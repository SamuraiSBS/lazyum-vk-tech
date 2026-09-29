import { describe, expect, it } from "vitest";
import { auditCanvas, auditPresentation } from "../src/lib/audit";
import { auditIssueKey, applyAuditDecision, isAutoFixableAuditIssue } from "../src/lib/audit-actions";
import { runExportPreflight } from "../src/lib/export-preflight";
import { renderPresentation } from "../src/lib/renderer";
import type { CanvasElement, DesignSystem, PresentationDocument, SlideCanvas } from "../src/lib/schemas";

const design: DesignSystem = {
  version: 1, sourceName: "table-test.pptx",
  slideSize: { width: 1280, height: 720, aspectRatio: 1.778 },
  colors: ["#FFFFFF", "#000000"],
  typography: { headingFonts: ["Arial"], bodyFonts: ["Arial"], fontSizes: [16], fontWeights: [400] },
  spacing: { horizontalMargins: [80], verticalMargins: [60], gaps: [16] },
  shapes: { types: ["shape"], radii: [], strokes: [] },
  masters: [], layouts: [{
    id: "layout-1", name: "Test", source: "layout", sourceFile: "test",
    width: 1280, height: 720, elements: [], textSlots: 1, placeholderCount: 0,
    visualSlots: 0, cardCount: 0, composition: "text", recurringElementIds: [],
  }], recurringElements: [], visualPatterns: [], warnings: [],
};

function table(id: string, rows: string[][]): Extract<CanvasElement, { type: "table" }> {
  return {
    id, type: "table", x: 120, y: 220, w: 500, h: 200,
    rows: rows.map((row) => row.map((text) => ({
      text, fill: "#FFFFFF", color: "#000000", align: "left",
      border: { color: "#000000", width: 1 },
    }))),
    fontFamily: "Arial", fontSize: 16, fontWeight: 400, zIndex: 1, locked: false,
  };
}

function text(id: string, value: string): Extract<CanvasElement, { type: "text" }> {
  return {
    id, type: "text", x: 120, y: 100, w: 500, h: 80, text: value,
    fontFamily: "Arial", fontSize: 16, fontWeight: 400, color: "#000000",
    align: "left", zIndex: 1, locked: false,
  };
}

function canvas(elements: CanvasElement[]): SlideCanvas {
  return { width: 1280, height: 720, background: "#FFFFFF", elements };
}

function document(): PresentationDocument {
  const result = renderPresentation(design, {
    title: "Table audit", planner: "deterministic",
    slides: Array.from({ length: 6 }, (_, index) => ({
      id: `slide-${index + 1}`, purpose: "summary" as const,
      title: `Slide ${index + 1}`, content: ["Ordinary content"], visualIntent: "none" as const,
    })),
  });
  result.slides.forEach((slide) => { slide.canvas = canvas([]); });
  return result;
}

