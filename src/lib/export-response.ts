import { NextResponse } from "next/server";
import {
  ArtifactJobNotFoundError,
  ArtifactNotFoundError,
  createArtifactStore,
} from "./artifact-store";
import {
  jobExportRequestSchema,
  type ExportFormat,
  type JobExportRequest,
  type PresentationDocument,
} from "./schemas";

export type ExportRequestSource =
  | { kind: "document"; document: unknown }
  | {
    kind: "job";
    jobId: string;
    variant: JobExportRequest["variant"];
    document: PresentationDocument;
    store: ReturnType<typeof createArtifactStore>;
  };

export function createExportResponse(
  body: Buffer | Uint8Array | string,
  contentType: string,
  filename: string,
) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : Uint8Array.from(body);
  return new NextResponse(bytes, {
    headers: {
      "content-type": contentType,
      "content-disposition": contentDisposition(filename),
      "content-length": String(bytes.byteLength),
    },
  });
}

export function createJobExportResponse(
  body: Buffer | Uint8Array | string,
  contentType: string,
  filename: string,
  jobId: string,
  artifactPath: string,
) {
  const response = createExportResponse(body, contentType, filename);
  response.headers.set("X-VK-Hackathon-Job-Id", jobId);
  response.headers.set("X-VK-Hackathon-Artifact-Path", artifactPath);
  return response;
}

export function exportErrorResponse(
  code: "INVALID_EXPORT_REQUEST" | "JOB_NOT_FOUND" | "JOB_NOT_READY" | "VARIANT_ARTIFACT_MISSING" | "EXPORT_FAILED",
  status: number,
) {
  const messages = {
    INVALID_EXPORT_REQUEST: "Export request is invalid",
    JOB_NOT_FOUND: "Export job was not found",
    JOB_NOT_READY: "Export job is not ready",
    VARIANT_ARTIFACT_MISSING: "Requested variant artifact is not available",
    EXPORT_FAILED: "Export could not be created",
  } as const;
  return NextResponse.json({ error: { code, message: messages[code] } }, { status });
}

export async function resolveExportRequest(input: unknown): Promise<ExportRequestSource | NextResponse> {
  if (!isObjectWithJobId(input)) return { kind: "document", document: input };

  const request = jobExportRequestSchema.safeParse(input);
  if (!request.success) return exportErrorResponse("INVALID_EXPORT_REQUEST", 400);

  const store = createArtifactStore();
  let manifest;
  try {
    manifest = await store.readManifest(request.data.jobId);
  } catch (error) {
    if (error instanceof ArtifactJobNotFoundError) return exportErrorResponse("JOB_NOT_FOUND", 404);
    return exportErrorResponse("JOB_NOT_FOUND", 404);
  }
  if (manifest.status !== "ready") return exportErrorResponse("JOB_NOT_READY", 409);

  try {
    const published = await store.readPublishedVariantPresentation(request.data.jobId, request.data.variant);
    return {
      kind: "job",
      jobId: request.data.jobId,
      variant: request.data.variant,
      document: published.document,
      store,
    };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return exportErrorResponse("VARIANT_ARTIFACT_MISSING", 404);
    return exportErrorResponse("VARIANT_ARTIFACT_MISSING", 404);
  }
}

export async function saveJobExport(
  source: Extract<ExportRequestSource, { kind: "job" }>,
  format: ExportFormat,
  contents: Buffer | Uint8Array,
) {
  try {
    return await source.store.saveExport(source.jobId, source.variant, format, contents);
  } catch {
    return null;
  }
}

export function exportPreflightErrorResponse(result: {
  code: string;
  message: string;
  issues: unknown[];
  audit?: unknown;
}) {
  return NextResponse.json({
    error: {
      code: "EXPORT_PREFLIGHT_FAILED",
      reason: result.code,
      message: result.message,
      issues: result.issues,
      audit: result.audit ?? null,
    },
  }, { status: 422 });
}

export function safeExportFilename(value: string, extension: ".pptx" | ".pdf" | ".html") {
  const normalized = value.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${normalized.slice(0, 80) || "presentation"}${extension}`;
}

export function contentDisposition(filename: string) {
  const extension = filename.match(/\.[^.]+$/u)?.[0] || "";
  const asciiBase = filename
    .slice(0, filename.length - extension.length)
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const asciiFallback = `${asciiBase || "presentation"}${extension}`;
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

export function encodeRFC5987ValueChars(value: string) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function isObjectWithJobId(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "jobId" in value);
}
