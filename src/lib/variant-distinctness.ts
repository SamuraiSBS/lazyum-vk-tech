import { createHash } from "node:crypto";
import type {
  CanvasElement,
  LayoutVariant,
  PresentationDocument,
  RenderedSlide,
} from "./schemas";

/**
 * Canvas coordinates are authored in CSS-pixel space. One pixel is precise
 * enough to distinguish intentional layout changes while filtering harmless
 * floating-point serialization noise.
 */
export const STRUCTURAL_FINGERPRINT_QUANTIZATION = 1;

export type StructuralElementFingerprint = {
  type: CanvasElement["type"];
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  text?: {
    fontSize: number;
    fontWeight: number;
    align: "left" | "center" | "right";
  };
  shape?: {
    shape: "rect" | "roundRect" | "ellipse" | "line";
    fill: string;
    stroke: string;
    strokeWidth: number;
    radius: number;
  };
  chart?: {
    chartType: "pie";
    categories: string[];
    seriesLabel: string;
    values: number[];
  };
  image?: {
    present: true;
    x: number;
    y: number;
    w: number;
    h: number;
  };
};

export type StructuralSlideFingerprint = {
  slideNumber: number;
  purpose: RenderedSlide["purpose"];
  templateLayoutId: string;
  canvas: { width: number; height: number };
  elements: StructuralElementFingerprint[];
  digest: string;
};

export type PresentationStructuralFingerprint = {
  version: 1;
  quantization: number;
  slides: StructuralSlideFingerprint[];
  digest: string;
};

export type StructuralDistance = {
  comparedSlides: number;
  differentSlides: number;
  differentSlideRatio: number;
  leftOnlyElements: number;
  rightOnlyElements: number;
  totalElements: number;
  differingElementRatio: number;
};

export type PerSlideVariantComparison = {
  slideNumber: number;
  purpose: RenderedSlide["purpose"] | "missing";
  equal: boolean;
  left: StructuralSlideFingerprint | null;
  right: StructuralSlideFingerprint | null;
  distance: StructuralDistance;
};

export type VariantPairComparison = {
  pair: readonly [LayoutVariant, LayoutVariant];
  samePlan: boolean;
  sameDesignSystem: boolean;
  sameSlideCount: boolean;
  leftSlideCount: number;
  rightSlideCount: number;
  perSlideFingerprints: PerSlideVariantComparison[];
  differentSlideCount: number;
  nonTitleDifferingSlides: number[];
  structuralDistance: StructuralDistance;
  identicalStructuralFingerprints: boolean;
  diagnostics: string[];
};

export type VariantDistinctnessReport = {
  fingerprints: Record<LayoutVariant, PresentationStructuralFingerprint>;
  pairs: VariantPairComparison[];
};

const VARIANTS: readonly LayoutVariant[] = ["compact", "balanced", "visual"];

/**
 * Produces an explainable representation of slide composition. Ordinary text
 * values, element ids, document.variant and timestamps are excluded; semantic
 * chart categories and values remain because they define the chart itself.
 */
export function fingerprintPresentationDocument(
  document: PresentationDocument,
  quantization = STRUCTURAL_FINGERPRINT_QUANTIZATION,
): PresentationStructuralFingerprint {
  if (!Number.isFinite(quantization) || quantization <= 0) {
    throw new Error(`Structural fingerprint quantization must be positive; received ${quantization}`);
  }
  const slides = document.slides.map((slide, index) => fingerprintSlide(slide, index + 1, quantization));
  return {
    version: 1,
    quantization,
    slides,
    digest: digest({ version: 1, quantization, slides }),
  };
}

/**
 * Compares Compact, Balanced and Visual documents without trusting their
 * variant labels as evidence of distinct composition.
 */
export function comparePresentationVariants(input: Record<LayoutVariant, PresentationDocument>): VariantDistinctnessReport {
  const fingerprints = Object.fromEntries(VARIANTS.map((variant) => [
    variant,
    fingerprintPresentationDocument(input[variant]),
  ])) as Record<LayoutVariant, PresentationStructuralFingerprint>;
  const pairs: VariantPairComparison[] = [
    compareVariantPair("compact", input.compact, fingerprints.compact, "balanced", input.balanced, fingerprints.balanced),
    compareVariantPair("compact", input.compact, fingerprints.compact, "visual", input.visual, fingerprints.visual),
    compareVariantPair("balanced", input.balanced, fingerprints.balanced, "visual", input.visual, fingerprints.visual),
  ];
  return { fingerprints, pairs };
}

