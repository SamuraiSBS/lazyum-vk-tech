import { z } from "zod";
import { effectiveAuditPresentation } from "./audit-actions";
import { presentationDocumentSchema, type AuditReport, type PresentationDocument } from "./schemas";

export type ExportPreflightIssue = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
  slideId?: string;
  elementId?: string;
  ignored?: boolean;
};

export type ExportPreflightFailureCode = "INVALID_DOCUMENT" | "AUDIT_ERRORS";

export type ExportPreflightSuccess = {
  ok: true;
  document: PresentationDocument;
  audit: AuditReport;
  issues: ExportPreflightIssue[];
};

export type ExportPreflightFailure = {
  ok: false;
  code: ExportPreflightFailureCode;
  message: string;
  issues: ExportPreflightIssue[];
  audit?: AuditReport;
};

export type ExportPreflightResult = ExportPreflightSuccess | ExportPreflightFailure;

/**
 * Validate and audit an export document without mutating the caller's value.
 * Warnings and informational audit issues remain visible in the result; only
 * deterministic audit errors make the export fail closed.
 */
export function runExportPreflight(input: unknown): ExportPreflightResult {
  const parsed = presentationDocumentSchema.safeParse(input);
  if (!parsed.success) return invalidDocumentResult(parsed.error);

  const document = parsed.data;
  const audit = effectiveAuditPresentation(document);
  const issues = audit.slides.flatMap((slide) => slide.issues.map((issue) => ({
    code: issue.type,
    severity: issue.severity,
    message: issue.message,
    path: `slides.${slide.slideId}`,
    slideId: slide.slideId,
    elementId: issue.elementId,
    ignored: issue.ignored,
  })));

  if (issues.some((issue) => issue.severity === "error" && !issue.ignored)) {
    return {
      ok: false,
      code: "AUDIT_ERRORS",
      message: "Presentation export preflight found fatal audit issues",
      issues,
      audit,
    };
  }

  return { ok: true, document, audit, issues };
}

// Short alias for route and test callers that prefer the noun phrase.
export const exportPreflight = runExportPreflight;

function invalidDocumentResult(error: z.ZodError): ExportPreflightFailure {
  return {
    ok: false,
    code: "INVALID_DOCUMENT",
    message: "Presentation document failed export preflight validation",
    issues: error.issues.map((issue) => ({
      code: issue.code,
      severity: "error" as const,
      message: issue.message,
      path: issue.path.length ? issue.path.map(String).join(".") : undefined,
    })),
  };
}
