/**
 * filldialog.ts — the "New Fill Layer" dialog.
 *
 * Extracted from main.ts for the same reason the palette and the export dialog
 * were: the coupling metric counts top-level functions in the shell that touch
 * document state, and a dialog is markup, not document logic. It builds the
 * form and hands the chosen spec to `create`; it never touches the document.
 *
 * Fill layers existed in the model (and the PSD importer created them) but no
 * surface in the app could make one — this dialog is that surface. Stops are a
 * list rather than two swatches because a two-stop field cannot express what a
 * gradient is; the list starts with two and grows.
 */
import { DEFAULT_FILL_GRADIENT, fillGradientColourAt, normalizeFillGradient, type FillGradientSpec } from "../engine/fillgradient.ts";
import { fillPatternColourAt, normalizeFillPattern, type FillPattern } from "../engine/fillpattern.ts";

export type Rgb = [number, number, number];

export interface FillStopChoice {
  /** 0..1 along the gradient */
  at: number;
  color: Rgb;
}

export interface FillChoice {
  /** solid, which way the gradient runs, or a generated pattern */
  kind: "solid" | "linear" | "radial" | "pattern";
  /** the stops, at least two for a gradient */
  stops: FillStopChoice[];
  /** degrees, linear only */
  angle: number;
  /** tile and colours, pattern only */
  pattern: { kind: "checker" | "stripes" | "dots"; size: number; colorA: Rgb; colorB: Rgb };
  /** the layer name the caller should use */
  name: string;
}

export interface FillDialogDeps {
  showModal(title: string, body: HTMLElement, onOk: () => void | false): void;
  pickColour(anchor: HTMLElement, target: { get(): Rgb; set(color: Rgb): void }): void;
  create(choice: FillChoice): void;
}

const KIND_LABELS: ReadonlyArray<readonly [FillChoice["kind"], string]> = [
  ["solid", "Solid colour"],
  ["linear", "Linear gradient"],
  ["radial", "Radial gradient"],
  ["pattern", "Pattern"],
];

const PATTERN_CHOICES: ReadonlyArray<readonly [FillPattern["kind"], string]> = [
  ["checker", "Checkerboard"],
  ["stripes", "Diagonal stripes"],
  ["dots", "Dots"],
];

const MAX_STOPS = 8;

