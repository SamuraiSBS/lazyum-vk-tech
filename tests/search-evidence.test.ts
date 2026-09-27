import { describe, expect, it } from "vitest";
import { searchEvidence, SearchEvidenceError } from "../src/lib/skills/search-evidence";
import type { NormalizedContent } from "../src/lib/schemas";

const content: NormalizedContent = {
  brief: "Grounded evidence",
  documents: [],
  excerpts: [],
  keywords: [],
  sourceChunks: [{
    sourceId: "source-1", chunkId: "chunk-1", sourceName: "metrics.csv", mimeType: "text/csv",
    text: "42 пользователя завершили пилот", locator: "row:2,column:2", precision: "exact",
  }],
  facts: [{
    kind: "spreadsheet-cell", factId: "fact-42", sourceId: "source-1", chunkId: "chunk-1", format: "csv",
    valueType: "number", value: 42, coordinate: { row: 2, column: 2 }, locator: "row:2,column:2",
  }],
};

describe("search_evidence v1", () => {
  it("returns only the requested existing IDs and an exact excerpt", () => {
    expect(searchEvidence(content, {
      excerpts: [{ sourceChunkId: "chunk-1", factIds: ["fact-42"], excerpt: "42 пользователя завершили пилот" }],
    })).toEqual({ matches: [{ sourceChunkId: "chunk-1", factIds: ["fact-42"], excerpt: "42 пользователя завершили пилот" }] });
  });

  it("rejects unknown IDs, non-exact text, unconfirmed evidence, and arbitrary fields", () => {
    expect(() => searchEvidence(content, { sourceChunkIds: ["missing"] })).toThrow(SearchEvidenceError);
    expect(() => searchEvidence(content, { factIds: ["missing"] })).toThrow("unknown_fact_id");
    expect(() => searchEvidence(content, { excerpts: [{ sourceChunkId: "chunk-1", excerpt: "43 пользователя завершили пилот" }] })).toThrow("non_exact_excerpt");
    expect(() => searchEvidence(content, { query: "not found" })).toThrow("unconfirmed_evidence");
    expect(() => searchEvidence(content, { sourceChunkIds: ["chunk-1"], xml: "<p/>" } as never)).toThrow();
  });
});
