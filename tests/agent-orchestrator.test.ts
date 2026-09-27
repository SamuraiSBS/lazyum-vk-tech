import { describe, expect, it } from "vitest";
import {
  AgentOrchestrationError,
  type AgentDryRunRequest,
  runPublishedGenerationJury,
  runAgentDryRun,
  validateAgentDryRunResult,
} from "../src/lib/agent-orchestrator";
import { AgentArtifactGraphError, BoundedAgentArtifactGraph } from "../src/lib/agent-artifact-graph";
import { runDeterministicMockAgent } from "../src/lib/agent-mock-runner";
import { variantRankingSchema } from "../src/lib/agent-contracts";
import type { ArtifactReference, AuditReport, LayoutVariant, PresentationDocument } from "../src/lib/schemas";

const ref = (artifactId: string, kind: "input" | "source" | "render" = "input", relativePath = "inputs/item.json") => ({
  artifactId,
  kind,
  relativePath,
  sha256: "a".repeat(64),
  byteSize: 24,
});

function request(overrides: Partial<AgentDryRunRequest> = {}): AgentDryRunRequest {
  const base: AgentDryRunRequest = {
    runId: "HACK-20260922-1027-p0-12-1",
    brief: "Проверяемая презентация для команды",
    slideCount: 5,
    templateArtifactRef: ref("artifact-input-template"),
    renderEvidenceRefs: [ref("artifact-render-template", "render", "render-evidence/template-1.png")],
    layouts: [
      { id: "layout-title", composition: "title", textSlots: 2, visualSlots: 0, cardCount: 0 },
      { id: "layout-cards", composition: "cards", textSlots: 4, visualSlots: 1, cardCount: 3 },
    ],
    designTokens: { colors: ["#112233"], headingFonts: ["Arial"], bodyFonts: ["Arial"] },
    sourceArtifacts: [{
      artifact: ref("artifact-source-1", "source", "inputs/source-1.json"),
      sourceId: "source-1",
      sourceChunkIds: ["chunk-1"],
      factIds: ["fact-1"],
    }],
    sourceChunks: [{ chunkId: "chunk-1", sourceId: "source-1", excerpt: "Проверяемый факт", precision: "exact" }],
    fatalAudit: false,
  };
  return { ...base, ...overrides };
}

