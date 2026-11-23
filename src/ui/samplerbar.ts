// The Color Sampler's options bar, extracted from main.ts (coupling pin).
// It receives the pixels and the points rather than reaching for the document:
// the bar is a view, and the only state it owns is the DOM it builds.
import { sampleColor } from "../engine/retouch.ts";

export interface SamplerImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function buildSamplerOptions(
  bar: HTMLElement,
  image: SamplerImage,
  points: readonly (readonly [number, number])[],
  hex: (rgb: [number, number, number]) => string,
  onClear: () => void,
): void {
  for (let i = 0; i < points.length; i++) {
    const [sx, sy] = points[i]!;
    const s = sampleColor(image, sx, sy, 1);
    const chip = document.createElement("span");
    chip.className = "opt-read";
    if (s) {
      const sw = document.createElement("span");
      sw.style.cssText = `display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px;border:1px solid var(--stroke-strong);background:${hex([s.r, s.g, s.b])}`;
      chip.appendChild(sw);
      chip.appendChild(document.createTextNode(`${i + 1}: ${sx}, ${sy} ${hex([s.r, s.g, s.b])}`));
    } else {
      chip.textContent = `${i + 1}: ${sx}, ${sy}`;
    }
    bar.appendChild(chip);
  }
  const clear = document.createElement("button");
  clear.className = "btn subtle";
  clear.textContent = points.length === 0 ? "No samples" : "Clear Samples";
  clear.disabled = points.length === 0;
  clear.addEventListener("click", onClear);
  bar.appendChild(clear);
  const hint = document.createElement("span");
  hint.className = "label";
  hint.textContent = points.length === 0
    ? "Click the canvas to place a sample (four maximum) · Alt-click clears them"
    : "Alt-click the canvas to clear every sample";
  bar.appendChild(hint);
}
