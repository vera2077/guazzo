/**
 * windowchrome.ts — the frameless window's own controls.
 *
 * DOM ownership (step 4): the shell hands over its top strip and never sees the
 * buttons again. The chrome owns the find button, the caption buttons, the drag
 * region and the seven resize grips; it does not own the shell's *decisions*.
 *
 * Two of those decisions arrive as callbacks on purpose:
 *  - close must run the unsaved-changes guard (AB2). Calling `windowClose()`
 *    here would delete the guard, so the module has no import of it at all.
 *  - Find opens the command palette, whose entries are built from the shell's
 *    menus (`buildPaletteEntries`). The chrome must not import `src/main.ts`
 *    (static pin), so the opener is a dependency, not a re-implementation.
 *
 * A "mount(host)" that took no dependencies could only do this by bypassing the
 * close guard or by re-growing a callback registry inside the module — the
 * exact pattern R3 removed from the menu bar.
 *
 * AE1/AE2 rationale travels with the code: the frameless window loses
 * WS_THICKFRAME so the grips are rebuilt by hand, and there is deliberately no
 * dblclick handler — `start_dragging()` hands the click to the window manager,
 * and Windows already maximises a caption double-click (adding our own produced
 * maximise-then-restore, which looked like nothing happened).
 */
import { iconSvg, type IconName } from "./icons.ts";
import {
  isTauri,
  windowMinimize,
  windowStartDrag,
  windowStartResize,
  windowToggleMaximize,
} from "./native.ts";

export interface WindowChromeDeps {
  /** The shell's guarded close path: asks before losing unsaved work. */
  onClose: () => void;
  /** Opens the command palette; its entries belong to the shell. */
  openPalette: () => void;
}

/** The strip is the title bar: drag on empty space, not on a control. */
function onControl(t: EventTarget | null): boolean {
  return !!(t as HTMLElement | null)?.closest("button, a, input, select, textarea, .menu");
}

async function toggleMaximise(btn: HTMLButtonElement): Promise<void> {
  const maximised = await windowToggleMaximize();
  btn.innerHTML = iconSvg(maximised ? "win-restore" : "win-max", 15);
  btn.title = maximised ? "Restore down" : "Maximise";
  btn.setAttribute("aria-label", btn.title);
}

function buildFindButton(host: HTMLElement, openPalette: () => void): void {
  const wrap = document.createElement("div");
  wrap.className = "topfind";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn icon subtle tbfind";
  b.innerHTML = iconSvg("search", 15);
  const title = "Find tools and actions (Ctrl/Cmd+K)";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", openPalette);
  wrap.appendChild(b);
  host.appendChild(wrap);
}

function buildCaptionButtons(host: HTMLElement, deps: WindowChromeDeps): void {
  const bar = document.createElement("div");
  bar.className = "winctl";
  const button = (
    icon: IconName,
    title: string,
    run: (btn: HTMLButtonElement) => void,
    extra = "",
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "winbtn" + (extra ? " " + extra : "");
    b.innerHTML = iconSvg(icon, 15);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", () => run(b));
    bar.appendChild(b);
    return b;
  };
  button("win-min", "Minimise", () => void windowMinimize());
  button("win-max", "Maximise / restore", (btn) => void toggleMaximise(btn));
  button("win-close", "Close", () => deps.onClose(), "danger");
  host.appendChild(bar);
}

function buildResizeGrips(): void {
  // Frameless windows lose WS_THICKFRAME, so rebuild the grips by hand.
  // There is deliberately no "n" edge: the whole top strip is the caption
  // (drag / menu bar / window buttons), and an invisible grab strip there was
  // stealing clicks from the menu bar. Seven edges, and the CSS keeps them
  // BELOW menus so a pop can never be un-clickable at the window edge.
  const edges: [string, string][] = [
    ["w", "ew-resize"], ["e", "ew-resize"], ["s", "ns-resize"],
    ["nw", "nwse-resize"], ["ne", "nesw-resize"], ["sw", "nesw-resize"], ["se", "nwse-resize"],
  ];
  for (const [dir, cursor] of edges) {
    const d = document.createElement("div");
    d.className = "rs-edge rs-" + dir;
    d.style.cursor = cursor;
    d.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void windowStartResize(dir);
    });
    document.body.appendChild(d);
  }
}

/**
 * Mounts the chrome into `host` (the top strip).
 *
 * Callable outside Tauri: the find button is part of the browser build too,
 * while the caption buttons and grips only make sense with a native window.
 * Keeping that gate inside the module means the smoke build still mounts it.
 */
export function mountWindowChrome(host: HTMLElement, deps: WindowChromeDeps): void {
  buildFindButton(host, deps.openPalette);
  if (!isTauri()) return;

  buildCaptionButtons(host, deps);
  host.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (onControl(e.target)) return;
    void windowStartDrag();
  });
  buildResizeGrips();
}
