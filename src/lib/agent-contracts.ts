import { z } from "zod";

const agentIds = [
  "template-analyst",
  "evidence-analyst",
  "narrative-architect",
  "visual-director",
  "variant-designer-compact",
  "variant-designer-balanced",
  "variant-designer-visual",
  "semantic-critic",
  "visual-critic",
  "repair-planner",
  "final-jury",
] as const;

export const agentIdSchema = z.enum(agentIds);
export type AgentId = z.infer<typeof agentIdSchema>;

export const agentVersionSchema = z.literal("v1");

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const artifactIdSchema = z.string().regex(/^artifact-[a-z0-9][a-z0-9._-]{0,79}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceRefIdsSchema = z.object({
  sourceChunkIds: z.array(identifierSchema).max(50),
  factIds: z.array(identifierSchema).max(50),
}).strict();

const artifactPathSchema = z.string().regex(
  /^(?:inputs|analysis|planning|variants|audits|render-evidence|critiques|repairs|jury)\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.(?:json|png|pdf)$/i,
);

export const MAX_AGENT_RENDER_ARTIFACT_BYTES = 32_000_000;
const localRenderPagePath = /^render-evidence\/(?:compact|balanced|visual)\/slide-(?:[1-9]|1[0-5])\.png$/;

export const safeArtifactRefSchema = z.object({
  artifactId: artifactIdSchema,
  kind: z.enum(["input", "source", "analysis", "plan", "variant", "render", "audit", "critique", "repair", "ranking"]),
  relativePath: artifactPathSchema,
  sha256: sha256Schema,
  byteSize: z.number().int().nonnegative().max(MAX_AGENT_RENDER_ARTIFACT_BYTES),
}).strict().superRefine((ref, context) => {
  if (ref.byteSize > 2_000_000 && !(ref.kind === "render" && localRenderPagePath.test(ref.relativePath))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["byteSize"], message: "Artifact reference exceeds byte limit" });
  }
});
export type SafeArtifactRef = z.infer<typeof safeArtifactRefSchema>;

export const agentRefSchema = z.object({
  id: agentIdSchema,
  version: agentVersionSchema,
}).strict();
export type AgentRef = z.infer<typeof agentRefSchema>;

export const systemProducerSchema = z.object({
  kind: z.literal("system"),
  id: z.enum(["input", "narrative-selector", "deterministic-render", "deterministic-audit"]),
  version: agentVersionSchema,
}).strict();
export type SystemProducer = z.infer<typeof systemProducerSchema>;

export const templateLayoutSummarySchema = z.object({
  id: identifierSchema,
  composition: z.enum(["title", "split", "cards", "timeline", "visual", "text", "blank"]),
  textSlots: z.number().int().nonnegative().max(300),
  visualSlots: z.number().int().nonnegative().max(300),
  cardCount: z.number().int().nonnegative().max(300),
}).strict();
export type TemplateLayoutSummary = z.infer<typeof templateLayoutSummarySchema>;

