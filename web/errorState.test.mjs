// Tests for ErrorState (web/src/components/ErrorState.tsx) — the shared crash/failure
// fallback ErrorBoundary renders when a panel throws (variant table, title override,
// message derivation, Retry button + context-menu gating, Copy wiring).
//
// No DOM test runner in this repo, so (like agentRow.test.mjs) this loads the REAL
// ErrorState.tsx via Vite's OXC transform into a tmp dir under web/ (so
// `react/jsx-runtime` resolves from web/node_modules), rewrites the `@/...` specifiers,
// and stubs ONLY the leaf primitives (Button, ContextMenu*, copyWithToast, lucide icons).
// Markup assertions use renderToStaticMarkup; handlers are read off the element tree
// returned by calling ErrorState(props) and invoked directly.
//
// Run: node --test errorState.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-errorstate-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const STUBS = {
  '@/components/ui/button': 'button.mjs',
  '@/components/ui/context-menu': 'contextMenu.mjs',
  '@/lib/clipboardToast': 'clipboardToast.mjs',
  'lucide-react': 'lucide.mjs',
};
const rewrite = (code) => {
  let out = code;
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  return out;
};

const srcPath = resolve(__dirname, 'src/components/ErrorState.tsx');
const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
writeFileSync(join(tmpDir, 'ErrorState.mjs'), rewrite(code));

writeFileSync(join(tmpDir, 'button.mjs'), `import { createElement as h } from 'react';
export function Button(p) { return h('button', { 'data-btn': '1', 'data-variant': p.variant, 'data-size': p.size, className: p.className }, p.children); }\n`);
writeFileSync(join(tmpDir, 'contextMenu.mjs'), `import { createElement as h } from 'react';
export function ContextMenu(p) { return h('div', { 'data-cm': '1' }, p.children); }
export function ContextMenuTrigger(p) { return p.children; }
export function ContextMenuContent(p) { return h('menu', null, p.children); }
export function ContextMenuSeparator() { return h('hr'); }
export function ContextMenuItem(p) { return h('button', { 'data-item': '1', disabled: p.disabled }, p.children); }\n`);
writeFileSync(join(tmpDir, 'clipboardToast.mjs'), `export const copied = [];
export function copyWithToast(t) { copied.push(t); }\n`);
writeFileSync(join(tmpDir, 'lucide.mjs'), `import { createElement as h } from 'react';
const icon = (n) => (p) => h('i', { 'data-icon': n, className: p.className });
export const WifiIcon = icon('Wifi');
export const Loader2Icon = icon('Loader');
export const OctagonXIcon = icon('Octagon');
export const RefreshCwIcon = icon('Refresh');\n`);

const { ErrorState } = await import(join(tmpDir, 'ErrorState.mjs'));
const { copied } = await import(join(tmpDir, 'clipboardToast.mjs'));
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
const tree = (props) => ErrorState(props);
const html = (props) => renderToStaticMarkup(React.createElement(ErrorState, props));
const items = (root) => find(root, (e) => e.type === ContextMenuItem);
const itemByLabel = (root, label) => items(root).find((e) => e.props.children === label);
const buttons = (root) => find(root, (e) => e.type === Button);
// Menu children in render order, as labels ('---' for the separator).
const menuOrder = (root) => {
  const out = [];
  walk(root, (e) => {
    if (e.type === ContextMenuItem) out.push(e.props.children);
    else if (e.type === ContextMenuSeparator) out.push('---');
  });
  return out;
};

beforeEach(() => { copied.length = 0; });

// ---- variant table ------------------------------------------------------------
const VARIANTS = [
  ['network', 'Wifi', 'Connection Error', 'Unable to reach the server. Please check your connection.'],
  ['timeout', 'Loader', 'Request Timeout', 'The request took too long to complete. Please try again.'],
  ['api', 'Octagon', 'Server Error', 'Something went wrong on the server. Please try again.'],
  ['general', 'Octagon', 'Error', 'An unexpected error occurred.'],
];
for (const [variant, icon, title, description] of VARIANTS) {
  test(`variant ${variant} renders the ${icon} icon, "${title}" title and its description`, () => {
    const out = html({ error: 'boom', variant });
    assert.ok(out.includes(`data-icon="${icon}"`), out);
    assert.ok(out.includes(`>${title}</div>`), out);
    assert.ok(out.includes(`>${description}</div>`), out);
    // Retry icon must not leak in when there is no onRetry.
    assert.ok(!out.includes('data-icon="Refresh"'), out);
  });
}

test('variant defaults to general when omitted', () => {
  const out = html({ error: 'boom' });
  assert.ok(out.includes('>Error</div>'));
  assert.ok(out.includes('>An unexpected error occurred.</div>'));
  assert.ok(out.includes('data-icon="Octagon"'));
});

