import { describe, expect, it } from "vitest";
import { auditCanvas } from "../src/lib/audit";
import type { DesignSystem, SlideCanvas } from "../src/lib/schemas";

const design: DesignSystem = {
  version: 1,
  sourceName: "title-body-collision.pptx",
  slideSize: { width: 960, height: 540, aspectRatio: 1.778 },
  colors: ["#000000", "#FFFFFF"],
  typography: { headingFonts: ["Arial"], bodyFonts: ["Arial"], fontSizes: [17, 32], fontWeights: [400, 700] },
  spacing: { horizontalMargins: [19], verticalMargins: [30], gaps: [16] },
  shapes: { types: ["shape"], radii: [], strokes: ["#000000"] },
  masters: [],
  layouts: [{
    id: "title-body-layout", name: "Title body", source: "layout", sourceFile: "fixture",
    width: 960, height: 540, elements: [], textSlots: 2, placeholderCount: 0, visualSlots: 0, cardCount: 0,
    composition: "text", recurringElementIds: [],
  }],
  recurringElements: [],
  visualPatterns: [],
  warnings: [],
};

function text(id: string, textValue: string, fontSize: number, fontWeight: number) {
  return {
    id,
    type: "text" as const,
    x: 19,
    y: 30,
    w: 713,
    h: 76,
    text: textValue,
    fontFamily: "Arial",
    fontSize,
    fontWeight,
    color: "#FFFFFF",
    align: "left" as const,
    zIndex: 1,
    locked: false,
  };
}

describe("title/body render audit", () => {
  it("makes the saved Balanced slide 5 title/body geometry fatal", () => {
    const canvas: SlideCanvas = {
      width: 960,
      height: 540,
      background: "#000000",
      elements: [
        text("5-text-0", "Предлагаемое решение", 32, 700),
        text("5-text-1", "• Цифровой сервис для планирования\n• Интуитивно понятный интерфейс\n• Интеграция с учебным процессом", 17, 400),
      ],
    };

    expect(auditCanvas(canvas, design)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "ELEMENT_OVERLAP",
        severity: "error",
        elementId: "5-text-0",
        message: "Element overlaps 5-text-1",
      }),
    ]));
  });

  it("keeps text fully contained by a background shape out of overlap findings", () => {
    const canvas: SlideCanvas = {
      width: 960,
      height: 540,
      background: "#000000",
      elements: [{
        id: "background-card",
        type: "shape",
        x: 0,
        y: 0,
        w: 800,
        h: 180,
        shape: "rect",
        fill: "#000000",
        stroke: "#000000",
        strokeWidth: 0,
        radius: 0,
        zIndex: 0,
        locked: true,
      }, {
        ...text("title", "Допустимый текст на фоне", 32, 700),
        x: 30,
        y: 40,
        w: 640,
      }],
    };

    expect(auditCanvas(canvas, design)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ELEMENT_OVERLAP" }),
    ]));
  });
});
