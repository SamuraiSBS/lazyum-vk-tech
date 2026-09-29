import { createHash } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  normalizedContentSchema,
  type InputSourceArtifact,
  type ContentDocument,
  type NormalizedContent,
  type SourceChunk,
  type SourceFact,
} from "./schemas";

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_SOURCE_FILES = 12;
const MAX_TEXT_CHARS = 50_000;
const WORDPROCESSINGML_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PPTX_PRESENTATION_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);
const PPTX_OFFICE_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const PPTX_SLIDE_RELATIONSHIP_TYPES = new Set([...PPTX_OFFICE_RELATIONSHIP_NAMESPACES].map((uri) => `${uri}/slide`));
const PPTX_PACKAGE_RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  trimValues: true,
  parseTagValue: false,
});

export async function normalizeContent(
  brief: string,
  files: Array<{ name: string; type: string; buffer: Buffer }>,
): Promise<NormalizedContent> {
  const cleanBrief = brief.trim();
  if (cleanBrief.length < 2) throw new Error("Please describe the presentation topic");
  const parsedSources = await Promise.all(files.slice(0, MAX_SOURCE_FILES).map(async (file) => {
    const extracted = await extractSourceContent(file.name, file.buffer, file.type);
    const mimeType = extracted.mimeType || file.type || mimeFromName(file.name);
    const sourceId = stableSourceId(file.name, file.buffer);
    const document: ContentDocument = {
      name: file.name,
      type: mimeType,
      text: compact(extracted.text, MAX_TEXT_CHARS),
      characters: 0,
    };
    document.characters = document.text.length;
    const sourceChunks = extracted.chunks.map((chunk, index) => toSourceChunk({
      sourceId,
      sourceName: file.name,
      mimeType,
      chunk,
      index,
    }));
    return {
      document,
      sourceChunks,
      facts: extracted.chunks.flatMap((chunk, index) => chunk.fact
        ? [toSourceFact({
          sourceId,
          chunkId: sourceChunks[index]!.chunkId,
          fact: chunk.fact,
        })]
        : []),
    };
  }));
  const documents = parsedSources.map((source) => source.document);
  const sourceChunks = parsedSources.flatMap((source) => source.sourceChunks);
  const facts = parsedSources.flatMap((source) => source.facts);
  const corpus = [cleanBrief, ...documents.map((document) => document.text)].join("\n");
  return normalizedContentSchema.parse({
    brief: cleanBrief,
    documents,
    excerpts: extractExcerpts(corpus),
    keywords: extractKeywords(corpus),
    sourceChunks,
    facts,
  });
}

export function inputSourceArtifact(input: { name: string; type: string; buffer: Buffer }): InputSourceArtifact {
  return {
    id: stableSourceId(input.name, input.buffer),
    type: input.type || mimeFromName(input.name),
    name: input.name || "source",
    origin: "uploaded",
    sha256: createHash("sha256").update(input.buffer).digest("hex"),
    byteSize: input.buffer.byteLength,
    sourceChunkIds: [],
    factIds: [],
  };
}

export async function extractTextFromSource(name: string, buffer: Buffer) {
  return (await extractSourceContent(name, buffer)).text;
}

type ChunkDraft = {
  text: string;
  locator: string;
  precision: "exact" | "document";
  mergedRange?: string;
  fact?: FactDraft;
};

type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

type FactDraft =
  | {
    kind: "spreadsheet-cell";
    format: "xlsx" | "csv";
    valueType: "string" | "number" | "boolean" | "date";
    value: string | number | boolean;
    coordinate: { sheet?: string; row: number; column: number };
    locator: string;
    formula?: string;
    mergedRange?: string;
  }
  | {
    kind: "image-metadata";
    locator: "image:metadata";
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    byteSize: number;
    width?: number;
    height?: number;
  };

type ExtractedSource = {
  text: string;
  chunks: ChunkDraft[];
  mimeType?: string;
};

async function extractSourceContent(name: string, buffer: Buffer, declaredMimeType = ""): Promise<ExtractedSource> {
  if (buffer.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(name + " exceeds the 12 MB material limit");
  }
  const extension = path.extname(name).toLowerCase();
  if ([".txt", ".md"].includes(extension)) {
    const text = buffer.toString("utf8");
    return { text, chunks: chunkLineSource(text) };
  }
  if (extension === ".csv") {
    const text = buffer.toString("utf8");
    return { text, chunks: chunkCsvSource(text) };
  }
  if (extension === ".xlsx") return extractXlsxSource(buffer);
  if (isSupportedImageExtension(extension) || isSupportedImageMime(declaredMimeType)) {
    return extractImageSource(name, buffer);
  }
  if (extension === ".docx") {
    return extractDocxSource(buffer);
  }
  if (extension === ".pptx") return extractPptxSource(buffer);
  if (extension === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      const pages = parsed.pages.filter((page) => page.text.trim().length > 0);
      return {
        text: pages.map((page) => page.text).join("\n\n"),
        chunks: pages.map((page) => ({
          text: limitText(page.text),
          locator: `page:${page.num}`,
          precision: "exact" as const,
        })),
      };
    } finally {
      await parser.destroy();
    }
  }
  throw new Error("Unsupported material type: " + extension);
}

