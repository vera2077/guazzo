/**
 * The Help dialog must stay readable and complete.
 *
 * Dispatch coverage used to be checked HERE, by reading `src/main.ts` as text
 * and looking for `k === "s"` branches. That is why Ctrl+Shift+S could be
 * documented and inert for months: the lint matched the letter and ignored the
 * modifier. AH5 moved the accelerator contract into `src/ui/keymap.ts`, and
 * `src/engine/tests/keymap.test.ts` now proves — by running the real functions —
 * that the help table and the dispatcher are the same list in both directions.
 *
 * What is left for this file is what a behaviour test cannot see: typos, rows
 * that leak a developer note into the UI, and tools that exist on the toolbar
 * but are advertised nowhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NON_KEY_ROWS, SHORTCUTS } from "../../ui/shortcuts.ts";
import { TOOL_IDS, TOOL_LABELS } from "../../ui/toollabels.ts";

test("every row has a key and a description", () => {
  for (const row of SHORTCUTS) {
    assert.ok(row.keys.trim().length > 0, `a row has an empty key: ${JSON.stringify(row)}`);
    assert.ok(row.what.trim().length > 0, `row "${row.keys}" has no description`);
  }
});

test("no row leaks a developer note", () => {
  for (const row of SHORTCUTS) {
    assert.ok(!/[?!]|TODO|FIXME|XXX|\bno:/i.test(row.what), `row "${row.keys}" reads like a note: ${row.what}`);
    assert.ok(row.what.length <= 110, `row "${row.keys}" is ${row.what.length} chars — too long for the dialog`);
  }
});

test("every tool's documented shortcut has a row in the table", () => {
  for (const id of TOOL_IDS) {
    const label = TOOL_LABELS[id];
    const shortcut = /\(([^)]+)\)\s*$/.exec(label)?.[1];
    assert.ok(shortcut !== undefined, `tool "${id}" has no shortcut in its label`);
    const mentioned = SHORTCUTS.some((row) => row.keys.split(/\s*\/\s*/).includes(shortcut));
    assert.ok(mentioned, `tool "${id}" documents ${shortcut} but Help has no row for it`);
  }
});

test("composite rows only use the entry style the table supports", () => {
  // "Ctrl+C / Ctrl+X / Ctrl+V" and "C then Enter" are fine; anything else with
  // prose would silently stop being parseable by the coverage test.
  for (const row of SHORTCUTS) {
    if (NON_KEY_ROWS.includes(row.keys)) continue;
    for (const part of row.keys.split(/\s*\/\s*/)) {
      assert.ok(part.length <= 14, `"${part}" (from "${row.keys}") is longer than any real combo`);
    }
  }
});
