import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  findLibreOfficeExecutable,
  getRenderTimeoutConfig,
  runBoundedProcess,
  type RenderEvidenceRuntime,
} from "./render-evidence";
import type { PresentationDocument } from "./schemas";

export const PDF_EXPORT_CONTENT_TYPE = "application/pdf";

type PdfExportRuntime = Pick<RenderEvidenceRuntime, "findRenderer" | "runProcess">;

/**
 * Convert the existing native PPTX export through the local LibreOffice
 * Impress path. The work directory and isolated LibreOffice profile are
 * always removed, including renderer failures and timeouts.
 */
export async function createPresentationPdf(
  document: PresentationDocument,
  runtime: PdfExportRuntime = {},
): Promise<Buffer> {
  let workDir: string | undefined;
  let outputDir: string | undefined;
  let outputPath: string | undefined;
  let stage = "create_work_directory";
  let processResult: { stdout: string; stderr: string; exitCode: number } | undefined;
  let inputSizeBytes: number | undefined;
  let inputSha256: string | undefined;
  let rendererBasename: string | undefined;
  try {
    workDir = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-pdf-export-"));
    const inputPath = path.join(workDir, `vk-export-${randomUUID()}.pptx`);
    // Give each LibreOffice conversion a unique source basename and a separate
    // output directory; still require the expected artifact before returning.
    outputDir = path.join(workDir, "pdf-output");
    outputPath = path.join(outputDir, `${path.parse(inputPath).name}.pdf`);
    const expectedPdfPath = outputPath;
    const profileDir = path.join(workDir, "libreoffice-profile");

    stage = "create_output_directory";
    await mkdir(outputDir, { recursive: true });
    stage = "create_libreoffice_profile";
    await mkdir(profileDir, { recursive: true });
    stage = "create_pptx";
    const { createPresentationPptx } = await import("./pptx-export");
    const input = await createPresentationPptx(document);
    inputSizeBytes = input.byteLength;
    inputSha256 = createHash("sha256").update(input).digest("hex");
    await writeFile(inputPath, input);

    stage = "find_libreoffice";
    const rendererPath = await (runtime.findRenderer ?? findLibreOfficeExecutable)();
    rendererBasename = safeFilename(path.basename(rendererPath));
    stage = "run_libreoffice";
    processResult = await (runtime.runProcess ?? runBoundedProcess)(
      rendererPath,
      [
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--headless",
        "--convert-to",
        "pdf:impress_pdf_Export",
        "--outdir",
        outputDir,
        inputPath,
      ],
      getRenderTimeoutConfig().processTimeoutMs,
      "LibreOffice PDF export",
    );
    if (processResult.exitCode !== 0) {
      stage = "libreoffice_nonzero_exit";
      throw new Error(
        `LibreOffice PDF export failed with exit code ${processResult.exitCode}: ${formatProcessError(processResult)}`,
      );
    }

    stage = "read_expected_pdf";
    const pdf = await readFile(expectedPdfPath);
    stage = "validate_pdf";
    if (pdf.length === 0 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("LibreOffice PDF export produced an invalid or empty PDF");
    }
    if (process.env.VK_HACKATHON_PDF_EXPORT_DIAGNOSTICS === "1") {
      console.error("[pdf-export-diagnostic]", JSON.stringify({
        event: "pdf_export_succeeded",
        inputSizeBytes: inputSizeBytes ?? null,
        inputSha256: inputSha256 ?? null,
        rendererBasename: rendererBasename ?? null,
        exitCode: processResult?.exitCode ?? null,
        stdout: sanitizeProcessStream(processResult?.stdout, document, workDir),
        stderr: sanitizeProcessStream(processResult?.stderr, document, workDir),
        expectedOutputFilename: safeFilename(path.basename(expectedPdfPath)),
        outputFiles: await listOutputFiles(outputDir),
      }));
    }
    return pdf;
  } catch (error) {
    const outputFiles = outputDir ? await listOutputFiles(outputDir) : [];
    console.error("[pdf-export-diagnostic]", JSON.stringify({
      event: "pdf_export_failed",
      stage,
      errorName: safeErrorField(error, "name"),
      errorCode: safeErrorField(error, "code"),
      inputSizeBytes: inputSizeBytes ?? null,
      inputSha256: inputSha256 ?? null,
      rendererBasename: rendererBasename ?? null,
      exitCode: processResult?.exitCode ?? null,
      stdout: sanitizeProcessStream(processResult?.stdout, document, workDir),
      stderr: sanitizeProcessStream(processResult?.stderr, document, workDir),
      expectedOutputFilename: outputPath ? safeFilename(path.basename(outputPath)) : null,
      outputFiles,
    }));
    throw error;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function listOutputFiles(outputDir: string): Promise<Array<{ name: string; size: number }>> {
  try {
    const entries = await readdir(outputDir, { withFileTypes: true });
    const files: Array<{ name: string; size: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(outputDir, entry.name);
      const fileStats = await stat(filePath);
      files.push({ name: safeFilename(entry.name), size: fileStats.size });
    }
    return files;
  } catch {
    return [];
  }
}

function safeFilename(value: string) {
  return /^[\w.-]{1,100}$/u.test(value) ? value : "<redacted-name>";
}

function safeErrorField(error: unknown, field: "name" | "code") {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>)[field] : undefined;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/u.test(value) ? value : "unknown";
}

function sanitizeProcessStream(
  value: string | undefined,
  document: PresentationDocument,
  workDir: string | undefined,
) {
  if (!value) return "";
  let safe = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r\n?/gu, "\n");
  if (workDir) {
    safe = safe.replace(new RegExp(escapeRegExp(workDir), "giu"), "<workDir>");
    safe = safe.replace(new RegExp(escapeRegExp(workDir.replace(/\\/gu, "/")), "giu"), "<workDir>");
  }
  safe = safe
    .replace(/(?:[A-Za-z]:\\|\/)[^\s<>"|?*]*(?:\\|\/)[^\s<>"|?*]*/gu, "<path>")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer <redacted>")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/giu, "$1=<redacted>")
    .replace(/data:[^\s,;]+/giu, "<data-redacted>");
  for (const token of collectSlideTextTokens(document)) {
    safe = safe.replace(new RegExp(escapeRegExp(token), "giu"), "<slide-text>");
  }
  return safe.slice(0, 1_200);
}

function collectSlideTextTokens(document: PresentationDocument) {
  const strings = [document.title];
  for (const slide of document.slides) {
    for (const element of slide.canvas.elements) {
      if (element.type === "text") strings.push(element.text);
    }
  }
  const tokens = new Set<string>();
  for (const value of strings) {
    for (const token of value.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) tokens.add(token);
  }
  return [...tokens].sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function formatProcessError(result: { stdout: string; stderr: string }) {
  return `${result.stderr.trim()} ${result.stdout.trim()}`.trim() || "no diagnostic output";
}
