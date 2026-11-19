/**
 * effects-bake.ts — bake Photoshop layer-style effects (stages 2+3) into RGBA
 * buffers. Pure math, no canvas/DOM; used by psd.ts at import time so a PSD
 * with layer styles opens looking like Photoshop.
 *
 * Baking is destructive by design (Guazzo has no live layer styles yet):
 * the helpers return EFFECT-ONLY buffers that the caller composites with
 * compositeOver() in Photoshop's effect order.
 *
 * Supported: dropShadow, innerShadow, outerGlow, innerGlow, bevel/emboss,
 * solidFill (Color Overlay), gradientOverlay, stroke (outside band).
 * Not yet: satin, patternOverlay, blend modes other than normal, contour.
 * Unknown → skipped silently by the caller.
 */

export interface RgbaBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** ag-psd UnitsValue ("Pixels"/"Percent"…) or a plain number → px number */
export function unitPx(v: number | { value: number } | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && typeof v.value === "number" && Number.isFinite(v.value)) return v.value;
  return fallback;
}

/** separable gaussian blur over a float alpha plane (0..1), edge-clamped */
export function blurAlpha(a: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0 || w < 1 || h < 1) return a;
  const rad = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(rad * 2 + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) {
    const k = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + rad] = k;
    sum += k;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / sum;

  const tmp = new Float32Array(w * h);
  // horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rad; i <= rad; i++) {
        const sx = Math.min(w - 1, Math.max(0, x + i));
        acc += a[row + sx]! * kernel[i + rad]!;
      }
      tmp[row + x] = acc;
    }
  }
  // vertical pass
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rad; i <= rad; i++) {
        const sy = Math.min(h - 1, Math.max(0, y + i));
        acc += tmp[sy * w + x]! * kernel[i + rad]!;
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** extract the buffer's alpha plane as 0..1 floats */
function alphaPlane(buf: RgbaBuffer): Float32Array {
  const a = new Float32Array(buf.width * buf.height);
  for (let i = 0; i < a.length; i++) a[i] = buf.data[i * 4 + 3]! / 255;
  return a;
}

export interface ShadowSpec {
  r: number; g: number; b: number;
  opacity: number;   // 0..1
  angleDeg: number;  // Photoshop light angle: 0 = light from east, 90 = from top
  distance: number;  // px offset
  size: number;      // blur radius px
}

/** shadow-only layer: blurred, offset, tinted silhouette of the content */
export function makeDropShadowLayer(buf: RgbaBuffer, s: ShadowSpec): RgbaBuffer {
  const { width: w, height: h } = buf;
  let a = alphaPlane(buf);
  if (s.size > 0) a = blurAlpha(a, w, h, Math.max(s.size / 2, 0.4));
  // light travels from the angle source toward the layer; the shadow falls
  // opposite. Screen y is down, so angle 90° (light from top) → shadow below.
  const rad = (s.angleDeg * Math.PI) / 180;
  const dx = -Math.round(s.distance * Math.cos(rad));
  const dy = Math.round(s.distance * Math.sin(rad));
  const out = new Uint8ClampedArray(w * h * 4);
  const alpha = Math.min(1, Math.max(0, s.opacity));
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - dy));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx));
      const v = a[sy * w + sx]! * alpha;
      if (v <= 0) continue;
      const o = (y * w + x) * 4;
      out[o] = s.r; out[o + 1] = s.g; out[o + 2] = s.b; out[o + 3] = 255 * v;
    }
  }
  return { data: out, width: w, height: h };
}

export interface SolidFillSpec {
  r: number; g: number; b: number;
  opacity: number; // 0..1
}

/** content with Color Overlay (normal blend) applied: keep alpha, mix color */
export function bakeSolidFill(buf: RgbaBuffer, f: SolidFillSpec): RgbaBuffer {
  const out = new Uint8ClampedArray(buf.data); // copy
  const op = Math.min(1, Math.max(0, f.opacity));
  for (let o = 0; o < out.length; o += 4) {
    if (out[o + 3]! === 0) continue;
    out[o] = out[o]! + (f.r - out[o]!) * op;
    out[o + 1] = out[o + 1]! + (f.g - out[o + 1]!) * op;
    out[o + 2] = out[o + 2]! + (f.b - out[o + 2]!) * op;
  }
  return { data: out, width: buf.width, height: buf.height };
}

