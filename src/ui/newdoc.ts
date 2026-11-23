/**
 * The New Document dialog: Photoshop-shaped, and the one place that turns
 * print units (inches, cm, picas …) into a pixel canvas. All the arithmetic
 * lives in ../engine/docmeta.ts so it is unit-tested; this module only builds
 * the form, keeps the fields in sync and hands the finished Document over.
 */
import { Document, type Layer } from "../engine/document.ts";
import type { ShowModal } from "./dialogs.ts";
import {
  BUILTIN_PRESETS,
  MAX_DIM,
  imageImportRefusal,
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

// W6 (handoff-4): storage keys carry an explicit schema seam. Without the .v1
// suffix a future shape change would read old rows as if they were new; with it
// the old key is simply ignored (and adopted once, below, so nothing is lost).
const PRESET_KEY = "guazzo.docPresets.v1";
const PRESET_KEY_LEGACY = "guazzo.docPresets";

function loadCustomPresets(): DocPreset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (raw) return sanitisePresets(JSON.parse(raw) as unknown);
    // one-time adoption of the pre-v1 key, then rewrite under the new name
    const legacy = localStorage.getItem(PRESET_KEY_LEGACY);
    if (!legacy) return [];
    const adopted = sanitisePresets(JSON.parse(legacy) as unknown);
    if (adopted.length > 0) saveCustomPresets(adopted);
    return adopted;
  } catch { return []; }
}

function saveCustomPresets(list: DocPreset[]): void {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(list.slice(0, 40))); } catch { /* storage full or blocked */ }
}

/** Everything the dialog needs from the editor shell. */
export interface NewDocDeps {
  showModal: ShowModal;
  /** in-app replacements for window.alert / window.prompt (no browser chrome) */
  notify(title: string, message: string): void;
  promptText(title: string, message: string, initial?: string): Promise<string | null>;
  applyTransform(): void;
  isTransforming(): boolean;
  foregroundColor(): [number, number, number];
  backgroundColor(): [number, number, number];
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
  let errRow: HTMLElement | null = null;

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
  nameIn.setAttribute("aria-label", "Name");
  nameRow.appendChild(nameIn);

  // Document type
  const typeRow = row1("Document Type:");
  const typeSel = document.createElement("select");
  typeSel.setAttribute("aria-label", "Document type");
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
    num.setAttribute("aria-label", label.replace(/:$/, ""));
    const unit = select(UNIT_ORDER.map((u) => [u, UNIT_LABELS[u]]));
    unit.setAttribute("aria-label", `${label.replace(/:$/, "")} unit`);
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
  resNum.setAttribute("aria-label", "Resolution");
  resNum.min = "1";
  const resUnit = select([["ppi", "Pixels/Inch"], ["ppc", "Pixels/Cm"]]);
  resUnit.setAttribute("aria-label", "Resolution unit");
  resPair.append(resNum, resUnit);
  resRow.appendChild(resPair);

  // Color mode + bit depth
  const modeRow = row1("Color Mode:");
  const modePair = document.createElement("div");
  modePair.className = "pair inline-row";
  const modeSel = select([["rgb", "RGB Color"], ["gray", "Grayscale"], ["cmyk", "CMYK Color"], ["lab", "Lab Color"]], ["gray", "cmyk", "lab"]);
  modeSel.setAttribute("aria-label", "Colour mode");
  const depthSel = select([["8", "8 bit"], ["16", "16 bit"], ["32", "32 bit"]], ["16", "32"]);
  depthSel.setAttribute("aria-label", "Bit depth");
  modePair.append(modeSel, depthSel);
  modeRow.appendChild(modePair);

