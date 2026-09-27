import { createHash } from "node:crypto";
import { z } from "zod";
import {
  agentIdSchema,
  critiqueReportSchema,
  deterministicAuditOutputSchema,
  deterministicRenderOutputSchema,
  evidenceAnalystInputSchema,
  evidencePackSchema,
  evidenceSourceSummarySchema,
  finalJuryInputSchema,
  narrativeArchitectInputSchema,
  narrativePlanSchema,
  publishedGenerationJuryInputSchema,
  publishedVariantRankingSchema,
  repairPlanSchema,
  repairPlannerInputSchema,
  safeArtifactRefSchema,
  sourceChunkSummarySchema,
  templateAnalystInputSchema,
  templateInterpretationSchema,
  templateLayoutSummarySchema,
  variantDesignerInputSchema,
  variantIdSchema,
  variantPlanSchema,
  variantRankingSchema,
  visualDirectorInputSchema,
  visualSpecPackSchema,
  type AgentId,
  type CritiqueReport,
  type EvidencePack,
  type NarrativePlan,
  type SafeArtifactRef,
  type TemplateInterpretation,
  type VariantId,
  type VariantPlan,
  type PublishedVariantRanking,
} from "./agent-contracts";
import {
  agentVariantRenderSetSchema,
  designSystemSchema,
  generationStageTraceSchema,
  presentationPlanSchema,
  type ArtifactReference,
  type AuditReport,
  type DesignSystem,
  type LayoutVariant,
  type PresentationDocument,
  type PresentationPlan,
} from "./schemas";
import { getActiveAgentVersions } from "./agent-registry";
import { BoundedAgentArtifactGraph, agentArtifactGraphSchema, type AgentArtifactGraph } from "./agent-artifact-graph";
import { runDeterministicMockAgent } from "./agent-mock-runner";
import { createPlannerSpecialistContextFromReferences } from "./agent-planner-bridge";
import {
  createDryRunDesignSystem,
  materializedVariantSchema,
  materializeVariantSet,
  type MaterializedVariant,
} from "./variant-materializer";
import type { SavedGenerationArtifactsForJury } from "./artifact-store";
import { persistAgentVariantRenders, verifyAgentVariantRenders } from "./agent-render-evidence";
import type { AgentVariantRenderSet } from "./schemas";