export const templateAnalystInputSchema = z.object({
  templateArtifact: safeArtifactRefSchema,
  renderEvidenceRefs: z.array(safeArtifactRefSchema).max(100),
  layouts: z.array(templateLayoutSummarySchema).min(1).max(80),
  designTokens: z.object({
    colors: z.array(z.string().regex(/^#[0-9A-F]{6}$/i)).max(24),
    headingFonts: z.array(z.string().min(1).max(120)).max(12),
    bodyFonts: z.array(z.string().min(1).max(120)).max(12),
  }).strict(),
}).strict();
export type TemplateAnalystInput = z.infer<typeof templateAnalystInputSchema>;

export const evidenceSourceSummarySchema = z.object({
  artifact: safeArtifactRefSchema,
  sourceId: identifierSchema,
  sourceChunkIds: z.array(identifierSchema).max(50),
  factIds: z.array(identifierSchema).max(50),
}).strict();
export type EvidenceSourceSummary = z.infer<typeof evidenceSourceSummarySchema>;

export const sourceChunkSummarySchema = z.object({
  chunkId: identifierSchema,
  sourceId: identifierSchema,
  excerpt: z.string().min(1).max(280),
  precision: z.enum(["exact", "document"]),
}).strict();
export type SourceChunkSummary = z.infer<typeof sourceChunkSummarySchema>;

export const evidenceAnalystInputSchema = z.object({
  brief: z.string().min(2).max(2_000),
  sources: z.array(evidenceSourceSummarySchema).max(12),
  sourceChunks: z.array(sourceChunkSummarySchema).max(200),
}).strict();
export type EvidenceAnalystInput = z.infer<typeof evidenceAnalystInputSchema>;

export const templateLayoutFamilySchema = z.object({
  id: identifierSchema,
  purpose: z.enum(["title", "split", "cards", "timeline", "visual", "text", "blank"]),
  confidence: z.number().min(0).max(1),
  reusable: z.literal(true),
  riskCodes: z.array(z.enum(["low_capacity", "high_density", "sparse_visuals"])).max(3),
}).strict();

export const templateInterpretationSchema = z.object({
  version: z.literal("v1"),
  layoutFamilies: z.array(templateLayoutFamilySchema).min(1).max(20),
  typography: z.object({
    headingRoles: z.array(z.string().min(1).max(80)).max(12),
    bodyRoles: z.array(z.string().min(1).max(80)).max(12),
    densityGuidance: z.enum(["compact", "balanced", "airy"]),
  }).strict(),
  spacingGuidance: z.enum(["tight", "regular", "generous"]),
  prohibitedCompositions: z.array(z.string().min(1).max(160)).max(20),
  risks: z.array(z.string().min(1).max(240)).max(20),
}).strict();
export type TemplateInterpretation = z.infer<typeof templateInterpretationSchema>;

const evidenceClaimSchema = z.object({
  id: identifierSchema,
  text: z.string().min(1).max(280),
  priority: z.number().int().min(0).max(3),
  precision: z.enum(["exact", "document"]),
  sourceRefs: sourceRefIdsSchema,
}).strict().superRefine((claim, context) => {
  if (claim.sourceRefs.sourceChunkIds.length === 0 && claim.sourceRefs.factIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRefs"], message: "Every evidence claim must be traceable" });
  }
});

export const evidencePackSchema = z.object({
  version: z.literal("v1"),
  claims: z.array(evidenceClaimSchema).max(40),
  contradictions: z.array(z.object({
    id: identifierSchema,
    summary: z.string().min(1).max(280),
    sourceRefs: sourceRefIdsSchema,
  }).strict()).max(20),
  unsupported: z.array(z.object({
    id: identifierSchema,
    summary: z.string().min(1).max(280),
  }).strict()).max(20),
  coverage: z.object({
    total: z.number().int().nonnegative().max(40),
    grounded: z.number().int().nonnegative().max(40),
  }).strict(),
}).strict().superRefine((pack, context) => {
  const ids = new Set<string>();
  for (const [index, claim] of pack.claims.entries()) {
    if (ids.has(claim.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["claims", index, "id"], message: "Evidence claim ids must be unique" });
    ids.add(claim.id);
  }
  if (pack.coverage.total !== pack.claims.length || pack.coverage.grounded !== pack.claims.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage"], message: "Dry-run evidence coverage must match traceable claims" });
  }
});
export type EvidencePack = z.infer<typeof evidencePackSchema>;

const purposeSchema = z.enum([
  "title", "problem", "context", "opportunity", "solution", "workflow", "advantages", "implementation", "metrics", "next_steps", "summary",
]);
const visualIntentSchema = z.enum(["none", "diagram", "cards", "timeline", "image", "metrics"]);

export const narrativeArchitectInputSchema = z.object({
  brief: z.string().min(2).max(2_000),
  template: templateInterpretationSchema,
  evidence: evidencePackSchema,
  slideCount: z.number().int().min(5).max(15),
}).strict();
export type NarrativeArchitectInput = z.infer<typeof narrativeArchitectInputSchema>;

const narrativeSlideSchema = z.object({
  id: identifierSchema,
  purpose: purposeSchema,
  title: z.string().min(1).max(160),
  message: z.string().min(1).max(280),
  claimIds: z.array(identifierSchema).max(6),
  sourceRefs: sourceRefIdsSchema,
  visualIntent: visualIntentSchema,
  nextTransition: z.string().min(1).max(200),
}).strict();

export const narrativePlanSchema = z.object({
  version: z.literal("v1"),
  planId: identifierSchema,
  title: z.string().min(1).max(180),
  audience: z.string().min(1).max(160),
  objective: z.string().min(1).max(240),
  slides: z.array(narrativeSlideSchema).min(5).max(15),
}).strict();
export type NarrativePlan = z.infer<typeof narrativePlanSchema>;

export const visualDirectorInputSchema = z.object({
  narrative: narrativePlanSchema,
  evidence: evidencePackSchema,
  template: templateInterpretationSchema,
}).strict();
export type VisualDirectorInput = z.infer<typeof visualDirectorInputSchema>;

const visualSpecSchema = z.object({
  slideId: identifierSchema,
  visualType: z.enum(["none", "cards", "timeline", "image", "table", "chart", "diagram"]),
  intent: z.string().min(1).max(240),
  claimIds: z.array(identifierSchema).max(6),
  sourceRefs: sourceRefIdsSchema,
  nativeSafe: z.literal(true),
  fallback: z.enum(["none", "cards", "text"]),
}).strict();

export const visualSpecPackSchema = z.object({
  version: z.literal("v1"),
  specs: z.array(visualSpecSchema).min(5).max(15),
}).strict();
export type VisualSpecPack = z.infer<typeof visualSpecPackSchema>;

export const variantProfileSchema = z.object({
  density: z.enum(["compact", "balanced", "airy"]),
  visualRatio: z.enum(["low", "medium", "high"]),
  dataEmphasis: z.enum(["low", "medium", "high"]),
}).strict();

export const variantIdSchema = z.enum(["compact", "balanced", "visual"]);
export type VariantId = z.infer<typeof variantIdSchema>;

export const variantDesignerInputSchema = z.object({
  variant: variantIdSchema,
  narrative: narrativePlanSchema,
  visuals: visualSpecPackSchema,
  template: templateInterpretationSchema,
  evidence: evidencePackSchema,
}).strict();
export type VariantDesignerInput = z.infer<typeof variantDesignerInputSchema>;

const variantSlideSchema = z.object({
  slideId: identifierSchema,
  layoutId: identifierSchema,
  slotAssignments: z.array(z.object({
    slotId: identifierSchema,
    role: z.enum(["title", "body", "visual", "footer"]),
    claimIds: z.array(identifierSchema).max(6),
  }).strict()).min(1).max(8),
  contentMode: z.enum(["compressed", "balanced", "expanded"]),
}).strict();

export const variantPlanSchema = z.object({
  version: z.literal("v1"),
  variant: variantIdSchema,
  profile: variantProfileSchema,
  slides: z.array(variantSlideSchema).min(5).max(15),
  rationale: z.string().min(1).max(480),
  expectedTradeoff: z.string().min(1).max(240),
}).strict();
export type VariantPlan = z.infer<typeof variantPlanSchema>;

export const criticInputSchema = z.object({
  variant: variantIdSchema,
  variantPlan: variantPlanSchema,
  auditArtifact: safeArtifactRefSchema,
  renderEvidenceRefs: z.array(safeArtifactRefSchema).min(1).max(100),
  evidence: evidencePackSchema,
}).strict();
export type CriticInput = z.infer<typeof criticInputSchema>;

const critiqueFindingSchema = z.object({
  id: identifierSchema,
  severity: z.enum(["info", "warning", "error"]),
  category: z.enum(["grounding", "narrative", "readability", "template_fidelity", "density"]),
  slideId: identifierSchema,
  message: z.string().min(1).max(240),
  evidenceArtifactIds: z.array(artifactIdSchema).max(8),
}).strict();

export const critiqueReportSchema = z.object({
  version: z.literal("v1"),
  variant: variantIdSchema,
  advisoryOnly: z.literal(true),
  findings: z.array(critiqueFindingSchema).max(40),
}).strict();
export type CritiqueReport = z.infer<typeof critiqueReportSchema>;

export const repairPlannerInputSchema = z.object({
  variant: variantIdSchema,
  variantPlan: variantPlanSchema,
  deterministicAudit: z.object({
    passed: z.literal(true),
    fatal: z.literal(false),
    issueIds: z.array(identifierSchema).max(100),
  }).strict(),
  critiques: z.array(critiqueReportSchema).length(2),
  round: z.number().int().min(1).max(2),
}).strict();
export type RepairPlannerInput = z.infer<typeof repairPlannerInputSchema>;

const repairOperationSchema = z.object({
  id: identifierSchema,
  slideId: identifierSchema,
  operation: z.enum(["rewrite", "switch_layout", "reduce_content", "replace_visual_spec"]),
  targetId: identifierSchema.optional(),
  rationale: z.string().min(1).max(240),
}).strict();

export const repairPlanSchema = z.object({
  version: z.literal("v1"),
  variant: variantIdSchema,
  round: z.number().int().min(1).max(2),
  status: z.enum(["no_repair", "repair" ]),
  operations: z.array(repairOperationSchema).max(20),
}).strict().superRefine((plan, context) => {
  if (plan.status === "no_repair" && plan.operations.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["operations"], message: "No-repair plans must not contain operations" });
  }
});
export type RepairPlan = z.infer<typeof repairPlanSchema>;

