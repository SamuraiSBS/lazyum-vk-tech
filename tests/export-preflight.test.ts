import { beforeAll, describe, expect, it } from "vitest";
import { runExportPreflight } from "../src/lib/export-preflight";
import { auditIssueKey } from "../src/lib/audit-actions";
import { auditPresentation } from "../src/lib/audit";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema, type PresentationDocument } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

let baseDocument: PresentationDocument;
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/mXPo5QAAAABJRU5ErkJggg==";

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

describe("export preflight", () => {
  it.each([
    "data:image/png;base64,AAAA",
    "data:image/jpeg;base64,/9j/2Q==",
  ])("blocks malformed embedded image data through the ordinary fatal audit gate: %s", (dataUrl) => {
    const document = structuredClone(baseDocument);
    const image = {
      id: "broken-image", type: "image" as const, x: 100, y: 100, w: 100, h: 100,
      alt: "Broken", dataUrl, zIndex: 30, locked: false,
    };
    document.slides[0].canvas.elements.push(image);
    const result = runExportPreflight(document);
    expect(result).toMatchObject({ ok: false, code: "AUDIT_ERRORS" });
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_IMAGE_DATA", severity: "error", elementId: image.id }),
    ]));
  });
  it("accepts a valid document and keeps non-fatal audit issues visible", () => {
    const document = structuredClone(baseDocument);
    const text = document.slides[0].canvas.elements.find((element) => element.type === "text");
    if (!text || text.type !== "text") throw new Error("Fixture does not contain a text element");
    text.fontSize = 10;
    const shape = document.slides[0].canvas.elements.find((element) => element.type === "shape");
    if (!shape || shape.type !== "shape") throw new Error("Fixture does not contain a shape element");
    shape.fill = "#123456";
    shape.stroke = "#123456";
    const snapshot = structuredClone(document);

    const result = runExportPreflight(document);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audit.slides).toHaveLength(document.slides.length);
    expect(result.issues.some((issue) => issue.severity === "warning")).toBe(true);
    expect(result.issues.some((issue) => issue.severity === "info")).toBe(true);
    expect(document).toEqual(snapshot);
  });

  it("passes a cropped image stretch warning through ordinary export preflight", () => {
    const document = structuredClone(baseDocument);
    document.slides[0].canvas.elements.push({
      id: "stretched-crop", type: "image", x: 900, y: 400, w: 100, h: 100,
      alt: "Cropped image", dataUrl: pixel,
      crop: { left: -50, right: 0, top: 0, bottom: 0 },
      zIndex: 30, locked: false,
    });

    const result = runExportPreflight(document);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audit.passed).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "IMAGE_ASPECT_DISTORTION", severity: "warning",
      slideId: document.slides[0].id, elementId: "stretched-crop",
    }));
  });

  it("blocks only fatal audit issues with a stable failure shape", () => {
    const document = structuredClone(baseDocument);
    const element = document.slides[0].canvas.elements[0];
    element.x = -1;

    const result = runExportPreflight(document);

    expect(result).toMatchObject({
      ok: false,
      code: "AUDIT_ERRORS",
      message: "Presentation export preflight found fatal audit issues",
    });
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OUTSIDE_SLIDE", severity: "error", slideId: document.slides[0].id }),
    ]));
    expect(result.audit?.passed).toBe(false);
  });

  it("blocks an overlapping title and body as a fatal render-audit collision", () => {
    const document = structuredClone(baseDocument);
    const [title, body] = document.slides[0].canvas.elements.filter((element) => element.type === "text");
    if (!title || title.type !== "text" || !body || body.type !== "text") {
      throw new Error("Fixture does not contain title and body text");
    }
    body.x = title.x;
    body.y = title.y;
    body.w = title.w;
    body.h = title.h;

    const result = runExportPreflight(document);

    expect(result).toMatchObject({ ok: false, code: "AUDIT_ERRORS" });
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ELEMENT_OVERLAP",
        severity: "error",
        slideId: document.slides[0].id,
        elementId: title.id,
      }),
    ]));
  });

  it("does not let an unverified fix decision bypass a current fatal issue", () => {
    const document = structuredClone(baseDocument);
    const element = document.slides[0].canvas.elements[0];
    element.x = -1;
    const issue = auditPresentation(document).slides[0].issues.find((candidate) => candidate.type === "OUTSIDE_SLIDE");
    if (!issue) throw new Error("Expected OUTSIDE_SLIDE issue");
    document.auditDecisions = [{
      issueKey: auditIssueKey(document.slides[0].id, issue),
      slideId: document.slides[0].id,
      elementId: issue.elementId,
      action: "fix",
      appliedAt: "2026-09-17T00:00:00.000Z",
    }];

    expect(runExportPreflight(document)).toMatchObject({ ok: false, code: "AUDIT_ERRORS" });
  });

  it("allows export for an explicitly ignored current fatal issue", () => {
    const document = structuredClone(baseDocument);
    const element = document.slides[0].canvas.elements[0];
    element.x = -1;
    const issue = auditPresentation(document).slides[0].issues.find((candidate) => candidate.type === "OUTSIDE_SLIDE");
    if (!issue) throw new Error("Expected OUTSIDE_SLIDE issue");
    document.auditDecisions = [{
      issueKey: auditIssueKey(document.slides[0].id, issue),
      slideId: document.slides[0].id,
      elementId: issue.elementId,
      action: "ignore",
      appliedAt: "2026-09-17T00:00:00.000Z",
    }];

    const result = runExportPreflight(document);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OUTSIDE_SLIDE", severity: "error", ignored: true }),
    ]));
  });

  it("returns schema failures as export preflight errors", () => {
    const result = runExportPreflight({ title: "missing presentation fields" });

    expect(result).toMatchObject({ ok: false, code: "INVALID_DOCUMENT" });
    if (result.ok) return;
    expect(result.issues.every((issue) => issue.severity === "error")).toBe(true);
  });
});
