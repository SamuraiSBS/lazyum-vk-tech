/**
 * Unit-aware measurements for the opt-in editor -> PPTX -> PDF acceptance run.
 * Canvas geometry is in 96-DPI CSS pixels, PowerPoint geometry in OOXML EMU,
 * and PDF text geometry in PDF points with a top-left origin.
 */

export type Rectangle = { x: number; y: number; width: number; height: number };
export type CanvasSize = { width: number; height: number };
export type PdfPageSize = {
  widthPt: number;
  heightPt: number;
  /** Optional lower-left PDF page origin from PDF.js `page.view`. */
  leftPt?: number;
  bottomPt?: number;
};

export type GeometryUnit = "canvas-px" | "pdf-pt" | "pptx-emu";
export type MeasuredTextBox = {
  text: string;
  rect: Rectangle;
  unit: GeometryUnit;
};

export type ParityTolerance = {
  canvasGeometryPx: number;
  pptxGeometryPx: number;
  pdfContainmentPx: number;
  slideBoundsPx: number;
  minimumSlideMarginPx: number;
};

export const DEFAULT_PARITY_TOLERANCES: Readonly<ParityTolerance> = Object.freeze({
  canvasGeometryPx: 1,
  pptxGeometryPx: 1,
  pdfContainmentPx: 3,
  slideBoundsPx: 1,
  minimumSlideMarginPx: 2,
});

export type ParityFindingCode =
  | "INVALID_GEOMETRY"
  | "SOURCE_OUTSIDE_SLIDE"
  | "CANVAS_TEXT_MISSING"
  | "CANVAS_TEXT_MISMATCH"
  | "CANVAS_GEOMETRY_MISMATCH"
  | "PPTX_TEXT_MISSING"
  | "PPTX_TEXT_MISMATCH"
  | "PPTX_GEOMETRY_MISMATCH"
  | "PDF_TEXT_MISSING"
  | "PDF_TEXT_CLIPPED"
  | "PDF_TEXT_OUTSIDE_SLIDE"
  | "PDF_TEXT_MARGIN";

export type ParityFinding = {
  code: ParityFindingCode;
  message: string;
  expected?: Rectangle;
  actual?: Rectangle;
  delta?: Partial<Rectangle>;
  tolerance?: number;
};

export type PdfJsTextItemLike = {
  str?: unknown;
  width?: unknown;
  height?: unknown;
  transform?: unknown;
};

export type PopplerBboxPage = {
  page: number;
  widthPt: number;
  heightPt: number;
  boxes: MeasuredTextBox[];
};

const EMU_PER_CANVAS_PIXEL = 9_525;
const PDF_POINTS_PER_CANVAS_PIXEL = 72 / 96;

export function canvasPixelsToPdfPoints(value: number): number {
  assertFiniteNumber(value, "canvas pixel value");
  return value * PDF_POINTS_PER_CANVAS_PIXEL;
}

export function pdfPointsToCanvasPixels(value: number): number {
  assertFiniteNumber(value, "PDF point value");
  return value / PDF_POINTS_PER_CANVAS_PIXEL;
}

export function pptxEmuToCanvasPixels(value: number): number {
  assertFiniteNumber(value, "PPTX EMU value");
  return value / EMU_PER_CANVAS_PIXEL;
}

export function rectangleToCanvasPixels(box: MeasuredTextBox): Rectangle {
  assertRectangle(box.rect, `${box.unit} rectangle`);
  switch (box.unit) {
    case "canvas-px":
      return { ...box.rect };
    case "pdf-pt":
      return {
        x: pdfPointsToCanvasPixels(box.rect.x),
        y: pdfPointsToCanvasPixels(box.rect.y),
        width: pdfPointsToCanvasPixels(box.rect.width),
        height: pdfPointsToCanvasPixels(box.rect.height),
      };
    case "pptx-emu":
      return {
        x: pptxEmuToCanvasPixels(box.rect.x),
        y: pptxEmuToCanvasPixels(box.rect.y),
        width: pptxEmuToCanvasPixels(box.rect.width),
        height: pptxEmuToCanvasPixels(box.rect.height),
      };
  }
}

