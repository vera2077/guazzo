import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_ACTIONS, KEY_ACTION_IDS, keyAction, normalizeCombo, type KeyAction, type KeyMods } from "../../ui/keymap.ts";
import { NON_KEY_ROWS, SHORTCUTS } from "../../ui/shortcuts.ts";

/**
 * AH5: the shortcut table and the dispatcher must be the same list.
 *
 * The old "test" read src/main.ts as text and looked for `k === "s"`, which is
 * why Ctrl+Shift+S could be documented in Help and inert in the app for months.
 * These checks run the real functions in both directions instead.
 */

interface Parsed {
  combo: string;
  mods: KeyMods;
  key: string;
}

function parseCombo(text: string): Parsed | null {
  const tokens = text.split("+").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  const mods: KeyMods = {};
  let key = "";
  for (const token of tokens) {
    const low = token.toLowerCase();
    if (low === "ctrl" || low === "cmd") mods.ctrl = true;
    else if (low === "shift") mods.shift = true;
    else if (low === "alt") mods.alt = true;
    else key = token;
  }
  if (!key) return null;
  return { combo: normalizeCombo(key, mods), mods, key };
}

/** Every accelerator string advertised in Help ▸ Keyboard Shortcuts. */
function documentedCombos(): Parsed[] {
  const out: Parsed[] = [];
  for (const row of SHORTCUTS) {
    if (NON_KEY_ROWS.includes(row.keys)) continue;
    for (const part of row.keys.split(/\s*\/\s*/)) {
      const parsed = parseCombo(part);
      if (parsed && parsed.mods.ctrl) out.push(parsed);
    }
  }
  return out;
}

test("every documented accelerator resolves to an action", () => {
  const documented = documentedCombos();
  assert.ok(documented.length >= 20, `expected the help table to document accelerators, found ${documented.length}`);
  for (const doc of documented) {
    const action = keyAction(doc.key, doc.mods);
    assert.ok(action !== null, `Help documents ${doc.combo} but ui/keymap.ts has no action for it`);
  }
});

test("every action is discoverable from the help table", () => {
  const documented = new Set<KeyAction>();
  for (const doc of documentedCombos()) {
    const action = keyAction(doc.key, doc.mods);
    if (action) documented.add(action);
  }
  for (const id of KEY_ACTION_IDS) {
    assert.ok(documented.has(id), `action "${id}" exists but no Help row advertises a combo that reaches it`);
  }
});

test("the action table and the id list agree", () => {
  const ids = new Set<string>(KEY_ACTION_IDS);
  assert.equal(ids.size, KEY_ACTION_IDS.length, "KEY_ACTION_IDS has duplicates");
  for (const action of Object.values(KEY_ACTIONS)) {
    assert.ok(ids.has(action), `KEY_ACTIONS maps to "${action}", which is missing from KEY_ACTION_IDS`);
  }
  const reachable = new Set(Object.values(KEY_ACTIONS));
  for (const id of KEY_ACTION_IDS) {
    assert.ok(reachable.has(id), `"${id}" is listed but no combo produces it`);
  }
});

test("plain letters are not accelerators", () => {
  // The regression this pins: Ctrl+Shift+L used to look "handled" because the
  // chain tested `k === "l"` alone and ignored the modifier.
  assert.equal(keyAction("l", { ctrl: true }), null);
  assert.equal(keyAction("l", { ctrl: true, shift: true }), null);
  assert.equal(keyAction("s"), null);
});

test("normalizeCombo folds the shifted glyph and orders modifiers", () => {
  assert.equal(normalizeCombo("S", { ctrl: true, shift: true }), "ctrl+shift+s");
  assert.equal(normalizeCombo("s", { shift: true, ctrl: true }), "ctrl+shift+s");
  assert.equal(normalizeCombo("="), "=");
  assert.equal(keyAction("=", { ctrl: true }), "zoomIn");
  // AM5: with Shift held the browser reports "+", not "=". The old table only
  // had ctrl+shift+= (a combo normalizeCombo could never produce), so the
  // standard zoom-in fell through to the browser's page zoom.
  assert.equal(keyAction("+", { ctrl: true, shift: true }), "zoomIn");
  assert.equal(keyAction("_", { ctrl: true, shift: true }), "zoomOut");
  assert.equal(normalizeCombo("+", { ctrl: true, shift: true }), "ctrl++");
  assert.equal(normalizeCombo("S", { ctrl: true, shift: true }), "ctrl+shift+s");
  assert.equal(keyAction("+", { ctrl: true }), "zoomIn");
  assert.equal(keyAction("-", { ctrl: true }), "zoomOut");
  assert.equal(keyAction("1", { ctrl: true }), "actualPixels");
});

test("shift changes the action where Photoshop does", () => {
  assert.equal(keyAction("e", { ctrl: true }), "mergeDown");
  assert.equal(keyAction("e", { ctrl: true, shift: true }), "exportAs");
  assert.equal(keyAction("s", { ctrl: true }), "save");
  assert.equal(keyAction("s", { ctrl: true, shift: true }), "saveAs");
  assert.equal(keyAction("c", { ctrl: true }), "copy");
  assert.equal(keyAction("c", { ctrl: true, shift: true }), "copyMerged");
  assert.equal(keyAction("z", { ctrl: true }), "undo");
  assert.equal(keyAction("z", { ctrl: true, shift: true }), "redo");
  assert.equal(keyAction("n", { ctrl: true }), "newDocument");
  assert.equal(keyAction("n", { ctrl: true, shift: true }), "newLayer");
});
