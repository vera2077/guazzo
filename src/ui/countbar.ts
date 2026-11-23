/** Options bar for the Count tool: how many markers, and a way to clear them.
 *  Counts are annotations on the view, like Photoshop's; they are not pixels
 *  and not part of the document, so the bar says so rather than implying the
 *  markers are saved with the file. */
export function buildCountOptions(bar: HTMLElement, count: number, onClear: () => void): void {
  const chip = document.createElement("span");
  chip.className = "opt-read";
  chip.textContent = count === 1 ? "1 marker" : `${count} markers`;
  bar.appendChild(chip);

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn";
  clear.textContent = "Clear Counts";
  clear.disabled = count === 0;
  clear.addEventListener("click", onClear);
  bar.appendChild(clear);

  const hint = document.createElement("span");
  hint.className = "label";
  hint.textContent = count === 0 ? "Click to number points on the canvas" : "Click to add another marker · markers stay on this view";
  bar.appendChild(hint);
}
