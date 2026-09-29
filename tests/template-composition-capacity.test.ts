import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";

it("leaves no surplus source item markers around opportunity, timeline and ending content", async () => {
  const name = "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx";
  const design = await parsePptxTemplate(await readFile(new URL(`../fixtures/templates/organizer/${name}`, import.meta.url)), name);
  const content = await normalizeContent(
    "Create a ten-slide, fact-based overview of reliable export layout parity and presentation readability.",
    [],
  );
  const plan = await createPresentationPlan(content, 10);
  const document = renderPresentation(design, plan, "visual", [], { variantGeometry: true });
  const visibleSmallBodyImages = (index: number) => {
    const slide = document.slides[index]!;
    return slide.canvas.elements.filter((element) => element.type === "image"
      && element.y >= slide.canvas.height * 0.12 && element.y + element.h <= slide.canvas.height * 0.82
      && element.w <= slide.canvas.width * 0.08 && element.h <= slide.canvas.height * 0.12);
  };
  const opportunity = document.slides[3]!;
  const cardBodies = opportunity.canvas.elements.filter((element) => element.type === "text" && element.id !== `${opportunity.id}-text-0`);
  const cardMarkers = visibleSmallBodyImages(3);
  expect(cardMarkers).toHaveLength(cardBodies.length);
  expect(cardBodies.length).toBeGreaterThan(0);
  for (const marker of cardMarkers) {
    expect(cardBodies.some((body) => body.x >= marker.x + marker.w
      && body.x - marker.x - marker.w <= opportunity.canvas.width * 0.08
      && body.y < marker.y + marker.h && body.y + body.h > marker.y)).toBe(true);
  }
  for (const index of [5, 7, 9]) expect(visibleSmallBodyImages(index)).toHaveLength(0);
  const ending = document.slides[9]!;
  const body = ending.canvas.elements.find((element) => element.id === `${ending.id}-text-1`);
  expect(body?.type).toBe("text");
  expect(body!.w).toBeGreaterThanOrEqual(ending.canvas.width * 0.4);
}, 30_000);

it("preserves repeated intentional icons when no source item slots accompany them", async () => {
  const name = "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx";
  const design = await parsePptxTemplate(await readFile(new URL(`../fixtures/templates/organizer/${name}`, import.meta.url)), name);
  const content = await normalizeContent("Create a ten-slide overview of export layout readability.", []);
  const plan = await createPresentationPlan(content, 10);
  const original = renderPresentation(design, plan, "visual", [], { variantGeometry: true });
  const layoutId = original.slides[5]!.templateLayoutId;
  expect(original.slides[9]!.templateLayoutId).toBe(layoutId);
  const sourceLayout = design.layouts.find((layout) => layout.id === layoutId)!;
  const smallImages = sourceLayout.elements.filter((element) => element.type === "image"
    && element.imageDataUrl && element.y >= sourceLayout.height * 0.12
    && element.y + element.h <= sourceLayout.height * 0.82
    && element.w <= sourceLayout.width * 0.08 && element.h <= sourceLayout.height * 0.12);
  expect(smallImages.length).toBeGreaterThanOrEqual(6);
  const associatedSlots = sourceLayout.elements.filter((slot) => (slot.type === "text" || slot.type === "placeholder")
    && slot.w * slot.h <= sourceLayout.width * sourceLayout.height * 0.2
    && smallImages.some((image) => image.x >= slot.x && image.y >= slot.y
      && image.x + image.w <= slot.x + slot.w && image.y + image.h <= slot.y + slot.h));
  expect(associatedSlots.length).toBeGreaterThanOrEqual(6);
  const associatedIds = new Set(associatedSlots.map((slot) => slot.id));
  const iconOnlyDesign = {
    ...design,
    layouts: design.layouts.map((layout) => layout.id === layoutId
      ? { ...layout, elements: layout.elements.filter((element) => !associatedIds.has(element.id)) }
      : layout),
  };
  const rendered = renderPresentation(iconOnlyDesign, plan, "visual", [], {
    variantGeometry: true,
    layoutOverrides: new Map([plan.slides[5]!, plan.slides[9]!].map((slide) => [slide.id, layoutId])),
  });
  for (const index of [5, 9]) {
    const visibleIds = new Set(rendered.slides[index]!.canvas.elements
      .filter((element) => element.type === "image")
      .map((element) => element.sourceTemplateElementId));
    expect(smallImages.every((image) => visibleIds.has(image.id))).toBe(true);
  }
}, 30_000);
