// bump.mjs — single-source versioning for Pigment.
// Usage:  node scripts/bump.mjs 0.24.0        (bump all three files)
//         node scripts/bump.mjs --check      (assert they agree, change nothing)
// The three files that MUST stay in lockstep:
//   app/package.json                "version"
//   app/src-tauri/Cargo.toml        ^version = "x.y.z"
//   app/src-tauri/tauri.conf.json   "version": "x.y.z"
import { readFileSync, writeFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const write = (p, s) => writeFileSync(new URL(p, import.meta.url), s);

const pkg = JSON.parse(read('../package.json'));
const conf = JSON.parse(read('../src-tauri/tauri.conf.json'));
const cargo = read('../src-tauri/Cargo.toml');
const cargoMatch = cargo.match(/^version\s*=\s*"([^"]+)"/m);

const current = { package: pkg.version, tauri: conf.version, cargo: cargoMatch?.[1] };

function check() {
  const bad = Object.entries(current).filter(([, v]) => v !== pkg.version);
  if (bad.length) {
    throw new Error(
      `bump: versions disagree — package.json=${current.package}, tauri.conf.json=${current.tauri}, Cargo.toml=${current.cargo}. ` +
        'Fix by running: node scripts/bump.mjs <version>',
    );
  }
  console.log(`bump: all three files agree on ${pkg.version}`);
}

const arg = process.argv[2];
if (arg === '--check') {
  check();
} else if (arg && /^\d+\.\d+\.\d+$/.test(arg)) {
  check(); // refuse to bump a disagreeing tree
  pkg.version = arg;
  write('../package.json', JSON.stringify(pkg, null, 2) + '\n');
  write('../src-tauri/tauri.conf.json', JSON.stringify({ ...conf, version: arg }, null, 2) + '\n');
  write('../src-tauri/Cargo.toml', cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${arg}"`));
  console.log(`bump: ${current.package} → ${arg} in package.json, Cargo.toml, tauri.conf.json`);
} else {
  console.error('usage: node scripts/bump.mjs <x.y.z>  |  node scripts/bump.mjs --check');
  process.exitCode = 1;
}
