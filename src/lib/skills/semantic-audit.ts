import { z } from "zod";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const severitySchema = z.enum(["info", "warning", "error"]);
const advisoryCategorySchema = z.enum([
  "content_semantics",
  "citation_traceability",
  "readability",
  "visual_consistency",
]);

export const semanticAuditArtifactRefSchema = z.object({
  artifactId: identifierSchema,
  slideIds: z.array(identifierSchema).min(1).max(100),
}).strict();
export type SemanticAuditArtifactRef = z.infer<typeof semanticAuditArtifactRefSchema>;

export const renderedEvidenceRefSchema = z.object({
  evidenceId: identifierSchema,
  artifactId: identifierSchema,
  slideId: identifierSchema,
  format: z.literal("png"),
  sha256: sha256Schema,
}).strict();
export type RenderedEvidenceRef = z.infer<typeof renderedEvidenceRefSchema>;

export const deterministicAuditFindingSchema = z.object({
  findingId: identifierSchema,
  severity: severitySchema,
  category: advisoryCategorySchema,
  artifactId: identifierSchema,
  slideId: identifierSchema,
  message: z.string().min(1).max(2_000),
  evidenceId: identifierSchema.optional(),
}).strict();
export type DeterministicAuditFinding = z.infer<typeof deterministicAuditFindingSchema>;

export const semanticAuditInputSchema = z.object({
  version: z.literal("v1"),
  artifactRefs: z.array(semanticAuditArtifactRefSchema).min(1).max(50),
  renderedEvidenceRefs: z.array(renderedEvidenceRefSchema).min(1).max(500),
  deterministicFindings: z.array(deterministicAuditFindingSchema).max(1_000),
}).strict();
export type SemanticAuditInput = z.infer<typeof semanticAuditInputSchema>;

export const advisoryFindingSchema = z.object({
  id: z.string().regex(/^semantic-audit:v1:[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
  advisoryStatus: z.literal("advisory"),
  severity: severitySchema,
  category: advisoryCategorySchema,
  slideRef: z.object({
    artifactId: identifierSchema,
    slideId: identifierSchema,
  }).strict(),
  message: z.string().min(1).max(2_000),
  deterministicFindingId: identifierSchema,
  evidenceId: identifierSchema.optional(),
}).strict();
export type AdvisoryFinding = z.infer<typeof advisoryFindingSchema>;

export const semanticAuditOutputSchema = z.object({
  version: z.literal("v1"),
  advisoryOnly: z.literal(true),
  findings: z.array(advisoryFindingSchema).max(1_000),
}).strict();
export type SemanticAuditOutput = z.infer<typeof semanticAuditOutputSchema>;

export class SemanticAuditError extends Error {
  constructor(readonly code:
    | "duplicate_artifact_id"
    | "duplicate_slide_ref"
    | "duplicate_evidence_id"
    | "duplicate_finding_id"
    | "unknown_artifact_ref"
    | "unknown_slide_ref"
    | "inconsistent_slide_artifact_ref"
    | "unknown_evidence_ref"
    | "inconsistent_evidence_ref",
  ) {
    super(code);
    this.name = "SemanticAuditError";
  }
}

/**
 * Pure v1 boundary for advisory-only semantic audit normalization. It consumes
 * pre-validated references and deterministic findings, then emits no verdict,
 * mutation instruction, or export authority.
 */
export function normalizeSemanticAudit(input: unknown): SemanticAuditOutput {
  const parsed = semanticAuditInputSchema.parse(input);
  const artifacts = new Map<string, Set<string>>();

  for (const artifact of parsed.artifactRefs) {
    if (artifacts.has(artifact.artifactId)) throw new SemanticAuditError("duplicate_artifact_id");
    const slideIds = new Set<string>();
    for (const slideId of artifact.slideIds) {
      if (slideIds.has(slideId)) throw new SemanticAuditError("duplicate_slide_ref");
      slideIds.add(slideId);
    }
    artifacts.set(artifact.artifactId, slideIds);
  }

  const evidenceById = new Map<string, RenderedEvidenceRef>();
  for (const evidence of parsed.renderedEvidenceRefs) {
    if (evidenceById.has(evidence.evidenceId)) throw new SemanticAuditError("duplicate_evidence_id");
    assertKnownSlideRef(artifacts, evidence.artifactId, evidence.slideId);
    evidenceById.set(evidence.evidenceId, evidence);
  }

  const findingIds = new Set<string>();
  const findings = parsed.deterministicFindings.map((finding) => {
    if (findingIds.has(finding.findingId)) throw new SemanticAuditError("duplicate_finding_id");
    findingIds.add(finding.findingId);
    assertKnownSlideRef(artifacts, finding.artifactId, finding.slideId);

    if (finding.evidenceId) {
      const evidence = evidenceById.get(finding.evidenceId);
      if (!evidence) throw new SemanticAuditError("unknown_evidence_ref");
      if (evidence.artifactId !== finding.artifactId || evidence.slideId !== finding.slideId) {
        throw new SemanticAuditError("inconsistent_evidence_ref");
      }
    }

    return advisoryFindingSchema.parse({
      id: `semantic-audit:v1:${finding.findingId}`,
      advisoryStatus: "advisory",
      severity: finding.severity,
      category: finding.category,
      slideRef: { artifactId: finding.artifactId, slideId: finding.slideId },
      message: finding.message,
      deterministicFindingId: finding.findingId,
      ...(finding.evidenceId ? { evidenceId: finding.evidenceId } : {}),
    });
  });

  return semanticAuditOutputSchema.parse({
    version: "v1",
    advisoryOnly: true,
    findings: findings.sort((left, right) => left.id.localeCompare(right.id, "en")),
  });
}

function assertKnownSlideRef(
  artifacts: Map<string, Set<string>>,
  artifactId: string,
  slideId: string,
) {
  const slideIds = artifacts.get(artifactId);
  if (!slideIds) throw new SemanticAuditError("unknown_artifact_ref");
  if (slideIds.has(slideId)) return;
  if ([...artifacts.values()].some((candidate) => candidate.has(slideId))) {
    throw new SemanticAuditError("inconsistent_slide_artifact_ref");
  }
  throw new SemanticAuditError("unknown_slide_ref");
}
