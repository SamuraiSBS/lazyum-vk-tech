import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/analyze/route";
import {
  artifactManifestSchema,
  designSystemSchema,
  renderEvidenceSchema,
  type ArtifactReference,
} from "../src/lib/schemas";

const heldOutTemplatePath = process.env.VK_HACKATHON_HELD_OUT_TEMPLATE_PATH;
const runHeldOutAcceptance = process.env.VK_HACKATHON_HELD_OUT_TEMPLATE_ACCEPTANCE === "1"
  && Boolean(heldOutTemplatePath && path.isAbsolute(heldOutTemplatePath));
const describeHeldOutAcceptance = runHeldOutAcceptance ? describe : describe.skip;

describeHeldOutAcceptance("held-out template POST /api/analyze acceptance", () => {
  let artifactRoot = "";
  let previousArtifactRoot: string | undefined;
  let previousRenderTimeout: string | undefined;

  beforeAll(async () => {
    artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-held-out-route-"));
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
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  });

  it("persists consistent server-side evidence for the configured external template", async () => {
    const templatePath = heldOutTemplatePath!;
    const template = await readFile(templatePath);
    const response = await POST(createRequest(template, path.basename(templatePath)));
    const payload = await response.json() as {
      designSystem?: unknown;
      jobId?: string;
      manifest?: unknown;
      renderEvidence?: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.jobId).toMatch(/^job-/);

    const manifest = artifactManifestSchema.parse(payload.manifest);
    const designSystem = designSystemSchema.parse(payload.designSystem);
    const renderEvidence = renderEvidenceSchema.parse(payload.renderEvidence);
    expect(manifest.status).toBe("ready");
    expect(renderEvidence.inputPath).toBe("input/template.pptx");
    expect(renderEvidence.slides).toHaveLength(renderEvidence.slideCount);
    expect(renderEvidence.slides.map((slide) => slide.slideNumber)).toEqual(
      Array.from({ length: renderEvidence.slideCount }, (_, index) => index + 1),
    );

    const parsed = expectReference(manifest.artifacts.parsed, "DesignSystem");
    const savedRenderEvidence = expectReference(manifest.artifacts.renderEvidence, "render evidence");
    const renders = manifest.artifacts.renders;
    expect(renders).not.toBeNull();
    const renderArtifacts = renders!;
    expect(renderArtifacts.pdf).toEqual(renderEvidence.pdf);
    expect(renderArtifacts.slides).toEqual(renderEvidence.slides);
    expect(renderArtifacts.slides).toHaveLength(renderEvidence.slideCount);

    const jobRoot = path.join(artifactRoot, payload.jobId!);
    await expectPersistedArtifact(jobRoot, manifest.inputs.template);
    await expectPersistedArtifact(jobRoot, parsed);
    await expectPersistedArtifact(jobRoot, savedRenderEvidence);
    await expectPersistedArtifact(jobRoot, renderArtifacts.pdf);
    await Promise.all(renderArtifacts.slides.map((slide) => expectPersistedArtifact(jobRoot, slide)));

    expect(artifactManifestSchema.parse(JSON.parse(await readFile(path.join(jobRoot, "manifest.json"), "utf8")))).toEqual(manifest);
    expect(JSON.parse(await readFile(path.join(jobRoot, parsed.relativePath), "utf8"))).toEqual(designSystem);
    expect(JSON.parse(await readFile(path.join(jobRoot, savedRenderEvidence.relativePath), "utf8"))).toEqual(renderEvidence);
  }, 900_000);
});

function createRequest(template: Buffer, filename: string) {
  const form = new FormData();
  form.set("template", new File([new Uint8Array(template)], filename, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }));
  return new Request("http://localhost/api/analyze", { method: "POST", body: form });
}

function expectReference(reference: ArtifactReference | null, label: string): ArtifactReference {
  expect(reference, `${label} reference`).not.toBeNull();
  return reference!;
}

async function expectPersistedArtifact(jobRoot: string, reference: ArtifactReference) {
  const artifactPath = path.join(jobRoot, reference.relativePath);
  const contents = await readFile(artifactPath);
  expect((await stat(artifactPath)).size).toBe(reference.byteSize);
  expect(createHash("sha256").update(contents).digest("hex")).toBe(reference.sha256);
}
