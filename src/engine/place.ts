/**
 * place.ts — where a dropped image lands on the canvas.
 *
 * Placement never upscales: a small image keeps its pixels and sits centred,
 * a large one is scaled down to fit. The arithmetic is here rather than in the
 * drop handler so it can be tested without a DOM.
 */

export interface PlaceRect {
  /** top-left in document pixels */
  x: number;
  y: number;
  /** size in document pixels, never larger than the source */
  w: number;
  h: number;
  /** 1 = pixels copied as they are; below 1 = resampled down */
  scale: number;
}

/** fit `imgW × imgH` inside `docW × docH`, centred, never enlarging */
export function placeRect(imgW: number, imgH: number, docW: number, docH: number): PlaceRect {
  const sw = Math.max(1, Math.round(imgW) || 1);
  const sh = Math.max(1, Math.round(imgH) || 1);
  const dw = Math.max(1, Math.round(docW) || 1);
  const dh = Math.max(1, Math.round(docH) || 1);
  const scale = Math.min(1, dw / sw, dh / sh);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  return {
    x: Math.floor((dw - w) / 2),
    y: Math.floor((dh - h) / 2),
    w,
    h,
    scale,
  };
}
