import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../src/lib/render-evidence", async () => {
  const { createHash: hash } = await import("node:crypto");
  const { mkdir: makeDirectory, writeFile: write } = await import("node:fs/promises");
  const renderPptxToPngs = vi.fn(async (inputPath: string, options: { outputDir?: string } = {}) => {
    if (!options.outputDir) throw new Error("Test renderer output directory is required");
    await makeDirectory(options.outputDir, { recursive: true });
    const pdf = Buffer.from("%PDF-1.7 mocked render");
    const pdfPath = path.join(options.outputDir, "template.pdf");
    await write(pdfPath, pdf);
    const slides = [];
    for (const slideNumber of [1, 2]) {
      const contents = Buffer.from("PNG slide " + slideNumber);
      const outputPath = path.join(options.outputDir, `slide-${slideNumber}.png`);
      await write(outputPath, contents);
      slides.push({
        outputPath,
        outputFormat: "png" as const,
        slideNumber,
        outputBytes: contents.byteLength,
        outputSha256: hash("sha256").update(contents).digest("hex"),
      });
    }
    return {
      renderer: "libreoffice-impress-headless" as const,
      rendererPath: "C:\\LibreOffice\\soffice.com",
      rendererVersion: "LibreOffice 26.8.0.3",
      rasterizer: "poppler-pdftoppm" as const,
      rasterizerPath: "C:\\Poppler\\pdftoppm.exe",
      pageCounter: "poppler-pdfinfo" as const,
      pageCounterPath: "C:\\Poppler\\pdfinfo.exe",
      inputPath,
      pdfPath,
      pdfBytes: pdf.byteLength,
      pdfSha256: hash("sha256").update(pdf).digest("hex"),
      outputFormat: "png" as const,
      slideCount: 2,
      width: 900,
      height: 1_600,
      slides,
    };
  });
  return { renderPptxToPngs };
});

import { POST } from "../src/app/api/analyze/route";
import { ARTIFACT_RELATIVE_PATHS } from "../src/lib/artifact-store";
import { artifactManifestSchema, designSystemSchema, renderEvidenceSchema } from "../src/lib/schemas";
import { renderPptxToPngs } from "../src/lib/render-evidence";
import { REQUEST_BODY_LIMITS } from "../src/lib/request-guards";
import { createFixtureTemplate } from "./fixture-decks";

let artifactRoot: string;
let previousArtifactRoot: string | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-analyze-"));
  previousArtifactRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
  process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
});

beforeEach(() => {
  vi.mocked(renderPptxToPngs).mockClear();
});

