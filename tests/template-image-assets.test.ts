import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { POST as generate } from "../src/app/api/generate/route";
import { POST as exportPptx } from "../src/app/api/export/route";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const templates = [
  "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx",
  "VK Tech шаблон.pptx",
  "Шаблон презентации VK Education.pptx",
];

describe("template image artifact graph", () => {
  it("rejects reopen and publication when a generated job image is tampered", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vk-image-generation-"));
    roots.push(root);
    const previousRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
    const previousProvider = process.env.VK_HACKATHON_LLM_PROVIDER;
    process.env.VK_HACKATHON_ARTIFACT_ROOT = root;
    process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
    try {
      const template = await readFile(path.resolve("fixtures", "templates", "organizer", "Шаблон презентации VK Education.pptx"));
      const form = new FormData();
      form.set("template", new File([new Uint8Array(template)], "education.pptx"));
      form.set("brief", "Образовательная программа VK: проблема, решение, процесс и результаты");
      form.set("slideCount", "5");
      const response = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(200);
      const store = new ArtifactStore(root);
      const manifest = await store.readManifest(payload.jobId);
      expect(manifest.artifacts.templateImages.length).toBeGreaterThan(0);
      await expect(store.readPublishedGenerationJob(payload.jobId)).resolves.toBeDefined();
      const manifestPath = store.jobPath(payload.jobId, "manifest.json");
      const savedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
      delete savedManifest.artifacts.templateImages;
      await writeFile(manifestPath, JSON.stringify(savedManifest));
      await expect(store.readPublishedGenerationJob(payload.jobId)).rejects.toThrow();
      await writeFile(manifestPath, JSON.stringify({ ...savedManifest, version: 1 }));
      await expect(store.readPublishedGenerationJob(payload.jobId)).resolves.toBeDefined();
      const legacyExport = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: payload.jobId, variant: "balanced" }),
      }));
      expect(legacyExport.status).toBe(200);
      await writeFile(manifestPath, JSON.stringify(manifest));
      const target = manifest.artifacts.templateImages[0];
      await writeFile(store.jobPath(payload.jobId, target.relativePath), Buffer.from("tampered"));
      await expect(store.readPublishedGenerationJob(payload.jobId)).rejects.toThrow();
      const exported = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: payload.jobId, variant: "balanced" }),
      }));
      expect(exported.status).not.toBe(200);
    } finally {
      if (previousRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
      else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousRoot;
      if (previousProvider === undefined) delete process.env.VK_HACKATHON_LLM_PROVIDER;
      else process.env.VK_HACKATHON_LLM_PROVIDER = previousProvider;
    }
  }, 120_000);

  it("publishes selected client-conference images as native PPTX objects in a bounded five-slide job", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vk-client-image-export-"));
    roots.push(root);
    const previousRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
    const previousProvider = process.env.VK_HACKATHON_LLM_PROVIDER;
    process.env.VK_HACKATHON_ARTIFACT_ROOT = root;
    process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
    try {
      const name = templates[0];
      const template = await readFile(path.resolve("fixtures", "templates", "organizer", name));
      const form = new FormData();
      form.set("template", new File([new Uint8Array(template)], name));
      form.set("brief", "Клиентская конференция VK Workspace: проблема, решение, сценарий и результат");
      form.set("slideCount", "5");
      const response = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(200);
      const store = new ArtifactStore(root);
      const published = await store.readPublishedGenerationJob(payload.jobId);
      const design = published.designSystem;
      const document = published.presentations.balanced;
      expect(document.slides).toHaveLength(5);
      const exported = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: payload.jobId, variant: "balanced" }),
      }));
      expect(exported.status).toBe(200);
      const pptx = await JSZip.loadAsync(Buffer.from(await exported.arrayBuffer()));
      const parser = new XMLParser({ ignoreAttributes: false });
      const many = (value: unknown): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
      let selected = 0;
      for (const [index, slide] of document.slides.entries()) {
        const xml = await pptx.file(`ppt/slides/slide${index + 1}.xml`)?.async("string");
        const relsXml = await pptx.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`)?.async("string");
        expect(xml && relsXml).toBeTruthy();
        const tree = parser.parse(xml!)["p:sld"]["p:cSld"]["p:spTree"];
        const pictures = many(tree["p:pic"]);
        const relationships = many(parser.parse(relsXml!).Relationships.Relationship);
        const rels = new Map(relationships.map((rel) => [rel["@_Id"], rel["@_Target"]]));
        const images = slide.canvas.elements.filter((element) => element.type === "image" && element.sourceTemplateElementId);
        expect(pictures).toHaveLength(images.length);
        expect(many(tree["p:sp"]).length).toBeGreaterThan(0);
        for (const [pictureIndex, element] of images.entries()) {
          if (element.type !== "image") continue;
          const source = design.layouts.find((layout) => layout.id === slide.templateLayoutId)?.elements
            .find((candidate) => candidate.id === element.sourceTemplateElementId);
          expect(source?.type).toBe("image");
          expect(element.crop).toEqual(source?.crop);
          const picture = pictures[pictureIndex];
          const target = rels.get(picture["p:blipFill"]["a:blip"]["@_r:embed"]);
          const mediaPath = path.posix.normalize(path.posix.join("ppt/slides", String(target)));
          const bytes = await pptx.file(mediaPath)?.async("nodebuffer");
          expect(bytes).toEqual(Buffer.from(element.dataUrl!.split(",")[1], "base64"));
          expect(bytes).toEqual(Buffer.from(source!.imageDataUrl!.split(",")[1], "base64"));
          const crop = picture["p:blipFill"]["a:srcRect"];
          if (source?.crop) expect(crop).toEqual({
            "@_l": String(Math.round(source.crop.left * 1000)),
            "@_t": String(Math.round(source.crop.top * 1000)),
            "@_r": String(Math.round(source.crop.right * 1000)),
            "@_b": String(Math.round(source.crop.bottom * 1000)),
          });
          else expect(crop).toBeUndefined();
          selected += 1;
        }
      }
      expect(selected).toBeGreaterThan(0);

      // Duplicate source IDs across layouts must not let a slide borrow the
      // original layout's bytes/crop when its selected layout says otherwise.
      const changed = structuredClone(design);
      const changedDocument = structuredClone(document);
      const slide = changedDocument.slides.find((item) => item.canvas.elements.some((element) =>
        element.type === "image" && element.sourceTemplateElementId));
      expect(slide).toBeDefined();
      const sourceLayout = changed.layouts.find((layout) => layout.id === slide!.templateLayoutId)!;
      const duplicate = structuredClone(sourceLayout);
      duplicate.id += "-duplicate-image-ids";
      duplicate.elements = duplicate.elements.filter((element) => element.type === "image");
      const source = duplicate.elements.find((element) => element.id === slide!.canvas.elements.find((candidate) =>
        candidate.type === "image" && candidate.sourceTemplateElementId)?.sourceTemplateElementId)!;
      source.crop = { left: source.crop?.left === 10 ? 15 : 10, top: 0, right: 0, bottom: 0 };
      changed.layouts.push(duplicate);
      const manifest = await store.readManifest(payload.jobId);
      for (const asset of manifest.artifacts.templateImages) {
        asset.placements = changed.layouts.flatMap((layout) => layout.elements
          .filter((element) => element.type === "image" && element.sourceFile === asset.sourceFile
            && element.relationshipId === asset.relationshipId)
          .map((element) => ({ layoutId: layout.id, sourceElementId: element.id,
            ...(element.crop ? { crop: element.crop } : {}) })));
      }
      const parsedBytes = Buffer.from(JSON.stringify(changed));
      await writeFile(store.jobPath(payload.jobId, manifest.artifacts.parsed!.relativePath), parsedBytes);
      manifest.artifacts.parsed!.sha256 = sha256(parsedBytes);
      manifest.artifacts.parsed!.byteSize = parsedBytes.length;
      await writeFile(store.jobPath(payload.jobId, "manifest.json"), JSON.stringify(manifest));
      slide!.templateLayoutId = duplicate.id;
      await store.saveVariant(payload.jobId, "balanced", changedDocument);
      await expect(store.readPublishedVariantPresentation(payload.jobId, "balanced")).rejects.toThrow();
    } finally {
      if (previousRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
      else process.env.VK_HACKATHON_ARTIFACT_ROOT = previousRoot;
      if (previousProvider === undefined) delete process.env.VK_HACKATHON_LLM_PROVIDER;
      else process.env.VK_HACKATHON_LLM_PROVIDER = previousProvider;
    }
  }, 180_000);

  it.each(templates)("persists exact relationship media and fails closed on tamper: %s", async (name) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vk-image-assets-"));
    roots.push(root);
    const store = new ArtifactStore(root);
    const template = await readFile(path.resolve("fixtures", "templates", "organizer", name));
    const job = await store.createJob({ name, buffer: template });
    const design = await parsePptxTemplate(template, name);
    const manifest = await store.saveDesignSystem(job.jobId, design);
    const allowed = design.imageAssets?.filter((item) => item.allowed) ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    expect(manifest.artifacts.templateImages).toHaveLength(allowed.length);
    for (const asset of manifest.artifacts.templateImages) {
      expect(asset.relativePath).toMatch(/^parsed\/template-images\/[0-9a-f]{64}\.(?:png|jpg|gif|svg)$/);
      expect(asset.target).toMatch(/^ppt\/media\//);
      expect(asset.sources.length).toBeGreaterThan(0);
      const placements = design.layouts.flatMap((layout) => layout.elements
        .filter((element) => element.type === "image" && element.sourceFile === asset.sourceFile
          && element.relationshipId === asset.relationshipId)
        .map((element) => ({ layoutId: layout.id, sourceElementId: element.id,
          ...(element.rotation ? { rotation: element.rotation } : {}),
          ...(element.crop ? { crop: element.crop } : {}) })));
      expect(asset.placements).toEqual(placements);
      const bytes = (await store.readPublishedArtifact(job.jobId, asset.relativePath)).contents;
      expect(sha256(bytes)).toBe(asset.sha256);
      expect(bytes.length).toBe(asset.byteSize);
    }
    const first = manifest.artifacts.templateImages[0];
    await writeFile(store.jobPath(job.jobId, first.relativePath), Buffer.from("tampered"));
    await expect(store.readPublishedArtifact(job.jobId, first.relativePath)).rejects.toThrow();
    await expect(store.markReady(job.jobId)).rejects.toThrow();
    expect((await store.readManifest(job.jobId)).status).not.toBe("ready");
  }, 120_000);
});