async function extractDocxSource(buffer: Buffer): Promise<ExtractedSource> {
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (documentXml && documentXml.length <= MAX_SOURCE_BYTES
    && /<w:document\b[^>]*xmlns:w="http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main"/iu.test(documentXml)
    && !/<!DOCTYPE|<!ENTITY/iu.test(documentXml)
    && XMLValidator.validate(documentXml) === true
    && !/<w:(?:altChunk|txbxContent|fldSimple|instrText|delText)\b/iu.test(documentXml)) {
    const ordered = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      trimValues: false,
      parseTagValue: false,
      processEntities: true,
    }).parse(documentXml);
    const root = orderedChild(ordered, "document", {});
    const body = root && orderedChild(root.children, "body", root.namespaces);
    if (body) {
      const paragraphs: string[] = [];
      const complete = collectDocxParagraphs(body.children, paragraphs, body.namespaces);
      if (complete) {
        let remaining = MAX_TEXT_CHARS;
        const chunks: ChunkDraft[] = [];
        paragraphs.forEach((paragraph, index) => {
          if (!paragraph.trim() || remaining <= 0) return;
          const text = paragraph.slice(0, remaining);
          remaining -= text.length;
          chunks.push({ text, locator: `paragraph:${index + 1}`, precision: "exact" });
        });
        return { text: chunks.map((chunk) => chunk.text).join("\n\n"), chunks };
      }
    }
  }
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value || "";
  return { text, chunks: text.trim() ? [{ text: limitText(text), locator: "document", precision: "document" }] : [] };
}

type OrderedXmlNode = Record<string, unknown>;
type XmlNamespaces = Record<string, string>;
type DocxElement = { tag: string; children: unknown[]; namespaces: XmlNamespaces };

function docxElement(node: OrderedXmlNode, inherited: XmlNamespaces): DocxElement | null {
  const attributes = node[":@"];
  const namespaces: XmlNamespaces = Object.assign(Object.create(null), inherited);
  if (attributes && typeof attributes === "object") {
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "@_xmlns" && typeof value === "string") namespaces[""] = value;
      else if (key.startsWith("@_xmlns:") && typeof value === "string") namespaces[key.slice(8)] = value;
    }
  }
  const entry = Object.entries(node).find(([key]) => key !== ":@" && key !== "#text");
  if (!entry || !Array.isArray(entry[1])) return null;
  const [qualifiedName, children] = entry;
  const colon = qualifiedName.indexOf(":");
  const prefix = colon < 0 ? "" : qualifiedName.slice(0, colon);
  if (namespaces[prefix] !== WORDPROCESSINGML_NAMESPACE) return null;
  return { tag: xmlLocalName(qualifiedName), children, namespaces };
}

function orderedChild(nodes: unknown, name: string, namespaces: XmlNamespaces): DocxElement | undefined {
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if ("#text" in node) continue;
    const element = docxElement(node as OrderedXmlNode, namespaces);
    if (element?.tag === name) return element;
  }
  return undefined;
}

function collectDocxParagraphs(nodes: unknown[], paragraphs: string[], namespaces: XmlNamespaces): boolean {
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if ("#text" in node) continue;
    const element = docxElement(node as OrderedXmlNode, namespaces);
    if (!element) return false;
    const { tag, children } = element;
    if (tag === "p") {
      const text = docxParagraphText(children, element.namespaces);
      if (text === null) return false;
      paragraphs.push(text);
    } else if (["tbl", "tr", "tc", "sdt", "sdtContent"].includes(tag)) {
      if (!collectDocxParagraphs(children, paragraphs, element.namespaces)) return false;
    } else if (tag !== "sectPr" && tag !== "tblPr" && tag !== "tblGrid" && tag !== "trPr" && tag !== "tcPr") {
      return false;
    }
  }
  return true;
}

function docxParagraphText(nodes: unknown, namespaces: XmlNamespaces): string | null {
  if (!Array.isArray(nodes)) return null;
  let text = "";
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if ("#text" in node) continue;
    const element = docxElement(node as OrderedXmlNode, namespaces);
    if (!element) return null;
    const { tag, children } = element;
    if (["r", "hyperlink", "ins", "smartTag", "sdt", "sdtContent"].includes(tag)) {
      const value = docxParagraphText(children, element.namespaces);
      if (value === null) return null;
      text += value;
    } else if (tag === "t") {
      if (children.some((child) => !child || typeof child !== "object" || Object.keys(child).some((key) => key !== "#text"))) return null;
      text += children.map((child) => (child as OrderedXmlNode)["#text"] || "").join("");
    } else if (tag === "tab") text += "\t";
    else if (tag === "br" || tag === "cr") text += "\n";
    else if (!["pPr", "rPr", "bookmarkStart", "bookmarkEnd", "proofErr", "lastRenderedPageBreak"].includes(tag)) return null;
  }
  return text;
}

async function extractImageSource(name: string, buffer: Buffer): Promise<ExtractedSource> {
  const mimeType = detectImageMime(buffer);
  if (!mimeType) throw new Error(name + " is not a supported PNG, JPG, JPEG, WebP, or GIF image");
  const dimensions = detectImageDimensions(mimeType, buffer);
  const dimensionsText = dimensions ? `;width:${dimensions.width};height:${dimensions.height}` : "";
  const text = `image-mime:${mimeType};bytes:${buffer.byteLength}${dimensionsText}`;
  return {
    text,
    mimeType,
    chunks: [{
      text,
      locator: "image:metadata",
      precision: "exact",
        fact: {
          kind: "image-metadata",
        locator: "image:metadata",
        mimeType,
        byteSize: buffer.byteLength,
        ...dimensions,
      },
    }],
  };
}

