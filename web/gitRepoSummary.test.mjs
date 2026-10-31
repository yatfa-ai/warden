// Tests for GitRepoSummary (web/src/components/sidebar/GitBadges.tsx) — the one-line
// branch/state summary on the git section header (WARDEN-975). Nothing else renders it:
// the sibling suites only regex-match SourceControlPanel/GitBadges source text.
//
// No DOM runner in this repo, so (like sidebarBits.test.mjs) this loads the REAL
// GitBadges.tsx via Vite's OXC transform into a tmp dir under web/, rewrites the `@/...`
// specifiers, stubs ONLY the leaf modules, and renders with renderToStaticMarkup.
//
// Run: node --test gitRepoSummary.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.tmp-gitreposummary-test-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const STUBS = {
  '@/components/ui/context-menu': 'contextMenu.mjs',
  '@/lib/clipboardToast': 'clipboardToast.mjs',
  'lucide-react': 'lucide.mjs',
  '@/components/DiffBlock': 'diffBlock.mjs',
  '@/lib/utils': 'utils.mjs',
  '@/lib/chatDisplay': 'chatDisplay.mjs',
  '@/lib/formatTimestamp': 'formatTimestamp.mjs',
  '@/lib/uiStore': 'uiStore.mjs',
  './DiffStatChip': 'diffStatChip.mjs',
  '@/lib/api': 'api.mjs',
  '@/lib/gitDiffApi': 'gitDiffApi.mjs',
};
const rewrite = (code) => {
  let out = code;
  for (const [spec, f] of Object.entries(STUBS)) for (const q of ["'", '"']) out = out.replaceAll(`${q}${spec}${q}`, `'./${f}'`);
  return out;
};
const p = resolve(__dirname, 'src/components/sidebar/GitBadges.tsx');
const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
writeFileSync(join(tmpDir, 'GitBadges.mjs'), rewrite(code));

const w = (name, body) => writeFileSync(join(tmpDir, name), body);
w('contextMenu.mjs', `export const ContextMenu = () => null; export const ContextMenuContent = () => null;
export const ContextMenuItem = () => null; export const ContextMenuTrigger = () => null;\n`);
w('clipboardToast.mjs', `export function copyWithToast() {}\n`);
w('lucide.mjs', `export const FileIcon = () => null;\n`);
w('diffBlock.mjs', `export const DiffBlock = () => null;\n`);
w('utils.mjs', `export const cn = (...a) => a.filter(Boolean).join(' ');\n`);
w('chatDisplay.mjs', `export const basename = (s) => s;\n`);
w('formatTimestamp.mjs', `export const calls = [];
export function formatTimestamp(at, fmt) { calls.push({ at, fmt }); return 'TS[' + fmt + ']'; }
export function formatAbsoluteFull(ms) { return 'ABS[' + ms + ']'; }\n`);
w('uiStore.mjs', `export function useTimestampFormat() { return 'absolute'; }\n`);
w('diffStatChip.mjs', `import { createElement as h } from 'react';
export function DiffStatChip(p) { return h('i', { 'data-chip': p.diffstat.insertions + '/' + p.diffstat.deletions }); }\n`);
w('api.mjs', `export const fetchBounded = async () => ({});\n`);
w('gitDiffApi.mjs', `export const readFileDiff = async () => ({});\n`);

const { GitRepoSummary, STALE_HEAD_AGE_MS } = await import(join(tmpDir, 'GitBadges.mjs'));
const { calls } = await import(join(tmpDir, 'formatTimestamp.mjs'));

const render = (props) => renderToStaticMarkup(React.createElement(GitRepoSummary, { branch: 'main', clean: true, ...props }));
const titleOf = (html) => html.match(/^<span[^>]*? title="([^"]*)"/)[1];
const DAY = 86400_000;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

test('exports a 7-day stale threshold', () => {
  assert.equal(STALE_HEAD_AGE_MS, 7 * DAY);
});

test('a clean tracked branch renders ⎇ branch + → upstream and nothing else', () => {
  const html = render({ upstream: 'origin/main', ahead: 0, behind: 0 });
  assert.match(html, /⎇ main/);
  assert.match(html, /<span class="shrink-0 text-muted-foreground\/80" title="tracking origin\/main">→ origin\/main<\/span>/);
  for (const g of ['⚠', '±', '🔒', '↑', '↓', '🗄', '>· ']) assert.ok(!html.includes(g), `unexpected ${g}`);
  assert.equal(titleOf(html), 'main · tracking origin/main');
  assert.match(html, /text-cyan-400/);
  assert.ok(!html.includes('text-amber-400'));
});