/** Throws one actionable failure report for a pair that does not meet the hard gates. */
export function assertVariantPairDistinct(pair: VariantPairComparison) {
  const failures: string[] = [];
  if (!pair.samePlan) failures.push("canonical plans differ");
  if (!pair.sameDesignSystem) failures.push("design systems differ");
  if (!pair.sameSlideCount) failures.push(`slide counts differ (${pair.leftSlideCount} vs ${pair.rightSlideCount})`);
  if (pair.identicalStructuralFingerprints) failures.push("all structural fingerprints are identical");
  if (pair.nonTitleDifferingSlides.length === 0) failures.push("only the title slide differs (or no slide differs)");
  if (failures.length > 0) {
    throw new Error(`VARIANT_DISTINCTNESS_FAILURE [${pair.pair.join(" vs ")}]: ${failures.join("; ")}. ${pair.diagnostics.join(" ")}`);
  }
}

function compareVariantPair(
  leftVariant: LayoutVariant,
  leftDocument: PresentationDocument,
  leftFingerprint: PresentationStructuralFingerprint,
  rightVariant: LayoutVariant,
  rightDocument: PresentationDocument,
  rightFingerprint: PresentationStructuralFingerprint,
): VariantPairComparison {
  const slideCount = Math.max(leftFingerprint.slides.length, rightFingerprint.slides.length);
  const perSlideFingerprints: PerSlideVariantComparison[] = [];
  for (let index = 0; index < slideCount; index += 1) {
    const left = leftFingerprint.slides[index] ?? null;
    const right = rightFingerprint.slides[index] ?? null;
    const purpose = left?.purpose ?? right?.purpose ?? "missing";
    const distance = compareSlideFingerprints(left, right);
    perSlideFingerprints.push({
      slideNumber: index + 1,
      purpose,
      equal: Boolean(left && right && left.digest === right.digest),
      left,
      right,
      distance,
    });
  }
  const structuralDistance = combineDistances(perSlideFingerprints.map((slide) => slide.distance));
  const nonTitleDifferingSlides = perSlideFingerprints
    .filter((slide) => slide.purpose !== "title" && !slide.equal)
    .map((slide) => slide.slideNumber);
  const samePlan = canonicalJson(leftDocument.plan) === canonicalJson(rightDocument.plan);
  const sameDesignSystem = canonicalJson(leftDocument.designSystem) === canonicalJson(rightDocument.designSystem);
  const sameSlideCount = leftDocument.slides.length === rightDocument.slides.length;
  const identicalStructuralFingerprints = leftFingerprint.digest === rightFingerprint.digest;
  const diagnostics = createDiagnostics({
    leftVariant,
    rightVariant,
    samePlan,
    sameDesignSystem,
    sameSlideCount,
    leftSlideCount: leftDocument.slides.length,
    rightSlideCount: rightDocument.slides.length,
    perSlideFingerprints,
    identicalStructuralFingerprints,
    nonTitleDifferingSlides,
    structuralDistance,
  });
  return {
    pair: [leftVariant, rightVariant],
    samePlan,
    sameDesignSystem,
    sameSlideCount,
    leftSlideCount: leftDocument.slides.length,
    rightSlideCount: rightDocument.slides.length,
    perSlideFingerprints,
    differentSlideCount: structuralDistance.differentSlides,
    nonTitleDifferingSlides,
    structuralDistance,
    identicalStructuralFingerprints,
    diagnostics,
  };
}

function fingerprintSlide(slide: RenderedSlide, slideNumber: number, quantization: number): StructuralSlideFingerprint {
  const elements = slide.canvas.elements
    .map((element) => fingerprintElement(element, quantization))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const fingerprint = {
    slideNumber,
    purpose: slide.purpose,
    templateLayoutId: slide.templateLayoutId,
    canvas: {
      width: quantize(slide.canvas.width, quantization),
      height: quantize(slide.canvas.height, quantization),
    },
    elements,
  };
  return { ...fingerprint, digest: digest(fingerprint) };
}

function fingerprintElement(element: CanvasElement, quantization: number): StructuralElementFingerprint {
  const geometry = {
    x: quantize(element.x, quantization),
    y: quantize(element.y, quantization),
    w: quantize(element.w, quantization),
    h: quantize(element.h, quantization),
  };
  if (element.type === "text") {
    return {
      type: "text",
      ...geometry,
      zIndex: element.zIndex,
      text: {
        fontSize: quantize(element.fontSize, quantization),
        fontWeight: element.fontWeight,
        align: element.align,
      },
    };
  }
  if (element.type === "shape") {
    return {
      type: "shape",
      ...geometry,
      zIndex: element.zIndex,
      shape: {
        shape: element.shape,
        fill: element.fill,
        stroke: element.stroke,
        strokeWidth: quantize(element.strokeWidth, quantization),
        radius: quantize(element.radius, quantization),
      },
    };
  }
  if (element.type === "chart") {
    return {
      type: "chart",
      ...geometry,
      zIndex: element.zIndex,
      chart: {
        chartType: element.chartType,
        categories: element.categories.map((category) => category.value),
        seriesLabel: element.series.label.value,
        values: element.series.values.map((datum) => datum.value),
      },
    };
  }
  return {
    type: "image",
    ...geometry,
    zIndex: element.zIndex,
    image: { present: true, ...geometry },
  };
}

