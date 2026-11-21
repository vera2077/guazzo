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
| Layer masks | Baked into the layer's alpha (same rule Photoshop's own flatten uses). |
| Groups, nested groups, group opacity/blend/visibility | Live tree nodes. |
| Pass-through groups | Live, and `passThrough` is kept — see below. |
| Adjustment layers | 12 of 13 kinds live (list below). Fields the model does not have are admitted per field, not dropped silently. |
| Channel mixer, gradient map, colour lookup, selective colour | Admitted wholesale: the layer keeps its position, the settings do not survive. |
| Solid-colour fill layers | Live. |
| Gradient and pattern fills | Rasterised; the recipe is admitted. |
| Text layers | Editable when the text is horizontal, axis-aligned and unwarped; see the text guards. |
| Layer effects (shadow, glow, stroke, bevel, satin, overlay) | Baked into pixels and admitted: they stop being editable. |
| Smart objects and placed files | Rasterised and admitted. |
| Vector shapes | Rasterised; a vector fill is admitted. |
| 16- and 32-bit channels | Read through the 8-bit path: values above 255 clip, admitted as `bit-depth`. |
| CMYK, Lab and other colour modes | Converted to RGB by the PSD reader before Guazzo sees pixels; Guazzo itself only models RGB, so the conversion is the reader's, not ours. |
| Layer comps | Not read. They are alternate visibility states, not pixel data. |

### Adjustment layers

Live on import and export: invert, posterize, threshold, curves, levels,
exposure, vibrance, hue/saturation, colour balance, black & white, photo filter,
brightness/contrast.

Partial, with the missing fields named in the report:

| Kind | Kept | Admitted |
| --- | --- | --- |
| levels | composite channel | per-channel levels |
| exposure | exposure (stops) | offset, gamma |
| vibrance | vibrance | saturation |
| hue/saturation | master channel | colorize, per-range channels |
| brightness/contrast | modern maths | legacy maths (imported as modern) |
| black & white | six weights | tint |

Not carried at all: desaturate (Photoshop has no record for it), channel mixer,
gradient map, colour lookup, selective colour.

### Text guards

A text layer becomes editable only if it is horizontal, axis-aligned
(no rotation, skew or scale), unwarped and not on a path. Anything else is
refused with an admission and imported as pixels — refusing is better than
snapping upright on the first edit.

Two lossy-but-normal cases are admitted rather than refused:

- **Per-run size and colour.** Guazzo's text recipe has one size and one colour
  per layer; a paragraph with coloured words keeps the runs' weight and font but
  takes the layer's size and colour. The report says which layer.
- **Missing fonts.** The font is substituted (Arial) and listed by name.

Justify-centre, justify-right and justify-all are kept as `justify`;
`wrap`/`boxH` are kept when the file carries box bounds.

## Export

Written as live layers:

- pixel layers (with masks baked into alpha),
- groups, including pass-through groups,
- the 12 adjustment kinds above,
- solid-colour fills,
- text layers whose recipe fits the guards above.

Everything else forces the documented fallback: **one whole-document composite
layer**, plus an admission naming the blocking layers, for example

> a single flattened image because 2 layers have no live PSD record (Group A, Levels)

A masked group, a masked adjustment layer and a masked fill all block a live
tree: the PSD records that would carry them have no place to put the mask, and
baking the mask away would change the picture.

## What is never carried

Smart objects, smart filters, layer effects, layer comps, video and 3D layers,
CMYK editing, and 16-bit precision. These are reported on import and are not
silently approximated. They are also out of scope for the model: see the
non-goals in `docs/REWRITE.md`.

## Verifying a build

The round trip is tested through the real reader, not through Guazzo's own
writer: `node scripts/ci.mjs` runs `src/engine/tests/psdexport.test.ts`, which
builds a PSD, parses it with ag-psd and imports the result, comparing
composited pixels. Import-only behaviour is in `src/engine/tests/psd.test.ts`.
