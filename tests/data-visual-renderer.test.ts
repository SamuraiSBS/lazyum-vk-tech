import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { auditPresentation } from "../src/lib/audit";
import { createStandaloneHtml } from "../src/lib/html-export";
import { createPresentationPptx } from "../src/lib/pptx-export";
import { materializeFactBackedTable } from "../src/lib/data-visual-renderer";
import {
  createDataVisualSpec,
  type DataVisualDraft,
} from "../src/lib/skills/data-visual-spec";
import {
  presentationDocumentSchema,
  type NormalizedContent,
  type PresentationDocument,
  type PresentationPlan,
} from "../src/lib/schemas";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

describe("fact-backed table native render path", () => {
  it("renders a supplied row-label header without changing legacy empty corners", () => {
    const legacy = createDataVisualSpec(tableContent, tablePlan(), tableDraft);
    if (legacy.visualType !== "table") throw new Error("Expected table spec");
    const slot = { id: "table", x: 0, y: 0, w: 420, h: 150, zIndex: 1 };
    expect(materializeFactBackedTable(legacy, slot).rows[0]![0]!.text).toBe("");
    const withHeader = createDataVisualSpec(tableContent, tablePlan(), {
      ...tableDraft,
      rowLabelHeader: { factId: "fact-period", sourceChunkId: "chunk-period", value: "<Период>&" },
    });
    if (withHeader.visualType !== "table") throw new Error("Expected table spec");
    expect(materializeFactBackedTable(withHeader, slot).rows[0]![0]!.text).toBe("<Период>&");
  });

  it("materializes a validated table spec into semantic HTML and native PPTX", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
    const plan = tablePlan();
    const base = presentationDocumentSchema.parse(renderPresentation(design, plan));
    const slot = findFreeTableSlot(base, "metrics");
    const spec = createDataVisualSpec(tableContent, plan, tableDraft);
    if (spec.visualType !== "table") throw new Error("Expected a table data visual spec");
    const document = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const table = document.slides[0]?.canvas.elements.find((element) => element.id === slot.id);

    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("Expected a native table element");
    expect(table.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ["", "<Период>&", "Результат"],
      ["Q1", "42", "готово"],
      ["Q2", "57", "готово"],
    ]);

    const audit = auditPresentation(document);
    expect(audit.slides.flatMap((slide) => slide.issues)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
    );

    const html = createStandaloneHtml(document);
    expect(html).toContain('<table class="element element-table"');
    expect(html).toContain("&lt;Период&gt;&amp;");
    expect(html).toContain("готово");

    const archive = await JSZip.loadAsync(await createPresentationPptx(document));
    const slideXml = await archive.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toContain("<a:tbl>");
    expect(slideXml).toContain("<a:t>42</a:t>");
    expect(slideXml).toContain("<a:t>готово</a:t>");
    expect(archive.file(/^ppt\/media\//u)).toHaveLength(0);
  });
});

const tableContent: NormalizedContent = {
  brief: "Факт-backed таблица",
  documents: [],
  excerpts: [],
  keywords: [],
  sourceChunks: [
    chunk("chunk-period", "<Период>&", "row:1,column:1"),
    chunk("chunk-result", "Результат", "row:1,column:2"),
    chunk("chunk-q1", "Q1", "row:2,column:1"),
    chunk("chunk-q2", "Q2", "row:3,column:1"),
    chunk("chunk-q1-value", "42", "row:2,column:2"),
    chunk("chunk-q2-value", "57", "row:3,column:2"),
    chunk("chunk-q1-status", "готово", "row:2,column:3"),
    chunk("chunk-q2-status", "готово", "row:3,column:3"),
  ],
  facts: [
    categoricalFact("fact-period", "chunk-period", "<Период>&", "row:1,column:1"),
    categoricalFact("fact-result", "chunk-result", "Результат", "row:1,column:2"),
    categoricalFact("fact-q1", "chunk-q1", "Q1", "row:2,column:1"),
    categoricalFact("fact-q2", "chunk-q2", "Q2", "row:3,column:1"),
    numericFact("fact-q1-value", "chunk-q1-value", 42, "row:2,column:2"),
    numericFact("fact-q2-value", "chunk-q2-value", 57, "row:3,column:2"),
    categoricalFact("fact-q1-status", "chunk-q1-status", "готово", "row:2,column:3"),
    categoricalFact("fact-q2-status", "chunk-q2-status", "готово", "row:3,column:3"),
  ],
};

