# The stepwise rewrite of `src/main.ts`

`src/main.ts` is 7,988 lines and 263 top-level functions (measured on the phase-B slice 1 branch). The rewrite dismantles
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
node scripts/coupling.mjs            # coupling: 90/263 top-level functions touch document state (34%)
node scripts/coupling.mjs --verbose  # names + per-state counts
```

"Document state" is `doc, activeLayer, history, flat, flatDirty, selMask,
selRect`. `scripts/pins.mjs` fails the gate when the count **grows**
(`rewrite coupling does not grow`, baseline `90`; it was `98` at `78a1afe` and fell to `92` with step 5 and to `90` with phase-B slice 1). Lower the
constant in the same commit that moves state out; never raise it to make a
refactor fit.

## Branches and what contains what

All seven branches are merged. They were integrated one at a time on
`handover/integration` (R3 `cd7983e`, R4+R6+S5 `69aab1d`, S4 `0121749`, R7
`f642990`, H1 `8ee7a58`) and the result was fast-forwarded onto `main`; the
conflict resolutions are described in those merge commits. Containment was the
only merge-order constraint:
**R6 contains R4** and **R7 contains R5**, so merging R6/R7 alone lands both.

| Branch | Commit | Base | Contains | Merge status at `afd5da6` |
| --- | --- | --- | --- | --- |
| `refactor/extract-ui` | `b16e421` | `b4ea560` | R0.1-R0.3 | merged (`59d3885`) |
| `refactor/menubar-popup` | `29cd25b` | `59d3885` | R3 | merged |
| `refactor/modal-contract` | `251333f` | `c93ccd8` | R4 | merged (inside R6) |
| `refactor/coupling-plan` | `a2354e7` | `78a1afe` | R5 | merged (inside R7) |
| `refactor/ui-behaviour-tests` | `9d5d237` | `78a1afe` | R6 + R4 | merged |
| `refactor/docs-truth` | `e1076d7` | `a2354e7` | R7 + R5 | merged |

Do not cherry-pick: R4 is already in R6 and R5 in R7, so picking the files twice
duplicates `ShowModal` and the coupling pin. All numbers in this file were
measured at `78a1afe` (v0.63.1); `main` has moved past v0.66 since — rerun
`node scripts/coupling.mjs` and the gate on the tree being merged.

## Steps

Per-step line counts and the sha256 of `src/main.ts` at each extraction commit are in `docs/REWRITE-LOG.md`. A step is done when its commit is an ancestor of `main`: `git merge-base --is-ancestor <commit> main`.

| # | Responsibility | Moves to | Status | Falsifiable acceptance |
| --- | --- | --- | --- | --- |
| 1 | modal system: `showModal`, focus trap, stack, `notify/ask/askPrompt`, `showTextDialog` | `src/ui/dialogs.ts` | **done** (R0.1 `fa69ded`) | `grep -c "function showModal" src/main.ts` = 0 (one definition lives in the module); gate green |
| 2 | menu popups, context menus, and the menu bar itself (`mountMenuBar`) | `src/ui/popup.ts` | **done** (R0.2 `5a78a29`; R3 `29cd25b`) | on the merged branch: `grep -rc "setCloseAllMenus\|querySelector(\".context-pop\")" src` = 0; pointerdown/Escape smoke assertions pass |
| 3 | command palette: entries, filtering, run | `src/ui/palette.ts` | **done** (R0.3 `b16e421`) | `grep -c "function openCommandPalette" src/main.ts` = 0 (definition is in the module); palette smoke passes |
| 4 | shell chrome: window buttons, find button | `src/ui/windowchrome.ts` | **done** (S4 `d96f8de`) | module exports `mountWindowChrome(host, deps)`; no `src/ui/*.ts` imports `main.ts`; `grep -c "buildWindowChrome" src/main.ts` = 0 |
| 5 | document tabs: `captureTab`, `activateTab`, `closeTab`, `renderTabs`, `createUntitledTab`, `replaceDocument`, `installDoc`, `setDocInTab`, `flushTransient` (`main.ts:3048–3274` = 227 lines at `e1e9eb7`) | `src/ui/tabs.ts` | **done** (S5 `8296228`) | no direct global reads in the module (structural pin); coupling 92 with `COUPLING_BASELINE` lowered; four behaviour tests pass, including AA2 |
| 6 | history + flat cache invalidation (`renderHistoryPanel`, `applyHistoryChange`, `pushHist`, `renderFlat`) | `src/ui/historypanel.ts`, `src/ui/flatcache.ts` (cache done on `refactor/session-container`, wiring `e40673b`); the history panel is still in `main.ts` | **cache done**, panel pending | `flatDirty` absent from `src/` (pin); only the cache owns a full-canvas buffer (pin); a group child opacity change invalidates (FC2); `coupling: 84/264`, measured, baseline lowered to it |
| 7 | selection primitives (`selMask`/`selRect` users) | `src/core/selection.ts` | pending | `grep -c "selMask\|selRect" src/main.ts` falls by ≥ 20; coupling ≤ previous step − 8 |
| 8 | session container (`doc`/`activeLayer`/`history` owner) | `src/core/session.ts` | **phase B**, owner-directed; step 8 stays a non-goal | `docs/handover/B1-handover-session-history.md` records slice 1; each later slice lowers coupling |

Step 5 measured 227 lines, not 300: the eight bodies plus `flushTransient` occupy `main.ts:3048–3274` at `e1e9eb7`. Its acceptance is therefore the three checks in `docs/handover/S5-handover-tabs.md` — no direct global reads, coupling at 92, and four behaviour tests — not a line count.

Step 4 is why the old plan stalled: `buildWindowChrome` needs nine handles and
imported `topbar` from the shell, so it could not be a module without a cycle.
The rule that unblocks it is **DOM ownership**: a module may receive a host
element and own everything inside it (`mountWindowChrome(host)`), instead of the
shell passing callbacks and elements around. The static pin stays what it
already is — no `src/ui` module imports `src/main.ts`.

## Phase B — the session container (owner-directed)

The owner asked for phase B on a branch off `main` (no merge) because the tab
strip already behaves like a per-document session in everything but ownership.
Step 8's non-goal stands; phase B is a deliberate exception, recorded here so
the plan does not contradict itself.

Slice 1 (`refactor/session-container`, report `B1-handover-session-history.md`)
gives the live undo stack a named owner: `src/ui/session.ts` holds the stack of
the open tab (`current`, `adopt`, `push`/`undo`/`redo`/`jumpTo`/`clear`) and the
shell's bare `history` global is gone. It is shape-independent — `History` and
`HistoryEntry` do not change with the PSD group work — so this slice is not
rewritten while `Document` changes.

Next slices, one commit each, each ending a state ownership rather than a line
count: flat cache and its invalidation, the selection set, then `doc` and
`activeLayer` (the pair most functions still touch). Coupling must fall with
each; the pin is a ratchet, never a budget.

## What "done" costs

Each step is one handover branch off `app/main`, one commit per module, gate
green on that commit, with the branch's deletion list and acceptance evidence in
`docs/handover/R<n>-handover-*.md` (R3-R7 are there now). Nothing is merged by
the author of the branch.
