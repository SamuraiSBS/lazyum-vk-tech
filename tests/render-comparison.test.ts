import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateRenderPageSetSha256,
  comparePngBuffers,
  comparePngRelativePaths,
  renderAndCompareFixture,
  resolveSafeRelativePath,
} from "../src/lib/render-comparison";
import type { RenderEvidenceBundle, RenderPptxToPngOptions } from "../src/lib/render-evidence";
import type { RenderGoldenFixture } from "../src/lib/schemas";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic PNG render comparison", () => {
  it("passes equal images and reports zero pixel diff", () => {
    const image = createPng(2, 1, [
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    const result = comparePngBuffers(image, image, {
      baselinePath: "baseline/slide-1.png",
      currentPath: "current/slide-1.png",
    });

    expect(result.status).toBe("passed");
    expect(result.reasons).toEqual([]);
    expect(result.baseline).toMatchObject({ byteSize: image.length, width: 2, height: 1 });
    expect(result.current.sha256).toBe(result.baseline.sha256);
    expect(result.pixelDiff).toMatchObject({
      pixelCount: 2,
      differingPixels: 0,
      differingPixelRatio: 0,
      maxChannelDelta: 0,
      totalAbsoluteChannelDelta: 0,
    });
    expect(result.caveat).toMatch(/PowerPoint parity/);
  });

  it("fails changed pixels with deterministic metrics", () => {
    const baseline = createPng(2, 1, [
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    const current = createPng(2, 1, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ]);

    const result = comparePngBuffers(baseline, current);

    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual(["sha256_mismatch", "pixel_diff"]);
    expect(result.pixelDiff).toMatchObject({
      pixelCount: 2,
      differingPixels: 1,
      differingPixelRatio: 0.5,
      differingChannels: 2,
      maxChannelDelta: 255,
      totalAbsoluteChannelDelta: 510,
      meanAbsoluteChannelDelta: 63.75,
    });
  });

  it("fails dimension mismatches before comparing pixels", () => {
    const baseline = createPng(1, 1, [[255, 0, 0, 255]]);
    const current = createPng(2, 1, [[255, 0, 0, 255], [0, 0, 0, 255]]);

    const result = comparePngBuffers(baseline, current);

    expect(result.status).toBe("failed");
    expect(result.reasons).toContain("dimension_mismatch");
    expect(result.pixelDiff).toBeNull();
  });

  it("fails byte and SHA mismatches even when decoded pixels are equal", () => {
    const baseline = createPng(1, 1, [[10, 20, 30, 255]], "baseline");
    const current = createPng(1, 1, [[10, 20, 30, 255]], "current");

    const result = comparePngBuffers(baseline, current);

    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual(["byte_size_mismatch", "sha256_mismatch"]);
    expect(result.pixelDiff).toMatchObject({ differingPixels: 0, totalAbsoluteChannelDelta: 0 });
  });

  it("rejects traversal and unsafe relative paths", async () => {
    const root = await testRoot();

    expect(() => resolveSafeRelativePath(root, "../escape.png")).toThrow(/Unsafe relative/);
    expect(() => resolveSafeRelativePath(root, "C:\\escape.png")).toThrow(/Unsafe relative/);
    expect(() => resolveSafeRelativePath(root, "nested/./slide.png")).toThrow(/Unsafe relative/);
    await expect(comparePngRelativePaths({
      baselineRoot: root,
      baselineRelativePath: "../escape.png",
      currentRoot: root,
      currentRelativePath: "slide-1.png",
    })).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("uses an injected mocked runner without starting LibreOffice", async () => {
    const root = await testRoot();
    const baselineRoot = path.join(root, "goldens");
    const currentRoot = path.join(root, "current");
    await mkdir(path.join(baselineRoot, "golden"), { recursive: true });
    await mkdir(currentRoot, { recursive: true });
    const image = createPng(1, 1, [[80, 90, 100, 255]]);
    await writeFile(path.join(baselineRoot, "golden", "slide-1.png"), image);
    await writeFile(path.join(currentRoot, "slide-1.png"), image);
    const page = {
      slideNumber: 1,
      relativePath: "slide-1.png",
      byteSize: image.length,
      sha256: createHash("sha256").update(image).digest("hex"),
      width: 1,
      height: 1,
    };
    const expected: RenderGoldenFixture = {
      inputPath: "fixtures/templates/organizer/mock.pptx",
      pageCount: 1,
      width: 900,
      height: 1_600,
      pageSetSha256: calculateRenderPageSetSha256([page]),
      pages: [page],
      representatives: [{ ...page, goldenPath: "golden/slide-1.png" }],
    };
    const renderEvidence: RenderEvidenceBundle = {
      renderer: "libreoffice-impress-headless",
      rendererPath: "mocked",
      rendererVersion: "mocked",
      rasterizer: "poppler-pdftoppm",
      rasterizerPath: "mocked",
      pageCounter: "poppler-pdfinfo",
      pageCounterPath: "mocked",
      inputPath: path.join(root, "mock.pptx"),
      pdfPath: path.join(root, "mock.pdf"),
      pdfBytes: 1,
      pdfSha256: "mocked",
      outputFormat: "png",
      slideCount: 1,
      width: 900,
      height: 1_600,
      slides: [{
        outputPath: path.join(currentRoot, "slide-1.png"),
        outputFormat: "png",
        slideNumber: 1,
        outputBytes: image.length,
        outputSha256: page.sha256,
      }],
    };
    const render = vi.fn(async (_inputPath: string, _options?: RenderPptxToPngOptions) => renderEvidence);

    const result = await renderAndCompareFixture({
      inputPath: path.join(root, "mock.pptx"),
      expected,
      baselineRoot,
      currentRoot,
      render,
      renderOptions: { jobTimeoutMs: 300_000, processTimeoutMs: 60_000 },
    });

    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]?.[1]).toMatchObject({ outputDir: currentRoot, jobTimeoutMs: 300_000, processTimeoutMs: 60_000 });
    expect(result.status).toBe("passed");
    expect(result.pageSet.status).toBe("passed");
    expect(result.representatives[0]?.comparison.status).toBe("passed");
  });
});

async function testRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-render-comparison-"));
  roots.push(root);
  return root;
}

function createPng(width: number, height: number, pixels: Array<[number, number, number, number]>, text?: string) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const rowOffset = row * (width * 4 + 1);
    raw[rowOffset] = 0;
    for (let column = 0; column < width; column += 1) {
      const source = pixels[row * width + column];
      const target = rowOffset + 1 + column * 4;
      raw[target] = source[0];
      raw[target + 1] = source[1];
      raw[target + 2] = source[2];
      raw[target + 3] = source[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw))];
  if (text) chunks.push(pngChunk("tEXt", Buffer.from(`note\0${text}`, "latin1")));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunks,
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
