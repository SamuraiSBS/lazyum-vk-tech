import {
  auditReportSchema,
  type AuditIssue,
  type AuditReport,
  type CanvasElement,
  type DesignSystem,
  type PresentationDocument,
  type SlideCanvas,
} from "./schemas";

const TEXT_CHARACTER_WIDTH_FACTOR = 0.62;
const TEXT_LINE_HEIGHT_FACTOR = 1.28;
const MIN_CHARACTERS_PER_LINE = 4;
const LARGE_TEXT_FONT_SIZE = 18 * (96 / 72);
const LARGE_BOLD_TEXT_FONT_SIZE = 14 * (96 / 72);
const PLACEHOLDER_TEXT_PATTERN = /(?<![\p{L}\p{N}_])(?:lorem\s+ipsum|xxx|todo|вставьте\s+текст)(?![\p{L}\p{N}_])/iu;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_HEADER_BYTES = 64 * 1024;
const MATERIAL_ASPECT_DIFFERENCE = 0.1;

export type TextBoxMeasurement = {
  charsPerLine: number;
  lineCount: number;
  lineHeight: number;
  height: number;
  wrappedText: string;
};

/**
 * Deterministic text-box model shared by rendering and audit. It deliberately
 * works in canvas units rather than relying on a browser or Office font engine.
 */
export function measureTextForBox(value: string, fontSize: number, width: number): TextBoxMeasurement {
  const charsPerLine = Math.max(
    MIN_CHARACTERS_PER_LINE,
    Math.floor(width / Math.max(5, fontSize * TEXT_CHARACTER_WIDTH_FACTOR)),
  );
  const lines = value.split("\n").flatMap((line) => wrapTextLine(line, charsPerLine));
  const lineCount = Math.max(1, lines.length);
  const lineHeight = fontSize * TEXT_LINE_HEIGHT_FACTOR;
  return {
    charsPerLine,
    lineCount,
    lineHeight,
    height: lineCount * lineHeight,
    wrappedText: lines.join("\n"),
  };
}

export function auditPresentation(document: PresentationDocument): AuditReport {
  const firstSlideByContent = new Map<string, string>();
  const slides = document.slides.map((slide) => ({
    slideId: slide.id,
    issues: (() => {
      const issues = auditCanvas(slide.canvas, document.designSystem);
      const signature = substantiveSlideSignature(slide.title, slide.canvas);
      if (signature) {
        const firstSlideId = firstSlideByContent.get(signature);
        if (firstSlideId) {
          issues.push(issue("DUPLICATE_SLIDE", "warning", undefined, `Substantive content matches ${firstSlideId}`));
        } else {
          firstSlideByContent.set(signature, slide.id);
        }
      }
      return issues;
    })(),
  }));
  return auditReportSchema.parse({
    slides,
    passed: slides.every((slide) => !slide.issues.some((issue) => issue.severity === "error")),
  });
}

function substantiveSlideSignature(title: string, canvas: SlideCanvas): string | undefined {
  const normalizedTitle = normalizeSlideText(title);
  const body = canvas.elements
    .filter((element): element is Extract<CanvasElement, { type: "text" }> => element.type === "text")
    .filter((element) => !isFooter(element, canvas))
    .map((element) => normalizeSlideText(element.text))
    .filter((text) => text && text !== normalizedTitle)
    .sort();
  return normalizedTitle && body.length ? JSON.stringify([normalizedTitle, body]) : undefined;
}

function normalizeSlideText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

