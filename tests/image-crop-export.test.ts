import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createStandaloneHtml } from "../src/lib/html-export";
import { createPresentationPptx } from "../src/lib/pptx-export";
import { canvasImageSchema, presentationDocumentSchema } from "../src/lib/schemas";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLZ4QAAAABJRU5ErkJggg==", "base64");
const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
const baseImage = {
  id: "first",
  type: "image" as const,
  x: 20,
  y: 30,
  w: 100,
  h: 80,
  alt: "First <crop>",
  dataUrl,
  zIndex: 1,
  locked: false,
};

describe("per-placement image crop export", () => {
  it("validates signed bounded percentages and keeps uncropped images backward compatible", () => {
    expect(canvasImageSchema.parse(baseImage)).not.toHaveProperty("crop");
    expect(canvasImageSchema.parse({ ...baseImage, crop: { left: -10, top: 0, right: 25.125, bottom: 5 } }).crop)
      .toEqual({ left: -10, top: 0, right: 25.125, bottom: 5 });
    for (const crop of [
      { left: 101, top: 0, right: 0, bottom: 0 },
      { left: -101, top: 0, right: 0, bottom: 0 },
      { left: 50, top: 0, right: 50, bottom: 0 },
      { left: 0, top: 75, right: 0, bottom: 25 },
      { left: Number.NaN, top: 0, right: 0, bottom: 0 },
      { left: 0, top: 0, right: 0, bottom: 0, extra: 1 },
    ]) {
      expect(canvasImageSchema.safeParse({ ...baseImage, crop }).success).toBe(false);
    }
  });

  it("writes separate native srcRect values while preserving the original media bytes", async () => {
    const document = await fixtureDocument();
    const archive = await JSZip.loadAsync(await createPresentationPptx(document));
    const xml = await archive.file("ppt/slides/slide1.xml")?.async("string");
    expect(xml).toBeDefined();
    const pictures = xml!.match(/<p:pic\b[\s\S]*?<\/p:pic>/gu) ?? [];
    expect(pictures).toHaveLength(3);
    expect(pictures[0]).toContain('<a:srcRect l="25000" t="0" r="25000" b="20000"/>');
    expect(pictures[0]).toMatch(/<a:blip\b[^>]*>[\s\S]*?<\/a:blip><a:srcRect l="25000" t="0" r="25000" b="20000"\/>/u);
    expect(pictures[1]).toContain('<a:srcRect l="-10000" t="5000" r="30000" b="0"/>');
    expect(pictures[2]).not.toContain("a:srcRect");
    expect(pictures.every((picture) => picture.includes("<a:blip"))).toBe(true);
    const mediaFiles = archive.file(/^ppt\/media\//u);
    expect(mediaFiles.length).toBeGreaterThan(0);
    const mediaBytes = await Promise.all(mediaFiles.map((file) => file.async("nodebuffer")));
    expect(mediaBytes.some((bytes) => bytes.equals(imageBytes))).toBe(true);
  });

  it("clips each HTML placement to the same visible region with alt, dimensions, and safe data URLs", async () => {
    const html = createStandaloneHtml(await fixtureDocument());
    const first = html.match(/<div class="element element-image-crop" data-element-id="first"[\s\S]*?<\/div>/u)?.[0];
    const second = html.match(/<div class="element element-image-crop" data-element-id="second"[\s\S]*?<\/div>/u)?.[0];
    expect(first).toContain("left:20px;top:30px;width:100px;height:80px");
    expect(first).toContain("overflow:hidden");
    expect(first).toContain("width:200px;height:100px;left:-50px;top:0px");
    expect(first).toContain('alt="First &lt;crop&gt;"');
    expect(second).toContain("width:125px;height:84.2105px;left:12.5px;top:-4.2105px");
    expect(second).toContain('alt="Second"');
    expect(first).toContain(`src="${dataUrl}"`);
    expect(html).toMatch(/<img class="element element-image" data-element-id="plain"[^>]*style="[^"]*width:100px;height:80px[^"]*object-fit:fill;/u);
    expect(html).not.toContain("<script");
  });
});

async function fixtureDocument() {
  const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "crop-fixture.pptx");
  const content = await normalizeContent("Image crop", []);
  const plan = await createPresentationPlan(content, 5);
  const document = renderPresentation(design, plan);
  document.slides[0]!.canvas.elements = [
    { ...baseImage, crop: { left: 25, top: 0, right: 25, bottom: 20 } },
    { ...baseImage, id: "second", alt: "Second", zIndex: 2, crop: { left: -10, top: 5, right: 30, bottom: 0 } },
    { ...baseImage, id: "plain", alt: "Plain", zIndex: 3 },
  ];
  return presentationDocumentSchema.parse(document);
}
