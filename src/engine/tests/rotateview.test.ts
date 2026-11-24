/**
 * rotateview.test.ts — pure view-rotation math: centre-relative clockwise
 * rotation, exact inverse, rotated-rectangle bounds and 15° angle snapping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rotateViewPoint,
  unrotateViewPoint,
  rotateViewRect,
  viewAngleSteps,
  type ViewPoint,
  type ViewRect,
} from "../rotateview.ts";

const near = (got: number, want: number, msg: string, eps = 1e-9): void => {
  assert.ok(Math.abs(got - want) <= eps, `${msg}: expected ${want}, got ${got}`);
};
const nearPoint = (got: ViewPoint, x: number, y: number, msg: string): void => {
  near(got.x, x, `${msg}.x`);
  near(got.y, y, `${msg}.y`);
};

test("90° clockwise about a centre maps a known point — pivot is the centre, not the origin", () => {
  const centre: ViewPoint = { x: 10, y: 10 };
  const p: ViewPoint = { x: 15, y: 10 }; // 5 px to the RIGHT of the centre

  // Clockwise on screen: right of centre → below centre.
  const got = rotateViewPoint(p, centre, 90);
  nearPoint(got, 10, 15, "right-of-centre point after 90° clockwise");

  // A rotation around (0,0) would produce (-10, 15) instead; the assertion
  // above fails for that implementation, and this control makes it explicit.
  const aboutOrigin = rotateViewPoint(p, { x: 0, y: 0 }, 90);
  nearPoint(aboutOrigin, -10, 15, "same point pivoted on the origin");
  assert.ok(
    Math.abs(got.x - aboutOrigin.x) > 1e-6,
    "pivot must be the supplied centre, not the origin",
  );
});

test("rotate → unrotate round-trips exactly for assorted points and angles", () => {
  const centre: ViewPoint = { x: -7, y: 33 };
  const points: ViewPoint[] = [
    { x: 0, y: 0 },
    { x: 12, y: -4 },
    { x: -7, y: 33 }, // the pivot itself is fixed
    { x: 1000.5, y: -250.25 },
  ];
  for (const degrees of [0, 15, 37, 90, 179, 270, -45, 720]) {
    for (const p of points) {
      const back = unrotateViewPoint(rotateViewPoint(p, centre, degrees), centre, degrees);
      nearPoint(back, p.x, p.y, `round-trip ${JSON.stringify(p)} @ ${degrees}°`);
    }
  }
});

test("rotateViewRect returns the AABB containing all four rotated corners", () => {
  const r: ViewRect = { x: 0, y: 0, w: 10, h: 4 };
  const centre: ViewPoint = { x: 5, y: 2 };

  // Known 90° case: corners (0,0),(10,0),(10,4),(0,4) → x∈[3,7], y∈[-3,7].
  const box = rotateViewRect(r, centre, 90);
  near(box.x, 3, "min x");
  near(box.y, -3, "min y");
  near(box.w, 4, "width");
  near(box.h, 10, "height");

  // For arbitrary angles, every rotated corner must lie inside the box.
  const corners: ViewPoint[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (const degrees of [0, 23, 45, 90, 137.5, -33, 360]) {
    const b = rotateViewRect(r, centre, degrees);
    for (const c of corners) {
      const q = rotateViewPoint(c, centre, degrees);
      assert.ok(
        q.x >= b.x - 1e-9 && q.x <= b.x + b.w + 1e-9,
        `${degrees}°: corner x ${q.x} outside [${b.x}, ${b.x + b.w}]`,
      );
      assert.ok(
        q.y >= b.y - 1e-9 && q.y <= b.y + b.h + 1e-9,
        `${degrees}°: corner y ${q.y} outside [${b.y}, ${b.y + b.h}]`,
      );
    }
  }
});

test("viewAngleSteps snaps to nearest 15° step and wraps into [0,360)", () => {
  assert.equal(viewAngleSteps(22), 15);
  assert.equal(viewAngleSteps(359), 0);
  assert.equal(viewAngleSteps(0), 0);
  assert.equal(viewAngleSteps(7), 0);
  assert.equal(viewAngleSteps(8), 15);
  assert.equal(viewAngleSteps(180), 180);
  assert.equal(viewAngleSteps(375), 15);
  assert.equal(viewAngleSteps(-15), 345);
});
