import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/request-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/request-guards")>();
  const guard = actual.createProcessRequestGuard({ maxGenerationRequestsPerWindow: 100, maxExportRequestsPerWindow: 100 });
  return { ...actual, acquireHeavyOperation: (kind: "generation" | "export") => guard.acquireHeavyOperation(kind) };
});

import { POST as generate } from "../src/app/api/generate/route";
import { POST as exportPptx } from "../src/app/api/export/route";
import { ArtifactStore, sha256 } from "../src/lib/artifact-store";
import { presentationDocumentSchema, type LayoutVariant } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

const variants: LayoutVariant[] = ["compact", "balanced", "visual"];
const organizerTemplates = [
  "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx",
  "VK Tech шаблон.pptx",
  "Шаблон презентации VK Education.pptx",
] as const;
const xmlParser = new XMLParser({ ignoreAttributes: false });
let artifactRoot: string;
let oldRoot: string | undefined;
let oldProvider: string | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.resolve(process.cwd(), ".data", "vk-crop-published-"));
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

async function croppedTemplate() {
  const archive = await JSZip.loadAsync(await createFixtureTemplate("photo"));
  const media = archive.file(/^ppt\/media\/.*\.png$/u)[0];
  if (!media) throw new Error("Photo fixture has no PNG media");
  archive.file(media.name, validPng());
  const slideFile = "ppt/slides/slide1.xml";
  const slideXml = await archive.file(slideFile)!.async("string");
  const picture = slideXml.match(/<p:pic\b[\s\S]*?<\/p:pic>/u)?.[0];
  if (!picture) throw new Error("Photo fixture has no picture");
  const addCrop = (xml: string, rect: string) => xml.replace(
    /<a:blip\b[^>]*(?:\/>|>[\s\S]*?<\/a:blip>)/u,
    (blip) => blip + rect,
  );
  const first = addCrop(picture, '<a:srcRect l="25125" t="0" r="15000" b="5000"/>');
  archive.file(slideFile, slideXml.replace(picture, first));
  return archive.generateAsync({ type: "nodebuffer" });
}