async function extractXlsxSource(buffer: Buffer): Promise<ExtractedSource> {
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  const workbookPath = await resolveXlsxWorkbookPath(zip);
  const workbookXml = await readZipXml(zip, workbookPath);
  const workbookDocument = xmlParser.parse(workbookXml);
  const workbook = xmlChild(workbookDocument, "workbook") || workbookDocument;
  const workbookRelationships = await readXlsxRelationships(zip, workbookPath);
  const sharedStrings = await readXlsxSharedStrings(zip, workbookRelationships, workbookPath);
  const date1904 = xlsxBoolean(xmlAttribute(xmlChild(workbook, "workbookPr"), "date1904"));
  const dateStyles = await readXlsxDateStyles(zip, workbookRelationships, workbookPath);
  const sheets = asXmlArray(xmlChild(xmlChild(workbook, "sheets"), "sheet"));
  const chunks: ChunkDraft[] = [];
  const sheetTexts: string[] = [];

  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex += 1) {
    const sheet = sheets[sheetIndex];
    const sheetName = xmlAttribute(sheet, "name");
    if (!sheetName) throw new Error(`XLSX sheet ${sheetIndex + 1} has no name`);
    const relationshipId = xmlAttribute(sheet, "id");
    const relationship = relationshipId ? workbookRelationships.get(relationshipId) : undefined;
    if (!relationship?.target) throw new Error(`XLSX sheet ${sheetName} has no workbook relationship`);
    const sheetPath = resolveRelationshipTarget(workbookPath, relationship.target);
    const sheetXml = await readZipXml(zip, sheetPath);
    const sheetDocument = xmlParser.parse(sheetXml);
    const worksheet = xmlChild(sheetDocument, "worksheet") || sheetDocument;
    const mergedRanges = readXlsxMergedRanges(worksheet);
    const rows = asXmlArray(xmlChild(xmlChild(worksheet, "sheetData"), "row"));
    const rowTexts: string[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const fallbackRow = positiveInteger(xmlAttribute(row, "r")) || rowIndex + 1;
      let nextColumn = 1;
      const rowValues: Array<{ column: number; text: string }> = [];
      const cells = asXmlArray(xmlChild(row, "c"));

      for (const cell of cells) {
        const cellReference = parseXlsxCellReference(xmlAttribute(cell, "r"));
        const rowNumber = cellReference?.row || fallbackRow;
        const columnNumber = cellReference?.column || nextColumn;
        nextColumn = Math.max(nextColumn, columnNumber + 1);
        const mergedRange = findXlsxMergedRange(mergedRanges, rowNumber, columnNumber);
        if (mergedRange?.covered) continue;
        const value = readXlsxCellValue(cell, sharedStrings, { date1904, dateStyles });
        if (value === null || value.text.length === 0) continue;
        const text = limitText(value.text);
        const locator = `sheet:${sheetName},row:${rowNumber},column:${columnNumber}`;
        chunks.push({
          text,
          locator,
          precision: "exact",
          ...(mergedRange ? { mergedRange: mergedRange.range } : {}),
          fact: {
            kind: "spreadsheet-cell",
            format: "xlsx",
            valueType: value.valueType,
            value: value.value,
            coordinate: { sheet: sheetName, row: rowNumber, column: columnNumber },
            locator,
            ...(value.formula ? { formula: value.formula } : {}),
            ...(mergedRange ? { mergedRange: mergedRange.range } : {}),
          },
        });
        rowValues.push({ column: columnNumber, text });
      }

      if (rowValues.length) {
        rowValues.sort((left, right) => left.column - right.column);
        rowTexts.push(rowValues.map(({ text }) => text).join("\t"));
      }
    }

    if (rowTexts.length) sheetTexts.push(rowTexts.join("\n"));
  }

  return { text: sheetTexts.join("\n\n"), chunks };
}

type XlsxRelationship = { target: string; type: string };

async function resolveXlsxWorkbookPath(zip: JSZip) {
  const rootRelationshipsPath = "_rels/.rels";
  if (!zip.files[rootRelationshipsPath]) return "xl/workbook.xml";
  const rootXml = await readZipXml(zip, rootRelationshipsPath);
  const rootDocument = xmlParser.parse(rootXml);
  const rootRelationships = readRelationshipRecords(rootDocument);
  const officeDocument = [...rootRelationships.values()].find((relationship) =>
    relationship.type.endsWith("/officeDocument"),
  );
  return officeDocument?.target
    ? resolveRelationshipTarget("", officeDocument.target)
    : "xl/workbook.xml";
}

async function readXlsxRelationships(zip: JSZip, workbookPath: string) {
  const relationshipsPath = path.posix.join(
    path.posix.dirname(workbookPath),
    "_rels",
    path.posix.basename(workbookPath) + ".rels",
  );
  if (!zip.files[relationshipsPath]) return new Map<string, XlsxRelationship>();
  const relationshipsXml = await readZipXml(zip, relationshipsPath);
  return readRelationshipRecords(xmlParser.parse(relationshipsXml));
}

async function readXlsxSharedStrings(
  zip: JSZip,
  relationships: Map<string, XlsxRelationship>,
  workbookPath: string,
) {
  const relationship = [...relationships.values()].find((candidate) => candidate.type.endsWith("/sharedStrings"));
  const sharedStringsPath = relationship?.target
    ? resolveRelationshipTarget(workbookPath, relationship.target)
    : "xl/sharedStrings.xml";
  if (!zip.files[sharedStringsPath]) return [];
  const sharedStringsXml = await readZipXml(zip, sharedStringsPath);
  const sharedStringsDocument = xmlParser.parse(sharedStringsXml);
  const root = xmlChild(sharedStringsDocument, "sst") || sharedStringsDocument;
  return asXmlArray(xmlChild(root, "si")).map((item) => collectText(item).join(""));
}

