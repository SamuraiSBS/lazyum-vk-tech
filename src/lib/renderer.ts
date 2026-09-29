import {
  presentationDocumentSchema,
  type CanvasElement,
  type DesignSystem,
  type LayoutVariant,
  type PresentationDocument,
  type PresentationPlan,
  type TemplateElement,
  type TemplateLayout,
} from "./schemas";
import { measureTextForBox } from "./audit";
import {
  materializeFactBackedTable,
  materializeFactBackedChart,
  materializeFactBackedDiagram,
  DataVisualRendererError,
  type DataVisualBarChartStyle,
  type DataVisualChartLayoutSlot,
  type DataVisualTableLayoutSlot,
  type DataVisualTableStyle,
  type FactBackedDiagramSpec,
  type FactBackedTableSpec,
  type FactBackedChartSpec,
} from "./data-visual-renderer";
import { chooseTemplateLayout, splitSingleCardStatement } from "./layout-engine";

const MAX_TEMPLATE_IMAGES = 48;
const DETERMINISTIC_FONT_FALLBACK = "Arial";
const ARTWORK_MIN_AREA_RATIO = 0.001;
const ARTWORK_IMAGE_MIN_AREA_RATIO = 0.0005;
const ARTWORK_BACKGROUND_AREA_RATIO = 0.82;
const TEXT_ARTWORK_CLEARANCE = 0.05;
const TEXT_CANVAS_EDGE_INSET_PX = 6;

type Rect = Pick<TemplateElement, "x" | "y" | "w" | "h">;
type TextAssignment = { slot: TemplateElement; value: string; index: number };

export type TextFontRole = "heading" | "body";

export type DataVisualTableRenderInput = {
  spec: FactBackedTableSpec;
  slot: DataVisualTableLayoutSlot;
  style?: Partial<DataVisualTableStyle>;
};

export type DataVisualChartRenderInput = {
  spec: FactBackedChartSpec;
  slot: DataVisualChartLayoutSlot;
  style?: Partial<DataVisualBarChartStyle>;
};

export type DataVisualDiagramRenderInput = {
  spec: FactBackedDiagramSpec;
  slot: DataVisualChartLayoutSlot;
};

export type DataVisualRenderInput =
  | DataVisualTableRenderInput
  | DataVisualChartRenderInput
  | DataVisualDiagramRenderInput;

export type RenderPresentationOptions = {
  layoutOverrides?: ReadonlyMap<string, string>;
  variantGeometry?: boolean;
};

/**
 * Resolve text typography from the most local template evidence available.
 * The deterministic fallback is used only when neither a slot nor the
 * corresponding DesignSystem font list provides evidence.
 */
export function resolveTextFont(
  role: TextFontRole,
  designSystem: { typography: Pick<DesignSystem["typography"], "headingFonts" | "bodyFonts"> },
  observedFontFamily?: string,
) {
  const observed = observedFontFamily?.trim();
  if (observed) return observed;
  const configuredFonts = role === "heading"
    ? designSystem.typography.headingFonts
    : designSystem.typography.bodyFonts;
  const configured = configuredFonts.map((font) => font.trim()).find(Boolean);
  return configured || DETERMINISTIC_FONT_FALLBACK;
}

export function renderPresentation(
  designSystem: DesignSystem,
  plan: PresentationPlan,
  variant: LayoutVariant = "balanced",
  dataVisuals: readonly DataVisualRenderInput[] = [],
  options: RenderPresentationOptions = {},
): PresentationDocument {
  const slideIds = new Set(plan.slides.map((slide) => slide.id));
  dataVisuals.forEach(({ spec }) => {
    if (!slideIds.has(spec.slideId)) {
      throw new Error("Data visual spec references an unknown slide");
    }
  });
  const layoutUseCounts = new Map<string, number>();
  const slides = plan.slides.map((slide, index) => {
    const layout = chooseTemplateLayout(
      designSystem,
      slide,
      variant,
      options.layoutOverrides?.get(slide.id),
      { slideIndex: index, slideCount: plan.slides.length, layoutUseCounts },
    );
    layoutUseCounts.set(layout.id, (layoutUseCounts.get(layout.id) || 0) + 1);
    return {
      id: slide.id,
      order: index + 1,
      purpose: slide.purpose,
      title: slide.title,
      templateLayoutId: layout.id,
      canvas: renderSlide(
        layout,
        slide,
        designSystem,
        dataVisuals.filter(({ spec }) => spec.slideId === slide.id),
        options.variantGeometry ? variant : undefined,
      ),
    };
  });
  return presentationDocumentSchema.parse({
    version: 1,
    title: plan.title,
    designSystem,
    plan,
    slides,
  });
}

