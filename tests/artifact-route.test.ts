import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "../src/app/api/artifacts/[jobId]/[...path]/route";
import { ArtifactStore, ARTIFACT_RELATIVE_PATHS, renderSlideRelativePath, sha256 } from "../src/lib/artifact-store";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

let artifactRoot: string;
let jobId: string;
let slideContents: Buffer;
let previousArtifactRoot: string | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-artifact-route-"));
  previousArtifactRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
  process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;

  const store = new ArtifactStore(artifactRoot);
  const job = await store.createJob({ name: "template.pptx", buffer: Buffer.from("template") });
  jobId = job.jobId;
  await store.saveDesignSystem(jobId, await parsePptxTemplate(await createFixtureTemplate("bright"), "template.pptx"));
  const pdfPath = store.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.renderPdf);
  const slidePath = store.jobPath(jobId, renderSlideRelativePath(1));
  await mkdir(path.dirname(pdfPath), { recursive: true });
  const pdfContents = Buffer.from("%PDF-1.7 route fixture");
  slideContents = Buffer.from("PNG route fixture");
  await writeFile(pdfPath, pdfContents);
  await writeFile(slidePath, slideContents);
  await store.saveRenderArtifacts(jobId, {
    renderer: "libreoffice-impress-headless",
    rendererPath: "C:\\LibreOffice\\soffice.com",
    rendererVersion: "LibreOffice 26.8.0.3",
    rasterizer: "poppler-pdftoppm",
    rasterizerPath: "C:\\Poppler\\pdftoppm.exe",
    pageCounter: "poppler-pdfinfo",
    pageCounterPath: "C:\\Poppler\\pdfinfo.exe",
    inputPath: store.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.template),
    pdfPath,
    pdfBytes: pdfContents.byteLength,
    pdfSha256: sha256(pdfContents),
    outputFormat: "png",
    slideCount: 1,
    width: 900,
    height: 1_600,
    slides: [{
      outputPath: slidePath,
      outputFormat: "png",
      slideNumber: 1,
      outputBytes: slideContents.byteLength,
      outputSha256: sha256(slideContents),
    }],
  });
  await store.markReady(jobId);
  await writeFile(store.jobPath(jobId, "unpublished.txt"), "private");
});

afterAll(async () => {
  if (previousArtifactRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
  else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousArtifactRoot;
  await rm(artifactRoot, { recursive: true, force: true });
});

describe("GET /api/artifacts/[jobId]/[...path]", () => {
  it("serves a published render with its binary content type", async () => {
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ jobId, path: ["parsed", "renders", "slide-1.png"] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(slideContents);
  });

  it("blocks traversal and files that are not published in the manifest", async () => {
    const traversal = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ jobId, path: ["parsed", "renders", "..", "design-system.json"] }),
    });
    const unpublished = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ jobId, path: ["unpublished.txt"] }),
    });

    expect(traversal.status).toBe(404);
    expect(unpublished.status).toBe(404);
  });
});
