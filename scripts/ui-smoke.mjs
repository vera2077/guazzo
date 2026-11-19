// Headless smoke test for the UI layer: evaluates the real single-file bundle
// (app-bundle.js) against a tiny DOM shim so that a *top-level* runtime error —
// the class of bug that produces a blank window — is caught before shipping.
// It deliberately stubs rendering: no pixels, no layout, only code paths that
// run at module load plus a handful of synthetic interactions.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let errors = 0;
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

const ctx2d = new Proxy({}, {
  get(t, p) {
    if (p in t) return t[p];
    if (p === 'canvas') return { width: 100, height: 100 };
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'getImageData') return (x, y, w, h) => new ImageDataStub(Math.max(1, w | 0), Math.max(1, h | 0));
    if (p === 'createPattern') return () => ({});
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
    return () => {};
  },
  set(t, p, v) { t[p] = v; return true; },
});

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
  appendChild(c) { const n = this.childNode(c); this.children.push(n); n.parentNode = this; return n; }
  append(...cs) { for (const c of cs) { const n = this.childNode(c); this.children.push(n); n.parentNode = this; } }
  /** the real DOM accepts plain strings in append/appendChild — wrap them as
   *  text nodes so app code can compose nodes and literals freely */
  childNode(c) {
    if (typeof c === 'string') { const t = new El('#text'); t._text = c; return t; }
    return c;
  }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); }
  addEventListener(t, fn) { this.listeners.set(t, fn); }
  removeEventListener(t) { this.listeners.delete(t); }
  /** fire a listener if the code registered one (used for synthetic clicks) */
  fire(type, ev = {}) {
    const fn = this.listeners.get(type);
    if (!fn) return false;
    fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0, pointerId: 1, shiftKey: false, key: '', ...ev });
    return true;
  }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; }
  getContext() { return ctx2d; }
  toBlob(cb) { exported.push({ canvas: this }); cb(new Blob(['x'])); }
  click() { this.fire('click'); }
  focus() {}
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
}

const exported = [];
let offscreenResizes = 0;
const byId = new Map();
const ids = ['app', 'topbar', 'options', 'tabs', 'toolbar', 'canvas-host', 'panels', 'statusbar'];
for (const id of ids) byId.set(id, new El('div'));

let created = 0;
const documentShim = {
  getElementById: (id) => byId.get(id) ?? null,
  createElement: (tag) => { created++; return new El(tag); },
  createElementNS: (_ns, tag) => new El(tag),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
  body: new El('body'),
  documentElement: new El('html'),
  fonts: { add() {}, ready: Promise.resolve() },
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll: () => [],
  querySelector: () => null,
  execCommand: () => false,
};

