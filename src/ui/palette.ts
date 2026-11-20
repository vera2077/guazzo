// The command palette (Ctrl/Cmd+K), extracted from main.ts (rewrite step 3).
//
// It renders; it does not decide what exists. The entry list is passed in, which
// is what keeps the palette honest: tools come from the tool table and actions
// come from the real menus, so a menu item that is removed cannot linger here.

import { enterModal, leaveModal } from "./dialogs.ts";
import { TOOL_IDS, TOOL_LABELS, type ToolId } from "./toollabels.ts";
import type { MenuItem } from "./popup.ts";

export interface PaletteEntry {
  label: string;
  group: string;
  key?: string;
  run: () => void;
}

export interface PaletteDeps {
  /** the real menu tree, so actions cannot drift from the menus */
  menus: { title: string; items: MenuItem[] }[];
  /**
   * Fallback dispatcher, used only for an item that has no closure of its own.
   * It resolves labels through the app's registered actions, which is why it is
   * NOT the primary path any more (see the AI5 note in `walk`).
   */
  runTop: (label: string) => void;
  selectTool: (id: ToolId) => void;
  statusHint: (text: string) => void;
}

export function buildPaletteEntries(deps: PaletteDeps): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const id of TOOL_IDS) {
    out.push({
      label: TOOL_LABELS[id],
      group: "Tools",
      // a tool's shortcut is inside its label: "Move (V)" / "Quick Selection (Shift+W)"
      key: /\(([^)]+)\)$/.exec(TOOL_LABELS[id])?.[1],
      run: () => {
        deps.selectTool(id);
        // the status line is part of the feedback loop: a tool that switches
        // silently looks like the click did nothing (regression caught in review)
        deps.statusHint(`${TOOL_LABELS[id]} selected`);
      },
    });
  }
  const walk = (group: string, items: MenuItem[]) => {
    for (const it of items) {
      if (it.sep) continue;
      if (it.children) {
        walk(`${group} \u203a ${it.label ?? ""}`, it.children);
        continue;
      }
      if (!it.label || !it.run) continue;
      const action = it.run;
      out.push({
        label: it.label.replace(/\u2026$/, ""),
        group,
        key: it.key,
        // AI5: run the item's OWN closure. Resolving the label through runTop()
        // only reached File and Image actions, so ~75 of ~110 rows (every Layer,
        // Select, Filter and View entry) did nothing when chosen — the row looked
        // live because it was listed.
        run: () => { action(); },
      });
    }
  };
  for (const menu of deps.menus) walk(menu.title, menu.items);
  return out;
}

export function openCommandPalette(entries: PaletteEntry[]): void {
  if (document.querySelector(".palette")) return;
  const overlay = document.createElement("div");
  overlay.className = "overlay palette-overlay";
  const panel = document.createElement("div");
  panel.className = "palette";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Search tools and actions");

  const input = document.createElement("input");
  input.type = "search";
  input.className = "palette-input";
  input.placeholder = "Search tools and actions…";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Search tools and actions");

  const list = document.createElement("div");
  list.className = "palette-list";
  list.setAttribute("role", "listbox");

  let shown: PaletteEntry[] = entries;
  let active = 0;

  const matches = (e: PaletteEntry, q: string): boolean => {
    if (!q) return true;
    const hay = `${e.label} ${e.group} ${e.key ?? ""}`.toLowerCase();
    // every whitespace-separated term must appear somewhere (order-independent)
    return q.split(/\s+/).every((t) => hay.includes(t));
  };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = entries.filter((e) => matches(e, q));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = "";
    list.setAttribute("aria-activedescendant", "");
    if (shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "No matching tool or action.";
      list.appendChild(empty);
      return;
    }
    let lastGroup = "";
    shown.forEach((e, i) => {
      if (e.group !== lastGroup) {
        lastGroup = e.group;
        const head = document.createElement("div");
        head.className = "palette-group";
        head.textContent = e.group;
        list.appendChild(head);
      }
      const row = document.createElement("div");
      row.className = "palette-row" + (i === active ? " active" : "");
      row.id = `pal-row-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === active ? "true" : "false");
      const name = document.createElement("span");
      name.className = "pal-name";
      name.textContent = e.label;
      row.appendChild(name);
      if (e.key) {
        const k = document.createElement("span");
        k.className = "pal-key";
        k.textContent = e.key;
        row.appendChild(k);
      }
      row.addEventListener("pointerenter", () => { active = i; paintActive(); });
      row.addEventListener("click", () => close(true));
      list.appendChild(row);
    });
    list.setAttribute("aria-activedescendant", `pal-row-${active}`);
  };

  const paintActive = () => {
    const rows = Array.from(list.querySelectorAll(".palette-row"));
    rows.forEach((r, i) => {
      r.classList.toggle("active", i === active);
      r.setAttribute("aria-selected", i === active ? "true" : "false");
    });
    rows[active]?.scrollIntoView({ block: "nearest" });
    list.setAttribute("aria-activedescendant", `pal-row-${active}`);
  };

  let closed = false;
  const close = (runIt: boolean) => {
    if (closed) return;
    closed = true;
    const chosen = shown[active];
    overlay.remove();
    leaveModal();
    if (opener && opener.isConnected) opener.focus();
    window.removeEventListener("keydown", onKey, true);
    if (runIt && chosen) chosen.run();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(false); return; }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      active = Math.min(shown.length - 1, active + 1);
      paintActive();
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      active = Math.max(0, active - 1);
      paintActive();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      close(true);
    }
  };

  overlay.appendChild(panel);
  panel.append(input, list);
  overlay.addEventListener("pointerdown", (ev) => { if (ev.target === overlay) close(false); });
  document.body.appendChild(overlay);
  // AU9: remember who opened the palette; closing it must put focus back
  // there instead of dropping the caret on <body>.
  const opener = document.activeElement as HTMLElement | null;
  enterModal();
  window.addEventListener("keydown", onKey, true);
  input.addEventListener("input", () => { active = 0; render(); });
  render();
  input.focus();
}

