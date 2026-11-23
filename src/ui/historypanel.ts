/**
 * The History card: one row per undo step, and the repaint after a jump.
 * Extracted from main.ts while lowering the coupling count: the panel's DOM
 * work lives here, and the document state it displays arrives through
 * HistoryPanelDeps, so this module never reads a shell global.
 */
import type { Document, Layer } from "../engine/document.ts";
import type { History } from "../engine/history.ts";
import type { MenuItem } from "./popup.ts";

export interface HistoryPanelDeps {
  host: HTMLElement;
  history(): History;
  applyHistoryChange(): void;
  showContextMenu(ev: MouseEvent, items: MenuItem[]): void;
  statusHint(message: string): void;
  updateStatus(): void;
}

export interface HistoryChangeDeps {
  clearPreview(): void;
  document(): Document;
  textSelection(): Layer | null;
  setTextSelection(layer: Layer | null): void;
  markDirty(): void;
  setFlatDirty(v: boolean): void;
  setAutosaveDirty(v: boolean): void;
  activeLayer(): Layer;
  setActiveLayer(layer: Layer): void;
  renderAll(): void;
}

/** one row per entry; applied (past) bright, future dimmed; click to jump */
export function renderHistoryPanelInto(d: HistoryPanelDeps): void {
  const history = d.history();
  const labels = history.labels;
  const pos = history.position;
  const el = d.host;
  // stick to the newest step unless the user scrolled up to inspect older ones
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  el.innerHTML = "";
  if (labels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "label";
    empty.style.padding = "6px 9px";
    empty.textContent = "No actions yet";
    el.appendChild(empty);
    return;
  }
  labels.forEach((label, k) => {
    const row = document.createElement("div");
    row.className = "hist-row" + (k >= pos ? " future" : "") + (k === pos - 1 ? " current" : "");
    row.textContent = label;
    row.title = label;
    // Mouse-only was the whole panel's problem: a step could be jumped to by
    // clicking but not by keyboard, and nothing said where the current step
    // sits. Give each row the same contract as the layer rows.
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-current", k === pos - 1 ? "step" : "false");
    row.setAttribute("aria-label", `${label} — step ${k + 1} of ${labels.length}`);
    const jump = (): void => { history.jumpTo(k + 1); d.applyHistoryChange(); };
    row.addEventListener("click", jump);
    row.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      jump();
    });
    row.addEventListener("contextmenu", (e) => {
      const pos = history.position; // read fresh: rows may predate later jumps
      d.showContextMenu(e, [
        { label: "Step Backward to Here", disabled: k + 1 >= pos, run: () => { history.jumpTo(k + 1); d.applyHistoryChange(); } },
        { label: "Step Forward to Here", disabled: k + 1 <= pos, run: () => { history.jumpTo(k + 1); d.applyHistoryChange(); } },
        { sep: true },
        { label: "Clear History", run: () => { history.clear(); d.applyHistoryChange(); d.statusHint("History cleared"); } },
      ]);
    });
    el.appendChild(row);
  });
  if (atBottom) el.scrollTop = el.scrollHeight;
  d.updateStatus();
}

/** after a jump: the pixels changed under any preview, so drop it and repaint */
export function applyHistoryChangeVia(d: HistoryChangeDeps): void {
  d.clearPreview(); // AA2: the pixels changed under the preview
  const doc = d.document();
  const sel = d.textSelection();
  if (sel && !doc.inDocument(sel)) d.setTextSelection(null);
  d.markDirty();
  d.setFlatDirty(true);
  d.setAutosaveDirty(true);
  const active = d.activeLayer();
  if (!doc.inDocument(active)) d.setActiveLayer(doc.layers[doc.layers.length - 1] ?? active);
  d.renderAll();
}
