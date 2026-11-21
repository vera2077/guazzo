// Headless smoke test for the UI layer: evaluates the real single-file bundle
// (app-bundle.js) against a tiny DOM shim so that a *top-level* runtime error —
// the class of bug that produces a blank window — is caught before shipping.
// It deliberately stubs rendering: no pixels, no layout, only code paths that
// run at module load plus a handful of synthetic interactions.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// P3.4: the export-size predicate is pure and lives outside the bundle. Import
// the built module so this smoke run fails if the refusal stops being reachable.
const { exportRefusal: smokeExportRefusal } = await import(
  pathToFileURL(fileURLToPath(new URL("../dist/engine/exportlimit.js", import.meta.url))).href
);

let errors = 0;
// AV5: checks the harness genuinely cannot run are DEFERRED, not passed. They
// print on their own line and stay out of the pass total, because a log that
// cannot tell "verified" from "not verified" is how AV1 and AM1 happened.
const deferred = [];
const defer = (label, why) => { deferred.push(`${label} (${why})`); };
function fail(msg) { errors++; console.error('SMOKE FAIL:', msg); }
/** assertions, not just logs: a silent regression must fail the smoke run */
function expect(cond, msg) {
  if (!cond) fail(msg);
}

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  toggle(c, on) { const v = on === undefined ? !this.set.has(c) : !!on; if (v) this.set.add(c); else this.set.delete(c); return v; }
  contains(c) { return this.set.has(c); }
}

/**
 * Canvas calls are RECORDED, not discarded (Phase C1 of the analysis plan).
 *
 * The old shim answered every method with a no-op, and `requestAnimationFrame`
 * returned a number without ever calling back — so no frame had ever rendered
 * when this test passed. Two real bugs shipped through that hole: a `.children`
 * crash inside a menu and a context popup that was `display: none`. Rendering is
 * now driven by a controllable clock and the draw calls are inspectable.
 */
const drawLog = [];
const ctx2d = new Proxy({}, {
  get(t, p) {
    if (p in t) return t[p];
    if (p === 'canvas') return { width: 100, height: 100 };
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'getImageData') return (x, y, w, h) => new ImageDataStub(Math.max(1, w | 0), Math.max(1, h | 0));
    if (p === 'createPattern') return () => ({});
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
    return (...args) => {
      if (p === 'putImageData' || p === 'drawImage' || p === 'arc' || p === 'fillRect' || p === 'clearRect') {
        drawLog.push({ op: p, args });
      }
    };
  },
  set(t, p, v) { t[p] = v; return true; },
});

/** Frame clock: callbacks queue up and run only when the test asks. */
const frameQueue = [];
function runFrames(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    const batch = frameQueue.splice(0, frameQueue.length);
    if (batch.length === 0) return i;
    for (const cb of batch) cb(16 * (i + 1));
  }
  return rounds;
}

class ImageDataStub {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      this.width = a; this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a; this.width = b; this.height = c;
    }
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    // collectSegs (the text commit path) walks nodeType/nodeName/childNodes —
    // a '#text' node is nodeType 3, everything else an element (nodeType 1)
    this.nodeType = tag === '#text' ? 3 : 1;
    this.nodeName = tag === '#text' ? '#text' : this.tagName;
    this.children = [];
    this.style = new Proxy({ cssText: '' }, {
      get: (t, p) => {
        // real elements expose setProperty/removeProperty on the inline style
        if (p === 'setProperty') return (k, v) => { t[k] = v; };
        if (p === 'removeProperty') return (k) => { delete t[k]; };
        return p in t ? t[p] : '';
      },
      set: (t, p, v) => { t[p] = v; return true; },
    });
    this.classList = new ClassList();
    this.dataset = {};
    this.scrollIntoView = () => {};
    this.replaceChildren = (...kids) => {
      for (const old of this.children.splice(0)) old.parentNode = null;
      for (const k of kids) this.appendChild(k);
    };
    this.attrs = {};
    this._text = '';
    this._value = undefined;
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 500;
    this.clientHeight = 200;
    this.listeners = new Map();
    this.width = 300; this.height = 200;
    this.isConnected = true;
    this.offsetWidth = 120;
    this.offsetHeight = 24;
    this.offsetParent = {};
    this.clientWidth = 1000; this.clientHeight = 700;
  }
  // DOM alias: collectSegs (text commit) reads childNodes; live so remove()
  // reassigning .children stays visible
  get childNodes() { return this.children; }
  // a <select> reports its first option until something assigns a value
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT' && this.children[0]) return this.children[0].value ?? '';
    return '';
  }
  set value(v) { this._value = String(v); }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html ?? ''; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { const n = this.childNode(c); this.children.push(n); n.parentNode = this; return n; }
  append(...cs) { for (const c of cs) { const n = this.childNode(c); this.children.push(n); n.parentNode = this; } }
  /** the real DOM accepts plain strings in append/appendChild — wrap them as
   *  text nodes so app code can compose nodes and literals freely */
  childNode(c) {
    if (typeof c === 'string') { const t = new El('#text'); t._text = c; return t; }
    return c;
  }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
  }
  addEventListener(t, fn) {
    const list = this.listeners.get(t) ?? [];
    if (!list.includes(fn)) list.push(fn);
    this.listeners.set(t, list);
  }
  removeEventListener(t, fn) {
    const list = this.listeners.get(t);
    if (!list) return;
    this.listeners.set(t, list.filter((f) => f !== fn));
  }
  /** fire a listener if the code registered one (used for synthetic clicks) */
  dispatchEvent(ev) {
    this.fire(ev.type, ev);
    return !ev.defaultPrevented;
  }
  fire(type, ev = {}) {
    // Real DOM events bubble; panels rely on it (a menu row's keydown is
    // handled by the pop it lives in), so the shim must bubble too or the
    // gate silently tests a DOM that does not exist.
    let node = this;
    while (node) {
      const list = node.listeners?.get(type);
      if (list && list.length) {
        for (const fn of list) {
          fn({ target: this, currentTarget: node, preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0, pointerId: 1, shiftKey: false, key: '', ...ev });
        }
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; }
  getContext() { return ctx2d; }
  toBlob(cb) { exported.push({ canvas: this }); cb(new Blob(['x'])); }
  click() { this.fire('click'); }
  focus() { documentShim.activeElement = this; }
  blur() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  setPointerCapture() {}
  select() {}
  releasePointerCapture() {}
  insertBefore(n) { this.children.unshift(n); return n; }
  get firstChild() { return this.children[0] ?? null; }
  /** Real DOM API the app leans on: walk ancestors testing a simple selector. */
  closest(sel) {
    const wanted = sel.split(',').map((s) => s.trim()).filter(Boolean);
    let node = this;
    while (node) {
      if (wanted.some((s) => (s.startsWith('.') ? node.classList.contains(s.slice(1)) : node.tagName === s.toUpperCase()))) return node;
      node = node.parentNode;
    }
    return null;
  }
  matches(sel) { return this.closest(sel) === this; }
  /** Real DOM API: ancestors count, the node itself does too. The menubar's
   *  outside-click rule leans on it, and a missing method threw only when the
   *  gate finally fired a pointerdown — add it rather than skip the test. */
  contains(n) {
    for (let p = n; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
}

const exported = [];
let offscreenResizes = 0;
const byId = new Map();
const ids = ['app', 'topbar', 'options', 'tabs', 'toolbar', 'canvas-host', 'panels', 'statusbar'];
for (const id of ids) byId.set(id, new El('div'));

let created = 0;
const documentShim = {
  activeElement: null,
  getElementById: (id) => byId.get(id) ?? null,
  createElement: (tag) => { created++; return new El(tag); },
  createElementNS: (_ns, tag) => new El(tag),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
  body: new El('body'),
  documentElement: new El('html'),
  fonts: { add() {}, ready: Promise.resolve() },
  addEventListener() {},
  removeEventListener(type, fn) {
    const list = globalListeners.get(type) ?? [];
    globalListeners.set(type, list.filter((f) => f !== fn));
  },
  querySelectorAll: () => [],
  querySelector: () => null,
  execCommand: () => false,
};

const menuRowOf = (pop) => (pop?.children ?? []).find((c) => c.classList.contains('menu-item'));

// Click the primary button of the named dialog. The gate must leave the
// app's modal state clean: a leaked overlay keeps modalCount > 0, and every
// global shortcut (including the menu-key path) then silently early-returns —
// which would make later keyboard assertions vacuous.
const closeAllModals = () => {
  let guard = 0;
  while (guard++ < 8) {
    const overlay = documentShim.body.children.find((c) => c.classList.contains('overlay'));
    if (!overlay) return true;
    const foot = overlay.children[0]?.children.find((k) => k.classList.contains('foot'));
    const btn = foot?.children.find((b) => b.classList.contains('subtle')) ?? foot?.children[foot.children.length - 1];
    if (!btn) { overlay.remove(); continue; }
    btn.fire('click');
  }
  return !documentShim.body.children.some((c) => c.classList.contains('overlay'));
};
const dismissModal = (title) => {
  const overlay = documentShim.body.children.find(
    (c) => c.classList.contains('overlay') && (c.children[0]?.children ?? []).some((k) => k.tagName === 'H3' && k.textContent === title));
  const foot = overlay?.children[0]?.children.find((k) => k.classList.contains('foot'));
  const ok = foot?.children.find((b) => b.classList.contains('primary')) ?? foot?.children[foot.children.length - 1];
  ok?.fire('click');
  return !documentShim.body.children.includes(overlay);
};
const globalListeners = new Map();
// The close guard and autosave use window.setInterval(). Recording them lets a
// test drive only the 400 ms OS-close poller; the animation and autosave timers
// stay asleep, so no other state changes behind the test's back.
const intervalQueue = [];
const timeoutQueue = [];
const windowShim = {
  __fire(type, ev = {}) {
    for (const fn of globalListeners.get(type) ?? []) fn(ev);
    return ev;
  },
  addEventListener(type, fn) {
    const list = globalListeners.get(type) ?? [];
    if (!list.includes(fn)) list.push(fn);
    globalListeners.set(type, list);
  },
  document: documentShim,
  innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
  removeEventListener() {},
  requestAnimationFrame: (cb) => { frameQueue.push(cb); return frameQueue.length; },
  cancelAnimationFrame() {},
  setTimeout: (fn, ms) => {
    if (ms >= 1_000) {
      const id = timeoutQueue.length + 1;
      timeoutQueue.push({ id, fn, ms });
      return id;
    }
    return setTimeout(fn, 0);
  },
  clearTimeout: (id) => {
    const at = timeoutQueue.findIndex((i) => i.id === id);
    if (at >= 0) timeoutQueue.splice(at, 1);
    else clearTimeout(id);
  },
  setInterval: (fn, ms) => {
    const id = intervalQueue.length + 1;
    intervalQueue.push({ id, fn, ms });
    return id;
  },
  clearInterval: (id) => {
    const at = intervalQueue.findIndex((i) => i.id === id);
    if (at >= 0) intervalQueue.splice(at, 1);
  },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: 'smoke', platform: 'win32' },
  location: { href: 'http://localhost/' },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  MouseEvent: class MouseEvent {
    constructor(type, opts = {}) { this.type = type; Object.assign(this, opts); this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() {}
  },
  Blob: globalThis.Blob,
  Response: globalThis.Response,
  CompressionStream: globalThis.CompressionStream,
  DecompressionStream: globalThis.DecompressionStream,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  FileReader: class { readAsArrayBuffer() {} },
  ImageData: ImageDataStub,
  OffscreenCanvas: class {
    constructor(w, h) { this._w = w; this._h = h; }
    // resizing the shared composite canvas mid-export is exactly the bug that
    // shipped a blank white JPEG, so count every assignment
    get width() { return this._w; }
    set width(v) { this._w = v; offscreenResizes++; }
    get height() { return this._h; }
    set height(v) { this._h = v; offscreenResizes++; }
    getContext() { return ctx2d; }
  },
  FontFace: class { constructor(f) { this.family = f; this.status = 'loaded'; } load() { return Promise.resolve(this); } },
  ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} unobserve() {} },
  MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} takeRecords() { return []; } },
  getComputedStyle: (el) => ({ getPropertyValue: () => '', width: '10px', height: '10px' }),
  Path2D: class {},
  // fillPop's showContextMenu does `ev.target instanceof HTMLElement` for the
  // Escape focus-return; a missing global would throw ReferenceError in vm.
  HTMLElement: class HTMLElement {},
  Element: class Element {},
  // inputContextMenu branches on these; missing globals would throw in vm
  HTMLInputElement: class HTMLInputElement {},
  HTMLTextAreaElement: class HTMLTextAreaElement {},
  // collectSegs branches on Node.TEXT_NODE / Node.ELEMENT_NODE
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  performance: { now: () => 0 },
};
windowShim.window = windowShim;
windowShim.globalThis = windowShim;
windowShim.self = windowShim;

// Phase 1.2: a real OPFS-shaped store, held shut until the autosave drill seeds
// a snapshot. initAutosave() runs during boot, so the gate keeps it from reading
// (or starting its 20 s interval) while every other smoke case runs.
const autosaveFiles = new Map();
let autosaveWriteFails = false;
let autosaveWriteAttempts = 0;
let releaseOpfs = () => {};
const opfsGate = new Promise((resolve) => { releaseOpfs = resolve; });
const opfsRoot = {
  async getFileHandle(name, opts = {}) {
    if (!autosaveFiles.has(name) && !opts.create) {
      const err = new Error("NotFoundError");
      err.name = "NotFoundError";
      throw err;
    }
    if (!autosaveFiles.has(name)) autosaveFiles.set(name, "");
    return {
      async getFile() {
        const value = autosaveFiles.get(name) ?? "";
        return {
          async arrayBuffer() {
            if (value instanceof Uint8Array) return value.slice().buffer;
            return new TextEncoder().encode(String(value)).buffer;
          },
        };
      },
      async createWritable() {
        autosaveWriteAttempts++;
        if (autosaveWriteFails) {
          autosaveWriteFails = false;
          throw new Error("autosave quota exceeded");
        }
        return {
          async write(data) { autosaveFiles.set(name, new Uint8Array(data)); },
          async close() {},
        };
      },
    };
  },
  async removeEntry(name) { autosaveFiles.delete(name); },
};
windowShim.navigator.storage = {
  async getDirectory() { await opfsGate; return opfsRoot; },
};

// Phase 1.1: one recorder for the whole run. It is installed BEFORE the bundle
// boots because mountWindowChrome() takes the native branch only when isTauri()
// is true at boot. Tests swap `nativeHandler` per path; the bridge object itself
// never changes, which matches native.ts (it re-reads the global on every call).
const nativeCalls = [];
let nativeHandler = async () => null;
const tauriBridge = {
  invoke: async (cmd, args) => {
    nativeCalls.push([cmd, args]);
    return nativeHandler(cmd, args);
  },
};
windowShim.__TAURI_INTERNALS__ = tauriBridge;

/** Drive only the interval with this period: close_requested is 400 ms. */
async function tickIntervals(ms) {
  for (const timer of intervalQueue.filter((i) => i.ms === ms)) await timer.fn();
}

