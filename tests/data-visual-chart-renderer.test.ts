import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { auditPresentation } from "../src/lib/audit";
import { createStandaloneHtml } from "../src/lib/html-export";
import { createPresentationPptx } from "../src/lib/pptx-export";
import {
  DataVisualRendererError,
  materializeFactBackedChart,
  materializeFactBackedDiagram,
} from "../src/lib/data-visual-renderer";
import {
  createDataVisualSpec,
  type DataVisualDraft,
  type DataVisualSpec,
} from "../src/lib/skills/data-visual-spec";
import {
  presentationDocumentSchema,
  type NormalizedContent,
  type PresentationDocument,
  type PresentationPlan,
} from "../src/lib/schemas";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

describe("fact-backed native data-visual render path", () => {
  it("materializes a stable chart into semantic HTML and native PPTX", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
    const plan = chartPlan();
    const base = presentationDocumentSchema.parse(renderPresentation(design, plan));
    const slot = findFreeChartSlot(base, "metrics");
    const spec = createDataVisualSpec(chartContent, plan, chartDraft);
    if (spec.visualType !== "chart" || spec.chartType !== "bar") throw new Error("Expected a bar chart spec");

    const first = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const second = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const firstChart = chartElements(first, slot.id);
    const secondChart = chartElements(second, slot.id);

    expect(firstChart).toEqual(secondChart);
    expect(firstChart.some((element) => element.type === "shape")).toBe(true);
    expect(firstChart.some((element) => element.type === "text")).toBe(true);
    firstChart.forEach((element) => {
      expect(element.x).toBeGreaterThanOrEqual(slot.x);
      expect(element.y).toBeGreaterThanOrEqual(slot.y);
      expect(element.x + element.w).toBeLessThanOrEqual(slot.x + slot.w);
      expect(element.y + element.h).toBeLessThanOrEqual(slot.y + slot.h);
      expect(element.x).toBeGreaterThanOrEqual(0);
      expect(element.y).toBeGreaterThanOrEqual(0);
      expect(element.x + element.w).toBeLessThanOrEqual(first.slides[0]!.canvas.width);
      expect(element.y + element.h).toBeLessThanOrEqual(first.slides[0]!.canvas.height);
    });

    const audit = auditPresentation(first);
    const issues = audit.slides.flatMap((slide) => slide.issues);
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "OUTSIDE_SLIDE" }),
    ]));
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error" }),
    ]));

    const html = createStandaloneHtml(first);
    ["Q1", "Q2", "Завершили", "42", "57"].forEach((value) => expect(html).toContain(value));
    expect(html).toContain('data-element-type="shape"');
    expect(html).toContain('data-element-type="text"');

    const archive = await JSZip.loadAsync(await createPresentationPptx(first));
    const slideXml = await archive.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toContain("<p:sp>");
    ["Q1", "Q2", "Завершили", "42", "57"].forEach((value) => expect(slideXml).toContain(value));
    expect(archive.file(/^ppt\/media\//u)).toHaveLength(0);
  });

  it("materializes a deterministic native line chart with semantic points", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
    const plan = chartPlan();
    const base = presentationDocumentSchema.parse(renderPresentation(design, plan));
    const slot = { ...findFreeChartSlot(base, "metrics"), id: "fact-backed-line-chart" };
    const spec = { ...chartSpec(), chartType: "line" as const };

    const first = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const second = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const firstChart = chartElements(first, slot.id);
    const secondChart = chartElements(second, slot.id);

    expect(firstChart).toEqual(secondChart);
    expect(firstChart.some((element) => element.type === "shape" && element.shape === "line")).toBe(true);
    expect(firstChart.some((element) => element.type === "shape" && element.shape === "ellipse")).toBe(true);
    assertContained(firstChart, slot, first.slides[0]!.canvas.width, first.slides[0]!.canvas.height);

    const audit = auditPresentation(first);
    expect(audit.slides.flatMap((slide) => slide.issues)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error" }),
    ]));

    const html = createStandaloneHtml(first);
    ["Q1", "Q2", "Завершили", "42", "57"].forEach((value) => expect(html).toContain(value));
    expect(html).toContain('data-element-type="shape"');

    const archive = await JSZip.loadAsync(await createPresentationPptx(first));
    const slideXml = await archive.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toContain("<p:sp>");
    ["Q1", "Q2", "Завершили", "42", "57"].forEach((value) => expect(slideXml).toContain(value));
    expect(archive.file(/^ppt\/media\//u)).toHaveLength(0);
  });

  it("materializes a deterministic fact-backed pie as accessible HTML and one editable native PPTX chart", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
    const plan = chartPlan();
    const base = presentationDocumentSchema.parse(renderPresentation(design, plan));
    const slot = { ...findFreeChartSlot(base, "metrics"), id: "fact-backed-pie-chart" };
    const spec = pieChartSpec();
    const first = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const second = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const firstChart = chartElements(first, slot.id);
    const chart = firstChart[0];

    expect(firstChart).toEqual(chartElements(second, slot.id));
    expect(firstChart).toHaveLength(1);
    expect(chart?.type).toBe("chart");
    if (chart?.type !== "chart") throw new Error("Expected one semantic pie chart canvas element");
    expect(chart.chartType).toBe("pie");
    expect(chart.categories.map((category) => category.value)).toEqual(spec.categories.map((category) => category.value));
    expect(chart.series.values.map((datum) => datum.value)).toEqual([42, 57, 0]);
    expect(chart.sourceRefs).toEqual(spec.sourceRefs);
    assertContained(firstChart, slot, first.slides[0]!.canvas.width, first.slides[0]!.canvas.height);

    const slideElements = first.slides[0]!.canvas.elements;
    const ids = slideElements.map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(slideElements.length).toBeLessThanOrEqual(200);
    expect(() => presentationDocumentSchema.parse(first)).not.toThrow();

    const audit = auditPresentation(first);
    expect(audit.slides.flatMap((slide) => slide.issues)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "OUTSIDE_SLIDE" }),
      expect.objectContaining({ severity: "error" }),
    ]));

    const html = createStandaloneHtml(first);
    expect(html).toContain('data-element-type="chart"');
    expect(html).toContain("<figure");
    expect(html).toContain("<svg viewBox=\"0 0 100 100\" role=\"img\"");
    expect(html).toContain("<table class=\"pie-chart-data\"");
    expect(html).toContain("data-category-index=\"0\"");
    expect(html).toContain("data-category-index=\"1\"");
    expect(html).not.toContain("data-category-index=\"2\"");
    const figureStart = html.indexOf('<figure class="element element-chart"');
    const figureEnd = html.indexOf("</figure>", figureStart);
    const pieFigure = html.slice(figureStart, figureEnd + "</figure>".length);
    expect(figureStart).toBeGreaterThan(-1);
    expect(pieFigure).not.toMatch(/<script\b|https?:\/\//iu);
    expect(pieFigure).not.toContain("<img");
    const firstRow = html.indexOf("<th scope=\"row\">Q1</th>");
    const secondRow = html.indexOf("<th scope=\"row\">Q2</th>");
    const zeroRow = html.indexOf("<td>0</td>", secondRow);
    const escapedThirdRow = html.indexOf("<th scope=\"row\">Q3 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;new&#39;</th>");
    expect(firstRow).toBeGreaterThan(-1);
    expect(firstRow).toBeLessThan(secondRow);
    expect(secondRow).toBeLessThan(escapedThirdRow);
    expect(zeroRow).toBeGreaterThan(secondRow);
    expect(html).not.toContain('<script>alert("x")</script>');

    const archive = await JSZip.loadAsync(await createPresentationPptx(first));
    const chartFiles = archive.file(/^ppt\/charts\/chart\d+\.xml$/u);
    expect(chartFiles).toHaveLength(1);
    const chartXml = await chartFiles[0]!.async("string");
    expect(chartXml).toContain("<c:pieChart>");
    ["Q1", "Q2", "Q3 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;new&apos;", "42", "57", "0"]
      .forEach((value) => expect(chartXml).toContain(value));
    const chartCategoryValues = chartXml.match(/<c:cat>[\s\S]*?<\/c:cat>/u)?.[0] ?? "";
    const chartNumericValues = chartXml.match(/<c:val>[\s\S]*?<\/c:val>/u)?.[0] ?? "";
    expect(chartCategoryValues.indexOf("Q1")).toBeLessThan(chartCategoryValues.indexOf("Q2"));
    expect(chartCategoryValues.indexOf("Q2")).toBeLessThan(chartCategoryValues.indexOf("Q3 &lt;script&gt;"));
    expect(chartNumericValues.indexOf("42")).toBeLessThan(chartNumericValues.indexOf("57"));
    expect(chartNumericValues.indexOf("57")).toBeLessThan(chartNumericValues.indexOf("<c:v>0</c:v>"));

    const slideXml = await archive.file("ppt/slides/slide1.xml")?.async("string");
    const slideRelationships = await archive.file("ppt/slides/_rels/slide1.xml.rels")?.async("string");
    expect(slideRelationships).toMatch(/Type="[^"]*\/chart"/u);
    const chartRelationshipId = slideRelationships?.match(/<Relationship[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/chart"/u)?.[1];
    expect(chartRelationshipId).toBeTruthy();
    expect(slideXml).toContain("<p:graphicFrame>");
    expect(slideXml).toContain(`r:id="${chartRelationshipId}"`);
    expect(archive.file(/^ppt\/media\//u)).toHaveLength(0);

    const chartFileName = chartFiles[0]!.name;
    const chartRelationships = await archive.file(`ppt/charts/_rels/${chartFileName.split("/").at(-1)!.replace(".xml", ".xml.rels")}`)?.async("string");
    const workbookRelationship = chartRelationships?.match(/<Relationship[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/package"[^>]*Target="([^"]+)"/u);
    expect(workbookRelationship).toBeTruthy();
    expect(chartXml).toContain(`<c:externalData r:id="${workbookRelationship?.[1]}"`);
    const workbookPath = `ppt/${workbookRelationship?.[2]?.replace(/^\.\.\//u, "")}`;
    const workbookFile = archive.file(workbookPath);
    expect(workbookFile).toBeTruthy();
    const workbook = await JSZip.loadAsync(await workbookFile!.async("nodebuffer"));
    const worksheetXml = await workbook.file("xl/worksheets/sheet1.xml")?.async("string");
    expect(worksheetXml).toContain('<c r="B2"><v>42</v></c>');
    expect(worksheetXml).toContain('<c r="B3"><v>57</v></c>');
    expect(worksheetXml).toContain('<c r="B4"><v>0</v></c>');
  });

  it("creates and persists a 100-category pie with 201 separately grounded fact refs", async () => {
    const categories = Array.from({ length: 100 }, (_, index) => {
      const row = index + 1;
      return {
        factId: `pie-category-fact-${index + 1}`,
        sourceChunkId: `pie-category-chunk-${index + 1}`,
        locator: `row:${row},column:1`,
        value: `Category ${String(index + 1).padStart(3, "0")}`,
      };
    });
    const values = Array.from({ length: 100 }, (_, index) => {
      const row = index + 101;
      return {
        factId: `pie-value-fact-${index + 1}`,
        sourceChunkId: `pie-value-chunk-${index + 1}`,
        locator: `row:${row},column:2`,
        value: index + 1,
      };
    });
    const seriesLabel = {
      factId: "pie-series-label-fact",
      sourceChunkId: "pie-series-label-chunk",
      locator: "row:201,column:3",
      value: "Participants",
    };
    const groundedRefs = [...categories, ...values, seriesLabel];
    const content: NormalizedContent = {
      ...chartContent,
      sourceChunks: groundedRefs.map((datum) => chunk(datum.sourceChunkId, String(datum.value), datum.locator)),
      facts: [
        ...categories.map((datum) => categoricalFact(datum.factId, datum.sourceChunkId, datum.value, datum.locator)),
        ...values.map((datum) => numericFact(datum.factId, datum.sourceChunkId, datum.value, datum.locator)),
        categoricalFact(seriesLabel.factId, seriesLabel.sourceChunkId, seriesLabel.value, seriesLabel.locator),
      ],
    };
    const claims = Array.from({ length: Math.ceil(groundedRefs.length / 41) }, (_, index) => {
      const refs = groundedRefs.slice(index * 41, (index + 1) * 41);
      return {
        id: `pie-grounded-${index + 1}`,
        text: `Grounded pie data group ${index + 1}`,
        grounding: "grounded" as const,
        precision: "exact" as const,
        sourceRefs: {
          sourceChunkIds: refs.map((datum) => datum.sourceChunkId),
          factIds: refs.map((datum) => datum.factId),
        },
      };
    });
    const basePlan = chartPlan();
    const plan: PresentationPlan = {
      ...basePlan,
      slides: basePlan.slides.map((slide) => slide.id === "metrics" ? { ...slide, claims } : slide),
    };
    const draft: Extract<DataVisualDraft, { visualType: "chart" }> = {
      version: "v1",
      visualType: "chart",
      chartType: "pie",
      slideId: "metrics",
      claimIds: claims.map((claim) => claim.id),
      title: "Динамика пилота",
      categories: categories.map(({ factId, sourceChunkId, value }) => ({ factId, sourceChunkId, value })),
      series: [{
        id: "participants",
        label: {
          factId: seriesLabel.factId,
          sourceChunkId: seriesLabel.sourceChunkId,
          value: seriesLabel.value,
        },
        values: values.map(({ factId, sourceChunkId, value }) => ({ factId, sourceChunkId, value })),
      }],
    };
    const spec = createDataVisualSpec(content, plan, draft);
    if (spec.visualType !== "chart" || spec.chartType !== "pie") throw new Error("Expected a fact-backed pie spec");

    expect(spec.categories).toHaveLength(100);
    expect(spec.series).toHaveLength(1);
    expect(spec.series[0]?.values.map((datum) => datum.value)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(spec.sourceRefs.factIds).toHaveLength(201);
    expect(new Set(spec.sourceRefs.factIds).size).toBe(201);
    expect(spec.sourceRefs.sourceChunkIds).toHaveLength(201);
    expect(new Set(spec.sourceRefs.sourceChunkIds).size).toBe(201);

    const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
    const base = presentationDocumentSchema.parse(renderPresentation(design, plan));
    const slot = { ...findFreeChartSlot(base, "metrics"), id: "fact-backed-100-category-pie" };
    const document = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const chart = document.slides[0]!.canvas.elements.find((element) => element.id === slot.id);

    expect(chart?.type).toBe("chart");
    if (chart?.type !== "chart") throw new Error("Expected persisted semantic pie chart");
    expect(chart.chartType).toBe("pie");
    expect(chart.categories).toHaveLength(100);
    expect(chart.categories.map((datum) => datum.value)).toEqual(categories.map((datum) => datum.value));
    expect(chart.series.values).toHaveLength(100);
    expect(chart.series.values.map((datum) => datum.value)).toEqual(values.map((datum) => datum.value));
    expect(chart.sourceRefs.factIds).toHaveLength(201);
    expect(chart.sourceRefs.sourceChunkIds).toHaveLength(201);
  });

  it("fails closed for diagram, unsupported chart capacity, and unsupported visual type", () => {
    const slot = { id: "chart-slot", x: 20, y: 20, w: 600, h: 300, zIndex: 90 };
    expect(() => materializeFactBackedChart(diagramSpec(), slot))
      .toThrowError(new DataVisualRendererError("unsupported_visual_type"));
    expect(() => materializeFactBackedChart({ ...chartSpec(), chartType: "line" }, {
      ...slot,
      w: 40,
      h: 30,
    })).toThrowError(new DataVisualRendererError("unsupported_chart_capacity"));
  });

  it("materializes a deterministic native diagram with contained semantic nodes and edges", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
    const plan = chartPlan();
    const base = presentationDocumentSchema.parse(renderPresentation(design, plan));
    const slot = { ...findFreeChartSlot(base, "metrics"), id: "fact-backed-diagram" };
    const spec = diagramSpec();

    const first = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const second = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const firstDiagram = chartElements(first, slot.id);
    const secondDiagram = chartElements(second, slot.id);

    expect(firstDiagram).toEqual(secondDiagram);
    expect(firstDiagram.some((element) => element.type === "shape" && element.shape === "roundRect")).toBe(true);
    expect(firstDiagram.some((element) => element.type === "shape" && element.shape === "line")).toBe(true);
    expect(firstDiagram.map((element) => element.id)).toEqual(expect.arrayContaining([
      "fact-backed-diagram-node-0-q1-label",
      "fact-backed-diagram-node-1-q2-label",
      "fact-backed-diagram-edge-0-q1-q2-line",
      "fact-backed-diagram-edge-0-q1-q2-label",
    ]));
    const q1 = firstDiagram.find((element) => element.id === "fact-backed-diagram-node-0-q1-shape");
    const q2 = firstDiagram.find((element) => element.id === "fact-backed-diagram-node-1-q2-shape");
    const q1q2 = firstDiagram.find((element) => element.id === "fact-backed-diagram-edge-0-q1-q2-line");
    expect(q1?.type).toBe("shape");
    expect(q2?.type).toBe("shape");
    expect(q1q2?.type).toBe("shape");
    if (q1?.type !== "shape" || q2?.type !== "shape" || q1q2?.type !== "shape") throw new Error("Expected native diagram shapes");
    expect(q1q2.x).toBeCloseTo(q1.x + q1.w / 2);
    expect(q1q2.y).toBeCloseTo(q1.y + q1.h / 2);
    expect(q1q2.x + q1q2.w).toBeCloseTo(q2.x + q2.w / 2);
    expect(q1q2.y).toBeCloseTo(q2.y + q2.h / 2);
    expect(firstDiagram.filter((element) => element.type === "text").map((element) => element.text).join(" "))
      .toContain("Завершили");
    assertContained(firstDiagram, slot, first.slides[0]!.canvas.width, first.slides[0]!.canvas.height);

    const audit = auditPresentation(first);
    const issues = audit.slides.flatMap((slide) => slide.issues);
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "OUTSIDE_SLIDE" }),
    ]));
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error" }),
    ]));

    const html = createStandaloneHtml(first);
    ["Динамика пилота", "Q1", "Q2", "Завершили"].forEach((value) => expect(html).toContain(value));
    expect(html).toContain('data-element-type="shape"');
    expect(html).toContain('data-element-type="text"');

    const archive = await JSZip.loadAsync(await createPresentationPptx(first));
    const slideXml = await archive.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toContain("<p:sp>");
    ["Динамика пилота", "Q1", "Q2", "Завершили"].forEach((value) => expect(slideXml).toContain(value));
    expect(archive.file(/^ppt\/media\//u)).toHaveLength(0);
  });

  it("routes a non-horizontal edge through deterministic orthogonal native segments", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
    const plan = chartPlan();
    const base = presentationDocumentSchema.parse(renderPresentation(design, plan));
    const slot = { ...findFreeChartSlot(base, "metrics"), id: "fact-backed-diagonal-diagram" };
    const spec = diagramSpecWithDiagonalEdge();

    const document = presentationDocumentSchema.parse(renderPresentation(design, plan, "balanced", [{ spec, slot }]));
    const routedLines = document.slides[0]!.canvas.elements.filter((element) =>
      element.type === "shape" && element.id.startsWith(`${slot.id}-edge-1-q1-q4-line`));

    expect(routedLines).toHaveLength(3);
    expect(routedLines.every((element) => element.type === "shape"
      && (element.w === 1 || element.h === 1))).toBe(true);
    expect(routedLines.some((element) => element.type === "shape" && element.w > 1 && element.h === 1)).toBe(true);
    expect(routedLines.some((element) => element.type === "shape" && element.w === 1 && element.h > 1)).toBe(true);
    expect(routedLines.map((element) => element.id)).toEqual([
      "fact-backed-diagonal-diagram-edge-1-q1-q4-line",
      "fact-backed-diagonal-diagram-edge-1-q1-q4-line-1",
      "fact-backed-diagonal-diagram-edge-1-q1-q4-line-2",
    ]);
    const q1 = document.slides[0]!.canvas.elements.find((element) => element.id === "fact-backed-diagonal-diagram-node-0-q1-shape");
    const q4 = document.slides[0]!.canvas.elements.find((element) => element.id === "fact-backed-diagonal-diagram-node-3-q4-shape");
    expect(q1?.type).toBe("shape");
    expect(q4?.type).toBe("shape");
    if (q1?.type !== "shape" || q4?.type !== "shape") throw new Error("Expected native diagram nodes");
    const firstLine = routedLines[0];
    const lastLine = routedLines[2];
    expect(firstLine?.type).toBe("shape");
    expect(lastLine?.type).toBe("shape");
    if (firstLine?.type !== "shape" || lastLine?.type !== "shape") throw new Error("Expected native diagram routes");
    expect(firstLine.x).toBeCloseTo(q1.x + q1.w / 2);
    expect(firstLine.y).toBeCloseTo(q1.y + q1.h / 2);
    expect(lastLine.x).toBeCloseTo(q4.x + q4.w / 2);
    expect(lastLine.y + lastLine.h).toBeCloseTo(q4.y + q4.h / 2);
    assertContained(routedLines, slot, document.slides[0]!.canvas.width, document.slides[0]!.canvas.height);
  });

  it("fails closed for diagram capacity and invalid slots", () => {
    const spec = diagramSpec();
    const tooManyNodes = {
      ...spec,
      nodes: [
        ...spec.nodes,
        ...Array.from({ length: 11 }, (_, index) => ({
          id: `extra-${index}`,
          label: spec.nodes[0]!.label,
        })),
      ],
    };
    expect(() => materializeFactBackedDiagram(tooManyNodes, {
      id: "diagram-slot",
      x: 20,
      y: 20,
      w: 600,
      h: 300,
      zIndex: 90,
    })).toThrowError(new DataVisualRendererError("unsupported_diagram_capacity"));
    expect(() => materializeFactBackedDiagram(spec, {
      id: "diagram-slot",
      x: Number.NaN,
      y: 20,
      w: 600,
      h: 300,
      zIndex: 90,
    })).toThrowError(new DataVisualRendererError("invalid_layout_slot"));
  });
});

