// Tests for SavedSessionRow (web/src/components/sidebar/SavedSessionRows.tsx) — the
// rebuilt "Ink · Saved" sidebar row (WARDEN-1422). savedSessionRows.test.mjs slices only
// the pure helpers and editMenu.test.mjs regex-matches the TSX source, so nothing executed
// the decisions the row itself makes: working/stopped classification, who may rename,
// the agent tag, respawn gating, note/saved markers, the metadata line, host gating and
// the right-click menu's labels / copy targets.
//
// No DOM test runner in this repo, so (like sidebarBits.test.mjs) this loads the REAL
// SavedSessionRows.tsx via Vite's OXC transform into a tmp dir under web/ (so react
// resolves from web/node_modules), rewrites the `@/...` and `lucide-react` specifiers onto
// small stubs, and renders with react-dom/server's renderToStaticMarkup (the component
// uses useState, so it cannot be called directly). ContextMenuItem stubs capture their
// props so onSelect handlers can be invoked.
//
// Scope: SSR renders only the FIRST-render state. The interactive edit mode (rename / note
// commit on blur or Enter) is NOT covered here.
//
// Run: node --test savedSessionRow.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-savedsessionrow-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const STUBS = {
  '@/components/ui/input': 'input.mjs',
  '@/components/ui/editable-context-menu': 'editableContextMenu.mjs',
  '@/components/ui/context-menu': 'contextMenu.mjs',
  '@/components/ui/icon-tooltip': 'iconTooltip.mjs',
  '@/components/StatusDot': 'statusDot.mjs',
  '@/components/ui/skeleton': 'skeleton.mjs',
  '@/lib/utils': 'utils.mjs',
  '@/lib/clipboardToast': 'clipboardToast.mjs',
  '@/lib/formatTimestamp': 'formatTimestamp.mjs',
  '@/lib/uiStore': 'uiStore.mjs',
  'lucide-react': 'icons.mjs',
};
const rewrite = (code) => {
  let out = code;
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  return out;
};

const srcPath = resolve(__dirname, 'src/components/sidebar/SavedSessionRows.tsx');
const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
const rewritten = rewrite(code);
assert.equal(/from\s*['"]@\//.test(rewritten), false, 'an @/ specifier survived the rewrite — add a stub for it');
writeFileSync(join(tmpDir, 'SavedSessionRows.mjs'), rewritten);

const w = (name, body) => writeFileSync(join(tmpDir, name), body);
w('input.mjs', `import { createElement as h } from 'react';
export function Input(p) { return h('input', { 'aria-label': p['aria-label'] }); }\n`);
w('editableContextMenu.mjs', `export function EditableContextMenu(p) { return p.children; }\n`);
w('contextMenu.mjs', `import { createElement as h } from 'react';
export const items = [];
export function ContextMenu(p) { return h('div', { 'data-menu': '1' }, p.children); }
export function ContextMenuTrigger(p) { return p.children; }
export function ContextMenuContent(p) { return h('menu', null, p.children); }
export function ContextMenuSeparator() { return h('hr'); }
export function ContextMenuItem(p) { items.push(p); return h('button', { 'data-item': '1', 'data-variant': p.variant }, p.children); }\n`);
w('iconTooltip.mjs', `import { createElement as h } from 'react';
export function IconTooltip(p) { return h('span', { 'data-tip': p.label }, p.children); }\n`);
w('statusDot.mjs', `import { createElement as h } from 'react';
export function StatusDot(p) { return h('i', { 'data-dot': '1', 'data-tone': p.tone, 'data-variant': p.variant, 'data-label': p.label }); }\n`);
w('skeleton.mjs', `import { createElement as h } from 'react';
export function Skeleton() { return h('i'); }\n`);
w('utils.mjs', `export function cn(...a) { return a.flat(Infinity).filter(Boolean).join(' '); }\n`);
w('clipboardToast.mjs', `export const copied = [];
export function copyWithToast(t) { copied.push(t); }\n`);
w('formatTimestamp.mjs', `export function formatTimestamp(at, fmt, opts) { return 'TS[' + at + '|' + fmt + '|' + (opts && opts.withSuffix) + ']'; }
export function formatAbsoluteFull(at) { return 'ABS[' + at + ']'; }\n`);
w('uiStore.mjs', `export const pref = { value: 'relative' };
export function useTimestampFormat() { return pref.value; }\n`);
w('icons.mjs', `import { createElement as h } from 'react';
const mk = (n) => () => h('svg', { 'data-icon': n });
export const Pencil = mk('Pencil'); export const StickyNote = mk('StickyNote');
export const Trash2 = mk('Trash2'); export const RotateCw = mk('RotateCw');\n`);

const { SavedSessionRow } = await import(join(tmpDir, 'SavedSessionRows.mjs'));
const { copied } = await import(join(tmpDir, 'clipboardToast.mjs'));
const { items } = await import(join(tmpDir, 'contextMenu.mjs'));
const { pref } = await import(join(tmpDir, 'uiStore.mjs'));
const { hueOf } = await import(join(tmpDir, 'SavedSessionRows.mjs'));

// ---- helpers ----------------------------------------------------------------
const noop = () => {};
const chat = (over = {}) => ({ id: 'id1', key: 'key1', name: 'Alpha', kind: 'tmux', active: true, ...over });
function render(over = {}, chatOver = {}) {
  items.length = 0;
  const log = [];
  const html = renderToStaticMarkup(React.createElement(SavedSessionRow, {
    chat: chat(chatOver), focused: false,
    onOpen: () => log.push('open'), onDelete: () => log.push('delete'),
    onRename: noop, onSetNote: noop, ...over,
  }));
  return { html, log, items: [...items] };
}
const item = (r, label) => r.items.find((i) => i.children === label);
const has = (html, s) => html.includes(s);
const dot = (html) => /<i data-dot="1" data-tone="([^"]*)" data-variant="([^"]*)" data-label="([^"]*)"/.exec(html);

