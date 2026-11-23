/** Options bar for the Note tool: how many notes, and a way to clear them. */
export function buildNoteOptions(bar: HTMLElement, count: number, onClear: () => void): void {
  const chip = document.createElement("span");
  chip.className = "opt-read";
  chip.textContent = count === 0 ? "No notes" : `${count} note${count === 1 ? "" : "s"}`;
  bar.append(chip);
  const clear = document.createElement("button");
  clear.className = "opt-btn";
  clear.textContent = "Clear Notes";
  clear.disabled = count === 0;
  clear.addEventListener("click", onClear);
  bar.append(clear);
  // `.label` children are filed into the "?" help panel by finalizeOptionsBar,
  // so the hint that must stay on the bar uses the readout class instead.
  const note = document.createElement("span");
  note.className = "opt-read dim";
  note.textContent = "Click to add a note · notes are view-only";
  bar.append(note);
}
