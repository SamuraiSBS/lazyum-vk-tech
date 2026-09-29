import { NextResponse } from "next/server";
import { writeFile } from "node:fs/promises";
import { ZodError } from "zod";
import { inputSourceArtifact, normalizeContent } from "../../../lib/content-parser";
import { createPresentationPlan } from "../../../lib/planner";
import { createConfiguredPlannerProvider, PlannerProviderError } from "../../../lib/planner-provider";
import { renderPresentation } from "../../../lib/renderer";
import { createGroundedTableForGeneration } from "../../../lib/grounded-table-generation";
import { createGroundedChartForGeneration } from "../../../lib/grounded-chart-generation";
import { createGroundedDiagramForGeneration } from "../../../lib/grounded-diagram-generation";
import { auditPresentation } from "../../../lib/audit";
import { parsePptxTemplate } from "../../../lib/template-parser";
import { createArtifactStore } from "../../../lib/artifact-store";
import { runPublishedGenerationJury } from "../../../lib/agent-orchestrator";
import { resolveEffectiveSlideCount } from "../../../lib/slide-count";
import {
  acquireHeavyOperation,
  limitRequestBody,
  MAX_SOURCE_BYTES,
  MAX_TEMPLATE_BYTES,
  rejectOversizedFile,
  rejectTooManySources,
  REQUEST_BODY_LIMITS,
} from "../../../lib/request-guards";
import {
  auditReportSchema,
  artifactManifestSchema,
  normalizedContentSchema,
  plannerSchemaDiagnosticSchema,
  presentationDocumentSchema,
  presentationPlanSchema,
  type AuditReport,
  type GroundingSummary,
  type LayoutVariant,
  type PlannerSchemaDiagnostic,
  type ProviderAttemptDiagnostic,
  type PresentationDocument,
} from "../../../lib/schemas";

export const runtime = "nodejs";

const GENERATION_VARIANTS: LayoutVariant[] = ["compact", "balanced", "visual"];
type GenerationErrorCode = "model_policy_rejected" | "provider_configuration_failed" | "provider_timeout" | "provider_http" | "invalid_json" | "planner_schema_invalid" | "token_envelope_exhausted" | "grounding_failed" | "unknown";
type GenerationStage = "request" | "template" | "content" | "planning" | "rendering" | "auditing" | "persisting";

