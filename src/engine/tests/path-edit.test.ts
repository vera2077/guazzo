/**
 * path-edit.test.ts — the additive anchor-editing and selection→path exports.
 * Uses a locally constructed SelectionMask (no changes to shared helpers).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { editAnchor, selectionToPath, type PathAnchor } from "../path.ts";
import { SelectionMask } from "../mask.ts";

const rect: PathAnchor[] = [
  { x: 10, y: 10 },
  { x: 30, y: 10 },
  { x: 30, y: 30 },
  { x: 10, y: 30 },
];
const copy = (a: readonly PathAnchor[]): PathAnchor[] => a.map((p) => ({ ...p }));

/** Double signed area; > 0 means clockwise in document (y-down) coords. */
const area2 = (a: readonly PathAnchor[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = a[(i + 1) % a.length]!;
    s += p.x * q.y - q.x * p.y;
  }
  return s;
};

test("editAnchor delete removes one anchor, returns a new array, never mutates input", () => {
  const input = copy(rect);
  const snapshot = copy(input);
  const out = editAnchor(input, 1, "delete");
  assert.equal(out.length, 3);
  assert.notStrictEqual(out, input, "must be a fresh array");
  assert.deepEqual(out, [rect[0], rect[2], rect[3]]);
  assert.deepEqual(input, snapshot, "the caller's array must be untouched");
});

test("editAnchor corner clears the handles of only the edited anchor", () => {
  const input = copy(rect);
  input[1] = { ...input[1]!, hx: 5, hy: -3 };
  const snapshot = copy(input);
  const out = editAnchor(input, 1, "corner");
  assert.equal(out[1]!.hx, undefined);
  assert.equal(out[1]!.hy, undefined);
  assert.equal(out[0]!.x, 10, "neighbours do not move");
  assert.equal(out[2]!.x, 30, "neighbours do not move");
  assert.deepEqual(input, snapshot, "input not mutated");
});

test("editAnchor smooth derives symmetric neighbour handles", () => {
  const out = editAnchor(rect, 1, "smooth");
  assert.ok(out[1]!.hx !== undefined && out[1]!.hy !== undefined, "handles created");
  // prev (10,10), next (30,30) -> ((30-10)/6, (30-10)/6).
  assert.ok(Math.abs(out[1]!.hx! - 10 / 3) < 1e-9);
  assert.ok(Math.abs(out[1]!.hy! - 10 / 3) < 1e-9);
  assert.equal(out[0]!.hx, undefined, "other anchors stay corners");
  assert.equal(rect[1]!.hx, undefined, "input not mutated");
});

test("editAnchor dx/dy moves only the edited anchor (fails on mutation or ignored delta)", () => {
  const input = copy(rect);
  const out = editAnchor(input, 1, "corner", 7, -4);
  // Would fail if dx/dy were ignored:
  assert.equal(out[1]!.x, rect[1]!.x + 7);
  assert.equal(out[1]!.y, rect[1]!.y - 4);
  assert.equal(out[0]!.x, 10, "neighbours do not move");
  assert.equal(out[2]!.x, 30, "neighbours do not move");
  // Would fail if the input anchor had been mutated in place (input[1] is
  // still the original rect corner (30, 10)):
  assert.equal(input[1]!.x, 30, "dx/dy must not mutate the input anchor");
  assert.equal(input[1]!.y, 10, "dx/dy must not mutate the input anchor");
  assert.notStrictEqual(out[1], input[1], "edited anchor must be a fresh object");
});

test("editAnchor out-of-range index returns an unchanged copy", () => {
  const input = copy(rect);
  for (const idx of [-1, 4, 99]) {
    const out = editAnchor(input, idx, "delete", 5, 5);
    assert.deepEqual(out, rect);
    assert.notStrictEqual(out, input);
  }
});

test("selectionToPath: a rectangular selection yields 4 clockwise, handle-free anchors", () => {
  const m = new SelectionMask(64, 64);
  m.selectRect(10, 10, 20, 20);
  const p = selectionToPath(m, 64, 64);
  assert.equal(p.length, 4);
  assert.deepEqual(p, rect);
  assert.ok(area2(p) > 0, "clockwise in y-down coordinates");
  for (const a of p) {
    assert.equal(a.hx, undefined);
    assert.equal(a.hy, undefined);
  }
});

test("selectionToPath: empty and fully-covered masks return []", () => {
  assert.deepEqual(selectionToPath(new SelectionMask(32, 32), 32, 32), []);
  const full = new SelectionMask(32, 32);
  full.selectRect(0, 0, 32, 32);
  assert.deepEqual(selectionToPath(full, 32, 32), []);
});
