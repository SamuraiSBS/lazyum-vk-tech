import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_RELATIVE_PATHS,
  ArtifactStore,
  sha256,
  renderSlideRelativePath,
} from "../src/lib/artifact-store";
import { artifactManifestSchema, renderEvidenceSchema } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ArtifactStore", () => {
  it("validates a manifest and persists the template, parsed JSON, hashes and sizes", async () => {
    const root = await testRoot();
    const store = new ArtifactStore(root);
    const template = Buffer.from("fixture-pptx-bytes");
    const job = await store.createJob({ name: "template.pptx", buffer: template });
    const designSystem = await parsePptxTemplate(await createFixtureTemplate("bright"), "template.pptx");

    await store.saveDesignSystem(job.jobId, designSystem);
    await saveFakeRenderArtifacts(store, job.jobId);
    const manifest = await store.markReady(job.jobId);
    const manifestFromDisk = artifactManifestSchema.parse(JSON.parse(
      await readFile(store.jobPath(job.jobId, ARTIFACT_RELATIVE_PATHS.manifest), "utf8"),
    ));
    const templateFromDisk = await readFile(store.jobPath(job.jobId, ARTIFACT_RELATIVE_PATHS.template));
    const parsedFromDisk = JSON.parse(await readFile(
      store.jobPath(job.jobId, ARTIFACT_RELATIVE_PATHS.parsedDesignSystem),
      "utf8",
    ));

    expect(manifestFromDisk).toEqual(manifest);
    expect(manifest.status).toBe("ready");
    expect(manifest.inputs.template.byteSize).toBe(templateFromDisk.byteLength);
    expect(manifest.inputs.template.sha256).toBe(sha256(templateFromDisk));
    expect(manifest.inputs.template.relativePath).toBe(ARTIFACT_RELATIVE_PATHS.template);
    expect(manifest.artifacts).toMatchObject({
      parsed: {
        relativePath: ARTIFACT_RELATIVE_PATHS.parsedDesignSystem,
        byteSize: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      renderEvidence: {
        relativePath: ARTIFACT_RELATIVE_PATHS.parsedRenderEvidence,
        byteSize: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      renders: {
        pdf: {
          relativePath: ARTIFACT_RELATIVE_PATHS.renderPdf,
          byteSize: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        slides: [{
          slideNumber: 1,
          relativePath: renderSlideRelativePath(1),
          byteSize: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }],
      },
      planning: null,
      variants: null,
      exports: null,
      audit: null,
    });
    expect(parsedFromDisk).toEqual(designSystem);
    const evidenceFromDisk = renderEvidenceSchema.parse(JSON.parse(await readFile(
      store.jobPath(job.jobId, ARTIFACT_RELATIVE_PATHS.parsedRenderEvidence),
      "utf8",
    )));
    expect(evidenceFromDisk.pdf.relativePath).toBe(ARTIFACT_RELATIVE_PATHS.renderPdf);
    expect(evidenceFromDisk.slides[0].sha256).toBe(manifest.artifacts.renders?.slides[0].sha256);
    await expect(store.readPublishedArtifact(job.jobId, renderSlideRelativePath(1))).resolves.toMatchObject({
      relativePath: renderSlideRelativePath(1),
    });
  });

  it("gives repeated jobs different ids and blocks traversal", async () => {
    const root = await testRoot();
    const store = new ArtifactStore(root);
    const template = Buffer.from("same-template");
    const first = await store.createJob({ name: "template.pptx", buffer: template });
    const second = await store.createJob({ name: "template.pptx", buffer: template });

    expect(first.jobId).not.toBe(second.jobId);
    expect(() => store.jobPath(first.jobId, "../outside.json")).toThrow(/escapes/i);
    expect(() => store.jobPath("../outside", ARTIFACT_RELATIVE_PATHS.manifest)).toThrow(/job id/i);
    await expect(store.readPublishedArtifact(first.jobId, "parsed/renders/../design-system.json")).rejects.toThrow(/invalid artifact path/i);
  });

  it("records a failed job without claiming ready", async () => {
    const root = await testRoot();
    const store = new ArtifactStore(root);
    const job = await store.createJob({ name: "template.pptx", buffer: Buffer.from("input") });

    const manifest = await store.markFailed(job.jobId, new Error("parse failed\ninternal detail"));

    expect(manifest.status).toBe("failed");
    expect(manifest.error).toBe("parse failed internal detail");
    expect(manifest.status).not.toBe("ready");
    expect(manifest.artifacts.parsed).toBeNull();
  });
});

async function testRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-artifacts-"));
  roots.push(root);
  return root;
}

async function saveFakeRenderArtifacts(store: ArtifactStore, jobId: string) {
  const pdfPath = store.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.renderPdf);
  const slidePath = store.jobPath(jobId, renderSlideRelativePath(1));
  await mkdir(path.dirname(pdfPath), { recursive: true });
  const pdf = Buffer.from("%PDF-1.7 fixture");
  const slide = Buffer.from("PNG fixture");
  await writeFile(pdfPath, pdf);
  await writeFile(slidePath, slide);
  return store.saveRenderArtifacts(jobId, {
    renderer: "libreoffice-impress-headless",
    rendererPath: "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    rendererVersion: "LibreOffice 26.8.0.3",
    rasterizer: "poppler-pdftoppm",
    rasterizerPath: "C:\\Poppler\\pdftoppm.exe",
    pageCounter: "poppler-pdfinfo",
    pageCounterPath: "C:\\Poppler\\pdfinfo.exe",
    inputPath: store.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.template),
    pdfPath,
    pdfBytes: pdf.byteLength,
    pdfSha256: sha256(pdf),
    outputFormat: "png",
    slideCount: 1,
    width: 900,
    height: 1_600,
    slides: [{
      outputPath: slidePath,
      outputFormat: "png",
      slideNumber: 1,
      outputBytes: slide.byteLength,
      outputSha256: sha256(slide),
    }],
  });
}