export const finalJuryInputSchema = z.object({
  variants: z.array(variantPlanSchema).length(3),
  audits: z.array(z.object({
    variant: variantIdSchema,
    passed: z.literal(true),
    fatal: z.literal(false),
    issueIds: z.array(identifierSchema).max(100),
  }).strict()).length(3),
  critiques: z.array(critiqueReportSchema).length(6),
  repairs: z.array(repairPlanSchema).length(3),
  evidenceCoverage: z.object({
    total: z.number().int().nonnegative().max(40),
    grounded: z.number().int().nonnegative().max(40),
  }).strict(),
}).strict();
export type FinalJuryInput = z.infer<typeof finalJuryInputSchema>;

const variantRankingShapeSchema = z.object({
  version: z.literal("v1"),
  rankedVariants: z.array(z.object({
    variant: variantIdSchema,
    score: z.number().min(0).max(100),
    deterministicAuditScore: z.number().min(0).max(100),
    advisoryScore: z.number().min(0).max(100),
    rationale: z.string().min(1).max(240),
  }).strict()).length(3),
  recommendedVariant: variantIdSchema,
  blockingReasons: z.array(z.string().min(1).max(240)).max(20),
  remainingUserVisibleIssues: z.array(z.string().min(1).max(240)).max(20),
}).strict();

