import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeedHtml, escapeAttr, safeFontFamily } from "../../ui/textseed.ts";
import type { TextSeg } from "../document.ts";

const hostile = 'x" onmouseover="window.__pwned=1';
const seg = (over: Partial<TextSeg>): TextSeg =>
  ({ text: "hi", font: "Arial", bold: false, italic: false, underline: false, strike: false, ...over });

test("escapeAttr escapes every character that can end an attribute", () => {
  const out = escapeAttr(`<>&"'`);
  assert.equal(out, "&lt;&gt;&amp;&quot;&#39;");
  assert.ok(!/[<>"']/.test(out), "no raw delimiter may survive escaping");
});

test("safeFontFamily refuses CSS and attribute injection wholesale", () => {
  const bad = [
    hostile,
    "x;background:url(javascript:alert(1))",
    "Arial\"><img src=x onerror=alert(1)>",
    "a\\62 c",
    "x(",
    "",
    "f".repeat(200),
  ];
  for (const f of bad) assert.equal(safeFontFamily(f), "Arial", `refused: ${f.slice(0, 30)}`);
  assert.equal(safeFontFamily("Times New Roman"), "Times New Roman");
  assert.equal(safeFontFamily("Noto Sans, Arial"), "Noto Sans, Arial");
  assert.equal(safeFontFamily(42 as unknown as string), "Arial");
});

test("a hostile font name cannot open an attribute or a tag", () => {
  const html = buildSeedHtml([[seg({ text: "run", font: hostile, bold: true })]]);
  assert.ok(!html.includes("onmouseover"), "the payload must not survive at all");
  assert.ok(!html.includes("__pwned"));
  // every quote in the output is one we emitted ourselves: exactly two per
  // quoted attribute (face, style) and nothing else
  assert.equal((html.match(/"/g) ?? []).length, 4);
});

test("a hostile run text is entity-escaped, never markup", () => {
  const html = buildSeedHtml([[seg({ text: '<img src=x onerror="alert(1)">' })]]);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes('"'));
});

test("plain runs stay plain text (no wrapper, same as before)", () => {
  assert.equal(buildSeedHtml([[seg({ text: "a < b" })]]), "a &lt; b");
});

test("styled runs keep their wrapper and line breaks", () => {
  const html = buildSeedHtml([[seg({ text: "a", bold: true })], [seg({ text: "b" })]]);
  assert.ok(html.includes("<span face=\"Arial\""));
  assert.ok(html.includes("</span>"));
  assert.ok(html.includes("<br>"));
  assert.equal((html.match(/"/g) ?? []).length, 4);
});
