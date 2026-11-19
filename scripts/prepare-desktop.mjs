// prepare-desktop.mjs — builds desktop-dist/, the folder Tauri embeds as the
// frontend. The single-file build IS the desktop frontend: one self-contained
// HTML page (engine + UI + vendored ag-psd, zero external requests), copied
// in as index.html.
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const cwd = process.cwd();
const OUT = join(cwd, 'desktop-dist');
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await copyFile(join(cwd, 'app-single.html'), join(OUT, 'index.html'));
console.log('desktop-dist ready (index.html from app-single.html)');
