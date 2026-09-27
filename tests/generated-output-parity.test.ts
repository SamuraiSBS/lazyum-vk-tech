import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { createPresentationPptx } from "../src/lib/pptx-export";
import {
  renderPptxToPngs,
  runBoundedProcess,
} from "../src/lib/render-evidence";
import { renderPresentation } from "../src/lib/renderer";
import {
  presentationDocumentSchema,
  type CanvasElement,
  type LayoutVariant,
  type PresentationDocument,
} from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

/**
 * This is a structural export/render preflight, not a visual-fidelity or pixel-parity proof.
 * Geometry is compared in the canvas' 96-DPI pixel coordinate space after the PPTX
 * inch -> OOXML EMU round trip. The tolerance is intentionally explicit and reported
 * in the test diagnostics.
 */
const GEOMETRY_TOLERANCE_PX = 1;
const SLIDE_SIZE_TOLERANCE_PX = 1;
const EMU_PER_PIXEL = 9_525;
const POINTS_PER_PIXEL = 72 / 96;
const RENDER_WIDTH_PX = 900;
const RENDER_JOB_TIMEOUT_MS = 900_000;
const VARIANTS = ["compact", "balanced", "visual"] as const;
const ORGANIZER_TEMPLATES = [
  "VK Tech шаблон.pptx",
  "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx",
  "Шаблон презентации VK Education.pptx",
] as const;
const GENERATED_PARITY_TASK_ID = "VK-P0-GENERATED-PARITY-3T-20260921";
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  trimValues: false,
});

type XmlRecord = Record<string, unknown>;
type NativeKind = "text" | "shape" | "image";

type NativeObject = {
  kind: NativeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  runTexts: string[];
  xmlName: string;
  nativeRelationshipId?: string;
};

type NativeObjectCounts = Record<NativeKind, number>;

type TemplateBackedImageEvidence = {
  slideNumber: number;
  elementId: string;
  templateElementId: string;
  templateLayoutId: string;
  geometry: { x: number; y: number; w: number; h: number };
  sourceFile: string;
  relationshipId: string;
  assetTarget: string;
  assetSha256: string;
  assetSources: Array<{
    sourceFile: string;
    xmlPath?: string;
    elementId?: string;
    relationshipId?: string;
  }>;
  nativeRelationshipId?: string;
};

type NativeParityEvidence = {
  nativeObjectCounts: NativeObjectCounts;
  templateBackedImages: TemplateBackedImageEvidence[];
  generatedFullSlideRasterImage: boolean;
};

type ParsedPptx = {
  slideSize: { width: number; height: number };
  slides: Array<{ objects: NativeObject[] }>;
};

const cleanupRoots: string[] = [];

afterAll(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generated output parity preflight", () => {
  it("keeps one deterministic plan aligned across Compact, Balanced and Visual native PPTX exports", async () => {
    const templateBuffer = await createFixtureTemplate("photo");
    const { plan, documents } = await buildOfflineVariants(templateBuffer, "synthetic-photo.pptx");

    expect(new Set(documents.map((document) => JSON.stringify(document.plan))).size).toBe(1);
    expect(documents.every((document) => JSON.stringify(document.plan) === JSON.stringify(plan))).toBe(true);
    expect(new Set(documents.flatMap((document) => document.slides.flatMap((slide) =>
      slide.canvas.elements.map((element) => element.type),
    )))).toEqual(new Set(["text", "shape", "image"]));

    for (const [index, variant] of VARIANTS.entries()) {
      const document = documents[index];
      if (!document) throw new Error(`generated-output-parity [variant=${variant}] document was not created`);
      const pptxBuffer = await createPresentationPptx(document);
      await assertNativePptxParity(pptxBuffer, document, variant);
    }
  });

  it("rejects a generated full-slide image without template-backed provenance", async () => {
    const templateBuffer = await createFixtureTemplate("bright");
    const { documents } = await buildOfflineVariants(templateBuffer, "synthetic-generated-raster.pptx", 5);
    const sourceDocument = documents[0];
    if (!sourceDocument) throw new Error("generated-output-parity [variant=compact] document was not created");
    const firstSlide = sourceDocument.slides[0];
    if (!firstSlide) throw new Error("generated-output-parity [variant=compact slide=1] slide was not created");
    const generatedRaster = {
      id: "generated-full-slide-raster",
      type: "image" as const,
      x: 0,
      y: 0,
      w: firstSlide.canvas.width,
      h: firstSlide.canvas.height,
      alt: "Generated raster that must be rejected",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLZ4QAAAABJRU5ErkJggg==",
      zIndex: Math.max(...firstSlide.canvas.elements.map((element) => element.zIndex)) + 1,
      locked: false,
    };
    const document = presentationDocumentSchema.parse({
      ...sourceDocument,
      slides: sourceDocument.slides.map((slide, index) => index === 0
        ? { ...slide, canvas: { ...slide.canvas, elements: [...slide.canvas.elements, generatedRaster] } }
        : slide),
    });
    const pptxBuffer = await createPresentationPptx(document);

    await expect(assertNativePptxParity(pptxBuffer, document, "compact", "synthetic-generated-raster"))
      .rejects.toThrow("full-slide raster image lacks template-backed provenance");
  });
});

