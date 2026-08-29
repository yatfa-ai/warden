// Tests for the post-GET config normalization behind Settings (WARDEN-1178).
//
// No front-end test runner in this repo, so (like settingsDirty.test.mjs and
// attentionRollup.test.mjs) this loads the REAL
// src/components/settings/normalizeLoadedConfig.ts (transpiled TS -> ESM via
// Vite's OXC transform) and exercises the PURE helper with plain objects. The
// module's only import is an `import type`, erased at transpile time, so the
// emitted module loads standalone.
//
// THE BUG UNDER TEST. Two prefs use `null` to mean DISABLED:
//   - observerSessionTimeout                 — null = never auto-close Observer tabs
//   - tokenBudgetPerSessionThresholdTokens   — null = per-session alarm off
// The loader coerced that persisted null back into a number (`?? 30`, and a
// `typeof === 'number'` test that also swallows null → 1_000_000). Because the
// SAME normalized object is handed to `setBaseline`, the coerced number became
// the dirty baseline too: `isBackendConfigDirty` read NOT dirty, the WARDEN-905
// unsaved-changes guard never fired, and the next Save of any unrelated field
// re-PUT the coerced number over the user's "off". User-visible cost: idle
// Observer tabs auto-close again and close DELETES transcripts; the per-session
// runaway alarm the user switched off starts firing again.
//
// The behaviors that matter, mapping to the ticket's success criteria:
//   1/2 - an explicit null on either field  → PRESERVED as null (blank + not dirty)
//   3   - an ABSENT field                   → still falls back to 30 / 1,000,000
//   4   - every other default               → unchanged, incl. the sibling FLEET
//         threshold whose null legitimately means "use the default"
//
// Run: node normalizeLoadedConfig.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/components/settings/normalizeLoadedConfig.ts');

