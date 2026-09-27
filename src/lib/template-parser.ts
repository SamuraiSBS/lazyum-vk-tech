import { createHash } from "node:crypto";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import {
  designSystemSchema,
  type DesignSystem,
  type EvidenceSource,
  type ImageAssetEvidence,
  type RelationshipEvidence,
  type TemplateElement,
  type TemplateLayout,
} from "./schemas";

const EMU_PER_PIXEL = 9_525;
const MAX_TEMPLATE_BYTES = 50 * 1024 * 1024;
const MAX_XML_BYTES = 3 * 1024 * 1024;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: false,
  processEntities: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

type ParsedXml = Record<string, unknown>;
type EvidenceRecord<T> = {
  value: T;
  confidence: number;
  sources: EvidenceSource[];
};

type ParsedRelationship = {
  relationshipId: string;
  relationshipType: string;
  rawTarget: string;
  targetFile?: string;
  targetMode?: string;
};

type ThemeTokens = {
  colors: string[];
  colorEvidence: EvidenceRecord<string>[];
  scheme: Map<string, EvidenceRecord<string>>;
  headingFonts: string[];
  bodyFonts: string[];
  fontSizes: number[];
  fontWeights: number[];
  headingFontEvidence: EvidenceRecord<string>[];
  bodyFontEvidence: EvidenceRecord<string>[];
  fontSizeEvidence: EvidenceRecord<number>[];
  fontWeightEvidence: EvidenceRecord<number>[];
};

type InheritableProperty = "x" | "y" | "w" | "h" | "fontFamily" | "fontSize" | "fontWeight" | "fill" | "stroke";
type InternalTemplateElement = TemplateElement & {
  __placeholderIndex?: string;
  __explicitProperties: Set<InheritableProperty>;
  __availableProperties: Set<InheritableProperty>;
  __propertySources: Partial<Record<InheritableProperty, EvidenceSource>>;
  __inheritedSources: string[];
};
type BackgroundToken = {
  value: string;
  sources: EvidenceSource[];
  confidence: number;
};
type InternalTemplateLayout = TemplateLayout & {
  elements: InternalTemplateElement[];
  __directBackground?: BackgroundToken;
  __effectiveBackground?: BackgroundToken;
};
type ParsedMaster = {
  sourceFile: string;
  name: string;
  elements: InternalTemplateElement[];
  background?: BackgroundToken;
};

const inheritableProperties: InheritableProperty[] = [
  "x", "y", "w", "h", "fontFamily", "fontSize", "fontWeight", "fill", "stroke",
];

