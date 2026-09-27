import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";

type Rect = { x: number; y: number; w: number; h: number };

function intersection(left: Rect, right: Rect) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const w = Math.min(left.x + left.w, right.x + right.w) - x;
  const h = Math.min(left.y + left.h, right.y + right.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

function relativeLuminance(color: string) {
  const match = /^#([\da-f]{6})$/iu.exec(color);
  if (!match) throw new Error(`Expected a six-digit sRGB color, received ${color}`);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function contains(outer: Rect, inner: Rect) {
  return outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.w >= inner.x + inner.w
    && outer.y + outer.h >= inner.y + inner.h;
}

function significantArtwork(layout: Awaited<ReturnType<typeof parsePptxTemplate>>["layouts"][number]) {
  const canvasArea = layout.width * layout.height;
  return layout.elements.filter((element) => {
    const areaRatio = (element.w * element.h) / canvasArea;
    if (areaRatio < 0.003 || areaRatio >= 0.82) return false;
    if (element.type === "image") return Boolean(element.imageDataUrl)
      && element.x >= 0
      && element.y >= 0
      && element.x + element.w <= layout.width + 1
      && element.y + element.h <= layout.height + 1;
    return (element.type === "shape" || element.type === "line")
      && !element.text.trim()
      && element.x < layout.width
      && element.y < layout.height
      && element.x + element.w > 0
      && element.y + element.h > 0;
  });
}

function effectiveBackgroundColors(slide: {
  canvas: {
    background: string;
    elements: Array<Rect & {
      id: string;
      type: string;
      zIndex: number;
      fill?: string;
      stroke?: string;
      shape?: string;
    }>;
  };
}, label: Rect & { zIndex: number }) {
  const graphics = slide.canvas.elements
    .filter((element) => element.type !== "text" && element.zIndex < label.zIndex && intersection(element, label))
    .sort((left, right) => left.zIndex - right.zIndex);
  let coverIndex = -1;
  graphics.forEach((element, index) => {
    if (
      element.type === "shape"
      && element.shape !== "line"
      && typeof element.fill === "string"
      && contains(element, label)
    ) coverIndex = index;
  });
  const visibleGraphics = coverIndex >= 0 ? graphics.slice(coverIndex) : graphics;
  expect(visibleGraphics.filter((element) => element.type === "image").length).toBe(0);

  const colors = coverIndex >= 0 ? [] : [slide.canvas.background];
  visibleGraphics.forEach((element) => {
    if (element.type !== "shape") return;
    const color = element.shape === "line" ? element.stroke || element.fill : element.fill;
    if (color) colors.push(color);
  });
  return [...new Set(colors)];
}

describe("VK Tech fallback timeline visual regressions", () => {
  it("keeps every fallback timeline label readable and clear of the title on the organizer fixture", async () => {
    const templatePath = path.resolve(process.cwd(), "fixtures/templates/organizer/VK Tech шаблон.pptx");
    const designSystem = await parsePptxTemplate(await readFile(templatePath), "VK Tech шаблон.pptx");
    const plan = await createPresentationPlan({
      brief: "Детерминированная диагностика fallback timeline",
      documents: [],
      excerpts: [],
      keywords: [],
      sourceChunks: [],
    }, 10);
    const document = renderPresentation(designSystem, plan, "visual");

    expect(plan.slides[5]).toMatchObject({
      id: "slide-6",
      title: "Как это работает",
      content: ["Входные данные", "Обработка и принятие решений", "Результат и обратная связь"],
      visualIntent: "timeline",
    });
    expect(plan.slides[7]).toMatchObject({
      id: "slide-8",
      title: "План реализации",
      content: ["Подготовка", "Пилот и проверка", "Масштабирование"],
      visualIntent: "timeline",
    });

    for (const slideId of ["slide-6", "slide-8"]) {
      const slide = document.slides.find((candidate) => candidate.id === slideId);
      if (!slide) throw new Error(`Expected rendered ${slideId}`);
      const selectedLayout = designSystem.layouts.find((layout) => layout.id === slide.templateLayoutId);
      if (!selectedLayout) throw new Error(`Expected selected template layout ${slide.templateLayoutId}`);

      const title = slide.canvas.elements.find((element) => element.id === `${slideId}-text-0`);
      if (!title || title.type !== "text") throw new Error(`Expected title text element for ${slideId}`);
      const labels = slide.canvas.elements.filter((element) => element.id.startsWith(`${slideId}-timeline-label-`));
      expect(labels).toHaveLength(3);
      const plannedSlide = plan.slides.find((candidate) => candidate.id === slideId);
      if (!plannedSlide) throw new Error(`Expected planned ${slideId}`);
      expect(labels.map((element) => element.type === "text" ? element.text : undefined)).toEqual(plannedSlide.content);

      const timelineGraphics = slide.canvas.elements.filter((element) => (
        element.id === `${slideId}-timeline-line`
        || element.id.startsWith(`${slideId}-timeline-dot-`)
        || element.id.startsWith(`${slideId}-timeline-panel-`)
      ));
      expect(timelineGraphics).toHaveLength(7);
      const graphicsToCheck = [...labels, ...timelineGraphics];
      significantArtwork(selectedLayout).forEach((artwork) => {
        graphicsToCheck.forEach((graphic) => {
          expect(intersection(artwork, graphic)).toBeUndefined();
        });
      });

      labels.forEach((element, index) => {
        if (element.type !== "text") throw new Error("Expected fallback timeline labels to be text elements");
        expect(element.x).toBeGreaterThanOrEqual(0);
        expect(element.y).toBeGreaterThanOrEqual(0);
        expect(element.x + element.w).toBeLessThanOrEqual(slide.canvas.width);
        expect(element.y + element.h).toBeLessThanOrEqual(slide.canvas.height);
        expect(intersection(title, element)).toBeUndefined();

        labels.slice(index + 1).forEach((other) => {
          expect(intersection(element, other)).toBeUndefined();
        });

        effectiveBackgroundColors(slide, element).forEach((background) => {
          expect(contrastRatio(element.color, background)).toBeGreaterThanOrEqual(4.5);
        });
      });

      timelineGraphics.filter((element) => element.type === "shape").forEach((graphic) => {
        const color = graphic.shape === "line" ? graphic.stroke || graphic.fill : graphic.fill;
        if (!color) throw new Error(`Expected timeline foreground color for ${graphic.id}`);
        expect(contrastRatio(color, slide.canvas.background)).toBeGreaterThanOrEqual(4.5);
      });
      const titleBottom = title.y + title.h;
      expect(labels.every((element) => element.y >= titleBottom)).toBe(true);
    }
  });
});
