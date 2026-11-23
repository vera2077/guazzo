/**
 * Document tabs: the tab strip, the per-document state slots, and the swap
 * between them.
 *
 * The shell still owns the live globals (`doc`, `activeLayer`, `history`,
 * `flat`, the selection and the view). This module never touches them
 * directly: it reads them through `deps.read()`, writes them through
 * `deps.write()/deps.patch()`, and runs shell behaviour through callbacks. A
 * `tabs.ts` function that named a shell global would reintroduce the second
 * owner the rewrite is removing, so `pins.mjs` refuses bare state names here.
 */
import { Document, type Layer } from "../engine/document.ts";
import { History, subtreeBytes, type HistoryEntry } from "../engine/history.ts";
import type { SelectionMask } from "../engine/mask.ts";
import type { MenuItem } from "./popup.ts";
import { createFlatCache, type FlatSnapshot } from "./flatcache.ts";

export interface SelRect { x: number; y: number; w: number; h: number }
export type SelGeom =
  | { kind: "ellipse"; x: number; y: number; w: number; h: number }
  | { kind: "poly"; pts: [number, number][] };

/** the part of a tab that is live in the shell while the tab is active */
export interface TabState {
  doc: Document;
  activeLayer: Layer;
  history: History;
  /** layers folded shut in this tab; copied by DocSession.adopt() on a switch */
  collapsed: ReadonlySet<number>;
  flat: FlatSnapshot;
  selRect: SelRect | null;
  selMask: SelectionMask | null;
  selGeom: SelGeom | null;
  /** view-only annotations (notes, counts, samples, ruler) owned by the shell */
  view?: unknown;
  scale: number;
  panX: number;
  panY: number;
  autosaveDirty: boolean;
  /** edits not yet written to a file (drives the tab dot and the close guard) */
  dirty: boolean;
}

/** one slot in the strip: the live state plus per-document metadata */
export interface DocTab extends TabState {
  name: string;
  /** document resolution in dots per inch (metadata only; canvas is always px) */
  dpi?: number;
  /** AG1: Rust's handle for the file this document saved to */
  savedHandle?: number;
  /** display name Rust reported for the last successful save (AK3) */
  savedName?: string;
}

export interface TabsDeps {
  read(): TabState;
  write(state: TabState): void;
  patch(p: Partial<TabState>): void;
  commitText(): void;
  cancelTransform(): void;
  /** finish a live stroke; the shell owns the paint session */
  finishStroke(): void;
  closeGesture(): void;
  /** drop a box selection that belongs to the tab being left */
  clearTextSelection(): void;
  clearPreview(): void;
  hideContextMenu(): void;
  stopAnts(): void;
  startAnts(): void;
  renderAll(): void;
  drawOverlay(): void;
  pushHist(entry: HistoryEntry): void;
  iconSvg(name: string, size: number): string;
  showContextMenu(ev: MouseEvent, items: MenuItem[]): void;
  /** returns a promise so the close prompt can wait for the write to land */
  saveProject(asCopy: boolean): void | Promise<void>;
  /** make the tab being closed the active one, so Save writes *it* */
  activateTab(i: number): void;
  quickExportPng(): void;
  runTop(label: string): void;
  fit(): void;
  hideRecoveryBar(): void;
  /** AS3: the shell's own dialog, not the browser's (a WebView may not have one). */
  ask(
    title: string,
    body: string,
    ok: string,
    okKind?: "neutral",
    extra?: { label: string; run: () => void },
  ): Promise<boolean>;
}

let tabDeps: TabsDeps | null = null;
let stripHost: HTMLElement | null = null;
const tabs: DocTab[] = [];
let activeTab = -1;

function d(): TabsDeps {
  if (!tabDeps) throw new Error("tabs: mountTabs() was never called");
  return tabDeps;
}