test('a named branch with no upstream shows the 🔒 local-only marker and says so in the hover', () => {
  const html = render({ upstream: null });
  assert.match(html, /🔒/);
  assert.match(html, /title="no remote tracking — local-only work, not backed up remotely"/);
  assert.ok(!html.includes('→'));
  assert.equal(titleOf(html), 'main · no remote tracking — local-only, not backed up');
});

test('the 🔒 marker is suppressed for an empty branch name and for the literal HEAD branch', () => {
  for (const branch of ['', 'HEAD']) {
    const html = render({ branch, upstream: null });
    assert.ok(!html.includes('🔒'), `branch=${JSON.stringify(branch)}`);
    assert.ok(!html.includes('no remote tracking'), `branch=${JSON.stringify(branch)}`);
  }
});

test('ahead / behind render ↑N amber and ↓N blue, only when positive numbers; hover lists them', () => {
  const html = render({ upstream: 'origin/main', ahead: 3, behind: 2 });
  assert.match(html, /<span class="shrink-0 text-amber-400">↑3<\/span>/);
  assert.match(html, /<span class="shrink-0 text-blue-400">↓2<\/span>/);
  assert.equal(titleOf(html), 'main · tracking origin/main · 3 unpushed · 2 behind remote');
  const none = render({ upstream: 'o/m', ahead: null, behind: undefined });
  assert.ok(!none.includes('↑') && !none.includes('↓'));
  const zero = render({ upstream: 'o/m', ahead: 0, behind: 0 });
  assert.ok(!zero.includes('↑') && !zero.includes('↓'));
  const str = render({ upstream: 'o/m', ahead: '4', behind: '5' });
  assert.ok(!str.includes('↑') && !str.includes('↓'));
});

test('stash count renders 🗄N fuchsia with its own hover; zero / non-number renders nothing', () => {
  const html = render({ upstream: 'o/m', stashCount: 2 });
  assert.match(html, /<span class="shrink-0 text-fuchsia-400" title="2 stashed">🗄2<\/span>/);
  assert.equal(titleOf(html), 'main · tracking o/m · 2 stashed');
  assert.ok(!render({ upstream: 'o/m', stashCount: 0 }).includes('🗄'));
  assert.ok(!render({ upstream: 'o/m', stashCount: null }).includes('🗄'));
  assert.ok(!render({ upstream: 'o/m', stashCount: '3' }).includes('🗄'));
});

test('clean === false shows the yellow ± ; only clean === false (null = non-git, true = clean)', () => {
  assert.match(render({ upstream: 'o/m', clean: false }), /<span class="text-yellow-400">±<\/span>/);
  assert.ok(!render({ upstream: 'o/m', clean: true }).includes('±'));
  assert.ok(!render({ upstream: 'o/m', clean: null }).includes('±'));
  // non-git / unknown (null) and clean (true) add no "uncommitted changes" hover part
  for (const clean of [null, true]) assert.ok(!titleOf(render({ upstream: 'o/m', clean })).includes('uncommitted'), String(clean));
  assert.ok(titleOf(render({ upstream: 'o/m', clean: false })).includes('uncommitted changes'));
});

test('dirty magnitude: the DiffStatChip and the hover (+N −M) appear only when insertions + deletions > 0', () => {
  const big = render({ upstream: 'o/m', clean: false, diffstat: { insertions: 4, deletions: 1 } });
  assert.match(big, /data-chip="4\/1"/);
  assert.equal(titleOf(big), 'main · tracking o/m · uncommitted changes (+4 −1)');
  const delOnly = render({ upstream: 'o/m', clean: false, diffstat: { insertions: 0, deletions: 2 } });
  assert.match(delOnly, /data-chip="0\/2"/);
  assert.match(delOnly, /\(\+0 −2\)/);
  const zero = render({ upstream: 'o/m', clean: false, diffstat: { insertions: 0, deletions: 0 } });
  assert.ok(!zero.includes('data-chip'));
  assert.equal(titleOf(zero), 'main · tracking o/m · uncommitted changes');
  const absent = render({ upstream: 'o/m', clean: false, diffstat: null });
  assert.ok(!absent.includes('data-chip'));
  const cleanWithStat = render({ upstream: 'o/m', clean: true, diffstat: { insertions: 9, deletions: 9 } });
  assert.ok(!cleanWithStat.includes('data-chip') && !cleanWithStat.includes('uncommitted'));
});

