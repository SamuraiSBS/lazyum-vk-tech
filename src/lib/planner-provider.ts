import type { LlmProvider, LlmProviderMetadata } from "./planner";
import { createYandexAiStudioProvider, type RetrySleep } from "./yandex-ai-studio";

export type PlannerProviderName = "deterministic" | "yandex-ai-studio";

export type PlannerTokenBudget = { inputTokenBudget: number; outputTokenBudget: number; totalTokenBudget: number };

export type PlannerPolicyRejectionMetadata = {
  status: "rejected";
  rejectedField: string;
  reason: string;
  modelName?: string;
  modelUri?: string;
  totalParametersB?: number;
  openWeights?: boolean;
  license?: string;
};

export type PlannerProviderFailureMetadata = Partial<LlmProviderMetadata> & {
  policyFailure?: PlannerPolicyRejectionMetadata;
};

export type PlannerProviderConfig = {
  provider: PlannerProviderName;
  yandex?: {
    apiKey: string; folderId: string; modelName: string; modelUri: string; baseUrl: string; timeoutMs: number;
    maxAttempts: number; budget: PlannerTokenBudget; policy: LlmProviderMetadata["policy"];
  };
};

export class PlannerProviderError extends Error {
  constructor(
    readonly code: "model_policy_rejected" | "provider_configuration_failed" | "provider_timeout" | "provider_http" | "invalid_json" | "token_envelope_exhausted",
    message: string,
    readonly attemptsUsed = 0,
    readonly metadata?: PlannerProviderFailureMetadata,
    readonly httpStatus?: number,
  ) { super(message); this.name = "PlannerProviderError"; }
}

export function loadPlannerProviderConfig(env: NodeJS.ProcessEnv = process.env): PlannerProviderConfig {
  const provider = env.VK_HACKATHON_LLM_PROVIDER?.trim() || "deterministic";
  if (provider === "deterministic") return { provider };
  if (provider !== "yandex-ai-studio") throw new PlannerProviderError("provider_configuration_failed", "VK_HACKATHON_LLM_PROVIDER must be deterministic or yandex-ai-studio");

  const apiKey = required(env, "YANDEX_CLOUD_API_KEY");
  const folderId = required(env, "YANDEX_CLOUD_FOLDER_ID");
  const rejectedPolicy = collectPolicyMetadata(env);
  const modelName = policyRequired(env, "YANDEX_CLOUD_MODEL_NAME", rejectedPolicy);
  const modelUri = policyRequired(env, "YANDEX_CLOUD_MODEL_URI", rejectedPolicy);
  const totalParametersB = policyNumber(env, "YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B", rejectedPolicy);
  const openWeights = policyBoolean(env, "YANDEX_CLOUD_MODEL_OPEN_WEIGHTS", rejectedPolicy);
  const license = policyLicense(env, "YANDEX_CLOUD_MODEL_LICENSE", rejectedPolicy);
  const timeoutMs = positiveInteger(env.VK_HACKATHON_LLM_TIMEOUT_MS, 60_000, "VK_HACKATHON_LLM_TIMEOUT_MS", 120_000);
  const maxAttempts = positiveInteger(env.VK_HACKATHON_LLM_MAX_ATTEMPTS, 2, "VK_HACKATHON_LLM_MAX_ATTEMPTS", 3);
  const budget = {
    inputTokenBudget: positiveInteger(env.VK_HACKATHON_LLM_INPUT_TOKEN_BUDGET, 8_000, "VK_HACKATHON_LLM_INPUT_TOKEN_BUDGET", 24_000),
    outputTokenBudget: positiveInteger(env.VK_HACKATHON_LLM_OUTPUT_TOKEN_BUDGET, 1_500, "VK_HACKATHON_LLM_OUTPUT_TOKEN_BUDGET", 8_000),
    totalTokenBudget: positiveInteger(env.VK_HACKATHON_LLM_TOTAL_TOKEN_BUDGET, 18_000, "VK_HACKATHON_LLM_TOTAL_TOKEN_BUDGET", 48_000),
  };
  if (budget.totalTokenBudget < budget.outputTokenBudget) throw new PlannerProviderError("provider_configuration_failed", "VK_HACKATHON_LLM_TOTAL_TOKEN_BUDGET must cover VK_HACKATHON_LLM_OUTPUT_TOKEN_BUDGET");
  return {
    provider,
    yandex: {
      apiKey, folderId, modelName, modelUri, timeoutMs, maxAttempts, budget,
      policy: { status: "approved", modelName, modelUri, totalParametersB, openWeights, license },
      baseUrl: (env.YANDEX_CLOUD_OPENAI_BASE_URL?.trim() || "https://ai.api.cloud.yandex.net/v1").replace(/\/$/u, ""),
    },
  };
}