/**
 * Convert PDF.js text items to PDF-point rectangles. PDF.js transforms use a
 * bottom-left origin; output boxes use a top-left origin to match canvas CSS.
 * Rotated text remains supported as an axis-aligned envelope. Non-text items
 * are ignored, while malformed text items fail closed.
 */
export function pdfJsTextItemsToBoxes(
  items: readonly PdfJsTextItemLike[],
  page: PdfPageSize,
): MeasuredTextBox[] {
  assertPageSize(page);
  const left = page.leftPt ?? 0;
  const bottom = page.bottomPt ?? 0;
  return items.flatMap((item, index) => {
    if (typeof item.str !== "string" || item.str.trim() === "") return [];
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) {
      throw new Error(`PDF.js text item ${index + 1} has no six-value transform`);
    }
    const x = finiteNumber(transform[4], `PDF.js text item ${index + 1} transform x`) - left;
    const baseline = finiteNumber(transform[5], `PDF.js text item ${index + 1} transform y`);
    const width = finiteNumber(item.width, `PDF.js text item ${index + 1} width`);
    const height = finiteNumber(item.height, `PDF.js text item ${index + 1} height`);
    if (width <= 0 || height <= 0) {
      throw new Error(`PDF.js text item ${index + 1} has non-positive bounds`);
    }
    const rect = {
      x,
      y: bottom + page.heightPt - baseline - height,
      width,
      height,
    };
    assertRectangle(rect, `PDF.js text item ${index + 1}`);
    return [{ text: item.str, rect, unit: "pdf-pt" as const }];
  });
}

/**
 * Parse the relevant subset of Poppler's `pdftotext -bbox` XML. Coordinates
 * are returned explicitly in PDF points; incomplete or malformed output is an
 * error so callers cannot silently treat missing extraction support as a pass.
 */
export function parsePopplerBboxXml(xml: string): PopplerBboxPage[] {
  if (typeof xml !== "string" || !/<doc(?:\s|>)/iu.test(xml)) {
    throw new Error("Poppler bbox output is missing its <doc> root");
  }
  const pageMatches = [...xml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page\s*>/giu)];
  const pageOpenCount = [...xml.matchAll(/<page\b/giu)].length;
  if (pageMatches.length === 0 || pageMatches.length !== pageOpenCount) {
    throw new Error("Poppler bbox output has missing or malformed <page> elements");
  }
  return pageMatches.map((match, index) => {
    const attributes = parseXmlAttributes(match[1] || "", `page ${index + 1}`);
    const widthPt = finiteNumber(attributes.width, `Poppler page ${index + 1} width`);
    const heightPt = finiteNumber(attributes.height, `Poppler page ${index + 1} height`);
    if (widthPt <= 0 || heightPt <= 0) {
      throw new Error(`Poppler page ${index + 1} has non-positive dimensions`);
    }
    const boxes = [...match[2]!.matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word\s*>/giu)].map((word, wordIndex) => {
      const wordAttributes = parseXmlAttributes(word[1] || "", `page ${index + 1} word ${wordIndex + 1}`);
      const xMin = finiteNumber(wordAttributes.xMin, `Poppler page ${index + 1} word ${wordIndex + 1} xMin`);
      const yMin = finiteNumber(wordAttributes.yMin, `Poppler page ${index + 1} word ${wordIndex + 1} yMin`);
      const xMax = finiteNumber(wordAttributes.xMax, `Poppler page ${index + 1} word ${wordIndex + 1} xMax`);
      const yMax = finiteNumber(wordAttributes.yMax, `Poppler page ${index + 1} word ${wordIndex + 1} yMax`);
      const text = decodeXmlText(word[2] || "").trim();
      const rect = { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin };
      if (!text || rect.width <= 0 || rect.height <= 0) {
        throw new Error(`Poppler page ${index + 1} word ${wordIndex + 1} has empty text or non-positive bounds`);
      }
      assertRectangle(rect, `Poppler page ${index + 1} word ${wordIndex + 1}`);
      return { text, rect, unit: "pdf-pt" as const };
    });
    return { page: index + 1, widthPt, heightPt, boxes };
  });
}

