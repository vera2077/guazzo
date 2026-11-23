/**
 * lookuptable.ts — .cube lookup tables as a live adjustment.
 *
 * A lookup table is a cube of colour samples: an N×N×N grid where each
 * cell is the output colour for the input position of that cell. Sampling
 * is trilinear, so a 17- or 33-point table is smooth instead of blocky.
 *
 * Only the 3D form is supported. A 1D table (LUT_1D_SIZE) is a per-channel
 * curve, which this app already expresses as Curves — importing it as a
 * lookup would be a second, worse way to say the same thing, so it is
 * refused with a reason rather than silently resampled.
 *
 * The parser is deliberately strict: a .cube that half-parses would render
 * as a plausible but wrong picture, which is worse than a refusal.
 */

export interface LookupTable {
  /** human name: TITLE from the file, else the file name */
  name: string;
  /** edge length of the cube, 2..65 */
  size: number;
  /** input range the table covers */
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** size³ × 3 floats, red varying fastest (the .cube convention) */
  data: number[];
}

export const MAX_LUT_SIZE = 65;
export const MIN_LUT_SIZE = 2;

export interface LutParseResult {
  table?: LookupTable;
  error?: string;
}

function parseTriple(parts: string[], line: number): [number, number, number] | string {
  if (parts.length < 3) return `line ${line}: expected three numbers`;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const v = Number(parts[i]);
    if (!Number.isFinite(v)) return `line ${line}: "${parts[i]}" is not a number`;
    out.push(v);
  }
  return [out[0]!, out[1]!, out[2]!];
}

/**
 * Parses the text of a .cube file. Returns `{ table }` or `{ error }`; the
 * caller shows the error verbatim, so every message names the line and
 * what was wrong with it.
 */
export function parseCube(text: string, fallbackName = "Lookup"): LutParseResult {
  let size = 0;
  let title = "";
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let sawOneD = false;
  const data: number[] = [];
  // A .cube is a few hundred KB at the cap; a crafted 60 MB file would build
  // gigabytes of numbers before the row-count check could object (sec-r9 #1).
  if (text.length > 16 * 1024 * 1024) return { error: "this .cube is too large to parse" };
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const head = (parts[0] ?? "").toUpperCase();

    if (head === "TITLE") {
      title = line.slice(line.indexOf(" ") + 1).replace(/^"|"$/g, "");
      continue;
    }
    if (head === "LUT_3D_SIZE") {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < MIN_LUT_SIZE || n > MAX_LUT_SIZE) {
        return { error: `line ${i + 1}: LUT_3D_SIZE must be an integer ${MIN_LUT_SIZE}..${MAX_LUT_SIZE}` };
      }
      size = n;
      continue;
    }
    if (head === "LUT_1D_SIZE") {
      sawOneD = true;
      continue;
    }
    if (head === "DOMAIN_MIN" || head === "DOMAIN_MAX") {
      const t = parseTriple(parts.slice(1), i + 1);
      if (typeof t === "string") return { error: t };
      if (head === "DOMAIN_MIN") domainMin = t;
      else domainMax = t;
      continue;
    }
    if (/^[A-Za-z_]/.test(head)) {
      // Unknown keyword (LUT_3D_INPUT_RANGE, comments in some exporters).
      continue;
    }

    const t = parseTriple(parts, i + 1);
    if (typeof t === "string") return { error: t };
    data.push(t[0], t[1], t[2]);
    // Stop as soon as the table is provably too long, instead of collecting
    // every row of a hostile file and checking at the end (sec-r9 #1).
    if (size > 0 && data.length > size * size * size * 3) {
      return { error: `more colour rows than a ${size}×${size}×${size} table can hold` };
    }
  }

  if (sawOneD && size === 0) {
    return { error: "this is a 1D table; use Curves instead (per-channel curves)" };
  }
  if (size === 0) return { error: "no LUT_3D_SIZE line — this is not a 3D .cube" };
  const expected = size * size * size * 3;
  if (data.length !== expected) {
    return { error: `expected ${expected / 3} colour rows for size ${size}, found ${data.length / 3}` };
  }
  for (let i = 0; i < 3; i++) {
    if (!(domainMax[i]! > domainMin[i]!)) return { error: "DOMAIN_MAX must be greater than DOMAIN_MIN" };
  }
  return { table: { name: title || fallbackName, size, domainMin, domainMax, data } };
}