const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const agentDryRunRequestSchema = z.object({
  runId: runIdSchema,
  brief: z.string().min(2).max(2_000),
  slideCount: z.number().int().min(5).max(15),
  templateArtifactRef: safeArtifactRefSchema,
  renderEvidenceRefs: z.array(safeArtifactRefSchema).max(100),
  layouts: z.array(templateLayoutSummarySchema).min(1).max(80),
  designTokens: z.object({
    colors: z.array(z.string().regex(/^#[0-9A-F]{6}$/i)).max(24),
    headingFonts: z.array(z.string().min(1).max(120)).max(12),
    bodyFonts: z.array(z.string().min(1).max(120)).max(12),
  }).strict(),
  designSystem: designSystemSchema.optional(),
  sourceArtifacts: z.array(evidenceSourceSummarySchema).max(12),
  sourceChunks: z.array(sourceChunkSummarySchema).max(200),
  fatalAudit: z.boolean().default(false),
}).strict();
export type AgentDryRunRequest = z.input<typeof agentDryRunRequestSchema>;

const stageIdSchema = z.enum([
  "inputs",
  "specialists",
  "narrative-candidates",
  "narrative-selection",
  "visual-direction",
  "variant-design",
  "render-audit",
  "critics",
  "repair-plans",
  "final-jury",
]);

export const agentStageRunSchema = z.object({
  stage: stageIdSchema,
  status: z.enum(["completed", "blocked"]),
  agentIds: z.array(agentIdSchema).max(8),
  inputArtifactIds: z.array(z.string().regex(/^artifact-[a-z0-9][a-z0-9._-]{0,79}$/)).max(64),
  outputArtifactIds: z.array(z.string().regex(/^artifact-[a-z0-9][a-z0-9._-]{0,79}$/)).max(64),
  attempts: z.literal(1),
  durationMs: z.literal(0),
  validationErrors: z.array(z.string().min(1).max(240)).max(8),
}).strict();
export type AgentStageRun = z.infer<typeof agentStageRunSchema>;

export const agentRunManifestSchema = z.object({
  version: z.literal("v1"),
  runId: runIdSchema,
  mode: z.enum(["dry-run", "local-render"]),
  status: z.enum(["completed", "failed"]),
  agentRegistryVersion: z.literal(1),
  providerCalls: z.literal(false),
  networkCalls: z.literal(false),
  filesystemMutationAuthority: z.boolean(),
  stages: z.array(agentStageRunSchema).max(32),
  graph: agentArtifactGraphSchema,
  published: z.boolean(),
  publishedArtifactIds: z.array(z.string().regex(/^artifact-[a-z0-9][a-z0-9._-]{0,79}$/)).max(32),
  stopReason: z.enum(["fatal_deterministic_audit"]).optional(),
}).strict();
export type AgentRunManifest = z.infer<typeof agentRunManifestSchema>;

export const agentDryRunResultSchema = z.object({
  manifest: agentRunManifestSchema,
  providerCalls: z.literal(false),
  networkCalls: z.literal(false),
  materializedVariants: z.array(materializedVariantSchema).length(3),
  renderEvidence: agentVariantRenderSetSchema.optional(),
}).strict();
export type AgentDryRunResult = z.infer<typeof agentDryRunResultSchema>;

export class AgentOrchestrationError extends Error {
  constructor(readonly code:
    | "duplicate_input_ref"
    | "missing_source_ref"
    | "missing_source_chunk_ref"
    | "missing_claim_ref"
    | "invalid_dry_run_input") {
    super(code);
    this.name = "AgentOrchestrationError";
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en"));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function makeRef(
  artifactId: string,
  kind: SafeArtifactRef["kind"],
  relativePath: string,
  payload: unknown,
  hashPayload: unknown = payload,
): SafeArtifactRef {
  const serialized = stableStringify(payload);
  const hashed = stableStringify(hashPayload);
  return safeArtifactRefSchema.parse({
    artifactId,
    kind,
    relativePath,
    sha256: createHash("sha256").update(hashed, "utf8").digest("hex"),
    byteSize: Buffer.byteLength(serialized, "utf8"),
  });
}

function addStage(stages: AgentStageRun[], stage: AgentStageRun) {
  stages.push(agentStageRunSchema.parse(stage));
}

function addInputRefs(graph: BoundedAgentArtifactGraph, request: z.infer<typeof agentDryRunRequestSchema>) {
  const refs = [
    request.templateArtifactRef,
    ...request.renderEvidenceRefs,
    ...request.sourceArtifacts.map((source) => source.artifact),
  ];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.artifactId)) throw new AgentOrchestrationError("duplicate_input_ref");
    seen.add(ref.artifactId);
    graph.addInput(ref);
  }
  return refs;
}

function validateSourceGraph(request: z.infer<typeof agentDryRunRequestSchema>) {
  const sourceIds = new Set<string>();
  const sourceChunkIds = new Set<string>();
  for (const source of request.sourceArtifacts) {
    if (sourceIds.has(source.sourceId)) throw new AgentOrchestrationError("duplicate_input_ref");
    sourceIds.add(source.sourceId);
    for (const chunkId of source.sourceChunkIds) sourceChunkIds.add(chunkId);
  }
  for (const chunk of request.sourceChunks) {
    if (!sourceIds.has(chunk.sourceId)) throw new AgentOrchestrationError("missing_source_ref");
    if (!sourceChunkIds.has(chunk.chunkId)) throw new AgentOrchestrationError("missing_source_chunk_ref");
  }
}

