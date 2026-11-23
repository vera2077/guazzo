// Menu-popup primitives, extracted from main.ts (rewrite step 2).
//
// fillPop renders the rows, owns the side-submenu placement (FIXED, not
// absolute: the pop itself scrolls, and an ancestor with overflow clips an
// absolutely positioned child — that bug hid the Blending submenu for weeks),
// and dispatches each row's run(). showContextMenu renders the same rows into a
// body-level pop so a right-click menu can float over the tabs.
//
// The menu BAR lives here too (buttons, flyouts, open-state), so closing one
// surface (bar, context menu, submenu) is this module's own business: the shell
// only mounts the bar and supplies the definitions via mountMenuBar().

import { iconSvg, type IconName } from "./icons.ts";

export type MenuItem = {
  label?: string;
  key?: string;
  icon?: IconName;
  run?: () => void;
  children?: MenuItem[];
  sep?: boolean;
  header?: string;
  disabled?: boolean;
  /** shown as the row's tooltip when `disabled`: "why can't I run this?" */
  why?: string;
  /** renders a check mark in front of the label */
  checked?: boolean;
};

export interface PopOptions { label?: string; escape?: () => void; opener?: HTMLElement | null }

/**
 * Where focus goes when a pop closes. The click target is often a label span
 * inside a layer row: focusing it does nothing, so Escape dropped focus to
 * <body> and the keyboard user lost their place. Walk up to the nearest thing
 * that can hold focus (the row carries tabindex) and return that.
 */
function focusAnchorOf(target: EventTarget | null): HTMLElement | null {
  let el = target as HTMLElement | null;
  if (!el || typeof el.focus !== "function") return null;
  const focusable = (n: HTMLElement | null): boolean =>
    !!n && (n.hasAttribute?.("tabindex") || n.tagName === "BUTTON" ||
      n.tagName === "INPUT" || n.tagName === "SELECT" || n.tagName === "TEXTAREA");
  if (focusable(el)) return el;
  for (let up = el.parentElement; up; up = up.parentElement) if (focusable(up)) return up;
  return el;
}

/** side submenu openers, keyed by their parent row: the keyboard path needs the
 *  same placement the pointer path does. */
const subOpeners = new WeakMap<HTMLElement, () => void>();