function clampLut(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sampleChannel(table: LookupTable, r: number, g: number, b: number): [number, number, number] {
  const n = table.size;
  const max = n - 1;
  // Normalise into the table's domain, then into cell space.
  const tr = clampLut((r / 255 - table.domainMin[0]) / (table.domainMax[0] - table.domainMin[0])) * max;
  const tg = clampLut((g / 255 - table.domainMin[1]) / (table.domainMax[1] - table.domainMin[1])) * max;
  const tb = clampLut((b / 255 - table.domainMin[2]) / (table.domainMax[2] - table.domainMin[2])) * max;
  const r0 = Math.floor(tr), g0 = Math.floor(tg), b0 = Math.floor(tb);
  const r1 = Math.min(max, r0 + 1), g1 = Math.min(max, g0 + 1), b1 = Math.min(max, b0 + 1);
  const fr = tr - r0, fg = tg - g0, fb = tb - b0;

  // .cube stores red varying fastest: the cell at (r,g,b) is
  // ((b * n + g) * n + r) * 3. Reading it the other way is exactly the
  // bug this comment is here to stop.
  const at = (ri: number, gi: number, bi: number, c: number): number => {
    const idx = ((bi * n + gi) * n + ri) * 3 + c;
    return table.data[idx] ?? 0;
  };
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = lerp(at(r0, g0, b0, c), at(r1, g0, b0, c), fr);
    const c10 = lerp(at(r0, g1, b0, c), at(r1, g1, b0, c), fr);
    const c01 = lerp(at(r0, g0, b1, c), at(r1, g0, b1, c), fr);
    const c11 = lerp(at(r0, g1, b1, c), at(r1, g1, b1, c), fr);
    const c0 = lerp(c00, c10, fg);
    const c1 = lerp(c01, c11, fg);
    out[c] = Math.round(clampLut(lerp(c0, c1, fb)) * 255);
  }
  return out;
}

/** Applies a loaded table to one pixel, returning 0..255 channels. */
export function applyLookup(table: LookupTable, r: number, g: number, b: number): [number, number, number] {
  return sampleChannel(table, r, g, b);
}

/** True when the table is the identity cube (so the layer can be skipped). */
export function lookupIsIdentity(table: LookupTable): boolean {
  const n = table.size;
  const max = n - 1;
  for (let ri = 0; ri < n; ri++) {
    for (let gi = 0; gi < n; gi++) {
      for (let bi = 0; bi < n; bi++) {
        const idx = ((bi * n + gi) * n + ri) * 3;
        const want = [ri / max, gi / max, bi / max];
        for (let c = 0; c < 3; c++) {
          if (Math.abs((table.data[idx + c] ?? 0) - want[c]!) > 1e-4) return false;
        }
      }
    }
  }
  return true;
}

/**
 * Rebuilds the .cube text for a table, so an exported PSD carries the same
 * table the project does. Values are written with six decimals — enough
 * for 8-bit output to be identical and for a round trip to compare equal
 * after the parser's own rounding.
 */
export function cubeText(table: LookupTable): string {
  const lines: string[] = [
    `# written by Guazzo`,
    `TITLE "${table.name.replace(/"/g, "'")}"`,
    `LUT_3D_SIZE ${table.size}`,
    `DOMAIN_MIN ${table.domainMin.map((v) => v.toFixed(6)).join(" ")}`,
    `DOMAIN_MAX ${table.domainMax.map((v) => v.toFixed(6)).join(" ")}`,
  ];
  for (let i = 0; i < table.data.length; i += 3) {
    lines.push(
      `${(table.data[i] ?? 0).toFixed(6)} ${(table.data[i + 1] ?? 0).toFixed(6)} ${(table.data[i + 2] ?? 0).toFixed(6)}`,
    );
  }
  return lines.join("\n") + "\n";
}
