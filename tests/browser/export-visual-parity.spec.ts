import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium, expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import JSZip from "jszip";
import {
  DEFAULT_PARITY_TOLERANCES,
  canvasPixelsToPdfPoints,
  inspectTextParity,
  normalizedTextTokens,
  pdfJsTextItemsToBoxes,
  pptxEmuToCanvasPixels,
  type CanvasSize,
  type MeasuredTextBox,
  type ParityFinding,
  type PdfJsTextItemLike,
  type PdfPageSize,
} from "../../src/lib/export-visual-parity";
import {
  presentationDocumentSchema,
  type LayoutVariant,
  type PresentationDocument,
} from "../../src/lib/schemas";

/**
 * Expensive published-job acceptance. Run with VK_EXPORT_VISUAL_PARITY=1.
 * The Playwright webServer config pins VK_HACKATHON_LLM_PROVIDER=deterministic;
 * the returned published plans are checked before they are used as evidence.
 */

const ORGANIZER_TEMPLATES = [
  "VK Tech шаблон.pptx",
  "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx",
  "Шаблон презентации VK Education.pptx",
] as const;
const VARIANTS: readonly LayoutVariant[] = ["compact", "balanced", "visual"];
const FIXTURE_DIRECTORY = path.resolve(process.cwd(), "fixtures/templates/organizer");
const REPORT_FILE = "export-visual-parity.json";
const APP_BASE_URL = "http://localhost:3030/";
const PDF_PAGE_SIZE_TOLERANCE_PT = 1.5;
const PPTX_SLIDE_SIZE_TOLERANCE_PX = 1;
const require = createRequire(import.meta.url);

type ExportResponse = {
  responsePath: string;
  artifactPath: string;
  responseSha256: string;
  artifactSha256: string;
  sizeBytes: number;
};

type ExportStatus = "not_attempted" | "pending" | "succeeded" | "failed";
type ExportErrorEvidence = {
  format: "pptx" | "pdf";
  status: "failed";
  message: string;
  httpStatus?: number;
  responseCode?: string;
};

type HarnessFinding = ParityFinding | {
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  tolerance?: number;
};

type SlideEvidence = {
  slideNumber: number;
  slideId: string;
  title: string;
  expectedTextBoxes: number;
  canvasTextBoxes: number;
  pptxTextBoxes: number;
  pdfTextItems: number;
  coverageStatus: "measured" | "visited_export_unavailable";
  skippedChecks?: Array<"pptx" | "pdf">;
  findings: HarnessFinding[];
  text: Array<{
    elementId: string;
    expected: string;
    canvasRectPx?: { x: number; y: number; width: number; height: number };
    pptxRectEmu?: { x: number; y: number; width: number; height: number };
    pdfRectPt?: { x: number; y: number; width: number; height: number };
    pdfRectPx?: { x: number; y: number; width: number; height: number };
    findings: HarnessFinding[];
  }>;
};

type VariantEvidence = {
  variant: LayoutVariant;
  documentSha256: string;
  pptxExportStatus: ExportStatus;
  pdfExportStatus: ExportStatus;
  exportErrors: ExportErrorEvidence[];
  pptx: ExportResponse & { textShapeCount: number; slideSizeCanvasPx: CanvasSize };
  pdf: ExportResponse & { pageCount: number; textPageSizePt: Array<{ widthPt: number; heightPt: number }> };
  slides: SlideEvidence[];
  findings: HarnessFinding[];
};

type TemplateEvidence = {
  template: string;
  templateSha256: string;
  jobId?: string;
  publishedManifestStatus?: string;
  variants: VariantEvidence[];
  findings: HarnessFinding[];
};

type HarnessReport = {
  schemaVersion: 1;
  status: "running" | "passed" | "failed";
  startedAt: string;
  completedAt?: string;
  reportPath: string;
  coverage: {
    planned: { templates: number; variants: number; slides: number; artifactExports: number };
    observed: { templates: number; variants: number; slideRecords: number; fullyMeasuredSlides: number; artifactExportAttempts: number };
    failedArtifactExports: number;
    status: "incomplete" | "complete" | "complete_with_export_failures";
  };
  configuration: {
    optIn: "VK_EXPORT_VISUAL_PARITY=1";
    planner: "deterministic";
    templates: readonly string[];
    variants: readonly LayoutVariant[];
    slidesPerJob: 10;
    units: { canvas: "canvas-px at 96 DPI"; pptx: "English Metric Units (EMU)"; pdf: "PDF points, top-left text bounds" };
    tolerances: typeof DEFAULT_PARITY_TOLERANCES & {
      pdfPageSizePt: number;
      pptxSlideSizePx: number;
    };
  };
  toolVersions: Record<string, string>;
  evidenceCaveats: string[];
  templates: TemplateEvidence[];
  findings: HarnessFinding[];
  failure?: string;
};

type PdfPageProxyLike = {
  view: number[];
  getTextContent(options?: Record<string, unknown>): Promise<{ items: PdfJsTextItemLike[] }>;
  cleanup(): void;
};

type PdfDocumentProxyLike = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxyLike>;
  destroy(): Promise<void>;
};

type PdfJsLike = {
  version?: string;
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocumentProxyLike> };
};

type PublishedJobPayload = {
  manifest?: { status?: string };
  presentations?: Record<LayoutVariant, unknown>;
};

