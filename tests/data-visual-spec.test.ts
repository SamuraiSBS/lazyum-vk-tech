import { describe, expect, it } from "vitest";
import {
  createDataVisualSpec,
  DataVisualSpecError,
  dataVisualDraftSchema,
  type DataVisualDraft,
} from "../src/lib/skills/data-visual-spec";
import type { NormalizedContent, PresentationPlan } from "../src/lib/schemas";

const content: NormalizedContent = {
  brief: "Пилотная метрика",
  documents: [],
  excerpts: [],
  keywords: [],
  sourceChunks: [
    chunk("chunk-q1", "Q1", "row:2,column:1"),
    chunk("chunk-q2", "Q2", "row:3,column:1"),
    chunk("chunk-completed", "Завершили", "row:1,column:2"),
    chunk("chunk-value-q1", "42", "row:2,column:2"),
    chunk("chunk-value-q2", "57", "row:3,column:2"),
  ],
  facts: [
    categoricalFact("fact-q1", "chunk-q1", "Q1", "row:2,column:1"),
    categoricalFact("fact-q2", "chunk-q2", "Q2", "row:3,column:1"),
    categoricalFact("fact-completed", "chunk-completed", "Завершили", "row:1,column:2"),
    numericFact("fact-value-q1", "chunk-value-q1", 42, "row:2,column:2"),
    numericFact("fact-value-q2", "chunk-value-q2", 57, "row:3,column:2"),
  ],
};

const draft: Extract<DataVisualDraft, { visualType: "chart" }> = {
  version: "v1",
  visualType: "chart",
  chartType: "bar",
  slideId: "metrics",
  claimIds: ["metrics-grounded"],
  title: "Динамика пилота",
  categories: [
    { factId: "fact-q1", sourceChunkId: "chunk-q1", value: "Q1" },
    { factId: "fact-q2", sourceChunkId: "chunk-q2", value: "Q2" },
  ],
  series: [{
    id: "completed",
    label: { factId: "fact-completed", sourceChunkId: "chunk-completed", value: "Завершили" },
    values: [
      { factId: "fact-value-q1", sourceChunkId: "chunk-value-q1", value: 42 },
      { factId: "fact-value-q2", sourceChunkId: "chunk-value-q2", value: 57 },
    ],
  }],
};

describe("data-visual-spec v1", () => {
  it("creates a native semantic chart spec from validated spreadsheet facts", () => {
    expect(createDataVisualSpec(content, plan(), draft)).toEqual({
      ...draft,
      sourceRefs: {
        sourceChunkIds: ["chunk-q1", "chunk-q2", "chunk-completed", "chunk-value-q1", "chunk-value-q2"],
        factIds: ["fact-q1", "fact-q2", "fact-completed", "fact-value-q1", "fact-value-q2"],
      },
    });
  });

  it("accepts grounded one-series pie data with zero slices and rejects invalid totals", () => {
    const pieDraft = { ...draft, chartType: "pie" as const };
    const grounded = createDataVisualSpec(content, plan(), pieDraft);
    expect(grounded).toMatchObject({ visualType: "chart", chartType: "pie" });

    const withZero = {
      ...pieDraft,
      series: [{
        ...pieDraft.series[0]!,
        values: [pieDraft.series[0]!.values[0]!, { ...pieDraft.series[0]!.values[1]!, value: 0 }],
      }],
    };
    expect(dataVisualDraftSchema.parse(withZero)).toMatchObject({ chartType: "pie" });
    expect(() => dataVisualDraftSchema.parse({
      ...pieDraft,
      series: [{
        ...pieDraft.series[0]!,
        values: [pieDraft.series[0]!.values[0]!, { ...pieDraft.series[0]!.values[1]!, value: -1 }],
      }],
    })).toThrow("Pie chart values must be non-negative");
    expect(() => dataVisualDraftSchema.parse({
      ...pieDraft,
      series: [{
        ...pieDraft.series[0]!,
        values: pieDraft.series[0]!.values.map((datum) => ({ ...datum, value: 0 })),
      }],
    })).toThrow("Pie chart values must have a finite positive sum");
    expect(() => dataVisualDraftSchema.parse({
      ...pieDraft,
      series: [pieDraft.series[0]!, { ...pieDraft.series[0]!, id: "second-series" }],
    })).toThrow("Pie charts require exactly one series");
  });

  it("rejects unknown fact and source chunk IDs", () => {
    expect(() => createDataVisualSpec(content, plan(), replaceDatum({ factId: "missing-fact" }))).toThrow("unknown_fact_id");
    expect(() => createDataVisualSpec(content, plan(), replaceDatum({ sourceChunkId: "missing-chunk" }))).toThrow("unknown_source_chunk_id");
  });

  it("rejects a fact/source pair that does not belong together", () => {
    expect(() => createDataVisualSpec(content, plan(), replaceDatum({ sourceChunkId: "chunk-value-q2" })))
      .toThrow("unconfirmed_fact_source");
  });

  it("rejects unsupported claims", () => {
    expect(() => createDataVisualSpec(content, plan(), { ...draft, claimIds: ["metrics-unsupported"] }))
      .toThrow(DataVisualSpecError);
    expect(() => createDataVisualSpec(content, plan(), { ...draft, claimIds: ["metrics-unsupported"] }))
      .toThrow("unsupported_claim");
  });

  it("validates an optional table row-label header as an exact grounded fact", () => {
    const header = categoricalFact("fact-period", "chunk-period", "Period", "row:1,column:1");
    const withHeader: NormalizedContent = {
      ...content,
      sourceChunks: [...content.sourceChunks, chunk("chunk-period", "Period", "row:1,column:1")],
      facts: [...(content.facts ?? []), header],
    };
    const table: Extract<DataVisualDraft, { visualType: "table" }> = {
      version: "v1", visualType: "table", slideId: "metrics", claimIds: ["metrics-grounded"],
      title: "Динамика пилота",
      rowLabelHeader: { factId: header.factId, sourceChunkId: header.chunkId, value: "Period" },
      columns: [draft.series[0]!.label],
      rows: [
        { id: "q1", label: draft.categories[0]!, cells: [draft.series[0]!.values[0]!] },
        { id: "q2", label: draft.categories[1]!, cells: [draft.series[0]!.values[1]!] },
      ],
    };
    const groundedPlan = plan();
    groundedPlan.slides[0]!.claims![0]!.sourceRefs.factIds.push(header.factId);
    groundedPlan.slides[0]!.claims![0]!.sourceRefs.sourceChunkIds.push(header.chunkId);
    const spec = createDataVisualSpec(withHeader, groundedPlan, table);
    expect(spec.sourceRefs.factIds[0]).toBe(header.factId);
    expect(spec.visualType === "table" && spec.rowLabelHeader?.value).toBe("Period");
    expect(() => createDataVisualSpec(withHeader, groundedPlan, {
      ...table, rowLabelHeader: { ...table.rowLabelHeader!, value: "Invented" },
    })).toThrow("fact_value_mismatch");
    expect(() => createDataVisualSpec(withHeader, plan(), table)).toThrow("unconfirmed_plan_reference");
    expect(() => createDataVisualSpec(withHeader, groundedPlan, {
      ...table, rowLabelHeader: { ...table.rowLabelHeader!, sourceChunkId: "chunk-q1" },
    })).toThrow("unconfirmed_fact_source");
  });

  it("rejects geometry, PPTX, XML, and arbitrary fields", () => {
    expect(() => createDataVisualSpec(content, plan(), { ...draft, x: 10 } as never)).toThrow();
    expect(() => createDataVisualSpec(content, plan(), { ...draft, pptxCommand: "addChart" } as never)).toThrow();
    expect(() => createDataVisualSpec(content, plan(), { ...draft, xml: "<c:chart/>" } as never)).toThrow();
    expect(() => createDataVisualSpec(content, plan(), {
      ...draft,
      series: [{ ...draft.series[0]!, values: [{ ...draft.series[0]!.values[0]!, width: 100 }, draft.series[0]!.values[1]! ] }],
    } as never)).toThrow();
  });

  it("is stable for repeated calls", () => {
    expect(createDataVisualSpec(content, plan(), draft)).toEqual(createDataVisualSpec(content, plan(), draft));
  });
});