const tableDraft: Extract<DataVisualDraft, { visualType: "table" }> = {
  version: "v1",
  visualType: "table",
  slideId: "metrics",
  claimIds: ["metrics-grounded"],
  title: "Факт-backed метрики",
  columns: [
    { factId: "fact-period", sourceChunkId: "chunk-period", value: "<Период>&" },
    { factId: "fact-result", sourceChunkId: "chunk-result", value: "Результат" },
  ],
  rows: [
    {
      id: "q1",
      label: { factId: "fact-q1", sourceChunkId: "chunk-q1", value: "Q1" },
      cells: [
        { factId: "fact-q1-value", sourceChunkId: "chunk-q1-value", value: 42 },
        { factId: "fact-q1-status", sourceChunkId: "chunk-q1-status", value: "готово" },
      ],
    },
    {
      id: "q2",
      label: { factId: "fact-q2", sourceChunkId: "chunk-q2", value: "Q2" },
      cells: [
        { factId: "fact-q2-value", sourceChunkId: "chunk-q2-value", value: 57 },
        { factId: "fact-q2-status", sourceChunkId: "chunk-q2-status", value: "готово" },
      ],
    },
  ],
};

function tablePlan(): PresentationPlan {
  const factIds = tableContent.facts!.map((fact) => fact.factId);
  const sourceChunkIds = tableContent.sourceChunks.map((chunk) => chunk.chunkId);
  return {
    title: "Факт-backed таблица",
    planner: "deterministic",
    slides: [
      {
        id: "metrics",
        purpose: "metrics",
        title: "Факт-backed метрики",
        content: ["Проверенные значения"],
        visualIntent: "metrics",
        claims: [{
          id: "metrics-grounded",
          text: "Проверенные табличные показатели",
          grounding: "grounded",
          precision: "exact",
          sourceRefs: { sourceChunkIds, factIds },
        }],
      },
      ...["problem", "context", "solution", "summary"].map((purpose, index) => ({
        id: `slide-${index + 2}`,
        purpose: purpose as "problem" | "context" | "solution" | "summary",
        title: `Слайд ${index + 2}`,
        content: ["Контекст"],
        visualIntent: "none" as const,
        claims: [{
          id: `claim-${index + 2}`,
          text: "Контекст",
          grounding: "unsupported" as const,
          precision: "document" as const,
          sourceRefs: { sourceChunkIds: [], factIds: [] },
        }],
      })),
    ],
  };
}

function findFreeTableSlot(document: PresentationDocument, slideId: string) {
  const slide = document.slides.find((candidate) => candidate.id === slideId);
  if (!slide) throw new Error("Expected metrics slide");
  const w = 420;
  const h = 150;
  for (let y = 0; y + h <= slide.canvas.height; y += 20) {
    for (let x = 0; x + w <= slide.canvas.width; x += 20) {
      const candidate = { x, y, w, h };
      if (!slide.canvas.elements.some((element) => element.type !== "shape" && overlaps(element, candidate))) {
        return { id: "fact-backed-table", zIndex: 90, ...candidate };
      }
    }
  }
  throw new Error("Could not find a non-overlapping table slot");
}

function overlaps(element: { x: number; y: number; w: number; h: number }, box: { x: number; y: number; w: number; h: number }) {
  return element.x < box.x + box.w && element.x + element.w > box.x
    && element.y < box.y + box.h && element.y + element.h > box.y;
}

function chunk(chunkId: string, text: string, locator: string) {
  return {
    sourceId: "spreadsheet-1",
    chunkId,
    sourceName: "metrics.csv",
    mimeType: "text/csv",
    text,
    locator,
    precision: "exact" as const,
  };
}

function categoricalFact(factId: string, chunkId: string, value: string, locator: string) {
  return {
    kind: "spreadsheet-cell" as const,
    factId,
    sourceId: "spreadsheet-1",
    chunkId,
    format: "csv" as const,
    valueType: "string" as const,
    value,
    coordinate: coordinate(locator),
    locator,
  };
}

function numericFact(factId: string, chunkId: string, value: number, locator: string) {
  return {
    kind: "spreadsheet-cell" as const,
    factId,
    sourceId: "spreadsheet-1",
    chunkId,
    format: "csv" as const,
    valueType: "number" as const,
    value,
    coordinate: coordinate(locator),
    locator,
  };
}

function coordinate(locator: string) {
  return {
    row: Number(locator.match(/row:(\d+)/u)?.[1]),
    column: Number(locator.match(/column:(\d+)/u)?.[1]),
  };
}
