// Tests for ConfirmDialog (web/src/components/ui/confirm-dialog.tsx) — the shared
// confirm/dismiss contract behind every destructive-action call site (App,
// CollectionsSection, HealthDashboard, ObserverTabs, SettingsPage, WorkspaceTabs,
// WriteOnlySecretField, HostsSection, ResetSection).
//
// Documented contract: `onConfirm` fires ONLY from the confirm button (the caller
// closes), while Cancel / Escape / overlay all route through `onOpenChange(false)`.
// Structurally that means Cancel sits inside `DialogClose asChild` with NO onClick
// of its own, and the confirm button sits OUTSIDE any DialogClose (otherwise
// confirming would also dismiss).
//
// HARNESS (seam-first, like errorState.test.mjs): the REAL confirm-dialog.tsx is
// transpiled with vite's transformWithOxc into a tmp dir under web/; the
// `@/components/ui/dialog` and `@/components/ui/button` specifiers are rewritten onto
// test-local stubs (asserted: no `@/` specifier survives). ConfirmDialog(props) is
// called directly and the returned element tree inspected.
//
// Run: node --test confirmDialog.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-confirmdialog-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const STUBS = {
  '@/components/ui/dialog': 'dialog.mjs',
  '@/components/ui/button': 'button.mjs',
};
const srcPath = resolve(__dirname, 'src/components/ui/confirm-dialog.tsx');
const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
let rewritten = code;
for (const [spec, f] of Object.entries(STUBS)) {
  for (const q of ["'", '"']) rewritten = rewritten.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
}
assert.doesNotMatch(rewritten, /['"]@\//, 'an @/ specifier survived the rewrite');
writeFileSync(join(tmpDir, 'confirm-dialog.mjs'), rewritten);
writeFileSync(
  join(tmpDir, 'dialog.mjs'),
  `const mk = (n) => { const f = (p) => null; Object.defineProperty(f, 'name', { value: n }); return f; };
export const Dialog = mk('Dialog');
export const DialogClose = mk('DialogClose');
export const DialogContent = mk('DialogContent');
export const DialogDescription = mk('DialogDescription');
export const DialogFooter = mk('DialogFooter');
export const DialogHeader = mk('DialogHeader');
export const DialogTitle = mk('DialogTitle');\n`,
);
writeFileSync(join(tmpDir, 'button.mjs'), `export function Button(p) { return null; }\n`);

const { ConfirmDialog } = await import(join(tmpDir, 'confirm-dialog.mjs'));
const D = await import(join(tmpDir, 'dialog.mjs'));
const { Button } = await import(join(tmpDir, 'button.mjs'));

// ---- helpers ----------------------------------------------------------------
// Pre-order walk collecting { el, ancestors } for every element.
function walk(node, visit, ancestors = []) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit, ancestors));
  if (!React.isValidElement(node)) return;
  visit(node, ancestors);
  walk(node.props.children, visit, [...ancestors, node]);
}
const find = (root, type) => {
  const out = [];
  walk(root, (e, anc) => { if (e.type === type) out.push({ el: e, anc }); });
  return out;
};
const one = (root, type) => {
  const hits = find(root, type);
  assert.equal(hits.length, 1, `expected exactly one ${type.name}`);
  return hits[0];
};
const base = (over = {}) => ({
  open: true,
  onOpenChange: () => {},
  title: 'Delete it?',
  onConfirm: () => {},
  ...over,
});
const render = (over) => ConfirmDialog(base(over));
const text = (el) => [el.props.children].flat(Infinity).join('');
// Cancel = the Button inside a DialogClose; confirm = the Button outside any.
const cancelBtn = (root) => find(root, Button).find((h) => h.anc.some((a) => a.type === D.DialogClose));
const confirmBtn = (root) => find(root, Button).find((h) => !h.anc.some((a) => a.type === D.DialogClose));