export async function parsePptxTemplate(
  buffer: Buffer,
  sourceName = "template.pptx",
): Promise<DesignSystem> {
  if (buffer.byteLength > MAX_TEMPLATE_BYTES) {
    throw new Error("PPTX template exceeds the 50 MB safety limit");
  }

  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  const warnings: string[] = [];
  const backgroundEvidence: EvidenceRecord<string>[] = [];
  const relationships: RelationshipEvidence[] = [];
  const imageAssets: ImageAssetEvidence[] = [];
  const theme = await extractThemeTokens(zip, warnings);
  const presentation = await readXml(zip, "ppt/presentation.xml", warnings);
  const slideSize = extractSlideSize(presentation, warnings);
  const layoutNames = listPackageFiles(zip, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i);
  const slideNames = listPackageFiles(zip, /^ppt\/slides\/slide\d+\.xml$/i);
  const masterNames = listPackageFiles(zip, /^ppt\/slideMasters\/slideMaster\d+\.xml$/i);
  const parsedLayouts: InternalTemplateLayout[] = [];
  for (const [index, name] of layoutNames.entries()) {
    parsedLayouts.push(await extractTemplateLayout(zip, name, "layout", index + 1, slideSize, theme, warnings));
  }
  const parsedSlides: InternalTemplateLayout[] = [];
  for (const [index, name] of slideNames.entries()) {
    parsedSlides.push(await extractTemplateLayout(zip, name, "slide", index + 1, slideSize, theme, warnings));
  }
  const masters: ParsedMaster[] = [];
  for (const name of masterNames) {
    masters.push(await extractMaster(zip, name, slideSize, theme, warnings));
  }

  for (const layout of [...parsedLayouts, ...parsedSlides]) {
    await hydrateLayoutRelationships(zip, layout, warnings, relationships, imageAssets);
  }
  for (const master of masters) {
    await hydrateRelationships(zip, master.sourceFile, master.elements, warnings, imageAssets);
  }
  const mastersByFile = new Map(masters.map((master) => [master.sourceFile, master]));
  const layoutsByFile = new Map(parsedLayouts.map((layout) => [layout.sourceFile, layout]));
  parsedLayouts.forEach((layout) => {
    const master = layout.masterSourceFile ? mastersByFile.get(layout.masterSourceFile) : undefined;
    if (master) layout.elements = mergeInheritedElements(master.elements, layout.elements, master.sourceFile);
    refreshLayoutMetrics(layout);
  });
  parsedSlides.forEach((slide) => {
    const baseLayout = slide.layoutSourceFile ? layoutsByFile.get(slide.layoutSourceFile) : undefined;
    if (baseLayout) {
      slide.masterSourceFile = baseLayout.masterSourceFile;
      slide.elements = mergeInheritedElements(baseLayout.elements, slide.elements, baseLayout.sourceFile);
    }
    refreshLayoutMetrics(slide);
  });
  resolveEffectiveBackgrounds(parsedLayouts, parsedSlides, mastersByFile, layoutsByFile, warnings, backgroundEvidence);

  // Layouts often only contain inherited placeholders. Slides are still useful
  // examples of the real compositions, so retain both while de-duplicating
  // equivalent empty layouts.
  const layouts = deduplicateLayouts([...parsedLayouts, ...parsedSlides])
    .filter((layout) => layout.elements.length > 0);
  if (!layouts.length) {
    warnings.push("No drawable layout was found; using a safe empty title layout");
    const fallbackLayout = emptyLayout(slideSize);
    fallbackLayout.background = "#FFFFFF";
    layouts.push(fallbackLayout);
    addFallbackBackgroundEvidence(backgroundEvidence, warnings, "generated");
  }

  const allElements = [
    ...parsedLayouts.flatMap((layout) => layout.elements),
    ...parsedSlides.flatMap((layout) => layout.elements),
    ...masters.flatMap((master) => master.elements),
  ];
  const elementColorEvidence = allElements.flatMap((element) => {
    const colors: Array<readonly [string, "fill" | "stroke"]> = [];
    if (element.fill) colors.push([element.fill, "fill"]);
    if (element.stroke) colors.push([element.stroke, "stroke"]);
    return colors.map(([value, property]) => tokenEvidence(value, elementSource(element, property), elementConfidence(element)));
  });
  const colorsEvidence = consolidateEvidence([...theme.colorEvidence, ...elementColorEvidence]).slice(0, 24);
  if (!colorsEvidence.length) {
    warnings.push("Fallback design-system colors used: no color token was extracted");
    ["#2B2D42", "#FFFFFF", "#EF8354"].forEach((value) => colorsEvidence.push(
      tokenEvidence(value, generatedSource("fallback/colors"), 0.15),
    ));
  }
  const colors = colorsEvidence.map((entry) => entry.value);

  const elementFontEvidence = allElements.flatMap((element) => element.fontFamily
    ? [tokenEvidence(element.fontFamily, elementSource(element, "fontFamily"), elementConfidence(element))]
    : []);
  const headingFontEvidence = consolidateEvidence([...theme.headingFontEvidence, ...elementFontEvidence]).slice(0, 12);
  const bodyFontEvidence = consolidateEvidence([...theme.bodyFontEvidence, ...elementFontEvidence]).slice(0, 12);
  const sizeEvidence = sortEvidence(consolidateEvidence([
    ...theme.fontSizeEvidence,
    ...allElements.flatMap((element) => element.fontSize === undefined ? [] : [tokenEvidence(element.fontSize, elementSource(element, "fontSize"), elementConfidence(element))]),
  ]), (left, right) => left.value - right.value).slice(0, 30);
  const weightEvidence = sortEvidence(consolidateEvidence([
    ...theme.fontWeightEvidence,
    ...allElements.flatMap((element) => element.fontWeight === undefined ? [] : [tokenEvidence(element.fontWeight, elementSource(element, "fontWeight"), elementConfidence(element))]),
  ]), (left, right) => left.value - right.value).slice(0, 12);
  const spacingEvidence = extractSpacingEvidence(allElements, slideSize);
  const shapeTypeEvidence = consolidateEvidence(allElements.map((element) =>
    tokenEvidence(element.type, elementSource(element), elementConfidence(element)),
  )).slice(0, 20);
  const radiusEvidence = consolidateEvidence(allElements
    .filter((element) => element.radius !== undefined && element.radius > 0)
    .map((element) => tokenEvidence(element.radius!, elementSource(element), elementConfidence(element))))
    .slice(0, 20);
  const strokeEvidence = consolidateEvidence(allElements
    .filter((element) => Boolean(element.stroke))
    .map((element) => tokenEvidence(element.stroke!, elementSource(element, "stroke"), elementConfidence(element))))
    .slice(0, 24);
  const finalBackgroundEvidence = consolidateEvidence(backgroundEvidence).slice(0, 80);
  const recurringElements = extractRecurringElements(layouts);

  return designSystemSchema.parse({
    version: 1,
    sourceName,
    slideSize: {
      ...slideSize,
      aspectRatio: round(slideSize.width / slideSize.height),
    },
    colors,
    typography: {
      headingFonts: headingFontEvidence.map((entry) => entry.value),
      bodyFonts: bodyFontEvidence.map((entry) => entry.value),
      fontSizes: sizeEvidence.map((entry) => entry.value),
      fontWeights: weightEvidence.map((entry) => entry.value),
    },
    spacing: {
      horizontalMargins: spacingEvidence.horizontalMargins.map((entry) => entry.value),
      verticalMargins: spacingEvidence.verticalMargins.map((entry) => entry.value),
      gaps: spacingEvidence.gaps.map((entry) => entry.value),
    },
    shapes: {
      types: shapeTypeEvidence.map((entry) => entry.value),
      radii: radiusEvidence.map((entry) => entry.value),
      strokes: strokeEvidence.map((entry) => entry.value),
    },
    masters: masters.map(({ sourceFile, name, elements }) => ({ sourceFile, name, elementCount: elements.length })),
    layouts,
    recurringElements,
    visualPatterns: inferVisualPatterns(layouts),
    evidence: {
      colors: colorsEvidence,
      typography: {
        headingFonts: headingFontEvidence,
        bodyFonts: bodyFontEvidence,
        fontSizes: sizeEvidence,
        fontWeights: weightEvidence,
      },
      spacing: spacingEvidence,
      shapes: {
        types: shapeTypeEvidence,
        radii: radiusEvidence,
        strokes: strokeEvidence,
      },
      backgrounds: finalBackgroundEvidence,
    },
    relationships: uniqueRelationships(relationships),
    imageAssets: uniqueImageAssets(imageAssets),
    warnings: unique(warnings).sort().slice(0, 200),
  });
}

async function extractMaster(
  zip: JSZip,
  sourceFile: string,
  slideSize: { width: number; height: number },
  theme: ThemeTokens,
  warnings: string[],
): Promise<ParsedMaster> {
  const document = await readXml(zip, sourceFile, warnings);
  const elements = document ? extractElements(document, slideSize, theme, sourceFile) : [];
  const background = document ? extractBackground(document, sourceFile, theme, warnings) : undefined;
  const name = firstString(findFirst(document, "p:cSld"), "@_name") || basename(sourceFile);
  return { sourceFile, name, elements, background };
}

async function extractThemeTokens(zip: JSZip, warnings: string[]): Promise<ThemeTokens> {
  const themeFiles = listPackageFiles(zip, /^ppt\/theme\/theme\d+\.xml$/i);
  const tokens: ThemeTokens = {
    colors: [],
    colorEvidence: [],
    scheme: new Map(),
    headingFonts: [],
    bodyFonts: [],
    fontSizes: [],
    fontWeights: [],
    headingFontEvidence: [],
    bodyFontEvidence: [],
    fontSizeEvidence: [],
    fontWeightEvidence: [],
  };
  if (!themeFiles.length) {
    warnings.push("No PPTX theme file was found");
    return tokens;
  }
  for (const file of themeFiles.slice(0, 4)) {
    const document = await readXml(zip, file, warnings);
    collectTheme(document, tokens, file);
  }
  tokens.colorEvidence = consolidateEvidence(tokens.colorEvidence);
  tokens.colors = tokens.colorEvidence.map((entry) => entry.value);
  tokens.headingFontEvidence = consolidateEvidence(tokens.headingFontEvidence);
  tokens.bodyFontEvidence = consolidateEvidence(tokens.bodyFontEvidence);
  tokens.fontSizeEvidence = consolidateEvidence(tokens.fontSizeEvidence);
  tokens.fontWeightEvidence = consolidateEvidence(tokens.fontWeightEvidence);
  tokens.headingFonts = tokens.headingFontEvidence.map((entry) => entry.value);
  tokens.bodyFonts = tokens.bodyFontEvidence.map((entry) => entry.value);
  tokens.fontSizes = tokens.fontSizeEvidence.map((entry) => entry.value);
  tokens.fontWeights = tokens.fontWeightEvidence.map((entry) => entry.value);
  return tokens;
}

