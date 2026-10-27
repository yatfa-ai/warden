// Tests for web/src/components/FileBrowserDialog.tsx — the WARDEN-573 read-only
// workspace file browser (context menu added by WARDEN-1268). The PURE tree
// helpers (joinPath / applyToggle) are pinned by fileBrowser.test.mjs; the
// component glue — the /api/git-ls fetch, the loading/error/empty ladder, lazy
// expand + cache, reset-on-close and the select-and-close handoff — had no test
// that loaded it. This pins that glue.
//
// WHY THESE LEGS (each is a user-visible regression if broken):
//   - fetch URL: chatId/dir must be encodeURIComponent'd or a path with `/`, `&`
//     or spaces requests the wrong directory.
//   - open gate / reset-on-close: a closed dialog must not hit the server, and a
//     reopen must show fresh repo contents (stale tree cleared, root refetched).
//   - error gate `!res.ok || data.error`: /api/git-ls reports no-cwd / not-a-repo
//     at HTTP 200 with an `error` field; dropping that half renders a real error
//     as "empty" (the WARDEN-89 false-empty).
//   - lazy expand: the first click of a subdir must request `dir=<joined path>`;
//     collapse must keep the cache (no refetch); a failing subdir must not take
//     its siblings down.
//   - select-and-close: a file click hands the path to the parent THEN closes.
//   - context menu: Expand/Collapse label, Copy file path (full repo-relative)
//     vs Copy filename (basename), file Open.
//   - indent arithmetic (depth*14+8, files +18, message rows +20).
//
// HARNESS (seam-first, like agentRow.test.mjs / useAsyncConfirm.test.mjs): no DOM
// or React runner exists, so the REAL FileBrowserDialog.tsx, fileBrowserTree.ts and
// api.ts (for the real readErrorBody) are transpiled with vite's transformWithOxc
// into a tmp dir under web/. `react` is rewritten onto a test-local
// useState/useEffect/useCallback shim (render-on-set, effects flushed by deps);
// the UI primitives, lucide icons and clipboardToast are stubbed; fetchBounded is
// a pass-through to a controllable fake global fetch. The module-scope DirChildren
// is expanded off the returned element tree. The rewrites are ASSERTED, not
// assumed: react IS installed in web/, so an unrewritten import would load the
// real react, whose hooks throw outside a renderer — a loud failure, never a
// silent pass. Per WARDEN-997 the first legs prove the DRIVER re-renders on
// setState and runs effects by deps before any behavior verdict.
//
// Run: node --test fileBrowserDialog.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-filebrowserdialog-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

// --- shims & stubs -----------------------------------------------------------
writeFileSync(
  join(tmpDir, 'react-shim.mjs'),
  `
import React from 'react';
export const Fragment = React.Fragment;
let current = null;
export const __aim = (inst) => { current = inst; };
const changed = (deps, prev) =>
  prev === undefined || deps === undefined || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
export function useState(initial) {
  const self = current;
  const slot = self.cursor++;
  if (self.states.length <= slot) self.states.push(initial);
  return [self.states[slot], (next) => {
    self.states[slot] = typeof next === 'function' ? next(self.states[slot]) : next;
    self.render();
  }];
}
export function useEffect(fn, deps) {
  const self = current;
  const slot = self.cursor++;
  if (changed(deps, self.effectDeps[slot])) {
    self.effectDeps[slot] = deps;
    self.pendingEffects.push(fn);
  }
}
export function useCallback(fn, deps) {
  const self = current;
  const slot = self.cursor++;
  const prev = self.memo[slot];
  if (prev && !changed(deps, prev.deps)) return prev.fn;
  self.memo[slot] = { fn, deps };
  return fn;
}
`,
);
writeFileSync(
  join(tmpDir, 'ui.mjs'),
  `import { createElement as h } from 'react';
export const Dialog = (p) => (p.open ? h('dialog', { onOpenChange: p.onOpenChange }, p.children) : null);
export const DialogContent = (p) => h('div', null, p.children);
export const DialogHeader = (p) => h('div', null, p.children);
export const DialogTitle = (p) => h('h2', null, p.children);
export const DialogDescription = (p) => h('p', { 'data-desc': '1' }, p.children);
export const ContextMenu = (p) => h('cm', null, p.children);
export const ContextMenuTrigger = (p) => p.children;
export const ContextMenuContent = (p) => h('menu', null, p.children);
export const ContextMenuSeparator = () => null;
export const ContextMenuItem = (p) => h('item', { onSelect: p.onSelect }, p.children);
export const ScrollArea = (p) => h('div', null, p.children);
`,
);
writeFileSync(
  join(tmpDir, 'lucide.mjs'),
  `import { createElement as h } from 'react';
const icon = (n) => () => h('svg', { 'data-icon': n });
export const Loader2Icon = icon('Loader2'), ChevronRightIcon = icon('ChevronRight'),
  ChevronDownIcon = icon('ChevronDown'), FolderIcon = icon('Folder'),
  FolderOpenIcon = icon('FolderOpen'), FileIcon = icon('File');
`,
);
writeFileSync(
  join(tmpDir, 'clipboardToast.mjs'),
  `export const copied = [];\nexport function copyWithToast(t) { copied.push(t); }\n`,
);
// fetchBounded: pass-through to the (fake) global fetch — the real one adds
// timers/retries that are api.ts's own concern. readErrorBody stays REAL.
writeFileSync(
  join(tmpDir, 'api.mjs'),
  `export { readErrorBody } from './api-real.mjs';\nexport const fetchBounded = (url) => globalThis.fetch(url);\n`,
);

