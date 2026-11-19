/**
 * document.ts — layer stack + reference compositor.
 *
 * Layers are ordered bottom → top (index 0 paints first).
 * compositeRect is the single source of truth for what the document
 * looks like; the browser viewport layers caching/GPU tricks on top of
 * it, and node tests call it directly.
 */

import { TileGrid } from "./tile.ts";
import { compositePixel, type BlendMode, LAYER_BLEND_MODES } from "./blend.ts";
import { gridBBox } from "./transform.ts";
import { compileAdjust, type AdjustSpec, adjustLabel } from "./adjustfn.ts";
import { TILE } from "./tile.ts";

let nextLayerId = 1;

/** one run of text with a single style (engine-side copy; the UI mirrors this) */
export interface TextSeg {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  font: string;
}

/** text layers keep their recipe so clicking them reopens a live editor */
export interface TextLayerMeta {
  /** styled runs, one array per line of text */
  lines: TextSeg[][];
  /** top-left of the rasterized box, doc coords */
  x: number;
  y: number;
  /** rasterized content footprint, doc px (differs from the box when wrapped) */
  w: number;
  h: number;
  /** box width the text wraps at, doc px; undefined = no wrapping (auto width) */
  wrap?: number;
  /** box height when the user dragged a top/bottom handle, doc px; undefined = auto (content height) */
  boxH?: number;
  /** font size at commit time */
  size: number;
  color: [number, number, number];
  /** paragraph alignment inside the box (defaults to left when absent) */
  align?: "left" | "center" | "right" | "justify";
}

export type LayerKind = "pixel" | "adjust" | "fill";

export interface Layer {
  id: number;
  name: string;
  kind: LayerKind;
  /** pixel/alpha data; adjustment and fill layers keep an empty grid so
   *  every call site can still ask for one without a branch */
  grid: TileGrid;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  locked: boolean;
  /** set by the text tool; survives project save/load */
  textData?: TextLayerMeta;
  /** flat visual grouping only — the stack stays flat, this just tints and
   *  bands rows that belong together so "fake groups" are discoverable */
  groupId?: string;
  /** grey mask: R channel holds coverage (0 hides, 255 reveals). An
   *  unallocated tile means "reveal everything", so a fresh mask is free. */
  mask?: TileGrid;
  /** clip this layer to the alpha of the stack below it */
  clipToBelow?: boolean;
  /** adjustment layers: what to do to the backdrop */
  adjust?: AdjustSpec;
  /** fill layers: a flat colour covering the whole canvas */
  fill?: { color: [number, number, number] };
}

/**
 * Copy every layer *recipe* field from `src` onto `dst`.
 *
 * Single source of truth for "what a Layer is" beyond pixels: the field
 * list must stay in sync with `serializeLayer` in io.ts (whatever the
 * project format can save must survive geometry ops) — both read exactly
 * name/kind/visible/opacity/blendMode/locked/adjust/fill/mask/clip/group.
 * Pixel data (grid), masks and text metadata are NOT copied here: every
 * geometry path transforms those with its own mapping.
 */
export function cloneLayerMeta(dst: Layer, src: Layer): void {
  dst.name = src.name;
  dst.kind = src.kind;
  dst.visible = src.visible;
  dst.opacity = src.opacity;
  dst.blendMode = src.blendMode;
  dst.locked = src.locked;
  if (src.adjust) dst.adjust = JSON.parse(JSON.stringify(src.adjust)) as AdjustSpec;
  if (src.fill) dst.fill = { color: [src.fill.color[0], src.fill.color[1], src.fill.color[2]] };
  dst.clipToBelow = src.clipToBelow;
  dst.groupId = src.groupId;
}

/**
 * Mask coverage at a doc pixel, 0..255 (255 = fully revealed).
 *
 * Storage is inverted on purpose: the R channel holds how much is
 * *hidden*, so a freshly allocated (all-zero) tile means "reveal
 * everything" and a new mask costs nothing to create or extend.
 */
export function maskAt(mask: TileGrid | undefined, x: number, y: number): number {
  if (!mask) return 255;
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const t = mask.tile(tx, ty, false);
  if (!t) return 255;
  return 255 - t.data[((y - ty * TILE) * TILE + (x - tx * TILE)) * 4]!;
}

/** write mask coverage at a doc pixel; allocates the tile on demand */
export function setMaskAt(mask: TileGrid, x: number, y: number, value: number): void {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const t = mask.tile(tx, ty, true);
  if (!t) return;
  const v = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  const hidden = 255 - v;
  const i = ((y - ty * TILE) * TILE + (x - tx * TILE)) * 4;
  t.data[i] = hidden;
  t.data[i + 1] = hidden;
  t.data[i + 2] = hidden;
  t.data[i + 3] = 255;
  t.version++;
}