async function extractTemplateLayout(
  zip: JSZip,
  sourceFile: string,
  source: "layout" | "slide",
  index: number,
  slideSize: { width: number; height: number },
  theme: ThemeTokens,
  warnings: string[],
): Promise<InternalTemplateLayout> {
  const document = await readXml(zip, sourceFile, warnings);
  if (!document) {
    const fallback = emptyLayout(slideSize);
    const layout: InternalTemplateLayout = {
      ...fallback,
      id: source + "-" + index,
      name: basename(sourceFile),
      source,
      sourceFile,
      background: undefined,
    };
    return layout;
  }
  const elements = extractElements(document, slideSize, theme, sourceFile);
  const background = extractBackground(document, sourceFile, theme, warnings);
  const textSlots = elements.filter((element) => element.type === "text" || element.type === "placeholder").length;
  const placeholderCount = elements.filter((element) => element.type === "placeholder").length;
  const visualSlots = elements.filter((element) => ["image", "chart", "table"].includes(element.type)).length;
  const cardCount = countCards(elements);
  const name = firstString(findFirst(document, "p:cSld"), "@_name") || basename(sourceFile);
  const composition = inferComposition(elements, textSlots, visualSlots, cardCount);
  const layout: InternalTemplateLayout = {
    id: source + "-" + index,
    name: name || (source === "layout" ? "Layout " : "Slide ") + index,
    source,
    sourceFile,
    width: slideSize.width,
    height: slideSize.height,
    background: background?.value,
    elements,
    textSlots,
    placeholderCount,
    visualSlots,
    cardCount,
    composition,
    recurringElementIds: [],
  };
  layout.__directBackground = background;
  return layout;
}

function extractSlideSize(document: ParsedXml | undefined, warnings: string[]) {
  const presentation = document ? findFirst(document, "p:presentation") : undefined;
  const size = asRecord(presentation)?.["p:sldSz"];
  const cx = numberAttribute(size, "@_cx");
  const cy = numberAttribute(size, "@_cy");
  if (!cx || !cy) {
    warnings.push("Slide size was not declared; assuming 16:9 1280×720");
    return { width: 1280, height: 720 };
  }
  return { width: Math.round(cx / EMU_PER_PIXEL), height: Math.round(cy / EMU_PER_PIXEL) };
}

