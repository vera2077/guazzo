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
  composite(): { width: number; height: number; generation: number; data: Uint8ClampedArray } | null;
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
  stats.setAttribute("role", "status");
  wrap.append(canvas, stats);
  d.host.appendChild(wrap);

  const keyOf = (img: { width: number; height: number; generation: number } | null): string =>
    img ? `${img.width}x${img.height}:${img.generation}` : "";

  let lastKey = "";
  return (): void => {
    // Cheap guard: render() calls this on every pointermove, but the cache's
    // generation only moves when the composite changed.
    if (!d.visible()) return;
    const img = d.composite();
    const key = keyOf(img);
    if (key === lastKey) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, HIST_W, HIST_H);
    if (!img) {
      stats.textContent = "Nothing to measure yet.";
      lastKey = key;
      return;
    }
    lastKey = key;
    const h = d.histogramOf(img.data);
    ctx.fillStyle = "#11161d";
    ctx.fillRect(0, 0, HIST_W, HIST_H);
    if (h.count === 0 || h.peak === 0) {
      stats.textContent = "The composite is empty.";
      return;
    }
    const draw = (buckets: Uint32Array, colour: string): void => {
      ctx.fillStyle = colour;
      const bw = Math.max(1, Math.ceil(HIST_W / 256));
      for (let i = 0; i < 256; i++) {
        // sqrt keeps the tails readable without hiding the peak
        const v = Math.sqrt(buckets[i]! / h.peak);
        const bh = Math.round(v * (HIST_H - 2));
        if (bh > 0) ctx.fillRect(Math.round((i * HIST_W) / 256), HIST_H - bh, bw, bh);
      }
    };
    draw(h.r, "rgba(255, 92, 92, 0.45)");
    draw(h.g, "rgba(92, 255, 132, 0.40)");
    draw(h.b, "rgba(92, 148, 255, 0.45)");
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
}
