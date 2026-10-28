// Tests for RecoveryPanel (web/src/components/PaneRecoveryPanel.tsx) — the in-pane
// dead-session / unresponsive overlay behind PaneTile's recovery phases
// (session_dead, host_unreachable, error).
//
// Pinned: the respawnable gate `chat?.kind === 'tmux' && chat?.cmd != null`
// (incl. WARDEN-1422: an EMPTY cmd is the host login shell and IS respawnable),
// the per-variant button sets, the per-button disabled rules, handler wiring,
// variants/icons, title/description/icon rendering and root stopPropagation.
//
// HARNESS (seam-first, like confirmDialog.test.mjs): the REAL .tsx is transpiled
// with vite's transformWithOxc into a tmp dir under web/; `@/components/ui/button`
// and `lucide-react` are rewritten onto test-local stubs (asserted: no `@/`
// specifier survives). RecoveryPanel(props) is called directly and the returned
// element tree walked.
//
// Run: node --test paneRecoveryPanel.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-panerecoverypanel-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const STUBS = {
  '@/components/ui/button': 'button.mjs',
  'lucide-react': 'icons.mjs',
};
const srcPath = resolve(__dirname, 'src/components/PaneRecoveryPanel.tsx');
const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
let rewritten = code;
for (const [spec, f] of Object.entries(STUBS)) {
  for (const q of ["'", '"']) rewritten = rewritten.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
}
assert.doesNotMatch(rewritten, /['"]@\//, 'an @/ specifier survived the rewrite');
assert.doesNotMatch(rewritten, /from ['"]lucide-react['"]/, 'lucide-react survived the rewrite');
writeFileSync(join(tmpDir, 'pane-recovery-panel.mjs'), rewritten);
writeFileSync(join(tmpDir, 'button.mjs'), `export function Button(p) { return null; }\n`);
writeFileSync(
  join(tmpDir, 'icons.mjs'),
  `const mk = (n) => { const f = (p) => null; Object.defineProperty(f, 'name', { value: n }); return f; };
export const PowerIcon = mk('PowerIcon');
export const RefreshCwIcon = mk('RefreshCwIcon');
export const SquareTerminalIcon = mk('SquareTerminalIcon');
export const XIcon = mk('XIcon');\n`,
);

const { RecoveryPanel } = await import(join(tmpDir, 'pane-recovery-panel.mjs'));
const { Button } = await import(join(tmpDir, 'button.mjs'));
const I = await import(join(tmpDir, 'icons.mjs'));

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
const text = (el) => [el.props.children].flat(Infinity).filter((c) => typeof c === 'string').join('').trim();
const labels = (root) => buttons(root).map(text);
const btn = (root, label) => {
  const hits = buttons(root).filter((b) => text(b) === label);
  assert.equal(hits.length, 1, `expected exactly one "${label}" button`);
  return hits[0];
};
const iconOf = (b) => {
  const [icon] = [b.props.children].flat();
  return icon.type;
};
const noop = () => {};
const render = (over = {}) =>
  RecoveryPanel({
    title: 'Agent session not found',
    description: 'The tmux session is gone.',
    icon: React.createElement('i', { id: 'hero' }),
    busy: false,
    onClose: noop,
    ...over,
  });
const tmux = (cmd) => ({ id: 'c1', kind: 'tmux', cmd });

// ---- respawnable gate -----------------------------------------------------------
test('Re-spawn is shown for tmux chat with a cmd', () => {
  assert.deepEqual(labels(render({ chat: tmux('claude') })), ['Open shell here', 'Re-spawn agent', 'Close']);
});

test('Re-spawn is shown for tmux chat with an EMPTY cmd (WARDEN-1422: host login shell)', () => {
  assert.ok(labels(render({ chat: tmux('') })).includes('Re-spawn agent'));
});

test('Re-spawn is hidden for missing or null cmd', () => {
  assert.ok(!labels(render({ chat: { id: 'c1', kind: 'tmux' } })).includes('Re-spawn agent'));
  assert.ok(!labels(render({ chat: tmux(null) })).includes('Re-spawn agent'));
});

test('Re-spawn is hidden for non-tmux kind, no chat and null chat', () => {
  assert.ok(!labels(render({ chat: { id: 'c1', kind: 'yatfa', cmd: 'x' } })).includes('Re-spawn agent'));
  assert.ok(!labels(render({})).includes('Re-spawn agent'));
  assert.ok(!labels(render({ chat: null })).includes('Re-spawn agent'));
});

// ---- variants -------------------------------------------------------------------
test('default variant is recovery: Open shell + Close, no Retry', () => {
  assert.deepEqual(labels(render({ chat: { id: 'c1', kind: 'yatfa' } })), ['Open shell here', 'Close']);
  assert.deepEqual(labels(render({ chat: tmux('x'), variant: 'recovery' })), ['Open shell here', 'Re-spawn agent', 'Close']);
});

test('unresponsive variant shows only Retry + Close, even for a respawnable chat', () => {
  assert.deepEqual(labels(render({ chat: tmux('claude'), variant: 'unresponsive' })), ['Retry', 'Close']);
});

// ---- disabled rules -------------------------------------------------------------
test('Open shell is disabled by busy or by missing chat', () => {
  assert.equal(btn(render({ chat: tmux('x') }), 'Open shell here').props.disabled, false);
  assert.equal(btn(render({ chat: tmux('x'), busy: true }), 'Open shell here').props.disabled, true);
  assert.equal(btn(render({ busy: false }), 'Open shell here').props.disabled, true);
  assert.equal(btn(render({ chat: null }), 'Open shell here').props.disabled, true);
});

test('Re-spawn, Retry and Close are disabled by busy only', () => {
  const rec = (busy) => render({ chat: tmux('x'), busy });
  assert.equal(btn(rec(false), 'Re-spawn agent').props.disabled, false);
  assert.equal(btn(rec(true), 'Re-spawn agent').props.disabled, true);
  assert.equal(btn(rec(false), 'Close').props.disabled, false);
  assert.equal(btn(rec(true), 'Close').props.disabled, true);
  // Retry is enabled with no chat at all
  const un = (busy) => render({ variant: 'unresponsive', busy });
  assert.equal(btn(un(false), 'Retry').props.disabled, false);
  assert.equal(btn(un(true), 'Retry').props.disabled, true);
  assert.equal(btn(un(false), 'Close').props.disabled, false);
});

// ---- handler wiring, variants, icons ----------------------------------------------
test('each button onClick is the matching prop', () => {
  const onOpenShell = () => {}, onRespawn = () => {}, onRetry = () => {}, onClose = () => {};
  const rec = render({ chat: tmux('x'), onOpenShell, onRespawn, onRetry, onClose });
  assert.equal(btn(rec, 'Open shell here').props.onClick, onOpenShell);
  assert.equal(btn(rec, 'Re-spawn agent').props.onClick, onRespawn);
  assert.equal(btn(rec, 'Close').props.onClick, onClose);
  const un = render({ variant: 'unresponsive', onOpenShell, onRespawn, onRetry, onClose });
  assert.equal(btn(un, 'Retry').props.onClick, onRetry);
  assert.equal(btn(un, 'Close').props.onClick, onClose);
});

test('button variants and icons: primary default, outline re-spawn, ghost close', () => {
  const rec = render({ chat: tmux('x') });
  assert.equal(btn(rec, 'Open shell here').props.variant, undefined);
  assert.equal(btn(rec, 'Re-spawn agent').props.variant, 'outline');
  assert.equal(btn(rec, 'Close').props.variant, 'ghost');
  assert.equal(iconOf(btn(rec, 'Open shell here')), I.SquareTerminalIcon);
  assert.equal(iconOf(btn(rec, 'Re-spawn agent')), I.PowerIcon);
  assert.equal(iconOf(btn(rec, 'Close')), I.XIcon);
  const un = render({ variant: 'unresponsive' });
  assert.equal(btn(un, 'Retry').props.variant, undefined);
  assert.equal(iconOf(btn(un, 'Retry')), I.RefreshCwIcon);
});

// ---- content + root ----------------------------------------------------------------
test('title, description and icon are rendered', () => {
  const root = render({ title: 'Host unreachable', description: 'Cannot reach host.' });
  assert.equal(text(findAll(root, (e) => e.type === 'div' && /font-medium/.test(e.props.className ?? ''))[0]), 'Host unreachable');
  assert.equal(text(findAll(root, (e) => e.type === 'p')[0]), 'Cannot reach host.');
  assert.equal(findAll(root, (e) => e.type === 'i' && e.props.id === 'hero').length, 1);
});

test('root onClick stops propagation', () => {
  let stopped = 0;
  render().props.onClick({ stopPropagation: () => stopped++ });
  assert.equal(stopped, 1);
});