const STUBS = {
  react: 'react-shim.mjs',
  '@/components/ui/dialog': 'ui.mjs',
  '@/components/ui/context-menu': 'ui.mjs',
  '@/components/ui/scroll-area': 'ui.mjs',
  'lucide-react': 'lucide.mjs',
  '@/lib/clipboardToast': 'clipboardToast.mjs',
  '@/lib/api': 'api.mjs',
  '@/lib/fileBrowserTree': 'fileBrowserTree.mjs',
};
const rewrite = (code) => {
  let out = code;
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  return out;
};
async function load(srcRel, outName, rewriteIt = true, srcOverride) {
  const p = resolve(__dirname, srcRel);
  const { code } = await transformWithOxc(srcOverride ?? readFileSync(p, 'utf8'), p, {});
  writeFileSync(join(tmpDir, outName), rewriteIt ? rewrite(code) : code);
}
await load('src/lib/fileBrowserTree.ts', 'fileBrowserTree.mjs');
await load('src/lib/api.ts', 'api-real.mjs', false);
await load(
  'src/components/FileBrowserDialog.tsx',
  'FileBrowserDialog.mjs',
  true,
  process.env.COMPONENT_SRC ? readFileSync(process.env.COMPONENT_SRC, 'utf8') : undefined,
);
const loaded = readFileSync(join(tmpDir, 'FileBrowserDialog.mjs'), 'utf8');
assert.ok(loaded.includes("'./react-shim.mjs'"), 'the react specifier rewrite must land');
assert.ok(!/from ["']@\//.test(loaded), 'no @/ specifier may survive the rewrite');

const { FileBrowserDialog } = await import(join(tmpDir, 'FileBrowserDialog.mjs'));
const { __aim: aim } = await import(join(tmpDir, 'react-shim.mjs'));
const { copied } = await import(join(tmpDir, 'clipboardToast.mjs'));
const { ContextMenuItem } = await import(join(tmpDir, 'ui.mjs'));

// --- driver ------------------------------------------------------------------
// Expand function components (incl. module-scope DirChildren, never exported) into
// a plain tree: { tag, props, kids }, with strings as text leaves.
function expand(node) {
  if (Array.isArray(node)) return node.flatMap((n) => expand(n));
  if (node == null || node === false || node === true) return [];
  if (!React.isValidElement(node)) return [String(node)];
  const { type, props } = node;
  if (type === React.Fragment) return expand(props.children);
  if (typeof type === 'function') return expand(type(props));
  return [{ tag: type, props, kids: expand(props.children) }];
}
const textOf = (n) => (typeof n === 'string' ? n : n.kids.map(textOf).join(''));
function findAll(nodes, pred, out = []) {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (pred(n)) out.push(n);
    findAll(n.kids, pred, out);
  }
  return out;
}

function mount(initialProps) {
  const inst = { states: [], effectDeps: [], memo: [], pendingEffects: [], cursor: 0, renders: 0, props: initialProps, out: [] };
  inst.render = () => {
    aim(inst);
    inst.cursor = 0;
    inst.renders += 1;
    inst.out = expand(FileBrowserDialog(inst.props));
    const effects = inst.pendingEffects;
    inst.pendingEffects = [];
    for (const fx of effects) fx();
  };
  inst.render();
  return inst;
}

// Fake fetch: every request is logged; `routes[url]` returns a promise.
const fetchLog = [];
let routes = {};
globalThis.fetch = (url) => {
  fetchLog.push(url);
  const r = routes[url];
  if (!r) return Promise.reject(new Error(`unrouted ${url}`));
  return r();
};
const respond = (body, { ok = true, status = 200 } = {}) => () =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
const deferred = () => {
  let resolveFn, rejectFn;
  const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  return { route: () => p, resolve: (body, o = {}) => resolveFn({ ok: o.ok ?? true, status: o.status ?? 200, json: () => Promise.resolve(body) }), reject: (e) => rejectFn(e) };
};
const settle = () => new Promise((r) => setImmediate(r));

const ROOT = [{ name: 'src', type: 'dir' }, { name: 'docs', type: 'dir' }, { name: 'README.md', type: 'file' }];
const SRC = [{ name: 'lib', type: 'dir' }, { name: 'a.ts', type: 'file' }];
const LIB = [{ name: 'x.ts', type: 'file' }];
const url = (id, dir) => `/api/git-ls?id=${encodeURIComponent(id)}&dir=${encodeURIComponent(dir)}`;

function setup({ chatId = 'chat1', open = true, cwd } = {}) {
  fetchLog.length = 0;
  copied.length = 0;
  routes = {};
  const calls = [];
  const props = {
    chatId, cwd, open,
    onOpenChange: (v) => calls.push(['open', v]),
    onSelectFile: (f) => calls.push(['select', f]),
  };
  return { props, calls };
}
const rows = (inst) => findAll(inst.out, (n) => n.tag === 'cm');
const rowByName = (inst, name) => rows(inst).find((cm) => textOf(findAll(cm.kids, (n) => n.tag === 'button')[0]) === name);
const buttonOf = (cm) => findAll(cm.kids, (n) => n.tag === 'button')[0];
const itemOf = (cm, label) => findAll(cm.kids, (n) => n.tag === 'item' && textOf(n) === label)[0];
const body = (inst) => textOf({ kids: inst.out });
const click = async (inst, name) => { buttonOf(rowByName(inst, name)).props.onClick(); await settle(); };
const msgRows = (inst) => findAll(inst.out, (n) => n.tag === 'div' && n.props.style && n.props.className?.includes('py-1.5'));

// --- tests -------------------------------------------------------------------
test('driver sanity: setState re-renders and effects run by deps (WARDEN-997)', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  const inst = mount(props);
  const before = inst.renders;
  assert.ok(before >= 2, 'the open effect seeds root state, which must re-render the mount');
  await settle();
  assert.ok(inst.renders > before, 'a resolved fetch must re-render via setState');
  assert.equal(fetchLog.length, 1);
  inst.render(); // same deps -> effect must NOT re-run
  assert.equal(fetchLog.length, 1);
});

