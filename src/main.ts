/**
 * main.ts — walking-skeleton UI: viewport + brush + layers panel.
 * Real panel/tool architecture lands with the full UI pass.
 */

import { Document, bakeLayerMask, cloneLayerMeta, fillMaskFromSelection, maskAt, mergeLayerInto, paintMaskDab, setMaskAt, type Layer, type TextLayerMeta, type TextSeg } from "./engine/document.ts";
import { adjustLabel, defaultAdjustSpec, type AdjustKind, type AdjustSpec } from "./engine/adjustfn.ts";
import { resizeDocument, canvasResizeDocument, cropDocument } from "./engine/resize.ts";
import { stampDab, dabPositions, type TipImage } from "./engine/paint.ts";
import { History, StrokeSession, propertyCommand, layerAddCommand, textOpCommand, layerRemoveCommand, layerMoveCommand, layerOpCommand, layerOpCommandIn, captureTiles, snapshotCommand, type HistoryEntry, type TileImages } from "./engine/history.ts";
import { TileGrid, TILE, cropRGBAAt } from "./engine/tile.ts";
import { LAYER_BLEND_MODES, type BlendMode } from "./engine/blend.ts";
import { serializeProject, deserializeProject } from "./engine/io.ts";
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
import * as f2 from "./engine/filters2.ts";
import type { F2Rect } from "./engine/filters2.ts";
import { checkPsdHeader, psdToDocument, type PsdLike } from "./engine/psd.ts";
import { fillGradient, type GradColor } from "./engine/gradient.ts";
import { SelectionMask, clearMasked, type PixelMask } from "./engine/mask.ts";
import {
  borderSelection,
  contractSelection,
  expandSelection,
  featherSelection,
  growSelection,
  similarSelection,
  smoothSelection,
} from "./engine/selectops.ts";
import { refineSelection } from "./engine/refine.ts";
import { transformLayer, gridBBox } from "./engine/transform.ts";
import { snapshotGrid, applyLayerMove, type GridSnapshot } from "./engine/move.ts";
import { floodFill, magicWand, sampleGrid, type RGBA } from "./engine/flood.ts";
import { dodgeBurnDab, spongeDab, focusDab, smudgeDab, cloneDab, redEyeDab, sampleColor } from "./engine/retouch.ts";
import { fillPlane } from "./engine/plane.ts";
import { contentAwareFill, spotHeal } from "./engine/heal.ts";
import { MAX_DIM, MAX_IMPORT_BYTES } from "./engine/docmeta.ts";
import { penHandleFor, flattenPath, type PathAnchor } from "./engine/path.ts";
import {
  CURVE_CHANNELS, buildBlackWhiteForm, buildExposureForm, buildFields,
  buildPhotoFilterForm, levelsFromFields, LEVELS_FIELDS,
  type CurveChannel,
} from "./ui/adjust-forms.ts";
import { buildTonalPanel } from "./ui/tonal.ts";
import { appMarkSvg, iconSvg, type IconName } from "./ui/icons.ts";
import { ask, askPrompt, modalOpen, notify, showModal, showTextDialog } from "./ui/dialogs.ts";
import { createCloseLoop } from "./ui/closeloop.ts";
import { buildPaletteEntries, openCommandPalette } from "./ui/palette.ts";
import { applyHistoryChangeVia, renderHistoryPanelInto, type HistoryChangeDeps, type HistoryPanelDeps } from "./ui/historypanel.ts";
import { closeMenus, hideContextMenu, menusOpen, mountMenuBar, refreshMenuBar, showContextMenu, type MenuItem } from "./ui/popup.ts";
import { proxyKey } from "./ui/proxykey.ts";
import { mountWindowChrome } from "./ui/windowchrome.ts";
import { LICENCE_TEXT } from "./ui/licence.ts";
import { activeIndex, activeTabName, activeTabView, anyTabDirty, captureTab, closeActiveTab, closeTab, mountTabs, renderTabs, replaceDocument, seedBootTab, setDocInTab, setLastTabDpi, tabsView } from "./ui/tabs.ts";

// Z1: seed HTML is a trust boundary (a project file supplies the strings), so
// the builder lives in a pure, tested module instead of inline in this file.
import { buildSeedHtml } from "./ui/textseed.ts";
import { keyAction, shortcutAllowed, type KeyAction } from "./ui/keymap.ts";
import { SHORTCUTS } from "./ui/shortcuts.ts";
import { createPreviewScheduler } from "./ui/previewqueue.ts";
import { dockifyPanels, resetDock, togglePanels } from "./ui/dock.ts";
import { NOTICES_TEXT } from "./ui/notices.ts";
import { openExportDialog, type ExportRequest } from "./ui/exportdlg.ts";
import { buildLayersPanel } from "./ui/layerspanel.ts";
import { buildPsd } from "./engine/psdexport.ts";
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
let quickMaskCanvas: HTMLCanvasElement | null = null;
/** overlay geometry while a shape selection is live or being dragged */
let selGeom: { kind: "ellipse"; x: number; y: number; w: number; h: number }
  | { kind: "poly"; pts: Array<[number, number]> } | null = null;
let marqueeing = false;
let ellipseDrag = false;
let ellipseStart: [number, number] = [0, 0];
/** Shift held when the drag started: constrain to a circle */
let ellipseSquare = false;
let lassoing = false;
let lassoPts: Array<[number, number]> = [];
/** pen tool: clicked anchors + the cursor preview point */
let penAnchors: PathAnchor[] = [];
// Drag-to-curve: index of the anchor whose handle the pointer is dragging.
let penDragIdx = -1;
let penCursor: [number, number] | null = null;
let marqueeStart: [number, number] = [0, 0];
// Photoshop parity: the marquee family also offers a one-pixel row/column strip.
let marqueeShape: "rect" | "row" | "col" = "rect";
/** Shift held when the drag started: constrain to a square */
let marqueeSquare = false;
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

const BRUSH_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["brush", "eraser", "retouch", "clone", "focus", "heal"]);

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
  octx.clearRect(0, 0, overlay.width, overlay.height);
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
    const spec: ShapeSpec = { kind: shapeKind, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, sides: shapeSides, strokeWidth: shapeStrokeW };
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
    octx.fillRect(0, 0, overlay.width, overlay.height);
    octx.beginPath();
    octx.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < 4; i++) octx.lineTo(pts[i]![0], pts[i]![1]);
    octx.closePath();
    octx.save();
    octx.clip();
    octx.clearRect(0, 0, overlay.width, overlay.height); // "cut out" the kept area
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
    octx.fillRect(0, 0, overlay.width, y);
    octx.fillRect(0, y + h, overlay.width, overlay.height - (y + h));
    octx.fillRect(0, y, x, h);
    octx.fillRect(x + w, y, overlay.width - (x + w), h);
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

