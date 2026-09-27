import { createHash } from "node:crypto";
import type { LlmProvider, LlmProviderMetadata, LlmRequest } from "./planner";
import { PlannerProviderError } from "./planner-provider";
import type { PlannerProviderConfig } from "./planner-provider";
import { buildEvidenceCatalogue } from "./claim-alignment";
import { providerAttemptDiagnosticSchema, type ProviderAttemptDiagnostic } from "./schemas";

export type YandexAiStudioConfig = NonNullable<PlannerProviderConfig["yandex"]>;
type FetchLike = typeof fetch;
export type RetrySleep = (milliseconds: number) => Promise<void>;
const defaultSleep: RetrySleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type YandexProviderFailure = PlannerProviderError & { diagnostics?: ProviderAttemptDiagnostic[] };

export function createYandexAiStudioProvider(config: YandexAiStudioConfig, fetcher: FetchLike = fetch, sleep: RetrySleep = defaultSleep): LlmProvider {
  const metadata: LlmProviderMetadata = {
    provider: "yandex-ai-studio", modelUri: config.modelUri, maxAttempts: config.maxAttempts, attemptsUsed: 0,
    policy: config.policy,
    budget: { ...config.budget, estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedTotalTokens: 0 },
    reportedUsage: null, usageUnknown: true,
  };
  return {
    metadata,
    async generateStructured<T>(request: LlmRequest): Promise<T> {
      const body = requestBody(config, request);
      const estimatedInputTokens = conservativeTokenEstimate(JSON.stringify(body));
      const estimatedPerAttempt = estimatedInputTokens + config.budget.outputTokenBudget;
      let estimatedTotalTokens = 0;
      const diagnostics: ProviderAttemptDiagnostic[] = [];
      for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        if (estimatedInputTokens > config.budget.inputTokenBudget || estimatedTotalTokens + estimatedPerAttempt > config.budget.totalTokenBudget) {
          updateMetadata(metadata, attempt - 1, estimatedInputTokens, estimatedTotalTokens, null);
          throw new PlannerProviderError("token_envelope_exhausted", "planner token envelope exhausted before provider request", attempt - 1, metadata);
        }
        estimatedTotalTokens += estimatedPerAttempt;
        try {
          const payload = await callYandex(config, body, fetcher, attempt);
          updateMetadata(metadata, attempt, estimatedInputTokens, estimatedTotalTokens, reportedUsage(payload));
          const content = providerContent(payload, attempt);
          return parseJsonObject<T>(content.content, attempt, metadata, content.responseShapeKeys, content.finishReason);
        } catch (error) {
          const normalized = normalizeProviderError(error, attempt, metadata, estimatedInputTokens, estimatedTotalTokens, diagnostics);
          if (!isRetryable(normalized) || attempt === config.maxAttempts) throw normalized;
          await sleep(retryDelayMs(attempt));
        }
      }
      throw new PlannerProviderError("provider_configuration_failed", "planner retry loop ended unexpectedly", metadata.attemptsUsed, metadata);
    },
  };
}

function requestBody(config: YandexAiStudioConfig, request: LlmRequest) {
  return {
    model: config.modelUri,
    temperature: 0.2,
    max_tokens: config.budget.outputTokenBudget,
    // Qwen 3.6 enables reasoning by default. A presentation plan is a bounded
    // JSON artifact, so reserve the completion budget for the artifact rather
    // than hidden reasoning and ask the OpenAI-compatible API for JSON mode.
    reasoning_effort: "none",
    // The configured Qwen endpoint accepted this strict, fixed-cardinality
    // schema in the P0-11.16 live contract probe. Keep server-side Zod
    // validation as the final authority for the provider response.
    response_format: strictDeckPlanSchema(request.slideCount),
    messages: [{ role: "system", content: request.systemPrompt }, { role: "user", content: plannerInput(request) }],
  };
}

function strictDeckPlanSchema(slideCount: number) {
  return {
    type: "json_schema",
    json_schema: {
      name: "grounded_deck_plan",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          slides: {
            type: "array",
            minItems: slideCount,
            maxItems: slideCount,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                purpose: { type: "string", enum: ["title", "problem", "context", "opportunity", "solution", "workflow", "advantages", "implementation", "metrics", "next_steps", "summary"] },
                title: { type: "string" },
                content: { type: "array", minItems: 1, maxItems: 1, items: { type: "string" } },
                visualIntent: { type: "string", enum: ["none", "diagram", "cards", "timeline", "image", "metrics"] },
                evidence: {
                  type: "array",
                  minItems: 1,
                  maxItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      contentIndex: { type: "integer", enum: [0] },
                      sourceChunkIds: { type: "array", items: { type: "string" } },
                      factIds: { type: "array", items: { type: "string" } },
                      verbatimEvidence: { type: "string" },
                    },
                    required: ["contentIndex", "sourceChunkIds", "factIds", "verbatimEvidence"],
                  },
                },
              },
              required: ["id", "purpose", "title", "content", "visualIntent", "evidence"],
            },
          },
        },
        required: ["title", "slides"],
      },
    },
  } as const;
}

