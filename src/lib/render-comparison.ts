import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import type {
  RenderGoldenFixture,
  RenderGoldenPage,
} from "./schemas";
import {
  renderPptxToPngs,
  type RenderEvidenceBundle,
  type RenderPptxToPngOptions,
} from "./render-evidence";

export const RENDER_COMPARISON_CAVEAT =
  "Deterministic PNG comparison only; it does not establish PowerPoint parity, DOM parity, or visual fidelity.";

export type RenderComparisonErrorCode = "invalid_path" | "invalid_png";

export class RenderComparisonError extends Error {
  readonly code: RenderComparisonErrorCode;

  constructor(code: RenderComparisonErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RenderComparisonError";
    this.code = code;
  }
}

export interface PngMetadata {
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
}

export interface RenderPageMetadata extends PngMetadata {
  slideNumber: number;
  relativePath: string;
}

export interface PixelDiffMetrics {
  pixelCount: number;
  differingPixels: number;
  differingPixelRatio: number;
  differingChannels: number;
  differingChannelRatio: number;
  maxChannelDelta: number;
  totalAbsoluteChannelDelta: number;
  meanAbsoluteChannelDelta: number;
}

export type PngComparisonReason =
  | "byte_size_mismatch"
  | "sha256_mismatch"
  | "dimension_mismatch"
  | "pixel_diff";

export interface PngComparisonResult {
  status: "passed" | "failed";
  reasons: PngComparisonReason[];
  baseline: PngMetadata & { relativePath?: string };
  current: PngMetadata & { relativePath?: string };
  pixelDiff: PixelDiffMetrics | null;
  caveat: string;
}

export interface RenderSetComparisonResult {
  status: "passed" | "failed";
  reasons: string[];
  expectedPageCount: number;
  currentPageCount: number;
  expectedPageSetSha256: string;
  currentPageSetSha256: string;
  caveat: string;
}

export interface RenderedFixtureComparison {
  status: "passed" | "failed";
  expectedPageCount: number;
  currentPageCount: number;
  currentPages: RenderPageMetadata[];
  pageSet: RenderSetComparisonResult;
  representatives: Array<{
    slideNumber: number;
    goldenPath: string;
    comparison: PngComparisonResult;
  }>;
  renderEvidence: RenderEvidenceBundle;
  caveat: string;
}

export type RenderComparisonAdapter = (
  inputPath: string,
  options?: RenderPptxToPngOptions,
) => Promise<RenderEvidenceBundle>;

/**
 * Compare PNG bytes and decoded RGBA pixels. A byte/hash mismatch is failed
 * even when the decoded pixels happen to be equal, so accidental metadata or
 * encoder drift cannot silently become a passing baseline.
 */
export function comparePngBuffers(
  baselineContents: Buffer,
  currentContents: Buffer,
  paths: { baselinePath?: string; currentPath?: string } = {},
): PngComparisonResult {
  const baselineImage = decodePng(baselineContents);
  const currentImage = decodePng(currentContents);
  const baseline = {
    ...metadataFor(baselineContents, baselineImage),
    ...(paths.baselinePath ? { relativePath: paths.baselinePath } : {}),
  };
  const current = {
    ...metadataFor(currentContents, currentImage),
    ...(paths.currentPath ? { relativePath: paths.currentPath } : {}),
  };
  const reasons: PngComparisonReason[] = [];

  if (baseline.byteSize !== current.byteSize) reasons.push("byte_size_mismatch");
  if (baseline.sha256 !== current.sha256) reasons.push("sha256_mismatch");
  let pixelDiff: PixelDiffMetrics | null = null;
  if (baseline.width !== current.width || baseline.height !== current.height) {
    reasons.push("dimension_mismatch");
  } else {
    pixelDiff = calculatePixelDiff(baselineImage.rgba, currentImage.rgba);
    if (pixelDiff.differingPixels > 0) reasons.push("pixel_diff");
  }

  return {
    status: reasons.length === 0 ? "passed" : "failed",
    reasons,
    baseline,
    current,
    pixelDiff,
    caveat: RENDER_COMPARISON_CAVEAT,
  };
}

export async function comparePngFiles(input: {
  baselinePath: string;
  currentPath: string;
}): Promise<PngComparisonResult> {
  const [baselineContents, currentContents] = await Promise.all([
    readFile(input.baselinePath),
    readFile(input.currentPath),
  ]);
  return comparePngBuffers(baselineContents, currentContents, {
    baselinePath: input.baselinePath,
    currentPath: input.currentPath,
  });
}

