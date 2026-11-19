/**
 * The Help dialog must not teach shortcuts that do not work.
 *
 * This test reads `src/main.ts` as TEXT and checks the documented accelerators
 * against the key chain that actually dispatches them. It is a lint, not a
 * behaviour test — it cannot prove Ctrl+Shift+S does what the row claims — but
 * it does catch the failure that actually happened: a row (Ctrl+Shift+S, and a
 * non-existent Ctrl+Shift+L) that no branch ever handled, and a row that leaked
 * a developer note into the UI.
 *
 * Reading the source is deliberate. The dispatcher lives in `main.ts`, which
 * needs a DOM and cannot be imported here; extracting the key chain into a pure
 * module is the better long-term fix (Phase B of the analysis plan), and this
 * test should be rewritten against it then.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NON_KEY_ROWS, SHORTCUTS } from "../../ui/shortcuts.ts";
import { TOOL_IDS, TOOL_LABELS } from "../../ui/toollabels.ts";

const SRC = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");

/** Split "Ctrl+C / Ctrl+X" into individual combos. */
function combos(keys: string): string[] {
  if (NON_KEY_ROWS.includes(keys)) return [];
  return keys.split(" / ").map((k) => k.trim());
}

/** The key a combo ends in: "Ctrl+Shift+S" → "S", "[ " → "[". */
function baseKey(combo: string): string {
  const parts = combo.split("+");
  return parts[parts.length - 1]!.trim();
}

/**
 * Tokens that are dispatched by name rather than by a single-letter comparison.
 * Each entry says what the source must contain for the row to be honest.
 */
const NAMED: Record<string, string[]> = {
  Esc: ['e.key === "Escape"'],
  Enter: ['e.key === "Enter"'],
  Delete: ['e.key === "Delete"'],
  Backspace: ['e.key === "Backspace"'],
  Space: ['e.code !== "Space"'],
  Tab: ['e.key === "Tab"'],
  Menu: ['e.key === "ContextMenu"'],
};

/**
 * True when the dispatcher compares this key in the right context.
 *
 * The distinction matters: the Ctrl branch compares the lower-cased `k`, while
 * plain keys are compared against `e.key`. Conflating them is what let
 * Ctrl+Shift+L look "handled" — `L` is the lasso key, but nothing reads it with
 * Ctrl held, so the shortcut a user pressed did nothing.
 */
function isHandled(base: string, ctrl: boolean): boolean {
  const named = NAMED[base];
  if (named) return named.every((needle) => SRC.includes(needle));
  if (base === "F10") return SRC.includes('e.key === "F10"');
  if (base.length !== 1) return false;
  const lower = base.toLowerCase();
  if (ctrl) return SRC.includes(`k === "${lower}"`);
  return (
    SRC.includes(`e.key === "${lower}" || e.key === "${base}"`) ||
    SRC.includes(`e.key === "${base}"`) ||
    // tool keys are chained one-comparison-per-letter in some branches
    SRC.includes(`k === "${lower}"`)
  );
}

test("every documented accelerator is handled by the key chain", () => {
  const unhandled: string[] = [];
  for (const row of SHORTCUTS) {
    for (const combo of combos(row.keys)) {
      const ctrl = /\b(Ctrl|Cmd)\b/.test(combo);
      if (!isHandled(baseKey(combo), ctrl)) unhandled.push(`${row.keys} (${row.what})`);
    }
  }
  assert.deepEqual(unhandled, [], `these rows teach shortcuts nothing handles: ${unhandled.join(", ")}`);
});

test("every tool's documented shortcut has a row in the table", () => {
  const documented = new Set<string>();
  for (const row of SHORTCUTS) for (const combo of combos(row.keys)) documented.add(combo);
  const missing: string[] = [];
  for (const id of TOOL_IDS) {
    const label = TOOL_LABELS[id];
    const shortcut = /\(([^)]+)\)$/.exec(label)?.[1];
    if (!shortcut) continue;
    if (!documented.has(shortcut)) missing.push(`${label}`);
  }
  assert.deepEqual(missing, [], `tools whose shortcut is not in Help: ${missing.join(", ")}`);
});

test("no row leaks a developer note", () => {
  for (const row of SHORTCUTS) {
    assert.doesNotMatch(row.what, /\?|TODO|FIXME|XXX|no:/i, `row "${row.keys}" reads like a note, not help: ${row.what}`);
    assert.ok(row.what.length <= 90, `row "${row.keys}" is too long for the dialog (${row.what.length} chars)`);
  }
});

test("every Ctrl-combo the dispatcher handles is documented", () => {
  // the Ctrl branch compares lower-case letters to `k`
  const handled = new Set<string>();
  const re = /k === "([a-z0-9=+\-])"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC)) !== null) handled.add(m[1]!);
  const documented = new Set<string>();
  for (const row of SHORTCUTS) {
    for (const combo of combos(row.keys)) {
      if (!/\bCtrl\b/.test(combo)) continue;
      const base = baseKey(combo).toLowerCase();
      documented.add(base);
      // browsers report Ctrl+= as "=" or "+" depending on layout, and the
      // dispatcher handles both spellings of the zoom-in key
      if (base === "=") documented.add("+");
    }
  }
  // shortcuts are documented with the modifier, so check the base keys
  const undocumented = [...handled].filter((k) => !documented.has(k));
  assert.deepEqual(undocumented, [], `dispatcher handles Ctrl+${undocumented.join(", Ctrl+")} but Help never mentions it`);
});

test("SABOTAGE: a bogus row is caught", () => {
  // proves the lint has teeth; the real table never contains this
  const bogus = { keys: "Ctrl+Shift+L", what: "Levels" };
  assert.equal(isHandled(baseKey(bogus.keys), true), false, "Ctrl+Shift+L must not be considered handled");
});
