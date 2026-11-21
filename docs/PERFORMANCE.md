# Performance

These are measured numbers, not targets. The machine is a shared Windows
workstation; treat ratios between sizes as the signal and absolute numbers as
a snapshot of this run. Each line is the median of the script's samples.

Reproduce with:

```bash
node scripts/bench.mjs 2048
node scripts/bench.mjs 4096
node scripts/bench.mjs 8192
node scripts/bench.mjs 16384
```

`bench.mjs` builds a five-layer full-canvas document, then times the paths that
make a large document feel slow. It has no pass/fail threshold on purpose:
machines differ, and a benchmark that fails builds becomes noise.

## Full benchmark matrix

| Operation | 2048² (4.2 MP) | 4096² (16.8 MP) | 8192² (67.1 MP) | 16384² (268.4 MP) |
| --- | ---: | ---: | ---: | ---: |
| Composite 5 layers, full document | 256.8 ms | 1039.6 ms | 4104.3 ms | 16368.6 ms |
| Composite 5 layers, 512² dirty rect | 16.3 ms | 17.1 ms | 16.0 ms | 16.1 ms |
| Gaussian blur σ=8 over 1000² | 207.4 ms | 216.8 ms | 201.1 ms | 202.2 ms |
| Composite with a cached adjustment layer | 84.0 ms | 331.3 ms | 1199.4 ms | 4785.6 ms |
| `applyLevels` over the full document | 35.7 ms | 140.6 ms | 544.1 ms | 2135.9 ms |
| `sampleGrid` full read | 4.6 ms | 17.3 ms | 67.2 ms | 279.2 ms |
| Contiguous flood from the centre | 51.9 ms | 198.1 ms | 725.4 ms | 2891.7 ms |
| Preview proxy build, 20 layers | 6.9 ms | 4.1 ms | 3.1 ms | 5.1 ms |
| Preview tick, cached 420×291 stack | 11.4 ms | 13.6 ms | 10.8 ms | 10.8 ms |
| Perspective crop, full-canvas quad, 5 layers | 0.81 s | 3.39 s | 13.4 s | — |
| Select-and-mask from a select-all | 0.17 s | 0.63 s | 2.7 s | — |
| Move drag, 256 px layer on a full canvas | 0.5 ms | 0.6 ms | 0.6 ms | 0.7 ms |
| Move drag, full-canvas layer | 21.9 ms | 95.5 ms | — | — |

The dirty-rect composite stays flat because it only touches the requested
256 px tiles. Full-document composite is linear in pixels, as expected; the
useful number is that a 512² repaint does not pay for the canvas size.

## Other measured paths

- **Gaussian blur, σ=8, 1000²:** 191–217 ms across runs. It used to take
  545 ms because the clamped edge was evaluated for every tap in the interior.
- **Quick Selection, 4096²:** `magicWand` 211.5 ms for a 1000×1000 flat block,
  down from 432.6 ms in the first pass and the handoff baseline of 555 ms. The
  second click inside the cached region skips the flood and the union.
- **Autosave snapshot, 4096², 3 layers:** the old v1 path took 654–680 ms to
  serialise and deflate 268 MB of JSON into a 0.5 MB snapshot. It built one
  string, so a large enough document failed with `RangeError: Invalid string
  length` instead of writing anything.
- **Autosave v2 streaming, 4096² × 8 layers:** synthetic solid-colour layers,
  537 MB of raw pixels encoded in 3.8 s into a 0.54 MB snapshot across 257
  slices; the largest slice was 2,097,220 bytes. The decoder restored all eight
  layers with an identical pixel hash. Three tabs × 4096² × 3 layers encoded
  in 4.3 s into 0.60 MB and restored in 6.5 s. These are `node --test` numbers
  on this machine using `CompressionStream`, not browser timings; photographic
  pixels compress far less than the synthetic flat tiles. The point of the
  measurement is the shape: no whole-document string, a fixed ~2 MB slice, and
  an event-loop yield between slices.
- **PSD export-loss analysis, 8192², 3 layers:** under 20 ms. It walks roots
  only and never composites, which is why the export dialog no longer pays the
  old 4.8 s admission cost.
- **Perspective crop:** samples only the destination quad's bounding box
  (expanded one pixel for bilinear neighbours), not the whole document.
- **Move drag:** reuses one growing crop buffer; the pointer-move path no
  longer allocates a bbox-sized RGBA copy per event.

## What still costs

