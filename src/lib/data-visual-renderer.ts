import {
  canvasPieChartSchema,
  canvasElementSchema,
  type CanvasElement,
} from "./schemas";
import { measureTextForBox } from "./audit";
import {
  dataVisualSpecSchema,
  type DataVisualSpec,
} from "./skills/data-visual-spec";

export type FactBackedTableSpec = Extract<DataVisualSpec, { visualType: "table" }>;
export type FactBackedChartSpec = Extract<DataVisualSpec, { visualType: "chart" }>;
export type FactBackedDiagramSpec = Extract<DataVisualSpec, { visualType: "diagram" }>;

/**
 * Geometry belongs to the layout caller, not to data-visual-spec v1.
 * The slot id also makes multiple data visuals on one slide deterministic.
 */
export type DataVisualLayoutSlot = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  locked?: boolean;
  sourceTemplateElementId?: string;
};

/** Kept as a named alias for the existing table render input. */
export type DataVisualTableLayoutSlot = DataVisualLayoutSlot;
export type DataVisualChartLayoutSlot = DataVisualLayoutSlot;

type DiagramNodeBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DataVisualTableStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  headerFill: string;
  headerColor: string;
  bodyFill: string;
  bodyColor: string;
  borderColor: string;
  borderWidth: number;
};

const DEFAULT_TABLE_STYLE: DataVisualTableStyle = {
  fontFamily: "Arial",
  fontSize: 18,
  fontWeight: 400,
  headerFill: "#112233",
  headerColor: "#FFFFFF",
  bodyFill: "#FFFFFF",
  bodyColor: "#000000",
  borderColor: "#445566",
  borderWidth: 1,
};

export type DataVisualBarChartStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  panelFill: string;
  panelStroke: string;
  axisColor: string;
  labelColor: string;
  valueColor: string;
  seriesColors: readonly string[];
};

const DEFAULT_BAR_CHART_STYLE: DataVisualBarChartStyle = {
  fontFamily: "Arial",
  fontSize: 18,
  fontWeight: 400,
  panelFill: "#FFFFFF",
  panelStroke: "#D7DEE7",
  axisColor: "#445566",
  labelColor: "#1A1A1A",
  valueColor: "#1A1A1A",
  seriesColors: ["#2F6FED", "#F28E2B", "#59A14F", "#E15759", "#B279A2"],
};

export class DataVisualRendererError extends Error {
  constructor(readonly code:
    | "unsupported_visual_type"
    | "unsupported_chart_type"
    | "unsupported_chart_capacity"
    | "unsupported_diagram_capacity"
    | "invalid_layout_slot") {
    super(code);
    this.name = "DataVisualRendererError";
  }
}

/**
 * Convert one validated fact-backed table spec into the existing native table
 * contract. The adapter is deliberately pure: it performs no layout search,
 * provider call, filesystem access, or export-specific XML work.
 */
export function materializeFactBackedTable(
  spec: FactBackedTableSpec,
  slot: DataVisualTableLayoutSlot,
  style: Partial<DataVisualTableStyle> = {},
): Extract<CanvasElement, { type: "table" }> {
  const validatedSpec = dataVisualSpecSchema.parse(spec);
  if (validatedSpec.visualType !== "table") {
    throw new TypeError("Data visual renderer accepts table specs only");
  }

  const resolvedStyle = { ...DEFAULT_TABLE_STYLE, ...style };
  const rows = [
    [
      tableCell(validatedSpec.rowLabelHeader?.value ?? "", resolvedStyle, "left", true),
      ...validatedSpec.columns.map((column) => tableCell(datumText(column), resolvedStyle, "center", true)),
    ],
    ...validatedSpec.rows.map((row) => [
      tableCell(row.label.value, resolvedStyle, "left", false),
      ...row.cells.map((cell) => tableCell(
        datumText(cell),
        resolvedStyle,
        typeof cell.value === "number" ? "right" : "left",
        false,
      )),
    ]),
  ];

  return canvasElementSchema.parse({
    ...slot,
    type: "table",
    rows,
    fontFamily: resolvedStyle.fontFamily,
    fontSize: resolvedStyle.fontSize,
    fontWeight: resolvedStyle.fontWeight,
    locked: slot.locked ?? false,
  }) as Extract<CanvasElement, { type: "table" }>;
}

