// Tests for renderAgentRow (web/src/components/fleet-health/AgentRow.tsx) — the
// Fleet Health per-agent row extracted verbatim from HealthDashboard by WARDEN-1942.
//
// No DOM test runner in this repo, so (like agentSparkline.test.mjs) this loads the
// REAL AgentRow.tsx plus its pure lib deps (agentSparkline, activityAria, healthUtils,
// chatDisplay, formatTimestamp) via Vite's OXC transform into a tmp dir under web/
// (so `react/jsx-runtime` resolves from web/node_modules), rewrites the `@/...`
// specifiers to relative paths, and stubs ONLY the leaf UI primitives (Checkbox,
// ContextMenu*, Sparkline, cn, copyWithToast) and StatusChips. The chip stubs echo
// their props as data attributes / record them, so the chip FEEDS are asserted by data.
// Handlers are read off the returned React element tree and invoked directly;
// renderToStaticMarkup is used for markup assertions.
//
// Run: node --test agentRow.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-agentrow-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

// Real modules (transpiled). Keys are the `@/` specifier -> source path.
const REAL = {
  '@/lib/agentSparkline': 'src/lib/agentSparkline.ts',
  '@/lib/activityAria': 'src/lib/activityAria.ts',
  '@/lib/healthUtils': 'src/lib/healthUtils.ts',
  '@/lib/chatDisplay': 'src/lib/chatDisplay.ts',
  '@/lib/formatTimestamp': 'src/lib/formatTimestamp.ts',
};
// Stubbed modules: specifier -> stub filename.
const STUBS = {
  '@/components/Sparkline': 'sparkline.mjs',
  '@/components/ui/checkbox': 'checkbox.mjs',
  '@/components/ui/context-menu': 'contextMenu.mjs',
  '@/lib/clipboardToast': 'clipboardToast.mjs',
  '@/lib/utils': 'utils.mjs',
  './StatusChips': 'statusChips.mjs',
};
const rel = (name) => './' + name;
const rewrite = (code) => {
  let out = code;
  for (const [spec, p] of Object.entries(REAL)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'${rel(p.split('/').pop().replace(/\.tsx?$/, '.mjs'))}'`);
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'${rel(f)}'`);
  return out;
};

async function load(srcRel, outName, srcOverride) {
  const p = resolve(__dirname, srcRel);
  const src = srcOverride ?? readFileSync(p, 'utf8');
  const { code } = await transformWithOxc(src, p, {});
  writeFileSync(join(tmpDir, outName), rewrite(code));
}

for (const p of Object.values(REAL)) await load(p, p.split('/').pop().replace(/\.tsx?$/, '.mjs'));
await load(
  'src/components/fleet-health/AgentRow.tsx',
  'AgentRow.mjs',
  process.env.ROW_SRC ? readFileSync(process.env.ROW_SRC, 'utf8') : undefined,
);

writeFileSync(join(tmpDir, 'utils.mjs'), `export const cn = (...a) => a.filter((x) => typeof x === 'string' && x).join(' ');\n`);
writeFileSync(join(tmpDir, 'sparkline.mjs'), `import { createElement as h } from 'react';
export function Sparkline(p) { return h('i', { 'data-sparkline': '1', 'data-values': JSON.stringify(p.values), 'data-errors': JSON.stringify(p.errors), 'data-aria': p.ariaLabel, className: p.className }); }\n`);
writeFileSync(join(tmpDir, 'checkbox.mjs'), `import { createElement as h } from 'react';
export function Checkbox(p) { return h('input', { type: 'checkbox', readOnly: true, checked: !!p.checked, 'aria-label': p['aria-label'] }); }\n`);
writeFileSync(join(tmpDir, 'contextMenu.mjs'), `import { createElement as h } from 'react';
export function ContextMenu(p) { return h('div', { 'data-cm': '1' }, p.children); }
export function ContextMenuTrigger(p) { return p.children; }
export function ContextMenuContent(p) { return h('menu', null, p.children); }
export function ContextMenuItem(p) { return h('button', { 'data-item': '1' }, p.children); }\n`);
writeFileSync(join(tmpDir, 'clipboardToast.mjs'), `export const copied = [];
export function copyWithToast(t) { copied.push(t); }\n`);
const chip = (n, key) => `export function ${n}(p) { return h('i', { 'data-chip': '${n}', 'data-feed': JSON.stringify(p.${key}) }); }`;
writeFileSync(join(tmpDir, 'statusChips.mjs'), `import { createElement as h } from 'react';
export function HealthDot(p) { return h('i', { 'data-chip': 'HealthDot', 'data-feed': JSON.stringify(p.state) }); }
${chip('ResourceChip', 'agent')}
${chip('TokenChip', 'agent')}
${['WipChip', 'ConflictChip', 'BehindChip', 'UnpushedChip', 'StalledChip', 'StashChip'].map((n) => chip(n, 'status')).join('\n')}
`);

