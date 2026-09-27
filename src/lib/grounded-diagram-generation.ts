import type { NormalizedContent, PresentationDocument, PresentationPlan, SpreadsheetFact } from "./schemas";
import type { DataVisualDiagramRenderInput } from "./renderer";
import { auditCanvas } from "./audit";
import { materializeFactBackedDiagram } from "./data-visual-renderer";
import { createDataVisualSpec, dataVisualSpecSchema, type DataVisualDraft } from "./skills/data-visual-spec";

const MAX_NODES = 12;
const MAX_EDGES = 24;
const MAX_NODE_LABEL_LENGTH = 100;
const MAX_RELATIONSHIP_LABEL_LENGTH = 48;

/**
 * Select one exact, fact-backed relation table for a slide whose planner intent
 * is `diagram`. The supported record convention is one header row containing
 * unique `source` and `target` columns, plus an optional `relationship` column;
 * each later row with either endpoint populated is one explicit edge record.
 * Other columns are ignored. Header names are case-insensitive after trimming.
 */
export function createGroundedDiagramForGeneration(
  content: NormalizedContent,
  plan: PresentationPlan,
  baseDocument: Pick<PresentationDocument, "slides" | "designSystem">,
): DataVisualDiagramRenderInput[] {
  const chunksById = new Map(content.sourceChunks.map((chunk) => [chunk.chunkId, chunk]));
  const factsByGroup = new Map<string, SpreadsheetFact[]>();
  for (const fact of content.facts ?? []) {
    if (fact.kind !== "spreadsheet-cell") continue;
    const key = `${fact.sourceId}\0${fact.coordinate.sheet ?? ""}`;
    factsByGroup.set(key, [...(factsByGroup.get(key) ?? []), fact]);
  }

  const groups = [...factsByGroup.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
  for (const slide of plan.slides) {
    if (slide.purpose === "title" || slide.visualIntent !== "diagram") continue;
    const renderedSlide = baseDocument.slides.find((candidate) => candidate.id === slide.id);
    if (!renderedSlide) continue;
    const slots = findFreeSlots(renderedSlide);
    if (!slots.length) continue;

    const groundedClaims = (slide.claims ?? []).filter((claim) => claim.grounding === "grounded" && claim.precision === "exact");
    if (!groundedClaims.length) continue;

    for (const [, group] of groups) {
      const candidate = findRelationRecords(group);
      if (!candidate || candidate.records.length === 0) continue;
      if (candidate.records.length > MAX_EDGES) continue;

      const nodesByLabel = new Map<string, { id: string; fact: SpreadsheetFact }>();
      const requiredFacts: SpreadsheetFact[] = [];
      for (const record of candidate.records) {
        requiredFacts.push(record.source, record.target);
        if (record.relationship) requiredFacts.push(record.relationship);
        for (const fact of [record.source, record.target]) {
          const label = fact.value as string;
          if (!nodesByLabel.has(label)) nodesByLabel.set(label, { id: `node-${nodesByLabel.size + 1}`, fact });
        }
      }
      if (nodesByLabel.size < 2 || nodesByLabel.size > MAX_NODES) continue;

      const coveredFacts = new Set<string>();
      for (const fact of requiredFacts) {
        const chunk = chunksById.get(fact.chunkId);
        if (!chunk || chunk.sourceId !== fact.sourceId || chunk.precision !== "exact" || fact.formula || fact.mergedRange) {
          coveredFacts.clear();
          break;
        }
        if (!groundedClaims.some((claim) => claim.sourceRefs.factIds.includes(fact.factId)
          && claim.sourceRefs.sourceChunkIds.includes(fact.chunkId))) {
          coveredFacts.clear();
          break;
        }
        coveredFacts.add(fact.factId);
      }
      if (coveredFacts.size !== new Set(requiredFacts.map((fact) => fact.factId)).size) continue;

      const claimIds = groundedClaims.filter((claim) => requiredFacts.some((fact) =>
        claim.sourceRefs.factIds.includes(fact.factId) && claim.sourceRefs.sourceChunkIds.includes(fact.chunkId)))
        .map((claim) => claim.id);
      const nodes = [...nodesByLabel.values()].map(({ id, fact }) => ({
        id,
        label: datum(fact),
      }));
      const edges = candidate.records.map((record) => {
        const edge = {
          fromId: nodesByLabel.get(record.source.value as string)!.id,
          toId: nodesByLabel.get(record.target.value as string)!.id,
        };
        return record.relationship ? { ...edge, label: datum(record.relationship) } : edge;
      });
      const draft: Extract<DataVisualDraft, { visualType: "diagram" }> = {
        version: "v1",
        visualType: "diagram",
        slideId: slide.id,
        claimIds,
        title: slide.title,
        nodes,
        edges,
      };

      try {
        const validatedSpec = createDataVisualSpec(content, plan, draft);
        if (validatedSpec.visualType !== "diagram") continue;
        const spec = dataVisualSpecSchema.parse({
          ...validatedSpec,
          sourceRefs: {
            sourceChunkIds: [...new Set(requiredFacts.map((fact) => fact.chunkId))],
            factIds: [...new Set(requiredFacts.map((fact) => fact.factId))],
          },
        });
        if (spec.visualType !== "diagram") continue;
        for (const slot of slots) {
          try {
            const elements = materializeFactBackedDiagram(spec, slot);
            if (elements.length > 200 || renderedSlide.canvas.elements.length + elements.length > 200) continue;
            const baseErrors = auditCanvas(renderedSlide.canvas, baseDocument.designSystem)
              .filter((issue) => issue.severity === "error");
            const candidateErrors = auditCanvas({
              ...renderedSlide.canvas,
              elements: [...renderedSlide.canvas.elements, ...elements],
            }, baseDocument.designSystem).filter((issue) => issue.severity === "error");
            if (introducesAuditError(baseErrors, candidateErrors)) continue;
            return [{ spec, slot }];
          } catch {
            // A slot that cannot fit the bounded native drawing is not usable.
          }
        }
      } catch {
        // Any ambiguity, failed evidence validation, or renderer limit omits this candidate.
      }
    }
  }
  return [];
}

type RelationRecord = {
  row: number;
  source: SpreadsheetFact;
  target: SpreadsheetFact;
  relationship?: SpreadsheetFact;
};

function findRelationRecords(group: SpreadsheetFact[]): { records: RelationRecord[] } | undefined {
  const byRow = new Map<number, SpreadsheetFact[]>();
  const byCoordinate = new Map<string, SpreadsheetFact>();
  for (const fact of group) {
    const key = `${fact.coordinate.row}:${fact.coordinate.column}`;
    if (byCoordinate.has(key)) return undefined;
    byCoordinate.set(key, fact);
    byRow.set(fact.coordinate.row, [...(byRow.get(fact.coordinate.row) ?? []), fact]);
  }

  const headerCandidates: Array<{ row: number; sourceColumn: number; targetColumn: number; relationshipColumn?: number }> = [];
  for (const [row, cells] of byRow) {
    const sourceColumns = cells.filter((fact) => normalizedHeader(fact) === "source").map((fact) => fact.coordinate.column);
    const targetColumns = cells.filter((fact) => normalizedHeader(fact) === "target").map((fact) => fact.coordinate.column);
    if (sourceColumns.length === 0 || targetColumns.length === 0) continue;
    const relationshipColumns = cells.filter((fact) => normalizedHeader(fact) === "relationship").map((fact) => fact.coordinate.column);
    if (sourceColumns.length !== 1 || targetColumns.length !== 1 || relationshipColumns.length > 1) return undefined;
    headerCandidates.push({
      row,
      sourceColumn: sourceColumns[0]!,
      targetColumn: targetColumns[0]!,
      ...(relationshipColumns.length === 1 ? { relationshipColumn: relationshipColumns[0] } : {}),
    });
  }
  if (headerCandidates.length !== 1) return undefined;

  const header = headerCandidates[0]!;
  const selectedHeaderFacts = [
    byCoordinate.get(`${header.row}:${header.sourceColumn}`),
    byCoordinate.get(`${header.row}:${header.targetColumn}`),
    ...(header.relationshipColumn === undefined ? [] : [byCoordinate.get(`${header.row}:${header.relationshipColumn}`)]),
  ];
  if (selectedHeaderFacts.some((fact) => !fact || !isExactTextCell(fact, 160))) return undefined;
  const records: RelationRecord[] = [];
  for (const row of [...byRow.keys()].sort((left, right) => left - right)) {
    if (row <= header.row) continue;
    const source = byCoordinate.get(`${row}:${header.sourceColumn}`);
    const target = byCoordinate.get(`${row}:${header.targetColumn}`);
    const relationship = header.relationshipColumn === undefined
      ? undefined
      : byCoordinate.get(`${row}:${header.relationshipColumn}`);
    const sourcePopulated = hasNonBlankValue(source);
    const targetPopulated = hasNonBlankValue(target);
    const relationshipPopulated = hasNonBlankValue(relationship);
    if (!sourcePopulated && !targetPopulated && !relationshipPopulated) continue;
    if (!source || !target || !sourcePopulated || !targetPopulated) return undefined;
    if (!isExactTextCell(source, MAX_NODE_LABEL_LENGTH) || !isExactTextCell(target, MAX_NODE_LABEL_LENGTH)) return undefined;
    if (source.value === target.value) return undefined;
    if (relationshipPopulated && (!relationship || !isExactTextCell(relationship, MAX_RELATIONSHIP_LABEL_LENGTH))) return undefined;
    records.push({ row, source, target, ...(relationshipPopulated && relationship ? { relationship } : {}) });
  }
  return records.length ? { records } : undefined;
}

function normalizedHeader(fact: SpreadsheetFact) {
  if (fact.valueType !== "string" || typeof fact.value !== "string" || fact.formula || fact.mergedRange) return "";
  return fact.value.trim().toLowerCase();
}

function hasNonBlankValue(fact: SpreadsheetFact | undefined) {
  if (!fact) return false;
  return typeof fact.value === "string" ? fact.value.trim().length > 0 : true;
}

function isExactTextCell(fact: SpreadsheetFact, maxLength: number) {
  return fact.valueType === "string" && typeof fact.value === "string"
    && fact.value.trim().length > 0 && fact.value.length <= maxLength
    && !fact.formula && !fact.mergedRange;
}

function datum(fact: SpreadsheetFact) {
  return { factId: fact.factId, sourceChunkId: fact.chunkId, value: fact.value as string };
}

function findFreeSlots(slide: PresentationDocument["slides"][number]) {
  const { width, height, elements } = slide.canvas;
  const maxWidth = Math.min(440, width * 0.46);
  const maxHeight = Math.min(260, height * 0.48);
  if (maxWidth < 280 || maxHeight < 170) return [];

  const dimensions = [
    [maxWidth, maxHeight],
    [maxWidth, Math.min(maxHeight, 220)],
    [maxWidth, Math.min(maxHeight, 180)],
    [Math.min(maxWidth, 380), Math.min(maxHeight, 180)],
    [Math.min(maxWidth, 320), Math.min(maxHeight, 170)],
    [Math.min(maxWidth, 280), Math.min(maxHeight, 170)],
  ] as const;
  const slots: Array<{ id: string; x: number; y: number; w: number; h: number; zIndex: number }> = [];
  const seenDimensions = new Set<string>();
  for (const [w, h] of dimensions) {
    if (w < 280 || h < 170 || seenDimensions.has(`${w}x${h}`)) continue;
    seenDimensions.add(`${w}x${h}`);
    for (let y = 20; y + h <= height - 20; y += 10) {
      for (let x = 20; x + w <= width - 20; x += 10) {
        if (elements.some((element) => !isCanvasBackground(element, width, height)
          && element.x < x + w && element.x + element.w > x
          && element.y < y + h && element.y + element.h > y)) continue;
        slots.push({ id: `${slide.id}-grounded-diagram`, x, y, w, h, zIndex: 90 });
        break;
      }
      if (slots.at(-1)?.w === w && slots.at(-1)?.h === h) break;
    }
  }
  return slots;
}

function isCanvasBackground(element: PresentationDocument["slides"][number]["canvas"]["elements"][number], width: number, height: number) {
  return element.type === "shape" && element.shape === "rect"
    && element.x <= 0 && element.y <= 0
    && element.x + element.w >= width && element.y + element.h >= height;
}

function introducesAuditError(
  baseErrors: ReturnType<typeof auditCanvas>,
  candidateErrors: ReturnType<typeof auditCanvas>,
) {
  const remaining = new Map<string, number>();
  const keyFor = (issue: ReturnType<typeof auditCanvas>[number]) => JSON.stringify([
    issue.type,
    issue.elementId ?? "",
    issue.message,
  ]);
  for (const issue of baseErrors) {
    const key = keyFor(issue);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const issue of candidateErrors) {
    const key = keyFor(issue);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
    } else {
      return true;
    }
  }
  return false;
}
