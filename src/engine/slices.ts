/**
 * Slicing helpers: non-mutating rectangle operations used to split a document
 * into a non-overlapping grid of tiles. Every rectangle is expressed in integer
 * document-space pixels, with x/y the top-left corner and w/h the size.
 */

export interface Slice {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  name?: string;
}

const sliceClamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Clamp a rect into the document, or return null when it has no area left. */
function sliceClampRect(
  r: { x: number; y: number; w: number; h: number },
  docW: number,
  docH: number,
): { x: number; y: number; w: number; h: number } | null {
  const x0 = sliceClamp(r.x, 0, docW);
  const y0 = sliceClamp(r.y, 0, docH);
  const x1 = sliceClamp(r.x + r.w, 0, docW);
  const y1 = sliceClamp(r.y + r.h, 0, docH);
  const w = x1 - x0;
  const h = y1 - y0;
  return w > 0 && h > 0 ? { x: x0, y: y0, w, h } : null;
}

/** The next strictly-increasing id, one past the largest id already present. */
const nextId = (slices: readonly Slice[]): number =>
  slices.reduce((max, s) => Math.max(max, s.id), 0) + 1;

/** Append a clamped slice. Dropped (zero-area) rects still yield a fresh array. */
export function addSlice(
  slices: readonly Slice[],
  docW: number,
  docH: number,
  r: { x: number; y: number; w: number; h: number },
  name?: string,
): Slice[] {
  const rect = sliceClampRect(r, docW, docH);
  if (!rect) return [...slices];
  const id = nextId(slices);
  const slice: Slice = {
    id,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    name: name ?? `Slice ${id}`,
  };
  return [...slices, slice];
}

/** Remove the slice with the given id, returning a fresh array. */
export function removeSlice(slices: readonly Slice[], id: number): Slice[] {
  return slices.filter((s) => s.id !== id);
}

/** Move a slice by a delta, keeping its rect fully inside the document. */
export function moveSlice(
  slices: readonly Slice[],
  id: number,
  dx: number,
  dy: number,
  docW: number,
  docH: number,
): Slice[] {
  return slices.map((s) => {
    if (s.id !== id) return s;
    const maxX = Math.max(0, docW - s.w);
    const maxY = Math.max(0, docH - s.h);
    return {
      ...s,
      x: sliceClamp(s.x + dx, 0, maxX),
      y: sliceClamp(s.y + dy, 0, maxY),
    };
  });
}

/**
 * Fill the document's gaps around `slices` so the returned tiles partition the
 * whole canvas exactly. Horizontal band boundaries are placed at every slice's
 * top and bottom edge (plus 0 and docH). Inside each band we merge the covering
 * slices' x-intervals and emit the uncovered strips between them. The union of
 * the result is [0,docW) x [0,docH) with no overlaps and no gaps; input slices
 * are never modified.
 */
export function sliceTiles(
  slices: readonly Slice[],
  docW: number,
  docH: number,
): Slice[] {
  if (docW <= 0 || docH <= 0) return [];

  const clipped = slices
    .map((slice) => ({ slice, rect: sliceClampRect(slice, docW, docH) }))
    .filter((e): e is { slice: Slice; rect: { x: number; y: number; w: number; h: number } } => e.rect !== null);

  const ys = new Set<number>([0, docH]);
  for (const { rect } of clipped) {
    ys.add(rect.y);
    ys.add(rect.y + rect.h);
  }
  const bands = [...ys].sort((a, b) => a - b);

  const out: Slice[] = [];
  let next = nextId(slices); // ids for the newly-created gap strips

  for (let i = 0; i + 1 < bands.length; i++) {
    const y0 = bands[i]!;
    const y1 = bands[i + 1]!;
    const bandH = y1 - y0;
    if (bandH <= 0) continue;

    // A slice either spans this entire band or does not touch it, because every
    // slice edge is a band boundary.
    const intervals = clipped
      .filter(({ rect }) => rect.y <= y0 && rect.y + rect.h >= y1)
      .map(({ slice, rect }) => ({
        left: rect.x,
        right: rect.x + rect.w,
        id: slice.id,
        name: slice.name,
      }))
      .sort((a, b) => a.left - b.left || a.right - b.right);

    // Merge touching/overlapping intervals into disjoint covered spans.
    const covered: { left: number; right: number; id: number; name?: string }[] = [];
    for (const iv of intervals) {
      const last = covered[covered.length - 1];
      if (last && iv.left <= last.right) {
        last.right = Math.max(last.right, iv.right);
      } else {
        covered.push({ left: iv.left, right: iv.right, id: iv.id, name: iv.name });
      }
    }

    // Covered spans keep the originating slice's identity.
    for (const span of covered) {
      out.push({
        id: span.id,
        x: span.left,
        y: y0,
        w: span.right - span.left,
        h: bandH,
        name: span.name,
      });
    }

    // Emit the uncovered strips between consecutive spans.
    let cursor = 0;
    for (const span of covered) {
      if (span.left > cursor) {
        out.push({ id: next++, x: cursor, y: y0, w: span.left - cursor, h: bandH });
      }
      cursor = Math.max(cursor, span.right);
    }
    if (cursor < docW) {
      out.push({ id: next++, x: cursor, y: y0, w: docW - cursor, h: bandH });
    }
  }

  return out;
}