test('open fetches /api/git-ls with chatId and dir encodeURIComponent-encoded', async () => {
  const { props } = setup({ chatId: 'a b/c&d' });
  routes[url('a b/c&d', '')] = respond({ entries: [] });
  mount(props);
  await settle();
  assert.deepEqual(fetchLog, ['/api/git-ls?id=a%20b%2Fc%26d&dir=']);
});

test('a closed dialog fetches nothing and renders nothing', async () => {
  const { props } = setup({ open: false });
  const inst = mount(props);
  await settle();
  assert.deepEqual(fetchLog, []);
  assert.deepEqual(inst.out, []);
});

test('first load shows Loading… (not empty), then the entries', async () => {
  const { props } = setup();
  const d = deferred();
  routes[url('chat1', '')] = d.route;
  const inst = mount(props);
  assert.match(body(inst), /Loading…/);
  assert.doesNotMatch(body(inst), /empty/);
  d.resolve({ entries: ROOT });
  await settle();
  assert.doesNotMatch(body(inst), /Loading…/);
  assert.deepEqual(rows(inst).map((cm) => textOf(buttonOf(cm))), ['src', 'docs', 'README.md']);
});

test('HTTP 200 carrying {error} renders the error, never "empty"', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ error: 'not a git repository', entries: [] });
  const inst = mount(props);
  await settle();
  assert.match(body(inst), /not a git repository/);
  assert.doesNotMatch(body(inst), /empty/);
});