/** NFKC/case/punctuation-insensitive token form used for exact token matching. */
export function normalizedTextTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .match(/[\p{L}\p{N}]+/gu) || [];
}

export type TextMatch = {
  text: string;
  rect: Rectangle;
  boxIndices: number[];
  tokenRefs: string[];
};

/**
 * Find one complete, contiguous token sequence. It can span PDF.js items when
 * a renderer splits a text run, but never accepts a substring or partial text.
 * `expectedRect` disambiguates repeated labels by choosing the nearest bounds.
 */
export function findTextBounds(
  expectedText: string,
  boxes: readonly MeasuredTextBox[],
  options: { expectedRect?: Rectangle; claimedTokenRefs?: ReadonlySet<string> } = {},
): TextMatch | null {
  const wanted = normalizedTextTokens(expectedText);
  if (wanted.length === 0) return null;
  type PdfToken = {
    token: string;
    boxIndex: number;
    tokenIndex: number;
    boxTokenCount: number;
  };
  type TokenCandidate = { token: string; endIndex: number; fragments: PdfToken[] };

  const flattened: PdfToken[] = [];
  boxes.forEach((box, boxIndex) => {
    if (typeof box.text !== "string") return;
    const boxTokens = normalizedTextTokens(box.text);
    boxTokens.forEach((token, tokenIndex) => {
      flattened.push({ token, boxIndex, tokenIndex, boxTokenCount: boxTokens.length });
    });
  });

  // PDF.js sometimes emits a wrapped word as adjacent single-word items. Allow
  // only a geometrically adjacent run whose normalized concatenation is one
  // exact expected token; ordinary neighboring words remain separate tokens.
  const candidatesByStart: TokenCandidate[][] = flattened.map((entry, index) => [{
    token: entry.token,
    endIndex: index,
    fragments: [entry],
  }]);
  const expectedTokens = [...new Set(wanted)];
  for (let start = 0; start < flattened.length; start += 1) {
    const first = flattened[start]!;
    if (first.boxTokenCount !== 1 || first.tokenIndex !== 0) continue;

    for (const expectedToken of expectedTokens) {
      if (first.token.length >= expectedToken.length || !expectedToken.startsWith(first.token)) continue;
      let combined = first.token;
      const fragments = [first];
      for (let nextIndex = start + 1; nextIndex < flattened.length; nextIndex += 1) {
        const previous = fragments[fragments.length - 1]!;
        const next = flattened[nextIndex]!;
        if (next.boxTokenCount !== 1 || next.tokenIndex !== 0 || next.boxIndex === previous.boxIndex) break;
        if (!areAdjacentPdfTextFragments(boxes[previous.boxIndex]!, boxes[next.boxIndex]!)) break;

        combined += next.token;
        fragments.push(next);
        if (combined === expectedToken) {
          candidatesByStart[start]!.push({ token: combined, endIndex: nextIndex, fragments: [...fragments] });
          break;
        }
        if (!expectedToken.startsWith(combined)) break;
      }
    }
  }

  const matches: TextMatch[] = [];
  const selected: TokenCandidate[] = [];
  const visit = (cursor: number, wantedIndex: number) => {
    if (wantedIndex === wanted.length) {
      const fragments = selected.flatMap((candidate) => candidate.fragments);
      const tokenRefs = fragments.map(({ boxIndex, tokenIndex }) => `${boxIndex}:${tokenIndex}`);
      if (tokenRefs.some((reference) => options.claimedTokenRefs?.has(reference))) return;
      const boxIndices = [...new Set(fragments.map((entry) => entry.boxIndex))];
      const rect = unionRectangles(boxIndices.map((index) => boxes[index]!.rect));
      matches.push({ text: selected.map((candidate) => candidate.token).join(" "), rect, boxIndices, tokenRefs });
      return;
    }
    if (cursor >= flattened.length) return;
    for (const candidate of candidatesByStart[cursor]!) {
      if (candidate.token !== wanted[wantedIndex]) continue;
      selected.push(candidate);
      visit(candidate.endIndex + 1, wantedIndex + 1);
      selected.pop();
    }
  };

  for (let start = 0; start < flattened.length; start += 1) {
    visit(start, 0);
  }
  if (matches.length === 0) return null;
  if (!options.expectedRect || matches.length === 1) return matches[0]!;
  return matches.sort((left, right) => (
    rectangleDistance(left.rect, options.expectedRect!) - rectangleDistance(right.rect, options.expectedRect!)
  ))[0]!;
}

