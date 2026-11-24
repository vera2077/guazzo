// build-desktop.mjs — the ONE-COMMAND web pipeline that feeds the Tauri exe.
// Runs, in order, all in-process (the dev sandbox forbids child_process spawn,
// so every step below is a library call, never a spawned binary):
//   1. TypeScript compile of src/ → dist/  (via the typescript npm API)
//   2. version-consistency assert          (package.json = Cargo.toml = tauri.conf.json)
//   3. single-file bundle                 (scripts/single-file.mjs — has its own
//                                           src→dist staleness guard + bundle checks)
//   4. app-bundle.js syntax check          (vm.Script compiles the whole bundle)
//   5. freshness assert                   (desktop-dist/index.html ≥ app-single.html)
//   6. desktop-dist regeneration          (scripts/prepare-desktop.mjs)
// Then it prints the cargo command — cargo itself still runs from the shell:
//   cd src-tauri && CARGO_HOME=../.cargo-home cargo build --release
// A stale exe can never be produced: build.rs independently re-checks that
// desktop-dist/index.html is newer than every file in ../src, and refuses to
// compile otherwise.
import { createRequire } from 'node:module';
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPT_NAME, writeBuildReceipt } from './build-inputs.mjs';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
// pnpm junctions do not resolve bare specifiers in this sandbox's node build
// (the ag-psd lesson), so prefer the REAL .pnpm path and fall back to the
// plain specifier for normal machines.
let ts;
try {
  ts = require('typescript');
} catch {
  ts = require(require
    .resolve('typescript/lib/typescript.js', {
      paths: [join(process.cwd(), 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript')],
    }));
}

function die(msg) {
  console.error(`build-desktop: ${msg}`);
  process.exit(1);
}

// --- 0. notices freshness (W3) -----------------------------------------
// THIRD-PARTY-NOTICES.md is the single source of truth; src/ui/notices.ts is
// its generated embed. A stale embed ships an About dialog that disagrees with
// the LICENSES that reach the user, so regenerate instead of trusting hand-edits.
{
  // LICENSE is the EULA the About dialog shows, so it needs the same gate:
  // editing only the licence used to leave an old copy embedded forever.
  const mdM = Math.max(
    statSync('THIRD-PARTY-NOTICES.md').mtimeMs,
    statSync('LICENSE').mtimeMs,
  );
  const tsM = statSync('src/ui/notices.ts').mtimeMs;
  if (mdM > tsM) {
    await import('./embed-notices.mjs');
    console.log('build-desktop: notices were stale — regenerated src/ui/notices.ts');
  }
}

// --- 0b. release guard: no placeholder copyright (W1) -------------------
// LICENSE and the About dialog must name the real owner. Shipping the literal
// "<COPYRIGHT HOLDER>" is a legal defect, so it fails the build unless the
// developer explicitly opts out (GUAZZO_ALLOW_PLACEHOLDER=1) for a local test
// build that will never be distributed.
{
  const holders = [];
  if (readFileSync('LICENSE', 'utf8').includes('<COPYRIGHT HOLDER>')) holders.push('LICENSE');
  if (readFileSync('src/main.ts', 'utf8').includes('"<COPYRIGHT HOLDER>"')) holders.push('src/main.ts OWNER_NAME');
  if (holders.length > 0) {
    if (process.env.GUAZZO_ALLOW_PLACEHOLDER === '1') {
      console.warn(`build-desktop: WARNING placeholder copyright in ${holders.join(', ')} — GUAZZO_ALLOW_PLACEHOLDER=1, this build must not ship`);
    } else {
      die(
        `placeholder copyright in ${holders.join(', ')} — set OWNER_NAME/LICENSE to the legal entity ` +
          '(or export GUAZZO_ALLOW_PLACEHOLDER=1 for a throwaway local build)',
      );
    }
  }
}

// --- 1. tsc, in-process -------------------------------------------------
const configPath = join(process.cwd(), 'tsconfig.json');
const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
if (rawConfig.error) die(`cannot read tsconfig.json: ${rawConfig.error.messageText}`);
// A file that stops being compiled leaves its old dist/ output behind, and the
// bundler then treats that stale module as an input: an untracked wasm.ts
// excluded from tsconfig still collided with the bundle (code-r40 #2). Start
// from an empty dist/ so the compile's outputs are the module list.
rmSync(join(process.cwd(), 'dist'), { recursive: true, force: true });
const parsed = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, process.cwd());
if (parsed.errors.length) {
  die(`tsconfig errors: ${ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, '\n')}`);
}
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  const host = {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
  };
  console.error(ts.formatDiagnostics(diagnostics.slice(0, 20), host));
  die(`tsc reported ${diagnostics.length} error(s) — dist/ was NOT rebuilt`);
}
const emitResult = program.emit();
if (emitResult.emitSkipped) die('tsc emit was skipped — dist/ may be stale');
// The WASM adapter is excluded from the main tsconfig so its emitted
// __rewriteRelativeImportExtension helper cannot collide with main.js in the
// single-file bundle. Compile it on its own; it has no static imports.
const wasmAdapter = join(process.cwd(), 'src/engine/wasm.ts');
try {
  statSync(wasmAdapter);
  const wasmOptions = {
    ...parsed.options,
    rewriteRelativeImportExtensions: false,
    allowImportingTsExtensions: false,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };
  const wasmProgram = ts.createProgram([wasmAdapter], wasmOptions);
  const wasmDiagnostics = ts.getPreEmitDiagnostics(wasmProgram);
  if (wasmDiagnostics.length) {
    const host = {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (f) => f,
      getNewLine: () => '\n',
    };
    console.error(ts.formatDiagnostics(wasmDiagnostics.slice(0, 20), host));
    die(`tsc reported ${wasmDiagnostics.length} error(s) in the WASM adapter — dist/ was NOT rebuilt`);
  }
  if (wasmProgram.emit().emitSkipped) die('tsc emit for the WASM adapter was skipped');
} catch { /* adapter absent in a TypeScript-only checkout */ }
console.log(`build-desktop: tsc ok (${parsed.fileNames.length} files → dist/)`);

