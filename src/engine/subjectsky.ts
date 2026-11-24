/**
 * Deterministic, DOM-free heuristic subject/sky selection.
 *
 * This is deliberately NOT semantic ML: no model, no randomness, no DOM and
 * no network. It assumes the sky touches the top of the frame, adapts a
 * colour reference from the top row, and grows a colour-distance flood down
 * from that row. The largest connected region growing out of the top rows is
 * taken as sky; "subject" is simply its complement.
 */

export type SubjectSkyMode = "subject" | "sky";

/** Initial colour-distance budget (48 per pixel, compared in squared space). */
const BASE_THRESHOLD = 48;
const THRESHOLD_SQ = BASE_THRESHOLD * BASE_THRESHOLD;

interface ReferenceColour {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Squared Euclidean distance between two pixels over all four RGBA channels. */
function dist2(px: Uint8ClampedArray, a: number, b: number): number {
  const ao = a * 4;
  const bo = b * 4;
  const dr = (px[ao] ?? 0) - (px[bo] ?? 0);
  const dg = (px[ao + 1] ?? 0) - (px[bo + 1] ?? 0);
  const db = (px[ao + 2] ?? 0) - (px[bo + 2] ?? 0);
  const da = (px[ao + 3] ?? 0) - (px[bo + 3] ?? 0);
  return dr * dr + dg * dg + db * db + da * da;
}

/** Squared distance from a pixel to the adapted reference colour. */
function distToReference(px: Uint8ClampedArray, i: number, ref: ReferenceColour): number {
  const o = i * 4;
  const dr = (px[o] ?? 0) - ref.r;
  const dg = (px[o + 1] ?? 0) - ref.g;
  const db = (px[o + 2] ?? 0) - ref.b;
  const da = (px[o + 3] ?? 0) - ref.a;
  return dr * dr + dg * dg + db * db + da * da;
}

/** Average colour of the top row — the reference adapted to this image. */
function topRowReference(px: Uint8ClampedArray, w: number): ReferenceColour {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let x = 0; x < w; x++) {
    const o = x * 4;
    r += px[o] ?? 0;
    g += px[o + 1] ?? 0;
    b += px[o + 2] ?? 0;
    a += px[o + 3] ?? 0;
  }
  return { r: r / w, g: g / w, b: b / w, a: a / w };
}

/**
 * Indices of the largest colour-connected region seeded from the top row.
 *
 * Seeds are top-row pixels close to the adapted reference. Growth then walks
 * 4-neighbours whose colour distance is within the (48) threshold: a gentle
 * sky gradient is followed step by step, while a sharp horizon (sky -> land)
 * stops the flood. Ties and traversal order are fixed, so results are stable.
 */
function largestTopRegion(px: Uint8ClampedArray, w: number, h: number): number[] {
  const n = w * h;
  const ref = topRowReference(px, w);
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  let best: number[] = [];

  for (let x = 0; x < w; x++) {
    const seed = x; // row 0
    if (visited[seed] !== 0) continue;
    if (distToReference(px, seed, ref) > THRESHOLD_SQ) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    const region: number[] = [];

    while (head < tail) {
      const cur = queue[head++]!;
      region.push(cur);
      const cx = cur % w;
      const cy = (cur - cx) / w;

      const grow = (next: number): void => {
        if (visited[next] !== 0) return;
        if (dist2(px, cur, next) > THRESHOLD_SQ) return;
        visited[next] = 1;
        queue[tail++] = next;
      };
      if (cx > 0) grow(cur - 1);
      if (cx < w - 1) grow(cur + 1);
      if (cy > 0) grow(cur - w);
      if (cy < h - 1) grow(cur + w);
    }

    if (region.length > best.length) best = region;
  }
  return best;
}

/**
 * Build a 0/255 selection mask for the sky, or for its complement (subject).
 *
 * @param px    RGBA pixels of length w*h*4. Never mutated.
 * @param w     Image width in pixels.
 * @param h     Image height in pixels.
 * @param mode  "sky" selects the detected sky; "subject" selects everything
 *              else. Any unrecognised value falls back to "sky".
 * @returns     A NEW Uint8ClampedArray of length w*h (255 selected, 0 not).
 */
export function subjectSkyMask(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  mode: SubjectSkyMode = "sky",
): Uint8ClampedArray {
  if (!(w > 0) || !(h > 0)) return new Uint8ClampedArray(0);
  const width = Math.floor(w);
  const height = Math.floor(h);
  const n = width * height;
  if (n <= 0) return new Uint8ClampedArray(0);

  const selected = largestTopRegion(px, width, height);
  const isSubject = mode === "subject";
  const mask = new Uint8ClampedArray(n);
  if (isSubject) mask.fill(255);
  for (const i of selected) mask[i] = isSubject ? 0 : 255;
  return mask;
}