function renderSlide(
  layout: TemplateLayout,
  slide: PresentationPlan["slides"][number],
  designSystem: DesignSystem,
  dataVisuals: readonly DataVisualRenderInput[] = [],
  geometryVariant?: LayoutVariant,
) {
  const palette = designSystem.colors;
  const background = layout.background || palette[0] || "#FFFFFF";
  const usesTimelineFallback = slide.visualIntent === "timeline" && layout.composition !== "timeline";
  const markerRows = excessMarkerRows(layout, slide.content.length);
  const isEnding = slide.purpose === "summary" || slide.purpose === "next_steps";
  const artwork = templateArtworkObstacles(layout, { includeFilledTextDecorations: true });
  const sourceSlotArtwork = templateArtworkObstacles(layout, {
    ignoreLines: true,
    includeFilledTextDecorations: true,
  });
  const markerArtwork = markerRows.flatMap((row) => [...row.images, ...(row.background ? [row.background] : [])]);
  const placementArtwork = isEnding && markerRows.length
    ? artwork.filter((rect) => !markerArtwork.some((marker) => sameRect(rect, marker)))
    : artwork;
  const placementSourceArtwork = isEnding && markerRows.length
    ? sourceSlotArtwork.filter((rect) => !markerArtwork.some((marker) => sameRect(rect, marker)))
    : sourceSlotArtwork;
  const fullBleedRaster = fullBleedRasterBackground(layout);
  const elements: CanvasElement[] = [];
  // PowerPoint often stores filled cards and panels as empty text boxes. The
  // parser keeps their original type, so retain their drawing surface even
  // though they are not content slots.
  const decorative = layout.elements.filter((element) => !element.text.trim()
    && (["shape", "line"].includes(element.type)
      || ((element.type === "text" || element.type === "placeholder") && Boolean(element.fill || element.stroke))));
  decorative.forEach((element) => {
    const clipped = clipTemplateElementToCanvas(element, layout.width, layout.height);
    if (clipped) elements.push(shapeFromTemplate(clipped, background, palette));
  });
  layout.elements
    .filter((element) => element.type === "image" && element.imageDataUrl)
    .filter((element) => isContainedInCanvas(element, layout.width, layout.height))
    .sort((left, right) => right.w * right.h - left.w * left.h || left.zIndex - right.zIndex)
    .filter((element, index, all) => all.findIndex((candidate) => sameImagePlacement(candidate, element)) === index)
    .slice(0, MAX_TEMPLATE_IMAGES)
    .forEach((element) => {
      elements.push({
        id: "template-image-" + element.id,
        type: "image",
        x: element.x,
        y: element.y,
        w: element.w,
        h: element.h,
        alt: element.name || "Template image",
        dataUrl: element.imageDataUrl,
        ...(element.crop ? { crop: element.crop } : {}),
        ...(element.rotation ? { rotation: element.rotation } : {}),
        zIndex: element.zIndex,
        locked: false,
        sourceTemplateElementId: element.id,
      });
    });

  const slots = layout.elements
    .filter((element) => (element.type === "text" || element.type === "placeholder") && isUsableTextSlot(element, layout))
    .map((element) => adjustVariantTextSlot(element, layout, slide.purpose, geometryVariant))
    .sort((left, right) =>
      (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x,
    );
  const reserveCards = slide.visualIntent === "cards" && layout.cardCount < 3
    && (layout.cardCount > 0 || slots.length < 4);
  const fallbackBottom = reserveCards ? layout.height * 0.62 : layout.height * 0.92;
  const initialFallback = fallbackSlots(layout, undefined, fallbackBottom).map((element) => adjustVariantTextSlot(element, layout, slide.purpose, geometryVariant));
  const titleSlot = slots[0] || initialFallback[0];
  const fallback = fallbackSlots(layout, titleSlot, fallbackBottom).map((element) => adjustVariantTextSlot(element, layout, slide.purpose, geometryVariant));
  const remainingSlots = slots.filter((slot) => slot.id !== titleSlot.id && !overlapsElement(slot, titleSlot))
    .sort((left, right) => right.w * right.h - left.w * left.h);
  const cardWidthLimit = Math.min(layout.width * 0.48, layout.width / Math.max(1, layout.cardCount) * 1.7);
  const cardContentSlots = remainingSlots
    .filter((slot) => slot.h >= layout.height * 0.09
      && slot.y >= titleSlot.y + titleSlot.h
      && slot.w <= cardWidthLimit)
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .filter((slot, index, candidates) => !candidates.slice(0, index).some((previous) => overlapsElement(slot, previous)));
  const cardItems = splitSingleCardStatement(slide.content, layout.cardCount);
  const requiredCardSlots = cardItems.length;
  const packedCardContent = packCardContent(cardItems, Math.max(1, requiredCardSlots));
  const preflightCardAssignments = layout.cardCount >= 2
    && cardItems.length >= 2
    && cardItems.length <= layout.cardCount
    && cardContentSlots.length >= requiredCardSlots
    ? materializeTextAssignments(
      packedCardContent.map((value, index) => ({ slot: cardContentSlots[index]!, value, index: index + 1 })),
      layout,
      artwork,
      false,
      true,
      sourceSlotArtwork,
    )
    : [];
  const distributesAcrossCards = layout.cardCount >= 2
    && cardItems.length >= 2
    && cardItems.length <= layout.cardCount
    && cardContentSlots.length >= requiredCardSlots
    && preflightCardAssignments.every(({ slot, value, index }, assignmentIndex) => (
      textFitsSlot(value, slot, index, layout)
      && !preflightCardAssignments.slice(0, assignmentIndex).some((previous) => overlapsElement(slot, previous.slot))
    ));
  const minimumBodyWidth = geometryVariant === "visual" ? layout.width * 0.16 : layout.width * 0.2;
  const bodyCandidates = remainingSlots.filter((slot) => (
    slot.h >= layout.height * 0.1
    && slot.w >= minimumBodyWidth
    && (!reserveCards || slot.y + slot.h <= fallbackBottom)
      && (slot.y >= titleSlot.y + titleSlot.h || slot.x >= titleSlot.x + titleSlot.w)
      && (distributesAcrossCards || textFitsSlot(formatContent(slide.content), slot, 1, layout))
  ));
  const titleSeparatedBodyCandidates = bodyCandidates;
  const rasterBodyFallback = fullBleedRaster
    ? rasterContentFallbackSlot(remainingSlots, titleSlot, layout)
    : undefined;
  const useRasterBodyFallback = Boolean(rasterBodyFallback && !distributesAcrossCards && bodyCandidates.length === 0);
  const splitDiagramSlots = slide.visualIntent === "diagram" && layout.composition === "split"
    ? remainingSlots.filter((slot) => slot.h >= layout.height * 0.18
      && slot.w >= layout.width * 0.3
      && (slot.y >= titleSlot.y + titleSlot.h || slot.x >= titleSlot.x + titleSlot.w))
      .sort((left, right) => left.x - right.x)
    : [];
  const usesSplitDiagram = splitDiagramSlots.length >= 2
    && splitDiagramSlots.at(-1)!.x - splitDiagramSlots[0]!.x >= layout.width * 0.3
    && slide.content.length >= 2;
  const contentSlots = usesSplitDiagram
    ? [splitDiagramSlots[0]!, splitDiagramSlots.at(-1)!]
    : distributesAcrossCards && cardContentSlots.length
    ? cardContentSlots
    : titleSeparatedBodyCandidates.length
      ? titleSeparatedBodyCandidates
      : [rasterBodyFallback || fallback[1]];
  if (isEnding && markerRows.length && contentSlots[0] && contentSlots[0].w < layout.width * 0.45) {
    contentSlots[0] = {
      ...fallback[1],
      x: layout.width * 0.24,
      y: Math.max(layout.height * 0.4, titleSlot.y + titleSlot.h + layout.height * 0.05),
      w: layout.width * 0.54,
      h: layout.height * 0.32,
    };
  }
  const usesCardFallback = slide.visualIntent === "cards" && slide.content.length >= 2 && layout.cardCount < 3
    && slots.length < 4 && !distributesAcrossCards;
  const contentValues = usesCardFallback
    ? []
    : usesSplitDiagram
    ? [formatContent(slide.content.slice(0, Math.ceil(slide.content.length / 2))),
      formatContent(slide.content.slice(Math.ceil(slide.content.length / 2)))]
    : distributesAcrossCards
    ? packCardContent(cardItems, Math.max(1, contentSlots.length))
    : [formatContent(slide.content)];
  const coverColumn = slide.purpose === "title" ? coverTextColumn(layout, titleSlot) : undefined;
  const assignments = [
    { slot: coverColumn?.title || titleSlot, value: slide.title, index: 0 },
    ...(usesTimelineFallback ? [] : contentValues.map((value, index) => ({
      slot: (index === 0 ? coverColumn?.body : undefined) || contentSlots[index] || fallback[index + 1],
      value,
      index: index + 1,
    }))),
  ];
  const positionedAssignments = materializeTextAssignments(
    assignments,
    layout,
    placementArtwork,
    useRasterBodyFallback,
    distributesAcrossCards,
    placementSourceArtwork,
  );
  positionedAssignments.forEach(({ slot, value, index }) => {
    if (!slot || !value) return;
    const preferredFontSize = slot.fontSize || fontSizeFor(index, layout);
    const fontSize = fitTextFontSize(value, preferredFontSize, slot.w, slot.h);
    const sourceTextSurface = templateTextSurfaceFill(slot, layout, palette);
    const contrastPanelFill = fullBleedRaster && !sourceTextSurface
      // A raster has unknown pixels: the canvas color is not its visible surface.
      // Give the text a known opaque backing before choosing its foreground.
      ? "#FFFFFF"
      : !fullBleedRaster && overlapsArtwork(slot, artwork) ? background : undefined;
    const textSurface = contrastPanelFill || sourceTextSurface || background;
    const overlappingArtworkZIndex = contrastPanelFill
      ? layout.elements
        .filter((element) => overlapsElement(slot, element))
        .reduce((maximum, element) => Math.max(maximum, element.zIndex), -1)
      : -1;
    const textZIndex = contrastPanelFill
      ? Math.max(50 + index, overlappingArtworkZIndex + 2)
      : 50 + index;
    if (contrastPanelFill) {
      elements.push({
        id: slide.id + "-text-" + index + "-contrast-panel",
        type: "shape",
        x: slot.x,
        y: slot.y,
        w: slot.w,
        h: slot.h,
        shape: "roundRect",
        fill: contrastPanelFill,
        stroke: contrastPanelFill,
        strokeWidth: 0,
        radius: 8,
        zIndex: textZIndex - 1,
        locked: false,
      });
    }
    elements.push({
      id: slide.id + "-text-" + index,
      type: "text",
      x: slot.x,
      y: slot.y,
      w: slot.w,
      h: slot.h,
      text: wrapTextForBox(value, fontSize, slot.w),
      fontFamily: resolveTextFont(textFontRole(index), designSystem, slot.fontFamily),
      fontSize,
      fontWeight: slot.fontWeight || (index === 0 ? 700 : 400),
      color: readableTextColor(textSurface, palette),
      align: templateTextAlignment(slot, layout, index),
      zIndex: textZIndex,
      locked: false,
      sourceTemplateElementId: slot.id,
    });
  });

  if (usesTimelineFallback) {
    const positionedTitleSlot = positionedAssignments.find((assignment) => assignment.index === 0)?.slot || titleSlot;
    elements.push(...fallbackTimeline(
      slide.id,
      packCardContent(slide.content, 4),
      layout,
      palette,
      designSystem,
      background,
      positionedTitleSlot,
      artwork,
    ));
  }
  if (usesCardFallback) {
    elements.push(...fallbackCards(slide.id, slide.content, layout, background, palette, designSystem, artwork));
  }
  dataVisuals.forEach((input) => {
    if (input.spec.visualType === "table") {
      const tableInput = input as DataVisualTableRenderInput;
      elements.push(materializeFactBackedTable(tableInput.spec, tableInput.slot, tableInput.style));
      return;
    }
    if (input.spec.visualType === "chart") {
      const chartInput = input as DataVisualChartRenderInput;
      elements.push(...materializeFactBackedChart(chartInput.spec, chartInput.slot, chartInput.style));
      return;
    }
    if (input.spec.visualType === "diagram") {
      const diagramInput = input as DataVisualDiagramRenderInput;
      elements.push(...materializeFactBackedDiagram(diagramInput.spec, diagramInput.slot));
      return;
    }
    throw new DataVisualRendererError("unsupported_visual_type");
  });

  // Metric templates can provide more repeated rows than the plan has values.
  // Remove only decoration contained in an unused peer row; otherwise an
  // orphaned icon/tile remains visible with no corresponding metric.
  const populatedSourceSlots = positionedAssignments
    .filter(({ value, index }) => index > 0 && Boolean(value))
    .map(({ slot }) => layout.elements.find((element) => element.id === slot.id))
    .filter((slot): slot is TemplateElement => Boolean(slot));
  const unusedMetricRows = slide.visualIntent === "metrics" && populatedSourceSlots.length >= 2
    ? layout.elements.filter((slot) => (slot.type === "text" || slot.type === "placeholder")
      && !populatedSourceSlots.some((used) => used.id === slot.id)
      && populatedSourceSlots.some((used) => Math.abs(used.x - slot.x) < 1
        && Math.abs(used.w - slot.w) < 1 && Math.abs(used.h - slot.h) < 1))
    : [];
  const unusedMarkerIds = new Set<string>();
  if (markerRows.length) {
    for (const row of markerRows) {
      const populated = !usesTimelineFallback && !isEnding && positionedAssignments.some(({ slot, index }) =>
        index > 0 && slot.x >= row.anchor.x + row.anchor.w - 5
          && slot.x - row.anchor.x - row.anchor.w <= layout.width * 0.08
          && slot.y < row.anchor.y + row.anchor.h
          && slot.y + slot.h > row.anchor.y);
      if (!populated) {
        row.images.forEach((image) => unusedMarkerIds.add(image.id));
        if (row.background) unusedMarkerIds.add(row.background.id);
      }
    }
  }
  const visibleElements = elements.filter((element) => element.type === "text" || !element.sourceTemplateElementId
    || (!unusedMarkerIds.has(element.sourceTemplateElementId)
      && !unusedMetricRows.some((row) => containsRect(row, element))));

  return {
    width: layout.width,
    height: layout.height,
    background,
    elements: visibleElements.sort((left, right) => left.zIndex - right.zIndex),
  };
}

function shapeFromTemplate(element: TemplateElement, background: string, palette: string[]): CanvasElement {
  const fill = element.fill || (element.type === "line" ? background : palette[1] || "#FFFFFF");
  const stroke = element.stroke || fill;
  return {
    id: "template-" + element.id,
    type: "shape",
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    shape: element.type === "line" ? "line" : element.radius ? "roundRect" : "rect",
    fill,
    stroke,
    strokeWidth: element.type === "line" ? 2 : 0,
    radius: element.radius || 0,
    zIndex: element.zIndex,
    locked: false,
    sourceTemplateElementId: element.id,
  };
}

function clipTemplateElementToCanvas(element: TemplateElement, width: number, height: number): TemplateElement | undefined {
  if (element.type === "line") {
    const clipped = clipLineToCanvas(element, width, height);
    return clipped ? { ...element, ...clipped } : undefined;
  }
  const left = Math.max(0, element.x);
  const top = Math.max(0, element.y);
  const right = Math.min(width, element.x + element.w);
  const bottom = Math.min(height, element.y + element.h);
  if (right <= left || bottom <= top) return undefined;
  return { ...element, x: left, y: top, w: right - left, h: bottom - top };
}

function clipLineToCanvas(element: TemplateElement, width: number, height: number) {
  const dx = element.w;
  const dy = element.h;
  let start = 0;
  let end = 1;
  const tests: Array<[number, number]> = [
    [-dx, element.x],
    [dx, width - element.x],
    [-dy, element.y],
    [dy, height - element.y],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const ratio = q / p;
    if (p < 0) start = Math.max(start, ratio);
    else end = Math.min(end, ratio);
    if (start > end) return undefined;
  }
  if (end - start <= 0) return undefined;
  return {
    x: element.x + start * dx,
    y: element.y + start * dy,
    w: (end - start) * dx,
    h: (end - start) * dy,
  };
}

function intersectsCanvas(element: Pick<TemplateElement, "x" | "y" | "w" | "h">, width: number, height: number) {
  return element.x < width && element.y < height && element.x + element.w > 0 && element.y + element.h > 0;
}

function isContainedInCanvas(element: Pick<TemplateElement, "x" | "y" | "w" | "h">, width: number, height: number) {
  return element.x >= 0 && element.y >= 0 && element.x + element.w <= width && element.y + element.h <= height;
}

function overlapsElement(left: Pick<TemplateElement, "x" | "y" | "w" | "h">, right: Pick<TemplateElement, "x" | "y" | "w" | "h">) {
  return left.x < right.x + right.w && left.x + left.w > right.x
    && left.y < right.y + right.h && left.y + left.h > right.y;
}

function templateArtworkObstacles(
  layout: TemplateLayout,
  options: { ignoreLines?: boolean; includeFilledTextDecorations?: boolean } = {},
): Rect[] {
  const canvasArea = layout.width * layout.height;
  return layout.elements.flatMap((element) => {
    if (element.type === "image") {
      const relativeArea = (element.w * element.h) / canvasArea;
      return element.imageDataUrl
        && relativeArea < ARTWORK_BACKGROUND_AREA_RATIO
        && relativeArea >= ARTWORK_IMAGE_MIN_AREA_RATIO
        && isContainedInCanvas(element, layout.width, layout.height)
        ? [{ x: element.x, y: element.y, w: element.w, h: element.h }]
        : [];
    }
    const filledTextDecoration = options.includeFilledTextDecorations
      && (element.type === "text" || element.type === "placeholder")
      && !element.text.trim()
      && Boolean(element.fill || element.stroke);
    if ((element.type !== "shape" && element.type !== "line" && !filledTextDecoration)
      || (options.ignoreLines && element.type === "line")
      || element.text.trim()
      || isTextSlotBackground(element, layout)) return [];
    const clipped = clipTemplateElementToCanvas(element, layout.width, layout.height);
    if (!clipped) return [];
    const relativeArea = (clipped.w * clipped.h) / canvasArea;
    return relativeArea >= ARTWORK_MIN_AREA_RATIO && relativeArea < ARTWORK_BACKGROUND_AREA_RATIO
      ? [{ x: clipped.x, y: clipped.y, w: clipped.w, h: clipped.h }]
      : [];
  });
}

function coverTextColumn(layout: TemplateLayout, sourceTitle: TemplateElement) {
  const partialArt = layout.elements.filter((element) => element.type === "image"
    && Boolean(element.imageDataUrl)
    && isContainedInCanvas(element, layout.width, layout.height)
    && element.w * element.h >= layout.width * layout.height * 0.08
    && element.w * element.h < layout.width * layout.height * ARTWORK_BACKGROUND_AREA_RATIO
    && element.x > layout.width * 0.3);
  if (!partialArt.length || sourceTitle.x >= layout.width * 0.3) return undefined;
  const artLeft = Math.min(...partialArt.map((element) => element.x));
  const width = Math.min(sourceTitle.w, artLeft - sourceTitle.x - layout.width * 0.025);
  if (width < layout.width * 0.25) return undefined;
  const title = { ...sourceTitle, w: width, h: Math.max(sourceTitle.h, layout.height * 0.19) };
  const bodyY = Math.max(title.y + title.h + layout.height * 0.025, layout.height * 0.45);
  const body: TemplateElement = {
    ...sourceTitle,
    id: "cover-body-column",
    x: title.x,
    y: bodyY,
    w: width,
    h: Math.min(layout.height * 0.2, layout.height - bodyY - layout.height * 0.08),
    fontSize: Math.min(21, sourceTitle.fontSize || 21),
    fontWeight: 400,
  };
  return { title, body };
}

function isTextSlotBackground(shape: TemplateElement, layout: TemplateLayout) {
  const filledTextSurface = (shape.type === "text" || shape.type === "placeholder")
    && !shape.text.trim()
    && Boolean(shape.fill || shape.stroke);
  if (shape.type !== "shape" && !filledTextSurface) return false;
  return layout.elements.some((slot) => (
    slot.id !== shape.id
    && (slot.type === "text" || slot.type === "placeholder")
    && containsRect(shape, slot)
  ));
}

function fullBleedRasterBackground(layout: TemplateLayout) {
  const canvasArea = layout.width * layout.height;
  return layout.elements
    .filter((element) => element.type === "image"
      && Boolean(element.imageDataUrl)
      && isContainedInCanvas(element, layout.width, layout.height)
      && (element.w * element.h) / canvasArea >= ARTWORK_BACKGROUND_AREA_RATIO)
    .sort((left, right) => right.w * right.h - left.w * left.h)[0];
}

function materializeTextAssignments(
  assignments: readonly TextAssignment[],
  layout: TemplateLayout,
  artwork: readonly Rect[],
  preserveRasterContentColumn = false,
  preserveSourceSlots = false,
  sourceSlotArtwork: readonly Rect[] = artwork,
) {
  const occupied: Rect[] = [];
  const ordered = assignments
    .filter((assignment) => assignment.value)
    .slice()
    .sort((left, right) => (left.index === 0 ? -1 : right.index === 0 ? 1 : 0)
      || textPlacementDemand(right, layout) - textPlacementDemand(left, layout)
      || right.value.length - left.value.length
      || left.index - right.index);
  const positioned = new Map<number, TextAssignment>();
  ordered.forEach((assignment) => {
    const slot = findArtworkClearTextSlot(
      assignment.slot,
      assignment.value,
      assignment.index,
      layout,
      artwork,
      occupied,
      preserveRasterContentColumn && assignment.index > 0,
      preserveSourceSlots,
      sourceSlotArtwork,
      positioned.get(0)?.slot,
    );
    occupied.push(slot);
    positioned.set(assignment.index, { ...assignment, slot });
  });
  return assignments.map((assignment) => positioned.get(assignment.index) || assignment);
}

function textPlacementDemand(assignment: TextAssignment, layout: TemplateLayout) {
  const width = Math.max(layout.width * 0.12, assignment.slot.w);
  const neededHeight = measureTextForBox(assignment.value, 14, width).height;
  return neededHeight / Math.max(1, assignment.slot.h);
}

function findArtworkClearTextSlot(
  slot: TemplateElement,
  value: string,
  index: number,
  layout: TemplateLayout,
  artwork: readonly Rect[],
  occupied: readonly Rect[],
  preserveSourceColumn = false,
  preserveSourceSlot = false,
  sourceSlotArtwork: readonly Rect[] = artwork,
  positionedTitle?: Rect,
) {
  const edgeSafeSlot = insetTextSlotFromCanvasEdges(slot, layout);
  const followsTitle = (candidate: Rect) => !positionedTitle
    || candidate.x >= positionedTitle.x + positionedTitle.w
    || candidate.x + candidate.w <= positionedTitle.x
    || candidate.y >= positionedTitle.y + positionedTitle.h + Math.max(8, layout.height * 0.02);
  if (preserveSourceSlot && isInsideCanvasRect(edgeSafeSlot, layout)
    && textFitsSlot(value, edgeSafeSlot, index, layout)
    && followsTitle(edgeSafeSlot)
    && !hasAnyArtworkOverlap(edgeSafeSlot, sourceSlotArtwork)
    && !occupied.some((rect) => overlapsElement(edgeSafeSlot, rect))) {
    return edgeSafeSlot;
  }
  if (isInsideCanvasRect(edgeSafeSlot, layout) && textFitsSlot(value, edgeSafeSlot, index, layout)
    && followsTitle(edgeSafeSlot)
    && !overlapsArtwork(edgeSafeSlot, artwork)
    && !hasAnyArtworkOverlap(edgeSafeSlot, sourceSlotArtwork)
    && !occupied.some((rect) => overlapsElement(edgeSafeSlot, rect))) {
    return edgeSafeSlot;
  }

  const minWidth = Math.min(slot.w, Math.max(layout.width * 0.12, layout.width * (index === 0 ? 0.16 : 0.14)));
  const maxWidth = Math.min(layout.width * 0.82, Math.max(slot.w, layout.width * 0.82));
  const widths = preserveSourceColumn
    ? [Math.min(slot.w, layout.width * 0.42)]
    : uniqueNumbers([
    slot.w,
    ...Array.from({ length: 9 }, (_, index) => layout.width * (0.18 + index * 0.08)),
    slot.w * 1.15,
    slot.w * 1.3,
    slot.w * 1.5,
    slot.w * 1.8,
    slot.w * 2.2,
    maxWidth,
    slot.w * 0.92,
    slot.w * 0.84,
    slot.w * 0.76,
    slot.w * 0.68,
    slot.w * 0.6,
    slot.w * 0.5,
    slot.w * 0.4,
    minWidth,
    ].map((width) => Math.max(minWidth, Math.min(maxWidth, width))));
  const maxHeight = Math.min(layout.height * 0.8, layout.height - 12);
  const heights = uniqueNumbers([
    slot.h,
    slot.h * 1.25,
    slot.h * 1.5,
    slot.h * 1.8,
    layout.height * 0.25,
    layout.height * 0.35,
    layout.height * 0.5,
    layout.height * 0.65,
  ].map((height) => Math.min(maxHeight, Math.max(slot.h, height))));
  let best: TemplateElement | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const width of widths) {
    for (const height of heights) {
      const candidateBase = { ...slot, w: width, h: height };
      const preferredFontSize = slot.fontSize || fontSizeFor(index, layout);
      if (!textFitsSlot(value, candidateBase, index, layout)) continue;
      const xPositions = preserveSourceColumn
        ? [Math.max(6, Math.min(layout.width - width - 6, slot.x))]
        : candidateAxisPositions(layout.width, width, slot.x + (slot.w - width) / 2, artwork, "x");
      const yPositions = candidateAxisPositions(
        layout.height,
        height,
        preserveSourceColumn ? slot.y : slot.y + (slot.h - height) / 2,
        artwork,
        "y",
      );
      for (const x of xPositions) {
        for (const y of yPositions) {
          const candidate = { ...candidateBase, x, y };
          if (!followsTitle(candidate)) continue;
          if (hasAnyArtworkOverlap(candidate, sourceSlotArtwork)) continue;
          const artworkOverlap = artworkOverlapRatio(candidate, artwork);
          const textOverlap = occupied.some((rect) => overlapsElement(candidate, rect));
          const widthChange = Math.abs(slot.w - width) / Math.max(1, slot.w);
          const heightGrowth = Math.max(0, (height - slot.h) / Math.max(1, layout.height));
          const movement = Math.abs(x - slot.x) / layout.width + Math.abs(y - slot.y) / layout.height;
          const score = (textOverlap ? 2_000_000 : 0) + artworkOverlap * 1_000_000
            + widthChange * 1_000 + movement * 50 + heightGrowth * 20
            + Math.max(0, preferredFontSize - fitTextFontSize(value, preferredFontSize, width, height)) * 0.1;
          if (score < bestScore) {
            best = candidate;
            bestScore = score;
          }
        }
      }
    }
  }
  return best || edgeSafeSlot;
}

