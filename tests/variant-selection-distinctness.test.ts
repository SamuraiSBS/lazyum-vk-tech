import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema, type LayoutVariant, type PresentationDocument } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { comparePresentationVariants } from "../src/lib/variant-distinctness";

const ORGANIZER_TEMPLATES = [
  "VK Tech шаблон.pptx",
  "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx",
  "Шаблон презентации VK Education.pptx",
] as const;
const VARIANTS = ["compact", "balanced", "visual"] as const;

describe("generic variant layout selection", () => {
  it("selects structurally distinct non-title observed layouts for every organizer template", async () => {
    const content = await normalizeContent("Deterministic organizer layout-profile selection", [{
      name: "variant-selection-source.txt",
      type: "text/plain",
      buffer: Buffer.from("All variants retain one source-grounded deterministic plan while their observed layout composition changes."),
    }]);
    const plan = await createPresentationPlan(content, 10);

    for (const templateName of ORGANIZER_TEMPLATES) {
      const templatePath = path.resolve(process.cwd(), "fixtures", "templates", "organizer", templateName);
      const designSystem = await parsePptxTemplate(await readFile(templatePath), templateName);
      const documents = Object.fromEntries(VARIANTS.map((variant) => [variant, presentationDocumentSchema.parse({
        ...renderPresentation(designSystem, plan, variant),
        variant,
      })])) as Record<LayoutVariant, PresentationDocument>;
      const comparison = comparePresentationVariants(documents);

      expect(documents.compact.plan, templateName).toEqual(plan);
      expect(documents.balanced.plan, templateName).toEqual(plan);
      expect(documents.visual.plan, templateName).toEqual(plan);
      expect(documents.compact.designSystem, templateName).toEqual(documents.balanced.designSystem);
      expect(documents.balanced.designSystem, templateName).toEqual(documents.visual.designSystem);

      for (const pair of comparison.pairs) {
        const [leftVariant, rightVariant] = pair.pair;
        const layoutDifferences = documents[leftVariant].slides.filter((slide, index) => (
          slide.purpose !== "title" && slide.templateLayoutId !== documents[rightVariant].slides[index]?.templateLayoutId
        ));
        expect(layoutDifferences.length, `${templateName}: ${leftVariant} vs ${rightVariant} must select a different non-title observed layout`).toBeGreaterThan(0);
        expect(pair.identicalStructuralFingerprints, `${templateName}: ${leftVariant} vs ${rightVariant} fingerprints`).toBe(false);
        expect(pair.nonTitleDifferingSlides.length, `${templateName}: ${leftVariant} vs ${rightVariant} non-title structural slides`).toBeGreaterThan(0);
      }
    }
  }, 30_000);
});
