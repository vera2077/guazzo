# R6 handover — behavioural tests for the extracted modules

Gate base: `1e9cf85 (merge of 78a1afe)` — 44 files / 409 tests


Branch: `refactor/ui-behaviour-tests`
Tip: `9d5d237` "R6: the modal, menu and palette contracts are tests, not bundle text"
Base: `251333f` (R4 `refactor/modal-contract`) + a merge of `main` at `78a1afe`

**Merge R4 first.** This branch is stacked on it because R6.1 (the New Document
refusal) lives in `scripts/ui-smoke.mjs` on that branch. `git merge-tree` against
`main` at `78a1afe` is clean.

## What changed

- `src/ui/tests/dom.ts` — a ~200-line DOM harness (elements, class lists,
  events, focus). Deliberately no layout and no `innerHTML` parsing: anything
  that needs layout stays in `scripts/ui-smoke.mjs`.
- `src/ui/tests/dialogs.test.ts` — 5 tests: Escape closes only the top of two
  stacked dialogs; a refused OK and a refused Enter both keep the dialog and
  its `.ndlg-error`; closing returns focus to the opener; Tab wraps in both
  directions.
- `src/ui/tests/popup.test.ts` — 4 tests: the context menu lands in the body
  with its first row focused; a row runs its action; Escape closes and returns
  focus; hovering a submenu parent opens a fixed, visible submenu.
- `src/ui/tests/palette.test.ts` — 3 tests: typing filters; Enter runs the
  highlighted tool; Enter runs a menu row's own closure (the AI5 contract).
- `src/ui/tests/shortcuts.test.ts` — 4 tests on the guard, not the listener.
- `src/ui/keymap.ts` — `ShortcutContext` + `shortcutAllowed()`: the two bare
  `if`s that were inline in the keydown listener (modal open, form field) are
  now one exported predicate. `src/main.ts` calls it.
- `scripts/ci.mjs` — test discovery walks `src/**/*.test.ts` instead of only
  `src/engine/tests/`; the step is named "test suite (engine + ui)". Without
  this the new files would have been silently skipped.
- `scripts/single-file.mjs` — the bundle walk excludes `*/tests/*` (test files
  and the harness are compiled by the same tsc pass but must not ship).
- `scripts/ui-smoke.mjs` — two `bundleSrc.includes` assertions about submenu
  placement are gone; the new popup test drives the placement instead.
  Bundle-text assertion count: 47 → 45.

## R6.3, resolved differently

The handoff asked to extract `dispatchKey(key, mods): Action | null` from the
300-line chain. AH5 already replaced that chain with `keyAction()` +
`KEY_HANDLERS` (one handler per action id, table in `src/ui/keymap.ts`). A
second extra layer would have been duplicate indirection, so R6 asserts the
precedence instead: Ctrl+Shift+S is `saveAs`; a modal swallows keys; INPUT/
TEXTAREA/SELECT and contenteditable swallow keys; the canvas does not.

## Evidence

- Gate on the branch: `✔ CI green in 4.8s — 44 test files / 409 tests, pins,
  smoke, deterministic single-file build`.
- The tests bite (each probe reverted after observing the failure):
  - restoring `close(); onOk();` in `dialogs.ts` → `✖ a refused Enter keeps the
    dialog open too` (1 failing of 5).
  - deleting `if (ctx.modalOpen) return false;` from `shortcutAllowed` →
    `✖ a modal swallows accelerators` (1 failing of 16).
- `tsc --noEmit` clean; `node --check` clean on the edited scripts.

## Merge notes

- The owner's uncommitted work in `app/` was not touched. Files this branch
  changes: the seven above plus the five new test files.
- After merging R4 and R6, the merged tree reports 409 tests: 393 at the merge
  point plus 16 in `src/ui/tests/`. R6.1's New Document block adds smoke
  assertions, not a test case.