test('non-ok falls back to "ls failed" unless the body carries an error', async () => {
  let { props } = setup();
  routes[url('chat1', '')] = respond({}, { ok: false, status: 500 });
  let inst = mount(props);
  await settle();
  assert.match(body(inst), /ls failed/);

  ({ props } = setup());
  routes[url('chat1', '')] = respond({ error: 'no cwd' }, { ok: false, status: 400 });
  inst = mount(props);
  await settle();
  assert.match(body(inst), /no cwd/);
  assert.doesNotMatch(body(inst), /ls failed/);

  // non-ok whose body does not parse (HTML error page) -> still "ls failed"
  ({ props } = setup());
  routes[url('chat1', '')] = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('bad')) });
  inst = mount(props);
  await settle();
  assert.match(body(inst), /ls failed/);
});

test('rejected fetch and truncated 200 body both render "ls failed"', async () => {
  let { props } = setup();
  routes[url('chat1', '')] = () => Promise.reject(new Error('network'));
  let inst = mount(props);
  await settle();
  assert.match(body(inst), /ls failed/);
  assert.doesNotMatch(body(inst), /empty/);

  ({ props } = setup());
  routes[url('chat1', '')] = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('truncated')) });
  inst = mount(props);
  await settle();
  assert.match(body(inst), /ls failed/);
  assert.doesNotMatch(body(inst), /empty/);
});

test('empty and non-array entries render "empty"', async () => {
  for (const entries of [[], undefined, null, 'oops', { a: 1 }]) {
    const { props } = setup();
    routes[url('chat1', '')] = respond({ entries });
    const inst = mount(props);
    await settle();
    assert.match(body(inst), /empty/, `entries=${JSON.stringify(entries)}`);
    assert.deepEqual(rows(inst), []);
  }
});

test('close clears the tree; reopen shows Loading… and refetches the root', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  const inst = mount(props);
  await settle();
  assert.equal(rows(inst).length, 3);

  inst.props = { ...props, open: false };
  inst.render();
  assert.deepEqual(inst.out, []);
  assert.equal(fetchLog.length, 1, 'closing must not fetch');

  const d = deferred();
  routes[url('chat1', '')] = d.route;
  inst.props = { ...props, open: true };
  inst.render();
  assert.equal(fetchLog.length, 2, 'reopen refetches the root');
  assert.deepEqual(rows(inst), [], 'stale entries from the previous open must be gone');
  assert.match(body(inst), /Loading…/);
  d.resolve({ entries: [{ name: 'fresh.txt', type: 'file' }] });
  await settle();
  assert.deepEqual(rows(inst).map((cm) => textOf(buttonOf(cm))), ['fresh.txt']);
});

test('reopen forgets expanded subdirs: they are collapsed and refetched on the next click', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ entries: SRC });
  const inst = mount(props);
  await settle();
  await click(inst, 'src');
  assert.equal(fetchLog.length, 2);
  inst.props = { ...props, open: false };
  inst.render();
  inst.props = { ...props, open: true };
  inst.render();
  await settle();
  assert.equal(buttonOf(rowByName(inst, 'src')).props['aria-expanded'], false);
  assert.equal(rowByName(inst, 'a.ts'), undefined);
  await click(inst, 'src');
  assert.deepEqual(fetchLog.slice(2), [url('chat1', ''), url('chat1', 'src')]);
});

test('a chatId change refetches; an unrelated re-render does not', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat2', '')] = respond({ entries: [{ name: 'other.md', type: 'file' }] });
  const inst = mount(props);
  await settle();
  assert.equal(fetchLog.length, 1);

  inst.props = { ...props, cwd: '/elsewhere', onSelectFile: () => {}, onOpenChange: () => {} };
  inst.render();
  await settle();
  assert.equal(fetchLog.length, 1, 'new callbacks / cwd must not refetch');

  inst.props = { ...inst.props, chatId: 'chat2' };
  inst.render();
  await settle();
  assert.deepEqual(fetchLog, [url('chat1', ''), url('chat2', '')]);
  assert.deepEqual(rows(inst).map((cm) => textOf(buttonOf(cm))), ['other.md']);
});

