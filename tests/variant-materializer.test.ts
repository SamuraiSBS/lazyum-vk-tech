import { describe, expect, it } from "vitest";
import { presentationPlanSchema, type LayoutVariant, type PresentationPlan } from "../src/lib/schemas";
import { variantPlanSchema, type VariantPlan } from "../src/lib/agent-contracts";
import {
  createDryRunDesignSystem,
  materializeVariantSet,
  VariantMaterializationError,
} from "../src/lib/variant-materializer";

const variants: readonly LayoutVariant[] = ["compact", "balanced", "visual"];

function plan(overrides: Partial<PresentationPlan> = {}): PresentationPlan {
  return presentationPlanSchema.parse({
    title: "Детерминированный dry-run",
    planner: "deterministic",
    slides: Array.from({ length: 5 }, (_, index) => ({
      id: `slide-${index + 1}`,
      purpose: index === 0 ? "title" : index === 1 ? "problem" : "solution",
      title: `Слайд ${index + 1}`,
      content: [`Проверяемое содержание ${index + 1}`],
      visualIntent: index === 1 ? "cards" : "none",
      sourceRefs: { sourceChunkIds: [], factIds: [] },
      claims: [],
    })),
    ...overrides,
  });
}

function variantPlan(variant: LayoutVariant, layoutForSlide: (index: number) => string): VariantPlan {
  return variantPlanSchema.parse({
    version: "v1",
    variant,
    profile: {
      density: variant === "compact" ? "compact" : variant === "visual" ? "airy" : "balanced",
      visualRatio: variant === "compact" ? "low" : variant === "visual" ? "high" : "medium",
      dataEmphasis: variant === "compact" ? "high" : variant === "visual" ? "low" : "medium",
    },
    slides: Array.from({ length: 5 }, (_, index) => ({
      slideId: `slide-${index + 1}`,
      layoutId: layoutForSlide(index),
      slotAssignments: [{
        slotId: `slide-${index + 1}-title`,
        role: "title",
        claimIds: [],
      }],
      contentMode: variant === "compact" ? "compressed" : variant === "visual" ? "expanded" : "balanced",
    })),
    rationale: `${variant} deterministic test profile`,
    expectedTradeoff: "Only geometry should differ",
  });
}

function setup() {
  const designSystem = createDryRunDesignSystem({
    layouts: [
      { id: "layout-title", composition: "title", textSlots: 2, visualSlots: 0, cardCount: 0 },
      { id: "layout-cards", composition: "cards", textSlots: 4, visualSlots: 1, cardCount: 3 },
      { id: "layout-visual", composition: "visual", textSlots: 2, visualSlots: 1, cardCount: 0 },
    ],
    designTokens: { colors: ["#112233", "#445566", "#FFFFFF"], headingFonts: ["Arial"], bodyFonts: ["Arial"] },
  });
  const canonicalPlan = plan();
  const layoutForSlide = (index: number) => index === 0 ? "layout-title" : index % 2 ? "layout-cards" : "layout-visual";
  return {
    designSystem,
    plan: canonicalPlan,
    variantPlans: variants.map((variant) => variantPlan(variant, layoutForSlide)),
  };
}

describe("P0-12.4 deterministic variant materialization", () => {
  it("materializes exactly three valid documents from one plan and design system", () => {
    const input = setup();
    const result = materializeVariantSet({
      ...input,
      sourceChunkIds: [],
      factIds: [],
    });

    expect(result).toHaveLength(3);
    expect(result.map((item) => item.variant)).toEqual(["compact", "balanced", "visual"]);
    expect(result.every((item) => item.document.slides.length === 5)).toBe(true);
    expect(result.every((item) => item.document.designSystem)).toBe(true);
    expect(result[0]?.document.designSystem).toEqual(input.designSystem);
    expect(result.every((item) => item.document.plan.title === input.plan.title)).toBe(true);
    expect(new Set(result.map((item) => item.geometryFingerprint.digest)).size).toBe(3);
    expect(result.every((item) => item.audit.passed)).toBe(true);
  });

  it("fails closed when a variant references a missing layout", () => {
    const input = setup();
    const broken = input.variantPlans.map((item, index) => index === 0
      ? { ...item, slides: item.slides.map((slide, slideIndex) => slideIndex === 1 ? { ...slide, layoutId: "layout-missing" } : slide) }
      : item);
    expect(() => materializeVariantSet({ ...input, variantPlans: broken, sourceChunkIds: [], factIds: [] }))
      .toThrowError(new VariantMaterializationError("missing_layout_ref"));
  });

  it("fails closed when the canonical plan contains an unknown fact ref", () => {
    const input = setup();
    const brokenPlan = plan({
      slides: input.plan.slides.map((slide, index) => index === 1
        ? { ...slide, sourceRefs: { sourceChunkIds: ["chunk-missing"], factIds: ["fact-missing"] } }
        : slide),
    });
    expect(() => materializeVariantSet({ ...input, plan: brokenPlan, sourceChunkIds: [], factIds: [] }))
      .toThrowError(new VariantMaterializationError("missing_source_ref"));
  });
});
