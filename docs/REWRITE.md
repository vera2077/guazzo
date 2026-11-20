# The stepwise rewrite of `src/main.ts`

`src/main.ts` is 8,178 lines and 272 top-level functions. The rewrite dismantles
it into modules **one responsibility at a time**, each step on its own handover
branch, each step proving the gate and the same behaviour.

This file replaces the plan that lived in `guazzo-next/REWRITE.md` until R0. Two
of its claims were wrong and are corrected here:

- it measured progress in **lines moved**, which rewards moving 500 lines of
  dialogs out of the shell while the shell's coupling to document state stays
  exactly where it was;
- its step 5 ("session container, must reach 115 of 264 functions, 44 %") was not
  a step, it was the whole rewrite counted as one commit. It is now an explicit
  **non-goal** until `main.ts` is under 2,000 lines.

## The metric

```
node scripts/coupling.mjs            # coupling: 98/272 top-level functions touch document state (36%)
node scripts/coupling.mjs --verbose  # names + per-state counts
```

"Document state" is `doc, activeLayer, history, flat, flatDirty, selMask,
selRect`. `scripts/pins.mjs` fails the gate when the count **grows**
(`rewrite coupling does not grow`, baseline `98` at `78a1afe`). Lower the
constant in the same commit that moves state out; never raise it to make a
refactor fit.

## Branches and what contains what

Six branches, five still open. Containment is the only merge-order constraint:
**R6 contains R4** and **R7 contains R5**, so merging R6/R7 alone lands both.

| Branch | Commit | Base | Contains | Merge status at `afd5da6` |
| --- | --- | --- | --- | --- |
| `refactor/extract-ui` | `b16e421` | `b4ea560` | R0.1-R0.3 | merged (`59d3885`) |
| `refactor/menubar-popup` | `29cd25b` | `59d3885` | R3 | open |
| `refactor/modal-contract` | `251333f` | `c93ccd8` | R4 | open (inside R6) |
| `refactor/coupling-plan` | `a2354e7` | `78a1afe` | R5 | open (inside R7) |
| `refactor/ui-behaviour-tests` | `9d5d237` | `78a1afe` | R6 + R4 | open |
| `refactor/docs-truth` | `e1076d7` | `a2354e7` | R7 + R5 | open |

Do not cherry-pick: R4 is already in R6 and R5 in R7, so picking the files twice
duplicates `ShowModal` and the coupling pin. All numbers in this file were
measured at `78a1afe` (v0.63.1); `main` has moved past v0.66 since — rerun
`node scripts/coupling.mjs` and the gate on the tree being merged.

## Steps

Per-step line counts and the sha256 of `src/main.ts` at each extraction commit are in `docs/REWRITE-LOG.md`.

A step is done when its commit is an ancestor of `main`:
`git merge-base --is-ancestor <commit> main`. The table names the commit, so it
does not have to be edited when a branch merges — only when a step lands.

| # | Responsibility | Moves to | Evidence (commit) | Falsifiable acceptance |
| --- | --- | --- | --- | --- |
| 1 | modal system: `showModal`, focus trap, stack, `notify/ask/askPrompt`, `showTextDialog` | `src/ui/dialogs.ts` | `fa69ded` | `grep -c "function showModal" src/main.ts` = 0 (one definition lives in the module); gate green |
| 2 | menu popups, context menus, and the menu bar itself (`mountMenuBar`) | `src/ui/popup.ts` | `5a78a29`, plus R3 `29cd25b` on `refactor/menubar-popup` | once R3 is an ancestor of `main`: `grep -rc "setCloseAllMenus\|querySelector(\".context-pop\")" src` = 0; pointerdown/Escape smoke assertions pass |
| 3 | command palette: entries, filtering, run | `src/ui/palette.ts` | `b16e421` | `grep -c "function openCommandPalette" src/main.ts` = 0 (definition is in the module); palette smoke passes |
| 4 | shell chrome: window buttons, find button | `src/ui/windowchrome.ts` | — (next) | module exports `mountWindowChrome(host: HTMLElement)`; no `src/ui/*.ts` imports `main.ts`; `grep -c "buildWindowChrome" src/main.ts` = 0 |
| 5 | document tabs: `captureTab`, `activateTab`, `closeTab`, `renderTabs`, `createUntitledTab`, `replaceDocument`, `installDoc`, `setDocInTab` (`main.ts:3141–3560`) | `src/ui/tabs.ts` | — | those eight live in the module; `wc -l < src/main.ts` falls by ≥ 300; coupling ≤ baseline − 6 (the currently coupled functions in this cluster) |
| 6 | history + flat cache invalidation (`renderHistoryPanel`, `applyHistoryChange`, `pushHist`, `renderFlat`) | `src/ui/history.ts`, `src/core/flat.ts` | — | `grep -c "flatDirty" src/main.ts` falls by ≥ 15; coupling ≤ previous step − 4 |
| 7 | selection primitives (`selMask`/`selRect` users) | `src/core/selection.ts` | — | `grep -c "selMask\|selRect" src/main.ts` falls by ≥ 20; coupling ≤ previous step − 8 |
| 8 | session container (`doc`/`activeLayer`/`history` owner) | `src/core/session.ts` | — | **non-goal** until `main.ts < 2,000` lines; not a step |

Step 4 is why the old plan stalled: `buildWindowChrome` needs nine handles and
imported `topbar` from the shell, so it could not be a module without a cycle.
The rule that unblocks it is **DOM ownership**: a module may receive a host
element and own everything inside it (`mountWindowChrome(host)`), instead of the
shell passing callbacks and elements around. The static pin stays what it
already is — no `src/ui` module imports `src/main.ts`.

## What "done" costs

Each step is one handover branch off `app/main`, one commit per module, gate
green on that commit, with the branch's deletion list and acceptance evidence in
`docs/handover/R<n>-handover-*.md` (R3-R7 are there now). Nothing is merged by
the author of the branch.