const describeGeneratedParity = process.env.VK_HACKATHON_GENERATED_PARITY === "1" ? describe : describe.skip;

describeGeneratedParity("generated output render evidence preflight", () => {
  it("renders all variants from all three immutable VK Tech organizer templates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-generated-parity-"));
    cleanupRoots.push(root);
    const acceptanceEvidence: GeneratedParityAcceptanceEvidence = {
      taskId: GENERATED_PARITY_TASK_ID,
      status: "pass",
      slideCount: 5,
      variants: [...VARIANTS],
      templates: [],
      runtime: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      caveats: [
        "This is structural/native export and LibreOffice/Poppler render evidence, not pixel parity.",
        "This is not PowerPoint desktop acceptance or manual editability acceptance.",
        "This is not held-out-template proof or full MVP acceptance.",
      ],
    };
    let failure: unknown;

    try {
      for (const organizerName of ORGANIZER_TEMPLATES) {
        const organizerPath = path.resolve(process.cwd(), "fixtures", "templates", "organizer", organizerName);
        const organizerBuffer = await readFile(organizerPath);
        const { designSystem, plan, documents } = await buildOfflineVariants(organizerBuffer, organizerName, 5);
        assertSharedPlanAndDesignSystem(designSystem, plan, documents, organizerName);
        const templateEvidence: GeneratedParityTemplateEvidence = {
          name: organizerName,
          status: "pass",
          sharedPlan: true,
          sharedDesignSystem: true,
          variants: [],
        };
        acceptanceEvidence.templates.push(templateEvidence);

        for (const [index, variant] of VARIANTS.entries()) {
          const document = documents[index];
          if (!document) throw new Error(`generated-output-parity [variant=${variant} template=${organizerName}] document was not created`);
          const pptxPath = path.join(root, `${slugify(organizerName)}-${variant}.pptx`);
          const renderDir = path.join(root, slugify(organizerName), variant);

          try {
            await writeFile(pptxPath, await createPresentationPptx(document));
            const nativeParity = await assertNativePptxParity(await readFile(pptxPath), document, variant, organizerName);

            const renderHeight = Math.max(1, Math.round(
              RENDER_WIDTH_PX * document.designSystem.slideSize.height / document.designSystem.slideSize.width,
            ));
            let evidence: Awaited<ReturnType<typeof renderPptxToPngs>>;
            try {
              evidence = await renderPptxToPngs(pptxPath, {
                outputDir: renderDir,
                width: RENDER_WIDTH_PX,
                height: renderHeight,
                jobTimeoutMs: RENDER_JOB_TIMEOUT_MS,
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              throw new Error(
                `RENDER_BLOCKER [variant=${variant} template=${organizerName}]: ${detail}`,
                { cause: error },
              );
            }

            const renderSummary = await assertRenderEvidence(evidence, document, variant, organizerName);
            templateEvidence.variants.push({
              variant,
              status: "pass",
              slideCount: document.slides.length,
              nativeObjectCounts: nativeParity.nativeObjectCounts,
              templateBackedImages: nativeParity.templateBackedImages,
              generatedFullSlideRasterImage: nativeParity.generatedFullSlideRasterImage,
              geometryTolerancePx: GEOMETRY_TOLERANCE_PX,
              pdfPageSizePt: renderSummary.pdfPageSizePt,
              pngSize: renderSummary.pngSize,
              pngCount: evidence.slides.length,
              rendererVersion: evidence.rendererVersion,
            });
            if (!acceptanceEvidence.runtime.libreOffice) acceptanceEvidence.runtime.libreOffice = evidence.rendererVersion;
            acceptanceEvidence.runtime.rasterizer = evidence.rasterizer;
            acceptanceEvidence.runtime.pageCounter = evidence.pageCounter;
            acceptanceEvidence.runtime.rasterizerPath = evidence.rasterizerPath;
            acceptanceEvidence.runtime.pageCounterPath = evidence.pageCounterPath;
          } catch (error) {
            templateEvidence.status = "fail";
            templateEvidence.variants.push({
              variant,
              status: "fail",
              error: error instanceof Error ? error.message : String(error),
            });
            acceptanceEvidence.status = "fail";
            throw error;
          }
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      await addToolVersions(acceptanceEvidence);
      const evidencePath = await writeAcceptanceEvidence(acceptanceEvidence);
      console.log(`GENERATED_OUTPUT_PARITY_ACCEPTANCE_EVIDENCE_PATH=${evidencePath}`);
      console.log(`GENERATED_OUTPUT_PARITY_ACCEPTANCE_EVIDENCE=${JSON.stringify(acceptanceEvidence)}`);
    }

    if (failure) throw failure;
  }, RENDER_JOB_TIMEOUT_MS);
});

type GeneratedParityVariantEvidence = {
  variant: LayoutVariant;
  status: "pass" | "fail";
  slideCount?: number;
  nativeObjectCounts?: NativeObjectCounts;
  templateBackedImages?: TemplateBackedImageEvidence[];
  generatedFullSlideRasterImage?: boolean;
  geometryTolerancePx?: number;
  pdfPageSizePt?: { width: number; height: number };
  pngSize?: { width: number; height: number };
  pngCount?: number;
  rendererVersion?: string;
  error?: string;
};

type GeneratedParityTemplateEvidence = {
  name: string;
  status: "pass" | "fail";
  sharedPlan: boolean;
  sharedDesignSystem: boolean;
  variants: GeneratedParityVariantEvidence[];
};

type GeneratedParityAcceptanceEvidence = {
  taskId: string;
  status: "pass" | "fail";
  slideCount: number;
  variants: readonly LayoutVariant[];
  templates: GeneratedParityTemplateEvidence[];
  runtime: {
    node: string;
    platform: string;
    libreOffice?: string;
    rasterizer?: string;
    pageCounter?: string;
    rasterizerPath?: string;
    pageCounterPath?: string;
    rasterizerVersion?: string;
    pageCounterVersion?: string;
  };
  caveats: string[];
};

async function buildOfflineVariants(
  templateBuffer: Buffer,
  sourceName: string,
  slideCount = 10,
) {
  const designSystem = await parsePptxTemplate(templateBuffer, sourceName);
  const content = await normalizeContent("VK Tech generated output parity preflight", [{
    name: "parity-fixture.txt",
    type: "text/plain",
    buffer: Buffer.from(
      "Один общий план должен сохранить текст, фигуры, изображения и координаты при native PPTX export.",
    ),
  }]);
  const plan = await createPresentationPlan(content, slideCount);
  const documents = VARIANTS.map((variant) => presentationDocumentSchema.parse({
    ...renderPresentation(designSystem, plan, variant),
    variant,
  }));
  return { designSystem, plan, documents };
}

function assertSharedPlanAndDesignSystem(
  designSystem: PresentationDocument["designSystem"],
  plan: PresentationDocument["plan"],
  documents: PresentationDocument[],
  organizerName: string,
) {
  const planFingerprints = new Set(documents.map((document) => JSON.stringify(document.plan)));
  if (planFingerprints.size !== 1 || documents.some((document) => JSON.stringify(document.plan) !== JSON.stringify(plan))) {
    throw new Error(`generated-output-parity [template=${organizerName}] variants do not share one deterministic plan`);
  }
  const designSystemFingerprints = new Set(documents.map((document) => JSON.stringify(document.designSystem)));
  if (designSystemFingerprints.size !== 1 || documents.some((document) => JSON.stringify(document.designSystem) !== JSON.stringify(designSystem))) {
    throw new Error(`generated-output-parity [template=${organizerName}] variants do not share one DesignSystem`);
  }
}

async function assertNativePptxParity(
  pptxBuffer: Buffer,
  document: PresentationDocument,
  variant: LayoutVariant,
  organizerName = "synthetic",
) {
  const parsed = await parseNativePptx(pptxBuffer, variant);
  const expectedWidth = document.designSystem.slideSize.width;
  const expectedHeight = document.designSystem.slideSize.height;
  assertClose(
    parsed.slideSize.width,
    expectedWidth,
    SLIDE_SIZE_TOLERANCE_PX,
    `generated-output-parity [variant=${variant} template=${organizerName}] slide width differs: canvas=${expectedWidth}px pptx=${parsed.slideSize.width}px tolerance=${SLIDE_SIZE_TOLERANCE_PX}px`,
  );
  assertClose(
    parsed.slideSize.height,
    expectedHeight,
    SLIDE_SIZE_TOLERANCE_PX,
    `generated-output-parity [variant=${variant} template=${organizerName}] slide height differs: canvas=${expectedHeight}px pptx=${parsed.slideSize.height}px tolerance=${SLIDE_SIZE_TOLERANCE_PX}px`,
  );
  if (parsed.slides.length !== document.slides.length) {
    throw new Error(
      `generated-output-parity [variant=${variant} template=${organizerName}] slide count differs: canvas=${document.slides.length} pptx=${parsed.slides.length}`,
    );
  }

  const nativeObjectCounts: NativeObjectCounts = { text: 0, shape: 0, image: 0 };
  const templateBackedImages: TemplateBackedImageEvidence[] = [];
  let generatedFullSlideRasterImage = false;

  for (const [slideIndex, slide] of document.slides.entries()) {
    const native = parsed.slides[slideIndex];
    if (!native) throw new Error(`generated-output-parity [variant=${variant} template=${organizerName} slide=${slideIndex + 1}] missing PPTX slide`);
    const expected = slide.canvas.elements;
    const expectedByKind = countKinds(expected);
    const nativeByKind = countKinds(native.objects);
    for (const kind of ["text", "shape", "image"] as const) {
      nativeObjectCounts[kind] += nativeByKind[kind];
      if (nativeByKind[kind] !== expectedByKind[kind]) {
        throw new Error(
          `generated-output-parity [variant=${variant} template=${organizerName} slide=${slideIndex + 1}] native ${kind} count differs: canvas=${expectedByKind[kind]} pptx=${nativeByKind[kind]}`,
        );
      }
    }

    const fullSlideImages = native.objects.filter((object) => object.kind === "image").filter((object) => (
      object.x <= GEOMETRY_TOLERANCE_PX
      && object.y <= GEOMETRY_TOLERANCE_PX
      && object.w >= slide.canvas.width - GEOMETRY_TOLERANCE_PX
      && object.h >= slide.canvas.height - GEOMETRY_TOLERANCE_PX
    ));
    const allowedTemplateImages = new Map<NativeObject, TemplateBackedImageEvidence>();
    for (const nativeImage of fullSlideImages) {
      const provenance = templateBackedImageEvidence(document, slide, nativeImage, slideIndex + 1);
      if (provenance) {
        allowedTemplateImages.set(nativeImage, provenance);
        templateBackedImages.push(provenance);
      }
    }
    const generatedFullSlideImages = fullSlideImages.filter((image) => !allowedTemplateImages.has(image));
    if (generatedFullSlideImages.length > 0) {
      generatedFullSlideRasterImage = true;
      throw new Error(
        `generated-output-parity [variant=${variant} template=${organizerName} slide=${slideIndex + 1}] full-slide raster image lacks template-backed provenance; expected editable generated canvas objects`,
      );
    }

    const unused = new Set(native.objects.map((_, objectIndex) => objectIndex));
    for (const element of expected) {
      const kind = canvasKind(element);
      const candidateIndex = [...unused].find((objectIndex) => {
        const object = native.objects[objectIndex];
        if (!object || object.kind !== kind || !sameGeometry(element, object, GEOMETRY_TOLERANCE_PX)) return false;
        if (kind !== "text") return true;
        if (element.type !== "text") return false;
        const exportedText = normalizeText(object.runTexts.join("\n"));
        return exportedText === normalizeText(element.text);
      });
      if (candidateIndex === undefined) {
        const expectedGeometry = formatGeometry(element);
        const nativeDiagnostics = native.objects
          .filter((object) => object.kind === kind)
          .map((object) => `${object.xmlName}:${formatGeometry(object)}:${JSON.stringify(object.runTexts)}`)
          .join(" | ");
        throw new Error(
          `generated-output-parity [variant=${variant} template=${organizerName} slide=${slideIndex + 1} element=${element.id}] native ${kind} object missing or geometry/text differs: canvas=${expectedGeometry} tolerance=${GEOMETRY_TOLERANCE_PX}px native=${nativeDiagnostics}`,
        );
      }
      unused.delete(candidateIndex);
    }
  }
  return {
    nativeObjectCounts,
    templateBackedImages,
    generatedFullSlideRasterImage,
  } satisfies NativeParityEvidence;
}

function templateBackedImageEvidence(
  document: PresentationDocument,
  slide: PresentationDocument["slides"][number],
  nativeImage: NativeObject,
  slideNumber: number,
): TemplateBackedImageEvidence | undefined {
  const canvasImage = slide.canvas.elements.find((element) => (
    element.type === "image" && sameGeometry(element, nativeImage, GEOMETRY_TOLERANCE_PX)
  ));
  if (!canvasImage || canvasImage.type !== "image" || !canvasImage.sourceTemplateElementId || !canvasImage.dataUrl) return undefined;

  const templateLayout = document.designSystem.layouts.find((layout) => layout.id === slide.templateLayoutId);
  if (!templateLayout) return undefined;
  const templateElement = templateLayout.elements.find((element) => (
    element.id === canvasImage.sourceTemplateElementId && element.type === "image"
  ));
  if (!templateElement || !templateElement.imageDataUrl || !templateElement.relationshipId || !templateElement.sourceFile) return undefined;
  if (canvasImage.dataUrl !== templateElement.imageDataUrl || !sameGeometry(canvasImage, templateElement, GEOMETRY_TOLERANCE_PX)) return undefined;

  const asset = document.designSystem.imageAssets?.find((candidate) => (
    candidate.allowed
      && candidate.relationshipId === templateElement.relationshipId
      && candidate.sourceFile === templateElement.sourceFile
  ));
  if (!asset?.target || !asset.sha256) return undefined;

  return {
    slideNumber,
    elementId: canvasImage.id,
    templateElementId: templateElement.id,
    templateLayoutId: templateLayout.id,
    geometry: {
      x: templateElement.x,
      y: templateElement.y,
      w: templateElement.w,
      h: templateElement.h,
    },
    sourceFile: templateElement.sourceFile,
    relationshipId: templateElement.relationshipId,
    assetTarget: asset.target,
    assetSha256: asset.sha256,
    assetSources: asset.sources,
    ...(nativeImage.nativeRelationshipId ? { nativeRelationshipId: nativeImage.nativeRelationshipId } : {}),
  };
}

async function parseNativePptx(buffer: Buffer, variant: LayoutVariant): Promise<ParsedPptx> {
  const archive = await JSZip.loadAsync(buffer);
  const presentationXml = await readZipText(archive, "ppt/presentation.xml", variant);
  const presentation = xmlParser.parse(presentationXml) as unknown;
  const slideSizeNode = firstRecord(findValues(presentation, "p:sldSz"));
  if (!slideSizeNode) throw new Error(`generated-output-parity [variant=${variant}] PPTX slide size XML is missing`);
  const slideWidthEmu = numericAttribute(slideSizeNode, "cx", variant);
  const slideHeightEmu = numericAttribute(slideSizeNode, "cy", variant);
  const slideNames = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  const slides: ParsedPptx["slides"] = [];
  for (const slideName of slideNames) {
    const xml = await readZipText(archive, slideName, variant);
    const parsed = xmlParser.parse(xml) as unknown;
    const objects = [
      ...findValues(parsed, "p:sp").map((value) => parseNativeObject(value, "p:sp", variant)),
      ...findValues(parsed, "p:cxnSp").map((value) => parseNativeObject(value, "p:cxnSp", variant)),
      ...findValues(parsed, "p:pic").map((value) => parseNativeObject(value, "p:pic", variant)),
    ];
    slides.push({ objects });
  }
  return {
    slideSize: {
      width: slideWidthEmu / EMU_PER_PIXEL,
      height: slideHeightEmu / EMU_PER_PIXEL,
    },
    slides,
  };
}

function parseNativeObject(value: unknown, xmlName: string, variant: LayoutVariant): NativeObject {
  const record = asRecord(value);
  if (!record) throw new Error(`generated-output-parity [variant=${variant}] ${xmlName} XML node is invalid`);
  const transform = firstRecord(findValues(record, "a:xfrm"));
  const off = transform ? firstRecord(findValues(transform, "a:off")) : undefined;
  const ext = transform ? firstRecord(findValues(transform, "a:ext")) : undefined;
  if (!off || !ext) throw new Error(`generated-output-parity [variant=${variant}] ${xmlName} has no native geometry`);
  const x = numericAttribute(off, "x", variant) / EMU_PER_PIXEL;
  const y = numericAttribute(off, "y", variant) / EMU_PER_PIXEL;
  const w = numericAttribute(ext, "cx", variant) / EMU_PER_PIXEL;
  const h = numericAttribute(ext, "cy", variant) / EMU_PER_PIXEL;
  const runTexts = findValues(record, "a:t")
    .map((text) => typeof text === "string" ? text : "")
    .filter((text) => text.length > 0);
  const blip = firstRecord(findValues(record, "a:blip"));
  const nativeRelationshipId = typeof blip?.["@_r:embed"] === "string" ? blip["@_r:embed"] : undefined;
  if (xmlName === "p:pic" && findValues(record, "a:blip").length === 0) {
    throw new Error(`generated-output-parity [variant=${variant}] p:pic has no native a:blip image payload`);
  }
  return {
    kind: xmlName === "p:pic" ? "image" : runTexts.length > 0 ? "text" : "shape",
    x,
    y,
    w,
    h,
    runTexts,
    xmlName,
    ...(nativeRelationshipId ? { nativeRelationshipId } : {}),
  };
}

async function assertRenderEvidence(
  evidence: Awaited<ReturnType<typeof renderPptxToPngs>>,
  document: PresentationDocument,
  variant: LayoutVariant,
  organizerName: string,
) {
  if (evidence.slideCount !== document.slides.length) {
    throw new Error(
      `generated-output-parity [variant=${variant} template=${organizerName}] rendered page count differs: canvas=${document.slides.length} pdf=${evidence.slideCount}`,
    );
  }
  const expectedPageWidth = document.designSystem.slideSize.width * POINTS_PER_PIXEL;
  const expectedPageHeight = document.designSystem.slideSize.height * POINTS_PER_PIXEL;
  const pageInfo = await runBoundedProcess(
    evidence.pageCounterPath,
    [evidence.pdfPath],
    60_000,
    `Poppler PDF page-size check (${variant})`,
  );
  if (pageInfo.exitCode !== 0) {
    throw new Error(
      `RENDER_BLOCKER [variant=${variant} template=${organizerName}] Poppler page-size check failed: ${pageInfo.stderr || pageInfo.stdout || "no diagnostic output"}`,
    );
  }
  const pageSize = /Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/iu.exec(pageInfo.stdout);
  if (!pageSize) {
    throw new Error(
      `RENDER_BLOCKER [variant=${variant} template=${organizerName}] Poppler did not report a PDF page size`,
    );
  }
  assertClose(
    Number(pageSize[1]),
    expectedPageWidth,
    POINTS_PER_PIXEL,
    `generated-output-parity [variant=${variant} template=${organizerName}] PDF page width differs: expected=${expectedPageWidth}pt actual=${pageSize[1]}pt`,
  );
  assertClose(
    Number(pageSize[2]),
    expectedPageHeight,
    POINTS_PER_PIXEL,
    `generated-output-parity [variant=${variant} template=${organizerName}] PDF page height differs: expected=${expectedPageHeight}pt actual=${pageSize[2]}pt`,
  );
  await assertNonEmptyFile(evidence.pdfPath, `generated-output-parity [variant=${variant}] rendered PDF`);
  const firstSlide = evidence.slides[0];
  if (!firstSlide) throw new Error(`generated-output-parity [variant=${variant} template=${organizerName}] rendered PNG list is empty`);
  const pngSize = await readPngDimensions(firstSlide.outputPath);
  for (const slide of evidence.slides) {
    await assertNonEmptyFile(slide.outputPath, `generated-output-parity [variant=${variant}] rendered PNG slide ${slide.slideNumber}`);
    const dimensions = await readPngDimensions(slide.outputPath);
    if (dimensions.width !== evidence.width || dimensions.height !== evidence.height) {
      throw new Error(
        `generated-output-parity [variant=${variant} template=${organizerName} slide=${slide.slideNumber}] PNG dimensions differ: expected=${evidence.width}x${evidence.height} actual=${dimensions.width}x${dimensions.height}`,
      );
    }
  }
  return {
    pdfPageSizePt: { width: Number(pageSize[1]), height: Number(pageSize[2]) },
    pngSize,
  };
}

async function writeAcceptanceEvidence(evidence: GeneratedParityAcceptanceEvidence) {
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  const evidenceDir = path.resolve(process.cwd(), ".data", "acceptance", "generated-output-parity", runId);
  await mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidencePath;
}

async function addToolVersions(evidence: GeneratedParityAcceptanceEvidence) {
  const [rasterizerVersion, pageCounterVersion] = await Promise.all([
    evidence.runtime.rasterizerPath
      ? readToolVersion(evidence.runtime.rasterizerPath, "Poppler pdftoppm version")
      : Promise.resolve(undefined),
    evidence.runtime.pageCounterPath
      ? readToolVersion(evidence.runtime.pageCounterPath, "Poppler pdfinfo version")
      : Promise.resolve(undefined),
  ]);
  if (rasterizerVersion) evidence.runtime.rasterizerVersion = rasterizerVersion;
  if (pageCounterVersion) evidence.runtime.pageCounterVersion = pageCounterVersion;
}

async function readToolVersion(command: string, label: string) {
  const result = await runBoundedProcess(command, ["-v"], 60_000, label);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return output || `unavailable (exit ${result.exitCode})`;
}

function slugify(value: string) {
  return value.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "").toLowerCase();
}

