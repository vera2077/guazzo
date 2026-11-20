// Export As… dialog — one place for PNG / JPEG / WebP / PSD, with a quality
// control, a scale factor and an honest size estimate.
//
// The canvas work stays in main.ts; this module owns only the form and the
// decisions. It hands the caller a Request describing exactly what to write.

import type { ShowModal } from "./dialogs.ts";

export type ExportFormat = "png" | "jpeg" | "webp" | "psd";

export interface ExportRequest {
  format: ExportFormat;
  /** 1–100, only used by jpeg/webp. */
  quality: number;
  /** 0.1–2.0 */
  scale: number;
  filename: string;
}

export interface ExportDeps {
  showModal: ShowModal;
  /** Current document size in px, plus whether it has layers PSD can't hold. */
  docInfo: () => { width: number; height: number; hasNonPixelLayers: boolean };
  defaultName: () => string;
  onExport: (req: ExportRequest) => void;
}

const FORMATS: { id: ExportFormat; label: string; ext: string; lossy: boolean; note: string }[] = [
  { id: "png", label: "PNG", ext: "png", lossy: false, note: "Lossless, transparent, best for graphics and screenshots." },
  { id: "jpeg", label: "JPEG", ext: "jpg", lossy: true, note: "Small files for photos. No transparency — the checkerboard is flattened to white." },
  { id: "webp", label: "WebP", ext: "webp", lossy: true, note: "Smaller than JPEG at the same quality, keeps transparency." },
  { id: "psd", label: "Photoshop (PSD)", ext: "psd", lossy: false, note: "Keeps layers, names, opacity, visibility and blend modes." },
];

/** Rough bytes-per-pixel for the size estimate shown next to the field. */
function bytesPerPixel(format: ExportFormat, quality: number): number {
  switch (format) {
    case "png": return 1.1;
    case "jpeg": return 0.12 + (quality / 100) * 0.75;
    case "webp": return 0.08 + (quality / 100) * 0.52;
    case "psd": return 4.05;
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function openExportDialog(deps: ExportDeps): void {
  const info = deps.docInfo();
  const body = document.createElement("div");
  body.className = "expdlg";

  // ---- format -------------------------------------------------------------
  const fmtRow = document.createElement("div");
  fmtRow.className = "inline-row";
  const fmtLabel = document.createElement("span");
  fmtLabel.className = "label";
  fmtLabel.textContent = "Format";
  const fmtSel = document.createElement("select");
  for (const f of FORMATS) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.label;
    fmtSel.appendChild(opt);
  }
  fmtRow.append(fmtLabel, fmtSel);
  body.appendChild(fmtRow);

  const note = document.createElement("div");
  note.className = "label exp-note";
  body.appendChild(note);

  // ---- quality ------------------------------------------------------------
  const qRow = document.createElement("div");
  qRow.className = "inline-row";
  const qLabel = document.createElement("span");
  qLabel.className = "label";
  qLabel.textContent = "Quality";
  const qRange = document.createElement("input");
  qRange.type = "range";
  qRange.min = "1";
  qRange.max = "100";
  qRange.value = "85";
  qRange.style.width = "150px";
  const qVal = document.createElement("span");
  qVal.className = "value";
  qVal.textContent = "85";
  qRow.append(qLabel, qRange, qVal);
  body.appendChild(qRow);

  // ---- scale --------------------------------------------------------------
  const sRow = document.createElement("div");
  sRow.className = "inline-row";
  const sLabel = document.createElement("span");
  sLabel.className = "label";
  sLabel.textContent = "Scale";
  const sRange = document.createElement("input");
  sRange.type = "range";
  sRange.min = "10";
  sRange.max = "200";
  sRange.value = "100";
  sRange.style.width = "150px";
  const sVal = document.createElement("span");
  sVal.className = "value";
  sVal.textContent = "100%";
  sRow.append(sLabel, sRange, sVal);
  body.appendChild(sRow);

  // ---- size readout -------------------------------------------------------
  const sizeLine = document.createElement("div");
  sizeLine.className = "label exp-size";
  body.appendChild(sizeLine);

  // ---- filename -----------------------------------------------------------
  const nameRow = document.createElement("div");
  nameRow.className = "inline-row";
  const nameLabel = document.createElement("span");
  nameLabel.className = "label";
  nameLabel.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.style.flex = "1 1 auto";
  const base = deps.defaultName().replace(/\.(png|jpe?g|webp|psd|guazzo\.json)$/i, "");
  nameInput.value = base;
  nameRow.append(nameLabel, nameInput);
  body.appendChild(nameRow);

  const psdWarning = document.createElement("div");
  psdWarning.className = "label exp-warn";
  body.appendChild(psdWarning);

  const current = (): ExportRequest => {
    const format = fmtSel.value as ExportFormat;
    return {
      format,
      quality: Number(qRange.value),
      scale: Number(sRange.value) / 100,
      filename: `${nameInput.value.trim() || "export"}.${FORMATS.find((f) => f.id === format)!.ext}`,
    };
  };

  const sync = (): void => {
    const format = fmtSel.value as ExportFormat;
    const f = FORMATS.find((x) => x.id === format)!;
    const q = Number(qRange.value);
    const sc = Number(sRange.value) / 100;
    note.textContent = f.note;
    qVal.textContent = String(q);
    sVal.textContent = `${Math.round(sc * 100)}%`;
    // quality has no meaning for lossless formats
    qRange.disabled = !f.lossy;
    qRange.style.opacity = f.lossy ? "1" : ".45";
    const w = Math.max(1, Math.round(info.width * sc));
    const h = Math.max(1, Math.round(info.height * sc));
    const bpp = bytesPerPixel(format, q);
    sizeLine.textContent = `${w} × ${h} px · about ${humanSize(w * h * bpp)}`;
    if (format === "psd") {
      psdWarning.textContent = info.hasNonPixelLayers
        ? "This document has adjustment or fill layers. PSD export flattens them into one composite layer — the file will open as a single layer."
        : "All layers export as separate, editable PSD layers.";
    } else {
      psdWarning.textContent = "";
    }
  };

  fmtSel.addEventListener("change", sync);
  qRange.addEventListener("input", sync);
  sRange.addEventListener("input", sync);
  nameInput.addEventListener("input", () => { /* name only matters on export */ });
  sync();

  deps.showModal("Export As", body, () => deps.onExport(current()));
}
