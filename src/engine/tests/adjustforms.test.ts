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
