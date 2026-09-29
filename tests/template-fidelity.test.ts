import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { chooseTemplateLayout } from "../src/lib/layout-engine";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { auditPresentation } from "../src/lib/audit";
import { createPresentationPptx } from "../src/lib/pptx-export";
import type { DesignSystem, PresentationPlan, TemplateElement, TemplateLayout } from "../src/lib/schemas";
import { createFixtureTemplate, type FixtureTheme } from "./fixture-decks";

const FIXTURE_PALETTES: Record<FixtureTheme, string[]> = {
  bright: ["#F7F1FF", "#FFFFFF", "#7B3DFF", "#251142"],
  dark: ["#17202A", "#263545", "#37BFA7", "#F7F9FA"],
  photo: ["#EEF7FA", "#FFFFFF", "#0077B6", "#251142"],
  portrait: ["#EAF2FF", "#FFFFFF", "#4D6CFA", "#17202A"],
};

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLZ4QAAAABJRU5ErkJggg==";

it("uses proportionate source compositions for sparse organizer Visual slides", async () => {
  for (const [name, index] of [
    ["VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx", 1],
    ["Шаблон презентации VK Education.pptx", 5],
  ] as const) {
    const design = await parsePptxTemplate(await readFile(new URL(`../fixtures/templates/organizer/${name}`, import.meta.url)), name);
    const plan = await createPresentationPlan(await normalizeContent("Create a ten-slide, fact-based overview of reliable export layout parity and presentation readability.", []), 10);
    const document = renderPresentation(design, plan, "visual", [], { variantGeometry: true });
    const repeated = renderPresentation(design, plan, "visual", [], { variantGeometry: true });
    const renderSignature = (renderedDocument: typeof document) => JSON.stringify(renderedDocument.slides.map((slide) => ({
      layout: slide.templateLayoutId,
      elements: slide.canvas.elements.map((element) => ({
        id: element.id,
        type: element.type,
        source: element.sourceTemplateElementId,
        x: element.x,
        y: element.y,
        w: element.w,
        h: element.h,
        text: element.type === "text" ? element.text : undefined,
      })),
    })));
    expect(renderSignature(repeated)).toBe(renderSignature(document));
    const rendered = document.slides[index]!;
    const source = design.layouts.find((layout) => layout.id === rendered.templateLayoutId)!;
    const text = rendered.canvas.elements.filter((element) => element.type === "text");
    const body = text.filter((element) => element.id !== `${rendered.id}-text-0`);
    expect(auditPresentation(document).passed).toBe(true);
    expect(normalize(text.map((element) => element.text).join(" "))).toContain(normalize(plan.slides[index]!.title));
    plan.slides[index]!.content.forEach((item) => expect(normalize(text.map((element) => element.text).join(" "))).toContain(normalize(item)));
    if (index === 1) {
      expect(source.id).toBe("slide-6");
      expect(body).toHaveLength(2);
      const sourceBodySlots = body.map((element) => source.elements.find((slot) => (
        slot.id === element.sourceTemplateElementId
        && (slot.type === "text" || slot.type === "placeholder")
      )));
      expect(sourceBodySlots.every(Boolean)).toBe(true);
      expect(new Set(sourceBodySlots.map((slot) => slot?.id)).size).toBe(body.length);
      expect(body.every((element, bodyIndex) => (
        element.sourceTemplateElementId === sourceBodySlots[bodyIndex]?.id
        && element.x >= 0 && element.y >= 0
        && element.x + element.w <= rendered.canvas.width
        && element.y + element.h <= rendered.canvas.height
      ))).toBe(true);
    } else {
      expect(source.id).toBe("slide-23");
      expect(source.composition).toBe("timeline");
      expect(body).toHaveLength(3);
      expect(body.every((element) => element.id.includes("timeline-label"))).toBe(true);
      expect(Math.max(...body.map((element) => element.x)) - Math.min(...body.map((element) => element.x)))
        .toBeGreaterThan(rendered.canvas.width * 0.4);
    }
    const published = await JSZip.loadAsync(await createPresentationPptx(document));
    const slideXml = await published.file(`ppt/slides/slide${index + 1}.xml`)?.async("string");
    expect(slideXml).toBeDefined();
    const exportedText = normalize(Array.from(slideXml!.matchAll(/<a:t>(.*?)<\/a:t>/gu), (match) => match[1]).join(" "));
    for (const item of plan.slides[index]!.content) expect(exportedText.includes(normalize(item))).toBe(true);
  }
}, 120000);

