// Menu-popup primitives, extracted from main.ts (rewrite step 2).
//
// fillPop renders the rows, owns the side-submenu placement (FIXED, not
// absolute: the pop itself scrolls, and an ancestor with overflow clips an
// absolutely positioned child — that bug hid the Blending submenu for weeks),
// and dispatches each row's run(). showContextMenu renders the same rows into a
// body-level pop so a right-click menu can float over the tabs.
//
// The one thing this module does not own is the menu BAR: closing it needs the
// main window's open-state, so the owner passes closeAllMenus to initPopup().

import { iconSvg, type IconName } from "./icons.ts";

let popupHost: PopupHost = {
  // Replaced by initPopup() during boot. The placeholder keeps the popup usable
  // in the smoke harness, which imports the bundle before any menu bar exists.
  closeAllMenus: () => {},
};

export type MenuItem = {
  label?: string;
  key?: string;
  icon?: IconName;
  run?: () => void;
  children?: MenuItem[];
  sep?: boolean;
  header?: string;
  disabled?: boolean;
  /** renders a check mark in front of the label */
  checked?: boolean;
};

export interface PopOptions { label?: string; escape?: () => void; opener?: HTMLElement | null }

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
    row.setAttribute("role", "menuitem");
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
      fillPop(sub, it.children);
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
        popupHost.closeAllMenus?.();
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
    const rows = Array.from(pop.children).filter((c) => c.classList.contains("menu-item")) as HTMLElement[];
    if (rows.length === 0) return;
    if (key === "Escape") {
      e.stopPropagation();
      (opts?.escape ?? (() => { popupHost.closeAllMenus?.(); }))();
      opts?.opener?.focus();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      e.preventDefault();
      const cur = rows.findIndex((r) => r === ae);
      let next: number;
      if (key === "Home") next = 0;
      else if (key === "End") next = rows.length - 1;
      else if (key === "ArrowDown") next = cur < 0 ? 0 : (cur + 1) % rows.length;
      else next = cur < 0 ? rows.length - 1 : (cur - 1 + rows.length) % rows.length;
      rows[next]!.focus();
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

/**
 * AN3: ownership of a pointer target. Main used to re-derive this with
 * `document.querySelector(".context-pop")`, which meant two places knew the
 * popup's DOM contract. The module that creates the pop owns the question.
 */
export function contextMenuOwns(target: Node | null | undefined): boolean {
  return !!(ctxPop && target && ctxPop.contains(target));
}

/**
 * AN1: the popup needs one thing from its owner — "a context menu opening must
 * also close the menu bar". That used to be injected by a global setter called
 * from main's module tail, which meant the popup worked in the test harness (no
 * setter) and only half-worked in the app. It is now a construction option:
 * forgetting to pass it is visible at the call site instead of silent.
 */
export interface PopupHost {
  /**
   * Close the menu bar and any open flyout.
   *
   * REQUIRED on purpose (handoff-7 AN1 / definition of done #7). While this was
   * optional, omitting it compiled fine and a context menu could open on top of
   * an open menu. Now the app does not compile without it.
   */
  closeAllMenus: () => void;
}
export function initPopup(options: PopupHost): void {
  popupHost = { ...options };
}


export function showContextMenu(ev: MouseEvent, items: MenuItem[]): void {
  ev.preventDefault();
  ev.stopPropagation();
  popupHost.closeAllMenus?.();
  const pop = document.createElement("div");
  pop.className = "menu-pop context-pop";
  fillPop(pop, items, { label: "Context menu", escape: hideContextMenu, opener: ev.target instanceof HTMLElement ? ev.target : null });
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