test('description names the cwd, falling back to "."', async () => {
  let { props } = setup({ cwd: '/work/repo' });
  routes[url('chat1', '')] = respond({ entries: [] });
  let inst = mount(props);
  assert.match(textOf(findAll(inst.out, (n) => n.props['data-desc'])[0]), /in \/work\/repo —/);
  ({ props } = setup());
  routes[url('chat1', '')] = respond({ entries: [] });
  inst = mount(props);
  assert.match(textOf(findAll(inst.out, (n) => n.props['data-desc'])[0]), /in \. —/);
});

test('lazy expand: first click requests dir=<path>, collapse keeps the cache, re-expand does not refetch', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ entries: SRC });
  const inst = mount(props);
  await settle();
  assert.equal(buttonOf(rowByName(inst, 'src')).props['aria-expanded'], false);

  await click(inst, 'src');
  assert.equal(fetchLog.at(-1), '/api/git-ls?id=chat1&dir=src');
  assert.equal(fetchLog.length, 2);
  assert.equal(buttonOf(rowByName(inst, 'src')).props['aria-expanded'], true);
  assert.ok(rowByName(inst, 'a.ts'), 'children render after the first click');

  await click(inst, 'src'); // collapse
  assert.equal(buttonOf(rowByName(inst, 'src')).props['aria-expanded'], false);
  assert.equal(rowByName(inst, 'a.ts'), undefined);
  assert.equal(fetchLog.length, 2, 'collapse must not fetch');

  await click(inst, 'src'); // re-expand from cache
  assert.ok(rowByName(inst, 'a.ts'));
  assert.equal(fetchLog.length, 2, 're-expand must serve the cache');
});

test('a subdir shows its own Loading… while its fetch is pending', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  const d = deferred();
  routes[url('chat1', 'src')] = d.route;
  const inst = mount(props);
  await settle();
  await click(inst, 'src');
  assert.match(body(inst), /Loading…/);
  assert.equal(buttonOf(rowByName(inst, 'src')).props['aria-expanded'], true);
  d.resolve({ entries: SRC });
  await settle();
  assert.doesNotMatch(body(inst), /Loading…/);
});

test('nested expand joins the path: src/lib is requested as dir=src%2Flib', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ entries: SRC });
  routes[url('chat1', 'src/lib')] = respond({ entries: LIB });
  const inst = mount(props);
  await settle();
  await click(inst, 'src');
  await click(inst, 'lib');
  assert.equal(fetchLog.at(-1), '/api/git-ls?id=chat1&dir=src%2Flib');
  assert.ok(rowByName(inst, 'x.ts'));
});

test('a failing subdir is isolated: siblings and the root stay intact', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ error: 'boom' });
  routes[url('chat1', 'docs')] = respond({ entries: [{ name: 'guide.md', type: 'file' }] });
  const inst = mount(props);
  await settle();
  await click(inst, 'src');
  await click(inst, 'docs');
  assert.match(body(inst), /boom/);
  assert.ok(rowByName(inst, 'guide.md'), 'sibling listing unaffected by the failed subdir');
  assert.ok(rowByName(inst, 'README.md'), 'root listing unaffected');
});

test('file click hands the repo-relative path to onSelectFile THEN closes the dialog', async () => {
  const { props, calls } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ entries: SRC });
  const inst = mount(props);
  await settle();
  buttonOf(rowByName(inst, 'README.md')).props.onClick();
  assert.deepEqual(calls, [['select', 'README.md'], ['open', false]]);

  calls.length = 0;
  await click(inst, 'src');
  assert.deepEqual(calls, [], 'a directory click must not select or close');
  buttonOf(rowByName(inst, 'a.ts')).props.onClick();
  assert.deepEqual(calls, [['select', 'src/a.ts'], ['open', false]]);
});