export function fillPop(pop: HTMLElement, items: MenuItem[], opts?: PopOptions): void {
  pop.innerHTML = "";
  pop.setAttribute("role", "menu");
  pop.setAttribute("aria-label", opts?.label ?? "Menu");
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement("div");
      d.className = "menu-sep";
      pop.appendChild(d);
      continue;
    }
    if (it.header) {
      const h = document.createElement("div");
      h.className = "menu-head";
      h.textContent = it.header;
      pop.appendChild(h);
      continue;
    }
    const row = document.createElement("div");
    row.className = "menu-item" + (it.children ? " sub" : "") + (it.disabled ? " disabled" : "");
    // ui11: a greyed row with no explanation leaves the user guessing. A
    // disabled .menu-item used to be pointer-events:none, which also killed
    // this tooltip.
    if (it.disabled && it.why) row.title = it.why;
    // AU8: a row that can be checked is a checkbox item and must SAY whether it
    // is checked; a plain menuitem with a tick glyph tells a screen reader
    // nothing, and the state is the only thing the user came for.
    if (it.checked !== undefined) {
      row.setAttribute("role", "menuitemcheckbox");
      row.setAttribute("aria-checked", it.checked ? "true" : "false");
    } else {
      row.setAttribute("role", "menuitem");
    }
    row.tabIndex = -1;
    if (it.disabled) row.setAttribute("aria-disabled", "true");
    if (it.children) row.setAttribute("aria-haspopup", "true");
    const ico = document.createElement("span");
    ico.className = "mi-ico";
    if (it.icon) ico.innerHTML = iconSvg(it.icon, 14);
    else if (it.checked) ico.innerHTML = iconSvg("check", 13);
    const label = document.createElement("span");
    label.className = "mi-label";
    label.textContent = it.label ?? "";
    row.append(ico, label);
    if (it.children) {
      const chev = document.createElement("span");
      chev.className = "key";
      chev.textContent = "›";
      row.appendChild(chev);
      const sub = document.createElement("div");
      sub.className = "menu-pop menu-sub";
      // ui12 #8: Escape inside a submenu must step back to the parent row. It
      // used to inherit the bar's Escape, so one Escape from a nested Blending
      // lost the whole menu the user had navigated into.
      fillPop(sub, it.children, {
        label: it.label,
        escape: () => { row.classList.remove("open"); row.focus(); },
      });
      row.appendChild(sub);

      // A menu pop scrolls (overflow-y:auto), and an ancestor with overflow
      // CLIPS an absolutely positioned child — which is why hovering Blending
      // showed nothing. The submenu is therefore position:fixed and placed by
      // hand, so it escapes the clip and flips at the viewport edges.
      const placeSub = (): void => {
        const r = row.getBoundingClientRect();
        sub.style.visibility = "hidden";
        row.classList.add("open");
        const w = sub.offsetWidth || 212;
        const h = sub.offsetHeight || 0;
        let x = r.right + 2;
        if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - 2);
        let y = r.top - 5;
        if (h > 0 && y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
        sub.style.left = `${x}px`;
        sub.style.top = `${y}px`;
        sub.style.visibility = "";
      };
      const closeSub = (): void => { row.classList.remove("open"); };
      const openSub = (): void => {
        if (row.classList.contains("open")) return;
        for (const sib of Array.from(pop.children)) {
          if (sib !== row && sib.classList.contains("open")) sib.classList.remove("open");
        }
        placeSub();
      };
      subOpeners.set(row, openSub);
      row.addEventListener("pointerenter", openSub);
      row.addEventListener("pointerleave", () => {
        // moving right into the submenu must not close it
        if (!sub.matches(":hover")) closeSub();
      });
      sub.addEventListener("pointerleave", closeSub);
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (row.classList.contains("open")) closeSub();
        else openSub();
      });
    } else if (it.key) {
      const k = document.createElement("span");
      k.className = "key";
      k.textContent = it.key;
      row.appendChild(k);
    }
    if (!it.children && it.run && !it.disabled) {
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        // Focus the bar button before running: the row is gone by then, and a
        // modal records the hidden row as its opener, so its close-time focus
        // restore lands nowhere and the user is dropped to <body>.
        opts?.opener?.focus();
        closeMenus();
        it.run!();
      });
    }
    pop.appendChild(row);
  }
  // keyboard navigation (handoff-3 S2): arrows cycle the items, Enter opens a
  // submenu or activates, Escape closes and hands focus back to the opener.
  pop.addEventListener("keydown", (e) => {
    const key = e.key;
    const ae = (document as { activeElement?: Element | null }).activeElement ?? null;
    // pop.children is an HTMLCollection in a real browser (no .filter/.find) —
    // the old cast to HTMLElement[] claimed array methods that do not exist and
    // threw "pop.children.filter is not a function" on the first keydown.
    // ui11: navigation must skip dead rows. Collecting every .menu-item made
    // ArrowDown land on a greyed command, where Enter did nothing and said
    // nothing — four presses to cross a disabled pair.
    const rows = menuRows(pop);
    if (rows.length === 0) return;
    if (key === "Escape") {
      e.stopPropagation();
      (opts?.escape ?? closeMenus)();
      opts?.opener?.focus();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      e.preventDefault();
      // AS1: preventDefault alone left the window-level shortcut listener free to
      // run as well, so every ArrowDown while browsing a menu also nudged the
      // active layer by a pixel and pushed a "Nudge" history entry.
      e.stopPropagation();
      const cur = rows.findIndex((r) => r === ae);
      let next: number;
      if (key === "Home") next = 0;
      else if (key === "End") next = rows.length - 1;
      else if (key === "ArrowDown") next = cur < 0 ? 0 : (cur + 1) % rows.length;
      else next = cur < 0 ? rows.length - 1 : (cur - 1 + rows.length) % rows.length;
      rows[next]!.focus();
      return;
    }
    if (key === "ArrowLeft" && pop.classList.contains("menu-sub")) {
      // Inside a submenu the left arrow steps back to the row that owns it —
      // the same place Escape goes, without closing the whole bar (uiux-r8 #5).
      e.preventDefault();
      e.stopPropagation();
      (opts?.escape ?? closeMenus)();
      return;
    }
    if (key === "ArrowRight" || key === "ArrowLeft") {
      // Photoshop convention: the arrows walk the menu bar while a menu is
      // open. Without it the only way out of a 12-item File menu was Escape and
      // a mouse (uiux-r6).
      e.preventDefault();
      e.stopPropagation();
      // No closest() here: the menu shim used by the smoke has no such method,
      // and the root is one hop up anyway (`.menu` > button + pop).
      const root = pop.parentNode as HTMLElement | null;
      const bar = (root?.parentNode ?? null) as HTMLElement | null;
      if (!root || !bar || !root.classList.contains("menu")) return;
      const menus = Array.from(bar.children).filter(
        (c): c is HTMLElement => (c as HTMLElement).classList?.contains("menu") === true,
      );
      const at = menus.indexOf(root as HTMLElement);
      if (at < 0 || menus.length < 2) return;
      const nextRoot = menus[(at + (key === "ArrowRight" ? 1 : menus.length - 1)) % menus.length]!;
      const wantTitle = nextRoot.children[0]?.textContent ?? "";
      // closeMenus() re-renders the strip, so the button captured above is
      // detached by the time we would click it. Re-find the title afterwards.
      closeMenus();
      const live = Array.from(bar.children).find(
        (c): c is HTMLElement =>
          (c as HTMLElement).classList?.contains("menu") === true &&
          (c as HTMLElement).children[0]?.textContent === wantTitle,
      );
      const opener = live?.children[0] as HTMLElement | undefined;
      opener?.click();
      const nextPop = live?.children[1];
      const nextRows = nextPop ? menuRows(nextPop) : [];
      nextRows[0]?.focus();
      return;
    }
    if (key === "Enter" || key === " ") {
      const cur = rows.find((r) => r === ae);
      if (!cur || cur.classList.contains("disabled")) return;
      e.preventDefault();
      const sub = cur.querySelector<HTMLElement>(":scope > .menu-sub");
      if (sub) {
        if (cur.classList.contains("open")) cur.classList.remove("open");
        else subOpeners.get(cur)?.();
        (Array.from(sub.children).find((c) => c.classList.contains("menu-item")) as HTMLElement | undefined)?.focus();
        return;
      }
      cur.click();
    }
  });
}

