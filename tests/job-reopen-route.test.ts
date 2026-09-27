import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "../src/app/api/jobs/[jobId]/route";
import { auditPresentation } from "../src/lib/audit";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { runPublishedGenerationJury } from "../src/lib/agent-orchestrator";
import { inputSourceArtifact, normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import {
  artifactManifestSchema,
  generationStageTraceSchema,
  presentationDocumentSchema,
  type LayoutVariant,
  type PresentationDocument,
} from "../src/lib/schemas";
import { publishedVariantRankingSchema } from "../src/lib/agent-contracts";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

const variants: LayoutVariant[] = ["compact", "balanced", "visual"];
let artifactRoot: string;
let previousArtifactRoot: string | undefined;
let store: ArtifactStore;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-job-reopen-"));
  previousArtifactRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
  process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
  store = new ArtifactStore(artifactRoot);
});

afterAll(async () => {
  if (previousArtifactRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
  else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousArtifactRoot;
  await rm(artifactRoot, { recursive: true, force: true });
});

describe("GET /api/jobs/[jobId]", () => {
  it("reopens only the validated published generation snapshot", async () => {
    const ready = await createReadyGenerationJob();
    const response = await getJob(ready.jobId);
    const payload = await response.json() as {
      manifest?: unknown;
      designSystem?: unknown;
      presentations?: Record<LayoutVariant, unknown>;
      audits?: Record<LayoutVariant, unknown>;
      ranking?: unknown;
      stageTrace?: unknown;
    };

    expect(response.status).toBe(200);
    expect(Object.keys(payload).sort()).toEqual(["audits", "designSystem", "manifest", "presentations", "ranking", "stageTrace"]);
    expect(artifactManifestSchema.parse(payload.manifest).jobId).toBe(ready.jobId);
    expect(payload.designSystem).toEqual(ready.documents.balanced.designSystem);
    expect(payload.presentations).toEqual(ready.documents);
    expect(payload.audits).toEqual(ready.audits);
    const ranking = publishedVariantRankingSchema.parse(payload.ranking);
    expect(ranking.recommendedVariant).toBe("balanced");
    expect(ranking.sourceArtifactRefs.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ variant: "compact", artifact: expect.objectContaining({ relativePath: "variants/compact.json" }) }),
      expect.objectContaining({ variant: "balanced", artifact: expect.objectContaining({ relativePath: "variants/balanced.json" }) }),
      expect.objectContaining({ variant: "visual", artifact: expect.objectContaining({ relativePath: "variants/visual.json" }) }),
    ]));
    expect(ranking.sourceArtifactRefs.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ variant: "compact", artifact: expect.objectContaining({ relativePath: "audit/compact.json" }) }),
      expect.objectContaining({ variant: "balanced", artifact: expect.objectContaining({ relativePath: "audit/balanced.json" }) }),
      expect.objectContaining({ variant: "visual", artifact: expect.objectContaining({ relativePath: "audit/visual.json" }) }),
    ]));
    expect(generationStageTraceSchema.parse(payload.stageTrace)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "final-jury", status: "completed",
        inputArtifactIds: expect.arrayContaining([
          "artifact-planning-canonical",
          "artifact-variants-compact", "artifact-variants-balanced", "artifact-variants-visual",
          "artifact-audits-compact", "artifact-audits-balanced", "artifact-audits-visual",
        ]),
      }),
    ]));
    expect(payload).not.toHaveProperty("planning");
    expect(JSON.stringify(payload)).not.toContain("private/draft.json");
    expect(JSON.stringify(payload)).not.toContain("raw-provider-output");
  });

  it("returns controlled errors without any artifact payload for unknown, failed, and incomplete jobs", async () => {
    const analyzing = await store.createJob({ name: "analyzing.pptx", buffer: Buffer.from("analyzing") });
    const failed = await store.createJob({ name: "failed.pptx", buffer: Buffer.from("failed") });
    await store.markGenerationFailed(failed.jobId, new Error("fixture failure"));
    const incomplete = await createReadyGenerationJob();
    const incompleteManifest = await store.readManifest(incomplete.jobId);
    const incompleteAudits = incompleteManifest.artifacts.audit;
    if (!incompleteAudits || !("visual" in incompleteAudits)) throw new Error("Expected generation audit references");
    await writeManifest(incomplete.jobId, {
      ...incompleteManifest,
      artifacts: { ...incompleteManifest.artifacts, audit: { ...incompleteAudits, visual: null } },
    });

    const cases = [
      { jobId: "job-does-not-exist", status: 404, code: "JOB_NOT_FOUND" },
      { jobId: analyzing.jobId, status: 409, code: "JOB_NOT_READY" },
      { jobId: failed.jobId, status: 409, code: "JOB_NOT_READY" },
      { jobId: incomplete.jobId, status: 409, code: "JOB_INCOMPLETE" },
    ];
    for (const testCase of cases) {
      const response = await getJob(testCase.jobId);
      expect(response.status).toBe(testCase.status);
      await expect(response.json()).resolves.toEqual({
        error: expect.objectContaining({ code: testCase.code }),
      });
    }
  });

  it("rejects a manifest that points a generation variant at an arbitrary published-looking file", async () => {
    const ready = await createReadyGenerationJob();
    const manifest = await store.readManifest(ready.jobId);
    const variantReferences = manifest.artifacts.variants;
    if (!variantReferences || !("visual" in variantReferences)) throw new Error("Expected generation variant references");
    const privateContents = Buffer.from(JSON.stringify({ private: "editor draft" }));
    const privatePath = "private/draft.json";
    await mkdir(path.dirname(store.jobPath(ready.jobId, privatePath)), { recursive: true });
    await writeFile(store.jobPath(ready.jobId, privatePath), privateContents);
    await writeManifest(ready.jobId, {
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        variants: {
          ...variantReferences,
          visual: { relativePath: privatePath, byteSize: privateContents.byteLength, sha256: sha256(privateContents) },
        },
      },
    });

    const response = await getJob(ready.jobId);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "JOB_INCOMPLETE" }),
    });
  });

  it("fails closed when the persisted jury ranking is missing or invalid", async () => {
    const missing = await createReadyGenerationJob();
    const missingManifest = await store.readManifest(missing.jobId);
    await writeManifest(missing.jobId, {
      ...missingManifest,
      artifacts: { ...missingManifest.artifacts, orchestration: null },
    });
    expect((await getJob(missing.jobId)).status).toBe(409);

    const invalid = await createReadyGenerationJob();
    const invalidManifest = await store.readManifest(invalid.jobId);
    const orchestration = invalidManifest.artifacts.orchestration;
    if (!orchestration) throw new Error("Expected persisted jury references");
    const contents = Buffer.from(JSON.stringify({ rawProviderOutput: "raw-provider-output" }));
    await writeFile(store.jobPath(invalid.jobId, orchestration.ranking.relativePath), contents);
    await writeManifest(invalid.jobId, {
      ...invalidManifest,
      artifacts: {
        ...invalidManifest.artifacts,
        orchestration: {
          ...orchestration,
          ranking: { ...orchestration.ranking, byteSize: contents.byteLength, sha256: sha256(contents) },
        },
      },
    });
    const response = await getJob(invalid.jobId);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: expect.objectContaining({ code: "JOB_INCOMPLETE" }) });

    const unbound = await createReadyGenerationJob();
    const unboundManifest = await store.readManifest(unbound.jobId);
    const unboundArtifacts = unboundManifest.artifacts.orchestration;
    if (!unboundArtifacts) throw new Error("Expected persisted jury references");
    const ranking = publishedVariantRankingSchema.parse(JSON.parse((await readFile(store.jobPath(unbound.jobId, unboundArtifacts.ranking.relativePath))).toString("utf8")));
    ranking.sourceArtifactRefs.canonicalPlan.sha256 = "f".repeat(64);
    const rankingContents = Buffer.from(JSON.stringify(ranking, null, 2) + "\n");
    await writeFile(store.jobPath(unbound.jobId, unboundArtifacts.ranking.relativePath), rankingContents);
    await writeManifest(unbound.jobId, {
      ...unboundManifest,
      artifacts: {
        ...unboundManifest.artifacts,
        orchestration: {
          ...unboundArtifacts,
          ranking: { ...unboundArtifacts.ranking, byteSize: rankingContents.byteLength, sha256: sha256(rankingContents) },
        },
      },
    });
    const unboundResponse = await getJob(unbound.jobId);
    expect(unboundResponse.status).toBe(409);
    await expect(unboundResponse.json()).resolves.toEqual({ error: expect.objectContaining({ code: "JOB_INCOMPLETE" }) });
  });
});