export async function POST(request: Request) {
  const lease = acquireHeavyOperation("generation");
  if (lease instanceof Response) return lease;
  let artifactStore: ReturnType<typeof createArtifactStore> | undefined;
  let jobId: string | undefined;
  let plannerAttempt = 1;
  let plannerProvider: ReturnType<typeof createConfiguredPlannerProvider>;
  let stage: GenerationStage = "request";
  try {
    const store = createArtifactStore();
    artifactStore = store;
    const boundedRequest = await limitRequestBody(request, REQUEST_BODY_LIMITS.generate);
    if (boundedRequest instanceof Response) return boundedRequest;
    const form = await boundedRequest.formData();
    stage = "template";
    const template = requireFile(form.get("template"), "PPTX template");
    if (!/\.pptx$/i.test(template.name)) throw new Error("The template must be a .pptx file");
    const templateLimitResponse = rejectOversizedFile(template, MAX_TEMPLATE_BYTES);
    if (templateLimitResponse) return templateLimitResponse;
    const brief = String(form.get("brief") || "").trim();
    const requestedCount = Number(form.get("slideCount") || 10);
    const selectedSlideCount = Math.max(5, Math.min(15, Number.isFinite(requestedCount) ? Math.round(requestedCount) : 10));
    const { count: slideCount } = resolveEffectiveSlideCount(brief, selectedSlideCount);
    const materials = form.getAll("materials")
      .filter((entry): entry is File => typeof entry !== "string");
    const sourceCountLimitResponse = rejectTooManySources(materials.length);
    if (sourceCountLimitResponse) return sourceCountLimitResponse;
    const oversizedSource = materials.find((file) => file.size > MAX_SOURCE_BYTES);
    if (oversizedSource) return rejectOversizedFile(oversizedSource, MAX_SOURCE_BYTES)!;
    const templateBuffer = Buffer.from(await template.arrayBuffer());
    const materialInputs = await Promise.all(materials.map(async (file) => ({
      name: file.name,
      type: file.type,
      buffer: Buffer.from(await file.arrayBuffer()),
    })));
    const job = await store.createJob(
      { name: template.name, buffer: templateBuffer },
      materialInputs.map(inputSourceArtifact),
    );
    jobId = job.jobId;
    stage = "content";
    const [designSystem, normalizedContent] = await Promise.all([
      parsePptxTemplate(templateBuffer, template.name),
      normalizeContent(brief, materialInputs),
    ]);
    const parsedContent = normalizedContentSchema.parse(normalizedContent);
    stage = "persisting";
    await store.saveDesignSystem(jobId, designSystem);
    await store.linkInputSourceArtifacts(jobId, parsedContent);
    stage = "planning";
    plannerProvider = createConfiguredPlannerProvider();
    const plan = presentationPlanSchema.parse(await createPresentationPlan(parsedContent, slideCount, plannerProvider));
    plannerAttempt = plannerProvider?.metadata?.attemptsUsed || 1;
    stage = "rendering";
    const presentations = Object.fromEntries(GENERATION_VARIANTS.map((variant) => {
      const baseDocument = renderPresentation(designSystem, plan, variant);
      const chart = createGroundedChartForGeneration(parsedContent, plan, baseDocument);
      const existingVisuals = chart.length ? chart : createGroundedTableForGeneration(parsedContent, plan, baseDocument);
      const candidateDiagrams = createGroundedDiagramForGeneration(parsedContent, plan, baseDocument);
      const candidateDiagramBySlide = new Map(candidateDiagrams.map(({ spec }) => [
        spec.slideId,
        new Set(spec.sourceRefs.factIds),
      ]));
      const distinctExistingVisuals = existingVisuals.filter(({ spec }) => {
        const diagramFactIds = candidateDiagramBySlide.get(spec.slideId);
        return !diagramFactIds || !spec.sourceRefs.factIds.some((factId) => diagramFactIds.has(factId));
      });
      const diagramBaseDocument = distinctExistingVisuals.length
        ? renderPresentation(designSystem, plan, variant, distinctExistingVisuals)
        : baseDocument;
      const diagrams = distinctExistingVisuals.length
        ? createGroundedDiagramForGeneration(parsedContent, plan, diagramBaseDocument)
        : candidateDiagrams;
      const diagramSlides = new Set(diagrams.map(({ spec }) => spec.slideId));
      const diagramFactIds = new Set(diagrams.flatMap(({ spec }) => spec.sourceRefs.factIds));
      const visuals = [
        ...diagrams,
        ...existingVisuals.filter(({ spec }) => !(diagramSlides.has(spec.slideId)
          && spec.sourceRefs.factIds.some((factId) => diagramFactIds.has(factId)))),
      ];
      return [variant, presentationDocumentSchema.parse({
        ...renderPresentation(designSystem, plan, variant, visuals),
        variant,
      })];
    })) as Record<LayoutVariant, PresentationDocument>;
    stage = "auditing";
    const audits = Object.fromEntries(GENERATION_VARIANTS.map((variant) => [
      variant,
      auditReportSchema.parse(auditPresentation(presentations[variant])),
    ])) as Record<LayoutVariant, AuditReport>;
    stage = "persisting";
    await store.savePlanning(jobId, parsedContent, plan);
    await store.saveVariants(jobId, presentations);
    await store.saveAudits(jobId, audits);
    if (Object.values(audits).some((audit) => !audit.passed)) {
      throw new Error("fatal_deterministic_audit");
    }
    const savedArtifacts = await store.readGenerationArtifactsForJury(jobId);
    const orchestration = runPublishedGenerationJury(savedArtifacts);
    await store.saveGenerationOrchestration(jobId, orchestration.ranking, orchestration.stages);
    const manifest = await store.markGenerationReady(jobId);
    return NextResponse.json({
      presentations,
      audits,
      presentation: presentations.balanced,
      audit: audits.balanced,
      normalizedContent: parsedContent,
      attempts: plan.meta?.attemptsUsed ?? 1,
      jobId,
      manifest,
    });
  } catch (error) {
    plannerAttempt = plannerProvider?.metadata?.attemptsUsed || plannerAttempt;
    const failure = classifyGenerationError(error, stage, plannerAttempt);
    const safeMessage = messageFor(error);
    const failedManifestError = failureManifestError(safeMessage, error, failure);
    if (jobId && artifactStore) {
      try {
        const failedManifest = await artifactStore.markGenerationFailed(jobId, new Error(failedManifestError));
        const manifest = await persistFailedMetadata(artifactStore, jobId, failedManifest, error, failure);
        return NextResponse.json({
          error: safeMessage,
          code: failure.code,
          stage: failure.stage,
        attempts: failure.attemptsUsed,
          jobId,
          manifest: publicManifest(manifest),
        }, { status: 400 });
      } catch {
        // Preserve the route's existing error response if failure persistence is unavailable.
      }
    }
    return NextResponse.json({
      error: safeMessage,
      code: failure.code,
      stage: failure.stage,
        attempts: failure.attemptsUsed,
    }, { status: 400 });
  } finally {
    lease.release();
  }
}

