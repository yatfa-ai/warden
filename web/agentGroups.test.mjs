// Tests for renderAgentGroups (web/src/components/fleet-health/AgentGroups.tsx) — the
// Fleet Health grouped agent catalog (Health / Project / Host chains) moved verbatim out
// of HealthDashboard.tsx by WARDEN-1962. Before this file only source-regex guards
// (healthSectionHeaderContextMenu / hostHeaderContextMenu / projectHeaderContextMenu
// tests) touched it; nothing executed it.
//
// No DOM test runner in this repo, so (like agentRow.test.mjs) this loads the REAL
// AgentGroups.tsx plus its pure lib deps (healthUtils, companionStatusText, selection,
// chatDisplay) via Vite's OXC transform into a tmp dir under web/ (so `react` resolves
// from web/node_modules), rewrites the `@/...` specifiers to relative paths, and stubs
// ONLY the leaf UI (StatusDot, CompanionIndicator, Button, Checkbox, ContextMenu*,
// copyWithToast, lucide Trash2). Handlers are read off the returned React element tree
// and invoked directly; renderToStaticMarkup is used for markup assertions.
//
// Run: node --test agentGroups.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-agentgroups-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const REAL = {
  '@/lib/healthUtils': 'src/lib/healthUtils.ts',
  '@/lib/companionStatusText': 'src/lib/companionStatusText.ts',
  '@/lib/selection': 'src/lib/selection.ts',
  '@/lib/chatDisplay': 'src/lib/chatDisplay.ts',
};
const STUBS = {
  '@/components/StatusDot': 'statusDot.mjs',
  '../CompanionIndicator': 'companionIndicator.mjs',
  '@/components/ui/button': 'button.mjs',
  '@/components/ui/checkbox': 'checkbox.mjs',
  '@/components/ui/context-menu': 'contextMenu.mjs',
  '@/lib/clipboardToast': 'clipboardToast.mjs',
  'lucide-react': 'lucide.mjs',
};
const outName = (p) => p.split('/').pop().replace(/\.tsx?$/, '.mjs');
const rewrite = (code) => {
  let out = code;
  for (const [spec, p] of Object.entries(REAL)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${outName(p)}'`);
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  return out;
};
async function load(srcRel, name) {
  const p = resolve(__dirname, srcRel);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  writeFileSync(join(tmpDir, name), rewrite(code));
}
for (const p of Object.values(REAL)) await load(p, outName(p));
await load('src/components/fleet-health/AgentGroups.tsx', 'AgentGroups.mjs');

writeFileSync(join(tmpDir, 'statusDot.mjs'), `import { createElement as h } from 'react';
export function StatusDot(p) { return h('i', { 'data-dot': '1', 'data-tone': p.tone, 'data-variant': p.variant, 'data-label': p.label, 'data-title': p.title }); }\n`);
writeFileSync(join(tmpDir, 'companionIndicator.mjs'), `import { createElement as h } from 'react';
export function CompanionIndicator(p) { return h('i', { 'data-companion': p.companion ? p.companion.state : 'none' }); }\n`);
writeFileSync(join(tmpDir, 'button.mjs'), `import { createElement as h } from 'react';
export function Button(p) { return h('button', { 'aria-label': p['aria-label'], 'aria-expanded': p['aria-expanded'], title: p.title, 'data-size': p.size }, p.children); }\n`);
writeFileSync(join(tmpDir, 'checkbox.mjs'), `import { createElement as h } from 'react';
export function Checkbox(p) { return h('input', { type: 'checkbox', readOnly: true, checked: !!p.checked, disabled: !!p.disabled, 'aria-label': p['aria-label'] }); }\n`);
writeFileSync(join(tmpDir, 'contextMenu.mjs'), `import { createElement as h } from 'react';
export function ContextMenu(p) { return h('div', { 'data-cm': '1' }, p.children); }
export function ContextMenuTrigger(p) { return p.children; }
export function ContextMenuContent(p) { return h('menu', null, p.children); }
export function ContextMenuItem(p) { return h('button', { 'data-item': '1' }, p.children); }
export function ContextMenuSeparator() { return h('hr'); }\n`);
writeFileSync(join(tmpDir, 'clipboardToast.mjs'), `export const copied = [];
export function copyWithToast(t) { copied.push(t); }\n`);
writeFileSync(join(tmpDir, 'lucide.mjs'), `import { createElement as h } from 'react';
export function Trash2() { return h('i', { 'data-trash': '1' }); }\n`);

const M = await import(join(tmpDir, 'AgentGroups.mjs'));
const { renderAgentGroups, byRecencyDesc, CLOSED_COLLAPSED_LIMIT, CLOSED_EXPANDED_LIMIT, HEALTH_SECTION_ORDER } = M;
const { copied } = await import(join(tmpDir, 'clipboardToast.mjs'));
const { Button } = await import(join(tmpDir, 'button.mjs'));
const { Checkbox } = await import(join(tmpDir, 'checkbox.mjs'));
const { ContextMenuItem } = await import(join(tmpDir, 'contextMenu.mjs'));
const { Trash2 } = await import(join(tmpDir, 'lucide.mjs'));
const { StatusDot } = await import(join(tmpDir, 'statusDot.mjs'));
const { THIS_MACHINE } = await import(join(tmpDir, 'chatDisplay.mjs'));

// ---- helpers ----------------------------------------------------------------
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
const find = (root, pred) => { const out = []; walk(root, (e) => pred(e) && out.push(e)); return out; };
const html = (root) => renderToStaticMarkup(React.createElement(React.Fragment, null, root));
const text = (e) => renderToStaticMarkup(e).replace(/<[^>]*>/g, '');
const checkboxes = (root) => find(root, (e) => e.type === Checkbox);
const checkboxByLabel = (root, label) => checkboxes(root).find((e) => e.props['aria-label'] === label);
const buttons = (root) => find(root, (e) => e.type === Button);
const items = (root) => find(root, (e) => e.type === ContextMenuItem);
const itemByLabel = (root, label) => items(root).find((e) => e.props.children === label);
const toggleBtn = (root) => find(root, (e) => e.type === 'button' && e.props.type === 'button' && 'aria-expanded' in e.props);
const dots = (root) => find(root, (e) => e.type === StatusDot);
const renderedIdsOf = (root) => find(root, (e) => e.type === 'i' && e.props['data-agent']).map((e) => e.props['data-agent']);

const ag = (id, over = {}) => ({ id, key: `k-${id}`, name: `Agent ${id}`, host: 'host-a', project: 'proj', healthState: 'healthy', ...over });
const emptyGroups = () => ({ healthy: [], warning: [], critical: [], idle: [], closed: [], unknown: [] });

function makeCtx(over = {}) {
  const calls = { toggleGroup: [], setClosed: [], setCollapsed: [], removeCompanion: [], agents: [] };
  const ctx = {
    groupBy: 'health',
    healthData: { groups: emptyGroups() },
    closedExpanded: false,
    setClosedExpanded: (v) => calls.setClosed.push(v),
    selectedIds: new Set(),
    toggleGroup: (ids) => calls.toggleGroup.push(ids),
    renderAgent: (agent, showHost) => {
      calls.agents.push([agent.id, showHost]);
      return React.createElement('i', { key: agent.id, 'data-agent': agent.id, 'data-showhost': String(showHost) });
    },
    projectGroups: [],
    hostGroups: [],
    hostStatuses: {},
    hostLabels: {},
    collapsedHosts: {},
    setCollapsedHosts: (v) => calls.setCollapsed.push(v),
    companionTransportEnabled: false,
    setRemoveCompanionHost: (h) => calls.removeCompanion.push(h),
    ...over,
  };
  return { ctx, calls };
}
const render = (over) => { const { ctx, calls } = makeCtx(over); return { root: renderAgentGroups(ctx), calls, ctx }; };
const closedAgents = (n, base = 1000) => Array.from({ length: n }, (_, i) => ag(`c${i}`, { lastActivity: base + i }));
const closedCtx = (n, over = {}) => {
  const groups = { ...emptyGroups(), closed: closedAgents(n) };
  return { healthData: { groups }, ...over };
};
const hostGroup = (host, agents, counts = { healthy: agents.length }) => ({ host, agents, counts: { healthy: 0, warning: 0, critical: 0, idle: 0, closed: 0, unknown: 0, ...counts } });
const projGroup = (project, agents, counts = { healthy: agents.length }) => ({ project, agents, counts: { healthy: 0, warning: 0, critical: 0, idle: 0, closed: 0, unknown: 0, ...counts } });

// ---- tests ------------------------------------------------------------------
test('exports the Closed caps (5 collapsed / 20 expanded) and the canonical section order', () => {
  assert.equal(CLOSED_COLLAPSED_LIMIT, 5);
  assert.equal(CLOSED_EXPANDED_LIMIT, 20);
  assert.deepEqual([...HEALTH_SECTION_ORDER], ['healthy', 'warning', 'critical', 'idle', 'closed', 'unknown']);
});

test('byRecencyDesc orders newest lastActivity first, sinks missing, treats 0 as a real value', () => {
  const sorted = [ag('a', { lastActivity: 5 }), ag('none'), ag('b', { lastActivity: 50 }), ag('zero', { lastActivity: 0 })].sort(byRecencyDesc);
  assert.deepEqual(sorted.map((a) => a.id), ['b', 'a', 'zero', 'none']);
  assert.ok(byRecencyDesc(ag('x', { lastActivity: 2 }), ag('y', { lastActivity: 1 })) < 0);
  assert.ok(byRecencyDesc(ag('x', { lastActivity: 1 }), ag('y', { lastActivity: 2 })) > 0);
  assert.equal(byRecencyDesc(ag('x', { lastActivity: 3 }), ag('y', { lastActivity: 3 })), 0);
});

test('health mode skips empty sections and renders the rest in canonical order with showHost=true', () => {
  const groups = { ...emptyGroups(), unknown: [ag('u1')], healthy: [ag('h1')], idle: [ag('i1')] };
  const { root, calls } = render({ healthData: { groups } });
  assert.deepEqual(root.map((e) => e.key), ['healthy', 'idle', 'unknown']);
  assert.deepEqual(calls.agents, [['h1', true], ['i1', true], ['u1', true]]);
  const out = html(root);
  assert.match(out, /● Healthy Agents \(1\)/);
  assert.match(out, /○ Idle Sessions \(1\)/);
  assert.match(out, /· Unknown Status \(1\)/);
  assert.doesNotMatch(out, /Warning Agents|Critical Agents|Closed Sessions/);
});

test('health mode with no agents anywhere renders nothing', () => {
  assert.deepEqual(render({}).root, []);
});

test('non-closed sections are neither capped nor re-sorted', () => {
  const many = Array.from({ length: 30 }, (_, i) => ag(`h${i}`, { lastActivity: i }));
  const { root } = render({ healthData: { groups: { ...emptyGroups(), healthy: many } } });
  assert.deepEqual(renderedIdsOf(root), many.map((a) => a.id));
  assert.equal(toggleBtn(root).length, 0);
});

test('Closed collapsed shows the top 5 by recency, newest first, and the header carries the true total', () => {
  const { root } = render(closedCtx(12));
  assert.deepEqual(renderedIdsOf(root), ['c11', 'c10', 'c9', 'c8', 'c7']);
  assert.match(html(root), /Closed Sessions \(12\)/);
});

test('Closed at or below the collapsed cap shows everything and offers no toggle', () => {
  const at = render(closedCtx(5));
  assert.equal(renderedIdsOf(at.root).length, 5);
  assert.equal(toggleBtn(at.root).length, 0);
  const over = render(closedCtx(6));
  assert.equal(toggleBtn(over.root).length, 1);
});

test('Closed toggle label carries the total; click flips closedExpanded', () => {
  let r = render(closedCtx(8));
  const [btn] = toggleBtn(r.root);
  assert.equal(btn.props['aria-expanded'], false);
  assert.equal(text(btn), 'show more (8 total)');
  btn.props.onClick();
  assert.deepEqual(r.calls.setClosed, [true]);

  r = render(closedCtx(8, { closedExpanded: true }));
  const [open] = toggleBtn(r.root);
  assert.equal(open.props['aria-expanded'], true);
  assert.equal(text(open), 'show less');
  open.props.onClick();
  assert.deepEqual(r.calls.setClosed, [false]);
});

test('Closed expanded shows up to 20 by recency; under the cap there is no "…and M more" note', () => {
  const r = render(closedCtx(15, { closedExpanded: true }));
  assert.equal(renderedIdsOf(r.root).length, 15);
  assert.deepEqual(renderedIdsOf(r.root).slice(0, 2), ['c14', 'c13']);
  assert.doesNotMatch(html(r.root), /more \(showing/);
  const exact = render(closedCtx(20, { closedExpanded: true }));
  assert.doesNotMatch(html(exact.root), /more \(showing/);
});

test('Closed expanded over the 20 cap surfaces "…and M more (showing 20 of N)"', () => {
  const r = render(closedCtx(27, { closedExpanded: true }));
  assert.equal(renderedIdsOf(r.root).length, 20);
  assert.deepEqual(renderedIdsOf(r.root).slice(0, 2), ['c26', 'c25']);
  assert.match(html(r.root), /…and 7 more \(showing 20 of 27\)/);
});

test('Closed collapsed over the cap shows only the toggle, never the "…and M more" note', () => {
  const r = render(closedCtx(27));
  assert.doesNotMatch(html(r.root), /more \(showing/);
  assert.equal(text(toggleBtn(r.root)[0]), 'show more (27 total)');
});

test('Closed sorting does not mutate the input array', () => {
  const closed = closedAgents(8);
  const before = closed.map((a) => a.id);
  render({ healthData: { groups: { ...emptyGroups(), closed } } });
  assert.deepEqual(closed.map((a) => a.id), before);
});

test('Closed agents with no lastActivity sink below dated ones', () => {
  const closed = [ag('nodate1'), ag('dated', { lastActivity: 1 }), ag('nodate2')];
  const r = render({ healthData: { groups: { ...emptyGroups(), closed } } });
  assert.equal(renderedIdsOf(r.root)[0], 'dated');
});

test('select-all targets the RENDERED ids only (key||id), not agents hidden behind the Closed cap', () => {
  const closed = closedAgents(8);
  closed[7] = { ...closed[7], key: undefined }; // newest -> falls back to id
  const r = render({ healthData: { groups: { ...emptyGroups(), closed } } });
  const cb = checkboxByLabel(r.root, 'select all closed sessions');
  cb.props.onCheckedChange();
  assert.deepEqual(r.calls.toggleGroup, [['c7', 'k-c6', 'k-c5', 'k-c4', 'k-c3']]);
  itemByLabel(r.root, 'Select all').props.onSelect();
  assert.deepEqual(r.calls.toggleGroup[1], r.calls.toggleGroup[0]);
});

test('select-all checked flips only when every rendered id is selected; menu label follows', () => {
  const groups = { ...emptyGroups(), healthy: [ag('a'), ag('b')] };
  const label = 'select all healthy agents';
  let r = render({ healthData: { groups }, selectedIds: new Set(['k-a']) });
  assert.equal(checkboxByLabel(r.root, label).props.checked, false);
  assert.ok(itemByLabel(r.root, 'Select all'));
  r = render({ healthData: { groups }, selectedIds: new Set(['k-a', 'k-b']) });
  assert.equal(checkboxByLabel(r.root, label).props.checked, true);
  assert.ok(itemByLabel(r.root, 'Deselect all'));
  assert.equal(itemByLabel(r.root, 'Select all'), undefined);
});

test('Closed select-all is not "all selected" by ids hidden behind the cap', () => {
  const closed = closedAgents(8);
  // select only the 5 rendered ones -> checked, even though 3 hidden are not selected
  const rendered = new Set(['k-c7', 'k-c6', 'k-c5', 'k-c4', 'k-c3']);
  const r = render({ healthData: { groups: { ...emptyGroups(), closed } }, selectedIds: rendered });
  assert.equal(checkboxByLabel(r.root, 'select all closed sessions').props.checked, true);
});

test('section header menu copies the section title and the shown agents\' names (name||key||id)', () => {
  copied.length = 0;
  const groups = { ...emptyGroups(), healthy: [ag('a'), ag('b', { name: undefined }), ag('c', { name: undefined, key: undefined })] };
  const r = render({ healthData: { groups } });
  itemByLabel(r.root, 'Copy section name').props.onSelect();
  itemByLabel(r.root, 'Copy agent names').props.onSelect();
  assert.deepEqual(copied, ['Healthy Agents', 'Agent a\nk-b\nc']);
});

test('Closed header copy-names lists only the shown (capped) agents', () => {
  copied.length = 0;
  const r = render(closedCtx(8));
  itemByLabel(r.root, 'Copy agent names').props.onSelect();
  assert.equal(copied[0].split('\n').length, 5);
  assert.equal(copied[0].split('\n')[0], 'Agent c7');
});

// ---- project mode -----------------------------------------------------------
test('project mode with no groups renders the placeholder', () => {
  const r = render({ groupBy: 'project', projectGroups: [] });
  assert.match(html(r.root), /No agents to group\./);
});

test('project mode renders one block per group, rows with showHost=false, count pluralised', () => {
  const groups = [projGroup('alpha', [ag('a1'), ag('a2')], { healthy: 1, critical: 1 }), projGroup('beta', [ag('b1')], { idle: 1 })];
  const r = render({ groupBy: 'project', projectGroups: groups });
  assert.deepEqual(r.root.map((e) => e.key), ['alpha', 'beta']);
  assert.deepEqual(r.calls.agents, [['a1', false], ['a2', false], ['b1', false]]);
  const out = html(r.root);
  assert.match(out, /2 agents/);
  assert.match(out, /1 agent</);
  assert.doesNotMatch(out, /1 agents/);
});

test('project distribution lists only non-zero states in canonical order, lower-cased', () => {
  const groups = [projGroup('alpha', [ag('a1'), ag('a2'), ag('a3')], { unknown: 1, healthy: 2 })];
  const out = html(render({ groupBy: 'project', projectGroups: groups }).root);
  const hIdx = out.indexOf('2 healthy');
  const uIdx = out.indexOf('1 unknown');
  assert.ok(hIdx >= 0 && uIdx > hIdx);
  assert.doesNotMatch(out, /\d (warning|critical|idle|closed)/);
});

test('project select-all targets every agent in the project (key||id) and reflects selection', () => {
  const g = projGroup('alpha', [ag('a1'), ag('a2', { key: undefined })]);
  let r = render({ groupBy: 'project', projectGroups: [g] });
  const cb = checkboxByLabel(r.root, 'select all agents in alpha');
  assert.equal(cb.props.checked, false);
  assert.equal(cb.props.disabled, false);
  cb.props.onCheckedChange();
  itemByLabel(r.root, 'Select all').props.onSelect();
  assert.deepEqual(r.calls.toggleGroup, [['k-a1', 'a2'], ['k-a1', 'a2']]);
  r = render({ groupBy: 'project', projectGroups: [g], selectedIds: new Set(['k-a1', 'a2']) });
  assert.equal(checkboxByLabel(r.root, 'select all agents in alpha').props.checked, true);
  assert.ok(itemByLabel(r.root, 'Deselect all'));
});

test('project header menu copies the project name and the agents\' names', () => {
  copied.length = 0;
  const r = render({ groupBy: 'project', projectGroups: [projGroup('alpha', [ag('a1'), ag('a2', { name: undefined })])] });
  itemByLabel(r.root, 'Copy project name').props.onSelect();
  itemByLabel(r.root, 'Copy agent names').props.onSelect();
  assert.deepEqual(copied, ['alpha', 'Agent a1\nk-a2']);
});

test('project host-span: offline first, per-status dot tone/variant/label/title, latency only in label/title', () => {
  const agents = [ag('1', { host: 'on' }), ag('2', { host: 'on' }), ag('3', { host: 'off' }), ag('4', { host: 'unk' }), ag('5', { host: 'lat0' })];
  const hostStatuses = {
    on: { status: 'online', latency_ms: 12 },
    off: { status: 'offline', latency_ms: null },
    lat0: { status: 'online', latency_ms: null },
  };
  const r = render({ groupBy: 'project', projectGroups: [projGroup('alpha', agents)], hostStatuses, hostLabels: { on: 'Box ON' } });
  const d = dots(r.root).map((e) => e.props);
  assert.deepEqual(d.map((p) => [p.tone, p.variant, p.label, p.title]), [
    ['red', 'square', 'Offline', 'offline'],
    ['green', 'solid', 'Online (12ms)', 'online (12ms)'],
    ['green', 'solid', 'Online', 'online'],
    ['gray', 'ring', 'Unknown connectivity', 'unknown'],
  ]);
  const out = html(r.root);
  assert.match(out, /Box ON/);
  assert.match(out, /\(2\)/);
  // exactly one visible "offline" flag, on the offline host
  assert.equal((out.match(/>offline</g) || []).length, 1);
  // latency never appears in visible text
  assert.doesNotMatch(out, />[^<]*12ms[^<]*</);
});

test('project host-span separators: a dot between spans but not before the first', () => {
  const agents = [ag('1', { host: 'h1' }), ag('2', { host: 'h2' })];
  const out = html(render({ groupBy: 'project', projectGroups: [projGroup('p', agents)] }).root);
  assert.equal((out.match(/text-muted-foreground\/40">·</g) || []).length, 1);
});

// ---- host mode --------------------------------------------------------------
test('host mode with no groups renders the placeholder', () => {
  assert.match(html(render({ groupBy: 'host', hostGroups: [] }).root), /No agents to group\./);
});

test('host mode renders rows with showHost=false and a per-host key', () => {
  const g = [hostGroup('h1', [ag('1'), ag('2')]), hostGroup('h2', [ag('3')])];
  const r = render({ groupBy: 'host', hostGroups: g });
  assert.deepEqual(r.root.map((e) => e.key), ['h1', 'h2']);
  assert.deepEqual(r.calls.agents, [['1', false], ['2', false], ['3', false]]);
});

test('groupBy picks exactly one branch', () => {
  const groups = { ...emptyGroups(), healthy: [ag('hh')] };
  const base = { healthData: { groups }, projectGroups: [projGroup('p', [ag('pp')])], hostGroups: [hostGroup('h', [ag('hs')])] };
  assert.deepEqual(renderedIdsOf(render({ ...base, groupBy: 'health' }).root), ['hh']);
  assert.deepEqual(renderedIdsOf(render({ ...base, groupBy: 'project' }).root), ['pp']);
  assert.deepEqual(renderedIdsOf(render({ ...base, groupBy: 'host' }).root), ['hs']);
});

test('host header: label, aria/title/glyph flip with collapse, rows hidden and select-all disabled when collapsed', () => {
  const g = hostGroup('h1', [ag('1'), ag('2')]);
  let r = render({ groupBy: 'host', hostGroups: [g], hostLabels: { h1: 'Nice Host' } });
  let btn = buttons(r.root).find((b) => b.props.variant === 'ghost' && !b.props.size);
  assert.equal(btn.props['aria-expanded'], true);
  assert.equal(btn.props['aria-label'], 'Nice Host: 2 agents, collapse');
  assert.equal(btn.props.title, 'Collapse host');
  assert.match(html(r.root), /▾/);
  assert.deepEqual(renderedIdsOf(r.root), ['1', '2']);
  const cb = checkboxByLabel(r.root, 'select all agents on Nice Host');
  assert.equal(cb.props.disabled, false);

  r = render({ groupBy: 'host', hostGroups: [g], collapsedHosts: { h1: true } });
  btn = buttons(r.root).find((b) => b.props.variant === 'ghost' && !b.props.size);
  assert.equal(btn.props['aria-expanded'], false);
  assert.equal(btn.props['aria-label'], 'h1: 2 agents, expand');
  assert.equal(btn.props.title, 'Expand host');
  assert.match(html(r.root), /▸/);
  assert.deepEqual(renderedIdsOf(r.root), []);
  const cb2 = checkboxByLabel(r.root, 'select all agents on h1');
  assert.equal(cb2.props.disabled, true);
  assert.equal(cb2.props.checked, false);
  cb2.props.onCheckedChange();
  assert.deepEqual(r.calls.toggleGroup, [[]]);
});

test('host aria-label pluralises: one agent is singular', () => {
  const r = render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1')])] });
  assert.equal(buttons(r.root)[0].props['aria-label'], 'h1: 1 agent, collapse');
});

test('host collapse writes a merged map from both the button and the menu, flipping only that host', () => {
  const g = hostGroup('h1', [ag('1')]);
  let r = render({ groupBy: 'host', hostGroups: [g], collapsedHosts: { other: true } });
  buttons(r.root)[0].props.onClick();
  itemByLabel(r.root, 'Collapse').props.onSelect();
  assert.deepEqual(r.calls.setCollapsed, [{ other: true, h1: true }, { other: true, h1: true }]);

  r = render({ groupBy: 'host', hostGroups: [g], collapsedHosts: { h1: true, other: true } });
  buttons(r.root)[0].props.onClick();
  itemByLabel(r.root, 'Expand').props.onSelect();
  assert.deepEqual(r.calls.setCollapsed, [{ h1: false, other: true }, { h1: false, other: true }]);
});

test('host select-all uses key||id of the group\'s agents; checkbox reflects selection', () => {
  const g = hostGroup('h1', [ag('1'), ag('2', { key: undefined })]);
  let r = render({ groupBy: 'host', hostGroups: [g] });
  checkboxByLabel(r.root, 'select all agents on h1').props.onCheckedChange();
  assert.deepEqual(r.calls.toggleGroup, [['k-1', '2']]);
  r = render({ groupBy: 'host', hostGroups: [g], selectedIds: new Set(['k-1', '2']) });
  assert.equal(checkboxByLabel(r.root, 'select all agents on h1').props.checked, true);
});

test('host connectivity: dot tone/variant/label/title and the status text with latency', () => {
  const mk = (st) => dots(render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1')])], hostStatuses: st ? { h1: st } : {} }).root)[0].props;
  const on = mk({ status: 'online', latency_ms: 40 });
  assert.deepEqual([on.tone, on.variant, on.label, on.title], ['green', 'solid', 'Online (40ms)', 'online (40ms)']);
  const on0 = mk({ status: 'online', latency_ms: 0 });
  assert.deepEqual([on0.label, on0.title], ['Online', 'online']);
  const off = mk({ status: 'offline' });
  assert.deepEqual([off.tone, off.variant, off.label, off.title], ['red', 'square', 'Offline', 'offline']);
  const unk = mk(null);
  assert.deepEqual([unk.tone, unk.variant, unk.label, unk.title], ['gray', 'ring', 'Unknown connectivity', 'unknown']);

  const t = (st) => text(buttons(render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1')])], hostStatuses: st ? { h1: st } : {} }).root)[0]);
  assert.match(t({ status: 'online', latency_ms: 40 }), /online 40ms/);
  assert.doesNotMatch(t({ status: 'offline', latency_ms: 40 }), /40ms/);
  assert.match(t({ status: 'offline' }), /offline/);
  assert.match(t(null), /unknown/);
});

test('host distribution lists non-zero states; load segment gated, rounded and tone-coloured', () => {
  const noLoad = html(render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1')], { healthy: 1 })] }).root);
  assert.match(noLoad, /1 healthy/);
  assert.doesNotMatch(noLoad, /% cpu|% mem|Host load/);

  const agents = [ag('1', { cpuPct: 40.4, memPct: 50 }), ag('2', { cpuPct: 60.6, memPct: 91.6 })];
  const out = html(render({ groupBy: 'host', hostGroups: [hostGroup('h1', agents, { healthy: 2 })] }).root);
  assert.match(out, /51% cpu · 92% mem/);
  assert.match(out, /text-red-500/);
  assert.match(out, /title="Host load: 51% avg CPU · 92% max mem \(across 2 agents\)"/);

  const cpuOnly = html(render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1', { cpuPct: 85 })], { healthy: 1 })] }).root);
  assert.match(cpuOnly, />85% cpu</);
  assert.doesNotMatch(cpuOnly, /% mem/);
  assert.match(cpuOnly, /tabular-nums text-yellow-500/);
  assert.match(cpuOnly, /no mem data \(across 1 agent\)/);

  const memOnly = html(render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1', { memPct: 10 })], { healthy: 1 })] }).root);
  assert.match(memOnly, />10% mem</);
  assert.doesNotMatch(memOnly, /% cpu</);
  assert.match(memOnly, /no CPU data/);
});

test('load segment renders even when every health count is zero', () => {
  const g = hostGroup('h1', [ag('1', { cpuPct: 10 })], {});
  const out = html(render({ groupBy: 'host', hostGroups: [g] }).root);
  assert.match(out, /10% cpu/);
});

test('companion trash is gated on transport enabled AND a non-local host; click removes that host', () => {
  const g = [hostGroup('remote', [ag('1')]), hostGroup(THIS_MACHINE, [ag('2')])];
  const off = render({ groupBy: 'host', hostGroups: g, companionTransportEnabled: false });
  assert.equal(find(off.root, (e) => e.type === Trash2).length, 0);

  const on = render({ groupBy: 'host', hostGroups: g, companionTransportEnabled: true });
  const trashBtns = buttons(on.root).filter((b) => b.props.size === 'icon-xs');
  assert.equal(trashBtns.length, 1);
  assert.equal(trashBtns[0].props['aria-label'], 'Remove companion from remote');
  assert.equal(trashBtns[0].props.title, 'Remove the warden companion binary from remote');
  trashBtns[0].props.onClick();
  assert.deepEqual(on.calls.removeCompanion, ['remote']);
  assert.equal(find(on.root, (e) => e.type === Trash2).length, 1);
});

test('host menu: Copy host name always; SSH address gated on non-local; Remove companion gated on transport + non-local', () => {
  copied.length = 0;
  const remote = render({ groupBy: 'host', hostGroups: [hostGroup('remote', [ag('1')])], companionTransportEnabled: true });
  itemByLabel(remote.root, 'Copy host name').props.onSelect();
  itemByLabel(remote.root, 'Copy SSH address').props.onSelect();
  assert.deepEqual(copied, ['remote', 'ssh remote']);
  const rm = items(remote.root).find((e) => text(e) === 'Remove companion…');
  assert.equal(rm.props.variant, 'destructive');
  rm.props.onSelect();
  assert.deepEqual(remote.calls.removeCompanion, ['remote']);

  const remoteNoTransport = render({ groupBy: 'host', hostGroups: [hostGroup('remote', [ag('1')])], companionTransportEnabled: false });
  assert.ok(itemByLabel(remoteNoTransport.root, 'Copy SSH address'));
  assert.equal(items(remoteNoTransport.root).find((e) => text(e) === 'Remove companion…'), undefined);

  const local = render({ groupBy: 'host', hostGroups: [hostGroup(THIS_MACHINE, [ag('1')])], companionTransportEnabled: true });
  assert.ok(itemByLabel(local.root, 'Copy host name'));
  assert.equal(itemByLabel(local.root, 'Copy SSH address'), undefined);
  assert.equal(items(local.root).find((e) => text(e) === 'Remove companion…'), undefined);
});

test('host menu: Copy companion status only when companionStatusText is non-null, and copies that text', () => {
  copied.length = 0;
  const none = render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1')])], hostStatuses: { h1: { status: 'online' } } });
  assert.equal(itemByLabel(none.root, 'Copy companion status'), undefined);
  const inactive = render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1')])], hostStatuses: { h1: { status: 'online', companion: { state: 'inactive' } } } });
  assert.equal(itemByLabel(inactive.root, 'Copy companion status'), undefined);

  const active = render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1')])], hostStatuses: { h1: { status: 'online', companion: { state: 'active', version: '1.2' } } } });
  itemByLabel(active.root, 'Copy companion status').props.onSelect();
  assert.deepEqual(copied, ['Companion active (v1.2)']);
});

test('host menu copies the raw host (not the display label) for name and ssh address', () => {
  copied.length = 0;
  const r = render({ groupBy: 'host', hostGroups: [hostGroup('raw.example', [ag('1')])], hostLabels: { 'raw.example': 'Pretty' } });
  itemByLabel(r.root, 'Copy host name').props.onSelect();
  itemByLabel(r.root, 'Copy SSH address').props.onSelect();
  assert.deepEqual(copied, ['raw.example', 'ssh raw.example']);
  assert.match(html(r.root), /Pretty/);
});

test('host companion indicator and dot reflect the host\'s status entry', () => {
  const r = render({ groupBy: 'host', hostGroups: [hostGroup('h1', [ag('1')])], hostStatuses: { h1: { status: 'online', companion: { state: 'active' } } } });
  assert.match(html(r.root), /data-companion="active"/);
});

test('host menu Collapse/Expand label follows collapsed state', () => {
  const g = hostGroup('h1', [ag('1')]);
  assert.ok(itemByLabel(render({ groupBy: 'host', hostGroups: [g] }).root, 'Collapse'));
  assert.ok(itemByLabel(render({ groupBy: 'host', hostGroups: [g], collapsedHosts: { h1: true } }).root, 'Expand'));
});