function rasterContentFallbackSlot(
  slots: readonly TemplateElement[],
  titleSlot: TemplateElement,
  layout: TemplateLayout,
) {
  const leftColumnSlots = slots
    .filter((slot) => slot.y >= titleSlot.y + titleSlot.h
      && slot.x <= layout.width * 0.2
      && slot.x + slot.w <= layout.width * 0.55
      && slot.w >= layout.width * 0.24
      && slot.h >= layout.height * 0.05)
    .sort((left, right) => right.w * right.h - left.w * left.h || left.y - right.y || left.x - right.x);
  const sourceSlot = leftColumnSlots[0];
  return sourceSlot
    ? { ...sourceSlot, w: Math.min(sourceSlot.w, layout.width * 0.42) }
    : undefined;
}

function templateTextAlignment(slot: Pick<TemplateElement, "x" | "w">, layout: TemplateLayout, textIndex: number) {
  if (textIndex > 0) return "left" as const;
  const slotCenter = slot.x + slot.w / 2;
  return Math.abs(slotCenter - layout.width / 2) <= layout.width * 0.05 ? "center" as const : "left" as const;
}

function templateTextSurfaceFill(slot: Rect, layout: TemplateLayout, palette: string[]) {
  const background = layout.elements
    .filter((element) => element.type === "shape"
      && containsRect(element, slot)
      && (element.fill || palette[1]))
    .sort((left, right) => left.w * left.h - right.w * right.h || right.zIndex - left.zIndex)[0];
  return background?.fill || (background ? palette[1] : undefined);
}