test.describe("opt-in published editor/PPTX/PDF visual parity", () => {
  test("measures all text boxes for 3 organizer templates × 3 variants × 10 slides", async ({}, testInfo) => {
    test.skip(process.env.VK_EXPORT_VISUAL_PARITY !== "1", "Set VK_EXPORT_VISUAL_PARITY=1 to run the full published export acceptance.");
    test.setTimeout(900_000);

    const reportPath = testInfo.outputPath(REPORT_FILE);
    const report: HarnessReport = {
      schemaVersion: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      reportPath,
      coverage: {
        planned: {
          templates: ORGANIZER_TEMPLATES.length,
          variants: ORGANIZER_TEMPLATES.length * VARIANTS.length,
          slides: ORGANIZER_TEMPLATES.length * VARIANTS.length * 10,
          artifactExports: ORGANIZER_TEMPLATES.length * VARIANTS.length * 2,
        },
        observed: { templates: 0, variants: 0, slideRecords: 0, fullyMeasuredSlides: 0, artifactExportAttempts: 0 },
        failedArtifactExports: 0,
        status: "incomplete",
      },
      configuration: {
        optIn: "VK_EXPORT_VISUAL_PARITY=1",
        planner: "deterministic",
        templates: ORGANIZER_TEMPLATES,
        variants: VARIANTS,
        slidesPerJob: 10,
        units: {
          canvas: "canvas-px at 96 DPI",
          pptx: "English Metric Units (EMU)",
          pdf: "PDF points, top-left text bounds",
        },
        tolerances: {
          ...DEFAULT_PARITY_TOLERANCES,
          pdfPageSizePt: PDF_PAGE_SIZE_TOLERANCE_PT,
          pptxSlideSizePx: PPTX_SLIDE_SIZE_TOLERANCE_PX,
        },
      },
      toolVersions: {
        node: process.version,
        playwright: getPackageVersion("@playwright/test"),
        browser: "not started",
      },
      evidenceCaveats: [
        "This acceptance measures editable DOM geometry, OOXML text-shape geometry, and PDF text bounds; it does not establish pixel-level or human visual fidelity.",
        "PDF text extraction uses PDF.js getTextContent() with page transforms. Text bounds approximate glyph extents and are compared with explicit tolerances.",
        "A deterministic plan and a published job do not establish PowerPoint-specific rendering or manual editability acceptance.",
        "The exact normalized-token match proves extracted text presence, not semantic correctness of generated content.",
      ],
      templates: [],
      findings: [],
    };

    const flushReport = async () => {
      refreshCoverage(report);
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    };

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      const browserExecutable = findBrowserExecutable();
      if (!browserExecutable) {
        throw new Error("BLOCKED: no Chromium-based browser executable found (checked PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, Chrome, and Edge).");
      }
      browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
      context = await browser.newContext();
      const page = await context.newPage();
      report.toolVersions.browser = `${browser.version()} (${path.basename(browserExecutable)})`;
      report.toolVersions.browserExecutable = browserExecutable;
      page.setDefaultTimeout(30_000);
      page.setDefaultNavigationTimeout(60_000);

      const libreOffice = findExecutable("soffice", [
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
        "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
      ]);
      if (!libreOffice) throw new Error("BLOCKED: LibreOffice/soffice is not available; published PDF export cannot be rendered.");
      report.toolVersions.libreOffice = readToolVersion(libreOffice);

      const pdfjs = await loadPdfJs();
      report.toolVersions.pdfTextExtractor = `PDF.js ${pdfjs.version || getPdfJsPackageVersion()}`;

      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(APP_BASE_URL, { waitUntil: "domcontentloaded" });
      const appRootUrl = APP_BASE_URL;

      for (const templateName of ORGANIZER_TEMPLATES) {
        const templatePath = path.join(FIXTURE_DIRECTORY, templateName);
        if (!existsSync(templatePath)) throw new Error(`BLOCKED: immutable organizer fixture is missing: ${templatePath}`);
        const templateBytes = await fs.readFile(templatePath);
        const templateEvidence: TemplateEvidence = {
          template: templateName,
          templateSha256: sha256(templateBytes),
          variants: [],
          findings: [],
        };
        report.templates.push(templateEvidence);
        await flushReport();

        const generationResponse = await page.request.post(new URL("/api/generate", appRootUrl).toString(), {
          multipart: {
            brief: "Create a ten-slide, fact-based overview of reliable export layout parity and presentation readability.",
            slideCount: "10",
            template: {
              name: templateName,
              mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              buffer: templateBytes,
            },
          },
          timeout: 300_000,
        });
        if (!generationResponse.ok()) {
          throw new Error(`POST /api/generate failed for ${templateName}: HTTP ${generationResponse.status()} ${truncate(await generationResponse.text())}`);
        }
        const generated = await generationResponse.json() as {
          jobId?: string;
          presentations?: Record<LayoutVariant, unknown>;
          manifest?: { status?: string };
        };
        if (!generated.jobId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(generated.jobId)) {
          throw new Error(`POST /api/generate returned no safe job id for ${templateName}`);
        }
        const jobId = generated.jobId;
        templateEvidence.jobId = jobId;

        const reopenedResponse = await page.request.get(
          new URL(`/api/jobs/${encodeURIComponent(jobId)}`, appRootUrl).toString(),
          { timeout: 120_000 },
        );
        if (!reopenedResponse.ok()) {
          throw new Error(`Published job reopen failed for ${templateName} (${jobId}): HTTP ${reopenedResponse.status()} ${truncate(await reopenedResponse.text())}`);
        }
        const published = await reopenedResponse.json() as PublishedJobPayload;
        templateEvidence.publishedManifestStatus = published.manifest?.status;
        if (published.manifest?.status !== "ready" || !published.presentations) {
          throw new Error(`Published job ${jobId} is incomplete or not ready for ${templateName}`);
        }

        const documents = {} as Record<LayoutVariant, PresentationDocument>;
        for (const variant of VARIANTS) {
          const rawDocument = published.presentations[variant];
          const document = presentationDocumentSchema.parse(rawDocument);
          if (document.plan.planner !== "deterministic") {
            throw new Error(`Refusing non-deterministic evidence: job ${jobId}/${variant} reports planner=${document.plan.planner}`);
          }
          if (document.variant !== variant || document.slides.length !== 10) {
            throw new Error(`Published ${variant} document must contain exactly 10 slides and identify its variant`);
          }
          documents[variant] = document;
          const generatedDocument = generated.presentations?.[variant];
          if (!generatedDocument || sha256Json(generatedDocument) !== sha256Json(document)) {
            throw new Error(`Published ${variant} document for ${jobId} does not match the POST /api/generate result`);
          }
        }

        const reopenedPageUrl = new URL(`/?job=${encodeURIComponent(jobId)}`, appRootUrl).toString();
        const browserReopenResponsePromise = page.waitForResponse((response) => (
          response.url().includes(`/api/jobs/${encodeURIComponent(jobId)}`)
            && response.request().method() === "GET"
        ), { timeout: 120_000 });
        await page.goto(reopenedPageUrl, { waitUntil: "domcontentloaded" });
        const browserReopenResponse = await browserReopenResponsePromise;
        if (!browserReopenResponse.ok()) {
          throw new Error(
            `Editor browser reopen failed for ${jobId}: HTTP ${browserReopenResponse.status()} ${truncate(await browserReopenResponse.text())}`,
          );
        }
        await expect(page).toHaveURL(reopenedPageUrl);
        await expect(page.getByRole("status")).toContainText("Открыт опубликованный job.");
        await expect(page.getByRole("tab")).toHaveCount(3);
        await expect(page.getByRole("complementary", { name: "Список слайдов" })).toContainText("10 слайдов");
        await expect(page.locator(".editable-canvas")).toBeVisible();

        for (const variant of VARIANTS) {
          const document = documents[variant];
          const variantEvidence: VariantEvidence = {
            variant,
            documentSha256: sha256Json(document),
            pptxExportStatus: "not_attempted",
            pdfExportStatus: "not_attempted",
            exportErrors: [],
            pptx: {
              responsePath: "",
              artifactPath: "",
              responseSha256: "",
              artifactSha256: "",
              sizeBytes: 0,
              textShapeCount: 0,
              slideSizeCanvasPx: { width: 0, height: 0 },
            },
            pdf: {
              responsePath: "",
              artifactPath: "",
              responseSha256: "",
              artifactSha256: "",
              sizeBytes: 0,
              pageCount: 0,
              textPageSizePt: [],
            },
            slides: [],
            findings: [],
          };
          templateEvidence.variants.push(variantEvidence);

          const variantTab = page.getByRole("tab", { name: new RegExp(variantLabel(variant), "u") });
          await variantTab.click();
          await expect(variantTab).toHaveAttribute("aria-selected", "true");

          let pptxBytes: Buffer | undefined;
          let pdfBytes: Buffer | undefined;
          for (const format of ["pptx", "pdf"] as const) {
            variantEvidence[format === "pptx" ? "pptxExportStatus" : "pdfExportStatus"] = "pending";
            try {
              const exported = await exportPublishedArtifact(page, appRootUrl, jobId, variant, format, testInfo);
              if (format === "pptx") {
                variantEvidence.pptx = { ...variantEvidence.pptx, ...exported.metadata };
                variantEvidence.pptxExportStatus = "succeeded";
                pptxBytes = exported.bytes;
              } else {
                variantEvidence.pdf = { ...variantEvidence.pdf, ...exported.metadata };
                variantEvidence.pdfExportStatus = "succeeded";
                pdfBytes = exported.bytes;
              }
            } catch (error) {
              const failure = toExportErrorEvidence(format, error);
              variantEvidence[format === "pptx" ? "pptxExportStatus" : "pdfExportStatus"] = "failed";
              variantEvidence.exportErrors.push(failure);
              variantEvidence.findings.push({
                code: `${format.toUpperCase()}_EXPORT_FAILED`,
                message: `Published ${format.toUpperCase()} export failed for ${jobId}/${variant}: ${failure.message}`,
                actual: failure,
              });
              await flushReport();
            }
          }

          let nativePptx: Awaited<ReturnType<typeof readPptxTextGeometry>> | undefined;
          if (pptxBytes) {
            try {
              nativePptx = await readPptxTextGeometry(pptxBytes);
              variantEvidence.pptx.textShapeCount = nativePptx.slides.reduce((sum, slide) => sum + slide.length, 0);
              variantEvidence.pptx.slideSizeCanvasPx = nativePptx.slideSizeCanvasPx;
              if (nativePptx.slides.length !== document.slides.length) {
                variantEvidence.findings.push({
                  code: "PPTX_SLIDE_COUNT_MISMATCH",
                  message: `PPTX has ${nativePptx.slides.length} slides; source has ${document.slides.length}.`,
                });
              }
              const slideWidthDelta = Math.abs(nativePptx.slideSizeCanvasPx.width - document.designSystem.slideSize.width);
              const slideHeightDelta = Math.abs(nativePptx.slideSizeCanvasPx.height - document.designSystem.slideSize.height);
              if (slideWidthDelta > PPTX_SLIDE_SIZE_TOLERANCE_PX || slideHeightDelta > PPTX_SLIDE_SIZE_TOLERANCE_PX) {
                variantEvidence.findings.push({
                  code: "PPTX_SLIDE_SIZE_MISMATCH",
                  message: "PPTX OOXML slide dimensions differ from the source canvas beyond tolerance.",
                  expected: document.designSystem.slideSize,
                  actual: nativePptx.slideSizeCanvasPx,
                  tolerance: PPTX_SLIDE_SIZE_TOLERANCE_PX,
                });
              }
            } catch (error) {
              const failure = toExportErrorEvidence("pptx", error);
              variantEvidence.pptxExportStatus = "failed";
              variantEvidence.exportErrors.push(failure);
              variantEvidence.findings.push({
                code: "PPTX_ARTIFACT_READ_FAILED",
                message: `Published PPTX artifact could not be inspected for ${jobId}/${variant}: ${failure.message}`,
                actual: failure,
              });
            }
          }

          let pdfDocument: PdfDocumentProxyLike | undefined;
          if (pdfBytes) {
            try {
              pdfDocument = await openPdf(pdfjs, pdfBytes);
              variantEvidence.pdf.pageCount = pdfDocument.numPages;
              if (pdfDocument.numPages !== document.slides.length) {
                variantEvidence.findings.push({
                  code: "PDF_PAGE_COUNT_MISMATCH",
                  message: `PDF has ${pdfDocument.numPages} pages; source has ${document.slides.length}.`,
                });
              }
            } catch (error) {
              const failure = toExportErrorEvidence("pdf", error);
              variantEvidence.pdfExportStatus = "failed";
              variantEvidence.exportErrors.push(failure);
              variantEvidence.findings.push({
                code: "PDF_ARTIFACT_READ_FAILED",
                message: `Published PDF artifact could not be inspected for ${jobId}/${variant}: ${failure.message}`,
                actual: failure,
              });
            }
          }

          try {
            if (nativePptx && pdfDocument) {
              await measureVariantSlides({
                page,
                appRootUrl,
                document,
                nativeSlides: nativePptx.slides,
                pdfDocument,
                variantEvidence,
                testInfo,
              });
            } else {
              await visitVariantSlidesWithoutParity({
                page,
                document,
                variantEvidence,
                testInfo,
                nativeSlides: nativePptx?.slides,
                skippedChecks: [
                  ...(!nativePptx ? ["pptx" as const] : []),
                  ...(!pdfDocument ? ["pdf" as const] : []),
                ],
              });
            }
          } finally {
            await pdfDocument?.destroy().catch(() => undefined);
          }

          variantEvidence.findings.push(...variantEvidence.slides.flatMap((slide) => slide.findings));
          templateEvidence.findings.push(...variantEvidence.findings);
          report.findings.push(...variantEvidence.findings);
          await flushReport();
        }
      }

      if (report.findings.length > 0) {
        const exportFailureCount = report.templates.reduce((sum, template) => (
          sum + template.variants.reduce((nested, variant) => nested + variant.exportErrors.length, 0)
        ), 0);
        throw new Error(
          `Visual parity acceptance found ${report.findings.length} issue(s), including ${exportFailureCount} artifact export/inspection failure(s); see ${reportPath}`,
        );
      }
      report.status = "passed";
    } catch (error) {
      report.status = "failed";
      report.failure = errorMessage(error);
      throw error;
    } finally {
      report.completedAt = new Date().toISOString();
      await flushReport();
      console.log(`[export-visual-parity] report=${reportPath}`);
      console.log(`[export-visual-parity] status=${report.status} templates=${report.templates.length} variants=${report.templates.reduce((sum, entry) => sum + entry.variants.length, 0)} slides=${report.templates.reduce((sum, entry) => sum + entry.variants.reduce((nested, variant) => nested + variant.slides.length, 0), 0)} findings=${report.findings.length}`);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  });
});