async function readXlsxDateStyles(
  zip: JSZip,
  relationships: Map<string, XlsxRelationship>,
  workbookPath: string,
) {
  const relationship = [...relationships.values()].find((candidate) => candidate.type.endsWith("/styles"));
  const stylesPath = relationship?.target
    ? resolveRelationshipTarget(workbookPath, relationship.target)
    : "xl/styles.xml";
  if (!zip.files[stylesPath]) return new Set<number>();

  const stylesDocument = xmlParser.parse(await readZipXml(zip, stylesPath));
  const styleSheet = xmlChild(stylesDocument, "styleSheet") || stylesDocument;
  const customFormats = new Map<number, string>();
  for (const numFmt of asXmlArray(xmlChild(xmlChild(styleSheet, "numFmts"), "numFmt"))) {
    const id = nonnegativeInteger(xmlAttribute(numFmt, "numFmtId"));
    const formatCode = xmlAttribute(numFmt, "formatCode");
    if (id !== undefined && formatCode) customFormats.set(id, formatCode);
  }

  const dateStyles = new Set<number>();
  const cellXfs = asXmlArray(xmlChild(xmlChild(styleSheet, "cellXfs"), "xf"));
  for (let index = 0; index < cellXfs.length; index += 1) {
    const numberFormatId = nonnegativeInteger(xmlAttribute(cellXfs[index], "numFmtId"));
    if (numberFormatId !== undefined && isXlsxDateNumberFormat(numberFormatId, customFormats.get(numberFormatId))) {
      dateStyles.add(index);
    }
  }
  return dateStyles;
}

function readRelationshipRecords(value: unknown) {
  const root = xmlChild(value, "Relationships") || value;
  const records = new Map<string, XlsxRelationship>();
  for (const relationship of asXmlArray(xmlChild(root, "Relationship"))) {
    const id = xmlAttribute(relationship, "Id");
    const target = xmlAttribute(relationship, "Target");
    if (id && target) records.set(id, {
      target,
      type: xmlAttribute(relationship, "Type") || "",
    });
  }
  return records;
}

async function readZipXml(zip: JSZip, name: string) {
  const entry = zip.files[name];
  if (!entry || entry.dir) throw new Error("XLSX XML part is missing: " + name);
  const xml = await entry.async("string");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsafe XML declaration in " + name);
  return xml;
}

function resolveRelationshipTarget(sourcePart: string, target: string) {
  let decodedTarget = target;
  try {
    decodedTarget = decodeURIComponent(target);
  } catch {
    throw new Error("Invalid XLSX relationship target: " + target);
  }
  const joined = decodedTarget.startsWith("/")
    ? decodedTarget.slice(1)
    : path.posix.join(path.posix.dirname(sourcePart), decodedTarget);
  const normalized = path.posix.normalize(joined).replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Invalid XLSX relationship target: " + target);
  }
  return normalized;
}

type CellValue = {
  text: string;
  valueType: "string" | "number" | "boolean" | "date";
  value: string | number | boolean;
  formula?: string;
};

function readXlsxCellValue(
  cell: unknown,
  sharedStrings: string[],
  options: { date1904: boolean; dateStyles: Set<number> },
): CellValue | null {
  const cellType = (xmlAttribute(cell, "t") || "n").toLowerCase();
  const formulaValue = xmlScalarText(xmlChild(cell, "f"));
  const formula = formulaValue === null ? null : decodeXlsxXmlEntities(formulaValue);
  const formulaMetadata = formula && formula.length > 0 ? { formula } : {};
  if (cellType === "inlinestr") {
    const text = collectText(xmlChild(cell, "is")).join("");
    return text ? { text, valueType: "string", value: text, ...formulaMetadata } : null;
  }
  const rawValue = xmlScalarText(xmlChild(cell, "v"));
  if (rawValue === null || rawValue.length === 0) return null;
  if (cellType === "s") {
    const sharedStringIndex = Number(rawValue);
    const value = Number.isInteger(sharedStringIndex) && sharedStringIndex >= 0
      ? sharedStrings[sharedStringIndex]
      : undefined;
    return value === undefined ? null : { text: value, valueType: "string", value, ...formulaMetadata };
  }
  if (cellType === "b") {
    if (rawValue === "1" || rawValue.toLowerCase() === "true") return { text: "true", valueType: "boolean", value: true, ...formulaMetadata };
    if (rawValue === "0" || rawValue.toLowerCase() === "false") return { text: "false", valueType: "boolean", value: false, ...formulaMetadata };
    return null;
  }
  if (cellType === "n") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return { text: rawValue, valueType: "string", value: rawValue, ...formulaMetadata };
    const styleIndex = nonnegativeInteger(xmlAttribute(cell, "s"));
    if (styleIndex !== undefined && options.dateStyles.has(styleIndex)) {
      const isoValue = xlsxSerialToIso(value, options.date1904);
      return isoValue ? { text: isoValue, valueType: "date", value: isoValue, ...formulaMetadata } : null;
    }
    return { text: rawValue, valueType: "number", value, ...formulaMetadata };
  }
  if (cellType === "str") return { text: rawValue, valueType: "string", value: rawValue, ...formulaMetadata };
  return null;
}

