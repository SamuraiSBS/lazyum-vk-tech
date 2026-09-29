import { describe, expect, it } from "vitest";
import {
  EDITOR_HISTORY_LIMIT,
  isHistoryAtInitial,
  recordHistory,
  startHistory,
  travelHistory,
} from "../src/lib/editor-history";
import type { LayoutVariant, PresentationDocument } from "../src/lib/schemas";

function document(variant: LayoutVariant, text: string): PresentationDocument {
  return { variant, slides: [{ canvas: { elements: [{ text }] } }] } as PresentationDocument;
}

describe("editor document history", () => {
  it("restores content, clears redo on edit, and detects return to the published baseline", () => {
    const initial = document("balanced", "published");
    const first = recordHistory(startHistory(initial), document("balanced", "edited"));
    expect(first.past).toHaveLength(1);
    expect(isHistoryAtInitial(first)).toBe(false);
    const undone = travelHistory(first, "undo");
    expect(undone.present).toEqual(initial);
    expect(isHistoryAtInitial(undone)).toBe(true);
    expect(travelHistory(undone, "redo").present.slides[0].canvas.elements[0]).toMatchObject({ text: "edited" });
    const replacement = recordHistory(undone, document("balanced", "different"));
    expect(replacement.future).toEqual([]);
    expect(travelHistory(replacement, "redo")).toBe(replacement);
    expect(recordHistory(replacement, document("balanced", "different"))).toBe(replacement);
  });

  it("bounds snapshots and leaves separately stored variant histories intact", () => {
    let balanced = startHistory(document("balanced", "0"));
    const visual = startHistory(document("visual", "visual"));
    for (let index = 1; index <= EDITOR_HISTORY_LIMIT + 4; index++) {
      balanced = recordHistory(balanced, document("balanced", String(index)));
    }
    expect(balanced.past).toHaveLength(EDITOR_HISTORY_LIMIT);
    expect(balanced.past[0].slides[0].canvas.elements[0]).toMatchObject({ text: "4" });
    expect(visual.present.slides[0].canvas.elements[0]).toMatchObject({ text: "visual" });
    expect(startHistory(document("balanced", "new job")).past).toEqual([]);
  });
});
