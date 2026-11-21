import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// The packaging script is plain ESM with no declarations. Importing it here
// makes the deterministic ZIP writer part of the gate rather than a release-day
// hope; the @ts-expect-error also fails if the module ever stops being importable.
// @ts-expect-error - a .mjs script has no type declarations
const pkg = await import("../../../scripts/package.mjs");
const { buildZip, zipEntryNames } = pkg;

const entries = [
  { name: "b.txt", data: Buffer.from("second\n") },
  { name: "a.txt", data: Buffer.from("first\n") },
];
const fixed = new Date(Date.UTC(2026, 10, 21, 10, 30, 0));

test("package zip: same entries and commit time produce identical bytes", () => {
  const one = buildZip(entries, fixed);
  const two = buildZip(entries, fixed);
  assert.ok(one.equals(two));
  assert.equal(
    createHash("sha256").update(one).digest("hex"),
    createHash("sha256").update(two).digest("hex"),
  );
});

test("package zip: entry order is the order given, with no directory entries", () => {
  const names = zipEntryNames(buildZip(entries, fixed)).map((e: { name: string }) => e.name);
  assert.deepEqual(names, ["b.txt", "a.txt"]);
});

test("package zip: the timestamp is part of the bytes, not the wall clock", () => {
  const later = new Date(Date.UTC(2026, 10, 21, 10, 31, 0));
  assert.ok(!buildZip(entries, fixed).equals(buildZip(entries, later)));
});