/**
 * Treat PDF text items as fragments only when their measured boxes nearly
 * touch on one baseline, or form aligned/overlapping adjacent lines. Distances
 * are tested in canvas pixels so PDF-point and PPTX-EMU inputs use the same
 * physical rule.
 */
function areAdjacentPdfTextFragments(left: MeasuredTextBox, right: MeasuredTextBox) {
  const leftRect = rectangleToCanvasPixels(left);
  const rightRect = rectangleToCanvasPixels(right);
  const referenceHeight = Math.min(leftRect.height, rightRect.height);
  if (referenceHeight <= 0) return false;
  const allowance = Math.max(2, referenceHeight * 0.5);
  const verticalOverlap = Math.max(
    0,
    Math.min(leftRect.y + leftRect.height, rightRect.y + rightRect.height) - Math.max(leftRect.y, rightRect.y),
  );
  const horizontalGap = Math.max(
    0,
    Math.max(leftRect.x - (rightRect.x + rightRect.width), rightRect.x - (leftRect.x + leftRect.width)),
  );
  const horizontalOverlap = Math.max(
    0,
    Math.min(leftRect.x + leftRect.width, rightRect.x + rightRect.width) - Math.max(leftRect.x, rightRect.x),
  );
  if (verticalOverlap >= referenceHeight * 0.5 && horizontalGap <= allowance) return true;

  const verticalGap = Math.max(
    0,
    Math.max(leftRect.y - (rightRect.y + rightRect.height), rightRect.y - (leftRect.y + leftRect.height)),
  );
  const verticallyAdjacent = verticalGap <= referenceHeight * 1.25;
  const alignedStarts = Math.abs(leftRect.x - rightRect.x) <= allowance;
  const substantialHorizontalOverlap = horizontalOverlap >= Math.min(leftRect.width, rightRect.width) * 0.5;
  return verticallyAdjacent && (alignedStarts || substantialHorizontalOverlap);
}

export type TextParityInput = {
  expectedText: string;
  expectedCanvasRect: Rectangle;
  slideCanvasSize: CanvasSize;
  canvasTextBox?: MeasuredTextBox;
  pptxTextBox?: MeasuredTextBox;
  pdfTextBoxes: readonly MeasuredTextBox[];
  claimedPdfTokenRefs?: Set<string>;
  tolerances?: Partial<ParityTolerance>;
};

