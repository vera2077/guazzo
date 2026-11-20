# B3 — derived invalidation, one preview counter, typed snapshots

Branch: `refactor/session-container` (on top of B2 `f69f4b9`)
Gate base: `b632879` (main, group model)
Gate: `✔ CI green — 52 test files / 472 tests, 70 pins, smoke, deterministic build`

## What changed

**Pixel changes are derived.** `TileGrid` takes an optional `onWrite` hook and
calls it from the same three methods that already end in `version++`
(`clearAllocated`, `fillRect`, `writeRect`); `Document.writeHook` bumps
`Document.revision`. A direct `tile.data` write goes through `grid.touch()`
(`bakeLayerMask` is the one caller). `renderFlat()` now asks
`flatCache.needsComposite(doc.revision)` and records
`markComposited(doc.revision)`; a missed pixel invalidation cannot happen
because the bump lives next to the version bump, not at 55 call sites.

**Structural changes are declared.** What writes no tile — add/remove/move,
opacity, blend mode, visibility, mask attach, flatten/merge — goes through one
helper in `main.ts`: `const declaredChange = () => { doc.revision++; flatCache.invalidate(); }`.
It moves the preview key (documents whose structure changed must re-key) and
marks the cache's declared flag. A pin asserts it is the only
`flatCache.invalidate()` in the shell.

**AQ3 closes.** `proxyKey` took `editEpoch` from `History`, which saturates at
the undo limit. It now takes `revision`, the document's monotonic content
counter; the pin names the bounded-index mistake.

**The slot bug is uncompilable.** `FlatSnapshot` is a branded metadata type
(`kind: "flat-snapshot"`); `adopt()` accepts only that, never a `FlatCache`, and
`snapshot()` carries no pixels. B2's smoke failure (the next tab resized the
slot's geometry) is now a type error.

**Opacity is one named mutation.** `src/ui/layerops.ts#setLayerOpacity(layer,
percent, doc, cache)` clamps, applies, bumps the revision and invalidates;
`opacityDialog` takes that mutation as a callback so it no longer reads the
document itself, and FC2 drives the real handler on a group child.

## Evidence

- Probes: removing the `onWrite` call from `writeRect` fails
  `FC3: a pixel primitive bumps the revision the cache key reads`
  (`1 failing of 472`); pointing the preview key back at
  `history.position` fails the pin `the preview key reads the document
  revision, not a bounded index`. Both restored.
- `coupling: 84/264 (32%)` — unchanged from the B2 baseline; the new helper is
  an arrow, and the opacity dialog stopped reading the document.
- Merge order: this branch is R6/S5 + B1 + B2 + B3; it contains `refactor/coupling-plan`'s
  measure tooling.

## Limits (stated, not hidden)

- Engine functions that replace a layer grid after `addLayer` must pass the
  document hook; the four sites in `resize.ts`, `imageops.ts` and
  `perspective.ts` do, but a future site can forget. A pin covers the hook's
  existence, not new construction sites.
- `declaredChange` still enumerates the structure list by hand. If a structural
  edit forgets it, the revision does not move — that is precisely the list the
  design keeps short enough to review.