/**
 * Convert one validated fact-backed chart spec into native shapes and text.
 * The chart never owns layout: every generated object is inset into the
 * caller-owned slot and receives a stable id derived from that slot and the
 * semantic input order.
 */
export function materializeFactBackedChart(
  spec: DataVisualSpec,
  slot: DataVisualChartLayoutSlot,
  style: Partial<DataVisualBarChartStyle> = {},
): CanvasElement[] {
  const validatedSpec = dataVisualSpecSchema.parse(spec);
  if (validatedSpec.visualType !== "chart") {
    throw new DataVisualRendererError("unsupported_visual_type");
  }
  if (validatedSpec.chartType === "pie") {
    return materializeFactBackedPieChart(validatedSpec, slot);
  }
  if (validatedSpec.chartType === "line") {
    return materializeFactBackedLineChart(validatedSpec, slot, style);
  }
  if (validatedSpec.chartType !== "bar") {
    throw new DataVisualRendererError("unsupported_chart_type");
  }
  validateLayoutSlot(slot);

  const resolvedStyle = { ...DEFAULT_BAR_CHART_STYLE, ...style };
  const categoryCount = validatedSpec.categories.length;
  const seriesCount = validatedSpec.series.length;
  const expectedElementCount = 2
    + 1
    + seriesCount * 2
    + categoryCount * seriesCount * 2
    + categoryCount;
  if (expectedElementCount > 200) {
    throw new DataVisualRendererError("unsupported_chart_capacity");
  }

  const padding = Math.max(8, Math.min(16, Math.min(slot.w, slot.h) * 0.04));
  const titleHeight = Math.max(20, Math.min(32, slot.h * 0.12));
  const legendRowHeight = Math.max(18, Math.min(26, resolvedStyle.fontSize * 1.4));
  const legendHeight = legendRowHeight * seriesCount;
  const valueLabelHeight = Math.max(18, Math.min(26, resolvedStyle.fontSize * 1.35));
  const categoryLabelHeight = Math.max(22, Math.min(52, slot.h * 0.18));
  const valueBandY = slot.y + padding + titleHeight + 4 + legendHeight;
  const plotTop = valueBandY + valueLabelHeight + 4;
  const plotBottom = slot.y + slot.h - padding - categoryLabelHeight;
  const plotHeight = plotBottom - plotTop;
  const plotWidth = slot.w - padding * 2;
  if (plotWidth <= 0 || plotHeight < 20) {
    throw new DataVisualRendererError("unsupported_chart_capacity");
  }

  const categoryWidth = plotWidth / categoryCount;
  const innerCategoryWidth = categoryWidth * 0.84;
  const barGap = seriesCount > 1
    ? Math.min(4, innerCategoryWidth / (seriesCount * 4))
    : 0;
  const barWidth = (innerCategoryWidth - barGap * (seriesCount - 1)) / seriesCount;
  if (categoryWidth <= 0 || barWidth < 2) {
    throw new DataVisualRendererError("unsupported_chart_capacity");
  }

  const values = validatedSpec.series.flatMap((series) => series.values.map((datum) => datum.value));
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const range = maximum - minimum || 1;
  const baselineY = plotTop + plotHeight * (maximum / range);
  const seriesColors = resolvedStyle.seriesColors.length
    ? resolvedStyle.seriesColors
    : DEFAULT_BAR_CHART_STYLE.seriesColors;
  const elements: CanvasElement[] = [];
  let zIndex = slot.zIndex;

  elements.push(chartShape({
    id: slot.id,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.h,
    shape: "rect",
    fill: resolvedStyle.panelFill,
    stroke: resolvedStyle.panelStroke,
    strokeWidth: 1,
    radius: 0,
    zIndex: zIndex++,
    locked: slot.locked ?? false,
    sourceTemplateElementId: slot.sourceTemplateElementId,
  }));
  elements.push(chartShape({
    id: `${slot.id}-axis`,
    x: slot.x + padding,
    y: round(baselineY),
    w: plotWidth,
    h: 1,
    shape: "line",
    fill: resolvedStyle.axisColor,
    stroke: resolvedStyle.axisColor,
    strokeWidth: 1,
    radius: 0,
    zIndex: zIndex++,
    locked: slot.locked ?? false,
  }));

  validatedSpec.series.forEach((series, seriesIndex) => {
    series.values.forEach((datum, categoryIndex) => {
      const categoryX = slot.x + padding + categoryIndex * categoryWidth;
      const barX = categoryX + (categoryWidth - innerCategoryWidth) / 2
        + seriesIndex * (barWidth + barGap);
      const rawBarHeight = Math.abs(datum.value) / range * plotHeight;
      const barHeight = Math.max(2, rawBarHeight);
      const barY = datum.value >= 0
        ? (datum.value === 0 && baselineY <= plotTop ? baselineY : baselineY - barHeight)
        : baselineY;
      const safeBarY = Math.max(plotTop, Math.min(plotBottom - 2, barY));
      const safeBarHeight = Math.min(barHeight, plotBottom - safeBarY);
      elements.push(chartShape({
        id: `${slot.id}-bar-${seriesIndex}-${categoryIndex}`,
        x: round(barX),
        y: round(safeBarY),
        w: round(barWidth),
        h: round(Math.max(2, safeBarHeight)),
        shape: "rect",
        fill: seriesColors[seriesIndex % seriesColors.length]!,
        stroke: seriesColors[seriesIndex % seriesColors.length]!,
        strokeWidth: 0,
        radius: 0,
        zIndex: zIndex++,
        locked: slot.locked ?? false,
      }));
    });
  });

  const titleBox = chartText(
    `${slot.id}-title`,
    validatedSpec.title,
    slot.x + padding,
    slot.y + padding,
    plotWidth,
    titleHeight,
    Math.min(28, resolvedStyle.fontSize + 2),
    resolvedStyle.fontFamily,
    resolvedStyle.fontWeight,
    resolvedStyle.labelColor,
    "left",
    zIndex++,
    slot.locked ?? false,
  );
  elements.push(titleBox);

  validatedSpec.series.forEach((series, seriesIndex) => {
    const legendY = slot.y + padding + titleHeight + 4 + seriesIndex * legendRowHeight;
    const legendColor = seriesColors[seriesIndex % seriesColors.length]!;
    elements.push(chartShape({
      id: `${slot.id}-legend-swatch-${seriesIndex}`,
      x: slot.x + padding,
      y: round(legendY + (legendRowHeight - 10) / 2),
      w: 10,
      h: 10,
      shape: "rect",
      fill: legendColor,
      stroke: legendColor,
      strokeWidth: 0,
      radius: 0,
      zIndex: zIndex++,
      locked: slot.locked ?? false,
    }));
    elements.push(chartText(
      `${slot.id}-legend-${seriesIndex}`,
      series.label.value,
      slot.x + padding + 16,
      legendY,
      Math.max(2, slot.w - padding * 2 - 16),
      legendRowHeight,
      resolvedStyle.fontSize,
      resolvedStyle.fontFamily,
      resolvedStyle.fontWeight,
      resolvedStyle.labelColor,
      "left",
      zIndex++,
      slot.locked ?? false,
    ));
  });

  validatedSpec.series.forEach((series, seriesIndex) => {
    series.values.forEach((datum, categoryIndex) => {
      const categoryX = slot.x + padding + categoryIndex * categoryWidth;
      const barX = categoryX + (categoryWidth - innerCategoryWidth) / 2
        + seriesIndex * (barWidth + barGap);
      elements.push(chartText(
        `${slot.id}-value-${seriesIndex}-${categoryIndex}`,
        String(datum.value),
        round(barX),
        round(valueBandY),
        round(barWidth),
        valueLabelHeight,
        resolvedStyle.fontSize,
        resolvedStyle.fontFamily,
        resolvedStyle.fontWeight,
        resolvedStyle.valueColor,
        "center",
        zIndex++,
        slot.locked ?? false,
      ));
    });
  });

  validatedSpec.categories.forEach((category, categoryIndex) => {
    elements.push(chartText(
      `${slot.id}-category-${categoryIndex}`,
      category.value,
      round(slot.x + padding + categoryIndex * categoryWidth),
      round(plotBottom),
      round(categoryWidth),
      categoryLabelHeight,
      resolvedStyle.fontSize,
      resolvedStyle.fontFamily,
      resolvedStyle.fontWeight,
      resolvedStyle.labelColor,
      "center",
      zIndex++,
      slot.locked ?? false,
    ));
  });

  return elements;
}