const XLSX_BUILT_IN_DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function isXlsxDateNumberFormat(numberFormatId: number, customFormatCode: string | undefined) {
  if (XLSX_BUILT_IN_DATE_FORMAT_IDS.has(numberFormatId)) return true;
  if (!customFormatCode) return false;
  const meaningful = customFormatCode
    .replace(/"[^"]*"/gu, "")
    .replace(/\\./gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/[_*]./gu, "")
    .toLowerCase();
  return meaningful.includes("y") || meaningful.includes("d");
}

function xlsxSerialToIso(serial: number, date1904: boolean) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  // Excel's 1900 date system contains a non-existent 1900-02-29. Refuse that
  // serial range rather than producing an incorrect factual date.
  if (!date1904 && serial >= 60 && serial < 61) return null;

  const wholeDays = Math.floor(serial);
  const milliseconds = Math.round((serial - wholeDays) * MILLISECONDS_PER_DAY);
  const adjustedDays = date1904
    ? wholeDays
    : wholeDays >= 61 ? wholeDays - 1 : wholeDays;
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, 31);
  const date = new Date(epoch + adjustedDays * MILLISECONDS_PER_DAY + milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseXlsxCellReference(value: string | undefined) {
  if (!value) return undefined;
  const match = /^\$?([A-Z]+)\$?(\d+)$/iu.exec(value);
  if (!match) return undefined;
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return column > 0 && row > 0 ? { row, column } : undefined;
}

type XlsxMergedRange = {
  range: string;
  start: { row: number; column: number };
  end: { row: number; column: number };
};

function readXlsxMergedRanges(worksheet: unknown) {
  const parsed = asXmlArray(xmlChild(xmlChild(worksheet, "mergeCells"), "mergeCell"))
    .flatMap((mergeCell) => {
      const range = normalizeXlsxMergedRange(xmlAttribute(mergeCell, "ref"));
      return range ? [range] : [];
    });
  const anchors = new Map<string, XlsxMergedRange>();
  const ambiguousRanges = new Set<string>();

  for (const range of parsed) {
    const anchor = `${range.start.row}:${range.start.column}`;
    const existing = anchors.get(anchor);
    if (existing && existing.range !== range.range) ambiguousRanges.add(anchor);
    else anchors.set(anchor, range);
  }

  return [...anchors.entries()]
    .flatMap(([anchor, range]) => ambiguousRanges.has(anchor) ? [] : [range])
    .sort((left, right) => left.start.row - right.start.row
      || left.start.column - right.start.column
      || left.end.row - right.end.row
      || left.end.column - right.end.column);
}

function normalizeXlsxMergedRange(value: string | undefined): XlsxMergedRange | undefined {
  if (!value) return undefined;
  const references = value.trim().split(":");
  if (references.length !== 2) return undefined;
  const start = parseXlsxCellReference(references[0]);
  const end = parseXlsxCellReference(references[1]);
  if (!start || !end || start.row > end.row || start.column > end.column) return undefined;
  if (start.row === end.row && start.column === end.column) return undefined;
  return {
    range: `${formatXlsxCellReference(start)}:${formatXlsxCellReference(end)}`,
    start,
    end,
  };
}

function findXlsxMergedRange(ranges: XlsxMergedRange[], row: number, column: number) {
  for (const range of ranges) {
    if (row < range.start.row || row > range.end.row || column < range.start.column || column > range.end.column) continue;
    if (row === range.start.row && column === range.start.column) return { range: range.range, covered: false };
    return { range: range.range, covered: true };
  }
  return undefined;
}

function formatXlsxCellReference(reference: { row: number; column: number }) {
  let column = reference.column;
  let letters = "";
  while (column > 0) {
    const remainder = (column - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    column = Math.floor((column - 1) / 26);
  }
  return `${letters}${reference.row}`;
}

function positiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonnegativeInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function xlsxBoolean(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

function asXmlArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlChild(value: unknown, localName: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = Object.entries(value as Record<string, unknown>).find(([key]) =>
    !key.startsWith("@_") && xmlLocalName(key) === localName,
  );
  return entry?.[1];
}

function xmlAttribute(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = Object.entries(value as Record<string, unknown>).find(([key]) => {
    if (!key.startsWith("@_")) return false;
    const attributeName = key.slice(2);
    return attributeName === name || xmlLocalName(attributeName) === name;
  });
  const attributeValue = entry?.[1];
  return typeof attributeValue === "string" || typeof attributeValue === "number"
    ? String(attributeValue)
    : undefined;
}

function xmlLocalName(value: string) {
  return value.slice(value.lastIndexOf(":") + 1);
}

function xmlScalarText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? xmlScalarText(value[0]) : null;
  if (value && typeof value === "object") return collectText(value).join("");
  return null;
}

function decodeXlsxXmlEntities(value: string) {
  return value.replace(/&(quot|apos|lt|gt|amp);/gu, (_match, entity: string) => ({
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    amp: "&",
  })[entity] || _match);
}

async function extractPptxSource(buffer: Buffer): Promise<ExtractedSource> {
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0] || 0) - Number(right.match(/\d+/)?.[0] || 0));
  const ordered = await resolvePptxSourceSlideOrder(zip);
  // An incomplete package can still provide text, but its physical slide names do not
  // establish either display order or a trustworthy visible-slide locator.
  const names = ordered || slideFiles;
  const chunks: ChunkDraft[] = [];
  const slideTexts: string[] = [];
  for (const [index, name] of names.entries()) {
    const xml = await zip.files[name]?.async("string");
    if (!xml) continue;
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsafe XML declaration in " + name);
    const text = collectText(xmlParser.parse(xml)).join(" ");
    slideTexts.push(text);
    chunks.push({
      text: limitText(text),
      locator: ordered ? `slide:${index + 1}` : "document",
      precision: ordered ? "exact" : "document",
    });
  }
  if (!chunks.length) chunks.push({ text: "", locator: "document", precision: "document" });
  return { text: slideTexts.join("\n\n"), chunks };
}

