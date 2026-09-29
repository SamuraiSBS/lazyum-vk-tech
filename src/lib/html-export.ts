import type { CanvasElement, PresentationDocument } from "./schemas";
import { createPieChartSectorGeometry } from "./pie-chart-geometry";

export const HTML_EXPORT_CONTENT_TYPE = "text/html; charset=utf-8";

export function createStandaloneHtml(document: PresentationDocument): string {
  const slides = document.slides.map((slide) => {
    const elements = [...slide.canvas.elements]
      .sort((left, right) => left.zIndex - right.zIndex)
      .map((element) => renderElement(element))
      .join("");
    return `<section class="slide" data-slide-id="${escapeAttribute(slide.id)}" data-slide-order="${slide.order}" data-slide-width="${slide.canvas.width}" data-slide-height="${slide.canvas.height}" style="${slideStyle(slide.canvas.width, slide.canvas.height, slide.canvas.background)}"><div class="slide-elements">${elements}</div></section>`;
  }).join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(document.title)}</title>
  <style>${stylesheet()}</style>
</head>
<body><main class="deck" data-slide-count="${document.slides.length}">${slides}</main></body>
</html>`;
}

function renderElement(element: CanvasElement) {
  const attributes = `data-element-id="${escapeAttribute(element.id)}" data-element-type="${element.type}"`;
  if (element.type === "text") {
    const style = elementStyle(element) + `font-family:${cssFontFamily(element.fontFamily)};font-size:${px(element.fontSize)};font-weight:${element.fontWeight};color:${element.color};text-align:${element.align};white-space:pre-wrap;`;
    return `<div class="element element-text" ${attributes} style="${style}">${escapeHtml(element.text).replace(/\n/g, "<br>")}</div>`;
  }
  if (element.type === "image") {
    const rotationStyle = element.rotation ? `transform:rotate(${element.rotation}deg);` : "";
    const style = elementStyle(element) + "object-fit:fill;" + rotationStyle;
    if (element.dataUrl && /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/iu.test(element.dataUrl)) {
      if (element.crop) {
        const horizontal = 100 - element.crop.left - element.crop.right;
        const vertical = 100 - element.crop.top - element.crop.bottom;
        const imageStyle = `position:absolute;display:block;max-width:none;width:${px(element.w * 100 / horizontal)};height:${px(element.h * 100 / vertical)};left:${px(-element.w * element.crop.left / horizontal)};top:${px(-element.h * element.crop.top / vertical)};`;
        return `<div class="element element-image-crop" ${attributes} style="${elementStyle(element)}overflow:hidden;${rotationStyle}"><img class="element-image" src="${escapeAttribute(element.dataUrl)}" alt="${escapeAttribute(element.alt)}" draggable="false" style="${imageStyle}"></div>`;
      }
      return `<img class="element element-image" ${attributes} src="${escapeAttribute(element.dataUrl)}" alt="${escapeAttribute(element.alt)}" draggable="false" style="${style}">`;
    }
    return `<div class="element element-image element-image-empty" ${attributes} aria-label="${escapeAttribute(element.alt)}" style="${style}"></div>`;
  }
  if (element.type === "table") {
    const rows = element.rows.map((row) => `<tr>${row.map((cell) => {
      const cellStyle = `background:${cell.fill};color:${cell.color};text-align:${cell.align};border:${px(cell.border.width)} solid ${cell.border.color};`;
      return `<td style="${cellStyle}">${escapeHtml(cell.text).replace(/\n/g, "<br>")}</td>`;
    }).join("")}</tr>`).join("");
    const style = elementStyle(element)
      + `font-family:${cssFontFamily(element.fontFamily)};font-size:${px(element.fontSize)};font-weight:${element.fontWeight};`;
    return `<table class="element element-table" ${attributes} style="${style}"><tbody>${rows}</tbody></table>`;
  }
  if (element.type === "chart") {
    return renderPieChart(element, attributes);
  }
  const style = element.shape === "line"
    ? elementStyle(element) + `height:0;border:0;border-top:${px(Math.max(element.strokeWidth, 1))} solid ${element.stroke};`
    : elementStyle(element) + `background:${element.fill};border:${px(element.strokeWidth)} solid ${element.stroke};border-radius:${px(element.radius)};`;
  return `<div class="element element-shape shape-${element.shape}" ${attributes} style="${style}"></div>`;
}

function renderPieChart(element: Extract<CanvasElement, { type: "chart" }>, attributes: string) {
  const values = element.series.values.map((datum) => datum.value);
  const sectors = createPieChartSectorGeometry(values).map((sector) => {
    const category = element.categories[sector.categoryIndex]!;
    const value = values[sector.categoryIndex]!;
    const label = `${category.value}: ${value}`;
    return `<path data-category-index="${sector.categoryIndex}" d="${sector.path}" fill="${sector.color}" aria-label="${escapeAttribute(label)}"><title>${escapeHtml(label)}</title></path>`;
  }).join("");
  const description = element.categories
    .map((category, index) => `${category.value}: ${values[index]}`)
    .join("; ");
  const rows = element.categories.map((category, index) => (
    `<tr><th scope="row">${escapeHtml(category.value)}</th><td>${values[index]}</td></tr>`
  )).join("");
  const style = elementStyle(element)
    + "margin:0;padding:4px;display:flex;flex-direction:column;gap:4px;overflow:auto;background:#FFFFFF;";
  return `<figure class="element element-chart" ${attributes} style="${style}"><figcaption style="position:relative;font-weight:600;">${escapeHtml(element.title)}</figcaption><svg viewBox="0 0 100 100" role="img" aria-label="${escapeAttribute(element.title)}" style="position:relative;display:block;flex:0 0 55%;width:100%;min-height:32px;"><title>${escapeHtml(element.title)}</title><desc>${escapeHtml(description)}</desc>${sectors}</svg><table class="pie-chart-data" aria-label="Данные диаграммы" style="position:relative;flex:1 0 auto;width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px;"><caption style="position:relative;text-align:left;">Данные диаграммы</caption><thead><tr><th scope="col" style="position:relative;text-align:left;border-bottom:1px solid #D7DEE7;">Категория</th><th scope="col" style="position:relative;text-align:right;border-bottom:1px solid #D7DEE7;">Значение</th></tr></thead><tbody>${rows}</tbody></table></figure>`;
}

function slideStyle(width: number, height: number, background: string) {
  return `width:${px(width)};height:${px(height)};background:${background};`;
}

function elementStyle(element: Pick<CanvasElement, "x" | "y" | "w" | "h" | "zIndex">) {
  return `left:${px(element.x)};top:${px(element.y)};width:${px(element.w)};height:${px(element.h)};z-index:${element.zIndex};`;
}

function stylesheet() {
  return `.deck{display:flex;flex-direction:column;gap:24px;align-items:flex-start;padding:24px;background:#f4f1ec}.slide{position:relative;box-sizing:border-box;overflow:hidden;flex:none}.slide-elements{position:absolute;inset:0}.element{position:absolute;box-sizing:border-box}.element-text{margin:0;overflow:visible}.element-image{display:block;border:0}.element-image-empty{background:transparent}.element-table{border-collapse:collapse;table-layout:fixed}.element-table td{box-sizing:border-box;overflow:hidden;vertical-align:middle;white-space:pre-wrap;padding:0}.shape-line{background:transparent}`;
}

function px(value: number) {
  return `${Number(value.toFixed(4))}px`;
}

function cssFontFamily(value: string) {
  return `"${value.replace(/["\\\r\n{};()]/gu, " ")}"`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => HTML_ENTITIES[character]);
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