const { renderAgentRow } = await import(join(tmpDir, 'AgentRow.mjs'));
const { copied } = await import(join(tmpDir, 'clipboardToast.mjs'));
const { ContextMenuItem } = await import(join(tmpDir, 'contextMenu.mjs'));
const { Checkbox } = await import(join(tmpDir, 'checkbox.mjs'));

// ---- helpers ----------------------------------------------------------------
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
const find = (root, pred) => { const out = []; walk(root, (e) => pred(e) && out.push(e)); return out; };
const rowOf = (root) => find(root, (e) => e.props.role === 'button')[0];
const wrapperOf = (root) => find(root, (e) => e.type === 'span' && typeof e.props.onClick === 'function')[0];
const checkboxOf = (root) => find(root, (e) => e.type === Checkbox)[0];
const items = (root) => find(root, (e) => e.type === ContextMenuItem);
const itemByLabel = (root, label) => items(root).find((e) => e.props.children === label);
const html = (root) => renderToStaticMarkup(root);

function makeCtx(over = {}) {
  const calls = { open: [], toggle: [] };
  const ctx = {
    selectedIds: new Set(),
    toggleSelect: (id) => calls.toggle.push(id),
    onOpenChat: (id) => calls.open.push(id),
    fleetGit: { statusByKey: {} },
    hostLabels: {},
    timestampFormat: 'relative',
    agentIdOf: (a) => a.id,
    agentActivity: new Map(),
    bucketCount: 0,
    ...over,
  };
  return { ctx, calls };
}
const AGENT = { id: 'id-1', key: 'key-1', name: 'Agent One', host: 'host-a', healthState: 'healthy' };
const render = (agent = AGENT, showHost = true, over = {}) => {
  const { ctx, calls } = makeCtx(over);
  return { root: renderAgentRow(agent, showHost, ctx), calls, ctx };
};
const feeds = (root, name) => {
  const m = [...html(root).matchAll(new RegExp(`data-chip="${name}" data-feed="([^"]*)"`, 'g'))];
  return m.map((x) => JSON.parse(x[1].replaceAll('&quot;', '"')));
};

// ---- tests ------------------------------------------------------------------
test('row is a focusable role=button whose aria-label falls back name -> key -> id', () => {
  const row = (a) => rowOf(render(a).root);
  assert.equal(row(AGENT).props.tabIndex, 0);
  assert.equal(row(AGENT).props['aria-label'], 'open chat Agent One');
  assert.equal(row({ ...AGENT, name: undefined }).props['aria-label'], 'open chat key-1');
  assert.equal(row({ ...AGENT, name: undefined, key: undefined }).props['aria-label'], 'open chat id-1');
});

test('click opens the chat by key, falling back to id', () => {
  let r = render(AGENT);
  rowOf(r.root).props.onClick();
  assert.deepEqual(r.calls.open, ['key-1']);
  r = render({ ...AGENT, key: undefined });
  rowOf(r.root).props.onClick();
  assert.deepEqual(r.calls.open, ['id-1']);
});

test('Enter and Space open the chat and preventDefault; other keys do nothing', () => {
  const r = render(AGENT);
  const row = rowOf(r.root);
  for (const key of ['Enter', ' ']) {
    let prevented = 0;
    row.props.onKeyDown({ key, preventDefault: () => prevented++ });
    assert.equal(prevented, 1, `${JSON.stringify(key)} must preventDefault`);
  }
  assert.deepEqual(r.calls.open, ['key-1', 'key-1']);
  let prevented = 0;
  row.props.onKeyDown({ key: 'a', preventDefault: () => prevented++ });
  row.props.onKeyDown({ key: 'Tab', preventDefault: () => prevented++ });
  assert.equal(prevented, 0);
  assert.equal(r.calls.open.length, 2);
  // fallback to id on keyboard open too
  const r2 = render({ ...AGENT, key: undefined });
  rowOf(r2.root).props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(r2.calls.open, ['id-1']);
});

test('selection wrapper stops click AND keydown propagation so toggling never opens the chat', () => {
  const w = wrapperOf(render().root);
  let click = 0, key = 0;
  w.props.onClick({ stopPropagation: () => click++ });
  w.props.onKeyDown({ stopPropagation: () => key++ });
  assert.equal(click, 1);
  assert.equal(key, 1);
});

