/**
 * main.ts — walking-skeleton UI: viewport + brush + layers panel.
 * Real panel/tool architecture lands with the full UI pass.
 */

import { Document, bakeLayerMask, maskAt, mergeLayerInto, paintMaskDab, setMaskAt, type Layer, type TextSeg } from "./engine/document.ts";
import { adjustLabel, defaultAdjustSpec, type AdjustKind, type AdjustSpec } from "./engine/adjustfn.ts";
import { resizeDocument, canvasResizeDocument, cropDocument } from "./engine/resize.ts";
import { stampDab, dabPositions, type TipImage } from "./engine/paint.ts";
import { History, StrokeSession, propertyCommand, layerAddCommand, layerRemoveCommand, layerMoveCommand, layerOpCommand, layerOpCommandIn, captureTiles, snapshotCommand, type HistoryEntry, type TileImages } from "./engine/history.ts";
import { TILE } from "./engine/tile.ts";
import { LAYER_BLEND_MODES, type BlendMode } from "./engine/blend.ts";
import { serializeProject, deserializeProject } from "./engine/io.ts";
import { applyAdjustment, type AdjustmentKind } from "./engine/adjust.ts";
import { applyFilter, mulberry32 } from "./engine/filter.ts";
import { flip, rotate90, rotate180, trimBounds } from "./engine/imageops.ts";
import { drawShape, shapePolyline, shapeSelection, type ShapeKind, type ShapeSpec } from "./engine/shapes.ts";
import * as f2 from "./engine/filters2.ts";
import type { F2Rect } from "./engine/filters2.ts";
import { psdToDocument, type PsdLike } from "./engine/psd.ts";
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
import { transformLayer, gridBBox } from "./engine/transform.ts";
import { snapshotGrid, applyLayerMove, type GridSnapshot } from "./engine/move.ts";
import { floodFill, magicWand, sampleGrid, type RGBA } from "./engine/flood.ts";
import { dodgeBurnDab, spongeDab, focusDab, smudgeDab, cloneDab, redEyeDab, sampleColor } from "./engine/retouch.ts";
import { fillPlane } from "./engine/plane.ts";
import { contentAwareFill, spotHeal } from "./engine/heal.ts";
import { MAX_DIM } from "./engine/docmeta.ts";
import { buildTonalPanel } from "./ui/tonal.ts";
import { iconSvg, setIcon, type IconName } from "./ui/icons.ts";
import { dockifyPanels, resetDock, togglePanels } from "./ui/dock.ts";
import { openExportDialog, type ExportRequest } from "./ui/exportdlg.ts";
import { buildPsd } from "./engine/psdexport.ts";
import { openNewDocumentDialog } from "./ui/newdoc.ts";

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
let marqueeStart: [number, number] = [0, 0];
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
  selRect = null;
  selMask = null;
  selGeom = null;
  marqueeing = false;
  ellipseDrag = false;
  lassoing = false;
  stopAnts();
  drawOverlay();
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
let panning = false;
let panGrab: { sx: number; sy: number; px: number; py: number } | null = null;
/** middle-button behaviour: drag = temporary pan, click = sticky pan until clicked again */
let midPan: { moved: boolean } | null = null;
let panSticky = false;
let stickyPrev: [number, number] = [0, 0];
/** hover position in canvas-host CSS pixels, for the brush-size ring */
let hoverPos: [number, number] | null = null;
/** number of open modals; the global shortcut handler is muted while > 0 */
let modalCount = 0;
let checkerPattern: CanvasPattern | null = null;