export interface StrokeSpec {
  r: number; g: number; b: number;
  opacity: number; // 0..1
  size: number;    // stroke width px
}

/** stroke-only layer: the band of pixels within `size` OUTSIDE the shape.
 *  Photoshop inside/center strokes are approximated as outside (stage 2). */
export function makeStrokeLayer(buf: RgbaBuffer, s: StrokeSpec): RgbaBuffer {
  const { width: w, height: h } = buf;
  const r = Math.max(1, Math.round(s.size));
  const a = alphaPlane(buf);
  // disc structuring element
  const offs: [number, number][] = [];
  for (let oy = -r; oy <= r; oy++) {
    for (let ox = -r; ox <= r; ox++) {
      if (ox * ox + oy * oy <= r * r) offs.push([ox, oy]);
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  const alpha = Math.min(1, Math.max(0, s.opacity));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (a[y * w + x]! > 0) continue; // band only, content excluded
      let m = 0;
      for (const [ox, oy] of offs) {
        const sx = x - ox, sy = y - oy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const v = a[sy * w + sx]!;
        if (v > m) m = v;
        if (m >= 1) break;
      }
      if (m <= 0) continue;
      out[o] = s.r; out[o + 1] = s.g; out[o + 2] = s.b; out[o + 3] = 255 * m * alpha;
    }
  }
  return { data: out, width: w, height: h };
}

// ---- stage 3: inner effects, glows, bevel, gradient overlay ----------------

/** disc dilation (max filter) over a float alpha plane — glow "choke"/spread */
export function dilateAlpha(a: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0 || w < 1 || h < 1) return a;
  const ri = Math.max(1, Math.round(r));
  const offs: [number, number][] = [];
  for (let oy = -ri; oy <= ri; oy++) {
    for (let ox = -ri; ox <= ri; ox++) {
      if (ox * ox + oy * oy <= ri * ri) offs.push([ox, oy]);
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (const [ox, oy] of offs) {
        const sx = x - ox, sy = y - oy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const v = a[sy * w + sx]!;
        if (v > m) m = v;
        if (m >= 1) break;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** inner-shadow-only layer: the band just INSIDE the content edge, on the
 *  side away from the light. Effect-only buffer (transparent elsewhere). */
export function makeInnerShadowLayer(buf: RgbaBuffer, s: ShadowSpec): RgbaBuffer {
  const { width: w, height: h } = buf;
  let a = alphaPlane(buf);
  if (s.size > 0) a = blurAlpha(a, w, h, Math.max(s.size / 2, 0.4));
  // shift the silhouette TOWARD the light; the uncovered inside edge shadows.
  // screen y is down: light top (90°) → moved content up → band at the bottom.
  const rad = (s.angleDeg * Math.PI) / 180;
  const dx = Math.round(s.distance * Math.cos(rad));
  const dy = Math.round(s.distance * Math.sin(rad));
  const A = alphaPlane(buf); // unshifted content alpha (mask of the band)
  const out = new Uint8ClampedArray(w * h * 4);
  const alpha = Math.min(1, Math.max(0, s.opacity));
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y + dy)); // moved[y] = orig[y+dy]
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx)); // moved[x] = orig[x-dx]
      const c = A[y * w + x]!;
      if (c <= 0) continue;
      const moved = a[sy * w + sx]!;
      const band = c * (1 - moved);
      if (band <= 0) continue;
      const o = (y * w + x) * 4;
      out[o] = s.r; out[o + 1] = s.g; out[o + 2] = s.b; out[o + 3] = 255 * band * alpha;
    }
  }
  return { data: out, width: w, height: h };
}

export interface GlowSpec {
  r: number; g: number; b: number;
  opacity: number; // 0..1
  size: number;    // blur radius px
  choke: number;   // dilation px before blur (Photoshop spread)
}

