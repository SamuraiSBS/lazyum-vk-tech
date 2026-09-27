import { z } from "zod";
import {
  auditReportSchema,
  designSystemSchema,
  presentationDocumentSchema,
  presentationPlanSchema,
  type DesignSystem,
  type LayoutVariant,
  type PresentationDocument,
  type PresentationPlan,
  type TemplateElement,
  type TemplateLayout,
} from "./schemas";
import {
  templateLayoutSummarySchema,
  variantIdSchema,
  variantPlanSchema,
  type TemplateLayoutSummary,
  type VariantId,
  type VariantPlan,
} from "./agent-contracts";
import { auditPresentation } from "./audit";
import { assertVariantPairDistinct, comparePresentationVariants, fingerprintPresentationDocument } from "./variant-distinctness";
import { renderPresentation } from "./renderer";

const VARIANTS: readonly VariantId[] = ["compact", "balanced", "visual"];

export const geometryFingerprintSchema = z.object({
  version: z.literal(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  slideDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(5).max(15),
  elementCount: z.number().int().nonnegative(),
}).strict();
export type GeometryFingerprint = z.infer<typeof geometryFingerprintSchema>;

export const materializedVariantSchema = z.object({
  variant: variantIdSchema,
  variantPlan: variantPlanSchema,
  document: presentationDocumentSchema,
  audit: auditReportSchema,
  geometryFingerprint: geometryFingerprintSchema,
}).strict();
export type MaterializedVariant = z.infer<typeof materializedVariantSchema>;

export class VariantMaterializationError extends Error {
  constructor(readonly code:
    | "incomplete_variant_set"
    | "duplicate_variant"
    | "missing_variant_slide_ref"
    | "missing_layout_ref"
    | "invalid_layout_ref"
    | "missing_source_ref"
    | "missing_fact_ref"
    | "missing_claim_ref"
    | "geometry_not_distinct") {
    super(code);
    this.name = "VariantMaterializationError";
  }
}

export type VariantMaterializationInput = {
  designSystem: DesignSystem;
  plan: PresentationPlan;
  variantPlans: readonly VariantPlan[];
  sourceChunkIds: Iterable<string>;
  factIds: Iterable<string>;
};

export type DryRunDesignSystemInput = {
  layouts: readonly TemplateLayoutSummary[];
  designTokens: {
    colors: readonly string[];
    headingFonts: readonly string[];
    bodyFonts: readonly string[];
  };
};

/**
 * Build a bounded in-memory design system only for the dry-run request shape
 * that carries layout summaries instead of the parsed template itself.
 * Real parsed DesignSystem input always wins in the orchestrator.
 */
export function createDryRunDesignSystem(input: DryRunDesignSystemInput): DesignSystem {
  const colors = input.designTokens.colors.length
    ? [
      ...input.designTokens.colors,
      ...(input.designTokens.colors.some((color) => color.toUpperCase() === "#FFFFFF") ? [] : ["#FFFFFF"]),
    ].slice(0, 24)
    : ["#FFFFFF"];
  const layouts = input.layouts.map((summary) => createDryRunLayout(summary, colors));
  return designSystemSchema.parse({
    version: 1,
    sourceName: "dry-run-template",
    slideSize: { width: 1280, height: 720, aspectRatio: 16 / 9 },
    colors,
    typography: {
      headingFonts: [...input.designTokens.headingFonts],
      bodyFonts: [...input.designTokens.bodyFonts],
      fontSizes: [18, 24, 36, 48],
      fontWeights: [400, 600, 700],
    },
    spacing: { horizontalMargins: [96], verticalMargins: [72], gaps: [24] },
    shapes: { types: ["rect", "roundRect", "line"], radii: [16], strokes: colors.slice(0, 4) },
    masters: [],
    layouts,
    recurringElements: [],
    visualPatterns: layouts.some((layout) => layout.visualSlots > 0) ? ["Dedicated visual area"] : [],
    warnings: ["Synthetic DesignSystem used because the dry-run input supplied layout summaries only"],
  });
}

export function materializeVariantSet(input: VariantMaterializationInput): MaterializedVariant[] {
  const designSystem = designSystemSchema.parse(input.designSystem);
  const plan = presentationPlanSchema.parse(input.plan);
  const variantPlans = input.variantPlans.map((variantPlan) => variantPlanSchema.parse(variantPlan));
  const sourceChunkIds = new Set(input.sourceChunkIds);
  const factIds = new Set(input.factIds);

  validatePlanReferences(plan, sourceChunkIds, factIds);
  validateVariantSet(variantPlans);

  const layoutIds = new Set<string>();
  for (const layout of designSystem.layouts) {
    if (layoutIds.has(layout.id)) throw new VariantMaterializationError("invalid_layout_ref");
    layoutIds.add(layout.id);
  }

  const materialized = variantPlans.map((variantPlan) => materializeVariant({
    designSystem,
    plan,
    variantPlan,
    layoutIds,
    sourceChunkIds,
    factIds,
  }));

  const documents = Object.fromEntries(materialized.map((item) => [item.variant, item.document])) as Record<LayoutVariant, PresentationDocument>;
  try {
    comparePresentationVariants(documents).pairs.forEach(assertVariantPairDistinct);
  } catch (error) {
    throw new VariantMaterializationError("geometry_not_distinct");
  }

  return materialized.map((item) => materializedVariantSchema.parse(item));
}

function materializeVariant(input: {
  designSystem: DesignSystem;
  plan: PresentationPlan;
  variantPlan: VariantPlan;
  layoutIds: ReadonlySet<string>;
  sourceChunkIds: ReadonlySet<string>;
  factIds: ReadonlySet<string>;
}): MaterializedVariant {
  const planSlides = new Map(input.plan.slides.map((slide) => [slide.id, slide]));
  const overrides = new Map<string, string>();
  for (const variantSlide of input.variantPlan.slides) {
    const canonicalSlide = planSlides.get(variantSlide.slideId);
    if (!canonicalSlide) throw new VariantMaterializationError("missing_variant_slide_ref");
    if (!input.layoutIds.has(variantSlide.layoutId)) {
      throw new VariantMaterializationError("missing_layout_ref");
    }
    const claimIds = new Set((canonicalSlide.claims || []).map((claim) => claim.id));
    for (const assignment of variantSlide.slotAssignments) {
      if (!assignment.slotId.startsWith(`${variantSlide.slideId}-`)) {
        throw new VariantMaterializationError("invalid_layout_ref");
      }
      for (const claimId of assignment.claimIds) {
        if (!claimIds.has(claimId)) throw new VariantMaterializationError("missing_claim_ref");
      }
    }
    overrides.set(variantSlide.slideId, variantSlide.layoutId);
  }
  if (overrides.size !== input.plan.slides.length) throw new VariantMaterializationError("missing_variant_slide_ref");

  const rendered = renderPresentation(
    input.designSystem,
    input.plan,
    input.variantPlan.variant,
    [],
    { layoutOverrides: overrides, variantGeometry: true },
  );
  const document = presentationDocumentSchema.parse({ ...rendered, variant: input.variantPlan.variant });
  const audit = auditPresentation(document);
  const fingerprint = fingerprintPresentationDocument(document);
  const geometryFingerprint = geometryFingerprintSchema.parse({
    version: 1,
    digest: fingerprint.digest,
    slideDigests: fingerprint.slides.map((slide) => slide.digest),
    elementCount: document.slides.reduce((total, slide) => total + slide.canvas.elements.length, 0),
  });

  // Re-check the refs at the materialization boundary. This keeps a future
  // renderer/layout change from silently publishing a document detached from
  // the evidence graph that produced the canonical plan.
  validatePlanReferences(document.plan, input.sourceChunkIds, input.factIds);
  return { variant: input.variantPlan.variant, variantPlan: input.variantPlan, document, audit, geometryFingerprint };
}

function validateVariantSet(variantPlans: readonly VariantPlan[]) {
  if (variantPlans.length !== VARIANTS.length) throw new VariantMaterializationError("incomplete_variant_set");
  const seen = new Set<VariantId>();
  for (const variantPlan of variantPlans) {
    if (seen.has(variantPlan.variant)) throw new VariantMaterializationError("duplicate_variant");
    seen.add(variantPlan.variant);
  }
  if (VARIANTS.some((variant) => !seen.has(variant))) throw new VariantMaterializationError("incomplete_variant_set");
}

function validatePlanReferences(
  plan: PresentationPlan,
  sourceChunkIds: ReadonlySet<string>,
  factIds: ReadonlySet<string>,
) {
  const check = (label: string, refs: { sourceChunkIds: string[]; factIds: string[] }) => {
    for (const sourceChunkId of refs.sourceChunkIds) {
      if (!sourceChunkIds.has(sourceChunkId)) throw new VariantMaterializationError("missing_source_ref");
    }
    for (const factId of refs.factIds) {
      if (!factIds.has(factId)) throw new VariantMaterializationError("missing_fact_ref");
    }
    void label;
  };
  for (const slide of plan.slides) {
    check(`slide:${slide.id}`, slide.sourceRefs || { sourceChunkIds: [], factIds: [] });
    for (const claim of slide.claims || []) check(`claim:${claim.id}`, claim.sourceRefs);
  }
}

function createDryRunLayout(summary: TemplateLayoutSummary, colors: readonly string[]): TemplateLayout {
  const width = 1280;
  const height = 720;
  const accent = colors[1] || colors[0] || "#D9E2F3";
  const text = (id: string, x: number, y: number, w: number, h: number, fontSize: number, zIndex: number): TemplateElement => ({
    id,
    type: "text",
    name: id,
    x,
    y,
    w,
    h,
    text: "",
    fontSize,
    fontWeight: zIndex === 10 ? 700 : 400,
    zIndex,
  });
  const elements: TemplateElement[] = [text(`${summary.id}-title`, 96, 72, 1088, 104, 44, 10)];
  if (summary.composition === "cards") {
    const count = Math.max(3, Math.min(4, summary.cardCount || 3));
    const gap = 24;
    const cardWidth = (1088 - gap * (count - 1)) / count;
    for (let index = 0; index < count; index += 1) {
      const x = 96 + index * (cardWidth + gap);
      elements.push({
        id: `${summary.id}-card-${index}`,
        type: "shape",
        name: "Card",
        x,
        y: 252,
        w: cardWidth,
        h: 286,
        text: "",
        fill: accent,
        stroke: accent,
        radius: 16,
        zIndex: 20,
      }, text(`${summary.id}-card-text-${index}`, x + 24, 282, cardWidth - 48, 220, 22, 30 + index));
    }
  } else if (summary.composition === "split") {
    elements.push(text(`${summary.id}-left`, 96, 246, 496, 292, 24, 20), text(`${summary.id}-right`, 688, 246, 496, 292, 24, 21));
  } else if (summary.composition === "visual") {
    elements.push(text(`${summary.id}-body`, 96, 244, 496, 300, 24, 20), {
      id: `${summary.id}-visual`,
      type: "shape",
      name: "Visual area",
      x: 672,
      y: 226,
      w: 512,
      h: 322,
      text: "",
      fill: accent,
      stroke: accent,
      radius: 16,
      zIndex: 15,
    });
  } else {
    elements.push(text(`${summary.id}-body`, 96, 246, 1088, 292, 24, 20));
  }
  return {
    id: summary.id,
    name: summary.id,
    source: "layout",
    sourceFile: "generated/agent-dry-run",
    width,
    height,
    background: colors[0] || "#FFFFFF",
    elements,
    textSlots: summary.textSlots,
    placeholderCount: 0,
    visualSlots: summary.visualSlots,
    cardCount: summary.composition === "cards" ? Math.max(3, summary.cardCount) : summary.cardCount,
    composition: summary.composition,
    recurringElementIds: [],
  };
}
