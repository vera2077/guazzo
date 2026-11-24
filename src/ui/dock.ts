// Dockable right-hand panel stack.
//
// Every card in the column is (a) collapsible from its header, (b) resizable by
// dragging the grip on its bottom edge, and the column itself is (c) resizable by
// dragging the divider against the canvas. Sizes and collapse state persist in one
// localStorage object, and double-clicking a grip resets just that card.
//
// It works on whatever cards already exist in #panels, because the cards are built
// by main.ts and ui/tonal.ts and this module should not care who made them.

import { iconSvg } from "./icons.ts";

const LS_STATE = "guazzo.panelState.v1";
const LS_WIDTH = "guazzo.panelWidth.v1";

const MIN_W = 210;
const MAX_W = 560;
const MIN_H = 64;
const MAX_H = 1200;
const DEFAULT_W = 296;

interface PanelState {
  heights: Record<string, number>;
  collapsed: string[];
}

interface Card {
  el: HTMLElement;
  key: string;
  grip: HTMLElement;
  head: HTMLElement;
  defClass: string;
  defHeight: string;
  defFlex: string;
  /** remembered even while collapsed, when the inline height is cleared */
  lastHeight: number | null;
}

const registries = new WeakMap<HTMLElement, Card[]>();

function readState(): PanelState {
  const empty: PanelState = { heights: {}, collapsed: [] };
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    const obj = parsed as { heights?: unknown; collapsed?: unknown };
    const heights: Record<string, number> = {};
    if (obj.heights && typeof obj.heights === "object") {
      for (const [k, v] of Object.entries(obj.heights as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) heights[k] = v;
      }
    }
    const collapsed = Array.isArray(obj.collapsed)
      ? obj.collapsed.filter((v): v is string => typeof v === "string")
      : [];
    return { heights, collapsed };
  } catch {
    return empty;
  }
}

function writeState(cards: Card[]): void {
  const heights: Record<string, number> = {};
  for (const c of cards) {
    const h = c.lastHeight ?? parseFloat(c.el.style.height);
    if (Number.isFinite(h) && h > 0) heights[c.key] = Math.round(h);
  }
  const state: PanelState = {
    heights,
    collapsed: cards.filter((c) => c.el.classList.contains("collapsed")).map((c) => c.key),
  };
  try {
    localStorage.setItem(LS_STATE, JSON.stringify(state));
  } catch {
    /* storage unavailable — resizing still works for this session */
  }
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(LS_WIDTH));
    return Number.isFinite(n) && n > 0 ? Math.max(MIN_W, Math.min(MAX_W, n)) : DEFAULT_W;
  } catch {
    return DEFAULT_W;
  }
}

function setWidth(host: HTMLElement, w: number): void {
  host.style.width = `${Math.round(Math.max(MIN_W, Math.min(MAX_W, w)))}px`;
}

