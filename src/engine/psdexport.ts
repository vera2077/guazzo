// PSD export — the reverse of engine/psd.ts.
//
// We only ever write 8-bit RGB, which is exactly what ag-psd supports writing, and
// we keep layers, names, opacity, visibility and blend modes so a file round-trips
// through Photoshop without being flattened. Layer masks are baked into the
// exported alpha (the import side bakes the same way — symmetric fidelity);
// clipToBelow is exported as a real PSD clipping layer.
//
// Adjustment layers are written as real Photoshop adjustment records when the
// model has an exact record for them. Slice 1 covers invert, posterize,
// threshold, curves, brightness/contrast, photo filter, colour balance and
// black & white; the partial kinds still wait for their field mapping.
//
// The product entry point is buildPsdForExport(): it writes a layer tree only
// when every root layer is representable (a pixel layer, or an adjustment with
// an exact record). Otherwise it writes the whole-document composite, because a
// non-representable layer cannot be rasterised in isolation without changing the
// picture — fill, clipped, pass-through and unmapped adjustment layers all
// depend on the backdrop. The single-layer flat path is the honest fallback.
//
// This module is deliberately free of ag-psd imports: it builds the plain object
// shape ag-psd's writePsd() expects, so it is unit-testable in Node and the actual
// serialisation stays in the UI layer where the vendored bundle lives.

import { gridBBox } from "./transform.ts";
import type { BlendMode } from "./blend.ts";
import { maskAt, type Document, type Layer } from "./document.ts";
import type { AdjustSpec, BalanceTriple } from "./adjustfn.ts";
import type { CurvePoint } from "./tone.ts";

/** ag-psd expresses blend modes as Photoshop writes them: "color burn". */
export function psdBlendName(mode: BlendMode): string {
  return mode.replace(/-/g, " ");
}

export interface PsdLayerOut {
  name: string;
  opacity: number;
  blendMode: string;
  hidden: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  imageData?: { width: number; height: number; data: Uint8ClampedArray };
  /** PSD clipping layer — shows through the alpha of the layer below */
  clipping?: boolean;
  /** a live Photoshop adjustment record; absent when the layer was flattened */
  adjustment?: PsdAdjustmentOut;
  children?: PsdLayerOut[];
  /** Marks a divider produced by an adjustment/fill layer we must flatten. */
  __flattened?: boolean;
}

/** One Photoshop curve knot. The record stores input/output in 0–255 bytes. */
export interface PsdCurvePoint {
  input: number;
  output: number;
}

/** Photoshop's color-balance triple, in the record's channel names. */
export interface PsdColorBalance {
  cyanRed: number;
  magentaGreen: number;
  yellowBlue: number;
}

/** The adjustment records slice 1 can write without losing a model field. */
export type PsdAdjustmentOut =
  | { type: "invert" }
  | { type: "posterize"; levels: number }
  | { type: "threshold"; level: number }
  | { type: "curves"; channels: PsdCurvePoint[][] }
  | { type: "brightness/contrast"; brightness: number; contrast: number; useLegacy: false }
  | {
      type: "photo filter";
      color: { r: number; g: number; b: number };
      density: number;
      preserveLuminosity: boolean;
    }
  | {
      type: "color balance";
      shadows: PsdColorBalance;
      midtones: PsdColorBalance;
      highlights: PsdColorBalance;
      preserveLuminosity: boolean;
    }
  | {
      type: "black & white";
      reds: number;
      yellows: number;
      greens: number;
      cyans: number;
      blues: number;
      magentas: number;
      useTint: false;
    };

/**
 * Turn a Guazzo curve channel into PSD knots. The probe showed ag-psd writes
 * and reads 0–255 input/output pairs directly, so this is a clamp/round/sort,
 * not a rescale. Fewer than two knots is not a curve record Photoshop will
 * accept: return null so the layer falls back to flattening instead of being
 * written as a malformed record. Two knots at the same input cannot describe a
 * function; keep the last one, then apply the same two-knot floor.
 */
function curveChannel(points: readonly CurvePoint[] | undefined): PsdCurvePoint[] | null {
  if (!points || points.length < 2) return null;
  const sorted = points
    .map((p) => ({
      input: Math.max(0, Math.min(255, Math.round(p.x))),
      output: Math.max(0, Math.min(255, Math.round(p.y))),
    }))
    .sort((a, b) => a.input - b.input);
  const out: PsdCurvePoint[] = [];
  for (const point of sorted) {
    if (out.length > 0 && out[out.length - 1]!.input === point.input) out[out.length - 1] = point;
    else out.push(point);
  }
  return out.length >= 2 ? out : null;
}

