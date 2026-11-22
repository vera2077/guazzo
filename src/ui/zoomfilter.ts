/**
 * Choosing how to resample the composite on the way to the screen.
 *
 * The viewport draws a document-sized canvas into a device-pixel canvas, so the
 * effective scale is `zoom * devicePixelRatio`. Two things looked wrong before
 * this existed:
 *
 *  - smoothing was off at every zoom, so 93 % dropped one row in fourteen and
 *    thin strokes and small text looked chewed rather than merely soft;
 *  - at 100 % on a 125 % or 150 % display the fraction (0.8 or 1.5) resampled
 *    with nearest-neighbour, which is the "why is everything low-res" report.
 *
 * The rule is the one an editor should have: nearest-neighbour only when one
 * image pixel maps to a whole number of device pixels (100 %, 200 %, 300 % on
 * a 100 % display), because that is exactly when nearest is lossless. Every
 * other ratio is a genuine resample and gets the high-quality filter.
 */

/** Device pixels per document pixel at this zoom on this display. */
export function deviceScale(zoom: number, dpr: number): number {
  const z = Number.isFinite(zoom) ? zoom : 1;
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return z * d;
}

/**
 * True when nearest-neighbour is lossless: the device scale is an integer.
 * `tolerance` absorbs floating-point drift (1/3 * 3 is 1.0000000000000002 on
 * some zoom steps), not sloppiness — a 7 % downscale must never be called crisp.
 */
export function isCrispZoom(zoom: number, dpr: number, tolerance = 0.01): boolean {
  // A non-finite or zero zoom is a bug upstream; report "not crisp" so the
  // caller keeps the smoothing filter rather than silently drawing 1:1.
  if (!Number.isFinite(zoom) || zoom <= 0) return false;
  const s = deviceScale(zoom, dpr);
  if (!(s > 0)) return false;
  return Math.abs(s - Math.round(s)) <= tolerance;
}

/** Whether the canvas should smooth: the complement of `isCrispZoom`. */
export function shouldSmooth(zoom: number, dpr: number, tolerance = 0.01): boolean {
  return !isCrispZoom(zoom, dpr, tolerance);
}
