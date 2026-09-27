import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createGroundedTableForGeneration } from "../src/lib/grounded-table-generation";
import { materializeFactBackedTable } from "../src/lib/data-visual-renderer";
import type { NormalizedContent, PresentationDocument, PresentationPlan } from "../src/lib/schemas";

const spreadsheet = Buffer.from("Period,Completed\nQ1,42\nQ2,57\n", "utf8");

async function fixture() {
  const content = await normalizeContent("Показатели пилота", [{ name: "metrics.csv", type: "text/csv", buffer: spreadsheet }]);
  const facts = content.facts ?? [];
  const sourceRefs = { factIds: facts.map((fact) => fact.factId), sourceChunkIds: content.sourceChunks.map((chunk) => chunk.chunkId) };
  const slides: PresentationPlan["slides"] = ["metrics", "problem", "context", "solution", "summary"].map((purpose, index) => ({
    id: `slide-${index + 1}`, purpose: purpose as PresentationPlan["slides"][number]["purpose"],
    title: `Слайд ${index + 1}`, content: ["Показатели пилота"], visualIntent: "metrics",
    claims: index === 0 ? [{ id: "grounded", text: "Показатели пилота", grounding: "grounded", precision: "exact", sourceRefs }] : [],
  }));
  const plan: PresentationPlan = { title: "Пилот", planner: "deterministic", slides };
  const base = { slides: [{
    id: "slide-1", order: 1, purpose: "metrics" as const, title: "Слайд 1", templateLayoutId: "test",
    canvas: { width: 960, height: 540, background: "#FFFFFF", elements: [] },
  }] } satisfies Pick<PresentationDocument, "slides">;
  return { content, plan, base };
}

describe("ordinary-generation grounded table selection", () => {
  it("uses only the complete source grid and preserves every fact reference", async () => {
    const { content, plan, base } = await fixture();
    const selected = createGroundedTableForGeneration(content, plan, base);
    expect(selected).toHaveLength(1);
    const input = selected[0]!;
    expect(input.spec.sourceRefs.factIds).toEqual(expect.arrayContaining((content.facts ?? [])
      .filter((fact) => ["row:1,column:1", "row:1,column:2", "row:2,column:1", "row:2,column:2", "row:3,column:1", "row:3,column:2"].includes(fact.locator))
      .map((fact) => fact.factId)));
    expect(input.spec.visualType === "table" && input.spec.rowLabelHeader).toMatchObject({ value: "Period" });
    const table = materializeFactBackedTable(input.spec, input.slot);
    expect(table.type).toBe("table");
    expect(table.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ["Period", "Completed"], ["Q1", "42"], ["Q2", "57"],
    ]);
    expect(createGroundedTableForGeneration(content, plan, base)).toEqual(selected);
  });

  it("keeps an empty corner cell and refuses to hide an unconfirmed nonempty header", async () => {
    const { content, plan, base } = await fixture();
    const emptyContent: NormalizedContent = { ...content, facts: content.facts?.map((fact) =>
      fact.locator === "row:1,column:1" && fact.kind === "spreadsheet-cell"
        ? { ...fact, value: "" } : fact) };
    const emptyTable = createGroundedTableForGeneration(emptyContent, plan, base)[0];
    expect(emptyTable).toBeDefined();
    expect(emptyTable!.spec.visualType === "table" && emptyTable!.spec.rowLabelHeader).toBeUndefined();
    expect(materializeFactBackedTable(emptyTable!.spec, emptyTable!.slot).rows[0]![0]!.text).toBe("");

    const header = content.facts?.find((fact) => fact.locator === "row:1,column:1");
    expect(header).toBeDefined();
    const unconfirmed: PresentationPlan = { ...plan, slides: plan.slides.map((slide, index) => index === 0
      ? { ...slide, claims: slide.claims?.map((claim) => ({ ...claim,
        sourceRefs: { ...claim.sourceRefs, factIds: claim.sourceRefs.factIds.filter((id) => id !== header!.factId) },
      })) } : slide) };
    expect(createGroundedTableForGeneration(content, unconfirmed, base)).toEqual([]);
  });

  it("skips missing cells, unsupported claims, and absent spreadsheet material", async () => {
    const { content, plan, base } = await fixture();
    const missingCell: NormalizedContent = { ...content, facts: content.facts?.filter((fact) => fact.locator !== "row:3,column:2") };
    expect(createGroundedTableForGeneration(missingCell, plan, base)).toEqual([]);
    const unsupported: PresentationPlan = { ...plan, slides: plan.slides.map((slide, index) => index === 0
      ? { ...slide, claims: [{ ...slide.claims![0]!, grounding: "unsupported", sourceRefs: { factIds: [], sourceChunkIds: [] } }] }
      : slide) };
    expect(createGroundedTableForGeneration(content, unsupported, base)).toEqual([]);
    expect(createGroundedTableForGeneration({ ...content, facts: [], sourceChunks: [] }, plan, base)).toEqual([]);
  });

  it("keeps the table off template artwork and skips slides without a free slot", async () => {
    const { content, plan, base } = await fixture();
    const shape = (id: string, x: number, y: number, w: number, h: number) => ({
      id, type: "shape" as const, x, y, w, h, shape: "rect" as const,
      fill: "#eeeeee", stroke: "#eeeeee", strokeWidth: 0, radius: 0, zIndex: 10, locked: false,
    });
    const background = shape("background", 0, 0, 960, 540);
    const panel = shape("meaningful-panel", 0, 0, 450, 180);
    const withPanel: Pick<PresentationDocument, "slides"> = {
      slides: [{ ...base.slides[0]!, canvas: { ...base.slides[0]!.canvas, elements: [background, panel] } }],
    };
    const selected = createGroundedTableForGeneration(content, plan, withPanel);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.slot.x).toBeGreaterThanOrEqual(450);
    expect(selected[0]!.slot.y).toBe(20);

    const withoutSpace: Pick<PresentationDocument, "slides"> = {
      slides: [{ ...base.slides[0]!, canvas: { ...base.slides[0]!.canvas, elements: [
        background, shape("left-artwork", 0, 0, 480, 540), shape("right-artwork", 480, 0, 480, 540),
      ] } }],
    };
    expect(createGroundedTableForGeneration(content, plan, withoutSpace)).toEqual([]);
  });
});
