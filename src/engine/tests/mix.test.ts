import { test } from "node:test";
import assert from "node:assert/strict";
import { mixColour } from "../mix.ts";

test("mix: the ends are exact and the middle is half", () => {
  assert.deepEqual(mixColour([0, 100, 200], [255, 0, 0], 0), [0, 100, 200]);
  assert.deepEqual(mixColour([0, 100, 200], [255, 0, 0], 1), [255, 0, 0]);
  assert.deepEqual(mixColour([0, 0, 0], [200, 100, 50], 0.5), [100, 50, 25]);
  // out-of-range t clamps rather than producing negative or >255 channels
  assert.deepEqual(mixColour([10, 10, 10], [20, 20, 20], -3), [10, 10, 10]);
  assert.deepEqual(mixColour([10, 10, 10], [20, 20, 20], 3), [20, 20, 20]);
});
