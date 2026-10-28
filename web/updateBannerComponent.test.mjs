// Tests for the UpdateBanner component (web/src/components/UpdateBanner.tsx, WARDEN-1887) —
// the non-blocking auto-update chip: the dismiss key (per kind + version), install/download
// action routing, the `live` guard on the late getUpdateState() result, `off()` on unmount,
// and the chip's a11y attributes / text. (updateBanner.test.mjs pins only the pure
// updateBannerView helper.)
//
// No DOM test runner in this repo, so (like sidebarBits.test.mjs) this loads the REAL
// UpdateBanner.tsx AND the REAL updateBanner.ts via Vite's OXC transform into a tmp dir under
// web/ (so `react/jsx-runtime` resolves from web/node_modules), rewrites the `@/...` and
// `react` specifiers, and stubs ONLY Button, `@/lib/electron` and a minimal `react`
// (useState/useEffect over slot arrays). The component is driven by calling it and reading
// the returned element tree; effects are run / cleaned up explicitly by the harness.
//
// Run: node --test updateBannerComponent.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-updatebanner-component-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const STUBS = {
  '@/components/ui/button': 'button.mjs',
  '@/lib/electron': 'electron.mjs',
  '@/lib/updateBanner': 'updateBanner.mjs', // the REAL module, transpiled below
};
const rewrite = (code) => {
  let out = code;
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  // Only the bare `react` import (hooks) is stubbed; `react/jsx-runtime` stays real.
  for (const q of ["'", '"']) out = out.replaceAll(`from ${q}react${q}`, `from './react.mjs'`);
  return out;
};
async function load(rel, outName) {
  const p = resolve(__dirname, rel);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  writeFileSync(join(tmpDir, outName), rewrite(code));
}
await load('src/components/UpdateBanner.tsx', 'UpdateBanner.mjs');
await load('src/lib/updateBanner.ts', 'updateBanner.mjs');

writeFileSync(join(tmpDir, 'button.mjs'), `export function Button() { return null; }\n`);
// Minimal hooks: state lives in slot arrays; effects are recorded (not run) so the harness
// decides when the mount effect fires and can invoke its cleanup (unmount).
writeFileSync(join(tmpDir, 'react.mjs'), `export const R = { slots: [], idx: 0, effects: [], cleanups: [], rerender: null };
export function useState(init) {
  const i = R.idx++;
  if (!(i in R.slots)) R.slots[i] = init;
  const set = (v) => { R.slots[i] = typeof v === 'function' ? v(R.slots[i]) : v; };
  return [R.slots[i], set];
}
export function useEffect(fn) {
  const i = R.effectIdx++;
  if (!R.effects[i]) R.effects[i] = fn;
}\n`);
writeFileSync(join(tmpDir, 'electron.mjs'), `export const E = { getUpdateState: null, listener: null, off: 0, installed: 0, downloaded: 0 };
export function getUpdateState() { return E.getUpdateState(); }
export function onUpdateState(cb) { E.listener = cb; return () => { E.off += 1; }; }
export function installUpdateNow() { E.installed += 1; return Promise.resolve(true); }
export function openUpdateDownload() { E.downloaded += 1; return Promise.resolve(true); }\n`);

const { UpdateBanner } = await import(join(tmpDir, 'UpdateBanner.mjs'));
const { R } = await import(join(tmpDir, 'react.mjs'));
const { E } = await import(join(tmpDir, 'electron.mjs'));
const { Button } = await import(join(tmpDir, 'button.mjs'));

// ---- harness ----------------------------------------------------------------
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
const find = (root, pred) => { const out = []; walk(root, (e) => pred(e) && out.push(e)); return out; };
const text = (c) => (Array.isArray(c) ? c.flat(Infinity).join('') : String(c ?? ''));

// Re-render = call the component again over the persisted slots.
function render() {
  R.idx = 0;
  R.effectIdx = 0;
  return UpdateBanner();
}
// Mount = first render, then run the mount effect (stores its cleanup).
function mount() {
  R.slots = []; R.effects = []; R.cleanups = [];
  const first = render();
  R.effects.forEach((fn, i) => { R.cleanups[i] = fn(); });
  return first;
}
const flush = () => new Promise((r) => setImmediate(r));
const st = (over = {}) => ({
  status: 'ready', currentVersion: '1.0.0', version: '1.2.3', percent: null,
  silent: false, downloadUrl: null, error: null, lastCheckedAt: null, ...over,
});
const buttons = (root) => find(root, (e) => e.type === Button);
const action = (root) => buttons(root).find((b) => b.props['aria-label'] === undefined);
const dismiss = (root) => buttons(root).find((b) => b.props['aria-label'] === 'Dismiss update notice');
// Mount with the given initial getUpdateState() result and settle it into state.
async function mountWith(state) {
  E.getUpdateState = () => Promise.resolve(state);
  mount();
  await flush();
  return render();
}

beforeEach(() => {
  E.getUpdateState = () => Promise.resolve(null);
  E.listener = null; E.off = 0; E.installed = 0; E.downloaded = 0;
});

