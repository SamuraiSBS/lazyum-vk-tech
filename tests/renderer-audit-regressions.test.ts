import { describe, expect, it } from "vitest";
import { auditPresentation } from "../src/lib/audit";
import { renderPresentation } from "../src/lib/renderer";
import type { DesignSystem, PresentationPlan } from "../src/lib/schemas";

const design: DesignSystem = {
  version: 1,
  sourceName: "arbitrary-regression-fixture.pptx",
  slideSize: { width: 960, height: 540, aspectRatio: 1.778 },
  colors: ["#FFFFFF", "#000000"],
  typography: { headingFonts: ["Arial"], bodyFonts: ["Arial"], fontSizes: [19, 32], fontWeights: [400, 700] },
  spacing: { horizontalMargins: [80], verticalMargins: [40], gaps: [16] },
  shapes: { types: ["shape"], radii: [], strokes: ["#000000"] },
  masters: [],
  layouts: [{
    id: "arbitrary-overlap-layout",
    name: "Arbitrary overlap layout",
    source: "slide",
    sourceFile: "fixture",
    width: 960,
    height: 540,
    elements: [
      {
        id: "partial-image",
        type: "image",
        name: "Partial image",
        x: 80,
        y: 450,
        w: 320,
        h: 160,
        text: "",
        zIndex: 1,
        imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
      {
        id: "title-slot",
        type: "text",
        name: "Title",
        x: 80,
        y: 40,
        w: 700,
        h: 80,
        text: "",
        fontSize: 32,
        zIndex: 2,
      },
      {
        id: "overlapping-body-slot",
        type: "placeholder",
        name: "Body",
        x: 80,
        y: 40,
        w: 700,
        h: 80,
        text: "",
        fontSize: 19,
        zIndex: 3,
      },
    ],
    textSlots: 2,
    placeholderCount: 1,
    visualSlots: 1,
    cardCount: 0,
    composition: "text",
    recurringElementIds: [],
  }],
  recurringElements: [],
  visualPatterns: [],
  warnings: [],
};

const plan: PresentationPlan = {
  title: "Renderer geometry regression",
  planner: "deterministic",
  slides: Array.from({ length: 5 }, (_, index) => ({
    id: `slide-${index + 1}`,
    purpose: "summary",
    title: `Title ${index + 1}`,
    content: ["Body content stays in a fallback region."],
    visualIntent: "none",
  })),
};

describe("renderer geometry regressions", () => {
  it("drops arbitrary partial template images and separates overlapping title/body slots", () => {
    const document = renderPresentation(design, plan);
    const firstSlide = document.slides[0];
    if (!firstSlide) throw new Error("Expected rendered slide");

    expect(firstSlide.canvas.elements.some((element) => element.sourceTemplateElementId === "partial-image")).toBe(false);
    const title = firstSlide.canvas.elements.find((element) => element.id === "slide-1-text-0");
    const body = firstSlide.canvas.elements.find((element) => element.id === "slide-1-text-1");
    expect(title).toMatchObject({ sourceTemplateElementId: "title-slot", x: 80, y: 40, w: 700, h: 80 });
    expect(body).toMatchObject({ sourceTemplateElementId: "fallback-body" });

    const issues = auditPresentation(document).slides.flatMap((slide) => slide.issues);
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "OUTSIDE_SLIDE", severity: "error" }),
      expect.objectContaining({ type: "ELEMENT_OVERLAP", severity: "error" }),
    ]));
    expect(auditPresentation(document).passed).toBe(true);
  });

  it("insets zero-edge template body slots for every layout variant", () => {
    const edgeDesign: DesignSystem = {
      ...design,
      layouts: design.layouts.map((layout) => ({
        ...layout,
        elements: layout.elements.map((element) => element.id === "title-slot"
          ? { ...element, x: 80, y: 40, w: 700, h: 80 }
          : element.id === "overlapping-body-slot"
            ? { ...element, x: 0, y: 140, w: 700, h: 150 }
            : element),
      })),
    };

    for (const variant of ["compact", "balanced", "visual"] as const) {
      const document = renderPresentation(edgeDesign, plan, variant);
      const firstSlide = document.slides[0];
      if (!firstSlide) throw new Error(`Expected rendered slide for ${variant}`);
      const body = firstSlide.canvas.elements.find((element) => element.id === "slide-1-text-1");
      if (!body || body.type !== "text") throw new Error(`Expected materialized body text for ${variant}`);

      expect(body.sourceTemplateElementId).toBe("overlapping-body-slot");
      expect(body.x).toBeGreaterThanOrEqual(2);
      expect(body.x).toBe(6);
      expect(body.w).toBe(700);
      expect(body.x + body.w).toBeLessThanOrEqual(firstSlide.canvas.width - 2);
      expect(auditPresentation(document).passed).toBe(true);

      for (const element of firstSlide.canvas.elements) {
        if (element.type !== "text") continue;
        expect(element.x).toBeGreaterThanOrEqual(2);
        expect(element.y).toBeGreaterThanOrEqual(2);
        expect(element.x + element.w).toBeLessThanOrEqual(firstSlide.canvas.width - 2);
        expect(element.y + element.h).toBeLessThanOrEqual(firstSlide.canvas.height - 2);
      }
    }
  });

  it("backs generated text on an unknown full-slide raster with a high-contrast panel", () => {
    const rasterDesign: DesignSystem = {
      ...design,
      layouts: design.layouts.map((layout) => ({
        ...layout,
        elements: [
          {
            id: "full-slide-raster",
            type: "image" as const,
            name: "Full slide raster",
            x: 0,
            y: 0,
            w: layout.width,
            h: layout.height,
            text: "",
            zIndex: 1,
            imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          },
          ...layout.elements.filter((element) => element.type !== "image"),
        ],
      })),
    };
    const document = renderPresentation(rasterDesign, plan);
    const firstSlide = document.slides[0];
    if (!firstSlide) throw new Error("Expected a rendered slide on the raster template");

    expect(firstSlide.canvas.elements.some((element) => element.sourceTemplateElementId === "full-slide-raster")).toBe(true);
    firstSlide.canvas.elements.filter((element) => element.type === "text").forEach((text) => {
      const panel = firstSlide.canvas.elements.find((element) => element.id === `${text.id}-contrast-panel`);
      expect(panel).toMatchObject({ type: "shape", fill: "#FFFFFF" });
      if (!panel || panel.type !== "shape" || text.type !== "text") throw new Error("Expected a white contrast panel behind each text box");
      expect(panel.x).toBeLessThanOrEqual(text.x);
      expect(panel.y).toBeLessThanOrEqual(text.y);
      expect(panel.x + panel.w).toBeGreaterThanOrEqual(text.x + text.w);
      expect(panel.y + panel.h).toBeGreaterThanOrEqual(text.y + text.h);
      expect(panel.zIndex).toBeLessThan(text.zIndex);
      expect(text.color).toBe("#000000");
    });
  });

  it("uses the visible light text surface when the slide background is dark", () => {
    const surfaceDesign: DesignSystem = {
      ...design,
      layouts: design.layouts.map((layout) => ({
        ...layout,
        background: "#101010",
        elements: [
          ...layout.elements.filter((element) => element.type !== "image" && element.id !== "overlapping-body-slot"),
          { id: "light-panel", type: "shape" as const, name: "Content surface",
            x: 75, y: 135, w: 710, h: 170, text: "", fill: "#F5F5F5", zIndex: 2 },
          { ...layout.elements.find((element) => element.id === "overlapping-body-slot")!,
            x: 80, y: 140, w: 700, h: 150, zIndex: 3 },
        ],
      })),
    };
    const firstSlide = renderPresentation(surfaceDesign, plan).slides[0];
    const body = firstSlide?.canvas.elements.find((element) => element.id === "slide-1-text-1");
    expect(body).toMatchObject({ type: "text", color: "#000000" });
  });

  it("keeps rendered body below the title when the only template body slot is above it", () => {
    const misorderedDesign: DesignSystem = {
      ...design,
      layouts: design.layouts.map((layout) => ({
        ...layout,
        elements: layout.elements.map((element) => element.id === "title-slot"
          ? { ...element, y: 220, h: 90 }
          : element.id === "overlapping-body-slot"
            ? { ...element, x: 80, y: 35, w: 700, h: 100 }
            : element),
      })),
    };
    const document = renderPresentation(misorderedDesign, plan);
    const firstSlide = document.slides[0];
    if (!firstSlide) throw new Error("Expected a rendered slide with a misordered source body slot");
    const title = firstSlide.canvas.elements.find((element) => element.id === "slide-1-text-0");
    const body = firstSlide.canvas.elements.find((element) => element.id === "slide-1-text-1");
    if (!title || title.type !== "text" || !body || body.type !== "text") {
      throw new Error("Expected both title and planned body text");
    }

    expect(body.y).toBeGreaterThanOrEqual(title.y + title.h);
    expect(body.text.replace(/\s+/gu, " ")).toContain("Body content stays in a fallback region.");
  });

  it("replaces the template body slot with fallback timeline labels without dropping content", () => {
    const timelineContent = ["Timeline item 1", "Timeline item 2", "Timeline item 3", "Timeline item 4", "Timeline item 5"];
    const timelinePlan: PresentationPlan = {
      ...plan,
      slides: plan.slides.map((slide, index) => index === 0
        ? { ...slide, visualIntent: "timeline", content: timelineContent }
        : slide),
    };

    for (const variant of ["compact", "balanced", "visual"] as const) {
      const document = renderPresentation(design, timelinePlan, variant);
      const firstSlide = document.slides[0];
      if (!firstSlide) throw new Error("Expected rendered timeline slide");
      const text = firstSlide.canvas.elements.filter((element) => element.type === "text");
      const timelineLabels = text
        .filter((element) => element.id.startsWith("slide-1-timeline-label-"))
        .map((element) => element.text);

      expect(text.some((element) => element.id === "slide-1-text-1")).toBe(false);
      expect(timelineLabels).toEqual([
        "Timeline item 1",
        "Timeline item 2",
        "Timeline item 3",
        "Timeline item 4 · Timeline item 5",
      ]);
      expect(auditPresentation(document).passed).toBe(true);
    }
  });

  it("clips decorative template lines to slide bounds while preserving the visible segment", () => {
    const lineDesign: DesignSystem = {
      ...design,
      layouts: design.layouts.map((layout) => ({
        ...layout,
        elements: [...layout.elements,
          { id: "edge-line", type: "line", name: "Edge line", x: 900, y: 100, w: 120, h: 60, text: "", zIndex: 4 },
          { id: "off-canvas-line", type: "line", name: "Off-canvas line", x: 980, y: 100, w: 120, h: 60, text: "", zIndex: 5 },
        ],
      })),
    };
    const document = renderPresentation(lineDesign, plan);
    const firstSlide = document.slides[0];
    if (!firstSlide) throw new Error("Expected rendered slide with clipped template line");
    const visibleLine = firstSlide.canvas.elements.find((element) => element.sourceTemplateElementId === "edge-line");

    expect(visibleLine).toMatchObject({ x: 900, y: 100, w: 60, h: 30 });
    expect(firstSlide.canvas.elements.some((element) => element.sourceTemplateElementId === "off-canvas-line")).toBe(false);
    expect(auditPresentation(document).passed).toBe(true);
  });

  it("uses the generated fallback body when a template body slot cannot fit its text", () => {
    const narrowBodyDesign: DesignSystem = {
      ...design,
      layouts: design.layouts.map((layout) => ({
        ...layout,
        elements: layout.elements.map((element) => element.id === "overlapping-body-slot"
          ? { ...element, y: 140, w: 320, h: 72 }
          : element),
      })),
    };
    const longContent = "Detailed body text ".repeat(11).trim();
    const longTextPlan: PresentationPlan = {
      ...plan,
      slides: plan.slides.map((slide, index) => index === 0 ? { ...slide, content: [longContent] } : slide),
    };

    for (const variant of ["compact", "balanced", "visual"] as const) {
      const document = renderPresentation(narrowBodyDesign, longTextPlan, variant);
      const firstSlide = document.slides[0];
      if (!firstSlide) throw new Error("Expected rendered slide with fallback body");
      const body = firstSlide.canvas.elements.find((element) => element.id === "slide-1-text-1");

      expect(body).toMatchObject({ sourceTemplateElementId: "fallback-body" });
      expect(auditPresentation(document).passed).toBe(true);
    }
  });
});
