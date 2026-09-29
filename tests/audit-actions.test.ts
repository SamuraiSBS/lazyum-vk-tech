import { beforeAll, describe, expect, it } from "vitest";
import {
  applyAllSafeAuditFixes,
  applyAuditDecision,
  auditIssueKey,
  effectiveAuditPresentation,
  isAutoFixableAuditIssue,
} from "../src/lib/audit-actions";
import { auditPresentation } from "../src/lib/audit";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema, type AuditIssue, type CanvasElement, type PresentationDocument } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

let baseDocument: PresentationDocument;

beforeAll(async () => {
  const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
  const content = await normalizeContent("Аудит презентации", [{
    name: "materials.txt",
    type: "text/plain",
    buffer: Buffer.from("Детерминированный аудит помогает подготовить презентацию."),
  }]);
  baseDocument = presentationDocumentSchema.parse(renderPresentation(design, await createPresentationPlan(content, 5)));
});

function issueFor(document: PresentationDocument, type: AuditIssue["type"]): { slideId: string; issue: AuditIssue } {
  for (const slide of auditPresentation(document).slides) {
    const issue = slide.issues.find((candidate) => candidate.type === type);
    if (issue) return { slideId: slide.slideId, issue };
  }
  throw new Error(`Expected ${type} audit issue`);
}

function withOutsideElement() {
  const document = structuredClone(baseDocument);
  document.slides[0].canvas.elements[0].x = -20;
  return document;
}

function withUnsupportedFont() {
  const document = structuredClone(baseDocument);
  const text = document.slides[0].canvas.elements.find((element) => element.type === "text");
  if (!text || text.type !== "text") throw new Error("Fixture has no text element");
  text.fontFamily = "Unapproved Typeface";
  return document;
}

function withLowContrastText(options: {
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  palette?: string[];
  layers?: CanvasElement[];
} = {}) {
  const document = structuredClone(baseDocument);
  document.designSystem.colors = options.palette || ["#777777", "#959595", "#000000"];
  document.slides[0].canvas = {
    width: 1280,
    height: 720,
    background: "#FFFFFF",
    elements: [
      ...(options.layers || []),
      {
        id: "contrast-text", type: "text", x: 100, y: 120, w: 320, h: 80,
        text: "Contrast check", fontFamily: "Arial", fontSize: options.fontSize || 16,
        fontWeight: options.fontWeight || 400, color: options.color || "#777777",
        align: "left", zIndex: 10, locked: false,
      },
    ],
  };
  return document;
}

function coveringShape(fill: string): CanvasElement {
  return {
    id: "background-shape", type: "shape", x: 80, y: 100, w: 400, h: 140,
    shape: "rect", fill, stroke: fill, strokeWidth: 0, radius: 0,
    zIndex: 5, locked: false,
  };
}

function withOverflow(options: { h?: number; y?: number; obstacle?: boolean } = {}) {
  const document = structuredClone(baseDocument);
  document.slides[0].canvas = {
    width: 1280, height: 720, background: "#FFFFFF",
    elements: [
      {
        id: "overflow-text", type: "text", x: 100, y: options.y ?? 100, w: 200, h: options.h ?? 60,
        text: "A sentence that must wrap into several lines and remain editable after fixing",
        fontFamily: "Arial", fontSize: 28, fontWeight: 400, color: "#000000",
        align: "left", zIndex: 1, locked: false,
      },
      ...(options.obstacle ? [{ id: "neighbor", type: "shape" as const, x: 100, y: 185, w: 200, h: 90,
        shape: "rect" as const, fill: "#000000", stroke: "#000000", strokeWidth: 0, radius: 0, zIndex: 0, locked: false }] : []),
    ],
  };
  return document;
}

