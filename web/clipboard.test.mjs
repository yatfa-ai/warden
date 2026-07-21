// Tests for the Electron-safe clipboard helper in src/lib/clipboard.ts.
//
// copyText prefers navigator.clipboard.writeText, then falls back to a hidden
// textarea + document.execCommand('copy') — the SAME legacy path PaneTile's
// copy-on-select uses (WARDEN-285) — because navigator.clipboard can fail
// silently in Electron (non-secure context / permission denied). That fallback
// is the Electron-safety guarantee and the thing this test locks in: it is hard
// to exercise by hand in a headless sandbox, so we drive it against mocked
// globals here.
//
// Pure global-mockable logic — no React, no DOM at import time — so the
// OXC-transpile-to-temp-`.mjs` + dynamic `import()` harness used by
// selection.test.mjs / kill.test.mjs loads the REAL module and we swap
// globalThis.navigator / globalThis.document between cases (copyText reads them
// at call time, not import time).
//
// Run: node clipboard.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL clipboard.ts (TS -> ESM via OXC) -------------------------
// clipboard.ts has no runtime imports, so no specifier rewriting is needed.
const src = readFileSync(join(libDir, 'clipboard.ts'), 'utf8');
const { code } = await transformWithOxc(src, join(libDir, 'clipboard.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-clipboard-test-'));
const file = join(tmpDir, 'clipboard.mjs');
writeFileSync(file, code);
const { copyText, handleOsc52 } = await import(file);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const testAsync = (name, fn) => fn().then(() => { passed += 1; console.log('  ok -', name); });

// Node 21+ ships globalThis.navigator as a getter-only accessor (undici: get,
// configurable, but no setter), so direct assignment throws:
//   globalThis.navigator = {...}  → TypeError: ... only a getter
// (this is why the file used to crash at the first mock-setup, before any
// assertion ran — a red suite asserting nothing, per the WARDEN-739 lesson).
// defineProperty redefines it cleanly on all Node versions: the descriptor is
// configurable, so it installs on ≥21 and overwrites the plain data property on
// ≤20. document has no global today, but routing it through the same helper is
// free symmetry and future-proofs against Node shipping it as an accessor too.
const setGlobal = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

// Save originals (Node 24 has a navigator global; document is undefined) and
// restore after every case so mocks never leak across tests.
const realNavigator = globalThis.navigator;
const realDocument = globalThis.document;
const restore = () => {
  setGlobal('navigator', realNavigator);
  setGlobal('document', realDocument);
};

// A mock DOM whose textarea captures the copied value and whose execCommand
// reports whether it "succeeded". Mirrors the real fallback's element lifecycle
// (createElement → set value → append → select → execCommand → removeChild).
function mockDoc({ execReturns = true } = {}) {
  let taValue;
  const ta = {
    style: {},
    select() {},
    set value(v) { taValue = v; },
    get value() { return taValue; },
  };
  let execCalled = false;
  return {
    document: {
      createElement: () => ta,
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => { execCalled = true; return execReturns; },
    },
    captured: () => taValue,
    execCalled: () => execCalled,
  };
}

// ---------------------------------------------------------------------------
console.log('\nasync Clipboard API path');
// ---------------------------------------------------------------------------
await testAsync('navigator.clipboard.writeText succeeds → true, text passed through', async () => {
  let saved;
  setGlobal('document', undefined);
  setGlobal('navigator', { clipboard: { writeText: async (t) => { saved = t; } } });
  const ok = await copyText('hello');
  assert.equal(ok, true);
  assert.equal(saved, 'hello');
  restore();
});

// ---------------------------------------------------------------------------
console.log('\nexecCommand fallback path');
// ---------------------------------------------------------------------------
await testAsync('no clipboard API → execCommand fallback, textarea holds the text', async () => {
  const m = mockDoc();
  setGlobal('navigator', {});
  setGlobal('document', m.document);
  const ok = await copyText('fallback!');
  assert.equal(ok, true);
  assert.equal(m.execCalled(), true);
  assert.equal(m.captured(), 'fallback!');
  restore();
});