test('checkbox is keyed on agentIdOf (not agent.id): checked state, toggle arg, aria-label flip', () => {
  const agentIdOf = (a) => `scoped:${a.id}`;
  let r = render(AGENT, true, { agentIdOf, selectedIds: new Set(['scoped:id-1']) });
  let cb = checkboxOf(r.root);
  assert.equal(cb.props.checked, true);
  assert.equal(cb.props['aria-label'], 'deselect Agent One');
  cb.props.onCheckedChange();
  assert.deepEqual(r.calls.toggle, ['scoped:id-1']);

  // a raw agent.id in the set must NOT count as selected
  r = render(AGENT, true, { agentIdOf, selectedIds: new Set(['id-1']) });
  cb = checkboxOf(r.root);
  assert.equal(cb.props.checked, false);
  assert.equal(cb.props['aria-label'], 'select Agent One');
  // toggling doesn't open the chat
  cb.props.onCheckedChange();
  assert.deepEqual(r.calls.open, []);
});

test('selection checkbox reveal: hover-only by default, always visible once any row or this row is selected', () => {
  const cls = (over) => wrapperOf(render(AGENT, true, over).root).props.className;
  const quiet = cls({});
  assert.match(quiet, /opacity-0/);
  assert.match(quiet, /group-hover:opacity-100/);
  assert.match(quiet, /focus-within:opacity-100/);
  const elsewhere = cls({ selectedIds: new Set(['other']) });
  assert.match(elsewhere, /(^| )opacity-100/);
  assert.doesNotMatch(elsewhere, /opacity-0/);
  const self = cls({ selectedIds: new Set(['id-1']) });
  assert.doesNotMatch(self, /opacity-0/);
  // size > 0, not > 1: a single selected id elsewhere already reveals
  assert.doesNotMatch(cls({ selectedIds: new Set(['x']) }), /opacity-0/);
});

test('health dot is fed the normalized health state (case-insensitive, garbage/missing -> unknown)', () => {
  const dot = (healthState) => feeds(render({ ...AGENT, healthState }).root, 'HealthDot')[0];
  assert.equal(dot('HEALTHY'), 'healthy');
  assert.equal(dot('warning'), 'warning');
  assert.equal(dot(undefined), 'unknown');
  assert.equal(dot('bogus'), 'unknown');
});

test('name span falls back name -> key -> id', () => {
  const name = (a) => html(render(a).root).match(/<span class="truncate flex-1">([^<]*)<\/span>/)[1];
  assert.equal(name(AGENT), 'Agent One');
  assert.equal(name({ ...AGENT, name: '' }), 'key-1');
  assert.equal(name({ ...AGENT, name: '', key: '' }), 'id-1');
});