const chartContent: NormalizedContent = {
  brief: "Пилотная метрика",
  documents: [],
  excerpts: [],
  keywords: [],
  sourceChunks: [
    chunk("chunk-q1", "Q1", "row:2,column:1"),
    chunk("chunk-q2", "Q2", "row:3,column:1"),
    chunk("chunk-q3", 'Q3 <script>alert("x")</script> & \'new\'', "row:4,column:1"),
    chunk("chunk-completed", "Завершили", "row:1,column:2"),
    chunk("chunk-value-q1", "42", "row:2,column:2"),
    chunk("chunk-value-q2", "57", "row:3,column:2"),
    chunk("chunk-value-q3", "0", "row:4,column:2"),
  ],
  facts: [
    categoricalFact("fact-q1", "chunk-q1", "Q1", "row:2,column:1"),
    categoricalFact("fact-q2", "chunk-q2", "Q2", "row:3,column:1"),
    categoricalFact("fact-q3", "chunk-q3", 'Q3 <script>alert("x")</script> & \'new\'', "row:4,column:1"),
    categoricalFact("fact-completed", "chunk-completed", "Завершили", "row:1,column:2"),
    numericFact("fact-value-q1", "chunk-value-q1", 42, "row:2,column:2"),
    numericFact("fact-value-q2", "chunk-value-q2", 57, "row:3,column:2"),
    numericFact("fact-value-q3", "chunk-value-q3", 0, "row:4,column:2"),
  ],
};

