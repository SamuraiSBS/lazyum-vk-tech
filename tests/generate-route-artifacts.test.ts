import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as getArtifact } from "../src/app/api/artifacts/[jobId]/[...path]/route";
import { POST } from "../src/app/api/generate/route";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { normalizeContent } from "../src/lib/content-parser";
import {
  artifactManifestSchema,
  auditReportSchema,
  generationPlanningSchema,
  generationStageTraceSchema,
  type LayoutVariant,
  presentationDocumentSchema,
  type PresentationDocument,
} from "../src/lib/schemas";
import { publishedVariantRankingSchema } from "../src/lib/agent-contracts";
import { createFixtureTemplate } from "./fixture-decks";

let artifactRoot: string;
let previousArtifactRoot: string | undefined;
let previousProvider: string | undefined;
let previousYandexApiKey: string | undefined;
let previousYandexFolderId: string | undefined;
let previousYandexModelUri: string | undefined;
let previousYandexModelName: string | undefined;
let previousYandexModelParameters: string | undefined;
let previousYandexModelOpenWeights: string | undefined;
let previousYandexModelLicense: string | undefined;

const PROVIDER_SOURCE_TEXT = "Материалы для воспроизводимого теста.";

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-generate-"));
  previousArtifactRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
  previousProvider = process.env.VK_HACKATHON_LLM_PROVIDER;
  previousYandexApiKey = process.env.YANDEX_CLOUD_API_KEY;
  previousYandexFolderId = process.env.YANDEX_CLOUD_FOLDER_ID;
  previousYandexModelUri = process.env.YANDEX_CLOUD_MODEL_URI;
  previousYandexModelName = process.env.YANDEX_CLOUD_MODEL_NAME;
  previousYandexModelParameters = process.env.YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B;
  previousYandexModelOpenWeights = process.env.YANDEX_CLOUD_MODEL_OPEN_WEIGHTS;
  previousYandexModelLicense = process.env.YANDEX_CLOUD_MODEL_LICENSE;
  process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
  process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
});