function replaceDatum(change: Partial<(typeof draft.series)[number]["values"][number]>): Extract<DataVisualDraft, { visualType: "chart" }> {
  return {
    ...draft,
    series: [{
      ...draft.series[0]!,
      values: [{ ...draft.series[0]!.values[0]!, ...change }, draft.series[0]!.values[1]!],
    }],
  };
}

function plan(): PresentationPlan {
  const allFactIds = content.facts!.map((fact) => fact.factId);
  const allChunkIds = content.sourceChunks.map((source) => source.chunkId);
  return {
    title: "Пилот",
    planner: "deterministic",
    slides: [
      {
        id: "metrics", purpose: "metrics", title: "Динамика пилота", content: ["Проверенные показатели"], visualIntent: "metrics",
        claims: [
          { id: "metrics-grounded", text: "Показатели пилота", grounding: "grounded", precision: "exact", sourceRefs: { sourceChunkIds: allChunkIds, factIds: allFactIds } },
          { id: "metrics-unsupported", text: "Непроверяемый вывод", grounding: "unsupported", precision: "document", sourceRefs: { sourceChunkIds: [], factIds: [] } },
        ],
      },
      ...["problem", "context", "solution", "summary"].map((purpose, index) => ({
        id: `slide-${index + 2}`,
        purpose: purpose as "problem" | "context" | "solution" | "summary",
        title: `Слайд ${index + 2}`,
        content: ["Контекст"],
        visualIntent: "none" as const,
        claims: [{ id: `claim-${index + 2}`, text: "Контекст", grounding: "unsupported" as const, precision: "document" as const, sourceRefs: { sourceChunkIds: [], factIds: [] } }],
      })),
    ],
  };
}

function chunk(chunkId: string, text: string, locator: string) {
  return {
    sourceId: "spreadsheet-1", chunkId, sourceName: "metrics.csv", mimeType: "text/csv", text, locator, precision: "exact" as const,
  };
}

function categoricalFact(factId: string, chunkId: string, value: string, locator: string) {
  const row = Number(locator.match(/row:(\d+)/u)?.[1]);
  const column = Number(locator.match(/column:(\d+)/u)?.[1]);
  return {
    kind: "spreadsheet-cell" as const, factId, sourceId: "spreadsheet-1", chunkId, format: "csv" as const,
    valueType: "string" as const, value, coordinate: { row, column }, locator,
  };
}

function numericFact(factId: string, chunkId: string, value: number, locator: string) {
  const row = Number(locator.match(/row:(\d+)/u)?.[1]);
  const column = Number(locator.match(/column:(\d+)/u)?.[1]);
  return {
    kind: "spreadsheet-cell" as const, factId, sourceId: "spreadsheet-1", chunkId, format: "csv" as const,
    valueType: "number" as const, value, coordinate: { row, column }, locator,
  };
}
