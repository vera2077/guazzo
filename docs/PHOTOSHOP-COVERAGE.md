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

**r47 scope note, updated r48:** Guazzo has no segmentation or content-aware
model offline. Model-dependent rows therefore ship only as ◐ heuristic partials:
they use deterministic colour/variance rules and say so in the UI and in their
coverage rows. They do not claim semantic detection or model-quality fills.
Real offline ML needs model weights, a runtime, licensing, CI and security work
and is out of scope until explicitly approved.

Known cosmetic Pen limits (documented, not blocking): very short Bezier
handles are drawn but not grabbable - the handle hit test deliberately defers
to the anchor centre; and a double-click landing exactly on a handle endpoint drags
that handle instead of closing the path (Enter and other double-clicks
still close).

## A. Tools

| Photoshop tool | Group | State | Guazzo today / next step |
|---|---|---|---|
| Move | own | ✔ | drag, arrows nudge, auto-select |
| Rectangular Marquee | marquee | ✔ | Shift square, Alt from centre |
| Elliptical Marquee | marquee | ✔ | separate tool |
| Single Row / Single Column Marquee | marquee | ✔ | `marqueeShape` in the marquee options bar; a click on the press point selects the full width/height at one pixel (commit `e1615f8`, smoke asserts the bar offers both). |
| Lasso | lasso | ✔ | freehand |
| Polygonal Lasso | Shift+L | ✔ | click-to-click outline; Enter, double-click or a click on the first point closes it; Backspace removes the last point, Esc cancels. `polyselect.test.ts` + smoke |
| Magnetic Lasso | magnet | ✔ | Shift+L cycles Lasso / Polygonal / Magnetic. Snaps the drawn outline onto nearby edges **on release** (radius 2–24 px), then closes it as a selection. |
| Object Selection | selection | ◐ | Select ▸ Object Selection (heuristic): GrabCut-style colour-histogram refinement seeded from the current selection rectangle; deterministic and undoable, but not semantic object detection |
| Quick Selection | selection | ✔ | grows along similar colour |
| Magic Wand | selection | ✔ | tolerance, contiguous, add/subtract |
| Select and Mask | mode | ✔ | feather, smooth, refine |
| Quick Mask | mode | ✔ | Q, painted selection overlay |
| Crop | crop | ✔ | |
| Perspective Crop | crop | ✔ | four-corner homography, premultiplied |
| Slice / Slice Select | crop | ✔ | Image menu adds slices from the selection, tiles the canvas around them, and turns a tile back into a selection; view-only guides |
| Frame | place | ✖ | ⌁ a frame is a smart-object placeholder; place + smart object covers the workflow |
| Eyedropper | sample | ✔ | picks foreground |
| Color Sampler | sampler | ✔ | Shift+I; up to **four** numbered points drawn on the overlay, each reported as `Sample n: x, y #rrggbb` in the status hint and listed in the options bar; Alt-click or Clear Samples empties the set (`main.ts` sampler branch, smoke asserts placement, numbering, the four cap and Alt-clear). |
| Ruler | ruler | ✔ | Shift+R; drag to measure — the options bar reports **W / H / D** (distance) and **A** (angle counter-clockwise from +x, as Photoshop does), the overlay draws the segment with end ticks and a distance chip, and Esc or Clear removes it. Read-only: measuring never touches pixels (`main.ts` ruler branch, `ui/rulerbar.ts`; smoke asserts the distance, the zero angle of a horizontal drag, and Esc; probes: a no-op pointerdown and a disabled Escape branch each fail it). |
| Note | note | ✔ | Shift+N. Click attaches a numbered note with text; markers are view-only and are **not** saved with the document. |
| Count | annotate | ✔ | Shift+C; numbered markers drawn on the view. Markers are view state, not document state — they are not saved with the file and reset on a tab switch. |
| Spot Healing | heal | ✔ | |
| Healing Brush | heal | ✔ | J; Alt-click samples a source point, paint restores from it with Strength; without a source it uses Spot Healing |
| Patch | patch | ✔ | Shift+J. Drag a selection onto the pixels that should replace it; the offset is copied, not searched. Needs a selection; the bar says so. |
| Content-Aware Move | heal | ◐ | Image → Content-Aware Move: exemplar patch synthesis moves the selected rectangle by an offset and fills the vacated area; deterministic partial, not semantic content awareness |
| Remove | heal | ◐ | Image → Content-Aware Remove: the same bounded exemplar patch synthesis fills a selected rectangle; deterministic partial, not semantic content awareness |
| Red Eye | heal | ✔ | retouch mode |
| Clone Stamp | clone | ✔ | Alt-click source, aligned |
| Pattern Stamp | `patternstamp` (Shift+P) | ✔ | pattern = foreground/background, checker/stripes/dots, tile + scale in the bar |
| History Brush | history | ✔ | Y; jump to a history step, Set source from current state, return to the state being edited, then paint to restore the captured pixels; size/opacity/hardness/flow are in the bar and the selection clips the stroke |
| Art History Brush | history | ✔ | Alt+Y; Set source from current state, return to the edited state, then paint with Style (tight/medium/loose) and Fidelity; the selection clips the stroke |
| Eraser | erase | ✔ | brush eraser |
| Background Eraser | bgerase | ✔ | Shift+E; drag erases pixels within **Tolerance** of the colour sampled on the first dab, the rim follows Hardness, and the whole stroke is one undo entry (`src/engine/bgerase.ts` with five tests: target erased, neighbour survives, tolerance 0 exact, soft rim partial, unmatched stroke reports null; smoke asserts the tool, both variants and the Shift+E cycle). Sampling is per stroke, not continuous — a second colour needs a second stroke. |
| Magic Eraser | erase | ✔ | Shift+E: `eraseRegion()` takes the wand's region, narrows it to the selection, and clears it as one undoable step; tolerance from the bucket bar. `flood.test.ts` + smoke |
| Brush | paint | ✔ | |
| Pencil | B | ✔ | hard, aliased edge through the same dab engine (`stampDab`'s `hard`), no texture/noise/dynamics; B cycles Brush and Pencil. `paint.test.ts` + smoke |
| Colour Replacement | paint | ✔ | Shift+Y — repaints a sampled colour while keeping each pixel's luminance; tolerance and hardness in the bar; the bar states that a true HSL swap differs on saturated ramps. |
| Colour Replacement | `colourreplace` (Shift+Y) | ✔ | Shift+Y; drag repaints pixels within **Tolerance** of the colour sampled on the first dab with the foreground colour, keeping each pixel's own brightness. Selection clips it; Hardness shapes the rim. Honest limit: this scales the target's luma rather than swapping HSL, so a saturated ramp shifts differently than Photoshop's hue-preserving swap (`src/engine/colourreplace.ts`, three tests; smoke asserts the tool, the bar and Shift+Y). |
| Mixer Brush | `mixer` (Shift+K) | ◐ | picks up the layer colour under the dab and mixes the bar colour into it (Wet); no bristle model |
| Gradient | paint | ✔ | foreground→background, linear/radial via fill layers |
| Paint Bucket | paint | ✔ | tolerance, contiguous |
| Blur / Sharpen / Smudge | focus | ✔ | three modes of Focus |
| Dodge / Burn / Sponge | toning | ✔ | three modes of Retouch |
| Pen | path | ✔ | corner + curve, closes to selection |
| Freeform Pen | mode | ✔ | Freeform checkbox on the Pen bar: drag a freehand path and release; it closes into a selection (96-point cap). Smoke asserts the bar offers it and a drag reports "Freeform path closed". |
| Curvature Pen | path | ✔ | Alt+P; click anchors, double-click or Enter closes into a selection with automatically derived smooth handles |
| Add / Delete / Convert Anchor | path | ✔ | Alt-click deletes, Ctrl+double-click toggles corner/smooth, double-click/Enter closes, Shift-drag moves; Add drops a new anchor |
| Path Selection / Direct Selection | path | ✔ | A; click/Shift-click anchors, drag to move, marquee on empty canvas, Delete removes selected anchors |
| Rectangle / Ellipse / Line / Polygon / Star | shape | ✔ | five kinds |
| Rounded Rectangle / Custom Shape | `shape` kind `rounded` + Radius slider; Custom Shape = `heart` preset | ✔ | Rounded rectangle uses the Radius bar slider; Custom Shape draws a deterministic heart. Arbitrary path import is still out of scope. |
| Type | type | ✔ | horizontal, editable recipe, per-run styling |
| Vertical Type / Type Mask / Type on Path | type | ◐ | Vertical Type and Type on Path: quarter-turned glyph raster and bend along the open pen path; Type Mask remains out of scope. Re-editing reopens the horizontal recipe. |
| Hand | view | ✔ | H, Space |
| Rotate View | view | ✔ | View menu rotates the canvas in 15° steps; view only, pixel data is unchanged |
| Zoom | view | ✔ | Z, click-to-zoom, zoomAt |
| 3D / Video / 360 | — | ⌁ | out of scope |

## B. Select menu

| Command | State | Note |
|---|---|---|
| All / Deselect / Inverse | ✔ | |
| Grow / Similar | ✔ | |
| Expand / Contract / Feather / Smooth / Border | ✔ | |
| Select and Mask | ✔ | |
| Colour Range | ✔ | Select ▸ Colour Range: fuzziness around the foreground colour over the active layer, 0–200, empty pixels skipped |
| Focus Area | ◐ | Select → Focus Area (heuristic): 5x5 luma variance plus Sobel edge energy scores sharp texture at an editable 0 to 1 threshold (default 0.2); deterministic partial, not semantic depth detection |
| Subject / Sky | ◐ | Select ▸ Subject / Sky (heuristic): a top-row colour flood grows the sky region and the subject is its complement; deterministic partial, not semantic segmentation |
| Make Work Path (Image menu) | ✔ | traces the single outer contour of any selection (including Select All, which traces the canvas border) into editable Pen anchors; holes and disjoint components are not traced |

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
| Apply Image / Calculations | ✔ | Image menu; nested pixel layers count as sources; Apply Image composites into the active layer, Calculations builds a selection from one channel; selection and opacity clip both |
| Smart Filters | smart object | ✔ | Layer / Image menu dialog with blur/sharpen/emboss/noise amounts; the stack stays editable, re-renders after transform and replace, and survives save/reload |

## D. Filters (41 live today)

Present: Gaussian/box blurs, motion, radial, zoom, pixelate families, noise
(including **Reduce Noise** — a strength-driven 5×5 median blended by
deviation from the local median, so specks vanish while hard edges survive), sharpen family
(sharpen/edges/more/unsharp), stylize (emboss, find edges, solarize, tiles,
trace contour, wind, diffuse), render (clouds, fibers, lens flare, picture
frame), distort (pinch, ripple, twirl, spherize, wave, zigzag, polar), other
(high pass, maximum, minimum, median, dust & scratches, offset, and a **Custom
5×5 kernel** dialog with 25 coefficients, Scale and Offset).

**Smart Filters** are live on a smart object: a blur/sharpen/emboss/noise stack
with amounts, re-rendered from the immutable source on edit, transform and
reopen, and saved with the project.

**Filter Gallery families** are live: Poster Edges, Colored Pencil, Rough
Pastel, Canvas Texture and Note Paper are strength-driven rows in the Filters
panel and Filter menu, honouring selections and the live preview.

**Specialty blur** adds Lens, Field, Iris and Tilt Shift: radius-driven rows
with centred or focus-band defaults, honouring selections and the live preview.

Open, in priority order: model-dependent selection families are out of
scope (see the r47 scope note above).

## E. Panels

Layers (tree, masks, clipping, effects), Adjustments, History (keyboard
reachable), Colour (picker + spectrum), Brush Settings (live floating panel),
Histogram (live, 236 px canvas, per-channel + luma with clipping stats), Info
(position, colour under the pointer, selection extent, canvas size).
Channels absent — masks live on their layer, so a channel list would have no
separable model to list. Paths are live Pen anchors, not persisted vector
objects: Make Work Path traces a selection into them and they close back into
a selection. Actions absent — no script recorder. Properties absent — the
per-layer controls live in the Layers footer.

Priority: **Channels** P3 only after a path/mask channel model exists,
**Actions** ⌁ (scripting story is separate), **Paths** ✔ for live anchor
editing; persisted vector objects remain out of scope.

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
| 2026-11-23 | Batch 1m | Magnetic Lasso (Shift+L cycles): the drawn outline is snapped to the strongest Sobel edge within the radius on release; the frame is excluded from the measure because sampling outside as luma 0 invented an edge along the border |
| 2026-11-23 | Batch 1l | Note (Shift+N): numbered view-only markers with text, cleared from the bar; the hint had to avoid `.label` because the bar files labels into the help panel |
| 2026-11-23 | Batch 1k | Patch (Shift+J): copies the selection's content from a dragged source offset, blended by the selection's own alpha; refuses without a selection rather than guessing |
| 2026-11-23 | Batch 1c | Magic Eraser |
| 2026-11-23 | Batch 1f | Background Eraser (Shift+E): per-stroke sampled colour, tolerance, hardness rim |
| 2026-11-23 | Batch 1e | Ruler (Shift+R): W/H/D/A readout, overlay line with end ticks, Esc/Clear; probing showed the bar readouts must not use `.label` — finalizeOptionsBar files labels into the help panel |
| 2026-11-23 | Batch 1d | Color Sampler (four points, status readout); Single Row / Single Column marquee corrected to done (it shipped in `e1615f8` and the plan had it wrong) |
| 2026-11-23 | 1g | Rounded Rectangle as its own shape kind (radius slider, SDF coverage, radius 0 = rectangle) | engine test + smoke assertion |
| 2026-11-23 | 1h | Pattern Stamp: the dab takes its colour from the pattern per pixel, so the stroke is a stamp and not a flat brush | engine test (both pattern colours, no flat-colour leak) + smoke (own bar, Shift+P) |
| 2026-11-23 | 1i | Mixer Brush: colour is sampled per dab from the layer and mixed with the bar colour by Wet | engine test (mix ends/clamp) + smoke (Shift+K, Wet control) |
| 2026-11-23 | r5 | integration gaps: nested smart sources, background eraser clipping to a selection, pen path on tool change, sampler/ruler/polygon across documents | unit + smoke + probes |
| 2026-11-23 | 1j | Colour Replacement (Shift+Y): per-stroke sampled target, tolerance, luma-preserving paint, selection clip | engine test (hue swap keeps luma, tolerance, clip) + smoke (tool, Tolerance bar, Shift+Y) |

| 2026-11-23 | 2 | Count | Numbered markers (Shift+C), readout in the bar, Clear Counts. View-only by design and labelled as such. |
| 2026-11-23 | Batch 1n | Histogram + Info panels: live per-channel/luma histogram guarded by the flat cache's generation, Info rows for position/colour/selection/canvas; both cells assert their values in the smoke |
| 2026-11-23 | 1k | Colour Range (fuzziness around the foreground colour, whole active layer) | engine test + menu entry |
| 2026-11-24 | r44 | Filter coverage row D corrected: Median and Dust & Scratches were already live (`filters2.ts`, `FILTERS` entries, engine test) | docs only |
| 2026-11-24 | r47-a | Reduce Noise + Custom 5×5 kernel: `filters2.ts` engine ops, one-slider gallery row, a 25-cell dialog under Filter ▸ Other, three engine tests | engine tests |
| 2026-11-24 | r47-b | History Brush (Y): snapshot source from the current state, soft dab restores pixels, undoable stroke, selection clip | engine test + tool/option wiring |
| 2026-11-24 | r47-c | Apply Image + Calculations: composite engine, Image menu dialogs, static UI pins | engine tests + pins |
| 2026-11-24 | r47-d | Path anchor editing + Make Work Path: Alt-click delete, Ctrl+double-click corner/smooth, double-click closes, Shift-drag move, selection contour trace | engine tests + pins |
| 2026-11-24 | r47-e | Review follow-ups: visible Pen anchors, double-click closes, Ctrl+double-click converts, Shift-drag moves without restyling, Make Work Path from any selection, History Brush Flow/undo, nested composite sources, shared 5x5 kernel | engine tests + pins |
| 2026-11-24 | r47-f | Final polish: full-canvas work paths, masked non-5x5 kernels, in-dialog validation, History Brush brush sliders, draggable Pen handles | engine tests + pins |
| 2026-11-24 | r47-g | Nit sweep: unambiguous Pen handle hits, persistent History Brush return step, full-coverage canvas work path | engine test + pins |
| 2026-11-24 | r48-a | Phase 0 housekeeping: README 1.18.12/1.18.13 rows and documented cosmetic Pen limits | docs + pins |
| 2026-11-24 | r48-b | Custom Shape (heart): deterministic preset in the Shape tool kind list with rounded-rectangle coverage row | engine test + pins |
| 2026-11-24 | r48-c | Rotate View: 15° canvas rotation in the View menu, inverse-mapped pointer and zoom coordinates, pixels unchanged | engine tests + pins |
| 2026-11-24 | r48-d | Slice and Slice Select: add slices from a selection, tile the canvas around them, select a tile as a selection; view-only guides | engine test + pins |
| 2026-11-24 | r48-e | Art History Brush (Alt+Y): capture a source, return to the edited state, paint deterministic stylised strokes with tight/medium/loose style and fidelity; selection clipped | engine test + tool/option wiring + pins |
| 2026-11-24 | r48-f | Curvature Pen (Alt+P) and Path / Direct Selection (A): smooth handles derived at close, anchor marquee/drag/delete with visible selection | engine tests + tool/option wiring + pins |
| 2026-11-24 | r48-g | Smart Filters: editable blur/sharpen/emboss/noise stack on a smart object, re-rendered from the source and saved with the project | engine test + IO round-trip + pins |
| 2026-11-24 | r48-h | Filter Gallery families: Poster Edges, Colored Pencil, Rough Pastel, Canvas Texture and Note Paper as strength-driven filter rows | engine test + pins |
| 2026-11-24 | r48-i | Specialty blur: Lens, Field, Iris and Tilt Shift radius rows with centred/focus defaults, selection aware | engine test + pins |
| 2026-11-24 | r48-j | Text layout: vertical glyph flow and type-on-path bending of the committed raster, honest partial coverage | engine test + pins |
| 2026-11-24 | r48-k | Object Selection (heuristic): GrabCut-style colour-histogram refinement of the current selection rectangle, labelled partial not semantic | engine test + pins |
| 2026-11-24 | r48-l | Subject / Sky (heuristic): top-row colour flood grows the sky region, subject is the complement; labelled partial not semantic | engine test + pins |
| 2026-11-24 | r48-m | Focus Area (heuristic): variance/edge-energy selection at an editable conservative threshold (default 0.2); deterministic partial, not semantic depth detection | engine test + pins |
| 2026-11-24 | r48-n | Content-Aware Move/Remove: deterministic exemplar patch synthesis for a selected rectangle, undoable, labelled partial rather than semantic content awareness | engine test + pins |
| 2026-11-24 | r48-o | Review follow-ups: bounded text-layout allocation, path-relative type placement, normalised subject/sky dimensions, buffer guards, honest immediate-apply labels, focus-threshold control and content-aware eligibility guards | engine tests + pins |
| 2026-11-24 | r48-p | Second review pass: oversized paths keep the caret origin, non-finite subject/sky dimensions rejected, overlap test asserts original source pixels, visible/validated focus threshold, keyboard-reachable disabled reasons, docs kept in step | engine tests + pins |