async function readPngDimensions(filePath: string) {
  const buffer = await readFile(filePath);
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`generated-output-parity rendered output is not a PNG: ${filePath}`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function assertNonEmptyFile(filePath: string, label: string) {
  const file = await stat(filePath).catch((error) => {
    throw new Error(`${label} is missing at ${filePath}`, { cause: error });
  });
  if (!file.isFile() || file.size <= 0) throw new Error(`${label} is empty or not a file: ${filePath}`);
}

function countKinds(elements: Array<CanvasElement | NativeObject>) {
  return elements.reduce<Record<NativeKind, number>>((counts, element) => {
    counts[canvasKind(element)] += 1;
    return counts;
  }, { text: 0, shape: 0, image: 0 });
}

function canvasKind(element: CanvasElement | NativeObject): NativeKind {
  if ("type" in element) return element.type === "text" ? "text" : element.type === "image" ? "image" : "shape";
  return element.kind;
}

function sameGeometry(
  element: { x: number; y: number; w: number; h: number },
  object: { x: number; y: number; w: number; h: number },
  tolerance: number,
) {
  return Math.abs(element.x - object.x) <= tolerance
    && Math.abs(element.y - object.y) <= tolerance
    && Math.abs(element.w - object.w) <= tolerance
    && Math.abs(element.h - object.h) <= tolerance;
}

function formatGeometry(element: Pick<CanvasElement, "x" | "y" | "w" | "h">) {
  return `${element.x.toFixed(3)},${element.y.toFixed(3)},${element.w.toFixed(3)},${element.h.toFixed(3)}`;
}

function normalizeText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}; delta=${Number.isFinite(actual) ? Math.abs(actual - expected).toFixed(4) : "non-finite"}`);
  }
}

async function readZipText(archive: JSZip, fileName: string, variant: LayoutVariant) {
  const file = archive.files[fileName];
  if (!file) throw new Error(`generated-output-parity [variant=${variant}] PPTX entry is missing: ${fileName}`);
  return file.async("string");
}

function slideNumber(fileName: string) {
  return Number(fileName.match(/slide(\d+)\.xml$/u)?.[1] || 0);
}

function asRecord(value: unknown): XmlRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as XmlRecord : undefined;
}

function firstRecord(values: unknown[]): XmlRecord | undefined {
  return values.map(asRecord).find((value): value is XmlRecord => Boolean(value));
}

function findValues(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => findValues(item, key));
  const record = asRecord(value);
  if (!record) return [];
  const found: unknown[] = [];
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (entryKey === key) found.push(...(Array.isArray(entryValue) ? entryValue : [entryValue]));
    found.push(...findValues(entryValue, key));
  }
  return found;
}

function numericAttribute(record: XmlRecord, name: string, variant: LayoutVariant) {
  const raw = record[`@_${name}`];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`generated-output-parity [variant=${variant}] invalid OOXML ${name} attribute`);
  return value;
}
