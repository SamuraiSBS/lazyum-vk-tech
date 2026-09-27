import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/request-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/request-guards")>();
  const guard = actual.createProcessRequestGuard({
    maxGenerationRequestsPerWindow: 100,
    maxExportRequestsPerWindow: 100,
  });
  return {
    ...actual,
    acquireHeavyOperation: (operationClass: "generation" | "export") => guard.acquireHeavyOperation(operationClass),
  };
});

vi.mock("../src/lib/planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/planner")>();
  return {
    ...actual,
    createPresentationPlan: async (...args: Parameters<typeof actual.createPresentationPlan>) => {
      const plan = await actual.createPresentationPlan(...args);
      const content = args[0];
      return {
        ...plan,
        slides: plan.slides.map((slide, index) => index === 1 ? {
          ...slide,
          claims: [{
            id: "published-table-evidence",
            text: "Source spreadsheet values",
            grounding: "grounded" as const,
            precision: "exact" as const,
            sourceRefs: {
              factIds: (content.facts ?? []).map((fact) => fact.factId),
              sourceChunkIds: content.sourceChunks.map((chunk) => chunk.chunkId),
            },
          }],
        } : slide),
      };
    },
  };
});

import { POST as generate } from "../src/app/api/generate/route";
import { POST as exportPptx } from "../src/app/api/export/route";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { presentationDocumentSchema, type LayoutVariant } from "../src/lib/schemas";
import { createFixtureTemplate } from "./fixture-decks";

const variants: LayoutVariant[] = ["compact", "balanced", "visual"];
const cases = [
  { sourceCsv: "Period,Completed\nQ1,42\nQ2,57\n", expectedRows: [["Period", "Completed"], ["Q1", "42"], ["Q2", "57"]] },
  { sourceCsv: ",Completed\nQ1,42\nQ2,57\n", expectedRows: [["", "Completed"], ["Q1", "42"], ["Q2", "57"]] },
];
let artifactRoot: string;
let previousArtifactRoot: string | undefined;
let previousProvider: string | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-grounded-table-published-export-"));
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

describe("ordinary grounded table through published job PPTX", () => {
  it.each(cases)("exports exact editable CSV cells for all variants: $sourceCsv", async ({ sourceCsv, expectedRows }) => {
    expect(sourceCsv.trimEnd().split("\n").map((row) => row.split(","))).toEqual(expectedRows);
    const form = new FormData();
    form.set("template", new File([new Uint8Array(await createFixtureTemplate("bright"))], "table-template.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.set("brief", "Grounded table published export fixture");
    form.set("slideCount", "5");
    form.set("materials", new File([sourceCsv], "metrics.csv", { type: "text/csv" }));

    const generation = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await generation.json();
    expect(generation.status, JSON.stringify(payload)).toBe(200);
    expect(payload.jobId).toMatch(/^job-/u);
    const store = new ArtifactStore(artifactRoot);

    for (const variant of variants) {
      const document = presentationDocumentSchema.parse(payload.presentations[variant]);
      const tableSlides = document.slides.flatMap((slide, index) => slide.canvas.elements
        .filter((element) => element.type === "table")
        .map((table) => ({ index, table })));
      expect(tableSlides, variant).toHaveLength(1);
      const { index, table } = tableSlides[0]!;
      if (table.type !== "table") throw new Error(`Missing native table in ${variant}`);
      expect(table.rows.map((row) => row.map((cell) => cell.text)), variant).toEqual(expectedRows);

      const response = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: payload.jobId, variant }),
      }));
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(response.status, `${variant}: ${bytes.toString("utf8").slice(0, 300)}`).toBe(200);
      expect(response.headers.get("content-type")).toContain("presentationml.presentation");
      expect(response.headers.get("X-VK-Hackathon-Job-Id")).toBe(payload.jobId);

      const manifest = await store.readManifest(payload.jobId);
      const exports = manifest.artifacts.exports;
      const reference = exports && typeof exports === "object" && "compact" in exports
        ? exports[variant].pptx : null;
      if (!reference) throw new Error(`Missing published ${variant} PPTX reference`);
      expect(response.headers.get("X-VK-Hackathon-Artifact-Path")).toBe(reference.relativePath);
      expect(reference.byteSize).toBe(bytes.byteLength);
      expect(reference.sha256).toBe(sha256(bytes));
      expect((await store.readPublishedArtifact(payload.jobId, reference.relativePath)).contents).toEqual(bytes);

      const archive = await JSZip.loadAsync(bytes);
      const slideXml = await archive.file(`ppt/slides/slide${index + 1}.xml`)?.async("string");
      expect(slideXml, `${variant}: missing table slide XML`).toBeDefined();
      const nativeTables = slideXml?.match(/<a:tbl>[\s\S]*?<\/a:tbl>/gu) ?? [];
      expect(nativeTables, `${variant}: no editable OOXML table`).toHaveLength(1);
      const rows = [...nativeTables[0]!.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gu)]
        .map((match) => [...match[1]!.matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/gu)]
          .map((cell) => [...cell[1]!.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)]
            .map((text) => text[1]).join("")));
      expect(rows, `${variant}: native cell values`).toEqual(expectedRows);
      expect(slideXml, `${variant}: raster slide substitution`).not.toContain("<p:pic>");
    }
  }, 120_000);
});
