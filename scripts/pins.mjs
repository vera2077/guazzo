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
  // Tauri replaces WebView2's drag-drop handler with its own by default, and the
  // page then never receives a `drop` event for a file dragged in from Explorer:
  // the OS paints the copy cursor and nothing happens. That shipped in 1.11.0 and
  // was invisible to the smoke because the harness fires the DOM event directly.
  // The page routes dropped files by target, so the native handler must stay off.
  ["the page, not the shell, handles dropped files", () => {
    const src = readFileSync("src-tauri/src/main.rs", "utf8");
    return /\.disable_drag_drop_handler\(\)/.test(src)
      || "main.rs no longer calls disable_drag_drop_handler(), so WebView2 swallows HTML5 file drops again";
  }],
  // The signature is recorded, not assumed. A release job that means to sign
  // must not be able to publish an exe whose manifest says nothing about it,
  // and a "signature" without a timestamp dies the day the certificate expires.
  ["release staging records the signature it found", () => {
    const src = readFileSync("scripts/release.mjs", "utf8");
    return (/const signature = o\.signature \?\? readSignature\(/.test(src)
      && /signature: signatureManifest\(signature\)/.test(src))
      || "release.mjs stopped asking the exe what its signature says";
  }],
  ["signing is timestamped and refuses without a certificate", () => {
    const src = readFileSync("scripts/signature.mjs", "utf8");
    const timestamped = /"\/tr", timestampUrl/.test(src) && /"\/td", "SHA256"/.test(src);
    const refuses = /no certificate thumbprint/.test(src);
    return (timestamped && refuses)
      || "an untimestamped signature expires with the certificate, and signing without a thumbprint signs with whatever it finds";
  }],
  // DoD #5: these two are the whole XSS boundary and the whole close guard, so a
  // deletion must turn the gate red rather than leave a passing mention behind.
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
  ["the r21 data-loss paths stay refused", () => {
    const checks = [
      [/!upper\.visible \|\| !below\.visible \|\| !!upper\.smart \|\| !!below\.smart \|\| !!below\.textData/,
        "Merge Down must refuse a hidden, smart or live-type layer"],
      [/if \(moveDrag\) endMoveDrag\(\);/,
        "a tool switch must record an in-flight move instead of dropping it"],
      [/mask\.clearAllocated\(\);\s*restoreTiles\(mask, maskBefore\)/,
        "transform undo must clear the destination mask tiles"],
      [/centre: \{ x: t\.src\.x \+ t\.src\.w \/ 2/,
        "a smart layer's mask must pivot on the pixels' centre"],
      [/layer\.textData \? textOpCommand\(layer, label, run\)/,
        "transforming live text must restore its recipe"],
      [/bytes: pxEntry\.bytes,/,
        "text resize must charge its pixels to the history budget"],
    ];
    const bad = checks.find(([re]) => !re.test(mainSrc));
    return bad ? bad[1] : true;
  }],
  ["the shell never mutates the layer tree directly", () => {
    const bad = [/\blayers\.splice\(/, /\.children\.splice\(/, /\.children\.push\(/].find((re) => re.test(mainSrc));
    return bad ? `main.ts mutates the tree with ${bad} — use insertLayer/removeLayerFrom/moveLayerTo` : true;
  }],
  ["the group tests keep the guard and the row-2 cycle", () => {
    const tests = readFileSync(new URL("../src/engine/tests/groups.test.ts", import.meta.url), "utf8");
    const guard = (tests.match(/guard: insertLayer refuses/g) ?? []).length;
    if (guard !== 1) return `groups.test.ts has the guard test ${guard} times - a merge deleted or doubled it`;
    if (!/row 2: delete\/undo\/redo a group child is stable across cycles/.test(tests)) {
      return "groups.test.ts lost the row-2 cycle - a merge can no longer delete a test a pin reads";
    }
    return true;
  }],
  ["the tree guard is still in the primitive", () => {
    if (!/already in the document - detach it with removeLayerFrom/.test(srcDoc)) {
      return "insertLayer lost its \"already in the document\" refusal — a stale spot can duplicate a node again";
    }
    if (!/insertLayer: cannot insert/.test(srcDoc)) return "insertLayer lost its descendant refusal";
    return true;
  }],
  ["deleteActiveLayer deletes group children", () => {
    if (!/const parent = doc\.parentOf\(layer\);/.test(mainSrc)) return "deleteActiveLayer went back to a flat index";
    if (!/doc\.removeLayerFrom\(parent, layer\);/.test(mainSrc)) return "deleteActiveLayer no longer detaches with removeLayerFrom";
    // Matches the FIELDS, not the spelling: { parent, index } shorthand is a correct
    // edit and must not fail the gate; a root-only spot still does.
    if (!/layerRemoveCommand\(doc, layer, \{\s*parent,\s*index/.test(mainSrc)) return "deleteActiveLayer records a root-only spot";
    return true;
  }],
  ["a mask stroke reads Alt and the help says so", () => {
    // The hint promised "Alt-paint to reveal" for a year while no dab read the
    // modifier (uiux-r17 #5). The flag must be captured once per stroke, not
    // per dab: releasing Alt mid-stroke must not flip the dab under the cursor.
    if (!/strokeAlt = e\.altKey;/.test(mainSrc)) return "the stroke start does not capture Alt";
    if (!/const hide = \(mlum < 128\) !== strokeAlt;/.test(mainSrc)) return "the mask dab ignores strokeAlt";
    if (!/strokeAlt = false;/.test(mainSrc)) return "endStroke does not clear strokeAlt";
    return true;
  }],
  ["bracket keys use e.code, not e.key", () => {
    // Shift+] arrives as "}", so an e.key branch changed the brush size while
    // the help text promised hardness (uiux-r17 #5).
    if (!/e\.code === "BracketLeft" \|\| e\.code === "BracketRight"/.test(mainSrc)) return "brackets do not use e.code";
    return true;
  }],
  ["the colour popover returns focus to its opener", () => {
    if (!/colorPopAnchor = anchor;/.test(mainSrc)) return "openColorPicker does not record its anchor";
    if (!/if \(back && back\.isConnected && back\.offsetParent !== null\) back\.focus\(\);/.test(mainSrc)) return "closeColorPop does not restore focus";
    return true;
  }],
  ["invalidation has exactly one door", () => {
    const hits = (mainSrc.match(/flatCache\.invalidate\(\)/g) ?? []).length;
    return hits === 1 ? true : `main.ts calls flatCache.invalidate() ${hits} times — the cache has one owner`;
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
      && /ask: \(title, body, ok, kind, extra\) => ask\(title, body, ok, kind, extra\)/.test(mainSrc)
      && /label: "Save"/.test(tabsSrc))
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
  ["the session owns the undo stack and the panel's collapse set", () => {
    const main = read("src/main.ts");
    const session = read("src/ui/session.ts");
    if (!main.includes("const session = new DocSession()")) return "main.ts no longer creates the DocSession";
    if (main.includes("let history = new History(")) return "main.ts keeps a bare history global";
    if (!session.includes("adopt(history: History, collapsed: ReadonlySet<number>)")) return "DocSession has no adopt() carrying a tab's stack and folds";
    if (!session.includes("private collapsedIds = new Set<number>()")) return "the collapse set is not keyed by layer id on the session";
    if (!main.includes("session.adopt(s.history, s.collapsed)")) return "a tab switch no longer hands its stack and folds to the session";
    if (!main.includes("session.push(entry)")) return "pushHist no longer pushes through the session";
    return true;
  }],
  ["groups refuse pixels instead of silently no-opping", () => {
    // A group has no pixels. Every paint/adjust/fill/transform entry point must
    // call the refusal before it touches `grid`; a missing call is a silent no-op
    // that looks like a broken brush, not like an error.
    const main = read("src/main.ts");
    const helperAt = main.indexOf("function refuseGroupPixels(");
    if (helperAt < 0) return "main.ts has no refuseGroupPixels() helper";
    const helper = main.slice(helperAt, helperAt + 500);
    if (!/layer\.kind\s*!==\s*"group"/.test(helper)) return "the refusal no longer tests for a group layer";
    if (!helper.includes('statusHint("Groups hold layers, not pixels")')) return "the refusal no longer names the reason";
    const calls = (main.match(/if \([^;\n]*refuseGroupPixels\(/g) ?? []).length;
    if (calls < 10) return `only ${calls} pixel entry points refuse group layers; expected at least 10`;
    for (const name of [
      "clearSelection",
      "enterTransform",
      "pourBucket",
      "contentAwareFillSelection",
      "fillWithForeground",
      "runTonalOp",
    ]) {
      const at = main.indexOf(`function ${name}(`);
      if (at < 0) return `main.ts no longer defines ${name}()`;
      const end = main.indexOf("\nfunction ", at + 1);
      const body = main.slice(at, end < 0 ? undefined : end);
      if (!body.includes("refuseGroupPixels(")) return `${name}() no longer refuses group layers`;
    }
    // A mask is its own surface: a group that owns one may be mask-painted
    // (code-r17 #4), so the refusal is conditional — but it must still guard
    // the pixel stroke, which is what this pin exists to prevent.
    if (!/const onMaskSurface = paintTarget === "mask" && !!activeLayer\.mask;/.test(main)) {
      return "the paint stroke no longer distinguishes the mask surface";
    }
    if (!/if \(!onMaskSurface && refuseGroupPixels\(activeLayer\)\) return;[\s\S]{0,500}painting = true;/.test(main)) {
      return "the paint stroke can start on a group layer";
    }
    return true;
  }],
  ["group authoring is reachable from both layer menus", () => {
    // The tree operations are unit-tested, but a missing menu entry is invisible
    // to those tests: the user would still have no way to make a group. Both the
    // Layer bar menu and the row context menu must call the shared factory.
    const main = read("src/main.ts");
    const sites = (main.match(/\.\.\.groupAuthoringItems\(/g) ?? []).length;
    if (sites < 2) return `only ${sites} layer menus offer New Group / Group Layers / Ungroup`;
    if (!main.includes("label: deleteLayerLabel(")) return "the Layer menu no longer names a group by what it takes";
    const panel = read("src/ui/layerspanel.ts");
    if (!panel.includes('layer.kind !== "group"')) return "the row rename guard still rejects groups";
    return true;
  }],
  ["the row chip is a colour tag, not a grouping action", () => {
    // Panel slice 4/6: with real groups in Layer.children, the row chip may
    // only paint a persisted tag. A pin that merely finds `layer.groupId =`
    // would pass on dead behaviour, so this one also requires the row to read
    // the tag back for its tint — and forbids the chip from touching the tree.
    const panel = read("src/ui/layerspanel.ts");
    const start = panel.indexOf("const tag = layer.groupId;");
    const end = panel.indexOf("row.appendChild(tagChip);", start);
    if (start < 0 || end < 0) return "layerspanel.ts no longer builds the colour-tag chip";
    const chip = panel.slice(start, end);
    if (!/Colour tag/.test(chip)) return "the chip no longer names itself a colour tag";
    if (!chip.includes("layer.groupId = nextId")) return "the chip no longer stores the tag it shows";
    if (!chip.includes("tagColour(")) return "the chip no longer paints itself from the tag palette";
    const grouping = /(addGroup|addLayerTo|addGroupTo|insertLayer|moveLayerTo|removeLayerFrom|children\s*=|children\.(?:push|splice|unshift))/.exec(chip);
    if (grouping) return `the colour-tag chip touches the layer tree via ${grouping[0]}`;
    if (!panel.includes("const tint = tagColour(layer.groupId)")) return "the row no longer paints the tag colour — the chip is dead behaviour";
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
  ["the page needs no dialog permission", () => {
    // Parsed rather than grepped: `permissions: []` made the old check pass
    // without looking at what was granted.
    let parsed;
    try {
      parsed = JSON.parse(caps);
    } catch (err) {
      return `capabilities/default.json is not JSON: ${err.message}`;
    }
    const granted = Array.isArray(parsed.permissions) ? parsed.permissions : [];
    const dialog = granted.filter((p) => String(p).startsWith("dialog:"));
    return dialog.length === 0 || `the webview must not hold ${dialog.join(", ")} — the Rust commands open the dialogs`;
  }],
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

  ["the desktop CSP pins the directives the app depends on", () => {
    // "some CSP exists" is satisfied by `default-src *`, which protects nothing.
    // The directives below are the ones that make the policy mean something.
    const m = /"csp":\s*"((?:[^"\\]|\\.)*)"/.exec(conf);
    if (!m) return "tauri.conf.json has no csp string — an injected script would run with the app's privileges";
    const csp = m[1].replace(/\\"/g, '"').replace(/\s+/g, " ");
    const need = ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"];
    const missing = need.filter((d) => !csp.includes(d));
    if (missing.length > 0) return `the CSP dropped ${missing.join(", ")}`;
    const script = /script-src([^;]*)/.exec(csp)?.[1] ?? "";
    if (script.includes("'unsafe-inline'")) return "script-src allows 'unsafe-inline'";
    if (script.includes("'unsafe-eval'")) return "script-src allows 'unsafe-eval'";
    return true;
  }],

  ["the release job publishes the verified folder, with pinned actions", () => {
    // Two ways this file can publish the wrong thing: point at a path that does
    // not exist (repo root is app/, so `app/release/...` matched nothing) or skip
    // the hash check and upload whatever is on disk. A mutable `uses: org/act@v4`
    // is a third: the tag can be moved to code that skips the gate.
    const wf = read(".github/workflows/release.yml");
    if (wf.includes("app/release/")) return "files: points at app/release/..., but the repo root is app/";
    if (!wf.includes("release/${{ steps.version.outputs.v }}/")) return "files: does not name the staged release folder";
    if (!wf.includes("scripts/verify-asset.mjs")) return "the publish step does not verify the bytes it uploads";
    const uses = [...wf.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    const unpinned = uses.filter((u) => !/^[^@]+@[0-9a-f]{40}$/.test(u));
    return unpinned.length === 0 || `unpinned action(s): ${unpinned.join(", ")}`;
  }],
  ["the shipped page is in the build receipt, and Publish names the tag", () => {
    // sec-r24: app-single.html is gitignored, so neither the dirty check nor
    // the receipt covered it; a post-gate overwrite shipped inside the signed
    // Setup. Publish also defaulted to github.ref, producing a release on the
    // branch name instead of the tag.
    const inputs = read("scripts/build-inputs.mjs");
    if (!inputs.includes('"app-single.html"')) return "app-single.html is outside the build receipt";
    const wf = read(".github/workflows/release.yml");
    if (!wf.includes("tag_name: v${{ steps.version.outputs.v }}")) return "Publish does not name the version tag";
    if (!wf.includes("if: startsWith(github.ref, 'refs/tags/v')")) return "Publish is not restricted to a tag";
    const rel = read("scripts/release.mjs");
    if (!rel.includes("process.env[REQUIRE_SIGNER_ENV]) {")) {
      return "a configured signer does not bind an unsigned-allowed release";
    }
    const io = read("src/engine/io.ts");
    return io.includes("bytes = base64ToBytes(t.data, TILE_BYTES);") ||
      "a project tile is allocated before its payload is decoded";
  }],

  ["a live type layer cannot be edited as pixels, and a save waits for the write", () => {
    // code-r23: four paths destroyed pixels a live type layer still owns, a save
    // cleared the dirty markers for a document that changed mid-write, and
    // autosave wrote a snapshot its reader refuses (layer count, not tiles).
    const m = read("src/main.ts");
    const need = [
      ["autosave counts layers", "layers > MAX_AUTOSAVE_LAYERS"],
      ["a save compares the revision", "const revisionAtSerialize = doc.revision;"],
      // A CRLF checkout would defeat a needle containing a bare \n, so match
      // the line pair and not the endings.
      ["Clear refuses live type", /if \(activeLayer\.textData\) \{\r?\n\s+\/\/ Delete on live type/],
      ["Cut refuses the mask chip", 'Cut works on pixels — switch the chip to Pixels first.'],
      ["nudge clips the recipe", "if (layer.textData && selMask == null) {"],
      ["Merge Down refuses a hidden below", "!upper.visible || !below.visible ||"],
    ];
    for (const [what, line] of need) {
      const found = typeof line === "string" ? m.includes(line) : line.test(m);
      if (!found) return `${what} — the guard is gone`;
    }
    return true;
  }],

  ["a focused tab keeps its own keys and passes accelerators", () => {
    // r24: the strip stopped every key, so Ctrl+S/Z/C did nothing while a tab
    // had focus — silently.
    const t = read("src/ui/tabs.ts");
    if (!t.includes('ev.key === "Enter" || ev.key === " " || ev.key === "Delete" || ev.key === "Backspace"')) {
      return "the tab strip no longer stops Backspace, which the shell treats as Delete";
    }
    if (/if \(ev\.key === "Enter"[^\n]*ev\.stopPropagation\(\);/.test(t) && !t.includes("Backspace")) {
      return "the tab strip consumes more keys than it owns";
    }
    const m = read("src/main.ts");
    if (!m.includes("const enabled = chips.filter(")) return "the options bar can focus a disabled twin";
    if (!m.includes("optionsBar.tabIndex = -1;")) return "a bar with no control drops focus to <body>";
    if (!m.includes("pop.tabIndex = -1;")) return "the help dialog has no focus target";
    return true;
  }],

  ["the release job signs the Setup before it drops the key, and the installer keeps to the profile", () => {
    // sec-r23: the certificate was removed before the installer was built, so
    // the Setup — the file winget installs — could only ship unsigned; and the
    // graphical install path skipped the scope rule the CLI already obeyed.
    const wf = read(".github/workflows/release.yml");
    const build = wf.indexOf("name: Build the installer");
    const remove = wf.indexOf("name: Remove the certificate");
    if (build < 0 || remove < 0) return "the release job lost its installer or certificate step";
    if (remove < build) return "the certificate is removed before the Setup is signed";

    const inst = read("installer/src/main.rs");
    if (!inst.includes("dir_allowed(dir)?;")) return "install() does not re-check the folder scope";
    if (!inst.includes("if let Err(message) = dir_allowed(Path::new(&dir))")) {
      return "start_install() does not check the folder scope";
    }
    if (!inst.includes("text.ends_with('.') || text.ends_with(' ')")) {
      return "a folder component may end with a dot or a space";
    }

    const verify = read("scripts/verify-asset.mjs");
    if (!verify.includes("does not list it — rerun build-setup")) {
      return "verify-asset publishes a Setup the manifest does not name";
    }

    const rel = read("scripts/release.mjs");
    return rel.includes("onDetachedReleaseTag") || "release.mjs refuses a tag checkout (detached HEAD)";
  }],

  ["every workflow action is pinned to a commit", () => {
    // release.yml was the only file checked, so ci.yml kept floating tags
    // (sec-r19 F6).
    const files = [".github/workflows/release.yml", ".github/workflows/ci.yml"];
    for (const file of files) {
      const wf = read(file);
      const uses = [...wf.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
      const unpinned = uses.filter((u) => !/^[^@]+@[0-9a-f]{40}$/.test(u));
      if (unpinned.length > 0) return `${file}: unpinned action(s): ${unpinned.join(", ")}`;
    }
    return true;
  }],
  ["the release job cannot be triggered by a tag push", () => {
    const wf = read(".github/workflows/release.yml");
    return /workflow_dispatch:/.test(wf) && !/^\s*push:/m.test(wf)
      ? true
      : "a tag push would publish a runner-built exe that is not the verified artifact";
  }],
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

  ["an already-feathered selection cannot silently re-run Select and Mask", () => {
    // AQ2's fixed point is correct engine behaviour; the UI must not present a
    // button that looks like it ran and returns the input unchanged.
    const ok = mainSrc.includes("const alreadyFeathered = selectionHasFeather(base)")
      && mainSrc.includes("ok.disabled = blocked")
      && mainSrc.includes("This selection is already feathered")
      && bundle.includes("if (ok.disabled)");
    return ok || "Select and Mask must disable OK and explain the fixed point";
  }],

  ["PSD export writes a tree only when every layer is representable", () => {
    // A record-less layer cannot be flattened on its own without changing the
    // picture: fill, clipped, pass-through and unmapped adjustments need the
    // backdrop. The product path therefore writes either a live tree or one
    // whole-document composite, and says which.
    const start = mainSrc.indexOf("function writePsdBlob");
    const end = mainSrc.indexOf("// ---- image/canvas resize", start);
    const body = start < 0 ? "" : mainSrc.slice(start, end > start ? end : undefined);
    if (!body.includes("buildPsdForExport(doc,")) return "writePsdBlob does not use the representable-tree decision";
    if (body.includes("flattenLayerPixels")) return "the isolated-layer flatten hook is back";
    const psdSrc = read("src/engine/psdexport.ts");
    if (!psdSrc.includes("export function psdLayerRepresentable(")) return "no representable predicate";
    if (!psdSrc.includes("data: doc.composite()")) return "the fallback does not write the document composite";
    if (!psdSrc.includes("no live PSD record")) return "the fallback does not explain itself";
    return true;
  }],

  ["the vendored PSD parser is the build the notices name", () => {
    // ag-psd parses hostile files, and it is the one vendored dependency: a
    // swapped bundle would ship inside the signed page without any other
    // check noticing (sec-r14 L4).
    const data = readFileSync("vendor/ag-psd-bundle.js");
    const hash = createHash("sha256").update(data).digest("hex");
    return hash === "b3927002cec64f42d80f04ea6b5af60516a942f78f41a29db7626b1e495e628a"
      ? true
      : `vendor/ag-psd-bundle.js is ${hash}, not the reviewed build`;
  }],

  ["PSD parsing asks ag-psd for a bounded memory budget", () => {
    // Handoff 9 P0.4: ag-psd's own default is 2 GiB. The explicit limit is the
    // only thing that stops a crafted header from asking for that before our
    // layer-rect guard can run.
    const main = read("src/main.ts");
    const psd = read("src/engine/psd.ts");
    // Lowered from 1.5 GiB to 768 MiB: conversion copies parsed rectangles
    // into tiles, so parse + document peaked near 3 GiB (sec-r12 #3).
    if (!psd.includes("export const PSD_MEMORY_LIMIT = 768 * 1024 * 1024")) {
      return "psd.ts does not export the 768 MiB limit";
    }
    if (!main.includes("totalMemoryLimit: PSD_MEMORY_LIMIT")) {
      return "openPsdFile does not pass the limit to ag-psd";
    }
    if (!psd.includes("guardPsdBudget(psd);")) {
      return "psdToDocument does not guard layer rectangles before allocating";
    }
    return true;
  }],

  ["a dialog can refuse to close on invalid input", () =>
    /onOk\(\) === false/.test(bundle) ||
    "validation errors used to vanish together with the dialog that held them"],

  ["mention checks only fall", () => {
    // Phase 1.3 debt meter: source-text includes and regex tests certify
    // behaviour by finding a name in the built text. Both spellings count:
    // `bundleSrc.includes(...)` and `.test(bundleSrc)`, plus the same pattern on
    // the cssNow/aboutSrc/mainSrc sources. Phase 1.1 replaced the native/chrome
    // blocks and Phase 1.2 replaced the autosave string. The overnight pass took
    // it to 63: the openAnyFile greps became the IPC replay plus a real dropped
    // file, and the alert/confirm greps became counters in the shim. The ceiling
    // is not a target: removing checks is progress; adding one is a regression
    // even if every one passes.
    const source = read("scripts/ui-smoke.mjs");
    const count = (source.match(/(?:bundle(?:Src)?|cssNow|aboutSrc|mainSrc)\.(?:includes|test)\(|\.(?:includes|test)\((?:bundle(?:Src)?|cssNow|aboutSrc|mainSrc)\b/g) ?? []).length;
    return count <= 63 || `${count} mention checks (ceiling 63) — assert the behaviour or lower the ceiling`;
  }],

  ["only Document mutates Layer.children", () => {
    // The panel and the authoring commands splice through insertLayer/
    // removeLayerFrom/moveLayerTo so the cycle guard and the ordinary list rules
    // stay in one place. A direct children.push/splice in a feature file is how
    // a tree edit bypasses both.
    const offenders = artifactInputs().filter((file) => {
      const rel = file.replaceAll("\\", "/");
      if (rel === "src/engine/document.ts" || rel.startsWith("vendor/") || rel.includes("/tests/")) return false;
      return /\.children\.(?:push|splice|unshift|pop|shift)\s*\(/.test(read(file));
    });
    return offenders.length === 0 ||
      `${offenders.join(", ")} mutate Layer.children directly; use insertLayer/removeLayerFrom/moveLayerTo`;
  }],
  ["the r26 focus and announcement contracts", () => {
    // uiux-r26: Tab dead-ended on the window strip, closing the last tab left
    // focus on <body>, a modal announced its title but not its question, the
    // lock button said "Unlock layer, pressed", and the rail's active tool was
    // invisible to a screen reader.
    const m = read("src/main.ts");
    if (!m.includes('at.closest?.("#tabs, #topbar, #statusbar")')) return "Tab dead-ends on the window strip";
    if (!m.includes('b.setAttribute("aria-pressed", String(id === tool));') &&
        !m.includes('btn.setAttribute("aria-pressed", String(id === tool));')) return "the active tool is not announced";
    const t = read("src/ui/tabs.ts");
    if (!/createUntitledTab\(\);[\s\S]{0,600}\.focus\(\)/.test(t)) return "closing the last tab drops focus";
    const d = read("src/ui/dialogs.ts");
    if (!d.includes("describe: true,")) return "a modal does not describe its question";
    if (!d.includes('panel.setAttribute("aria-describedby", body.id);')) return "the description is not linked";
    const lp = read("src/ui/layerspanel.ts");
    return lp.includes('lockBtn.setAttribute("aria-label", `${layer.name} lock`);') ||
      "the lock button's name contradicts its state";
  }],
  ["a tab is captured before it is judged, and autosave waits for its own bytes", () => {
    // code-r26 #1: `dirty` lags the document by a capture, so closing the
    // active tab could discard a stroke without prompting.
    const t = read("src/ui/tabs.ts");
    if (!t.includes("if (i === activeTab) captureTab();")) return "closeTab judges a stale dirty flag";
    const m = read("src/main.ts");
    if (!m.includes("if (editEpoch === epochAtWrite) autosaveDirty = false;")) {
      return "autosave reports saved after an edit it did not write";
    }
    if (!m.includes('if (at?.closest?.("#panels, #options, .float-win, .overlay, .color-pop, .menu-pop")) {\n      e.preventDefault();\n      return;\n    }\n    clearSelection();')) {
      return "Delete acts behind the focused panel or popover";
    }
    // code-r26 #3: a UNC prefix never reaches the string rules, and is_dir()
    // would open the share before the allow-list refuses it.
    const i = read("installer/src/main.rs");
    if (!i.includes("UNC(_, _) | VerbatimUNC(_, _) | DeviceNS(_)")) return "the installer accepts a UNC path";
    return i.includes(".filter(|p| dir_allowed(p).is_ok() && p.is_dir())") ||
      "a saved path is probed before its scope is checked";
  }]
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
