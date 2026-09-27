import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createGroundedDiagramForGeneration } from "../src/lib/grounded-diagram-generation";
import { materializeFactBackedDiagram } from "../src/lib/data-visual-renderer";
import type { NormalizedContent, PresentationDocument, PresentationPlan } from "../src/lib/schemas";

async function fixture(csv = [
  "Source,Target,Relationship,Notes",
  "Alpha,Beta,creates,Gamma",
  "Beta,Gamma,uses,Delta",
].join("\n")) {
  const content = await normalizeContent("Grounded relation records", [{ name: "relations.csv", type: "text/csv", buffer: Buffer.from(csv) }]);
  const plan = makePlan(content);
  const base: Pick<PresentationDocument, "slides" | "designSystem"> = {
    designSystem: {
      version: 1,
      sourceName: "relations.csv",
      slideSize: { width: 960, height: 540, aspectRatio: 16 / 9 },
      colors: ["#FFFFFF"],
      typography: { headingFonts: ["Arial"], bodyFonts: ["Arial"], fontSizes: [], fontWeights: [] },
      spacing: { horizontalMargins: [], verticalMargins: [], gaps: [] },
      shapes: { types: [], radii: [], strokes: [] },
      masters: [],
      layouts: [{
        id: "test", name: "Test", source: "slide", sourceFile: "relations.csv", width: 960, height: 540,
        elements: [], textSlots: 0, placeholderCount: 0, visualSlots: 0, cardCount: 0,
        composition: "blank", recurringElementIds: [],
      }],
      recurringElements: [], visualPatterns: [], warnings: [],
    },
    slides: [{
      id: "slide-2", order: 2, purpose: "workflow", title: "Process diagram", templateLayoutId: "test",
      canvas: { width: 960, height: 540, background: "#FFFFFF", elements: [] },
    }],
  };
  return { content, plan, base };
}

function makePlan(
  content: NormalizedContent,
  options: { intent?: PresentationPlan["slides"][number]["visualIntent"]; grounding?: "grounded" | "unsupported"; precision?: "exact" | "document"; omittedFactId?: string } = {},
): PresentationPlan {
  const facts = (content.facts ?? []).filter((fact) => fact.kind === "spreadsheet-cell" && fact.factId !== options.omittedFactId);
  const sourceRefs = {
    factIds: facts.map((fact) => fact.factId),
    sourceChunkIds: facts.map((fact) => fact.chunkId),
  };
  const trailingSlides: PresentationPlan["slides"] = [
    { id: "slide-3", purpose: "context", title: "Context", content: ["Context"], visualIntent: "cards" },
    { id: "slide-4", purpose: "solution", title: "Solution", content: ["Solution"], visualIntent: "cards" },
    { id: "slide-5", purpose: "summary", title: "Summary", content: ["Summary"], visualIntent: "cards" },
  ];
  return {
    title: "Process fixture",
    planner: "deterministic",
    slides: [
      { id: "slide-1", purpose: "title", title: "Title", content: ["Grounded relation records"], visualIntent: "none" },
      {
        id: "slide-2", purpose: "workflow", title: "Process diagram", content: ["Show the recorded process"],
        visualIntent: options.intent ?? "diagram",
        claims: [{
          id: "relation-evidence", text: "Recorded source relationships", grounding: options.grounding ?? "grounded",
          precision: options.precision ?? "exact",
          sourceRefs: options.grounding === "unsupported" ? { factIds: [], sourceChunkIds: [] } : sourceRefs,
        }],
      },
      ...trailingSlides,
    ],
  };
}

