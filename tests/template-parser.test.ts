import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { designSystemSchema } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

const slide1File = "ppt/slides/slide1.xml";
const slide2File = "ppt/slides/slide2.xml";
const layout1File = "ppt/slideLayouts/slideLayout1.xml";
const master1File = "ppt/slideMasters/slideMaster1.xml";

async function mutatePart(zip: JSZip, file: string, mutate: (xml: string) => string) {
  const entry = zip.file(file);
  if (!entry) throw new Error("Fixture part is missing: " + file);
  zip.file(file, mutate(await entry.async("string")));
}

async function setBackground(zip: JSZip, file: string, color?: string) {
  await mutatePart(zip, file, (xml) => {
    const withoutBackground = xml.replace(/<p:bg\b[^>]*>[\s\S]*?<\/p:bg>/g, "");
    const background = color
      ? "<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"" + color + "\"/></a:solidFill><a:effectLst/></p:bgPr><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:bg>"
      : "";
    if (!/<p:cSld\b[^>]*>/.test(withoutBackground)) throw new Error("Fixture part has no p:cSld: " + file);
    return withoutBackground.replace(/<p:cSld\b[^>]*>/, (opening) => opening + background);
  });
}

async function appendShape(zip: JSZip, file: string, shape: string) {
  await mutatePart(zip, file, (xml) => {
    if (!xml.includes("</p:spTree>")) throw new Error("Fixture part has no p:spTree: " + file);
    return xml.replace("</p:spTree>", shape + "</p:spTree>");
  });
}

function artworkShape(id: number, color: string) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Artwork ' + id +
    '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="952500" y="952500"/>' +
    '<a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/>' +
    '</a:prstGeom><a:solidFill><a:srgbClr val="' + color +
    '"/></a:solidFill></p:spPr></p:sp>';
}

async function setShowMasterShapes(zip: JSZip, file: string, value: string) {
  const root = file.includes("/slides/") ? "p:sld" : "p:sldLayout";
  await mutatePart(zip, file, (xml) => {
    const expression = new RegExp("<" + root + "\\b");
    if (!expression.test(xml)) throw new Error("Fixture root is missing: " + file);
    return xml.replace(expression, "<" + root + ' showMasterSp="' + value + '"');
  });
}

function addPictureCrop(picture: string, rect: string) {
  const withCrop = picture.replace(/<a:blip\b[^>]*(?:\/>|>[\s\S]*?<\/a:blip>)/u, (blip) => blip + rect);
  if (withCrop === picture) throw new Error("Fixture picture has no a:blip");
  return withCrop;
}

function placeholderShape(options: {
  id: number;
  name: string;
  index: number;
  geometry?: { x?: number; y?: number; cx?: number; cy?: number };
  fontFamily?: string;
  fontSize?: number;
  bold?: string;
  fill?: string | null;
  stroke?: string | null;
  textColor?: string;
  text: string;
}) {
  const geometry = options.geometry;
  const off = geometry?.x !== undefined || geometry?.y !== undefined
    ? "<a:off" + (geometry.x === undefined ? "" : " x=\"" + geometry.x + "\"") +
      (geometry.y === undefined ? "" : " y=\"" + geometry.y + "\"") + "/>"
    : "";
  const ext = geometry?.cx !== undefined || geometry?.cy !== undefined
    ? "<a:ext" + (geometry.cx === undefined ? "" : " cx=\"" + geometry.cx + "\"") +
      (geometry.cy === undefined ? "" : " cy=\"" + geometry.cy + "\"") + "/>"
    : "";
  const transform = off || ext ? "<a:xfrm>" + off + ext + "</a:xfrm>" : "";
  const textStyle = options.fontFamily || options.fontSize !== undefined || options.bold !== undefined || options.textColor
    ? "<a:rPr" + (options.fontSize === undefined ? "" : " sz=\"" + options.fontSize + "\"") +
      (options.bold === undefined ? "" : " b=\"" + options.bold + "\"") + ">" +
      (options.fontFamily ? "<a:latin typeface=\"" + options.fontFamily + "\"/>" : "") +
      (options.textColor ? "<a:solidFill><a:srgbClr val=\"" + options.textColor + "\"/></a:solidFill>" : "") +
      "</a:rPr>"
    : "";
  const fill = options.fill === null
    ? "<a:noFill/>"
    : options.fill
      ? "<a:solidFill><a:srgbClr val=\"" + options.fill + "\"/></a:solidFill>"
      : "";
  const stroke = options.stroke === null
    ? "<a:ln><a:noFill/></a:ln>"
    : options.stroke
      ? "<a:ln><a:solidFill><a:srgbClr val=\"" + options.stroke + "\"/></a:solidFill></a:ln>"
      : "";
  return [
    "<p:sp><p:nvSpPr><p:cNvPr id=\"" + options.id + "\" name=\"" + options.name + "\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"body\" idx=\"" + options.index + "\"/></p:nvPr></p:nvSpPr>",
    "<p:spPr>" + transform + "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>" + fill + stroke + "</p:spPr>",
    "<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>" + textStyle + "<a:t>" + options.text + "</a:t></a:r></a:p></p:txBody></p:sp>",
  ].join("");
}

