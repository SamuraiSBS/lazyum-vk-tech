import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      if (!args[0].brief.includes("grounded table route fixture")) return plan;
      const content = args[0];
      return {
        ...plan,
        slides: plan.slides.map((slide, index) => index === 1 ? {
          ...slide,
          claims: [{
            id: "table-evidence", text: "Source spreadsheet values", grounding: "grounded" as const,
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

import { POST as exportPresentation } from "../src/app/api/export/route";
import { POST as generate } from "../src/app/api/generate/route";
import { ArtifactStore } from "../src/lib/artifact-store";
import {
  artifactManifestSchema,
  generationPlanningSchema,
  presentationDocumentSchema,
  type PresentationDocument,
} from "../src/lib/schemas";
import { REQUEST_BODY_LIMITS } from "../src/lib/request-guards";
import { createFixtureTemplate } from "./fixture-decks";

let artifactRoot: string;
let previousArtifactRoot: string | undefined;
let previousProvider: string | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-generate-variants-"));
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

describe("POST /api/generate three-variant contract", () => {
  it("renders a validated native table in all three ordinary generation variants when claims cover the complete CSV grid", async () => {
    const form = new FormData();
    form.set("template", new File([new Uint8Array(await createFixtureTemplate("bright"))], "table-template.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.set("brief", "grounded table route fixture");
    form.set("slideCount", "5");
    form.set("materials", new File(["Period,Completed\nQ1,42\nQ2,57\n"], "metrics.csv", { type: "text/csv" }));
    const response = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    for (const variant of ["compact", "balanced", "visual"] as const) {
      const document = presentationDocumentSchema.parse(payload.presentations[variant]);
      const table = document.slides.flatMap((slide) => slide.canvas.elements).find((element) => element.type === "table");
      expect(table?.type).toBe("table");
      if (table?.type !== "table") continue;
      expect(table.rows.map((row) => row.map((cell) => cell.text))).toEqual([
        ["", "Completed"], ["Q1", "42"], ["Q2", "57"],
      ]);
    }
  });

  it("rejects an oversized declared request before parsing or creating a job", async () => {
    const response = await generate(new Request("http://localhost/api/generate", {
      method: "POST",
      headers: {
        "content-length": String(REQUEST_BODY_LIMITS.generate + 1),
        "content-type": "application/octet-stream",
      },
      body: "small",
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("plans once, returns exactly three variants, and keeps the balanced export alias usable", async () => {
    const response = await generate(createRequest(
      await createFixtureTemplate("bright"),
      "three-variant-template.pptx",
      "Единый source-grounded план для трёх профилей верстки",
    ));
    const payload = await response.json() as {
      audit: unknown;
      audits: Record<string, unknown>;
      normalizedContent: unknown;
      presentation: unknown;
      presentations: Record<string, unknown>;
      jobId: string;
      manifest: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.jobId).toMatch(/^job-/);
    expect(Object.keys(payload.presentations).sort()).toEqual(["balanced", "compact", "visual"]);
    expect(Object.keys(payload.audits).sort()).toEqual(["balanced", "compact", "visual"]);

    const documents = Object.fromEntries(
      (["compact", "balanced", "visual"] as const).map((variant) => [
        variant,
        presentationDocumentSchema.parse(payload.presentations[variant]),
      ]),
    ) as Record<"compact" | "balanced" | "visual", PresentationDocument>;
    const manifest = artifactManifestSchema.parse(payload.manifest);
    if (!manifest.artifacts.planning) throw new Error("Expected the canonical planning artifact");
    const planning = generationPlanningSchema.parse(JSON.parse(
      (await new ArtifactStore(artifactRoot).readPublishedArtifact(payload.jobId, manifest.artifacts.planning.relativePath)).contents.toString("utf8"),
    ));

    expect(documents.compact.variant).toBe("compact");
    expect(documents.balanced.variant).toBe("balanced");
    expect(documents.visual.variant).toBe("visual");
    expect(documents.compact.designSystem).toEqual(documents.balanced.designSystem);
    expect(documents.balanced.designSystem).toEqual(documents.visual.designSystem);
    expect(documents.compact.plan).toEqual(documents.balanced.plan);
    expect(documents.balanced.plan).toEqual(documents.visual.plan);
    expect(planning.normalizedContent).toEqual(payload.normalizedContent);
    expect(planning.presentationPlan).toEqual(documents.compact.plan);
    expect(manifest.groundingSummary).toEqual(planning.presentationPlan.meta?.groundingSummary);
    expect(planning.presentationPlan.meta?.groundingSummary).toMatchObject({
      total: expect.any(Number),
      grounded: expect.any(Number),
      unsupported: expect.any(Number),
      rejected: 0,
      ruleVersion: "evidence-carrying-v1",
    });
    expect(documents.compact).not.toEqual(documents.balanced);
    expect(documents.balanced).not.toEqual(documents.visual);
    for (const document of Object.values(documents)) {
      expect(document.slides.flatMap((slide) => slide.canvas.elements).some((element) => element.type === "table")).toBe(false);
    }

    expect(payload.presentation).toEqual(payload.presentations.balanced);
    expect(payload.audit).toEqual(payload.audits.balanced);
    const exportResponse = await exportPresentation(new Request("http://localhost/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload.presentation),
    }));
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-type")).toContain("presentationml.presentation");
  });
});

function createRequest(template: Buffer, filename: string, brief: string) {
  const form = new FormData();
  form.set("template", new File([new Uint8Array(template)], filename, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }));
  form.set("brief", brief);
  form.set("slideCount", "5");
  form.set("materials", new File(["Команда проверяет общий план и три контролируемых профиля."], "notes.txt", { type: "text/plain" }));
  return new Request("http://localhost/api/generate", { method: "POST", body: form });
}
