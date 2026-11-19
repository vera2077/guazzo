/**
 * Seed HTML for the live text editor.
 *
 * The editor is seeded by assigning `el.innerHTML`, and every string here comes
 * from a document file — i.e. from wherever the user's `.guazzo.json` came from.
 * So this module is a trust boundary and lives on its own so it can be unit
 * tested: no value may ever be able to close an attribute or open a tag.
 *
 * Two independent defences per field:
 *   1. `safeFontFamily` whitelists the characters a CSS family may contain, and
 *      refuses everything else wholesale (a CSS injection needs `;` or `:` or
 *      `url(` — none survive the whitelist).
 *   2. `escapeAttr` escapes `& < > " '` in every quoted value and in the text.
 */
import type { TextSeg } from "../engine/document.ts";

/** longest family name we will pass through (the longest real ones are ~40) */
const MAX_FONT_NAME = 120;

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A font family that is safe inside a `style="…"` attribute. Anything outside
 * letters, digits, space, `_ - , ' "` is refused (no `;`, no `(`, no `\`), and
 * an over-long or empty name falls back to Arial.
 */
export function safeFontFamily(font: unknown): string {
  if (typeof font !== "string") return "Arial";
  const trimmed = font.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FONT_NAME) return "Arial";
  return /^[A-Za-z0-9 _,'"-]+$/.test(trimmed) ? trimmed : "Arial";
}

export function segSpanHtml(s: TextSeg): string {
  const family = safeFontFamily(s.font);
  const style: string[] = [`font-family:${family}`];
  if (s.bold) style.push("font-weight:600");
  if (s.italic) style.push("font-style:italic");
  const deco: string[] = [];
  if (s.underline) deco.push("underline");
  if (s.strike) deco.push("line-through");
  if (deco.length) style.push(`text-decoration:${deco.join(" ")}`);
  const txt = escapeAttr(s.text ?? "");
  if (!s.bold && !s.italic && !s.underline && !s.strike) return txt; // plain run
  return `<span face="${escapeAttr(family)}" style="${escapeAttr(style.join(";"))}">${txt}</span>`;
}

export function buildSeedHtml(lines: TextSeg[][]): string {
  return lines.map(segs => segs.map(segSpanHtml).join("")).join("<br>");
}

/**
 * Does this seed consist of plain runs only (no spans)? The editor's restyle
 * path only needs the spans when a run carries a style.
 */
export function seedHasSpans(lines: TextSeg[][]): boolean {
  for (const segs of lines) {
    for (const s of segs) if (s.bold || s.italic || s.underline || s.strike) return true;
  }
  return false;
}
