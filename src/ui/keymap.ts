/**
 * The keyboard contract, in one place.
 *
 * Before this module the accelerators lived in two unrelated places: a chain of
 * `else if (k === "z")` inside the keydown listener, and a hand-written table in
 * Help ▸ Keyboard Shortcuts. They disagreed for months — Ctrl+Shift+S was
 * documented and did nothing, because the chain only looked at the letter — and
 * the test that "checked" it read `src/main.ts` as TEXT, which is the same as
 * checking nothing.
 *
 * So: the table below is the contract, `src/main.ts` owns a handler per action
 * id, and `src/engine/tests/keymap.test.ts` proves the two sets match exactly in
 * both directions. Adding a shortcut to the help table without an action now
 * fails the gate, and so does adding an action nobody can discover.
 */

/** Every accelerator that the controller can run. */
export type KeyAction =
  | "palette"
  | "undo"
  | "redo"
  | "copy"
  | "copyMerged"
  | "cut"
  | "paste"
  | "deselect"
  | "transform"
  | "mergeDown"
  | "exportAs"
  | "selectAll"
  | "invertSelection"
  | "autoTone"
  | "duplicateLayer"
  | "newLayer"
  | "newDocument"
  | "openProject"
  | "openImage"
  | "save"
  | "saveAs"
  | "closeTab"
  | "fitOnScreen"
  | "actualPixels"
  | "zoomIn"
  | "zoomOut";

export interface KeyMods {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * Canonical combo string: modifiers in a fixed order, then the key.
 *
 * Letters are lowercased (browsers report the shifted glyph when Shift is held,
 * so "S" and "s" must be one combo); everything else keeps its glyph because
 * "=", "+", "-" and "0" are their own keys.
 */
/**
 * Characters that already REQUIRE Shift on a US layout. With Shift held the
 * browser reports the shifted glyph ("=" arrives as "+"), so adding "shift" to
 * the combo would produce `ctrl+shift++` — a string no table row can sensibly
 * contain. AL5/AM5: the modifier is implied by the glyph, so it is not repeated.
 */
const SHIFTED_GLYPHS = new Set(["+", "_", "{", "}", "|", ":", "\"", "<", ">", "?", "~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")"]);

export function normalizeCombo(key: string, mods: KeyMods = {}): string {
  const base = key.length === 1 ? key.toLowerCase() : key;
  const impliedShift = base.length === 1 && SHIFTED_GLYPHS.has(base) && /[A-Z]/.test(key) === false;
  const parts: string[] = [];
  if (mods.ctrl) parts.push("ctrl");
  if (mods.shift && !impliedShift) parts.push("shift");
  if (mods.alt) parts.push("alt");
  parts.push(base);
  return parts.join("+");
}

/**
 * combo → action. Alt is deliberately absent: Alt+Backspace (fill) and
 * Alt-click modifiers are handled where they belong, not as accelerators here.
 */
export const KEY_ACTIONS: Readonly<Record<string, KeyAction>> = {
  "ctrl+k": "palette",
  "ctrl+z": "undo",
  "ctrl+shift+z": "redo",
  "ctrl+y": "redo",
  "ctrl+c": "copy",
  "ctrl+shift+c": "copyMerged",
  "ctrl+x": "cut",
  "ctrl+v": "paste",
  "ctrl+d": "deselect",
  "ctrl+t": "transform",
  "ctrl+e": "mergeDown",
  "ctrl+shift+e": "exportAs",
  "ctrl+a": "selectAll",
  "ctrl+shift+i": "invertSelection",
  // AS4: the Image menu advertises this on Auto Tone; it used to be inert.
  "ctrl+shift+l": "autoTone",
  "ctrl+j": "duplicateLayer",
  "ctrl+shift+n": "newLayer",
  "ctrl+n": "newDocument",
  "ctrl+shift+o": "openProject",
  "ctrl+o": "openImage",
  "ctrl+s": "save",
  "ctrl+shift+s": "saveAs",
  "ctrl+w": "closeTab",
  "ctrl+0": "fitOnScreen",
  "ctrl+1": "actualPixels",
  "ctrl+=": "zoomIn",
  "ctrl++": "zoomIn",
  "ctrl+-": "zoomOut",
  "ctrl+_": "zoomOut",
};

/** The action for this key event, or null when the key is not an accelerator. */
export function keyAction(key: string, mods: KeyMods = {}): KeyAction | null {
  return KEY_ACTIONS[normalizeCombo(key, mods)] ?? null;
}

/** What the listener saw: a modal on screen, and the element with focus. */
export interface ShortcutContext {
  modalOpen: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}

/**
 * Whose keystrokes are these?
 *
 * A dialog owns Escape/Enter, and a form field owns its letters (typing "b" in
 * a Width field must not switch to the brush). This lived as two bare `if`s in
 * the keydown listener — correct, but invisible to a test and easy to reorder.
 * Exported so the precedence itself is testable (src/ui/tests/shortcuts.test.ts).
 */
export function shortcutAllowed(ctx: ShortcutContext): boolean {
  if (ctx.modalOpen) return false;
  const target = ctx.target;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? ""))) return false;
  return true;
}

/** All action ids, for coverage checks (a Set has no order guarantees to rely on). */
export const KEY_ACTION_IDS: readonly KeyAction[] = [
  "palette", "undo", "redo", "copy", "copyMerged", "cut", "paste", "deselect",
  "transform", "mergeDown", "exportAs", "selectAll", "invertSelection",
  "duplicateLayer", "newLayer", "newDocument", "openProject", "openImage",
  "save", "saveAs", "closeTab", "fitOnScreen", "actualPixels", "zoomIn", "zoomOut",
  "autoTone",
];