/** Compare editor/PPTX geometry and ensure the exact PDF text remains inside its source box and slide margins. */
export function inspectTextParity(input: TextParityInput): { findings: ParityFinding[]; pdfMatch: TextMatch | null } {
  const tolerances = resolveTolerances(input.tolerances);
  assertRectangle(input.expectedCanvasRect, "source canvas text rectangle");
  assertCanvasSize(input.slideCanvasSize);
  const findings: ParityFinding[] = [];
  const sourceBounds = { x: 0, y: 0, width: input.slideCanvasSize.width, height: input.slideCanvasSize.height };
  if (!rectangleContainedBy(input.expectedCanvasRect, sourceBounds, tolerances.slideBoundsPx)) {
    findings.push({
      code: "SOURCE_OUTSIDE_SLIDE",
      message: "Source PresentationDocument text geometry violates the slide bounds.",
      expected: sourceBounds,
      actual: input.expectedCanvasRect,
      tolerance: tolerances.slideBoundsPx,
    });
  }

  inspectKnownBox({
    unit: "canvas-px",
    label: "Canvas",
    box: input.canvasTextBox,
    expectedText: input.expectedText,
    expectedRect: input.expectedCanvasRect,
    geometryTolerancePx: tolerances.canvasGeometryPx,
    missingCode: "CANVAS_TEXT_MISSING",
    textCode: "CANVAS_TEXT_MISMATCH",
    geometryCode: "CANVAS_GEOMETRY_MISMATCH",
    findings,
  });
  inspectKnownBox({
    unit: "pptx-emu",
    label: "PPTX",
    box: input.pptxTextBox,
    expectedText: input.expectedText,
    expectedRect: input.expectedCanvasRect,
    geometryTolerancePx: tolerances.pptxGeometryPx,
    missingCode: "PPTX_TEXT_MISSING",
    textCode: "PPTX_TEXT_MISMATCH",
    geometryCode: "PPTX_GEOMETRY_MISMATCH",
    findings,
  });

  const pdfBoxesCanvas = input.pdfTextBoxes.map((box) => ({
    ...box,
    rect: rectangleToCanvasPixels(box),
    unit: "canvas-px" as const,
  }));
  const pdfMatch = findTextBounds(input.expectedText, pdfBoxesCanvas, {
    expectedRect: input.expectedCanvasRect,
    claimedTokenRefs: input.claimedPdfTokenRefs,
  });
  if (!pdfMatch) {
    findings.push({ code: "PDF_TEXT_MISSING", message: "The complete normalized text was not found in the PDF text bounds." });
    return { findings, pdfMatch: null };
  }
  pdfMatch.tokenRefs.forEach((reference) => input.claimedPdfTokenRefs?.add(reference));
  if (!rectangleContainedBy(pdfMatch.rect, input.expectedCanvasRect, tolerances.pdfContainmentPx)) {
    findings.push({
      code: "PDF_TEXT_CLIPPED",
      message: "Extracted PDF text bounds extend beyond the source canvas text box.",
      expected: input.expectedCanvasRect,
      actual: pdfMatch.rect,
      tolerance: tolerances.pdfContainmentPx,
    });
  }
  if (!rectangleContainedBy(pdfMatch.rect, sourceBounds, tolerances.slideBoundsPx)) {
    findings.push({
      code: "PDF_TEXT_OUTSIDE_SLIDE",
      message: "Extracted PDF text bounds extend outside the slide.",
      expected: sourceBounds,
      actual: pdfMatch.rect,
      tolerance: tolerances.slideBoundsPx,
    });
  }
  const margins = rectangleMargins(pdfMatch.rect, sourceBounds);
  const minimumMargin = tolerances.minimumSlideMarginPx;
  if (Object.values(margins).some((margin) => margin < minimumMargin - tolerances.slideBoundsPx)) {
    findings.push({
      code: "PDF_TEXT_MARGIN",
      message: `Extracted PDF text violates the ${minimumMargin}px minimum slide margin (within ${tolerances.slideBoundsPx}px tolerance).`,
      expected: sourceBounds,
      actual: pdfMatch.rect,
      tolerance: tolerances.slideBoundsPx,
    });
  }
  return { findings, pdfMatch };
}

export function rectangleMargins(rect: Rectangle, bounds: Rectangle) {
  assertRectangle(rect, "measured rectangle");
  assertRectangle(bounds, "containing rectangle");
  return {
    left: rect.x - bounds.x,
    top: rect.y - bounds.y,
    right: bounds.x + bounds.width - (rect.x + rect.width),
    bottom: bounds.y + bounds.height - (rect.y + rect.height),
  };
}

function inspectKnownBox(input: {
  unit: GeometryUnit;
  label: string;
  box?: MeasuredTextBox;
  expectedText: string;
  expectedRect: Rectangle;
  geometryTolerancePx: number;
  missingCode: "CANVAS_TEXT_MISSING" | "PPTX_TEXT_MISSING";
  textCode: "CANVAS_TEXT_MISMATCH" | "PPTX_TEXT_MISMATCH";
  geometryCode: "CANVAS_GEOMETRY_MISMATCH" | "PPTX_GEOMETRY_MISMATCH";
  findings: ParityFinding[];
}) {
  if (!input.box) {
    input.findings.push({ code: input.missingCode, message: `${input.label} text box is missing.` });
    return;
  }
  if (input.box.unit !== input.unit) {
    input.findings.push({
      code: "INVALID_GEOMETRY",
      message: `${input.label} text box unit must be ${input.unit}, received ${input.box.unit}.`,
    });
    return;
  }
  const normalizedExpected = normalizedTextTokens(input.expectedText).join(" ");
  const normalizedActual = normalizedTextTokens(input.box.text).join(" ");
  if (!normalizedExpected || normalizedActual !== normalizedExpected) {
    input.findings.push({
      code: input.textCode,
      message: `${input.label} text does not match the complete source text after token normalization.`,
    });
  }
  const actual = rectangleToCanvasPixels(input.box);
  const delta = rectangleDelta(actual, input.expectedRect);
  if (Object.values(delta).some((difference) => Math.abs(difference) > input.geometryTolerancePx)) {
    input.findings.push({
      code: input.geometryCode,
      message: `${input.label} text geometry differs from the source by more than ${input.geometryTolerancePx}px.`,
      expected: input.expectedRect,
      actual,
      delta,
      tolerance: input.geometryTolerancePx,
    });
  }
}