  // Background contents
  const bgRow = row1("Background Contents:");
  const bgPair = document.createElement("div");
  bgPair.className = "pair inline-row";
  const bgSel = select([["white", "White"], ["black", "Black"], ["transparent", "Transparent"], ["color", "Background Color"]]);
  bgSel.setAttribute("aria-label", "Background contents");
  const bgSwatch = document.createElement("div");
  bgSwatch.setAttribute("aria-label", "Background colour");
  bgSwatch.className = "swatch";
  // The label says Background, so the swatch and the fill must be the
  // background colour, not the foreground one (uiux-r7 #6).
  const paintSwatch = (): void => {
    const v = bgSel.value;
    if (v === "transparent") {
      bgSwatch.style.background =
        "repeating-conic-gradient(#c8c8c8 0% 25%, #fff 0% 50%) 50% / 8px 8px";
      return;
    }
    const c = v === "white" ? [255, 255, 255] : v === "black" ? [0, 0, 0] : deps.backgroundColor();
    bgSwatch.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  bgSel.addEventListener("change", paintSwatch);
  paintSwatch();
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
    // The visible span is not associated with the select; give the control the
    // same accessible name the eye already sees.
    control.setAttribute("aria-label", label.replace(/:$/, ""));
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

  // dimensionsPx clamps to 1..MAX_DIM (docmeta.test.ts pins that), so it can
  // never report an invalid size. The refusal contract has to read the raw
  // fields instead: without this the two branches in onOk were unreachable and
  // a zero width silently produced a 1×1 document.
  const rawPixels = (): [number, number] => [
    Math.round(unitToPx(Number(dimW.num.value) || 0, dimW.unit.value as DocUnit, currentDpi())),
    Math.round(unitToPx(Number(dimH.num.value) || 0, dimH.unit.value as DocUnit, currentDpi())),
  ];

  const refresh = (): void => {
    dpi = currentDpi();
    const [w, h] = dimensionsPx();
    sizeOut.textContent = `${w} × ${h} px`;
    readout.innerHTML = `Image Size<br><b>${imageSizeMb(w, h)}</b>`;
    // A stale red line that still claims the old value is worse than no error:
    // clear it (and the invalid flags) the moment the form changes.
    if (errRow) errRow.textContent = "";
    for (const el of [dimW.num, dimH.num]) el.removeAttribute("aria-invalid");
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

  // The unit trackers live above applyPreset because a preset writes the
  // unit select directly: no change event fires, so without this the next
  // manual unit change converts from the *previous* unit and 1920 px becomes
  // 1920 inches.
  let prevWUnit: DocUnit = "px";
  let prevHUnit: DocUnit = "px";
  const applyPreset = (p: DocPreset): void => {
    dimW.num.value = String(p.w);
    dimH.num.value = String(p.h);
    dimW.unit.value = p.unit;
    dimH.unit.value = p.unit;
    prevWUnit = p.unit;
    prevHUnit = p.unit;
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
  prevWUnit = dimW.unit.value as DocUnit;
  prevHUnit = dimH.unit.value as DocUnit;
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

  saveBtn.addEventListener("click", async () => {
    const p = readForm();
    const label = await deps.promptText("Save preset", "Save this document size as a preset named:", p.name);
    if (!label) return;
    const preset: DocPreset = { ...p, name: label.trim().slice(0, 60) || p.name };
    custom = [...custom.filter((c) => c.name !== preset.name), preset];
    saveCustomPresets(custom);
    fillPresetOptions();
    typeSel.value = preset.name;
  });

  delBtn.addEventListener("click", async () => {
    if (!custom.length) { deps.notify("Nothing to delete", "There are no custom presets yet."); return; }
    const names = custom.map((c) => c.name).join(", ");
    const label = await deps.promptText("Delete preset", `Which preset?\n${names}`, custom[custom.length - 1]!.name);
    if (!label) return;
    const next = custom.filter((c) => c.name !== label.trim());
    if (next.length === custom.length) {
      deps.notify("No such preset", `There is no custom preset named “${label}”.`);
      return;
    }
    custom = next;
    saveCustomPresets(custom);
    fillPresetOptions();
  });

  // An error line inside the dialog: OK used to close and do nothing at all,
  // which reads like the app is broken.
  errRow = document.createElement("div");
  errRow.className = "ndlg-error";
  errRow.setAttribute("role", "status");
  errRow.setAttribute("aria-live", "polite");
  body.appendChild(errRow);
  const fail = (message: string, invalid: HTMLInputElement[]): void => {
    if (!errRow) return;
    errRow.textContent = message;
    for (const el of invalid) el.setAttribute("aria-invalid", "true");
  };

  // returns false while the form is invalid, so the dialog stays open and the
  // message is actually readable (showModal closes only when onOk does not refuse)
  deps.showModal("New", body, (): void | false => {
    const [w, h] = rawPixels();
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
      fail("Width and height must be positive numbers.", [dimW.num, dimH.num]);
      return false;
    }
    if (w > MAX_DIM || h > MAX_DIM) {
      fail(`Maximum document size is ${MAX_DIM} × ${MAX_DIM} px.`, [dimW.num, dimH.num]);
      return false;
    }
    // The importer refuses a picture over 64 MPx; a document the editor can
    // create but cannot save or open is worse than the refusal.
    const tooBig = imageImportRefusal(w, h);
    if (tooBig) {
      fail(tooBig, [dimW.num, dimH.num]);
      return false;
    }
    const nd = new Document(w, h);
    const kind = bgSel.value;
    if (kind === "white" || kind === "black") {
      const l = nd.addLayer("Background");
      l.grid.fillRect(0, 0, w, h, kind === "white" ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    } else if (kind === "color") {
      const l = nd.addLayer("Background");
      l.grid.fillRect(0, 0, w, h, [...deps.backgroundColor(), 255]);
    }
    const layer = nd.addLayer("Layer 1");
    deps.replaceDocument(nd, layer, nameIn.value.trim() || "Untitled");
    deps.setActiveTabDpi(Math.round(dpi));
    deps.renderTabs();
  });
}

/** File > New entry point; the host supplies the shell's seams. */
export function newDocumentDialog(deps: NewDocDeps): void {
  openNewDocumentDialog(deps);
}
