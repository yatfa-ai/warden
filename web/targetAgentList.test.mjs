// Tests for TargetAgentList (web/src/components/TargetAgentList.tsx) — the shared
// bordered target list rendered inside the KillDialog / KeySendDialog safety gates
// (name · type · host · optional role, plus a per-row themed Copy menu).
//
// No DOM test runner in this repo, so (like errorState.test.mjs / agentRow.test.mjs)
// this loads the REAL TargetAgentList.tsx and the REAL lib/chatDisplay.ts via Vite's
// OXC transform into a tmp dir under web/, rewrites the `@/...` specifiers, and stubs
// ONLY uiStore (useHostLabels), clipboardToast and the context-menu primitives.
// Markup assertions use renderToStaticMarkup; Copy handlers are read off the element
// tree returned by calling TargetAgentList(props) and invoked directly. (The component
// calls useHostLabels() — stubbed to a plain function — so calling it directly is safe.)
//
// Run: node --test targetAgentList.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-targetagentlist-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const REAL = { '@/lib/chatDisplay': ['src/lib/chatDisplay.ts', 'chatDisplay.mjs'] };
const STUBS = {
  '@/components/ui/context-menu': 'contextMenu.mjs',
  '@/lib/clipboardToast': 'clipboardToast.mjs',
  '@/lib/uiStore': 'uiStore.mjs',
};
const rewrite = (code) => {
  let out = code;
  for (const [spec, [, f]] of Object.entries(REAL)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  return out;
};
async function load(srcRel, outName) {
  const p = resolve(__dirname, srcRel);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  writeFileSync(join(tmpDir, outName), rewrite(code));
}
for (const [src, out] of Object.values(REAL)) await load(src, out);
await load('src/components/TargetAgentList.tsx', 'TargetAgentList.mjs');

writeFileSync(join(tmpDir, 'uiStore.mjs'), `export const state = { hostLabels: {} };
export function useHostLabels() { return state.hostLabels; }\n`);
writeFileSync(join(tmpDir, 'clipboardToast.mjs'), `export const copied = [];
export function copyWithToast(t) { copied.push(t); }\n`);
writeFileSync(join(tmpDir, 'contextMenu.mjs'), `import { createElement as h } from 'react';
export function ContextMenu(p) { return h('div', { 'data-cm': '1' }, p.children); }
export function ContextMenuTrigger(p) { return p.children; }
export function ContextMenuContent(p) { return h('menu', null, p.children); }
export function ContextMenuItem(p) { return h('button', { 'data-item': '1' }, p.children); }\n`);

const { TargetAgentList } = await import(join(tmpDir, 'TargetAgentList.mjs'));
const { copied } = await import(join(tmpDir, 'clipboardToast.mjs'));
const { state } = await import(join(tmpDir, 'uiStore.mjs'));
const { ContextMenu, ContextMenuItem } = await import(join(tmpDir, 'contextMenu.mjs'));

// ---- helpers ----------------------------------------------------------------
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
const find = (root, pred) => { const out = []; walk(root, (e) => pred(e) && out.push(e)); return out; };
const tree = (targets) => TargetAgentList({ targets });
const html = (targets) => renderToStaticMarkup(React.createElement(TargetAgentList, { targets }));
const menus = (root) => find(root, (e) => e.type === ContextMenu);
const rowItems = (menu) => find(menu, (e) => e.type === ContextMenuItem);
const labels = (menu) => rowItems(menu).map((e) => e.props.children);
const select = (menu, label) => rowItems(menu).find((e) => e.props.children === label).props.onSelect();
// The <li> row's four-ish spans, as [text, class] pairs.
const spans = (rowHtml) => [...rowHtml.matchAll(/<span class="([^"]*)"[^>]*>([^<]*)<\/span>/g)].map((m) => [m[2], m[1]]);
const lis = (out) => [...out.matchAll(/<li[^>]*>.*?<\/li>/g)].map((m) => m[0]);

const yatfa = (o = {}) => ({ id: 'chat-1', key: 'proj-worker', kind: 'yatfa', host: 'box.example', role: 'worker', ...o });
const shell = (o = {}) => ({ id: 'chat-2', key: 'chat-2', kind: 'tmux', cmd: 'bash', cwd: '/home/me/repo', host: '(local)', ...o });

beforeEach(() => { copied.length = 0; state.hostLabels = {}; });

// ---- row layout -----------------------------------------------------------------
test('renders one row per target, in the given order', () => {
  const out = html([yatfa(), shell({ id: 'a', key: 'a', name: 'alpha' }), shell({ id: 'b', key: 'b', name: 'beta' })]);
  const rows = lis(out);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes('proj-worker'));
  assert.ok(rows[1].includes('>alpha<'));
  assert.ok(rows[2].includes('>beta<'));
});

test('empty targets render the bordered list with no rows', () => {
  const out = html([]);
  assert.ok(out.includes('border-border'));
  assert.equal(lis(out).length, 0);
});

test('a row shows name, type, host, role in that order, with the name span carrying a title tooltip', () => {
  const out = html([yatfa()]);
  assert.deepEqual(spans(out).map(([t]) => t), ['proj-worker', 'yatfa', 'box.example', 'worker']);
  assert.ok(out.includes('title="proj-worker"'), out);
  const [name, type, host, role] = spans(out);
  assert.ok(name[1].includes('truncate') && name[1].includes('flex-1'));
  assert.ok(type[1].includes('shrink-0') && host[1].includes('shrink-0') && role[1].includes('shrink-0'));
});