describe("audit actions", () => {
  it("expands a unique editable overflow box and preserves text and neighboring elements", () => {
    const document = withOverflow();
    const { slideId, issue } = issueFor(document, "TEXT_OVERFLOW");
    expect(isAutoFixableAuditIssue(issue)).toBe(true);
    const fixed = applyAuditDecision(document, slideId, issue, "fix");
    const before = document.slides[0].canvas.elements[0];
    const after = fixed.slides[0].canvas.elements[0];
    expect(after).toEqual({ ...before, h: expect.any(Number) });
    expect(after.h).toBeGreaterThan(before.h);
    expect(fixed.auditDecisions).toEqual(expect.arrayContaining([expect.objectContaining({ action: "fix", issueKey: auditIssueKey(slideId, issue) })]));
    expect(auditPresentation(fixed).slides[0].issues.some((finding) => finding.type === "TEXT_OVERFLOW")).toBe(false);
    expect(applyAuditDecision(fixed, slideId, issue, "fix")).toBe(fixed);
  });

  it("reduces font size when expansion adds overlap, including in bulk", () => {
    const document = withOverflow({ obstacle: true, h: 80 });
    const { slideId, issue } = issueFor(document, "TEXT_OVERFLOW");
    const originalNeighbor = document.slides[0].canvas.elements[1];
    const fixed = applyAuditDecision(document, slideId, issue, "fix");
    const text = fixed.slides[0].canvas.elements[0];
    expect(text.type === "text" && text.fontSize).toBeGreaterThanOrEqual(14);
    expect(text.type === "text" && text.fontSize).toBeLessThan(28);
    expect(text.h).toBe(80);
    expect(fixed.slides[0].canvas.elements[1]).toEqual(originalNeighbor);
    expect(auditPresentation(fixed).slides[0].issues.filter((finding) => finding.type === "TEXT_OVERFLOW" || finding.type === "ELEMENT_OVERLAP")).toEqual([]);
    const bulk = applyAllSafeAuditFixes(document);
    expect(bulk.slides[0].canvas.elements).toEqual(fixed.slides[0].canvas.elements);
    expect(bulk.auditDecisions?.some((decision) => decision.issueKey === auditIssueKey(slideId, issue) && decision.action === "fix")).toBe(true);
  });

  it("leaves impossible, stale, locked, and duplicate-id overflow findings unchanged", () => {
    const impossible = withOverflow({ y: 680, h: 8 });
    const target = issueFor(impossible, "TEXT_OVERFLOW");
    expect(applyAuditDecision(impossible, target.slideId, target.issue, "fix")).toBe(impossible);
    expect(applyAllSafeAuditFixes(impossible)).toBe(impossible);
    const stale = withOverflow();
    const old = issueFor(stale, "TEXT_OVERFLOW");
    (stale.slides[0].canvas.elements[0] as Extract<CanvasElement, { type: "text" }>).text = "Short";
    expect(applyAuditDecision(stale, old.slideId, old.issue, "fix")).toBe(stale);
    const locked = withOverflow();
    locked.slides[0].canvas.elements[0].locked = true;
    const lockedIssue = issueFor(locked, "TEXT_OVERFLOW");
    expect(applyAuditDecision(locked, lockedIssue.slideId, lockedIssue.issue, "fix")).toBe(locked);
    const ambiguous = withOverflow();
    ambiguous.slides[0].canvas.elements.push({ ...ambiguous.slides[0].canvas.elements[0] });
    const ambiguousIssue = issueFor(ambiguous, "TEXT_OVERFLOW");
    expect(applyAuditDecision(ambiguous, ambiguousIssue.slideId, ambiguousIssue.issue, "fix")).toBe(ambiguous);
  });
  it("uses a stable key based on the deterministic issue identity", () => {
    const issue: AuditIssue = { type: "OUTSIDE_SLIDE", severity: "error", elementId: "shape-1", message: "Element extends outside the slide" };
    expect(auditIssueKey("slide-1", issue)).toBe(auditIssueKey("slide-1", { ...issue }));
    expect(auditIssueKey("slide-1", issue)).not.toBe(auditIssueKey("slide-2", issue));
  });

  it("keeps ignored error and warning issues visible but non-blocking in the effective audit", () => {
    const errorDocument = withOutsideElement();
    const errorTarget = issueFor(errorDocument, "OUTSIDE_SLIDE");
    const ignoredError = applyAuditDecision(errorDocument, errorTarget.slideId, errorTarget.issue, "ignore", "2026-09-17T00:00:00.000Z");
    const errorReport = effectiveAuditPresentation(ignoredError);
    expect(errorReport.passed).toBe(true);
    expect(errorReport.slides.find((slide) => slide.slideId === errorTarget.slideId)?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "OUTSIDE_SLIDE", ignored: true }),
    ]));

    const warningDocument = withUnsupportedFont();
    const warningTarget = issueFor(warningDocument, "UNSUPPORTED_FONT");
    const ignoredWarning = applyAuditDecision(warningDocument, warningTarget.slideId, warningTarget.issue, "ignore", "2026-09-17T00:00:00.000Z");
    expect(effectiveAuditPresentation(ignoredWarning).slides.find((slide) => slide.slideId === warningTarget.slideId)?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "UNSUPPORTED_FONT", severity: "warning", ignored: true }),
    ]));
  });

  it("clamps OUTSIDE_SLIDE geometry and records a fix only after repeat audit resolves it", () => {
    const document = withOutsideElement();
    const target = issueFor(document, "OUTSIDE_SLIDE");
    expect(isAutoFixableAuditIssue(target.issue)).toBe(true);

    const fixed = applyAuditDecision(document, target.slideId, target.issue, "fix", "2026-09-17T00:00:00.000Z");

    expect(fixed).not.toBe(document);
    expect(fixed.auditDecisions).toEqual(expect.arrayContaining([expect.objectContaining({ action: "fix", issueKey: auditIssueKey(target.slideId, target.issue) })]));
    expect(auditPresentation(fixed).slides.find((slide) => slide.slideId === target.slideId)?.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "OUTSIDE_SLIDE", elementId: target.issue.elementId }),
    ]));
  });

  it("replaces UNSUPPORTED_FONT with the design-system font and resolves it on repeat audit", () => {
    const document = withUnsupportedFont();
    const target = issueFor(document, "UNSUPPORTED_FONT");
    const original = document.slides.find((slide) => slide.id === target.slideId)?.canvas.elements.find((element) => element.id === target.issue.elementId);
    const fixed = applyAuditDecision(document, target.slideId, target.issue, "fix", "2026-09-17T00:00:00.000Z");
    const updated = fixed.slides.find((slide) => slide.id === target.slideId)?.canvas.elements.find((element) => element.id === target.issue.elementId);

    expect(updated).not.toEqual(original);
    expect(updated && updated.type === "text" && document.designSystem.typography.headingFonts.includes(updated.fontFamily)).toBe(true);
    expect(auditPresentation(fixed).slides.find((slide) => slide.slideId === target.slideId)?.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "UNSUPPORTED_FONT", elementId: target.issue.elementId }),
    ]));
  });

  it("uses an observed color that passes the unrounded 4.5:1 normal-text threshold", () => {
    const document = withLowContrastText({ palette: ["#777777", "#767676", "#000000"] });
    const { slideId, issue } = issueFor(document, "LOW_TEXT_CONTRAST");
    const fixed = applyAuditDecision(document, slideId, issue, "fix");
    const before = document.slides[0].canvas.elements[0];
    const after = fixed.slides[0].canvas.elements[0];
    expect(after).toEqual({ ...before, color: "#767676" });
    expect(document.slides[0].canvas.elements[0]).toEqual(before);
    expect(auditPresentation(fixed).slides[0].issues.some((finding) => finding.type === "LOW_TEXT_CONTRAST" && finding.elementId === "contrast-text")).toBe(false);
  });

  it("uses the audited 3:1 threshold for large text", () => {
    const document = withLowContrastText({ fontSize: 24, color: "#959595", palette: ["#959595", "#949494", "#000000"] });
    const { slideId, issue } = issueFor(document, "LOW_TEXT_CONTRAST");
    const fixed = applyAuditDecision(document, slideId, issue, "fix");
    expect(fixed.slides[0].canvas.elements[0]).toEqual({ ...document.slides[0].canvas.elements[0], color: "#949494" });
    expect(auditPresentation(fixed).slides[0].issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "LOW_TEXT_CONTRAST", elementId: "contrast-text" }),
    ]));
  });

  it("uses a fully containing shape background and preserves every neighboring element", () => {
    const document = withLowContrastText({ color: "#333333", palette: ["#333333", "#FFFFFF", "#000000"], layers: [coveringShape("#000000")] });
    const { slideId, issue } = issueFor(document, "LOW_TEXT_CONTRAST");
    const fixed = applyAuditDecision(document, slideId, issue, "fix");
    expect(fixed.slides[0].canvas.elements[0]).toEqual(document.slides[0].canvas.elements[0]);
    expect(fixed.slides[0].canvas.elements[1]).toEqual({ ...document.slides[0].canvas.elements[1], color: "#FFFFFF" });
    expect(auditPresentation(fixed).slides[0].issues.some((finding) => finding.type === "LOW_TEXT_CONTRAST" && finding.elementId === "contrast-text")).toBe(false);
  });

  it("does not act on a stale finding after an image makes the background ambiguous", () => {
    const document = withLowContrastText();
    const { slideId, issue } = issueFor(document, "LOW_TEXT_CONTRAST");
    document.slides[0].canvas.elements.unshift({
      id: "image-overlay", type: "image", x: 90, y: 110, w: 220, h: 100,
      alt: "Overlay", zIndex: 5, locked: false,
    });
    expect(applyAuditDecision(document, slideId, issue, "fix")).toBe(document);
  });

  it("does not change a slide when no observed palette color clears contrast", () => {
    const document = withLowContrastText({ palette: ["#777777", "#959595"] });
    const { slideId, issue } = issueFor(document, "LOW_TEXT_CONTRAST");
    expect(applyAuditDecision(document, slideId, issue, "fix")).toBe(document);
  });

  it("is idempotent and applies the same safe gate in bulk", () => {
    const document = withLowContrastText({ palette: ["#777777", "#000000"] });
    const { slideId, issue } = issueFor(document, "LOW_TEXT_CONTRAST");
    const fixed = applyAuditDecision(document, slideId, issue, "fix");
    expect(applyAuditDecision(fixed, slideId, issue, "fix")).toBe(fixed);
    expect(applyAllSafeAuditFixes(document).slides[0].canvas.elements).toEqual(fixed.slides[0].canvas.elements);
    const unsafe = withLowContrastText({ palette: ["#777777", "#959595"] });
    expect(applyAllSafeAuditFixes(unsafe)).toBe(unsafe);
  });
});
