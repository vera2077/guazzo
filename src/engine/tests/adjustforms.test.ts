/**
 * adjust-forms.ts — the shared field tables.
 *
 * AF2 (handoff-5): the floating palette and the modal tonal dialogs used to
 * declare the same slider ranges independently, which is how X1's drift
 * happened. These tests pin the table both surfaces now read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS_FIELDS, levelsFromFields, type FieldControl } from "../../ui/adjust-forms.ts";

const ctl = (value: number): FieldControl => ({ value: () => value } as unknown as FieldControl);

test("levels fields keep Photoshop's ranges and defaults", () => {
  const byId = Object.fromEntries(LEVELS_FIELDS.map((f) => [f.id, f]));
  assert.deepEqual(
    LEVELS_FIELDS.map((f) => f.id),
    ["inBlack", "inWhite", "gamma", "outBlack", "outWhite"],
  );
  assert.equal(byId.inBlack!.max, 254); // 255 is the white end, never an input black
  assert.equal(byId.inWhite!.min, 1);
  assert.equal(byId.gamma!.min, 0.1);
  assert.equal(byId.gamma!.max, 9);
  assert.equal(byId.gamma!.step, 0.05);
  assert.equal(byId.gamma!.def, 1);
  assert.equal(byId.outWhite!.def, 255);
});

test("levelsFromFields clamps an inverted range instead of producing a negative span", () => {
  const o = levelsFromFields({
    inBlack: ctl(200), inWhite: ctl(30), gamma: ctl(1),
    outBlack: ctl(0), outWhite: ctl(255),
  });
  assert.equal(o.inBlack, 200);
  assert.equal(o.inWhite, 201, "white must stay above black or the LUT divides by zero");
});

test("levelsFromFields passes normal values through untouched", () => {
  const o = levelsFromFields({
    inBlack: ctl(12), inWhite: ctl(240), gamma: ctl(1.35),
    outBlack: ctl(8), outWhite: ctl(250),
  });
  assert.deepEqual(o, { inBlack: 12, inWhite: 240, gamma: 1.35, outBlack: 8, outWhite: 250 });
});

test("the converged controls keep the user's chosen values (m10524)", async () => {
  const { BW_WEIGHTS, EXPOSURE, PHOTO_FILTER_DEFAULT, PHOTO_FILTER_PRESETS } = await import(
    "../../ui/adjust-forms.ts"
  );
  // Black & White: the dialog's weights, the widened −200…300 range for both surfaces.
  assert.deepEqual(
    [BW_WEIGHTS.red, BW_WEIGHTS.yellow, BW_WEIGHTS.green, BW_WEIGHTS.cyan, BW_WEIGHTS.blue, BW_WEIGHTS.magenta],
    [40, 60, 40, 60, 20, 80],
  );
  assert.equal(BW_WEIGHTS.min, -200);
  assert.equal(BW_WEIGHTS.max, 300);
  assert.ok(
    [BW_WEIGHTS.red, BW_WEIGHTS.yellow, BW_WEIGHTS.green, BW_WEIGHTS.cyan, BW_WEIGHTS.blue, BW_WEIGHTS.magenta]
      .every((w) => w >= BW_WEIGHTS.min && w <= BW_WEIGHTS.max),
    "every default must sit inside the range both surfaces render",
  );
  // Exposure: one EV scale, 0 EV in the middle.
  assert.deepEqual([EXPOSURE.min, EXPOSURE.max, EXPOSURE.def, EXPOSURE.step], [-4, 4, 0, 0.1]);
  // Photo Filter: Warming (85) at 25 % is the default, and it must be a real preset.
  assert.equal(PHOTO_FILTER_DEFAULT.preset, "Warming (85)");
  assert.equal(PHOTO_FILTER_DEFAULT.density, 25);
  assert.ok(PHOTO_FILTER_PRESETS.some(([label]) => label === PHOTO_FILTER_DEFAULT.preset));
  assert.deepEqual([...PHOTO_FILTER_DEFAULT.color], [214, 143, 53]);
});