// --- 2. version lockstep ------------------------------------------------
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
// W5: the fourth carrier — the string the running app shows in its About
// dialog. Asserting three of four let a bumped exe still report the old version.
const appVer = readFileSync('src/main.ts', 'utf8').match(/const APP_VERSION = "([^"]+)"/)?.[1];
if (!(pkg.version === conf.version && conf.version === cargo && cargo === appVer)) {
  die(
    `versions disagree: package.json=${pkg.version} tauri.conf.json=${conf.version} ` +
      `Cargo.toml=${cargo} src/main.ts APP_VERSION=${appVer} — run \`node scripts/bump.mjs <version>\``,
  );
}
console.log(`build-desktop: version lockstep ok (${pkg.version} × 4 carriers)`);

// --- 3. single-file bundle (imports run its top-level code + guards) ----
const { build } = await import('./single-file.mjs');
await build();

// --- 4. bundle syntax check ---------------------------------------------
const bundleCode = readFileSync('app-bundle.js', 'utf8');
try {
  new Script(bundleCode, { filename: 'app-bundle.js' });
} catch (err) {
  die(`app-bundle.js does not parse: ${err.message}`);
}
console.log(`build-desktop: app-bundle.js syntax ok (${bundleCode.length} bytes)`);

// --- 5./6. desktop-dist freshness + regenerate ---------------------------

// AE3: the freshness chain used to stop at src/ — a rebuilt vendor blob or a
// changed package.json (which the vendor banner is validated against) could
// leave a bundle that claims to match a dependency it no longer matches.
const watched = [
  ['vendor/ag-psd-bundle.js', 'the vendored PSD codec'],
  ['package.json', 'the dependency ranges'],
  ['LICENSE', 'the licence text embedded in About'],
  ['THIRD-PARTY-NOTICES.md', 'the notices text embedded in About'],
  ['LICENSE', 'the licence text embedded in About'],
];
for (const [file, what] of watched) {
  const m = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (m > statSync('app-bundle.js').mtimeMs) {
    die(`build-desktop: ${file} (${what}) is newer than app-bundle.js — rerun the build`);
  }
}

const singleMtime = statSync('app-single.html').mtimeMs;
const indexMtime = statSync('desktop-dist/index.html', { throwIfNoEntry: false })?.mtimeMs ?? 0;
if (indexMtime < singleMtime) {
  console.log('build-desktop: desktop-dist/index.html is older than app-single.html — regenerating');
}
await import('./prepare-desktop.mjs');

// final assert: the embedded page really is the fresh build
const indexBytes = statSync('desktop-dist/index.html').size;
const singleBytes = statSync('app-single.html').size;
if (indexBytes !== singleBytes) die('desktop-dist/index.html size mismatch — copy failed');
console.log(
  `build-desktop: desktop-dist ok (${indexBytes} bytes). ` +
    'Next: cd src-tauri && CARGO_HOME=../.cargo-home cargo build --release',
);

// --- 7. force the Rust crate to re-embed the page -----------------------
// `tauri_build` compresses desktop-dist into OUT_DIR from the build script, and
// the crate picks it up through `generate_context!()`. Cargo decides whether the
// crate itself is fresh from its own inputs, so a page-only change can leave an
// exe embedding last round's HTML — which looks identical to a code bug in the
// running app. Touching main.rs makes the recompile (and the embed) mandatory.
const mainRs = 'src-tauri/src/main.rs';
const now = new Date();
utimesSync(mainRs, now, now);
console.log('build-desktop: touched src-tauri/src/main.rs so cargo re-embeds the page');

// --- 8. build receipt ---------------------------------------------------
// release.mjs re-hashes this same set and refuses to stage when anything
// changed after the build. The file is ignored by git; it describes one build.
const { path: receiptPath, receipt } = writeBuildReceipt(process.cwd(), { version: pkg.version });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`build-desktop: wrote ${RECEIPT_NAME} (${receipt.files.length} inputs, ${receipt.digest.slice(0, 12)})`);
