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
import { createFlatCache } from "../flatcache.ts";
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
  collapsed: new Set(),
  flat: createFlatCache(doc.width, doc.height).snapshot(),
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
  answer(yes: boolean): void;
  /** the extra button the last close prompt offered, if any */
  extra(): { label: string; run: () => void } | undefined;
  /** makes saveProject resolve and clears (or keeps) the dirty flag */
  saveSucceeds(ok: boolean): void;
}

function rig(): Rig {
  const dom = installDom();
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  let state = stateOf(fakeDoc());
  const calls: string[] = [];
  let last: { label: string; undo: () => void; redo: () => void } | undefined;
  const answers: boolean[] = [];
  let extraOffered: { label: string; run: () => void } | undefined;
  let saveOk = true;
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
    activateTab: (i) => { calls.push(`activate:${i}`); },
    saveProject: () => {
      calls.push("saveProject");
      if (saveOk) state = { ...state, dirty: false };
    },
    quickExportPng: () => {},
    runTop: () => {},
    fit: () => { calls.push("fit"); },
    hideRecoveryBar: () => {},
    ask: (_title, _body, _ok, _kind, extra) => {
      extraOffered = extra;
      const yes = answers.shift() ?? false;
      calls.push(`ask:${yes}`);
      return Promise.resolve(yes);
    },
  };
  resetTabs();
  mountTabs(host, deps);
  return {
    dom, host, calls,
    state: () => state,
    setState: (s) => { state = s; },
    lastHist: () => last,
    answer: (yes) => { answers.push(yes); },
    extra: () => extraOffered,
    saveSucceeds: (ok) => { saveOk = ok; },
  };
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

test("closing a dirty tab asks first; a refusal keeps it, a confirmation closes it", async () => {
  const r = rig();
  replaceDocument(fakeDoc(), layer(), "A");
  replaceDocument(fakeDoc(), layer(), "B");
  const dirty = { ...r.state(), dirty: true };
  r.setState(dirty);
  captureTab();

  r.answer(false);
  closeTab(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tabsView().length, 2, "the refusal left both tabs alone");

  r.answer(true);
  closeTab(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tabsView().length, 1, "the confirmation removed the tab");
  assert.equal(activeIndex(), 0, "and the neighbour became active");
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

test("ui13: the dirty-tab prompt offers Save, and Save closes only when the write lands", async () => {
  const r = rig();
  replaceDocument(fakeDoc(), layer(), "A");
  replaceDocument(fakeDoc(), layer(), "B");
  r.setState({ ...r.state(), dirty: true });
  captureTab();

  closeTab(1);
  await Promise.resolve();
  const extra = r.extra();
  assert.ok(extra, "the close prompt must offer a third answer");
  assert.equal(extra!.label, "Save", "the third answer is Save, not another way to discard");

  // A cancelled save leaves the tab open: saveProject resolves without
  // clearing dirty, which is what the real one does when the user backs out of
  // the save dialog. Closing anyway would discard the work the prompt warns about.
  r.saveSucceeds(false);
  extra!.run();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tabsView().length, 2, "a cancelled save must not close the tab");

  // The positive branch is the app's contract, not this module's: saveProject
  // clears the *tab's* dirty flag in main.ts, and only then does closeTabNow
  // run. Here we can only prove the part this module owns — that Save is
  // routed to the shell rather than merely dismissing the dialog.
  assert.ok(r.calls.includes("saveProject"), "Save must reach the shell");
});
