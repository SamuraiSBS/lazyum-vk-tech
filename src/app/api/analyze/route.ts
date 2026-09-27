import { NextResponse } from "next/server";
import { ARTIFACT_RELATIVE_PATHS, createArtifactStore } from "../../../lib/artifact-store";
import { renderPptxToPngs } from "../../../lib/render-evidence";
import { parsePptxTemplate } from "../../../lib/template-parser";
import {
  acquireHeavyOperation,
  limitRequestBody,
  MAX_TEMPLATE_BYTES,
  rejectOversizedFile,
  REQUEST_BODY_LIMITS,
} from "../../../lib/request-guards";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const lease = acquireHeavyOperation("generation");
  if (lease instanceof Response) return lease;
  let jobId: string | undefined;
  let artifactStore: ReturnType<typeof createArtifactStore> | undefined;
  try {
    const store = createArtifactStore();
    artifactStore = store;
    const boundedRequest = await limitRequestBody(request, REQUEST_BODY_LIMITS.analyze);
    if (boundedRequest instanceof Response) return boundedRequest;
    const form = await boundedRequest.formData();
    const template = form.get("template");
    const file = requireFile(template, "template");
    assertPptx(file.name);
    const fileLimitResponse = rejectOversizedFile(file, MAX_TEMPLATE_BYTES);
    if (fileLimitResponse) return fileLimitResponse;
    const templateBuffer = Buffer.from(await file.arrayBuffer());
    const job = await store.createJob({ name: file.name, buffer: templateBuffer });
    jobId = job.jobId;
    const designSystem = await parsePptxTemplate(templateBuffer, file.name);
    await store.saveDesignSystem(jobId, designSystem);
    const render = await renderPptxToPngs(
      store.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.template),
      { outputDir: store.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.renderDirectory) },
    );
    const savedRender = await store.saveRenderArtifacts(jobId, render);
    const manifest = await store.markReady(jobId);
    return NextResponse.json({ designSystem, jobId, manifest, renderEvidence: savedRender.renderEvidence });
  } catch (error) {
    if (jobId && artifactStore) {
      try {
        await artifactStore.cleanupRenderArtifacts(jobId);
        const manifest = await artifactStore.markFailed(jobId, error);
        return NextResponse.json({ error: messageFor(error), jobId, manifest }, { status: 400 });
      } catch {
        // Preserve the route's existing error response if failure persistence is unavailable.
      }
    }
    return NextResponse.json({ error: messageFor(error) }, { status: 400 });
  } finally {
    lease.release();
  }
}

function requireFile(value: FormDataEntryValue | null, label: string): File {
  if (!value || typeof value === "string") throw new Error("Please choose a " + label + " file");
  return value;
}

function assertPptx(name: string) {
  if (!/\.pptx$/i.test(name)) throw new Error("The template must be a .pptx file");
}

function messageFor(error: unknown) {
  const message = error instanceof Error ? error.message : "Template analysis failed";
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  const diagnostic = code ? `RENDER_BLOCKER [${code}]: ${message}` : message;
  return diagnostic.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 240) || "Template analysis failed";
}
