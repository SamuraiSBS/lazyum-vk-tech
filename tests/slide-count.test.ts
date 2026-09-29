import { describe, expect, it } from "vitest";
import { resolveEffectiveSlideCount } from "../src/lib/slide-count";

describe("resolveEffectiveSlideCount", () => {
  it.each([
    ["Сделай 7 слайдов о сервисе", 7],
    ["Подготовь презентацию на семь слайдов", 7],
    ["Prepare a presentation with seven slides", 7],
    ["Слайдов: 15", 15],
  ] as const)("uses one explicit in-range count from %s", (brief, expectedCount) => {
    expect(resolveEffectiveSlideCount(brief, 10)).toEqual({
      count: expectedCount,
      source: "brief",
    });
  });

  it("accepts the same count when it is repeated", () => {
    expect(resolveEffectiveSlideCount("7 слайдов. Повтор: семь слайдов.", 10)).toEqual({
      count: 7,
      source: "brief",
    });
  });

  it.each([
    ["7 идей для проекта"],
    ["Нужно от 7 до 10 слайдов"],
    ["Нужно 7–10 слайдов"],
    ["7 слайдов или 10 слайдов"],
    ["Сделай семь или десять слайдов"],
    ["Подготовь 20 слайдов"],
    ["Подготовь шестнадцать слайдов"],
  ] as const)("falls back to the selected count for %s", (brief) => {
    expect(resolveEffectiveSlideCount(brief, 10)).toEqual({
      count: 10,
      source: "selection",
    });
  });

  it("retains the selected count when the brief has no explicit count", () => {
    expect(resolveEffectiveSlideCount("Питч сервиса для команды продукта", 12)).toEqual({
      count: 12,
      source: "selection",
    });
  });

  it("recognizes the supported lower boundary", () => {
    expect(resolveEffectiveSlideCount("five slides", 10)).toEqual({
      count: 5,
      source: "brief",
    });
  });
});