// --- Load the REAL normalizeLoadedConfig.ts (TS -> ESM via Vite's OXC transform) ---
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-normalize-test-'));
const tmpFile = join(tmpDir, 'normalizeLoadedConfig.mjs');
writeFileSync(tmpFile, code);
const { normalizeLoadedConfig } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// The dirty rule the normalized object is baselined against — loaded from the
// REAL configDirty.ts, so criteria 1 and 2 assert the ACTUAL "not dirty" the
// guard computes rather than a re-implementation of it.
const dirtyPath = resolve(__dirname, 'src/components/settings/configDirty.ts');
const dirtySrc = readFileSync(dirtyPath, 'utf8');
const { code: dirtyCode } = await transformWithOxc(dirtySrc, dirtyPath, {});
const dirtyDir = mkdtempSync(join(tmpdir(), 'warden-normalize-dirty-'));
const dirtyFile = join(dirtyDir, 'configDirty.mjs');
writeFileSync(dirtyFile, dirtyCode);
const { isBackendConfigDirty } = await import(dirtyFile);
rmSync(dirtyDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A realistic GET /api/config payload: the disable-path fields are supplied per
// test, everything else is a well-formed backend response.
const RESPONSE = (over = {}) => ({
  hosts: ['alpha', 'beta'],
  pollIntervalMs: 1500,
  tmuxSession: 'agent',
  connectTimeout: 10,
  observerConfirmMode: 'auto-safe',
  observerAutoStart: true,
  observerSessionTimeout: 45,
  llm: { model: 'claude-x', baseUrl: 'https://api.example', maxTokens: 8000 },
  healthWarningThresholdMin: 7,
  healthCriticalThresholdMin: 42,
  tokenBudgetEnabled: true,
  tokenBudgetThresholdTokens: 3_000_000,
  tokenBudgetWindowHours: 12,
  tokenBudgetPerSessionThresholdTokens: 750_000,
  ...over,
});

// The snapshot shape isBackendConfigDirty diffs: the normalized config plus the
// three write-only secrets, exactly as a fresh load baselines them.
const draft = (config) => ({
  config,
  observerAuthTokenInput: '',
  observerAuthTokenPendingClear: false,
  webhookSecretInput: '',
  webhookSecretPendingClear: false,
  telemetryAuthTokenInput: '',
  telemetryAuthTokenPendingClear: false,
});

console.log('\ncriterion 1 — observerSessionTimeout: an explicit null is the DISABLE path');
test('a persisted null survives the load (NOT coerced to 30)', () => {
  const loaded = normalizeLoadedConfig(RESPONSE({ observerSessionTimeout: null }));
  assert.equal(loaded.observerSessionTimeout, null, 'the user cleared this field: null means never auto-close');
});
test('the null renders BLANK (the `?? \'\'` the input already applies)', () => {
  const loaded = normalizeLoadedConfig(RESPONSE({ observerSessionTimeout: null }));
  assert.equal(loaded.observerSessionTimeout ?? '', '', 'a coerced 30 would populate a field the user left empty');
});
test('the load is NOT dirty against its own baseline → the guard stays silent', () => {
  // The hook hands the SAME object to setConfig and setBaseline, so a coercion
  // here is invisible to the dirty check — this is why the bug was silent.
  const loaded = normalizeLoadedConfig(RESPONSE({ observerSessionTimeout: null }));
  const baseline = normalizeLoadedConfig(RESPONSE({ observerSessionTimeout: null }));
  assert.equal(isBackendConfigDirty(draft(loaded), draft(baseline)), false);
});
test('an unrelated later edit re-PUTs null, not 30 (the choice is not reversed)', () => {
  const loaded = normalizeLoadedConfig(RESPONSE({ observerSessionTimeout: null }));
  // Save PUTs `{...config}` — so whatever the loader put in `config` is what
  // gets re-persisted when the user changes something else entirely.
  const put = { ...loaded, tmuxSession: 'other' };
  assert.equal(put.observerSessionTimeout, null, 'the pre-fix loader re-persisted 30 over the user null');
});
test('a real number still round-trips untouched', () => {
  assert.equal(normalizeLoadedConfig(RESPONSE()).observerSessionTimeout, 45);
});

console.log('\ncriterion 2 — tokenBudgetPerSessionThresholdTokens: same disable path');
test('a persisted null survives the load (NOT coerced to 1,000,000)', () => {
  const loaded = normalizeLoadedConfig(RESPONSE({ tokenBudgetPerSessionThresholdTokens: null }));
  assert.equal(loaded.tokenBudgetPerSessionThresholdTokens, null, 'null disables the per-session alarm');
});
test('the null renders BLANK', () => {
  const loaded = normalizeLoadedConfig(RESPONSE({ tokenBudgetPerSessionThresholdTokens: null }));
  assert.equal(loaded.tokenBudgetPerSessionThresholdTokens ?? '', '');
});
test('the load is NOT dirty against its own baseline', () => {
  const loaded = normalizeLoadedConfig(RESPONSE({ tokenBudgetPerSessionThresholdTokens: null }));
  const baseline = normalizeLoadedConfig(RESPONSE({ tokenBudgetPerSessionThresholdTokens: null }));
  assert.equal(isBackendConfigDirty(draft(loaded), draft(baseline)), false);
});
test('an unrelated later edit re-PUTs null, not 1,000,000', () => {
  const loaded = normalizeLoadedConfig(RESPONSE({ tokenBudgetPerSessionThresholdTokens: null }));
  const put = { ...loaded, tmuxSession: 'other' };
  assert.equal(put.tokenBudgetPerSessionThresholdTokens, null);
});
test('a real number still round-trips untouched', () => {
  assert.equal(normalizeLoadedConfig(RESPONSE()).tokenBudgetPerSessionThresholdTokens, 750_000);
});
test('both fields can be disabled at once, independently', () => {
  const loaded = normalizeLoadedConfig(
    RESPONSE({ observerSessionTimeout: null, tokenBudgetPerSessionThresholdTokens: null }),
  );
  assert.equal(loaded.observerSessionTimeout, null);
  assert.equal(loaded.tokenBudgetPerSessionThresholdTokens, null);
});

console.log('\ncriterion 3 — an ABSENT field is UNKNOWN, and still falls back (fail-safe unchanged)');
test('observerSessionTimeout absent (fresh install / older backend) → 30', () => {
  const res = RESPONSE();
  delete res.observerSessionTimeout;
  assert.equal(normalizeLoadedConfig(res).observerSessionTimeout, 30, 'absent != explicitly disabled');
});
test('tokenBudgetPerSessionThresholdTokens absent → 1,000,000', () => {
  const res = RESPONSE();
  delete res.tokenBudgetPerSessionThresholdTokens;
  assert.equal(normalizeLoadedConfig(res).tokenBudgetPerSessionThresholdTokens, 1_000_000);
});
test('an explicit undefined is treated as absent, NOT as disabled', () => {
  const loaded = normalizeLoadedConfig(
    RESPONSE({ observerSessionTimeout: undefined, tokenBudgetPerSessionThresholdTokens: undefined }),
  );
  assert.equal(loaded.observerSessionTimeout, 30, 'this is the null-vs-undefined distinction `?? 30` cannot make');
  assert.equal(loaded.tokenBudgetPerSessionThresholdTokens, 1_000_000);
});
test('a malformed (non-number, non-null) value falls back rather than propagating', () => {
  const loaded = normalizeLoadedConfig(
    RESPONSE({ observerSessionTimeout: 'thirty', tokenBudgetPerSessionThresholdTokens: 'lots' }),
  );
  assert.equal(loaded.observerSessionTimeout, 30);
  assert.equal(loaded.tokenBudgetPerSessionThresholdTokens, 1_000_000);
});
test('a wholly empty response lands on every default (the pre-migration shape)', () => {
  const loaded = normalizeLoadedConfig({});
  assert.equal(loaded.observerSessionTimeout, 30);
  assert.equal(loaded.tokenBudgetPerSessionThresholdTokens, 1_000_000);
  assert.equal(loaded.tokenBudgetThresholdTokens, 2_000_000);
  assert.equal(loaded.pollIntervalMs, 1500);
});

console.log('\ncriterion 4 — the neighbouring defaults are untouched (do NOT blanket-fix)');
test('the FLEET threshold still coerces null → 2,000,000 (null there means "use the default")', () => {
  // budget.js resolves a null tokenBudgetThresholdTokens to
  // DEFAULT_TOKEN_BUDGET_THRESHOLD === 2_000_000 — exactly this fallback — so
  // for THIS field the loader already matches the backend and must not change.
  const loaded = normalizeLoadedConfig(RESPONSE({ tokenBudgetThresholdTokens: null }));
  assert.equal(loaded.tokenBudgetThresholdTokens, 2_000_000, 'the sibling field is deliberately NOT a disable path');
});
test('tokenBudgetWindowHours null → 24 (unchanged)', () => {
  assert.equal(normalizeLoadedConfig(RESPONSE({ tokenBudgetWindowHours: null })).tokenBudgetWindowHours, 24);
});
test('health thresholds null → 5 / 30 (unchanged; not nullable)', () => {
  const loaded = normalizeLoadedConfig(
    RESPONSE({ healthWarningThresholdMin: null, healthCriticalThresholdMin: null }),
  );
  assert.equal(loaded.healthWarningThresholdMin, 5);
  assert.equal(loaded.healthCriticalThresholdMin, 30);
});
test('pollIntervalMs null → 1500 (unchanged; not nullable)', () => {
  assert.equal(normalizeLoadedConfig(RESPONSE({ pollIntervalMs: null })).pollIntervalMs, 1500);
});
test('llm.maxTokens keeps its own null-as-absent rule (the correct idiom next door)', () => {
  const cleared = normalizeLoadedConfig(RESPONSE({ llm: { model: 'm', baseUrl: 'b', maxTokens: null } }));
  assert.equal(cleared.llm.maxTokens, null);
  assert.equal(normalizeLoadedConfig(RESPONSE()).llm.maxTokens, 8000);
});
test('every other field still round-trips as before', () => {
  const loaded = normalizeLoadedConfig(RESPONSE());
  assert.deepEqual(loaded.hosts, ['alpha', 'beta']);
  assert.equal(loaded.tmuxSession, 'agent');
  assert.equal(loaded.connectTimeout, 10);
  assert.equal(loaded.observerConfirmMode, 'auto-safe');
  assert.equal(loaded.observerAutoStart, true);
  assert.equal(loaded.tokenBudgetEnabled, true);
  assert.equal(loaded.tokenBudgetThresholdTokens, 3_000_000);
  assert.equal(loaded.tokenBudgetWindowHours, 12);
  assert.equal(loaded.healthWarningThresholdMin, 7);
});

console.log('\ndefensive normalization the relocation must preserve');
test('an unknown observerConfirmMode falls back to "always"', () => {
  assert.equal(normalizeLoadedConfig(RESPONSE({ observerConfirmMode: 'bogus' })).observerConfirmMode, 'always');
});
test('telemetry consent is OFF unless the backend says exactly true', () => {
  const loaded = normalizeLoadedConfig(RESPONSE({ telemetryIncidentsEnabled: 'yes' }));
  assert.equal(loaded.telemetryIncidentsEnabled, false, 'a partial/older GET can never turn a category on');
  assert.equal(loaded.telemetryNamesEnabled, false);
  assert.equal(normalizeLoadedConfig(RESPONSE({ telemetryNamesEnabled: true })).telemetryNamesEnabled, true);
});
test('a non-array watchPatterns is normalized to [] (no alerts)', () => {
  assert.deepEqual(normalizeLoadedConfig(RESPONSE({ watchPatterns: 'oops' })).watchPatterns, []);
  assert.deepEqual(normalizeLoadedConfig(RESPONSE({ watchPatterns: [{ id: 'p1' }] })).watchPatterns, [{ id: 'p1' }]);
});
test('a null/undefined payload normalizes to defaults rather than throwing', () => {
  assert.equal(normalizeLoadedConfig(null).observerSessionTimeout, 30);
  assert.equal(normalizeLoadedConfig(undefined).tokenBudgetPerSessionThresholdTokens, 1_000_000);
});

console.log(`\n✓ SETTINGS CONFIG-NORMALIZATION TESTS PASS (${passed})`);
