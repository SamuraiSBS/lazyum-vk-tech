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
    const content = args[0];
    return { ...plan, slides: plan.slides.map((slide, index) => index === 1 ? {
      ...slide, title: "Completed chart", claims: [{ id: "published-chart-evidence", text: "Source spreadsheet values",
        grounding: "grounded" as const, precision: "exact" as const,
        sourceRefs: { factIds: (content.facts ?? []).map((fact) => fact.factId), sourceChunkIds: content.sourceChunks.map((chunk) => chunk.chunkId) } }],
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
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-grounded-chart-published-export-"));
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

describe("ordinary grounded chart through published job PPTX", () => {
  it("exports exact editable categories and values for all variants", async () => {
    const form = new FormData();
    form.set("template", new File([new Uint8Array(await createFixtureTemplate("bright"))], "chart-template.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.set("brief", "Grounded chart published export fixture");
    form.set("slideCount", "5");
    form.set("materials", new File(["Period,Completed\nQ1,42\nQ2,57\n"], "metrics.csv", { type: "text/csv" }));
    const generation = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await generation.json();
    expect(generation.status, JSON.stringify(payload)).toBe(200);
    const store = new ArtifactStore(artifactRoot);

    for (const variant of variants) {
      const document = presentationDocumentSchema.parse(payload.presentations[variant]);
      const chartSlides = document.slides.flatMap((slide, index) => slide.canvas.elements
        .filter((element) => element.type === "chart").map((chart) => ({ index, chart, slide })));
      expect(chartSlides, variant).toHaveLength(1);
      const { index, chart, slide } = chartSlides[0]!;
      if (chart.type !== "chart") throw new Error(`Missing native chart in ${variant}`);
      expect(chart.chartType).toBe("pie");
      expect(chart.categories.map((datum) => datum.value)).toEqual(["Q1", "Q2"]);
      expect(chart.series.label.value).toBe("Completed");
      expect(chart.series.values.map((datum) => datum.value)).toEqual([42, 57]);
      expect(slide.canvas.elements.filter((element) => element.type === "table"), variant).toHaveLength(0);
      expect(slide.canvas.elements.filter((element) => element.id === chart.id), variant).toHaveLength(1);

      const response = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: payload.jobId, variant }),
      }));
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(response.status, `${variant}: ${bytes.toString("utf8").slice(0, 300)}`).toBe(200);
      const manifest = await store.readManifest(payload.jobId);
      const exports = manifest.artifacts.exports;
      const reference = exports && typeof exports === "object" && "compact" in exports ? exports[variant].pptx : null;
      if (!reference) throw new Error(`Missing published ${variant} PPTX reference`);
      expect(response.headers.get("X-VK-Hackathon-Artifact-Path")).toBe(reference.relativePath);
      expect(reference.byteSize).toBe(bytes.byteLength);
      expect(reference.sha256).toBe(sha256(bytes));
      expect((await store.readPublishedArtifact(payload.jobId, reference.relativePath)).contents).toEqual(bytes);

      const archive = await JSZip.loadAsync(bytes);
      const slideXml = await archive.file(`ppt/slides/slide${index + 1}.xml`)?.async("string");
      expect(slideXml).toContain("<c:chart");
      const relationships = await archive.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`)?.async("string");
      const chartTarget = relationships?.match(/Target="(?:\/ppt|\.\.)\/charts\/(chart\d+\.xml)"/u)?.[1];
      expect(chartTarget, `${variant}: chart relation`).toBeDefined();
      const chartXml = await archive.file(`ppt/charts/${chartTarget}`)?.async("string");
      expect(chartXml).toContain("<c:pieChart>");
      for (const value of ["Q1", "Q2", "Completed", "42", "57"]) expect(chartXml).toContain(value);
      expect(chartXml).toContain("<c:externalData");
      expect(archive.file(/ppt\/embeddings\/.*\.xlsx$/u).length).toBeGreaterThan(0);
    }
  }, 120_000);
});
