/**
 * importreport.ts — the IMPORT REPORT CONTRACT (PSD fidelity, fixed before
 * either side codes so the strings cannot drift).
 *
 * Invariant, and the only rule that matters: **nothing is silently dropped**.
 * Every feature the importer cannot reconstruct must appear in `avoided` with a
 * path that names where it was. The report is the companion to fidelity, never
 * a substitute for it: an entry in `avoided` is an admission, not a feature.
 *
 * `path` is the layer path from the root, joined with " / ", with the group name
 * or layer name as it appears in Photoshop — e.g. "Background / Effects / Glow".
 * File-wide findings use "-".
 * `feature` is a closed set so a harness can assert by name:
 *
 *   group-opacity   a group had opacity but it could not be applied as a group
 *   group-blend     a group blend mode outside Normal/Multiply/… was mapped
 *   pass-through    a group was imported as isolation (or vice versa)
 *   adjustment      an adjustment kind has no equivalent recipe here
 *   adjustment-partial an adjustment recipe survived with some fields dropped
 *   fill            a fill layer (gradient/pattern/…) was rasterised or dropped
 *   text            text was rasterised (missing font, unsupported shaping, …)
 *   text-style-runs per-run size or colour collapsed to the base style
 *   text-transform  rotated/skewed text was kept as pixels, not an axis-aligned recipe
 *   text-warp       warped text was kept as pixels
 *   text-on-path    text on a path was kept as pixels
 *   text-vertical   vertical text was kept as pixels
 *   text-wrap       a text box's wrap width was unavailable and is recomputed
 *   text-justify    a justified last line's alignment could not be carried
 *   text-paragraph-runs per-run paragraph styles were dropped
 *   text-effects    layer effects were baked; editing the text will not recreate them
 *   text-runs       the text or its style-run list is too large for a recipe
 *   effect          a layer style was rasterised into pixels
 *   smart-object    a smart object was rasterised (no live re-edit)
 *   mask            a mask could not be represented (vector, from a channel, …)
 *   bit-depth       channels deeper than 8-bit were read as 8-bit (clipped)
 *
 * `substitutedFonts` names every font family the importer replaced, once each,
 * in first-seen order. A live text recipe keeps the strings and geometry, so
 * the font substitution is the one thing carried here rather than repeated as
 * a per-layer `text` admission.
 */
export interface ImportReport {
  layers: number;
  groups: number;
  avoided: Array<{
    path: string;
    feature:
      | "group-opacity"
      | "group-blend"
      | "pass-through"
      | "adjustment"
      | "adjustment-partial"
      | "fill"
      | "text"
      | "text-style-runs"
      | "text-transform"
      | "text-warp"
      | "text-on-path"
      | "text-vertical"
      | "text-wrap"
      | "text-justify"
      | "text-paragraph-runs"
      | "text-effects"
      | "text-runs"
      | "effect"
      | "smart-object"
      | "mask"
      | "bit-depth";
    detail: string;
  }>;
  substitutedFonts: string[];
}

/** The one constructor both sides use, so a field can never be forgotten. */
export function emptyImportReport(): ImportReport {
  return { layers: 0, groups: 0, avoided: [], substitutedFonts: [] };
}