describe("ordinary-generation grounded diagram selection", () => {
  it("materializes only explicit source-record edges and validates every displayed label", async () => {
    const { content, plan, base } = await fixture([
      "Source,Target,Relationship,Notes",
      "Alpha,Beta,,Gamma",
      "Alpha,Gamma,creates,Delta",
      "Beta,Delta,uses,Ignored",
    ].join("\n"));
    const selected = createGroundedDiagramForGeneration(content, plan, base);
    expect(selected).toHaveLength(1);
    const { spec, slot } = selected[0]!;
    expect(spec.visualType).toBe("diagram");
    expect(spec.nodes.map((node) => node.label.value)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(spec.edges.map((edge) => [edge.fromId, edge.toId, edge.label?.value])).toEqual([
      ["node-1", "node-2", undefined],
      ["node-1", "node-3", "creates"],
      ["node-2", "node-4", "uses"],
    ]);
    const relationFacts = (content.facts ?? []).filter((fact) => fact.kind === "spreadsheet-cell"
      && fact.coordinate.row > 1 && fact.coordinate.column <= 3
      && (fact.coordinate.column !== 3 || String(fact.value).trim().length > 0));
    const unrelatedNotes = (content.facts ?? []).filter((fact) => fact.kind === "spreadsheet-cell"
      && fact.coordinate.column === 4);
    expect(spec.sourceRefs.factIds).toEqual(expect.arrayContaining(relationFacts.map((fact) => fact.factId)));
    for (const fact of unrelatedNotes) expect(spec.sourceRefs.factIds).not.toContain(fact.factId);
    const displayedFacts = [
      ...spec.nodes.map((node) => node.label),
      ...spec.edges.flatMap((edge) => edge.label ? [edge.label] : []),
    ];
    const evidenceClaim = plan.slides[1]!.claims![0]!;
    for (const datum of displayedFacts) {
      expect(evidenceClaim.sourceRefs.factIds).toContain(datum.factId);
      expect(evidenceClaim.sourceRefs.sourceChunkIds).toContain(datum.sourceChunkId);
    }
    const elements = materializeFactBackedDiagram(spec, slot);
    expect(elements.filter((element) => element.type === "shape" && element.shape === "roundRect")).toHaveLength(4);
    expect(elements.filter((element) => element.type === "shape" && element.shape === "line").length).toBeGreaterThanOrEqual(3);
    expect(createGroundedDiagramForGeneration(content, plan, base)).toEqual(selected);
  });

  it("supports the documented unlabeled-edge form and ignores title words without diagram intent", async () => {
    const { content, base } = await fixture("source,target\nAlpha,Beta\nBeta,Gamma\n");
    const unlabeled = createGroundedDiagramForGeneration(content, makePlan(content), base);
    expect(unlabeled).toHaveLength(1);
    expect(unlabeled[0]!.spec.edges.map((edge) => edge.label)).toEqual([undefined, undefined]);
    expect(createGroundedDiagramForGeneration(content, makePlan(content, { intent: "none" }), base)).toEqual([]);
  });

  it("fails closed for incomplete rows, ambiguous headers, and unsupported or unconfirmed evidence", async () => {
    const incomplete = await fixture("source,target,relationship\nAlpha,Beta,creates\n, Gamma,uses\n");
    expect(createGroundedDiagramForGeneration(incomplete.content, incomplete.plan, incomplete.base)).toEqual([]);

    const ambiguous = await fixture("source,source,target,relationship\nAlpha,Alpha,Beta,creates\n");
    expect(createGroundedDiagramForGeneration(ambiguous.content, ambiguous.plan, ambiguous.base)).toEqual([]);

    const unconfirmed = await fixture();
    const missingFactId = unconfirmed.content.facts?.find((fact) => fact.locator === "row:2,column:1")?.factId;
    expect(missingFactId).toBeDefined();
    expect(createGroundedDiagramForGeneration(unconfirmed.content,
      makePlan(unconfirmed.content, { omittedFactId: missingFactId }), unconfirmed.base)).toEqual([]);

    const unsupported = await fixture();
    expect(createGroundedDiagramForGeneration(unsupported.content,
      makePlan(unsupported.content, { grounding: "unsupported" }), unsupported.base)).toEqual([]);
    expect(createGroundedDiagramForGeneration(unsupported.content,
      makePlan(unsupported.content, { precision: "document" }), unsupported.base)).toEqual([]);
  });

  it("fails closed when native node or edge capacity is exceeded", async () => {
    const nodeRows = ["source,target", ...Array.from({ length: 12 }, (_, index) => `N${index + 1},N${index + 2}`)];
    const tooManyNodes = await fixture(nodeRows.join("\n"));
    expect(createGroundedDiagramForGeneration(tooManyNodes.content, tooManyNodes.plan, tooManyNodes.base)).toEqual([]);

    const edgeRows = ["source,target", ...Array.from({ length: 25 }, (_, index) => index % 2 === 0 ? "Alpha,Beta" : "Beta,Alpha")];
    const tooManyEdges = await fixture(edgeRows.join("\n"));
    const dataFacts = (tooManyEdges.content.facts ?? []).filter((fact) => fact.kind === "spreadsheet-cell"
      && !["row:1,column:1", "row:1,column:2"].includes(fact.locator));
    const plan = makePlan(tooManyEdges.content);
    plan.slides[1]!.claims = [{
      id: "relation-evidence", text: "Recorded source relationships", grounding: "grounded", precision: "exact",
      sourceRefs: {
        factIds: dataFacts.map((fact) => fact.factId),
        sourceChunkIds: dataFacts.map((fact) => fact.chunkId),
      },
    }];
    expect(createGroundedDiagramForGeneration(tooManyEdges.content, plan, tooManyEdges.base)).toEqual([]);
  });

  it("fails closed when a candidate slot introduces fatal renderer audit errors", async () => {
    const { content, plan, base } = await fixture();
    expect(createGroundedDiagramForGeneration(content, plan, base)).toEqual([]);
  });

  it("omits a diagram if template artwork leaves no collision-free slot", async () => {
    const { content, plan, base } = await fixture();
    const shape = (id: string, x: number, w: number) => ({
      id, type: "shape" as const, x, y: 0, w, h: 540, shape: "rect" as const,
      fill: "#EEEEEE", stroke: "#EEEEEE", strokeWidth: 0, radius: 0, zIndex: 10, locked: false,
    });
    const blocked = { ...base, slides: [{ ...base.slides[0]!, canvas: { ...base.slides[0]!.canvas,
      elements: [shape("left", 0, 480), shape("right", 480, 480)] } }] } satisfies typeof base;
    expect(createGroundedDiagramForGeneration(content, plan, blocked)).toEqual([]);
  });
});
