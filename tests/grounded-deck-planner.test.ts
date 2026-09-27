import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createGroundedDeckPlan } from "../src/lib/skills/grounded-deck-planner";
import type { LlmProvider } from "../src/lib/planner";

describe("grounded-deck-planner v1", () => {
  it("keeps deterministic offline planning compatible and records skill versions", async () => {
    const content = await normalizeContent("Offline plan", [{ name: "notes.txt", type: "text/plain", buffer: Buffer.from("Пилот подтвержден и измерим.") }]);
    const plan = await createGroundedDeckPlan({ content, slideCount: 5 });
    expect(plan.planner).toBe("deterministic");
    expect(plan.meta?.skillVersions).toMatchObject({ "grounded-deck-planner": "v1", search_evidence: "v1" });
  });

  it("fails closed before render/export when a live provider returns zero grounded claims", async () => {
    const content = await normalizeContent("Live plan", [{ name: "notes.txt", type: "text/plain", buffer: Buffer.from("Пилот подтвержден.") }]);
    const provider: LlmProvider = {
      metadata: {
        provider: "test-live",
        attemptsUsed: 1,
        maxAttempts: 1,
        policy: { status: "approved" },
        budget: {
          inputTokenBudget: 0,
          outputTokenBudget: 0,
          totalTokenBudget: 0,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedTotalTokens: 0,
        },
        reportedUsage: null,
        usageUnknown: true,
      },
      async generateStructured<T>() {
        return {
          title: "План",
          slides: Array.from({ length: 5 }, (_, index) => ({
            id: `slide-${index + 1}`, purpose: index === 0 ? "title" : "context", title: "Слайд", content: ["Неподтвержденный тезис"], visualIntent: "none",
            evidence: [{ contentIndex: 0, sourceChunkIds: [], factIds: [], verbatimEvidence: "" }],
          })),
        } as T;
      },
    };
    await expect(createGroundedDeckPlan({ content, slideCount: 5, provider })).rejects.toMatchObject({ code: "grounding_failed" });
  });
});
