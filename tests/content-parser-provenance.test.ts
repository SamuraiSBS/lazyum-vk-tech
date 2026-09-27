import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { normalizedContentSchema } from "../src/lib/schemas";
import { createFixtureTemplate } from "./fixture-decks";

vi.mock("pdf-parse", () => ({
  default: async () => ({ text: "PDF text without page attribution." }),
}));

describe("content parser provenance", () => {
  it("adds exact line locators for TXT and Markdown while retaining the flat fields", async () => {
    const content = await normalizeContent("Материалы проекта", [
      { name: "notes.txt", type: "", buffer: Buffer.from("first line\nsecond line\nthird line") },
      { name: "readme.md", type: "text/markdown", buffer: Buffer.from("# Heading\n\nMarkdown body") },
    ]);

    expect(content.documents.map((document) => document.name)).toEqual(["notes.txt", "readme.md"]);
    expect(content.excerpts).toEqual(expect.any(Array));
    expect(content.keywords).toEqual(expect.any(Array));
    expect(content.sourceChunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceName: "notes.txt",
        mimeType: "text/plain",
        text: "first line\nsecond line\nthird line",
        locator: "lines:1-3",
        precision: "exact",
      }),
      expect.objectContaining({
        sourceName: "readme.md",
        mimeType: "text/markdown",
        locator: "lines:1-3",
        precision: "exact",
      }),
    ]));
  });

  it("locates CSV cells by physical row and column", async () => {
    const content = await normalizeContent("CSV metrics", [{
      name: "metrics.csv",
      type: "text/csv",
      buffer: Buffer.from("name,score\nAlice,42\nBob,37"),
    }]);

    expect(content.sourceChunks.map((chunk) => chunk.locator)).toEqual([
      "row:1,column:1",
      "row:1,column:2",
      "row:2,column:1",
      "row:2,column:2",
      "row:3,column:1",
      "row:3,column:2",
    ]);
    expect(content.sourceChunks.find((chunk) => chunk.locator === "row:2,column:2")?.text).toBe("42");
    expect(content.sourceChunks.every((chunk) => chunk.precision === "exact")).toBe(true);
  });

  it("normalizes XLSX shared, inline, numeric, and boolean cells with exact sheet locators", async () => {
    const content = await normalizeContent("XLSX metrics", [{
      name: "metrics.xlsx",
      type: "",
      buffer: await createXlsx(),
    }]);
    const chunks = content.sourceChunks;

    expect(chunks.map((chunk) => chunk.locator)).toEqual([
      "sheet:Overview,row:2,column:1",
      "sheet:Overview,row:2,column:3",
      "sheet:Metrics,row:4,column:2",
      "sheet:Metrics,row:4,column:3",
    ]);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["Shared value", "Inline value", "42", "true"]);
    expect(chunks.every((chunk) => chunk.precision === "exact")).toBe(true);
    expect(content.documents[0].text).toContain("Shared value Inline value 42 true");
    expect(content.documents[0].text).not.toMatch(/<worksheet|<c\s/iu);
    expect(content.documents[0].characters).toBe(content.documents[0].text.length);
  });

  it("preserves normalized XLSX merge provenance only for value-bearing anchor cells", async () => {
    const xlsx = await createMergedXlsx();
    const files = [{ name: "merged.xlsx", type: "", buffer: xlsx }];
    const first = await normalizeContent("Merged metrics", files);
    const second = await normalizeContent("Merged metrics", files);
    const chunks = first.sourceChunks.filter((chunk) => chunk.sourceName === "merged.xlsx");
    const facts = (first.facts || []).flatMap((fact) => fact.kind === "spreadsheet-cell"
      && fact.sourceId === chunks[0]?.sourceId ? [fact] : []);

    expect(chunks.map(({ locator, text, mergedRange }) => ({ locator, text, mergedRange }))).toEqual([
      { locator: "sheet:Merged,row:1,column:1", text: "Header", mergedRange: "A1:C1" },
      { locator: "sheet:Merged,row:2,column:4", text: "Metric", mergedRange: "D2:E3" },
      { locator: "sheet:Merged,row:3,column:1", text: "Matrix", mergedRange: "A3:C4" },
      { locator: "sheet:Merged,row:6,column:7", text: "Invalid merge remains ordinary", mergedRange: undefined },
    ]);
    expect(facts.map(({ locator, mergedRange }) => ({ locator, mergedRange }))).toEqual([
      { locator: "sheet:Merged,row:1,column:1", mergedRange: "A1:C1" },
      { locator: "sheet:Merged,row:2,column:4", mergedRange: "D2:E3" },
      { locator: "sheet:Merged,row:3,column:1", mergedRange: "A3:C4" },
      { locator: "sheet:Merged,row:6,column:7", mergedRange: undefined },
    ]);
    expect(chunks.map((chunk) => chunk.locator)).not.toEqual(expect.arrayContaining([
      "sheet:Merged,row:1,column:2",
      "sheet:Merged,row:3,column:2",
      "sheet:Merged,row:4,column:3",
      "sheet:Merged,row:3,column:5",
    ]));
    expect(first.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })))
      .toEqual(second.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })));
    expect(first.facts).toEqual(second.facts);
    expect(() => normalizedContentSchema.parse(first)).not.toThrow();
  });

  it("uses cached XLSX formula values as facts and preserves the formula only as metadata", async () => {
    const content = await normalizeContent("Formula metrics", [{
      name: "formula-dates.xlsx",
      type: "",
      buffer: await createFormulaAndDateXlsx(),
    }]);

    const numericFormula = content.facts?.find((fact) => fact.kind === "spreadsheet-cell"
      && fact.locator === "sheet:Formula,row:2,column:2");
    const stringFormula = content.facts?.find((fact) => fact.kind === "spreadsheet-cell"
      && fact.locator === "sheet:Formula,row:2,column:3");
    expect(numericFormula).toEqual(expect.objectContaining({
      valueType: "number",
      value: 42,
      formula: "SUM(A2:A2)",
    }));
    expect(stringFormula).toEqual(expect.objectContaining({
      valueType: "string",
      value: "Ready",
      formula: 'CONCAT("Ready")',
    }));
    expect(content.sourceChunks.find((chunk) => chunk.locator === "sheet:Formula,row:2,column:2")?.text).toBe("42");
    expect(content.sourceChunks.find((chunk) => chunk.locator === "sheet:Formula,row:2,column:3")?.text).toBe("Ready");
    expect(content.documents[0].text).not.toContain("SUM(A2:A2)");
    expect(() => normalizedContentSchema.parse(content)).not.toThrow();
  });

  it("normalizes built-in and custom XLSX dates as timezone-stable ISO facts, including date1904", async () => {
    const content = await normalizeContent("Date metrics", [{
      name: "formula-dates.xlsx",
      type: "",
      buffer: await createFormulaAndDateXlsx(),
    }]);
    const dateFacts = (content.facts || []).flatMap((fact) => fact.kind === "spreadsheet-cell"
      && fact.valueType === "date" && fact.coordinate.sheet === "Dates"
      ? [{ locator: fact.locator, value: fact.value, formula: fact.formula }]
      : []);

    expect(dateFacts).toEqual([
      { locator: "sheet:Dates,row:3,column:1", value: "2024-01-01T00:00:00.000Z", formula: undefined },
      { locator: "sheet:Dates,row:3,column:2", value: "2024-01-02T00:00:00.000Z", formula: undefined },
      { locator: "sheet:Dates,row:3,column:3", value: "2024-01-03T00:00:00.000Z", formula: "TODAY()" },
    ]);
    expect(content.sourceChunks.find((chunk) => chunk.locator === "sheet:Dates,row:3,column:1")?.text)
      .toBe("2024-01-01T00:00:00.000Z");
    expect(content.documents[0].text).not.toContain("45292");

    const date1904Content = await normalizeContent("1904 epoch", [{
      name: "date1904.xlsx",
      type: "",
      buffer: await createFormulaAndDateXlsx(true),
    }]);
    expect(date1904Content.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        locator: "sheet:Epoch 1904,row:2,column:1",
        valueType: "date",
        value: "1904-01-01T00:00:00.000Z",
      }),
    ]));
  });

  it("fails closed for XLSX formulas without a cached value while preserving surrounding cells and stable IDs", async () => {
    const xlsx = await createFormulaAndDateXlsx();
    const files = [{ name: "formula-dates.xlsx", type: "", buffer: xlsx }];
    const first = await normalizeContent("Uncached formula", files);
    const second = await normalizeContent("Uncached formula", files);

    expect(first.sourceChunks.map((chunk) => chunk.locator)).not.toContain("sheet:Formula,row:2,column:4");
    expect(first.facts?.some((fact) => fact.kind === "spreadsheet-cell"
      && fact.locator === "sheet:Formula,row:2,column:4")).toBe(false);
    expect(first.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })))
      .toEqual(second.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })));
    expect(first.facts).toEqual(second.facts);
  });

  it("creates one verified metadata chunk for supported images without binary text", async () => {
    const content = await normalizeContent("Image materials", [{
      name: "reference.PNG",
      type: "application/octet-stream",
      buffer: Buffer.from("89504e470d0a1a0a", "hex"),
    }]);
    const document = content.documents[0];

    expect(document.type).toBe("image/png");
    expect(document.text).toBe("image-mime:image/png;bytes:8");
    expect(document.text).not.toContain("PNG");
    expect(content.sourceChunks).toEqual([
      expect.objectContaining({
        mimeType: "image/png",
        text: "image-mime:image/png;bytes:8",
        locator: "image:metadata",
        precision: "exact",
      }),
    ]);
  });

  it("keeps quoted and semicolon-delimited CSV provenance stable", async () => {
    const content = await normalizeContent("Quoted CSV", [{
      name: "quoted.csv",
      type: "text/csv",
      buffer: Buffer.from('"name";"note"\r\n"Alice";"hello; world"\r\n"Bob";"he said ""hi"""'),
    }]);

    expect(content.sourceChunks.map((chunk) => chunk.locator)).toEqual([
      "row:1,column:1",
      "row:1,column:2",
      "row:2,column:1",
      "row:2,column:2",
      "row:3,column:1",
      "row:3,column:2",
    ]);
    expect(content.sourceChunks.find((chunk) => chunk.locator === "row:2,column:2")?.text).toBe("hello; world");
    expect(content.sourceChunks.find((chunk) => chunk.locator === "row:3,column:2")?.text).toBe('he said "hi"');
  });

  it.each(["\n", "\r\n"])("uses physical CSV start rows after multiline quoted cells with %j", async (newline) => {
    const csv = [
      "name,note,value",
      `Alice,"first${newline}second",42`,
      "Bob,final,37",
    ].join(newline);
    const files = [{ name: "multiline.csv", type: "text/csv", buffer: Buffer.from(csv) }];
    const first = await normalizeContent("Multiline CSV", files);
    const second = await normalizeContent("Multiline CSV", files);

    expect(first.sourceChunks.map(({ locator, text }) => ({ locator, text }))).toEqual([
      { locator: "row:1,column:1", text: "name" },
      { locator: "row:1,column:2", text: "note" },
      { locator: "row:1,column:3", text: "value" },
      { locator: "row:2,column:1", text: "Alice" },
      { locator: "row:2,column:2", text: `first${newline}second` },
      { locator: "row:2,column:3", text: "42" },
      { locator: "row:4,column:1", text: "Bob" },
      { locator: "row:4,column:2", text: "final" },
      { locator: "row:4,column:3", text: "37" },
    ]);
    expect(first.facts?.filter((fact) => fact.kind === "spreadsheet-cell").map((fact) => ({
      locator: fact.locator,
      coordinate: fact.coordinate,
    }))).toEqual(first.sourceChunks.map(({ locator }) => ({
      locator,
      coordinate: { row: Number(locator.match(/row:(\d+)/u)?.[1]), column: Number(locator.match(/column:(\d+)/u)?.[1]) },
    })));
    expect(second.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })))
      .toEqual(first.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })));
    expect(second.facts).toEqual(first.facts);
  });

  it("parses a UTF-8 BOM before a quoted semicolon-delimited header", async () => {
    const content = await normalizeContent("BOM CSV", [{
      name: "bom.csv",
      type: "text/csv",
      buffer: Buffer.from('\uFEFF"name";"value"\r\n"Alice";"42"'),
    }]);

    expect(content.sourceChunks.map(({ locator, text }) => ({ locator, text }))).toEqual([
      { locator: "row:1,column:1", text: "name" },
      { locator: "row:1,column:2", text: "value" },
      { locator: "row:2,column:1", text: "Alice" },
      { locator: "row:2,column:2", text: "42" },
    ]);
  });

  it.each([
    ['name,value\n"Alice,42', "Unmatched CSV quote"],
    ['name,value\n"Alice"oops,42', "Malformed CSV quote"],
    ['name,value\nAlice"oops,42', "Malformed CSV quote"],
  ])("rejects malformed CSV before emitting facts: %j", async (csv, message) => {
    await expect(normalizeContent("Invalid CSV", [{
      name: "invalid.csv",
      type: "text/csv",
      buffer: Buffer.from(csv),
    }])).rejects.toThrow(message);
  });

  it("locates PPTX chunks by slide", async () => {
    const content = await normalizeContent("Template notes", [{
      name: "reference.pptx",
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: await createFixtureTemplate("bright"),
    }]);

    expect(content.sourceChunks.filter((chunk) => chunk.sourceName === "reference.pptx").map((chunk) => chunk.locator))
      .toEqual(["slide:1", "slide:2"]);
    expect(content.sourceChunks.filter((chunk) => chunk.sourceName === "reference.pptx").every((chunk) => chunk.precision === "exact"))
      .toBe(true);
  });

  it("uses document precision for DOCX and PDF without inventing pages", async () => {
    const docx = await createDocx("DOCX material");
    const content = await normalizeContent("Document materials", [
      { name: "notes.docx", type: "", buffer: docx },
      { name: "report.pdf", type: "application/pdf", buffer: Buffer.from("mock pdf") },
    ]);

    expect(content.sourceChunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceName: "notes.docx", locator: "document", precision: "document" }),
      expect.objectContaining({ sourceName: "report.pdf", locator: "document", precision: "document" }),
    ]));
    expect(content.sourceChunks.filter((chunk) => chunk.sourceName.endsWith(".docx") || chunk.sourceName.endsWith(".pdf"))
      .every((chunk) => !/page|стр\.|слайд/iu.test(chunk.locator))).toBe(true);
  });

  it("generates stable source and chunk IDs for the same inputs", async () => {
    const files = [{ name: "stable.txt", type: "text/plain", buffer: Buffer.from("stable source") }];
    const first = await normalizeContent("Stable brief", files);
    const second = await normalizeContent("Stable brief", files);

    expect(second.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })))
      .toEqual(first.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })));
    expect(first.sourceChunks.every((chunk) => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(chunk.sourceId + chunk.chunkId))).toBe(true);
  });

  it("generates stable IDs for the same XLSX and image inputs", async () => {
    const xlsx = await createXlsx();
    const image = createPngHeader(320, 200);
    const files = [
      { name: "stable.xlsx", type: "", buffer: xlsx },
      { name: "stable.png", type: "image/png", buffer: image },
    ];
    const first = await normalizeContent("Stable structured materials", files);
    const second = await normalizeContent("Stable structured materials", files);

    expect(second.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })))
      .toEqual(first.sourceChunks.map(({ sourceId, chunkId }) => ({ sourceId, chunkId })));
    expect(second.facts).toEqual(first.facts);
  });

  it("exposes typed spreadsheet facts and only verified image metadata facts", async () => {
    const content = await normalizeContent("Typed source materials", [
      { name: "metrics.xlsx", type: "", buffer: await createXlsx() },
      { name: "reference.png", type: "image/png", buffer: createPngHeader(320, 200) },
      { name: "values.csv", type: "text/csv", buffer: Buffer.from("label,value,enabled\nalpha,42,true") },
    ]);

    expect(content.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "spreadsheet-cell",
        format: "xlsx",
        valueType: "number",
        value: 42,
        coordinate: { sheet: "Metrics", row: 4, column: 2 },
        locator: "sheet:Metrics,row:4,column:2",
      }),
      expect.objectContaining({
        kind: "spreadsheet-cell",
        format: "csv",
        valueType: "boolean",
        value: true,
        coordinate: { row: 2, column: 3 },
        locator: "row:2,column:3",
      }),
      expect.objectContaining({
        kind: "image-metadata",
        mimeType: "image/png",
        byteSize: 24,
        width: 320,
        height: 200,
        locator: "image:metadata",
      }),
    ]));
    expect(content.facts?.every((fact) => fact.kind === "spreadsheet-cell"
      ? fact.sourceId && fact.chunkId && fact.locator
      : fact.mimeType && fact.byteSize >= 0 && !("ocr" in fact))).toBe(true);

    const malformed = {
      ...content,
      facts: content.facts?.map((fact) => fact.kind === "spreadsheet-cell"
        ? { ...fact, locator: "row:999,column:999" }
        : fact),
    };
    expect(() => normalizedContentSchema.parse(malformed)).toThrow(/locator does not match source chunk/iu);
  });
});