/** install the strip. The shell builds `deps` once, after its globals exist. */
export function mountTabs(el: HTMLElement, api: TabsDeps): void {
  stripHost = el;
  tabDeps = api;
  // tab strip is a real tablist: roving tabindex + arrow switching
  el.setAttribute("role", "tablist");
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    // The strip owns the key whenever it has focus, even when it cannot move:
    // at the last tab the event used to fall through to the editor's nudge
    // handler and shifted the active layer (uiux-r18 #3).
    e.preventDefault();
    e.stopPropagation();
    if (tabs.length < 2) return;
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = Math.min(tabs.length - 1, Math.max(0, activeTab + dir));
    if (next !== activeTab) {
      const hadFocus = el.contains(document.activeElement as never);
      activateTab(next);
      // renderTabs() rebuilds the strip, so the focused node is gone; without
      // this the second ArrowRight goes to <body> (uiux-r12 #4).
      if (hadFocus) (el.querySelector(".tab.active") as HTMLElement | null)?.focus();
    }
  });
}

export function tabsView(): readonly DocTab[] { return tabs; }
export function activeIndex(): number { return activeTab; }
export function activeTabName(): string { return tabs[activeTab]?.name ?? "untitled"; }
export function activeTabView(): DocTab | undefined { return tabs[activeTab]; }
export function anyTabDirty(): boolean { return tabs.some((t) => t.dirty); }
export function closeActiveTab(): void { closeTab(activeTab); }

/** test seam: the strip is a singleton, so a test file needs a clean one */
export function resetTabs(): void {
  tabs.length = 0;
  activeTab = -1;
}

/** the boot document, already live in the shell, becomes tab 0 */
export function seedBootTab(tab: DocTab): void {
  tabs.push(tab);
  activeTab = 0;
}

export function setLastTabDpi(dpi: number): void {
  const tab = tabs[tabs.length - 1];
  if (tab) tab.dpi = dpi;
}

/** write the current global state into the active tab's slot */
export function captureTab(): void {
  if (activeTab < 0) return;
  const t = tabs[activeTab]!;
  const live = d().read();
  // `read()` reports the *shell's* dirty flag, which belongs to whichever
  // document is in front. A tab marked dirty without the shell knowing —
  // a crash-restored document, a programmatic edit — must not lose its dot
  // when it is written back here, or closing it stops asking to save.
  const dirty = t.dirty || live.dirty;
  Object.assign(t, live);
  t.dirty = dirty;
  t.flat = live.flat;
}

/** flush editing state (text box / transform / live stroke) that belongs to
 *  the active document — called BEFORE any tab switch. The shell supplies the
 *  gesture/paint seams; document state itself never enters this module. */
export function flushTransient(): void {
  const api = d();
  api.clearPreview(); // AA2: leaving the document must not leave a proxy on screen
  api.commitText();
  api.cancelTransform();
  api.finishStroke();
  // Gesture state belongs to the document that was being edited. Switching
  // documents must not leave a drag, a crop rectangle or a lasso half-open, or
  // the next Enter applies tab A's crop to tab B. closeGesture COMMITS first so
  // a healing stroke the user already drew is not thrown away.
  api.closeGesture();
  api.clearTextSelection(); // box selection belongs to the tab being left
  api.stopAnts();
  api.drawOverlay();
}

export function activateTab(i: number): void {
  const api = d();
  if (i === activeTab) return;
  // AA2: flushTransient drops the preview before it commits anything
  flushTransient();
  api.stopAnts();
  // an open context menu holds closures over the OLD document's layers —
  // its items would act across documents and record into the wrong history
  api.hideContextMenu();
  captureTab();
  activeTab = i;
  const t = tabs[i]!;
  api.write(t);
  api.renderAll();
  // ui12: renderAll repaints the canvas and the panels but never the strip, so
  // after a switch the OLD tab kept .active / aria-selected / the roving stop
  // while a different document was on screen.
  renderTabs();
  if (t.selRect || t.selMask) api.startAnts();
}

