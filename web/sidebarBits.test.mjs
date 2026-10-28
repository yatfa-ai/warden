// Tests for SidebarBits (web/src/components/sidebar/SidebarBits.tsx) — the Fleet Health
// multi-select SelectionActionBar (button wiring, themed right-click menu `actions` map,
// copy-names payload, Interrupt/Watch gating) and UpdatedAgo (null guard + shared pref).
//
// No DOM test runner in this repo, so (like errorState.test.mjs) this loads the REAL
// SidebarBits.tsx AND the REAL selectionBarMenu.ts via Vite's OXC transform into a tmp dir
// under web/ (so `react/jsx-runtime` resolves from web/node_modules), rewrites the `@/...`
// specifiers, and stubs ONLY the leaf modules (Button, ContextMenu*, copyWithToast, uiStore,
// formatTimestamp). Handlers are read off the element tree returned by calling
// SelectionActionBar(props) (it uses no hooks) and invoked directly; UpdatedAgo uses hooks, so
// it is rendered with renderToStaticMarkup.
//
// Run: node --test sidebarBits.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-sidebarbits-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const STUBS = {
  '@/components/ui/button': 'button.mjs',
  '@/components/ui/context-menu': 'contextMenu.mjs',
  '@/lib/clipboardToast': 'clipboardToast.mjs',
  '@/lib/uiStore': 'uiStore.mjs',
  '@/lib/formatTimestamp': 'formatTimestamp.mjs',
  '@/lib/selectionBarMenu': 'selectionBarMenu.mjs', // the REAL module, transpiled below
};
const rewrite = (code) => {
  let out = code;
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  return out;
};
async function load(rel, outName) {
  const p = resolve(__dirname, rel);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  writeFileSync(join(tmpDir, outName), rewrite(code));
}
await load('src/components/sidebar/SidebarBits.tsx', 'SidebarBits.mjs');
await load('src/lib/selectionBarMenu.ts', 'selectionBarMenu.mjs');

writeFileSync(join(tmpDir, 'button.mjs'), `import { createElement as h } from 'react';
export function Button(p) { return h('button', { 'data-variant': p.variant, title: p.title }, p.children); }\n`);
writeFileSync(join(tmpDir, 'contextMenu.mjs'), `import { createElement as h } from 'react';
export function ContextMenu(p) { return h('div', null, p.children); }
export function ContextMenuTrigger(p) { return p.children; }
export function ContextMenuContent(p) { return h('menu', null, p.children); }
export function ContextMenuSeparator() { return h('hr'); }
export function ContextMenuItem(p) { return h('button', { 'data-item': '1' }, p.children); }\n`);
writeFileSync(join(tmpDir, 'clipboardToast.mjs'), `export const copied = [];
export function copyWithToast(t) { copied.push(t); }\n`);
writeFileSync(join(tmpDir, 'uiStore.mjs'), `export const pref = { value: 'relative' };
export function useTimestampFormat() { return pref.value; }\n`);
writeFileSync(join(tmpDir, 'formatTimestamp.mjs'), `export const calls = [];
export function formatTimestamp(at, fmt, opts) { calls.push({ at, fmt, opts }); return 'TS[' + at + '|' + fmt + '|' + (opts && opts.withSuffix) + ']'; }\n`);

const { SelectionActionBar, UpdatedAgo } = await import(join(tmpDir, 'SidebarBits.mjs'));
const { copied } = await import(join(tmpDir, 'clipboardToast.mjs'));
const { pref } = await import(join(tmpDir, 'uiStore.mjs'));
const { calls } = await import(join(tmpDir, 'formatTimestamp.mjs'));
const { Button } = await import(join(tmpDir, 'button.mjs'));
const { ContextMenuItem, ContextMenuSeparator } = await import(join(tmpDir, 'contextMenu.mjs'));

// ---- helpers ----------------------------------------------------------------
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
const find = (root, pred) => { const out = []; walk(root, (e) => pred(e) && out.push(e)); return out; };
const text = (c) => (Array.isArray(c) ? c.flat(Infinity).join('') : String(c ?? ''));
const buttons = (root) => find(root, (e) => e.type === Button);
const buttonByLabel = (root, label) => buttons(root).find((e) => text(e.props.children) === label);
const menuItems = (root) => find(root, (e) => e.type === ContextMenuItem);
const menuItem = (root, label) => menuItems(root).find((e) => text(e.props.children) === label);
const bar = (over = {}) => {
  const calls = [];
  const mk = (n) => () => calls.push(n);
  const props = { count: 3, onSelectAll: mk('all'), onClear: mk('clear'), onKill: mk('kill'), ...over };
  return { calls, root: SelectionActionBar(props) };
};
const full = (over = {}) => {
  const log = [];
  const mk = (n) => () => log.push(n);
  const root = SelectionActionBar({
    count: 3, onSelectAll: mk('all'), onClear: mk('clear'), onKill: mk('kill'),
    onInterrupt: mk('interrupt'), onWatch: mk('watch'), watchMode: 'watch', ...over,
  });
  return { log, root };
};

beforeEach(() => { copied.length = 0; calls.length = 0; pref.value = 'relative'; });

// ---- SelectionActionBar: buttons ---------------------------------------------
test('shows the live count as "N selected"', () => {
  const { root } = bar({ count: 7 });
  assert.ok(find(root, (e) => e.type === 'span' && text(e.props.children) === '7 selected').length === 1);
});

