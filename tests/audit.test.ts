import { describe, expect, it } from "vitest";
import { auditCanvas, auditPresentation, measureTextForBox } from "../src/lib/audit";
import { renderPresentation } from "../src/lib/renderer";
import { auditReportSchema, type DesignSystem, type PresentationPlan, type SlideCanvas } from "../src/lib/schemas";

const design: DesignSystem = {
  version: 1,
  sourceName: "test.pptx",
  slideSize: { width: 1280, height: 720, aspectRatio: 1.778 },
  colors: ["#FFFFFF", "#000000", "#7B3DFF"],
  typography: { headingFonts: ["Arial"], bodyFonts: ["Arial"], fontSizes: [16, 32], fontWeights: [400, 700] },
  spacing: { horizontalMargins: [80], verticalMargins: [60], gaps: [16] },
  shapes: { types: ["shape"], radii: [], strokes: ["#7B3DFF"] },
  masters: [],
  layouts: [{
    id: "layout-1", name: "Test", source: "layout", sourceFile: "test",
    width: 1280, height: 720, elements: [], textSlots: 1, placeholderCount: 0, visualSlots: 0, cardCount: 0,
    composition: "text", recurringElementIds: [],
  }],
  recurringElements: [],
  visualPatterns: [],
  warnings: [],
};

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/mXPo5QAAAABJRU5ErkJggg==";
const corruptPixel = (() => {
  const bytes = Buffer.from(pixel.split(",")[1], "base64");
  bytes[54] ^= 1; // Keep the chunk structure, but invalidate its IDAT CRC.
  return `data:image/png;base64,${bytes.toString("base64")}`;
})();

function makeImage(overrides: Partial<Extract<SlideCanvas["elements"][number], { type: "image" }>> = {}) {
  return {
    id: "image-1",
    type: "image" as const,
    x: 100,
    y: 100,
    w: 100,
    h: 100,
    alt: "Test image",
    dataUrl: pixel,
    zIndex: 1,
    locked: false,
    ...overrides,
  };
}

function makeText(overrides: Partial<Extract<SlideCanvas["elements"][number], { type: "text" }>> = {}) {
  return {
    id: "contrast-text",
    type: "text" as const,
    x: 100,
    y: 120,
    w: 320,
    h: 80,
    text: "Contrast check",
    fontFamily: "Arial",
    fontSize: 16,
    fontWeight: 400,
    color: "#777777",
    align: "left" as const,
    zIndex: 10,
    locked: false,
    ...overrides,
  };
}

function makeCanvas(elements: SlideCanvas["elements"], background = "#FFFFFF"): SlideCanvas {
  return { width: 1280, height: 720, background, elements };
}

function contrastIssues(canvas: SlideCanvas) {
  return auditCanvas(canvas, design).filter((issue) => issue.type === "LOW_TEXT_CONTRAST");
}

