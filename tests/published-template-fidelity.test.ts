import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/request-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/request-guards")>();
  const guard = actual.createProcessRequestGuard({ maxGenerationRequestsPerWindow: 100, maxExportRequestsPerWindow: 100 });
  return { ...actual, acquireHeavyOperation: (kind: "generation" | "export") => guard.acquireHeavyOperation(kind) };
});

import { POST as generate } from "../src/app/api/generate/route";
import { POST as exportPptx } from "../src/app/api/export/route";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { auditReportSchema, designSystemSchema, generationPlanningSchema, presentationDocumentSchema, type CanvasElement, type LayoutVariant } from "../src/lib/schemas";

const templates = [
  "VK Tech шаблон.pptx",
  "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx",
  "Шаблон презентации VK Education.pptx",
] as const;
const variants = ["compact", "balanced", "visual"] as const satisfies readonly LayoutVariant[];
const slideCount = 5;
type CanvasImage = Extract<CanvasElement, { type: "image" }>;
let artifactRoot: string;
let oldRoot: string | undefined;
let oldProvider: string | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.resolve(process.cwd(), ".data", "vk-published-fidelity-"));
  oldRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
  oldProvider = process.env.VK_HACKATHON_LLM_PROVIDER;
  process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
  process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
});

afterAll(async () => {
  if (oldRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
  else process.env.VK_HACKATHON_ARTIFACT_ROOT = oldRoot;
  if (oldProvider === undefined) delete process.env.VK_HACKATHON_LLM_PROVIDER;
  else process.env.VK_HACKATHON_LLM_PROVIDER = oldProvider;
  await rm(artifactRoot, { recursive: true, force: true });
});

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

function xmlText(xml: string): string {
  return Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu), (match) => match[1]!
    .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&apos;/gu, "'"))
    .join(" ");
}

function pictures(xml: string): string[] {
  return Array.from(xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gu), (match) => match[0]);
}

function relationshipTargets(xml: string): Map<string, string> {
  return new Map(Array.from(xml.matchAll(/<Relationship\b[^>]*>/gu), ([entry]) => {
    const id = entry.match(/\bId="([^"]+)"/u)?.[1];
    const target = entry.match(/\bTarget="([^"]+)"/u)?.[1];
    if (!id || !target) throw new Error("Malformed PPTX image relationship");
    return [id, target];
  }));
}

