// Tests for the DropdownMenu wrapper (web/src/components/ui/dropdown-menu.tsx) — the
// app's menu-semantics primitive (WARDEN-1028) behind FileViewer's overflow menu.
//
// Documented contract: every part stamps its own `data-slot` and forwards props to the
// Radix primitive; Content portals and defaults `sideOffset` to 4; Item defaults
// `variant` to "default" (mirrored on `data-variant`, never leaked to the primitive);
// CheckboxItem renders a check-mark slot (`pl-8`) by default and none (`pl-2`) with
// `indicator={false}`, forwarding `checked` and never leaking `indicator`.
//
// HARNESS (seam-first, like iconTooltip.test.mjs): the REAL dropdown-menu.tsx is
// transpiled with vite's transformWithOxc into a tmp dir under web/; `radix-ui`,
// `lucide-react` and `@/lib/utils` are rewritten onto test-local stubs (asserted: no
// `@/` specifier survives). Each part is called directly and the returned element
// tree inspected.
//
// Run: node --test dropdownMenu.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-dropdownmenu-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const srcPath = resolve(__dirname, 'src/components/ui/dropdown-menu.tsx');
const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
let rewritten = code;
for (const q of ["'", '"']) {
  rewritten = rewritten
    .replaceAll(`${q}radix-ui${q}`, `'./radix.mjs'`)
    .replaceAll(`${q}lucide-react${q}`, `'./lucide.mjs'`)
    .replaceAll(`${q}@/lib/utils${q}`, `'./utils.mjs'`);
}
assert.doesNotMatch(rewritten, /['"]@\//, 'an @/ specifier survived the rewrite');
writeFileSync(join(tmpDir, 'dropdown-menu.mjs'), rewritten);
writeFileSync(
  join(tmpDir, 'radix.mjs'),
  `const mk = (n) => { const f = (p) => null; Object.defineProperty(f, 'name', { value: n }); return f; };
export const DropdownMenu = Object.fromEntries(
  ['Root', 'Trigger', 'Portal', 'Content', 'Item', 'CheckboxItem', 'ItemIndicator', 'Separator', 'Label', 'Group']
    .map((n) => [n, mk(n)]),
);\n`,
);
writeFileSync(
  join(tmpDir, 'lucide.mjs'),
  `export const CheckIcon = function CheckIcon(p) { return null; };\n`,
);
writeFileSync(
  join(tmpDir, 'utils.mjs'),
  `export const cn = (...a) => a.filter(Boolean).join(' ');\n`,
);

const M = await import(join(tmpDir, 'dropdown-menu.mjs'));
const { DropdownMenu: P } = await import(join(tmpDir, 'radix.mjs'));
const { CheckIcon } = await import(join(tmpDir, 'lucide.mjs'));

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
const kids = (el) => React.Children.toArray(el.props.children);
const classes = (el) => el.props.className.split(/\s+/);

test('module exports exactly the nine menu parts', () => {
  assert.deepEqual(Object.keys(M).sort(), [
    'DropdownMenu',
    'DropdownMenuCheckboxItem',
    'DropdownMenuContent',
    'DropdownMenuGroup',
    'DropdownMenuItem',
    'DropdownMenuLabel',
    'DropdownMenuPortal',
    'DropdownMenuSeparator',
    'DropdownMenuTrigger',
  ]);
});

test('pass-through parts render their primitive, stamp data-slot and forward props', () => {
  const cases = [
    [M.DropdownMenu, P.Root, 'dropdown-menu'],
    [M.DropdownMenuTrigger, P.Trigger, 'dropdown-menu-trigger'],
    [M.DropdownMenuPortal, P.Portal, 'dropdown-menu-portal'],
    [M.DropdownMenuGroup, P.Group, 'dropdown-menu-group'],
  ];
  for (const [part, prim, slot] of cases) {
    const el = part({ id: 'x', 'aria-label': 'lbl' });
    assert.equal(el.type, prim, slot);
    assert.equal(el.props['data-slot'], slot);
    assert.equal(el.props.id, 'x');
    assert.equal(el.props['aria-label'], 'lbl');
  }
});

test('Content is wrapped in exactly one Portal around the primitive Content', () => {
  const root = M.DropdownMenuContent({});
  assert.equal(root.type, P.Portal);
  const content = kids(root);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, P.Content);
  assert.equal(content[0].props['data-slot'], 'dropdown-menu-content');
});

test('Content sideOffset defaults to 4; an explicit value (including 0) wins', () => {
  const offset = (props) => kids(M.DropdownMenuContent(props))[0].props.sideOffset;
  assert.equal(offset({}), 4);
  assert.equal(offset({ sideOffset: 12 }), 12);
  assert.strictEqual(offset({ sideOffset: 0 }), 0);
});

test('Content merges className after the base classes and passes props through', () => {
  const c = kids(M.DropdownMenuContent({ className: 'custom-x', align: 'end', id: 'm' }))[0];
  const cls = classes(c);
  assert.ok(cls.includes('bg-popover'));
  assert.ok(cls.includes('min-w-[8rem]'));
  assert.ok(cls.includes('z-50'));
  assert.equal(cls[cls.length - 1], 'custom-x');
  assert.equal(c.props.align, 'end');
  assert.equal(c.props.id, 'm');
});

test('Item variant defaults to "default" and is mirrored on data-variant', () => {
  const el = M.DropdownMenuItem({});
  assert.equal(el.type, P.Item);
  assert.equal(el.props['data-slot'], 'dropdown-menu-item');
  assert.equal(el.props['data-variant'], 'default');
});

test('Item "destructive" is mirrored on data-variant; variant never leaks to the primitive', () => {
  const el = M.DropdownMenuItem({ variant: 'destructive' });
  assert.equal(el.props['data-variant'], 'destructive');
  for (const v of [undefined, 'destructive']) {
    assert.ok(!('variant' in M.DropdownMenuItem({ variant: v }).props));
  }
});

test('Item merges className after base classes and forwards props and children', () => {
  const el = M.DropdownMenuItem({ className: 'extra', disabled: true, children: 'Reload' });
  const cls = classes(el);
  assert.ok(cls.includes('select-none'));
  assert.equal(cls[cls.length - 1], 'extra');
  assert.strictEqual(el.props.disabled, true);
  assert.equal(el.props.children, 'Reload');
});

test('CheckboxItem defaults to the indicator: pl-8 plus one ItemIndicator>CheckIcon slot before children', () => {
  const el = M.DropdownMenuCheckboxItem({ children: 'Follow' });
  assert.equal(el.type, P.CheckboxItem);
  assert.equal(el.props['data-slot'], 'dropdown-menu-checkbox-item');
  const cls = classes(el);
  assert.ok(cls.includes('pl-8'));
  assert.ok(!cls.includes('pl-2'));
  const children = kids(el);
  assert.equal(children.length, 2);
  assert.equal(children[0].type, 'span');
  assert.equal(find(el, P.ItemIndicator).length, 1);
  assert.equal(find(find(el, P.ItemIndicator)[0], CheckIcon).length, 1);
  assert.equal(children[1], 'Follow');
});

test('CheckboxItem indicator={true} matches the default', () => {
  const el = M.DropdownMenuCheckboxItem({ indicator: true, children: 'Follow' });
  assert.ok(classes(el).includes('pl-8'));
  assert.equal(find(el, P.ItemIndicator).length, 1);
});

test('CheckboxItem indicator={false}: pl-2, no slot, children still rendered', () => {
  const el = M.DropdownMenuCheckboxItem({ indicator: false, children: 'Follow' });
  const cls = classes(el);
  assert.ok(cls.includes('pl-2'));
  assert.ok(!cls.includes('pl-8'));
  assert.equal(find(el, P.ItemIndicator).length, 0);
  assert.equal(find(el, CheckIcon).length, 0);
  assert.equal(find(el, 'span').length, 0);
  assert.deepEqual(kids(el), ['Follow']);
});

test('CheckboxItem forwards checked (true and false) and does not leak indicator', () => {
  for (const checked of [true, false]) {
    const el = M.DropdownMenuCheckboxItem({ checked, children: 'x' });
    assert.strictEqual(el.props.checked, checked);
  }
  for (const indicator of [true, false]) {
    const el = M.DropdownMenuCheckboxItem({ indicator, checked: true, onCheckedChange: () => {} });
    assert.ok(!('indicator' in el.props));
    assert.equal(typeof el.props.onCheckedChange, 'function');
  }
});

test('CheckboxItem merges className after the indicator padding class', () => {
  const cls = classes(M.DropdownMenuCheckboxItem({ className: 'extra' }));
  assert.equal(cls[cls.length - 1], 'extra');
  assert.ok(cls.indexOf('pl-8') < cls.indexOf('extra'));
});

test('Separator and Label stamp data-slot, merge className and forward props', () => {
  const sep = M.DropdownMenuSeparator({ className: 'sep-x', id: 's' });
  assert.equal(sep.type, P.Separator);
  assert.equal(sep.props['data-slot'], 'dropdown-menu-separator');
  assert.ok(classes(sep).includes('bg-border'));
  assert.equal(classes(sep).at(-1), 'sep-x');
  assert.equal(sep.props.id, 's');

  const lab = M.DropdownMenuLabel({ className: 'lab-x', id: 'l', children: 'Section' });
  assert.equal(lab.type, P.Label);
  assert.equal(lab.props['data-slot'], 'dropdown-menu-label');
  assert.ok(classes(lab).includes('text-muted-foreground'));
  assert.equal(classes(lab).at(-1), 'lab-x');
  assert.equal(lab.props.id, 'l');
  assert.equal(lab.props.children, 'Section');
});