async function measureVariantSlides(input: {
  page: Page;
  appRootUrl: string;
  document: PresentationDocument;
  nativeSlides: MeasuredTextBox[][];
  pdfDocument: PdfDocumentProxyLike;
  variantEvidence: VariantEvidence;
  testInfo: TestInfo;
}) {
  const thumbnails = input.page.getByRole("complementary", { name: "Список слайдов" }).locator("button.thumbnail");
  await expect(thumbnails).toHaveCount(input.document.slides.length);
  for (const [slideIndex, slide] of input.document.slides.entries()) {
    await thumbnails.nth(slideIndex).click();
    await expect(input.page.locator(".editor-breadcrumb")).toContainText(`Слайд ${slideIndex + 1}`);
    await expect(input.page.locator(".editor-toolbar h2")).toHaveText(slide.title);
    const canvasObjects = await readCanvasObjectBoxes(input.page, slide.canvas.width, slide.canvas.height);
    const nativeBoxes = input.nativeSlides[slideIndex] || [];
    const pdfPageNumber = slideIndex + 1;
    if (pdfPageNumber > input.pdfDocument.numPages) {
      input.variantEvidence.slides.push(createUnavailableSlideEvidence({
        slide,
        slideIndex,
        canvasObjects,
        nativeBoxes,
        skippedChecks: ["pdf"],
        findings: [{
          code: "PDF_PAGE_UNAVAILABLE",
          message: `PDF has no page ${pdfPageNumber} for source slide ${slideIndex + 1}.`,
        }],
      }));
      await flushPartialEvidence(input.testInfo, input.variantEvidence);
      continue;
    }
    const pdfPage = await input.pdfDocument.getPage(pdfPageNumber);
    try {
      const view = pdfPage.view;
      if (!Array.isArray(view) || view.length < 4) {
        throw new Error(`PDF.js page ${pdfPageNumber} does not expose four page bounds`);
      }
      const pdfPageSize: PdfPageSize = {
        leftPt: view[0]!,
        bottomPt: view[1]!,
        widthPt: view[2]! - view[0]!,
        heightPt: view[3]! - view[1]!,
      };
      input.variantEvidence.pdf.textPageSizePt.push({ widthPt: pdfPageSize.widthPt, heightPt: pdfPageSize.heightPt });
      const expectedPdfPageSize = {
        widthPt: canvasPixelsToPdfPoints(slide.canvas.width),
        heightPt: canvasPixelsToPdfPoints(slide.canvas.height),
      };
      if (Math.abs(pdfPageSize.widthPt - expectedPdfPageSize.widthPt) > PDF_PAGE_SIZE_TOLERANCE_PT
        || Math.abs(pdfPageSize.heightPt - expectedPdfPageSize.heightPt) > PDF_PAGE_SIZE_TOLERANCE_PT) {
        input.variantEvidence.findings.push({
          code: "PDF_PAGE_SIZE_MISMATCH",
          message: `PDF page ${pdfPageNumber} size differs from the source canvas beyond tolerance.`,
          expected: expectedPdfPageSize,
          actual: { widthPt: pdfPageSize.widthPt, heightPt: pdfPageSize.heightPt },
          tolerance: PDF_PAGE_SIZE_TOLERANCE_PT,
        });
      }
      const textContent = await pdfPage.getTextContent({ includeMarkedContent: false });
      const pdfBoxes = pdfJsTextItemsToBoxes(textContent.items, pdfPageSize);
      const expectedTextElements = slide.canvas.elements.filter((element) => element.type === "text");
      const slideEvidence: SlideEvidence = {
        slideNumber: slideIndex + 1,
        slideId: slide.id,
        title: slide.title,
        expectedTextBoxes: expectedTextElements.length,
        canvasTextBoxes: canvasObjects.filter((box) => box?.text !== null).length,
        pptxTextBoxes: nativeBoxes.length,
        pdfTextItems: pdfBoxes.length,
        coverageStatus: "measured",
        findings: [],
        text: [],
      };
      const claimedPdfTokenRefs = new Set<string>();
      const claimedNativeBoxes = new Set<number>();
      for (const sourceElement of expectedTextElements) {
        if (sourceElement.type !== "text") continue;
        const sourceIndex = slide.canvas.elements.findIndex((element) => element.id === sourceElement.id);
        const canvasTextBox = canvasObjects[sourceIndex];
        const pptxIndex = findNativeTextBox(sourceElement.text, nativeBoxes, claimedNativeBoxes);
        const pptxTextBox = pptxIndex >= 0 ? nativeBoxes[pptxIndex] : undefined;
        if (pptxIndex >= 0) claimedNativeBoxes.add(pptxIndex);
        const parity = inspectTextParity({
          expectedText: sourceElement.text,
          expectedCanvasRect: { x: sourceElement.x, y: sourceElement.y, width: sourceElement.w, height: sourceElement.h },
          slideCanvasSize: { width: slide.canvas.width, height: slide.canvas.height },
          ...(canvasTextBox?.text !== null && canvasTextBox ? {
            canvasTextBox: {
              text: canvasTextBox.text,
              rect: canvasTextBox.rect,
              unit: "canvas-px" as const,
            },
          } : {}),
          ...(pptxTextBox ? { pptxTextBox } : {}),
          pdfTextBoxes: pdfBoxes,
          claimedPdfTokenRefs,
        });
        const itemEvidence = {
          elementId: sourceElement.id,
          expected: sourceElement.text,
          ...(canvasTextBox?.text !== null && canvasTextBox ? { canvasRectPx: canvasTextBox.rect } : {}),
          ...(pptxTextBox ? { pptxRectEmu: pptxTextBox.rect } : {}),
          ...(parity.pdfMatch ? {
            pdfRectPt: canvasRectToPdfPointRect(parity.pdfMatch.rect),
            pdfRectPx: parity.pdfMatch.rect,
          } : {}),
          findings: deduplicateFindings(parity.findings),
        };
        slideEvidence.text.push(itemEvidence);
        slideEvidence.findings.push(...itemEvidence.findings);
      }
      input.variantEvidence.slides.push(slideEvidence);
      await flushPartialEvidence(input.testInfo, input.variantEvidence);
    } finally {
      pdfPage.cleanup();
    }
  }
}