describe("role-aware template fidelity", () => {
  it.each(["bright", "dark", "photo", "portrait"] as const)(
    "selects and transfers arbitrary compositions for the %s fixture",
    async (theme) => {
      const source = await parsePptxTemplate(await createFixtureTemplate(theme), `renamed-${theme}.pptx`);
      const design = withAnonymousTemplateLayouts(source, theme);
      const plan = narrativePlan();
      const document = renderPresentation(design, plan, "balanced");

      expect(document.slides.map((slide) => (
        design.layouts.find((layout) => layout.id === slide.templateLayoutId)?.composition
      ))).toEqual(["title", "split", "cards", "timeline", "visual", "text"]);

      for (const [index, rendered] of document.slides.entries()) {
        const sourceLayout = design.layouts.find((layout) => layout.id === rendered.templateLayoutId);
        if (!sourceLayout) throw new Error(`Missing source layout for ${rendered.id}`);
        expect(rendered.order).toBe(index + 1);
        expect(rendered.canvas.background).toBe(sourceLayout.background);

        const renderedText = rendered.canvas.elements.filter((element) => element.type === "text");
        const allText = normalize(renderedText.map((element) => element.text).join(" "));
        const planned = plan.slides[index];
        if (!planned) throw new Error(`Missing planned slide at index ${index}`);
        expect(allText).toContain(normalize(planned.title));
        planned.content.forEach((content) => expect(allText).toContain(normalize(content)));
        expect(allText).not.toMatch(/пример (?:заголовка|содержания)/iu);

        for (const artwork of sourceLayout.elements.filter((element) => (
          element.type === "shape" || element.type === "line" || element.type === "image"
        ))) {
          expect(rendered.canvas.elements.some((element) => (
            element.sourceTemplateElementId === artwork.id
            || (artwork.type === "image" && element.type === "image" && element.dataUrl === artwork.imageDataUrl)
          )), `${sourceLayout.id} keeps template artwork ${artwork.id}`).toBe(true);
        }

        const sourceTitleSlot = sourceLayout.elements
          .filter((element) => element.type === "text" || element.type === "placeholder")
          .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0))[0];
        const renderedTitle = renderedText.find((element) => element.sourceTemplateElementId === sourceTitleSlot?.id);
        expect(renderedTitle).toBeDefined();
        expect(renderedTitle?.fontFamily).toBe(sourceTitleSlot?.fontFamily);
        expect(renderedTitle?.fontSize).toBe(sourceTitleSlot?.fontSize);
        expect(renderedTitle?.fontWeight).toBe(sourceTitleSlot?.fontWeight);

        renderedText.forEach((element) => {
          const sourceSlot = sourceLayout.elements.find((candidate) => candidate.id === element.sourceTemplateElementId);
          const backingShape = sourceSlot && sourceLayout.elements
            .filter((candidate) => candidate.type === "shape" && contains(candidate, sourceSlot))
            .sort((left, right) => left.w * left.h - right.w * right.h)[0];
          expect(contrastRatio(element.color, backingShape?.fill || sourceLayout.background || "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
        });
      }

      expect(new Set(document.slides.map((slide) => slide.canvas.background)).size).toBeGreaterThan(1);
      expect(document.slides[0]?.canvas.elements.find((element) => element.type === "text")?.align).toBe("left");
      expect(document.slides.at(-1)?.canvas.elements.find((element) => element.type === "text")?.align).toBe("center");

      const roleSelections = plan.slides.map((slide, index) => chooseTemplateLayout(
        design,
        slide,
        "balanced",
        undefined,
        { slideIndex: index, slideCount: plan.slides.length },
      ).id);
      const reversedDesign = { ...design, layouts: [...design.layouts].reverse() };
      const reversedSelections = plan.slides.map((slide, index) => chooseTemplateLayout(
        reversedDesign,
        slide,
        "balanced",
        undefined,
        { slideIndex: index, slideCount: plan.slides.length },
      ).id);
      expect(reversedSelections).toEqual(roleSelections);
      expect(roleSelections[0]).not.toBe("slide-1");
      expect(roleSelections.at(-1)).toBe("layout-ending");
    },
  );

  it("recovers generic narrative roles when parser metadata labels every page as a timeline", async () => {
    const source = await parsePptxTemplate(await createFixtureTemplate("dark"), "renamed-source.pptx");
    const base = withAnonymousTemplateLayouts(source, "dark");
    const templateNames = [
      "Two-column content",
      "Feature cards",
      "Opening title page",
      "Milestone timeline",
      "Diagram page",
      "Final summary",
    ];
    const collapsed = {
      ...base,
      layouts: base.layouts.map((layout, index) => ({
        ...layout,
        name: templateNames[index] || "Untitled content",
        composition: "timeline" as const,
        cardCount: 0,
      })),
    };

    const selections = narrativePlan().slides.map((slide, index, slides) => chooseTemplateLayout(
      collapsed,
      slide,
      "balanced",
      undefined,
      { slideIndex: index, slideCount: slides.length },
    ));

    expect(selections.map((layout) => layout.name)).toEqual([
      "Opening title page",
      "Two-column content",
      "Feature cards",
      "Milestone timeline",
      "Diagram page",
      "Final summary",
    ]);
    expect(selections.map((layout) => layout.composition)).toEqual([
      "title", "visual", "cards", "timeline", "visual", "text",
    ]);
  });

  it("infers a reusable card grid from repeated text-slot geometry without card metadata", async () => {
    const source = await parsePptxTemplate(await createFixtureTemplate("photo"), "renamed-card-fixture.pptx");
    const base = withAnonymousTemplateLayouts(source, "photo");
    const cardLayout = base.layouts.find((layout) => layout.id === "layout-cards");
    if (!cardLayout) throw new Error("Fixture card layout is missing");
    const unlabelledCards = {
      ...cardLayout,
      name: "Unlabelled composition",
      composition: "split" as const,
      cardCount: 0,
      elements: cardLayout.elements.filter((element) => !/^card-\d+$/u.test(element.id)),
    };
    const design = { ...base, layouts: base.layouts.map((layout) => (
      layout.id === cardLayout.id ? unlabelledCards : layout
    )) };
    const plan = narrativePlan();
    const selection = chooseTemplateLayout(
      design,
      plan.slides[2]!,
      "balanced",
      undefined,
      { slideIndex: 2, slideCount: plan.slides.length },
    );
    const rendered = renderPresentation(design, plan, "balanced").slides[2];

    expect(selection.id).toBe(unlabelledCards.id);
    expect(selection.composition).toBe("cards");
    expect(selection.cardCount).toBe(3);
    expect(rendered?.templateLayoutId).toBe(unlabelledCards.id);
    expect(rendered?.canvas.elements.filter((element) => (
      element.type === "text" && element.sourceTemplateElementId?.startsWith("card-text-")
    ))).toHaveLength(3);
    expect(rendered?.canvas.elements.some((element) => element.id.endsWith("-contrast-panel"))).toBe(false);
  });

  it("keeps Compact card text inside independent VK Education source anchors", async () => {
    const templateName = "Шаблон презентации VK Education.pptx";
    const templatePath = new URL(`../fixtures/templates/organizer/${templateName}`, import.meta.url);
    const design = await parsePptxTemplate(await readFile(templatePath), templateName);
    const content = await normalizeContent(
      "Create a ten-slide, fact-based overview of reliable export layout parity and presentation readability.",
      [],
    );
    const plan = await createPresentationPlan(content, 10);
    const document = renderPresentation(design, plan, "compact");
    const rendered = document.slides[6];
    if (!rendered) throw new Error("The organizer regression plan is missing slide 7");

    const textBoxes = rendered.canvas.elements.filter((element) => element.type === "text");
    const overlaps = textBoxes.flatMap((left, index) => textBoxes.slice(index + 1)
      .filter((right) => left.x < right.x + right.w && left.x + left.w > right.x
        && left.y < right.y + right.h && left.y + left.h > right.y)
      .map((right) => [left.id, right.id]));
    expect(overlaps).toEqual([]);
    expect(auditPresentation(document).passed).toBe(true);

    const slideText = normalize(textBoxes.map((element) => element.text).join(" "));
    plan.slides[6]!.content.forEach((item) => expect(slideText).toContain(normalize(item)));
  });

  it("keeps Visual VK Tech metrics clear of the template's icon column", async () => {
    const templateName = "VK Tech шаблон.pptx";
    const templatePath = new URL(`../fixtures/templates/organizer/${templateName}`, import.meta.url);
    const design = await parsePptxTemplate(await readFile(templatePath), templateName);
    const content = await normalizeContent(
      "Create a ten-slide, fact-based overview of reliable export layout parity and presentation readability.",
      [],
    );
    const plan = await createPresentationPlan(content, 10);
    const document = renderPresentation(design, plan, "visual", [], { variantGeometry: true });
    const rendered = document.slides[8];
    if (!rendered) throw new Error("The organizer regression plan is missing slide 9");
    const sourceLayout = design.layouts.find((layout) => layout.id === rendered.templateLayoutId);
    if (!sourceLayout) throw new Error("The selected VK Tech metrics layout is missing");

    const iconArtwork = sourceLayout.elements.filter((element) => element.y >= sourceLayout.height * 0.2
      && element.w <= sourceLayout.width * 0.08
      && element.h <= sourceLayout.height * 0.1
      && (element.type === "image"
        || ((element.type === "text" || element.type === "placeholder")
          && !element.text.trim() && Boolean(element.fill || element.stroke))));
    const bodyText = rendered.canvas.elements.filter((element) => element.type === "text")
      .filter((element) => element.id !== "slide-9-text-0");
    expect(iconArtwork.length).toBeGreaterThanOrEqual(3);
    expect(bodyText).toHaveLength(3);
    const populatedSlots = bodyText.map((text) => sourceLayout.elements.find((slot) => slot.id === text.sourceTemplateElementId)!);
    const unusedPeerRows = sourceLayout.elements.filter((slot) =>
      (slot.type === "text" || slot.type === "placeholder")
      && !populatedSlots.some((used) => used.id === slot.id)
      && populatedSlots.some((used) => Math.abs(used.x - slot.x) < 1
        && Math.abs(used.w - slot.w) < 1 && Math.abs(used.h - slot.h) < 1),
    );
    expect(unusedPeerRows).toHaveLength(1);
    const unusedRow = unusedPeerRows[0]!;
    const unusedDecorationIds = sourceLayout.elements
      .filter((element) => (element.type === "image" || element.type === "shape"
        || (element.type === "text" && Boolean(element.fill || element.stroke)))
        && contains(unusedRow, element))
      .map((element) => element.id);
    expect(unusedDecorationIds.length).toBeGreaterThanOrEqual(3);
    expect(rendered.canvas.elements.filter((element) =>
      element.sourceTemplateElementId && unusedDecorationIds.includes(element.sourceTemplateElementId),
    )).toEqual([]);
    for (const text of bodyText) {
      for (const icon of iconArtwork) {
        expect(intersects(text, icon), `${text.text} stays clear of icon ${icon.id}`).toBe(false);
      }
    }

    const slideText = normalize(bodyText.map((element) => element.text).join(" "));
    plan.slides[8]!.content.forEach((item) => expect(slideText).toContain(normalize(item)));
  });

  it("keeps Visual VK WorkSpace cards clear of small source icon backgrounds", async () => {
    const templateName = "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx";
    const templatePath = new URL(`../fixtures/templates/organizer/${templateName}`, import.meta.url);
    const design = await parsePptxTemplate(await readFile(templatePath), templateName);
    const content = await normalizeContent(
      "Create a ten-slide, fact-based overview of reliable export layout parity and presentation readability.",
      [],
    );
    const plan = await createPresentationPlan(content, 10);
    const document = renderPresentation(design, plan, "visual", [], { variantGeometry: true });
    const rendered = document.slides[1];
    if (!rendered) throw new Error("The organizer regression plan is missing slide 2");
    const sourceLayout = design.layouts.find((layout) => layout.id === rendered.templateLayoutId);
    if (!sourceLayout) throw new Error("The selected VK WorkSpace card layout is missing");

    const iconArtwork = sourceLayout.elements.filter((element) => element.y >= sourceLayout.height * 0.2
      && element.w <= sourceLayout.width * 0.08
      && element.h <= sourceLayout.height * 0.1
      && (element.type === "image"
        || ((element.type === "text" || element.type === "placeholder")
          && !element.text.trim() && Boolean(element.fill || element.stroke))));
    const bodyText = rendered.canvas.elements.filter((element) => element.type === "text")
      .filter((element) => element.id !== "slide-2-text-0");
    expect(iconArtwork.length).toBeGreaterThanOrEqual(3);
    expect(bodyText.length).toBeGreaterThan(0);
    for (const text of bodyText) {
      for (const icon of iconArtwork) {
        expect(intersects(text, icon), `${text.text} stays clear of icon ${icon.id}`).toBe(false);
      }
    }

    const slideText = normalize(bodyText.map((element) => element.text).join(" "));
    plan.slides[1]!.content.forEach((item) => expect(slideText).toContain(normalize(item)));
  });

  it("keeps four semantic items out of three card anchors with overlapping source fields", async () => {
    const source = await parsePptxTemplate(await createFixtureTemplate("photo"), "anonymous-capacity.pptx");
    const base = withAnonymousTemplateLayouts(source, "photo");
    const cards = base.layouts.find((layout) => layout.id === "layout-cards");
    const prose = base.layouts.find((layout) => layout.id === "slide-1");
    if (!cards || !prose) throw new Error("Capacity fixture layouts are missing");
    const duplicate = cards.elements.find((element) => element.id === "card-text-0");
    if (!duplicate) throw new Error("First card anchor is missing");
    const threeCards = {
      ...cards,
      elements: [...cards.elements, { ...duplicate, id: "overlapping-source-field", text: "Sample copy" }],
    };
    const design = { ...base, layouts: [threeCards, prose] };
    const items = ["Discovery", "Pilot rollout", "Review constraints", "Measure adoption"];
    const slide = {
      id: "capacity-story",
      purpose: "advantages" as const,
      title: "Four workstreams",
      content: items,
      visualIntent: "cards" as const,
    };
    const selected = chooseTemplateLayout(design, slide);
    const plan = narrativePlan();
    const rendered = renderPresentation(design, {
      ...plan,
      slides: plan.slides.map((existing, index) => index === 2 ? slide : existing),
    }).slides[2];

    expect(selected.id).toBe(prose.id);
    expect(rendered?.templateLayoutId).toBe(prose.id);
    const text = rendered?.canvas.elements.filter((element) => element.type === "text").map((element) => element.text).join(" ") || "";
    items.forEach((item) => expect(text).toContain(item));
    expect(text).not.toContain("Sample copy");
  });

  it("chooses prose when one multi-clause paragraph has too few distinct card anchors", async () => {
    const source = await parsePptxTemplate(await createFixtureTemplate("photo"), "anonymous-clauses.pptx");
    const base = withAnonymousTemplateLayouts(source, "photo");
    const cards = base.layouts.find((layout) => layout.id === "layout-cards");
    const prose = base.layouts.find((layout) => layout.id === "slide-1");
    if (!cards || !prose) throw new Error("Clause fixture layouts are missing");
    const oneAnchor = {
      ...cards,
      elements: cards.elements.filter((element) => !["card-text-1", "card-text-2"].includes(element.id)),
    };
    const design = { ...base, layouts: [oneAnchor, prose] };
    const slide = {
      id: "clause-story",
      purpose: "advantages" as const,
      title: "Workstreams",
      content: ["Discover needs; pilot changes; measure outcomes."],
      visualIntent: "cards" as const,
    };
    const selected = chooseTemplateLayout(design, slide);
    const plan = narrativePlan();
    const rendered = renderPresentation(design, {
      ...plan,
      slides: plan.slides.map((existing, index) => index === 2 ? slide : existing),
    }).slides[2];

    expect(selected.id).toBe(prose.id);
    expect(rendered?.templateLayoutId).toBe(prose.id);
    const text = rendered?.canvas.elements.filter((element) => element.type === "text").map((element) => element.text).join(" ") || "";
    expect(text).toContain(slide.content[0]);
  });

  it("prefers editable card slots over a broad full-bleed image overlay for list roles", async () => {
    const source = await parsePptxTemplate(await createFixtureTemplate("photo"), "renamed-role-fixture.pptx");
    const base = withAnonymousTemplateLayouts(source, "photo");
    const dimensions = base.layouts[0];
    const cardSource = base.layouts.find((layout) => layout.composition === "cards");
    if (!dimensions || !cardSource) throw new Error("Fixture template is missing dimensions or a card layout");
    const x = (value: number) => dimensions.width * value;
    const y = (value: number) => dimensions.height * value;
    const rasterOverlay: TemplateLayout = {
      ...dimensions,
      id: "anonymous-raster-page",
      name: "Untitled visual page",
      composition: "split",
      cardCount: 0,
      elements: [
        {
          id: "background-art",
          type: "image",
          name: "Full-slide illustration",
          x: 0,
          y: 0,
          w: dimensions.width,
          h: dimensions.height,
          text: "",
          imageDataUrl: PIXEL,
          zIndex: 0,
        },
        {
          id: "source-heading",
          type: "text",
          name: "Title",
          x: x(0.05),
          y: y(0.08),
          w: x(0.62),
          h: y(0.13),
          text: "Пример заголовка",
          fontSize: 30,
          fontWeight: 700,
          zIndex: 2,
        },
        {
          id: "source-wide-body",
          type: "text",
          name: "Content",
          x: x(0.05),
          y: y(0.28),
          w: x(0.9),
          h: y(0.55),
          text: "Пример содержания",
          fontSize: 18,
          zIndex: 2,
        },
      ],
      textSlots: 2,
      placeholderCount: 0,
      visualSlots: 1,
      recurringElementIds: [],
    };
    const editableCards = { ...cardSource, id: "anonymous-card-page", name: "Untitled repeated composition" };
    const design = { ...base, layouts: [rasterOverlay, editableCards] };
    const slide = narrativePlan().slides[2];
    if (!slide) throw new Error("Fixture narrative has no list slide");
    const position = { slideIndex: 2, slideCount: 6 };
    const selected = chooseTemplateLayout(design, slide, "balanced", undefined, position);

    expect(selected.id).toBe(editableCards.id);
    expect(chooseTemplateLayout(
      { ...design, layouts: [rasterOverlay] },
      { ...slide, visualIntent: "image" },
      "balanced",
      undefined,
      position,
    ).id).toBe(rasterOverlay.id);

    const wideBody = rasterOverlay.elements.find((element) => element.id === "source-wide-body");
    const backgroundArt = rasterOverlay.elements.find((element) => element.id === "background-art");
    if (!wideBody || !backgroundArt) throw new Error("Raster fixture is missing its broad body or image");
    const rasterCardOverlay: TemplateLayout = {
      ...editableCards,
      id: "anonymous-raster-card-page",
      name: "Untitled repeated visual page",
      elements: [...editableCards.elements, backgroundArt, wideBody],
      textSlots: editableCards.textSlots + 1,
      visualSlots: editableCards.visualSlots + 1,
    };
    const oneItemSlide = { ...slide, content: ["One concise summary"] };
    const singleItemSelection = chooseTemplateLayout(
      { ...design, layouts: [rasterCardOverlay, editableCards] },
      oneItemSlide,
      "balanced",
      undefined,
      position,
    );
    expect(singleItemSelection.id).toBe(editableCards.id);
  });

  it("keeps raster-backed closing copy inside its source column when the text needs more height", async () => {
    const source = await parsePptxTemplate(await createFixtureTemplate("photo"), "renamed-closing-fixture.pptx");
    const base = withAnonymousTemplateLayouts(source, "photo");
    const dimensions = base.layouts[0];
    if (!dimensions) throw new Error("Fixture template has no layouts");
    const x = (value: number) => dimensions.width * value;
    const y = (value: number) => dimensions.height * value;
    const closingLayout: TemplateLayout = {
      ...dimensions,
      id: "anonymous-raster-closing",
      name: "Closing page",
      composition: "text",
      elements: [
        {
          id: "background-photo",
          type: "image",
          name: "Full-slide photograph",
          x: 0,
          y: 0,
          w: dimensions.width,
          h: dimensions.height,
          text: "",
          imageDataUrl: PIXEL,
          zIndex: 0,
        },
        {
          id: "closing-title",
          type: "text",
          name: "Title",
          x: x(0.06),
          y: y(0.15),
          w: x(0.62),
          h: y(0.13),
          text: "Пример заголовка",
          fontSize: 30,
          fontWeight: 700,
          zIndex: 2,
        },
        {
          id: "closing-summary",
          type: "text",
          name: "Summary",
          x: x(0.06),
          y: y(0.55),
          w: x(0.46),
          h: y(0.05),
          text: "Пример содержания",
          fontSize: 18,
          zIndex: 2,
        },
        {
          id: "closing-artwork",
          type: "shape",
          name: "Accent illustration",
          x: x(0.49),
          y: y(0.64),
          w: x(0.15),
          h: y(0.16),
          text: "",
          fill: "#0077B6",
          stroke: "#0077B6",
          zIndex: 4,
        },
      ],
      textSlots: 2,
      placeholderCount: 0,
      visualSlots: 1,
      cardCount: 0,
      recurringElementIds: [],
    };
    const design = { ...base, layouts: [closingLayout] };
    const summary = Array.from({ length: 2 }, () => (
      "Определить следующие действия на основании подтверждённых материалов и согласовать сроки с ответственными командами."
    )).join(" ");
    const plan = narrativePlan();
    const closingSlide = plan.slides.at(-1);
    if (!closingSlide) throw new Error("Fixture narrative has no ending slide");
    const document = renderPresentation(design, {
      ...plan,
      title: "Завершение",
      slides: [
        ...plan.slides.slice(0, -1),
        { ...closingSlide, title: "Итог проекта", content: [summary], visualIntent: "none" },
      ],
    });
    const rendered = document.slides.at(-1);
    if (!rendered) throw new Error("Closing slide was not rendered");
    const body = rendered.canvas.elements.find((element) => (
      element.type === "text" && element.sourceTemplateElementId === "closing-summary"
    ));
    const artwork = rendered.canvas.elements.find((element) => (
      element.sourceTemplateElementId === "closing-artwork"
    ));
    if (!body || body.type !== "text" || !artwork) throw new Error("Closing slot or illustration was not transferred");

    expect(body.x).toBe(closingLayout.elements[2]?.x);
    expect(body.w).toBeLessThanOrEqual(dimensions.width * 0.42);
    expect(body.x + body.w).toBeLessThanOrEqual(artwork.x);
    expect(body.h).toBeGreaterThan(closingLayout.elements[2]?.h || 0);
    expect(normalize(body.text)).toContain(normalize(summary));
  });
});