/**
 * Paint into a layer mask with a soft round dab.
 *
 * `value` is the new coverage at the dab centre (255 reveals, 0 hides);
 * the brush's soft edge blends toward the existing coverage. Like
 * `stampDab` it only touches tiles that already cover the dab, so a
 * masked layer keeps its sparse storage.
 */
export function paintMaskDab(
  mask: TileGrid,
  d: { x: number; y: number; radius: number; hardness: number; alpha: number; value: number },
): { x: number; y: number; w: number; h: number } | null {
  const r = Math.max(0.5, d.radius);
  const x0 = Math.max(0, Math.floor(d.x - r));
  const y0 = Math.max(0, Math.floor(d.y - r));
  const x1 = Math.min(mask.width, Math.ceil(d.x + r));
  const y1 = Math.min(mask.height, Math.ceil(d.y + r));
  if (x1 <= x0 || y1 <= y0) return null;
  const hard = Math.min(0.999, Math.max(0, d.hardness));
  const inner = r * hard;
  let touched = false;
  const txa = Math.floor(x0 / TILE), txaEnd = Math.floor((x1 - 1) / TILE);
  const tya = Math.floor(y0 / TILE), tyaEnd = Math.floor((y1 - 1) / TILE);
  for (let ty = tya; ty <= tyaEnd; ty++) {
    for (let tx = txa; tx <= txaEnd; tx++) {
      const bx = tx * TILE, by = ty * TILE;
      // a missing tile means "reveal everything"; painting reveal over reveal
      // changes nothing, so only allocate when the dab actually hides
      const existing = mask.tile(tx, ty, false);
      const revealsOnly = d.value >= 254.5;
      if (!existing && revealsOnly) continue;
      const tile = existing ?? mask.tile(tx, ty, true);
      if (!tile) continue;
      const cx = Math.max(x0, bx) - bx, cy = Math.max(y0, by) - by;
      const cw = Math.min(x1, bx + TILE) - bx - cx;
      const ch = Math.min(y1, by + TILE) - by - cy;
      let wrote = false;
      for (let yy = 0; yy < ch; yy++) {
        for (let xx = 0; xx < cw; xx++) {
          const gx = bx + cx + xx, gy = by + cy + yy;
          const dx = gx + 0.5 - d.x, dy = gy + 0.5 - d.y;
          const dist = Math.hypot(dx, dy);
          if (dist > r) continue;
          let wgt = 1;
          if (dist > inner) {
            const q = (dist - inner) / Math.max(1e-6, r - inner);
            wgt = 1 - q * q * (3 - 2 * q);
          }
          const k = wgt * d.alpha;
          if (k <= 0) continue;
          const i = ((cy + yy) * TILE + cx + xx) * 4;
          const cur = 255 - tile.data[i]!; // coverage before
          const next = cur + (d.value - cur) * k;
          const hidden = 255 - Math.max(0, Math.min(255, Math.round(next)));
          tile.data[i] = hidden;
          tile.data[i + 1] = hidden;
          tile.data[i + 2] = hidden;
          tile.data[i + 3] = 255;
          wrote = true;
        }
      }
      if (wrote) {
        touched = true;
        tile.version++;
      }
    }
  }
  return touched ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** multiply a layer's pixels by its mask and drop the mask (Apply Mask) */
export function bakeLayerMask(layer: Layer, width: number, height: number): void {
  if (!layer.mask) return;
  const mask = layer.mask;
  layer.grid.forEachTileInRect(0, 0, width, height, (tile, cx, cy, cw, ch, bx, by) => {
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const gx = bx + cx + xx, gy = by + cy + yy;
        const m = maskAt(mask, gx, gy) / 255;
        if (m >= 1) continue;
        const i = ((cy + yy) * TILE + cx + xx) * 4;
        tile.data[i + 3] = tile.data[i + 3]! * m;
      }
    }
    tile.version++;
  });
  layer.mask = undefined;
}

/** a mask that reveals everything (stored sparsely, so it costs nothing) */
export function createLayerMask(width: number, height: number): TileGrid {
  return new TileGrid(width, height);
}

export class Document {
  readonly width: number;
  readonly height: number;
  readonly layers: Layer[] = []; // bottom → top

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** add a layer on top; returns it */
  addLayer(name?: string): Layer {
    const layer: Layer = {
      id: nextLayerId++,
      name: name ?? `Layer ${nextLayerId - 1}`,
      kind: "pixel",
      grid: new TileGrid(this.width, this.height),
      visible: true,
      opacity: 1,
      blendMode: "normal",
      locked: false,
    };
    this.layers.push(layer);
    return layer;
  }

  removeLayer(layer: Layer): void {
    const i = this.layers.indexOf(layer);
    if (i >= 0) this.layers.splice(i, 1);
  }