async function visitVariantSlidesWithoutParity(input: {
  page: Page;
  document: PresentationDocument;
  variantEvidence: VariantEvidence;
  testInfo: TestInfo;
  nativeSlides?: MeasuredTextBox[][];
  skippedChecks: Array<"pptx" | "pdf">;
}) {
  const thumbnails = input.page.getByRole("complementary", { name: "Список слайдов" }).locator("button.thumbnail");
  await expect(thumbnails).toHaveCount(input.document.slides.length);
  for (const [slideIndex, slide] of input.document.slides.entries()) {
    await thumbnails.nth(slideIndex).click();
    await expect(input.page.locator(".editor-breadcrumb")).toContainText(`Слайд ${slideIndex + 1}`);
    await expect(input.page.locator(".editor-toolbar h2")).toHaveText(slide.title);
    const canvasObjects = await readCanvasObjectBoxes(input.page, slide.canvas.width, slide.canvas.height);
    input.variantEvidence.slides.push(createUnavailableSlideEvidence({
      slide,
      slideIndex,
      canvasObjects,
      nativeBoxes: input.nativeSlides?.[slideIndex] || [],
      skippedChecks: input.skippedChecks,
    }));
    await flushPartialEvidence(input.testInfo, input.variantEvidence);
  }
}

function createUnavailableSlideEvidence(input: {
  slide: PresentationDocument["slides"][number];
  slideIndex: number;
  canvasObjects: Array<{ text: string | null; rect: { x: number; y: number; width: number; height: number } }>;
  nativeBoxes: MeasuredTextBox[];
  skippedChecks: Array<"pptx" | "pdf">;
  findings?: HarnessFinding[];
}): SlideEvidence {
  const expectedTextElements = input.slide.canvas.elements.filter((element) => element.type === "text");
  const claimedNativeBoxes = new Set<number>();
  const text: SlideEvidence["text"] = [];
  for (const sourceElement of expectedTextElements) {
    if (sourceElement.type !== "text") continue;
    const sourceIndex = input.slide.canvas.elements.findIndex((element) => element.id === sourceElement.id);
    const canvasTextBox = input.canvasObjects[sourceIndex];
    const pptxIndex = findNativeTextBox(sourceElement.text, input.nativeBoxes, claimedNativeBoxes);
    const pptxTextBox = pptxIndex >= 0 ? input.nativeBoxes[pptxIndex] : undefined;
    if (pptxIndex >= 0) claimedNativeBoxes.add(pptxIndex);
    text.push({
      elementId: sourceElement.id,
      expected: sourceElement.text,
      ...(canvasTextBox && canvasTextBox.text !== null ? { canvasRectPx: canvasTextBox.rect } : {}),
      ...(pptxTextBox ? { pptxRectEmu: pptxTextBox.rect } : {}),
      findings: [],
    });
  }
  return {
    slideNumber: input.slideIndex + 1,
    slideId: input.slide.id,
    title: input.slide.title,
    expectedTextBoxes: expectedTextElements.length,
    canvasTextBoxes: input.canvasObjects.filter((box) => box.text !== null).length,
    pptxTextBoxes: input.nativeBoxes.length,
    pdfTextItems: 0,
    coverageStatus: "visited_export_unavailable",
    skippedChecks: input.skippedChecks,
    findings: input.findings || [],
    text,
  };
}

