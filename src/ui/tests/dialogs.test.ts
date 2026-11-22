// The modal stack, stated as behaviour rather than as source text.
//
// These are the three contracts that regressed in review: one Escape must not
// close two stacked dialogs, a refusing form must stay on screen (OK and Enter
// alike), and focus must come back to whatever opened the dialog.
//
// Each test installs its own DOM: the modules read `document`/`window` when
// called, so a shared install would let one file's globals leak into another's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom, type Dom, type FakeElement } from "./dom.ts";

const { showModal, modalOpen } = await import("../dialogs.ts");

const el = (dom: Dom, tag = "div"): FakeElement => dom.document.createElement(tag);
const panelOf = (overlay: FakeElement): FakeElement => overlay.children[0]!;
const footOf = (overlay: FakeElement): FakeElement => {
  const p = panelOf(overlay);
  return p.children[p.children.length - 1]!;
};
const button = (overlay: FakeElement, label: string): FakeElement => {
  const found = footOf(overlay).children.find((c) => c.textContent === label);
  assert.ok(found, `the dialog has a ${label} button`);
  return found;
};
const titles = (dom: Dom): string[] => dom.overlays().map((o) => panelOf(o).children[0]!.textContent);

test("Escape closes only the top of two stacked dialogs", () => {
  const dom = installDom();
  showModal("Outer", el(dom) as unknown as HTMLElement, () => {});
  showModal("Inner", el(dom) as unknown as HTMLElement, () => {});
  assert.equal(dom.overlays().length, 2);
  assert.deepEqual(titles(dom), ["Outer", "Inner"]);

  dom.window.fire("keydown", { key: "Escape" });
  assert.deepEqual(titles(dom), ["Outer"], "the inner dialog closed, the outer one stayed");

  dom.window.fire("keydown", { key: "Escape" });
  assert.equal(dom.overlays().length, 0);
  assert.equal(modalOpen(), false);
});

test("a refused OK keeps the dialog and its error line", () => {
  const dom = installDom();
  const body = el(dom);
  const error = el(dom);
  error.className = "ndlg-error";
  error.textContent = "Width must be at least 1 pixel.";
  body.appendChild(error);
  let calls = 0;
  showModal("Refuse", body as unknown as HTMLElement, () => { calls++; return false; });

  const overlay = dom.overlays().at(-1)!;
  button(overlay, "OK").fire("click");
  assert.equal(calls, 1);
  assert.ok(dom.overlays().includes(overlay), "a refused OK must not close the dialog");
  assert.equal(error.textContent, "Width must be at least 1 pixel.", "the reason is still readable");

  button(overlay, "Cancel").fire("click");
  assert.equal(dom.overlays().length, 0);
});

test("a refused Enter keeps the dialog open too", () => {
  const dom = installDom();
  let calls = 0;
  showModal("Refuse Enter", el(dom) as unknown as HTMLElement, () => { calls++; return false; });
  const overlay = dom.overlays().at(-1)!;
  dom.window.fire("keydown", { key: "Enter", target: el(dom) });
  assert.equal(calls, 1);
  assert.ok(dom.overlays().includes(overlay), "Enter ran onOk, saw false, and must not have closed first");
  button(overlay, "Cancel").fire("click");
  assert.equal(dom.overlays().length, 0);
});

test("Escape is Cancel: a prompt that asked settles instead of hanging", () => {
  // The close guard awaits ask(...). Escape used to call close() alone, which
  // fires onClose but never onCancel, so the await never returned, the finally
  // that acks the OS request never ran, and the window could not be quit again.
  const dom = installDom();
  let cancelled = 0;
  showModal("Ask", el(dom) as unknown as HTMLElement, () => {}, { onCancel: () => cancelled++ });
  const overlay = dom.overlays().at(-1)!;
  dom.window.fire("keydown", { key: "Escape", target: el(dom) });
  assert.equal(cancelled, 1, "Escape must take the cancel path, not just close");
  assert.equal(dom.overlays().length, 0);
  assert.ok(!dom.overlays().includes(overlay));
});

test("Enter on a select belongs to the select, not to OK", () => {
  const dom = installDom();
  let calls = 0;
  const body = el(dom);
  const select = dom.document.createElement("select");
  body.appendChild(select);
  showModal("Pick", body as unknown as HTMLElement, () => { calls++; });
  dom.window.fire("keydown", { key: "Enter", target: select });
  assert.equal(calls, 0, "Enter in a dropdown must not run the dialog's OK");
  assert.equal(dom.overlays().length, 1, "and it must not close it either");
  button(dom.overlays()[0]!, "Cancel").fire("click");
});

test("closing returns focus to the opener", () => {
  const dom = installDom();
  const opener = el(dom, "button");
  dom.body.appendChild(opener);
  opener.focus();
  assert.equal(dom.document.activeElement, opener);

  showModal("Focus", el(dom) as unknown as HTMLElement, () => {});
  assert.notEqual(dom.document.activeElement, opener, "focus moved into the dialog");
  const overlay = dom.overlays().at(-1)!;
  button(overlay, "Cancel").fire("click");
  assert.equal(dom.document.activeElement, opener, "focus came back where it was");
});

test("Tab is trapped: it wraps from the last control to the first, and back", () => {
  const dom = installDom();
  const body = el(dom);
  const first = el(dom, "input");
  const second = el(dom, "input");
  body.append(first, second);
  showModal("Trap", body as unknown as HTMLElement, () => {});
  const overlay = dom.overlays().at(-1)!;
  const ok = button(overlay, "OK");

  ok.focus();
  dom.window.fire("keydown", { key: "Tab" });
  assert.equal(dom.document.activeElement, first);

  first.focus();
  dom.window.fire("keydown", { key: "Tab", shiftKey: true });
  assert.equal(dom.document.activeElement, ok);

  button(overlay, "Cancel").fire("click");
  assert.equal(dom.overlays().length, 0);
});