function materializeFactBackedPieChart(
  spec: FactBackedChartSpec,
  slot: DataVisualChartLayoutSlot,
): CanvasElement[] {
  validateLayoutSlot(slot);
  if (!Number.isFinite(slot.x + slot.w) || !Number.isFinite(slot.y + slot.h)) {
    throw new DataVisualRendererError("invalid_layout_slot");
  }
  const series = spec.series[0];
  if (!series) throw new DataVisualRendererError("unsupported_chart_type");
  return [canvasPieChartSchema.parse({
    id: slot.id,
    type: "chart",
    chartType: "pie",
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.h,
    title: spec.title,
    categories: spec.categories,
    series,
    sourceRefs: spec.sourceRefs,
    zIndex: slot.zIndex,
    locked: slot.locked ?? false,
    sourceTemplateElementId: slot.sourceTemplateElementId,
  })];
}

/**
 * Convert one validated fact-backed diagram into a bounded native drawing.
 * Layout is derived only from the caller-owned slot and the stable semantic
 * order of nodes and edges; the data-visual spec supplies no coordinates.
 */
export function materializeFactBackedDiagram(
  spec: FactBackedDiagramSpec,
  slot: DataVisualLayoutSlot,
): CanvasElement[] {
  const validatedSpec = dataVisualSpecSchema.parse(spec);
  if (validatedSpec.visualType !== "diagram") {
    throw new DataVisualRendererError("unsupported_visual_type");
  }
  validateLayoutSlot(slot);

  const maxNodes = 12;
  const maxEdges = 24;
  if (validatedSpec.nodes.length > maxNodes || validatedSpec.edges.length > maxEdges) {
    throw new DataVisualRendererError("unsupported_diagram_capacity");
  }

  const padding = Math.max(8, Math.min(18, Math.min(slot.w, slot.h) * 0.04));
  const titleHeight = Math.max(20, Math.min(34, slot.h * 0.14));
  const bodyX = slot.x + padding;
  const bodyY = slot.y + padding + titleHeight;
  const bodyW = slot.w - padding * 2;
  const bodyH = slot.h - padding * 2 - titleHeight;
  const columns = Math.max(1, Math.ceil(Math.sqrt(validatedSpec.nodes.length)));
  const rows = Math.ceil(validatedSpec.nodes.length / columns);
  const cellW = bodyW / columns;
  const cellH = bodyH / rows;
  if (bodyW <= 0 || bodyH <= 0 || cellW < 40 || cellH < 30) {
    throw new DataVisualRendererError("unsupported_diagram_capacity");
  }

  const nodeW = Math.min(180, cellW * 0.72);
  const nodeH = Math.min(64, cellH * 0.52);
  if (nodeW < 28 || nodeH < 20) {
    throw new DataVisualRendererError("unsupported_diagram_capacity");
  }

  const resolvedNodeFill = "#FFFFFF";
  const resolvedNodeStroke = "#2F6FED";
  const resolvedEdgeColor = "#445566";
  const resolvedTextColor = "#1A1A1A";
  const elements: CanvasElement[] = [];
  let zIndex = slot.zIndex;

  elements.push(diagramShape({
    id: slot.id,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.h,
    shape: "rect",
    fill: "#FFFFFF",
    stroke: "#D7DEE7",
    strokeWidth: 1,
    radius: 0,
    zIndex: zIndex++,
    locked: slot.locked ?? false,
    sourceTemplateElementId: slot.sourceTemplateElementId,
  }));
  elements.push(diagramText(
    `${slot.id}-title`,
    validatedSpec.title,
    bodyX,
    slot.y + padding,
    bodyW,
    titleHeight,
    24,
    resolvedTextColor,
    "left",
    zIndex++,
    slot.locked ?? false,
  ));

  const nodeBoxes = validatedSpec.nodes.map((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = bodyX + column * cellW + (cellW - nodeW) / 2;
    const y = bodyY + row * cellH + (cellH - nodeH) / 2;
    return { node, x: round(x), y: round(y), w: round(nodeW), h: round(nodeH) };
  });
  const nodesById = new Map(nodeBoxes.map((box) => [box.node.id, box] as const));

  validatedSpec.edges.forEach((edge, edgeIndex) => {
    const from = nodesById.get(edge.fromId);
    const to = nodesById.get(edge.toId);
    if (!from || !to) {
      throw new DataVisualRendererError("unsupported_diagram_capacity");
    }
    const edgeId = `${slot.id}-edge-${edgeIndex}-${stableDiagramId(edge.fromId)}-${stableDiagramId(edge.toId)}`;
    routeDiagramEdge(from, to).forEach((segment, segmentIndex) => {
      elements.push(diagramShape({
        id: `${edgeId}-line${segmentIndex ? `-${segmentIndex}` : ""}`,
        x: segment.x,
        y: segment.y,
        w: segment.w,
        h: segment.h,
        shape: "line",
        fill: resolvedEdgeColor,
        stroke: resolvedEdgeColor,
        strokeWidth: 2,
        radius: 0,
        zIndex: zIndex++,
        locked: slot.locked ?? false,
      }));
    });
    if (edge.label) {
      const labelW = Math.min(140, Math.max(32, bodyW / Math.max(2, columns)));
      const labelH = Math.max(18, Math.min(30, cellH * 0.3));
      const labelBox = findDiagramEdgeLabelBox(
        from,
        to,
        labelW,
        labelH,
        bodyX,
        bodyY,
        bodyW,
        bodyH,
      );
      elements.push(diagramText(
        `${edgeId}-label`,
        edge.label.value,
        labelBox.x,
        labelBox.y,
        labelBox.w,
        labelBox.h,
        16,
        resolvedTextColor,
        "center",
        zIndex++,
        slot.locked ?? false,
      ));
    }
  });

  nodeBoxes.forEach(({ node, x, y, w, h }, nodeIndex) => {
    const nodeId = `${slot.id}-node-${nodeIndex}-${stableDiagramId(node.id)}`;
    elements.push(diagramShape({
      id: `${nodeId}-shape`,
      x,
      y,
      w,
      h,
      shape: "roundRect",
      fill: resolvedNodeFill,
      stroke: resolvedNodeStroke,
      strokeWidth: 2,
      radius: Math.min(12, h / 4),
      zIndex: zIndex++,
      locked: slot.locked ?? false,
    }));
    elements.push(diagramText(
      `${nodeId}-label`,
      node.label.value,
      x + 8,
      y + 6,
      Math.max(4, w - 16),
      Math.max(8, h - 12),
      18,
      resolvedTextColor,
      "center",
      zIndex++,
      slot.locked ?? false,
    ));
  });

  if (elements.length > 200) {
    throw new DataVisualRendererError("unsupported_diagram_capacity");
  }
  return elements;
}