async function readCanvasObjectBoxes(page: Page, canvasWidth: number, canvasHeight: number) {
  return await page.locator(".editable-canvas").evaluate((frame, expectedSize) => {
    const bounds = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const left = bounds.left + Number.parseFloat(style.borderLeftWidth || "0");
    const top = bounds.top + Number.parseFloat(style.borderTopWidth || "0");
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    if (width <= 0 || height <= 0) throw new Error("Editable canvas has a zero-sized client box");
    const elements = [...frame.querySelectorAll<HTMLElement>(".canvas-object")];
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const textarea = element.querySelector("textarea");
      return {
        text: textarea ? textarea.value : null,
        rect: {
          x: ((rect.left - left) / width) * expectedSize.width,
          y: ((rect.top - top) / height) * expectedSize.height,
          width: (rect.width / width) * expectedSize.width,
          height: (rect.height / height) * expectedSize.height,
        },
      };
    });
  }, { width: canvasWidth, height: canvasHeight });
}

async function exportPublishedArtifact(
  page: Page,
  appRootUrl: string,
  jobId: string,
  variant: LayoutVariant,
  format: "pptx" | "pdf",
  testInfo: TestInfo,
) {
  const endpoint = format === "pptx" ? "/api/export" : "/api/export/pdf";
  const response = await page.request.post(new URL(endpoint, appRootUrl).toString(), {
    data: { jobId, variant },
    timeout: 240_000,
  });
  if (!response.ok()) {
    throw new Error(`Published ${format.toUpperCase()} export failed for ${jobId}/${variant}: HTTP ${response.status()} ${truncate(await response.text())}`);
  }
  const artifactPath = response.headers()["x-vk-hackathon-artifact-path"];
  const expectedPath = `exports/${variant}/${format}.${format}`;
  if (artifactPath !== expectedPath) {
    throw new Error(`Published ${format.toUpperCase()} export path mismatch: expected=${expectedPath} actual=${artifactPath || "missing"}`);
  }
  const responseBytes = Buffer.from(await response.body());
  if (responseBytes.length === 0) throw new Error(`Published ${format.toUpperCase()} response is empty for ${jobId}/${variant}`);
  const artifactUrl = new URL(
    `/api/artifacts/${encodeURIComponent(jobId)}/${artifactPath.split("/").map(encodeURIComponent).join("/")}`,
    appRootUrl,
  ).toString();
  const artifactResponse = await page.request.get(artifactUrl, { timeout: 120_000 });
  if (!artifactResponse.ok()) {
    throw new Error(`Published ${format.toUpperCase()} artifact could not be reopened at ${artifactPath}: HTTP ${artifactResponse.status()}`);
  }
  const artifactBytes = Buffer.from(await artifactResponse.body());
  const responseSha256 = sha256(responseBytes);
  const artifactSha256 = sha256(artifactBytes);
  if (responseSha256 !== artifactSha256) {
    throw new Error(`Published ${format.toUpperCase()} response bytes differ from saved artifact ${artifactPath}`);
  }
  const outputPath = testInfo.outputPath("artifacts", `${slug(`${jobId}-${variant}-${format}`)}.${format}`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, artifactBytes);
  return {
    bytes: artifactBytes,
    metadata: {
      responsePath: outputPath,
      artifactPath,
      responseSha256,
      artifactSha256,
      sizeBytes: artifactBytes.length,
    } satisfies ExportResponse,
  };
}

