import { z } from "zod";
import {
  normalizedContentSchema,
  presentationPlanSchema,
  type NormalizedContent,
  type PresentationPlan,
  type SpreadsheetFact,
} from "../schemas";

const factReferenceSchema = z.object({
  factId: z.string().min(1),
  sourceChunkId: z.string().min(1),
}).strict();

export const numericDatumSchema = factReferenceSchema.extend({
  value: z.number().finite(),
}).strict();
export type NumericDatum = z.infer<typeof numericDatumSchema>;

export const categoricalDatumSchema = factReferenceSchema.extend({
  value: z.string().min(1).max(50_000),
}).strict();
export type CategoricalDatum = z.infer<typeof categoricalDatumSchema>;

export const dataVisualSourceRefsSchema = z.object({
  sourceChunkIds: z.array(z.string().min(1)).min(1).max(201),
  factIds: z.array(z.string().min(1)).min(1).max(201),
}).strict();
export type DataVisualSourceRefs = z.infer<typeof dataVisualSourceRefsSchema>;

const baseDraftShape = {
  version: z.literal("v1"),
  slideId: z.string().min(1),
  claimIds: z.array(z.string().min(1)).min(1).max(20),
  title: z.string().min(1).max(160),
};

const dataVisualSeriesSchema = z.object({
  id: z.string().min(1).max(120),
  label: categoricalDatumSchema,
  values: z.array(numericDatumSchema).min(1).max(100),
}).strict();

const tableRowSchema = z.object({
  id: z.string().min(1).max(120),
  label: categoricalDatumSchema,
  cells: z.array(z.union([numericDatumSchema, categoricalDatumSchema])).min(1).max(100),
}).strict();

const diagramNodeSchema = z.object({
  id: z.string().min(1).max(120),
  label: categoricalDatumSchema,
}).strict();

const diagramEdgeSchema = z.object({
  fromId: z.string().min(1).max(120),
  toId: z.string().min(1).max(120),
  label: categoricalDatumSchema.optional(),
}).strict();

const chartDraftRawSchema = z.object({
  ...baseDraftShape,
  visualType: z.literal("chart"),
  chartType: z.enum(["bar", "line", "pie"]),
  categories: z.array(categoricalDatumSchema).min(1).max(100),
  series: z.array(dataVisualSeriesSchema).min(1).max(20),
}).strict();

const tableDraftRawSchema = z.object({
  ...baseDraftShape,
  visualType: z.literal("table"),
  rowLabelHeader: categoricalDatumSchema.optional(),
  columns: z.array(categoricalDatumSchema).min(1).max(100),
  rows: z.array(tableRowSchema).min(1).max(100),
}).strict();

const diagramDraftRawSchema = z.object({
  ...baseDraftShape,
  visualType: z.literal("diagram"),
  nodes: z.array(diagramNodeSchema).min(2).max(100),
  edges: z.array(diagramEdgeSchema).min(1).max(200),
}).strict();

type DataVisualShape = z.infer<typeof chartDraftRawSchema>
  | z.infer<typeof tableDraftRawSchema>
  | z.infer<typeof diagramDraftRawSchema>;

function validateVisualShape(draft: DataVisualShape, context: z.RefinementCtx) {
  if (draft.visualType === "chart") {
    for (const [index, series] of draft.series.entries()) {
      if (series.values.length !== draft.categories.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["series", index, "values"],
          message: "Chart series values must align with the category count",
        });
      }
    }
    if (draft.chartType === "pie" && draft.series.length !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["series"], message: "Pie charts require exactly one series" });
    }
    if (draft.chartType === "pie" && draft.series.length === 1) {
      const values = draft.series[0]!.values;
      for (const [index, datum] of values.entries()) {
        if (datum.value < 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["series", 0, "values", index, "value"],
            message: "Pie chart values must be non-negative",
          });
        }
      }
      const total = values.reduce((sum, datum) => sum + datum.value, 0);
      if (!Number.isFinite(total) || total <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["series", 0, "values"],
          message: "Pie chart values must have a finite positive sum",
        });
      }
    }
    return;
  }
  if (draft.visualType === "table") {
    for (const [index, row] of draft.rows.entries()) {
      if (row.cells.length !== draft.columns.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", index, "cells"],
          message: "Table row cells must align with the column count",
        });
      }
    }
    return;
  }
  const nodeIds = new Set(draft.nodes.map((node) => node.id));
  if (nodeIds.size !== draft.nodes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "Diagram node ids must be unique" });
  }
  for (const [index, edge] of draft.edges.entries()) {
    if (!nodeIds.has(edge.fromId) || !nodeIds.has(edge.toId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", index], message: "Diagram edges must reference existing nodes" });
    }
  }
}

export const dataVisualDraftSchema = z.discriminatedUnion("visualType", [
  chartDraftRawSchema,
  tableDraftRawSchema,
  diagramDraftRawSchema,
]).superRefine(validateVisualShape);
export type DataVisualDraft = z.infer<typeof dataVisualDraftSchema>;