export function auditCanvas(canvas: SlideCanvas, designSystem: DesignSystem): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const ids = new Set<string>();
  const supportedFonts = new Set([
    ...designSystem.typography.headingFonts,
    ...designSystem.typography.bodyFonts,
    "Arial",
    "Calibri",
    "Aptos",
  ].map((font) => font.toLocaleLowerCase()));
  const allowedColors = new Set([...designSystem.colors, canvas.background].map((color) => color.toUpperCase()));
  const margin = Math.min(canvas.width, canvas.height) * 0.035;
  canvas.elements.forEach((element) => {
    if (ids.has(element.id)) {
      issues.push(issue("ELEMENT_OVERLAP", "error", element.id, "Two canvas elements share the same id"));
    }
    ids.add(element.id);
    if (element.x < 0 || element.y < 0 || element.x + element.w > canvas.width || element.y + element.h > canvas.height) {
      issues.push(issue("OUTSIDE_SLIDE", "error", element.id, "Element extends outside the slide"));
    }
    if (element.type === "text") {
      if (!element.text.trim()) issues.push(issue("EMPTY_PLACEHOLDER", "error", element.id, "Text placeholder is empty"));
      else if (PLACEHOLDER_TEXT_PATTERN.test(element.text)) {
        issues.push(issue("EMPTY_PLACEHOLDER", "error", element.id, "Text contains placeholder content"));
      }
      if (element.fontSize < 14) issues.push(issue("SMALL_TEXT", "warning", element.id, "Text is smaller than 14 px"));
      if (!supportedFonts.has(element.fontFamily.toLocaleLowerCase())) {
        issues.push(issue("UNSUPPORTED_FONT", "warning", element.id, "Font is not declared by the template design system"));
      }
      if (!allowedColors.has(element.color.toUpperCase())) {
        issues.push(issue("COLOR_OUTSIDE_DESIGN_SYSTEM", "warning", element.id, "Text color is outside the extracted design system"));
      }
      if (measureTextForBox(element.text, element.fontSize, element.w).height > element.h) {
        issues.push(issue("TEXT_OVERFLOW", "error", element.id, "Text exceeds element bounds"));
      }
      if (element.text.trim()) {
        const background = findUnambiguousTextBackground(element, canvas);
        const textLuminance = relativeLuminance(element.color);
        const backgroundLuminance = background ? relativeLuminance(background) : undefined;
        if (textLuminance !== undefined && backgroundLuminance !== undefined) {
          const contrastRatio = (Math.max(textLuminance, backgroundLuminance) + 0.05)
            / (Math.min(textLuminance, backgroundLuminance) + 0.05);
          const isLargeText = element.fontSize >= LARGE_TEXT_FONT_SIZE
            || (element.fontWeight >= 700 && element.fontSize >= LARGE_BOLD_TEXT_FONT_SIZE);
          const requiredRatio = isLargeText ? 3 : 4.5;
          if (contrastRatio < requiredRatio) {
            issues.push(issue(
              "LOW_TEXT_CONTRAST",
              "warning",
              element.id,
              `Text contrast is ${contrastRatio.toFixed(2)}:1; WCAG 2.2 AA requires at least ${requiredRatio}:1`,
            ));
          }
        }
      }
      if (!isFooter(element, canvas) && (
        element.x < margin || element.y < margin || element.x + element.w > canvas.width - margin || element.y + element.h > canvas.height - margin
      )) {
        issues.push(issue("SMALL_MARGIN", "warning", element.id, "Text is too close to the slide edge"));
      }
    }
    if (element.type === "shape" && !allowedColors.has(element.fill.toUpperCase()) && !allowedColors.has(element.stroke.toUpperCase())) {
      issues.push(issue("COLOR_OUTSIDE_DESIGN_SYSTEM", "info", element.id, "Shape uses a color outside the extracted palette"));
    }
    if (element.type === "image") {
      const image = inspectEmbeddedImage(element.dataUrl);
      if (!image.valid) {
        issues.push(issue("INVALID_IMAGE_DATA", "error", element.id, "Image has missing or malformed embedded data"));
      } else if (image.dimensions) {
        const visibleWidth = image.dimensions.width * (100 - (element.crop?.left ?? 0) - (element.crop?.right ?? 0)) / 100;
        const visibleHeight = image.dimensions.height * (100 - (element.crop?.top ?? 0) - (element.crop?.bottom ?? 0)) / 100;
        const imageRatio = visibleWidth / visibleHeight;
        const frameRatio = element.w / element.h;
        const ratioDifference = Math.abs(Math.log(frameRatio / imageRatio));
        if (Number.isFinite(ratioDifference) && ratioDifference > Math.log(1 + MATERIAL_ASPECT_DIFFERENCE)) {
          issues.push(issue("IMAGE_ASPECT_DISTORTION", "warning", element.id, "Image frame materially changes the intrinsic aspect ratio"));
        }
      }
    }
  });
  const foreground = canvas.elements.filter((element) => element.type !== "shape" || element.shape !== "line");
  foreground.forEach((element, index) => foreground.slice(index + 1).forEach((other) => {
    if (overlaps(element, other) && !allowedOverlap(element, other)) {
      issues.push(issue(
        "ELEMENT_OVERLAP",
        element.type === "text" && other.type === "text" ? "error" : "warning",
        element.id,
        "Element overlaps " + other.id,
      ));
    }
  }));
  if (canvas.elements.length > 70) {
    issues.push(issue("DENSE_LAYOUT", "warning", undefined, "Slide has more than 70 editable objects"));
  }
  return issues;
}