function ensureEveryVariantIsRanked(
  ranking: { rankedVariants: Array<{ variant: VariantId }> },
  context: z.RefinementCtx,
) {
  if (new Set(ranking.rankedVariants.map((item) => item.variant)).size !== 3) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["rankedVariants"], message: "Jury must rank all three variants exactly once" });
  }
}

export const variantRankingSchema = variantRankingShapeSchema.superRefine(ensureEveryVariantIsRanked);
export type VariantRanking = z.infer<typeof variantRankingSchema>;

const publishedJuryArtifactReferenceSchema = z.object({
  artifactId: artifactIdSchema,
  kind: z.enum(["plan", "variant", "audit"]),
  relativePath: z.string().regex(/^(?:planning\/plan\.json|variants\/(?:compact|balanced|visual)\.json|audit\/(?:compact|balanced|visual)\.json)$/),
  sha256: sha256Schema,
  byteSize: z.number().int().nonnegative(),
}).strict().superRefine((reference, context) => {
  const valid = reference.kind === "plan"
    ? reference.artifactId === "artifact-planning-canonical" && reference.relativePath === "planning/plan.json"
    : reference.kind === "variant"
      ? (reference.artifactId === "artifact-variants-compact" && reference.relativePath === "variants/compact.json")
        || (reference.artifactId === "artifact-variants-balanced" && reference.relativePath === "variants/balanced.json")
        || (reference.artifactId === "artifact-variants-visual" && reference.relativePath === "variants/visual.json")
      : (reference.artifactId === "artifact-audits-compact" && reference.relativePath === "audit/compact.json")
        || (reference.artifactId === "artifact-audits-balanced" && reference.relativePath === "audit/balanced.json")
        || (reference.artifactId === "artifact-audits-visual" && reference.relativePath === "audit/visual.json");
  if (!valid) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["relativePath"], message: "Jury references must identify the canonical published generation artifact" });
  }
});

export const publishedJurySourceArtifactRefsSchema = z.object({
  canonicalPlan: publishedJuryArtifactReferenceSchema,
  variants: z.array(z.object({ variant: variantIdSchema, artifact: publishedJuryArtifactReferenceSchema }).strict()).length(3),
  audits: z.array(z.object({ variant: variantIdSchema, artifact: publishedJuryArtifactReferenceSchema }).strict()).length(3),
}).strict().superRefine((references, context) => {
  for (const variant of ["compact", "balanced", "visual"] as const) {
    const variantEntry = references.variants.find((entry) => entry.variant === variant);
    const auditEntry = references.audits.find((entry) => entry.variant === variant);
    if (variantEntry?.artifact.kind !== "variant" || variantEntry.artifact.artifactId !== `artifact-variants-${variant}`) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Every published variant must have its own exact artifact reference" });
    }
    if (auditEntry?.artifact.kind !== "audit" || auditEntry.artifact.artifactId !== `artifact-audits-${variant}`) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["audits"], message: "Every published audit must have its own exact artifact reference" });
    }
  }
});