async function resolvePptxSourceSlideOrder(zip: JSZip): Promise<string[] | null> {
  const presentation = zip.file("ppt/presentation.xml");
  const relationships = zip.file("ppt/_rels/presentation.xml.rels");
  if (!presentation || !relationships) return null;
  const presentationXml = await presentation.async("string");
  const relationshipsXml = await relationships.async("string");
  if ([presentationXml, relationshipsXml].some((xml) =>
    /<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true)) return null;

  const presentationRoot = pptxElement(xmlParser.parse(presentationXml), "presentation", PPTX_PRESENTATION_NAMESPACES);
  const relationshipRoot = pptxElement(xmlParser.parse(relationshipsXml), "Relationships", new Set([PPTX_PACKAGE_RELATIONSHIP_NAMESPACE]));
  const slideIdList = presentationRoot && pptxElement(presentationRoot.value, "sldIdLst", PPTX_PRESENTATION_NAMESPACES, presentationRoot.namespaces);
  if (!presentationRoot || !relationshipRoot || !slideIdList) return null;

  const relationMap = new Map<string, string>();
  const relationshipIds = new Set<string>();
  const relations = pptxElements(relationshipRoot.value, "Relationship", new Set([PPTX_PACKAGE_RELATIONSHIP_NAMESPACE]), relationshipRoot.namespaces);
  if (relations.length !== pptxLocalElementCount(relationshipRoot.value, "Relationship")) return null;
  for (const relation of relations) {
    const id = pptxAttribute(relation.value, "Id");
    const target = pptxAttribute(relation.value, "Target");
    const type = pptxAttribute(relation.value, "Type");
    const mode = pptxAttribute(relation.value, "TargetMode");
    if (!id || !target || !type || relationshipIds.has(id)) return null;
    relationshipIds.add(id);
    if (mode && mode !== "Internal") return null;
    if (!PPTX_SLIDE_RELATIONSHIP_TYPES.has(type)) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(target); } catch { return null; }
    if (decoded !== target || !/^(?:\/ppt\/)?slides\/slide\d+\.xml$/iu.test(decoded)) return null;
    const name = decoded.startsWith("/") ? decoded.slice(1) : `ppt/${decoded}`;
    if (!zip.file(name)) return null;
    relationMap.set(id, name);
  }

  const ids = pptxElements(slideIdList.value, "sldId", PPTX_PRESENTATION_NAMESPACES, slideIdList.namespaces);
  if (ids.length !== pptxLocalElementCount(slideIdList.value, "sldId")) return null;
  if (!ids.length) return null;
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  const names: string[] = [];
  for (const slide of ids) {
    const id = pptxAttribute(slide.value, "id");
    const relationId = pptxAttribute(slide.value, "id", PPTX_OFFICE_RELATIONSHIP_NAMESPACES, slide.namespaces);
    if (!id || typeof relationId !== "string" || usedIds.has(id)) return null;
    const name = relationMap.get(relationId);
    if (!name || usedNames.has(name)) return null;
    usedIds.add(id);
    usedNames.add(name);
    const slideXml = await zip.file(name)?.async("string");
    if (!slideXml || /<!DOCTYPE|<!ENTITY/iu.test(slideXml) || XMLValidator.validate(slideXml) !== true) return null;
    const slideRoot = pptxElement(xmlParser.parse(slideXml), "sld", PPTX_PRESENTATION_NAMESPACES);
    if (!slideRoot) return null;
    const show = pptxAttribute(slideRoot.value, "show");
    if (show !== "0" && show !== "false") names.push(name);
  }
  return names;
}

type PptxElement = { value: Record<string, unknown>; namespaces: Record<string, string> };

function pptxLocalElementCount(parent: Record<string, unknown>, localName: string): number {
  return Object.entries(parent).reduce((count, [key, value]) =>
    count + (!key.startsWith("@_") && xmlLocalName(key) === localName ? asXmlArray(value).length : 0), 0);
}

function pptxElements(parent: unknown, localName: string, allowedNamespaces: Set<string>, inherited: Record<string, string> = {}): PptxElement[] {
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return [];
  const matches: PptxElement[] = [];
  for (const [qualifiedName, rawValue] of Object.entries(parent)) {
    if (qualifiedName.startsWith("@_") || xmlLocalName(qualifiedName) !== localName) continue;
    for (const value of asXmlArray(rawValue)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const namespaces = { ...inherited };
      for (const [key, uri] of Object.entries(value)) {
        if (typeof uri !== "string") continue;
        if (key === "@_xmlns") namespaces[""] = uri;
        else if (key.startsWith("@_xmlns:")) namespaces[key.slice(8)] = uri;
      }
      const colon = qualifiedName.indexOf(":");
      const prefix = colon < 0 ? "" : qualifiedName.slice(0, colon);
      if (allowedNamespaces.has(namespaces[prefix] || "")) matches.push({ value: value as Record<string, unknown>, namespaces });
    }
  }
  return matches;
}

function pptxElement(parent: unknown, localName: string, allowedNamespaces: Set<string>, inherited: Record<string, string> = {}): PptxElement | undefined {
  const matches = pptxElements(parent, localName, allowedNamespaces, inherited);
  return matches.length === 1 ? matches[0] : undefined;
}

