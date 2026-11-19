/**
 * tiff.ts — baseline TIFF reader (handoff backlog: "TIFF import").
 *
 * Scope is deliberately the format Photoshop and scanners actually emit for
 * 8-bit images, decoded without any dependency:
 *   - byte order II / MM
 *   - strips (StripOffsets / RowsPerStrip / StripByteCounts)
 *   - Compression 1 (none), 5 (LZW), 32773 (PackBits)
 *   - Photometric 0 (WhiteIsZero), 1 (BlackIsZero), 2 (RGB), 3 (palette)
 *   - SamplesPerPixel 1/3/4, BitsPerSample 8 only, PlanarConfiguration 1
 *   - Predictor 2 (horizontal differencing)
 *   - ExtraSamples → alpha (first extra sample)
 * Everything else throws a readable error instead of returning a wrong image:
 * a silently mis-decoded layer is worse than a refused file.
 */

import { MAX_DIM } from "./docmeta.ts";

/** bytes the decoded RGBA image may occupy (one 4-byte sample per pixel) */
export const TIFF_PIXEL_BUDGET = 512 * 1024 * 1024;

export interface TiffImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, ready for TileGrid.writeRect */
  data: Uint8ClampedArray;
}

interface Entry { tag: number; type: number; count: number; valueOffset: number; inline: number[] }

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readU16(v: DataView, o: number, le: boolean): number { return v.getUint16(o, le); }
function readU32(v: DataView, o: number, le: boolean): number { return v.getUint32(o, le); }

function readEntries(v: DataView, ifdOffset: number, le: boolean): Entry[] {
  if (ifdOffset + 2 > v.byteLength) throw new Error("tiff: IFD offset past end of file");
  const count = readU16(v, ifdOffset, le);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const base = ifdOffset + 2 + i * 12;
    if (base + 12 > v.byteLength) throw new Error("tiff: truncated IFD entry");
    const tag = readU16(v, base, le);
    const type = readU16(v, base + 2, le);
    const n = readU32(v, base + 4, le);
    const inline: number[] = [];
    for (let b = 0; b < 4; b++) inline.push(v.getUint8(base + 8 + b));
    out.push({ tag, type, count: n, valueOffset: readU32(v, base + 8, le), inline });
  }
  return out;
}

/** Read a numeric tag as an array of numbers (handles inline values). */
function readTagNumbers(v: DataView, e: Entry, le: boolean): number[] {
  const size = TYPE_SIZE[e.type] ?? 1;
  const total = size * e.count;
  const out: number[] = [];
  if (total <= 4) {
    for (let i = 0; i < e.count; i++) {
      const off = i * size;
      if (size === 2) {
        // inline values follow the FILE's byte order -- the big-endian failure
        // here was reading every SHORT little-endian regardless (TAG 284 read
        // as 256, which looked like planar data and got refused).
        out.push(le
          ? (e.inline[off]! | (e.inline[off + 1]! << 8))
          : ((e.inline[off]! << 8) | e.inline[off + 1]!));
      }
      else if (size === 4) {
        out.push(le
          ? (e.inline[off]! | (e.inline[off + 1]! << 8) | (e.inline[off + 2]! << 16) | (e.inline[off + 3]! << 24)) >>> 0
          : ((e.inline[off]! << 24) | (e.inline[off + 1]! << 16) | (e.inline[off + 2]! << 8) | e.inline[off + 3]!) >>> 0);
      } else out.push(e.inline[off]!);
    }
    return out;
  }
  if (e.valueOffset + total > v.byteLength) throw new Error("tiff: tag value past end of file");
  for (let i = 0; i < e.count; i++) {
    const off = e.valueOffset + i * size;
    if (size === 2) out.push(readU16(v, off, le));
    else if (size === 4) out.push(readU32(v, off, le));
    else out.push(v.getUint8(off));
  }
  return out;
}

/** AC4: required tags must fail with a `tiff:` message, not a raw TypeError. */
function requireEntry(entries: Entry[], tag: number): Entry {
  const e = entries.find((x) => x.tag === tag);
  if (!e) throw new Error(`tiff: required tag ${tag} is missing`);
  return e;
}