export const publishedGenerationJuryInputSchema = z.object({
  sourceArtifactRefs: publishedJurySourceArtifactRefsSchema,
  canonicalSlideIds: z.array(z.string().min(1).max(120)).min(5).max(15),
  variants: z.array(z.object({
    variant: variantIdSchema,
    slideIds: z.array(z.string().min(1).max(120)).min(5).max(15),
    elementCount: z.number().int().nonnegative().max(3_000),
  }).strict()).length(3),
  audits: z.array(z.object({
    variant: variantIdSchema,
    slideIds: z.array(z.string().min(1).max(120)).min(5).max(15),
    passed: z.literal(true),
    issueCount: z.number().int().nonnegative().max(10_000),
    warningCount: z.number().int().nonnegative().max(10_000),
    errorCount: z.number().int().nonnegative().max(10_000),
  }).strict()).length(3),
}).strict().superRefine((input, context) => {
  const variants = new Set(input.variants.map((entry) => entry.variant));
  const audits = new Set(input.audits.map((entry) => entry.variant));
  if (variants.size !== 3 || !(["compact", "balanced", "visual"] as const).every((variant) => variants.has(variant))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Jury input must contain all three published variants exactly once" });
  }
  if (audits.size !== 3 || !(["compact", "balanced", "visual"] as const).every((variant) => audits.has(variant))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["audits"], message: "Jury input must contain all three published audits exactly once" });
  }
  for (const variant of input.variants) {
    if (variant.slideIds.length !== input.canonicalSlideIds.length || variant.slideIds.some((slideId, index) => slideId !== input.canonicalSlideIds[index])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Published variant slides must match the canonical plan" });
    }
  }
  for (const audit of input.audits) {
    if (audit.slideIds.length !== input.canonicalSlideIds.length || audit.slideIds.some((slideId, index) => slideId !== input.canonicalSlideIds[index])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["audits"], message: "Published audit slides must match the canonical plan" });
    }
  }
});
export type PublishedGenerationJuryInput = z.infer<typeof publishedGenerationJuryInputSchema>;

export const publishedVariantRankingSchema = variantRankingShapeSchema.extend({
  sourceArtifactRefs: publishedJurySourceArtifactRefsSchema,
}).strict().superRefine(ensureEveryVariantIsRanked);
export type PublishedVariantRanking = z.infer<typeof publishedVariantRankingSchema>;

export const deterministicRenderOutputSchema = z.object({
  version: z.literal("v1"),
  variant: variantIdSchema,
  slideIds: z.array(identifierSchema).min(5).max(15),
  nativeObjectsOnly: z.literal(true),
  providerCalls: z.literal(false),
}).strict();
export type DeterministicRenderOutput = z.infer<typeof deterministicRenderOutputSchema>;

export const deterministicAuditOutputSchema = z.object({
  version: z.literal("v1"),
  variant: variantIdSchema,
  passed: z.boolean(),
  fatal: z.boolean(),
  issueIds: z.array(identifierSchema).max(100),
  providerCalls: z.literal(false),
}).strict();
export type DeterministicAuditOutput = z.infer<typeof deterministicAuditOutputSchema>;

export const agentInputSchemas = {
  "template-analyst": templateAnalystInputSchema,
  "evidence-analyst": evidenceAnalystInputSchema,
  "narrative-architect": narrativeArchitectInputSchema,
  "visual-director": visualDirectorInputSchema,
  "variant-designer-compact": variantDesignerInputSchema,
  "variant-designer-balanced": variantDesignerInputSchema,
  "variant-designer-visual": variantDesignerInputSchema,
  "semantic-critic": criticInputSchema,
  "visual-critic": criticInputSchema,
  "repair-planner": repairPlannerInputSchema,
  "final-jury": finalJuryInputSchema,
} as const;

export const agentOutputSchemas = {
  "template-analyst": templateInterpretationSchema,
  "evidence-analyst": evidencePackSchema,
  "narrative-architect": narrativePlanSchema,
  "visual-director": visualSpecPackSchema,
  "variant-designer-compact": variantPlanSchema,
  "variant-designer-balanced": variantPlanSchema,
  "variant-designer-visual": variantPlanSchema,
  "semantic-critic": critiqueReportSchema,
  "visual-critic": critiqueReportSchema,
  "repair-planner": repairPlanSchema,
  "final-jury": variantRankingSchema,
} as const;

export type AgentInput = {
  [K in AgentId]: z.infer<(typeof agentInputSchemas)[K]>
}[AgentId];
export type AgentOutput = {
  [K in AgentId]: z.infer<(typeof agentOutputSchemas)[K]>
}[AgentId];

export function validateAgentInput(id: AgentId, value: unknown): AgentInput {
  return agentInputSchemas[id].parse(value) as AgentInput;
}

export function validateAgentOutput(id: AgentId, value: unknown): AgentOutput {
  return agentOutputSchemas[id].parse(value) as AgentOutput;
}

export function getAgentInputSchema(id: AgentId) {
  return agentInputSchemas[id];
}

export function getAgentOutputSchema(id: AgentId) {
  return agentOutputSchemas[id];
}

export { agentIds };
