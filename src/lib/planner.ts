import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { getActiveSkillVersions } from "./skills/registry";
import {
  normalizedContentSchema,
  presentationPlanSchema,
  type NormalizedContent,
  type PlanClaim,
  type PlanSlide,
  type PresentationPlan,
  type PresentationPlanMeta,
  providerDeckPlanSchema,
} from "./schemas";
import { loadPlannerSystemPrompt } from "./prompts";
import { alignProviderDeckPlan, GROUNDING_RULE_VERSION } from "./claim-alignment";
import {
  validatePlannerSpecialistContext,
  type PlannerSpecialistContext,
} from "./agent-planner-bridge";
import type { EvidencePack } from "./agent-contracts";

const PLANNER_PROMPT_PATH = "prompts/planner/system.md";

export type LlmRequest = {
  brief: string;
  content: NormalizedContent;
  slideCount: number;
  systemPrompt: string;
  specialistContext?: PlannerSpecialistContext;
};

export type LlmProviderMetadata = {
  provider: string;
  modelUri?: string;
  maxAttempts: number;
  attemptsUsed: number;
  policy: PresentationPlanMeta["policy"];
  budget: PresentationPlanMeta["budget"];
  reportedUsage: PresentationPlanMeta["reportedUsage"];
  usageUnknown: boolean;
};

export interface LlmProvider {
  generateStructured<T>(request: LlmRequest): Promise<T>;
  metadata?: LlmProviderMetadata;
}

export async function createPresentationPlan(
  content: NormalizedContent,
  slideCount: number,
  provider?: LlmProvider,
  specialistContext?: PlannerSpecialistContext,
): Promise<PresentationPlan> {
  const safeCount = Math.max(5, Math.min(15, Math.round(slideCount)));
  const normalizedContent = normalizedContentSchema.parse(content);
  const validatedSpecialistContext = specialistContext
    ? validatePlannerSpecialistContext(specialistContext, normalizedContent)
    : undefined;
  if (provider) {
    const response = await provider.generateStructured<unknown>({
      brief: normalizedContent.brief,
      content: normalizedContent,
      slideCount: safeCount,
      systemPrompt: loadPlannerSystemPrompt(),
      ...(validatedSpecialistContext ? { specialistContext: validatedSpecialistContext } : {}),
    });
    const providerPlan = providerDeckPlanSchema.parse(response);
    if (providerPlan.slides.length !== safeCount) {
      throw new ZodError([{
        code: "custom",
        path: ["slides"],
        message: "Provider slide count must match the requested count",
      }]);
    }
    const aligned = alignProviderDeckPlan(providerPlan, normalizedContent);
    assertLiveGroundingCoverage(aligned.groundingSummary, provider);
    const parsed = presentationPlanSchema.parse({
      title: aligned.title,
      slides: aligned.slides,
      planner: "llm",
      meta: createPlanMeta(provider, aligned.groundingSummary),
    });
    return validatePresentationPlanGrounding(parsed, normalizedContent);
  }
  const deterministic = deterministicPlan(normalizedContent, safeCount, createPlanMeta(), validatedSpecialistContext?.evidence);
  return withGroundingSummary(deterministic);
}

export function validatePresentationPlanGrounding(
  plan: PresentationPlan,
  content: NormalizedContent,
): PresentationPlan {
  const parsedContent = normalizedContentSchema.parse(content);
  const parsedPlan = presentationPlanSchema.parse(plan);
  const chunksById = new Map(parsedContent.sourceChunks.map((chunk) => [chunk.chunkId, chunk]));
  const factsById = new Map((parsedContent.facts ?? []).map((fact) => [fact.factId, fact]));
  const sourceChunkIds = new Set(parsedContent.sourceChunks.map((chunk) => chunk.chunkId));
  const factIds = new Set((parsedContent.facts ?? []).map((fact) => fact.factId));
  const claimIds = new Set<string>();
  const errors: string[] = [];

  for (const slide of parsedPlan.slides) {
    for (const claim of slide.claims ?? []) {
      if (claimIds.has(claim.id)) errors.push(`duplicate claim id ${claim.id}`);
      claimIds.add(claim.id);
      for (const sourceChunkId of claim.sourceRefs.sourceChunkIds) {
        if (!sourceChunkIds.has(sourceChunkId)) {
          errors.push(`slide ${slide.id} claim ${claim.id} references unknown sourceChunkId: ${sourceChunkId}`);
        }
      }
      for (const factId of claim.sourceRefs.factIds) {
        if (!factIds.has(factId)) {
          errors.push(`slide ${slide.id} claim ${claim.id} references unknown factId ${factId}`);
        }
      }
      if (claim.precision === "exact" && !claimHasExactSourceChunk(claim, chunksById, factsById)) {
        errors.push(`slide ${slide.id} claim ${claim.id} precision exact requires at least one exact source chunk`);
      }
    }
  }

  if (errors.length) throw new Error(`DeckPlan grounding validation failed: ${errors.join("; ")}`);
  return presentationPlanSchema.parse({
    ...parsedPlan,
    slides: parsedPlan.slides.map((slide) => {
      const claims = slide.claims?.map((claim) => ({
        ...claim,
        precision: claimHasExactSourceChunk(claim, chunksById, factsById) ? "exact" as const : "document" as const,
      }));
      return {
        ...slide,
        claims,
        sourceRefs: unionSourceRefs(claims ?? []),
      };
    }),
  });
}

