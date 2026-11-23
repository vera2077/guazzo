// The command palette (Ctrl/Cmd+K), extracted from main.ts (rewrite step 3).
//
// It renders; it does not decide what exists. The entry list is passed in, which
// is what keeps the palette honest: tools come from the tool table and actions
// come from the real menus, so a menu item that is removed cannot linger here.

import { enterModalLayer, leaveModalLayer } from "./dialogs.ts";
import { TOOL_IDS, TOOL_LABELS, type ToolId } from "./toollabels.ts";
import type { MenuItem } from "./popup.ts";

export interface PaletteEntry {
  /** unavailable right now (the menu greys these out) */
  disabled?: boolean;
  /** why it is unavailable — shown when the user tries to run it anyway */
  why?: string;
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
        // A menu greys out what is unavailable (Undo with empty history, Merge
        // Down on the bottom layer). Listing it as live here would contradict
        // the menu the palette claims to mirror.
        disabled: it.disabled === true,
        why: it.why,
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
  // The active row is announced through the FOCUSED element, so the input has
  // to be the combobox that owns the listbox (aria-activedescendant on an
  // unfocused list announces nothing).
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", "palette-list");

  const note = document.createElement("div");
  note.className = "palette-note";
  note.hidden = true;

  const list = document.createElement("div");
  list.id = "palette-list";
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
      // Tool labels already name their shortcut ("Move (V)"); printing the key
      // span too made the row read "Move (V) … V" (uiux-r9 #5).
      const keyInLabel = e.label.includes(`(${e.key})`);
      if (e.key && !keyInLabel) {
        const k = document.createElement("span");
        k.className = "pal-key";
        k.textContent = e.key;
        row.appendChild(k);
      }
      row.addEventListener("pointerenter", () => { active = i; paintActive(); });
      if (shown[i]?.disabled) {
        row.setAttribute("aria-disabled", "true");
        row.classList.add("disabled");
        row.addEventListener("click", () => {
          // A greyed row used to swallow the click; Enter explains it. Mouse
          // users get the same sentence (uiux-r9 #4).
          note.textContent = shown[i]?.why ?? "That command is not available for the current layer or selection.";
          note.hidden = false;
          note.setAttribute("role", "status");
        });
      } else {
        row.addEventListener("click", () => close(true));
      }
      list.appendChild(row);
    });
    input.setAttribute("aria-activedescendant", `pal-row-${active}`);
  };

  const paintActive = () => {
    const rows = Array.from(list.querySelectorAll(".palette-row"));
    rows.forEach((r, i) => {
      r.classList.toggle("active", i === active);
      r.setAttribute("aria-selected", i === active ? "true" : "false");
    });
    rows[active]?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", `pal-row-${active}`);
  };

  let closed = false;
  const close = (runIt: boolean) => {
    if (closed) return;
    const chosen = shown[active];
    // ui11: a greyed row that silently closes the palette reads as a command
    // that ran and did nothing. Keep the palette open and say why.
    if (runIt && chosen?.disabled) {
      note.textContent = chosen.why ?? "That command is not available for the current layer or selection.";
      note.hidden = false;
      note.setAttribute("role", "status");
      return;
    }
    // ui12 (critical): this used to run BEFORE the disabled check, so one Enter
    // on a greyed row set the latch and then returned — the palette could never
    // be closed again (no Escape, no click-out, no close button), and because
    // it stays registered as a modal every accelerator was suppressed.
    closed = true;
    overlay.remove();
    leaveModalLayer(overlay);
    if (opener && opener.isConnected) opener.focus();
    window.removeEventListener("keydown", onKey, true);
    if (runIt && chosen && !chosen.disabled) chosen.run();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (closed) return;
    // ui12: aria-modal is a promise. The rows are not focusable, so Tab had
    // nowhere to go but the canvas behind the overlay; keep it on the input.
    if (ev.key === "Tab") { ev.preventDefault(); return; }
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
  panel.append(input, list, note);
  overlay.addEventListener("pointerdown", (ev) => { if (ev.target === overlay) close(false); });
  document.body.appendChild(overlay);
  // AU9: remember who opened the palette; closing it must put focus back
  // there instead of dropping the caret on <body>.
  const opener = document.activeElement as HTMLElement | null;
  enterModalLayer(overlay);
  window.addEventListener("keydown", onKey, true);
  input.addEventListener("input", () => { active = 0; render(); });
  render();
  input.focus();
}

