// The session owns the live undo stack: one stack per open tab, and the
// session points at the one that is open now. These tests are the contract the
// old bare global could not state — a tab switch adopts that tab's stack, undo
// and redo run it, and the panel's numbers come from the same object.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DocSession } from "../session.ts";
import type { HistoryEntry } from "../../engine/history.ts";

function entry(log: string[], label: string): HistoryEntry {
  return { label, undo: () => log.push(`undo:${label}`), redo: () => log.push(`redo:${label}`) };
}

test("SB1: push records one undoable step and the session reports it", () => {
  const log: string[] = [];
  const session = new DocSession();
  assert.equal(session.canUndo, false);
  assert.equal(session.canRedo, false);
  session.push(entry(log, "Paint"));
  assert.equal(session.canUndo, true);
  assert.equal(session.canRedo, false);
  assert.deepEqual(session.labels, ["Paint"]);
  assert.equal(session.position, 1);
});

test("SB1: undo and redo move the same stack and run the closures once each", () => {
  const log: string[] = [];
  const session = new DocSession();
  session.push(entry(log, "Paint"));
  assert.equal(session.undo(), true);
  assert.equal(session.undo(), false);
  assert.deepEqual(log, ["undo:Paint"]);
  assert.equal(session.canRedo, true);
  assert.equal(session.redo(), true);
  assert.equal(session.redo(), false);
  assert.deepEqual(log, ["undo:Paint", "redo:Paint"]);
});

test("SB1: a new edit clears the redo tail (position is the redo boundary)", () => {
  const log: string[] = [];
  const session = new DocSession();
  session.push(entry(log, "A"));
  session.push(entry(log, "B"));
  session.undo();
  assert.equal(session.canRedo, true);
  session.push(entry(log, "C"));
  assert.equal(session.canRedo, false);
  assert.deepEqual(session.labels, ["A", "C"]);
  assert.deepEqual(log, ["undo:B"]);
});

test("SB1: adopt swaps the stack a tab switch hands over, not the session", () => {
  const log: string[] = [];
  const session = new DocSession();
  session.push(entry(log, "tab-1"));
  const other = new DocSession();
  other.push(entry(log, "tab-2"));
  session.adopt(other.current);
  assert.deepEqual(session.labels, ["tab-2"]);
  assert.equal(session.position, 1);
  session.undo();
  assert.deepEqual(log, ["undo:tab-2"]);
});

test("SB1: jumpTo and clear address the adopted stack", () => {
  const log: string[] = [];
  const session = new DocSession();
  session.push(entry(log, "A"));
  session.push(entry(log, "B"));
  session.jumpTo(0);
  assert.equal(session.position, 0);
  assert.deepEqual(log, ["undo:B", "undo:A"]);
  session.clear();
  assert.equal(session.canUndo, false);
  assert.deepEqual(session.labels, []);
});