/** outer-glow-only layer: dilated + blurred tinted silhouette (no offset).
 *  Drawn behind the content, so the content covers its own area. */
export function makeOuterGlowLayer(buf: RgbaBuffer, s: GlowSpec): RgbaBuffer {
  const { width: w, height: h } = buf;
  let a = alphaPlane(buf);
  if (s.choke > 0) a = dilateAlpha(a, w, h, s.choke);
  a = blurAlpha(a, w, h, Math.max(s.size / 2, 0.4));
  const out = new Uint8ClampedArray(w * h * 4);
  const alpha = Math.min(1, Math.max(0, s.opacity));
  for (let i = 0; i < a.length; i++) {
    if (a[i]! <= 0) continue;
    const o = i * 4;
    out[o] = s.r; out[o + 1] = s.g; out[o + 2] = s.b; out[o + 3] = 255 * a[i]! * alpha;
  }
  return { data: out, width: w, height: h };
}

/** inner-glow-only layer: ring just INSIDE the content edge. */
export function makeInnerGlowLayer(buf: RgbaBuffer, s: GlowSpec): RgbaBuffer {
  const { width: w, height: h } = buf;
  const A = alphaPlane(buf);
  const g = blurAlpha(A, w, h, Math.max(s.size / 2, 0.4));
  const out = new Uint8ClampedArray(w * h * 4);
  const alpha = Math.min(1, Math.max(0, s.opacity));
  for (let i = 0; i < A.length; i++) {
    const band = A[i]! * (1 - g[i]!);
    if (band <= 0) continue;
    const o = i * 4;
    out[o] = s.r; out[o + 1] = s.g; out[o + 2] = s.b; out[o + 3] = 255 * band * alpha;
  }
  return { data: out, width: w, height: h };
}

export interface BevelSpec {
  size: number;     // band width px
  angleDeg: number; // light angle (compass, same convention as shadows)
  highlight: { r: number; g: number; b: number; opacity: number };
  shadow: { r: number; g: number; b: number; opacity: number };
  invert: boolean;  // Photoshop "direction: down" flips highlight/shadow sides
}

/** bevel/emboss approximation: two inner-edge bands — highlight on the side
 *  FACING the light, shadow on the far side. Returns both effect-only layers. */
export function makeBevelLayers(buf: RgbaBuffer, s: BevelSpec): { highlight: RgbaBuffer; shadow: RgbaBuffer } {
  const { width: w, height: h } = buf;
  const A = alphaPlane(buf);
  const blurred = blurAlpha(A, w, h, Math.max(s.size / 2, 0.4));
  const rad = (s.angleDeg * Math.PI) / 180;
  const d = Math.max(1, Math.round(s.size / 2));
  const dx = Math.round(d * Math.cos(rad));
  const dy = Math.round(d * Math.sin(rad));
  const hi = new Uint8ClampedArray(w * h * 4);
  const sh = new Uint8ClampedArray(w * h * 4);
  const ho = Math.min(1, Math.max(0, s.highlight.opacity));
  const so = Math.min(1, Math.max(0, s.shadow.opacity));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = A[y * w + x]!;
      if (c <= 0) continue;
      const o = (y * w + x) * 4;
      // highlight band: content shifted AWAY from light uncovers the near side
      const awayX = Math.min(w - 1, Math.max(0, x + dx));
      const awayY = Math.min(h - 1, Math.max(0, y - dy));
      const hb = c * (1 - blurred[awayY * w + awayX]!);
      if (hb > 0) { hi[o] = s.highlight.r; hi[o + 1] = s.highlight.g; hi[o + 2] = s.highlight.b; hi[o + 3] = 255 * hb * ho; }
      // shadow band: content shifted TOWARD light uncovers the far side
      const nearX = Math.min(w - 1, Math.max(0, x - dx));
      const nearY = Math.min(h - 1, Math.max(0, y + dy));
      const sb = c * (1 - blurred[nearY * w + nearX]!);
      if (sb > 0) { sh[o] = s.shadow.r; sh[o + 1] = s.shadow.g; sh[o + 2] = s.shadow.b; sh[o + 3] = 255 * sb * so; }
    }
  }
  return { highlight: { data: hi, width: w, height: h }, shadow: { data: sh, width: w, height: h } };
}