function materializeFactBackedLineChart(
  spec: FactBackedChartSpec,
  slot: DataVisualChartLayoutSlot,
  style: Partial<DataVisualBarChartStyle>,
): CanvasElement[] {
  validateLayoutSlot(slot);

  const resolvedStyle = { ...DEFAULT_BAR_CHART_STYLE, ...style };
  const categoryCount = spec.categories.length;
  const seriesCount = spec.series.length;
  const lineCount = seriesCount * Math.max(0, categoryCount - 1);
  const pointCount = seriesCount * categoryCount;
  const expectedElementCount = 1 // panel
    + 2 // axes
    + 1 // title
    + seriesCount * 2 // legend swatches and labels
    + lineCount
    + pointCount
    + pointCount // value labels
    + categoryCount;
  if (expectedElementCount > 200) {
    throw new DataVisualRendererError("unsupported_chart_capacity");
  }

  const padding = Math.max(8, Math.min(16, Math.min(slot.w, slot.h) * 0.04));
  const titleHeight = Math.max(20, Math.min(32, slot.h * 0.12));
  const legendRowHeight = Math.max(18, Math.min(26, resolvedStyle.fontSize * 1.4));
  const legendHeight = legendRowHeight * seriesCount;
  const categoryLabelHeight = Math.max(22, Math.min(52, slot.h * 0.18));
  const plotTop = slot.y + padding + titleHeight + 4 + legendHeight + 8;
  const plotBottom = slot.y + slot.h - padding - categoryLabelHeight;
  const plotHeight = plotBottom - plotTop;
  const plotWidth = slot.w - padding * 2;
  if (plotWidth <= 0 || plotHeight < 32) {
    throw new DataVisualRendererError("unsupported_chart_capacity");
  }

  const categoryWidth = plotWidth / categoryCount;
  if (categoryWidth < 20) {
    throw new DataVisualRendererError("unsupported_chart_capacity");
  }

  const values = spec.series.flatMap((series) => series.values.map((datum) => datum.value));
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const range = maximum - minimum || 1;
  const pointX = (categoryIndex: number) => slot.x + padding + categoryWidth * (categoryIndex + 0.5);
  const pointY = (value: number) => plotTop + plotHeight * ((maximum - value) / range);
  const seriesColors = resolvedStyle.seriesColors.length
    ? resolvedStyle.seriesColors
    : DEFAULT_BAR_CHART_STYLE.seriesColors;
  const elements: CanvasElement[] = [];
  let zIndex = slot.zIndex;

  elements.push(chartShape({
    id: slot.id,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.h,
    shape: "rect",
    fill: resolvedStyle.panelFill,
    stroke: resolvedStyle.panelStroke,
    strokeWidth: 1,
    radius: 0,
    zIndex: zIndex++,
    locked: slot.locked ?? false,
    sourceTemplateElementId: slot.sourceTemplateElementId,
  }));
  elements.push(chartShape({
    id: `${slot.id}-y-axis`,
    x: round(slot.x + padding),
    y: round(plotTop),
    w: 1,
    h: round(plotHeight),
    shape: "line",
    fill: resolvedStyle.axisColor,
    stroke: resolvedStyle.axisColor,
    strokeWidth: 1,
    radius: 0,
    zIndex: zIndex++,
    locked: slot.locked ?? false,
  }));
  elements.push(chartShape({
    id: `${slot.id}-x-axis`,
    x: round(slot.x + padding),
    y: round(plotBottom),
    w: round(plotWidth),
    h: 1,
    shape: "line",
    fill: resolvedStyle.axisColor,
    stroke: resolvedStyle.axisColor,
    strokeWidth: 1,
    radius: 0,
    zIndex: zIndex++,
    locked: slot.locked ?? false,
  }));

  elements.push(chartText(
    `${slot.id}-title`,
    spec.title,
    slot.x + padding,
    slot.y + padding,
    plotWidth,
    titleHeight,
    Math.min(28, resolvedStyle.fontSize + 2),
    resolvedStyle.fontFamily,
    resolvedStyle.fontWeight,
    resolvedStyle.labelColor,
    "left",
    zIndex++,
    slot.locked ?? false,
  ));

  spec.series.forEach((series, seriesIndex) => {
    const legendY = slot.y + padding + titleHeight + 4 + seriesIndex * legendRowHeight;
    const legendColor = seriesColors[seriesIndex % seriesColors.length]!;
    elements.push(chartShape({
      id: `${slot.id}-legend-swatch-${seriesIndex}`,
      x: slot.x + padding,
      y: round(legendY + (legendRowHeight - 10) / 2),
      w: 10,
      h: 10,
      shape: "ellipse",
      fill: legendColor,
      stroke: legendColor,
      strokeWidth: 0,
      radius: 0,
      zIndex: zIndex++,
      locked: slot.locked ?? false,
    }));
    elements.push(chartText(
      `${slot.id}-legend-${seriesIndex}`,
      series.label.value,
      slot.x + padding + 16,
      legendY,
      Math.max(2, slot.w - padding * 2 - 16),
      legendRowHeight,
      resolvedStyle.fontSize,
      resolvedStyle.fontFamily,
      resolvedStyle.fontWeight,
      resolvedStyle.labelColor,
      "left",
      zIndex++,
      slot.locked ?? false,
    ));
  });

  spec.series.forEach((series, seriesIndex) => {
    const color = seriesColors[seriesIndex % seriesColors.length]!;
    series.values.forEach((datum, categoryIndex) => {
      const x = pointX(categoryIndex);
      const y = pointY(datum.value);
      const pointRadius = Math.max(3, Math.min(6, categoryWidth * 0.12, plotHeight * 0.04));
      elements.push(chartShape({
        id: `${slot.id}-point-${seriesIndex}-${categoryIndex}`,
        x: round(x - pointRadius),
        y: round(y - pointRadius),
        w: round(pointRadius * 2),
        h: round(pointRadius * 2),
        shape: "ellipse",
        fill: color,
        stroke: color,
        strokeWidth: 0,
        radius: 0,
        zIndex: zIndex++,
        locked: slot.locked ?? false,
      }));
      const labelWidth = Math.max(20, Math.min(categoryWidth, 72));
      const labelX = Math.max(slot.x + padding, Math.min(x - labelWidth / 2, slot.x + slot.w - padding - labelWidth));
      const labelHeight = Math.max(18, Math.min(24, resolvedStyle.fontSize * 1.25));
      const labelY = y - pointRadius - labelHeight - 2 >= plotTop
        ? y - pointRadius - labelHeight - 2
        : Math.min(plotBottom - labelHeight - 2, y + pointRadius + 2);
      elements.push(chartText(
        `${slot.id}-value-${seriesIndex}-${categoryIndex}`,
        String(datum.value),
        round(labelX),
        round(labelY),
        round(labelWidth),
        round(labelHeight),
        Math.min(resolvedStyle.fontSize, 16),
        resolvedStyle.fontFamily,
        resolvedStyle.fontWeight,
        resolvedStyle.valueColor,
        "center",
        zIndex++,
        slot.locked ?? false,
      ));

      if (categoryIndex === 0) return;
      const previousX = pointX(categoryIndex - 1);
      const previousY = pointY(series.values[categoryIndex - 1]!.value);
      elements.push(chartShape({
        id: `${slot.id}-line-${seriesIndex}-${categoryIndex - 1}`,
        x: round(Math.min(previousX, x)),
        y: round(Math.min(previousY, y)),
        w: round(Math.abs(x - previousX)),
        h: round(Math.max(1, Math.abs(y - previousY))),
        shape: "line",
        fill: color,
        stroke: color,
        strokeWidth: 2,
        radius: 0,
        zIndex: zIndex++,
        locked: slot.locked ?? false,
      }));
    });
  });

  spec.categories.forEach((category, categoryIndex) => {
    elements.push(chartText(
      `${slot.id}-category-${categoryIndex}`,
      category.value,
      round(slot.x + padding + categoryIndex * categoryWidth),
      round(plotBottom),
      round(categoryWidth),
      categoryLabelHeight,
      resolvedStyle.fontSize,
      resolvedStyle.fontFamily,
      resolvedStyle.fontWeight,
      resolvedStyle.labelColor,
      "center",
      zIndex++,
      slot.locked ?? false,
    ));
  });

  return elements;
}