async function readPptxTextGeometry(bytes: Buffer) {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new Error(`Published PPTX is not a readable ZIP archive: ${errorMessage(error)}`);
  }
  const presentationXml = await readZipText(archive, "ppt/presentation.xml");
  const size = presentationXml.match(/<p:sldSz\b[^>]*\/?\s*>/u);
  if (!size) throw new Error("Published PPTX has no p:sldSz geometry in ppt/presentation.xml");
  const cx = readIntegerXmlAttribute(size[0], "cx", "PPTX slide cx", true);
  const cy = readIntegerXmlAttribute(size[0], "cy", "PPTX slide cy", true);
  const slideSizeCanvasPx = {
    width: pptxEmuToCanvasPixels(cx),
    height: pptxEmuToCanvasPixels(cy),
  };
  const slideFiles = Object.keys(archive.files)
    .filter((fileName) => /^ppt\/slides\/slide\d+\.xml$/u.test(fileName))
    .sort((left, right) => slideFileIndex(left) - slideFileIndex(right));
  if (slideFiles.length !== 10) throw new Error(`Published PPTX has ${slideFiles.length} native slide XML parts; expected 10`);
  const slides = await Promise.all(slideFiles.map(async (fileName) => parsePptxTextShapes(await readZipText(archive, fileName))));
  return { slideSizeCanvasPx, slides };
}

