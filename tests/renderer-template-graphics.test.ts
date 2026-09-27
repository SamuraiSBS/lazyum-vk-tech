import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditPresentation } from "../src/lib/audit";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";
import type { TemplateElement, TemplateLayout } from "../src/lib/schemas";

type Rect = Pick<TemplateElement, "x" | "y" | "w" | "h">;

function intersectionArea(left: Rect, right: Rect) {
  const width = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function containedInCanvas(element: Rect, layout: TemplateLayout) {
  return element.x >= 0
    && element.y >= 0
    && element.w > 0
    && element.h > 0
    && element.x + element.w <= layout.width + 1
    && element.y + element.h <= layout.height + 1;
}

function intersectsCanvas(element: Rect, layout: TemplateLayout) {
  return element.x < layout.width
    && element.y < layout.height
    && element.x + element.w > 0
    && element.y + element.h > 0;
}

function templateArtwork(layout: TemplateLayout) {
  return layout.elements.filter((element) => {
    if (element.type === "image") return Boolean(element.imageDataUrl) && containedInCanvas(element, layout);
    return (element.type === "shape" || element.type === "line")
      && !element.text.trim()
      && intersectsCanvas(element, layout);
  });
}

function significantArtwork(layout: TemplateLayout) {
  const canvasArea = layout.width * layout.height;
  return templateArtwork(layout).filter((element) => {
    const isTextSurface = element.type === "shape" && layout.elements.some((slot) => (
      (slot.type === "text" || slot.type === "placeholder")
      && slot.x >= element.x
      && slot.y >= element.y
      && slot.x + slot.w <= element.x + element.w
      && slot.y + slot.h <= element.y + element.h
    ));
    if (isTextSurface) return false;
    const relativeArea = (element.w * element.h) / canvasArea;
    // Ignore full-slide backgrounds, which intentionally sit under text, and
    // tiny marks that do not form a meaningful text collision on their own.
    return relativeArea >= 0.01 && relativeArea <= 0.82;
  });
}

function materializesArtwork(source: TemplateElement, canvasElements: Array<{
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sourceTemplateElementId?: string;
  dataUrl?: string;
}>) {
  return canvasElements.some((element) => (
    element.sourceTemplateElementId === source.id
    || (source.type === "image"
      && element.type === "image"
      && element.dataUrl === source.imageDataUrl
      && element.x === source.x
      && element.y === source.y
      && element.w === source.w
      && element.h === source.h)
  ));
}

function normalizedText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function compactedText(value: string) {
  return normalizedText(value).replace(/\s+/gu, "");
}

describe("template artwork text clearance", () => {
  it("keeps planned native text clear of significant template artwork across variants", async () => {
    const templatePath = path.resolve(process.cwd(), "fixtures/templates/organizer/VK Tech шаблон.pptx");
    const designSystem = await parsePptxTemplate(await readFile(templatePath), "VK Tech шаблон.pptx");
    const plan = await createPresentationPlan({
      brief: "Детерминированная проверка размещения текста",
      documents: [],
      excerpts: [],
      keywords: [],
      sourceChunks: [],
    }, 10);
    const variants = ["compact", "balanced", "visual"] as const;
    const geometrySignatures: string[] = [];
    const collisions: Array<{
      variant: string;
      slideId: string;
      layoutId: string;
      textId: string;
      textRect: Rect;
      artworkId: string;
      artworkRect: Rect;
      overlapRatio: number;
    }> = [];

    for (const variant of variants) {
      const document = renderPresentation(designSystem, plan, variant, [], { variantGeometry: true });
      const audit = auditPresentation(document);
      geometrySignatures.push(document.slides.map((slide) => slide.canvas.elements
        .filter((element) => element.type === "text")
        .map((element) => `${element.id}:${element.x},${element.y},${element.w},${element.h}`)
        .join("|"))
        .join(";"));

      expect(audit.passed, `${variant} deterministic audit`).toBe(true);

      for (const plannedSlide of plan.slides) {
        const renderedSlide = document.slides.find((slide) => slide.id === plannedSlide.id);
        if (!renderedSlide) throw new Error(`Expected rendered ${plannedSlide.id}`);
        const selectedLayout = designSystem.layouts.find((layout) => layout.id === renderedSlide.templateLayoutId);
        if (!selectedLayout) throw new Error(`Expected selected template layout ${renderedSlide.templateLayoutId}`);

        const generatedText = renderedSlide.canvas.elements.filter((element) => element.type === "text");
        const titleText = generatedText.find((element) => element.id === `${plannedSlide.id}-text-0`);
        const bodyText = generatedText.find((element) => element.id === `${plannedSlide.id}-text-1`);
        if (titleText && bodyText && titleText.x < bodyText.x + bodyText.w
          && titleText.x + titleText.w > bodyText.x) {
          expect(bodyText.y, `${variant} ${plannedSlide.id} body follows title`)
            .toBeGreaterThanOrEqual(titleText.y + titleText.h);
        }
        const allText = compactedText(generatedText.map((element) => element.text).join(" "));
        expect(allText).toContain(compactedText(plannedSlide.title));
        plannedSlide.content.forEach((content) => expect(allText).toContain(compactedText(content)));
        generatedText.forEach((element) => {
          expect(element.x).toBeGreaterThanOrEqual(0);
          expect(element.y).toBeGreaterThanOrEqual(0);
          expect(element.x + element.w).toBeLessThanOrEqual(renderedSlide.canvas.width);
          expect(element.y + element.h).toBeLessThanOrEqual(renderedSlide.canvas.height);
        });

        const sourceArtwork = templateArtwork(selectedLayout);
        const populatedMetricSlots = plannedSlide.visualIntent === "metrics"
          ? generatedText.flatMap((text) => selectedLayout.elements.filter((slot) =>
            slot.id === text.sourceTemplateElementId && text.id !== `${plannedSlide.id}-text-0`))
          : [];
        const unusedMetricRows = populatedMetricSlots.length >= 2
          ? selectedLayout.elements.filter((slot) =>
            (slot.type === "text" || slot.type === "placeholder")
            && !populatedMetricSlots.some((used) => used.id === slot.id)
            && populatedMetricSlots.some((used) => Math.abs(used.x - slot.x) < 1
              && Math.abs(used.w - slot.w) < 1 && Math.abs(used.h - slot.h) < 1))
          : [];
        const isUnusedMetricDecoration = (element: TemplateElement) => unusedMetricRows.some((row) =>
          element.x >= row.x && element.y >= row.y
          && element.x + element.w <= row.x + row.w
          && element.y + element.h <= row.y + row.h);
        sourceArtwork.forEach((element) => {
          expect(materializesArtwork(element, renderedSlide.canvas.elements),
            `${selectedLayout.id} ${variant} artwork ${element.id}`).toBe(!isUnusedMetricDecoration(element));
        });
        const filledEmptyTextSurfaces = selectedLayout.elements.filter((element) =>
          (element.type === "text" || element.type === "placeholder")
          && !element.text.trim() && Boolean(element.fill || element.stroke)
          && intersectsCanvas(element, selectedLayout));
        filledEmptyTextSurfaces.forEach((surface) => {
          expect(renderedSlide.canvas.elements.some((element) =>
            element.type === "shape" && element.sourceTemplateElementId === surface.id
          ), `${selectedLayout.id} retains filled source panel ${surface.id}`).toBe(!isUnusedMetricDecoration(surface));
        });

        significantArtwork(selectedLayout).forEach((artwork) => {
          generatedText.forEach((textElement) => {
            const overlap = intersectionArea(artwork, textElement);
            const relativeOverlap = overlap / Math.min(artwork.w * artwork.h, textElement.w * textElement.h);
            if (relativeOverlap >= 0.05) {
              collisions.push({
                variant,
                slideId: renderedSlide.id,
                layoutId: selectedLayout.id,
                textId: textElement.id,
                textRect: { x: textElement.x, y: textElement.y, w: textElement.w, h: textElement.h },
                artworkId: artwork.id,
                artworkRect: { x: artwork.x, y: artwork.y, w: artwork.w, h: artwork.h },
                overlapRatio: Number(relativeOverlap.toFixed(3)),
              });
            }
          });
        });
      }
    }

    expect(new Set(geometrySignatures).size).toBe(variants.length);
    expect(collisions).toEqual([]);
  });
});
