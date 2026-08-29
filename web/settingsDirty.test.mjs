// Tests for the unsaved-backend-edits dirty check behind the Settings discard
// guard (WARDEN-906).
//
// No front-end test runner in this repo, so (like attentionRollup.test.mjs) this
// loads the REAL src/components/settings/configDirty.ts (transpiled TS -> ESM via
// Vite's OXC transform) and exercises the PURE helpers with plain objects. The
// module's only import is an `import type`, erased at transpile time, so the
// emitted module loads standalone.
//
// Under test: `isBackendConfigDirty` (the rule SettingsPage gates Back/Cancel on)
// and the `deepEqual` it is built from. The behaviors that matter:
//   - no baseline yet (load pending/failed)      → NOT dirty (leave freely)
//   - an untouched loaded config                 → NOT dirty
//   - any config edit, incl. nested llm / hosts / watchPatterns → dirty
//   - a typed write-only secret / armed Remove   → dirty (config is unchanged!)
//   - whitespace-only secret                     → NOT dirty (save trims + omits)
//   - the post-save re-baseline                  → NOT dirty (save-then-close)
//
// Run: node settingsDirty.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/components/settings/configDirty.ts');

// --- Load the REAL configDirty.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-dirty-test-'));
const tmpFile = join(tmpDir, 'configDirty.mjs');
writeFileSync(tmpFile, code);
const { isBackendConfigDirty, deepEqual } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A representative slice of the loaded ConfigData: a flat scalar, a nested
// object (llm), a string array (hosts), and an object array (watchPatterns) —
// the four shapes the comparison has to handle.
const CONFIG = {
  hosts: ['alpha', 'beta'],
  pollIntervalMs: 1500,
  tmuxSession: 'agent',
  observerConfirmMode: 'always',
  llm: { model: 'claude-x', baseUrl: 'https://api.example', maxTokens: null },
  healthWarningThresholdMin: 5,
  webhookUrl: '',
  webhookEnabled: false,
  telemetryEndpoint: '',
  watchPatterns: [{ id: 'p1', pattern: 'ERROR', label: 'errors' }],
};

// Deep-clone so a "no edits" draft is a DIFFERENT object graph with the same
// values — the case a reference compare would wrongly call dirty.
const clone = (v) => JSON.parse(JSON.stringify(v));

// A draft/baseline snapshot: the config plus the three write-only secrets,
// which default to "nothing typed, no Remove armed" exactly as a fresh load does.
const draft = (over = {}) => ({
  config: clone(CONFIG),
  observerAuthTokenInput: '',
  observerAuthTokenPendingClear: false,
  webhookSecretInput: '',
  webhookSecretPendingClear: false,
  telemetryAuthTokenInput: '',
  telemetryAuthTokenPendingClear: false,
  ...over,
});
// The edited-config shorthand: same snapshot, config patched.
const edited = (patch) => draft({ config: { ...clone(CONFIG), ...patch } });

console.log('\nbaseline absence + the untouched form → never dirty');
test('null baseline (GET pending or failed) → NOT dirty', () => {
  assert.equal(isBackendConfigDirty(draft(), null), false);
});
test('an untouched load (equal values, different object graph) → NOT dirty', () => {
  assert.equal(isBackendConfigDirty(draft(), draft()), false, 'value compare, not reference compare');
});

