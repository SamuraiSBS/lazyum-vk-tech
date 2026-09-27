import { NextResponse } from "next/server";
import { runExportPreflight } from "../../../../lib/export-preflight";
import {
  createExportResponse,
  createJobExportResponse,
  exportErrorResponse,
  exportPreflightErrorResponse,
  resolveExportRequest,
  safeExportFilename,
  saveJobExport,
} from "../../../../lib/export-response";
import { createPresentationPdf, PDF_EXPORT_CONTENT_TYPE } from "../../../../lib/pdf-export";
import { acquireHeavyOperation, limitRequestBody, REQUEST_BODY_LIMITS } from "../../../../lib/request-guards";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const lease = acquireHeavyOperation("export");
  if (lease instanceof Response) return lease;
  try {
    const boundedRequest = await limitRequestBody(request, REQUEST_BODY_LIMITS.export);
    if (boundedRequest instanceof Response) return boundedRequest;
    const source = await resolveExportRequest(await boundedRequest.json());
    if (source instanceof Response) return source;
    const preflight = runExportPreflight(source.document);
    if (!preflight.ok) return exportPreflightErrorResponse(preflight);
    let buffer: Buffer;
    try {
      buffer = await createPresentationPdf(preflight.document);
    } catch {
      return source.kind === "job"
        ? exportErrorResponse("EXPORT_FAILED", 500)
        : NextResponse.json({ error: "PDF export failed" }, { status: 500 });
    }
    if (source.kind === "job") {
      const saved = await saveJobExport(source, "pdf", buffer);
      if (!saved) return exportErrorResponse("EXPORT_FAILED", 500);
      return createJobExportResponse(
        buffer,
        PDF_EXPORT_CONTENT_TYPE,
        safeExportFilename(preflight.document.title, ".pdf"),
        source.jobId,
        saved.reference.relativePath,
      );
    }
    return createExportResponse(buffer, PDF_EXPORT_CONTENT_TYPE, safeExportFilename(preflight.document.title, ".pdf"));
  } catch {
    return NextResponse.json({ error: "PDF export failed" }, { status: 500 });
  } finally {
    lease.release();
  }
}
