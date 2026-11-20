// Shortcut precedence, independent of the listener that consumes it.
//
// R6.3 asked for a `dispatchKey(key, mods)` extraction, but AH5 already replaced
// the 300-line else-if chain with the table in ui/keymap.ts: `keyAction` says
// WHICH action a combo is, `src/main.ts` owns one handler per action. What was
// still untested was the guard in front of both: a dialog swallows the key, a
// form field swallows it, the canvas does not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { keyAction, shortcutAllowed } from "../keymap.ts";

test("Ctrl+Shift+S is Save As, not Save", () => {
  assert.equal(keyAction("S", { ctrl: true, shift: true }), "saveAs");
  assert.equal(keyAction("S", { ctrl: true }), "save");
  assert.equal(keyAction("s", { ctrl: true, shift: true }), "saveAs");
});

test("a modal swallows accelerators", () => {
  assert.equal(shortcutAllowed({ modalOpen: true, target: null }), false);
  assert.equal(shortcutAllowed({ modalOpen: true, target: { tagName: "CANVAS" } }), false);
});

test("a form field swallows letters", () => {
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(shortcutAllowed({ modalOpen: false, target: { tagName } }), false, tagName);
  }
  assert.equal(shortcutAllowed({ modalOpen: false, target: { isContentEditable: true } }), false);
});

test("the canvas still gets its keys", () => {
  assert.equal(shortcutAllowed({ modalOpen: false, target: null }), true);
  assert.equal(shortcutAllowed({ modalOpen: false, target: { tagName: "CANVAS" } }), true);
});
