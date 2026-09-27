import { describe, expect, it } from "vitest";
import {
  DataVisualRendererError,
  materializeFactBackedDiagram,
} from "../src/lib/data-visual-renderer";
import {
  createDataVisualSpec,
  dataVisualSpecSchema,
  type DataVisualDraft,
  type DataVisualSpec,
} from "../src/lib/skills/data-visual-spec";
import type { NormalizedContent, PresentationPlan } from "../src/lib/schemas";

const maximumSlot = {
  id: "diagram-maximum-slot",
  x: 80,
  y: 54,
  w: 1040,
  h: 640,
  zIndex: 40,
} as const;

describe("fact-backed native diagram boundaries", () => {
  it("deterministically renders 12 nodes and 24 edges with unique IDs inside the slot", () => {
    const spec = makeDiagramSpec(12, 24);
    const first = materializeFactBackedDiagram(spec, maximumSlot);
    const second = materializeFactBackedDiagram(spec, maximumSlot);

    expect(spec.sourceRefs.factIds).toHaveLength(36);
    expect(spec.sourceRefs.sourceChunkIds).toHaveLength(36);
    expect(first).toEqual(second);
    expect(new Set(first.map((element) => element.id)).size).toBe(first.length);
    expect(first.length).toBeLessThanOrEqual(200);
    expect(first.filter((element) => element.type === "shape"
      && element.id.includes("-node-") && element.id.endsWith("-shape"))).toHaveLength(12);
    expect(first.filter((element) => element.type === "text"
      && element.id.startsWith(`${maximumSlot.id}-edge-`)
      && element.id.endsWith("-label"))).toHaveLength(24);

    for (const element of first) {
      expect(element.x).toBeGreaterThanOrEqual(maximumSlot.x);
      expect(element.y).toBeGreaterThanOrEqual(maximumSlot.y);
      expect(element.x + element.w).toBeLessThanOrEqual(maximumSlot.x + maximumSlot.w);
      expect(element.y + element.h).toBeLessThanOrEqual(maximumSlot.y + maximumSlot.h);
    }
  });

  it("fails closed when node or edge capacity is exceeded", () => {
    const tooManyNodes = makeDiagramSpec(13, 24);
    const tooManyEdges = makeDiagramSpec(12, 25);

    expect(dataVisualSpecSchema.safeParse(tooManyNodes).success).toBe(true);
    expect(dataVisualSpecSchema.safeParse(tooManyEdges).success).toBe(true);
    expect(() => materializeFactBackedDiagram(tooManyNodes, maximumSlot))
      .toThrowError(new DataVisualRendererError("unsupported_diagram_capacity"));
    expect(() => materializeFactBackedDiagram(tooManyEdges, maximumSlot))
      .toThrowError(new DataVisualRendererError("unsupported_diagram_capacity"));
  });
});

function makeDiagramSpec(nodeCount: number, edgeCount: number): Extract<DataVisualSpec, { visualType: "diagram" }> {
  const sourceChunks: NormalizedContent["sourceChunks"] = [];
  const facts: NonNullable<NormalizedContent["facts"]> = [];
  let row = 1;

  function addLabelFact(id: string, value: string) {
    const sourceChunkId = `chunk-${id}`;
    const factId = `fact-${id}`;
    const locator = `row:${row},column:1`;
    sourceChunks.push({
      sourceId: "diagram-source",
      chunkId: sourceChunkId,
      sourceName: "diagram-fixture.csv",
      mimeType: "text/csv",
      text: value,
      locator,
      precision: "exact",
    });
    facts.push({
      kind: "spreadsheet-cell",
      factId,
      sourceId: "diagram-source",
      chunkId: sourceChunkId,
      format: "csv",
      valueType: "string",
      value,
      coordinate: { row, column: 1 },
      locator,
    });
    row += 1;
    return { factId, sourceChunkId, value };
  }

  const nodeIds = Array.from({ length: nodeCount }, (_, index) => `node-${String(index + 1).padStart(2, "0")}`);
  const nodes: Extract<DataVisualDraft, { visualType: "diagram" }>["nodes"] = nodeIds.map((id, index) => ({
    id,
    label: addLabelFact(id, `Node ${index + 1}`),
  }));
  const pairs = nodeIds.flatMap((fromId, fromIndex) => nodeIds
    .filter((_, toIndex) => toIndex !== fromIndex)
    .map((toId) => ({ fromId, toId })));
  const edges: Extract<DataVisualDraft, { visualType: "diagram" }>["edges"] = pairs
    .slice(0, edgeCount)
    .map((pair, index) => ({
      ...pair,
      label: addLabelFact(`edge-${String(index + 1).padStart(2, "0")}`, `Edge ${index + 1}`),
    }));

  const content: NormalizedContent = {
    brief: "Grounded diagram boundary fixture",
    documents: [],
    excerpts: [],
    keywords: [],
    sourceChunks,
    facts,
  };
  const sourceChunkIds = sourceChunks.map((chunk) => chunk.chunkId);
  const factIds = facts.map((fact) => fact.factId);
  const metricsSlide: PresentationPlan["slides"][number] = {
    id: "diagram-slide",
    purpose: "metrics",
    title: "Maximum supported diagram",
    content: ["Labels are grounded in spreadsheet cells."],
    visualIntent: "diagram",
    claims: [{
      id: "diagram-grounded-claim",
      text: "All diagram labels are grounded in the fixture spreadsheet.",
      grounding: "grounded",
      precision: "exact",
      sourceRefs: { sourceChunkIds, factIds },
    }],
  };
  const plan: PresentationPlan = {
    title: "Diagram renderer boundary fixture",
    planner: "deterministic",
    slides: [
      metricsSlide,
      ...(["title", "problem", "solution", "summary"] as const).map((purpose, index) => ({
        id: `supporting-slide-${index + 1}`,
        purpose,
        title: `Supporting slide ${index + 1}`,
        content: ["Supporting content."],
        visualIntent: "none" as const,
      })),
    ],
  };
  const draft: Extract<DataVisualDraft, { visualType: "diagram" }> = {
    version: "v1",
    visualType: "diagram",
    slideId: metricsSlide.id,
    claimIds: ["diagram-grounded-claim"],
    title: metricsSlide.title,
    nodes,
    edges,
  };
  const spec = createDataVisualSpec(content, plan, draft);
  if (spec.visualType !== "diagram") throw new Error("Expected a diagram spec");
  const validatedSpec = dataVisualSpecSchema.parse(spec);
  if (validatedSpec.visualType !== "diagram") throw new Error("Expected a validated diagram spec");
  return validatedSpec;
}