const chartSpecSchema = chartDraftRawSchema.extend({ sourceRefs: dataVisualSourceRefsSchema }).strict();
const tableSpecSchema = tableDraftRawSchema.extend({ sourceRefs: dataVisualSourceRefsSchema }).strict();
const diagramSpecSchema = diagramDraftRawSchema.extend({ sourceRefs: dataVisualSourceRefsSchema }).strict();

export const dataVisualSpecSchema = z.discriminatedUnion("visualType", [
  chartSpecSchema,
  tableSpecSchema,
  diagramSpecSchema,
]).superRefine(validateVisualShape);
export type DataVisualSpec = z.infer<typeof dataVisualSpecSchema>;

export class DataVisualSpecError extends Error {
  constructor(readonly code:
    | "unknown_slide_id"
    | "unknown_claim_id"
    | "unsupported_claim"
    | "unknown_fact_id"
    | "unknown_source_chunk_id"
    | "unconfirmed_fact_source"
    | "unsupported_fact_type"
    | "fact_value_mismatch"
    | "unconfirmed_plan_reference",
  ) {
    super(code);
    this.name = "DataVisualSpecError";
  }
}

/**
 * Pure v1 boundary for semantic native data visuals. It validates only
 * fact-backed tables, charts, and diagrams; layout and rendering stay outside.
 */
export function createDataVisualSpec(
  content: NormalizedContent,
  plan: PresentationPlan,
  draft: DataVisualDraft,
): DataVisualSpec {
  const parsedContent = normalizedContentSchema.parse(content);
  const parsedPlan = presentationPlanSchema.parse(plan);
  const parsedDraft = dataVisualDraftSchema.parse(draft);
  const slide = parsedPlan.slides.find((candidate) => candidate.id === parsedDraft.slideId);
  if (!slide) throw new DataVisualSpecError("unknown_slide_id");
  if (parsedDraft.title !== slide.title) throw new DataVisualSpecError("unconfirmed_plan_reference");

  const claimsById = new Map((slide.claims ?? []).map((claim) => [claim.id, claim]));
  const selectedClaims = parsedDraft.claimIds.map((claimId) => {
    const claim = claimsById.get(claimId);
    if (!claim) throw new DataVisualSpecError("unknown_claim_id");
    if (claim.grounding !== "grounded") throw new DataVisualSpecError("unsupported_claim");
    return claim;
  });
  const chunksById = new Map(parsedContent.sourceChunks.map((chunk) => [chunk.chunkId, chunk]));
  const factsById = new Map((parsedContent.facts ?? []).map((fact) => [fact.factId, fact]));
  const refs = collectDatumReferences(parsedDraft);

  for (const datum of refs) {
    validateDatum(datum, factsById, chunksById, selectedClaims);
  }

  return dataVisualSpecSchema.parse({
    ...parsedDraft,
    sourceRefs: {
      sourceChunkIds: unique(refs.map((datum) => datum.sourceChunkId)),
      factIds: unique(refs.map((datum) => datum.factId)),
    },
  });
}

type DatumReference = NumericDatum | CategoricalDatum;

function collectDatumReferences(draft: DataVisualDraft): DatumReference[] {
  if (draft.visualType === "chart") {
    return [
      ...draft.categories,
      ...draft.series.flatMap((series) => [series.label, ...series.values]),
    ];
  }
  if (draft.visualType === "table") {
    return [
      ...(draft.rowLabelHeader ? [draft.rowLabelHeader] : []),
      ...draft.columns,
      ...draft.rows.flatMap((row) => [row.label, ...row.cells]),
    ];
  }
  return [
    ...draft.nodes.map((node) => node.label),
    ...draft.edges.flatMap((edge) => edge.label ? [edge.label] : []),
  ];
}

function validateDatum(
  datum: DatumReference,
  factsById: Map<string, z.infer<typeof normalizedContentSchema>["facts"][number]>,
  chunksById: Map<string, z.infer<typeof normalizedContentSchema>["sourceChunks"][number]>,
  claims: NonNullable<PresentationPlan["slides"][number]["claims"]>,
) {
  const fact = factsById.get(datum.factId);
  if (!fact) throw new DataVisualSpecError("unknown_fact_id");
  const chunk = chunksById.get(datum.sourceChunkId);
  if (!chunk) throw new DataVisualSpecError("unknown_source_chunk_id");
  if (fact.kind !== "spreadsheet-cell") throw new DataVisualSpecError("unsupported_fact_type");
  if (fact.chunkId !== datum.sourceChunkId || fact.sourceId !== chunk.sourceId) {
    throw new DataVisualSpecError("unconfirmed_fact_source");
  }
  if (!claims.some((claim) => claim.sourceRefs.factIds.includes(datum.factId)
    && claim.sourceRefs.sourceChunkIds.includes(datum.sourceChunkId))) {
    throw new DataVisualSpecError("unconfirmed_plan_reference");
  }
  if (typeof datum.value === "number") {
    if (fact.valueType !== "number" || fact.value !== datum.value) throw new DataVisualSpecError("fact_value_mismatch");
    return;
  }
  if (fact.valueType === "number" || String(fact.value) !== datum.value) {
    throw new DataVisualSpecError("fact_value_mismatch");
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}