const chartDraft: Extract<DataVisualDraft, { visualType: "chart" }> = {
  version: "v1",
  visualType: "chart",
  chartType: "bar",
  slideId: "metrics",
  claimIds: ["metrics-grounded"],
  title: "Динамика пилота",
  categories: [
    { factId: "fact-q1", sourceChunkId: "chunk-q1", value: "Q1" },
    { factId: "fact-q2", sourceChunkId: "chunk-q2", value: "Q2" },
  ],
  series: [{
    id: "completed",
    label: { factId: "fact-completed", sourceChunkId: "chunk-completed", value: "Завершили" },
    values: [
      { factId: "fact-value-q1", sourceChunkId: "chunk-value-q1", value: 42 },
      { factId: "fact-value-q2", sourceChunkId: "chunk-value-q2", value: 57 },
    ],
  }],
};

function chartSpec(): Extract<DataVisualSpec, { visualType: "chart" }> {
  const spec = createDataVisualSpec(chartContent, chartPlan(), chartDraft);
  if (spec.visualType !== "chart") throw new Error("Expected chart spec");
  return spec;
}

function pieChartSpec(): Extract<DataVisualSpec, { visualType: "chart" }> {
  const draft = {
    ...chartDraft,
    chartType: "pie" as const,
    categories: [
      ...chartDraft.categories,
      { factId: "fact-q3", sourceChunkId: "chunk-q3", value: 'Q3 <script>alert("x")</script> & \'new\'' },
    ],
    series: [{
      ...chartDraft.series[0]!,
      values: [
        ...chartDraft.series[0]!.values,
        { factId: "fact-value-q3", sourceChunkId: "chunk-value-q3", value: 0 },
      ],
    }],
  };
  const spec = createDataVisualSpec(chartContent, chartPlan(), draft);
  if (spec.visualType !== "chart" || spec.chartType !== "pie") throw new Error("Expected pie chart spec");
  return spec;
}