function extractElements(
  document: ParsedXml,
  slideSize: { width: number; height: number },
  theme: ThemeTokens,
  sourceFile: string,
) {
  const root = findFirst(document, "p:spTree");
  if (!root) return [];
  const elements: InternalTemplateElement[] = [];
  let zIndex = 0;
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (key === "p:sp") {
        for (const shape of asArray(child)) elements.push(extractShape(shape, "shape", zIndex++, slideSize, theme, sourceFile));
        continue;
      }
      if (key === "p:pic") {
        for (const picture of asArray(child)) elements.push(extractShape(picture, "image", zIndex++, slideSize, theme, sourceFile));
        continue;
      }
      if (key === "p:cxnSp") {
        for (const line of asArray(child)) elements.push(extractShape(line, "line", zIndex++, slideSize, theme, sourceFile));
        continue;
      }
      if (key === "p:graphicFrame") {
        for (const frame of asArray(child)) elements.push(extractGraphicFrame(frame, zIndex++, slideSize, theme, sourceFile));
        continue;
      }
      if (key === "p:grpSp") {
        for (const group of asArray(child)) {
          elements.push(extractShape(group, "group", zIndex++, slideSize, theme, sourceFile));
          walk(group);
        }
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return elements.filter((element) => element.w > 0 && element.h > 0);
}

function extractShape(
  value: unknown,
  fallbackType: TemplateElement["type"],
  zIndex: number,
  slideSize: { width: number; height: number },
  theme: ThemeTokens,
  sourceFile: string,
): InternalTemplateElement {
  const cNvPr = findFirst(value, "p:cNvPr");
  const transform = findFirst(value, "a:xfrm");
  const off = asRecord(transform)?.["a:off"];
  const ext = asRecord(transform)?.["a:ext"];
  const geometry = normalizeGeometry(
    numberAttribute(off, "@_x"),
    numberAttribute(off, "@_y"),
    numberAttribute(ext, "@_cx"),
    numberAttribute(ext, "@_cy"),
    slideSize,
  );
  const placeholder = findFirst(value, "p:ph");
  const placeholderIndex = firstString(placeholder, "@_idx");
  const text = collectText(value).join("\n").trim();
  const textProps = findTextProps(value);
  const elementType = placeholder
    ? "placeholder"
    : findFirst(value, "p:txBody")
      ? "text"
      : fallbackType;
  const shapeName = firstString(cNvPr, "@_name") || firstString(cNvPr, "@_id") || fallbackType + "-" + zIndex;
  const radius = /roundRect|round/i.test(String(findFirst(value, "@_prst") || "")) ? Math.min(geometry.w, geometry.h) * 0.08 : undefined;
  const id = String(firstString(cNvPr, "@_id") || "element-" + zIndex);
  const source: EvidenceSource = { sourceFile, elementId: id };
  const explicitProperties = new Set<InheritableProperty>();
  const propertySources: Partial<Record<InheritableProperty, EvidenceSource>> = {};
  const offRecord = asRecord(off);
  const extRecord = asRecord(ext);
  if (hasNumericAttribute(offRecord, "@_x")) explicitProperties.add("x");
  if (hasNumericAttribute(offRecord, "@_y")) explicitProperties.add("y");
  if (hasNumericAttribute(extRecord, "@_cx")) explicitProperties.add("w");
  if (hasNumericAttribute(extRecord, "@_cy")) explicitProperties.add("h");
  for (const property of ["x", "y", "w", "h"] as const) {
    if (explicitProperties.has(property)) propertySources[property] = source;
  }
  if (textProps.fontFamily) {
    explicitProperties.add("fontFamily");
    propertySources.fontFamily = source;
  }
  if (textProps.fontSize !== undefined) {
    explicitProperties.add("fontSize");
    propertySources.fontSize = source;
  }
  if (textProps.hasExplicitFontWeight) {
    explicitProperties.add("fontWeight");
    propertySources.fontWeight = source;
  }
  const shapeProperties = findFirst(value, "p:spPr");
  const lineProperties = findFirst(shapeProperties, "a:ln");
  const fillDeclaration = findDirectShapeFill(shapeProperties);
  const fill = firstColor(fillDeclaration, theme);
  const stroke = firstColor(lineProperties, theme);
  if (fill || hasDirectNoFill(shapeProperties)) {
    explicitProperties.add("fill");
    propertySources.fill = source;
  }
  if (stroke || hasDirectNoFill(lineProperties)) {
    explicitProperties.add("stroke");
    propertySources.stroke = source;
  }
  return {
    id,
    type: elementType,
    name: shapeName,
    ...geometry,
    text,
    fontFamily: textProps.fontFamily,
    fontSize: textProps.fontSize,
    fontWeight: textProps.fontWeight ?? (elementType === "placeholder" && textProps.hasExplicitFontWeight ? 400 : undefined),
    fill,
    stroke,
    radius,
    placeholderType: firstString(placeholder, "@_type"),
    relationshipId: firstString(findFirst(value, "a:blip"), "@_r:embed")
      || firstString(findFirst(value, "a:blip"), "@_embed")
      || firstString(findFirst(value, "a:blip"), "@_r:link"),
    sourceFile,
    zIndex,
    ...(placeholderIndex === undefined ? {} : { __placeholderIndex: placeholderIndex }),
    __explicitProperties: explicitProperties,
    __availableProperties: new Set(explicitProperties),
    __propertySources: propertySources,
    __inheritedSources: [],
  };
}

async function hydrateLayoutRelationships(
  zip: JSZip,
  layout: InternalTemplateLayout,
  warnings: string[],
  relationshipEvidence: RelationshipEvidence[],
  imageAssets: ImageAssetEvidence[],
) {
  const relationships = await hydrateRelationships(zip, layout.sourceFile, layout.elements, warnings, imageAssets);
  relationships.forEach((relationship) => {
    const type = relationship.relationshipType;
    if (/slideLayout$/i.test(type)) {
      const targetFile = relationship.targetFile;
      if (!isValidInternalTarget(zip, relationship, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i) || !targetFile) {
        addInvalidTemplateRelationshipWarning(warnings, layout.sourceFile, relationship, "slide layout");
        return;
      }
      layout.layoutSourceFile = targetFile;
      relationshipEvidence.push({
        kind: "slide-layout",
        sourceFile: layout.sourceFile,
        relationshipFile: relationshipFileFor(layout.sourceFile),
        relationshipId: relationship.relationshipId,
        relationshipType: relationship.relationshipType,
        targetFile,
      });
    }
    if (/slideMaster$/i.test(type)) {
      const targetFile = relationship.targetFile;
      if (!isValidInternalTarget(zip, relationship, /^ppt\/slideMasters\/slideMaster\d+\.xml$/i) || !targetFile) {
        addInvalidTemplateRelationshipWarning(warnings, layout.sourceFile, relationship, "slide master");
        return;
      }
      layout.masterSourceFile = targetFile;
      relationshipEvidence.push({
        kind: "layout-master",
        sourceFile: layout.sourceFile,
        relationshipFile: relationshipFileFor(layout.sourceFile),
        relationshipId: relationship.relationshipId,
        relationshipType: relationship.relationshipType,
        targetFile,
      });
    }
  });
  return relationships;
}

function isValidInternalTarget(zip: JSZip, relationship: ParsedRelationship, matcher: RegExp) {
  return relationship.targetMode !== "External"
    && Boolean(relationship.targetFile && matcher.test(relationship.targetFile) && zipHasFile(zip, relationship.targetFile));
}

function addInvalidTemplateRelationshipWarning(
  warnings: string[],
  sourceFile: string,
  relationship: ParsedRelationship,
  expected: string,
) {
  const target = relationship.targetFile || relationship.rawTarget || "unresolved";
  warnings.push(
    "Invalid " + expected + " relationship target: sourceFile=" + sourceFile +
    "; relationshipId=" + relationship.relationshipId +
    "; relationshipType=" + relationship.relationshipType + "; target=" + target,
  );
}

async function hydrateRelationships(
  zip: JSZip,
  sourceFile: string,
  elements: TemplateElement[],
  warnings: string[],
  imageAssets: ImageAssetEvidence[],
) {
  const relsFile = relationshipFileFor(sourceFile);
  const document = await readXml(zip, relsFile, warnings, true);
  const relationships = parseRelationships(document, sourceFile);
  const targets = new Map(relationships.map((relationship) => [relationship.relationshipId, relationship]));
  for (const relationship of relationships) {
    if (!relationship.rawTarget || (relationship.targetMode !== "External" &&
      (!relationship.targetFile || !zipHasFile(zip, relationship.targetFile)))) {
      addUnresolvedRelationshipWarning(warnings, sourceFile, relationship.relationshipId, relationship);
    }
  }
  for (const element of elements) {
    if (element.type !== "image" || !element.relationshipId) continue;
    const relationship = targets.get(element.relationshipId);
    const target = relationship?.targetFile;
    const file = target ? zip.files[target] : undefined;
    const source = relationshipSource(relsFile, relationship?.relationshipId || element.relationshipId);
    if (!relationship || relationship.targetMode === "External" || !target || !file || !/^ppt\/media\//i.test(target)) {
      addUnresolvedRelationshipWarning(warnings, sourceFile, element.relationshipId, relationship);
      imageAssets.push({
        relationshipId: element.relationshipId,
        sourceFile,
        target: target || relationship?.rawTarget || "unresolved",
        allowed: false,
        sources: [source],
      });
      continue;
    }
    const bytes = await file.async("nodebuffer");
    const data = bytes.toString("base64");
    element.imageDataUrl = "data:" + mimeFromPackagePath(target) + ";base64," + data;
    imageAssets.push({
      relationshipId: element.relationshipId,
      sourceFile,
      target,
      allowed: true,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sources: [source],
    });
  }
  return relationships;
}

function relationshipFileFor(sourceFile: string) {
  const index = sourceFile.lastIndexOf("/");
  const directory = index >= 0 ? sourceFile.slice(0, index) : "";
  const filename = index >= 0 ? sourceFile.slice(index + 1) : sourceFile;
  return directory + "/_rels/" + filename + ".rels";
}

function parseRelationships(document: ParsedXml | undefined, sourceFile: string): ParsedRelationship[] {
  const root = asRecord(document)?.Relationships;
  const rawRelationships = asArray(asRecord(root)?.Relationship);
  return rawRelationships
    .map<ParsedRelationship | undefined>((relationship) => {
      const relationshipId = firstString(relationship, "@_Id");
      if (!relationshipId) return undefined;
      const rawTarget = firstString(relationship, "@_Target") || "";
      const relationshipType = firstString(relationship, "@_Type") || "unknown";
      return {
        relationshipId,
        relationshipType,
        rawTarget,
        targetFile: resolvePackagePath(sourceFile, rawTarget),
        targetMode: firstString(relationship, "@_TargetMode"),
      };
    })
    .filter((relationship): relationship is ParsedRelationship => Boolean(relationship))
    .sort((left, right) => left.relationshipId.localeCompare(right.relationshipId));
}

function resolvePackagePath(sourceFile: string, target: string) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return undefined;
  const base = sourceFile.split("/").slice(0, -1);
  let invalid = false;
  target.split("/").forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") {
      if (!base.length) {
        invalid = true;
        return;
      }
      base.pop();
    }
    else base.push(part);
  });
  return !invalid && base.length ? base.join("/") : undefined;
}

