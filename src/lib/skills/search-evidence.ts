import { z } from "zod";
import { normalizedContentSchema, type NormalizedContent } from "../schemas";

const requestedExcerptSchema = z.object({
  sourceChunkId: z.string().min(1),
  excerpt: z.string().min(1).max(5_000),
  factIds: z.array(z.string().min(1)).max(50).default([]),
}).strict();

export const searchEvidenceRequestSchema = z.object({
  sourceChunkIds: z.array(z.string().min(1)).max(50).default([]),
  factIds: z.array(z.string().min(1)).max(50).default([]),
  query: z.string().min(1).max(500).optional(),
  excerpts: z.array(requestedExcerptSchema).max(50).default([]),
}).strict().superRefine((request, context) => {
  if (!request.sourceChunkIds.length && !request.factIds.length && !request.query && !request.excerpts.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence request requires a source ID, fact ID, query, or excerpt selector" });
  }
});
export type SearchEvidenceRequest = z.input<typeof searchEvidenceRequestSchema>;

export const searchEvidenceMatchSchema = z.object({
  sourceChunkId: z.string().min(1),
  factIds: z.array(z.string().min(1)).max(50),
  excerpt: z.string().min(1).max(5_000),
}).strict();
export type SearchEvidenceMatch = z.infer<typeof searchEvidenceMatchSchema>;

export const searchEvidenceResultSchema = z.object({
  matches: z.array(searchEvidenceMatchSchema).max(50),
}).strict();
export type SearchEvidenceResult = z.infer<typeof searchEvidenceResultSchema>;

export class SearchEvidenceError extends Error {
  constructor(readonly code: "unknown_source_chunk_id" | "unknown_fact_id" | "non_exact_excerpt" | "unconfirmed_evidence") {
    super(code);
    this.name = "SearchEvidenceError";
  }
}

/**
 * Pure evidence resolver. It deliberately accepts only validated normalized
 * content and returns no location, coordinate, XML, or arbitrary model fields.
 */
export function searchEvidence(content: NormalizedContent, request: SearchEvidenceRequest): SearchEvidenceResult {
  const parsedContent = normalizedContentSchema.parse(content);
  const parsedRequest = searchEvidenceRequestSchema.parse(request);
  const chunksById = new Map(parsedContent.sourceChunks.map((chunk) => [chunk.chunkId, chunk]));
  const factsById = new Map((parsedContent.facts ?? []).map((fact) => [fact.factId, fact]));
  const selected = new Map<string, { excerpt: string; factIds: Set<string> }>();

  const add = (sourceChunkId: string, excerpt: string, factIds: string[] = []) => {
    const chunk = chunksById.get(sourceChunkId);
    if (!chunk) throw new SearchEvidenceError("unknown_source_chunk_id");
    if (!chunk.text.includes(excerpt)) throw new SearchEvidenceError("non_exact_excerpt");
    const current = selected.get(sourceChunkId) ?? { excerpt, factIds: new Set<string>() };
    for (const factId of factIds) current.factIds.add(factId);
    selected.set(sourceChunkId, current);
  };

  for (const sourceChunkId of parsedRequest.sourceChunkIds) {
    const chunk = chunksById.get(sourceChunkId);
    if (!chunk) throw new SearchEvidenceError("unknown_source_chunk_id");
    add(sourceChunkId, chunk.text);
  }
  for (const factId of parsedRequest.factIds) {
    const fact = factsById.get(factId);
    if (!fact) throw new SearchEvidenceError("unknown_fact_id");
    const chunk = chunksById.get(fact.chunkId);
    if (!chunk) throw new SearchEvidenceError("unconfirmed_evidence");
    add(chunk.chunkId, chunk.text, [factId]);
  }
  for (const candidate of parsedRequest.excerpts) {
    for (const factId of candidate.factIds) {
      const fact = factsById.get(factId);
      if (!fact) throw new SearchEvidenceError("unknown_fact_id");
      if (fact.chunkId !== candidate.sourceChunkId) throw new SearchEvidenceError("unconfirmed_evidence");
    }
    add(candidate.sourceChunkId, candidate.excerpt, candidate.factIds);
  }
  if (parsedRequest.query) {
    const query = normalize(parsedRequest.query);
    for (const chunk of parsedContent.sourceChunks) {
      if (normalize(chunk.text).includes(query)) add(chunk.chunkId, chunk.text);
    }
  }
  if (!selected.size) throw new SearchEvidenceError("unconfirmed_evidence");
  return searchEvidenceResultSchema.parse({
    matches: [...selected.entries()].map(([sourceChunkId, value]) => ({
      sourceChunkId,
      factIds: [...value.factIds],
      excerpt: value.excerpt,
    })),
  });
}

function normalize(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
}
