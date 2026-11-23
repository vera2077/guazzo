/**
 * adjustdlg.ts — the Adjustment Settings dialog.
 *
 * Why this exists: an adjustment layer could be created with a single "Amount"
 * slider that the shell mapped to whatever field that kind happened to own, and
 * then never reopened. A recipe you cannot open is not a layer — it is a
 * destructive edit with a misleading name in the panel.
 *
 * This dialog owns the *form for a recipe*: given an AdjustSpec it renders the
 * controls that spec actually has, and returns a complete replacement spec. The
 * shell decides what to do with it (new layer, or an undoable property change).
 * Curves uses the shared curve widget, so the layer editor and the destructive
 * Curves dialog cannot drift apart.
 */
import { LEVELS_FIELDS, buildFields, hexOf, levelsFromFields, parseHexColour, photoFilterPresetColour, photoFilterPresetEntries, type FieldControl } from "./adjust-forms.ts";
import { mountCurveEditor } from "./curveeditor.ts";
import { defaultAdjustSpec, type AdjustKind, type AdjustSpec } from "../engine/adjustfn.ts";
import type { MapStop } from "../engine/tone.ts";
import { parseCube, type LookupTable } from "../engine/lookuptable.ts";
import { SELECTIVE_LABELS, SELECTIVE_RANGES, normalizeSelective, type CmykOffsets, type SelectiveRange, type SelectiveSettings } from "../engine/selective.ts";

export interface AdjustDialogDeps {
  showModal(title: string, body: HTMLElement, onOk: () => void | false): void;
}

export interface AdjustDialogOptions {
  kind: AdjustKind;
  /** the current recipe when editing; omitted when creating */
  spec?: AdjustSpec;
  /** the layer's name, shown in the title when editing */
  layerName?: string;
  /** called with a complete spec when the user confirms */
  onOk(spec: AdjustSpec): void;
}

export const ADJUST_KIND_LABELS: readonly [AdjustKind, string][] = [
  ["brightness-contrast", "Brightness/Contrast"],
  ["levels", "Levels"],
  ["curves", "Curves"],
  ["exposure", "Exposure"],
  ["vibrance", "Vibrance"],
  ["hue-sat", "Hue/Saturation"],
  ["color-balance", "Colour Balance"],
  ["black-white", "Black & White"],
  ["photo-filter", "Photo Filter"],
  ["invert", "Invert"],
  ["posterize", "Posterize"],
  ["threshold", "Threshold"],
  ["desaturate", "Desaturate"],
  ["gradient-map", "Gradient Map"],
  ["channel-mixer", "Channel Mixer"],
  ["selective-colour", "Selective Colour"],
  ["color-lookup", "Colour Lookup"],
];

const SLIDER_FIELDS: Record<string, readonly { id: string; label: string; min: number; max: number; def: number; step?: number }[]> = {
  "brightness-contrast": [
    { id: "brightness", label: "Brightness", min: -100, max: 100, def: 0 },
    { id: "contrast", label: "Contrast", min: -100, max: 100, def: 0 },
  ],
  exposure: [{ id: "stops", label: "Exposure (EV)", min: -4, max: 4, def: 0, step: 0.1 }],
  vibrance: [{ id: "amount", label: "Vibrance", min: -100, max: 100, def: 0 }],
  "hue-sat": [
    { id: "hue", label: "Hue", min: -180, max: 180, def: 0 },
    { id: "saturation", label: "Saturation", min: -100, max: 100, def: 0 },
    { id: "lightness", label: "Lightness", min: -100, max: 100, def: 0 },
  ],
  posterize: [{ id: "posterizeLevels", label: "Levels", min: 2, max: 255, def: 4 }],
  threshold: [{ id: "thresholdLevel", label: "Level", min: 0, max: 255, def: 128 }],
};

