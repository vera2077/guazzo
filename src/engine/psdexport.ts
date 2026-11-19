// PSD export — the reverse of engine/psd.ts.
//
// We only ever write 8-bit RGB, which is exactly what ag-psd supports writing, and
// we keep layers, names, opacity, visibility and blend modes so a file round-trips
// through Photoshop without being flattened. Layer masks are baked into the
// exported alpha (the import side bakes the same way — symmetric fidelity);
// clipToBelow is exported as a real PSD clipping layer. ag-psd cannot write
// adjustment/fill layers, so those still go through the caller's flatten hook.
//
// This module is deliberately free of ag-psd imports: it builds the plain object
// shape ag-psd's writePsd() expects, so it is unit-testable in Node and the actual
// serialisation stays in the UI layer where the vendored bundle lives.

import { gridBBox } from "./transform.ts";
import type { BlendMode } from "./blend.ts";
import { maskAt, type Document, type Layer } from "./document.ts";

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
  children?: PsdLayerOut[];
  /** Marks a divider produced by an adjustment/fill layer we must flatten. */
  __flattened?: boolean;
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
 * Non-pixel layers (adjustment and fill layers) have no pixel buffer to export —
 * PSD can describe them, ag-psd cannot write them, and silently dropping them
 * would lose image content. So they are passed through a caller-supplied
 * `flatten` hook that returns the composited layer as pixels, which is what
 * Photoshop itself does when you flatten-and-save.
 */
export function buildPsd(
  doc: Document,
  flatten?: (layer: Layer, index: number) => { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null,
): PsdOut {
  const children: PsdLayerOut[] = [];
  doc.layers.forEach((layer, i) => {
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
