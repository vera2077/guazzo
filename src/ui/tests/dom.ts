// A tiny DOM for the UI tests.
//
// `scripts/ui-smoke.mjs` already proves the assembled app behaves, but it can
// only do that by running the bundle in a shim, and some contracts (the modal
// stack, the palette's filter) are cheaper and sharper to state against the
// module itself. Node has no DOM, so this file is the smallest one the three
// extracted modules actually use: elements, class lists, events, focus.
//
// It is deliberately not a browser: no layout, no CSS, no innerHTML parsing.
// If a test needs layout it belongs in ui-smoke.mjs instead.

type Listener = (ev: Record<string, unknown>) => void;

export class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  value = "";
  type = "";
  id = "";
  tabIndex = -1;
  placeholder = "";
  offsetWidth = 120;
  offsetHeight = 80;
  scrollTop = 0;
  scrollHeight = 0;
  private text = "";
  private classes = new Set<string>();
  private listeners = new Map<string, Listener[]>();

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  get classList() {
    const self = this;
    return {
      add: (...names: string[]) => { for (const n of names) self.classes.add(n); },
      remove: (...names: string[]) => { for (const n of names) self.classes.delete(n); },
      contains: (name: string) => self.classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !self.classes.has(name);
        if (on) self.classes.add(name); else self.classes.delete(name);
        return on;
      },
      get length() { return self.classes.size; },
    };
  }
  get className(): string { return [...this.classes].join(" "); }
  set className(v: string) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  get textContent(): string {
    if (this.children.length === 0) return this.text;
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) { this.text = String(v); this.children = []; }

  get innerHTML(): string { return ""; }
  set innerHTML(_v: string) { this.children = []; this.text = ""; }

  get isConnected(): boolean {
    let at: FakeElement | null = this;
    while (at) {
      if (at.tagName === "BODY" && (at as FakeElement).parentNode === null) return true;
      at = at.parentNode;
    }
    return false;
  }

  append(...nodes: FakeElement[]): void { for (const n of nodes) this.appendChild(n); }
  appendChild(node: FakeElement): FakeElement {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  remove(): void {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }

  setAttribute(name: string, value: string): void { this.attrs.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }

  focus(): void { (this as unknown as { ownerDocument: FakeDocument }).ownerDocument.activeElement = this; }
  select(): void { /* the prompt test does not need a text selection */ }
  getContext(_kind: string): null { return null; }
  scrollIntoView(): void { /* no layout */ }
  getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
    return { left: 0, right: this.offsetWidth, top: 0, bottom: this.offsetHeight, width: this.offsetWidth, height: this.offsetHeight };
  }
  matches(selector: string): boolean {
    if (selector === ":hover") return false;
    return selector.split(",").some((part) => matchesPart(this, part.trim()));
  }
  contains(node: FakeElement | null): boolean {
    if (!node) return false;
    let at: FakeElement | null = node;
    while (at) { if (at === this) return true; at = at.parentNode; }
    return false;
  }

  querySelector<T = FakeElement>(selector: string): T | null { return (this.querySelectorAll(selector)[0] as T) ?? null; }
  querySelectorAll<T = FakeElement>(selector: string): T[] {
    const scopePrefix = ":scope > ";
    const direct = selector.startsWith(scopePrefix);
    const rest = direct ? selector.slice(scopePrefix.length) : selector;
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const c of el.children) {
        if (matchesAny(c, rest)) out.push(c);
        if (!direct) walk(c);
      }
    };
    if (direct) {
      for (const c of this.children) if (matchesAny(c, rest)) out.push(c);
    } else walk(this);
    return out as T[];
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  fire(type: string, ev: Record<string, unknown> = {}): void {
    if (typeof ev.preventDefault !== "function") ev.preventDefault = () => {};
    if (typeof ev.stopPropagation !== "function") ev.stopPropagation = () => {};
    if (ev.target === undefined) ev.target = this;
    let at: FakeElement | null = this;
    while (at) {
      for (const fn of at.listeners.get(type) ?? []) fn(ev);
      at = at.parentNode;
    }
  }
}

export class FakeTextArea extends FakeElement {
  constructor() { super("textarea"); }
}

export class FakeDocument {
  body: FakeElement;
  activeElement: FakeElement;
  constructor() {
    this.body = new FakeElement("body");
    (this.body as unknown as { ownerDocument: FakeDocument }).ownerDocument = this;
    this.activeElement = this.body;
  }
  createElement(tag: string): FakeElement {
    const el = tag === "textarea" ? new FakeTextArea() : new FakeElement(tag);
    (el as unknown as { ownerDocument: FakeDocument }).ownerDocument = this;
    return el;
  }
  querySelector<T = FakeElement>(selector: string): T | null { return this.body.querySelector<T>(selector); }
  querySelectorAll<T = FakeElement>(selector: string): T[] { return this.body.querySelectorAll<T>(selector); }
}

export class FakeWindow {
  innerWidth = 1280;
  innerHeight = 800;
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }
  fire(type: string, ev: Record<string, unknown> = {}): void {
    if (typeof ev.preventDefault !== "function") ev.preventDefault = () => {};
    if (typeof ev.stopPropagation !== "function") ev.stopPropagation = () => {};
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
}

export interface Dom {
  document: FakeDocument;
  window: FakeWindow;
  body: FakeElement;
  overlays(): FakeElement[];
}

/** Install globals. Call once per test file, before the module under test runs. */
export function installDom(): Dom {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = document;
  g.window = window;
  g.HTMLElement = FakeElement;
  g.HTMLTextAreaElement = FakeTextArea;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  return {
    document,
    window,
    body: document.body,
    overlays: () => document.body.children.filter((c) => c.classList.contains("overlay")),
  };
}

function matchesAny(el: FakeElement, selector: string): boolean {
  return selector.split(",").some((part) => matchesPart(el, part.trim()));
}

function matchesPart(el: FakeElement, part: string): boolean {
  if (!part) return false;
  let rest = part;
  if (rest.startsWith(":scope")) rest = rest.replace(/^:scope\s*/i, "");
  const attr = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest);
  if (attr) return el.hasAttribute(attr[1]!) && (attr[2] === undefined || el.getAttribute(attr[1]!) === attr[2]);
  const classMatch = /\.([\w-]+)/.exec(rest);
  if (classMatch && !el.classList.contains(classMatch[1]!)) return false;
  const tag = rest.split(/[.#\[]/)[0]!.trim();
  if (tag && tag !== "*" && el.tagName !== tag.toUpperCase()) return false;
  return true;
}
