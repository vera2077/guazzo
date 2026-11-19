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
import { readFileSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// --- 1. tsc, in-process -------------------------------------------------
const configPath = join(process.cwd(), 'tsconfig.json');
const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
if (rawConfig.error) die(`cannot read tsconfig.json: ${rawConfig.error.messageText}`);
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
console.log(`build-desktop: tsc ok (${parsed.fileNames.length} files → dist/)`);

// --- 2. version lockstep ------------------------------------------------
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!(pkg.version === conf.version && conf.version === cargo)) {
  die(
    `versions disagree: package.json=${pkg.version} tauri.conf.json=${conf.version} Cargo.toml=${cargo} — ` +
      'run `node scripts/bump.mjs <version>`',
  );
}
console.log(`build-desktop: version lockstep ok (${pkg.version})`);

// --- 3. single-file bundle (imports run its top-level code + guards) ----
await import('./single-file.mjs');

// --- 4. bundle syntax check ---------------------------------------------
const bundleCode = readFileSync('app-bundle.js', 'utf8');
try {
  new Script(bundleCode, { filename: 'app-bundle.js' });
} catch (err) {
  die(`app-bundle.js does not parse: ${err.message}`);
}
console.log(`build-desktop: app-bundle.js syntax ok (${bundleCode.length} bytes)`);

// --- 5./6. desktop-dist freshness + regenerate ---------------------------
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