/** The 6 hue bands Photoshop's Black & White exposes, with its neutral weight. */
const BW_FIELDS = [
  { id: "r", label: "Reds", min: -200, max: 300, def: 40 },
  { id: "g", label: "Greens", min: -200, max: 300, def: 60 },
  { id: "b", label: "Blues", min: -200, max: 300, def: 20 },
  { id: "c", label: "Cyans", min: -200, max: 300, def: 60 },
  { id: "m", label: "Magentas", min: -200, max: 300, def: 40 },
  { id: "y", label: "Yellows", min: -200, max: 300, def: 60 },
];

/** The four sliders one channel-mixer output channel owns, in percent. */
const MIX_FIELDS = [
  { id: "r", label: "Red %", min: -200, max: 200, def: 0 },
  { id: "g", label: "Green %", min: -200, max: 200, def: 0 },
  { id: "b", label: "Blue %", min: -200, max: 200, def: 0 },
  { id: "constant", label: "Constant", min: -200, max: 200, def: 0 },
];

const SELECTIVE_FIELDS = [
  { id: "c", label: "Cyan %", min: -100, max: 100, def: 0 },
  { id: "m", label: "Magenta %", min: -100, max: 100, def: 0 },
  { id: "y", label: "Yellow %", min: -100, max: 100, def: 0 },
  { id: "k", label: "Black %", min: -100, max: 100, def: 0 },
];

const BALANCE_FIELDS = (["shadows", "midtones", "highlights"] as const).flatMap((band) =>
  ([["r", "Red"], ["g", "Green"], ["b", "Blue"]] as const).map(([ch, name]) => ({
    id: `${band}.${ch}`,
    label: `${band.slice(0, 5)} ${name}`,
    min: -100,
    max: 100,
    def: 0,
  })),
);

function checkRow(label: string, def: boolean): { row: HTMLElement; input: HTMLInputElement; value: () => boolean } {
  const row = document.createElement("label");
  row.className = "inline-row";
  const span = document.createElement("span");
  span.className = "label";
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = def;
  input.setAttribute("aria-label", label);
  row.append(input, span);
  return { row, input, value: () => input.checked };
}

/** A labelled `<input type="color">`: the one control the gradient-map editor
 *  needs, and the only place a hex string enters a recipe. */
function colourRow(label: string, value: [number, number, number]):
  { row: HTMLElement; input: HTMLInputElement; colour: () => [number, number, number] } {
  const row = document.createElement("label");
  row.className = "inline-row";
  const span = document.createElement("span");
  span.className = "label";
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "color";
  input.className = "color-well";
  input.value = hexOf(value);
  input.setAttribute("aria-label", label);
  row.append(span, input);
  return {
    row,
    input,
    colour: () => parseHexColour(input.value) ?? value,
  };
}

function selectRow(
  label: string, options: readonly (readonly [string, string])[], value: string,
): { row: HTMLElement; input: HTMLSelectElement; value: () => string } {
  const row = document.createElement("label");
  row.className = "inline-row";
  const span = document.createElement("span");
  span.className = "label";
  span.textContent = label;
  const input = document.createElement("select");
  input.setAttribute("aria-label", label);
  for (const [v, text] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    input.appendChild(o);
  }
  input.value = value;
  row.append(span, input);
  return { row, input, value: () => input.value };
}

/**
 * Build the spec editor for `kind` into `host` and return a reader that
 * produces the complete spec. `kind` never changes inside one dialog, so the
 * reader's switch and the fields that were built are always in step.
 */
export interface SpecReader {
  (): AdjustSpec;
  /** Returns a reason to keep the dialog open, or null when the recipe is usable. */
  blocked?: () => string | null;
}

