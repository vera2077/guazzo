# Guazzo

*Guazzo — the Italian word the French *gouache* was borrowed from; watery paint.*

A fully-offline, Photoshop-like image editor. No accounts, no cloud, no network —
the app never makes a single network request.

## Run it

| How | What |
| --- | --- |
| **Desktop app** | Run `Guazzo-v0.30.0.exe` — keep `WebView2Loader.dll` (160 KB) in the same folder; both files ship together (Windows 10/11 — the WebView2 runtime itself is built into Windows; only this small loader stub is external, because the MinGW toolchain links it dynamically) |
| **Single file** | Open `app-single.html` in any modern browser — same app, one HTML file (~1.6 MB), runs from a USB stick |
| **Dev server** | `node scripts/serve.mjs` → http://127.0.0.1:5188/ |

> **Never run the exe as administrator.** An elevated run creates the app's
> WebView2 data folder (`%LOCALAPPDATA%\Guazzo\WebView2`) with Administrators
> ownership, after which normal launches fail to write it and exit. Launch
> normally and it stays healthy. If a launch ever fails you'll now see an
> error dialog instead of a silent exit — report its text and it can be fixed.
>
> **Rebuilding inside a sandboxed workspace:** files there can inherit a **Low
> integrity label**, and Windows runs a process at its exe's label — a
> Low-integrity Guazzo cannot write its WebView2 data folder (`os error 5`,
> "nothing launches unless admin"). The shipped exes are labeled Medium. After
> rebuilding from source in such a tree, relabel the outputs:
> `icacls Guazzo.exe /setintegritylevel medium` (and on
> `WebView2Loader.dll`).

**v0.13.2 — code-quality pass (from the whole-project review).** Six real bugs
found by reading the controller rather than by testing it:

- **Typing in a dialog no longer edits your picture.** The keyboard handler had
  no focus guard, so "b" in a Width field switched tools, Backspace erased pixels
  behind the modal, Enter applied a pending crop and Ctrl+Z undid the document.
- **Layer undo targets the layer you changed.** Blend-mode and opacity undo
  closures captured "the active layer" instead of that layer, so switching layers
  then undoing mutated the wrong one.
- **Autosave can no longer lose a stroke.** Dirty flags are cleared before the
  first `await` and restored if the write fails; an in-flight guard stops two
  ticks from racing for the same file; a parked text box no longer blocks saving.
- **Switching tabs cancels gestures.** A crop drawn on tab A could be applied to
  tab B with Enter; drags, lassoes and strokes are now all closed on tab switch.
- **A lost pointerup can't make the next stroke un-undoable** — a dangling stroke
  session is closed before a new one starts, and a live text box commits before
  any early return in the pointer handler.
- **Documents are capped at 16384 px per side** (was 30000). The compositor keeps
  one flat RGBA buffer and Canvas2D stops drawing past that, so 30000 px meant a
  blank canvas and a 3.6 GB allocation; the dialogs now refuse instead.

Also: the duplicated fill-compositing loop moved out of the controller into
`src/engine/plane.ts` (`fillPlane`), where it is tested against the same blend
maths the rest of the engine uses (6 new tests, 154 total).

## Name & trademarks

> Guazzo is an independent product. It is not affiliated with, endorsed by, or sponsored by Adobe Inc. Photoshop® and .PSD are trademarks of Adobe Inc.; Guazzo reads and writes .PSD files using the openly published Photoshop File Format Specification. All other trademarks belong to their respective owners.

## What changed in v0.30.0 — text tool bounding-box rework
- **Professional selection box**: clicking a text layer now shows a 1px dashed frame (dark blue over white, so it reads on any canvas) with exactly **8 solid 8×8 white handles** — 4 corners plus 4 edge midpoints, no background fill.
- **Selection vs. editing**: a single click selects (frame + handles, no caret); a **double click enters editing** — the handles hide and the caret blinks where you clicked. Click outside, press Escape or switch tools to commit.
- **Live reflow**: dragging the left/right (or corner) handles resizes the box width and the text **re-wraps in real time**; top/bottom handles set the box height (a red marker shows when the content overflows); corners scale both.
- **Move**: dragging anywhere inside the selected box moves the whole text layer (also nudges with the arrow keys via the Move machinery).
- **Cursors**: `nwse`/`nesw`-resize on corners, `ew`/`ns`-resize on edges, a move cursor inside the selected box, an I-beam while editing.
- **Persistence**: box wrap width and height are stored in the layer's text metadata and survive project Save/Load (round-trip tested).
- The old floating black drag-square with the four-way arrow is gone.

## What changed in v0.29.0 — editor-round fixes
- **Colour picker**: added a full spectrum — a saturation/value field plus a hue strip above the hex row. Draggable markers, and slider/hex edits re-sync the markers.
- **About dialog**: the "tile-based engine" line now wraps instead of overflowing the dialog.
- **Adjustments palette**: no longer opens a centered modal that blurs the canvas. The palette itself now carries a dropdown of every adjustment; picking one builds its controls **inline in the same floating window** (sliders, a live curve editor for Curves, preset swatches for Photo Filter, Gradient Map endpoints pick through the in-app picker). Apply runs non-destructively into the layer with one undo entry; the canvas stays visible while you work.
- **Layer panel collapse**: a collapsed card now fully collapses — remembered heights are released and the grow-card no longer leaves an empty box behind.

## What changed in v0.28.0 — renamed from Pigment to Guazzo

Renamed from Pigment to Guazzo before first release. No feature changes.

Companion compliance items landed in the same release (see "Name & trademarks"
below): a proprietary EULA (`LICENSE`), full third-party license texts
(`THIRD-PARTY-NOTICES.md`, also embedded in the About dialog), the ag-psd
vendor banner now carries its MIT copyright, and the Edit menu's inpainting
command is called **Smart Fill** (classical patch-based, not an Adobe feature).