function pptxAttribute(value: Record<string, unknown>, localName: string, allowedNamespaces?: Set<string>, namespaces: Record<string, string> = {}): string | undefined {
  for (const [key, raw] of Object.entries(value)) {
    if (!key.startsWith("@_") || typeof raw !== "string" && typeof raw !== "number") continue;
    const name = key.slice(2);
    if (xmlLocalName(name) !== localName) continue;
    const colon = name.indexOf(":");
    if (allowedNamespaces ? colon < 0 || !allowedNamespaces.has(namespaces[name.slice(0, colon)] || "") : colon >= 0) continue;
    return String(raw);
  }
  return undefined;
}

function chunkLineSource(value: string): ChunkDraft[] {
  const bounded = limitText(value);
  const lines = splitLines(bounded);
  return [{
    text: bounded,
    locator: `lines:1-${Math.max(1, lines.length)}`,
    precision: "exact",
  }];
}

function chunkCsvSource(value: string): ChunkDraft[] {
  const rows = parseCsvRows(limitText(value));
  const chunks = rows.flatMap((row) => row.cells.map((cell, columnIndex) => {
    const text = limitText(cell);
    const locator = `row:${row.rowNumber},column:${columnIndex + 1}`;
    const typedValue = inferCsvValue(cell);
    return {
      text,
      locator,
      precision: "exact" as const,
      fact: {
        kind: "spreadsheet-cell" as const,
        format: "csv" as const,
        valueType: typedValue.valueType,
        value: typedValue.value,
        coordinate: { row: row.rowNumber, column: columnIndex + 1 },
        locator,
      },
    };
  }));
  return chunks.length ? chunks : [{ text: "", locator: "row:1,column:1", precision: "exact" }];
}

function inferCsvValue(text: string): { valueType: "string" | "number" | "boolean"; value: string | number | boolean } {
  const normalized = text.trim().toLowerCase();
  if (normalized === "true") return { valueType: "boolean", value: true };
  if (normalized === "false") return { valueType: "boolean", value: false };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text.trim())) {
    const value = Number(text.trim());
    if (Number.isFinite(value)) return { valueType: "number", value };
  }
  return { valueType: "string", value: text };
}

function splitLines(value: string) {
  return value.split(/\r\n|\n|\r/u);
}

type CsvRow = { rowNumber: number; cells: string[] };

function parseCsvRows(value: string): CsvRow[] {
  const csv = value.replace(/^\uFEFF/u, "");
  const delimiter = detectCsvDelimiter(csv);
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let state: "unquoted" | "quoted" | "afterQuote" = "unquoted";
  let physicalLine = 1;
  let rowStartLine = 1;
  let rowStarted = false;
  let index = 0;

  const finishCell = () => {
    cells.push(cell);
    cell = "";
  };
  const finishRow = () => {
    finishCell();
    rows.push({ rowNumber: rowStartLine, cells });
    cells = [];
    rowStarted = false;
  };

  while (index < csv.length) {
    const character = csv[index];
    if (state === "quoted") {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 2;
        continue;
      }
      if (character === '"') {
        state = "afterQuote";
        index += 1;
        continue;
      }
      if (character === "\r" || character === "\n") {
        const newline = character === "\r" && csv[index + 1] === "\n" ? "\r\n" : character;
        cell += newline;
        physicalLine += 1;
        index += newline.length;
      } else {
        cell += character;
        index += 1;
      }
      continue;
    }
    if (character === '"' && state === "unquoted" && cell.length === 0) {
      state = "quoted";
      rowStarted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      finishCell();
      state = "unquoted";
      rowStarted = true;
      index += 1;
      continue;
    }
    if (character === "\r" || character === "\n") {
      finishRow();
      if (character === "\r" && csv[index + 1] === "\n") index += 2;
      else index += 1;
      physicalLine += 1;
      rowStartLine = physicalLine;
      state = "unquoted";
      continue;
    }
    if (state === "afterQuote" || character === '"') {
      throw new Error(`Malformed CSV quote at line ${physicalLine}`);
    }
    cell += character;
    rowStarted = true;
    index += 1;
  }
  if (state === "quoted") throw new Error(`Unmatched CSV quote at line ${rowStartLine}`);
  if (rowStarted || rows.length === 0) finishRow();
  return rows;
}

function detectCsvDelimiter(value: string) {
  const firstLine = value.split(/\r\n|\n|\r/u, 1)[0] || "";
  const commaCount = countOutsideQuotes(firstLine, ",");
  const semicolonCount = countOutsideQuotes(firstLine, ";");
  return semicolonCount > commaCount ? ";" : ",";
}

function countOutsideQuotes(value: string, delimiter: string) {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    else if (!quoted && value[index] === delimiter) count += 1;
  }
  return count;
}

function toSourceChunk(input: {
  sourceId: string;
  sourceName: string;
  mimeType: string;
  chunk: ChunkDraft;
  index: number;
}): SourceChunk {
  return {
    sourceId: input.sourceId,
    chunkId: stableChunkId(input.sourceId, input.chunk.locator, input.chunk.text, input.index),
    sourceName: input.sourceName,
    mimeType: input.mimeType,
    text: limitText(input.chunk.text),
    locator: input.chunk.locator,
    precision: input.chunk.precision,
    ...(input.chunk.mergedRange ? { mergedRange: input.chunk.mergedRange } : {}),
  };
}