function containsRect(container: Rect, content: Rect) {
  return content.x >= container.x
    && content.y >= container.y
    && content.x + content.w <= container.x + container.w
    && content.y + content.h <= container.y + container.h;
}

function sameRect(left: Rect, right: Rect) {
  return left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h;
}

/** Only images attached one-to-one to repeated source text slots are item
 * markers. A repeated decorative icon run without those slots is artwork. */
function excessMarkerRows(layout: TemplateLayout, itemCount: number) {
  if (!itemCount) return [];
  const images = layout.elements.filter((image) => image.type === "image" && Boolean(image.imageDataUrl)
    && isContainedInCanvas(image, layout.width, layout.height)
    && image.y >= layout.height * 0.12 && image.y + image.h <= layout.height * 0.82
    && image.w <= layout.width * 0.08 && image.h <= layout.height * 0.12)
    .sort((left, right) => right.w * right.h - left.w * left.h);
  const groups: Array<{ anchor: TemplateElement; images: TemplateElement[]; background?: TemplateElement; slot?: TemplateElement }> = [];
  for (const image of images) {
    const centerX = image.x + image.w / 2;
    const centerY = image.y + image.h / 2;
    const group = groups.find(({ anchor }) => Math.abs(centerX - anchor.x - anchor.w / 2) <= Math.max(3, anchor.w * 0.15)
      && Math.abs(centerY - anchor.y - anchor.h / 2) <= Math.max(3, anchor.h * 0.15));
    if (group) group.images.push(image);
    else groups.push({ anchor: image, images: [image] });
  }
  const runs = groups.map((group) => groups.filter((peer) =>
    Math.abs(peer.anchor.w - group.anchor.w) <= Math.max(2, group.anchor.w * 0.08)
    && Math.abs(peer.anchor.h - group.anchor.h) <= Math.max(2, group.anchor.h * 0.08)));
  const largest = runs.sort((left, right) => right.length - left.length)[0] || [];
  if (largest.length < 6 || largest.length <= itemCount + 1) return [];
  const sourceSlots = layout.elements.filter((element) => (element.type === "text" || element.type === "placeholder")
    && isUsableTextSlot(element, layout)
    && element.w * element.h <= layout.width * layout.height * 0.2);
  const paired = largest.map((group) => ({ ...group, slot: sourceSlots
    .filter((slot) => containsRect(slot, group.anchor))
    .sort((left, right) => left.w * left.h - right.w * right.h)[0] }));
  if (paired.some((group) => !group.slot)
    || new Set(paired.map((group) => group.slot!.id)).size !== paired.length) return [];
  const peer = paired[0]!.slot!;
  if (paired.some((group) => Math.abs(group.slot!.w - peer.w) > Math.max(2, peer.w * 0.08)
    || Math.abs(group.slot!.h - peer.h) > Math.max(2, peer.h * 0.08))) return [];
  return paired.map((group) => ({ ...group, background: layout.elements.find((element) =>
    (element.type === "text" || element.type === "placeholder") && !element.text.trim()
      && Boolean(element.fill || element.stroke) && containsRect(element, group.anchor)
      && element.w * element.h <= group.anchor.w * group.anchor.h * 12) }));
}

