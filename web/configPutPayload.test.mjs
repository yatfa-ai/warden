// Tests for configPutPayload — the PUT /api/config request-body builder behind
// Settings' footer Save (WARDEN-1343).
//
// No front-end test runner in this repo, so (exactly like
// prefDefaultDiff.test.mjs) this loads the REAL modules transpiled TS -> ESM
// via Vite's OXC transform and exercises the pure helper.
//
// THE PIN THAT MATTERS MOST is the first block: a cleared "Window (hours)"
// input drafts `null`, and the server's `nullable: false` flooredNumber guard
// refuses null outright (the asymmetry is deliberate — WARDEN-773 corr. 3,
// pinned server-side by src/config-schema.test.js 'windowHours null IGNORED
// (asymmetry)'). handleSave used to spread the draft wholesale, so the null
// went over the wire, was refused, the custom value survived on disk, and the
// unconditional WARDEN-906 re-baseline marked the never-persisted clear as
// saved. The builder materializes the clear at the save boundary to the
// DERIVED default (configFieldDefault — the same normalizeLoadedConfig({})
// derivation prefDefaultDiff.test.mjs pins field-by-field against
// deriveDefaults()); these tests hold that seam so it cannot regress.
//
// Equally load-bearing are the PASS-THROUGH pins: the two nullable-DISABLE
// budget fields (observerSessionTimeout / tokenBudgetPerSessionThresholdTokens)
// must still send null — null means DISABLED there, and WARDEN-1178 made that
// path real. Coercing them would silently un-disable the feature.
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node configPutPayload.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- localStorage polyfill (Node has none); storage.ts reads it lazily -------
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); },
};

// --- Load the REAL modules (TS -> ESM via the OXC transform) ----------------
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-config-put-payload-test-'));
const emit = async (srcPath, outName, rewrites = {}) => {
  const src = readFileSync(srcPath, 'utf8');
  const { code } = await transformWithOxc(src, srcPath, {});
  let out = code;
  for (const [from, to] of Object.entries(rewrites)) out = out.replaceAll(from, to);
  writeFileSync(join(tmpDir, outName), out);
};

await emit(resolve(__dirname, 'src/lib/themes.ts'), 'themes.mjs');
await emit(resolve(__dirname, 'src/lib/storage.ts'), 'storage.mjs', {
  '@/lib/themes': './themes.mjs',
});
await emit(resolve(__dirname, 'src/components/settings/configDirty.ts'), 'configDirty.mjs');
await emit(
  resolve(__dirname, 'src/components/settings/normalizeLoadedConfig.ts'),
  'normalizeLoadedConfig.mjs',
);
await emit(resolve(__dirname, 'src/components/settings/prefDefaultDiff.ts'), 'prefDefaultDiff.mjs', {
  './configDirty': './configDirty.mjs',
  './normalizeLoadedConfig': './normalizeLoadedConfig.mjs',
  '@/lib/storage': './storage.mjs',
});
await emit(
  resolve(__dirname, 'src/components/settings/configPutPayload.ts'),
  'configPutPayload.mjs',
  { './prefDefaultDiff': './prefDefaultDiff.mjs' },
);
// types.ts is `import type`-only (ConfigData); the transform elides type-only
// imports, so it needs no emission and no rewrites — same as the harness in
// prefDefaultDiff.test.mjs, which never emits types.ts either.