function resolveTolerances(tolerances: Partial<ParityTolerance> = {}): ParityTolerance {
  const resolved = { ...DEFAULT_PARITY_TOLERANCES, ...tolerances };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Tolerance ${name} must be a finite non-negative number`);
  }
  return resolved;
}

function rectangleContainedBy(rect: Rectangle, bounds: Rectangle, tolerance: number) {
  return rect.x >= bounds.x - tolerance
    && rect.y >= bounds.y - tolerance
    && rect.x + rect.width <= bounds.x + bounds.width + tolerance
    && rect.y + rect.height <= bounds.y + bounds.height + tolerance;
}

function rectangleDelta(actual: Rectangle, expected: Rectangle): Rectangle {
  return {
    x: actual.x - expected.x,
    y: actual.y - expected.y,
    width: actual.width - expected.width,
    height: actual.height - expected.height,
  };
}

function rectangleDistance(left: Rectangle, right: Rectangle) {
  const horizontal = Math.abs(left.x - right.x) + Math.abs(left.width - right.width);
  const vertical = Math.abs(left.y - right.y) + Math.abs(left.height - right.height);
  return horizontal + vertical;
}

function unionRectangles(rectangles: readonly Rectangle[]): Rectangle {
  if (rectangles.length === 0) throw new Error("Cannot union an empty set of rectangles");
  rectangles.forEach((rect, index) => assertRectangle(rect, `union rectangle ${index + 1}`));
  const left = Math.min(...rectangles.map((rect) => rect.x));
  const top = Math.min(...rectangles.map((rect) => rect.y));
  const right = Math.max(...rectangles.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rectangles.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function assertPageSize(page: PdfPageSize) {
  assertFiniteNumber(page.widthPt, "PDF page width");
  assertFiniteNumber(page.heightPt, "PDF page height");
  if (page.widthPt <= 0 || page.heightPt <= 0) throw new Error("PDF page dimensions must be positive");
  if (page.leftPt !== undefined) assertFiniteNumber(page.leftPt, "PDF page left origin");
  if (page.bottomPt !== undefined) assertFiniteNumber(page.bottomPt, "PDF page bottom origin");
}

function assertCanvasSize(size: CanvasSize) {
  assertFiniteNumber(size.width, "canvas width");
  assertFiniteNumber(size.height, "canvas height");
  if (size.width <= 0 || size.height <= 0) throw new Error("Canvas dimensions must be positive");
}

function assertRectangle(rect: Rectangle, label: string) {
  if (!rect || typeof rect !== "object") throw new Error(`${label} is not a rectangle`);
  for (const key of ["x", "y", "width", "height"] as const) {
    assertFiniteNumber(rect[key], `${label} ${key}`);
  }
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`${label} has non-positive dimensions`);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`${label} is not numeric`);
  const parsed = typeof value === "number" ? value : Number(value);
  assertFiniteNumber(parsed, label);
  return parsed;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function parseXmlAttributes(source: string, label: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1]!] = decodeXmlText(match[2] ?? match[3] ?? "");
  }
  if (/\S/u.test(source.replace(pattern, ""))) throw new Error(`${label} contains malformed XML attributes`);
  return attributes;
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (entity, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
      throw new Error(`Invalid XML character entity ${entity}`);
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&[^\s;]+;/gu, (entity) => {
    throw new Error(`Unsupported XML entity ${entity}`);
  });
}
