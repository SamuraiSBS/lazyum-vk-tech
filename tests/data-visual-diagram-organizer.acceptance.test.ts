import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { auditPresentation } from "../src/lib/audit";
import { createPresentationPptx } from "../src/lib/pptx-export";
import {
  auditReportSchema,
  designSystemSchema,
  presentationDocumentSchema,
  type NormalizedContent,
  type PresentationDocument,
  type PresentationPlan,
} from "../src/lib/schemas";
import {
  createDataVisualSpec,
  dataVisualSpecSchema,
  type DataVisualDraft,
  type DataVisualSpec,
} from "../src/lib/skills/data-visual-spec";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";

const runOrganizerAcceptance = process.env.VK_HACKATHON_DIAGRAM_ORGANIZER_ACCEPTANCE === "1";
const describeOrganizerAcceptance = runOrganizerAcceptance ? describe : describe.skip;

describeOrganizerAcceptance("organizer template fact-backed diagram acceptance", () => {
  it("parses, renders, audits and exports editable diagram objects for the local organizer PPTX", async () => {
    const templatePath = path.resolve(process.cwd(), "fixtures/templates/organizer/VK Tech шаблон.pptx");
    const templateBytes = await readFile(templatePath);
    const templateHashBefore = sha256(templateBytes);
    const design = designSystemSchema.parse(await parsePptxTemplate(templateBytes, path.basename(templatePath)));
    const { content, plan, draftBase } = makeGroundedFixture();

    const baseDocument = presentationDocumentSchema.parse(renderPresentation(design, plan));
    const target = findReplaceableBodySlot(baseDocument);
    if (!target) throw new Error("The parsed organizer template produced no renderer-owned body slot large enough for a diagram");

    const targetPlanSlide = plan.slides.find((slide) => slide.id === target.slideId);
    if (!targetPlanSlide) throw new Error("Selected diagram slide is missing from the fixture plan");
    const draft: DataVisualDraft = {
      ...draftBase,
      slideId: targetPlanSlide.id,
      title: targetPlanSlide.title,
    };
    const spec = dataVisualSpecSchema.parse(createDataVisualSpec(content, plan, draft));
    if (spec.visualType !== "diagram") throw new Error("Expected a validated fact-backed diagram");

    const renderedWithDiagram = presentationDocumentSchema.parse(renderPresentation(
      design,
      plan,
      "balanced",
      [{ spec, slot: target.slot }],
    ));
    // The native diagram takes ownership of the generic body-text area chosen
    // above, so remove the superseded filler text before auditing and export.
    const document = presentationDocumentSchema.parse({
      ...renderedWithDiagram,
      slides: renderedWithDiagram.slides.map((slide) => slide.id !== target.slideId ? slide : {
        ...slide,
        canvas: {
          ...slide.canvas,
          elements: slide.canvas.elements.filter((element) => element.id !== target.replacedTextId),
        },
      }),
    });
    const audit = auditReportSchema.parse(auditPresentation(document));
    expect(audit.passed, JSON.stringify(audit.slides.filter((slide) => slide.issues.some((issue) => issue.severity === "error")))).toBe(true);
    expect(audit.slides.flatMap((slide) => slide.issues)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
    );

    const diagramElements = elementsInSlot(document, target.slot.id);
    expect(diagramElements.filter((element) => element.type === "shape" && element.shape !== "line")).toHaveLength(3);
    expect(diagramElements.filter((element) => element.type === "shape" && element.shape === "line").length).toBeGreaterThan(0);
    expect(diagramElements.filter((element) => element.type === "text").length).toBeGreaterThanOrEqual(4);

    const comparisonBase = presentationDocumentSchema.parse({
      ...baseDocument,
      slides: baseDocument.slides.map((slide) => slide.id !== target.slideId ? slide : {
        ...slide,
        canvas: {
          ...slide.canvas,
          elements: slide.canvas.elements.filter((element) => element.id !== target.replacedTextId),
        },
      }),
    });
    const basePptx = await createPresentationPptx(comparisonBase);
    const diagramPptx = await createPresentationPptx(document);
    const baseArchive = await JSZip.loadAsync(basePptx);
    const diagramArchive = await JSZip.loadAsync(diagramPptx);
    const renderedTarget = document.slides.find((slide) => slide.id === target.slideId);
    if (!renderedTarget) throw new Error("Rendered diagram slide is missing");
    const slidePath = `ppt/slides/slide${renderedTarget.order}.xml`;
    const baseXml = await baseArchive.file(slidePath)?.async("string");
    const diagramXml = await diagramArchive.file(slidePath)?.async("string");
    if (!baseXml || !diagramXml) throw new Error(`Missing exported slide XML: ${slidePath}`);
    const baseObjects = countEditableObjects(baseXml);
    const diagramObjects = countEditableObjects(diagramXml);
    expect(diagramObjects.shapes - baseObjects.shapes).toBe(diagramElements.length);
    expect(diagramObjects.lineShapes - baseObjects.lineShapes).toBe(
      diagramElements.filter((element) => element.type === "shape" && element.shape === "line").length,
    );
    expect(diagramObjects.pictures - baseObjects.pictures).toBe(0);
    expect(diagramObjects.graphicFrames - baseObjects.graphicFrames).toBe(0);
    expect(diagramArchive.file(/^ppt\/media\//u).length).toBe(baseArchive.file(/^ppt\/media\//u).length);

    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-organizer-diagram-"));
    expect(isWithin(path.resolve(process.cwd()), tempDirectory)).toBe(false);
    const outputPath = path.join(tempDirectory, "organizer-fact-backed-diagram.pptx");
    await writeFile(outputPath, diagramPptx);
    const templateHashAfter = sha256(await readFile(templatePath));
    expect(templateHashAfter).toBe(templateHashBefore);

    console.info("ORGANIZER_DIAGRAM_ACCEPTANCE=" + JSON.stringify({
      outputPath,
      templateHashBefore,
      templateHashAfter,
      slideId: target.slideId,
      slideNumber: renderedTarget.order,
      replacedTextId: target.replacedTextId,
      slot: target.slot,
      diagramElementCounts: {
        shapes: diagramElements.filter((element) => element.type === "shape").length,
        text: diagramElements.filter((element) => element.type === "text").length,
        total: diagramElements.length,
      },
      exportedSlideObjects: {
        baseline: baseObjects,
        withDiagram: diagramObjects,
        addedDiagramObjects: diagramObjects.shapes - baseObjects.shapes,
      },
      auditPassed: audit.passed,
      auditIssueCounts: audit.slides.flatMap((slide) => slide.issues)
        .reduce((counts, issue) => ({ ...counts, [issue.severity]: counts[issue.severity] + 1 }), { info: 0, warning: 0, error: 0 }),
    }));
  }, 120_000);
});

function makeGroundedFixture() {
  const labels = [
    { id: "input", value: "Вход" },
    { id: "result", value: "Результат" },
    { id: "edge-input-result", value: "поток данных" },
  ];
  const sourceChunks: NormalizedContent["sourceChunks"] = [];
  const facts: NonNullable<NormalizedContent["facts"]> = [];
  const references = labels.map((label, index) => {
    const row = index + 1;
    const chunkId = `diagram-chunk-${label.id}`;
    const factId = `diagram-fact-${label.id}`;
    const locator = `row:${row},column:1`;
    sourceChunks.push({
      sourceId: "local-diagram-fixture",
      chunkId,
      sourceName: "organizer-diagram-fixture.csv",
      mimeType: "text/csv",
      text: label.value,
      locator,
      precision: "exact",
    });
    facts.push({
      kind: "spreadsheet-cell",
      factId,
      sourceId: "local-diagram-fixture",
      chunkId,
      format: "csv",
      valueType: "string",
      value: label.value,
      coordinate: { row, column: 1 },
      locator,
    });
    return { ...label, factId, sourceChunkId: chunkId };
  });
  const factIds = references.map((reference) => reference.factId);
  const sourceChunkIds = references.map((reference) => reference.sourceChunkId);
  const content: NormalizedContent = {
    brief: "A local spreadsheet fixture for a fact-backed process diagram.",
    documents: [],
    excerpts: [],
    keywords: [],
    sourceChunks,
    facts,
  };
  const purposes = ["metrics", "title", "problem", "solution", "summary"] as const;
  const planSlides: PresentationPlan["slides"] = purposes.map((purpose, index) => ({
    id: `diagram-slide-${index + 1}`,
    purpose,
    title: `Fact-backed process ${index + 1}`,
    content: ["Labels are sourced from exact local CSV cells."],
    visualIntent: index === 0 ? "diagram" : "none",
    claims: [{
      id: "diagram-grounded-claim",
      text: "Diagram labels match the local spreadsheet facts.",
      grounding: "grounded",
      precision: "exact",
      sourceRefs: { sourceChunkIds, factIds },
    }],
  }));
  const plan: PresentationPlan = {
    title: "Organizer template diagram acceptance",
    planner: "deterministic",
    slides: planSlides,
  };
  const draftBase: DataVisualDraft = {
    version: "v1",
    visualType: "diagram",
    slideId: planSlides[0]!.id,
    claimIds: ["diagram-grounded-claim"],
    title: planSlides[0]!.title,
    nodes: references.slice(0, 2).map((reference, index) => ({
      id: ["input", "result"][index]!,
      label: {
        factId: reference.factId,
        sourceChunkId: reference.sourceChunkId,
        value: reference.value,
      },
    })),
    edges: [{
      fromId: "input",
      toId: "result",
      label: { factId: references[2]!.factId, sourceChunkId: references[2]!.sourceChunkId, value: references[2]!.value },
    }],
  };
  return { content, plan, draftBase };
}

function findReplaceableBodySlot(document: PresentationDocument) {
  const candidates: Array<{
    slideId: string;
    replacedTextId: string;
    slot: { id: string; x: number; y: number; w: number; h: number; zIndex: number };
  }> = [];
  for (const slide of document.slides) {
    const bodyText = slide.canvas.elements.find((element) => element.type === "text" && element.id === `${slide.id}-text-1`);
    if (!bodyText || bodyText.w < 140 || bodyText.h < 120) continue;
    candidates.push({
      slideId: slide.id,
      replacedTextId: bodyText.id,
      slot: {
        id: "organizer-acceptance-diagram",
        x: bodyText.x,
        y: bodyText.y,
        w: bodyText.w,
        h: bodyText.h,
        zIndex: bodyText.zIndex,
      },
    });
  }
  return candidates.sort((left, right) => right.slot.w * right.slot.h - left.slot.w * left.slot.h)[0];
}

function elementsInSlot(document: PresentationDocument, slotId: string) {
  const slide = document.slides.find((candidate) => candidate.canvas.elements.some((element) => (
    element.id === slotId || element.id.startsWith(`${slotId}-`)
  )));
  if (!slide) throw new Error("Rendered diagram slot is missing");
  return slide.canvas.elements.filter((element) => element.id === slotId || element.id.startsWith(`${slotId}-`));
}

function countEditableObjects(xml: string) {
  return {
    shapes: matches(xml, /<p:sp(?=[\s>])/gu),
    connectors: matches(xml, /<p:cxnSp(?=[\s>])/gu),
    lineShapes: matches(xml, /<a:prstGeom prst="line"(?=[\s>])/gu),
    pictures: matches(xml, /<p:pic(?=[\s>])/gu),
    graphicFrames: matches(xml, /<p:graphicFrame(?=[\s>])/gu),
  };
}

function matches(value: string, expression: RegExp) {
  return [...value.matchAll(expression)].length;
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(parent: string, target: string) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
