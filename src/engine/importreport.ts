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
 * `feature` is a closed set so a harness can assert by name:
 *
 *   group-opacity   a group had opacity but it could not be applied as a group
 *   group-blend     a group blend mode outside Normal/Multiply/… was mapped
 *   pass-through    a group was imported as isolation (or vice versa)
 *   adjustment      an adjustment kind has no equivalent recipe here
 *   fill            a fill layer (gradient/pattern/…) was rasterised or dropped
 *   text            text was rasterised (missing font, unsupported shaping, …)
 *   effect          a layer style was rasterised into pixels
 *   smart-object    a smart object was rasterised (no live re-edit)
 *   mask            a mask could not be represented (vector, from a channel, …)
 *
 * `substitutedFonts` names every font family the importer replaced, once each,
 * in first-seen order; each one also produces a `text` entry at its layer path.
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
      | "fill"
      | "text"
      | "effect"
      | "smart-object"
      | "mask";
    detail: string;
  }>;
  substitutedFonts: string[];
}

/** The one constructor both sides use, so a field can never be forgotten. */
export function emptyImportReport(): ImportReport {
  return { layers: 0, groups: 0, avoided: [], substitutedFonts: [] };
}