function withAnonymousTemplateLayouts(source: DesignSystem, theme: FixtureTheme): DesignSystem {
  const base = source.layouts[0];
  if (!base) throw new Error("Fixture parser did not return a source layout");
  const palette = FIXTURE_PALETTES[theme];
  const headingFont = source.typography.headingFonts[0] || "Arial";
  const bodyFont = source.typography.bodyFonts[0] || "Arial";
  const x = (value: number) => base.width * value;
  const y = (value: number) => base.height * value;
  const text = (
    id: string,
    left: number,
    top: number,
    width: number,
    height: number,
    size: number,
    heading = false,
  ): TemplateElement => ({
    id,
    type: "text",
    name: heading ? "Untitled field A" : "Untitled field B",
    x: x(left),
    y: y(top),
    w: x(width),
    h: y(height),
    text: heading ? "Пример заголовка" : "Пример содержания",
    fontFamily: heading ? headingFont : bodyFont,
    fontSize: size,
    fontWeight: heading ? 700 : 500,
    zIndex: heading ? 20 : 21,
  });
  const shape = (
    id: string,
    left: number,
    top: number,
    width: number,
    height: number,
    fill: string,
    zIndex = 2,
  ): TemplateElement => ({
    id,
    type: "shape",
    name: "Untitled artwork",
    x: x(left),
    y: y(top),
    w: x(width),
    h: y(height),
    text: "",
    fill,
    stroke: fill,
    zIndex,
  });
  const image = (id: string, left: number, top: number, width: number, height: number): TemplateElement => ({
    id,
    type: "image",
    name: "Untitled visual anchor",
    x: x(left),
    y: y(top),
    w: x(width),
    h: y(height),
    text: "",
    imageDataUrl: PIXEL,
    zIndex: 4,
  });

  const layout = (
    id: string,
    composition: TemplateLayout["composition"],
    background: string,
    elements: TemplateElement[],
    cardCount = 0,
  ): TemplateLayout => ({
    id,
    name: "Unlabelled template page",
    source: "slide",
    sourceFile: `ppt/slides/${id}.xml`,
    width: base.width,
    height: base.height,
    background,
    elements,
    textSlots: elements.filter((element) => element.type === "text" || element.type === "placeholder").length,
    placeholderCount: 0,
    visualSlots: elements.filter((element) => element.type === "image").length,
    cardCount,
    composition,
    recurringElementIds: [],
  });

  const cover = layout("layout-cover", "title", palette[0]!, [
    shape("cover-accent", 0, 0.025, 1, 0.025, palette[2]!),
    text("cover-heading", 0.08, 0.17, 0.62, 0.16, 34, true),
    text("cover-subtitle", 0.08, 0.38, 0.62, 0.1, 18),
    image("cover-anchor", 0.82, 0.12, 0.1, 0.14),
  ]);
  const misidentifiedOpening = layout("slide-1", "split", palette[1]!, [
    text("split-heading", 0.07, 0.08, 0.85, 0.13, 30, true),
    text("split-body", 0.07, 0.3, 0.46, 0.46, 20),
    shape("split-art", 0.62, 0.28, 0.28, 0.42, palette[2]!),
    image("split-anchor", 0.67, 0.34, 0.18, 0.25),
  ]);
  const cardElements: TemplateElement[] = [
    text("cards-heading", 0.07, 0.08, 0.78, 0.13, 30, true),
    shape("cards-artwork", 0.9, 0.08, 0.05, 0.08, palette[2]!),
  ];
  for (let index = 0; index < 3; index += 1) {
    const left = 0.07 + index * 0.3;
    cardElements.push(
      shape(`card-${index}`, left, 0.32, 0.26, 0.46, palette[1]!, 3),
      text(`card-text-${index}`, left + 0.025, 0.39, 0.21, 0.28, 18),
    );
  }
  const cards = layout("layout-cards", "cards", palette[0]!, cardElements, 3);
  const timeline = layout("layout-timeline", "timeline", palette[1]!, [
    text("timeline-heading", 0.08, 0.08, 0.78, 0.13, 30, true),
    shape("timeline-line", 0.09, 0.5, 0.82, 0.008, palette[2]!),
    ...[0, 1, 2].map((index) => text(`timeline-step-${index}`, 0.08 + index * 0.29, 0.57, 0.22, 0.18, 17)),
    image("timeline-anchor", 0.86, 0.12, 0.08, 0.1),
  ]);
  const visual = layout("layout-visual", "visual", palette[0]!, [
    text("visual-heading", 0.07, 0.08, 0.78, 0.13, 30, true),
    text("visual-body", 0.07, 0.31, 0.43, 0.42, 19),
    shape("visual-art", 0.62, 0.27, 0.3, 0.48, palette[1]!),
    image("visual-anchor", 0.67, 0.32, 0.2, 0.35),
  ]);
  const ending = layout("layout-ending", "text", palette[2]!, [
    shape("ending-footer", 0.1, 0.91, 0.8, 0.025, palette[3]!),
    text("ending-heading", 0.2, 0.22, 0.6, 0.15, 32, true),
    text("ending-summary", 0.18, 0.45, 0.64, 0.27, 21),
    image("ending-anchor", 0.86, 0.08, 0.07, 0.09),
  ]);

  return {
    ...source,
    sourceName: "unlabelled-upload.pptx",
    colors: palette,
    layouts: [misidentifiedOpening, cards, cover, timeline, visual, ending],
  };
}

