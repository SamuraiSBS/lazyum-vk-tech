import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/request-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/request-guards")>();
  const guard = actual.createProcessRequestGuard({ maxGenerationRequestsPerWindow: 100, maxExportRequestsPerWindow: 100 });
  return { ...actual, acquireHeavyOperation: (kind: "generation" | "export") => guard.acquireHeavyOperation(kind) };
});

import { POST as generate } from "../src/app/api/generate/route";
import { POST as exportPptx } from "../src/app/api/export/route";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { auditReportSchema, generationPlanningSchema, presentationDocumentSchema } from "../src/lib/schemas";

const templateName = "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx";
const reviewRoot = path.resolve(process.cwd(), ".agent-state", "tmp", "workspace-powerpoint-20260928");

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("ordinary published WorkSpace PowerPoint review artifact", () => {
  it("publishes an audited ten-slide Visual PPTX and retains exact review evidence", async () => {
    expect(process.env.NODE_OPTIONS).toMatch(/(?:^|\s)--max-old-space-size=8192(?:\s|$)/u);
    await mkdir(reviewRoot, { recursive: true });
    const artifactRoot = path.join(reviewRoot, "artifacts");
    const priorRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
    const priorProvider = process.env.VK_HACKATHON_LLM_PROVIDER;
    process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
    process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
    try {
      const template = await readFile(new URL(`../fixtures/templates/organizer/${templateName}`, import.meta.url));
      const form = new FormData();
      form.set("template", new File([new Uint8Array(template)], templateName, {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }));
      form.set("brief", "VK Tech: обзор решения для команды");
      form.set("materials", new File([
        "Команда согласует решения быстрее. Внедрение начинается с пилота. Метрики включают время согласования и качество результата.",
      ], "brief.txt", { type: "text/plain" }));
      form.set("slideCount", "10");
      const response = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
      const payload = await response.json();
      expect(response.status, payload.error ?? "generation failed").toBe(200);
      const jobId: string = payload.jobId;
      expect(jobId).toMatch(/^job-/u);
      delete payload.presentations;
      delete payload.audits;
      const store = new ArtifactStore(artifactRoot);
      const manifest = await store.readManifest(jobId);
      expect(manifest.status).toBe("ready");
      const planRef = manifest.artifacts.planning!;
      const planBytes = (await store.readPublishedArtifact(jobId, planRef.relativePath)).contents;
      expect(sha256(planBytes)).toBe(planRef.sha256);
      const plan = generationPlanningSchema.parse(JSON.parse(planBytes.toString("utf8"))).presentationPlan;
      expect(plan.slides).toHaveLength(10);
      const variantRefs = manifest.artifacts.variants;
      const auditRefs = manifest.artifacts.audit;
      if (!variantRefs || !("visual" in variantRefs) || !auditRefs || !("visual" in auditRefs)) {
        throw new Error("Published variant or audit references are missing");
      }
      const variantRef = variantRefs.visual;
      const auditRef = auditRefs.visual;
      expect(variantRef).toBeDefined();
      expect(auditRef).toBeDefined();
      const variantBytes = (await store.readPublishedArtifact(jobId, variantRef!.relativePath)).contents;
      const auditBytes = (await store.readPublishedArtifact(jobId, auditRef!.relativePath)).contents;
      expect(sha256(variantBytes)).toBe(variantRef!.sha256);
      expect(sha256(auditBytes)).toBe(auditRef!.sha256);
      const document = presentationDocumentSchema.parse(JSON.parse(variantBytes.toString("utf8")));
      const audit = auditReportSchema.parse(JSON.parse(auditBytes.toString("utf8")));
      expect(document.slides).toHaveLength(10);
      expect(document.slides.map((slide) => slide.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(document.slides.map((slide) => slide.purpose)).toEqual(plan.slides.map((slide) => slide.purpose));
      expect(audit.passed).toBe(true);
      expect(audit.slides.flatMap((slide) => slide.issues).filter((issue) => issue.severity === "error")).toEqual([]);

      const exported = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, variant: "visual" }),
      }));
      const downloaded = Buffer.from(await exported.arrayBuffer());
      expect(exported.status, exported.status === 200 ? "PPTX" : downloaded.toString("utf8").slice(0, 300)).toBe(200);
      const exports = (await store.readManifest(jobId)).artifacts.exports;
      const exportRef = exports && typeof exports === "object" && "visual" in exports ? exports.visual.pptx : null;
      expect(exportRef).toBeDefined();
      expect(exportRef!.byteSize).toBe(downloaded.byteLength);
      expect(exportRef!.sha256).toBe(sha256(downloaded));
      const published = (await store.readPublishedArtifact(jobId, exportRef!.relativePath)).contents;
      expect(published).toEqual(downloaded);
      const pptx = await JSZip.loadAsync(published);
      expect(pptx.file(/^ppt\/slides\/slide\d+\.xml$/u)).toHaveLength(10);
      const copyPath = path.join(reviewRoot, `${jobId}-visual-published.pptx`);
      await copyFile(store.jobPath(jobId, exportRef!.relativePath), copyPath);
      expect(digest(await readFile(copyPath))).toBe(exportRef!.sha256);
      const evidence = {
        jobId, templateName, slideCount: document.slides.length,
        plan: { path: planRef.relativePath, sha256: planRef.sha256 },
        visualVariant: { path: variantRef!.relativePath, sha256: variantRef!.sha256 },
        visualAudit: { path: auditRef!.relativePath, sha256: auditRef!.sha256, passed: audit.passed },
        publishedExport: { path: exportRef!.relativePath, byteSize: exportRef!.byteSize, sha256: exportRef!.sha256 },
        reviewCopy: { path: copyPath, sha256: digest(await readFile(copyPath)) },
        slides: document.slides.map((slide) => ({ order: slide.order, purpose: slide.purpose, title: slide.title })),
      };
      const evidencePath = path.join(reviewRoot, `${jobId}-evidence.json`);
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
      process.stdout.write(`WORKSPACE_POWERPOINT_EVIDENCE=${evidencePath}\nWORKSPACE_POWERPOINT_PPTX=${copyPath}\n`);
    } finally {
      if (priorRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
      else process.env.VK_HACKATHON_ARTIFACT_ROOT = priorRoot;
      if (priorProvider === undefined) delete process.env.VK_HACKATHON_LLM_PROVIDER;
      else process.env.VK_HACKATHON_LLM_PROVIDER = priorProvider;
    }
  }, 600_000);
});
