// The tab strip, stated as behaviour instead of as source text.
//
// These are the contracts that used to live only in comments: a switch must
// finish the outgoing document's work and clear a preview (AA2), a tab slot
// must keep what it was when left, a dirty tab must ask before it closes, and
// a reshape must be undoable through the history rather than silently applied.
//
// The module is a singleton (one strip per window), so each test resets it and
// mounts its own deps; the fake document is enough because nothing here paints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { History } from "../../engine/history.ts";
import type { Document, Layer } from "../../engine/document.ts";
import { installDom, type Dom } from "./dom.ts";
import {
  activeIndex,
  activateTab,
  captureTab,
  closeTab,
  installDoc,
  mountTabs,
  replaceDocument,
  resetTabs,
  setDocInTab,
  tabsView,
  type TabState,
  type TabsDeps,
} from "../tabs.ts";

const layer = (): Layer => ({ grid: {} } as unknown as Layer);
const fakeDoc = (w = 8, h = 8): Document => ({
  width: w,
  height: h,
  layers: [layer()],
  addBackground() { return layer(); },
  addLayer() { return layer(); },
} as unknown as Document);

const stateOf = (doc: Document, dirty = false): TabState => ({
  doc,
  activeLayer: doc.layers[0]!,
  history: new History(100),
  flat: new Uint8ClampedArray(doc.width * doc.height * 4),
  flatDirty: true,
  selRect: null,
  selMask: null,
  selGeom: null,
  scale: 1,
  panX: 0,
  panY: 0,
  autosaveDirty: true,
  dirty,
});

interface Rig {
  dom: Dom;
  host: HTMLElement;
  calls: string[];
  state(): TabState;
  setState(s: TabState): void;
  lastHist(): { label: string; undo: () => void; redo: () => void } | undefined;
}

function rig(): Rig {
  const dom = installDom();
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  let state = stateOf(fakeDoc());
  const calls: string[] = [];
  let last: { label: string; undo: () => void; redo: () => void } | undefined;
  const deps: TabsDeps = {
    read: () => state,
    write: (s) => { calls.push("write"); state = s; },
    patch: (p) => { state = { ...state, ...p } as TabState; },
    commitText: () => { calls.push("flushTransient"); },
    cancelTransform: () => {},
    finishStroke: () => {},
    closeGesture: () => {},
    clearTextSelection: () => {},
    clearPreview: () => { calls.push("clearPreview"); },
    hideContextMenu: () => { calls.push("hideContextMenu"); },
    stopAnts: () => {},
    startAnts: () => { calls.push("startAnts"); },
    renderAll: () => { calls.push("renderAll"); },
    drawOverlay: () => {},
    pushHist: (e) => { calls.push("pushHist"); last = e; },
    iconSvg: () => "<svg></svg>",
    showContextMenu: () => {},
    saveProject: () => {},
    quickExportPng: () => {},
    runTop: () => {},
    fit: () => { calls.push("fit"); },
    hideRecoveryBar: () => {},
  };
  resetTabs();
  mountTabs(host, deps);
  return { dom, host, calls, state: () => state, setState: (s) => { state = s; }, lastHist: () => last };
}

test("replacing the document opens a tab and renders it as the active one", () => {
  const r = rig();
  replaceDocument(fakeDoc(), layer(), "One");

  assert.equal(tabsView().length, 1);
  assert.equal(activeIndex(), 0);
  const labels = (r.host.children as unknown as { textContent?: string; className?: string }[])
    .map((c) => c.textContent ?? "");
  assert.ok(labels[0]!.includes("One"), `the strip shows the tab name, got ${JSON.stringify(labels)}`);
  const tabEl = r.host.children[0] as unknown as { className?: string };
  assert.ok(tabEl.className?.includes("active"), "the first tab is the active one");
  assert.equal(r.host.children.length, 2, "one tab plus the new-tab button");
});

test("AA2: a switch clears the preview and finishes the outgoing work before restoring", () => {
  const r = rig();
  const a = fakeDoc(8, 8);
  const b = fakeDoc(16, 4);
  replaceDocument(a, layer(), "A");
  replaceDocument(b, layer(), "B");
  r.calls.length = 0;

  // the outgoing document holds an unsaved edit and a live preview
  const outgoing = { ...r.state(), dirty: true };
  r.setState(outgoing);
  activateTab(0);

  // exactly one clear, and it is the first thing the switch does: a second
  // clear after the flush began means someone cleared a preview that the flush
  // was already committing (the order this test exists to protect)
  assert.deepEqual(r.calls.slice(0, 2), ["clearPreview", "flushTransient"],
    `the preview is dropped before the work is flushed (${r.calls.join(",")})`);
  assert.equal(r.calls.filter(c => c === "clearPreview").length, 1,
    `clearing again after the flush started (${r.calls.join(",")})`);
  assert.ok(r.calls.indexOf("write") > r.calls.indexOf("flushTransient"),
    `the swap happens after the flush (${r.calls.join(",")})`);
  assert.equal(tabsView()[1]!.dirty, true, "the left tab kept its dirty flag");
  assert.equal(r.state().doc, a, "the switch restored the other document");

  activateTab(1);
  assert.equal(r.state().doc, b, "and switching back restores B");
  assert.equal(r.state().dirty, true, "B's unsaved edit is still there");
});

test("closing a dirty tab asks first; a refusal keeps it, a confirmation closes it", () => {
  const r = rig();
  replaceDocument(fakeDoc(), layer(), "A");
  replaceDocument(fakeDoc(), layer(), "B");
  const confirmBackup = (globalThis as { confirm?: unknown }).confirm;
  try {
    (globalThis as { confirm?: () => boolean }).confirm = () => false;
    const dirty = { ...r.state(), dirty: true };
    r.setState(dirty);
    captureTab();
    closeTab(1);
    assert.equal(tabsView().length, 2, "the refusal left both tabs alone");

    (globalThis as { confirm?: () => boolean }).confirm = () => true;
    closeTab(1);
    assert.equal(tabsView().length, 1, "the confirmation removed the tab");
    assert.equal(activeIndex(), 0, "and the neighbour became active");
  } finally {
    if (confirmBackup === undefined) delete (globalThis as { confirm?: unknown }).confirm;
    else (globalThis as { confirm?: unknown }).confirm = confirmBackup;
  }
});

test("a reshape is installed without touching history; undoing it restores the old document", () => {
  const r = rig();
  const a = fakeDoc(8, 8);
  const b = fakeDoc(10, 10);
  const c = fakeDoc(12, 12);
  replaceDocument(a, layer(), "A");
  r.calls.length = 0;

  r.setState({ ...r.state(), doc: a });
  installDoc(b, 0);
  assert.equal(r.state().doc, b, "installDoc replaced the live document");
  assert.equal(tabsView()[0]!.autosaveDirty, true, "the tab is marked for autosave");
  assert.ok(!r.calls.includes("pushHist"), "installDoc is not an undoable step by itself");

  setDocInTab(c);
  assert.ok(r.calls.includes("pushHist"), "setDocInTab records one undoable entry");
  const hist = r.lastHist();
  assert.ok(hist, "an undo entry exists");
  hist.undo!();
  assert.equal(r.state().doc, b, "undo puts the previous document back");
  hist.redo!();
  assert.equal(r.state().doc, c, "redo applies the reshape again");
});