/** Explicit alias for callers that only opt into the currently supported bar path. */
export const materializeFactBackedBarChart = materializeFactBackedChart;

function validateLayoutSlot(slot: DataVisualLayoutSlot) {
  if (!Number.isFinite(slot.x) || !Number.isFinite(slot.y)
    || !Number.isFinite(slot.w) || !Number.isFinite(slot.h)
    || !Number.isInteger(slot.zIndex) || slot.w <= 0 || slot.h <= 0 || slot.zIndex < 0) {
    throw new DataVisualRendererError("invalid_layout_slot");
  }
}

function chartShape(element: Omit<Extract<CanvasElement, { type: "shape" }>, "type">) {
  return canvasElementSchema.parse({ ...element, type: "shape" }) as Extract<CanvasElement, { type: "shape" }>;
}

function diagramShape(element: Omit<Extract<CanvasElement, { type: "shape" }>, "type">) {
  return canvasElementSchema.parse({ ...element, type: "shape" }) as Extract<CanvasElement, { type: "shape" }>;
}

function routeDiagramEdge(from: DiagramNodeBox, to: DiagramNodeBox) {
  const fromCenterX = from.x + from.w / 2;
  const fromCenterY = from.y + from.h / 2;
  const toCenterX = to.x + to.w / 2;
  const toCenterY = to.y + to.h / 2;
  const sameRow = fromCenterY === toCenterY;
  const sameColumn = fromCenterX === toCenterX;

  if (sameRow) {
    return [diagramLineSegment(
      fromCenterX,
      fromCenterY,
      toCenterX,
      toCenterY,
    )];
  }
  if (sameColumn) {
    return [diagramLineSegment(
      fromCenterX,
      fromCenterY,
      toCenterX,
      toCenterY,
    )];
  }

  const bendY = round((fromCenterY + toCenterY) / 2);
  return [
    diagramLineSegment(fromCenterX, fromCenterY, fromCenterX, bendY),
    diagramLineSegment(fromCenterX, bendY, toCenterX, bendY),
    diagramLineSegment(toCenterX, bendY, toCenterX, toCenterY),
  ];
}

