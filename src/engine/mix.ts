/** Linear mix of two colours, 0 = a, 1 = b. Rounded per channel. */
export type Rgb = readonly [number, number, number];

export function mixColour(a: Rgb, b: Rgb, t: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}
