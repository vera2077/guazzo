# Guazzo

*Guazzo — the Italian word the French *gouache* was borrowed from; watery paint.*

A fully-offline, Photoshop-like image editor. No accounts, no cloud, no network —
the app never makes a single network request.

## Run it

| How | What |
| --- | --- |
| **Desktop app** | Take the release zip from `release/<version>/`, extract it, and run the `.exe`. Keep `WebView2Loader.dll` beside it — the zip contains both. Windows 10/11 includes the WebView2 runtime; only the loader stub ships separately. SmartScreen may warn because the build is unsigned: choose **More info → Run anyway**. Do not run it as administrator. |
| **Single file** | Open `app-single.html` from the same zip in any modern browser — the same app in one ~2.0 MB HTML file, running from a USB stick or a folder. |
| **Dev server** | `node scripts/serve.mjs` → http://127.0.0.1:5188/ |

Every release archive also contains `README.txt` (quick start), `LICENSE`,
`THIRD-PARTY-NOTICES.md`, `SHA256SUMS.txt`, and `RELEASE.json`. Verify a download
with `sha256sum -c SHA256SUMS.txt` inside the extracted folder.

**Download:** [github.com/vera2077/guazzo/releases/latest](https://github.com/vera2077/guazzo/releases/latest)
— take `Guazzo-v<version>.zip`, extract it, and run the `.exe`. The build is **unsigned**, so
Windows shows "Unknown publisher" and SmartScreen may warn on first launch;
code signing is planned, not purchased. Guazzo never checks for updates and
contains no network code: update by replacing the program folder with a newer
release zip. Your `.guazzo.json` documents keep working; see
[`docs/PUBLISH.md`](docs/PUBLISH.md).

> **Never run the exe as administrator.** An elevated run creates the app's
> WebView2 data folder (`%LOCALAPPDATA%\Guazzo\WebView2`) with Administrators
> ownership, after which normal launches fail to write it and exit. Launch
> normally and it stays healthy.
>
> **Rebuilding inside a sandboxed workspace:** files there can inherit a **Low
> integrity label**, and Windows runs a process at its exe's label — a
> Low-integrity Guazzo cannot write its WebView2 data folder (`os error 5`).
> The shipped exes are labeled Medium. After rebuilding from source in such a
> tree, relabel the outputs:
> `icacls Guazzo.exe /setintegritylevel medium` (and on
> `WebView2Loader.dll`).

## Licence

Guazzo is **source-available, not open source**. You may install and use it, for
personal or commercial work, but the copyright stays with the author and the
licence grants no right to redistribute it — see [`LICENSE`](LICENSE). The source
is published so the build can be audited and reproduced, not as a grant of rights
beyond that licence. Third-party components and their terms are listed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Name & trademarks

> Guazzo is an independent product. It is not affiliated with, endorsed by, or
> sponsored by Adobe Inc. Photoshop® and .PSD are trademarks of Adobe Inc.;
> Guazzo reads and writes .PSD files using the openly published Photoshop File
> Format Specification. All other trademarks belong to their respective owners.

## Features

- **Pressure-aware painting** — pen tablet primary, mouse fallback; brush + eraser (B/E); stroke rendering is frame-coalesced and allocation-free, so even a size-300 eraser glides at full speed; **Flow** controls per-dab build-up, **Smooth** is pulled-string stroke smoothing, **Scatter** jitters dabs for spray effects, and **pen tilt flattens the nib into an ellipse** like a real tilted pen; **brush tips**: built-in Soft round / Square / Chalk / Spray, plus **Custom… to load any PNG/JPEG as your own brush** (transparency = density, or black-on-white for opaque images)
- **Free Transform** — the **⤢ button in the left toolbar** (click again to Apply), the **⤢ in the Layers panel's action strip**, or **double-click any layer's row**; Ctrl+T still works; drag inside the frame to move, a corner to scale, outside to rotate (Shift snaps 15°); live readout with Apply/Cancel; Enter commits, Esc cancels; fully undoable
- **Text tool (T)** — click the canvas for a live editable text box (drag its ✥ handle to reposition); **multiline: Shift+Enter makes a new line**, with per-line spacing; **select any portion of the text and apply bold / italic / underline / strikethrough / a different font to just that part**; **click existing text to re-edit it** — content, styling, and size all changeable, committed in place as one undoable step; Enter or click-away commits, Esc discards; the recipe survives project save/load and PSD import/export where representable; **Load font… imports any .ttf/.otf/.woff/.woff2 from your computer** for the session
- **Layers and groups** — add, duplicate, reorder, delete, visibility, opacity, 27 Photoshop blend modes, live composite, **group nodes with nesting, pass-through and opacity**, drag-to-reparent, and keyboard tree navigation; **Merge Down (⇩ strip button or Ctrl+E)** and **Flatten Image (⊟)** are fully undoable as one history step
- **Full undo/redo** — strokes, layer ops, adjustments, filters, gradients, deletes; Ctrl+Z / Ctrl+Shift+Z; clickable History panel that scrolls on its own and follows the newest edit without losing your place when you scroll back
- **Your own panel layout** — every panel card resizes from its bottom grip and collapses from its header; the column resizes from its left divider; Tab hides panels + toolbar; `View ▸ Reset Panel Layout` restores the defaults; all of it is remembered between sessions
- **Interface** — Photoshop's layout (toolbar left, options bar on top, panels right) in a softer, modern skin: rounded cards, one restrained blue accent, real vector icons throughout, and a status bar showing **zoom, canvas size, active layer, history position** and the permanent "100% offline" reminder
- **File I/O** — open PNG/JPEG/WebP/GIF/**PSD**; save editable `.guazzo.json` projects; **Export As… (PNG / JPEG / WebP / PSD)**; **Image Size…** resamples every layer (bilinear) with a keep-aspect lock, **Canvas Size…** re-anchors content with a 9-point anchor picker
- **Multiple documents** — Photoshop-style tabs: open several images/projects at once, each keeps its own layers, history, selection, and zoom; click a tab to switch, × to close, ＋ for a new document
- **Autosave & crash recovery** — changes are tracked per document. Autosave waits for a **2 second idle window** after the last edit and runs **at most every 30 seconds** while edits continue, so a full 4096² document is not serialised on every stroke. Snapshots are deflated in the browser's private OPFS storage; nothing leaves your disk. After a crash, relaunch offers "Found an unsaved autosave from …" with Restore / Discard — every tab comes back. Failed writes back off and say so.
- **PSD import** — layers, stacking, names, offsets, blend modes, opacity, visibility, **group nodes with nesting, group opacity/blend and Photoshop's pass-through default**, raster masks (baked to alpha), **live adjustment records** for invert, threshold, posterize, curves, brightness/contrast, photo filter, colour balance, black & white, levels, exposure, vibrance, and hue/saturation, **live solid-colour fills**, and **live text recipes** with font substitution reporting. Layer-style effects are baked in Photoshop's order (shadow → glow → stroke → content → inner shadow → inner glow → bevel). Anything that cannot stay live is named in the import report rather than dropped silently.
- **PSD export** — exports a real layer tree when every layer is representable (pixels, live adjustment records, solid fills, text recipes, groups, masks, clipping); otherwise it writes one honest flattened image and says why. Dense curves are written as pencil tables, masked pixels keep their polarity, and PSD parsing/exporting is budgeted before allocation.
- **Move tool (V)** — drag the active layer, or just the selected pixels when a selection is live (the hole is left behind, like Photoshop); arrows nudge 1 px, Shift+arrows 10 px; one undo step per drag, lossless — content is re-derived from a snapshot, never re-shifted
- **Crop tool (C)** — drag a crop rectangle over a dimmed canvas with rule-of-thirds guides, then **Enter** (or *Apply crop*) to commit, **Esc** to cancel; every layer is re-anchored, never resampled
- **Magic Wand (W)** — click to select all touching pixels within the tolerance (0–255); untick *Contiguous* to catch every similar colour in the layer; anti-aliased edge fringe; feeds every selection-aware command (brush, filters, adjustments, fill, move)
- **Quick Selection (Shift+W)** — click or drag to grow one cached region while the pointer stays inside it; Shift adds, Alt subtracts
- **Paint Bucket (Shift+G)** — flood-fill with the foreground colour, honouring tolerance, opacity and any live selection; one undo step
- **New Document dialog (Ctrl+N)** — Photoshop-shaped: name, document-type presets, width/height with inch/cm/mm/pt/pica units that convert as you switch them, resolution (ppi/ppcm), colour mode and bit depth (unsupported combinations are shown, disabled, and labelled), background contents with a live swatch, colour profile, pixel aspect ratio and a live "Image Size" readout; save and delete your own presets
- **Menu bar** — a real File / Edit / Image / Layer / Select / Filter / View / Help bar across the top; greyed-out items tell you what is currently unavailable, and every entry is the same command as its shortcut
- **Right-click context menus** — on the canvas (clipboard, selection, export), layer rows (duplicate/rename/blend ▸/opacity/clipping/masks/merge), history rows (step to here, clear), document tabs (close/save/export), toolbar buttons (tool families, like Photoshop's flyouts) and colour swatches (delete); Ctrl+C/X/V + Ctrl+Shift+C Copy Merged with paste-as-new-layer
- **Selections** — rectangular marquee (M, cycles with elliptical ⬭ M), freehand lasso (L), polygon/pen paths, marching ants, paint/adjust/filters/gradients clip per-pixel to any selection shape, Ctrl+D deselect, Delete erases under the mask
- **Gradient tool (G)** — linear/radial, per-stop color + alpha (foreground→transparent default), drag defines the axis, fills selection or layer
- **Adjustment layers** — brightness/contrast, levels, curves, exposure, vibrance, hue/saturation, colour balance, black & white, photo filter, invert, posterize, threshold, desaturate; 13 live recipes with masks and blend modes
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

## Changelog

Newest first. Full long-form notes for every release live in
[`docs/CHANGELOG-ARCHIVE.md`](docs/CHANGELOG-ARCHIVE.md); this table is the
current-only history.

| Version | What changed |
| --- | --- |
| 1.0.0 | First stable release. Streaming v2 autosave for 4096² multi-layer sessions, deterministic downloadable zip, documentation/performance truth, and the unsigned/no-update release policy. No new editing capability. |
| 0.74.0 | Downloadable deterministic zip packaging; one PSD export-loss decision shared by dialog/stats/writer; idle-debounced deflated autosave; blur without per-tap clamping; export-canvas refusal; consistent 16k PSD import budget. |
| 0.73.0 | Handoff 9 blockers: mask-polarity round trips, nested group export, PSD/TIFF parse caps, ARIA/group/keyboard UX, import/export honesty, test and performance work, build receipts and bounded IPC. |
| 0.72.0 | Drag-to-reparent, ARIA tree rows and keyboard navigation, larger chevron target. |
| 0.71.0 | Indented/collapsible layer tree, colour-tag chips, PSD groups as real nodes. |
| 0.70.7 | Portable single-file CSP, text recipes through geometry changes. |
| 0.70.6 | Native open path executed in the smoke gate. |
| 0.70.5 | Window-chrome keyboard route. |
| 0.70.4 | Mask polarity instead of a canvas-wide fill. |
| 0.70.3 | The gate now says when it cannot verify a claim. |
| 0.70.2 | Release staging refuses stale code. |
| 0.70.1 | Handoff 8 shortcuts, semantics and paths. |
| 0.70.0 | Desktop path executed rather than described. |
| 0.69.0 | Release staging a test can run. |
| 0.68.0 | Handoff 8 allocation cluster begins. |
| 0.67.0 | Handoff 8, first three fixes. |
| 0.66.0 | Cached preview proxy, one OK path, compile-time seams. |
| 0.65.1 | One mask policy; two more executable assertions. |
| 0.65.0 | Refine, popup seams, preview executed. |
| 0.64.0 | Handoff 7 correctness and gate honesty. |
| 0.63.2 | The title-bar close button closes again. |
| 0.63.1 | The keyboard table is the contract. |
| 0.63.0 | Handoff 6: data safety, a gate that can fail, restored features. |

## Documentation

- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — measured numbers and the cost of the largest paths.
- [`docs/CHANGELOG-ARCHIVE.md`](docs/CHANGELOG-ARCHIVE.md) — long-form history and pre-0.63 notes.
- [`docs/handover/README.md`](docs/handover/README.md) — handover documents and what each one covers.
- [`docs/PUBLISH.md`](docs/PUBLISH.md) — first-push and release-asset checklist.
- [`RELEASE.md`](RELEASE.md) — release order, packaging, retention, and integrity checks.

## Architecture

TypeScript engine. The engine has no runtime npm dependencies at all; the only
third-party code in the shipped app is the vendored `ag-psd` UMD bundle (the PSD
reader/writer), inlined into the single file so nothing is ever fetched.

Every source module is listed below so a new contributor can find the owner of a
behaviour instead of grepping `main.ts`.

```
src/engine/
  adjust.ts          pure pixel adjustments (brightness, hue, posterize, …)
  adjustfn.ts        adjustment-layer recipes → pointwise transforms
  autosave.ts        snapshot codec and idle/capped autosave scheduler
  blend.ts           all 27 blend modes + behind/clear (W3C compositing)
  docmeta.ts         units, presets, image-size maths
  document.ts        Document/Layer model, tree, compositor, masks
  effects-bake.ts    layer-style effects rasterisation for PSD import
  exportlimit.ts     export-canvas size refusal predicate
  filter.ts          blur/sharpen/noise/pixelate (premultiplied float)
  filters2.ts        motion/radial/box/median blur, distort, stylize, render
  flood.ts           magic wand + paint bucket region growth
  gradient.ts        linear/radial/angle/reflected/diamond gradients
  heal.ts            patch-based spot healing + content-aware fill
  history.ts         hybrid undo: commands + dirty-tile snapshots
  imageops.ts        rotate/flip/trim, rebuilding layers by re-anchoring
  importreport.ts    import-report contract and feature labels
  io.ts              .guazzo.json project format v1
  mask.ts            sparse selection and layer-mask storage
  move.ts            lossless layer/pixel moving from one snapshot
  paint.ts           pressure-aware dab stamping, clip-aware
  path.ts            pen-path geometry and rasterisation
  perspective.ts     perspective-crop sampling
  plane.ts           solid fills with opacity/mask/blend
  psd.ts             parsed-PSD mapping to Document
  psdexport.ts       Document → PSD layer records
  refine.ts          edge refinement and feather fixed-point detection
  resize.ts          resample, canvas resize with anchors, crop
  retouch.ts         dodge/burn/sponge/focus/smudge/clone/red-eye
  sample.ts          colour sampling and neighbourhood reads
  selectops.ts       expand/contract/feather/smooth/border/grow/similar
  shapes.ts          supersampled rectangle/ellipse/line/polygon/star
  textmap.ts         text measurement, wrapping and run layout
  tiff.ts            TIFF reader (LZW/PackBits/predictor)
  tile.ts            256 px sparse tile grid
  tone.ts            LUT/curve/levels/exposure engine, histogram, auto tone
  transform.ts       free transform (move/scale/rotate/skew/perspective)
src/ui/
  adjust-forms.ts    adjustment and filter dialog forms
  closeloop.ts       close-request guard and acknowledgement loop
  dialogs.ts         modal/dialog base and focus containment
  dock.ts            panel docking, resizing and collapse
  exportdlg.ts       export dialog, scale and loss preview
  flatcache.ts       full-document composite cache
  historypanel.ts    History panel
  icons.ts           vector icon set
  keymap.ts          accelerator model
  layerops.ts        layer/group tree actions
  layerspanel.ts     Layers panel, drag reparent and ARIA tree
  licence.ts         licence text and About dialog
  native.ts          Tauri bridge (save/open/window/close)
  newdoc.ts          New Document dialog
  notices.ts         generated third-party notices embed
  palette.ts         command palette
  popup.ts           menus, submenus and placement
  previewqueue.ts    coalesced preview render scheduler
  proxykey.ts        preview cache key derivation
  session.ts         document/session state, collapse set, panel rows
  shortcuts.ts       shortcut table and help metadata
  tabs.ts            document tab state and switching
  textseed.ts        text recipe placement helpers
  tonal.ts           tonal adjustment dialogs
  toollabels.ts      tool labels, titles and family metadata
  windowchrome.ts    custom window chrome and resize grips
src/main.ts          controller: viewport, tools, panels, menus, history
vendor/              vendored ag-psd UMD bundle, no CDN or network fetch
scripts/             build, gate, smoke, packaging and release tooling
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

## Build from source

Requirements: **Node ≥ 22.18**, pnpm, Rust (WinLibs/MinGW works — the shipped
exe is built with it), and WebView2 (built into Windows 11).

One command runs the whole web pipeline — TypeScript compile, the single-file
bundle (with its staleness/order/collision guards), a bundle syntax check, and
the `desktop-dist/` refresh:

```bash
npm run desktop          # = node scripts/build-desktop.mjs

# the gate (un-piped; do not redirect its output away)
node scripts/ci.mjs

# desktop exe
cd src-tauri && CARGO_HOME=../.cargo-home cargo build --release

# deterministic release zip (after staging)
node scripts/package.mjs <version>
```

Freshness is enforced on BOTH sides: `build-desktop.mjs` refuses to bundle a
stale `dist/`, and `src-tauri/build.rs` refuses to compile if any
`src/**/*.ts` (or `index.html`) is newer than `desktop-dist/index.html` — a
stale exe can no longer be produced by accident. Versions live in four files
(`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
`src/main.ts`); keep them in lockstep with `node scripts/bump.mjs <x.y.z>`
(or `--check`), then let `cargo build --release` update `Cargo.lock`.

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
| `Ctrl+A` / `Ctrl+D` / `Ctrl+Shift+I` | Select all / deselect / invert selection |
| `Alt+Backspace` | Fill selection with the foreground colour |
| `Ctrl+J` / `Ctrl+Shift+N` | Duplicate layer / new layer |
| `↑↓←→` (Move tool) | Nudge active layer 1 px — add Shift for 10 px |
| `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | Undo / Redo |
| `Del` / `Backspace` | Clear the selection area on the active layer |
| `Esc` | Cancel current action (transform, text box, selection) |
| In the text box: `Enter` commits · `Shift+Enter` new line · `Esc` discards |

## Non-goals (by design)

Cloud/generative features (Firefly-style), online activation or licensing of
any kind, CMYK/Lab color modes, 16/32-bit PSD writing, and a built-in update
checker. The app is offline forever, by design.

## Roadmap

- Smart objects, 16-bit PSD, additional layer styles
- Remaining PSD fidelity gaps (selective colour, colour lookup, channel mixer,
  gradient-map records as live model kinds)
- Brush texture, dual/eraser-tip dynamics, airbrush mode
- Optional local ML (subject select, denoise) with user-supplied models — never
  downloaded by the app
