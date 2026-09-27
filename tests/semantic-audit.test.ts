import { describe, expect, it } from "vitest";
import {
  normalizeSemanticAudit,
  SemanticAuditError,
  semanticAuditInputSchema,
  semanticAuditOutputSchema,
} from "../src/lib/skills/semantic-audit";

const input = {
  version: "v1" as const,
  artifactRefs: [
    { artifactId: "deck-a", slideIds: ["slide-1"] },
    { artifactId: "deck-b", slideIds: ["slide-2"] },
  ],
  renderedEvidenceRefs: [
    { evidenceId: "evidence-1", artifactId: "deck-a", slideId: "slide-1", format: "png" as const, sha256: "a".repeat(64) },
    { evidenceId: "evidence-2", artifactId: "deck-b", slideId: "slide-2", format: "png" as const, sha256: "b".repeat(64) },
  ],
  deterministicFindings: [{
    findingId: "audit-text-overflow-1",
    severity: "warning" as const,
    category: "readability" as const,
    artifactId: "deck-a",
    slideId: "slide-1",
    message: "Body copy may be difficult to read at presentation distance.",
    evidenceId: "evidence-1",
  }],
};

describe("semantic-audit v1", () => {
  it("normalizes a known deterministic finding into an advisory-only finding", () => {
    expect(normalizeSemanticAudit(input)).toEqual({
      version: "v1",
      advisoryOnly: true,
      findings: [{
        id: "semantic-audit:v1:audit-text-overflow-1",
        advisoryStatus: "advisory",
        severity: "warning",
        category: "readability",
        slideRef: { artifactId: "deck-a", slideId: "slide-1" },
        message: "Body copy may be difficult to read at presentation distance.",
        deterministicFindingId: "audit-text-overflow-1",
        evidenceId: "evidence-1",
      }],
    });
  });

  it("rejects authority fields, commands, URLs, binary payloads, and every other extra field", () => {
    expect(() => normalizeSemanticAudit({ ...input, exportDecision: "allow" })).toThrow();
    expect(() => normalizeSemanticAudit({ ...input, renderedEvidenceRefs: [{ ...input.renderedEvidenceRefs[0], url: "https://example.test/render.png" }] })).toThrow();
    expect(() => normalizeSemanticAudit({ ...input, deterministicFindings: [{ ...input.deterministicFindings[0], fix: "resize" }] })).toThrow();
    expect(() => normalizeSemanticAudit({ ...input, deterministicFindings: [{ ...input.deterministicFindings[0], shell: "rm -rf ." }] })).toThrow();
    expect(() => normalizeSemanticAudit({ ...input, renderedEvidenceRefs: [{ ...input.renderedEvidenceRefs[0], bytes: [137, 80, 78, 71] }] })).toThrow();
  });

  it("fails closed for unknown and inconsistent references", () => {
    expect(() => normalizeSemanticAudit({ ...input, deterministicFindings: [{ ...input.deterministicFindings[0], slideId: "missing-slide" }] }))
      .toThrow("unknown_slide_ref");
    expect(() => normalizeSemanticAudit({ ...input, deterministicFindings: [{ ...input.deterministicFindings[0], artifactId: "missing-artifact" }] }))
      .toThrow("unknown_artifact_ref");
    expect(() => normalizeSemanticAudit({ ...input, deterministicFindings: [{ ...input.deterministicFindings[0], artifactId: "deck-a", slideId: "slide-2" }] }))
      .toThrow("inconsistent_slide_artifact_ref");
    expect(() => normalizeSemanticAudit({ ...input, deterministicFindings: [{ ...input.deterministicFindings[0], evidenceId: "missing-evidence" }] }))
      .toThrow("unknown_evidence_ref");
    expect(() => normalizeSemanticAudit({ ...input, deterministicFindings: [{ ...input.deterministicFindings[0], artifactId: "deck-b", slideId: "slide-2", evidenceId: "evidence-1" }] }))
      .toThrow("inconsistent_evidence_ref");
  });

  it("rejects duplicate deterministic finding IDs and duplicate evidence IDs", () => {
    expect(() => normalizeSemanticAudit({
      ...input,
      deterministicFindings: [input.deterministicFindings[0], { ...input.deterministicFindings[0] }],
    })).toThrow(SemanticAuditError);
    expect(() => normalizeSemanticAudit({
      ...input,
      renderedEvidenceRefs: [input.renderedEvidenceRefs[0], { ...input.renderedEvidenceRefs[0] }],
    })).toThrow("duplicate_evidence_id");
  });

  it("is deterministic and cannot become a deterministic audit or export verdict", () => {
    const reversed = {
      ...input,
      deterministicFindings: [
        { ...input.deterministicFindings[0], findingId: "z-finding" },
        { ...input.deterministicFindings[0], findingId: "a-finding" },
      ],
    };
    const result = normalizeSemanticAudit(reversed);

    expect(result).toEqual(normalizeSemanticAudit(reversed));
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "semantic-audit:v1:a-finding",
      "semantic-audit:v1:z-finding",
    ]);
    expect(Object.hasOwn(result, "passed")).toBe(false);
    expect(Object.hasOwn(result, "exportDecision")).toBe(false);
    expect(semanticAuditInputSchema.safeParse({ ...input, passed: true }).success).toBe(false);
    expect(semanticAuditOutputSchema.safeParse({ ...result, passed: false }).success).toBe(false);
    expect(semanticAuditOutputSchema.safeParse({ ...result, exportDecision: "block" }).success).toBe(false);
  });
});
