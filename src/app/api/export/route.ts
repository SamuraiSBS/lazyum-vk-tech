import { NextResponse } from "next/server";
import {
  createExportResponse,
  createJobExportResponse,
  exportErrorResponse,
  exportPreflightErrorResponse,
  resolveExportRequest,
  safeExportFilename,
  saveJobExport,
} from "../../../lib/export-response";
import { runExportPreflight } from "../../../lib/export-preflight";
import { createPresentationPptx } from "../../../lib/pptx-export";
import { acquireHeavyOperation, limitRequestBody, REQUEST_BODY_LIMITS } from "../../../lib/request-guards";

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
      buffer = await createPresentationPptx(preflight.document);
    } catch {
      return source.kind === "job"
        ? exportErrorResponse("EXPORT_FAILED", 500)
        : NextResponse.json({ error: "PPTX export failed" }, { status: 400 });
    }
    if (source.kind === "job") {
      const saved = await saveJobExport(source, "pptx", buffer);
      if (!saved) return exportErrorResponse("EXPORT_FAILED", 500);
      return createJobExportResponse(
        buffer,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        safeExportFilename(preflight.document.title, ".pptx"),
        source.jobId,
        saved.reference.relativePath,
      );
    }
    return createExportResponse(
      buffer,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      safeExportFilename(preflight.document.title, ".pptx"),
    );
  } catch {
    return NextResponse.json({ error: "PPTX export failed" }, { status: 400 });
  } finally {
    lease.release();
  }
}