export function closeTab(i: number): void {
  const api = d();
  const target = tabs[i];
  if (target && target.dirty) {
    void api.ask(
      `Close “${target.name}”?`,
      "This document has unsaved changes.",
      "Close without saving",
      "neutral",
      {
        label: "Save",
        // The tab only closes if the write actually landed: saveProject resolves
        // after the file is chosen and written, and leaves `dirty` true when the
        // user cancels the save dialog. ui13: this prompt used to offer no Save
        // at all, which made "unsaved changes" a warning with one exit.
        run: () => {
          // saveProject writes the ACTIVE document; closing a background tab
          // used to save the front one and leave the target dirty forever
          // (code-r6).
          api.activateTab(i);
          void Promise.resolve(api.saveProject(true)).then(() => {
            if (!target.dirty) closeTabNow(i);
          });
        },
      },
    ).then((yes) => { if (yes) closeTabNow(i); });
    return;
  }
  closeTabNow(i);
}

/** closes immediately; callers that can be refused go through closeTab */
function closeTabNow(i: number): void {
  const api = d();
  const target = tabs[i];
  if (!target) return;
  const wasActive = i === activeTab;
  if (wasActive) {
    flushTransient();
    api.stopAnts();
    activeTab = -1; // never capture back into a slot we are removing
  }
  tabs.splice(i, 1);
  if (tabs.length === 0) {
    // Fall through to the focus handoff: returning here left focus on <body>
    // (uiux-r26 F2).
    createUntitledTab();
  } else if (wasActive) {
    activateTab(Math.min(i, tabs.length - 1));
  } else {
    if (i < activeTab) activeTab--;
    renderTabs();
  }
  // The removed tab owned focus; renderTabs built new nodes, so hand focus to
  // the tab that now stands in its place instead of letting it fall to <body>
  // (uiux-r25 #3).
  (stripHost?.querySelector(".tab.active") as HTMLElement | null)?.focus();
}

/** AS3: one prompt for the whole batch, not one per dirty tab. */
function closeOtherTabs(keep: number): void {
  const api = d();
  const doomed = tabs.map((t, idx) => ({ t, idx })).filter((x) => x.idx !== keep && x.t.dirty);
  const removeAll = (): void => {
    for (let j = tabs.length - 1; j >= 0; j--) if (j !== keep) closeTabNow(j);
  };
  if (doomed.length === 0) { removeAll(); return; }
  const names = doomed.map((x) => `“${x.t.name}”`).join(", ");
  void api.ask(
    "Close the other tabs?",
    `${names} ${doomed.length === 1 ? "has" : "have"} unsaved changes. Closing discards them.`,
    "Close them",
  ).then((yes) => { if (yes) removeAll(); });
}