function diagramLineSegment(x1: number, y1: number, x2: number, y2: number) {
  const horizontal = y1 === y2;
  return {
    x: round(horizontal ? Math.min(x1, x2) : x1),
    y: round(horizontal ? y1 : Math.min(y1, y2)),
    w: round(horizontal ? Math.max(1, Math.abs(x2 - x1)) : 1),
    h: round(horizontal ? 1 : Math.max(1, Math.abs(y2 - y1))),
  };
}

function findDiagramEdgeLabelBox(
  from: DiagramNodeBox,
  to: DiagramNodeBox,
  w: number,
  h: number,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
) {
  const centerX = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
  const centerY = (from.y + from.h / 2 + to.y + to.h / 2) / 2;
  const candidates = [
    { x: centerX - w / 2, y: centerY - h / 2 },
    { x: centerX - w / 2, y: Math.min(from.y, to.y) - h - 4 },
    { x: centerX - w / 2, y: Math.max(from.y + from.h, to.y + to.h) + 4 },
    { x: Math.min(from.x, to.x) - w - 4, y: centerY - h / 2 },
    { x: Math.max(from.x + from.w, to.x + to.w) + 4, y: centerY - h / 2 },
  ];
  for (const candidate of candidates) {
    const box = {
      x: round(clamp(candidate.x, bodyX, bodyX + bodyW - w)),
      y: round(clamp(candidate.y, bodyY, bodyY + bodyH - h)),
      w: round(w),
      h: round(h),
    };
    if (!overlapsDiagramBox(box, from) && !overlapsDiagramBox(box, to)) return box;
  }
  const fallback = candidates[0]!;
  return {
    x: round(clamp(fallback.x, bodyX, bodyX + bodyW - w)),
    y: round(clamp(fallback.y, bodyY, bodyY + bodyH - h)),
    w: round(w),
    h: round(h),
  };
}

