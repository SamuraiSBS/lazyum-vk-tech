import { describe, expect, it, vi } from "vitest";
import { createConfiguredPlannerProvider, loadPlannerProviderConfig } from "../src/lib/planner-provider";
import { createYandexAiStudioProvider } from "../src/lib/yandex-ai-studio";
import type { LlmRequest } from "../src/lib/planner";
import { loadPlannerSystemPrompt } from "../src/lib/prompts";

const request: LlmRequest = {
  brief: "Питч сервиса для команд",
  slideCount: 5,
  systemPrompt: "Return a plan.",
  content: { brief: "Питч сервиса для команд", documents: [], excerpts: [], keywords: [], sourceChunks: [] },
};

describe("Yandex AI Studio planner provider", () => {
  it("keeps deterministic mode credential-free and exposes only explicitly attested provider metadata", () => {
    expect(loadPlannerProviderConfig({ VK_HACKATHON_LLM_PROVIDER: "deterministic" } as unknown as NodeJS.ProcessEnv)).toEqual({ provider: "deterministic" });
    expect(createConfiguredPlannerProvider({ VK_HACKATHON_LLM_PROVIDER: "deterministic" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();

    const config = loadPlannerProviderConfig(providerEnv({
      VK_HACKATHON_LLM_PROVIDER: "yandex-ai-studio",
      YANDEX_CLOUD_API_KEY: "not-a-real-secret",
      YANDEX_CLOUD_FOLDER_ID: "folder-123",
    }));
    expect(config.yandex?.modelUri).toBe("gpt://folder-123/test-qwen");

    const configured = createConfiguredPlannerProvider(providerEnv({
      VK_HACKATHON_LLM_PROVIDER: "yandex-ai-studio",
      YANDEX_CLOUD_API_KEY: "not-a-real-secret",
      YANDEX_CLOUD_FOLDER_ID: "folder-123",
      YANDEX_CLOUD_MODEL_URI: "gpt://folder-123/custom-qwen",
    }));
    expect(configured?.metadata).toMatchObject({
      provider: "yandex-ai-studio",
      modelUri: "gpt://folder-123/custom-qwen",
      maxAttempts: 2,
      policy: { status: "approved", openWeights: true, license: "Apache-2.0", totalParametersB: 35 },
    });
  });

  it("fails closed when the cloud provider is selected without its required secret", () => {
    expect(() => loadPlannerProviderConfig({ VK_HACKATHON_LLM_PROVIDER: "yandex-ai-studio" } as unknown as NodeJS.ProcessEnv))
      .toThrow("YANDEX_CLOUD_API_KEY is required");
  });

  it("sends structured planner context to the OpenAI-compatible AI Studio endpoint", async () => {
    const exactCitedContent = "Данные подтверждают план команды на квартал.";
    const providerPayload = {
      title: "Питч",
      slides: [{
        id: "slide-1",
        purpose: "context",
        title: "Подтверждённый тезис",
        content: [exactCitedContent],
        visualIntent: "none",
        evidence: [{ contentIndex: 0, sourceChunkIds: ["chunk-typed"], factIds: ["fact-typed"], verbatimEvidence: exactCitedContent }],
      }],
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(providerPayload) } }],
    }), { status: 200 }));
    const provider = createYandexAiStudioProvider(loadPlannerProviderConfig(providerEnv()).yandex!, fetcher);

    const typedRequest: LlmRequest = {
      ...request,
      content: {
        ...request.content,
        sourceChunks: [{
          sourceId: "source-typed",
          chunkId: "chunk-typed",
          sourceName: "metrics.csv",
          mimeType: "text/csv",
          text: `${exactCitedContent} 42`,
          locator: "row:2,column:2",
          precision: "exact",
        }],
        facts: [{
          kind: "spreadsheet-cell",
          factId: "fact-typed",
          sourceId: "source-typed",
          chunkId: "chunk-typed",
          format: "csv",
          valueType: "number",
          value: 42,
          coordinate: { row: 2, column: 2 },
          locator: "row:2,column:2",
        }],
      },
    };
    expect(exactCitedContent.length).toBeLessThanOrEqual(64);
    await expect(provider.generateStructured(typedRequest)).resolves.toEqual(providerPayload);
    expect(fetcher).toHaveBeenCalledWith("https://ai.api.cloud.yandex.net/v1/chat/completions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer not-a-real-secret" }),
    }));
    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: "gpt://folder-123/test-qwen",
      temperature: 0.2,
      reasoning_effort: "none",
      response_format: {
        type: "json_schema",
        json_schema: expect.objectContaining({ name: "grounded_deck_plan", strict: true }),
      },
    });
    const body = JSON.parse(String(options.body)) as { messages?: Array<{ content?: string }> };
    expect(body.messages?.[1]?.content).toContain('"factId":"fact-typed"');
    expect(body.messages?.[1]?.content).toContain('"evidenceCatalogue"');
    expect(body.messages?.[1]?.content).not.toContain('"documents"');
    expect(body.messages?.[1]?.content).toContain("must be copied verbatim from its verbatimEvidence and be at most 64 characters");
    expect(body.messages?.[1]?.content).toContain("verbatimEvidence must equal its content string exactly");
    expect(JSON.parse(String(options.body)).response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "grounded_deck_plan",
        strict: true,
        schema: {
          properties: {
            slides: { minItems: 5, maxItems: 5 },
          },
        },
      },
    });
  });

  it("requires the exact bounded slide count and a final count check without weakening grounding instructions", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: "Питч", slides: [] }) } }],
    }), { status: 200 }));
    const provider = createYandexAiStudioProvider(loadPlannerProviderConfig(providerEnv()).yandex!, fetcher);

    await provider.generateStructured({ ...request, slideCount: 7, systemPrompt: loadPlannerSystemPrompt() });

    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(options.body)) as { messages: Array<{ role: string; content: string }> };
    const systemPrompt = body.messages.find((message) => message.role === "system")?.content;
    const userPrompt = body.messages.find((message) => message.role === "user")?.content;

    expect(systemPrompt).toContain("exactly that count: never fewer and never more");
    expect(systemPrompt).toContain("inclusive range 5–15");
    expect(systemPrompt).toContain("final count check that `slides.length` equals the requested");
    expect(userPrompt).toContain("Return exactly 7 slides");
    expect(userPrompt).toContain("never return fewer than 5 or more than 15 slides");
    expect(userPrompt).toContain("final count check that slides.length === 7");
    expect(systemPrompt).toContain("verbatimEvidence");
    expect(systemPrompt).toContain("Do not invent statistics, names, dates, results or citations");
    expect(userPrompt).toContain("Use only the evidence catalogue. Do not output claims, sourceRefs, planner or meta. Do not invent facts.");
    expect(body).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          strict: true,
          schema: { properties: { slides: { minItems: 7, maxItems: 7 } } },
        },
      },
    });
  });

  it("accepts bounded JSON wrapped in Qwen-style reasoning or markdown", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '<think>internal reasoning</think>\nHere is the plan:\n```json\n{"title":"Питч","slides":[]}\n```' } }],
    }), { status: 200 }));
    const provider = createYandexAiStudioProvider(loadPlannerProviderConfig(providerEnv()).yandex!, fetcher);

    await expect(provider.generateStructured(request)).resolves.toEqual({ title: "Питч", slides: [] });
  });

  it("records only bounded metadata for an unexpected envelope and never its values", async () => {
    const rawSecret = "raw-model-output-must-not-persist";
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: rawSecret }), { status: 200 }));
    const provider = createYandexAiStudioProvider(loadPlannerProviderConfig(providerEnv()).yandex!, fetcher);

    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: "invalid_json",
      diagnostics: [{ stage: "response_shape", code: "invalid_json", attempt: 1, responseShapeKeys: ["unexpected"] }],
    });
    try { await provider.generateStructured(request); } catch (error) {
      expect(JSON.stringify(error)).not.toContain(rawSecret);
    }
  });

  it("classifies a non-empty length-terminated response as truncation and preserves only numeric usage", async () => {
    const rawContent = '{"title":"raw-model-output-must-not-persist"';
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: rawContent }, finish_reason: "length" }],
      usage: { prompt_tokens: 101, completion_tokens: 202, total_tokens: 303 },
    }), { status: 200 }));
    const provider = createYandexAiStudioProvider(loadPlannerProviderConfig(providerEnv()).yandex!, fetcher);

    try {
      await provider.generateStructured(request);
      throw new Error("Expected truncated JSON to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_json",
        attemptsUsed: 1,
        diagnostics: [expect.objectContaining({
          stage: "truncation",
          code: "invalid_json",
          attempt: 1,
          finishReason: "length",
          usage: { inputTokens: 101, outputTokens: 202, totalTokens: 303 },
        })],
      });
      expect(JSON.stringify(error)).not.toContain(rawContent);
      expect(JSON.stringify(error)).not.toContain("raw-model-output-must-not-persist");
    }
  });
});

function providerEnv(overrides: Record<string, string> = {}) {
  return {
    VK_HACKATHON_LLM_PROVIDER: "yandex-ai-studio",
    YANDEX_CLOUD_API_KEY: "not-a-real-secret",
    YANDEX_CLOUD_FOLDER_ID: "folder-123",
    YANDEX_CLOUD_MODEL_NAME: "Test open model",
    YANDEX_CLOUD_MODEL_URI: "gpt://folder-123/test-qwen",
    YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B: "35",
    YANDEX_CLOUD_MODEL_OPEN_WEIGHTS: "true",
    YANDEX_CLOUD_MODEL_LICENSE: "Apache-2.0",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}