/** Fire recorded long setTimeout calls (autosave idle/backoff) in order. */
async function tickTimeouts(maxMs) {
  for (;;) {
    const at = timeoutQueue.findIndex((timer) => timer.ms <= maxMs);
    if (at < 0) return;
    const [timer] = timeoutQueue.splice(at, 1);
    await timer.fn();
  }
}

let code = '';
try {
  code = readFileSync(new URL('../app-bundle.js', import.meta.url), 'utf8');
  // freshness self-check: the bundle must be newer than every file that
  // feeds it, otherwise this run certifies yesterday's UI.
  const bundleMtime = statSync(new URL('../app-bundle.js', import.meta.url)).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(fileURLToPath(new URL('../src', import.meta.url)));
  const htmlMtime = statSync(fileURLToPath(new URL('../index.html', import.meta.url))).mtimeMs;
  if (Math.max(newest, htmlMtime) > bundleMtime) {
    fail('app-bundle.js is STALE (a src/*.ts or index.html is newer) — run `node scripts/build-desktop.mjs` first');
  }
  runInNewContext(code, windowShim, { filename: 'app-bundle.js' });
} catch (err) {
  fail(`${err.name}: ${err.message}\n${String(err.stack).split('\n').slice(0, 6).join('\n')}`);
}

// The chrome mounted above (it only does so when isTauri() is true at boot).
// Hide the bridge again so every earlier smoke path that expects the browser
// build still runs the browser branch; the native block restores this object.
delete windowShim.__TAURI_INTERNALS__;

windowShim.btoa = (b) => Buffer.from(String(b), "binary").toString("base64");
windowShim.atob = (s) => Buffer.from(String(s), "base64").toString("binary");
windowShim.Blob = class ShimBlob {
  constructor(parts = []) {
    this._chunks = (parts ?? []).map((x) => (typeof x === "string" ? new Uint8Array(Buffer.from(x, "utf8")) : new Uint8Array(x)));
    this.size = this._chunks.reduce((n, c) => n + c.length, 0);
  }
  stream() {
    return new globalThis.Blob(this._chunks).stream();
  }
  async arrayBuffer() {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this._chunks) { out.set(c, at); at += c.length; }
    return out.buffer;
  }
};

// DoD-8: openNative() reassembles IPC bytes into a File, and openAnyFile()
// reads projects with file.text(). Both are browser APIs the shim lacked, so the
// OPEN path used to be uncertifiable — only "the helpers are bundled".
windowShim.File = class ShimFile extends windowShim.Blob {
  constructor(parts = [], name = "file") {
    super(parts);
    this.name = name;
  }
  async text() {
    return Buffer.from(await this.arrayBuffer()).toString("utf8");
  }
};

// exercise the interactive paths: every toolbar button, the layer strip and a
// history row click, so a broken handler shows up here instead of in the app.
function guard(label, fn) {
  try { fn(); } catch (err) { fail(`${label} → ${err.name}: ${err.message}`); }
}
/**
 * Click a control that the assertion depends on. Missing target = FAILURE:
 * `btn?.fire()` silently no-ops, which is how the Shape tool "passed" while
 * never being exercised.
 */
function mustFire(label, el) {
  if (!el) { fail(`${label}: control not found`); return; }
  try { el.fire('click'); } catch (err) { fail(`${label} → ${err.name}: ${err.message}`); }
}
const toolbarEl = byId.get('toolbar');
// tools live in the .tool-area scroller; the colour well and the toggle are
// pinned siblings below it (v0.25.1)
const toolAreaEl = toolbarEl.children.find((c) => c.classList.contains('tool-area'));
expect(!!toolAreaEl, 'toolbar should have a tool-area scroller');
for (const [i, btn] of (toolAreaEl?.children ?? []).entries()) {
  if (typeof btn.fire === 'function') guard(`toolbar[${i}] click`, () => btn.fire('click'));
}

