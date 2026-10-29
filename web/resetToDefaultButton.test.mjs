// Tests for the per-row reset-to-default affordance
// (web/src/components/settings/rows/ResetToDefaultButton.tsx, WARDEN-1276):
// ResetToDefaultButton, ClientPrefResetToDefaultButton, ConfigResetToDefaultButton.
//
// Pinned: the always-rendered fixed-size slot (identical className in both
// states, so no layout shift); the button's props/a11y name/icon and onClick;
// the client wiring (differs gate = clientPrefDiffersFromDefault, restore =
// setter(clientPrefDefault(prefKey)), structural compare for object prefs); the
// config wiring (differs gate = configDraftDiffersFromDefault, restore =
// setConfig(configDraftWithFieldRestored(config, path)) — one path only, dotted
// `llm.*` paths restore inside the group, the live draft is never mutated).
//
// HARNESS (seam-first, like paneRecoveryPanel.test.mjs): the REAL .tsx plus the
// real prefDefaultDiff, storage, themes, configDirty and normalizeLoadedConfig
// are transpiled with vite's transformWithOxc into a tmp dir under web/;
// `@/components/ui/button` and `lucide-react` are rewritten onto stubs (asserted:
// no `@/` or lucide-react specifier survives). The components are called
// directly and the returned element tree walked. A localStorage polyfill is
// installed as in prefDefaultDiff.test.mjs.
//
// Run: node --test resetToDefaultButton.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));

// localStorage polyfill (Node has none); storage.ts reads it lazily.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); },
};

