// Tests for IconTooltip (web/src/components/ui/icon-tooltip.tsx) — the shared themed
// tooltip wrapper behind every glyph-only control (App header, ChatSidebar,
// CollectionsSection, ObserverTabs).
//
// Documented contract: an ENABLED control is handed straight to `TooltipTrigger asChild`
// (Radix then puts `aria-describedby` on the real focusable control); a DISABLED control
// is wrapped in `<span className="inline-flex">` because a disabled <button> drops
// pointer events; `side` defaults to "top".
//
// HARNESS (seam-first, like confirmDialog.test.mjs): the REAL icon-tooltip.tsx is
// transpiled with vite's transformWithOxc into a tmp dir under web/; the
// `@/components/ui/tooltip` specifier is rewritten onto test-local stubs (asserted: no
// `@/` specifier survives). IconTooltip(props) is called directly and the returned
// element tree inspected.
//
// Run: node --test iconTooltip.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-icontooltip-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const srcPath = resolve(__dirname, 'src/components/ui/icon-tooltip.tsx');
const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
let rewritten = code;
for (const q of ["'", '"']) {
  rewritten = rewritten.replaceAll(`${q}@/components/ui/tooltip${q}`, `'./tooltip.mjs'`);
}
assert.doesNotMatch(rewritten, /['"]@\//, 'an @/ specifier survived the rewrite');
writeFileSync(join(tmpDir, 'icon-tooltip.mjs'), rewritten);
writeFileSync(
  join(tmpDir, 'tooltip.mjs'),
  `const mk = (n) => { const f = (p) => null; Object.defineProperty(f, 'name', { value: n }); return f; };
export const Tooltip = mk('Tooltip');
export const TooltipTrigger = mk('TooltipTrigger');
export const TooltipContent = mk('TooltipContent');\n`,
);

const { IconTooltip } = await import(join(tmpDir, 'icon-tooltip.mjs'));
const T = await import(join(tmpDir, 'tooltip.mjs'));

// ---- helpers ----------------------------------------------------------------
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
const find = (root, type) => {
  const out = [];
  walk(root, (e) => { if (e.type === type) out.push(e); });
  return out;
};
const one = (root, type) => {
  const hits = find(root, type);
  assert.equal(hits.length, 1, `expected exactly one ${type.name ?? type}`);
  return hits[0];
};
const kids = (el) => React.Children.toArray(el.props.children);
const button = React.createElement('button', { 'aria-label': 'Settings' }, 'x');
const render = (over = {}) => IconTooltip({ label: 'Settings', children: button, ...over });

test('renders a root Tooltip with exactly one Trigger and one Content', () => {
  const root = render();
  assert.equal(root.type, T.Tooltip);
  assert.equal(find(root, T.TooltipTrigger).length, 1);
  assert.equal(find(root, T.TooltipContent).length, 1);
  assert.equal(kids(root).length, 2);
});

test('the trigger uses asChild so Radix props land on the child, not a wrapper button', () => {
  assert.strictEqual(one(render(), T.TooltipTrigger).props.asChild, true);
  assert.strictEqual(one(render({ disabled: true }), T.TooltipTrigger).props.asChild, true);
});

test('enabled (undefined or false) hands children straight to the trigger with no span', () => {
  for (const over of [{}, { disabled: false }, { disabled: undefined }]) {
    const trig = one(render(over), T.TooltipTrigger);
    assert.strictEqual(trig.props.children, button, `children must be the same element for ${JSON.stringify(over)}`);
    assert.equal(find(trig, 'span').length, 0);
  }
});

test('disabled wraps children in exactly one span.inline-flex inside the trigger', () => {
  const trig = one(render({ disabled: true }), T.TooltipTrigger);
  const wrapper = trig.props.children;
  assert.ok(React.isValidElement(wrapper));
  assert.equal(wrapper.type, 'span');
  assert.equal(wrapper.props.className, 'inline-flex');
  assert.strictEqual(wrapper.props.children, button);
  assert.equal(find(trig, 'span').length, 1);
});

test('side defaults to "top" and bottom/left/right are forwarded to the content', () => {
  assert.equal(one(render(), T.TooltipContent).props.side, 'top');
  for (const side of ['top', 'bottom', 'left', 'right']) {
    assert.equal(one(render({ side }), T.TooltipContent).props.side, side);
  }
});

test('label (string or ReactNode) is the TooltipContent body and is not in the trigger', () => {
  const rich = React.createElement('div', null, 'line1', React.createElement('b', null, 'line2'));
  for (const label of ['Open settings', rich]) {
    const root = render({ label });
    assert.strictEqual(one(root, T.TooltipContent).props.children, label);
    const trig = one(root, T.TooltipTrigger);
    if (typeof label === 'string') {
      assert.doesNotMatch(JSON.stringify(trig.props.children), /Open settings/);
    } else {
      assert.equal(find(trig, 'b').length, 0);
    }
  }
  // children are not leaked into the content
  assert.equal(find(one(render(), T.TooltipContent), 'button').length, 0);
});