// ---- rendering --------------------------------------------------------------
test('renders nothing when there is no update state (the non-Electron / idle case)', async () => {
  assert.equal(mount(), null);
  await flush();
  assert.equal(render(), null);
  assert.equal(await mountWith(st({ status: 'idle' })), null);
});

test('renders an accessible status chip with the view text', async () => {
  const root = await mountWith(st({ status: 'ready', version: '1.2.3' }));
  assert.equal(root.type, 'div');
  assert.equal(root.props.role, 'status');
  assert.equal(root.props['aria-live'], 'polite');
  assert.equal(root.props['data-testid'], 'update-banner');
  const spans = find(root, (e) => e.type === 'span');
  assert.equal(spans.length, 1);
  assert.equal(text(spans[0].props.children), 'Update 1.2.3 ready — restart to apply');
});

test('the dismiss button is labelled "Dismiss update notice" and shows ×', async () => {
  const root = await mountWith(st());
  const d = dismiss(root);
  assert.ok(d);
  assert.equal(text(d.props.children), '×');
});

test('a push from onUpdateState surfaces the chip', async () => {
  assert.equal(await mountWith(null), null);
  assert.equal(typeof E.listener, 'function');
  E.listener(st({ status: 'downloading', version: '2.0.0', percent: 40 }));
  const root = render();
  assert.equal(text(find(root, (e) => e.type === 'span')[0].props.children), 'Downloading update 2.0.0 (40%)…');
});

// ---- action routing ---------------------------------------------------------
test('ready: the Restart action calls installUpdateNow and only it', async () => {
  const root = await mountWith(st({ status: 'ready' }));
  const a = action(root);
  assert.equal(text(a.props.children), 'Restart');
  a.props.onClick();
  assert.deepEqual([E.installed, E.downloaded], [1, 0]);
});

test('available with a downloadUrl: the Download action calls openUpdateDownload and only it', async () => {
  const root = await mountWith(st({ status: 'available', downloadUrl: 'https://x/y' }));
  const a = action(root);
  assert.equal(text(a.props.children), 'Download');
  a.props.onClick();
  assert.deepEqual([E.installed, E.downloaded], [0, 1]);
});

test('no action button (only dismiss) when the view has no action', async () => {
  for (const s of [st({ status: 'downloading', percent: 10 }), st({ status: 'available', downloadUrl: null })]) {
    const root = await mountWith(s);
    assert.equal(buttons(root).length, 1);
    assert.ok(dismiss(root));
    assert.equal(action(root), undefined);
  }
});

// ---- dismiss key ------------------------------------------------------------
test('dismiss hides the chip without triggering any action', async () => {
  const root = await mountWith(st({ status: 'ready', version: '1.2.3' }));
  dismiss(root).props.onClick();
  assert.equal(render(), null);
  assert.deepEqual([E.installed, E.downloaded], [0, 0]);
});

test('dismiss is per version: the same kind at a later version re-surfaces the chip', async () => {
  const root = await mountWith(st({ status: 'ready', version: '1.2.3' }));
  dismiss(root).props.onClick();
  assert.equal(render(), null);
  E.listener(st({ status: 'ready', version: '1.2.3', percent: 100 })); // same (kind, version) stays hidden
  assert.equal(render(), null);
  E.listener(st({ status: 'ready', version: '1.2.4' }));
  const again = render();
  assert.ok(again);
  assert.equal(text(find(again, (e) => e.type === 'span')[0].props.children), 'Update 1.2.4 ready — restart to apply');
});

test('dismiss is per kind: a different kind at the same version re-surfaces the chip', async () => {
  const root = await mountWith(st({ status: 'downloading', version: '1.2.3', percent: 5 }));
  dismiss(root).props.onClick();
  assert.equal(render(), null);
  E.listener(st({ status: 'ready', version: '1.2.3' }));
  assert.ok(render());
});

test('a null version keys as "kind:" — dismissing it still holds across re-renders', async () => {
  const root = await mountWith(st({ status: 'available', version: null, downloadUrl: 'https://x' }));
  dismiss(root).props.onClick();
  assert.equal(render(), null);
  assert.equal(R.slots[1], 'available:');
});

// ---- subscribe lifecycle ----------------------------------------------------
test('mount subscribes to onUpdateState and does not unsubscribe yet', async () => {
  await mountWith(null);
  assert.equal(typeof E.listener, 'function');
  assert.equal(E.off, 0);
});

test('unmount calls the unsubscribe function returned by onUpdateState exactly once', async () => {
  await mountWith(null);
  R.cleanups[0]();
  assert.equal(E.off, 1);
});

test('a getUpdateState() result that resolves after unmount does not set state (live guard)', async () => {
  let resolveIt;
  E.getUpdateState = () => new Promise((r) => { resolveIt = r; });
  mount();
  R.cleanups[0]();
  resolveIt(st({ status: 'ready' }));
  await flush();
  assert.equal(R.slots[0], null);
  assert.equal(render(), null);
});

test('a getUpdateState() result that resolves while mounted does set state', async () => {
  let resolveIt;
  E.getUpdateState = () => new Promise((r) => { resolveIt = r; });
  mount();
  assert.equal(render(), null);
  resolveIt(st({ status: 'ready' }));
  await flush();
  assert.ok(render());
});
