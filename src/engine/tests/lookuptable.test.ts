/**
 * lookuptable.test.ts — .cube parsing and sampling.
 *
 * The dangerous failure here is a table that half-parses: the picture looks
 * plausible and is wrong. These tests therefore lean on the refusals as
 * much as on the maths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLookup, cubeText, lookupIsIdentity, parseCube } from "../lookuptable.ts";

const { eq } = await import("./helpers.ts");

/** 2×2×2 identity cube, red varying fastest. */
const IDENTITY_2 = `TITLE "Identity"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

test("parses an identity cube and samples it exactly", () => {
  const got = parseCube(IDENTITY_2, "id.cube");
  assert.ok(got.table, got.error ?? "parse failed");
  const table = got.table!;
  eq(table.size, 2);
  eq(table.name, "Identity");
  assert.deepEqual(applyLookup(table, 255, 0, 0), [255, 0, 0]);
  assert.deepEqual(applyLookup(table, 0, 255, 0), [0, 255, 0]);
  assert.deepEqual(applyLookup(table, 0, 0, 255), [0, 0, 255]);
  assert.deepEqual(applyLookup(table, 255, 255, 255), [255, 255, 255]);
  assert.ok(lookupIsIdentity(table));
});

test("trilinear sampling interpolates between cube corners", () => {
  // Every output is 0 unless the input's red is 1: midpoint should be ~128.
  const cube = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 0 0
1 0 0
0 0 0
1 0 0
0 0 0
1 0 0
`;
  const got = parseCube(cube);
  assert.ok(got.table, got.error ?? "parse failed");
  const mid = applyLookup(got.table!, 128, 0, 0);
  assert.ok(Math.abs(mid[0] - 127) <= 2, `mid red ${mid[0]}`);
  eq(mid[1], 0);
});

test("the name falls back to the file name and the domain is honoured", () => {
  const cube = `LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 2 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
  const got = parseCube(cube, "identity.cube");
  assert.ok(got.table, got.error ?? "parse failed");
  eq(got.table!.name, "identity.cube");
  // input 0 corresponds to domain min; 128/255 is inside [0,2] → not clamped
  const half = applyLookup(got.table!, 128, 0, 0);
  assert.ok(half[0] > 0 && half[0] < 255, `red ${half[0]}`);
});

test("refusals name the reason instead of half-parsing", () => {
  eq(parseCube("LUT_1D_SIZE 16\n0 0 0\n").error?.includes("1D"), true);
  eq(parseCube("0 0 0\n1 1 1\n").error, "no LUT_3D_SIZE line — this is not a 3D .cube");
  eq(parseCube("LUT_3D_SIZE 1\n0 0 0\n").error?.includes("LUT_3D_SIZE"), true);
  eq(parseCube("LUT_3D_SIZE 70\n").error?.includes("LUT_3D_SIZE"), true);
  eq(parseCube("LUT_3D_SIZE 2\n0 0 0\n1 1 1\n").error?.includes("expected 8 colour rows"), true);
  eq(parseCube("LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\n" + "0 0 0\n".repeat(8)).error?.includes("DOMAIN_MAX"), true);
  eq(parseCube("LUT_3D_SIZE 2\n0 0 x\n" + "0 0 0\n".repeat(7)).error?.includes("not a number"), true);
});

test("cubeText rebuilds a table the parser reads back identically", () => {
  const got = parseCube(IDENTITY_2);
  assert.ok(got.table, got.error ?? "parse failed");
  const text = cubeText(got.table!);
  const again = parseCube(text);
  assert.ok(again.table, again.error ?? "parse failed");
  eq(again.table!.size, got.table!.size);
  assert.deepEqual(again.table!.data, got.table!.data);
  assert.deepEqual(applyLookup(again.table!, 12, 200, 99), applyLookup(got.table!, 12, 200, 99));
});

test("a .cube with more rows than its size declares stops early", () => {
  const rows = Array.from({ length: 9 }, () => "0.5 0.5 0.5").join("\n");
  const parsed = parseCube(`LUT_3D_SIZE 2\n${rows}\n`, "flood.cube");
  assert.equal(parsed.table, undefined);
  assert.match(String(parsed.error), /more colour rows/);
});