async function createDocx(text: string) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function createXlsx() {
  const zip = new JSZip();
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWorkbook" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Overview" sheetId="1" r:id="rId1"/><sheet name="Metrics" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Shared value</t></si></sst>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"/><c r="C2" t="inlineStr"><is><t>Inline value</t></is></c></row></sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="4"><c r="B4" t="n"><v>42</v></c><c r="C4" t="b"><v>1</v></c></row></sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function createMergedXlsx() {
  const zip = new JSZip();
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWorkbook" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Merged" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c><c r="B1" t="inlineStr"><is><t>Covered header</t></is></c></row><row r="2"><c r="D2" t="inlineStr"><is><t>Metric</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Matrix</t></is></c><c r="B3" t="inlineStr"><is><t>Covered matrix</t></is></c><c r="E3" t="inlineStr"><is><t>Covered metric</t></is></c></row><row r="4"><c r="C4" t="inlineStr"><is><t>Covered matrix lower</t></is></c></row><row r="6"><c r="G6" t="inlineStr"><is><t>Invalid merge remains ordinary</t></is></c></row></sheetData><mergeCells count="4"><mergeCell ref=" $a$1:$c$1 "/><mergeCell ref="D2:E3"/><mergeCell ref="A3:C4"/><mergeCell ref="G6"/></mergeCells></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function createFormulaAndDateXlsx(date1904 = false) {
  const zip = new JSZip();
  const workbookProperties = date1904 ? '<workbookPr date1904="1"/>' : "";
  const firstDateSerial = date1904 ? 43830 : 45292;
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWorkbook" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${workbookProperties}<sheets><sheet name="Formula" sheetId="1" r:id="rId1"/><sheet name="Dates" sheetId="2" r:id="rId2"/><sheet name="Epoch 1904" sheetId="3" r:id="rId3"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="B2"><f>SUM(A2:A2)</f><v>42</v></c><c r="C2" t="str"><f>CONCAT(&quot;Ready&quot;)</f><v>Ready</v></c><c r="D2"><f>SUM(B2:C2)</f></c></row></sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="3"><c r="A3" s="1"><v>${firstDateSerial}</v></c><c r="B3" s="2"><v>${firstDateSerial + 1}</v></c><c r="C3" s="1"><f>TODAY()</f><v>${firstDateSerial + 2}</v></c></row></sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet3.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="A2" s="1"><v>0</v></c></row></sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function createPngHeader(width: number, height: number) {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