describe("Audit Engine", () => {
  it.each([undefined, "", "data:image/png;base64,AAAA", "data:image/png;base64,@@@", "https://example.com/a.png", corruptPixel, "data:image/jpeg;base64,/9j/2Q=="])(
    "reports missing or malformed image data as a stable fatal finding: %s",
    (dataUrl) => {
      const issues = auditCanvas(makeCanvas([makeImage({ dataUrl })]), design);
      expect(issues.filter((candidate) => candidate.type === "INVALID_IMAGE_DATA")).toEqual([{
        type: "INVALID_IMAGE_DATA",
        severity: "error",
        elementId: "image-1",
        message: "Image has missing or malformed embedded data",
      }]);
    },
  );

  it("warns for material uncropped image stretch and accepts a proportional frame", () => {
    const issues = auditCanvas(makeCanvas([
      makeImage({ id: "stretched", w: 200, h: 100 }),
      makeImage({ id: "proportional", x: 400, w: 100, h: 100 }),
    ]), design);
    expect(issues.filter((candidate) => candidate.type === "IMAGE_ASPECT_DISTORTION")).toEqual([{
      type: "IMAGE_ASPECT_DISTORTION",
      severity: "warning",
      elementId: "stretched",
      message: "Image frame materially changes the intrinsic aspect ratio",
    }]);
  });

  it.each([
    ["positive crop", { left: 20, right: 30, top: 0, bottom: 0 }, 100, 200],
    ["negative crop", { left: -50, right: 0, top: 0, bottom: 0 }, 150, 100],
  ])("checks visible intrinsic aspect for %s", (_label, crop, matchingWidth, matchingHeight) => {
    const issues = auditCanvas(makeCanvas([
      makeImage({ id: "matching-crop", w: matchingWidth, h: matchingHeight, crop }),
      makeImage({ id: "stretched-crop", x: 400, w: 100, h: 100, crop }),
    ]), design).filter((candidate) => candidate.type === "IMAGE_ASPECT_DISTORTION");

    expect(issues).toEqual([{
      type: "IMAGE_ASPECT_DISTORTION",
      severity: "warning",
      elementId: "stretched-crop",
      message: "Image frame materially changes the intrinsic aspect ratio",
    }]);
  });

  it("keeps an embedded image with uncertain dimensions nonfatal", () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>').toString("base64")}`;
    const issues = auditCanvas(makeCanvas([makeImage({ dataUrl: svg, w: 200, h: 100 })]), design);
    expect(issues.filter((candidate) => candidate.type.startsWith("IMAGE_") || candidate.type === "INVALID_IMAGE_DATA")).toEqual([]);
  });
  it("warns on a later slide with the same normalized title and substantive text", () => {
    const document = renderPresentation(design, {
      title: "Duplicate audit",
      planner: "deterministic",
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `slide-${index + 1}`,
        purpose: "summary" as const,
        title: `Unique title ${index + 1}`,
        content: [`Unique body ${index + 1}`],
        visualIntent: "none" as const,
      })),
    });
    document.slides[0].title = "  Q3   RESULTS ";
    document.slides[0].canvas = makeCanvas([
      makeText({ id: "first-title", text: "Q3 Results", y: 100 }),
      makeText({ id: "first-body", text: "Revenue grew across all regions", y: 260 }),
      makeText({ id: "first-footer", text: "Company confidential", y: 670, h: 24 }),
    ]);
    document.slides[1].title = "q3 results";
    document.slides[1].canvas = makeCanvas([
      makeText({ id: "second-title", text: "q3 results", y: 100 }),
      makeText({ id: "second-body", text: " Revenue  grew across all regions ", y: 260 }),
      makeText({ id: "second-footer", text: "Different footer", y: 670, h: 24 }),
      { id: "decoration", type: "shape", x: 800, y: 500, w: 80, h: 80, shape: "rect", fill: "#7B3DFF", stroke: "#7B3DFF", strokeWidth: 0, radius: 0, zIndex: 1, locked: false },
    ]);

    const report = auditReportSchema.parse(auditPresentation(document));
    expect(report.passed).toBe(true);
    expect(report.slides[0].issues.some((candidate) => candidate.type === "DUPLICATE_SLIDE")).toBe(false);
    expect(report.slides[1].issues.filter((candidate) => candidate.type === "DUPLICATE_SLIDE")).toEqual([{
      type: "DUPLICATE_SLIDE",
      severity: "warning",
      elementId: undefined,
      message: "Substantive content matches slide-1",
    }]);
  });

  it("does not treat a repeated title, footer, or decoration as duplicated substantive content", () => {
    const document = renderPresentation(design, {
      title: "Distinct content",
      planner: "deterministic",
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `slide-${index + 1}`,
        purpose: "summary" as const,
        title: "Quarterly results",
        content: [`Distinct content ${index + 1}`],
        visualIntent: "none" as const,
      })),
    });
    document.slides.forEach((slide, index) => {
      slide.canvas = makeCanvas([
        makeText({ id: `title-${index}`, text: "Quarterly results", y: 100 }),
        ...(index < 2 ? [makeText({ id: `body-${index}`, text: `Different body ${index + 1}`, y: 260 })] : []),
        makeText({ id: `footer-${index}`, text: "Company confidential", y: 670, h: 24 }),
      ]);
    });

    const report = auditPresentation(document);
    expect(report.slides.flatMap((slide) => slide.issues).filter((candidate) => candidate.type === "DUPLICATE_SLIDE")).toEqual([]);
  });

  it.each([
    ["lorem ipsum", "lorem ipsum"],
    ["mixed-case lorem ipsum", "LoReM IpSuM"],
    ["XXX", "XXX"],
    ["TODO", "todo"],
    ["Russian placeholder", "Вставьте текст"],
  ])("reports placeholder content: %s", (_label, text) => {
    const issues = auditCanvas(makeCanvas([makeText({ id: "placeholder", text })]), design)
      .filter((issue) => issue.type === "EMPTY_PLACEHOLDER");

    expect(issues).toEqual([expect.objectContaining({
      type: "EMPTY_PLACEHOLDER",
      severity: "error",
      elementId: "placeholder",
      message: "Text contains placeholder content",
    })]);
  });

  it("does not report ordinary text or marker fragments inside words", () => {
    const issues = auditCanvas(makeCanvas([makeText({
      text: "The todoist has an xxxylophone, loremipsum and невставьтетекстовый example.",
    })]), design).filter((issue) => issue.type === "EMPTY_PLACEHOLDER");

    expect(issues).toEqual([]);
  });

  it("keeps reporting empty text as an error placeholder", () => {
    const issues = auditCanvas(makeCanvas([makeText({ text: " \n\t" })]), design)
      .filter((issue) => issue.type === "EMPTY_PLACEHOLDER");

    expect(issues).toEqual([expect.objectContaining({
      type: "EMPTY_PLACEHOLDER",
      severity: "error",
      message: "Text placeholder is empty",
    })]);
  });

  it("fails presentation audit when placeholder content is found", () => {
    const document = renderPresentation(design, {
      title: "Placeholder audit",
      planner: "deterministic",
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `slide-${index + 1}`,
        purpose: "summary" as const,
        title: `Slide ${index + 1}`,
        content: ["Generated text"],
        visualIntent: "none" as const,
      })),
    });
    document.slides.forEach((slide, index) => {
      slide.canvas = makeCanvas(index === 0 ? [makeText({ id: "found-placeholder", text: "TODO" })] : []);
    });

    const report = auditPresentation(document);

    expect(report.passed).toBe(false);
    expect(report.slides[0].issues).toContainEqual(expect.objectContaining({
      type: "EMPTY_PLACEHOLDER",
      severity: "error",
      elementId: "found-placeholder",
    }));
  });

  it("returns structured deterministic issues", () => {
    const canvas: SlideCanvas = {
      width: 1280,
      height: 720,
      background: "#FFFFFF",
      elements: [{
        id: "too-small",
        type: "text",
        x: 4,
        y: 4,
        w: 120,
        h: 15,
        text: "This line is intentionally too long for a tiny text box",
        fontFamily: "Unknown Font",
        fontSize: 10,
        fontWeight: 400,
        color: "#FF0000",
        align: "left",
        zIndex: 1,
        locked: false,
      }, {
        id: "outside",
        type: "shape",
        x: 1200,
        y: 680,
        w: 120,
        h: 80,
        shape: "rect",
        fill: "#FFFFFF",
        stroke: "#FFFFFF",
        strokeWidth: 0,
        radius: 0,
        zIndex: 2,
        locked: false,
      }],
    };
    const types = auditCanvas(canvas, design).map((issue) => issue.type);
    expect(types).toContain("TEXT_OVERFLOW");
    expect(types).toContain("SMALL_TEXT");
    expect(types).toContain("UNSUPPORTED_FONT");
    expect(types).toContain("COLOR_OUTSIDE_DESIGN_SYSTEM");
    expect(types).toContain("OUTSIDE_SLIDE");
  });

  it("uses one text model for narrow and wide boxes while preserving explicit line breaks", () => {
    const text = "A measured line wraps predictably\nand explicit breaks stay explicit";
    const narrow = measureTextForBox(text, 16, 160);
    const wide = measureTextForBox(text, 16, 640);

    expect(narrow.charsPerLine).toBeLessThan(wide.charsPerLine);
    expect(narrow.lineCount).toBeGreaterThan(wide.lineCount);
    expect(narrow.wrappedText).toContain("\n");
    expect(narrow.lineHeight).toBe(16 * 1.28);

    const canvas: SlideCanvas = {
      width: 1280,
      height: 720,
      background: "#FFFFFF",
      elements: [{
        id: "slide-1-text-1",
        type: "text",
        x: 80,
        y: 120,
        w: 160,
        h: narrow.height,
        text,
        fontFamily: "Arial",
        fontSize: 16,
        fontWeight: 400,
        color: "#000000",
        align: "left",
        zIndex: 1,
        locked: false,
      }, {
        id: "slide-1-text-2",
        type: "text",
        x: 320,
        y: 120,
        w: 640,
        h: wide.height,
        text,
        fontFamily: "Arial",
        fontSize: 16,
        fontWeight: 400,
        color: "#000000",
        align: "left",
        zIndex: 2,
        locked: false,
      }],
    };

    expect(auditCanvas(canvas, design)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TEXT_OVERFLOW" }),
    ]));
  });

  it("uses footer geometry rather than generated element ids for small-margin exceptions", () => {
    const plan: PresentationPlan = {
      title: "Generated identifiers",
      planner: "deterministic",
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `slide-${index + 1}`,
        purpose: "summary",
        title: `Slide ${index + 1}`,
        content: ["Generated text"],
        visualIntent: "none",
      })),
    };
    const generated = renderPresentation(design, plan).slides[0].canvas;
    const generatedText = generated.elements.find((element) => element.type === "text");
    if (!generatedText || generatedText.type !== "text") throw new Error("Expected generated text element");
    generatedText.x = 4;
    const canvas: SlideCanvas = {
      ...generated,
      elements: [...generated.elements, {
        id: "slide-1-text-9",
        type: "text",
        x: 80,
        y: 670,
        w: 220,
        h: 24,
        text: "Page 1",
        fontFamily: "Arial",
        fontSize: 16,
        fontWeight: 400,
        color: "#000000",
        align: "left",
        zIndex: 2,
        locked: false,
      }],
    };
    const issues = auditCanvas(canvas, design);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "SMALL_MARGIN", elementId: generatedText.id }),
    ]));
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "SMALL_MARGIN", elementId: "slide-1-text-9" }),
    ]));
  });

  it("warns below 4.5:1 and accepts sufficient normal-text contrast without rounding the threshold", () => {
    const issues = contrastIssues(makeCanvas([
      makeText({ id: "below-aa", color: "#777777" }),
      makeText({ id: "meets-aa", x: 520, color: "#767676" }),
    ]));

    expect(issues).toEqual([expect.objectContaining({
      type: "LOW_TEXT_CONTRAST",
      severity: "warning",
      elementId: "below-aa",
    })]);
    // #777777 on white is about 4.48:1, which rounds to 4.5:1 at one decimal.
    // It must still fail the unrounded 4.5:1 comparison.
  });

  it("uses the 3:1 threshold for large text", () => {
    const issues = contrastIssues(makeCanvas([
      makeText({ id: "large-meets-aa", color: "#949494", fontSize: 24 }),
      makeText({ id: "large-below-aa", x: 520, color: "#959595", fontSize: 24 }),
    ]));

    expect(issues).toEqual([expect.objectContaining({
      type: "LOW_TEXT_CONTRAST",
      severity: "warning",
      elementId: "large-below-aa",
    })]);
  });

  it("uses the topmost fully containing shape as the text background", () => {
    const text = makeText({ color: "#767676" });
    const canvas = makeCanvas([{
      id: "lower-text-background",
      type: "shape",
      x: 80,
      y: 100,
      w: 400,
      h: 140,
      shape: "rect",
      fill: "#000000",
      stroke: "#000000",
      strokeWidth: 0,
      radius: 0,
      zIndex: 3,
      locked: false,
    }, {
      id: "text-background",
      type: "shape",
      x: 80,
      y: 100,
      w: 400,
      h: 140,
      shape: "rect",
      fill: "#FFFFFF",
      stroke: "#FFFFFF",
      strokeWidth: 0,
      radius: 0,
      zIndex: 5,
      locked: false,
    }, text], "#767676");

    expect(contrastIssues(canvas)).toEqual([]);
  });

  it("skips contrast for ambiguous backgrounds and unsupported color formats", () => {
    const imageCanvas = makeCanvas([makeText(), {
      id: "image-behind-text",
      type: "image",
      x: 90,
      y: 110,
      w: 220,
      h: 100,
      alt: "",
      zIndex: 5,
      locked: false,
    }]);
    const partialShapeCanvas = makeCanvas([makeText({ color: "#767676" }), {
      id: "partial-background",
      type: "shape",
      x: 90,
      y: 110,
      w: 120,
      h: 100,
      shape: "rect",
      fill: "#000000",
      stroke: "#000000",
      strokeWidth: 0,
      radius: 0,
      zIndex: 5,
      locked: false,
    }]);
    const unsupportedColorCanvas = makeCanvas([makeText({ color: "rgb(0, 0, 0)" })], "white");

    expect(contrastIssues(imageCanvas)).toEqual([]);
    expect(contrastIssues(partialShapeCanvas)).toEqual([]);
    expect(contrastIssues(unsupportedColorCanvas)).toEqual([]);
  });

  it("keeps low-contrast findings advisory for auditReport.passed", () => {
    const document = renderPresentation(design, {
      title: "Advisory contrast",
      planner: "deterministic",
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `slide-${index + 1}`,
        purpose: "summary" as const,
        title: `Slide ${index + 1}`,
        content: ["Generated text"],
        visualIntent: "none" as const,
      })),
    });
    document.slides.forEach((slide, index) => {
      slide.canvas = makeCanvas(index === 0 ? [makeText({ color: "#777777" })] : []);
    });

    const report = auditPresentation(document);

    expect(report.passed).toBe(true);
    expect(report.slides[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "LOW_TEXT_CONTRAST", severity: "warning" }),
    ]));
  });
});
