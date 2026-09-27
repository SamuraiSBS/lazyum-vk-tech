// Adapted from Lazyum's project-editor geometry helpers. Kept local so the
// hackathon app remains runnable without importing the production web app.
export function clampToCanvas(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function clientDeltaToCanvas(
  start: { x: number; y: number },
  current: { x: number; y: number },
  canvas: { width: number; height: number },
  frame: DOMRect,
) {
  return {
    x: (current.x - start.x) * canvas.width / frame.width,
    y: (current.y - start.y) * canvas.height / frame.height,
  };
}