function readTag(v: DataView, entries: Entry[], tag: number, le: boolean, fallback?: number): number {
  const e = entries.find((x) => x.tag === tag);
  if (!e) {
    if (fallback === undefined) throw new Error(`tiff: required tag ${tag} is missing`);
    return fallback;
  }
  return readTagNumbers(v, e, le)[0]!;
}

/** LZW (TIFF flavour: MSB-first codes, early change). */
export function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let outPos = 0;
  let bitBuf = 0, bitCount = 0, srcPos = 0;
  let codeWidth = 9;
  let next = 258;
  let prev: number[] | null = null;
  const dict: number[][] = [];
  const reset = (): void => {
    dict.length = 0;
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []); // 256 clear, 257 end
    next = 258;
    codeWidth = 9;
    prev = null;
  };
  reset();
  const code = (): number => {
    while (bitCount < codeWidth) {
      if (srcPos >= src.length) return 257;
      bitBuf = (bitBuf << 8) | src[srcPos++]!;
      bitCount += 8;
    }
    const shift = bitCount - codeWidth;
    const c = (bitBuf >> shift) & ((1 << codeWidth) - 1);
    bitCount -= codeWidth;
    bitBuf &= (1 << bitCount) - 1;
    return c;
  };
  for (;;) {
    const c = code();
    if (c === 257) break;
    if (c === 256) { reset(); continue; }
    let entry: number[];
    if (c < next && dict[c]) entry = dict[c]!;
    else if (prev) entry = prev.concat([prev[0]!]);
    else throw new Error("tiff: bad LZW code");
    for (const byte of entry) {
      if (outPos < out.length) out[outPos++] = byte;
    }
    if (prev) {
      dict[next] = prev.concat([entry[0]!]);
      next++;
      if (next + 1 >= (1 << codeWidth) && codeWidth < 12) codeWidth++;
    }
    prev = entry;
    if (outPos >= out.length) break;
  }
  if (outPos !== expected) throw new Error("tiff: LZW stream produced the wrong amount of data");
  return out;
}

/** TIFF PackBits (RLE). */
export function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++]! << 24) >> 24; // signed
    if (n >= 0) {
      const count = n + 1;
      for (let k = 0; k < count && o < expected; k++) out[o++] = src[i++] ?? 0;
    } else if (n !== -128) {
      const count = 1 - n;
      const byte = src[i++] ?? 0;
      for (let k = 0; k < count && o < expected; k++) out[o++] = byte;
    }
  }
  return out;
}

/** Undo horizontal differencing (Predictor 2) in place, per row, per sample. */
function undoPredictor(bytes: Uint8Array, width: number, rows: number, samples: number): void {
  const stride = width * samples;
  for (let row = 0; row < rows; row++) {
    const base = row * stride;
    for (let x = samples; x < stride; x++) {
      bytes[base + x] = (bytes[base + x]! + bytes[base + x - samples]!) & 0xff;
    }
  }
}