function colorBalanceOut(triple: BalanceTriple): PsdColorBalance {
  return {
    cyanRed: Math.round(triple.r),
    magentaGreen: Math.round(triple.g),
    yellowBlue: Math.round(triple.b),
  };
}

/**
 * Map an adjustment spec to a Photoshop record, or null when the model has
 * fields the record cannot carry. Null means the caller must flatten, not that
 * the layer can be dropped.
 */
export function psdAdjustmentRecord(spec: AdjustSpec | undefined): PsdAdjustmentOut | null {
  if (!spec) return null;
  switch (spec.kind) {
    case "invert":
      return { type: "invert" };
    case "posterize":
      return { type: "posterize", levels: Math.max(2, Math.min(255, Math.round(spec.posterizeLevels ?? 4))) };
    case "threshold":
      // Photoshop's slider and record are 1–255; our dialog is 1–254. Clamp
      // rather than write a value Photoshop may reject.
      return { type: "threshold", level: Math.max(1, Math.min(255, Math.round(spec.thresholdLevel ?? 128))) };
    case "curves": {
      const c = spec.curves;
      if (!c) return null;
      const rgb = curveChannel(c.rgb);
      if (!rgb) return null;
      // PSD channel 0 is the composite curve. Guazzo's rgb curve is the
      // fallback for each channel, not an extra pass on top of per-channel
      // curves, so use it as channel 0 only when no per-channel override
      // exists. Otherwise write an identity composite and the three effective
      // channel curves, or Photoshop would apply rgb twice.
      if (!c.r && !c.g && !c.b) return { type: "curves", channels: [rgb] };
      const r = curveChannel(c.r ?? c.rgb);
      const g = curveChannel(c.g ?? c.rgb);
      const b = curveChannel(c.b ?? c.rgb);
      if (!r || !g || !b) return null;
      const identity: PsdCurvePoint[] = [{ input: 0, output: 0 }, { input: 255, output: 255 }];
      return { type: "curves", channels: [identity, r, g, b] };
    }
    case "brightness-contrast":
      return {
        type: "brightness/contrast",
        brightness: Math.round(spec.brightness ?? 0),
        // Photoshop clamps contrast at -50; our model allows -100. Clamp at the
        // record boundary so we never write a value Photoshop will clip. The
        // rendered result still differs: our brightness is a 2.55x offset,
        // Photoshop's is not. That difference is documented, not fixable here.
        contrast: Math.max(-50, Math.min(100, Math.round(spec.contrast ?? 0))),
        // The modern CgEd block is the one that carries the same numbers back;
        // the legacy 'brit' block is still written for older readers.
        useLegacy: false,
      };
    case "photo-filter": {
      const pf = spec.photoFilter ?? { color: [236, 138, 0] as [number, number, number], density: 25 };
      return {
        type: "photo filter",
        color: {
          r: Math.max(0, Math.min(255, Math.round(pf.color[0]))),
          g: Math.max(0, Math.min(255, Math.round(pf.color[1]))),
          b: Math.max(0, Math.min(255, Math.round(pf.color[2]))),
        },
        density: Math.max(0, Math.min(100, pf.density)),
        preserveLuminosity: pf.preserveLuminosity ?? true,
      };
    }
    case "color-balance": {
      const cb = spec.colorBalance;
      return {
        type: "color balance",
        shadows: colorBalanceOut(cb?.shadows ?? { r: 0, g: 0, b: 0 }),
        midtones: colorBalanceOut(cb?.midtones ?? { r: 0, g: 0, b: 0 }),
        highlights: colorBalanceOut(cb?.highlights ?? { r: 0, g: 0, b: 0 }),
        preserveLuminosity: cb?.preserveLuminosity ?? true,
      };
    }
    case "black-white": {
      const bw = spec.blackWhite ?? { r: 40, g: 60, b: 40, c: 60, m: 40, y: 20 };
      return {
        type: "black & white",
        reds: Math.round(bw.r),
        yellows: Math.round(bw.y),
        greens: Math.round(bw.g),
        cyans: Math.round(bw.c),
        blues: Math.round(bw.b),
        magentas: Math.round(bw.m),
        useTint: false,
      };
    }
    default:
      return null;
  }
}

export interface PsdOut {
  width: number;
  height: number;
  children: PsdLayerOut[];
}

/**
 * Read one layer's pixels into a tight RGBA buffer covering only its bounding box
 * (PSD layers carry their own rect; a full-canvas buffer per layer would inflate
 * the file by orders of magnitude on a 20 MP document).
 */