  moveLayer(layer: Layer, toIndex: number): void {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.layers.splice(Math.max(0, Math.min(this.layers.length, toIndex)), 0, layer);
  }

  /** flat fill for new documents (white background layer) */
  /** an adjustment layer that filters everything beneath it */
  addAdjustLayer(spec: AdjustSpec): Layer {
    const layer: Layer = {
      id: nextLayerId++,
      name: adjustLabel(spec),
      kind: "adjust",
      grid: new TileGrid(this.width, this.height),
      visible: true,
      opacity: 1,
      blendMode: "normal",
      locked: false,
      adjust: spec,
    };
    this.layers.push(layer);
    return layer;
  }

  /** a flat colour layer (Photoshop's Solid Colour fill layer) */
  addFillLayer(color: [number, number, number], name = "Solid Colour"): Layer {
    const layer: Layer = {
      id: nextLayerId++,
      name,
      kind: "fill",
      grid: new TileGrid(this.width, this.height),
      visible: true,
      opacity: 1,
      blendMode: "normal",
      locked: false,
      fill: { color },
    };
    this.layers.push(layer);
    return layer;
  }

  /** give a layer a mask that starts fully revealed */
  attachMask(layer: Layer): TileGrid {
    if (!layer.mask) layer.mask = createLayerMask(this.width, this.height);
    return layer.mask;
  }

  addBackground(name = "Background"): Layer {
    const l = this.addLayer(name);
    l.grid.fillRect(0, 0, this.width, this.height, [255, 255, 255, 255]);
    return l;
  }

  /**
   * Composite a doc-space rect of the whole stack into `out` (w*h*4
   * straight RGBA). `out` is filled with transparent black first.
   */
  compositeRect(x: number, y: number, w: number, h: number, out: Uint8ClampedArray): void {
    if (out.length < w * h * 4) throw new Error("compositeRect: buffer too small");
    out.fill(0);
    // Float64 on purpose: adjustment closures must see raw doubles so the
    // byte store rounds identically to the destructive ops (float32 turns
    // .49999 float dust into exact .5 and flips ties-to-even).
    const px = new Float64Array(3);
    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const op = layer.opacity;
      const mode: BlendMode =
        LAYER_BLEND_MODES.includes(layer.blendMode) ? layer.blendMode : "normal";

      // Adjustment layers transform whatever is already underneath, which
      // is pointwise, so doing it per rect (not per tile) is exact.
      if (layer.kind === "adjust") {
        const adj = compileAdjust(layer.adjust ?? { kind: "levels" });
        for (let yy = 0; yy < h; yy++) {
          const gy = y + yy;
          if (gy < 0 || gy >= this.height) continue;
          for (let xx = 0; xx < w; xx++) {
            const gx = x + xx;
            if (gx < 0 || gx >= this.width) continue;
            const dp = (yy * w + xx) * 4;
            const a = out[dp + 3]!;
            if (a === 0) continue;
            const r0 = out[dp]!, g0 = out[dp + 1]!, b0 = out[dp + 2]!;
            let nr: number, ng: number, nb: number;
            if (adj.rgb) {
              adj.rgb(r0, g0, b0, px);
              nr = px[0]!; ng = px[1]!; nb = px[2]!;
            } else {
              nr = adj.lr![r0]!; ng = adj.lg![g0]!; nb = adj.lb![b0]!;
            }
            // mask + opacity decide how much of the adjustment sticks.
            // A clipping mask also limits it to the backdrop's coverage: the
            // audit (R3) caught that clipping an adjustment layer was silently
            // ignored, so a clipped Levels still filtered the whole document.
            let m = (maskAt(layer.mask, gx, gy) / 255) * op;
            if (layer.clipToBelow) m *= a / 255;
            if (m >= 1) {
              out[dp] = nr; out[dp + 1] = ng; out[dp + 2] = nb;
            } else if (m > 0) {
              out[dp] = r0 + (nr - r0) * m;
              out[dp + 1] = g0 + (ng - g0) * m;
              out[dp + 2] = b0 + (nb - b0) * m;
            }
          }
        }
        continue;
      }

      // Fill layers are an unbounded flat colour; only the mask cuts them.
      if (layer.kind === "fill") {
        const col = layer.fill?.color ?? [255, 255, 255];
        for (let yy = 0; yy < h; yy++) {
          const gy = y + yy;
          if (gy < 0 || gy >= this.height) continue;
          for (let xx = 0; xx < w; xx++) {
            const gx = x + xx;
            if (gx < 0 || gx >= this.width) continue;
            let sa = 255 * op * (maskAt(layer.mask, gx, gy) / 255);
            if (sa <= 0) continue;
            const dp = (yy * w + xx) * 4;
            if (layer.clipToBelow) sa = sa * (out[dp + 3]! / 255);
            if (sa <= 0) continue;
            const da = out[dp + 3]!;
            if (mode === "normal") {
              const as = sa / 255, ab = da / 255;
              const ao = as + ab * (1 - as);
              if (ao === 0) continue;
              const wS = (1 - as) * ab;
              out[dp] = (as * col[0] + wS * out[dp]!) / ao;
              out[dp + 1] = (as * col[1] + wS * out[dp + 1]!) / ao;
              out[dp + 2] = (as * col[2] + wS * out[dp + 2]!) / ao;
              out[dp + 3] = ao * 255;
            } else {
              compositePixel(mode, col[0], col[1], col[2], sa, out[dp]!, out[dp + 1]!, out[dp + 2]!, da, out, dp, gx, gy);
            }
          }
        }
        continue;
      }

      const hasMask = !!layer.mask;
      layer.grid.forEachTileInRect(x, y, w, h, (tile, cx, cy, cw, ch, bx, by) => {
        const td = tile.data;
        const normal = mode === "normal";
        for (let yy = 0; yy < ch; yy++) {
          for (let xx = 0; xx < cw; xx++) {
            const gx = bx + cx + xx, gy = by + cy + yy;
            const tp = ((cy + yy) * TILE + cx + xx) * 4;
            const sr = td[tp]!, sg = td[tp + 1]!, sb = td[tp + 2]!;
            let sa = td[tp + 3]!;
            if (sa === 0) continue;
            if (op < 1) sa = sa * op;
            if (hasMask) sa = sa * (maskAt(layer.mask, gx, gy) / 255);
            if (sa === 0) continue;
            const dp = ((gy - y) * w + (gx - x)) * 4;
            const da = out[dp + 3]!;
            // clipping: only show where the stack below is opaque
            if (layer.clipToBelow) {
              sa = sa * (da / 255);
              if (sa === 0) continue;
            }
            if (normal) {
              // inline source-over, byte units: Co = (as·sr + (1-as)·ab·dst)/ao
              // (channelBlend normal: B = Cs → same result as compositePixel)
              const as = sa / 255, ab = da / 255;
              const ao = as + ab * (1 - as);
              if (ao === 0) { out[dp] = 0; out[dp + 1] = 0; out[dp + 2] = 0; out[dp + 3] = 0; continue; }
              const wS = (1 - as) * ab;
              out[dp] = (as * sr + wS * out[dp]!) / ao;
              out[dp + 1] = (as * sg + wS * out[dp + 1]!) / ao;
              out[dp + 2] = (as * sb + wS * out[dp + 2]!) / ao;
              out[dp + 3] = ao * 255;
            } else {
              compositePixel(mode, sr, sg, sb, sa, out[dp]!, out[dp + 1]!, out[dp + 2]!, da, out, dp, gx, gy);
            }
          }
        }
      });
    }
  }

  /** composite the entire document */
  composite(out?: Uint8ClampedArray): Uint8ClampedArray {
    const buf = out ?? new Uint8ClampedArray(this.width * this.height * 4);
    this.compositeRect(0, 0, this.width, this.height, buf);
    return buf;
  }
}