test('a mid-operation repo leads with the red ⚠ op; detail is folded into its title and the hover', () => {
  const plain = render({ upstream: 'o/m', inProgress: { operation: 'merge' } });
  assert.match(plain, /<span class="shrink-0 text-red-400 font-medium" title="merge in progress">⚠ merge<\/span>/);
  assert.ok(plain.indexOf('⚠') < plain.indexOf('⎇'));
  assert.equal(titleOf(plain), 'main · tracking o/m · merge in progress');
  const detail = render({ upstream: 'o/m', inProgress: { operation: 'rebase', detail: '2/5 · onto abc' } });
  assert.match(detail, /title="rebase in progress · 2\/5 · onto abc">⚠ rebase</);
  assert.equal(titleOf(detail), 'main · tracking o/m · rebase in progress · 2/5 · onto abc');
  for (const inProgress of [{ operation: null }, { operation: null, detail: 'x' }, undefined]) {
    const html = render({ upstream: 'o/m', inProgress });
    assert.ok(!html.includes('⚠') && !html.includes('in progress'), JSON.stringify(inProgress));
  }
});

test('detached HEAD: amber ⎇ + trimmed short SHA instead of the branch label; no 🔒, no tracking part', () => {
  const html = render({ branch: 'HEAD', detached: true, headSha: '  abc1234 ', upstream: null });
  assert.match(html, /text-amber-400/);
  assert.ok(!html.includes('text-cyan-400'));
  assert.match(html, /title="detached HEAD — commits not on a branch; at risk if reflog expires">⎇<\/span>/);
  assert.match(html, /<span class="min-w-0 wrap-anywhere font-mono">abc1234<\/span>/);
  assert.ok(!html.includes('⎇ HEAD'));
  assert.ok(!html.includes('🔒'));
  assert.equal(titleOf(html), 'detached HEAD @ abc1234 · commits not on a branch; at risk if reflog expires');
});

test('detached HEAD without a SHA drops the SHA span and the "@" ; ahead/behind stay out of the hover', () => {
  const html = render({ branch: 'HEAD', detached: true, headSha: '   ', ahead: 2, behind: 3 });
  assert.ok(!html.includes('font-mono'));
  assert.equal(titleOf(html), 'detached HEAD · commits not on a branch; at risk if reflog expires');
  assert.ok(!titleOf(html).includes('unpushed') && !titleOf(html).includes('behind remote'));
  // only a literal `true` means detached: the bare branch name 'HEAD' alone does not
  const headOnly = render({ branch: 'HEAD', detached: undefined, headSha: 'abc1234', upstream: null });
  assert.match(headOnly, /⎇ HEAD/);
  assert.match(headOnly, /text-cyan-400/);
  assert.ok(!headOnly.includes('abc1234'));
  const notDetached = render({ branch: 'dev', detached: false, headSha: 'abc', upstream: 'o/dev' });
  assert.match(notDetached, /⎇ dev/);
  assert.ok(!notDetached.includes('font-mono'));
});

test('last-commit freshness: a fresh headDate is muted, one over 7d is amber; both fold the exact time into the hover', () => {
  const fresh = isoAgo(2 * DAY);
  const f = render({ upstream: 'o/m', headDate: fresh });
  assert.match(f, /<span class="shrink-0 text-muted-foreground">· TS\[absolute\]<\/span>/);
  assert.ok(titleOf(f).includes(`last commit ABS[${Date.parse(fresh)}]`));
  assert.equal(calls.at(-1).at, Date.parse(fresh));
  assert.equal(calls.at(-1).fmt, 'absolute');
  const stale = render({ upstream: 'o/m', headDate: isoAgo(8 * DAY) });
  assert.match(stale, /<span class="shrink-0 text-amber-400">· TS\[absolute\]<\/span>/);
  const nearEdge = render({ upstream: 'o/m', headDate: isoAgo(6.9 * DAY) });
  assert.match(nearEdge, /<span class="shrink-0 text-muted-foreground">· TS/);
});

test('a missing / empty / unparseable headDate renders no freshness marker and no "last commit" hover', () => {
  for (const headDate of [undefined, null, '', 'not-a-date']) {
    const html = render({ upstream: 'o/m', headDate });
    assert.ok(!html.includes('>· '), `headDate=${JSON.stringify(headDate)}`);
    assert.ok(!titleOf(html).includes('last commit'), `headDate=${JSON.stringify(headDate)}`);
  }
});

test('the hover orders its parts: branch, tracking, last commit, operation, dirty, stash, unpushed, behind', () => {
  const headDate = isoAgo(DAY);
  const html = render({
    upstream: 'o/m', headDate, inProgress: { operation: 'revert', detail: 'deadbee' },
    clean: false, diffstat: { insertions: 1, deletions: 2 }, stashCount: 1, ahead: 4, behind: 5,
  });
  assert.equal(titleOf(html),
    `main · tracking o/m · last commit ABS[${Date.parse(headDate)}] · revert in progress · deadbee · uncommitted changes (+1 −2) · 1 stashed · 4 unpushed · 5 behind remote`);
});

test('className is appended after the tint class', () => {
  assert.match(render({ upstream: 'o/m', className: 'extra-x' }), /^<span class="[^"]*text-cyan-400 extra-x"/);
});
