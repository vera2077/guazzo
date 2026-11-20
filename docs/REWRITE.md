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

## Steps

| # | Responsibility | Moves to | Status | Falsifiable acceptance |
| --- | --- | --- | --- | --- |
| 1 | modal system: `showModal`, focus trap, stack, `notify/ask/askPrompt`, `showTextDialog` | `src/ui/dialogs.ts` | **done** (R0.1 `fa69ded`) | `grep -c "function showModal" src/main.ts` = 0 (one definition lives in the module); gate green |
| 2 | menu popups, context menus, and the menu bar itself (`mountMenuBar`) | `src/ui/popup.ts` | R0.2 `5a78a29` merged; R3 `29cd25b` on `refactor/menubar-popup` | on the merged branch: `grep -rc "setCloseAllMenus\|querySelector(\".context-pop\")" src` = 0; pointerdown/Escape smoke assertions pass |
| 3 | command palette: entries, filtering, run | `src/ui/palette.ts` | **done** (R0.3 `b16e421`) | `grep -c "function openCommandPalette" src/main.ts` = 0 (definition is in the module); palette smoke passes |
| 4 | shell chrome: window buttons, find button | `src/ui/windowchrome.ts` | **next** | module exports `mountWindowChrome(host: HTMLElement)`; no `src/ui/*.ts` imports `main.ts`; `grep -c "buildWindowChrome" src/main.ts` = 0 |
| 5 | document tabs: `captureTab`, `activateTab`, `closeTab`, `renderTabs`, `createUntitledTab`, `replaceDocument`, `installDoc`, `setDocInTab` (`main.ts:3141–3560`) | `src/ui/tabs.ts` | pending | those eight live in the module; `wc -l < src/main.ts` falls by ≥ 300; coupling ≤ baseline − 6 (the currently coupled functions in this cluster) |
| 6 | history + flat cache invalidation (`renderHistoryPanel`, `applyHistoryChange`, `pushHist`, `renderFlat`) | `src/ui/history.ts`, `src/core/flat.ts` | pending | `grep -c "flatDirty" src/main.ts` falls by ≥ 15; coupling ≤ previous step − 4 |
| 7 | selection primitives (`selMask`/`selRect` users) | `src/core/selection.ts` | pending | `grep -c "selMask\|selRect" src/main.ts` falls by ≥ 20; coupling ≤ previous step − 8 |
| 8 | session container (`doc`/`activeLayer`/`history` owner) | `src/core/session.ts` | **non-goal** until `main.ts < 2,000` lines | not a step; do not start it |

Step 4 is why the old plan stalled: `buildWindowChrome` needs nine handles and
imported `topbar` from the shell, so it could not be a module without a cycle.
The rule that unblocks it is **DOM ownership**: a module may receive a host
element and own everything inside it (`mountWindowChrome(host)`), instead of the
shell passing callbacks and elements around. The static pin stays what it
already is — no `src/ui` module imports `src/main.ts`.

## What "done" costs

Each step is one handover branch off `app/main`, one commit per module, gate
green on that commit, with the branch's deletion list and acceptance evidence in
its `R<n>-handover-*.md` report. Nothing is merged by the author of the branch.
