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
const { copyText } = await import(file);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const testAsync = (name, fn) => fn().then(() => { passed += 1; console.log('  ok -', name); });

// Save originals (Node 24 has a navigator global; document is undefined) and
// restore after every case so mocks never leak across tests.
const realNavigator = globalThis.navigator;
const realDocument = globalThis.document;
const restore = () => {
  globalThis.navigator = realNavigator;
  globalThis.document = realDocument;
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
  globalThis.document = undefined;
  globalThis.navigator = { clipboard: { writeText: async (t) => { saved = t; } } };
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
  globalThis.navigator = {};
  globalThis.document = m.document;
  const ok = await copyText('fallback!');
  assert.equal(ok, true);
  assert.equal(m.execCalled(), true);
  assert.equal(m.captured(), 'fallback!');
  restore();
});

await testAsync('clipboard.writeText rejects → falls through to execCommand fallback', async () => {
  const m = mockDoc();
  globalThis.navigator = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
  globalThis.document = m.document;
  const ok = await copyText('recover');
  assert.equal(ok, true);
  assert.equal(m.execCalled(), true);
  assert.equal(m.captured(), 'recover');
  restore();
});

await testAsync('execCommand returns false → false (copy unsupported)', async () => {
  const m = mockDoc({ execReturns: false });
  globalThis.navigator = {};
  globalThis.document = m.document;
  const ok = await copyText('unsupported');
  assert.equal(ok, false);
  assert.equal(m.execCalled(), true);
  restore();
});

await testAsync('no clipboard API and no document → false (nothing to copy with)', async () => {
  globalThis.navigator = {};
  globalThis.document = undefined;
  const ok = await copyText('nowhere');
  assert.equal(ok, false);
  restore();
});

console.log(`\n✓ CLIPBOARD TESTS PASS (${passed})`);
