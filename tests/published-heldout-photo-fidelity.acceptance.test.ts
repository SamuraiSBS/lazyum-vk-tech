import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateRawSync, inflateSync } from "node:zlib";
import JSZip from "jszip";
import { expect, it, vi } from "vitest";
import { createFixtureTemplate } from "./fixture-decks";

vi.mock("../src/lib/request-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/request-guards")>();
  const guard = actual.createProcessRequestGuard({ maxGenerationRequestsPerWindow: 100, maxExportRequestsPerWindow: 100 });
  return { ...actual, acquireHeavyOperation: (kind: "generation" | "export") => guard.acquireHeavyOperation(kind) };
});

vi.mock("../src/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/audit")>();
  return { ...actual, auditPresentation: (...args: Parameters<typeof actual.auditPresentation>) => {
    const report = actual.auditPresentation(...args);
    if (!report.passed) console.error("Held-out deterministic audit:", JSON.stringify(report.slides.flatMap((slide) => slide.issues.filter((issue) => issue.severity === "error").map((issue) => ({ slideId: slide.slideId, ...issue, element: args[0].slides.find((s) => s.id === slide.slideId)?.canvas.elements.find((e) => e.id === issue.elementId) })))));
    return report;
  } };
});

import { POST as generate } from "../src/app/api/generate/route";
import { POST as exportPptx } from "../src/app/api/export/route";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { auditReportSchema, designSystemSchema, generationPlanningSchema, presentationDocumentSchema, type CanvasElement } from "../src/lib/schemas";

const variants = ["compact", "balanced", "visual"] as const;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type CanvasImage = Extract<CanvasElement, { type: "image" }>;

const malformedFixturePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLZ4QAAAABJRU5ErkJggg==", "base64");
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const mediaPath = "ppt/media/image-1-1.png";
const heldoutTemplatePath = new URL("../fixtures/templates/photo-led.pptx", import.meta.url);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Buffer): Buffer {
  const label = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([label, payload])));
  return Buffer.concat([length, label, payload, checksum]);
}

