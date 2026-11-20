/**
 * session.ts — the live editing session, phase B slice 1: history ownership.
 *
 * Every content change already flows through one History stack per open tab;
 * the shell used to own that stack as a bare global and hand it to the tab
 * module through read/write adapters. This module is the object that owns it
 * instead, so the stack (and the undo/redo contract built on it) has one named
 * owner rather than a global that every function reaches for.
 *
 * Deliberately narrow: doc, activeLayer, flat, selection and view state still
 * live in the shell and move here in later slices, one at a time. The stack is
 * per tab, so `adopt()` is what a tab switch calls — the session always points
 * at the stack of the document that is open right now.
 */

import { History, type HistoryEntry } from "../engine/history.ts";

export class DocSession {
  private stack: History;

  constructor(history: History = new History(100)) {
    this.stack = history;
  }

  /** the stack of the open tab (the tab module keeps one of these per slot) */
  get current(): History {
    return this.stack;
  }

  /** a tab switch: the session now speaks for that document's stack */
  adopt(history: History): void {
    this.stack = history;
  }

  push(entry: HistoryEntry): void {
    this.stack.push(entry);
  }

  undo(): boolean {
    return this.stack.undo();
  }

  redo(): boolean {
    return this.stack.redo();
  }

  jumpTo(position: number): void {
    this.stack.jumpTo(position);
  }

  clear(): void {
    this.stack.clear();
  }

  get canUndo(): boolean {
    return this.stack.canUndo;
  }

  get canRedo(): boolean {
    return this.stack.canRedo;
  }

  get position(): number {
    return this.stack.position;
  }

  get labels(): readonly string[] {
    return this.stack.labels;
  }

  get editEpoch(): number {
    return this.stack.editEpoch;
  }

  get bytes(): number {
    return this.stack.bytes;
  }
}