async function callYandex(config: YandexAiStudioConfig, body: ReturnType<typeof requestBody>, fetcher: FetchLike, attempt: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetcher(`${config.baseUrl}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw yandexProviderError("provider_http", `Yandex AI Studio request failed with HTTP ${response.status}`, attempt, undefined, response.status, [diagnostic({ stage: "http", code: "provider_http", attempt, httpStatus: response.status })]);
    try { return await response.json() as unknown; }
    catch { throw yandexProviderError("invalid_json", "Yandex AI Studio returned a response that is not valid JSON", attempt, undefined, undefined, [diagnostic({ stage: "response_shape", code: "invalid_json", attempt })]); }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw yandexProviderError("provider_timeout", `Yandex AI Studio request timed out after ${config.timeoutMs}ms`, attempt, undefined, undefined, [diagnostic({ stage: "transport", code: "provider_timeout", attempt })]);
    if (!(error instanceof PlannerProviderError)) throw yandexProviderError("provider_configuration_failed", "Yandex AI Studio transport failed", attempt, undefined, undefined, [diagnostic({ stage: "transport", code: "provider_configuration_failed", attempt })]);
    throw error;
  } finally { clearTimeout(timer); }
}

function normalizeProviderError(error: unknown, attemptsUsed: number, metadata: LlmProviderMetadata, estimatedInputTokens: number, estimatedTotalTokens: number, diagnostics: ProviderAttemptDiagnostic[]) {
  // A parsed provider envelope can carry safe numeric usage even when its
  // planner content later fails validation. Preserve it for the failed-job
  // diagnostic; never retain the envelope or content itself.
  updateMetadata(metadata, attemptsUsed, estimatedInputTokens, estimatedTotalTokens, metadata.reportedUsage);
  if (error instanceof PlannerProviderError) {
    diagnostics.push(...(diagnosticsFrom(error) ?? []));
    return yandexProviderError(error.code, error.message, attemptsUsed, metadata, error.httpStatus, diagnostics.slice(-3));
  }
  diagnostics.push(diagnostic({ stage: "transport", code: "provider_configuration_failed", attempt: attemptsUsed }));
  return yandexProviderError("provider_configuration_failed", "Yandex AI Studio request failed", attemptsUsed, metadata, undefined, diagnostics.slice(-3));
}
function isRetryable(error: PlannerProviderError) {
  return error.code === "provider_timeout" || (error.code === "provider_http" && (error.httpStatus === 429 || (error.httpStatus !== undefined && error.httpStatus >= 500)));
}
function retryDelayMs(attempt: number) { return Math.min(1_000, 100 * attempt); }
function updateMetadata(metadata: LlmProviderMetadata, attemptsUsed: number, estimatedInputTokens: number, estimatedTotalTokens: number, usage: LlmProviderMetadata["reportedUsage"]) {
  metadata.attemptsUsed = attemptsUsed;
  metadata.budget = { ...metadata.budget, estimatedInputTokens, estimatedOutputTokens: attemptsUsed * metadata.budget.outputTokenBudget, estimatedTotalTokens };
  metadata.reportedUsage = usage;
  metadata.usageUnknown = usage === null;
}
function reportedUsage(payload: unknown): LlmProviderMetadata["reportedUsage"] {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const values = usage as Record<string, unknown>;
  const inputTokens = values.prompt_tokens, outputTokens = values.completion_tokens, totalTokens = values.total_tokens;
  return [inputTokens, outputTokens, totalTokens].every((value) => Number.isInteger(value) && Number(value) >= 0)
    ? { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens), totalTokens: Number(totalTokens) } : null;
}
export function conservativeTokenEstimate(value: string) { return Math.ceil(Buffer.byteLength(value, "utf8") / 3); }
function plannerInput(request: LlmRequest) {
  return [
    "Return one complete JSON object only. No prose, Markdown or code fence.",
    "Keys: title, slides. Every slide: id, purpose, title, content, visualIntent, evidence.",
    `Return exactly ${request.slideCount} slides. request.slideCount is in the inclusive 5–15 range: never return fewer than 5 or more than 15 slides. Immediately before outputting JSON, perform a final count check that slides.length === ${request.slideCount}. Each content string must be copied verbatim from its verbatimEvidence and be at most 64 characters; use one content string per slide and a title no longer than 36 characters.`,
    "Each evidence array has exactly one item: contentIndex 0, sourceChunkIds, factIds, verbatimEvidence.",
    "verbatimEvidence must equal its content string exactly and be a non-empty source substring of at most 64 characters. If no such exact citation exists, use empty IDs and an empty verbatimEvidence.",
    "Use only the evidence catalogue. Do not output claims, sourceRefs, planner or meta. Do not invent facts.",
    "purpose: title|problem|context|opportunity|solution|workflow|advantages|implementation|metrics|next_steps|summary.",
    "visualIntent: none|diagram|cards|timeline|image|metrics.", "Input:",
    JSON.stringify({ brief: request.brief, evidenceCatalogue: buildEvidenceCatalogue(request.content) }),
  ].join("\n");
}
function parseJsonObject<T>(text: string, attemptsUsed: number, metadata: LlmProviderMetadata, responseShapeKeys: string[], finishReason?: string): T {
  const normalized = normalizeDiagnosticContent(text);
  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1]?.trim();
  for (const candidate of [fenced, normalized, extractJsonObject(normalized)].filter((value): value is string => Boolean(value))) {
    try { return JSON.parse(candidate) as T; }
    catch { /* Try the next bounded representation before failing closed. */ }
  }
  const parseDiagnostic = diagnostic({
    stage: finishReason === "length" ? "truncation" : "json_parse", code: "invalid_json", attempt: attemptsUsed,
    contentPresent: true, contentType: "string", contentLength: Buffer.byteLength(normalized, "utf8"), contentSha256: sha256(normalized), responseShapeKeys,
    ...(finishReason ? { finishReason } : {}),
    ...(metadata.reportedUsage ? { usage: metadata.reportedUsage } : {}),
  });
  const message = finishReason === "length"
    ? "Yandex AI Studio truncated planner content before a complete JSON object"
    : "Yandex AI Studio returned planner content that is not valid JSON";
  throw yandexProviderError("invalid_json", message, attemptsUsed, metadata, undefined, [parseDiagnostic]);
}

function providerContent(payload: unknown, attempt: number) {
  const envelope = asRecord(payload);
  const responseShapeKeys = boundedKeys(envelope);
  const choice = Array.isArray(envelope?.choices) ? asRecord(envelope.choices[0]) : undefined;
  const message = asRecord(choice?.message);
  const content = message?.content;
  const finishReason = safeFinishReason(choice?.finish_reason);
  if (!envelope || !Array.isArray(envelope.choices) || !choice || !message) {
    throw yandexProviderError("invalid_json", "Yandex AI Studio returned an unexpected response shape", attempt, undefined, undefined, [diagnostic({ stage: "response_shape", code: "invalid_json", attempt, responseShapeKeys, ...(finishReason ? { finishReason } : {}) })]);
  }
  const contentType = valueType(content);
  if (typeof content !== "string" || !content.trim()) {
    throw yandexProviderError("invalid_json", "Yandex AI Studio returned no planner content", attempt, undefined, undefined, [diagnostic({ stage: "content", code: "invalid_json", attempt, contentPresent: content !== undefined && content !== null, contentType, ...(typeof content === "string" ? { contentLength: Buffer.byteLength(content, "utf8") } : {}), ...(finishReason ? { finishReason } : {}), responseShapeKeys })]);
  }
  return { content, responseShapeKeys, ...(finishReason ? { finishReason } : {}) };
}

function diagnostic(value: ProviderAttemptDiagnostic) { return providerAttemptDiagnosticSchema.parse(value); }
function yandexProviderError(code: PlannerProviderError["code"], message: string, attemptsUsed: number, metadata?: LlmProviderMetadata, httpStatus?: number, diagnostics?: ProviderAttemptDiagnostic[]): YandexProviderFailure {
  return Object.assign(new PlannerProviderError(code, message, attemptsUsed, metadata, httpStatus), diagnostics?.length ? { diagnostics } : {});
}
function diagnosticsFrom(error: PlannerProviderError): ProviderAttemptDiagnostic[] | undefined {
  return "diagnostics" in error && Array.isArray(error.diagnostics) ? error.diagnostics as ProviderAttemptDiagnostic[] : undefined;
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function boundedKeys(value: Record<string, unknown> | undefined) { return value ? Object.keys(value).filter((key) => /^[A-Za-z0-9_.-]+$/u.test(key)).sort().slice(0, 20) : []; }
function valueType(value: unknown): ProviderAttemptDiagnostic["contentType"] { if (value === null) return "null"; if (Array.isArray(value)) return "array"; return typeof value as ProviderAttemptDiagnostic["contentType"]; }
function safeFinishReason(value: unknown) { return typeof value === "string" && value.trim() ? value.trim().replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 120) || undefined : undefined; }
function normalizeDiagnosticContent(value: string) { return value.replace(/<think>[\s\S]*?<\/think>/giu, "").trim(); }
function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function extractJsonObject(value: string) {
  const start = value.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
}
