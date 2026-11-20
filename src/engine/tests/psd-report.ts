/**
 * psd-report.ts — the import report, read back as findings.
 *
 * `psdToDocument` owns the accounting now: every feature it cannot carry over
 * is pushed into the report as it walks. This module only turns that report
 * into the shape the fixture checks read, and proves that every parsed layer is
 * either in the document or named by the report.
 *
 * The old reference walk (which predicted what a flattened importer would drop)
 * is deliberately gone: two accounts of the same loss can disagree, and the
 * importer's own report is the one the status bar shows.
 */
import type { Document, Layer } from "../document.ts";
import type { ImportReport } from "../importreport.ts";
import type { PsdLayerLike, PsdLike } from "../psd.ts";

export type Feature = ImportReport["avoided"][number]["feature"];

export interface Finding {
  feature: Feature;
  /** layer path from the root, joined with " / "; "-" for file-wide findings */
  path: string;
  detail: string;
}

/** the report's admissions, in the order the importer made them */
export function reportFindings(report: ImportReport): Finding[] {
  return report.avoided.map((a) => ({ feature: a.feature, path: a.path, detail: a.detail }));
}

function docPaths(doc: Document): Set<string> {
  const paths = new Set<string>();
  const walk = (list: readonly Layer[], trail: string): void => {
    for (const layer of list) {
      const path = trail ? `${trail} / ${layer.name}` : layer.name;
      paths.add(path);
      if (layer.children) walk(layer.children, path);
    }
  };
  walk(doc.layers, "");
  return paths;
}

/** ag-psd synthesizes this placeholder when a PSD has no layers at all. */
function placeholder(layer: PsdLayerLike): boolean {
  return (
    !layer.imageData && !layer.mask && !layer.name && !layer.hidden &&
    layer.left === 0 && layer.top === 0 && layer.right === 0 && layer.bottom === 0
  );
}

/** PSD nodes that made it neither into the document nor into the report */
export function silentDrops(psd: PsdLike, doc: Document, findings: readonly Finding[]): string[] {
  const reported = new Set(findings.map((f) => f.path));
  const inDoc = docPaths(doc);
  const out: string[] = [];
  const walk = (list: readonly PsdLayerLike[], trail: string): void => {
    for (const layer of list) {
      if (placeholder(layer)) continue;
      const name = layer.children ? (layer.name || "Group") : (layer.name || "Layer");
      const path = trail ? `${trail} / ${name}` : name;
      if (!inDoc.has(path) && !reported.has(path)) {
        out.push(`${path} (${layer.children ? "group" : "layer"})`);
      }
      if (layer.children) walk(layer.children, path);
    }
  };
  walk(psd.children ?? [], "");
  return out;
}

/** readable lines for scripts/psd-check.mjs */
export function reportLines(findings: readonly Finding[]): string[] {
  return findings.map((f) => `  • [${f.feature}] ${f.detail}`);
}
