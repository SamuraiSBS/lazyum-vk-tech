import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createPresentationPptx } from "../src/lib/pptx-export";
import { renderPresentation, resolveTextFont } from "../src/lib/renderer";
import {
  designSystemSchema,
  presentationPlanSchema,
  type DesignSystem,
  type PresentationDocument,
  type PresentationPlan,
} from "../src/lib/schemas";
import { createFixtureTemplate } from "./fixture-decks";
import { parsePptxTemplate } from "../src/lib/template-parser";

describe("renderer typography", () => {
  it("uses bright template heading/body fonts for normal and fallback text", async () => {
    const bright = await parsePptxTemplate(await createFixtureTemplate("bright"), "bright-fonts.pptx");
    expect(bright.typography.headingFonts).toContain("Aptos Display");
    expect(bright.typography.bodyFonts).toContain("Aptos");

    const design = withEmptyLayout(bright, bright.typography);
    const document = renderPresentation(design, fontPlan());
    const texts = textElements(document);

    expect(texts.find((element) => element.sourceTemplateElementId === "fallback-title")?.fontFamily).toBe("Aptos Display");
    expect(texts.find((element) => element.sourceTemplateElementId === "fallback-body")?.fontFamily).toBe("Aptos");
    expect(texts.filter((element) => element.id.endsWith("-text-0")).every((element) => element.fontFamily === "Aptos Display")).toBe(true);
    expect(texts.filter((element) => element.id.endsWith("-text-1")).every((element) => element.fontFamily === "Aptos")).toBe(true);
    expect(texts.filter((element) => element.id.includes("-card-") && element.id.endsWith("-text")).every((element) => element.fontFamily === "Aptos")).toBe(true);
    expect(texts.filter((element) => element.id.includes("-timeline-label-")).every((element) => element.fontFamily === "Aptos")).toBe(true);
    expect(texts.every((element) => element.fontFamily !== "Arial")).toBe(true);
  });

  it("prefers a font observed on the template slot and keeps role mapping consistent", () => {
    const design = { typography: { headingFonts: ["Heading token"], bodyFonts: ["Body token"] } };
    expect(resolveTextFont("heading", design, "Observed heading")).toBe("Observed heading");
    expect(resolveTextFont("body", design, "Observed body")).toBe("Observed body");
    expect(resolveTextFont("heading", design)).toBe("Heading token");
    expect(resolveTextFont("body", design)).toBe("Body token");
  });

  it("uses the explicit deterministic fallback only when role evidence is absent", () => {
    const design = withEmptyLayout({
      ...minimalDesign(),
    }, {
      headingFonts: ["Heading token"],
      bodyFonts: [],
      fontSizes: [16, 32],
      fontWeights: [400, 700],
    });
    const document = renderPresentation(design, fontPlan());
    const texts = textElements(document);

    expect(texts.find((element) => element.sourceTemplateElementId === "fallback-title")?.fontFamily).toBe("Heading token");
    expect(texts.filter((element) => element.sourceTemplateElementId === "fallback-body").every((element) => element.fontFamily === "Arial")).toBe(true);
    expect(texts.filter((element) => element.id.includes("-card-") && element.id.endsWith("-text")).every((element) => element.fontFamily === "Arial")).toBe(true);
    expect(texts.filter((element) => element.id.includes("-timeline-label-")).every((element) => element.fontFamily === "Arial")).toBe(true);
  });

  it("writes the same heading/body mapping to native PPTX XML", async () => {
    const bright = await parsePptxTemplate(await createFixtureTemplate("bright"), "bright-fonts.pptx");
    const document = renderPresentation(withEmptyLayout(bright, bright.typography), fontPlan());
    const archive = await JSZip.loadAsync(await createPresentationPptx(document));
    const themeXml = await archive.files["ppt/theme/theme1.xml"]?.async("string");
    const slideXml = (await Promise.all(document.slides.map(async (_, index) =>
      archive.files[`ppt/slides/slide${index + 1}.xml`]?.async("string"),
    ))).filter((value): value is string => Boolean(value)).join("\n");

    expect(themeXml).toMatch(/<a:majorFont>[\s\S]*?typeface="Aptos Display"/u);
    expect(themeXml).toMatch(/<a:minorFont>[\s\S]*?typeface="Aptos"/u);
    expect(slideXml).toContain('typeface="Aptos Display"');
    expect(slideXml).toContain('typeface="Aptos"');
    expect(slideXml).not.toContain('typeface="Arial"');
  });
});

function textElements(document: PresentationDocument) {
  return document.slides.flatMap((slide) => slide.canvas.elements.filter((element) => element.type === "text"));
}

function fontPlan(): PresentationPlan {
  return presentationPlanSchema.parse({
    title: "Font fixture",
    planner: "deterministic",
    slides: [
      { id: "title", purpose: "title", title: "Заголовок", content: ["Описание"], visualIntent: "none" },
      { id: "body", purpose: "problem", title: "Основной текст", content: ["Текст тела"], visualIntent: "none" },
      { id: "cards", purpose: "solution", title: "Карточки", content: ["Карточка один", "Карточка два"], visualIntent: "cards" },
      { id: "timeline", purpose: "workflow", title: "Timeline", content: ["Шаг один", "Шаг два", "Шаг три"], visualIntent: "timeline" },
      { id: "summary", purpose: "summary", title: "Итог", content: ["Финальный текст"], visualIntent: "none" },
    ],
  });
}

function withEmptyLayout(design: DesignSystem, typography: DesignSystem["typography"]): DesignSystem {
  const sourceLayout = design.layouts[0];
  if (!sourceLayout) throw new Error("Font test requires a source layout");
  return designSystemSchema.parse({
    ...design,
    typography,
    layouts: [{
      ...sourceLayout,
      id: "font-test-layout",
      name: "Font test layout",
      elements: [],
      textSlots: 0,
      placeholderCount: 0,
      visualSlots: 0,
      cardCount: 0,
      composition: "text",
      recurringElementIds: [],
    }],
  });
}

function minimalDesign(): DesignSystem {
  return designSystemSchema.parse({
    version: 1,
    sourceName: "font-test.pptx",
    slideSize: { width: 1280, height: 720, aspectRatio: 1.778 },
    colors: ["#FFFFFF", "#000000", "#7B3DFF"],
    typography: { headingFonts: [], bodyFonts: [], fontSizes: [16, 32], fontWeights: [400, 700] },
    spacing: { horizontalMargins: [80], verticalMargins: [60], gaps: [16] },
    shapes: { types: ["shape"], radii: [], strokes: ["#7B3DFF"] },
    masters: [],
    layouts: [{
      id: "font-test-layout", name: "Font test layout", source: "layout", sourceFile: "font-test",
      width: 1280, height: 720, elements: [], textSlots: 0, placeholderCount: 0, visualSlots: 0, cardCount: 0,
      composition: "text", recurringElementIds: [],
    }],
    recurringElements: [],
    visualPatterns: [],
    warnings: [],
  });
}
