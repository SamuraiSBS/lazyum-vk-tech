import { normalizedContentSchema, presentationPlanSchema, type NormalizedContent, type PresentationPlan } from "../schemas";
import { createPresentationPlan, type LlmProvider } from "../planner";
import { searchEvidence } from "./search-evidence";

export type GroundedDeckPlannerRequest = {
  content: NormalizedContent;
  slideCount: number;
  provider?: LlmProvider;
};

/**
 * Skill boundary only: planning remains in planner.ts and evidence remains in
 * search-evidence.ts. This adapter does not calculate geometry or make PPTX.
 */
export async function createGroundedDeckPlan(request: GroundedDeckPlannerRequest): Promise<PresentationPlan> {
  const content = normalizedContentSchema.parse(request.content);
  const plan = await createPresentationPlan(content, request.slideCount, request.provider);
  for (const claim of plan.slides.flatMap((slide) => slide.claims ?? [])) {
    if (claim.grounding !== "grounded") continue;
    searchEvidence(content, {
      sourceChunkIds: claim.sourceRefs.sourceChunkIds,
      factIds: claim.sourceRefs.factIds,
    });
  }
  return presentationPlanSchema.parse(plan);
}
