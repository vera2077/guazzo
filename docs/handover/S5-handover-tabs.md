# S5 handover — the tab strip and its flush contract

Branch `refactor/ui-behaviour-tests` (the R6 branch), commit `8296228`, base `e0460a0`
(the merge of `app/main` at `e1e9eb7` into R6 `9d5d237`).

```
Gate base: e0460a0 — 46 test files / 422 tests, pins, smoke, deterministic build
Gate tip:  8296228 — 46 test files / 422 tests, pins: 55/55, smoke, deterministic build
```

The branch already carries R4 (`251333f`) through R6, and the commit also carries
R5's tooling (`scripts/coupling.mjs`, the coupling pin, `docs/REWRITE.md`) because
`refactor/coupling-plan` was merged into this branch. Files are byte-identical to
R5, so merge order between R5 and this branch does not matter; R4 must be merged
first (it is in this branch's history either way).

## What moved

- `captureTab`, `activateTab`, `closeTab`, `renderTabs`, `createUntitledTab`,
  `replaceDocument`, `installDoc`, `setDocInTab`, and `flushTransient` now live in
  `src/ui/tabs.ts` (320 lines). The shell keeps the live globals; the module
  reaches them only through `TabsDeps` (`read`/`write`/`patch`, `flushTransient`'s
  pieces, paint/gesture seams, `renderAll`, menu and save callbacks).
- `src/main.ts` 8,280 → 8,104 lines. The moved block was measured at
  `main.ts:3048–3274` at `e1e9eb7`: **227 lines**, not the handoff's 300 estimate.
- `src/ui/historypanel.ts` (new): the History card's rows and the repaint after a
  jump, with the state supplied by `HistoryPanelDeps` / `HistoryChangeDeps`.
- `src/ui/newdoc.ts`: `newDocumentDialog(deps)` now owns the File > New wiring;
  main supplies one `newDocDeps` literal instead of a fourth copy of the seams.
- `src/ui/tests/tabs.test.ts`: four behaviour tests — replace/render, AA2 switch
  ordering, dirty-close confirmation, and `installDoc` vs `setDocInTab` undo.
- Bundler order gains `dist/ui/tabs.js` and `dist/ui/historypanel.js`.

## Acceptance evidence

- **No direct global reads in the module.** `scripts/pins.mjs` has a structural
  pin: with comments stripped, `src/ui/tabs.ts` may name state only in
  `TabState`'s property declarations. At this commit it holds.
- **Coupling ≤ 92.** `node scripts/coupling.mjs` →
  `coupling: 92/266 top-level functions in src/main.ts touch document state (35%)`.
  `COUPLING_BASELINE` is lowered from 98 to 92 in the same commit.
- **Four behavioural tests, AA2 included.** `src/ui/tests/tabs.test.ts` proves the
  switch clears the preview, flushes (commitText/transform/stroke/gesture) before
  the swap, keeps the outgoing slot's dirty flag, and restores the other document.
- **The AA2 assertion bites.** Inverting the order (`flushTransient()` then
  `clearPreview()`) makes the suite print
  `✖ AA2: a switch clears the preview and finishes the outgoing work before restoring`
  and the gate exit non-zero. Restored afterwards.

## Deliberate deviations, stated plainly

1. The line-count acceptance was replaced (per the owner's decision) by the three
   checks above; 227 is the measured block and is reported as such.
2. `flushTransient` moved too. It is not one of the eight, but it is the only
   caller-facing contract a tab switch/close needs, and nothing else calls it.
3. The History panel and the File > New host moved in the same commit. They are
   genuine module moves (the panel's DOM, the dialog's wiring), and they supplied
   the last four coupled functions; without them the measured count is 96, above
   the 92 target.

## Merge notes

- `git -C app merge-tree --write-tree main refactor/ui-behaviour-tests` against
  current main `60483e2` is clean (exit 0).
- The branch was built in worktree `app-tabs`; the owner's dirty files in `app/`
  were never touched.