function overlapsDiagramBox(left: DiagramNodeBox, right: DiagramNodeBox) {
  return left.x < right.x + right.w && left.x + left.w > right.x
    && left.y < right.y + right.h && left.y + left.h > right.y;
}

function chartText(
  id: string,
  value: string,
  x: number,
  y: number,
  w: number,
  h: number,
  preferredFontSize: number,
  fontFamily: string,
  fontWeight: number,
  color: string,
  align: "left" | "center" | "right",
  zIndex: number,
  locked: boolean,
) {
  let fontSize = Math.max(14, Math.round(preferredFontSize));
  let measurement = measureTextForBox(value, fontSize, w);
  while (fontSize > 14 && measurement.height > h) {
    fontSize -= 1;
    measurement = measureTextForBox(value, fontSize, w);
  }
  if (measurement.height > h) {
    throw new DataVisualRendererError("unsupported_chart_capacity");
  }
  return canvasElementSchema.parse({
    id,
    type: "text",
    x: round(x),
    y: round(y),
    w: round(w),
    h: round(h),
    text: measurement.wrappedText,
    fontFamily,
    fontSize,
    fontWeight: Math.round(fontWeight),
    color,
    align,
    zIndex,
    locked,
  }) as Extract<CanvasElement, { type: "text" }>;
}

