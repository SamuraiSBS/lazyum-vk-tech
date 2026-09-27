import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/analyze/route";
import { artifactManifestSchema, renderEvidenceSchema } from "../src/lib/schemas";
import os from "node:os";

const organizerDirectory = path.resolve("fixtures/templates/organizer");
const fixtures = [
  { name: "VK Tech шаблон.pptx", slideCount: 54 },
  { name: "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx", slideCount: 29 },
  { name: "Шаблон презентации VK Education.pptx", slideCount: 55 },
] as const;

const runRealAcceptance = process.env.VK_HACKATHON_REAL_TEMPLATE_ACCEPTANCE === "1";
const describeRealAcceptance = runRealAcceptance ? describe : describe.skip;

describeRealAcceptance("real organizer POST /api/analyze acceptance", () => {
  let artifactRoot: string;
  let previousArtifactRoot: string | undefined;
  let previousRenderTimeout: string | undefined;

  beforeAll(async () => {
    artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-real-route-"));
    previousArtifactRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
    previousRenderTimeout = process.env.VK_HACKATHON_RENDER_TIMEOUT_MS;
    process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
    process.env.VK_HACKATHON_RENDER_TIMEOUT_MS = "300000";
  });

  afterAll(async () => {
    if (previousArtifactRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
    else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousArtifactRoot;
    if (previousRenderTimeout === undefined) delete process.env.VK_HACKATHON_RENDER_TIMEOUT_MS;
    else process.env.VK_HACKATHON_RENDER_TIMEOUT_MS = previousRenderTimeout;
    await rm(artifactRoot, { recursive: true, force: true });
  });

  it.each(fixtures)("renders $name through the route", async ({ name, slideCount }) => {
    const templatePath = path.join(organizerDirectory, name);
    const templateBuffer = await readFile(templatePath);
    const response = await POST(createRequest(templateBuffer, name));
    const payload = await response.json() as {
      jobId?: string;
      manifest?: unknown;
      renderEvidence?: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.jobId).toMatch(/^job-/);
    const manifest = artifactManifestSchema.parse(payload.manifest);
    const evidence = renderEvidenceSchema.parse(payload.renderEvidence);
    expect(manifest.status).toBe("ready");
    expect(evidence.slideCount).toBe(slideCount);
    expect(evidence.slides).toHaveLength(slideCount);

    const jobRoot = path.join(artifactRoot, payload.jobId!);
    const files = await listFiles(jobRoot);
    expect(files).toContain("input/template.pptx");
    expect(files).toContain("parsed/design-system.json");
    expect(files).toContain("parsed/render-evidence.json");
    expect(files).toContain("parsed/renders/template.pdf");
    expect(files).toContain("manifest.json");
    expect(files.filter((file) => /^parsed\/renders\/slide-\d+\.png$/.test(file))).toHaveLength(slideCount);
    expect(manifest.artifacts.renders?.slides).toHaveLength(slideCount);
    expect(manifest.artifacts.renders?.slides.every((slide) => (
      /^parsed\/renders\/slide-\d+\.png$/.test(slide.relativePath)
      && slide.byteSize > 0
      && /^[0-9a-f]{64}$/.test(slide.sha256)
    ))).toBe(true);
  }, 900_000);
});

function createRequest(template: Buffer, filename: string) {
  const form = new FormData();
  form.set("template", new File([new Uint8Array(template)], filename, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }));
  return new Request("http://localhost/api/analyze", { method: "POST", body: form });
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(entryPath)).map((relative) => `${entry.name}/${relative}`));
    } else if (entry.isFile()) {
      result.push(entry.name);
    }
  }
  return result;
}