function createCanonicalPresentationPlan(
  narrative: NarrativePlan,
  evidence: EvidencePack,
): PresentationPlan {
  const claimsById = new Map(evidence.claims.map((claim) => [claim.id, claim]));
  return presentationPlanSchema.parse({
    title: narrative.title,
    planner: "deterministic",
    slides: narrative.slides.map((slide) => ({
      id: slide.id,
      purpose: slide.purpose,
      title: slide.title,
      content: [slide.message],
      visualIntent: slide.visualIntent,
      sourceRefs: slide.sourceRefs,
      claims: slide.claimIds.map((claimId) => {
        const claim = claimsById.get(claimId);
        if (!claim) throw new AgentOrchestrationError("missing_claim_ref");
        return {
          id: claim.id,
          text: claim.text,
          grounding: "grounded" as const,
          precision: claim.precision,
          sourceRefs: claim.sourceRefs,
        };
      }),
    })),
  });
}

function getOutput<T>(graph: BoundedAgentArtifactGraph, artifactId: string, parser: z.ZodType<T>): T {
  const record = graph.get(artifactId);
  if (!record?.output) throw new AgentOrchestrationError("invalid_dry_run_input");
  return parser.parse(record.output);
}

function auditPayload(variant: VariantId, materializedAudit: MaterializedVariant["audit"], forceFatal: boolean) {
  const issueIds = materializedAudit.slides.flatMap((slide) => slide.issues.map((issue) =>
    `${slide.slideId}:${issue.type}:${issue.elementId || "slide"}`,
  ));
  const fatal = forceFatal || !materializedAudit.passed;
  return deterministicAuditOutputSchema.parse({
    version: "v1",
    variant,
    passed: !fatal,
    fatal,
    issueIds: fatal ? (issueIds.length ? issueIds : ["fatal-dry-run-audit"]) : issueIds,
    providerCalls: false,
  });
}

function renderPayload(variant: VariantId, document: PresentationDocument) {
  return deterministicRenderOutputSchema.parse({
    version: "v1",
    variant,
    slideIds: document.slides.map((slide) => slide.id),
    nativeObjectsOnly: true,
    providerCalls: false,
  });
}

function toInputIds(refs: SafeArtifactRef[]) {
  return refs.map((ref) => ref.artifactId);
}

/**
 * Execute the bounded P0-12.1 DAG with deterministic local mock roles.
 * No provider, network, filesystem writer, XML/PPTX mutation, or export path
 * is reachable from this function.
 */
