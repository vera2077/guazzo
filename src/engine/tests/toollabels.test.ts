/**
 * AF1: a label and a button cannot disagree because the button derives its text
 * from the label. What can still drift is the vocabulary itself — a tool added
 * without a label, a label whose shortcut is not the key that selects it, or two
 * tools sharing one title. Those are the assertions below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_IDS, TOOL_LABELS, toolTitle, type ToolId } from "../../ui/toollabels.ts";

const SHORTCUTS: Partial<Record<ToolId, string>> = {
  move: "V", marquee: "M", ellipse: "M", lasso: "L",
  polylasso: "Shift+L", pencil: "Shift+B", patternstamp: "Shift+P", mixer: "Shift+K", magicerase: "Shift+E", wand: "W", quick: "Shift+W",
  crop: "C", shape: "U", eyedropper: "I", sampler: "Shift+I", ruler: "Shift+R", count: "Shift+C", bgerase: "Shift+E", colourreplace: "Shift+Y",
  patch: "Shift+J",
  note: "Shift+N",
  magnet: "Shift+L", brush: "B", eraser: "E", bucket: "Shift+G",
  gradient: "G", heal: "J", retouch: "O", clone: "S", focus: "Shift+S", historybrush: "Y", arthistory: "Alt+Y", text: "T", pen: "P",
};

test("every tool id has a label and every label has an id", () => {
  const labelKeys = Object.keys(TOOL_LABELS).sort();
  assert.deepEqual(labelKeys, [...TOOL_IDS].sort(), "TOOL_IDS and TOOL_LABELS cover the same tools");
  for (const id of TOOL_IDS) {
    const label = TOOL_LABELS[id];
    assert.ok(label && label.trim().length > 0, `${id} has a label`);
    assert.ok(label.includes("("), `${label} names its shortcut`);
  }
});

test("the shortcut in a label is the key that actually selects the tool", () => {
  for (const id of TOOL_IDS) {
    const key = SHORTCUTS[id];
    assert.ok(key, `${id} has no documented shortcut`);
    assert.ok(
      TOOL_LABELS[id].includes(`(${key})`),
      `${id}: label "${TOOL_LABELS[id]}" must say (${key})`,
    );
  }
});

test("titles are unique, so the context-menu family list cannot be ambiguous", () => {
  const seen = new Map<string, ToolId>();
  for (const id of TOOL_IDS) {
    const name = TOOL_LABELS[id].replace(/\s*\(.*\)$/, "");
    assert.ok(!seen.has(name), `"${name}" is used by both ${seen.get(name)} and ${id}`);
    seen.set(name, id);
  }
  assert.equal(seen.size, TOOL_IDS.length);
});

test("toolTitle puts the label first and the description after an em dash", () => {
  assert.equal(toolTitle("brush"), "Brush (B)");
  assert.equal(toolTitle("brush", "paint"), "Brush (B) — paint");
});