describe("P0-12.1 deterministic agent orchestrator", () => {
  it("executes the complete DAG deterministically and persists bounded validated outputs", async () => {
    const [first, second] = await Promise.all([runAgentDryRun(request()), runAgentDryRun(request())]);
    expect(JSON.stringify(first.manifest)).toBe(JSON.stringify(second.manifest));
    expect(validateAgentDryRunResult(first)).toEqual(first);
    expect(
      first.manifest.status,
      JSON.stringify(first.materializedVariants.map((item) => ({
        variant: item.variant,
        passed: item.audit.passed,
        issues: item.audit.slides.flatMap((slide) => slide.issues.map((issue) => ({
          slideId: slide.slideId,
          type: issue.type,
          elementId: issue.elementId,
          message: issue.message,
          element: item.document.slides.find((candidate) => candidate.id === slide.slideId)?.canvas.elements.find((element) => element.id === issue.elementId),
          relatedElement: item.document.slides.find((candidate) => candidate.id === slide.slideId)?.canvas.elements.find((element) => issue.message.includes(element.id) && element.id !== issue.elementId),
        }))),
      }))),
    ).toBe("completed");
    expect(first.manifest.published).toBe(true);
    expect(first.manifest.providerCalls).toBe(false);
    expect(first.manifest.networkCalls).toBe(false);
    expect(first.manifest.filesystemMutationAuthority).toBe(false);
    expect(first.materializedVariants).toHaveLength(3);
    expect(first.materializedVariants.map((item) => item.variant)).toEqual(["compact", "balanced", "visual"]);
    expect(first.materializedVariants.every((item) => item.document.slides.length === 5)).toBe(true);
    expect(new Set(first.materializedVariants.map((item) => item.geometryFingerprint.digest)).size).toBe(3);
    expect(first.materializedVariants.every((item) => item.audit.passed)).toBe(true);
    expect(first.manifest.stages.map((stage) => stage.stage)).toEqual([
      "inputs", "specialists", "narrative-candidates", "narrative-selection", "visual-direction",
      "variant-design", "render-audit", "critics", "repair-plans", "final-jury",
    ]);
    expect(first.manifest.graph.artifacts).toHaveLength(28);
    const rankingArtifact = first.manifest.graph.artifacts.find((artifact) => artifact.ref.kind === "ranking");
    expect(variantRankingSchema.parse(rankingArtifact?.output).recommendedVariant).toBe("balanced");
    expect(rankingArtifact?.parentRefs.map((ref) => ref.artifactId)).toEqual(expect.arrayContaining([
      "artifact-variants-compact", "artifact-variants-balanced", "artifact-variants-visual",
      "artifact-audits-compact", "artifact-audits-balanced", "artifact-audits-visual",
    ]));
    expect(first.manifest.graph.artifacts.every((artifact) => artifact.ref.relativePath.includes("/"))).toBe(true);
    const serialized = JSON.stringify(first.manifest);
    expect(serialized).not.toContain("providerResponse");
    expect(serialized).not.toContain("hiddenReasoning");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("C:\\\\");
    expect(first.manifest.graph.artifacts.every((artifact) => artifact.output === null || typeof artifact.output === "object")).toBe(true);
    const evidenceArtifact = first.manifest.graph.artifacts.find((artifact) => artifact.producer.id === "evidence-analyst");
    expect(evidenceArtifact?.output).toMatchObject({ version: "v1", coverage: { grounded: 1 } });
    expect((evidenceArtifact?.output as { claims: Array<{ sourceRefs: unknown }> }).claims[0]?.sourceRefs).toEqual({
      sourceChunkIds: ["chunk-1"],
      factIds: ["fact-1"],
    });
  });

  it("binds ranking and trace to the exact saved canonical plan, documents and audits", async () => {
    const dryRun = await runAgentDryRun(request());
    const documents = Object.fromEntries(dryRun.materializedVariants.map((variant) => [variant.variant, structuredClone(variant.document)])) as Record<LayoutVariant, PresentationDocument>;
    const canonicalPlan = documents.balanced.plan;
    const emptyAudit = (document: PresentationDocument): AuditReport => ({
      passed: true,
      slides: document.slides.map((slide) => ({ slideId: slide.id, issues: [] })),
    });
    const audits: Record<LayoutVariant, AuditReport> = {
      compact: emptyAudit(documents.compact),
      balanced: emptyAudit(documents.balanced),
      visual: emptyAudit(documents.visual),
    };
    const reference = (relativePath: string, hash: string): ArtifactReference => ({
      relativePath,
      byteSize: 128,
      sha256: hash.repeat(64),
    });
    const saved = {
      plan: canonicalPlan,
      variants: documents,
      audits,
      references: {
        plan: reference("planning/plan.json", "a"),
        variants: {
          compact: reference("variants/compact.json", "b"),
          balanced: reference("variants/balanced.json", "c"),
          visual: reference("variants/visual.json", "d"),
        },
        audits: {
          compact: reference("audit/compact.json", "e"),
          balanced: reference("audit/balanced.json", "f"),
          visual: reference("audit/visual.json", "1"),
        },
      },
    };
    const original = runPublishedGenerationJury(saved);
    const altered = structuredClone(saved);
    const firstElement = altered.variants.compact.slides[0].canvas.elements[0];
    if (!firstElement) throw new Error("Expected a materialized compact slide element");
    altered.variants.compact.slides[0].canvas.elements.push({ ...firstElement, id: "published-jury-only-element" });
    for (let index = 0; index < 20; index += 1) {
      altered.audits.compact.slides[0].issues.push({
        type: "SMALL_TEXT",
        severity: "warning",
        elementId: "published-jury-only-element",
        message: "Persisted audit metric",
      });
    }
    const rankedPublished = runPublishedGenerationJury(altered);
    const originalCompact = original.ranking.rankedVariants.find((entry) => entry.variant === "compact")!;
    const publishedCompact = rankedPublished.ranking.rankedVariants.find((entry) => entry.variant === "compact")!;

    expect(publishedCompact.deterministicAuditScore).toBe(0);
    expect(publishedCompact.score).toBeLessThan(originalCompact.score);
    expect(rankedPublished.ranking.recommendedVariant).not.toBe("compact");
    expect(rankedPublished.ranking.sourceArtifactRefs.variants.find((entry) => entry.variant === "compact")?.artifact.sha256)
      .toBe(saved.references.variants.compact.sha256);
    expect(rankedPublished.ranking.sourceArtifactRefs.audits.find((entry) => entry.variant === "compact")?.artifact.sha256)
      .toBe(saved.references.audits.compact.sha256);
    expect(rankedPublished.stages.find((stage) => stage.stage === "final-jury")?.inputArtifactIds).toEqual(expect.arrayContaining([
      "artifact-planning-canonical",
      "artifact-variants-compact", "artifact-variants-balanced", "artifact-variants-visual",
      "artifact-audits-compact", "artifact-audits-balanced", "artifact-audits-visual",
    ]));
    expect(JSON.stringify(rankedPublished.stages)).not.toContain("Persisted audit metric");
  });

  it("fails closed on missing source refs before executing the DAG", async () => {
    await expect(runAgentDryRun(request({
      sourceChunks: [{ chunkId: "missing-chunk", sourceId: "source-1", excerpt: "fact", precision: "exact" }],
    }))).rejects.toThrow(AgentOrchestrationError);
    await expect(runAgentDryRun(request({
      sourceArtifacts: [{
        artifact: ref("artifact-source-1", "source", "inputs/source-1.json"),
        sourceId: "source-1",
        sourceChunkIds: [],
        factIds: [],
      }],
    }))).rejects.toThrow("missing_source_chunk_ref");
  });

  it("stops before critics, repair and jury on a fatal deterministic audit", async () => {
    const result = await runAgentDryRun(request({ fatalAudit: true }));
    expect(result.manifest.status).toBe("failed");
    expect(result.manifest.published).toBe(false);
    expect(result.manifest.stopReason).toBe("fatal_deterministic_audit");
    expect(result.manifest.stages.at(-1)?.stage).toBe("render-audit");
    expect(result.manifest.stages.at(-1)?.status).toBe("blocked");
    expect(result.manifest.stages.some((stage) => stage.stage === "critics")).toBe(false);
    expect(result.manifest.graph.artifacts.some((artifact) => artifact.ref.kind === "ranking")).toBe(false);
  });

  it("rejects invalid mock output and missing graph parents", () => {
    const input = {
      templateArtifact: ref("artifact-input-template"),
      renderEvidenceRefs: [],
      layouts: [{ id: "layout-title", composition: "title", textSlots: 1, visualSlots: 0, cardCount: 0 }],
      designTokens: { colors: ["#112233"], headingFonts: ["Arial"], bodyFonts: ["Arial"] },
    };
    expect(() => runDeterministicMockAgent("template-analyst", input, { rawProviderResponse: "secret" })).toThrow();

    const graph = new BoundedAgentArtifactGraph();
    graph.addInput(ref("artifact-input-template"));
    expect(() => graph.addAgentOutput(
      "template-analyst",
      ref("artifact-analysis-template", "input", "analysis/template.json"),
      [ref("artifact-not-present")],
      {},
    )).toThrow(AgentArtifactGraphError);
    expect(() => graph.addAgentOutput(
      "template-analyst",
      ref("artifact-analysis-template", "input", "analysis/template.json"),
      [ref("artifact-input-template")],
      { rawProviderResponse: "secret" },
    )).toThrow("invalid_output");
  });
});
