import { auditPresentation, measureTextForBox } from "./audit";
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
  return Boolean(issue.elementId) && (issue.type === "OUTSIDE_SLIDE" || issue.type === "UNSUPPORTED_FONT" || issue.type === "LOW_TEXT_CONTRAST" || issue.type === "TEXT_OVERFLOW");
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
  // A stale finding must not change text whose background or color has since changed.
  if ((issue.type === "LOW_TEXT_CONTRAST" || issue.type === "TEXT_OVERFLOW") && !hasCurrentIssue(document, slideId, issueKey)) return document;

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
  if (issue.type === "TEXT_OVERFLOW") {
    if (document.slides.filter((slide) => slide.id === slideId).length !== 1
      || targetSlide.canvas.elements.filter((element) => element.id === issue.elementId).length !== 1
      || target?.type !== "text" || target.locked) return document;
    const originalIssues = auditPresentation(document).slides.find((slide) => slide.slideId === slideId)?.issues || [];
    const originalUnsafe = unsafeIssueCounts(originalIssues);
    const replacements: CanvasElement[] = [];
    const requiredHeight = measureTextForBox(target.text, target.fontSize, target.w).height;
    if (Number.isFinite(requiredHeight) && requiredHeight > target.h && target.y + requiredHeight <= targetSlide.canvas.height) {
      replacements.push({ ...target, h: requiredHeight });
    }
    for (let size = Math.floor(target.fontSize); size >= 14; size -= 1) {
      if (size >= target.fontSize) continue;
      if (measureTextForBox(target.text, size, target.w).height <= target.h) {
        replacements.push({ ...target, fontSize: size });
        break;
      }
    }
    for (const replacement of replacements) {
      const candidate = replaceElement(document, slideId, target.id, replacement);
      const findings = auditPresentation(candidate).slides.find((slide) => slide.slideId === slideId)?.issues || [];
      if (!findings.some((finding) => finding.type === "TEXT_OVERFLOW" && finding.elementId === target.id)
        && !addsUnsafeIssue(originalUnsafe, unsafeIssueCounts(findings))) return candidate;
    }
    return document;
  }
  if (issue.type === "LOW_TEXT_CONTRAST" && target?.type === "text") {
    if (targetSlide.canvas.elements.filter((element) => element.id === target.id).length !== 1) return document;
    // The audit is the single authority on both background ambiguity and the
    // normal/large WCAG threshold. Palette order gives a stable tie break.
    for (const color of document.designSystem.colors) {
      if (!/^#[0-9a-f]{6}$/i.test(color) || color.toUpperCase() === target.color.toUpperCase()) continue;
      const replacement = { ...target, color };
      const candidate: PresentationDocument = {
        ...document,
        slides: document.slides.map((slide) => slide.id !== slideId ? slide : {
          ...slide,
          canvas: {
            ...slide.canvas,
            elements: slide.canvas.elements.map((element) => element.id === target.id ? replacement : element),
          },
        }),
      };
      if (!auditPresentation(candidate).slides.find((slide) => slide.slideId === slideId)?.issues.some(
        (finding) => finding.type === "LOW_TEXT_CONTRAST" && finding.elementId === target.id,
      )) return candidate;
    }
    return document;
  }
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

function replaceElement(document: PresentationDocument, slideId: string, elementId: string, replacement: CanvasElement): PresentationDocument {
  return {
    ...document,
    slides: document.slides.map((slide) => slide.id !== slideId ? slide : {
      ...slide,
      canvas: { ...slide.canvas, elements: slide.canvas.elements.map((element) => element.id === elementId ? replacement : element) },
    }),
  };
}

function unsafeIssueCounts(issues: AuditIssue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    if (issue.severity !== "error" && issue.type !== "ELEMENT_OVERLAP") continue;
    const key = JSON.stringify([issue.type, issue.severity, issue.elementId, issue.message]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function addsUnsafeIssue(before: Map<string, number>, after: Map<string, number>): boolean {
  return [...after].some(([key, count]) => count > (before.get(key) || 0));
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
