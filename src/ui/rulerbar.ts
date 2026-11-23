// The Ruler tool's options bar, kept out of main.ts for the coupling pin.
// It receives numbers, never the document: measuring is read-only, and the bar
// is a view of two points the shell already converted.
export interface RulerMeasure {
  /** signed delta in document pixels, right/down positive */
  dx: number;
  dy: number;
  /** the length of the segment, always >= 0 */
  distance: number;
  /** counter-clockwise from +x in degrees, as Photoshop reports it */
  angle: number;
}

export function buildRulerOptions(
  bar: HTMLElement,
  measure: RulerMeasure | null,
  onClear: () => void,
): void {
  if (!measure) return;
  // finalizeOptionsBar files every .label into the help panel, so a readout
  // that must stay in the bar is not a .label.
  const chip = (text: string): void => {
    const s = document.createElement("span");
    s.className = "opt-read";
    s.textContent = text;
    bar.appendChild(s);
  };
  chip(`W: ${measure.dx.toFixed(1)}`);
  chip(`H: ${measure.dy.toFixed(1)}`);
  chip(`D: ${measure.distance.toFixed(1)} px`);
  chip(`A: ${measure.angle.toFixed(1)}°`);
  const clear = document.createElement("button");
  clear.className = "btn subtle";
  clear.textContent = "Clear";
  clear.addEventListener("click", onClear);
  bar.appendChild(clear);
}
