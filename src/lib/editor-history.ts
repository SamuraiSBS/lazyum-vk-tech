import type { LayoutVariant, PresentationDocument } from "@/lib/schemas";

export const EDITOR_HISTORY_LIMIT = 30;

export type DocumentHistory = {
  initial: PresentationDocument;
  past: PresentationDocument[];
  present: PresentationDocument;
  future: PresentationDocument[];
};

export type VariantHistories = Partial<Record<LayoutVariant, DocumentHistory>>;

export function startHistory(document: PresentationDocument): DocumentHistory {
  return { initial: document, past: [], present: document, future: [] };
}

export function recordHistory(
  history: DocumentHistory,
  document: PresentationDocument,
  limit = EDITOR_HISTORY_LIMIT,
): DocumentHistory {
  if (JSON.stringify(history.present) === JSON.stringify(document)) return history;
  return {
    ...history,
    past: [...history.past, history.present].slice(-Math.max(1, limit)),
    present: document,
    future: [],
  };
}

export function travelHistory(history: DocumentHistory, direction: "undo" | "redo"): DocumentHistory {
  if (direction === "undo") {
    if (!history.past.length) return history;
    return {
      ...history,
      past: history.past.slice(0, -1),
      present: history.past[history.past.length - 1],
      future: [history.present, ...history.future],
    };
  }
  if (!history.future.length) return history;
  return {
    ...history,
    past: [...history.past, history.present].slice(-EDITOR_HISTORY_LIMIT),
    present: history.future[0],
    future: history.future.slice(1),
  };
}

export function isHistoryAtInitial(history: DocumentHistory): boolean {
  return JSON.stringify(history.present) === JSON.stringify(history.initial);
}

export function editorShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "target">,
): "undo" | "redo" | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return null;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable], [role='textbox']")) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}