// ---- tests --------------------------------------------------------------------
test('root Dialog receives open and onOpenChange verbatim', () => {
  const onOpenChange = () => {};
  for (const open of [true, false]) {
    const root = render({ open, onOpenChange });
    assert.equal(root.type, D.Dialog);
    assert.equal(root.props.open, open);
    assert.equal(root.props.onOpenChange, onOpenChange);
  }
});

test('DialogContent hides the built-in close button (showCloseButton === false)', () => {
  const { el } = one(render(), D.DialogContent);
  assert.equal(el.props.showCloseButton, false);
});

test('title renders inside DialogTitle', () => {
  const { el } = one(render({ title: 'Remove host?' }), D.DialogTitle);
  assert.equal(el.props.children, 'Remove host?');
});

test('description (string and node) renders inside DialogDescription', () => {
  const s = one(render({ description: 'This cannot be undone.' }), D.DialogDescription).el;
  assert.equal(s.props.children, 'This cannot be undone.');
  const node = React.createElement('b', null, 'rich');
  const n = one(render({ description: node }), D.DialogDescription).el;
  assert.equal(n.props.children, node);
});

test('no DialogDescription for omitted, empty-string or null description', () => {
  for (const description of [undefined, '', null]) {
    assert.equal(find(render({ description }), D.DialogDescription).length, 0, String(description));
  }
});

test('exactly two buttons: Cancel inside one DialogClose asChild (outline), confirm outside it', () => {
  const root = render();
  assert.equal(find(root, Button).length, 2);
  const closes = find(root, D.DialogClose);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].el.props.asChild, true);
  const cancel = cancelBtn(root);
  const confirm = confirmBtn(root);
  assert.ok(cancel && confirm);
  assert.notEqual(cancel.el, confirm.el);
  assert.equal(cancel.el.props.variant, 'outline');
  assert.equal(cancel.anc.filter((a) => a.type === D.DialogClose).length, 1);
  assert.equal(confirm.anc.filter((a) => a.type === D.DialogClose).length, 0);
});

test('Cancel has no onClick — dismissal is routed only through Radix onOpenChange', () => {
  assert.equal(cancelBtn(render()).el.props.onClick, undefined);
});

test('confirm onClick is onConfirm itself and never calls onOpenChange', () => {
  const calls = [];
  const onConfirm = () => calls.push('confirm');
  const onOpenChange = (v) => calls.push(['open', v]);
  const { el } = confirmBtn(render({ onConfirm, onOpenChange }));
  assert.equal(el.props.onClick, onConfirm);
  el.props.onClick();
  assert.deepEqual(calls, ['confirm']);
});

test('Cancel precedes confirm in tree order (Radix autofocuses the first focusable)', () => {
  const root = render();
  const btns = find(root, Button);
  assert.ok(btns[0].anc.some((a) => a.type === D.DialogClose), 'first button is Cancel');
  assert.ok(!btns[1].anc.some((a) => a.type === D.DialogClose), 'second button is confirm');
});

test('default labels are Confirm and Cancel', () => {
  const root = render();
  assert.equal(text(confirmBtn(root).el), 'Confirm');
  assert.equal(text(cancelBtn(root).el), 'Cancel');
});

test('custom confirmLabel / cancelLabel land on the correct buttons', () => {
  const root = render({ confirmLabel: 'Delete', cancelLabel: 'Keep' });
  assert.equal(text(confirmBtn(root).el), 'Delete');
  assert.equal(text(cancelBtn(root).el), 'Keep');
});

test('confirm variant is default unless destructive; Cancel stays outline', () => {
  for (const [destructive, want] of [[undefined, 'default'], [false, 'default'], [true, 'destructive']]) {
    const root = render({ destructive });
    assert.equal(confirmBtn(root).el.props.variant, want, `destructive=${destructive}`);
    assert.equal(cancelBtn(root).el.props.variant, 'outline');
  }
});
