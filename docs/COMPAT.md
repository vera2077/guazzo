# PSD compatibility

Guazzo reads and writes **8-bit RGB** Photoshop documents. This page is the
contract: what survives a round trip, what is converted, and what is reported
as an admission rather than silently dropped.

Two rules govern the whole file:

1. **Import never fails because a feature is unsupported.** It imports what it
   can and lists every loss, by path, in the import report. The report is shown
   once after opening and the status line keeps a summary.
2. **Export writes a tree, or it writes one flattened image — never a
   half-tree.** A group composites as one source, so exporting "most of" a tree
   would change the picture while looking like it worked. When any root layer
   cannot be represented, the whole document is composited and the admission
   names the layers that blocked it.

## Import

| PSD feature | Result |
| --- | --- |
| Pixel layers: opacity, blend mode, visibility, clipping | Live. |
| Layer masks | Baked into the layer's alpha (the same rule Photoshop's own flatten uses). |
| Groups, nested groups, group opacity/blend/visibility | Live tree nodes. |
| Pass-through groups | Live, and `passThrough` is kept — see below. |
| Adjustment layers | 17 kinds live (list below). Fields the model does not have are admitted per field, not dropped silently. |
| Solid-colour and gradient fills | Live fill layers. Linear and radial gradients keep their stops and angle. |
| Pattern fills, and any fill with a layer mask or styles | Rasterised; the recipe is admitted. A PSD pattern is a bitmap, and Guazzo's pattern fills are procedural. |
| Text layers | Editable when the text is horizontal, axis-aligned and unwarped; see the text guards. |
| Layer effects (drop shadow, inner shadow, outer/inner glow, bevel, solid fill, gradient overlay, stroke) | Live recipes, rendered at composite time and written back on export. |
| Styles on an adjustment or fill layer | Admitted: those layers have no pixels of their own to render a style over. |
| Smart objects and placed files | Rasterised and admitted. Photoshop keeps the placed file's **original** pixels inside the PSD; the reader exposes only the placed result at document resolution, so a live re-edit cannot be reconstructed. |
| Vector shapes | Rasterised; a vector fill is admitted unless it is a solid colour or a gradient, which become live fill layers. |
| 16- and 32-bit channels | Accepted and opened through the reader's 8-bit path: each sample is truncated to its high byte, so detail finer than one 8-bit step is lost. Admitted as `bit-depth`. |
| CMYK, Lab and other colour modes | Converted to RGB by the PSD reader before Guazzo sees pixels; Guazzo itself only models RGB, so the conversion is the reader's, not ours. |
| Layer comps | Not read. They are alternate visibility states, not pixel data. |

### Adjustment layers

Live on import and export: invert, posterize, threshold, curves, levels,
exposure, vibrance, hue/saturation, colour balance, black & white, photo filter,
brightness/contrast, channel mixer, gradient map, colour lookup, selective
colour.

Carried with their real numbers:

| Kind | Carried |
| --- | --- |
| levels | composite and per-channel rows |
| exposure | exposure (stops), offset, gamma |
| vibrance | vibrance and saturation |
| hue/saturation | master hue/saturation/lightness, colorize (hue + saturation), the six per-range bands |
| brightness/contrast | modern maths; a legacy record is imported as modern and admitted as such |
| black & white | six weights and the tint (hue + saturation) |
| selective colour | all nine ranges, absolute or relative |
| channel mixer | per-channel red/green/blue/constant |
| gradient map | stops and colours (solid gradients) |
| colour lookup | the `.cube` table |
| photo filter | colour and density |

Not carried at all: **desaturate**, which Photoshop has no record for, and a
**noise gradient** (imported as its colour ramp, admitted).

### Text guards

A text layer becomes editable only if it is horizontal, axis-aligned
(no rotation, skew or scale), unwarped and not on a path. Anything else is
refused with an admission and imported as pixels — refusing is better than
snapping upright on the first edit.

Two lossy-but-normal cases are admitted rather than refused:

- **Missing fonts.** The font is substituted (Arial) and listed by name.
- **Paragraph-level styles** on individual runs. Per-run size and colour are
  carried; per-run paragraph styles are not.

Justify-centre, justify-right and justify-all are kept as `justify`;
`wrap`/`boxH` are kept when the file carries box bounds.

## Export

Written as live layers:

- pixel layers (with masks baked into alpha),
- groups, including pass-through groups,
- the adjustment kinds above,
- solid-colour and linear/radial gradient fills,
- text layers whose recipe fits the guards above,
- layer styles, as a recipe on the layer that carries them.

Everything else forces the documented fallback: **one whole-document composite
layer**, plus an admission naming the blocking layers, for example

> a single flattened image because 2 layers have no live PSD record (Group A, Levels)

A masked group, a masked adjustment layer and a masked fill all block a live
tree: the PSD records that would carry them have no place to put the mask, and
baking the mask away would change the picture. A pattern fill blocks it for the
same reason — there is no procedural-pattern record to write.

## What is never carried

Smart-object **sources** (the embedded original file), smart filters, layer
comps, video and 3D layers, CMYK editing, and 16-bit precision. These are
reported on import and are not silently approximated. They are also out of
scope for the model: see the non-goals in `docs/REWRITE.md`.

## Verifying a build

The round trip is tested through the real reader, not through Guazzo's own
writer: `node scripts/ci.mjs` runs `src/engine/tests/psdexport.test.ts`, which
builds a PSD, parses it with ag-psd and imports the result, comparing
composited pixels. Import-only behaviour is in `src/engine/tests/psd.test.ts`;
the style renderer has its own tests in `src/engine/tests/effects.test.ts`.
