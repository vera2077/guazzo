# Guazzo

*Guazzo — the Italian word the French *gouache* was borrowed from; watery paint.*

A fully-offline, Photoshop-shaped image editor for Windows. No accounts, no
cloud, no network — the app never makes a single request.

## Run it

| How | What |
| --- | --- |
| **Desktop** | Download `Guazzo-v<version>.zip` from the [releases page](https://github.com/vera2077/guazzo/releases/latest), extract it, run the `.exe`. Keep `WebView2Loader.dll` beside it — the zip has both. Windows 10/11 already has the WebView2 runtime. |
| **Single file** | Open `app-single.html` from the same zip in any modern browser — the same app in one ~2 MB file, no install, works from a USB stick. |
| **From source** | `node scripts/serve.mjs` → http://127.0.0.1:5188/ (see *Build from source*). |

The build is **unsigned**, so Windows shows "Unknown publisher" and SmartScreen
may warn on first launch (**More info → Run anyway**). Every release ships
`SHA256SUMS.txt`, `RELEASE.json` and `LICENSE`; verify a download with
`sha256sum -c SHA256SUMS.txt` inside the extracted folder. Guazzo never checks
for updates and contains no network code — update by replacing the folder.

> **Never run the exe as administrator.** An elevated run creates
> `%LOCALAPPDATA%\Guazzo\WebView2` with Administrators ownership, after which
> normal launches fail to write it and exit.

## What it does

- **Painting** — pressure-aware brush and eraser with flow, smoothing, scatter,
  pen-tilt nib flattening, four built-in tips, custom PNG/JPEG brushes, and a
  **second tip** that multiplies dab coverage (dual brush); hardness means the
  same thing in every tool — the fraction of the radius that is fully opaque.
- **Layers** — 27 blend modes, opacity, masks, clipping, **nested groups** with
  pass-through and opacity, drag-to-reparent, keyboard tree navigation, merge
  and flatten as one undo step.
- **Selections** — rectangular/elliptical marquee, lasso, pen paths, magic wand,
  quick selection, Select and Mask with feathering; every paint, filter,
  adjustment, gradient and fill clips per-pixel to the selection.
- **Adjustments** — 17 live adjustment-layer recipes (levels, curves, exposure,
  vibrance, hue/saturation, colour balance, black & white, photo filter, invert,
  posterize, threshold, brightness/contrast, desaturate, gradient map, channel
  mixer, selective colour, colour lookup from a `.cube` table) with masks and
  blend modes.
  Every adjustment layer reopens in **Adjustment Settings…** with the editor its kind
  needs — curves drawn by hand, levels, a nine-slider colour balance, six black &
  white bands — and each edit is one undo step that restores the recipe, not the pixels.
- **Leaving safely** — closing the window asks before losing work, and the
  prompt can **save each document first**; a cancelled save keeps the window
  open with the work still there.
- **Fill layers** — solid colour, a **multi-stop linear/radial gradient** (up to
  eight stops) or a **generated pattern** (checker, stripes, dots), all live and
  editable (new in 1.2.4, multi-stop and patterns in 1.3.0; PSD solid fills
  import and export as records).
- **Filters** — 29, grouped as blur, sharpen, noise, distort, stylize, render,
  pixelate and other; each honours the selection and lands as one undo step.
- **Text** — editable recipes with per-run bold/italic/underline/strike/font,
  per-run size and colour, multiline, paragraph alignment
  (left/centre/right/justify), local font loading, and recipes that survive
  save/load and PSD, including the per-run styling.
- **Transform and crop** — free transform, perspective crop, image size
  (bilinear), canvas size with 9 anchors, rotate/flip/trim.
- **PSD** — import layers, groups, pass-through, masks, 14 live adjustment kinds,
  solid fills, text recipes; export a real layer tree when every layer is
  representable, otherwise one honest flattened image that says why. Anything
  that cannot stay live is named in the import report.
- **Files** — open PNG/JPEG/WebP/GIF/PSD/TIFF, or drop a picture straight onto the canvas to place it as a layer (onto the tab bar to open it as a new project); save editable `.guazzo.json`
  projects; export PNG/JPEG/WebP/PSD; multiple tabs; autosave with crash
  recovery, idle-debounced and deflated in private OPFS storage.
- **Interface** — Photoshop's layout (toolbar, options bar, panels) with
  resizable/collapsible cards, tab bar, right-click menus, a command palette
  (Ctrl+K), a real menu bar, and full keyboard navigation including the layer tree.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module map, layering rules, the gate.
- [`docs/COMPAT.md`](docs/COMPAT.md) — what survives a PSD round trip.
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — measured numbers for the largest paths.
- [`docs/CHANGELOG-ARCHIVE.md`](docs/CHANGELOG-ARCHIVE.md) — long-form history.
- [`docs/PUBLISH.md`](docs/PUBLISH.md) · [`RELEASE.md`](RELEASE.md) — release checklist and order.
- [`docs/SIGNING.md`](docs/SIGNING.md) — how to check a signature, and how to sign.
- [`docs/handover/README.md`](docs/handover/README.md) — handover documents.

## Changelog

Newest first; long-form notes for every release live in
[`docs/CHANGELOG-ARCHIVE.md`](docs/CHANGELOG-ARCHIVE.md).

| Version | What changed |
| --- | --- |
| 1.11.1 | The Layers panel footer is one row of seven 24 px buttons instead of eleven that wrapped into two rows. Merge, Flatten, Free Transform and clipping moved to the layer menus, where they already were; Delete sits alone at the right edge so a mis-aimed click cannot delete the layer you were about to mask. |
| 1.11.0 | Drag a picture onto the canvas and it lands as a new layer, scaled to fit and centred, on the document you already have open. Drag it onto the tab bar instead and it opens as its own project. Anything that is not an image still opens by path, as before. |
| 1.10.0 | Dual brush: a second tip multiplies each dab's coverage, so a stroke breaks up instead of being one flat disc; it is a dropdown next to the brush options with its own size. Also fixed: hardness was inverted for the brush and eraser (100% was the softest setting while the same slider was crisp for dodge, burn and sponge) — one slider now means one thing. |
| 1.9.0 | Per-run text sizes and colours: select part of a line, set a size or a colour, and only that run changes — the recipe keeps each run's size and colour, the rasteriser measures and paints each run at its own size and colour, and the PSD type record carries them both ways instead of collapsing to the base style. |
| 1.8.0 | Colour Lookup is a live adjustment kind: load a `.cube` 3D table, see what the cube's own header says, and confirm — a lookup layer cannot be created without a table, because a layer that changes nothing is a layer that lies. The table persists in projects and round-trips through PSD as a `3dlut` record; unreadable cubes and abstract profiles are admitted instead of guessed. |
| 1.7.0 | Selective Colour is a live adjustment kind: six hue ranges and three tone ranges (whites, neutrals, blacks), each with cyan/magenta/yellow/black offsets in relative or absolute mode, kept per range while you switch, persisted in projects and round-tripping through PSD. |
| 1.6.1 | Interface review pass: the palette can no longer lock itself open, a crop no longer survives a tool switch, the tab strip repaints, the status bar clips instead of hiding its error slot, the floating palette sits under modals, the unbacked `Alt+Ctrl+G` claim is gone, submenu Escape steps back, the viewport renders at device pixel ratio, history rows are keyboard-reachable, tabs scroll into view, and Space-drag pans. |
| 1.6.0 | Channel Mixer is a live adjustment kind: one set of weights per output channel (plus a monochrome gray mixer) that reads the source pixels, persisted in projects and round-tripping through PSD. |
| 1.5.0 | Gradient Map is a live adjustment kind, and its PSD record round-trips: the dialog sets shadows, an optional midtone and highlights, the stops survive save/load, and import reads Photoshop's solid gradient-map stops back into the recipe (noise gradients are admitted). |
| 1.4.2 | The unsaved-changes prompt can save: **Save** writes every dirty document, then the window closes; cancelling a save returns you to the app with the work still marked dirty. |
| 1.4.0 | Adjustment Settings: adjustment layers reopen with a real editor per kind (shared curve widget for the adjustment dialog and the destructive Curves), and the recipe is undoable. UI review fixes: Escape on the unsaved prompt no longer leaves the window unquittable, arrows skip disabled menu rows and dead rows explain themselves, Layer Mask is reachable from the menu bar and the palette, the close prompt's destructive answer is neutral, and failures get a persistent error slot instead of a 2.6 s hint. |
| 1.3.1 | Fill-layer UI review: forward Tab no longer dead-ends on hidden controls, menus return focus before opening a dialog, the palette marks the commands the menus disable and announces its active row, options-bar selects are named, layer-row focus ring reaches 3:1, gradient and pattern thumbnails show their real content. |
| 1.3.0 | Multi-stop gradient fills (up to eight stops, add/remove/reorder in the dialog) and generated pattern fills (checker, stripes, dots) with an adjustable tile size. |
| 1.2.4 | Fill layers can be created at all (solid or two-stop gradient), and they stay live. UI follow-ups: busy state for long crops, menu-bar roles, tree Left/Right. |
| 1.2.3 | Two performance fixtures that could not fail now do; group deletion asks before removing a subtree. |
| 1.2.2 | Review fixes: mask polarity through perspective crop, Move composites the changed region once, release-integrity hardening, contrast and focus-ring fixes. |
| 1.2.1 | Fix a regression in 1.2.0: the Move snapshot scanned the whole layer for its bounds. |
| 1.2.0 | Perspective crop warps in strips (5.4 GB → 4.4 MB at 16k) and mask filling uses one tile of scratch. |
| 1.1.1 | Single Windows manifest (DPI, long paths, Common Controls) and release notes become a staged file. |
| 1.1.0 | Apache-2.0; the repo builds on a normal machine (no committed cargo mirror); CI on every push. |
| 1.0.0 | First stable release. |

## Build from source

**Node ≥ 22.18**, Rust (WinLibs/MinGW works; the shipped exe is built with it),
WebView2 (built into Windows 11).

```bash
npm install
node scripts/build-desktop.mjs     # tsc → single-file bundle → desktop-dist/
node scripts/ci.mjs                # the gate (un-piped: do not redirect it away)
cd src-tauri && cargo build --release   # CARGO_HOME=../.cargo-home in a sandbox
```

Freshness is enforced on both sides: the bundler refuses a stale `dist/`, and
`src-tauri/build.rs` refuses to compile if any source is newer than
`desktop-dist/index.html`. Versions live in four files; `node scripts/bump.mjs
<x.y.z>` keeps them in lockstep (`--check` verifies).

In a sandbox where `~/.cargo` is not writable, point `CARGO_HOME` at a folder
you own. If cargo cannot reach crates.io, serve it locally:
`node scripts/crates-mirror.mjs &` then copy `src-tauri/.cargo/config.toml.example`
to `src-tauri/.cargo/config.toml` (that file is gitignored on purpose — it
would break a normal build).

## Where the app keeps its data

Nothing in the cloud; the app never opens a socket. Besides the files you pick,
it writes two local caches:

- `%LOCALAPPDATA%\Guazzo\WebView2` — the WebView2 profile (panel layout, toolbar
  width, document presets). Safe to delete while the app is closed.
- `%LOCALAPPDATA%\Pigment\WebView2` — **orphaned** leftover from builds before
  the v0.28.0 rename; nothing reads it and it can be deleted.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `B` / `E` | Brush / Eraser |
| `V` / `C` | Move / Crop |
| `M` / `L` | Marquee (again for ellipse) / Lasso |
| `W` / `Shift+W` | Magic wand / quick selection (Shift add, Alt subtract) |
| `G` / `T` | Gradient / Text |
| `I` / `O` / `S` / `U` | Eyedropper / dodge-burn-sponge / clone stamp / shapes |
| `H` / `Z` | Hand / zoom lens (Space+drag and middle-drag pan) |
| `Ctrl+T` | Free transform (Enter applies, Esc cancels) |
| `Ctrl+E` | Merge down |
| `Ctrl+K` | Command palette |
| `Ctrl+A` / `Ctrl+D` / `Ctrl+Shift+I` | Select all / deselect / invert |
| `Alt+Backspace` | Fill selection with the foreground colour |
| `Ctrl+J` / `Ctrl+Shift+N` | Duplicate layer / new layer |
| Arrows (Move tool) | Nudge 1 px — Shift for 10 px |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Del` | Clear the selected area |
| `Tab` / `Shift+Tab` | Hide panels + toolbar / panels only |
| `Esc` | Cancel the current action |

Full list: **Help ▸ Keyboard Shortcuts**.

## Non-goals (by design)

Cloud or generative features, online activation, CMYK/Lab colour modes,
16/32-bit PSD writing, and an update checker. Offline forever.

## Roadmap

- Smart objects, 16-bit PSD, additional layer styles
- Airbrush build-up (keep depositing while the pointer rests) and pen-pressure curves
- Optional local ML (subject select, denoise) with user-supplied models — never
  downloaded by the app

## Licence

**Apache License 2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Use,
modify and redistribute freely, including commercially, keeping the licence and
notice files and stating your changes. The licence grants no rights to the name
**Guazzo** or the author's trademarks: a fork is welcome, a fork called Guazzo is
not. Third-party terms are in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

> Guazzo is an independent product. It is not affiliated with, endorsed by, or
> sponsored by Adobe Inc. Photoshop® and .PSD are trademarks of Adobe Inc.;
> Guazzo reads and writes .PSD files using the openly published Photoshop File
> Format Specification. All other trademarks belong to their respective owners.