function buildEditor(
  host: HTMLElement, kind: AdjustKind, spec: AdjustSpec,
): SpecReader {
  const base = (): AdjustSpec => ({ kind });
  const num = (id: string, def: number): number => {
    const f = fields[id];
    return f ? f.value() : def;
  };
  let fields: Record<string, FieldControl> = {};

  switch (kind) {
    case "brightness-contrast":
    case "exposure":
    case "vibrance":
    case "hue-sat":
    case "posterize":
    case "threshold": {
      fields = buildFields(host, SLIDER_FIELDS[kind] ?? []);
      return () => {
        const s = base();
        if (kind === "brightness-contrast") {
          s.brightness = num("brightness", 0);
          s.contrast = num("contrast", 0);
        } else if (kind === "exposure") {
          s.stops = Math.round(num("stops", 0) * 10) / 10;
        } else if (kind === "vibrance") {
          s.amount = num("amount", 0);
        } else if (kind === "hue-sat") {
          s.hue = num("hue", 0);
          s.saturation = num("saturation", 0);
          s.lightness = num("lightness", 0);
        } else if (kind === "posterize") {
          s.posterizeLevels = Math.round(num("posterizeLevels", 4));
        } else {
          s.thresholdLevel = Math.round(num("thresholdLevel", 128));
        }
        return s;
      };
    }

    case "levels": {
      fields = buildFields(host, LEVELS_FIELDS);
      const current = spec.levels;
      if (current) {
        const set = (id: string, v: number): void => {
          const f = fields[id];
          if (f) {
            f.input.value = String(v);
            f.input.dispatchEvent(new Event("input"));
          }
        };
        set("inBlack", current.inBlack);
        set("inWhite", current.inWhite);
        set("gamma", current.gamma);
        set("outBlack", current.outBlack);
        set("outWhite", current.outWhite);
      }
      return () => ({ kind, levels: levelsFromFields(fields) });
    }

    case "curves": {
      const editor = mountCurveEditor(host, { initial: spec.curves, hint: "" });
      return () => {
        const values = editor.values();
        const touched = editor.touched();
        const curves: NonNullable<AdjustSpec["curves"]> = { rgb: values.rgb };
        for (const ch of touched) {
          if (ch === "r") curves.r = values.r;
          else if (ch === "g") curves.g = values.g;
          else if (ch === "b") curves.b = values.b;
        }
        return { kind, curves };
      };
    }

    case "color-balance": {
      fields = buildFields(host, BALANCE_FIELDS);
      const preserve = checkRow("Preserve luminosity", spec.colorBalance?.preserveLuminosity ?? true);
      host.appendChild(preserve.row);
      const cb = spec.colorBalance;
      const put = (id: string, v: number): void => {
        const f = fields[id];
        if (f) {
          f.input.value = String(v);
          f.input.dispatchEvent(new Event("input"));
        }
      };
      if (cb) {
        for (const band of ["shadows", "midtones", "highlights"] as const) {
          put(`${band}.r`, cb[band].r);
          put(`${band}.g`, cb[band].g);
          put(`${band}.b`, cb[band].b);
        }
      }
      const band = (name: string): { r: number; g: number; b: number } => ({
        r: num(`${name}.r`, 0),
        g: num(`${name}.g`, 0),
        b: num(`${name}.b`, 0),
      });
      return () => ({
        kind,
        colorBalance: {
          shadows: band("shadows"),
          midtones: band("midtones"),
          highlights: band("highlights"),
          preserveLuminosity: preserve.value(),
        },
      });
    }

    case "black-white": {
      fields = buildFields(host, BW_FIELDS);
      const bw = spec.blackWhite;
      if (bw) {
        for (const id of ["r", "g", "b", "c", "m", "y"]) {
          const f = fields[id];
          if (f) {
            f.input.value = String(bw[id as keyof typeof bw]);
            f.input.dispatchEvent(new Event("input"));
          }
        }
      }
      return () => ({
        kind,
        blackWhite: {
          r: num("r", 40), g: num("g", 60), b: num("b", 20),
          c: num("c", 60), m: num("m", 40), y: num("y", 60),
        },
      });
    }

    case "photo-filter": {
      const current = spec.photoFilter;
      const wanted = current?.color ?? [236, 138, 0];
      const preset = photoFilterPresetEntries().find(([label]) => {
        const c = photoFilterPresetColour(label);
        return c[0] === wanted[0] && c[1] === wanted[1] && c[2] === wanted[2];
      })?.[0] ?? photoFilterPresetEntries()[0]![0];
      const sel = selectRow("Filter", photoFilterPresetEntries(), preset);
      host.appendChild(sel.row);
      fields = buildFields(host, [{ id: "density", label: "Density (%)", min: 0, max: 100, def: current?.density ?? 25 }]);
      if (current) {
        const f = fields.density!;
        f.input.value = String(current.density);
        f.input.dispatchEvent(new Event("input"));
      }
      const preserve = checkRow("Preserve luminosity", current?.preserveLuminosity ?? true);
      host.appendChild(preserve.row);
      return () => ({
        kind,
        photoFilter: {
          color: photoFilterPresetColour(sel.value()),
          density: Math.round(num("density", 25)),
          preserveLuminosity: preserve.value(),
        },
      });
    }

    case "channel-mixer": {
      // Three output channels (plus an optional monochrome one) share one set
      // of four sliders. The state holds the channel the sliders are NOT
      // showing, so switching never loses an edit.
      type MixKey = "red" | "green" | "blue" | "gray";
      const id: NonNullable<AdjustSpec["mixer"]> = spec.mixer ?? {
        red: { r: 100, g: 0, b: 0, constant: 0 },
        green: { r: 0, g: 100, b: 0, constant: 0 },
        blue: { r: 0, g: 0, b: 100, constant: 0 },
      };
      const state: NonNullable<AdjustSpec["mixer"]> = {
        red: { ...id.red }, green: { ...id.green }, blue: { ...id.blue },
      };
      if (id.gray) state.gray = { ...id.gray };
      let current: MixKey = "red";

      const pick = selectRow(
        "Output channel",
        [["red", "Red"], ["green", "Green"], ["blue", "Blue"], ["gray", "Gray (monochrome)"]],
        "red",
      );
      const mono = checkRow("Monochrome", !!state.gray);
      host.append(pick.row, mono.row);
      const mixFields = buildFields(host, MIX_FIELDS);
      const pull = (): void => {
        const f = state[current] ?? state.red;
        const set = (key: "r" | "g" | "b" | "constant", v: number): void => {
          const c = mixFields[key];
          if (!c) return;
          c.input.value = String(v);
          c.input.dispatchEvent(new Event("input"));
        };
        set("r", f.r);
        set("g", f.g);
        set("b", f.b);
        set("constant", f.constant);
      };
      const push = (): void => {
        state[current] = {
          r: Math.round(mixFields.r?.value() ?? 0),
          g: Math.round(mixFields.g?.value() ?? 0),
          b: Math.round(mixFields.b?.value() ?? 0),
          constant: Math.round(mixFields.constant?.value() ?? 0),
        };
      };
      pick.input.addEventListener("change", () => {
        push();
        const next = pick.value() as MixKey;
        if (next === "gray") {
          if (!state.gray) state.gray = { ...state.blue };
          mono.input.checked = true;
        }
        current = next;
        pull();
      });
      mono.input.addEventListener("change", () => {
        if (mono.value()) {
          if (!state.gray) state.gray = { ...state.blue };
        } else {
          delete state.gray;
          if (current === "gray") {
            current = "blue";
            pick.input.value = "blue";
            pull();
          }
        }
      });
      pull();
      return () => {
        push();
        return { kind, mixer: state };
      };
    }

    case "color-lookup": {
      // A lookup layer with no table changes nothing, so saying "OK" would
      // create a layer that lies about what it does. The dialog stays open with
      // a reason instead, and the reason names the parser's own complaint.
      let table: LookupTable | null = spec.lookup ?? null;
      const note = document.createElement("p");
      note.className = "field-note";
      note.setAttribute("role", "status");
      const file = document.createElement("input");
      file.type = "file";
      file.accept = ".cube,text/plain";
      file.style.display = "none";
      const load = document.createElement("button");
      load.type = "button";
      load.className = "btn";
      load.textContent = "Load .cube…";
      load.addEventListener("click", () => file.click());
      const say = (text: string, bad = false): void => {
        note.textContent = text;
        note.classList.toggle("error", bad);
      };
      const show = (): void => {
        say(table
          ? `Loaded "${table.name}" — ${table.size}×${table.size}×${table.size} samples.`
          : "No table loaded. Load a .cube file; until then the layer changes nothing.");
      };
      file.addEventListener("change", () => {
        const picked = (file as HTMLInputElement).files?.[0];
        if (!picked) return;
        if (picked.size > 8 * 1024 * 1024) {
          say("That .cube is larger than 8 MB — Guazzo reads tables up to 65³ samples.", true);
          return;
        }
        void picked.text().then((text) => {
          const parsed = parseCube(text, picked.name);
          if (parsed.table) {
            table = parsed.table;
            show();
          } else {
            say(`Could not load ${picked.name}: ${parsed.error}`, true);
          }
        });
      });
      show();
      const row = document.createElement("div");
      row.className = "inline-row";
      row.append(load, file);
      host.append(row, note);
      const read: SpecReader = () => (table ? { kind, lookup: table } : { kind });
      read.blocked = () => (table ? null : "Load a .cube lookup table before confirming.");
      return read;
    }

    case "selective-colour": {
      // Nine ranges share one set of four sliders, like channel mixer's four
      // channels share theirs: switching a range must never lose the edits
      // made to the range you just left.
      const id: SelectiveSettings = normalizeSelective(spec.selective ?? { mode: "relative", ranges: {} });
      const state = {} as Record<SelectiveRange, CmykOffsets>;
      for (const r of SELECTIVE_RANGES) state[r] = { ...(id.ranges[r] ?? { c: 0, m: 0, y: 0, k: 0 }) };
      let current: SelectiveRange = "reds";

      const mode = selectRow(
        "Mode",
        [["relative", "Relative"], ["absolute", "Absolute"]],
        id.mode,
      );
      const range = selectRow(
        "Colour range",
        SELECTIVE_RANGES.map((r) => [r, SELECTIVE_LABELS[r]] as [string, string]),
        "reds",
      );
      host.append(mode.row, range.row);
      const fields = buildFields(host, SELECTIVE_FIELDS);
      const pull = (): void => {
        const f = state[current];
        const set = (key: "c" | "m" | "y" | "k", v: number): void => {
          const c = fields[key];
          if (!c) return;
          c.input.value = String(v);
          c.input.dispatchEvent(new Event("input"));
        };
        set("c", f.c);
        set("m", f.m);
        set("y", f.y);
        set("k", f.k);
      };
      const push = (): void => {
        state[current] = {
          c: Math.round(fields.c?.value() ?? 0),
          m: Math.round(fields.m?.value() ?? 0),
          y: Math.round(fields.y?.value() ?? 0),
          k: Math.round(fields.k?.value() ?? 0),
        };
      };
      range.input.addEventListener("change", () => {
        push();
        current = range.value() as SelectiveRange;
        pull();
      });
      pull();
      return () => {
        push();
        const ranges: Partial<Record<SelectiveRange, CmykOffsets>> = {};
        for (const r of SELECTIVE_RANGES) {
          const v = state[r];
          if (v.c === 0 && v.m === 0 && v.y === 0 && v.k === 0) continue;
          ranges[r] = { ...v };
        }
        return { kind, selective: { mode: mode.value() as "relative" | "absolute", ranges } };
      };
    }

    case "gradient-map": {
      // Same three-stop shape as the destructive Gradient Map dialog, so the
      // live layer and the destructive op read the same way: shadows, an
      // optional midtone, highlights. The midtone is off by default, matching
      // the destructive dialog's checkbox.
      const stops = spec.map ?? [];
      const at = (t: number, fallback: [number, number, number]): [number, number, number] => {
        const hit = stops.find((st) => Math.abs(st.pos - t) < 1e-6);
        return hit ? [hit.color[0], hit.color[1], hit.color[2]] : fallback;
      };
      const shadow = colourRow("Shadows", at(0, [0, 0, 0]));
      const midOn = checkRow("Add midtone stop", stops.some((st) => st.pos > 0.01 && st.pos < 0.99));
      const mid = colourRow("Midtone", at(0.5, [255, 255, 255]));
      const high = colourRow("Highlights", at(1, [255, 255, 255]));
      // A midtone swatch the user cannot reach is a control that lies about
      // the recipe: hide and disable it until the checkbox turns it on, so the
      // two visible wells are exactly the two stops that will be stored.
      const syncMid = (): void => {
        const on = midOn.value();
        mid.row.style.display = on ? "" : "none";
        mid.input.disabled = !on;
      };
      midOn.input.addEventListener("change", syncMid);
      syncMid();
      host.append(shadow.row, midOn.row, mid.row, high.row);
      return () => {
        const map: MapStop[] = [{ pos: 0, color: shadow.colour() }];
        if (midOn.value()) map.push({ pos: 0.5, color: mid.colour() });
        map.push({ pos: 1, color: high.colour() });
        return { kind, map };
      };
    }

    default: {
      const note = document.createElement("div");
      note.className = "field-note";
      note.textContent = kind === "invert"
        ? "Invert has no settings — it flips every channel."
        : "Desaturate has no settings — it removes all saturation.";
      host.appendChild(note);
      return () => base();
    }
  }
}