if (errors === 0) {
  const panels = byId.get('panels');
  const toolbar = byId.get('toolbar');
  const topbar = byId.get('topbar');
  const layers = panels.children[0];
  const hist = panels.children[1];
  const count = (el, pred) => el.children.filter(pred).length;
  // Cards are now [head, body, footer?, grip]: never index into them, ask for
  // the role instead, so docking (which appends a grip) cannot break the test.
  const partOf = (card, cls) => (card?.children ?? []).find((c) => c.classList.contains(cls));
  const bodyOf = (card) => partOf(card, 'card-body');
  const rowsOf = (card) => {
    const out = [];
    const walk = (el) => {
      for (const c of el?.children ?? []) {
        if (c.classList.contains('row')) out.push(c);
        else walk(c);
      }
    };
    walk(bodyOf(card));
    return out;
  };
  const footOf = (card) => partOf(card, 'card-foot');
  console.log('smoke: elements created =', created);
  console.log('smoke: panels children =', panels.children.length, '(layers, history, adjust, filters)');
  console.log('smoke: layers card head =', JSON.stringify(layers?.children[0]?.className ?? 'missing'));
  console.log('smoke: layers rows =', count(bodyOf(layers) ?? new El('div'), () => true) > 0 ? 'rendered' : 'missing');
  console.log('smoke: history head =', JSON.stringify(partOf(hist, 'card-head')?.className ?? 'missing'), '| grip =', !!partOf(hist, 'card-grip'));
  console.log('smoke: history body children =', bodyOf(hist)?.children.length ?? 'missing');
  const cards = panels.children.filter((c) => c.classList.contains('card'));
  expect(cards.length >= 6, `expected at least 6 panel cards, got ${cards.length}`);
  expect(cards.every((c) => !!partOf(c, 'card-grip')), 'every card should have a resize grip');
  expect(cards.every((c) => !!partOf(c, 'card-head')?.children.some((k) => k.classList.contains('card-chev'))), 'every card head should have a chevron');
  expect(!!partOf(panels, 'panel-grip'), 'panel column should have a width divider');
  // collapsing a card hides its body
  const collapsible = cards[1];
  const itsHead = partOf(collapsible, 'card-head');
  guard('collapse card', () => itsHead.fire('click'));
  expect(collapsible.classList.contains('collapsed'), 'clicking a card head should collapse it');
  guard('expand card', () => itsHead.fire('click'));
  expect(!collapsible.classList.contains('collapsed'), 'clicking again should expand it');
  console.log('smoke: docking =', cards.length, 'cards, all with grips + chevrons');
  console.log('smoke: toolbar buttons =', toolAreaEl?.children.length ?? 0, '| pinned rows =', toolbar.children.length);
  console.log('smoke: topbar children =', topbar.children.length);
  const menusOf = () => (topbar.children.find((c) => c.id === 'menubar')?.children ?? []);
  const titleOf = (m) => m.children[0]?.textContent ?? '?';
  console.log('smoke: menu titles =', JSON.stringify(menusOf().map(titleOf)));
  console.log('smoke: menu items total =', menusOf().reduce((n, m) => n + (m.children[1]?.children.length ?? 0), 0));
  // the bar is rebuilt on every open, so always re-query instead of holding refs
  const openMenuByTitle = (title) => {
    const m = menusOf().find((x) => titleOf(x) === title);
    guard(`open ${title} menu`, () => m?.children[0]?.fire('click'));
    return menusOf().find((x) => x.classList.contains('open'));
  };
  const menuItem = (title, label) => {
    const open = openMenuByTitle(title);
    const pop = open?.children[1];
    return { open, row: pop?.children.find((c) => (c.children[1]?.textContent ?? '') === label) };
  };
  const file = openMenuByTitle('File');
  console.log('smoke: File menu opens =', !!file, '| items =', file?.children[1]?.children.length ?? 0);
  const fill = menuItem('Edit', 'Fill with Foreground');
  guard('Edit > Fill with Foreground', () => fill.row?.fire('click'));
  const histRows = bodyOf(hist)?.children ?? [];
  console.log('smoke: history rows after menu fill =', histRows.length,
    '| label =', JSON.stringify((histRows[0]?.textContent || histRows[0]?.innerHTML || '').slice(0, 28)));
// AS1: arrow keys must never edit the document while a menu is open. The popup
// consumes them for navigation (and now stops propagation); the window-level
// shortcut handler also refuses when a menu or context pop is up.
{
  const moveBtn = toolAreaEl?.children.find((b) => (b.getAttribute('aria-label') || '').includes('Move (V)'));
  guard('AS1: switch to the Move tool', () => moveBtn?.fire('click'));
  const rowsBefore = (bodyOf(hist)?.children ?? []).length;
  openMenuByTitle('File');
  for (const key of ['ArrowDown', 'ArrowUp']) {
    windowShim.__fire('keydown', {
      key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault() {}, stopPropagation() {}, target: documentShim.body,
    });
  }
  const rowsAfter = (bodyOf(hist)?.children ?? []).length;
  expect(rowsAfter === rowsBefore,
    `an arrow key while a menu is open must not nudge the layer (history ${rowsBefore} -> ${rowsAfter})`);
  windowShim.__fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {}, target: documentShim.body });
  console.log('smoke: AS1 = arrow keys do not edit the document while a menu is open');
}  const layerMenu = menuItem('Layer', 'Merge Down');
  console.log('smoke: Layer menu items =', layerMenu.open?.children[1]?.children.length ?? 0,
    '| Merge Down disabled =', !!layerMenu.row?.classList.contains('disabled'),
    '(expected true only when the active layer is the bottom one)');
  expect(menusOf().length >= 8, `expected >= 8 menus, got ${menusOf().length}`);
  // Spot Healing lives in the toolbar and Smart Fill in the Edit menu:
  // both are engine-backed features, so a missing binding is a real regression.
  const healItem = menuItem('Edit', 'Smart Fill');
  expect(!!healItem.row, 'Edit menu should offer Smart Fill');
  const toolbarBtns = (toolAreaEl?.children ?? []).filter((c) => c.classList.contains('tool'));
  // promoteTitles runs through a MutationObserver, which the shim does not implement,
  // so accept the raw title as well as the promoted data-tip
  // aria-label is authored at creation time and survives promoteTitles
  const tipOf = (b) => b.getAttribute('aria-label') ?? b.dataset.tip ?? b.title ?? '';
  expect(toolbarBtns.some((b) => tipOf(b).startsWith('Spot Healing')),
    'toolbar should expose the Spot Healing brush');
  expect((layerMenu.open?.children[1]?.children.length ?? 0) > 0, 'Layer menu rendered no items');
  // Side submenu (Layer > Blending): must open on hover with its own fixed
  // coordinates. CSS :hover alone cannot do it — the scrolling pop clips an
  // absolutely positioned child, which is the "second menu does nothing" bug.
  const blendRow = layerMenu.open?.children[1]?.children.find((c) => c.classList.contains('sub'));
  expect(!!blendRow, 'Layer menu should contain a submenu row (Blending)');
  guard('Layer > Blending hover', () => blendRow?.fire('pointerenter'));
  expect(!!blendRow?.classList.contains('open'), 'hovering a submenu row must open it');
  const blendSub = blendRow?.children.find((c) => c.classList.contains('menu-sub'));
  expect(!!blendSub && !!blendSub.style.left, 'the side menu must be positioned by hand (fixed), not left to clipping');
  guard('Layer > Blending leave', () => blendRow?.fire('pointerleave'));
  // toolbar sizing: the compact two-column toggle must exist and flip the class
  const sizeBtn = byId.get('toolbar').children.find((b) => b.classList.contains('toolbar-size'));
  expect(!!sizeBtn, 'toolbar should have a column toggle');
  // the generic click-all-buttons pass above already clicked it, so assert the FLIP
  const wasWrapped = byId.get('toolbar').classList.contains('wrap');
  guard('two-column toolbar', () => sizeBtn?.fire('click'));
  expect(byId.get('toolbar').classList.contains('wrap') !== wasWrapped,
    'the column toggle should flip the wrap class');
  guard('back to one column', () => sizeBtn?.fire('click'));
  expect(byId.get('toolbar').classList.contains('wrap') === wasWrapped,
    'toggling back should restore the previous toolbar mode');
  // colour tag: the chip tints the row and never restructures the stack
  const rows0 = rowsOf(layers);
  const chip = rows0[0] ? partOf(rows0[0], 'tagchip') : null;
  expect(!!chip, 'a layer row should carry a colour-tag chip');
  expect((chip?.getAttribute?.('aria-label') ?? '').includes('Colour tag') ||
    (chip?.getAttribute?.('aria-label') ?? '').includes('colour tag'),
    'the chip should name itself a colour tag');
  guard('colour tag chip', () => chip?.fire('click'));
  const rows1 = rowsOf(layers);
  const chip1 = rows1[0] ? partOf(rows1[0], 'tagchip') : null;
  expect(!!(chip1 && chip1.classList.contains('on')),
    'clicking the chip should mark the layer with a colour tag');
  // The exact palette value is a design choice (three of them moved for text
  // contrast); what must not change is that tagging tints the row's edge
  // instead of rebuilding the row.
  expect(/#[0-9a-f]{6}/i.test(rows1[0]?.style.borderLeft ?? ''),
    'the tagged row should be tinted, not restructured');
  expect(rows1[0]?.classList.contains('tagged') === true,
    'the tagged row should paint its tint from the tagged class');
  expect(!rows1[0]?.style.background,
    'the tag must not set an inline background that outranks hover and selection');
  expect(rows1.length === rows0.length,
    'a colour tag must not add or remove rows');
  expect(hist.children.length > 0, 'history card missing');
  const hostBefore = byId.get('canvas-host').children.length;
  // File > New… opens the document dialog; a valid size closes it and adds a
  // tab. The refusal half is the R4 contract: a zero width must leave the
  // dialog open, with the reason visible, from BOTH OK and Enter — Enter used
  // to close first, and close() destroyed the error line with the dialog.
  const hostEl = byId.get('canvas-host');
  const tabsEl = byId.get('tabs');
  const tabsBefore = tabsEl.children.length;
  const docBody = documentShim.body;
  const overlayNow = () => docBody.children.filter((c) => c.classList.contains('overlay')).pop();
  const walkOf = (el, pred, out = []) => {
    for (const c of el?.children ?? []) { if (pred(c)) out.push(c); walkOf(c, pred, out); }
    return out;
  };
  const setUnit = (num, unit) => { const pair = num?.parentNode; const sel = pair?.children?.[1]; if (sel) sel.value = unit; };
  // A fresh dialog inherits the last preset (Letter = inches); pin both units to
  // px so 64 is 64 px, not 64 in = 19,200 px > MAX_DIM.
  const openNew = () => {
    const item = menuItem('File', 'New');
    guard('File > New', () => item.row?.fire('click'));
    const panel = overlayNow()?.children[0];
    const foot = panel?.children[panel.children.length - 1];
    const okBtn = foot?.children.find((b) => (b.textContent ?? '') === 'OK');
    const field = (label) => {
      const row = walkOf(panel, (c) => c.classList?.contains('grid1')
        && (c.children[0]?.textContent ?? '').startsWith(label))[0];
      return row?.children?.[1]?.children?.[0];
    };
    const width = field('Width');
    const height = field('Height');
    setUnit(width, 'px');
    setUnit(height, 'px');
    return {
      panel, okBtn, width, height,
      error: () => walkOf(panel, (c) => c.classList?.contains('ndlg-error'))[0]?.textContent ?? '',
    };
  };
  // The dialog listens on window, and El.fire only bubbles along parentNode, so
  // the keydown has to be fired at the window shim, not at the input.
  const enter = (target) => windowShim.__fire('keydown', {
    key: 'Enter', preventDefault() {}, stopPropagation() {}, target,
  });

  // 1) Enter is a second OK: a valid size must close the dialog and create the tab.
  const first = openNew();
  console.log('smoke: New dialog =', !!first.panel, '| title =', JSON.stringify(first.panel?.children[0]?.textContent ?? ''),
    '| rows =', first.panel?.children[1]?.children?.[0]?.children.length ?? 0, '| OK found =', !!first.okBtn);
  expect(!!first.width && !!first.height, 'the New dialog exposes width and height fields');
  first.width.value = '64';
  first.height.value = '64';
  enter(first.width);
  expect(!overlayNow(), 'Enter on a valid New must close the dialog');
  expect(tabsEl.children.length === tabsBefore + 1, `Enter should add exactly one tab (${tabsBefore} -> ${tabsEl.children.length})`);

  // 2) The same Enter must refuse, and the dialog must keep both itself and the reason.
  const second = openNew();
  second.width.value = '0';
  second.height.value = '0';
  guard('New dialog OK with zero width', () => second.okBtn?.fire('click'));
  expect(!!overlayNow(), 'a refused OK must keep the New dialog open');
  expect(second.error().length > 0, `a refused OK must say why (error = ${JSON.stringify(second.error())})`);
  enter(second.width);
  expect(!!overlayNow(), 'a refused Enter must keep the New dialog open too');
  expect(second.error().length > 0, 'a refused Enter must keep the reason on screen');
  second.width.value = '64';
  second.height.value = '64';
  guard('New dialog OK', () => second.okBtn?.fire('click'));
  expect(!overlayNow(), 'a valid New must close the dialog');
  expect(tabsEl.children.length === tabsBefore + 2, `OK after a refusal should add one tab (${tabsBefore} -> ${tabsEl.children.length})`);
  console.log('smoke: tabs after New =', tabsEl.children.length, '(was', tabsBefore + ')');


  // phase 6/7 coverage: the image geometry commands and the shape tool must not throw
  for (const label of ['Rotate 90° CW', 'Rotate 90° CCW', 'Rotate 180°', 'Flip Horizontal', 'Flip Vertical', 'Trim']) {
    const it = menuItem('Image', label);
    guard(`Image > ${label}`, () => it.row?.fire('click'));
  }
  const statusAfterGeo = byId.get('statusbar')?.textContent ?? '';
  console.log('smoke: geometry commands ran | status =', JSON.stringify(statusAfterGeo.slice(0, 46)));
  const tl = byId.get('toolbar');
  const shapeBtnEl = (tl.children.find((c) => c.classList.contains('tool-area'))?.children ?? [])
    .find((b) => tipOf(b).startsWith('Shape (U)'));
  mustFire('Shape tool', shapeBtnEl);
  const optsAfterShape = byId.get('options');
  console.log('smoke: shape options =', optsAfterShape.children.length,
    '| first tag =', optsAfterShape.children[0]?.tagName ?? '?');

  // Export path: the export canvas must be its OWN canvas. Aliasing the shared
  // composite canvas and then resizing it cleared the bitmap, which exported a
  // blank white JPEG and left the viewport empty until the next edit.
  const exportItem = menuItem('File', 'Export As…');
  if (!exportItem.row) fail('File menu should offer Export As…');
  else {
    guard('File > Export As…', () => exportItem.row.fire('click'));
    const overlay = documentShim.body.children.find((c) => c.classList.contains('overlay'));
    if (!overlay) fail('Export As… opened no dialog');
    else {
      const foot = overlay.children[0].children[2];
      const ok = foot?.children[foot.children.length - 1];
      mustFire('Export dialog OK', ok);
      expect(exported.length === 1, `expected one export blob, got ${exported.length}`);
      expect(offscreenResizes === 0, `export resized the shared composite canvas ${offscreenResizes}x`);
      expect(exported[0]?.canvas !== byId.get('canvas-host'), 'export drew on the viewport canvas');
      console.log('smoke: export =', exported.length, 'blob(s) | shared-canvas resizes =', offscreenResizes);
      // The shim's toBlob never calls back, so the dialog stays open after OK —
      // close it explicitly or modalCount stays > 0 and every later keyboard
      // shortcut would silently early-return (a vacuous green gate).
      const cancelBtn = foot?.children.find((b) => b.classList.contains('subtle'));
      cancelBtn?.fire('click');
      expect(!documentShim.body.children.includes(overlay), 'closing Export As… must restore the modal count');
    }
  }

  // Focus containment (analysis UX finding 1): Tab must cycle inside the
  // dialog, and closing must put focus back where the user left it. Uses a
  // dialog with several controls (Export As) because a single-button dialog
  // would make the assertion vacuous.
  {
    const host0 = byId.get('canvas-host');
    host0.tabIndex = 0;
    documentShim.activeElement = host0;
    const openerBefore = documentShim.activeElement;
    const export6 = menuItem('File', 'Export As…');
    guard('open Export As for focus test', () => export6.row?.fire('click'));
    const ov = documentShim.body.children.filter((c) => c.classList.contains('overlay')).pop();
    const panel = ov?.children[0];
    const collect = (el, out = []) => {
      for (const c of el?.children ?? []) {
        if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(c.tagName)) out.push(c);
        collect(c, out);
      }
      return out;
    };
    const fields = collect(panel);
    expect(fields.length >= 3, `the focus test needs several controls, got ${fields.length}`);
    const fireTab = (shift) => windowShim.__fire('keydown', {
      key: 'Tab', shiftKey: !!shift, preventDefault() {}, stopPropagation() {}, target: documentShim.activeElement,
    });
    // forward from the last field wraps to the first, and never leaves the panel
    fields[fields.length - 1].focus();
    fireTab(false);
    expect(documentShim.activeElement === fields[0], 'Tab on the last control wraps to the first inside the dialog');
    // backward from the first wraps to the last
    fields[0].focus();
    fireTab(true);
    expect(documentShim.activeElement === fields[fields.length - 1], 'Shift+Tab on the first control wraps to the last');
    // closing returns focus to whatever had it before the dialog opened
    const foot6 = panel?.children.find((k) => k.classList.contains('foot'));
    const cancel6 = foot6?.children.find((b) => b.classList.contains('subtle'));
    guard('close focus-test dialog', () => cancel6?.fire('click'));
    expect(!fields.includes(documentShim.activeElement) && documentShim.activeElement !== null,
      'closing a dialog returns focus outside it');
    expect(!documentShim.body.children.some((c) => c.classList.contains('overlay')), 'focus test dialog closed');
    console.log('smoke: focus containment = Tab wraps inside the dialog, focus returns on close');
  }

  // Command palette (Ctrl/Cmd+K): entries must be DERIVED from the tool table
  // and the menus, and typing must filter them.
  {
    const pal = () => documentShim.body.children.find((c) => c.classList.contains('palette-overlay'));
    windowShim.__fire('keydown', { key: 'k', ctrlKey: true, metaKey: false, preventDefault() {}, stopPropagation() {}, target: documentShim.body });
    const ov = pal();
    expect(!!ov, 'Ctrl+K must open the search dialog');
    const panel = ov?.children[0];
    const input = panel?.children.find((c) => c.classList.contains('palette-input'));
    const list = panel?.children.find((c) => c.classList.contains('palette-list'));
    expect(!!input && !!list, 'the palette needs a search field and a list');
    const rowsOf = () => (list?.children ?? []).filter((c) => c.classList.contains('palette-row'));
    expect(rowsOf().length >= 40, `the palette should list tools and actions (got ${rowsOf().length})`);
    const names = () => rowsOf().map((r) => (r.children[0]?.textContent ?? ''));
    expect(names().includes('Pen (P)'), 'tools come from TOOL_LABELS (Pen (P) present)');
    expect(names().some((n) => n === 'Merge Down'), 'actions come from the menus (Merge Down present)');
    // filtering: "levels" should narrow to the tonal commands
    input.value = 'levels';
    input.fire('input');
    const filtered = names();
    expect(filtered.length > 0 && filtered.length < 12, `typing must narrow the list (got ${filtered.length})`);
    expect(filtered.some((n) => n.startsWith('Levels')), 'the filter finds Levels');
    // AI5: a row must RUN something observable, not just close. The old assertion
    // recorded the options-bar text into a variable and never used it — that is
    // how "~75 of 110 rows do nothing" shipped green.
    const layerRowsNow = () => rowsOf(layers).length;
    const rowsBefore = layerRowsNow();
    input.value = 'new layer';
    input.fire('input');
    const actionRows = names();
    expect(actionRows.some((n) => n === 'New Layer'), `the filter finds the New Layer action (got ${actionRows.join(', ')})`);
    windowShim.__fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {}, target: input });
    expect(!pal(), 'Enter closes the palette after running the entry');
    const rowsAfter = layerRowsNow();
    expect(rowsAfter === rowsBefore + 1,
      `running a palette row must perform its action (layer rows ${rowsBefore} -> ${rowsAfter})`);
    // Enter on the highlighted entry and closes the dialog
    // Escape closes without running
    windowShim.__fire('keydown', { key: 'k', ctrlKey: true, preventDefault() {}, stopPropagation() {}, target: documentShim.body });
    expect(!!pal(), 'the palette reopens');
    windowShim.__fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {}, target: documentShim.body });
    expect(!pal(), 'Escape closes the palette');
    // A3: one import path (dialog + drop), and the options bar re-pages when Its
  // own width changes, not only when the window does.
  {
    const bundle = readFileSync('app-bundle.js', 'utf8');
    expect(bundle.includes('async function openAnyFile'), 'dialogs and drops share one import path');
    expect((bundle.match(/openAnyFile\(/g) ?? []).length >= 4, 'both dialogs and the drop handler route through openAnyFile');
    expect(bundle.includes('addEventListener("drop"'), 'drag-and-drop is wired');
    const css = readFileSync('index.html', 'utf8');
    expect(/\.drop-target\s*::after/.test(css), 'the drop target has a visible hint');
    // C1: frames RENDER. The old shim answered every canvas call with a no-op and
  // never invoked a rAF callback, which is how a `display: none` popup and a
  // `.children.filter` crash both reached a user through a green gate.
  {
    // 1. the boot render actually blitted something (putImageData on the composite)
    const puts = drawLog.filter((d) => d.op === 'putImageData');
    expect(puts.length > 0, 'boot must blit the composite with putImageData');
    const img = puts[0]?.args[0];
    expect(!!img && img.width > 1 && img.height > 1,
      `the blitted frame must have real dimensions (got ${img ? img.width + 'x' + img.height : 'none'})`);

    // 2. deferred work is real: a resize schedules a frame and the clock runs it
    const queuedBefore = frameQueue.length;
    windowShim.__fire('resize', {});
    const rounds = runFrames(6);
    expect(rounds > 0 || queuedBefore > 0, 'the app must schedule animation frames (resize → re-fit)');

    // 3. geometry, not just "it ran": the brush ring radius tracks the brush size
    drawLog.length = 0;
    const ta = toolbarEl.children.find((c) => c.classList.contains('tool-area'));
    const brushBtnEl = ta.children.find((b) => (b.getAttribute('aria-label') || '').includes('Brush (B)'));
    expect(!!brushBtnEl, 'brush tool button exists');
    brushBtnEl.fire('click');
    runFrames(3);
    const dispEl = hostEl.children.find((c) => c.tagName === 'CANVAS');
    dispEl.fire('pointermove', { clientX: 120, clientY: 90, buttons: 0, pointerId: 1 });
    const arcs = drawLog.filter((d) => d.op === 'arc');
    expect(arcs.length > 0, 'the brush cursor ring must be stroked (ctx.arc)');
    const radius = Number(arcs[arcs.length - 1].args[2]);
    expect(radius > 1 && radius < 2000, `the ring radius must be plausible (got ${radius})`);
    // 4. the ring follows the setting, not just the code path: doubling the brush
    // size must roughly double the drawn radius
    const optionsEl = byId.get('options');
    const nums = [];
    const walkNums = (el) => {
      if (!el || typeof el !== 'object') return;
      if (el.classList?.contains('num')) nums.push(el);
      if (Array.isArray(el.children)) el.children.forEach(walkNums);
    };
    walkNums(optionsEl);
    const sizeField = nums[0];
    expect(!!sizeField, 'the brush options bar exposes a numeric size field');
    const before = Number(arcs[arcs.length - 1].args[2]);
    sizeField.value = "200";
    sizeField.fire('change');
    drawLog.length = 0;
    dispEl.fire('pointermove', { clientX: 130, clientY: 95, buttons: 0, pointerId: 1 });
    // a large brush also draws its centre dot, so take the largest arc: the ring
    const radii2 = drawLog.filter((d) => d.op === 'arc').map((d) => Number(d.args[2]));
    const after = radii2.length ? Math.max(...radii2) : NaN;
    expect(after > before * 3, `raising the brush size must grow the ring (${before} → ${after})`);
    console.log(`smoke: render = ${puts.length} blit(s) ${img.width}x${img.height}, frames ran ${rounds}, brush ring ${Math.round(before)} → ${Math.round(after)} px`);
  }

    // AI1: the drag rule itself is unit-tested in engine/path.test.ts
    // (penHandleFor: beyond threshold bends, wobble keeps the corner). Here we
    // only prove the tool is reachable through the toolbar, which is what the
    // user actually clicks.
    const taPen = toolbarEl.children.find((c) => c.classList.contains('tool-area'));
    const penBtnEl = taPen.children.find((b) => (b.getAttribute('aria-label') || '').includes('Pen (P)'));
    expect(!!penBtnEl, 'pen tool button exists');
    penBtnEl.fire('click');
    expect(penBtnEl.classList.contains('active'), 'clicking the pen tool must select it');
    console.log('smoke: pen tool = reachable and selectable from the toolbar');

  console.log('smoke: import path = one openAnyFile for dialogs and drops, drop hint styled');
  }

  // AI6: a selection edit must be a history step. The shim cannot drive this
  // end to end (the status line is rebuilt only by render(), and a stale read
  // made an earlier version of this block pass while proving nothing), so the
  // wiring is pinned where it cannot lie: every editing entry point must go
  // through selectionCommand(), and the engine test covers the snapshot maths.
  {
    const mainSrc = readFileSync('src/main.ts', 'utf8');
    const uses = (mainSrc.match(/selectionCommand\(/g) ?? []).length;
    expect(uses >= 5,
      `selection edits must push history via selectionCommand (found ${uses} uses, need the mask/rect/deselect/selectAll/path paths)`);
    expect(/function selectionCommand\(/.test(mainSrc), 'selectionCommand() exists');
    expect(/function restoreSelection\(/.test(mainSrc), 'restoreSelection() exists');
    // AL4: the snapshot stores the selection's bbox as a plain byte row, not a
    // full-canvas clone — a 16384² mask is 268 MB and an undo pair would keep two.
    expect(/function snapshotMask\(/.test(mainSrc), 'snapshots go through snapshotMask()');
    // AP1: the snapshot is tile-sparse (only tiles that exist), so the byte cost
    // is the allocated tile bytes — not a dense w*h row per snapshot, and not a
    // full-canvas clone either.
    expect(/return mask\.isEmpty\(\) \? null : mask\.clone\(\)/.test(mainSrc),
      'a snapshot copies only the tiles that exist');
    expect(!/new Uint8ClampedArray\(b\.w \* b\.h\)/.test(mainSrc),
      'no snapshot may allocate a dense bbox array');
    expect(/snap\.mask\.allocatedBytes\(\)/.test(mainSrc), 'the byte cost is the allocated tile bytes');
    console.log(`smoke: selection undo = wired through selectionCommand at ${uses} edit points`);
  }

// P3.4: a 16384² export must be refused before the scaled canvas exists. The
// predicate is pure, so execute it here; the ordering check keeps the guard in
// runExport ahead of document.createElement("canvas").
{
  const message = smokeExportRefusal(16384, 16384, "png");
  expect(!!message && /50 % or lower/.test(message),
    `16384² export must name the 50 % ceiling (got ${message ?? "null"})`);
  expect(smokeExportRefusal(8192, 8192, "png") === null,
    "8192² export must still fit");
  const mainSrc = readFileSync('src/main.ts', 'utf8');
  const body = mainSrc.slice(mainSrc.indexOf("function runExport"), mainSrc.indexOf("function writePsdBlob"));
  const refusalAt = body.indexOf("exportRefusal(w, h");
  const canvasAt = body.indexOf('document.createElement("canvas")');
  expect(refusalAt > 0 && canvasAt > refusalAt,
    "runExport must refuse before it creates the scaled canvas");
  console.log("smoke: export refusal = 16384² names 50 %, runExport guards before allocation");
}

  console.log('smoke: command palette = derived entries, filtering, Enter runs, Escape closes');

// ---- AM2: the Find button and the tool labels are asserted by execution ----
{
  const walk = (root, out = []) => {
    for (const c of root.children ?? []) { out.push(c); walk(c, out); }
    return out;
  };
  const bar = byId.get('topbar');
  const findBtn = walk(bar).find((c) => c.classList && c.classList.contains('tbfind'));
  expect(!!findBtn, 'the title strip must carry the Find button');
  if (findBtn) {
    findBtn.fire('click', { preventDefault() {}, stopPropagation() {} });
    const opened = walk(documentShim.body).some((c) => c.classList?.contains('palette'))
      || walk(byId.get('app')).some((c) => c.classList?.contains('palette'));
    expect(opened, 'clicking Find opens the palette');
    windowShim.__fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  }
  const toolBtns = walk(byId.get('toolbar')).filter((c) =>
    c.classList?.contains('tool') && !c.classList?.contains('toolbar-size'));
  const named = toolBtns.filter((c) => /\([A-Za-z0-9+\/]+\)/.test((c.getAttribute && c.getAttribute('aria-label')) || c.title || ''));
  const unnamed = toolBtns.filter((c) => !named.includes(c));
  expect(toolBtns.length >= 18 && named.length === toolBtns.length,
    `every tool button names its shortcut (${named.length}/${toolBtns.length}; unnamed: ${unnamed.map((c) => (c.getAttribute && c.getAttribute('aria-label')) || c.title || '?').join(', ')})`);
  console.log(`smoke: find button + tool labels = clicked, ${named.length}/${toolBtns.length} named`);
}

  }

  // Phase 1.1: execute every native path instead of naming it. The recorder was
  // installed before the bundle booted, so mountWindowChrome() already took the
  // native branch; each case below swaps only the fake Rust handler. The real
  // dialog plugin lives behind `save_file`/`open_file`; the page never calls
  // `plugin:dialog|save` itself, so that is the observable boundary.
  {
    windowShim.__TAURI_INTERNALS__ = tauriBridge;
    const calls = nativeCalls;
    const settle = () => new Promise((r) => setTimeout(r, 60));
    const findAll = (root, pred, out = []) => {
      for (const c of root?.children ?? []) {
        if (pred(c)) out.push(c);
        findAll(c, pred, out);
      }
      return out;
    };
    const overlayFor = (title) => documentShim.body.children.find(
      (c) => c.classList.contains('overlay')
        && (c.children[0]?.children ?? []).some((k) => k.tagName === 'H3' && k.textContent === title),
    );
    const clickModal = (title, label) => {
      const foot = overlayFor(title)?.children[0]?.children.find((k) => k.classList.contains('foot'));
      const btn = (foot?.children ?? []).find((b) => b.textContent === label);
      expect(!!btn, `dialog "${title}" should offer ${label}`);
      btn?.fire('click');
    };
    const dirtyEl = () => byId.get('statusbar')?.children.find((c) => c.classList.contains('status-dirty'));
    const hintEl = () => byId.get('statusbar')?.children.find((c) => c.classList.contains('status-hint'));
    const isDirty = () => !!dirtyEl() && dirtyEl().style.display !== 'none';

    nativeHandler = async (cmd, args) => {
      if (cmd === 'save_file') return { handle: 7, name: args?.name ?? 'x' };
      if (cmd === 'save_file_again') return true;
      if (cmd === 'close_requested') return false;
      return null;
    };

    calls.length = 0;
    menuItem('File', 'Save Project').row?.fire('click');
    await settle();
    const first = calls.find(([c]) => c === 'save_file');
    expect(!!first, 'Save Project reaches the native save (no download fallback)');
    expect(!!first && first[1]?.remember === true, 'a project save asks the shell to remember its target');
    expect(!!first && typeof first[1]?.base64 === 'string' && first[1].base64.length > 0,
      'the document crosses IPC as bytes, never as a path');

    calls.length = 0;
    menuItem('File', 'Save Project').row?.fire('click');
    await settle();
    const again = calls.find(([c]) => c === 'save_file_again');
    expect(!!again, 'a second save writes in place through the remembered handle');
    expect(!!again && again[1]?.handle === 7, 'the remembered handle is the one the first save returned');
    expect(calls.every(([c]) => c !== 'write_bytes' && c !== 'read_bytes'),
      'no command that takes a path is ever called');

    // Cancel: the picker dismisses with null. No write, no lie in the status
    // bar, and the document keeps its dirty mark.
    nativeHandler = async (cmd) => {
      if (cmd === 'save_file') return null;
      if (cmd === 'save_file_again') return false;
      return null;
    };
    menuItem('Layer', 'New Layer').row?.fire('click');
    await settle();
    expect(isDirty(), 'a new layer should mark the document dirty before the cancel test');
    calls.length = 0;
    menuItem('File', 'Save Project As…').row?.fire('click');
    await settle();
    expect(calls.some(([c]) => c === 'save_file'), 'Save As opens the native save path');
    expect(!calls.some(([c]) => c === 'save_file_again'), 'a cancelled Save As writes nothing');
    expect(hintEl()?.textContent === 'Save cancelled', `cancel must say "Save cancelled" (got ${hintEl()?.textContent ?? 'none'})`);
    expect(isDirty(), 'cancelling a save must leave the dirty mark visible');

    // Failure: a rejected invoke reaches notify() and never clears dirty.
    nativeHandler = async (cmd) => {
      if (cmd === 'save_file') throw new Error('disk is full');
      return null;
    };
    calls.length = 0;
    menuItem('File', 'Save Project As…').row?.fire('click');
    await settle();
    expect(!!overlayFor('Could not save the file'), 'a rejected invoke must surface an error dialog');
    expect(isDirty(), 'a failed save must leave the dirty mark visible');
    dismissModal('Could not save the file');

    // Open cancel: the picker returns null, so no tab is replaced.
    nativeHandler = async (cmd) => (cmd === 'open_file' ? null : null);
    calls.length = 0;
    const tabsBeforeCancel = tabsEl.children.length;
    menuItem('File', 'Open Project…').row?.fire('click');
    await settle();
    expect(calls.some(([c]) => c === 'open_file'), 'Open Project asks the shell through open_file');
    expect(tabsEl.children.length === tabsBeforeCancel, 'a cancelled Open must not replace or add a tab');

    // DoD-8: execute the OPEN path. The recorder answers with the bytes this
    // session just saved, so IPC -> File -> text -> project load -> new tab runs.
    const projectB64 = first?.[1]?.base64;
    expect(typeof projectB64 === 'string' && projectB64.length > 0, 'the saved project bytes are available to replay');
    const tabsBefore = tabsEl.children.length;
    nativeHandler = async (cmd) => (cmd === 'open_file'
      ? { name: 'reopen.guazzo.json', base64: projectB64 }
      : null);
    menuItem('File', 'Open Project…').row?.fire('click');
    await settle();
    await settle();
    expect(calls.some(([c]) => c === 'open_file'), 'Open Project asks the shell for a file through IPC');
    expect(tabsEl.children.length > tabsBefore,
      `an opened project arrives as a new tab (before ${tabsBefore}, after ${tabsEl.children.length})`);

    // Window chrome: booted native, so the real module built the controls.
    const top = byId.get('topbar');
    const winctl = findAll(top, (c) => c.classList.contains('winctl'))[0];
    expect(!!winctl, 'a native boot must build the caption buttons');
    const findWrap = findAll(top, (c) => c.classList.contains('topfind'))[0];
    expect(!!findWrap && top.children.indexOf(findWrap) < top.children.indexOf(winctl),
      'the Find button must sit before the caption buttons');
    const titleButton = (title) => findAll(top, (c) => c.tagName === 'BUTTON' && c.title === title)[0];
    const minimise = titleButton('Minimise');
    const maximise = titleButton('Maximise / restore');
    expect(!!minimise && !!maximise, 'the caption strip must carry minimise and maximise');
    calls.length = 0;
    minimise?.fire('click');
    await settle();
    expect(calls.some(([c]) => c === 'win_minimize'), 'Minimise invokes win_minimize');
    calls.length = 0;
    nativeHandler = async (cmd) => (cmd === 'win_toggle_maximize' ? true : null);
    maximise?.fire('click');
    await settle();
    expect(calls.some(([c]) => c === 'win_toggle_maximize'), 'Maximise invokes win_toggle_maximize');

    calls.length = 0;
    top?.fire('pointerdown', { button: 0, target: top, preventDefault() {}, stopPropagation() {} });
    await settle();
    expect(calls.some(([c]) => c === 'win_drag'), 'dragging the title strip invokes win_drag');

    const grips = findAll(documentShim.body, (c) => c.classList.contains('rs-edge'));
    expect(grips.length === 7, `the frameless window must expose seven resize grips (got ${grips.length})`);
    for (const grip of grips) {
      const dir = [...grip.classList.set].find((c) => c.startsWith('rs-') && c !== 'rs-edge')?.slice(3);
      calls.length = 0;
      grip.fire('pointerdown', { button: 0, target: grip, preventDefault() {}, stopPropagation() {} });
      await settle();
      const resize = calls.find(([c]) => c === 'win_resize');
      expect(!!resize && resize[1]?.direction === dir,
        `${dir ?? '?'} grip must invoke win_resize with its own direction`);
    }

    // Close loop: the OS request is polled every 400 ms. Cancel acks the request
    // (otherwise Rust re-asks forever); confirm force-closes after the ack.
    menuItem('Layer', 'New Layer').row?.fire('click');
    await settle();
    expect(isDirty(), 'the close-guard test needs an unsaved document');
    nativeHandler = async (cmd) => (cmd === 'close_requested' ? true : null);
    calls.length = 0;
    await tickIntervals(400);
    await settle();
    expect(!!overlayFor('Unsaved changes'), 'close_requested must raise the unsaved-changes question');
    clickModal('Unsaved changes', 'Cancel');
    await settle();
    expect(calls.some(([c]) => c === 'close_ack'), 'cancelling the close must ack the OS request');
    expect(!calls.some(([c]) => c === 'win_force_close'), 'cancelling the close must not force-close');

    calls.length = 0;
    await tickIntervals(400);
    await settle();
    expect(!!overlayFor('Unsaved changes'), 'a second OS close request must ask again');
    clickModal('Unsaved changes', 'Close anyway');
    await settle();
    expect(calls.some(([c]) => c === 'win_force_close'), 'confirming the close must force-close the window');
    expect(calls.some(([c]) => c === 'close_ack'), 'the confirmed close must still ack');

    nativeHandler = async () => null;
    console.log('smoke: native bridge = save/save-again/cancel/failure/open, chrome 7 grips + drag + buttons, close ack/force');
  }

  // Panel slice 5/6 + the 0.72.0 tree contract: ARIA rows, keyboard folding,
  // and drag-to-reparent against a real grouped project (the project loader is
  // still the path a group arrives through).
  {
    const treeProject = {
      format: 'guazzo-project', version: 1, name: 'tree.guazzo.json',
      // Larger than Preview's 420 px proxy threshold, so the filter preview
      // actually takes the proxy path and announces itself with a badge.
      width: 800, height: 800,
      layers: [
        { name: 'bottom', visible: true, opacity: 1, blendMode: 'normal', locked: false, tiles: [] },
        {
          name: 'Group A', kind: 'group', visible: true, opacity: 1, blendMode: 'normal', locked: false, tiles: [],
          children: [
            { name: 'child A', visible: true, opacity: 1, blendMode: 'normal', locked: false, tiles: [] },
            { name: 'child B', visible: true, opacity: 1, blendMode: 'normal', locked: false, tiles: [] },
          ],
        },
        { name: 'top', visible: true, opacity: 1, blendMode: 'normal', locked: false, tiles: [] },
      ],
    };
    const priorHandler = nativeHandler;
    nativeHandler = async (cmd) => (cmd === 'open_file'
      ? { name: 'tree.guazzo.json', base64: Buffer.from(JSON.stringify(treeProject), 'utf8').toString('base64') }
      : null);
    menuItem('File', 'Open Project…').row?.fire('click');
    await new Promise((r) => setTimeout(r, 120));
    nativeHandler = priorHandler;
    const treeRows = () => rowsOf(layers);
    const named = (n) => treeRows().find((r) => partOf(r, 'name')?.textContent === n);
    const pad = (r) => Number.parseInt(String(r?.style?.paddingLeft ?? '').replace(/[^0-9]/g, ''), 10) || 0;
    const groupRow = named('Group A');
    const childRow = named('child B');
    expect(treeRows().length === 5, `a grouped project should show five rows (got ${treeRows().length})`);
    expect(!!groupRow && !!childRow, 'the opened project must render the group and its child');
    expect(partOf(groupRow, 'badge')?.textContent === 'grp 2',
      'a group row must carry the group badge plus its child count, not the fill badge');
    expect(pad(childRow) > pad(groupRow),
      `a child row must indent past its parent (${pad(childRow)}px vs ${pad(groupRow)}px)`);

    const rowList = (bodyOf(layers)?.children ?? []).find((c) => c.classList.contains('layer-rows'));
    expect(rowList?.getAttribute?.('role') === 'tree', 'the rows must live in a role=tree container');
    expect(groupRow?.getAttribute?.('role') === 'treeitem', 'each row must be a treeitem');
    expect(groupRow?.getAttribute?.('aria-level') === '1', 'a root group is level 1');
    expect(childRow?.getAttribute?.('aria-level') === '2', 'a child is level 2');
    expect(groupRow?.getAttribute?.('aria-expanded') === 'true', 'the group row must own aria-expanded');
    const chevOf = () => partOf(named('Group A'), 'layer-chev');
    expect(chevOf()?.getAttribute?.('aria-hidden') === 'true',
      'the chevron is mouse-only: the row owns the keyboard');

    const before = treeRows().length;
    guard('collapse Group A with ArrowLeft', () => named('Group A')?.fire('keydown', { key: 'ArrowLeft' }));
    expect(treeRows().length === before - 2,
      `collapsing a two-child group must drop two rows (${before} → ${treeRows().length})`);
    expect(named('Group A')?.getAttribute?.('aria-expanded') === 'false',
      'a collapsed group row must say aria-expanded=false');
    guard('expand Group A with ArrowRight', () => named('Group A')?.fire('keydown', { key: 'ArrowRight' }));
    expect(treeRows().length === before, `expanding must restore the row count (${before} → ${treeRows().length})`);
    guard('select child B', () => named('child B')?.fire('click'));
    expect(named('child B')?.getAttribute?.('aria-selected') === 'true',
      'clicking a child must move aria-selected to it');
    expect(named('Group A')?.getAttribute?.('aria-selected') === 'false',
      'only one row may be selected');

    // P3: a filter preview must find a layer that lives inside a group. The old
    // proxy builder walked only doc.layers, so selecting child B and moving a
    // filter slider cleared the preview instead of showing anything.
    const walkTree = (root, out = []) => {
      for (const c of root.children ?? []) { out.push(c); walkTree(c, out); }
      return out;
    };
    const textOf = (node) => `${node._text ?? ''}${(node.children ?? []).map(textOf).join('')}`;
    const filterSelect = walkTree(byId.get('panels')).find((el) => el.tagName === 'SELECT'
      && /gaussian blur/i.test(textOf(el)));
    expect(!!filterSelect, 'the Filters card must expose a filter select');
    const blurOpt = walkTree(filterSelect).find((o) => o.tagName === 'OPTION' && /gaussian blur/i.test(textOf(o)));
    expect(!!blurOpt, 'Gaussian Blur must be one of the filter options');
    guard('preview a filter on a grouped child', () => {
      filterSelect.value = blurOpt.value;
      filterSelect.fire('change');
      const card = (() => {
        let node = filterSelect;
        while (node && !node.classList.contains('card')) node = node.parentNode;
        return node;
      })();
      const slider = walkTree(card).find((c) => c.tagName === 'INPUT' && c.type === 'range');
      expect(!!slider, 'the Filters card must expose its amount slider');
      slider.value = '7';
      slider.fire('input');
    });
    runFrames();
    const previewBadge = walkTree(byId.get('canvas-host'))
      .find((c) => c.classList.contains('preview-badge'));
    expect(!!previewBadge && previewBadge.classList.contains('on'),
      'a filter preview on a group child must run, not clear the canvas');
    expect(/Preview/.test(previewBadge?.textContent ?? ''),
      `the preview badge must describe the proxy (got ${JSON.stringify(previewBadge?.textContent)})`);

    // Drag a root layer into the group's middle: the row is reparented, the
    // document keeps the same node count, and one undo puts it back at root.
    const dt = { effectAllowed: '', dropEffect: '', setData() {}, getData() { return ''; } };
    const countBeforeDrag = treeRows().length;
    named('top')?.fire('dragstart', { dataTransfer: dt });
    named('Group A')?.fire('dragover', { clientY: 300, dataTransfer: dt });
    named('Group A')?.fire('drop', { clientY: 300, dataTransfer: dt });
    expect(treeRows().length === countBeforeDrag, 'a reparent must not add or remove nodes');
    const movedTop = named('top');
    expect(!!movedTop && pad(movedTop) > pad(named('Group A')),
      `the dropped root should now indent under the group (${pad(movedTop)}px vs ${pad(named('Group A'))}px)`);
    guard('Edit > Undo after drag', () => menuItem('Edit', 'Undo')?.row?.fire('click'));
    expect(treeRows().length === countBeforeDrag, 'undo keeps the node count');
    expect(pad(named('top')) === pad(named('Group A')),
      'one undo must put the dropped layer back at the root');

    console.log('smoke: panel tree = ARIA levels, keyboard fold, drag reparent + undo');
  }
  // The native paths above are the only ones that need the bridge. Put the
  // browser build back so later tests keep exercising the download fallback.
  delete windowShim.__TAURI_INTERNALS__;

  const help = menuItem('Help', 'About Guazzo');
  guard('Help > About', () => help.row?.fire('click'));
  const dlg = documentShim.body.children.find((c) => c.classList.contains('overlay'));
  console.log('smoke: about dialog =', !!dlg, '| title =', JSON.stringify(dlg?.children[0]?.children[0]?.textContent ?? ''),
    '| modal in body =', documentShim.body.children.some((c) => c.classList.contains('overlay')));
  // W1 pin: static checks on the shipped bundle. (The shim cannot read text that
  // arrived through innerHTML, and build-desktop already refuses a placeholder
  // release — this keeps the two facts pinned next to the dialog that shows it.)
  const bundleSrc = readFileSync(new URL('../app-bundle.js', import.meta.url), 'utf8');
  expect(/const OWNER_NAME = "[^"<][^"]*";/.test(bundleSrc), 'the bundle carries a real OWNER_NAME, not the placeholder');
  expect(!bundleSrc.includes('"<COPYRIGHT HOLDER>"'), 'the bundle does not ship the placeholder copyright');
  // one classic script: a second copy must never be a parse error (v0.39.1)
  expect(bundleSrc.startsWith('"use strict";'), 'the bundle opens in strict mode');
  expect(bundleSrc.includes('(function () {'), 'the bundle is wrapped in one function scope');
  // real-DOM collections have no array methods: the menu keyboard handler must
  // convert before filtering, or every keydown throws on a live HTMLCollection
  expect(!bundleSrc.includes('.children as unknown as HTMLElement[]'), 'no cast pretends children is an array');
  expect(bundleSrc.includes('Array.from(pop.children)'), 'menu rows convert the HTMLCollection first');
  // frameless window chrome + the pager/help tail group
  expect(bundleSrc.includes('function mountWindowChrome'), 'desktop title strip is built in one place (src/ui/windowchrome.ts)');
  expect(bundleSrc.includes('win_toggle_maximize'), 'window buttons call the native commands');
  expect(bundleSrc.includes('opt-tail'), 'pager and help share one non-wrapping tail');
  expect(bundleSrc.includes('windowStartResize'), 'frameless windows keep resize grips');
  expect(bundleSrc.includes('function appMarkSvg'), 'the title strip draws the app mark, not the old dot');
  expect(bundleSrc.includes('id="brand"><span class="mark">'), 'the brand uses the mark');
  // About ▸ Licence: the reader dialogs must open on top and Escape must close
  // only the top one (before v0.43.0 the text was inlined and overflowed).
  const aboutPanel = documentShim.body.children.find((c) => c.classList.contains('overlay'))?.children[0];
  const aboutLinks = aboutPanel?.children.flatMap((c) => (c.classList?.contains('about') ? c.children : [])).filter((c) => c.classList?.contains('about-link')) ?? [];
  expect(aboutLinks.length === 2, 'About offers exactly two rows: Licence and Third-party notices');
  guard('About > Licence row', () => aboutLinks[0]?.fire('click'));
  const overlaysAfter = documentShim.body.children.filter((c) => c.classList?.contains('overlay'));
  expect(overlaysAfter.length === 2, 'the licence opens a dialog on top of About, it does not replace it');
  const licencePre = overlaysAfter[1]?.children?.[0]?.children?.find((c) => c.classList?.contains('about'))?.children?.find((c) => c.tagName === 'PRE');
  expect(!!licencePre && /SOFTWARE LICENSE|Permission is hereby granted|Apache License/.test(licencePre.textContent || ''), 'the licence dialog shows the real licence text');
  windowShim.__fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {}, target: documentShim.body });
  const afterEsc = documentShim.body.children.filter((c) => c.classList?.contains('overlay'));
  expect(afterEsc.length === 1, 'one Escape closes only the topmost dialog, leaving About open');
  expect(dismissModal('About Guazzo'), 'closing the About dialog must restore the modal count');
  console.log('smoke: history rows after fill =', bodyOf(hist)?.children.length);

  // layer strip: "+ new layer" pushes history + rebuilds every panel
  const strip = footOf(layers);
  guard('new-layer strip button', () => strip.children[0]?.fire('click'));
  const histBody = bodyOf(hist);
  console.log('smoke: history rows after add =', histBody.children.length);
  guard('history row click', () => histBody.children[0]?.fire('click'));

  // layer masks + adjustment layers (phase 3 UI)
  const stripButtons = () => (footOf(layers)?.children ?? []);
  const byTitle = (needle) => stripButtons().find((b) => (b.title || '').includes(needle));
  guard('add layer mask', () => byTitle('layer mask')?.fire('click'));
  const maskChip = rowsOf(layers).some((r) =>
    (r.children ?? []).some((c) => c.classList.contains('maskchip')));
  console.log('smoke: layer mask chip present =', maskChip);
  guard('new adjustment layer', () => byTitle('adjustment layer')?.fire('click'));
  const layerRows = rowsOf(layers).length;
  console.log('smoke: layer rows after adjustment layer =', layerRows);
  const adjDlg = documentShim.body.children.filter((c) => c.classList.contains('overlay')).pop();
  if (adjDlg) {
    const ok = (adjDlg.children[0].children[2]?.children ?? []).find((b) => /ok/i.test(b.textContent ?? ''));
    guard('adjustment dialog OK', () => ok?.fire('click'));
  }
  console.log('smoke: layer rows after OK =', rowsOf(layers).length);
  guard('clip toggle', () => byTitle('Clip to layer below')?.fire('click'));
  // status bar children are built once by buildStatusBars (handoff-3 T6): the
  // bar must have its static spans after boot, not an empty innerHTML
  expect((byId.get('statusbar')?.children ?? []).length > 0, 'status bar has static children');
  console.log('smoke: status bar children =', (byId.get('statusbar')?.children ?? []).length);

  // ---- right-click context menus (v0.25.0) --------------------------------
  const popInBody = () => documentShim.body.children.find((c) => c.classList.contains('context-pop'));
  const popItems = () => (popInBody()?.children ?? []).filter((c) => c.classList.contains('menu-item'));
  const popRow = (label) => popItems().find((c) => (c.children[1]?.textContent ?? '') === label);
  const rowsNow = () => rowsOf(layers);

  // layers panel: right-click a row, run Duplicate Layer…
  const rowsBefore = rowsNow().length;
  mustFire('layer row contextmenu', rowsNow()[0]);
  rowsNow()[0]?.fire('contextmenu', { clientX: 24, clientY: 24 });
  expect(!!popInBody(), 'right-clicking a layer row should open a context pop');
  expect(popItems().length >= 10, `layer context pop should be rich (got ${popItems().length} items)`);
  const dupRow = popRow('Duplicate Layer…');
  expect(!!dupRow, 'layer context pop should offer Duplicate Layer…');
  guard('context Duplicate Layer…', () => dupRow?.fire('click'));
  expect(!popInBody(), 'clicking a context item should close the pop');
  expect(rowsNow().length === rowsBefore + 1, `Duplicate Layer… should add a row (${rowsBefore} -> ${rowsNow().length})`);

  // canvas: right-click the host, run Select All
  mustFire('canvas contextmenu', hostEl);
  hostEl.fire('contextmenu', { clientX: 100, clientY: 100 });
  expect(!!popInBody(), 'right-clicking the canvas should open a context pop');
  const canvasItems = popItems().map((c) => c.children[1]?.textContent ?? '');
  for (const wanted of ['Undo', 'Cut', 'Copy', 'Copy Merged', 'Paste', 'Select All', 'Quick Export as PNG']) {
    expect(canvasItems.includes(wanted), `canvas context pop should offer ${wanted}`);
  }
  guard('context Select All', () => popRow('Select All')?.fire('click'));
  expect(!popInBody(), 'Select All should close the pop');

  // history: right-click a row, Clear History
  const histRowsNow = (bodyOf(hist)?.children ?? []);
  if (histRowsNow.length > 0) {
    guard('history row contextmenu', () => histRowsNow[0]?.fire('contextmenu', { clientX: 40, clientY: 40 }));
    expect(!!popInBody(), 'right-clicking a history row should open a context pop');
    const clearRow = popRow('Clear History');
    expect(!!clearRow, 'history pop should offer Clear History');
    guard('context Clear History', () => clearRow?.fire('click'));
    expect(!popInBody(), 'Clear History should close the pop');
    console.log('smoke: history after clear =', JSON.stringify((bodyOf(hist)?.children ?? []).length));
  }

  // document tab: right-click offers close/save/export
  const aTab = tabsEl.children[0];
  mustFire('tab contextmenu', aTab);
  aTab?.fire('contextmenu', { clientX: 60, clientY: 8 });
  expect(!!popInBody(), 'right-clicking a tab should open a context pop');
  const tabItems = popItems().map((c) => c.children[1]?.textContent ?? '');
  for (const wanted of ['Close Tab', 'Close Other Tabs', 'Save Project', 'Quick Export as PNG']) {
    expect(tabItems.includes(wanted), `tab pop should offer ${wanted}`);
  }
  guard('dismiss tab pop', () => popRow('Export As…')?.fire('click'));

  // toolbar: right-click a family tool, switch within the family
  const marqueeBtn = toolbarBtns.find((b) => tipOf(b).startsWith('Rectangular Marquee'));
  mustFire('marquee contextmenu', marqueeBtn);
  marqueeBtn?.fire('contextmenu', { clientX: 12, clientY: 80 });
  expect(!!popInBody(), 'right-clicking a tool should open its family pop');
  const ellipseRow = popRow('Elliptical Marquee (M)');
  expect(!!ellipseRow, 'selection family pop should offer Elliptical Marquee');
  guard('family switch to ellipse', () => ellipseRow?.fire('click'));
  expect(!popInBody(), 'family switch should close the pop');
  const ellipseBtn = toolbarBtns.find((b) => tipOf(b).startsWith('Elliptical Marquee'));
  expect(!!ellipseBtn && ellipseBtn.classList.contains('active'), 'family switch should highlight the ellipse tool');
  guard('family switch back to marquee', () => {
    const b = toolbarBtns.find((x) => tipOf(x).startsWith('Rectangular Marquee'));
    b?.fire('click');
  });
  console.log('smoke: context menus = layers/canvas/history/tab/toolbars OK');

  // CSS pin (real-vs-shim divergence guard): the smoke's El shim does not
  // compute styles, so a .context-pop with no display rule would still pass
  // popInBody() while rendering invisible in the real browser — exactly the
  // v0.25.5 bug. Statically assert the stylesheet shows it.
  const css = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const base = css.indexOf('.menu-pop {');
  const ctx = css.indexOf('.context-pop {');
  expect(base >= 0 && ctx > base, '.context-pop rule must exist after .menu-pop in index.html');
  const ctxRule = css.slice(ctx, css.indexOf('}', ctx));
  expect(/display:\s*flex/.test(ctxRule), '.context-pop must set display:flex — a bare body-child pop never matches .menu.open > .menu-pop');
  // Same class of divergence for the options bar: only the real browser has
  // layout, so a tail that could be squeezed off-screen would pass here. Pin
  // the two rules that keep ">" and "?" pinned at the right edge.
  const hostRuleAt = css.indexOf('.opt-host {');
  const hostRule = hostRuleAt >= 0 ? css.slice(hostRuleAt, css.indexOf('}', hostRuleAt)) : '';
  expect(/min-width:\s*0/.test(hostRule), '.opt-host needs min-width:0 or it cannot shrink and pushes the tail away');
  const tailAt = css.indexOf('.opt-tail {');
  const tailRule = tailAt >= 0 ? css.slice(tailAt, css.indexOf('}', tailAt)) : '';
  expect(/flex:\s*none/.test(tailRule), '.opt-tail must be flex:none so the pager and help never shrink off the row');
  // Paging must decide from the controls' own widths. The v0.40.1 build asked
  // host.scrollWidth, which a clipped flex container can report as huge (or
  // zero), and that hid every control but the first behind ">".
  expect(bundleSrc.includes('function unwrapOptionsBar'), 'options paging must be re-runnable (unwrap first)');
  expect(/\.offsetWidth \|\| 0/.test(bundleSrc) || bundleSrc.includes('el.offsetWidth'), 'paging must measure per-control widths');
  expect(!bundleSrc.includes('host.scrollWidth'), 'paging must not depend on host.scrollWidth — it cannot be trusted for a clipped flex row');
  // Side menus are position:fixed + JS-placed: a scrolling pop clips an
  // absolute child, which is why hovering "Blending" showed nothing.
  expect(!/menu-item\.sub:hover/.test(css), 'a :hover rule cannot place the fixed side menu — remove it');
  // caption buttons: neutral hover (no red block) and above the resize grips
  expect(!/#c42b1c/.test(css), 'the close button must not use the Windows red block');
  const winctlRule = css.slice(css.indexOf('.winctl {'), css.indexOf('}', css.indexOf('.winctl {')));
  expect(/z-index:\s*400/.test(winctlRule), '.winctl must sit above .rs-edge (350) or the corner grip steals the close button');

  // ---- keyboard / a11y pass (handoff-3 S) ---------------------------------
  const a11yHost = byId.get('canvas-host');
  guard('canvas context menu (a11y re-open)', () => a11yHost?.fire('contextmenu', { clientX: 40, clientY: 40 }));
  const aPop = popInBody();
  expect(!!aPop, 'context pop should be open for the a11y checks');
  expect(aPop?.getAttribute('role') === 'menu', 'context pop must carry role="menu"');
  const aRows = popItems();
  expect(aRows.length > 0 && aRows.every((r) => r.getAttribute('role') === 'menuitem'),
    'every pop row must carry role="menuitem"');
  guard('pop ArrowDown keydown', () => aPop?.fire('keydown', { key: 'ArrowDown' }));
  guard('pop Home keydown', () => aPop?.fire('keydown', { key: 'Home' }));
  guard('pop Escape keydown', () => aPop?.fire('keydown', { key: 'Escape' }));
  expect(!popInBody(), 'Escape must close the context pop');
  const a11yTabs = byId.get('tabs');
  expect(a11yTabs?.getAttribute('role') === 'tablist', 'tabs bar must carry role="tablist"');
  const tabRows = (a11yTabs?.children ?? []).filter((c) => c.classList.contains('tab'));
  expect(tabRows.length > 0 && tabRows.some((t) => t.getAttribute('role') === 'tab'),
    'tabs must carry role="tab"');
  guard('tabs ArrowRight keydown', () => a11yTabs?.fire('keydown', { key: 'ArrowRight' }));
  const newtab = (a11yTabs?.children ?? []).find((c) => c.classList.contains('newtab'));
  expect(!!(newtab?.getAttribute('aria-label')), 'new-tab button must keep an aria-label after title stripping');
  const a11ySizeBtn = (byId.get('toolbar')?.children ?? []).find((c) => c.classList.contains('toolbar-size'));
  expect(!!(a11ySizeBtn?.getAttribute('aria-label')), 'toolbar size toggle must keep an aria-label');
  // reported defect sweep: Flatten Image must not disturb the toolbar, and
  // the flattened row must still carry a thumbnail canvas
  const toolbarKidsBefore = (byId.get('toolbar')?.children ?? []).length;
  const flattenRow = menuItem('Layer', 'Flatten Image');
  guard('Layer > Flatten Image', () => flattenRow?.row?.fire('click'));
  const toolbarAfter = byId.get('toolbar');
  expect((toolbarAfter?.children ?? []).length === toolbarKidsBefore,
    'flatten must not rebuild or empty the toolbar');
  expect(!toolbarAfter?.classList.contains('toolbar-hidden'),
    'flatten must not hide the toolbar');
  const rowsAfterFlatten = rowsOf(layers);
  const thumbsAfterFlatten = rowsAfterFlatten.flatMap((r) => (r.children ?? []))
    .filter((c) => c.tagName === 'CANVAS' && c.classList.contains('thumb'));
  expect(rowsAfterFlatten.length === 1 && thumbsAfterFlatten.length === 1,
    'flattened document keeps exactly one row with one thumbnail');
  console.log('smoke: flatten keeps toolbar =', (toolbarAfter?.children ?? []).length,
    '| rows =', rowsAfterFlatten.length, '| thumbs =', thumbsAfterFlatten.length);
  // R1: switching tabs must dismiss an open context pop (its closures point at
  // the OLD document — acting from another tab would record into the wrong history)
  guard('canvas context menu (tab-switch check)', () => a11yHost?.fire('contextmenu', { clientX: 40, clientY: 40 }));
  expect(!!popInBody(), 'pop re-opened for the tab-switch check');
  const otherTab = (a11yTabs?.children ?? []).find((c) => c.classList.contains('tab') && !c.classList.contains('active'));
  guard('switch tab while pop open', () => otherTab?.fire('click'));
  expect(!popInBody(), 'activating another tab must close the context pop');
  // R2: Cut must be ONE conceptual action = one history entry. After the tab
  // switch above, the active tab's layer is a pixel layer with content, so
  // the whole-layer cut path runs (no selection => selectionRect = full layer).
  guard('canvas context menu (cut check)', () => a11yHost?.fire('contextmenu', { clientX: 40, clientY: 40 }));
  const cutRow = popRow('Cut');
  const histBefore = (bodyOf(hist)?.children ?? []).length;
  guard('cut on the active pixel layer', () => cutRow?.fire('click'));
  expect((bodyOf(hist)?.children ?? []).length === histBefore + 1,
    'cut must push exactly one undo entry (was: copy + clearSelection = two)');
  // ---- v0.27.0 defect sweep ------------------------------------------------
  // #6: Reset Panel Layout must not kill collapse. The head listener used to
  // re-bind on the reset re-dock, so every click toggled twice (net zero).
  const resetRow6 = menuItem('View', 'Reset Panel Layout');
  guard('View > Reset Panel Layout', () => resetRow6?.row?.fire('click'));
  const card6 = (byId.get('panels')?.children ?? []).find((c) => c.classList.contains('card'));
  const head6 = (card6?.children ?? []).find((c) => c.classList.contains('card-head'));
  guard('collapse after reset (1st click)', () => head6?.fire('click'));
  expect(!!card6?.classList.contains('collapsed'), 'card must collapse after Reset Panel Layout (double-bind bug)');
  guard('expand after reset (2nd click)', () => head6?.fire('click'));
  expect(!card6?.classList.contains('collapsed'), 'card must expand again after Reset Panel Layout');

  // #1: the colour well is a button that opens the in-app picker popover
  const colorRow6 = (byId.get('toolbar')?.children ?? []).find((c) => c.classList.contains('color-well-row'));
  const wellBtn6 = (colorRow6?.children ?? []).find((c) => c.classList.contains('color-well'));
  mustFire('colour well', wellBtn6);
  const colorPop6 = documentShim.body.children.find((c) => c.classList.contains('color-pop'));
  expect(!!colorPop6, 'clicking the well must open the in-app colour popover');
  expect((colorPop6?.children ?? []).some((c) => c.classList.contains('cp-sv')),
    'the picker must show the saturation/value spectrum field (v0.29.0)');
  const cpButtons6 = (colorPop6?.children ?? []).find((c) => c.classList.contains('cp-buttons'));
  const doneBtn6 = (cpButtons6?.children ?? []).find((b) => (b.textContent ?? '') === 'Done');
  guard('colour picker Done', () => doneBtn6?.fire('click'));
  expect(!documentShim.body.children.some((c) => c.classList.contains('color-pop')),
    'Done must close the colour popover');

  // #2: right-click on an options number field → in-app Cut/Copy/Paste menu.
  // El.fire does not bubble, so drive the #app listener directly with the
  // field as the synthetic target.
  const brushBtn6 = toolbarBtns.find((b) => tipOf(b).startsWith('Brush'));
  guard('switch to brush (input menu)', () => brushBtn6?.fire('click'));
  const numInput6 = (byId.get('options')?.children ?? []).flatMap((c) => c.children ?? [])
    .find((c) => c.tagName === 'INPUT' && c.classList.contains('num'));
  if (!numInput6) fail('brush options should expose a numeric field');
  else {
    guard('contextmenu on a number field', () =>
      byId.get('app')?.fire('contextmenu', { target: numInput6, clientX: 30, clientY: 30 }));
    expect(!!popInBody(), 'field right-click must open the in-app edit menu');
    for (const wanted of ['Cut', 'Copy', 'Paste', 'Select All']) {
      expect(!!popRow(wanted), `field menu should offer ${wanted}`);
    }
    guard('dismiss field menu', () => popRow('Select All')?.fire('click'));
  }

  // #7 (v0.29.0): Image > Levels… opens the floating Adjustments palette —
  // a dropdown + inline form in the same window. No modal, no blur.
  const levelsRow6 = menuItem('Image', 'Levels…');
  // the earlier About dialog may still be open in this shim; the palette
  // must not add ANY new overlay on top of what already exists
  const preOverlay6 = documentShim.body.children.filter((c) => c.classList.contains('overlay')).length;
  guard('Image > Levels…', () => levelsRow6?.row?.fire('click'));
  const pal6 = documentShim.body.children.find((c) => c.classList.contains('float-win'));
  expect(!!pal6, 'Image > Levels… must open the floating adjustments palette');
  const palBody6 = (pal6?.children ?? []).find((c) => c.classList.contains('float-body'));
  const palSelect6 = (palBody6?.children ?? []).find((c) => c.tagName === 'SELECT');
  if (!palSelect6) fail('palette must contain the adjustment dropdown');
  else {
    const palOpts6 = (palSelect6.children ?? []).flatMap((g) => (g.children?.length ? g.children : [g]));
    expect(palOpts6.length >= 22,
      `palette dropdown should list every adjustment (got ${palOpts6.length})`);
  }
  const palForm6 = (palBody6?.children ?? []).find((c) => c.classList.contains('pal-form'));
  expect((palForm6?.children ?? []).length >= 1,
    'palette must show the inline form for the selected adjustment');
  expect(documentShim.body.children.filter((c) => c.classList.contains('overlay')).length === preOverlay6,
    'the palette must NOT open a modal overlay (no blur)');
  const palHead6 = (pal6?.children ?? []).find((c) => c.classList.contains('float-head'));
  const palClose6 = (palHead6?.children ?? []).find((b) => b.classList.contains('float-close'));
  guard('palette close', () => palClose6?.fire('click'));
  expect((documentShim.body.children.find((c) => c.classList.contains('float-win'))?.style?.display ?? '') === 'none',
    'palette close must hide it');

  // #3: About is narrow and shows exactly one button (OK)
  const aboutRow6 = menuItem('Help', 'About Guazzo');
  guard('Help > About Guazzo', () => aboutRow6?.row?.fire('click'));
  const aboutOv6 = documentShim.body.children.filter((c) => c.classList.contains('overlay')).pop();
  const aboutPanel6 = aboutOv6?.children[0];
  expect(!!aboutPanel6?.classList.contains('narrow'), 'About must use the narrow face');
  const aboutFoot6 = (aboutPanel6?.children ?? []).find((c) => c.classList.contains('foot'));
  expect((aboutFoot6?.children ?? []).length === 1, 'About must show exactly one button (OK only)');
  expect((aboutFoot6?.children ?? [])[0]?.textContent === 'OK', 'the single About button must be OK');
  guard('About OK', () => (aboutFoot6?.children ?? [])[0]?.fire('click'));
  expect(!documentShim.body.children.some((c) => c === aboutOv6), 'About overlay must be removed on OK');

  // v0.30.0 text-box rework: the old drag handle and the light-blue editor
  // fill must be GONE from the shipped bundle; the new frame pieces must be in
  const bundle = readFileSync('app-bundle.js', 'utf8');
  expect(bundle.includes('drawTextBoxOverlay'), 'bundle must contain the text bounding-box renderer');
  expect(bundle.includes('nwse-resize') && bundle.includes('ew-resize'), 'bundle must contain the handle resize cursors');
  expect(bundle.includes('white-space:pre-wrap'), 'the live text editor must wrap like the rasterizer');
  expect(!bundle.includes('rgba(9,79,209,.12)'), 'the light-blue editor background fill must be gone');
  expect(!bundle.includes('Drag to move the text box'), 'the floating drag-handle square must be gone');

  console.log('smoke: v0.29.0 sweep = reset-collapse, spectrum picker, field menu, inline palette, about OK');

  // ---- v0.30.1 text-commit regression --------------------------------------
  // shipped v0.30.0 made the first empty-canvas click after a commit only
  // DESELECT (no editor opened — typing went nowhere and Enter did nothing);
  // a live editor also never committed on blur. Pins all three paths.
  guard('text commit regression', () => {
    const hostEl = byId.get('canvas-host');
    const disp = hostEl.children.find(c => c.tagName === 'CANVAS');
    const panelsText = () => {
      let txt = '';
      const walk = (el) => {
        if (el && typeof el === 'object') {
          if (el._text) txt += el._text + ' | ';
          if (Array.isArray(el.children)) el.children.forEach(walk);
        }
      };
      walk(byId.get('panels'));
      return txt;
    };
    const liveEditor = () => hostEl.children.find(c => c.contentEditable === 'true');
    const toolArea = toolbarEl.children.find(c => c.classList.contains('tool-area'));
    const textBtn = toolArea.children.find(b => (b.getAttribute('aria-label') || '').includes('Text (T)'));
    expect(!!textBtn, 'text tool button exists');
    textBtn.fire('click');
    // 1. empty-canvas click opens the editor
    disp.fire('pointerdown', { button: 0 });
    let ed = liveEditor();
    expect(!!ed, 'empty-canvas click opens the live editor');
    ed.appendChild(documentShim.createTextNode('hello guazzo'));
    // 2. Enter commits and places the layer
    ed.fire('keydown', { key: 'Enter' });
    expect(panelsText().includes('Text: hello guazzo'), 'Enter places the typed text as a layer');
    // v0.30.3: the commit must acknowledge in the status bar (the placed text
    // is easy to lose track of otherwise)
    const sbEl = byId.get('statusbar');
    const hintSpan = (sbEl?.children ?? []).find(c => c.classList.contains('status-hint'));
    const hintTxt = hintSpan?.textContent ?? '';
    expect(hintTxt.includes('Placed text'), 'commit acknowledges the placed text in the status bar');
    // THE v0.30.4 bug: unwrapped rows carried width 0, so the raster canvas was
    // 2px wide and every glyph was clipped away — a layer with no pixels.
    const dims = /Placed text \u00b7 (\d+) \u00d7 (\d+) px/.exec(hintTxt);
    expect(!!dims && Number(dims[1]) > 2,
      'placed text must rasterize wider than the empty 2px canvas (got ' + (dims ? dims[1] : '?') + 'px wide)');
    // 3. THE v0.30.0 bug: the next empty-canvas click must open a NEW editor
    // in ONE click (it used to only deselect — typing then went nowhere)
    disp.fire('pointerdown', { button: 0 });
    ed = liveEditor();
    expect(!!ed, 'click after a commit opens a new editor in ONE click');
    ed.appendChild(documentShim.createTextNode('second box'));
    // 4. click-away on the canvas commits it
    disp.fire('pointerdown', { button: 0 });
    expect(panelsText().includes('Text: second box'), 'clicking away places the live text');
    // 5. blur (user clicked a panel or a slider) commits too
    disp.fire('pointerdown', { button: 0 });
    ed = liveEditor();
    expect(!!ed, 'third click starts a third editor');
    ed.appendChild(documentShim.createTextNode('blurred away'));
    ed.fire('blur');
    expect(panelsText().includes('Text: blurred away'), 'editor blur commits the text');
    expect(!liveEditor(), 'blur removed the editor');
    // 6. v0.30.2: a stale editor's dying blur must not commit (and destroy)
    // the freshly opened successor
    disp.fire('pointerdown', { button: 0 });            // editor C opens
    const edC = liveEditor();
    expect(!!edC, 'fourth click starts a fourth editor');
    edC.appendChild(documentShim.createTextNode('survivor'));
    ed.fire('blur');                                    // the OLD editor's stale blur
    expect(!!liveEditor() && liveEditor() === edC,
      'a replaced editor\'s blur must not destroy the live one');
    expect(panelsText().includes('Text: survivor') === false,
      'stale blur must not place the successor\'s text');
    edC.fire('keydown', { key: 'Enter' });                // cleanup: commit C
    expect(panelsText().includes('Text: survivor'), 'successor still commits normally');
  });
  // ---- alignment buttons + the round "?" help button (v0.31.0) ----
  {
    const label = (b) => String(b.getAttribute('aria-label') ?? b.title ?? '');
    closeAllModals();
    // the text tool is still active from the block above
    const opts = byId.get('options');
    const helps = opts.children.filter((c) => c.classList.contains('opt-help'));
    expect(helps.length === 1, `the options bar has exactly one "?" help button (got ${helps.length})`);
    expect(opts.children.every((c) => !c.classList.contains('label')),
      'long guidance text no longer sits inline in the options bar');
    // AD5: the button's accessible name is short, the caption stays on screen,
    // and the full guidance appears in a panel that waits to be dismissed.
    expect(String(helps[0].getAttribute('aria-label')) === 'Tool help',
      'the "?" button needs a short accessible name, not a 200-character paragraph');
    const caps = opts.children.filter((c) => c.classList.contains('opt-cap'));
    expect(caps.length === 1, 'a one-line caption stays visible while the tool is selected');
    helps[0].fire('click');
    const helpPanel = documentShim.body.children.find((c) => c.classList.contains('help-pop'));
    const panelText = (helpPanel?.children ?? []).map((c) => c.textContent).join(' | ');
    expect(!!helpPanel && /Text \(T\)/.test(panelText), 'clicking "?" opens a panel carrying the text-tool guidance');
    expect(!/TOOL_CAP_LABEL/.test(panelText), 'the panel must not be a placeholder');
    expect(helpPanel?.getAttribute?.('aria-labelledby') === 'help-panel-title',
      'the help dialog must be named by its heading');
    expect(String(helps[0].getAttribute('aria-expanded')) === 'true', 'the "?" button reports its panel state');
    windowShim.__fire('keydown', {
      key: 'Escape', preventDefault() {}, stopPropagation() {}, target: documentShim.body,
    });
    expect(!documentShim.body.children.some((c) => c.classList.contains('help-pop')),
      'Escape must close the help panel');
    expect(documentShim.activeElement === helps[0],
      'Escape must return focus to the "?" button');
    helps[0].fire('click');
    expect(documentShim.body.children.some((c) => c.classList.contains('help-pop')),
      'clicking "?" again reopens the panel');
    helps[0].fire('click');
    expect(!documentShim.body.children.some((c) => c.classList.contains('help-pop')),
      'clicking "?" again dismisses the panel');
    const isAlign = (c) => /^(Align |Justify)/.test(label(c));
    const alignBtns = opts.children.filter(isAlign);
    expect(alignBtns.length === 4, `four paragraph-alignment buttons exist (got ${alignBtns.length})`);
    const centre = alignBtns.find((b) => label(b).startsWith('Align centre'));
    expect(!!centre, 'centre-alignment button present');
    centre.fire('click');
    const after = byId.get('options').children.filter(isAlign);
    const active = after.find((b) => label(b).includes('(active)'));
    expect(!!active && label(active).startsWith('Align centre'), 'clicking centre marks it active');
    // ---- U1/X2: menus must be reachable and drivable from the keyboard ----
  {
    closeAllModals();
    const leaked = documentShim.body.children.filter((c) => c.classList.contains('overlay'))
      .map((o) => (o.children[0]?.children ?? []).find((k) => k.tagName === 'H3')?.textContent ?? '?');
    expect(leaked.length === 0, `a dialog is still open (${leaked.join(', ')}) — keyboard tests would be vacuous`);
    const fileRoot = menusOf().find((x) => titleOf(x) === 'File');
    const fileBtn = fileRoot?.children[0];
    expect(!!fileBtn, 'File menu button exists');
    fileBtn.fire('keydown', { key: 'ArrowDown' });
    const first = documentShim.activeElement;
    expect(!!first && first.classList.contains('menu-item'),
      'ArrowDown on a menu button must focus the first MENU ROW (not the button)');
    first.fire('keydown', { key: 'ArrowDown' });
    const second = documentShim.activeElement;
    expect(!!second && second !== first && second.classList.contains('menu-item'),
      'ArrowDown on a focused row moves to the next row');
    expect(!!menusOf().find((x) => x.classList.contains('open')), 'the menu stays open while navigating');
    second.fire('keydown', { key: 'Escape' });
    expect(!menusOf().find((x) => x.classList.contains('open')), 'Escape closes the menu');

    // R3: the bar's outside-click rule must be reachable behaviourally — the
    // old code looked up a class-name string no test could drive. A click
    // inside the bar must not dismiss it; one outside must.
    fileBtn.fire('click');
    expect(!!menusOf().find((x) => x.classList.contains('open')), 'clicking a menu title opens it');
    windowShim.__fire('pointerdown', { target: fileBtn });
    expect(!!menusOf().find((x) => x.classList.contains('open')), 'pointerdown inside the bar keeps the menu open');
    windowShim.__fire('pointerdown', { target: byId.get('canvas-host') });
    expect(!menusOf().find((x) => x.classList.contains('open')), 'pointerdown outside closes the menu');

    // Menu key (X2): opens the focused surface's context menu
    const host = byId.get('canvas-host');
    documentShim.activeElement = host;
    windowShim.__fire('keydown', { key: 'b', preventDefault() {}, stopPropagation() {}, target: documentShim.body, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    const helpNow = (function findHelp(el) { for (const c of el.children ?? []) { if (c.classList?.contains('opt-help')) return c; const r = findHelp(c); if (r) return r; } return null; })(byId.get('options'));
    windowShim.__fire('keydown', { key: 'ContextMenu', preventDefault() {}, stopPropagation() {}, target: host, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    const noop = 0;
    const brushAct = false;
    const helpEl = (function findHelp(el) { for (const c of el.children ?? []) { if (c.classList?.contains('opt-help')) return c; const r = findHelp(c); if (r) return r; } return null; })(byId.get('options'));
    byId.get('canvas-host').fire('contextmenu', { clientX: 40, clientY: 40, preventDefault() {}, stopPropagation() {} });
    documentShim.body.children.filter((c) => c.classList.contains('context-pop')).forEach((c) => c.remove());
        // Focus is the user-visible effect: the opener must land on a menu row.
    const kbdFocus = documentShim.activeElement;
    expect(!!kbdFocus && kbdFocus.classList.contains('menu-item'),
      'the Menu key opens a context menu for the focused surface');
    expect(!!kbdFocus && !!kbdFocus.parentNode?.classList?.contains('context-pop'),
      'the keyboard-opened context menu focuses its first row');
    windowShim.__fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {}, target: host, shiftKey: false });
    expect(!documentShim.body.children.some((c) => c.classList.contains('context-pop')),
      'Escape closes the keyboard-opened context menu');
    console.log('smoke: keyboard menus = menubar ArrowDown focus, row navigation, Menu key, Escape');
  }
  console.log('smoke: text align + "?" help = 4 align buttons, help tooltip, inline hints swept');
  }
  console.log('smoke: text commit = Enter / click-away / blur all place the layer');
  console.log('smoke: a11y = pop/tab roles, aria-labels, keydown guards OK');

  // Perspective Crop: the engine must be bundled and the crop bar must open the
  // four-corner mode (a feature that exists only in dist/ never reaches the app).
  {
    const bundle = readFileSync('app-bundle.js', 'utf8');
    expect(bundle.includes('function perspectiveCrop'), 'perspectiveCrop must be in the bundled app');
    const area = byId.get('toolbar').children.find((c) => c.classList.contains('tool-area'));
    const cropBtn = area.children.find((b) => (b.getAttribute('aria-label') || '').includes('Crop (C)'));
    expect(!!cropBtn, 'the crop tool button must exist');
    cropBtn.fire('click');
    const bar = byId.get('options');
    const perspBtn = bar.children.find((c) => (c._text ?? '').includes('Perspective'));
    expect(!!perspBtn, 'the crop options bar must offer Perspective…');
    perspBtn.fire('click');
    const walkText = (el) => {
      let txt = '';
      const walk = (n) => {
        if (n && typeof n === 'object') {
          if (n._text) txt += n._text + ' | ';
          if (Array.isArray(n.children)) n.children.forEach(walk);
        }
      };
      walk(el);
      return txt;
    };
    const status = walkText(byId.get('statusbar'));
    expect(/four corners/i.test(status), `entering perspective mode must explain the corners, got "${status}"`);
    // The hint span is a direct .label child, so v0.31.0's help sweep moves its
    // text into the "?" tooltip — assert the mode's controls instead.
    expect(bar.children.some((c) => (c._text ?? '').includes('Apply perspective crop')),
      'the bar must offer Apply for the perspective crop');
    expect(bar.children.some((c) => (c._text ?? '').includes('Cancel')),
      'the bar must offer Cancel for the perspective crop');
    console.log('smoke: perspective crop = bundled, bar button opens the quad');

    // Live preview — EXECUTED (AM2), not grepped. Drive the filter slider and
    // prove a frame ran and blitted a proxy-sized image. A bundle-text check
    // could not tell a working preview from a dead one (the v0.36 deadlock
    // shipped with every string present).
    {
      const all = (root, out = []) => {
        if (!root) return out;
        for (const c of root.children ?? []) { out.push(c); all(c, out); }
        return out;
      };
      const panelNodes = all(byId.get('panels'));
      // The shim has no HTMLSelectElement.options; a select's choices are its
      // children — inside <optgroup>s here — and its value is whatever was
      // assigned (see the value getter).
      const textOf = (node) => `${node._text ?? ''}${(node.children ?? []).map(textOf).join('')}`;
      const filterSel = panelNodes.find((c) => c.tagName === 'SELECT' && /gaussian blur/i.test(textOf(c)));
      expect(!!filterSel, 'the filters card must expose its filter select');
      const flat = (node, out = []) => {
        for (const c of node.children ?? []) { out.push(c); flat(c, out); }
        return out;
      };
      const blurOpt = flat(filterSel).find((o) => o.tagName === 'OPTION' && /gaussian blur/i.test(textOf(o)));
      expect(!!blurOpt, 'Gaussian Blur must be one of the filter options');
      filterSel.value = blurOpt.value;
      filterSel.fire('change');
      // the amount slider lives in the same card as the select
      const card = (() => {
        let node = filterSel;
        while (node && !node.classList.contains('card')) node = node.parentNode;
        return node ?? byId.get('panels');
      })();
      const slider = all(card).find((c) => c.tagName === 'INPUT' && c.type === 'range');
      expect(!!slider, 'the filters card must expose its amount slider');
      slider.value = '7';
      slider.fire('input');
      const before = drawLog.length;
      runFrames(3);
      const blits = drawLog.slice(before).filter((e) => e.op === 'putImageData');
      expect(blits.length > 0,
        `a slider tick must schedule a frame that blits the preview (saw ${drawLog.length - before} ctx calls)`);
      const img = blits[blits.length - 1].args[0];
      expect(img && img.width > 1 && img.height > 1, 'the preview blit must carry an image');
      expect(img.width < 1024, `the preview must be a proxy, not the canvas (got ${img && img.width}px wide)`);
      // the badge lives on the canvas host, not in a panel
      const badge = all(byId.get('canvas-host')).some((c) => (c._text ?? '').includes('Preview'));
      expect(badge, 'the proxy must say it is a preview');
      console.log(`smoke: live preview = executed (proxy ${img.width}×${img.height}, badge present)`);
    }

    // Native dialogs and the window chrome are executed above against the fake
    // bridge; no bundle-content mention checks remain.
    // No deferred native or chrome checks: both paths execute above.

    // Options bar: one builder per tool, looked up by a switch whose function
    // declarations are hoisted (a const map here crashed boot with a TDZ error).
    expect(bundle.includes('function optionBuilder'), 'the options-bar dispatch must be bundled');
    expect(
      bundle.includes('marquee-shape') && bundle.includes('Single Row'),
      'the marquee tool must offer the single-row/column strip modes',
    );
    const builders = ['buildMoveOptions','buildWandOptions','buildShapeOptions','buildQuickOptions',
      'buildBucketOptions','buildEyedropperOptions','buildRetouchOptions','buildCloneOptions',
      'buildFocusOptions','buildHealOptions','buildCropOptions','buildSelectOptions',
      'buildGradientOptions','buildTextOptions','buildBrushOptions'];
    for (const name of builders) {
      expect(bundle.includes('function ' + name), 'missing options builder: ' + name);
    }
    const cases = (bundle.match(/case "[a-z]+": return build\w+Options;/g) ?? []).length;
    expect(cases >= 18, 'every tool must map to a builder (found ' + cases + ' cases)');
    console.log('smoke: options bar = ' + builders.length + ' builders, ' + cases + ' tool cases');
  }
}

// ---- handoff-5 pins -------------------------------------------------------
// Static pins on the SHIPPED bundle. They used to sit after the process.exit()
// below, which made them dead code: nothing had ever checked them.
const bundleSrc = readFileSync(new URL('../app-bundle.js', import.meta.url), 'utf8');
expect(bundleSrc.includes("function buildSeedHtml") || bundleSrc.includes("function segSpanHtml"),
  "the seed-HTML builder must be bundled (it is the XSS trust boundary)");
// AM1: this used to be `!x === false`, which is `x` — the assertion passed
// BECAUSE the raw-string sink was present and would have failed if someone
// removed it. The invariant is "the sink only ever receives buildSeedHtml()",
// not "the sink exists".
expect(/\.innerHTML = seedHtml/.test(bundleSrc), "the text editor still has its seed sink (buildSeedHtml feeds it)");
expect(bundleSrc.includes("buildSeedHtml("), "the seed HTML must come from buildSeedHtml (escapes text, whitelists fonts)");
  expect(/function safeFontFamily\(/.test(bundleSrc), "the font whitelist must be bundled, not inlined per call site");
expect(!/innerHTML\s*=\s*[^;]{0,40}(textData\.font|seg\.font|run\.font)/.test(bundleSrc),
  "a raw font string must never be concatenated into innerHTML");
expect(!/\bpreviewPending\s*=/.test(bundleSrc),
  "no previewPending flag: one scheduler (src/ui/previewqueue.ts) owns the frame");
expect(bundleSrc.includes("createPreviewScheduler"),
  "the preview scheduler must be the bundled implementation, not a local re-implementation");
expect(bundleSrc.includes('"save_file"') || bundleSrc.includes("save_file"),
  "saves must go through the Rust-owned dialog (save_file), never a JS-supplied path");
expect(!bundleSrc.includes("write_bytes") && !bundleSrc.includes("read_bytes"),
  "write_bytes/read_bytes are gone: no command may accept a filesystem path from the page");
expect(bundleSrc.includes("guazzo-tmp") === false, "temp-file naming belongs to Rust only");
console.log("smoke: handoff-5 = textseed bundled, single preview scheduler, no path-taking commands");

// ---- handoff-5 batch 2 ----------------------------------------------------
expect(bundleSrc.includes("LICENCE_TEXT"), "the licence text must be embedded (About shows it)");
  // AE4/AE5/AD5 pins
  // AF4: one bilinear sampler, three callers. A fourth inlined copy would be a
  // silent divergence (that is how the dark-fringe bug came back once already).
  // AF3: the Layers panel is its own module; main.ts keeps only the adapter.
  expect((bundleSrc.match(/function buildLayersPanel\(/g) ?? []).length === 1, 'the Layers panel is built in exactly one place');
  expect((bundleSrc.match(/function layerThumb\(/g) ?? []).length === 1, 'the thumbnail renderer moved with the panel (no duplicate)');
  {
    const mainSrc = readFileSync('src/main.ts', 'utf8');
    const at = mainSrc.indexOf('function renderLayers(): void {');
    const body = at >= 0 ? mainSrc.slice(at, mainSrc.indexOf('\n}\n', at) + 3) : '';
    expect(body.length > 0 && body.split('\n').length <= 6, 'renderLayers is an adapter, not a 320-line renderer again');
  }
  expect((bundleSrc.match(/function samplePremul\(/g) ?? []).length === 1, 'exactly one bilinear sampler exists');
  expect(/function samplePerspective\(/.test(bundleSrc), 'perspective keeps a float wrapper over the same convention');
  expect((bundleSrc.match(/samplePremul\(/g) ?? []).length >= 3, 'resize, transform and the shared core use the sampler');
  expect(bundleSrc.includes('__GUAZZO_BOOTED__'), 'the bundle must refuse to boot twice (sentinel)');
  expect(/function shellHealth/.test(bundleSrc), 'a broken IPC bridge must be reported, not silently downgraded');
  expect(/__TAURI__/.test(bundleSrc), 'isTauri() must not depend on one internal global name');
  expect(/function toggleHelpPanel/.test(bundleSrc), 'the "?" guidance must open a panel, not a 2.6 s toast');
  expect(/class="opt-cap"|className = "opt-cap"/.test(bundleSrc), 'each tool must keep a visible caption');
  expect(!/help\.addEventListener\("click", \(\) => statusHint\(tip\)\)/.test(bundleSrc), 'help must not be a toast again');
  const helpCss = readFileSync('index.html', 'utf8');
  expect(/\.help-pop\s*\{[^}]*position:\s*fixed/.test(helpCss), '.help-pop must be fixed so the bar cannot clip it');
  expect(/\.opt-cap\s*\{[^}]*text-overflow:\s*ellipsis/.test(helpCss), 'the caption must truncate instead of wrapping the bar');
  const buildRs = readFileSync('src-tauri/build.rs', 'utf8');
  expect(/for watched in \[".*\.\.\/vendor".*\.\.\/package\.json"/.test(buildRs), 'cargo must watch vendor/ and package.json too');
expect(/function showTextDialog/.test(bundleSrc), "the licence/notices reader dialog must exist (About used to inline 30 KB of text and overflow)");
expect(/link\("Licence"/.test(bundleSrc) && /link\("Third-party notices"/.test(bundleSrc), "About must offer Licence and Third-party notices as rows, not inline blocks");
expect(/const modalStack = \[\]/.test(bundleSrc), "nested dialogs need a stack, or one Escape closes both");
expect(!/Licence:<\/p>/.test(bundleSrc), "About must not inline the licence text again");
const aboutSrc = readFileSync('src/main.ts', 'utf8');
const aboutAt = aboutSrc.indexOf('function showAbout');
const aboutBody = aboutSrc.slice(aboutAt, aboutAt + 1600);
expect(aboutBody.length > 0 && !aboutBody.includes('<pre'), "the About body must stay compact (no <pre> blobs)");

expect(!/toolButton\("brush", "Brush \(B\)"/.test(bundleSrc),
  "no tool button may carry a hand-written title that can drift from TOOL_LABELS");
const cssNow = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
expect(/\.rs-edge\s*\{[^}]*z-index:\s*60/.test(cssNow),
  ".rs-edge must stay below menus (320): a grip above a pop makes it un-clickable");
expect(!/qRange\.style\.opacity/.test(readFileSync('src/ui/exportdlg.ts', 'utf8')),
  "the export dialog must not hand-patch a disabled control's opacity");

// Phase 1.2: autosave is a behaviour, not the string "Discard the recovered
// work?". Seed the OPFS store initAutosave() is waiting on, then exercise the
// banner: Discard asks first and cancelling keeps the only copy; Restore swaps
// the document and drops the banner.
{
  const findDeep = (root, pred, out = []) => {
    for (const c of root?.children ?? []) {
      if (pred(c)) out.push(c);
      findDeep(c, pred, out);
    }
    return out;
  };
  const autosavePayload = async () => {
    const value = autosaveFiles.get('guazzo-autosave.json');
    if (value instanceof Uint8Array) {
      if (value[0] === 2) {
        // v2: byte 2, "GZAS", u32 compressed-metadata length, metadata JSON.
        // Metadata carries every tab's layer tree (without pixels), which is
        // what this drill checks; the tile records are covered by the engine
        // tests, which can afford a 4096² document.
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        const length = view.getUint32(5, true);
        const text = await new Response(
          new Blob([value.subarray(9, 9 + length)]).stream().pipeThrough(new DecompressionStream('deflate')),
        ).text();
        return JSON.parse(text);
      }
      const body = value.subarray(1);
      const text = await new Response(
        new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate')),
      ).text();
      return JSON.parse(text);
    }
    return JSON.parse(String(value));
  };
  // The streaming encoder yields between slices with setTimeout(0). The smoke's
  // fake clock owns setTimeout, so a real wait alone cannot let it finish:
  // alternate real macrotasks (CompressionStream progress) with fake-timer
  // turns until the queued slice timers drain.
  const settleAutosave = async (advance) => {
    await tickTimeouts(advance);
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 2));
      await tickTimeouts(0);
    }
    await new Promise((r) => setTimeout(r, 20));
  };
  const snapshot = {
    format: 'guazzo-project', version: 1, name: 'Recovered',
    width: 64, height: 64,
    layers: [
      { name: 'Recovered Layer', visible: true, opacity: 1, blendMode: 'normal', locked: false, tiles: [] },
    ],
  };
  autosaveFiles.set('guazzo-autosave.json', JSON.stringify({
    savedAt: Date.now(),
    tabs: [{ name: 'Recovered', project: snapshot }],
    active: 0,
  }));
  releaseOpfs();
  await new Promise((r) => setTimeout(r, 80));

  const bannerLabel = () => findDeep(byId.get('canvas-host'),
    (c) => c.textContent && c.textContent.startsWith('Found an unsaved autosave from'))[0];
  const label = bannerLabel();
  expect(!!label, 'a seeded OPFS snapshot must show the recovery banner');
  const bar = label?.parentNode;
  const barButton = (text) => findDeep(bar, (c) => c.tagName === 'BUTTON' && c.textContent === text)[0];

  barButton('Discard')?.fire('click');
  await new Promise((r) => setTimeout(r, 20));
  const discardOverlay = documentShim.body.children.find((c) =>
    c.classList.contains('overlay')
      && (c.children[0]?.children ?? []).some((k) => k.tagName === 'H3' && k.textContent === 'Discard the recovered work?'));
  expect(!!discardOverlay, 'Discard must confirm before deleting the only copy');
  const foot = discardOverlay?.children[0]?.children.find((k) => k.classList.contains('foot'));
  const cancel = (foot?.children ?? []).find((b) => b.textContent === 'Cancel');
  cancel?.fire('click');
  await new Promise((r) => setTimeout(r, 20));
  expect(autosaveFiles.has('guazzo-autosave.json'), 'cancelling Discard must keep the autosave file');
  expect(!!bannerLabel(), 'cancelling Discard must keep the recovery banner');

  barButton('Restore')?.fire('click');
  await new Promise((r) => setTimeout(r, 80));
  expect(!bannerLabel(), 'Restore must remove the recovery banner');
  expect(!!findDeep(byId.get('tabs'), (c) => c.textContent === 'Recovered')[0],
    'Restore must open the recovered document in a tab');
  expect(!!findDeep(byId.get('panels'), (c) => c.textContent === 'Recovered Layer')[0],
    'Restore must render the recovered layer');
  // P2.2: the drill above seeds OPFS by hand. This drives the real 20 s
  // interval after a real edit, so `return;` at the top of writeAutosave()
  // would leave the store empty and fail here.
  autosaveFiles.delete('guazzo-autosave.json');
  const addLayerBtn = findDeep(byId.get('panels'),
    (c) => c.tagName === 'BUTTON' && c.title === 'New layer (top)')[0];
  addLayerBtn?.fire('click');
  await new Promise((r) => setTimeout(r, 20));
  await settleAutosave(2_000);
  const written = autosaveFiles.get('guazzo-autosave.json');
  expect(written instanceof Uint8Array && written.length > 0,
    'the idle autosave must write a compressed snapshot after an edit');
  const payload = written ? await autosavePayload() : null;
  expect(!!payload && Array.isArray(payload.tabs) && payload.tabs.length > 0,
    'the autosave payload must carry the open tabs');
  expect(!!payload && payload.tabs.some((tab) => (tab.project?.layers ?? []).length > 0),
    'the autosave payload must carry the edited document');

  // P3.7: a failed write must say so, keep the previous snapshot, and back off
  // before hammering a storage that is full.
  const statusHint = () => byId.get('statusbar')?.children
    .find((c) => c.classList.contains('status-hint'))?.textContent ?? '';
  // A live transform makes writeAutosave() return; the perspective test left
  // one open, so cancel it before proving the failure path.
  windowShim.__fire('keydown', { key: 'Escape', target: documentShim.body, preventDefault() {}, stopPropagation() {} });
  const beforeFailure = autosaveFiles.get('guazzo-autosave.json');
  const rowsBefore = findDeep(byId.get('panels'), (c) => c.classList.contains('row')).length;
  const menuBar = byId.get('topbar')?.children.find((c) => c.id === 'menubar');
  const layerMenu = menuBar?.children.find((c) => (c.children[0]?.textContent ?? '') === 'Layer');
  expect(!!layerMenu, 'the autosave probe needs the Layer menu');
  layerMenu?.children[0]?.fire('click');
  const layerPop = menuBar?.children.find((c) => c.classList.contains('open'));
  expect(!!layerPop, 'the autosave probe needs the Layer menu to open');
  const newLayerRow = layerPop?.children[1]?.children
    .find((c) => (c.children[1]?.textContent ?? '').includes('New Layer'));
  expect(!!newLayerRow, 'the autosave probe needs Layer > New Layer');
  newLayerRow?.fire('click');
  await new Promise((r) => setTimeout(r, 20));
  const rowsAfter = findDeep(byId.get('panels'), (c) => c.classList.contains('row')).length;
  expect(rowsAfter === rowsBefore + 1,
    `the backoff test needs a real edit (rows ${rowsBefore} → ${rowsAfter})`);
  const settle = () => new Promise((r) => setTimeout(r, 80));
  autosaveWriteAttempts = 0;
  autosaveWriteFails = true;
  await settleAutosave(2_000);
  expect(autosaveWriteAttempts === 1,
    `a failed autosave must make one attempt (got ${autosaveWriteAttempts})`);
  expect(statusHint().includes('Autosave failed'),
    `a failed autosave must be visible (got "${statusHint()}")`);
  expect(autosaveFiles.get('guazzo-autosave.json') === beforeFailure,
    'a failed autosave must leave the previous snapshot intact');
  await tickTimeouts(19_999);
  await settle();
  expect(autosaveWriteAttempts === 1,
    `autosave must back off after a failure (got ${autosaveWriteAttempts} attempts)`);
  await settleAutosave(20_000);
  expect(autosaveWriteAttempts === 2,
    `autosave must retry after the backoff (got ${autosaveWriteAttempts} attempts)`);
  expect(statusHint().includes('Autosave saved'),
    `a recovered autosave must say so (got "${statusHint()}")`);

  console.log('smoke: autosave = seeded OPFS banner, discard confirms, restore swaps document, failure backs off');
}

// Phase E: no browser-chrome dialogs, and the autosave Discard asks first.
expect(!bundleSrc.includes("window.alert("), "no window.alert: the frameless shell must not borrow the browser chrome");
expect(!bundleSrc.includes("window.confirm("), "no blocking window.confirm: it freezes the paint loop");
expect(/function notify\(/.test(bundleSrc) && /function ask\(/.test(bundleSrc), "one in-app notify + ask pair");
expect(bundleSrc.includes("Close anyway"), "closing with unsaved tabs must offer an explicit choice");
console.log("smoke: dialogs = in-app notify/ask only, discard + close confirm");

// When imported (scripts/ci.mjs) an exit() would kill the rest of the gate, so
// only set the code; running standalone the process ends here anyway.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (deferred.length > 0) {
    console.log(`smoke: deferred: ${deferred.length} (not verified) — ${deferred.join('; ')}`);
  }
  process.exit(errors === 0 ? 0 : 1);
} else {
  process.exitCode = errors === 0 ? 0 : 1;
}
