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
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** Every file whose contents can change the built artifact. */
function artifactInputs() {
  const sources = readdirSync("src", { recursive: true })
    .filter((f) => typeof f === "string" && f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => join("src", f));
  return ["index.html", "vendor/ag-psd-bundle.js", ...sources];
}

/**
 * The artifact must be newer than everything it is made of.
 *
 * This pin used to be `() => true` with the comment "enforced by
 * build-desktop" — which made it a line in the report that could never fail,
 * and the report is exactly where a human looks for reassurance.
 */
function artifactIsFresh() {
  const bundleStat = statSync("app-bundle.js", { throwIfNoEntry: false });
  if (!bundleStat) return "app-bundle.js is missing — run scripts/build-desktop.mjs";
  const stale = artifactInputs().filter((file) => {
    const m = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    // 1 s of slack: coarse filesystems round timestamps, and a rebuild within
    // the same second is not evidence of staleness.
    return m > bundleStat.mtimeMs + 1000;
  });
  return stale.length === 0 || `${stale.length} input(s) newer than the bundle, e.g. ${stale[0]}`;
}
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
  ["artifact is not stale", artifactIsFresh],

  // ---- AJ: the preview must not flatter the result -------------------------
  ["the preview composites through a temporary document", () =>
    bundle.includes("new Document(sw, sh)") ||
    "the preview must show the layer inside its stack, not pasted over a composite that already has it"],
  ["the preview downsamples layer masks", () =>
    bundle.includes("function downsampleMaskInto(") ||
    "a masked-out hole would preview as solid"],
  ["the preview threads the selection to the recipe", () =>
    /previewJobMaskAware \? cache\.proxyMask : null/.test(bundle) ||
    "the preview must ignore the same mask the commit ignores, and say so"],
  ["clearing the preview cancels the queued frame", () =>
    /previewCancel\?\.\(\);/.test(bundle) ||
    "a frame queued for the old document would paint over the new one"],

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
  ["a save target belongs to one document", () =>
    (!rust.includes("LAST_SAVE") &&
      rust.includes("saved_slots") &&
      rust.includes("remember: bool") &&
      read("src/main.ts").includes("savedHandle")) ||
    "AG1: one process-global save slot let Ctrl+S overwrite another tab's file, or an exported PNG"],
  ["save writes atomically", () =>
    (rust.includes("write_atomic") && rust.includes("sync_all")) ||
    "a crash mid-write must not truncate the user's file"],
  ["the page needs no dialog permission", () =>
    (!caps.includes('"dialog:allow') && caps.includes('"permissions": []')) ||
    "the Rust commands run the dialog, so the webview must not have the capability"],
  // ---- keyboard contract (AH5) --------------------------------------------
  // ---- handoff-7 AL/AM/AP ------------------------------------------------
  ["the close prompt is latched", () =>
    (/if \(!closeLoop\.begin\(\)\) return;/.test(mainSrc) && /function createCloseLoop\(/.test(bundle)) ||
    "closeWithGuard must take the latch, not a module boolean (AM4 tests it)"],
  ["a cancelled close is acknowledged", () =>
    (/close_ack/.test(rust) && /ackCloseRequest/.test(bundle)) ||
    "without the ack a cancelled Alt+F4 re-fires every 400 ms"],
  ["Enter honours a dialog that refused to close", () =>
    /if \(onOk\(\) === false\)\s*return;/.test(bundle) ||
    "the keyboard path must use the same refusal contract as the OK button"],
  ["the preview proxy is cached between slider ticks", () =>
    (/let proxyCache: ProxyCache \| null = null;/.test(mainSrc) && /function buildProxy\(/.test(mainSrc)) ||
    "rebuilding every layer of a 16384² stack per pointermove is the AL3 bug"],
  ["a release can name its commit", () =>
    (/RELEASE\.json/.test(readFileSync(new URL("../scripts/release.mjs", import.meta.url), "utf8"))) ||
    "staging a folder with no provenance makes 'what we shipped' unverifiable"],
  ["selection undo stores the bbox, not the canvas", () =>
    (/function snapshotMask\(/.test(mainSrc) && !/selMask\.clone\(\)/.test(mainSrc)) ||
    "a full-canvas mask snapshot is 268 MB at 16384² — store the bbox"],
  ["Select and Mask hides outside the selection", () =>
    /fillMaskFromSelection\(/.test(mainSrc) ||
    "a layer mask from a selection must hide the complement, not only touch the bbox"],
  ["the seed sink is fed only by the escaping builder", () =>
    (/buildSeedHtml\(/.test(bundle) && /function safeFontFamily\(/.test(bundle)) ||
    "text seed HTML must be produced by buildSeedHtml with the font whitelist"],
  ["zooming is reachable with Shift held", () =>
    (/"ctrl\+\+": "zoomIn"/.test(bundle) && /SHIFTED_GLYPHS/.test(bundle)) ||
    "with Shift the browser reports '+' — ctrl+shift+= alone never matches"],

  // ---- window close (v0.63.2) ---------------------------------------------
  ["the close command is not gated on a flag the page cannot set", () =>
    !/fn win_force_close[\s\S]{0,400}?if !CLOSE_REQUESTED/.test(rust) ||
    "win_force_close must close once the page has confirmed; a guard there stopped the caption X"],
  ["the close command actually destroys the window", () =>
    /fn win_force_close[\s\S]{0,600}?window\.destroy\(\)/.test(rust) ||
    "win_force_close no longer destroys the window"],
  ["a native close is routed through the page guard", () =>
    (/api\.prevent_close\(\)/.test(rust) && /CLOSE_REQUESTED\.store\(true/.test(rust)) ||
    "Alt+F4 must be intercepted and handed to the page's unsaved-work prompt"],

  ["the accelerator chain is a table, not an if-chain", () =>
    /KEY_HANDLERS\b/.test(bundle) ||
    "the bundle has no KEY_HANDLERS map — the old key chain came back"],
  ["no accelerator is dispatched by a bare letter comparison", () =>
    !/const k = e\.key\.toLowerCase\(\)/.test(bundle) ||
    "the old `const k = e.key.toLowerCase()` accelerator chain is back"],
  ["the keymap module is bundled", () =>
    /function keyAction\(/.test(bundle) ||
    "dist/ui/keymap.js is missing from the bundle order"],

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

  // ---- review follow-ups ---------------------------------------------------
  ["Ctrl+Shift+S reaches a REGISTERED Save As", () => {
    // The old pin asserted that the dispatch string existed — which is exactly
    // how the bug shipped: the label was dispatched and never registered.
    const registered = bundle.includes('topButton("file", "Save Project As');
    const body = /function runTop\(label\)[\s\S]*?\n\}/.exec(bundle)?.[0] ?? "";
    return (registered && body.includes("menuDefs()")) ||
      "Save As must be a registered action AND runTop must fall back to the menu tree";
  }],

  ["Select and Mask can output a layer mask", () => {
    // AI4: the refined edge is usually wanted as a mask; the engine band used to be
    // derived from fractional alphas that no tool writes, so the radius did nothing.
    const ok = bundle.includes("New layer with that mask") && bundle.includes("refineSelection(");
    return ok || "the dialog must offer mask output and still call the engine";
  }],

  ["a dialog can refuse to close on invalid input", () =>
    /onOk\(\) === false/.test(bundle) ||
    "validation errors used to vanish together with the dialog that held them"],
];

/**
 * Run every pin and return the number that failed.
 *
 * `ci.mjs` calls this; the guard at the bottom only covers `node
 * scripts/pins.mjs`. Before this was exported the gate imported the module,
 * `main()` never ran (the guard compares argv[1], which an import does not
 * set), and the whole static layer was decorative.
 */
export function runPins() {
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
  } else {
    console.log(`pins: ${PINS.length}/${PINS.length} static invariants hold`);
  }
  return failed;
}

function main() {
  if (runPins() > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

export { PINS };