/** The title the shell shows when editing an existing layer. */
export function adjustDialogTitle(kind: AdjustKind, layerName?: string): string {
  const label = ADJUST_KIND_LABELS.find(([k]) => k === kind)?.[1] ?? "Adjustment";
  return layerName ? `${label} — ${layerName}` : label;
}

/** Edit the recipe of an existing adjustment layer. */
export function openAdjustLayerDialog(deps: AdjustDialogDeps, opts: AdjustDialogOptions): void {
  const spec = opts.spec ?? defaultAdjustSpec(opts.kind);
  const body = document.createElement("div");
  body.className = "stack";
  const read = buildEditor(body, opts.kind, spec);
  const why = document.createElement("p");
  why.className = "field-note error";
  why.setAttribute("role", "alert");
  why.style.display = "none";
  body.appendChild(why);
  deps.showModal(adjustDialogTitle(opts.kind, opts.layerName), body, () => {
    const blocked = read.blocked?.();
    if (blocked) {
      why.textContent = blocked;
      why.style.display = "";
      return false;
    }
    opts.onOk(read());
  });
}

/**
 * Create a new adjustment layer: pick a kind, configure it, confirm.
 *
 * The kind select lives *inside* the dialog rather than in a first modal
 * because two modals in a row is a way to lose the second one — the first
 * closes, focus is restored, and the new one opens behind it. Changing the kind
 * rebuilds only the controls, so the dialog stays put.
 */
