// The palette: it renders what it is handed, filters on every word typed, and
// Enter runs the highlighted entry's own closure (AI5: before that, ~75 of the
// rows did nothing because the label was resolved through a table of four menus).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom, type Dom, type FakeElement } from "./dom.ts";

const { openCommandPalette } = await import("../palette.ts");

const rows = (dom: Dom): FakeElement[] => dom.body.querySelectorAll<FakeElement>(".palette-row");
const input = (dom: Dom): FakeElement => {
  const found = dom.body.querySelector<FakeElement>(".palette-input");
  assert.ok(found, "the palette has a search field");
  return found;
};

test("typing filters the list", () => {
  const dom = installDom();
  openCommandPalette([
    { label: "Brush", group: "Tools", key: "B", run: () => {} },
    { label: "Open…", group: "File", key: "Ctrl+O", run: () => {} },
  ]);
  assert.equal(rows(dom).length, 2);
  input(dom).value = "br";
  input(dom).fire("input");
  assert.equal(rows(dom).length, 1);
  assert.equal(rows(dom)[0]!.children[0]!.textContent, "Brush");
  dom.window.fire("keydown", { key: "Escape" });
});

test("Enter runs the highlighted tool", () => {
  const dom = installDom();
  const selected: string[] = [];
  openCommandPalette([
    { label: "Brush", group: "Tools", key: "B", run: () => { selected.push("brush"); } },
    { label: "Eraser", group: "Tools", key: "E", run: () => { selected.push("eraser"); } },
  ]);
  dom.window.fire("keydown", { key: "Enter" });
  assert.deepEqual(selected, ["brush"]);
  assert.equal(dom.body.querySelector(".palette"), null, "running an entry closes the palette");
});

test("Enter runs a menu row's own closure, not a label lookup", () => {
  const dom = installDom();
  const ran: string[] = [];
  openCommandPalette([
    { label: "Brush", group: "Tools", key: "B", run: () => {} },
    { label: "Merge Visible", group: "Layer", key: "Ctrl+Shift+E", run: () => { ran.push("merge"); } },
  ]);
  dom.window.fire("keydown", { key: "ArrowDown" });
  dom.window.fire("keydown", { key: "Enter" });
  assert.deepEqual(ran, ["merge"]);
});
