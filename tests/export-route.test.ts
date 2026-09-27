import JSZip from "jszip";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

import { POST } from "../src/app/api/export/route";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { createPresentationPptx } from "../src/lib/pptx-export";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema, type PresentationDocument } from "../src/lib/schemas";
import { REQUEST_BODY_LIMITS } from "../src/lib/request-guards";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

const pptxContentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
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

describe("POST /api/export", () => {
  it("rejects an oversized declared JSON body before parsing or exporting", async () => {
    const response = await POST(new Request("http://localhost/api/export", {
      method: "POST",
      headers: {
        "content-length": String(REQUEST_BODY_LIMITS.export + 1),
        "content-type": "application/json",
      },
      body: "not json",
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("downloads a valid PPTX with an HTTP-safe Cyrillic filename", async () => {
    const title = "Русская презентация";
    const response = await POST(createRequest({ ...baseDocument, title }));
    const body = Buffer.from(await response.arrayBuffer());
    const archive = await JSZip.loadAsync(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(pptxContentType);
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="presentation.pptx"; filename*=UTF-8''${encodeURIComponent("Русская-презентация.pptx")}`,
    );
    expect(response.headers.get("content-disposition")).toMatch(/^[\x00-\x7F]*$/u);
    expect(body.subarray(0, 4).toString("binary")).toBe("PK\x03\x04");
    expect(archive.files["[Content_Types].xml"]).toBeDefined();
    expect(archive.files["ppt/presentation.xml"]).toBeDefined();
    expect(archive.files["ppt/slides/slide1.xml"]).toBeDefined();
  });

  it("keeps ASCII filenames unchanged while adding the encoded filename parameter", async () => {
    const title = "VK Tech deck";
    const response = await POST(createRequest({ ...baseDocument, title }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="VK-Tech-deck.pptx"; filename*=UTF-8''VK-Tech-deck.pptx`,
    );
    expect(response.headers.get("content-type")).toBe(pptxContentType);
  });

  it("blocks export with HTTP 422 when the current audit has a fatal issue", async () => {
    const document = structuredClone(baseDocument);
    document.slides[0].canvas.elements[0].x = -1;

    const response = await POST(createRequest(document));
    const payload = await response.json() as {
      error: { code: string; reason: string; issues: Array<{ code: string; severity: string }> };
    };

    expect(response.status).toBe(422);
    expect(payload).toMatchObject({
      error: {
        code: "EXPORT_PREFLIGHT_FAILED",
        reason: "AUDIT_ERRORS",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "OUTSIDE_SLIDE", severity: "error" }),
        ]),
      },
    });
  });
});

function createRequest(document: PresentationDocument) {
  return new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(document),
  });
}
