// The tree contract is DOM, not a pure helper: a treeitem has to say its level,
// whether its group is open, and whether it is the selected row. The fake DOM
// has no canvas, so thumbnails bail out early; everything asserted here is the
// row/chevron contract the smoke also depends on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom, type FakeElement } from "./dom.ts";
import { Document, type Layer } from "../../engine/document.ts";
import { buildLayersPanel, type LayersPanel } from "../layerspanel.ts";
import { DocSession, panelRows } from "../session.ts";

const dom = installDom();

test("panel ARIA: tree levels, group expansion and the selected row survive a collapse", () => {
  const doc = new Document(32, 32);
  doc.addLayer("bottom");
  const group = doc.addGroup("Group A");
  doc.addLayerTo(group, "child A");
  const top = doc.addLayer("top");
  const session = new DocSession();
  let active: Layer = top;
  const body = dom.document.createElement("div");
  const strip = dom.document.createElement("div");
  const noop = (): void => {};
  let panel!: LayersPanel;

  panel = buildLayersPanel({
    body: body as unknown as HTMLElement,
    strip: strip as unknown as HTMLElement,
    rows: () => panelRows(doc, active, session.collapsed),
    reveal: noop,
    doc: () => doc,
    active: () => active,
    setActive: (layer) => { active = layer; },
    collapsed: () => session.collapsed,
    toggleCollapsed: (layer) => { session.toggleCollapsed(layer.id); },
    paintTarget: () => "pixel",
    setPaintTarget: noop,
    hasSelection: () => false,
    undoable: noop,
    repaint: noop,
    rerender: () => panel.render(),
    refreshHistory: noop,
    refreshOptions: noop,
    menu: noop,
    addLayer: noop,
    duplicateLayer: noop,
    deleteLayer: noop,
    mergeDown: noop,
    flatten: noop,
    enterTransform: noop,
    cancelTransform: noop,
    addMask: noop,
    loadMask: noop,
    applyMask: noop,
    deleteMask: noop,
    addAdjust: noop,
    moveLayer: noop,
    canDropLayer: () => false,
    dropLayer: noop,
  });
  panel.render();

  const rowNamed = (name: string): FakeElement => {
    const row = body.querySelectorAll(".row").find((el) => el.querySelector(".name")?.textContent === name);
    assert.ok(row, `row ${name} exists`);
    return row;
  };

  assert.equal(body.querySelector(".layer-rows")?.getAttribute("role"), "tree");
  const tree = body.querySelector(".layer-rows")!;
  assert.equal(tree.getAttribute("aria-label"), "Layers");
  assert.equal(rowNamed("top").getAttribute("role"), "treeitem");
  assert.equal(rowNamed("top").getAttribute("aria-level"), "1");
  assert.equal(rowNamed("Group A").getAttribute("aria-level"), "1");
  assert.equal(rowNamed("child A").getAttribute("aria-level"), "2");
  assert.equal(rowNamed("Group A").getAttribute("aria-expanded"), "true");
  assert.equal(rowNamed("top").getAttribute("aria-selected"), "true");
  assert.equal(rowNamed("child A").getAttribute("aria-selected"), "false");

  // ArrowLeft on the group closes it; the row stays visible and says so.
  rowNamed("Group A").fire("keydown", { key: "ArrowLeft" });
  assert.equal(body.querySelectorAll(".row").length, 3);
  assert.equal(rowNamed("Group A").getAttribute("aria-expanded"), "false");
  assert.equal(body.querySelectorAll(".row").some((r) => r.querySelector(".name")?.textContent === "child A"), false);

  // ArrowRight opens it again; selecting the child moves aria-selected with it.
  rowNamed("Group A").fire("keydown", { key: "ArrowRight" });
  assert.equal(body.querySelectorAll(".row").length, 4);
  assert.equal(rowNamed("Group A").getAttribute("aria-expanded"), "true");
  rowNamed("child A").fire("click");
  assert.equal(rowNamed("child A").getAttribute("aria-selected"), "true");
  assert.equal(rowNamed("Group A").getAttribute("aria-selected"), "false");
  assert.equal(rowNamed("top").getAttribute("aria-selected"), "false");
});
