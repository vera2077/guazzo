/**
 * filldialog.ts — the "New Fill Layer" dialog.
 *
 * Extracted from main.ts for the same reason the palette and the export dialog
 * were: the coupling metric counts top-level functions in the shell that touch
 * document state, and a dialog is markup, not document logic. It builds the
 * form and hands the chosen spec to `create`; it never touches the document.
 *
 * Fill layers existed in the model (and the PSD importer created them) but no
 * surface in the app could make one — this dialog is that surface.
 */
import type { FillGradientSpec } from "../engine/fillgradient.ts";

export type Rgb = [number, number, number];

export interface FillChoice {
  /** solid, or which way the gradient runs */
  kind: "solid" | "linear" | "radial";
  first: Rgb;
  second: Rgb;
  /** degrees, linear only */
  angle: number;
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
];

export function openFillLayerDialog(deps: FillDialogDeps): void {
  const body = document.createElement("div");

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

  const colourRow = (label: string, initial: Rgb): { row: HTMLElement; value: Rgb } => {
    const row = document.createElement("div");
    row.className = "field";
    const lab = document.createElement("span");
    lab.className = "label";
    lab.textContent = label;
    const button = document.createElement("button");
    button.className = "btn swatch";
    button.type = "button";
    button.setAttribute("aria-label", label);
    const value: Rgb = [...initial] as Rgb;
    const paint = (): void => {
      button.style.background = `rgb(${value[0]},${value[1]},${value[2]})`;
    };
    paint();
    button.addEventListener("click", () =>
      deps.pickColour(button, {
        get: () => value,
        set: (color) => {
          value[0] = color[0];
          value[1] = color[1];
          value[2] = color[2];
          paint();
        },
      }),
    );
    row.append(lab, button);
    return { row, value };
  };
  const first = colourRow("Colour 1", [255, 255, 255]);
  const second = colourRow("Colour 2", [0, 0, 0]);

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
  angle.setAttribute("aria-label", "Gradient angle");
  angleRow.append(angleLab, angle);

  /** Only the controls the chosen kind actually uses stay on screen. */
  const sync = (): void => {
    const kind = kindSel.value;
    second.row.style.display = kind === "solid" ? "none" : "";
    angleRow.style.display = kind === "linear" ? "" : "none";
  };
  kindSel.addEventListener("change", sync);
  body.append(kindRow, first.row, second.row, angleRow);
  sync();

  deps.showModal("New Fill Layer", body, () => {
    const kind: FillChoice["kind"] =
      kindSel.value === "radial" ? "radial" : kindSel.value === "solid" ? "solid" : "linear";
    deps.create({
      kind,
      first: [...first.value] as Rgb,
      second: [...second.value] as Rgb,
      angle: Number(angle.value) || 0,
      name: kind === "solid" ? "Solid Colour" : kind === "radial" ? "Radial Gradient" : "Linear Gradient",
    });
  });
}

/** The gradient a choice describes; solid fills have none. */
export function fillGradientFrom(choice: FillChoice): FillGradientSpec | undefined {
  if (choice.kind === "solid") return undefined;
  return {
    type: choice.kind,
    angle: choice.angle,
    stops: [
      { at: 0, color: [...choice.first] as Rgb },
      { at: 1, color: [...choice.second] as Rgb },
    ],
  };
}
