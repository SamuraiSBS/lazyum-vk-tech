import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/request-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/request-guards")>();
  const guard = actual.createProcessRequestGuard({ maxGenerationRequestsPerWindow: 100, maxExportRequestsPerWindow: 100 });
  return { ...actual, acquireHeavyOperation: (kind: "generation" | "export") => guard.acquireHeavyOperation(kind) };
});

vi.mock("../src/lib/planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/planner")>();
  return { ...actual, createPresentationPlan: async (...args: Parameters<typeof actual.createPresentationPlan>) => {
    const plan = await actual.createPresentationPlan(...args);
    const publishedFixture = args[0].brief.includes("grounded diagram published export fixture");
    const chartCoexistenceFixture = args[0].brief.includes("grounded diagram slot coexistence fixture");
    const tableCoexistenceFixture = args[0].brief.includes("grounded diagram table coexistence fixture");
    if (!publishedFixture && !chartCoexistenceFixture && !tableCoexistenceFixture) return plan;
    const content = args[0];
    const fixtureTitle = chartCoexistenceFixture
      ? "Process diagram and chart"
      : tableCoexistenceFixture ? "Process diagram and table" : "Process diagram";
    const fixtureContent = chartCoexistenceFixture
      ? "Show the explicit relationships and chart from separate source records"
      : tableCoexistenceFixture
        ? "Show the explicit relationships and table from separate source records"
        : "Show the explicit relationships in the source records";
    const claimText = tableCoexistenceFixture
      ? "The source records contain exact process relationships and tabular values"
      : chartCoexistenceFixture
        ? "The source records contain exact process relationships and chart values"
        : "The spreadsheet records each process relationship";
    return { ...plan, slides: plan.slides.map((slide, index) => index === 1 ? {
      ...slide,
      purpose: "workflow" as const,
      title: fixtureTitle,
      content: [fixtureContent],
      visualIntent: "diagram" as const,
      claims: [{
        id: "published-diagram-evidence",
        text: claimText,
        grounding: "grounded" as const,
        precision: "exact" as const,
        sourceRefs: {
          factIds: (content.facts ?? []).map((fact) => fact.factId),
          sourceChunkIds: content.sourceChunks.map((chunk) => chunk.chunkId),
        },
      }],
    } : slide) };
  } };
});

import { POST as generate } from "../src/app/api/generate/route";
import { POST as exportPptx } from "../src/app/api/export/route";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { presentationDocumentSchema, type LayoutVariant } from "../src/lib/schemas";
import { createFixtureTemplate } from "./fixture-decks";

const variants: LayoutVariant[] = ["compact", "balanced", "visual"];
let artifactRoot: string;
let previousArtifactRoot: string | undefined;
let previousProvider: string | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-grounded-diagram-published-export-"));
  previousArtifactRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
  previousProvider = process.env.VK_HACKATHON_LLM_PROVIDER;
  process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
  process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
});

