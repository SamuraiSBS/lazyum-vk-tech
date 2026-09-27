import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findLibreOfficeExecutable,
  getRenderTimeoutConfig,
  renderPptxToPngs,
  RENDER_TIMEOUT_LIMITS,
  runBoundedProcess,
} from "../src/lib/render-evidence";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("render evidence adapter", () => {
  it("returns every slide with deterministic file metadata", async () => {
    const root = await testRoot();
    const inputPath = path.join(root, "template.pptx");
    const outputDir = path.join(root, "renders");
    await writeFile(inputPath, Buffer.from("pptx fixture"));

    const result = await renderPptxToPngs(inputPath, { outputDir, width: 900, height: 1_600 }, {
      findRenderer: async () => "C:\\LibreOffice\\soffice.com",
      findRasterizer: async () => "C:\\Poppler\\pdftoppm.exe",
      findPageCounter: async () => "C:\\Poppler\\pdfinfo.exe",
      runProcess: async (_command, args, _timeoutMs, label) => {
        if (label === "LibreOffice version check") return { stdout: "LibreOffice 26.8.0.3\n", stderr: "", exitCode: 0 };
        if (label === "LibreOffice PPTX conversion") {
          const pdfPath = path.join(args[5], "template.pdf");
          await mkdir(path.dirname(pdfPath), { recursive: true });
          await writeFile(pdfPath, Buffer.from("%PDF-1.7 deterministic fixture"));
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (label === "Poppler PDF page count") return { stdout: "Pages:           2\n", stderr: "", exitCode: 0 };
        const outputPath = args[args.length - 1] + ".png";
        await writeFile(outputPath, Buffer.from("PNG slide " + args[3]));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.slideCount).toBe(2);
    expect(result.slides).toHaveLength(2);
    expect(result.slides.map((slide) => path.basename(slide.outputPath))).toEqual(["slide-1.png", "slide-2.png"]);
    expect(result.slides.every((slide) => slide.outputBytes > 0)).toBe(true);
    expect(result.slides.every((slide) => /^[0-9a-f]{64}$/.test(slide.outputSha256))).toBe(true);
    expect(result.pdfBytes).toBeGreaterThan(0);
    expect(result.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a missing LibreOffice renderer explicitly", async () => {
    const missingRoot = await testRoot();
    vi.stubEnv("ProgramFiles", missingRoot);
    vi.stubEnv("ProgramFiles(x86)", missingRoot);
    vi.stubEnv("PATH", missingRoot);

    await expect(findLibreOfficeExecutable()).rejects.toMatchObject({
      name: "RenderEvidenceError",
      code: "renderer_unavailable",
    });
  });

  it("enforces a bounded process timeout", async () => {
    await expect(runBoundedProcess(
      process.execPath,
      ["-e", "setTimeout(() => undefined, 1000)"],
      25,
      "test renderer",
    )).rejects.toMatchObject({ code: "timeout" });
  });

  it("keeps job and child-process timeouts separate", async () => {
    const root = await testRoot();
    const inputPath = path.join(root, "template.pptx");
    const outputDir = path.join(root, "renders");
    const processTimeouts: number[] = [];
    await writeFile(inputPath, Buffer.from("pptx fixture"));

    await renderPptxToPngs(inputPath, {
      outputDir,
      jobTimeoutMs: RENDER_TIMEOUT_LIMITS.job.minMs,
      processTimeoutMs: RENDER_TIMEOUT_LIMITS.process.minMs,
    }, {
      findRenderer: async () => "C:\\LibreOffice\\soffice.com",
      findRasterizer: async () => "C:\\Poppler\\pdftoppm.exe",
      findPageCounter: async () => "C:\\Poppler\\pdfinfo.exe",
      runProcess: async (_command, args, timeoutMs, label) => {
        processTimeouts.push(timeoutMs);
        if (label === "LibreOffice version check") return { stdout: "LibreOffice 26.8.0.3\n", stderr: "", exitCode: 0 };
        if (label === "LibreOffice PPTX conversion") {
          await writeFile(path.join(args[5], "template.pdf"), Buffer.from("%PDF-1.7 deterministic fixture"));
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (label === "Poppler PDF page count") return { stdout: "Pages:           2\n", stderr: "", exitCode: 0 };
        await writeFile(args[args.length - 1] + ".png", Buffer.from("PNG slide " + args[3]));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(processTimeouts).toEqual([
      RENDER_TIMEOUT_LIMITS.process.minMs,
      RENDER_TIMEOUT_LIMITS.process.minMs,
      RENDER_TIMEOUT_LIMITS.process.minMs,
      RENDER_TIMEOUT_LIMITS.process.minMs,
      RENDER_TIMEOUT_LIMITS.process.minMs,
    ]);
  });

  it("bounds the configured overall timeout", () => {
    expect(getRenderTimeoutConfig({ VK_HACKATHON_RENDER_TIMEOUT_MS: "120000" })).toEqual({
      jobTimeoutMs: 120_000,
      processTimeoutMs: RENDER_TIMEOUT_LIMITS.process.defaultMs,
    });
    expect(() => getRenderTimeoutConfig({ VK_HACKATHON_RENDER_TIMEOUT_MS: "59999" })).toThrow(
      /VK_HACKATHON_RENDER_TIMEOUT_MS must be an integer/,
    );
    expect(() => getRenderTimeoutConfig({ VK_HACKATHON_RENDER_TIMEOUT_MS: "900001" })).toThrow(
      /VK_HACKATHON_RENDER_TIMEOUT_MS must be an integer/,
    );
  });
});

async function testRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-render-evidence-"));
  roots.push(root);
  return root;
}
