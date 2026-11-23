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
  /** `pixelsChanged` is false for a jump to the step already current. */
  applyHistoryChange(pixelsChanged?: boolean): void;
  showContextMenu(ev: MouseEvent, items: MenuItem[]): void;
  /** a live Free Transform holds a document snapshot history must not replace */
  cancelTransform(): void;
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
    // Roving tabindex: one Tab stop for the whole list, arrows to walk it.
    // Every row as a stop meant up to 100 presses to get past the panel
    // (uiux-r19 #4).
    row.tabIndex = k === pos - 1 ? 0 : -1;
    row.setAttribute("role", "button");
    row.setAttribute("aria-current", k === pos - 1 ? "step" : "false");
    row.setAttribute("aria-label", `${label} — step ${k + 1} of ${labels.length}`);
    const jump = (): void => {
      d.cancelTransform();
      const before = history.position;
      history.jumpTo(k + 1);
      d.applyHistoryChange(history.position !== before);
      // applyHistoryChange rebuilds every row, so the node that fired this no
      // longer exists; land focus on the new current step (uiux-r21).
      const rows = Array.from(el.querySelectorAll<HTMLElement>(".hist-row"));
      rows[Math.max(0, history.position - 1)]?.focus();
    };
    row.addEventListener("click", jump);
    row.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        const rows = Array.from(el.querySelectorAll<HTMLElement>(".hist-row"));
        const next = rows[rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          row.tabIndex = -1;
          next.tabIndex = 0;
          next.focus();
        }
        return;
      }
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      jump();
    });
    row.addEventListener("contextmenu", (e) => {
      const pos = history.position; // read fresh: rows may predate later jumps
      d.showContextMenu(e, [
        { label: "Step Backward to Here", disabled: k + 1 >= pos, run: () => { d.cancelTransform(); history.jumpTo(k + 1); d.applyHistoryChange(); } },
        { label: "Step Forward to Here", disabled: k + 1 <= pos, run: () => { d.cancelTransform(); history.jumpTo(k + 1); d.applyHistoryChange(); } },
        { sep: true },
        { label: "Clear History", run: () => { d.cancelTransform(); history.clear(); d.applyHistoryChange(false); d.statusHint("History cleared"); } },
      ]);
    });
    el.appendChild(row);
  });
  if (atBottom) el.scrollTop = el.scrollHeight;
  d.updateStatus();
}

/** after a jump: the pixels changed under any preview, so drop it and repaint */
export function applyHistoryChangeVia(d: HistoryChangeDeps, pixelsChanged = true): void {
  d.clearPreview(); // AA2: the pixels changed under the preview
  const doc = d.document();
  const sel = d.textSelection();
  if (sel && !doc.inDocument(sel)) d.setTextSelection(null);
  // Jumping to the step already current changes nothing; marking the document
  // dirty there relit the unsaved dot after a save (uiux-r14 #5).
  if (pixelsChanged) {
    d.markDirty();
    d.setFlatDirty(true);
    d.setAutosaveDirty(true);
  }
  const active = d.activeLayer();
  if (!doc.inDocument(active)) d.setActiveLayer(doc.layers[doc.layers.length - 1] ?? active);
  d.renderAll();
}