test('All calls onSelectAll and only it', () => {
  const { calls, root } = bar();
  buttonByLabel(root, 'All').props.onClick();
  assert.deepEqual(calls, ['all']);
});

test('Clear calls onClear and only it', () => {
  const { calls, root } = bar();
  buttonByLabel(root, 'Clear').props.onClick();
  assert.deepEqual(calls, ['clear']);
});

test('Kill N… is the destructive button, carries the count, and calls onKill and only it', () => {
  const { calls, root } = bar({ count: 4 });
  const kill = buttonByLabel(root, 'Kill 4…');
  assert.ok(kill, 'Kill 4… button missing');
  assert.equal(kill.props.variant, 'destructive');
  kill.props.onClick();
  assert.deepEqual(calls, ['kill']);
});

test('Interrupt button renders only when onInterrupt is given, calls it, and is not destructive', () => {
  assert.equal(buttonByLabel(bar().root, 'Interrupt 3…'), undefined);
  const { log, root } = full({ count: 2 });
  const b = buttonByLabel(root, 'Interrupt 2…');
  assert.ok(b, 'Interrupt 2… button missing');
  assert.notEqual(b.props.variant, 'destructive');
  b.props.onClick();
  assert.deepEqual(log, ['interrupt']);
});

test('Watch button renders only when onWatch is given and calls it', () => {
  assert.equal(buttons(bar().root).some((b) => /Watch/.test(text(b.props.children))), false);
  const { log, root } = full();
  buttonByLabel(root, 'Watch 3').props.onClick();
  assert.deepEqual(log, ['watch']);
});

test('Watch/Unwatch label and title follow watchMode, with no ellipsis', () => {
  const w = buttonByLabel(full({ watchMode: 'watch' }).root, 'Watch 3');
  assert.ok(w);
  assert.match(w.props.title, /^watch every selected agent/);
  const u = buttonByLabel(full({ watchMode: 'unwatch' }).root, 'Unwatch 3');
  assert.ok(u);
  assert.match(u.props.title, /^stop watching every selected agent/);
  assert.ok(!text(w.props.children).includes('…') && !text(u.props.children).includes('…'));
  // watchMode omitted defaults to the "Watch" wording.
  assert.ok(buttonByLabel(full({ watchMode: undefined }).root, 'Watch 3'));
});

// ---- SelectionActionBar: context menu ----------------------------------------
test('context menu is derived from the same gating as the buttons (hasInterrupt / hasWatch)', () => {
  const labels = (root) => menuItems(root).map((e) => text(e.props.children));
  assert.deepEqual(labels(bar().root), ['Select all', 'Clear selection', 'Kill 3…']);
  assert.deepEqual(labels(full().root), ['Select all', 'Clear selection', 'Interrupt 3…', 'Watch 3', 'Kill 3…']);
  assert.ok(labels(full({ watchMode: 'unwatch' }).root).includes('Unwatch 3'));
});

test('each context-menu item id dispatches to the SAME handler as its button', () => {
  const cases = [['Select all', 'all'], ['Clear selection', 'clear'], ['Interrupt 3…', 'interrupt'], ['Watch 3', 'watch'], ['Kill 3…', 'kill']];
  for (const [label, expected] of cases) {
    const { log, root } = full();
    menuItem(root, label).props.onSelect();
    assert.deepEqual(log, [expected], `menu item "${label}" ran ${JSON.stringify(log)}`);
  }
});

test('the Kill menu item is destructive and sits last, after a separator; others are not destructive', () => {
  const { root } = full();
  const items = menuItems(root);
  const kill = items[items.length - 1];
  assert.equal(text(kill.props.children), 'Kill 3…');
  assert.equal(kill.props.variant, 'destructive');
  for (const it of items.slice(0, -1)) assert.equal(it.props.variant, undefined);
  assert.equal(find(root, (e) => e.type === ContextMenuSeparator).length, 1);
});

test('copy-names copies non-blank names joined with newlines', () => {
  const { root } = full({ selectedNames: ['alpha', '', 'beta', 'gamma'] });
  menuItem(root, 'Copy selected agent names').props.onSelect();
  assert.deepEqual(copied, ['alpha\nbeta\ngamma']);
});

test('Copy selected agent names is hidden when names are absent or all blank', () => {
  assert.equal(menuItem(full().root, 'Copy selected agent names'), undefined);
  assert.equal(menuItem(full({ selectedNames: [] }).root, 'Copy selected agent names'), undefined);
  assert.equal(menuItem(full({ selectedNames: ['', ''] }).root, 'Copy selected agent names'), undefined);
});

// ---- UpdatedAgo ---------------------------------------------------------------
const ago = (props) => renderToStaticMarkup(React.createElement(UpdatedAgo, props));

test('UpdatedAgo renders nothing for missing, null or zero `at`', () => {
  assert.equal(ago({}), '');
  assert.equal(ago({ at: null }), '');
  assert.equal(ago({ at: 0 }), '');
  assert.equal(calls.length, 0);
});

test('UpdatedAgo renders formatTimestamp(at, sharedPref, {withSuffix:true})', () => {
  assert.match(ago({ at: 1234 }), />TS\[1234\|relative\|true\]</);
  assert.deepEqual(calls, [{ at: 1234, fmt: 'relative', opts: { withSuffix: true } }]);
});

test('UpdatedAgo follows the shared timestamp pref', () => {
  pref.value = 'absolute';
  assert.match(ago({ at: 99 }), />TS\[99\|absolute\|true\]</);
});
