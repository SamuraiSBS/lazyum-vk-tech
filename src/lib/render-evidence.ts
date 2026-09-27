import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export const RENDER_TIMEOUT_LIMITS = {
  job: { defaultMs: 300_000, minMs: 60_000, maxMs: 900_000 },
  process: { defaultMs: 60_000, minMs: 5_000, maxMs: 120_000 },
} as const;
const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 1_600;

export type RenderEvidenceErrorCode =
  | "invalid_input"
  | "renderer_unavailable"
  | "timeout"
  | "render_failed"
  | "output_invalid";

export class RenderEvidenceError extends Error {
  readonly code: RenderEvidenceErrorCode;

  constructor(code: RenderEvidenceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RenderEvidenceError";
    this.code = code;
  }
}

export interface RenderPptxToPngOptions {
  outputDir?: string;
  /** Backwards-compatible alias for the bounded overall render job timeout. */
  timeoutMs?: number;
  jobTimeoutMs?: number;
  processTimeoutMs?: number;
  slideNumber?: number;
  width?: number;
  height?: number;
}

export interface RenderTimeoutConfig {
  jobTimeoutMs: number;
  processTimeoutMs: number;
}

export interface RenderEvidence {
  renderer: "libreoffice-impress-headless";
  rendererPath: string;
  rendererVersion: string;
  rasterizer: "poppler-pdftoppm";
  rasterizerPath: string;
  pageCounter: "poppler-pdfinfo";
  pageCounterPath: string;
  inputPath: string;
  pdfPath: string;
  pdfBytes: number;
  pdfSha256: string;
  outputPath: string;
  outputFormat: "png";
  slideNumber: number;
  slideCount: number;
  width: number;
  height: number;
  outputBytes: number;
  outputSha256: string;
}

export interface RenderEvidenceBundle {
  renderer: "libreoffice-impress-headless";
  rendererPath: string;
  rendererVersion: string;
  rasterizer: "poppler-pdftoppm";
  rasterizerPath: string;
  pageCounter: "poppler-pdfinfo";
  pageCounterPath: string;
  inputPath: string;
  pdfPath: string;
  pdfBytes: number;
  pdfSha256: string;
  outputFormat: "png";
  slideCount: number;
  width: number;
  height: number;
  slides: Array<{
    outputPath: string;
    outputFormat: "png";
    slideNumber: number;
    outputBytes: number;
    outputSha256: string;
  }>;
}

type ProcessResult = { stdout: string; stderr: string; exitCode: number };
type ProcessRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
) => Promise<ProcessResult>;

export interface RenderEvidenceRuntime {
  findRenderer?: () => Promise<string>;
  findRasterizer?: () => Promise<string>;
  findPageCounter?: () => Promise<string>;
  runProcess?: ProcessRunner;
}

/**
 * Render every slide through LibreOffice's real Impress export, then
 * rasterize each PDF page with the already-installed Poppler CLI.
 */
export async function renderPptxToPngs(
  inputPath: string,
  options: RenderPptxToPngOptions = {},
  runtime: RenderEvidenceRuntime = {},
): Promise<RenderEvidenceBundle> {
  return renderPptx(inputPath, options, undefined, runtime);
}

/**
 * Render one PPTX slide through the same LibreOffice → PDF → Poppler path.
 * Kept as a compatibility helper for focused render checks.
 */
export async function renderPptxToPng(
  inputPath: string,
  options: RenderPptxToPngOptions = {},
  runtime: RenderEvidenceRuntime = {},
): Promise<RenderEvidence> {
  const slideNumber = validatePositiveInteger(options.slideNumber ?? 1, "slideNumber");
  const bundle = await renderPptx(inputPath, options, [slideNumber], runtime);
  const slide = bundle.slides[0];
  return {
    renderer: bundle.renderer,
    rendererPath: bundle.rendererPath,
    rendererVersion: bundle.rendererVersion,
    rasterizer: bundle.rasterizer,
    rasterizerPath: bundle.rasterizerPath,
    pageCounter: bundle.pageCounter,
    pageCounterPath: bundle.pageCounterPath,
    inputPath: bundle.inputPath,
    pdfPath: bundle.pdfPath,
    pdfBytes: bundle.pdfBytes,
    pdfSha256: bundle.pdfSha256,
    outputPath: slide.outputPath,
    outputFormat: slide.outputFormat,
    slideNumber: slide.slideNumber,
    slideCount: bundle.slideCount,
    width: bundle.width,
    height: bundle.height,
    outputBytes: slide.outputBytes,
    outputSha256: slide.outputSha256,
  };
}