afterAll(async () => {
  if (previousArtifactRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
  else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousArtifactRoot;
  if (previousProvider === undefined) delete process.env.VK_HACKATHON_LLM_PROVIDER;
  else process.env.VK_HACKATHON_LLM_PROVIDER = previousProvider;
  if (previousYandexApiKey === undefined) delete process.env.YANDEX_CLOUD_API_KEY;
  else process.env.YANDEX_CLOUD_API_KEY = previousYandexApiKey;
  if (previousYandexFolderId === undefined) delete process.env.YANDEX_CLOUD_FOLDER_ID;
  else process.env.YANDEX_CLOUD_FOLDER_ID = previousYandexFolderId;
  if (previousYandexModelUri === undefined) delete process.env.YANDEX_CLOUD_MODEL_URI;
  else process.env.YANDEX_CLOUD_MODEL_URI = previousYandexModelUri;
  restoreEnv("YANDEX_CLOUD_MODEL_NAME", previousYandexModelName);
  restoreEnv("YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B", previousYandexModelParameters);
  restoreEnv("YANDEX_CLOUD_MODEL_OPEN_WEIGHTS", previousYandexModelOpenWeights);
  restoreEnv("YANDEX_CLOUD_MODEL_LICENSE", previousYandexModelLicense);
  await rm(artifactRoot, { recursive: true, force: true });
});

afterEach(() => {
  process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
  vi.unstubAllGlobals();
});

describe("POST /api/generate artifact persistence", () => {
  it("returns the balanced aliases and publishes every validated generation artifact", async () => {
    const response = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "generation-template.pptx",
      "Сделать воспроизводимый pipeline генерации презентации",
    ));
    const payload = await response.json() as {
      audit?: unknown;
      audits?: unknown;
      jobId?: string;
      manifest?: unknown;
      normalizedContent?: unknown;
      presentation?: unknown;
      presentations?: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.jobId).toMatch(/^job-/);
    const manifest = artifactManifestSchema.parse(payload.manifest);
    const presentation = presentationDocumentSchema.parse(payload.presentation);
    const audit = auditReportSchema.parse(payload.audit);
    const planning = generationPlanningSchema.parse(JSON.parse(await readArtifact(manifest.artifacts.planning!.relativePath, payload.jobId!)));
    const presentations = payload.presentations as Record<string, unknown>;
    const audits = payload.audits as Record<string, unknown>;

    expect(manifest.status).toBe("ready");
    expect(manifest.inputs.sources).toHaveLength(1);
    expect(manifest.inputs.sources[0]).toMatchObject({
      origin: "uploaded",
      name: "notes.txt",
      type: "text/plain",
      sourceChunkIds: expect.arrayContaining([expect.stringMatching(/^chunk-/)]),
      factIds: [],
    });
    expect(JSON.stringify(manifest)).not.toContain(PROVIDER_SOURCE_TEXT);
    expect(planning.presentationPlan).toEqual(presentation.plan);
    expect(planning.normalizedContent).toEqual(payload.normalizedContent);
    expect(Object.keys(presentations).sort()).toEqual(["balanced", "compact", "visual"]);
    expect(Object.keys(audits).sort()).toEqual(["balanced", "compact", "visual"]);
    expect(presentation).toEqual(presentations.balanced);
    expect(audit).toEqual(audits.balanced);
    expect(presentation.plan.meta).toMatchObject({
      provider: "deterministic",
      promptPath: "prompts/planner/system.md",
      attempts: 1,
    });
    expect(presentation.plan.meta?.promptSha256).toMatch(/^[0-9a-f]{64}$/iu);
    expect(manifest.artifacts.planning?.relativePath).toBe("planning/plan.json");
    expect(manifest.artifacts.variants).toMatchObject({
      compact: { relativePath: "variants/compact.json" },
      balanced: { relativePath: "variants/balanced.json" },
      visual: { relativePath: "variants/visual.json" },
    });
    expect(manifest.artifacts.audit).toMatchObject({
      compact: { relativePath: "audit/compact.json" },
      balanced: { relativePath: "audit/balanced.json" },
      visual: { relativePath: "audit/visual.json" },
    });
    expect(manifest.artifacts.orchestration).toMatchObject({
      ranking: { relativePath: "orchestration/jury-ranking.json" },
      stageTrace: { relativePath: "orchestration/stage-trace.json" },
    });

    const variantReferences = manifest.artifacts.variants;
    const auditReferences = manifest.artifacts.audit;
    if (!variantReferences || !auditReferences || !("compact" in variantReferences) || !("compact" in auditReferences)) {
      throw new Error("Expected the complete generation reference maps");
    }
    for (const reference of [
      manifest.artifacts.planning,
      variantReferences.compact,
      variantReferences.balanced,
      variantReferences.visual,
      auditReferences.compact,
      auditReferences.balanced,
      auditReferences.visual,
      manifest.artifacts.orchestration?.ranking,
      manifest.artifacts.orchestration?.stageTrace,
    ]) {
      if (!reference) throw new Error("Expected generation artifact reference");
      const contents = await readArtifact(reference.relativePath, payload.jobId!);
      expect(reference.byteSize).toBe(Buffer.byteLength(contents));
      expect(reference.sha256).toBe(sha256(Buffer.from(contents)));
      const routeResponse = await getArtifact(new Request("http://localhost"), {
        params: Promise.resolve({ jobId: payload.jobId!, path: reference.relativePath.split("/") }),
      });
      expect(routeResponse.status).toBe(200);
      expect(Buffer.from(await routeResponse.arrayBuffer()).toString("utf8")).toBe(contents);
    }
    const orchestration = manifest.artifacts.orchestration;
    if (!orchestration) throw new Error("Expected jury artifact references");
    const ranking = publishedVariantRankingSchema.parse(JSON.parse(await readArtifact(orchestration.ranking.relativePath, payload.jobId!)));
    expect(ranking).toMatchObject({
      recommendedVariant: "balanced",
    });
    expect(ranking.sourceArtifactRefs.canonicalPlan).toMatchObject({
      relativePath: manifest.artifacts.planning?.relativePath,
      sha256: manifest.artifacts.planning?.sha256,
      byteSize: manifest.artifacts.planning?.byteSize,
    });
    expect(ranking.sourceArtifactRefs.variants.map((entry) => entry.artifact)).toEqual([
      ...(["compact", "balanced", "visual"] as const).map((variant) => ({
        artifactId: `artifact-variants-${variant}`,
        kind: "variant",
        ...variantReferences[variant],
      })),
    ]);
    expect(ranking.sourceArtifactRefs.audits.map((entry) => entry.artifact)).toEqual([
      ...(["compact", "balanced", "visual"] as const).map((variant) => ({
        artifactId: `artifact-audits-${variant}`,
        kind: "audit",
        ...auditReferences[variant],
      })),
    ]);
    expect(generationStageTraceSchema.parse(JSON.parse(await readArtifact(orchestration.stageTrace.relativePath, payload.jobId!)))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "final-jury", status: "completed",
        inputArtifactIds: expect.arrayContaining([
          "artifact-planning-canonical",
          "artifact-variants-compact", "artifact-variants-balanced", "artifact-variants-visual",
          "artifact-audits-compact", "artifact-audits-balanced", "artifact-audits-visual",
        ]),
      }),
    ]));
  });

  it("ranks the altered documents and audits that were actually saved to the job", async () => {
    const saveVariantsOriginal = ArtifactStore.prototype.saveVariants;
    const saveAuditsOriginal = ArtifactStore.prototype.saveAudits;
    const saveVariants = vi.spyOn(ArtifactStore.prototype, "saveVariants").mockImplementation(async function (
      this: ArtifactStore,
      jobId: string,
      presentations: Record<LayoutVariant, PresentationDocument>,
    ) {
      const published = structuredClone(presentations);
      published.compact.slides.forEach((slide) => { slide.canvas.elements = []; });
      return saveVariantsOriginal.call(this, jobId, published);
    });
    const saveAudits = vi.spyOn(ArtifactStore.prototype, "saveAudits").mockImplementation(async function (
      this: ArtifactStore,
      jobId: string,
      audits,
    ) {
      const published = structuredClone(audits);
      for (let index = 0; index < 20; index += 1) {
        published.compact.slides[0].issues.push({
          type: "SMALL_TEXT",
          severity: "warning",
          elementId: "published-jury-audit-signal",
          message: "Persisted audit metric",
          issueKey: `published-jury-warning-${index}`,
        });
      }
      return saveAuditsOriginal.call(this, jobId, published);
    });

    try {
      const response = await POST(createRequest(
        await createFixtureTemplate("bright"),
        "published-jury-template.pptx",
        "Сверить jury с сохранённым набором",
      ));
      const payload = await response.json() as {
        jobId?: string;
        presentations?: Record<LayoutVariant, PresentationDocument>;
        manifest?: unknown;
      };
      expect(response.status).toBe(200);
      const manifest = artifactManifestSchema.parse(payload.manifest);
      const rankingRef = manifest.artifacts.orchestration?.ranking;
      const variantRefs = manifest.artifacts.variants;
      const auditRefs = manifest.artifacts.audit;
      if (!rankingRef || !variantRefs || !("compact" in variantRefs) || !auditRefs || !("compact" in auditRefs)
        || !variantRefs.compact || !auditRefs.compact) {
        throw new Error("Expected saved generation and ranking refs");
      }
      const compactVariantRef = variantRefs.compact;
      const compactAuditRef = auditRefs.compact;
      const publishedCompact = presentationDocumentSchema.parse(JSON.parse(await readArtifact(compactVariantRef.relativePath, payload.jobId!)));
      const publishedCompactAudit = auditReportSchema.parse(JSON.parse(await readArtifact(compactAuditRef.relativePath, payload.jobId!)));
      const ranking = publishedVariantRankingSchema.parse(JSON.parse(await readArtifact(rankingRef.relativePath, payload.jobId!)));
      const compactRank = ranking.rankedVariants.find((entry) => entry.variant === "compact");

      expect(publishedCompact.slides.every((slide) => slide.canvas.elements.length === 0)).toBe(true);
      expect(payload.presentations!.compact.slides.some((slide) => slide.canvas.elements.length > 0)).toBe(true);
      expect(publishedCompactAudit.slides[0].issues).toHaveLength(20);
      expect(ranking.sourceArtifactRefs.variants.find((entry) => entry.variant === "compact")?.artifact).toEqual({
        artifactId: "artifact-variants-compact", kind: "variant", ...compactVariantRef,
      });
      expect(ranking.sourceArtifactRefs.audits.find((entry) => entry.variant === "compact")?.artifact).toEqual({
        artifactId: "artifact-audits-compact", kind: "audit", ...compactAuditRef,
      });
      expect(compactRank?.deterministicAuditScore).toBe(0);
      expect(compactRank?.score).toBeLessThan(40);
      expect(compactRank?.advisoryScore).toBe(76);
      expect(ranking.recommendedVariant).not.toBe("compact");
    } finally {
      saveVariants.mockRestore();
      saveAudits.mockRestore();
    }
  });

  it("returns provider model metadata on a mocked provider success", async () => {
    process.env.VK_HACKATHON_LLM_PROVIDER = "yandex-ai-studio";
    process.env.YANDEX_CLOUD_API_KEY = "test-provider-secret";
    process.env.YANDEX_CLOUD_FOLDER_ID = "folder-123";
    process.env.YANDEX_CLOUD_MODEL_URI = "gpt://folder-123/test-qwen";
    configureProviderPolicy();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse(providerPlanPayload(await providerEvidence()))));

    const response = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "provider-generation.pptx",
      "Проверить metadata провайдера",
    ));
    const payload = await response.json() as { presentation?: unknown; manifest?: unknown; attempts?: number };

    expect(response.status).toBe(200);
    const presentation = presentationDocumentSchema.parse(payload.presentation);
    const manifest = artifactManifestSchema.parse(payload.manifest);
    expect(presentation.plan.meta).toMatchObject({
      provider: "yandex-ai-studio",
      modelUri: "gpt://folder-123/test-qwen",
      promptPath: "prompts/planner/system.md",
      attempts: 1,
      maxAttempts: 2,
      attemptsUsed: 1,
      policy: { status: "approved", modelName: "Test open model", openWeights: true, license: "Apache-2.0", totalParametersB: 35 },
      budget: { inputTokenBudget: 8000, outputTokenBudget: 1500, totalTokenBudget: 18000 },
      usageUnknown: true,
    });
    expect(presentation.plan.meta?.groundingSummary).toEqual({
      total: 5,
      grounded: 5,
      unsupported: 0,
      rejected: 0,
      ruleVersion: "evidence-carrying-v1",
    });
    expect(presentation.plan.slides.flatMap((slide) => slide.claims ?? []).every((claim) => (
      claim.grounding === "grounded"
      && claim.sourceRefs.sourceChunkIds.length === 1
      && claim.sourceRefs.factIds.length === 0
    ))).toBe(true);
    expect(payload.attempts).toBe(1);
    expect(manifest.status).toBe("ready");
    expect(manifest.groundingSummary).toEqual(presentation.plan.meta?.groundingSummary);
  });

  it("classifies provider timeout with planning stage and one attempt", async () => {
    process.env.VK_HACKATHON_LLM_PROVIDER = "yandex-ai-studio";
    process.env.YANDEX_CLOUD_API_KEY = "test-provider-secret";
    process.env.YANDEX_CLOUD_FOLDER_ID = "folder-123";
    configureProviderPolicy();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));

    const response = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "provider-timeout.pptx",
      "Проверить timeout провайдера",
    ));
    const payload = await response.json() as { code?: string; stage?: string; attempts?: number; error?: string; manifest?: unknown };

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({ code: "provider_timeout", stage: "planning", attempts: 2 });
    expect(payload.error).not.toContain("test-provider-secret");
    expect(artifactManifestSchema.parse(payload.manifest).error).not.toContain("test-provider-secret");
  });

  it("classifies provider HTTP and invalid JSON failures without publishing a ready artifact", async () => {
    process.env.VK_HACKATHON_LLM_PROVIDER = "yandex-ai-studio";
    process.env.YANDEX_CLOUD_API_KEY = "test-provider-secret";
    process.env.YANDEX_CLOUD_FOLDER_ID = "folder-123";
    configureProviderPolicy();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Response("upstream test-provider-secret raw-provider-error-must-not-persist", { status: 503 })));

    const httpResponse = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "provider-http.pptx",
      "Проверить HTTP ошибку провайдера",
    ));
    const httpPayload = await httpResponse.json() as { code?: string; stage?: string; attempts?: number; error?: string; jobId?: string; manifest?: unknown };
    expect(httpPayload).toMatchObject({ code: "provider_http", stage: "planning", attempts: 2 });
    expect(httpPayload.error).not.toContain("test-provider-secret");
    expect(httpPayload.error).not.toContain("raw-provider-error-must-not-persist");
    expect(artifactManifestSchema.parse(httpPayload.manifest).status).toBe("failed");
    expect(JSON.stringify(httpPayload)).not.toContain("providerDiagnostics");
    const httpManifest = await new ArtifactStore(artifactRoot).readManifest(httpPayload.jobId!);
    expect(httpManifest.providerDiagnostics).toEqual([
      expect.objectContaining({ stage: "http", code: "provider_http", attempt: 1, httpStatus: 503 }),
      expect.objectContaining({ stage: "http", code: "provider_http", attempt: 2, httpStatus: 503 }),
    ]);
    expect(JSON.stringify(httpManifest)).not.toContain("raw-provider-error-must-not-persist");

    process.env.VK_HACKATHON_LLM_PROVIDER = "yandex-ai-studio";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse("not-json")));
    const jsonResponse = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "provider-json.pptx",
      "Проверить JSON ошибку провайдера",
    ));
    const jsonPayload = await jsonResponse.json() as { code?: string; stage?: string; attempts?: number; jobId?: string; manifest?: unknown };
    expect(jsonPayload).toMatchObject({ code: "invalid_json", stage: "planning", attempts: 1 });
    expect(artifactManifestSchema.parse(jsonPayload.manifest).status).toBe("failed");
    expect(JSON.stringify(jsonPayload)).not.toContain("not-json");
    expect(JSON.stringify(jsonPayload)).not.toContain("contentSha256");
    expect(JSON.stringify(jsonPayload)).not.toContain("plannerSchemaDiagnostic");
    const jsonManifest = await new ArtifactStore(artifactRoot).readManifest(jsonPayload.jobId!);
    expect(jsonManifest.providerDiagnostics).toEqual([expect.objectContaining({
      stage: "json_parse", code: "invalid_json", attempt: 1,
      contentPresent: true, contentType: "string", contentLength: 8,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect(JSON.stringify(jsonManifest)).not.toContain("not-json");
    expect(JSON.stringify(jsonManifest)).not.toContain("test-provider-secret");
    expect(jsonManifest.plannerSchemaDiagnostic).toBeUndefined();
  });

  it("fails closed on a provider plan with fewer slides than requested without exposing its content", async () => {
    process.env.VK_HACKATHON_LLM_PROVIDER = "yandex-ai-studio";
    process.env.YANDEX_CLOUD_API_KEY = "test-provider-secret";
    process.env.YANDEX_CLOUD_FOLDER_ID = "folder-123";
    configureProviderPolicy();
    const rawProviderContent = providerPlanPayload(undefined, 4).replace("План провайдера", "raw-provider-schema-content-must-not-persist");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse(rawProviderContent)));

    const response = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "provider-schema.pptx",
      "Проверить schema validation провайдера",
    ));
    const payload = await response.json() as { code?: string; stage?: string; attempts?: number; jobId?: string; manifest?: unknown };
    const publicManifest = artifactManifestSchema.parse(payload.manifest);
    const failedManifest = await new ArtifactStore(artifactRoot).readManifest(payload.jobId!);

    expect(payload).toMatchObject({ code: "planner_schema_invalid", stage: "planning", attempts: 1 });
    expect(JSON.stringify(payload)).not.toContain("plannerSchemaDiagnostic");
    expect(JSON.stringify(payload)).not.toContain(rawProviderContent);
    expect(JSON.stringify(payload)).not.toContain("Array must contain at least");
    expect(JSON.stringify(publicManifest)).not.toContain("plannerSchemaDiagnostic");
    expect(failedManifest.plannerSchemaDiagnostic).toEqual({
      stage: "planning",
      attempt: 1,
      issues: [{ path: ["slides"], code: "too_small", minimum: 5 }],
    });
    expect(JSON.stringify(failedManifest)).not.toContain(rawProviderContent);
    expect(JSON.stringify(failedManifest)).not.toContain("test-provider-secret");
    expect(JSON.stringify(failedManifest)).not.toContain("Array must contain at least");
    expect(failedManifest.artifacts.planning).toBeNull();
    expect(failedManifest.artifacts.variants).toBeNull();
    expect(failedManifest.artifacts.audit).toBeNull();
    expect(failedManifest.artifacts.exports).toBeNull();
    expect(failedManifest.artifacts.renderEvidence).toBeNull();
    expect(failedManifest.artifacts.renders).toBeNull();
  });

  it("persists only redacted numeric usage for a length-truncated provider response and starts no generation artifacts", async () => {
    process.env.VK_HACKATHON_LLM_PROVIDER = "yandex-ai-studio";
    process.env.YANDEX_CLOUD_API_KEY = "test-provider-secret";
    process.env.YANDEX_CLOUD_FOLDER_ID = "folder-123";
    configureProviderPolicy();
    const rawContent = '{"title":"raw-provider-content-must-not-persist"';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse(rawContent, {
      finishReason: "length",
      usage: { prompt_tokens: 101, completion_tokens: 202, total_tokens: 303 },
    })));

    const response = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "provider-truncation.pptx",
      "Проверить truncation провайдера",
    ));
    const payload = await response.json() as { code?: string; stage?: string; attempts?: number; jobId?: string; manifest?: unknown };
    const manifest = artifactManifestSchema.parse(payload.manifest);
    const failedManifest = await new ArtifactStore(artifactRoot).readManifest(payload.jobId!);

    expect(payload).toMatchObject({ code: "invalid_json", stage: "planning", attempts: 1 });
    expect(JSON.stringify(payload)).not.toContain(rawContent);
    expect(JSON.stringify(failedManifest)).not.toContain(rawContent);
    expect(failedManifest.providerDiagnostics).toEqual([expect.objectContaining({
      stage: "truncation",
      code: "invalid_json",
      attempt: 1,
      finishReason: "length",
      contentPresent: true,
      contentType: "string",
      contentLength: Buffer.byteLength(rawContent),
      usage: { inputTokens: 101, outputTokens: 202, totalTokens: 303 },
    })]);
    expect(manifest.status).toBe("failed");
    expect(manifest.artifacts.planning).toBeNull();
    expect(manifest.artifacts.variants).toBeNull();
    expect(manifest.artifacts.audit).toBeNull();
    expect(manifest.artifacts.exports).toBeNull();
    expect(manifest.artifacts.renderEvidence).toBeNull();
    expect(manifest.artifacts.renders).toBeNull();
  });

  it("classifies a provider grounding rejection at the planning stage", async () => {
    process.env.VK_HACKATHON_LLM_PROVIDER = "yandex-ai-studio";
    process.env.YANDEX_CLOUD_API_KEY = "test-provider-secret";
    process.env.YANDEX_CLOUD_FOLDER_ID = "folder-123";
    configureProviderPolicy();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse(providerPlanPayload())));

    const response = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "provider-grounding.pptx",
      "Проверить grounding ошибку провайдера",
    ));
    const payload = await response.json() as { code?: string; stage?: string; attempts?: number; manifest?: unknown };

    expect(payload).toMatchObject({ code: "grounding_failed", stage: "planning", attempts: 1 });
    expect(artifactManifestSchema.parse(payload.manifest).status).toBe("failed");
  });

  it("records a redacted model-policy rejection in the failed manifest before any fetch", async () => {
    process.env.VK_HACKATHON_LLM_PROVIDER = "yandex-ai-studio";
    process.env.YANDEX_CLOUD_API_KEY = "test-provider-secret";
    process.env.YANDEX_CLOUD_FOLDER_ID = "folder-123";
    delete process.env.YANDEX_CLOUD_MODEL_NAME;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(createRequest(
      await createFixtureTemplate("bright"),
      "policy-rejected.pptx",
      "Проверить policy rejection",
    ));
    const payload = await response.json() as { code?: string; attempts?: number; error?: string; manifest?: unknown };
    const manifest = artifactManifestSchema.parse(payload.manifest);

    expect(payload).toMatchObject({ code: "model_policy_rejected", attempts: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(payload.error).not.toContain("test-provider-secret");
    expect(manifest).toMatchObject({ status: "failed" });
    expect(manifest.error).toContain("code=model_policy_rejected");
    expect(manifest.error).toContain("policy=rejected");
    expect(manifest.error).not.toContain("test-provider-secret");
    expect(manifest.plannerPolicy).toEqual({
      status: "rejected",
      rejectedField: "YANDEX_CLOUD_MODEL_NAME",
      reason: "must be explicitly attested",
      modelUri: "gpt://folder-123/test-qwen",
      totalParametersB: 35,
      openWeights: true,
      license: "Apache-2.0",
    });
    expect(JSON.stringify(manifest.plannerPolicy)).not.toContain("test-provider-secret");
    expect(manifest.artifacts.planning).toBeNull();
    expect(manifest.artifacts.variants).toBeNull();
    expect(manifest.artifacts.audit).toBeNull();
  });

  it("does not leave a ready manifest after a partial variant save", async () => {
    const saveVariants = vi.spyOn(ArtifactStore.prototype, "saveVariants").mockRejectedValueOnce(new Error("variant write failed"));
    try {
      const response = await POST(createRequest(
        await createFixtureTemplate("bright"),
        "partial-generation.pptx",
        "Проверить частичный сбой генерации",
      ));
      const payload = await response.json() as { code?: string; stage?: string; attempts?: number; jobId?: string; manifest?: unknown };
      const manifest = artifactManifestSchema.parse(payload.manifest);

      expect(response.status).toBe(400);
      expect(payload).toMatchObject({ code: "unknown", stage: "persisting", attempts: 1 });
      expect(manifest.status).toBe("failed");
      expect(manifest.artifacts.planning).toBeNull();
      expect(manifest.artifacts.variants).toBeNull();
      expect(manifest.artifacts.audit).toBeNull();
      await expect(readFile(path.join(artifactRoot, payload.jobId!, "planning/plan.json"))).rejects.toThrow();
      await expect(readFile(path.join(artifactRoot, payload.jobId!, "variants/balanced.json"))).rejects.toThrow();
    } finally {
      saveVariants.mockRestore();
    }
  });

  it("persists a sanitized failed manifest and does not publish partial generation artifacts", async () => {
    const response = await POST(createRequest(Buffer.from("not a pptx"), "broken-generation.pptx", "Валидный brief"));
    const payload = await response.json() as { error?: string; jobId?: string; manifest?: unknown };

    expect(response.status).toBe(400);
    expect(payload.jobId).toMatch(/^job-/);
    expect(payload.error).toBeTruthy();
    expect(payload.error).not.toMatch(/[\r\n\t]/);
    const manifest = artifactManifestSchema.parse(payload.manifest);
    expect(manifest.status).toBe("failed");
    expect(manifest.artifacts.planning).toBeNull();
    expect(manifest.artifacts.variants).toBeNull();
    expect(manifest.artifacts.audit).toBeNull();
    expect(manifest.error).not.toMatch(/[\r\n\t]/);
  });
});