describe("ordinary published template fidelity", () => {
  const cases = templates.flatMap((name) => variants.map((variant) => [name, variant] as const));
  it.each(cases)("preserves role order, planned text, source artwork bytes and placement crops: %s / %s", async (name, variant) => {

      const template = await readFile(new URL(`../fixtures/templates/organizer/${name}`, import.meta.url));
      const form = new FormData();
      form.set("template", new File([new Uint8Array(template)], name, {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }));
      form.set("brief", "VK Tech: обзор решения для команды");
      form.set("materials", new File([
        "Команда согласует решения быстрее. Внедрение начинается с пилота. Метрики включают время согласования и качество результата.",
      ], "brief.txt", { type: "text/plain" }));
      form.set("slideCount", String(slideCount));
      const generated = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
      const generatedPayload = await generated.json();
      expect(generated.status, `${name}: ${generatedPayload.error ?? "generation failed"}`).toBe(200);
      expect(generatedPayload.jobId, name).toMatch(/^job-/u);
      const jobId: string = generatedPayload.jobId;
      // Response variants contain repeated base64 artwork; inspect the durable artifacts below.
      delete generatedPayload.presentations;
      delete generatedPayload.audits;
      const store = new ArtifactStore(artifactRoot);
      const manifest = await store.readManifest(jobId);
      expect(manifest.status, name).toBe("ready");
      const planningRef = manifest.artifacts.planning!;
      const planningBytes = (await store.readPublishedArtifact(jobId, planningRef.relativePath)).contents;
      expect(sha256(planningBytes), `${name}: persisted plan hash`).toBe(planningRef.sha256);
      const plan = generationPlanningSchema.parse(JSON.parse(planningBytes.toString("utf8"))).presentationPlan;
      const parsedRef = manifest.artifacts.parsed!;
      const parsedBytes = (await store.readPublishedArtifact(jobId, parsedRef.relativePath)).contents;
      expect(sha256(parsedBytes), `${name}: persisted design hash`).toBe(parsedRef.sha256);
      const design = designSystemSchema.parse(JSON.parse(parsedBytes.toString("utf8")));
      expect(plan.slides, name).toHaveLength(slideCount);
      expect(new Set(plan.slides.map((slide) => slide.purpose)).size, name).toBeGreaterThan(4);
      const variantRefs = manifest.artifacts.variants;
      const auditRefs = manifest.artifacts.audit;
      if (!variantRefs || typeof variantRefs !== "object" || !("compact" in variantRefs)
        || !auditRefs || typeof auditRefs !== "object" || !("compact" in auditRefs)) {
        throw new Error(`${name}: missing published variant or audit references`);
      }
        const label = `${name} / ${variant}`;
        const variantRef = variantRefs[variant]!;
        const variantBytes = (await store.readPublishedArtifact(jobId, variantRef.relativePath)).contents;
        expect(sha256(variantBytes), `${label} persisted variant hash`).toBe(variantRef.sha256);
        const document = presentationDocumentSchema.parse(JSON.parse(variantBytes.toString("utf8")));
        expect(document.slides, label).toHaveLength(slideCount);
        expect(new Set(document.slides.map((slide) => slide.templateLayoutId)).size,
          `${label} source layout diversity`).toBeGreaterThan(1);
        expect(document.slides.map((slide) => slide.purpose), label).toEqual(plan.slides.map((slide) => slide.purpose));
        expect(document.slides.map((slide) => slide.title), label).toEqual(plan.slides.map((slide) => slide.title));
        const auditRef = auditRefs[variant]!;
        const auditBytes = (await store.readPublishedArtifact(jobId, auditRef.relativePath)).contents;
        expect(sha256(auditBytes), `${label} persisted audit hash`).toBe(auditRef.sha256);
        const audit = auditReportSchema.parse(JSON.parse(auditBytes.toString("utf8")));
        expect(audit.passed, `${label} saved audit`).toBe(true);
        expect(audit.slides.flatMap((slide) => slide.issues).filter((issue) => issue.severity === "error"), label).toEqual([]);

        const exported = await exportPptx(new Request("http://localhost/api/export", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, variant }),
        }));
        const bytes = Buffer.from(await exported.arrayBuffer());
        expect(exported.status, `${label}: ${exported.status === 200 ? "PPTX" : bytes.toString("utf8").slice(0, 300)}`).toBe(200);
        const exports = (await store.readManifest(jobId)).artifacts.exports;
        const exportRef = exports && typeof exports === "object" && "compact" in exports
          ? exports[variant].pptx : null;
        expect(exportRef, `${label} persisted export`).toBeDefined();
        expect(exportRef!.byteSize, `${label} export size`).toBe(bytes.byteLength);
        expect(exportRef!.sha256, `${label} export hash`).toBe(sha256(bytes));
        expect((await store.readPublishedArtifact(jobId, exportRef!.relativePath)).contents,
          `${label} published PPTX bytes`).toEqual(bytes);
        const archive = await JSZip.loadAsync(bytes);
        expect(Object.keys(archive.files).filter((file) => /^ppt\/slides\/slide\d+\.xml$/u.test(file)), label).toHaveLength(slideCount);
        let checkedArtwork = 0;
        let checkedCrops = 0;
        for (const [index, slide] of document.slides.entries()) {
          const source = design.layouts.find((layout) => layout.id === slide.templateLayoutId);
          expect(source, `${label} slide ${index + 1} source composition`).toBeDefined();
          expect(slide.canvas.background, `${label} slide ${index + 1} source background`).toBe(source!.background);
          expect(slide.order, `${label} slide ${index + 1} order`).toBe(index + 1);
          const slidePath = `ppt/slides/slide${index + 1}.xml`;
          const xml = await archive.file(slidePath)?.async("string");
          expect(xml, `${label} slide ${index + 1} published XML`).toBeDefined();
          const publishedText = normalize(xmlText(xml!));
          for (const planned of [plan.slides[index]!.title, ...plan.slides[index]!.content]) {
            expect(publishedText, `${label} slide ${index + 1} missing planned text: ${planned}`).toContain(normalize(planned));
          }
          const images = [...slide.canvas.elements]
            .sort((left, right) => left.zIndex - right.zIndex)
            .filter((element): element is CanvasImage => element.type === "image" && Boolean(element.dataUrl));
          const nativeImages = pictures(xml!);
          expect(nativeImages, `${label} slide ${index + 1} image count`).toHaveLength(images.length);
          const rels = relationshipTargets(await archive.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`)?.async("string") || "");
          for (const [imageIndex, image] of images.entries()) {
            const placement = `${label} slide ${index + 1} image ${imageIndex + 1}`;
            const sourceImage = source!.elements.find((element) => element.id === image.sourceTemplateElementId);
            expect(sourceImage?.type, `${placement} source`).toBe("image");
            expect(image.dataUrl, `${placement} source bytes`).toBe(sourceImage?.imageDataUrl);
            const sourceCrop = sourceImage?.type === "image" ? sourceImage.crop : undefined;
            expect(image.crop, `${placement} source crop`).toEqual(sourceCrop);
            const native = nativeImages[imageIndex]!;
            const embed = native.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/u)?.[1];
            expect(embed, `${placement} relationship`).toBeDefined();
            const target = rels.get(embed!);
            expect(target, `${placement} target`).toBeDefined();
            const mediaPath = path.posix.normalize(path.posix.join("ppt/slides", target!));
            const publishedBytes = await archive.file(mediaPath)?.async("nodebuffer");
            expect(publishedBytes, `${placement} media`).toBeDefined();
            const sourceBytes = Buffer.from(image.dataUrl!.split(",", 2)[1]!, "base64");
            expect(hash(publishedBytes!), `${placement} SHA-256`).toBe(hash(sourceBytes));
            checkedArtwork++;
            const crop = image.crop;
            const nativeCrop = native.match(/<a:srcRect\b([^>]*)\/>/u)?.[1];
            if (crop) {
              expect(nativeCrop, `${placement} crop`).toBeDefined();
              for (const side of ["left", "top", "right", "bottom"] as const) {
                const attribute = { left: "l", top: "t", right: "r", bottom: "b" }[side];
                expect(Number(nativeCrop!.match(new RegExp(`\\b${attribute}="(-?\\d+)"`, "u"))?.[1]), `${placement} ${side}`)
                  .toBe(Math.round(crop[side] * 1000));
              }
              checkedCrops++;
            } else {
              expect(nativeCrop, `${placement} unexpected crop`).toBeUndefined();
            }
          }
        }
        expect(checkedArtwork, `${label} no source artwork exercised`).toBeGreaterThan(0);
        expect(checkedCrops, `${label}: selected composition did not exercise source image crops`).toBeGreaterThan(0);
  }, 600_000);
});