function diagramSpec() {
  const draft: Extract<DataVisualDraft, { visualType: "diagram" }> = {
    version: "v1",
    visualType: "diagram",
    slideId: "metrics",
    claimIds: ["metrics-grounded"],
    title: "Динамика пилота",
    nodes: [
      { id: "q1", label: { factId: "fact-q1", sourceChunkId: "chunk-q1", value: "Q1" } },
      { id: "q2", label: { factId: "fact-q2", sourceChunkId: "chunk-q2", value: "Q2" } },
    ],
    edges: [{
      fromId: "q1",
      toId: "q2",
      label: { factId: "fact-completed", sourceChunkId: "chunk-completed", value: "Завершили" },
    }],
  };
  const spec = createDataVisualSpec(chartContent, chartPlan(), draft);
  if (spec.visualType !== "diagram") throw new Error("Expected diagram spec");
  return spec;
}

function diagramSpecWithDiagonalEdge() {
  const spec = diagramSpec();
  return {
    ...spec,
    nodes: [
      ...spec.nodes,
      { id: "q3", label: spec.nodes[0]!.label },
      { id: "q4", label: spec.nodes[1]!.label },
    ],
    edges: [
      ...spec.edges,
      { fromId: "q1", toId: "q4", label: spec.edges[0]!.label },
    ],
  };
}