function deterministicPlan(
  content: NormalizedContent,
  slideCount: number,
  meta: PresentationPlanMeta,
  evidence?: EvidencePack,
): PresentationPlan {
  const topic = titleFromBrief(content.brief);
  const sourceSignals = content.sourceChunks.map((chunk) => chunk.text).filter(Boolean);
  const signals = sourceSignals.length
    ? sourceSignals
    : content.excerpts.length
      ? content.excerpts
      : content.keywords.map((keyword) => keyword + " — важный аспект темы.");
  const recipes: Array<Omit<PlanSlide, "id" | "claims" | "sourceRefs">> = [
    {
      purpose: "title",
      title: topic,
      content: ["Краткий обзор темы и ключевой результат для аудитории."],
      visualIntent: "none",
    },
    {
      purpose: "problem",
      title: "Почему тема требует внимания",
      content: [takeSignal(signals, 0, "Определим исходную проблему, потребность и контекст.")],
      visualIntent: "cards",
    },
    {
      purpose: "context",
      title: "Контекст и исходные данные",
      content: splitSignal(takeSignal(signals, 1, "Соберём факты, ограничения и ожидания."), 3),
      visualIntent: "diagram",
    },
    {
      purpose: "opportunity",
      title: "Возможность",
      content: [takeSignal(signals, 2, "Покажем, какую ценность создаёт выбранный подход.")],
      visualIntent: "image",
    },
    {
      purpose: "solution",
      title: "Предлагаемое решение",
      content: splitSignal(takeSignal(signals, 3, "Опишем решение простыми, проверяемыми шагами."), 3),
      visualIntent: "cards",
    },
    {
      purpose: "workflow",
      title: "Как это работает",
      content: ["Входные данные", "Обработка и принятие решений", "Результат и обратная связь"],
      visualIntent: "timeline",
    },
    {
      purpose: "advantages",
      title: "Ключевые преимущества",
      content: splitSignal(takeSignal(signals, 4, "Выделим преимущества для пользователей и команды."), 4),
      visualIntent: "cards",
    },
    {
      purpose: "implementation",
      title: "План реализации",
      content: ["Подготовка", "Пилот и проверка", "Масштабирование"],
      visualIntent: "timeline",
    },
    {
      purpose: "metrics",
      title: "Как измерим результат",
      content: ["Пользовательская ценность", "Качество процесса", "Скорость достижения цели"],
      visualIntent: "metrics",
    },
    {
      purpose: "next_steps",
      title: "Следующие шаги",
      content: [findExplicitNextStepsSignal(sourceSignals) || "Определить следующие действия на основании подтверждённых материалов."],
      visualIntent: "none",
    },
    {
      purpose: "summary",
      title: "Главное",
      content: ["Тема понятна", "Подход воспроизводим", "Следующий шаг определён"],
      visualIntent: "cards",
    },
  ];
  const selected = recipes.slice(0, slideCount);
  while (selected.length < slideCount) {
    const index = selected.length;
    selected.push({
      purpose: "context",
      title: "Деталь " + (index - recipes.length + 2),
      content: splitSignal(takeSignal(signals, index, "Дополнительный аспект, который помогает принять решение."), 3),
      visualIntent: "cards",
    });
  }
  const parsed = presentationPlanSchema.parse({
    title: topic,
    slides: selected.map((slide, index) => {
      const id = "slide-" + (index + 1);
      return {
        ...slide,
        id,
        claims: buildClaims(id, slide.content, content, evidence),
      };
    }),
    planner: "deterministic",
    meta,
  });
  return validatePresentationPlanGrounding(parsed, content);
}

function buildClaims(
  slideId: string,
  content: string[],
  normalizedContent: NormalizedContent,
  evidence?: EvidencePack,
): PlanClaim[] {
  return content.map((text, index) => {
    const chunk = normalizedContent.sourceChunks.find((candidate) => containsClaim(candidate.text, text));
    const facts = chunk
      ? (normalizedContent.facts ?? []).filter((fact) => fact.chunkId === chunk.chunkId)
      : [];
    const specialistClaim = evidence?.claims.find((claim) => containsClaim(claim.text, text) || containsClaim(text, claim.text));
    return {
      id: `${slideId}-claim-${index + 1}`,
      text,
      grounding: specialistClaim || chunk ? "grounded" : "unsupported",
      precision: specialistClaim?.precision === "exact" || chunk?.precision === "exact" ? "exact" : "document",
      sourceRefs: specialistClaim?.sourceRefs || {
        sourceChunkIds: chunk ? [chunk.chunkId] : [],
        factIds: facts.map((fact) => fact.factId),
      },
    };
  });
}