test('name comes from displayName and type from chatType (not the raw fields)', () => {
  const out = html([shell({ cmd: 'claude --resume x', name: 'renamed', key: 'k' })]);
  assert.deepEqual(spans(out).map(([t]) => t).slice(0, 2), ['renamed', 'resume']);
  // Unnamed tmux shell falls back to "process · cwd-basename".
  const out2 = html([shell()]);
  assert.ok(out2.includes('>shell · repo<'), out2);
});

test('name span escapes markup', () => {
  const out = html([shell({ name: '<b>x</b>' })]);
  assert.ok(!out.includes('<b>x</b>'), out);
  assert.ok(out.includes('&lt;b&gt;x&lt;/b&gt;'), out);
});

// ---- host label resolution (WARDEN-735 invariant) ---------------------------------
test('host is resolved through the configured host labels (2-arg hostTagOf)', () => {
  state.hostLabels = { 'box.example': 'Build Box' };
  const out = html([yatfa()]);
  assert.ok(spans(out).some(([t]) => t === 'Build Box'), out);
  assert.ok(!out.includes('box.example'), out);
});

test('a host without a label renders raw; a blank/whitespace label falls back to the raw host', () => {
  state.hostLabels = { 'other': 'Other' };
  assert.ok(html([yatfa()]).includes('>box.example<'));
  state.hostLabels = { 'box.example': '   ' };
  assert.ok(html([yatfa()]).includes('>box.example<'));
});

test('this machine reads "local" unlabeled and its label when labeled', () => {
  assert.ok(html([shell()]).includes('>local<'));
  state.hostLabels = { '(local)': 'My Mac' };
  const out = html([shell()]);
  assert.ok(out.includes('>My Mac<'));
  assert.ok(!out.includes('>local<'));
});

test('a missing host renders an empty host span instead of throwing', () => {
  const out = html([yatfa({ host: undefined })]);
  assert.deepEqual(spans(out).map(([t]) => t), ['proj-worker', 'yatfa', '', 'worker']);
});

test('every row resolves its own host (labels apply per row)', () => {
  state.hostLabels = { 'a.host': 'Alpha' };
  const out = html([yatfa({ id: '1', key: 'k1', host: 'a.host' }), yatfa({ id: '2', key: 'k2', host: 'b.host' })]);
  const [r1, r2] = lis(out);
  assert.ok(r1.includes('>Alpha<') && !r1.includes('a.host'));
  assert.ok(r2.includes('>b.host<'));
});

// ---- role gating -------------------------------------------------------------------
test('role span and Copy role item appear only when the target has a role', () => {
  const withRole = tree([yatfa()]);
  const without = tree([yatfa({ role: undefined })]);
  assert.deepEqual(labels(menus(withRole)[0]), ['Copy agent name', 'Copy type', 'Copy host', 'Copy role']);
  assert.deepEqual(labels(menus(without)[0]), ['Copy agent name', 'Copy type', 'Copy host']);
  assert.equal(spans(html([yatfa()])).length, 4);
  assert.equal(spans(html([yatfa({ role: undefined })])).length, 3);
  assert.equal(spans(html([yatfa({ role: '' })])).length, 3);
  assert.deepEqual(labels(menus(tree([yatfa({ role: '' })]))[0]), ['Copy agent name', 'Copy type', 'Copy host']);
});

test('role gating is per row', () => {
  const root = tree([yatfa({ id: '1', key: 'k1' }), yatfa({ id: '2', key: 'k2', role: undefined })]);
  const [m1, m2] = menus(root);
  assert.equal(labels(m1).length, 4);
  assert.equal(labels(m2).length, 3);
});

// ---- keys --------------------------------------------------------------------------
test('rows are keyed by key, falling back to id when key is empty', () => {
  const root = tree([yatfa({ id: 'id-1', key: 'key-1' }), yatfa({ id: 'id-2', key: '' }), yatfa({ id: 'id-3', key: undefined })]);
  assert.deepEqual(menus(root).map((m) => m.key), ['key-1', 'id-2', 'id-3']);
});

// ---- copy wiring -------------------------------------------------------------------
test('each Copy item copies the displayed name / type / resolved host / role', () => {
  state.hostLabels = { 'box.example': 'Build Box' };
  const [menu] = menus(tree([yatfa()]));
  select(menu, 'Copy agent name');
  select(menu, 'Copy type');
  select(menu, 'Copy host');
  select(menu, 'Copy role');
  assert.deepEqual(copied, ['proj-worker', 'yatfa', 'Build Box', 'worker']);
});

test('Copy host copies "local" for this machine when unlabeled', () => {
  const [menu] = menus(tree([shell()]));
  select(menu, 'Copy host');
  assert.deepEqual(copied, ['local']);
});

test('Copy items copy their own row (no closure bleed between rows)', () => {
  const root = tree([
    yatfa({ id: '1', key: 'one', host: 'h1', role: 'r1' }),
    yatfa({ id: '2', key: 'two', host: 'h2', role: 'r2' }),
  ]);
  const [m1, m2] = menus(root);
  select(m2, 'Copy agent name');
  select(m1, 'Copy agent name');
  select(m2, 'Copy host');
  select(m1, 'Copy role');
  assert.deepEqual(copied, ['two', 'one', 'h2', 'r1']);
});