console.log('\nany backend-config edit → dirty');
test('a scalar edit (attention threshold) → dirty', () => {
  assert.equal(isBackendConfigDirty(edited({ healthWarningThresholdMin: 12 }), draft()), true);
});
test('a typed webhook URL (the ticket scenario) → dirty', () => {
  assert.equal(isBackendConfigDirty(edited({ webhookUrl: 'https://ntfy.sh/mine' }), draft()), true);
});
test('a NESTED edit (observer model inside llm) → dirty', () => {
  const d = edited({ llm: { model: 'other', baseUrl: 'https://api.example', maxTokens: null } });
  assert.equal(isBackendConfigDirty(d, draft()), true, 'shallow compare would miss this');
});
test('a string-array edit (a host added) → dirty', () => {
  assert.equal(isBackendConfigDirty(edited({ hosts: ['alpha', 'beta', 'gamma'] }), draft()), true);
});
test('an object-array edit (a watch pattern renamed) → dirty', () => {
  const d = edited({ watchPatterns: [{ id: 'p1', pattern: 'ERROR', label: 'renamed' }] });
  assert.equal(isBackendConfigDirty(d, draft()), true);
});
test('a boolean flipped off→on → dirty', () => {
  assert.equal(isBackendConfigDirty(edited({ webhookEnabled: true }), draft()), true);
});
test('key ORDER alone is not an edit → NOT dirty', () => {
  const reordered = {};
  for (const k of Object.keys(CONFIG).reverse()) reordered[k] = clone(CONFIG[k]);
  assert.equal(isBackendConfigDirty(draft({ config: reordered }), draft()), false);
});
test('an absent optional key equals an explicit undefined → NOT dirty', () => {
  const withUndefined = { ...clone(CONFIG), showHostTags: undefined };
  assert.equal(isBackendConfigDirty(draft({ config: withUndefined }), draft()), false);
});

console.log('\nwrite-only secrets: unsaved even though `config` is untouched');
test('a typed observer auth token → dirty', () => {
  assert.equal(isBackendConfigDirty(draft({ observerAuthTokenInput: 'sk-new' }), draft()), true);
});
test('a typed webhook secret → dirty', () => {
  assert.equal(isBackendConfigDirty(draft({ webhookSecretInput: 'hunter2' }), draft()), true);
});
test('a typed telemetry auth token → dirty', () => {
  assert.equal(isBackendConfigDirty(draft({ telemetryAuthTokenInput: 'tok' }), draft()), true);
});
test('an armed Remove (pendingClear) with an empty input → dirty', () => {
  const d = draft({ webhookSecretPendingClear: true });
  assert.equal(isBackendConfigDirty(d, draft()), true, 'Remove sends an explicit null on save');
});
test('whitespace-only secret → NOT dirty (save trims it and omits the field)', () => {
  assert.equal(isBackendConfigDirty(draft({ observerAuthTokenInput: '   ' }), draft()), false);
});
test('surrounding whitespace on an otherwise-equal secret → NOT dirty', () => {
  const baseline = draft({ webhookSecretInput: 'abc' });
  assert.equal(isBackendConfigDirty(draft({ webhookSecretInput: ' abc ' }), baseline), false);
});

console.log('\npost-save re-baseline → the save-then-close path stays silent');
test('re-baselining to the saved draft clears dirtiness', () => {
  const saved = draft({ config: { ...clone(CONFIG), pollIntervalMs: 3000 }, webhookSecretInput: 'hunter2' });
  assert.equal(isBackendConfigDirty(saved, draft()), true, 'dirty before the save');
  assert.equal(isBackendConfigDirty(saved, saved), false, 'not dirty once re-baselined on success');
});
test('editing again AFTER a save is dirty against the new baseline', () => {
  const savedBaseline = draft({ config: { ...clone(CONFIG), pollIntervalMs: 3000 } });
  const next = draft({ config: { ...clone(CONFIG), pollIntervalMs: 5000 } });
  assert.equal(isBackendConfigDirty(next, savedBaseline), true);
});

console.log('\ndeepEqual primitives');
test('null vs an object is not equal (and does not throw)', () => {
  assert.equal(deepEqual(null, {}), false);
  assert.equal(deepEqual({}, null), false);
  assert.equal(deepEqual(null, null), true);
});
test('arrays compare by length and position', () => {
  assert.equal(deepEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(deepEqual(['a', 'b'], ['b', 'a']), false, 'reordering hosts is an edit');
  assert.equal(deepEqual(['a'], ['a', 'b']), false);
});
test('an array and a non-array are never equal', () => {
  assert.equal(deepEqual([], {}), false);
  assert.equal(deepEqual({ 0: 'a', length: 1 }, ['a']), false);
});
test('distinct scalar types are not equal (0 vs null vs false)', () => {
  assert.equal(deepEqual(0, null), false);
  assert.equal(deepEqual(null, false), false);
  assert.equal(deepEqual('', 0), false);
});

console.log(`\n✓ SETTINGS DIRTY-GUARD TESTS PASS (${passed})`);
