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
  pen-tilt nib flattening, four built-in tips and custom PNG/JPEG brushes.
- **Layers** — 27 blend modes, opacity, masks, clipping, **nested groups** with
  pass-through and opacity, drag-to-reparent, keyboard tree navigation, merge
  and flatten as one undo step.
- **Selections** — rectangular/elliptical marquee, lasso, pen paths, magic wand,
  quick selection, Select and Mask with feathering; every paint, filter,
  adjustment, gradient and fill clips per-pixel to the selection.
- **Adjustments** — 13 live adjustment-layer recipes (levels, curves, exposure,
  vibrance, hue/saturation, colour balance, black & white, photo filter, invert,
  posterize, threshold, brightness/contrast, desaturate) with masks and blend modes.
  Every adjustment layer reopens in **Adjustment Settings…** with the editor its kind
  needs — curves drawn by hand, levels, a nine-slider colour balance, six black &
  white bands — and each edit is one undo step that restores the recipe, not the pixels.
- **Fill layers** — solid colour, a **multi-stop linear/radial gradient** (up to
  eight stops) or a **generated pattern** (checker, stripes, dots), all live and
  editable (new in 1.2.4, multi-stop and patterns in 1.3.0; PSD solid fills
  import and export as records).
- **Filters** — 29, grouped as blur, sharpen, noise, distort, stylize, render,
  pixelate and other; each honours the selection and lands as one undo step.
- **Text** — editable recipes with per-run bold/italic/underline/strike/font,
  multiline, paragraph alignment (left/centre/right/justify), local font loading,
  and recipes that survive save/load and PSD where representable.
- **Transform and crop** — free transform, perspective crop, image size
  (bilinear), canvas size with 9 anchors, rotate/flip/trim.
- **PSD** — import layers, groups, pass-through, masks, 12 live adjustment kinds,
  solid fills, text recipes; export a real layer tree when every layer is
  representable, otherwise one honest flattened image that says why. Anything
  that cannot stay live is named in the import report.
- **Files** — open PNG/JPEG/WebP/GIF/PSD/TIFF; save editable `.guazzo.json`
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
| 1.2.4 | Fill layers can be created at all (solid or two-stop gradient), and they stay live. UI follow-ups: busy state for long crops, menu-bar roles, tree Left/Right. |
| 1.3.0 | Multi-stop gradient fills (up to eight stops, add/remove/reorder in the dialog) and generated pattern fills (checker, stripes, dots) with an adjustable tile size. |
| 1.4.0 | Adjustment Settings: adjustment layers reopen with a real editor per kind (shared curve widget for the adjustment dialog and the destructive Curves), and the recipe is undoable. UI review fixes: Escape on the unsaved prompt no longer leaves the window unquittable, arrows skip disabled menu rows and dead rows explain themselves, Layer Mask is reachable from the menu bar and the palette, the close prompt's destructive answer is neutral, and failures get a persistent error slot instead of a 2.6 s hint. |
| 1.3.1 | Fill-layer UI review: forward Tab no longer dead-ends on hidden controls, menus return focus before opening a dialog, the palette marks the commands the menus disable and announces its active row, options-bar selects are named, layer-row focus ring reaches 3:1, gradient and pattern thumbnails show their real content. |
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

- More adjustment kinds (selective colour, colour lookup, channel mixer, gradient map)
- Remaining PSD fidelity gaps: selective colour, colour lookup, channel mixer,
  gradient-map records as live model kinds; per-run text sizes and colours
- Smart objects, 16-bit PSD, additional layer styles
- Brush texture, dual/eraser-tip dynamics, airbrush mode
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