export function renderTabs(): void {
  if (!stripHost) return;
  const api = d();
  const strip = stripHost;
  strip.innerHTML = "";
  const tabEls: HTMLElement[] = [];
  tabs.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === activeTab ? " active" : "");
    el.setAttribute("role", "tab");
    el.tabIndex = i === activeTab ? 0 : -1;
    el.setAttribute("aria-selected", String(i === activeTab));
    el.addEventListener("keydown", (ev) => {
      // A tab key must not also reach the document: Delete on a focused tab
      // used to erase the selection of the tab that had just come forward, and
      // Enter could run an armed crop (uiux-r23 #1). The shell's guard only
      // exempts form fields, so the strip owns its keys here.
      // Consume only the keys the strip owns. Swallowing every key meant
      // Ctrl+S/Z/C and the single-letter tools did nothing while a tab had
      // focus, with no hint (uiux-r24 #1 / code-r24 #1). Arrows are handled by
      // the strip-level listener.
      // Backspace is added as a stop without an action: the shell treats it as
      // Delete, so a focused tab would erase the selection behind it
      // (code-r25 #1).
      if (ev.key === "Enter" || ev.key === " " || ev.key === "Delete" || ev.key === "Backspace") {
        ev.stopPropagation();
      }
      // An ARIA tab with no activation key is a mouse target with a role
      // (uiux-r19 #3). Enter/Space activate, Delete closes.
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activateTab(i);
        // activateTab rebuilds the strip; put focus on the tab the user just
        // chose instead of dropping it to <body> (uiux-r21).
        (strip.querySelector(".tab.active") as HTMLElement | null)?.focus();
        return;
      }
      if (ev.key === "Delete") {
        ev.preventDefault();
        // A dirty tab asks a question: the confirm dialog owns focus, so
        // refocusing the strip here pulled it out from under the overlay and a
        // following Enter landed on "Close without saving" (uiux-r22 #1).
        if (t.dirty) { closeTab(i); return; }
        closeTab(i);
        // A clean tab closes synchronously; focus whatever is active now
        // rather than the page body.
        ((strip.querySelector(".tab.active") ?? strip.querySelector(".tab")) as HTMLElement | null)?.focus();
      }
    });
    const label = document.createElement("span");
    label.textContent = (t.dirty ? "• " : "") + t.name;
    label.style.cssText = "overflow:hidden;text-overflow:ellipsis";
    if (t.dirty) el.classList.add("dirty");
    el.appendChild(label);
    const x = document.createElement("span");
    x.className = "close";
    x.innerHTML = api.iconSvg("close", 12);
    x.title = "Close";
    // A fake button inside a role="tab" is presentational to assistive tech and
    // could never be reached anyway (uiux-r24 #5). Delete and the tab context
    // menu are the keyboard paths; the glyph stays for the mouse.
    x.setAttribute("aria-hidden", "true");
    x.tabIndex = -1;
    x.addEventListener("click", (ev) => { ev.stopPropagation(); closeTab(i); });
    el.addEventListener("auxclick", (ev) => { if (ev.button === 1) { ev.preventDefault(); closeTab(i); } });
    el.appendChild(x);
    el.addEventListener("click", () => { if (i !== activeTab) activateTab(i); });
    el.addEventListener("contextmenu", (e) => {
      api.showContextMenu(e, [
        { label: "Close Tab", disabled: tabs.length <= 1, run: () => closeTab(i) },
        { label: "Close Other Tabs", disabled: tabs.length <= 1, run: () => closeOtherTabs(i) },
        { sep: true },
        // Save is a command about *this* tab. It must bring the tab forward
        // first, exactly like Close does, or it writes the front document and
        // leaves this one untouched while the status bar says "Saved".
        { label: "Save Project", key: "Ctrl+S", run: () => { api.activateTab(i); void api.saveProject(true); } },
        { label: "Save Project As…", key: "Ctrl+Shift+S", run: () => { api.activateTab(i); void api.saveProject(false); } },
        // Export reads the live document too: a background tab must come
        // forward or the front picture is exported under this tab's name.
        { label: "Quick Export as PNG", run: () => { api.activateTab(i); api.quickExportPng(); } },
        { label: "Export As…", run: () => { api.activateTab(i); api.runTop("Export As…"); } },
      ]);
    });
    tabEls.push(el);
    strip.appendChild(el);
  });
  const plus = document.createElement("button");
  plus.className = "newtab";
  plus.innerHTML = api.iconSvg("plus", 14);
  plus.title = "New document";
  plus.setAttribute("aria-label", "New document");
  plus.addEventListener("click", () => createUntitledTab());
  strip.appendChild(plus);
  // The strip scrolls horizontally with its scrollbar hidden (index.html
  // #tabs), so a tab opened past the right edge — or reached with Ctrl+Tab —
  // used to become active while sitting off-screen, with nothing on screen
  // saying it existed. Ask the browser to bring the active tab back into view.
  const activeEl = tabEls[activeTab];
  const scroller = activeEl as (HTMLElement & { scrollIntoView?: unknown }) | undefined;
  if (typeof scroller?.scrollIntoView === "function") {
    (scroller.scrollIntoView as (opts: ScrollIntoViewOptions) => void)({ block: "nearest", inline: "nearest" });
  }
}