export async function runAgentDryRun(
  request: AgentDryRunRequest,
  options: { renderEvidenceRoot?: string; onRenderEvidencePersisted?: (evidence: AgentVariantRenderSet) => Promise<void> } = {},
): Promise<AgentDryRunResult> {
  const parsed = agentDryRunRequestSchema.parse(request);
  try {
    validateSourceGraph(parsed);
  } catch (error) {
    if (error instanceof AgentOrchestrationError) throw error;
    throw new AgentOrchestrationError("invalid_dry_run_input");
  }

  const graph = new BoundedAgentArtifactGraph();
  const inputRefs = addInputRefs(graph, parsed);
  const stages: AgentStageRun[] = [];
  addStage(stages, {
    stage: "inputs",
    status: "completed",
    agentIds: [],
    inputArtifactIds: [],
    outputArtifactIds: toInputIds(inputRefs),
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  const templateInput = templateAnalystInputSchema.parse({
    templateArtifact: parsed.templateArtifactRef,
    renderEvidenceRefs: parsed.renderEvidenceRefs,
    layouts: parsed.layouts,
    designTokens: parsed.designTokens,
  });
  const evidenceInput = evidenceAnalystInputSchema.parse({
    brief: parsed.brief,
    sources: parsed.sourceArtifacts,
    sourceChunks: parsed.sourceChunks,
  });
  const [templateInterpretation, evidencePack] = await Promise.all([
    Promise.resolve(runDeterministicMockAgent("template-analyst", templateInput)),
    Promise.resolve(runDeterministicMockAgent("evidence-analyst", evidenceInput)),
  ]);
  const plannerSpecialistContext = createPlannerSpecialistContextFromReferences(
    templateInterpretationSchema.parse(templateInterpretation),
    evidencePackSchema.parse(evidencePack),
    {
      sourceChunkIds: parsed.sourceChunks.map((chunk) => chunk.chunkId),
      factIds: parsed.sourceArtifacts.flatMap((source) => source.factIds),
    },
  );
  const templateOutput = plannerSpecialistContext.template;
  const evidenceOutput = plannerSpecialistContext.evidence;
  const templateRef = makeRef("artifact-analysis-template-analyst", "analysis", "analysis/template-analyst.json", templateOutput);
  const evidenceRef = makeRef("artifact-analysis-evidence-analyst", "analysis", "analysis/evidence-analyst.json", evidenceOutput);
  graph.addAgentOutput("template-analyst", templateRef, [parsed.templateArtifactRef, ...parsed.renderEvidenceRefs], templateOutput);
  graph.addAgentOutput("evidence-analyst", evidenceRef, parsed.sourceArtifacts.map((source) => source.artifact), evidenceOutput);
  addStage(stages, {
    stage: "specialists",
    status: "completed",
    agentIds: ["template-analyst", "evidence-analyst"],
    inputArtifactIds: toInputIds([parsed.templateArtifactRef, ...parsed.renderEvidenceRefs, ...parsed.sourceArtifacts.map((source) => source.artifact)]),
    outputArtifactIds: [templateRef.artifactId, evidenceRef.artifactId],
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  const narrativeInput = narrativeArchitectInputSchema.parse({
    brief: parsed.brief,
    template: templateOutput,
    evidence: evidenceOutput,
    slideCount: parsed.slideCount,
  });
  const candidateOne = narrativePlanSchema.parse(runDeterministicMockAgent("narrative-architect", narrativeInput));
  const candidateTwo = narrativePlanSchema.parse(runDeterministicMockAgent("narrative-architect", narrativeInput, {
    ...candidateOne,
    planId: "candidate-2",
    slides: candidateOne.slides.map((slide) => ({ ...slide, title: `${slide.title} · альтернативный ход` })),
  }));
  const candidateOneRef = makeRef("artifact-planning-narrative-candidate-1", "plan", "planning/narrative-candidate-1.json", candidateOne);
  const candidateTwoRef = makeRef("artifact-planning-narrative-candidate-2", "plan", "planning/narrative-candidate-2.json", candidateTwo);
  graph.addAgentOutput("narrative-architect", candidateOneRef, [templateRef, evidenceRef], candidateOne);
  graph.addAgentOutput("narrative-architect", candidateTwoRef, [templateRef, evidenceRef], candidateTwo);
  addStage(stages, {
    stage: "narrative-candidates",
    status: "completed",
    agentIds: ["narrative-architect"],
    inputArtifactIds: [templateRef.artifactId, evidenceRef.artifactId],
    outputArtifactIds: [candidateOneRef.artifactId, candidateTwoRef.artifactId],
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  const selectedNarrative = narrativePlanSchema.parse(candidateOne);
  const canonicalPlan = createCanonicalPresentationPlan(selectedNarrative, evidenceOutput);
  const selectedRef = makeRef("artifact-planning-narrative-selected", "plan", "planning/narrative-selected.json", selectedNarrative);
  graph.addSystemOutput("narrative-selector", selectedRef, [candidateOneRef, candidateTwoRef], selectedNarrative);
  addStage(stages, {
    stage: "narrative-selection",
    status: "completed",
    agentIds: [],
    inputArtifactIds: [candidateOneRef.artifactId, candidateTwoRef.artifactId],
    outputArtifactIds: [selectedRef.artifactId],
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  const visualInput = visualDirectorInputSchema.parse({ narrative: selectedNarrative, evidence: evidenceOutput, template: templateOutput });
  const visualOutput = visualSpecPackSchema.parse(runDeterministicMockAgent("visual-director", visualInput));
  const visualRef = makeRef("artifact-planning-visual-director", "plan", "planning/visual-director.json", visualOutput);
  graph.addAgentOutput("visual-director", visualRef, [selectedRef, evidenceRef, templateRef], visualOutput);
  addStage(stages, {
    stage: "visual-direction",
    status: "completed",
    agentIds: ["visual-director"],
    inputArtifactIds: [selectedRef.artifactId, evidenceRef.artifactId, templateRef.artifactId],
    outputArtifactIds: [visualRef.artifactId],
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  const variantIds: VariantId[] = ["compact", "balanced", "visual"];
  const variantInputs = variantIds.map((variant) => variantDesignerInputSchema.parse({
    variant,
    narrative: selectedNarrative,
    visuals: visualOutput,
    template: templateOutput,
    evidence: evidenceOutput,
  }));
  const variantOutputs = await Promise.all(variantIds.map((variant, index) => Promise.resolve(
    variantPlanSchema.parse(runDeterministicMockAgent(`variant-designer-${variant}` as AgentId, variantInputs[index])),
  )));
  const variantRefs = variantIds.map((variant, index) => makeRef(`artifact-variants-${variant}`, "variant", `variants/${variant}.json`, variantOutputs[index]));
  variantIds.forEach((variant, index) => {
    graph.addAgentOutput(`variant-designer-${variant}` as AgentId, variantRefs[index], [selectedRef, visualRef, evidenceRef, templateRef], variantOutputs[index]);
  });
  addStage(stages, {
    stage: "variant-design",
    status: "completed",
    agentIds: ["variant-designer-compact", "variant-designer-balanced", "variant-designer-visual"],
    inputArtifactIds: [selectedRef.artifactId, visualRef.artifactId, evidenceRef.artifactId, templateRef.artifactId],
    outputArtifactIds: variantRefs.map((ref) => ref.artifactId),
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  const designSystem = parsed.designSystem || createDryRunDesignSystem({
    layouts: parsed.layouts,
    designTokens: parsed.designTokens,
  });
  const materializedVariants = materializeVariantSet({
    designSystem,
    plan: canonicalPlan,
    variantPlans: variantOutputs,
    sourceChunkIds: parsed.sourceChunks.map((chunk) => chunk.chunkId),
    factIds: parsed.sourceArtifacts.flatMap((source) => source.factIds),
  });

  const realRenderEvidence = options.renderEvidenceRoot ? await persistAgentVariantRenders(
    options.renderEvidenceRoot,
    parsed.runId,
    Object.fromEntries(materializedVariants.map((item) => [item.variant, item.document])) as Record<LayoutVariant, PresentationDocument>,
  ) : undefined;
  if (realRenderEvidence) await options.onRenderEvidencePersisted?.(realRenderEvidence);

  const renderRefs: SafeArtifactRef[][] = [];
  const auditRefs: SafeArtifactRef[] = [];
  const audits: Array<z.infer<typeof deterministicAuditOutputSchema>> = [];
  for (const [index, variant] of variantIds.entries()) {
    const materialized = materializedVariants[index];
    let variantRenderRefs: SafeArtifactRef[];
    if (realRenderEvidence) {
      const renderedVariant = realRenderEvidence.variants[variant];
      if (!renderedVariant) throw new Error(`Missing ${variant} render evidence`);
      variantRenderRefs = renderedVariant.pages.map((page, pageIndex) => {
        const ref = safeArtifactRefSchema.parse({
          artifactId: `artifact-render-evidence-${variant}-slide-${pageIndex + 1}`,
          kind: "render",
          ...page,
        });
        graph.addBinaryRender(ref, [variantRefs[index]]);
        return ref;
      });
    } else {
      const render = renderPayload(variant, materialized.document);
      const ref = makeRef(
        `artifact-render-evidence-${variant}`,
        "render",
        `render-evidence/${variant}.json`,
        render,
        { render, document: materialized.document },
      );
      graph.addSystemOutput("deterministic-render", ref, [variantRefs[index]], render);
      variantRenderRefs = [ref];
    }
    renderRefs.push(variantRenderRefs);
    const audit = auditPayload(variant, materialized.audit, parsed.fatalAudit);
    const auditRef = makeRef(
      `artifact-audits-${variant}`,
      "audit",
      `audits/${variant}.json`,
      audit,
      { audit, document: materialized.document },
    );
    graph.addSystemOutput("deterministic-audit", auditRef, [variantRefs[index], ...variantRenderRefs], audit);
    auditRefs.push(auditRef);
    audits.push(audit);
  }
  const fatal = audits.some((audit) => audit.fatal);
  addStage(stages, {
    stage: "render-audit",
    status: fatal ? "blocked" : "completed",
    agentIds: [],
    inputArtifactIds: variantRefs.map((ref) => ref.artifactId),
    outputArtifactIds: [...renderRefs.flat(), ...auditRefs].map((ref) => ref.artifactId),
    attempts: 1,
    durationMs: 0,
    validationErrors: fatal ? ["fatal_deterministic_audit"] : [],
  });
  if (fatal) {
    return makeResult({
      runId: parsed.runId,
      status: "failed",
      stages,
      graph,
      published: false,
      publishedArtifactIds: [],
      materializedVariants,
      renderEvidence: realRenderEvidence,
      stopReason: "fatal_deterministic_audit",
    });
  }

  const critiqueOutputs: CritiqueReport[] = [];
  const critiqueRefs: SafeArtifactRef[] = [];
  for (const [index, variant] of variantIds.entries()) {
    if (realRenderEvidence && options.renderEvidenceRoot) {
      await verifyAgentVariantRenders(options.renderEvidenceRoot, realRenderEvidence);
    }
    const criticInput = {
      variant,
      variantPlan: variantOutputs[index],
      auditArtifact: auditRefs[index],
      renderEvidenceRefs: renderRefs[index],
      evidence: evidenceOutput,
    };
    const [semantic, visual] = await Promise.all([
      Promise.resolve(critiqueReportSchema.parse(runDeterministicMockAgent("semantic-critic", criticInput))),
      Promise.resolve(critiqueReportSchema.parse(runDeterministicMockAgent("visual-critic", criticInput))),
    ]);
    const semanticRef = makeRef(`artifact-critiques-${variant}-semantic`, "critique", `critiques/${variant}-semantic.json`, semantic);
    const visualCritiqueRef = makeRef(`artifact-critiques-${variant}-visual`, "critique", `critiques/${variant}-visual.json`, visual);
    graph.addAgentOutput("semantic-critic", semanticRef, [variantRefs[index], auditRefs[index], ...renderRefs[index], evidenceRef], semantic);
    graph.addAgentOutput("visual-critic", visualCritiqueRef, [variantRefs[index], auditRefs[index], ...renderRefs[index], evidenceRef], visual);
    critiqueOutputs.push(semantic, visual);
    critiqueRefs.push(semanticRef, visualCritiqueRef);
  }
  addStage(stages, {
    stage: "critics",
    status: "completed",
    agentIds: ["semantic-critic", "visual-critic"],
    inputArtifactIds: [...variantRefs, ...auditRefs, ...renderRefs.flat(), evidenceRef].map((ref) => ref.artifactId),
    outputArtifactIds: critiqueRefs.map((ref) => ref.artifactId),
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  const repairOutputs: Array<z.infer<typeof repairPlanSchema>> = [];
  const repairRefs: SafeArtifactRef[] = [];
  for (const [index, variant] of variantIds.entries()) {
    const repairInput = repairPlannerInputSchema.parse({
      variant,
      variantPlan: variantOutputs[index],
      deterministicAudit: {
        passed: audits[index].passed,
        fatal: audits[index].fatal,
        issueIds: audits[index].issueIds,
      },
      critiques: [critiqueOutputs[index * 2], critiqueOutputs[index * 2 + 1]],
      round: 1,
    });
    const repair = repairPlanSchema.parse(runDeterministicMockAgent("repair-planner", repairInput));
    const repairRef = makeRef(`artifact-repairs-${variant}`, "repair", `repairs/${variant}-round-1.json`, repair);
    graph.addAgentOutput("repair-planner", repairRef, [variantRefs[index], auditRefs[index], critiqueRefs[index * 2], critiqueRefs[index * 2 + 1]], repair);
    repairOutputs.push(repair);
    repairRefs.push(repairRef);
  }
  addStage(stages, {
    stage: "repair-plans",
    status: "completed",
    agentIds: ["repair-planner"],
    inputArtifactIds: [...variantRefs, ...auditRefs, ...critiqueRefs].map((ref) => ref.artifactId),
    outputArtifactIds: repairRefs.map((ref) => ref.artifactId),
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  const juryInput = finalJuryInputSchema.parse({
    variants: variantOutputs,
    audits: audits.map((audit) => ({
      variant: audit.variant,
      passed: audit.passed,
      fatal: audit.fatal,
      issueIds: audit.issueIds,
    })),
    critiques: critiqueOutputs,
    repairs: repairOutputs,
    evidenceCoverage: evidenceOutput.coverage,
  });
  const ranking = variantRankingSchema.parse(runDeterministicMockAgent("final-jury", juryInput));
  const rankingRef = makeRef("artifact-jury-ranking", "ranking", "jury/ranking.json", ranking);
  graph.addAgentOutput("final-jury", rankingRef, [...variantRefs, ...auditRefs, ...critiqueRefs, ...repairRefs, evidenceRef], ranking);
  addStage(stages, {
    stage: "final-jury",
    status: "completed",
    agentIds: ["final-jury"],
    inputArtifactIds: [...variantRefs, ...auditRefs, ...critiqueRefs, ...repairRefs, evidenceRef].map((ref) => ref.artifactId),
    outputArtifactIds: [rankingRef.artifactId],
    attempts: 1,
    durationMs: 0,
    validationErrors: [],
  });

  return makeResult({
    runId: parsed.runId,
    status: "completed",
    stages,
    graph,
    published: true,
    publishedArtifactIds: [...variantRefs, ...auditRefs, rankingRef].map((ref) => ref.artifactId),
    materializedVariants,
    renderEvidence: realRenderEvidence,
  });
}

function makeResult(input: {
  runId: string;
  status: "completed" | "failed";
  stages: AgentStageRun[];
  graph: BoundedAgentArtifactGraph;
  published: boolean;
  publishedArtifactIds: string[];
  materializedVariants: MaterializedVariant[];
  renderEvidence?: AgentVariantRenderSet;
  stopReason?: "fatal_deterministic_audit";
}): AgentDryRunResult {
  const manifest = agentRunManifestSchema.parse({
    version: "v1",
    runId: input.runId,
    mode: input.renderEvidence ? "local-render" : "dry-run",
    status: input.status,
    agentRegistryVersion: 1,
    providerCalls: false,
    networkCalls: false,
    filesystemMutationAuthority: Boolean(input.renderEvidence),
    stages: input.stages,
    graph: input.graph.toManifest(),
    published: input.published,
    publishedArtifactIds: input.publishedArtifactIds,
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
  });
  return agentDryRunResultSchema.parse({
    manifest,
    providerCalls: false,
    networkCalls: false,
    materializedVariants: input.materializedVariants,
    ...(input.renderEvidence ? { renderEvidence: input.renderEvidence } : {}),
  });
}

function publishedJuryArtifactRef(
  artifactId: string,
  kind: "plan" | "variant" | "audit",
  reference: ArtifactReference,
) {
  return {
    artifactId,
    kind,
    relativePath: reference.relativePath,
    byteSize: reference.byteSize,
    sha256: reference.sha256,
  };
}

/**
 * Rank the exact generation artifacts already saved by ArtifactStore. This
 * function has no planning, rendering, layout or materialization path.
 */
export function runPublishedGenerationJury(saved: SavedGenerationArtifactsForJury): {
  ranking: PublishedVariantRanking;
  stages: ReturnType<typeof generationStageTraceSchema.parse>;
} {
  const variants: LayoutVariant[] = ["compact", "balanced", "visual"];
  const sourceArtifactRefs = {
    canonicalPlan: publishedJuryArtifactRef("artifact-planning-canonical", "plan", saved.references.plan),
    variants: variants.map((variant) => ({
      variant,
      artifact: publishedJuryArtifactRef(`artifact-variants-${variant}`, "variant", saved.references.variants[variant]),
    })),
    audits: variants.map((variant) => ({
      variant,
      artifact: publishedJuryArtifactRef(`artifact-audits-${variant}`, "audit", saved.references.audits[variant]),
    })),
  };
  const canonicalSlideIds = saved.plan.slides.map((slide) => slide.id);
  const input = publishedGenerationJuryInputSchema.parse({
    sourceArtifactRefs,
    canonicalSlideIds,
    variants: variants.map((variant) => ({
      variant,
      slideIds: saved.variants[variant].slides.map((slide) => slide.id),
      elementCount: saved.variants[variant].slides.reduce((total, slide) => total + slide.canvas.elements.length, 0),
    })),
    audits: variants.map((variant) => {
      const report = saved.audits[variant];
      const issues = report.slides.flatMap((slide) => slide.issues);
      return {
        variant,
        slideIds: report.slides.map((slide) => slide.slideId),
        passed: report.passed,
        issueCount: Math.min(10_000, issues.length),
        warningCount: Math.min(10_000, issues.filter((issue) => issue.severity === "warning").length),
        errorCount: Math.min(10_000, issues.filter((issue) => issue.severity === "error").length),
      };
    }),
  });

  const baseScores: Record<LayoutVariant, number> = { compact: 84, balanced: 92, visual: 88 };
  const rankedVariants = input.variants.map((variant) => {
    const audit = input.audits.find((entry) => entry.variant === variant.variant)!;
    const auditScore = Math.max(0, 100 - audit.errorCount * 18 - audit.warningCount * 5 - Math.max(0, audit.issueCount - audit.errorCount - audit.warningCount));
    const averageElements = variant.elementCount / variant.slideIds.length;
    const structureScore = Math.max(0, Math.min(100, Math.round(100 - Math.abs(averageElements - 12) * 2)));
    const score = Math.max(0, Math.min(100, Math.round(
      baseScores[variant.variant] + (auditScore - 100) * 0.6 + (structureScore - 100) * 0.15,
    )));
    return {
      variant: variant.variant,
      score,
      deterministicAuditScore: auditScore,
      advisoryScore: structureScore,
      rationale: "Deterministic ranking uses the published document structure and its persisted audit metrics",
    };
  }).sort((left, right) => right.score - left.score || left.variant.localeCompare(right.variant, "en"));

  const ranking = publishedVariantRankingSchema.parse({
    version: "v1",
    rankedVariants,
    recommendedVariant: rankedVariants[0].variant,
    blockingReasons: [],
    remainingUserVisibleIssues: [],
    sourceArtifactRefs: input.sourceArtifactRefs,
  });
  const planId = input.sourceArtifactRefs.canonicalPlan.artifactId;
  const variantIds = input.sourceArtifactRefs.variants.map((entry) => entry.artifact.artifactId);
  const auditIds = input.sourceArtifactRefs.audits.map((entry) => entry.artifact.artifactId);
  const stages = generationStageTraceSchema.parse([
    { stage: "narrative-selection", status: "completed", agentIds: [], inputArtifactIds: [], outputArtifactIds: [planId], attempts: 1, durationMs: 0 },
    { stage: "variant-design", status: "completed", agentIds: [], inputArtifactIds: [planId], outputArtifactIds: variantIds, attempts: 1, durationMs: 0 },
    { stage: "render-audit", status: "completed", agentIds: [], inputArtifactIds: variantIds, outputArtifactIds: auditIds, attempts: 1, durationMs: 0 },
    { stage: "final-jury", status: "completed", agentIds: ["final-jury"], inputArtifactIds: [planId, ...variantIds, ...auditIds], outputArtifactIds: ["artifact-jury-ranking"], attempts: 1, durationMs: 0 },
  ]);
  return { ranking, stages };
}

export function validateAgentDryRunResult(result: unknown): AgentDryRunResult {
  return agentDryRunResultSchema.parse(result);
}

export function getDryRunAgentVersions() {
  return getActiveAgentVersions();
}