function candidateAxisPositions(
  limit: number,
  size: number,
  preferred: number,
  artwork: readonly Rect[],
  axis: "x" | "y",
) {
  const max = Math.max(0, limit - size);
  const edgeInset = Math.min(TEXT_CANVAS_EDGE_INSET_PX, max / 2);
  const min = edgeInset;
  const safeMax = Math.max(min, max - edgeInset);
  const padding = Math.max(6, limit * 0.008);
  const step = Math.max(12, limit / 16);
  const positions = [min, safeMax, Math.max(min, Math.min(safeMax, preferred)), (min + safeMax) / 2];
  for (let coordinate = min; coordinate <= safeMax; coordinate += step) positions.push(coordinate);
  for (const obstacle of artwork) {
    const start = axis === "x" ? obstacle.x : obstacle.y;
    const end = start + (axis === "x" ? obstacle.w : obstacle.h);
    positions.push(start - size - padding, end + padding);
  }
  const unique = uniqueNumbers(positions.map((value) => Math.max(min, Math.min(safeMax, value))))
    .sort((left, right) => Math.abs(left - preferred) - Math.abs(right - preferred));
  const required = [min, safeMax, Math.max(min, Math.min(safeMax, preferred)), (min + safeMax) / 2];
  return uniqueNumbers([...required, ...unique.slice(0, 16)]);
}