/** Safety net: a rebuilt/hidden bar is re-attached instead of silently gone. */
function ensureMenuBar(): void {
  if (!menuBarEl.isConnected || menuBarEl.offsetWidth === 0) {
    if (!menuBarEl.isConnected) topbar.insertBefore(menuBarEl, topbar.children[1] ?? null);
    buildMenuBar();
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
type ToolId =
  | "brush"
  | "eraser"
  | "marquee"
  | "ellipse"
  | "lasso"
  | "gradient"
  | "text"
  | "move"
  | "crop"
  | "wand"
  | "quick"
  | "shape"
  | "bucket"
  | "heal"
  | "eyedropper" | "retouch" | "clone" | "focus";
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
let textFont = "Arial";
let textSize = 48;
let textBold = false;
let textItalic = false;
let textUnderline = false;
let textStrike = false;
/** live on-canvas text editor: contentEditable box + drag handle */
let textEditing: { el: HTMLDivElement; handle: HTMLDivElement; docX: number; docY: number } | null = null;
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
function startTextEditor(docX: number, docY: number, seedHtml?: string): void {
  commitText();
  const host = document.getElementById("canvas-host")!;
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.spellcheck = false;
  el.style.cssText =
    "position:absolute;z-index:6;margin:0;padding:2px 3px;min-width:24px;min-height:1.3em;outline:none;white-space:pre;" +
    "border:1px dashed #7fb2ff;background:rgba(9,79,209,.12);caret-color:#fff;box-sizing:content-box;overflow:visible";
  // drag handle floats ABOVE the box (sibling, so el.textContent stays pure text)
  const handle = document.createElement("div");
  handle.textContent = "✥";
  handle.title = "Drag to move the text box";
  handle.style.cssText =
    "position:absolute;z-index:6;width:22px;height:16px;line-height:15px;text-align:center;font-size:11px;" +
    "color:#7fb2ff;background:#1b1b1b;border:1px solid #7fb2ff;cursor:grab;user-select:none";
  host.append(el, handle);
  textEditing = { el, handle, docX, docY };
  if (seedHtml) el.innerHTML = seedHtml; // re-editing: restore styled content
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
    else if (e.key === "Escape") { e.preventDefault(); commitText(); }
    e.stopPropagation(); // typing stays in the box (native undo while editing)
  });
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try { handle.setPointerCapture(ev.pointerId); } catch { /* lost pointer */ }
    const sx = ev.clientX, sy = ev.clientY;
    const ox = textEditing?.docX ?? 0, oy = textEditing?.docY ?? 0;
    const onMove = (ev2: PointerEvent) => {
      if (!textEditing) return;
      textEditing.docX = ox + (ev2.clientX - sx) / scale;
      textEditing.docY = oy + (ev2.clientY - sy) / scale;
      restyleTextEditor();
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
  restyleTextEditor();
  el.focus();
}

/** keep the live box glued to the canvas (position in screen px, font scaled by zoom) */
function restyleTextEditor(): void {
  if (!textEditing) return;
  const { el, handle, docX, docY } = textEditing;
  const [sx, sy] = docToScreen(docX, docY);
  el.style.left = `${sx}px`;
  el.style.top = `${sy}px`;
  el.style.font = `${textItalic ? "italic " : ""}${textBold ? "bold " : ""}${textSize * scale}px ${textFont}`;
  el.style.color = `rgb(${color[0]},${color[1]},${color[2]})`;
  el.style.textDecoration = `${textUnderline ? "underline " : ""}${textStrike ? "line-through" : ""}`.trim() || "none";
  handle.style.left = `${sx}px`;
  handle.style.top = `${sy - 18}px`;
}

/** rebuild live-editor HTML from stored segments (re-edit seeding) */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function segSpanHtml(s: TextSeg): string {
  const style: string[] = [`font-family:${s.font}`];
  if (s.bold) style.push("font-weight:600");
  if (s.italic) style.push("font-style:italic");
  const deco: string[] = [];
  if (s.underline) deco.push("underline");
  if (s.strike) deco.push("line-through");
  if (deco.length) style.push(`text-decoration:${deco.join(" ")}`);
  const txt = escapeHtml(s.text);
  if (!s.bold && !s.italic && !s.underline && !s.strike) return txt; // plain run, no wrapper
  return `<span face="${escapeHtml(s.font)}" style="${style.join(";")}">${txt}</span>`;
}
function buildSeedHtml(lines: TextSeg[][]): string {
  return lines.map(segs => segs.map(segSpanHtml).join("")).join("<br>");
}

/** click on an existing text layer → reopen its live editor seeded with the stored recipe */
function openTextFor(layer: Layer): void {
  const meta = layer.textData!;
  commitText(); // flush any live box FIRST, while the old text state/target still apply
  textTarget = layer;
  textSize = Math.min(200, Math.max(8, Math.round(meta.size)));
  color[0] = meta.color[0] ?? 0;
  color[1] = meta.color[1] ?? 0;
  color[2] = meta.color[2] ?? 0;
  colorWell.value = `#${color.map(c => c.toString(16).padStart(2, "0")).join("")}`;
  const first = meta.lines[0]?.[0];
  textBold = first?.bold ?? false;
  textItalic = first?.italic ?? false;
  textUnderline = first?.underline ?? false;
  textStrike = first?.strike ?? false;
  textFont = first?.font ?? "Arial";
  refreshOptions(); // rebuild the text options bar with the restored size/font state
  startTextEditor(meta.x, meta.y, buildSeedHtml(meta.lines));
}

/** measure + paint mixed-styling MULTILINE text; returns the raster or null when empty */
function rasterizeTextRich(lines: TextSeg[][]): { rgba: Uint8ClampedArray; cw: number; ch: number } | null {
  interface Paint { text: string; font: string; width: number; underline: boolean; strike: boolean; }
  const mc = document.createElement("canvas");
  const mctx = mc.getContext("2d")!;
  const gap = Math.max(1, Math.round(textSize * 0.2)); // leading between lines
  const laid: { paints: Paint[]; ascent: number; descent: number; width: number }[] = [];
  let maxW = 0, totalH = 0;
  lines.forEach((segs, i) => {
    const paints: Paint[] = [];
    let w = 0, ascent = 0, descent = 0;
    for (const s of segs) {
      const font = `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}${textSize}px ${s.font}`;
      mctx.font = font;
      const m = mctx.measureText(s.text);
      paints.push({ text: s.text, font, width: m.width, underline: s.underline, strike: s.strike });
      w += m.width;
      ascent = Math.max(ascent, m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : textSize * 0.9);
      descent = Math.max(descent, m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : textSize * 0.3);
    }
    if (!paints.length) { // blank line still takes a line of height
      ascent = textSize * 0.9;
      descent = textSize * 0.3;
    }
    maxW = Math.max(maxW, w);
    laid.push({ paints, ascent, descent, width: w });
    totalH += ascent + descent + (i < lines.length - 1 ? gap : 0);
  });
  const cw = Math.ceil(maxW) + 2;
  const ch = Math.ceil(totalH) + 2;
  if (cw < 1 || ch < 1) return null;
  mc.width = cw;
  mc.height = ch;
  const ctx = mc.getContext("2d")!;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  const lineH = Math.max(1, Math.round(textSize / 14));
  let y = 1;
  for (const l of laid) {
    let cx = 1;
    for (const p of l.paints) {
      ctx.font = p.font;
      ctx.fillText(p.text, cx, y + l.ascent);
      if (p.underline) ctx.fillRect(cx, y + l.ascent + 1, p.width, lineH);
      if (p.strike) ctx.fillRect(cx, y + Math.round(l.ascent * 0.55), p.width, lineH);
      cx += p.width;
    }
    y += l.ascent + l.descent + gap;
  }
  return { rgba: ctx.getImageData(0, 0, cw, ch).data, cw, ch };
}

/** commit the live box: edit the target layer in place, or create a new one */
function commitText(): void {
  if (!textEditing) return;
  const { el, handle, docX, docY } = textEditing;
  const lines: TextSeg[][] = [];
  collectSegs(el, { bold: textBold, italic: textItalic, underline: textUnderline, strike: textStrike, font: textFont }, lines);
  el.remove();
  handle.remove();
  textEditing = null;
  while (lines.length && !lines[lines.length - 1]!.length) lines.pop(); // drop trailing empty lines
  const text = lines.map(l => l.map(s => s.text).join("")).join("\n").replace(/\u00A0/g, " ").trim();
  const target = textTarget;
  textTarget = null;
  if (!text) {
    // emptied box on an existing text layer → clear its pixels (undoable)
    if (target && doc.layers.includes(target) && target.textData) {
      const meta = target.textData;
      const entry = layerOpCommand(target, "Clear text", () => {
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
    const entry = layerOpCommand(target, "Edit text", () => {
      const meta = target.textData;
      if (meta) target.grid.fillRect(meta.x, meta.y, meta.w, meta.h, [0, 0, 0, 0]); // clear old footprint
      const r = rasterizeTextRich(lines);
      if (r) {
        target.grid.writeRect(rx, ry, r.cw, r.ch, r.rgba);
        target.textData = {
          lines: lines.map(l => l.map(s => ({ ...s }))),
          x: rx, y: ry, w: r.cw, h: r.ch,
          size: textSize, color: [color[0], color[1], color[2]],
        };
      }
    });
    if (entry) pushHist(entry);
    flatDirty = true;
    render();
    renderLayers();
    renderHistoryPanel();
    return;
  }
  placeTextRich(lines, docX, docY);
}

/** stamp mixed-styling text as a NEW undoable layer; (x, y) = top-left in doc coords */
function placeTextRich(lines: TextSeg[][], x: number, y: number): void {
  const r = rasterizeTextRich(lines);
  if (!r) return;
  const content = lines.map(l => l.map(s => s.text).join("")).join(" ").replace(/\u00A0/g, " ").trim();
  const rx = Math.round(x), ry = Math.round(y);
  const layer = doc.addLayer(`Text: ${content.slice(0, 24)}`);
  // writeRect clips at doc bounds; negative-origin placement is safe
  layer.grid.writeRect(rx, ry, r.cw, r.ch, r.rgba);
  layer.textData = {
    lines: lines.map(l => l.map(s => ({ ...s }))),
    x: rx, y: ry, w: r.cw, h: r.ch,
    size: textSize, color: [color[0], color[1], color[2]],
  };
  activeLayer = layer;
  pushHist(layerAddCommand(doc, layer, doc.layers.length - 1));
  flatDirty = true;
  render();
  renderLayers();
  renderHistoryPanel();
}

function screenToDoc(e: PointerEvent): [number, number] {
  const rect = display.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  return [(sx - panX) / scale, (sy - panY) / scale];
}

// ---- Move tool ------------------------------------------------------------

function beginMoveDrag(x: number, y: number): void {
  commitText();
  const layer = activeLayer;
  if (!layer) return;
  if (layer.locked) { warnLocked(); return; }
  moveDrag = {
    layer,
    before: captureTiles(layer.grid),
    snap: snapshotGrid(layer.grid),
    mask: selMask,
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
    // re-edit: clicking inside an existing text layer's box reopens that text
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i]!;
      const m = l.textData;
      if (!m) continue;
      if (x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) {
        openTextFor(l);
        return;
      }
    }
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
  if (healMask) { commitHeal(); return; }
  if (shapeDrag) { commitShape(); return; }
  if (moveDrag) { endMoveDrag(); return; }
  if (cropDrag) {
    cropDrag = false;
    if (cropRect && (cropRect.w < 2 || cropRect.h < 2)) cropRect = null; // click = clear
    drawOverlay();
    refreshOptions();
    return;
  }
  if (transform) { transform.mode = ""; return; }
  if (marqueeing) {
    marqueeing = false;
    if (selRect && (selRect.w < 2 || selRect.h < 2)) selRect = null; // click = deselect
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
    return;
  }
  if (ellipseDrag) {
    ellipseDrag = false;
    const r = selGeom && selGeom.kind === "ellipse" ? selGeom : null;
    if (!r || r.w < 2 || r.h < 2) { deselect(); return; } // click = deselect
    const m = new SelectionMask(doc.width, doc.height);
    m.selectEllipse(r.x, r.y, r.w, r.h);
    selMask = m;
    startAnts();
    drawOverlay();
    return;
  }
  if (lassoing) {
    lassoing = false;
    if (lassoPts.length < 3) { deselect(); return; } // click = deselect
    const m = new SelectionMask(doc.width, doc.height);
    m.selectPolygon(lassoPts);
    selMask = m;
    selGeom = { kind: "poly", pts: lassoPts.slice() };
    startAnts();
    drawOverlay();
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

// ---- toolbar sizing (drag the right edge, or flip to two compact columns) --
const LS_TOOLBAR = "pigment.toolbar.v1";
/** width at which the toolbar flips between one and two columns */
const AUTO_WRAP_W = 92;
let toolbarCols: 1 | 2 = 1;
let toolbarW = 50;
const appEl = document.getElementById("app");
function applyToolbar(): void {
  const width = toolbarCols === 2 ? Math.max(AUTO_WRAP_W, toolbarW) : toolbarW;
  // a missing #app must not break the rest of the layout pass
  appEl?.style?.setProperty("--toolbar-w", `${width}px`);
  toolbar.classList.toggle("wrap", toolbarCols === 2);
  toolbarSizeBtn.classList.toggle("active", toolbarCols === 2);
  toolbarSizeBtn.title = toolbarCols === 2 ? "Single-column toolbar" : "Two-column toolbar (compact)";
  try {
    localStorage.setItem(LS_TOOLBAR, JSON.stringify({ cols: toolbarCols, w: toolbarW }));
  } catch {
    /* storage can be denied in private windows; the layout still works */
  }
  relayout();
}
(function loadToolbar(): void {
  try {
    const raw = localStorage.getItem(LS_TOOLBAR);
    if (!raw) return;
    const v = JSON.parse(raw) as { cols?: number; w?: number };
    if (v.cols === 2 || v.cols === 1) toolbarCols = v.cols;
    if (typeof v.w === "number" && Number.isFinite(v.w)) toolbarW = Math.max(44, Math.min(180, v.w));
  } catch {
    /* a corrupt preference must never block start-up */
  }
})();
const toolbarGrip = document.createElement("div");
toolbarGrip.id = "toolbar-grip";
toolbarGrip.title = "Drag to resize the toolbar";
const toolbarSizeBtn = document.createElement("button");
toolbarSizeBtn.className = "tool toolbar-size";
toolbarSizeBtn.innerHTML = iconSvg("columns", 18);
toolbarSizeBtn.addEventListener("click", () => {
  toolbarCols = toolbarCols === 2 ? 1 : 2;
  // keep the persisted width in the mode's range so later grip drags
  // start from what is on screen
  if (toolbarCols === 2 && toolbarW < AUTO_WRAP_W + 4) toolbarW = AUTO_WRAP_W + 4;
  if (toolbarCols === 1 && toolbarW > 88) toolbarW = 88;
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
    if (prevW < AUTO_WRAP_W && toolbarW >= AUTO_WRAP_W) toolbarCols = 2;
    else if (prevW >= AUTO_WRAP_W && toolbarW < AUTO_WRAP_W) toolbarCols = 1;
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
// small window: when the tools stop fitting vertically, compact to two
// columns once. Deliberately one-directional (no oscillation): going back to
// one column is the user's call via the pinned footer button or the grip.
new ResizeObserver(() => {
  if (toolbarCols === 1 && toolbar.scrollHeight > toolbar.clientHeight + 4) {
    toolbarCols = 2;
    applyToolbar();
  }
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

topbar.innerHTML = `<span id="brand"><span class="dot"></span>Pigment
  <small>offline image editor</small></span>`;

// ---- status bar (Photoshop-style read-out strip along the bottom) ----------
const statusBar = document.getElementById("statusbar")!;
let hintTimer: number | null = null;
/** Show a one-off message where Photoshop shows status text. */
function statusHint(message: string): void {
  const el = document.getElementById("statusbar");
  if (!el) return;
  el.innerHTML = `<span class="status-hint">${message}</span>`;
  if (hintTimer !== null) window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => { hintTimer = null; updateStatus(); }, 2600);
}

/** Locked layers used to be silent no-ops; say why nothing happened. */
function warnLocked(): void {
  pulse(layersBody);
  statusHint("This layer is locked — click the lock in the Layers panel to edit it.");
}

function updateStatus(): void {
  const zoom = Number.isFinite(scale) ? Math.round(scale * 100) : 100;
  const idx = doc.layers.indexOf(activeLayer);
  const layerNo = idx < 0 ? 0 : doc.layers.length - idx;
  let cursor = "";
  if (hoverPos) {
    const cx = Math.floor((hoverPos[0] - panX) / scale);
    const cy = Math.floor((hoverPos[1] - panY) / scale);
    if (cx >= 0 && cy >= 0 && cx < doc.width && cy < doc.height) cursor = `<span>X <b>${cx}</b> Y <b>${cy}</b></span>`;
  }
  let selInfo = "";
  const sb = selRect
    ? selRect
    : selMask
      ? selMask.bbox()
      : null;
  if (sb) selInfo = `<span>Selection <b>${Math.round(sb.w)} × ${Math.round(sb.h)}</b></span>`;
  const dirty = docDirty ? `<span class="status-dirty">• Unsaved</span>` : "";
  statusBar.innerHTML =
    `<span>Zoom <b>${zoom}%</b></span>` +
    `<span>${doc.width} × ${doc.height} px</span>` +
    cursor +
    selInfo +
    `<span>Layer <b>${layerNo}</b> of ${doc.layers.length}</span>` +
    `<span>History <b>${history.position}</b>/${history.labels.length}</span>` +
    dirty +
    `<span class="grow-spacer"></span>` +
    `<span>100% offline — no network access</span>`;
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

function askFile(accept: string): Promise<File | null> {
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

/** swap in a whole new document (image/project open, New) and reset view + history */
// ---- document tabs ---------------------------------------------------------
// One Pigment window hosts any number of open documents. All live handlers
// reference the module-level globals above; switching tabs simply swaps the
// globals to point at the selected document's bundle — no call-site changes.
interface DocTab {
  name: string;
  doc: Document;
  activeLayer: Layer;
  history: History;
  flat: Uint8ClampedArray<ArrayBuffer>;
  flatDirty: boolean;
  selRect: { x: number; y: number; w: number; h: number } | null;
  selMask: SelectionMask | null;
  selGeom: { kind: "ellipse"; x: number; y: number; w: number; h: number } | { kind: "poly"; pts: [number, number][] } | null;
  scale: number;
  panX: number;
  panY: number;
  autosaveDirty: boolean;
  /** edits not yet saved to a file (drives the tab dot and the close guard) */
  dirty: boolean;
  /** document resolution in dots per inch (metadata only; canvas is always px) */
  dpi?: number;
}
const tabs: DocTab[] = [];
let activeTab = -1;
const tabsBar = document.getElementById("tabs")!;

/** flush editing state (text box / transform / live stroke) that belongs to
 *  the currently active document — called BEFORE any tab switch */
function flushTransient(): void {
  commitText();
  cancelTransform();
  if (strokeSession) {
    const entry = strokeSession.finish(activeLayer.grid, tool === "eraser" ? "Erase" : "Paint");
    strokeSession = null;
    if (entry) pushHist(entry); // pushHist marks the tab dirty for autosave
  }
  // Gesture state belongs to the document that was being edited. Switching
  // documents must not leave a drag, a crop rectangle or a lasso half-open, or
  // the next Enter applies tab A's crop to tab B. closeGesture COMMITS first so
  // a healing stroke the user already drew is not thrown away.
  closeGesture();
  stopAnts();
  drawOverlay();
}

/**
 * Finish whatever gesture is in flight. `endStroke`, tab switching and window
 * blur all need this, and each used to reimplement a subset — the tab-switch copy
 * DISCARDED an uncommitted Spot Healing stroke, and the blur copy left the mask
 * allocated. One implementation, one behaviour.
 */
function closeGesture(): void {
  if (
    healMask || shapeDrag || moveDrag || cropDrag || marqueeing ||
    ellipseDrag || lassoing || gradientDrag || painting
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
  rawCursor = null;
  quickPx = null;
}

/** write the current global state into the active tab's slot */
function captureTab(): void {
  if (activeTab < 0) return;
  const t = tabs[activeTab]!;
  t.doc = doc; t.activeLayer = activeLayer; t.history = history;
  t.flat = flat; t.flatDirty = flatDirty;
  t.selRect = selRect; t.selMask = selMask; t.selGeom = selGeom;
  t.scale = scale; t.panX = panX; t.panY = panY;
  t.autosaveDirty = autosaveDirty;
  t.dirty = docDirty;
}

function activateTab(i: number): void {
  if (i === activeTab) return;
  flushTransient();
  stopAnts();
  captureTab();
  activeTab = i;
  const t = tabs[i]!;
  docDirty = t.dirty;
  doc = t.doc; activeLayer = t.activeLayer; history = t.history;
  flat = t.flat; flatDirty = t.flatDirty;
  selRect = t.selRect; selMask = t.selMask; selGeom = t.selGeom;
  scale = t.scale; panX = t.panX; panY = t.panY;
  autosaveDirty = t.autosaveDirty;
  off.width = doc.width;
  off.height = doc.height;
  render();
  renderLayers();
  renderHistoryPanel();
  renderTabs();
  if (selRect || selMask) startAnts();
}

function closeTab(i: number): void {
  const target = tabs[i];
  if (target && target.dirty) {
    const ask = (globalThis as { confirm?: (m: string) => boolean }).confirm;
    if (typeof ask === "function" && !ask(`“${target.name}” has unsaved changes. Close it anyway?`)) return;
  }
  const wasActive = i === activeTab;
  if (wasActive) {
    flushTransient();
    stopAnts();
    activeTab = -1; // never capture back into a slot we are removing
  }
  tabs.splice(i, 1);
  if (tabs.length === 0) { createUntitledTab(); return; }
  if (wasActive) {
    activateTab(Math.min(i, tabs.length - 1));
  } else {
    if (i < activeTab) activeTab--;
    renderTabs();
  }
}

function renderTabs(): void {
  tabsBar.innerHTML = "";
  tabs.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === activeTab ? " active" : "");
    const label = document.createElement("span");
    label.textContent = (t.dirty ? "• " : "") + t.name;
    label.style.cssText = "overflow:hidden;text-overflow:ellipsis";
    if (t.dirty) el.classList.add("dirty");
    el.appendChild(label);
    const x = document.createElement("span");
    x.className = "close";
    x.innerHTML = iconSvg("close", 12);
    x.title = "Close";
    x.addEventListener("click", (ev) => { ev.stopPropagation(); closeTab(i); });
    el.addEventListener("auxclick", (ev) => { if (ev.button === 1) { ev.preventDefault(); closeTab(i); } });
    el.appendChild(x);
    el.addEventListener("click", () => { if (i !== activeTab) activateTab(i); });
    tabsBar.appendChild(el);
  });
  const plus = document.createElement("button");
  plus.className = "newtab";
  plus.innerHTML = iconSvg("plus", 14);
  plus.title = "New document";
  plus.addEventListener("click", () => createUntitledTab());
  tabsBar.appendChild(plus);
}

function createUntitledTab(): void {
  const nd = new Document(1024, 768);
  nd.addBackground("Background");
  const layer = nd.addLayer("Layer 1");
  replaceDocument(nd, layer, "Untitled");
}

function replaceDocument(newDoc: Document, active?: Layer, name = "Untitled"): void {
  flushTransient();
  stopAnts();
  captureTab(); // keep the outgoing tab's state in its slot
  tabs.push({
    name, doc: newDoc,
    activeLayer: active ?? newDoc.layers[newDoc.layers.length - 1] ?? newDoc.addLayer("Layer 1"),
    history: new History(100),
    flat: new Uint8ClampedArray(newDoc.width * newDoc.height * 4),
    flatDirty: true,
    selRect: null, selMask: null, selGeom: null,
    scale: 1, panX: 0, panY: 0,
    autosaveDirty: true,
    dirty: false,
  });
  hideRecoveryBar();
  activateTab(tabs.length - 1);
  fit();           // new document → zoom to fit
  captureTab();    // persist that view into the tab
  render();
  renderTabs();
}

topButton("file", "New", () => { newDocumentDialog(); }, "file-plus");

/** Open a real Photoshop file via the vendored ag-psd UMD bundle
 *  (loaded as a classic script in index.html → globalThis.agPsd). */
async function openPsdFile(file: File): Promise<void> {
  const ag = (globalThis as { agPsd?: { readPsd: (buf: ArrayBuffer, options?: { useImageData?: boolean }) => PsdLike } }).agPsd;
  if (!ag) {
    window.alert("PSD support library (ag-psd) is not loaded.");
    return;
  }
  let psd: PsdLike;
  try {
    psd = ag.readPsd(await file.arrayBuffer(), { useImageData: true });
    replaceDocument(psdToDocument(psd), undefined, file.name.replace(/\.[^.]+$/, "") || "PSD");
  } catch (err) {
    window.alert(`Could not open ${file.name}:\n${err instanceof Error ? err.message : String(err)}`);
    statusHint("PSD import failed — the file was not changed");
  }
}

topButton("file", "Open Image…", async () => {
  const file = await askFile("image/png,image/jpeg,image/webp,image/gif,.psd,image/vnd.adobe.photoshop");
  if (!file) return;
  try {
    if (/\.psd$/i.test(file.name)) {
      await openPsdFile(file);
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
    console.error("open image failed", err);
    window.alert(`Could not open "${file.name}": ${err instanceof Error ? err.message : String(err)}`);
  }
});

topButton("file", "Open Project…", async () => {
  const file = await askFile(".json,application/json");
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const nd = deserializeProject(json);
    const name = (json as { name?: unknown }).name;
    replaceDocument(nd, undefined, (typeof name === "string" && name) || file.name.replace(/\.[^.]+$/, "") || "Project");
  } catch (err) {
    window.alert(`Could not open ${file.name}:\n${err instanceof Error ? err.message : String(err)}`);
    statusHint("Project open failed — the file was not changed");
  }
});

topButton("file", "Save Project", () => {
  const tname = tabs[activeTab]?.name ?? "untitled";
  const json = serializeProject(doc, tname);
  download(`${tname.replace(/[\\/:*?"<>|]/g, "_")}.pigment.json`, new Blob([JSON.stringify(json)], { type: "application/json" }));

  // the file exists now: clear the unsaved marker for this tab
  docDirty = false;
  const savedTab = tabs[activeTab];
  if (savedTab) savedTab.dirty = false;
  renderTabs();
  updateStatus();
});

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
    defaultName: () => tabs[activeTab]?.name ?? "untitled",
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
    if (b) download(safe, b);
    else window.alert(`The ${req.format.toUpperCase()} encoder refused this document. Try PNG.`);
  }, mime, quality);
}

/** PSD export: layers with names/opacity/visibility/blend modes where possible. */
function writePsdBlob(filename: string): void {
  const ag = (globalThis as {
    agPsd?: { writePsd?: (psd: unknown, opts?: { generateThumbnail?: boolean }) => ArrayBuffer };
  }).agPsd;
  if (!ag?.writePsd) {
    window.alert("PSD writing is unavailable (the ag-psd bundle did not expose writePsd).");
    return;
  }
  const hasNonPixel = doc.layers.some((l) => l.kind !== "pixel");
  const psd = buildPsd(doc);
  if (hasNonPixel) {
    // Adjustment and fill layers have no pixel buffer PSD can carry from us, so a
    // document containing them exports as one flattened composite layer rather
    // than silently losing the adjustment.
    psd.children = [{
      name: tabs[activeTab]?.name ?? "Composite",
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
    download(filename, new Blob([buf], { type: "image/vnd.adobe.photoshop" }));
  } catch (err) {
    console.error("psd export failed", err);
    window.alert(`PSD export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- image/canvas resize -----------------------------------------------------

/** install a document into the current tab WITHOUT touching the history */
function installDoc(nd: Document, layerIdx: number): void {
  const t = tabs[activeTab];
  if (t) t.autosaveDirty = true;
  doc = nd;
  off.width = nd.width;
  off.height = nd.height;
  flat = new Uint8ClampedArray(nd.width * nd.height * 4);
  flatDirty = true;
  selRect = null; selMask = null; selGeom = null;
  activeLayer = nd.layers[Math.min(Math.max(0, layerIdx), nd.layers.length - 1)] ?? nd.layers[0]!;
}

/** swap in a new Document for the CURRENT tab as a REVIEWABLE edit: the old
 *  document is kept alive by the undo entry, so Crop/Rotate/Trim/Resize stay
 *  undoable instead of silently emptying the History panel */
function setDocInTab(nd: Document, label = "Reshape"): void {
  flushTransient();
  stopAnts();
  const prevDoc = doc;
  const prevIdx = Math.max(0, prevDoc.layers.indexOf(activeLayer));
  const nextIdx = Math.max(0, prevIdx);
  installDoc(nd, nextIdx);
  const nextActiveIdx = Math.max(0, nd.layers.indexOf(activeLayer));
  pushHist({
    label,
    undo: () => {
      installDoc(prevDoc, prevIdx);
      flatDirty = true;
      render();
      renderLayers();
      drawOverlay();
    },
    redo: () => {
      installDoc(nd, nextActiveIdx);
      flatDirty = true;
      render();
      renderLayers();
      drawOverlay();
    },
  });
  fit();
  render(); renderLayers(); renderHistoryPanel(); drawOverlay();
}

/** small modal helper: dark overlay, title, body, OK/Cancel; Esc closes */
function showModal(title: string, body: HTMLElement, onOk: () => void): void {
  // Appended to <body>, not #canvas-host: an absolute overlay inside the canvas
  // column left the panels clickable while a "modal" was open.
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const panel = document.createElement("div");
  panel.className = "modal";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", title);
  const h = document.createElement("h3");
  h.textContent = title;
  panel.appendChild(h);
  panel.appendChild(body);
  const row = document.createElement("div");
  row.className = "foot";
  const cancel = document.createElement("button");
  cancel.className = "btn subtle";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "btn primary";
  ok.textContent = "OK";
  row.append(cancel, ok);
  panel.appendChild(row);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  modalCount++;
  const firstField = body.querySelector<HTMLElement>("input, select, textarea, button");
  firstField?.focus();
  const close = () => {
    overlay.remove();
    modalCount = Math.max(0, modalCount - 1);
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { ev.stopPropagation(); close(); }
    if (ev.key === "Enter") {
      const t = ev.target as HTMLElement | null;
      if (t instanceof HTMLTextAreaElement || t?.tagName === "BUTTON") return;
      ev.preventDefault();
      close();
      onOk();
    }
  };
  window.addEventListener("keydown", onKey, true);
  cancel.addEventListener("click", close);
  ok.addEventListener("click", () => { close(); onOk(); });
}

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

function toolButton(icon: IconName, title: string, cb: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tool";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = iconSvg(icon, 19);
  b.addEventListener("click", cb);
  toolbar.appendChild(b);
  return b;
}

/** thin divider between toolbar groups */
function toolSeparator(): void {
  const sep = document.createElement("div");
  sep.className = "tool-sep";
  toolbar.appendChild(sep);
}

const moveBtn = toolButton("move", "Move (V) — drag the layer, arrows nudge", () => { tool = "move"; highlight(); });
const marqueeBtn = toolButton("marquee", "Rectangular Marquee (M)", () => { tool = "marquee"; highlight(); });
const ellipseBtn = toolButton("ellipse", "Elliptical Marquee (M)", () => { tool = "ellipse"; highlight(); });
const lassoBtn = toolButton("lasso", "Lasso (L)", () => { tool = "lasso"; highlight(); });
const wandBtn = toolButton("wand", "Magic Wand (W) — click to select similar pixels", () => { tool = "wand"; highlight(); });
const quickBtn = toolButton("wand", "Quick Selection (W) — paint to select similar pixels", () => { tool = "quick"; highlight(); });
const shapeBtn = toolButton("frame", "Shape (U) — drag to draw a shape", () => { tool = "shape"; highlight(); });
const cropBtn = toolButton("crop", "Crop (C) — drag, then Enter", () => { tool = "crop"; highlight(); });
toolSeparator();
const brushBtn = toolButton("brush", "Brush (B)", () => { tool = "brush"; highlight(); });
const eraserBtn = toolButton("eraser", "Eraser (E)", () => { tool = "eraser"; highlight(); });
const gradientBtn = toolButton("gradient", "Gradient (G)", () => { tool = "gradient"; highlight(); });
const bucketBtn = toolButton("bucket", "Paint Bucket (Shift+G) — click to fill an area", () => { tool = "bucket"; highlight(); });
const healBtn = toolButton("bandage", "Spot Healing Brush (J) — paint over a blemish to rebuild it", () => { tool = "heal"; highlight(); });
toolSeparator();
const eyedropperBtn = toolButton("eyedropper", "Eyedropper (I) — click to sample a colour", () => { tool = "eyedropper"; highlight(); });
const retouchBtn = toolButton("dodge", "Dodge / Burn / Sponge (O)", () => { tool = "retouch"; highlight(); });
const cloneBtn = toolButton("stamp", "Clone Stamp (S) — Alt-click sets the source", () => { tool = "clone"; highlight(); });
const focusBtn = toolButton("blur", "Blur / Sharpen / Smudge (Shift+S)", () => { tool = "focus"; highlight(); });
toolSeparator();
const textBtn = toolButton("text", "Text (T)", () => { tool = "text"; highlight(); });
// free transform is a MODE, not a persistent tool: clicking the button while
// a transform is active commits it (Apply), otherwise it enters transform mode
const transformToolBtn = toolButton("transform", "Free Transform (Ctrl+T)", () => {
  if (transform) applyTransform(); else enterTransform();
});
const TOOL_BTN: Record<ToolId, HTMLButtonElement> = {
  brush: brushBtn, eraser: eraserBtn, marquee: marqueeBtn,
  ellipse: ellipseBtn, lasso: lassoBtn, gradient: gradientBtn, text: textBtn,
  move: moveBtn, crop: cropBtn, wand: wandBtn, quick: quickBtn, bucket: bucketBtn,
  shape: shapeBtn,
  heal: healBtn,
  eyedropper: eyedropperBtn, retouch: retouchBtn, clone: cloneBtn, focus: focusBtn,
};
/** The pointer must say what will happen: ring tools hide the OS cursor. */
function syncCursor(): void {
  if (panning) { host.style.cursor = "grabbing"; return; }
  if (panSticky) { host.style.cursor = "grab"; return; }
  if (spaceDown) { host.style.cursor = "grab"; return; }
  if (transform) { host.style.cursor = "move"; return; }
  if (tool === "move") { host.style.cursor = "move"; return; }
  if (tool === "text") { host.style.cursor = "text"; return; }
  if (tool === "crop" || tool === "gradient") { host.style.cursor = "crosshair"; return; }
  // brush-family tools draw their own ring on the overlay
  host.style.cursor = BRUSH_TOOLS.has(tool) ? "none" : "crosshair";
}

function highlight(): void {
  if (transform) { applyTransform(); return; } // tool switch commits, Photoshop-style
  if (tool !== "text") commitText(); // leaving the text tool commits any live box
  for (const b of Object.values(TOOL_BTN)) b.classList.remove("active");
  TOOL_BTN[tool].classList.add("active");
  syncCursor();
  refreshOptions();
}
highlight();

// ---- shared foreground color (left toolbar: brush + text use this) ---------
const colorWell = document.createElement("input");
colorWell.type = "color";
colorWell.title = "Foreground color (brush + text)";
colorWell.value = `#${color.map(c => c.toString(16).padStart(2, "0")).join("")}`;
colorWell.style.margin = "8px auto 0";
colorWell.addEventListener("input", () => {
  color[0] = parseInt(colorWell.value.slice(1, 3), 16);
  color[1] = parseInt(colorWell.value.slice(3, 5), 16);
  color[2] = parseInt(colorWell.value.slice(5, 7), 16);
  restyleTextEditor(); // a live text box follows the color change
});
toolbar.appendChild(colorWell);
toolbar.appendChild(toolbarSizeBtn);
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

function refreshOptions(): void {
  optionsBar.innerHTML = "";
  // the toolbar transform button shows an active state while a transform is live
  transformToolBtn.classList.toggle("active", !!transform);
  // Quick Mask and mask painting recolour the whole bar: the mode matters
  if (quickMask) {
    const tag = document.createElement("span");
    tag.className = "label";
    tag.textContent = "Quick Mask — the brush edits the selection";
    const hint = document.createElement("span");
    hint.className = "label";
    hint.style.opacity = ".6";
    hint.textContent = "dark protects · white selects · Q to leave";
    const exit = document.createElement("button");
    exit.className = "btn subtle";
    exit.textContent = "Exit (Q)";
    exit.addEventListener("click", () => toggleQuickMask());
    optionsBar.append(tag, hint, exit);
    return;
  }
  if (paintTarget === "mask" && activeLayer.mask) {
    const tag = document.createElement("span");
    tag.className = "label";
    tag.textContent = `Editing the mask of “${activeLayer.name}”`;
    const hint = document.createElement("span");
    hint.className = "label";
    hint.style.opacity = ".6";
    hint.textContent = "dark hides · light reveals";
    const done = document.createElement("button");
    done.className = "btn subtle";
    done.textContent = "Back to pixels";
    done.addEventListener("click", () => { paintTarget = "pixel"; renderLayers(); refreshOptions(); });
    optionsBar.append(tag, hint, done);
    return;
  }
  if (transform) {
    const t = transform;
    const readout = document.createElement("span");
    readout.className = "value";
    readout.style.minWidth = "0";
    t.readout = readout;
    readout.textContent = transformReadout(t);
    const apply = document.createElement("button");
    apply.className = "btn primary";
    apply.textContent = "Apply";
    apply.addEventListener("click", applyTransform);
    const cancel = document.createElement("button");
    cancel.className = "btn subtle";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", cancelTransform);
    optionsBar.append(readout, apply, cancel);
    return;
  }
  if (tool === "move") {
    const hint = document.createElement("span");
    hint.textContent = selMask || selRect
      ? "Drag to move the selection's pixels · arrows nudge (Shift = 10px)"
      : "Drag to move the active layer · arrows nudge (Shift = 10px)";
    hint.className = "label";
    optionsBar.appendChild(hint);
    return;
  }
  if (tool === "wand") {
    optionsBar.appendChild(optionSlider("Tolerance", 0, 255, wandTolerance, (v) => String(v), (v) => { wandTolerance = v; }));
    optionsBar.appendChild(optionCheck("Contiguous", wandContiguous, (v) => { wandContiguous = v; }));
    const whint = document.createElement("span");
    whint.className = "label";
    whint.textContent = "Click to select similar pixels · Shift-click adds · Alt-click subtracts";
    optionsBar.appendChild(whint);
    return;
  }
  if (tool === "shape") {
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
    return;
  }
  if (tool === "quick") {
    optionsBar.appendChild(optionSlider("Tolerance", 0, 255, quickTolerance, (v) => String(v), (v) => {
      quickTolerance = v;
    }));
    const qhint = document.createElement("span");
    qhint.className = "label";
    qhint.textContent = "Paint to select similar pixels · keep painting to grow the selection";
    optionsBar.appendChild(qhint);
    return;
  }
  if (tool === "bucket") {
    optionsBar.appendChild(optionSlider("Tolerance", 0, 255, bucketTolerance, (v) => String(v), (v) => { bucketTolerance = v; }));
    optionsBar.appendChild(optionSlider("Opacity", 1, 100, Math.round(bucketOpacity * 100), (v) => `${v}%`, (v) => { bucketOpacity = v / 100; }));
    optionsBar.appendChild(optionCheck("Contiguous", bucketContiguous, (v) => { bucketContiguous = v; }));
    const bhint = document.createElement("span");
    bhint.className = "label";
    bhint.textContent = "Click to fill with the foreground colour";
    optionsBar.appendChild(bhint);
    return;
  }
  if (tool === "eyedropper") {
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
    return;
  }
  if (tool === "retouch") {
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
    return;
  }
  if (tool === "clone") {
    const chint = document.createElement("span");
    chint.className = "label";
    chint.textContent = cloneSrc
      ? "Alt-click to re-sample · drag to clone"
      : "Alt-click to set the clone source first";
    optionsBar.appendChild(chint);
    optionsBar.appendChild(optionSlider("Size", 1, 300, brushSize, (v) => `${v}px`, (v) => { brushSize = v; }));
    optionsBar.appendChild(optionSlider("Opacity", 1, 100, Math.round(cloneAlpha * 100), (v) => `${v}%`, (v) => { cloneAlpha = v / 100; }));
    optionsBar.appendChild(optionCheck("Aligned", cloneAligned, (v) => { cloneAligned = v; if (!v) cloneOffset = null; }));
    return;
  }
  if (tool === "focus") {
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
    return;
  }
  if (tool === "heal") {
    const hh = document.createElement("span");
    hh.className = "label";
    hh.textContent = "Paint over the blemish — the area is rebuilt from its surroundings · J";
    optionsBar.appendChild(hh);
    optionsBar.appendChild(optionSlider("Size", 1, 300, brushSize, (v) => `${v}px`, (v) => { brushSize = v; }));
    optionsBar.appendChild(optionSlider("Hardness", 0, 100, Math.round(brushHardness * 100), (v) => `${v}%`, (v) => { brushHardness = v / 100; }));
    return;
  }
  if (tool === "crop") {
    const hint = document.createElement("span");
    hint.textContent = cropRect
      ? `Crop to ${cropRect.w} × ${cropRect.h} · Enter applies · Esc cancels`
      : "Drag a crop rectangle · Enter applies · Esc cancels";
    hint.className = "label";
    optionsBar.appendChild(hint);
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
    return;
  }
  if (tool === "marquee" || tool === "ellipse" || tool === "lasso") {
    const hint = document.createElement("span");
    hint.textContent = "Drag to select · click to deselect · Ctrl+D deselect · Del clears selection";
    hint.className = "label";
    optionsBar.appendChild(hint);
    return;
  }
  if (tool === "gradient") {
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
    return;
  }
  if (tool === "text") {
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
    optionsBar.appendChild(optionSlider("Size", 8, 200, textSize, v => `${v}px`, v => { textSize = v; restyleTextEditor(); }));
    return;
  }
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

const THUMB_W = 26;
const THUMB_H = 20;

/**
 * A coarse mosaic of the layer: one flat colour per allocated 256px tile.
 * Sampling every pixel would mean a full readRect per layer on every edit,
 * which is exactly the cost we removed from compositing.
 */
function layerThumb(layer: Layer): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = THUMB_W;
  cv.height = THUMB_H;
  cv.className = "thumb";
  const c2 = cv.getContext("2d");
  if (!c2) return cv;
  const cols = Math.max(1, Math.ceil(doc.width / TILE));
  const rows = Math.max(1, Math.ceil(doc.height / TILE));
  const bw = THUMB_W / cols;
  const bh = THUMB_H / rows;
  const mid = ((TILE >> 1) * TILE + (TILE >> 1)) * 4;
  if (layer.kind === "pixel") {
    layer.grid.forEachTile((t, tx, ty) => {
      const d = t.data;
      if (d[mid + 3] === 0) return;
      c2.fillStyle = `rgba(${d[mid]},${d[mid + 1]},${d[mid + 2]},${(d[mid + 3] ?? 0) / 255})`;
      c2.fillRect(tx * bw, ty * bh, Math.ceil(bw), Math.ceil(bh));
    });
  } else {
    c2.fillStyle = layer.kind === "adjust" ? "rgba(127,178,255,.55)" : "rgba(255,255,255,.28)";
    c2.fillRect(0, 0, THUMB_W, THUMB_H);
  }
  if (layer.mask) {
    // a chip in the corner, so a masked layer is readable at a glance
    c2.fillStyle = "rgba(255,255,255,.85)";
    c2.fillRect(0, THUMB_H - 3, 3, 3);
  }
  return cv;
}

/** flat-group tints; a group is only a colour band, never a nested stack */
const GROUP_COLOURS = ["#5b8cff", "#f2b33d", "#4ec98b", "#e0645c", "#a877f0", "#3dc3d4"];
const groupColour = (id: string): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GROUP_COLOURS[h % GROUP_COLOURS.length]!;
};

/** G1..G6 then none — fixed ids, so adjacent layers band together by construction */
function nextGroupId(current?: string): string | undefined {
  if (!current) return "G1";
  const n = Number(current.slice(1));
  if (Number.isFinite(n) && n >= 1 && n < GROUP_COLOURS.length) return `G${n + 1}`;
  return undefined;
}

function renderLayers(): void {
  const keepScroll = layersBody.scrollTop;
  layersBody.innerHTML = "";

  // ---- active-layer properties (blend mode + opacity, both undoable) ----
  const props = document.createElement("div");
  props.className = "stack";

  const blendRow = document.createElement("div");
  blendRow.className = "inline-row";
  const blendLab = document.createElement("span");
  blendLab.textContent = "Blend";
  blendLab.className = "label";
  blendLab.style.width = "42px";
  const blend = document.createElement("select");
  for (const m of LAYER_BLEND_MODES) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m.replace(/-/g, " ").replace(/^\w|\s\w/g, s => s.toUpperCase());
    blend.appendChild(o);
  }
  blend.value = activeLayer.blendMode;
  blend.style.cssText = "flex:1;min-width:0";
  blend.addEventListener("change", () => {
    const layer = activeLayer; // captured: undo must target this layer, not whatever is active later
    const before = layer.blendMode;
    const after = blend.value as BlendMode;
    layer.blendMode = after;
    pushHist(propertyCommand(
      `Blend ${before} → ${after}`,
      (v) => { layer.blendMode = v as BlendMode; flatDirty = true; },
      before, after,
    ));
    flatDirty = true; render(); renderHistoryPanel();
  });
  blendRow.append(blendLab, blend);
  props.appendChild(blendRow);

  const opRow = document.createElement("div");
  opRow.className = "inline-row";
  const opLab = document.createElement("span");
  opLab.textContent = "Opacity";
  opLab.className = "label";
  opLab.style.width = "42px";
  const opRange = document.createElement("input");
  opRange.type = "range";
  opRange.min = "0"; opRange.max = "100";
  opRange.value = String(Math.round(activeLayer.opacity * 100));
  opRange.style.flex = "1";
  const opVal = document.createElement("span");
  opVal.textContent = `${Math.round(activeLayer.opacity * 100)}%`;
  opVal.className = "value";
  // captured once: a tab switch mid-drag must not retarget the edit
  const opLayer = activeLayer;
  let before: number | null = null;
  opRange.addEventListener("pointerdown", () => { before = opLayer.opacity; });
  opRange.addEventListener("input", () => {
    // keyboard arrows fire input/change without pointerdown, so seed lazily
    if (before === null) before = opLayer.opacity;
    opLayer.opacity = Number(opRange.value) / 100;
    opVal.textContent = `${Number(opRange.value)}%`;
    flatDirty = true; render();
  });
  opRange.addEventListener("change", () => {
    // a keyboard edit never saw pointerdown, so fall back to the layer's value
    const b = before ?? opLayer.opacity;
    before = null;
    const layer = opLayer; // captured: undo must target this layer
    const a = layer.opacity;
    if (a === b) return;
    pushHist(propertyCommand(
      `Opacity ${Math.round(a * 100)}%`,
      (v) => { layer.opacity = v as number; flatDirty = true; },
      b, a,
    ));
    renderHistoryPanel();
  });
  opRow.append(opLab, opRange, opVal);
  props.appendChild(opRow);

  // ---- paint target: the pixels or the layer mask ------------------------
  if (activeLayer.mask) {
    const tRow = document.createElement("div");
    tRow.className = "inline-row";
    const tLab = document.createElement("span");
    tLab.className = "label";
    tLab.textContent = "Edit";
    tLab.style.width = "42px";
    const mk = (label: string, target: "pixel" | "mask"): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "btn subtle" + (paintTarget === target ? " primary" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        paintTarget = target;
        renderLayers();
        refreshOptions();
      });
      return b;
    };
    const applyBtn = document.createElement("button");
    applyBtn.className = "btn subtle";
    applyBtn.textContent = "Apply";
    applyBtn.title = "Bake the mask into the pixels and drop it";
    applyBtn.addEventListener("click", () => applyLayerMaskNow());
    const delBtn = document.createElement("button");
    delBtn.className = "btn subtle icon";
    setIcon(delBtn, "trash", 13);
    delBtn.title = "Delete the mask";
    delBtn.addEventListener("click", () => deleteLayerMask());
    tRow.append(tLab, mk("Pixels", "pixel"), mk("Mask", "mask"), applyBtn, delBtn);
    props.appendChild(tRow);
  }
  layersBody.appendChild(props);

  // ---- layer rows (topmost first) ----------------------------------------
  for (const layer of [...doc.layers].reverse()) {
    const row = document.createElement("div");
    const idx = doc.layers.indexOf(layer);
    const above = doc.layers[idx + 1];
    row.className = "row" + (layer === activeLayer ? " active" : "")
      + (layer.clipToBelow ? " clipped" : "")
      + (above && above.clipToBelow ? " clip-base" : "");
    row.title = layer.name + (layer.clipToBelow ? " (clipped to the layer below)" : "");
    if (layer.groupId) {
      const tint = groupColour(layer.groupId);
      row.style.borderLeft = `3px solid ${tint}`;
      row.style.background = `${tint}1f`;
    }
    const vis = document.createElement("span");
    vis.className = "eye" + (layer.visible ? "" : " off");
    vis.innerHTML = iconSvg(layer.visible ? "eye" : "eye-off", 14);
    vis.title = layer.visible ? "Hide layer" : "Show layer";
    vis.addEventListener("click", (e) => {
      e.stopPropagation();
      const before = layer.visible;
      layer.visible = !before;
      pushHist(propertyCommand(
        `Visibility ${layer.name}`,
        (v) => { layer.visible = v as boolean; flatDirty = true; },
        before, layer.visible,
      ));
      flatDirty = true; renderLayers(); render(); renderHistoryPanel();
    });
    row.appendChild(vis);
    row.appendChild(layerThumb(layer));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layer.name;
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation(); // keep the row click from stealing the rename
      if (layer.kind !== "pixel" && layer.kind !== "adjust" && layer.kind !== "fill") return;
      const box = document.createElement("input");
      box.type = "text";
      box.className = "rename";
      box.value = layer.name;
      const commit = (): void => {
        const next = box.value.trim() || layer.name;
        if (next !== layer.name) {
          const before = layer.name;
          layer.name = next;
          pushHist(propertyCommand(`Rename ${before} → ${next}`,
            (v) => { layer.name = v as string; },
            before, next));
          renderHistoryPanel();
        }
        renderLayers();
      };
      box.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        if (ev.key === "Escape") { ev.preventDefault(); renderLayers(); }
      });
      box.addEventListener("blur", commit);
      name.replaceWith(box);
      box.focus();
      box.select();
    });
    row.appendChild(name);
    const lockBtn = document.createElement("span");
    lockBtn.className = "lockbtn" + (layer.locked ? " on" : "");
    lockBtn.innerHTML = iconSvg(layer.locked ? "lock" : "unlock", 12);
    lockBtn.title = layer.locked ? "Unlock layer" : "Lock layer (blocks painting and moving)";
    lockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const before = !layer.locked;
      layer.locked = before;
      pushHist(propertyCommand(
        `${before ? "Lock" : "Unlock"} ${layer.name}`,
        (v) => { layer.locked = v as boolean; },
        !before, before,
      ));
      renderLayers();
      renderHistoryPanel();
    });
    row.appendChild(lockBtn);
    const gchip = document.createElement("span");
    gchip.className = "groupchip" + (layer.groupId ? " on" : "");
    gchip.textContent = layer.groupId ? layer.groupId : "+";
    gchip.title = layer.groupId
      ? `Group ${layer.groupId} — click to cycle, Shift-click to leave the group`
      : "Put this layer in a colour group (visual only — the stack stays flat)";
    if (layer.groupId) gchip.style.color = groupColour(layer.groupId);
    gchip.addEventListener("click", (e) => {
      e.stopPropagation();
      const before = layer.groupId;
      const nextId = e.shiftKey ? undefined : nextGroupId(before);
      layer.groupId = nextId;
      pushHist(propertyCommand(
        nextId ? `Group ${layer.name} as ${nextId}` : `Leave group ${before ?? ""}`.trim(),
        (v) => { layer.groupId = v as string | undefined; },
        before, nextId,
      ));
      renderLayers();
      renderHistoryPanel();
    });
    row.appendChild(gchip);
    if (layer.kind !== "pixel") {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = layer.kind === "adjust" ? "adj" : "fill";
      badge.title = layer.kind === "adjust" ? "Adjustment layer" : "Fill layer";
      row.appendChild(badge);
    }
    if (layer.mask) {
      const chip = document.createElement("span");
      chip.className = "maskchip" + (layer === activeLayer && paintTarget === "mask" ? " active" : "");
      chip.innerHTML = iconSvg("mask", 12);
      chip.title = "Layer mask — click to paint on it";
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        activeLayer = layer;
        paintTarget = "mask";
        renderLayers();
        refreshOptions();
      });
      row.appendChild(chip);
    }
    row.addEventListener("click", () => {
      activeLayer = layer;
      if (paintTarget === "mask" && !layer.mask) paintTarget = "pixel";
      renderLayers();
      refreshOptions();
    });
    layersBody.appendChild(row);
  }
  // ---- panel-bottom action strip (Photoshop-style) ------------------------
  // renderLayers() runs on every edit, so the strip must be rebuilt, not appended to
  layersStrip.innerHTML = "";
  const stripBtn = (ic: IconName, title: string, cb: () => void): void => {
    const b = document.createElement("button");
    b.className = "btn icon subtle";
    b.title = title;
    b.setAttribute("aria-label", title);
    setIcon(b, ic, 15);
    b.addEventListener("click", cb);
    layersStrip.appendChild(b);
  };
  stripBtn("plus", "New layer (top)", addNewLayer);
  stripBtn("arrow-up", "Move layer up", () => {
    const idx = doc.layers.indexOf(activeLayer);
    const to = Math.min(doc.layers.length - 1, idx + 1);
    if (to === idx) return;
    doc.moveLayer(activeLayer, to);
    pushHist(layerMoveCommand(doc, activeLayer, idx, to));
    flatDirty = true; renderLayers(); render(); renderHistoryPanel();
  });
  stripBtn("arrow-down", "Move layer down", () => {
    const idx = doc.layers.indexOf(activeLayer);
    const to = Math.max(0, idx - 1);
    if (to === idx) return;
    doc.moveLayer(activeLayer, to);
    pushHist(layerMoveCommand(doc, activeLayer, idx, to));
    flatDirty = true; renderLayers(); render(); renderHistoryPanel();
  });
  stripBtn("copy", "Duplicate layer", duplicateActiveLayer);
  stripBtn("transform", "Free Transform (Ctrl+T)", () => {
    if (transform) cancelTransform(); // never carry a live transform onto new pixels
    enterTransform();
  });
  stripBtn("mask", activeLayer.mask ? "Mask — apply, load or delete (Alt-click deletes)" : "Add layer mask",
    () => {
      if (!activeLayer.mask) { addLayerMaskFromSelection(); return; }
      // mask exists: add-selection-to-mask when a selection is live, else load it
      if (selMask) addLayerMaskFromSelection();
      else loadMaskAsSelection();
    });
  stripBtn("sliders", "New adjustment layer", () => { addAdjustmentLayer(); });
  stripBtn("target", activeLayer.clipToBelow ? "Clipped to layer below (click to unclip)" : "Clip to layer below",
    () => {
      const layer = activeLayer;
      const before = !!layer.clipToBelow;
      layer.clipToBelow = !before;
      pushHist(propertyCommand(
        `${before ? "Unclip" : "Clip"} ${layer.name}`,
        (v) => { layer.clipToBelow = v as boolean; flatDirty = true; },
        before, layer.clipToBelow,
      ));
      flatDirty = true;
      renderLayers(); render(); renderHistoryPanel();
    });
  stripBtn("merge", "Merge Down (Ctrl+E)", () => { mergeDown(); });
  stripBtn("flatten", "Flatten Image", () => { flattenImage(); });
  stripBtn("trash", "Delete layer", deleteActiveLayer);
  layersBody.scrollTop = keepScroll;
}