describe("native table audit", () => {
  it("reports each placeholder with stable table and 1-based cell identity", () => {
    const issues = auditCanvas(canvas([table("metrics", [
      ["Metric", "Value", "Note"],
      ["Revenue", "TODO", ""],
      ["XXX", "42", "Вставьте текст"],
    ])]), design).filter((candidate) => candidate.type === "EMPTY_PLACEHOLDER");

    expect(issues).toEqual([
      { type: "EMPTY_PLACEHOLDER", severity: "error", elementId: "metrics", message: "Table cell at row 2, column 2 contains placeholder content" },
      { type: "EMPTY_PLACEHOLDER", severity: "error", elementId: "metrics", message: "Table cell at row 3, column 1 contains placeholder content" },
      { type: "EMPTY_PLACEHOLDER", severity: "error", elementId: "metrics", message: "Table cell at row 3, column 3 contains placeholder content" },
    ]);
    expect(new Set(issues.map((candidate) => auditIssueKey("slide-1", candidate))).size).toBe(3);
  });

  it("accepts intentional blanks and ordinary text while retaining normal text behavior", () => {
    const issues = auditCanvas(canvas([
      table("valid-table", [["Metric", "Value"], ["", "todoist and xxxylophone"]]),
      text("ordinary-placeholder", "TODO"),
    ]), design).filter((candidate) => candidate.type === "EMPTY_PLACEHOLDER");
    expect(issues).toEqual([{
      type: "EMPTY_PLACEHOLDER", severity: "error", elementId: "ordinary-placeholder",
      message: "Text contains placeholder content",
    }]);
  });

  it("detects matching table data, but not different headers, different data, or matching headers alone", () => {
    const presentation = document();
    presentation.slides.forEach((slide) => { slide.title = "Metrics"; });
    presentation.slides[0].canvas = canvas([table("first", [["Metric", "Value"], ["Revenue", "42"]])]);
    presentation.slides[1].canvas = canvas([table("second", [["Metric", "Value"], ["Revenue", "42"]])]);
    presentation.slides[2].canvas = canvas([table("third", [["Metric", "Value"], ["Revenue", "43"]])]);
    presentation.slides[3].canvas = canvas([table("different-header", [["Measure", "Amount"], ["Revenue", "42"]])]);
    presentation.slides[4].canvas = canvas([table("header-only-a", [["Metric", "Value"]])]);
    presentation.slides[5].canvas = canvas([table("header-only-b", [["Metric", "Value"]])]);

    const report = auditPresentation(presentation);
    expect(report.slides.map((slide) => slide.issues.filter((candidate) => candidate.type === "DUPLICATE_SLIDE").length))
      .toEqual([0, 1, 0, 0, 0, 0]);
    expect(report.slides[1].issues).toContainEqual(expect.objectContaining({
      type: "DUPLICATE_SLIDE", message: "Substantive content matches slide-1",
    }));
  });

  it("allows an ordinary valid table through export preflight", () => {
    const presentation = document();
    presentation.slides[0].canvas = canvas([table("valid-export-table", [["Metric", "Value"], ["Revenue", "42"]])]);
    const original = structuredClone(presentation);

    const result = runExportPreflight(presentation);
    expect(result.ok).toBe(true);
    expect(result.issues.some((candidate) => candidate.code === "EMPTY_PLACEHOLDER")).toBe(false);
    expect(presentation).toEqual(original);
  });

  it("uses the ordinary export gate and an exact ignore decision without changing table cells", () => {
    const presentation = document();
    presentation.slides[0].canvas = canvas([table("export-table", [["Metric", "Value"], ["Revenue", "TODO"]])]);
    const original = structuredClone(presentation);
    const rawIssue = auditPresentation(presentation).slides[0].issues.find((candidate) => candidate.type === "EMPTY_PLACEHOLDER");
    if (!rawIssue) throw new Error("Expected table placeholder");
    expect(isAutoFixableAuditIssue(rawIssue)).toBe(false);
    expect(applyAuditDecision(presentation, "slide-1", rawIssue, "fix")).toEqual(presentation);

    const blocked = runExportPreflight(presentation);
    expect(blocked).toMatchObject({ ok: false, code: "AUDIT_ERRORS" });
    expect(blocked.issues).toContainEqual(expect.objectContaining({
      code: "EMPTY_PLACEHOLDER", severity: "error", slideId: "slide-1", elementId: "export-table",
      message: "Table cell at row 2, column 2 contains placeholder content", ignored: false,
    }));
    expect(presentation).toEqual(original);

    presentation.auditDecisions = [{
      issueKey: auditIssueKey("slide-1", rawIssue), slideId: "slide-1", elementId: "export-table",
      action: "ignore", appliedAt: "2026-09-28T00:00:00.000Z",
    }];
    const ignored = runExportPreflight(presentation);
    expect(ignored.ok).toBe(true);
    expect(ignored.issues).toContainEqual(expect.objectContaining({
      code: "EMPTY_PLACEHOLDER", severity: "error", slideId: "slide-1", elementId: "export-table", ignored: true,
    }));
    expect(presentation.slides[0].canvas.elements[0]).toEqual(original.slides[0].canvas.elements[0]);
  });
});