function chartPlan(): PresentationPlan {
  const factIds = chartContent.facts!.map((fact) => fact.factId);
  const sourceChunkIds = chartContent.sourceChunks.map((sourceChunk) => sourceChunk.chunkId);
  return {
    title: "Пилот",
    planner: "deterministic",
    slides: [
      {
        id: "metrics",
        purpose: "metrics",
        title: "Динамика пилота",
        content: ["Проверенные показатели"],
        visualIntent: "metrics",
        claims: [{
          id: "metrics-grounded",
          text: "Показатели пилота",
          grounding: "grounded",
          precision: "exact",
          sourceRefs: { sourceChunkIds, factIds },
        }],
      },
      ...["problem", "context", "solution", "summary"].map((purpose, index) => ({
        id: `slide-${index + 2}`,
        purpose: purpose as "problem" | "context" | "solution" | "summary",
        title: `Слайд ${index + 2}`,
        content: ["Контекст"],
        visualIntent: "none" as const,
        claims: [{
          id: `claim-${index + 2}`,
          text: "Контекст",
          grounding: "unsupported" as const,
          precision: "document" as const,
          sourceRefs: { sourceChunkIds: [], factIds: [] },
        }],
      })),
    ],
  };
}

function chartElements(document: PresentationDocument, slotId: string) {
  return document.slides[0]!.canvas.elements.filter((element) => element.id === slotId || element.id.startsWith(`${slotId}-`));
}