function compareSlideFingerprints(left: StructuralSlideFingerprint | null, right: StructuralSlideFingerprint | null): StructuralDistance {
  if (!left || !right) {
    const elementCount = (left?.elements.length ?? 0) + (right?.elements.length ?? 0);
    return {
      comparedSlides: 1,
      differentSlides: 1,
      differentSlideRatio: 1,
      leftOnlyElements: left?.elements.length ?? 0,
      rightOnlyElements: right?.elements.length ?? 0,
      totalElements: elementCount,
      differingElementRatio: elementCount === 0 ? 1 : 1,
    };
  }
  const leftElements = left.elements.map(canonicalJson);
  const rightElements = right.elements.map(canonicalJson);
  const unmatchedRight = new Map<string, number>();
  for (const value of rightElements) unmatchedRight.set(value, (unmatchedRight.get(value) ?? 0) + 1);
  let leftOnlyElements = 0;
  for (const value of leftElements) {
    const count = unmatchedRight.get(value) ?? 0;
    if (count > 0) unmatchedRight.set(value, count - 1);
    else leftOnlyElements += 1;
  }
  const rightOnlyElements = [...unmatchedRight.values()].reduce((sum, count) => sum + count, 0);
  const equal = left.digest === right.digest;
  // The denominator counts both multisets, so a full replacement is 1.0
  // rather than an unintuitive value above one.
  const totalElements = left.elements.length + right.elements.length;
  return {
    comparedSlides: 1,
    differentSlides: equal ? 0 : 1,
    differentSlideRatio: equal ? 0 : 1,
    leftOnlyElements,
    rightOnlyElements,
    totalElements,
    differingElementRatio: totalElements === 0 ? (equal ? 0 : 1) : (leftOnlyElements + rightOnlyElements) / totalElements,
  };
}

function combineDistances(distances: StructuralDistance[]): StructuralDistance {
  const comparedSlides = distances.reduce((sum, distance) => sum + distance.comparedSlides, 0);
  const differentSlides = distances.reduce((sum, distance) => sum + distance.differentSlides, 0);
  const leftOnlyElements = distances.reduce((sum, distance) => sum + distance.leftOnlyElements, 0);
  const rightOnlyElements = distances.reduce((sum, distance) => sum + distance.rightOnlyElements, 0);
  const totalElements = distances.reduce((sum, distance) => sum + distance.totalElements, 0);
  return {
    comparedSlides,
    differentSlides,
    differentSlideRatio: comparedSlides === 0 ? 0 : differentSlides / comparedSlides,
    leftOnlyElements,
    rightOnlyElements,
    totalElements,
    differingElementRatio: totalElements === 0 ? 0 : (leftOnlyElements + rightOnlyElements) / totalElements,
  };
}

function createDiagnostics(input: {
  leftVariant: LayoutVariant;
  rightVariant: LayoutVariant;
  samePlan: boolean;
  sameDesignSystem: boolean;
  sameSlideCount: boolean;
  leftSlideCount: number;
  rightSlideCount: number;
  perSlideFingerprints: PerSlideVariantComparison[];
  identicalStructuralFingerprints: boolean;
  nonTitleDifferingSlides: number[];
  structuralDistance: StructuralDistance;
}) {
  const messages: string[] = [];
  if (!input.samePlan) messages.push("FAIL: documents do not share one canonical plan.");
  if (!input.sameDesignSystem) messages.push("FAIL: documents do not share one design system.");
  if (!input.sameSlideCount) messages.push(`FAIL: slide counts differ (${input.leftSlideCount} vs ${input.rightSlideCount}).`);
  if (input.identicalStructuralFingerprints) {
    messages.push("FAIL: structural fingerprints are identical; inspect renderer/layout variant selection.");
  } else if (input.nonTitleDifferingSlides.length === 0) {
    messages.push("FAIL: only the title slide differs; a bounded renderer/layout task must create non-title composition changes.");
  } else {
    messages.push(`PASS: non-title structural differences on slides ${input.nonTitleDifferingSlides.join(", ")}.`);
  }
  messages.push(
    `distance: slides=${input.structuralDistance.differentSlides}/${input.structuralDistance.comparedSlides}, `
      + `elements=${input.structuralDistance.leftOnlyElements}+${input.structuralDistance.rightOnlyElements}/${input.structuralDistance.totalElements}.`,
  );
  return messages;
}

function quantize(value: number, step: number) {
  return Math.round(value / step) * step;
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
