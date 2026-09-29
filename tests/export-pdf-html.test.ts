import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

vi.mock("../src/lib/request-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/request-guards")>();
  const guard = actual.createProcessRequestGuard({
    maxGenerationRequestsPerWindow: 100,
    maxExportRequestsPerWindow: 100,
  });
  return {
    ...actual,
    acquireHeavyOperation: (operationClass: "generation" | "export") => guard.acquireHeavyOperation(operationClass),
  };
});

import { POST as postHtml } from "../src/app/api/export/html/route";
import { POST as postPdf } from "../src/app/api/export/pdf/route";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { createPresentationPdf } from "../src/lib/pdf-export";
import { presentationDocumentSchema, type PresentationDocument } from "../src/lib/schemas";
import { REQUEST_BODY_LIMITS } from "../src/lib/request-guards";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

let baseDocument: PresentationDocument;

beforeAll(async () => {
  const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
  const content = await normalizeContent("Русская презентация сервиса VK", [{
    name: "materials.txt",
    type: "text/plain",
    buffer: Buffer.from("Сервис помогает командам быстрее согласовывать решения."),
  }]);
  const plan = await createPresentationPlan(content, 5);
  baseDocument = presentationDocumentSchema.parse(renderPresentation(design, plan));
});

describe("POST /api/export/pdf and /api/export/html", () => {
  it("rejects oversized declared JSON bodies on both routes before parsing", async () => {
    const makeOversizedRequest = (url: string) => new Request(url, {
      method: "POST",
      headers: {
        "content-length": String(REQUEST_BODY_LIMITS.export + 1),
        "content-type": "application/json",
      },
      body: "not json",
    });
    const pdfResponse = await postPdf(makeOversizedRequest("http://localhost/api/export/pdf"));
    const htmlResponse = await postHtml(makeOversizedRequest("http://localhost/api/export/html"));

    expect(pdfResponse.status).toBe(413);
    expect(await pdfResponse.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(htmlResponse.status).toBe(413);
    expect(await htmlResponse.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("returns a non-empty PDF with a bounded-export response contract", async () => {
    const response = await postPdf(createRequest({ ...baseDocument, title: "Русский экспорт" }));
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="presentation.pdf"; filename*=UTF-8''${encodeURIComponent("Русский-экспорт.pdf")}`,
    );
    expect(body.byteLength).toBeGreaterThan(0);
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 90_000);

  it("returns standalone HTML for every slide with escaped content and source geometry", async () => {
    const document = structuredClone(baseDocument);
    document.title = "Экспорт <тест>";
    const text = document.slides[0].canvas.elements.find((element) => element.type === "text");
    if (!text || text.type !== "text") throw new Error("Fixture does not contain a text element");
    text.text = "<x>&\"'";
    const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    document.slides[0].canvas.elements.push({
      id: "inline-data-image",
      type: "image",
      x: document.slides[0].canvas.width - 48,
      y: document.slides[0].canvas.height - 40,
      w: 32,
      h: 24,
      alt: "<image>",
      dataUrl: imageDataUrl,
      zIndex: 999,
      locked: false,
    });

    const response = await postHtml(createRequest(document));
    const html = await response.text();

    expect(response.status, html.slice(0, 2000)).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="presentation.html"; filename*=UTF-8''${encodeURIComponent("Экспорт-тест.html")}`,
    );
    expect(html).toContain(`data-slide-count="${document.slides.length}"`);
    expect((html.match(/data-slide-order=/g) || []).length).toBe(document.slides.length);
    expect(html).toContain(`data-slide-width="${document.slides[0].canvas.width}"`);
    expect(html).toContain(`data-slide-height="${document.slides[0].canvas.height}"`);
    expect(html).toContain("&lt;x&gt;&amp;&quot;&#39;");
    expect(html).not.toContain("<x>&\"'");
    expect(html).toContain(imageDataUrl);
    expect(html).toContain("element-shape");
    expect(html).toContain("element-image");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link\b|https?:\/\//iu);
  });

  it("returns HTTP 422 with structured preflight issues for a fatal audit finding", async () => {
    const document = structuredClone(baseDocument);
    document.slides[0].canvas.elements[0].x = -1;

    const response = await postHtml(createRequest(document));
    const payload = await response.json() as {
      error: { code: string; reason: string; issues: Array<{ code: string; severity: string }> };
    };

    expect(response.status).toBe(422);
    expect(payload).toMatchObject({
      error: {
        code: "EXPORT_PREFLIGHT_FAILED",
        reason: "AUDIT_ERRORS",
      },
    });
    expect(payload.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OUTSIDE_SLIDE", severity: "error" }),
    ]));
  });
});

describe("createPresentationPdf", () => {
  it("emits opt-in success diagnostics with input identity and bounded metadata", async () => {
    const previousSetting = process.env.VK_HACKATHON_PDF_EXPORT_DIAGNOSTICS;
    process.env.VK_HACKATHON_PDF_EXPORT_DIAGNOSTICS = "1";
    const diagnosticSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const expectedPdf = Buffer.from("%PDF-1.7\nsynthetic PDF fixture\n", "ascii");
    let observedInput: { sizeBytes: number; sha256: string } | undefined;

    try {
      await createPresentationPdf(baseDocument, {
        findRenderer: async () => "C:\\Program Files\\LibreOffice\\program\\soffice.com",
        runProcess: async (_command, args) => {
          const inputPath = args.at(-1)!;
          const input = await readFile(inputPath);
          observedInput = {
            sizeBytes: input.byteLength,
            sha256: createHash("sha256").update(input).digest("hex"),
          };
          const outputDirectory = args[args.indexOf("--outdir") + 1]!;
          await writeFile(path.join(outputDirectory, `${path.parse(inputPath).name}.pdf`), expectedPdf);
          return {
            stdout: `${inputPath} ${baseDocument.title} converted`,
            stderr: "renderer warning",
            exitCode: 0,
          };
        },
      });

      const diagnosticCall = diagnosticSpy.mock.calls.find(([prefix]) => prefix === "[pdf-export-diagnostic]");
      expect(diagnosticCall).toBeDefined();
      const event = JSON.parse(String(diagnosticCall?.[1])) as Record<string, unknown>;
      expect(event).toMatchObject({
        event: "pdf_export_succeeded",
        rendererBasename: "soffice.com",
        exitCode: 0,
        expectedOutputFilename: expect.stringMatching(/^vk-export-[0-9a-f-]{36}\.pdf$/iu),
        stderr: "renderer warning",
        outputFiles: [{
          name: expect.stringMatching(/^vk-export-[0-9a-f-]{36}\.pdf$/iu),
          size: expectedPdf.byteLength,
        }],
      });
      expect(observedInput).toMatchObject({
        sizeBytes: event.inputSizeBytes,
        sha256: event.inputSha256,
      });
      expect(String(event.stdout)).not.toContain(baseDocument.title);
      expect(String(event.stdout).length).toBeLessThanOrEqual(1_200);
    } finally {
      if (previousSetting === undefined) delete process.env.VK_HACKATHON_PDF_EXPORT_DIAGNOSTICS;
      else process.env.VK_HACKATHON_PDF_EXPORT_DIAGNOSTICS = previousSetting;
      diagnosticSpy.mockRestore();
    }
  });

  it("uses a unique PPTX basename and separate LibreOffice output directory per export", async () => {
    const expectedPdf = Buffer.from("%PDF-1.7\nsynthetic PDF fixture\n", "ascii");
    const processCalls: string[][] = [];

    const runtime = {
      findRenderer: async () => "soffice.com",
      runProcess: async (_command: string, args: string[], _timeoutMs: number, _label: string, _signal?: AbortSignal) => {
        processCalls.push(args);
        const outputDirectory = args[args.indexOf("--outdir") + 1];
        if (!outputDirectory) throw new Error("PDF exporter omitted the LibreOffice output directory");
        const inputPath = args.at(-1);
        if (!inputPath) throw new Error("PDF exporter omitted the LibreOffice input file");
        await writeFile(path.join(outputDirectory, `${path.parse(inputPath).name}.pdf`), expectedPdf);
        return { stdout: "converted", stderr: "", exitCode: 0 };
      },
    };

    const firstPdf = await createPresentationPdf(baseDocument, runtime);
    const secondPdf = await createPresentationPdf(baseDocument, runtime);

    const inputPaths = processCalls.map((args) => args.at(-1)!);
    const outputDirectories = processCalls.map((args) => args[args.indexOf("--outdir") + 1]!);
    expect(inputPaths).toHaveLength(2);
    expect(inputPaths.map((inputPath) => path.basename(inputPath))).toEqual([
      expect.stringMatching(/^vk-export-[0-9a-f-]{36}\.pptx$/iu),
      expect.stringMatching(/^vk-export-[0-9a-f-]{36}\.pptx$/iu),
    ]);
    expect(new Set(inputPaths).size).toBe(2);
    expect(outputDirectories).toEqual(inputPaths.map((inputPath) => path.join(path.dirname(inputPath), "pdf-output")));
    expect([firstPdf, secondPdf]).toEqual([expectedPdf, expectedPdf]);
  });

  it("rejects a zero-exit LibreOffice result when no PDF was created", async () => {
    await expect(createPresentationPdf(baseDocument, {
      findRenderer: async () => "soffice.com",
      runProcess: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createRequest(document: PresentationDocument) {
  return new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(document),
  });
}
