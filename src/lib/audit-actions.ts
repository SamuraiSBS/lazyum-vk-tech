import { auditPresentation } from "./audit";
import type { AuditIssue, AuditReport, CanvasElement, PresentationDocument } from "./schemas";

export type AuditAction = "fix" | "ignore";

/**
 * A tuple encoding rather than a hash keeps the key deterministic, inspectable
 * and collision-free for the values that identify a deterministic audit issue.
 */
export function auditIssueKey(slideId: string, issue: Pick<AuditIssue, "type" | "elementId" | "message">): string {
  return JSON.stringify([slideId, issue.type, issue.elementId || "", issue.message]);
}

export function isAutoFixableAuditIssue(issue: Pick<AuditIssue, "type" | "elementId">): boolean {
  return Boolean(issue.elementId) && (issue.type === "OUTSIDE_SLIDE" || issue.type === "UNSUPPORTED_FONT");
}

/**
 * Returns a fresh document. A fix decision is persisted only after a fresh
 * deterministic audit proves that the exact issue is gone.
 */
export function applyAuditDecision(
  document: PresentationDocument,
  slideId: string,
  issue: AuditIssue,
  action: AuditAction,
  appliedAt = new Date().toISOString(),
): PresentationDocument {
  const issueKey = auditIssueKey(slideId, issue);
  if (action === "ignore") {
    return withDecision(document, { issueKey, slideId, elementId: issue.elementId, action, appliedAt });
  }
  if (!isAutoFixableAuditIssue(issue)) return document;

  const candidate = applySafeFix(document, slideId, issue);
  if (candidate === document || hasCurrentIssue(candidate, slideId, issueKey)) return document;
  return withDecision(candidate, { issueKey, slideId, elementId: issue.elementId, action, appliedAt });
}

export function applyAllSafeAuditFixes(document: PresentationDocument, appliedAt = new Date().toISOString()): PresentationDocument {
  return auditPresentation(document).slides.reduce(
    (nextDocument, slide) => slide.issues.reduce(
      (next, issue) => isAutoFixableAuditIssue(issue)
        ? applyAuditDecision(next, slide.slideId, issue, "fix", appliedAt)
        : next,
      nextDocument,
    ),
    document,
  );
}

/** The report remains complete, while ignored issues are marked and do not fail it. */
export function effectiveAuditPresentation(document: PresentationDocument): AuditReport {
  const raw = auditPresentation(document);
  const slides = raw.slides.map((slide) => ({
    ...slide,
    issues: slide.issues.map((issue) => {
      const issueKey = auditIssueKey(slide.slideId, issue);
      return { ...issue, issueKey, ignored: isIgnored(document, issueKey) };
    }),
  }));
  return {
    slides,
    passed: slides.every((slide) => !slide.issues.some((issue) => issue.severity === "error" && !issue.ignored)),
  };
}

function applySafeFix(document: PresentationDocument, slideId: string, issue: AuditIssue): PresentationDocument {
  const targetSlide = document.slides.find((slide) => slide.id === slideId);
  if (!targetSlide || !issue.elementId) return document;
  const target = targetSlide.canvas.elements.find((element) => element.id === issue.elementId);
  const replacement = target && safeReplacement(target, targetSlide.canvas, document, issue);
  if (!replacement) return document;

  return {
    ...document,
    slides: document.slides.map((slide) => slide.id !== slideId ? slide : {
      ...slide,
      canvas: { ...slide.canvas, elements: slide.canvas.elements.map((element) => element.id === issue.elementId ? replacement : element) },
    }),
  };
}

function safeReplacement(
  element: CanvasElement,
  canvas: { width: number; height: number },
  document: PresentationDocument,
  issue: AuditIssue,
): CanvasElement | null {
  if (issue.type === "OUTSIDE_SLIDE") {
    const w = Math.min(element.w, canvas.width);
    const h = Math.min(element.h, canvas.height);
    return {
      ...element,
      x: clamp(element.x, 0, canvas.width - w),
      y: clamp(element.y, 0, canvas.height - h),
      w,
      h,
    };
  }
  if (issue.type === "UNSUPPORTED_FONT" && element.type === "text") {
    const fontFamily = element.fontWeight >= 600
      ? document.designSystem.typography.headingFonts[0] || document.designSystem.typography.bodyFonts[0]
      : document.designSystem.typography.bodyFonts[0] || document.designSystem.typography.headingFonts[0];
    return fontFamily ? { ...element, fontFamily } : null;
  }
  return null;
}

function hasCurrentIssue(document: PresentationDocument, slideId: string, issueKey: string) {
  return auditPresentation(document).slides
    .find((slide) => slide.slideId === slideId)
    ?.issues.some((issue) => auditIssueKey(slideId, issue) === issueKey) || false;
}

function isIgnored(document: PresentationDocument, issueKey: string) {
  const decision = [...(document.auditDecisions || [])].reverse().find((candidate) => candidate.issueKey === issueKey);
  return decision?.action === "ignore";
}

function withDecision(
  document: PresentationDocument,
  decision: NonNullable<PresentationDocument["auditDecisions"]>[number],
): PresentationDocument {
  return {
    ...document,
    auditDecisions: [...(document.auditDecisions || []).filter((candidate) => candidate.issueKey !== decision.issueKey), decision],
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
