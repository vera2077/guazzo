# Panel slice — the six things to check before calling it done

State at `b2e4eee`: the panel still renders a FLAT list. `src/ui/layerspanel.ts:281` walks a
layer array topmost-first; `:374-382` the uuid chip still writes `layer.groupId` (a colour tag)
and there is no indent, no collapse, no child selection. `src/ui/session.ts` owns `DocSession`
but exposes no `rows()`. Nothing below is implemented yet.

1. **Reverse per level, never the flattened array.** Root list bottom-up; for each node emit
   it, then recurse into its children bottom-up. `[...allLayers()].reverse()` puts a child
   above its parent and under the wrong group.
2. **Collapse state lives on `DocSession`, keyed by layer id.** It already owns panel view; a
   `WeakMap<DocTab, Set<…>>` inside `layerspanel.ts` would be a second registry for the same
   state. Ids, not indices — indices move.
3. **A selection inside a collapsed group must be revealed.** `activeLayer` can be a hidden
   descendant (canvas editing, Ctrl+T, reopening a project). Either expand ancestors on
   select, or have `rows()` include the ancestors of the active node. A panel that points at
   nothing is worse than a flat one.
4. **Rows are the owner's decision.** `deps.rows(): readonly { node, depth }[]` — the panel
   renders, it does not decide what is visible.
5. **Group thumbnail from `compositeLayers(children)`, cached.** Twenty groups at 6000×4000
   rebuilding a subtree composite per render will be felt; reuse the existing 1 MP cap.
6. **The chip pin must be able to fail.** Updated in the same commit, asserting the chip is a
   COLOUR TAG — one grouping concept only. If the chip still writes `groupId`, the pin is green
   on dead behaviour.

Smoke, same commit: a child row's indent > its parent's; collapsing drops the visible row
count; expanding restores it; a group row's chevron has an accessible name.

Then: PSD import, v0.71.0 tagged once at the end of `feat/panel`.

## Order to do it in (first item fails silently, so it goes first)

1. **`deps.rows()` with the reveal rule — as a pure function + test, before any rendering.**
   Build `{ node, depth }[]` from `(doc, activeLayer, collapsed)`, with collapsed ANCESTORS of
   the active node force-expanded. The test sets `activeLayer` to a grandchild whose group is
   collapsed and asserts both ancestors appear. That fails as a pure function, before the panel
   exists — the only way point 3 gets caught, since it only surfaces when `activeLayer` arrives
   from canvas editing, Ctrl+T, or a reopened project.
2. **Collapse set on `DocSession`**, keyed by layer id, carried by `adopt()`.
3. **Render from `rows()`**: reverse per level, indent `8 + depth * 14`, chevron with an
   accessible name, thumbnail from cached `compositeLayers(children)`.
4. **Chip becomes a colour tag**; update the chip pin in the same commit and confirm it fails
   if the chip writes `groupId` again.
5. **Four smoke assertions**: child indent > parent, collapse drops the visible count, expand
   restores it, chevron named.
6. Then PSD import, then **v0.71.0 tagged once at the end**.
