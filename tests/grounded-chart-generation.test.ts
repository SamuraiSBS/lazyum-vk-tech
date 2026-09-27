import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createGroundedChartForGeneration } from "../src/lib/grounded-chart-generation";
import { materializeFactBackedChart } from "../src/lib/data-visual-renderer";
import type { NormalizedContent, PresentationDocument, PresentationPlan } from "../src/lib/schemas";

async function fixture() {
  const content = await normalizeContent("Pilot metrics", [{ name: "metrics.csv", type: "text/csv", buffer: Buffer.from("Period,Completed\nQ1,42\nQ2,57\n") }]);
  const refs = { factIds: (content.facts ?? []).map((fact) => fact.factId), sourceChunkIds: content.sourceChunks.map((chunk) => chunk.chunkId) };
  const plan: PresentationPlan = { title: "Pilot", planner: "deterministic", slides: [
    { id: "slide-1", purpose: "metrics", title: "Completed chart", content: ["Pilot metrics"], visualIntent: "metrics",
      claims: [{ id: "exact", text: "Pilot metrics", grounding: "grounded", precision: "exact", sourceRefs: refs }] },
    ...["problem", "context", "solution", "summary"].map((purpose, index) => ({
      id: `slide-${index + 2}`, purpose: purpose as PresentationPlan["slides"][number]["purpose"],
      title: `Slide ${index + 2}`, content: ["Pilot metrics"], visualIntent: "cards" as const,
    })),
  ] };
  const base: Pick<PresentationDocument, "slides"> = { slides: [{ id: "slide-1", order: 1, purpose: "metrics", title: "Completed chart", templateLayoutId: "test",
    canvas: { width: 960, height: 540, background: "#FFFFFF", elements: [] } }] };
  return { content, plan, base };
}

describe("grounded chart generation", () => {
  it("selects an exact, native editable chart with source-backed labels and values", async () => {
    const { content, plan, base } = await fixture();
    const result = createGroundedChartForGeneration(content, plan, base);
    expect(result).toHaveLength(1);
    const { spec, slot } = result[0]!;
    expect(spec.chartType).toBe("pie");
    expect(spec.categories.map((datum) => datum.value)).toEqual(["Q1", "Q2"]);
    expect(spec.series[0]!.label.value).toBe("Completed");
    expect(spec.series[0]!.values.map((datum) => datum.value)).toEqual([42, 57]);
    expect(spec.sourceRefs.factIds).toHaveLength(5);
    expect(materializeFactBackedChart(spec, slot)[0]).toMatchObject({ type: "chart", chartType: "pie" });
    expect(createGroundedChartForGeneration(content, plan, base)).toEqual(result);
  });

  it("preserves prior output for incomplete, unconfirmed, unsupported, and non-chart plans", async () => {
    const { content, plan, base } = await fixture();
    const missing: NormalizedContent = { ...content, facts: content.facts?.filter((fact) => fact.locator !== "row:3,column:2") };
    expect(createGroundedChartForGeneration(missing, plan, base)).toEqual([]);
    const unconfirmed: PresentationPlan = { ...plan, slides: plan.slides.map((slide) => ({ ...slide, claims: slide.claims?.map((claim) => ({ ...claim,
      sourceRefs: { ...claim.sourceRefs, factIds: claim.sourceRefs.factIds.filter((id) => id !== content.facts?.find((fact) => fact.locator === "row:2,column:2")?.factId) },
    })) })) };
    expect(createGroundedChartForGeneration(content, unconfirmed, base)).toEqual([]);
    const unsupported: PresentationPlan = { ...plan, slides: plan.slides.map((slide) => ({ ...slide, claims: slide.claims?.map((claim) => ({ ...claim, grounding: "unsupported" as const })) })) };
    expect(createGroundedChartForGeneration(content, unsupported, base)).toEqual([]);
    const noIntent: PresentationPlan = { ...plan, slides: plan.slides.map((slide) => ({ ...slide, title: "Completed metrics" })) };
    expect(createGroundedChartForGeneration(content, noIntent, base)).toEqual([]);
  });

  it("keeps clear of meaningful elements and declines a blocked canvas", async () => {
    const { content, plan, base } = await fixture();
    const shape = (id: string, x: number, y: number, w: number, h: number) => ({ id, type: "shape" as const, x, y, w, h,
      shape: "rect" as const, fill: "#eeeeee", stroke: "#eeeeee", strokeWidth: 0, radius: 0, zIndex: 10, locked: false });
    const background = shape("background", 0, 0, 960, 540);
    const panel = shape("panel", 0, 0, 450, 220);
    const withPanel: Pick<PresentationDocument, "slides"> = { slides: [{ ...base.slides[0]!, canvas: { ...base.slides[0]!.canvas, elements: [background, panel] } }] };
    const chart = createGroundedChartForGeneration(content, plan, withPanel);
    expect(chart).toHaveLength(1);
    expect(chart[0]!.slot.x).toBeGreaterThanOrEqual(450);
    const blocked: Pick<PresentationDocument, "slides"> = { slides: [{ ...base.slides[0]!, canvas: { ...base.slides[0]!.canvas,
      elements: [background, shape("left", 0, 0, 480, 540), shape("right", 480, 0, 480, 540)] } }] };
    expect(createGroundedChartForGeneration(content, plan, blocked)).toEqual([]);
  });
});