afterAll(async () => {
  if (previousArtifactRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
  else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousArtifactRoot;
  await rm(artifactRoot, { recursive: true, force: true });
});

describe("POST /api/analyze", () => {
  it("rejects an oversized declared request before parsing or rendering", async () => {
    const response = await POST(new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: {
        "content-length": String(REQUEST_BODY_LIMITS.analyze + 1),
        "content-type": "application/octet-stream",
      },
      body: "small",
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(renderPptxToPngs).not.toHaveBeenCalled();
    expect(await readdir(artifactRoot)).toEqual([]);
  });

  it("creates a ready job with the current designSystem response and expected files", async () => {
    const template = await createFixtureTemplate("bright");
    const response = await POST(createRequest(template, "fixture-template.pptx"));
    const payload = await response.json() as {
      designSystem?: unknown;
      jobId?: string;
      manifest?: unknown;
      renderEvidence?: unknown;
    };

    expect(response.status).toBe(200);
    const responseDesignSystem = designSystemSchema.parse(payload.designSystem);
    expect(responseDesignSystem.sourceName).toBe("fixture-template.pptx");
    expect(responseDesignSystem.evidence?.colors.length).toBeGreaterThan(0);
    expect(payload.jobId).toMatch(/^job-/);
    const manifest = artifactManifestSchema.parse(payload.manifest);
    expect(manifest.status).toBe("ready");
    const renderEvidence = renderEvidenceSchema.parse(payload.renderEvidence);
    expect(renderEvidence.slides).toHaveLength(2);

    const jobRoot = path.join(artifactRoot, payload.jobId!);
    await expectFile(path.join(jobRoot, ARTIFACT_RELATIVE_PATHS.template));
    await expectFile(path.join(jobRoot, ARTIFACT_RELATIVE_PATHS.parsedDesignSystem));
    await expectFile(path.join(jobRoot, ARTIFACT_RELATIVE_PATHS.parsedRenderEvidence));
    await expectFile(path.join(jobRoot, ARTIFACT_RELATIVE_PATHS.renderPdf));
    await expectFile(path.join(jobRoot, "parsed/renders/slide-1.png"));
    await expectFile(path.join(jobRoot, "parsed/renders/slide-2.png"));
    await expectFile(path.join(jobRoot, ARTIFACT_RELATIVE_PATHS.manifest));
    const savedDesignSystem = designSystemSchema.parse(JSON.parse(await readFile(
      path.join(jobRoot, ARTIFACT_RELATIVE_PATHS.parsedDesignSystem),
      "utf8",
    )));
    expect(savedDesignSystem.sourceName).toBe("fixture-template.pptx");
    expect(savedDesignSystem.evidence?.colors.length).toBeGreaterThan(0);
    expect(manifest.artifacts.renders?.slides.map((slide) => slide.relativePath)).toEqual([
      "parsed/renders/slide-1.png",
      "parsed/renders/slide-2.png",
    ]);
    expect(manifest.artifacts.renders?.slides.every((slide) => slide.byteSize > 0 && /^[0-9a-f]{64}$/i.test(slide.sha256))).toBe(true);
  });

  it("uses different ids for repeated jobs", async () => {
    const template = await createFixtureTemplate("dark");
    const first = await POST(createRequest(template, "dark-template.pptx"));
    const second = await POST(createRequest(template, "dark-template.pptx"));
    const firstPayload = await first.json() as { jobId: string };
    const secondPayload = await second.json() as { jobId: string };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstPayload.jobId).not.toBe(secondPayload.jobId);
    expect((await readdir(artifactRoot)).filter((entry) => entry.startsWith("job-")).length).toBeGreaterThanOrEqual(2);
  });

  it("persists failed instead of ready when analysis throws", async () => {
    const response = await POST(createRequest(Buffer.from("not a pptx"), "broken-template.pptx"));
    const payload = await response.json() as { error?: string; jobId?: string; manifest?: unknown };

    expect(response.status).toBe(400);
    expect(payload.error).toBeTruthy();
    expect(payload.jobId).toMatch(/^job-/);
    const manifest = artifactManifestSchema.parse(payload.manifest);
    expect(manifest.status).toBe("failed");
    expect(manifest.status).not.toBe("ready");
    expect(manifest.artifacts.parsed).toBeNull();
    expect(manifest.error).not.toMatch(/\r|\n/);
  });

  it("returns an explicit renderer blocker and failed manifest", async () => {
    vi.mocked(renderPptxToPngs).mockRejectedValueOnce(
      Object.assign(new Error("RENDER_BLOCKER: LibreOffice soffice was not found"), { code: "renderer_unavailable" }),
    );
    const response = await POST(createRequest(await createFixtureTemplate("bright"), "missing-renderer.pptx"));
    const payload = await response.json() as { error?: string; manifest?: unknown };

    expect(response.status).toBe(400);
    expect(payload.error).toContain("RENDER_BLOCKER");
    expect(artifactManifestSchema.parse(payload.manifest).status).toBe("failed");
  });

  it("removes partial render output when the renderer fails", async () => {
    vi.mocked(renderPptxToPngs).mockImplementationOnce(async (_inputPath, options = {}) => {
      await mkdir(options.outputDir!, { recursive: true });
      await writeFile(path.join(options.outputDir!, "template.pdf"), Buffer.from("partial pdf"));
      await writeFile(path.join(options.outputDir!, "slide-1.png"), Buffer.from("partial png"));
      throw Object.assign(new Error("Poppler PDF rasterization exceeded the configured timeout"), { code: "timeout" });
    });

    const response = await POST(createRequest(await createFixtureTemplate("photo"), "partial-render.pptx"));
    const payload = await response.json() as { jobId?: string; manifest?: unknown; error?: string };
    const manifest = artifactManifestSchema.parse(payload.manifest);

    expect(response.status).toBe(400);
    expect(payload.error).toContain("RENDER_BLOCKER [timeout]");
    expect(manifest.status).toBe("failed");
    expect(manifest.artifacts.renderEvidence).toBeNull();
    expect(manifest.artifacts.renders).toBeNull();
    await expect(readdir(path.join(artifactRoot, payload.jobId!, "parsed/renders"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createRequest(template: Buffer, filename: string) {
  const form = new FormData();
  form.set("template", new File([new Uint8Array(template)], filename, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }));
  return new Request("http://localhost/api/analyze", { method: "POST", body: form });
}

async function expectFile(filePath: string) {
  const stat = await import("node:fs/promises").then(({ stat }) => stat(filePath));
  expect(stat.isFile()).toBe(true);
}
