import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { MAX_AGENT_RENDER_ARTIFACT_BYTES } from "./agent-contracts";
import { createPresentationPptx } from "./pptx-export";
import { renderPptxToPngs } from "./render-evidence";
import {
  agentVariantRenderSetSchema,
  type AgentVariantRenderSet,
  type ArtifactReference,
  type LayoutVariant,
  type PresentationDocument,
} from "./schemas";

const variants = ["compact", "balanced", "visual"] as const;
const maxArtifactBytes = MAX_AGENT_RENDER_ARTIFACT_BYTES;
const maxRunBytes = 128_000_000;
const maxDecodedPngBytes = 128_000_000;

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function reference(relativePath: string, bytes: Buffer): ArtifactReference {
  if (!bytes.length || bytes.length > maxArtifactBytes) throw new Error("Invalid render artifact size");
  return { relativePath, byteSize: bytes.length, sha256: digest(bytes) };
}

function artifactName(variant: LayoutVariant, extension: "pptx" | "pdf" | "png", page?: number) {
  return `render-evidence/${variant}/${page ? `slide-${page}` : "deck"}.${extension}`;
}

function assertFormat(bytes: Buffer, extension: string) {
  if (extension === "pptx" && bytes.subarray(0, 4).toString("hex") !== "504b0304") throw new Error("Invalid PPTX artifact");
  if (extension === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Invalid PDF artifact");
  if (extension === "png") assertPngStructure(bytes);
}

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertPngStructure(bytes: Buffer) {
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid PNG artifact");
  let offset = 8;
  let chunks = 0;
  let imageData = false;
  let imageDataEnded = false;
  let palette = false;
  const idat: Buffer[] = [];
  let height = 0;
  let rowBytes = 0;
  let filterBytesPerPixel = 0;
  let expectedBytes = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const actualCrc = pngCrc32(bytes.subarray(offset + 4, end - 4));
    if (actualCrc !== bytes.readUInt32BE(end - 4)) break;
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) break;
    if (chunks === 0) {
      if (type !== "IHDR" || length !== 13) break;
      const width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
      const validDepth = colorType === 0 ? [1, 2, 4, 8, 16] : colorType === 3 ? [1, 2, 4, 8] : [8, 16];
      if (!width || !height || !channels || !validDepth.includes(bitDepth) ||
        bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) break;
      rowBytes = Math.ceil(width * channels * bitDepth / 8);
      filterBytesPerPixel = Math.max(1, Math.ceil(channels * bitDepth / 8));
      expectedBytes = height * (rowBytes + 1);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes > maxDecodedPngBytes) break;
    } else if (type === "IHDR") break;
    if (type === "PLTE") {
      if (imageData || palette || length < 3 || length > 768 || length % 3 !== 0) break;
      palette = true;
    }
    if (type === "IDAT") {
      if (imageDataEnded || (bytes[25] === 3 && !palette)) break;
      imageData = true;
      idat.push(bytes.subarray(offset + 8, end - 4));
    } else if (imageData) imageDataEnded = true;
    if (type === "IEND") {
      if (length !== 0 || !imageData || end !== bytes.length) break;
      const compressed = Buffer.concat(idat);
      try {
        // Node returns the consumed input count with info:true; its bundled type omits this overload.
        const result = inflateSync(compressed, { maxOutputLength: expectedBytes + 1, info: true }) as unknown as {
          buffer: Buffer; engine: { bytesWritten: number };
        };
        if (result.engine.bytesWritten !== compressed.length || result.buffer.length !== expectedBytes) break;
        const pixels = result.buffer;
        for (let row = 0; row < height; row += 1) {
          const start = row * (rowBytes + 1);
          const filter = pixels[start];
          if (filter > 4) throw new Error("Invalid PNG filter");
          // Reconstruct bytes so every row's filter has valid, bounded input.
          for (let col = 0; col < rowBytes; col += 1) {
            const at = start + 1 + col;
            const left = col >= filterBytesPerPixel ? pixels[at - filterBytesPerPixel] : 0;
            const above = row ? pixels[at - rowBytes - 1] : 0;
            const upperLeft = row && col >= filterBytesPerPixel ? pixels[at - rowBytes - 1 - filterBytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = above;
            else if (filter === 3) predictor = Math.floor((left + above) / 2);
            else if (filter === 4) {
              const p = left + above - upperLeft;
              const a = Math.abs(p - left);
              const b = Math.abs(p - above);
              const c = Math.abs(p - upperLeft);
              predictor = a <= b && a <= c ? left : b <= c ? above : upperLeft;
            }
            pixels[at] = (pixels[at] + predictor) & 0xff;
          }
        }
        return;
      } catch { break; }
    }
    if (type !== "IHDR" && type !== "PLTE" && type !== "IDAT" && type !== "IEND" && type[0] === type[0].toUpperCase()) break;
    chunks += 1;
    offset = end;
  }
  throw new Error("Invalid PNG artifact");
}