function createRequest(template: Buffer, filename: string, brief: string) {
  const form = new FormData();
  form.set("template", new File([new Uint8Array(template)], filename, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }));
  form.set("brief", brief);
  form.set("slideCount", "5");
  form.set("variant", "balanced");
  form.set("materials", new File([PROVIDER_SOURCE_TEXT], "notes.txt", { type: "text/plain" }));
  return new Request("http://localhost/api/generate", { method: "POST", body: form });
}

async function readArtifact(relativePath: string, jobId: string) {
  return readFile(path.join(artifactRoot, jobId, relativePath), "utf8");
}

function providerResponse(
  content: string,
  options: { finishReason?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } = {},
) {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, ...(options.finishReason ? { finish_reason: options.finishReason } : {}) }],
    ...(options.usage ? { usage: options.usage } : {}),
  }), { status: 200 });
}

type ProviderEvidence = {
  sourceChunkIds: string[];
  factIds: string[];
  verbatimEvidence: string;
};

function providerPlanPayload(evidence: ProviderEvidence = {
  sourceChunkIds: [],
  factIds: [],
  verbatimEvidence: "",
}, slideCount = 5) {
  return JSON.stringify({
    title: "План провайдера",
    slides: Array.from({ length: slideCount }, (_, index) => ({
      id: `provider-slide-${index + 1}`,
      purpose: index === 0 ? "title" : "context",
      title: `Слайд ${index + 1}`,
      content: [PROVIDER_SOURCE_TEXT],
      visualIntent: "none",
      evidence: [{ contentIndex: 0, ...evidence }],
    })),
  });
}

async function providerEvidence(): Promise<ProviderEvidence> {
  const content = await normalizeContent("Проверить metadata провайдера", [{
    name: "notes.txt",
    type: "text/plain",
    buffer: Buffer.from(PROVIDER_SOURCE_TEXT),
  }]);
  const chunk = content.sourceChunks[0];
  if (!chunk) throw new Error("Expected a normalized provider source chunk");
  return {
    sourceChunkIds: [chunk.chunkId],
    factIds: [],
    verbatimEvidence: PROVIDER_SOURCE_TEXT,
  };
}

function configureProviderPolicy() {
  process.env.YANDEX_CLOUD_MODEL_NAME = "Test open model";
  process.env.YANDEX_CLOUD_MODEL_URI = "gpt://folder-123/test-qwen";
  process.env.YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B = "35";
  process.env.YANDEX_CLOUD_MODEL_OPEN_WEIGHTS = "true";
  process.env.YANDEX_CLOUD_MODEL_LICENSE = "Apache-2.0";
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