/** Mark the active tab as containing unsaved work. Recovery uses it: a
 *  restored document was inserted with `dirty: false` and therefore had no dot
 *  and no close prompt, so closing it lost the recovered work silently
 *  (code-r6). */
export function markActiveDirty(): void {
  const t = tabs[activeTab];
  if (!t) return;
  t.dirty = true;
  renderTabs();
}

export function createUntitledTab(): void {
  const nd = new Document(1024, 768);
  nd.addBackground("Background");
  const layer = nd.addLayer("Layer 1");
  replaceDocument(nd, layer, "Untitled");
}

/** swap in a whole new document (image/project open, New) and reset view + history */
export function replaceDocument(newDoc: Document, active?: Layer, name = "Untitled"): void {
  const api = d();
  flushTransient();
  api.stopAnts();
  captureTab(); // keep the outgoing tab's state in its slot
  tabs.push({
    name, doc: newDoc,
    activeLayer: active ?? newDoc.layers[newDoc.layers.length - 1] ?? newDoc.addLayer("Layer 1"),
    history: new History(100),
    collapsed: new Set(),
    flat: createFlatCache(newDoc.width, newDoc.height).snapshot(),
    selRect: null, selMask: null, selGeom: null,
    scale: 1, panX: 0, panY: 0,
    autosaveDirty: true,
    dirty: false,
  });
  api.hideRecoveryBar();
  activateTab(tabs.length - 1);
  api.fit(); // new document → zoom to fit
  captureTab(); // persist that view into the tab
  api.renderAll();
  renderTabs();
}

/** install a document into the current tab WITHOUT touching the history */
export function installDoc(nd: Document, layerIdx: number): void {
  const t = tabs[activeTab];
  if (t) t.autosaveDirty = true;
  const idx = Math.min(Math.max(0, layerIdx), nd.layers.length - 1);
  d().patch({
    doc: nd,
    flat: createFlatCache(nd.width, nd.height).snapshot(),
    selRect: null,
    selMask: null,
    selGeom: null,
    activeLayer: nd.layers[idx] ?? nd.layers[0]!,
    // Reshape replaces the document in place: annotations belong to the tab,
    // not to the pixel buffer, and dropping them here made Rotate look like it
    // had deleted notes/counts/samples (code-r13 #3).
    view: d().read().view,
  });
}

/** swap in a new Document for the CURRENT tab as a REVIEWABLE edit: the old
 *  document is kept alive by the undo entry, so Crop/Rotate/Trim/Resize stay
 *  undoable instead of silently emptying the History panel */
export function setDocInTab(nd: Document, label = "Reshape"): void {
  const api = d();
  flushTransient();
  api.stopAnts();
  const prevDoc = api.read().doc;
  const prevIdx = Math.max(0, prevDoc.layers.indexOf(api.read().activeLayer));
  const nextIdx = Math.max(0, prevIdx);
  installDoc(nd, nextIdx);
  const nextActiveIdx = Math.max(0, nd.layers.indexOf(api.read().activeLayer));
  api.pushHist({
    label,
    // The closures retain both documents: a reshape must pay for what it keeps
    // or the byte budget can never evict it (code-r18 #6).
    bytes: prevDoc.layers.reduce((n, l) => n + subtreeBytes(l), 0)
      + nd.layers.reduce((n, l) => n + subtreeBytes(l), 0),
    undo: () => {
      installDoc(prevDoc, prevIdx);
      api.renderAll();
      api.drawOverlay();
    },
    redo: () => {
      installDoc(nd, nextActiveIdx);
      api.renderAll();
      api.drawOverlay();
    },
  });
  api.fit();
  api.renderAll();
  api.drawOverlay();
}
