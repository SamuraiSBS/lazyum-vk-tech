import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_RELATIVE_PATHS, ArtifactStore } from "../src/lib/artifact-store";
import { inputSourceArtifact, normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { inputSourceArtifactSchema } from "../src/lib/schemas";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generation input source artifact graph", () => {
  it("persists stable, content-free input refs and links every extracted chunk and fact", async () => {
    const source = { name: "metrics.csv", type: "text/csv", buffer: Buffer.from("metric,value\\ncompleted,42\\n") };
    const first = inputSourceArtifact(source);
    const second = inputSourceArtifact({ ...source, buffer: Buffer.from(source.buffer) });
    expect(second).toEqual(first);

    const store = new ArtifactStore(await testRoot());
    const job = await store.createJob({ name: "template.pptx", buffer: Buffer.from("template") }, [first]);
    const content = await normalizeContent("Показатели пилота", [source]);
    const linked = await store.linkInputSourceArtifacts(job.jobId, content);
    const persisted = linked.inputs.sources[0];
    if (!persisted) throw new Error("Expected an input source artifact");

    expect(linked.inputs.sources).toHaveLength(1);
    expect(persisted).toMatchObject({
      id: content.sourceChunks[0]?.sourceId,
      name: "metrics.csv",
      type: "text/csv",
      origin: "uploaded",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      byteSize: source.buffer.byteLength,
    });
    expect(persisted.sourceChunkIds).toEqual(content.sourceChunks.map((chunk) => chunk.chunkId).sort());
    expect(persisted.factIds).toEqual((content.facts ?? []).map((fact) => fact.factId).sort());
    expect(JSON.stringify(linked)).not.toContain("completed,42");
    expect(JSON.stringify(linked)).not.toContain("Показатели пилота");

    const plan = await createPresentationPlan(content, 5);
    await expect(store.savePlanning(job.jobId, content, plan)).resolves.toMatchObject({
      artifacts: { planning: { relativePath: ARTIFACT_RELATIVE_PATHS.planning } },
    });
    const manifestText = await readFile(store.jobPath(job.jobId, ARTIFACT_RELATIVE_PATHS.manifest), "utf8");
    expect(manifestText).not.toContain("completed,42");
  });

  it("rejects grounded refs that are absent from the published input graph and rejects raw fields", async () => {
    const source = { name: "notes.txt", type: "text/plain", buffer: Buffer.from("Подтверждённый факт для проверки.") };
    const store = new ArtifactStore(await testRoot());
    const job = await store.createJob({ name: "template.pptx", buffer: Buffer.from("template") }, [inputSourceArtifact(source)]);
    const content = await normalizeContent("Проверить связь", [source]);
    await store.linkInputSourceArtifacts(job.jobId, content);
    const plan = await createPresentationPlan(content, 5);
    const grounded = plan.slides.flatMap((slide) => slide.claims ?? []).find((claim) => claim.grounding === "grounded");
    if (!grounded) throw new Error("Expected deterministic plan to contain a grounded claim");
    const danglingPlan = structuredClone(plan);
    const danglingClaim = danglingPlan.slides.flatMap((slide) => slide.claims ?? []).find((claim) => claim.id === grounded.id);
    if (!danglingClaim) throw new Error("Expected cloned grounded claim");
    danglingClaim.sourceRefs.sourceChunkIds = ["chunk-not-published"];

    await expect(store.savePlanning(job.jobId, content, danglingPlan)).rejects.toThrow(
      "grounding_input_artifact_graph_dangling_ref",
    );
    expect(() => inputSourceArtifactSchema.parse({
      ...inputSourceArtifact(source), rawContent: "must-not-persist", prompt: "must-not-persist",
    })).toThrow();
  });
});

async function testRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-input-source-"));
  roots.push(root);
  return root;
}
