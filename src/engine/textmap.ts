/**
 * textmap.ts — a text layer is pixels PLUS a recipe (`textData`), and geometry
 * has to move both or the recipe goes stale.
 *
 * Handoff-8 AP5: before this module, `scaleText` scaled x/y/w/h/size but left
 * `wrap` and `boxH` at their old pixel values (so a 200 % enlargement re-wrapped
 * text at half width), and Free Transform moved the pixels and not the recipe at
 * all (so a double-click re-opened the editor at the pre-transform place). Worse,
 * rotate/flip kept a box recipe whose text can no longer run along its own
 * baseline: rotations and mirrors DROP the recipe, because a horizontal baseline
 * in a rotated box is a wrong instruction, not a stale one. The pixels are
 * already correct — dropping only stops the editor from lying.
 */
import type { Layer } from "./document.ts";

export type TextRecipe = NonNullable<Layer["textData"]>;

/** deep copy of the parts geometry rewrites (lines are never mutated) */
export function cloneRecipe(m: TextRecipe): TextRecipe {
  return { ...m, lines: m.lines.map((segs) => segs.map((s) => ({ ...s }))) };
}

/** Image Size / canvas resample: every pixel quantity scales with the document. */
export function recipeAfterScale(m: TextRecipe, fx: number, fy: number): TextRecipe {
  const out = cloneRecipe(m);
  out.x *= fx;
  out.y *= fy;
  out.w *= fx;
  out.h *= fy;
  out.size = Math.max(1, m.size * Math.sqrt(fx * fy));
  // AP5: the wrap width is a horizontal pixel quantity and boxH is vertical —
  // scaling w/h and not these is why enlargement re-wrapped at the old width.
  if (m.wrap) out.wrap = Math.max(1, m.wrap * fx);
  if (m.boxH) out.boxH = Math.max(1, m.boxH * fy);
  return out;
}

/** Move / crop re-anchor: the recipe translates, nothing scales. */
export function recipeAfterMove(m: TextRecipe, dx: number, dy: number): TextRecipe {
  const out = cloneRecipe(m);
  out.x += dx;
  out.y += dy;
  return out;
}

/**
 * Free Transform: translate + a non-rotating scale can be expressed (text is
 * axis-aligned), a rotation cannot. Returns undefined for "drop the recipe".
 */
export function recipeAfterTransform(
  m: TextRecipe,
  spec: { angleDeg: number; scaleX: number; scaleY: number; dx: number; dy: number },
  centre: { x: number; y: number } | null,
): TextRecipe | undefined {
  if (Math.abs(spec.angleDeg % 360) > 1e-6) return undefined; // AP5: rotation drops it
  if (!centre) return undefined;
  const sx = spec.scaleX, sy = spec.scaleY;
  // A mirror is not a scale: a negative factor leaves the baseline reversed.
  if (!(sx > 0) || !(sy > 0)) return undefined;
  // Same order transformGrid uses: scale about the bbox centre, then translate.
  const out = cloneRecipe(m);
  out.x = centre.x + (m.x - centre.x) * sx + spec.dx;
  out.y = centre.y + (m.y - centre.y) * sy + spec.dy;
  out.w = m.w * sx;
  out.h = m.h * sy;
  out.size = Math.max(1, m.size * Math.sqrt(sx * sy));
  if (m.wrap) out.wrap = Math.max(1, m.wrap * sx);
  if (m.boxH) out.boxH = Math.max(1, m.boxH * sy);
  return out;
}