function validPng() {
  const chunk = (name: string, contents: Buffer) => {
    const payload = Buffer.concat([Buffer.from(name), contents]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(contents.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function entries(value: unknown): Record<string, any>[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as Record<string, any>[];
}

function pngBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(";base64")) throw new Error("Expected base64 image data URL");
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

async function exportedPictures(archive: JSZip, slideIndex: number) {
  const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
  const slideXml = await archive.file(slidePath)?.async("string");
  const relationshipsXml = await archive.file(`ppt/slides/_rels/slide${slideIndex + 1}.xml.rels`)?.async("string");
  if (!slideXml || !relationshipsXml) throw new Error(`Missing slide XML or relationships: ${slidePath}`);
  const slide = xmlParser.parse(slideXml);
  const relationships = xmlParser.parse(relationshipsXml);
  const rels = new Map(entries(relationships.Relationships?.Relationship)
    .map((relationship) => [relationship["@_Id"], relationship["@_Target"]]));
  return Promise.all(entries(slide["p:sld"]?.["p:cSld"]?.["p:spTree"]?.["p:pic"]).map(async (picture) => {
    const blip = picture["p:blipFill"]?.["a:blip"];
    const relationshipId = blip?.["@_r:embed"];
    const target = rels.get(relationshipId);
    if (typeof target !== "string") throw new Error(`Unresolved image relationship ${relationshipId} on ${slidePath}`);
    const mediaPath = path.posix.normalize(path.posix.join("ppt/slides", target.replace(/^\//u, "")));
    const bytes = await archive.file(mediaPath)?.async("nodebuffer");
    if (!bytes) throw new Error(`Missing image media ${mediaPath}`);
    return { crop: picture["p:blipFill"]?.["a:srcRect"] as Record<string, string> | undefined, bytes, mediaPath };
  }));
}

describe("template image crop through ordinary published generation and PPTX", () => {
  it.each(organizerTemplates)("preserves every selected image placement in published variants of %s", async (templateName) => {
    const template = await readFile(path.resolve(process.cwd(), "fixtures", "templates", "organizer", templateName));
    const parsed = await parsePptxTemplate(template, templateName);
    const layouts = new Map(parsed.layouts.map((layout) => [layout.id, layout]));

    const form = new FormData();
    form.set("template", new File([new Uint8Array(template)], templateName, {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.set("brief", templateName === "Шаблон презентации VK Education.pptx"
      ? "Образовательная программа VK: проблема, решение, процесс и результаты"
      : "Платформа VK Tech: вызовы, решение, технология, этапы внедрения и результаты");
    form.set("slideCount", "15");
    const response = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    const store = new ArtifactStore(artifactRoot);
    let imageCount = 0;
    let croppedPlacementCount = 0;

    for (const variant of variants) {
      const document = presentationDocumentSchema.parse(payload.presentations[variant]);
      const selected = document.slides.flatMap((slide, slideIndex) => [...slide.canvas.elements]
        .sort((left, right) => left.zIndex - right.zIndex)
        .filter((element): element is Extract<typeof element, { type: "image" }> =>
          element.type === "image" && Boolean(element.dataUrl))
        .map((element, imageIndex) => {
          const source = layouts.get(slide.templateLayoutId)?.elements.find((candidate) => candidate.id === element.sourceTemplateElementId);
          expect(source, `${templateName}/${variant}: source ${element.sourceTemplateElementId} in ${slide.templateLayoutId}`).toBeDefined();
          expect(source?.type).toBe("image");
          expect(source?.sourceFile, `${templateName}/${variant}: source provenance`).toMatch(/^ppt\//u);
          expect(source?.relationshipId, `${templateName}/${variant}: image relationship`).toBeTruthy();
          expect(source?.imageDataUrl, `${templateName}/${variant}: source bytes`).toBeTruthy();
          expect(element.crop, `${templateName}/${variant}: placement crop`).toEqual(source?.crop);
          expect(pngBytes(element.dataUrl!), `${templateName}/${variant}: canvas bytes`).toEqual(pngBytes(source!.imageDataUrl!));
          return { element, source: source!, slideIndex, imageIndex };
        }));
      imageCount += selected.length;

      const exported = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: payload.jobId, variant }),
      }));
      const bytes = Buffer.from(await exported.arrayBuffer());
      expect(exported.status, `${variant}: ${bytes.toString("utf8").slice(0, 300)}`).toBe(200);
      const exports = (await store.readManifest(payload.jobId)).artifacts.exports;
      const reference = exports && typeof exports === "object" && "compact" in exports
        ? exports[variant].pptx : null;
      if (!reference) throw new Error(`Missing published ${variant} PPTX`);
      expect(reference.byteSize, `${templateName}/${variant}: manifest size`).toBe(bytes.byteLength);
      expect(reference.sha256).toBe(sha256(bytes));
      expect((await store.readPublishedArtifact(payload.jobId, reference.relativePath)).contents).toEqual(bytes);
      const pptx = await JSZip.loadAsync(bytes);
      const slidePictures = new Map(await Promise.all(document.slides.map(async (_, slideIndex) => {
        return [slideIndex, await exportedPictures(pptx, slideIndex)] as const;
      })));
      for (const { element, source, slideIndex, imageIndex } of selected) {
        const picture = slidePictures.get(slideIndex)?.[imageIndex];
        const label = `${templateName}/${variant}: slide ${slideIndex + 1} image ${imageIndex} from ${source.sourceFile}#${source.id}`;
        expect(picture, label).toBeDefined();
        expect(picture?.bytes, `${label}: exported ${picture?.mediaPath} bytes`).toEqual(pngBytes(element.dataUrl!));
        if (source.crop) {
          const expected = {
            "@_l": String(Math.round(source.crop.left * 1000)), "@_t": String(Math.round(source.crop.top * 1000)),
            "@_r": String(Math.round(source.crop.right * 1000)), "@_b": String(Math.round(source.crop.bottom * 1000)),
          };
          expect(picture?.crop, `${label}: exported crop`).toEqual(expected);
          if (Object.values(expected).some((value) => value !== "0")) croppedPlacementCount += 1;
        } else {
          expect(picture?.crop, `${label}: unexpected exported crop`).toBeUndefined();
        }
      }
      for (const [slideIndex, pictures] of slidePictures) {
        const expected = selected.filter((image) => image.slideIndex === slideIndex).length;
        expect(pictures, `${templateName}/${variant}: slide ${slideIndex + 1} native picture count`).toHaveLength(expected);
      }
    }
    expect(imageCount, `${templateName}: no selected template-backed images`).toBeGreaterThan(0);
    expect(croppedPlacementCount, `${templateName}: no nonzero cropped placement reached a published export`).toBeGreaterThan(0);
  }, 600_000);

  it("carries distinct native crops and placement provenance into each published variant", async () => {
    const template = await croppedTemplate();
    const parsed = await parsePptxTemplate(template, "crop-template.pptx");
    const images = parsed.layouts.flatMap((layout) => layout.elements)
      .filter((element) => element.sourceFile === "ppt/slides/slide1.xml" && element.type === "image");
    expect(images.some((image) => image.crop?.left === 25.125)).toBe(true);
    expect(images.some((image) => image.crop?.left === 25.125 && image.imageDataUrl)).toBe(true);

    const form = new FormData();
    form.set("template", new File([new Uint8Array(template)], "crop-template.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.set("brief", "Education template crop preservation");
    form.set("slideCount", "5");
    const response = await generate(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.jobId).toMatch(/^job-/u);
    const store = new ArtifactStore(artifactRoot);

    for (const variant of variants) {
      const document = presentationDocumentSchema.parse(payload.presentations[variant]);
      const images = document.slides.flatMap((slide) => slide.canvas.elements)
        .filter((element) => element.type === "image");
      expect(images.some((image) => image.crop?.left === 25.125 && image.sourceTemplateElementId), variant).toBe(true);

      const exported = await exportPptx(new Request("http://localhost/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: payload.jobId, variant }),
      }));
      const bytes = Buffer.from(await exported.arrayBuffer());
      expect(exported.status, `${variant}: ${bytes.toString("utf8").slice(0, 300)}`).toBe(200);
      const exports = (await store.readManifest(payload.jobId)).artifacts.exports;
      const reference = exports && typeof exports === "object" && "compact" in exports
        ? exports[variant].pptx : null;
      if (!reference) throw new Error(`Missing published ${variant} PPTX`);
      expect(reference.sha256).toBe(sha256(bytes));
      expect((await store.readPublishedArtifact(payload.jobId, reference.relativePath)).contents).toEqual(bytes);
      const pptx = await JSZip.loadAsync(bytes);
      const xmlParts = await Promise.all(pptx.file(/^ppt\/slides\/slide\d+\.xml$/u).map((file) => file.async("string")));
      const outputXml = xmlParts.join("\n");
      expect(outputXml, variant).toContain('<a:srcRect l="25125" t="0" r="15000" b="5000"/>');
    }
  });
});
