import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_RELATIVE_PATHS, ArtifactStore, renderSlideRelativePath, sha256 } from "../src/lib/artifact-store";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";
import { pruneJobs } from "../scripts/prune-jobs";

const temporaryRoots: string[] = [];
const now = new Date("2026-09-27T12:00:00.000Z");
const oldDate = "2026-08-01T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vk-prune-"));
  temporaryRoots.push(root);
  return root;
}

async function job(store: ArtifactStore, status: "analyzing" | "ready" | "failed", updatedAt = oldDate) {
  const created = await store.createJob({ name: "template.pptx", buffer: Buffer.from("template") });
  const manifestPath = store.jobPath(created.jobId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, status, createdAt: oldDate, updatedAt }));
  return created.jobId;
}

describe("job pruning", () => {
  it("reports old completed jobs in dry-run and protects active, recent and malformed entries", async () => {
    const root = await fixtureRoot();
    const store = new ArtifactStore(root);
    const oldReady = await job(store, "ready");
    const oldFailed = await job(store, "failed");
    const active = await job(store, "analyzing");
    const recent = await job(store, "ready", "2026-09-26T12:00:00.000Z");
    const malformed = await job(store, "failed");
    await writeFile(store.jobPath(malformed, "manifest.json"), "not json");
    await mkdir(path.join(root, "unrelated"));

    const result = await pruneJobs({ root, olderThanDays: 7, now });
    expect(result.candidates.sort()).toEqual([oldReady, oldFailed].sort());
    expect(result.deleted).toEqual([]);
    expect(result.skipped.map((item) => item.name)).toEqual(expect.arrayContaining([active, recent, malformed, "unrelated"]));
    expect(await readdir(root)).toHaveLength(6);
  });

  it("requires a stopped service before deletion and only deletes eligible jobs", async () => {
    const root = await fixtureRoot();
    const store = new ArtifactStore(root);
    const oldReady = await job(store, "ready");
    const active = await job(store, "analyzing");
    await expect(pruneJobs({ root, olderThanDays: 7, apply: true, now })).rejects.toThrow(/Stop the application/);
    const result = await pruneJobs({ root, olderThanDays: 7, apply: true, stopped: true, now });
    expect(result.deleted).toEqual([oldReady]);
    expect(await readdir(root)).toEqual([active]);
  });

  it("keeps a published job readable after copying and restoring the volume", async () => {
    const parent = await fixtureRoot();
    const root = path.join(parent, "jobs");
    const backup = path.join(parent, "backup");
    const restored = path.join(parent, "restored");
    await mkdir(root);
    const store = new ArtifactStore(root);
    const created = await store.createJob({ name: "template.pptx", buffer: Buffer.from("template") });
    const published = created.jobId;
    await store.saveDesignSystem(published, await parsePptxTemplate(await createFixtureTemplate("bright"), "template.pptx"));
    const pdfPath = store.jobPath(published, ARTIFACT_RELATIVE_PATHS.renderPdf);
    const slidePath = store.jobPath(published, renderSlideRelativePath(1));
    const pdf = Buffer.from("%PDF-1.7 fixture");
    const slide = Buffer.from("PNG fixture");
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, pdf);
    await writeFile(slidePath, slide);
    await store.saveRenderArtifacts(published, {
      renderer: "libreoffice-impress-headless",
      rendererPath: "fixture-soffice",
      rendererVersion: "fixture",
      rasterizer: "poppler-pdftoppm",
      rasterizerPath: "fixture-pdftoppm",
      pageCounter: "poppler-pdfinfo",
      pageCounterPath: "fixture-pdfinfo",
      inputPath: store.jobPath(published, ARTIFACT_RELATIVE_PATHS.template),
      pdfPath,
      pdfBytes: pdf.byteLength,
      pdfSha256: sha256(pdf),
      outputFormat: "png",
      slideCount: 1,
      width: 900,
      height: 1600,
      slides: [{
        outputPath: slidePath,
        outputFormat: "png",
        slideNumber: 1,
        outputBytes: slide.byteLength,
        outputSha256: sha256(slide),
      }],
    });
    await store.markReady(published);
    await cp(root, backup, { recursive: true });
    await cp(backup, restored, { recursive: true });

    const reopened = new ArtifactStore(restored);
    expect((await reopened.readManifest(published)).status).toBe("ready");
    const artifact = await reopened.readPublishedArtifact(published, renderSlideRelativePath(1));
    expect(sha256(artifact.contents)).toBe(sha256(slide));
  });

  it("rejects unsafe roots and retention values", async () => {
    const root = await fixtureRoot();
    await expect(pruneJobs({ root: ".", olderThanDays: 7, now })).rejects.toThrow(/absolute path/);
    await expect(pruneJobs({ root, olderThanDays: 0, now })).rejects.toThrow(/positive whole number/);
    await expect(pruneJobs({ root: path.parse(root).root, olderThanDays: 7, now })).rejects.toThrow(/Filesystem root/);
  });
});