function parsePptxTextShapes(xml: string): MeasuredTextBox[] {
  const shapes = [...xml.matchAll(/<p:sp(?:\s[^>]*)?>([\s\S]*?)<\/p:sp\s*>/gu)];
  const output: MeasuredTextBox[] = [];
  for (const [index, shape] of shapes.entries()) {
    const inner = shape[1] || "";
    const textXml = inner.replace(/<a:br\b[^>]*\/?\s*>/gu, "<a:t> </a:t>");
    const paragraphs = [...textXml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p\s*>/gu)];
    const text = (paragraphs.length ? paragraphs.map((paragraph) => paragraph[1] || "") : [textXml])
      .map((paragraph) => [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t\s*>/gu)]
        .map((run) => decodeXml(run[1] || "")).join(""))
      .join(" ");
    if (normalizedTextTokens(text).length === 0) continue;
    const shapeProperties = inner.match(/<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr\s*>/u)?.[1];
    const transform = shapeProperties?.match(/<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm\s*>/u)?.[1];
    const offset = transform?.match(/<a:off\b[^>]*\/?\s*>/u)?.[0];
    const extent = transform?.match(/<a:ext\b[^>]*\/?\s*>/u)?.[0];
    if (!offset || !extent) throw new Error(`PPTX slide text shape ${index + 1} has no native x/y/cx/cy geometry`);
    const rect = {
      x: readIntegerXmlAttribute(offset, "x", `PPTX slide text shape ${index + 1} x`),
      y: readIntegerXmlAttribute(offset, "y", `PPTX slide text shape ${index + 1} y`),
      width: readIntegerXmlAttribute(extent, "cx", `PPTX slide text shape ${index + 1} cx`, true),
      height: readIntegerXmlAttribute(extent, "cy", `PPTX slide text shape ${index + 1} cy`, true),
    };
    if (Object.values(rect).some((value) => !Number.isFinite(value)) || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`PPTX slide text shape ${index + 1} has invalid native geometry`);
    }
    output.push({ text, rect, unit: "pptx-emu" });
  }
  return output;
}

function findNativeTextBox(expectedText: string, boxes: readonly MeasuredTextBox[], alreadyUsed: Set<number>) {
  const expectedTokens = normalizedTextTokens(expectedText).join(" ");
  for (const [index, box] of boxes.entries()) {
    if (!alreadyUsed.has(index) && normalizedTextTokens(box.text).join(" ") === expectedTokens) return index;
  }
  return -1;
}

async function openPdf(pdfjs: PdfJsLike, bytes: Buffer) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 });
  try {
    return await task.promise;
  } catch (error) {
    throw new Error(`BLOCKED: PDF.js could not extract text bounds from the published PDF: ${errorMessage(error)}`);
  }
}

