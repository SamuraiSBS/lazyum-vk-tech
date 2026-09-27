import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { createStandaloneHtml } from "../src/lib/html-export";
import { createPresentationPptx } from "../src/lib/pptx-export";
import {
  canvasElementSchema,
  presentationDocumentSchema,
  type PresentationDocument,
} from "../src/lib/schemas";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

let baseDocument: PresentationDocument;

beforeAll(async () => {
  const design = await parsePptxTemplate(await createFixtureTemplate("bright"), "fixture-template.pptx");
  const content = await normalizeContent("Табличный экспорт VK", []);
  baseDocument = presentationDocumentSchema.parse(renderPresentation(design, await createPresentationPlan(content, 5)));
});

function tableElement() {
  return {
    id: "native-table",
    type: "table" as const,
    x: 120,
    y: 160,
    w: 720,
    h: 180,
    rows: [
      [
        { text: "Показатель", fill: "#112233", color: "#FFFFFF", align: "left" as const, border: { color: "#445566", width: 1 } },
        { text: "Значение", fill: "#112233", color: "#FFFFFF", align: "center" as const, border: { color: "#445566", width: 1 } },
      ],
      [
        { text: "<выручка>&\"'", fill: "#FFFFFF", color: "#000000", align: "left" as const, border: { color: "#445566", width: 1 } },
        { text: "42", fill: "#FFFFFF", color: "#000000", align: "right" as const, border: { color: "#445566", width: 1 } },
      ],
    ],
    fontFamily: "Arial",
    fontSize: 18,
    fontWeight: 400,
    zIndex: 999,
    locked: false,
  };
}

function documentWithTable() {
  const document = structuredClone(baseDocument);
  document.slides[0]?.canvas.elements.push(tableElement());
  return presentationDocumentSchema.parse(document);
}

describe("native editable table slice", () => {
  it("fails closed for ragged rows, invalid colors, and unknown fields", () => {
    const empty = tableElement();
    empty.rows = [];
    expect(canvasElementSchema.safeParse(empty).success).toBe(false);

    const ragged = tableElement();
    ragged.rows[1]?.pop();
    expect(canvasElementSchema.safeParse(ragged).success).toBe(false);

    const invalidColor = tableElement();
    invalidColor.rows[0]![0]!.fill = "red";
    expect(canvasElementSchema.safeParse(invalidColor).success).toBe(false);

    expect(canvasElementSchema.safeParse({ ...tableElement(), unexpected: true }).success).toBe(false);
  });

  it("exports semantic escaped HTML with the exact table row and cell count", () => {
    const html = createStandaloneHtml(documentWithTable());
    expect(html).toContain('data-element-type="table"');
    expect((html.match(/<tr>/g) ?? []).length).toBe(2);
    expect((html.match(/<td /g) ?? []).length).toBe(4);
    expect(html).toContain('&lt;выручка&gt;&amp;&quot;&#39;');
    expect(html).not.toContain('<выручка>&"\'');
    expect(html).toContain('left:120px;top:160px;width:720px;height:180px;z-index:999;');
  });

  it("writes a native OOXML table and editable cell text without slide raster media", async () => {
    const archive = await JSZip.loadAsync(await createPresentationPptx(documentWithTable()));
    const slideXml = await archive.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toContain("<a:tbl>");
    expect(slideXml).toContain("Показатель");
    expect(slideXml).toContain("Значение");
    expect(slideXml).toContain("<a:t>");
    expect(slideXml).toContain('val="445566"');
    expect(slideXml).toContain("<a:ln");
    expect(archive.file(/^ppt\/media\//u)).toHaveLength(0);
  });
});
