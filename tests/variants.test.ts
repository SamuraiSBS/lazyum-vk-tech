import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

describe("presentation variants", () => {
  it("creates one canonical source-grounded plan before variant rendering", async () => {
    const content = await normalizeContent("Стратегия внедрения продукта", [{
      name: "source.txt",
      type: "text/plain",
      buffer: Buffer.from("Команде нужен пилот, измеримые метрики, подготовка данных и план масштабирования."),
    }]);
    const plan = await createPresentationPlan(content, 10);
    const designSystem = await parsePptxTemplate(await createFixtureTemplate("bright"), "variants.pptx");
    const documents = (["compact", "balanced", "visual"] as const).map((variant) => presentationDocumentSchema.parse({
      ...renderPresentation(designSystem, plan, variant),
      variant,
    }));

    expect(documents.map((document) => document.variant)).toEqual(["compact", "balanced", "visual"]);
    expect(documents[0]?.plan).toEqual(plan);
    expect(documents[1]?.plan).toEqual(plan);
    expect(documents[2]?.plan).toEqual(plan);
    expect(documents[0]?.designSystem).toEqual(documents[1]?.designSystem);
    expect(documents[1]?.designSystem).toEqual(documents[2]?.designSystem);

    const geometry = (index: number) => documents[index]!.slides.map((slide) => slide.canvas.elements.map((element) => ({
      id: element.id, x: element.x, y: element.y, w: element.w, h: element.h,
    })));
    expect(geometry(0)).not.toEqual(geometry(2));
  });
});