const windowShim = {
  document: documentShim,
  innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame: (cb) => { return 0; }, // never runs: no render loop in smoke
  cancelAnimationFrame() {},
  setTimeout: (fn, ms) => setTimeout(fn, 0),
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: 'smoke', platform: 'win32' },
  location: { href: 'http://localhost/' },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
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
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  performance: { now: () => 0 },
};
windowShim.window = windowShim;
windowShim.globalThis = windowShim;
windowShim.self = windowShim;

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
  const layerMenu = menuItem('Layer', 'Merge Down');
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
  // flat colour groups: clicking the chip must set a groupId and repaint the row
  const body0 = bodyOf(layers)?.children ?? [];
  const rows0 = body0.filter((c) => c.classList.contains('row'));
  const chip = rows0[0] ? partOf(rows0[0], 'groupchip') : null;
  expect(!!chip, 'a layer row should carry a group chip');
  guard('group chip', () => chip?.fire('click'));
  const rows1 = (bodyOf(layers)?.children ?? []).filter((c) => c.classList.contains('row'));
  expect(!!(rows1[0] && partOf(rows1[0], 'groupchip')?.classList.contains('on')),
    'clicking the chip should mark the layer as grouped');
  expect(hist.children.length > 0, 'history card missing');
  const hostBefore = byId.get('canvas-host').children.length;
  // File > New… opens the document dialog; pressing OK must create a tab.
  const hostEl = byId.get('canvas-host');
  const tabsEl = byId.get('tabs');
  const tabsBefore = tabsEl.children.length;
  const newItem = menuItem('File', 'New');
  guard('File > New', () => newItem.row?.fire('click'));
  const docBody = documentShim.body;
  const dlgOverlay = docBody.children.filter((c) => c.classList.contains('overlay')).pop();
  const panel = dlgOverlay?.children[0];
  const foot = panel?.children[panel.children.length - 1];
  const okBtn = foot?.children.find((b) => (b.textContent ?? '') === 'OK');
  console.log('smoke: New dialog =', !!dlgOverlay, '| title =', JSON.stringify(panel?.children[0]?.textContent ?? ''),
    '| rows =', panel?.children[1]?.children?.[0]?.children.length ?? 0, '| OK found =', !!okBtn);
  guard('New dialog OK', () => okBtn?.fire('click'));
  expect(tabsEl.children.length === tabsBefore + 1, `New should add exactly one tab (${tabsBefore} -> ${tabsEl.children.length})`);
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
    }
  }

  const help = menuItem('Help', 'About Guazzo');
  guard('Help > About', () => help.row?.fire('click'));
  const dlg = documentShim.body.children.find((c) => c.classList.contains('overlay'));
  console.log('smoke: about dialog =', !!dlg, '| title =', JSON.stringify(dlg?.children[0]?.children[0]?.textContent ?? ''),
    '| modal in body =', documentShim.body.children.some((c) => c.classList.contains('overlay')));
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
  const maskChip = (bodyOf(layers)?.children ?? []).some((r) =>
    (r.children ?? []).some((c) => c.classList.contains('maskchip')));
  console.log('smoke: layer mask chip present =', maskChip);
  guard('new adjustment layer', () => byTitle('adjustment layer')?.fire('click'));
  const layerRows = (bodyOf(layers)?.children ?? []).length;
  console.log('smoke: layer rows after adjustment layer =', layerRows);
  const adjDlg = documentShim.body.children.filter((c) => c.classList.contains('overlay')).pop();
  if (adjDlg) {
    const ok = (adjDlg.children[0].children[2]?.children ?? []).find((b) => /ok/i.test(b.textContent ?? ''));
    guard('adjustment dialog OK', () => ok?.fire('click'));
  }
  console.log('smoke: layer rows after OK =', (bodyOf(layers)?.children ?? []).length);
  guard('clip toggle', () => byTitle('Clip to layer below')?.fire('click'));
  // status bar children are built once by buildStatusBars (handoff-3 T6): the
  // bar must have its static spans after boot, not an empty innerHTML
  expect((byId.get('statusbar')?.children ?? []).length > 0, 'status bar has static children');
  console.log('smoke: status bar children =', (byId.get('statusbar')?.children ?? []).length);

  // ---- right-click context menus (v0.25.0) --------------------------------
  const popInBody = () => documentShim.body.children.find((c) => c.classList.contains('context-pop'));
  const popItems = () => (popInBody()?.children ?? []).filter((c) => c.classList.contains('menu-item'));
  const popRow = (label) => popItems().find((c) => (c.children[1]?.textContent ?? '') === label);
  const rowsNow = () => (bodyOf(layers)?.children ?? []).filter((c) => c.classList.contains('row'));

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
  const rowsAfterFlatten = (bodyOf(layers)?.children ?? []).filter((r) => r.classList.contains('row'));
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

  // #7: Image > Levels… opens the floating Adjustments palette and fires the
  // adjustment; the palette lists every adjustment (tonal + basic).
  const levelsRow6 = menuItem('Image', 'Levels…');
  guard('Image > Levels…', () => levelsRow6?.row?.fire('click'));
  const pal6 = documentShim.body.children.find((c) => c.classList.contains('float-win'));
  expect(!!pal6, 'Image > Levels… must open the floating adjustments palette');
  const palBody6 = (pal6?.children ?? []).find((c) => c.classList.contains('float-body'));
  expect((palBody6?.children ?? []).length >= 22,
    `palette should list every adjustment (got ${(palBody6?.children ?? []).length})`);
  const palHead6 = (pal6?.children ?? []).find((c) => c.classList.contains('float-head'));
  const palClose6 = (palHead6?.children ?? []).find((b) => b.classList.contains('float-close'));
  guard('palette close', () => palClose6?.fire('click'));
  expect((documentShim.body.children.find((c) => c.classList.contains('float-win'))?.style?.display ?? '') === 'none',
    'palette close must hide it');
  // the palette also fired the Levels dialog: close it so later overlay
  // lookups (About) see the right modal
  const levelsDlg6 = documentShim.body.children.filter((c) => c.classList.contains('overlay')).pop();
  if (levelsDlg6) {
    const cancelB6 = (levelsDlg6.children[0]?.children[2]?.children ?? [])[0];
    guard('Levels dialog cancel', () => cancelB6?.fire('click'));
  }

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

  console.log('smoke: v0.27.0 sweep = reset-collapse, colour popover, field menu, palette, about OK');
  console.log('smoke: a11y = pop/tab roles, aria-labels, keydown guards OK');
}

process.exit(errors === 0 ? 0 : 1);
