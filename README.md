# Guazzo

*Guazzo — the Italian word the French *gouache* was borrowed from; watery paint.*

A fully-offline, Photoshop-like image editor. No accounts, no cloud, no network —
the app never makes a single network request.

## Run it

| How | What |
| --- | --- |
| **Desktop app** | Run `Guazzo-v0.44.0.exe` — keep `WebView2Loader.dll` (160 KB) in the same folder; both files ship together (Windows 10/11 — the WebView2 runtime itself is built into Windows; only this small loader stub is external, because the MinGW toolchain links it dynamically) |
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

## What changed in v0.31.0 — text alignment + a single "?" help button

Two requests from the same message.

**Text alignment.** The text tool now has Photoshop's paragraph row: **left, centre, right, justify**
(the request named left/justified/right; centre is included because every text UI has three
horizontal stops plus justification). It works in both states:

- **While typing** — the live editor re-aligns immediately (`text-align` on the contenteditable),
  and new text is rasterised with the chosen alignment.
- **On a placed layer** — selecting a text layer and pressing an alignment button re-lays the stored
  recipe and re-rasters it as **one undoable step** (`Text align`), so alignment is never baked in
  destructively.

Justify stretches the gaps *between words* on every line of a paragraph except the last, which is
what stops the final line of a paragraph from being stretched across the whole box. Alignment is
stored per text layer (`textData.align`) and survives Save Project / Open Project; older project
files keep loading (a missing value means left).