function narrativePlan(): PresentationPlan {
  return {
    title: "Проверка переноса композиции",
    planner: "deterministic",
    slides: [
      { id: "story-1", purpose: "title", title: "Проверка обложки", content: ["Короткий тезис"], visualIntent: "none" },
      { id: "story-2", purpose: "context", title: "Содержательный блок", content: ["Ключевой факт", "Короткий вывод"], visualIntent: "none" },
      { id: "story-3", purpose: "advantages", title: "Список решений", content: ["Первый шаг", "Второй шаг", "Третий шаг"], visualIntent: "cards" },
      { id: "story-4", purpose: "workflow", title: "Последовательность", content: ["Собрать данные", "Сравнить варианты", "Подвести итог"], visualIntent: "timeline" },
      { id: "story-5", purpose: "solution", title: "Связи системы", content: ["Источник", "Обработка"], visualIntent: "diagram" },
      { id: "story-6", purpose: "summary", title: "Итог выступления", content: ["Результат понятен", "План выполним", "Команда готова"], visualIntent: "none" },
    ],
  };
}

function normalize(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function contains(container: TemplateElement, content: TemplateElement) {
  return content.x >= container.x
    && content.y >= container.y
    && content.x + content.w <= container.x + container.w
    && content.y + content.h <= container.y + container.h;
}

function intersects(
  left: Pick<TemplateElement, "x" | "y" | "w" | "h">,
  right: Pick<TemplateElement, "x" | "y" | "w" | "h">,
) {
  return left.x < right.x + right.w && left.x + left.w > right.x
    && left.y < right.y + right.h && left.y + left.h > right.y;
}

function contrastRatio(first: string, second: string) {
  const left = luminance(first);
  const right = luminance(second);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function luminance(color: string) {
  const channels = color.match(/[\da-f]{2}/giu)?.slice(-3).map((channel) => parseInt(channel, 16) / 255) || [];
  const [red, green, blue] = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (red || 0) + 0.7152 * (green || 0) + 0.0722 * (blue || 0);
}
