// Builds app-single.html — the zero-dependency single-file fallback build of Guazzo.
// Concatenates the tsc output in dependency order and strips ESM module syntax;
// also inlines the vendored ag-psd UMD bundle so the single file keeps full
// PSD import support with zero external requests.
// Run `node node_modules/typescript/bin/tsc` first so dist/ is current.
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Recursively list files under `dir` whose name ends with `ext`. */
async function walkExt(root, dir, ext, out = []) {
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) await walkExt(root, rel, ext, out);
    else if (e.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

/**
 * Build the single-file artifact.
 *
 * Exported so the gate can run the generator twice and compare bytes. Importing
 * this module used to be the gate's "reproducibility check", but an ESM import
 * is a module-cache hit the second time, so the second hash was of the *first*
 * file and the check could never fail.
 *
 * @param {{ htmlPath?: string, bundlePath?: string, quiet?: boolean }} [opts]
 * @returns {Promise<{ html: string, js: string, htmlHash: string, jsHash: string }>}
 */
export async function build({ htmlPath = 'app-single.html', bundlePath = 'app-bundle.js', quiet = false } = {}) {
  const cwd = process.cwd();
  const order = [
    'dist/engine/tile.js',
    'dist/engine/sample.js',
    'dist/engine/blend.js',
    'dist/engine/tone.js',
    'dist/engine/adjustfn.js',
    'dist/engine/document.js',
    'dist/engine/paint.js',
    'dist/engine/history.js',
    'dist/engine/io.js',
    'dist/engine/adjust.js',
    'dist/engine/filter.js',
    'dist/engine/filters2.js',
    'dist/engine/gradient.js',
    'dist/engine/mask.js',
    'dist/engine/shapes.js',
    'dist/engine/perspective.js',
    'dist/engine/selectops.js',
    'dist/engine/effects-bake.js',
    'dist/engine/psd.js',
    'dist/engine/transform.js',
    'dist/engine/resize.js',
    'dist/engine/imageops.js',
    'dist/engine/move.js',
    'dist/engine/flood.js',
    'dist/engine/retouch.js',
    'dist/engine/plane.js',
    'dist/engine/heal.js',
    'dist/engine/path.js',
    'dist/engine/refine.js',
    'dist/engine/textmap.js',
  'dist/engine/docmeta.js',
    'dist/engine/psdexport.js',
    'dist/engine/tiff.js',
    'dist/ui/icons.js',
    'dist/ui/licence.js',
    'dist/ui/toollabels.js',
    'dist/ui/textseed.js',
    'dist/ui/dialogs.js',
    'dist/ui/popup.js',
    'dist/ui/tabs.js',
    'dist/ui/historypanel.js',
    'dist/ui/palette.js',
    'dist/ui/windowchrome.js',
  'dist/ui/proxykey.js',
    'dist/ui/keymap.js',
  'dist/ui/closeloop.js',
    'dist/ui/shortcuts.js',
    'dist/ui/previewqueue.js',
    'dist/ui/adjust-forms.js',
    'dist/ui/newdoc.js',
    'dist/ui/tonal.js',
    'dist/ui/layerspanel.js',
    'dist/ui/exportdlg.js',
    'dist/ui/notices.js',
    'dist/ui/dock.js',
    'dist/ui/native.js',
    'dist/main.js',
  ];
  // A module that tsc emits but this list forgets is SILENTLY absent from the
  // bundle and shows up at runtime as `undefined is not a function`.
  const emitted = (await walkExt(cwd, 'dist', '.js'))
    // tests (and their harness) are compiled by the same tsc pass but are not
    // part of the shipped bundle — ui tests live beside the modules they test
    .filter((f) => !f.startsWith('dist/engine/tests/') && !f.includes('/tests/'))
    .sort();
  const missing = emitted.filter((f) => !order.includes(f));
  const stale = order.filter((f) => !emitted.includes(f));
  if (missing.length) throw new Error(`single-file: ${missing.join(', ')} compiled but not in the order list`);
  if (stale.length) throw new Error(`single-file: ${stale.join(', ')} in the order list but not compiled (stale dist?)`);

  // Freshness guard: bundling a stale dist/ ships an artifact that disagrees with
  // the sources. The smoke suite silently tested old code this way twice.
  const tsSources = (await walkExt(cwd, 'src', '.ts')).map((f) => f.replace(/^src\//, '')).sort();
  const stalePairs = [];
  for (const src of tsSources) {
    const distFile = 'dist/' + src.replace(/\.ts$/, '.js');
    try {
      const [s, d] = await Promise.all([stat(join(cwd, 'src', src)), stat(join(cwd, distFile))]);
      if (d.mtimeMs + 1 < s.mtimeMs) stalePairs.push(`${src} → ${distFile}`);
    } catch {
      stalePairs.push(`${src} → ${distFile} (missing)`);
    }
  }
  if (stalePairs.length) {
    throw new Error(
      `single-file: dist/ is stale, run \`node node_modules/typescript/bin/tsc\` first:\n  ` +
        stalePairs.slice(0, 8).join('\n  '),
    );
  }

  let js = '';
  for (const f of order) {
    js += `\n// ==== ${f} ====\n` + (await readFile(join(cwd, f), 'utf8'));
  }
  // Strip ESM syntax line-by-line so MULTI-LINE imports (the form prettier emits
  // whenever an import has more than a couple of names) disappear whole instead
  // of leaving an orphaned `} from "./x.js";` that dies as a SyntaxError.
  /**
   * @param {string} src
   * @returns {string}
   */
  function stripModuleSyntax(src) {
    const lines = src.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*import\b/.test(line)) {
        // module specifiers are resolved by concatenation order, so the whole
        // statement goes away; walk to its terminating semicolon
        let terminated = /;\s*$/.test(line);
        let guard = 0;
        while (!terminated && i + 1 < lines.length && guard++ < 64) {
          i++;
          terminated = /;\s*$/.test(lines[i]);
        }
        if (!terminated) throw new Error(`single-file: unterminated import statement near:\n${line}`);
        continue;
      }
      out.push(line.replace(/^export (?=(?:async )?(?:function|const|let|var|class))/, ''));
    }
    return out.join('\n');
  }
  js = stripModuleSyntax(js);

  // The stripper above only understands `export function|const|let|var|class`.
  // Any other ESM form (`export { x }`, `export default`, `export * from`, …)
  // survives into a 1.4 MB inline script and dies as a bare SyntaxError.
  const esmLeft = js.match(/^\s*(?:import|export)\b[^\n]*$/gm);
  if (esmLeft) {
    throw new Error(`single-file: unhandled ESM syntax left in the bundle:\n${esmLeft.slice(0, 5).join('\n')}`);
  }
  const orphanFrom = js.match(/^\s*\}?\s*from\s+["'][^"']+["']/gm);
  if (orphanFrom) {
    throw new Error(`single-file: orphaned import fragment left in the bundle:\n${orphanFrom.slice(0, 5).join('\n')}`);
  }

  // Concatenation flattens module scopes into one script scope: a top-level
  // name declared in two modules becomes a fatal redeclaration SyntaxError
  // that kills the whole app (blank UI). Fail the build instead of shipping it.
  const declRe = /^(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/gm;
  // destructured top-level declarations (`const { a, b: c } = …`, `const [x, y] = …`)
  // bind the LOCAL names a/c/x/y; declRe alone never sees them (handoff-3 T5).
  // Line-scoped: multi-line destructure patterns are out of scope — an actual
  // redeclaration still fails loudly at the vm.Script syntax check below.
  const declDeRe = /^(?:const|let|var)\s*[{\[]([^}\]]+)[}\]]\s*=/gm;
  function destructureNames(raw) {
    const names = [];
    for (const part of raw.split(',')) {
      let t = part.trim().replace(/^\.\.\./, '');
      if (!t) continue;
      t = t.split(':')[1] ?? t; // { a: b } binds b, not a
      t = t.split('=')[0].trim(); // strip defaults
      if (/^[A-Za-z0-9_$]+$/.test(t)) names.push(t);
    }
    return names;
  }
  const owners = new Map();
  for (const f of order) {
    const src = js.slice(js.indexOf(`// ==== ${f} ====`));
    const body = f === order[order.length - 1] ? src : src.slice(0, src.indexOf(`// ==== ${order[order.indexOf(f) + 1]} ====`));
    let m;
    declRe.lastIndex = 0;
    const names = [];
    while ((m = declRe.exec(body)) !== null) names.push(m[1]);
    declDeRe.lastIndex = 0;
    while ((m = declDeRe.exec(body)) !== null) names.push(...destructureNames(m[1]));
    for (const name of names) {
      if (!owners.has(name)) owners.set(name, f);
      else if (owners.get(name) !== f) {
        throw new Error(`single-file collision: "${name}" is declared top-level in both ${owners.get(name)} and ${f} — rename one or share it via import/export`);
      }
    }
  }

  // Wrap the concatenated app in one function scope. The page is a single classic
  // script, so a second copy of it (a double include from an asset/HTML mix-up)
  // would otherwise be a PARSE error — "identifier 'x' has already been declared"
  // — and the window stays blank with no way to recover. Inside an IIFE the second
  // copy simply runs in its own scope.
  // AE4: the wrapper used to turn a double include into a silent double boot —
    // two sets of listeners, two autosave loops, symptoms like "every click
    // happens twice". The sentinel makes a second copy throw immediately.
    const sentinel =
      'if (window.__GUAZZO_BOOTED__) throw new Error("Guazzo bundle included twice");\n' +
      'window.__GUAZZO_BOOTED__ = true;\n';
    js = '"use strict";\n(function () {\n' + sentinel + js + '\n})();\n';

  const vendorTag = '<script src="./vendor/ag-psd-bundle.js"></script>';
  const moduleTag = '<script type="module" src="./dist/main.js"></script>';
  const html = await readFile(join(cwd, 'index.html'), 'utf8');
  if (!html.includes(vendorTag)) throw new Error('index.html: vendor script tag not found');
  if (!html.includes(moduleTag)) throw new Error('index.html: dist script tag not found');
  const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  const wantPsd = (pkg.dependencies?.['ag-psd'] ?? '').replace(/^[^0-9]*/, '');
  const vendor = await readFile(join(cwd, 'vendor/ag-psd-bundle.js'), 'utf8');
  // the vendored copy is the only third-party runtime code: refuse to ship a
  // bundle whose stamped version disagrees with the declared dependency
  const banner = /^\/\* ag-psd ([0-9][0-9A-Za-z.\-]*)/.exec(vendor);
  if (!banner) throw new Error('vendor/ag-psd-bundle.js has no version banner — run scripts/vendor-psd.mjs');
  if (wantPsd && banner[1].trim() !== wantPsd) {
    throw new Error(`vendor ag-psd is ${banner[1].trim()} but package.json declares ${pkg.dependencies['ag-psd']} — run scripts/vendor-psd.mjs`);
  }
  // An inline <script> ends at the first `</script` (and the HTML parser has
  // legacy comment rules for `<!--`), so any such sequence inside the bundled JS
  // would truncate the app mid-script. Escape it the way the spec allows.
  const safeForInline = (/** @type {string} */ code) => code.replace(/<\/(?=script)/gi, '<\\/');
  // Function replacements: a string replacement would interpret `$&`, `$'`, `$\``
  // inside the injected code and silently corrupt the output.
  const out = html
    .replace(vendorTag, () => '<script>\n' + safeForInline(vendor) + '\n</script>')
    .replace(moduleTag, () => `<script>\n${safeForInline(js)}\n</script>`);
  // AU5: the portable file is opened straight from disk, where no host supplies
  // a policy — so the policy has to be IN the file. Every inline script gets a
  // CSP hash of its exact text (CSP hashes the element's body with CR->LF
  // normalisation); anything else is 'none'. No 'unsafe-inline' anywhere in
  // script-src, so a project-injected script cannot run even by a future bug.
  const inlineBodies = [...out.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (inlineBodies.length === 0) throw new Error('single-file: no inline script found to hash for the CSP');
  const scriptHashes = inlineBodies
    .map((body) => `'sha256-${createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`)
    .join(' ');
  const csp =
    "default-src 'none'; " +
    `script-src ${scriptHashes}; ` +
    "style-src 'unsafe-inline'; " +
    "img-src data: blob:; font-src data:; " +
    "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const charset = out.indexOf('<meta charset');
  if (charset < 0) throw new Error('single-file: no <meta charset> to anchor the CSP after');
  const lineEnd = out.indexOf('\n', charset);
  const withCsp = out.slice(0, lineEnd + 1) + '  ' + metaTag + '\n' + out.slice(lineEnd + 1);
  await writeFile(join(cwd, htmlPath), withCsp);

  // Also emit the processed bundle on disk: it lets the dev server run the
  // exact single-file script (http://127.0.0.1:5188/app-bundle.js), which is
  // how the concatenated build gets executed and console-verified pre-ship.
  await writeFile(join(cwd, bundlePath), js);
  if (!quiet) console.log(`wrote ${htmlPath} (${withCsp.length} bytes, CSP with ${inlineBodies.length} script hashes) + ${bundlePath}`);
  return {
    html: withCsp,
    js,
    htmlHash: createHash('sha256').update(withCsp).digest('hex'),
    jsHash: createHash('sha256').update(js).digest('hex'),
  };
}

// Standalone use: `node scripts/single-file.mjs` (the historical entry point).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await build();
