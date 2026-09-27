import { describe, expect, it } from "vitest";
import { alignProviderDeckPlan } from "../src/lib/claim-alignment";
import { createPresentationPlan, type LlmProvider } from "../src/lib/planner";
import { normalizeContent } from "../src/lib/content-parser";
import type { ProviderDeckPlan } from "../src/lib/schemas";

describe("provider evidence claim alignment", () => {
  it("turns a valid cited numeric fact into an exact grounded claim", async () => {
    const content = await groundedContent();
    const fact = content.facts?.find((candidate) => candidate.kind === "spreadsheet-cell" && candidate.valueType === "number");
    if (!fact) throw new Error("Expected spreadsheet fact");
    const result = alignProviderDeckPlan(providerPlan("42", {
      sourceChunkIds: [fact.chunkId], factIds: [fact.factId], verbatimEvidence: "42",
    }), content);

    expect(result.slides[0]?.claims[0]).toMatchObject({
      grounding: "grounded",
      precision: "exact",
      sourceRefs: { sourceChunkIds: [fact.chunkId], factIds: [fact.factId] },
    });
    expect(result.groundingSummary).toEqual({ total: 5, grounded: 5, unsupported: 0, rejected: 0, ruleVersion: "evidence-carrying-v1" });
  });

  it("fails closed for invented IDs, mismatched facts and fabricated verbatim evidence", async () => {
    const content = await groundedContent();
    const chunk = content.sourceChunks[0]!;
    const cases = [
      { sourceChunkIds: ["invented-chunk"], factIds: [], verbatimEvidence: "42" },
      { sourceChunkIds: [chunk.chunkId], factIds: ["invented-fact"], verbatimEvidence: "42" },
      { sourceChunkIds: [chunk.chunkId], factIds: [], verbatimEvidence: "not in the source" },
    ];
    for (const citation of cases) {
      const result = alignProviderDeckPlan(providerPlan("42", citation), content);
      expect(result.slides.flatMap((slide) => slide.claims).every((claim) => claim.grounding === "unsupported")).toBe(true);
      expect(result.groundingSummary).toMatchObject({ total: 5, grounded: 0, unsupported: 5, rejected: 5 });
    }
  });

  it("does not treat a paraphrase as grounded without verbatim support", async () => {
    const content = await groundedContent();
    const chunk = content.sourceChunks.find((candidate) => candidate.mimeType === "text/plain");
    if (!chunk) throw new Error("Expected text chunk");
    const result = alignProviderDeckPlan(providerPlan("Команда быстрее принимает решения", {
      sourceChunkIds: [chunk.chunkId], factIds: [], verbatimEvidence: chunk.text,
    }), content);

    expect(result.slides[0]?.claims[0]).toMatchObject({ grounding: "unsupported", groundingReason: "content_not_verbatim_evidence" });
    expect(result.slides[0]?.claims[0]?.sourceRefs).toEqual({ sourceChunkIds: [], factIds: [] });
  });

  it("assigns unique canonical slide and claim IDs when the provider repeats its slide ID", async () => {
    const content = await groundedContent();
    const chunk = content.sourceChunks[0]!;
    const plan = providerPlan(chunk.text, {
      sourceChunkIds: [chunk.chunkId], factIds: [], verbatimEvidence: chunk.text,
    });
    for (const slide of plan.slides) slide.id = "repeated-provider-id";

    const result = alignProviderDeckPlan(plan, content);
    expect(result.slides.map((slide) => slide.id)).toEqual(["slide-1", "slide-2", "slide-3", "slide-4", "slide-5"]);
    expect(result.slides.flatMap((slide) => slide.claims).map((claim) => claim.id)).toEqual([
      "slide-1-claim-1", "slide-2-claim-1", "slide-3-claim-1", "slide-4-claim-1", "slide-5-claim-1",
    ]);
  });

  it("fails a live provider plan closed when every substantive claim is unsupported", async () => {
    const content = await groundedContent();
    const provider: LlmProvider = {
      metadata: {
        provider: "yandex-ai-studio", maxAttempts: 1, attemptsUsed: 1,
        policy: { status: "approved" },
        budget: { inputTokenBudget: 1, outputTokenBudget: 1, totalTokenBudget: 2, estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedTotalTokens: 2 },
        reportedUsage: null, usageUnknown: true,
      },
      async generateStructured<T>() {
        return providerPlan("Непроверяемый пересказ", { sourceChunkIds: [], factIds: [], verbatimEvidence: "" }) as T;
      },
    };
    await expect(createPresentationPlan(content, 5, provider)).rejects.toThrow(/zero grounded substantive content claims/iu);
  });
});

async function groundedContent() {
  return normalizeContent("Evidence alignment", [
    { name: "notes.txt", type: "text/plain", buffer: Buffer.from("Сервис помогает командам быстрее согласовывать решения.") },
    { name: "metrics.csv", type: "text/csv", buffer: Buffer.from("metric,value\nusers,42") },
  ]);
}

function providerPlan(text: string, citation: { sourceChunkIds: string[]; factIds: string[]; verbatimEvidence: string }): ProviderDeckPlan {
  return {
    title: "План",
    slides: Array.from({ length: 5 }, (_, index) => ({
      id: `slide-${index + 1}`,
      purpose: index === 0 ? "title" : "context",
      title: `Слайд ${index + 1}`,
      content: [text],
      visualIntent: "none",
      evidence: [{ contentIndex: 0, ...citation }],
    })),
  };
}
