import {
  evidencePackSchema,
  templateInterpretationSchema,
  type EvidencePack,
  type TemplateInterpretation,
} from "./agent-contracts";
import { normalizedContentSchema, type NormalizedContent } from "./schemas";
import { z } from "zod";

export const plannerSpecialistContextSchema = z.object({
  template: templateInterpretationSchema,
  evidence: evidencePackSchema,
}).strict();

export type PlannerSpecialistContext = {
  template: TemplateInterpretation;
  evidence: EvidencePack;
};

export type PlannerReferenceIndex = {
  sourceChunkIds: Iterable<string>;
  factIds: Iterable<string>;
  factChunkIds?: ReadonlyMap<string, string>;
};

function validateReferences(context: PlannerSpecialistContext, references: PlannerReferenceIndex) {
  const sourceChunkIds = new Set(references.sourceChunkIds);
  const factIds = new Set(references.factIds);
  const errors: string[] = [];

  const checkRefs = (label: string, refs: { sourceChunkIds: string[]; factIds: string[] }) => {
    for (const sourceChunkId of refs.sourceChunkIds) {
      if (!sourceChunkIds.has(sourceChunkId)) errors.push(`${label} references unknown sourceChunkId ${sourceChunkId}`);
    }
    for (const factId of refs.factIds) {
      if (!factIds.has(factId)) {
        errors.push(`${label} references unknown factId ${factId}`);
        continue;
      }
      const factChunkId = references.factChunkIds?.get(factId);
      if (factChunkId && refs.sourceChunkIds.length > 0 && !refs.sourceChunkIds.includes(factChunkId)) {
        errors.push(`${label} factId ${factId} does not belong to a cited sourceChunkId`);
      }
    }
  };

  context.evidence.claims.forEach((claim) => checkRefs(`evidence claim ${claim.id}`, claim.sourceRefs));
  context.evidence.contradictions.forEach((contradiction) => checkRefs(`evidence contradiction ${contradiction.id}`, contradiction.sourceRefs));
  if (errors.length > 0) throw new Error(`Planner specialist grounding validation failed: ${errors.join("; ")}`);
}

export function createPlannerSpecialistContextFromReferences(
  templateOutput: unknown,
  evidenceOutput: unknown,
  references: PlannerReferenceIndex,
): PlannerSpecialistContext {
  const parsed = plannerSpecialistContextSchema.parse({
    template: templateOutput,
    evidence: evidenceOutput,
  });
  validateReferences(parsed, references);
  return parsed;
}

export function createPlannerSpecialistContext(
  templateOutput: unknown,
  evidenceOutput: unknown,
  content: NormalizedContent,
): PlannerSpecialistContext {
  const parsed = plannerSpecialistContextSchema.parse({
    template: templateOutput,
    evidence: evidenceOutput,
  });
  const parsedContent = normalizedContentSchema.parse(content);
  validateReferences(parsed, {
    sourceChunkIds: parsedContent.sourceChunks.map((chunk) => chunk.chunkId),
    factIds: (parsedContent.facts ?? []).map((fact) => fact.factId),
    factChunkIds: new Map((parsedContent.facts ?? []).map((fact) => [fact.factId, fact.chunkId])),
  });
  return parsed;
}

export function validatePlannerSpecialistContext(
  context: unknown,
  content: NormalizedContent,
): PlannerSpecialistContext {
  const parsed = plannerSpecialistContextSchema.parse(context);
  const parsedContent = normalizedContentSchema.parse(content);
  validateReferences(parsed, {
    sourceChunkIds: parsedContent.sourceChunks.map((chunk) => chunk.chunkId),
    factIds: (parsedContent.facts ?? []).map((fact) => fact.factId),
    factChunkIds: new Map((parsedContent.facts ?? []).map((fact) => [fact.factId, fact.chunkId])),
  });
  return parsed;
}