function insetTextSlotFromCanvasEdges(slot: TemplateElement, layout: TemplateLayout): TemplateElement {
  const x = Math.max(TEXT_CANVAS_EDGE_INSET_PX, Math.min(layout.width - TEXT_CANVAS_EDGE_INSET_PX, slot.x));
  const y = Math.max(TEXT_CANVAS_EDGE_INSET_PX, Math.min(layout.height - TEXT_CANVAS_EDGE_INSET_PX, slot.y));
  const w = Math.min(slot.w, Math.max(0, layout.width - TEXT_CANVAS_EDGE_INSET_PX - x));
  const h = Math.min(slot.h, Math.max(0, layout.height - TEXT_CANVAS_EDGE_INSET_PX - y));
  return { ...slot, x, y, w, h };
}

function uniqueNumbers(values: number[]) {
  const seen = new Set<number>();
  return values.filter((value) => {
    const rounded = Math.round(value * 10) / 10;
    if (seen.has(rounded)) return false;
    seen.add(rounded);
    return true;
  }).map((value) => Math.round(value * 10) / 10);
}

function isInsideCanvasRect(rect: Rect, layout: TemplateLayout) {
  return rect.x >= 0
    && rect.y >= 0
    && rect.w > 0
    && rect.h > 0
    && rect.x + rect.w <= layout.width
    && rect.y + rect.h <= layout.height;
}