await testAsync('clipboard.writeText rejects → falls through to execCommand fallback', async () => {
  const m = mockDoc();
  setGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
  setGlobal('document', m.document);
  const ok = await copyText('recover');
  assert.equal(ok, true);
  assert.equal(m.execCalled(), true);
  assert.equal(m.captured(), 'recover');
  restore();
});

await testAsync('execCommand returns false → false (copy unsupported)', async () => {
  const m = mockDoc({ execReturns: false });
  setGlobal('navigator', {});
  setGlobal('document', m.document);
  const ok = await copyText('unsupported');
  assert.equal(ok, false);
  assert.equal(m.execCalled(), true);
  restore();
});

await testAsync('no clipboard API and no document → false (nothing to copy with)', async () => {
  setGlobal('navigator', {});
  setGlobal('document', undefined);
  const ok = await copyText('nowhere');
  assert.equal(ok, false);
  restore();
});

// ---------------------------------------------------------------------------
console.log('\nOSC 52 clipboard handler (WARDEN-437)');
// ---------------------------------------------------------------------------
// handleOsc52 is the xterm parser handler for OSC 52 (the standard terminal
// clipboard protocol). SET writes the decoded base64 to the system clipboard via
// copyText; QUERY is ignored so a remote program can never read the local
// clipboard. copyText runs async (fire-and-forgot inside handleOsc52), so each
// case flushes pending promises before asserting what was (or wasn't) copied.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Wire the async Clipboard API path (navigator.clipboard.writeText) so we can
// observe exactly what handleOsc52 copies; no document → no execCommand fallback.
const clipCapture = () => {
  let saved;
  setGlobal('document', undefined);
  setGlobal('navigator', { clipboard: { writeText: async (t) => { saved = t; } } });
  return { get saved() { return saved; } };
};

await testAsync('SET (c;<base64>) decodes ASCII and writes the clipboard', async () => {
  const clip = clipCapture();
  const ok = handleOsc52('c;' + Buffer.from('hello', 'utf-8').toString('base64'));
  await flush();
  assert.equal(ok, true, 'always handled (suppresses any fallback)');
  assert.equal(clip.saved, 'hello');
  restore();
});

await testAsync('SET decodes multibyte UTF-8 (accents + emoji) correctly', async () => {
  const clip = clipCapture();
  const text = 'café — ☕ sélection';
  handleOsc52('c;' + Buffer.from(text, 'utf-8').toString('base64'));
  await flush();
  assert.equal(clip.saved, text);
  restore();
});

await testAsync('SET with several selectors (cps0;<base64>) still finds the payload', async () => {
  const clip = clipCapture();
  handleOsc52('cps0;' + Buffer.from('multi', 'utf-8').toString('base64'));
  await flush();
  assert.equal(clip.saved, 'multi');
  restore();
});

await testAsync('QUERY (c;?) does NOT read/copy the clipboard (security)', async () => {
  const clip = clipCapture();
  const ok = handleOsc52('c;?');
  await flush();
  assert.equal(ok, true, 'a query is still claimed handled — no fallback may answer it');
  assert.equal(clip.saved, undefined, 'a query must never trigger a clipboard write');
  restore();
});

await testAsync('QUERY with no payload (bare "c") does NOT copy', async () => {
  const clip = clipCapture();
  handleOsc52('c');
  await flush();
  assert.equal(clip.saved, undefined);
  restore();
});

await testAsync('empty payload (c;) does NOT copy', async () => {
  const clip = clipCapture();
  handleOsc52('c;');
  await flush();
  assert.equal(clip.saved, undefined);
  restore();
});

await testAsync('malformed base64 is ignored (never throws, never copies)', async () => {
  const clip = clipCapture();
  const ok = handleOsc52('c;@@@not-base64@@@');
  await flush();
  assert.equal(ok, true);
  assert.equal(clip.saved, undefined);
  restore();
});

console.log(`\n✓ CLIPBOARD TESTS PASS (${passed})`);
