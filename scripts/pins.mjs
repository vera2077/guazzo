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
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { measure } from "./coupling.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

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
const refineSrc = readFileSync(new URL("../src/engine/refine.ts", import.meta.url), "utf8");
const srcDoc = readFileSync(new URL("../src/engine/document.ts", import.meta.url), "utf8");
const mainSrc = read("src/main.ts");
const conf = read("src-tauri/tauri.conf.json");
/** Measured at 78a1afe (R5 baseline): 98 of 272 top-level functions. */
const COUPLING_BASELINE = 84;

const caps = read("src-tauri/capabilities/default.json");
const rust = read("src-tauri/src/main.rs");
const pkg = JSON.parse(read("package.json") || "{}");

/** Each pin is [name, fn] where fn returns true or a string explaining the miss. */
const EXTRA_PINS = [
  // DoD #5: these two are the whole XSS boundary and the whole close guard, so a
  // deletion must turn the gate red rather than leave a passing mention behind.
  ["the escaping attribute writer exists", () => /function escapeAttr\(/.test(readFileSync('src/ui/textseed.ts', 'utf8'))],
  ["the close command is actually reachable from the page", () => /windowForceClose\(\)/.test(mainSrc)],
  ["the proxy starts from unfiltered pixels on every tick", () => /cache\.target\.grid\.writeRect\(0, 0, cache\.sw, cache\.sh, cache\.pristine\)/.test(mainSrc)],
  ["Enter and OK share one path (onOk is invoked once)", () => {
    // strip comments first: a comment mentioning onOk() is not a call site
    const src = readFileSync('src/ui/dialogs.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const calls = (src.match(/onOk\(\)/g) ?? []).length;
    return calls === 1 ? true : `onOk() is invoked ${calls} times — the button and Enter can disagree`;
  }],
  ["the popup owns the menu bar", () => {
    const popupSrc = readFileSync('src/ui/popup.ts', 'utf8');
    return (/export function mountMenuBar\(/.test(popupSrc)
      && /mountMenuBar\(menuBarEl, menuDefs\)/.test(mainSrc)
      && !/setCloseAllMenus|initPopup/.test(popupSrc + mainSrc))
      || "R3: the module that opens a menu must be the module that closes it";
  }],
  // Step 4 structural pin: the chrome lives in its module, and it cannot delete
  // the unsaved-changes guard by calling windowClose() itself. The pin fails if
  // a later "cleanup" re-inlines buildWindowChrome into the shell or bypasses
  // the onClose dependency; source-shape, not a runtime test, because the
  // browser smoke has no Tauri window to click.
  ["window chrome is mounted by src/ui/windowchrome.ts", () => {
    // strip comments: the header explains why windowClose must not be used, and
    // the word alone is not a call site (same rule as the onOk pin).
    const chrome = read("src/ui/windowchrome.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    if (!/export function mountWindowChrome\s*\(\s*host: HTMLElement/.test(chrome)) return "src/ui/windowchrome.ts does not export mountWindowChrome(host)";
    if (/function buildWindowChrome/.test(mainSrc)) return "src/main.ts still defines buildWindowChrome";
    if (!/mountWindowChrome\(topbar,/.test(mainSrc)) return "src/main.ts never mounts the chrome";
    if (/\bwindowClose\b/.test(chrome)) return "src/ui/windowchrome.ts calls windowClose directly — the unsaved-changes guard is gone";
    if (!/deps\.onClose\(\)/.test(chrome)) return "the close button no longer runs the shell's guarded close";
    return true;
  }],
];

const PINS_GROUPS = [
  ["the shell never mutates the layer tree directly", () => {
    const bad = [/\blayers\.splice\(/, /\.children\.splice\(/, /\.children\.push\(/].find((re) => re.test(mainSrc));
    return bad ? `main.ts mutates the tree with ${bad} — use insertLayer/removeLayerFrom/moveLayerTo` : true;
  }],
  ["the tree primitives exist and the shell uses the add helper", () => {
    if (!/insertLayer\(parent: Layer \| null/.test(srcDoc)) return "document.ts has no insertLayer(parent, ...)";
    if (!/moveLayerTo\(/.test(srcDoc)) return "document.ts has no moveLayerTo";
    if (!/function addAboveActive\(/.test(mainSrc)) return "the six add sites lost addAboveActive";
    return true;
  }],
];
const PINS = [
  ...PINS_GROUPS,
  // AU5: the portable single-file build carries its own policy, and the hashes
  // in it are the ones this file's scripts actually produce. A pin, not a test
  // suite, because it is a property of the artifact we ship.
  [
    "the portable build carries a CSP that matches its own scripts",
    () => {
      const single = readFileSync(new URL("../app-single.html", import.meta.url), "utf8");
      const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(single);
      if (!meta) return "app-single.html has no CSP meta";
      const policy = meta[1];
      if (/script-src[^;]*unsafe-inline/.test(policy)) return "script-src allows 'unsafe-inline'";
      const declared = new Set([...policy.matchAll(/'(sha256-[^']+)'/g)].map((m) => m[1]));
      const bodies = [...single.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      if (bodies.length === 0) return "no inline script found";
      for (const body of bodies) {
        const h = "sha256-" + createHash("sha256").update(body.replace(/\r\n?/g, "\n"), "utf8").digest("base64");
        if (!declared.has(h)) return "a script body is not covered by the policy";
      }
      if (single.indexOf("Content-Security-Policy") > single.indexOf("<script")) return "the CSP meta comes after a script";
      return true;
    },
  ],
  [
    "AS2: the chrome has a keyboard route (F6 / F10)",
    () => mainSrc.includes('if (e.key === "F6")') && /function focusNextPane\(/.test(mainSrc) && mainSrc.includes('if (e.key === "F10"'),
  ],
  ["write errors name the file, never its directory", () => !/format!\([^)]*display\(\)/.test(rust)
    || "a Rust error string formats a path — the page must only ever see a file name"],
...EXTRA_PINS,
  ["dirty-tab close uses the in-app dialog, not window.confirm", () => {
    const tabsSrc = readFileSync('src/ui/tabs.ts', 'utf8');
    return ((!/window\.confirm\s*\(/.test(bundle + tabsSrc))
      && /api\.ask\(/.test(tabsSrc)
      && /function closeOtherTabs\(/.test(tabsSrc)
      && /ask: \(title, body, ok\) => ask\(/.test(mainSrc))
      || "closeTab must ask through ui/dialogs.ts and batch Close Other Tabs into one prompt";
  }],
  ["a cancelled save says so instead of claiming the file", () =>
    /Export cancelled/.test(bundle) && /written, not claimable/.test(rust)],
  // ---- artifact shape -----------------------------------------------------
  ["bundle is one non-module script wrapped in a scope", () =>
    (bundle.startsWith('"use strict";') && bundle.includes("(function () {")) ||
    "the bundle must start with \"use strict\" and open a function scope"],
  ["bundle has the double-boot sentinel", () =>
    bundle.includes("__GUAZZO_BOOTED__") || "a second include would boot the app twice"],
  ["artifact is not stale", artifactIsFresh],

  // ---- rewrite progress (R5) ----------------------------------------------
  // Line count rewarded moving code around; it could not tell an extraction
  // from a reshuffle. This counts the thing the rewrite is for: top-level
  // functions in src/main.ts that still mention document state. Lower it in the
  // same commit that moves the state out, never raise it to make a refactor fit.
  ["src/ui/tabs.ts owns no document state", () => {
    // H3: one structural pin per step, not only the number. The module may
    // name state only in TabState's property declarations; any bare read is a
    // regression to the coupling the move was meant to end.
    const src = read("src/ui/tabs.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const bad = src.match(/(?<![\w$./-])(doc|activeLayer|history|flat|flatDirty|selMask|selRect|autosaveDirty|docDirty)\b(?!\s*:)/);
    return !bad || `src/ui/tabs.ts reads ${bad[0]} directly`;
  }],
  ["the session owns the undo stack", () => {
    const main = read("src/main.ts");
    const session = read("src/ui/session.ts");
    if (!main.includes("const session = new DocSession()")) return "main.ts no longer creates the DocSession";
    if (main.includes("let history = new History(")) return "main.ts keeps a bare history global";
    if (!session.includes("adopt(history: History)")) return "DocSession has no adopt() for a tab switch";
    if (!main.includes("session.adopt(s.history)")) return "a tab switch no longer hands its stack to the session";
    if (!main.includes("session.push(entry)")) return "pushHist no longer pushes through the session";
    return true;
  }],
  ["flatDirty is gone; the cache owns invalidation", () => {
    // B2: the boolean had 63 owners. If it comes back anywhere — code or a
    // comment — the cache has been bypassed again and a stale composite ships.
    const owners = ["src/main.ts", "src/ui/tabs.ts", "src/ui/tests/tabs.test.ts"]
      .filter((f) => read(f).includes("flatDirty"));
    if (owners.length) return `${owners.join(", ")} still name flatDirty; call flatCache.invalidate()`;
    const main = read("src/main.ts");
    if (!main.includes("createFlatCache(")) return "main.ts no longer creates the flat cache";
    if (!main.includes("flatCache.adopt(")) return "a tab switch no longer adopts its cache";
    if (!main.includes("needsComposite(doc.revision)")) return "renderFlat no longer compares the document revision";
    return true;
  }],
  ["a declared change is the only cache invalidation in the shell", () => {
    // B3: pixel edits are derived from doc.revision inside the tile primitives.
    // What is left explicit is the structure list — one helper, one place to
    // review. A second invalidate() means a call site is guessing again.
    const main = read("src/main.ts");
    if (!main.includes("const declaredChange = (): void =>")) return "main.ts lost its declared-change helper";
    const sites = main.split("flatCache.invalidate()").length - 1;
    if (sites !== 1) return `main.ts has ${sites} direct flatCache.invalidate() calls; the helper is the only place`;
    if (!main.includes("doc.revision++")) return "a declared change no longer moves the document revision";
    if (read("src/ui/tabs.ts").includes("flatCache.invalidate()")) return "tabs.ts invalidates the cache directly";
    return true;
  }],
  ["pixel primitives bump the document revision", () => {
    // B3: writeRect/fillRect/clearAllocated end with version++, so they are the
    // one place a pixel edit is visible to every cache key. The hook next to
    // them is what makes a missed invalidation impossible rather than a
    // convention across 51 call sites.
    const tile = read("src/engine/tile.ts");
    if (!/onWrite\?:\s*\(\)\s*=>\s*void/.test(tile)) return "TileGrid has no write hook";
    if ((tile.match(/this\.onWrite\?\.\(\)/g) ?? []).length < 3) return "a tile primitive no longer bumps the document";
    if (!tile.includes("touch(): void")) return "TileGrid has no touch() for direct data writes";
    if (!/revision\s*=\s*0/.test(read("src/engine/document.ts"))) return "Document has no revision counter";
    const main = read("src/main.ts");
    if (!main.includes("needsComposite(doc.revision)")) return "renderFlat does not read the revision";
    return true;
  }],
  ["the preview key reads the document revision, not a bounded index", () => {
    // AQ3: history.position saturates at the undo limit, so an edit after the
    // limit produced the previous key. The revision counter is unbounded.
    const key = read("src/ui/proxykey.ts");
    if (!/revision:\s*number/.test(key)) return "proxyKey lost its revision field";
    if (key.includes("editEpoch")) return "proxyKey still keys on the bounded history epoch";
    if (!key.includes("i.revision")) return "proxyKey no longer joins the revision";
    const main = read("src/main.ts");
    if (!main.includes("revision: doc.revision")) return "the proxy call does not pass the document revision";
    return true;
  }],
  ["the preview key counts every layer node", () => {
    // A group is one root entry with many children: keying on doc.layers.length
    // makes two different documents share a key component, and the preview
    // shows the wrong stack.
    const main = read("src/main.ts");
    if (!main.includes("layerCount: doc.layerCount()")) return "previewKey counts root entries, not nodes";
    if (main.includes("layerCount: doc.layers.length")) return "previewKey still uses doc.layers.length";
    return true;
  }],
  ["a slot stores a flat snapshot, not a cache", () => {
    // The B2 smoke bug: a slot holding the live cache let the next adopt()
    // resize the slot's geometry. The brand is the compile-time fence.
    const cache = read("src/ui/flatcache.ts");
    if (!cache.includes('kind: "flat-snapshot"')) return "FlatSnapshot lost its brand";
    if (!cache.includes("adopt(snapshot: FlatSnapshot)")) return "adopt() no longer takes a snapshot";
    if (read("src/ui/tabs.ts").includes(".adopt(live")) return "tabs.ts hands the live cache back to adopt()";
    return true;
  }],
  ["only the flat cache owns a full-canvas buffer", () => {
    // Same ownership rule as previewqueue.ts: the module owns the storage; the
    // shell may write pixels into it, but must not hold or replace it. Temp
    // buffers for thumbnails/copies are the shell's business and stay allowed.
    for (const f of ["src/main.ts", "src/ui/tabs.ts"]) {
      const src = read(f);
      if (/\blet\s+flat\s*=/.test(src)) return `${f} keeps a bare flat buffer global`;
      if (/flat:\s*new Uint8ClampedArray/.test(src)) return `${f} constructs a flat buffer instead of createFlatCache()`;
    }
    const tabs = read("src/ui/tabs.ts");
    if (!/flat:\s*createFlatCache\(/.test(tabs)) return "src/ui/tabs.ts no longer creates per-tab caches";
    return read("src/ui/flatcache.ts").includes("new Uint8ClampedArray(bytesFor(")
      || "src/ui/flatcache.ts lost its allocation";
  }],
  ["rewrite coupling does not grow", () => {
    const { coupled, total, pct } = measure(join(ROOT, "src/main.ts"));
    return coupled <= COUPLING_BASELINE ||
      `coupling rose to ${coupled}/${total} (${pct}%); baseline is ${COUPLING_BASELINE}`;
  }],

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
  ["the menu bar has no injectable closer", () => {
    const popupSrc = readFileSync('src/ui/popup.ts', 'utf8');
    return ((!/initPopup|setCloseAllMenus/.test(popupSrc + mainSrc))
      && /export function closeMenus\(/.test(popupSrc)) ||
      "AN1/R3: a module-tail setter silently leaves the harness half-working";
  }],
  ["context-menu ownership is asked of the popup", () =>
    (/function contextMenuOwns\(/.test(bundle) && !/querySelector\("\.context-pop"\)/.test(mainSrc)) ||
    "AN3: two places knowing the popup's DOM contract is how they drift"],
  ["refine is bounded by the selection, not the canvas", () =>
    (/export function refineWorkArea\(/.test(refineSrc)) ||
    "AP4: a 40 × 40 selection on 16384² must not allocate canvas-sized planes"],
  ["refine cannot grow the selection it is refining", () =>
    (/const bx0 = box\.x/.test(refineSrc)) ||
    "AP2: colour matting outside the footprint walks the selection outward every pass"],
  ["the preview proxy is cached between slider ticks", () =>
    (/let proxyCache: ProxyCache \| null = null;/.test(mainSrc) && /function buildProxy\(/.test(mainSrc)) ||
    "rebuilding every layer of a 16384² stack per pointermove is the AL3 bug"],
  // AV2: this used to grep release.mjs for the literal "RELEASE.json", which the
  // script's own allow-list also contains — it passed even if the manifest write
  // was deleted. The claim is now made by executing stage() in a temp directory
  // (src/engine/tests/release.test.ts); the pin only checks the seam exists.
  ["release staging is a testable function, not a script", () => {
    const src = readFileSync(new URL("../scripts/release.mjs", import.meta.url), "utf8");
    if (!/export function stage\(o\)/.test(src)) return "release.mjs does not export stage()";
    if (!/renameSync\(stagingDir, outDir\)/.test(src)) return "staging is not swapped in with a rename";
    return true;
  }],
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
