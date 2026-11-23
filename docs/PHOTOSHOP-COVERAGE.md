# Photoshop coverage plan

Guazzo is measured against the tool and command catalogue in
`ps2024/PHOTOSHOP-2024-REFERENCE.md` and
`ps_manual/out/Photoshop-2026-Complete-Reference.md` (chapter 2 tools, chapter 4
menus, chapter 10 filters, chapter 11 colour/adjustments, chapter 5 panels).
This file is the living record: every row is a promise either kept or visibly
open. It is updated in the same commit as the code that changes a row.

**Status** — ✔ live, ◐ partial (state the limit), ✖ missing, ⌁ out of scope
(guarded: no networking, no cloud, 8-bit sRGB tile engine).

Rule: a row moves to ✔ only when a test or smoke assertion proves the behaviour,
not when a menu entry exists. Limits are written into the row, not hidden.

## A. Tools

| Photoshop tool | Group | State | Guazzo today / next step |
|---|---|---|---|
| Move | own | ✔ | drag, arrows nudge, auto-select |
| Rectangular Marquee | marquee | ✔ | Shift square, Alt from centre |
| Elliptical Marquee | marquee | ✔ | separate tool |
| Single Row / Single Column Marquee | marquee | ✔ | `marqueeShape` in the marquee options bar; a click on the press point selects the full width/height at one pixel (commit `e1615f8`, smoke asserts the bar offers both). |
| Lasso | lasso | ✔ | freehand |
| Polygonal Lasso | Shift+L | ✔ | click-to-click outline; Enter, double-click or a click on the first point closes it; Backspace removes the last point, Esc cancels. `polyselect.test.ts` + smoke |
| Magnetic Lasso | lasso | ✖ | P2 — edge snap needs a live edge map; keep separate from polygon |
| Object Selection | selection | ✖ | ⌁ approximation only, would overclaim; not planned |
| Quick Selection | selection | ✔ | grows along similar colour |
| Magic Wand | selection | ✔ | tolerance, contiguous, add/subtract |
| Select and Mask | mode | ✔ | feather, smooth, refine |
| Quick Mask | mode | ✔ | Q, painted selection overlay |
| Crop | crop | ✔ | |
| Perspective Crop | crop | ✔ | four-corner homography, premultiplied |
| Slice / Slice Select | crop | ✖ | P3 — web slicing has no viewer use case here |
| Frame | place | ✖ | ⌁ a frame is a smart-object placeholder; place + smart object covers the workflow |
| Eyedropper | sample | ✔ | picks foreground |
| Color Sampler | sampler | ✔ | Shift+I; up to **four** numbered points drawn on the overlay, each reported as `Sample n: x, y #rrggbb` in the status hint and listed in the options bar; Alt-click or Clear Samples empties the set (`main.ts` sampler branch, smoke asserts placement, numbering, the four cap and Alt-clear). |
| Ruler | sample | ✖ | **P1 (this batch)** — drag to measure, status shows distance/angle |
| Note | annotate | ✖ | P3 — needs a document annotation model |
| Count | annotate | ✖ | P3 |
| Spot Healing | heal | ✔ | |
| Healing Brush | heal | ◐ | spot mode only; sampled-source brush is P2 |
| Patch | heal | ✖ | **P1 (this batch)** — drag a selection onto a clean area |
| Content-Aware Move | heal | ✖ | ⌁ no content-aware engine; Smart Fill is a bounded fill |
| Remove | heal | ✖ | ⌁ same |
| Red Eye | heal | ✔ | retouch mode |
| Clone Stamp | clone | ✔ | Alt-click source, aligned |
| Pattern Stamp | clone | ✖ | P2 — needs a pattern picker in the options bar |
| History Brush | history | ✖ | P2 — history states exist, painting from one is a new path |
| Art History Brush | history | ✖ | P3 — stylised strokes on top of the above |
| Eraser | erase | ✔ | brush eraser |
| Background Eraser | erase | ✖ | P2 — tolerance erase with edge preservation |
| Magic Eraser | erase | ✔ | Shift+E: `eraseRegion()` takes the wand's region, narrows it to the selection, and clears it as one undoable step; tolerance from the bucket bar. `flood.test.ts` + smoke |
| Brush | paint | ✔ | |
| Pencil | B | ✔ | hard, aliased edge through the same dab engine (`stampDab`'s `hard`), no texture/noise/dynamics; B cycles Brush and Pencil. `paint.test.ts` + smoke |
| Color Replacement | paint | ✖ | P2 — paint hue while keeping luminance |
| Mixer Brush | paint | ✖ | P3 — bristle model is its own project |
| Gradient | paint | ✔ | foreground→background, linear/radial via fill layers |
| Paint Bucket | paint | ✔ | tolerance, contiguous |
| Blur / Sharpen / Smudge | focus | ✔ | three modes of Focus |
| Dodge / Burn / Sponge | toning | ✔ | three modes of Retouch |
| Pen | path | ✔ | corner + curve, closes to selection |
| Freeform Pen | path | ✖ | P2 |
| Curvature Pen | path | ✖ | P2 |
| Add / Delete / Convert Anchor | path | ✖ | P2 — needs a path point editor |
| Path Selection / Direct Selection | path | ✖ | P2 — selection only today |
| Rectangle / Ellipse / Line / Polygon / Star | shape | ✔ | five kinds |
| Rounded Rectangle / Custom Shape | shape | ✖ | P3 |
| Type | type | ✔ | horizontal, editable recipe, per-run styling |
| Vertical Type / Type Mask / Type on Path | type | ✖ | P3 — engine rasterises horizontal text only |
| Hand | view | ✔ | H, Space |
| Rotate View | view | ✖ | P3 |
| Zoom | view | ✔ | Z, click-to-zoom, zoomAt |
| 3D / Video / 360 | — | ⌁ | out of scope |

## B. Select menu

| Command | State | Note |
|---|---|---|
| All / Deselect / Inverse | ✔ | |
| Grow / Similar | ✔ | |
| Expand / Contract / Feather / Smooth / Border | ✔ | |
| Select and Mask | ✔ | |
| Colour Range | ✖ | P2 — a tolerance dialog over the whole canvas |
| Focus Area | ✖ | ⌁ |
| Subject / Sky | ✖ | ⌁ no ML model offline |
| Make Work Path | ✖ | P3 |

## C. Image menu

| Command | State | Note |
|---|---|---|
| Image Size | ✔ | bilinear |
| Canvas Size | ✔ | nine anchors |
| Image Rotation / Flip | ✔ | |
| Trim | ✔ | |
| Adjustments | ✔ | 17 live recipes |
| Auto Tone / Contrast / Colour | ✔ | |
| Mode (bit depth, CMYK, Lab) | ◐ | 8-bit sRGB only; 16-bit PSD is read through an 8-bit path and says so |
| Apply Image / Calculations | ✖ | P3 |

## D. Filters (29 live today)

Present: Gaussian/box blurs, motion, radial, zoom, pixelate families, noise,
sharpen family (sharpen/edges/more/unsharp), stylize (emboss, find edges,
solarize, tiles, trace contour, wind, diffuse), render (clouds, fibers, lens
flare, picture frame), distort (pinch, ripple, twirl, spherize, wave, zigzag,
polar), other (high pass, maximum, minimum, offset).

Open, in priority order: **Filter Gallery families** (artistic/brush strokes/
sketch/texture) are generators, not one shader — P3 as a family; **Smart
Filters** (non-destructive filter on a smart object) P2; **Lens/Field/Iris/Tilt
Shift blur** P3 (gallery UI); **Reduce Noise / Dust & Scratches / Median** P2;
**Custom 5×5 kernel** P3.

## E. Panels

Layers (tree, masks, clipping, effects), Adjustments, History (keyboard
reachable), Colour (picker + spectrum), Brush Settings (live floating panel),
Info/Histogram absent, Channels absent (masks live on layers), Paths absent,
Actions absent, Properties absent.

Priority: **Info panel / readouts** P2 (Color Sampler will surface numbers in the
status bar first), **Channels** P3, **Actions** ⌁ (scripting story is separate).

## F. Working agreement

1. One feature, one commit, with a test or smoke assertion that fails when the
   behaviour is removed.
2. Every new `src/engine/*.ts` goes into the `ORDER` list in
   `scripts/single-file.mjs`; every new `src/ui/*.ts` likewise when imported by
   the bundle.
3. The gate is run unpiped: `node scripts/ci.mjs > /tmp/ci.log 2>&1; echo CI_EXIT=$?`.
4. Rows in this file change in the same commit as the code, and the README
   feature bullets change only when the behaviour is user-visible.

## Progress log

| Date | Batch | Rows closed |
|---|---|---|
| 2026-11-23 | Plan created; README icon | — |
| 2026-11-23 | Batch 1a | Polygonal Lasso |
| 2026-11-23 | Batch 1b | Pencil |
| 2026-11-23 | Batch 1c | Magic Eraser |
| 2026-11-23 | Batch 1d | Color Sampler (four points, status readout); Single Row / Single Column marquee corrected to done (it shipped in `e1615f8` and the plan had it wrong) |