function intersectionArea(left: Rect, right: Rect) {
  const width = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function artworkOverlapRatio(rect: Rect, artwork: readonly Rect[]) {
  const area = rect.w * rect.h;
  if (area <= 0) return 1;
  return Math.max(0, ...artwork.map((element) => {
    const overlap = intersectionArea(rect, element);
    return overlap / Math.min(area, element.w * element.h);
  }));
}

function overlapsArtwork(rect: Rect, artwork: readonly Rect[]) {
  return artworkOverlapRatio(rect, artwork) >= TEXT_ARTWORK_CLEARANCE;
}

function hasAnyArtworkOverlap(rect: Rect, artwork: readonly Rect[]) {
  return artwork.some((element) => intersectionArea(rect, element) > 0);
}

function isUsableTextSlot(element: TemplateElement, layout: TemplateLayout) {
  if (!intersectsCanvas(element, layout.width, layout.height)) return false;
  const areaRatio = (element.w * element.h) / (layout.width * layout.height);
  return element.w >= layout.width * 0.12
    && element.h >= layout.height * 0.05
    && areaRatio <= 0.78;
}

/**
 * Apply the bounded variant profile only when the caller explicitly opts in.
 * The public renderer keeps its historical geometry by default; the
 * orchestrator uses this small, deterministic slot adjustment so three
 * materialized documents remain structurally distinguishable even when a
 * sparse template exposes only one reusable layout family.
 */
function adjustVariantTextSlot(
  element: TemplateElement,
  layout: TemplateLayout,
  purpose: PresentationPlan["slides"][number]["purpose"],
  variant?: LayoutVariant,
): TemplateElement {
  if (!variant || purpose === "title" || (element.type !== "text" && element.type !== "placeholder")) return element;
  const widthFactor = variant === "compact" ? 1.08 : variant === "visual" ? 0.82 : 1;
  const targetWidth = Math.max(layout.width * 0.12, Math.min(layout.width * 0.82, element.w * widthFactor));
  const centeredX = element.x + (element.w - targetWidth) / 2;
  const x = Math.max(0, Math.min(layout.width - targetWidth, centeredX));
  return { ...element, x, w: targetWidth };
}

function sameImagePlacement(left: TemplateElement, right: TemplateElement) {
  return left.imageDataUrl === right.imageDataUrl
    && left.x === right.x
    && left.y === right.y
    && left.w === right.w
    && left.h === right.h
    && left.rotation === right.rotation
    && (left.crop === right.crop || (Boolean(left.crop) && Boolean(right.crop)
      && left.crop!.left === right.crop!.left
      && left.crop!.top === right.crop!.top
      && left.crop!.right === right.crop!.right
      && left.crop!.bottom === right.crop!.bottom));
}

function fallbackSlots(layout: TemplateLayout, titleSlot?: TemplateElement, bottomLimit = layout.height * 0.92): TemplateElement[] {
  const bodyY = titleSlot
    ? Math.max(layout.height * 0.4, titleSlot.y + titleSlot.h + layout.height * 0.06)
    : layout.height * 0.4;
  const bodyHeight = titleSlot
    ? Math.max(layout.height * 0.16, Math.min(layout.height * 0.35, bottomLimit - bodyY))
    : Math.max(layout.height * 0.16, Math.min(layout.height * 0.4, bottomLimit - bodyY));
  return [
    {
      id: "fallback-title",
      type: "text",
      name: "Title",
      x: layout.width * 0.09,
      y: layout.height * 0.13,
      w: layout.width * 0.82,
      h: layout.height * 0.19,
      text: "",
      fontSize: 44,
      zIndex: 50,
    },
    {
      id: "fallback-body",
      type: "text",
      name: "Body",
      x: layout.width * 0.1,
      y: bodyY,
      w: layout.width * 0.58,
      h: bodyHeight,
      text: "",
      fontSize: 24,
      zIndex: 51,
    },
  ];
}

function fallbackTimeline(
  slideId: string,
  content: string[],
  layout: TemplateLayout,
  palette: string[],
  designSystem: DesignSystem,
  background: string,
  titleSlot: TemplateElement,
  artwork: readonly Rect[],
): CanvasElement[] {
  const values = content.slice(0, 4);
  if (!values.length) return [];

  const placement = findFallbackTimelinePlacement(layout, titleSlot, artwork, values);
  if (!placement) throw new Error("Unable to place fallback timeline after its title without crossing artwork");
  const {
    start,
    width,
    step,
    labelWidth,
    labelHeight,
    horizontalPadding,
    verticalPadding,
    labelY,
    lineY,
  } = placement;
  const overlayZIndex = Math.max(60, ...layout.elements.map((element) => element.zIndex + 1));
  const rasterBackground = fullBleedRasterBackground(layout);
  const labelBackground = rasterBackground ? "#FFFFFF" : fallbackTimelineBackground(background, palette);
  const labelColor = bestContrastColor(labelBackground, ["#FFFFFF", "#000000"]);
  const lineColor = rasterBackground ? "#000000" : readableTextColor(background, palette);
  const result: CanvasElement[] = [];
  if (rasterBackground) {
    result.push({
      id: slideId + "-timeline-rail",
      type: "shape",
      x: start,
      y: lineY - 6,
      w: width,
      h: 12,
      shape: "roundRect",
      fill: "#FFFFFF",
      stroke: "#FFFFFF",
      strokeWidth: 0,
      radius: 6,
      zIndex: overlayZIndex,
      locked: false,
    });
  }
  result.push({
    id: slideId + "-timeline-line",
    type: "shape",
    x: start,
    y: lineY,
    w: width,
    h: 3,
    shape: "line",
    fill: lineColor,
    stroke: lineColor,
    strokeWidth: 2,
    radius: 0,
    zIndex: overlayZIndex + 1,
    locked: false,
  });
  values.forEach((value, index) => {
    const x = start + step * (index + 0.5);
    const labelX = x - labelWidth / 2;
    result.push({
      id: slideId + "-timeline-dot-" + index,
      type: "shape",
      x: x - 10,
      y: lineY - 10,
      w: 20,
      h: 20,
      shape: "ellipse",
      fill: lineColor,
      stroke: lineColor,
      strokeWidth: 0,
      radius: 10,
      zIndex: overlayZIndex + 2,
      locked: false,
    }, {
      id: slideId + "-timeline-panel-" + index,
      type: "shape",
      x: labelX - horizontalPadding,
      y: labelY - verticalPadding,
      w: labelWidth + horizontalPadding * 2,
      h: labelHeight + verticalPadding * 2,
      shape: "roundRect",
      fill: labelBackground,
      stroke: lineColor,
      strokeWidth: 1,
      radius: 8,
      zIndex: overlayZIndex + 3,
      locked: false,
    }, {
      id: slideId + "-timeline-label-" + index,
      type: "text",
      x: labelX,
      y: labelY,
      w: labelWidth,
      h: labelHeight,
      text: value,
      fontFamily: resolveTextFont("body", designSystem),
      fontSize: fitTextFontSize(value, 18, labelWidth, labelHeight),
      fontWeight: 600,
      color: labelColor,
      align: "center",
      zIndex: overlayZIndex + 4,
      locked: false,
    });
  });
  return result;
}

type FallbackTimelinePlacement = {
  start: number;
  width: number;
  step: number;
  labelWidth: number;
  labelHeight: number;
  horizontalPadding: number;
  verticalPadding: number;
  labelY: number;
  lineY: number;
};

function findFallbackTimelinePlacement(
  layout: TemplateLayout,
  titleSlot: TemplateElement,
  artwork: readonly Rect[],
  values: string[],
): FallbackTimelinePlacement | undefined {
  const labelCount = values.length;
  const labelHeight = Math.min(58, layout.height * 0.1);
  const verticalPadding = Math.min(8, layout.height * 0.02);
  const labelToLineGap = Math.min(26, layout.height * 0.04);
  const titleGap = Math.max(12, layout.height * 0.025);
  const minLabelY = Math.max(verticalPadding, titleSlot.y + titleSlot.h + titleGap + verticalPadding);
  const maxLabelY = layout.height - labelHeight - labelToLineGap - 10;
  if (minLabelY > maxLabelY) return undefined;
  const preferredLabelY = Math.max(minLabelY, Math.min(maxLabelY,
    layout.height * 0.76 - labelHeight - labelToLineGap));
  const candidateYs = uniqueNumbers([
    minLabelY,
    maxLabelY,
    preferredLabelY,
    ...Array.from({ length: 37 }, (_, index) => minLabelY + (maxLabelY - minLabelY) * index / 36),
    ...artwork.flatMap((element) => [
      element.y - labelHeight - verticalPadding * 2 - labelToLineGap - 10,
      element.y + element.h + verticalPadding + 10,
    ]),
  ].map((value) => Math.max(minLabelY, Math.min(maxLabelY, value))))
    .sort((left, right) => Math.abs(left - preferredLabelY) - Math.abs(right - preferredLabelY));
  const candidateWidths = uniqueNumbers([
    ...Array.from({ length: 14 }, (_, index) => layout.width * (0.76 - index * 0.04)),
    ...artwork.map((element) => element.x - layout.width * 0.01),
    ...artwork.map((element) => layout.width - element.x - element.w - layout.width * 0.01),
  ].filter((value) => value >= layout.width * 0.24 && value <= layout.width * 0.82))
    .sort((left, right) => right - left);

  for (const width of candidateWidths) {
    const step = width / labelCount;
    const labelWidth = Math.min(210, step * 0.86);
    const horizontalPadding = Math.min(12, step * 0.04);
    if (values.some((value) => {
      const fontSize = fitTextFontSize(value, 18, labelWidth, labelHeight);
      return measureTextForBox(value, fontSize, labelWidth).height > labelHeight;
    })) continue;
    const maxStart = Math.max(0, layout.width - width);
    const preferredStart = layout.width * 0.12;
    const starts = uniqueNumbers([
      0,
      maxStart,
      maxStart / 2,
      preferredStart,
      ...artwork.flatMap((element) => [
        element.x - width - horizontalPadding,
        element.x + element.w + horizontalPadding,
      ]),
    ].map((value) => Math.max(0, Math.min(maxStart, value))))
      .sort((left, right) => Math.abs(left - preferredStart) - Math.abs(right - preferredStart));

    for (const start of starts) {
      for (const labelY of candidateYs) {
        const panels = values.map((_, index) => {
          const center = start + step * (index + 0.5);
          return {
            x: center - labelWidth / 2 - horizontalPadding,
            y: labelY - verticalPadding,
            w: labelWidth + horizontalPadding * 2,
            h: labelHeight + verticalPadding * 2,
          };
        });
        const lineY = labelY + labelHeight + labelToLineGap;
        const line = { x: start, y: lineY, w: width, h: 3 };
        const dots = values.map((_, index) => {
          const center = start + step * (index + 0.5);
          return { x: center - 10, y: lineY - 10, w: 20, h: 20 };
        });
        const inBounds = (rect: Rect) => rect.x >= 0 && rect.y >= 0
          && rect.x + rect.w <= layout.width && rect.y + rect.h <= layout.height;
        if (panels.some((panel) => !inBounds(panel)
          || overlapsElement(panel, titleSlot)
          || overlapsArtwork(panel, artwork))) continue;
        if ([line, ...dots].some((element) => !inBounds(element)
          || overlapsElement(element, titleSlot)
          || overlapsArtwork(element, artwork))) continue;
        return {
          start,
          width,
          step,
          labelWidth,
          labelHeight,
          horizontalPadding,
          verticalPadding,
          labelY,
          lineY,
        };
      }
    }
  }
  return undefined;
}

function fallbackTimelineBackground(background: string, palette: string[]) {
  const colors = [...palette, "#FFFFFF", "#1A1A1A"]
    .filter((color) => /^#[\da-f]{6}$/iu.test(color));
  return colors.sort((left, right) => contrast(right, background) - contrast(left, background))[0] || "#FFFFFF";
}

function fallbackCards(
  slideId: string,
  content: string[],
  layout: TemplateLayout,
  background: string,
  palette: string[],
  designSystem: DesignSystem,
  artwork: readonly Rect[],
): CanvasElement[] {
  const values = packCardContent(content, 4);
  const gap = Math.max(16, layout.width * 0.02);
  const cardWidth = (layout.width * 0.82 - gap * (values.length - 1)) / values.length;
  const cardHeight = layout.height * 0.17;
  const preferredY = layout.height * 0.67;
  const candidateYs = Array.from({ length: 37 }, (_, index) => (
    (layout.height - cardHeight) * index / 36
  )).sort((left, right) => Math.abs(left - preferredY) - Math.abs(right - preferredY));
  const y = candidateYs.find((candidateY) => values.every((_, index) => {
    const x = layout.width * 0.09 + index * (cardWidth + gap);
    const card = { x, y: candidateY, w: cardWidth, h: cardHeight };
    const text = { x: x + 16, y: candidateY + 15, w: cardWidth - 32, h: layout.height * 0.12 };
    return !overlapsArtwork(card, artwork) && !overlapsArtwork(text, artwork);
  })) ?? preferredY;
  const fill = palette.at(1) || (background === "#FFFFFF" ? "#F2F4F8" : "#FFFFFF");
  return values.flatMap((value, index) => {
    const x = layout.width * 0.09 + index * (cardWidth + gap);
    const groupId = slideId + "-card-" + index;
    return [{
      id: groupId + "-shape",
      type: "shape" as const,
      x,
      y,
      w: cardWidth,
      h: layout.height * 0.17,
      shape: "roundRect" as const,
      fill,
      stroke: fill,
      strokeWidth: 0,
      radius: 16,
      zIndex: 70,
      locked: false,
      groupId,
    }, {
      id: groupId + "-text",
      type: "text" as const,
      x: x + 16,
      y: y + 15,
      w: cardWidth - 32,
      h: layout.height * 0.12,
      text: wrapTextForBox(value, fitTextFontSize(value, 17, cardWidth - 32, layout.height * 0.12), cardWidth - 32),
      fontFamily: resolveTextFont("body", designSystem),
      fontSize: fitTextFontSize(value, 17, cardWidth - 32, layout.height * 0.12),
      fontWeight: 600,
      color: readableTextColor(fill, palette),
      align: "left" as const,
      zIndex: 71,
      locked: false,
    }];
  });
}

function formatContent(content: string[]) {
  return content.length > 1 ? content.map((item) => "• " + item).join("\n") : content[0] || "";
}

function packCardContent(content: string[], slotCount: number) {
  if (content.length <= slotCount) return content;
  const leading = content.slice(0, Math.max(0, slotCount - 1));
  const final = content.slice(Math.max(0, slotCount - 1)).join(" · ");
  return [...leading, final];
}

function textFontRole(index: number): TextFontRole {
  return index === 0 ? "heading" : "body";
}

function fontSizeFor(index: number, layout: TemplateLayout) {
  if (index === 0) return Math.max(34, Math.min(56, layout.height * 0.07));
  return Math.max(18, Math.min(28, layout.height * 0.035));
}

function fitTextFontSize(value: string, preferred: number, width: number, height: number) {
  const minimum = 14;
  let fontSize = Math.max(minimum, Math.round(preferred));
  const targetHeight = height * 0.86;
  while (fontSize > minimum && measureTextForBox(value, fontSize, width).height > targetHeight) {
    fontSize -= 1;
  }
  return fontSize;
}

function textFitsSlot(value: string, slot: TemplateElement, index: number, layout: TemplateLayout) {
  const preferredFontSize = slot.fontSize || fontSizeFor(index, layout);
  const fontSize = fitTextFontSize(value, preferredFontSize, slot.w, slot.h);
  const measurement = measureTextForBox(value, fontSize, slot.w);
  const wrapsInsideWord = value.split(/\s+/u).some((word) => (
    /[\p{Script=Latin}\p{Script=Cyrillic}]/u.test(word)
      && word.length > measurement.charsPerLine
  ));
  return measurement.height <= slot.h && !wrapsInsideWord;
}

function wrapTextForBox(value: string, fontSize: number, width: number) {
  return measureTextForBox(value, fontSize, width).wrappedText;
}

function readableTextColor(background: string, palette: string[]) {
  return bestContrastColor(background, [...palette, "#FFFFFF", "#000000"]);
}

function bestContrastColor(background: string, candidates: string[]) {
  const normalized = candidates.filter((color) => /^#[\da-f]{6}$/iu.test(color));
  return normalized.sort((left, right) => contrast(right, background) - contrast(left, background))[0]
    || "#000000";
}

function relativeLuminance(color: string) {
  const channels = color.slice(1).match(/.{2}/g)?.map((part) => Number.parseInt(part, 16) / 255) || [1, 1, 1];
  const normalized = channels.map((value) => value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
  return normalized[0] * 0.2126 + normalized[1] * 0.7152 + normalized[2] * 0.0722;
}

function contrast(left: string, right: string) {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