function layerImage(layer: Layer, docW: number, docH: number): PsdLayerOut {
  const base: PsdLayerOut = {
    name: layer.name,
    opacity: layer.opacity,
    blendMode: psdBlendName(layer.blendMode),
    hidden: !layer.visible,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };
  const box = gridBBox(layer.grid);
  if (!box) return base;
  const w = Math.min(box.w, Math.max(0, docW - box.x));
  const h = Math.min(box.h, Math.max(0, docH - box.y));
  if (w <= 0 || h <= 0) return base;
  const data = new Uint8ClampedArray(w * h * 4);
  layer.grid.readRect(box.x, box.y, w, h, data);
  if (layer.mask) {
    // bake the mask into exported alpha — mirrors psd.ts's import bakeMask, so
    // export/import is symmetric instead of silently dropping coverage
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = maskAt(layer.mask, box.x + x, box.y + y) / 255;
        const i = (y * w + x) * 4;
        if (m >= 1) continue;
        const a = data[i + 3]! * m;
        data[i + 3] = a;
        if (a === 0) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
      }
    }
  }
  base.clipping = layer.clipToBelow === true;
  base.left = box.x;
  base.top = box.y;
  base.right = box.x + w;
  base.bottom = box.y + h;
  base.imageData = { width: w, height: h, data };
  return base;
}

/**
 * Build the ag-psd object for a document.
 *
 * Pixel layers are written directly. Adjustment layers whose spec has an exact
 * Photoshop record are written as live records. Everything else with no pixel
 * buffer — fill layers and adjustment kinds without a record — is passed through
 * a caller-supplied `flatten` hook that returns the composited layer as pixels,
 * which is what Photoshop itself does when you flatten-and-save. Without a hook
 * those layers are omitted, never silently invented.
 */
export function buildPsd(
  doc: Document,
  flatten?: (layer: Layer, index: number) => { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null,
): PsdOut {
  const children: PsdLayerOut[] = [];
  doc.layers.forEach((layer, i) => {
    if (layer.kind === "adjust") {
      const adjustment = psdAdjustmentRecord(layer.adjust);
      if (adjustment) {
        // A live record keeps the layer's own opacity, blend and clipping.
        // There are no pixel channels; the record is the layer.
        children.push({
          name: layer.name,
          opacity: layer.opacity,
          blendMode: psdBlendName(layer.blendMode),
          hidden: !layer.visible,
          clipping: layer.clipToBelow === true,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          adjustment,
        });
        return;
      }
    }
    if (layer.kind !== "pixel") {
      const flat = flatten?.(layer, i) ?? null;
      if (!flat) return;
      children.push({
        name: layer.name,
        opacity: 1,
        blendMode: "normal",
        hidden: !layer.visible,
        clipping: layer.clipToBelow === true,
        left: flat.x,
        top: flat.y,
        right: flat.x + flat.w,
        bottom: flat.y + flat.h,
        imageData: { width: flat.w, height: flat.h, data: flat.data },
        __flattened: true,
      });
      return;
    }
    children.push(layerImage(layer, doc.width, doc.height));
  });
  return { width: doc.width, height: doc.height, children };
}

/** A layer the writer can carry without changing the picture. */
export function psdLayerRepresentable(layer: Layer): boolean {
  return layer.kind === "pixel" ||
    (layer.kind === "adjust" && psdAdjustmentRecord(layer.adjust) !== null);
}

function psdLayerLabel(layer: Layer): string {
  return layer.kind === "adjust" ? layer.adjust?.kind ?? "adjustment" : layer.kind;
}

/**
 * The product export decision. A layer tree is written only when every root
 * layer is representable; otherwise the export is the whole-document composite.
 * A non-representable layer cannot be flattened on its own without changing the
 * picture: fill, clipped, pass-through and unmapped adjustment layers all depend
 * on the backdrop.
 */
export function buildPsdForExport(
  doc: Document,
  flattenedName: string,
): { psd: PsdOut; admission: string } {
  const blocked = doc.layers.filter((layer) => !psdLayerRepresentable(layer));
  if (blocked.length === 0) return { psd: buildPsd(doc), admission: "" };

  const psd = buildPsd(doc);
  psd.children = [{
    name: flattenedName,
    opacity: 1,
    blendMode: "normal",
    hidden: false,
    left: 0,
    top: 0,
    right: doc.width,
    bottom: doc.height,
    imageData: { width: doc.width, height: doc.height, data: doc.composite() },
  }];
  const labels = [...new Set(blocked.map(psdLayerLabel))].join(", ");
  const count = blocked.length;
  return {
    psd,
    admission: `a single flattened image because ${count} layer${count === 1 ? "" : "s"} ` +
      `${count === 1 ? "has" : "have"} no live PSD record (${labels})`,
  };
}