/** history panel: one row per entry; applied (past) bright, future dimmed;
 *  click a row to jump to that state */
function renderHistoryPanel(): void {
  const labels = history.labels;
  const pos = history.position;
  const el = historyBody;
  // stick to the newest step unless the user scrolled up to inspect older ones
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  el.innerHTML = "";
  if (labels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "label";
    empty.style.padding = "6px 9px";
    empty.textContent = "No actions yet";
    el.appendChild(empty);
    return;
  }
  labels.forEach((label, k) => {
    const row = document.createElement("div");
    row.className = "hist-row" + (k >= pos ? " future" : "") + (k === pos - 1 ? " current" : "");
    row.textContent = label;
    row.title = label;
    row.addEventListener("click", () => { history.jumpTo(k + 1); applyHistoryChange(); });
    el.appendChild(row);
  });
  if (atBottom) el.scrollTop = el.scrollHeight;
  updateStatus();
}

function applyHistoryChange(): void {
  markDirty();
  flatDirty = true;
  autosaveDirty = true;
  if (!doc.layers.includes(activeLayer)) {
    activeLayer = doc.layers[doc.layers.length - 1] ?? activeLayer;
  }
  render(); renderLayers(); renderHistoryPanel();
}

// ---- keyboard shortcuts --------------------------------------------------
window.addEventListener("keydown", (e) => {
  // A dialog, the text editor or any form field owns its own keystrokes:
  // without this, typing "b" in a Width field switched tools and Backspace
  // erased pixels behind the modal.
  // A dialog owns the keyboard while it is open (Escape/Enter are handled by it).
  if (modalCount > 0) return;
  const kt = e.target as HTMLElement | null;
  if (kt && (kt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(kt.tagName))) return;
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
    const k = e.key.toLowerCase();
    if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) { if (history.redo()) applyHistoryChange(); }
      else if (history.undo()) applyHistoryChange();
    } else if (k === "y") {
      e.preventDefault();
      if (history.redo()) applyHistoryChange();
    } else if (k === "d") {
      e.preventDefault();
      deselect();
    } else if (k === "t") {
      e.preventDefault();
      enterTransform();
    } else if (k === "e") {
      e.preventDefault();
      if (e.shiftKey) runTop("Export As…"); else mergeDown();
    } else if (k === "a") {
      e.preventDefault();
      selectAll();
    } else if (k === "i" && e.shiftKey) {
      e.preventDefault();
      invertSelection();
    } else if (k === "j") {
      e.preventDefault();
      duplicateActiveLayer();
    } else if (k === "n" && e.shiftKey) {
      e.preventDefault();
      addNewLayer();
    } else if (k === "n") {
      e.preventDefault();
      newDocumentDialog();
    } else if (k === "o" && e.shiftKey) {
      e.preventDefault();
      runTop("Open Project…");
    } else if (k === "o") {
      e.preventDefault();
      runTop("Open Image…");
    } else if (k === "s") {
      e.preventDefault();
      runTop("Save Project");
    } else if (k === "w") {
      e.preventDefault();
      closeTab(activeTab);
    } else if (k === "0") {
      e.preventDefault();
      fit();
    } else if (k === "1") {
      e.preventDefault();
      actualPixels();
    } else if (k === "=" || k === "+") {
      e.preventDefault();
      zoomBy(1.25);
    } else if (k === "-") {
      e.preventDefault();
      zoomBy(1 / 1.25);
    }
    return;
  }
  if (e.key === "b" || e.key === "B") { tool = "brush"; highlight(); }
  else if (e.key === "e" || e.key === "E") { tool = "eraser"; highlight(); }
  else if (e.key === "m" || e.key === "M") { tool = tool === "marquee" ? "ellipse" : "marquee"; highlight(); }
  else if (e.key === "l" || e.key === "L") { tool = "lasso"; highlight(); }
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
  else if (e.key === "Enter" && cropRect) { applyCropNow(); }
  else if (e.key === "Escape") {
    if (shapeDrag) { shapeDrag = null; drawOverlay(); return; }
    if (cropRect) { cancelCrop(); return; }
    gradientDrag = false;
    commitText();
    deselect();
  }
  else if (tool === "move" && e.key.startsWith("Arrow")) {
    // Photoshop nudges the active layer: 1px, or 10px with Shift
    const step = e.shiftKey ? 10 : 1;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const v = d[e.key];
    if (v) { e.preventDefault(); nudgeActive(v[0], v[1]); }
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
  render();
  renderHistoryPanel();
});