type ImageInspection = { valid: boolean; dimensions?: { width: number; height: number } };

/** Inspect only embedded, bounded image bytes; never fetch a URL or invoke a decoder. */
function inspectEmbeddedImage(dataUrl: string | undefined): ImageInspection {
  if (!dataUrl) return { valid: false };
  const match = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(dataUrl);
  if (!match) return { valid: false };
  const payload = match[2];
  if (payload.length % 4 !== 0 || payload.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return { valid: false };
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== payload) return { valid: false };
  const mime = match[1].toLowerCase();
  if (mime === "png") {
    return inspectPng(bytes);
  }
  if (mime === "gif") {
    if (bytes.length < 14 || !/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)) || bytes[bytes.length - 1] !== 0x3b) return { valid: false };
    return withDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  }
  if (mime === "jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return { valid: false };
    const dimensions = jpegDimensions(bytes);
    return dimensions ? { valid: true, dimensions } : { valid: false };
  }
  if (mime === "webp") {
    if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP"
      || bytes.readUInt32LE(4) + 8 !== bytes.length) return { valid: false };
    return { valid: true, dimensions: webpDimensions(bytes) };
  }
  const xml = bytes.toString("utf8");
  return { valid: /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/iu.test(xml) && /<\/svg>\s*$/iu.test(xml) };
}

function inspectPng(bytes: Buffer): ImageInspection {
  if (bytes.length < 57 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return { valid: false };
  let offset = 8;
  let dimensions: ImageInspection | undefined;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return { valid: false };
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return { valid: false };
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end - 4; index += 1) {
      crc ^= bytes[index];
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) return { valid: false };
    if (!dimensions) {
      if (type !== "IHDR" || length !== 13 || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0) return { valid: false };
      dimensions = withDimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
      if (!dimensions.valid) return dimensions;
    } else if (type === "IHDR") return { valid: false };
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") return length === 0 && hasImageData && end === bytes.length ? dimensions : { valid: false };
    offset = end;
  }
  return { valid: false };
}

function withDimensions(width: number, height: number): ImageInspection {
  return width > 0 && height > 0 ? { valid: true, dimensions: { width, height } } : { valid: false };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  let dimensions: { width: number; height: number } | undefined;
  let hasScan = false;
  while (offset + 4 <= bytes.length && offset < MAX_IMAGE_HEADER_BYTES) {
    if (bytes[offset] !== 0xff) break;
    let marker = bytes[++offset];
    while (marker === 0xff && offset + 1 < bytes.length) marker = bytes[++offset];
    offset += 1;
    if (marker === 0xda) {
      hasScan = true;
      break;
    }
    if (marker === 0xd9) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
      && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return undefined;
      dimensions = { width, height };
    }
    offset += length;
  }
  return hasScan ? dimensions : undefined;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const format = bytes.toString("ascii", 12, 16);
  if (format === "VP8X" && bytes.length >= 30) {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (format === "VP8 " && bytes.length >= 30 && bytes.toString("hex", 23, 26) === "9d012a") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
      height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)),
    };
  }
  return undefined;
}