beforeEach(() => { copied.length = 0; pref.value = 'relative'; });

test('working vs stopped: aria-label, StatusDot tone/variant/label and the `stop` class; active:null is working', () => {
  const live = render({}, { active: true });
  assert.ok(has(live.html, 'aria-label="working session Alpha"'));
  assert.deepEqual(dot(live.html).slice(1), ['green', 'solid', 'working — live tmux session']);
  assert.equal(/class="[^"]*\bstop\b/.test(live.html), false);

  const dead = render({}, { active: false });
  assert.ok(has(dead.html, 'aria-label="stopped session Alpha"'));
  assert.deepEqual(dot(dead.html).slice(1), ['muted', 'ring', 'stopped — nothing running']);
  assert.ok(/class="[^"]*\bstop\b/.test(dead.html));

  for (const active of [null, undefined]) {
    const r = render({}, { active });
    assert.ok(has(r.html, 'aria-label="working session Alpha"'), `active:${active} must read as working`);
    assert.equal(dot(r.html)[1], 'green');
  }
});

test('display name falls back name → key → id', () => {
  assert.ok(has(render({}, { name: 'N' }).html, 'working session N"'));
  assert.ok(has(render({}, { name: '', key: 'K' }).html, 'working session K"'));
  assert.ok(has(render({}, { name: '', key: '', id: 'I' }).html, 'working session I"'));
});

