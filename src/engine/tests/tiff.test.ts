/**
 * tiff.test.ts — the reader is tested against files this test builds byte by
 * byte, so there is no external fixture to trust and no encoder to import.
 * Each case asserts actual pixel values, not "it did not throw".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTiff, lzwDecode, packBitsDecode } from "../tiff.ts";

interface BuildOpts {
  width: number;
  height: number;
  samples: 1 | 3 | 4;
  rows: Uint8Array; // raw sample bytes, width*height*samples
  compression?: 1 | 5 | 32773;
  photometric?: number;
  bigEndian?: boolean;
  predictor?: number;
}

function packBitsEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    // find a run of >= 3 equal bytes → RLE packet, else literal
    let run = 1;
    while (i + run < src.length && src[i + run] === src[i] && run < 128) run++;
    if (run >= 3) {
      out.push(257 - run, src[i]!);
      i += run;
    } else {
      let lit = 0;
      while (i + lit < src.length && lit < 128) {
        const same = i + lit + 2 < src.length && src[i + lit] === src[i + lit + 1] && src[i + lit] === src[i + lit + 2];
        if (same) break;
        lit++;
      }
      out.push(lit - 1, ...src.subarray(i, i + lit));
      i += lit;
    }
  }
  return new Uint8Array(out);
}

/** Minimal LZW encoder for round-trip testing (TIFF/MSB-first, early change). */
function lzwEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0, bitCount = 0;
  const emit = (code: number, width: number): void => {
    bitBuf = (bitBuf << width) | code;
    bitCount += width;
    while (bitCount >= 8) {
      out.push((bitBuf >> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
    bitBuf &= (1 << bitCount) - 1;
  };
  let dict = new Map<string, number>();
  let next = 258, codeWidth = 9;
  const reset = (): void => {
    dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    next = 258;
    codeWidth = 9;
  };
  reset();
  emit(256, codeWidth);
  let cur = String.fromCharCode(src[0] ?? 0);
  for (let i = 1; i < src.length; i++) {
    const ch = String.fromCharCode(src[i]!);
    const cand = cur + ch;
    if (dict.has(cand)) { cur = cand; continue; }
    emit(dict.get(cur)!, codeWidth);
    dict.set(cand, next++);
    if (next + 1 > (1 << codeWidth) && codeWidth < 12) codeWidth++;
    cur = ch;
  }
  emit(dict.get(cur)!, codeWidth);
  emit(257, codeWidth);
  if (bitCount > 0) out.push((bitBuf << (8 - bitCount)) & 0xff);
  return new Uint8Array(out);
}

/** A no-clear LZW stream that fills the 12-bit dictionary. Every code is
 *  literal zero, so each addition defines [0,0] and the output stays tiny. */
function lzwDictionaryOverflowStream(codes: number): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0, bitCount = 0;
  let next = 258, codeWidth = 9;
  const emit = (code: number): void => {
    bitBuf = (bitBuf << codeWidth) | code;
    bitCount += codeWidth;
    while (bitCount >= 8) {
      out.push((bitBuf >> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
    bitBuf &= (1 << bitCount) - 1;
  };
  emit(0);
  for (let i = 1; i < codes; i++) {
    next++;
    if (next + 1 >= (1 << codeWidth) && codeWidth < 12) codeWidth++;
    emit(0);
  }
  if (bitCount > 0) out.push((bitBuf << (8 - bitCount)) & 0xff);
  return new Uint8Array(out);
}

function buildTiff(o: BuildOpts): Uint8Array {
  const le = !o.bigEndian;
  const compression = o.compression ?? 1;
  const photometric = o.photometric ?? (o.samples >= 3 ? 2 : 1);
  const predictor = o.predictor ?? 1;
  const stripRaw = o.rows;
  const strip = compression === 1 ? stripRaw
    : compression === 5 ? lzwEncode(stripRaw)
      : packBitsEncode(stripRaw);

  // layout: header(8) + IFD + values, then the strip at the end
  const tags: [number, number, number[]][] = [
    [256, 4, [o.width]],
    [257, 4, [o.height]],
    [258, 3, Array.from({ length: o.samples }, () => 8)],
    [259, 3, [compression]],
    [262, 3, [photometric]],
    [273, 4, [0]], // patched below
    [277, 3, [o.samples]],
    [278, 4, [o.height]],
    [279, 4, [strip.length]],
    [284, 3, [1]],
  ];
  if (predictor !== 1) tags.push([317, 3, [predictor]]);
  if (o.samples === 4) tags.push([338, 3, [2]]);

  const entryCount = tags.length;
  const ifdStart = 8;
  const ifdBytes = 2 + entryCount * 12 + 4;
  let valueCursor = ifdStart + ifdBytes;
  const valueChunks: { tag: number; at: number; bytes: Uint8Array }[] = [];
  const typeSize: Record<number, number> = { 3: 2, 4: 4 };

  const out = new Uint8Array(ifdStart + ifdBytes + tags.length * 8 + strip.length + 16);
  const v = new DataView(out.buffer);
  if (le) { out[0] = 0x49; out[1] = 0x49; } else { out[0] = 0x4d; out[1] = 0x4d; }
  v.setUint16(2, 42, le);
  v.setUint32(4, ifdStart, le);
  v.setUint16(ifdStart, entryCount, le);

  tags.forEach(([tag, type, values], i) => {
    const base = ifdStart + 2 + i * 12;
    const size = typeSize[type] ?? 4;
    const total = size * values.length;
    v.setUint16(base, tag, le);
    v.setUint16(base + 2, type, le);
    v.setUint32(base + 4, values.length, le);
    const write = (at: number): void => {
      values.forEach((val, k) => {
        if (size === 2) v.setUint16(at + k * 2, val, le);
        else v.setUint32(at + k * 4, val, le);
      });
    };
    if (total <= 4) {
      write(base + 8);
    } else {
      const at = valueCursor;
      valueCursor += total + (total % 2);
      v.setUint32(base + 8, at, le);
      valueChunks.push({ tag, at, bytes: new Uint8Array(0) });
      write(at);
    }
  });
  const stripAt = valueCursor;
  // patch StripOffsets
  const offIdx = tags.findIndex(([t]) => t === 273);
  const offBase = ifdStart + 2 + offIdx * 12;
  v.setUint32(offBase + 8, stripAt, le);
  v.setUint32(ifdStart + 2 + entryCount * 12, 0, le);
  out.set(strip, stripAt);
  return out.subarray(0, stripAt + strip.length);
}

const rgbRows = (w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      out[p] = x * 20; out[p + 1] = y * 40; out[p + 2] = 128;
    }
  }
  return out;
};

test("tiff: uncompressed RGB little-endian decodes exact pixels", () => {
  const w = 4, h = 3;
  const img = decodeTiff(buildTiff({ width: w, height: h, samples: 3, rows: rgbRows(w, h) }));
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  const at = (x: number, y: number): number[] => {
    const p = (y * w + x) * 4;
    return [img.data[p]!, img.data[p + 1]!, img.data[p + 2]!, img.data[p + 3]!];
  };
  assert.deepEqual(at(0, 0), [0, 0, 128, 255]);
  assert.deepEqual(at(3, 2), [60, 80, 128, 255]);
});

test("tiff: big-endian byte order is honoured", () => {
  const w = 2, h = 2;
  const img = decodeTiff(buildTiff({ width: w, height: h, samples: 3, rows: rgbRows(w, h), bigEndian: true }));
  assert.equal(img.width, w);
  const p = (1 * w + 1) * 4;
  assert.deepEqual([img.data[p], img.data[p + 1], img.data[p + 2]], [20, 40, 128]);
});

test("tiff: PackBits strips decode to the same bytes", () => {
  const w = 6, h = 2;
  const rows = new Uint8Array(w * h * 3).fill(7);
  const img = decodeTiff(buildTiff({ width: w, height: h, samples: 3, rows, compression: 32773 }));
  for (let i = 0; i < w * h; i++) assert.equal(img.data[i * 4], 7);
});

test("tiff: LZW strips round-trip through the encoder", () => {
  const w = 8, h = 4;
  const rows = new Uint8Array(w * h * 3);
  for (let i = 0; i < rows.length; i++) rows[i] = (i * 11) & 0xff;
  const img = decodeTiff(buildTiff({ width: w, height: h, samples: 3, rows, compression: 5 }));
  for (let i = 0; i < w * h; i++) {
    assert.equal(img.data[i * 4], rows[i * 3]);
    assert.equal(img.data[i * 4 + 1], rows[i * 3 + 1]);
    assert.equal(img.data[i * 4 + 2], rows[i * 3 + 2]);
  }
});

test("tiff: horizontal predictor 2 is undone", () => {
  const w = 3, h = 1;
  // encoder-side differencing of [10, 20, 30] → [10, 10, 10]
  const rows = new Uint8Array([10, 10, 10]);
  const img = decodeTiff(buildTiff({ width: w, height: h, samples: 1, rows, predictor: 2, photometric: 1 }));
  assert.deepEqual([0, 1, 2].map((x) => img.data[x * 4]), [10, 20, 30]);
});

test("tiff: WhiteIsZero greyscale is inverted", () => {
  const img = decodeTiff(buildTiff({ width: 2, height: 1, samples: 1, rows: new Uint8Array([0, 200]), photometric: 0 }));
  assert.equal(img.data[0], 255);
  assert.equal(img.data[4], 55);
});

test("tiff: alpha sample becomes layer alpha", () => {
  const img = decodeTiff(buildTiff({
    width: 1, height: 1, samples: 4,
    rows: new Uint8Array([10, 20, 30, 40]),
  }));
  assert.deepEqual([...img.data], [10, 20, 30, 40]);
});

test("tiff: unsupported bit depth is refused, not guessed", () => {
  const bytes = buildTiff({ width: 1, height: 1, samples: 1, rows: new Uint8Array([0]) });
  // patch BitsPerSample to 16
  const v = new DataView(bytes.buffer);
  const ifd = v.getUint32(4, true);
  const n = v.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const base = ifd + 2 + i * 12;
    if (v.getUint16(base, true) === 258) v.setUint16(base + 8, 16, true);
  }
  assert.throws(() => decodeTiff(bytes), /8 bits per sample/);
});

test("tiff: truncated strip is refused", () => {
  const bytes = buildTiff({ width: 2, height: 2, samples: 1, rows: new Uint8Array([1, 2, 3, 4]) });
  assert.throws(() => decodeTiff(bytes.subarray(0, bytes.length - 3)), /strip past end/);
});

test("lzwDecode / packBitsDecode reject malformed streams", () => {
  assert.throws(() => lzwDecode(new Uint8Array([]), 8), /wrong amount of data/);
  // a PackBits literal longer than the buffer just stops early — no throw
  assert.equal(packBitsDecode(new Uint8Array([3, 1, 2]), 8).length, 8);
});

test("lzwDecode refuses a stream that grows the dictionary past 4096 entries", () => {
  // Handoff 9 P0.5: codes are 12-bit; defining more than 4096 entries is
  // unreachable growth. The stream is ~6 KB with no Clear code.
  const stream = lzwDictionaryOverflowStream(4200);
  assert.throws(() => lzwDecode(stream, 5000), /tiff: LZW dictionary overflow/);
});

test("tiff: an oversized header is refused before anything is allocated", () => {
  // AC1: 100 KB of tags claiming 60000² would ask for ~14 GB of RGBA. The
  // reader must refuse on the header alone — the strip bytes here are junk.
  const tiny = buildTiff({ width: 2, height: 2, samples: 3, rows: rgbRows(2, 2) });
  const patched = new Uint8Array(tiny);
  // width/height are the first two LONG-ish values in this builder's IFD; patch
  // every 32-bit word that equals 2 so the claim is unambiguous.
  const dv = new DataView(patched.buffer);
  let patchedAny = false;
  for (let i = 0; i + 4 <= patched.length; i += 2) {
    if (dv.getUint32(i, true) === 2) { dv.setUint32(i, 60000, true); patchedAny = true; break; }
  }
  assert.ok(patchedAny, "fixture must have been patched");
  assert.throws(() => decodeTiff(patched), /tiff: (\d+ × \d+ exceeds|.*pixel budget)/);
});

test("tiff: an absurd sample count is refused before allocating", () => {
  const buf = buildTiff({ width: 4, height: 4, samples: 1, rows: new Uint8Array(16).fill(128) });
  // tag 277 lives in the IFD; rewrite its inline SHORT value to 65535
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (view.getUint16(at, true) === 277) {
      view.setUint16(at + 8, 65535, true);
      break;
    }
  }
  assert.throws(() => decodeTiff(buf), /sample count|too large/);
});

