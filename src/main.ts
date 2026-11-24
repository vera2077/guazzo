/**
 * main.ts — walking-skeleton UI: viewport + brush + layers panel.
 * Real panel/tool architecture lands with the full UI pass.
 */

import { Document, bakeLayerMask, cloneLayerContents, cloneLayerMeta, fillMaskFromSelection, maskAt, mergeLayerInto, paintMaskDab, setMaskAt, type Layer, type TextLayerMeta, type TextSeg } from "./engine/document.ts";
import { adjustLabel, type AdjustSpec } from "./engine/adjustfn.ts";
import { runColour, runFont, runFontSize } from "./engine/textruns.ts";
import { openAdjustLayerDialog, openNewAdjustmentDialog } from "./ui/adjustdlg.ts";
import { resizeDocument, canvasResizeDocument, cropDocument } from "./engine/resize.ts";
import { stampDab, dabPositions, type TipImage } from "./engine/paint.ts";
import {
  DEFAULT_BRUSH_SETTINGS, brushRandom, dabVariation, grainTexture, normalizeBrushSettings,
  type BrushSettings,
} from "./engine/brushsettings.ts";
import { deviceScale, isCrispZoom } from "./ui/zoomfilter.ts";
import { createAirbrush, AIRBRUSH_TICK_FLOW } from "./ui/airbrush.ts";
import { loadPressureSettings, pressureAt, savePressureSettings, type PressureSettings } from "./ui/pressure.ts";
import { openPressureDialog } from "./ui/pressuredlg.ts";
import { openBrushSettingsPanel, type BrushPanelHandle } from "./ui/brushsettingsdlg.ts";
import { StrokeSession, propertyCommand, layerAddCommand, textOpCommand, layerRemoveCommand, layerOpCommand, layerOpCommandIn, captureTiles, maskSelectionCommand, snapshotCommand, subtreeBytes, restoreTiles, type HistoryEntry, type TileImages, type LayerSpot } from "./engine/history.ts";
import { TileGrid, TILE, TILE_BYTES, cropRGBAAt } from "./engine/tile.ts";
import { placeRect } from "./engine/place.ts";
import { LAYER_BLEND_MODES, type BlendMode } from "./engine/blend.ts";
import { serializeProject, deserializeProject, projectTileCount, projectSmartBytes, projectTileRefusal } from "./engine/io.ts";
// The Rust/WASM accelerators are an in-progress module built by the other
// workspace (rust/ is ~11 GB of sources and is deliberately not committed), so
// a static import made a clean checkout un-buildable: tsc could not resolve the
// file the tag did not contain (code-r40 #2). They are loaded at runtime and
// every caller keeps its JavaScript fallback.
type WasmAdapter = {
  wasmReady(): boolean;
  wasmComposite(...args: any[]): Promise<any>;
  wasmFlatten(...args: any[]): Promise<any>;
  wasmMergeDown(...args: any[]): Promise<any>;
  wasmRotate(...args: any[]): Promise<any>;
  wasmFlip(...args: any[]): Promise<any>;
};
let wasmAdapter: WasmAdapter | null = null;
// Non-literal on purpose: TypeScript must not try to resolve a file that is
// optional, and a failed import must leave the editor working.
const wasmSpecifier = "./engine/" + "wasm.js";
async function loadWasmAdapter(): Promise<void> {
  try {
    wasmAdapter = (await import(/* @vite-ignore */ wasmSpecifier)) as WasmAdapter;
  } catch {
    wasmAdapter = null;
  }
}
void loadWasmAdapter();
export function wasmEngineEnabled(): boolean {
  try { return wasmAdapter?.wasmReady() === true; } catch { return false; }
}
function wasmCompositeCall(...args: any[]): Promise<any> { return wasmAdapter!.wasmComposite(...args); }
function wasmFlattenCall(...args: any[]): Promise<any> { return wasmAdapter!.wasmFlatten(...args); }
function wasmMergeDownCall(...args: any[]): Promise<any> { return wasmAdapter!.wasmMergeDown(...args); }
function wasmRotateCall(...args: any[]): Promise<any> { return wasmAdapter!.wasmRotate(...args); }
function wasmFlipCall(...args: any[]): Promise<any> { return wasmAdapter!.wasmFlip(...args); }
import { AutosaveScheduler, MAX_AUTOSAVE_LAYERS, MAX_AUTOSAVE_TILES, MAX_TABS, decodeAutosaveSnapshotV1, decodeAutosaveSnapshotV2, encodeAutosaveSnapshotV2, type AutosaveTimer } from "./engine/autosave.ts";
import { applyAdjustment, type AdjustmentKind } from "./engine/adjust.ts";
import {
  applyLevels, applyCurve, applyExposure, applyVibrance, applyColorBalance,
  applyBlackWhite, applyPhotoFilter, applyChannelMixer, applyGradientMap,
  applyDesaturate, applyEqualize, autoTone, autoContrast, autoColor,
  type Rect4, type CurvePoint,
} from "./engine/tone.ts";
import { applyFilter, mulberry32 } from "./engine/filter.ts";
import { flip, rotate90, rotate180, trimBounds } from "./engine/imageops.ts";
import { drawShape, shapePolyline, shapeSelection, type ShapeKind, type ShapeSpec } from "./engine/shapes.ts";
import type { FillPatternKind } from "./engine/fillpattern.ts";
import { mixColour } from "./engine/mix.ts";
import * as f2 from "./engine/filters2.ts";
import type { F2Rect } from "./engine/filters2.ts";
import { checkPsdHeader, PSD_MEMORY_LIMIT, psdToDocument, type PsdLike } from "./engine/psd.ts";
import { emptyImportReport, type ImportReport } from "./engine/importreport.ts";
import { fillGradient, type GradColor } from "./engine/gradient.ts";
import { SelectionMask, clearMasked, type PixelMask } from "./engine/mask.ts";
import { polygonMask } from "./engine/polyselect.ts";
import {
  borderSelection,
  colourRangeSelection,
  contractSelection,
  expandSelection,
  featherSelection,
  growSelection,
  similarSelection,
  smoothSelection,
} from "./engine/selectops.ts";
import { refineSelection, selectionHasFeather } from "./engine/refine.ts";
import { transformLayer, transformGrid, gridBBox } from "./engine/transform.ts";
import { smartSourceFromGrid, renderSmartIntoGrid, transformSmartGrid, contentBounds, type SmartSource } from "./engine/smart.ts";
import { snapshotGrid, applyLayerMove, type GridSnapshot } from "./engine/move.ts";
import { eraseRegion, floodFill, magicWand, sampleGrid, type RGBA } from "./engine/flood.ts";
import { dodgeBurnDab, spongeDab, focusDab, smudgeDab, cloneDab, redEyeDab, sampleColor } from "./engine/retouch.ts";
import { fillPlane } from "./engine/plane.ts";
import { contentAwareFill, spotHeal } from "./engine/heal.ts";
import { imageImportRefusal, jsonImportRefusal, jsonShapeRefusal, sniffImageSize, MAX_DIM, MAX_IMPORT_BYTES, MAX_JSON_BYTES } from "./engine/docmeta.ts";
import { penHandleFor, flattenPath, type PathAnchor } from "./engine/path.ts";
import {
  CURVE_CHANNELS, buildBlackWhiteForm, buildExposureForm, buildFields,
  buildPhotoFilterForm, levelsFromFields, LEVELS_FIELDS,
  type CurveChannel,
} from "./ui/adjust-forms.ts";
import { buildTonalPanel } from "./ui/tonal.ts";
import { appMarkSvg, iconSvg, type IconName } from "./ui/icons.ts";
import { ask, askPrompt, modalOpen, notify, showModal, showTextDialog } from "./ui/dialogs.ts";
import { buildSamplerOptions } from "./ui/samplerbar.ts";
import { histogramOf } from "./engine/histogram.ts";
import { buildHistogramPanel } from "./ui/histogrampanel.ts";
import { buildInfoPanel } from "./ui/infopanel.ts";
import { buildCountOptions } from "./ui/countbar.ts";
import { buildRulerOptions, type RulerMeasure } from "./ui/rulerbar.ts";
import { backgroundEraseDab, sampleGridColor, type BgTarget } from "./engine/bgerase.ts";
import { replaceColourDab } from "./engine/colourreplace.ts";
import { patchFromOffset } from "./engine/patch.ts";
import { buildPatchOptions } from "./ui/patchbar.ts";
import { buildNoteOptions } from "./ui/notebar.ts";
import { buildMagnetOptions } from "./ui/magnetbar.ts";
import { snapToEdges } from "./engine/magnetic.ts";
import { createCloseLoop } from "./ui/closeloop.ts";
import { buildPaletteEntries, openCommandPalette } from "./ui/palette.ts";
import { applyHistoryChangeVia, renderHistoryPanelInto, type HistoryChangeDeps, type HistoryPanelDeps } from "./ui/historypanel.ts";
import { closeMenus, hideContextMenu, menusOpen, mountMenuBar, refreshMenuBar, showContextMenu, type MenuItem } from "./ui/popup.ts";
import { proxyKey } from "./ui/proxykey.ts";
import { mountWindowChrome } from "./ui/windowchrome.ts";
import { LICENCE_TEXT } from "./ui/licence.ts";
import { activateTab, activeIndex, activeTabName, activeTabView, anyTabDirty, captureTab, closeActiveTab, closeTab, markActiveDirty, mountTabs, renderTabs, replaceDocument, seedBootTab, setDocInTab, setLastTabDpi, tabsView } from "./ui/tabs.ts";
import { createFlatCache } from "./ui/flatcache.ts";
import { addGroupNode, canDeleteLayer, canMoveLayer, canUngroupLayer, dropSpot, groupLayerNode, groupPath, moveLayerNode, moveLayerToSpot, moveOutSpot, setLayerOpacity, subtreeCount, ungroupLayerNode } from "./ui/layerops.ts";

// Z1: seed HTML is a trust boundary (a project file supplies the strings), so
// the builder lives in a pure, tested module instead of inline in this file.
import { buildSeedHtml } from "./ui/textseed.ts";
import { keyAction, shortcutAllowed, type KeyAction } from "./ui/keymap.ts";
import { DocSession, panelRows } from "./ui/session.ts";
import { SHORTCUTS } from "./ui/shortcuts.ts";
import { createPreviewScheduler } from "./ui/previewqueue.ts";
import { dockifyPanels, resetDock, togglePanels } from "./ui/dock.ts";
import { NOTICES_TEXT } from "./ui/notices.ts";
import { openExportDialog, type ExportRequest } from "./ui/exportdlg.ts";
import { buildLayersPanel } from "./ui/layerspanel.ts";
import { buildPsdForExport, psdExportLoss } from "./engine/psdexport.ts";
import { exportRefusal } from "./engine/exportlimit.ts";
import { decodeTiff } from "./engine/tiff.ts";
import {
  isTauri,
  shellHealth,
  openNative,
  saveNative,
  saveNativeAgain,
  ackCloseRequest,
  takeCloseRequest,
  windowForceClose,
} from "./ui/native.ts";
import { perspectiveCrop, quadSize, type Quad } from "./engine/perspective.ts";
import { newDocumentDialog, openNewDocumentDialog } from "./ui/newdoc.ts";

const host = document.getElementById("canvas-host") as HTMLDivElement;
const display = document.createElement("canvas");
const ctx = display.getContext("2d")!;
host.appendChild(display);

// ---- selection overlay (marching ants) ------------------------------------
host.style.position = "relative";
const overlay = document.createElement("canvas");
overlay.style.cssText = "position:absolute;inset:0;pointer-events:none";
host.appendChild(overlay);
const octx = overlay.getContext("2d")!;

// ---- selection state -------------------------------------------------------
let selRect: { x: number; y: number; w: number; h: number } | null = null;
/** arbitrary-shape selection (ellipse / lasso) — per-pixel 0..255 mask */
let selMask: SelectionMask | null = null;
/** brush edits the layer mask instead of its pixels */
let paintTarget: "pixel" | "mask" = "pixel";
/** mask snapshot taken at stroke start (one undo entry per mask stroke) */
let maskStrokeBefore: TileImages | null = null;
/** Quick Mask: painting edits the selection itself */
let quickMask = false;
/** red overlay cache for Quick Mask */
let quickMaskDirty = true;
/** selection before the first quick-mask dab of this stroke, for its undo entry */
let quickMaskBefore: SelectionSnap | null = null;
let quickMaskCanvas: HTMLCanvasElement | null = null;
/** overlay geometry while a shape selection is live or being dragged */
let selGeom: { kind: "ellipse"; x: number; y: number; w: number; h: number }
  | { kind: "poly"; pts: Array<[number, number]> } | null = null;
let marqueeing = false;
let ellipseDrag = false;
let ellipseStart: [number, number] = [0, 0];
/** Shift held when the drag started: constrain to a circle */
let selShiftAtPress = false;
let lassoing = false;
/** Pen's freehand mode: drag a path, release to close it into a selection. */
let freeformPen = false;
let ffDrag = false;
let ffPts: Array<[number, number]> = [];
/** The selection as it was when the current selection gesture began. */
let selBefore: SelectionSnap | null = null;
/** Shift at the press unions, Alt subtracts, no modifier replaces. Captured at
 *  pointerdown because Shift also constrains a marquee to a square while the
 *  drag runs (code-r32 #6 — the tooltip promised these and only the wand
 *  honoured them). */
let selDragMode: SelectMode = "replace";
let selDragBase: SelectionMask | null = null;
let lassoPts: Array<[number, number]> = [];
let polyPts: Array<[number, number]> = [];
let polyBefore: SelectionSnap | null = null;
let polyMode: "replace" | "add" | "subtract" = "replace";
/** pen tool: clicked anchors + the cursor preview point */
let penAnchors: PathAnchor[] = [];
// Drag-to-curve: index of the anchor whose handle the pointer is dragging.
let penDragIdx = -1;
let penCursor: [number, number] | null = null;
let marqueeStart: [number, number] = [0, 0];
// Photoshop parity: the marquee family also offers a one-pixel row/column strip.
let marqueeShape: "rect" | "row" | "col" = "rect";
/** Shift held when the drag started: constrain to a square */

let antsOffset = 0;
let antsTimer: ReturnType<typeof setInterval> | null = null;

// ---- move / crop state -----------------------------------------------------
/** live Move-tool drag: one snapshot, absolute offsets, one undo step */
let moveDrag: {
  layer: Layer;
  before: TileImages;
  snap: GridSnapshot;
  mask: PixelMask | null;
  startX: number;
  startY: number;
  text0: { x: number; y: number } | null;
  dx: number;
  dy: number;
} | null = null;
/** pending crop rectangle (document coords) */
let cropRect: { x: number; y: number; w: number; h: number } | null = null;
/** Perspective Crop: four draggable corners mapped onto an axis-aligned result. */
let cropQuad: Quad | null = null;
let quadDragIdx = -1;
let cropDrag = false;
let cropStart: [number, number] = [0, 0];

/** Square/circle constraint for Shift-drags: the smaller axis wins. */
function squareRect(a: [number, number], b: [number, number]): { x: number; y: number; w: number; h: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  const ex = a[0] + Math.sign(dx || 1) * side;
  const ey = a[1] + Math.sign(dy || 1) * side;
  return rectFrom(a, [ex, ey]);
}

function rectFrom(a: [number, number], b: [number, number]): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.min(Math.floor(a[0]), Math.floor(b[0])));
  const y = Math.max(0, Math.min(Math.floor(a[1]), Math.floor(b[1])));
  const x2 = Math.min(doc.width, Math.max(Math.ceil(a[0]), Math.ceil(b[0])));
  const y2 = Math.min(doc.height, Math.max(Math.ceil(a[1]), Math.ceil(b[1])));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

/**
 * Quick Mask (Q): the brush paints the selection itself. Red shows what is
 * protected (unselected), exactly like Photoshop's rubylith overlay.
 */
function toggleQuickMask(): void {
  if (!quickMask) {
    quickMask = true;
    // starting from a full-canvas selection means "nothing is protected yet"
    if (!selMask) {
      const m = new SelectionMask(doc.width, doc.height);
      m.selectRect(0, 0, doc.width, doc.height);
      selMask = m;
    }
    quickMaskDirty = true;
    tool = "brush";
    highlight();
    drawOverlay();
    refreshOptions();
  } else {
    quickMask = false;
    quickMaskDirty = true;
    const empty = !selMask || selMask.isEmpty();
    if (empty) selMask = null;
    if (selRect) selRect = null;
    if (selMask) startAnts(); else stopAnts();
    drawOverlay();
    refreshOptions();
    renderHistoryPanel();
  }
}

/** rebuild the rubylith canvas from the selection mask (only when dirty) */
function refreshQuickMaskOverlay(): void {
  if (!selMask) { quickMaskCanvas = null; return; }
  if (!quickMaskCanvas || quickMaskCanvas.width !== doc.width || quickMaskCanvas.height !== doc.height) {
    quickMaskCanvas = document.createElement("canvas");
    quickMaskCanvas.width = doc.width;
    quickMaskCanvas.height = doc.height;
  }
  const ctx = quickMaskCanvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(doc.width, doc.height);
  const d = img.data;
  const bb = selMask.bbox();
  const x0 = bb ? Math.max(0, bb.x) : 0;
  const y0 = bb ? Math.max(0, bb.y) : 0;
  const x1 = bb ? Math.min(doc.width, bb.x + bb.w) : 0;
  const y1 = bb ? Math.min(doc.height, bb.y + bb.h) : 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const a = selMask.alphaAt(x, y);
      if (a >= 128) continue; // selected: no rubylith
      const i = (y * doc.width + x) * 4;
      d[i] = 214; d[i + 1] = 46; d[i + 2] = 62; d[i + 3] = 140;
    }
  }
  ctx.putImageData(img, 0, 0);
  quickMaskDirty = false;
}

const BRUSH_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["brush", "pencil", "patternstamp", "mixer", "eraser", "bgerase", "colourreplace", "retouch", "clone", "focus", "heal"]);

/** The brush ring: a 300 px soft brush and a 3 px hard brush must not look alike. */
function drawBrushRing(): void {
  if (!hoverPos) return;
  const active = BRUSH_TOOLS.has(tool) || (quickMask && tool !== "move");
  if (!active || transform || panning) return;
  const [hx, hy] = hoverPos;
  const r = Math.max(2, (brushSize / 2) * scale);
  octx.save();
  octx.beginPath();
  octx.arc(hx, hy, r, 0, Math.PI * 2);
  octx.strokeStyle = "rgba(0,0,0,.72)";
  octx.lineWidth = 1;
  octx.stroke();
  octx.beginPath();
  octx.arc(hx, hy, Math.max(1, r - 1), 0, Math.PI * 2);
  octx.strokeStyle = "rgba(255,255,255,.92)";
  octx.stroke();
  if (r > 14) {
    // centre dot, so the exact pixel under a huge soft brush is locatable
    octx.beginPath();
    octx.arc(hx, hy, 1.1, 0, Math.PI * 2);
    octx.fillStyle = "rgba(255,255,255,.92)";
    octx.fill();
  }
  octx.restore();
}

function drawOverlay(): void {
  drawOverlayBase();
  drawTextBoxOverlay();
  drawBrushRing();
}

function drawOverlayBase(): void {
  // every overlay primitive below speaks CSS pixels; scale the context once
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, viewW, viewH);
  // Where the patch will land: a dashed box translated by the live offset, so
  // the drop point is visible before the button is released (uiux-r11).
  if (tool === "patch" && patchStart && patchLast) {
    const box = currentSelectionMask()?.bbox();
    if (box) {
      const dx = (patchLast[0] - patchStart[0]) * scale;
      const dy = (patchLast[1] - patchStart[1]) * scale;
      octx.save();
      octx.setLineDash([4, 3]);
      octx.strokeStyle = "rgba(255,255,255,.9)";
      octx.lineWidth = 1;
      octx.strokeRect(
        panX + box.x * scale + 0.5 + dx,
        panY + box.y * scale + 0.5 + dy,
        box.w * scale,
        box.h * scale,
      );
      octx.restore();
    }
  }
  if (rulerA && rulerB) {
    const ax = rulerA[0] * scale + panX, ay = rulerA[1] * scale + panY;
    const bx = rulerB[0] * scale + panX, by = rulerB[1] * scale + panY;
    const len = Math.hypot(bx - ax, by - ay);
    const ux = len > 0 ? (bx - ax) / len : 0, uy = len > 0 ? (by - ay) / len : 0;
    octx.strokeStyle = "rgba(255,255,255,.92)";
    octx.lineWidth = 1;
    octx.beginPath();
    octx.moveTo(ax, ay);
    octx.lineTo(bx, by);
    // end ticks perpendicular to the segment, so a near-zero angle still reads
    for (const [px, py] of [[ax, ay], [bx, by]] as const) {
      octx.moveTo(px - uy * 6, py + ux * 6);
      octx.lineTo(px + uy * 6, py - ux * 6);
    }
    octx.stroke();
    const m = rulerMeasure();
    if (m) {
      const label = `${m.distance.toFixed(1)} px · ${m.angle.toFixed(1)}°`;
      octx.font = "11px system-ui, sans-serif";
      const tw = octx.measureText(label).width;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      octx.fillStyle = "rgba(0,0,0,.72)";
      octx.fillRect(mx + 8, my - 20, tw + 10, 16);
      octx.fillStyle = "#fff";
      octx.fillText(label, mx + 13, my - 8);
    }
  }
  if (tool === "clone" && cloneSrc) {
    // Photoshop marks the clone source with a crosshair
    const cx = cloneSrc[0] * scale + panX, cy = cloneSrc[1] * scale + panY;
    octx.save();
    octx.strokeStyle = "#5b8cff";
    octx.lineWidth = 1.5;
    octx.beginPath();
    octx.moveTo(cx - 9, cy); octx.lineTo(cx + 9, cy);
    octx.moveTo(cx, cy - 9); octx.lineTo(cx, cy + 9);
    octx.stroke();
    octx.beginPath();
    octx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    octx.stroke();
    octx.restore();
  }
  if (samples.length > 0) {
    octx.save();
    octx.font = "600 11px system-ui, sans-serif";
    octx.textAlign = "center";
    for (let i = 0; i < samples.length; i++) {
      const [sx, sy] = samples[i]!;
      const cx = sx * scale + panX, cy = sy * scale + panY;
      octx.strokeStyle = "#ffffff";
      octx.lineWidth = 1;
      octx.beginPath();
      octx.moveTo(cx - 7, cy); octx.lineTo(cx + 7, cy);
      octx.moveTo(cx, cy - 7); octx.lineTo(cx, cy + 7);
      octx.stroke();
      octx.strokeStyle = "rgba(0,0,0,.55)";
      octx.beginPath();
      octx.arc(cx, cy, 3.2, 0, Math.PI * 2);
      octx.stroke();
      octx.fillStyle = "rgba(0,0,0,.65)";
      octx.fillRect(cx + 6, cy - 20, 15, 14);
      octx.fillStyle = "#fff";
      octx.fillText(String(i + 1), cx + 13.5, cy - 9);
    }
    octx.restore();
  }
  if (counts.length > 0) {
    octx.save();
    octx.font = "600 11px system-ui, sans-serif";
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    for (let i = 0; i < counts.length; i++) {
      const [sx, sy] = counts[i]!;
      const cx = sx * scale + panX, cy = sy * scale + panY;
      octx.fillStyle = "rgba(20,110,190,.92)";
      octx.beginPath();
      octx.arc(cx, cy, 8, 0, Math.PI * 2);
      octx.fill();
      octx.strokeStyle = "#ffffff";
      octx.lineWidth = 1.4;
      octx.stroke();
      octx.fillStyle = "#ffffff";
      octx.fillText(String(i + 1), cx, cy + 0.5);
    }
    octx.restore();
  }
  if (notes.length > 0) {
    octx.save();
    octx.font = "600 11px system-ui, sans-serif";
    octx.textAlign = "left";
    octx.textBaseline = "middle";
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]!;
      const cx = n.x * scale + panX, cy = n.y * scale + panY;
      octx.fillStyle = "rgba(250,204,21,.95)";
      octx.strokeStyle = "rgba(120,80,0,.9)";
      octx.lineWidth = 1.2;
      octx.beginPath();
      octx.rect(cx - 6, cy - 6, 12, 12);
      octx.fill();
      octx.stroke();
      octx.fillStyle = "#3a2a00";
      octx.fillText(String(i + 1), cx + 9, cy + 0.5);
    }
    octx.restore();
  }
  if (transform) { drawTransformOverlay(); return; }
  if (quickMask) {
    if (quickMaskDirty) refreshQuickMaskOverlay();
    if (quickMaskCanvas) {
      octx.imageSmoothingEnabled = false;
      octx.drawImage(quickMaskCanvas, panX, panY, doc.width * scale, doc.height * scale);
      octx.imageSmoothingEnabled = true;
    }
  }
  const antsStroke = (shape: () => void): void => {
    octx.save();
    octx.lineWidth = 1;
    octx.setLineDash([5, 4]);
    octx.strokeStyle = "#000";
    octx.lineDashOffset = -antsOffset + 4.5;
    shape();
    octx.stroke();
    octx.strokeStyle = "#fff";
    octx.lineDashOffset = -antsOffset;
    shape();
    octx.stroke();
    octx.restore();
  };
  const s = selRect ?? (marqueeing ? rectFrom(marqueeStart, marqueeStart) : null);
  if (s && s.w > 0 && s.h > 0) {
    const x = s.x * scale + panX, y = s.y * scale + panY;
    antsStroke(() => octx.strokeRect(x + 0.5, y + 0.5, s.w * scale, s.h * scale));
  }
  // Arbitrary-shape selections (Magic Wand, Quick Selection, lasso, ellipse,
  // Quick Mask) have no geometry to stroke, so trace the mask border instead.
  if (selMask && !selRect && !selGeom) {
    const maskRef = selMask;
    antsStroke(() => {
      const { h, v } = maskRef.outline();
      octx.beginPath();
      for (const [x0, x1, y] of h) {
        octx.moveTo(x0 * scale + panX, y * scale + panY);
        octx.lineTo(x1 * scale + panX, y * scale + panY);
      }
      for (const [y0, y1, x] of v) {
        octx.moveTo(x * scale + panX, y0 * scale + panY);
        octx.lineTo(x * scale + panX, y1 * scale + panY);
      }
    });
  }
  if (selGeom) {
    if (selGeom.kind === "ellipse") {
      const x = selGeom.x * scale + panX, y = selGeom.y * scale + panY;
      const w = selGeom.w * scale, h = selGeom.h * scale;
      if (w > 1 && h > 1) {
        const ell = () => octx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
        antsStroke(() => { octx.beginPath(); ell(); });
      }
    } else if (selGeom.pts.length >= 2) {
      const pts = selGeom.pts; // capture: selGeom is a let, not narrowable in closures
      const poly = () => {
        octx.beginPath();
        octx.moveTo(pts[0]![0] * scale + panX, pts[0]![1] * scale + panY);
        for (let i = 1; i < pts.length; i++) {
          octx.lineTo(pts[i]![0] * scale + panX, pts[i]![1] * scale + panY);
        }
        octx.closePath();
      };
      antsStroke(poly);
    }
  }
  if (gradientDrag) {
    const ax = gradStart[0] * scale + panX, ay = gradStart[1] * scale + panY;
    const bx = gradEnd[0] * scale + panX, by = gradEnd[1] * scale + panY;
    octx.save();
    octx.lineWidth = 1.5;
    octx.strokeStyle = "#7fb2ff";
    octx.beginPath();
    octx.moveTo(ax, ay);
    octx.lineTo(bx, by);
    octx.stroke();
    for (const [gx, gy] of [[ax, ay], [bx, by]] as const) {
      octx.beginPath();
      octx.arc(gx, gy, 4, 0, Math.PI * 2);
      octx.fillStyle = "#fff";
      octx.fill();
      octx.stroke();
    }
    octx.restore();
  }
  if (shapeDrag) {
    // live preview of the shape being dragged (pixels are only written on release)
    const d = shapeDrag;
    const x = Math.min(d.x0, d.x1) * scale + panX;
    const y = Math.min(d.y0, d.y1) * scale + panY;
    const w = Math.abs(d.x1 - d.x0) * scale;
    const h = Math.abs(d.y1 - d.y0) * scale;
    const spec: ShapeSpec = { kind: shapeKind, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, sides: shapeSides, radius: shapeRadius, strokeWidth: shapeStrokeW };
    const poly = shapePolyline(spec);
    const fillCol = shapeFill ?? color;
    octx.save();
    octx.beginPath();
    if (poly) {
      poly.forEach(([px, py], i) => {
        const sx = px * scale + panX;
        const sy = py * scale + panY;
        if (i === 0) octx.moveTo(sx, sy);
        else octx.lineTo(sx, sy);
      });
      octx.closePath();
    } else if (shapeKind === "ellipse") {
      octx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
    } else if (shapeKind === "line") {
      octx.moveTo(d.x0 * scale + panX, d.y0 * scale + panY);
      octx.lineTo(d.x1 * scale + panX, d.y1 * scale + panY);
    } else if (shapeKind === "rounded") {
      const r = Math.min(Math.max(0, shapeRadius) * scale, Math.min(w, h) / 2);
      // The preview must have the corners the rasteriser will produce, or the
      // drag shows a sharp rectangle that snaps rounded on release.
      const rr = (octx as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect;
      if (rr) rr.call(octx, x, y, w, h, r);
      else octx.rect(x, y, w, h);
    } else {
      octx.rect(x, y, w, h);
    }
    if (!d.toSelection && shapeKind !== "line") {
      octx.fillStyle = `rgba(${fillCol[0]}, ${fillCol[1]}, ${fillCol[2]}, 0.22)`;
      octx.fill();
    }
    octx.strokeStyle = d.toSelection ? "#7fb2ff" : "#fff";
    octx.setLineDash([4, 3]);
    octx.lineWidth = 1;
    octx.stroke();
    octx.restore();
  }
  if (cropQuad) {
    const pts = cropQuad.map(([x, y]) => [x * scale + panX, y * scale + panY] as [number, number]);
    octx.save();
    octx.fillStyle = "rgba(0,0,0,0.45)";
    octx.fillRect(0, 0, viewW, viewH);
    octx.beginPath();
    octx.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < 4; i++) octx.lineTo(pts[i]![0], pts[i]![1]);
    octx.closePath();
    octx.save();
    octx.clip();
    octx.clearRect(0, 0, viewW, viewH); // "cut out" the kept area
    octx.restore();
    octx.strokeStyle = "#fff";
    octx.setLineDash([5, 4]);
    octx.lineWidth = 1.2;
    octx.stroke();
    octx.setLineDash([]);
    for (const [px, py] of pts) {
      octx.beginPath();
      octx.arc(px, py, 5, 0, Math.PI * 2);
      octx.fillStyle = "#5b8cff";
      octx.fill();
      octx.strokeStyle = "#fff";
      octx.stroke();
    }
    octx.restore();
  }
  if (cropRect && cropRect.w > 1 && cropRect.h > 1) {
    const c = cropRect;
    const x = c.x * scale + panX, y = c.y * scale + panY;
    const w = c.w * scale, h = c.h * scale;
    // dim everything outside the crop
    octx.save();
    octx.fillStyle = "rgba(0,0,0,0.55)";
    octx.fillRect(0, 0, viewW, y);
    octx.fillRect(0, y + h, viewW, viewH - (y + h));
    octx.fillRect(0, y, x, h);
    octx.fillRect(x + w, y, viewW - (x + w), h);
    // border + thirds
    octx.strokeStyle = "#fff";
    octx.lineWidth = 1;
    octx.strokeRect(x + 0.5, y + 0.5, w, h);
    octx.strokeStyle = "rgba(255,255,255,0.35)";
    octx.beginPath();
    for (let i = 1; i < 3; i++) {
      octx.moveTo(x + (w * i) / 3, y);
      octx.lineTo(x + (w * i) / 3, y + h);
      octx.moveTo(x, y + (h * i) / 3);
      octx.lineTo(x + w, y + (h * i) / 3);
    }
    octx.stroke();
    octx.restore();
  }
}

function startAnts(): void {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (antsTimer !== null) return;
  antsTimer = setInterval(() => {
    antsOffset = (antsOffset + 1) % 18;
    drawOverlay();
  }, 90);
}
function stopAnts(): void {
  if (antsTimer !== null) { clearInterval(antsTimer); antsTimer = null; }
}
function deselect(): void {
  const before = snapshotSelection();
  const had = !!(selRect || selMask);
  selRect = null;
  selMask = null;
  selGeom = null;
  marqueeing = false;
  ellipseDrag = false;
  lassoing = false;
  stopAnts();
  drawOverlay();
  // Only a selection that existed is a history step; the daily click-to-clear
  // must not fill the panel with no-ops.
  if (had) pushHist(selectionCommand("Deselect", before));
}

/**
 * Write one stored mask value (255 = hidden, 0 = revealed) across the current
 * selection, honouring its coverage rather than its bounding box. Mask Clear and
 * Fill used to rewrite the whole canvas while their menu entry said "selection"
 * (uiux-r17 #1).
 */
function writeMaskArea(mask: TileGrid, w: number, h: number, stored: number): void {
  const sel = currentSelectionMask();
  const box = sel && !sel.isEmpty() ? sel.bbox() : null;
  if (!box || box.w <= 0 || box.h <= 0) {
    mask.fillRect(0, 0, w, h, [stored, stored, stored, 255]);
    return;
  }
  const x = Math.max(0, box.x), y = Math.max(0, box.y);
  const bw = Math.min(box.w, w - x), bh = Math.min(box.h, h - y);
  if (bw <= 0 || bh <= 0) return;
  const buf = new Uint8ClampedArray(bw * bh * 4);
  mask.readRect(x, y, bw, bh, buf);
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      if (sel && sel.alphaAt(x + xx, y + yy) === 0) continue;
      const i = (yy * bw + xx) * 4;
      buf[i] = stored; buf[i + 1] = stored; buf[i + 2] = stored; buf[i + 3] = 255;
    }
  }
  mask.writeRect(x, y, bw, bh, buf);
}

function clearSelection(): void {
  const onMask = paintTarget === "mask" && !!activeLayer.mask;
  if (!onMask && refuseGroupPixels(activeLayer)) return;
  if (refusePaintSurface(activeLayer, onMask)) return;
  if (onMask) {
    // The mask chip says which surface is being edited; Clear used to punch
    // the layer's pixels instead (code-r16 #3).
    const mask = activeLayer.mask!;
    // maskAt reads `255 - stored`: the stored byte is how much the mask HIDES.
    // Clear hides everything (255), Fill reveals everything (0); polarity only
    // changes what an absent tile means, i.e. the neutral an undo restores.
    const neutral = activeLayer.maskHide ? 255 : 0;
    // Capture BEFORE the write: snapshotCommand photographs the grid itself for
    // `after`, so passing captureTiles(mask) here as `before` made before==after
    // and redo restored the cleared image (code-r39 F2).
    const before = captureTiles(mask);
    writeMaskArea(mask, mask.width, mask.height, 255);
    const entry = snapshotCommand(mask, "Clear Mask", before, undefined, neutral);
    if (entry) { pushHist(entry); render(); renderHistoryPanel(); }
    return;
  }
  if (activeLayer.textData) {
    // Delete on live type used to clear the pixels and keep the recipe, so the
    // next Type edit re-stamped the old glyphs over whatever was beneath
    // (code-r23 #2).
    statusHint("Rasterize the type first — a live text layer has no fixed pixels.");
    return;
  }
  if (selMask) {
    const m = selMask;
    const entry = layerOpCommand(activeLayer, "Clear (selection)", () => {
      clearMasked(activeLayer.grid, m);
    });
    if (!entry) return;
    pushHist(entry);
    render();
    renderHistoryPanel();
    return;
  }
  if (!selRect) return;
  const s = selRect;
  const entry = layerOpCommand(activeLayer, "Clear", () => {
    activeLayer.grid.fillRect(s.x, s.y, s.w, s.h, [0, 0, 0, 0]);
  });
  if (!entry) return;
  pushHist(entry);
  render();
  renderHistoryPanel();
}

// ---- document ------------------------------------------------------------
let doc = new Document(1024, 768);
doc.addBackground("Background");
const paintLayer = doc.addLayer("Layer 1");
let activeLayer = paintLayer;
const session = new DocSession();

// every content change flows through the history stack — hooking it gives us
// a reliable "document is worth autosaving" signal.
let autosaveDirty = true;
/** Bumped by every content change; the autosave writer compares it across the
 *  write so an edit made during the OPFS write is not reported as saved
 *  (code-r26 #5). */
let editEpoch = 0;
let autosaveScheduler: AutosaveScheduler | null = null;
/** true when the tab has edits that have never been written to a file on disk */
let docDirty = false;
function pushHist(entry: HistoryEntry | null): void {
  if (!entry) return;
  quickPx = null; // pixels changed: the quick-select snapshot is stale
  quickPxLayer = null;
  quickRegion = null;
  quickApplied = null;
  session.push(entry);
  editEpoch++;
  autosaveDirty = true;
  autosaveScheduler?.noteEdit();
  if (!docDirty) {
    docDirty = true;
    updateStatus();
    renderTabs();
  }
}

/** Undo/redo also change the document, so the marker has to follow them. */
function markDirty(): void {
  editEpoch++;
  // Undo and redo change the document too: without this the next snapshot can
  // still hold the edit that was undone, and recovery would re-apply it (sec-r38
  // LOW-2). `if (docDirty) return;` below must not skip the autosave marker.
  autosaveDirty = true;
  autosaveScheduler?.noteEdit();
  if (docDirty) return;
  docDirty = true;
  updateStatus();
  renderTabs();
}

// ---- view transform ------------------------------------------------------
let scale = 1, panX = 0, panY = 0;

// Space-drag and middle-drag pan the canvas: without this, anything past ~150%
// leaves the wanted region permanently off-screen.
let spaceDown = false;
/** H toggles a temporary hand (drag anywhere pans), Z a click-to-zoom lens. */
let handMode = false;
let zoomMode = false;
let panning = false;
let panGrab: { sx: number; sy: number; px: number; py: number } | null = null;
/** middle-button behaviour: drag = temporary pan, click = sticky pan until clicked again */
let midPan: { moved: boolean } | null = null;
let panSticky = false;
let stickyPrev: [number, number] = [0, 0];
/** hover position in canvas-host CSS pixels, for the brush-size ring */
let hoverPos: [number, number] | null = null;
let checkerPattern: CanvasPattern | null = null;

/** Safety net: a rebuilt/hidden bar is re-attached instead of silently gone. */
function ensureMenuBar(): void {
  if (!menuBarEl.isConnected || menuBarEl.offsetWidth === 0) {
    if (!menuBarEl.isConnected) topbar.insertBefore(menuBarEl, topbar.children[1] ?? null);
    refreshMenuBar();
  }
}

// The viewport canvases are sized in device pixels and stretched back to the
// host by CSS (`#canvas-host canvas { position:absolute; inset:0 }`). Without
// this an editor at 100% zoom on a 150% Windows display was upscaled by the
// browser: the pixels you were retouching were not the pixels on screen.
let dpr = 1;
let viewW = 1;
let viewH = 1;

function resizeBuffers(): void {
  dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  viewW = Math.max(1, host.clientWidth);
  viewH = Math.max(1, host.clientHeight);
  display.width = Math.max(1, Math.round(viewW * dpr));
  display.height = Math.max(1, Math.round(viewH * dpr));
  overlay.width = display.width;
  overlay.height = display.height;
}

/** Window/layout resize: keep zoom and the document point at the viewport centre. */
function resize(): void {
  relayout();
}

/**
 * A panel/layout change must NOT re-fit the document: someone retouching at 400%
 * who widens the Layers panel expects the pixels under the cursor to stay put.
 * Keep the document point that was at the viewport centre.
 */
function relayout(): void {
  const cx = (viewW / 2 - panX) / scale;
  const cy = (viewH / 2 - panY) / scale;
  resizeBuffers();
  panX = viewW / 2 - cx * scale;
  panY = viewH / 2 - cy * scale;
  render();
  drawOverlay();
}

function fit(): void {
  const pad = 40;
  // a host narrower than the padding used to yield a negative scale, which
  // inverted the blit instead of showing a thumbnail
  scale = Math.max(0.01, Math.min(
    (viewW - pad) / doc.width,
    (viewH - pad) / doc.height,
  ));
  panX = (viewW - doc.width * scale) / 2;
  panY = (viewH - doc.height * scale) / 2;
}

function makeChecker(): CanvasPattern {
  if (checkerPattern) return checkerPattern;
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const cc = c.getContext("2d")!;
  cc.fillStyle = "#3a3a3a"; cc.fillRect(0, 0, 8, 8); cc.fillRect(8, 8, 8, 8);
  cc.fillStyle = "#2f2f2f"; cc.fillRect(8, 0, 8, 8); cc.fillRect(0, 8, 8, 8);
  checkerPattern = ctx.createPattern(c, "repeat")!;
  return checkerPattern;
}

/** full-document composite cache */
let flatCache = createFlatCache(doc.width, doc.height);
// Bumped every time renderFlat() writes a new composite. `generation` only
// moves on a document swap, so panels watched it and went stale after a stroke
// (uiux-r23 #2); the histogram keys on this stamp instead.
let flatStamp = 0;

/** a structural change: it writes no tile, so it must announce itself */
const declaredChange = (): void => {
  doc.revision++;
  flatCache.invalidate();
};
const off = document.createElement("canvas");
off.width = doc.width; off.height = doc.height;
const offCtx = off.getContext("2d")!;

function renderFlat(): void {
  if (!flatCache.needsComposite(doc.revision)) return;
  doc.composite(flatCache.buffer);
  // ImageData(flat) wraps the same buffer (no copy); putImageData consumes it synchronously
  offCtx.putImageData(new ImageData(flatCache.buffer, doc.width, doc.height), 0, 0);
  flatCache.markComposited(doc.revision);
  flatStamp++;
}

// ---- live preview -------------------------------------------------------
// Destructive filters are applied on OK; this keeps a *proxy* result on the
// canvas while the amount slider moves, so the user sees what they are buying
// before committing. The proxy is downsampled (filters are O(pixels) and oil
// paint / median would otherwise stall at 4K) and scaled back up with nearest
// sampling, which is honest about detail: it previews structure, not pixels.
let previewRect: { x: number; y: number; w: number; h: number } | null = null;
let previewCanvas: HTMLCanvasElement | null = null;

function setPreview(
  rect: { x: number; y: number; w: number; h: number },
  px: Uint8ClampedArray,
  w: number,
  h: number,
  proxied = false,
): void {
  if (!previewCanvas) previewCanvas = document.createElement("canvas");
  previewCanvas.width = w;
  previewCanvas.height = h;
  const pctx = previewCanvas.getContext("2d");
  if (!pctx) return;
  // copy: the engine hands out Uint8ClampedArray<ArrayBufferLike>, while
  // ImageData wants the ArrayBuffer-backed instantiation.
  const copy = new Uint8ClampedArray(px.length);
  copy.set(px);
  pctx.putImageData(new ImageData(copy, w, h), 0, 0);
  previewRect = rect;
  setPreviewBadge(proxied, w, h);
  render();
}

let previewBadgeEl: HTMLElement | null = null;
/** Set once the scheduler exists; clearPreview() runs during boot, before it. */
let previewCancel: (() => void) | null = null;
/**
 * AJ1: whether the recipe being previewed honours the selection. Adjustments
 * clip to the selection RECT at commit time but ignore feathering, so their
 * preview has to say so instead of quietly agreeing with itself.
 */
/** AN4: mask-awareness travels with the queued job (see queuePreview). */
let previewJobMaskAware = true;
/**
 * AA3: the preview runs on a downscaled proxy, so say so on the canvas instead
 * of letting a soft preview read as the committed result.
 */
function setPreviewBadge(show: boolean, w: number, h: number): void {
  const ignored = !!selMask && !previewJobMaskAware;
  if (!show && !ignored) { previewBadgeEl?.classList.remove("on"); return; }
  if (!previewBadgeEl) {
    previewBadgeEl = document.createElement("div");
    previewBadgeEl.className = "preview-badge";
    host.appendChild(previewBadgeEl);
  }
  previewBadgeEl.textContent = ignored
    ? `Preview · ${w} × ${h} proxy · feathering not shown`
    : `Preview · ${w} × ${h} proxy`;
  previewBadgeEl.classList.add("on");
}

function clearPreview(): void {
  // AJ3: a frame queued for the document that was showing must not paint onto
  // whatever document is showing now.
  previewCancel?.();
  previewBadgeEl?.classList.remove("on");
  if (!previewRect) return;
  previewRect = null;
  render();
}

/** the composited colour at a document point, for the Info card */
function compositeSampleAt(x: number, y: number): [number, number, number] | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || py < 0 || px >= flatCache.width || py >= flatCache.height) return null;
  const c = sampleColor({ width: flatCache.width, height: flatCache.height, data: flatCache.buffer }, px, py, 1);
  return c ? [c.r, c.g, c.b] : null;
}

function render(): void {
  renderFlat();
  restyleTextEditor(); // keep the live text box glued to the canvas while panning/zooming
  ctx.save();
  ctx.fillStyle = "#151515";
  ctx.fillRect(0, 0, display.width, display.height);
  // Nearest-neighbour is only lossless when one image pixel is a whole number
  // of device pixels; every other ratio is a real resample and is smoothed,
  // or a 93 % view drops one row in fourteen and 100 % on a 125 % display
  // rounds half the pixels (see ui/zoomfilter.ts).
  const device = deviceScale(scale, dpr);
  const crisp = isCrispZoom(scale, dpr);
  const offX = crisp ? Math.round(panX * dpr) : panX * dpr;
  const offY = crisp ? Math.round(panY * dpr) : panY * dpr;
  ctx.setTransform(device, 0, 0, device, offX, offY);
  // checkerboard + document
  ctx.fillStyle = makeChecker();
  ctx.fillRect(0, 0, doc.width, doc.height);
  ctx.imageSmoothingEnabled = !crisp;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, 0, 0);
  if (previewRect && previewCanvas) {
    const pr = previewRect;
    ctx.drawImage(previewCanvas, pr.x, pr.y, pr.w, pr.h);
  }
  ctx.restore();
  drawOverlay(); // keep marching ants glued to pan/zoom
  updateStatus();
  // the generation guard inside makes this a no-op unless the composite moved
  refreshHistogram();
  infoPanel.update({
    canvas: { width: flatCache.width, height: flatCache.height },
    selection: (() => { const b = selRect ?? selMask?.bbox() ?? null; return b ? { width: b.w, height: b.h } : null; })(),
  });
}

function compositeRegion(x: number, y: number, w: number, h: number, completed = false): void {
  // update the flat cache for a dirty rect then re-render.
  // Splices the small rect straight into `flat` (no scratch copy) and pushes
  // only that rect to the offscreen canvas via putImageData's dirty-rect form.
  if (w <= 0 || h <= 0) return;
  const tmp = new Uint8ClampedArray(w * h * 4);
  doc.compositeRect(x, y, w, h, tmp);
  for (let yy = 0; yy < h; yy++) {
    const srcRow = yy * w * 4;
    const dstRow = ((y + yy) * doc.width + x) * 4;
    flatCache.buffer.set(tmp.subarray(srcRow, srcRow + w * 4), dstRow);
  }
  offCtx.putImageData(new ImageData(flatCache.buffer, doc.width, doc.height), 0, 0, x, y, w, h);
  // `completed` means the rect covers every pixel that changed since the last
  // composite (a Move drag knows its old and new rectangles), so renderFlat()
  // must not recompose the whole document on top of this splice.
  if (completed) flatCache.markComposited(doc.revision);
  render();
}

// ---- painting ------------------------------------------------------------
let painting = false;
/** Alt at the start of a mask stroke: paint coverage instead of hiding. */
let strokeAlt = false;
let strokeSession: StrokeSession | null = null;
/** Airbrush: deposit at the resting pointer instead of only where it moves. */
let airbrushOn = false;
const airbrush = createAirbrush({
  deposit: (x, y) => {
    if (!painting || !strokeSession) return false;
    const p = lastPressure > 0 && lastPressure !== 0.5 ? lastPressure : 1;
    const radius = Math.max(1, (brushSize / 2) * (0.35 + 0.65 * pressureSize(p)));
    const rect = paintOneDab(x, y, radius, undefined, AIRBRUSH_TICK_FLOW, pressureAlpha(p));
    if (!rect) return false;
    scheduleComposite(rect.x, rect.y, rect.w, rect.h);
    return true;
  },
});
// Pen-pressure response. The size curve feeds the mapping the brush always had
// (0.35 + 0.65 * pressure); opacity and flow default to flat 1 so a mouse or a
// stylus that reports a constant reads exactly as before.
const pressureSettings: PressureSettings = loadPressureSettings();
const pressureSize = (p: number): number => pressureAt(pressureSettings.size, p);
const pressureAlpha = (p: number): number => pressureAt(pressureSettings.opacity, p) * pressureAt(pressureSettings.flow, p);
let lastX = 0, lastY = 0;
let brushSize = 24;
// ---- retouch / focus / clone / eyedropper state --------------------------
let retouchMode: "dodge" | "burn" | "sponge" | "redEye" = "dodge";
let retouchRange: "shadows" | "midtones" | "highlights" = "midtones";
let retouchStrength = 0.35;
let retouchVibrance = false;
let focusMode: "blur" | "sharpen" | "smudge" = "blur";
let focusStrength = 0.4;
let cloneSrc: [number, number] | null = null;
let cloneOffset: [number, number] | null = null;
let cloneAligned = true;
let cloneAlpha = 0.85;
let spongeMode: "saturate" | "desaturate" = "saturate";
let eyeSize = 1;
/** colour-sampler points, in document pixels; Photoshop caps the set at four */
let samples: Array<[number, number]> = [];
let counts: Array<[number, number]> = [];
/** View-only annotations: a point and its text. */
let notes: Array<{ x: number; y: number; text: string }> = [];
/** last note text announced, so hovering inside one marker does not repeat it */
let lastNoteHint = "";
/** Magnetic lasso: the rough drag, and how far it may snap. */

let magnetRadius = 8;
/** the Ruler's two ends, in document pixels; measuring never touches the document */
let rulerA: [number, number] | null = null;
let rulerB: [number, number] | null = null;
let rulerDrag = false;

/** The bar's numbers. Document-free on purpose — it is the shell's job to know
 *  where the canvas is, and the bar's job to print what it was handed. */
function rulerMeasure(): RulerMeasure | null {
  if (!rulerA || !rulerB) return null;
  const dx = rulerB[0] - rulerA[0];
  const dy = rulerB[1] - rulerA[1];
  return { dx, dy, distance: Math.hypot(dx, dy), angle: (Math.atan2(-dy, dx) * 180) / Math.PI };
}
let smudgePrev: [number, number] | null = null;
let bgColor: [number, number, number] = [255, 255, 255];
let brushHardness = 0.8;
/** background eraser: how far a pixel may differ from the sampled colour */
let bgTolerance = 32;
let colourTolerance = 64;
let colourTarget: BgTarget | null = null;
/** Patch drag: where it started and where the pointer is now. */
let patchStart: [number, number] | null = null;
let patchMask: SelectionMask | null = null;
let patchLast: [number, number] | null = null;
/** sampled once per stroke, on the first dab; null between strokes */
let bgTarget: BgTarget | null = null;
let brushOpacity = 1;
let brushFlow = 1;      // per-dab alpha multiplier — low flow = gradual build-up
let brushSmooth = 0;     // pulled-string smoothing, 0..90
let lastPressure = 1;
let rawCursor: [number, number] | null = null; // unsmoothed cursor (stroke catch-up)
// Quick Selection samples the active layer's pixels; a whole-layer copy costs
// `w*h*4` bytes, so it is taken once per drag and invalidated by pushHist().
let quickPx: Uint8ClampedArray | null = null;
let quickPxLayer: number | null = null;
let quickRegion: { mask: SelectionMask; bbox: { x: number; y: number; w: number; h: number } } | null = null;
let quickApplied: "add" | "subtract" | null = null;
let quickMode: "add" | "subtract" = "add";

/** pen tilt → nib shape. Near-vertical pens (tilt < 8°) stay round. */
function tiltOf(e: PointerEvent): { angle: number; ratio: number } | undefined {
  if (e.pointerType !== "pen") return undefined;
  const tx = e.tiltX ?? 0, ty = e.tiltY ?? 0;
  const mag = Math.hypot(tx, ty);
  if (mag < 8) return undefined;
  const ratio = Math.max(0.3, Math.cos((mag * Math.PI) / 180));
  return { angle: Math.atan2(ty, tx), ratio };
}

// ---- brush tips --------------------------------------------------------------
// "round" (null) = the procedural soft disc. Others are tip images whose
// alpha channel is the density. All built-ins are generated deterministically.
let activeTip: TipImage | null = null;
let tipName = "round";
// dual brush: a second tip multiplies the dab's coverage, so the stroke
// breaks up instead of being one flat disc
let dualTipName = "none";
let dualTip: TipImage | null = null;
let dualScale = 1;
let customTip: TipImage | null = null;
const loadedFonts: string[] = [];
const BUILTIN_FONT_FAMILIES = [
  "Arial", "Georgia", "Times New Roman", "Courier New", "Verdana", "Trebuchet MS",
  "Impact", "Comic Sans MS", "Tahoma", "Consolas", "Segoe UI", "Palatino Linotype",
];

function fontLookupKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Engine-side font lookup for PSD import: match Photoshop's font names
 *  ("ArialMT", "Arial-BoldMT") against families the document can actually
 *  render. Null means the caller must substitute. */
function resolveImportedFont(family: string): string | null {
  const wanted = fontLookupKey(family);
  if (!wanted) return "Arial";
  const available = [...loadedFonts, ...BUILTIN_FONT_FAMILIES];
  const exact = available.find(name => fontLookupKey(name) === wanted);
  if (exact) return exact;
  const prefixed = available.find(name => {
    const key = fontLookupKey(name);
    return key.length > 2 && wanted.startsWith(key);
  });
  return prefixed ?? null;
}

function makeSquareTip(size = 32): TipImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data[i * 4 + 3] = 255;
  return { data, w: size, h: size };
}

function makeChalkTip(size = 64): TipImage {
  const rand = mulberry32(0x9e3779b9);
  const data = new Uint8ClampedArray(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c; // 0..1 disc
      if (d > 1) continue;
      let a = (1 - d * d) * 255 * (0.55 + 0.45 * rand());
      if (rand() < 0.22) a = 0; // speckled holes
      data[(y * size + x) * 4 + 3] = a;
    }
  }
  return { data, w: size, h: size };
}

function makeSprayTip(size = 64): TipImage {
  const rand = mulberry32(0x1234abcd);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < 1100; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = Math.sqrt(rand()) * (size / 2 - 2);
    const x = Math.round(size / 2 + Math.cos(ang) * rad);
    const y = Math.round(size / 2 + Math.sin(ang) * rad);
    const r = rand() < 0.3 ? 2 : 1;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      data[(yy * size + xx) * 4 + 3] = Math.max(data[(yy * size + xx) * 4 + 3]!, 200);
    }
  }
  return { data, w: size, h: size };
}

const BUILTIN_TIPS: Record<string, () => TipImage> = {
  square: makeSquareTip,
  chalk: makeChalkTip,
  spray: makeSprayTip,
};

/** decode an image file into a brush tip: alpha channel is the density, but
 *  fully-opaque images (grayscale-on-white) use luminance (black = opaque) */
async function fileToTip(file: File): Promise<TipImage> {
  // A brush tip is downscaled to 512 px, but the decoder still builds the whole
  // image first; the same byte and pixel budget as every other import applies
  // (sec-r8 F3).
  if (file.size > MAX_IMPORT_BYTES) throw new Error("That image is too large for a brush tip.");
  // A tip is small on screen but the decoder still builds the whole image; read
  // the header first, exactly as every other import does (sec-r9 #4).
  const sniffed = typeof file.slice === "function"
    ? sniffImageSize(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()))
    : null;
  if (!sniffed) {
    // Every format we advertise has a readable header. A file whose header we
    // cannot measure is not a format we can bound, so it must not reach the
    // decoder: 200 KB declaring 16384² allocates a gigabyte (sec-r11 #1).
    throw new Error(
      `Guazzo cannot read "${file.name}"'s dimensions before opening it, so it will not decode it. ` +
        "Supported pictures are PNG, JPEG, GIF, BMP, WebP and TIFF.",
    );
  }
  const bad = imageImportRefusal(sniffed.width, sniffed.height);
  if (bad) throw new Error(bad);
  const bmp = await createImageBitmap(file);
  const refusal = imageImportRefusal(bmp.width, bmp.height);
  if (refusal) { bmp.close(); throw new Error(refusal); }
  const maxDim = 512;
  const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const src = ctx.getImageData(0, 0, w, h).data;
  let hasTransparency = false;
  for (let i = 3; i < src.length; i += 4) if (src[i]! < 255) { hasTransparency = true; break; }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (hasTransparency) {
      data[i * 4 + 3] = src[i * 4 + 3]!;
    } else {
      // opaque source: treat black as full density, white as empty
      const lum = 0.3 * src[i * 4]! + 0.59 * src[i * 4 + 1]! + 0.11 * src[i * 4 + 2]!;
      data[i * 4 + 3] = 255 - lum;
    }
  }
  return { data, w, h };
}
// Brush Settings: the dialog's recipe. Size/hardness/opacity/flow stay in the
// options bar (they are edited too often to bury); the tip's fixed shape and
// the dynamics live here. Persisted so a brush survives a restart.
const BRUSH_KEY = "guazzo.brush.v1";
function loadBrushSettings(): BrushSettings {
  try {
    const raw = localStorage.getItem(BRUSH_KEY);
    return raw ? normalizeBrushSettings(JSON.parse(raw)) : normalizeBrushSettings(DEFAULT_BRUSH_SETTINGS);
  } catch {
    return normalizeBrushSettings(DEFAULT_BRUSH_SETTINGS);
  }
}
function saveBrushSettings(s: BrushSettings): void {
  try { localStorage.setItem(BRUSH_KEY, JSON.stringify(s)); } catch { /* storage is full */ }
}
let brushSettings = loadBrushSettings();
// The bar's own sliders, exposed so the Brush Settings panel can move them:
// two writers for one number must move the same thumb.
let setBarSize: (v: number) => void = () => {};
let setBarHardness: (v: number) => void = () => {};
let setBarSmooth: (v: number) => void = () => {};
let setBarScatter: (v: number) => void = () => {};
let brushPanel: BrushPanelHandle | null = null;
// One smoothing number: the recipe is loaded before the first stroke, so the
// bar must show what the strokes will actually use (declared above).
brushSmooth = brushSettings.smoothing;
// one generator per stroke: a stroke can be replayed, and jitter cannot leak
// into the next gesture
let strokeRnd: () => number = brushRandom(1);
// Spot Healing paints a hole mask; the pixels are rebuilt when the stroke ends
let healMask: SelectionMask | null = null;
let healRect: { x: number; y: number; w: number; h: number } | null = null;
import { TOOL_LABELS, toolTitle, type ToolId } from "./ui/toollabels.ts";
import { fillGradientFrom, fillPatternFrom, openFillLayerDialog } from "./ui/filldialog.ts";

/**
 * One-line guidance per tool. The options bar used to spell this out inline on
 * every tool switch; the long text now lives behind the round "?" button at the
 * end of the bar (user request: "move all the tooltips on those question
 * marks ... it would look much cleaner"). Hints the bar still renders inline
 * are appended to this text automatically, so the tooltip never drifts behind
 * the UI.
 */
const TOOL_GUIDE: Record<ToolId, string> = {
  brush: "Brush (B) — paint with the foreground colour. Tablet pressure drives size and opacity; [ and ] resize, Shift+[ and ] change hardness.",
  eraser: "Eraser (E) — erases the active layer to transparency.",
  marquee: "Rectangular Marquee (M) — drag to select; Shift+drag forces a square. Shift adds to the selection, Alt subtracts.",
  ellipse: "Elliptical Marquee (M) — drag to select; Shift+drag draws a circle.",
  lasso: "Lasso (L) — drag to draw a freehand selection.",
  polylasso: "Polygonal Lasso (Shift+L) — click to place points; Enter, a double-click or a click on the first point closes the selection; Backspace removes the last point, Esc cancels.",
  pen: "Pen (P) — click to drop a corner anchor, drag from it to curve the path; Enter or double-click closes into a selection, Backspace removes the last anchor, Esc cancels.",
  pencil: "Pencil (Shift+B) — paint with a hard, aliased edge; B selects Brush, Shift+B selects Pencil. Size and opacity come from the brush bar, but no softness, texture or dynamics are applied.",
  patternstamp: "Pattern Stamp (Shift+P) — paint the foreground/background pattern; the tip shape and hardness come from the brush bar, the tile and scale from here.",
  mixer: "Mixer Brush (Shift+K) — paint colour mixed into what is already on the layer; Wet sets how much of the bar colour is laid down versus picked up.",
  gradient: "Gradient (G) — drag to fill the selection (or layer) with the foreground→background gradient.",
  text: "Text (T) — click for a text box; click existing text to re-edit it; drag the box to move it; Shift+Enter for a new line; select text then B/I/U/S or a font to style just that part; Enter commits, Escape cancels.",
  move: "Move (V) — drag to move the active layer. Arrow keys nudge by 1 px, Shift+arrows by 10 px.",
  crop: "Crop (C) — drag a crop box, then Enter to apply or Escape to cancel.",
  wand: "Magic Wand (W) — click to select similar pixels. Shift-click adds to the selection, Alt-click subtracts.",
  bucket: "Paint Bucket (Shift+G) — click to flood-fill an area with the foreground colour.",
  magicerase: "Magic Eraser (Shift+E) — click a colour to erase its contiguous region; tolerance comes from the bucket options and the current selection clips it.",
  bgerase: "Background Eraser (Shift+E) — drag to erase pixels matching the colour under the first dab; tolerance sets how close a pixel must be, and the rim follows hardness.",
  colourreplace: "Colour Replacement (Shift+Y) — drag over one colour to paint it with the foreground colour at the same brightness; tolerance widens the match and the rim follows hardness.",
  quick: "Quick Selection (Shift+W) — paint over similar pixels to grow the selection.",
  shape: "Shape (U) — drag to draw; Alt-drag turns the shape into a selection.",
  sampler: "Color Sampler (Shift+I) — click to place up to four sample points; the options bar shows each one's colour and position; Alt-click clears them all.",
  count: "Count (Shift+C) — click to number points on the canvas. The markers belong to this view, not to the file.",
  ruler: "Ruler (Shift+R) — drag to measure distance, width, height and angle; the measurement is a readout and is cleared with Esc.",
  eyedropper: "Eyedropper (I) — click to sample a colour from the image into the foreground.",
  retouch: "Retouch (O) — dodge, burn or sponge the pixels under the brush; Alt-click cycles the mode.",
  clone: "Clone Stamp (S) — Alt-click to set the source, then paint to clone from it.",
  focus: "Focus (Shift+S) — blur, sharpen or smudge along the stroke; Alt-click cycles the mode.",
  patch: "Patch (Shift+J) — drag a selection onto the pixels that should replace it. Copies, it does not search.",
  note: "Note (Shift+N) — click to attach a note to a spot. Notes are view-only and are not saved with the document.",
  magnet: "Magnetic Lasso (Shift+L) — drag a rough outline; on release it snaps onto the strongest edges within the radius. Shift+L cycles Lasso, Polygonal and Magnetic.",
  heal: "Spot Healing (J) — paint over a blemish; the area is rebuilt from its surroundings.",
};

let tool: ToolId = "brush";
// Magic Wand / Paint Bucket share the same Photoshop-style tolerance model
let wandTolerance = 32;
let quickTolerance = 40;
let shapeKind: ShapeKind = "rectangle";
let shapeRadius = 16;
let patternKind: FillPatternKind = "checker";
let patternTile = 32;
let patternScaleVal = 1;
let mixerWet = 50;
let shapeSides = 5;
let shapeStrokeW = 0;
type ShapeDrag = { x0: number; y0: number; x1: number; y1: number; toSelection: boolean };
let shapeDrag: ShapeDrag | null = null;
/** null = follow the current foreground colour, like Photoshop's shape tools */
let shapeFill: [number, number, number] | null = null;
/** null = follow the current background colour */
let shapeStroke: [number, number, number] | null = null;
let wandContiguous = true;
let bucketTolerance = 32;
let bucketContiguous = true;
let bucketOpacity = 1;

// ---- gradient state --------------------------------------------------------
let gradKind: "linear" | "radial" = "linear";
let gradFrom: GradColor = { r: 0, g: 0, b: 0, a: 255 }; // foreground →
let gradTo: GradColor = { r: 0, g: 0, b: 0, a: 0 };     // → transparent (default)
let gradientDrag = false;
let gradStart: [number, number] = [0, 0];
let gradEnd: [number, number] = [0, 0];
const color: [number, number, number] = [0, 0, 0];

// ---- text tool state --------------------------------------------------------
type TextAlign = "left" | "center" | "right" | "justify";
/** paragraph alignment for new text (and for the layer being edited) */
let textAlign: TextAlign = "left";
let textFont = "Arial";
let textSize = 48;
let textBold = false;
let textItalic = false;
let textUnderline = false;
let textStrike = false;
/** live on-canvas text editor: contentEditable box + drag handle */
let textEditing: { el: HTMLDivElement; docX: number; docY: number; wrap?: number } | null = null;
/** the text layer whose bounding box is currently selected (text tool) */
let textSel: Layer | null = null;
type TextHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
interface TextResize {
  layer: Layer;
  handle: TextHandleId;
  beforeMeta: TextLayerMeta;
  beforeTiles: TileImages;
  anchorBox: { x: number; y: number; w: number; h: number };
  /** current raster footprint, cleared before each reflow */
  lastFoot: { x: number; y: number; w: number; h: number };
}
let textResize: TextResize | null = null;
/** when set, committing the live box EDITS this layer instead of creating a new one */
let textTarget: Layer | null = null;

/** a run of text with one style — the live box can contain many (engine copy imported above) */
interface SegStyle {
  bold: boolean; italic: boolean; underline: boolean; strike: boolean; font: string;
  /** set only when this run overrides the layer's own size / colour */
  size?: number; color?: [number, number, number];
}

// A range captured from the live text box. Sliders and the colour picker move
// focus out of the contenteditable, so "what is selected" has to be remembered
// while it exists or per-run styling cannot reach it.
let savedTextRange: Range | null = null;

/** is the current DOM selection a non-collapsed range inside the live text box? */
function richSelection(): boolean {
  if (!textEditing) return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return textEditing.el.contains(sel.anchorNode) && textEditing.el.contains(sel.focusNode);
}

document.addEventListener("selectionchange", () => {
  if (!textEditing) { savedTextRange = null; return; }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0);
  if (textEditing.el.contains(r.startContainer) && textEditing.el.contains(r.endContainer)) {
    savedTextRange = r.cloneRange();
  }
});

/** wrap the remembered run in a span with one inline style; false = nothing selected */
function wrapSavedRun(apply: (span: HTMLSpanElement) => void): boolean {
  if (!textEditing || !savedTextRange || savedTextRange.collapsed) return false;
  const el = textEditing.el;
  if (el.contains(savedTextRange.commonAncestorContainer) === false) return false;
  const r = savedTextRange;
  try {
    const span = document.createElement("span");
    span.setAttribute("data-run", "1");
    apply(span);
    const frag = r.extractContents();
    span.appendChild(frag);
    r.insertNode(span);
    // keep the selection over the freshly wrapped run so the next control
    // applies to the same characters
    const next = document.createRange();
    next.selectNodeContents(span);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(next);
    savedTextRange = next.cloneRange();
    return true;
  } catch {
    return false;
  }
}

function cssColour(v: string): [number, number, number] | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (h) {
    const n = parseInt(h[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

/** apply a size or colour to the selected characters instead of the whole box */
function applyRunSize(px: number): boolean {
  return wrapSavedRun((span) => { span.style.fontSize = `${px}px`; });
}

function applyRunColour(rgb: [number, number, number]): boolean {
  return wrapSavedRun((span) => { span.style.color = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; });
}

/** apply a document.execCommand to the in-box selection; false = no live selection */
function applyRich(cmd: string, value?: string): boolean {
  if (!richSelection()) return false;
  try { return document.execCommand(cmd, false, value); } catch { return false; }
}

/** flatten the contentEditable DOM into styled text LINES (BR / block boundary = newline) */
function collectSegs(node: Node, style: SegStyle, lines: TextSeg[][]): void {
  const line = (): TextSeg[] => {
    if (!lines.length) lines.push([]);
    return lines[lines.length - 1]!;
  };
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.textContent) line().push({ text: node.textContent, ...style });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const tag = node.nodeName;
  if (tag === "BR") { lines.push([]); return; } // hard line break
  const el = node as HTMLElement;
  const s: SegStyle = { ...style };
  if (tag === "B" || tag === "STRONG") s.bold = true;
  if (tag === "I" || tag === "EM") s.italic = true;
  if (tag === "U") s.underline = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") s.strike = true;
  const face = el.getAttribute("face"); // execCommand("fontName") emits <font face="…">
  if (face) s.font = face;
  const st = el.style;
  if (st.fontFamily) s.font = st.fontFamily.replace(/["']/g, "");
  if (st.fontWeight && (st.fontWeight === "bold" || Number(st.fontWeight) >= 600)) s.bold = true;
  if (st.fontStyle === "italic") s.italic = true;
  if (st.textDecoration.includes("underline")) s.underline = true;
  if (st.textDecoration.includes("line-through")) s.strike = true;
  const px = parseFloat(st.fontSize);
  if (Number.isFinite(px) && px >= 1 && px <= 1000) s.size = px;
  const inline = st.color ? cssColour(st.color) : null;
  if (inline) s.color = inline;
  const attr = el.getAttribute("color"); // execCommand("foreColor") emits <font color>
  const fromAttr = attr ? cssColour(attr) : null;
  if (fromAttr) s.color = fromAttr;
  const kids = Array.from(el.childNodes);
  for (const k of kids) collectSegs(k, s, lines);
  // block-level children (DIV/P) imply a line break → start a new line
  if (tag === "DIV" || tag === "P") lines.push([]);
}

// ---- free transform (Ctrl+T) -------------------------------------------------
interface TransformState {
  src: { x: number; y: number; w: number; h: number }; // original layer bbox, doc coords
  cx: number; cy: number; // rotation center = bbox center, doc coords
  angle: number; // radians
  scaleX: number; scaleY: number;
  dx: number; dy: number; // translation, doc px
  snap: HTMLCanvasElement; // pre-transform layer pixels
  mode: "" | "move" | "scale" | "rotate";
  start: [number, number]; // last pointer pos, doc coords
  startAngle: number; // pointer angle when rotate drag began
  startDist: number; // pointer distance when scale drag began
  baseScale: number; // scale factor when scale drag began
  readout: HTMLSpanElement | null;
}
let transform: TransformState | null = null;

function transformCorners(t: TransformState): [number, number][] {
  const cxc = t.cx + t.dx, cyc = t.cy + t.dy;
  const cos = Math.cos(t.angle), sin = Math.sin(t.angle);
  const hw = (t.src.w / 2) * t.scaleX, hh = (t.src.h / 2) * t.scaleY;
  const rel: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return rel.map(([x, y]) => [x * cos - y * sin + cxc, x * sin + y * cos + cyc] as [number, number]);
}

function pointInQuad(x: number, y: number, quad: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = quad[i]!, [xj, yj] = quad[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function transformReadout(t: TransformState): string {
  return `W ${Math.round(t.src.w * t.scaleX)} · H ${Math.round(t.src.h * t.scaleY)} · ${Math.round((t.angle * 180) / Math.PI)}° · X ${Math.round(t.cx + t.dx)} · Y ${Math.round(t.cy + t.dy)}`;
}

function enterTransform(): void {
  commitText();
  if (activeLayer.locked) { warnLocked(); return; }
  // smart layers are transformable — that is their point — so the paint guard
  // is asked to allow them here
  if (refuseGroupPixels(activeLayer, true)) return;
  if (activeLayer.locked) { warnLocked(); return; }
  // A smart layer's footprint is the picture, not the tiles it sits in: the
  // source is captured tight, so the transform must measure the same edges or
  // each scale is off by the padding.
  const bb = (activeLayer.smart ? contentBounds(activeLayer.grid) : null) ?? gridBBox(activeLayer.grid);
  if (!bb || bb.w < 1 || bb.h < 1) return;
  const rgba = new Uint8ClampedArray(bb.w * bb.h * 4);
  activeLayer.grid.readRect(bb.x, bb.y, bb.w, bb.h, rgba);
  const snap = document.createElement("canvas");
  snap.width = bb.w;
  snap.height = bb.h;
  snap.getContext("2d")!.putImageData(new ImageData(rgba, bb.w, bb.h), 0, 0);
  transform = {
    src: bb, cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2,
    angle: 0, scaleX: 1, scaleY: 1, dx: 0, dy: 0, snap,
    mode: "", start: [0, 0], startAngle: 0, startDist: 1, baseScale: 1,
    readout: null,
  };
  deselect();
  refreshOptions();
  drawOverlay();
}

function undoDocument(): void {
  // A live Free Transform holds a snapshot of the document as it was; letting
  // history replace the document underneath it means the next Enter stamps
  // pre-undo pixels into the restored document (code-r27 #5). Cancel, then undo.
  if (transform) cancelTransform();
  if (session.undo()) applyHistoryChange();
}

function redoDocument(): void {
  if (transform) cancelTransform();
  if (session.redo()) applyHistoryChange();
}

function cancelTransform(): void {
  if (!transform) return;
  transform = null;
  refreshOptions();
  drawOverlay();
}

function applyTransform(): void {
  if (!transform) return;
  // Identity (Ctrl+T then Enter) rewrites identical pixels, and a snapshot
  // entry for that charges gigabytes on a large document (code-r30 #6).
  {
    const s = transform;
    if (s.angle === 0 && s.scaleX === 1 && s.scaleY === 1 && s.dx === 0 && s.dy === 0) {
      cancelTransform();
      return;
    }
  }
  const t = transform;
  transform = null;
  if (doc.inDocument(activeLayer)) {
    const layer = activeLayer;
    const spec = { angleDeg: (t.angle * 180) / Math.PI, scaleX: t.scaleX, scaleY: t.scaleY, dx: t.dx, dy: t.dy };
    const mask = layer.mask;
    const maskBefore = mask ? captureTiles(mask) : null;
    const hide0 = layer.maskHide === true;
    const label = `Transform ${Math.round((t.angle * 180) / Math.PI)}°`;
    // A live text layer carries a recipe that the transform rewrites; a
    // tiles-only snapshot restored the pixels and left the recipe moved, so
    // re-editing appeared at the new place and redo applied it twice.
    const smart0 = layer.smart;
    let smartDropped = false;
    const cb0 = contentBounds(layer.grid);
    if (layer.smart && !cb0) {
      // An empty smart layer (a loaded project can carry the source without
      // painted pixels) is not "clipped": rasterising it would say it reached
      // the edge and, with no tile change, leave no undo entry to restore the
      // source (code-r31 #4).
      statusHint("This smart object has no visible pixels — nothing to transform.");
      refreshOptions();
      drawOverlay();
      return;
    }
    const run = (): void => {
      if (layer.smart) {
        // A smart object scales from its SOURCE, not from the pixels on screen:
        // shrink to 25 % and back and the detail is still there. The mask must
        // pivot on the pixels' centre, not its own bbox, or an off-centre mask
        // drifts away from its layer on every transform.
        //
        // A footprint clipped by the canvas has no trustworthy footprint: the
        // tight bbox is the visible sliver, so deriving the source→screen scale
        // from it re-rendered the whole source at 80 % after one drag (code-r30
        // #1). Rasterise honestly in that case instead of guessing.
        const cb = cb0!;
        const cx = t.src.x + t.src.w / 2;
        const cy = t.src.y + t.src.h / 2;
        const clipped = cb.x <= 0 || cb.y <= 0 || cb.x + cb.w >= layer.grid.width || cb.y + cb.h >= layer.grid.height;
        // A rotation cannot be kept in the source: the next commit would derive
        // its scale from the rotated bbox and re-render the source at √2 size
        // (code-r37 #5), so a rotated smart object is rasterised honestly here.
        const rotated = spec.angleDeg !== 0;
        if (clipped || rotated) {
          // The preview pivots on the footprint; transformLayer pivots on
          // gridBBox (padded to 32 px), so a clipped commit landed up to half a
          // pad away from where the user saw it (code-r31 #3).
          transformGrid(layer.grid, spec, { bbox: t.src, centre: { x: cx, y: cy } });
          if (layer.mask) {
            transformGrid(layer.mask, spec, { empty: layer.maskHide ? 255 : 0, alpha: 255, ignoreAlpha: true, centre: { x: cx, y: cy } });
          }
          layer.smart = undefined;
          smartDropped = true;
          statusHint(rotated
            ? "A smart object cannot keep its source through a rotation, so it was rasterised for this transform."
            : "This smart object reaches the canvas edge, so it was rasterised for this transform.");
        } else {
        transformSmartGrid(layer.grid, layer.smart, spec, t.src.w, t.src.h);
        if (layer.mask) {
          transformGrid(layer.mask, spec, {
            empty: layer.maskHide ? 255 : 0,
            alpha: 255,
            ignoreAlpha: true,
            centre: { x: t.src.x + t.src.w / 2, y: t.src.y + t.src.h / 2 },
          });
        }
        }
      } else {
        transformLayer(layer, spec);
      }
    };
    const raw = layer.textData ? textOpCommand(layer, label, run) : layerOpCommand(layer, label, run);
    const entry = raw && smartDropped
      ? {
          label: raw.label,
          // The wrapper pins the source array; History evicts on bytes, so a
          // 20 MP source would sit outside the budget forever (code-r31 #5).
          bytes: (raw.bytes ?? 0) + (smart0 ? smart0.data.byteLength : 0),
          undo: () => { raw.undo(); layer.smart = smart0; },
          redo: () => { raw.redo(); layer.smart = undefined; },
        }
      : raw;
    if (entry) {
      const maskAfter = mask ? captureTiles(mask) : null;
      if (mask && maskBefore && maskAfter) {
        // The pixels and the mask are one layer: an undo that restores only the
        // pixels leaves the mask where the transform had already moved it.
        // Tiles created by the transform at the destination survive a plain
        // restoreTiles() (it only writes the keys it holds), so the mask left
        // a ghost where the old footprint ended. Clear, then restore.
        // A released hide-mask tile is absent, and clearAllocated() would
        // materialise zero (revealed) in every tile a snapshot does not name.
        // Fill with the polarity's neutral first, like snapshotCommand does,
        // so undo/redo cannot paint a revealed ghost (code-r42 F2).
        const neutral = hide0 ? 255 : 0;
        const clearMask = () => {
          mask.forEachTile((t) => { t.data.fill(neutral); t.version++; });
          mask.touch();
        };
        pushHist({
          label: entry.label,
          bytes: (entry.bytes ?? 0) + (maskBefore.size + maskAfter.size) * TILE_BYTES,
          undo: () => {
            entry.undo();
            layer.mask = mask;
            clearMask();
            restoreTiles(mask, maskBefore);
            layer.maskHide = hide0;
          },
          redo: () => {
            entry.redo();
            layer.mask = mask;
            clearMask();
            restoreTiles(mask, maskAfter);
            layer.maskHide = hide0;
          },
        });
      } else {
        pushHist(entry);
      }
    }
    render();
    renderLayers();
    renderHistoryPanel();
  }
  refreshOptions();
  drawOverlay();
}

function drawTransformOverlay(): void {
  if (!transform) return;
  const t = transform;
  octx.clearRect(0, 0, viewW, viewH);
  const [scx, scy] = docToScreen(t.cx + t.dx, t.cy + t.dy);
  octx.save();
  octx.translate(scx, scy);
  octx.rotate(t.angle);
  octx.scale(t.scaleX * scale, t.scaleY * scale);
  octx.drawImage(t.snap, -t.src.w / 2, -t.src.h / 2);
  octx.restore();
  const pts = transformCorners(t).map(([x, y]) => docToScreen(x, y));
  octx.strokeStyle = "#7fb2ff";
  octx.lineWidth = 1;
  octx.beginPath();
  octx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < 4; i++) octx.lineTo(pts[i]![0], pts[i]![1]);
  octx.closePath();
  octx.stroke();
  octx.fillStyle = "#fff";
  for (const [x, y] of pts) {
    octx.beginPath();
    octx.arc(x, y, 4, 0, Math.PI * 2);
    octx.fill();
  }
}

function docToScreen(x: number, y: number): [number, number] {
  return [x * scale + panX, y * scale + panY];
}

/** create an empty live text box at the click point (commits any open one) */
function startTextEditor(docX: number, docY: number, seedHtml?: string, wrap?: number): void {
  commitText();
  const host = document.getElementById("canvas-host")!;
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.spellcheck = false;
  // editing frame: thin dashed border, NO background fill (text stays readable
  // over any canvas); pre-wrap + explicit width make the DOM wrap exactly like
  // the rasterizer so what you type is what gets stamped
  el.style.cssText =
    "position:absolute;z-index:6;margin:0;padding:2px 3px;min-width:24px;min-height:1.3em;outline:none;white-space:pre-wrap;" +
    "border:1px dashed #1d4ed8;background:transparent;caret-color:#fff;box-sizing:content-box;overflow:visible";
  host.append(el);
  if (!seedHtml) textSel = null; // fresh box: hide the frame while typing
  textEditing = { el, docX, docY, wrap };
  if (seedHtml) el.innerHTML = seedHtml; // re-editing: restore styled content
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelText(); }
    e.stopPropagation(); // typing stays in the box (native undo while editing)
  });
  // clicking ANYWHERE outside the canvas (a swatch, a slider, another panel,
  // alt-tab) blurs the editor — the text must still be placed. Guarded by
  // identity: a REPLACED editor's dying blur must never commit (and destroy)
  // the freshly opened successor. commitText() also nulls textEditing before
  // removing el, so a removal-triggered blur re-entry is a no-op.
  el.addEventListener("blur", (ev) => {
    if (!textEditing || textEditing.el !== el) return;
    // Choosing a font, size or colour blurs the editor; committing there
    // destroyed the selection the style was meant to apply to. `relatedTarget`
    // names the control focus moved to, so this stays synchronous for every
    // other blur (a click on the canvas must commit at once).
    const to = ev.relatedTarget;
    if (to instanceof Element && (to.closest("#options") || to.closest(".color-pop"))) return;
    commitText();
  });
  restyleTextEditor();
  // DEFERRED focus: the click that opened this editor is still completing,
  // and its default action focuses #canvas-host (tabindex makes it focusable),
  // instantly blurring a synchronously focused el. Focusing from a macrotask
  // lands AFTER that default action, so no blur can fire on the way in.
  setTimeout(() => { if (textEditing && textEditing.el === el) el.focus(); }, 0);
}

/** keep the live box glued to the canvas (position in screen px, font scaled by zoom) */
function restyleTextEditor(): void {
  if (!textEditing) return;
  const { el, docX, docY, wrap } = textEditing;
  const [sx, sy] = docToScreen(docX, docY);
  el.style.left = `${sx}px`;
  el.style.top = `${sy}px`;
  el.style.font = `${textItalic ? "italic " : ""}${textBold ? "bold " : ""}${textSize * scale}px ${textFont}`;
  el.style.color = `rgb(${color[0]},${color[1]},${color[2]})`;
  el.style.textDecoration = `${textUnderline ? "underline " : ""}${textStrike ? "line-through" : ""}`.trim() || "none";
  el.style.width = wrap != null ? `${wrap * scale}px` : "";
  el.style.textAlign = textAlign;
}

/** ---- text-box selection: bounds, hit tests, reflow and the 8-handle frame ---- */

function cloneTextMeta(m: TextLayerMeta): TextLayerMeta {
  return {
    lines: m.lines.map(l => l.map(seg => ({ ...seg }))),
    x: m.x, y: m.y, w: m.w, h: m.h,
    ...(m.wrap != null ? { wrap: m.wrap } : {}),
    ...(m.boxH != null ? { boxH: m.boxH } : {}),
    size: m.size, color: [m.color[0], m.color[1], m.color[2]],
    ...(m.align && m.align !== "left" ? { align: m.align } : {}),
  };
}

/** the visible box: wrap width when set, else the raster width; boxH when the
 *  user dragged a top/bottom handle, else the content height */
function textBoxOf(m: TextLayerMeta): { x: number; y: number; w: number; h: number } {
  const w = m.wrap ?? m.w;
  const h = m.boxH ?? m.h;
  return { x: m.x, y: m.y, w: Math.max(w, 4), h: Math.max(h, Math.round(m.size * 1.1)) };
}

/** topmost text layer whose BOX contains the doc point */
function textLayerAt(x: number, y: number): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i]!;
    const m = l.textData;
    if (!m) continue;
    const b = textBoxOf(m);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return l;
  }
  return null;
}

/** which of the 8 handles is under the doc point (selected box only) */
function textHandleAtDoc(x: number, y: number): TextHandleId | null {
  const m = textSel?.textData;
  if (!textSel || !m) return null;
  const b = textBoxOf(m);
  const r = 7 / scale;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, x1 = b.x + b.w, y1 = b.y + b.h;
  const hs: [TextHandleId, number, number][] = [
    ["nw", b.x, b.y], ["n", cx, b.y], ["ne", x1, b.y],
    ["e", x1, cy], ["se", x1, y1], ["s", cx, y1], ["sw", b.x, y1], ["w", b.x, cy],
  ];
  for (const [id, hx, hy] of hs) {
    if (Math.abs(x - hx) <= r && Math.abs(y - hy) <= r) return id;
  }
  return null;
}

function handleCursor(handle: TextHandleId): string {
  if (handle === "nw" || handle === "se") return "nwse-resize";
  if (handle === "ne" || handle === "sw") return "nesw-resize";
  if (handle === "e" || handle === "w") return "ew-resize";
  return "ns-resize";
}

/** cursor for hovering with the text tool: handles resize, inside moves, else I-beam */
function textHoverCursor(x: number, y: number): string {
  const h = textHandleAtDoc(x, y);
  if (h) return handleCursor(h);
  const m = textSel?.textData;
  if (m) {
    const b = textBoxOf(m);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return "move";
  }
  return "text";
}

/** clear the old raster footprint, re-lay the stored recipe, stamp the new one */
function reflowTextLayer(layer: Layer, foot: { x: number; y: number; w: number; h: number }): void {
  const m = layer.textData;
  if (!m) return;
  if (foot.w > 0 && foot.h > 0) layer.grid.fillRect(foot.x, foot.y, foot.w, foot.h, [0, 0, 0, 0]);
  const r = rasterizeTextRich(m.lines, m.wrap, m.size, m.color, m.align ?? "left");
  if (r) {
    layer.grid.writeRect(m.x, m.y, r.cw, r.ch, r.rgba);
    m.w = r.cw;
    m.h = r.ch;
  } else {
    m.w = 0;
    m.h = 0;
  }
}

/**
 * Paragraph alignment for a text LAYER (not the live editor): rewrite the
 * recipe, re-raster it and record one undo entry. Whole-box operation, exactly
 * like Photoshop's paragraph controls.
 */
function alignTextLayer(layer: Layer, mode: TextAlign): void {
  const meta = layer.textData;
  if (!meta) return;
  if (layer.locked) { warnLocked(); return; }
  if ((meta.align ?? "left") === mode) return;
  const entry = textOpCommand(layer, "Text align", () => {
    meta.align = mode;
    reflowTextLayer(layer, { x: meta.x, y: meta.y, w: meta.w, h: meta.h });
  });
  if (entry) pushHist(entry);
  render();
  renderLayers();
  renderHistoryPanel();
  statusHint(`Text aligned ${mode}`);
}

function startTextResize(layer: Layer, handle: TextHandleId): void {
  const m = layer.textData;
  if (!m) return;
  if (layer.locked) { warnLocked(); return; }
  textSel = layer;
  if (activeLayer !== layer) { activeLayer = layer; renderLayers(); }
  textResize = {
    layer, handle,
    beforeMeta: cloneTextMeta(m),
    beforeTiles: captureTiles(layer.grid),
    anchorBox: textBoxOf(m),
    lastFoot: { x: m.x, y: m.y, w: m.w, h: m.h },
  };
  host.style.cursor = handleCursor(handle);
}

function updateTextResize(x: number, y: number): void {
  const d = textResize;
  if (!d) return;
  const m = d.layer.textData;
  if (!m) { textResize = null; return; }
  const a = d.anchorBox;
  const minW = Math.max(10, Math.round(m.size));
  const minH = Math.max(10, Math.round(m.size * 1.1));
  let nx = a.x, ny = a.y, nw = a.w, nh = a.h;
  if (d.handle.includes("w")) { nw = Math.max(minW, (a.x + a.w) - x); nx = (a.x + a.w) - nw; }
  if (d.handle.includes("e")) { nw = Math.max(minW, x - a.x); }
  if (d.handle.includes("n")) { nh = Math.max(minH, (a.y + a.h) - y); ny = (a.y + a.h) - nh; }
  if (d.handle.includes("s")) { nh = Math.max(minH, y - a.y); }
  m.x = Math.round(nx);
  m.y = Math.round(ny);
  m.wrap = Math.round(nw);
  if (d.handle === "n" || d.handle === "s") m.boxH = Math.round(nh);
  else m.boxH = undefined; // width/corner drags reflow: height follows content again
  reflowTextLayer(d.layer, d.lastFoot);
  d.lastFoot = { x: m.x, y: m.y, w: m.w, h: m.h };
  render();
  drawOverlay();
}

function finishTextResize(): void {
  const d = textResize;
  textResize = null;
  if (!d) return;
  const layer = d.layer;
  if (!doc.inDocument(layer)) return; // tab switched under us, or the group was deleted
  const m = layer.textData;
  if (!m) return;
  const label = `Text box ${Math.round(m.wrap ?? m.w)} \u00d7 ${Math.round(m.boxH ?? m.h)}`;
  // one entry, two dimensions: the pixel snapshot restores the stamp, the meta
  // restore brings back the recipe so undo/redo move box and pixels together
  const pxEntry = snapshotCommand(layer.grid, label, d.beforeTiles);
  if (!pxEntry) return; // pixels never changed: nothing to record
  const beforeMeta = d.beforeMeta;
  const afterMeta = cloneTextMeta(m);
  const entry: HistoryEntry = {
    label,
    bytes: pxEntry.bytes,
    undo: () => { pxEntry.undo(); layer.textData = cloneTextMeta(beforeMeta); },
    redo: () => { pxEntry.redo(); layer.textData = cloneTextMeta(afterMeta); },
  };
  pushHist(entry);
  render();
  renderLayers();
  renderHistoryPanel();
}

/** the selected text box: 1px dashed frame + 8 white handles, no fill */
function drawTextBoxOverlay(): void {
  if (textEditing || transform || !textSel) return;
  if (!doc.inDocument(textSel)) { textSel = null; return; }
  const m = textSel.textData;
  if (!m) { textSel = null; return; }
  const b = textBoxOf(m);
  const [sx, sy] = docToScreen(b.x, b.y);
  const sw = b.w * scale, sh = b.h * scale;
  if (sw < 1 || sh < 1) return;
  const frame = (): void => { octx.beginPath(); octx.rect(sx, sy, sw, sh); };
  octx.save();
  octx.lineWidth = 1;
  octx.setLineDash([4, 3]);
  octx.strokeStyle = "#fff"; // white under dark blue: readable on any canvas
  octx.lineDashOffset = 2;
  frame(); octx.stroke();
  octx.strokeStyle = "#1d4ed8";
  octx.lineDashOffset = 5.5;
  frame(); octx.stroke();
  octx.setLineDash([]);
  const hx = [sx, sx + sw / 2, sx + sw, sx + sw, sx + sw, sx + sw / 2, sx, sx];
  const hy = [sy, sy, sy, sy + sh / 2, sy + sh, sy + sh, sy + sh, sy + sh / 2];
  for (let i = 0; i < 8; i++) {
    octx.fillStyle = "#fff";
    octx.strokeStyle = "#222";
    octx.fillRect(hx[i]! - 4, hy[i]! - 4, 8, 8);
    octx.strokeRect(hx[i]! - 3.5, hy[i]! - 3.5, 7, 7);
  }
  // wrapped content taller than the box: small overflow marker, bottom-right
  if (m.boxH != null && m.h > m.boxH + 2) {
    octx.fillStyle = "#e5484d";
    octx.fillRect(sx + sw - 3, sy + sh - 3, 6, 6);
  }
  octx.restore();
}

/** rebuild live-editor HTML from stored segments (re-edit seeding) */


/** click on an existing text layer → reopen its live editor seeded with the stored recipe */
function openTextFor(layer: Layer): void {
  if (layer.locked) { warnLocked(); return; }
  const meta = layer.textData!;
  commitText(); // flush any live box FIRST, while the old text state/target still apply
  textTarget = layer;
  textSize = Math.min(200, Math.max(8, Math.round(meta.size)));
  color[0] = meta.color[0] ?? 0;
  color[1] = meta.color[1] ?? 0;
  color[2] = meta.color[2] ?? 0;
  syncColorWell();
  const first = meta.lines[0]?.[0];
  textBold = first?.bold ?? false;
  textItalic = first?.italic ?? false;
  textUnderline = first?.underline ?? false;
  textStrike = first?.strike ?? false;
  textFont = first?.font ?? "Arial";
  textAlign = meta.align ?? "left";
  refreshOptions(); // rebuild the text options bar with the restored size/font state
  startTextEditor(meta.x, meta.y, buildSeedHtml(meta.lines), meta.wrap);
}

/** one measurement/paint unit after layout (a seg may split across rows) */
interface TextPart { text: string; font: string; width: number; underline: boolean; strike: boolean; color?: [number, number, number]; }
interface TextRow { parts: TextPart[]; width: number; ascent: number; descent: number; last: boolean; }

/** split a source line into word/whitespace tokens, each carrying its seg style */
function tokenizeLine(segs: TextSeg[]): { text: string; seg: TextSeg }[] {
  const out: { text: string; seg: TextSeg }[] = [];
  for (const s of segs) {
    // a tab measures ~0 in canvas text and silently vanished: expand to a
    // fixed 4-space stop before tokenizing (tab stops are a typographic nicety
    // no other part of the pipeline models)
    for (const tok of s.text.replace(/\t/g, "    ").split(/(?<=\s)(?=\S)|(?<=\S)(?=\s)/)) {
      if (tok) out.push({ text: tok, seg: s });
    }
  }
  return out;
}

/** greedy word-wrap of one source line into rows no wider than `wrap` */
function wrapLineRows(toks: { text: string; seg: TextSeg }[], measure: (t: { text: string; seg: TextSeg }) => TextPart, wrap: number, maxAscent: number, maxDescent: number): TextRow[] {
  const rows: TextRow[] = [];
  let cur: TextRow = { parts: [], width: 0, ascent: 0, descent: 0, last: false };
  const flush = (): void => {
    rows.push(cur);
    cur = { parts: [], width: 0, ascent: 0, descent: 0, last: false };
  };
  for (const tok of toks) {
    const p = measure(tok);
    if (cur.parts.length && cur.width + p.width > wrap) {
      // the leading space of a wrapped row is dropped (standard reflow)
      if (/^\s+$/.test(p.text)) continue;
      flush();
    }
    if (cur.parts.length === 0 && p.width > wrap && !/^\s+$/.test(p.text)) {
      // a single word wider than the box: hard-break by characters
      const chars = Array.from(p.text);
      let chunk = "";
      let chunkW = 0;
      for (const ch of chars) {
        const w = measure({ text: ch, seg: tok.seg }).width;
        if (chunk && chunkW + w > wrap) {
          cur.parts.push({ ...p, text: chunk, width: chunkW });
          cur.width += chunkW;
          cur.ascent = maxAscent; cur.descent = maxDescent;
          flush();
          chunk = ch; chunkW = w;
        } else { chunk += ch; chunkW += w; }
      }
      if (chunk) {
        cur.parts.push({ ...p, text: chunk, width: chunkW });
        cur.width += chunkW;
        cur.ascent = maxAscent; cur.descent = maxDescent;
      }
      continue;
    }
    cur.parts.push(p);
    cur.width += p.width;
    cur.ascent = maxAscent; cur.descent = maxDescent;
  }
  rows.push(cur); // trailing row (possibly empty)
  // the final row of a paragraph is never justified (standard behaviour);
  // rows are built with last:false, so only the tail needs marking
  const tail = rows[rows.length - 1];
  if (tail) tail.last = true;
  return rows;
}

/** lay out mixed-styling lines (wrapping when `wrap` is set) into paint rows */
function layoutTextRich(lines: TextSeg[][], size: number, wrap?: number, col: [number, number, number] = [0, 0, 0]): TextRow[] {
  const mc = document.createElement("canvas");
  const mctx = mc.getContext("2d")!;
  const measure = (t: { text: string; seg: TextSeg }): TextPart => {
    const seg = t.seg;
    // a run with its own size is measured at that size, or the glyphs would
    // paint at one size inside a box laid out for another
    const font = runFont(seg, { size, color: col });
    mctx.font = font;
    const m = mctx.measureText(t.text);
    return {
      text: t.text, font, width: m.width, underline: seg.underline, strike: seg.strike,
      // the part carries its own colour so the paint loop can switch fillStyle
      // mid-line; a run without an override simply repeats the layer colour
      ...(seg.color ? { color: runColour(seg, { size, color: col }) } : {}),
    };
  };
  const rows: TextRow[] = [];
  for (const segs of lines) {
    let ascent = 0, descent = 0;
    for (const s of segs) {
      const px = runFontSize(s, { size, color: col });
      mctx.font = runFont(s, { size, color: col });
      const m = mctx.measureText(s.text || "Hg");
      ascent = Math.max(ascent, m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : px * 0.9);
      descent = Math.max(descent, m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : px * 0.3);
    }
    if (!segs.length) { ascent = size * 0.9; descent = size * 0.3; } // blank line still takes a line of height
    if (wrap != null && wrap > 0 && segs.length) {
      const toks = tokenizeLine(segs);
      if (toks.length) {
        const wrapped = wrapLineRows(toks, measure, wrap, ascent, descent);
        rows.push(...wrapped);
        continue;
      }
    }
    // no wrapping (or an empty line): one row per source line.
    // The row width MUST be the sum of the part widths — a hard 0 here made
    // rasterizeTextRich allocate a 2px canvas and clip every glyph away, so
    // committed text existed as a layer but had no pixels at all.
    const parts = segs.length ? segs.map(s => measure({ text: s.text, seg: s })) : [];
    let width = 0;
    for (const part of parts) width += part.width;
    rows.push({ parts, width, ascent, descent, last: true });
  }
  return rows;
}

/** measure + paint mixed-styling MULTILINE text; returns the raster or null when empty */
function rasterizeTextRich(lines: TextSeg[][], wrap?: number, size = textSize, col: [number, number, number] = color, align: TextAlign = "left"): { rgba: Uint8ClampedArray; cw: number; ch: number } | null {
  const gap = Math.max(1, Math.round(size * 0.2)); // leading between lines
  const rows = layoutTextRich(lines, size, wrap, col);
  if (!rows.length) return null;
  let maxW = 0, totalH = 0;
  rows.forEach((l, i) => {
    maxW = Math.max(maxW, l.width);
    totalH += l.ascent + l.descent + (i < rows.length - 1 ? gap : 0);
  });
  // SAFETY NET: a degenerate width silently produced an empty layer (the
  // v0.30.4 bug). If measurement comes back ~0 while there IS text — e.g. the
  // web font has not resolved yet in WebView2 — fall back to a heuristic so
  // glyphs are never clipped into a 2px canvas.
  if (maxW < 1) {
    // fix the measured widths themselves: sizing only the canvas left every
    // part at width 0, so all tokens overprinted at one x (a smear, not glyphs)
    for (const l of rows) {
      let w = 0;
      for (const p of l.parts) {
        if (p.width < 0.5) p.width = Math.max(1, p.text.length * size * 0.55);
        w += p.width;
      }
      l.width = w;
      if (w > maxW) maxW = w;
    }
  }
  // Alignment reference is the BOX width when the text lives in a box — never
  // the widest row: one oversized token used to inflate the reference and push
  // every other row inward. The canvas still has to fit that outlier.
  const boxW = wrap != null && wrap > 0 ? wrap : maxW;
  const cw = Math.ceil(Math.max(boxW, maxW)) + 2;
  const ch = Math.ceil(totalH) + 2;
  if (cw < 1 || ch < 1) return null;
  const mc = document.createElement("canvas");
  mc.width = cw;
  mc.height = ch;
  const ctx = mc.getContext("2d")!;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
  const lineH = Math.max(1, Math.round(size / 14));
  let y = 1;
  for (const l of rows) {
    // justify stretches the gaps between words on every line but the last of
    // a paragraph; the other modes shift the whole row inside the box
    let rowW = l.width;
    const gaps = l.parts.length - 1;
    let extra = 0;
    if (align === "justify" && !l.last && gaps > 0 && boxW > l.width + 0.5) {
      extra = (boxW - l.width) / gaps;
      rowW = boxW;
    }
    const startX = align === "center" ? (boxW - rowW) / 2
      : align === "right" ? boxW - rowW
      : 0;
    let cx = 1 + Math.max(0, startX);
    for (const p of l.parts) {
      ctx.font = p.font;
      if (p.color) ctx.fillStyle = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
      ctx.fillText(p.text, cx, y + l.ascent);
      // the word's rule spans its own glyphs PLUS the justified gap that
      // follows it, otherwise stretched lines leave bare holes in underline
      const ruleW = p.width + (extra > 0 ? extra : 0);
      if (p.underline) ctx.fillRect(cx, y + l.ascent + 1, ruleW, lineH);
      if (p.strike) ctx.fillRect(cx, y + Math.round(l.ascent * 0.55), ruleW, lineH);
      cx += p.width + extra;
    }
    y += l.ascent + l.descent + gap;
  }
  return { rgba: ctx.getImageData(0, 0, cw, ch).data, cw, ch };
}

/** commit the live box: edit the target layer in place, or create a new one */
/**
 * Escape = cancel, not commit (Photoshop muscle memory): the editor closes and
 * the layer keeps whatever it had. A fresh box that was never placed leaves no
 * trace at all — no layer, no history entry.
 */
function cancelText(): void {
  const ed = textEditing;
  if (!ed) return;
  textEditing = null; // null BEFORE remove: a removal-triggered blur must no-op
  ed.el.remove();
  textTarget = null;
  textSel = null;
  render();
  drawOverlay();
  renderLayers();
  refreshOptions();
  statusHint("Text cancelled");
}

function commitText(): void {
  if (!textEditing) return;
  const { el, docX, docY, wrap } = textEditing;
  const lines: TextSeg[][] = [];
  collectSegs(el, { bold: textBold, italic: textItalic, underline: textUnderline, strike: textStrike, font: textFont }, lines);
  textEditing = null; // null BEFORE remove: a remove-triggered blur must no-op
  el.remove();
  while (lines.length && !lines[lines.length - 1]!.length) lines.pop(); // drop trailing empty lines
  const text = lines.map(l => l.map(s => s.text).join("")).join("\n").replace(/\u00A0/g, " ").trim();
  const target = textTarget;
  textTarget = null;
  if (!text) {
    // emptied box on an existing text layer → clear its pixels (undoable)
    if (target && doc.inDocument(target) && target.textData) {
      const meta = target.textData;
      const entry = textOpCommand(target, "Clear text", () => {
        target.grid.fillRect(meta.x, meta.y, meta.w, meta.h, [0, 0, 0, 0]);
        target.textData = undefined;
      });
      if (entry) pushHist(entry);
      render();
      renderLayers();
      renderHistoryPanel();
    }
    return;
  }
  if (target && doc.inDocument(target)) {
    const rx = Math.round(docX), ry = Math.round(docY);
    const entry = textOpCommand(target, "Edit text", () => {
      const meta = target.textData;
      if (meta) target.grid.fillRect(meta.x, meta.y, meta.w, meta.h, [0, 0, 0, 0]); // clear old footprint
      const r = rasterizeTextRich(lines, wrap, textSize, color, textAlign);
      if (r) {
        target.grid.writeRect(rx, ry, r.cw, r.ch, r.rgba);
        target.textData = {
          lines: lines.map(l => l.map(s => ({ ...s }))),
          x: rx, y: ry, w: r.cw, h: r.ch,
          ...(wrap != null ? { wrap } : {}),
          size: textSize, color: [color[0], color[1], color[2]],
      ...(textAlign !== "left" ? { align: textAlign } : {}),
        };
      }
    });
    if (entry) pushHist(entry);
    textSel = target; // keep the committed box selected (handles stay up)
    render();
    renderLayers();
    renderHistoryPanel();
    statusHint("Text updated");
    return;
  }
  placeTextRich(lines, docX, docY, wrap);
}

/** stamp mixed-styling text as a NEW undoable layer; (x, y) = top-left in doc coords */
function placeTextRich(lines: TextSeg[][], x: number, y: number, wrap?: number): void {
  const r = rasterizeTextRich(lines, wrap, textSize, color, textAlign);
  if (!r) return;
  const content = lines.map(l => l.map(s => s.text).join("")).join(" ").replace(/\u00A0/g, " ").trim();
  const rx = Math.round(x), ry = Math.round(y);
  const layer = doc.addLayer(`Text: ${content.slice(0, 24)}`);
  // writeRect clips at doc bounds; negative-origin placement is safe
  layer.grid.writeRect(rx, ry, r.cw, r.ch, r.rgba);
  layer.textData = {
    lines: lines.map(l => l.map(s => ({ ...s }))),
    x: rx, y: ry, w: r.cw, h: r.ch,
    ...(wrap != null ? { wrap } : {}),
    size: textSize, color: [color[0], color[1], color[2]],
    ...(textAlign !== "left" ? { align: textAlign } : {}),
  };
  activeLayer = layer;
  textSel = layer; // fresh text stays selected with its handles
  pushHist(addAboveActive(doc, layer));
  render();
  renderLayers();
  renderHistoryPanel();
  statusHint(`Placed text · ${r.cw} × ${r.ch} px`);
}

function screenToDoc(e: PointerEvent): [number, number] {
  const rect = display.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  return [(sx - panX) / scale, (sy - panY) / scale];
}

// ---- Move tool ------------------------------------------------------------

function beginMoveDrag(x: number, y: number, ignoreSelection = false): void {
  commitText();
  const layer = activeLayer;
  if (!layer) return;
  if (layer.locked) { warnLocked(); return; }
  moveDrag = {
    layer,
    before: captureTiles(layer.grid),
    snap: snapshotGrid(layer.grid),
    mask: ignoreSelection ? null : selMask,
    startX: x,
    startY: y,
    text0: layer.textData ? { x: layer.textData.x, y: layer.textData.y } : null,
    dx: 0,
    dy: 0,
  };
}

function updateMoveDrag(x: number, y: number): void {
  const m = moveDrag;
  if (!m) return;
  const dx = Math.round(x - m.startX), dy = Math.round(y - m.startY);
  if (dx === m.dx && dy === m.dy) return;
  const prevDx = m.dx, prevDy = m.dy;
  m.dx = dx;
  m.dy = dy;
  applyLayerMove(m.layer.grid, m.snap, dx, dy, m.mask);
  // With a selection only the selected pixels move. Shifting the recipe too
  // would leave it describing a frame the raster never occupied (code-r22).
  if (m.text0 && m.layer.textData && !m.mask) {
    m.layer.textData.x = m.text0.x + dx;
    m.layer.textData.y = m.text0.y + dy;
  }
  // Only the pixels that can differ: the content's previous and current
  // rectangles. `completed` tells compositeRegion() it may mark the cache
  // composed, so renderFlat() does not recompose the whole document again —
  // the old code asked for a full-canvas rect and then recomposited it anyway.
  const b = m.snap.bounds;
  if (b) {
    const x0 = Math.max(0, Math.min(b.x + prevDx, b.x + dx));
    const y0 = Math.max(0, Math.min(b.y + prevDy, b.y + dy));
    const x1 = Math.min(doc.width - 1, Math.max(b.x + b.w - 1 + prevDx, b.x + b.w - 1 + dx));
    const y1 = Math.min(doc.height - 1, Math.max(b.y + b.h - 1 + prevDy, b.y + b.h - 1 + dy));
    if (x1 >= x0 && y1 >= y0) scheduleComposite(x0, y0, x1 - x0 + 1, y1 - y0 + 1, true);
  }
}

function endMoveDrag(): void {
  const m = moveDrag;
  moveDrag = null;
  if (!m) return;
  if (m.dx === 0 && m.dy === 0) return; // a click, not a drag
  const layer = m.layer;
  // The mask travels with the pixels. It is applied once, on release: the live
  // preview only needs the pixels, and translating a mask every pointermove
  // would compound its own rewrites.
  // A mask only travels when the whole layer moved. With a selection the pixel
  // move is clipped to it (applyLayerMove), so translating the mask under the
  // pixels that stayed put would hide and reveal the wrong window (code-r19 #6).
  const maskBefore = layer.mask && m.mask == null ? captureTiles(layer.mask) : null;
  if (layer.mask && maskBefore) {
    transformGrid(layer.mask, { angleDeg: 0, scaleX: 1, scaleY: 1, dx: m.dx, dy: m.dy }, {
      empty: layer.maskHide ? 255 : 0,
      alpha: 255,
      ignoreAlpha: true,
    });
  }
  // The drag left zeroed tiles in the union; release them once, here, so the
  // next transform pivots on the pixels instead of the swept area.
  layer.grid.releaseEmptyTiles();
  const pixels = snapshotCommand(layer.grid, "Move", m.before);
  // snapshotCommand fills tiles the op allocated and then reverted with the
  // grid's neutral; raw restoreTiles only wrote the keys it held, leaving a
  // ghost at the destination after undo (code-r19 #2).
  const maskEntry =
    layer.mask && maskBefore
      ? snapshotCommand(layer.mask, "Move mask", maskBefore, undefined, layer.maskHide ? 255 : 0)
      : null;
  const text0 = m.text0;
  const text1 = layer.textData ? { ...layer.textData } : null;
  // A layer can carry only a mask: its pixel grid has no tiles, so `pixels` is
  // null while `maskEntry` holds the whole edit. Gating history on `pixels`
  // dropped that step entirely, leaving a moved mask with no Ctrl+Z (code-r41).
  const parts = [pixels, maskEntry].filter((e): e is HistoryEntry => !!e);
  if (parts.length > 0) {
    const bytes = parts.reduce((n, e) => n + (e.bytes ?? 0), 0);
    // text layers move their metadata with them, so undo must restore both
    if (text0 || text1) {
      pushHist({
        label: "Move",
        bytes,
        undo: () => {
          for (const e of parts) e.undo();
          if (text0 && layer.textData) {
            layer.textData.x = text0.x;
            layer.textData.y = text0.y;
          }
        },
        redo: () => {
          for (const e of parts) e.redo();
          if (text1 && layer.textData) Object.assign(layer.textData, text1);
        },
      });
    } else if (parts.length === 1) {
      pushHist(parts[0]!);
    } else {
      pushHist({
        label: "Move",
        bytes,
        undo: () => { for (const e of parts) e.undo(); },
        redo: () => { for (const e of parts) e.redo(); },
      });
    }
  }
  render();
  renderLayers();
  renderHistoryPanel();
}

/** one-step translation for the arrow keys */
function nudgeActive(dx: number, dy: number): void {
  const layer = activeLayer;
  if (!layer) return;
  if (layer.locked) { warnLocked(); return; }
  commitText();
  const before = captureTiles(layer.grid);
  const mask = layer.mask;
  const maskBefore = mask && selMask == null ? captureTiles(mask) : null;
  applyLayerMove(layer.grid, snapshotGrid(layer.grid), dx, dy, selMask, true);
  if (mask && maskBefore) {
    transformGrid(mask, { angleDeg: 0, scaleX: 1, scaleY: 1, dx, dy }, {
      empty: layer.maskHide ? 255 : 0,
      alpha: 255,
      ignoreAlpha: true,
    });
  }
  if (layer.textData && selMask == null) {
    // With a selection only the selected pixels move; shifting the recipe too
    // left the raster and the recipe out of step (code-r23 #4).
    layer.textData.x += dx;
    layer.textData.y += dy;
  }
  const entry = snapshotCommand(layer.grid, "Nudge", before);
  const maskEntry =
    mask && maskBefore
      ? snapshotCommand(mask, "Nudge mask", maskBefore, undefined, layer.maskHide ? 255 : 0)
      : null;
  // A text layer's recipe moved too: an undo that restores pixels and leaves
  // textData displaced makes the next edit erase a footprint that is not there.
  // Only when the recipe moved: with a selection it deliberately did not, and
  // pre-shifting a snapshot that undo then restores drifted textData by
  // (-dx,-dy) on every nudge/undo pair (code-r24 #2).
  const movedText = layer.textData && selMask == null;
  const text0 = movedText ? cloneTextMeta(layer.textData!) : null;
  const text1 = text0 ? cloneTextMeta(text0) : null;
  if (text0) { text0.x -= dx; text0.y -= dy; }
  const parts = [entry, maskEntry].filter((e): e is HistoryEntry => !!e);
  if (parts.length === 0 && !text0) { render(); return; }
  pushHist({
    label: "Nudge",
    bytes: parts.reduce((n, e) => n + (e.bytes ?? 0), 0),
    undo: () => {
      for (const e of parts) e.undo();
      if (text0) layer.textData = cloneTextMeta(text0);
    },
    redo: () => {
      for (const e of parts) e.redo();
      if (text1) layer.textData = cloneTextMeta(text1);
    },
  });
  render();
  renderLayers();
  renderHistoryPanel();
}

// ---- Crop tool ------------------------------------------------------------

function applyCropNow(): void {
  const c = cropRect;
  cropRect = null;
  cropDrag = false;
  drawOverlay();
  if (!c || c.w < 2 || c.h < 2) return;
  setDocInTab(cropDocument(doc, c.x, c.y, c.w, c.h), "Crop");
  stopAnts();
  drawOverlay();
  refreshOptions();
}

function startPerspective(): void {
  if (transform) applyTransform();
  commitText();
  const base = cropRect ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  cropQuad = [
    [base.x, base.y],
    [base.x + base.w, base.y],
    [base.x + base.w, base.y + base.h],
    [base.x, base.y + base.h],
  ];
  drawOverlay();
  refreshOptions();
  statusHint("Drag the four corners · Enter applies · Esc cancels");
}

function cancelPerspective(): void {
  cropQuad = null;
  quadDragIdx = -1;
  // The hint describes a gesture that is no longer armed; leaving it behind
  // tells the user to drag corners that are not there.
  statusHint("");
  drawOverlay();
  refreshOptions();
}

function applyPerspectiveNow(): void {
  if (!cropQuad) return;
  const size = quadSize(cropQuad);
  const quad = cropQuad;
  cropQuad = null;
  quadDragIdx = -1;
  // A5: the warp blocks the main thread — 13 s at 8192². Anything painted in
  // the same task as the work never reaches the screen, so the busy state is
  // applied, then the work is deferred by one turn to let the frame land.
  document.body.classList.add("busy");
  statusHint(`Cropping to ${size.w} × ${size.h}…`);
  window.setTimeout(() => {
    try {
      const next = perspectiveCrop(doc, quad, size.w, size.h);
      setDocInTab(next.doc, "Perspective Crop");
      statusHint(`Perspective crop to ${size.w} × ${size.h}`);
    } catch (err) {
      statusHint(err instanceof Error ? err.message : "Perspective crop failed");
    } finally {
      document.body.classList.remove("busy");
    }
    refreshOptions();
    drawOverlay();
  }, 0);
}

/** Nearest quad corner within a screen-space radius, or -1. */
function quadCornerAt(x: number, y: number): number {
  if (!cropQuad) return -1;
  const r = 14 / Math.max(0.05, scale);
  let best = -1;
  let bestD = r;
  cropQuad.forEach(([qx, qy], i) => {
    const d = Math.hypot(qx - x, qy - y);
    if (d <= bestD) { bestD = d; best = i; }
  });
  return best;
}

function cancelCrop(): void {
  cropRect = null;
  cropDrag = false;
  drawOverlay();
}

display.addEventListener("pointerdown", (e) => {
  // commit a live text box before ANY branch returns: a middle/right click used
  // to leave the editor open while the rest of the UI thought it had committed
  commitText();
  // Space-drag and middle-drag pan, whatever the active tool is.
  if (zoomMode && e.button === 0) {
    const zr = host.getBoundingClientRect();
    zoomAt(e.altKey ? 1 / 1.6 : 1.6, e.clientX - zr.left, e.clientY - zr.top);
    return;
  }
  if (handMode && e.button === 0) {
    e.preventDefault();
    panning = true;
    panGrab = { sx: e.clientX, sy: e.clientY, px: panX, py: panY };
    host.style.cursor = "grabbing";
    return;
  }
  if (spaceDown || e.button === 1) {
    panning = true;
    panGrab = { sx: e.clientX, sy: e.clientY, px: panX, py: panY };
    midPan = e.button === 1 ? { moved: false } : null;
    stickyPrev = [e.clientX, e.clientY];
    try { display.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    host.style.cursor = "grabbing";
    e.preventDefault();
    return;
  }
  if (e.button === 2) return; // right is reserved for context menus
  try { display.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointers */ }
  const [x, y] = screenToDoc(e);
  if (tool === "patch") {
    // Ctrl+A makes selRect without a mask; currentSelectionMask() materialises
    // it, so "select all, patch" is not rejected while the ants are visible.
    if (!currentSelectionMask()) {
      statusHint("Patch needs a selection — drag out a marquee first.");
      return;
    }
    // Writing into a group's own grid paints pixels nothing draws, and a
    // smart object would drop the patch at its next transform.
    if (refuseGroupPixels(activeLayer)) return;
    if (refusePaintSurface(activeLayer)) return;
    patchStart = [x, y];
    // Keep the mask that was validated: currentSelectionMask() materialises a
    // rect-only selection without storing it, and the commit used the raw
    // global, so Select All + Patch painted nothing (uiux-r12 #1).
    patchMask = currentSelectionMask();
    patchLast = [x, y];
    statusHint("Drag the selection onto the pixels that should replace it.");
    return;
  }
  if (tool === "note") {
    const at: [number, number] = [Math.round(x), Math.round(y)];
    void askPrompt("Add note", "What should this note say?", "").then((text) => {
      const t = (text ?? "").trim();
      if (!t) return;
      notes.push({ x: at[0], y: at[1], text: t });
      refreshOptions();
      drawOverlay();
      statusHint(`Note ${notes.length}: ${t}`);
    });
    return;
  }
  if (transform) {
    const t = transform;
    t.start = [x, y];
    const quad = transformCorners(t);
    const handleR = 10 / scale; // 10 screen px in doc units
    let onHandle = false;
    for (const c of quad) if (Math.hypot(c[0] - x, c[1] - y) <= handleR) onHandle = true;
    if (onHandle) {
      t.mode = "scale";
      t.baseScale = t.scaleX;
      t.startDist = Math.max(1e-6, Math.hypot(x - (t.cx + t.dx), y - (t.cy + t.dy)));
    } else if (pointInQuad(x, y, quad)) {
      t.mode = "move";
    } else {
      t.mode = "rotate";
      t.startAngle = Math.atan2(y - (t.cy + t.dy), x - (t.cx + t.dx)) - t.angle;
    }
    return;
  }
  if (tool === "move") {
    beginMoveDrag(x, y);
    return;
  }
  if (cropQuad && tool === "crop") {
    const idx = quadCornerAt(x, y);
    if (idx >= 0) { quadDragIdx = idx; return; }
  }
  if (tool === "crop") {
    cropDrag = true;
    cropStart = [x, y];
    cropRect = rectFrom([x, y], [x, y]);
    drawOverlay();
    return;
  }
  if (tool === "polylasso") {
    // A click near the first point closes the polygon; each other click adds
    // one. The first point of a new polygon drops any old selection.
    if (polyPts.length >= 3) {
      const first = polyPts[0];
      const [fx, fy] = first ?? [0, 0];
      if (Math.hypot(x - fx, y - fy) <= 8 / Math.max(scale, 0.01)) { endPolyLasso(true, doc.width, doc.height); return; }
    }
    if (polyPts.length === 0) {
      // Keep what the first click replaces: cancelling a polygon used to leave
      // the old selection gone with no undo step (code-r36 #5, uiux-r36 #4).
      polyBefore = snapshotSelection();
      polyMode = e.shiftKey ? "add" : e.altKey ? "subtract" : "replace";
      selRect = null;
      selMask = null;
    }
    polyPts.push([x, y]);
    selGeom = { kind: "poly", pts: polyPts };
    drawOverlay();
    return;
  }
  if (tool === "marquee" || tool === "ellipse" || tool === "lasso" || tool === "magnet") {
    // starting a fresh selection invalidates the old one of ANY shape — keep a
    // snapshot first, because pointerup used to snapshot the *new* selection
    // and undo then left a sub-rect outline with no mask (a Move shifted the
    // whole layer under it).
    selBefore = snapshotSelection();
    selDragMode = e.shiftKey ? "add" : e.altKey ? "subtract" : "replace";
    selDragBase = selDragMode === "replace" ? null : currentSelectionMask();
    selRect = null;
    selMask = null;
    selGeom = null;
    if (tool === "marquee") {
      marqueeing = true;
      marqueeStart = [x, y];
      selShiftAtPress = e.shiftKey;
    } else if (tool === "ellipse") {
      ellipseDrag = true;
      ellipseStart = [x, y];
      selShiftAtPress = e.shiftKey;
    } else if (tool === "magnet") {
      lassoing = true;
      lassoPts = [[x, y]];
    } else {
      lassoing = true;
      lassoPts = [[x, y]];
    }
    drawOverlay();
    return;
  }
  if (tool === "shape") {
    // Alt-drag builds a selection, which is not a pixel edit; only the normal
    // shape rasteriser has to stay off a group's empty grid.
    if (!e.altKey && refuseGroupPixels(activeLayer)) return;
    shapeDrag = { x0: x, y0: y, x1: x, y1: y, toSelection: e.altKey };
    return;
  }
  if (tool === "pen" && freeformPen) {
    ffDrag = true;
    ffPts = [[x, y]];
    selGeom = { kind: "poly", pts: ffPts };
    drawOverlay();
    return;
  }
  if (tool === "pen") {
    // double-click closes; a plain click keeps dropping anchors
    if (e.detail >= 2 && penAnchors.length >= 3) { commitPenPath(); return; }
    // Push a corner anchor; dragging from here turns it into a smooth one.
    penAnchors.push({ x, y });
    penDragIdx = penAnchors.length - 1;
    selGeom = { kind: "poly", pts: flattenPath(penAnchors, false) };
    drawOverlay();
    return;
  }
  if (tool === "quick") {
    // Keep painting=true so pointermove reaches paintDabs; there is no
    // StrokeSession because no layer pixels are written.
    painting = true;
    quickMode = e.altKey ? "subtract" : "add";
    quickApplied = null;
    lastX = x; lastY = y;
    rawCursor = [x, y];
    quickDab(x, y, quickMode);
    return;
  }
  if (tool === "wand") {
    pickWand(x, y, e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");
    return;
  }
  if (tool === "eyedropper") { pickColor(x, y); return; }
  if (tool === "sampler") {
    if (e.altKey) {
      samples = [];
      statusHint("Colour samples cleared.");
    } else if (samples.length >= 4) {
      statusHint("Four colour samples is the maximum — Alt-click to clear them.");
      return;
    } else {
      const sx = Math.round(x), sy = Math.round(y);
      samples.push([sx, sy]);
      if (flatCache.needsComposite(doc.revision)) renderFlat();
      const c = sampleColor({ width: doc.width, height: doc.height, data: flatCache.buffer }, sx, sy, 1);
      statusHint(c ? `Sample ${samples.length}: ${sx}, ${sy} ${hex([c.r, c.g, c.b])}` : `Sample ${samples.length}: ${sx}, ${sy}`);
    }
    refreshOptions();
    drawOverlay();
    return;
  }
  if (tool === "ruler") {
    rulerA = [x, y];
    rulerB = [x, y];
    rulerDrag = true;
    refreshOptions();
    drawOverlay();
    return;
  }
  if (tool === "count") {
    const cx = Math.round(x), cy = Math.round(y);
    counts.push([cx, cy]);
    statusHint(`Count ${counts.length}: ${cx}, ${cy}`);
    refreshOptions();
    drawOverlay();
    return;
  }
  if (tool === "clone") {
    if (e.altKey) { cloneSrc = [x, y]; drawOverlay(); return; } // Alt-click samples
    if (!cloneSrc) { pulse(toolbar); return; }
    cloneOffset = cloneAligned
      ? [cloneSrc[0] - x, cloneSrc[1] - y]
      : (cloneOffset ?? [cloneSrc[0] - x, cloneSrc[1] - y]);
  }
  if (tool === "retouch" && e.altKey) {
    retouchMode = retouchMode === "dodge" ? "burn" : retouchMode === "burn" ? "sponge" : retouchMode === "sponge" ? "redEye" : "dodge";
    refreshOptions();
    return;
  }
  if (tool === "focus" && e.altKey) {
    focusMode = focusMode === "blur" ? "sharpen" : focusMode === "sharpen" ? "smudge" : "blur";
    refreshOptions();
    return;
  }
  if (tool === "bucket") { pourBucket(x, y); return; }
  if (tool === "magicerase") { magicErase(x, y, activeLayer, doc.width, doc.height, selMask); return; }
  if (tool === "gradient") {
    if (refuseGroupPixels(activeLayer)) return;
    if (refusePaintSurface(activeLayer)) return;
    gradientDrag = true;
    gradStart = [x, y];
    gradEnd = [x, y];
    drawOverlay();
    return;
  }
  if (tool === "text") {
    // selection-first: single click selects the box (frame + 8 handles),
    // double click reopens the live editor, dragging inside moves, dragging a
    // handle reflows/resizes the text (Photoshop paragraph-box behaviour)
    const hit = textLayerAt(x, y);
    if (hit?.locked) { warnLocked(); return; }
    if (hit) {
      if (textSel === hit && e.detail >= 2) { openTextFor(hit); return; }
      const h = textSel === hit ? textHandleAtDoc(x, y) : null;
      if (h) { startTextResize(hit, h); return; }
      if (textSel !== hit) {
        textSel = hit;
        if (!hit.locked && activeLayer !== hit) activeLayer = hit;
        renderLayers();
        refreshOptions();
        drawOverlay();
        // press-drag on a fresh selection moves it in one gesture
        beginMoveDrag(x, y, true);
        return;
      }
      beginMoveDrag(x, y, true);
      return;
    }
    // click on empty canvas: deselect AND start the new editor in ONE click —
    // returning after the deselect (the old behaviour) made the tool feel dead:
    // the user clicked once, typed nothing-into-nothing and Enter did nothing
    if (textSel) { textSel = null; drawOverlay(); }
    startTextEditor(x, y);
    return;
  }
  // a lost pointerup (alt-tab, capture revoked) would otherwise leave an
  // unclosed session that makes the NEXT stroke un-undoable: close it first
  if (strokeSession) endStroke();
  // Brush/eraser/heal/retouch/clone all reach this point with a pixel target.
  // A mask is its own surface, and a group may own one the compositor applies
  // (code-r17 #4), so the group refusal yields when the mask is the target.
  const onMaskSurface = paintTarget === "mask" && !!activeLayer.mask;
  if (!onMaskSurface && refuseGroupPixels(activeLayer)) return;
  if (refusePaintSurface(activeLayer, onMaskSurface)) return;
  painting = true;
  strokeAlt = e.altKey;
  strokeRnd = brushRandom((Date.now() ^ (x * 7919) ^ (y * 104729)) >>> 0);
  strokeSession = new StrokeSession();
  if (paintTarget === "mask" && activeLayer.mask) maskStrokeBefore = captureTiles(activeLayer.mask);
  else maskStrokeBefore = null;
  lastX = x; lastY = y;
  rawCursor = [x, y];
  smudgePrev = [x, y];
  paintDabs(x, y, e.pressure, tiltOf(e));
  // Airbrush starts in the same gesture: the first dab is the dab paintDabs
  // just made, and the timer takes over from there if nothing moves.
  if (airbrushOn && (tool === "brush" || tool === "eraser") && painting) airbrush.start(x, y);
});

display.addEventListener("pointermove", (e) => {
  const hb = host.getBoundingClientRect();
  hoverPos = [e.clientX - hb.left, e.clientY - hb.top];
  {
    const [ix, iy] = screenToDoc(e);
    infoPanel.update({ x: ix, y: iy, colour: compositeSampleAt(ix, iy) });
  }
  // a lost pointerup (alt-tab, capture revoked) must never leave a stroke open:
  // the next hover would otherwise keep painting with no button held
  if (painting && e.buttons === 0) endStroke();
  if (rulerDrag && e.buttons !== 0) {
    const [rx, ry] = screenToDoc(e);
    rulerB = [rx, ry];
    refreshOptions();
    drawOverlay();
    return;
  }
  if (tool === "patch" && patchStart && e.buttons !== 0) {
    const [px, py] = screenToDoc(e);
    patchLast = [px, py];
    // No statusHint here: it is a polite live region, and one announcement per
    // pointermove queues a sentence per pixel of travel (uiux-r27 #3). The
    // overlay already draws the offset; the release reports it once.
    drawOverlay();
    return;
  }
  // Notes are only useful if their text can be read again: surface it while
  // the pointer is over the marker, since the canvas has no tooltip.
  if (tool === "note" && notes.length > 0) {
    const [nx, ny] = screenToDoc(e);
    const hit = notes.findIndex((n) => Math.hypot(n.x - nx, n.y - ny) <= 8 / Math.max(scale, 0.01));
    if (hit >= 0) {
      // Same live region as the patch drag: one announcement per marker, not
      // per pointermove inside it (uiux-r28 note).
      const text = `Note ${hit + 1}: ${notes[hit]!.text}`;
      if (lastNoteHint !== text) {
        lastNoteHint = text;
        statusHint(text);
      }
    }
  }
  if (panSticky && !panning) {
    // sticky middle-click pan: the canvas follows the pointer with no button held
    const dx = e.clientX - stickyPrev[0];
    const dy = e.clientY - stickyPrev[1];
    stickyPrev = [e.clientX, e.clientY];
    if (dx !== 0 || dy !== 0) {
      panX += dx; panY += dy;
      render();
      drawOverlay();
    }
    return;
  }
  if (panning && panGrab) {
    if (midPan && Math.hypot(e.clientX - panGrab.sx, e.clientY - panGrab.sy) > 3) midPan.moved = true;
    panX = panGrab.px + (e.clientX - panGrab.sx);
    panY = panGrab.py + (e.clientY - panGrab.sy);
    render();
    drawOverlay();
    return;
  }
  if (textResize) {
    const [x, y] = screenToDoc(e);
    updateTextResize(x, y);
    return;
  }
  if (!panning && !painting && !transform && !moveDrag) drawOverlay();
  if (moveDrag) {
    const [x, y] = screenToDoc(e);
    updateMoveDrag(x, y);
    return;
  }
  if (shapeDrag) {
    const [x, y] = screenToDoc(e);
    shapeDrag.x1 = x;
    shapeDrag.y1 = y;
    drawOverlay();
    return;
  }
  if (quadDragIdx >= 0 && cropQuad) {
    const [qx, qy] = screenToDoc(e);
    cropQuad[quadDragIdx] = [qx, qy];
    drawOverlay();
    refreshOptions();
    return;
  }
  if (cropDrag) {
    const [x, y] = screenToDoc(e);
    cropRect = rectFrom(cropStart, [x, y]);
    drawOverlay();
    return;
  }
  if (transform && transform.mode) {
    const t = transform;
    const [x, y] = screenToDoc(e);
    if (t.mode === "move") {
      t.dx += x - t.start[0];
      t.dy += y - t.start[1];
      t.start = [x, y];
    } else if (t.mode === "scale") {
      const d = Math.hypot(x - (t.cx + t.dx), y - (t.cy + t.dy));
      const f = Math.max(0.05, (d / t.startDist) * t.baseScale);
      t.scaleX = f;
      t.scaleY = f;
    } else {
      let a = Math.atan2(y - (t.cy + t.dy), x - (t.cx + t.dx)) - t.startAngle;
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); // 15° snap
      t.angle = a;
    }
    drawTransformOverlay();
    if (t.readout) t.readout.textContent = transformReadout(t);
    return;
  }
  if (marqueeing) {
    const [x, y] = screenToDoc(e);
    selRect = (e.shiftKey && !selShiftAtPress) ? squareRect(marqueeStart, [x, y]) : rectFrom(marqueeStart, [x, y]);
    drawOverlay();
    return;
  }
  if (ellipseDrag) {
    const [x, y] = screenToDoc(e);
    selGeom = { kind: "ellipse", ...((e.shiftKey && !selShiftAtPress) ? squareRect(ellipseStart, [x, y]) : rectFrom(ellipseStart, [x, y])) };
    drawOverlay();
    return;
  }
  if (tool === "pen" && penAnchors.length > 0) {
    penCursor = screenToDoc(e);
    // AI1: this used to be `if (penDragIdx >= 0) penDragIdx = -1;` on the line
    // above, which cleared the index in the same tick that read it — so
    // dragAnchor was always undefined and the handle could never be set. The
    // reset belongs to the gesture END (endStroke), not to every move.
    const dragAnchor = penDragIdx >= 0 ? penAnchors[penDragIdx] : undefined;
    if (dragAnchor && e.buttons > 0) {
      // AI1: the threshold rule lives in the engine so it can be tested; the
      // sub-3px wobble of a click is what keeps a corner sharp.
      const bent = penHandleFor(dragAnchor, penCursor[0] - dragAnchor.x, penCursor[1] - dragAnchor.y);
      dragAnchor.hx = bent.hx;
      dragAnchor.hy = bent.hy;
    }
    selGeom = { kind: "poly", pts: flattenPath(penAnchors, false) };
    drawOverlay();
    return;
  }
  if (tool === "polylasso" && polyPts.length > 0) {
    const [x, y] = screenToDoc(e);
    selGeom = { kind: "poly", pts: [...polyPts, [x, y]] };
    drawOverlay();
    return;
  }
  if (ffDrag) {
    const [x, y] = screenToDoc(e);
    // Same reasoning as the lasso: hundreds of points make the fill test
    // every edge for every pixel; 3 document px is invisible in the outline.
    const last = ffPts[ffPts.length - 1];
    if (!last || Math.hypot(x - last[0], y - last[1]) >= 3) ffPts.push([x, y]);
    selGeom = { kind: "poly", pts: ffPts };
    drawOverlay();
    return;
  }
  if (lassoing) {
    const [x, y] = screenToDoc(e);
    // Morphological fill tests every edge for every pixel in the bbox, so a
    // pointermove-per-point drag can run for minutes. Two document pixels is
    // below what the ants can show; 512 points is a gesture, not a map.
    const last = lassoPts[lassoPts.length - 1];
    if ((!last || Math.hypot(x - last[0], y - last[1]) >= 2) && lassoPts.length < 512) lassoPts.push([x, y]);
    selGeom = { kind: "poly", pts: lassoPts };
    drawOverlay();
    return;
  }
  if (gradientDrag) {
    const [x, y] = screenToDoc(e);
    gradEnd = [x, y];
    drawOverlay();
    return;
  }
  if (tool === "text" && !textEditing && !transform) {
    const [x, y] = screenToDoc(e);
    host.style.cursor = textHoverCursor(x, y);
  }
  if (!painting) return;
  // recompute coalesced events for smooth strokes; paintDabs advances
  // lastX/lastY itself, so each sub-event continues from the previous one
  const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
  // pulled-string smoothing: the brush tip chases the cursor at 1−smooth/100
  // of the remaining distance per event — high smooth = rope-like lag
  const chase = brushSmooth > 0 ? Math.max(0.02, 1 - brushSmooth / 100) : 1;
  for (const ev of events.length ? events : [e]) {
    const pe = ev as PointerEvent;
    const [ex, ey] = screenToDoc(pe);
    rawCursor = [ex, ey];
    if (tool === "quick") quickMode = pe.altKey ? "subtract" : "add";
    const tilt = tiltOf(pe);
    if (chase < 1) {
      // anchor chases the raw cursor; paint only the smoothed advance
      const nx = lastX + (ex - lastX) * chase;
      const ny = lastY + (ey - lastY) * chase;
      paintDabs(nx, ny, pe.pressure || e.pressure, tilt);
    } else {
      paintDabs(ex, ey, pe.pressure || e.pressure, tilt);
    }
  }
  if (airbrush.active() && rawCursor) airbrush.move(rawCursor[0], rawCursor[1]);
});

/** Finish a pan: a middle press that never moved toggles sticky pan mode. */
function endPan(): void {
  const wasPanning = panning;
  const tap = wasPanning && !!midPan && !midPan.moved;
  panning = false;
  panGrab = null;
  midPan = null;
  if (tap) panSticky = !panSticky;
  syncCursor();
}

display.addEventListener("pointerup", () => {
  if (tool === "patch" && patchStart && patchLast) {
    const dx = Math.round(patchLast[0] - patchStart[0]);
    const dy = Math.round(patchLast[1] - patchStart[1]);
    // The callback runs synchronously inside layerOpCommand, so clearing the
    // field first made every Patch a no-op ("found nothing to copy there").
    const mask = patchMask;
    patchStart = null;
    patchLast = null;
    patchMask = null;
    if (dx === 0 && dy === 0) {
      statusHint("Patch: drag the selection somewhere to pick a source.");
    } else {
      let patched: { x: number; y: number; w: number; h: number } | null = null;
      // A patch only touches the selection's bbox: a whole-layer snapshot per
      // drag cost ~96 MB on a 12 MP layer and evicted real undo steps.
      const bb = mask && mask.bbox();
      const op = bb
        ? layerOpCommandIn(activeLayer, "Patch", () => {
            patched = patchFromOffset(activeLayer.grid, mask, dx, dy);
          }, bb)
        : layerOpCommand(activeLayer, "Patch", () => {
            patched = patchFromOffset(activeLayer.grid, mask, dx, dy);
          });
      if (op) {
        pushHist(op);
        declaredChange();
        render();
        const r = patched as { x: number; y: number; w: number; h: number } | null;
        if (r) statusHint(`Patched ${r.w} × ${r.h} pixels from ${dx}, ${dy}.`);
        else statusHint("Patch found nothing to copy there.");
      } else {
        statusHint("Patch found nothing to copy there.");
      }
    }
  }
  if (rulerDrag) {
    rulerDrag = false;
    refreshOptions();
  }
  endStroke();
  endPan();
});
display.addEventListener("pointercancel", () => {
  endStroke();
  endPan();
});
display.addEventListener("pointerleave", () => { if (panning) endPan(); });
display.addEventListener("dblclick", () => { if (tool === "polylasso" && polyPts.length >= 3) endPolyLasso(true, doc.width, doc.height); });
window.addEventListener("pointerup", () => { if (panning) endPan(); });

/** Pen → selection: the collected anchors become an antialiased mask. */
function commitPenPath(): void {
  if (penAnchors.length < 3) {
    penAnchors = [];
    penCursor = null;
    selGeom = null;
    drawOverlay();
    statusHint("A path needs at least three anchors.");
    return;
  }
  const next = new SelectionMask(doc.width, doc.height);
  // AI3: a path is filled with the non-zero rule (what a shape outline means);
  // an empty result must not silently replace a real selection.
  const filled = next.selectPolygon(flattenPath(penAnchors, true), "nonzero");
  penAnchors = [];
  penCursor = null;
  selGeom = null;
  if (!filled) {
    drawOverlay();
    statusHint("The path enclosed no pixels — the selection was left alone.");
    return;
  }
  applySelectionMask(next);
  statusHint("Path closed into a selection.");
}

function cancelPenPath(): boolean {
  if (penAnchors.length === 0) return false;
  penAnchors = [];
  penCursor = null;
  selGeom = null;
  drawOverlay();
  statusHint("Pen path cancelled.");
  return true;
}
/** Polygonal lasso: click-by-click outline. `commit` closes it into a mask;
 *  otherwise the open outline is discarded. */
function endPolyLasso(commit: boolean, w: number, h: number): boolean {
  if (polyPts.length === 0) return false;
  const restoreBefore = (): void => {
    if (polyBefore) restoreSelection(polyBefore);
    polyBefore = null;
    polyMode = "replace";
  };
  if (!commit) {
    polyPts = [];
    selGeom = null;
    restoreBefore();
    drawOverlay();
    statusHint("Polygonal selection cancelled; the previous selection is back.");
    return true;
  }
  if (polyPts.length < 3) {
    polyPts = [];
    selGeom = null;
    restoreBefore();
    drawOverlay();
    statusHint("A polygonal selection needs at least three points; the previous selection is back.");
    return true;
  }
  const next = polygonMask(w, h, polyPts);
  polyPts = [];
  selGeom = null;
  if (!next) {
    restoreBefore();
    drawOverlay();
    statusHint("The polygon enclosed no pixels — the selection was left alone.");
    return true;
  }
  const before = polyBefore ?? snapshotSelection();
  let base: SelectionMask | null = null;
  if (polyMode !== "replace") {
    base = before.mask;
    if (!base && before.rect) {
      base = new SelectionMask(w, h);
      base.selectRect(before.rect.x, before.rect.y, before.rect.w, before.rect.h);
    }
  }
  const merged = base ? mergeSelection(base, next, polyMode, w, h) : next;
  polyBefore = null;
  polyMode = "replace";
  applySelectionMask(merged, "Polygon select", before);
  statusHint("Polygon closed into a selection.");
  return true;
}

/**
 * Close (or cancel) a freehand pen path into a selection. Point count is
 * capped by decimation here rather than in the engine: a 3 px spacing is below
 * what the ants can draw, and the morphological fill is quadratic in edges.
 */
function endFreeformPath(commit: boolean, w: number, h: number): boolean {
  if (!ffDrag) return false;
  ffDrag = false;
  const pts = ffPts;
  ffPts = [];
  selGeom = null;
  if (!commit) {
    drawOverlay();
    statusHint("Freeform path cancelled.");
    return true;
  }
  if (pts.length < 3) {
    drawOverlay();
    statusHint("A freeform path needs a drag, not a click.");
    return true;
  }
  const step = Math.max(1, Math.ceil(pts.length / 96));
  const simple = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const next = polygonMask(w, h, simple);
  if (!next) {
    drawOverlay();
    statusHint("The path enclosed no pixels — the selection was left alone.");
    return true;
  }
  applySelectionMask(next, "Freeform path");
  statusHint("Freeform path closed into a selection.");
  return true;
}

function commitShape(): void {
  if (!shapeDrag) return;
  const { x0, y0, x1, y1, toSelection } = shapeDrag;
  shapeDrag = null;
  if (Math.abs(x1 - x0) < 2 && Math.abs(y1 - y0) < 2) { drawOverlay(); return; }
  const kind = shapeKind;
  // Alt-drag writes a selection, not pixels, so it must not be refused on a
  // locked or computed layer — and returning above left the ghost drawn
  // (code-r16 #1).
  if (!toSelection && refusePaintSurface(activeLayer)) { drawOverlay(); return; }
  if (toSelection) {
    // Alt-drag: the shape becomes a selection instead of pixels
    const next = new SelectionMask(doc.width, doc.height);
    // SelectionMask already implements the sink contract, so it receives the shape directly
    shapeSelection(doc.width, doc.height, { kind, x0, y0, x1, y1, sides: shapeSides, strokeWidth: shapeStrokeW }, next);
    if (!next.isEmpty()) {
      selMask = next;
      selRect = next.isRect() ? next.bbox() : null;
      startAnts();
    }
    drawOverlay();
    refreshOptions();
    return;
  }
  const sides = shapeSides;
  const strokeW = shapeStrokeW;
  const fill: [number, number, number] = shapeFill ?? [color[0], color[1], color[2]];
  const stroke: [number, number, number] = shapeStroke ?? [bgColor[0], bgColor[1], bgColor[2]];
  const label = `Shape ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  // the rasterised bbox never exceeds the drag rect plus the stroke pad
  const pad = Math.max(strokeW, kind === "line" ? Math.ceil(strokeW / 2) : 0) + 2;
  const srect = {
    x: Math.floor(Math.min(x0, x1) - pad),
    y: Math.floor(Math.min(y0, y1) - pad),
    w: Math.ceil(Math.abs(x1 - x0) + pad * 2),
    h: Math.ceil(Math.abs(y1 - y0) + pad * 2),
  };
  const entry = layerOpCommandIn(activeLayer, label, () => {
    drawShape(activeLayer.grid, {
      kind,
      x0, y0, x1, y1,
      fill,
      fillAlpha: 1,
      sides,
      stroke: strokeW > 0 ? stroke : undefined,
      strokeWidth: strokeW,
      mask: selMask ?? undefined,
    });
  }, srect);
  if (entry) pushHist(entry);
  render();
  renderHistoryPanel();
  renderLayers();
}

/** Rebuild the area under a healing stroke from its surroundings. */
function commitHeal(): void {
  const mask = healMask;
  const rect = healRect;
  healMask = null;
  healRect = null;
  if (!mask || !rect) return;
  const clipped = {
    x: Math.max(0, rect.x), y: Math.max(0, rect.y),
    w: Math.min(rect.w, doc.width - Math.max(0, rect.x)),
    h: Math.min(rect.h, doc.height - Math.max(0, rect.y)),
  };
  if (clipped.w < 1 || clipped.h < 1) return;
  const layer = activeLayer;
  // only the touched tiles are snapshotted: a 20 MP layer would otherwise copy twice
  const entry = layerOpCommandIn(layer, "Spot Healing", () => {
    spotHeal(layer.grid, clipped, mask);
  }, clipped);
  if (entry) {
    pushHist(entry);
    renderHistoryPanel();
  }
  render();
}

/**
 * The rectangle every pixel operation should act on: the marquee rect when one
 * exists, else the selection mask's bounds, else the whole layer. Clipped to the
 * canvas. Duplicated inline six times before this helper existed — and one copy
 * forgot the clip, which is exactly the kind of drift a single source prevents.
 */
function selectionRect(): { x: number; y: number; w: number; h: number } {
  if (selRect) {
    const x = Math.max(0, selRect.x);
    const y = Math.max(0, selRect.y);
    return {
      x, y,
      w: Math.min(doc.width, selRect.x + selRect.w) - x,
      h: Math.min(doc.height, selRect.y + selRect.h) - y,
    };
  }
  if (selMask) return selMask.bbox() ?? { x: 0, y: 0, w: 0, h: 0 };
  return { x: 0, y: 0, w: doc.width, h: doc.height };
}

function endStroke(): void {
  airbrush.stop();
  strokeAlt = false;
  // AI1: a drag that sets a pen handler ends here; the next move must not keep
  // bending the anchor, so the gesture index resets with the gesture.
  penDragIdx = -1;
  if (healMask) {
    // commitHeal consumes healMask/healRect; the stroke states must not
    // outlive it — a stray hover dab with buttons released would otherwise
    // recreate a dangling heal gesture (handoff-3 T6).
    commitHeal();
    painting = false;
    rawCursor = null;
    return;
  }
  if (textResize) { finishTextResize(); return; }
  if (shapeDrag) { commitShape(); return; }
  if (moveDrag) { endMoveDrag(); return; }
  if (cropDrag) {
    cropDrag = false;
    if (quadDragIdx >= 0) { quadDragIdx = -1; return; }
    if (cropRect && (cropRect.w < 2 || cropRect.h < 2)) cropRect = null; // click = clear
    drawOverlay();
    refreshOptions();
    return;
  }
  if (transform) { transform.mode = ""; return; }
  if (marqueeing) {
    marqueeing = false;
    const before = selBefore ?? snapshotSelection();
    selBefore = null;
    if (tool === "marquee" && marqueeShape !== "rect") {
      // A single-row/column marquee ignores the drag extent: Photoshop selects the
      // whole width (or height) at the press position, even for a plain click.
      const py = Math.max(0, Math.min(doc.height - 1, Math.round(marqueeStart[1])));
      const px = Math.max(0, Math.min(doc.width - 1, Math.round(marqueeStart[0])));
      selRect =
        marqueeShape === "row"
          ? { x: 0, y: py, w: doc.width, h: 1 }
          : { x: px, y: 0, w: 1, h: doc.height };
    } else if (selRect && (selRect.w < 2 || selRect.h < 2)) selRect = null; // click = deselect
    const hadRect = !!selRect;
    if (selRect) {
      // materialise the mask now: every consumer (move, bucket, masks, filters)
      // reads selMask, so a rect-only selection would silently be ignored there
      const m = new SelectionMask(doc.width, doc.height);
      m.selectRect(selRect.x, selRect.y, selRect.w, selRect.h);
      const merged = mergeSelection(selDragBase, m, selDragMode, doc.width, doc.height);
      selMask = merged.isEmpty() ? null : merged;
      if (selMask) startAnts(); else stopAnts();
      // A merged selection has no rectangle that describes it: keeping the
      // drag rect made selectionRect() return drag ∩ mask, so Copy and
      // Levels touched only the last rectangle — and after a subtract that
      // emptied the mask, the rect alone described exactly what was removed.
      if (selDragMode !== "replace") selRect = null;
      selDragBase = null;
    } else if (selDragMode !== "replace" && selDragBase) {
      // A Shift/Alt click with no drag must not throw away the selection the
      // modifier was meant to add to or subtract from (code-r34 #2).
      selMask = selDragBase;
      startAnts();
    } else {
      selMask = null;
      stopAnts();
    }
    drawOverlay();
    refreshOptions();
    const selBb = selMask?.bbox();
    if (selBb) statusHint(`Selection ${selBb.w} × ${selBb.h} px${selDragMode === "replace" ? "" : selDragMode === "add" ? " (added)" : " (subtracted)"}`);
    // A click with nothing selected before and nothing after is not a change;
    // pushing it dirtied the document and added a no-op undo step.
    const hadBefore = !!(before.rect || before.mask);
    const changed = hadRect || (selDragMode === "replace" && hadBefore);
    if (changed) pushHist(selectionCommand(hadRect ? "Marquee select" : "Deselect", before));
    return;
  }
  if (ellipseDrag) {
    ellipseDrag = false;
    const beforeEllipse = selBefore ?? snapshotSelection();
    selBefore = null;
    const r = selGeom && selGeom.kind === "ellipse" ? selGeom : null;
    if (!r || r.w < 2 || r.h < 2) {
      // A modifier click keeps the base selection it was modifying (code-r34 #2).
      if (selDragMode !== "replace" && selDragBase) {
        selMask = selDragBase;
        startAnts();
        drawOverlay();
        selDragBase = null;
        return;
      }
      const hadBefore = !!(beforeEllipse.rect || beforeEllipse.mask);
      deselect();
      if (hadBefore) pushHist(selectionCommand("Deselect", beforeEllipse));
      return;
    }
    const m = new SelectionMask(doc.width, doc.height);
    m.selectEllipse(r.x, r.y, r.w, r.h);
    const merged = mergeSelection(selDragBase, m, selDragMode, doc.width, doc.height);
    selMask = merged.isEmpty() ? null : merged;
    if (selMask) startAnts(); else stopAnts();
    if (selDragMode !== "replace") selGeom = null;
    const selBbE = selMask?.bbox();
    if (selBbE) statusHint(`Selection ${selBbE.w} × ${selBbE.h} px${selDragMode === "replace" ? "" : selDragMode === "add" ? " (added)" : " (subtracted)"}`);
    selDragBase = null;
    drawOverlay();
    pushHist(selectionCommand("Elliptical select", beforeEllipse));
    return;
  }
  if (ffDrag) {
    endFreeformPath(true, off.width, off.height);
    return;
  }
  if (lassoing) {
    lassoing = false;
    const beforeLasso = selBefore ?? snapshotSelection();
    selBefore = null;
    if (lassoPts.length < 3) {
      // A modifier click keeps the selection it was modifying, like the marquee
      // and ellipse branches (code-r35 #5). A plain click that really deselects
      // pushes the snapshot, because mousedown already emptied selRect/selMask
      // and deselect() sees "nothing was selected" otherwise.
      if (selDragMode !== "replace" && selDragBase) {
        selMask = selDragBase;
        selDragBase = null;
        startAnts();
        drawOverlay();
        refreshOptions();
        return;
      }
      const hadSelection = !!(beforeLasso.rect || beforeLasso.mask);
      deselect();
      if (hadSelection) pushHist(selectionCommand("Deselect", beforeLasso));
      return;
    }
    let pts = lassoPts;
    if (tool === "magnet") {
      renderFlat();
      const snapped = snapToEdges(flatCache.buffer, flatCache.width, flatCache.height,
        lassoPts.map(([px, py]) => ({ x: px, y: py })), magnetRadius);
      pts = snapped.map((q) => [q.x, q.y] as [number, number]);
      statusHint(`Magnetic lasso snapped ${lassoPts.length} points within ${magnetRadius} px.`);
    }
    const m = new SelectionMask(doc.width, doc.height);
    if (!m.selectPolygon(pts)) {
      // A degenerate lasso used to replace a real selection and push history
      // for nothing; commitPenPath already refuses this case (code-r12 #4).
      statusHint("The lasso enclosed no pixels — the selection was left alone.");
      drawOverlay();
      return;
    }
    const merged = mergeSelection(selDragBase, m, selDragMode, doc.width, doc.height);
    selMask = merged.isEmpty() ? null : merged;
    if (selDragMode !== "replace") selGeom = null;
    else selGeom = { kind: "poly", pts: pts.slice() };
    if (selMask) startAnts(); else stopAnts();
    const selBbL = selMask?.bbox();
    if (selBbL) statusHint(`Selection ${selBbL.w} × ${selBbL.h} px${selDragMode === "replace" ? "" : selDragMode === "add" ? " (added)" : " (subtracted)"}`);
    selDragBase = null;
    drawOverlay();
    pushHist(selectionCommand("Lasso select", beforeLasso));
    return;
  }
  if (gradientDrag) {
    gradientDrag = false;
    drawOverlay();
    if (paintTarget === "mask" && activeLayer.mask) {
      statusHint("The gradient fills pixels. Switch the chip to Pixels first.");
      return;
    }
    const ddx = gradEnd[0] - gradStart[0], ddy = gradEnd[1] - gradStart[1];
    if (ddx * ddx + ddy * ddy < 1) return; // click = no-op
    // fill rect: marquee rect → mask bbox → whole layer
    const rect = selectionRect();
    if (rect.w <= 0 || rect.h <= 0) return;
    const spec = {
      kind: gradKind,
      from: { x: gradStart[0], y: gradStart[1], c: gradFrom },
      to: { x: gradEnd[0], y: gradEnd[1], c: gradTo },
    };
    const entry = layerOpCommand(
      activeLayer,
      `Gradient ${gradKind}${selRect || selMask ? " (selection)" : ""}`,
      () => { fillGradient(activeLayer.grid, rect.x, rect.y, rect.w, rect.h, spec, selMask ?? undefined); },
    );
    if (!entry) return;
    pushHist(entry);
    render();
    renderHistoryPanel();
    return;
  }
  if (!painting) return;
  painting = false;
  bgTarget = null; // the next stroke samples its own colour
  colourTarget = null;
  if (quickMask && quickMaskBefore) {
    // Quick Mask changes the selection, not pixels: its undo entry must be a
    // selection entry, or Ctrl+Z after painting the mask undoes the previous
    // layer edit and leaves the mask paint in place.
    pushHist(selectionCommand("Quick Mask", quickMaskBefore));
    quickMaskBefore = null;
    renderHistoryPanel();
  }
  // smoothed strokes lag behind the cursor — finish the rope on release. This has
  // to happen BEFORE the mask snapshot below, or the final dab is missing from
  // the captured after-image and undoing/redoing a mask stroke loses it.
  if (brushSmooth > 0 && rawCursor) paintDabs(rawCursor[0], rawCursor[1], lastPressure);
  rawCursor = null;
  if (maskStrokeBefore && activeLayer.mask) {
    // A hide-polarity mask's absent tile is hidden, so undo must fill an
    // allocated-then-reverted tile with 255, not 0 (which would reveal it).
    pushHist(snapshotCommand(activeLayer.mask, "Paint Mask", maskStrokeBefore, undefined, activeLayer.maskHide ? 255 : 0));
    maskStrokeBefore = null;
    renderHistoryPanel();
    declaredChange();
    render();
  }
  if (strokeSession) {
    const STROKE_LABEL: Partial<Record<ToolId, string>> = {
      count: "Count",
      retouch: retouchMode === "dodge" ? "Dodge" : retouchMode === "burn" ? "Burn"
        : retouchMode === "sponge" ? (spongeMode === "saturate" ? "Saturate" : "Desaturate") : "Red Eye",
      focus: focusMode === "blur" ? "Blur" : focusMode === "sharpen" ? "Sharpen" : "Smudge",
      clone: "Clone Stamp",
      pencil: "Pencil",
      bgerase: "Background Erase",
      colourreplace: "Colour Replacement",
    };
    const entry = strokeSession.finish(activeLayer.grid,
      tool === "eraser" ? "Erase" : STROKE_LABEL[tool] ?? "Paint");
    strokeSession = null;
    if (entry) {
      pushHist(entry);
      renderHistoryPanel();
      // The flat cache was patched dab by dab, so its generation never moved
      // and the Histogram panel kept showing the picture as it was before the
      // stroke. Going through declaredChange keeps the cache's single door and
      // marks the document unsaved, which a stroke also does.
      declaredChange();
      render();
    }
  }
}


/** Dispatch one dab to the right engine op for the active tool. */
function paintOneDab(x: number, y: number, radius: number,
  tilt?: { angle: number; ratio: number },
  flowScale = 1,
  alphaScale = 1,
  dabColor?: readonly [number, number, number],
  ellipse?: { angle: number; ratio: number },
  hard = false): { x: number; y: number; w: number; h: number } | null {
  // Quick Mask: the brush edits the selection itself, not any layer
  if (quickMask) {
    // The selection is the document change here, so the stroke needs a
    // selection entry, not a pixel one (a pixel snapshot would undo the last
    // layer edit and leave the mask paint in place).
    if (!quickMaskBefore) quickMaskBefore = snapshotSelection();
    if (!selMask) selMask = new SelectionMask(doc.width, doc.height);
    const lum = 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2];
    // painting dark protects (deselects), white adds to the selection
    const target = lum > 127 ? 255 : 0; // white brush selects, dark protects
    for (let yy = -radius; yy <= radius; yy++) {
      for (let xx = -radius; xx <= radius; xx++) {
        const gx = Math.round(x + xx), gy = Math.round(y + yy);
        if (gx < 0 || gy < 0 || gx >= doc.width || gy >= doc.height) continue;
        if (xx * xx + yy * yy > radius * radius) continue;
        selMask.setAlpha(gx, gy, target);
      }
    }
    quickMaskDirty = true;
    return { x: Math.round(x - radius), y: Math.round(y - radius), w: Math.round(radius * 2), h: Math.round(radius * 2) };
  }
  // painting into a layer mask instead of its pixels
  if (paintTarget === "mask" && activeLayer.mask) {
    const mlum = 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2];
    // Dark hides, light reveals — and Alt reverses that, which is what the
    // hint has promised since the mask landed (uiux-r17 #5). strokeAlt is read
    // once at pointerdown so releasing Alt mid-stroke cannot flip a dab.
    const hide = (mlum < 128) !== strokeAlt;
    return paintMaskDab(activeLayer.mask, {
      x, y, radius, hardness: brushHardness, alpha: brushOpacity,
      value: hide ? 0 : 255,
      // Third argument is what an *unallocated* tile means for this mask. A
      // hide-polarity mask is empty where it is hidden, so seeding a new tile
      // with "revealed" made every touched 256-px tile pop visible (code-r18).
    }, activeLayer.maskHide ? 0 : 255);
  }
  // Background Eraser: the colour is sampled once, at the first dab of the
  // stroke, so dragging across two different colours does not chase them.
  if (tool === "bgerase") {
    if (!bgTarget) bgTarget = sampleGridColor(activeLayer.grid, x, y) ?? [0, 0, 0];
    return backgroundEraseDab(activeLayer.grid, x, y, {
      radius,
      hardness: brushHardness,
      target: bgTarget,
      tolerance: bgTolerance,
      // The eraser is a paint tool: a selection has to clip it like it clips
      // the brush, or "erase inside this shape" erases the whole dab.
      clip: selRect ?? undefined,
      mask: selMask ?? undefined,
      session: strokeSession ?? undefined,
    });
  }
  // Colour Replacement: one target colour per stroke, replaced by the
  // foreground at the pixel's own brightness. Sampling per dab would chase a
  // gradient and repaint the whole stroke.
  if (tool === "colourreplace") {
    if (!colourTarget) colourTarget = sampleGridColor(activeLayer.grid, x, y) ?? [0, 0, 0];
    return replaceColourDab(activeLayer.grid, x, y, {
      radius,
      hardness: brushHardness,
      target: colourTarget,
      tolerance: colourTolerance,
      colour: [color[0], color[1], color[2]],
      clip: selRect ?? undefined,
      mask: selMask ?? undefined,
      session: strokeSession ?? undefined,
    });
  }
  // Spot Healing: collect the dab into a hole mask, rebuild the pixels on release
  if (tool === "heal") {
    if (!healMask) healMask = new SelectionMask(doc.width, doc.height);
    const r = Math.max(1, radius);
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(doc.width - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(doc.height - 1, Math.ceil(y + r));
    const soft = Math.max(0, Math.min(1, brushHardness));
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const d = Math.hypot(gx + 0.5 - x, gy + 0.5 - y) / r;
        if (d > 1) continue;
        // hardness 100 = crisp edge; lower values feather the hole so the
        // patch synthesis has a clean border to blend against
        // Honour the active selection like every other brush: healing across
        // a marquee used to change pixels the user had excluded (code-r12 #3).
        if (selRect && (gx < selRect.x || gy < selRect.y || gx >= selRect.x + selRect.w || gy >= selRect.y + selRect.h)) continue;
        const cov = selMask ? selMask.alphaAt(gx, gy) / 255 : 1;
        if (cov <= 0) continue;
        const a = Math.round((soft >= 1 ? 255 : 255 * (d <= soft ? 1 : 1 - (d - soft) / Math.max(0.001, 1 - soft))) * cov);
        if (a > 0) healMask.setAlpha(gx, gy, a);
      }
    }
    healRect = healRect
      ? {
          x: Math.min(healRect.x, x0), y: Math.min(healRect.y, y0),
          w: Math.max(healRect.x + healRect.w, x1 + 1) - Math.min(healRect.x, x0),
          h: Math.max(healRect.y + healRect.h, y1 + 1) - Math.min(healRect.y, y0),
        }
      : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  const grid = activeLayer.grid;
  const base = {
    x, y, radius, hardness: brushHardness,
    mask: selMask ?? null,
    clip: selRect ?? null,
    session: strokeSession ?? undefined,
  };
  switch (tool) {
    case "retouch": {
      if (retouchMode === "sponge") {
        return spongeDab(grid, { ...base, amount: retouchStrength, mode: spongeMode, vibrance: retouchVibrance });
      }
      if (retouchMode === "redEye") return redEyeDab(grid, { ...base, darken: retouchStrength });
      return dodgeBurnDab(grid, { ...base, amount: retouchStrength, mode: retouchMode, range: retouchRange });
    }
    case "focus": {
      if (focusMode === "smudge") {
        const from = smudgePrev ?? [x - 1, y];
        smudgePrev = [x, y];
        const dx = x - from[0]!, dy = y - from[1]!;
        if (Math.hypot(dx, dy) > radius * 0.6) return null; // pointer jumped: no smear
        return smudgeDab(grid, { ...base, fromX: from[0]!, fromY: from[1]!, strength: focusStrength });
      }
      return focusDab(grid, { ...base, strength: focusStrength, mode: focusMode });
    }
    case "clone": {
      if (!cloneOffset) return null;
      return cloneDab(grid, { ...base, offsetX: cloneOffset[0], offsetY: cloneOffset[1], alpha: cloneAlpha });
    }
    default: {
      const tex = brushSettings.texture;
      // Mixer: the stroke colour is the bar colour mixed into what the layer
      // already holds under the dab. Sampling the *unpainted* pixel each dab is
      // what makes it a mixer rather than a translucent brush.
      let strokeColour: readonly [number, number, number] = dabColor ?? color;
      if (tool === "mixer" && !dabColor) {
        const under = sampleGridColor(activeLayer.grid, Math.round(x), Math.round(y));
        if (under) strokeColour = mixColour(under, color, mixerWet / 100);
      }
      return stampDab(grid, {
        x, y, radius,
        hardness: brushHardness,
        alpha: brushOpacity * brushFlow * flowScale * alphaScale,
        color: strokeColour,
        mode: tool === "eraser" ? "clear" : "normal",
        // Pencil: binary rim and no texture — a grain on an aliased stroke
        // reads as noise, not as paper.
        hard,
        clip: selRect ?? undefined,
        mask: selMask ?? undefined,
        stretch: tilt && !activeTip ? tilt : undefined,
        // the fixed tip shape (angle/roundness) is a recipe change, so it is
        // applied for a procedural tip only — an image tip already has a shape
        ellipse: activeTip ? undefined : ellipse ?? {
          angle: (brushSettings.tip.angle * Math.PI) / 180,
          ratio: brushSettings.tip.roundness / 100,
        },
        tip: activeTip ?? undefined,
        dual: dualTip ?? undefined,
        dualScale: brushSettings.dual.scale / 100,
        texture: tex.on
          ? { data: grainTexture(tex.grain), scale: tex.scale, depth: tex.depth, invert: tex.invert }
          : undefined,
        noise: hard ? undefined : brushSettings.noise > 0 ? brushSettings.noise / 100 : undefined,
        wetEdges: hard ? undefined : brushSettings.wetEdges ? 1 : undefined,
        // Pattern Stamp: the foreground/background pair is the pattern, so the
        // stroke uses the same two colours as the fill layer's dialog.
        pattern: tool === "patternstamp"
          ? { kind: patternKind, size: patternTile, colorA: [color[0], color[1], color[2]], colorB: [bgColor[0], bgColor[1], bgColor[2]] }
          : undefined,
        patternScale: patternScaleVal,
      }, strokeSession ?? undefined);
    }
  }
}

function paintDabs(x: number, y: number, pressure: number, tilt?: { angle: number; ratio: number }): void {
  // Quick Selection is a selection stroke, not a pixel stroke: one flood at
  // the cursor, not one per interpolated dab along the segment.
  if (tool === "quick") {
    lastX = x; lastY = y;
    quickDab(x, y, quickMode);
    return;
  }
  const p = pressure > 0 && pressure !== 0.5 ? pressure : 1;
  lastPressure = p;
  const radius = Math.max(1, (brushSize / 2) * (0.35 + 0.65 * pressureSize(p)));
  // Spacing is a percentage of the radius, as the dialog labels it. The old
  // hard-coded 25 % is the default, so an untouched brush dabs as before.
  // Pencil dabs closer together: an aliased disc at the brush spacing leaves
  // visible scallops, while a soft edge hides them.
  const spacing = tool === "pencil"
    ? Math.max(0.5, radius * 0.12)
    : Math.max(0.5, radius * (brushSettings.tip.spacing / 100));
  const dabs = dabPositions(lastX, lastY, x, y, spacing);
  // the cursor must advance per call: coalesced sub-events each continue from
  // where the previous one ended, or a fast burst re-stamps the same segment
  // over and over (quadratic work — the size-300 eraser hang)
  lastX = x; lastY = y;
  if (dabs.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  // Dynamics are a recipe applied per cursor position: one position can stamp
  // several dabs (Count), each with its own scatter, size, angle and colour.
  // Other tools stay one-dab-per-position; jitter on a heal stamp would make
  // the repair impossible to reason about.
  const useDynamics = tool === "brush" || tool === "eraser";
  for (let i = 0; i < dabs.length; i++) {
    const [dxp, dyp] = dabs[i]!;
    const variants = useDynamics
      ? dabVariation(brushSettings, {
          x: dxp, y: dyp, radius,
          alpha: 1,
          color,
          pressure: p,
          tilt: tilt ? 1 - tilt.ratio : 0,
        }, strokeRnd)
      : [{ x: dxp, y: dyp, radius, ratio: 1, angle: 0, alpha: 1, color }];
    for (const v of variants) {
      const rect = useDynamics
        ? paintOneDab(v.x, v.y, v.radius, tilt, 1, pressureAlpha(p) * v.alpha, v.color,
            { angle: v.angle, ratio: v.ratio })
        : paintOneDab(dxp, dyp, radius, tilt, 1, pressureAlpha(p), undefined, undefined, tool === "pencil");
      if (rect) {
        minX = Math.min(minX, rect.x); minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.w); maxY = Math.max(maxY, rect.y + rect.h);
      }
    }
  }
  if (maxX > minX && maxY > minY) {
    scheduleComposite(minX, minY, maxX - minX, maxY - minY);
  }
}

// ---- frame-coalesced stroke rendering -------------------------------------
// pointermove (with coalesced events) can fire far above display refresh;
// batching dirty rects to one composite+render per rAF keeps strokes smooth.
let pendingDirty: { x: number; y: number; w: number; h: number; completed: boolean } | null = null;
let rafScheduled = false;
function scheduleComposite(x: number, y: number, w: number, h: number, completed = false): void {
  if (pendingDirty) {
    const x1 = Math.min(pendingDirty.x, x), y1 = Math.min(pendingDirty.y, y);
    const x2 = Math.max(pendingDirty.x + pendingDirty.w, x + w);
    const y2 = Math.max(pendingDirty.y + pendingDirty.h, y + h);
    pendingDirty = { x: x1, y: y1, w: x2 - x1, h: y2 - y1, completed: pendingDirty.completed || completed };
  } else {
    pendingDirty = { x, y, w, h, completed };
  }
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    const d = pendingDirty;
    pendingDirty = null;
    if (d) compositeRegion(d.x, d.y, d.w, d.h, d.completed);
  });
}

// wheel zoom around cursor
display.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = display.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const [dx, dy] = [(sx - panX) / scale, (sy - panY) / scale];
  scale = Math.min(32, Math.max(0.05, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  panX = sx - dx * scale;
  panY = sy - dy * scale;
  render();
}, { passive: false });

// ---- minimal panels ------------------------------------------------------
const toolbar = document.getElementById("toolbar")!;
/** scrolling home for the tool buttons. The compact toggle stays pinned below
 *  it; the colour well rides INSIDE the list, right under Free Transform,
 *  centred (v0.25.2) */
const toolArea = document.createElement("div");
toolArea.className = "tool-area";
toolbar.appendChild(toolArea);

// ---- toolbar sizing (drag the right edge, or flip to two compact columns) --
/** Stamped by scripts/bump.mjs in lockstep with package.json / Cargo.toml / tauri.conf.json. */
const APP_VERSION = "1.18.12";
// W1 (handoff-4): the legal entity that owns this build, in ONE place. The
// About dialog and LICENSE must agree; scripts/build-desktop.mjs refuses a
// release while the placeholder is still here (see the owner checklist).
const OWNER_NAME = "vera2077";

const LS_TOOLBAR = "guazzo.toolbar.v1";
/** width at which the toolbar flips between one and two columns */
const AUTO_WRAP_W = 92;
/** the proper single-column width — folding back always returns here (v0.25.5) */
const TOOLBAR_W1 = 50;
let toolbarCols: 1 | 2 = 1;
let toolbarW = TOOLBAR_W1;
// user-set compaction state: when true, auto-fit stands down until the
// window's fit CATEGORY genuinely changes (restored from storage at boot —
// must be declared before loadToolbar runs, hence its position here)
let toolbarManual = false;
const appEl = document.getElementById("app");
function applyToolbar(): void {
  const width = toolbarCols === 2 ? Math.max(AUTO_WRAP_W, toolbarW) : toolbarW;
  // a missing #app must not break the rest of the layout pass
  appEl?.style?.setProperty("--toolbar-w", `${width}px`);
  toolbar.classList.toggle("wrap", toolbarCols === 2);
  // the little top button shows where a click would take you: > = widen to
  // two columns, < = fold back to one (v0.25.3)
  toolbarSizeBtn.innerHTML = iconSvg(toolbarCols === 1 ? "chevron-right" : "chevron-left", 14);
  toolbarSizeBtn.title = toolbarCols === 1 ? "Expand to two columns (resizes automatically)" : "Fold back to one column (resizes automatically)";
  toolbarSizeBtn.setAttribute("aria-label", toolbarSizeBtn.title);
  try {
    // persist the manual flag too: without it the first ResizeObserver fire
    // after reload would auto-compact away the user's stored choice (R3)
    localStorage.setItem(LS_TOOLBAR, JSON.stringify({ cols: toolbarCols, w: toolbarW, manual: toolbarManual }));
  } catch {
    /* storage can be denied in private windows; the layout still works */
  }
  relayout();
}
(function loadToolbar(): void {
  try {
    const raw = localStorage.getItem(LS_TOOLBAR);
    if (!raw) return;
    const v = JSON.parse(raw) as { cols?: number; w?: number; manual?: boolean };
    if (v.cols === 2 || v.cols === 1) toolbarCols = v.cols;
    if (typeof v.w === "number" && Number.isFinite(v.w)) toolbarW = Math.max(44, Math.min(180, v.w));
    if (v.manual === true) toolbarManual = true;
  } catch {
    /* a corrupt preference must never block start-up */
  }
})();
const toolbarGrip = document.createElement("div");
toolbarGrip.id = "toolbar-grip";
toolbarGrip.title = "Drag to resize the toolbar";
const toolbarSizeBtn = document.createElement("button");
toolbarSizeBtn.className = "tool toolbar-size";
toolbarSizeBtn.innerHTML = iconSvg("chevron-right", 14);
// pinned at the top, above the tool scroller (v0.25.3)
toolbar.insertBefore(toolbarSizeBtn, toolArea);
toolbarSizeBtn.addEventListener("click", () => {
  toolbarManual = true;
  toolbarCols = toolbarCols === 2 ? 1 : 2;
  // snap to the PROPER width for the mode: folding back returns to the real
  // one-column size instead of shaving a few pixels off the wide column
  // (the grip stays free-drag for custom widths) (v0.25.5)
  toolbarW = toolbarCols === 2 ? Math.max(AUTO_WRAP_W + 4, TOOLBAR_W1) : TOOLBAR_W1;
  applyToolbar();
});
toolbarGrip.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  toolbarGrip.classList.add("drag");
  toolbarGrip.setPointerCapture(ev.pointerId);
  const startX = ev.clientX;
  const startW = toolbarW;
  const move = (e: PointerEvent): void => {
    const prevW = toolbarW;
    toolbarW = Math.max(44, Math.min(180, Math.round(startW + (e.clientX - startX))));
    // edge-triggered, not level: widening past the boundary compacts to two
    // columns, shrinking back below it returns to one. A wide single column
    // dragged within 92..180 keeps its mode.
    if (prevW < AUTO_WRAP_W && toolbarW >= AUTO_WRAP_W) { toolbarCols = 2; toolbarManual = true; }
    else if (prevW >= AUTO_WRAP_W && toolbarW < AUTO_WRAP_W) { toolbarCols = 1; toolbarManual = true; }
    applyToolbar();
  };
  const up = (): void => {
    toolbarGrip.classList.remove("drag");
    toolbarGrip.removeEventListener("pointermove", move);
    toolbarGrip.removeEventListener("pointerup", up);
    toolbarGrip.removeEventListener("pointercancel", up);
  };
  toolbarGrip.addEventListener("pointermove", move);
  toolbarGrip.addEventListener("pointerup", up);
  toolbarGrip.addEventListener("pointercancel", up);
});
// window resize drives the mode BOTH ways: compact when the tools stop
// fitting, back to one column when they clearly do (a row of slack keeps the
// boundary stable). A manual toggle/grip choice wins until the fit category
// actually changes, so deliberate compaction survives window jitter (v0.25.1).
let toolbarFit: "one" | "two" | null = null;
// one-column content height, measured once at start-up and refreshed whenever
// the mode passes through one column — never inside an observer delivery,
// because flipping classes mid-delivery is what triggers the browser's
// "ResizeObserver loop completed with undelivered notifications" artifact.
let toolbarH1 = -1;
(function measureOneColumn(): void {
  const wrap = toolbar.classList.contains("wrap");
  if (wrap) toolbar.classList.remove("wrap");
  toolbarH1 = toolArea.scrollHeight;
  if (wrap) toolbar.classList.add("wrap");
})();
let toolbarApplyQueued = false;
new ResizeObserver(() => {
  // display:none measures 0 and would be classified "two", reserving 96 px for
  // a rail that is not on screen (uiux-r6).
  if (toolbar.classList.contains("toolbar-hidden")) return;
  if (toolbarCols === 1) toolbarH1 = toolArea.scrollHeight;
  const fitsOne = toolbarH1 >= 0 && toolbarH1 <= toolArea.clientHeight - 32;
  const fit: "one" | "two" = fitsOne ? "one" : "two";
  // the very first delivery only ESTABLISHES the baseline category — treating
  // it as a change would clear a manual preference restored from storage at
  // boot (R3). Every later one↔two flip is genuine and releases manual mode.
  if (fit !== toolbarFit) {
    const genuine = toolbarFit !== null; // null → first assignment = baseline
    toolbarFit = fit;
    if (genuine) toolbarManual = false;
  }
  if (toolbarManual) return;
  const want: 1 | 2 = fit === "two" ? 2 : 1;
  if (want === toolbarCols || toolbarApplyQueued) return;
  // defer the flip: applyToolbar changes the observed toolbar's own width,
  // and resizing the observed element synchronously inside its observer
  // callback is the other half of the loop artifact (v0.25.4)
  toolbarApplyQueued = true;
  requestAnimationFrame(() => {
    toolbarApplyQueued = false;
    if (toolbarManual || want === toolbarCols) return;
    toolbarCols = want;
    toolbarW = want === 2 ? Math.max(AUTO_WRAP_W + 4, toolbarW) : TOOLBAR_W1;
    applyToolbar();
    if (want === 1) toolbarH1 = toolArea.scrollHeight;
  });
}).observe(toolbar);
const topbar = document.getElementById("topbar")!;
const panels = document.getElementById("panels")!;
/** card header: small icon + uppercase title */
function cardHead(box: HTMLElement, icon: IconName, title: string): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "card-head";
  head.innerHTML = iconSvg(icon, 14) + `<span>${title}</span>`;
  box.appendChild(head);
  return head;
}

// Layers card: header, active-layer properties, scrolling rows, action strip
const layersBox = document.createElement("div");
layersBox.className = "card grow";
const optionsBar = document.getElementById("options")!;
// r30 parks focus here when a remembered control vanished; an unnamed
// role-less div announces nothing, so the landing spot could be anywhere.
optionsBar.setAttribute("role", "toolbar");
optionsBar.setAttribute("aria-label", "Tool options");
// options-bar paging state: declared HERE because init-time highlight() calls
// refreshOptions() long before the function's own source position.
let optionsPage: 0 | 1 = 0;
cardHead(layersBox, "layers", "Layers");
const layersBody = document.createElement("div");
layersBody.className = "card-body";
layersBox.appendChild(layersBody);
const layersStrip = document.createElement("div");
layersStrip.className = "card-foot";
layersBox.appendChild(layersStrip);

// History card. Sizing, collapsing and the resizable bottom edge are handled for
// every panel at once by src/ui/dock.ts, so no per-card grips here.
const historyBox = document.createElement("div");
historyBox.className = "card";
cardHead(historyBox, "history", "History");
const historyBody = document.createElement("div");
historyBody.className = "card-body tight";
historyBox.appendChild(historyBody);

const adjustBox = document.createElement("div");
adjustBox.className = "card";
// Histogram card: the composite's distribution, refreshed when the flat
// cache's generation moves — never on a bare pointermove (it walks 4 bytes per
// pixel, and a 16 MP document is 64 MB to read).
const histBox = document.createElement("div");
histBox.className = "card";
cardHead(histBox, "histogram", "Histogram");
const histBody = document.createElement("div");
histBody.className = "card-body tight";
histBox.appendChild(histBody);
panels.appendChild(layersBox);
panels.appendChild(historyBox);
panels.appendChild(histBox);

// Info card: a read-out of the pointer, the colour under it and the selection.
const infoBox = document.createElement("div");
infoBox.className = "card";
cardHead(infoBox, "info", "Info");
const infoBody = document.createElement("div");
infoBody.className = "card-body tight";
infoBox.appendChild(infoBody);
const infoPanel = buildInfoPanel(infoBody);
panels.appendChild(infoBox);
panels.appendChild(adjustBox);
const refreshHistogram = buildHistogramPanel({
  host: histBody,
  visible: () => !panels.classList.contains("panel-hidden") && !histBox.classList.contains("collapsed"),
  composite: () => ({ width: flatCache.width, height: flatCache.height, generation: flatCache.generation, stamp: flatStamp, data: flatCache.buffer }),
  histogramOf,
});

topbar.innerHTML = `<span id="brand"><span class="mark">${appMarkSvg(19)}</span>Guazzo</span>`;

// ---- status bar (Photoshop-style read-out strip along the bottom) ----------
const statusBar = document.getElementById("statusbar")!;
let hintTimer: number | null = null;
let lastImportReport: { fileName: string; report: ImportReport } | null = null;
/** Show a one-off message where Photoshop shows status text. */
// ---- status bar -----------------------------------------------------------
// Children are built once and updateStatus only rewrites text: hover-driven
// renders must not rebuild the DOM, and must never wipe the transient hint
// span (handoff-3 T6; the old innerHTML rebuild destroyed statusHint on the
// first pointermove after it appeared).
interface StatusBarEls {
  zoom: HTMLElement; size: HTMLElement;
  cursor: HTMLElement; cursorX: HTMLElement; cursorY: HTMLElement;
  sel: HTMLElement; selB: HTMLElement;
  layerNo: HTMLElement; layerOf: Text;
  histPos: HTMLElement; histTotal: Text;
  dirty: HTMLElement; details: HTMLButtonElement; hint: HTMLElement; error: HTMLButtonElement;
}
let sb: StatusBarEls | null = null;

function buildStatusBars(): void {
  const bar = statusBar;
  bar.replaceChildren();
  const mk = (cls?: string): HTMLElement => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    return s;
  };
  const bold = (host: HTMLElement): HTMLElement => {
    const b = document.createElement("b");
    host.appendChild(b);
    return b;
  };
  const zoom = mk(); zoom.append("Zoom "); const zoomB = bold(zoom);
  const size = mk();
  const cursor = mk(); cursor.style.display = "none";
  const cursorX = bold(cursor); cursor.append(" "); const cursorY = bold(cursor);
  const sel = mk(); sel.append("Selection "); const selB = bold(sel);
  sel.style.display = "none";
  const layer = mk(); layer.append("Layer "); const layerNo = bold(layer);
  const layerOf = document.createTextNode(""); layer.append(layerOf);
  const hist = mk(); hist.append("History "); const histPos = bold(hist);
  const histTotal = document.createTextNode(""); hist.append(histTotal);
  const dirty = mk("status-dirty"); dirty.textContent = "• Unsaved";
  dirty.style.display = "none";
  const details = document.createElement("button");
  details.type = "button";
  details.className = "status-details";
  details.textContent = "Details";
  details.title = "Show the last PSD import report";
  details.style.display = "none";
  details.addEventListener("click", () => openLastImportReport());
  const spacer = mk("grow-spacer");
  const offline = mk(); offline.textContent = "100% offline — no network access";
  // ui11: the two failures that threaten work (autosave, PSD import) appeared
  // in the same accent-coloured line as "Copied" and vanished after 2.6 s. A
  // failure needs its own persistent channel, and clicking it dismisses —
  // unless the click was a text selection, because this is the only message
  // the user can copy (uiux-r46).
  const error = document.createElement("button");
  error.type = "button";
  error.className = "status-error";
  error.setAttribute("role", "alert");
  error.title = "Dismiss";
  error.addEventListener("click", () => {
    if (window.getSelection()?.toString()) return;
    error.style.display = "none";
  });
  const hint = mk("status-hint");
  hint.style.display = "none";
  // A refusal that only changes pixels is invisible to a screen reader; this is
  // the app's only channel for "why nothing happened".
  hint.setAttribute("role", "status");
  hint.setAttribute("aria-live", "polite");
  bar.append(zoom, size, cursor, sel, layer, hist, dirty, details, spacer, offline, error, hint);
  sb = {
    zoom: zoomB, size, cursor, cursorX, cursorY, sel, selB,
    layerNo, layerOf, histPos, histTotal, dirty, details, hint, error,
  };
}

function updateStatus(): void {
  if (!sb) buildStatusBars();
  const s = sb;
  if (!s) return;
  const zoom = Number.isFinite(scale) ? Math.round(scale * 100) : 100;
  s.zoom.textContent = `${zoom}%`;
  s.size.textContent = `${doc.width} × ${doc.height} px`;
  if (hoverPos) {
    const cx = Math.floor((hoverPos[0] - panX) / scale);
    const cy = Math.floor((hoverPos[1] - panY) / scale);
    if (cx >= 0 && cy >= 0 && cx < doc.width && cy < doc.height) {
      s.cursorX.textContent = String(cx);
      s.cursorY.textContent = String(cy);
      s.cursor.style.display = "";
    } else s.cursor.style.display = "none";
  } else s.cursor.style.display = "none";
  const sbx = selRect ? selRect : selMask ? selMask.bbox() : null;
  if (sbx) {
    s.selB.textContent = `${Math.round(sbx.w)} × ${Math.round(sbx.h)}`;
    s.sel.style.display = "";
  } else s.sel.style.display = "none";
  // Depth-first numbering so a group child reports a real position instead of
  // "Layer 0 of N" (indexOf returns -1 for anything below the top level).
  const flat = doc.allLayers();
  const idx = flat.indexOf(activeLayer);
  // One denominator for the status bar and the panel: doc.layerCount() counts
  // total nodes (groups + leaves), which is exactly the number of rows the panel
  // draws. Two counts that disagreed would be wrong for every grouped document.
  s.layerNo.textContent = String(idx < 0 ? 0 : flat.length - idx);
  s.layerOf.textContent = ` of ${doc.layerCount()}`;
  s.histPos.textContent = String(session.position);
  s.histTotal.textContent = `/${session.labels.length}`;
  s.dirty.style.display = docDirty ? "" : "none";
}

function warnLocked(): void {
  pulse(layersBody);
  statusHint("This layer is locked — click the lock in the Layers panel to edit it.");
}

function statusHint(message: string): void {
  if (!sb) buildStatusBars();
  const hint = sb?.hint;
  if (!hint) return;
  // textContent, never innerHTML: callers pass user-typed strings (layer
  // names, which PSD import makes attacker-controlled) — a tainted name like
  // "<img src=x onerror=…>" must render literally, not execute.
  hint.textContent = message;
  hint.style.display = "";
  if (hintTimer !== null) window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    hintTimer = null;
    hint.style.display = "none";
  }, 2600);
}

/**
 * A failure that must not fade: it stays until the user dismisses it or a later
 * success clears it. `role="alert"` so a screen reader hears it once.
 */
let statusErrorOwner = "";
function statusError(message: string, owner = ""): void {
  if (!sb) buildStatusBars();
  const el = sb?.error;
  if (!el) return;
  statusErrorOwner = owner;
  el.textContent = message;
  el.title = `${message} — click to dismiss`;
  el.style.display = "";
  // the transient hint would otherwise sit beside it saying something cheerful
  if (sb?.hint) sb.hint.style.display = "none";
  if (hintTimer !== null) { window.clearTimeout(hintTimer); hintTimer = null; }
}

/** Clear a persistent error, but only the one this owner put there. */
function clearStatusError(owner: string): void {
  if (statusErrorOwner !== owner) return;
  const el = sb?.error;
  if (!el) return;
  el.textContent = "";
  el.style.display = "none";
  statusErrorOwner = "";
}

/** A report that must survive the action it describes; cleared by the next hint. */
function statusHold(message: string): void {
  if (!sb) buildStatusBars();
  const hint = sb?.hint;
  if (!hint) return;
  hint.textContent = message;
  hint.style.display = "";
  if (hintTimer !== null) {
    window.clearTimeout(hintTimer);
    hintTimer = null;
  }
}

/**
 * A group is a container, not a pixel surface: its grid exists so every Layer
 * has one, but nothing may be painted into it. Every pixel entry point asks
 * this first, because before the check the brush/fill/heal tools wrote into an
 * empty grid that the compositor never visits — a silent no-op with a history
 * entry attached.
 */
/**
 * The two "surface that is not yours" refusals:
 *
 * - `locked` is the user's explicit "do not touch this"; the brush, gradient
 *   and patch paths each wrote into a locked layer while five other tools
 *   respected it, so the guard lives in one place now (uiux-r14 #1).
 * - `adjust`/`fill` layers are *computed*: the compositor draws them from the
 *   backdrop or from `fill`, never from `grid`. A stroke wrote a grid nothing
 *   reads and pushed a History entry that changed no pixel (uiux-r14 #2).
 *
 * `maskTarget` is true when the stroke paints a layer mask, which is a real
 * surface on any kind, so only the lock applies there.
 */
function refusePaintSurface(layer: Layer, maskTarget = false): boolean {
  if (layer.locked) { warnLocked(); return true; }
  if (!maskTarget && (layer.kind === "adjust" || layer.kind === "fill")) {
    statusHint(layer.kind === "adjust"
      ? "This is a live adjustment. Paint its mask, or flatten it to edit pixels."
      : "This is a fill layer. Paint its mask, or rasterize it to edit pixels.");
    return true;
  }
  return false;
}

function refuseGroupPixels(layer: Layer, allowSmart = false): boolean {
  // Groups hold no pixels; a smart object paints from its source.
  if (layer.kind !== "group") {
    if (!allowSmart && layer.smart) { pulse(layersBody); statusHint("Rasterize the smart object before painting on it"); return true; }
    return false;
  }
  pulse(layersBody);
  statusHint("Groups hold layers, not pixels");
  return true;
}

// ---- file menu -----------------------------------------------------------
const TOP_ICONS: Record<string, IconName> = {
  "New": "file-plus",
  "Open Image…": "image",
  "Open Project…": "folder-open",
  "Save Project": "save",
  "Export As…": "download",
  "Image Size…": "resize",
  "Canvas Size…": "frame",
};

/** Commands that used to be top-bar buttons; they now live in the menu bar. */
type TopAction = { menu: "file" | "image"; label: string; run: () => void; icon: IconName };
const topActions: TopAction[] = [];

function topButton(menu: "file" | "image", label: string, cb: () => void, icon?: IconName): void {
  topActions.push({ menu, label, run: cb, icon: icon ?? TOP_ICONS[label] ?? "check" });
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tif",
  "image/vnd.adobe.photoshop": "psd",
  "application/json": "json",
};

/** Turn an <input accept> list into the extension list a native picker wants. */
function extListFromAccept(accept: string): string[] {
  const out = new Set<string>();
  for (const raw of accept.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token.startsWith(".")) out.add(token.slice(1));
    else if (MIME_EXT[token]) out.add(MIME_EXT[token]!);
  }
  return [...out];
}

export async function askFile(accept: string): Promise<File | null> {
  if (isTauri()) {
    try {
      const picked = await openNative(extListFromAccept(accept));
      if (!picked) return null;
      return new File([picked.bytes as unknown as BlobPart], picked.name);
    } catch (err) {
      notify("Could not open the file", err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Deliver a file to the user. In the desktop shell this is the platform save
 * dialog (a real path on disk, remembered by the OS); in the browser it stays a
 * download. The two paths are exclusive on purpose: if the user cancels a native
 * save dialog, a download must NOT appear afterwards.
 */
/**
 * AG1: `inPlace` is the document's own save handle — Rust writes exactly that
 * file, or returns false and we fall back to the dialog. `remember` asks Rust to
 * mint a handle for the file the user just picked; exports never pass it, so an
 * export can never become a save target or disturb another document's target.
 */
interface SaveOutcome {
  ok: boolean;
  /** true when the user dismissed the native picker and NOTHING was written */
  cancelled?: boolean;
  /** handle Rust minted for the file just written, when one was requested */
  handle?: number;
  /** display name of the file Rust wrote (never a path — AK3) */
  savedName?: string;
}

async function saveBlob(
  filename: string,
  blob: Blob,
  ext: string,
  opts: { inPlace?: number; remember?: boolean } = {},
): Promise<SaveOutcome> {
  if (!isTauri()) {
    download(filename, blob);
    return { ok: true };
  }
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (opts.inPlace !== undefined && (await saveNativeAgain(opts.inPlace, bytes))) {
      statusHint(`Saved ${filename}`);
      return { ok: true, handle: opts.inPlace };
    }
    const saved = await saveNative(filename, ext, bytes, opts.remember === true);
    if (saved === null) {
      // AU1: the picker was dismissed. Saying "Saved <file>" here was a lie the
      // user could only discover by looking for a file that was never written.
      statusHint(opts.remember === true ? "Save cancelled" : "Export cancelled");
      return { ok: false, cancelled: true };
    }
    statusHint(`Saved ${saved.name}`);
    // handle 0 = bytes written, no claimable target (an export).
    return { ok: true, handle: saved.handle > 0 ? saved.handle : undefined, savedName: saved.name };
  } catch (err) {
    notify("Could not save the file", err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}

/** Overlay state that belongs to one document, not to the window. */
function resetDocumentScopedState(): void {
  // The floating Adjustments palette edits the active layer; carrying its
  // controls into another tab let the sliders move pixels in a document they
  // were never opened for (uiux-r18 #4).
  if (adjustPal && adjustPal.style.display !== "none") closeAdjustPalette(false);
  samples = [];
  counts = [];
  rulerA = null;
  rulerB = null;
  rulerDrag = false;
  polyPts = [];
  penAnchors = [];
  penCursor = null;
  // An armed perspective quad belongs to the document it was drawn on. Leaving
  // it alive let the next Enter wrap whichever tab was active (code-r8 #3).
  cropQuad = null;
  quadDragIdx = -1;
  // The Quick Mask is a view of THIS document's selection; a cached bitmap from
  // the previous tab would paint over the new one (code-r8 #8).
  // Notes and a magnetic drag belong to the picture that was on screen.
  notes = [];
  // The paint target and Quick Mask are per-document views, not session
  // preferences: a mask chip lit on tab A used to paint into tab B's pixels
  // (uiux-r17 #4). Reset both with the rest of the document-scoped state.
  paintTarget = "pixel";
  quickMask = false;
  quickMaskDirty = true;
  if (quickMaskCanvas) quickMaskCanvas = null;
  if (selGeom && selGeom.kind === "poly") selGeom = null;
}

// document tabs live in ./ui/tabs.ts — the shell keeps the live globals and
// mounts the strip; a tab switch swaps those globals through read()/write().
const tabsBar = document.getElementById("tabs")!;
mountTabs(tabsBar, {
  read: () => ({ doc, activeLayer, history: session.current, collapsed: session.collapsed, flat: flatCache.snapshot(), selRect, selMask, selGeom, scale, panX, panY, autosaveDirty, dirty: docDirty, view: { notes, counts, samples, rulerA, rulerB } }),
  write: (s) => {
    doc = s.doc; activeLayer = s.activeLayer; session.adopt(s.history, s.collapsed);
    flatCache.adopt(s.flat);
    selRect = s.selRect; selMask = s.selMask; selGeom = s.selGeom;
    scale = s.scale; panX = s.panX; panY = s.panY;
    autosaveDirty = s.autosaveDirty; docDirty = s.dirty;
    off.width = s.doc.width; off.height = s.doc.height;
    // Crosshairs, a ruler and half-drawn paths are in the OLD document's
    // coordinates; carrying them over draws them on a different picture.
    resetDocumentScopedState();
    const v = s.view as { notes?: typeof notes; counts?: typeof counts; samples?: typeof samples; rulerA?: typeof rulerA; rulerB?: typeof rulerB } | undefined;
    if (v) {
      notes = v.notes ?? [];
      counts = v.counts ?? [];
      samples = v.samples ?? [];
      rulerA = v.rulerA ?? null;
      rulerB = v.rulerB ?? null;
    }
  },
  patch: (p) => {
    if (p.doc) {
      doc = p.doc; off.width = p.doc.width; off.height = p.doc.height;
      resetDocumentScopedState();
    }
    if (p.activeLayer) activeLayer = p.activeLayer;
    if (p.history || p.collapsed) session.adopt(p.history ?? session.current, p.collapsed ?? session.collapsed);
    if (p.flat) flatCache.adopt(p.flat);
    if ("selRect" in p) selRect = p.selRect ?? null;
    if ("selMask" in p) selMask = p.selMask ?? null;
    if ("selGeom" in p) selGeom = p.selGeom ?? null;
    if (p.scale !== undefined) scale = p.scale;
    if (p.panX !== undefined) panX = p.panX;
    if (p.panY !== undefined) panY = p.panY;
    if (p.autosaveDirty !== undefined) autosaveDirty = p.autosaveDirty;
    if (p.dirty !== undefined) docDirty = p.dirty;
    const v = (p as { view?: { notes?: typeof notes; counts?: typeof counts; samples?: typeof samples; rulerA?: typeof rulerA; rulerB?: typeof rulerB } }).view;
    if (v) {
      notes = v.notes ?? [];
      counts = v.counts ?? [];
      samples = v.samples ?? [];
      rulerA = v.rulerA ?? null;
      rulerB = v.rulerB ?? null;
    }
  },
  commitText,
  cancelTransform,
  finishStroke: () => {
    if (strokeSession) {
      const entry = strokeSession.finish(activeLayer.grid, tool === "eraser" ? "Erase" : "Paint");
      strokeSession = null;
      if (entry) pushHist(entry); // pushHist marks the tab dirty for autosave
    }
  },
  closeGesture,
  clearTextSelection: () => { textSel = null; },
  clearPreview,
  hideContextMenu: () => hideContextMenu(),
  stopAnts,
  startAnts,
  renderAll: () => { render(); renderLayers(); renderHistoryPanel(); refreshOptions(); },
  drawOverlay,
  pushHist,
  iconSvg: (name, size) => iconSvg(name as Parameters<typeof iconSvg>[0], size),
  showContextMenu,
  saveProject: (asCopy) => saveProject(asCopy),
  activateTab: (i) => activateTab(i),
  quickExportPng: () => quickExportPng(),
  runTop,
  fit,
  hideRecoveryBar,
  ask: (title, body, ok, kind, extra) => ask(title, body, ok, kind, extra),
});

/**
 * Finish whatever gesture is in flight. `endStroke`, tab switching and window
 * blur all need this, and each used to reimplement a subset — the tab-switch copy
 * DISCARDED an uncommitted Spot Healing stroke, and the blur copy left the mask
 * allocated. One implementation, one behaviour.
 */
function closeGesture(): void {
  if (
    healMask || shapeDrag || moveDrag || cropDrag || marqueeing ||
    ellipseDrag || lassoing || gradientDrag || painting || textResize
  ) {
    endStroke(); // commits each kind (heal/shape/move) or finalises selection
  }
  // anything endStroke could not commit (no active layer, off-canvas drag) is
  // dropped here so the next gesture cannot inherit it
  painting = false;
  marqueeing = false;
  ellipseDrag = false;
  lassoing = false;
  moveDrag = null;
  gradientDrag = false;
  cropDrag = false;
  cropRect = null;
  healMask = null;
  healRect = null;
  textResize = null;
  rawCursor = null;
  quickPx = null;
  quickPxLayer = null;
  quickRegion = null;
  quickApplied = null;
}

topButton("file", "New", () => { newDocumentDialog(newDocDeps); }, "file-plus");

/** shell seams for the File > New dialog; the dialog module owns the wiring */
const newDocDeps: Parameters<typeof openNewDocumentDialog>[0] = {
  showModal,
  notify: (title, message) => notify(title, message),
  promptText: (title, message, initial) => askPrompt(title, message, initial),
  applyTransform,
  isTransforming: () => transform !== null,
  foregroundColor: () => color,
  backgroundColor: () => bgColor,
  replaceDocument: (d, layer, name) => replaceDocument(d, layer, name),
  setActiveTabDpi: setLastTabDpi,
  renderTabs,
};

const PSD_FEATURE_LABEL: Record<ImportReport["avoided"][number]["feature"], string> = {
  "group-opacity": "group opacity dropped",
  "group-blend": "group blend dropped",
  "pass-through": "pass-through dropped",
  adjustment: "adjustments dropped",
  "adjustment-partial": "adjustments imported without every field",
  fill: "fills dropped",
  text: "text rasterised",
  "text-style-runs": "per-run text styling dropped",
  "text-transform": "rotated/skewed text kept as pixels",
  "text-warp": "warped text kept as pixels",
  "text-on-path": "path text kept as pixels",
  "text-vertical": "vertical text kept as pixels",
  "text-wrap": "text wrap recomputed",
  "text-justify": "justified last-line alignment dropped",
  "text-paragraph-runs": "paragraph-style runs dropped",
  "text-effects": "text effects not editable",
  "text-runs": "text too large for a recipe",
  effect: "effects baked",
  "smart-object": "smart objects rasterised",
  mask: "masks dropped",
  "bit-depth": "16-bit depth clipped",
};

/** One line for the status bar: counts plus one summary per admission kind. */
function psdImportLine(report: ImportReport): string {
  const layers = `${report.layers} layer${report.layers === 1 ? "" : "s"}`;
  const groups = `${report.groups} group${report.groups === 1 ? "" : "s"}`;
  const counts = new Map<ImportReport["avoided"][number]["feature"], number>();
  for (const admission of report.avoided) counts.set(admission.feature, (counts.get(admission.feature) ?? 0) + 1);
  const parts = [...counts].map(([feature, n]) =>
    `${PSD_FEATURE_LABEL[feature]} on ${n} layer${n === 1 ? "" : "s"}`);
  if (report.substitutedFonts.length > 0) {
    const n = report.substitutedFonts.length;
    parts.push(`${n} font${n === 1 ? "" : "s"} substituted`);
  }
  return `${layers}, ${groups}${parts.length ? ` · ${parts.join(" · ")}` : " — no admissions"}`;
}

function psdImportPath(path: string): string {
  return path === "-" ? "Whole document" : path;
}

/** Readable at the moment it matters: one sentence, grouped counts, paths on demand. */
function showPsdImportReport(fileName: string, report: ImportReport): void {
  const total = report.avoided.length + report.substitutedFonts.length;
  const body = document.createElement("div");
  body.className = "stack import-report";

  const lead = document.createElement("p");
  lead.className = "import-lead";
  lead.textContent =
    "The file opened. Nothing was silently discarded; everything below was changed, not lost.";
  body.appendChild(lead);

  const fileLine = document.createElement("p");
  fileLine.className = "label";
  fileLine.textContent = `${fileName} — ${report.layers} layer${report.layers === 1 ? "" : "s"}, ${report.groups} group${report.groups === 1 ? "" : "s"}.`;
  body.appendChild(fileLine);

  const counts = new Map<ImportReport["avoided"][number]["feature"], number>();
  for (const admission of report.avoided) {
    counts.set(admission.feature, (counts.get(admission.feature) ?? 0) + 1);
  }
  const grouped = [...counts].sort(
    (a, b) => b[1] - a[1] || PSD_FEATURE_LABEL[a[0]].localeCompare(PSD_FEATURE_LABEL[b[0]]),
  );
  for (const [feature, count] of grouped) {
    const row = document.createElement("div");
    row.className = "import-count";
    row.textContent = `${PSD_FEATURE_LABEL[feature]} — ${count}`;
    body.appendChild(row);
  }
  if (report.substitutedFonts.length > 0) {
    // Fonts are one change per family, not per layer, so they get their own row
    // rather than inflating the "text rasterised" count.
    const row = document.createElement("div");
    row.className = "import-count";
    row.textContent = `font substitutions — ${report.substitutedFonts.length}`;
    body.appendChild(row);
  }

  const all = document.createElement("details");
  all.className = "import-all";
  const summary = document.createElement("summary");
  summary.textContent = `Show all ${total} changed ${total === 1 ? "item" : "items"}`;
  all.appendChild(summary);
  const list = document.createElement("ul");
  for (const admission of report.avoided) {
    const li = document.createElement("li");
    li.textContent = `${psdImportPath(admission.path)} — ${admission.detail}`;
    list.appendChild(li);
  }
  for (const font of report.substitutedFonts) {
    const li = document.createElement("li");
    li.textContent = `Whole document — font "${font}" was not available; its text uses "Arial" instead`;
    list.appendChild(li);
  }
  all.appendChild(list);
  body.appendChild(all);

  showModal(`Imported — ${total} thing${total === 1 ? "" : "s"} changed`, body, () => {}, {
    single: true,
  });
}

function openLastImportReport(): void {
  if (lastImportReport) showPsdImportReport(lastImportReport.fileName, lastImportReport.report);
}

/** Open a real Photoshop file via the vendored ag-psd UMD bundle
 *  (loaded as a classic script in index.html → globalThis.agPsd). */
async function openPsdFile(file: File): Promise<void> {
  const ag = (globalThis as { agPsd?: { readPsd: (buf: ArrayBuffer, options?: { useImageData?: boolean; totalMemoryLimit?: number }) => PsdLike } }).agPsd;
  if (!ag) {
    notify("PSD import unavailable", "The PSD support library (ag-psd) is not loaded.");
    return;
  }
  // AG3: the header is 26 bytes and says how much memory the parse will want.
  try {
    // Validate the header before the parse spends memory; the parse budget is
    // one figure (PSD_MEMORY_LIMIT), not a scaled guess (code-r32 #2).
    checkPsdHeader(new Uint8Array(await file.slice(0, 26).arrayBuffer()));
  } catch (err) {
    notify(`Could not open ${file.name}`, err instanceof Error ? err.message : String(err));
    statusError("PSD import failed — the file was not changed. Click to dismiss.");
    return;
  }
  let psd: PsdLike;
  try {
    psd = ag.readPsd(await file.arrayBuffer(), {
      useImageData: true,
      // Handoff 9 P0.4: ag-psd defaults to 2 GiB. ag-psd subtracts EVERY
      // decoded layer, mask and composite from this budget, so it cannot be
      // scaled to one canvas without failing ordinary multi-layer files
      // (code-r32 #2). The ceiling is therefore flat; a crafted small header
      // can ask for up to this figure before ag-psd refuses, which is the
      // bounded trade-off code-r33 #3 and sec-r32 accepted.
      totalMemoryLimit: PSD_MEMORY_LIMIT,
    });
    const report = emptyImportReport();
    const imported = psdToDocument(psd, report, { resolveFont: resolveImportedFont });
    replaceDocument(imported, undefined, file.name.replace(/\.[^.]+$/, "") || "PSD");
    statusHint(`Imported "${file.name}" — ${psdImportLine(report)}`);
    const changed = report.avoided.length + report.substitutedFonts.length;
    lastImportReport = changed > 0 ? { fileName: file.name, report } : null;
    if (sb) sb.details.style.display = changed > 0 ? "" : "none";
    if (changed > 0) showPsdImportReport(file.name, report);
  } catch (err) {
    notify(`Could not open ${file.name}`, err instanceof Error ? err.message : String(err));
    statusError("PSD import failed — the file was not changed. Click to dismiss.");
  }
}

/** decode a raster file to RGBA; TIFF goes through our own reader because
 *  browsers cannot decode it */
async function decodeImageFile(file: File): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  // The byte ceiling belongs here, not only in openAnyFile: the canvas drop
  // path and Replace Smart Contents both call this directly (sec-r6).
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(
      `Guazzo opens files up to ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB. ` +
        `"${file.name}" is ${Math.round(file.size / (1024 * 1024))} MB.`,
    );
  }
  if (/\.tiff?$/i.test(file.name)) {
    const img = decodeTiff(new Uint8Array(await file.arrayBuffer()));
    const tiffBad = imageImportRefusal(img.width, img.height);
    if (tiffBad) throw new Error(tiffBad);
    return { width: img.width, height: img.height, data: img.data };
  }
  // Refuse from the header, before the decoder allocates anything: a 200 KB
  // PNG can declare 20000² and turn into 1.6 GB (sec-r8 F1). Formats whose
  // header we cannot read still fall back to the post-decode check below.
  // The smoke harness's File is a stand-in without slice(); a real File always
  // has it, so a missing method simply skips the header check.
  const sniffed = typeof file.slice === "function"
    ? sniffImageSize(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()))
    : null;
  if (!sniffed) {
    // Formats whose header we cannot measure must not reach the decoder: a
    // 200 KB file declaring 16384² allocates a gigabyte first (sec-r11 #1).
    throw new Error(
      `Guazzo cannot read "${file.name}"'s dimensions before opening it, so it will not decode it. ` +
        "Supported pictures are PNG, JPEG, GIF, BMP, WebP and TIFF.",
    );
  }
  const bad = imageImportRefusal(sniffed.width, sniffed.height);
  if (bad) throw new Error(bad);
  const bmp = await createImageBitmap(file);
  // Refuse before allocating the canvas and its RGBA copy: a small file can
  // declare a 20000 px side and turn into gigabytes of pixels (sec-r5).
  const refused = imageImportRefusal(bmp.width, bmp.height);
  if (refused) { bmp.close(); throw new Error(refused); }
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const cc = c.getContext("2d", { willReadFrequently: true })!;
  cc.drawImage(bmp, 0, 0);
  return { width: c.width, height: c.height, data: cc.getImageData(0, 0, c.width, c.height).data };
}

/** the layer name an image file gets: its base name */
function layerNameFromFile(file: File): string {
  return file.name.replace(/\.[^.]+$/, "") || "Image";
}

/** true when dropping this file on the canvas should place it rather than
 *  replace the document: rasters yes, projects and PSD keep their own path */
function isPlaceableImage(file: File): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name) || /^image\/(png|jpeg|webp|gif|bmp|tiff?)$/i.test(file.type);
}

/**
 * Dropping a picture on the canvas places it on the active layer stack: fitted
 * inside the current document (never enlarged), centred, one undo step. It does
 * not silently replace the document the way dropping it anywhere else does.
 */
async function placeImageFile(file: File): Promise<void> {
  const img = await decodeImageFile(file);
  const r = placeRect(img.width, img.height, doc.width, doc.height);
  let data = img.data;
  if (r.scale < 1 || r.w !== img.width || r.h !== img.height) {
    // resample through a canvas: drawImage does the filtering, we take the pixels
    const src = document.createElement("canvas");
    src.width = img.width; src.height = img.height;
    const sctx = src.getContext("2d", { willReadFrequently: true })!;
    const idata = sctx.createImageData(img.width, img.height);
    idata.data.set(img.data);
    sctx.putImageData(idata, 0, 0);
    const dst = document.createElement("canvas");
    dst.width = r.w; dst.height = r.h;
    const dctx = dst.getContext("2d", { willReadFrequently: true })!;
    dctx.drawImage(src, 0, 0, r.w, r.h);
    data = dctx.getImageData(0, 0, r.w, r.h).data;
  }
  const layer = doc.addLayer(layerNameFromFile(file));
  layer.grid.writeRect(r.x, r.y, r.w, r.h, data);
  pushHist(addAboveActive(doc, layer));
  activeLayer = layer;
  declaredChange();
  renderLayers(); render(); renderHistoryPanel(); renderTabs();
  statusHint(r.scale < 1
    ? `Placed ${file.name} at ${r.w} × ${r.h} (scaled to fit)`
    : `Placed ${file.name} on the canvas`);
}

/**
 * A3: one import path. The Open dialog, the project dialog and drag-and-drop all
 * end up here, so a dropped file is validated by exactly the same parser as a
 * chosen one — a second entry point would be a second place to forget the size
 * caps and the repair warnings.
 */
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,.psd,.tif,.tiff,image/tiff,image/vnd.adobe.photoshop";

async function openAnyFile(file: File): Promise<void> {
  // AG3: refuse on the cheap number before reading a byte. Every entry point
  // (button, drop, compare) funnels through here, so this is the only gate.
  if (file.size > MAX_IMPORT_BYTES) {
    notify(
      `“${file.name}” is too large`,
      `Guazzo opens files up to ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB. ` +
        `This one is ${Math.round(file.size / (1024 * 1024))} MB.`,
    );
    return;
  }
  try {
    if (/\.json$/i.test(file.name)) {
      // The generic ceiling is right for pixels; JSON is bounded tighter
      // because parsing allocates before any structural validation runs.
      const refusal = jsonImportRefusal(file.size);
      if (refusal) {
        notify(`\u201c${file.name}\u201d is too large`, refusal);
        return;
      }
      const text = await file.text();
      const shapeRefusal = jsonShapeRefusal(text);
      if (shapeRefusal) throw new Error(shapeRefusal);
      const json = JSON.parse(text);
      const { doc: nd, warnings } = deserializeProject(json);
      const name = (json as { name?: unknown }).name;
      replaceDocument(nd, undefined, (typeof name === "string" && name) || file.name.replace(/\.[^.]+$/, "") || "Project");
      // A1: a repaired load is not a clean load — say what was repaired, or the
      // user saves a subtly different document over the original thinking it is fine.
      if (warnings.length > 0) {
        statusHint(`Opened with ${warnings.length} repair${warnings.length === 1 ? "" : "s"}`);
        showTextDialog(
          "Opened with repairs",
          `"${file.name}" was not perfectly formed. Guazzo repaired it rather than refusing to open:\n\n` +
            warnings.map((w) => `• ${w}`).join("\n") +
            "\n\nSave under a new name if you want to keep the original file untouched.",
        );
      }
      return;
    }
    if (/\.psd$/i.test(file.name)) {
      await openPsdFile(file);
      return;
    }
    const img = await decodeImageFile(file);
    const name = layerNameFromFile(file);
    const nd = new Document(img.width, img.height);
    const layer = nd.addLayer(name);
    layer.grid.writeRect(0, 0, img.width, img.height, img.data);
    replaceDocument(nd, layer, name);
    statusHint(`Opened ${file.name} (${img.width} × ${img.height})`);
  } catch (err) {
    console.error("open failed", err);
    notify(`Could not open “${file.name}”`, err instanceof Error ? err.message : String(err));
  }
}

topButton("file", "Open Image…", async () => {
  const file = await askFile(IMAGE_ACCEPT);
  if (file) await openAnyFile(file);
});

topButton("file", "Open Project…", async () => {
  const file = await askFile(".json,application/json");
  if (file) await openAnyFile(file);
});

// Drag a file anywhere onto the window to open it (the drop overlay says what
// will happen). Only the first few files are taken: opening twenty at once is
// never what someone meant, and each one allocates a full document.
const DROP_MAX = 4;
let dropDepth = 0;
function showDropHint(on: boolean): void {
  const host = document.getElementById("canvas-host");
  if (!host) return;
  host.classList.toggle("drop-target", on);
}
document.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  showDropHint(true);
});
document.addEventListener("dragleave", (e) => {
  // dragleave fires for every child element; count the nesting instead of
  // flickering the hint off when the pointer crosses a panel
  dropDepth = Math.max(0, dropDepth - 1);
  if (dropDepth === 0 || e.relatedTarget === null) showDropHint(false);
});
document.addEventListener("dragenter", () => { dropDepth++; });
document.addEventListener("drop", (e) => {
  dropDepth = 0;
  showDropHint(false);
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  e.preventDefault();
  const take = files.slice(0, DROP_MAX);
  if (files.length > take.length) {
    statusHint(`Opening the first ${take.length} of ${files.length} dropped files`);
  }
  // where the pointer let go decides what happens: the tab bar opens a new
  // project, the canvas places the picture into the one that is already open
  const target = e.target as Element | null;
  const onTabs = !!target?.closest?.("#tabs");
  const onCanvas = !!target?.closest?.("#canvas-host");
  void (async () => {
    for (const f of take) {
      try {
        if (onCanvas && isPlaceableImage(f)) await placeImageFile(f);
        else await openAnyFile(f);
      } catch (err) {
        notify(`Could not open “${f.name}”`, err instanceof Error ? err.message : String(err));
      }
    }
    if (onTabs && take.length > 0) statusHint(`Opened ${take.length === 1 ? take[0]!.name : `${take.length} files`} in ${take.length === 1 ? "a new project" : "new projects"}`);
  })();
});

/**
 * AG1: `inPlace` is Ctrl+S — overwrite the file THIS document last saved, no
 * dialog. The dirty flags clear only after the write succeeded, so cancelling
 * the dialog (or a failed write) leaves the document marked as unsaved.
 */
async function saveProject(inPlace = false): Promise<void> {
  // A live transform bumps no revision, so saving under it wrote pre-transform
  // pixels and then cleared the dirty flag (code-r28 #4). Commit it first.
  if (transform) applyTransform();
  // The loader refuses above the same ceiling, so saving past it produced a
  // file that could not be reopened — after reporting "Saved" (sec-r5).
  const tooBig = projectTileRefusal(projectTileCount(doc), projectSmartBytes(doc));
  if (tooBig) { notify("This document is too large to save", tooBig); return; }
  const tab = activeTabView();
  const tname = tab?.name ?? "untitled";
  const revisionAtSerialize = doc.revision;
  const json = serializeProject(doc, tname);
  const outcome = await saveBlob(
    `${tname.replace(/[\\/:*?"<>|]/g, "_")}.guazzo.json`,
    new Blob([JSON.stringify(json)], { type: "application/json" }),
    "json",
    { inPlace: inPlace ? tab?.savedHandle : undefined, remember: true },
  );
  if (!outcome.ok) return;
  if (outcome.handle !== undefined && tab) {
    tab.savedHandle = outcome.handle;
    tab.savedName = outcome.savedName ?? tab.savedName;
  }
  if (doc.revision === revisionAtSerialize) {
    docDirty = false;
    if (tab) tab.dirty = false;
    // `dirty` is what makes a snapshot "clean"; the write path gates on the
    // per-tab autosave flag, which saving never touched — so a saved session
    // was still offered as crash work on the next launch (uiux-r38 F2).
    for (const t of tabsView()) t.autosaveDirty = true;
    autosaveDirty = true;
    captureTab();
    autosaveScheduler?.noteEdit();
  } else {
    // An edit landed while the blob was being written; the file on disk holds
    // the earlier state, so the tab must stay dirty (code-r23 #3).
    statusHint("Saved the state as it was when the save started — this edit is still unsaved.");
  }
  renderTabs();
  updateStatus();
}

topButton("file", "Save Project", () => { void saveProject(true); });
topButton("file", "Save Project As…", () => { void saveProject(false); }, "save");
topButton("file", "Export As…", () => exportAs(), "download");

/** Export As…: PNG / JPEG / WebP / PSD, with quality, scale and a size estimate. */
function exportAs(): void {
  // A live transform bumps no revision; exporting under it shipped
  // pre-transform pixels (code-r29 #2).
  if (transform) applyTransform();
  if (transform) return;
  openExportDialog({
    showModal,
    docInfo: () => {
      const loss = psdExportLoss(doc);
      return {
        width: doc.width,
        height: doc.height,
        totalLayers: doc.layers.length,
        flattenedLayers: loss.blocked.length,
        flattenedNames: loss.blocked.map((layer) => layer.name),
        noteCount: loss.notes.length,
        noteText: loss.notes.join("; "),
      };
    },
    psdAdmission: () => psdExportLoss(doc).admission,
    defaultName: () => activeTabView()?.name ?? "untitled",
    onExport: (req) => runExport(req),
  });
}

function runExport(req: ExportRequest): void {
  const safe = req.filename.replace(/[\\/:*?"<>|]/g, "_");
  if (req.format === "psd") {
    // A PSD carries layers, so a scaled export would mean resampling every
    // layer and mask — the writer takes one document. Refuse rather than
    // write a full-size file the dialog called "50 %".
    if (req.scale !== 1) {
      notify("PSD exports at 100%", "A PSD keeps its layers, so Guazzo cannot scale it on the way out. Resize with Image Size first.");
      return;
    }
    writePsdBlob(safe);
    return;
  }
  // Scaled export: draw the flattened frame through a canvas so one bit of math
  // handles every format and every scale factor.
  const w = Math.max(1, Math.round(doc.width * req.scale));
  const h = Math.max(1, Math.round(doc.height * req.scale));
  const refusal = exportRefusal(w, h, req.format);
  if (refusal) {
    notify("Export too large", refusal);
    return;
  }
  if (wasmEngineEnabled()) {
    void runExportWasm(req, safe, w, h);
    return;
  }
  runExportOriginal(req, safe, w, h);
}

async function runExportWasm(req: ExportRequest, safe: string, w: number, h: number): Promise<void> {
  try {
    const json = JSON.stringify(serializeProject(doc, activeTabView()?.name ?? "Export"));
    const image = await wasmCompositeCall(json, doc.width, doc.height);
    const base = document.createElement("canvas");
    base.width = doc.width;
    base.height = doc.height;
    base.getContext("2d")!.putImageData(image, 0, 0);
    const scaled = document.createElement("canvas");
    scaled.width = w;
    scaled.height = h;
    const sctx = scaled.getContext("2d")!;
    if (req.format === "jpeg") {
      sctx.fillStyle = "#ffffff";
      sctx.fillRect(0, 0, w, h);
    }
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(base, 0, 0, w, h);
    const mime = req.format === "jpeg" ? "image/jpeg" : req.format === "webp" ? "image/webp" : "image/png";
    const quality = req.format === "png" ? undefined : Math.max(0.01, Math.min(1, req.quality / 100));
    const blob = await new Promise<Blob | null>((resolve) => scaled.toBlob(resolve, mime, quality));
    if (!blob) throw new Error("the canvas encoder returned no blob");
    await saveBlob(safe, blob, req.format === "jpeg" ? "jpg" : req.format);
    statusHint("Exported with the Rust engine");
  } catch (err) {
    console.error("wasm export failed; using the original engine", err);
    statusHint("Rust engine unavailable — using the original engine");
    runExportOriginal(req, safe, w, h);
  }
}

function runExportOriginal(req: ExportRequest, safe: string, w: number, h: number): void {
  renderFlat();
  // ALWAYS a fresh canvas: aliasing `off` (the shared composite cache) and then
  // assigning .width would clear the very bitmap we are about to read, which
  // exported a white JPEG and left the viewport blitting an empty cache.
  const scaled = document.createElement("canvas");
  scaled.width = w;
  scaled.height = h;
  const sctx = scaled.getContext("2d")!;
  // JPEG has no alpha: flatten onto white so the user never gets black fringes.
  if (req.format === "jpeg") {
    sctx.fillStyle = "#ffffff";
    sctx.fillRect(0, 0, w, h);
  }
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(off, 0, 0, w, h);
  const mime = req.format === "jpeg" ? "image/jpeg" : req.format === "webp" ? "image/webp" : "image/png";
  const quality = req.format === "png" ? undefined : Math.max(0.01, Math.min(1, req.quality / 100));
  scaled.toBlob((b) => {
    if (b) void saveBlob(safe, b, req.format === "jpeg" ? "jpg" : req.format);
    else notify("Export failed", `The ${req.format.toUpperCase()} encoder refused this document. Try PNG instead.`);
  }, mime, quality);
}

/** PSD export: layers with names/opacity/visibility/blend modes where possible. */
function writePsdBlob(filename: string): void {
  const ag = (globalThis as {
    agPsd?: { writePsd?: (psd: unknown, opts?: { generateThumbnail?: boolean }) => ArrayBuffer };
  }).agPsd;
  if (!ag?.writePsd) {
    notify("PSD export unavailable", "The ag-psd bundle did not expose writePsd.");
    return;
  }
  const { psd, admission } = buildPsdForExport(doc, activeTabView()?.name ?? "Composite");
  try {
    const buf = ag.writePsd(psd, { generateThumbnail: false });
    void saveBlob(filename, new Blob([buf], { type: "image/vnd.adobe.photoshop" }), "psd").then((out) => {
      if (out.ok && admission) statusHold(`Exported “${filename}” — ${admission}`);
    });
  } catch (err) {
    console.error("psd export failed", err);
    notify("PSD export failed", err instanceof Error ? err.message : String(err));
  }
}

// ---- image/canvas resize -----------------------------------------------------

/** small modal helper: dark overlay, title, body, OK/Cancel; Esc closes */
function numField(parent: HTMLElement, label: string, value: number): HTMLInputElement {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  span.className = "label";
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.min = "1";
  input.max = String(MAX_DIM);
  wrap.append(span, input);
  parent.appendChild(wrap);
  return input;
}

/** swap a transformed document into the current tab (no stress on history) */
function applyImageOp(label: string, next: Document): void {
  if (transform) return;
  setDocInTab(next, label);
  render();
  renderLayers();
  renderHistoryPanel();
  renderTabs();
  pulse(filterBox);
}

/** Run a whole-document geometry op in Rust, then apply the result.
 *  False means the caller should run the TypeScript fallback. */
async function applyRustImageOp(
  label: string,
  run: (json: string, name: string) => Promise<string>,
): Promise<boolean> {
  const source = doc;
  const identity = docIdentity(source);
  try {
    const name = activeTabView()?.name ?? "Untitled";
    const json = JSON.stringify(serializeProject(source, name));
    const nextJson = await run(json, name);
    if (doc !== source || docIdentity(doc) !== identity) {
      statusHint(`${label} skipped — document changed`);
      return true;
    }
    const { doc: next } = deserializeProject(JSON.parse(nextJson));
    applyImageOp(label, next);
    statusHint(`${label} with the Rust engine`);
    return true;
  } catch (err) {
    console.error("wasm image op failed; using the original engine", err);
    statusHint("Rust engine unavailable — using the original engine");
    return false;
  }
}

async function rotateDoc(dir: 1 | -1): Promise<void> {
  if (transform) return;
  const label = dir === 1 ? "Rotate 90 CW" : "Rotate 90 CCW";
  if (wasmEngineEnabled() && await applyRustImageOp(label, (json, name) => wasmRotateCall(json, name, dir))) return;
  applyImageOp(label, rotate90(doc, dir));
}

async function rotateDoc180(): Promise<void> {
  if (transform) return;
  if (wasmEngineEnabled() && await applyRustImageOp("Rotate 180", (json, name) => wasmRotateCall(json, name, 2))) return;
  applyImageOp("Rotate 180", rotate180(doc));
}

async function flipDoc(axis: "horizontal" | "vertical"): Promise<void> {
  if (transform) return;
  const label = axis === "horizontal" ? "Flip Horizontal" : "Flip Vertical";
  if (wasmEngineEnabled() && await applyRustImageOp(label, (json, name) => wasmFlipCall(json, name, axis === "horizontal"))) return;
  applyImageOp(label, flip(doc, axis));
}

function trimDoc(): void {
  if (transform) return;
  const px = new Uint8ClampedArray(doc.width * doc.height * 4);
  doc.compositeRect(0, 0, doc.width, doc.height, px);
  const box = trimBounds(px, doc.width, doc.height, 0);
  if (!box || (box.w === doc.width && box.h === doc.height)) return;
  applyImageOp("Trim", cropDocument(doc, box.x, box.y, box.w, box.h));
}

topButton("image", "Rotate 90° CW", rotateDoc.bind(null, 1), "transform");
topButton("image", "Rotate 90° CCW", rotateDoc.bind(null, -1), "transform");
topButton("image", "Rotate 180°", rotateDoc180, "transform");
topButton("image", "Flip Horizontal", flipDoc.bind(null, "horizontal"), "swap");
topButton("image", "Flip Vertical", flipDoc.bind(null, "vertical"), "swap");
topButton("image", "Trim", trimDoc, "crop");
topButton("image", "Image Size…", () => {
  if (transform) return;
  const box = document.createElement("div");
  const wIn = numField(box, "Width", doc.width);
  const hIn = numField(box, "Height", doc.height);
  const link = document.createElement("input");
  link.type = "checkbox";
  link.checked = true;
  const linkLabel = document.createElement("label");
  linkLabel.style.cssText = "display:flex;gap:6px;align-items:center;cursor:pointer";
  linkLabel.append(link, Object.assign(document.createElement("span"), { textContent: "Keep aspect ratio" }));
  box.appendChild(linkLabel);
  const ar = doc.width / doc.height;
  wIn.addEventListener("input", () => {
    if (!link.checked) return;
    const w = Math.max(1, Number(wIn.value) || 1);
    hIn.value = String(Math.max(1, Math.round(w / ar)));
  });
  // Only Width used to be linked, so typing a Height with "Keep aspect ratio"
  // ticked stretched the image while the box said otherwise (uiux-r22 #2).
  hIn.addEventListener("input", () => {
    if (!link.checked) return;
    const h = Math.max(1, Number(hIn.value) || 1);
    wIn.value = String(Math.max(1, Math.round(h * ar)));
  });
  showModal("Image Size", box, () => {
    const w = Math.min(MAX_DIM, Math.max(1, Math.round(Number(wIn.value) || doc.width)));
    const h = Math.min(MAX_DIM, Math.max(1, Math.round(Number(hIn.value) || doc.height)));
    if (w === doc.width && h === doc.height) return;
    if (imageImportRefusal(w, h)) {
      notify("Image Size refused", imageImportRefusal(w, h)!);
      return;
    }
    setDocInTab(resizeDocument(doc, w, h), "Image Size");
  });
});

topButton("image", "Canvas Size…", () => {
  if (transform) return;
  const box = document.createElement("div");
  const wIn = numField(box, "Width", doc.width);
  const hIn = numField(box, "Height", doc.height);
  const anchorLabel = document.createElement("div");
  anchorLabel.textContent = "Anchor";
  anchorLabel.style.cssText = "margin:6px 0 4px";
  box.appendChild(anchorLabel);
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(3,28px);gap:4px;margin-bottom:4px";
  let ax = 0.5, ay = 0.5;
  const cells: HTMLButtonElement[] = [];
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "anchor-cell" + (cx === 1 && cy === 1 ? " active" : "");
      const where = ["top", "middle", "bottom"][cy] + " " + ["left", "centre", "right"][cx];
      b.setAttribute("aria-label", `Anchor ${where}`);
      b.setAttribute("aria-pressed", cx === 1 && cy === 1 ? "true" : "false");
      const my = cy, mx = cx;
      b.addEventListener("click", () => {
        ax = mx / 2; ay = my / 2;
        cells.forEach(c => {
          c.classList.remove("active");
          c.setAttribute("aria-pressed", "false");
        });
        b.classList.add("active");
        b.setAttribute("aria-pressed", "true");
      });
      grid.appendChild(b);
      cells.push(b);
    }
  }
  box.appendChild(grid);
  showModal("Canvas Size", box, () => {
    const w = Math.min(MAX_DIM, Math.max(1, Math.round(Number(wIn.value) || doc.width)));
    const h = Math.min(MAX_DIM, Math.max(1, Math.round(Number(hIn.value) || doc.height)));
    if (w === doc.width && h === doc.height && ax === 0.5 && ay === 0.5) return;
    if (imageImportRefusal(w, h)) {
      notify("Canvas Size refused", imageImportRefusal(w, h)!);
      return;
    }
    setDocInTab(canvasResizeDocument(doc, w, h, ax, ay), "Canvas Size");
  });
});

function toolButton(icon: IconName, id: ToolId | null, description: string, cb: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tool";
  // AF1: hover text is the canonical label (derived from the tool id, never a
  // second literal); aria-label keeps the whole sentence for screen readers.
  const title = id ? toolTitle(id, description) : description;
  b.title = id ? TOOL_LABELS[id] : description;
  b.setAttribute("aria-label", title);
  b.innerHTML = iconSvg(icon, 19);
  b.addEventListener("click", cb);
  toolArea.appendChild(b);
  return b;
}

/** thin divider between toolbar groups */
function toolSeparator(): void {
  const sep = document.createElement("div");
  sep.className = "tool-sep";
  toolArea.appendChild(sep);
}

const moveBtn = toolButton("move", "move", "drag the layer, arrows nudge", () => { tool = "move"; highlight(); });
const marqueeBtn = toolButton("marquee", "marquee", "", () => { tool = "marquee"; highlight(); });
const ellipseBtn = toolButton("ellipse", "ellipse", "", () => { tool = "ellipse"; highlight(); });
const lassoBtn = toolButton("lasso", "lasso", "", () => { tool = "lasso"; highlight(); });
const polyLassoBtn = toolButton("polygon", "polylasso", "click to add points, Enter to close", () => { tool = "polylasso"; highlight(); });
const penBtn = toolButton("nib", "pen", "", () => { tool = "pen"; highlight(); });
const wandBtn = toolButton("wand", "wand", "click to select similar pixels", () => { tool = "wand"; highlight(); });
const quickBtn = toolButton("quickselect", "quick", "paint to select similar pixels", () => { tool = "quick"; highlight(); });
const shapeBtn = toolButton("frame", "shape", "drag to draw a shape", () => { tool = "shape"; highlight(); });
const cropBtn = toolButton("crop", "crop", "drag, then Enter", () => { tool = "crop"; highlight(); });
toolSeparator();
const brushBtn = toolButton("brush", "brush", "", () => { tool = "brush"; highlight(); });
const eraserBtn = toolButton("eraser", "eraser", "", () => { tool = "eraser"; highlight(); });
const pencilBtn = toolButton("pencil", "pencil", "hard, aliased edge; Shift+B", () => { tool = "pencil"; highlight(); });
const patternStampBtn = toolButton("pattern", "patternstamp", "click to stamp the pattern", () => { tool = "patternstamp"; highlight(); });
const mixerBtn = toolButton("mixer", "mixer", "paint with colour picked up from the layer", () => { tool = "mixer"; highlight(); });
const gradientBtn = toolButton("gradient", "gradient", "", () => { tool = "gradient"; highlight(); });
const bucketBtn = toolButton("bucket", "bucket", "click to fill an area", () => { tool = "bucket"; highlight(); });
const magicEraseBtn = toolButton("eraser", "magicerase", "click a colour to erase it", () => { tool = "magicerase"; highlight(); });
const bgEraseBtn = toolButton("bgerase", "bgerase", "drag to erase pixels of a sampled colour", () => { tool = "bgerase"; highlight(); });
const colourReplaceBtn = toolButton("replace", "colourreplace", "drag to repaint one colour with the foreground", () => { tool = "colourreplace"; highlight(); });
const patchBtn = toolButton("patch", "patch", "drag a selection onto the pixels that should replace it", () => { tool = "patch"; highlight(); });
const noteBtn = toolButton("note", "note", "click to attach a note", () => { tool = "note"; highlight(); });
const magnetBtn = toolButton("magnet", "magnet", "drag a rough outline, it snaps to edges on release", () => { tool = "magnet"; highlight(); });
const healBtn = toolButton("bandage", "heal", "paint over a blemish to rebuild it", () => { tool = "heal"; highlight(); });
toolSeparator();
const eyedropperBtn = toolButton("eyedropper", "eyedropper", "click to sample a colour", () => { tool = "eyedropper"; highlight(); });
const samplerBtn = toolButton("sampler", "sampler", "click to place up to four colour samples", () => { tool = "sampler"; highlight(); });
const countBtn = toolButton("count", "count", "click to number points on the canvas", () => { tool = "count"; highlight(); });
const rulerBtn = toolButton("ruler", "ruler", "drag to measure distance and angle", () => { tool = "ruler"; highlight(); });
const retouchBtn = toolButton("dodge", "retouch", "", () => { tool = "retouch"; highlight(); });
const cloneBtn = toolButton("stamp", "clone", "Alt-click sets the source", () => { tool = "clone"; highlight(); });
const focusBtn = toolButton("blur", "focus", "", () => { tool = "focus"; highlight(); });
toolSeparator();
const textBtn = toolButton("text", "text", "", () => { tool = "text"; highlight(); });
// free transform is a MODE, not a persistent tool: clicking the button while
// a transform is active commits it (Apply), otherwise it enters transform mode
const transformToolBtn = toolButton("transform", null, "Free Transform (Ctrl+T)", () => {
  if (transform) applyTransform(); else enterTransform();
});
const TOOL_BTN: Record<ToolId, HTMLButtonElement> = {
  brush: brushBtn, pencil: pencilBtn, patternstamp: patternStampBtn, mixer: mixerBtn, eraser: eraserBtn, marquee: marqueeBtn,
  ellipse: ellipseBtn, lasso: lassoBtn, polylasso: polyLassoBtn, gradient: gradientBtn, text: textBtn,
  move: moveBtn, crop: cropBtn, wand: wandBtn, quick: quickBtn, bucket: bucketBtn, magicerase: magicEraseBtn, bgerase: bgEraseBtn, colourreplace: colourReplaceBtn, patch: patchBtn, note: noteBtn, magnet: magnetBtn,
  shape: shapeBtn,
  heal: healBtn,
  eyedropper: eyedropperBtn, sampler: samplerBtn, count: countBtn, ruler: rulerBtn, retouch: retouchBtn, clone: cloneBtn, focus: focusBtn,
  pen: penBtn,
};

// right-click on a tool button switches within its family (Photoshop flyouts).
// Labels are static because promoteTitles moves `title` to data-tip at runtime.
// Short names for the right-click family menus. Tool BUTTONS keep richer
// aria-labels (set by toolButton from the hint text) for assistive tech;
// this table is the terse menu-face of the same tools (handoff-3 T6).
const TOOL_FAMILIES: Partial<Record<ToolId, string>> = {
  marquee: "Selection", ellipse: "Selection", lasso: "Selection", polylasso: "Selection",
  wand: "Selection", quick: "Selection",
  brush: "Painting", pencil: "Painting", patternstamp: "Painting", mixer: "Painting", eraser: "Painting",
  gradient: "Painting", bucket: "Painting", magicerase: "Painting", bgerase: "Painting", colourreplace: "Painting",
  heal: "Retouching", retouch: "Retouching", clone: "Retouching", focus: "Retouching", patch: "Retouching", note: "Sampling", magnet: "Selection",
  eyedropper: "Sampling", sampler: "Sampling", count: "Sampling", ruler: "Sampling",
};
for (const [id, btn] of Object.entries(TOOL_BTN) as [ToolId, HTMLButtonElement][]) {
  const fam = TOOL_FAMILIES[id];
  if (!fam) continue;
  btn.addEventListener("contextmenu", (e) => {
    const members = (Object.entries(TOOL_BTN) as [ToolId, HTMLButtonElement][])
      .filter(([tid]) => TOOL_FAMILIES[tid] === fam);
    showContextMenu(e, [
      { header: fam + " Tools" },
      ...members.map(([tid]) => ({
        label: TOOL_LABELS[tid],
        checked: tool === tid,
        run: () => { tool = tid; highlight(); },
      })),
    ]);
  });
}
/** The pointer must say what will happen: ring tools hide the OS cursor. */
function syncCursor(): void {
  if (panning) { host.style.cursor = "grabbing"; return; }
  if (handMode) { host.style.cursor = "grab"; return; }
  if (panSticky) { host.style.cursor = "grab"; return; }
  if (spaceDown) { host.style.cursor = "grab"; return; }
  if (zoomMode) { host.style.cursor = "zoom-in"; return; }
  if (transform) { host.style.cursor = "move"; return; }
  if (tool === "move") { host.style.cursor = "move"; return; }
  if (tool === "text") { host.style.cursor = "text"; return; }
  if (tool === "crop" || tool === "gradient") { host.style.cursor = "crosshair"; return; }
  // brush-family tools draw their own ring on the overlay
  host.style.cursor = BRUSH_TOOLS.has(tool) ? "none" : "crosshair";
}

/** The "?" guide popover; declared here because highlight() (called during
 *  startup, before the help implemention at the bottom is reached) may close it. */
let helpPanel: HTMLElement | null = null;

function highlight(): void {
  // The guide popover anchors to a button in the bar this function rebuilds.
  if (helpPanel) closeHelpPanel();
  const hadBrushPanel = brushPanel !== null;
  // The brush panel belongs to one tool's options bar. Switching tools rebuilds
  // that bar, so a panel left open would edit a recipe the new tool never reads
  // and would return focus to a detached button (uiux-r7 #5).
  if (brushPanel) brushPanel.close();
  // Tool switch commits, Photoshop-style — then the rest of this function still
  // has to run: the early return left the old tool marked active (ui13).
  if (transform) applyTransform();
  // ui12: a half-drawn crop is a gesture of the crop tool. Leaving the tool
  // used to keep the dim overlay and an invisible armed crop.
  if (tool !== "crop") {
    if (cropQuad) cancelPerspective();
    else if (cropRect) cancelCrop();
  }
  // AD1: sticky view modes are a VIEW state, not a tool; picking a tool must
  // leave them or the next brush stroke pans the canvas instead of painting.
  if (handMode || zoomMode) { handMode = false; zoomMode = false; syncCursor(); }
  if (tool !== "text") commitText(); // leaving the text tool commits any live box
  // A half-drawn polygon belongs to the lasso tool. Leaving it used to keep a
  // dangling preview, and the next Enter looked like it had been ignored.
  if (tool !== "pen" && penAnchors.length > 0) cancelPenPath();
  if (tool !== "pen" && ffDrag) endFreeformPath(false, off.width, off.height);
  // Every drag below belongs to the tool that started it: pressing B mid-drag
  // used to commit the marquee/gradient/shape under the new tool.
  // A move is a real edit, not a half-drawn gesture: endMoveDrag records it.
  // Dropping moveDrag here left the applied pixels with no undo step and the
  // mask untranslated (code-r21 #2).
  if (moveDrag) endMoveDrag();
  if (marqueeing || ellipseDrag || gradientDrag || shapeDrag || patchStart) {
    marqueeing = false;
    ellipseDrag = false;
    gradientDrag = false;
    shapeDrag = null;
    patchStart = null;
    patchLast = null;
    patchMask = null;
    selGeom = null;
    drawOverlay();
  }
  // A drag belongs to the tool that started it: pointerup used to commit the
  // lasso under whatever tool the shortcut had just selected (code-r13 #6).
  if (tool !== "lasso" && tool !== "magnet" && lassoing) {
    lassoing = false;
    lassoPts = [];
    selGeom = null;
    drawOverlay();
  }
  // Colour samples are the sampler's overlay. Leaving the tool used to keep
  // the crosshairs and chips on every subsequent document (uiux-r5): the only
  // Clear lived in the sampler bar, which is not on screen any more.
  if (tool !== "sampler" && samples.length > 0) {
    samples = [];
    drawOverlay();
  }
  // The ruler is the same contract as the sampler: its overlay belongs to the
  // tool. It used to stay drawn over the canvas until Escape or a tab switch.
  if (tool !== "ruler" && (rulerA || rulerB)) {
    rulerA = null;
    rulerB = null;
    rulerDrag = false;
    drawOverlay();
  }
  if (tool !== "polylasso" && polyPts.length > 0) {
    // Leaving the tool is a cancel, like Escape: it must put the selection from
    // before the first click back instead of silently dropping both (uiux-r38 F3).
    endPolyLasso(false, flatCache.width, flatCache.height);
  }
  for (const b of Object.values(TOOL_BTN)) b.classList.remove("active");
  TOOL_BTN[tool].classList.add("active");
  // The active class is invisible to a screen reader; the pressed state is not
  // (uiux-r26 F5).
  for (const [id, b] of Object.entries(TOOL_BTN)) {
    b.setAttribute("aria-pressed", String(id === tool));
  }
  syncCursor();
  refreshOptions();
  if (hadBrushPanel) {
    // The panel held focus and its button was rebuilt; land on the new bar's
    // first control instead of dropping to <body> (uiux-r8 #4).
    const first = optionsBar.querySelector?.("button, select, input") as HTMLElement | null;
    (first ?? display).focus();
  }
}
highlight();

// ---- shared foreground color (left toolbar: brush + text use this) ---------
// ---- in-app colour picker (replaces the OS <input type="color"> popup) --
let colorPop: HTMLElement | null = null;
let colorPopBefore: [number, number, number] | null = null;
let colorPopOutside: ((e: PointerEvent) => void) | null = null;
let colorPopKey: ((e: KeyboardEvent) => void) | null = null;
/** the control a popover was opened from; focus returns here on close */
let colorPopAnchor: HTMLElement | null = null;
let pickerSV: ((c: [number, number, number]) => void) | null = null;

function syncColorWell(): void {
  colorWell.style.background = hex([color[0], color[1], color[2]]);
}

function closeColorPop(): void {
  if (colorPopOutside) document.removeEventListener("pointerdown", colorPopOutside, true);
  if (colorPopKey) window.removeEventListener("keydown", colorPopKey, true);
  colorPopOutside = null;
  colorPopKey = null;
  colorPop?.remove();
  colorPop = null;
  colorPopBefore = null;
  pickerSV = null;
  // The card's hex field and channel sliders kept whatever they showed before
  // the popover opened, so a committed colour never appeared there (uiux-r18).
  syncColorPanel();
  // Closing used to drop focus to <body>, so the next Tab started from the top
  // of the document instead of the swatch that opened the picker (uiux-r17 #6).
  const back = colorPopAnchor;
  colorPopAnchor = null;
  if (back && back.isConnected && back.offsetParent !== null) back.focus();
  else if (back) display.focus();
}

// ---- HSV spectrum picker helpers ---------------------------------------
function rgbToHsv(c: [number, number, number]): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max <= 0 ? 0 : d / max;
  return [h, s, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r = 0, g = 0, b = 0;
  if (i === 0) { r = v; g = t; b = p; }
  else if (i === 1) { r = q; g = v; b = p; }
  else if (i === 2) { r = p; g = v; b = t; }
  else if (i === 3) { r = p; g = q; b = v; }
  else if (i === 4) { r = t; g = p; b = v; }
  else { r = v; g = p; b = q; }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const SV_W = 226, SV_H = 124, HUE_H = 14;

function drawSvField(ctx: CanvasRenderingContext2D, hueDeg: number): void {
  const [r, g, b] = hsvToRgb(hueDeg, 1, 1);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, SV_W, SV_H);
  const gw = ctx.createLinearGradient(0, 0, SV_W, 0);
  gw.addColorStop(0, "rgb(255,255,255)");
  gw.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gw;
  ctx.fillRect(0, 0, SV_W, SV_H);
  const gb = ctx.createLinearGradient(0, 0, 0, SV_H);
  gb.addColorStop(0, "rgba(0,0,0,0)");
  gb.addColorStop(1, "rgb(0,0,0)");
  ctx.fillStyle = gb;
  ctx.fillRect(0, 0, SV_W, SV_H);
}

function drawHueStrip(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, SV_W, 0);
  for (let i = 0; i <= 6; i++) {
    const [r, gg, b] = hsvToRgb(i * 60, 1, 1);
    g.addColorStop(i / 6, `rgb(${r},${gg},${b})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SV_W, HUE_H);
}

/**
 * The in-app colour picker. Without `target` it edits the FOREGROUND colour;
 * with a target (e.g. the gradient-map swatches in the adjustments palette)
 * it edits that value instead — one picker, two sinks.
 */
function openColorPicker(
  anchor: HTMLElement,
  target?: { get(): [number, number, number]; set(c: [number, number, number]): void },
): void {
  closeColorPop();
  colorPopAnchor = anchor;
  const initial: [number, number, number] = target ? target.get() : [color[0], color[1], color[2]];
  colorPopBefore = [initial[0], initial[1], initial[2]];

  const pop = document.createElement("div");
  pop.className = "color-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", target ? "Colour" : "Foreground colour");

  const preview = document.createElement("div");
  preview.className = "cp-preview";
  preview.style.background = hex(initial);
  pop.appendChild(preview);

  const hexRow = document.createElement("label");
  hexRow.className = "cp-row";
  const hexLab = document.createElement("span");
  hexLab.className = "label";
  hexLab.textContent = "Hex";
  const hexField = document.createElement("input");
  hexField.type = "text";
  hexField.className = "hex";
  hexField.maxLength = 7;
  hexField.value = hex(initial);
  hexRow.append(hexLab, hexField);
  pop.appendChild(hexRow);

  const ranges: HTMLInputElement[] = [];
  for (let i = 0; i < 3; i++) {
    const row = document.createElement("label");
    row.className = "cp-row";
    const lab = document.createElement("span");
    lab.className = "label";
    lab.textContent = "RGB"[i]!;
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "255";
    range.value = String(initial[i]);
    range.setAttribute("aria-label", `${lab.textContent} channel`);
    const val = document.createElement("span");
    val.className = "value";
    val.textContent = String(initial[i]);
    range.addEventListener("input", () => {
      val.textContent = range.value;
      commit([
        Number(ranges[0]?.value ?? initial[0]),
        Number(ranges[1]?.value ?? initial[1]),
        Number(ranges[2]?.value ?? initial[2]),
      ]);
    });
    ranges.push(range);
    row.append(lab, range, val);
    pop.appendChild(row);
  }

  /** every change funnels through here: write the sink, refresh the chrome. */
  function commit(c: [number, number, number]): void {
    if (target) {
      target.set(c);
    } else {
      color[0] = c[0]; color[1] = c[1]; color[2] = c[2];
      syncColorWell();
      restyleTextEditor();
    }
    const h = hex(c);
    hexField.value = h;
    preview.style.background = h;
    for (let i = 0; i < ranges.length; i++) ranges[i]!.value = String(c[i]);
    pickerSV?.(c); // keep the spectrum markers in step with hex/slider edits
  }

  // ---- spectrum (m07433 #1): SV field + hue strip, two-way with hex/RGB ----
  const svCanvas = document.createElement("canvas");
  svCanvas.className = "cp-sv";
  svCanvas.width = SV_W;
  svCanvas.height = SV_H;
  svCanvas.title = "Saturation and brightness \u2014 drag to pick";
  // X3: promoteTitles strips title=, and a canvas has no text, so without this
  // the picker had NO accessible name at all and could not be focused.
  svCanvas.tabIndex = 0;
  svCanvas.setAttribute("role", "slider");
  svCanvas.setAttribute("aria-label", "Saturation and brightness \u2014 drag or use the arrow keys");
  svCanvas.setAttribute("aria-valuemin", "0");
  svCanvas.setAttribute("aria-valuemax", "100");
  const hueCanvas = document.createElement("canvas");
  hueCanvas.className = "cp-hue";
  hueCanvas.width = SV_W;
  hueCanvas.height = HUE_H;
  hueCanvas.title = "Hue \u2014 drag to pick";
  hueCanvas.tabIndex = 0;
  hueCanvas.setAttribute("role", "slider");
  hueCanvas.setAttribute("aria-label", "Hue \u2014 drag or use the arrow keys");
  hueCanvas.setAttribute("aria-valuemin", "0");
  hueCanvas.setAttribute("aria-valuemax", "360");
  hueCanvas.setAttribute("aria-valuenow", "0");
  const svCtx = svCanvas.getContext("2d");
  const hueCtx = hueCanvas.getContext("2d");
  let curHsv = rgbToHsv(initial);
  const syncMarkers = (c: [number, number, number]): void => {
    curHsv = rgbToHsv(c);
    // A role=slider with no value is announced as "slider" and then silence
    // (uiux-r19 #5).
    svCanvas.setAttribute(
      "aria-valuetext",
      `Saturation ${Math.round(curHsv[1] * 100)}%, brightness ${Math.round(curHsv[2] * 100)}%`,
    );
    hueCanvas.setAttribute("aria-valuenow", String(Math.round(curHsv[0])));
    if (svCtx) {
      drawSvField(svCtx, curHsv[0]);
      const mx = Math.max(3, Math.min(SV_W - 3, curHsv[1] * (SV_W - 1)));
      const my = Math.max(3, Math.min(SV_H - 3, (1 - curHsv[2]) * (SV_H - 1)));
      svCtx.lineWidth = 1.5;
      svCtx.strokeStyle = "rgba(0,0,0,.6)";
      svCtx.beginPath();
      svCtx.arc(mx + 0.75, my + 0.75, 5.5, 0, Math.PI * 2);
      svCtx.stroke();
      svCtx.strokeStyle = "#fff";
      svCtx.beginPath();
      svCtx.arc(mx, my, 5, 0, Math.PI * 2);
      svCtx.stroke();
    }
    if (hueCtx) {
      drawHueStrip(hueCtx);
      const hx = Math.max(0, Math.min(SV_W - 2, (curHsv[0] / 360) * (SV_W - 1)));
      hueCtx.fillStyle = "#fff";
      hueCtx.fillRect(hx - 1.5, 0, 3, HUE_H);
      hueCtx.strokeStyle = "rgba(0,0,0,.6)";
      hueCtx.strokeRect(hx - 2, 0.5, 4, HUE_H - 1);
    }
  };
  pickerSV = syncMarkers;
  syncMarkers(initial);
  pop.insertBefore(svCanvas, hexRow);
  pop.insertBefore(hueCanvas, hexRow);

  const startFieldDrag = (el: HTMLElement, onMove: (ev: PointerEvent) => void): void => {
    el.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      onMove(ev);
      try { el.setPointerCapture(ev.pointerId); } catch { /* synthetic / untrusted events */ }
      const move = (e: PointerEvent): void => onMove(e);
      const up = (): void => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  };
  startFieldDrag(svCanvas, (ev) => {
    const r = svCanvas.getBoundingClientRect();
    if (!Number.isFinite(r.width) || r.width <= 0) return;
    curHsv[1] = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    curHsv[2] = 1 - Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
    commit(hsvToRgb(curHsv[0], curHsv[1], curHsv[2]));
  });
  startFieldDrag(hueCanvas, (ev) => {
    const r = hueCanvas.getBoundingClientRect();
    if (!Number.isFinite(r.width) || r.width <= 0) return;
    curHsv[0] = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 360;
    commit(hsvToRgb(curHsv[0], curHsv[1], curHsv[2]));
  });

  // Both canvases are role="slider" and say "use the arrow keys"; until now the
  // key did nothing here and reached the editor's nudge handler, moving the
  // layer behind the open popover (uiux-r18 #1). Left/Right change saturation,
  // Up/Down change brightness; the hue strip uses Left/Right, one degree per
  // step. Each consumes the key so the document never sees it.
  const clampU = (n: number): number => Math.max(0, Math.min(1, n));
  svCanvas.addEventListener("keydown", (ev: KeyboardEvent) => {
    const d = (ev.shiftKey ? 0.1 : 0.02) * (ev.key === "ArrowRight" || ev.key === "ArrowUp" ? 1 : ev.key === "ArrowLeft" || ev.key === "ArrowDown" ? -1 : 0);
    if (d === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") curHsv[1] = clampU(curHsv[1] + d);
    else curHsv[2] = clampU(curHsv[2] + d);
    commit(hsvToRgb(curHsv[0], curHsv[1], curHsv[2]));
  });
  hueCanvas.addEventListener("keydown", (ev: KeyboardEvent) => {
    const d = (ev.shiftKey ? 15 : 3) * (ev.key === "ArrowRight" || ev.key === "ArrowUp" ? 1 : ev.key === "ArrowLeft" || ev.key === "ArrowDown" ? -1 : 0);
    if (d === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    curHsv[0] = (curHsv[0] + d + 360) % 360;
    commit(hsvToRgb(curHsv[0], curHsv[1], curHsv[2]));
  });

  const buttons = document.createElement("div");
  buttons.className = "cp-buttons";
  const cancel = document.createElement("button");
  cancel.className = "btn subtle";
  cancel.textContent = "Cancel";
  const done = document.createElement("button");
  done.className = "btn primary";
  done.textContent = "Done";
  buttons.append(cancel, done);
  pop.appendChild(buttons);

  hexField.addEventListener("input", () => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hexField.value.trim());
    if (!m) return;
    const v = m[1]!;
    commit([parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]);
  });

  document.body.appendChild(pop);
  colorPop = pop;

  const rect = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 240;
  const h = pop.offsetHeight || 200;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.right + 8));
  const top = Math.max(8, Math.min(window.innerHeight - h - 8, rect.top - h - 6));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  const finish = (restore: boolean): void => {
    if (restore && colorPopBefore) commit(colorPopBefore);
    closeColorPop();
  };
  cancel.addEventListener("click", () => finish(true));
  done.addEventListener("click", () => finish(false));
  colorPopOutside = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (t && pop.contains(t)) return;
    if (t === anchor) return; // clicking the well again just re-opens
    finish(false);
  };
  document.addEventListener("pointerdown", colorPopOutside, true);
  colorPopKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      finish(true);
      return;
    }
    // Tab used to walk out of the popover into the page behind it; keep the
    // ring inside, the way a dialog does (uiux-r17 #6).
    if (e.key === "Tab" && colorPop) {
      const ring = Array.from(colorPop.querySelectorAll("button, input, select, canvas, [tabindex]"))
        .filter((el): el is HTMLElement => el instanceof HTMLElement && el.tabIndex >= 0);
      if (ring.length === 0) return;
      const at = ring.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? ring.length - 1 : at - 1) : (at + 1) % ring.length;
      e.preventDefault();
      e.stopPropagation();
      ring[next]!.focus();
    }
  };
  window.addEventListener("keydown", colorPopKey, true);
  hexField.focus();
  hexField.select();
}

const colorWell = document.createElement("button");
colorWell.type = "button";
colorWell.className = "color-well";
colorWell.title = "Foreground colour (brush + text) — click to pick";
colorWell.setAttribute("aria-label", "Foreground colour");
colorWell.style.background = `#${color.map(c => c.toString(16).padStart(2, "0")).join("")}`;
colorWell.addEventListener("click", () => openColorPicker(colorWell));
const colorRow = document.createElement("div");
colorRow.className = "color-well-row";
colorRow.appendChild(colorWell);
toolbar.appendChild(colorRow);
toolbar.appendChild(toolbarGrip);
applyToolbar();

// ---- tool options bar (contextual per active tool) ------------------------

/** labelled native colour well used by the shape options (fill + stroke) */
function optionColor(label: string, value: [number, number, number],
  oninput: (v: [number, number, number]) => void): HTMLLabelElement {
  const toHex = (c: [number, number, number]): string =>
    "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const wrap = document.createElement("label");
  wrap.className = "inline-row";
  wrap.style.gap = "5px";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.textContent = label;
  const inp = document.createElement("input");
  inp.type = "color";
  inp.value = toHex(value);
  inp.style.width = "34px";
  inp.addEventListener("input", () => {
    const m = /^#?([0-9a-f]{6})$/i.exec(inp.value);
    if (!m) return;
    const n = parseInt(m[1]!, 16);
    oninput([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  });
  wrap.append(lab, inp);
  return wrap;
}

function optionSlider(label: string, min: number, max: number, value: number,
  format: (v: number) => string, oninput: (v: number) => void,
  oncommit?: (v: number) => void,
  // A second writer (the Brush Settings panel) must move the bar's thumb, or
  // the bar shows a size the brush is not using.
  expose?: (api: { set: (v: number) => void }) => void): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "inline-row";
  wrap.style.gap = "5px";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.textContent = label;
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.value = String(value);
  range.style.width = "90px";
  range.setAttribute("aria-label", label);
  // A read-only readout could not be typed into, so exact sizes were unreachable.
  const num = document.createElement("input");
  num.type = "number";
  num.className = "num";
  num.min = String(min);
  num.max = String(max);
  num.step = max - min <= 1 ? "0.01" : "1";
  num.value = String(Math.round(value * 100) / 100);
  num.title = `${label} (${format(min)} – ${format(max)})`;
  // promoteTitles() removes title for data-tip, which left every spin button
  // unnamed; the range already names itself, the number must too (uiux-r33 #5).
  num.setAttribute("aria-label", `${label} (${format(min)} – ${format(max)})`);
  const clampV = (v: number): number => Math.max(min, Math.min(max, v));
  expose?.({
    set: (v: number): void => {
      const c = clampV(v);
      range.value = String(c);
      num.value = String(Math.round(c * 100) / 100);
    },
  });
  range.addEventListener("input", () => {
    const v = Number(range.value);
    num.value = String(Math.round(v * 100) / 100);
    oninput(v);
  });
  if (oncommit) range.addEventListener("change", () => oncommit(Number(range.value)));
  num.addEventListener("change", () => {
    const parsed = Number(num.value);
    if (!Number.isFinite(parsed)) { num.value = String(Math.round(Number(range.value) * 100) / 100); return; }
    const v = clampV(parsed);
    num.value = String(Math.round(v * 100) / 100);
    range.value = String(v);
    oninput(v);
    oncommit?.(v);
  });
  num.addEventListener("keydown", (ev) => {
    // arrows inside a number field must not nudge the layer underneath
    ev.stopPropagation();
    if (ev.key === "Enter") num.blur();
  });
  wrap.append(lab, range, num);
  return wrap;
}

/** gradient stop control: color picker + alpha slider; keeps a live working copy */
function optionCheck(label: string, checked: boolean, onchange: (v: boolean) => void): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "inline-row check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onchange(box.checked));
  const span = document.createElement("span");
  span.className = "label";
  span.textContent = label;
  wrap.append(box, span);
  return wrap;
}

function stopPicker(label: string, initial: GradColor, set: (c: GradColor) => void): HTMLDivElement {
  let cur: GradColor = { ...initial };
  const commit = () => set(cur);
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:4px";
  const lab = document.createElement("span");
  lab.textContent = label;
  lab.style.opacity = ".75";
  const pick = document.createElement("input");
  pick.type = "color";
  pick.value = `#${[cur.r, cur.g, cur.b].map(v => v.toString(16).padStart(2, "0")).join("")}`;
  pick.style.cssText = "width:26px;height:20px;border:1px solid #000;background:none;cursor:pointer;padding:0";
  pick.addEventListener("input", () => {
    cur = {
      ...cur,
      r: parseInt(pick.value.slice(1, 3), 16),
      g: parseInt(pick.value.slice(3, 5), 16),
      b: parseInt(pick.value.slice(5, 7), 16),
    };
    commit();
  });
  wrap.append(lab, pick);
  wrap.appendChild(optionSlider("A", 0, 100, Math.round((cur.a / 255) * 100), v => `${v}%`, v => {
    cur = { ...cur, a: Math.round((v / 100) * 255) };
    commit();
  }));
  return wrap;
}

function buildOptionsBase(): void {
  optionsBar.innerHTML = "";
  // D3 (uiux-r32): the page is chosen by fitOptionsPages; resetting it here
  // sent anyone on page 2 back to page 1 whenever a control rebuilt the bar.
  // the toolbar transform button shows an active state while a transform is live
  transformToolBtn.classList.toggle("active", !!transform);
  // Quick Mask and mask painting recolour the whole bar: the mode matters
  if (tool === "ruler") {
    buildRulerOptions(optionsBar, rulerMeasure(), () => {
      rulerA = null; rulerB = null; rulerDrag = false;
      refreshOptions(); drawOverlay();
    });
    return;
  }
  if (tool === "sampler") {
    // renderFlat() owns the freshness check; reading the cache's own geometry
    // keeps this shell function out of the coupling metric's document state.
    renderFlat();
    const image = { width: flatCache.width, height: flatCache.height, data: flatCache.buffer };
    buildSamplerOptions(optionsBar, image, samples, (rgb) => hex(rgb), () => {
      samples = [];
      refreshOptions();
      drawOverlay();
    });
    return;
  }
  if (tool === "count") {
    buildCountOptions(optionsBar, counts.length, () => {
      counts = [];
      refreshOptions();
      drawOverlay();
      statusHint("Counts cleared.");
    });
    return;
  }
  const build = optionBuilder(tool);
  if (build) { build(); return; }
  buildBrushOptions();
}

/**
 * Per-tool options-bar builders. A switch (not a const map) so that the
 * function declarations are hoisted: the bar is built during boot, before
 * any module-level map could be initialised (a const map here has already
 * produced a TDZ crash once).
 */
function optionBuilder(t: ToolId): (() => void) | null {
  switch (t) {
    case "move": return buildMoveOptions;
    case "wand": return buildWandOptions;
    case "shape": return buildShapeOptions;
    case "quick": return buildQuickOptions;
    case "bucket": return buildBucketOptions;
    case "magicerase": return buildMagicEraserOptions;
    case "bgerase": return buildBgEraseOptions;
    case "colourreplace": return buildColourReplaceOptions;
    case "patch": return () => buildPatchOptions(optionsBar);
    case "note": return () => buildNoteOptions(optionsBar, notes.length, () => { notes = []; refreshOptions(); drawOverlay(); statusHint("Notes cleared."); });
    case "magnet": return () => buildMagnetOptions(optionsBar, magnetRadius, (next) => { magnetRadius = next; });
    case "eyedropper": return buildEyedropperOptions;
    case "retouch": return buildRetouchOptions;
    case "clone": return buildCloneOptions;
    case "focus": return buildFocusOptions;
    case "heal": return buildHealOptions;
    case "crop": return buildCropOptions;
    case "marquee": return buildSelectOptions;
    case "polylasso": return buildSelectOptions;
    case "ellipse": return buildSelectOptions;
    case "lasso": return buildSelectOptions;
    case "pen": return buildSelectOptions;
    case "gradient": return buildGradientOptions;
    case "text": return buildTextOptions;
    case "brush": return buildBrushOptions;
    case "eraser": return buildBrushOptions;
    case "pencil": return buildBrushOptions;
    case "patternstamp": return buildPatternOptions;
    case "mixer": return buildMixerOptions;
    default: return null;
  }
}

function buildMoveOptions(): void {
  const hint = document.createElement("span");
  hint.textContent = selMask || selRect
    ? "Drag to move the selection's pixels · arrows nudge (Shift = 10px)"
    : "Drag to move the active layer · arrows nudge (Shift = 10px)";
  hint.className = "label";
  optionsBar.appendChild(hint);
}

function buildWandOptions(): void {
  optionsBar.appendChild(optionSlider("Tolerance", 0, 255, wandTolerance, (v) => String(v), (v) => { wandTolerance = v; }));
  optionsBar.appendChild(optionCheck("Contiguous", wandContiguous, (v) => { wandContiguous = v; }));
  const whint = document.createElement("span");
  whint.className = "label";
  whint.textContent = "Click to select similar pixels · Shift-click adds · Alt-click subtracts";
  optionsBar.appendChild(whint);
}

function buildShapeOptions(): void {
  const kindSel = document.createElement("select");
  kindSel.setAttribute("aria-label", "Shape type");
  for (const k of ["rectangle", "rounded", "ellipse", "line", "polygon", "star"] as ShapeKind[]) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k === "rounded" ? "Rounded Rectangle" : k.charAt(0).toUpperCase() + k.slice(1);
    if (k === shapeKind) o.selected = true;
    kindSel.appendChild(o);
  }
  kindSel.addEventListener("change", () => {
    shapeKind = kindSel.value as ShapeKind;
    refreshOptions();
    drawOverlay();
    // The rebuild replaces this select, so arrow keys would drop focus to the
    // body after the first change (ui13-r3). Put it back on the new one.
    const walk = (n: Element): Element[] => {
      const out: Element[] = [];
      for (const c of Array.from(n.children)) out.push(c, ...walk(c));
      return out;
    };
    (walk(optionsBar).find((c) => c.tagName === "SELECT") as HTMLElement | undefined)?.focus();
  });
  optionsBar.appendChild(kindSel);
  if (shapeKind === "polygon" || shapeKind === "star") {
    optionsBar.appendChild(optionSlider("Sides", 3, 24, shapeSides, (v) => String(v), (v) => { shapeSides = v; drawOverlay(); }));
  }
  if (shapeKind === "rounded") {
    optionsBar.appendChild(optionSlider("Radius", 0, 200, shapeRadius, (v) => `${v} px`, (v) => { shapeRadius = v; drawOverlay(); }));
  }
  optionsBar.appendChild(optionColor("Fill", shapeFill ?? [color[0], color[1], color[2]], (v) => { shapeFill = v; drawOverlay(); }));
  const strokeSwatch = optionColor("Stroke", shapeStroke ?? [bgColor[0], bgColor[1], bgColor[2]], (v) => { shapeStroke = v; drawOverlay(); });
  // At width 0 there is no stroke, so the swatch must not look like a control
  // that changes anything (uiux-r7 low). The width slider changes availability,
  // so the state is a function rather than a build-time snapshot (uiux-r33 #4).
  const syncStrokeSwatch = (): void => {
    const off = shapeStrokeW <= 0;
    strokeSwatch.classList.toggle("off", off);
    if (off) strokeSwatch.setAttribute("aria-disabled", "true");
    else strokeSwatch.removeAttribute("aria-disabled");
    const inp = strokeSwatch.querySelector("input");
    if (inp) inp.disabled = off;
  };
  syncStrokeSwatch();
  optionsBar.appendChild(strokeSwatch);
  optionsBar.appendChild(optionSlider("Stroke w", 0, 40, shapeStrokeW, (v) => (v === 0 ? "none" : `${v} px`), (v) => { shapeStrokeW = v; syncStrokeSwatch(); drawOverlay(); }));
  const shint = document.createElement("span");
  shint.className = "label";
  shint.textContent = "Drag to draw · Alt-drag makes a selection instead of pixels";
  optionsBar.appendChild(shint);
}

function buildPatternOptions(): void {
  optionsBar.appendChild(brushSettingsButton());
  const kind = document.createElement("select");
  kind.setAttribute("aria-label", "Pattern");
  for (const k of ["checker", "stripes", "dots"] as FillPatternKind[]) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k.charAt(0).toUpperCase() + k.slice(1);
    if (k === patternKind) o.selected = true;
    kind.appendChild(o);
  }
  kind.addEventListener("change", () => { patternKind = kind.value as FillPatternKind; drawOverlay(); });
  optionsBar.appendChild(kind);
  optionsBar.appendChild(optionSlider("Tile", 8, 128, patternTile, (v) => `${v} px`, (v) => { patternTile = v; }));
  optionsBar.appendChild(optionSlider("Scale", 25, 400, Math.round(patternScaleVal * 100), (v) => `${v}%`, (v) => { patternScaleVal = v / 100; }));
}

function buildMixerOptions(): void {
  optionsBar.appendChild(brushSettingsButton());
  optionsBar.appendChild(optionSlider("Wet", 0, 100, mixerWet, (v) => `${v}%`, (v) => { mixerWet = v; }));
  const hint = document.createElement("span");
  hint.className = "label";
  hint.textContent = "Wet mixes the bar colour into the layer; 100% paints the bar colour alone";
  optionsBar.appendChild(hint);
}

function buildQuickOptions(): void {
  optionsBar.appendChild(optionSlider("Tolerance", 0, 255, quickTolerance, (v) => String(v), (v) => {
    quickTolerance = v;
    quickRegion = null;
    quickApplied = null;
  }));
  const qhint = document.createElement("span");
  qhint.className = "label";
  qhint.textContent = "Paint to select similar pixels · keep painting to grow the selection";
  optionsBar.appendChild(qhint);
}

/** Background Eraser options: the brush controls it actually uses, plus the
 *  one number that is its own (how close a colour has to be). */
function buildBgEraseOptions(): void {
  optionsBar.appendChild(optionSlider("Size", 1, 500, brushSize, (v) => `${v} px`, (v) => { brushSize = v; drawBrushRing(); }));
  optionsBar.appendChild(optionSlider("Tolerance", 0, 255, bgTolerance, (v) => String(v), (v) => { bgTolerance = v; }));
  optionsBar.appendChild(optionSlider("Hardness", 0, 100, Math.round(brushHardness * 100), (v) => `${v}%`, (v) => { brushHardness = v / 100; }));
  const hint = document.createElement("span");
  hint.className = "label";
  hint.textContent = "Drag to erase the colour you started on · Shift+E cycles to Magic Eraser";
  optionsBar.appendChild(hint);
}

function buildColourReplaceOptions(): void {
  optionsBar.appendChild(optionSlider("Size", 1, 500, brushSize, (v) => `${v} px`, (v) => { brushSize = v; drawBrushRing(); }));
  optionsBar.appendChild(optionSlider("Tolerance", 0, 255, colourTolerance, (v) => String(v), (v) => { colourTolerance = v; }));
  optionsBar.appendChild(optionSlider("Hardness", 0, 100, Math.round(brushHardness * 100), (v) => `${v}%`, (v) => { brushHardness = v / 100; }));
  const hint = document.createElement("span");
  hint.className = "label";
  hint.textContent = "Drag over the colour to replace · the foreground colour is painted in its place";
  optionsBar.appendChild(hint);
}

function buildMagicEraserOptions(): void {
  optionsBar.appendChild(optionSlider("Tolerance", 0, 255, bucketTolerance, (v) => String(v), (v) => { bucketTolerance = v; }));
  const hint = document.createElement("span");
  hint.className = "label";
  hint.textContent = "Click a colour to erase it; the current selection limits the area";
  optionsBar.appendChild(hint);
}

function buildBucketOptions(): void {
  optionsBar.appendChild(optionSlider("Tolerance", 0, 255, bucketTolerance, (v) => String(v), (v) => { bucketTolerance = v; }));
  optionsBar.appendChild(optionSlider("Opacity", 1, 100, Math.round(bucketOpacity * 100), (v) => `${v}%`, (v) => { bucketOpacity = v / 100; }));
  optionsBar.appendChild(optionCheck("Contiguous", bucketContiguous, (v) => { bucketContiguous = v; }));
  const bhint = document.createElement("span");
  bhint.className = "label";
  bhint.textContent = "Click to fill with the foreground colour";
  optionsBar.appendChild(bhint);
}

function buildEyedropperOptions(): void {
  const sizeSel = document.createElement("select");
  sizeSel.setAttribute("aria-label", "Sample size");
  for (const n of [1, 3, 5, 11]) {
    const o = document.createElement("option");
    o.value = String(n); o.textContent = `${n} by ${n} average`;
    sizeSel.appendChild(o);
  }
  sizeSel.value = String(eyeSize);
  sizeSel.addEventListener("change", () => { eyeSize = Number(sizeSel.value); });
  optionsBar.appendChild(sizeSel);
  const ehint = document.createElement("span");
  ehint.className = "label";
  ehint.textContent = "Click to sample the merged image";
  optionsBar.appendChild(ehint);
}

function buildRetouchOptions(): void {
  const modeSel = document.createElement("select");
  modeSel.setAttribute("aria-label", "Retouch mode");
  for (const [v, label] of [["dodge", "Dodge"], ["burn", "Burn"], ["sponge", "Sponge"], ["redEye", "Red Eye"]] as const) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    modeSel.appendChild(o);
  }
  modeSel.value = retouchMode;
  modeSel.addEventListener("change", () => {
    retouchMode = modeSel.value as typeof retouchMode;
    refreshOptions();
  });
  optionsBar.appendChild(modeSel);
  if (retouchMode === "dodge" || retouchMode === "burn") {
    const rangeSel = document.createElement("select");
    rangeSel.setAttribute("aria-label", "Tonal range");
    for (const [v, label] of [["shadows", "Shadows"], ["midtones", "Midtones"], ["highlights", "Highlights"]] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      rangeSel.appendChild(o);
    }
    rangeSel.value = retouchRange;
    rangeSel.addEventListener("change", () => { retouchRange = rangeSel.value as typeof retouchRange; });
    optionsBar.appendChild(rangeSel);
  }
  if (retouchMode === "sponge") {
    const spSel = document.createElement("select");
    spSel.setAttribute("aria-label", "Sponge mode");
    for (const [v, label] of [["saturate", "Saturate"], ["desaturate", "Desaturate"]] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      spSel.appendChild(o);
    }
    spSel.value = spongeMode;
    spSel.addEventListener("change", () => { spongeMode = spSel.value as typeof spongeMode; });
    optionsBar.appendChild(spSel);
    optionsBar.appendChild(optionCheck("Vibrance", retouchVibrance, (v) => { retouchVibrance = v; }));
  }
  optionsBar.appendChild(optionSlider("Strength", 1, 100, Math.round(retouchStrength * 100), (v) => `${v}%`, (v) => { retouchStrength = v / 100; }));
  optionsBar.appendChild(optionSlider("Size", 1, 300, brushSize, (v) => `${v}px`, (v) => { brushSize = v; }));
}

function buildCloneOptions(): void {
  const chint = document.createElement("span");
  chint.className = "label";
  chint.textContent = cloneSrc
    ? "Alt-click to re-sample · drag to clone"
    : "Alt-click to set the clone source first";
  optionsBar.appendChild(chint);
  optionsBar.appendChild(optionSlider("Size", 1, 300, brushSize, (v) => `${v}px`, (v) => { brushSize = v; }));
  optionsBar.appendChild(optionSlider("Opacity", 1, 100, Math.round(cloneAlpha * 100), (v) => `${v}%`, (v) => { cloneAlpha = v / 100; }));
  optionsBar.appendChild(optionCheck("Aligned", cloneAligned, (v) => { cloneAligned = v; if (!v) cloneOffset = null; }));
}

function buildFocusOptions(): void {
  const fSel = document.createElement("select");
  fSel.setAttribute("aria-label", "Focus mode");
  for (const [v, label] of [["blur", "Blur"], ["sharpen", "Sharpen"], ["smudge", "Smudge"]] as const) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    fSel.appendChild(o);
  }
  fSel.value = focusMode;
  fSel.addEventListener("change", () => { focusMode = fSel.value as typeof focusMode; });
  optionsBar.appendChild(fSel);
  optionsBar.appendChild(optionSlider("Strength", 1, 100, Math.round(focusStrength * 100), (v) => `${v}%`, (v) => { focusStrength = v / 100; }));
  optionsBar.appendChild(optionSlider("Size", 1, 300, brushSize, (v) => `${v}px`, (v) => { brushSize = v; }));
}

function buildHealOptions(): void {
  const hh = document.createElement("span");
  hh.className = "label";
  hh.textContent = "Paint over the blemish — the area is rebuilt from its surroundings · J";
  optionsBar.appendChild(hh);
  optionsBar.appendChild(optionSlider("Size", 1, 300, brushSize, (v) => `${v}px`, (v) => { brushSize = v; }));
  optionsBar.appendChild(optionSlider("Hardness", 0, 100, Math.round(brushHardness * 100), (v) => `${v}%`, (v) => { brushHardness = v / 100; }));
}

function buildCropOptions(): void {
  const hint = document.createElement("span");
  hint.textContent = cropQuad
    ? `Perspective crop ${quadSize(cropQuad).w} × ${quadSize(cropQuad).h} · drag corners · Enter applies · Esc cancels`
    : cropRect
      ? `Crop to ${cropRect.w} × ${cropRect.h} · Enter applies · Esc cancels`
      : "Drag a crop rectangle · Enter applies · Esc cancels";
  hint.className = "label";
  optionsBar.appendChild(hint);
  if (cropQuad) {
    const ok = document.createElement("button");
    ok.className = "btn primary";
    ok.textContent = "Apply perspective crop";
    ok.addEventListener("click", applyPerspectiveNow);
    const no = document.createElement("button");
    no.className = "btn subtle";
    no.textContent = "Cancel";
    no.addEventListener("click", cancelPerspective);
    optionsBar.append(ok, no);
    return;
  }
  const persp = document.createElement("button");
  persp.className = "btn subtle";
  persp.textContent = "Perspective…";
  persp.title = "Correct perspective: drag the four corners, then Enter";
  persp.addEventListener("click", startPerspective);
  optionsBar.appendChild(persp);
  if (cropRect) {
    const ok = document.createElement("button");
    ok.className = "btn primary";
    ok.textContent = "Apply crop";
    ok.addEventListener("click", applyCropNow);
    const no = document.createElement("button");
    no.className = "btn subtle";
    no.textContent = "Cancel";
    no.addEventListener("click", () => { cancelCrop(); refreshOptions(); });
    optionsBar.append(ok, no);
  }
}

function buildSelectOptions(): void {
  if (tool === "pen") {
    const ffBox = optionCheck("Freeform", freeformPen, (v) => {
      freeformPen = v;
      statusHint(v ? "Freeform: drag a path; release closes it into a selection." : "Pen: click to place anchors, Enter closes the path.");
    });
    ffBox.title = "Drag a freehand path that closes into a selection on release";
    optionsBar.appendChild(ffBox);
  }
  if (tool === "marquee") {
    const shapeSel = document.createElement("select");
    shapeSel.setAttribute("aria-label", "Marquee shape");
    shapeSel.id = "marquee-shape";
    const shapes: [typeof marqueeShape, string][] = [
      ["rect", "Rectangle"],
      ["row", "Single Row"],
      ["col", "Single Column"],
    ];
    for (const [v, label] of shapes) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      if (v === marqueeShape) o.selected = true;
      shapeSel.appendChild(o);
    }
    shapeSel.addEventListener("change", () => {
      marqueeShape = shapeSel.value as typeof marqueeShape;
      if (selRect || selMask) {
        const before = snapshotSelection();
        selRect = null;
        selMask = null;
        selGeom = null;
        pushHist(selectionCommand("Marquee shape", before));
      } else {
        selGeom = null;
      }
      stopAnts();
      drawOverlay();
      statusHint(
        marqueeShape === "rect"
          ? "Rectangle marquee — drag a box"
          : marqueeShape === "row"
            ? "Single row marquee — click a spot; the whole row width is selected"
            : "Single column marquee — click a spot; the whole column height is selected",
      );
    });
    optionsBar.appendChild(shapeSel);
  }
  const hint = document.createElement("span");
  // A marquee-shape choice belongs to the marquee tool. Reading it from every
  // selection tool told Ellipse/Lasso/Pen users to click for a "one-pixel
  // strip" that those tools cannot make (uiux-r7 low).
  hint.textContent =
    tool === "polylasso"
      ? "Click to add points · click the first point or double-click to close · Backspace removes the last point · Enter closes · Esc cancels"
      : tool === "marquee"
        ? marqueeShape === "rect"
          ? "Drag to select · click to deselect · Ctrl+D deselect · Del clears selection"
          : "Click to select a one-pixel strip across the whole canvas · Esc cancels"
        : tool === "ellipse"
          ? "Drag to select an ellipse · Shift constrains it to a circle · Esc cancels"
          : tool === "lasso"
          ? "Drag a freehand outline · release to close it · Esc cancels"
          : "Click to add an anchor · Enter closes the path into a selection · Esc cancels";
  hint.className = "label";
  optionsBar.appendChild(hint);
}

function buildGradientOptions(): void {
  const hint = document.createElement("span");
  hint.textContent = "Drag to set the axis · fills the selection or the whole layer";
  hint.className = "label";
  optionsBar.appendChild(hint);
  const kindSel = document.createElement("select");
  for (const k of ["linear", "radial"] as const) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k === "linear" ? "Linear" : "Radial";
    if (k === gradKind) o.selected = true;
    kindSel.appendChild(o);
  }
  kindSel.addEventListener("change", () => { gradKind = kindSel.value as "linear" | "radial"; });
  
  optionsBar.appendChild(kindSel);
  optionsBar.appendChild(stopPicker("From", gradFrom, c => { gradFrom = c; }));
  optionsBar.appendChild(stopPicker("To", gradTo, c => { gradTo = c; }));
}

function buildTextOptions(): void {
  const hint = document.createElement("span");
  hint.textContent = "Click for a text box · click existing text to re-edit it · drag ✥ to move · Shift+Enter = new line · select text, then B/I/U/S or font to style just that part · Enter commits";
  hint.className = "label";
  optionsBar.appendChild(hint);
  const fontSel = document.createElement("select");
  fontSel.setAttribute("aria-label", "Font");
  const allFonts = [...loadedFonts, ...BUILTIN_FONT_FAMILIES];
  for (const f of allFonts) {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    if (f === textFont) o.selected = true;
    fontSel.appendChild(o);
  }
  const loadOpt = document.createElement("option");
  loadOpt.value = "__load__";
  loadOpt.textContent = "Load font…";
  fontSel.appendChild(loadOpt);
  
  fontSel.addEventListener("change", async () => {
    if (fontSel.value === "__load__") {
      const file = await askFile(".ttf,.otf,.woff,.woff2");
      if (!file) { fontSel.value = textFont; return; } // cancelled → keep current
      try {
        const name = file.name.replace(/\.[^.]+$/, "");
        const face = new FontFace(name, await file.arrayBuffer());
        await face.load();
        (document.fonts as unknown as { add(f: FontFace): void }).add(face); // TS DOM lib lacks FontFaceSet.add
        const family = face.family || name;
        if (!loadedFonts.includes(family)) loadedFonts.unshift(family);
        textFont = family;
      } catch (err) {
        console.error(err);
        fontSel.value = textFont;
        return;
      }
      refreshOptions(); // rebuild the select with the new font listed
      restyleTextEditor();
      return;
    }
    if (!applyRich("fontName", fontSel.value)) textFont = fontSel.value;
    restyleTextEditor();
  });
  optionsBar.appendChild(fontSel);
  // toggles: with a text selection inside the box they style ONLY that portion
  // (native execCommand); otherwise they set the style for new typing.
  const toggleBtn = (label: string, active: boolean, css: string, onToggle: () => void, name: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "btn icon" + (active ? " primary" : " subtle");
    b.textContent = label;
    // "B button" tells a screen reader nothing about the style or its state.
    b.setAttribute("aria-label", name);
    b.setAttribute("aria-pressed", active ? "true" : "false");
    b.style.cssText = `width:26px;height:24px;${css};`;
    // keep the caret/selection in the text box when clicking the button
    b.addEventListener("mousedown", ev => ev.preventDefault());
    b.addEventListener("click", onToggle);
    return b;
  };
  optionsBar.appendChild(toggleBtn("B", textBold, "font-weight:bold", () => {
    if (!applyRich("bold")) textBold = !textBold;
    refreshOptions(); restyleTextEditor();
  }, "Bold"));
  optionsBar.appendChild(toggleBtn("I", textItalic, "font-style:italic", () => {
    if (!applyRich("italic")) textItalic = !textItalic;
    refreshOptions(); restyleTextEditor();
  }, "Italic"));
  optionsBar.appendChild(toggleBtn("U", textUnderline, "text-decoration:underline", () => {
    if (!applyRich("underline")) textUnderline = !textUnderline;
    refreshOptions(); restyleTextEditor();
  }, "Underline"));
  optionsBar.appendChild(toggleBtn("S", textStrike, "text-decoration:line-through", () => {
    if (!applyRich("strikeThrough")) textStrike = !textStrike;
    refreshOptions(); restyleTextEditor();
  }, "Strikethrough"));
  // paragraph alignment: applies to the whole box (Photoshop paragraph controls)
  const alignDefs: [TextAlign, IconName, string][] = [
    ["left", "align-left", "Align left"],
    ["center", "align-center", "Align centre"],
    ["right", "align-right", "Align right"],
    ["justify", "align-justify", "Justify"],
  ];
  for (const [mode, icon, title] of alignDefs) {
    const b = document.createElement("button");
    const on = textAlign === mode;
    b.className = "btn icon" + (on ? " primary" : " subtle");
    b.innerHTML = iconSvg(icon, 15);
    b.title = title;
    b.setAttribute("aria-label", `${title}${on ? " (active)" : ""}`);
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("pointerdown", ev => ev.preventDefault()); // keep the caret in the box
    b.addEventListener("click", () => {
      textAlign = mode;
      restyleTextEditor();
      if (textTarget && textTarget.textData) alignTextLayer(textTarget, mode);
      else if (textSel && textSel.textData) alignTextLayer(textSel, mode);
      refreshOptions();
      drawOverlay();
    });
    optionsBar.appendChild(b);
  }
  optionsBar.appendChild(optionSlider(
    "Size", 8, 200, textSize, v => `${v}px`,
    v => { textSize = v; restyleTextEditor(); },
    v => { if (applyRunSize(v)) restyleTextEditor(); },
  ));
  // A text layer can hold more than one size or colour. With characters selected
  // these controls style the selection; with a bare caret they set the default.
  const runColour = document.createElement("button");
  runColour.className = "btn icon color-swatch";
  runColour.title = "Text colour (selection or whole box)";
  runColour.setAttribute("aria-label", `Text colour rgb(${color[0]}, ${color[1]}, ${color[2]})`);
  runColour.style.cssText = `width:26px;height:24px;background:rgb(${color[0]},${color[1]},${color[2]});`;
  runColour.addEventListener("mousedown", ev => ev.preventDefault()); // keep the run selected
  runColour.addEventListener("click", () => {
    openColorPicker(runColour, {
      get: () => color,
      set: (c) => {
        if (!applyRunColour(c)) { color[0] = c[0]; color[1] = c[1]; color[2] = c[2]; restyleTextEditor(); }
        runColour.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
        runColour.setAttribute("aria-label", `Text colour rgb(${c[0]}, ${c[1]}, ${c[2]})`);
      },
    });
  });
  optionsBar.appendChild(runColour);
}

// The Brush Settings entry point. Every bar whose stroke reads the recipe
// (brush, pattern stamp, mixer) has to offer it, or the same controls are
// live on one tool and unreachable on another (uiux-r5).
function brushSettingsButton(): HTMLButtonElement {
const bsBtn = document.createElement("button");
bsBtn.type = "button";
bsBtn.className = "btn";
bsBtn.dataset.brushSettings = "1";
bsBtn.title = "Brush Settings — scattering, shape dynamics, texture, transfer";
bsBtn.setAttribute("aria-label", "Brush Settings");
bsBtn.textContent = "Brush Settings";
bsBtn.addEventListener("click", () => {
  if (brushPanel) { brushPanel.focus(); return; }
  // The bar owns size/hardness/smoothing; mirror them in so the panel opens
  // showing what a stroke is actually using.
  brushSettings.tip.size = brushSize;
  brushSettings.tip.hardness = Math.round(brushHardness * 100);
  brushSettings.smoothing = brushSmooth;
  brushPanel = openBrushSettingsPanel(
    { foreground: () => color, background: () => bgColor, note: statusHint },
    brushSettings,
    (next: BrushSettings) => {
    // Live: no OK, because the next dab on the canvas is the confirmation.
    brushSettings = next;
    saveBrushSettings(brushSettings);
    brushSize = Math.round(next.tip.size);
    brushHardness = Math.max(0, Math.min(1, next.tip.hardness / 100));
    brushSmooth = next.smoothing;
    setBarSize(brushSize);
    setBarHardness(Math.round(brushHardness * 100));
    setBarSmooth(brushSmooth);
    setBarScatter(next.scattering.scatter);
  }, () => {
    brushPanel = null;
    if (bsBtn.isConnected) bsBtn.focus();
  }, tool);
});
return bsBtn;
}

function buildBrushOptions(): void {
optionsBar.appendChild(brushSettingsButton());
const tipSel = document.createElement("select");
for (const [val, label] of [
  ["round", "Soft round"], ["square", "Square"], ["chalk", "Chalk"],
  ["spray", "Spray"], ["custom", "Custom…"],
] as const) {
  const o = document.createElement("option");
  o.value = val;
  o.textContent = label;
  if (val === tipName) o.selected = true;
  tipSel.appendChild(o);
}

tipSel.addEventListener("change", async () => {
  const v = tipSel.value;
  if (v === "round") {
    activeTip = null;
  } else if (v === "custom") {
    if (!customTip) {
      const file = await askFile("image/png,image/jpeg");
      if (!file) { // cancelled → back to the previous tip
        tipSel.value = tipName; return;
      }
      try {
        customTip = await fileToTip(file);
      } catch (err) {
        console.error(err);
        tipSel.value = tipName;
        return;
      }
    }
    activeTip = customTip;
  } else {
    activeTip = BUILTIN_TIPS[v]?.() ?? null;
  }
  tipName = tipSel.value;
});
optionsBar.appendChild(tipSel);
optionsBar.appendChild(optionSlider("Size", 1, 300, brushSize, v => `${v}px`, v => { brushSize = v; },
  undefined, (api) => { setBarSize = api.set; }));
// The pencil draws a binary rim (paint.ts short-circuits `hard`), so a
// Hardness slider would be a control that changes nothing (uiux-r5).
if (tool !== "pencil") {
  optionsBar.appendChild(optionSlider("Hardness", 0, 100, Math.round(brushHardness * 100), v => `${v}%`, v => { brushHardness = v / 100; },
    undefined, (api) => { setBarHardness = api.set; }));
}
optionsBar.appendChild(optionSlider("Opacity", 1, 100, Math.round(brushOpacity * 100), v => `${v}%`, v => { brushOpacity = v / 100; }));
optionsBar.appendChild(optionSlider("Flow", 1, 100, Math.round(brushFlow * 100), v => `${v}%`, v => { brushFlow = v / 100; }));
optionsBar.appendChild(optionSlider("Smooth", 0, 90, brushSettings.smoothing, v => `${v}%`, v => {
  brushSmooth = v;
  brushSettings.smoothing = v;
  saveBrushSettings(brushSettings);
}, undefined, (api) => { setBarSmooth = api.set; }));
// Scatter stays on the bar because it is the one dynamics setting that gets
// changed mid-stroke; it is the same number the dialog shows.
if (tool !== "pencil") optionsBar.appendChild(optionSlider("Scatter", 0, 100, brushSettings.scattering.scatter, v => `${v}%`, v => {
  brushSettings.scattering.scatter = v;
  brushSettings.scattering.on = v > 0;
  saveBrushSettings(brushSettings);
}, undefined, (api) => { setBarScatter = api.set; }));
// Airbrush: hold still and keep depositing (the timer lives in ui/airbrush.ts).
// A toggle, not a slider: the deposit rate is derived from Flow, so a second
// number would only be a second thing to tune before the first one is learned.
const airBtn = document.createElement("button");
airBtn.type = "button";
airBtn.className = "btn";
airBtn.dataset.airbrush = "1";
airBtn.title = "Airbrush — keep depositing while the pointer rests";
airBtn.setAttribute("aria-label", "Airbrush");
airBtn.setAttribute("aria-pressed", String(airbrushOn));
airBtn.textContent = "Airbrush";
const syncAir = (): void => {
  airBtn.setAttribute("aria-pressed", String(airbrushOn));
  airBtn.classList.toggle("on", airbrushOn);
};
airBtn.addEventListener("click", () => {
  airbrushOn = !airbrushOn;
  if (!airbrushOn) airbrush.stop();
  syncAir();
});
syncAir();
optionsBar.appendChild(airBtn);

// Pressure response: three knots per attribute, edited in a small dialog.
const presBtn = document.createElement("button");
presBtn.type = "button";
presBtn.className = "btn icon";
presBtn.dataset.pressure = "1";
presBtn.title = "Pressure curve — how stylus pressure drives size, opacity and flow";
presBtn.setAttribute("aria-label", "Pressure curve");
presBtn.textContent = "Pressure";
presBtn.addEventListener("click", () => {
  openPressureDialog({ showModal }, pressureSettings, (next) => {
    pressureSettings.size = next.size;
    pressureSettings.opacity = next.opacity;
    pressureSettings.flow = next.flow;
    savePressureSettings(pressureSettings);
    notify("Pressure curves saved", "Size, opacity and flow now follow the curves you drew.");
  });
});
optionsBar.appendChild(presBtn);


// second tip (dual brush): its alpha multiplies the dab, so the stroke breaks
// up where the second tip is dark. None means the plain disc.
const dualSel = document.createElement("select");
dualSel.setAttribute("aria-label", "Second tip");
for (const [val, label] of [
  ["none", "Second tip: none"], ["chalk", "Second tip: chalk"],
  ["spray", "Second tip: spray"], ["square", "Second tip: square"],
] as const) {
  const o = document.createElement("option");
  o.value = val;
  o.textContent = label;
  if (val === dualTipName) o.selected = true;
  dualSel.appendChild(o);
}
dualSel.addEventListener("change", () => {
  dualTipName = dualSel.value;
  dualTip = dualTipName === "none" ? null : (BUILTIN_TIPS[dualTipName]?.() ?? null);
});
optionsBar.appendChild(dualSel);
optionsBar.appendChild(optionSlider("Second size", 10, 100, Math.round(dualScale * 100), v => `${v}%`, v => { dualScale = v / 100; }));
}

/**
 * Move the tool's long guidance text into a single "?" button at the end of
 * the options bar. Runs after the tool's own controls are built and before the
 * bar is paged, so the button is always the last item and never gets paged away.
 */
function finalizeOptionsBar(): void {
  // Mask and quick-mask modes used to return here on the assumption of a
  // banner no code built, so the caption and "?" vanished (uiux-r16 #6).
  const editingMask = quickMask || (paintTarget === "mask" && !!activeLayer?.mask);
  const hints: string[] = [];
  for (const kid of Array.from(optionsBar.children)) {
    if (!kid.classList.contains("label")) continue;
    const text = (kid.textContent ?? "").trim();
    if (text) hints.push(text);
    kid.remove();
  }
  const guide = TOOL_GUIDE[tool] ?? "";
  if (editingMask) hints.unshift(quickMask ? "Editing: Quick Mask" : "Editing: Layer Mask — paint to hide, Alt-paint to reveal");
  const extra = hints.filter(h => h && !guide.includes(h));

  // AD5: a caption stays on screen. The bar used to file every explanation into
  // a toast that vanished after 2.6 s, so a tool's controls were undocumented
  // the moment you started reading. The chip is the first sentence of the
  // guide; the full text lives behind "?" in a panel that stays until dismissed.
  const caption = document.createElement("span");
  caption.className = "opt-cap";
  caption.textContent = shortCaption(guide || extra[0] || "");
  caption.title = guide;
  optionsBar.appendChild(caption);

  const help = document.createElement("button");
  help.className = "btn icon subtle opt-help";
  help.type = "button";
  help.innerHTML = iconSvg("help", 15);
  help.title = "Tool help";
  help.dataset.tip = "Tool help";
  help.setAttribute("aria-label", "Tool help");
  help.setAttribute("aria-expanded", "false");
  help.setAttribute("aria-controls", "help-panel");
  help.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleHelpPanel(help, guide, extra);
  });
  optionsBar.appendChild(help);
}

/** First sentence of a guide string, capped so it fits one line. */
function shortCaption(guide: string): string {
  const first = guide.split(/(?<=[.!?])\s/)[0] ?? guide;
  const cut = first.length > 78 ? first.slice(0, 75).replace(/[ ,;:]+$/, "") + "…" : first;
  return cut;
}

let helpAnchor: HTMLElement | null = null;
/** The capture listener the popover installs; it must leave with the popover,
 *  or the next one closes on its own first click (uiux-r14 #4). */
let helpDocDown: ((ev: PointerEvent) => void) | null = null;
function closeHelpPanel(returnFocus = false): void {
  if (!helpPanel) return;
  if (helpDocDown) {
    document.removeEventListener("pointerdown", helpDocDown, true);
    helpDocDown = null;
  }
  const anchor = helpAnchor;
  // The panel can own focus. Removing it then drops focus to <body>, where the
  // next Delete erases the selection and arrows nudge the layer (code-r25 #2).
  const owned = helpPanel.contains(document.activeElement);
  helpPanel.remove();
  helpPanel = null;
  helpAnchor = null;
  anchor?.setAttribute("aria-expanded", "false");
  if (returnFocus || owned) {
    const back = anchor?.isConnected ? anchor : display;
    back.focus();
    if (document.activeElement !== back) display.focus();
  }
}

/** AD5: the "?" guidance, anchored under the button until dismissed. */
function toggleHelpPanel(anchor: HTMLElement, guide: string, hints: string[]): void {
  if (helpPanel) { closeHelpPanel(); return; }
  const pop = document.createElement("div");
  pop.className = "menu-pop help-pop";
  pop.setAttribute("role", "dialog");
  pop.id = "help-panel";
  pop.tabIndex = -1;
  // Tab inside a non-modal popover must leave it, not toggle the chrome behind
  // it (uiux-r25 #4). Returning focus to the anchor keeps the next Tab moving
  // through the bar.
  pop.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    ev.preventDefault();
    ev.stopPropagation();
    closeHelpPanel(true);
  });
  const head = document.createElement("div");
  head.className = "menu-head";
  head.id = "help-panel-title";
  pop.setAttribute("aria-labelledby", head.id);
  head.textContent = `${TOOL_LABELS[tool] ?? "Tool"} help`;
  pop.appendChild(head);
  const lines = [guide, ...hints].filter(Boolean);
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = "help-line";
    row.textContent = line;
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  // A dialog that nothing can enter is silent: the panel is the only
  // documentation most tools have (finalizeOptionsBar files every hint here),
  // so it takes focus when it opens (uiux-r24 #4). Escape returns it to the
  // anchor in closeHelpPanel.
  pop.focus();
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.right - 300, window.innerWidth - 316))}px`;
  pop.style.top = `${Math.min(window.innerHeight - 40, r.bottom + 6)}px`;
  helpPanel = pop;
  helpAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  const onDocDown = (ev: PointerEvent) => {
    if (pop.contains(ev.target as Node) || anchor.contains(ev.target as Node)) return;
    closeHelpPanel();
  };
  helpDocDown = onDocDown;
  document.addEventListener("pointerdown", onDocDown, true);

}

const PANES = ["#menubar", "#toolbar", "#options", "#canvas-host", "#panels"] as const;
const PANE_NAMES = ["menu bar", "tools", "options", "canvas", "panels"] as const;
let paneCursor = -1;

/** True when this element, or an ancestor, is not shown. F6 used to land on
 *  controls inside a hidden pane, which moved focus nowhere visible
 *  (uiux-r7 low). */
function hiddenByAncestor(el: Element): boolean {
  // The class sits on the pane itself, and a shallow parent walk can stop
  // before it (the smoke's nodes implement parentNode only). Ask the panes
  // directly first.
  for (const id of ["toolbar", "panels"] as const) {
    const pane = document.getElementById(id);
    if (pane && pane !== el && pane.contains(el) && pane.classList.contains(`${id === "toolbar" ? "toolbar" : "panel"}-hidden`)) return true;
  }
  let n: Element | null = el;
  while (n) {
    if (n instanceof HTMLElement) {
      if (n.hidden || n.style.display === "none" || n.style.visibility === "hidden") return true;
      if (n.classList.contains("panel-hidden") || n.classList.contains("toolbar-hidden")) return true;
    }
    // The smoke's elements implement parentNode, not parentElement — using
    // parentElement alone walked one level and missed the hidden rail.
    n = (n.parentElement ?? (n.parentNode as Element | null));
  }
  return false;
}

/** every focusable descendant, in document order */
function focusableIn(root: Element | null): HTMLElement[] {
  if (!root) return [];
  const out: HTMLElement[] = [];
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const tag = child.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || child.tabIndex >= 0) {
        if (!child.hasAttribute("disabled") && !hiddenByAncestor(child)) out.push(child);
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** AS2: F6 / Shift+F6 move focus between the five chrome regions. Each region
 *  remembers the control you left, so going back to the layers panel lands on
 *  the layer you were on instead of resetting to the first row. */
const paneMemory = new Map<number, HTMLElement>();

function focusNextPane(dir: number): void {
  for (let step = 0; step < PANES.length; step++) {
    paneCursor = (paneCursor + dir + PANES.length) % PANES.length;
    const root = document.querySelector(PANES[paneCursor]!);
    const list = focusableIn(root);
    if (list.length === 0) continue;
    const remembered = paneMemory.get(paneCursor);
    const target = remembered && remembered.isConnected && root?.contains(remembered)
      ? remembered
      : list[0]!;
    target.focus();
    paneMemory.set(paneCursor, target);
    statusHint(`Focus: ${PANE_NAMES[paneCursor]} — Tab moves inside, F6 moves on`);
    return;
  }
}

/** Is focus somewhere in the chrome? Tab is Photoshop's panel toggle only when
 *  it is not, so once F6 puts you in a panel, Tab walks that panel's controls. */
/** Panels and the tool rail in one press, and the grid track with them — a
 *  hidden rail that still reserved 50px left a black gutter beside the canvas. */
function toggleChrome(): void {
  const visible = togglePanels();
  document.getElementById("toolbar")?.classList.toggle("toolbar-hidden", !visible);
  // Restoring has to put back the *computed* width (two columns, a dragged
  // rail), not the 50 px CSS fallback (uiux-r6).
  if (visible) applyToolbar();
  else document.getElementById("app")?.style.setProperty("--toolbar-w", "0px");
  relayout();
}

function focusInChrome(): boolean {
  const at = document.activeElement;
  if (!at) return false;
  // A floating panel is not the chrome: Tab there must move between its own
  // controls (uiux-r6/r3). The canvas is the picture — a click lands on it and
  // Tab from there must still hide the panels (uiux-r6). The tool rail is
  // "chrome" for F6, but a Tab from a tool button must hide the panels too.
  if (at.closest?.(".float-win") || at.closest?.(".color-pop")) return true;
  // The tab strip is chrome. Without this, Tab from a tab hit the global Tab
  // branch, hid the panels and left focus on the tab — a keyboard trap with no
  // Escape hatch (uiux-r25 #1).
  // The window strip and the status bar are chrome too: Tab entering them must
  // move within them, not fall out of the chrome (uiux-r26 F1).
  if (at.closest?.("#tabs, #topbar, #statusbar")) return true;
  // The recovery bar asks a question that must be answered; Tab there must move
  // between Restore and Discard, not hide the panels (uiux-r36 #2).
  if (recoveryBar && recoveryBar.contains(at)) return true;
  return PANES.filter((sel) => sel !== "#toolbar" && sel !== "#canvas-host")
    .some((sel) => document.querySelector(sel)?.contains(at as Node));
}

// Keep the memory honest for the control the user actually landed on.
document.addEventListener("focusin", () => {
  for (let i = 0; i < PANES.length; i++) {
    const root = document.querySelector(PANES[i]!);
    if (root?.contains(document.activeElement as Node)) paneMemory.set(i, document.activeElement as HTMLElement);
  }
}, true);

function refreshOptions(): void {
  // The bar is about to be rebuilt, so any open "?" points at a dead button.
  // Closing here (rather than watching isConnected asynchronously) keeps the
  // behaviour synchronous and testable in the shim (uiux-r14 #4).
  if (helpPanel) closeHelpPanel();
  // Rebuilding the bar detaches every control. Without this, a mode <select>
  // handed focus to <body> and the next arrow key nudged the layer instead
  // (uiux-r13 #4). Remember which control had focus by its label/role and
  // give it back to the rebuilt twin.
  const prev = document.activeElement as (HTMLElement & { getAttribute?: (n: string) => string | null }) | null;
  const inside = !!(prev && optionsBar.contains(prev));
  // Identity must be a label, never a tag: restoring "the first <input>"
  // lands on a different control and the next arrow key edits the wrong thing
  // (uiux-r14 latent finding).
  const label = (el: HTMLElement & { getAttribute?: (n: string) => string | null }) =>
    el.getAttribute?.("aria-label") ?? el.getAttribute?.("title") ?? el.getAttribute?.("data-opt") ?? "";
  const key = inside && prev ? label(prev) : "";
  buildOptionsBase();
  finalizeOptionsBar();
  fitOptionsPages();
  if (!inside) return;
  const chips = Array.from(optionsBar.querySelectorAll("button, select, input")) as HTMLElement[];
  // A control with no accessible name cannot be matched by `label`. The four
  // new tools' Clear buttons were exactly that, so activating them dropped
  // focus to <body> and the next Delete erased a selection (uiux-r23 #4).
  // Fall back to the first control of the rebuilt bar: same tool, same row.
  // A disabled twin cannot take focus: Clear Counts rebuilt as `disabled` once
  // the state was emptied, so focusing it was a no-op and the next Delete hit
  // <body> (uiux-r24 #2).
  const enabled = chips.filter((el) => !(el as HTMLButtonElement).disabled && !el.hasAttribute("disabled"));
  const next = key ? enabled.find((el) => label(el) === key) : undefined;
  // A remembered label that is gone (the ruler's Clear disappears with the
  // measurement) must not send focus to an unrelated control: park on the bar
  // instead (uiux-r30 #4).
  const target = next ?? (key ? undefined : enabled[0]);
  if (target) target.focus();
  // `focus()` on a control on the hidden page is a no-op: focus stays on
  // <body> and the next Delete erases the selection (code-r25 #4). Verify the
  // landing and park on the bar when the twin is unreachable.
  if (target && document.activeElement !== target) {
    optionsBar.tabIndex = -1;
    optionsBar.focus();
    return;
  }
  if (!target) {
    // No control left to hold focus (a bar that is only a caption). Park it on
    // the bar itself so Tab still counts as inside the chrome.
    optionsBar.tabIndex = -1;
    optionsBar.focus();
  }
}

/**
 * Options-bar paging (user request): when a tool's controls would wrap into a
 * second row, the overflow hides behind a ">" button instead. Clicking it
 * flips to the hidden page ("<" returns).
 *
 * The bar is split in two halves: `.opt-host` holds the controls (and is the
 * only thing that can overflow), `.opt-tail` holds the pager and the "?" help
 * button and sits OUTSIDE the overflow container — so however narrow the
 * window gets, those two buttons stay pinned at the right and visible.
 */
function unwrapOptionsBar(): void {
  const host = optionsBar.querySelector<HTMLElement>(":scope > .opt-host");
  const tail = optionsBar.querySelector<HTMLElement>(":scope > .opt-tail");
  if (host) {
    const frag = document.createDocumentFragment();
    for (const page of Array.from(host.querySelectorAll<HTMLElement>(":scope > .opt-page"))) {
      while (page.firstChild) frag.appendChild(page.firstChild);
    }
    while (host.firstChild) frag.appendChild(host.firstChild);
    optionsBar.insertBefore(frag, host);
    host.remove();
  }
  const help = tail?.querySelector<HTMLElement>(".opt-help") ?? null;
  const cap = tail?.querySelector<HTMLElement>(".opt-cap") ?? null;
  if (tail) {
    // The tail owns both the caption and the "?" button; keeping only the
    // button deleted every caption on any bar that fits (uiux-r15 #3).
    if (cap) optionsBar.appendChild(cap);
    if (help) optionsBar.appendChild(help);
    tail.remove();
  }
}

function fitOptionsPages(): void {
  unwrapOptionsBar();
  const kids = Array.from(optionsBar.children) as HTMLElement[];
  const help = kids.find(k => k.classList.contains("opt-help")) ?? null;
  // the caption rides with the help button: both are explanation, not controls,
  // and paging must never hide the caption on page 2
  const cap = kids.find(k => k.classList.contains("opt-cap")) ?? null;
  const ctrls = kids.filter(k => k !== help && k !== cap && !k.classList.contains("label")) as HTMLElement[];
  // quick-mask / mask-editing banners are the only content: nothing to page
  if (ctrls.length === 0) return;
  const barW = optionsBar.clientWidth;
  if (!Number.isFinite(barW) || barW <= 0) return; // no layout engine (headless smoke)

  const host = document.createElement("div");
  host.className = "opt-host";
  const pageA = document.createElement("div");
  pageA.className = "opt-page";
  pageA.dataset.page = "a";
  const pageB = document.createElement("div");
  pageB.className = "opt-page";
  pageB.dataset.page = "b";
  for (const c of ctrls) pageA.appendChild(c);
  host.appendChild(pageA);
  host.appendChild(pageB);
  for (const k of kids) if (k.classList.contains("label")) host.appendChild(k);
  const tail = document.createElement("div");
  tail.className = "opt-tail";
  if (cap) tail.appendChild(cap);
  if (help) tail.appendChild(help);
  optionsBar.appendChild(host);
  optionsBar.appendChild(tail);

  // Measure each control's intrinsic width and greedily fill page 1. Using the
  // elements' own layout widths means a clipped or still-measuring container
  // can no longer swallow every control but one (the v0.40.1 bug).
  const GAP = 12; // .opt-host column-gap
  // The pager is created after this loop but occupies `.opt-tail`, so page 1
  // must budget for it now: 28 px button + 6 px gap + the bar's padding. The
  // old number measured a tail that did not yet have its pager and clipped the
  // last control at 900 px.
  const PAGER_RESERVE = 34 + 30;
  const budget = Math.max(0, barW - (tail.offsetWidth || 0) - PAGER_RESERVE);
  let used = 0;
  let moved = 0;
  for (const el of Array.from(pageA.children) as HTMLElement[]) {
    const w = el.offsetWidth || 0;
    const next = used + (used > 0 ? GAP : 0) + w;
    if (moved === 0 && (next <= budget || used === 0)) {
      used = next;
      continue;
    }
    pageB.appendChild(el);
    moved++;
  }

  if (moved === 0) {
    // everything fits: leave one plain row (no pager, no wrapper)
    unwrapOptionsBar();
    return;
  }

  const pager = document.createElement("button");
  pager.className = "btn subtle icon opt-pager";
  pager.type = "button";
  const setPage = (p: 0 | 1): void => {
    optionsPage = p;
    pageA.style.display = p === 0 ? "contents" : "none";
        // page B carries overflow-x:auto; display:contents gives its children to
    // the parent's overflow:hidden box, so the scroll box never existed.
    pageB.style.display = p === 1 ? "flex" : "none";
    pager.innerHTML = iconSvg(p === 0 ? "chevron-right" : "chevron-left", 14);
    pager.title = p === 0 ? "Show more options" : "Back to main options";
    pager.setAttribute("aria-label", pager.title);
  };
  pager.addEventListener("click", () => setPage(optionsPage === 0 ? 1 : 0));
  setPage(optionsPage);
  tail.insertBefore(pager, help);
}

// layers list (topmost first)
/** selection → layer mask (Photoshop's "Reveal Selection") */
function addLayerMaskFromSelection(): void {
  const layer = activeLayer;
  if (doc.layers.length === 0) return;
  if (layer.locked) { warnLocked(); return; }
  // With no selection the mask is attached as-is, which used to leave `entry`
  // null — pushHist dropped it, so Ctrl+Z could not remove a mask the file
  // saves (code-r17 #6).
  const existed = !!layer.mask;
  if (!layer.mask) {
    doc.attachMask(layer);
    // A fresh mask has no history: a polarity left over from a mask that was
    // baked away must not turn "add mask from selection" into "hide everything".
    layer.maskHide = false;
  }
  const mask = layer.mask!;
  const before = captureTiles(mask);
  const beforeHide = layer.maskHide === true;
  let entry: HistoryEntry | null = null;
  if (selMask) {
    // AP2: write only the selection's box, and hide the complement through the
    // mask's polarity instead of walking the whole canvas.
    const afterHide = fillMaskFromSelection(mask, selMask, true, beforeHide ? 0 : 255);
    layer.maskHide = afterHide;
    entry = maskSelectionCommand(layer, mask, "Add Layer Mask", before, beforeHide, afterHide, existed);
  }
  if (!entry) {
    entry = {
      label: "Add Layer Mask",
      bytes: mask.allocated * TILE_BYTES,
      undo: () => { layer.mask = existed ? mask : undefined; declaredChange(); },
      redo: () => { layer.mask = mask; declaredChange(); },
    };
  }
  pushHist(entry);
  paintTarget = "mask";
  declaredChange();
  renderLayers(); render(); renderHistoryPanel();
}

/** layer mask → selection (the inverse trip) */
function loadMaskAsSelection(): void {
  const layer = activeLayer;
  if (!layer.mask) return;
  const m = new SelectionMask(doc.width, doc.height);
  if (layer.maskHide) {
    // Hide-polarity masks are sparse: every unallocated tile is already empty,
    // so only the allocated tiles can contribute selected pixels.
    layer.mask.forEachTile((t, tx, ty) => {
      const x0 = tx * TILE, y0 = ty * TILE;
      const w = Math.min(TILE, doc.width - x0), h = Math.min(TILE, doc.height - y0);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const a = 255 - t.data[(yy * TILE + xx) * 4]!;
          if (a > 0) m.setAlpha(x0 + xx, y0 + yy, a);
        }
      }
    });
  } else {
    for (let y = 0; y < doc.height; y++) {
      for (let x = 0; x < doc.width; x++) {
        const a = maskAt(layer.mask, x, y, 255);
        if (a > 0) m.setAlpha(x, y, a);
      }
    }
  }
  selRect = null;
  selGeom = null;
  selMask = m;
  startAnts();
  drawOverlay();
}

function applyLayerMaskNow(): void {
  const layer = activeLayer;
  if (!layer.mask) return;
  // Baking writes tile alpha: same surface rules as any other pixel op, and a
  // locked layer must not lose its mask (code-r16 #2).
  if (refuseGroupPixels(layer)) return;
  if (refusePaintSurface(layer)) return;
  const before = captureTiles(layer.grid);
  const maskBackup = layer.mask;
  const hide0 = layer.maskHide === true; // baking clears it; undo must restore it
  bakeLayerMask(layer, doc.width, doc.height);
  const pixelEntry = snapshotCommand(layer.grid, "Apply Layer Mask", before);
  // the bake multiplies pixels AND drops the mask: one entry must restore both,
  // otherwise undo silently loses the mask the user can still see in the panel.
  // A layer that was only ever masked has no tiles, so `snapshotCommand` may be
  // null — the mask work must still be undoable.
  if (pixelEntry || maskBackup.allocated > 0) {
    pushHist({
      label: "Apply Layer Mask",
      bytes: (pixelEntry?.bytes ?? 0) + maskBackup.allocated * TILE_BYTES,
      undo: () => {
        pixelEntry?.undo();
        layer.mask = maskBackup;
        layer.maskHide = hide0;
        declaredChange();
      },
      redo: () => {
        layer.mask = undefined;
        layer.maskHide = false;
        pixelEntry?.redo();
        declaredChange();
      },
    });
  }
  paintTarget = "pixel";
  declaredChange();
  renderLayers(); render(); renderHistoryPanel();
}

function deleteLayerMask(): void {
  const layer = activeLayer;
  if (!layer.mask) return;
  if (layer.locked) { warnLocked(); return; }
  const mask = layer.mask;
  const wasHide = layer.maskHide === true;
  layer.mask = undefined;
  layer.maskHide = false;
  pushHist({
    label: "Delete Layer Mask",
    bytes: mask.allocated * TILE_BYTES,
    undo: () => { layer.mask = mask; layer.maskHide = wasHide; declaredChange(); },
    redo: () => { layer.mask = undefined; layer.maskHide = false; declaredChange(); },
  });
  paintTarget = "pixel";
  declaredChange();
  renderLayers(); render(); renderHistoryPanel();
}

/** the adjustment-layer picker */
/**
 * New Fill Layer — the dialog lives in ui/filldialog.ts (markup, not document
 * logic); this bridge is the only part that touches the document.
 */
const addFillLayer = (): void => {
  openFillLayerDialog({
    showModal,
    pickColour: openColorPicker,
    create: (choice) => {
      const first = choice.stops[0]?.color ?? [255, 255, 255];
      const layer = doc.addFillLayer([first[0], first[1], first[2]], choice.name, fillGradientFrom(choice), fillPatternFrom(choice));
      pushHist(addAboveActive(doc, layer));
      activeLayer = layer;
      declaredChange();
      renderLayers(); render(); renderHistoryPanel(); renderTabs(); pulse(layersBox);
    },
  });
};

/**
 * Edit one adjustment layer's recipe. Shared by the menu, the context menu and
 * the panel's double-click, so all three do the same undoable thing.
 */
const editAdjustLayer = (layer: Layer): void => {
  const before = layer.adjust;
  if (layer.kind !== "adjust" || !before) {
    notify("Not an adjustment layer", "Adjustment Settings edits the recipe of an adjustment layer.");
    return;
  }
  openAdjustLayerDialog({ showModal }, {
    kind: before.kind,
    spec: before,
    layerName: layer.name,
    onOk: (after) => {
      // A recipe change repaints the picture, so it must be one undo step with
      // both halves recorded: the undo restores the OLD spec, not just pixels.
      pushHist(propertyCommand(`${adjustLabel(after)} settings — ${layer.name}`, (v) => {
        layer.adjust = v as AdjustSpec;
        declaredChange();
      }, before, after));
      layer.adjust = after;
      layer.name = adjustLabel(after);
      declaredChange();
      renderLayers(); render(); refreshOptions(); renderHistoryPanel();
    },
  });
};

/**
 * "New Adjustment Layer": pick a kind, configure it in the same dialog, confirm.
 * The old version exposed one "Amount" slider for every kind and mapped it to
 * whichever field that kind happened to own, which made Levels a gamma guess and
 * Curves unreachable — and nothing could reopen the result.
 */
const canMakeSmart = (layer: Layer): boolean =>
  layer.kind === "pixel" && !layer.smart && !layer.textData;

const convertToSmartObject = (): void => {
  const layer = activeLayer;
  if (refuseGroupPixels(layer, true)) return;
  if (layer.smart) { statusHint("This layer is already a smart object"); return; }
  if (layer.textData) {
    // Type keeps its recipe; converting would have to drop it or freeze it.
    statusHint("Rasterize the type first — a live text layer has no fixed pixels");
    return;
  }
  const source = smartSourceFromGrid(layer.grid);
  if (!source) { statusHint("Nothing to convert — this layer has no pixels"); return; }
  // propertyCommand records undo/redo closures; it does NOT apply `after` for
  // you, so the forward direction is set here (the undo path sets it back).
  layer.smart = source;
  // No byte charge: the buffer is still live on the layer, so the entry keeps a
  // reference, not a copy. Charging it evicted the user's undo stack on a few
  // converts (sec-r28 #4). Rasterize does charge, because the source leaves the
  // document there.
  pushHist(propertyCommand(`Convert to Smart Object — ${layer.name}`, (v) => { layer.smart = v as SmartSource | undefined; }, undefined, source));
  declaredChange();
  renderLayers();
  renderHistoryPanel();
  notify("Smart object", `“${layer.name}” keeps its original ${source.width} × ${source.height} image — scaling it will not lose detail.`);
};

const rasterizeSmartObject = (): void => {
  const layer = activeLayer;
  if (!layer.smart) { statusHint("This layer is not a smart object"); return; }
  const before = layer.smart;
  layer.smart = undefined;
  pushHist(propertyCommand(`Rasterize Smart Object — ${layer.name}`, (v) => { layer.smart = v as SmartSource | undefined; }, before, undefined, before?.data.byteLength ?? 0));
  declaredChange();
  renderLayers();
  renderHistoryPanel();
  statusHint(`“${layer.name}” is now ordinary pixels`);
};

const replaceSmartContents = (): void => {
  const layer = activeLayer;
  if (!layer.smart) { statusHint("Convert the layer to a smart object first"); return; }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,.tif,.tiff";
  input.style.display = "none";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    void (async () => {
      try {
        const img = await decodeImageFile(file);
        const source: SmartSource = { width: img.width, height: img.height, data: img.data };
        // Tile-aligned bbox is up to 255 px larger per axis than the picture, so
        // a replacement anchored to it lands shifted and scaled (code-r27 #4).
        const bb = contentBounds(layer.grid) ?? gridBBox(layer.grid) ?? { x: 0, y: 0, w: img.width, h: img.height };
        const beforeSource = layer.smart;
        const beforeTiles = captureTiles(layer.grid);
        renderSmartIntoGrid(layer.grid, source, bb);
        layer.smart = source;
        const entry = snapshotCommand(layer.grid, `Replace Contents — ${layer.name}`, beforeTiles);
        if (entry) {
          // The entry pins the old and the new source buffers; charging only
          // the tiles hid up to 2×160 MB per replace (code-r28 #3).
          entry.bytes =
            (entry.bytes ?? 0) + (beforeSource?.data.byteLength ?? 0) + source.data.byteLength;
          const undo = entry.undo, redo = entry.redo;
          entry.undo = () => { undo(); layer.smart = beforeSource; };
          entry.redo = () => { redo(); layer.smart = source; };
          pushHist(entry);
        }
        declaredChange();
        render();
        renderLayers();
        renderHistoryPanel();
        notify("Smart object updated", `“${layer.name}” now shows ${file.name} at its saved footprint.`);
      } catch (err) {
        notify("Could not replace the contents", err instanceof Error ? err.message : String(err));
      }
    })();
  };
  input.click();
};

const addAdjustmentLayer = (): void => {
  openNewAdjustmentDialog({ showModal }, (spec) => {
    const layer = doc.addAdjustLayer(spec);
    layer.name = adjustLabel(spec);
    pushHist(addAboveActive(doc, layer));
    activeLayer = layer;
    declaredChange();
    renderLayers(); render(); renderHistoryPanel(); renderTabs(); pulse(layersBox);
  });
};

/**
 * A coarse mosaic of the layer: one flat colour per allocated 256px tile.
 * Sampling every pixel would mean a full readRect per layer on every edit,
 * which is exactly the cost we removed from compositing.
 */
function blendTitle(mode: BlendMode): string {
  return mode.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function opacityDialog(layer: Layer, apply: (percent: number) => boolean): void {
  const body = document.createElement("div");
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.className = "label";
  span.textContent = "Opacity (%)";
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(Math.round(layer.opacity * 100));
  input.min = "0";
  input.max = "100";
  wrap.append(span, input);
  body.appendChild(wrap);
  showModal(`Opacity — ${layer.name}`, body, () => {
    const v = Math.max(0, Math.min(100, Math.round(Number(input.value) || 0)));
    const after = v / 100;
    if (after === layer.opacity) return;
    const before = layer.opacity;
    if (!apply(v)) return;
    pushHist(propertyCommand(`Opacity ${v}% ${layer.name}`, (w) => { apply(w as number); }, before, after));
    render(); renderLayers(); renderHistoryPanel();
  });
}

function rasterizeTypeLayer(layer: Layer): void {
  if (!layer.textData) return;
  const before = layer.textData;
  layer.textData = undefined;
  pushHist(propertyCommand(`Rasterize Type ${layer.name}`, (v) => { layer.textData = v as TextLayerMeta | undefined; }, before, undefined));
  renderLayers();
  renderHistoryPanel();
  statusHint(`“${layer.name}” rasterized`);
}

/** one implementation per layer op, shared by the context menu and the Menu bar */
function setLayerBlendMode(layer: Layer, m: BlendMode): void {
  if (m === layer.blendMode) return;
  const before = layer.blendMode;
  layer.blendMode = m;
  declaredChange();
  pushHist(propertyCommand(`Blend ${blendTitle(before)} → ${blendTitle(m)} ${layer.name}`, (v) => { layer.blendMode = v as BlendMode; declaredChange(); }, before, m));
  render(); renderLayers(); renderHistoryPanel();
}

function toggleLayerVisibility(layer: Layer): void {
  const before = layer.visible;
  layer.visible = !before;
  declaredChange();
  pushHist(propertyCommand(`${before ? "Hide" : "Show"} ${layer.name}`, (v) => { layer.visible = v as boolean; declaredChange(); }, before, !before));
  render(); renderLayers(); renderHistoryPanel();
}

function toggleLayerLock(layer: Layer): void {
  const before = layer.locked;
  layer.locked = !before;
  pushHist(propertyCommand(`${before ? "Unlock" : "Lock"} ${layer.name}`, (v) => { layer.locked = v as boolean; }, before, !before));
  renderLayers(); renderHistoryPanel();
}

/** start the inline rename on the layer's row (the row owns the input UI) */
function beginLayerRename(layer: Layer): void {
  // The row lives inside the Layers card. While that card is collapsed its
  // body is display:none, the input cannot take focus, and typing falls
  // through to the tool keys — so expand it first.
  const card = layersBody.closest?.(".card") as HTMLElement | null;
  if (card?.classList.contains("collapsed")) {
    card.classList.remove("collapsed");
    card.style.height = "";
    card.style.flex = "";
    const head = card.querySelector(".card-head") as HTMLElement | null;
    head?.setAttribute("aria-expanded", "true");
  }
  renderLayers();
  const nameEl = layersBody.querySelector<HTMLElement>(`.row[data-layer-id="${layer.id}"] .name`);
  nameEl?.dispatchEvent(new MouseEvent("dblclick"));
}

function layerBlendItems(layer: Layer): MenuItem[] {
  return LAYER_BLEND_MODES.map((m) => ({
    label: blendTitle(m),
    checked: layer.blendMode === m,
    run: () => setLayerBlendMode(layer, m),
  }));
}

/**
 * New Group / Group Layers / Ungroup, shared by the Layer menu and the row
 * context menu. The document and the callbacks are parameters, not globals:
 * the coupling pin counts top-level functions that mention the shell's live
 * document state, and the trio must not add three to that number.
 */
function groupAuthoringItems(
  target: Layer,
  document: Document,
  push: (entry: HistoryEntry) => void,
  changed: () => void,
  activate: (layer: Layer) => void,
  after: () => void,
): MenuItem[] {
  const parent = document.parentOf(target);
  if (parent === undefined) return [];
  const list = parent ? (parent.children ?? []) : document.layers;
  const index = list.indexOf(target);
  const newGroup = (): void => {
    const at = index < 0 ? list.length : index + 1;
    const { group, entry } = addGroupNode(document, parent, at);
    push(entry);
    changed();
    activate(group);
    after();
  };
  const groupLayers = (): void => {
    const { group, entry } = groupLayerNode(document, target);
    push(entry);
    changed();
    activate(group);
    after();
  };
  const ungroup = (): void => {
    const { children, entry } = ungroupLayerNode(document, target);
    push(entry);
    changed();
    activate(children[0] ?? parent ?? document.layers[0]!);
    after();
  };
  return [
    { label: "New Group", run: newGroup },
    { label: "Group Layers", run: groupLayers },
    { label: "Ungroup", disabled: !canUngroupLayer(document, target), run: ungroup },
  ];
}

/** Delete command label: a group says how many descendant layers go with it. */
function deleteLayerLabel(layer: Layer): string {
  if (layer.kind !== "group") return "Delete Layer";
  const n = subtreeCount(layer) - 1;
  return n === 0 ? "Delete Empty Group" : `Delete Group (${n} layer${n === 1 ? "" : "s"})`;
}

/**
 * The discoverable/keyboard twin of drag-to-reparent. Candidates are filtered
 * with canMoveLayer(), so the menu never offers a drop that would throw.
 */
function layerMoveMenuItems(
  layer: Layer,
  document: Document,
  push: (entry: HistoryEntry) => void,
  changed: () => void,
  activate: (next: Layer) => void,
  after: () => void,
): MenuItem[] {
  const parent = document.parentOf(layer);
  if (parent === undefined) return [];
  const commit = (moved: { entry: HistoryEntry } | null): void => {
    if (!moved) return;
    push(moved.entry);
    changed();
    activate(layer);
    after();
  };
  const groups = document.allLayers().filter(
    (candidate) => candidate.kind === "group" && canMoveLayer(document, layer, candidate),
  );
  const items: MenuItem[] = [];
  if (groups.length > 0) {
    items.push({
      label: "Move into group ▸",
      children: groups.map((group) => ({
        label: groupPath(document, group),
        run: () => commit(moveLayerNode(document, layer, group, "inside")),
      })),
    });
  }
  const out = parent ? moveOutSpot(document, layer) : null;
  if (out) {
    items.push({
      label: "Move out of group",
      run: () => commit(moveLayerToSpot(document, layer, out.parent, out.index)),
    });
  }
  return items;
}

/** Set or clear a layer's colour tag, undoably. Kept free of `doc`/`activeLayer`
 *  so it does not add a coupled function (the pin is at 84). */
function setLayerTag(layer: Layer, tag: string | undefined): void {
  const before = layer.groupId;
  if (before === tag) return;
  layer.groupId = tag;
  pushHist(
    propertyCommand(
      tag ? `Tag ${layer.name} ${tag}` : `Clear colour tag on ${layer.name}`,
      (v) => { layer.groupId = v as string | undefined; },
      before,
      tag,
    ),
  );
  declaredChange();
  renderLayers();
  renderHistoryPanel();
  // renderLayers() replaces every row; without this the keyboard user who just
  // committed a tag is stranded on <body> and the next Delete clears the
  // selection (uiux-r30 #2). The same block was copied into finishTextResize,
  // where a mouse resize must not steal focus from the canvas (uiux-r31 #1).
  const row = layersBody.querySelector?.(`.row[data-layer-id="${layer.id}"]`) as HTMLElement | null;
  row?.focus();
}

function layerContextMenu(layer: Layer): MenuItem[] {
  const idx = doc.layers.indexOf(layer);
  const blendItems: MenuItem[] = layerBlendItems(layer);
  const items: MenuItem[] = [
    { label: "New Layer", key: "Ctrl+Shift+N", run: addNewLayer },
    ...groupAuthoringItems(
      layer,
      doc,
      (entry) => pushHist(entry),
      declaredChange,
      (next) => { activeLayer = next; },
      () => { renderLayers(); render(); renderHistoryPanel(); },
    ),
    ...layerMoveMenuItems(
      layer,
      doc,
      (entry) => pushHist(entry),
      declaredChange,
      (next) => { activeLayer = next; },
      () => { renderLayers(); render(); renderHistoryPanel(); },
    ),
    { label: "Duplicate Layer…", run: duplicateActiveLayer },
    { label: deleteLayerLabel(layer), disabled: !canDeleteLayer(doc, layer), run: deleteActiveLayer },
    { sep: true },
    { label: "Rename Layer…", run: () => beginLayerRename(layer) },
    ...(layer.kind === "adjust" && layer.adjust
      ? [{ label: "Adjustment Settings…", run: () => editAdjustLayer(layer) } as MenuItem]
      : []),
    ...(canMakeSmart(layer) ? [{ label: "Convert to Smart Object", run: convertToSmartObject } as MenuItem] : []),
    ...(layer.smart ? [
      { label: "Rasterize Smart Object", run: rasterizeSmartObject },
      { label: "Replace Smart Object Contents…", run: replaceSmartContents },
    ] as MenuItem[] : []),
    { label: layer.visible ? "Hide Layer" : "Show Layer", run: () => toggleLayerVisibility(layer) },
    { label: layer.locked ? "Unlock Layer" : "Lock Layer", run: () => toggleLayerLock(layer) },
    { sep: true },
    { label: "Blending ▸", children: blendItems },
    {
      // The chip is pointer-only and out of the tab order, so this menu is the
      // keyboard path to a tag (uiux-r29 #3).
      label: "Colour Tag ▸",
      children: [
        ...["G1", "G2", "G3", "G4", "G5", "G6"].map((id) => ({
          label: id,
          checked: layer.groupId === id,
          run: () => setLayerTag(layer, id),
        })),
        { sep: true },
        { label: "Clear Tag", disabled: !layer.groupId, run: () => setLayerTag(layer, undefined) },
      ],
    },

    { label: "Layer Opacity…", run: () => opacityDialog(layer, (percent) => setLayerOpacity(layer, percent, doc, flatCache)) },
    { sep: true },
    {
      // No key label: the keymap has no Alt combinations (they collide with
      // OS/window-manager gestures) and no handler exists — an advertised
      // shortcut that does nothing is worse than an unlisted command.
      label: layer.clipToBelow ? "Release Clipping Mask" : "Create Clipping Mask",
      run: () => {
        const before = layer.clipToBelow === true;
        layer.clipToBelow = !before;
        declaredChange();
        pushHist(propertyCommand(`${before ? "Release Clipping" : "Create Clipping"} ${layer.name}`, (v) => { layer.clipToBelow = v as boolean; declaredChange(); }, before, !before));
        render(); renderLayers(); renderHistoryPanel();
      },
    },
    { label: "Add Layer Mask", run: addLayerMaskFromSelection },
    ...(layer.mask ? [
      // The mask chip is the only pointer control for this, and it is not in
      // the tab order: a keyboard user could never paint a layer mask
      // (uiux-r27 #4).
      { label: "Paint on Layer Mask", run: () => { paintTarget = "mask"; refreshOptions(); renderLayers(); } },
      { label: "Paint on Pixels", run: () => { paintTarget = "pixel"; refreshOptions(); renderLayers(); } },
      { label: "Apply Layer Mask", run: applyLayerMaskNow },
      { label: "Delete Layer Mask", run: deleteLayerMask },
    ] as MenuItem[] : []),
    { sep: true },
    { label: "Merge Down", key: "Ctrl+E", disabled: idx <= 0, run: mergeDown },
    { label: "Flatten Image", run: flattenImage },
    ...(layer.textData ? [{ label: "Rasterize Type", run: () => rasterizeTypeLayer(layer) } as MenuItem] : []),
    { sep: true },
    { label: "Quick Export as PNG", run: quickExportPng },
    { label: "Export As…", run: () => runTop("Export As…") },
  ];
  return items;
}

/**
 * The Layers panel lives in src/ui/layerspanel.ts (handoff-5 AF3): this file
 * kept a 320-line renderer reaching into a dozen module globals. The adapter
 * below is the whole contract — if the panel needs something new, it has to be
 * named here instead of discovered by grepping for `activeLayer`.
 */
const layersPanel = buildLayersPanel({
  body: layersBody,
  strip: layersStrip,
  rows: () => panelRows(doc, activeLayer, session.collapsed),
  reveal: () => session.revealFor(doc, activeLayer),
  doc: () => doc,
  active: () => activeLayer,
  setActive: (l) => { activeLayer = l; },
  collapsed: () => session.collapsed,
  toggleCollapsed: (layer) => { session.toggleCollapsed(layer.id); renderLayers(); },
  paintTarget: () => paintTarget,
  setPaintTarget: (t) => { paintTarget = t; },
  hasSelection: () => selMask !== null || selRect !== null,
  undoable: (label, apply, before, after) => pushHist(propertyCommand(label, apply, before, after)),
  repaint: () => { declaredChange(); render(); },
  rerender: () => renderLayers(),
  refreshHistory: () => renderHistoryPanel(),
  refreshOptions: () => refreshOptions(),
  menu: (ev, layer) => showContextMenu(ev, layerContextMenu(layer)),
  addLayer: () => addNewLayer(),
  duplicateLayer: () => duplicateActiveLayer(),
  deleteLayer: () => deleteActiveLayer(),
  mergeDown: () => mergeDown(),
  flatten: () => flattenImage(),
  enterTransform: () => enterTransform(),
  cancelTransform: () => cancelTransform(),
  addMask: () => addLayerMaskFromSelection(),
  loadMask: () => loadMaskAsSelection(),
  applyMask: () => applyLayerMaskNow(),
  deleteMask: () => deleteLayerMask(),
  addAdjust: () => addAdjustmentLayer(),
  moveLayer: (delta) => {
    // Raise/lower moves a node among its OWN siblings. The panel passes a
    // direction (+1 up, -1 down), never a root index: a group child's index in
    // doc.layers is -1, which is how the old flat body made raise/lower dead on
    // children. moveLayerTo keeps the cycle guard and the forward-shift
    // compensation in one place.
    const parent = doc.parentOf(activeLayer);
    if (parent === undefined) return;
    const list = parent ? (parent.children ?? []) : doc.layers;
    const idx = list.indexOf(activeLayer);
    if (idx < 0) return;
    const at = Math.max(0, Math.min(idx + delta, list.length - 1));
    if (at === idx) return;
    // moveLayerTo takes a PRE-removal splice index: passing the final index it
    // is going to have makes a forward move land back where it started (the
    // "up" button was dead). moveLayerToSpot owns that conversion and records
    // the final index in its entry.
    // moveLayerToSpot takes the PRE-removal splice index; going up means the
    // slot one past the final one, because removing the layer first shifts
    // everything above it down.
    const moved = moveLayerToSpot(doc, activeLayer, parent, at > idx ? at + 1 : at);
    if (!moved) return;
    pushHist(moved.entry);
    declaredChange(); renderLayers(); render(); renderHistoryPanel();
  },
  canDropLayer: (moving, target, zone) => dropSpot(doc, moving, target, zone) !== null,
  dropLayer: (moving, target, zone) => {
    const moved = moveLayerNode(doc, moving, target, zone);
    if (!moved) return;
    pushHist(moved.entry);
    declaredChange();
    renderLayers();
    render();
    renderHistoryPanel();
    // D5 (uiux-r32): a drop is a document change; it was silent and it threw
    // the focused row away. Name the move, then put focus back on the layer.
    statusHint(`Moved \u201c${moving.name}\u201d under \u201c${target.name}\u201d`);
    (layersBody.querySelector(`.row[data-layer-id="${moving.id}"]`) as HTMLElement | null)?.focus();
  },
  onRefused: () => statusHint("A layer cannot be dropped there."),
});


/**
 * Photoshop's rule, one sentence for all six add sites: a new layer is inserted
 * as a SIBLING of the active layer, directly above it; with no active layer, at
 * the root. Re-answering the sites through this function is the difference
 * between fixing them and re-typing them.
 */
/**
 * Insert `layer` directly above `ref` (by default the layer that was active)
 * and record that spot. Callers must pass `ref` captured *before* they move
 * `activeLayer`: recording the spot after the reassignment put a root layer on
 * top instead of above its source, and put a group child at the root.
 */
function addAboveActive(doc: Document, layer: Layer, ref: Layer = activeLayer): HistoryEntry {
  const parent = doc.parentOf(ref);
  let spot: LayerSpot = { parent: null, index: doc.layers.length - 1 };
  if (parent !== undefined) {
    const list = parent ? (parent.children ?? []) : doc.layers;
    const at = list.indexOf(ref);
    const from = doc.parentOf(layer);
    if (at >= 0 && from !== undefined) {
      doc.removeLayerFrom(from, layer);
      const target = parent ? (parent.children ?? []) : doc.layers;
      const index = Math.max(0, Math.min(at + 1, target.length));
      doc.insertLayer(parent, layer, index);
      spot = { parent, index };
    }
  }
  return layerAddCommand(doc, layer, spot);
}

function renderLayers(): void {
  layersPanel.render();
}

const historyPanelDeps: HistoryPanelDeps = {
  host: historyBody,
  history: () => session.current,
  applyHistoryChange: (pixelsChanged?: boolean) => applyHistoryChange(pixelsChanged ?? true),
  showContextMenu: (ev, items) => showContextMenu(ev, items),
  statusHint: (message) => statusHint(message),
  updateStatus: () => updateStatus(),
  cancelTransform: () => cancelTransform(),
};

/** history panel: one row per entry; applied (past) bright, future dimmed */
function renderHistoryPanel(): void { renderHistoryPanelInto(historyPanelDeps); }

const historyChangeDeps: HistoryChangeDeps = {
  clearPreview: () => clearPreview(),
  document: () => doc,
  textSelection: () => textSel,
  setTextSelection: (layer) => { textSel = layer; },
  markDirty: () => markDirty(),
  setFlatDirty: (v) => { if (v) declaredChange(); },
  setAutosaveDirty: (v) => { autosaveDirty = v; if (v) autosaveScheduler?.noteEdit(); },
  activeLayer: () => activeLayer,
  setActiveLayer: (layer) => { activeLayer = layer; },
  renderAll: () => {
    // Undoing "Add Layer Mask" detaches the mask; the paint target and the help
    // panel kept claiming the mask was still there (uiux-r39 F4). The reset
    // lives here, on the rerender path, so applyHistoryChange stays uncoupled.
    if (paintTarget === "mask" && !activeLayer?.mask) {
      paintTarget = "pixel";
      refreshOptions();
    }
    // D1 (uiux-r32): undo/redo rebuilds every row. Without this, a keyboard
    // user who pressed Ctrl+Z with a layer row focused lands on <body>, and the
    // next Tab hides the chrome instead of moving focus (focusInChrome() is
    // false from the body).
    const before = document.activeElement as HTMLElement | null;
    const layerId = before?.closest?.(".row") instanceof HTMLElement
      ? (before.closest(".row") as HTMLElement).dataset.layerId
      : undefined;
    const wasHistory = before?.closest?.(".hist-row") instanceof HTMLElement;
    // A strip button (mask, duplicate, …) is rebuilt by renderLayers(), and a
    // focused tab by renderTabs(); both dropped focus to <body> on undo
    // (uiux-r37 #5).
    const stripAct = before instanceof HTMLElement && before.dataset.act && before.closest("#panels")
      ? before.dataset.act
      : undefined;
    const wasTab = before?.closest?.("#tabs .tab") instanceof HTMLElement;
    render(); renderLayers(); renderHistoryPanel();
    if (wasHistory) {
      // At position 0 no row carries .current, and the first Ctrl+Z of a
      // session stranded focus on <body> (uiux-r33 #2).
      const row = (document.querySelector("#panels .hist-row.current")
        ?? document.querySelector("#panels .hist-row")) as HTMLElement | null;
      row?.focus();
    } else if (stripAct) {
      const again = layersBody.querySelector(`[data-act="${stripAct}"]`) as HTMLElement | null;
      (again ?? layersBody.querySelector(".row.active") as HTMLElement | null)?.focus();
    } else if (wasTab) {
      (document.querySelector("#tabs .tab.active") as HTMLElement | null)?.focus();
    } else if (layerId) {
      // Undo of a layer add (or redo of a delete) removes that row; without a
      // fallback focus landed on <body> (uiux-r35 #5).
      const row = (layersBody.querySelector(`.row[data-layer-id="${layerId}"]`) as HTMLElement | null)
        ?? (layersBody.querySelector(".row.active") as HTMLElement | null);
      row?.focus();
    }
  },
};

function applyHistoryChange(pixelsChanged = true): void { applyHistoryChangeVia(historyChangeDeps, pixelsChanged); }

// ---- keyboard shortcuts --------------------------------------------------
// Space-drag pan state: set while the key is held, restored on release.
window.addEventListener("keydown", (e) => {
  // A dialog, the text editor or any form field owns its own keystrokes:
  // without this, typing "b" in a Width field switched tools and Backspace
  // erased pixels behind the modal. The rule lives in ui/keymap.ts so the
  // precedence is a test, not a comment (R6.3).
  const kt = e.target as HTMLElement | null;
  if (!shortcutAllowed({ modalOpen: modalOpen(), target: kt })) return;
  // D2 (uiux-r32): the colour popover says role="dialog" but is not a modal
  // layer, so with focus on its SV/hue canvas a plain "d" reset the foreground
  // behind the picker and the next slider move re-committed the old colour.
  // Ctrl/Cmd combinations still work (undo must not require closing a picker).
  if (colorPop && !e.ctrlKey && !e.metaKey && !e.altKey) return;
  // X2: Menu key / Shift+F10 opens the focused surface's context menu
  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
    openContextMenuFromKeyboard();
    return;
  }
  if (transform) {
    // transform captures the keyboard: Enter applies, Esc cancels, Ctrl+T cancels
    if (e.key === "Enter") { e.preventDefault(); applyTransform(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelTransform(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") { e.preventDefault(); cancelTransform(); }
    return;
  }
  // Photoshop's Tab family: Tab hides the panel column (and the toolbar),
  // Shift+Tab hides only the panels. Both toggle straight back.
  // Photoshop's Tab hides panels — but only from the canvas, not inside the
  // chrome. Taking Tab there too meant a panel could never be walked with the
  // keyboard (ui11): F6 put focus in a panel and the next Tab hid it.
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && recoveryBar && recoveryBar.contains(document.activeElement)) {
    // The bar is a question; Tab must move between its two answers instead of
    // leaving a keyboard user in the panels behind it (uiux-r37 #1).
    const buttons = Array.from(recoveryBar.querySelectorAll("button")) as HTMLElement[];
    const at = document.activeElement as HTMLElement;
    // After the bar settles, only Close remains: it is not an answer, and a
    // one-button "cycle" would trap Tab on it forever. Leave the bar alone so
    // the browser moves focus on (uiux-r41 F1, uiux-r42 F1).
    if (buttons.length < 2 || !buttons.includes(at)) return;
    e.preventDefault();
    const i = buttons.indexOf(at);
    const target = buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]!;
    target.focus();
    return;
  }
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !focusInChrome()) {
    e.preventDefault();
    // togglePanels returns the NEW visibility. `classList.toggle(cls, force)`
    // adds when force is true, so forcing `!e.shiftKey` made plain Tab hide the
    // toolbar every time and never bring it back (ui13).
    if (e.shiftKey) togglePanels();
    else toggleChrome();
    relayout();
    // Tab from the rail hid the rail and left focus on a button that is no
    // longer drawn; park it in the first pane still visible (uiux-r7 low).
    const at = document.activeElement as HTMLElement | null;
    if (at && hiddenByAncestor(at)) {
      // Tab also hides the panel column, so the first pane that still has a
      // focusable control is usually the menu bar.
      const next =
        focusableIn(document.getElementById("menubar"))[0] ??
        focusableIn(document.getElementById("options"))[0] ??
        focusableIn(document.getElementById("panels"))[0] ??
        focusableIn(document.getElementById("toolbar"))[0] ??
        null;
      next?.focus();
    }
    return;
  }
  // AS2: Tab is Photoshop's panel toggle, which left the chrome with no keyboard
  // route at all — no way to reach the menu bar, the tool rail, the options bar
  // or the panels without a mouse. F6 cycles panes, F10 lands on the menu bar
  // (Alt alone belongs to the OS window menu, so it stays untouched).
  if (e.key === "F6") {
    e.preventDefault();
    focusNextPane(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "F10" && !e.shiftKey) {
    e.preventDefault();
    // children[0] is the .menu wrapper (popup.ts), which has no tabindex; the
    // focusable element is the title button inside it.
    const first = menuBarEl.children[0]?.children[0];
    if (first instanceof HTMLElement) first.focus();
    return;
  }
  if (e.altKey && e.key === "Backspace") {
    e.preventDefault();
    fillWithForeground();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    // AH5: the accelerator contract lives in ui/keymap.ts. This listener only
    // maps an action id to a handler, so the help table and the dispatcher
    // cannot drift — a shortcut without an action fails the gate, and so does
    // an action nobody can discover from the help dialog.
    const action = keyAction(e.key, { ctrl: true, shift: e.shiftKey, alt: e.altKey });
    const run = action ? KEY_HANDLERS[action] : undefined;
    if (action && run) {
      e.preventDefault();
      run();
    }
    return;
  }
  if (e.key === "h" || e.key === "H") {
    handMode = !handMode;
    zoomMode = false;
    syncCursor();
    statusHint(handMode ? "Hand mode — drag to pan, H to leave" : "Hand mode off");
    return;
  }
  if (e.key === "z" || e.key === "Z") {
    zoomMode = !zoomMode;
    handMode = false;
    syncCursor();
    statusHint(zoomMode ? "Zoom mode — click to zoom in, Alt-click to zoom out, Z to leave" : "Zoom mode off");
    return;
  }
  if (e.key === "b" || e.key === "B") { tool = e.shiftKey ? "pencil" : "brush"; highlight(); }
  else if (e.shiftKey && e.key.toLowerCase() === "p") { tool = "patternstamp"; highlight(); }
  else if (e.shiftKey && e.key.toLowerCase() === "y") { tool = "colourreplace"; highlight(); }
  else if (e.shiftKey && e.key.toLowerCase() === "j") { tool = "patch"; highlight(); }
  else if (e.shiftKey && e.key.toLowerCase() === "n") { tool = "note"; highlight(); }
  else if (e.shiftKey && e.key.toLowerCase() === "k") { tool = "mixer"; highlight(); }
  else if (e.key === "e" || e.key === "E") {
    // Shift+E cycles the two eraser variants; E always returns to the plain one
    tool = e.shiftKey ? (tool === "magicerase" ? "bgerase" : "magicerase") : "eraser";
    highlight();
  }
  else if (e.key === "m" || e.key === "M") { tool = tool === "marquee" ? "ellipse" : "marquee"; highlight(); }
  else if (e.key === "l" || e.key === "L") {
    // L is Lasso; Shift+L cycles its three shapes, the way L cycles in Photoshop.
    tool = e.shiftKey ? (tool === "polylasso" ? "magnet" : tool === "magnet" ? "lasso" : "polylasso") : "lasso";
    highlight();
  }
  else if (e.key === "p" || e.key === "P") { tool = "pen"; highlight(); statusHint("Pen — click anchors, Enter or double-click to close into a selection."); }
  else if (e.key === "w" || e.key === "W") { tool = e.shiftKey ? "quick" : "wand"; highlight(); }
  else if (e.key === "u" || e.key === "U") { tool = "shape"; highlight(); }
  else if (e.code === "BracketLeft" || e.code === "BracketRight") {
    // e.code, not e.key: Shift+] arrives as "}" and Shift+[ as "{", so the
    // documented hardness pair used to change the size instead.
    const up = e.code === "BracketRight";
    if (e.shiftKey) {
      brushHardness = Math.max(0, Math.min(1, brushHardness + (up ? 0.05 : -0.05)));
      brushSettings.tip.hardness = Math.round(brushHardness * 100);
      saveBrushSettings(brushSettings);
      statusHint(`Hardness ${Math.round(brushHardness * 100)}%`);
      refreshOptions();
      return;
    }
    // documented in Help ▸ Keyboard Shortcuts: step the brush size
    const step = brushSize < 20 ? 1 : brushSize < 60 ? 5 : 10;
    brushSize = Math.max(1, Math.min(300, brushSize + (up ? step : -step)));
    // The panel edits brushSettings.tip.size; leaving it behind made the next
    // panel change snap the brush back to the stale draft (uiux-r9 #6).
    brushSettings.tip.size = brushSize;
    saveBrushSettings(brushSettings);
    if (brushPanel) brushPanel.close();
    refreshOptions();
  }
  else if (e.key === "g" || e.key === "G") { tool = e.shiftKey ? "bucket" : "gradient"; highlight(); }
  else if (e.key === "t" || e.key === "T") { tool = "text"; highlight(); }
  else if (e.key === "v" || e.key === "V") { tool = "move"; highlight(); }
  // !shiftKey: Shift+C is Count, and this branch used to swallow it first.
  else if (!e.shiftKey && (e.key === "c" || e.key === "C")) { tool = "crop"; highlight(); }
  else if (e.key === "i" || e.key === "I") { tool = e.shiftKey ? "sampler" : "eyedropper"; highlight(); }
  else if (e.key === "r" || e.key === "R") { if (e.shiftKey) { tool = "ruler"; highlight(); } }
  else if (e.shiftKey && e.key.toLowerCase() === "c") { tool = "count"; highlight(); }
  else if (e.key === "o" || e.key === "O") { tool = "retouch"; highlight(); }
  else if (e.key === "j" || e.key === "J") { tool = "heal"; highlight(); }
  else if (e.key === "s" || e.key === "S") { tool = e.shiftKey ? "focus" : "clone"; highlight(); }
  else if (e.key === "q" || e.key === "Q") { toggleQuickMask(); }
  else if (e.key === "x" || e.key === "X") { swapColors(); }
  else if (e.key === "d" || e.key === "D") {
    // Help promises black AND white; this reset only the foreground.
    setForeground([0, 0, 0], false);
    bgColor = [255, 255, 255];
    bgWell.value = "#ffffff";
  }
  // AI2: Enter closes a pen path. This must come before the crop branches, or
  // an armed crop/perspective gesture swallows the key and the path is stuck.
  else if (e.key === "Enter" && tool === "polylasso" && polyPts.length > 0) {
    endPolyLasso(true, doc.width, doc.height); e.preventDefault(); }
  else if (e.key === "Enter" && tool === "pen" && penAnchors.length >= 2) { commitPenPath(); }
  // ui12: an armed crop belongs to the crop tool. Without the guard, drawing a
  // crop, switching to Brush and pressing Enter still cropped the document.
  else if (e.key === "Enter" && tool === "crop" && cropQuad) { applyPerspectiveNow(); }
  else if (e.key === "Enter" && tool === "crop" && cropRect) { applyCropNow(); }
  else if (e.key === "Escape" && brushPanel) {
    // A floating panel is not a modal: focus may be on the canvas while it is
    // open, so Escape has to be handled here, not only on the panel element.
    e.preventDefault();
    brushPanel.close();
  }
  else if (e.key === "Escape" && (handMode || zoomMode)) {
    handMode = false;
    zoomMode = false;
    syncCursor();
    e.preventDefault();
  }
  else if (e.key === "Escape" && endPolyLasso(false, doc.width, doc.height)) { e.preventDefault(); }
  else if (e.key === "Escape" && helpPanel) {
    // The popover owns focus when it is open, so it closes before the tool
    // branches below consume the key (uiux-r30 #5).
    closeHelpPanel(true);
    e.preventDefault();
  }
  else if (e.key === "Escape" && (rulerA || rulerB)) {
    rulerA = null; rulerB = null; rulerDrag = false;
    refreshOptions(); drawOverlay(); e.preventDefault();
  }
  else if (e.key === "Escape" && endFreeformPath(false, off.width, off.height)) { e.preventDefault(); }
        else if (e.key === "Escape" && cancelPenPath()) { e.preventDefault(); }
  else if (e.key === "Escape" && adjustPal && adjustPal.style.display !== "none") {
    closeAdjustPalette();
    e.preventDefault();
  }
  else if (e.key === "Escape" && menusOpen()) {
    closeMenus();
    e.preventDefault();
  }
  else if (e.key === "Escape") {
    if (shapeDrag) { shapeDrag = null; drawOverlay(); return; }
    if (textSel && !textEditing) { textSel = null; drawOverlay(); return; }
    if (cropQuad) { cancelPerspective(); return; } // AD2: the bar promised this
    if (cropRect) { cancelCrop(); return; }
    if (handMode || zoomMode) { handMode = false; zoomMode = false; syncCursor(); statusHint("View modes off"); return; }
    gradientDrag = false;
    commitText();
    deselect();
  }
  else if (tool === "move" && e.key.startsWith("Arrow")) {
    // AS1: never edit the document while the user is browsing a menu or a popup.
    // A keydown that some other handler already consumed is not ours either.
    // A focused History row or options control owns its arrows (uiux-r19 #1).
    const focusAt = e.target instanceof HTMLElement ? e.target : null;
    if (e.defaultPrevented || menusOpen()) return;
    if (focusAt?.closest("#panels, #options, .float-win, .overlay, .color-pop, .menu-pop")) return;
    // Photoshop nudges the active layer: 1px, or 10px with Shift
    const step = e.shiftKey ? 10 : 1;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const v = d[e.key];
    if (v) { e.preventDefault(); nudgeActive(v[0], v[1]); }
  }
  // AI2: with the pen armed, Delete/Backspace removes the last anchor — the
  // selection branch below used to eat the key and clear an unrelated selection.
  else if ((e.key === "Delete" || e.key === "Backspace") && tool === "polylasso" && polyPts.length > 0) {
    polyPts.pop();
    selGeom = polyPts.length >= 1 ? { kind: "poly", pts: polyPts } : null;
    drawOverlay();
    e.preventDefault();
  }
  else if ((e.key === "Delete" || e.key === "Backspace") && tool === "pen" && penAnchors.length > 0) {
    penAnchors.pop();
    selGeom = penAnchors.length >= 2 ? { kind: "poly", pts: flattenPath(penAnchors, false) } : null;
    drawOverlay();
    e.preventDefault();
  }
  else if ((e.key === "Delete" || e.key === "Backspace") && (selRect || selMask)) {
    // The help popover focuses its own DIV and keeps it; Delete there is a
    // request to the panel, not to the selection behind it (code-r26 #2).
    const at = document.activeElement as HTMLElement | null;
    // Same guard as the arrow keys above: a focused widget, popover or floating
    // panel owns Delete for itself, not for the canvas behind it (uiux-r27 #2).
    if (e.defaultPrevented ||
        at?.closest?.("#panels, #options, .float-win, .overlay, .color-pop, .menu-pop, #menubar, #toolbar, #tabs, #statusbar")) {
      e.preventDefault();
      return;
    }
    clearSelection();
  }
});

renderLayers();
renderHistoryPanel();

// ---- adjustments panel ---------------------------------------------------
type KindMeta = { min: number; max: number; def: number; label: (v: number) => string };
const KINDS: Record<AdjustmentKind, KindMeta> = {
  brightness: { min: -255, max: 255, def: 0, label: (v) => `Brightness ${v > 0 ? "+" : ""}${v}` },
  contrast: { min: -100, max: 100, def: 0, label: (v) => `Contrast ${v > 0 ? "+" : ""}${v}` },
  saturation: { min: -100, max: 100, def: 0, label: (v) => `Saturation ${v > 0 ? "+" : ""}${v}` },
  hue: { min: -180, max: 180, def: 0, label: (v) => `Hue ${v}°` },
  invert: { min: 0, max: 0, def: 0, label: () => "Invert" },
  grayscale: { min: 0, max: 0, def: 0, label: () => "Grayscale" },
  posterize: { min: 2, max: 32, def: 4, label: (v) => `Posterize ${v}` },
  threshold: { min: 1, max: 254, def: 128, label: (v) => `Threshold ${v}` },
};
cardHead(adjustBox, "sliders", "Adjustments");
const adjRow = document.createElement("div");
adjRow.className = "card-body inline-wrap";
adjustBox.appendChild(adjRow);

const adjSel = document.createElement("select");
for (const k of Object.keys(KINDS) as AdjustmentKind[]) {
  const o = document.createElement("option");
  o.value = k;
  o.textContent = k.charAt(0).toUpperCase() + k.slice(1);
  adjSel.appendChild(o);
}
adjSel.style.flex = "1 1 100%";

const adjSlider = document.createElement("input");
adjSlider.type = "range";
adjSlider.setAttribute("aria-label", "Amount");
const adjVal = document.createElement("span");
adjVal.className = "value";
adjVal.style.minWidth = "34px";

function syncAdjUI(): void {
  const meta = KINDS[adjSel.value as AdjustmentKind];
  adjSlider.min = String(meta.min);
  adjSlider.max = String(meta.max);
  adjSlider.step = "1";
  adjSlider.value = String(meta.def);
  adjSlider.style.display = meta.min === meta.max ? "none" : "";
  adjVal.textContent = meta.min === meta.max ? "" : String(meta.def);
  void adjVal.offsetWidth; // keep the span in layout even when empty
}
adjSel.addEventListener("change", syncAdjUI);
adjSlider.addEventListener("input", () => {
  adjVal.textContent = adjSlider.value;
});
/**
 * Downsampled proxy preview of the Adjustments card. Same op Apply runs, minus
 * the selection mask: the mask is document-sized, so it cannot be applied at
 * proxy scale — Apply still clips to it, the preview just shows the full frame.
 */
function previewAdjustment(): void {
  const kind = adjSel.value as AdjustmentKind;
  const amount = Number(adjSlider.value);
  queuePreview((g, rect) => {
    applyAdjustment(g, rect.x, rect.y, rect.w, rect.h, { kind, amount }, undefined);
  }, false);
}
adjSel.addEventListener("change", previewAdjustment);
adjSlider.addEventListener("input", previewAdjustment);

const adjApply = document.createElement("button");
adjApply.textContent = "Apply";
adjApply.className = "btn primary";
adjApply.addEventListener("click", () => {
  if (refuseGroupPixels(activeLayer)) return;
  if (refusePaintSurface(activeLayer)) return;
  const kind = adjSel.value as AdjustmentKind;
  const meta = KINDS[kind];
  const amount = Number(adjSlider.value);
  // selection clip: rect marquee → rect; arbitrary mask → mask bbox; else full doc
  const rect = selectionRect();
  if (rect.w <= 0 || rect.h <= 0) return;
  const label = meta.label(amount) + (selRect || selMask ? " (selection)" : "");
  const entry = layerOpCommand(activeLayer, label, () => {
    applyAdjustment(activeLayer.grid, rect.x, rect.y, rect.w, rect.h, { kind, amount }, selMask ?? undefined);
  });
  if (!entry) return;
  pushHist(entry);
  clearPreview();
  render();
  renderHistoryPanel();
});

adjRow.appendChild(adjSel);
adjRow.appendChild(adjSlider);
adjRow.appendChild(adjVal);
adjRow.appendChild(adjApply);
syncAdjUI();


// ---- tonal panel (Levels/Curves/exposure/… + histogram) -------------------
/** Signature shared by every tonal op (adjustment card + floating palette). */
type TonalOpFn = (g: TileGrid, r: Rect4, m: PixelMask | null) => void;

/** Shared runner for tonal ops: selection-clipped, ONE undo entry, live view. */
function runTonalOp(label: string, fn: TonalOpFn): void {
  if (refuseGroupPixels(activeLayer)) return;
  if (refusePaintSurface(activeLayer)) return;
  const rect = selectionRect();
  if (rect.w <= 0 || rect.h <= 0) return;
  const entry = layerOpCommand(activeLayer, label, () => {
    fn(activeLayer.grid, rect, selMask ?? null);
  });
  if (!entry) return;
  pushHist(entry);
  render();
  renderHistoryPanel();
  pulse(adjustBox);
}

const tonalPanel = buildTonalPanel({
  panels,
  cardHead: (box, icon, title) => { const el = cardHead(box, icon, title); return el; },
  // A tonal dialog never refuses OK today, but the adapter must still forward
  // the contract instead of flattening it: the old `() => { onOk(); … }` turned
  // a refusal into a close, so any future validation would vanish on click.
  showModal: (title, body, onOk, opts) => showModal(title, body, () => {
    if (onOk() === false) return false;
    tonalPanel.refreshHistogram();
  }, opts),
  targetRect: () => {
    const rect = selectionRect();
    return rect.w > 0 && rect.h > 0 ? rect : null;
  },
  targetMask: () => selMask,
  hasSelection: () => !!(selRect || selMask),
  activeGrid: () => (activeLayer.locked ? null : activeLayer.grid),
  docSize: () => ({ w: doc.width, h: doc.height }),
  run: runTonalOp,
  foreground: () => [color[0], color[1], color[2]],
  pulse: (el) => pulse(el),
  // live preview: same proxy path the Filters/Adjustments cards use
  preview: (fn) => queuePreview((g, rect) => fn(g, rect, null), false),
  clearPreview: () => clearPreview(),
});

// ---- filters panel ------------------------------------------------------
/** one row per available filter: the panel and the Filter menu share this list */
interface FilterSpec {
  id: string;
  group: string;
  label: string;
  min: number;
  max: number;
  def: number;
  /** human label for the current slider value */
  fmt: (v: number) => string;
  /** apply to `grid`'s `rect` with the slider value as the main parameter.
   *  Takes the grid rather than closing over the active layer so the same
   *  recipe can run on a downsampled proxy for the live preview. */
  run: (g: TileGrid, rect: F2Rect, v: number, mask?: PixelMask) => void;
}

const FILTERS: FilterSpec[] = [
  {
    id: "blur", group: "Blur", label: "Gaussian Blur", min: 1, max: 25, def: 4,
    fmt: (v) => `σ${v}`,
    run: (g, r, v, m) => applyFilter(g, r.x, r.y, r.w, r.h, { kind: "blur", amount: v }, m),
  },
  {
    id: "motion", group: "Blur", label: "Motion Blur", min: 1, max: 60, def: 12,
    fmt: (v) => `${v}px`,
    run: (g, r, v, m) => f2.motionBlur(g, r, 0, v, m),
  },
  {
    id: "radial-zoom", group: "Blur", label: "Radial Blur (zoom)", min: 1, max: 100, def: 30,
    fmt: (v) => `${v}`,
    run: (g, r, v) => f2.radialBlur(g, r, v, "zoom"),
  },
  {
    id: "radial-spin", group: "Blur", label: "Radial Blur (spin)", min: 1, max: 100, def: 20,
    fmt: (v) => `${v}`,
    run: (g, r, v) => f2.radialBlur(g, r, v, "spin"),
  },
  {
    id: "box", group: "Blur", label: "Box Blur", min: 1, max: 30, def: 5,
    fmt: (v) => `${v}px`,
    run: (g, r, v, m) => f2.boxBlur(g, r, v, 2, m),
  },
  {
    id: "sharpen", group: "Sharpen", label: "Sharpen", min: 1, max: 100, def: 50,
    fmt: (v) => `${v}`,
    run: (g, r, v, m) => applyFilter(g, r.x, r.y, r.w, r.h, { kind: "sharpen", amount: v }, m),
  },
  {
    id: "unsharp", group: "Sharpen", label: "Unsharp Mask", min: 1, max: 100, def: 50,
    fmt: (v) => `${v}%`,
    run: (g, r, v, m) => applyFilter(g, r.x, r.y, r.w, r.h, { kind: "unsharp", amount: v }, m),
  },
  {
    id: "noise", group: "Noise", label: "Add Noise", min: 1, max: 100, def: 25,
    fmt: (v) => `±${v}`,
    run: (g, r, v, m) => applyFilter(g, r.x, r.y, r.w, r.h, { kind: "noise", amount: v }, m),
  },
  {
    id: "median", group: "Noise", label: "Median", min: 1, max: 6, def: 2,
    fmt: (v) => `${v}px`,
    run: (g, r, v, m) => f2.medianFilter(g, r, v, m),
  },
  {
    id: "dust", group: "Noise", label: "Dust & Scratches", min: 1, max: 5, def: 2,
    fmt: (v) => `${v}px`,
    run: (g, r, v, m) => f2.dustScratches(g, r, v, m),
  },
  {
    id: "pinch", group: "Distort", label: "Pinch", min: 1, max: 100, def: 40,
    fmt: (v) => `${v}%`,
    run: (g, r, v) => f2.spherize(g, r, v, "pinch"),
  },
  {
    id: "spherize", group: "Distort", label: "Spherize", min: 1, max: 100, def: 50,
    fmt: (v) => `${v}%`,
    run: (g, r, v) => f2.spherize(g, r, v, "spherize"),
  },
  {
    id: "twirl", group: "Distort", label: "Twirl", min: 1, max: 360, def: 120,
    fmt: (v) => `${v}°`,
    run: (g, r, v) => f2.twirl(g, r, v),
  },
  {
    id: "ripple", group: "Distort", label: "Ripple", min: 1, max: 40, def: 10,
    fmt: (v) => `${v}px`,
    run: (g, r, v) => f2.ripple(g, r, v, 30),
  },
  {
    id: "wave", group: "Distort", label: "Wave", min: 1, max: 40, def: 10,
    fmt: (v) => `${v}px`,
    run: (g, r, v) => f2.wave(g, r, v, 60),
  },
  {
    id: "polar", group: "Distort", label: "Polar Coordinates", min: 0, max: 1, def: 0,
    fmt: (v) => (v === 0 ? "rect → polar" : "polar → rect"),
    run: (g, r, v) => f2.polarCoordinates(g, r, v === 0 ? "rect-to-polar" : "polar-to-rect"),
  },
  {
    id: "find-edges", group: "Stylize", label: "Find Edges", min: 0, max: 0, def: 0,
    fmt: () => "",
    run: (g, r, _v, m) => f2.findEdges(g, r, m),
  },
  {
    id: "emboss", group: "Stylize", label: "Emboss", min: 30, max: 300, def: 135,
    fmt: (v) => `${v}°`,
    run: (g, r, v) => f2.emboss(g, r, v, 3, 100),
  },
  {
    id: "solarize", group: "Stylize", label: "Solarize", min: 1, max: 254, def: 128,
    fmt: (v) => `>${v}`,
    run: (g, r, v) => f2.solarize(g, r, v),
  },
  {
    id: "trace", group: "Stylize", label: "Trace Contour", min: 1, max: 254, def: 128,
    fmt: (v) => `level ${v}`,
    run: (g, r, v) => f2.traceContour(g, r, v),
  },
  {
    id: "oil", group: "Stylize", label: "Oil Paint", min: 1, max: 8, def: 4,
    fmt: (v) => `${v}px`,
    run: (g, r, v) => f2.oilPaint(g, r, v, 12),
  },
  {
    id: "clouds", group: "Render", label: "Clouds", min: 1, max: 40, def: 8,
    fmt: (v) => `seed ${v}`,
    run: (g, r, v) => f2.clouds(g, r, v, 1, "clouds"),
  },
  {
    id: "difference-clouds", group: "Render", label: "Difference Clouds", min: 1, max: 40, def: 8,
    fmt: (v) => `seed ${v}`,
    run: (g, r, v) => f2.clouds(g, r, v, 1, "difference"),
  },
  {
    id: "lens-flare", group: "Render", label: "Lens Flare", min: 10, max: 200, def: 100,
    fmt: (v) => `${v}%`,
    run: (g, r, v) => f2.lensFlare(g, r, r.x + r.w / 2, r.y + r.h / 2, v),
  },
  {
    id: "pixelate", group: "Pixelate", label: "Mosaic", min: 2, max: 64, def: 8,
    fmt: (v) => `${v}px`,
    run: (g, r, v, m) => applyFilter(g, r.x, r.y, r.w, r.h, { kind: "pixelate", amount: v }, m),
  },
  {
    id: "crystallize", group: "Pixelate", label: "Crystallize", min: 3, max: 40, def: 10,
    fmt: (v) => `${v}px`,
    run: (g, r, v) => f2.crystallize(g, r, v),
  },
  {
    id: "high-pass", group: "Other", label: "High Pass", min: 1, max: 40, def: 10,
    fmt: (v) => `${v}px`,
    run: (g, r, v) => f2.highPass(g, r, v),
  },
  {
    id: "offset", group: "Other", label: "Offset", min: 1, max: 200, def: 40,
    fmt: (v) => `${v}px`,
    run: (g, r, v) => f2.offsetFilter(g, r, v, Math.round(v / 2)),
  },
  {
    id: "minimum", group: "Other", label: "Minimum", min: 1, max: 8, def: 2,
    fmt: (v) => `${v}px`,
    run: (g, r, v) => f2.minMax(g, r, v, "minimum"),
  },
  {
    id: "maximum", group: "Other", label: "Maximum", min: 1, max: 8, def: 2,
    fmt: (v) => `${v}px`,
    run: (g, r, v) => f2.minMax(g, r, v, "maximum"),
  },
];

const filterBox = document.createElement("div");
filterBox.className = "card";
panels.appendChild(filterBox);
cardHead(filterBox, "funnel", "Filters");
const fRow = document.createElement("div");
fRow.className = "card-body inline-wrap";
filterBox.appendChild(fRow);

const fSel = document.createElement("select");
{
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const spec of FILTERS) {
    let grp = groups.get(spec.group);
    if (!grp) {
      grp = document.createElement("optgroup");
      grp.label = spec.group;
      groups.set(spec.group, grp);
      fSel.appendChild(grp);
    }
    const o = document.createElement("option");
    o.value = spec.id;
    o.textContent = spec.label;
    grp.appendChild(o);
  }
}
fSel.style.flex = "1 1 100%";

const fSlider = document.createElement("input");
fSlider.type = "range";
fSlider.setAttribute("aria-label", "Amount");
const fVal = document.createElement("span");
fVal.className = "value";
fVal.style.minWidth = "46px";

function currentFilter(): FilterSpec {
  return FILTERS.find((s) => s.id === fSel.value) ?? FILTERS[0]!;
}

function syncFUI(): void {
  const spec = currentFilter();
  const fixed = spec.max <= spec.min;
  fSlider.disabled = fixed;
  fSlider.min = String(spec.min);
  fSlider.max = String(spec.max);
  fSlider.step = "1";
  fSlider.value = String(spec.def);
  fVal.textContent = fixed ? "" : spec.fmt(spec.def);
}
/**
 * Live preview for destructive pixel ops (filters, adjustments). The recipe is
 * run on a downsampled proxy of the target rect, so a 25 px median or oil paint
 * cannot stall the slider at document resolution; the proxy is drawn back at
 * document scale with nearest sampling. It previews structure and colour, and
 * is deliberately not pixel-exact — the committed result is full resolution.
 */
const PREVIEW_MAX = 420;
// AA1: one scheduler owns the frame. The old pair of flags (previewPending +
// previewRun) deadlocked on the first slider touch: queueFilterPreview set the
// flag and then called queuePreview, which returned early because of it.
// src/ui/previewqueue.ts has the regression test.
const previewSched = createPreviewScheduler((cb) => { requestAnimationFrame(cb); });
previewCancel = () => { previewSched.cancel(); };
let previewRun: ((g: TileGrid, rect: F2Rect, mask: SelectionMask | null) => void) | null = null;

/**
 * Nearest-neighbour downsample of one document rect into a proxy grid.
 *
 * Nearest rather than bilinear on purpose: the proxy is a stand-in for "what
 * would this look like", and bilinear would blur exactly the detail a sharpening
 * or edge filter is judged on.
 */
function downsampleInto(
  dst: TileGrid,
  src: TileGrid,
  rect: { x: number; y: number; w: number; h: number },
  sw: number,
  sh: number,
  k: number,
): void {
  // AR1: sample one source row per proxy row. Reading the whole rect first
  // allocated rect.w x rect.h x 4 bytes per layer (67 MB at 4096s, 1.07 GB at
  // 16384s) to produce a 420-px proxy, and rect is the whole canvas whenever
  // nothing is selected. Nearest sampling only ever reads one row per output row,
  // so the peak here is rect.w x 4.
  const rowPx = new Uint8ClampedArray(rect.w * 4);
  const small = new Uint8ClampedArray(sw * sh * 4);
  for (let yy = 0; yy < sh; yy++) {
    const sy = Math.min(rect.h - 1, Math.floor(yy / k));
    src.readRect(rect.x, rect.y + sy, rect.w, 1, rowPx);
    for (let xx = 0; xx < sw; xx++) {
      const sx = Math.min(rect.w - 1, Math.floor(xx / k));
      const si = sx * 4;
      const di = (yy * sw + xx) * 4;
      small[di] = rowPx[si]!;
      small[di + 1] = rowPx[si + 1]!;
      small[di + 2] = rowPx[si + 2]!;
      small[di + 3] = rowPx[si + 3]!;
    }
  }
  dst.writeRect(0, 0, sw, sh, small);
}

/** AJ1: a layer mask has to survive the downsample, or the preview lies about holes. */
function downsampleMaskInto(
  dst: Layer,
  mask: TileGrid,
  rect: { x: number; y: number; w: number; h: number },
  sw: number,
  sh: number,
  k: number,
): void {
  const grid = new TileGrid(sw, sh);
  for (let yy = 0; yy < sh; yy++) {
    const sy = rect.y + Math.min(rect.h - 1, Math.floor(yy / k));
    for (let xx = 0; xx < sw; xx++) {
      const sx = rect.x + Math.min(rect.w - 1, Math.floor(xx / k));
      setMaskAt(grid, xx, yy, maskAt(mask, sx, sy));
    }
  }
  dst.mask = grid;
}

/** The selection, at proxy scale, for recipes that respect feathering. */
function downsampleSelection(
  mask: SelectionMask,
  rect: { x: number; y: number; w: number; h: number },
  sw: number,
  sh: number,
  k: number,
): SelectionMask {
  const out = new SelectionMask(sw, sh);
  for (let yy = 0; yy < sh; yy++) {
    const sy = rect.y + Math.min(rect.h - 1, Math.floor(yy / k));
    for (let xx = 0; xx < sw; xx++) {
      const sx = rect.x + Math.min(rect.w - 1, Math.floor(xx / k));
      out.setAlpha(xx, yy, mask.alphaAt(sx, sy));
    }
  }
  return out;
}

/**
 * AL3: the downsampled stack is rebuilt only when the *inputs* change, not on
 * every slider tick. A 1 MP document inside a 420 px proxy means a `k` of ~0.4,
 * so the old version re-read and re-downsampled every layer of a 16384² stack on
 * every pointermove — the drag got slower the larger the document, which is
 * exactly backwards.
 */
interface ProxyCache {
  key: string;
  preview: Document;
  target: Layer;
  proxyRect: F2Rect;
  proxyMask: SelectionMask | null;
  sw: number;
  sh: number;
  k: number;
  /** AL3: the unfiltered target pixels, so a second tick does not filter a filter */
  pristine: Uint8ClampedArray;
}
let proxyCache: ProxyCache | null = null;

/** AQ3: stable identity per Document, so a tab switch always invalidates the key. */
const docIds = new WeakMap<Document, number>();
let nextDocId = 1;
function docIdentity(d: Document): number {
  let id = docIds.get(d);
  if (id === undefined) { id = nextDocId++; docIds.set(d, id); }
  return id;
}

function previewKey(rect: F2Rect, k: number, layer: Layer): string {
  // AQ3: keyed on a monotonic edit counter, document identity and the mask's
  // content stamp — never on `history.position`, which saturates once eviction
  // starts (index goes up on push and back down on shift).
  return proxyKey({
    docId: docIdentity(doc),
    width: doc.width,
    height: doc.height,
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    scale: k,
    revision: doc.revision,
    layerCount: doc.layerCount(),
    layerId: layer.id,
    maskStamp: layer.mask ? layer.mask.stamp() : 0,
    maskHidden: layer.maskHide === true,
  });
}

function buildProxyTo(
  preview: Document,
  src: Layer,
  parent: Layer | null,
  rect: F2Rect,
  k: number,
  sw: number,
  sh: number,
  targetLayer: Layer,
): Layer | null {
  // P3: group children were invisible here because the old loop walked only
  // `doc.layers`. Rebuild the tree recursively so a filter preview on a grouped
  // layer includes its group context instead of clearing to a blank canvas.
  if (src.kind === "group") {
    const dst = parent ? preview.addGroupTo(parent, src.name) : preview.addGroup(src.name);
    cloneLayerMeta(dst, src);
    dst.passThrough = src.passThrough;
    let hit: Layer | null = null;
    for (const child of src.children ?? []) {
      const found = buildProxyTo(preview, child, dst, rect, k, sw, sh, targetLayer);
      if (found) hit = found;
    }
    return hit;
  }
  const dst = parent ? preview.addLayerTo(parent, src.name) : preview.addLayer(src.name);
  cloneLayerMeta(dst, src);
  if (src.kind === "pixel") downsampleInto(dst.grid, src.grid, rect, sw, sh, k);
  if (src.mask) downsampleMaskInto(dst, src.mask, rect, sw, sh, k);
  return src === targetLayer ? dst : null;
}

function buildProxy(rect: F2Rect, k: number, layer: Layer, sw: number, sh: number): ProxyCache | null {
  const key = previewKey(rect, k, layer);
  if (proxyCache && proxyCache.key === key && proxyCache.sw === sw && proxyCache.sh === sh) return proxyCache;
  // AJ2: the preview must show what Apply would produce — this layer inside its
  // stack, at its own opacity and blend mode — not the layer alone pasted over
  // a composite that already contains it (that is why a 50 % layer previewed at
  // 100 % and Multiply previewed as Normal).
  const preview = new Document(sw, sh);
  let target: Layer | null = null;
  for (const src of doc.layers) {
    const found = buildProxyTo(preview, src, null, rect, k, sw, sh, layer);
    if (found) target = found;
  }
  if (!target) return null;
  const proxyRect: F2Rect = { x: 0, y: 0, w: sw, h: sh };
  const proxyMask = selMask ? downsampleSelection(selMask, rect, sw, sh, k) : null;
  const pristine = new Uint8ClampedArray(sw * sh * 4);
  target.grid.readRect(0, 0, sw, sh, pristine);
  proxyCache = { key, preview, target, proxyRect, proxyMask, sw, sh, k, pristine };
  return proxyCache;
}

function renderProxyPreview(): void {
  const run = previewRun;
  const layer = activeLayer;
  if (!run || !layer || layer.locked) { clearPreview(); return; }
  const rect = selectionRect();
  if (rect.w <= 0 || rect.h <= 0) { clearPreview(); return; }
  const k = Math.min(1, PREVIEW_MAX / Math.max(rect.w, rect.h));
  const sw = Math.max(1, Math.round(rect.w * k));
  const sh = Math.max(1, Math.round(rect.h * k));
  const cache = buildProxy(rect, k, layer, sw, sh);
  if (!cache) { clearPreview(); return; }
  // AJ1: the proxy mask goes to the recipe, and the recipe decides — exactly
  // like Apply does. A recipe that ignores feathering is flagged on the badge
  // instead of being quietly blended here, because a preview that is more
  // generous than the commit is worse than no preview.
  // AL3: the proxy stack is cached, so the target must start from its pristine
  // pixels on every tick — otherwise dragging a slider filters an already
  // filtered proxy and the preview drifts away from what Apply would do.
  cache.target.grid.writeRect(0, 0, cache.sw, cache.sh, cache.pristine);
  run(cache.target.grid, cache.proxyRect, previewJobMaskAware ? cache.proxyMask : null);
  const out = new Uint8ClampedArray(cache.sw * cache.sh * 4);
  cache.preview.compositeRect(0, 0, cache.sw, cache.sh, out);
  setPreview(rect, out, cache.sw, cache.sh, k < 1);
}

/**
 * Queue a preview for the next frame. The recipe is re-evaluated on that frame
 * from live controls, so a fast drag collapses into one render.
 */
function queuePreview(
  run: (g: TileGrid, rect: F2Rect, mask: SelectionMask | null) => void,
  maskAware: boolean,
): void {
  previewRun = run;
  previewJobMaskAware = maskAware;
  previewSched.queue(renderProxyPreview);
}

/** Filter slider/select path — the recipe reads the controls when it fires. */
function queueFilterPreview(): void {
  queuePreview((g, rect, mask) => {
    const spec = currentFilter();
    const amount = Number(fSlider.value);
    // Mirrors the Apply path: recipes that take a mask get it, the rest are
    // wrapped so the preview and the commit cannot disagree.
    if (spec.run.length >= 4) spec.run(g, rect, amount, mask ?? undefined);
    else f2.withSelectionMask(g, rect, mask, () => { spec.run(g, rect, amount); });
  }, true);
}

fSel.addEventListener("change", () => { syncFUI(); queueFilterPreview(); });
fSlider.addEventListener("input", () => {
  fVal.textContent = currentFilter().fmt(Number(fSlider.value));
  queueFilterPreview();
});

const fApply = document.createElement("button");
fApply.textContent = "Apply";
fApply.className = "btn primary";
fApply.addEventListener("click", () => {
  if (refuseGroupPixels(activeLayer)) return;
  if (refusePaintSurface(activeLayer)) return;
  const spec = currentFilter();
  const amount = Number(fSlider.value);
  // selection clip: same rule as adjustments — rect marquee, mask bbox, else full doc
  const rect = selectionRect();
  if (rect.w <= 0 || rect.h <= 0) return;
  const suffix = spec.max > spec.min && spec.fmt(amount) ? ` ${spec.fmt(amount)}` : "";
  // Filters that take a mask blend it themselves; the rest go through
  // withSelectionMask, so every filter honours the selection and the label can
  // say so honestly.
  const honoursMask = spec.run.length >= 4;
  const selectionUsed = selRect || selMask;
  const label = spec.label + suffix + (selectionUsed ? " (selection)" : "");
  const entry = layerOpCommand(activeLayer, label, () => {
    if (honoursMask) spec.run(activeLayer.grid, rect, amount, selMask ?? undefined);
    else f2.withSelectionMask(activeLayer.grid, rect, selMask, () => spec.run(activeLayer.grid, rect, amount));
  });
  if (!entry) return;
  pushHist(entry);
  clearPreview();
  render();
  renderHistoryPanel();
});

fRow.appendChild(fSel);
fRow.appendChild(fSlider);
fRow.appendChild(fVal);
fRow.appendChild(fApply);
syncFUI();

window.addEventListener("resize", resize);
resizeBuffers();
fit();
render();

// ---- Space-to-pan and the unsaved-changes guard -------------------------
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || modalOpen()) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
  if (!spaceDown) { spaceDown = true; syncCursor(); }
  e.preventDefault(); // Space must not scroll the panel column
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  spaceDown = false;
  panning = false;
  panGrab = null;
  syncCursor();
});
window.addEventListener("blur", () => {
  spaceDown = false;
  // an open text box must not be lost by alt-tabbing: the box has no other
  // close-out path (closeGesture covers gestures, not the editor)
  if (textEditing) commitText();
  // leaving the window mid-stroke used to resume painting on return
  closeGesture();
  endPan();
  hideContextMenu(); // a context menu must not act while the window is unfocused
  syncCursor();
});

/** True when any tab holds work that was never written to a file. */
function anyUnsaved(): boolean {
  captureTab();
  return anyTabDirty();
}
window.addEventListener("beforeunload", (e) => {
  if (!anyUnsaved()) return;
  e.preventDefault();
  e.returnValue = "";
});


// the boot document becomes tab 0
seedBootTab({ name: "Untitled", doc, activeLayer, history: session.current, collapsed: session.collapsed, flat: flatCache.snapshot(), selRect, selMask, selGeom, scale, panX, panY, autosaveDirty, dirty: false });
renderTabs();

// ---- autosave / crash recovery (OPFS — fully local, never leaves the disk) --
const AUTOSAVE_FILE = "guazzo-autosave.json";
// A crashed session is moved here at boot. The live slot keeps autosaving the
// current session, so opening a file during recovery cannot leave the work
// since that open unwritten (sec-r33 #1).
const AUTOSAVE_RECOVERY_FILE = "guazzo-autosave-recovery.json";
// When two snapshots survive a crash, the one the bar offers is copied into the
// recovery slot and the other into this one, so the live slot stays free for the
// session on screen (code-r36 #1/#2).
const AUTOSAVE_PARKED_FILE = "guazzo-autosave-older.json";
/** A third distinct crash session, kept so a later boot cannot overwrite it. */
const AUTOSAVE_ARCHIVE_FILE = "guazzo-autosave-archive.json";
/** Set by Restore; the recovery/parked slots go after the restored tabs are safely written. */
let autosaveDropAfterWrite = false;
/** The snapshot Restore wrote to disk, so only its own copies are dropped. */
let autosaveDropBytes: Uint8Array | null = null;
const AUTOSAVE_RETRY_MS = 20_000;

// structural types only — no dependence on lib.dom OPFS typings
interface AutosaveFileHandleLike {
  getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
}
interface AutosaveRootLike {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<AutosaveFileHandleLike>;
  removeEntry(name: string): Promise<void>;
}

async function opfs(): Promise<AutosaveRootLike | null> {
  try {
    const st = (navigator as unknown as { storage?: { getDirectory?: () => Promise<AutosaveRootLike> } }).storage;
    return st && st.getDirectory ? await st.getDirectory() : null;
  } catch {
    return null;
  }
}

let autosaveInFlight = false;
let autosaveBackoffTicks = 0;
let autosaveFailed = false;
const AUTOSAVE_MAX_BACKOFF_TICKS = 15; // 15 × 20 s = 5 min

function autosaveFailedNotice(err?: unknown): void {
  if (err !== undefined) console.error("autosave write failed", err);
  autosaveBackoffTicks = Math.min(
    AUTOSAVE_MAX_BACKOFF_TICKS,
    autosaveBackoffTicks ? autosaveBackoffTicks * 2 : 1,
  );
  autosaveScheduler?.retryAfter(autosaveBackoffTicks * AUTOSAVE_RETRY_MS);
  if (!autosaveFailed) {
    autosaveFailed = true;
    statusError("Autosave failed — changes are still only in this window.", "autosave");
  }
}

function autosaveSucceeded(): void {
  autosaveBackoffTicks = 0;
  if (autosaveFailed) {
    autosaveFailed = false;
    // the persistent red banner belonged to the failure that just ended
    clearStatusError("autosave");
    statusHint("Autosave saved");
  }
}

async function writeAutosave(): Promise<void> {
  if (transform) return; // a live transform has no committed pixels
  // The recovery bar does NOT gate this write: the crashed snapshot lives in
  // AUTOSAVE_RECOVERY_FILE, and the session on screen owns AUTOSAVE_FILE. Gating
  // it here meant every edit made during recovery was never written (sec-r33 #1).
  if (autosaveInFlight) return; // two ticks must never open two writable handles
  captureTab(); // the active tab's dirty flag lives in its slot
  const tabs = tabsView().slice();
  const pending = tabs.filter(t => t.autosaveDirty);
  if (!pending.length) return;

  // Clear the flags BEFORE the first await. An edit that happens while the
  // streaming encoder yields sets the flag again; the revision check below
  // catches the same edit changing a document under the encoder.
  // The reader refuses a blob with more tiles than MAX_AUTOSAVE_TILES, and it
  // counts grids and masks across every tab. Count them here, before encoding:
  // a snapshot the reader will reject is worse than no snapshot, because it says
  // "saved" and then finds nothing after a crash (code-r8 #2).
  // The reader refuses a snapshot with more than MAX_TABS tabs, so a session
  // that grew past it would be written and then recover nothing (code-r9 #1).
  if (tabs.length > MAX_TABS) {
    for (const t of tabs) t.autosaveDirty = true;
    autosaveScheduler?.retryAfter(AUTOSAVE_MAX_BACKOFF_TICKS * AUTOSAVE_RETRY_MS);
    statusError(
      `This session has ${tabs.length} tabs and autosave keeps ${MAX_TABS} — save your work to a file to keep it.`,
      "autosave",
    );
    return;
  }
  let tiles = 0;
  for (const t of tabs) tiles += projectTileCount(t.doc);
  if (tiles > MAX_AUTOSAVE_TILES) {
    for (const t of tabs) t.autosaveDirty = true;
    autosaveScheduler?.retryAfter(AUTOSAVE_MAX_BACKOFF_TICKS * AUTOSAVE_RETRY_MS);
    statusError(
      `This session needs ${tiles} tile slots and autosave keeps ${MAX_AUTOSAVE_TILES} — save your work to a file to keep it.`,
      "autosave",
    );
    return;
  }
  let layers = 0;
  for (const t of tabs) layers += t.doc.allLayers().length;
  if (layers > MAX_AUTOSAVE_LAYERS) {
    // The reader refuses this snapshot; writing it would say "saved" and then
    // recover nothing after a crash (code-r23 #1).
    for (const t of tabs) t.autosaveDirty = true;
    autosaveScheduler?.retryAfter(AUTOSAVE_MAX_BACKOFF_TICKS * AUTOSAVE_RETRY_MS);
    statusError(
      `This session has ${layers} layers and autosave keeps ${MAX_AUTOSAVE_LAYERS} — save your work to a file to keep it.`,
      "autosave",
    );
    return;
  }
  for (const t of pending) t.autosaveDirty = false;
  // Sample the edit epoch BEFORE the encode: undo bumps the epoch but not
  // `doc.revision`, so an undo during encode/OPFS would otherwise be stamped
  // clean although its bytes are not in the blob (code-r27 #2).
  const epochAtWrite = editEpoch;
  const revisions = tabs.map(t => t.doc.revision);
  let bytes: Uint8Array;
  try {
    bytes = await encodeAutosaveSnapshotV2({
      savedAt: Date.now(),
      active: activeIndex(),
      tabs: tabs.map(t => ({ name: t.name, doc: t.doc })),
      // A session with nothing unsaved is not a crash to recover from; marking
      // it lets the next boot drop the file instead of offering it (code-r37 #3).
      clean: tabsView().every((t) => !t.dirty),
    });
    // The v2 encoder yields to the event loop between slices, so the user can
    // edit (or close a tab) mid-snapshot. Refuse to write a mix of two states:
    // leave every tab dirty and try again on the next tick.
    const after = tabsView();
    const stable = after.length === tabs.length &&
      tabs.every((t, i) => after[i] === t && t.doc.revision === revisions[i]);
    if (!stable) {
      for (const t of tabs) t.autosaveDirty = true;
      autosaveScheduler?.retryAfter(0);
      return;
    }
    // The reader refuses a snapshot above this size, so writing one would
    // report "saved" and then fail to restore it (sec-r8 F4).
    if (bytes.byteLength > MAX_JSON_BYTES) {
      for (const t of tabs) t.autosaveDirty = true;
      autosaveScheduler?.retryAfter(AUTOSAVE_MAX_BACKOFF_TICKS * AUTOSAVE_RETRY_MS);
      statusError(
        "This session is too large to autosave — save your work to a file to keep it.",
        "autosave",
      );
      return;
    }
  } catch (err) {
    for (const t of pending) t.autosaveDirty = true; // keep it dirty, try later
    autosaveFailedNotice(err);
    return;
  }

  autosaveInFlight = true;
  try {
    const root = await opfs();
    if (!root) { for (const t of pending) t.autosaveDirty = true; autosaveFailedNotice(); return; }
    const fh = await root.getFileHandle(AUTOSAVE_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    // An edit during the write is NOT in these bytes: leaving the flag set makes
    // the scheduled tick run again instead of recording the session as saved.
    if (editEpoch === epochAtWrite) autosaveDirty = false;
    autosaveSucceeded();
    if (autosaveDropAfterWrite) {
      // Restore asked for this: the restored tabs are on disk now, so the two
      // crash slots can go. Deleting them before this write would leave the
      // restored session with no snapshot at all (code-r36 #2).
      autosaveDropAfterWrite = false;
      await dropSnapshotCopies(
        [AUTOSAVE_RECOVERY_FILE, AUTOSAVE_PARKED_FILE, AUTOSAVE_ARCHIVE_FILE],
        autosaveDropBytes,
      );
      autosaveDropBytes = null;
    }
  } catch (err) {
    // storage full or unavailable: keep the documents dirty and back off
    for (const t of pending) t.autosaveDirty = true;
    autosaveFailedNotice(err);
  } finally {
    autosaveInFlight = false;
  }
}

autosaveScheduler = new AutosaveScheduler(() => writeAutosave(), {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms) as unknown as AutosaveTimer,
  clearTimeout: (id) => window.clearTimeout(id as unknown as number),
});

let recoveryBar: HTMLDivElement | null = null;
function hideRecoveryBar(): void {
  if (recoveryBar) { recoveryBar.remove(); recoveryBar = null; }
  recoveryOlderSavedAt = null;
}
interface AutosaveEntry { name?: unknown; project?: unknown; restored?: Document; warnings?: string[] }

/** Replace the session with the documents in `entries`; returns what happened. */
function restoreSnapshotEntries(entries: AutosaveEntry[]): { restored: number; failed: number; failedNames: string[] } {
  let restored = 0;
  let failed = 0;
  const failedNames: string[] = [];
  for (const e of entries) {
    try {
      let nd: Document;
      let warnings: string[] = [];
      if (e.restored instanceof Document) {
        nd = e.restored;
        warnings = e.warnings ?? [];
      } else {
        const loaded = deserializeProject(e.project);
        nd = loaded.doc;
        warnings = loaded.warnings;
      }
      const name = typeof e.name === "string" && e.name ? e.name : "Restored";
      replaceDocument(nd, undefined, name);
      // The work came from a crash, not from a file: it must look unsaved.
      markActiveDirty();
      markDirty();
      if (warnings.length > 0) console.warn(`restored "${name}" with repairs`, warnings);
      restored++;
    } catch (err) {
      failed++;
      failedNames.push(typeof e.name === "string" && e.name ? e.name : "Untitled");
      console.error("autosave restore failed", err);
    }
  }
  return { restored, failed, failedNames };
}

let recoveryOfferedBytes: Uint8Array | null = null;
let recoveryOlderSavedAt: number | null = null;

/** Replace the question with its answer: a note plus Close, focus kept in the bar. */
function settleRecoveryBar(message: string, appendOlderNotice: boolean): void {
  if (!recoveryBar) return;
  const label = recoveryBar.querySelector("#recovery-label");
  if (label) {
    // Callers that already name the earlier snapshot pass false; the old
    // substring heuristic appended a second, conflicting sentence to them
    // (uiux-r45 N1).
    label.textContent = recoveryOlderSavedAt !== null && appendOlderNotice
      ? `${message} An earlier autosave from ${new Date(recoveryOlderSavedAt).toLocaleString()} is still on disk — relaunch Guazzo and use "Restore … instead".`
      : message;
  }
  for (const b of Array.from(recoveryBar.querySelectorAll("button"))) b.remove();
  const close = document.createElement("button");
  close.textContent = "Close";
  close.style.cssText = "background:#2b3644;color:#dfe6ee;border:0;border-radius:4px;padding:4px 10px;cursor:pointer";
  close.addEventListener("click", () => {
    hideRecoveryBar();
    ((document.querySelector("#tabs .tab.active") as HTMLElement | null)
      ?? (layersBody.querySelector(".row.active") as HTMLElement | null))?.focus();
  });
  recoveryBar.appendChild(close);
  close.focus();
}

function showRecoveryBar(savedAt: number, entries: AutosaveEntry[], olderSavedAt?: number, offeredBytes?: Uint8Array, olderSnap?: SnapshotFile | null): void {
  if (recoveryBar) return;
  const host = document.getElementById("canvas-host")!;
  const bar = document.createElement("div");
  // Announced and reachable: this is the one screen where lost work is decided
  // (uiux-r36 #2).
  // role=alert is already assertive; pairing it with aria-live=polite sent two
  // contradictory politeness hints to a screen reader (uiux-r39 F5).
  bar.setAttribute("role", "alert");
  bar.setAttribute("aria-label", "Recovered work");
  bar.style.cssText = "position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:30;" +
    "background:#1f2733;border:1px solid #3a4a5f;border-radius:6px;padding:8px 12px;" +
    "display:flex;gap:10px;align-items:center;font:12px system-ui;color:#d8dee6;" +
    "max-width:calc(100% - 16px);flex-wrap:wrap;justify-content:center;overflow-wrap:anywhere;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.5)";
  const when = new Date(savedAt).toLocaleString();
  const label = document.createElement("span");
  label.id = "recovery-label";
  label.style.cssText = "min-width:0;white-space:normal;overflow-wrap:anywhere;flex:1 1 240px";
  label.textContent = `Found an unsaved autosave from ${when}` + (entries.length > 1 ? ` (${entries.length} documents)` : "") +
    (olderSavedAt ? ` — an earlier autosave from ${new Date(olderSavedAt).toLocaleString()} is also on disk` : "");
  const restore = document.createElement("button");
  restore.textContent = "Restore";
  restore.setAttribute("aria-describedby", "recovery-label");
  restore.style.cssText = "background:#1a6b32;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer";
  const discard = document.createElement("button");
  discard.textContent = "Discard";
  discard.setAttribute("aria-describedby", "recovery-label");
  discard.style.cssText = "background:#6b1a1a;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer";
  // The earlier snapshot used to be a promise with no control: "kept until you
  // choose" while no screen could ever choose it (uiux-r40 N4).
  let earlier: HTMLButtonElement | null = null;
  if (olderSnap && olderSavedAt) {
    earlier = document.createElement("button");
    // Two snapshots from the same day must be distinguishable by sight as
    // well as by the aria-describedby label (uiux-r42 F5).
    earlier.textContent = `Restore ${new Date(olderSavedAt).toLocaleString()} instead`;
    earlier.setAttribute("aria-describedby", "recovery-label");
    earlier.style.cssText = "background:#2b3644;color:#dfe6ee;border:0;border-radius:4px;padding:4px 10px;cursor:pointer";
    earlier.addEventListener("click", () => {
      const r = restoreSnapshotEntries(olderSnap.entries);
      const when = new Date(olderSavedAt).toLocaleString();
      const noun = olderSnap.entries.length === 1 ? "document" : "documents";
      // A successful earlier restore still left the untouched boot tab behind:
      // none of the recovered documents replaced it. Mirror the main Restore
      // path so only the recovered work remains (code-r41).
      const all = tabsView();
      if (all.length > 1 && all[0]!.name === "Untitled" && all[0]!.history.position === 0) {
        closeTab(0);
      }
      if (r.failed > 0) {
        // Hiding the bar here stranded the documents that failed to load: a
        // toast is gone before the user can act on it (code-r41).
        notify(
          r.failed === olderSnap.entries.length
            ? "None of the earlier documents could be opened"
            : "Only some earlier documents came back",
          `${r.restored} of ${olderSnap.entries.length} earlier ${noun} opened. Could not rebuild: ${r.failedNames.join(", ")}. The earlier autosave is still on disk.`,
        );
      }
      if (r.restored === 0) {
        settleRecoveryBar(`None of the ${olderSnap.entries.length} earlier ${noun} could be rebuilt. The earlier autosave from ${when} is still on disk — relaunch Guazzo to try again.`, false);
        return;
      }
      if (r.failed > 0) {
        settleRecoveryBar(`Restored ${r.restored} of ${olderSnap.entries.length} earlier ${noun}. Could not rebuild: ${r.failedNames.join(", ")}. The earlier autosave from ${when} is still on disk — relaunch Guazzo to try again.`, false);
      } else {
        hideRecoveryBar();
      }
      ((document.querySelector("#tabs .tab.active") as HTMLElement | null)
        ?? (layersBody.querySelector(".row.active") as HTMLElement | null))?.focus();
      // A complete restore may retire the earlier snapshot once the restored
      // tabs are written. A partial one must keep it: it still holds the only
      // copy of the documents that failed to rebuild (code-r41).
      if (r.restored > 0 && r.restored === olderSnap.entries.length) {
        autosaveDropAfterWrite = true;
        autosaveDropBytes = olderSnap.bytes;
        autosaveScheduler?.noteEdit();
      }
    });
  }

  restore.addEventListener("click", async () => {
    const { restored: restoredCount, failed: failedCount, failedNames } = restoreSnapshotEntries(entries);
    // drop the untouched boot document when restored docs came back
    const all = tabsView();
    if (all.length > 1 && all[0]!.name === "Untitled" && all[0]!.history.position === 0) {
      closeTab(0);
    }
    if (failedCount > 0) {
      // The slots survive a partial restore, so silence made it look as if the
      // missing documents had never been offered (uiux-r38 F4). The bar stays:
      // a toast is gone before the user can act on it (uiux-r39 F2).
      notify(
        failedCount === entries.length ? "None of the recovered documents could be opened" : "Only some documents came back",
        `${restoredCount} of ${entries.length} recovered ${entries.length === 1 ? "document" : "documents"} opened.` +
          ` Could not rebuild: ${failedNames.join(", ")}. The crash copy is still on disk.`,
      );
    }
    if (restoredCount === 0) {
      settleRecoveryBar(`None of the ${entries.length === 1 ? "document" : `${entries.length} documents`} could be rebuilt. The crash copy is still on disk — relaunch Guazzo to try again.`, true);
      return;
    }
    if (failedCount > 0) {
      settleRecoveryBar(`Restored ${restoredCount} of ${entries.length} recovered ${entries.length === 1 ? "document" : "documents"}. Could not rebuild: ${failedNames.join(", ")}. The crash copy is still on disk — relaunch Guazzo to try again.`, true);
      // A partial restore must not drop the slots: they still hold the failures
      // (code-r37 #2). Keep them and skip the write-then-drop arm below.
    } else {
      hideRecoveryBar();
    }
    // The bar's buttons are gone; leaving focus on <body> made the next Tab
    // hide the panel column (uiux-r35 #3).
    ((document.querySelector("#tabs .tab.active") as HTMLElement | null)
      ?? (layersBody.querySelector(".row.active") as HTMLElement | null))?.focus();
    // Keep the crash slots until the restored tabs are written: a crash during
    // the debounce used to leave no snapshot at all (code-r36 #2). When every
    // entry failed to load, keep them too — the recovery file is the only copy.
    // Only a COMPLETE restore may drop the slots: a partial one still holds the
    // documents that failed to load, and the write that would follow deletes
    // them (code-r37 #2).
    if (restoredCount > 0 && restoredCount === entries.length) {
      autosaveDropAfterWrite = true;
      autosaveDropBytes = recoveryOfferedBytes;
      autosaveScheduler?.noteEdit();
    }
  });
  discard.addEventListener("click", async () => {
    // "Discard" used to delete the autosave on one click, with no undo and no
    // copy elsewhere: the only record of that work is the file being removed.
    // Ask first, and say exactly what is lost.
    const count = entries.length;
    const keptOlder = recoveryOlderSavedAt
      ? `\n\nAn earlier autosave from ${new Date(recoveryOlderSavedAt).toLocaleString()} is also on disk — "Restore … instead" loads it now.`
      : "\n\nIt cannot be undone.";
    const okToDiscard = await ask(
      "Discard the recovered work?",
      (recoveryOlderSavedAt
        ? `This deletes the autosave from ${new Date(savedAt).toLocaleString()} — the only copy of ${count === 1 ? "this document" : `these ${count} documents`}.`
        : `This deletes the autosave, which is the only copy of ${count === 1 ? "this document" : `these ${count} documents`} from ${new Date(savedAt).toLocaleString()}.`) +
        keptOlder,
      "Discard it",
      "neutral",
    );
    if (!okToDiscard) return;
    const olderKept = recoveryOlderSavedAt;
    if (olderKept) {
      // The earlier snapshot is not deleted, so hiding the bar would imply the
      // decision was complete when it was not (uiux-r39 F1).
      settleRecoveryBar(`Discarded the autosave from ${new Date(savedAt).toLocaleString()}. An earlier one from ${new Date(olderKept).toLocaleString()} is still on disk — relaunch Guazzo and use "Restore … instead".`, false);
    } else {
      hideRecoveryBar();
      // The bar's buttons are gone; leaving focus on <body> made the next Tab
      // hide the panel column (uiux-r35 #3).
      ((document.querySelector("#tabs .tab.active") as HTMLElement | null)
        ?? (layersBody.querySelector(".row.active") as HTMLElement | null))?.focus();
    }
    // Discard deletes the recovered work, not the session still on screen: the
    // live slot is this session's crash copy (code-r36 #2). Unless it holds the
    // very snapshot being discarded — then the confirm's "only copy" would be a
    // lie and the next boot would offer it again (uiux-r37 #2).
    const rootNow = await opfs();
    const liveNow = rootNow ? await decodeSnapshotFile(rootNow, AUTOSAVE_FILE) : null;
    const same = (a: Uint8Array, b: Uint8Array): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    const liveIsOffered = !!(liveNow && recoveryOfferedBytes && same(liveNow.bytes, recoveryOfferedBytes));
    // Byte-scoped: a distinct session in the parked or archive slot was never
    // offered by this bar, so Discard must not destroy it either (code-r38 #2).
    await dropSnapshotCopies(
      liveIsOffered
        ? [AUTOSAVE_FILE, AUTOSAVE_RECOVERY_FILE, AUTOSAVE_PARKED_FILE, AUTOSAVE_ARCHIVE_FILE]
        : [AUTOSAVE_RECOVERY_FILE, AUTOSAVE_PARKED_FILE, AUTOSAVE_ARCHIVE_FILE],
      recoveryOfferedBytes,
    );
    // Edits made while the bar was up were never blocked, but the scheduler may
    // have skipped its last tick; ask for one now.
    autosaveScheduler?.noteEdit();
  });

  // The tab trap belongs to the bar, not to the window: the bar is the only
  // thing on screen that asks a question, and a keyboard user must be able to
  // answer it without falling into the panels behind it (uiux-r37 #1).
  bar.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Tab") return;
    // A settled bar has one button and no cycle: trapping Tab there focused
    // detached nodes and swallowed the key (uiux-r40 N2).
    // Known refs, not a DOM query: the bar is settled by removing these very
    // nodes, and the smoke's element shim has no querySelectorAll (uiux-r40 N2).
    const live: HTMLButtonElement[] = [restore, discard];
    if (earlier) live.push(earlier);
    // Cycle, not "pick by modifier": a fixed target made Tab from Discard
    // re-focus Discard, so two of the four directions were dead ends (uiux-r38 F1).
    // `ev.target` is the focused button in a browser; the shim passes it too,
    // while `document.activeElement` is not updated by focus() there.
    const from = (ev.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
    const at = live.indexOf(from as HTMLButtonElement);
    // Decide BEFORE swallowing the key: a settled bar has only Close left, and
    // preventing here would shadow the window handler that lets Tab leave the
    // bar (uiux-r42 F1). No answer to cycle to means no trap.
    if (at < 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    live[(at + (ev.shiftKey ? -1 : 1) + live.length) % live.length]?.focus();
  });
  bar.appendChild(label);
  bar.appendChild(restore);
  bar.appendChild(discard);
  if (earlier) bar.appendChild(earlier);
  host.appendChild(bar);
  recoveryBar = bar;
  recoveryOfferedBytes = offeredBytes ?? null;
  recoveryOlderSavedAt = olderSavedAt ?? null;
  restore.focus();
}

interface SnapshotFile { bytes: Uint8Array; savedAt: number; entries: AutosaveEntry[]; clean?: boolean }

/** Decode one snapshot file, or null when it is absent or unusable. */
async function decodeSnapshotFile(root: AutosaveRootLike, name: string): Promise<SnapshotFile | null> {
  let fh: AutosaveFileHandleLike;
  try { fh = await root.getFileHandle(name); } catch { return null; }
  const file = await fh.getFile();
  // A snapshot is app-owned, but "app-owned" is not "trusted": a corrupted
  // record or a writer from another build must be refused before it is read
  // into memory (sec-r7 #2).
  if (file.size > MAX_JSON_BYTES) {
    console.warn(`${name} is ${file.size} bytes, above the read limit; not restored`);
    return null;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 2) {
      const snap = await decodeAutosaveSnapshotV2(bytes);
      if (!snap) return null;
      return {
        bytes,
        savedAt: snap.savedAt,
        entries: snap.tabs.map(t => ({ name: t.name, restored: t.restored, warnings: t.warnings })),
        clean: snap.clean === true,
      };
    }
    const decoded = await decodeAutosaveSnapshotV1(bytes);
    const text = decoded ?? new TextDecoder().decode(bytes);
    // The v2 path measures tiles and bytes before allocating; the v1 JSON path
    // went straight to JSON.parse, so a 190 MB blob of empty objects became tens
    // of millions of recovery rows before anything asked if it was sane.
    const shape = jsonShapeRefusal(text);
    if (shape) throw new Error(shape);
    const parsed = JSON.parse(text) as { savedAt?: number; tabs?: unknown; project?: unknown };
    if (typeof parsed.savedAt !== "number") return null;
    if (Array.isArray(parsed.tabs)) {
      // multi-document payload (v0.7.0+), including v1 compressed snapshots.
      // The reader caps v2 at MAX_TABS; the v1 list must be capped here or a
      // hand-edited snapshot draws one row per entry.
      const tabs = parsed.tabs.slice(0, MAX_TABS);
      if (parsed.tabs.length > MAX_TABS) {
        console.warn(`autosave: snapshot has ${parsed.tabs.length} tabs — showing the first ${MAX_TABS}`);
      }
      return { bytes, savedAt: parsed.savedAt, entries: tabs as AutosaveEntry[] };
    }
    if (parsed.project) {
      // legacy single-document payload (v0.4.2–v0.6.0)
      return { bytes, savedAt: parsed.savedAt, entries: [{ name: "Restored", project: parsed.project }] };
    }
    return null;
  } catch (err) {
    // A corrupt or future snapshot must not crash the app. Do not delete it:
    // the user may want it recovered by a newer build.
    console.warn("autosave snapshot was not restored", err);
    return null;
  }
}

async function writeSnapshotFile(root: AutosaveRootLike, name: string, bytes: Uint8Array): Promise<void> {
  const fh = await root.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

async function dropSnapshots(names: string[]): Promise<void> {
  // Only an explicit Restore or Discard reaches this function, and only the
  // snapshot slots named by the caller go: the live slot belongs to the session
  // on screen (code-r36 #2).
  const root = await opfs();
  if (!root) return;
  for (const name of names) {
    try { await root.removeEntry(name); } catch { /* already gone */ }
  }
}

/**
 * Delete the slots that hold this exact snapshot, and nothing else.
 *
 * A crash can leave several distinct sessions on disk while the bar can only
 * offer one of them. Dropping "the recovery, parked and archive slots" by name
 * therefore destroyed sessions the user was never shown (code-r38 #2); compare
 * the bytes instead, so a slot that is only a copy of the offered snapshot goes
 * and a different session stays for the next launch.
 */
async function dropSnapshotCopies(names: string[], bytes: Uint8Array | null): Promise<void> {
  if (!bytes) return;
  const root = await opfs();
  if (!root) return;
  for (const name of names) {
    // Compare the file's bytes directly: decoding rebuilt up to 4096 tiles and
    // a whole Document per slot only to throw them away (sec-r39 F3).
    const raw = await readSnapshotBytes(root, name);
    if (!raw) continue;
    if (raw.length === bytes.length && raw.every((v, i) => v === bytes[i])) {
      try { await root.removeEntry(name); } catch { /* already gone */ }
    }
  }
}

async function slotExists(root: AutosaveRootLike, name: string): Promise<boolean> {
  try { await root.getFileHandle(name); return true; } catch { return false; }
}

/** Read a snapshot slot's bytes without parsing it. Null when absent/unreadable. */
async function readSnapshotBytes(root: AutosaveRootLike, name: string): Promise<Uint8Array | null> {
  try {
    const fh = await root.getFileHandle(name);
    const file = await fh.getFile();
    if (file.size > MAX_JSON_BYTES) return null;
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function initAutosave(): Promise<void> {
  const root = await opfs();
  if (!root) return; // OPFS unavailable (e.g. some file:// contexts): autosave off
  // A crash while the recovery bar is up can leave a newer session in the live
  // slot and an older one in the recovery slot. Reading one and returning would
  // hide the other for good (sec-r34). Both are read, the newer is offered, and
  // NOTHING is deleted or moved here: choosing Restore or Discard is the only
  // explicit act that may drop a snapshot (code-r35 #4). A boot-time cleanup
  // deleted the older slot before the user had seen either.
  const recovery = await decodeSnapshotFile(root, AUTOSAVE_RECOVERY_FILE);
  const live = await decodeSnapshotFile(root, AUTOSAVE_FILE);
  const parked = await decodeSnapshotFile(root, AUTOSAVE_PARKED_FILE);
  // The archive is a real copy of a crash session: excluding it from the sort
  // meant a third session was parked forever and dropped with the rest, so the
  // promised copy was never offered (code-r37 #1).
  const archived = await decodeSnapshotFile(root, AUTOSAVE_ARCHIVE_FILE);
  const slots = [
    { name: AUTOSAVE_RECOVERY_FILE, snap: recovery },
    { name: AUTOSAVE_FILE, snap: live },
    { name: AUTOSAVE_PARKED_FILE, snap: parked },
    { name: AUTOSAVE_ARCHIVE_FILE, snap: archived },
  ].filter((slot): slot is { name: string; snap: SnapshotFile } => slot.snap !== null);
  // A snapshot whose session had nothing unsaved is not lost work: drop it at
  // boot rather than asking the user to "recover" a document they saved.
  const cleanSlots = slots.filter((slot) => slot.snap.clean);
  if (cleanSlots.length > 0) {
    await dropSnapshots(cleanSlots.map((slot) => slot.name));
    for (const slot of cleanSlots) slots.splice(slots.indexOf(slot), 1);
  }
  if (slots.length === 0) return;
  slots.sort((a, b) => b.snap.savedAt - a.snap.savedAt);
  const shown = slots[0]!;
  // On a second boot the offered bytes can sit in two slots (recovery + live):
  // labelling that identical copy "an older autosave" was false, and parking it
  // would overwrite the genuinely older session (code-r38 #2).
  const sameSlot = (a: SnapshotFile, b: SnapshotFile): boolean =>
    a.bytes.length === b.bytes.length && a.bytes.every((v, i) => v === b.bytes[i]);
  const older = slots.slice(1).find((slot) => !sameSlot(slot.snap, shown.snap))?.snap;
  try {
    // Park the older copy first: writing the offered bytes over the recovery
    // slot must not destroy the only copy of the other snapshot. The live slot
    // is never touched here, so the next autosave of this session cannot
    // overwrite what the bar is offering (code-r36 #1).
    //
    // A second boot sees the offered snapshot twice (live + recovery) and the
    // older one in the parked slot. Copying "the second newest" then would
    // write the offered bytes over the parked slot and lose the only copy of
    // the older session (sec-r36 #1) — so nothing is written when the copies
    // are already byte-identical.
    const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    const recoveryPresent = await slotExists(root, AUTOSAVE_RECOVERY_FILE);
    const recoveryBytes = await readSnapshotBytes(root, AUTOSAVE_RECOVERY_FILE);
    const parkedPresent = await slotExists(root, AUTOSAVE_PARKED_FILE);
    const olderIsRecovery = !!(recoveryBytes && older && sameBytes(recoveryBytes, older.bytes));
    let keepParked = false;
    if (older && !sameBytes(older.bytes, shown.snap.bytes)) {
      // A third distinct session in the parked slot would be overwritten by the
      // second-newest here. Keep it in the archive slot first: the bar names the
      // two it offers, but no crash session is destroyed by parking (sec-r37 #1).
      if (parked && !sameBytes(parked.bytes, older.bytes) && !sameBytes(parked.bytes, shown.snap.bytes)) {
        // Presence and readability are different facts: a corrupt or newer-format
        // archive must be kept, not overwritten because it failed to parse (sec-r39 F2).
        const archivedBytes = await readSnapshotBytes(root, AUTOSAVE_ARCHIVE_FILE);
        if (!archivedBytes) {
          await writeSnapshotFile(root, AUTOSAVE_ARCHIVE_FILE, parked.bytes);
          console.warn("autosave: kept an earlier crash session in the archive slot");
        } else if (!sameBytes(archivedBytes, parked.bytes)) {
          // A fourth distinct crash session: the archive already holds one we
          // cannot name. Parking `older` over this slot would destroy it and the
          // warning would be false — so keep the parked session and skip the
          // write; `older` still lives in the slot it came from (code-r39 F3).
          keepParked = true;
          console.warn("autosave: the archive slot already holds another crash session; the parked one was kept");
        }
      }
      // A slot that exists but did not decode may be a corrupt or newer-format
      // snapshot; the decoder's contract is to keep it, not to replace it
      // (uiux-r40 N5).
      if (parkedPresent && !parked) {
        keepParked = true;
        console.warn("autosave: the parked slot holds a snapshot this build cannot read; it was kept");
      }
      if (!keepParked && !(parked && sameBytes(parked.bytes, older.bytes))) {
        await writeSnapshotFile(root, AUTOSAVE_PARKED_FILE, older.bytes);
      }
    }
    if (shown.name !== AUTOSAVE_RECOVERY_FILE) {
      if (!recoveryPresent) {
        await writeSnapshotFile(root, AUTOSAVE_RECOVERY_FILE, shown.snap.bytes);
      } else if (!recovery) {
        console.warn("autosave: the recovery slot holds a snapshot this build cannot read; it was kept");
      } else if (olderIsRecovery) {
        // Writing the offered bytes here would destroy the older session the bar
        // just promised to keep — and the Discard confirm tells the user it will
        // be offered next launch (uiux-r40 N1).
        console.warn("autosave: the recovery slot holds the earlier snapshot; it was kept");
      } else if (!sameBytes(recoveryBytes ?? shown.snap.bytes, shown.snap.bytes)) {
        await writeSnapshotFile(root, AUTOSAVE_RECOVERY_FILE, shown.snap.bytes);
      }
    }
  } catch (err) {
    console.warn("autosave: could not park the offered snapshot", err);
  }
  showRecoveryBar(shown.snap.savedAt, shown.snap.entries, older?.savedAt, shown.snap.bytes, older ?? null);
}
void initAutosave();

// ---- merge down / flatten ----------------------------------------------------

/** composite the active layer onto the one below it, drop the active layer.
 *  Undoable as ONE history entry (pixels + layer removal together). */
async function mergeDown(): Promise<void> {
  if (transform) {
    statusHint("Finish the transform before merging — Merge Down applies the pixels on screen.");
    return;
  }
  commitText();
  const idx = doc.layers.indexOf(activeLayer);
  if (idx < 0) {
    statusHint("Merge Down works on top-level layers — move this layer out of its group first.");
    return;
  }
  if (idx === 0) {
    statusHint("Merge Down needs a layer below this one.");
    return;
  }
  if (wasmEngineEnabled()) {
    const source = doc;
    const identity = docIdentity(source);
    try {
      const name = activeTabView()?.name ?? "Merged";
      const json = JSON.stringify(serializeProject(source, name));
      const nextJson = await wasmMergeDownCall(json, name, activeLayer.id);
      if (doc !== source || docIdentity(doc) !== identity) {
        statusHint("Merge Down skipped — document changed");
        return;
      }
      const { doc: next } = deserializeProject(JSON.parse(nextJson));
      setDocInTab(next, "Merge Down");
      statusHint("Merged down with the Rust engine");
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A refusal is not an unavailable engine: the Rust rules are the same
      // rules this command must enforce, so surface it and leave the doc alone.
      if (message.startsWith("Merge Down")) {
        statusHint(message);
        return;
      }
      console.error("wasm merge down failed; using the original engine", err);
      statusHint("Rust engine unavailable — merging locally");
    }
  }
  mergeDownOriginal();
}

function mergeDownOriginal(): void {
  if (transform) {
    statusHint("Finish the transform before merging — Merge Down applies the pixels on screen.");
    return;
  }
  commitText();
  const idx = doc.layers.indexOf(activeLayer);
  if (idx < 0) {
    // A group child has no index here, and silently doing nothing looked like a
    // broken command (code-r29 #4).
    statusHint("Merge Down works on top-level layers — move this layer out of its group first.");
    return;
  }
  if (idx === 0) {
    // Ctrl+E bypasses the menu, so "disabled" is not visible here (uiux-r38 F5).
    statusHint("Merge Down needs a layer below this one.");
    return;
  }
  const upper = activeLayer;
  const below = doc.layers[idx - 1]!;
  // Merge Down is a pixel merge: `mergeLayerInto` copies two grids. A group's
  // grid is never read by the compositor (it draws its children), so merging
  // into one wrote pixels nobody would see; and a style or smart source on the
  // upper layer would be discarded without a word. Refuse both, visibly.
  if (
    below.kind !== "pixel" || upper.kind !== "pixel" || below.effects || upper.effects ||
    upper.clipToBelow || below.clipToBelow || below.mask || below.opacity < 1 || below.blendMode !== "normal" ||
    // mergeLayerInto composites the upper grid regardless of its visible flag,
    // so a HIDDEN layer would publish the pixels the user hid and then delete
    // the layer. A smart source would be re-derived on the next transform and
    // drop the merged pixels; a live text recipe would no longer describe the
    // pixels. All three are refused rather than silently baking.
    !upper.visible || !below.visible || !!upper.smart || !!below.smart || !!below.textData
  ) {
    statusHint(
      !upper.visible
        ? "Merge Down would bake a hidden layer into the one below. Show it first."
        : !below.visible
          ? "Merge Down would composite onto a hidden layer. Show the layer below first."
          : upper.smart || below.smart
          ? "Merge Down does not flatten smart objects — rasterise them first."
          : below.textData
            ? "Merge Down into live type would break its recipe — rasterise the type first."
            : below.kind !== "pixel" || upper.kind !== "pixel"
        ? "Merge Down needs two pixel layers — convert the " +
          (below.kind !== "pixel" ? "lower" : "upper") + " layer (or group) to pixels first."
        : upper.effects || below.effects
          ? "Merge Down does not carry layer styles — rasterise the style first."
          : "Merge Down applies the lower layer's mask, opacity, blend or clipping, so merging would change the pixels. Flatten first.",
    );
    return;
  }
  const pxOp = layerOpCommand(below, "Merge Down", () => {
    mergeLayerInto(upper, below);
  });
  // The removal is part of the operation, not bookkeeping: without it the
  // upper layer stays in `doc.layers` (drawn twice) and undo re-inserts an
  // attached layer, which throws.
  doc.removeLayerFrom(null, upper);
  const rmOp = layerRemoveCommand(doc, upper, { parent: null, index: idx });
  pushHist({
    label: "Merge Down",
    bytes: (rmOp.bytes ?? 0) + (pxOp?.bytes ?? 0),
    undo: () => { rmOp.undo(); pxOp?.undo(); },
    redo: () => { pxOp?.redo(); rmOp.redo(); },
  });
  activeLayer = below;
  declaredChange();
  renderLayers(); render(); renderHistoryPanel();
}

/** composite every layer into one "Flattened" layer (single history entry) */
async function flattenImage(): Promise<void> {
  if (transform) return;
  commitText();
  if (doc.layers.length < 2) return;
  if (wasmEngineEnabled()) {
    const source = doc;
    const identity = docIdentity(source);
    try {
      const name = activeTabView()?.name ?? "Flattened";
      const json = JSON.stringify(serializeProject(source, name));
      const nextJson = await wasmFlattenCall(json, name);
      // The await leaves a window for edits. Discard a stale result rather
      // than replacing a document the user changed while the engine ran.
      if (doc !== source || docIdentity(doc) !== identity) {
        statusHint("Flatten skipped — document changed");
        return;
      }
      const { doc: next } = deserializeProject(JSON.parse(nextJson));
      setDocInTab(next, "Flatten Image");
      statusHint("Flattened with the Rust engine");
      return;
    } catch (err) {
      console.error("wasm flatten failed; using the original engine", err);
      statusHint("Rust engine unavailable — flattening locally");
    }
  }
  const before = doc.layers.slice();
  const pixels = doc.composite(); // all current layers, bottom→top
  const flat = doc.addLayer("Flattened");
  flat.grid.writeRect(0, 0, doc.width, doc.height, pixels);
  // Flatten MEANS one layer: swap the stack to [flat] in the LIVE path too.
  // The undo/redo closures below only replay history — the previous version
  // left the originals in place, so the panel showed every old layer plus a
  // "Flattened" copy on top and the document no longer matched its layers.
  doc.layers.length = 0;
  doc.layers.push(flat);
  pushHist({
    label: "Flatten Image",
    // The closures retain every original layer: charge them or the byte
    // budget never sees this step (code-r17 #3).
    bytes: before.reduce((n, l) => n + subtreeBytes(l), 0) + subtreeBytes(flat),
    undo: () => { doc.layers.length = 0; for (const l of before) doc.layers.push(l); },
    redo: () => { doc.layers.length = 0; doc.layers.push(flat); },
  });
  activeLayer = flat;
  declaredChange();
  renderLayers(); render(); renderHistoryPanel();
}

// ---- magic wand / paint bucket ------------------------------------------
/** Sample the ACTIVE LAYER (Photoshop's default sample source) and build a
 *  selection from the colours under the cursor. */
type SelectMode = "replace" | "add" | "subtract";

/** Shift unions a shape into the live mask, Alt removes it (Photoshop's modifiers). */
function mergeSelection(base: SelectionMask | null, extra: SelectionMask, mode: SelectMode, w: number, h: number): SelectionMask {
  if (mode === "replace" || !base || base.isEmpty()) return extra;
  const out = new SelectionMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = base.alphaAt(x, y);
      const b = extra.alphaAt(x, y);
      const v = mode === "add" ? Math.max(a, b) : Math.max(0, a - b);
      if (v > 0) out.setAlpha(x, y, v);
    }
  }
  return out;
}

function pickWand(x: number, y: number, mode: SelectMode = "replace"): void {
  if (transform) return;
  commitText();
  const layer = activeLayer;
  if (!layer) return;
  const px = sampleGrid(layer.grid, doc.width, doc.height);
  const res = magicWand(px, doc.width, doc.height, Math.floor(x), Math.floor(y), {
    tolerance: wandTolerance,
    contiguous: wandContiguous,
  });
  if (!res) {
    if (mode === "replace") deselect();
    return;
  }
  const base = selMask ?? (selRect ? (() => {
    const m = new SelectionMask(doc.width, doc.height);
    m.selectRect(selRect.x, selRect.y, selRect.w, selRect.h);
    return m;
  })() : null);
  const merged = mergeSelection(base, res.mask, mode, doc.width, doc.height);
  selRect = null;
  selGeom = null;
  selMask = merged;
  if (merged.isEmpty()) deselect();
  startAnts();
  drawOverlay();
  refreshOptions();
  render();
}

/** Flood the area under the cursor with the foreground colour, one undo step. */
/** union one wand region into the live selection (Quick Selection brush).
 *  One flood at the cursor, cached while the pointer stays inside the region:
 *  the old five-probe flood ran 5×3 full-canvas scans per click and a drag
 *  re-flooded every move. The cache is invalidated by pixel edits, layer
 *  changes, and tolerance changes. */
function quickDab(x: number, y: number, mode: "add" | "subtract" = "add"): void {
  if (transform) return;
  const layer = activeLayer;
  if (!layer) return;
  if (!quickPx || quickPxLayer !== layer.id) {
    quickPx = activeLayerPixels();
    quickPxLayer = layer.id;
    quickRegion = null;
  }
  const px = quickPx;
  const ix = Math.round(x), iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= doc.width || iy >= doc.height) return;

  if (!quickRegion || quickRegion.mask.alphaAt(ix, iy) === 0) {
    const found = magicWand(px, doc.width, doc.height, ix, iy, {
      tolerance: quickTolerance,
      contiguous: true,
      antialias: true,
    });
    if (!found) return;
    quickRegion = found;
    quickApplied = null;
  }
  const region = quickRegion;
  // The region is already unioned into the live selection. Re-walking its
  // bbox on every pointermove is pure work and is what made a drag crawl.
  if (quickApplied === mode) return;
  if (!selMask) selMask = new SelectionMask(doc.width, doc.height);
  let touched = false;
  const box = region.bbox;
  for (let yy = box.y; yy < box.y + box.h; yy++) {
    for (let xx = box.x; xx < box.x + box.w; xx++) {
      const a = region.mask.alphaAt(xx, yy);
      if (a > 0) {
        const prev = selMask.alphaAt(xx, yy);
        if (mode === "subtract") {
          if (prev > 0) { selMask.setAlpha(xx, yy, Math.max(0, prev - a)); touched = true; }
        } else if (a > prev) { selMask.setAlpha(xx, yy, a); touched = true; }
      }
    }
  }
  quickApplied = mode;
  if (!touched) return;
  selRect = null;
  selGeom = null;
  startAnts();
  drawOverlay();
  refreshOptions();
  render();
}

// Takes the document geometry and the selection as parameters: the eraser is
// a pixel operation, and the coupling pin counts functions that reach for the
// document globals instead of receiving what they need.
function magicErase(
  x: number, y: number, layer: Layer | null, w: number, h: number,
  mask: SelectionMask | null,
): void {
  if (transform) return;
  if (!layer || refuseGroupPixels(layer)) return;
  if (refusePaintSurface(layer)) return;
  if (paintTarget === "mask" && layer.mask) {
    statusHint("The Magic Eraser erases pixels. Switch the chip to Pixels first.");
    return;
  }
  const px = activeLayerPixels();
  const entry = layerOpCommand(layer, "Magic Eraser", () => {
    eraseRegion(layer.grid, px, w, h, Math.floor(x), Math.floor(y), {
      tolerance: bucketTolerance,
      contiguous: true,
      clip: mask ?? undefined,
    });
  });
  if (!entry) {
    statusHint("The Magic Eraser found nothing to erase there.");
    return;
  }
  pushHist(entry);
  render();
  renderHistoryPanel();
}

function pourBucket(x: number, y: number): void {
  if (transform) return;
  commitText();
  const layer = activeLayer;
  if (!layer) return;
  if (refuseGroupPixels(layer)) return;
  if (refusePaintSurface(layer)) return;
  if (paintTarget === "mask" && layer.mask) {
    statusHint("Paint Bucket fills pixels. Switch the chip to Pixels, or paint the mask with the brush.");
    return;
  }
  const c: RGBA = {
    r: color[0], g: color[1], b: color[2],
    a: Math.round(255 * bucketOpacity),
  };
  const entry = layerOpCommand(layer, "Paint Bucket", () => {
    floodFill(layer.grid, Math.floor(x), Math.floor(y), c, {
      tolerance: bucketTolerance,
      contiguous: bucketContiguous,
      mask: selMask,
    });
  });
  if (!entry) return;
  pushHist(entry);
  render();
  renderHistoryPanel();
}

/** Edit > Fill: flood the whole selection (or the layer) with the foreground. */
/** Edit ▸ Smart Fill (classical patch-based inpainting): rebuilds the selection from the pixels around it. */
function contentAwareFillSelection(): void {
  if (refuseGroupPixels(activeLayer)) return;
  const mask = selMask;
  if (!mask) {
    statusHint("Select something first — Smart Fill works on a selection.");
    return;
  }
  const b = mask.bbox();
  if (!b || b.w < 1 || b.h < 1) {
    statusHint("The selection is empty.");
    return;
  }
  const layer = activeLayer;
  if (refusePaintSurface(layer)) return;
  if (paintTarget === "mask" && layer.mask) {
    statusHint("Smart Fill rebuilds pixels. Switch the chip to Pixels first.");
    return;
  }
  const rect = {
    x: Math.max(0, b.x), y: Math.max(0, b.y),
    w: Math.min(b.w, doc.width - Math.max(0, b.x)),
    h: Math.min(b.h, doc.height - Math.max(0, b.y)),
  };
  const entry = layerOpCommandIn(layer, "Smart Fill", () => {
    contentAwareFill(layer.grid, rect, mask);
  }, rect);
  if (entry) pushHist(entry);
  render();
  renderHistoryPanel();
}

function fillWithForeground(): void {
  if (transform) return;
  commitText();
  const onMask = paintTarget === "mask" && !!activeLayer.mask;
  if (!onMask && refuseGroupPixels(activeLayer)) return;
  const layer = activeLayer;
  if (!layer) return;
  if (refusePaintSurface(layer, onMask)) return;
  if (onMask) {
    const mask = layer.mask!;
    const neutral = layer.maskHide ? 255 : 0;
    // Same ordering as Clear: capture, mutate, then record (code-r39 F2).
    const before = captureTiles(mask);
    // The brush already decides hide/reveal from the colour's luminance; a
    // constant fill made black and white paint the same mask (uiux-r17 #1).
    const mlum = 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2];
    writeMaskArea(mask, mask.width, mask.height, mlum < 128 ? 255 : 0);
    const entry = snapshotCommand(mask, "Fill Mask", before, undefined, neutral);
    if (entry) { pushHist(entry); render(); renderHistoryPanel(); }
    return;
  }
  if (layer.textData) {
    // Fill writes pixels a live text layer does not own; the recipe keeps its
    // own image (code-r23 #2). A mask fill is a different surface (code-r24 #3).
    statusHint("Rasterize the type first — a live text layer has no fixed pixels.");
    return;
  }
  const paint = { r: color[0], g: color[1], b: color[2], a: Math.round(255 * bucketOpacity) };
  const entry = layerOpCommand(layer, "Fill", () => {
    if (selMask) {
      const b = selMask.bbox();
      if (b) fillPlane(layer.grid, b, paint, { mask: selMask });
    } else if (selRect) {
      const r = selRect;
      fillPlane(layer.grid, {
        x: Math.max(0, r.x), y: Math.max(0, r.y),
        w: Math.min(doc.width, r.x + r.w) - Math.max(0, r.x),
        h: Math.min(doc.height, r.y + r.h) - Math.max(0, r.y),
      }, paint);
    } else {
      fillPlane(layer.grid, { x: 0, y: 0, w: doc.width, h: doc.height }, paint);
    }
  });
  if (!entry) return;
  pushHist(entry);
  render();
  renderHistoryPanel();
}

// ---- selection + view commands (menu bar + shortcuts) --------------------
function selectAll(): void {
  if (transform) return;
  const before = snapshotSelection();
  selMask = null;
  selGeom = null;
  selRect = { x: 0, y: 0, w: doc.width, h: doc.height };
  startAnts();
  drawOverlay();
  refreshOptions();
  render();
  pushHist(selectionCommand("Select All", before));
}

function invertSelection(): void {
  if (transform) return;
  if (!selMask && !selRect) { selectAll(); return; }
  let m = selMask;
  if (!m) {
    m = new SelectionMask(doc.width, doc.height);
    const r = selRect!;
    m.selectRect(r.x, r.y, r.w, r.h);
  }
  const before = snapshotSelection();
  m.invert();
  selMask = m;
  selRect = null;
  selGeom = null;
  startAnts();
  drawOverlay();
  refreshOptions();
  render();
  pushHist(selectionCommand("Inverse selection", before));
}

/** the current selection as a soft mask, or null when nothing is selected */
function currentSelectionMask(): SelectionMask | null {
  if (selMask) return selMask;
  if (!selRect) return null;
  const m = new SelectionMask(doc.width, doc.height);
  m.selectRect(selRect.x, selRect.y, selRect.w, selRect.h);
  return m;
}

/** commit a rewritten mask back into the UI state (no pixel history entry) */
/**
 * AI6: a selection is document state the user edits, so it belongs on the undo
 * stack. Before this, Ctrl+Z after a Refine or Grow undid the *pixels* instead
 * and left the new edge in place — the one thing the user wanted back.
 *
 * A snapshot is the mask copy plus the rectangular variant, because the app has
 * two representations (selRect is a rect, selMask is coverage) and every edit
 * switches between them.
 */
/**
 * AP1: a selection snapshot is a tile-sparse copy of the mask itself, not a
 * dense bbox array. The old version allocated `b.w * b.h` bytes and called
 * alphaAt() per pixel (a 16384^2 selection is 268 MB before you can undo), while
 * SelectionMask.clone() memcpys only the tiles that exist. Restore clones again, so
 * an entry can be replayed any number of times.
 */
interface SelectionSnap {
  /** a marquee is four numbers; a wand/lasso selection is a mask */
  rect: { x: number; y: number; w: number; h: number } | null;
  mask: MaskSnap | null;
}

type MaskSnap = SelectionMask;

function snapshotMask(mask: SelectionMask | null): MaskSnap | null {
  if (!mask) return null;
  return mask.isEmpty() ? null : mask.clone();
}

function restoreMask(snap: MaskSnap | null): SelectionMask | null {
  return snap ? snap.clone() : null;
}

function snapshotSelection(): SelectionSnap {
  // A marquee carries both a rect and a mask (the commit sets both because
  // every consumer reads selMask). Keeping only the rect restored a selection
  // that Move, Nudge and Paint Bucket could not see (code-r12 #1).
  return {
    rect: selRect ? { x: selRect.x, y: selRect.y, w: selRect.w, h: selRect.h } : null,
    mask: snapshotMask(selMask),
  };
}

function restoreSelection(snap: SelectionSnap): void {
  selRect = snap.rect ? { ...snap.rect } : null;
  selMask = restoreMask(snap.mask);
  selGeom = null;
  marqueeing = false;
  ellipseDrag = false;
  lassoing = false;
  stopAnts();
  drawOverlay();
  refreshOptions();
  render();
  updateStatus();
}

function selectionBytes(snap: SelectionSnap): number {
  // A marquee stores a rect AND materialises the same area into a mask, so
  // charging 32 bytes let a 4096² Select All retain ~16 MB for free
  // (code-r17 #5).
  return 32 + (snap.mask ? snap.mask.allocatedBytes() : 0);
}

function selectionCommand(label: string, before: SelectionSnap): HistoryEntry {
  const after = snapshotSelection();
  return {
    label,
    bytes: selectionBytes(before) + selectionBytes(after),
    undo: () => restoreSelection(before),
    redo: () => restoreSelection(after),
  };
}

function applySelectionMask(next: SelectionMask, label = "Selection", preState?: SelectionSnap): void {
  const before = preState ?? snapshotSelection();
  let empty = true;
  for (let y = 0; y < next.height && empty; y++) {
    for (let x = 0; x < next.width; x++) {
      if (next.alphaAt(x, y) > 0) { empty = false; break; }
    }
  }
  selMask = empty ? null : next;
  selRect = null;
  selGeom = null;
  if (empty) stopAnts(); else startAnts();
  drawOverlay();
  refreshOptions();
  render();
  pushHist(selectionCommand(label, before));
}

/** flat RGBA of the active layer, used by Grow/Similar/Refine/Quick Selection */
let layerPxCache: { doc: Document; id: number; rev: number; w: number; h: number; px: Uint8ClampedArray } | null = null;
function activeLayerPixels(): Uint8ClampedArray {
  // the wand samples the active layer, so Grow/Similar must too — sampling the
  // composite here made two selection tools disagree about the same click.
  // Grow/Similar/Refine run repeatedly on an unchanged layer, so keep the last
  // snapshot until the layer or its pixels move.
  const layer = activeLayer;
  const rev = doc.revision;
  if (
    layerPxCache &&
    layerPxCache.doc === doc &&
    layerPxCache.id === layer.id &&
    layerPxCache.rev === rev &&
    layerPxCache.w === doc.width &&
    layerPxCache.h === doc.height
  ) {
    return layerPxCache.px;
  }
  const px = new Uint8ClampedArray(doc.width * doc.height * 4);
  layer.grid.readRect(0, 0, doc.width, doc.height, px);
  layerPxCache = { doc, id: layer.id, rev, w: doc.width, h: doc.height, px };
  return px;
}

/** Select ▸ Modify ▸ … — each opens a tiny dialog for its radius */
function selectModifyDialog(
  title: string,
  field: string,
  def: number,
  max: number,
  label: (v: number) => string,
  build: (m: SelectionMask, v: number) => SelectionMask,
): void {
  const base = currentSelectionMask();
  if (!base) { selectAll(); return; }
  const body = document.createElement("div");
  body.className = "stack";
  const inp = numField(body, field, def);
  inp.min = "1";
  inp.max = String(max);
  showModal(title, body, () => {
    const v = Math.max(1, Math.min(max, Math.round(Number(inp.value) || def)));
    void label;
    applySelectionMask(build(currentSelectionMask() ?? base, v));
  });
}

function selectExpand(): void {
  selectModifyDialog("Expand Selection", "Expand by (px)", 4, 200, (v) => `+${v}`, expandSelection);
}
function selectContract(): void {
  selectModifyDialog("Contract Selection", "Contract by (px)", 4, 200, (v) => `-${v}`, contractSelection);
}
function selectFeather(): void {
  selectModifyDialog("Feather Selection", "Feather radius (px)", 5, 200, (v) => `${v}px`, featherSelection);
}
function selectSmooth(): void {
  selectModifyDialog("Smooth Selection", "Smooth radius (px)", 3, 100, (v) => `${v}px`, smoothSelection);
}
function selectBorder(): void {
  selectModifyDialog("Border Selection", "Border width (px)", 4, 100, (v) => `${v}px`, borderSelection);
}

function selectAndMask(): void {
  const base = currentSelectionMask();
  if (!base) {
    statusHint("Select and Mask needs a selection — draw one first.");
    return;
  }
  const body = document.createElement("div");
  body.className = "stack";
  const radius = numField(body, "Edge radius (px)", 8);
  radius.min = "1";
  radius.max = "64";
  const feather = numField(body, "Feather (px)", 2);
  feather.min = "0";
  feather.max = "64";
  // AI4: the output is a choice, not an assumption. A refined edge is most often
  // wanted as a LAYER MASK (so the pixels stay editable), not as a selection.
  const outputRow = document.createElement("label");
  outputRow.className = "field";
  const outputLabel = document.createElement("span");
  outputLabel.className = "label";
  outputLabel.textContent = "Output";
  const outputSel = document.createElement("select");
  for (const [value, text] of [
    ["selection", "Selection"],
    ["mask", "Layer mask on the active layer"],
    ["layer", "New layer with that mask"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    outputSel.appendChild(opt);
  }
  outputRow.appendChild(outputLabel);
  outputRow.appendChild(outputSel);
  body.appendChild(outputRow);
  const note = document.createElement("p");
  note.className = "label";
  const noteText = "Refines the edge band against the active layer's colours, then feathers.";
  note.textContent = noteText;
  body.appendChild(note);
  const alreadyFeathered = selectionHasFeather(base);
  showModal("Select and Mask", body, () => {
    const m = currentSelectionMask() ?? base;
    const px = activeLayerPixels();
    const r = Math.max(1, Math.min(64, Math.round(Number(radius.value) || 8)));
    const f = Math.max(0, Math.min(64, Math.round(Number(feather.value) || 0)));
    const next = refineSelection(m, px, doc.width, doc.height, { radius: r, feather: f });
    const output = outputSel.value;
    if (output === "selection") {
      applySelectionMask(next);
      statusHint(`Selection refined (radius ${r}px, feather ${f}px)`);
      return;
    }
    // Mask outputs hang the refined coverage on a page layer as an editable mask
    // (white = selected). "layer" works on a copy so the original pixels survive.
    if (output === "layer") {
      const copy = doc.addLayer(`${activeLayer.name} refined`);
      copy.blendMode = activeLayer.blendMode;
      copy.opacity = activeLayer.opacity;
      activeLayer.grid.forEachTile((t, tx, ty) => copy.grid.writeRect(tx * TILE, ty * TILE, TILE, TILE, t.data));
      activeLayer = copy;
      pushHist(addAboveActive(doc, copy));
    }
    // Write the refined coverage into the layer's mask. AL5: everything the
    // selection does NOT cover must be hidden, or "Layer mask" showed the whole
    // layer with a hole where the selection's bbox ended.
    const maskExisted = !!activeLayer.mask;
    const maskGrid = doc.attachMask(activeLayer);
    const beforeMask = captureTiles(maskGrid);
    const beforeHide = activeLayer.maskHide === true;
    // AP2: outside the selection is hidden by polarity, not by a dense fill.
    // priorDefault carries the existing mask's polarity: a reveal default over
    // a hide-polarity mask would un-hide the pixels already painted there.
    const afterHide = fillMaskFromSelection(maskGrid, next, true, beforeHide ? 0 : 255);
    activeLayer.maskHide = afterHide;
    paintTarget = "mask";
    pushHist(maskSelectionCommand(activeLayer, maskGrid, "Select and Mask", beforeMask, beforeHide, afterHide, maskExisted));
    declaredChange();
    render();
    renderLayers();
    renderHistoryPanel();
    refreshOptions();
    statusHint(`Mask created from the refined edge (radius ${r}px, feather ${f}px)`);
  }, {
    onControls: ({ ok }) => {
      // A4: a disabled OK with the reason in muted text is a dead end for a
      // keyboard user — the button cannot take focus, so the reason has to.
      let reasonFocused = false;
      const sync = (): void => {
        const blocked = (Number(feather.value) || 0) > 0 && alreadyFeathered;
        ok.disabled = blocked;
        note.textContent = blocked
          ? "This selection is already feathered — set Feather to 0 to refine the edge again."
          : noteText;
        note.setAttribute("role", blocked ? "status" : "note");
        if (blocked && !reasonFocused) {
          note.tabIndex = -1;
          note.focus();
          reasonFocused = true;
        }
      };
      feather.addEventListener("input", sync);
      sync();
    },
  });
}

function selectGrow(): void {
  const base = currentSelectionMask();
  if (!base) { selectAll(); return; }
  const px = activeLayerPixels();
  applySelectionMask(growSelection(base, px, doc.width, doc.height, 32));
}

function selectColourRange(): void {
  const px = activeLayerPixels();
  // The cache is the document's geometry; reading it here keeps this shell
  // command out of the coupling metric's document state.
  const w = flatCache.width, h = flatCache.height;
  const body = document.createElement("div");
  body.className = "stack";
  const fuzz = numField(body, "Fuzziness (0–200)", 40);
  fuzz.min = "0";
  fuzz.max = "200";
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "Selects every pixel within this distance of the foreground colour.";
  body.appendChild(note);
  showModal("Colour Range", body, () => {
    const v = Math.max(0, Math.min(200, Math.round(Number(fuzz.value) || 40)));
    const target: [number, number, number] = [color[0], color[1], color[2]];
    applySelectionMask(colourRangeSelection(px, w, h, target, v));
    statusHint(`Colour Range: ${v} % fuzziness around the foreground colour.`);
  });
}

function selectSimilar(): void {
  const base = currentSelectionMask();
  if (!base) { selectAll(); return; }
  const px = activeLayerPixels();
  applySelectionMask(similarSelection(base, px, doc.width, doc.height, 32));
}

function zoomBy(factor: number): void {
  zoomAt(factor, host.clientWidth / 2, host.clientHeight / 2);
}

/** Zoom around a point in canvas-host CSS pixels (keeps that point still). */
function zoomAt(factor: number, sx: number, sy: number): void {
  const dx = (sx - panX) / scale, dy = (sy - panY) / scale;
  scale = Math.min(32, Math.max(0.05, scale * factor));
  panX = sx - dx * scale;
  panY = sy - dy * scale;
  render();
  drawOverlay();
}

function actualPixels(): void {
  const cx = host.clientWidth / 2, cy = host.clientHeight / 2;
  const dx = (cx - panX) / scale, dy = (cy - panY) / scale;
  scale = 1;
  panX = cx - dx;
  panY = cy - dy;
  render();
}

// ---- layer commands shared by the menu bar -------------------------------
function addNewLayer(): void {
  if (transform) applyTransform();
  const ref = activeLayer;
  const layer = doc.addLayer(`Layer ${doc.layers.length}`);
  const entry = addAboveActive(doc, layer, ref);
  activeLayer = layer;
  pushHist(entry);
  declaredChange();
  renderLayers(); render(); renderHistoryPanel();
}

function duplicateActiveLayer(): void {
  if (transform) applyTransform();
  const src = activeLayer;
  const copy = doc.addLayer(`${src.name} copy`);
  // one engine helper, shared with save: a duplicate is the same LAYER, tree and
  // all (a hand-written field list drops children, styles, smart sources and the
  // mask's polarity).
  cloneLayerContents(doc, src, copy);
  // A copy belongs where its source lives: at the root it lost the group's
  // opacity, mask and clipping (code-r9 #4), and a text layer's recipe has to
  // travel too or the copy can never be re-edited (code-r9 #5).
  // A copy belongs where its source lives, directly above it — at the root it
  // landed on top instead, which changes what a clipped or adjustment layer
  // above it affects. insertAbove removes and reinserts at the recorded spot.
  const entry = addAboveActive(doc, copy, src);
  if (src.textData) copy.textData = cloneTextMeta(src.textData);
  activeLayer = copy;
  pushHist(entry);
  declaredChange();
  renderLayers(); render(); renderHistoryPanel();
}

function deleteActiveLayer(): void {
  if (transform) return; // deleting mid-transform would desync the preview
  const layer = activeLayer;
  const parent = doc.parentOf(layer);
  // parentOf: undefined = not in the document, null = top level, Layer = its group.
  // The flat indexOf is -1 for a group child, so removeLayer no-opped and the recorded
  // undo re-inserted a layer that was still attached - a duplicate per cycle.
  // (Restored after the merge; see insertLayer's guard for the same defect class.)
  if (parent === undefined) return;
  const list = parent ? (parent.children ?? []) : doc.layers;
  const idx = list.indexOf(layer);
  if (idx < 0) return;
  if (!canDeleteLayer(doc, layer)) return;
  const taken = layer.kind === "group" ? subtreeCount(layer) - 1 : 0;
  // A trash button labelled "Delete layer" removed a whole subtree silently and
  // undo was the only way back. Ask first, and re-check the layer on the way in:
  // the answer arrives after a dialog, and the tree may have moved. A closure so
  // the coupling counter does not grow a top-level function for one call site.
  const remove = (): void => {
    const live = parent ? (parent.children ?? []) : doc.layers;
    const at = live.indexOf(layer);
    if (at < 0 || !doc.inDocument(layer)) return;
    doc.removeLayerFrom(parent, layer);
    const next = live[Math.min(at, live.length - 1)] ?? parent ?? doc.layers[0]!;
    activeLayer = next;
    pushHist(layerRemoveCommand(doc, layer, { parent, index: at }));
    declaredChange();
    renderLayers(); render(); renderHistoryPanel();
    if (layer.kind === "group") {
      statusHint(taken === 0
        ? `Deleted empty group ${layer.name}`
        : `Deleted ${layer.name} and ${taken} layer${taken === 1 ? "" : "s"}`);
    }
  };
  if (taken === 0) {
    remove();
    return;
  }
  void ask(
    `Delete \u201c${layer.name}\u201d?`,
    `This group holds ${taken} layer${taken === 1 ? "" : "s"}. Deleting it deletes them too.`,
    "Delete group",
    "neutral",
  ).then((yes) => {
    if (yes) remove();
  });
}

function runTop(label: string): void {
  const a = topActions.find((x) => x.label === label);
  if (a) {
    a.run();
    return;
  }
  // AG2: a label may live only in a menu (Save Project As… was dispatched from
  // the Ctrl+Shift+S branch and defined nowhere, so the shortcut was silent).
  // Fall back to the live menu tree so dispatch and definition cannot diverge.
  for (const m of menuDefs()) {
    const it = m.items.find((i) => i.label === label);
    if (it?.run) {
      void it.run();
      return;
    }
  }
}

/** Draw the eye to a panel the menu just targeted. */
function pulse(box: HTMLElement): void {
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  box.classList.remove("flash");
  void box.offsetWidth;
  box.classList.add("flash");
  setTimeout(() => box.classList.remove("flash"), 1000);
}

// ---- floating Adjustments palette (user request: Image ▸ Adjustments
// opens a draggable in-editor popup listing every adjustment; each item in
// the menu opens the SAME palette and triggers that adjustment). It is a
// div inside the app: no OS window, no taskbar icon, clamped to the app.
let adjustPal: HTMLElement | null = null;
let adjustPalPos: { x: number; y: number } | null = null;
let adjustPalDrag: { sx: number; sy: number; ox: number; ox2: number; oy: number } | null = null;

// ---------------------------------------------------------------------------
// Floating Adjustments palette (m07433 #3): a dropdown + inline form inside
// one draggable window. No modal, no background blur \u2014 the editor stays
// visible and work continues around it. Every Image \u25b8 Adjustments item
// opens THIS palette with that adjustment selected.
// ---------------------------------------------------------------------------
/** One adjustments entry: builds its inline form into the palette. */
interface PalForm { label: () => string; op: TonalOpFn }
type PalBuilder = (host: HTMLElement) => PalForm;

function palSlider(
  host: HTMLElement, label: string, min: number, max: number, def: number,
  fmt: (v: number) => string, step?: number,
): () => number {
  const row = document.createElement("label");
  row.className = "inline-row";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.style.minWidth = "86px";
  lab.textContent = label;
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.value = String(def);
  if (step) range.step = String(step);
  range.setAttribute("aria-label", label);
  const val = document.createElement("span");
  val.className = "value";
  val.style.minWidth = "38px";
  val.textContent = fmt(def);
  range.addEventListener("input", () => { val.textContent = fmt(Number(range.value)); });
  row.append(lab, range, val);
  host.appendChild(row);
  return () => Number(range.value);
}

function palCheck(host: HTMLElement, label: string, def: boolean): () => boolean {
  const row = document.createElement("label");
  row.className = "inline-row check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = def;
  const lab = document.createElement("span");
  lab.className = "label";
  lab.style.minWidth = "0";
  lab.textContent = label;
  row.append(cb, lab);
  host.appendChild(row);
  return () => cb.checked;
}

function palSelect<T extends string>(
  host: HTMLElement, label: string, entries: readonly [T, string][], def: T,
): () => T {
  const row = document.createElement("label");
  row.className = "inline-row";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.style.minWidth = "86px";
  lab.textContent = label;
  const sel = document.createElement("select");
  for (const [v, text] of entries) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    sel.appendChild(o);
  }
  sel.value = def;
  sel.style.flex = "1 1 auto";
  row.append(lab, sel);
  host.appendChild(row);
  return () => sel.value as T;
}

function palHint(host: HTMLElement, text: string): void {
  const p = document.createElement("div");
  p.className = "label";
  p.textContent = text;
  host.appendChild(p);
}

/** Basic destructive adjustments (the same ops as the Adjustments card). */
function palBasicForm(kind: AdjustmentKind): PalBuilder {
  return (host) => {
    const meta = KINDS[kind];
    if (meta.max <= meta.min) {
      palHint(host, "No parameters \u2014 Apply runs it directly.");
      return {
        label: () => meta.label(0),
        op: (g, r, m) => applyAdjustment(g, r.x, r.y, r.w, r.h, { kind, amount: 0 }, m ?? undefined),
      };
    }
    const amount = palSlider(host, "Amount", meta.min, meta.max, meta.def, (v) => String(v));
    return {
      label: () => meta.label(amount()),
      op: (g, r, m) => applyAdjustment(g, r.x, r.y, r.w, r.h, { kind, amount: amount() }, m ?? undefined),
    };
  };
}

function palLevels(host: HTMLElement): PalForm {
  // AF2: the ranges come from ui/adjust-forms.ts, so the palette and the modal
  // Levels dialog cannot disagree about them again.
  const c = buildFields(host, LEVELS_FIELDS);
  return {
    label: () => "Levels",
    op: (g, r, m) => applyLevels(g, r, levelsFromFields(c), m),
  };
}

/** compact curve editor: click adds, drag bends, double-click removes. */
function palCurves(host: HTMLElement): PalForm {
  // X1: the palette used to hardcode the "rgb" channel, so per-channel curves
  // were unreachable from here even though the engine supports them.
  const chRow = document.createElement("label");
  chRow.className = "inline-row";
  const chLab = document.createElement("span");
  chLab.className = "label";
  chLab.style.minWidth = "86px";
  chLab.textContent = "Channel";
  const chSel = document.createElement("select");
  for (const [value, text] of CURVE_CHANNELS) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    chSel.appendChild(o);
  }
  chSel.value = "rgb";
  chSel.setAttribute("aria-label", "Channel");
  chSel.style.flex = "1 1 auto";
  chRow.append(chLab, chSel);
  host.appendChild(chRow);
  const channel = (): CurveChannel => chSel.value as CurveChannel;
  const perChannel: Record<CurveChannel, CurvePoint[]> = {
    rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    g: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    b: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  };
  let pts: CurvePoint[] = perChannel.rgb;
  chSel.addEventListener("change", () => { pts = perChannel[channel()]; draw(); });
  const cv = document.createElement("canvas");
  cv.width = 210;
  cv.height = 150;
  cv.className = "pal-curve";
  cv.title = "Click to add \u00b7 drag to bend \u00b7 double-click a point to remove it";
  cv.tabIndex = 0;
  cv.setAttribute("role", "application");
  cv.setAttribute("aria-label", "Curve editor \u2014 click to add a point, drag to bend, arrows nudge the nearest point");
  const ctx = cv.getContext("2d");
  const draw = (): void => {
    if (!ctx) return;
    ctx.fillStyle = "#0e0f12";
    ctx.fillRect(0, 0, 210, 150);
    ctx.strokeStyle = "rgba(255,255,255,.14)";
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) {
      ctx.beginPath();
      ctx.moveTo((g * 210) / 4, 0);
      ctx.lineTo((g * 210) / 4, 150);
      ctx.moveTo(0, (g * 150) / 4);
      ctx.lineTo(210, (g * 150) / 4);
      ctx.stroke();
    }
    const px = (x: number): number => (x / 255) * (210 - 12) + 6;
    const py = (y: number): number => 150 - ((y / 255) * (150 - 12) + 6);
    const sorted = pts.slice().sort((a, b) => a.x - b.x);
    ctx.strokeStyle = "rgba(127,178,255,.4)";
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    ctx.lineTo(px(255), py(255));
    ctx.stroke();
    ctx.strokeStyle = "#5b8cff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px(sorted[0]!.x), py(sorted[0]!.y));
    for (const pt of sorted) ctx.lineTo(px(pt.x), py(pt.y));
    ctx.stroke();
    ctx.fillStyle = "#fff";
    for (const pt of sorted) {
      ctx.beginPath();
      ctx.arc(px(pt.x), py(pt.y), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  draw();
  host.appendChild(cv);
  const toPt = (ev: PointerEvent): CurvePoint => {
    const r = cv.getBoundingClientRect();
    const fx = Number.isFinite(r.width) && r.width > 0 ? (ev.clientX - r.left) / r.width : 0.5;
    const fy = Number.isFinite(r.height) && r.height > 0 ? (ev.clientY - r.top) / r.height : 0.5;
    return {
      x: Math.round(Math.max(0, Math.min(1, fx)) * 255),
      y: Math.round(Math.max(0, Math.min(1, 1 - fy)) * 255),
    };
  };
  const nearest = (p: CurvePoint): number => {
    const r = cv.getBoundingClientRect();
    const sx = Number.isFinite(r.width) && r.width > 0 ? r.width / 210 : 1;
    const sy = Number.isFinite(r.height) && r.height > 0 ? r.height / 150 : 1;
    let best = -1;
    let bd = 144; // 12px squared
    pts.forEach((q, i) => {
      const dx = (q.x - p.x) / 255 * 198 * sx;
      const dy = (q.y - p.y) / 255 * 138 * sy;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  let dragIdx = -1;
  cv.addEventListener("pointerdown", (ev: PointerEvent) => {
    ev.preventDefault();
    const p = toPt(ev);
    dragIdx = nearest(p);
    if (dragIdx < 0) {
      pts.push(p);
      dragIdx = pts.length - 1;
    }
    try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic events */ }
    const move = (e: PointerEvent): void => {
      if (dragIdx < 0) return;
      pts[dragIdx] = toPt(e);
      draw();
    };
    const up = (): void => {
      dragIdx = -1;
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
    };
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
  });
  // Keyboard parity with the modal Curves editor (handoff-4 X3): arrows nudge
  // the nearest point, Shift for a coarse step.
  cv.addEventListener("keydown", (ev: KeyboardEvent) => {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!keys.includes(ev.key)) return;
    ev.preventDefault();
    const sorted = pts.slice().sort((a, b) => a.x - b.x);
    // Nudge an interior point when there is one (moving an endpoint would
    // change the black/white clip), otherwise the first point.
    let i = sorted.findIndex((p) => p.x > 0 && p.x < 255);
    if (i < 0) i = 0;
    const target = sorted[i]!;
    const step = ev.shiftKey ? 8 : 1;
    if (ev.key === "ArrowUp") target.y = Math.min(255, target.y + step);
    else if (ev.key === "ArrowDown") target.y = Math.max(0, target.y - step);
    else if (ev.key === "ArrowLeft") target.x = Math.max(0, target.x - step);
    else target.x = Math.min(255, target.x + step);
    pts = pts.slice().sort((a, b) => a.x - b.x);
    perChannel[channel()] = pts;
    draw();
  });
  // removal needs the real dblclick position
  cv.addEventListener("dblclick", (ev: MouseEvent) => {
    if (pts.length <= 2) return;
    const idx = nearest(toPt(ev as unknown as PointerEvent));
    if (idx >= 0) { pts.splice(idx, 1); draw(); }
  });
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn subtle";
  reset.textContent = "Reset curve";
  reset.addEventListener("click", () => { pts = [{ x: 0, y: 0 }, { x: 255, y: 255 }]; perChannel[channel()] = pts; draw(); });
  host.appendChild(reset);
  return {
    label: () => `Curves (${channel().toUpperCase()})`,
    op: (g, r, m) => {
      // rgb applies to all three channels; r/g/b apply to just that channel.
      const ch = channel();
      applyCurve(g, r, pts.slice().sort((a, b) => a.x - b.x), ch, m);
    },
  };
}

function palExposure(host: HTMLElement): PalForm {
  // AF2: EV scale shared with the modal dialog (m10524).
  const f = buildExposureForm(host);
  return {
    label: () => f.label(),
    op: (g, r, m) => { const ev = f.ev(); if (ev !== 0) applyExposure(g, r, ev, m); },
  };
}

function palVibrance(host: HTMLElement): PalForm {
  const amount = palSlider(host, "Vibrance", -100, 100, 0, (v) => `${v > 0 ? "+" : ""}${v}`);
  return { label: () => `Vibrance ${amount() > 0 ? "+" : ""}${amount()}`, op: (g, r, m) => applyVibrance(g, r, amount(), m) };
}

function palColorBalance(host: HTMLElement): PalForm {
  const range = palSelect(host, "Range", [
    ["shadows", "Shadows"], ["midtones", "Midtones"], ["highlights", "Highlights"],
  ] as const, "midtones");
  const cr = palSlider(host, "Cyan\u2013Red", -100, 100, 0, (v) => `${v > 0 ? "+" : ""}${v}`);
  const mg = palSlider(host, "Magenta\u2013Green", -100, 100, 0, (v) => `${v > 0 ? "+" : ""}${v}`);
  const yb = palSlider(host, "Yellow\u2013Blue", -100, 100, 0, (v) => `${v > 0 ? "+" : ""}${v}`);
  const preserve = palCheck(host, "Preserve luminosity", true);
  return {
    label: () => `Colour Balance ${cr() > 0 ? "+" : ""}${cr()}/${mg() > 0 ? "+" : ""}${mg()}/${yb() > 0 ? "+" : ""}${yb()}`,
    op: (g, r, m) => {
      const zero = { r: 0, g: 0, b: 0 };
      const cur = { r: cr(), g: mg(), b: yb() };
      const o = {
        shadows: zero,
        midtones: zero,
        highlights: zero,
        preserveLuminosity: preserve(),
      };
      if (range() === "shadows") o.shadows = cur;
      else if (range() === "midtones") o.midtones = cur;
      else o.highlights = cur;
      applyColorBalance(g, r, o, m);
    },
  };
}

function palBlackWhite(host: HTMLElement): PalForm {
  // AF2: −200…300 offsets, the dialog's weights for every channel (m10524).
  const f = buildBlackWhiteForm(host);
  return {
    label: () => "Black & White",
    op: (g, r, m) => applyBlackWhite(g, r, f.values(), m),
  };
}

function palPhotoFilter(host: HTMLElement): PalForm {
  // AF2: shared builder — Warming (85) at 25 % is the only default (m10524).
  const f = buildPhotoFilterForm(host);
  return {
    label: () => f.label(),
    op: (g, r, m) => {
      const v = f.values();
      applyPhotoFilter(g, r, {
        color: v.color, density: v.density, preserveLuminosity: v.preserveLuminosity,
      }, m);
    },
  };
}

function palChannelMixer(host: HTMLElement): PalForm {
  const rr = palSlider(host, "Red \u2190 R", -200, 200, 100, (v) => `${v}%`);
  const rg = palSlider(host, "Red \u2190 G", -200, 200, 0, (v) => `${v}%`);
  const rb = palSlider(host, "Red \u2190 B", -200, 200, 0, (v) => `${v}%`);
  const gr = palSlider(host, "Green \u2190 R", -200, 200, 0, (v) => `${v}%`);
  const gg = palSlider(host, "Green \u2190 G", -200, 200, 100, (v) => `${v}%`);
  const gb = palSlider(host, "Green \u2190 B", -200, 200, 0, (v) => `${v}%`);
  const br = palSlider(host, "Blue \u2190 R", -200, 200, 0, (v) => `${v}%`);
  const bg = palSlider(host, "Blue \u2190 G", -200, 200, 0, (v) => `${v}%`);
  const bb = palSlider(host, "Blue \u2190 B", -200, 200, 100, (v) => `${v}%`);
  const constant = palSlider(host, "Constant", -100, 100, 0, (v) => `${v}`);
  return {
    label: () => "Channel Mixer",
    op: (g, r, m) => applyChannelMixer(g, r, {
      red: [rr(), rg(), rb()],
      green: [gr(), gg(), gb()],
      blue: [br(), bg(), bb()],
      monochrome: false,
      constant: constant(),
    }, m),
  };
}

function palGradientMap(host: HTMLElement): PalForm {
  let start: [number, number, number] = [0, 0, 0];
  let end: [number, number, number] = [255, 255, 255];
  const row = document.createElement("div");
  row.className = "inline-row";
  const mkSwatch = (label: string, get: () => [number, number, number], set: (c: [number, number, number]) => void): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn subtle";
    b.textContent = label;
    b.title = `${label} colour \u2014 click to pick`;
    b.addEventListener("click", () => {
      openColorPicker(b, {
        get,
        set: (c) => { set(c); b.textContent = `${label} ${hex(c)}`; },
      });
    });
    b.textContent = `${label} ${hex(get())}`;
    return b;
  };
  const arrow = document.createElement("span");
  arrow.className = "label";
  arrow.textContent = "\u2192";
  row.append(
    mkSwatch("Shadows", () => start, (c) => { start = c; }),
    arrow,
    mkSwatch("Highlights", () => end, (c) => { end = c; }),
  );
  host.appendChild(row);
  palHint(host, "Gradient maps the layer\u2019s tones from shadows to highlights.");
  return {
    label: () => "Gradient Map",
    op: (g, r, m) => applyGradientMap(g, r, [{ pos: 0, color: [start[0], start[1], start[2]] }, { pos: 1, color: [end[0], end[1], end[2]] }], m),
  };
}

function palImmediate(label: string, op: TonalOpFn): PalBuilder {
  return (host) => {
    palHint(host, "No parameters \u2014 Apply runs it directly.");
    return { label: () => label, op };
  };
}

interface PalEntry { key: string; text: string; build: PalBuilder }

const PAL_BASIC: PalEntry[] = (Object.keys(KINDS) as AdjustmentKind[]).map((k) => ({
  key: k,
  text: k.charAt(0).toUpperCase() + k.slice(1),
  build: palBasicForm(k),
}));

const PAL_TONAL: PalEntry[] = [
  { key: "levels", text: "Levels", build: palLevels },
  { key: "curves", text: "Curves", build: palCurves },
  { key: "exposure", text: "Exposure", build: palExposure },
  { key: "vibrance", text: "Vibrance", build: palVibrance },
  { key: "colorBalance", text: "Colour Balance", build: palColorBalance },
  { key: "blackWhite", text: "Black & White", build: palBlackWhite },
  { key: "photoFilter", text: "Photo Filter", build: palPhotoFilter },
  { key: "channelMixer", text: "Channel Mixer", build: palChannelMixer },
  { key: "gradientMap", text: "Gradient Map", build: palGradientMap },
  { key: "desaturate", text: "Desaturate", build: palImmediate("Desaturate", (g, r, m) => applyDesaturate(g, r, m)) },
  { key: "autoTone", text: "Auto Tone", build: palImmediate("Auto Tone", (g, r, m) => autoTone(g, r, 0.5, m)) },
  { key: "autoContrast", text: "Auto Contrast", build: palImmediate("Auto Contrast", (g, r, m) => autoContrast(g, r, m)) },
  { key: "autoColor", text: "Auto Colour", build: palImmediate("Auto Colour", (g, r, m) => autoColor(g, r, m)) },
  { key: "equalize", text: "Equalize", build: palImmediate("Equalize", (g, r, m) => applyEqualize(g, r, m)) },
];

const PAL_ALL: PalEntry[] = [...PAL_BASIC, ...PAL_TONAL];

let palSelectKind: ((key: string) => void) | null = null;
/** Rebuild the open form from the live layer (values, not just the kind). */
let palRebuild: (() => void) | null = null;

function buildAdjustPalette(): HTMLElement {
  const win = document.createElement("div");
  win.className = "float-win";
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-label", "Adjustments");

  const head = document.createElement("div");
  head.className = "float-head";
  const title = document.createElement("b");
  title.textContent = "Adjustments";
  const close = document.createElement("button");
  close.className = "btn subtle icon float-close";
  close.type = "button";
  close.textContent = "\u00d7";
  close.title = "Close";
  close.setAttribute("aria-label", "Close adjustments palette");
  close.addEventListener("click", () => closeAdjustPalette());
  // Escape must work while focus is in a slider too: shortcutAllowed() rejects
  // INPUT/SELECT, so the global chain never saw the key (uiux-r14 #3).
  win.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closeAdjustPalette();
  });
  head.append(title, close);
  win.appendChild(head);

  const body = document.createElement("div");
  body.className = "float-body pal-body";

  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Adjustment");
  const grpB = document.createElement("optgroup");
  grpB.label = "Basic";
  for (const e of PAL_BASIC) {
    const o = document.createElement("option");
    o.value = e.key;
    o.textContent = e.text;
    grpB.appendChild(o);
  }
  const grpT = document.createElement("optgroup");
  grpT.label = "Tonal";
  for (const e of PAL_TONAL) {
    const o = document.createElement("option");
    o.value = e.key;
    o.textContent = e.text;
    grpT.appendChild(o);
  }
  sel.append(grpB, grpT);

  const formArea = document.createElement("div");
  formArea.className = "pal-form";

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "btn primary";
  apply.textContent = "Apply";

  let current: PalForm | null = null;
  palSelectKind = (key: string): void => {
    const entry = PAL_ALL.find((e) => e.key === key) ?? PAL_ALL[0]!;
    sel.value = entry.key;
    formArea.replaceChildren();
    current = entry.build(formArea);
  };
  sel.addEventListener("change", () => palSelectKind?.(sel.value));
  // With no rebuild, closing on one layer and opening on another showed the
  // previous layer's numbers under the new layer's name (uiux-r18): every
  // field was created once and never re-read.
  palRebuild = (): void => { if (activeLayer) palSelectKind?.(sel.value); };
  apply.addEventListener("click", () => {
    if (!current) return;
    const f = current;
    if (activeLayer.locked) { warnLocked(); return; }
    runTonalOp(f.label(), f.op);
    tonalPanel.refreshHistogram();
  });

  body.append(sel, formArea, apply);
  win.appendChild(body);

  // drag by the head bar, clamped inside the app window
  head.addEventListener("pointerdown", (e) => {
    if (e.target === close) return;
    e.preventDefault();
    const rect = win.getBoundingClientRect();
    adjustPalDrag = {
      sx: e.clientX, sy: e.clientY,
      ox: rect.left, oy: rect.top, ox2: rect.left,
    };
    const move = (ev: PointerEvent): void => {
      if (!adjustPalDrag) return;
      const w = win.offsetWidth || 260;
      const h = win.offsetHeight || 320;
      const x = Math.max(4, Math.min(window.innerWidth - w - 4, adjustPalDrag.ox + (ev.clientX - adjustPalDrag.sx)));
      const y = Math.max(4, Math.min(window.innerHeight - h - 4, adjustPalDrag.oy + (ev.clientY - adjustPalDrag.sy)));
      win.style.left = `${x}px`;
      win.style.top = `${y}px`;
      adjustPalPos = { x, y };
    };
    const up = (): void => {
      adjustPalDrag = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // X4: a cancelled pointer or a lost window focus used to leave the drag
    // flag set and BOTH window listeners attached forever.
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
  });

  palSelectKind(sel.value);
  return win;
}

/** The control that opened the palette, so closing returns focus there. */
let adjustPalOpener: HTMLElement | null = null;

function openAdjustPalette(kind?: string): void {
  const opener = document.activeElement;
  if (opener instanceof HTMLElement) adjustPalOpener = opener;
  if (!adjustPal) adjustPal = buildAdjustPalette();
  if (adjustPal.parentNode !== document.body) document.body.appendChild(adjustPal);
  adjustPal.style.display = "flex";
  if (!adjustPalPos) {
    const w = adjustPal.offsetWidth || 260;
    adjustPalPos = { x: Math.max(8, window.innerWidth - w - 24), y: 90 };
  }
  // Clamp on every open: a shrink while the palette sat near the right edge
  // left it partly unreachable, and close/reopen reused the stale point
  // (uiux-r16 #3).
  clampAdjustPal();
  adjustPal.style.left = `${adjustPalPos.x}px`;
  adjustPal.style.top = `${adjustPalPos.y}px`;
  if (kind) palSelectKind?.(kind);
  // Always re-read: the palette outlives the layer it was built for.
  palRebuild?.();
  // A role="dialog" that never takes focus leaves the keyboard user tabbing
  // through the page to find it (uiux-r15 #5).
  const first = adjustPal.querySelector<HTMLElement>(".pal-body select, .pal-body button, .pal-body input");
  first?.focus();
}

function clampAdjustPal(): void {
  if (!adjustPal || !adjustPalPos) return;
  const w = adjustPal.offsetWidth || 260;
  const h = adjustPal.offsetHeight || 320;
  adjustPalPos = {
    x: Math.max(8, Math.min(window.innerWidth - w - 8, adjustPalPos.x)),
    y: Math.max(8, Math.min(window.innerHeight - h - 8, adjustPalPos.y)),
  };
}

function closeAdjustPalette(restoreFocus = true): void {
  if (adjustPal) adjustPal.style.display = "none";
  const back = adjustPalOpener;
  adjustPalOpener = null;
  // A tab switch or a geometry commit closes the palette; pulling focus back to
  // the toolbar would then act on the wrong surface (uiux-r19 #6).
  if (restoreFocus && back?.isConnected) back.focus();
}

function focusFilter(id: string): void {
  fSel.value = id;
  syncFUI();
  pulse(filterBox);
}

// ---- menu bar ------------------------------------------------------------

function menuDefs(): { title: string; items: MenuItem[] }[] {
  const fileItems: MenuItem[] = topActions
    .filter((a) => a.menu === "file")
    .map((a) => ({
      label: a.label,
      icon: a.icon,
      run: a.run,
      key: { "New": "Ctrl+N", "Open Image…": "Ctrl+O", "Open Project…": "Ctrl+Shift+O", "Save Project": "Ctrl+S", "Save Project As…": "Ctrl+Shift+S", "Export As…": "Ctrl+Shift+E" }[a.label],
    }));
  const imageItems: MenuItem[] = topActions
    .filter((a) => a.menu === "image")
    .map((a) => ({ label: a.label, icon: a.icon, run: a.run }));

  // every adjustments entry opens the SAME floating palette (user request)
  // and triggers the clicked adjustment inside it.
  const tonalItems: MenuItem[] = [
    { label: "Levels\u2026", run: () => openAdjustPalette("levels") },
    { label: "Curves\u2026", run: () => openAdjustPalette("curves") },
    { label: "Exposure\u2026", run: () => openAdjustPalette("exposure") },
    { label: "Vibrance\u2026", run: () => openAdjustPalette("vibrance") },
    { sep: true },
    { label: "Colour Balance\u2026", run: () => openAdjustPalette("colorBalance") },
    { label: "Black & White\u2026", run: () => openAdjustPalette("blackWhite") },
    { label: "Photo Filter\u2026", run: () => openAdjustPalette("photoFilter") },
    { label: "Channel Mixer\u2026", run: () => openAdjustPalette("channelMixer") },
    { label: "Gradient Map\u2026", run: () => openAdjustPalette("gradientMap") },
    { sep: true },
    { label: "Desaturate", run: () => openAdjustPalette("desaturate") },
    { label: "Auto Tone", key: "Ctrl+Shift+L", run: () => openAdjustPalette("autoTone") },
    { label: "Auto Contrast", run: () => openAdjustPalette("autoContrast") },
    { label: "Auto Colour", run: () => openAdjustPalette("autoColor") },
    { label: "Equalize", run: () => openAdjustPalette("equalize") },
  ];
  const adjItems: MenuItem[] = (Object.keys(KINDS) as AdjustmentKind[]).map((k) => ({
    label: `${k.charAt(0).toUpperCase()}${k.slice(1)}\u2026`,
    run: () => openAdjustPalette(k),
  }));
  const filItems: MenuItem[] = FILTERS.map((spec) => ({
    label: `${spec.label}…`,
    run: () => focusFilter(spec.id),
  }));

  const layerIdx = doc.layers.indexOf(activeLayer);
  return [
    {
      title: "File",
      items: [
        // AG2: six rows — Save Project As… is the sixth, and the menu is the
        // only place it is visible as an action.
        ...fileItems.slice(0, 6),
        { sep: true },
        { label: "Close Tab", key: "Ctrl+W", run: () => closeActiveTab() },
      ],
    },
    {
      title: "Edit",
      items: [
        { label: "Undo", key: "Ctrl+Z", disabled: !session.canUndo, why: "There is nothing to undo in this document.", run: undoDocument },
        { label: "Redo", key: "Ctrl+Shift+Z", disabled: !session.canRedo, why: "There is nothing to redo.", run: redoDocument },
        { sep: true },
        { label: "Cut", key: "Ctrl+X", disabled: !activeLayer || activeLayer.locked, run: cutFromDoc },
        { label: "Copy", key: "Ctrl+C", run: () => copyFromDoc(false) },
        { label: "Copy Merged", key: "Ctrl+Shift+C", run: () => copyFromDoc(true) },
        { label: "Paste", key: "Ctrl+V", disabled: !clip, run: pasteClip },
        { sep: true },
        { label: "Fill with Foreground", key: "Alt+Backspace", run: fillWithForeground },
        {
          label: "Smart Fill",
          disabled: !selMask,
          run: contentAwareFillSelection,
        },
        { label: "Clear", key: "Delete", disabled: !(selRect || selMask), run: clearSelection },
        { sep: true },
        { label: "Free Transform", key: "Ctrl+T", run: enterTransform },
      ],
    },
    {
      title: "Image",
      items: [
        { header: "Adjustments" },
        ...tonalItems,
        { sep: true },
        { header: "Basic" },
        ...adjItems,
        { sep: true },
        ...imageItems,
        { sep: true },
        { label: "Crop to Selection", disabled: !selRect, run: () => { if (cropRect === null && selRect) { cropRect = { ...selRect }; applyCropNow(); } } },
      ],
    },
    {
      title: "Layer",
      items: [
        { label: "New Layer", key: "Ctrl+Shift+N", run: addNewLayer },
        { label: "New Adjustment Layer…", run: addAdjustmentLayer },
        { label: "New Fill Layer…", run: addFillLayer },
        {
          label: "Adjustment Settings…",
          disabled: !(activeLayer.kind === "adjust" && activeLayer.adjust),
          run: () => editAdjustLayer(activeLayer),
        },
        { sep: true },
        {
          label: "Convert to Smart Object",
          disabled: !canMakeSmart(activeLayer),
          why: "Only a pixel layer with content can become a smart object.",
          run: convertToSmartObject,
        },
        {
          label: "Rasterize Smart Object",
          disabled: !activeLayer.smart,
          why: "Only a smart object can be rasterized.",
          run: rasterizeSmartObject,
        },
        {
          label: "Replace Smart Object Contents…",
          disabled: !activeLayer.smart,
          why: "Only a smart object can take new contents.",
          run: replaceSmartContents,
        },
        ...groupAuthoringItems(
          activeLayer,
          doc,
          (entry) => pushHist(entry),
          declaredChange,
          (next) => { activeLayer = next; },
          () => { renderLayers(); render(); renderHistoryPanel(); },
        ),
        { label: "Duplicate Layer", key: "Ctrl+J", run: duplicateActiveLayer },
        { label: deleteLayerLabel(activeLayer), disabled: !canDeleteLayer(doc, activeLayer), why: "A document keeps at least one layer.", run: deleteActiveLayer },
        { sep: true },
        // X2: the four layer ops that used to live only in the pointer context
        // menu now reach the Menu bar (one implementation, both surfaces)
        { label: "Rename Layer…", run: () => beginLayerRename(activeLayer) },
        { label: activeLayer.visible ? "Hide Layer" : "Show Layer", run: () => toggleLayerVisibility(activeLayer) },
        { label: activeLayer.locked ? "Unlock Layer" : "Lock Layer", run: () => toggleLayerLock(activeLayer) },
        { label: "Blending ▸", children: layerBlendItems(activeLayer) },
        {
          label: "Layer Mask ▸",
          children: [
            { label: "Add Layer Mask", run: addLayerMaskFromSelection },
            {
              label: "Paint on Layer Mask",
              disabled: !activeLayer.mask,
              why: "This layer has no mask to paint on.",
              run: () => { paintTarget = "mask"; refreshOptions(); renderLayers(); },
            },
            {
              label: "Paint on Pixels",
              disabled: !activeLayer.mask,
              why: "There is no mask to leave.",
              run: () => { paintTarget = "pixel"; refreshOptions(); renderLayers(); },
            },
            {
              label: "Apply Layer Mask",
              disabled: !activeLayer.mask,
              why: "This layer has no mask to apply.",
              run: applyLayerMaskNow,
            },
            {
              label: "Delete Layer Mask",
              disabled: !activeLayer.mask,
              why: "This layer has no mask to delete.",
              run: deleteLayerMask,
            },
          ],
        },
        {
          label: "Rasterize Type",
          disabled: !activeLayer.textData,
          why: "Only a text layer can be rasterized.",
          run: () => rasterizeTypeLayer(activeLayer),
        },
        { label: "Quick Export as PNG", run: quickExportPng },
        { sep: true },
        { label: "Merge Down", key: "Ctrl+E", disabled: layerIdx <= 0, why: "The active layer is the bottom one.", run: mergeDown },
        { label: "Flatten Image", run: flattenImage },
      ],
    },
    {
      title: "Select",
      items: [
        { label: "All", key: "Ctrl+A", run: selectAll },
        { label: "Deselect", key: "Ctrl+D", disabled: !(selRect || selMask), run: deselect },
        { label: "Inverse", key: "Ctrl+Shift+I", run: invertSelection },
        { label: "Grow", run: selectGrow },
        { label: "Similar", run: selectSimilar },
        { label: "Colour Range…", run: selectColourRange },
        { header: "Modify" },
        { label: "Expand…", run: selectExpand },
        { label: "Contract…", run: selectContract },
        { label: "Feather…", run: selectFeather },
        { label: "Smooth…", run: selectSmooth },
        { label: "Border…", run: selectBorder },
        { label: "Select and Mask…", run: selectAndMask },
      ],
    },
    { title: "Filter", items: [{ header: "Filters" }, ...filItems] },
    {
      title: "View",
      items: [
        { label: "Zoom In", key: "Ctrl++", run: () => zoomBy(1.25) },
        { label: "Zoom Out", key: "Ctrl+-", run: () => zoomBy(1 / 1.25) },
        { label: "Fit on Screen", key: "Ctrl+0", run: fit },
        { label: "Actual Pixels", key: "Ctrl+1", run: actualPixels },
        { sep: true },
        { label: "Show / Hide Panels", key: "Tab", run: () => { toggleChrome(); relayout(); } },
        { label: "Reset Panel Layout", run: () => { resetDock(panels, relayout); } },
        { sep: true },
        {
          label: "Compact Toolbar (Two Columns)",
          checked: toolbarCols === 2,
          run: () => { toolbarSizeBtn.click(); }, // same fold/expand logic as the little top button
        },
        { label: "Reset Toolbar Width", run: () => { toolbarW = 50; toolbarCols = 1; applyToolbar(); } },
      ],
    },
    {
      title: "Help",
      items: [
        { label: "Keyboard Shortcuts", run: showShortcuts },
        { label: "About Guazzo", run: showAbout },
      ],
    },
  ];
}


/**
 * Search tools and actions (Ctrl/Cmd+K).
 *
 * The entries are DERIVED, never hand-listed: tools come from TOOL_IDS +
 * TOOL_LABELS (the same table the toolbar derives its tooltips from) and actions
 * come from menuDefs(), so anything that exists in a menu is searchable and the
 * palette cannot drift from the UI.
 */
function showShortcuts(): void {
  const body = document.createElement("div");
  body.className = "shortcuts";
  // generated from src/ui/shortcuts.ts — a test checks every row against the key
  // chain, because the hand-written list used to teach shortcuts nothing handled
  const rows = SHORTCUTS;
for (const { keys: k, what } of rows) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.innerHTML = `<kbd>${k}</kbd><span>${what}</span>`;
    body.appendChild(row);
  }
  showModal("Keyboard Shortcuts", body, () => {});
}

function showAbout(): void {
  // Compact by design: the licence and the notices are long documents, and
  // inlining them pushed this dialog off the bottom of a 900x600 window (user
  // report). They are now two rows that open their own scrollable dialog.
  const body = document.createElement("div");
  body.className = "about";
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">${appMarkSvg(34)}<p style="margin:0"><b>Guazzo</b> ${APP_VERSION} — a fully offline image editor.</p></div>
    <p class="label">&copy; 2026 ${OWNER_NAME.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>
    <p>All files stay on your device — Guazzo contains no networking code.</p>
    <p>Photoshop&reg; is a trademark of Adobe Inc. Guazzo is not affiliated with,
    endorsed by, or sponsored by Adobe.</p>
    <p class="label">Tile-based engine · 27 blend modes · WebView2 shell · zero runtime dependencies</p>`;

  const link = (label: string, hint: string, text: string): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "about-link";
    b.innerHTML = `<span class="al-main">${label}</span><span class="al-hint">${hint}</span>`;
    b.addEventListener("click", () => showTextDialog(label, text));
    body.appendChild(b);
  };
  link("Licence", "the terms this copy is licensed under", LICENCE_TEXT);
  link("Third-party notices", "MIT, Apache-2.0 and other components", NOTICES_TEXT);

  showModal("About Guazzo", body, () => {}, { single: true, narrow: true });
}

const menuBarEl = document.createElement("nav");
menuBarEl.id = "menubar";
topbar.insertBefore(menuBarEl, topbar.children[1] ?? null);

/**
 * Frameless-window chrome (desktop only). The OS title bar is off in main.rs,
 * so the app supplies the title strip: dragging, the three buttons, and eight
 * resize grips that hand the gesture back to the native window manager (which
 * is what keeps snapping and resizing smooth).
 */
/**
 * The Find button sits at the right of the title strip, immediately left of the
 * window controls, and opens the same search dialog as Ctrl/Cmd+K — a visible
 * door to a feature that was otherwise keyboard-only.
 */
/** The palette's contents, derived from the tool table and the real menus. */
function commandEntries(): ReturnType<typeof buildPaletteEntries> {
  return buildPaletteEntries({
    menus: menuDefs(),
    runTop,
    selectTool: (id) => { tool = id; highlight(); },
    statusHint,
  });
}

/**
 * AB2: every close path — the caption ✕, Alt+F4, the taskbar — ends here, so an
 * unsaved document cannot disappear without the user saying yes. Save Project
 * still needs a click; the question is only "lose the changes?".
 */
const closeLoop = createCloseLoop();

/**
 * Save every dirty document, one tab at a time. `Save Project` writes the tab
 * that is on screen, so the loop has to switch first — and switching is also
 * what flushes a live transform or text edit into the document being written.
 */
async function saveAllDirtyTabs(): Promise<void> {
  for (let i = 0; i < tabsView().length; i++) {
    if (!tabsView()[i]?.dirty) continue;
    if (activeIndex() !== i) activateTab(i);
    await saveProject(true);
  }
}

async function closeWithGuard(): Promise<void> {
  // AL1: one prompt at a time. The 400 ms poller used to start a second
  // closeWithGuard() while the first ask() was still open, so dismissing the
  // dialog answered one while another stacked on top of it.
  if (!closeLoop.begin()) return;
  try {
    // The live shell state is the active tab's real state until a switch
    // captures it; without this, editing the active document leaves the tab
    // slot's dirty flag stale and the close guard believes nothing was lost.
    captureTab();
    const dirty = tabsView().filter((t) => t.dirty);
    if (dirty.length > 0) {
      const names = dirty.map((t) => t.name).join(", ");
      // ui11: the prompt offered only "close and lose it" or "cancel". A Save
      // answer writes each dirty document first and then closes, which is what
      // the question is actually about.
      let saveFirst = false;
      const closeAnyway = await ask(
        "Unsaved changes",
        `${dirty.length === 1 ? "1 document has" : `${dirty.length} documents have`} unsaved changes: ${names}.\n\nClosing loses them.`,
        "Close without saving",
        "neutral",
        { label: "Save", run: () => { saveFirst = true; } },
      );
      if (saveFirst) {
        await saveAllDirtyTabs();
        // A cancelled native dialog leaves the tab dirty. That is a "no" from
        // the user, not a licence to close: put them back in the app.
        if (anyTabDirty()) return;
      } else if (!closeAnyway) {
        return;
      }
    }
    cancelTransform();
    commitText();
    await windowForceClose();
  } finally {
    closeLoop.end();
    // AL1: ack on EVERY exit, including cancel. Rust used to clear the flag only
    // in win_force_close, so "Keep editing" left it set and the dialog returned
    // 400 ms later, forever.
    await ackCloseRequest();
  }
}

mountWindowChrome(topbar, {
  onClose: () => void closeWithGuard(),
  openPalette: () => openCommandPalette(commandEntries()),
});
if (isTauri()) {
  // the OS asked to close (Alt+F4 / taskbar): route it through the same guard
  window.setInterval(() => { void (async () => {
    if (!(await takeCloseRequest())) return;
    await closeWithGuard();
  })(); }, 400);
} else {
  // AE5: internals present with no callable invoke is a broken shell, not a
  // browser — say it out loud instead of quietly running the download build.
  const broken = shellHealth();
  if (broken) console.error(`Guazzo: ${broken} — running as the browser build`);
}


function openContextMenuFromKeyboard(): void {
  const el = (document.activeElement ?? document.body) as HTMLElement;
  const r = el.getBoundingClientRect();
  const ev = new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  });
  el.dispatchEvent(ev);
}

// ---- internal clipboard (Copy / Cut / Copy Merged / Paste) ----------------
let clip: { w: number; h: number; data: Uint8ClampedArray } | null = null;

function copyFromDoc(merged: boolean, silent = false): void {
  const layer = activeLayer;
  if (!layer || layer.locked) { if (layer) warnLocked(); return; }
  // adjustment/fill layers have no pixels of their own — Copy would paste an
  // invisible empty layer. Refuse honestly instead of lying in the hint.
  // (Copy MERGED stays available: it composites the whole stack.)
  if (!merged && layer.kind !== "pixel") {
    statusHint("Nothing to copy — rasterize the layer first");
    return;
  }
  if (!merged && paintTarget === "mask" && layer.mask) {
    // Delete clears the mask and Cut refuses it; Copy used to claim it copied
    // pixels while the chip said mask (code-r24 #4).
    statusHint("Copy works on pixels — switch the chip to Pixels first.");
    return;
  }
  const r = selectionRect();
  if (r.w < 1 || r.h < 1) return;
  const data = new Uint8ClampedArray(r.w * r.h * 4);
  if (merged) doc.compositeRect(r.x, r.y, r.w, r.h, data);
  else layer.grid.readRect(r.x, r.y, r.w, r.h, data);
  // A rectangle copy carried the hard box of a feathered or lasso selection;
  // Cut softens by the same mask, so the two used to disagree about the same
  // selection. Multiply alpha by the mask's coverage.
  if (selMask) {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const cov = selMask.alphaAt(r.x + x, r.y + y);
        if (cov >= 255) continue;
        data[(y * r.w + x) * 4 + 3] = Math.round((data[(y * r.w + x) * 4 + 3] ?? 0) * (cov / 255));
      }
    }
  }
  clip = { w: r.w, h: r.h, data };
  if (!silent) statusHint(merged ? "Copied merged pixels" : `Copied ${r.w} × ${r.h} px`);
}

function cutFromDoc(): void {
  const layer = activeLayer;
  if (!layer || layer.locked) { if (layer) warnLocked(); return; }
  if (layer.kind !== "pixel") { statusHint("Nothing to cut — rasterize the layer first"); return; }
  if (layer.smart) { statusHint("A smart object keeps its original image — rasterize it before cutting."); return; }
  if (paintTarget === "mask" && layer.mask) {
    // Cut copies pixels; with the mask chip lit it used to clear the layer's
    // pixels while the mask was untouched (code-r23 #5).
    statusHint("Cut works on pixels — switch the chip to Pixels first.");
    return;
  }
  if (layer.textData) {
    statusHint("Rasterize the type first — a live text layer has no fixed pixels.");
    return;
  }
  // capture the pixels BEFORE mutating — one conceptual action, ONE undo
  copyFromDoc(false, true);
  const entry = layerOpCommand(layer, "Cut", () => {
    if (selMask) clearMasked(layer.grid, selMask);
    else if (selRect) layer.grid.fillRect(selRect.x, selRect.y, selRect.w, selRect.h, [0, 0, 0, 0]);
  });
  if (!entry) return;
  pushHist(entry);
  declaredChange();
  render();
  renderHistoryPanel();
  statusHint("Cut");
}

function pasteClip(): void {
  if (!clip) return;
  commitText();
  const w = Math.min(clip.w, doc.width);
  const h = Math.min(clip.h, doc.height);
  const name = `Pasted ${clip.w} × ${clip.h}`;
  const layer = doc.addLayer(name);
  const x = (doc.width - w) >> 1;
  const y = (doc.height - h) >> 1;
  // X5: when the clipboard is bigger than the canvas, keep its MIDDLE — the old
  // code cropped the top-left and then centred that, so the visible half of a
  // large paste came from the wrong corner.
  const sx = Math.max(0, (clip.w - w) >> 1);
  const sy = Math.max(0, (clip.h - h) >> 1);
  // writeRect indexes its src with stride w and demands a true w*h*4 buffer,
  // so a clip wider than the clamped paste rect MUST be cropped first — the
  // oversized buffer would silently shear rows (row 1 from the tail of row 0).
  layer.grid.writeRect(x, y, w, h, cropRGBAAt(clip.data, clip.w, sx, sy, w, h));
  activeLayer = layer;
  pushHist(addAboveActive(doc, layer));
  declaredChange();
  render();
  renderLayers();
  renderHistoryPanel();
  statusHint(`Pasted as “${name}”`);
}

function quickExportPng(): void {
  // Same reason as saveProject: exporting under a live transform shipped the
  // pre-transform picture and reported success.
  if (transform) applyTransform();
  // `scale` is a 0.1–2.0 fraction, not a percentage: 100 asked for a
  // hundred-times export, which the size guard refused for every document
  // bigger than ~81 px (code-r30 #2).
  runExport({ format: "png", quality: 100, scale: 1, filename: activeTabName() });
}

function canvasContextMenu(ev: MouseEvent): void {
  const items: MenuItem[] = [
    { label: "Undo", key: "Ctrl+Z", disabled: !session.canUndo, run: undoDocument },
    { label: "Redo", key: "Ctrl+Shift+Z", disabled: !session.canRedo, run: redoDocument },
    { sep: true },
    { label: "Cut", key: "Ctrl+X", disabled: !activeLayer || activeLayer.locked, run: cutFromDoc },
    { label: "Copy", key: "Ctrl+C", run: () => copyFromDoc(false) },
    { label: "Copy Merged", key: "Ctrl+Shift+C", run: () => copyFromDoc(true) },
    { label: "Paste", key: "Ctrl+V", disabled: !clip, run: pasteClip },
    { sep: true },
    { label: "Select All", key: "Ctrl+A", run: selectAll },
    { label: "Deselect", key: "Ctrl+D", disabled: !selRect && !selMask, run: deselect },
    { label: "Inverse", key: "Ctrl+Shift+I", disabled: !selRect && !selMask, run: invertSelection },
    { sep: true },
    { label: "Fill with Foreground", key: "Alt+Backspace", run: fillWithForeground },
    { label: "Clear", key: "Del", disabled: !selRect && !selMask, run: clearSelection },
    {
      label: "Crop to Selection",
      disabled: !selRect,
      // The Image-menu entry copies the selection into cropRect first; this one
      // used to call applyCropNow directly and return, so two commands with one
      // name did different things.
      run: () => {
        if (!selRect) return;
        cropRect = { ...selRect };
        applyCropNow();
      },
    },
    { sep: true },
    { label: "Quick Export as PNG", run: quickExportPng },
    { label: "Export As…", run: () => runTop("Export As…") },
  ];
  showContextMenu(ev, items);
}

host.addEventListener("contextmenu", canvasContextMenu);

/** Right-click on a text/number field: real edit ops, not the browser menu. */
function inputContextMenu(t: HTMLElement): MenuItem[] {
  const editable = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  const hasSel = editable
    ? (t as HTMLInputElement).selectionStart !== (t as HTMLInputElement).selectionEnd
    : false;
  const exec = (cmd: string): boolean => {
    try { return document.execCommand(cmd); } catch { return false; }
  };
  const pasteInto = async (el: HTMLInputElement | HTMLTextAreaElement): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const s = el.selectionStart ?? el.value.length;
      const epos = el.selectionEnd ?? el.value.length;
      el.value = el.value.slice(0, s) + text + el.value.slice(epos);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      statusHint("Clipboard unavailable — use Ctrl+V");
    }
  };
  return [
    { label: "Cut", disabled: !hasSel, run: () => { t.focus(); exec("cut"); } },
    { label: "Copy", disabled: !hasSel, run: () => { t.focus(); exec("copy"); } },
    {
      label: "Paste",
      run: () => {
        t.focus();
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) void pasteInto(t);
      },
    },
    { label: "Select All", run: () => { t.focus(); exec("selectAll"); } },
  ];
}

// global suppression: surfaces above stopPropagation() first, everything else
// (panels, options bar, menubar) gets the browser menu disabled. Text fields
// used to fall through to the native menu (Reload/Cut/Copy — the user called
// those "irrelevant"); they now get the in-app edit menu instead.
appEl?.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
    e.preventDefault();
    showContextMenu(e, inputContextMenu(t));
    return;
  }
  e.preventDefault();
});

// ---- menu bar installation ------------------------------------------------
// The bar (buttons, flyouts, open-state) lives in src/ui/popup.ts; the shell
// only supplies the definitions, rebuilt on refresh so Undo/Redo stay fresh.
mountMenuBar(menuBarEl, menuDefs);

// ---- tooltips: anything with a title shows a custom tip after 500 ms ------
const tipEl = document.createElement("div");
tipEl.className = "tooltip";
tipEl.setAttribute("role", "tooltip");
document.body.appendChild(tipEl);
const TIP_DELAY = 500;
let tipTimer: ReturnType<typeof setTimeout> | null = null;
let tipTarget: HTMLElement | null = null;

function showTip(el: HTMLElement): void {
  const text = el.getAttribute("data-tip");
  if (!text) return;
  tipEl.textContent = text;
  tipEl.classList.add("show");
  const r = el.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  let top = r.bottom + 8;
  if (top + tr.height > window.innerHeight - 6) top = r.top - tr.height - 8;
  left = Math.max(6, Math.min(window.innerWidth - tr.width - 6, left));
  top = Math.max(6, top);
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}

function hideTip(): void {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
  tipTarget = null;
  tipEl.classList.remove("show");
}

document.addEventListener("pointerover", (e) => {
  const t = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
  if (!t || t === tipTarget) return;
  if (tipTimer) clearTimeout(tipTimer);
  tipTarget = t;
  tipEl.classList.remove("show");
  tipTimer = setTimeout(() => { if (tipTarget === t) showTip(t); }, TIP_DELAY);
});
document.addEventListener("pointerout", (e) => {
  const t = (e.target as Element | null)?.closest?.("[data-tip]");
  if (t && t === tipTarget) hideTip();
});
window.addEventListener("pointerdown", hideTip, true);
window.addEventListener("wheel", hideTip, true);
window.addEventListener("blur", hideTip);

/** Native `title` attributes become our own tooltip, including ones created
 *  later by panel re-renders. */
function promoteTitles(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll("[title]")) as HTMLElement[]) {
    const t = el.getAttribute("title");
    if (t) {
      el.setAttribute("data-tip", t);
      el.removeAttribute("title");
    }
  }
}
new MutationObserver((records) => {
  for (const rec of records) {
    if (rec.type === "attributes") {
      const el = rec.target as HTMLElement;
      promoteTitles(el.parentElement ?? el);
    } else {
      for (const n of Array.from(rec.addedNodes)) {
        if (n.nodeType === 1) promoteTitles(n as Element);
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
// resizing must not strand an open menu or a squashed bar
let optionsFitQueued = false;
window.addEventListener("resize", () => {
  closeMenus();
  ensureMenuBar();
  clampAdjustPal();
  // the bar's page split depends on the window width: re-fit after the layout
  // settles, never mid-event (the measurement must be post-layout to be right)
  if (!optionsFitQueued) {
    optionsFitQueued = true;
    requestAnimationFrame(() => { optionsFitQueued = false; fitOptionsPages(); });
  }
});
// the window is not the only thing that resizes: dragging the panel column or
// the toolbar changes the bar's width too, and a stale page split then hides
// controls behind a `>` that no longer matches (analysis UX 8)
{
  const bar = document.getElementById("options");
  if (bar && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (optionsFitQueued) return;
      optionsFitQueued = true;
      requestAnimationFrame(() => { optionsFitQueued = false; fitOptionsPages(); });
    }).observe(bar);
  }
}
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => ensureMenuBar()).observe(topbar);
}
promoteTitles(document);

// ---- New Document dialog (Photoshop-style) --------------------------------
// The dialog itself lives in ./ui/newdoc.ts; units and presets are unit-tested
// in ./engine/docmeta.ts.
// ---- colour panel (foreground/background, RGB sliders, swatches) ----------
const colorBox = document.createElement("div");
colorBox.className = "card";
panels.appendChild(colorBox);
cardHead(colorBox, "eyedropper", "Colour");
const colorBody = document.createElement("div");
colorBody.className = "card-body tight";
colorBox.appendChild(colorBody);

const hex = (c: [number, number, number]): string =>
  "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
function setForeground(c: [number, number, number], remember = true): void {
  color[0] = c[0]; color[1] = c[1]; color[2] = c[2];
  syncColorWell();
  if (remember) pushSwatch(c);
  else syncColorPanel();
  restyleTextEditor();
}

const swatches: [number, number, number][] = [];
const swatchRow = document.createElement("div");
swatchRow.className = "inline-wrap swatches";
colorBody.appendChild(swatchRow);

function pushSwatch(c: [number, number, number]): void {
  const key = hex(c);
  if (swatches.some((w) => hex(w) === key)) { syncColorPanel(); return; }
  swatches.unshift([c[0], c[1], c[2]]);
  if (swatches.length > 10) swatches.length = 10;
  renderSwatches();
  syncColorPanel();
}
function renderSwatches(): void {
  swatchRow.innerHTML = "";
  for (const c of swatches) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = hex(c);
    b.title = hex(c);
    b.setAttribute("aria-label", `Set foreground colour ${hex(c)}`);
    b.addEventListener("click", () => setForeground(c));
    b.addEventListener("contextmenu", (e) => {
      const idx = swatches.indexOf(c);
      showContextMenu(e, [
        { label: "Delete Swatch", disabled: idx < 0, run: () => { swatches.splice(idx, 1); renderSwatches(); } },
        { label: "Clear All Swatches", disabled: swatches.length === 0, run: () => { swatches.length = 0; renderSwatches(); statusHint("Swatches cleared"); } },
      ]);
    });
    swatchRow.appendChild(b);
  }
}

const hexInput = document.createElement("input");
hexInput.type = "text";
hexInput.className = "hex";
hexInput.spellcheck = false;
hexInput.title = "Hex colour, e.g. #5b8cff";
hexInput.setAttribute("aria-label", "Hex colour");
hexInput.addEventListener("change", () => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexInput.value.trim());
  if (!m) { syncColorPanel(); return; }
  const v = m[1]!;
  setForeground([parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]);
});
colorBody.appendChild(hexInput);

const bgWell = document.createElement("input");
bgWell.type = "color";
bgWell.className = "color-well";
bgWell.id = "bg-well";
bgWell.title = "Background colour (X swaps)";
bgWell.value = hex(bgColor);
bgWell.addEventListener("input", () => {
  bgColor = [parseInt(bgWell.value.slice(1, 3), 16), parseInt(bgWell.value.slice(3, 5), 16), parseInt(bgWell.value.slice(5, 7), 16)];
});
colorBody.appendChild(bgWell);

const swapBtn = document.createElement("button");
swapBtn.className = "btn icon subtle";
swapBtn.title = "Swap foreground and background (X)";
swapBtn.setAttribute("aria-label", "Swap foreground and background colours");
swapBtn.innerHTML = iconSvg("swap", 14);
swapBtn.addEventListener("click", () => swapColors());
colorBody.appendChild(swapBtn);

function swapColors(): void {
  const t = bgColor;
  bgColor = [color[0], color[1], color[2]];
  bgWell.value = hex(bgColor);
  setForeground(t, false);
}

const CHANNELS: { key: 0 | 1 | 2; label: string }[] = [
  { key: 0, label: "R" }, { key: 1, label: "G" }, { key: 2, label: "B" },
];
const channelRanges: HTMLInputElement[] = [];
for (const ch of CHANNELS) {
  const row = document.createElement("div");
  row.className = "inline-row";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.textContent = ch.label;
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "255";
  range.style.width = "96px";
  range.setAttribute("aria-label", ch.label);
  const val = document.createElement("span");
  val.className = "value";
  val.style.minWidth = "26px";
  range.addEventListener("input", () => {
    color[ch.key] = Number(range.value);
    val.textContent = range.value;
    syncColorWell();
    restyleTextEditor();
    // The card's own hex field was written only on open and on eyedropper
    // picks, so it showed a stale value the next time it was committed
    // (uiux-r18 #5). One colour, one place to read it from.
    hexInput.value = hex([color[0], color[1], color[2]]);
  });
  channelRanges.push(range);
  row.append(lab, range, val);
  colorBody.appendChild(row);
}

function syncColorPanel(): void {
  hexInput.value = hex([color[0], color[1], color[2]]);
  CHANNELS.forEach((ch, i) => {
    const r = channelRanges[i]!;
    r.value = String(color[ch.key]);
    const val = r.parentElement?.querySelector(".value");
    if (val) val.textContent = String(color[ch.key]);
  });
}
syncColorPanel();
renderSwatches();

/** Eyedropper: sample the MERGED frame (Photoshop's default "All Layers"). */
function pickColor(x: number, y: number): void {
  if (flatCache.needsComposite(doc.revision)) renderFlat();
  const s = sampleColor({ width: doc.width, height: doc.height, data: flatCache.buffer }, Math.round(x), Math.round(y), eyeSize);
  if (!s) return;
  setForeground([s.r, s.g, s.b]);
  const fresh = hex([s.r, s.g, s.b]);
  hexInput.value = fresh;
}


// ---- keyboard actions -----------------------------------------------------
// One handler per KeyAction. The table in ui/keymap.ts decides WHICH combo runs
// which id; this map decides what the id does. Both are checked against
// Help ▸ Keyboard Shortcuts by src/engine/tests/keymap.test.ts.
const KEY_HANDLERS: Record<KeyAction, () => void> = {
  palette: () => openCommandPalette(commandEntries()),
  undo: undoDocument,
  redo: redoDocument,
  copy: () => copyFromDoc(false),
  copyMerged: () => copyFromDoc(true),
  cut: () => cutFromDoc(),
  paste: () => pasteClip(),
  deselect: () => deselect(),
  transform: () => enterTransform(),
  mergeDown: () => mergeDown(),
  exportAs: () => runTop("Export As…"),
  selectAll: () => selectAll(),
  invertSelection: () => invertSelection(),
  autoTone: () => openAdjustPalette("autoTone"),
  duplicateLayer: () => duplicateActiveLayer(),
  newLayer: () => addNewLayer(),
  newDocument: () => newDocumentDialog(newDocDeps),
  openProject: () => runTop("Open Project…"),
  openImage: () => runTop("Open Image…"),
  save: () => runTop("Save Project"),
  saveAs: () => runTop("Save Project As…"),
  closeTab: () => closeActiveTab(),
  fitOnScreen: () => fit(),
  actualPixels: () => actualPixels(),
  zoomIn: () => zoomBy(1.25),
  zoomOut: () => zoomBy(1 / 1.25),
};

// ---- dockable panels ------------------------------------------------------
// Runs last on purpose: every card (layers, history, adjustments, filters,
// colour, tonal, histogram) already exists by now, and docking is applied to the
// set rather than to each card as it is created.
dockifyPanels(panels, relayout);