function assertContained(
  elements: PresentationDocument["slides"][number]["canvas"]["elements"],
  slot: { x: number; y: number; w: number; h: number },
  slideWidth: number,
  slideHeight: number,
) {
  elements.forEach((element) => {
    expect(element.x).toBeGreaterThanOrEqual(slot.x);
    expect(element.y).toBeGreaterThanOrEqual(slot.y);
    expect(element.x + element.w).toBeLessThanOrEqual(slot.x + slot.w);
    expect(element.y + element.h).toBeLessThanOrEqual(slot.y + slot.h);
    expect(element.x).toBeGreaterThanOrEqual(0);
    expect(element.y).toBeGreaterThanOrEqual(0);
    expect(element.x + element.w).toBeLessThanOrEqual(slideWidth);
    expect(element.y + element.h).toBeLessThanOrEqual(slideHeight);
  });
}

function findFreeChartSlot(document: PresentationDocument, slideId: string) {
  const slide = document.slides.find((candidate) => candidate.id === slideId);
  if (!slide) throw new Error("Expected metrics slide");
  // The fixture template places its title and body in the left column and
  // artwork in the upper-right corner. Use the remaining lower-right area
  // instead of assuming a wide empty region across the slide.
  const w = 340;
  const h = 320;
  for (let y = 0; y + h <= slide.canvas.height; y += 20) {
    for (let x = 0; x + w <= slide.canvas.width; x += 20) {
      const candidate = { x, y, w, h };
      if (!slide.canvas.elements.some((element) => element.type !== "shape" && overlaps(element, candidate))) {
        return { id: "fact-backed-bar-chart", zIndex: 90, ...candidate };
      }
    }
  }
  throw new Error("Could not find a non-overlapping chart slot");
}

