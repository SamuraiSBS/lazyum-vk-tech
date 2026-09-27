import { describe, expect, it, vi } from "vitest";
import { createConfiguredPlannerProvider, loadPlannerProviderConfig, PlannerProviderError } from "../src/lib/planner-provider";
import type { LlmRequest } from "../src/lib/planner";

const request: LlmRequest = {
  brief: "Проверить fail-closed planner policy",
  slideCount: 5,
  systemPrompt: "Return JSON only.",
  content: { brief: "Проверить fail-closed planner policy", documents: [], excerpts: [], keywords: [], sourceChunks: [] },
};

describe("planner model policy and bounded retry envelope", () => {
  it("keeps deterministic mode outside credentials and model policy", () => {
    expect(createConfiguredPlannerProvider({ VK_HACKATHON_LLM_PROVIDER: "deterministic" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it.each([
    ["missing model name", { YANDEX_CLOUD_MODEL_NAME: "" }, "YANDEX_CLOUD_MODEL_NAME", "YANDEX_CLOUD_MODEL_NAME"],
    ["false open weights", { YANDEX_CLOUD_MODEL_OPEN_WEIGHTS: "false" }, "OPEN_WEIGHTS", "YANDEX_CLOUD_MODEL_OPEN_WEIGHTS"],
    ["more than 35B total parameters", { YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B: "35.1" }, "TOTAL_PARAMETERS", "YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B"],
    ["forbidden licence", { YANDEX_CLOUD_MODEL_LICENSE: "Proprietary" }, "Apache-2.0 or MIT", "YANDEX_CLOUD_MODEL_LICENSE"],
  ])("rejects %s before provider construction with safe policy metadata", (_name, overrides, message, rejectedField) => {
    expect(() => loadPlannerProviderConfig(providerEnv(overrides))).toThrow(message);
    try { loadPlannerProviderConfig(providerEnv(overrides)); }
    catch (error) {
      expect(error).toMatchObject({
        code: "model_policy_rejected", attemptsUsed: 0,
        metadata: { policyFailure: { status: "rejected", rejectedField, modelUri: "gpt://folder-123/test-qwen", totalParametersB: expect.any(Number) } },
      });
      expect(JSON.stringify(error)).not.toContain("not-a-real-secret");
    }
  });

  it("records successful upstream usage and explicit policy metadata", async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const provider = createConfiguredPlannerProvider(providerEnv(), { fetcher, sleep: async () => undefined })!;
    await expect(provider.generateStructured(request)).resolves.toEqual({ title: "План", slides: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(provider.metadata).toMatchObject({
      maxAttempts: 2, attemptsUsed: 1,
      policy: { status: "approved", modelName: "Test open model", openWeights: true, license: "Apache-2.0", totalParametersB: 35 },
      reportedUsage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 }, usageUnknown: false,
    });
  });

  it.each([
    ["timeout", () => new DOMException("aborted", "AbortError")],
    ["HTTP 429", () => new Response("rate limited", { status: 429 })],
    ["HTTP 503", () => new Response("unavailable", { status: 503 })],
  ])("retries %s once and performs exactly two fetches", async (name, first) => {
    const fetcher = name === "timeout"
      ? vi.fn().mockRejectedValueOnce(first()).mockResolvedValueOnce(response())
      : vi.fn().mockImplementationOnce(first).mockResolvedValueOnce(response());
    const sleep = vi.fn(async () => undefined);
    const provider = createConfiguredPlannerProvider(providerEnv(), { fetcher, sleep })!;
    await expect(provider.generateStructured(request)).resolves.toEqual({ title: "План", slides: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(provider.metadata?.attemptsUsed).toBe(2);
  });

  it.each([
    ["HTTP 400", () => new Response("bad request", { status: 400 })],
    ["HTTP 401", () => new Response("unauthorized", { status: 401 })],
    ["invalid response JSON", () => new Response("{", { status: 200 })],
    ["invalid planner JSON", () => response("not-json")],
  ])("does not retry %s", async (_name, result) => {
    const fetcher = vi.fn().mockImplementation(result);
    const provider = createConfiguredPlannerProvider(providerEnv(), { fetcher, sleep: async () => undefined })!;
    await expect(provider.generateStructured(request)).rejects.toBeInstanceOf(PlannerProviderError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops at configured max attempts after exactly two retryable fetches", async () => {
    const fetcher = vi.fn().mockImplementation(() => new Response("unavailable", { status: 503 }));
    const provider = createConfiguredPlannerProvider(providerEnv({ VK_HACKATHON_LLM_MAX_ATTEMPTS: "2" }), { fetcher, sleep: async () => undefined })!;
    await expect(provider.generateStructured(request)).rejects.toMatchObject({ code: "provider_http", attemptsUsed: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops before a second fetch when the aggregate token envelope is exhausted", async () => {
    const fetcher = vi.fn().mockImplementation(() => new Response("unavailable", { status: 503 }));
    const provider = createConfiguredPlannerProvider(providerEnv({
      VK_HACKATHON_LLM_OUTPUT_TOKEN_BUDGET: "100",
      VK_HACKATHON_LLM_TOTAL_TOKEN_BUDGET: "2500",
    }), { fetcher, sleep: async () => undefined })!;
    const largeRequest = { ...request, content: { ...request.content, sourceChunks: [{
      sourceId: "s", chunkId: "c", sourceName: "long.txt", mimeType: "text/plain", text: "x".repeat(3000), locator: "line:1", precision: "exact" as const,
    }] } };
    await expect(provider.generateStructured(largeRequest)).rejects.toMatchObject({ code: "token_envelope_exhausted", attemptsUsed: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies non-empty unparseable content with a normalized digest, not raw content", async () => {
    const rawContent = "<think>hidden</think> definitely-not-json";
    const provider = createConfiguredPlannerProvider(providerEnv(), {
      fetcher: vi.fn().mockResolvedValue(response(rawContent)), sleep: async () => undefined,
    })!;
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: "invalid_json",
      diagnostics: [expect.objectContaining({
        stage: "json_parse", code: "invalid_json", attempt: 1,
        contentPresent: true, contentType: "string", contentLength: Buffer.byteLength("definitely-not-json"),
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
    });
    try { await provider.generateStructured(request); } catch (error) {
      expect(JSON.stringify(error)).not.toContain(rawContent);
      expect(JSON.stringify(error)).not.toContain("hidden");
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

function response(content = JSON.stringify({ title: "План", slides: [] })) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }), { status: 200 });
}