function diagramText(
  id: string,
  value: string,
  x: number,
  y: number,
  w: number,
  h: number,
  preferredFontSize: number,
  color: string,
  align: "left" | "center" | "right",
  zIndex: number,
  locked: boolean,
) {
  let fontSize = Math.max(14, Math.round(preferredFontSize));
  let measurement = measureTextForBox(value, fontSize, w);
  while (fontSize > 14 && measurement.height > h) {
    fontSize -= 1;
    measurement = measureTextForBox(value, fontSize, w);
  }
  if (measurement.height > h) {
    throw new DataVisualRendererError("unsupported_diagram_capacity");
  }
  return canvasElementSchema.parse({
    id,
    type: "text",
    x: round(x),
    y: round(y),
    w: round(w),
    h: round(h),
    text: measurement.wrappedText,
    fontFamily: "Arial",
    fontSize,
    fontWeight: 600,
    color,
    align,
    zIndex,
    locked,
  }) as Extract<CanvasElement, { type: "text" }>;
}

function stableDiagramId(value: string) {
  return value.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || "item";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function tableCell(
  text: string,
  style: DataVisualTableStyle,
  align: "left" | "center" | "right",
  header: boolean,
) {
  return {
    text,
    fill: header ? style.headerFill : style.bodyFill,
    color: header ? style.headerColor : style.bodyColor,
    align,
    border: {
      color: style.borderColor,
      width: style.borderWidth,
    },
  };
}

function datumText(datum: { value: number | string }) {
  return typeof datum.value === "number" ? String(datum.value) : datum.value;
}