// ---- title override -------------------------------------------------------------
test('title prop overrides the variant title; empty string falls back to it', () => {
  assert.ok(html({ error: 'x', variant: 'network', title: 'Panel crashed' }).includes('>Panel crashed</div>'));
  assert.ok(!html({ error: 'x', variant: 'network', title: 'Panel crashed' }).includes('Connection Error'));
  assert.ok(html({ error: 'x', variant: 'network', title: '' }).includes('>Connection Error</div>'));
});

// ---- message derivation ---------------------------------------------------------
const MONO = (m) => `font-mono">${m}</div>`;
test('Error instance renders its .message; string passes through; other values are String()ed', () => {
  assert.ok(html({ error: new Error('kaput') }).includes(MONO('kaput')));
  assert.ok(html({ error: 'plain string' }).includes(MONO('plain string')));
  assert.ok(html({ error: 42 }).includes(MONO('42')));
  assert.ok(html({ error: { a: 1 } }).includes(MONO('[object Object]')));
  assert.ok(html({ error: null }).includes(MONO('null')));
});

test('empty message renders no monospace line', () => {
  assert.ok(!html({ error: '' }).includes('font-mono'));
  assert.ok(!html({ error: new Error('') }).includes('font-mono'));
});

test('message is HTML-escaped', () => {
  const out = html({ error: '<script>alert(1)</script>' });
  assert.ok(!out.includes('<script>'), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
});

test('className is appended to the wrapper; default adds nothing extra', () => {
  assert.ok(html({ error: 'x', className: 'my-extra' }).includes('text-center my-extra"'));
  assert.ok(!html({ error: 'x' }).includes('undefined'));
});

// ---- retry gating ---------------------------------------------------------------
test('Retry button and menu Retry/separator appear only with onRetry', () => {
  assert.equal(buttons(tree({ error: 'x' })).length, 0);
  assert.ok(!html({ error: 'x' }).includes('Retry'));
  assert.deepEqual(menuOrder(tree({ error: 'x' })), ['Copy error message', 'Copy error title']);

  const withRetry = tree({ error: 'x', onRetry: () => {} });
  assert.equal(buttons(withRetry).length, 1);
  assert.ok(html({ error: 'x', onRetry: () => {} }).includes('data-icon="Refresh"'));
  assert.deepEqual(menuOrder(withRetry), ['Retry', '---', 'Copy error message', 'Copy error title']);
});

test('Retry button is an outline/sm button wired to onRetry', () => {
  let n = 0;
  const onRetry = () => { n++; };
  const [btn] = buttons(tree({ error: 'x', onRetry }));
  assert.equal(btn.props.variant, 'outline');
  assert.equal(btn.props.size, 'sm');
  btn.props.onClick();
  assert.equal(n, 1);
});

test('menu Retry calls onRetry() with no arguments (does not leak the select event)', () => {
  const calls = [];
  const root = tree({ error: 'x', onRetry: (...a) => calls.push(a) });
  itemByLabel(root, 'Retry').props.onSelect({ type: 'select' });
  assert.deepEqual(calls, [[]]);
});

// ---- copy wiring ----------------------------------------------------------------
test('Copy error message copies the derived message', () => {
  itemByLabel(tree({ error: new Error('kaput') }), 'Copy error message').props.onSelect();
  assert.deepEqual(copied, ['kaput']);
  copied.length = 0;
  itemByLabel(tree({ error: 7 }), 'Copy error message').props.onSelect();
  assert.deepEqual(copied, ['7']);
});

test('Copy error title copies the displayed title (override honored, variant default otherwise)', () => {
  itemByLabel(tree({ error: 'x', variant: 'timeout' }), 'Copy error title').props.onSelect();
  itemByLabel(tree({ error: 'x', variant: 'timeout', title: 'Custom' }), 'Copy error title').props.onSelect();
  assert.deepEqual(copied, ['Request Timeout', 'Custom']);
});

test('Copy error message is disabled iff the message is empty ("0" is a message); Copy title is never disabled', () => {
  assert.equal(!!itemByLabel(tree({ error: '' }), 'Copy error message').props.disabled, true);
  assert.equal(!!itemByLabel(tree({ error: new Error('') }), 'Copy error message').props.disabled, true);
  assert.equal(!!itemByLabel(tree({ error: 'boom' }), 'Copy error message').props.disabled, false);
  assert.equal(!!itemByLabel(tree({ error: 0 }), 'Copy error message').props.disabled, false);
  assert.equal(!!itemByLabel(tree({ error: '' }), 'Copy error title').props.disabled, false);
});