## What changed in v0.27.0 — nine reported defects fixed

| # | Report | Fix |
|---|--------|-----|
| 1 | "make the color picker native to the app" | The toolbar well is now a Guazzo-styled button opening an **in-app colour popover**: live preview, hex field, R/G/B sliders, Cancel (restores) / Done. No OS picker anywhere. |
| 2 | right-click on size/hardness fields shows irrelevant items | Fields now get the **in-app edit menu** (Cut / Copy / Paste / Select All) instead of the browser's native menu. |
| 3 | About dialog too wide, Cancel/OK both irrelevant | About uses a **narrow (340 px) modal with a single OK button**. |
| 4 | sliders wrap into a second row on the options bar | A **`>` pager button** hides the overflow behind page 2 and flips to `<` to return; switching tools resets to page 1. Layout-driven, so it appears only when a tool actually overflows. |
| 5 | blur/sharpen and dodge/burn icons near-identical | Dodge redrawn as the **classic paddle** (disc + handle), blur keeps the radiating tick circle. |
| 6 | "reset panel layout" kills panel collapse | Root cause: `resetDock` re-docked cards and **double-bound the head listener** (every click toggled twice = net zero). Listeners now bind once per card (`dockBound`), chrome (chevron/grip) rebuilds idempotently, and a live registry replaces the stale closure. |
| 7 | Adjustments should be a movable in-editor popup | **Floating Adjustments palette**: draggable by its title bar, clamped inside the app window (no OS window, no taskbar icon), listing every adjustment; each Image ▸ Adjustments item opens the same palette and fires that adjustment. |
| 8 | flatten image makes the toolbar disappear | Root cause: `flattenImage()` never swapped the live layer stack — the panel showed stale rows and the toolbar state desynced. The live stack is now `[Flattened]`, with undo/redo restoring the previous stack. |
| 9 | layer thumbnails broken | Same root cause as #8 — the stale panel rows carried dead thumbnails. Flatten now leaves exactly one row with one live thumbnail. |

Smoke-gated: the sweep asserts reset-then-collapse, the colour popover open/Done, the field menu items, the palette (22 buttons) and About's single OK — all in `scripts/ui-smoke.mjs`.

## What changed in v0.25.5 — fold-back returns to the real one-column size

- The `<` (fold) button now snaps the toolbar back to its **proper 50 px single-column width** instead of shaving just a few pixels off the wide column (the old code only clamped the width to ≤ 88 px, so a previously widened toolbar barely shrank). Expanding with `>` likewise opens the standard 96 px two-column width, and the automatic compact/expand snaps the same way. The right-edge grip remains free-drag for custom widths.

## What changed in v0.25.4 — ResizeObserver loop artifact fixed

- Launching (or resizing into a mode flip) no longer produces the browser's `"ResizeObserver loop completed with undelivered notifications"` error — which our boot banner was treating as a real crash and painting in red. Root causes removed, not just silenced: the toolbar fit-checker no longer flips layout classes synchronously inside an observer delivery (the one-column height is cached and refreshed when the mode actually passes through it), and the compact/expand flip itself is deferred to the next animation frame so the observed toolbar is never resized by its own callback.
- As a belt-and-braces backstop, the two known benign ResizeObserver artifact messages are filtered before the boot banner can see them.

## What changed in v0.25.3 — toolbar chrome redo

- **Compact toggle moved to the top as one small button** — it shows `>` when one click widens the toolbar to two columns and `<` when it folds back to one; the same button drives both settings (auto-resize behaviour unchanged).
- **Colour picker is now a STATIC centred row** pinned below the tool scroller — it can no longer ride inside the scroll list, disappear under a button, or stick to the left; it stays put at every window size and in both column modes.

## What changed in v0.25.2 — colour picker placement

- The colour picker now **rides with the tools, directly below Text and Free Transform, centred** — instead of being pinned as a full-width row above the footer. In compact two-column mode it still keeps its own full-width row (never squeezed into a grid cell), centred.
- Smoke-test hardening: a stale toolbar lookup (searching `#toolbar` direct children for the Shape tool after buttons moved into the tool scroller) was caught and fixed; the smoke gate now records the true exit status.

## What changed in v0.25.1 — toolbar layout + automatic two-way compaction

- **Auto-compact AND auto-expand on window resize** — when the tools stop fitting vertically the toolbar compacts to two columns; when the window is tall enough again (with a row of slack so the boundary stays stable) it returns to one. A manual click or grip-drag choice wins until the fit situation actually changes.
- **Alignment fixed** — compact mode is now a strict two-column CSS grid instead of a flex wrap, so both columns line up pixel-perfectly (no more ragged rows).
- **Pinned footer** — the compact toggle always sits docked to the **bottom-left** corner; the tool list scrolls in its own area above it, so the toggle and the colour picker are never scrolled away or overlapped.
- **Colour picker placement** — the picker sits right below Text / Free Transform, centred (v0.25.2); in compact mode it spans its own full-width row instead of one grid cell.

## What changed in v0.25.0 — right-click context menus

Photoshop-style context menus on every surface, plus the clipboard they need:

