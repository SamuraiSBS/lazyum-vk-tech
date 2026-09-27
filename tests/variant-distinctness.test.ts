import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema, type CanvasElement, type PresentationDocument } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import {
  comparePresentationVariants,
  fingerprintPresentationDocument,
} from "../src/lib/variant-distinctness";
import { createFixtureTemplate } from "./fixture-decks";

describe("variant structural distinctness", () => {
  it("recognizes identical documents as structurally identical", async () => {
    const document = await createDocument();
    const fingerprint = fingerprintPresentationDocument(document);

    expect(fingerprintPresentationDocument({ ...document, variant: "visual" })).toEqual(fingerprint);
  });

  it("does not treat text-only changes as layout changes", async () => {
    const document = await createDocument();
    const changedText = clone(document);
    const text = changedText.slides[1]?.canvas.elements.find((element) => element.type === "text");
    if (!text || text.type !== "text") throw new Error("Test document requires a text element");
    text.text = "Completely different wording must not alter the layout fingerprint.";

    expect(fingerprintPresentationDocument(changedText)).toEqual(fingerprintPresentationDocument(document));
  });

  it("detects geometry, element-type and layout changes", async () => {
    const document = await createDocument();
    const changed = clone(document);
    const slide = changed.slides[1];
    const element = slide?.canvas.elements[0];
    if (!slide || !element) throw new Error("Test document requires a second-slide element");
    element.x += 20;
    slide.templateLayoutId = "different-layout";
    element.type = "shape";
    if (element.type === "shape") {
      Object.assign(element, { shape: "rect", fill: "#FFFFFF", stroke: "#000000", strokeWidth: 0, radius: 0 });
      delete (element as { text?: string }).text;
      delete (element as { fontFamily?: string }).fontFamily;
      delete (element as { fontSize?: number }).fontSize;
      delete (element as { fontWeight?: number }).fontWeight;
      delete (element as { color?: string }).color;
      delete (element as { align?: string }).align;
    }

    expect(fingerprintPresentationDocument(changed).digest).not.toBe(fingerprintPresentationDocument(document).digest);
  });

  it("fingerprints a pie chart by chart type and ordered semantic data", async () => {
    const document = await createDocument();
    const withPie = clone(document);
    const slide = withPie.slides[1]!;
    const pie: Extract<CanvasElement, { type: "chart" }> = {
      id: "variant-pie-chart",
      type: "chart",
      chartType: "pie",
      x: 40,
      y: 60,
      w: 360,
      h: 240,
      title: "Share",
      categories: [
        { factId: "fact-a", sourceChunkId: "chunk-a", value: "Alpha" },
        { factId: "fact-b", sourceChunkId: "chunk-b", value: "Beta" },
      ],
      series: {
        id: "share",
        label: { factId: "fact-series", sourceChunkId: "chunk-series", value: "Share" },
        values: [
          { factId: "fact-value-a", sourceChunkId: "chunk-value-a", value: 3 },
          { factId: "fact-value-b", sourceChunkId: "chunk-value-b", value: 7 },
        ],
      },
      sourceRefs: {
        factIds: ["fact-a", "fact-b", "fact-series", "fact-value-a", "fact-value-b"],
        sourceChunkIds: ["chunk-a", "chunk-b", "chunk-series", "chunk-value-a", "chunk-value-b"],
      },
      zIndex: 20,
      locked: false,
    };
    slide.canvas.elements.push(pie);
    const parsed = presentationDocumentSchema.parse(withPie);
    const fingerprint = fingerprintPresentationDocument(parsed);
    const pieFingerprint = fingerprint.slides[1]!.elements.find((element) => element.type === "chart");
    expect(pieFingerprint?.type).toBe("chart");
    expect(pieFingerprint?.chart).toEqual({
      chartType: "pie",
      categories: ["Alpha", "Beta"],
      seriesLabel: "Share",
      values: [3, 7],
    });

    const changedData = clone(parsed);
    const changedChart = changedData.slides[1]!.canvas.elements.find((element) => element.type === "chart");
    if (!changedChart || changedChart.type !== "chart") throw new Error("Expected pie chart element");
    changedChart.series.values[1]!.value = 8;
    expect(fingerprintPresentationDocument(changedData).digest).not.toBe(fingerprint.digest);
  });

  it("keeps one deterministic plan and design system for all three variants", async () => {
    const document = await createDocument();
    const variants = (["compact", "balanced", "visual"] as const).map((variant) => presentationDocumentSchema.parse({
      ...renderPresentation(document.designSystem, document.plan, variant),
      variant,
    }));
    const report = comparePresentationVariants({
      compact: variants[0]!,
      balanced: variants[1]!,
      visual: variants[2]!,
    });

    expect(report.pairs.every((pair) => pair.samePlan)).toBe(true);
    expect(report.pairs.every((pair) => pair.sameDesignSystem)).toBe(true);
    expect(report.pairs.every((pair) => pair.sameSlideCount)).toBe(true);
    expect(report.pairs).toHaveLength(3);
  });
});

async function createDocument(): Promise<PresentationDocument> {
  const content = await normalizeContent("Воспроизводимое сравнение трёх вариантов", [{
    name: "distinctness.txt",
    type: "text/plain",
    buffer: Buffer.from("Один общий детерминированный план. Геометрия, типы элементов и визуальная композиция должны быть проверяемыми."),
  }]);
  const plan = await createPresentationPlan(content, 10);
  const designSystem = await parsePptxTemplate(await createFixtureTemplate("photo"), "distinctness-photo.pptx");
  return presentationDocumentSchema.parse({
    ...renderPresentation(designSystem, plan, "balanced"),
    variant: "balanced",
  });
}

function clone(document: PresentationDocument): PresentationDocument {
  return presentationDocumentSchema.parse(JSON.parse(JSON.stringify(document)));
}