adjRow.appendChild(adjSel);
adjRow.appendChild(adjSlider);
adjRow.appendChild(adjVal);
adjRow.appendChild(adjApply);
syncAdjUI();


// ---- tonal panel (Levels/Curves/exposure/… + histogram) -------------------
const tonalPanel = buildTonalPanel({
  panels,
  cardHead: (box, icon, title) => { const el = cardHead(box, icon, title); return el; },
  showModal: (title, body, onOk) => showModal(title, body, () => { onOk(); tonalPanel.refreshHistogram(); }),
  targetRect: () => {
    const rect = selectionRect();
    return rect.w > 0 && rect.h > 0 ? rect : null;
  },
  targetMask: () => selMask,
  hasSelection: () => !!(selRect || selMask),
  activeGrid: () => (activeLayer.locked ? null : activeLayer.grid),
  docSize: () => ({ w: doc.width, h: doc.height }),
  run: (label, fn) => {
    if (activeLayer.locked) return;
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
  },
  foreground: () => [color[0], color[1], color[2]],
  pulse: (el) => pulse(el),
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
  /** apply to `rect` with the slider value as the main parameter */
  run: (rect: F2Rect, v: number, mask?: PixelMask) => void;
}

const FILTERS: FilterSpec[] = [
  {
    id: "blur", group: "Blur", label: "Gaussian Blur", min: 1, max: 25, def: 4,
    fmt: (v) => `σ${v}`,
    run: (r, v, m) => applyFilter(activeLayer.grid, r.x, r.y, r.w, r.h, { kind: "blur", amount: v }, m),
  },
  {
    id: "motion", group: "Blur", label: "Motion Blur", min: 1, max: 60, def: 12,
    fmt: (v) => `${v}px`,
    run: (r, v, m) => f2.motionBlur(activeLayer.grid, r, 0, v, m),
  },
  {
    id: "radial-zoom", group: "Blur", label: "Radial Blur (zoom)", min: 1, max: 100, def: 30,
    fmt: (v) => `${v}`,
    run: (r, v) => f2.radialBlur(activeLayer.grid, r, v, "zoom"),
  },
  {
    id: "radial-spin", group: "Blur", label: "Radial Blur (spin)", min: 1, max: 100, def: 20,
    fmt: (v) => `${v}`,
    run: (r, v) => f2.radialBlur(activeLayer.grid, r, v, "spin"),
  },
  {
    id: "box", group: "Blur", label: "Box Blur", min: 1, max: 30, def: 5,
    fmt: (v) => `${v}px`,
    run: (r, v, m) => f2.boxBlur(activeLayer.grid, r, v, 2, m),
  },
  {
    id: "sharpen", group: "Sharpen", label: "Sharpen", min: 1, max: 100, def: 50,
    fmt: (v) => `${v}`,
    run: (r, v, m) => applyFilter(activeLayer.grid, r.x, r.y, r.w, r.h, { kind: "sharpen", amount: v }, m),
  },
  {
    id: "unsharp", group: "Sharpen", label: "Unsharp Mask", min: 1, max: 100, def: 50,
    fmt: (v) => `${v}%`,
    run: (r, v, m) => applyFilter(activeLayer.grid, r.x, r.y, r.w, r.h, { kind: "unsharp", amount: v }, m),
  },
  {
    id: "noise", group: "Noise", label: "Add Noise", min: 1, max: 100, def: 25,
    fmt: (v) => `±${v}`,
    run: (r, v, m) => applyFilter(activeLayer.grid, r.x, r.y, r.w, r.h, { kind: "noise", amount: v }, m),
  },
  {
    id: "median", group: "Noise", label: "Median", min: 1, max: 6, def: 2,
    fmt: (v) => `${v}px`,
    run: (r, v, m) => f2.medianFilter(activeLayer.grid, r, v, m),
  },
  {
    id: "dust", group: "Noise", label: "Dust & Scratches", min: 1, max: 5, def: 2,
    fmt: (v) => `${v}px`,
    run: (r, v, m) => f2.dustScratches(activeLayer.grid, r, v, m),
  },
  {
    id: "pinch", group: "Distort", label: "Pinch", min: 1, max: 100, def: 40,
    fmt: (v) => `${v}%`,
    run: (r, v) => f2.spherize(activeLayer.grid, r, v, "pinch"),
  },
  {
    id: "spherize", group: "Distort", label: "Spherize", min: 1, max: 100, def: 50,
    fmt: (v) => `${v}%`,
    run: (r, v) => f2.spherize(activeLayer.grid, r, v, "spherize"),
  },
  {
    id: "twirl", group: "Distort", label: "Twirl", min: 1, max: 360, def: 120,
    fmt: (v) => `${v}°`,
    run: (r, v) => f2.twirl(activeLayer.grid, r, v),
  },
  {
    id: "ripple", group: "Distort", label: "Ripple", min: 1, max: 40, def: 10,
    fmt: (v) => `${v}px`,
    run: (r, v) => f2.ripple(activeLayer.grid, r, v, 30),
  },
  {
    id: "wave", group: "Distort", label: "Wave", min: 1, max: 40, def: 10,
    fmt: (v) => `${v}px`,
    run: (r, v) => f2.wave(activeLayer.grid, r, v, 60),
  },
  {
    id: "polar", group: "Distort", label: "Polar Coordinates", min: 0, max: 1, def: 0,
    fmt: (v) => (v === 0 ? "rect → polar" : "polar → rect"),
    run: (r, v) => f2.polarCoordinates(activeLayer.grid, r, v === 0 ? "rect-to-polar" : "polar-to-rect"),
  },
  {
    id: "find-edges", group: "Stylize", label: "Find Edges", min: 0, max: 0, def: 0,
    fmt: () => "",
    run: (r, _v, m) => f2.findEdges(activeLayer.grid, r, m),
  },
  {
    id: "emboss", group: "Stylize", label: "Emboss", min: 30, max: 300, def: 135,
    fmt: (v) => `${v}°`,
    run: (r, v) => f2.emboss(activeLayer.grid, r, v, 3, 100),
  },
  {
    id: "solarize", group: "Stylize", label: "Solarize", min: 1, max: 254, def: 128,
    fmt: (v) => `>${v}`,
    run: (r, v) => f2.solarize(activeLayer.grid, r, v),
  },
  {
    id: "trace", group: "Stylize", label: "Trace Contour", min: 1, max: 254, def: 128,
    fmt: (v) => `level ${v}`,
    run: (r, v) => f2.traceContour(activeLayer.grid, r, v),
  },
  {
    id: "oil", group: "Stylize", label: "Oil Paint", min: 1, max: 8, def: 4,
    fmt: (v) => `${v}px`,
    run: (r, v) => f2.oilPaint(activeLayer.grid, r, v, 12),
  },
  {
    id: "clouds", group: "Render", label: "Clouds", min: 1, max: 40, def: 8,
    fmt: (v) => `seed ${v}`,
    run: (r, v) => f2.clouds(activeLayer.grid, r, v, 1, "clouds"),
  },
  {
    id: "difference-clouds", group: "Render", label: "Difference Clouds", min: 1, max: 40, def: 8,
    fmt: (v) => `seed ${v}`,
    run: (r, v) => f2.clouds(activeLayer.grid, r, v, 1, "difference"),
  },
  {
    id: "lens-flare", group: "Render", label: "Lens Flare", min: 10, max: 200, def: 100,
    fmt: (v) => `${v}%`,
    run: (r, v) => f2.lensFlare(activeLayer.grid, r, r.x + r.w / 2, r.y + r.h / 2, v),
  },
  {
    id: "pixelate", group: "Pixelate", label: "Mosaic", min: 2, max: 64, def: 8,
    fmt: (v) => `${v}px`,
    run: (r, v, m) => applyFilter(activeLayer.grid, r.x, r.y, r.w, r.h, { kind: "pixelate", amount: v }, m),
  },
  {
    id: "crystallize", group: "Pixelate", label: "Crystallize", min: 3, max: 40, def: 10,
    fmt: (v) => `${v}px`,
    run: (r, v) => f2.crystallize(activeLayer.grid, r, v),
  },
  {
    id: "high-pass", group: "Other", label: "High Pass", min: 1, max: 40, def: 10,
    fmt: (v) => `${v}px`,
    run: (r, v) => f2.highPass(activeLayer.grid, r, v),
  },
  {
    id: "offset", group: "Other", label: "Offset", min: 1, max: 200, def: 40,
    fmt: (v) => `${v}px`,
    run: (r, v) => f2.offsetFilter(activeLayer.grid, r, v, Math.round(v / 2)),
  },
  {
    id: "minimum", group: "Other", label: "Minimum", min: 1, max: 8, def: 2,
    fmt: (v) => `${v}px`,
    run: (r, v) => f2.minMax(activeLayer.grid, r, v, "minimum"),
  },
  {
    id: "maximum", group: "Other", label: "Maximum", min: 1, max: 8, def: 2,
    fmt: (v) => `${v}px`,
    run: (r, v) => f2.minMax(activeLayer.grid, r, v, "maximum"),
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
fSel.addEventListener("change", syncFUI);
fSlider.addEventListener("input", () => {
  fVal.textContent = currentFilter().fmt(Number(fSlider.value));
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
  const label = spec.label + suffix + (selRect || selMask ? " (selection)" : "");
  const entry = layerOpCommand(activeLayer, label, () => {
    spec.run(rect, amount, selMask ?? undefined);
  });
  if (!entry) return;
  pushHist(entry);
  flatDirty = true;
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
  if (e.code !== "Space" || modalCount > 0) return;
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
  // leaving the window mid-stroke used to resume painting on return
  closeGesture();
  endPan();
  syncCursor();
});

/** True when any tab holds work that was never written to a file. */
function anyUnsaved(): boolean {
  captureTab();
  return tabs.some((t) => t.dirty);
}
window.addEventListener("beforeunload", (e) => {
  if (!anyUnsaved()) return;
  e.preventDefault();
  e.returnValue = "";
});


// the boot document becomes tab 0
tabs.push({ name: "Untitled", doc, activeLayer, history, flat, flatDirty, selRect, selMask, selGeom, scale, panX, panY, autosaveDirty, dirty: false });
activeTab = 0;
renderTabs();

// ---- autosave / crash recovery (OPFS — fully local, never leaves the disk) --
const AUTOSAVE_FILE = "pigment-autosave.json";
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
  const pending = tabs.filter(t => t.autosaveDirty);
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
      tabs: tabs.map(t => ({ name: t.name, project: serializeProject(t.doc, t.name) })),
      active: activeTab,
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
        const nd = deserializeProject(e.project);
        const name = typeof e.name === "string" && e.name ? e.name : "Restored";
        replaceDocument(nd, undefined, name);
      } catch (err) {
        console.error("autosave restore failed", err);
      }
    }
    // drop the untouched boot document when restored docs came back
    if (tabs.length > 1 && tabs[0]!.name === "Untitled" && tabs[0]!.history.position === 0) {
      closeTab(0);
    }
    hideRecoveryBar();
  });
  discard.addEventListener("click", async () => {
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
  pushHist({
    label: "Flatten Image",
    // doc.layers is readonly as a property, but the array itself is mutable:
    // splice it back to the captured state in both directions
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
/** Edit ▸ Content-Aware Fill: rebuilds the selection from the pixels around it. */
function contentAwareFillSelection(): void {
  const mask = selMask;
  if (!mask) {
    statusHint("Select something first — Content-Aware Fill works on a selection.");
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
  const entry = layerOpCommandIn(layer, "Content-Aware Fill", () => {
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
  selMask = null;
  selGeom = null;
  selRect = { x: 0, y: 0, w: doc.width, h: doc.height };
  startAnts();
  drawOverlay();
  refreshOptions();
  render();
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
function applySelectionMask(next: SelectionMask): void {
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
  const cx = host.clientWidth / 2, cy = host.clientHeight / 2;
  const dx = (cx - panX) / scale, dy = (cy - panY) / scale;
  scale = Math.min(32, Math.max(0.05, scale * factor));
  panX = cx - dx * scale;
  panY = cy - dy * scale;
  render();
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
  if (a) a.run();
}

/** Draw the eye to a panel the menu just targeted. */
function pulse(box: HTMLElement): void {
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  box.classList.remove("flash");
  void box.offsetWidth;
  box.classList.add("flash");
  setTimeout(() => box.classList.remove("flash"), 1000);
}

function focusAdjustment(kind: AdjustmentKind): void {
  adjSel.value = kind;
  syncAdjUI();
  pulse(adjustBox);
}

function focusFilter(id: string): void {
  fSel.value = id;
  syncFUI();
  pulse(filterBox);
}

// ---- menu bar ------------------------------------------------------------
type MenuItem = {
  label?: string;
  key?: string;
  icon?: IconName;
  run?: () => void;
  children?: MenuItem[];
  sep?: boolean;
  header?: string;
  disabled?: boolean;
  /** renders a check mark in front of the label */
  checked?: boolean;
};

function menuDefs(): { title: string; items: MenuItem[] }[] {
  const fileItems: MenuItem[] = topActions
    .filter((a) => a.menu === "file")
    .map((a) => ({
      label: a.label,
      icon: a.icon,
      run: a.run,
      key: { "New": "Ctrl+N", "Open Image…": "Ctrl+O", "Open Project…": "Ctrl+Shift+O", "Save Project": "Ctrl+S", "Export As…": "Ctrl+Shift+E" }[a.label],
    }));
  const imageItems: MenuItem[] = topActions
    .filter((a) => a.menu === "image")
    .map((a) => ({ label: a.label, icon: a.icon, run: a.run }));

  const tonalItems: MenuItem[] = [
    { label: "Levels…", run: () => tonalPanel.open("levels") },
    { label: "Curves…", run: () => tonalPanel.open("curves") },
    { label: "Exposure…", run: () => tonalPanel.open("exposure") },
    { label: "Vibrance…", run: () => tonalPanel.open("vibrance") },
    { sep: true },
    { label: "Colour Balance…", run: () => tonalPanel.open("colorBalance") },
    { label: "Black & White…", run: () => tonalPanel.open("blackWhite") },
    { label: "Photo Filter…", run: () => tonalPanel.open("photoFilter") },
    { label: "Channel Mixer…", run: () => tonalPanel.open("channelMixer") },
    { label: "Gradient Map…", run: () => tonalPanel.open("gradientMap") },
    { sep: true },
    { label: "Desaturate", run: () => tonalPanel.open("desaturate") },
    { label: "Auto Tone", key: "Ctrl+Shift+L", run: () => tonalPanel.open("autoTone") },
    { label: "Auto Contrast", run: () => tonalPanel.open("autoContrast") },
    { label: "Auto Colour", run: () => tonalPanel.open("autoColor") },
    { label: "Equalize", run: () => tonalPanel.open("equalize") },
  ];
  const adjItems: MenuItem[] = (Object.keys(KINDS) as AdjustmentKind[]).map((k) => ({
    label: `${k.charAt(0).toUpperCase()}${k.slice(1)}…`,
    run: () => focusAdjustment(k),
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
        ...fileItems.slice(0, 5),
        { sep: true },
        { label: "Close Tab", key: "Ctrl+W", run: () => closeTab(activeTab) },
      ],
    },
    {
      title: "Edit",
      items: [
        { label: "Undo", key: "Ctrl+Z", disabled: !history.canUndo, run: () => { if (history.undo()) applyHistoryChange(); } },
        { label: "Redo", key: "Ctrl+Shift+Z", disabled: !history.canRedo, run: () => { if (history.redo()) applyHistoryChange(); } },
        { sep: true },
        { label: "Fill with Foreground", key: "Alt+Backspace", run: fillWithForeground },
        {
          label: "Content-Aware Fill",
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
          label: "Two-Column Toolbar",
          checked: toolbarCols === 2,
          run: () => { toolbarSizeBtn.click(); }, // same logic as the pinned footer button (toggle + width nudge)
        },
        { label: "Reset Toolbar Width", run: () => { toolbarW = 50; toolbarCols = 1; applyToolbar(); } },
      ],
    },
    {
      title: "Help",
      items: [
        { label: "Keyboard Shortcuts", run: showShortcuts },
        { label: "About Pigment", run: showAbout },
      ],
    },
  ];
}

function showShortcuts(): void {
  const body = document.createElement("div");
  body.className = "shortcuts";
  const rows: [string, string][] = [
    ["V", "Move"], ["M", "Marquee / ellipse"], ["L", "Lasso"], ["W", "Magic wand"],
    ["C", "Crop"], ["B", "Brush"], ["E", "Eraser"], ["G", "Gradient"],
    ["Shift+G", "Paint bucket"], ["T", "Text"], ["Ctrl+T", "Free transform"],
    ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"], ["Ctrl+A", "Select all"],
    ["Ctrl+D", "Deselect"], ["Ctrl+Shift+I", "Invert selection"],
    ["Delete", "Clear selection"], ["Alt+Backspace", "Fill selection"],
    ["Ctrl+E", "Merge down"], ["Ctrl+J", "Duplicate layer"],
    ["Ctrl+Shift+N", "New layer"], ["Ctrl+0", "Fit on screen"],
    ["Ctrl+1", "Actual pixels"], ["Ctrl++ / Ctrl+-", "Zoom in / out"],
    ["[ / ]", "Brush size"], ["Ctrl+S", "Save project"], ["Ctrl+O", "Open image"],
  ];
  for (const [k, what] of rows) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.innerHTML = `<kbd>${k}</kbd><span>${what}</span>`;
    body.appendChild(row);
  }
  showModal("Keyboard Shortcuts", body, () => {});
}

function showAbout(): void {
  const body = document.createElement("div");
  body.className = "about";
  body.innerHTML = `
    <p><b>Pigment</b> — a fully offline image editor.</p>
    <p>No accounts, no cloud, no telemetry: the app never makes a network request.
    Everything — painting, layers, selection, filters, PSD import — runs on your machine.</p>
    <p class="label">Tile-based engine · 27 blend modes · WebView2 shell · zero runtime dependencies</p>`;
  showModal("About Pigment", body, () => {});
}

const menuBarEl = document.createElement("nav");
menuBarEl.id = "menubar";
topbar.insertBefore(menuBarEl, topbar.children[1] ?? null);

function fillPop(pop: HTMLElement, items: MenuItem[]): void {
  pop.innerHTML = "";
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement("div");
      d.className = "menu-sep";
      pop.appendChild(d);
      continue;
    }
    if (it.header) {
      const h = document.createElement("div");
      h.className = "menu-head";
      h.textContent = it.header;
      pop.appendChild(h);
      continue;
    }
    const row = document.createElement("div");
    row.className = "menu-item" + (it.children ? " sub" : "") + (it.disabled ? " disabled" : "");
    const ico = document.createElement("span");
    ico.className = "mi-ico";
    if (it.icon) ico.innerHTML = iconSvg(it.icon, 14);
    else if (it.checked) ico.innerHTML = iconSvg("check", 13);
    const label = document.createElement("span");
    label.className = "mi-label";
    label.textContent = it.label ?? "";
    row.append(ico, label);
    if (it.children) {
      const chev = document.createElement("span");
      chev.className = "key";
      chev.textContent = "›";
      row.appendChild(chev);
      const sub = document.createElement("div");
      sub.className = "menu-pop menu-sub";
      fillPop(sub, it.children);
      row.appendChild(sub);
    } else if (it.key) {
      const k = document.createElement("span");
      k.className = "key";
      k.textContent = it.key;
      row.appendChild(k);
    }
    if (!it.children && it.run && !it.disabled) {
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenus();
        it.run!();
      });
    }
    pop.appendChild(row);
  }
}

let menuOpenTitle: string | null = null;
const menuRoots = new Map<string, HTMLElement>();

function closeMenus(): void {
  for (const root of menuRoots.values()) {
    root.classList.remove("open");
    root.children[0]?.classList.remove("open");
  }
  menuOpenTitle = null;
}

/** Rebuild + open one menu. Rebuilding keeps Undo/Redo/Merge availability fresh. */
function openMenu(title: string): void {
  buildMenuBar();
  const root = menuRoots.get(title);
  if (!root) return;
  root.classList.add("open");
  root.children[0]?.classList.add("open");
  menuOpenTitle = title;
}

function buildMenuBar(): void {
  menuBarEl.innerHTML = "";
  menuRoots.clear();
  for (const def of menuDefs()) {
    const root = document.createElement("div");
    root.className = "menu";
    const btn = document.createElement("button");
    btn.className = "menu-btn";
    btn.textContent = def.title;
    const pop = document.createElement("div");
    pop.className = "menu-pop";
    fillPop(pop, def.items);
    root.append(btn, pop);
    menuRoots.set(def.title, root);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menuOpenTitle === def.title) closeMenus();
      else openMenu(def.title);
    });
    btn.addEventListener("pointerenter", () => {
      if (menuOpenTitle !== null && menuOpenTitle !== def.title) openMenu(def.title);
    });
    menuBarEl.appendChild(root);
  }
}