function findUnambiguousTextBackground(
  text: Extract<CanvasElement, { type: "text" }>,
  canvas: SlideCanvas,
): string | undefined {
  const overlappingLayers = canvas.elements.filter((element) => element !== text
    && element.type !== "text"
    && overlaps(text, element));
  const containingShapes = overlappingLayers.filter((element): element is Extract<CanvasElement, { type: "shape" }> =>
    element.type === "shape"
      && element.zIndex < text.zIndex
      && shapeContainsTextBounds(element, text)
      && relativeLuminance(element.fill) !== undefined,
  );
  const topmostContainingShape = containingShapes.sort((left, right) => right.zIndex - left.zIndex)[0];

  if (topmostContainingShape) {
    const hasAmbiguousLayerAbove = overlappingLayers.some((element) => element !== topmostContainingShape
      && element.zIndex >= topmostContainingShape.zIndex);
    return hasAmbiguousLayerAbove ? undefined : topmostContainingShape.fill;
  }

  return overlappingLayers.length === 0 ? canvas.background : undefined;
}

function shapeContainsTextBounds(
  shape: Extract<CanvasElement, { type: "shape" }>,
  text: Extract<CanvasElement, { type: "text" }>,
) {
  if (shape.shape === "line") return false;
  const corners = [
    { x: text.x, y: text.y },
    { x: text.x + text.w, y: text.y },
    { x: text.x, y: text.y + text.h },
    { x: text.x + text.w, y: text.y + text.h },
  ];

  if (shape.shape === "rect") {
    return corners.every((point) => point.x >= shape.x && point.x <= shape.x + shape.w
      && point.y >= shape.y && point.y <= shape.y + shape.h);
  }

  if (shape.shape === "ellipse") {
    const centerX = shape.x + shape.w / 2;
    const centerY = shape.y + shape.h / 2;
    const radiusX = shape.w / 2;
    const radiusY = shape.h / 2;
    return corners.every((point) => ((point.x - centerX) / radiusX) ** 2
      + ((point.y - centerY) / radiusY) ** 2 <= 1);
  }

  const radius = Math.min(shape.radius, shape.w / 2, shape.h / 2);
  if (radius === 0) {
    return corners.every((point) => point.x >= shape.x && point.x <= shape.x + shape.w
      && point.y >= shape.y && point.y <= shape.y + shape.h);
  }
  return corners.every((point) => {
    const nearestX = Math.max(shape.x + radius, Math.min(point.x, shape.x + shape.w - radius));
    const nearestY = Math.max(shape.y + radius, Math.min(point.y, shape.y + shape.h - radius));
    return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2 <= radius ** 2;
  });
}

function relativeLuminance(color: string): number | undefined {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function issue(type: AuditIssue["type"], severity: AuditIssue["severity"], elementId: string | undefined, message: string): AuditIssue {
  return { type, severity, elementId, message };
}

function overlaps(left: CanvasElement, right: CanvasElement) {
  return left.x < right.x + right.w && left.x + left.w > right.x
    && left.y < right.y + right.h && left.y + left.h > right.y;
}

function allowedOverlap(left: CanvasElement, right: CanvasElement) {
  if (left.type === "shape" && right.type === "text" && contains(left, right)) return true;
  if (right.type === "shape" && left.type === "text" && contains(right, left)) return true;
  if (left.type === "shape" && right.type === "shape") return true;
  return false;
}

function contains(outer: CanvasElement, inner: CanvasElement) {
  return inner.x >= outer.x - 2 && inner.y >= outer.y - 2
    && inner.x + inner.w <= outer.x + outer.w + 2 && inner.y + inner.h <= outer.y + outer.h + 2;
}

function wrapTextLine(value: string, charsPerLine: number) {
  if (!value) return [""];
  const words = value.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  words.forEach((originalWord) => {
    let word = originalWord;
    if (current && current.length + 1 + word.length > charsPerLine) {
      lines.push(current);
      current = "";
    }
    while (word.length > charsPerLine) {
      lines.push(word.slice(0, charsPerLine));
      word = word.slice(charsPerLine);
    }
    if (!word) return;
    const candidate = current ? current + " " + word : word;
    if (current && candidate.length > charsPerLine) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  });
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function isFooter(element: Extract<CanvasElement, { type: "text" }>, canvas: SlideCanvas) {
  const footerBandHeight = canvas.height * 0.1;
  return element.y >= canvas.height - footerBandHeight && element.h <= footerBandHeight;
}
