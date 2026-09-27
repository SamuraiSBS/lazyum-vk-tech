import {
  normalizedContentSchema,
  providerDeckPlanSchema,
  type GroundingSummary,
  type NormalizedContent,
  type PlanClaim,
  type PresentationPlan,
  type ProviderContentEvidence,
  type ProviderDeckPlan,
} from "./schemas";

export const GROUNDING_RULE_VERSION = "evidence-carrying-v1";

export type EvidenceCatalogue = Pick<NormalizedContent, "sourceChunks" | "facts">;

export type ClaimAlignmentResult = {
  title: string;
  slides: Array<Omit<PresentationPlan["slides"][number], "claims" | "sourceRefs"> & {
    claims: PlanClaim[];
    sourceRefs: { sourceChunkIds: string[]; factIds: string[] };
  }>;
  groundingSummary: GroundingSummary;
};

/** The only source material a live planner is allowed to cite. */
export function buildEvidenceCatalogue(content: NormalizedContent): EvidenceCatalogue {
  const parsed = normalizedContentSchema.parse(content);
  return {
    sourceChunks: parsed.sourceChunks.map((chunk) => ({
      sourceId: chunk.sourceId,
      chunkId: chunk.chunkId,
      sourceName: chunk.sourceName,
      mimeType: chunk.mimeType,
      text: chunk.text,
      locator: chunk.locator,
      precision: chunk.precision,
      ...(chunk.mergedRange ? { mergedRange: chunk.mergedRange } : {}),
    })),
    facts: parsed.facts ?? [],
  };
}

/**
 * Converts the provider DTO into the public DeckPlan claim shape. A citation
 * may only become grounded when all provenance checks succeed. Invalid or
 * insufficient evidence stays visible as an unsupported claim with a reason.
 */
export function alignProviderDeckPlan(response: ProviderDeckPlan, content: NormalizedContent): ClaimAlignmentResult {
  const providerPlan = providerDeckPlanSchema.parse(response);
  const parsedContent = normalizedContentSchema.parse(content);
  const chunksById = new Map(parsedContent.sourceChunks.map((chunk) => [chunk.chunkId, chunk]));
  const factsById = new Map((parsedContent.facts ?? []).map((fact) => [fact.factId, fact]));
  let total = 0;
  let grounded = 0;
  let rejected = 0;

  const slides = providerPlan.slides.map((slide, slideIndex) => {
    // Provider slide IDs are DTO input, not stable public identifiers. A
    // model may repeat an otherwise schema-valid ID, so create canonical IDs
    // at this deterministic server boundary before deriving claim IDs.
    const canonicalSlideId = `slide-${slideIndex + 1}`;
    const evidenceByIndex = new Map(slide.evidence.map((evidence) => [evidence.contentIndex, evidence]));
    const claims = slide.content.map((text, contentIndex) => {
      total += 1;
      const result = alignContentItem(
        `${canonicalSlideId}-claim-${contentIndex + 1}`,
        text,
        evidenceByIndex.get(contentIndex),
        chunksById,
        factsById,
      );
      if (result.claim.grounding === "grounded") grounded += 1;
      if (result.rejected) rejected += 1;
      return result.claim;
    });
    return {
      id: canonicalSlideId,
      purpose: slide.purpose,
      title: slide.title,
      content: slide.content,
      visualIntent: slide.visualIntent,
      claims,
      sourceRefs: unionSourceRefs(claims),
    };
  });

  return {
    title: providerPlan.title,
    slides,
    groundingSummary: {
      total,
      grounded,
      unsupported: total - grounded,
      rejected,
      ruleVersion: GROUNDING_RULE_VERSION,
    },
  };
}