async function parsedFromZip(zip: JSZip, sourceName: string) {
  return parsePptxTemplate(await zip.generateAsync({ type: "nodebuffer" }), sourceName);
}

function layoutFor(design: Awaited<ReturnType<typeof parsePptxTemplate>>, sourceFile: string) {
  const layout = design.layouts.find((candidate) => candidate.sourceFile === sourceFile);
  if (!layout) throw new Error("Parsed layout was not retained: " + sourceFile);
  return layout;
}

describe("Template Parser", () => {
  it("keeps interleaved shape and picture XML order", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("photo"));
    const slideXml = await zip.file(slide1File)!.async("string");
    const picture = slideXml.match(/<p:pic\b[\s\S]*?<\/p:pic>/u)?.[0];
    if (!picture) throw new Error("Photo fixture has no picture");
    const orderedPicture = picture.replace(/<p:cNvPr\b[^>]*\bid="\d+"/u,
      (node) => node.replace(/\bid="\d+"/u, 'id="978"'));
    const shape = (id: number) => artworkShape(id, "123456");
    await appendShape(zip, slide1File, shape(976) + orderedPicture + shape(977));
    const elements = layoutFor(await parsedFromZip(zip, "interleaved.pptx"), slide1File).elements;
    expect(["976", "978", "977"].map((id) => elements.find((element) => element.id === id)!.zIndex))
      .toEqual([elements.length - 3, elements.length - 2, elements.length - 1]);
  });

  it("maps nested group children with translation and unequal scales while retaining provenance", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("photo"));
    const original = await zip.file(slide1File)!.async("string");
    const picture = original.match(/<p:pic\b[\s\S]*?<\/p:pic>/u)?.[0];
    if (!picture) throw new Error("Photo fixture has no picture");
    const emu = (pixels: number) => pixels * 9525;
    const group = (id: number, off: [number, number], ext: [number, number], childOff: [number, number], childExt: [number, number], children: string, extra = "") =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm${extra}><a:off x="${emu(off[0])}" y="${emu(off[1])}"/>` +
      `<a:ext cx="${emu(ext[0])}" cy="${emu(ext[1])}"/>` +
      `<a:chOff x="${emu(childOff[0])}" y="${emu(childOff[1])}"/>` +
      `<a:chExt cx="${emu(childExt[0])}" cy="${emu(childExt[1])}"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`;
    const shape = `<p:sp><p:nvSpPr><p:cNvPr id="981" name="Nested text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${emu(10)}" y="${emu(15)}"/><a:ext cx="${emu(20)}" cy="${emu(10)}"/></a:xfrm></p:spPr>` +
      `<p:txBody><a:p><a:r><a:t>Nested text</a:t></a:r></a:p></p:txBody></p:sp>`;
    const line = `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="982" name="Nested line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${emu(30)}" y="${emu(30)}"/><a:ext cx="${emu(15)}" cy="${emu(10)}"/></a:xfrm></p:spPr></p:cxnSp>`;
    const nestedPicture = addPictureCrop(picture
      .replace(/<p:cNvPr\b[^>]*\bid="\d+"/u, (node) => node.replace(/\bid="\d+"/u, 'id="983"'))
      .replace(/<a:off\b[^>]*\/>/u, `<a:off x="${emu(25)}" y="${emu(20)}"/>`)
      .replace(/<a:ext\b[^>]*\/>/u, `<a:ext cx="${emu(10)}" cy="${emu(5)}"/>`), '<a:srcRect l="10000"/>');
    const inner = group(980, [30, 40], [100, 60], [5, 10], [50, 20], shape + line + nestedPicture);
    await appendShape(zip, slide1File, group(979, [100, 200], [400, 200], [10, 20], [200, 100], inner));
    const design = await parsedFromZip(zip, "nested-groups.pptx");
    const elements = layoutFor(design, slide1File).elements;
    const expected = [
      ["981", "text", 160, 270, 80, 60],
      ["982", "line", 240, 360, 60, 60],
      ["983", "image", 220, 300, 40, 30],
    ] as const;
    for (const [id, type, x, y, w, h] of expected) {
      expect(elements.find((element) => element.id === id)).toMatchObject({ id, type, x, y, w, h, sourceFile: slide1File });
    }
    expect(elements.find((element) => element.id === "983")).toMatchObject({
      crop: { left: 10, top: 0, right: 0, bottom: 0 },
      relationshipId: expect.any(String),
      imageDataUrl: expect.stringMatching(/^data:image\//u),
    });
    expect(expected.map(([id]) => elements.find((element) => element.id === id)!.zIndex))
      .toEqual([...expected.map(([id]) => elements.find((element) => element.id === id)!.zIndex)].sort((a, b) => a - b));
  });

  it("does not fabricate child positions for missing, degenerate, or rotated group transforms", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    const child = (id: number) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Unsafe"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      '<p:spPr><a:xfrm><a:off x="95250" y="95250"/><a:ext cx="95250" cy="95250"/></a:xfrm></p:spPr></p:sp>';
    const group = (id: number, transform: string, content: string) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Unsafe group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr>${transform}</p:grpSpPr>${content}</p:grpSp>`;
    const valid = '<a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/><a:chOff x="0" y="0"/><a:chExt cx="952500" cy="952500"/>';
    await appendShape(zip, slide1File, group(990, '<a:xfrm><a:off x="0" y="0"/></a:xfrm>', child(991)) +
      group(992, `<a:xfrm>${valid.replace('cx="952500" cy="952500"/>', 'cx="0" cy="952500"/>')}</a:xfrm>`, child(993)) +
      group(994, `<a:xfrm rot="5400000">${valid}</a:xfrm>`, child(995)));
    const design = await parsedFromZip(zip, "unsupported-groups.pptx");
    const elements = layoutFor(design, slide1File).elements;
    for (const id of ["991", "993", "995"]) expect(elements.some((element) => element.id === id)).toBe(false);
    expect(design.warnings.some((warning) => warning.includes("elementId=990") && warning.includes("degenerate"))).toBe(true);
    expect(design.warnings.some((warning) => warning.includes("elementId=992") && warning.includes("degenerate"))).toBe(true);
    expect(design.warnings.some((warning) => warning.includes("elementId=994") && warning.includes("rotation/flip"))).toBe(true);
  });

  it("keeps image srcRect on each OOXML placement with its source identity", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("photo"));
    const slideXml = await zip.file(slide1File)!.async("string");
    const picture = slideXml.match(/<p:pic\b[\s\S]*?<\/p:pic>/u)?.[0];
    if (!picture) throw new Error("Photo fixture has no p:pic");
    for (const [file, id, rect] of [
      [slide1File, "970", '<a:srcRect l="25125" t="0" r="15000" b="5000"/>'],
      [layout1File, "971", '<a:srcRect l="-10000" t="5000" r="30000" b="0"/>'],
      [master1File, "972", '<a:srcRect l="1000" t="2000" r="3000" b="4000"/>'],
    ] as const) {
      const placement = addPictureCrop(picture
        .replace(/<p:cNvPr\b[^>]*\bid="\d+"/u, (node) => node.replace(/\bid="\d+"/u, `id="${id}"`)), rect);
      await appendShape(zip, file, placement);
    }
    const design = await parsedFromZip(zip, "image-crop-provenance.pptx");
    const expected = [
      [slide1File, "970", { left: 25.125, top: 0, right: 15, bottom: 5 }],
      [layout1File, "971", { left: -10, top: 5, right: 30, bottom: 0 }],
      [master1File, "972", { left: 1, top: 2, right: 3, bottom: 4 }],
    ] as const;
    for (const [sourceFile, id, crop] of expected) {
      expect(design.layouts.flatMap((layout) => layout.elements)
        .some((element) => element.sourceFile === sourceFile && element.id.endsWith(id) &&
          JSON.stringify(element.crop) === JSON.stringify(crop)), `${sourceFile}:${id}`).toBe(true);
    }
    expect(design.layouts.flatMap((layout) => layout.elements)
      .some((element) => element.sourceFile === slide1File && element.type === "image" && !element.crop)).toBe(true);
  });

  it("ignores malformed and out-of-contract srcRect without losing its image", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("photo"));
    const xml = await zip.file(slide1File)!.async("string");
    const picture = xml.match(/<p:pic\b[\s\S]*?<\/p:pic>/u)?.[0];
    if (!picture) throw new Error("Photo fixture has no p:pic");
    for (const [id, rect] of [
      ["973", '<a:srcRect l="garbage"/>'],
      ["974", '<a:srcRect l="50000" r="50000"/>'],
      ["975", '<a:srcRect l="101000"/>'],
    ] as const) {
      await appendShape(zip, slide1File, addPictureCrop(picture
        .replace(/<p:cNvPr\b[^>]*\bid="\d+"/u, (node) => node.replace(/\bid="\d+"/u, `id="${id}"`)), rect));
    }
    const design = await parsedFromZip(zip, "invalid-crop.pptx");
    for (const id of ["973", "974", "975"]) {
      const image = design.layouts.flatMap((layout) => layout.elements)
        .find((element) => element.sourceFile === slide1File && element.id === id);
      expect(image?.type).toBe("image");
      expect(image).not.toHaveProperty("crop");
      expect(image?.imageDataUrl).toMatch(/^data:image\//u);
    }
  });

  it.each(["bright", "dark", "photo", "portrait"] as const)("extracts a design system from the %s fixture", async (theme) => {
    const design = await parsePptxTemplate(await createFixtureTemplate(theme), theme + ".pptx");

    expect(design.sourceName).toBe(theme + ".pptx");
    expect(design.slideSize.width).toBeGreaterThan(650);
    expect(design.slideSize.height).toBeGreaterThan(650);
    expect(design.colors.length).toBeGreaterThan(0);
    expect(design.layouts.length).toBeGreaterThan(0);
    expect(design.layouts.some((layout) => layout.elements.length > 0)).toBe(true);
    expect(design.visualPatterns.length).toBeGreaterThan(0);
  });

  it("scores retained layouts deterministically and keeps global diagnostics separate", async () => {
    const bytes = await createFixtureTemplate("bright");
    const first = await parsePptxTemplate(bytes, "ordinary.pptx");
    const second = await parsePptxTemplate(bytes, "ordinary.pptx");
    expect(first.layouts.map((layout) => [layout.sourceFile, layout.confidence, layout.parserWarnings]))
      .toEqual(second.layouts.map((layout) => [layout.sourceFile, layout.confidence, layout.parserWarnings]));
    expect(first.layouts.every((layout) => typeof layout.confidence === "number" && layout.confidence >= 0 && layout.confidence <= 1)).toBe(true);
    const legacy = structuredClone(first);
    legacy.layouts.forEach((layout) => { delete layout.confidence; delete layout.parserWarnings; });
    expect(designSystemSchema.safeParse(legacy).success).toBe(true);
  });

  it("attaches inherited background warnings to dependent layouts and scores fallback lower", async () => {
    const inheritedZip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await setBackground(inheritedZip, slide1File);
    await setBackground(inheritedZip, slide2File);
    await setBackground(inheritedZip, layout1File);
    await setBackground(inheritedZip, master1File, "654321");
    const inherited = await parsedFromZip(inheritedZip, "inherited.pptx");
    const fallbackZip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await setBackground(fallbackZip, slide1File);
    await setBackground(fallbackZip, slide2File);
    await setBackground(fallbackZip, layout1File);
    await setBackground(fallbackZip, master1File);
    const fallback = await parsedFromZip(fallbackZip, "fallback.pptx");
    const slide = layoutFor(fallback, slide1File);
    expect(slide.parserWarnings?.some((warning) => warning.includes("Fallback background used for " + layout1File))).toBe(true);
    expect(slide.confidence!).toBeLessThan(layoutFor(inherited, slide1File).confidence!);
  });

  it("assigns malformed relationship warnings only to their affected source", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    const relationshipFile = "ppt/slides/_rels/slide1.xml.rels";
    await mutatePart(zip, relationshipFile, (xml) => xml.replace(
      /Target="\.\.\/slideLayouts\/slideLayout\d+\.xml"/,
      'Target="../slideLayouts/missing-layout.xml"',
    ));
    const design = await parsedFromZip(zip, "broken.pptx");
    expect(layoutFor(design, slide1File).parserWarnings?.some((warning) => warning.includes("missing-layout.xml"))).toBe(true);
    expect(layoutFor(design, slide2File).parserWarnings?.some((warning) => warning.includes("missing-layout.xml"))).toBe(false);
    const intact = await parsePptxTemplate(await createFixtureTemplate("bright"), "intact.pptx");
    expect(layoutFor(design, slide1File).confidence!).toBeLessThan(layoutFor(intact, slide1File).confidence!);
  });

  it("keeps template image bytes for photo-led templates", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "photo-led.pptx");
    expect(design.layouts.flatMap((layout) => layout.elements).some((element) => element.imageDataUrl?.startsWith("data:image/"))).toBe(true);
    const asset = design.imageAssets?.find((candidate) => candidate.allowed);
    expect(asset?.target).toMatch(/^ppt\/media\//);
    expect(asset?.byteSize).toBeGreaterThan(0);
    expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(asset?.sources[0].sourceFile).toMatch(/_rels\/.*\.rels$/);
  });

  it("resolves slide and layout background overrides before the related master", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await setBackground(zip, slide1File, "ABCDEF");
    await setBackground(zip, slide2File);
    await setBackground(zip, layout1File, "123456");
    await setBackground(zip, master1File, "654321");

    const design = await parsedFromZip(zip, "background-precedence.pptx");
    const slideOverride = layoutFor(design, slide1File);
    const layoutInherited = layoutFor(design, slide2File);

    expect(slideOverride.background).toBe("#ABCDEF");
    expect(layoutInherited.background).toBe("#123456");
    expect(design.evidence?.backgrounds.find((entry) => entry.value === "#123456")?.sources)
      .toContainEqual({ sourceFile: layout1File, xmlPath: "/p:bg" });
    expect(design.warnings.some((warning) => warning.includes("Fallback background used for " + slide2File))).toBe(false);
  });

  it("inherits master backgrounds and uses a safe fallback only when the chain has no color", async () => {
    const inheritedZip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await setBackground(inheritedZip, slide1File);
    await setBackground(inheritedZip, slide2File);
    await setBackground(inheritedZip, layout1File);
    await setBackground(inheritedZip, master1File, "654321");
    const inherited = await parsedFromZip(inheritedZip, "master-background.pptx");

    expect(layoutFor(inherited, slide1File).background).toBe("#654321");
    expect(inherited.evidence?.backgrounds.find((entry) => entry.value === "#654321")?.sources)
      .toContainEqual({ sourceFile: master1File, xmlPath: "/p:bg" });
    expect(inherited.warnings.some((warning) => warning.includes("Fallback background used for " + slide1File))).toBe(false);

    const fallbackZip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await setBackground(fallbackZip, slide1File);
    await setBackground(fallbackZip, slide2File);
    await setBackground(fallbackZip, layout1File);
    await setBackground(fallbackZip, master1File);
    const fallback = await parsedFromZip(fallbackZip, "safe-background-fallback.pptx");

    expect(layoutFor(fallback, slide1File).background).toBe("#FFFFFF");
    expect(fallback.warnings.some((warning) => warning.includes("Fallback background used for " + layout1File))).toBe(true);
    expect(fallback.warnings.some((warning) => warning.includes("Fallback background used for " + slide1File))).toBe(false);
    expect(fallback.evidence?.backgrounds.find((entry) => entry.value === "#FFFFFF")?.sources)
      .toContainEqual({ sourceFile: "generated", xmlPath: "/fallback/background/" + layout1File });
  });

  it("inherits matching placeholder geometry and typography without replacing slide text", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await appendShape(zip, master1File, placeholderShape({
      id: 901,
      name: "Master body placeholder",
      index: 42,
      geometry: { x: 952500, y: 1905000, cx: 2857500, cy: 476250 },
      fontFamily: "Master Cascade Font",
      fontSize: 3000,
      bold: "1",
      text: "MASTER PLACEHOLDER TEXT",
    }));
    await appendShape(zip, layout1File, placeholderShape({
      id: 902,
      name: "Layout body placeholder",
      index: 42,
      geometry: { x: 1905000, cx: 3810000 },
      fontFamily: "Layout Cascade Font",
      fontSize: 1800,
      text: "LAYOUT PLACEHOLDER TEXT",
    }));
    await appendShape(zip, slide1File, placeholderShape({
      id: 903,
      name: "Slide body placeholder",
      index: 42,
      geometry: { x: 2857500 },
      fontFamily: "Slide Cascade Font",
      text: "SLIDE OWNED TEXT",
    }));

    const design = await parsedFromZip(zip, "placeholder-cascade.pptx");
    const slide = layoutFor(design, slide1File);
    const placeholder = slide.elements.find((element) => element.id === "903");

    expect(placeholder).toMatchObject({
      type: "placeholder",
      x: 300,
      y: 200,
      w: 400,
      h: 50,
      text: "SLIDE OWNED TEXT",
      fontFamily: "Slide Cascade Font",
      fontSize: 24,
      fontWeight: 700,
      sourceFile: slide1File,
    });
    expect(placeholder?.inheritedFrom).toContain(layout1File);
    expect(placeholder?.inheritedFrom).toContain(master1File);
    expect(slide.placeholderCount).toBe(1);
    expect(slide.elements.filter((element) => element.type === "placeholder")).toHaveLength(1);
    expect(design.evidence?.typography.headingFonts.find((entry) => entry.value === "Layout Cascade Font")?.sources)
      .toContainEqual({ sourceFile: layout1File, elementId: "902" });
    expect(design.evidence?.typography.fontWeights.find((entry) => entry.value === 700)?.sources)
      .toContainEqual({ sourceFile: master1File, elementId: "901" });
  });

  it("keeps explicit no-fill and no-stroke overrides while inheriting absent properties", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await appendShape(zip, master1File, placeholderShape({
      id: 911,
      name: "Master no-fill override source",
      index: 43,
      geometry: { x: 952500, y: 1905000, cx: 2857500, cy: 476250 },
      fill: "123456",
      stroke: "654321",
      text: "MASTER COLORED PLACEHOLDER",
    }));
    await appendShape(zip, master1File, placeholderShape({
      id: 912,
      name: "Master absent-fill source",
      index: 44,
      geometry: { x: 1905000, y: 1905000, cx: 3810000, cy: 476250 },
      fill: "ABCDEF",
      stroke: "FEDCBA",
      text: "MASTER SECOND PLACEHOLDER",
    }));
    await appendShape(zip, slide1File, placeholderShape({
      id: 913,
      name: "Slide explicit no-fill placeholder",
      index: 43,
      fill: null,
      stroke: null,
      text: "SLIDE EXPLICIT NO-FILL TEXT",
    }));
    await appendShape(zip, slide1File, placeholderShape({
      id: 914,
      name: "Slide absent-fill placeholder",
      index: 44,
      text: "SLIDE INHERITED-FILL TEXT",
    }));

    const design = await parsedFromZip(zip, "placeholder-no-fill-cascade.pptx");
    const slide = layoutFor(design, slide1File);
    const explicitNoFill = slide.elements.find((element) => element.id === "913");
    const absentFill = slide.elements.find((element) => element.id === "914");

    expect(explicitNoFill).toMatchObject({
      fill: undefined,
      stroke: undefined,
      text: "SLIDE EXPLICIT NO-FILL TEXT",
      sourceFile: slide1File,
    });
    expect(explicitNoFill?.inheritedFrom).toContain(master1File);
    expect(absentFill).toMatchObject({
      fill: "#ABCDEF",
      stroke: "#FEDCBA",
      text: "SLIDE INHERITED-FILL TEXT",
      sourceFile: slide1File,
    });
    expect(absentFill?.inheritedFrom).toContain(master1File);
    expect(design.evidence?.colors.flatMap((entry) => entry.sources).some((source) =>
      source.sourceFile === slide1File && source.elementId === "913",
    )).toBe(false);
    expect(design.evidence?.shapes.strokes.flatMap((entry) => entry.sources).some((source) =>
      source.sourceFile === slide1File && source.elementId === "913",
    )).toBe(false);
  });

  it("keeps line and text colors out of placeholder fill inheritance", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await appendShape(zip, master1File, placeholderShape({
      id: 915,
      name: "Master stroke-only cascade source",
      index: 45,
      fill: "112233",
      stroke: "223344",
      text: "MASTER FILL AND STROKE",
    }));
    await appendShape(zip, master1File, placeholderShape({
      id: 916,
      name: "Master no-fill cascade source",
      index: 46,
      geometry: { x: 1905000, y: 1905000, cx: 3810000, cy: 476250 },
      fill: "445566",
      stroke: "665544",
      text: "MASTER SECOND FILL AND STROKE",
    }));
    await appendShape(zip, slide1File, placeholderShape({
      id: 917,
      name: "Slide stroke-only placeholder",
      index: 45,
      stroke: "FF9900",
      text: "SLIDE STROKE ONLY TEXT",
    }));
    await appendShape(zip, slide1File, placeholderShape({
      id: 918,
      name: "Slide explicit no-fill with colored text",
      index: 46,
      fill: null,
      stroke: null,
      textColor: "00AAFF",
      text: "SLIDE COLORED TEXT WITH NO SHAPE FILL",
    }));

    const design = await parsedFromZip(zip, "placeholder-fill-scope.pptx");
    const slide = layoutFor(design, slide1File);
    const strokeOnly = slide.elements.find((element) => element.id === "917");
    const explicitNoFill = slide.elements.find((element) => element.id === "918");

    expect(strokeOnly).toMatchObject({
      fill: "#112233",
      stroke: "#FF9900",
      text: "SLIDE STROKE ONLY TEXT",
      sourceFile: slide1File,
    });
    expect(strokeOnly?.inheritedFrom).toContain(master1File);
    expect(design.evidence?.shapes.strokes.find((entry) => entry.value === "#FF9900")?.sources)
      .toContainEqual({ sourceFile: slide1File, elementId: "917" });

    expect(explicitNoFill).toMatchObject({
      fill: undefined,
      stroke: undefined,
      text: "SLIDE COLORED TEXT WITH NO SHAPE FILL",
      sourceFile: slide1File,
    });
    expect(explicitNoFill?.inheritedFrom).toContain(master1File);
    expect(design.evidence?.colors.flatMap((entry) => entry.sources).some((source) =>
      source.sourceFile === slide1File && source.elementId === "918",
    )).toBe(false);
    expect(design.evidence?.shapes.strokes.flatMap((entry) => entry.sources).some((source) =>
      source.sourceFile === slide1File && source.elementId === "918",
    )).toBe(false);
  });

  it("does not inherit through a missing slide-layout target", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await setBackground(zip, slide1File);
    await setBackground(zip, layout1File, "123456");
    const relationshipsFile = "ppt/slides/_rels/slide1.xml.rels";
    await mutatePart(zip, relationshipsFile, (xml) => {
      const mutated = xml.replace(/Target="\.\.\/slideLayouts\/slideLayout\d+\.xml"/, "Target=\"../slideLayouts/missing-layout.xml\"");
      if (mutated === xml) throw new Error("Fixture slide-layout relationship was not found");
      return mutated;
    });

    const design = await parsedFromZip(zip, "missing-layout-target.pptx");
    expect(layoutFor(design, slide1File).background).toBe("#FFFFFF");
    expect(design.warnings.some((warning) =>
      warning.includes("sourceFile=" + slide1File) && warning.includes("relationshipId=") && warning.includes("missing-layout.xml"),
    )).toBe(true);
    expect(design.evidence?.backgrounds.some((entry) => entry.value === "#123456" && entry.sources.some((source) => source.sourceFile === slide1File))).toBe(false);
  });

  it("inherits related master and layout artwork when showMasterSp is enabled", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await appendShape(zip, master1File, artworkShape(9801, "111111"));
    await appendShape(zip, layout1File, artworkShape(9802, "222222"));
    await setShowMasterShapes(zip, layout1File, "1");
    await setShowMasterShapes(zip, slide1File, "true");

    const design = await parsedFromZip(zip, "enabled-master-artwork.pptx");
    const slide = layoutFor(design, slide1File);
    expect(slide.elements.find((element) => element.sourceFile === master1File && element.name === "Artwork 9801")?.fill)
      .toBe("#111111");
    expect(slide.elements.find((element) => element.sourceFile === layout1File && element.name === "Artwork 9802")?.fill)
      .toBe("#222222");
  });

  it("hides master artwork on a layout but keeps layout artwork and placeholder style inheritance", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await appendShape(zip, master1File, artworkShape(9811, "111111"));
    await appendShape(zip, master1File, placeholderShape({
      id: 9812, name: "Master indexed slot", index: 71,
      geometry: { x: 952500, y: 1905000, cx: 2857500, cy: 476250 },
      fontFamily: "Master Hidden Artwork Font", text: "MASTER TEXT",
    }));
    await appendShape(zip, layout1File, artworkShape(9813, "222222"));
    await appendShape(zip, slide1File, placeholderShape({
      id: 9814, name: "Slide indexed slot", index: 71, text: "SLIDE TEXT",
    }));
    await setShowMasterShapes(zip, layout1File, "false");

    const design = await parsedFromZip(zip, "layout-hides-master-artwork.pptx");
    const slide = layoutFor(design, slide1File);
    expect(slide.elements.some((element) => element.name === "Artwork 9811")).toBe(false);
    expect(slide.elements.some((element) => element.name === "Artwork 9813")).toBe(true);
    expect(slide.elements.find((element) => element.id === "9814")).toMatchObject({
      fontFamily: "Master Hidden Artwork Font", text: "SLIDE TEXT", x: 100, y: 200,
    });
    expect(slide.elements.filter((element) => element.name === "Master indexed slot")).toHaveLength(0);
  });

  it("hides master artwork on one slide without hiding layout artwork or another slide's master artwork", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await appendShape(zip, master1File, artworkShape(9821, "111111"));
    await appendShape(zip, layout1File, artworkShape(9822, "222222"));
    await setShowMasterShapes(zip, slide1File, "0");

    const design = await parsedFromZip(zip, "slide-hides-master-artwork.pptx");
    const hiddenSlide = layoutFor(design, slide1File);
    expect(hiddenSlide.elements.some((element) => element.name === "Artwork 9821")).toBe(false);
    expect(hiddenSlide.elements.some((element) => element.name === "Artwork 9822")).toBe(true);
    expect(layoutFor(design, slide2File).elements.some((element) => element.name === "Artwork 9821")).toBe(true);
  });

  it("does not attach master artwork without a valid layout-master relationship", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await appendShape(zip, master1File, artworkShape(9831, "111111"));
    await mutatePart(zip, "ppt/slideLayouts/_rels/slideLayout1.xml.rels", (xml) =>
      xml.replace(/Target="\.\.\/slideMasters\/slideMaster\d+\.xml"/,
        'Target="../slideMasters/missing-master.xml"'));

    const design = await parsedFromZip(zip, "missing-master-artwork.pptx");
    expect(layoutFor(design, slide1File).elements.some((element) => element.name === "Artwork 9831")).toBe(false);
    expect(design.warnings.some((warning) => warning.includes("missing-master.xml"))).toBe(true);
  });

  it("keeps distinct indexed placeholders when an unindexed slide placeholder is present", async () => {
    const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
    await appendShape(zip, master1File, placeholderShape({
      id: 9841, name: "Master slot 72", index: 72,
      geometry: { x: 952500, y: 1905000, cx: 2857500, cy: 476250 },
      text: "MASTER 72",
    }));
    const unindexed = placeholderShape({
      id: 9842, name: "Slide unindexed slot", index: 0,
      geometry: { x: 1905000, y: 1905000, cx: 2857500, cy: 476250 },
      text: "SLIDE 0",
    }).replace(' idx="0"', "");
    await appendShape(zip, slide1File, unindexed);

    const slide = layoutFor(await parsedFromZip(zip, "distinct-indexed-placeholders.pptx"), slide1File);
    expect(slide.elements.filter((element) => element.type === "placeholder" &&
      (element.id === "9842" || element.name === "Master slot 72"))).toHaveLength(2);
    expect(slide.elements.find((element) => element.id === "9842")?.text).toBe("SLIDE 0");
    expect(slide.elements.find((element) => element.name === "Master slot 72")?.text).toBe("MASTER 72");
  });

  it("records deterministic token evidence, real relationship chains and inherited sources", async () => {
    const source = await createFixtureTemplate("bright");
    const zip = await JSZip.loadAsync(source);
    const master = zip.file("ppt/slideMasters/slideMaster1.xml");
    if (!master) throw new Error("Fixture master is missing");
    const masterXml = await master.async("string");
    const inheritedShape = [
      "<p:sp><p:nvSpPr><p:cNvPr id=\"987654\" name=\"Inherited master shape\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>",
      "<p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"952500\" cy=\"952500\"/></a:xfrm>",
      "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val=\"123456\"/></a:solidFill>",
      "<a:ln><a:noFill/></a:ln></p:spPr></p:sp>",
    ].join("");
    expect(masterXml).toContain("</p:spTree>");
    zip.file("ppt/slideMasters/slideMaster1.xml", masterXml.replace("</p:spTree>", inheritedShape + "</p:spTree>"));
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const first = await parsePptxTemplate(buffer, "bright.pptx");
    const second = await parsePptxTemplate(buffer, "bright.pptx");
    const evidence = first.evidence;

    designSystemSchema.parse(first);
    expect(evidence).toBeDefined();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const entries of [
      evidence?.colors,
      evidence?.typography.headingFonts,
      evidence?.typography.bodyFonts,
      evidence?.typography.fontSizes,
      evidence?.typography.fontWeights,
      evidence?.spacing.horizontalMargins,
      evidence?.spacing.verticalMargins,
      evidence?.spacing.gaps,
      evidence?.shapes.types,
      evidence?.shapes.radii,
      evidence?.shapes.strokes,
      evidence?.backgrounds,
    ]) {
      for (const entry of entries || []) {
        expect(entry.confidence).toBeGreaterThanOrEqual(0);
        expect(entry.confidence).toBeLessThanOrEqual(1);
        expect(entry.sources.length).toBeGreaterThan(0);
        expect(entry.sources.every((source) => source.sourceFile && (source.xmlPath || source.elementId))).toBe(true);
      }
    }

    expect(first.relationships?.some((relationship) =>
      relationship.kind === "slide-layout" && relationship.sourceFile === "ppt/slides/slide1.xml" &&
      relationship.relationshipFile === "ppt/slides/_rels/slide1.xml.rels" &&
      relationship.targetFile === "ppt/slideLayouts/slideLayout1.xml",
    )).toBe(true);
    expect(first.relationships?.some((relationship) =>
      relationship.kind === "layout-master" && relationship.sourceFile === "ppt/slideLayouts/slideLayout1.xml" &&
      relationship.relationshipFile === "ppt/slideLayouts/_rels/slideLayout1.xml.rels" &&
      relationship.targetFile === "ppt/slideMasters/slideMaster1.xml",
    )).toBe(true);
    expect(first.layouts.flatMap((layout) => layout.elements).some((element) =>
      element.inheritedFrom?.includes("ppt/slideMasters/slideMaster1.xml") &&
      element.sourceFile === "ppt/slideMasters/slideMaster1.xml",
    )).toBe(true);
  });

  it("keeps theme scheme color provenance", async () => {
    const source = await createFixtureTemplate("bright");
    const zip = await JSZip.loadAsync(source);
    const slide = zip.file("ppt/slides/slide1.xml");
    if (!slide) throw new Error("Fixture slide is missing");
    const xml = await slide.async("string");
    const mutated = xml.replace(/a:srgbClr val="251142"/, "a:schemeClr val=\"accent1\"");
    expect(mutated).not.toBe(xml);
    zip.file("ppt/slides/slide1.xml", mutated);

    const design = await parsePptxTemplate(await zip.generateAsync({ type: "nodebuffer" }), "scheme-color.pptx");
    const schemeColor = design.evidence?.colors.find((entry) => entry.value === "#4472C4");
    expect(schemeColor?.sources.some((source) => source.sourceFile === "ppt/theme/theme1.xml")).toBe(true);
    expect(design.colors).toContain("#4472C4");
  });

  it("diagnoses a missing image relationship with its source and relationship id", async () => {
    const source = await createFixtureTemplate("photo");
    const zip = await JSZip.loadAsync(source);
    const rels = zip.file("ppt/slides/_rels/slide1.xml.rels");
    if (!rels) throw new Error("Fixture slide relationships are missing");
    const xml = await rels.async("string");
    zip.file("ppt/slides/_rels/slide1.xml.rels", xml.replace("../media/image-1-1.png", "../media/missing-image.png"));

    const design = await parsePptxTemplate(await zip.generateAsync({ type: "nodebuffer" }), "missing-image.pptx");
    expect(design.warnings.some((warning) =>
      warning.includes("sourceFile=ppt/slides/slide1.xml") && warning.includes("relationshipId=rId1"),
    )).toBe(true);
    expect(design.imageAssets?.some((asset) => asset.relationshipId === "rId1" && !asset.allowed)).toBe(true);
  });
});