export function openFillLayerDialog(deps: FillDialogDeps): void {
  const body = document.createElement("div");

  // The preview runs the same samplers the compositor does, so what is drawn
  // here is what the layer will look like — not an approximation of it.
  const preview = document.createElement("canvas");
  preview.className = "fill-preview";
  preview.width = 240;
  preview.height = 48;
  preview.setAttribute("role", "img");
  preview.setAttribute("aria-label", "Preview of the fill");

  const kindRow = document.createElement("div");
  kindRow.className = "field";
  const kindLab = document.createElement("span");
  kindLab.className = "label";
  kindLab.textContent = "Fill";
  const kindSel = document.createElement("select");
  kindSel.setAttribute("aria-label", "Fill type");
  for (const [value, label] of KIND_LABELS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    kindSel.appendChild(option);
  }
  kindRow.append(kindLab, kindSel);

  // The stops, as data. The rows below are a view of this array.
  const stops: FillStopChoice[] = [
    { at: 0, color: [255, 255, 255] },
    { at: 1, color: [0, 0, 0] },
  ];

  const stopsWrap = document.createElement("div");
  stopsWrap.className = "stop-list";
  const stopsHead = document.createElement("div");
  stopsHead.className = "field";
  const stopsLab = document.createElement("span");
  stopsLab.className = "label";
  stopsLab.textContent = "Stops";
  const addBtn = document.createElement("button");
  addBtn.className = "btn small";
  addBtn.type = "button";
  addBtn.textContent = "+ Stop";
  addBtn.setAttribute("aria-label", "Add a colour stop");
  stopsHead.append(stopsLab, addBtn);
  stopsWrap.appendChild(stopsHead);

  const renderStops = (): void => {
    for (const row of Array.from(stopsWrap.querySelectorAll(".stop-row"))) row.remove();
    stops.forEach((stop, index) => {
      const row = document.createElement("div");
      row.className = "field stop-row";

      const swatch = document.createElement("button");
      swatch.className = "btn swatch";
      swatch.type = "button";
      swatch.setAttribute("aria-label", `Colour stop ${index + 1}`);
      const paint = (): void => {
        swatch.style.background = `rgb(${stop.color[0]},${stop.color[1]},${stop.color[2]})`;
      };
      paint();
      swatch.addEventListener("click", () =>
        deps.pickColour(swatch, {
          get: () => stop.color,
          set: (color) => {
            stop.color = [color[0], color[1], color[2]];
            paint();
            paintPreview();
          },
        }),
      );

      const at = document.createElement("input");
      at.type = "number";
      at.className = "num";
      at.min = "0";
      at.max = "100";
      at.value = String(Math.round(stop.at * 100));
      at.setAttribute("aria-label", `Colour stop ${index + 1} position, percent`);
      at.addEventListener("input", () => {
        stop.at = Math.min(1, Math.max(0, (Number(at.value) || 0) / 100));
        paintPreview();
      });

      const pct = document.createElement("span");
      pct.className = "value";
      pct.textContent = "%";

      row.append(swatch, at, pct);
      // Two stops are the minimum a gradient can mean; the last pair stays.
      if (stops.length > 2) {
        const del = document.createElement("button");
        del.className = "btn small";
        del.type = "button";
        del.textContent = "×";
        del.setAttribute("aria-label", `Remove colour stop ${index + 1}`);
        del.addEventListener("click", () => {
          stops.splice(index, 1);
          renderStops();
          sync();
        });
        row.appendChild(del);
      }
      stopsWrap.appendChild(row);
    });
  };

  addBtn.addEventListener("click", () => {
    if (stops.length >= MAX_STOPS) return;
    // Insert into the widest gap, so a new stop lands where there is room.
    let gapAt = 0;
    let gap = -1;
    for (let i = 1; i < stops.length; i++) {
      const d = stops[i]!.at - stops[i - 1]!.at;
      if (d > gap) {
        gap = d;
        gapAt = stops[i - 1]!.at + d / 2;
      }
    }
    stops.push({ at: gapAt, color: [128, 128, 128] });
    stops.sort((a, b) => a.at - b.at);
    renderStops();
    sync();
  });

  const angleRow = document.createElement("div");
  angleRow.className = "field";
  const angleLab = document.createElement("span");
  angleLab.className = "label";
  angleLab.textContent = "Angle";
  const angle = document.createElement("input");
  angle.type = "number";
  angle.className = "num";
  angle.min = "0";
  angle.max = "360";
  angle.value = "90";
  angle.setAttribute("aria-label", "Gradient angle in degrees");
  angleRow.append(angleLab, angle);

  const patternKindRow = document.createElement("div");
  patternKindRow.className = "field";
  const patternKindLab = document.createElement("span");
  patternKindLab.className = "label";
  patternKindLab.textContent = "Pattern";
  const patternKindSel = document.createElement("select");
  patternKindSel.setAttribute("aria-label", "Pattern shape");
  for (const [value, label] of PATTERN_CHOICES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    patternKindSel.appendChild(option);
  }
  patternKindRow.append(patternKindLab, patternKindSel);

  const patternSizeRow = document.createElement("div");
  patternSizeRow.className = "field";
  const patternSizeLab = document.createElement("span");
  patternSizeLab.className = "label";
  patternSizeLab.textContent = "Tile size";
  const patternSizeInput = document.createElement("input");
  patternSizeInput.type = "number";
  patternSizeInput.className = "num";
  patternSizeInput.min = "2";
  patternSizeInput.max = "256";
  patternSizeInput.value = "32";
  patternSizeInput.setAttribute("aria-label", "Pattern tile size in pixels");
  patternSizeRow.append(patternSizeLab, patternSizeInput);

  const patternColourRow = document.createElement("div");
  patternColourRow.className = "field";
  const patternColourLab = document.createElement("span");
  patternColourLab.className = "label";
  patternColourLab.textContent = "Colours";
  const patternA: Rgb = [255, 255, 255];
  const patternB: Rgb = [120, 120, 120];
  const swatchA = document.createElement("button");
  swatchA.className = "btn swatch";
  swatchA.type = "button";
  swatchA.setAttribute("aria-label", "Pattern colour");
  const swatchB = document.createElement("button");
  swatchB.className = "btn swatch";
  swatchB.type = "button";
  swatchB.setAttribute("aria-label", "Pattern background colour");
  const paintPattern = (): void => {
    swatchA.style.background = `rgb(${patternA[0]},${patternA[1]},${patternA[2]})`;
    swatchB.style.background = `rgb(${patternB[0]},${patternB[1]},${patternB[2]})`;
  };
  paintPattern();
  swatchA.addEventListener("click", () =>
    deps.pickColour(swatchA, { get: () => patternA, set: (c) => { patternA[0] = c[0]; patternA[1] = c[1]; patternA[2] = c[2]; paintPattern(); } }),
  );
  swatchB.addEventListener("click", () =>
    deps.pickColour(swatchB, { get: () => patternB, set: (c) => { patternB[0] = c[0]; patternB[1] = c[1]; patternB[2] = c[2]; paintPattern(); } }),
  );
  patternColourRow.append(patternColourLab, swatchA, swatchB);

  const note = document.createElement("p");
  note.className = "field-note";
  note.textContent = "A fill layer is a live colour layer: it covers the canvas and stays editable.";

  /** Draw the current fill into the preview strip. */
  const paintPreview = (): void => {
    const ctx = preview.getContext("2d");
    // The headless shim has no ImageData constructor unless it opts in; a
    // preview is decoration, so a context that cannot allocate pixels is a
    // reason to skip it, never a reason to fail opening the dialog.
    if (!ctx || typeof ctx.createImageData !== "function") return;
    const image = ctx.createImageData(preview.width, preview.height);
    const kind = kindSel.value;
    const grad =
      kind === "linear" || kind === "radial"
        ? normalizeFillGradient({ type: kind, angle: Number(angle.value) || 0, stops })
        : undefined;
    const pat =
      kind === "pattern"
        ? normalizeFillPattern({
            kind: patternKindSel.value,
            size: Number(patternSizeInput.value) || 32,
            colorA: patternA,
            colorB: patternB,
          })
        : undefined;
    for (let y = 0; y < preview.height; y++) {
      for (let x = 0; x < preview.width; x++) {
        const rgb = pat
          ? fillPatternColourAt(pat, x, y)
          : grad
            ? fillGradientColourAt(grad, x, y, preview.width, preview.height)
            : (stops[0]?.color ?? [255, 255, 255]);
        const i = (y * preview.width + x) * 4;
        image.data[i] = rgb[0];
        image.data[i + 1] = rgb[1];
        image.data[i + 2] = rgb[2];
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  };

  /** Only the controls the chosen kind actually uses stay on screen. */
  const sync = (): void => {
    const solid = kindSel.value === "solid";
    const pattern = kindSel.value === "pattern";
    stopsWrap.style.display = solid || pattern ? "none" : "";
    angleRow.style.display = kindSel.value === "linear" ? "" : "none";
    patternKindRow.style.display = pattern ? "" : "none";
    patternSizeRow.style.display = pattern ? "" : "none";
    patternColourRow.style.display = pattern ? "" : "none";
    addBtn.disabled = stops.length >= MAX_STOPS;
    note.textContent = solid
      ? "A solid fill layer paints one colour over the whole canvas and stays editable."
      : pattern
        ? "A pattern is generated, not sampled from an image, so it stays sharp at any canvas size."
        : "The gradient is sampled over the canvas, so resizing the canvas re-evaluates it.";
    paintPreview();
  };
  kindSel.addEventListener("change", sync);
  patternKindSel.addEventListener("change", paintPreview);
  patternSizeInput.addEventListener("input", paintPreview);
  angle.addEventListener("input", paintPreview);

  body.append(kindRow, preview, note, stopsWrap, patternKindRow, patternSizeRow, patternColourRow, angleRow);
  renderStops();
  sync();

  deps.showModal("New Fill Layer", body, () => {
    const kind: FillChoice["kind"] =
      kindSel.value === "radial"
        ? "radial"
        : kindSel.value === "solid"
          ? "solid"
          : kindSel.value === "pattern"
            ? "pattern"
            : "linear";
    deps.create({
      kind,
      stops: stops.map((s) => ({ at: s.at, color: [...s.color] as Rgb })).sort((a, b) => a.at - b.at),
      angle: Number(angle.value) || 0,
      pattern: {
        kind: patternKindSel.value === "stripes" ? "stripes" : patternKindSel.value === "dots" ? "dots" : "checker",
        size: Number(patternSizeInput.value) || 32,
        colorA: [patternA[0], patternA[1], patternA[2]],
        colorB: [patternB[0], patternB[1], patternB[2]],
      },
      name:
        kind === "solid"
          ? "Solid Colour"
          : kind === "radial"
            ? "Radial Gradient"
            : kind === "pattern"
              ? "Pattern Fill"
              : "Linear Gradient",
    });
  });
}

/** The gradient a choice describes; solid and pattern fills have none. */
export function fillGradientFrom(choice: FillChoice): FillGradientSpec | undefined {
  if (choice.kind === "solid" || choice.kind === "pattern") return undefined;
  const stops = choice.stops.length >= 2 ? choice.stops : DEFAULT_FILL_GRADIENT.stops;
  return {
    type: choice.kind,
    angle: choice.angle,
    stops: stops.map((stop) => ({ at: stop.at, color: [...stop.color] as Rgb })),
  };
}

/** The pattern a choice describes; only pattern fills have one. */
export function fillPatternFrom(choice: FillChoice): FillPattern | undefined {
  if (choice.kind !== "pattern") return undefined;
  return normalizeFillPattern(choice.pattern);
}
