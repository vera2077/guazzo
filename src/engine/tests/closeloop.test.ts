import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloseLoop } from "../../ui/closeloop.ts";

test("AL1/AM4: a second close request cannot stack a second prompt", () => {
  const loop = createCloseLoop();
  assert.equal(loop.begin(), true, "the first request owns the prompt");
  assert.equal(loop.open, true);
  // This is the Alt+F4 loop: the poller fires every 400 ms while the first
  // prompt is still waiting for an answer.
  assert.equal(loop.begin(), false, "a second request is refused while one is open");
  assert.equal(loop.begin(), false, "and still refused two ticks later");
});

test("AL1/AM4: release after a cancelled close lets the next request prompt", () => {
  const loop = createCloseLoop();
  loop.begin();
  loop.end(); // the user chose "Keep editing"
  assert.equal(loop.open, false);
  assert.equal(loop.begin(), true, "the next Alt+F4 asks again instead of dying");
});

test("AL1/AM4: release is idempotent", () => {
  const loop = createCloseLoop();
  loop.begin();
  loop.end();
  loop.end();
  assert.equal(loop.open, false);
  assert.equal(loop.begin(), true);
});
