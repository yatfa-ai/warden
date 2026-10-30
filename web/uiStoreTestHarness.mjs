// ONE home for the uiStore transpile emit graph shared by web/uiStore.test.mjs,
// web/layout.test.mjs and web/paneGrid.test.mjs: the Map-backed localStorage
// polyfill, the TS→ESM emit primitive, and the emitted-module closure over
// uiStore.ts's `@/lib/*` VALUE imports with their import-specifier rewrites.
//
// WHY THIS EXISTS: that graph used to be hand-copied into all three harnesses,
// so every time uiStore.ts gained a new `@/lib/<module>` VALUE import all three
// copies had to be extended in lockstep. This detonated twice — WARDEN-1574
// (uiStore gained the themes import) and WARDEN-1778 (uiStore gained the
// selection import) each had to patch all three files, and a missed harness
// dies at import with `Cannot find package '@/lib'`, surfacing as an opaque
// `not ok` under `npm test` while uiStore.test.mjs alone stays green
// (WARDEN-1071 §3b).
//
// THE CONTRACT: when uiStore.ts gains a new `@/lib/<module>` VALUE import,
// the fix is a ONE-file edit in HERE — emit the new module and rewrite its
// specifier on the uiStore emit below. Type-only imports need nothing (OXC
// erases them). Harnesses that emit modules OUTSIDE this graph (quickReply,
// resetUiPrefs, paneGrid) call `emitModule` themselves at their own call sites.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The Map the polyfill reads, exposed so a harness that resets persistence
// between tests (uiStore.test.mjs's `reset()`) clears the SAME Map the
// polyfill reads — hiding it would turn those resets into silent no-ops and
// break test isolation without any visible test-count change.
export const localStorageMemory = new Map();

function installLocalStoragePolyfill() {
  globalThis.localStorage = {
    getItem: (k) => (localStorageMemory.has(k) ? localStorageMemory.get(k) : null),
    setItem: (k, v) => { localStorageMemory.set(k, String(v)); },
    removeItem: (k) => { localStorageMemory.delete(k); },
    clear: () => { localStorageMemory.clear(); },
  };
}

// Transpile ONE real module (TS → ESM via the OXC transform Vite bundles) into
// `tmpDir` under `outName`, applying `rewrite` to the emitted code. `tmpDir` is
// NEVER removed here — the caller owns its lifecycle and rmSync's it after its
// own imports — and must live INSIDE web/ whenever a module carries a bare
// specifier (`zustand`): Node resolves those by walking up from the importing
// file, so the emitted module must sit under web/'s node_modules ancestry.
export async function emitModule(tmpDir, relPath, outName, rewrite = (c) => c) {
  const absPath = resolve(__dirname, relPath);
  const { code } = await transformWithOxc(readFileSync(absPath, 'utf8'), absPath, {});
  writeFileSync(join(tmpDir, outName), rewrite(code));
}

// The uiStore emit graph: install the polyfill (uiStore.ts and storage.ts
// beneath it seed themselves from loadUi() at module load, so it must exist
// before any emitted module is imported — exactly as in the browser), then
// emit uiStore's `@/lib/*` VALUE-import closure (themes, storage, layout,
// paneAttach, selection, uiStore) into `tmpDir`, rewriting each `@/lib/*`
// specifier on the emitted uiStore to its emitted sibling. Import order is
// irrelevant — nothing resolves until all modules are written — and `tmpDir`
// (inside web/, see emitModule) is left for the caller to import from.
export async function emitUiStoreGraph(tmpDir) {
  installLocalStoragePolyfill();
  await emitModule(tmpDir, 'src/lib/themes.ts', 'themes.mjs');
  await emitModule(tmpDir, 'src/lib/storage.ts', 'storage.mjs', (c) => c.replaceAll('@/lib/themes', './themes.mjs'));
  await emitModule(tmpDir, 'src/lib/layout.ts', 'layout.mjs');
  await emitModule(tmpDir, 'src/lib/paneAttach.ts', 'paneAttach.mjs');
  await emitModule(tmpDir, 'src/lib/selection.ts', 'selection.mjs');
  await emitModule(tmpDir, 'src/lib/uiStore.ts', 'uiStore.mjs', (c) => c.replaceAll('@/lib/storage', './storage.mjs').replaceAll('@/lib/layout', './layout.mjs').replaceAll('@/lib/paneAttach', './paneAttach.mjs').replaceAll('@/lib/selection', './selection.mjs').replaceAll('@/lib/themes', './themes.mjs'));
}
