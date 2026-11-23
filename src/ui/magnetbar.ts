/** Options bar for the Magnetic Lasso. The snap happens on release, so the
 *  only control is how far it may reach; the hint says when, because a magnetic
 *  lasso in Photoshop tracks live and this one does not. */
export function buildMagnetOptions(bar: HTMLElement, radius: number, onRadius: (next: number) => void): void {
  const label = document.createElement("span");
  label.className = "opt-read dim";
  label.textContent = "Snap radius";
  bar.append(label);
  const range = document.createElement("input");
  range.type = "range";
  range.min = "2";
  range.max = "24";
  range.step = "1";
  range.value = String(radius);
  range.setAttribute("aria-label", "Snap radius");
  range.addEventListener("input", () => onRadius(Number(range.value)));
  bar.append(range);
  const note = document.createElement("span");
  note.className = "opt-read dim";
  note.textContent = "snaps on release";
  bar.append(note);
}