async function loadPdfJs(): Promise<PdfJsLike> {
  let modulePath: string;
  try {
    modulePath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (error) {
    throw new Error(`BLOCKED: PDF.js text extraction is unavailable (pdfjs-dist/legacy/build/pdf.mjs could not be resolved): ${errorMessage(error)}`);
  }
  try {
    return await import(pathToFileURL(modulePath).href) as PdfJsLike;
  } catch (error) {
    throw new Error(`BLOCKED: PDF.js text extractor failed to load: ${errorMessage(error)}`);
  }
}

async function readZipText(archive: JSZip, fileName: string) {
  const file = archive.file(fileName);
  if (!file) throw new Error(`PPTX is missing required OOXML part ${fileName}`);
  return await file.async("string");
}

async function flushPartialEvidence(testInfo: TestInfo, variant: VariantEvidence) {
  const output = testInfo.outputPath("partial-evidence", `${variant.variant}-${variant.slides.length}-slides.json`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify({ variant: variant.variant, slides: variant.slides }, null, 2)}\n`, "utf8");
}

function toExportErrorEvidence(format: "pptx" | "pdf", error: unknown): ExportErrorEvidence {
  const message = errorMessage(error);
  const statusCode = message.match(/\bHTTP\s+(\d{3})\b/u)?.[1];
  const responseCode = message.match(/"code"\s*:\s*"([A-Z0-9_]+)"/u)?.[1];
  return {
    format,
    status: "failed",
    message,
    ...(statusCode ? { httpStatus: Number(statusCode) } : {}),
    ...(responseCode ? { responseCode } : {}),
  };
}

function refreshCoverage(report: HarnessReport) {
  const variants = report.templates.flatMap((template) => template.variants);
  const exportStatuses = variants.flatMap((variant) => [variant.pptxExportStatus, variant.pdfExportStatus]);
  const artifactExportAttempts = exportStatuses.filter((status) => status !== "not_attempted").length;
  const failedArtifactExports = exportStatuses.filter((status) => status === "failed").length;
  const allPlannedWorkVisited = report.templates.length === report.coverage.planned.templates
    && variants.length === report.coverage.planned.variants
    && variants.reduce((sum, variant) => sum + variant.slides.length, 0) === report.coverage.planned.slides
    && artifactExportAttempts === report.coverage.planned.artifactExports;

  report.coverage.observed = {
    templates: report.templates.length,
    variants: variants.length,
    slideRecords: variants.reduce((sum, variant) => sum + variant.slides.length, 0),
    fullyMeasuredSlides: variants.reduce((sum, variant) => (
      sum + variant.slides.filter((slide) => slide.coverageStatus === "measured").length
    ), 0),
    artifactExportAttempts,
  };
  report.coverage.failedArtifactExports = failedArtifactExports;
  report.coverage.status = !allPlannedWorkVisited
    ? "incomplete"
    : failedArtifactExports > 0
      ? "complete_with_export_failures"
      : "complete";
}

function canvasRectToPdfPointRect(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: canvasPixelsToPdfPoints(rect.x),
    y: canvasPixelsToPdfPoints(rect.y),
    width: canvasPixelsToPdfPoints(rect.width),
    height: canvasPixelsToPdfPoints(rect.height),
  };
}

function findExecutable(command: string, candidates: string[]) {
  const candidate = candidates.find((value) => existsSync(value));
  if (candidate) return candidate;
  try {
    return execFileSync("where.exe", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .find(Boolean) || null;
  } catch {
    return null;
  }
}

function findBrowserExecutable() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  return findExecutable("chrome.exe", [
    ...(configured ? [configured] : []),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\Борис.BORIS\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  ]) || findExecutable("msedge.exe", [
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Users\\Борис.BORIS\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
  ]);
}

function readToolVersion(executable: string) {
  const escapedExecutable = executable.replace(/'/gu, "''");
  const command = `$item = Get-Item -LiteralPath '${escapedExecutable}'; $version = $item.VersionInfo.ProductVersion; if (-not $version) { $version = $item.VersionInfo.FileVersion }; if ($version) { Write-Output $version } else { exit 2 }`;
  try {
    const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    const version = result.trim();
    if (version) return version;
  } catch (error) {
    const output = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr || "").trim()
      : "";
    return `unavailable (executable file-version query failed${output ? `: ${truncate(output)}` : `: ${errorMessage(error)}`})`;
  }
  return "unavailable (empty version output)";
}

function getPackageVersion(packageName: string) {
  try {
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(require("node:fs").readFileSync(manifestPath, "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

function getPdfJsPackageVersion() {
  try {
    const modulePath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const packagePath = path.resolve(path.dirname(modulePath), "../../package.json");
    const manifest = JSON.parse(require("node:fs").readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

function variantLabel(variant: LayoutVariant) {
  return variant[0]!.toUpperCase() + variant.slice(1);
}

function slug(value: string) {
  return value.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "").toLowerCase();
}

function slideFileIndex(fileName: string) {
  const index = Number(fileName.match(/slide(\d+)\.xml$/u)?.[1]);
  if (!Number.isInteger(index) || index < 1) throw new Error(`Invalid PPTX slide part name: ${fileName}`);
  return index;
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function decodeXml(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (entity, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) throw new Error(`Invalid XML entity ${entity}`);
    return String.fromCodePoint(codePoint);
  }).replace(/&[^\s;]+;/gu, (entity) => {
    throw new Error(`Unsupported OOXML entity ${entity}`);
  });
}

function readIntegerXmlAttribute(tag: string, name: string, label: string, positive = false) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}="(\\d+)"`, "u"));
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(value) || value < 0 || (positive && value === 0)) throw new Error(`${label} is missing or invalid`);
  return value;
}

function deduplicateFindings(findings: HarnessFinding[]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function truncate(value: string) {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim().slice(0, 300);
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