function decodePng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(pngSignature);
  let offset = pngSignature.length;
  const chunks: { type: string; data: Buffer }[] = [];
  while (offset < bytes.length) {
    expect(bytes.length - offset, "truncated PNG chunk header").toBeGreaterThanOrEqual(12);
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    expect(end, "truncated PNG chunk payload").toBeLessThanOrEqual(bytes.length);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    expect(bytes.readUInt32BE(end - 4), `${type} PNG CRC`).toBe(crc32(bytes.subarray(offset + 4, end - 4)));
    chunks.push({ type, data });
    offset = end;
    if (type === "IEND") break;
  }
  expect(offset, "trailing PNG bytes").toBe(bytes.length);
  expect(chunks.map((part) => part.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  const header = chunks[0]!.data;
  expect(header.length).toBe(13);
  expect([header.readUInt32BE(0), header.readUInt32BE(4)]).toEqual([1, 1]);
  expect([...header.subarray(8)]).toEqual([8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace.
  expect(chunks[2]!.data.length).toBe(0);
  // inflateSync checks the zlib Adler-32; the leading 0 is the PNG scanline filter.
  expect([...inflateSync(chunks[1]!.data)]).toEqual([0, 255, 0, 0, 255]);
}

async function repairKnownFixturePng(template: Buffer): Promise<{ pptx: Buffer; repaired: boolean; pngSha256: string }> {
  const zip = await JSZip.loadAsync(template);
  const entry = zip.file(mediaPath);
  expect(entry, `missing ${mediaPath}`).not.toBeNull();
  const original = await entry!.async("nodebuffer");
  if (!original.equals(malformedFixturePng)) {
    await decodePng(original);
    return { pptx: template, repaired: false, pngSha256: digest(original) };
  }
  // Only the known synthetic 1×1 RGBA image may be repaired. Retain its pixels and every other PPTX part.
  expect(original.subarray(0, 8)).toEqual(pngSignature);
  const idatLength = original.readUInt32BE(33);
  expect(original.subarray(37, 41).toString("ascii")).toBe("IDAT");
  const deflate = original.subarray(43, 41 + idatLength - 4);
  expect([...inflateRawSync(deflate)]).toEqual([0, 255, 0, 0, 255]);
  const repaired = Buffer.concat([
    pngSignature,
    chunk("IHDR", original.subarray(16, 29)),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  await decodePng(repaired);
  const before = await Promise.all(Object.keys(zip.files).filter((name) => !zip.files[name]!.dir && name !== mediaPath)
    .map(async (name) => [name, digest(await zip.file(name)!.async("nodebuffer"))] as const));
  zip.file(mediaPath, repaired);
  const pptx = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const after = await JSZip.loadAsync(pptx);
  expect(Object.keys(after.files).sort()).toEqual(Object.keys(zip.files).sort());
  for (const [name, hash] of before) expect(digest(await after.file(name)!.async("nodebuffer")), name).toBe(hash);
  return { pptx, repaired: true, pngSha256: digest(repaired) };
}

it.skipIf(!existsSync(heldoutTemplatePath))("publishes ten photo-led held-out slides with auditable native source artwork", async () => {
  const artifactRoot = path.resolve(process.cwd(), ".data", "acceptance", "heldout-photo-published-2026-09-29");
  const oldRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
  const oldProvider = process.env.VK_HACKATHON_LLM_PROVIDER;
  await mkdir(artifactRoot, { recursive: true });
  process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
  process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
  try {
    const namedTemplate = await readFile(heldoutTemplatePath);
    const named = await repairKnownFixturePng(namedTemplate);
    const regenerated = await repairKnownFixturePng(await createFixtureTemplate("photo"));
    expect(regenerated.repaired, "the regenerated fixture must contain a valid PNG without repair").toBe(false);
    // The repaired named file and regenerated source can use different valid PNG encodings.
    const template = regenerated.pptx;
    const form = new FormData();
    form.set("template", new File([new Uint8Array(template)], "photo-led.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
    form.set("brief", "Фотоистория пилота цифрового сервиса для команд");
    form.set("materials", new File(["Команда запускает пилот, сравнивает сроки согласования, проверяет качество решений и расширяет внедрение после оценки результатов."], "brief.txt", { type: "text/plain" }));
    form.set("slideCount", "10");
    const response = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload).slice(0, 400)).toBe(200);
    const jobId: string = payload.jobId;
    expect(jobId).toMatch(/^job-/);
    const store = new ArtifactStore(artifactRoot);
    const manifest = await store.readManifest(jobId);
    expect(manifest.status).toBe("ready");
    const read = async (ref: { relativePath: string; sha256: string }) => {
      const bytes = (await store.readPublishedArtifact(jobId, ref.relativePath)).contents;
      expect(sha256(bytes), ref.relativePath).toBe(ref.sha256);
      return bytes;
    };
    const plan = generationPlanningSchema.parse(JSON.parse((await read(manifest.artifacts.planning!)).toString("utf8"))).presentationPlan;
    const design = designSystemSchema.parse(JSON.parse((await read(manifest.artifacts.parsed!)).toString("utf8")));
    expect(plan.slides).toHaveLength(10);
    const variantRefs = manifest.artifacts.variants;
    const auditRefs = manifest.artifacts.audit;
    if (!variantRefs || typeof variantRefs !== "object" || !("compact" in variantRefs)
      || !auditRefs || typeof auditRefs !== "object" || !("compact" in auditRefs)) {
      throw new Error("Missing published variant or audit references");
    }
    const result: Record<string, unknown> = { jobId, artifactRoot, namedTemplateSha256: digest(namedTemplate), templateSha256: digest(template), fixturePngSha256: regenerated.pngSha256, repairedRegeneratedPng: regenerated.repaired, repairedNamedPng: named.repaired, variants: {} };
    let allSourceImages = 0;
    for (const variant of variants) {
      const ref = variantRefs[variant]!;
      const document = presentationDocumentSchema.parse(JSON.parse((await read(ref)).toString("utf8")));
      const audit = auditReportSchema.parse(JSON.parse((await read(auditRefs[variant]!)).toString("utf8")));
      expect(document.slides).toHaveLength(10);
      expect(document.slides.map((slide) => slide.order)).toEqual([1,2,3,4,5,6,7,8,9,10]);
      expect(document.slides.map((slide) => slide.title)).toEqual(plan.slides.map((slide) => slide.title));
      expect(audit.passed, `${variant} audit`).toBe(true);
      const exported = await exportPptx(new Request("http://localhost/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, variant }) }));
      const bytes = Buffer.from(await exported.arrayBuffer());
      expect(exported.status, bytes.toString("utf8").slice(0, 400)).toBe(200);
      const exports = (await store.readManifest(jobId)).artifacts.exports;
      if (!exports || typeof exports !== "object" || !("compact" in exports)) throw new Error("Missing published export references");
      const exportRef = exports[variant].pptx!;
      expect(exportRef.sha256).toBe(digest(bytes));
      expect(exportRef.byteSize).toBe(bytes.length);
      expect(await read(exportRef)).toEqual(bytes);
      const zip = await JSZip.loadAsync(bytes);
      expect(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))).toHaveLength(10);
      let imageCount = 0;
      for (const [index, slide] of document.slides.entries()) {
        const source = design.layouts.find((layout) => layout.id === slide.templateLayoutId);
        expect(source, `${variant} slide ${index + 1} layout`).toBeDefined();
        const xml = await zip.file(`ppt/slides/slide${index + 1}.xml`)?.async("string");
        expect(xml).toBeDefined();
        const images = slide.canvas.elements.filter((element): element is CanvasImage => element.type === "image" && Boolean(element.dataUrl));
        const contains = (outer: { x: number; y: number; w: number; h: number }, inner: { x: number; y: number; w: number; h: number }) =>
          inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
        const sourcePanels = source!.elements.filter((element) => element.type === "shape"
          && source!.elements.some((slot) => (slot.type === "text" || slot.type === "placeholder")
            && Boolean(slot.text.trim()) && contains(element, slot)));
        for (const panel of sourcePanels) {
          if (!slide.canvas.elements.some((element) => element.sourceTemplateElementId === panel.id)) continue;
          expect(slide.canvas.elements.some((element) => element.type === "text" && Boolean(element.text.trim())
            && contains(panel, element)), `${variant} slide ${index + 1} empty source panel ${panel.id}`).toBe(true);
        }
        for (const image of images) {
          const original = source!.elements.find((element) => element.id === image.sourceTemplateElementId);
          expect(original?.type).toBe("image");
          expect(image.dataUrl).toBe(original?.imageDataUrl);
          expect(image.crop).toEqual(original?.type === "image" ? original.crop : undefined);
          imageCount++;
        }
        expect((xml!.match(/<p:pic\b/gu) ?? []).length).toBe(images.length);
      }
      expect(imageCount, `${variant} source images`).toBeGreaterThan(0);
      allSourceImages += imageCount;
      (result.variants as Record<string, unknown>)[variant] = { auditPassed: audit.passed, sourceImages: imageCount, pptxPath: path.join(artifactRoot, jobId, exportRef.relativePath), pptxSha256: exportRef.sha256, slideCount: 10 };
    }
    expect(allSourceImages).toBeGreaterThan(0);
    await writeFile(path.join(artifactRoot, "review-evidence.json"), JSON.stringify(result, null, 2));
  } finally {
    if (oldRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
    else process.env.VK_HACKATHON_ARTIFACT_ROOT = oldRoot;
    if (oldProvider === undefined) delete process.env.VK_HACKATHON_LLM_PROVIDER;
    else process.env.VK_HACKATHON_LLM_PROVIDER = oldProvider;
  }
}, 900_000);