test("tiff: a zero-count SamplesPerPixel tag cannot switch the budget off", () => {
  // sec-r17 F1: readTag returns undefined for count 0. `Math.max(1, undefined)`
  // is NaN, every comparison against NaN is false, and the pixel budget that
  // line exists for silently passed — a 126-byte file decoded 16384 × 8192.
  const bytes = buildTiff({ width: 4, height: 4, samples: 1, rows: new Uint8Array(16).fill(128) });
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = v.getUint32(4, true);
  const n = v.getUint16(ifd, true);
  let patched = false;
  for (let i = 0; i < n; i++) {
    const base = ifd + 2 + i * 12;
    if (v.getUint16(base, true) === 277) { v.setUint32(base + 4, 0, true); patched = true; }
  }
  assert.ok(patched, "fixture must carry a SamplesPerPixel tag");
  assert.throws(() => decodeTiff(bytes), /tiff: unsupported sample count undefined/);
});

test("tiff: a tag count cannot become an unbounded allocation", () => {
  const bytes = buildTiff({ width: 1, height: 1, samples: 1, rows: new Uint8Array([0]) });
  const v = new DataView(bytes.buffer);
  const ifd = v.getUint32(4, true);
  const n = v.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const base = ifd + 2 + i * 12;
    if (v.getUint16(base, true) === 258) v.setUint32(base + 4, 240_000_000, true);
  }
  assert.throws(() => decodeTiff(bytes), /tag 258 has too many values/);
});

test("tiff: strip tables are bounded by the image height", () => {
  const bytes = buildTiff({ width: 1, height: 1, samples: 1, rows: new Uint8Array([0]) });
  const v = new DataView(bytes.buffer);
  const ifd = v.getUint32(4, true);
  const n = v.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const base = ifd + 2 + i * 12;
    if (v.getUint16(base, true) === 273) v.setUint32(base + 4, 2, true);
  }
  assert.throws(() => decodeTiff(bytes), /tag 273 has too many values/);
});