function requireFile(value: FormDataEntryValue | null, label: string): File {
  if (!value || typeof value === "string") throw new Error("Please choose a " + label);
  return value;
}

function messageFor(error: unknown) {
  if (error instanceof ZodError) return "Planner response failed schema validation";
  const message = error instanceof Error ? error.message : "Generation failed";
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD)/iu.test(name) && Boolean(value) && value!.length >= 4)
    .map(([, value]) => value!);
  const redacted = secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), message);
  return redacted.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 240) || "Generation failed";
}

function classifyGenerationError(error: unknown, stage: GenerationStage, plannerAttempt: number): { code: GenerationErrorCode; stage: GenerationStage; attemptsUsed: number } {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof PlannerProviderError) {
    return { code: error.code, stage, attemptsUsed: error.attemptsUsed };
  }
  const explicitCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  if (stage === "planning") {
    if (error instanceof ZodError) {
      return { code: "planner_schema_invalid", stage, attemptsUsed: plannerAttempt };
    }
    if (explicitCode === "provider_timeout" || /timed out|timeout|abort/iu.test(message)) {
      return { code: "provider_timeout", stage, attemptsUsed: 1 };
    }
    if (explicitCode === "provider_http" || /request failed with HTTP|HTTP \d{3}/iu.test(message)) {
      return { code: "provider_http", stage, attemptsUsed: 1 };
    }
    if (explicitCode === "grounding_failed" || /grounded claim|unsupported claim|grounding validation|duplicate claim id|sourcechunkid|factid|precision exact/iu.test(message)) {
      return { code: "grounding_failed", stage, attemptsUsed: 1 };
    }
    if (explicitCode === "invalid_json" || /not valid JSON|no planner content|unexpected token|JSON/iu.test(message)) {
      return { code: "invalid_json", stage, attemptsUsed: 1 };
    }
  }
  return { code: "unknown", stage, attemptsUsed: 1 };
}

function failureManifestError(
  safeMessage: string,
  error: unknown,
  failure: { code: GenerationErrorCode; attemptsUsed: number },
) {
  const metadata = error instanceof PlannerProviderError ? error.metadata : undefined;
  const policy = metadata?.policy;
  const budget = metadata?.budget;
  const details = [
    `code=${failure.code}`,
    `attemptsUsed=${failure.attemptsUsed}`,
    policy ? `policy=${policy.status}` : failure.code === "model_policy_rejected" ? "policy=rejected" : undefined,
    policy?.modelName ? `modelName=${policy.modelName}` : undefined,
    policy?.modelUri ? `modelUri=${policy.modelUri}` : undefined,
    policy?.totalParametersB !== undefined ? `totalParametersB=${policy.totalParametersB}` : undefined,
    policy?.license ? `license=${policy.license}` : undefined,
    budget ? `budget=${budget.inputTokenBudget}/${budget.outputTokenBudget}/${budget.totalTokenBudget}` : undefined,
  ].filter(Boolean).join("; ");
  return `${safeMessage}; ${details}`.slice(0, 240);
}

async function persistFailedMetadata(
  artifactStore: ReturnType<typeof createArtifactStore>,
  jobId: string,
  manifest: ReturnType<typeof artifactManifestSchema.parse>,
  error: unknown,
  failure: { code: GenerationErrorCode; attemptsUsed: number },
) {
  const policyFailure = error instanceof PlannerProviderError ? error.metadata?.policyFailure : undefined;
  const providerDiagnostics = plannerProviderDiagnostics(error);
  const groundingSummary = groundingSummaryFrom(error);
  const plannerSchemaDiagnostic = plannerSchemaDiagnosticFrom(error, failure);
  if (!policyFailure && !groundingSummary && !providerDiagnostics?.length && !plannerSchemaDiagnostic) return manifest;
  const nextManifest = artifactManifestSchema.parse({
    ...manifest,
    ...(policyFailure ? { plannerPolicy: policyFailure } : {}),
    ...(providerDiagnostics?.length ? { providerDiagnostics: providerDiagnostics.map(redactProviderDiagnostic) } : {}),
    ...(plannerSchemaDiagnostic ? { plannerSchemaDiagnostic } : {}),
    ...(groundingSummary ? { groundingSummary } : {}),
  });
  await writeFile(artifactStore.jobPath(jobId, "manifest.json"), JSON.stringify(nextManifest, null, 2) + "\n", "utf8");
  return nextManifest;
}