function createPlanMeta(provider?: LlmProvider, groundingSummary?: PresentationPlanMeta["groundingSummary"]): PresentationPlanMeta {
  const providerMetadata = provider?.metadata;
  const deterministic = !provider;
  return {
    provider: providerMetadata?.provider || (provider ? "llm" : "deterministic"),
    ...(providerMetadata?.modelUri ? { modelUri: providerMetadata.modelUri } : {}),
    promptPath: PLANNER_PROMPT_PATH,
    promptSha256: createHash("sha256")
      .update(readFileSync(path.resolve(process.cwd(), PLANNER_PROMPT_PATH)))
      .digest("hex"),
    generatedAt: new Date().toISOString(),
    attempts: providerMetadata?.attemptsUsed ?? 1,
    maxAttempts: providerMetadata?.maxAttempts || 1,
    attemptsUsed: providerMetadata?.attemptsUsed ?? 1,
    policy: providerMetadata?.policy || { status: "not_applicable" },
    budget: providerMetadata?.budget || {
      inputTokenBudget: 0,
      outputTokenBudget: 0,
      totalTokenBudget: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedTotalTokens: 0,
    },
    reportedUsage: providerMetadata?.reportedUsage || null,
    usageUnknown: providerMetadata?.usageUnknown ?? deterministic,
    skillVersions: getActiveSkillVersions(),
    ...(groundingSummary ? { groundingSummary } : {}),
  };
}

function withGroundingSummary(plan: PresentationPlan): PresentationPlan {
  const claims = plan.slides.flatMap((slide) => slide.claims ?? []);
  const grounded = claims.filter((claim) => claim.grounding === "grounded").length;
  const unsupported = claims.length - grounded;
  return presentationPlanSchema.parse({
    ...plan,
    meta: {
      ...plan.meta,
      groundingSummary: {
        total: claims.length,
        grounded,
        unsupported,
        rejected: 0,
        ruleVersion: GROUNDING_RULE_VERSION,
      },
    },
  });
}

function assertLiveGroundingCoverage(summary: NonNullable<PresentationPlanMeta["groundingSummary"]>, provider: LlmProvider) {
  if (provider.metadata?.provider && provider.metadata.provider !== "deterministic" && summary.total > 0 && summary.grounded === 0) {
    const error = new Error("grounding_failed: live provider returned zero grounded substantive content claims");
    Object.assign(error, { code: "grounding_failed", groundingSummary: summary });
    throw error;
  }
}

function claimHasExactSourceChunk(
  claim: PlanClaim,
  chunksById: Map<string, NormalizedContent["sourceChunks"][number]>,
  factsById: Map<string, NonNullable<NormalizedContent["facts"]>[number]>,
) {
  return claim.sourceRefs.sourceChunkIds.some((sourceChunkId) => chunksById.get(sourceChunkId)?.precision === "exact")
    || claim.sourceRefs.factIds.some((factId) => {
      const fact = factsById.get(factId);
      return fact ? chunksById.get(fact.chunkId)?.precision === "exact" : false;
    });
}

function unionSourceRefs(claims: PlanClaim[]) {
  const sourceChunkIds = new Set<string>();
  const factIds = new Set<string>();
  for (const claim of claims) {
    for (const sourceChunkId of claim.sourceRefs.sourceChunkIds) sourceChunkIds.add(sourceChunkId);
    for (const factId of claim.sourceRefs.factIds) factIds.add(factId);
  }
  return {
    sourceChunkIds: [...sourceChunkIds],
    factIds: [...factIds],
  };
}

function containsClaim(sourceText: string, claimText: string) {
  const source = normalizeForMatch(sourceText);
  const claim = normalizeForMatch(claimText);
  return claim.length > 0 && source.includes(claim);
}

function normalizeForMatch(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
}

function titleFromBrief(brief: string) {
  const firstLine = brief.split(/\n/u).find((line) => line.trim())?.trim() || "Новая презентация";
  return firstLine.length <= 90 ? firstLine : firstLine.slice(0, 87).trimEnd() + "…";
}

function takeSignal(signals: string[], index: number, fallback: string) {
  return signals[index % Math.max(1, signals.length)] || fallback;
}

function findExplicitNextStepsSignal(sourceSignals: string[]) {
  for (const sourceText of sourceSignals) {
    const match = /(?:следующ(?:ий|ие|их)\s+шаг[а-яё]*|план\s+(?:дальнейших\s+)?действ[а-яё]*|рекомендац[а-яё]*)\s*[:—-]\s*([^\r\n]+)/iu.exec(sourceText);
    const candidate = match?.[1]?.trim();
    if (candidate && candidate.length <= 280) return candidate;
  }
  return undefined;
}

function splitSignal(value: string, count: number) {
  const parts = value
    .replace(/[;:]/g, ".")
    .split(/[.!?]\s+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, count);
  const supplemental = [
    "Ценность для пользователя и ожидаемый эффект.",
    "Условия внедрения и важные ограничения.",
    "Метрика, по которой проверим результат.",
    "Следующий проверяемый шаг для команды.",
  ];
  while (parts.length < count) parts.push(supplemental[(parts.length - 1) % supplemental.length] || "Следующий проверяемый шаг.");
  return parts.map((part) => part.length > 140 ? part.slice(0, 137).trimEnd() + "…" : part);
}
