import { describe, expect, it } from "vitest";
import { createPlannerSpecialistContext, plannerSpecialistContextSchema } from "../src/lib/agent-planner-bridge";
import { createPresentationPlan } from "../src/lib/planner";
import { normalizeContent } from "../src/lib/content-parser";

describe("P0-12.2 agent planner bridge", () => {
  it("accepts only strict specialist outputs and preserves grounded source/fact refs", async () => {
    const content = await createContent();
    const fact = content.facts?.[0];
    const chunk = content.sourceChunks.find((candidate) => candidate.chunkId === fact?.chunkId);
    if (!chunk || !fact) throw new Error("Expected grounded fixture refs");

    const context = createPlannerSpecialistContext(
      validTemplateOutput(),
      {
        version: "v1",
        claims: [{
          id: "claim-1",
          text: chunk.text,
          priority: 3,
          precision: chunk.precision,
          sourceRefs: { sourceChunkIds: [chunk.chunkId], factIds: [fact.factId] },
        }],
        contradictions: [],
        unsupported: [],
        coverage: { total: 1, grounded: 1 },
      },
      content,
    );

    expect(plannerSpecialistContextSchema.parse(context)).toEqual(context);
    const plan = await createPresentationPlan(content, 5, undefined, context);
    const claim = plan.slides.flatMap((slide) => slide.claims ?? []).find((candidate) => candidate.text === chunk.text);
    expect(claim).toMatchObject({
      grounding: "grounded",
      sourceRefs: { sourceChunkIds: [chunk.chunkId], factIds: [fact.factId] },
    });
  });

  it("fails closed on unknown source and fact refs", async () => {
    const content = await createContent();
    expect(() => createPlannerSpecialistContext(
      validTemplateOutput(),
      {
        version: "v1",
        claims: [{
          id: "claim-1",
          text: "Недоказанный тезис",
          priority: 2,
          precision: "document",
          sourceRefs: { sourceChunkIds: ["missing-chunk"], factIds: ["missing-fact"] },
        }],
        contradictions: [],
        unsupported: [],
        coverage: { total: 1, grounded: 1 },
      },
      content,
    )).toThrow("Planner specialist grounding validation failed");
  });

  it("keeps the deterministic fallback unchanged when specialist context is absent", async () => {
    const content = await createContent();
    const withoutContext = await createPresentationPlan(content, 5);
    const explicitlyAbsent = await createPresentationPlan(content, 5, undefined, undefined);
    expect(explicitlyAbsent.slides).toEqual(withoutContext.slides);
    expect(explicitlyAbsent.planner).toBe("deterministic");
  });
});

async function createContent() {
  return normalizeContent("Planner bridge", [{
    name: "notes.txt",
    type: "text/plain",
    buffer: Buffer.from("Проверяемый источник описывает воспроизводимый результат команды."),
  }, {
    name: "metrics.csv",
    type: "text/csv",
    buffer: Buffer.from("metric,value\nusers,42"),
  }]);
}

function validTemplateOutput() {
  return {
    version: "v1" as const,
    layoutFamilies: [{
      id: "layout-title",
      purpose: "title" as const,
      confidence: 0.9,
      reusable: true as const,
      riskCodes: [],
    }],
    typography: {
      headingRoles: ["heading"],
      bodyRoles: ["body"],
      densityGuidance: "balanced" as const,
    },
    spacingGuidance: "regular" as const,
    prohibitedCompositions: [],
    risks: [],
  };
}