test('Dialog onOpenChange is the parent callback (Esc / overlay close reaches the parent)', async () => {
  const { props, calls } = setup();
  routes[url('chat1', '')] = respond({ entries: [] });
  const inst = mount(props);
  findAll(inst.out, (n) => n.tag === 'dialog')[0].props.onOpenChange(false);
  assert.deepEqual(calls, [['open', false]]);
});

test('context menu on a dir: Expand/Collapse label tracks state and the item toggles', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ entries: SRC });
  const inst = mount(props);
  await settle();
  assert.ok(itemOf(rowByName(inst, 'src'), 'Expand'));
  assert.equal(itemOf(rowByName(inst, 'src'), 'Collapse'), undefined);

  itemOf(rowByName(inst, 'src'), 'Expand').props.onSelect();
  await settle();
  assert.equal(fetchLog.at(-1), '/api/git-ls?id=chat1&dir=src', 'Expand via menu lazy-loads like the click');
  assert.ok(itemOf(rowByName(inst, 'src'), 'Collapse'));
  assert.equal(itemOf(rowByName(inst, 'src'), 'Expand'), undefined);

  itemOf(rowByName(inst, 'src'), 'Collapse').props.onSelect();
  await settle();
  assert.equal(rowByName(inst, 'a.ts'), undefined);
  assert.ok(itemOf(rowByName(inst, 'src'), 'Expand'));
});

test('context menu copy targets: Copy file path = full repo-relative path, Copy filename = basename', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ entries: SRC });
  routes[url('chat1', 'src/lib')] = respond({ entries: LIB });
  const inst = mount(props);
  await settle();
  await click(inst, 'src');
  await click(inst, 'lib');

  itemOf(rowByName(inst, 'lib'), 'Copy file path').props.onSelect();
  itemOf(rowByName(inst, 'lib'), 'Copy filename').props.onSelect();
  itemOf(rowByName(inst, 'x.ts'), 'Copy file path').props.onSelect();
  itemOf(rowByName(inst, 'x.ts'), 'Copy filename').props.onSelect();
  itemOf(rowByName(inst, 'README.md'), 'Copy file path').props.onSelect();
  assert.deepEqual(copied, ['src/lib', 'lib', 'src/lib/x.ts', 'x.ts', 'README.md']);
});

test('context menu Open on a file selects and closes (same handoff as the click)', async () => {
  const { props, calls } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ entries: SRC });
  const inst = mount(props);
  await settle();
  await click(inst, 'src');
  calls.length = 0;
  itemOf(rowByName(inst, 'a.ts'), 'Open').props.onSelect();
  assert.deepEqual(calls, [['select', 'src/a.ts'], ['open', false]]);
  // dirs have no Open item; files have no Expand/Collapse
  assert.equal(itemOf(rowByName(inst, 'src'), 'Open'), undefined);
  assert.equal(itemOf(rowByName(inst, 'a.ts'), 'Expand'), undefined);
});

test('indent arithmetic: dirs depth*14+8, files +18, message rows +20', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ entries: ROOT });
  routes[url('chat1', 'src')] = respond({ entries: SRC });
  routes[url('chat1', 'src/lib')] = respond({ entries: [] });
  routes[url('chat1', 'docs')] = respond({ error: 'denied' });
  const pad = (inst, name) => buttonOf(rowByName(inst, name)).props.style.paddingLeft;
  const inst = mount(props);
  await settle();
  assert.equal(pad(inst, 'src'), 8);
  assert.equal(pad(inst, 'README.md'), 26);
  await click(inst, 'src');
  assert.equal(pad(inst, 'lib'), 22);
  assert.equal(pad(inst, 'a.ts'), 40);
  await click(inst, 'lib');
  assert.equal(msgRows(inst).find((n) => textOf(n) === 'empty').props.style.paddingLeft, 14 * 2 + 8 + 20);
  await click(inst, 'docs');
  assert.equal(msgRows(inst).find((n) => textOf(n) === 'denied').props.style.paddingLeft, 14 + 8 + 20);
});

test('root error row sits at the root indent + 20', async () => {
  const { props } = setup();
  routes[url('chat1', '')] = respond({ error: 'no cwd' });
  const inst = mount(props);
  await settle();
  assert.equal(msgRows(inst)[0].props.style.paddingLeft, 28);
});