const { buildConfigPutPayload } = await import(join(tmpDir, 'configPutPayload.mjs'));
const { configFieldDefault } = await import(join(tmpDir, 'prefDefaultDiff.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A full ConfigData-shaped draft as the GET load produces it (post
// normalizeLoadedConfig — the exact state handleSave spreads). tokenBudget
// block carries the enabled default trio; tests override per case.
const draft = (overrides = {}) => ({
  hosts: [],
  pollIntervalMs: 1500,
  tmuxSession: 'agent',
  connectTimeout: 10,
  observerConfirmMode: 'always',
  observerAutoStart: false,
  observerSessionTimeout: 30,
  llm: { model: 'claude-sonnet-4', baseUrl: 'https://example.test', maxTokens: 8192 },
  healthWarningThresholdMin: 5,
  healthCriticalThresholdMin: 30,
  tokenBudgetEnabled: true,
  tokenBudgetThresholdTokens: 2_000_000,
  tokenBudgetWindowHours: 24,
  tokenBudgetPerSessionThresholdTokens: 1_000_000,
  companionTransportEnabled: false,
  companionTransportOverridden: false,
  confirmDestructiveActions: true,
  notifyChatOps: true,
  notifyErrors: true,
  notifySuccess: true,
  notifyObserver: true,
  showHostTags: true,
  showTypeBadges: true,
  showStatusIndicators: true,
  showProjectBadges: false,
  hideOfflineHosts: false,
  telemetryIncidentsEnabled: false,
  telemetryNamesEnabled: false,
  telemetryOperationalMetricsEnabled: false,
  telemetryEndpoint: '',
  webhookUrl: '',
  webhookEnabled: false,
  webhookAlertBudget: true,
  webhookAlertDone: true,
  watchPatterns: [],
  bounds: {},
  ...overrides,
});

const put = (config, llm, webhookExtra = {}, telemetryExtra = {}) =>
  buildConfigPutPayload(config, llm ?? { ...config.llm }, webhookExtra, telemetryExtra);

// ---------------------------------------------------------------------------
console.log('\nWARDEN-1343 — the cleared field never reaches the body as null');
// ---------------------------------------------------------------------------
test('a null tokenBudgetWindowHours draft is materialized to the derived default', () => {
  const body = put(draft({ tokenBudgetWindowHours: null }));
  assert.equal(body.tokenBudgetWindowHours, configFieldDefault('tokenBudgetWindowHours'));
});
test('the materialized value IS the schema default (24) — no second literal', () => {
  // Criterion 3: the coercion must READ the default source, not hardcode a
  // fresh 24. The seam must equal the live derivation; the golden 24 anchor
  // is pinned against the server registry by prefDefaultDiff.test.mjs, so a
  // deliberate schema change surfaces there first and this test tracks it.
  const body = put(draft({ tokenBudgetWindowHours: null }));
  assert.equal(body.tokenBudgetWindowHours, 24);
});
test('a custom value passes through unchanged (the defect kept 12 on disk)', () => {
  assert.equal(put(draft({ tokenBudgetWindowHours: 12 })).tokenBudgetWindowHours, 12);
});
test('a draft already at default passes through unchanged', () => {
  assert.equal(put(draft({ tokenBudgetWindowHours: 24 })).tokenBudgetWindowHours, 24);
});
test('a putJson-level regression guard: null is absent from the serialized body', () => {
  // The wire is JSON — assert the SERIALIZED body, the thing the server
  // actually parses, carries no null for this key.
  const serialized = JSON.stringify(put(draft({ tokenBudgetWindowHours: null })));
  const reparsed = JSON.parse(serialized);
  assert.equal(reparsed.tokenBudgetWindowHours, 24);
  assert.ok(!serialized.includes('"tokenBudgetWindowHours":null'));
});

// ---------------------------------------------------------------------------
console.log('\nWARDEN-1178 — the nullable-DISABLE siblings must still send null');
// ---------------------------------------------------------------------------
test('observerSessionTimeout: null passes through (null = never auto-stop)', () => {
  assert.equal(put(draft({ observerSessionTimeout: null })).observerSessionTimeout, null);
});
test('tokenBudgetPerSessionThresholdTokens: null passes through (null = alarm off)', () => {
  const body = put(draft({ tokenBudgetPerSessionThresholdTokens: null }));
  assert.equal(body.tokenBudgetPerSessionThresholdTokens, null);
});
test('the genuinely clear-to-default-at-read fields also pass through as null', () => {
  // nullable: true server-side — the server itself resolves null to the
  // default and persists it. Coercing these here would be harmless today but
  // would silently change the seam's contract; keep it faithful.
  const body = put(
    draft({
      healthWarningThresholdMin: null,
      healthCriticalThresholdMin: null,
      tokenBudgetThresholdTokens: null,
    }),
  );
  assert.equal(body.healthWarningThresholdMin, null);
  assert.equal(body.healthCriticalThresholdMin, null);
  assert.equal(body.tokenBudgetThresholdTokens, null);
});

// ---------------------------------------------------------------------------
console.log('\nthe rest of the handleSave payload contract is preserved');
// ---------------------------------------------------------------------------
test('llm (with the write-only authToken leg) replaces config.llm', () => {
  const body = put(
    draft(),
    { model: 'm2', baseUrl: 'https://b.test', maxTokens: null, authToken: 'typed-secret' },
  );
  assert.deepEqual(body.llm, {
    model: 'm2', baseUrl: 'https://b.test', maxTokens: null, authToken: 'typed-secret',
  });
});
test('an omitted secret key stays omitted (no-clobber), a pending clear sends null', () => {
  const untouched = put(draft(), null, {}, { telemetryAuthToken: 'tel-secret' });
  assert.equal('webhookSecret' in untouched, false);
  assert.equal(untouched.telemetryAuthToken, 'tel-secret');
  const cleared = put(draft(), null, { webhookSecret: null });
  assert.equal(cleared.webhookSecret, null);
});
test('the builder does not mutate the draft (the null stays for the pre-save UI)', () => {
  const config = draft({ tokenBudgetWindowHours: null });
  put(config);
  assert.equal(config.tokenBudgetWindowHours, null);
});
test('the materialized key wins over the config spread', () => {
  // Ordering contract: the coercion is LAST in the built object so a future
  // spread reshuffle cannot reintroduce the null.
  const body = put(draft({ tokenBudgetWindowHours: null }));
  assert.equal(body.tokenBudgetWindowHours, 24);
  assert.ok(Object.keys(body).indexOf('tokenBudgetWindowHours') >= 0);
});

console.log(`\n${passed} tests passed\n`);