function clearSelection(): void {
  if (selMask) {
    const m = selMask;
    const entry = layerOpCommand(activeLayer, "Clear (selection)", () => {
      clearMasked(activeLayer.grid, m);
    });
    if (!entry) return;
    pushHist(entry);
    flatDirty = true;
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
  flatDirty = true;
  render();
  renderHistoryPanel();
}

// ---- document ------------------------------------------------------------
let doc = new Document(1024, 768);
doc.addBackground("Background");
const paintLayer = doc.addLayer("Layer 1");
let activeLayer = paintLayer;
let history = new History(100);

// every content change flows through the history stack — hooking it gives us
// a reliable "document is worth autosaving" signal.
let autosaveDirty = true;
/** true when the tab has edits that have never been written to a file on disk */
let docDirty = false;
function pushHist(entry: HistoryEntry | null): void {
  if (!entry) return;
  quickPx = null; // pixels changed: the quick-select snapshot is stale
  history.push(entry);
  autosaveDirty = true;
  if (!docDirty) {
    docDirty = true;
    renderTabs();
  }
}

/** Undo/redo also change the document, so the marker has to follow them. */
function markDirty(): void {
  if (docDirty) return;
  docDirty = true;
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

function resizeBuffers(): void {
  display.width = Math.max(1, host.clientWidth);
  display.height = Math.max(1, host.clientHeight);
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
  const cx = (display.width / 2 - panX) / scale;
  const cy = (display.height / 2 - panY) / scale;
  resizeBuffers();
  panX = display.width / 2 - cx * scale;
  panY = display.height / 2 - cy * scale;
  render();
  drawOverlay();
}

function fit(): void {
  const pad = 40;
  // a host narrower than the padding used to yield a negative scale, which
  // inverted the blit instead of showing a thumbnail
  scale = Math.max(0.01, Math.min(
    (display.width - pad) / doc.width,
    (display.height - pad) / doc.height,
  ));
  panX = (display.width - doc.width * scale) / 2;
  panY = (display.height - doc.height * scale) / 2;
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
let flat = new Uint8ClampedArray(doc.width * doc.height * 4);
const off = document.createElement("canvas");
off.width = doc.width; off.height = doc.height;
const offCtx = off.getContext("2d")!;
let flatDirty = true;

function renderFlat(): void {
  if (!flatDirty) return;
  doc.composite(flat);
  // ImageData(flat) wraps the same buffer (no copy); putImageData consumes it synchronously
  offCtx.putImageData(new ImageData(flat, doc.width, doc.height), 0, 0);
  flatDirty = false;
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

function render(): void {
  renderFlat();
  restyleTextEditor(); // keep the live text box glued to the canvas while panning/zooming
  ctx.save();
  ctx.fillStyle = "#151515";
  ctx.fillRect(0, 0, display.width, display.height);
  ctx.setTransform(scale, 0, 0, scale, panX, panY);
  // checkerboard + document
  ctx.fillStyle = makeChecker();
  ctx.fillRect(0, 0, doc.width, doc.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0);
  if (previewRect && previewCanvas) {
    const pr = previewRect;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(previewCanvas, pr.x, pr.y, pr.w, pr.h);
  }
  ctx.restore();
  drawOverlay(); // keep marching ants glued to pan/zoom
  updateStatus();
}

function compositeRegion(x: number, y: number, w: number, h: number): void {
  // update the flat cache for a dirty rect then re-render.
  // Splices the small rect straight into `flat` (no scratch copy) and pushes
  // only that rect to the offscreen canvas via putImageData's dirty-rect form.
  if (w <= 0 || h <= 0) return;
  const tmp = new Uint8ClampedArray(w * h * 4);
  doc.compositeRect(x, y, w, h, tmp);
  for (let yy = 0; yy < h; yy++) {
    const srcRow = yy * w * 4;
    const dstRow = ((y + yy) * doc.width + x) * 4;
    flat.set(tmp.subarray(srcRow, srcRow + w * 4), dstRow);
  }
  offCtx.putImageData(new ImageData(flat, doc.width, doc.height), 0, 0, x, y, w, h);
  render();
}

// ---- painting ------------------------------------------------------------
let painting = false;
let strokeSession: StrokeSession | null = null;
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
let smudgePrev: [number, number] | null = null;
let bgColor: [number, number, number] = [255, 255, 255];
let brushHardness = 0.8;
let brushOpacity = 1;
let brushFlow = 1;      // per-dab alpha multiplier — low flow = gradual build-up
let brushSmooth = 0;     // pulled-string smoothing, 0..90
let lastPressure = 1;
let rawCursor: [number, number] | null = null; // unsmoothed cursor (stroke catch-up)
// Quick Selection samples the active layer's pixels; a whole-layer copy costs
// `w*h*4` bytes, so it is taken once per drag and invalidated by pushHist().
let quickPx: Uint8ClampedArray | null = null;

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
let customTip: TipImage | null = null;
const loadedFonts: string[] = [];

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
  const bmp = await createImageBitmap(file);
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
let brushScatter = 0; // % of brush diameter; dabs jitter within this radius
// Spot Healing paints a hole mask; the pixels are rebuilt when the stroke ends
let healMask: SelectionMask | null = null;
let healRect: { x: number; y: number; w: number; h: number } | null = null;
import { TOOL_LABELS, toolTitle, type ToolId } from "./ui/toollabels.ts";

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
  pen: "Pen (P) — click to drop a corner anchor, drag from it to curve the path; Enter or double-click closes into a selection, Backspace removes the last anchor, Esc cancels.",
  gradient: "Gradient (G) — drag to fill the selection (or layer) with the foreground→background gradient.",
  text: "Text (T) — click for a text box; click existing text to re-edit it; drag the box to move it; Shift+Enter for a new line; select text then B/I/U/S or a font to style just that part; Enter commits, Escape cancels.",
  move: "Move (V) — drag to move the active layer. Arrow keys nudge by 1 px, Shift+arrows by 10 px.",
  crop: "Crop (C) — drag a crop box, then Enter to apply or Escape to cancel.",
  wand: "Magic Wand (W) — click to select similar pixels. Shift-click adds to the selection, Alt-click subtracts.",
  bucket: "Paint Bucket (G) — click to flood-fill an area with the foreground colour.",
  quick: "Quick Selection (Shift+W) — paint over similar pixels to grow the selection.",
  shape: "Shape (U) — drag to draw; Alt-drag turns the shape into a selection.",
  eyedropper: "Eyedropper (I) — click to sample a colour from the image into the foreground.",
  retouch: "Retouch (O) — dodge, burn or sponge the pixels under the brush; Alt-click cycles the mode.",
  clone: "Clone Stamp (S) — Alt-click to set the source, then paint to clone from it.",
  focus: "Focus (R) — blur, sharpen or smudge along the stroke; Alt-click cycles the mode.",
  heal: "Spot Healing (J) — paint over a blemish; the area is rebuilt from its surroundings.",
};

let tool: ToolId = "brush";
// Magic Wand / Paint Bucket share the same Photoshop-style tolerance model
let wandTolerance = 32;
let quickTolerance = 40;
let shapeKind: ShapeKind = "rectangle";
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
interface SegStyle { bold: boolean; italic: boolean; underline: boolean; strike: boolean; font: string; }

/** is the current DOM selection a non-collapsed range inside the live text box? */
function richSelection(): boolean {
  if (!textEditing) return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return textEditing.el.contains(sel.anchorNode) && textEditing.el.contains(sel.focusNode);
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
  const bb = gridBBox(activeLayer.grid);
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

function cancelTransform(): void {
  if (!transform) return;
  transform = null;
  refreshOptions();
  drawOverlay();
}

function applyTransform(): void {
  if (!transform) return;
  const t = transform;
  transform = null;
  if (doc.layers.includes(activeLayer)) {
    const entry = layerOpCommand(activeLayer, `Transform ${Math.round((t.angle * 180) / Math.PI)}°`, () => {
      transformLayer(activeLayer, { angleDeg: (t.angle * 180) / Math.PI, scaleX: t.scaleX, scaleY: t.scaleY, dx: t.dx, dy: t.dy });
    });
    if (entry) pushHist(entry);
    flatDirty = true;
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
  octx.clearRect(0, 0, overlay.width, overlay.height);
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
  el.addEventListener("blur", () => {
    if (textEditing && textEditing.el === el) commitText();
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
  flatDirty = true;
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
  flatDirty = true;
  render();
  drawOverlay();
}

function finishTextResize(): void {
  const d = textResize;
  textResize = null;
  if (!d) return;
  const layer = d.layer;
  if (!doc.layers.includes(layer)) return; // tab switched under us
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
    undo: () => { pxEntry.undo(); layer.textData = cloneTextMeta(beforeMeta); },
    redo: () => { pxEntry.redo(); layer.textData = cloneTextMeta(afterMeta); },
  };
  pushHist(entry);
  flatDirty = true;
  render();
  renderLayers();
  renderHistoryPanel();
}

/** the selected text box: 1px dashed frame + 8 white handles, no fill */
function drawTextBoxOverlay(): void {
  if (textEditing || transform || !textSel) return;
  if (!doc.layers.includes(textSel)) { textSel = null; return; }
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
interface TextPart { text: string; font: string; width: number; underline: boolean; strike: boolean; }
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
function layoutTextRich(lines: TextSeg[][], size: number, wrap?: number): TextRow[] {
  const mc = document.createElement("canvas");
  const mctx = mc.getContext("2d")!;
  const measure = (t: { text: string; seg: TextSeg }): TextPart => {
    const seg = t.seg;
    const font = `${seg.italic ? "italic " : ""}${seg.bold ? "bold " : ""}${size}px ${seg.font}`;
    mctx.font = font;
    const m = mctx.measureText(t.text);
    return { text: t.text, font, width: m.width, underline: seg.underline, strike: seg.strike };
  };
  const rows: TextRow[] = [];
  for (const segs of lines) {
    let ascent = 0, descent = 0;
    for (const s of segs) {
      mctx.font = `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}${size}px ${s.font}`;
      const m = mctx.measureText(s.text || "Hg");
      ascent = Math.max(ascent, m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : size * 0.9);
      descent = Math.max(descent, m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : size * 0.3);
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
  const rows = layoutTextRich(lines, size, wrap);
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
    if (target && doc.layers.includes(target) && target.textData) {
      const meta = target.textData;
      const entry = textOpCommand(target, "Clear text", () => {
        target.grid.fillRect(meta.x, meta.y, meta.w, meta.h, [0, 0, 0, 0]);
        target.textData = undefined;
      });
      if (entry) pushHist(entry);
      flatDirty = true;
      render();
      renderLayers();
      renderHistoryPanel();
    }
    return;
  }
  if (target && doc.layers.includes(target)) {
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
    flatDirty = true;
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
  pushHist(layerAddCommand(doc, layer, doc.layers.length - 1));
  flatDirty = true;
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
  m.dx = dx;
  m.dy = dy;
  applyLayerMove(m.layer.grid, m.snap, dx, dy, m.mask);
  if (m.text0 && m.layer.textData) {
    m.layer.textData.x = m.text0.x + dx;
    m.layer.textData.y = m.text0.y + dy;
  }
  // compositeRegion() splices these pixels into `flat` itself; setting flatDirty
  // here would make renderFlat() recompose the whole document a second time.
  scheduleComposite(0, 0, doc.width, doc.height);
}

function endMoveDrag(): void {
  const m = moveDrag;
  moveDrag = null;
  if (!m) return;
  if (m.dx === 0 && m.dy === 0) return; // a click, not a drag
  const pixels = snapshotCommand(m.layer.grid, "Move", m.before);
  const text0 = m.text0;
  const layer = m.layer;
  const text1 = layer.textData ? { ...layer.textData } : null;
  if (pixels) {
    // text layers move their metadata with them, so undo must restore both
    if (text0 || text1) {
      pushHist({
        label: "Move",
        undo: () => {
          pixels.undo();
          if (text0 && layer.textData) {
            layer.textData.x = text0.x;
            layer.textData.y = text0.y;
          }
        },
        redo: () => {
          pixels.redo();
          if (text1 && layer.textData) Object.assign(layer.textData, text1);
        },
      });
    } else {
      pushHist(pixels);
    }
  }
  flatDirty = true;
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
  applyLayerMove(layer.grid, snapshotGrid(layer.grid), dx, dy, selMask);
  if (layer.textData) {
    layer.textData.x += dx;
    layer.textData.y += dy;
  }
  const entry = snapshotCommand(layer.grid, "Nudge", before);
  if (entry) pushHist(entry);
  flatDirty = true;
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
  drawOverlay();
  refreshOptions();
}

function applyPerspectiveNow(): void {
  if (!cropQuad) return;
  const size = quadSize(cropQuad);
  const quad = cropQuad;
  cropQuad = null;
  quadDragIdx = -1;
  try {
    const next = perspectiveCrop(doc, quad, size.w, size.h);
    setDocInTab(next.doc, "Perspective Crop");
    statusHint(`Perspective crop to ${size.w} × ${size.h}`);
  } catch (err) {
    statusHint(err instanceof Error ? err.message : "Perspective crop failed");
    refreshOptions();
    drawOverlay();
    return;
  }
  refreshOptions();
  drawOverlay();
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
  if (tool === "marquee" || tool === "ellipse" || tool === "lasso") {
    // starting a fresh selection invalidates the old one of ANY shape
    selRect = null;
    selMask = null;
    selGeom = null;
    if (tool === "marquee") {
      marqueeing = true;
      marqueeStart = [x, y];
      marqueeSquare = e.shiftKey;
    } else if (tool === "ellipse") {
      ellipseDrag = true;
      ellipseStart = [x, y];
      ellipseSquare = e.shiftKey;
    } else {
      lassoing = true;
      lassoPts = [[x, y]];
    }
    drawOverlay();
    return;
  }
  if (tool === "shape") { shapeDrag = { x0: x, y0: y, x1: x, y1: y, toSelection: e.altKey }; return; }
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
  if (tool === "quick") { quickDab(x, y, e.altKey ? "subtract" : "add"); return; }
  if (tool === "wand") {
    pickWand(x, y, e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");
    return;
  }
  if (tool === "eyedropper") { pickColor(x, y); return; }
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
  if (tool === "gradient") {
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
  painting = true;
  strokeSession = new StrokeSession();
  if (paintTarget === "mask" && activeLayer.mask) maskStrokeBefore = captureTiles(activeLayer.mask);
  else maskStrokeBefore = null;
  lastX = x; lastY = y;
  rawCursor = [x, y];
  smudgePrev = [x, y];
  paintDabs(x, y, e.pressure, tiltOf(e));
});

display.addEventListener("pointermove", (e) => {
  const hb = host.getBoundingClientRect();
  hoverPos = [e.clientX - hb.left, e.clientY - hb.top];
  // a lost pointerup (alt-tab, capture revoked) must never leave a stroke open:
  // the next hover would otherwise keep painting with no button held
  if (painting && e.buttons === 0) endStroke();
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
    selRect = (marqueeSquare || e.shiftKey) ? squareRect(marqueeStart, [x, y]) : rectFrom(marqueeStart, [x, y]);
    drawOverlay();
    return;
  }
  if (ellipseDrag) {
    const [x, y] = screenToDoc(e);
    selGeom = { kind: "ellipse", ...((ellipseSquare || e.shiftKey) ? squareRect(ellipseStart, [x, y]) : rectFrom(ellipseStart, [x, y])) };
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
  if (lassoing) {
    const [x, y] = screenToDoc(e);
    lassoPts.push([x, y]);
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
  endStroke();
  endPan();
});
display.addEventListener("pointercancel", () => {
  endStroke();
  endPan();
});
display.addEventListener("pointerleave", () => { if (panning) endPan(); });
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
function commitShape(): void {
  if (!shapeDrag) return;
  const { x0, y0, x1, y1, toSelection } = shapeDrag;
  shapeDrag = null;
  if (Math.abs(x1 - x0) < 2 && Math.abs(y1 - y0) < 2) { drawOverlay(); return; }
  const kind = shapeKind;
  if (toSelection) {
    // Alt-drag: the shape becomes a selection instead of pixels
    const next = new SelectionMask(doc.width, doc.height);
    // SelectionMask already implements the sink contract, so it receives the shape directly
    shapeSelection(doc.width, doc.height, { kind, x0, y0, x1, y1, sides: shapeSides, strokeWidth: shapeStrokeW }, next);
    if (!next.isEmpty) {
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
  flatDirty = true;
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
  flatDirty = true;
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
    const before = snapshotSelection();
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
    if (selRect) {
      // materialise the mask now: every consumer (move, bucket, masks, filters)
      // reads selMask, so a rect-only selection would silently be ignored there
      const m = new SelectionMask(doc.width, doc.height);
      m.selectRect(selRect.x, selRect.y, selRect.w, selRect.h);
      selMask = m;
      startAnts();
    } else {
      selMask = null;
      stopAnts();
    }
    drawOverlay();
    refreshOptions();
    pushHist(selectionCommand(selRect ? "Marquee select" : "Deselect", before));
    return;
  }
  if (ellipseDrag) {
    ellipseDrag = false;
    const beforeEllipse = snapshotSelection();
    const r = selGeom && selGeom.kind === "ellipse" ? selGeom : null;
    if (!r || r.w < 2 || r.h < 2) { deselect(); return; } // click = deselect
    const m = new SelectionMask(doc.width, doc.height);
    m.selectEllipse(r.x, r.y, r.w, r.h);
    selMask = m;
    startAnts();
    drawOverlay();
    pushHist(selectionCommand("Elliptical select", beforeEllipse));
    return;
  }
  if (lassoing) {
    lassoing = false;
    const beforeLasso = snapshotSelection();
    if (lassoPts.length < 3) { deselect(); return; } // click = deselect
    const m = new SelectionMask(doc.width, doc.height);
    m.selectPolygon(lassoPts);
    selMask = m;
    selGeom = { kind: "poly", pts: lassoPts.slice() };
    startAnts();
    drawOverlay();
    pushHist(selectionCommand("Lasso select", beforeLasso));
    return;
  }
  if (gradientDrag) {
    gradientDrag = false;
    drawOverlay();
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
    flatDirty = true;
    render();
    renderHistoryPanel();
    return;
  }
  if (!painting) return;
  painting = false;
  // smoothed strokes lag behind the cursor — finish the rope on release. This has
  // to happen BEFORE the mask snapshot below, or the final dab is missing from
  // the captured after-image and undoing/redoing a mask stroke loses it.
  if (brushSmooth > 0 && rawCursor) paintDabs(rawCursor[0], rawCursor[1], lastPressure);
  rawCursor = null;
  if (maskStrokeBefore && activeLayer.mask) {
    pushHist(snapshotCommand(activeLayer.mask, "Paint Mask", maskStrokeBefore));
    maskStrokeBefore = null;
    renderHistoryPanel();
  }
  if (strokeSession) {
    const STROKE_LABEL: Partial<Record<ToolId, string>> = {
      retouch: retouchMode === "dodge" ? "Dodge" : retouchMode === "burn" ? "Burn"
        : retouchMode === "sponge" ? (spongeMode === "saturate" ? "Saturate" : "Desaturate") : "Red Eye",
      focus: focusMode === "blur" ? "Blur" : focusMode === "sharpen" ? "Sharpen" : "Smudge",
      clone: "Clone Stamp",
    };
    const entry = strokeSession.finish(activeLayer.grid,
      tool === "eraser" ? "Erase" : STROKE_LABEL[tool] ?? "Paint");
    strokeSession = null;
    if (entry) {
      pushHist(entry);
      renderHistoryPanel();
    }
  }
}


/** Dispatch one dab to the right engine op for the active tool. */
function paintOneDab(x: number, y: number, radius: number,
  tilt?: { angle: number; ratio: number }): { x: number; y: number; w: number; h: number } | null {
  // Quick Mask: the brush edits the selection itself, not any layer
  if (quickMask) {
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
    return paintMaskDab(activeLayer.mask, {
      x, y, radius, hardness: brushHardness, alpha: brushOpacity,
      value: mlum < 128 ? 0 : 255, // dark brush hides, light brush reveals
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
        const a = soft >= 1 ? 255 : Math.round(255 * (d <= soft ? 1 : 1 - (d - soft) / Math.max(0.001, 1 - soft)));
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
    default:
      return stampDab(grid, {
        x, y, radius,
        hardness: brushHardness,
        alpha: brushOpacity * brushFlow,
        color,
        mode: tool === "eraser" ? "clear" : "normal",
        clip: selRect ?? undefined,
        mask: selMask ?? undefined,
        stretch: tilt && !activeTip ? tilt : undefined,
        tip: activeTip ?? undefined,
      }, strokeSession ?? undefined);
  }
}

function paintDabs(x: number, y: number, pressure: number, tilt?: { angle: number; ratio: number }): void {
  const p = pressure > 0 && pressure !== 0.5 ? pressure : 1;
  lastPressure = p;
  const radius = Math.max(1, (brushSize / 2) * (0.35 + 0.65 * p));
  const spacing = Math.max(1, radius * 0.25);
  const dabs = dabPositions(lastX, lastY, x, y, spacing);
  // the cursor must advance per call: coalesced sub-events each continue from
  // where the previous one ended, or a fast burst re-stamps the same segment
  // over and over (quadratic work — the size-300 eraser hang)
  lastX = x; lastY = y;
  if (dabs.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [dxp, dyp] of dabs) {
    let sx = dxp, sy = dyp;
    if (brushScatter > 0 && (tool === "brush" || tool === "eraser")) {
      const amp = (brushScatter / 100) * brushSize;
      sx += (Math.random() * 2 - 1) * amp;
      sy += (Math.random() * 2 - 1) * amp;
    }
    const rect = paintOneDab(sx, sy, radius, tilt);
    if (rect) {
      minX = Math.min(minX, rect.x); minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.w); maxY = Math.max(maxY, rect.y + rect.h);
    }
  }
  if (maxX > minX && maxY > minY) {
    scheduleComposite(minX, minY, maxX - minX, maxY - minY);
  }
}

// ---- frame-coalesced stroke rendering -------------------------------------
// pointermove (with coalesced events) can fire far above display refresh;
// batching dirty rects to one composite+render per rAF keeps strokes smooth.
let pendingDirty: { x: number; y: number; w: number; h: number } | null = null;
let rafScheduled = false;
function scheduleComposite(x: number, y: number, w: number, h: number): void {
  if (pendingDirty) {
    const x1 = Math.min(pendingDirty.x, x), y1 = Math.min(pendingDirty.y, y);
    const x2 = Math.max(pendingDirty.x + pendingDirty.w, x + w);
    const y2 = Math.max(pendingDirty.y + pendingDirty.h, y + h);
    pendingDirty = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  } else {
    pendingDirty = { x, y, w, h };
  }
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    const d = pendingDirty;
    pendingDirty = null;
    if (d) compositeRegion(d.x, d.y, d.w, d.h);
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
const APP_VERSION = "0.69.0";
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
panels.appendChild(layersBox);
panels.appendChild(historyBox);
panels.appendChild(adjustBox);

topbar.innerHTML = `<span id="brand"><span class="mark">${appMarkSvg(19)}</span>Guazzo</span>`;

// ---- status bar (Photoshop-style read-out strip along the bottom) ----------
const statusBar = document.getElementById("statusbar")!;
let hintTimer: number | null = null;
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
  dirty: HTMLElement; hint: HTMLElement;
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
  const spacer = mk("grow-spacer");
  const offline = mk(); offline.textContent = "100% offline — no network access";
  const hint = mk("status-hint"); hint.style.display = "none";
  bar.append(zoom, size, cursor, sel, layer, hist, dirty, spacer, offline, hint);
  sb = {
    zoom: zoomB, size, cursor, cursorX, cursorY, sel, selB,
    layerNo, layerOf, histPos, histTotal, dirty, hint,
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
  const idx = doc.layers.indexOf(activeLayer);
  s.layerNo.textContent = String(idx < 0 ? 0 : doc.layers.length - idx);
  s.layerOf.textContent = ` of ${doc.layers.length}`;
  s.histPos.textContent = String(history.position);
  s.histTotal.textContent = `/${history.labels.length}`;
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

// document tabs live in ./ui/tabs.ts — the shell keeps the live globals and
// mounts the strip; a tab switch swaps those globals through read()/write().
const tabsBar = document.getElementById("tabs")!;
mountTabs(tabsBar, {
  read: () => ({ doc, activeLayer, history, flat, flatDirty, selRect, selMask, selGeom, scale, panX, panY, autosaveDirty, dirty: docDirty }),
  write: (s) => {
    doc = s.doc; activeLayer = s.activeLayer; history = s.history;
    flat = s.flat; flatDirty = s.flatDirty;
    selRect = s.selRect; selMask = s.selMask; selGeom = s.selGeom;
    scale = s.scale; panX = s.panX; panY = s.panY;
    autosaveDirty = s.autosaveDirty; docDirty = s.dirty;
    off.width = s.doc.width; off.height = s.doc.height;
  },
  patch: (p) => {
    if (p.doc) { doc = p.doc; off.width = p.doc.width; off.height = p.doc.height; }
    if (p.activeLayer) activeLayer = p.activeLayer;
    if (p.history) history = p.history;
    if (p.flat) flat = p.flat;
    if (p.flatDirty !== undefined) flatDirty = p.flatDirty;
    if ("selRect" in p) selRect = p.selRect ?? null;
    if ("selMask" in p) selMask = p.selMask ?? null;
    if ("selGeom" in p) selGeom = p.selGeom ?? null;
    if (p.scale !== undefined) scale = p.scale;
    if (p.panX !== undefined) panX = p.panX;
    if (p.panY !== undefined) panY = p.panY;
    if (p.autosaveDirty !== undefined) autosaveDirty = p.autosaveDirty;
    if (p.dirty !== undefined) docDirty = p.dirty;
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
  renderAll: () => { render(); renderLayers(); renderHistoryPanel(); },
  drawOverlay,
  pushHist,
  iconSvg: (name, size) => iconSvg(name as Parameters<typeof iconSvg>[0], size),
  showContextMenu,
  saveProject: (asCopy) => { void saveProject(asCopy); },
  quickExportPng: () => quickExportPng(),
  runTop,
  fit,
  hideRecoveryBar,
  ask: (title, body, ok) => ask(title, body, ok),
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
  replaceDocument: (d, layer, name) => replaceDocument(d, layer, name),
  setActiveTabDpi: setLastTabDpi,
  renderTabs,
};

/** Open a real Photoshop file via the vendored ag-psd UMD bundle
 *  (loaded as a classic script in index.html → globalThis.agPsd). */
async function openPsdFile(file: File): Promise<void> {
  const ag = (globalThis as { agPsd?: { readPsd: (buf: ArrayBuffer, options?: { useImageData?: boolean }) => PsdLike } }).agPsd;
  if (!ag) {
    notify("PSD import unavailable", "The PSD support library (ag-psd) is not loaded.");
    return;
  }
  // AG3: the header is 26 bytes and says how much memory the parse will want.
  try {
    checkPsdHeader(new Uint8Array(await file.slice(0, 26).arrayBuffer()));
  } catch (err) {
    notify(`Could not open ${file.name}`, err instanceof Error ? err.message : String(err));
    statusHint("PSD import failed — the file was not changed");
    return;
  }
  let psd: PsdLike;
  try {
    psd = ag.readPsd(await file.arrayBuffer(), { useImageData: true });
    replaceDocument(psdToDocument(psd), undefined, file.name.replace(/\.[^.]+$/, "") || "PSD");
  } catch (err) {
    notify(`Could not open ${file.name}`, err instanceof Error ? err.message : String(err));
    statusHint("PSD import failed — the file was not changed");
  }
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
      const json = JSON.parse(await file.text());
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
    if (/\.tiff?$/i.test(file.name)) {
      // Browsers cannot decode TIFF, so this goes through our own reader; an
      // unsupported variant must refuse rather than paint a wrong image.
      const img = decodeTiff(new Uint8Array(await file.arrayBuffer()));
      const nd = new Document(img.width, img.height);
      const layer = nd.addLayer(file.name.replace(/\.[^.]+$/, "") || "Image");
      layer.grid.writeRect(0, 0, img.width, img.height, img.data);
      replaceDocument(nd, layer, file.name.replace(/\.[^.]+$/, "") || "Image");
      statusHint(`Opened ${file.name} (${img.width} × ${img.height})`);
      return;
    }
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const cc = c.getContext("2d", { willReadFrequently: true })!;
    cc.drawImage(bmp, 0, 0);
    const rgba = cc.getImageData(0, 0, c.width, c.height).data;
    const nd = new Document(c.width, c.height);
    const layer = nd.addLayer(file.name.replace(/\.[^.]+$/, "") || "Image");
    layer.grid.writeRect(0, 0, c.width, c.height, rgba);
    replaceDocument(nd, layer, file.name.replace(/\.[^.]+$/, "") || "Image");
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
  void (async () => {
    for (const f of take) await openAnyFile(f);
  })();
});

/**
 * AG1: `inPlace` is Ctrl+S — overwrite the file THIS document last saved, no
 * dialog. The dirty flags clear only after the write succeeded, so cancelling
 * the dialog (or a failed write) leaves the document marked as unsaved.
 */
async function saveProject(inPlace = false): Promise<void> {
  const tab = activeTabView();
  const tname = tab?.name ?? "untitled";
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
  docDirty = false;
  if (tab) tab.dirty = false;
  renderTabs();
  updateStatus();
}

topButton("file", "Save Project", () => { void saveProject(true); });
topButton("file", "Save Project As…", () => { void saveProject(false); }, "save");
topButton("file", "Export As…", () => exportAs(), "download");

/** Export As…: PNG / JPEG / WebP / PSD, with quality, scale and a size estimate. */
function exportAs(): void {
  if (transform) return;
  openExportDialog({
    showModal,
    docInfo: () => ({
      width: doc.width,
      height: doc.height,
      hasNonPixelLayers: doc.layers.some((l) => l.kind !== "pixel"),
    }),
    defaultName: () => activeTabView()?.name ?? "untitled",
    onExport: (req) => runExport(req),
  });
}

function runExport(req: ExportRequest): void {
  renderFlat();
  const safe = req.filename.replace(/[\\/:*?"<>|]/g, "_");
  if (req.format === "psd") {
    writePsdBlob(safe);
    return;
  }
  // Scaled export: draw the flattened frame through a canvas so one bit of math
  // handles every format and every scale factor.
  const w = Math.max(1, Math.round(doc.width * req.scale));
  const h = Math.max(1, Math.round(doc.height * req.scale));
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
  const hasNonPixel = doc.layers.some((l) => l.kind !== "pixel");
  const psd = buildPsd(doc);
  if (hasNonPixel) {
    // Adjustment and fill layers have no pixel buffer PSD can carry from us, so a
    // document containing them exports as one flattened composite layer rather
    // than silently losing the adjustment.
    psd.children = [{
      name: activeTabView()?.name ?? "Composite",
      opacity: 1,
      blendMode: "normal",
      hidden: false,
      left: 0,
      top: 0,
      right: doc.width,
      bottom: doc.height,
      imageData: { width: doc.width, height: doc.height, data: doc.composite() },
    }];
  }
  try {
    const buf = ag.writePsd(psd, { generateThumbnail: false });
    void saveBlob(filename, new Blob([buf], { type: "image/vnd.adobe.photoshop" }), "psd");
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
  flatDirty = true;
  render();
  renderLayers();
  renderHistoryPanel();
  renderTabs();
  pulse(filterBox);
}

function rotateDoc(dir: 1 | -1): void {
  if (transform) return;
  const next = dir === 1 ? rotate90(doc, 1) : rotate90(doc, -1);
  applyImageOp(dir === 1 ? "Rotate 90 CW" : "Rotate 90 CCW", next);
}

function rotateDoc180(): void {
  if (transform) return;
  applyImageOp("Rotate 180", rotate180(doc));
}

function flipDoc(axis: "horizontal" | "vertical"): void {
  if (transform) return;
  applyImageOp(axis === "horizontal" ? "Flip Horizontal" : "Flip Vertical", flip(doc, axis));
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
  showModal("Image Size", box, () => {
    const w = Math.min(MAX_DIM, Math.max(1, Math.round(Number(wIn.value) || doc.width)));
    const h = Math.min(MAX_DIM, Math.max(1, Math.round(Number(hIn.value) || doc.height)));
    if (w === doc.width && h === doc.height) return;
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
      b.className = "anchor-cell" + (cx === 1 && cy === 1 ? " active" : "");
      const my = cy, mx = cx;
      b.addEventListener("click", () => {
        ax = mx / 2; ay = my / 2;
        cells.forEach(c => c.classList.remove("active"));
        b.classList.add("active");
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
const penBtn = toolButton("nib", "pen", "", () => { tool = "pen"; highlight(); });
const wandBtn = toolButton("wand", "wand", "click to select similar pixels", () => { tool = "wand"; highlight(); });
const quickBtn = toolButton("quickselect", "quick", "paint to select similar pixels", () => { tool = "quick"; highlight(); });
const shapeBtn = toolButton("frame", "shape", "drag to draw a shape", () => { tool = "shape"; highlight(); });
const cropBtn = toolButton("crop", "crop", "drag, then Enter", () => { tool = "crop"; highlight(); });
toolSeparator();
const brushBtn = toolButton("brush", "brush", "", () => { tool = "brush"; highlight(); });
const eraserBtn = toolButton("eraser", "eraser", "", () => { tool = "eraser"; highlight(); });
const gradientBtn = toolButton("gradient", "gradient", "", () => { tool = "gradient"; highlight(); });
const bucketBtn = toolButton("bucket", "bucket", "click to fill an area", () => { tool = "bucket"; highlight(); });
const healBtn = toolButton("bandage", "heal", "paint over a blemish to rebuild it", () => { tool = "heal"; highlight(); });
toolSeparator();
const eyedropperBtn = toolButton("eyedropper", "eyedropper", "click to sample a colour", () => { tool = "eyedropper"; highlight(); });
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
  brush: brushBtn, eraser: eraserBtn, marquee: marqueeBtn,
  ellipse: ellipseBtn, lasso: lassoBtn, gradient: gradientBtn, text: textBtn,
  move: moveBtn, crop: cropBtn, wand: wandBtn, quick: quickBtn, bucket: bucketBtn,
  shape: shapeBtn,
  heal: healBtn,
  eyedropper: eyedropperBtn, retouch: retouchBtn, clone: cloneBtn, focus: focusBtn,
  pen: penBtn,
};

// right-click on a tool button switches within its family (Photoshop flyouts).
// Labels are static because promoteTitles moves `title` to data-tip at runtime.
// Short names for the right-click family menus. Tool BUTTONS keep richer
// aria-labels (set by toolButton from the hint text) for assistive tech;
// this table is the terse menu-face of the same tools (handoff-3 T6).
const TOOL_FAMILIES: Partial<Record<ToolId, string>> = {
  marquee: "Selection", ellipse: "Selection", lasso: "Selection",
  wand: "Selection", quick: "Selection",
  brush: "Painting", eraser: "Painting",
  gradient: "Painting", bucket: "Painting",
  heal: "Retouching", retouch: "Retouching", clone: "Retouching", focus: "Retouching",
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

function highlight(): void {
  if (transform) { applyTransform(); return; } // tool switch commits, Photoshop-style
  // AD1: sticky view modes are a VIEW state, not a tool; picking a tool must
  // leave them or the next brush stroke pans the canvas instead of painting.
  if (handMode || zoomMode) { handMode = false; zoomMode = false; syncCursor(); }
  if (tool !== "text") commitText(); // leaving the text tool commits any live box
  for (const b of Object.values(TOOL_BTN)) b.classList.remove("active");
  TOOL_BTN[tool].classList.add("active");
  syncCursor();
  refreshOptions();
}
highlight();

// ---- shared foreground color (left toolbar: brush + text use this) ---------
// ---- in-app colour picker (replaces the OS <input type="color"> popup) --
let colorPop: HTMLElement | null = null;
let colorPopBefore: [number, number, number] | null = null;
let colorPopOutside: ((e: PointerEvent) => void) | null = null;
let colorPopKey: ((e: KeyboardEvent) => void) | null = null;
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
  const hueCanvas = document.createElement("canvas");
  hueCanvas.className = "cp-hue";
  hueCanvas.width = SV_W;
  hueCanvas.height = HUE_H;
  hueCanvas.title = "Hue \u2014 drag to pick";
  hueCanvas.tabIndex = 0;
  hueCanvas.setAttribute("role", "slider");
  hueCanvas.setAttribute("aria-label", "Hue \u2014 drag or use the arrow keys");
  const svCtx = svCanvas.getContext("2d");
  const hueCtx = hueCanvas.getContext("2d");
  let curHsv = rgbToHsv(initial);
  const syncMarkers = (c: [number, number, number]): void => {
    curHsv = rgbToHsv(c);
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
  format: (v: number) => string, oninput: (v: number) => void): HTMLDivElement {
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
  const clampV = (v: number): number => Math.max(min, Math.min(max, v));
  range.addEventListener("input", () => {
    const v = Number(range.value);
    num.value = String(Math.round(v * 100) / 100);
    oninput(v);
  });
  num.addEventListener("change", () => {
    const parsed = Number(num.value);
    if (!Number.isFinite(parsed)) { num.value = String(Math.round(Number(range.value) * 100) / 100); return; }
    const v = clampV(parsed);
    num.value = String(Math.round(v * 100) / 100);
    range.value = String(v);
    oninput(v);
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
  optionsPage = 0;
  // the toolbar transform button shows an active state while a transform is live
  transformToolBtn.classList.toggle("active", !!transform);
  // Quick Mask and mask painting recolour the whole bar: the mode matters
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
    case "eyedropper": return buildEyedropperOptions;
    case "retouch": return buildRetouchOptions;
    case "clone": return buildCloneOptions;
    case "focus": return buildFocusOptions;
    case "heal": return buildHealOptions;
    case "crop": return buildCropOptions;
    case "marquee": return buildSelectOptions;
    case "ellipse": return buildSelectOptions;
    case "lasso": return buildSelectOptions;
    case "pen": return buildSelectOptions;
    case "gradient": return buildGradientOptions;
    case "text": return buildTextOptions;
    case "brush": return buildBrushOptions;
    case "eraser": return buildBrushOptions;
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
  for (const k of ["rectangle", "ellipse", "line", "polygon", "star"] as ShapeKind[]) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k.charAt(0).toUpperCase() + k.slice(1);
    if (k === shapeKind) o.selected = true;
    kindSel.appendChild(o);
  }
  kindSel.onchange = () => { shapeKind = kindSel.value as ShapeKind; refreshOptions(); drawOverlay(); };
  optionsBar.appendChild(kindSel);
  if (shapeKind === "polygon" || shapeKind === "star") {
    optionsBar.appendChild(optionSlider("Sides", 3, 24, shapeSides, (v) => String(v), (v) => { shapeSides = v; drawOverlay(); }));
  }
  optionsBar.appendChild(optionColor("Fill", shapeFill ?? [color[0], color[1], color[2]], (v) => { shapeFill = v; drawOverlay(); }));
  optionsBar.appendChild(optionColor("Stroke", shapeStroke ?? [bgColor[0], bgColor[1], bgColor[2]], (v) => { shapeStroke = v; drawOverlay(); }));
  optionsBar.appendChild(optionSlider("Stroke w", 0, 40, shapeStrokeW, (v) => (v === 0 ? "none" : `${v} px`), (v) => { shapeStrokeW = v; drawOverlay(); }));
  const shint = document.createElement("span");
  shint.className = "label";
  shint.textContent = "Drag to draw · Alt-drag makes a selection instead of pixels";
  optionsBar.appendChild(shint);
}

function buildQuickOptions(): void {
  optionsBar.appendChild(optionSlider("Tolerance", 0, 255, quickTolerance, (v) => String(v), (v) => {
    quickTolerance = v;
  }));
  const qhint = document.createElement("span");
  qhint.className = "label";
  qhint.textContent = "Paint to select similar pixels · keep painting to grow the selection";
  optionsBar.appendChild(qhint);
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
  if (tool === "marquee") {
    const shapeSel = document.createElement("select");
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
      selRect = null;
      selMask = null;
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
  hint.textContent =
    marqueeShape === "rect"
      ? "Drag to select · click to deselect · Ctrl+D deselect · Del clears selection"
      : "Click to select a one-pixel strip across the whole canvas · Esc cancels";
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
  const allFonts = [...loadedFonts, "Arial", "Georgia", "Times New Roman", "Courier New", "Verdana", "Trebuchet MS", "Impact", "Comic Sans MS", "Tahoma", "Consolas", "Segoe UI", "Palatino Linotype"];
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
  const toggleBtn = (label: string, active: boolean, css: string, onToggle: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "btn icon" + (active ? " primary" : " subtle");
    b.textContent = label;
    b.style.cssText = `width:26px;height:24px;${css};`;
    // keep the caret/selection in the text box when clicking the button
    b.addEventListener("mousedown", ev => ev.preventDefault());
    b.addEventListener("click", onToggle);
    return b;
  };
  optionsBar.appendChild(toggleBtn("B", textBold, "font-weight:bold", () => {
    if (!applyRich("bold")) textBold = !textBold;
    refreshOptions(); restyleTextEditor();
  }));
  optionsBar.appendChild(toggleBtn("I", textItalic, "font-style:italic", () => {
    if (!applyRich("italic")) textItalic = !textItalic;
    refreshOptions(); restyleTextEditor();
  }));
  optionsBar.appendChild(toggleBtn("U", textUnderline, "text-decoration:underline", () => {
    if (!applyRich("underline")) textUnderline = !textUnderline;
    refreshOptions(); restyleTextEditor();
  }));
  optionsBar.appendChild(toggleBtn("S", textStrike, "text-decoration:line-through", () => {
    if (!applyRich("strikeThrough")) textStrike = !textStrike;
    refreshOptions(); restyleTextEditor();
  }));
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
  optionsBar.appendChild(optionSlider("Size", 8, 200, textSize, v => `${v}px`, v => { textSize = v; restyleTextEditor(); }));
}

function buildBrushOptions(): void {
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
optionsBar.appendChild(optionSlider("Size", 1, 300, brushSize, v => `${v}px`, v => { brushSize = v; }));
optionsBar.appendChild(optionSlider("Hardness", 0, 100, Math.round(brushHardness * 100), v => `${v}%`, v => { brushHardness = v / 100; }));
optionsBar.appendChild(optionSlider("Opacity", 1, 100, Math.round(brushOpacity * 100), v => `${v}%`, v => { brushOpacity = v / 100; }));
optionsBar.appendChild(optionSlider("Flow", 1, 100, Math.round(brushFlow * 100), v => `${v}%`, v => { brushFlow = v / 100; }));
optionsBar.appendChild(optionSlider("Smooth", 0, 90, brushSmooth, v => `${v}%`, v => { brushSmooth = v; }));
optionsBar.appendChild(optionSlider("Scatter", 0, 100, brushScatter, v => `${v}%`, v => { brushScatter = v; }));
}

/**
 * Move the tool's long guidance text into a single "?" button at the end of
 * the options bar. Runs after the tool's own controls are built and before the
 * bar is paged, so the button is always the last item and never gets paged away.
 */
function finalizeOptionsBar(): void {
  // quick-mask / mask-editing modes show a temporary banner instead of tool
  // controls: leave that explanation visible rather than hiding it behind "?"
  if (quickMask || (paintTarget === "mask" && !!activeLayer?.mask)) return;
  const hints: string[] = [];
  for (const kid of Array.from(optionsBar.children)) {
    if (!kid.classList.contains("label")) continue;
    const text = (kid.textContent ?? "").trim();
    if (text) hints.push(text);
    kid.remove();
  }
  const guide = TOOL_GUIDE[tool] ?? "";
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

let helpPanel: HTMLElement | null = null;
function closeHelpPanel(): void {
  if (!helpPanel) return;
  helpPanel.remove();
  helpPanel = null;
  optionsBar.querySelector(".opt-help")?.setAttribute("aria-expanded", "false");
}

/** AD5: the "?" guidance, anchored under the button until dismissed. */
function toggleHelpPanel(anchor: HTMLElement, guide: string, hints: string[]): void {
  if (helpPanel) { closeHelpPanel(); return; }
  const pop = document.createElement("div");
  pop.className = "menu-pop help-pop";
  pop.setAttribute("role", "dialog");
  const head = document.createElement("div");
  head.className = "menu-head";
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
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.right - 300, window.innerWidth - 316))}px`;
  pop.style.top = `${Math.min(window.innerHeight - 40, r.bottom + 6)}px`;
  helpPanel = pop;
  anchor.setAttribute("aria-expanded", "true");
  const onDocDown = (ev: PointerEvent) => {
    if (pop.contains(ev.target as Node) || anchor.contains(ev.target as Node)) return;
    closeHelpPanel();
    document.removeEventListener("pointerdown", onDocDown, true);
  };
  document.addEventListener("pointerdown", onDocDown, true);
}

function refreshOptions(): void {
  buildOptionsBase();
  finalizeOptionsBar();
  fitOptionsPages();
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
  if (tail) {
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
  const pageB = document.createElement("div");
  pageB.className = "opt-page";
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
  const budget = Math.max(0, barW - (tail.offsetWidth || 0) - 10);
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
    pageB.style.display = p === 1 ? "contents" : "none";
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
  if (!layer.mask) doc.attachMask(layer);
  const mask = layer.mask!;
  const before = captureTiles(mask);
  if (selMask) {
    for (let y = 0; y < doc.height; y++) {
      for (let x = 0; x < doc.width; x++) {
        const a = selMask.alphaAt(x, y);
        if (a >= 255) continue;
        setMaskAt(mask, x, y, a);
      }
    }
  }
  pushHist(snapshotCommand(mask, "Add Layer Mask", before));
  paintTarget = "mask";
  flatDirty = true;
  renderLayers(); render(); renderHistoryPanel();
}

/** layer mask → selection (the inverse trip) */
function loadMaskAsSelection(): void {
  const layer = activeLayer;
  if (!layer.mask) return;
  const m = new SelectionMask(doc.width, doc.height);
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      const a = maskAt(layer.mask, x, y);
      if (a > 0) m.setAlpha(x, y, a);
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
  const before = captureTiles(layer.grid);
  const maskBackup = layer.mask;
  bakeLayerMask(layer, doc.width, doc.height);
  const pixelEntry = snapshotCommand(layer.grid, "Apply Layer Mask", before);
  // the bake multiplies pixels AND drops the mask: one entry must restore both,
  // otherwise undo silently loses the mask the user can still see in the panel
  if (pixelEntry) {
    pushHist({
      label: "Apply Layer Mask",
      undo: () => {
        pixelEntry.undo();
        layer.mask = maskBackup;
        flatDirty = true;
      },
      redo: () => {
        layer.mask = undefined;
        pixelEntry.redo();
        flatDirty = true;
      },
    });
  }
  paintTarget = "pixel";
  flatDirty = true;
  renderLayers(); render(); renderHistoryPanel();
}

function deleteLayerMask(): void {
  const layer = activeLayer;
  if (!layer.mask) return;
  const mask = layer.mask;
  layer.mask = undefined;
  pushHist({
    label: "Delete Layer Mask",
    undo: () => { layer.mask = mask; flatDirty = true; },
    redo: () => { layer.mask = undefined; flatDirty = true; },
  });
  paintTarget = "pixel";
  flatDirty = true;
  renderLayers(); render(); renderHistoryPanel();
}

/** the adjustment-layer picker */
function addAdjustmentLayer(): void {
  const rows: Array<[AdjustKind, string]> = [
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
  ];
  const body = document.createElement("div");
  const sel = document.createElement("select");
  for (const [kind, label] of rows) {
    const o = document.createElement("option");
    o.value = kind;
    o.textContent = label;
    sel.appendChild(o);
  }
  const amountRow = document.createElement("div");
  amountRow.className = "field";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.textContent = "Amount";
  const range = document.createElement("input");
  range.type = "range";
  range.min = "-100"; range.max = "100"; range.value = "0";
  range.setAttribute("aria-label", "Amount");
  const val = document.createElement("span");
  val.className = "value";
  val.textContent = "0";
  range.addEventListener("input", () => { val.textContent = range.value; });
  amountRow.append(lab, range, val);
  body.append(sel, amountRow);
  showModal("New Adjustment Layer", body, () => {
    const kind = sel.value as AdjustKind;
    const spec = defaultAdjustSpec(kind);
    const amount = Number(range.value);
    if (kind === "brightness-contrast") spec.brightness = amount;
    else if (kind === "exposure") spec.stops = amount / 50;
    else if (kind === "vibrance" || kind === "hue-sat") {
      spec.amount = undefined;
      spec.saturation = amount;
    } else if (kind === "levels") {
      // 0.5..1.5 keeps gamma positive for any future slider range
      const gamma = Math.min(2, Math.max(0.5, 1 - amount / 200));
      spec.levels = { inBlack: 0, inWhite: 255, gamma, outBlack: 0, outWhite: 255 };
    }
    const layer = doc.addAdjustLayer(spec);
    layer.name = adjustLabel(spec);
    pushHist(layerAddCommand(doc, layer, doc.layers.length - 1));
    activeLayer = layer;
    flatDirty = true;
    renderLayers(); render(); renderHistoryPanel(); renderTabs(); pulse(layersBox);
  });
}


/**
 * A coarse mosaic of the layer: one flat colour per allocated 256px tile.
 * Sampling every pixel would mean a full readRect per layer on every edit,
 * which is exactly the cost we removed from compositing.
 */
function blendTitle(mode: BlendMode): string {
  return mode.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function opacityDialog(layer: Layer): void {
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
    layer.opacity = after;
    flatDirty = true;
    pushHist(propertyCommand(`Opacity ${v}% ${layer.name}`, (w) => { layer.opacity = w as number; flatDirty = true; }, before, after));
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
  flatDirty = true;
  pushHist(propertyCommand(`Blend ${blendTitle(before)} → ${blendTitle(m)} ${layer.name}`, (v) => { layer.blendMode = v as BlendMode; flatDirty = true; }, before, m));
  render(); renderLayers(); renderHistoryPanel();
}

function toggleLayerVisibility(layer: Layer): void {
  const before = layer.visible;
  layer.visible = !before;
  flatDirty = true;
  pushHist(propertyCommand(`${before ? "Hide" : "Show"} ${layer.name}`, (v) => { layer.visible = v as boolean; flatDirty = true; }, before, !before));
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

function layerContextMenu(layer: Layer): MenuItem[] {
  const idx = doc.layers.indexOf(layer);
  const blendItems: MenuItem[] = layerBlendItems(layer);
  const items: MenuItem[] = [
    { label: "New Layer…", key: "Shift+Ctrl+N", run: addNewLayer },
    { label: "Duplicate Layer…", run: duplicateActiveLayer },
    { label: "Delete Layer", disabled: doc.layers.length <= 1, run: deleteActiveLayer },
    { sep: true },
    { label: "Rename Layer…", run: () => beginLayerRename(layer) },
    { label: layer.visible ? "Hide Layer" : "Show Layer", run: () => toggleLayerVisibility(layer) },
    { label: layer.locked ? "Unlock Layer" : "Lock Layer", run: () => toggleLayerLock(layer) },
    { sep: true },
    { label: "Blending ▸", children: blendItems },
    { label: "Layer Opacity…", run: () => opacityDialog(layer) },
    { sep: true },
    {
      label: layer.clipToBelow ? "Release Clipping Mask" : "Create Clipping Mask",
      key: "Alt+Ctrl+G",
      run: () => {
        const before = layer.clipToBelow === true;
        layer.clipToBelow = !before;
        flatDirty = true;
        pushHist(propertyCommand(`${before ? "Release Clipping" : "Create Clipping"} ${layer.name}`, (v) => { layer.clipToBelow = v as boolean; flatDirty = true; }, before, !before));
        render(); renderLayers(); renderHistoryPanel();
      },
    },
    { label: "Add Layer Mask", run: addLayerMaskFromSelection },
    ...(layer.mask ? [
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
  layers: () => doc.layers,
  active: () => activeLayer,
  setActive: (l) => { activeLayer = l; },
  paintTarget: () => paintTarget,
  setPaintTarget: (t) => { paintTarget = t; },
  hasSelection: () => selMask !== null || selRect !== null,
  undoable: (label, apply, before, after) => pushHist(propertyCommand(label, apply, before, after)),
  repaint: () => { flatDirty = true; render(); },
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
  moveLayer: (to) => {
    const idx = doc.layers.indexOf(activeLayer);
    if (to === idx) return;
    doc.moveLayer(activeLayer, to);
    pushHist(layerMoveCommand(doc, activeLayer, idx, to));
    flatDirty = true; renderLayers(); render(); renderHistoryPanel();
  },
});

function renderLayers(): void {
  layersPanel.render();
}

const historyPanelDeps: HistoryPanelDeps = {
  host: historyBody,
  history: () => history,
  applyHistoryChange: () => applyHistoryChange(),
  showContextMenu: (ev, items) => showContextMenu(ev, items),
  statusHint: (message) => statusHint(message),
  updateStatus: () => updateStatus(),
};

/** history panel: one row per entry; applied (past) bright, future dimmed */
function renderHistoryPanel(): void { renderHistoryPanelInto(historyPanelDeps); }

const historyChangeDeps: HistoryChangeDeps = {
  clearPreview: () => clearPreview(),
  document: () => doc,
  textSelection: () => textSel,
  setTextSelection: (layer) => { textSel = layer; },
  markDirty: () => markDirty(),
  setFlatDirty: (v) => { flatDirty = v; },
  setAutosaveDirty: (v) => { autosaveDirty = v; },
  activeLayer: () => activeLayer,
  setActiveLayer: (layer) => { activeLayer = layer; },
  renderAll: () => { render(); renderLayers(); renderHistoryPanel(); },
};

function applyHistoryChange(): void { applyHistoryChangeVia(historyChangeDeps); }

// ---- keyboard shortcuts --------------------------------------------------
window.addEventListener("keydown", (e) => {
  // A dialog, the text editor or any form field owns its own keystrokes:
  // without this, typing "b" in a Width field switched tools and Backspace
  // erased pixels behind the modal. The rule lives in ui/keymap.ts so the
  // precedence is a test, not a comment (R6.3).
  const kt = e.target as HTMLElement | null;
  if (!shortcutAllowed({ modalOpen: modalOpen(), target: kt })) return;
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
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    togglePanels();
    document.getElementById("toolbar")?.classList.toggle("toolbar-hidden", !e.shiftKey);
    relayout();
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
  if (e.key === "b" || e.key === "B") { tool = "brush"; highlight(); }
  else if (e.key === "e" || e.key === "E") { tool = "eraser"; highlight(); }
  else if (e.key === "m" || e.key === "M") { tool = tool === "marquee" ? "ellipse" : "marquee"; highlight(); }
  else if (e.key === "l" || e.key === "L") { tool = "lasso"; highlight(); }
  else if (e.key === "p" || e.key === "P") { tool = "pen"; highlight(); statusHint("Pen — click anchors, Enter or double-click to close into a selection."); }
  else if (e.key === "w" || e.key === "W") { tool = e.shiftKey ? "quick" : "wand"; highlight(); }
  else if (e.key === "u" || e.key === "U") { tool = "shape"; highlight(); }
  else if (e.key === "[" || e.key === "]") {
    // documented in Help ▸ Keyboard Shortcuts: step the brush size
    const step = brushSize < 20 ? 1 : brushSize < 60 ? 5 : 10;
    brushSize = Math.max(1, Math.min(300, brushSize + (e.key === "]" ? step : -step)));
    refreshOptions();
  }
  else if (e.key === "g" || e.key === "G") { tool = e.shiftKey ? "bucket" : "gradient"; highlight(); }
  else if (e.key === "t" || e.key === "T") { tool = "text"; highlight(); }
  else if (e.key === "v" || e.key === "V") { tool = "move"; highlight(); }
  else if (e.key === "c" || e.key === "C") { tool = "crop"; highlight(); }
  else if (e.key === "i" || e.key === "I") { tool = "eyedropper"; highlight(); }
  else if (e.key === "o" || e.key === "O") { tool = "retouch"; highlight(); }
  else if (e.key === "j" || e.key === "J") { tool = "heal"; highlight(); }
  else if (e.key === "s" || e.key === "S") { tool = e.shiftKey ? "focus" : "clone"; highlight(); }
  else if (e.key === "q" || e.key === "Q") { toggleQuickMask(); }
  else if (e.key === "x" || e.key === "X") { swapColors(); }
  else if (e.key === "d" || e.key === "D") { setForeground([0, 0, 0], false); }
  // AI2: Enter closes a pen path. This must come before the crop branches, or
  // an armed crop/perspective gesture swallows the key and the path is stuck.
  else if (e.key === "Enter" && tool === "pen" && penAnchors.length >= 2) { commitPenPath(); }
  else if (e.key === "Enter" && cropQuad) { applyPerspectiveNow(); }
  else if (e.key === "Enter" && cropRect) { applyCropNow(); }
  else if (e.key === "Escape" && (handMode || zoomMode)) {
    handMode = false;
    zoomMode = false;
    syncCursor();
    e.preventDefault();
  }
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
    if (e.defaultPrevented || menusOpen()) return;
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
  else if ((e.key === "Delete" || e.key === "Backspace") && tool === "pen" && penAnchors.length > 0) {
    penAnchors.pop();
    selGeom = penAnchors.length >= 2 ? { kind: "poly", pts: flattenPath(penAnchors, false) } : null;
    drawOverlay();
    e.preventDefault();
  }
  else if ((e.key === "Delete" || e.key === "Backspace") && (selRect || selMask)) { clearSelection(); }
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
  flatDirty = true;
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
  if (activeLayer.locked) { warnLocked(); return; }
  const rect = selectionRect();
  if (rect.w <= 0 || rect.h <= 0) return;
  const entry = layerOpCommand(activeLayer, label, () => {
    fn(activeLayer.grid, rect, selMask ?? null);
  });
  if (!entry) return;
  pushHist(entry);
  flatDirty = true;
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
    editEpoch: history.editEpoch,
    layerCount: doc.layers.length,
    layerId: layer.id,
    maskStamp: layer.mask ? layer.mask.stamp() : 0,
  });
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
    const dst = preview.addLayer(src.name);
    cloneLayerMeta(dst, src);
    if (src.kind === "pixel") downsampleInto(dst.grid, src.grid, rect, sw, sh, k);
    if (src.mask) downsampleMaskInto(dst, src.mask, rect, sw, sh, k);
    if (src === layer) target = dst;
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
  flatDirty = true;
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
seedBootTab({ name: "Untitled", doc, activeLayer, history, flat, flatDirty, selRect, selMask, selGeom, scale, panX, panY, autosaveDirty, dirty: false });
renderTabs();

// ---- autosave / crash recovery (OPFS — fully local, never leaves the disk) --
const AUTOSAVE_FILE = "guazzo-autosave.json";
const AUTOSAVE_INTERVAL_MS = 20_000;

// structural types only — no dependence on lib.dom OPFS typings
interface AutosaveFileHandleLike {
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
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

async function writeAutosave(): Promise<void> {
  if (transform) return; // a live transform has no committed pixels
  if (autosaveInFlight) return; // two ticks must never open two writable handles
  captureTab(); // the active tab's dirty flag lives in its slot
  const pending = tabsView().filter(t => t.autosaveDirty);
  if (!pending.length) return;

  // Clear the flags BEFORE the first await and serialise synchronously right
  // after: nothing can interleave between those two statements, so any edit
  // that happens while we are writing sets the flag again and survives to the
  // next cycle. Clearing afterwards would silently mark that edit as saved.
  for (const t of pending) t.autosaveDirty = false;
  let payload: string;
  try {
    payload = JSON.stringify({
      savedAt: Date.now(),
      tabs: tabsView().map(t => ({ name: t.name, project: serializeProject(t.doc, t.name) })),
      active: activeIndex(),
    });
  } catch (err) {
    for (const t of pending) t.autosaveDirty = true; // keep it dirty, try later
    console.error("autosave serialise failed", err);
    return;
  }

  autosaveInFlight = true;
  try {
    const root = await opfs();
    if (!root) { for (const t of pending) t.autosaveDirty = true; return; }
    const fh = await root.getFileHandle(AUTOSAVE_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(payload);
    await w.close();
    autosaveDirty = false;
  } catch {
    // storage full or unavailable: keep the documents dirty so the next tick retries
    for (const t of pending) t.autosaveDirty = true;
  } finally {
    autosaveInFlight = false;
  }
}

let recoveryBar: HTMLDivElement | null = null;
function hideRecoveryBar(): void {
  if (recoveryBar) { recoveryBar.remove(); recoveryBar = null; }
}
interface AutosaveEntry { name?: unknown; project?: unknown }

function showRecoveryBar(savedAt: number, entries: AutosaveEntry[]): void {
  if (recoveryBar) return;
  const host = document.getElementById("canvas-host")!;
  const bar = document.createElement("div");
  bar.style.cssText = "position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:30;" +
    "background:#1f2733;border:1px solid #3a4a5f;border-radius:6px;padding:8px 12px;" +
    "display:flex;gap:10px;align-items:center;font:12px system-ui;color:#d8dee6;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.5)";
  const when = new Date(savedAt).toLocaleString();
  const label = document.createElement("span");
  label.textContent = `Found an unsaved autosave from ${when}` + (entries.length > 1 ? ` (${entries.length} documents)` : "");
  const restore = document.createElement("button");
  restore.textContent = "Restore";
  restore.style.cssText = "background:#1a6b32;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer";
  const discard = document.createElement("button");
  discard.textContent = "Discard";
  discard.style.cssText = "background:#6b1a1a;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer";

  restore.addEventListener("click", () => {
    for (const e of entries) {
      try {
        const { doc: nd, warnings } = deserializeProject(e.project);
        const name = typeof e.name === "string" && e.name ? e.name : "Restored";
        replaceDocument(nd, undefined, name);
        if (warnings.length > 0) console.warn(`restored "${name}" with repairs`, warnings);
      } catch (err) {
        console.error("autosave restore failed", err);
      }
    }
    // drop the untouched boot document when restored docs came back
    const all = tabsView();
    if (all.length > 1 && all[0]!.name === "Untitled" && all[0]!.history.position === 0) {
      closeTab(0);
    }
    hideRecoveryBar();
  });
  discard.addEventListener("click", async () => {
    // "Discard" used to delete the autosave on one click, with no undo and no
    // copy elsewhere: the only record of that work is the file being removed.
    // Ask first, and say exactly what is lost.
    const count = entries.length;
    const okToDiscard = await ask(
      "Discard the recovered work?",
      `This deletes the autosave, which is the only copy of ${count === 1 ? "this document" : `these ${count} documents`} ` +
        `from ${new Date(savedAt).toLocaleString()}.\n\nIt cannot be undone.`,
      "Discard it",
    );
    if (!okToDiscard) return;
    hideRecoveryBar();
    const root = await opfs();
    if (root) { try { await root.removeEntry(AUTOSAVE_FILE); } catch { /* already gone */ } }
  });

  bar.appendChild(label);
  bar.appendChild(restore);
  bar.appendChild(discard);
  host.appendChild(bar);
  recoveryBar = bar;
}

async function initAutosave(): Promise<void> {
  const root = await opfs();
  if (!root) return; // OPFS unavailable (e.g. some file:// contexts): autosave off
  try {
    const fh = await root.getFileHandle(AUTOSAVE_FILE);
    const text = await (await fh.getFile()).text();
    const parsed = JSON.parse(text) as { savedAt?: number; tabs?: unknown; project?: unknown };
    if (typeof parsed.savedAt === "number") {
      if (Array.isArray(parsed.tabs)) {
        // multi-document payload (v0.7.0+)
        showRecoveryBar(parsed.savedAt, parsed.tabs as AutosaveEntry[]);
      } else if (parsed.project) {
        // legacy single-document payload (v0.4.2–v0.6.0)
        showRecoveryBar(parsed.savedAt, [{ name: "Restored", project: parsed.project }]);
      }
    }
  } catch {
    /* no autosave yet — nothing to offer */
  }
  window.setInterval(() => { void writeAutosave(); }, AUTOSAVE_INTERVAL_MS);
}
void initAutosave();

// ---- merge down / flatten ----------------------------------------------------

/** composite the active layer onto the one below it, drop the active layer.
 *  Undoable as ONE history entry (pixels + layer removal together). */
function mergeDown(): void {
  if (transform) return;
  commitText();
  const idx = doc.layers.indexOf(activeLayer);
  if (idx <= 0) return; // nothing below (bottom layer) — Photoshop declines too
  const upper = activeLayer;
  const below = doc.layers[idx - 1]!;
  const pxOp = layerOpCommand(below, "Merge Down", () => {
    mergeLayerInto(upper, below);
  });
  const rmOp = layerRemoveCommand(doc, upper, idx);
  pushHist({
    label: "Merge Down",
    undo: () => { rmOp.undo(); pxOp?.undo(); },
    redo: () => { pxOp?.redo(); rmOp.redo(); },
  });
  activeLayer = below;
  flatDirty = true;
  renderLayers(); render(); renderHistoryPanel();
}

/** composite every layer into one "Flattened" layer (single history entry) */
function flattenImage(): void {
  if (transform) return;
  commitText();
  if (doc.layers.length < 2) return;
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
    undo: () => { doc.layers.length = 0; for (const l of before) doc.layers.push(l); },
    redo: () => { doc.layers.length = 0; doc.layers.push(flat); },
  });
  activeLayer = flat;
  flatDirty = true;
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
/** union one wand region into the live selection (Quick Selection brush) */
function quickDab(x: number, y: number, mode: "add" | "subtract" = "add"): void {
  if (transform) return;
  if (!quickPx) quickPx = activeLayerPixels();
  const px = quickPx;
  // a brush stroke should reach similar colours around the cursor, so sample a
  // few points across the brush disc instead of only its centre
  const radius = Math.max(2, Math.round(brushSize / 2 / Math.max(0.05, scale)));
  const pts: Array<[number, number]> = [[x, y]];
  for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    pts.push([Math.round(x + Math.cos(a) * radius), Math.round(y + Math.sin(a) * radius)]);
  }
  if (!selMask) selMask = new SelectionMask(doc.width, doc.height);
  let touched = false;
  for (const [sx, sy] of pts) {
    const ix = Math.round(sx), iy = Math.round(sy);
    if (ix < 0 || iy < 0 || ix >= doc.width || iy >= doc.height) continue;
    const found = magicWand(px, doc.width, doc.height, ix, iy, {
      tolerance: quickTolerance,
      contiguous: true,
      antialias: true,
    });
    if (!found) continue;
    const box = found.bbox;
    for (let yy = box.y; yy < box.y + box.h; yy++) {
      for (let xx = box.x; xx < box.x + box.w; xx++) {
        const a = found.mask.alphaAt(xx, yy);
        if (a > 0) {
          const prev = selMask.alphaAt(xx, yy);
          if (mode === "subtract") {
            if (prev > 0) { selMask.setAlpha(xx, yy, Math.max(0, prev - a)); touched = true; }
          } else if (a > prev) { selMask.setAlpha(xx, yy, a); touched = true; }
        }
      }
    }
  }
  if (!touched) return;
  selRect = null;
  selGeom = null;
  startAnts();
  drawOverlay();
  refreshOptions();
  render();
}

function pourBucket(x: number, y: number): void {
  if (transform) return;
  commitText();
  const layer = activeLayer;
  if (!layer) return;
  if (layer.locked) { warnLocked(); return; }
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
  flatDirty = true;
  render();
  renderHistoryPanel();
}

/** Edit > Fill: flood the whole selection (or the layer) with the foreground. */
/** Edit ▸ Smart Fill (classical patch-based inpainting): rebuilds the selection from the pixels around it. */
function contentAwareFillSelection(): void {
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
  if (layer.locked) { warnLocked(); return; }
  const rect = {
    x: Math.max(0, b.x), y: Math.max(0, b.y),
    w: Math.min(b.w, doc.width - Math.max(0, b.x)),
    h: Math.min(b.h, doc.height - Math.max(0, b.y)),
  };
  const entry = layerOpCommandIn(layer, "Smart Fill", () => {
    contentAwareFill(layer.grid, rect, mask);
  }, rect);
  if (entry) pushHist(entry);
  flatDirty = true;
  render();
  renderHistoryPanel();
}

function fillWithForeground(): void {
  if (transform) return;
  commitText();
  const layer = activeLayer;
  if (!layer) return;
  if (layer.locked) { warnLocked(); return; }
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
  flatDirty = true;
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
  m.invert();
  selMask = m;
  selRect = null;
  selGeom = null;
  startAnts();
  drawOverlay();
  refreshOptions();
  render();
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
interface MaskSnap {
  /** bbox of the selection, so undo stores the shape, not the canvas */
  x: number;
  y: number;
  w: number;
  h: number;
  /** coverage rows, row-major, w*h bytes (a 16384² mask would be 268 MB) */
  data: Uint8ClampedArray;
}

interface SelectionSnap {
  rect: { x: number; y: number; w: number; h: number } | null;
  mask: MaskSnap | null;
}

function snapshotMask(mask: SelectionMask | null): MaskSnap | null {
  if (!mask) return null;
  const b = mask.bbox();
  if (!b || b.w < 1 || b.h < 1) return null;
  const data = new Uint8ClampedArray(b.w * b.h);
  let any = false;
  for (let y = 0; y < b.h; y++) {
    const row = y * b.w;
    for (let x = 0; x < b.w; x++) {
      const a = mask.alphaAt(b.x + x, b.y + y);
      if (a !== 0) {
        data[row + x] = a;
        any = true;
      }
    }
  }
  // All-zero coverage is the same selection as "nothing selected", and storing
  // the empty bbox would make `selMask` truthy again after an undo to nothing.
  return any ? { x: b.x, y: b.y, w: b.w, h: b.h, data } : null;
}

function restoreMask(snap: MaskSnap | null): SelectionMask | null {
  if (!snap) return null;
  const mask = new SelectionMask(doc.width, doc.height);
  for (let y = 0; y < snap.h; y++) {
    const row = y * snap.w;
    for (let x = 0; x < snap.w; x++) {
      const a = snap.data[row + x] ?? 0;
      if (a !== 0) mask.setAlpha(snap.x + x, snap.y + y, a);
    }
  }
  return mask;
}

function snapshotSelection(): SelectionSnap {
  return {
    rect: selRect ? { x: selRect.x, y: selRect.y, w: selRect.w, h: selRect.h } : null,
    mask: selRect ? null : snapshotMask(selMask),
  };
}

function restoreSelection(snap: SelectionSnap): void {
  selRect = snap.rect ? { ...snap.rect } : null;
  selMask = snap.rect ? null : restoreMask(snap.mask);
  selGeom = null;
  marqueeing = false;
  ellipseDrag = false;
  lassoing = false;
  if (selRect || selMask) startAnts(); else stopAnts();
  drawOverlay();
  refreshOptions();
  render();
  updateStatus();
}

function selectionBytes(snap: SelectionSnap): number {
  if (snap.rect) return 32;
  return snap.mask ? snap.mask.data.length : 0;
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

function applySelectionMask(next: SelectionMask, label = "Selection"): void {
  const before = snapshotSelection();
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

/** flat RGBA of the active layer, used by Grow/Similar/Quick Selection */
function activeLayerPixels(): Uint8ClampedArray {
  // the wand samples the active layer, so Grow/Similar must too — sampling the
  // composite here made two selection tools disagree about the same click
  const px = new Uint8ClampedArray(doc.width * doc.height * 4);
  activeLayer.grid.readRect(0, 0, doc.width, doc.height, px);
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
  note.textContent = "Refines the edge band against the active layer's colours, then feathers.";
  body.appendChild(note);
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
      pushHist(layerAddCommand(doc, copy, doc.layers.indexOf(copy)));
    }
    // Write the refined coverage into the layer's mask. AL5: everything the
    // selection does NOT cover must be hidden, or "Layer mask" showed the whole
    // layer with a hole where the selection's bbox ended.
    const maskGrid = doc.attachMask(activeLayer);
    const beforeMask = captureTiles(maskGrid);
    fillMaskFromSelection(maskGrid, next, true);
    paintTarget = "mask";
    pushHist(snapshotCommand(maskGrid, "Select and Mask", beforeMask));
    flatDirty = true;
    render();
    renderLayers();
    renderHistoryPanel();
    refreshOptions();
    statusHint(`Mask created from the refined edge (radius ${r}px, feather ${f}px)`);
  });
}

function selectGrow(): void {
  const base = currentSelectionMask();
  if (!base) { selectAll(); return; }
  const px = activeLayerPixels();
  applySelectionMask(growSelection(base, px, doc.width, doc.height, 32));
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
  const layer = doc.addLayer(`Layer ${doc.layers.length}`);
  activeLayer = layer;
  pushHist(layerAddCommand(doc, layer, doc.layers.length - 1));
  flatDirty = true;
  renderLayers(); render(); renderHistoryPanel();
}

function duplicateActiveLayer(): void {
  if (transform) applyTransform();
  const src = activeLayer;
  const copy = doc.addLayer(`${src.name} copy`);
  copy.blendMode = src.blendMode;
  copy.opacity = src.opacity;
  copy.visible = src.visible;
  // a duplicate must be the same KIND of layer: an adjustment or fill layer
  // copied as bare pixels would silently become an empty pixel layer
  copy.kind = src.kind;
  copy.clipToBelow = src.clipToBelow;
  if (src.groupId) copy.groupId = src.groupId;
  if (src.adjust) copy.adjust = JSON.parse(JSON.stringify(src.adjust)) as AdjustSpec;
  if (src.fill) copy.fill = { color: [...src.fill.color] as [number, number, number] };
  if (src.textData) copy.textData = { ...src.textData };
  src.grid.forEachTile((t, tx, ty) => {
    copy.grid.writeRect(tx * TILE, ty * TILE, TILE, TILE, t.data);
  });
  if (src.mask) {
    const m = doc.attachMask(copy);
    src.mask.forEachTile((t, tx, ty) => {
      m.writeRect(tx * TILE, ty * TILE, TILE, TILE, t.data);
    });
  }
  activeLayer = copy;
  pushHist(layerAddCommand(doc, copy, doc.layers.length - 1));
  flatDirty = true;
  renderLayers(); render(); renderHistoryPanel();
}

function deleteActiveLayer(): void {
  if (transform) return; // deleting mid-transform would desync the preview
  if (doc.layers.length <= 1) return;
  const idx = doc.layers.indexOf(activeLayer);
  const layer = activeLayer;
  doc.removeLayer(layer);
  activeLayer = doc.layers[Math.min(idx, doc.layers.length - 1)] ?? doc.layers[0]!;
  pushHist(layerRemoveCommand(doc, layer, idx));
  flatDirty = true;
  renderLayers(); render(); renderHistoryPanel();
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

function openAdjustPalette(kind?: string): void {
  if (!adjustPal) adjustPal = buildAdjustPalette();
  if (adjustPal.parentNode !== document.body) document.body.appendChild(adjustPal);
  adjustPal.style.display = "flex";
  if (!adjustPalPos) {
    const w = adjustPal.offsetWidth || 260;
    adjustPalPos = { x: Math.max(8, window.innerWidth - w - 24), y: 90 };
  }
  adjustPal.style.left = `${adjustPalPos.x}px`;
  adjustPal.style.top = `${adjustPalPos.y}px`;
  if (kind) palSelectKind?.(kind);
}

function closeAdjustPalette(): void {
  if (adjustPal) adjustPal.style.display = "none";
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
        { label: "Undo", key: "Ctrl+Z", disabled: !history.canUndo, run: () => { if (history.undo()) applyHistoryChange(); } },
        { label: "Redo", key: "Ctrl+Shift+Z", disabled: !history.canRedo, run: () => { if (history.redo()) applyHistoryChange(); } },
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
        { label: "Duplicate Layer", key: "Ctrl+J", run: duplicateActiveLayer },
        { label: "Delete Layer", disabled: doc.layers.length <= 1, run: deleteActiveLayer },
        { sep: true },
        // X2: the four layer ops that used to live only in the pointer context
        // menu now reach the Menu bar (one implementation, both surfaces)
        { label: "Rename Layer…", run: () => beginLayerRename(activeLayer) },
        { label: activeLayer.visible ? "Hide Layer" : "Show Layer", run: () => toggleLayerVisibility(activeLayer) },
        { label: activeLayer.locked ? "Unlock Layer" : "Lock Layer", run: () => toggleLayerLock(activeLayer) },
        { label: "Blending ▸", children: layerBlendItems(activeLayer) },
        { sep: true },
        { label: "Merge Down", key: "Ctrl+E", disabled: layerIdx <= 0, run: mergeDown },
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
        { label: "Show / Hide Panels", key: "Tab", run: () => { togglePanels(); relayout(); } },
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

async function closeWithGuard(): Promise<void> {
  // AL1: one prompt at a time. The 400 ms poller used to start a second
  // closeWithGuard() while the first ask() was still open, so dismissing the
  // dialog answered one while another stacked on top of it.
  if (!closeLoop.begin()) return;
  try {
    const dirty = tabsView().filter((t) => t.dirty);
    if (dirty.length > 0) {
      const names = dirty.map((t) => t.name).join(", ");
      const closeAnyway = await ask(
        "Unsaved changes",
        `${dirty.length} document(s) have unsaved changes (${names}).\n\nClosing now loses them.`,
        "Close anyway",
      );
      if (!closeAnyway) return;
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
  const r = selectionRect();
  if (r.w < 1 || r.h < 1) return;
  const data = new Uint8ClampedArray(r.w * r.h * 4);
  if (merged) doc.compositeRect(r.x, r.y, r.w, r.h, data);
  else layer.grid.readRect(r.x, r.y, r.w, r.h, data);
  clip = { w: r.w, h: r.h, data };
  if (!silent) statusHint(merged ? "Copied merged pixels" : `Copied ${r.w} × ${r.h} px`);
}

function cutFromDoc(): void {
  const layer = activeLayer;
  if (!layer || layer.locked) { if (layer) warnLocked(); return; }
  if (layer.kind !== "pixel") { statusHint("Nothing to cut — rasterize the layer first"); return; }
  // capture the pixels BEFORE mutating — one conceptual action, ONE undo
  copyFromDoc(false, true);
  const entry = layerOpCommand(layer, "Cut", () => {
    if (selMask) clearMasked(layer.grid, selMask);
    else if (selRect) layer.grid.fillRect(selRect.x, selRect.y, selRect.w, selRect.h, [0, 0, 0, 0]);
  });
  if (!entry) return;
  pushHist(entry);
  flatDirty = true;
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
  pushHist(layerAddCommand(doc, layer, doc.layers.length - 1));
  flatDirty = true;
  render();
  renderLayers();
  renderHistoryPanel();
  statusHint(`Pasted as “${name}”`);
}

function quickExportPng(): void {
  runExport({ format: "png", quality: 100, scale: 100, filename: activeTabName() });
}

function canvasContextMenu(ev: MouseEvent): void {
  const items: MenuItem[] = [
    { label: "Undo", key: "Ctrl+Z", disabled: !history.canUndo, run: () => { history.undo(); applyHistoryChange(); } },
    { label: "Redo", key: "Ctrl+Shift+Z", disabled: !history.canRedo, run: () => { history.redo(); applyHistoryChange(); } },
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
    { label: "Crop to Selection", disabled: !selRect, run: applyCropNow },
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
  if (flatDirty) renderFlat();
  const s = sampleColor({ width: doc.width, height: doc.height, data: flat }, Math.round(x), Math.round(y), eyeSize);
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
  undo: () => { if (history.undo()) applyHistoryChange(); },
  redo: () => { if (history.redo()) applyHistoryChange(); },
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
