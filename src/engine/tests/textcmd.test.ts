import assert from "node:assert/strict";
import { test } from "node:test";
import { Document, type Layer, type TextSeg } from "../document.ts";
import { History, textOpCommand } from "../history.ts";

function eq(actual: unknown, expected: unknown): void {
  assert.strictEqual(actual, expected);
}

function seg(text: string): TextSeg {
  return { text, bold: false, italic: false, underline: false, strike: false, font: "Arial" };
}

/** a 1:1 text layer with a recipe that matches nothing in particular */
function textLayer(): Layer {
  const doc = new Document(64, 32);
  const layer = doc.addLayer("Text: hello");
  layer.grid.fillRect(4, 4, 20, 10, [255, 0, 0, 255]);
  layer.textData = {
    lines: [[seg("hello")]],
    x: 4, y: 4, w: 20, h: 10, size: 12, color: [255, 0, 0],
  };
  return layer;
}

test("undoing a text edit restores pixels AND the recipe", () => {
  const layer = textLayer();
  const history = new History(10);
  const entry = textOpCommand(layer, "Edit text", () => {
    layer.grid.fillRect(4, 4, 20, 10, [0, 0, 0, 0]);
    layer.grid.fillRect(4, 4, 8, 10, [0, 255, 0, 255]);
    layer.textData = { ...layer.textData!, lines: [[seg("bye")]], w: 8 };
  });
  assert.ok(entry);
  history.push(entry);
  {
    const px = new Uint8ClampedArray(4);
    layer.grid.readRect(6, 6, 1, 1, px);
    assert.deepEqual([...px], [0, 255, 0, 255]);
  }
  eq(layer.textData!.lines[0]![0]!.text, "bye");

  assert.ok(history.undo());
  const px = new Uint8ClampedArray(4);
  layer.grid.readRect(6, 6, 1, 1, px);
  assert.deepEqual([...px], [255, 0, 0, 255]);
  // the recipe must be the PRE-edit one: re-editing then shows "hello", not "bye"
  eq(layer.textData!.lines[0]![0]!.text, "hello");
  eq(layer.textData!.w, 20);

  assert.ok(history.redo());
  eq(layer.textData!.lines[0]![0]!.text, "bye");
  eq(layer.textData!.w, 8);
});

test("clear text undo leaves the layer re-editable (recipe restored with pixels)", () => {
  const layer = textLayer();
  const history = new History(10);
  const entry = textOpCommand(layer, "Clear text", () => {
    const m = layer.textData!;
    layer.grid.fillRect(m.x, m.y, m.w, m.h, [0, 0, 0, 0]);
    layer.textData = undefined;
  });
  assert.ok(entry);
  history.push(entry);
  eq(layer.textData, undefined);

  assert.ok(history.undo());
  assert.ok(layer.textData, "undo must bring the recipe back or the layer can never be re-edited");
  eq(layer.textData!.lines[0]![0]!.text, "hello");
  const px = new Uint8ClampedArray(4);
  layer.grid.readRect(6, 6, 1, 1, px);
  assert.deepEqual([...px], [255, 0, 0, 255]);
});

test("a recipe-only change is still undoable", () => {
  const layer = textLayer();
  const history = new History(10);
  // pixels intentionally untouched: same footprint, different alignment
  const entry = textOpCommand(layer, "Text align", () => {
    layer.textData = { ...layer.textData!, align: "justify" };
  });
  assert.ok(entry, "a recipe-only change must not be dropped as a no-op");
  history.push(entry);
  eq(layer.textData!.align, "justify");
  assert.ok(history.undo());
  eq(layer.textData!.align, undefined);
  assert.ok(history.redo());
  eq(layer.textData!.align, "justify");
});

test("a no-change text op pushes nothing", () => {
  const layer = textLayer();
  eq(textOpCommand(layer, "Edit text", () => {}), null);
});