afterAll(async () => {
  if (previousArtifactRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
  else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousArtifactRoot;
  if (previousProvider === undefined) delete process.env.VK_HACKATHON_LLM_PROVIDER;
  else process.env.VK_HACKATHON_LLM_PROVIDER = previousProvider;
  await rm(artifactRoot, { recursive: true, force: true });
});

function expectNoGeometryOverlap(
  occupied: Array<{ id: string; x: number; y: number; w: number; h: number }>,
  diagrams: Array<{ id: string; x: number; y: number; w: number; h: number }>,
  variant: LayoutVariant,
  occupiedKind: string,
) {
  for (const visual of occupied) {
    for (const diagram of diagrams) {
      const overlaps = visual.x < diagram.x + diagram.w && visual.x + visual.w > diagram.x
        && visual.y < diagram.y + diagram.h && visual.y + visual.h > diagram.y;
      expect(overlaps, `${variant}: diagram element ${diagram.id} overlaps ${occupiedKind} ${visual.id}`).toBe(false);
    }
  }
}

describe("ordinary grounded diagram through published job PPTX", () => {
  it("keeps a separate grounded chart when reserving a diagram slot", async () => {
    const form = new FormData();
    form.set("template", new File([new Uint8Array(await createFixtureTemplate("bright"))], "diagram-template.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.set("brief", "grounded diagram slot coexistence fixture");
    form.set("slideCount", "5");
    form.append("materials", new File([
      "source,target,relationship,comment\nAlpha,Beta,creates,Gamma\nBeta,Gamma,,Delta\n",
    ], "relations.csv", { type: "text/csv" }));
    form.append("materials", new File([
      "Period,Value\nQ1,10\nQ2,20\n",
    ], "metrics.csv", { type: "text/csv" }));

    const generation = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await generation.json() as { jobId: string; presentations: Record<LayoutVariant, unknown> };
    expect(generation.status, JSON.stringify(payload)).toBe(200);

    for (const variant of variants) {
      const document = presentationDocumentSchema.parse(payload.presentations[variant]);
      const slide = document.slides.find((candidate) => candidate.title === "Process diagram and chart");
      expect(slide, `${variant}: missing planned process/chart slide`).toBeDefined();
      const chartPrefix = `${slide!.id}-grounded-chart`;
      const diagramPrefix = `${slide!.id}-grounded-diagram`;
      const chartElements = slide!.canvas.elements.filter((element) => element.id.startsWith(chartPrefix));
      const diagramElements = slide!.canvas.elements.filter((element) => element.id.startsWith(diagramPrefix));
      expect(chartElements, `${variant}: distinct-evidence chart should be preserved`).not.toHaveLength(0);
      expect(diagramElements, `${variant}: grounded diagram must exist before overlap checks`).not.toHaveLength(0);
      expectNoGeometryOverlap(chartElements, diagramElements, variant, "chart");
    }
  }, 120_000);

  it("keeps a separate grounded table beside the diagram without overlap", async () => {
    const form = new FormData();
    form.set("template", new File([new Uint8Array(await createFixtureTemplate("bright"))], "diagram-template.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.set("brief", "grounded diagram table coexistence fixture");
    form.set("slideCount", "5");
    form.append("materials", new File([
      "Metric,Value\nUsers,10\nRevenue,20\n",
    ], "metrics.csv", { type: "text/csv" }));
    form.append("materials", new File([
      "source,target,relationship,comment\nAlpha,Beta,creates,Gamma\nBeta,Gamma,,Delta\n",
    ], "relations.csv", { type: "text/csv" }));

    const generation = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await generation.json() as { jobId: string; presentations: Record<LayoutVariant, unknown> };
    expect(generation.status, JSON.stringify(payload)).toBe(200);

    for (const variant of variants) {
      const document = presentationDocumentSchema.parse(payload.presentations[variant]);
      const slide = document.slides.find((candidate) => candidate.title === "Process diagram and table");
      expect(slide, `${variant}: missing planned process/table slide`).toBeDefined();
      const tablePrefix = `${slide!.id}-grounded-table`;
      const diagramPrefix = `${slide!.id}-grounded-diagram`;
      const tableElements = slide!.canvas.elements.filter((element) => element.id.startsWith(tablePrefix));
      const diagramElements = slide!.canvas.elements.filter((element) => element.id.startsWith(diagramPrefix));
      expect(tableElements, `${variant}: distinct-evidence grounded table should be preserved`).not.toHaveLength(0);
      expect(diagramElements, `${variant}: grounded diagram must exist before overlap checks`).not.toHaveLength(0);
      expectNoGeometryOverlap(tableElements, diagramElements, variant, "table");
    }
  }, 120_000);

  it("exports editable source-record relationships for all three variants", async () => {
    const form = new FormData();
    form.set("template", new File([new Uint8Array(await createFixtureTemplate("bright"))], "diagram-template.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.set("brief", "grounded diagram published export fixture");
    form.set("slideCount", "5");
    form.set("materials", new File([
      "source,target,relationship,comment\nAlpha,Beta,creates,Gamma\nBeta,Gamma,,Delta\n",
    ], "relations.csv", { type: "text/csv" }));

    const generation = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await generation.json() as { jobId: string; presentations: Record<LayoutVariant, unknown> };
    expect(generation.status, JSON.stringify(payload)).toBe(200);
    const store = new ArtifactStore(artifactRoot);

    for (const variant of variants) {
      const document = presentationDocumentSchema.parse(payload.presentations[variant]);
      const diagrams = document.slides.flatMap((slide) => {
        const prefix = `${slide.id}-grounded-diagram`;
        const elements = slide.canvas.elements.filter((element) => element.id.startsWith(prefix));
        return elements.length ? [{ slide, elements }] : [];
      });
      expect(diagrams, variant).toHaveLength(1);
      const { slide, elements } = diagrams[0]!;
      const lineElements = elements.filter((element) => element.type === "shape" && element.shape === "line");
      const diagramTexts = elements.filter((element) => element.type === "text").map((element) => element.text);
      expect(diagramTexts).toEqual(expect.arrayContaining(["Alpha", "Beta", "Gamma", "creates"]));
      expect(diagramTexts).not.toContain("uses");
      expect(diagramTexts).not.toContain("Delta");
      expect(lineElements.some((element) => element.id.includes("edge-0-node-1-node-2"))).toBe(true);
      expect(lineElements.some((element) => element.id.includes("edge-1-node-2-node-3"))).toBe(true);
      expect(slide.canvas.elements
        .filter((element) => element.type === "chart" || element.type === "table")).toHaveLength(0);

      const response = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: payload.jobId, variant }),
      }));
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(response.status, `${variant}: ${bytes.toString("utf8").slice(0, 300)}`).toBe(200);
      expect(response.headers.get("X-VK-Hackathon-Job-Id")).toBe(payload.jobId);
      const manifest = await store.readManifest(payload.jobId);
      const exports = manifest.artifacts.exports;
      const reference = exports && typeof exports === "object" && "compact" in exports ? exports[variant].pptx : null;
      if (!reference) throw new Error(`Missing published ${variant} PPTX reference`);
      expect(response.headers.get("X-VK-Hackathon-Artifact-Path")).toBe(reference.relativePath);
      expect(reference.byteSize).toBe(bytes.byteLength);
      expect(reference.sha256).toBe(sha256(bytes));
      expect((await store.readPublishedArtifact(payload.jobId, reference.relativePath)).contents).toEqual(bytes);

      const archive = await JSZip.loadAsync(bytes);
      const slideIndex = document.slides.findIndex((candidate) => candidate.id === slide.id) + 1;
      const slideXml = await archive.file(`ppt/slides/slide${slideIndex}.xml`)?.async("string");
      expect(slideXml, `${variant}: missing diagram slide XML`).toBeDefined();
      const shapeObjects = [...(slideXml ?? "").matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].map((match) => match[0]);
      const nativeTextObjects = shapeObjects.filter((shape) => /<a:t>(?:Alpha|Beta|Gamma|creates)<\/a:t>/u.test(shape));
      expect(nativeTextObjects, `${variant}: expected separately editable node and relationship labels`).toHaveLength(4);
      expect(shapeObjects.filter((shape) => /<a:prstGeom\b[^>]*prst="roundRect"/u.test(shape)).length).toBeGreaterThanOrEqual(3);
      expect(shapeObjects.filter((shape) => /<a:prstGeom\b[^>]*prst="line"/u.test(shape)).length).toBeGreaterThanOrEqual(2);
    }
  }, 120_000);
});