function toSourceFact(input: {
  sourceId: string;
  chunkId: string;
  fact: FactDraft;
}): SourceFact {
  if (input.fact.kind === "spreadsheet-cell") {
    const value = typeof input.fact.value === "string" ? limitText(input.fact.value) : input.fact.value;
    return {
      ...input.fact,
      value,
      factId: stableFactId(input.sourceId, input.chunkId, input.fact.locator, JSON.stringify({
        format: input.fact.format,
        valueType: input.fact.valueType,
        value,
        coordinate: input.fact.coordinate,
        formula: input.fact.formula,
        mergedRange: input.fact.mergedRange,
      })),
      sourceId: input.sourceId,
      chunkId: input.chunkId,
    };
  }
  return {
    ...input.fact,
    factId: stableFactId(input.sourceId, input.chunkId, input.fact.locator, JSON.stringify({
      mimeType: input.fact.mimeType,
      byteSize: input.fact.byteSize,
      width: input.fact.width,
      height: input.fact.height,
    })),
    sourceId: input.sourceId,
    chunkId: input.chunkId,
  };
}

function stableSourceId(name: string, buffer: Buffer) {
  return "source-" + createHash("sha256")
    .update(name)
    .update("\u0000")
    .update(buffer)
    .digest("hex")
    .slice(0, 24);
}

function stableChunkId(sourceId: string, locator: string, text: string, index: number) {
  return "chunk-" + createHash("sha256")
    .update(sourceId)
    .update("\u0000")
    .update(String(index))
    .update("\u0000")
    .update(locator)
    .update("\u0000")
    .update(text)
    .digest("hex")
    .slice(0, 24);
}

function stableFactId(sourceId: string, chunkId: string, locator: string, value: string) {
  return "fact-" + createHash("sha256")
    .update(sourceId)
    .update("\u0000")
    .update(chunkId)
    .update("\u0000")
    .update(locator)
    .update("\u0000")
    .update(value)
    .digest("hex")
    .slice(0, 24);
}

function limitText(value: string) {
  return value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value;
}

function collectText(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    if (isXmlTextNode(key)) collectTextNode(child, result);
    else collectText(child, result);
  });
  return result;
}

function isXmlTextNode(key: string) {
  return !key.startsWith("@_") && (key === "t" || key.endsWith(":t"));
}

function collectTextNode(value: unknown, result: string[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectTextNode(item, result));
    return;
  }
  if (typeof value === "string" || typeof value === "number") result.push(String(value));
  else if (value && typeof value === "object") collectText(value, result);
}

function extractExcerpts(value: string) {
  return value
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 45)
    .slice(0, 12)
    .map((sentence) => compact(sentence, 280));
}

function extractKeywords(value: string) {
  const ignored = new Set([
    "это", "как", "для", "или", "что", "при", "без", "the", "and", "with", "from", "this",
    "презентация", "presentation", "тема", "нужно", "можно", "будет", "которые",
  ]);
  const counts = new Map<string, number>();
  value.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}-]{4,}/gu)?.forEach((word) => {
    if (!ignored.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ru"))
    .slice(0, 20)
    .map(([word]) => word);
}

function compact(value: string, limit: number) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? collapsed.slice(0, Math.max(0, limit - 1)).trimEnd() + "…" : collapsed;
}

function mimeFromName(name: string) {
  const extension = path.extname(name).toLowerCase();
  return ({
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

function isSupportedImageExtension(extension: string) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension);
}

function isSupportedImageMime(mimeType: string) {
  return ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"].includes(mimeType.toLowerCase());
}

function detectImageMime(buffer: Buffer): SupportedImageMime | undefined {
  if (buffer.length >= 8 && Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).equals(buffer.subarray(0, 8))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const gifHeader = buffer.subarray(0, 6).toString("ascii");
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function detectImageDimensions(mimeType: SupportedImageMime, buffer: Buffer) {
  if (mimeType === "image/png" && buffer.length >= 24) {
    return positiveDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (mimeType === "image/gif" && buffer.length >= 10) {
    return positiveDimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }
  if (mimeType === "image/webp") return detectWebpDimensions(buffer);
  if (mimeType === "image/jpeg") return detectJpegDimensions(buffer);
  return undefined;
}

function positiveDimensions(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function detectWebpDimensions(buffer: Buffer) {
  if (buffer.length < 30) return undefined;
  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType === "VP8X") {
    const width = 1 + buffer[24]! + (buffer[25]! << 8) + (buffer[26]! << 16);
    const height = 1 + buffer[27]! + (buffer[28]! << 8) + (buffer[29]! << 16);
    return positiveDimensions(width, height);
  }
  if (chunkType === "VP8L" && buffer[20] === 0x2f && buffer.length >= 25) {
    const width = 1 + (buffer[21]! | ((buffer[22]! & 0x3f) << 8));
    const height = 1 + ((buffer[22]! >> 6) | (buffer[23]! << 2) | ((buffer[24]! & 0x0f) << 10));
    return positiveDimensions(width, height);
  }
  if (chunkType === "VP8 ") {
    const frameStart = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (frameStart >= 0 && frameStart + 7 <= buffer.length) {
      return positiveDimensions(buffer.readUInt16LE(frameStart + 3) & 0x3fff, buffer.readUInt16LE(frameStart + 5) & 0x3fff);
    }
  }
  return undefined;
}

function detectJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return undefined;
    const marker = buffer[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 1 >= buffer.length) return undefined;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return undefined;
    if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
      return positiveDimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }
    offset += segmentLength;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number) {
  return [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ].includes(marker);
}