const tmpDir = mkdtempSync(join(__dirname, '.tmp-resettodefault-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const SETTINGS = 'src/components/settings';
// Rewrite every bare/relative specifier (either quote style) onto an emitted sibling.
const emit = async (srcRel, outName, rewrites = {}) => {
  const srcPath = resolve(__dirname, srcRel);
  const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
  let out = code;
  for (const [spec, target] of Object.entries(rewrites)) {
    for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'${target}'`);
  }
  writeFileSync(join(tmpDir, outName), out);
};

await emit('src/lib/themes.ts', 'themes.mjs');
await emit('src/lib/storage.ts', 'storage.mjs', { '@/lib/themes': './themes.mjs' });
await emit(`${SETTINGS}/configDirty.ts`, 'configDirty.mjs');
await emit(`${SETTINGS}/normalizeLoadedConfig.ts`, 'normalizeLoadedConfig.mjs');
await emit(`${SETTINGS}/prefDefaultDiff.ts`, 'prefDefaultDiff.mjs', {
  './configDirty': './configDirty.mjs',
  './normalizeLoadedConfig': './normalizeLoadedConfig.mjs',
  '@/lib/storage': './storage.mjs',
});
await emit(`${SETTINGS}/rows/ResetToDefaultButton.tsx`, 'reset-to-default-button.mjs', {
  '../prefDefaultDiff': './prefDefaultDiff.mjs',
  '@/lib/storage': './storage.mjs',
  '../types': './types-stub.mjs', // type-only import; may survive as a side-effect import
  '@/components/ui/button': './button.mjs',
  'lucide-react': './icons.mjs',
});
writeFileSync(join(tmpDir, 'types-stub.mjs'), 'export {};\n');
writeFileSync(join(tmpDir, 'button.mjs'), 'export function Button() { return null; }\n');
writeFileSync(
  join(tmpDir, 'icons.mjs'),
  `const mk = (n) => { const f = () => null; Object.defineProperty(f, 'name', { value: n }); return f; };
export const RotateCcw = mk('RotateCcw');\n`,
);

for (const f of readdirSync(tmpDir)) {
  const body = readFileSync(join(tmpDir, f), 'utf8');
  assert.doesNotMatch(body, /['"]@\//, `an @/ specifier survived in ${f}`);
  assert.doesNotMatch(body, /from ['"]lucide-react['"]/, `lucide-react survived in ${f}`);
  assert.doesNotMatch(body, /['"]\.\.\/(types|prefDefaultDiff)['"]/, `a ../ specifier survived in ${f}`);
}

const { ResetToDefaultButton, ClientPrefResetToDefaultButton, ConfigResetToDefaultButton } =
  await import(join(tmpDir, 'reset-to-default-button.mjs'));
const { Button } = await import(join(tmpDir, 'button.mjs'));
const { RotateCcw } = await import(join(tmpDir, 'icons.mjs'));
const { clientPrefDefault } = await import(join(tmpDir, 'prefDefaultDiff.mjs'));
const { normalizeLoadedConfig } = await import(join(tmpDir, 'normalizeLoadedConfig.mjs'));

// ---- helpers ----------------------------------------------------------------
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
const findAll = (root, pred) => {
  const out = [];
  walk(root, (e) => { if (pred(e)) out.push(e); });
  return out;
};
const buttons = (root) => findAll(root, (e) => e.type === Button);
// ClientPref/ConfigResetToDefaultButton return a <ResetToDefaultButton .../>
// element; resolve it one level so the rendered slot can be inspected.
const resolveWrapper = (el) => (el.type === ResetToDefaultButton ? ResetToDefaultButton(el.props) : el);
const renderClient = (props) => resolveWrapper(ClientPrefResetToDefaultButton(props));
const renderConfig = (props) => resolveWrapper(ConfigResetToDefaultButton(props));
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- ResetToDefaultButton ---------------------------------------------------------
test('at default: slot is a span with no Button', () => {
  const root = ResetToDefaultButton({ label: 'Font size', differs: false, onRestore: () => {} });
  assert.equal(root.type, 'span');
  assert.equal(buttons(root).length, 0);
});

test('slot className is identical in both states and reserves a fixed size (no layout shift)', () => {
  const off = ResetToDefaultButton({ label: 'X', differs: false, onRestore: () => {} });
  const on = ResetToDefaultButton({ label: 'X', differs: true, onRestore: () => {} });
  assert.equal(off.props.className, on.props.className);
  assert.match(off.props.className, /\bsize-7\b/);
  assert.match(off.props.className, /\bshrink-0\b/);
});

test('modified: exactly one ghost icon-sm type=button Button with the accessible name and a RotateCcw icon', () => {
  const root = ResetToDefaultButton({ label: 'Font size', differs: true, onRestore: () => {} });
  const bs = buttons(root);
  assert.equal(bs.length, 1);
  const b = bs[0];
  assert.equal(b.props.type, 'button');
  assert.equal(b.props.variant, 'ghost');
  assert.equal(b.props.size, 'icon-sm');
  assert.equal(b.props['aria-label'], 'Reset Font size to default');
  assert.equal(b.props.title, 'Reset Font size to default');
  const kids = [b.props.children].flat().filter(React.isValidElement);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].type, RotateCcw);
});

test('modified: clicking calls onRestore exactly once', () => {
  let n = 0;
  const root = ResetToDefaultButton({ label: 'X', differs: true, onRestore: () => { n++; } });
  buttons(root)[0].props.onClick();
  assert.equal(n, 1);
});

// ---- ClientPrefResetToDefaultButton -------------------------------------------------
test('client: no button when the value equals the default', () => {
  const root = renderClient({
    label: 'Font size', prefKey: 'terminalFontSize', value: clientPrefDefault('terminalFontSize'), setter: () => {},
  });
  assert.equal(buttons(root).length, 0);
});

test('client: off default shows the labelled button; click restores via setter(default)', () => {
  const calls = [];
  const root = renderClient({
    label: 'Font size', prefKey: 'terminalFontSize', value: 20, setter: (v) => calls.push(v),
  });
  const [b] = buttons(root);
  assert.equal(b.props['aria-label'], 'Reset Font size to default');
  b.props.onClick();
  assert.deepEqual(calls, [clientPrefDefault('terminalFontSize')]);
  assert.equal(calls[0], 14);
});

test('client: different keys restore to their own, different defaults', () => {
  const got = {};
  for (const [key, bad] of [['terminalFontSize', 99], ['terminalScrollback', 1], ['terminalCursorStyle', 'bar']]) {
    buttons(renderClient({ label: key, prefKey: key, value: bad, setter: (v) => { got[key] = v; } }))[0].props.onClick();
  }
  assert.equal(got.terminalFontSize, clientPrefDefault('terminalFontSize'));
  assert.equal(got.terminalScrollback, clientPrefDefault('terminalScrollback'));
  assert.equal(got.terminalCursorStyle, clientPrefDefault('terminalCursorStyle'));
  assert.equal(new Set(Object.values(got)).size, 3);
});

test('client: object prefs compare structurally (equal clone hides, altered shows)', () => {
  const def = clientPrefDefault('attentionStates');
  const same = renderClient({ label: 'Alerts', prefKey: 'attentionStates', value: clone(def), setter: () => {} });
  assert.equal(buttons(same).length, 0);
  const calls = [];
  const altered = renderClient({
    label: 'Alerts', prefKey: 'attentionStates', value: { ...def, stuck: !def.stuck }, setter: (v) => calls.push(v),
  });
  assert.equal(buttons(altered).length, 1);
  buttons(altered)[0].props.onClick();
  assert.deepEqual(calls, [def]);
});

// ---- ConfigResetToDefaultButton -----------------------------------------------------
const defaults = () => normalizeLoadedConfig({});

test('config: no button when the draft field equals its default', () => {
  const root = renderConfig({ label: 'Poll interval', path: 'pollIntervalMs', config: defaults(), setConfig: () => {} });
  assert.equal(buttons(root).length, 0);
});

test('config: modified field shows the button; click calls setConfig once restoring only that path', () => {
  const base = defaults();
  const config = { ...base, pollIntervalMs: base.pollIntervalMs + 777, healthWarningThresholdMin: base.healthWarningThresholdMin + 1 };
  const snapshot = clone(config);
  const calls = [];
  const root = renderConfig({ label: 'Poll interval', path: 'pollIntervalMs', config, setConfig: (c) => calls.push(c) });
  const [b] = buttons(root);
  assert.equal(b.props['aria-label'], 'Reset Poll interval to default');
  b.props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pollIntervalMs, base.pollIntervalMs);
  assert.equal(calls[0].healthWarningThresholdMin, base.healthWarningThresholdMin + 1, 'sibling field must be untouched');
  assert.deepEqual(config, snapshot, 'the live draft must not be mutated');
  assert.notEqual(calls[0], config);
});

test('config: dotted llm.model restores inside the group and keeps llm.baseUrl', () => {
  const base = defaults();
  const config = { ...base, llm: { ...base.llm, model: 'custom-model', baseUrl: 'http://example.test' } };
  const snapshot = clone(config);
  const calls = [];
  const root = renderConfig({ label: 'Model', path: 'llm.model', config, setConfig: (c) => calls.push(c) });
  assert.equal(buttons(root).length, 1);
  buttons(root)[0].props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].llm.model, base.llm.model);
  assert.equal(calls[0].llm.baseUrl, 'http://example.test');
  assert.deepEqual(config, snapshot);
});

test('config: the differs gate and the restore use the same path (a sibling edit does not show the button)', () => {
  const base = defaults();
  const config = { ...base, healthWarningThresholdMin: base.healthWarningThresholdMin + 1 };
  const root = renderConfig({ label: 'Poll interval', path: 'pollIntervalMs', config, setConfig: () => {} });
  assert.equal(buttons(root).length, 0);
});
