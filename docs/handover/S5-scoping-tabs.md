# Step 5 scoping — why the eight tab functions did not move in this pass

Branch: none. This is a decision memo, not a deliverable: step 5 as written
collides with the plan's own non-goal, and the collision needs the owner's call.

## What step 5 asks

Move `captureTab`, `activateTab`, `closeTab`, `renderTabs`, `createUntitledTab`,
`replaceDocument`, `installDoc`, `setDocInTab` into `src/ui/tabs.ts`;
`main.ts` −≥300 lines; coupling ≤ 92; a `tabs.test.ts` for "a tab switch commits
in-progress work and leaves no preview"; `flushTransient` should stop appearing
on both sides.

## What is actually there today (`e1e9eb7`)

- The whole tab block is `src/main.ts:3048–3274` — **227 lines**, of which the
  eight functions are ~135. The ≥300-line drop cannot come from this block
  alone; the rest is `flushTransient` + `closeGesture` (groundwork the handoff
  does not list) or unrelated code between `replaceDocument` (3253) and
  `installDoc` (3539).
- `activeTab` is referenced **9 times outside** the block and 14 inside; `tabs`
  **32 times**. The pointer/keyboard paths read the globals directly.
- The eight functions call into: `flushTransient`, `stopAnts`/`startAnts`,
  `hideContextMenu`, `clearPreview`, `render`/`renderLayers`/`renderHistoryPanel`,
  `fit`, `off` (offscreen canvas), `saveProject`, `quickExportPng`, `runTop`,
  `showContextMenu`, `iconSvg`, `Document`, `History`, `SelectionMask`, plus the
  mutable globals `doc/activeLayer/history/flat/flatDirty/selRect/selMask/selGeom/
  scale/panX/panY/autosaveDirty/docDirty/strokeSession/textSel`.

A module that "owns the tabs" therefore either receives those as ~15 callbacks
(the injection pattern R3 removed from the menu bar, at a larger grain) or owns
the globals — which is the session container.

## The contradiction

`docs/REWRITE.md` step 8 declares the session container an **explicit non-goal
until `main.ts < 2,000` lines**, precisely because "the intermediate state has
two owners of the same mutable globals — the exact bug class the rewrite exists
to remove" (§6 of the handoff says the same). Step 5 cannot move the tab state
without becoming that owner, unless the globals stay in the shell and the module
only receives accessors — in which case the import-cycle rule is satisfied but
the code has moved without the state, and the coupling count barely falls.

## Two honest designs

**A — `TabStore` over shell-owned globals (satisfies the letter of step 5).**
`src/ui/tabs.ts` exports a factory taking `{ snapshot(): TabState; restore(s):
void; deps... }`. The eight functions move; `main.ts` calls `tabStore.activate(i)`
instead of `activateTab(i)`, and every external `activeTab` read becomes
`tabStore.active()`. Cost: ~15 closures, and the state still has one owner (the
shell) so the intermediate two-owner bug does not appear. Line drop ≈ 230–260,
not 300; the acceptance would have to be amended or `flushTransient`/`closeGesture`
moved too (those drag gesture state: `strokeSession`, `healMask`, crop/drag
flags — a separate subsystem).

**B — `DocSession` (step 8 early).** A `src/core/session.ts` owns `doc/activeLayer/
history/flat/...` and tabs become views over it. This is the real destination,
but it touches every function in the shell (coupling 98 → most of it), it is the
plan's declared non-goal, and doing it before step 4 has merged means resolving
it against two moving branches.

## Recommendation

Do **A** on its own branch after R3/R4/R6 merge (they touch `main.ts` and the
smoke), with the acceptance amended to:

1. the eight live in `src/ui/tabs.ts`; `grep -c "function activateTab" src/main.ts` = 0;
2. `main.ts` falls by ≥ 220 lines (the real size of the block);
3. coupling ≤ 92 and the pin lowered in the same commit;
4. `tabs.test.ts` asserts the AA2 contract (switch calls `clearPreview` before
   the new document renders, and an in-flight stroke is committed first);
5. no new owner of the globals: `snapshot/restore` are the only crossing.

If the owner prefers B, say so and it becomes a different, larger handover — but
then the "non-goal until 2,000 lines" line in `docs/REWRITE.md` should be deleted
rather than quietly contradicted.