function overlaps(element: { x: number; y: number; w: number; h: number }, box: { x: number; y: number; w: number; h: number }) {
  return element.x < box.x + box.w && element.x + element.w > box.x
    && element.y < box.y + box.h && element.y + element.h > box.y;
}

function chunk(chunkId: string, text: string, locator: string) {
  return {
    sourceId: "spreadsheet-1",
    chunkId,
    sourceName: "metrics.csv",
    mimeType: "text/csv",
    text,
    locator,
    precision: "exact" as const,
  };
}

function categoricalFact(factId: string, chunkId: string, value: string, locator: string) {
  return {
    kind: "spreadsheet-cell" as const,
    factId,
    sourceId: "spreadsheet-1",
    chunkId,
    format: "csv" as const,
    valueType: "string" as const,
    value,
    coordinate: coordinate(locator),
    locator,
  };
}

function numericFact(factId: string, chunkId: string, value: number, locator: string) {
  return {
    kind: "spreadsheet-cell" as const,
    factId,
    sourceId: "spreadsheet-1",
    chunkId,
    format: "csv" as const,
    valueType: "number" as const,
    value,
    coordinate: coordinate(locator),
    locator,
  };
}

function coordinate(locator: string) {
  return {
    row: Number(locator.match(/row:(\d+)/u)?.[1]),
    column: Number(locator.match(/column:(\d+)/u)?.[1]),
  };
}
