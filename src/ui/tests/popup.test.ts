// The context menu, stated as behaviour: it lands in the body, the keyboard
// walks it, Enter runs the row, Escape closes and hands focus back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom, type Dom, type FakeElement } from "./dom.ts";

const popup = await import("../popup.ts");

const el = (dom: Dom, tag = "div"): FakeElement => dom.document.createElement(tag);
const fakeEvent = (target: FakeElement | null): MouseEvent => ({
  preventDefault() {},
  stopPropagation() {},
  clientX: 12,
  clientY: 16,
  target,
} as unknown as MouseEvent);

const menuRows = (pop: FakeElement): FakeElement[] => pop.children.filter((c) => c.classList.contains("menu-item"));

test("a context menu opens in the body with its first row focused", () => {
  const dom = installDom();
  popup.showContextMenu(fakeEvent(null), [
    { label: "Duplicate Layer", run: () => {} },
    { label: "Delete Layer", run: () => {} },
  ]);
  const pop = dom.body.querySelector<FakeElement>(".context-pop");
  assert.ok(pop, "the menu is in the document body, not inside a clipped container");
  assert.equal(menuRows(pop).length, 2);
  assert.equal(dom.document.activeElement, menuRows(pop)[0]);
  popup.hideContextMenu();
  assert.equal(dom.body.querySelector(".context-pop"), null);
});

test("clicking a row runs it", () => {
  const dom = installDom();
  let ran = 0;
  popup.showContextMenu(fakeEvent(null), [{ label: "Duplicate Layer", run: () => { ran++; } }]);
  const pop = dom.body.querySelector<FakeElement>(".context-pop")!;
  menuRows(pop)[0]!.fire("click");
  assert.equal(ran, 1);
  popup.hideContextMenu();
});

test("Escape closes the menu and returns focus to the opener", () => {
  const dom = installDom();
  const opener = el(dom, "button");
  dom.body.appendChild(opener);
  opener.focus();
  popup.showContextMenu(fakeEvent(opener), [{ label: "Duplicate Layer", run: () => {} }]);
  const pop = dom.body.querySelector<FakeElement>(".context-pop")!;
  pop.fire("keydown", { key: "Escape", stopPropagation() {} });
  assert.equal(dom.body.querySelector(".context-pop"), null);
  assert.equal(dom.document.activeElement, opener);
});

test("hovering into a submenu opens it with a fixed placement", () => {
  const dom = installDom();
  popup.showContextMenu(fakeEvent(null), [
    { label: "Mode", children: [{ label: "Normal" }, { label: "Multiply" }] },
  ]);
  const pop = dom.body.querySelector<FakeElement>(".context-pop")!;
  const row = menuRows(pop)[0]!;
  const sub = row.children.find((c) => c.classList.contains("menu-sub"));
  assert.ok(sub, "the submenu exists");
  row.fire("pointerenter");
  assert.ok(row.classList.contains("open"), "the row is marked open");
  assert.match(sub!.style.left ?? "", /^-?\d+px$/, "placed horizontally by hand");
  assert.match(sub!.style.top ?? "", /^-?\d+px$/, "placed vertically by hand");
  assert.equal(sub!.style.visibility, "", "visible after measuring");
  popup.hideContextMenu();
});
