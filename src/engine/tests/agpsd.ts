/**
 * agpsd.ts — the one place that loads the real ag-psd.
 *
 * Resolution first, hard path second. A normal `npm install` puts ag-psd at
 * node_modules/ag-psd and `require.resolve` finds it; this sandbox's pnpm
 * layout keeps the package behind a junction that Node does not walk, so the
 * fallback names the store path directly. Both routes end at the same bytes.
 *
 * The order matters: the fallback used to be the only route, which made the
 * test suite pass here and fail on a hosted runner that installs with npm.
 */
import { createRequire } from "node:module";

export interface AgPsd {
  writePsd: (psd: unknown, options?: unknown) => ArrayBuffer;
  readPsd: (buf: Uint8Array, options?: unknown) => unknown;
  initializeCanvas: (createCanvas: unknown, createImageData: unknown) => void;
}

const STORE_PATH =
  "../../../node_modules/.pnpm/ag-psd@34.2.1/node_modules/ag-psd/dist/index.js";

/** positional arguments, as the vendored version expects */
export function loadAgPsd(): AgPsd {
  const require = createRequire(import.meta.url);
  let mod: AgPsd;
  try {
    mod = require(require.resolve("ag-psd")) as AgPsd;
  } catch {
    mod = require(STORE_PATH) as AgPsd;
  }
  mod.initializeCanvas(
    (w: number, h: number) => ({
      width: w,
      height: h,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
      style: {},
    }),
    (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  );
  return mod;
}
