import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runAgentDryRun, type AgentDryRunRequest } from "../src/lib/agent-orchestrator";
import { MAX_AGENT_RENDER_ARTIFACT_BYTES, safeArtifactRefSchema } from "../src/lib/agent-contracts";
import { verifyAgentVariantRenders } from "../src/lib/agent-render-evidence";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

function request(runId: string): AgentDryRunRequest {
  const ref = (artifactId: string, kind: "input" | "source" | "render", relativePath: string) => ({
    artifactId, kind, relativePath, sha256: "a".repeat(64), byteSize: 24,
  });
  return {
    runId,
    brief: "Проверяемая презентация для команды",
    slideCount: 5,
    templateArtifactRef: ref("artifact-input-template", "input", "inputs/template.json"),
    renderEvidenceRefs: [ref("artifact-render-template", "render", "render-evidence/template-1.png")],
    layouts: [
      { id: "layout-title", composition: "title", textSlots: 2, visualSlots: 0, cardCount: 0 },
      { id: "layout-cards", composition: "cards", textSlots: 4, visualSlots: 1, cardCount: 3 },
    ],
    designTokens: { colors: ["#112233"], headingFonts: ["Arial"], bodyFonts: ["Arial"] },
    sourceArtifacts: [{
      artifact: ref("artifact-source-1", "source", "inputs/source-1.json"),
      sourceId: "source-1", sourceChunkIds: ["chunk-1"], factIds: ["fact-1"],
    }],
    sourceChunks: [{ chunkId: "chunk-1", sourceId: "source-1", excerpt: "Проверяемый факт", precision: "exact" }],
    fatalAudit: false,
  };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function addLargeTextChunk(png: Buffer): Buffer {
  const iend = Buffer.from("0000000049454e44ae426082", "hex");
  expect(png.subarray(-iend.length).equals(iend)).toBe(true);
  const data = Buffer.concat([Buffer.from("Comment\0"), Buffer.alloc(2_000_001, 0x78)]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return Buffer.concat([png.subarray(0, -iend.length), chunk, iend]);
}

function corruptIdatWithValidCrc(png: Buffer): Buffer {
  const altered = Buffer.from(png);
  let offset = 8;
  while (offset + 12 <= altered.length) {
    const length = altered.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > altered.length) break;
    if (altered.toString("ascii", offset + 4, offset + 8) === "IDAT" && length > 2) {
      altered[offset + 8] ^= 0xff; // Damage the zlib header, leaving PNG framing valid.
      altered.writeUInt32BE(crc32(altered.subarray(offset + 4, end - 4)), end - 4);
      return altered;
    }
    offset = end;
  }
  throw new Error("Expected a nonempty IDAT chunk");
}

describe("local agent render evidence", () => {
  it("persists three real five-page PPTX/PDF/PNG sets and binds visual critics to verified pages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-render-evidence-"));
    dirs.push(root);
    const result = await runAgentDryRun(request("local-render-complete"), {
      renderEvidenceRoot: root,
      onRenderEvidencePersisted: async (evidence) => {
        const page = evidence.variants.compact!.pages[0];
        const pagePath = path.join(root, evidence.runId, page.relativePath);
        const enlarged = addLargeTextChunk(await readFile(pagePath));
        expect(enlarged.length).toBeGreaterThan(2_000_000);
        expect(enlarged.length).toBeLessThanOrEqual(MAX_AGENT_RENDER_ARTIFACT_BYTES);
        await writeFile(pagePath, enlarged);
        page.byteSize = enlarged.length;
        page.sha256 = createHash("sha256").update(enlarged).digest("hex");
        await writeFile(path.join(root, evidence.runId, "render-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
      },
    });
    expect(result.manifest.status).toBe("completed");
    expect(result.manifest.mode).toBe("local-render");
    expect(result.manifest.filesystemMutationAuthority).toBe(true);
    const evidence = result.renderEvidence!;
    expect(evidence.variants.compact!.pages[0].byteSize).toBeGreaterThan(2_000_000);
    expect(await verifyAgentVariantRenders(root, evidence)).toEqual(evidence);
    for (const variant of ["compact", "balanced", "visual"] as const) {
      expect(evidence.variants[variant]?.pages).toHaveLength(5);
      const visual = result.manifest.graph.artifacts.find((artifact) => artifact.ref.artifactId === `artifact-critiques-${variant}-visual`);
      expect(visual?.parentRefs.filter((ref) => ref.kind === "render")).toHaveLength(5);
      if (variant === "compact") expect(visual?.parentRefs.find((ref) => ref.artifactId === "artifact-render-evidence-compact-slide-1")?.byteSize).toBeGreaterThan(2_000_000);
      const pdf = await readFile(path.join(root, evidence.runId, evidence.variants[variant]!.pdf.relativePath));
      expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    }
    const serialized = JSON.stringify(result.renderEvidence);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("soffice");
    const first = evidence.variants.compact!.pages[0];
    const firstPath = path.join(root, evidence.runId, first.relativePath);
    const original = await readFile(firstPath);
    await writeFile(firstPath, Buffer.concat([original, Buffer.from([0])]));
    await expect(verifyAgentVariantRenders(root, evidence)).rejects.toThrow("reference mismatch");
    const malformed = Buffer.from(original);
    malformed[29] ^= 1; // Corrupt the IHDR CRC while preserving the PNG signature.
    first.sha256 = createHash("sha256").update(malformed).digest("hex");
    await writeFile(firstPath, malformed);
    await writeFile(path.join(root, evidence.runId, "render-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await expect(verifyAgentVariantRenders(root, evidence)).rejects.toThrow("Invalid PNG artifact");
    first.sha256 = createHash("sha256").update(original).digest("hex");
    await writeFile(path.join(root, evidence.runId, "render-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await writeFile(firstPath, original);
    await unlink(firstPath);
    await expect(verifyAgentVariantRenders(root, evidence)).rejects.toThrow();
  }, 600_000);

  it("keeps the 2 MB limit for non-page refs and rejects render pages above 32 MB", () => {
    const base = { artifactId: "artifact-page", kind: "render", relativePath: "render-evidence/compact/slide-1.png", sha256: "a".repeat(64), byteSize: 2_000_001 };
    expect(safeArtifactRefSchema.safeParse(base).success).toBe(true);
    expect(safeArtifactRefSchema.safeParse({ ...base, kind: "input" }).success).toBe(false);
    expect(safeArtifactRefSchema.safeParse({ ...base, relativePath: "render-evidence/template-1.png" }).success).toBe(false);
    expect(safeArtifactRefSchema.safeParse({ ...base, byteSize: MAX_AGENT_RENDER_ARTIFACT_BYTES + 1 }).success).toBe(false);
  });

  it("stops before visual critique when a persisted page is altered", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-render-evidence-"));
    dirs.push(root);
    await expect(runAgentDryRun(request("local-render-tamper"), {
      renderEvidenceRoot: root,
      onRenderEvidencePersisted: async (evidence) => {
        const page = evidence.variants.compact!.pages[0];
        await writeFile(path.join(root, evidence.runId, page.relativePath), Buffer.from("altered"));
      },
    })).rejects.toThrow("reference mismatch");
  }, 600_000);

  it("rejects invalid IDAT before visual critique even when CRC and all references are updated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-render-evidence-"));
    dirs.push(root);
    await expect(runAgentDryRun(request("local-render-invalid-idat"), {
      renderEvidenceRoot: root,
      onRenderEvidencePersisted: async (evidence) => {
        const page = evidence.variants.compact!.pages[0];
        const pagePath = path.join(root, evidence.runId, page.relativePath);
        const altered = corruptIdatWithValidCrc(await readFile(pagePath));
        await writeFile(pagePath, altered);
        page.byteSize = altered.length;
        page.sha256 = createHash("sha256").update(altered).digest("hex");
        await writeFile(path.join(root, evidence.runId, "render-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
      },
    })).rejects.toThrow("Invalid PNG artifact");
  }, 600_000);
});
