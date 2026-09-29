import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { chooseTemplateLayout } from "../src/lib/layout-engine";
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

    const sourceLayout = designSystem.layouts[0];
    if (!sourceLayout) throw new Error("Variant test requires a source layout");
    const visualAnchor = {
      id: "visual-profile-anchor",
      type: "image" as const,
      name: "Visual profile anchor",
      x: sourceLayout.width * 0.72,
      y: sourceLayout.height * 0.58,
      w: sourceLayout.width * 0.18,
      h: sourceLayout.height * 0.18,
      text: "",
      imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      zIndex: sourceLayout.elements.length,
    };
    const profileDesign = {
      ...designSystem,
      layouts: [
        { ...sourceLayout, id: "compact-profile", composition: "split" as const, visualSlots: 0, cardCount: 0 },
        {
          ...sourceLayout,
          id: "visual-profile",
          // Keep composition constant so this assertion measures the visual
          // variant's profile preference, rather than the stronger semantic
          // composition score for ordinary text slides.
          composition: "split" as const,
          elements: [...sourceLayout.elements, visualAnchor],
          visualSlots: 1,
          cardCount: 0,
        },
      ],
    };
    const profileSlide = { id: "profile", purpose: "context" as const, title: "Профиль", content: ["Короткий текст"], visualIntent: "none" as const };
    expect(chooseTemplateLayout(profileDesign, profileSlide, "compact").id).toBe("compact-profile");
    expect(chooseTemplateLayout(profileDesign, profileSlide, "visual").id).toBe("visual-profile");
  });
});