async function getJob(jobId: string) {
  return GET(new Request(`http://localhost/api/jobs/${jobId}`), {
    params: Promise.resolve({ jobId }),
  });
}

async function writeManifest(jobId: string, manifest: unknown) {
  await writeFile(store.jobPath(jobId, "manifest.json"), JSON.stringify(manifest, null, 2));
}

async function createReadyGenerationJob(): Promise<{
  jobId: string;
  documents: Record<LayoutVariant, PresentationDocument>;
  audits: Record<LayoutVariant, ReturnType<typeof auditPresentation>>;
}> {
  const template = await createFixtureTemplate("bright");
  const designSystem = await parsePptxTemplate(template, "fixture-template.pptx");
  const material = {
    name: "materials.txt",
    type: "text/plain",
    buffer: Buffer.from("A reopened job must use the published A, B, and C variants."),
  };
  const normalizedContent = await normalizeContent("Reopen a published generation job", [material]);
  const plan = await createPresentationPlan(normalizedContent, 5);
  const documents = Object.fromEntries(variants.map((variant) => [
    variant,
    presentationDocumentSchema.parse({ ...renderPresentation(designSystem, plan, variant), variant }),
  ])) as Record<LayoutVariant, PresentationDocument>;
  const audits = Object.fromEntries(variants.map((variant) => [
    variant,
    auditPresentation(documents[variant]),
  ])) as Record<LayoutVariant, ReturnType<typeof auditPresentation>>;
  const job = await store.createJob({ name: "fixture-template.pptx", buffer: template }, [inputSourceArtifact(material)]);
  await store.saveDesignSystem(job.jobId, designSystem);
  await store.linkInputSourceArtifacts(job.jobId, normalizedContent);
  await store.savePlanning(job.jobId, normalizedContent, plan);
  await store.saveVariants(job.jobId, documents);
  await store.saveAudits(job.jobId, audits);
  const jury = runPublishedGenerationJury(await store.readGenerationArtifactsForJury(job.jobId));
  await store.saveGenerationOrchestration(job.jobId, jury.ranking, jury.stages);
  await store.markGenerationReady(job.jobId);
  return { jobId: job.jobId, documents, audits };
}
