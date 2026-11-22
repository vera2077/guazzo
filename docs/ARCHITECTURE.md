# Architecture

One TypeScript engine, one shell. The engine never imports UI code; the shell
(`src/main.ts`) owns state and calls into the engine for every pixel decision.

Layering rules the gate enforces:

- `src/engine/**` imports nothing from `src/ui/**` or `src/main.ts`.
- `src/ui/**` imports the engine and takes its document state as **explicit
  dependencies** (`{ doc, push, change }` style), never by importing `main.ts`.
- `src/main.ts` is the composition root: it owns the session globals
  (`doc`, `activeLayer`, `history`, `flat`, selection) and wires the UI modules
  to them. `scripts/coupling.mjs` counts how many top-level functions there
  still touch that state; the pin may only fall.

Build order is fixed, not inferred: `scripts/single-file.mjs` lists every
compiled module in `ORDER` and fails when a module is missing from it, when a
top-level name collides across modules, or when an `import`/`export` survives
stripping. Adding a module means adding it to that list.

## Modules

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
  fillgradient.ts    gradient fill layers: sampling maths
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
  filldialog.ts      New Fill Layer dialog (solid / linear / radial)
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

## The gate

`node scripts/ci.mjs` runs six stages: build (typecheck → bundle → desktop-dist),
static pins, the engine test suite, the UI smoke run, version lockstep, and a
deterministic double build. It is the only thing that decides whether a change
ships; a release additionally requires `scripts/release.mjs` (staging + hashes)
and `scripts/package.mjs` (the zip), in that order.
