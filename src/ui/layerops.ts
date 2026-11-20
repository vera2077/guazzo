/**
 * Layer mutations the shell's dialogs perform, named so tests can drive the
 * handler instead of re-implementing it.
 *
 * Opacity is a structural change: it moves no tile, so no primitive bumps the
 * document revision. The function therefore does both halves of the declared
 * contract — bump the revision the preview key reads, and invalidate the flat
 * cache — in one place the dialog and the test share.
 */
import type { Document, Layer } from "../engine/document.ts";
import type { FlatCache } from "./flatcache.ts";

/** clamp a percentage and apply it; false when the value did not change */
export function setLayerOpacity(layer: Layer, percent: number, doc: Document, cache: FlatCache): boolean {
  const next = Math.max(0, Math.min(100, Math.round(percent))) / 100;
  if (next === layer.opacity) return false;
  layer.opacity = next;
  doc.revision++;
  cache.invalidate();
  return true;
}
