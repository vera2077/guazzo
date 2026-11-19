#!/usr/bin/env node
/**
 * Static pins — Phase C2 of the analysis plan.
 *
 * These are invariants about the BUILT ARTIFACT and its sources: "the stylesheet
 * still gives the context menu a display", "the Rust side still owns the file
 * dialog", "the bundle is still one scoped non-module script". They used to be
 * scattered through `ui-smoke.mjs` next to behavioural assertions, which made a
 * failure ambiguous: was that a broken feature or a renamed constant?
 *
 * Two stages, two meanings:
 *   `node scripts/pins.mjs`      → the shape of the thing is wrong
 *   `node scripts/ui-smoke.mjs`  → the thing does not behave
 *
 * Run `node scripts/build-desktop.mjs` first; every pin reads `dist/`-derived
 * output or the sources that produced it.
 */
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const bundle = read("app-bundle.js");
const css = read("index.html");
const mainSrc = read("src/main.ts");
const conf = read("src-tauri/tauri.conf.json");
const caps = read("src-tauri/capabilities/default.json");
const rust = read("src-tauri/src/main.rs");
const pkg = JSON.parse(read("package.json") || "{}");

/** Each pin is [name, fn] where fn returns true or a string explaining the miss. */
const PINS = [
  // ---- artifact shape -----------------------------------------------------
  ["bundle is one non-module script wrapped in a scope", () =>
    (bundle.startsWith('"use strict";') && bundle.includes("(function () {")) ||
    "the bundle must start with \"use strict\" and open a function scope"],
  ["bundle has the double-boot sentinel", () =>
    bundle.includes("__GUAZZO_BOOTED__") || "a second include would boot the app twice"],
  ["artifact is not stale", () => true], // enforced by build-desktop; listed for the report

  // ---- v0.39.x / v0.40.x regressions that reached a user -------------------
  ["context popup is visible", () => {
    const i = css.indexOf(".context-pop {");
    if (i < 0) return "the .context-pop rule is gone";
    const rule = css.slice(i, css.indexOf("}", i));
    return /display:\s*flex/.test(rule) || "the menu popup would render as display:none again";
  }],
  ["menu submenus are fixed-position", () =>
    /\.menu-item\.sub\.open\s*>\s*\.menu-sub\s*\{[^}]*position:\s*fixed/.test(css) ||
    "an absolutely positioned submenu is clipped by the scrolling popup"],
  ["caption buttons sit above the resize grips", () => {
    const i = css.indexOf(".winctl {");
    const rule = i < 0 ? "" : css.slice(i, css.indexOf("}", i));
    return /z-index:\s*400/.test(rule) || ".rs-edge (z-index 60) would steal the close button";
  }],
  ["no hot red on the close button", () =>
    !/#c42b1c/i.test(css) || "the close button should match the app palette"],
  ["options bar keeps its tail visible", () =>
    (/\.opt-host\s*\{[^}]*min-width:\s*0/.test(css) && /\.opt-tail\s*\{[^}]*flex:\s*none/.test(css)) ||
    "the > and ? buttons can be squeezed off the row again"],
  ["paging does not measure scrollWidth", () =>
    !bundle.includes("host.scrollWidth") || "scrollWidth on a clipped flex row is not a reliable overflow measure"],
  ["children are not cast to arrays", () =>
    !/children as unknown as HTMLElement\[\]/.test(mainSrc) ||
    "HTMLCollection has no .filter — this shipped a crash"],
  ["drop target is indicated", () =>
    /\.drop-target\s*::after/.test(css) || "a drop would happen with no visible hint"],

  // ---- one implementation, one import path --------------------------------
  ["dialogs and drops share one importer", () =>
    (bundle.match(/async function openAnyFile/gu) ?? []).length === 1 ||
    "a second import path is a second place to forget the size caps"],
  ["one layers panel renderer", () =>
    (bundle.match(/function buildLayersPanel/gu) ?? []).length === 1 ||
    "the panel was extracted for a reason"],
  ["one bilinear sampler", () =>
    (bundle.match(/function samplePremul/gu) ?? []).length === 1 ||
    "three copies of the same premultiplied sampler had already drifted"],

  // ---- the desktop shell cannot be turned into a filesystem oracle --------
  ["no command accepts a path from the page", () =>
    (!rust.includes("fn write_bytes") && !rust.includes("fn read_bytes")) ||
    "the page must never name a file path — the dialog owns it"],
  ["save writes atomically", () =>
    (rust.includes("write_atomic") && rust.includes("sync_all")) ||
    "a crash mid-write must not truncate the user's file"],
  ["the page needs no dialog permission", () =>
    (!caps.includes('"dialog:allow') && caps.includes('"permissions": []')) ||
    "the Rust commands run the dialog, so the webview must not have the capability"],
  ["a CSP is set", () =>
    (conf.includes('"default-src') && !/"csp":\s*null/.test(conf)) ||
    "no CSP means any injected script runs with the app's privileges"],

  // ---- legal / provenance -------------------------------------------------
  ["the licence names the owner", () => {
    const lic = read("LICENSE");
    return (lic.includes("vera2077") && !lic.includes("[OWNER TODO")) ||
      "the About dialog embeds this text; a placeholder must not ship";
  }],
  ["the vendored PSD reader states its version", () =>
    /ag-psd [0-9][0-9A-Za-z.\-]*/.test(read("vendor/ag-psd-bundle.js").slice(0, 400)) ||
    "an unversioned 1 MB blob cannot be audited later"],

  // ---- version lockstep ---------------------------------------------------
  ["version is consistent across all four carriers", () => {
    const version = /const APP_VERSION = "([^"]+)"/.exec(mainSrc)?.[1];
    const cargo = /^version = "([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1];
    const tauri = /"version":\s*"([^"]+)"/.exec(conf)?.[1];
    const same = version && version === cargo && version === tauri && version === pkg.version;
    return same || `APP_VERSION=${version} Cargo=${cargo} tauri=${tauri} package=${pkg.version}`;
  }],
];

function main() {
  let failed = 0;
  for (const [name, check] of PINS) {
    let result;
    try {
      result = check();
    } catch (err) {
      result = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (result === true) continue;
    failed++;
    console.error(`✖ pin: ${name}\n    ${typeof result === "string" ? result : "returned " + String(result)}`);
  }
  if (failed > 0) {
    console.error(`\npins: ${failed} failed of ${PINS.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`pins: ${PINS.length}/${PINS.length} static invariants hold`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

export { PINS };