**One "?" help button.** Every tool used to print its long guidance inline in the options bar
("Click for a text box · click existing text to re-edit it · drag ✥ to move · Shift+Enter = new line
· …"), which crowded out the actual controls. That text now lives behind a single round **?** button
pinned to the right end of the options bar:

- **Hovering it** (0.5 s) shows the tool's full guidance in the standard tooltip.
- **Clicking it** prints the same guidance into the status bar, so it is readable without hovering.
- The text is built from a per-tool guide (`TOOL_GUIDE`) plus any hint the bar still renders inline,
  so the tooltip can never drift behind the UI.
- The button is excluded from options-bar paging — it stays visible on every page.
- Toolbar icons now hover as **"Brush (B)"** instead of the full sentence; the long description stays
  in `aria-label` for screen readers.

Quick Mask and mask-editing keep their inline banner on purpose: there the bar explains a temporary
mode, not a tool.

## What changed in v0.30.4 — text now actually reaches the canvas

The real defect behind "text disappears after Enter": `layoutTextRich()` built
**unwrapped** rows with a hard-coded `width: 0`, so `rasterizeTextRich()`
allocated a canvas of `ceil(0) + 2 = 2 px` wide and every glyph was painted
outside it. The layer was created, the undo entry was correct, the metadata was
correct — but the layer grid held *zero pixels*, so nothing appeared on the
canvas and nothing appeared in the thumbnail. The wrapping path (text inside a
box) measured correctly, which is why only plain text was affected.

- **Row widths are now the sum of their part widths** — the canvas is sized to
  the real text extent.
- **Safety net**: if measurement ever returns ~0 while text exists (e.g. a web
  font has not resolved yet in WebView2), the width falls back to a character
  heuristic so glyphs can never be clipped into a degenerate canvas again.
- **Regression pin** in ui-smoke asserts the placed-text status line reports a
  raster wider than 2 px. Proven with teeth: sabotaging the measurement makes
  the smoke fail with `got 2px wide`.

## What changed in v0.30.3 — placed text is now visible and acknowledged

- **Layer thumbnails render the layer's actual content.** The old thumbnail
  sampled one flat colour per tile *at the tile centre* — any content smaller
  than half a tile (typed text, small shapes) sampled a transparent pixel and
  the thumbnail showed nothing. Thumbnails now read the layer's bounding box
  (capped to a centred 1024² crop for huge layers) and draw it aspect-fitted —
  a text layer immediately shows its glyphs.
- **Placing text acknowledges itself.** Committing text now writes to the
  status bar: `Placed text · W × H px` (new layer) or `Text updated` (edit), so
  a committed box is never silently gone. Pinned in ui-smoke.

## What changed in v0.30.2 — text box appears again (focus-steal root cause)

The v0.30.0 "cannot place text" and v0.30.1 "text box never appears" bugs were
the same root cause: `#canvas-host` is focusable (the accessibility `tabindex`
added in v0.26.0), so the default action of the very click that opens the live
editor steals focus right back — a synchronously focused editor was instantly
blurred. Since v0.26.0 that silently killed typing; once v0.30.1 added
blur-commit, the instant blur destroyed the empty editor before it ever
rendered. Two fixes:

- **Deferred focus** — the editor now focuses from a macrotask
  (`setTimeout(…, 0)`), which lands *after* the opening click's default action,
  so no blur can fire on the way in. The box appears immediately; the caret
  lands a tick later (imperceptible).
- **Identity-guarded blur** — the blur-commit listener checks
  `textEditing.el === el` before committing, so a replaced editor's dying blur
  can never commit (and destroy) the freshly opened successor.

Pinned in ui-smoke: a stale editor's `blur` fired while its successor is live
must neither place the successor's text nor remove it, and the successor must
still commit normally afterwards.

## What changed in v0.30.1 — text placement fixes
- **One-click new text**: after committing a text box (Enter/Escape), the next empty-canvas click now deselects AND opens a new editor in the same click — previously the first click only deselected, so typing went nowhere and Enter did nothing.
- **Commit on blur**: clicking any panel, swatch, slider or another app area while the live editor is open now places the text (the editor commits when it loses focus).
- **Safer commit ordering**: the editor is deregistered before it is removed from the DOM, so a blur re-dispatch can never double-commit.
- Smoke gains a real text-commit regression (Enter / click-away / blur each place a "Text: …" layer) — verified to fail on the pre-fix build.

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

## Features (v0.44.0)

- **Pressure-aware painting** — pen tablet primary, mouse fallback; brush + eraser (B/E); stroke rendering is frame-coalesced and allocation-free, so even a size-300 eraser glides at full speed; **Flow** controls per-dab build-up, **Smooth** is pulled-string stroke smoothing, **Scatter** jitters dabs for spray effects, and **pen tilt flattens the nib into an ellipse** like a real tilted pen; **brush tips**: built-in Soft round / Square / Chalk / Spray, plus **Custom… to load any PNG/JPEG as your own brush** (transparency = density, or black-on-white for opaque images)
- **Free Transform** — no shortcut needed: the **⤢ button in the left toolbar** (click again to Apply), the **⤢ in the Layers panel's action strip**, or **double-click any layer's row** to transform that layer; Ctrl+T still works; drag inside the frame to move, a corner to scale, outside to rotate (Shift snaps 15°); live readout with Apply/Cancel; Enter commits, Esc cancels; fully undoable
- **Text tool (T)** — click the canvas for a live editable text box (drag its ✥ handle to reposition); **multiline: Shift+Enter makes a new line**, with per-line spacing; **select any portion of the text and apply bold / italic / underline / strikethrough / a different font to just that part**; **click existing text to re-edit it** — content, styling, and size all changeable, committed in place as one undoable step; Enter or click-away commits, Esc discards; text color comes from the toolbar color well (black by default); the recipe survives project save/load; **Load font… imports any .ttf/.otf/.woff/.woff2 from your computer** and it becomes selectable for the whole session
- **Layers** — add, duplicate, reorder, delete, visibility, opacity, 27 Photoshop blend modes, live composite, **Merge Down (⇩ strip button or Ctrl+E)** and **Flatten Image (⊟)** — both fully undoable as one history step
- **Full undo/redo** — strokes, layer ops, adjustments, filters, gradients, deletes; Ctrl+Z / Ctrl+Shift+Z; clickable History panel that scrolls on its own and follows the newest edit without losing your place when you scroll back
- **Your own panel layout** — every panel card resizes from its bottom grip and collapses from its header; the column resizes from its left divider; Tab hides panels + toolbar; `View ▸ Reset Panel Layout` restores the defaults; all of it is remembered between sessions
- **Interface** — Photoshop's layout (toolbar left, options bar on top, panels right) in a softer, modern skin: rounded cards, one restrained blue accent, real vector icons throughout, and a status bar showing **zoom, canvas size, active layer, history position** and the permanent "100% offline" reminder
- **File I/O** — open PNG/JPEG/WebP/GIF/**PSD**; save editable `.guazzo.json` projects; **Export As… (PNG / JPEG / WebP / PSD)**; **Image Size…** resamples every layer (bilinear) with a keep-aspect lock, **Canvas Size…** re-anchors content with a 9-point anchor picker
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
src/ui/              DOM-only panels: icons, newdoc, tonal, exportdlg, dock,
                     notices (generated embed of THIRD-PARTY-NOTICES.md)
src/main.ts          controller: viewport, tools, panels, menus, history UI
vendor/              ag-psd UMD bundle — versioned banner, rebuilt by
                     scripts/vendor-psd.mjs, no CDN, no runtime fetch
scripts/             serve.mjs, single-file.mjs, build-desktop.mjs, ui-smoke.mjs,
                     vendor-psd.mjs, bump.mjs, make-icons.mjs, prepare-desktop.mjs,
                     crates-mirror.mjs, embed-notices.mjs
src-tauri/           Tauri v2 desktop shell (Rust)
```

## Where the app keeps its data

Guazzo stores nothing in the cloud and never opens a socket. The only files it
touches are ones you pick (open/save) plus two local caches:

- `%LOCALAPPDATA%\Guazzo\WebView2` — the WebView2 profile (browser cache,
  localStorage for panel layout / toolbar width / document presets). Safe to
  delete while the app is closed; it is recreated on next launch.
- `%LOCALAPPDATA%\Pigment\WebView2` — **orphaned**, left behind by builds
  before the v0.28.0 rename from Pigment to Guazzo. Nothing reads or writes it
  any more and it can be deleted.

## What changed in v0.32.0 — handoff-4 review pass (menus, text, legal)

Reviewed against the fourth external audit. Everything below is behaviour, not
cosmetics — each row was reproduced first.

| Area | Change |
| --- | --- |
| **Menus (keyboard)** | The menubar was unreachable without a mouse: opening a menu never focused a row, and no key opened one. Now **Enter/ArrowDown on a menubar button focuses the first row**, ArrowDown/ArrowUp move between rows (nested submenu rows excluded so the order stays linear), **Escape closes and returns focus**, and **the Menu key or Shift+F10 opens the context menu for whatever is focused**. |
| **Text undo integrity** | Editing or clearing text snapshotted pixels only, so undo left the *recipe* pointing at the new wording — re-editing an undone text layer showed text that no longer existed on canvas. New `textOpCommand` snapshots **pixels and recipe together** on one entry, keeps recipe-only changes undoable, and drops an open-and-close that changed nothing. |
| **Text cancel** | Escape used to COMMIT. It now **cancels**: no layer, no history entry. Switching away or losing window focus still commits. |
| **Alignment reference** | Justification measured against `max(wrap, longestRow)`, so one over-long row silently widened the box. The box the user drew is now the reference; the canvas only grows when a row genuinely overflows it. |
| **Unmeasurable text** | When a font could not be measured (0 px advance) the canvas grew but the pen did not advance — every token overprinted at one x. Widths are now substituted and the row recomputed. |
| **Typographic edges** | Tabs expand to a 4-space stop instead of measuring ~0; underline/strikethrough rules cover justified gaps; the editor's B/I/U/S state comes from the selected run, not from the first character of the layer. |
| **Legal (release-blocking)** | `LICENSE` and the About dialog now name the owner — **vera2077** — through a single `OWNER_NAME` constant, and `scripts/build-desktop.mjs` **refuses to build** while `<COPYRIGHT HOLDER>` is still present (`GUAZZO_ALLOW_PLACEHOLDER=1` opts out for a throwaway local build; the guard is sabotage-tested). |
| **Notices** | `THIRD-PARTY-NOTICES.md` → `src/ui/notices.ts` is now regenerated automatically by the build when the markdown is newer, so the offline About dialog can never disagree with the shipped notices. The notices also state plainly that **all icons are original** and **no fonts are embedded**. |
| **Version quad** | `build-desktop` now asserts all four carriers (package.json, tauri.conf.json, Cargo.toml, `APP_VERSION` in the About dialog) — bumping three of four used to ship an exe that reported the old number. `bump.mjs --check` names all four. |
| **Storage keys** | `guazzo.docPresets` → `guazzo.docPresets.v1` with one-time adoption of the old key, so a future preset-shape change cannot silently misread old rows. |
| **Docs** | README architecture map lists `src/ui/notices.ts` and `scripts/embed-notices.mjs`; export is documented as PNG/JPEG/WebP/PSD; new "Where the app keeps its data" section documents `%LOCALAPPDATA%\Guazzo\WebView2` and the orphaned `%LOCALAPPDATA%\Pigment\WebView2` left by pre-rename builds. |

Engine tests **309** · smoke green (now asserts menu-row focus, row navigation,
the Menu key, and that no dialog is left open — an open dialog used to make every
later shortcut assertion vacuous).

## What changed in v0.33.0 — handoff-4 items X and Y

The second half of the fourth audit. Every row is a behaviour change, not a rename.

| Area | Change |
| --- | --- |
| **Adjustment drift (X1)** | The floating Adjustments palette and the modal tonal dialogs each had their own copy of the domain data: photo-filter presets existed **only** in the palette, and the palette's Curves hardcoded the `rgb` channel, so **per-channel curves were unreachable from the palette**. New `src/ui/adjust-forms.ts` is the single source for those facts (`CURVE_CHANNELS`, `PHOTO_FILTER_PRESETS`, lookups); the palette gained a Channel select that switches the point list it edits, and the Photo Filter dialog gained the shared preset list (choosing a preset fills the colour; editing the colour flips it back to "Custom…"). |
| **Palette keyboard (X3/X4)** | The palette could only be closed with the mouse; **Escape now closes it**. Its curve canvas is focusable with an accessible name and arrow keys nudge the nearest interior point (Shift = coarse). A cancelled pointer or a lost window focus used to leave the drag flag set **and both window listeners attached**; `pointercancel` and `blur` now release them. |
| **Colour pickers (X3)** | The saturation/brightness field and the hue strip are canvases, so `promoteTitles` stripped their only `title` and they had no accessible name and no tab stop. Both are now focusable `role="slider"` elements with `aria-label`s; the modal Curves editor likewise gained a name and an arrow-key path (nudge the last selected point, endpoints included only if nothing else is selected). |
| **Paste geometry (X5)** | Pasting a clipboard larger than the canvas cropped the **top-left** and then centred that crop, so the visible half came from the wrong corner. It now centres the source rect and takes the middle of the clipboard. `cropRGBAAt` is the new engine primitive (`cropRGBA` delegates to it, so old call sites keep their meaning). |
| **Layer thumbnails (X6)** | Adjustment and fill layers rendered as one flat colour — two different Curves layers were indistinguishable. An adjustment thumbnail now draws **what the adjustment does** to a grey ramp (via `compileAdjust`, the same code the compositor uses), and a fill layer shows its actual colour. |
| **Y verification** | Confirmed still true from handoff-3: the PSD byte round-trip test, the interleaved-undo integration test, the multi-entry ICO (4 images), and `prefers-reduced-motion`. Two leftovers are now **documented rather than "pending"**: `move.ts`/`flood.ts` still allocate a full-document buffer, but `move.ts` reuses a module scratch on the drag path and `flood.ts` allocates once per *click*, which is the accepted one-shot cost (comment at `sampleGrid`); `TOOL_LABELS`/`TOOL_FAMILIES` stay static because `promoteTitles` moves `title` → `data-tip`, so a dynamic label would break the 0.5 s tooltip contract. |

Engine tests **309** · smoke green · bundle 1689973 bytes.

## What changed in v0.44.0 — help you can read, and two silent-failure fixes

| Item | Before | Now |
| --- | --- | --- |
| Tool help (AD5) | Picking a tool left no caption; the only explanation was a toast that vanished after 2.6 s, and the `?` button's accessible name was a 200-character paragraph | A one-line caption stays in the bar while the tool is selected; `?` opens a panel that waits to be dismissed; the button's name is simply "Tool help" |
| Double include (AE4) | The single-script wrapper turned a duplicated bundle into a silent double boot — two autosave loops, two keyboard handlers, "every click happens twice" | A sentinel throws `Guazzo bundle included twice` on the second copy |
| Shell detection (AE5) | `isTauri()` keyed off one internal global; had it been renamed, the app would quietly become the browser build (Save downloads, no window buttons, no error) | The bridge is found by two independent routes, and a present-but-unusable bridge is reported |
| Freshness (AE3) | `cargo build` ignored `vendor/ag-psd-bundle.js` and `package.json` | Both are watched, so a stale page cannot ship |

## What changed in v0.43.0 — About fits on screen

The About dialog had grown two inlined documents (the licence and the third-party
notices) and pushed past the bottom of a 900 × 600 window. It is now compact, and
those documents open in their own scrollable readers.

| Before | Now |
| --- | --- |
| Two 30 KB `<pre>` blocks inside About; the dialog ran off the screen on a small window | Two rows — **Licence** and **Third-party notices** — that each open a reader with a height-capped, scrollable body |
| Nested dialogs shared one Escape | One modal stack: Escape (and Enter) act on the topmost dialog only, so closing a reader never closes About underneath it |

## What changed in v0.42.0 — handoff-5 items AB3 … AF6

| Item | Before | Now |
| --- | --- | --- |
| Save (AB3) | Ctrl+S opened the Save dialog **every** time, and the unsaved marker cleared even when you cancelled | Ctrl+S overwrites the file this session last wrote (the path lives in Rust); Ctrl+Shift+S is the old Save As; the dirty flag clears only after a successful write |
| Perspective (AC2, AC3) | A warped text layer kept a stale text recipe that re-rendered the *old* text; a degenerate quad produced NaN and the loop's bounds checks silently passed it | The layer becomes plain pixels; non-finite samples are skipped explicitly |
| TIFF (AC4) | A file missing a required tag threw a raw `TypeError` | `tiff: required tag … is missing` |
| View modes (AD1, AD2, AD3) | Picking a tool kept H/Z armed, so the first brush stroke panned; Esc did not cancel a perspective crop although the bar said it would; neither was taught anywhere | Tool choice clears the view modes, Esc cancels the quad, and the shortcut sheet lists H / Z / Space / perspective |
| Filter labels (AD4) | Every filter claimed "(selection)" in the undo label even though 20 of them ignore the mask | The claim is derived from whether the filter actually takes the mask |
| Caption grips (AE1, AE2) | Edge grips sat **above** menus (z 350 vs 320), so a pop at the window edge was un-clickable; double-click-maximise ran twice (native + our handler) and appeared to do nothing | Grips sit below menus at z 60; the window manager owns caption double-click |
| Build freshness (AE3) | A rebuilt `vendor/ag-psd-bundle.js`, `package.json`, `LICENSE` or notices file could leave a bundle that no longer matched them | All four are watched and refuse a stale build |
| Tool vocabulary (AF1, re-opened) | `TOOL_LABELS` and the buttons were two drifting literals ("Type (T)" vs "Text (T)", a Quick Selection key that is not its key) | [`src/ui/toollabels.ts`](src/ui/toollabels.ts) is the single source; buttons derive their title from the tool id; `toollabels.test.ts` pins label↔shortcut↔uniqueness |
| Licence (AF6, re-opened) | About showed the copyright line but never the licence; the file only shipped beside the exe | The full text is embedded (`src/ui/licence.ts`), shown under "Licence:" in About, and the embed step fails the build if the holder disappears |

## What changed in v0.41.0 — handoff-5 security and correctness pass

| Item | Before | Now |
| --- | --- | --- |
| Project files (Z1) | A text run's `font` string was pasted into `style="…"`; a `.guazzo.json` with `"font": "x\" onmouseover=\"…"` executed script when the layer was double-clicked. Tauri shipped **no CSP**. | `buildSeedHtml` lives in `src/ui/textseed.ts` with a font whitelist and full attribute escaping, covered by `textseed.test.ts` (6 tests incl. the exact payload). A real CSP ships in `tauri.conf.json`. |
| Saving (Z2, Z3, AB1) | `write_bytes(path, …)` / `read_bytes(path)` accepted **any absolute path** from the page, wrote non-atomically, and had no size ceiling. | Rust owns both dialogs now: `save_file(name, ext, bytes)` and `open_file(title, exts)` take **no path at all**, refuse >512 MB, and write via temp file + `sync_all` + rename. The old commands are gone. |
| Live preview (AA1, AA2, AA3) | The first filter-slider touch deadlocked previews for the whole session (two competing flags); previews survived tab switches; the canvas never said it was a proxy. | One scheduler (`src/ui/previewqueue.ts`, 3 regression tests). Previews clear on tab switch, undo and gesture end. The canvas shows a `Preview · W × H proxy` badge. |
| Closing (AB2) | The frameless ✕ destroyed the window and lost unsaved documents; Alt+F4 bypassed everything. | ✕ and the OS close path both run one guard that names the dirty documents and asks first; Rust refuses the native close until the page agrees (`close_requested` / `win_force_close`). |
| TIFF import (AC1) | A 100 KB header claiming 65535² asked for 17 GB before any pixel was read. | Dimensions are checked against `MAX_DIM` and a 512 MB pixel budget **before** allocation, with a `tiff: …` message and a test. |

## What changed in v0.40.5 — calmer caption buttons

The close button turned into a solid Windows-red block on hover, sitting 8 px in from the window edge with its top-right corner covered by the resize grip — so the hover shape looked cut off and the very corner of the button did not even register.

- `#topbar` lost its right padding and the host `.winctl` now owns the last pixels of the row (8 px padding removed, 4 px breathing room added), so the buttons moved right and the group looks deliberate.
- The three buttons are inset pills (`height: calc(100% - 10px)`, 6 px radius, 2 px apart) instead of edge-to-edge slabs.
- The close button no longer uses `#c42b1c`; it is one step brighter than minimise/maximise (`rgba(255,255,255,.14)` vs `.07`, `.2` when pressed) with the glyph at full text colour — same family, still unmistakably the close button.
- `.winctl` sits at `z-index: 400`, above the `.rs-edge` grips at 350, so the top-right corner grip can no longer swallow the button's hover or clicks.

## What changed in v0.40.4 — side submenus actually open

"Blending ▸" did nothing in the Layer menu and in the layer context menu. The rule was there (`.menu-item.sub:hover > .menu-sub { display: flex }`) and the hover fired — but every menu pop scrolls (`overflow-y: auto`, added in v0.22.0 so long menus are not clipped by the window), and **an ancestor with `overflow` clips an absolutely positioned child**. The submenu was rendering, invisible, outside the pop's box.

The side menu is now `position: fixed` and placed by script from the parent row's rect, which escapes the clip, flips to the left edge near the right side of the screen, and shifts up near the bottom. Hover, click (for touch), and Enter all share one opener; leaving the row closes it unless the pointer is already inside the submenu; closing the menu clears any row left marked open. Smoke now hovers Layer ▸ Blending and asserts the submenu opens and carries its own coordinates.

## What changed in v0.40.3 — the options bar shows its controls again

v0.40.1's page split asked the container for its overflow width (`host.scrollWidth`). On a clipped flex row that measurement is not trustworthy — it can report the full content width or nothing at all — so the "keep paging while it overflows" loop ran until a single control was left and everything else hid behind ">". The bar looked empty.

Paging now measures each control's own layout width and fills page 1 greedily against `#options` minus the tail: the widest set of controls that really fits stays visible, at least one control always does, the ">" pager appears only when something is actually hidden, and the split is recomputed on window resize (after layout, never mid-event). Paging is also re-runnable now: the bar is unwrapped back to a flat row before every pass, so a resize cannot stack wrappers. Smoke pins forbid returning to the overflow-width measurement.

## What changed in v0.40.2 — the title strip uses the app icon

The top-left brand still drew the original pale `#brand .dot` chip, which no longer matched the real icon shipped in v0.40.0. It now draws `appMarkSvg()` — a vector twin of `src-tauri/icons/icon.png` (blue gradient tile, white brush stroke, trailing dab) — so the mark is the same artwork at every DPI and in the About dialog, and needs no image file or network fetch. Smoke pins assert the mark function exists and that the brand renders it.

## What changed in v0.40.1 — the options bar can no longer lose its buttons

Narrowing the window used to push the ">" pager and the "?" help button off the right edge, because everything shared one overflow line.

The bar is now two siblings: `.opt-host` (controls, `flex: 1 1 auto`, `min-width: 0`, `overflow: hidden`) is the only part allowed to overflow, and `.opt-tail` (pager + help, `flex: none`) sits outside it. Overflow paging measures the host, so as the window narrows the controls page away behind ">" while both buttons stay pinned and clickable. Two CSS assertions in the smoke gate pin those rules, since the headless shim has no layout to catch it.

## What changed in v0.40.0 — frameless window, window buttons, new icon

**The window has no OS title bar now.** `main.rs` builds it with `.decorations(false)` and the page draws the title strip, so the name appears once — in the app's own top bar — instead of twice.

| Piece | How it works |
| --- | --- |
| Drag the window | `pointerdown` on empty top-bar space → `win_drag` → native `start_dragging` (Aero snap and window shake keep working) |
| Double-click the strip | toggles maximise via `win_toggle_maximize` |
| Minimise / maximise / close | three buttons at the right edge; the glyph swaps to "restore" while maximised; close turns red on hover |
| Resize | a frameless window loses `WS_THICKFRAME`, so seven invisible grips sit on the edges/corners and hand the gesture to `start_resize_dragging` — live resize and snapping stay native |
| Browser build | none of this exists: the chrome is only built when `isTauri()`, and every helper is a no-op outside the desktop shell |

The app icon is redrawn: a soft-rounded blue gradient tile with a white brush stroke and its trailing dab, generated analytically (3× 3 supersampling) by `scripts/make-icons.mjs` into 16/32/48/128/256 px plus a four-entry `.ico`, so taskbar and alt-tab are crisp.

Also fixed: the "?" help button no longer wraps to a second row. It now lives in a `.opt-tail` group beside the ">" pager, and the options bar never wraps — overflow is paged, never stacked.

## What changed in v0.39.2 — menus, options bar, title

| Problem | Cause | Fix |
| --- | --- | --- |
| Dropdown menus threw `pop.children.filter is not a function` | the keyboard handler cast `pop.children` (an `HTMLCollection`, no array methods) to `HTMLElement[]` | both casts now go through `Array.from(…)`; a smoke pin refuses the old shape |
| "?" help button dropped onto a second row in narrow windows | `margin-left: auto` pushed it against the far edge | it is a normal inline control at the end of the group now |
| "offline image editor" ate horizontal space in the title | static subtitle under the brand | removed — the brand is just the dot and the name |

## What changed in v0.39.1 — the exe embeds the page it just built

Two defects behind "uncaught SyntaxError: identifier 'isTauri' has already been declared":

| Problem | Cause | Fix |
| --- | --- | --- |
| The exe could ship a **stale** page | `tauri::generate_context!()` embeds `desktop-dist` at crate-compile time, and cargo considers the crate fresh when only the page changed | `scripts/build-desktop.mjs` now touches `src-tauri/src/main.rs` after regenerating, forcing the embed; the build prints a confirmation line |
| A duplicated script blanked the window | the page is one classic script, so a second copy was a fatal parse error | the concatenated bundle is wrapped in one function scope (`(function () { … })();`), so a second copy just runs in its own scope |

Nothing in the audited artifacts ever contained two `isTauri` declarations — the bundle, the single file and the desktop page each had exactly one. If the banner ever reappears, close every Guazzo window, delete `%LOCALAPPDATA%\Guazzo\WebView2`, and relaunch; if it still shows up, the banner text is the diagnostic.

## What changed in v0.39.0 — options bar refactor (last structural debt)

`buildOptionsBase()` was a ~370-line if-chain with one branch per tool: adding a
tool meant editing the middle of a ladder, and the branches shared a dozen
module globals. It is now fifteen named builders behind one switch.

- `buildMoveOptions`, `buildWandOptions`, `buildShapeOptions`, `buildQuickOptions`,
  `buildBucketOptions`, `buildEyedropperOptions`, `buildRetouchOptions`,
  `buildCloneOptions`, `buildFocusOptions`, `buildHealOptions`, `buildCropOptions`,
  `buildSelectOptions` (marquee / ellipse / lasso), `buildGradientOptions`,
  `buildTextOptions`, `buildBrushOptions` (brush / eraser).
- `optionBuilder(tool)` returns the right one. It is a **switch, not a const map**,
  because the options bar is built during boot: a `const` map referenced there hits
  the temporal dead zone (that crash happened once during this refactor and the
  smoke gate caught it). `switch` + function declarations are hoisted, so the
  dispatch cannot run before its builders exist.
- Behaviour is unchanged: same controls, same order, same paging and the same
  single "?" button. The smoke gate now also asserts that all fifteen builders are
  bundled and that every tool has a case (18 cases), so a new tool cannot ship with
  an empty options bar.

## What changed in v0.38.0 — native open/save dialogs in the desktop app

Saving used to behave like a web page in the desktop shell: the file went to
whatever folder the browser runtime picked, and "Open Image…" opened an in-page
file input. Both now use the platform's own dialogs.

| Where | Before | Now (desktop) |
| --- | --- | --- |
| Save Project (Ctrl+S) | browser download | Windows Save dialog, default name `.guazzo.json` |
| Export As… | browser download | Windows Save dialog with the format's extension |
| PSD export | browser download | Windows Save dialog, `.psd` |
| Open Image / Open Project | in-page `<input type=file>` | Windows Open dialog, filtered to the accepted extensions |
| Browser single-file build | download / input | unchanged (no Tauri, so it falls back) |

Implementation notes:

- `tauri-plugin-dialog` provides the pickers; the bytes move through two small
  Rust commands (`write_bytes` / `read_bytes`) so no filesystem plugin and no
  extra permission surface is needed. `src-tauri/capabilities/default.json`
  grants exactly `dialog:allow-open` and `dialog:allow-save` — there are still no
  network permissions in the app.
- Binary travels as base64 in both directions because Tauri IPC is JSON; a 5 MB
  PNG as a JSON number array would cost ~20 MB of parsing on a single save.
- The JS side lives in `src/ui/native.ts` and degrades to `null` outside Tauri,
  so the browser build never depends on it. One helper (`saveBlob`) owns both
  paths and they are exclusive: cancelling a native dialog does not also trigger
  a download.
- **Verification caveat:** the sandbox that builds this exe cannot host WebView2,
  so the native pickers can only be confirmed by running `Guazzo-v0.44.0.exe`
  yourself. The browser path is covered by the smoke gate.

### If a cargo build stops on a crate version that the index must contain

The crates mirror caches index files per crate. A fetch interrupted mid-write
leaves a truncated entry that cargo reads as "versions missing". Delete the one
entry and rebuild:

```bash
rm -f .cargo-mirror-cache/<first two letters>/<next two letters>/<crate-name>
```

## What changed in v0.37.0 — live preview inside the tonal dialogs

v0.36.0 gave the Adjustments and Filters *cards* a live preview. The nine modal dialogs (Levels, Curves, Exposure, Vibrance, Colour Balance, Black & White, Photo Filter, Channel Mixer, Gradient Map) were still blind: you moved sliders, pressed OK, and judged afterwards — each wrong guess costing an undo.

| Area | Change |
| --- | --- |
| **All nine dialogs preview** | Moving any slider, switching a select, ticking Preserve luminosity / Monochrome, picking a Photo Filter preset, or dragging a point in the Curves editor now updates the canvas behind the dialog. |
| **One recipe, two destinations** | Each dialog defines its op once (`current(g, r, m)`), reads live control values inside it, and passes that same function to both the preview and to OK. Preview and commit cannot drift — the classic failure mode of "approximate preview". |
| **Curves** | The curve editor has no `input` event, so edits call the preview from its own paint path — dragging a point bends the image as you drag. |
| **Dismissing clears** | `showModal` gained an `onClose` hook (with a `closed` guard so OK/Cancel/Escape double-fire cannot run it twice); every dialog clears the proxy when it closes. |
| **No-op values** | A dialog whose current values change nothing (Exposure 0 EV, Vibrance 0, an untouched curve) returns early, so an untouched dialog never re-renders the canvas. |

Everything runs through the same ≤420 px downsampled proxy as v0.36.0, so even Channel Mixer and Black & White preview in a frame; the committed result is full resolution. The smoke gate pins that the dialog wiring and the clear-on-close path are in the bundle.

## What changed in v0.36.0 — live preview in the Adjustments and Filters panels

Both panels used to be blind: you picked a filter and a number, pressed Apply, and only then saw whether it was right — undoing each attempt cost a history step.

| Area | Change |
| --- | --- |
| **Filters panel** | Moving the amount slider (or picking a different filter) now paints the result on the canvas immediately, before you commit. |
| **Adjustments panel** | Same for every adjustment in the card — brightness/contrast, levels, curves, exposure, vibrance, hue/sat, thresholds. |
| **Why it is a proxy** | The preview runs the *same* recipe on a copy of the target rect **downsampled to at most 420 px on the long side**, then draws it back at document scale with nearest sampling. A 25 px median or oil paint at 20 MP would stall the slider for seconds; the proxy answers in a frame. It is honest about what it shows: structure and colour, not final pixels. Committing always runs the real recipe at full resolution. |
| **Safety** | The proxy lives in its own `TileGrid`, so a preview can never write to your layer. Apply clears it and pushes one undo entry; the preview never touches history. |

`FilterSpec.run` now takes the target `TileGrid` instead of closing over the active layer — that one signature change is what lets the same recipe serve both the preview proxy and the committed full-resolution pass, which means the two cannot drift.

## What changed in v0.35.0 — Perspective Crop

| Area | Change |
| --- | --- |
| **Perspective Crop** | The Crop tool's options bar now offers **Perspective…**: four draggable corner handles are laid over the picture, everything outside the quad is dimmed, and **Enter** warps that quad into an axis-aligned rectangle of the same bounding-box size. **Esc** cancels. Drag a corner to place it; the handles are hit in screen space, so they stay grabbable at any zoom. |
| **How the warp works** | `src/engine/perspective.ts` builds the square→quad homography in closed form (Heckbert), then resamples **backwards** through its inverse: every destination pixel asks "where did I come from". Bilinear sampling is **premultiplied**, so transparent neighbours cannot bleed black into an edge. Refuses collinear corners instead of producing a silent garbage image. |
| **Layer recipes survive** | Every layer keeps its name, kind, visibility, opacity, blend mode, lock, group, clipping flag and deep copies of adjustment/fill/text recipes — a perspective crop does not silently turn a Curves layer into a Levels one. Masks are warped through `maskAt`/`setMaskAt`, so hidden areas stay hidden. |
| **Undo** | The crop goes through `setDocInTab(..., "Perspective Crop")`, so it is one undo step and does **not** clear the History panel. |

Covered by **9 engine tests** (corner mapping, affine rectangle ⇒ no projective term, collinear refusal, bounding box, identity warp reproduces pixels, quarter-document warp expands to full output, recipe survival, layer order/blend/group survival, transparency stays transparent). Engine tests **328**. The ui-smoke gate also asserts the engine is actually bundled and that the bar's Perspective button opens the four-corner mode — an engine that only exists in `dist/` never reaches the app.

## What changed in v0.34.0 — view keys and TIFF import

| Area | Change |
| --- | --- |
| **H — hand** | Pressing **H** toggles hand mode: drag anywhere to pan, `grab`/`grabbing` cursor, **Esc** leaves. Before this there was no hand at all — only the Space-hold, which fights any use of Space in a text box. |
| **Z — zoom lens** | Pressing **Z** toggles zoom mode: **click zooms in at the point you clicked**, Alt-click zooms out, **Esc** leaves. Zoom used to be centre-only (Ctrl++, Ctrl+−, wheel), so reaching a corner of a large document meant zooming and then panning. New `zoomAt(factor, x, y)` keeps the clicked pixel under the cursor — `zoomBy` is now a thin wrapper around it. |
| **TIFF import** | `Open Image…` accepts `.tif`/`.tiff`. Browsers cannot decode TIFF at all, so this is a hand-written reader in `src/engine/tiff.ts`: byte order II/MM, strips, **Compression** none / **LZW** / **PackBits**, **Photometric** WhiteIsZero / BlackIsZero / RGB / palette, 8-bit grey / RGB / RGBA (first extra sample = alpha), and **Predictor 2** horizontal differencing. Unsupported variants are **refused with a reason** rather than painted wrong: 16-bit, planar (separated) samples, BigTIFF, orientation ≠ 1. |

TIFF is covered by **10 engine tests** that build their files byte by byte, so nothing depends on an external fixture: exact pixels for uncompressed and big-endian, PackBits and LZW round-trips (an encoder lives in the test), predictor undo, WhiteIsZero inversion, alpha passthrough, plus the three refusal paths. Engine tests **319**.

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
