import { createRequire } from "node:module";
import JSZip from "jszip";
import { resolveTextFont, type TextFontRole } from "./renderer";
import type { CanvasElement, DesignSystem, PresentationDocument } from "./schemas";
import { pieChartColors } from "./pie-chart-geometry";

const require = createRequire(import.meta.url);
const PptxGenJS = require("@studydeck/pptxgenjs") as new () => any;
export async function createPresentationPptx(document: PresentationDocument): Promise<Buffer> {
  const pptx = new PptxGenJS();
  const layout = {
    name: "VK_TEMPLATE_" + document.designSystem.slideSize.width + "x" + document.designSystem.slideSize.height,
    width: document.designSystem.slideSize.width / 96,
    height: document.designSystem.slideSize.height / 96,
  };
  pptx.defineLayout(layout);
  pptx.layout = layout.name;
  pptx.author = "Lazyum VK Tech Hackathon MVP";
  pptx.company = "Lazyum";
  pptx.subject = "Template-driven editable presentation";
  pptx.title = document.title;
  pptx.lang = "ru-RU";
  pptx.theme = {
    headFontFace: resolveTextFont("heading", document.designSystem),
    bodyFontFace: resolveTextFont("body", document.designSystem),
    lang: "ru-RU",
  };

  for (const rendered of document.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: pptxColor(rendered.canvas.background) };
    [...rendered.canvas.elements]
      .sort((left, right) => left.zIndex - right.zIndex)
      .forEach((element) => renderNativeElement(pptx, slide, element, document.designSystem));
    slide.addNotes("Generated from template layout " + rendered.templateLayoutId);
  }
  const output = await pptx.write({ outputType: "nodebuffer" }) as Buffer;
  const hasCrops = document.slides.some((slide) => slide.canvas.elements.some((element) => element.type === "image" && element.crop && element.dataUrl));
  const hasChartZeros = document.slides.some((slide) => slide.canvas.elements.some((element) => element.type === "chart"
    && element.series.values.some((datum) => datum.value === 0)));
  if (!hasCrops && !hasChartZeros) return output;
  // Patch both OOXML features in one archive. Repacking a second full PPTX
  // retains another copy of every embedded image during Visual export.
  const archive = await JSZip.loadAsync(output);
  if (hasChartZeros) await preservePieChartZeroValues(archive, document);
  if (hasCrops) await preserveImageCrops(archive, document);
  return archive.generateAsync({ type: "nodebuffer", streamFiles: true });
}

async function preserveImageCrops(archive: JSZip, document: PresentationDocument): Promise<void> {
  for (const [slideIndex, rendered] of document.slides.entries()) {
    const images = [...rendered.canvas.elements]
      .sort((left, right) => left.zIndex - right.zIndex)
      .filter((element): element is Extract<CanvasElement, { type: "image" }> => element.type === "image" && Boolean(element.dataUrl));
    if (!images.some((image) => image.crop)) continue;
    const path = `ppt/slides/slide${slideIndex + 1}.xml`;
    const slideFile = archive.file(path);
    if (!slideFile) throw new Error(`PPTX is missing slide ${slideIndex + 1}`);
    const xml = await slideFile.async("string");
    let imageIndex = 0;
    const updated = xml.replace(/<p:pic\b[\s\S]*?<\/p:pic>/gu, (picture) => {
      const image = images[imageIndex++];
      if (!image?.crop) return picture;
      const crop = image.crop;
      const srcRect = `<a:srcRect l="${cropToOoxml(crop.left)}" t="${cropToOoxml(crop.top)}" r="${cropToOoxml(crop.right)}" b="${cropToOoxml(crop.bottom)}"/>`;
      let cropWritten = false;
      const patched = picture.replace(/<p:blipFill\b[\s\S]*?<\/p:blipFill>/u, (blipFill) => {
        if (!/<a:blip\b[^>]*\/>|<a:blip\b[^>]*>[\s\S]*?<\/a:blip>/u.test(blipFill)) return blipFill;
        if (/<a:srcRect\b[^>]*\/>/u.test(blipFill)) {
          return blipFill.replace(/<a:srcRect\b[^>]*\/>/u, () => {
            cropWritten = true;
            return srcRect;
          });
        }
        return blipFill.replace(/<a:blip\b[^>]*\/>|<a:blip\b[^>]*>[\s\S]*?<\/a:blip>/u, (blip) => {
          cropWritten = true;
          return blip + srcRect;
        });
      });
      if (!cropWritten) throw new Error(`PPTX image ${image.id} has no writable native image crop`);
      return patched;
    });
    if (imageIndex !== images.length) {
      throw new Error(`PPTX slide ${slideIndex + 1} has ${imageIndex} native images, expected ${images.length}`);
    }
    archive.file(path, updated);
  }
}