export function openNewAdjustmentDialog(
  deps: AdjustDialogDeps,
  onOk: (spec: AdjustSpec, kind: AdjustKind) => void,
): void {
  const body = document.createElement("div");
  body.className = "stack";
  const kindRow = document.createElement("label");
  kindRow.className = "inline-row";
  const kindLabel = document.createElement("span");
  kindLabel.className = "label";
  kindLabel.textContent = "Type";
  const kindSel = document.createElement("select");
  kindSel.setAttribute("aria-label", "Adjustment type");
  for (const [value, label] of ADJUST_KIND_LABELS) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    kindSel.appendChild(o);
  }
  kindRow.append(kindLabel, kindSel);
  body.appendChild(kindRow);

  const fieldsHost = document.createElement("div");
  fieldsHost.className = "stack";
  body.appendChild(fieldsHost);

  let kind: AdjustKind = "brightness-contrast";
  let read: SpecReader = () => defaultAdjustSpec(kind);
  const why = document.createElement("p");
  why.className = "field-note error";
  why.setAttribute("role", "alert");
  why.style.display = "none";
  const rebuild = (): void => {
    fieldsHost.replaceChildren();
    why.style.display = "none";
    read = buildEditor(fieldsHost, kind, defaultAdjustSpec(kind));
  };
  kindSel.addEventListener("change", () => {
    kind = kindSel.value as AdjustKind;
    rebuild();
  });
  rebuild();
  body.appendChild(why);

  deps.showModal("New Adjustment Layer", body, () => {
    const blocked = read.blocked?.();
    if (blocked) {
      why.textContent = blocked;
      why.style.display = "";
      return false;
    }
    onOk(read(), kind);
  });
}