async function renderPptx(
  inputPath: string,
  options: RenderPptxToPngOptions,
  requestedSlides: number[] | undefined,
  runtime: RenderEvidenceRuntime,
): Promise<RenderEvidenceBundle> {
  const input = await validateInputPath(inputPath);
  const timeoutConfig = getRenderTimeoutConfig();
  const jobTimeoutMs = validateBoundedTimeout(
    options.jobTimeoutMs ?? options.timeoutMs ?? timeoutConfig.jobTimeoutMs,
    "jobTimeoutMs",
    RENDER_TIMEOUT_LIMITS.job,
  );
  const processTimeoutMs = validateBoundedTimeout(
    options.processTimeoutMs ?? timeoutConfig.processTimeoutMs,
    "processTimeoutMs",
    RENDER_TIMEOUT_LIMITS.process,
  );
  const width = validatePositiveInteger(options.width ?? DEFAULT_WIDTH, "width");
  const height = validatePositiveInteger(options.height ?? DEFAULT_HEIGHT, "height");
  const deadline = Date.now() + jobTimeoutMs;
  const outputDir = await prepareOutputDirectory(options.outputDir);
  const findRenderer = runtime.findRenderer ?? findLibreOfficeExecutable;
  const findRasterizer = runtime.findRasterizer ?? (() => findExecutable("pdftoppm.exe", "pdftoppm"));
  const findPageCounter = runtime.findPageCounter ?? (() => findExecutable("pdfinfo.exe", "pdfinfo"));
  const runProcess = runtime.runProcess ?? runBoundedProcess;
  const rendererPath = await findRenderer();
  const rasterizerPath = await findRasterizer();
  const pageCounterPath = await findPageCounter();
  const pdfPath = safeChildPath(outputDir, `${path.basename(input, path.extname(input))}.pdf`);
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-lo-profile-"));
  const stage = { processTimeoutMs, deadline, jobTimeoutMs, runProcess };

  try {
    assertJobDeadline(deadline, jobTimeoutMs);
    const rendererVersion = await getLibreOfficeVersion(rendererPath, stage);
    await runLibreOfficeConvert({
      rendererPath,
      inputPath: input,
      outputDir,
      profileDir,
      stage,
    });

    const pdfBuffer = await readNonEmptyFile(pdfPath, "LibreOffice reported success but did not create the PDF");
    assertJobDeadline(deadline, jobTimeoutMs);
    const slideCount = await getPdfPageCount(pdfPath, pageCounterPath, stage);
    const slideNumbers = requestedSlides ?? Array.from({ length: slideCount }, (_, index) => index + 1);
    if (slideNumbers.some((slideNumber) => slideNumber > slideCount)) {
      const requested = slideNumbers.find((slideNumber) => slideNumber > slideCount);
      throw new RenderEvidenceError(
        "invalid_input",
        `Requested slide ${requested}, but the rendered PDF has ${slideCount} pages`,
      );
    }

    const slides: RenderEvidenceBundle["slides"] = [];
    for (const slideNumber of slideNumbers) {
      assertJobDeadline(deadline, jobTimeoutMs);
      const outputPath = safeChildPath(outputDir, `slide-${slideNumber}.png`);
      const outputPrefix = outputPath.slice(0, -path.extname(outputPath).length);
      await runPopplerRasterize({
        rasterizerPath,
        pdfPath,
        outputPrefix,
        slideNumber,
        width,
        height,
        stage,
      });
      const pngBuffer = await readNonEmptyFile(outputPath, "Poppler reported success but did not create the PNG");
      slides.push({
        outputPath,
        outputFormat: "png",
        slideNumber,
        outputBytes: pngBuffer.length,
        outputSha256: sha256(pngBuffer),
      });
    }

    return {
      renderer: "libreoffice-impress-headless",
      rendererPath,
      rendererVersion,
      rasterizer: "poppler-pdftoppm",
      rasterizerPath,
      pageCounter: "poppler-pdfinfo",
      pageCounterPath,
      inputPath: input,
      pdfPath,
      pdfBytes: pdfBuffer.length,
      pdfSha256: sha256(pdfBuffer),
      outputFormat: "png",
      slideCount,
      width,
      height,
      slides,
    };
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function getRenderTimeoutConfig(
  env: { VK_HACKATHON_RENDER_TIMEOUT_MS?: string } | NodeJS.ProcessEnv = process.env,
): RenderTimeoutConfig {
  return {
    jobTimeoutMs: parseConfiguredTimeout(
      env.VK_HACKATHON_RENDER_TIMEOUT_MS,
      "VK_HACKATHON_RENDER_TIMEOUT_MS",
      RENDER_TIMEOUT_LIMITS.job,
    ),
    processTimeoutMs: RENDER_TIMEOUT_LIMITS.process.defaultMs,
  };
}

export async function findLibreOfficeExecutable(): Promise<string> {
  if (process.platform !== "win32") return findExecutable("soffice", "soffice");

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    path.join(programFiles, "LibreOffice", "program", "soffice.com"),
    path.join(programFilesX86, "LibreOffice", "program", "soffice.com"),
    path.join(programFiles, "LibreOffice", "program", "soffice.exe"),
    path.join(programFilesX86, "LibreOffice", "program", "soffice.exe"),
  ];

  for (const candidate of [...new Set(candidates)]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next known installation path, then PATH.
    }
  }
  return findExecutable("soffice.com", "soffice");
}