function cropToOoxml(percent: number): number {
  return Math.round(percent * 1000);
}

async function preservePieChartZeroValues(archive: JSZip, document: PresentationDocument): Promise<void> {
  const pieCharts = document.slides.flatMap((slide) => [...slide.canvas.elements]
    .sort((left, right) => left.zIndex - right.zIndex)
    .filter((element): element is Extract<CanvasElement, { type: "chart" }> => element.type === "chart"));
  const chartParts = Object.keys(archive.files)
    .filter((path) => /^ppt\/charts\/chart\d+\.xml$/u.test(path))
    .sort((left, right) => Number(left.match(/chart(\d+)\.xml$/u)?.[1]) - Number(right.match(/chart(\d+)\.xml$/u)?.[1]));
  if (chartParts.length !== pieCharts.length) {
    throw new Error("PPTX pie chart parts do not match the semantic chart elements");
  }

  for (const [chartIndex, chart] of pieCharts.entries()) {
    const zeroIndices = chart.series.values.flatMap((datum, index) => datum.value === 0 ? [index] : []);
    if (zeroIndices.length === 0) continue;

    const chartFileName = chartParts[chartIndex]!.split("/").at(-1)!;
    const relationshipPath = `ppt/charts/_rels/${chartFileName}.rels`;
    const relationshipXml = await archive.file(relationshipPath)?.async("string");
    const workbookTarget = relationshipXml?.match(/<Relationship[^>]*Type="[^"]*\/package"[^>]*Target="([^"]+)"/u)?.[1];
    if (!workbookTarget) throw new Error(`PPTX pie chart is missing its embedded workbook relationship: ${chartFileName}`);
    const workbookPath = `ppt/${workbookTarget.replace(/^\.\.\//u, "")}`;
    const workbookFile = archive.file(workbookPath);
    if (!workbookFile) throw new Error(`PPTX pie chart is missing its embedded workbook: ${workbookPath}`);

    const workbook = await JSZip.loadAsync(await workbookFile.async("nodebuffer"));
    const worksheetFile = workbook.file("xl/worksheets/sheet1.xml");
    if (!worksheetFile) throw new Error(`PPTX pie chart workbook has no first worksheet: ${workbookPath}`);
    let worksheetXml = await worksheetFile.async("string");
    // PptxGenJS preserves zero in chart caches but leaves empty cells in its embedded XLSX.
    for (const zeroIndex of zeroIndices) {
      const cellRef = `B${zeroIndex + 2}`;
      const cellPattern = new RegExp(`<c\\b([^>]*\\br="${cellRef}"[^>]*)>(?:\\s*<v>[^<]*<\\/v>)?\\s*<\\/c>`, "u");
      let restored = false;
      worksheetXml = worksheetXml.replace(cellPattern, (_cell, attributes: string) => {
        restored = true;
        return `<c${attributes}><v>0</v></c>`;
      });
      if (!restored) throw new Error(`PPTX pie chart workbook is missing numeric cell ${cellRef}: ${workbookPath}`);
    }
    workbook.file("xl/worksheets/sheet1.xml", worksheetXml);
    archive.file(workbookPath, await workbook.generateAsync({ type: "nodebuffer" }));
  }

}

function renderNativeElement(pptx: any, slide: any, element: CanvasElement, designSystem: DesignSystem) {
  if (element.type === "text") {
    slide.addText(element.text, {
      ...canvasBox(element),
      fontFace: resolveTextFont(textFontRole(element), designSystem, element.fontFamily),
      fontSize: pixelsToPoints(element.fontSize),
      bold: element.fontWeight >= 600,
      color: pptxColor(element.color),
      align: element.align,
      valign: "mid",
      margin: 0,
      breakLine: true,
      fit: "shrink",
    });
    return;
  }
  if (element.type === "image") {
    if (element.dataUrl) slide.addImage({ data: element.dataUrl, ...canvasBox(element),
      ...(element.rotation ? { rotate: element.rotation } : {}) });
    return;
  }
  if (element.type === "chart") {
    slide.addChart("pie", [{
      name: element.series.label.value,
      labels: element.categories.map((category) => category.value),
      values: element.series.values.map((datum) => datum.value),
    }], {
      ...canvasBox(element),
      chartColors: pieChartColors(element.categories.length).map(pptxColor),
      showLegend: true,
      showTitle: true,
      title: element.title,
      titleFontFace: resolveTextFont("heading", designSystem),
      titleFontSize: 16,
      showPercent: true,
      showLabel: false,
      showValue: false,
    });
    return;
  }
  if (element.type === "table") {
    const borderFor = (border: { color: string; width: number }) => ({
      color: pptxColor(border.color),
      width: pixelsToPoints(border.width),
    });
    slide.addTable(element.rows.map((row) => row.map((cell) => ({
      text: cell.text,
      options: {
        fill: { color: pptxColor(cell.fill) },
        color: pptxColor(cell.color),
        align: cell.align,
        valign: "mid",
        border: borderFor(cell.border),
        margin: 0,
        fontFace: resolveTextFont("body", designSystem, element.fontFamily),
        fontSize: pixelsToPoints(element.fontSize),
        bold: element.fontWeight >= 600,
      },
    }))), {
      ...canvasBox(element),
      colW: Array.from({ length: element.rows[0]?.length ?? 0 }, () => element.w / 96 / (element.rows[0]?.length ?? 1)),
      rowH: Array.from({ length: element.rows.length }, () => element.h / 96 / element.rows.length),
      margin: 0,
      autoPage: false,
    });
    return;
  }
  const shape = element.shape === "ellipse"
    ? pptx.ShapeType.ellipse
    : element.shape === "roundRect"
      ? pptx.ShapeType.roundRect
      : element.shape === "line"
        ? pptx.ShapeType.line
        : pptx.ShapeType.rect;
  const options: Record<string, unknown> = {
    ...canvasBox(element),
    line: {
      color: pptxColor(element.stroke),
      width: pixelsToPoints(element.strokeWidth || 0),
    },
  };
  if (element.shape !== "line") {
    options.fill = { color: pptxColor(element.fill) };
    if (element.shape === "roundRect" && element.radius) options.radius = pixelsToPoints(element.radius);
  }
  slide.addShape(shape, options);
}

function textFontRole(element: CanvasElement): TextFontRole {
  return element.type === "text" && /-text-0$/u.test(element.id) ? "heading" : "body";
}

function canvasBox(element: Pick<CanvasElement, "x" | "y" | "w" | "h">) {
  return {
    x: element.x / 96,
    y: element.y / 96,
    w: element.w / 96,
    h: element.h / 96,
  };
}

function pixelsToPoints(value: number) {
  return value * 72 / 96;
}

function pptxColor(value: string) {
  return value.replace(/^#/, "").toUpperCase();
}
