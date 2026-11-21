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
