import { describe, expect, it } from "vitest";
import { criticInputSchema, critiqueReportSchema, type CriticInput, type VariantId } from "../src/lib/agent-contracts";
import { runDeterministicMockAgent } from "../src/lib/agent-mock-runner";

const artifact = (artifactId: string, kind: "audit" | "render", relativePath: string) => ({
  artifactId, kind, relativePath, sha256: "a".repeat(64), byteSize: 24,
});

function input(variant: VariantId, slideClaims: string[][], evidenceIds = ["claim-1", "claim-2"]): CriticInput {
  return criticInputSchema.parse({
    variant,
    variantPlan: {
      version: "v1", variant,
      profile: { density: "balanced", visualRatio: "medium", dataEmphasis: "medium" },
      slides: slideClaims.map((claimIds, index) => ({
        slideId: `slide-${index + 1}`, layoutId: "layout-1", contentMode: "balanced",
        slotAssignments: [
          { slotId: `title-${index + 1}`, role: "title", claimIds },
          { slotId: `body-${index + 1}`, role: "body", claimIds },
        ],
      })),
      rationale: "Test variant", expectedTradeoff: "Test tradeoff",
    },
    auditArtifact: artifact(`artifact-audit-${variant}`, "audit", `audits/${variant}.json`),
    renderEvidenceRefs: [artifact(`artifact-render-${variant}`, "render", `render-evidence/${variant}.json`)],
    evidence: {
      version: "v1",
      claims: evidenceIds.map((id) => ({
        id, text: `Grounded text for ${id}`, priority: 2, precision: "exact",
        sourceRefs: { sourceChunkIds: [`chunk-${id}`], factIds: [] },
      })),
      contradictions: [], unsupported: [],
      coverage: { total: evidenceIds.length, grounded: evidenceIds.length },
    },
  });
}

function semantic(value: CriticInput) {
  return critiqueReportSchema.parse(runDeterministicMockAgent("semantic-critic", value));
}

describe("deterministic semantic critic", () => {
  it.each(["compact", "balanced", "visual"] as const)("grounds the %s variant with stable, per-slide findings", (variant) => {
    const value = input(variant, [["claim-2", "claim-1"], [], ["claim-2", "claim-2", "claim-1"], ["claim-1"], []]);
    const report = semantic(value);
    expect(report.variant).toBe(variant);
    expect(report.advisoryOnly).toBe(true);
    expect(report.findings.map(({ id, slideId, category }) => [id, slideId, category])).toEqual([
      ["advisory-unbound-2", "slide-2", "grounding"],
      ["advisory-repeated-3-1", "slide-3", "narrative"],
      ["advisory-repeated-3-2", "slide-3", "narrative"],
      ["advisory-repeated-4-1", "slide-4", "narrative"],
      ["advisory-unbound-5", "slide-5", "grounding"],
    ]);
    expect(report.findings[1].message).toContain("claim-1");
    expect(report.findings[2].message).toContain("claim-2");
    expect(report.findings.every((finding) =>
      finding.evidenceArtifactIds.length === 1
      && finding.evidenceArtifactIds[0] === value.auditArtifact.artifactId)).toBe(true);
    expect(semantic(value)).toEqual(report);
    expect(JSON.stringify(report)).not.toMatch(/pixel|clipping|contrast|visual quality/i);
  });

  it("does not flag unbound slides when the evidence pack has no claims", () => {
    const value = input("balanced", [[], [], [], [], []], []);
    expect(semantic(value).findings).toEqual([]);
  });

  it("fails closed for unknown IDs even when the finding limit would already be reached", () => {
    const value = input("compact", Array.from({ length: 15 }, (_, index) =>
      index === 14 ? ["missing-claim"] : ["claim-1", "claim-2"]));
    expect(() => semantic(value)).toThrow("Unknown evidence claim ID missing-claim on slide slide-15");
  });

  it("caps repeat findings at 40 in deterministic slide order", () => {
    const ids = Array.from({ length: 6 }, (_, index) => `claim-${index + 1}`);
    const value = input("visual", Array.from({ length: 15 }, () => ids), ids);
    const report = semantic(value);
    expect(report.findings).toHaveLength(40);
    expect(report.findings[0].id).toBe("advisory-repeated-2-1");
    expect(report.findings.at(-1)?.id).toBe("advisory-repeated-8-4");
    expect(critiqueReportSchema.safeParse(report).success).toBe(true);
  });

  it("preserves the existing visual critic behavior", () => {
    const value = input("balanced", [["claim-1"], [], [], [], []]);
    const report = critiqueReportSchema.parse(runDeterministicMockAgent("visual-critic", value));
    expect(report.findings).toEqual([{
      id: "advisory-observed-capacity", severity: "info", category: "template_fidelity",
      slideId: "slide-1", message: "Mock visual review remains advisory; deterministic geometry is authoritative",
      evidenceArtifactIds: [value.renderEvidenceRefs[0].artifactId],
    }]);
  });
});
