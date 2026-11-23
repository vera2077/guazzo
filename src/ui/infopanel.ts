/**
 * The Info card: where the pointer is, what colour is under it, and how big the
 * selection is. Photoshop's Info panel is a read-out, not a control — nothing
 * here changes the document, so it can be updated at pointer speed.
 */
export interface InfoSnapshot {
  x: number;
  y: number;
  /** null when the pointer is outside the canvas */
  colour: [number, number, number] | null;
  /** selection bounds in document pixels, or null */
  selection: { width: number; height: number } | null;
  canvas: { width: number; height: number } | null;
}

export interface InfoPanelHandle {
  update(snapshot: Partial<InfoSnapshot>): void;
}

export function buildInfoPanel(host: HTMLElement): InfoPanelHandle {
  const wrap = document.createElement("div");
  wrap.className = "info-panel";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Pointer and selection information");

  const row = (label: string): HTMLSpanElement => {
    const line = document.createElement("div");
    line.className = "info-row";
    const name = document.createElement("span");
    name.className = "info-name";
    name.textContent = label;
    const value = document.createElement("span");
    value.className = "info-value";
    value.setAttribute("role", "status");
    line.append(name, value);
    wrap.appendChild(line);
    return value;
  };

  const pos = row("Position");
  const colour = row("Colour");
  const selection = row("Selection");
  const canvas = row("Canvas");
  host.appendChild(wrap);

  const hex = (c: [number, number, number]): string =>
    `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

  const state: InfoSnapshot = { x: 0, y: 0, colour: null, selection: null, canvas: null };
  return {
    update(next: Partial<InfoSnapshot>): void {
      Object.assign(state, next);
      pos.textContent = `${Math.round(state.x)}, ${Math.round(state.y)}`;
      colour.textContent = state.colour ? `${hex(state.colour)} · ${state.colour.map((v) => Math.round(v)).join(" ")}` : "—";
      selection.textContent = state.selection ? `${state.selection.width} × ${state.selection.height}` : "None";
      canvas.textContent = state.canvas ? `${state.canvas.width} × ${state.canvas.height} px` : "—";
    },
  };
}
