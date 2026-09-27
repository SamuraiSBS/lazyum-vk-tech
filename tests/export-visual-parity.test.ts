import { describe, expect, it } from "vitest";
import {
  canvasPixelsToPdfPoints,
  findTextBounds,
  inspectTextParity,
  normalizedTextTokens,
  parsePopplerBboxXml,
  pdfJsTextItemsToBoxes,
  pdfPointsToCanvasPixels,
  pptxEmuToCanvasPixels,
  rectangleToCanvasPixels,
  type MeasuredTextBox,
} from "../src/lib/export-visual-parity";

describe("export visual parity measurements", () => {
  it("parses valid Poppler bbox pages in PDF points and rejects malformed output", () => {
    const pages = parsePopplerBboxXml(
      '<doc><page number="1" width="612" height="792"><word xMin="72" yMin="36" xMax="118.5" yMax="48">Hello &amp; world</word></page></doc>',
    );

    expect(pages).toEqual([{
      page: 1,
      widthPt: 612,
      heightPt: 792,
      boxes: [{
        text: "Hello & world",
        rect: { x: 72, y: 36, width: 46.5, height: 12 },
        unit: "pdf-pt",
      }],
    }]);
    expect(() => parsePopplerBboxXml("<html><body>unsupported</body></html>")).toThrow(/<doc>/u);
    expect(() => parsePopplerBboxXml('<doc><page width="612" height="792">')).toThrow(/malformed <page>/u);
    expect(() => parsePopplerBboxXml(
      '<doc><page width="612" height="792"><word xMin="9" yMin="2" xMax="1" yMax="8">bad</word></page></doc>',
    )).toThrow(/non-positive bounds/u);
  });

  it("converts PDF points, PDF.js lower-left transforms, and PPTX EMU into canvas pixels", () => {
    expect(canvasPixelsToPdfPoints(16)).toBe(12);
    expect(pdfPointsToCanvasPixels(12)).toBe(16);
    expect(pptxEmuToCanvasPixels(9_525)).toBe(1);
    expect(rectangleToCanvasPixels({
      text: "PDF",
      unit: "pdf-pt",
      rect: { x: 72, y: 48, width: 120, height: 12 },
    })).toEqual({ x: 96, y: 64, width: 160, height: 16 });

    const boxes = pdfJsTextItemsToBoxes([
      { str: "Rendered text", width: 120, height: 12, transform: [12, 0, 0, 12, 72, 480] },
      { str: "", width: 0, height: 0 },
    ], { widthPt: 720, heightPt: 540, leftPt: 0, bottomPt: 0 });
    expect(boxes).toEqual([{
      text: "Rendered text",
      rect: { x: 72, y: 48, width: 120, height: 12 },
      unit: "pdf-pt",
    }]);
    expect(() => pdfJsTextItemsToBoxes([
      { str: "cannot measure", width: 20, height: 10 },
    ], { widthPt: 720, heightPt: 540 })).toThrow(/no six-value transform/u);
  });

  it("matches complete normalized token sequences without accepting substrings", () => {
    expect(normalizedTextTokens(" ‘ＰｏｗｅｒＰｏｉｎｔ’—НАСТРОЙКА, 100% "))
      .toEqual(["powerpoint", "настройка", "100"]);

    const boxes: MeasuredTextBox[] = [
      { text: "Качество экспорта", rect: { x: 20, y: 20, width: 100, height: 18 }, unit: "canvas-px" },
      { text: "100%", rect: { x: 124, y: 20, width: 30, height: 18 }, unit: "canvas-px" },
      { text: "EXPORTS", rect: { x: 20, y: 50, width: 70, height: 18 }, unit: "canvas-px" },
    ];
    expect(findTextBounds("Качество экспорта — 100%", boxes)?.rect)
      .toEqual({ x: 20, y: 20, width: 134, height: 18 });
    expect(findTextBounds("EXPORT", boxes)).toBeNull();
    expect(findTextBounds("Отсутствующая надпись", boxes)).toBeNull();
  });

  it("reconstructs exact split words from adjacent PDF text fragments and claims every fragment", () => {
    const scaleWord: MeasuredTextBox[] = [
      { text: "Масштабиро", rect: { x: 100, y: 40, width: 64, height: 10 }, unit: "canvas-px" },
      { text: "вание", rect: { x: 100, y: 51, width: 32, height: 10 }, unit: "canvas-px" },
    ];
    const scaleMatch = findTextBounds("Масштабирование", scaleWord);
    expect(scaleMatch).toMatchObject({
      text: "масштабирование",
      rect: { x: 100, y: 40, width: 64, height: 21 },
      boxIndices: [0, 1],
      tokenRefs: ["0:0", "1:0"],
    });
    expect(findTextBounds("Масштабирование", scaleWord, {
      claimedTokenRefs: new Set(["1:0"]),
    })).toBeNull();

    const benefits: MeasuredTextBox[] = [
      { text: "Ключевые", rect: { x: 100, y: 20, width: 55, height: 10 }, unit: "canvas-px" },
      { text: "преимуществ", rect: { x: 100, y: 31, width: 80, height: 10 }, unit: "canvas-px" },
      { text: "а", rect: { x: 100, y: 42, width: 6, height: 10 }, unit: "canvas-px" },
    ];
    expect(findTextBounds("Ключевые\nпреимущества", benefits)).toMatchObject({
      text: "ключевые преимущества",
      rect: { x: 100, y: 20, width: 80, height: 32 },
      boxIndices: [0, 1, 2],
      tokenRefs: ["0:0", "1:0", "2:0"],
    });
  });

  it("reconstructs an indented wrapped PDF.js word from overlapping bounds after point conversion", () => {
    const boxes = pdfJsTextItemsToBoxes([
      {
        str: "Масштабиро",
        width: 84.9924,
        height: 13.493,
        transform: [13.493, 0, 0, 13.493, 221.386, 390.161],
      },
      {
        str: "вание",
        width: 39.6289,
        height: 13.493,
        transform: [13.493, 0, 0, 13.493, 244.12, 406.29],
      },
    ], { widthPt: 720, heightPt: 540 });

    expect(boxes[0]!.rect.x).toBeCloseTo(221.386, 6);
    expect(boxes[0]!.rect.y).toBeCloseTo(136.346, 6);
    expect(boxes[0]!.rect.width).toBeCloseTo(84.9924, 6);
    expect(boxes[0]!.rect.height).toBeCloseTo(13.493, 6);
    expect(boxes[1]!.rect.x).toBeCloseTo(244.12, 6);
    expect(boxes[1]!.rect.y).toBeCloseTo(120.217, 6);

    const match = findTextBounds("Масштабирование", boxes);
    expect(match?.text).toBe("масштабирование");
    expect(match?.boxIndices).toEqual([0, 1]);
    expect(match?.tokenRefs).toEqual(["0:0", "1:0"]);
    expect(match?.rect.x).toBeCloseTo(221.386, 6);
    expect(match?.rect.y).toBeCloseTo(120.217, 6);
    expect(match?.rect.width).toBeCloseTo(84.9924, 6);
    expect(match?.rect.height).toBeCloseTo(29.622, 6);
  });

  it("does not join exact word fragments when their PDF geometry is unrelated", () => {
    const unrelated: MeasuredTextBox[] = [
      { text: "преимуществ", rect: { x: 20, y: 20, width: 80, height: 10 }, unit: "canvas-px" },
      { text: "а", rect: { x: 220, y: 180, width: 6, height: 10 }, unit: "canvas-px" },
    ];
    expect(findTextBounds("преимущества", unrelated)).toBeNull();

    const nearbyButNotOverlapping: MeasuredTextBox[] = [
      { text: "преимуществ", rect: { x: 20, y: 20, width: 80, height: 10 }, unit: "canvas-px" },
      { text: "а", rect: { x: 105, y: 31, width: 6, height: 10 }, unit: "canvas-px" },
    ];
    expect(findTextBounds("преимущества", nearbyButNotOverlapping)).toBeNull();
  });

  it("reports missing text on each export surface", () => {
    const result = inspectTextParity({
      expectedText: "Published label",
      expectedCanvasRect: { x: 40, y: 35, width: 180, height: 40 },
      slideCanvasSize: { width: 400, height: 300 },
      pdfTextBoxes: [],
    });
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "CANVAS_TEXT_MISSING",
      "PPTX_TEXT_MISSING",
      "PDF_TEXT_MISSING",
    ]);
  });

  it("detects geometry, source-bound, PDF clipping, and slide-margin violations", () => {
    const expected = { x: 40, y: 35, width: 180, height: 40 };
    const result = inspectTextParity({
      expectedText: "Published label",
      expectedCanvasRect: expected,
      slideCanvasSize: { width: 400, height: 300 },
      canvasTextBox: {
        text: "Published label",
        rect: { x: 55, y: 35, width: 180, height: 40 },
        unit: "canvas-px",
      },
      pptxTextBox: {
        text: "Published label",
        rect: { x: 40 * 9_525, y: 35 * 9_525, width: 180 * 9_525, height: 40 * 9_525 },
        unit: "pptx-emu",
      },
      pdfTextBoxes: [{
        text: "Published label",
        rect: { x: 1, y: 1, width: 100, height: 20 },
        unit: "canvas-px",
      }],
      tolerances: { minimumSlideMarginPx: 10 },
    });

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "CANVAS_GEOMETRY_MISMATCH",
      "PDF_TEXT_CLIPPED",
      "PDF_TEXT_MARGIN",
    ]);

    const outside = inspectTextParity({
      expectedText: "edge",
      expectedCanvasRect: { x: -5, y: 10, width: 60, height: 25 },
      slideCanvasSize: { width: 400, height: 300 },
      pdfTextBoxes: [{ text: "edge", rect: { x: -4, y: 12, width: 32, height: 12 }, unit: "canvas-px" }],
      tolerances: { slideBoundsPx: 0, minimumSlideMarginPx: 0 },
    });
    expect(outside.findings.map((finding) => finding.code)).toEqual([
      "SOURCE_OUTSIDE_SLIDE",
      "CANVAS_TEXT_MISSING",
      "PPTX_TEXT_MISSING",
      "PDF_TEXT_OUTSIDE_SLIDE",
      "PDF_TEXT_MARGIN",
    ]);
  });

  it("honors explicit geometry and containment tolerances", () => {
    const result = inspectTextParity({
      expectedText: "Fits exactly",
      expectedCanvasRect: { x: 40, y: 35, width: 180, height: 40 },
      slideCanvasSize: { width: 400, height: 300 },
      canvasTextBox: {
        text: "Fits exactly",
        rect: { x: 41.5, y: 35, width: 180, height: 40 },
        unit: "canvas-px",
      },
      pptxTextBox: {
        text: "Fits exactly",
        rect: { x: 41.5 * 9_525, y: 35 * 9_525, width: 180 * 9_525, height: 40 * 9_525 },
        unit: "pptx-emu",
      },
      pdfTextBoxes: [{
        text: "Fits exactly",
        rect: { x: 38, y: 36, width: 182, height: 38 },
        unit: "canvas-px",
      }],
      tolerances: {
        canvasGeometryPx: 2,
        pptxGeometryPx: 2,
        pdfContainmentPx: 3,
        slideBoundsPx: 1,
        minimumSlideMarginPx: 2,
      },
    });
    expect(result.findings).toEqual([]);
  });
});