// ---------------------------------------------------------------------------
// Right-click context menus (Photoshop-style, per-surface)
// ---------------------------------------------------------------------------

/** open (or null when closed) context pop; tracked so Escape and outside
 *  pointerdowns can dismiss it. */
let ctxPop: HTMLElement | null = null;

/** The main window asks this to keep its document-level dismisser honest. */
export function hideContextMenu(): void {
  if (ctxPop) { ctxPop.remove(); ctxPop = null; }
}

export function contextMenuOpen(): boolean { return ctxPop !== null; }

export function showContextMenu(ev: MouseEvent, items: MenuItem[]): void {
  ev.preventDefault();
  ev.stopPropagation();
  closeMenus();
  const pop = document.createElement("div");
  pop.className = "menu-pop context-pop";
  fillPop(pop, items, { label: "Context menu", escape: hideContextMenu, opener: focusAnchorOf(ev.target) });
  document.body.appendChild(pop);
  // clamp inside the viewport (ev may carry junk clientX/Y in synthetic tests)
  const x = Number.isFinite(ev.clientX) ? ev.clientX : 0;
  const y = Number.isFinite(ev.clientY) ? ev.clientY : 0;
  const maxX = Math.max(8, window.innerWidth - pop.offsetWidth - 8);
  const maxY = Math.max(8, window.innerHeight - pop.offsetHeight - 8);
  pop.style.left = `${Math.min(x, maxX)}px`;
  pop.style.top = `${Math.min(y, maxY)}px`;
  ctxPop = pop;
  focusMenuRow(pop);
}

/**
 * X2 (handoff-4): the Menu key / Shift+F10 must open the same context menu the
 * pointer would. Runs the surface's own handler at the focused element's rect.
 */

export function menuRows(pop: Element | null | undefined): HTMLElement[] {
  if (!pop) return [];
  // Walk DIRECT children: a submenu's rows live inside its own .menu-pop and
  // must not enter the parent's Arrow order (querySelectorAll would include them).
  const rows: HTMLElement[] = [];
  for (const child of Array.from(pop.children)) {
    if (!child.classList.contains("menu-item")) continue;
    if (child.classList.contains("disabled")) continue;
    rows.push(child as HTMLElement);
  }
  return rows;
}

export function focusMenuRow(pop: Element | null | undefined, where: "first" | "last" = "first"): void {
  const rows = menuRows(pop);
  if (rows.length === 0) return;
  (where === "first" ? rows[0] : rows[rows.length - 1])!.focus();
}

