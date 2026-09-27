import { describe, expect, it } from "vitest";
import { finalJuryInputSchema, variantRankingSchema, type FinalJuryInput } from "../src/lib/agent-contracts";
import { runDeterministicMockAgent } from "../src/lib/agent-mock-runner";

const variants = ["compact", "balanced", "visual"] as const;

function input(): FinalJuryInput {
  return finalJuryInputSchema.parse({
    variants: variants.map((variant) => ({
      version: "v1", variant,
      profile: { density: "balanced", visualRatio: "medium", dataEmphasis: "medium" },
      slides: Array.from({ length: 5 }, (_, index) => ({
        slideId: `slide-${index + 1}`, layoutId: "layout-1", contentMode: "balanced",
        slotAssignments: [{ slotId: `slot-${index + 1}`, role: "body", claimIds: [] }],
      })),
      rationale: "Fixture variant", expectedTradeoff: "Fixture tradeoff",
    })),
    audits: variants.map((variant) => ({ variant, passed: true, fatal: false, issueIds: [] })),
    critiques: variants.flatMap((variant) => [1, 2].map(() => ({
      version: "v1", variant, advisoryOnly: true, findings: [],
    }))),
    repairs: variants.map((variant) => ({ version: "v1", variant, round: 1, status: "no_repair", operations: [] })),
    evidenceCoverage: { total: 4, grounded: 4 },
  });
}

function rank(value: FinalJuryInput) {
  return variantRankingSchema.parse(runDeterministicMockAgent("final-jury", value));
}

describe("deterministic mock final jury", () => {
  it("ranks all variants with stable tie priority and schema-valid recommendation", () => {
    const result = rank(input());
    expect(result.rankedVariants.map((entry) => entry.variant)).toEqual(["balanced", "compact", "visual"]);
    expect(result.rankedVariants.every((entry) => entry.score === 100)).toBe(true);
    expect(result.recommendedVariant).toBe(result.rankedVariants[0].variant);
    expect(result.remainingUserVisibleIssues).toEqual([]);
  });

  it("is independent of every input array order", () => {
    const original = input();
    const reversed = structuredClone(original);
    reversed.variants.reverse();
    reversed.audits.reverse();
    reversed.critiques.reverse();
    reversed.repairs.reverse();
    expect(rank(reversed)).toEqual(rank(original));
  });

  it("lowers only the affected variant for audit, advisory and pending repair findings", () => {
    const value = input();
    value.audits[0].issueIds.push("OVERFLOW-1");
    value.critiques.find((critique) => critique.variant === "visual")!.findings.push({
      id: "warning-1", severity: "warning", category: "readability", slideId: "slide-2",
      message: "Text contrast needs review", evidenceArtifactIds: [],
    });
    value.repairs[2] = {
      version: "v1", variant: "visual", round: 1, status: "repair",
      operations: [{ id: "repair-1", slideId: "slide-2", operation: "rewrite", rationale: "Shorten the title" }],
    };
    const result = rank(value);
    const byId = Object.fromEntries(result.rankedVariants.map((entry) => [entry.variant, entry]));
    expect(byId.compact.deterministicAuditScore).toBeLessThan(byId.balanced.deterministicAuditScore);
    expect(byId.visual.advisoryScore).toBeLessThan(byId.balanced.advisoryScore);
    expect(byId.balanced.score).toBe(100);
    expect(result.recommendedVariant).toBe("balanced");
    expect(result.remainingUserVisibleIssues).toEqual(expect.arrayContaining([
      "compact: deterministic audit issue OVERFLOW-1",
      "visual slide-2: Text contrast needs review",
      "visual slide-2: pending rewrite — Shorten the title",
    ]));
  });

  it("uses actual evidence coverage and does not infer pixel defects", () => {
    const value = input();
    value.evidenceCoverage.grounded = 2;
    const result = rank(value);
    expect(result.rankedVariants.every((entry) => entry.score === 95)).toBe(true);
    expect(result.remainingUserVisibleIssues).toEqual(["Evidence coverage: 2/4 grounded"]);
  });

  it("rejects missing, duplicate and cross-variant identities", () => {
    const duplicateAudit = input();
    duplicateAudit.audits[2].variant = "compact";
    expect(() => rank(duplicateAudit)).toThrow();

    const missingCritique = input();
    missingCritique.critiques[5].variant = "compact";
    expect(() => rank(missingCritique)).toThrow();

    const crossVariantSlide = input();
    crossVariantSlide.variants[2].slides[0].slideId = "foreign-slide";
    expect(() => rank(crossVariantSlide)).toThrow();

    const foreignFinding = input();
    foreignFinding.critiques[0].findings.push({
      id: "finding-1", severity: "warning", category: "readability", slideId: "foreign-slide",
      message: "Foreign slide", evidenceArtifactIds: [],
    });
    expect(() => rank(foreignFinding)).toThrow();

    const impossibleCoverage = input();
    impossibleCoverage.evidenceCoverage.grounded = 5;
    expect(() => rank(impossibleCoverage)).toThrow();
  });
});