export function createConfiguredPlannerProvider(env: NodeJS.ProcessEnv = process.env, dependencies?: { fetcher?: typeof fetch; sleep?: RetrySleep }): LlmProvider | undefined {
  const config = loadPlannerProviderConfig(env);
  return config.provider === "deterministic" ? undefined : createYandexAiStudioProvider(config.yandex!, dependencies?.fetcher, dependencies?.sleep);
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new PlannerProviderError("provider_configuration_failed", `${name} is required when VK_HACKATHON_LLM_PROVIDER=yandex-ai-studio`);
  return value;
}
function policyRequired(env: NodeJS.ProcessEnv, name: string, metadata: PlannerPolicyRejectionMetadata) {
  const value = env[name]?.trim();
  if (!value) throw policyRejected(name, "must be explicitly attested", metadata);
  return value;
}
function policyNumber(env: NodeJS.ProcessEnv, name: string, metadata: PlannerPolicyRejectionMetadata) {
  const value = Number(policyRequired(env, name, metadata));
  if (!Number.isFinite(value) || value <= 0 || value > 35) throw policyRejected(name, "must be a total parameter count no greater than 35", metadata);
  return value;
}
function policyBoolean(env: NodeJS.ProcessEnv, name: string, metadata: PlannerPolicyRejectionMetadata) {
  if (policyRequired(env, name, metadata).toLowerCase() !== "true") throw policyRejected(name, "must be true", metadata);
  return true as const;
}
function policyLicense(env: NodeJS.ProcessEnv, name: string, metadata: PlannerPolicyRejectionMetadata) {
  const value = policyRequired(env, name, metadata);
  if (value !== "Apache-2.0" && value !== "MIT") throw policyRejected(name, "must be Apache-2.0 or MIT", metadata);
  return value;
}

function policyRejected(rejectedField: string, reason: string, metadata: PlannerPolicyRejectionMetadata) {
  return new PlannerProviderError("model_policy_rejected", `model policy rejected: ${rejectedField} ${reason}`, 0, {
    policyFailure: { ...metadata, rejectedField, reason },
  });
}

function collectPolicyMetadata(env: NodeJS.ProcessEnv): PlannerPolicyRejectionMetadata {
  const totalParametersB = Number(env.YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B?.trim());
  const openWeightsRaw = env.YANDEX_CLOUD_MODEL_OPEN_WEIGHTS?.trim().toLowerCase();
  return {
    status: "rejected",
    rejectedField: "unknown",
    reason: "model policy validation failed",
    ...(safePolicyValue(env.YANDEX_CLOUD_MODEL_NAME) ? { modelName: safePolicyValue(env.YANDEX_CLOUD_MODEL_NAME)! } : {}),
    ...(safePolicyValue(env.YANDEX_CLOUD_MODEL_URI) ? { modelUri: safePolicyValue(env.YANDEX_CLOUD_MODEL_URI)! } : {}),
    ...(Number.isFinite(totalParametersB) ? { totalParametersB } : {}),
    ...(openWeightsRaw === "true" ? { openWeights: true } : openWeightsRaw === "false" ? { openWeights: false } : {}),
    ...(safePolicyValue(env.YANDEX_CLOUD_MODEL_LICENSE) ? { license: safePolicyValue(env.YANDEX_CLOUD_MODEL_LICENSE)! } : {}),
  };
}

function safePolicyValue(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || /(api[_-]?key|token|secret|password)/iu.test(trimmed)) return undefined;
  return trimmed.slice(0, 240);
}
function positiveInteger(raw: string | undefined, fallback: number, name: string, maximum: number) {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new PlannerProviderError("provider_configuration_failed", `${name} must be an integer from 1 to ${maximum}`);
  return value;
}