function zipHasFile(zip: JSZip, target: string) {
  return Boolean(zip.files[target] && !zip.files[target].dir);
}

function relationshipSource(relationshipFile: string, relationshipId: string): EvidenceSource {
  return {
    sourceFile: relationshipFile,
    xmlPath: "/Relationships/Relationship[@Id='" + relationshipId + "']/@Target",
    relationshipId,
  };
}

function addUnresolvedRelationshipWarning(
  warnings: string[],
  sourceFile: string,
  relationshipId: string,
  relationship?: ParsedRelationship,
) {
  warnings.push(
    "Unresolved relationship: sourceFile=" + sourceFile + "; relationshipId=" + relationshipId +
    (relationship ? "; relationshipType=" + relationship.relationshipType + "; target=" + (relationship.rawTarget || "unresolved") : ""),
  );
}

function mimeFromPackagePath(value: string) {
  const extension = value.split(".").pop()?.toLowerCase();
  return extension === "png" ? "image/png"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "gif" ? "image/gif"
        : extension === "svg" ? "image/svg+xml"
          : "application/octet-stream";
}

function mergeInheritedElements(
  inherited: InternalTemplateElement[],
  own: InternalTemplateElement[],
  sourceFile: string,
): InternalTemplateElement[] {
  const consumed = new Set<number>();
  const mergedOwn = own.map((element) => {
    if (element.type !== "placeholder") return element;
    const matchIndex = inherited.findIndex((candidate, index) =>
      !consumed.has(index) && placeholdersMatch(candidate, element));
    if (matchIndex < 0) return element;
    consumed.add(matchIndex);
    return mergePlaceholder(inherited[matchIndex], element, sourceFile);
  });
  const occupiedIds = new Set(mergedOwn.map((element) => element.id));
  const copies = inherited.flatMap((element, index) => {
    if (consumed.has(index) || (element.type !== "placeholder" && occupiedIds.has(element.id))) return [];
    const inheritedSources = inheritedSourceChain(element, sourceFile);
    const copy: InternalTemplateElement = {
      ...element,
      id: "inherited-" + index + "-" + element.id,
      inheritedFrom: inheritedSources.join(" -> "),
      zIndex: Math.max(0, element.zIndex - 20),
      __explicitProperties: new Set(element.__explicitProperties),
      __availableProperties: new Set(element.__availableProperties),
      __propertySources: { ...element.__propertySources },
      __inheritedSources: inheritedSources,
    };
    return [copy];
  });
  return [...copies, ...mergedOwn];
}

function placeholdersMatch(left: InternalTemplateElement, right: InternalTemplateElement) {
  if (left.type !== "placeholder" || right.type !== "placeholder") return false;
  const leftIndex = left.__placeholderIndex;
  const rightIndex = right.__placeholderIndex;
  if (leftIndex !== undefined && rightIndex !== undefined && leftIndex !== rightIndex) return false;
  if (left.placeholderType && right.placeholderType && left.placeholderType !== right.placeholderType) return false;
  if (leftIndex !== undefined && rightIndex !== undefined) return true;
  const leftType = left.placeholderType || "obj";
  const rightType = right.placeholderType || "obj";
  return leftType === rightType;
}

function mergePlaceholder(
  inherited: InternalTemplateElement,
  own: InternalTemplateElement,
  sourceFile: string,
): InternalTemplateElement {
  const merged: InternalTemplateElement = {
    ...own,
    placeholderType: own.placeholderType || inherited.placeholderType,
    ...(own.__placeholderIndex === undefined && inherited.__placeholderIndex !== undefined
      ? { __placeholderIndex: inherited.__placeholderIndex }
      : {}),
    __explicitProperties: new Set(own.__explicitProperties),
    __availableProperties: new Set(own.__availableProperties),
    __propertySources: { ...own.__propertySources },
    __inheritedSources: [],
  };
  const childValues = merged as unknown as Record<InheritableProperty, number | string | undefined>;
  const parentValues = inherited as unknown as Record<InheritableProperty, number | string | undefined>;
  let inheritedValue = false;
  for (const property of inheritableProperties) {
    if (own.__explicitProperties.has(property)) continue;
    if (!inherited.__availableProperties.has(property)) continue;
    childValues[property] = parentValues[property];
    merged.__availableProperties.add(property);
    merged.__propertySources[property] = inherited.__propertySources[property]
      || elementSource(inherited, property);
    inheritedValue = true;
  }
  if (inheritedValue) {
    const inheritedSources = inheritedSourceChain(inherited, sourceFile);
    merged.__inheritedSources = inheritedSources;
    merged.inheritedFrom = inheritedSources.join(" -> ");
    if (!merged.sourceFile) merged.sourceFile = inherited.sourceFile || sourceFile;
  }
  return merged;
}

function inheritedSourceChain(element: InternalTemplateElement, sourceFile: string) {
  return [...new Set([
    sourceFile,
    ...(element.sourceFile ? [element.sourceFile] : []),
    ...element.__inheritedSources,
  ])];
}

function extractGraphicFrame(
  value: unknown,
  zIndex: number,
  slideSize: { width: number; height: number },
  theme: ThemeTokens,
  sourceFile: string,
) {
  const hasTable = Boolean(findFirst(value, "a:tbl"));
  const hasChart = Boolean(findFirst(value, "c:chart"));
  return extractShape(value, hasTable ? "table" : hasChart ? "chart" : "unknown", zIndex, slideSize, theme, sourceFile);
}

function normalizeGeometry(
  x: number,
  y: number,
  w: number,
  h: number,
  fallback: { width: number; height: number },
) {
  return {
    x: Math.max(0, Math.round(x / EMU_PER_PIXEL)),
    y: Math.max(0, Math.round(y / EMU_PER_PIXEL)),
    w: Math.max(1, Math.round((w || fallback.width * EMU_PER_PIXEL) / EMU_PER_PIXEL)),
    h: Math.max(1, Math.round((h || fallback.height * EMU_PER_PIXEL) / EMU_PER_PIXEL)),
  };
}

