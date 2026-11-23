/** Options bar for the Patch tool. The tool has no numeric control: the drag
 *  is the parameter, so the bar states the gesture and the requirement. */
export function buildPatchOptions(bar: HTMLElement): void {
  const note = document.createElement("span");
  note.className = "label";
  note.textContent = "Drag the selection onto the pixels that should replace it";
  bar.append(note);
  const hint = document.createElement("span");
  hint.className = "label dim";
  hint.textContent = "needs a selection";
  bar.append(hint);
}
