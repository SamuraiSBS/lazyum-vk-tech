import type { NormalizedContent, PresentationDocument, PresentationPlan, SpreadsheetFact } from "./schemas";
import type { DataVisualChartRenderInput } from "./renderer";
import { createDataVisualSpec, type DataVisualDraft } from "./skills/data-visual-spec";

/** Select one complete two-category spreadsheet series for a slide that requests a chart. */
export function createGroundedChartForGeneration(
  content: NormalizedContent,
  plan: PresentationPlan,
  baseDocument: Pick<PresentationDocument, "slides">,
): DataVisualChartRenderInput[] {
  const groups = new Map<string, SpreadsheetFact[]>();
  for (const fact of content.facts ?? []) {
    if (fact.kind !== "spreadsheet-cell" || fact.mergedRange || fact.valueType === "boolean" || fact.valueType === "date") continue;
    const key = `${fact.sourceId}\0${fact.coordinate.sheet ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const slide of plan.slides) {
    if (slide.purpose === "title" || !/(?:chart|graph|график|диаграмм)/iu.test(`${slide.title} ${slide.content.join(" ")}`)) continue;
    const groundedClaims = (slide.claims ?? []).filter((claim) => claim.grounding === "grounded" && claim.precision === "exact");
    if (!groundedClaims.length) continue;
    const renderedSlide = baseDocument.slides.find((candidate) => candidate.id === slide.id);
    if (!renderedSlide) continue;
    const slot = findFreeSlot(renderedSlide);
    if (!slot) continue;
    for (const group of groups.values()) {
      const byCoordinate = new Map(group.map((fact) => [`${fact.coordinate.row}:${fact.coordinate.column}`, fact]));
      const rows = [...new Set(group.map((fact) => fact.coordinate.row))].sort((a, b) => a - b);
      for (const headerRow of rows) {
        for (const firstColumn of [...new Set(group.filter((fact) => fact.coordinate.row === headerRow).map((fact) => fact.coordinate.column))].sort((a, b) => a - b)) {
          const categoryHeader = byCoordinate.get(`${headerRow}:${firstColumn}`);
          const seriesHeader = byCoordinate.get(`${headerRow}:${firstColumn + 1}`);
          const categories = [1, 2].map((offset) => byCoordinate.get(`${headerRow + offset}:${firstColumn}`));
          const values = [1, 2].map((offset) => byCoordinate.get(`${headerRow + offset}:${firstColumn + 1}`));
          if (!categoryHeader || categoryHeader.valueType !== "string" || !String(categoryHeader.value).trim()
            || !seriesHeader || seriesHeader.valueType !== "string" || !String(seriesHeader.value).trim()
            || categories.some((fact) => !fact || fact.valueType !== "string" || !String(fact.value).trim())
            || values.some((fact) => !fact || fact.valueType !== "number" || typeof fact.value !== "number" || !Number.isFinite(fact.value) || fact.value < 0)) continue;
          const usedFacts = [seriesHeader, ...categories, ...values] as SpreadsheetFact[];
          const claimIds = groundedClaims.filter((claim) => usedFacts.some((fact) =>
            claim.sourceRefs.factIds.includes(fact.factId) && claim.sourceRefs.sourceChunkIds.includes(fact.chunkId)))
            .map((claim) => claim.id);
          if (!usedFacts.every((fact) => groundedClaims.some((claim) => claimIds.includes(claim.id)
            && claim.sourceRefs.factIds.includes(fact.factId) && claim.sourceRefs.sourceChunkIds.includes(fact.chunkId)))) continue;
          const stringDatum = (fact: SpreadsheetFact) => ({ factId: fact.factId, sourceChunkId: fact.chunkId, value: fact.value as string });
          const numberDatum = (fact: SpreadsheetFact) => ({ factId: fact.factId, sourceChunkId: fact.chunkId, value: fact.value as number });
          const draft: Extract<DataVisualDraft, { visualType: "chart" }> = {
            version: "v1", visualType: "chart", chartType: "pie", slideId: slide.id, claimIds, title: slide.title,
            categories: categories.map((fact) => stringDatum(fact!)),
            series: [{ id: "source-series-1", label: stringDatum(seriesHeader), values: values.map((fact) => numberDatum(fact!)) }],
          };
          try {
            const spec = createDataVisualSpec(content, plan, draft);
            if (spec.visualType === "chart") return [{ spec, slot }];
          } catch {
            // Only validated source facts and plan references may reach the renderer.
          }
        }
      }
    }
  }
  return [];
}

function findFreeSlot(slide: PresentationDocument["slides"][number]) {
  const { width, height, elements } = slide.canvas;
  const w = Math.min(400, width * 0.42);
  const h = Math.min(220, height * 0.4);
  if (w < 220 || h < 150) return undefined;
  for (let y = 20; y + h <= height - 20; y += 20) {
    for (let x = 20; x + w <= width - 20; x += 20) {
      if (elements.some((element) => !isCanvasBackground(element, width, height)
        && element.x < x + w && element.x + element.w > x
        && element.y < y + h && element.y + element.h > y)) continue;
      return { id: `${slide.id}-grounded-chart`, x, y, w, h, zIndex: 90 };
    }
  }
  return undefined;
}

function isCanvasBackground(element: PresentationDocument["slides"][number]["canvas"]["elements"][number], width: number, height: number) {
  return element.type === "shape" && element.shape === "rect"
    && element.x <= 0 && element.y <= 0
    && element.x + element.w >= width && element.y + element.h >= height;
}