function findTextProps(value: unknown) {
  const propertyNodes = ["a:rPr", "a:defRPr", "a:endParaRPr"]
    .map((key) => findFirst(value, key))
    .filter((candidate) => candidate !== undefined);
  const typeface = propertyNodes
    .map((props) => firstString(findFirst(props, "a:latin"), "@_typeface"))
    .find((candidate) => Boolean(candidate));
  const fontSize = propertyNodes
    .map((props) => numberAttribute(props, "@_sz"))
    .find((candidate) => candidate > 0) || 0;
  const bold = propertyNodes
    .map((props) => firstString(props, "@_b"))
    .find((candidate) => candidate !== undefined);
  return {
    fontFamily: typeface,
    fontSize: fontSize ? Math.round(fontSize / 100 * 96 / 72) : undefined,
    fontWeight: bold === "1" || bold === "true" ? 700 : undefined,
    hasExplicitFontWeight: bold !== undefined,
  };
}

function extractBackground(
  document: ParsedXml,
  sourceFile: string,
  theme: ThemeTokens,
  warnings: string[],
) : BackgroundToken | undefined {
  const backgroundNode = findFirst(document, "p:bg");
  if (!backgroundNode) return undefined;
  const color = firstColor(backgroundNode, theme);
  if (color) {
    const schemeColorName = firstString(findFirst(backgroundNode, "a:schemeClr"), "@_val");
    const schemeEvidence = schemeColorName ? theme.scheme.get(schemeColorName)?.sources || [] : [];
    return {
      value: color,
      sources: [{ sourceFile, xmlPath: "/p:bg" }, ...schemeEvidence],
      confidence: 0.95,
    };
  }
  warnings.push("Unresolved background override: sourceFile=" + sourceFile + "; no supported color token was found in p:bg");
  return undefined;
}

function addFallbackBackgroundEvidence(
  backgroundEvidence: EvidenceRecord<string>[],
  warnings: string[],
  sourceFile: string,
) {
  warnings.push("Fallback background used for " + sourceFile + "; no background token was extracted");
  backgroundEvidence.push(tokenEvidence("#FFFFFF", generatedSource("fallback/background/" + sourceFile), 0.15));
}

function resolveEffectiveBackgrounds(
  parsedLayouts: InternalTemplateLayout[],
  parsedSlides: InternalTemplateLayout[],
  mastersByFile: Map<string, ParsedMaster>,
  layoutsByFile: Map<string, InternalTemplateLayout>,
  warnings: string[],
  backgroundEvidence: EvidenceRecord<string>[],
) {
  for (const layout of parsedLayouts) {
    let effective = layout.__directBackground;
    if (!effective) {
      const master = layout.masterSourceFile ? mastersByFile.get(layout.masterSourceFile) : undefined;
      if (master?.background) effective = inheritBackground(master.background);
    }
    if (!effective) effective = fallbackBackground(layout.sourceFile, warnings);
    setEffectiveBackground(layout, effective, backgroundEvidence);
  }

  for (const slide of parsedSlides) {
    let effective = slide.__directBackground;
    if (!effective) {
      const layout = slide.layoutSourceFile ? layoutsByFile.get(slide.layoutSourceFile) : undefined;
      if (layout?.__effectiveBackground) effective = inheritBackground(layout.__effectiveBackground);
    }
    if (!effective) effective = fallbackBackground(slide.sourceFile, warnings);
    setEffectiveBackground(slide, effective, backgroundEvidence);
  }
}

function inheritBackground(background: BackgroundToken): BackgroundToken {
  return { ...background, sources: [...background.sources], confidence: Math.max(0, background.confidence * 0.9) };
}

function fallbackBackground(sourceFile: string, warnings: string[]): BackgroundToken {
  warnings.push(
    "Fallback background used for " + sourceFile + "; no slide, related layout, or related master background was resolved",
  );
  return {
    value: "#FFFFFF",
    sources: [generatedSource("fallback/background/" + sourceFile)],
    confidence: 0.15,
  };
}

function setEffectiveBackground(
  layout: InternalTemplateLayout,
  background: BackgroundToken,
  evidence: EvidenceRecord<string>[],
) {
  layout.background = background.value;
  layout.__effectiveBackground = background;
  evidence.push(tokenEvidence(background.value, background.sources, background.confidence));
}

function refreshLayoutMetrics(layout: InternalTemplateLayout) {
  const elements = layout.elements;
  const textSlots = elements.filter((element) => element.type === "text" || element.type === "placeholder").length;
  const placeholderCount = elements.filter((element) => element.type === "placeholder").length;
  const visualSlots = elements.filter((element) => ["image", "chart", "table"].includes(element.type)).length;
  const cardCount = countCards(elements);
  layout.textSlots = textSlots;
  layout.placeholderCount = placeholderCount;
  layout.visualSlots = visualSlots;
  layout.cardCount = cardCount;
  layout.composition = inferComposition(elements, textSlots, visualSlots, cardCount);
}

function collectTheme(value: unknown, tokens: ThemeTokens, sourceFile: string, path: string[] = [], activeKey = "") {
  if (Array.isArray(value)) {
    value.forEach((item) => collectTheme(item, tokens, sourceFile, path, activeKey));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    const local = localName(key);
    const childPath = [...path, key];
    if (local === "srgbClr") {
      const color = normalizeColor(firstString(child, "@_val"));
      if (color) {
        const evidence = tokenEvidence(color, {
          sourceFile,
          xmlPath: xmlPath(childPath, "@_val"),
        }, 0.99);
        tokens.colorEvidence.push(evidence);
        if (activeKey && !tokens.scheme.has(localName(activeKey))) tokens.scheme.set(localName(activeKey), evidence);
      }
    }
    if (local === "sysClr") {
      const color = normalizeColor(firstString(child, "@_lastClr") || firstString(child, "@_val"));
      if (color) tokens.colorEvidence.push(tokenEvidence(color, {
        sourceFile,
        xmlPath: xmlPath(childPath, firstString(child, "@_lastClr") ? "@_lastClr" : "@_val"),
      }, 0.99));
    }
    if (local === "latin") {
      const font = firstString(child, "@_typeface");
      if (font) {
        const evidence = tokenEvidence(font, {
          sourceFile,
          xmlPath: xmlPath(childPath, "@_typeface"),
        }, 0.99);
        if (/majorFont|headFont/i.test(activeKey)) tokens.headingFontEvidence.push(evidence);
        else tokens.bodyFontEvidence.push(evidence);
      }
    }
    const size = numberAttribute(child, "@_sz");
    if (size) tokens.fontSizeEvidence.push(tokenEvidence(Math.round(size / 100 * 96 / 72), {
      sourceFile,
      xmlPath: xmlPath(childPath, "@_sz"),
    }, 0.99));
    if (firstString(child, "@_b") === "1") tokens.fontWeightEvidence.push(tokenEvidence(700, {
      sourceFile,
      xmlPath: xmlPath(childPath, "@_b"),
    }, 0.99));
    collectTheme(child, tokens, sourceFile, childPath, key);
  }
}

