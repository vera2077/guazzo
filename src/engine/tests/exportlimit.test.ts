import { test } from "node:test";
import assert from "node:assert/strict";
import { exportRefusal, MAX_EXPORT_CANVAS_BYTES } from "../exportlimit.ts";

test("export refusal: 8192 and 4096 fit exactly or comfortably", () => {
  assert.equal(exportRefusal(8192, 8192, "png"), null);
  assert.equal(exportRefusal(4096, 4096, "png"), null);
});

test("export refusal: 16384 names the largest whole-percent scale", () => {
  const message = exportRefusal(16384, 16384, "png");
  assert.ok(message, "a 16384² RGBA canvas must be refused");
  assert.match(message, /16384 × 16384/);
  assert.match(message, /1\.07 GB/);
  assert.match(message, /50 % or lower/);
  assert.match(message, /PNG/);
});

test("export refusal: the threshold is the scaled canvas, not the source document", () => {
  assert.equal(MAX_EXPORT_CANVAS_BYTES, 256 * 1024 * 1024);
  const justFits = Math.floor(Math.sqrt(MAX_EXPORT_CANVAS_BYTES / 4));
  assert.equal(exportRefusal(justFits, justFits, "jpeg"), null);
  assert.ok(exportRefusal(justFits + 1, justFits + 1, "jpeg"));
});

test("export refusal: invalid dimensions are refused rather than multiplied", () => {
  assert.match(exportRefusal(0, 10, "png") ?? "", /invalid/);
  assert.match(exportRefusal(Number.NaN, 10, "png") ?? "", /invalid/);
});