export interface GradientStop { loc: number; r: number; g: number; b: number; }
/** PSD gradient overlay — not the same thing as gradient.ts's two-stop
 *  linear/radial spec, so the name says which one it is. */
export interface GradientOverlaySpec {
  stops: GradientStop[]; // loc 0..1, caller pre-sorts and pre-normalizes
  angleDeg: number;      // 0 = west→east, 90 = top→bottom
  opacity: number;       // 0..1
  reverse: boolean;
}

/** apply Gradient Overlay to a COPY of the content: per-pixel color from a
 *  linear gradient across the content bbox, normal-blended over the pixels. */
export function bakeGradientOverlay(buf: RgbaBuffer, s: GradientOverlaySpec): RgbaBuffer {
  const { width: w, height: h } = buf;
  const stops = [...s.stops].sort((a, b) => a.loc - b.loc);
  if (!stops.length) return { data: new Uint8ClampedArray(buf.data), width: w, height: h };
  // content bbox
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (buf.data[(y * w + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const out = new Uint8ClampedArray(buf.data);
  if (maxX < 0) return { data: out, width: w, height: h }; // empty content
  const rad = (s.angleDeg * Math.PI) / 180;
  const ax = Math.cos(rad), ay = Math.sin(rad);
  const proj = (x: number, y: number): number => x * ax + y * ay;
  const corners = [proj(minX, minY), proj(maxX, minY), proj(minX, maxY), proj(maxX, maxY)];
  const lo = Math.min(...corners), hiP = Math.max(...corners);
  const span = hiP - lo || 1;
  const op = Math.min(1, Math.max(0, s.opacity));
  const at = (t: number): GradientStop => {
    if (t <= stops[0]!.loc) return stops[0]!;
    const last = stops[stops.length - 1]!;
    if (t >= last.loc) return last;
    for (let i = 1; i < stops.length; i++) {
      const b = stops[i]!;
      if (t <= b.loc) {
        const a = stops[i - 1]!;
        const f = b.loc === a.loc ? 0 : (t - a.loc) / (b.loc - a.loc);
        return {
          loc: t,
          r: a.r + (b.r - a.r) * f,
          g: a.g + (b.g - a.g) * f,
          b: a.b + (b.b - a.b) * f,
        };
      }
    }
    return last;
  };
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const o = (y * w + x) * 4;
      if (out[o + 3]! === 0) continue;
      let t = (proj(x, y) - lo) / span;
      if (s.reverse) t = 1 - t;
      const c = at(t);
      out[o] = out[o]! + (c.r - out[o]!) * op;
      out[o + 1] = out[o + 1]! + (c.g - out[o + 1]!) * op;
      out[o + 2] = out[o + 2]! + (c.b - out[o + 2]!) * op;
    }
  }
  return { data: out, width: w, height: h };
}

/** composite src OVER dst, in place on dst (source-over, byte math) */
export function compositeOver(dst: RgbaBuffer, src: RgbaBuffer): void {
  const d = dst.data, s = src.data;
  const n = Math.min(d.length, s.length);
  for (let o = 0; o < n; o += 4) {
    const sa = s[o + 3]! / 255;
    if (sa <= 0) continue;
    const da = d[o + 3]! / 255;
    const ao = sa + da * (1 - sa);
    if (ao <= 0) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0; continue; }
    const wS = (1 - sa) * da; // weight of dst under semi-transparent src
    d[o] = (sa * s[o]! + wS * d[o]!) / ao;
    d[o + 1] = (sa * s[o + 1]! + wS * d[o + 1]!) / ao;
    d[o + 2] = (sa * s[o + 2]! + wS * d[o + 2]!) / ao;
    d[o + 3] = ao * 255;
  }
}