function firstColor(value: unknown, theme: ThemeTokens): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstColor(item, theme);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const [key, child] of Object.entries(record)) {
    if (localName(key) === "srgbClr") {
      const color = normalizeColor(firstString(child, "@_val"));
      if (color) return color;
    }
    if (localName(key) === "sysClr") {
      const color = normalizeColor(firstString(child, "@_lastClr") || firstString(child, "@_val"));
      if (color) return color;
    }
    if (localName(key) === "schemeClr") {
      const scheme = firstString(child, "@_val");
      const color = scheme ? theme.scheme.get(scheme) : undefined;
      if (color) return color.value;
    }
    const found = firstColor(child, theme);
    if (found) return found;
  }
  return undefined;
}

function collectText(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, result));
    return result;
  }
  const record = asRecord(value);
  if (!record) return result;
  for (const [key, child] of Object.entries(record)) {
    if (localName(key) === "t" && typeof child === "string") result.push(child);
    else collectText(child, result);
  }
  return result;
}

function extractSpacingEvidence(elements: TemplateElement[], slideSize: { width: number; height: number }) {
  const horizontalMargins = elements.flatMap((element) => {
    const confidence = elementConfidence(element);
    return [
      tokenEvidence(element.x, elementSource(element, "x"), confidence),
      tokenEvidence(Math.max(0, slideSize.width - element.x - element.w), [
        elementSource(element, "x"), elementSource(element, "w"),
      ], confidence),
    ];
  });
  const verticalMargins = elements.flatMap((element) => {
    const confidence = elementConfidence(element);
    return [
      tokenEvidence(element.y, elementSource(element, "y"), confidence),
      tokenEvidence(Math.max(0, slideSize.height - element.y - element.h), [
        elementSource(element, "y"), elementSource(element, "h"),
      ], confidence),
    ];
  });
  const gaps: EvidenceRecord<number>[] = [];
  for (const left of elements) {
    for (const right of elements) {
      if (left.id === right.id) continue;
      const sameBand = Math.abs(left.y - right.y) < Math.min(left.h, right.h) * 0.45;
      const gap = right.x - (left.x + left.w);
      if (sameBand && gap >= 0 && gap <= slideSize.width * 0.5) {
        gaps.push(tokenEvidence(
          Math.round(gap),
          [elementSource(left, "x"), elementSource(left, "y"), elementSource(left, "w"),
            elementSource(right, "x"), elementSource(right, "y"), elementSource(right, "w")],
          Math.min(elementConfidence(left), elementConfidence(right)) * 0.9,
        ));
      }
    }
  }
  return {
    horizontalMargins: sortEvidence(consolidateEvidence(horizontalMargins), (left, right) => left.value - right.value).slice(0, 30),
    verticalMargins: sortEvidence(consolidateEvidence(verticalMargins), (left, right) => left.value - right.value).slice(0, 30),
    gaps: sortEvidence(consolidateEvidence(gaps), (left, right) => left.value - right.value).slice(0, 30),
  };
}

function tokenEvidence<T>(value: T, source: EvidenceSource | EvidenceSource[], confidence: number): EvidenceRecord<T> {
  return {
    value,
    confidence,
    sources: Array.isArray(source) ? source : [source],
  };
}

function consolidateEvidence<T>(records: EvidenceRecord<T>[]) {
  const values = new Map<T, EvidenceRecord<T>>();
  for (const record of records) {
    const existing = values.get(record.value);
    if (!existing) {
      values.set(record.value, {
        value: record.value,
        confidence: record.confidence,
        sources: [...record.sources],
      });
      continue;
    }
    const seen = new Set(existing.sources.map(sourceKey));
    existing.confidence = Math.max(existing.confidence, record.confidence);
    for (const source of record.sources) {
      if (!seen.has(sourceKey(source))) {
        existing.sources.push(source);
        seen.add(sourceKey(source));
      }
    }
  }
  return [...values.values()];
}

function sortEvidence<T>(records: EvidenceRecord<T>[], compare: (left: EvidenceRecord<T>, right: EvidenceRecord<T>) => number) {
  return [...records].sort((left, right) => compare(left, right) || sourceKey(left.sources[0]).localeCompare(sourceKey(right.sources[0])));
}

function elementSource(element: TemplateElement, property?: InheritableProperty): EvidenceSource {
  const internal = element as Partial<InternalTemplateElement>;
  const propertySource = property ? internal.__propertySources?.[property] : undefined;
  if (propertySource) return propertySource;
  return {
    sourceFile: element.sourceFile || "generated",
    elementId: element.id,
  };
}

function elementConfidence(element: TemplateElement) {
  if (!element.sourceFile) return 0.15;
  return element.inheritedFrom ? 0.85 : 0.95;
}

function generatedSource(path: string): EvidenceSource {
  return { sourceFile: "generated", xmlPath: "/" + path };
}

function sourceKey(source: EvidenceSource) {
  return [source.sourceFile, source.xmlPath || "", source.elementId || "", source.relationshipId || ""].join("|");
}

function xmlPath(path: string[], attribute?: string) {
  const suffix = attribute ? "/" + attribute.replace(/^@_/, "@") : "";
  return "/" + path.join("/") + suffix;
}

