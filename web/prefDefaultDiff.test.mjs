// Tests for prefDefaultDiff — the "is this ONE preference at its default?"
// comparator behind the per-row reset affordance (WARDEN-1276).
//
// No front-end test runner in this repo, so (like sectionPersistence.test.mjs
// and configDirty's settingsDirty.test.mjs) this loads the REAL modules
// transpiled TS -> ESM via Vite's OXC transform and exercises the pure helpers.
// prefDefaultDiff.ts imports three real modules (configDirty, normalizeLoadedConfig,
// lib/storage), so all of them — plus storage's own @/lib/themes import — are
// transpiled into one tmp dir and their bare specifiers rewritten to relative
// paths Node can resolve. storage.ts touches localStorage at call time only, but
// a polyfill is installed anyway so an accidental module-level read cannot throw.
//
// THE PIN THAT MATTERS MOST is the last block: the backend comparator's default
// source (normalizeLoadedConfig({}), what the web renders on a fresh install) is
// asserted field-by-field against deriveDefaults() in src/config-schema.js — the
// SAME registry `resetConfig` iterates. Nothing else in the repo compares those
// two, so without this a schema default could change and the affordance would
// quietly measure against a stale number: the row would show "modified" on an
// untouched fresh install, or hide while genuinely modified.
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node prefDefaultDiff.test.mjs   (from web/)
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
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-pref-default-diff-test-'));
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
// The transform may emit either quote style, so rewrite the bare specifier
// itself rather than a quoted form.
await emit(resolve(__dirname, 'src/components/settings/prefDefaultDiff.ts'), 'prefDefaultDiff.mjs', {
  './configDirty': './configDirty.mjs',
  './normalizeLoadedConfig': './normalizeLoadedConfig.mjs',
  '@/lib/storage': './storage.mjs',
});

