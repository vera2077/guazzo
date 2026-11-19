/**
 * The New Document dialog: Photoshop-shaped, and the one place that turns
 * print units (inches, cm, picas …) into a pixel canvas. All the arithmetic
 * lives in ../engine/docmeta.ts so it is unit-tested; this module only builds
 * the form, keeps the fields in sync and hands the finished Document over.
 */
import { Document, type Layer } from "../engine/document.ts";
import {
  BUILTIN_PRESETS,
  MAX_DIM,
  UNIT_LABELS,
  UNIT_ORDER,
  dimensionsToPixels,
  imageSizeMb,
  pxToUnit,
  sanitisePresets,
  unitToPx,
  type DocPreset,
  type DocUnit,
} from "../engine/docmeta.ts";

const PRESET_KEY = "pigment.docPresets";

function loadCustomPresets(): DocPreset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    return raw ? sanitisePresets(JSON.parse(raw) as unknown) : [];
  } catch { return []; }
}

function saveCustomPresets(list: DocPreset[]): void {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(list.slice(0, 40))); } catch { /* storage full or blocked */ }
}

/** Everything the dialog needs from the editor shell. */
export interface NewDocDeps {
  showModal(title: string, body: HTMLElement, onOk: () => void): void;
  applyTransform(): void;
  isTransforming(): boolean;
  foregroundColor(): [number, number, number];
  /** Replaces the document of the current tab and returns the tab count. */
  replaceDocument(doc: Document, layer: Layer, name: string): void;
  setActiveTabDpi(dpi: number): void;
  renderTabs(): void;
}

