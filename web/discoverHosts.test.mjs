// Tests for discoverHosts — the Open Chat browser's persisted host multiselect
// (localStorage key `warden:discover-hosts:v1`). WARDEN-1230 fixed both halves of
// this persistence after they were found coupled:
//
//   READ  — the old fallback `JSON.parse(localStorage.getItem(KEY) || '')` throws
//           on its own '' fallback, so every FIRST RUN (missing key → null → ''
//           → SyntaxError) was a caught parse failure: the catch was load-bearing
//           for the normal case and could not tell "nothing stored yet" from
//           "stored data is corrupt". The fix parses `?? 'null'`, so absence is
//           handled by the Array.isArray guard, silently — and only a genuinely
//           corrupt stored value warns.
//   WRITE — the old catch was `/* ignore */`, the only silent one of the ten
//           local-storage writers in the app. The fix console.warn's with the
//           `[warden:discoverHosts]` namespace, matching the eight convention
//           sites (saveUi / saveObs / stampLastSeen / saveWatchMissLog / …).
//
// The functions live in src/lib/discoverHosts.ts (extracted from
// OpenChatBrowserPage.tsx — the same unit-testability move as @/lib/chatDisplay
// and @/lib/agentFilter) and are loaded REAL (transpiled TS -> ESM via Vite's
// OXC transform), like watchCatchup.test.mjs. localStorage is a minimal
// in-memory shim, and console.warn is spied so the tests assert the warn FIRES
// (with the convention's exact namespaced message) for real failures and does
// NOT fire for a first run.
//
// Auto-discovered by `npm test` (`node --test` runs every *.test.mjs in web/).
//
// Run: node discoverHosts.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/discoverHosts.ts');

// --- Load the REAL discoverHosts.ts (TS -> ESM via the OXC transform) ----------
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-discover-hosts-test-'));
const tmpFile = join(tmpDir, 'discoverHosts.mjs');
writeFileSync(tmpFile, code);
const { DISCOVER_HOSTS_KEY, loadDiscoverHosts, saveDiscoverHosts } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- Minimal localStorage shim (getItem/setItem/removeItem) --------------------
// Backed by a Map; reset before each test so they are independent. A quota error
// is simulated per-test by swapping setItem, as in watchCatchup.test.mjs.
const store = new Map();
const resetStore = () => store.clear();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

// --- console.warn spy ----------------------------------------------------------
// Collects warn calls so tests can assert BOTH halves of the convention: the
// namespaced message fires for real failures, and stays silent for absence.
const warns = [];
const realWarn = console.warn;
function spyWarns(fn) {
  warns.length = 0;
  console.warn = (...args) => warns.push(args);
  try {
    return fn();
  } finally {
    console.warn = realWarn;
  }
}

// ---------------------------------------------------------------------------
console.log('\nread half: first run is absence, not a parse failure');

test('first run (nothing stored) returns undefined and does NOT warn', () => {
  resetStore();
  let out;
  let threw = false;
  try {
    out = spyWarns(() => loadDiscoverHosts());
  } catch {
    threw = true;
  }
  // The load-bearing regression: the old `|| ''` fallback threw SyntaxError on
  // every first run, so absence rode the catch. Absence must be silent.
  assert.equal(threw, false);
  assert.equal(out, undefined);
  assert.equal(warns.length, 0, `expected no warn on first run, got: ${JSON.stringify(warns)}`);
});

test('stored array loads back with non-string entries dropped', () => {
  resetStore();
  store.set(DISCOVER_HOSTS_KEY, JSON.stringify(['host-a', 42, null, 'host-b', { nope: true }]));
  assert.deepEqual(loadDiscoverHosts(), ['host-a', 'host-b']);
});

test('stored empty array round-trips as [] — an explicit empty selection is not a first run', () => {
  resetStore();
  store.set(DISCOVER_HOSTS_KEY, '[]');
  // The component's `selected: string[] | undefined` treats undefined as "first
  // run → default later"; [] is a real (deselected-everything) selection.
  assert.deepEqual(loadDiscoverHosts(), []);
});

test('valid JSON that is not an array → undefined, silently (guard handles schema mismatch)', () => {
  resetStore();
  for (const v of ['{"hosts": true}', '42', '"host-a"', 'null']) {
    store.set(DISCOVER_HOSTS_KEY, v);
    let out;
    let threw = false;
    try {
      out = spyWarns(() => loadDiscoverHosts());
    } catch {
      threw = true;
    }
    assert.equal(threw, false, `should not throw for stored ${v}`);
    assert.equal(out, undefined, `stored ${v} should read as undefined`);
    assert.equal(warns.length, 0, `stored ${v} should not warn (no parse failure)`);
  }
});

test('corrupt stored JSON → undefined AND the namespaced warn (never throws)', () => {
  resetStore();
  store.set(DISCOVER_HOSTS_KEY, '{not json');
  let out;
  let threw = false;
  try {
    out = spyWarns(() => loadDiscoverHosts());
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'corrupt data must never throw');
  assert.equal(out, undefined);
  // The convention form: namespaced message + the error object as second arg.
  assert.deepEqual(
    warns.map((a) => a[0]),
    ['[warden:discoverHosts] loadDiscoverHosts failed, ignoring stored hosts'],
  );
  assert.ok(warns[0][1] instanceof Error, 'the caught error must be passed through');
});

// ---------------------------------------------------------------------------
console.log('\nwrite half: a failed save surfaces instead of vanishing');

test('save → load round-trips the host selection', () => {
  resetStore();
  saveDiscoverHosts(['host-a', 'host-b']);
  assert.deepEqual(loadDiscoverHosts(), ['host-a', 'host-b']);
});

test('save writes the JSON array under the exact key', () => {
  resetStore();
  saveDiscoverHosts(['host-a']);
  assert.equal(store.get(DISCOVER_HOSTS_KEY), JSON.stringify(['host-a']));
});

test('save never throws on quota — and warns via the namespaced message', () => {
  resetStore();
  const realSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  let threw = false;
  try {
    spyWarns(() => saveDiscoverHosts(['host-a']));
  } catch {
    threw = true;
  }
  globalThis.localStorage.setItem = realSet;
  assert.equal(threw, false, 'a full localStorage must never crash the host picker');
  // The old code's `/* ignore */` discarded this entirely.
  assert.deepEqual(
    warns.map((a) => a[0]),
    ['[warden:discoverHosts] saveDiscoverHosts failed'],
  );
  assert.ok(warns[0][1] instanceof Error, 'the caught error must be passed through');
  assert.equal(warns[0][1].message, 'QuotaExceeded');
});

test('a save recovers a corrupt stored value (next load is clean)', () => {
  resetStore();
  store.set(DISCOVER_HOSTS_KEY, '{not json');
  saveDiscoverHosts(['host-a']);
  assert.deepEqual(loadDiscoverHosts(), ['host-a']);
});

// ---------------------------------------------------------------------------
console.log('\nboth halves together: a first run through the real save/load cycle');

test('fresh session: silent undefined load, silent successful save, then clean load', () => {
  resetStore();
  // First run: absent key, no warn (read half fixed).
  let first;
  spyWarns(() => { first = loadDiscoverHosts(); });
  assert.equal(first, undefined);
  assert.equal(warns.length, 0, 'first run must be silent');
  // A successful save is silent too — only FAILURES warn.
  spyWarns(() => saveDiscoverHosts(['host-a']));
  assert.equal(warns.length, 0, 'successful save must be silent');
  // Second load sees the saved value.
  assert.deepEqual(loadDiscoverHosts(), ['host-a']);
});
