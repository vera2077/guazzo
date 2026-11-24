/** Code-scanning regressions for the local cargo mirror. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
// @ts-expect-error - a .mjs script has no type declarations
const { upstreamFor } = await import("../../../scripts/crates-mirror.mjs");

test("the mirror maps index and crate paths to the two pinned HTTPS origins", () => {
  const index = upstreamFor("/se/rd/serde");
  assert.equal(index.target.origin, "https://index.crates.io");
  assert.equal(index.target.pathname, "/se/rd/serde");
  const crate = upstreamFor("/crates/serde/serde-1.0.0.crate");
  assert.equal(crate.target.origin, "https://static.crates.io");
  assert.equal(crate.target.pathname, "/crates/serde/serde-1.0.0.crate");
});

test("the mirror refuses paths that could redirect the fetch (SSRF)", () => {
  for (const bad of [
    "//evil.example/x",
    "/\\evil.example/x",
    "/../etc/passwd",
    "http://evil.example/",
    "https://index.crates.io@evil.example/",
    "/x\u0000y",
  ]) {
    assert.throws(() => upstreamFor(bad), /mirror path|unsafe characters|allowlist/,
      `must refuse ${JSON.stringify(bad)}`);
  }
});

test("cache files are hashes, so a request path cannot escape the cache", () => {
  const a = upstreamFor("/se/rd/serde");
  const b = upstreamFor("/se/rd/serde");
  assert.equal(a.cacheFile, b.cacheFile);
  assert.match(a.cacheFile, /[0-9a-f]{64}$/);
  assert.ok(!a.cacheFile.includes(".."));
});

test("the 502 response is a fixed plain-text message, never exception text", async () => {
  const src = await readFile(new URL("../../../scripts/crates-mirror.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("res.end(message)"), "the error body must be the fixed message");
  assert.ok(!src.includes("mirror failure: '"), "an exception string must not be reflected");
  assert.match(src, /'content-type': 'text\/plain; charset=utf-8'/, "the error must not be sniffed as HTML");
});