const {
  clientPrefDefault,
  clientPrefDiffersFromDefault,
  configFieldDefaults,
  configFieldDefault,
  configFieldDiffersFromDefault,
  configDraftDiffersFromDefault,
  configDraftWithFieldRestored,
} = await import(join(tmpDir, 'prefDefaultDiff.mjs'));
const { resetUiPrefDefaults, DEFAULT_UI, DEFAULT_TERMINAL_FONT_FAMILY } = await import(
  join(tmpDir, 'storage.mjs')
);
const { normalizeLoadedConfig } = await import(join(tmpDir, 'normalizeLoadedConfig.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

// The BACKEND registry — loaded directly (plain ESM JS, no transform needed).
const { deriveDefaults, CONFIG_FIELDS } = await import(
  resolve(__dirname, '../src/config-schema.js')
);

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// ---------------------------------------------------------------------------
console.log('\nclient prefs — at-default vs modified');
// ---------------------------------------------------------------------------
test('a pref holding its default does NOT differ (no affordance)', () => {
  assert.equal(clientPrefDiffersFromDefault('terminalScrollback', 10000), false);
  assert.equal(clientPrefDiffersFromDefault('terminalFontSize', 14), false);
  assert.equal(clientPrefDiffersFromDefault('theme', 'system'), false);
  assert.equal(clientPrefDiffersFromDefault('density', 'comfortable'), false);
  assert.equal(clientPrefDiffersFromDefault('copyOnSelect', false), false);
  assert.equal(clientPrefDiffersFromDefault('autoFocusNewPane', true), false);
});
test('a modified pref DOES differ (affordance shows)', () => {
  // Success criterion 1: scrollback at 50000 shows the affordance.
  assert.equal(clientPrefDiffersFromDefault('terminalScrollback', 50000), true);
  assert.equal(clientPrefDiffersFromDefault('terminalFontSize', 18), true);
  assert.equal(clientPrefDiffersFromDefault('theme', 'github-dark'), true);
  assert.equal(clientPrefDiffersFromDefault('copyOnSelect', true), true);
  assert.equal(clientPrefDiffersFromDefault('autoFocusNewPane', false), true);
});
test('restoring a client pref hands back its default value', () => {
  assert.equal(clientPrefDefault('terminalScrollback'), 10000);
  assert.equal(clientPrefDefault('terminalFontSize'), 14);
  assert.equal(clientPrefDefault('defaultNewChatHost'), '(local)');
  assert.equal(clientPrefDefault('defaultShell'), '');
});
test('object/array prefs compare STRUCTURALLY, not by reference', () => {
  // A freshly-built default object is never reference-equal to the live one; a
  // `!==` comparator would paint every one of these rows as modified forever.
  assert.equal(
    clientPrefDiffersFromDefault('attentionStates', {
      stuck: true, erroring: true, waiting: true, blocked: true, done: true,
    }),
    false,
  );
  assert.equal(
    clientPrefDiffersFromDefault('attentionStates', {
      stuck: true, erroring: true, waiting: false, blocked: true, done: true,
    }),
    true,
  );
  assert.equal(clientPrefDiffersFromDefault('customPresets', []), false);
  assert.equal(clientPrefDiffersFromDefault('customPresets', [{ name: 'codex', cmd: 'codex' }]), true);
});

// ---------------------------------------------------------------------------
console.log('\nclient prefs — the terminalFontFamily deviation (WARDEN-896 trap)');
// ---------------------------------------------------------------------------
test('the default read is the CURATED stack, never DEFAULT_UI\'s "" sentinel', () => {
  // DEFAULT_UI stores '' ("blank = default stack") but App's live initializer
  // coerces it and the font Select has no '' option. Re-deriving from DEFAULT_UI
  // would (a) report the untouched default font as modified, and (b) restore a
  // value that renders as "Custom…" until reload.
  assert.equal(DEFAULT_UI.terminalFontFamily, '');
  assert.notEqual(DEFAULT_TERMINAL_FONT_FAMILY, '');
  assert.equal(clientPrefDefault('terminalFontFamily'), DEFAULT_TERMINAL_FONT_FAMILY);
});
test('the LIVE default font does NOT show the affordance; a custom font does', () => {
  assert.equal(
    clientPrefDiffersFromDefault('terminalFontFamily', DEFAULT_TERMINAL_FONT_FAMILY),
    false,
  );
  assert.equal(clientPrefDiffersFromDefault('terminalFontFamily', '"Hack Nerd Font", monospace'), true);
});
test('the comparator rides resetUiPrefDefaults() — every key agrees with it', () => {
  // The bulk reset and the per-row restore must never disagree about what a
  // pref's default IS; that is the whole reason this reads the shipped factory.
  for (const [key, value] of Object.entries(resetUiPrefDefaults())) {
    assert.equal(
      clientPrefDiffersFromDefault(key, value),
      false,
      `${key}: the bulk-reset default must read as at-default`,
    );
  }
});

// ---------------------------------------------------------------------------
console.log('\nbackend config — at-default vs modified');
// ---------------------------------------------------------------------------
test('a field holding its default does NOT differ', () => {
  assert.equal(configFieldDiffersFromDefault('healthWarningThresholdMin', 5), false);
  assert.equal(configFieldDiffersFromDefault('healthCriticalThresholdMin', 30), false);
  assert.equal(configFieldDiffersFromDefault('confirmDestructiveActions', true), false);
  assert.equal(configFieldDiffersFromDefault('tmuxSession', 'agent'), false);
  assert.equal(configFieldDiffersFromDefault('connectTimeout', 10), false);
});
test('a modified field DOES differ (success criterion 2: thresholds at 7/40)', () => {
  assert.equal(configFieldDiffersFromDefault('healthWarningThresholdMin', 7), true);
  assert.equal(configFieldDiffersFromDefault('healthCriticalThresholdMin', 40), true);
  assert.equal(configFieldDiffersFromDefault('confirmDestructiveActions', false), true);
  assert.equal(configFieldDiffersFromDefault('tmuxSession', 'warden'), true);
});
test('dotted llm.* paths resolve (ObserverSection renders each as its own row)', () => {
  assert.equal(configFieldDiffersFromDefault('llm.model', ''), false);
  assert.equal(configFieldDiffersFromDefault('llm.model', 'claude-4'), true);
  assert.equal(configFieldDiffersFromDefault('llm.baseUrl', ''), false);
  assert.equal(configFieldDiffersFromDefault('llm.maxTokens', null), false); // null = use default
  assert.equal(configFieldDiffersFromDefault('llm.maxTokens', 4096), true);
});

// ---------------------------------------------------------------------------
console.log('\nbackend config — ABSENT ≡ DEFAULT (trap 3)');
// ---------------------------------------------------------------------------
test('an absent optional Display field reads as AT default, never modified', () => {
  // DisplaySection renders `config.showHostTags ?? true`, so an absent field
  // DISPLAYS as its default. Without this rule every never-touched optional
  // field would carry a bogus "modified" affordance on a fresh install
  // (success criterion 3).
  for (const key of ['showHostTags', 'showTypeBadges', 'showStatusIndicators', 'showProjectBadges', 'hideOfflineHosts']) {
    assert.equal(configFieldDiffersFromDefault(key, undefined), false, key);
  }
  // A whole draft missing them entirely behaves the same way.
  const sparse = { ...normalizeLoadedConfig({}) };
  delete sparse.showHostTags;
  assert.equal(configDraftDiffersFromDefault(sparse, 'showHostTags'), false);
});
test('an explicitly-flipped Display field DOES differ', () => {
  assert.equal(configFieldDiffersFromDefault('showHostTags', false), true);
  assert.equal(configFieldDiffersFromDefault('showProjectBadges', true), true); // default false
});

// ---------------------------------------------------------------------------
console.log('\nbackend config — nullable fields (trap 4)');
// ---------------------------------------------------------------------------
test('null means USE-THE-DEFAULT on the four "leave empty for the default" rows', () => {
  // Their placeholders literally say "Leave empty for the default (N)", and the
  // consumers resolve null to exactly N — so an emptied field IS at default and
  // must not offer a restore that would change nothing visible.
  assert.equal(configFieldDiffersFromDefault('healthWarningThresholdMin', null), false);
  assert.equal(configFieldDiffersFromDefault('healthCriticalThresholdMin', null), false);
  assert.equal(configFieldDiffersFromDefault('tokenBudgetThresholdTokens', null), false);
  assert.equal(configFieldDiffersFromDefault('tokenBudgetWindowHours', null), false);
  assert.equal(configFieldDiffersFromDefault('llm.maxTokens', null), false);
});
test('null means DISABLED — not default — on the two disable-path rows', () => {
  // normalizeLoadedConfig.ts documents this discrimination at length from the
  // other side: for these two, null is a real user choice ("Disabled when
  // empty" / "Empty disables the per-session alarm"), so it DIFFERS from the
  // 30 / 1,000,000 default and correctly offers a restore.
  assert.equal(configFieldDiffersFromDefault('observerSessionTimeout', null), true);
  assert.equal(configFieldDiffersFromDefault('tokenBudgetPerSessionThresholdTokens', null), true);
  // …and their actual defaults still read as at-default.
  assert.equal(configFieldDiffersFromDefault('observerSessionTimeout', 30), false);
  assert.equal(configFieldDiffersFromDefault('tokenBudgetPerSessionThresholdTokens', 1_000_000), false);
});

// ---------------------------------------------------------------------------
console.log('\nbackend config — the restored draft');
// ---------------------------------------------------------------------------
test('restoring writes the default into a NEW draft, touching nothing else', () => {
  const draft = { ...normalizeLoadedConfig({}), healthWarningThresholdMin: 7, tmuxSession: 'warden' };
  const next = configDraftWithFieldRestored(draft, 'healthWarningThresholdMin');
  assert.equal(next.healthWarningThresholdMin, 5);
  assert.equal(next.tmuxSession, 'warden', 'the sibling edit must survive');
  assert.notEqual(next, draft, 'must be a new object (setConfig spread contract)');
  assert.equal(draft.healthWarningThresholdMin, 7, 'the input draft must not be mutated');
  // The restored row now reads as at-default, so the affordance disappears.
  assert.equal(configDraftDiffersFromDefault(next, 'healthWarningThresholdMin'), false);
});
test('restoring a dotted llm.* field rebuilds the group, keeping its siblings', () => {
  const draft = {
    ...normalizeLoadedConfig({}),
    llm: { model: 'claude-4', baseUrl: 'https://example.test', maxTokens: 4096 },
  };
  const next = configDraftWithFieldRestored(draft, 'llm.model');
  assert.equal(next.llm.model, '');
  assert.equal(next.llm.baseUrl, 'https://example.test', 'sibling llm field must survive');
  assert.equal(next.llm.maxTokens, 4096);
  assert.notEqual(next.llm, draft.llm, 'the group must be rebuilt, not mutated');
  assert.equal(draft.llm.model, 'claude-4');
});
test('an unsupported deeper path is refused loudly, never written wrong', () => {
  const draft = normalizeLoadedConfig({});
  assert.throws(() => configDraftWithFieldRestored(draft, 'llm.a.b'), /unsupported nested path/);
});
test('configFieldDefaults() is a FACTORY — a mutated result cannot poison the next read', () => {
  const first = configFieldDefaults();
  first.tmuxSession = 'poisoned';
  first.llm.model = 'poisoned';
  assert.equal(configFieldDefaults().tmuxSession, 'agent');
  assert.equal(configFieldDefault('llm.model'), '');
});

// ---------------------------------------------------------------------------
console.log('\nTHE PIN — the web-side default source agrees with the backend registry');
// ---------------------------------------------------------------------------
test('every comparable field matches deriveDefaults() in src/config-schema.js', () => {
  const registry = deriveDefaults();
  const web = configFieldDefaults();
  // The three fields the web deliberately does not mirror:
  //   • hosts / watchPatterns  — user-authored content, explicitly out of scope
  //                              for this affordance (no "default" to restore).
  //   • llm                    — the registry's default is `{}` (llm.js owns its
  //                              own fallbacks); the web expands it to the
  //                              per-row shape the form edits, asserted below.
  const contentFields = new Set(['hosts', 'watchPatterns', 'llm']);
  let compared = 0;
  for (const [key, registryDefault] of Object.entries(registry)) {
    if (contentFields.has(key)) continue;
    if (!(key in web)) continue; // secrets + internal fields never reach ConfigData
    assert.deepEqual(
      web[key],
      registryDefault,
      `${key}: the affordance's default must equal the schema default`,
    );
    compared += 1;
  }
  assert.ok(compared >= 25, `expected to pin most of the registry, pinned ${compared}`);
});
test('the nested llm group expands the registry\'s {} to the form\'s own defaults', () => {
  const registry = deriveDefaults();
  assert.deepEqual(registry.llm, {}, 'the registry default is empty by design (llm.js owns fallbacks)');
  // '' / '' / null are each the "unset, use the resolver's fallback" value the
  // three ObserverSection inputs render as blank.
  assert.equal(configFieldDefault('llm.model'), '');
  assert.equal(configFieldDefault('llm.baseUrl'), '');
  assert.equal(configFieldDefault('llm.maxTokens'), null);
});
test('every field the affordance is wired to exists in the registry', () => {
  // Guards the other drift direction: a typo'd path would silently compare
  // against `undefined` and hide the affordance forever.
  const registryKeys = new Set(CONFIG_FIELDS.map((f) => f.key));
  const wiredPaths = [
    'showHostTags', 'showTypeBadges', 'showStatusIndicators', 'showProjectBadges', 'hideOfflineHosts',
    'confirmDestructiveActions', 'companionTransportEnabled',
    'healthWarningThresholdMin', 'healthCriticalThresholdMin',
    'tokenBudgetEnabled', 'tokenBudgetThresholdTokens', 'tokenBudgetWindowHours',
    'tokenBudgetPerSessionThresholdTokens',
    'observerConfirmMode', 'observerAutoStart', 'observerSessionTimeout',
    'llm.model', 'llm.baseUrl', 'llm.maxTokens',
    'notifyChatOps', 'notifyErrors', 'notifySuccess', 'notifyObserver',
    'webhookEnabled', 'webhookUrl', 'webhookAlertBudget', 'webhookAlertDone',
    'telemetryEndpoint', 'telemetryIncidentsEnabled', 'telemetryNamesEnabled',
    'telemetryOperationalMetricsEnabled',
    'tmuxSession', 'connectTimeout',
  ];
  for (const path of wiredPaths) {
    assert.ok(registryKeys.has(path.split('.')[0]), `${path} is not a registry field`);
    // And each resolves to a real default rather than undefined.
    assert.notEqual(configFieldDefault(path), undefined, `${path} resolves to no default`);
  }
});

console.log(`\n${passed} tests passed\n`);