async function findExecutable(windowsName: string, posixName: string): Promise<string> {
  const name = process.platform === "win32" ? windowsName : posixName;
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through PATH entries.
    }
  }
  throw new RenderEvidenceError(
    "renderer_unavailable",
    `${posixName} was not found. Install or expose the required local renderer dependency before running render smoke.`,
  );
}

type RenderStage = {
  processTimeoutMs: number;
  deadline: number;
  jobTimeoutMs: number;
  runProcess: ProcessRunner;
};

async function getLibreOfficeVersion(rendererPath: string, stage: RenderStage): Promise<string> {
  const result = await runStage(stage, rendererPath, ["--headless", "--version"], "LibreOffice version check");
  if (result.exitCode !== 0) {
    throw new RenderEvidenceError(
      "renderer_unavailable",
      `LibreOffice version check failed with exit code ${result.exitCode}: ${formatProcessError(result)}`,
    );
  }
  const version = result.stdout.trim().split(/\r?\n/).find(Boolean);
  if (!version) throw new RenderEvidenceError("renderer_unavailable", "LibreOffice returned no version");
  return version;
}

async function runLibreOfficeConvert(input: {
  rendererPath: string;
  inputPath: string;
  outputDir: string;
  profileDir: string;
  stage: RenderStage;
}) {
  const result = await runStage(input.stage,
    input.rendererPath,
    [
      `-env:UserInstallation=${pathToFileURL(input.profileDir).href}`,
      "--headless",
      "--convert-to",
      "pdf:impress_pdf_Export",
      "--outdir",
      input.outputDir,
      input.inputPath,
    ],
    "LibreOffice PPTX conversion",
  );
  if (result.exitCode !== 0) {
    throw new RenderEvidenceError(
      "render_failed",
      `LibreOffice PPTX conversion failed with exit code ${result.exitCode}: ${formatProcessError(result)}`,
    );
  }
}

async function runPopplerRasterize(input: {
  rasterizerPath: string;
  pdfPath: string;
  outputPrefix: string;
  slideNumber: number;
  width: number;
  height: number;
  stage: RenderStage;
}) {
  const result = await runStage(input.stage,
    input.rasterizerPath,
    [
      "-png",
      "-f",
      String(input.slideNumber),
      "-l",
      String(input.slideNumber),
      "-singlefile",
      "-scale-to-x",
      String(input.width),
      "-scale-to-y",
      String(input.height),
      input.pdfPath,
      input.outputPrefix,
    ],
    "Poppler PDF rasterization",
  );
  if (result.exitCode !== 0) {
    throw new RenderEvidenceError(
      "render_failed",
      `Poppler PDF rasterization failed with exit code ${result.exitCode}: ${formatProcessError(result)}`,
    );
  }
}

async function getPdfPageCount(
  pdfPath: string,
  pageCounterPath: string,
  stage: RenderStage,
): Promise<number> {
  const result = await runStage(stage, pageCounterPath, [pdfPath], "Poppler PDF page count");
  if (result.exitCode !== 0) {
    throw new RenderEvidenceError(
      "render_failed",
      `Poppler pdfinfo failed with exit code ${result.exitCode}: ${formatProcessError(result)}`,
    );
  }
  const pageMatch = /(?:^|\r?\n)Pages:\s+(\d+)\s*(?:$|\r?\n)/i.exec(result.stdout);
  const pageCount = pageMatch ? Number(pageMatch[1]) : NaN;
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new RenderEvidenceError("output_invalid", `Poppler pdfinfo did not report a valid page count for ${pdfPath}`);
  }
  return pageCount;
}

