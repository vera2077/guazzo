/**
 * The Histogram card: the composite's channel distribution, drawn once per
 * composite generation rather than per frame (a 16 MP document is 64 MB to walk).
 */
import type { Histogram } from "../engine/histogram.ts";

export interface HistogramPanelDeps {
  host: HTMLElement;
  /** false while the card is collapsed or the panels are hidden */
  visible(): boolean;
  /** the current composite, or null before one exists */
  composite(): { width: number; height: number; generation: number; stamp: number; data: Uint8ClampedArray } | null;
  histogramOf(data: Uint8ClampedArray): Histogram;
}

const HIST_W = 236;
const HIST_H = 92;

export function buildHistogramPanel(d: HistogramPanelDeps): () => void {
  const wrap = document.createElement("div");
  wrap.className = "hist-panel";
  const canvas = document.createElement("canvas");
  canvas.width = HIST_W;
  canvas.height = HIST_H;
  canvas.className = "hist-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Composite histogram, red green and blue channels");
  const stats = document.createElement("div");
  stats.className = "hist-stats";
  // Not a live region: it is rewritten on every recomposite, i.e. every
  // pointermove of a stroke, and it drowned the status bar's own live region
  // (uiux-r24 #3). The numbers are readable by navigating to the card.
  wrap.append(canvas, stats);
  d.host.appendChild(wrap);

  const keyOf = (img: { width: number; height: number; generation: number; stamp: number } | null): string =>
    img ? `${img.width}x${img.height}:${img.generation}:${img.stamp}` : "";

  let lastKey = "";
  let pending: ReturnType<typeof setTimeout> | null = null;
  // A 16 MP walk is 64 MB; measure once the stroke pauses instead of on every
  // paint frame. Small documents stay synchronous (the smoke test observes the
  // stats right after a fill).
  const COALESCE_PIXELS = 4_000_000;

  const paint = (img: { width: number; height: number; generation: number; stamp: number; data: Uint8ClampedArray } | null): void => {
    lastKey = keyOf(img);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, HIST_W, HIST_H);
    if (!img) {
      stats.textContent = "Nothing to measure yet.";
      return;
    }
    const h = d.histogramOf(img.data);
    ctx.fillStyle = "#11161d";
    ctx.fillRect(0, 0, HIST_W, HIST_H);
    if (h.count === 0 || h.peak === 0) {
      stats.textContent = "The composite is empty.";
      return;
    }
    const bars = (buckets: Uint32Array, colour: string): void => {
      ctx.fillStyle = colour;
      const bw = Math.max(1, Math.ceil(HIST_W / 256));
      for (let i = 0; i < 256; i++) {
        // sqrt keeps the tails readable without hiding the peak
        const v = Math.sqrt(buckets[i]! / h.peak);
        const bh = Math.round(v * (HIST_H - 2));
        if (bh > 0) ctx.fillRect(Math.round((i * HIST_W) / 256), HIST_H - bh, bw, bh);
      }
    };
    bars(h.r, "rgba(255, 92, 92, 0.45)");
    bars(h.g, "rgba(92, 255, 132, 0.40)");
    bars(h.b, "rgba(92, 148, 255, 0.45)");
    // The luma outline is what a photographer reads first: where the mass sits.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const v = Math.sqrt(h.luma[i]! / h.peak);
      const y = HIST_H - 1 - v * (HIST_H - 2);
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo((i * HIST_W) / 256, y);
    }
    ctx.stroke();
    const pct = (v: number): string => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
    stats.textContent =
      `mean ${h.mean.toFixed(0)} · shadows ${pct(h.clippedShadows)} · highlights ${pct(h.clippedHighlights)}`;
  };

  return (): void => {
    // render() calls this on every pointermove: the generation covers a
    // document swap and the stamp covers every recomposite, so a brush stroke
    // cannot leave the graph describing the previous frame (uiux-r23 #2).
    if (!d.visible()) return;
    const img = d.composite();
    const key = keyOf(img);
    if (key === lastKey) return;
    if (img && img.width * img.height > COALESCE_PIXELS) {
      if (pending) return;
      lastKey = key;
      pending = setTimeout(() => {
        pending = null;
        paint(d.composite());
      }, 150);
      return;
    }
    paint(img);
  };
}
