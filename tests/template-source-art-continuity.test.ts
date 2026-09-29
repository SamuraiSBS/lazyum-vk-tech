import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createStandaloneHtml } from "../src/lib/html-export";
import { createPresentationPlan } from "../src/lib/planner";
import { createPresentationPptx } from "../src/lib/pptx-export";
import { renderPresentation } from "../src/lib/renderer";
import { designSystemSchema, type CanvasElement } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";

const templateName = "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx";
const heroId = "inherited-6-119";
const stripId = "inherited-5-118";

function image(slide: { canvas: { elements: CanvasElement[] } }, sourceId: string) {
  const found = slide.canvas.elements.find((element) => element.type === "image"
    && element.sourceTemplateElementId === sourceId);
  if (!found || found.type !== "image") throw new Error(`Missing source image ${sourceId}`);
  return found;
}

function digest(dataUrl: string) {
  return createHash("sha256").update(Buffer.from(dataUrl.split(",")[1]!, "base64")).digest("hex");
}

describe("source artwork rotation and crop continuity", () => {
  it("transfers the WorkSpace source placement through canvas, HTML and native PPTX", async () => {
    const bytes = await readFile(new URL(`../fixtures/templates/organizer/${templateName}`, import.meta.url));
    const original = await JSZip.loadAsync(bytes);
    const sourceXml = await original.file("ppt/slideLayouts/slideLayout4.xml")!.async("string");
    const sourcePicture = sourceXml.match(/<p:pic\b[\s\S]*?Google Shape;119;p5[\s\S]*?<\/p:pic>/u)?.[0];
    expect(sourcePicture).toContain('rot="10800000"');
    expect(sourcePicture).toContain('r="26515" t="13089"');

    const design = await parsePptxTemplate(bytes, templateName);
    const layout = design.layouts.find((item) => item.id === "slide-4")!;
    const sourceHero = layout.elements.find((element) => element.id === heroId)!;
    const sourceStrip = layout.elements.find((element) => element.id === stripId)!;
    expect(sourceHero.rotation).toBe(180);
    expect(sourceHero.crop).toEqual({ left: 0, top: 13.089, right: 26.515, bottom: 0 });
    expect(sourceStrip.crop).toEqual({ left: 52.053, top: 90.954, right: 0, bottom: 2.847 });
    expect(sourceStrip.rotation).toBeUndefined();

    const plan = await createPresentationPlan(await normalizeContent("WorkSpace source artwork", []), 5);
    const document = renderPresentation(design, plan, "visual", [], {
      layoutOverrides: new Map([[plan.slides[0]!.id, layout.id]]), variantGeometry: true,
    });
    const rendered = document.slides[0]!;
    const hero = image(rendered, heroId);
    const strip = image(rendered, stripId);
    expect(rendered.templateLayoutId).toBe(layout.id);
    expect(hero.rotation).toBe(180);
    expect(hero.crop).toEqual(sourceHero.crop);
    expect(digest(hero.dataUrl!)).toBe(digest(sourceHero.imageDataUrl!));
    expect({ x: hero.x, y: hero.y, w: hero.w, h: hero.h }).toEqual({
      x: sourceHero.x, y: sourceHero.y, w: sourceHero.w, h: sourceHero.h,
    });
    // The separate, deliberately cropped lower strip remains untouched.
    expect(strip.crop).toEqual(sourceStrip.crop);
    expect(strip.rotation).toBeUndefined();
    expect(digest(strip.dataUrl!)).toBe(digest(sourceStrip.imageDataUrl!));

    const html = createStandaloneHtml(document);
    expect(html).toMatch(/data-element-id="template-image-inherited-6-119"[^>]*transform:rotate\(180deg\)/u);
    expect(html).not.toMatch(/data-element-id="template-image-inherited-5-118"[^>]*transform:rotate/u);

    const pptx = await JSZip.loadAsync(await createPresentationPptx(document));
    const outputXml = await pptx.file("ppt/slides/slide1.xml")!.async("string");
    const pictures = [...outputXml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gu)].map((match) => match[0]);
    const renderedImages = rendered.canvas.elements.filter((element) => element.type === "image" && element.dataUrl);
    expect(pictures).toHaveLength(renderedImages.length);
    const heroXml = pictures[renderedImages.findIndex((element) => element.id === hero.id)]!;
    const stripXml = pictures[renderedImages.findIndex((element) => element.id === strip.id)]!;
    expect(heroXml).toMatch(/<a:xfrm\b[^>]*rot="10800000"/u);
    expect(heroXml).toContain('<a:srcRect l="0" t="13089" r="26515" b="0"/>');
    expect(stripXml).not.toMatch(/<a:xfrm\b[^>]*rot=/u);
    expect(stripXml).toContain('<a:srcRect l="52053" t="90954" r="0" b="2847"/>');
  }, 120_000);

  it("keeps an intentional crop and transfers an unrelated arbitrary image angle", async () => {
    const bytes = await readFile(new URL(`../fixtures/templates/organizer/${templateName}`, import.meta.url));
    const parsed = await parsePptxTemplate(bytes, templateName);
    const layout = parsed.layouts.find((item) => item.id === "slide-4")!;
    const changed = designSystemSchema.parse({
      ...parsed,
      layouts: parsed.layouts.map((item) => item.id === layout.id ? {
        ...item,
        elements: item.elements.map((element) => element.id === stripId ? { ...element, rotation: 30 } : element),
      } : item),
    });
    const plan = await createPresentationPlan(await normalizeContent("Generic placement", []), 5);
    const document = renderPresentation(changed, plan, "visual", [], {
      layoutOverrides: new Map([[plan.slides[0]!.id, layout.id]]), variantGeometry: true,
    });
    const strip = image(document.slides[0]!, stripId);
    expect(strip.rotation).toBe(30);
    expect(strip.crop).toEqual({ left: 52.053, top: 90.954, right: 0, bottom: 2.847 });
    const xml = await (await JSZip.loadAsync(await createPresentationPptx(document)))
      .file("ppt/slides/slide1.xml")!.async("string");
    const pictures = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gu)].map((match) => match[0]);
    const renderedImages = document.slides[0]!.canvas.elements.filter((element) => element.type === "image" && element.dataUrl);
    const stripXml = pictures[renderedImages.findIndex((element) => element.id === strip.id)]!;
    expect(stripXml).toMatch(/<a:xfrm\b[^>]*rot="1800000"/u);
    expect(stripXml).toContain('<a:srcRect l="52053" t="90954" r="0" b="2847"/>');
  }, 120_000);
});