function alignContentItem(
  id: string,
  text: string,
  evidence: ProviderContentEvidence | undefined,
  chunksById: Map<string, NormalizedContent["sourceChunks"][number]>,
  factsById: Map<string, NonNullable<NormalizedContent["facts"]>[number]>,
): { claim: PlanClaim; rejected: boolean } {
  if (!evidence || (!evidence.verbatimEvidence.trim() && evidence.sourceChunkIds.length === 0 && evidence.factIds.length === 0)) {
    return unsupported(id, text, "missing_verifiable_evidence", false);
  }
  if (evidence.sourceChunkIds.length === 0) return unsupported(id, text, "missing_source_chunk", true);
  const chunks = evidence.sourceChunkIds.map((chunkId) => chunksById.get(chunkId));
  if (chunks.some((chunk) => !chunk)) return unsupported(id, text, "unknown_source_chunk_id", true);
  const resolvedChunks = chunks as NormalizedContent["sourceChunks"];
  if (!evidence.verbatimEvidence.trim()) return unsupported(id, text, "missing_verbatim_evidence", true);
  if (!resolvedChunks.some((chunk) => chunk.text.includes(evidence.verbatimEvidence))) {
    return unsupported(id, text, "verbatim_evidence_not_in_source_chunk", true);
  }
  const facts = evidence.factIds.map((factId) => factsById.get(factId));
  if (facts.some((fact) => !fact)) return unsupported(id, text, "unknown_fact_id", true);
  const resolvedFacts = facts as NonNullable<NormalizedContent["facts"]>;
  if (resolvedFacts.some((fact) => !evidence.sourceChunkIds.includes(fact.chunkId))) {
    return unsupported(id, text, "fact_not_owned_by_cited_source_chunk", true);
  }
  // Grounding requires an actual textual quote, not a semantic guess. This is
  // deliberately stricter than source-level paraphrase matching.
  if (!normalize(evidence.verbatimEvidence).includes(normalize(text))) {
    return unsupported(id, text, "content_not_verbatim_evidence", false);
  }
  const valueMismatch = claimedValuesMismatchFacts(text, resolvedFacts);
  if (valueMismatch) return unsupported(id, text, valueMismatch, true);

  return {
    claim: {
      id,
      text,
      grounding: "grounded",
      precision: resolvedChunks.some((chunk) => chunk.precision === "exact") ? "exact" : "document",
      sourceRefs: { sourceChunkIds: evidence.sourceChunkIds, factIds: evidence.factIds },
    },
    rejected: false,
  };
}

function claimedValuesMismatchFacts(text: string, facts: NonNullable<NormalizedContent["facts"]>): string | undefined {
  const numericClaims = [...text.matchAll(/(?<![\p{L}\d])[+-]?\d+(?:[.,]\d+)?/gu)]
    .map((match) => Number(match[0].replace(",", ".")))
    .filter(Number.isFinite);
  if (numericClaims.length) {
    const numericFacts = facts
      .filter((fact): fact is Extract<typeof fact, { kind: "spreadsheet-cell" }> => fact.kind === "spreadsheet-cell" && fact.valueType === "number")
      .map((fact) => fact.value as number);
    if (!numericClaims.every((value) => numericFacts.some((factValue) => Object.is(value, factValue)))) return "numeric_claim_not_supported_by_cited_facts";
  }
  const dateClaims = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)].map((match) => match[0]);
  if (dateClaims.length) {
    const dateFacts = facts
      .filter((fact): fact is Extract<typeof fact, { kind: "spreadsheet-cell" }> => fact.kind === "spreadsheet-cell" && fact.valueType === "date")
      .map((fact) => String(fact.value).slice(0, 10));
    if (!dateClaims.every((value) => dateFacts.includes(value))) return "date_claim_not_supported_by_cited_facts";
  }
  return undefined;
}

function unsupported(id: string, text: string, groundingReason: string, rejected: boolean) {
  return {
    claim: {
      id,
      text,
      grounding: "unsupported" as const,
      groundingReason,
      precision: "document" as const,
      sourceRefs: { sourceChunkIds: [], factIds: [] },
    },
    rejected,
  };
}

function unionSourceRefs(claims: PlanClaim[]) {
  return {
    sourceChunkIds: [...new Set(claims.flatMap((claim) => claim.sourceRefs.sourceChunkIds))],
    factIds: [...new Set(claims.flatMap((claim) => claim.sourceRefs.factIds))],
  };
}

function normalize(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
}