/** Local-only, opt-in binary evidence. Its manifest contains relative paths and hashes only. */
export async function persistAgentVariantRenders(
  root: string,
  runId: string,
  documents: Record<LayoutVariant, PresentationDocument>,
): Promise<AgentVariantRenderSet> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) throw new Error("Invalid render run id");
  const runRoot = path.resolve(root, runId);
  await mkdir(runRoot);
  const output: Record<string, unknown> = {};
  let totalBytes = 0;
  for (const variant of variants) {
    const document = documents[variant];
    const pageCount = document.slides.length;
    if (pageCount < 5 || pageCount > 15) throw new Error("Invalid render slide count");
    const variantDir = path.join(runRoot, "render-evidence", variant);
    await mkdir(variantDir, { recursive: true });
    const pptxBytes = await createPresentationPptx(document);
    const pptx = reference(artifactName(variant, "pptx"), pptxBytes);
    assertFormat(pptxBytes, "pptx");
    totalBytes += pptx.byteSize;
    if (totalBytes > maxRunBytes) throw new Error("Render run exceeds byte limit");
    await writeFile(path.join(variantDir, "deck.pptx"), pptxBytes, { flag: "wx" });
    const rendered = await renderPptxToPngs(path.join(variantDir, "deck.pptx"), { outputDir: variantDir });
    if (rendered.slideCount !== pageCount || rendered.slides.length !== pageCount) {
      throw new Error("Rendered page set does not match document slide count");
    }
    const pdfBytes = await readFile(rendered.pdfPath);
    const pdf = reference(artifactName(variant, "pdf"), pdfBytes);
    assertFormat(pdfBytes, "pdf");
    totalBytes += pdf.byteSize;
    const pages: ArtifactReference[] = [];
    for (let page = 1; page <= pageCount; page += 1) {
      const renderedPage = rendered.slides[page - 1];
      if (renderedPage?.slideNumber !== page || path.resolve(renderedPage.outputPath) !== path.join(variantDir, `slide-${page}.png`)) {
        throw new Error("Rendered page set is incomplete or out of order");
      }
      const bytes = await readFile(renderedPage.outputPath);
      const item = reference(artifactName(variant, "png", page), bytes);
      assertFormat(bytes, "png");
      totalBytes += item.byteSize;
      pages.push(item);
    }
    if (totalBytes > maxRunBytes) throw new Error("Render run exceeds byte limit");
    output[variant] = { pptx, pdf, pages };
  }
  const manifest = agentVariantRenderSetSchema.parse({ version: 1, runId, variants: output });
  await writeFile(path.join(runRoot, "render-evidence.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await verifyAgentVariantRenders(root, manifest);
  return manifest;
}

/** Read every byte afresh and reject missing, changed, escaped or malformed evidence. */
export async function verifyAgentVariantRenders(root: string, value: AgentVariantRenderSet): Promise<AgentVariantRenderSet> {
  const manifest = agentVariantRenderSetSchema.parse(value);
  const runRoot = path.resolve(root, manifest.runId);
  const realRoot = await realpath(runRoot);
  const saved = agentVariantRenderSetSchema.parse(JSON.parse(await readFile(path.join(runRoot, "render-evidence.json"), "utf8")));
  if (JSON.stringify(saved) !== JSON.stringify(manifest)) throw new Error("Render evidence manifest mismatch");
  let totalBytes = 0;
  for (const variant of variants) {
    const set = manifest.variants[variant];
    if (!set) throw new Error(`Missing ${variant} render evidence`);
    const items = [set.pptx, set.pdf, ...set.pages];
    for (const item of items) {
      const realFile = await realpath(path.join(runRoot, item.relativePath));
      const relative = path.relative(realRoot, realFile);
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new Error("Render artifact escapes run directory");
      }
      const bytes = await readFile(realFile);
      if (!bytes.length || bytes.length !== item.byteSize || digest(bytes) !== item.sha256) throw new Error("Render artifact reference mismatch");
      assertFormat(bytes, path.extname(item.relativePath).slice(1));
      totalBytes += bytes.length;
      if (totalBytes > maxRunBytes) throw new Error("Render run exceeds byte limit");
    }
  }
  return manifest;
}
