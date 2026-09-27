import type { NormalizedContent, PresentationDocument, PresentationPlan, SpreadsheetFact } from "./schemas";
import type { DataVisualTableRenderInput } from "./renderer";
import { createDataVisualSpec, type DataVisualDraft } from "./skills/data-visual-spec";

/** A deliberately small, complete 2-column source grid; missing cells never become display values. */
export function createGroundedTableForGeneration(
  content: NormalizedContent,
  plan: PresentationPlan,
  baseDocument: Pick<PresentationDocument, "slides">,
): DataVisualTableRenderInput[] {
  const facts = (content.facts ?? []).filter((fact): fact is SpreadsheetFact => fact.kind === "spreadsheet-cell"
    && !fact.mergedRange && fact.valueType !== "boolean" && fact.valueType !== "date");
  const groups = new Map<string, SpreadsheetFact[]>();
  for (const fact of facts) {
    const key = `${fact.sourceId}\0${fact.coordinate.sheet ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const slide of plan.slides) {
    if (slide.purpose === "title") continue;
    const groundedClaims = (slide.claims ?? []).filter((claim) => claim.grounding === "grounded" && claim.precision === "exact");
    if (!groundedClaims.length) continue;
    for (const group of groups.values()) {
      const byCoordinate = new Map(group.map((fact) => [`${fact.coordinate.row}:${fact.coordinate.column}`, fact]));
      const headerRows = [...new Set(group.map((fact) => fact.coordinate.row))].sort((a, b) => a - b);
      for (const headerRow of headerRows) {
        const nextRows = [headerRow + 1, headerRow + 2];
        const columns = [...new Set(group.filter((fact) => fact.coordinate.row === headerRow).map((fact) => fact.coordinate.column))].sort((a, b) => a - b);
        for (const firstColumn of columns) {
          const secondColumn = firstColumn + 1;
          const rowLabelHeader = byCoordinate.get(`${headerRow}:${firstColumn}`);
          if (rowLabelHeader && (rowLabelHeader.valueType !== "string" || typeof rowLabelHeader.value !== "string")) continue;
          const header = byCoordinate.get(`${headerRow}:${secondColumn}`);
          const labels = nextRows.map((row) => byCoordinate.get(`${row}:${firstColumn}`));
          const values = nextRows.map((row) => byCoordinate.get(`${row}:${secondColumn}`));
          const selected = [header, ...labels, ...values,
            ...(rowLabelHeader?.value ? [rowLabelHeader] : [])];
          if (selected.some((fact) => !fact) || !header || labels.some((fact) => !fact) || values.some((fact) => !fact)) continue;
          if (header.valueType !== "string" || labels.some((fact) => fact?.valueType !== "string")
            || values.some((fact) => fact?.valueType !== "number")) continue;
          const usedFacts = selected as SpreadsheetFact[];
          const claimIds = groundedClaims.filter((claim) => usedFacts.some((fact) =>
            claim.sourceRefs.factIds.includes(fact.factId) && claim.sourceRefs.sourceChunkIds.includes(fact.chunkId)))
            .map((claim) => claim.id);
          if (!usedFacts.every((fact) => groundedClaims.some((claim) => claimIds.includes(claim.id)
            && claim.sourceRefs.factIds.includes(fact.factId) && claim.sourceRefs.sourceChunkIds.includes(fact.chunkId)))) continue;
          const datum = (fact: SpreadsheetFact) => ({ factId: fact.factId, sourceChunkId: fact.chunkId, value: fact.value as string | number });
          const draft: Extract<DataVisualDraft, { visualType: "table" }> = {
            version: "v1", visualType: "table", slideId: slide.id, claimIds, title: slide.title,
            ...(rowLabelHeader?.value ? { rowLabelHeader: datum(rowLabelHeader) as { factId: string; sourceChunkId: string; value: string } } : {}),
            columns: [datum(header) as { factId: string; sourceChunkId: string; value: string }],
            rows: nextRows.map((_, index) => ({
              id: `source-row-${index + 1}`,
              label: datum(labels[index]!) as { factId: string; sourceChunkId: string; value: string },
              cells: [datum(values[index]!) as { factId: string; sourceChunkId: string; value: number }],
            })),
          };
          try {
            const spec = createDataVisualSpec(content, plan, draft);
            if (spec.visualType !== "table") continue;
            const renderedSlide = baseDocument.slides.find((item) => item.id === slide.id);
            if (!renderedSlide) continue;
            const slot = findFreeSlot(renderedSlide);
            if (slot) return [{ spec, slot }];
          } catch {
            // A candidate that fails the existing grounding boundary cannot enter rendering.
          }
        }
      }
    }
  }
  return [];
}

function findFreeSlot(slide: PresentationDocument["slides"][number]) {
  const { width, height, elements } = slide.canvas;
  const w = Math.min(420, width * 0.44);
  const h = Math.min(150, height * 0.28);
  if (w < 220 || h < 100) return undefined;
  for (let y = 20; y + h <= height - 20; y += 20) {
    for (let x = 20; x + w <= width - 20; x += 20) {
      if (elements.some((element) => !isCanvasBackground(element, width, height)
        && element.x < x + w && element.x + element.w > x
        && element.y < y + h && element.y + element.h > y)) continue;
      return { id: `${slide.id}-grounded-table`, x, y, w, h, zIndex: 90 };
    }
  }
  return undefined;
}

function isCanvasBackground(element: PresentationDocument["slides"][number]["canvas"]["elements"][number], width: number, height: number) {
  return element.type === "shape" && element.shape === "rect"
    && element.x <= 0 && element.y <= 0
    && element.x + element.w >= width && element.y + element.h >= height;
}