/** Decode a baseline TIFF buffer to RGBA. Throws on unsupported variants. */
export function decodeTiff(buffer: Uint8Array): TiffImage {
  if (buffer.length < 8) throw new Error("tiff: file is too small");
  const v = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const b0 = buffer[0]!, b1 = buffer[1]!;
  let le: boolean;
  if (b0 === 0x49 && b1 === 0x49) le = true;
  else if (b0 === 0x4d && b1 === 0x4d) le = false;
  else throw new Error("tiff: not a TIFF file");
  const magic = readU16(v, 2, le);
  if (magic !== 42) throw new Error("tiff: unsupported TIFF version (BigTIFF is not supported)");
  const entries = readEntries(v, readU32(v, 4, le), le);

  const width = readTag(v, entries, 256, le);
  const height = readTag(v, entries, 257, le);
  if (width < 1 || height < 1) throw new Error("tiff: image has no pixels");
  // AC1: the header is untrusted — a 100 KB file can claim 65535², which asks
  // for 17 GB before we ever look at a pixel. Refuse before allocating.
  if (width > MAX_DIM || height > MAX_DIM) {
    throw new Error(`tiff: ${width} × ${height} exceeds the ${MAX_DIM}px canvas limit`);
  }
  if (width * height * 4 > TIFF_PIXEL_BUDGET) {
    throw new Error(
      `tiff: ${width} × ${height} is larger than the ${Math.round(TIFF_PIXEL_BUDGET / (1024 * 1024))} MB pixel budget`,
    );
  }

  const bits = readTagNumbers(v, requireEntry(entries, 258), le);
  if (bits.some((b) => b !== 8)) throw new Error("tiff: only 8 bits per sample is supported");
  const samples = readTag(v, entries, 277, le, 1);
  // A header is 100 kB of untrusted input; SamplesPerPixel must never size an allocation
  if (samples < 1 || samples > 4) throw new Error(`tiff: unsupported sample count ${samples}`);
  const photometric = readTag(v, entries, 262, le, samples >= 3 ? 2 : 1);
  const compression = readTag(v, entries, 259, le, 1);
  const planar = readTag(v, entries, 284, le, 1);
  if (planar !== 1) throw new Error("tiff: planar (separated) samples are not supported");
  const predictor = readTag(v, entries, 317, le, 1);
  const orientation = readTag(v, entries, 274, le, 1);
  if (orientation !== 1) throw new Error("tiff: only orientation 1 (top-left) is supported");

  const rowsPerStrip = readTag(v, entries, 278, le, height);
  const stripOffsets = readTagNumbers(v, requireEntry(entries, 273), le);
  const stripCounts = readTagNumbers(v, requireEntry(entries, 279), le);
  if (stripOffsets.length === 0) throw new Error("tiff: no strip offsets");

  const rowBytes = width * samples;
  const raw = new Uint8Array(rowBytes * height);
  let writtenRows = 0;
  for (let s = 0; s < stripOffsets.length && writtenRows < height; s++) {
    const rows = Math.min(rowsPerStrip, height - writtenRows);
    const want = rowBytes * rows;
    const off = stripOffsets[s]!;
    const len = stripCounts[s] ?? buffer.length - off;
    if (off + len > buffer.length) throw new Error("tiff: strip past end of file");
    const chunk = buffer.subarray(off, off + len);
    let bytes: Uint8Array;
    if (compression === 1) bytes = chunk;
    else if (compression === 5) bytes = lzwDecode(chunk, want);
    else if (compression === 32773) bytes = packBitsDecode(chunk, want);
    else throw new Error(`tiff: unsupported compression ${compression}`);
    raw.set(bytes.subarray(0, want), writtenRows * rowBytes);
    writtenRows += rows;
  }
  if (predictor === 2) undoPredictor(raw, width, height, samples);

  const data = new Uint8ClampedArray(width * height * 4);
  if (photometric === 3) {
    const e = entries.find((x) => x.tag === 320);
    if (!e) throw new Error("tiff: palette image without a colour map");
    const cmap = readTagNumbers(v, e, le);
    const half = cmap.length / 3;
    for (let i = 0, p = 0; i < width * height; i++, p += 4) {
      const idx = raw[i]!;
      data[p] = (cmap[idx]! >> 8) & 0xff;
      data[p + 1] = (cmap[idx + half]! >> 8) & 0xff;
      data[p + 2] = (cmap[idx + half * 2]! >> 8) & 0xff;
      data[p + 3] = 255;
    }
    return { width, height, data };
  }
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const base = i * samples;
    if (samples >= 3) {
      data[p] = raw[base]!;
      data[p + 1] = raw[base + 1]!;
      data[p + 2] = raw[base + 2]!;
      data[p + 3] = samples >= 4 ? raw[base + 3]! : 255;
    } else {
      const g = raw[base]!;
      const val = photometric === 0 ? 255 - g : g; // WhiteIsZero inverts
      data[p] = val;
      data[p + 1] = val;
      data[p + 2] = val;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}
