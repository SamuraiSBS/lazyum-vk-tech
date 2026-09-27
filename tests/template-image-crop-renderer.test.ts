import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { designSystemSchema, templateElementSchema } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLZ4QAAAABJRU5ErkJggg==";
const firstCrop = { left: 25, top: 0, right: 15, bottom: 5 };
const secondCrop = { left: -10, top: 5, right: 30, bottom: 0 };

const baseImage = {
  id: "crop-first",
  type: "image" as const,
  name: "Shared image",
  x: 40,
  y: 100,
  w: 120,
  h: 90,
  text: "",
  imageDataUrl: dataUrl,
  zIndex: 1,
};

describe("template image crop rendering", () => {
  it("validates template placement crop with the canvas crop contract", () => {
    expect(templateElementSchema.parse(baseImage)).not.toHaveProperty("crop");
    expect(templateElementSchema.parse({ ...baseImage, crop: firstCrop }).crop).toEqual(firstCrop);
    for (const crop of [
      { left: 101, top: 0, right: 0, bottom: 0 },
      { left: 50, top: 0, right: 50, bottom: 0 },
      { left: 0, top: 0, right: Number.NaN, bottom: 0 },
      { ...firstCrop, extra: 1 },
    ]) {
      expect(templateElementSchema.safeParse({ ...baseImage, crop }).success).toBe(false);
    }
  });

  it("preserves separate crops for the same bytes across deterministic variants", async () => {
    const parsed = await parsePptxTemplate(await createFixtureTemplate("bright"), "crop-renderer.pptx");
    const layout = parsed.layouts[0]!;
    const design = designSystemSchema.parse({
      ...parsed,
      layouts: [{
        ...layout,
        elements: [
          ...layout.elements,
          { ...baseImage, crop: firstCrop },
          { ...baseImage, id: "crop-second", crop: secondCrop },
          { ...baseImage, id: "uncropped", x: 170 },
        ],
      }],
    });
    const plan = await createPresentationPlan(await normalizeContent("Template crop", []), 5);

    for (const variant of ["compact", "balanced", "visual"] as const) {
      const document = renderPresentation(design, plan, variant, [], { variantGeometry: true });
      for (const slide of document.slides) {
        const images = slide.canvas.elements.filter((element) => element.type === "image");
        expect(images.find((image) => image.sourceTemplateElementId === "crop-first")?.crop).toEqual(firstCrop);
        expect(images.find((image) => image.sourceTemplateElementId === "crop-second")?.crop).toEqual(secondCrop);
        expect(images.find((image) => image.sourceTemplateElementId === "uncropped")).not.toHaveProperty("crop");
        expect(images.filter((image) => image.dataUrl === dataUrl)).toHaveLength(3);
      }
    }
  });
});