- A full-document composite at 16384² is 16 seconds in this environment. That
  is inherent to reading and blending 1.07 GB of RGBA per layer; the app keeps
  dirty rectangles small instead.
- The first Quick Selection click at 4096² is still about 0.2 s. Later dabs
  inside the cached region are cheap by design.
- Autosave still costs about 4 s of CPU at 4096² × 8 layers, but it is split
  into ~2 MB slices with an event-loop yield between them. That keeps the main
  thread responsive; it does not make the total work free. The numbers above
  are from Node's `CompressionStream`; browser compression may differ.

## Perspective Crop: the working set is bounded now

The warp used to copy the quad's whole bounding box into two buffers before it
sampled a single pixel — `Uint8ClampedArray(bw*bh*4)` plus
`Float32Array(bw*bh*4)`, i.e. **20 bytes per source pixel**:

| Document | Before (buffers) | After (one strip) |
| --- | ---: | ---: |
| 2048² | 84 MB | 0.5 MB |
| 4096² | 336 MB | 1.1 MB |
| 8192² | 1.34 GB | 2.2 MB |
| 16384² | **5.37 GB** | 4.4 MB |

A 16k crop therefore used to fail on allocation before it produced output. It
now reads one horizontal strip at a time (64 destination rows, source window
derived from the strip's four corners, halved automatically if a pathological
homography makes one strip reach the whole source value), and samples the bytes
directly — the float copy only ever held exact integers 0..255, so the output is
byte-identical. Verified by hashing the composited result of five quads
(identity, trapezoid, rotated, off-canvas, edge) before and after: all five
hashes matched.

Time also improved slightly at 2048² (956 ms → 0.79–0.83 s across runs); the
dominant cost is the four bilinear taps per destination pixel, which is why
removing the per-pixel `mapPoint` tuple allocation (335 M allocations for a
five-layer 8192² crop) moved the number by under 1%. The allocation is gone
because it was free to remove, not because it was the bottleneck.

## Select and Mask: the mask scratch is one tile

### Move drag: touch the union, not the canvas

`applyLayerMove` used to clear and rewrite the whole canvas on every
pointermove — a full-canvas `fill(0)`, an optional pass copying every unmasked
pixel, the translation, then a second full-canvas scan to find the bbox of what
survived, then `writeRect` of that bbox. At 16384² that is roughly 1 GB of
writes per pointermove to move a layer that is usually a small fraction of the
canvas.

The snapshot now records the content's bbox once (`snapshotGrid`), and the
rewrite touches only `bbox ∪ (bbox + delta)`, clamped to the canvas. Outside
that union the source is transparent and the result is transparent, so not
writing is the same as writing zeros. The stationary pixels (the ones the
selection excludes) are always inside `bbox`, which is why the union is
sufficient. Cost: 11.3 ms → **0.5 ms** for a 256 px layer on a 2048² canvas
(22×), 33.3 ms → 21.9 ms when the layer really is the whole canvas.

`move.test.ts` pins this against a deliberately naive full-canvas reference for
seven offsets in both masked and unmasked mode; dropping the union or the
stationary pass each fail that test.

`fillMaskFromSelection` read the selection's prior coverage into a bounding-box
sized array before seeding hidden pixels. That is 268 MB for a select-all on a
16k document, held only to be read once. It now captures one 256² tile (64 KB),
reads that tile's prior values, clears what is outside the selection, and writes
the intersection — the same six outputs (three selection shapes × hide polarity)
hash identically before and after. Wall time is unchanged within run-to-run
variance (0.16–0.22 s at 2048²).

## Two accepted limits at 16k, measured not guessed

- **A selection undo entry snapshots the whole mask.** `snapshotSelection()` calls
  `SelectionMask.clone()`, which copies the allocated tiles: 16.8 MB at 4096²,
  268 MB at 16384². Two entries per edit against the 512 MB history budget means
  a full-canvas selection on a 16k document can evict all pixel history. Fixing
  it properly is copy-on-write tiles, not a smaller buffer — do not "fix" it by
  sampling the bbox, which is what produced the wrong-mask bug in 0.73.0.
- **A Move drag rewrites the whole layer per pointermove.** The scratch buffers
  are already reused (`moveScratch`, `cropScratch`), so there is no allocation
  per event, but `out.fill(0)` plus a full `writeRect` still touches every pixel:
  ~67 MB per event at 4096², ~1 GB at 16384². The fix is to rewrite only the
  union of the old and new content rectangles; it is a behaviour-preserving
  change in the same function, and worth doing only if 16k Move drags matter.