/** The grip only makes sense on an expanded card. */
function syncGrip(c: Card): void {
  const collapsed = c.el.classList.contains("collapsed");
  c.grip.style.display = collapsed ? "none" : "";
  c.head.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function cardOf(el: HTMLElement): HTMLElement | null {
  return el.classList.contains("card") ? el : null;
}

/**
 * Make every card in `host` collapsible + resizable and add the column divider.
 * Safe to call again after new cards are appended.
 */
export function dockifyPanels(host: HTMLElement, onChange?: () => void): void {
  const state = readState();
  const cards: Card[] = [];

  for (const el of Array.from(host.children) as HTMLElement[]) {
    const card = cardOf(el);
    if (!card) continue;

    const head = (Array.from(card.children) as HTMLElement[]).find((c) =>
      c.classList.contains("card-head"),
    );
    if (!head) continue;

    // The title is the persistence key: stable, unique in this stack, and it
    // survives the panel bodies being rebuilt on every edit.
    const key = (card.dataset.cardKey ?? head.textContent ?? "").trim().toLowerCase();

    // ---- collapse control ------------------------------------------------
    // Chrome (chevron + grip) is rebuilt on every dockify pass — resetDock
    // re-runs this function after stripping it — but the head LISTENERS bind
    // exactly once per card (dockBound). A second binding would make every
    // click toggle twice: collapse would stop working after Reset.
    const staleChev = head.querySelector(".card-chev");
    if (staleChev) staleChev.remove();
    const chev = document.createElement("span");
    chev.className = "card-chev";
    chev.innerHTML = iconSvg("chevron-down", 13);
    head.appendChild(chev);
    head.classList.add("card-head-toggle");
    head.tabIndex = 0;
    head.setAttribute("role", "button");

    const toggle = (): void => {
      // Collapsing must actually SHRINK the card: clear the inline height
      // (remembering it first) so .grow cards stop stretching, and restore
      // it on expand. Leaving the height set kept an empty box behind (m07433 #4).
      const reg0 = registries.get(host);
      const entry0 = reg0?.find((x) => x.el === card) ?? null;
      const willCollapse = !card.classList.contains("collapsed");
      if (willCollapse) {
        const live = parseFloat(card.style.height);
        if (Number.isFinite(live) && entry0) entry0.lastHeight = live;
        card.style.height = "auto";
      } else if (entry0 && entry0.lastHeight !== null) {
        card.style.height = `${Math.round(Math.max(MIN_H, Math.min(MAX_H, entry0.lastHeight)))}px`;
        card.style.flex = "none";
      } else {
        card.style.height = "";
        card.style.flex = "";
      }
      card.classList.toggle("collapsed");
      const reg = registries.get(host);
      if (reg && reg.length) {
        const c = reg.find((x) => x.el === card);
        if (c) syncGrip(c);
        writeState(reg);
      }
      onChange?.();
    };
    if (card.dataset.dockBound !== "1") {
      card.dataset.dockBound = "1";
      head.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null;
        if (target && target.closest("button, input, select, .maskchip")) return;
        toggle();
      });
      head.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          // Otherwise the window shortcut layer also saw the key: Enter
          // committed a pen path or applied a crop, Space armed pan (uiux-r35).
          e.stopPropagation();
          toggle();
        }
      });
    }

    // ---- resize grip (a normal flex child, never an overlay) --------------
    const staleGrip = card.querySelector(".card-grip");
    if (staleGrip) staleGrip.remove();
    const grip = document.createElement("div");
    grip.className = "card-grip";
    grip.title = "Drag to resize · double-click to reset";
    grip.tabIndex = 0;
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", "Resize panel");
    card.appendChild(grip);

    const c: Card = {
      el: card,
      key,
      grip,
      head,
      defClass: card.className.replace(/ ?collapsed/g, ""),
      defHeight: card.style.height,
      defFlex: card.style.flex,
      lastHeight: typeof state.heights[key] === "number" ? state.heights[key]! : null,
    };
    cards.push(c);

    if (c.lastHeight !== null) {
      card.style.height = `${Math.round(Math.max(MIN_H, Math.min(MAX_H, c.lastHeight)))}px`;
      card.style.flex = "none";
    }
    if (state.collapsed.includes(key)) {
      card.classList.add("collapsed");
      card.style.height = "auto"; // boot-collapsed cards must not keep their box either
    }
    syncGrip(c);

    const applyHeight = (h: number): void => {
      const clamped = Math.round(Math.max(MIN_H, Math.min(MAX_H, h)));
      card.style.height = `${clamped}px`;
      card.style.flex = "none";
      c.lastHeight = clamped;
      if (card.classList.contains("collapsed")) card.classList.remove("collapsed");
      syncGrip(c);
    };

    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startH = card.getBoundingClientRect().height;
      const move = (ev: PointerEvent): void => applyHeight(startH + (ev.clientY - startY));
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        writeState(cards);
        onChange?.();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    grip.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 64 : 16;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const now = card.getBoundingClientRect().height;
      applyHeight(now + (e.key === "ArrowDown" ? step : -step));
      writeState(cards);
      onChange?.();
    });

    grip.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      card.className = c.defClass;
      card.style.height = c.defHeight;
      card.style.flex = c.defFlex;
      c.lastHeight = null;
      syncGrip(c);
      writeState(cards);
      onChange?.();
    });
  }

  // The registry is re-published per pass so listeners bound ONCE always
  // read the CURRENT card list (toggle/persist), never a stale closure.
  registries.set(host, cards);

  // ---- column divider ----------------------------------------------------
  let wg = host.querySelector<HTMLElement>(".panel-grip");
  if (!wg) {
    wg = document.createElement("div");
    wg.className = "panel-grip";
    wg.title = "Drag to resize the panel column · double-click to reset";
    wg.tabIndex = 0;
    wg.setAttribute("role", "separator");
    wg.setAttribute("aria-orientation", "vertical");
    wg.setAttribute("aria-label", "Resize panel column");
    host.appendChild(wg);
  }
  const divider = wg;
  setWidth(host, readWidth());

  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = host.getBoundingClientRect().width;
    const move = (ev: PointerEvent): void => setWidth(host, startW - (ev.clientX - startX));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(LS_WIDTH, String(Math.round(host.getBoundingClientRect().width)));
      } catch {
        /* session-only width */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  divider.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const now = host.getBoundingClientRect().width;
    setWidth(host, now + (e.key === "ArrowLeft" ? step : -step));
  });

  divider.addEventListener("dblclick", () => {
    setWidth(host, DEFAULT_W);
    try {
      localStorage.setItem(LS_WIDTH, String(DEFAULT_W));
    } catch {
      /* session-only width */
    }
  });
}

/**
 * View ▸ Reset Panel Layout: forget stored sizes and put every card back, without
 * a reload (a reload would throw away undo history and unsaved edits).
 */
export function resetDock(host: HTMLElement, onChange?: () => void): void {
  try {
    localStorage.removeItem(LS_STATE);
    localStorage.removeItem(LS_WIDTH);
  } catch {
    /* nothing stored */
  }
  for (const el of Array.from(host.children) as HTMLElement[]) {
    if (!el.classList.contains("card")) continue;
    el.classList.remove("collapsed");
    el.style.height = "";
    el.style.flex = "";
    for (const node of Array.from(el.children) as HTMLElement[]) {
      if (node.classList.contains("card-grip")) node.remove();
      if (node.classList.contains("card-head")) {
        node.classList.remove("card-head-toggle");
        for (const k of Array.from(node.children) as HTMLElement[]) {
          if (k.classList.contains("card-chev")) k.remove();
        }
      }
    }
    delete el.dataset.docked;
  }
  setWidth(host, DEFAULT_W);
  dockifyPanels(host, onChange);
  onChange?.();
}

/** Show/hide the panel column (Tab), the way Photoshop's Tab does. */
export function togglePanels(force?: boolean): boolean {
  const host = document.getElementById("panels");
  if (!host) return false;
  host.classList.toggle("panel-hidden", force === undefined ? undefined : !force);
  return !host.classList.contains("panel-hidden");
}