function uniqueRelationships(records: RelationshipEvidence[]) {
  const seen = new Set<string>();
  return [...records]
    .filter((record) => {
      const key = [record.kind, record.sourceFile, record.relationshipId, record.targetFile].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => [left.sourceFile, left.kind, left.relationshipId, left.targetFile].join("|")
      .localeCompare([right.sourceFile, right.kind, right.relationshipId, right.targetFile].join("|")));
}

function uniqueImageAssets(records: ImageAssetEvidence[]) {
  const values = new Map<string, ImageAssetEvidence>();
  for (const record of records) {
    const key = [record.sourceFile, record.relationshipId, record.target].join("|");
    const existing = values.get(key);
    if (!existing) {
      values.set(key, { ...record, sources: [...record.sources] });
      continue;
    }
    const seen = new Set(existing.sources.map(sourceKey));
    for (const source of record.sources) {
      if (!seen.has(sourceKey(source))) existing.sources.push(source);
    }
  }
  return [...values.values()].sort((left, right) =>
    [left.sourceFile, left.relationshipId, left.target].join("|")
      .localeCompare([right.sourceFile, right.relationshipId, right.target].join("|")));
}

function countCards(elements: TemplateElement[]) {
  const shapes = elements.filter((element) => element.type === "shape" && element.w > 100 && element.h > 60);
  const grouped = new Map<string, number>();
  shapes.forEach((shape) => {
    const signature = Math.round(shape.w / 20) + "×" + Math.round(shape.h / 20) + ":" + (shape.fill || "none");
    grouped.set(signature, (grouped.get(signature) || 0) + 1);
  });
  return Math.max(0, ...grouped.values());
}

function inferComposition(
  elements: TemplateElement[],
  textSlots: number,
  visualSlots: number,
  cardCount: number,
): TemplateLayout["composition"] {
  if (!elements.length) return "blank";
  if (cardCount >= 3) return "cards";
  if (elements.filter((element) => element.type === "line").length >= 2) return "timeline";
  if (visualSlots > 0 && textSlots <= 3) return "visual";
  const textElements = elements.filter((element) => element.type === "text" || element.type === "placeholder");
  if (textSlots <= 1) return "title";
  if (textElements.some((element) => element.x < 120) && textElements.some((element) => element.x > 360)) return "split";
  return "text";
}

function extractRecurringElements(layouts: TemplateLayout[]) {
  const occurrences = new Map<string, { count: number; description: string }>();
  layouts.forEach((layout) => layout.elements.forEach((element) => {
    const signature = element.type + ":" + Math.round(element.x / 40) + ":" + Math.round(element.y / 40) + ":" + Math.round(element.w / 40) + ":" + Math.round(element.h / 40) + ":" + (element.fill || "");
    const existing = occurrences.get(signature);
    occurrences.set(signature, {
      count: (existing?.count || 0) + 1,
      description: element.type + " at " + Math.round(element.x) + "," + Math.round(element.y),
    });
  }));
  return [...occurrences.entries()]
    .filter(([, value]) => value.count >= 2)
    .map(([signature, value]) => ({ signature, ...value }))
    .slice(0, 30);
}

function inferVisualPatterns(layouts: TemplateLayout[]) {
  const patterns = new Set<string>();
  if (layouts.some((layout) => layout.cardCount >= 3)) patterns.add("Repeated card grid");
  if (layouts.some((layout) => layout.composition === "split")) patterns.add("Two-column composition");
  if (layouts.some((layout) => layout.composition === "timeline")) patterns.add("Timeline or connected sequence");
  if (layouts.some((layout) => layout.visualSlots > 0)) patterns.add("Dedicated visual area");
  if (layouts.some((layout) => layout.background && layout.background !== "#FFFFFF")) patterns.add("Colored slide backgrounds");
  return [...patterns];
}

function deduplicateLayouts(layouts: TemplateLayout[]) {
  const signatures = new Set<string>();
  return layouts.filter((layout) => {
    const signature = layout.composition + ":" + layout.elements.map((element) =>
      element.type + "-" + Math.round(element.x / 20) + "-" + Math.round(element.y / 20) + "-" + Math.round(element.w / 20),
    ).join("|");
    if (signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  });
}

function emptyLayout(slideSize: { width: number; height: number }): InternalTemplateLayout {
  const id = "fallback-title-slot";
  const source: EvidenceSource = { sourceFile: "generated", elementId: id };
  const placeholder: InternalTemplateElement = {
    id,
    type: "placeholder",
    name: "Title",
    x: 96,
    y: 150,
    w: slideSize.width - 192,
    h: 190,
    text: "",
    zIndex: 1,
    __explicitProperties: new Set(["x", "y", "w", "h"]),
    __availableProperties: new Set(["x", "y", "w", "h"]),
    __propertySources: { x: source, y: source, w: source, h: source },
    __inheritedSources: [],
  };
  return {
    id: "fallback-title",
    name: "Fallback title",
    source: "layout",
    sourceFile: "generated",
    width: slideSize.width,
    height: slideSize.height,
    background: "#FFFFFF",
    elements: [placeholder],
    textSlots: 1,
    placeholderCount: 1,
    visualSlots: 0,
    cardCount: 0,
    composition: "title",
    recurringElementIds: [],
  };
}

async function readXml(zip: JSZip, name: string, warnings: string[], optional = false) {
  const entry = zip.files[name];
  if (!entry) {
    if (!optional) warnings.push("Missing XML part: " + name);
    return undefined;
  }
  const xml = await entry.async("string");
  if (xml.length > MAX_XML_BYTES) {
    warnings.push("Skipped oversized XML part: " + name);
    return undefined;
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsafe XML declaration in PPTX package");
  try {
    return xmlParser.parse(xml) as ParsedXml;
  } catch {
    warnings.push("Could not parse XML part: " + name);
    return undefined;
  }
}

function listPackageFiles(zip: JSZip, matcher: RegExp) {
  return Object.keys(zip.files)
    .filter((name) => matcher.test(name) && !zip.files[name]?.dir)
    .sort((left, right) => numericFileOrder(left) - numericFileOrder(right));
}

function numericFileOrder(value: string) {
  return Number(value.match(/(\d+)(?=\.xml$)/)?.[1] || 0);
}

function findFirst(value: unknown, wantedKey: string): unknown {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findFirst(child, wantedKey);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const [key, child] of Object.entries(record)) {
    if (key === wantedKey) return child;
    const found = findFirst(child, wantedKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function firstString(value: unknown, attribute: string) {
  const record = asRecord(value);
  const candidate = record?.[attribute];
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : undefined;
}

function numberAttribute(value: unknown, attribute: string) {
  const raw = firstString(value, attribute);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasNumericAttribute(value: Record<string, unknown> | undefined, attribute: string) {
  const raw = firstString(value, attribute);
  return raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
}

function hasDirectNoFill(value: unknown) {
  const record = asRecord(value);
  return Boolean(record && Object.keys(record).some((key) => localName(key) === "noFill"));
}

function findDirectShapeFill(value: unknown) {
  const record = asRecord(value);
  if (!record) return undefined;
  const fillNames = new Set(["solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "noFill"]);
  for (const [key, child] of Object.entries(record)) {
    if (fillNames.has(localName(key))) return child;
  }
  return undefined;
}

function normalizeColor(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(normalized) ? "#" + normalized : undefined;
}

function localName(name: string) {
  return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
}

function basename(value: string) {
  return value.split("/").at(-1)?.replace(/\.xml$/i, "") || value;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