// ---------------------------------------------------------------------------
// Menu bar (the File/Edit/... strip). Owned here so the bar and the context
// menus share one "what is open" state: Escape, outside clicks and opening one
// surface all close the other without the shell handing over a callback.
// ---------------------------------------------------------------------------

export interface MenuDef { title: string; items: MenuItem[] }

let menuHost: HTMLElement | null = null;
let menuDefsFn: (() => MenuDef[]) | null = null;
let menuOpenTitle: string | null = null;
const menuRoots = new Map<string, HTMLElement>();

export function menusOpen(): boolean { return ctxPop !== null || menuOpenTitle !== null; }

export function contextMenuOwns(n: Node): boolean { return ctxPop !== null && ctxPop.contains(n); }

export function closeMenus(): void {
  hideContextMenu();
  for (const root of menuRoots.values()) {
    root.classList.remove("open");
    root.children[0]?.classList.remove("open");
  }
  for (const row of Array.from(document.querySelectorAll<HTMLElement>(".menu-item.sub.open"))) {
    row.classList.remove("open");
  }
  menuOpenTitle = null;
  syncMenuBarExpanded();
}

/** Rebuild the strip in place. Rebuilding keeps Undo/Redo/Merge availability fresh. */
// A4: the bar is a menu bar, not five unrelated buttons. The roles are the
// contract a screen reader reads, and Left/Right between top-level menus is
// what makes it navigable without a pointer.
function syncMenuBarExpanded(): void {
  for (const [title, root] of menuRoots) {
    root.children[0]?.setAttribute("aria-expanded", menuOpenTitle === title ? "true" : "false");
  }
}

export function refreshMenuBar(): void {
  if (!menuHost || !menuDefsFn) return;
  menuHost.innerHTML = "";
  menuHost.setAttribute("role", "menubar");
  menuHost.setAttribute("aria-label", "Main menu");
  menuRoots.clear();
  for (const def of menuDefsFn()) {
    const root = document.createElement("div");
    root.className = "menu";
    const btn = document.createElement("button");
    btn.className = "menu-btn";
    btn.textContent = def.title;
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    const pop = document.createElement("div");
    pop.className = "menu-pop";
    fillPop(pop, def.items, { label: def.title, escape: closeMenus, opener: btn });
    root.append(btn, pop);
    menuRoots.set(def.title, root);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menuOpenTitle === def.title) closeMenus();
      else openMenu(def.title);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        // Top-level navigation: move along the bar, opening as we land, the way
        // a menu bar behaves in every other application on the platform.
        const titles = [...menuRoots.keys()];
        const at = titles.indexOf(def.title);
        const step = e.key === "ArrowRight" ? 1 : titles.length - 1;
        const next = titles[(at + step) % titles.length];
        e.preventDefault();
        // Focus follows the bar (the smoke asserts it), and a menu that is
        // open opens on the next title as we land. The first command is reached
        // with ArrowDown, exactly as it is from a closed bar.
        if (menuOpenTitle !== null && next) openMenu(next);
        (menuRoots.get(next ?? "")?.children[0] as HTMLElement | undefined)?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      if (menuOpenTitle !== def.title) openMenu(def.title);
      focusMenuRow(menuRoots.get(def.title)?.children[1], e.key === "ArrowDown" ? "first" : "last");
    });
    btn.addEventListener("pointerenter", () => {
      if (menuOpenTitle !== null && menuOpenTitle !== def.title) openMenu(def.title);
    });
    menuHost.appendChild(root);
  }
}

/** Rebuild + open one menu, so its rows reflect the current undo/redo state. */
function openMenu(title: string): void {
  refreshMenuBar();
  const root = menuRoots.get(title);
  if (!root) return;
  root.classList.add("open");
  root.children[0]?.classList.add("open");
  menuOpenTitle = title;
  syncMenuBarExpanded();
  // keyboard users land on the first command, not on a button that does nothing
  focusMenuRow(root.children[1]);
}

/** Install the strip into `host` and take ownership of outside-click dismissal. */
export function mountMenuBar(host: HTMLElement, defs: () => MenuDef[]): void {
  menuHost = host;
  menuDefsFn = defs;
  refreshMenuBar();
  // window, not document: a bubbling pointerdown reaches both in a browser,
  // and the smoke DOM shim only forwards window listeners — the outside-click
  // rule has to stay testable, not just true.
  window.addEventListener("pointerdown", (e) => {
    const target = e.target as Node | null;
    if (target && contextMenuOwns(target)) return;
    if (menuHost && target && !menuHost.contains(target)) closeMenus();
  });
}
