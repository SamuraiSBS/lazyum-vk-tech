import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { createPresentationPptx } from "../src/lib/pptx-export";
import { comparePngBuffers, RENDER_COMPARISON_CAVEAT, type PngComparisonResult } from "../src/lib/render-comparison";
import { renderPptxToPngs, runBoundedProcess, type RenderEvidenceBundle } from "../src/lib/render-evidence";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema, type LayoutVariant, type PresentationDocument } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { assertVariantPairDistinct, comparePresentationVariants, type VariantPairComparison } from "../src/lib/variant-distinctness";

const ORGANIZER_TEMPLATES = [
  "VK Tech шаблон.pptx",
  "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx",
  "Шаблон презентации VK Education.pptx",
] as const;
const VARIANTS = ["compact", "balanced", "visual"] as const;
const RENDER_LONG_EDGE_PX = 1_200;
const RENDER_JOB_TIMEOUT_MS = 900_000;
const ACCEPTANCE_TIMEOUT_MS = 2_700_000;
const describeAcceptance = process.env.VK_HACKATHON_VARIANT_DISTINCTNESS === "1" ? describe : describe.skip;

describeAcceptance("generated variant distinctness acceptance", () => {
  it("proves non-metadata structural and raster differences for all immutable organizer templates", async () => {
    const runId = createRunId();
    const evidenceRoot = path.resolve(process.cwd(), ".data", "acceptance", "variant-distinctness", runId);
    await mkdir(evidenceRoot, { recursive: true });
    const evidence: AcceptanceEvidence = {
      runId,
      generatedAt: new Date().toISOString(),
      input: {
        slideCount: 10,
        variants: [...VARIANTS],
        deterministicPlanner: true,
        renderLongEdgePx: RENDER_LONG_EDGE_PX,
      },
      environment: { node: process.version, packageVersion: await packageVersion(), libreOffice: "unavailable", poppler: "unavailable" },
      templates: [],
      aggregateDistributions: {},
      hardGates: {
        variantsMustNotBeStructurallyIdentical: true,
        nonTitleStructuralDifferenceRequired: true,
        nonTitleRasterPixelDifferenceRequired: true,
        metadataOnlyDifferenceIsInsufficient: true,
      },
      proposedDiagnosticThresholds: {
        status: "not configured",
        note: "This acceptance records observed ratios only. It deliberately sets no final visual-distinctness threshold.",
      },
      caveat: "Structural and LibreOffice/Poppler PNG evidence only; this is not PowerPoint pixel parity, DOM pixel parity, or full visual-fidelity acceptance. " + RENDER_COMPARISON_CAVEAT,
    };
    const failures: string[] = [];

    try {
      for (const templateName of ORGANIZER_TEMPLATES) {
        const result = await evaluateTemplate(templateName, evidenceRoot);
        evidence.templates.push(result.templateEvidence);
        evidence.environment.libreOffice = result.environment.libreOffice;
        evidence.environment.poppler = result.environment.poppler;
        failures.push(...result.failures);
      }
      evidence.aggregateDistributions = summarize(evidence.templates);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(detail);
      evidence.aggregateDistributions = summarize(evidence.templates);
    } finally {
      evidence.failures = failures;
      await writeFile(path.join(evidenceRoot, "variant-distinctness-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    }

    expect(failures, `Variant-distinctness evidence: ${path.join(evidenceRoot, "variant-distinctness-evidence.json")}`).toEqual([]);
  }, ACCEPTANCE_TIMEOUT_MS);
});

async function evaluateTemplate(templateName: string, evidenceRoot: string) {
  const templatePath = path.resolve(process.cwd(), "fixtures", "templates", "organizer", templateName);
  const templateBuffer = await readFile(templatePath);
  const designSystem = await parsePptxTemplate(templateBuffer, templateName);
  const content = await normalizeContent("VK Tech deterministic variant-distinctness acceptance", [{
    name: "variant-distinctness-source.txt",
    type: "text/plain",
    buffer: Buffer.from("Три визуально различимых варианта используют один общий детерминированный план, единый дизайн-шаблон и одинаковые исходные факты."),
  }]);
  const plan = await createPresentationPlan(content, 10);
  const documents = Object.fromEntries(VARIANTS.map((variant) => [variant, presentationDocumentSchema.parse({
    ...renderPresentation(designSystem, plan, variant),
    variant,
  })])) as Record<LayoutVariant, PresentationDocument>;
  const report = comparePresentationVariants(documents);
  const target = proportionalRenderTarget(designSystem.slideSize);
  const templateKey = sanitizeTemplateName(templateName);
  const templateRoot = path.join(evidenceRoot, templateKey);
  await mkdir(templateRoot, { recursive: true });
  const rendered: Record<LayoutVariant, RenderEvidenceBundle> = {} as Record<LayoutVariant, RenderEvidenceBundle>;
  let environment = { libreOffice: "unavailable", poppler: "unavailable" };

  for (const variant of VARIANTS) {
    const pptxPath = path.join(templateRoot, `${variant}.pptx`);
    await writeFile(pptxPath, await createPresentationPptx(documents[variant]));
    try {
      const outputDir = path.join(templateRoot, variant);
      const render = await renderPptxToPngs(pptxPath, {
        outputDir,
        width: target.width,
        height: target.height,
        jobTimeoutMs: RENDER_JOB_TIMEOUT_MS,
      });
      rendered[variant] = render;
      environment = await collectRuntimeVersions(render);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`RENDER_BLOCKER [template=${templateName} variant=${variant}]: ${detail}`, { cause: error });
    }
  }

  const failures: string[] = [];
  const pairs = report.pairs.map((pair) => evaluatePair(pair, rendered, failures, templateName));
  const planDeepEqual = report.pairs.every((pair) => pair.samePlan);
  const designSystemDeepEqual = report.pairs.every((pair) => pair.sameDesignSystem);
  const sameSlideCount = report.pairs.every((pair) => pair.sameSlideCount);
  if (!planDeepEqual) failures.push(`VARIANT_DISTINCTNESS_FAILURE [template=${templateName}]: canonical plans differ.`);
  if (!designSystemDeepEqual) failures.push(`VARIANT_DISTINCTNESS_FAILURE [template=${templateName}]: design systems differ.`);
  if (!sameSlideCount) failures.push(`VARIANT_DISTINCTNESS_FAILURE [template=${templateName}]: slide counts differ.`);
  for (const [variant, render] of Object.entries(rendered) as Array<[LayoutVariant, RenderEvidenceBundle]>) {
    if (render.slideCount !== documents[variant].slides.length) {
      failures.push(`RENDER_BLOCKER [template=${templateName} variant=${variant}]: PNG page count=${render.slideCount}; expected=${documents[variant].slides.length}.`);
    }
  }
  return {
    environment,
    failures,
    templateEvidence: {
      template: { filename: templateName, sha256: sha256(templateBuffer) },
      input: { slideCount: 10, renderTarget: target, planner: plan.planner },
      invariants: { planDeepEqual, designSystemDeepEqual, sameSlideCount },
      variantPairs: pairs,
    },
  };
}

function evaluatePair(
  pair: VariantPairComparison,
  rendered: Record<LayoutVariant, RenderEvidenceBundle>,
  failures: string[],
  templateName: string,
) {
  try {
    assertVariantPairDistinct(pair);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const [leftVariant, rightVariant] = pair.pair;
  const left = rendered[leftVariant];
  const right = rendered[rightVariant];
  const rasterSlides: RasterSlideEvidence[] = left.slides.map((leftSlide) => {
    const rightSlide = right.slides.find((candidate) => candidate.slideNumber === leftSlide.slideNumber);
    if (!rightSlide) {
      failures.push(`RENDER_BLOCKER [template=${templateName} ${leftVariant} vs ${rightVariant}]: missing PNG slide ${leftSlide.slideNumber}.`);
      return { slideNumber: leftSlide.slideNumber, missingRightSlide: true };
    }
    return {
      slideNumber: leftSlide.slideNumber,
      purpose: pair.perSlideFingerprints[leftSlide.slideNumber - 1]?.purpose ?? "missing",
      comparison: comparePngBuffers(
        readFileSync(leftSlide.outputPath),
        readFileSync(rightSlide.outputPath),
        { baselinePath: `${leftVariant}/slide-${leftSlide.slideNumber}.png`, currentPath: `${rightVariant}/slide-${rightSlide.slideNumber}.png` },
      ),
    };
  });
  const nonTitlePixelDifferences = rasterSlides.filter((slide) => {
    const comparison = slide.comparison;
    return slide.purpose !== "title" && (comparison?.pixelDiff?.differingPixelRatio ?? 0) > 0;
  }).map((slide) => slide.slideNumber);
  const metadataOnlySlides = rasterSlides.filter((slide) => {
    const comparison = slide.comparison;
    return comparison?.pixelDiff?.differingPixels === 0
      && comparison.reasons.some((reason) => reason === "byte_size_mismatch" || reason === "sha256_mismatch");
  }).map((slide) => slide.slideNumber);
  if (nonTitlePixelDifferences.length === 0) {
    failures.push(`VARIANT_DISTINCTNESS_FAILURE [template=${templateName} ${leftVariant} vs ${rightVariant}]: no non-title PNG has differingPixelRatio > 0; metadata/hash-only differences are insufficient.`);
  }
  return {
    pair: pair.pair,
    structural: pair,
    hardGates: {
      structuralFingerprintsDiffer: !pair.identicalStructuralFingerprints,
      nonTitleStructuralSlides: pair.nonTitleDifferingSlides,
      nonTitleRasterPixelDifferenceSlides: nonTitlePixelDifferences,
      metadataOnlyRasterSlides: metadataOnlySlides,
    },
    rasterSlides,
  };
}

function proportionalRenderTarget(slideSize: { width: number; height: number }) {
  const longEdge = Math.max(slideSize.width, slideSize.height);
  return {
    width: Math.max(1, Math.round(RENDER_LONG_EDGE_PX * slideSize.width / longEdge)),
    height: Math.max(1, Math.round(RENDER_LONG_EDGE_PX * slideSize.height / longEdge)),
  };
}

async function collectRuntimeVersions(render: RenderEvidenceBundle) {
  const poppler = await runBoundedProcess(render.rasterizerPath, ["-v"], 60_000, "Poppler version")
    .then((result) => `${result.stdout}\n${result.stderr}`.trim() || "unavailable")
    .catch(() => "unavailable");
  return { libreOffice: render.rendererVersion || "unavailable", poppler };
}

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as { version?: string };
  return packageJson.version ?? "unavailable";
}

function summarize(templates: AcceptanceEvidence["templates"]) {
  const ratios = templates.flatMap((template) => template.variantPairs.flatMap((pair) => pair.rasterSlides.flatMap((slide) => {
    const comparison = slide.comparison;
    return comparison?.pixelDiff ? [comparison.pixelDiff.differingPixelRatio] : [];
  })));
  const structuralRatios = templates.flatMap((template) => template.variantPairs.map((pair) => pair.structural.structuralDistance.differingElementRatio));
  return {
    rasterDifferingPixelRatio: distribution(ratios),
    structuralDifferingElementRatio: distribution(structuralRatios),
  };
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    max: sorted.at(-1) ?? null,
    values: sorted,
  };
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeTemplateName(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]+/gu, "-").replace(/^-|-$/gu, "") || "template";
}

function createRunId() {
  return new Date().toISOString().replace(/[:.]/gu, "-") + `-${process.pid}`;
}

type AcceptanceEvidence = {
  runId: string;
  generatedAt: string;
  input: Record<string, unknown>;
  environment: { node: string; packageVersion: string; libreOffice: string; poppler: string };
  templates: Array<{
    template: { filename: string; sha256: string };
    input: Record<string, unknown>;
    invariants: Record<string, boolean>;
    variantPairs: Array<ReturnType<typeof evaluatePair>>;
  }>;
  aggregateDistributions: Record<string, unknown>;
  hardGates: Record<string, boolean>;
  proposedDiagnosticThresholds: Record<string, string>;
  caveat: string;
  failures?: string[];
};

type RasterSlideEvidence = {
  slideNumber: number;
  purpose?: string;
  missingRightSlide?: true;
  comparison?: PngComparisonResult;
};
