export type PieChartSectorGeometry = {
  categoryIndex: number;
  path: string;
  color: string;
};

const PIE_CHART_PALETTE = [
  "#2F6FED",
  "#F28E2B",
  "#59A14F",
  "#E15759",
  "#B279A2",
  "#76B7B2",
  "#EDC948",
  "#FF9DA7",
  "#9C755F",
  "#BAB0AC",
  "#4E79A7",
  "#AF7AA1",
] as const;

const CENTER = 50;
const RADIUS = 46;
const START_ANGLE = -Math.PI / 2;
const FULL_CIRCLE = Math.PI * 2;

/** Returns deterministic colors in input category order. */
export function pieChartColors(count: number): string[] {
  if (!Number.isInteger(count) || count < 0 || count > 100) {
    throw new RangeError("Pie chart color count must be an integer from 0 to 100");
  }
  return Array.from({ length: count }, (_, index) => PIE_CHART_PALETTE[index % PIE_CHART_PALETTE.length]!);
}

/**
 * Build inline-SVG sector paths. Zero-valued categories intentionally have no
 * path, while their original indices remain stable for the accompanying data
 * table and native PowerPoint chart.
 */
export function createPieChartSectorGeometry(values: readonly number[]): PieChartSectorGeometry[] {
  if (values.length < 1 || values.length > 100
    || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("Pie chart values must be 1 to 100 finite non-negative numbers");
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new RangeError("Pie chart values must have a finite positive sum");
  }

  let lastPositiveIndex = -1;
  values.forEach((value, index) => {
    if (value > 0) lastPositiveIndex = index;
  });
  let startAngle = START_ANGLE;
  const colors = pieChartColors(values.length);

  return values.flatMap((value, categoryIndex) => {
    if (value === 0) return [];
    const endAngle = categoryIndex === lastPositiveIndex
      ? START_ANGLE + FULL_CIRCLE
      : startAngle + (value / total) * FULL_CIRCLE;
    const path = sectorPath(startAngle, endAngle);
    startAngle = endAngle;
    return [{ categoryIndex, path, color: colors[categoryIndex]! }];
  });
}

function sectorPath(startAngle: number, endAngle: number) {
  const sweep = endAngle - startAngle;
  const start = pointOnCircle(startAngle);
  if (sweep >= FULL_CIRCLE - 1e-10) {
    const opposite = pointOnCircle(startAngle + Math.PI);
    return `M ${number(CENTER)} ${number(CENTER)} L ${number(start.x)} ${number(start.y)} A ${number(RADIUS)} ${number(RADIUS)} 0 0 1 ${number(opposite.x)} ${number(opposite.y)} A ${number(RADIUS)} ${number(RADIUS)} 0 0 1 ${number(start.x)} ${number(start.y)} Z`;
  }
  const end = pointOnCircle(endAngle);
  const largeArc = sweep > Math.PI ? 1 : 0;
  return `M ${number(CENTER)} ${number(CENTER)} L ${number(start.x)} ${number(start.y)} A ${number(RADIUS)} ${number(RADIUS)} 0 ${largeArc} 1 ${number(end.x)} ${number(end.y)} Z`;
}

function pointOnCircle(angle: number) {
  return {
    x: CENTER + Math.cos(angle) * RADIUS,
    y: CENTER + Math.sin(angle) * RADIUS,
  };
}

function number(value: number) {
  return String(Number(value.toFixed(4)));
}
