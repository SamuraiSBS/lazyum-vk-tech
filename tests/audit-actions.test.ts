import { beforeAll, describe, expect, it } from "vitest";
import {
  applyAuditDecision,
  auditIssueKey,
  effectiveAuditPresentation,
  isAutoFixableAuditIssue,
} from "../src/lib/audit-actions";
import { auditPresentation } from "../src/lib/audit";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema, type AuditIssue, type PresentationDocument } from "../src/lib/schemas";
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

describe("audit actions", () => {
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
});