- **Canvas right-click** — Undo/Redo, Cut / Copy / Copy Merged / Paste, Select All / Deselect / Inverse, Fill with Foreground, Clear, Crop to Selection, Quick Export as PNG, Export As… (items grey out when they don't apply).
- **Layers panel right-click** — New / Duplicate / Delete, Rename, Hide/Show, Lock/Unlock, **Blending ▸ (all 27 modes with a check mark)**, Layer Opacity…, Create/Release Clipping Mask, Add / Apply / Delete Layer Mask, Merge Down, Flatten, Rasterize Type (text layers), Quick Export as PNG, Export As…
- **History panel right-click** — Step Backward / Forward to a row, Clear History.
- **Document tab right-click** — Close Tab, Close Other Tabs, Save Project, Quick Export as PNG, Export As…
- **Toolbar right-click** — the Photoshop flyout: family tools grouped (Selection / Painting / Retouching) with the active one checked; pick without hunting for the shortcut.
- **Colour swatch right-click** — Delete Swatch, Clear All Swatches.
- **Internal clipboard** — Ctrl+C / Ctrl+X / Ctrl+V plus **Ctrl+Shift+C Copy Merged** (all layers) and matching Edit-menu items; pasting arrives as a centred new layer, one undo step. No OS clipboard is touched — the data stays in the app.
- Menus close on Escape, on any click outside, or after running an item; the browser's own right-click menu is suppressed except inside text fields.

## What changed in v0.24.1 — robust toolbar

- The compact toggle is now a **pinned footer row** (opaque, bordered, full-width) — scrolled tools pass *under* it instead of visually overlapping it in small windows.
- **Widening the toolbar past 92 px automatically compacts to two columns; shrinking back below 92 px returns to one** (edge-triggered, so a wide single column dragged within its range keeps its mode).
- A small window (tools no longer fitting vertically) **auto-compacts once**; going back to one column is your call via the footer button — no oscillation.
- The View ▸ toggle and the footer button now share one code path, and the persisted width always matches the mode you chose.

## What changed in v0.24.0 — handoff-2 hardening pass

Second external review (handoff round 2), executed end to end:

- **Geometry ops keep every layer recipe** — rotate / flip / crop / resize / transform now clone adjust specs, fill colours, clipping, groups and *layer masks* (masks resample premultiplied; previously Curves silently became Levels and fill layers whitened).
- **Import caps enforced loudly** — PSD/project files larger than 16,384 px now raise a clear alert instead of silently clamping or blanking.
- **PSD export round-trips masks + clipping** — layer masks are baked into exported alpha, clipped layers export as PSD clipping layers, verified by a full byte-level write→read→composite test with the real ag-psd.
- **Adjustment layers match the dialogs** — four real algorithm drifts fixed (threshold now decides on luma, colour-balance/black-white/photo-filter mirror tone.ts, float32 scratch → float64 so rounding agrees bit-for-bit).
- **One-command pipeline** — `npm run desktop` (in-process tsc → version-lockstep assert → guarded single-file bundling → syntax check → desktop-dist freshness), plus a cargo-side `build.rs` guard that panics with an actionable message when the web build is stale.
- **History is byte-budgeted** — undo memory is capped at 512 MB (one entry always survives), not just 100 entries; snapshot entries report real bytes.
- **Move drags reuse one scratch buffer** instead of allocating a full-document buffer per pointermove (~67 MB/event at 4096²).
- **Pixelate is premultiplied** and sharpen no longer mutates alpha; non-separable blend modes run scalarized (no per-pixel array allocations).
- **Test hygiene** — shared `eq` helper, honest deepEqual call sites, dead assertions removed, `layers.test.ts` → `composite.test.ts`, interleaved undo integration test.
- **git repo** scoped to `app/` (excludes build outputs; commits the vendored ag-psd bundle), lockfile purged of the dead vite/esbuild zoo.

## What changed in v0.23.0 — handoff review fixes

A full external review (handoff round 1) was triaged and landed:

| Area | Fix |
| --- | --- |
| **Export (critical)** | PNG/JPEG export at 100 % no longer clears the shared composite cache (was: white JPEG + blank canvas until the next edit) — the scaled canvas is always a fresh buffer. |
| **Blur / Sharpen brush** | The 3×3 kernel now averages **premultiplied** colour, so blurring a stroke edge on a transparent layer no longer paints dark halos; regression-tested. |
| **Tonal ops × selection** | Adjustments/filters applied through a feathered selection now blend continuously with mask coverage instead of snapping at the 50 % threshold. |
| **Spot Healing** | Semi-transparent hole fringes keep their own alpha (were forced opaque). |
| **Red Eye brush** | Honours the selection mask like every other retouch dab. |
| **Hardcoded tile size** | `tone.ts` ×2 and `document.ts` ×1 now import `TILE`, so a future tile-size change cannot silently corrupt indexing. |
| **Gesture hygiene** | One shared `closeGesture()` — tab switch or window blur now COMMITS an uncommitted heal/shape/move instead of dropping it; smoothing catch-up runs before the mask undo capture so redone strokes keep their final dab. |
| **Quick Selection** | The per-dab full-document pixel snapshot (≈67 MB at 4096²) is taken once per drag now. |
| **Viewport** | `resize()` keeps zoom and the viewport-centre document point instead of re-fitting. |
| **Build trust** | `scripts/single-file.mjs` refuses stale `dist/`, strips multi-line imports correctly, escapes `</script` and can no longer be corrupted by `$&`/`$'` in source; proven by sabotage tests. |
| **Smoke trust** | `scripts/ui-smoke.mjs` asserts instead of logging: the export path is now covered (1 blob, shared-canvas resizes = 0) and missing targets fail the run. |
| **Focus ring** | Inputs/buttons/sliders show a 2 px accent outline (WCAG 1.4.11; the old accent-line ring measured only 1.97:1). |
| **Boot banner** | Startup errors are capped at 3, reported even before `<body>` exists, and `unhandledrejection` feeds the same banner. |

273/273 engine tests, headless UI smoke green, `tsc` strict-clean.

## What changed in v0.22.0 — ten reported problems fixed

Everything here came from real use of v0.21.0, so each fix names the symptom first.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Middle-drag left the canvas glued to the cursor forever | the pan never tested whether the button was still down | panning now ends on `pointerup` / `pointercancel` / `pointerleave` / window blur — and a **middle click that does not move** toggles a sticky pan mode (click again to release) |
| Spot Healing left visible grain and rings | the old filler accumulated per-pixel guesses; mask edges above 128 were hard-cut | rewritten as a two-stage classical inpainter: Jacobi diffusion seeds the hole, then **onion-peel exemplar fill** copies real 7×7 neighbourhoods outward from the rim (Photoshop's content-aware idea), with a per-patch mean offset so gradients survive. Soft brush edges are now **feathered** instead of cut |
| Clicking a layer in the panel started resizing it | layer rows bound double-click to Free Transform, so a fast click could land as a double-click | row-level transform removed; double-click on the name renames. Transform stays on the strip button and Ctrl+T |
| Magic Wand selections had no marching ants | ants were only drawn for rectangular selections | `SelectionMask.outline()` computes merged border runs (cached, invalidated on edit) and the overlay ants every non-rect selection |
| The Shape tool preview was always a rectangle, stroke colour was fixed, shapes appeared late | one preview branch, stroke hard-wired to the background colour, and each commit snapshotted **every** tile of the layer | preview now follows the chosen kind (rect / ellipse / line / polygon / star, honouring sides and inner ratio) with a **fill and stroke colour picker** in the options bar, and commits go through the new rect-scoped `layerOpCommandIn` so only the touched tiles are copied |
| The layer action strip appeared three times | `renderLayers()` appended buttons without clearing the strip | the strip is rebuilt (`innerHTML = ""`) on every render |
| A brush stroke sometimes appeared right after Alt-Tabbing back | a lost `pointerup` left `painting` true, so the next pointer move painted | `pointermove` ends a stale stroke when `buttons === 0`, and window blur ends it too |
| Image/Filter menus were clipped by the panel column | the menu popup was constrained by the topbar's stacking context and height | topbar is `z-index: 300`, popups `z-index: 320` with their own scroll area, so they float over the tabs |
| No way to make the toolbar compact | the toolbar was a fixed 50 px single column | drag its right edge to resize (44–180 px), or click the column button / View ▸ Two-Column Toolbar for a compact two-column rail. The choice persists |
| No way to organise a flat stack | the layer model had no grouping concept at all | every layer has an optional flat `groupId` (saved in projects). Click the row's group chip to cycle G1…G6 — matching ids tint and band together, which makes **fake groups** and clip stacks visible. Clipped rows get an indent and a `↳`, and the layer they clip to gets a rule under it |

Engine additions: `history.captureTilesIn` / `layerOpCommandIn` (rect-scoped snapshots), `SelectionMask.outline()` with a version cache, `shapes.shapePolyline()`, and the rewritten `heal.ts` (14 tests, including a feathered-edge case and a texture-preservation case).

## What changed in v0.21.0 — Spot Healing + Content-Aware Fill

Two retouching features that Photoshop users reach for constantly, both implemented locally
and deterministically — no model weights, no downloads, no randomness between runs.

- **Spot Healing Brush (`J`)** — paint over a blemish and the pixels underneath are rebuilt
  from their surroundings when you release. The stroke collects a feather-edged hole mask
  (size + hardness in the options bar); on release the engine synthesises a replacement and
  the whole stroke is **one undo step**. Aimed at dust, sensor spots, small distractions and
  skin blemishes rather than large object removal.
- **Edit ▸ Content-Aware Fill** — rebuilds the entire active selection in one action, with the
  same engine tuned for larger areas (wider donor search, more synthesis passes).
- **How it works** (`src/engine/heal.ts`, ~330 lines, no dependencies): the hole is first
  *diffused* — a few Jacobi passes that average known neighbours and propagate inward — which
  gives the synthesis a plausible starting point and guarantees termination even when the hole
  fills the canvas. Then **patch-based synthesis** picks donor centres whose whole patch is
  known, thins the candidate set to an even sample, and fills the hole pixel by pixel using
  the best match under sum-of-squared-differences, repeated over a few passes. Large areas fall
  back to diffusion only. The whole repaired rectangle is written back in a single call, and
  pixels outside the hole are byte-identical afterwards (there is a test that asserts exactly
  that).
- Honest limits: this is classical inpainting, not generative AI. It excels on flat/gradient
  backgrounds and repeated textures; it will not invent a believable face or a complex object.
  That is the price of working completely offline with no bundled models — and it is documented
  in `docs/research/guazzo-vs-guide-gap.md`.

## What changed in v0.20.0 — dockable panels + UX pass

**The right-hand column is now yours.** Every card (Layers, History, Adjustments, Filters,
Colour, Tonal, Histogram) can be **resized by dragging its bottom grip**, **collapsed by clicking
its header** (or Enter/Space when focused), and **reset by double-clicking the grip**. The column
itself resizes from the divider on its left edge. Sizes and collapse state are remembered across
restarts, `View ▸ Reset Panel Layout` puts everything back — and **Tab** hides the whole column
plus the toolbar, like Photoshop.

**History resizing was inverted, and that is fixed.** The old grip sat on the *top* edge, so
dragging up made the panel taller; the grip now sits on the bottom edge of every card, so you drag
toward the space you want to give it. The History list scrolls on its own and keeps your scroll
position when new entries arrive.

**UX review findings fixed in this pass** (each one was a real "why did it do that" moment):

- **Panning existed nowhere.** Past ~150 % zoom the region you wanted was unreachable. Now
  **hold Space and drag**, or **drag with the middle button**, anywhere on the canvas.
- **Layout changes destroyed your view.** Widening a panel used to re-fit the whole document.
  Sizing the column now keeps the document point under the viewport centre exactly where it was.
- **Unsaved work was invisible and unguarded.** Modified tabs now show a **• dot**, the status bar
  says **• Unsaved**, closing a modified tab asks first, and the app warns before unloading.
- **Magic Wand taught modifiers that did not exist.** It now really does **Shift-click to add** and
  **Alt-click to subtract**, and Shift-dragging the rectangle/ellipse gives a **square/circle**.
- **No brush cursor.** A 300 px soft brush and a 3 px hard brush looked identical. Brush-family
  tools now draw a live **size ring with a centre dot**, and the cursor follows the tool
  (move, text, grab/grabbing while panning).
- **No numeric entry.** Every options slider now has a **typeable number field** (Enter commits,
  arrows stay inside the field instead of nudging the layer).
- **Dialogs were not modal.** An adjustment dialog left the rest of the app live — `B` switched
  tools and `Ctrl+Z` edited behind it. Dialogs now cover the whole window, take focus, and mute
  every global shortcut until closed.
- **New Document failed silently.** Invalid or oversized input now shows an error line inside the
  dialog instead of closing and doing nothing.
- **Locked layers were silent no-ops.** They now flash the Layers panel and say why in the status bar.
- **Layers panel upgrades**: **thumbnails**, **double-click to rename** (undoable), a **lock toggle**
  per row, and a status bar that reports **cursor X/Y** and **selection size**.
- **Export As…** shipped: PNG / JPEG / WebP / **PSD**, with quality, scale, and a live size estimate
  (PSD writes every pixel layer at its tile-aligned bounds and flattens adjustment/fill layers only
  when it must, warning you first).

## What changed in v0.19.0 — code-quality review pass

A full-project review (reading every module) found one systemic weakness and
eight concrete bugs. All are fixed, and the fixes are covered by new tests.

**The theme:** an invariant living in a module-level global that one consumer
forgets. Each fix removes the possibility rather than patching the symptom.

- **Apply Layer Mask is now honestly undoable.** Undo used to restore the pixels
  but silently drop the mask; one composite history entry now restores both.
- **Rectangular selections are first-class.** A marquee used to be invisible to
  the Move tool, Paint Bucket and Add Layer Mask (they read only the mask
  object). The mask is materialised when the marquee commits, so every consumer
  agrees.
- **Crop, Rotate, Flip, Trim, Image Size and Canvas Size are undoable.** They
  swap the document, which used to reset the whole History panel. The old
  document is now kept alive by the undo entry, and undo/redo preserve the
  active layer.
- **Merge Down honours the upper layer's mask** instead of merging unmasked
  pixels.
- **Duplicate Layer copies the mask, text metadata, clipping, adjustment/fill
  recipe and layer kind** — duplicating an adjustment layer no longer yields an
  empty pixel layer.
- **Moving a text layer undoes its text origin too**, so re-editing text after
  an undo no longer leaves ghost glyphs.
- **Grow / Similar / Quick Selection sample the active layer**, matching the
  Magic Wand instead of the merged composite.
- **Keyboard opacity edits reach the undo history**, and no longer retarget the
  wrong layer when the active tab changes mid-drag.
- **A stroke interrupted by a tab switch still marks the document dirty** for
  autosave.
- **Smaller fixes:** `[` / `]` now actually resize the brush (they were
  documented but unimplemented), Enter confirms dialogs from any field, a host
  narrower than the padding can no longer produce a negative zoom, mask painting
  no longer allocates tiles it does not write, and the adjustment-layer gamma
  can no longer go non-positive.
- **Build hardening:** the single-file bundler now refuses to build if any
  compiled module is missing from the concat order, if unhandled ESM syntax
  survives stripping, or if the vendored `ag-psd` banner disagrees with
  `package.json`. `scripts/vendor-psd.mjs` regenerates that vendor copy and
  stamps its version. `npm test` now runs the engine suite *and* the UI smoke
  test, which asserts instead of only logging.

## What changed in v0.18.0

Phases 5–7 of the reference-guide work: selection depth, image geometry and vector-style shapes.

- **Selection depth** — Grow, Similar, and a Modify group (Expand, Contract, Feather, Smooth, Border) on the Select menu. Each returns a brand-new mask, so every operation is one undo step.
- **Quick Selection tool (W / Shift+W)** — paints to select similar pixels; each dab unions a tolerance-based region with the selection.
- **Image geometry** — Rotate 90° CW/CCW, Rotate 180°, Flip Horizontal/Vertical and Trim on the Image menu. Layers, masks and text metadata are re-anchored, never resampled.
- **Shape tool (U)** — rectangle, ellipse, line, polygon and star with 4x supersampled antialiasing, centred strokes, fill from the foreground colour, and Alt-drag to turn the shape into a selection instead of pixels.

## What changed in v0.14.0 → v0.17.0

- **v0.14.0 — retouch tools.** Eyedropper (I), Dodge/Burn/Sponge (O, with range and vibrance), Clone Stamp (S, aligned or fixed source), Blur/Sharpen tools, Smudge, Red Eye, plus a Colour panel with hex entry, RGB sliders, swapped foreground/background wells and recent swatches.
- **v0.15.0 — tonal engine.** Levels, Curves (monotone cubic so the curve can never fold back), Exposure, Vibrance, Colour Balance, Black & White, Photo Filter, Channel Mixer, Gradient Map, Desaturate, Auto Tone/Contrast/Colour, Equalize, and a live Histogram panel. All of it is also available as adjustment layers.
- **v0.16.0 — layer masks and adjustment/fill layers.** Paintable layer masks (the mask is inverted internally so an empty mask costs nothing), 13 kinds of adjustment layer, solid-colour fill layers, clipping masks, mask-from-selection, mask-as-selection, apply/delete mask, and Quick Mask (Q).
- **v0.17.0 — the second filter family** (above), and the quality fixes from the review pass: keyboard shortcuts no longer fire while a dialog field has focus, undo entries bind to the layer they were made on, autosave can no longer mark an unsaved stroke clean, and switching tabs cancels any in-progress gesture.

## What changed in v0.26.0 — handoff-3 quality pass (criticals, seams, a11y)

| Area | Fix |
| --- | --- |
| Paste across sizes | a clip wider/taller than the document no longer shears rows — `cropRGBA` crops the buffer to the target before `writeRect` (engine-tested golden) |
| Copy/Cut honesty | Copy on a non-pixel layer refuses with a hint instead of silently copying nothing; **Cut is one undo entry** (was copy + clear = two); copy/cut/copy-merged/paste all work from the context menu and Edit menu, with `Ctrl+C/X/V`, `Ctrl+Shift+C` |
| Context-menu hygiene | switching tabs or blurring the window closes an open context pop — its closures point at the old document, so acting from another tab recorded into the wrong history |
| Toolbar preference | a manual (dragged or clicked) toolbar width/column choice survives reload; automatic two-way compaction still releases manual mode on genuine fit changes |
| Blur family | motion/radial/box blurs accumulate **premultiplied** colour — no dark halos on semi-transparent layers (regression-tested) |
| Status bar | built once, updated via `textContent` — no per-frame `innerHTML` rebuild; hint text is set as a literal (PSD layer names can't inject markup) |
| Build hygiene | 4-entry icon.ico (16/32/48/256), `serve.mjs` path containment fix, single-file collision guard now sees destructured top-level consts, dead `assertVendorVersion` removed, README module tree covers all 27 engine modules + 5 ui modules |
| Polish | adjustment-dialog dead `autoTone` duplicate removed; histogram card wears a chart icon; end-of-stroke heal branch resets gesture state; export dialog's `.expdlg/.exp-note/.exp-size/.exp-warn` classes actually styled; `prefers-reduced-motion` disables the flash pulse; single-file size honest at ~1.6 MB |
| Keyboard & AT | context pops and menu-bar drops carry `role="menu"`/`role="menuitem"` with full arrow/Home/End/Escape navigation (Escape returns focus to the opener); tabs are a `role="tablist"` with `aria-selected` + arrow-key switching; layer rows are tabbable with Enter/Space activation; every slider/tool button keeps an `aria-label` after the tooltip system strips `title` at runtime; canvas host is focusable with a visible dashed outline |

## What changed in v0.25.6 — context menus actually render

**Fixed:** right-click context menus (layers / canvas / history / tabs / tool
families / swatches, shipped in v0.25.0) never appeared in the real app. The
pop element carried the `.menu-pop` class, which is `display: none` unless it
lives inside an open `.menu` — the context pop is a bare `document.body` child,
so it was created but invisible. The headless smoke shim does not compute
styles, so its existence check passed.

- `.context-pop` now sets `display: flex` itself (real browsers render it).
- `ui-smoke` gained a CSS pin: it statically asserts the `.context-pop` rule
  exists after `.menu-pop` and sets `display: flex`, so an invisible-pop
  regression can never pass the gate again.

## Features (v0.30.0)

- **Pressure-aware painting** — pen tablet primary, mouse fallback; brush + eraser (B/E); stroke rendering is frame-coalesced and allocation-free, so even a size-300 eraser glides at full speed; **Flow** controls per-dab build-up, **Smooth** is pulled-string stroke smoothing, **Scatter** jitters dabs for spray effects, and **pen tilt flattens the nib into an ellipse** like a real tilted pen; **brush tips**: built-in Soft round / Square / Chalk / Spray, plus **Custom… to load any PNG/JPEG as your own brush** (transparency = density, or black-on-white for opaque images)
- **Free Transform** — no shortcut needed: the **⤢ button in the left toolbar** (click again to Apply), the **⤢ in the Layers panel's action strip**, or **double-click any layer's row** to transform that layer; Ctrl+T still works; drag inside the frame to move, a corner to scale, outside to rotate (Shift snaps 15°); live readout with Apply/Cancel; Enter commits, Esc cancels; fully undoable
- **Text tool (T)** — click the canvas for a live editable text box (drag its ✥ handle to reposition); **multiline: Shift+Enter makes a new line**, with per-line spacing; **select any portion of the text and apply bold / italic / underline / strikethrough / a different font to just that part**; **click existing text to re-edit it** — content, styling, and size all changeable, committed in place as one undoable step; Enter or click-away commits, Esc discards; text color comes from the toolbar color well (black by default); the recipe survives project save/load; **Load font… imports any .ttf/.otf/.woff/.woff2 from your computer** and it becomes selectable for the whole session
- **Layers** — add, duplicate, reorder, delete, visibility, opacity, 27 Photoshop blend modes, live composite, **Merge Down (⇩ strip button or Ctrl+E)** and **Flatten Image (⊟)** — both fully undoable as one history step
- **Full undo/redo** — strokes, layer ops, adjustments, filters, gradients, deletes; Ctrl+Z / Ctrl+Shift+Z; clickable History panel that scrolls on its own and follows the newest edit without losing your place when you scroll back
- **Your own panel layout** — every panel card resizes from its bottom grip and collapses from its header; the column resizes from its left divider; Tab hides panels + toolbar; `View ▸ Reset Panel Layout` restores the defaults; all of it is remembered between sessions
- **Interface** — Photoshop's layout (toolbar left, options bar on top, panels right) in a softer, modern skin: rounded cards, one restrained blue accent, real vector icons throughout, and a status bar showing **zoom, canvas size, active layer, history position** and the permanent "100% offline" reminder
- **File I/O** — open PNG/JPEG/WebP/GIF/**PSD**; save editable `.guazzo.json` projects; export PNG; **Image Size…** resamples every layer (bilinear) with a keep-aspect lock, **Canvas Size…** re-anchors content with a 9-point anchor picker
- **Multiple documents** — Photoshop-style tabs: open several images/projects at once, each keeps its own layers, history, selection, and zoom; click a tab to switch, × to close, ＋ for a new document
- **Autosave & crash recovery** — every change is tracked; every 20 s ALL open tabs are quietly written to the browser's private local storage (OPFS — nothing leaves your disk). After a crash, relaunch offers "Found an unsaved autosave from …" with Restore / Discard — every tab comes back, including the one you had in front
- **PSD import (stage 3)** — layers, stacking, names, offsets, blend modes, opacity, visibility, groups (flattened), raster masks (baked to alpha), **and layer-style effects baked in: drop shadows, inner shadows, outer/inner glows (with choke), bevel/emboss, gradient overlays, color overlays, outside strokes — merged in Photoshop's order (shadow → glow → stroke → content → inner shadow → inner glow → bevel)**
- **Move tool (V)** — drag the active layer, or just the selected pixels when a selection is live (the hole is left behind, like Photoshop); arrows nudge 1 px, Shift+arrows 10 px; one undo step per drag, lossless — content is re-derived from a snapshot, never re-shifted
- **Crop tool (C)** — drag a crop rectangle over a dimmed canvas with rule-of-thirds guides, then **Enter** (or *Apply crop*) to commit, **Esc** to cancel; every layer is re-anchored, never resampled
- **Magic Wand (W)** — click to select all touching pixels within the tolerance (0–255); untick *Contiguous* to catch every similar colour in the layer; anti-aliased edge fringe; feeds every selection-aware command (brush, filters, adjustments, fill, move)
- **Paint Bucket (Shift+G)** — flood-fill with the foreground colour, honouring tolerance, opacity and any live selection; one undo step
- **New Document dialog (Ctrl+N)** — Photoshop-shaped: name, document-type presets, width/height with inch/cm/mm/pt/pica units that convert as you switch them, resolution (ppi/ppcm), colour mode and bit depth (unsupported combinations are shown, disabled, and labelled), background contents with a live swatch, colour profile, pixel aspect ratio and a live "Image Size" readout; save and delete your own presets
- **Menu bar that survives resizing** — the bar re-asserts itself if the layout ever drops it, tool buttons can no longer be squeezed to zero width, and the options bar wraps instead of silently clipping its right edge
- **Menu bar** — a real File / Edit / Image / Layer / Select / Filter / View / Help bar across the top (Photoshop's layout, trimmed to what Guazzo actually does); greyed-out items tell you what is currently unavailable, and every entry is the same command as its shortcut
- **Right-click context menus** — on the canvas (clipboard, selection, export), layer rows (duplicate/rename/blend ▸/opacity/clipping/masks/merge), history rows (step to here, clear), document tabs (close/save/export), toolbar buttons (tool families, like Photoshop's flyouts) and colour swatches (delete); Ctrl+C/X/V + Ctrl+Shift+C Copy Merged with paste-as-new-layer
- **Tooltips** — hover any tool, panel button or menu row for half a second and a small dark tip explains what it does (replaces the browser's slow native tooltips)
- **Selections** — rectangular marquee (M, cycles with elliptical ⬭ M), freehand lasso (L), marching ants, paint/adjust/filters/gradients clip per-pixel to any selection shape, Ctrl+D deselect, Delete erases under the mask
- **Gradient tool (G)** — linear/radial, per-stop color + alpha (foreground→transparent default), drag defines the axis, fills selection or layer
- **Adjustments** — brightness, contrast, saturation, hue, invert, grayscale, posterize, threshold
- **Filters** — 29 filters in one grouped panel and the Filter menu:
  - *Blur*: Gaussian, Motion (angle/distance), Radial (zoom), Radial (spin), Box
  - *Sharpen*: Sharpen, Unsharp Mask
  - *Noise*: Add Noise (seeded), Median, Dust & Scratches
  - *Distort*: Pinch, Spherize, Twirl, Ripple, Wave, Polar Coordinates
  - *Stylize*: Find Edges, Emboss, Solarize, Trace Contour, Oil Paint
  - *Render*: Clouds, Difference Clouds (both seed-deterministic), Lens Flare
  - *Pixelate*: Mosaic, Crystallize
  - *Other*: High Pass, Offset, Minimum, Maximum
  - Every filter honours the active selection (and masks the edges so a selection boundary never erodes) and lands as one undo step.

## Architecture

TypeScript engine. The engine has no runtime npm dependencies at all; the only
third-party code in the shipped app is the vendored `ag-psd` UMD bundle (the PSD
reader/writer), inlined into the single file so nothing is ever fetched.

```
src/engine/          pure, testable core (suite runs on node --test)
  tile.ts            256px sparse tile grid — big docs stay cheap
  blend.ts           all 27 blend modes + behind/clear (W3C compositing math)
  tone.ts            LUT/curve/levels engine + histogram + auto tone
  adjustfn.ts        adjustment-layer specs → pointwise transforms
  document.ts        Document/Layer model, per-tile compositor, layer masks
  paint.ts           pressure-aware dab stamping, clip-aware
  retouch.ts         dodge/burn/sponge/focus/smudge/clone/red-eye dabs
  history.ts         hybrid undo: commands + dirty-tile snapshots
  io.ts              .guazzo.json project format v1 (tiles + base64 blobs)
  adjust.ts          pure pixel adjustments (Image > Adjustments)
  filter.ts          blur/sharpen/noise/pixelate (premultiplied float)
  filters2.ts        motion/radial/box/median blur, distort, stylize, render
  gradient.ts        linear/radial/angle/reflected/diamond gradients
  mask.ts            sparse selection and layer-mask storage
  selectops.ts       expand/contract/feather/smooth/border/grow/similar
  shapes.ts          supersampled rectangle/ellipse/line/polygon/star
  imageops.ts        rotate/flip/trim, rebuilding layers by re-anchoring
  transform.ts       free transform (move/scale/rotate/skew/perspective)
  resize.ts          resample, canvas resize with anchors, crop
  move.ts            lossless layer/pixel moving from one snapshot
  flood.ts           magic wand + paint bucket region growth
  plane.ts           solid fills with opacity/mask/blend
  docmeta.ts         units, presets, image-size math
  effects-bake.ts    layer-style effects rasterisation (PSD import)
  psd.ts             parsed-PSD to Document mapping (ag-psd does the parsing)
  psdexport.ts       Document → PSD layer records (ag-psd writes the bytes)
  heal.ts            patch-based spot healing + content-aware fill
src/ui/              DOM-only panels: icons, newdoc, tonal, exportdlg, dock
src/main.ts          controller: viewport, tools, panels, menus, history UI
vendor/              ag-psd UMD bundle — versioned banner, rebuilt by
                     scripts/vendor-psd.mjs, no CDN, no runtime fetch
scripts/             serve.mjs, single-file.mjs, build-desktop.mjs, ui-smoke.mjs,
                     vendor-psd.mjs, bump.mjs, make-icons.mjs, prepare-desktop.mjs,
                     crates-mirror.mjs
src-tauri/           Tauri v2 desktop shell (Rust)
```

## Build from source

Requirements: **Node ≥ 22.18**, pnpm, Rust (WinLibs/MinGW works — the shipped
exe is built with it), and WebView2 (built into Windows 11).

One command runs the whole web pipeline — TypeScript compile, the
single-file bundle (with its staleness/order/collision guards), a bundle
syntax check, and the `desktop-dist/` refresh:

```bash
npm run desktop          # = node scripts/build-desktop.mjs

# tests
npm test                 # engine suite + headless UI smoke

# desktop exe
cd src-tauri && CARGO_HOME=../.cargo-home cargo build --release
```

Freshness is enforced on BOTH sides: `build-desktop.mjs` refuses to bundle a
stale `dist/`, and `src-tauri/build.rs` refuses to compile if any
`src/**/*.ts` (or `index.html`) is newer than `desktop-dist/index.html` — a
stale exe can no longer be produced by accident. Versions live in three
files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`);
keep them in lockstep with `node scripts/bump.mjs <x.y.z>` (or
`--check`).

**`CARGO_HOME=../.cargo-home` is load-bearing**, not cosmetic: sandboxed
workspaces often cannot write `~/.cargo` (`os error 5`), and the workspace
local `app/.cargo-home` carries the registry index + sources for offline
rebuilds. Don't drop the variable.

### Note: crates.io through the local mirror

`cargo fetch` fails in some sandboxed environments (broken schannel TLS:
`SEC_E_NO_CREDENTIALS`). In that setup the mirror is **mandatory, not
optional** — `src-tauri/.cargo/config.toml` replaces crates.io with
`http://127.0.0.1:5189/`, served by:

```bash
node scripts/crates-mirror.mjs &        # :5189, disk-cached under app/.cargo-mirror-cache/
```

On a normal machine with working TLS you can delete that `source.crates-io`
replacement block from `src-tauri/.cargo/config.toml` and fetch directly.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `B` / `E` | Brush / Eraser |
| `M` | Rectangular Marquee — press again for Elliptical |
| `L` | Lasso |
| `G` | Gradient |
| `T` | Text tool |
| `Ctrl+T` | Free Transform (Enter applies, Esc cancels) |
| `Ctrl+E` | Merge Down |
| `V` / `C` | Move tool / Crop tool |
| `W` / `Shift+W` | Magic wand / quick selection (Shift add, Alt subtract) |
| `Space`+drag, middle-drag | Pan the canvas |
| `Tab` / `Shift+Tab` | Hide panels + toolbar / panels only |
| `I` / `O` / `S` / `U` | Eyedropper / dodge-burn-sponge / clone stamp / shapes |
| `G` / `Shift+G` | Gradient / paint bucket |
| `Ctrl+A` / `Ctrl+D` / `Ctrl+Shift+I` | Select all / deselect / invert selection |
| `Alt+Backspace` | Fill selection with the foreground colour |
| `Ctrl+J` / `Ctrl+Shift+N` | Duplicate layer / new layer |
| `↑↓←→` (Move tool) | Nudge active layer 1 px — add Shift for 10 px |
| `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | Undo / Redo |
| `Ctrl+D` | Deselect |
| `Del` / `Backspace` | Clear the selection area on the active layer |
| `Esc` | Cancel current action (transform, text box, selection) |
| In the text box: `Enter` commits · `Shift+Enter` new line · `Esc` discards |

## Non-goals (by design)

Cloud/generative features (Firefly-style), online activation or licensing of
any kind, CMYK/Lab color modes, 16/32-bit PSD writing. The app is offline
forever, by design.

## Roadmap

- Smart objects, 16-bit PSD, satin/pattern overlays
- Select-and-Mask style refine-edge brush, paths and pen editing
- Brush texture, dual/eraser-tip dynamics, airbrush mode
- Local ML (subject select, denoise) with user-supplied models — never downloaded
