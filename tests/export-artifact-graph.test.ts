import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as getArtifact } from "../src/app/api/artifacts/[jobId]/[...path]/route";
import { POST as postPptx } from "../src/app/api/export/route";
import { POST as postHtml } from "../src/app/api/export/html/route";
import { POST as postPdf } from "../src/app/api/export/pdf/route";
import { auditPresentation } from "../src/lib/audit";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { inputSourceArtifact, normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import {
  artifactManifestSchema,
  presentationDocumentSchema,
  type ArtifactManifest,
  type ExportFormat,
  type LayoutVariant,
  type PresentationDocument,
} from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

const variants: LayoutVariant[] = ["compact", "balanced", "visual"];
const formats: Array<{ format: ExportFormat; contentType: string; post: (request: Request) => Promise<Response> }> = [
  {
    format: "pptx",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    post: postPptx,
  },
  { format: "pdf", contentType: "application/pdf", post: postPdf },
  { format: "html", contentType: "text/html; charset=utf-8", post: postHtml },
];

let artifactRoot: string;
let previousArtifactRoot: string | undefined;
let store: ArtifactStore;
let jobId: string;
let documentOnly: PresentationDocument;
let inputSourcesBeforePlanning: ArtifactManifest["inputs"]["sources"];
let sourceChunkIdsBeforePlanning: string[];

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-export-graph-"));
  previousArtifactRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
  process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
  store = new ArtifactStore(artifactRoot);

  const ready = await createReadyGenerationJob(store);
  jobId = ready.jobId;
  documentOnly = ready.documents.balanced;
  inputSourcesBeforePlanning = ready.inputSourcesBeforePlanning;
  sourceChunkIdsBeforePlanning = ready.sourceChunkIdsBeforePlanning;
});