function plannerProviderDiagnostics(error: unknown): ProviderAttemptDiagnostic[] | undefined {
  if (!(error instanceof PlannerProviderError) || !("diagnostics" in error) || !Array.isArray(error.diagnostics)) return undefined;
  return error.diagnostics as ProviderAttemptDiagnostic[];
}

function redactProviderDiagnostic(diagnostic: ProviderAttemptDiagnostic): ProviderAttemptDiagnostic {
  // Schemas enforce the allowlist; copying fields makes the route boundary
  // explicit and prevents future error objects from leaking arbitrary data.
  return {
    stage: diagnostic.stage, code: diagnostic.code, attempt: diagnostic.attempt,
    ...(diagnostic.httpStatus !== undefined ? { httpStatus: diagnostic.httpStatus } : {}),
    ...(diagnostic.contentPresent !== undefined ? { contentPresent: diagnostic.contentPresent } : {}),
    ...(diagnostic.contentType ? { contentType: diagnostic.contentType } : {}),
    ...(diagnostic.contentLength !== undefined ? { contentLength: diagnostic.contentLength } : {}),
    ...(diagnostic.finishReason ? { finishReason: diagnostic.finishReason } : {}),
    ...(diagnostic.responseShapeKeys ? { responseShapeKeys: diagnostic.responseShapeKeys } : {}),
    ...(diagnostic.contentSha256 ? { contentSha256: diagnostic.contentSha256 } : {}),
    ...(diagnostic.usage ? { usage: diagnostic.usage } : {}),
  };
}

const SAFE_PLANNER_SCHEMA_PATH_SEGMENTS = new Set([
  "title", "slides", "id", "purpose", "content", "visualIntent", "evidence", "contentIndex", "sourceChunkIds", "factIds", "verbatimEvidence",
]);
const SAFE_PLANNER_SCHEMA_CODES = ["too_small", "too_big", "invalid_type", "invalid_enum_value", "invalid_string", "custom"] as const;

function plannerSchemaDiagnosticFrom(
  error: unknown,
  failure: { code: GenerationErrorCode; attemptsUsed: number },
): PlannerSchemaDiagnostic | undefined {
  if (failure.code !== "planner_schema_invalid" || !(error instanceof ZodError)) return undefined;
  const issues = error.issues.flatMap((issue) => {
    const code = SAFE_PLANNER_SCHEMA_CODES.find((candidate) => candidate === issue.code);
    if (!code || issue.path.length === 0 || issue.path.length > 6) return [];
    if (!issue.path.every((segment) => (
      (typeof segment === "string" && SAFE_PLANNER_SCHEMA_PATH_SEGMENTS.has(segment))
      || (typeof segment === "number" && Number.isInteger(segment) && segment >= 0 && segment <= 15)
    ))) return [];
    const numeric = issue as typeof issue & { minimum?: unknown; maximum?: unknown };
    return [{
      path: issue.path,
      code,
      ...(typeof numeric.minimum === "number" && Number.isFinite(numeric.minimum) && numeric.minimum >= 0 ? { minimum: numeric.minimum } : {}),
      ...(typeof numeric.maximum === "number" && Number.isFinite(numeric.maximum) && numeric.maximum >= 0 ? { maximum: numeric.maximum } : {}),
    }];
  }).slice(0, 8);
  return plannerSchemaDiagnosticSchema.parse({
    stage: "planning",
    attempt: Math.max(1, Math.min(3, failure.attemptsUsed)),
    issues,
  });
}

function publicManifest(manifest: ReturnType<typeof artifactManifestSchema.parse>) {
  // The failed-job manifest is a server-side diagnostic artifact. The route
  // keeps its existing response shape but never returns diagnostic digests.
  const { providerDiagnostics: _providerDiagnostics, plannerSchemaDiagnostic: _plannerSchemaDiagnostic, ...safeManifest } = manifest;
  return safeManifest;
}

function groundingSummaryFrom(error: unknown): GroundingSummary | undefined {
  if (!error || typeof error !== "object" || !("groundingSummary" in error)) return undefined;
  const parsed = artifactManifestSchema.shape.groundingSummary.safeParse(error.groundingSummary);
  return parsed.success ? parsed.data : undefined;
}