async function validateInputPath(inputPath: string) {
  const resolved = path.resolve(inputPath);
  if (path.extname(resolved).toLowerCase() !== ".pptx") {
    throw new RenderEvidenceError("invalid_input", `Renderer input must be a .pptx file: ${resolved}`);
  }
  try {
    if (!(await stat(resolved)).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new RenderEvidenceError("invalid_input", `PPTX fixture does not exist: ${resolved}`, { cause: error });
  }
  return resolved;
}

async function prepareOutputDirectory(outputDir?: string) {
  const resolved = outputDir
    ? path.resolve(outputDir)
    : await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-render-"));
  await mkdir(resolved, { recursive: true });
  return resolved;
}

function safeChildPath(directory: string, fileName: string) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedFile = path.resolve(resolvedDirectory, fileName);
  const relative = path.relative(resolvedDirectory, resolvedFile);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RenderEvidenceError("invalid_input", "Renderer output path escapes its output directory");
  }
  return resolvedFile;
}

function validatePositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RenderEvidenceError("invalid_input", `${name} must be a positive integer`);
  }
  return value;
}

function assertJobDeadline(deadline: number, jobTimeoutMs: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new RenderEvidenceError("timeout", `PPTX render job exceeded the configured ${jobTimeoutMs} ms timeout`);
  }
  return remaining;
}

async function runStage(
  stage: RenderStage,
  command: string,
  args: string[],
  label: string,
): Promise<ProcessResult> {
  const remaining = assertJobDeadline(stage.deadline, stage.jobTimeoutMs);
  const controller = new AbortController();
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  let jobTimedOut = false;
  const jobTimeout = new Promise<never>((_, reject) => {
    jobTimer = setTimeout(() => {
      jobTimedOut = true;
      controller.abort();
      reject(new RenderEvidenceError(
        "timeout",
        `PPTX render job exceeded the configured ${stage.jobTimeoutMs} ms timeout`,
      ));
    }, remaining);
  });

  try {
    return await Promise.race([
      stage.runProcess(command, args, stage.processTimeoutMs, label, controller.signal),
      jobTimeout,
    ]);
  } catch (error) {
    if (jobTimedOut || controller.signal.aborted) {
      throw new RenderEvidenceError(
        "timeout",
        `PPTX render job exceeded the configured ${stage.jobTimeoutMs} ms timeout`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (jobTimer) clearTimeout(jobTimer);
  }
}

async function readNonEmptyFile(filePath: string, missingMessage: string) {
  try {
    const buffer = await readFile(filePath);
    if (buffer.length <= 0) throw new Error("empty file");
    return buffer;
  } catch (error) {
    throw new RenderEvidenceError("output_invalid", `${missingMessage}: ${filePath}`, { cause: error });
  }
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function runBoundedProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
) {
  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new RenderEvidenceError("renderer_unavailable", `${label} process could not start`, { cause: error }));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      reject(new RenderEvidenceError("timeout", `${label} was aborted by the render job timeout`));
    }
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      reject(new RenderEvidenceError("timeout", `${label} exceeded the ${timeoutMs} ms timeout`));
    }, timeoutMs);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RenderEvidenceError("renderer_unavailable", `${label} process could not start`, { cause: error }));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? -1,
      });
    });
  });
}

function parseConfiguredTimeout(
  raw: string | undefined,
  name: string,
  limits: { defaultMs: number; minMs: number; maxMs: number },
) {
  if (raw === undefined || raw.trim() === "") return limits.defaultMs;
  if (!/^\d+$/.test(raw.trim())) {
    throw new RenderEvidenceError(
      "invalid_input",
      `${name} must be an integer between ${limits.minMs} and ${limits.maxMs} ms`,
    );
  }
  return validateBoundedTimeout(Number(raw), name, limits);
}

function validateBoundedTimeout(
  value: number,
  name: string,
  limits: { minMs: number; maxMs: number },
) {
  if (!Number.isSafeInteger(value) || value < limits.minMs || value > limits.maxMs) {
    throw new RenderEvidenceError(
      "invalid_input",
      `${name} must be an integer between ${limits.minMs} and ${limits.maxMs} ms`,
    );
  }
  return value;
}

function formatProcessError(result: { stdout: string; stderr: string }) {
  return `${result.stderr.trim()} ${result.stdout.trim()}`.trim() || "no diagnostic output";
}
