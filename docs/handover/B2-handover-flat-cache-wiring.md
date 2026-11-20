# B2 — the flat cache is wired in

**Branch:** `refactor/session-container` (stacked: B1 `56c5f5b`, B2 module `419244e`, this commit)
**Base:** `b632879` — Merge branch 'feat/psd-fidelity': inert group model, tree primitives, commands that know the parent
**Gate on this branch:** `52 test files / 470 tests, pins, smoke, deterministic single-file build`

## What changed

The live composited buffer is one `FlatCache` (`createFlatCache`) instead of a
bare `Uint8ClampedArray` plus a hand-set boolean:

- `src/main.ts`: `let flat` and `let flatDirty` are gone. `renderFlat()` asks
  `flatCache.needsComposite()`, composites into `flatCache.buffer`, then
  `flatCache.markComposited()`. Every former `flatDirty = true` is
  `flatCache.invalidate()` (55 sites across paint, transform, layer, mask,
  crop, text and history paths — the mechanical rename is the commit).
  `sampleColor` and the rect splice read the cache buffer.
- `src/ui/tabs.ts`: `TabState.flat` is a `FlatCache`; the two constructors make
  per-tab caches; `installDoc` patches a fresh cache; the tab adapter calls
  `flatCache.adopt(s.flat)` on `write` and `adopt(p.flat)` on `patch`.
- `src/main.ts` adapter: `read()` hands out the live cache; `captureTab()` in
  `tabs.ts` stores `live.flat.snapshot()` in the slot.
- `scripts/pins.mjs`: two pins, and `COUPLING_BASELINE` measured on this tree:
  `coupling: 84/264 top-level functions touch document state (32%)`
  (was 90 on main; the group move lowered it, so the baseline is lowered with it).
- `src/ui/tests/flatcache.test.ts`: FC2 mutates `doc.layers[0].children[0]`
  (a real group child) and asserts the generation moves and the cache asks for
  a composite.
- `docs/handover/B1-handover-session-history.md` is unchanged; B1's session now
  also carries the cache in tab writes (`session.adopt` + `flatCache.adopt`).

## The deviation worth knowing: slots keep a snapshot

`adopt()` deliberately clears pixels (a switch must not show the previous
document's composite). The first wiring stored the live cache object in the tab
slot; the next switch then resized the slot's geometry too, and smoke died with
`compositeRect: buffer too small` when a text-alignment handler rendered after
switching back from a 64×64 New Document to the 1024×768 one. The slot now owns
`snapshot()` — same pixels and generation, its own geometry — so `adopt()` can
stay destructive.

## Pins

1. `flatDirty is gone; the cache owns invalidation` — the identifier may not
   appear in `main.ts`, `tabs.ts` or the tab test, and main must create/adopt
   the cache and ask `needsComposite()`.
2. `only the flat cache owns a full-canvas buffer` — no `let flat =` global and
   no `flat: new Uint8ClampedArray` in main/tabs; per-tab slots use
   `createFlatCache`.

Probe: appending `// probe: flatDirty` to `src/ui/tabs.ts` fails pin 1 with
`src/ui/tabs.ts still name flatDirty; call flatCache.invalidate()` (plus the
artifact-freshness pin, because the file changed after the last build).

## Not claimed

The opacity *handler* is still in `main.ts` (`opacityDialog`); FC2 performs the
same mutation-then-invalidate sequence on a real grouped document, and pin 1
plus the 55 call sites keep the handler honest. A future slice that moves the
layer panel out of `main.ts` can drive the handler itself.