/** composite `src` (with its blend mode + opacity) onto `dst`'s pixels in
 *  place — the pixel half of Merge Down. Coverage = union of both bboxes;
 *  `dst` pixels outside the union stay untouched. Returns the merged bbox
 *  or null when both layers are empty. */
export function mergeLayerInto(src: Layer, dst: Layer): { x: number; y: number; w: number; h: number } | null {
  const a = gridBBox(dst.grid), b = gridBBox(src.grid);
  const bb = a && b
    ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
        h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) }
    : (a ?? b);
  if (!bb) return null;
  const n = bb.w * bb.h * 4;
  const base = new Uint8ClampedArray(n);
  dst.grid.readRect(bb.x, bb.y, bb.w, bb.h, base);
  const top = new Uint8ClampedArray(n);
  src.grid.readRect(bb.x, bb.y, bb.w, bb.h, top);
  const op = src.opacity;
  const mode = src.blendMode;
  const mask = src.mask;
  for (let i = 0; i < n; i += 4) {
    const px = bb.x + ((i >> 2) % bb.w);
    const py = bb.y + Math.floor(i / 4 / bb.w);
    const m = mask ? maskAt(mask, px, py) / 255 : 1;
    if (m <= 0) continue;
    const sa = top[i + 3]! * op * m;
    if (sa <= 0) continue; // transparent top pixel: base shows through
    compositePixel(mode, top[i]!, top[i + 1]!, top[i + 2]!, sa,
      base[i]!, base[i + 1]!, base[i + 2]!, base[i + 3]!, base, i, px, py);
  }
  dst.grid.writeRect(bb.x, bb.y, bb.w, bb.h, base);
  return bb;
}