export function openNewDocumentDialog(deps: NewDocDeps): void {

  if (deps.isTransforming()) deps.applyTransform();

  let custom = loadCustomPresets();
  const body = document.createElement("div");
  body.className = "ndlg";

  const main = document.createElement("div");
  main.className = "ndlg-main";
  const aside = document.createElement("div");
  aside.className = "ndlg-aside";
  body.append(main, aside);

  const row1 = (label: string): HTMLElement => {
    const r = document.createElement("div");
    r.className = "grid1";
    const l = document.createElement("span");
    l.className = "label";
    l.textContent = label;
    r.appendChild(l);
    main.appendChild(r);
    return r;
  };

  const input = (type: string, value: string): HTMLInputElement => {
    const i = document.createElement("input");
    i.type = type;
    i.value = value;
    return i;
  };

  const select = (options: [string, string][], disabled: string[] = []): HTMLSelectElement => {
    const s = document.createElement("select");
    for (const [value, text] of options) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      if (disabled.includes(value)) { o.disabled = true; o.textContent = `${text} (not supported)`; }
      s.appendChild(o);
    }
    return s;
  };

  // Name
  const nameRow = row1("Name:");
  const nameIn = input("text", "Untitled-1");
  nameRow.appendChild(nameIn);

  // Document type
  const typeRow = row1("Document Type:");
  const typeSel = document.createElement("select");
  typeRow.appendChild(typeSel);

  // Size readout
  const sizeRow = row1("Size:");
  const sizeOut = document.createElement("span");
  sizeOut.className = "readout";
  sizeRow.appendChild(sizeOut);

  // Width / Height with units
  const dimRow = (label: string): { num: HTMLInputElement; unit: HTMLSelectElement } => {
    const r = document.createElement("div");
    r.className = "grid1";
    const l = document.createElement("span");
    l.className = "label";
    l.textContent = label;
    const pair = document.createElement("div");
    pair.className = "pair inline-row";
    const num = input("number", "0");
    const unit = select(UNIT_ORDER.map((u) => [u, UNIT_LABELS[u]]));
    pair.append(num, unit);
    r.append(l, pair);
    main.appendChild(r);
    return { num, unit };
  };
  const dimW = dimRow("Width:");
  const dimH = dimRow("Height:");

  // Resolution
  const resRow = row1("Resolution:");
  const resPair = document.createElement("div");
  resPair.className = "pair inline-row";
  const resNum = input("number", "300");
  resNum.min = "1";
  const resUnit = select([["ppi", "Pixels/Inch"], ["ppc", "Pixels/Cm"]]);
  resPair.append(resNum, resUnit);
  resRow.appendChild(resPair);

  // Color mode + bit depth
  const modeRow = row1("Color Mode:");
  const modePair = document.createElement("div");
  modePair.className = "pair inline-row";
  const modeSel = select([["rgb", "RGB Color"], ["gray", "Grayscale"], ["cmyk", "CMYK Color"], ["lab", "Lab Color"]], ["gray", "cmyk", "lab"]);
  const depthSel = select([["8", "8 bit"], ["16", "16 bit"], ["32", "32 bit"]], ["16", "32"]);
  modePair.append(modeSel, depthSel);
  modeRow.appendChild(modePair);

  // Background contents
  const bgRow = row1("Background Contents:");
  const bgPair = document.createElement("div");
  bgPair.className = "pair inline-row";
  const bgSel = select([["white", "White"], ["black", "Black"], ["transparent", "Transparent"], ["color", "Background Color"]]);
  const bgSwatch = document.createElement("div");
  bgSwatch.className = "swatch";
  const fg = deps.foregroundColor();
  bgSwatch.style.background = `rgb(${fg[0]},${fg[1]},${fg[2]})`;
  bgPair.append(bgSel, bgSwatch);
  bgRow.appendChild(bgPair);

  // Advanced group
  const adv = document.createElement("div");
  adv.className = "group";
  const advTitle = document.createElement("span");
  advTitle.className = "group-title";
  advTitle.textContent = "Advanced";
  adv.appendChild(advTitle);
  const advRow = (label: string, control: HTMLElement): void => {
    const r = document.createElement("div");
    r.className = "grid1";
    const l = document.createElement("span");
    l.className = "label";
    l.textContent = label;
    r.append(l, control);
    adv.appendChild(r);
  };
  advRow("Color Profile:", select([["srgb", "Working RGB: sRGB IEC61966-2.1"], ["adobergb", "Adobe RGB (1998)"], ["p3", "Display P3"]], ["adobergb", "p3"]));
  advRow("Pixel Aspect Ratio:", select([["square", "Square Pixels"], ["ntsc", "NTSC"], ["pal", "PAL"]], ["ntsc", "pal"]));
  main.appendChild(adv);

  // Aside: preset management + image size readout
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn subtle";
  saveBtn.textContent = "Save Preset…";
  const delBtn = document.createElement("button");
  delBtn.className = "btn subtle";
  delBtn.textContent = "Delete Preset…";
  const readout = document.createElement("div");
  readout.className = "readout";
  aside.append(saveBtn, delBtn, readout);

  // ---- state sync -------------------------------------------------------
  let dpi = 300;
  const currentDpi = (): number => {
    const v = Number(resNum.value) || 72;
    return resUnit.value === "ppc" ? v * 2.54 : v;
  };

  const dimensionsPx = (): [number, number] =>
    dimensionsToPixels(
      Number(dimW.num.value) || 0,
      Number(dimH.num.value) || 0,
      dimW.unit.value as DocUnit,
      currentDpi(),
    );

  const refresh = (): void => {
    dpi = currentDpi();
    const [w, h] = dimensionsPx();
    sizeOut.textContent = `${w} × ${h} px`;
    readout.innerHTML = `Image Size<br><b>${imageSizeMb(w, h)}</b>`;
  };

  const fillPresetOptions = (): void => {
    typeSel.innerHTML = "";
    const custom0 = document.createElement("option");
    custom0.value = "custom";
    custom0.textContent = "Custom";
    typeSel.appendChild(custom0);
    for (const p of [...BUILTIN_PRESETS, ...custom]) {
      const o = document.createElement("option");
      o.value = p.name;
      o.textContent = p.name;
      typeSel.appendChild(o);
    }
  };

  const applyPreset = (p: DocPreset): void => {
    dimW.num.value = String(p.w);
    dimH.num.value = String(p.h);
    dimW.unit.value = p.unit;
    dimH.unit.value = p.unit;
    resUnit.value = "ppi";
    resNum.value = String(p.dpi);
    refresh();
  };

  const readForm = (): DocPreset => ({
    name: nameIn.value.trim() || "Untitled",
    w: Number(dimW.num.value) || 1,
    h: Number(dimH.num.value) || 1,
    unit: dimW.unit.value as DocUnit,
    dpi: Math.round(dpi),
  });

  fillPresetOptions();
  applyPreset(BUILTIN_PRESETS[0]!);
  refresh();

  typeSel.addEventListener("change", () => {
    const all = [...BUILTIN_PRESETS, ...custom];
    const p = all.find((x) => x.name === typeSel.value);
    if (p) applyPreset(p);
  });
  for (const el of [dimW.num, dimH.num, resNum]) el.addEventListener("input", refresh);

  // Changing a unit converts the displayed number, so the physical size is kept
  // (Photoshop's behaviour) — the canvas is always in pixels.
  let prevWUnit = dimW.unit.value as DocUnit;
  let prevHUnit = dimH.unit.value as DocUnit;
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  const convertDim = (d: { num: HTMLInputElement; unit: HTMLSelectElement }, prev: DocUnit): DocUnit => {
    const next = d.unit.value as DocUnit;
    const px = unitToPx(Number(d.num.value) || 0, prev, currentDpi());
    d.num.value = String(round2(pxToUnit(px, next, currentDpi())));
    refresh();
    return next;
  };
  dimW.unit.addEventListener("change", () => { prevWUnit = convertDim(dimW, prevWUnit); });
  dimH.unit.addEventListener("change", () => { prevHUnit = convertDim(dimH, prevHUnit); });
  resUnit.addEventListener("change", () => {
    const v = Number(resNum.value) || 72;
    resNum.value = String(round2(resUnit.value === "ppc" ? v / 2.54 : v * 2.54));
    refresh();
  });

  saveBtn.addEventListener("click", () => {
    const p = readForm();
    const label = window.prompt("Save document preset as:", p.name);
    if (!label) return;
    const preset: DocPreset = { ...p, name: label.trim().slice(0, 60) || p.name };
    custom = [...custom.filter((c) => c.name !== preset.name), preset];
    saveCustomPresets(custom);
    fillPresetOptions();
    typeSel.value = preset.name;
  });

  delBtn.addEventListener("click", () => {
    if (!custom.length) { window.alert("No custom presets to delete."); return; }
    const names = custom.map((c) => c.name).join(", ");
    const label = window.prompt(`Delete which preset?\n${names}`, custom[custom.length - 1]!.name);
    if (!label) return;
    const next = custom.filter((c) => c.name !== label.trim());
    if (next.length === custom.length) { window.alert(`No custom preset named "${label}".`); return; }
    custom = next;
    saveCustomPresets(custom);
    fillPresetOptions();
  });

  // An error line inside the dialog: OK used to close and do nothing at all,
  // which reads like the app is broken.
  const errRow = document.createElement("div");
  errRow.className = "ndlg-error";
  body.appendChild(errRow);
  const fail = (message: string): void => { errRow.textContent = message; };

  deps.showModal("New", body, () => {
    const [w, h] = dimensionsPx();
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
      fail("Width and height must be positive numbers.");
      return;
    }
    if (w > MAX_DIM || h > MAX_DIM) {
      fail(`Maximum document size is ${MAX_DIM} × ${MAX_DIM} px.`);
      return;
    }
    const nd = new Document(w, h);
    const kind = bgSel.value;
    if (kind === "white" || kind === "black") {
      const l = nd.addLayer("Background");
      l.grid.fillRect(0, 0, w, h, kind === "white" ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    } else if (kind === "color") {
      const l = nd.addLayer("Background");
      l.grid.fillRect(0, 0, w, h, [...deps.foregroundColor(), 255]);
    }
    const layer = nd.addLayer("Layer 1");
    deps.replaceDocument(nd, layer, nameIn.value.trim() || "Untitled");
    deps.setActiveTabDpi(Math.round(dpi));
    deps.renderTabs();
  });
}

