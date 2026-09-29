import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { chooseTemplateLayout } from "../src/lib/layout-engine";
import { createFixtureTemplate } from "./fixture-decks";

describe("Layout Engine", () => {
  it("prefers a repeated-card composition for a benefits slide", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate(), "cards.pptx");
    const layout = chooseTemplateLayout(design, {
      id: "slide-1",
      purpose: "advantages",
      title: "Преимущества",
      content: ["Первое", "Второе", "Третье"],
      visualIntent: "cards",
    });
    expect(layout.composition).toBe("cards");
  });

  it("prefers an asset-backed organizer title composition without relying on its label", async () => {
    const templatePath = path.resolve(process.cwd(), "fixtures", "templates", "organizer", "Шаблон презентации VK Education.pptx");
    const design = await parsePptxTemplate(await readFile(templatePath), "Шаблон презентации VK Education.pptx");
    const layout = chooseTemplateLayout(design, {
      id: "slide-1",
      purpose: "title",
      title: "Питч",
      content: ["Короткое описание"],
      visualIntent: "image",
    }, "visual");

    expect(layout.composition).toBe("title");
    expect(layout.visualSlots).toBeGreaterThan(0);
  });

  it("prefers a readable large image composition without treating thin diagonal lines as filled artwork", async () => {
    const templatePath = path.resolve(process.cwd(), "fixtures", "templates", "organizer", "Шаблон презентации VK Education.pptx");
    const design = await parsePptxTemplate(await readFile(templatePath), "image-layouts.pptx");
    const largeImage = design.layouts.find((layout) => layout.id === "slide-34");
    const smallerImage = design.layouts.find((layout) => layout.id === "slide-33");
    const clippedImage = design.layouts.find((layout) => layout.id === "layout-16");
    if (!largeImage || !smallerImage || !clippedImage) throw new Error("Image layout regression requires source compositions");
    const withoutCrops = design.layouts.map((layout) => ({
      ...layout,
      name: "Unlabelled visual composition",
      elements: layout.elements.map((element) => element.type === "image" ? { ...element, crop: undefined } : element),
    }));
    const slide = {
      id: "image-story",
      purpose: "opportunity" as const,
      title: "Программа обучения",
      content: ["Новые возможности для участников"],
      visualIntent: "image" as const,
    };

    for (const variant of ["compact", "balanced", "visual"] as const) {
      const selected = chooseTemplateLayout({ ...design, layouts: withoutCrops }, slide, variant);
      expect(selected.id, variant).toBe(largeImage.id);
      const blocked = withoutCrops.map((layout) => layout.id === largeImage.id
        ? { ...layout, elements: layout.elements.map((element) => element.type === "line"
          ? { ...element, type: "shape" as const } : element) }
        : layout);
      expect(chooseTemplateLayout({ ...design, layouts: blocked }, slide, variant).id, variant).toBe(smallerImage.id);
    }
  });

  it("does not choose an oversized visual layout", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "dense.pptx");
    const sourceElement = design.layouts[0].elements[0];
    const oversized = {
      ...design.layouts[0],
      id: "oversized-visual-layout",
      name: "visual mosaic",
      composition: "visual" as const,
      visualSlots: 220,
      elements: Array.from({ length: 220 }, (_, index) => ({
        ...sourceElement,
        id: "dense-image-" + index,
        type: "image" as const,
        imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      })),
    };
    const augmentedDesign = { ...design, layouts: [...design.layouts, oversized] };
    const layout = chooseTemplateLayout(augmentedDesign, {
      id: "slide-2",
      purpose: "problem",
      title: "Визуальный слайд",
      content: ["Пояснение"],
      visualIntent: "image",
    }, "visual");

    expect(layout.id).not.toBe("oversized-visual-layout");
  });

  it("does not let visual slot count outweigh composition and readable text area", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "visual-readability.pptx");
    const sourceLayout = design.layouts[0];
    if (!sourceLayout) throw new Error("Visual readability test requires a source layout");
    const slotHeavy = {
      ...sourceLayout,
      id: "slot-heavy-visual",
      name: "slot-heavy candidate",
      composition: "visual" as const,
      textSlots: 1,
      visualSlots: 12,
      cardCount: 8,
      elements: [
        {
          id: "tiny-body",
          type: "text" as const,
          name: "tiny body",
          x: sourceLayout.width * 0.04,
          y: sourceLayout.height * 0.08,
          w: sourceLayout.width * 0.08,
          h: sourceLayout.height * 0.04,
          text: "",
          zIndex: 0,
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `visual-${index}`,
          type: "image" as const,
          name: `visual ${index}`,
          x: sourceLayout.width * 0.2,
          y: sourceLayout.height * 0.1,
          w: sourceLayout.width * 0.12,
          h: sourceLayout.height * 0.12,
          text: "",
          zIndex: index + 1,
        })),
      ],
    };
    const readable = {
      ...sourceLayout,
      id: "readable-split",
      name: "readable candidate",
      composition: "split" as const,
      textSlots: 2,
      visualSlots: 1,
      cardCount: 0,
      elements: [
        {
          id: "readable-title",
          type: "text" as const,
          name: "title",
          x: sourceLayout.width * 0.08,
          y: sourceLayout.height * 0.08,
          w: sourceLayout.width * 0.84,
          h: sourceLayout.height * 0.12,
          text: "",
          zIndex: 0,
        },
        {
          id: "readable-body",
          type: "text" as const,
          name: "body",
          x: sourceLayout.width * 0.08,
          y: sourceLayout.height * 0.24,
          w: sourceLayout.width * 0.5,
          h: sourceLayout.height * 0.58,
          text: "",
          zIndex: 1,
        },
        {
          id: "readable-visual",
          type: "image" as const,
          name: "visual",
          x: sourceLayout.width * 0.64,
          y: sourceLayout.height * 0.24,
          w: sourceLayout.width * 0.28,
          h: sourceLayout.height * 0.58,
          text: "",
          zIndex: 2,
        },
      ],
    };
    const layout = chooseTemplateLayout({ ...design, layouts: [slotHeavy, readable] }, {
      id: "slide-2",
      purpose: "context",
      title: "Контекст",
      content: ["Главный тезис", "Пояснение"],
      visualIntent: "none",
    }, "visual");

    expect(layout.id).toBe("readable-split");
  });

  it("uses content demand for Visual without changing Compact or Balanced layout scoring", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "content-demand.pptx");
    const sourceLayout = design.layouts[0];
    if (!sourceLayout) throw new Error("Content-demand test requires a source layout");
    const candidate = (
      id: string,
      name: string,
      bodyWidth: number,
      visualCount: number,
      declaredTextSlots: number,
      declaredVisualSlots: number,
    ) => ({
      ...sourceLayout,
      id,
      name,
      composition: "visual" as const,
      textSlots: declaredTextSlots,
      visualSlots: declaredVisualSlots,
      cardCount: 0,
      elements: [
        {
          id: `${id}-title`,
          type: "text" as const,
          name: "heading",
          x: sourceLayout.width * 0.08,
          y: sourceLayout.height * 0.08,
          w: sourceLayout.width * 0.54,
          h: sourceLayout.height * 0.14,
          text: "",
          zIndex: 0,
        },
        {
          id: `${id}-body`,
          type: "text" as const,
          name: "body",
          x: sourceLayout.width * 0.08,
          y: sourceLayout.height * 0.32,
          w: sourceLayout.width * bodyWidth,
          h: sourceLayout.height * 0.55,
          text: "",
          zIndex: 1,
        },
        ...Array.from({ length: visualCount }, (_, index) => ({
          id: `${id}-visual-${index}`,
          type: "image" as const,
          name: "visual",
          x: sourceLayout.width * 0.7,
          y: sourceLayout.height * (0.24 + index * 0.12),
          w: sourceLayout.width * 0.24,
          h: sourceLayout.height * 0.1,
          text: "",
          zIndex: index + 2,
        })),
      ],
    });
    const visuallyRich = candidate("unknown-rich", "Unclassified A", 0.26, 6, 80, 0);
    const textRoomy = candidate("unknown-roomy", "Unclassified B", 0.54, 1, 0, 99);
    const shortSlide = {
      id: "slide-short",
      purpose: "context" as const,
      title: "Use case",
      content: ["A short takeaway."],
      visualIntent: "image" as const,
    };
    const longSlide = {
      ...shortSlide,
      id: "slide-long",
      content: ["A detailed explanation with evidence and context. ".repeat(24)],
    };
    const candidates = { ...design, layouts: [textRoomy, visuallyRich] };
    const shortSelection = chooseTemplateLayout(candidates, shortSlide, "visual");
    const longSelection = chooseTemplateLayout({ ...design, layouts: [visuallyRich, textRoomy] }, longSlide, "visual");
    const compactSelection = chooseTemplateLayout(candidates, shortSlide, "compact");
    const balancedSelection = chooseTemplateLayout(candidates, shortSlide, "balanced");

    expect(shortSelection.elements.find((element) => element.name === "body")?.w).toBeCloseTo(sourceLayout.width * 0.26);
    expect(longSelection.elements.find((element) => element.name === "body")?.w).toBeCloseTo(sourceLayout.width * 0.54);
    expect(compactSelection.id).toBe("unknown-roomy");
    expect(balancedSelection.id).toBe("unknown-rich");

    const renamedLongSelection = chooseTemplateLayout({
      ...design,
      layouts: [
        { ...textRoomy, id: "template-17", name: "Other unknown template" },
        { ...visuallyRich, id: "template-02", name: "Unnamed" },
      ],
    }, longSlide, "visual");
    expect(renamedLongSelection.elements.find((element) => element.name === "body")?.w)
      .toBeCloseTo(sourceLayout.width * 0.54);
  });

  it("breaks equal Visual geometry ties deterministically regardless of input order", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "stable-layout-tie.pptx");
    const sourceLayout = design.layouts[0];
    if (!sourceLayout) throw new Error("Stable-tie test requires a source layout");
    const alpha = { ...sourceLayout, id: "candidate-a", name: "Unknown layout one", composition: "visual" as const };
    const zeta = { ...sourceLayout, id: "candidate-z", name: "Unknown layout two", composition: "visual" as const };
    const slide = {
      id: "slide-tie",
      purpose: "context" as const,
      title: "Summary",
      content: ["One point"],
      visualIntent: "image" as const,
    };
    const forward = chooseTemplateLayout({ ...design, layouts: [zeta, alpha] }, slide, "visual");
    const reversed = chooseTemplateLayout({ ...design, layouts: [alpha, zeta] }, slide, "visual");

    expect(forward.id).toBe("candidate-a");
    expect(reversed.id).toBe("candidate-a");
  });

  it("does not treat off-canvas text from the parsed VK Tech template as real Visual capacity", async () => {
    const templatePath = path.resolve(process.cwd(), "fixtures", "templates", "organizer", "VK Tech шаблон.pptx");
    const design = await parsePptxTemplate(await readFile(templatePath), "VK Tech шаблон.pptx");
    const mostDeclaredTextSlots = [...design.layouts].sort((left, right) => right.textSlots - left.textSlots)[0];
    if (!mostDeclaredTextSlots) throw new Error("VK Tech capacity regression requires parsed layouts");

    const usableTextElements = mostDeclaredTextSlots.elements.filter((element) => (
      (element.type === "text" || element.type === "placeholder")
      && element.x >= 0
      && element.y >= 0
      && element.w > 0
      && element.h > 0
      && element.x + element.w <= mostDeclaredTextSlots.width + 1
      && element.y + element.h <= mostDeclaredTextSlots.height + 1
      && element.w >= mostDeclaredTextSlots.width * 0.12
      && element.h >= mostDeclaredTextSlots.height * 0.05
    ));
    const offCanvasTextElements = mostDeclaredTextSlots.elements.filter((element) => (
      (element.type === "text" || element.type === "placeholder")
      && (
        element.x < 0
        || element.y < 0
        || element.x + element.w > mostDeclaredTextSlots.width + 1
        || element.y + element.h > mostDeclaredTextSlots.height + 1
      )
    ));

    // The old parser count describes every extracted text shape; the parsed
    // organizer layout contains many shapes outside the 960×540 slide canvas.
    expect(mostDeclaredTextSlots.textSlots).toBeGreaterThanOrEqual(50);
    expect(offCanvasTextElements.length).toBeGreaterThan(0);
    expect(mostDeclaredTextSlots.textSlots).toBeGreaterThan(usableTextElements.length * 5);

    const selected = chooseTemplateLayout(design, {
      id: "slide-context",
      purpose: "context",
      title: "Контекст проекта",
      content: ["Рынок и аудитория", "Проблема пользователей", "Требуемое решение"],
      visualIntent: "none",
    }, "visual");

    expect(selected).not.toBe(mostDeclaredTextSlots);
    expect(usableTextArea(selected)).toBeGreaterThan(0);
  });

  it("counts text capacity only for readable boxes contained by the canvas, including its exact edges", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "capacity-boundaries.pptx");
    const sourceLayout = design.layouts[0];
    if (!sourceLayout) throw new Error("Capacity boundary test requires a source layout");
    const text = (id: string, x: number, y: number, w: number, h: number) => ({
      id,
      type: "text" as const,
      name: id,
      x,
      y,
      w,
      h,
      text: "",
      zIndex: 0,
    });
    const edgeReadable = {
      ...sourceLayout,
      id: "edge-readable",
      composition: "split" as const,
      textSlots: 0,
      visualSlots: 0,
      cardCount: 0,
      elements: [text(
        "touches-right-and-bottom-edges",
        sourceLayout.width * 0.88,
        sourceLayout.height * 0.95,
        sourceLayout.width * 0.12,
        sourceLayout.height * 0.05,
      )],
    };
    const clippedAndUnsuitable = {
      ...sourceLayout,
      id: "clipped-and-unsuitable",
      composition: "split" as const,
      textSlots: 99,
      visualSlots: 0,
      cardCount: 0,
      elements: [
        ...Array.from({ length: 6 }, (_, index) => text(
          `off-canvas-${index}`,
          sourceLayout.width * 1.25,
          sourceLayout.height * 0.2,
          sourceLayout.width * 0.6,
          sourceLayout.height * 0.6,
        )),
        text("left-of-canvas", -2, sourceLayout.height * 0.2, sourceLayout.width * 0.6, sourceLayout.height * 0.6),
        text("right-clipped", sourceLayout.width * 0.8, sourceLayout.height * 0.2, sourceLayout.width * 0.22, sourceLayout.height * 0.6),
        text("bottom-clipped", sourceLayout.width * 0.2, sourceLayout.height * 0.8, sourceLayout.width * 0.6, sourceLayout.height * 0.22),
        text("too-narrow", 0, 0, sourceLayout.width * 0.119, sourceLayout.height * 0.05),
        text("too-short", 0, 0, sourceLayout.width * 0.12, sourceLayout.height * 0.049),
      ],
    };
    const selected = chooseTemplateLayout({
      ...design,
      layouts: [clippedAndUnsuitable, edgeReadable],
    }, {
      id: "slide-context",
      purpose: "context",
      title: "Контекст",
      content: ["Ключевой тезис", "Пояснение"],
      visualIntent: "none",
    }, "visual");

    expect(selected.id).toBe("edge-readable");
  });

  it.each(["cards", "metrics"] as const)(
    "requires readable text area for a Visual %s slide",
    async (visualIntent) => {
      const design = await parsePptxTemplate(await createFixtureTemplate("photo"), `${visualIntent}-readability.pptx`);
      const sourceLayout = design.layouts[0];
      if (!sourceLayout) throw new Error("Card readability test requires a source layout");
      const slotHeavyCards = {
        ...sourceLayout,
        id: `slot-heavy-${visualIntent}`,
        name: "slot-heavy cards",
        composition: "cards" as const,
        textSlots: 1,
        visualSlots: 12,
        cardCount: 8,
        elements: [
          {
            id: "tiny-card-text",
            type: "text" as const,
            name: "tiny card text",
            x: sourceLayout.width * 0.04,
            y: sourceLayout.height * 0.04,
            w: sourceLayout.width * 0.08,
            h: sourceLayout.height * 0.04,
            text: "",
            zIndex: 0,
          },
          ...Array.from({ length: 12 }, (_, index) => ({
            id: `card-visual-${index}`,
            type: "image" as const,
            name: `card visual ${index}`,
            x: sourceLayout.width * 0.16,
            y: sourceLayout.height * 0.08,
            w: sourceLayout.width * 0.1,
            h: sourceLayout.height * 0.1,
            text: "",
            zIndex: index + 1,
          })),
        ],
      };
      const readableCards = {
        ...sourceLayout,
        id: `readable-${visualIntent}`,
        name: "readable cards",
        composition: "cards" as const,
        textSlots: 4,
        visualSlots: 1,
        cardCount: 3,
        elements: [
          {
            id: "cards-title",
            type: "text" as const,
            name: "title",
            x: sourceLayout.width * 0.08,
            y: sourceLayout.height * 0.08,
            w: sourceLayout.width * 0.84,
            h: sourceLayout.height * 0.12,
            text: "",
            zIndex: 0,
          },
          ...Array.from({ length: 3 }, (_, index) => ({
            id: `readable-card-${index}`,
            type: "text" as const,
            name: `card ${index}`,
            x: sourceLayout.width * (0.08 + index * 0.29),
            y: sourceLayout.height * 0.28,
            w: sourceLayout.width * 0.25,
            h: sourceLayout.height * 0.46,
            text: "",
            zIndex: index + 1,
          })),
        ],
      };
      const layout = chooseTemplateLayout({ ...design, layouts: [slotHeavyCards, readableCards] }, {
        id: "slide-cards",
        purpose: "advantages",
        title: "Преимущества",
        content: ["Первое", "Второе", "Третье"],
        visualIntent,
      }, "visual");

      expect(layout.id).toBe(`readable-${visualIntent}`);
    },
  );

  it("keeps a readable card composition ahead of a readable non-card layout", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "card-composition.pptx");
    const sourceLayout = design.layouts[0];
    if (!sourceLayout) throw new Error("Card composition test requires a source layout");
    const readableElements = [
      {
        id: "layout-title",
        type: "text" as const,
        name: "title",
        x: sourceLayout.width * 0.08,
        y: sourceLayout.height * 0.08,
        w: sourceLayout.width * 0.84,
        h: sourceLayout.height * 0.12,
        text: "",
        zIndex: 0,
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `layout-body-${index}`,
        type: "text" as const,
        name: `body ${index}`,
        x: sourceLayout.width * (0.08 + index * 0.29),
        y: sourceLayout.height * 0.28,
        w: sourceLayout.width * 0.25,
        h: sourceLayout.height * 0.46,
        text: "",
        zIndex: index + 1,
      })),
    ];
    const readableCards = {
      ...sourceLayout,
      id: "readable-cards",
      name: "readable cards",
      composition: "cards" as const,
      textSlots: 4,
      visualSlots: 1,
      cardCount: 3,
      elements: readableElements,
    };
    const readableSplit = {
      ...sourceLayout,
      id: "readable-split-alternative",
      name: "readable split",
      composition: "split" as const,
      textSlots: 4,
      visualSlots: 1,
      cardCount: 0,
      elements: readableElements.map((element) => ({ ...element, id: `split-${element.id}` })),
    };
    const layout = chooseTemplateLayout({ ...design, layouts: [readableSplit, readableCards] }, {
      id: "slide-cards",
      purpose: "advantages",
      title: "Преимущества",
      content: ["Первое", "Второе", "Третье"],
      visualIntent: "cards",
    }, "visual");

    expect(layout.id).toBe("readable-cards");
  });

  it("prefers text slots that keep the body below the title", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "title-order.pptx");
    const sourceLayout = design.layouts[0];
    if (!sourceLayout) throw new Error("Title-order test requires a source layout");
    const layout = (id: string, bodyY: number) => ({
      ...sourceLayout,
      id,
      name: id,
      composition: "text" as const,
      textSlots: 2,
      placeholderCount: 0,
      visualSlots: 0,
      cardCount: 0,
      elements: [
        {
          id: `${id}-title`,
          type: "text" as const,
          name: "title",
          x: sourceLayout.width * 0.08,
          y: sourceLayout.height * 0.28,
          w: sourceLayout.width * 0.72,
          h: sourceLayout.height * 0.16,
          text: "",
          fontSize: 44,
          zIndex: 0,
        },
        {
          id: `${id}-body`,
          type: "text" as const,
          name: "body",
          x: sourceLayout.width * 0.08,
          y: bodyY,
          w: sourceLayout.width * 0.72,
          h: sourceLayout.height * 0.34,
          text: "",
          fontSize: 22,
          zIndex: 1,
        },
      ],
    });
    const selected = chooseTemplateLayout({
      ...design,
      layouts: [
        layout("body-before-title", sourceLayout.height * 0.06),
        layout("title-before-body", sourceLayout.height * 0.5),
      ],
    }, {
      id: "slide-order",
      purpose: "summary",
      title: "Короткий заголовок",
      content: ["Пояснение по теме"],
      visualIntent: "none",
    });

    expect(selected.id).toBe("title-before-body");
  });
});

function usableTextArea(layout: Awaited<ReturnType<typeof parsePptxTemplate>>["layouts"][number]) {
  const canvasArea = layout.width * layout.height;
  return layout.elements
    .filter((element) => (
      (element.type === "text" || element.type === "placeholder")
      && element.x >= 0
      && element.y >= 0
      && element.w > 0
      && element.h > 0
      && element.x + element.w <= layout.width + 1
      && element.y + element.h <= layout.height + 1
      && element.w >= layout.width * 0.12
      && element.h >= layout.height * 0.05
    ))
    .reduce((total, element) => total + element.w * element.h, 0) / canvasArea;
}