test('role badge needs BOTH isAgent and a role', () => {
  const badge = (a) => html(render(a).root).includes('text-blue-400');
  assert.equal(badge({ ...AGENT, isAgent: true, role: 'worker' }), true);
  assert.match(html(render({ ...AGENT, isAgent: true, role: 'worker' }).root), /text-blue-400">worker</);
  assert.equal(badge({ ...AGENT, isAgent: true }), false);
  assert.equal(badge({ ...AGENT, role: 'worker' }), false);
  assert.equal(badge({ ...AGENT, isAgent: false, role: 'worker' }), false);
});

test('host tag: gated by showHost and "(local)"; shows the label when set, else the raw host', () => {
  const tag = (a, showHost, hostLabels = {}) => {
    const m = html(render(a, showHost, { hostLabels }).root).match(/<span class="text-\[10px\] text-muted-foreground">([^<]*)<\/span>/);
    return m ? m[1] : null;
  };
  assert.equal(tag(AGENT, true), 'host-a');
  assert.equal(tag(AGENT, true, { 'host-a': 'Build Box' }), 'Build Box');
  assert.equal(tag(AGENT, false), null);
  assert.equal(tag({ ...AGENT, host: '(local)' }, true), null);
  assert.equal(tag({ ...AGENT, host: '(local)' }, true, { '(local)': 'Me' }), null);
});

test('last activity renders only when present, honouring timestampFormat and the "ago" suffix (relative only)', () => {
  const stamp = (a, timestampFormat) => {
    const h = html(render(a, false, { timestampFormat }).root);
    const m = h.match(/<span class="text-\[10px\] text-muted-foreground">([^<]*)<\/span>/);
    return m ? m[1] : null;
  };
  const fiveMin = Date.now() - 5 * 60 * 1000 - 500;
  assert.equal(stamp({ ...AGENT, lastActivity: fiveMin }, 'relative'), '5m ago');
  const abs = stamp({ ...AGENT, lastActivity: fiveMin }, 'absolute');
  assert.ok(abs && !abs.includes('ago'), `absolute mode must not take the suffix, got ${abs}`);
  assert.equal(stamp(AGENT, 'relative'), null);
});

test('sparkline: none without a container; real series when active; zero baseline when idle; none until buckets load', () => {
  const spark = (a, agentActivity, bucketCount) => {
    const h = html(render(a, true, { agentActivity, bucketCount }).root);
    const m = h.match(/<i data-sparkline="1" data-values="([^"]*)" data-errors="([^"]*)" data-aria="([^"]*)" class="([^"]*)"/);
    if (!m) return null;
    const un = (s) => JSON.parse(s.replaceAll('&quot;', '"'));
    return { values: un(m[1]), errors: un(m[2]), aria: m[3], cls: m[4] };
  };
  const act = new Map([['c1', { values: [1, 2, 0], errors: [0, 1, 0], totalSum: 3, errorSum: 1 }]]);
  assert.equal(spark(AGENT, act, 3), null);
  const real = spark({ ...AGENT, container: 'c1' }, act, 3);
  assert.deepEqual(real.values, [1, 2, 0]);
  assert.deepEqual(real.errors, [0, 1, 0]);
  assert.match(real.aria, /3/);
  assert.equal(real.cls, 'w-14 h-4 compact:w-12 compact:h-3.5');
  const idle = spark({ ...AGENT, container: 'idle' }, act, 4);
  assert.deepEqual(idle.values, [0, 0, 0, 0]);
  assert.deepEqual(idle.errors, [0, 0, 0, 0]);
  assert.equal(spark({ ...AGENT, container: 'idle' }, act, 0), null);
});

test('git chips are each fed fleetGit.statusByKey[agentIdOf(agent)]; resource/token chips get the agent', () => {
  const status = { clean: false, ahead: 2 };
  const other = { clean: true };
  const agentIdOf = (a) => `scoped:${a.id}`;
  const { root } = render(AGENT, true, { agentIdOf, fleetGit: { statusByKey: { 'scoped:id-1': status, 'id-1': other } } });
  for (const n of ['WipChip', 'ConflictChip', 'BehindChip', 'UnpushedChip', 'StalledChip', 'StashChip']) {
    assert.deepEqual(feeds(root, n), [status], `${n} must receive the agentIdOf-keyed status`);
  }
  for (const n of ['ResourceChip', 'TokenChip']) {
    assert.deepEqual(feeds(root, n), [AGENT], `${n} must receive the agent`);
  }
  // no status entry -> undefined feed (chips render nothing themselves)
  const none = render(AGENT).root;
  assert.match(html(none), /<i data-chip="WipChip"><\/i>/);
});

test('chips appear in the documented order after the row body', () => {
  const order = [...html(render().root).matchAll(/data-chip="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['HealthDot', 'ResourceChip', 'TokenChip', 'WipChip', 'ConflictChip', 'BehindChip', 'UnpushedChip', 'StalledChip', 'StashChip']);
});

test('context menu: Open / Copy agent name / Copy host (RAW host) / Copy role, with the right targets', () => {
  const a = { ...AGENT, isAgent: true, role: 'worker' };
  const r = render(a, true, { hostLabels: { 'host-a': 'Build Box' } });
  assert.deepEqual(items(r.root).map((e) => e.props.children), ['Open', 'Copy agent name', 'Copy host', 'Copy role']);
  itemByLabel(r.root, 'Open').props.onSelect();
  assert.deepEqual(r.calls.open, ['key-1']);
  copied.length = 0;
  itemByLabel(r.root, 'Copy agent name').props.onSelect();
  itemByLabel(r.root, 'Copy host').props.onSelect();
  itemByLabel(r.root, 'Copy role').props.onSelect();
  assert.deepEqual(copied, ['Agent One', 'host-a', 'worker']);
});

test('context menu: Open falls back to id, name falls back to key/id, Copy role is gated like the badge', () => {
  const r = render({ ...AGENT, key: undefined, name: undefined });
  itemByLabel(r.root, 'Open').props.onSelect();
  assert.deepEqual(r.calls.open, ['id-1']);
  copied.length = 0;
  itemByLabel(r.root, 'Copy agent name').props.onSelect();
  assert.deepEqual(copied, ['id-1']);
  for (const a of [{ ...AGENT, role: 'worker' }, { ...AGENT, isAgent: true }]) {
    assert.equal(itemByLabel(render(a).root, 'Copy role'), undefined);
  }
});

test('context menu is offered regardless of showHost (Copy host is not gated by the row tag)', () => {
  const r = render({ ...AGENT, host: '(local)' }, false);
  copied.length = 0;
  itemByLabel(r.root, 'Copy host').props.onSelect();
  assert.deepEqual(copied, ['(local)']);
});
