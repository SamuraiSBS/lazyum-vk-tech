import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan, validatePresentationPlanGrounding } from "../src/lib/planner";
import type { LlmProvider } from "../src/lib/planner";
import { normalizedContentSchema, presentationPlanSchema } from "../src/lib/schemas";

describe("planner source grounding", () => {
  it("emits reproducible refs and marks deterministic fallbacks unsupported", async () => {
    const content = await createGroundedContent();
    const first = await createPresentationPlan(content, 5);
    const second = await createPresentationPlan(content, 5);

    expect(second.slides).toEqual(first.slides);
    const promptSha256 = createHash("sha256")
      .update(readFileSync(path.resolve(process.cwd(), "prompts/planner/system.md")))
      .digest("hex");
    expect(first.meta).toMatchObject({
      provider: "deterministic",
      promptPath: "prompts/planner/system.md",
      promptSha256,
      attempts: 1,
    });
    expect(new Date(first.meta?.generatedAt || "").toString()).not.toBe("Invalid Date");
    const sourceChunkIds = new Set(content.sourceChunks.map((chunk) => chunk.chunkId));
    const factIds = new Set((content.facts ?? []).map((fact) => fact.factId));
    const claims = first.slides.flatMap((slide) => slide.claims ?? []);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((claim) => claim.grounding === "grounded")).toBe(true);
    expect(claims.some((claim) => claim.grounding === "unsupported")).toBe(true);
    for (const claim of claims) {
      expect(claim.sourceRefs.sourceChunkIds.every((id) => sourceChunkIds.has(id))).toBe(true);
      expect(claim.sourceRefs.factIds.every((id) => factIds.has(id))).toBe(true);
      if (claim.grounding === "unsupported") {
        expect(claim.sourceRefs).toEqual({ sourceChunkIds: [], factIds: [] });
      }
    }
    for (const slide of first.slides) {
      expect(slide.sourceRefs).toEqual({
        sourceChunkIds: [...new Set((slide.claims ?? []).flatMap((claim) => claim.sourceRefs.sourceChunkIds))],
        factIds: [...new Set((slide.claims ?? []).flatMap((claim) => claim.sourceRefs.factIds))],
      });
    }
  });

  it("uses an unsupported next-steps fallback instead of recycling a repeated source signal", async () => {
    const sourceText = "Сервис помогает командам быстрее согласовывать решения и проверять результат на общем наборе данных.";
    const content = await normalizeContent("Grounded planning", [
      {
        name: "notes.txt",
        type: "text/plain",
        buffer: Buffer.from(sourceText),
      },
    ]);
    const plan = await createPresentationPlan(content, 10);
    const slide4 = plan.slides[3];
    const slide10 = plan.slides[9];
    const sourceChunkId = content.sourceChunks[0]?.chunkId;
    if (!slide4 || !slide10 || !sourceChunkId) throw new Error("Expected ten slides and one source chunk");

    expect(plan.planner).toBe("deterministic");
    expect(plan.slides).toHaveLength(10);
    expect(slide4.content).toEqual([sourceText]);
    expect(slide4.claims?.[0]).toMatchObject({
      grounding: "grounded",
      sourceRefs: { sourceChunkIds: [sourceChunkId], factIds: [] },
    });
    expect(slide10.content).toEqual(["Определить следующие действия на основании подтверждённых материалов."]);
    expect(slide10.content).not.toEqual(slide4.content);
    expect(slide10.claims?.[0]).toMatchObject({
      grounding: "unsupported",
      sourceRefs: { sourceChunkIds: [], factIds: [] },
    });
    expect(slide10.sourceRefs).toEqual({ sourceChunkIds: [], factIds: [] });
  });

  it("uses explicit source-backed next steps and preserves their source refs", async () => {
    const content = await normalizeContent("Grounded planning", [
      {
        name: "notes.txt",
        type: "text/plain",
        buffer: Buffer.from("Команда оценивает способ улучшить процесс.\nСледующие шаги: Провести ограниченный пилот и проверить результат."),
      },
    ]);
    const plan = await createPresentationPlan(content, 10);
    const slide10 = plan.slides[9];
    const sourceChunkId = content.sourceChunks[0]?.chunkId;
    if (!slide10 || !sourceChunkId) throw new Error("Expected slide ten and one source chunk");

    expect(slide10.content).toEqual(["Провести ограниченный пилот и проверить результат."]);
    expect(slide10.claims?.[0]).toMatchObject({
      grounding: "grounded",
      sourceRefs: { sourceChunkIds: [sourceChunkId], factIds: [] },
    });
    expect(slide10.sourceRefs).toEqual({ sourceChunkIds: [sourceChunkId], factIds: [] });
  });

  it("computes slide refs as a claim union and rejects exact precision without an exact source chunk", async () => {
    const content = await createGroundedContent();
    const firstChunk = content.sourceChunks[0];
    const secondChunk = content.sourceChunks[1];
    if (!firstChunk || !secondChunk) throw new Error("Expected at least two source chunks");
    const plan = validatePresentationPlanGrounding({
      title: "План",
      planner: "deterministic",
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `slide-${index + 1}`,
        purpose: index === 0 ? "title" : "context",
        title: `Слайд ${index + 1}`,
        content: ["Тезис"],
        visualIntent: "none",
        claims: index === 0
          ? [
            {
              id: "claim-a",
              text: "Первый тезис",
              grounding: "grounded",
              precision: "exact",
              sourceRefs: { sourceChunkIds: [firstChunk.chunkId], factIds: [] },
            },
            {
              id: "claim-b",
              text: "Второй тезис",
              grounding: "grounded",
              precision: "exact",
              sourceRefs: { sourceChunkIds: [firstChunk.chunkId, secondChunk.chunkId], factIds: [] },
            },
          ]
          : [{ id: `claim-${index}`, text: "Запасной тезис", grounding: "unsupported", precision: "document", sourceRefs: { sourceChunkIds: [], factIds: [] } }],
      })),
    }, content);

    expect(plan.slides[0]?.sourceRefs).toEqual({
      sourceChunkIds: [firstChunk.chunkId, secondChunk.chunkId],
      factIds: [],
    });

  });

  it("continues validating legacy plans without meta, slide refs or claim precision", () => {
    const parsed = presentationPlanSchema.parse({
      title: "Старый план",
      planner: "deterministic",
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `legacy-slide-${index + 1}`,
        purpose: index === 0 ? "title" : "context",
        title: `Слайд ${index + 1}`,
        content: ["Старый тезис"],
        visualIntent: "none",
        claims: [{ id: `legacy-claim-${index + 1}`, text: "Старый тезис", grounding: "unsupported" }],
      })),
    });

    expect(parsed.meta).toBeUndefined();
    expect(parsed.slides[0]?.sourceRefs).toBeUndefined();
    expect(parsed.slides[0]?.claims?.[0]?.precision).toBe("document");
    expect(parsed.slides[0]?.claims?.[0]?.sourceRefs).toEqual({ sourceChunkIds: [], factIds: [] });
  });

  it("derives claims and source refs from verified provider evidence", async () => {
    const content = await createGroundedContent();
    const sourceText = content.sourceChunks[0]?.text;
    if (!sourceText) throw new Error("Expected a source chunk");
    const provider: LlmProvider = {
      async generateStructured<T>() {
        return {
          title: "План",
          slides: Array.from({ length: 5 }, (_, index) => providerSlide(index, sourceText, {
            sourceChunkIds: [content.sourceChunks[0]!.chunkId], factIds: [], verbatimEvidence: sourceText,
          })),
        } as T;
      },
    };

    const plan = await createPresentationPlan(content, 5, provider);
    expect(plan.slides[0]?.claims?.[0]?.grounding).toBe("grounded");
    expect(plan.slides[0]?.sourceRefs?.sourceChunkIds).toEqual([content.sourceChunks[0]!.chunkId]);
  });

  it("fails closed when a schema-valid provider plan has a different slide count than requested", async () => {
    const content = await createGroundedContent();
    const sourceText = content.sourceChunks[0]?.text;
    if (!sourceText) throw new Error("Expected a source chunk");
    const provider: LlmProvider = {
      async generateStructured<T>() {
        return {
          title: "План",
          slides: Array.from({ length: 6 }, (_, index) => providerSlide(index, sourceText, {
            sourceChunkIds: [content.sourceChunks[0]!.chunkId], factIds: [], verbatimEvidence: sourceText,
          })),
        } as T;
      },
    };

    await expect(createPresentationPlan(content, 5, provider)).rejects.toMatchObject({
      name: "ZodError",
      issues: [expect.objectContaining({ path: ["slides"], code: "custom" })],
    });
  });

  it("accepts a grounded provider claim that cites an existing typed fact", async () => {
    const content = await createGroundedContent();
    const fact = content.facts?.find((candidate) => candidate.kind === "spreadsheet-cell" && candidate.value === 42);
    if (!fact) throw new Error("Expected a typed spreadsheet fact");
    const provider: LlmProvider = {
      async generateStructured<T>() {
        return {
          title: "План",
          slides: Array.from({ length: 5 }, (_, index) => providerSlide(index, "42", {
            sourceChunkIds: [fact.chunkId], factIds: [fact.factId], verbatimEvidence: "42",
          })),
        } as T;
      },
    };

    const plan = await createPresentationPlan(content, 5, provider);
    expect(plan.planner).toBe("llm");
    expect(plan.slides[0]?.claims?.[0]?.sourceRefs.factIds).toEqual([fact.factId]);
  });
});

async function createGroundedContent() {
  return normalizeContent("Grounded planning", [
    {
      name: "notes.txt",
      type: "text/plain",
      buffer: Buffer.from("Сервис помогает командам быстрее согласовывать решения и проверять результат на общем наборе данных."),
    },
    {
      name: "metrics.csv",
      type: "text/csv",
      buffer: Buffer.from("metric,value\nusers,42"),
    },
  ]);
}

function providerSlide(index: number, text: string, citation: { sourceChunkIds: string[]; factIds: string[]; verbatimEvidence: string }) {
  return {
    id: `provider-slide-${index + 1}`,
    purpose: index === 0 ? "title" : "context",
    title: `Слайд ${index + 1}`,
    content: [text],
    visualIntent: "none",
    evidence: [{ contentIndex: 0, ...citation }],
  };
}