test('aria-current is set only on the focused row, which also carries bg-accent', () => {
  const f = render({ focused: true });
  assert.ok(has(f.html, 'aria-current="true"'));
  assert.ok(/class="[^"]*(^|\s)bg-accent(\s|")/.test(f.html));
  const u = render({ focused: false });
  assert.equal(has(u.html, 'aria-current'), false);
  assert.equal(/(^|[\s"])bg-accent(\s|")/.test(u.html), false);
});

test('rename button only for non-agent tmux chats; kind yatfa / isAgent / other kinds hide it; tooltip is "rename"', () => {
  const ok = render({}, { kind: 'tmux' });
  assert.ok(has(ok.html, 'aria-label="rename session"'));
  assert.ok(has(ok.html, 'data-tip="rename"'));
  assert.ok(has(ok.html, 'data-icon="Pencil"'));
  for (const over of [{ kind: 'yatfa' }, { kind: 'tmux', isAgent: true }, { kind: 'other' }, { kind: undefined }]) {
    const r = render({}, over);
    assert.equal(has(r.html, 'aria-label="rename session"'), false, JSON.stringify(over));
    assert.equal(has(r.html, 'data-icon="Pencil"'), false, JSON.stringify(over));
  }
});

test('`agent` tag shows for kind yatfa or isAgent===true only', () => {
  assert.ok(has(render({}, { kind: 'yatfa' }).html, '>agent</span>'));
  assert.ok(has(render({}, { kind: 'tmux', isAgent: true }).html, '>agent</span>'));
  assert.equal(has(render({}, { kind: 'tmux' }).html, '>agent</span>'), false);
  assert.equal(has(render({}, { kind: 'tmux', isAgent: false }).html, '>agent</span>'), false);
});

test('respawn only on a stopped row that has an onRespawn handler', () => {
  const sel = 'aria-label="respawn session"';
  assert.ok(has(render({ onRespawn: noop }, { active: false }).html, sel));
  assert.ok(has(render({ onRespawn: noop }, { active: false }).html, 'data-icon="RotateCw"'));
  assert.equal(has(render({}, { active: false }).html, sel), false, 'stopped without a handler');
  assert.equal(has(render({ onRespawn: noop }, { active: true }).html, sel), false, 'working with a handler');
  assert.equal(has(render({ onRespawn: noop }, { active: null }).html, sel), false, 'null is working');
});

test('delete is always present; note button label/tooltip flips with a note; header note marker only with a note', () => {
  for (const active of [true, false]) {
    const r = render({}, { active });
    assert.ok(has(r.html, 'aria-label="delete this saved session"'));
    assert.ok(has(r.html, 'data-icon="Trash2"'));
  }
  const none = render({});
  assert.ok(has(none.html, 'aria-label="add note"'));
  assert.ok(has(none.html, 'data-tip="add note"'));
  assert.equal(has(none.html, 'aria-label="edit note"'), false);
  assert.equal(has(none.html, 'italic text-muted-foreground'), false, 'no note line without a note');
  assert.equal((none.html.match(/data-icon="StickyNote"/g) || []).length, 1, 'only the action button icon');

  const noted = render({ note: 'remember me' });
  assert.ok(has(noted.html, 'aria-label="edit note"'));
  assert.ok(has(noted.html, 'data-tip="edit note"'));
  assert.equal(has(noted.html, 'aria-label="add note"'), false);
  assert.ok(has(noted.html, 'title="remember me">remember me</span>'));
  assert.equal((noted.html.match(/data-icon="StickyNote"/g) || []).length, 2, 'header marker + action button');
});

test('"saved" pill only when justSaved', () => {
  assert.ok(has(render({ justSaved: true }).html, '>saved</span>'));
  assert.equal(has(render({ justSaved: false }).html, '>saved</span>'), false);
  assert.equal(has(render({}).html, '>saved</span>'), false);
});

test('metadata: working shows the time only, stopped prefixes "stopped", bare "stopped" without activity', () => {
  const w = render({}, { active: true, lastActivity: 1000 });
  assert.ok(has(w.html, '<span>TS[1000|relative|true]</span>'));
  assert.equal(has(w.html, 'stopped TS'), false);

  const s = render({}, { active: false, lastActivity: 1000 });
  assert.ok(has(s.html, '<span>stopped TS[1000|relative|true]</span>'));

  assert.ok(has(render({}, { active: false }).html, '<span>stopped</span>'));
  const wn = render({}, { active: true });
  assert.equal(has(wn.html, 'TS['), false);
  assert.equal(has(wn.html, 'stopped'), false);
  assert.equal(has(wn.html, '<span>stopped</span>'), false);
});

test('metadata title is the absolute timestamp; withSuffix is passed only for the relative format', () => {
  assert.ok(has(render({}, { lastActivity: 1000 }).html, 'title="ABS[1000]"'));
  assert.equal(has(render({}, {}).html, 'title="ABS['), false);
  pref.value = 'absolute';
  assert.ok(has(render({}, { lastActivity: 1000 }).html, 'TS[1000|absolute|false]'));
});

test('cwd shown with a "·" separator; no cwd → neither; host only when showHost AND hostLabel', () => {
  const c = render({}, { cwd: '/tmp/repo' });
  assert.ok(has(c.html, '>·</span>'));
  assert.ok(has(c.html, '>/tmp/repo</span>'));
  const n = render({}, {});
  assert.equal(has(n.html, '·'), false);

  const both = render({ showHost: true, hostLabel: 'box-7' });
  assert.ok(has(both.html, '>box-7</span>'));
  assert.ok(has(both.html, '>·</span>'));
  assert.equal(has(render({ showHost: false, hostLabel: 'box-7' }).html, 'box-7'), false);
  assert.equal(has(render({ showHost: true }).html, '<span class="shrink-0">'), false);
  assert.equal(has(render({ hostLabel: 'box-7' }).html, 'box-7'), false);
});

test('query highlights the matched substring (case-insensitive); an absent or non-matching query leaves the name plain', () => {
  const h = render({ query: 'LPH' });
  assert.ok(has(h.html, 'A<span class="rounded-[2px] bg-green-500/30 px-px">lph</span>a'));
  assert.equal(has(render({}).html, 'bg-green-500/30'), false);
  assert.equal(has(render({ query: 'zzz' }).html, 'bg-green-500/30'), false);
});

test('identity chip hue is hueOf(display name): stable across ids, different across names', () => {
  const hue = (html) => /hsl\((\d+) 62% 58%\)/.exec(html)[1];
  assert.equal(hue(render({}, { name: 'Alpha', id: 'a' }).html), String(hueOf('Alpha')));
  assert.equal(hue(render({}, { name: 'Alpha', id: 'b' }).html), String(hueOf('Alpha')));
  assert.notEqual(hueOf('Alpha'), hueOf('Beta'));
  assert.equal(hue(render({}, { name: 'Beta' }).html), String(hueOf('Beta')));
  assert.equal(hue(render({}, { name: '', key: 'KeyName' }).html), String(hueOf('KeyName')));
});

test('context menu: Open label per state, copy targets (session||key||id, cwd), cwd item gated, Delete destructive', () => {
  const w = render({}, { active: true, session: 'sess', cwd: '/w' });
  assert.ok(item(w, 'Open — reconnect'));
  assert.equal(item(w, 'Open (recovery)'), undefined);
  const s = render({}, { active: false });
  assert.ok(item(s, 'Open (recovery)'));
  assert.equal(item(s, 'Open — reconnect'), undefined);

  item(w, 'Copy session id').onSelect();
  item(w, 'Copy working directory').onSelect();
  assert.deepEqual(copied, ['sess', '/w']);

  copied.length = 0;
  item(render({}, { session: undefined, key: 'K', id: 'I' }), 'Copy session id').onSelect();
  item(render({}, { session: undefined, key: '', id: 'I' }), 'Copy session id').onSelect();
  assert.deepEqual(copied, ['K', 'I']);

  assert.equal(item(render({}, { cwd: undefined }), 'Copy working directory'), undefined);
  assert.equal(item(render({}, { cwd: '' }), 'Copy working directory'), undefined);

  assert.equal(item(w, 'Delete').variant, 'destructive');
  assert.equal(w.items.filter((i) => i.variant === 'destructive').length, 1);
});

test('context-menu Open and Delete invoke onOpen / onDelete (and only those)', () => {
  const r = render({});
  item(r, 'Open — reconnect').onSelect();
  assert.deepEqual(r.log, ['open']);
  item(r, 'Delete').onSelect();
  assert.deepEqual(r.log, ['open', 'delete']);
  const r2 = render({}, { active: false });
  item(r2, 'Open (recovery)').onSelect();
  assert.deepEqual(r2.log, ['open']);
});

test('row is role=button and keyboard-focusable (tabindex=0)', () => {
  const r = render({});
  assert.ok(has(r.html, 'role="button"'));
  assert.ok(has(r.html, 'tabindex="0"'));
});