afterAll(async () => {
  if (previousArtifactRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
  else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousArtifactRoot;
  await rm(artifactRoot, { recursive: true, force: true });
});

describe("job-based export artifact graph", () => {
  it("persists every normalized source chunk before planning", () => {
    expect(inputSourcesBeforePlanning).toHaveLength(1);
    expect(inputSourcesBeforePlanning[0]?.sourceChunkIds).toEqual(sourceChunkIdsBeforePlanning);
  });

  it("exports all 3 variants x 3 formats, publishes the returned bytes, and serves them back", async () => {
    for (const variant of variants) {
      for (const { format, contentType, post } of formats) {
        const response = await post(jobRequest(jobId, variant));
        const contents = Buffer.from(await response.arrayBuffer());
        const manifest = await store.readManifest(jobId);
        const reference = exportedReference(manifest, variant, format);
        if (!reference) throw new Error(`Missing ${variant}/${format} manifest reference`);

        expect(response.status, `${variant}/${format}`).toBe(200);
        expect(response.headers.get("content-type"), `${variant}/${format}`).toBe(contentType);
        expect(response.headers.get("X-VK-Hackathon-Job-Id")).toBe(jobId);
        expect(response.headers.get("X-VK-Hackathon-Artifact-Path")).toBe(reference.relativePath);
        expect(contents.byteLength).toBeGreaterThan(0);
        expect(reference.byteSize).toBe(contents.byteLength);
        expect(reference.sha256).toBe(sha256(contents));

        const artifact = await getArtifact(new Request("http://localhost"), {
          params: Promise.resolve({ jobId, path: reference.relativePath.split("/") }),
        });
        expect(artifact.status, `${variant}/${format} artifact`).toBe(200);
        expect(artifact.headers.get("content-type")).toBe(contentType);
        expect(Buffer.from(await artifact.arrayBuffer())).toEqual(contents);
      }
    }
  }, 120_000);

  it("updates the same export reference idempotently", async () => {
    const first = await postPptx(jobRequest(jobId, "balanced"));
    expect(first.status).toBe(200);
    const before = exportedReference(await store.readManifest(jobId), "balanced", "pptx");
    const second = await postPptx(jobRequest(jobId, "balanced"));
    expect(second.status).toBe(200);
    const after = exportedReference(await store.readManifest(jobId), "balanced", "pptx");

    expect(before?.relativePath).toBe("exports/balanced/pptx.pptx");
    expect(after?.relativePath).toBe(before?.relativePath);
    expect(after?.byteSize).toBe(Buffer.from(await second.arrayBuffer()).byteLength);
  });

  it("keeps the document-only contract working without a jobId", async () => {
    const response = await postPptx(new Request("http://localhost/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(documentOnly),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-VK-Hackathon-Job-Id")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("rejects unknown, failed, not-ready, missing-variant, and mixed job/document requests", async () => {
    const notReady = await store.createJob({ name: "not-ready.pptx", buffer: Buffer.from("not-ready") });
    const failed = await store.createJob({ name: "failed.pptx", buffer: Buffer.from("failed") });
    await store.markGenerationFailed(failed.jobId, new Error("fixture failure"));
    const missing = await createReadyGenerationJob(store);
    const missingManifest = await store.readManifest(missing.jobId);
    const missingVariants = missingManifest.artifacts.variants;
    if (!missingVariants || !("visual" in missingVariants)) throw new Error("Expected variant references");
    missingVariants.visual = null;
    await writeFile(store.jobPath(missing.jobId, "manifest.json"), JSON.stringify({
      ...missingManifest,
      artifacts: { ...missingManifest.artifacts, variants: missingVariants },
    }, null, 2));

    const cases = [
      { body: { jobId: "job-does-not-exist", variant: "balanced" }, status: 404, code: "JOB_NOT_FOUND" },
      { body: { jobId: notReady.jobId, variant: "balanced" }, status: 409, code: "JOB_NOT_READY" },
      { body: { jobId: failed.jobId, variant: "balanced" }, status: 409, code: "JOB_NOT_READY" },
      { body: { jobId: missing.jobId, variant: "visual" }, status: 404, code: "VARIANT_ARTIFACT_MISSING" },
      { body: { jobId, variant: "unknown" }, status: 400, code: "INVALID_EXPORT_REQUEST" },
      { body: { jobId, variant: "balanced", document: documentOnly }, status: 400, code: "INVALID_EXPORT_REQUEST" },
    ];
    for (const testCase of cases) {
      const response = await postPptx(jsonRequest(testCase.body));
      expect(response.status).toBe(testCase.status);
      await expect(response.json()).resolves.toMatchObject({ error: { code: testCase.code } });
    }
  });

  it("does not publish a false manifest reference when export persistence fails", async () => {
    const failing = await createReadyGenerationJob(store);
    const saveExport = vi.spyOn(ArtifactStore.prototype, "saveExport").mockRejectedValueOnce(new Error("disk unavailable"));
    try {
      const response = await postHtml(jobRequest(failing.jobId, "compact"));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "EXPORT_FAILED" } });
      expect((await store.readManifest(failing.jobId)).artifacts.exports).toBeNull();
    } finally {
      saveExport.mockRestore();
    }
  });
});

function jobRequest(job: string, variant: LayoutVariant) {
  return jsonRequest({ jobId: job, variant });
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function exportedReference(manifest: ArtifactManifest, variant: LayoutVariant, format: ExportFormat) {
  const exports = manifest.artifacts.exports;
  return exports && typeof exports === "object" && "compact" in exports ? exports[variant][format] : null;
}

async function createReadyGenerationJob(target: ArtifactStore) {
  const template = await createFixtureTemplate("bright");
  const designSystem = await parsePptxTemplate(template, "fixture-template.pptx");
  const materialInputs = [{
    name: "materials.txt",
    type: "text/plain",
    buffer: Buffer.from("Exported variants must remain traceable to the ready generation job."),
  }];
  const normalizedContent = await normalizeContent("VK Tech export artifact graph", materialInputs);
  const plan = await createPresentationPlan(normalizedContent, 5);
  const documents = Object.fromEntries(variants.map((variant) => [
    variant,
    presentationDocumentSchema.parse({ ...renderPresentation(designSystem, plan, variant), variant }),
  ])) as Record<LayoutVariant, PresentationDocument>;
  const job = await target.createJob(
    { name: "fixture-template.pptx", buffer: template },
    materialInputs.map(inputSourceArtifact),
  );
  await target.saveDesignSystem(job.jobId, designSystem);
  await target.linkInputSourceArtifacts(job.jobId, normalizedContent);
  const manifestBeforePlanning = await target.readManifest(job.jobId);
  await target.savePlanning(job.jobId, normalizedContent, plan);
  await target.saveVariants(job.jobId, documents);
  await target.saveAudits(job.jobId, Object.fromEntries(variants.map((variant) => [
    variant,
    auditPresentation(documents[variant]),
  ])) as Record<LayoutVariant, ReturnType<typeof auditPresentation>>);
  await target.markGenerationReady(job.jobId);
  return {
    jobId: job.jobId,
    documents,
    inputSourcesBeforePlanning: manifestBeforePlanning.inputs.sources,
    sourceChunkIdsBeforePlanning: normalizedContent.sourceChunks.map((chunk) => chunk.chunkId).sort(),
  };
}