export async function comparePngRelativePaths(input: {
  baselineRoot: string;
  baselineRelativePath: string;
  currentRoot: string;
  currentRelativePath: string;
}): Promise<PngComparisonResult> {
  const [baseline, current] = await Promise.all([
    readSafeRelativeFile(input.baselineRoot, input.baselineRelativePath),
    readSafeRelativeFile(input.currentRoot, input.currentRelativePath),
  ]);
  return comparePngBuffers(baseline.contents, current.contents, {
    baselinePath: normalizeRelativePath(input.baselineRelativePath),
    currentPath: normalizeRelativePath(input.currentRelativePath),
  });
}

export async function inspectPngFile(filePath: string): Promise<PngMetadata> {
  const contents = await readFile(filePath);
  return metadataFor(contents, decodePng(contents));
}

export function inspectPngBuffer(contents: Buffer): PngMetadata {
  return metadataFor(contents, decodePng(contents));
}

export function resolveSafeRelativePath(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, normalized.split("/").join(path.sep));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RenderComparisonError("invalid_path", `Unsafe relative render-comparison path: ${relativePath}`);
  }
  return resolvedPath;
}

export function calculateRenderPageSetSha256(pages: Array<Pick<RenderPageMetadata, "slideNumber" | "byteSize" | "sha256" | "width" | "height">>) {
  const canonical = [...pages]
    .sort((left, right) => left.slideNumber - right.slideNumber)
    .map((page) => [page.slideNumber, page.byteSize, page.sha256.toLowerCase(), page.width, page.height]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function compareRenderPageSet(
  expected: RenderGoldenFixture,
  currentPages: RenderPageMetadata[],
  actualPageCount = currentPages.length,
): RenderSetComparisonResult {
  const currentPageSetSha256 = calculateRenderPageSetSha256(currentPages);
  const reasons: string[] = [];
  if (expected.pageCount !== actualPageCount) {
    reasons.push(`page_count_mismatch: expected ${expected.pageCount}, received ${actualPageCount}`);
  }
  if (expected.pages.length !== currentPages.length) {
    reasons.push(`page_metadata_count_mismatch: expected ${expected.pages.length}, received ${currentPages.length}`);
  }
  for (const expectedPage of expected.pages) {
    const currentPage = currentPages.find((page) => page.slideNumber === expectedPage.slideNumber);
    if (!currentPage) {
      reasons.push(`missing_page: slide ${expectedPage.slideNumber}`);
      continue;
    }
    comparePageMetadata(expectedPage, currentPage, reasons);
  }
  if (expected.pageSetSha256 !== currentPageSetSha256) {
    reasons.push(`page_set_sha256_mismatch: expected ${expected.pageSetSha256}, received ${currentPageSetSha256}`);
  }
  return {
    status: reasons.length === 0 ? "passed" : "failed",
    reasons,
    expectedPageCount: expected.pageCount,
    currentPageCount: actualPageCount,
    expectedPageSetSha256: expected.pageSetSha256,
    currentPageSetSha256,
    caveat: RENDER_COMPARISON_CAVEAT,
  };
}

/**
 * Injecting the adapter keeps ordinary tests free of LibreOffice/Poppler.
 * The opt-in CLI passes the real renderPptxToPngs adapter.
 */
export async function renderAndCompareFixture(input: {
  inputPath: string;
  expected: RenderGoldenFixture;
  baselineRoot: string;
  currentRoot: string;
  render?: RenderComparisonAdapter;
  renderOptions?: RenderPptxToPngOptions;
}): Promise<RenderedFixtureComparison> {
  const render = input.render ?? renderPptxToPngs;
  const renderEvidence = await render(input.inputPath, {
    ...input.renderOptions,
    outputDir: input.currentRoot,
  });
  const currentPages = await collectRenderPageMetadata(renderEvidence, input.currentRoot);
  const pageSet = compareRenderPageSet(input.expected, currentPages, renderEvidence.slideCount);
  if (renderEvidence.width !== input.expected.width || renderEvidence.height !== input.expected.height) {
    pageSet.reasons.push(
      `render_scale_mismatch: expected ${input.expected.width}x${input.expected.height}, received ${renderEvidence.width}x${renderEvidence.height}`,
    );
    pageSet.status = "failed";
  }
  const representatives = [];
  for (const representative of input.expected.representatives) {
    const comparison = await comparePngRelativePaths({
      baselineRoot: input.baselineRoot,
      baselineRelativePath: representative.goldenPath,
      currentRoot: input.currentRoot,
      currentRelativePath: `slide-${representative.slideNumber}.png`,
    });
    representatives.push({
      slideNumber: representative.slideNumber,
      goldenPath: representative.goldenPath,
      comparison,
    });
  }
  const status = pageSet.status === "passed"
    && representatives.every((representative) => representative.comparison.status === "passed")
    ? "passed"
    : "failed";
  return {
    status,
    expectedPageCount: input.expected.pageCount,
    currentPageCount: renderEvidence.slideCount,
    currentPages,
    pageSet,
    representatives,
    renderEvidence,
    caveat: RENDER_COMPARISON_CAVEAT,
  };
}

export async function collectRenderPageMetadata(
  renderEvidence: RenderEvidenceBundle,
  currentRoot: string,
): Promise<RenderPageMetadata[]> {
  const pages: RenderPageMetadata[] = [];
  const seenSlides = new Set<number>();
  for (const slide of renderEvidence.slides) {
    if (seenSlides.has(slide.slideNumber)) {
      throw new RenderComparisonError("invalid_path", `Duplicate rendered slide number: ${slide.slideNumber}`);
    }
    seenSlides.add(slide.slideNumber);
    const relativePath = `slide-${slide.slideNumber}.png`;
    const expectedPath = resolveSafeRelativePath(currentRoot, relativePath);
    if (!samePath(expectedPath, slide.outputPath)) {
      throw new RenderComparisonError("invalid_path", `Rendered slide path does not stay in the current output directory: ${slide.outputPath}`);
    }
    const metadata = await inspectPngFile(expectedPath);
    if (metadata.byteSize !== slide.outputBytes || metadata.sha256 !== slide.outputSha256) {
      throw new RenderComparisonError(
        "invalid_png",
        `Render adapter metadata does not match ${relativePath}`,
      );
    }
    pages.push({ ...metadata, slideNumber: slide.slideNumber, relativePath });
  }
  return pages.sort((left, right) => left.slideNumber - right.slideNumber);
}

function comparePageMetadata(
  expected: RenderGoldenPage,
  current: RenderPageMetadata,
  reasons: string[],
) {
  if (expected.byteSize !== current.byteSize) {
    reasons.push(`byte_size_mismatch: slide ${expected.slideNumber}`);
  }
  if (expected.sha256.toLowerCase() !== current.sha256.toLowerCase()) {
    reasons.push(`sha256_mismatch: slide ${expected.slideNumber}`);
  }
  if (expected.width !== current.width || expected.height !== current.height) {
    reasons.push(
      `dimension_mismatch: slide ${expected.slideNumber} expected ${expected.width}x${expected.height}, received ${current.width}x${current.height}`,
    );
  }
}

function metadataFor(contents: Buffer, image: DecodedPng): PngMetadata {
  return {
    byteSize: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
    width: image.width,
    height: image.height,
  };
}

function calculatePixelDiff(baseline: Buffer, current: Buffer): PixelDiffMetrics {
  if (baseline.length !== current.length) {
    throw new RenderComparisonError("invalid_png", "Decoded PNG buffers have different lengths");
  }
  let differingPixels = 0;
  let differingChannels = 0;
  let maxChannelDelta = 0;
  let totalAbsoluteChannelDelta = 0;
  for (let offset = 0; offset < baseline.length; offset += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(baseline[offset + channel] - current[offset + channel]);
      if (delta !== 0) {
        pixelDiffers = true;
        differingChannels += 1;
      }
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      totalAbsoluteChannelDelta += delta;
    }
    if (pixelDiffers) differingPixels += 1;
  }
  const pixelCount = baseline.length / 4;
  const channelCount = baseline.length;
  return {
    pixelCount,
    differingPixels,
    differingPixelRatio: pixelCount === 0 ? 0 : differingPixels / pixelCount,
    differingChannels,
    differingChannelRatio: channelCount === 0 ? 0 : differingChannels / channelCount,
    maxChannelDelta,
    totalAbsoluteChannelDelta,
    meanAbsoluteChannelDelta: channelCount === 0 ? 0 : totalAbsoluteChannelDelta / channelCount,
  };
}

function normalizeRelativePath(relativePath: string) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) {
    throw new RenderComparisonError("invalid_path", `Unsafe relative render-comparison path: ${String(relativePath)}`);
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
    throw new RenderComparisonError("invalid_path", `Unsafe relative render-comparison path: ${relativePath}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RenderComparisonError("invalid_path", `Unsafe relative render-comparison path: ${relativePath}`);
  }
  return normalized;
}

async function readSafeRelativeFile(root: string, relativePath: string) {
  const lexicalPath = resolveSafeRelativePath(root, relativePath);
  let rootPath: string;
  let filePath: string;
  try {
    rootPath = await realpath(path.resolve(root));
    filePath = await realpath(lexicalPath);
  } catch (error) {
    throw new RenderComparisonError("invalid_path", `Render-comparison file is not available: ${relativePath}`, { cause: error });
  }
  const relative = path.relative(rootPath, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RenderComparisonError("invalid_path", `Render-comparison path escapes its root: ${relativePath}`);
  }
  return { contents: await readFile(filePath), relativePath: normalizeRelativePath(relativePath) };
}

function samePath(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

type DecodedPng = { width: number; height: number; rgba: Buffer };

function decodePng(contents: Buffer): DecodedPng {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (contents.length < signature.length || !contents.subarray(0, signature.length).equals(signature)) {
    throw new RenderComparisonError("invalid_png", "Render comparison expected a PNG signature");
  }
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const idat: Buffer[] = [];
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 12 <= contents.length) {
    const length = contents.readUInt32BE(offset);
    const type = contents.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd > contents.length || chunkEnd > contents.length) {
      throw new RenderComparisonError("invalid_png", "Render comparison found a truncated PNG chunk");
    }
    const data = contents.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (sawIhdr || length !== 13) throw new RenderComparisonError("invalid_png", "Render comparison found an invalid PNG header");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaceMethod = data[12];
      sawIhdr = true;
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      transparency = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawIhdr || !sawIend || width <= 0 || height <= 0 || idat.length === 0) {
    throw new RenderComparisonError("invalid_png", "Render comparison found an incomplete PNG");
  }
  if (bitDepth !== 8 || interlaceMethod !== 0) {
    throw new RenderComparisonError("invalid_png", "Render comparison supports only 8-bit non-interlaced PNG files");
  }
  const bytesPerPixel = bytesPerPixelFor(colorType);
  const inflated = inflatePngData(Buffer.concat(idat));
  const rowBytes = width * bytesPerPixel;
  const expectedLength = height * (rowBytes + 1);
  if (inflated.length !== expectedLength) {
    throw new RenderComparisonError("invalid_png", "Render comparison found invalid PNG scanline data");
  }
  const filtered = Buffer.alloc(rowBytes * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowStart = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = inflated[sourceOffset + column];
      const left = column >= bytesPerPixel ? filtered[rowStart + column - bytesPerPixel] : 0;
      const up = row > 0 ? filtered[rowStart - rowBytes + column] : 0;
      const upLeft = row > 0 && column >= bytesPerPixel ? filtered[rowStart - rowBytes + column - bytesPerPixel] : 0;
      filtered[rowStart + column] = unfilterByte(filter, raw, left, up, upLeft);
    }
    sourceOffset += rowBytes;
  }
  return { width, height, rgba: toRgba(filtered, width, height, colorType, palette, transparency) };
}

function bytesPerPixelFor(colorType: number) {
  switch (colorType) {
    case 0: return 1;
    case 2: return 3;
    case 3: return 1;
    case 4: return 2;
    case 6: return 4;
    default: throw new RenderComparisonError("invalid_png", `Render comparison does not support PNG color type ${colorType}`);
  }
}

function inflatePngData(data: Buffer) {
  try {
    return inflateSync(data);
  } catch (error) {
    throw new RenderComparisonError("invalid_png", "Render comparison could not decode PNG scanlines", { cause: error });
  }
}

function unfilterByte(filter: number, raw: number, left: number, up: number, upLeft: number) {
  switch (filter) {
    case 0: return raw;
    case 1: return (raw + left) & 0xff;
    case 2: return (raw + up) & 0xff;
    case 3: return (raw + Math.floor((left + up) / 2)) & 0xff;
    case 4: return (raw + paeth(left, up, upLeft)) & 0xff;
    default: throw new RenderComparisonError("invalid_png", `Render comparison found unsupported PNG filter ${filter}`);
  }
}

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function toRgba(
  filtered: Buffer,
  width: number,
  height: number,
  colorType: number,
  palette: Buffer | undefined,
  transparency: Buffer | undefined,
) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * bytesPerPixelFor(colorType);
    const target = pixel * 4;
    if (colorType === 0) {
      const gray = filtered[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = transparency && transparency.length >= 2 && gray === transparency[1] ? 0 : 255;
    } else if (colorType === 2) {
      rgba[target] = filtered[source];
      rgba[target + 1] = filtered[source + 1];
      rgba[target + 2] = filtered[source + 2];
      rgba[target + 3] = transparency && transparency.length >= 6
        && filtered[source] === transparency[1]
        && filtered[source + 1] === transparency[3]
        && filtered[source + 2] === transparency[5]
        ? 0
        : 255;
    } else if (colorType === 3) {
      const index = filtered[source];
      if (!palette || palette.length < (index + 1) * 3) {
        throw new RenderComparisonError("invalid_png", "Render comparison found an invalid PNG palette index");
      }
      rgba[target] = palette[index * 3];
      rgba[target + 1] = palette[index * 3 + 1];
      rgba[target + 2] = palette[index * 3 + 2];
      rgba[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 4) {
      const gray = filtered[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = filtered[source + 1];
    } else {
      rgba[target] = filtered[source];
      rgba[target + 1] = filtered[source + 1];
      rgba[target + 2] = filtered[source + 2];
      rgba[target + 3] = filtered[source + 3];
    }
  }
  return rgba;
}
