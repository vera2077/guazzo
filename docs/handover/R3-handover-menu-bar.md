# R3 handover — the menu bar moves into `src/ui/popup.ts`

Gate base: `59d3885` — 39 files / 386 tests


Branch: `refactor/menubar-popup` (in `app/`)
Base: `59d3885` (Merge branch 'refactor/extract-ui'; current `app/main` was `c93ccd8` when this was written — the branch merges cleanly onto it, see below)
Commit: `29cd25b` — "R3: the menu bar is src/ui/popup.ts's, not a callback the shell injects"
Gate on the branch: `✔ CI green in 7.1s — 39 test files / 386 tests, pins, smoke, deterministic single-file build`

## Why

R3 of `guazzo-handoff-next-r1.md` (finding N4). The bar's open-state and the
context menu's open-state had two owners talking through an injected callback:

- `popup.ts` held `let closeAllMenus: () => void = () => {}` and
  `setCloseAllMenus(fn)`, called at `src/main.ts` module init.
- Forgetting the injection failed silently (no type error, no test).
- `main.ts` dismissed the context pop with
  `document.querySelector(".context-pop")?.contains(...)` — a class-name string
  inside a pointerdown rule that no test could reach.

## What changed

`src/ui/popup.ts` (now 315 lines) owns the whole menu story:

- `menuOpenTitle`, `menuRoots`, `openMenu`, `closeMenus`, `refreshMenuBar`
  (was `buildMenuBar`; rebuilds so Undo/Redo/Merge availability stays fresh).
- `mountMenuBar(host, defs: () => MenuDef[])` installs the bar and the
  outside-click rule. `setCloseAllMenus` is deleted; opening a context menu
  closes the bar because both live in this module.
- `contextMenuOwns(node)` replaces the class-string query.
- `menusOpen()` for the shell's Escape guard (`ctxPop !== null || menuOpenTitle !== null`).
- The dismissal listener is on `window` (a bubbling pointerdown reaches both,
  and the smoke DOM shim only forwards window listeners, so the rule is testable).

`src/main.ts` (−78 lines): keeps `menuBarEl` and `menuDefs()` only, calls
`mountMenuBar(menuBarEl, menuDefs)` where it used to build the bar inline;
`ensureMenuBar()` re-attaches and calls `refreshMenuBar()`; Escape asks
`menusOpen()`; the import list loses `setCloseAllMenus`/`contextMenuOpen`.

Regions deleted from `src/main.ts` (line numbers at `59d3885`):
`7714–7727` (`menuOpenTitle`, `menuRoots`, `closeMenus`), `7729`
(`setCloseAllMenus(closeMenus)`), `7731–7775` (`openMenu`, `buildMenuBar`),
`7777–7781` (the startup build + the `document` pointerdown rule).

## Acceptance evidence

- `grep -rn "setCloseAllMenus" src scripts` → 0.
- `grep -rn 'querySelector(".context-pop")' src scripts` → 0.
- Smoke gains the rule as behaviour: clicking a title opens the bar, a
  `pointerdown` inside it keeps it open, one outside closes it
  (`scripts/ui-smoke.mjs`, menubar block). The harness gained `El.contains`.
- The assertions bite, verified by two temporary probes in the worktree:
  deleting the `closeMenus()` call → `SMOKE FAIL: pointerdown outside closes the menu`;
  widening the condition to close unconditionally → `SMOKE FAIL: pointerdown inside the bar keeps the menu open`.
- Existing keyboard/context-menu smoke assertions still pass (Escape closes the
  menu; About stack still closes one dialog per Escape; 386 engine tests, pins,
  deterministic build unchanged).

## Merge notes for the `app/` owner

- `git -C app merge-tree --write-tree main refactor/menubar-popup` at `c93ccd8`
  (`AI5: palette rows run their own closure…`): clean, no conflicts. R0 already
  landed AI5's code in `src/ui/palette.ts`, so the R0 ordering constraint is
  satisfied and R3 has no ordering constraint of its own.
- The worktree used to write this (`app-r3/`) is removed; the branch lives in
  `app/`. Check it out the same way as `refactor/extract-ui` if that is still
  the workflow.
- `app/`'s working tree at handover time had uncommitted AI6 edits in
  `src/main.ts`, `src/engine/mask.ts`, `src/engine/tests/mask.test.ts` and
  `scripts/ui-smoke.mjs` (palette/AI6 blocks — not the menubar block). Commit or
  stash them before checking the branch out into `app/`.