buildMenuBar();
document.addEventListener("pointerdown", (e) => {
  if (!menuBarEl.contains(e.target as Node)) closeMenus();
});

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
window.addEventListener("resize", () => { closeMenus(); ensureMenuBar(); });
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => ensureMenuBar()).observe(topbar);
}
promoteTitles(document);

// ---- New Document dialog (Photoshop-style) --------------------------------
// The dialog itself lives in ./ui/newdoc.ts; units and presets are unit-tested
// in ./engine/docmeta.ts.
function newDocumentDialog(): void {
  openNewDocumentDialog({
    showModal,
    applyTransform,
    isTransforming: () => transform !== null,
    foregroundColor: () => color,
    replaceDocument: (doc, layer, name) => replaceDocument(doc, layer, name),
    setActiveTabDpi: (dpi) => { const tab = tabs[tabs.length - 1]; if (tab) tab.dpi = dpi; },
    renderTabs,
  });
}


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
  colorWell.value = hex(c);
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
    b.addEventListener("click", () => setForeground(c));
    swatchRow.appendChild(b);
  }
}

const hexInput = document.createElement("input");
hexInput.type = "text";
hexInput.className = "hex";
hexInput.spellcheck = false;
hexInput.title = "Hex colour, e.g. #5b8cff";
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
  const val = document.createElement("span");
  val.className = "value";
  val.style.minWidth = "26px";
  range.addEventListener("input", () => {
    color[ch.key] = Number(range.value);
    val.textContent = range.value;
    colorWell.value = hex([color[0], color[1], color[2]]);
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


// ---- dockable panels ------------------------------------------------------
// Runs last on purpose: every card (layers, history, adjustments, filters,
// colour, tonal, histogram) already exists by now, and docking is applied to the
// set rather than to each card as it is created.
dockifyPanels(panels, relayout);
