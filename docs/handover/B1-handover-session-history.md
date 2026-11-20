# Phase B, slice 1 — the session owns the undo stack

**Branch:** `refactor/session-container`
**Base:** `e59eae5` (v0.70.7 — portable CSP (AU5) and text recipes through geometry (AP5))
**Gate base:** `e59eae5` — 49 test files / 442 tests. **After this slice:** 50 files / 447 tests, pins 62, smoke, deterministic build — green.

## Why a slice, and why this one first

`Document` is about to gain the PSD group tree, so the parts of the session
container that describe a document's shape would be written twice. The undo
stack is not one of them: `History` / `HistoryEntry` are unchanged by the group
work, and the stack was already the one thing every content change flowed
through. Naming its owner now removes a bare global without betting on the
shape of the thing that is moving.

## What changed

`src/ui/session.ts` (new, ~95 lines): `class DocSession` with

- `current: History` — the stack of the open tab (the tab module still stores
  one `History` per slot, unchanged);
- `adopt(history)` — what a tab switch calls; the session always points at the
  open document's stack;
- `push/undo/redo/jumpTo/clear` and the read-only view the UI uses:
  `canUndo`, `canRedo`, `position`, `labels`, `editEpoch`, `bytes`.

`src/main.ts`: the `let history = new History(100)` global is gone. `pushHist`
calls `session.push(entry)` (the `quickPx` invalidation and dirty mark stay
there — they are shell concerns, not stack concerns). The edit menu, the tab
context menu and the pointer hooks read `session.canUndo/canRedo` and call
`session.undo()/redo()`. The tab adapter reads `history: session.current`,
writes `session.adopt(s.history)`, and patches through `session.adopt` — a tab
switch now hands its stack to the session explicitly instead of assigning a
global. `renderHistoryPanel`'s host reads `session.current`, `position`,
`labels` and `editEpoch` from the same object.

`scripts/single-file.mjs`: bundler order gains `dist/ui/session.js`.

## Evidence

- Tests (`src/ui/tests/session.test.ts`, 5): push records one step; undo/redo
  run each closure once and stop at the ends; a new edit clears the redo tail;
  `adopt` swaps the stack a tab switch hands over (not the session); `jumpTo`
  and `clear` address the adopted stack.
- Probe: making `adopt()` a no-op fails exactly
  `✖ SB1: adopt swaps the stack a tab switch hands over, not the session`
  (`1 failing of 447`). Restored, green.
- Structural pin (`scripts/pins.mjs`, 62 pins): "the session owns the undo
  stack" fails when main no longer creates the `DocSession`, keeps a bare
  `history` global, loses `adopt()`, stops handing a tab's stack over, or stops
  pushing through the session. Probe: replacing `session.adopt(s.history)` with
  a discard fails the pin; restored, 62/62.
- Coupling: `90/263` (was `91/263` at `e59eae5`; the pin baseline is lowered
  from 92 to 90 in the same commit — never raised).
- Gate: `✔ CI green in 16.4s — 50 test files / 447 tests, pins, smoke,
  deterministic single-file build`.

## What this deliberately does not do

`doc`, `activeLayer`, `flat`, `flatDirty`, `selRect`, `selMask`, `selGeom` and
the view state are still shell globals. That is the rest of phase B:

1. flat cache + invalidation (`renderFlat`, `flatDirty`) — no `Document` shape
   dependency;
2. the selection set (`selMask`, `selRect`, `selGeom`);
3. `doc` + `activeLayer` — the pair the majority of functions still touch; do
   this only after the PSD group work has landed, because a module that owns
   the open document will also own how layers are traversed.

## Merge notes

- Branch off `e59eae5`; touches `src/main.ts`, `src/ui/session.ts`,
  `src/ui/tests/session.test.ts`, `scripts/pins.mjs`, `scripts/single-file.mjs`,
  `docs/REWRITE.md`. Does not touch `src/engine/` (so it does not conflict with
  the PSD fidelity branch), `src-tauri/`, or `package.json`.
- Ordering: independent of the PSD group work; it can merge before or after it.
- Do not merge without the gate: the pin count and the coupling baseline are
  tied to this tree.
