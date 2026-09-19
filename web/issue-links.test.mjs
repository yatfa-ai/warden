// Tests for findIssueCandidates / issueTrackerUrl / normalizeIssueLinkEntries —
// the strict per-project issue-key extractor behind WARDEN-1388's terminal
// issue linkifier.
//
// Same harness as url-links.test.mjs / path-links.test.mjs (no front-end test
// runner in this repo): load the REAL src/lib modules (transpiled TS -> ESM via
// Vite's OXC transform) and exercise them directly. This module decides which
// whitespace-delimited tokens become issue links — the risky pure-logic pieces:
// whole-token anchoring, configured-prefix-only matching, per-project scoping,
// punctuation trimming, the wrap-truncation guard, and the URL>path>issue
// mask-then-subtract composition. The opener (system browser via the
// wardenWindow bridge), the config plumbing, and the xterm wiring are
// integration concerns verified live; these tests pin the recognition half.
//
// Run: node issue-links.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL modules (TS -> ESM via the OXC transform Vite bundles) ----
// issue-links.ts is self-contained (no relative imports), url-links.ts too;
// path-links.ts imports ./url-links (see path-links.test.mjs for the same
// rewrite dance). All three load so the composition tests exercise the REAL
// mask-then-subtract precedence chain, not a re-implementation of it.
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-issuelinks-test-'));
const transpile = async (name, rewrite) => {
  let src = readFileSync(join(libDir, name), 'utf8');
  if (rewrite) src = src.replace(rewrite.from, rewrite.to);
  const { code } = await transformWithOxc(src, join(libDir, name), {});
  const out = join(tmpDir, name.replace(/\.ts$/, '.mjs'));
  writeFileSync(out, code);
  return import(out);
};
const { findUrlCandidates, maskUrls, maskSpans } = await transpile('url-links.ts');
const { findPathCandidates } = await transpile('path-links.ts', { from: /from ['"]\.\/url-links['"]/, to: 'from "./url-links.mjs"' });
const { findIssueCandidates, issueEntriesForProject, issueTrackerUrl, normalizeIssueLinkEntries, shouldResolvePaneProject, paneIssueEntryFor } = await transpile('issue-links.ts');
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// The fixture mapping: a warden pane configured with two prefixes (one project
// may legitimately own several prefixes), and the entries a DIFFERENT project
// would have — used to prove strict scoping.
const WARDEN_ENTRIES = [
  { project: 'warden', prefix: 'WARDEN', tracker: 'github.com/acme/warden/issues' },
  { project: 'warden', prefix: 'OPS', tracker: 'ops.internal:8443/browse' },
];
const YATFA_ENTRIES = [{ project: 'yatfa', prefix: 'YATFA', tracker: 'yatfa.dev/issues' }];
// BOTH mappings in one set — pins paneIssueEntryFor's LEG ORDER: when the pane's
// own project AND the resolved project both have mappings, the OWN project's
// entry must win (a swapped implementation would pass the single-mapping
// fixtures below unchanged).
const BOTH_ENTRIES = [...WARDEN_ENTRIES, ...YATFA_ENTRIES];

// Just the keys recognized on a line (through the REAL precedence composition
// PaneTile runs: maskUrls → findPathCandidates → maskSpans → findIssueCandidates).
const keys = (line, entries, opts) =>
  findIssueCandidates(
    maskSpans(maskUrls(line), findPathCandidates(maskUrls(line))),
    entries,
    opts,
  ).map((c) => c.key);

console.log('\nrecognition — configured-prefix keys are found whole');
test('a plain key mid-line is one candidate', () => {
  assert.deepEqual(keys('fix landed in WARDEN-1385 today', WARDEN_ENTRIES), ['WARDEN-1385']);
});
test('a key at start or end of line is recognized', () => {
  assert.deepEqual(keys('WARDEN-1 is at the start', WARDEN_ENTRIES), ['WARDEN-1']);
  assert.deepEqual(keys('at the end: WARDEN-42', WARDEN_ENTRIES), ['WARDEN-42']);
});
test('multiple keys on one line are independent candidates', () => {
  assert.deepEqual(keys('WARDEN-1 then WARDEN-2 then OPS-7', WARDEN_ENTRIES),
    ['WARDEN-1', 'WARDEN-2', 'OPS-7']);
});
test('several prefixes for one project all match', () => {
  assert.deepEqual(keys('OPS-3 blocks WARDEN-9', WARDEN_ENTRIES), ['OPS-3', 'WARDEN-9']);
});
test('keys keep start/length against the ORIGINAL line', () => {
  const line = 'see WARDEN-1385, it regressed';
  const [c] = findIssueCandidates(
    maskSpans(maskUrls(line), findPathCandidates(maskUrls(line))), WARDEN_ENTRIES);
  assert.equal(c.start, 4);
  assert.equal(c.length, 'WARDEN-1385'.length);
  assert.equal(line.slice(c.start, c.start + c.length), 'WARDEN-1385');
});
test('surrounding punctuation is trimmed off the linked span', () => {
  assert.deepEqual(keys('done (WARDEN-1385).', WARDEN_ENTRIES), ['WARDEN-1385']);
  assert.deepEqual(keys('see `WARDEN-42` and "OPS-7":', WARDEN_ENTRIES), ['WARDEN-42', 'OPS-7']);
  const [c] = findIssueCandidates('fix WARDEN-1385:', WARDEN_ENTRIES);
  assert.equal(c.length, 'WARDEN-1385'.length, 'trailing colon is not part of the link');
});

console.log('\nstrictness — whole-token anchoring, nothing inferred');
test('a key inside a bigger word never linkifies', () => {
  assert.deepEqual(keys('XWARDEN-1385 is one token', WARDEN_ENTRIES), []);
  assert.deepEqual(keys('WARDEN-1385x is not digits-only', WARDEN_ENTRIES), []);
  assert.deepEqual(keys('WARDEN-1385.5 keeps its dot', WARDEN_ENTRIES), []);
});
test('a file-ish token (dot suffix) stays plain text, never an issue link', () => {
  assert.deepEqual(keys('edited WARDEN-1385.tsx today', WARDEN_ENTRIES), []);
});
test('malformed shapes never match', () => {
  assert.deepEqual(keys('WARDEN--1385 WARDEN- WARDEN -1385 WARDEN-1-2', WARDEN_ENTRIES), []);
});
test('lowercase does not match an uppercased configured prefix', () => {
  assert.deepEqual(keys('warden-1385 stays plain', WARDEN_ENTRIES), []);
});
test('leading-zero digits are preserved verbatim in the key', () => {
  assert.deepEqual(keys('backfilled WARDEN-0042', WARDEN_ENTRIES), ['WARDEN-0042']);
});

console.log('\nscoping — configured prefixes and the pane project only');
test("another project's key stays plain text", () => {
  assert.deepEqual(keys('moved to YATFA-1234 in that repo', WARDEN_ENTRIES), []);
});
test('noise tokens never match realistic prefixes', () => {
  assert.deepEqual(keys('hash SHA-256 vs UTF-8 and HTTP-404 codes', WARDEN_ENTRIES), []);
});
test('an unknown / empty pane project yields no entries', () => {
  assert.deepEqual(issueEntriesForProject(WARDEN_ENTRIES, undefined), []);
  assert.deepEqual(issueEntriesForProject(WARDEN_ENTRIES, null), []);
  assert.deepEqual(issueEntriesForProject(WARDEN_ENTRIES, ''), []);
});
test('project matching is strict, case-sensitive equality', () => {
  assert.deepEqual(issueEntriesForProject(WARDEN_ENTRIES, 'Warden'), []);
  assert.equal(issueEntriesForProject(WARDEN_ENTRIES, 'warden').length, 2);
});
test('no configured entries at all → no candidates', () => {
  assert.deepEqual(keys('WARDEN-1385 stays plain', []), []);
});

console.log('\nprecedence — URL > path > issue (the real composition)');
test('a key inside a URL is consumed by the URL layer, not linked twice', () => {
  const line = 'open https://github.com/acme/warden/issues/WARDEN-1385 now';
  const urlMasked = maskUrls(line);
  assert.equal(findUrlCandidates(line).length, 1, 'the URL is recognized');
  assert.deepEqual(keys(line, WARDEN_ENTRIES), [], 'the key inside it is not re-linked');
});
test('a key beside a path link both resolve, never overlapping', () => {
  const line = 'patch src/app.ts:12 for WARDEN-1385';
  const urlMasked = maskUrls(line);
  const paths = findPathCandidates(urlMasked);
  const issues = findIssueCandidates(maskSpans(urlMasked, paths), WARDEN_ENTRIES);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'WARDEN-1385');
  const p = paths[0];
  for (const i of issues) {
    const overlaps = i.start < p.start + p.length && p.start < i.start + i.length;
    assert.ok(!overlaps, 'issue span must not overlap the path span');
  }
});
test('masking preserves indices — candidates read back correctly from the original line', () => {
  const line = 'open https://x.dev/1 then WARDEN-1385';
  const urlMasked = maskUrls(line);
  const paths = findPathCandidates(urlMasked);
  const [c] = findIssueCandidates(maskSpans(urlMasked, paths), WARDEN_ENTRIES);
  assert.equal(line.slice(c.start, c.start + c.length), 'WARDEN-1385');
});

console.log('\nwrap truncation — a key split by the terminal wrap is not linked');
test('a key ending at EOL is dropped when the next line wraps', () => {
  assert.deepEqual(keys('rollback to WARDEN-1385', WARDEN_ENTRIES, { wrappedAtEol: true }), [],
    'the tail digits may live on the next buffer line');
});
test('the same line keeps its key when nothing wraps', () => {
  assert.deepEqual(keys('rollback to WARDEN-1385', WARDEN_ENTRIES, { wrappedAtEol: false }), ['WARDEN-1385']);
  assert.deepEqual(keys('rollback to WARDEN-1385', WARDEN_ENTRIES), ['WARDEN-1385']);
});
test('a key NOT touching EOL is unaffected by the wrap flag', () => {
  assert.deepEqual(keys('WARDEN-1385 then more text', WARDEN_ENTRIES, { wrappedAtEol: true }), ['WARDEN-1385']);
});

console.log('\nURL builder + defensive entry normalization');
test('issueTrackerUrl appends the key to the configured base', () => {
  assert.equal(issueTrackerUrl(WARDEN_ENTRIES[0], 'WARDEN-1385'),
    'https://github.com/acme/warden/issues/WARDEN-1385');
  assert.equal(issueTrackerUrl(WARDEN_ENTRIES[1], 'OPS-7'),
    'https://ops.internal:8443/browse/OPS-7');
});
test('issueTrackerUrl strips a trailing slash / accidental scheme from the base', () => {
  assert.equal(issueTrackerUrl({ project: 'p', prefix: 'P', tracker: 'host.io/path/' }, 'P-1'),
    'https://host.io/path/P-1');
  assert.equal(issueTrackerUrl({ project: 'p', prefix: 'P', tracker: 'https://host.io' }, 'P-1'),
    'https://host.io/P-1');
});
test('normalizeIssueLinkEntries keeps well-formed entries and uppercases prefixes', () => {
  assert.deepEqual(
    normalizeIssueLinkEntries([{ project: 'warden', prefix: 'warden', tracker: 'github.com/a/w/issues/' }]),
    [{ project: 'warden', prefix: 'WARDEN', tracker: 'github.com/a/w/issues' }],
  );
});
test('normalizeIssueLinkEntries drops malformed entries (hand-edited config.json)', () => {
  assert.deepEqual(normalizeIssueLinkEntries([
    null,
    'not an object',
    { project: '', prefix: 'P', tracker: 'host.io' },
    { project: 'p', prefix: '1P', tracker: 'host.io' },
    { project: 'p', prefix: 'P', tracker: 'https://bad but scheme' },
    { project: 'p', prefix: 'P', tracker: 'has space.io' },
    { project: 'p', prefix: 'P', tracker: 'host.io?q=1' },
    { project: 'ok', prefix: 'P', tracker: 'host.io/path' },
  ]), [{ project: 'ok', prefix: 'P', tracker: 'host.io/path' }]);
  assert.deepEqual(normalizeIssueLinkEntries(undefined), []);
  assert.deepEqual(normalizeIssueLinkEntries('nope'), []);
});

// WARDEN-1405: the one-shot /api/pane-project fetch gate. True ONLY for the
// panes where the resolved-project answer can change the outcome — a manual
// (container-less) pane whose own project has no mapping, while the
// integration is on and mappings exist at all. Every other population is
// pinned FALSE: the toggle off (no request fired at all — the byte-identical
// off state), a yatfa pane (its project already IS the container parse — zero
// requests), and a pane whose own project is already mapped (nothing to
// resolve).
test('shouldResolvePaneProject: a mapped manual pane needs no resolution', () => {
  assert.equal(shouldResolvePaneProject({ container: null, project: 'warden' }, true, WARDEN_ENTRIES), false);
});
test('shouldResolvePaneProject: an unmapped manual (container-less) pane is the one true case', () => {
  assert.equal(shouldResolvePaneProject({ container: null, project: 'manual' }, true, WARDEN_ENTRIES), true);
  assert.equal(shouldResolvePaneProject({ container: null, project: 'local' }, true, YATFA_ENTRIES), true);
  assert.equal(shouldResolvePaneProject({ container: null }, true, WARDEN_ENTRIES), true);
});
test('shouldResolvePaneProject: the integration off fires no request', () => {
  assert.equal(shouldResolvePaneProject({ container: null, project: 'manual' }, false, WARDEN_ENTRIES), false);
});
test('shouldResolvePaneProject: no configured entries — nothing could linkify anyway', () => {
  assert.equal(shouldResolvePaneProject({ container: null, project: 'manual' }, true, []), false);
});
test('shouldResolvePaneProject: yatfa/container panes never ask (their project IS the container parse)', () => {
  assert.equal(shouldResolvePaneProject({ container: 'yatfa-planner-2', project: 'yatfa-planner' }, true, WARDEN_ENTRIES), false);
  assert.equal(shouldResolvePaneProject({ container: 'yatfa-planner-2', project: 'manual' }, true, WARDEN_ENTRIES), false);
});
test('shouldResolvePaneProject: no chat at all is false', () => {
  assert.equal(shouldResolvePaneProject(null, true, WARDEN_ENTRIES), false);
  assert.equal(shouldResolvePaneProject(undefined, true, WARDEN_ENTRIES), false);
});

// WARDEN-1413 (slice 4): THE pane's issue-entry scope — the two-leg per-ENTRY
// selection in ONE home, consumed by BOTH the linkifier's scope line and the
// gated pane-header project label, so the label can never drift from what a
// click actually opens. The four arms below are the ticket's pinned
// honest-silence and mapping arms; the fifth pins the [0] selection; the
// mutation check proves the fallback leg is load-bearing.
console.log('\npaneIssueEntryFor — the two-leg scope both the linkifier and the header chip read');
test('paneIssueEntryFor: empty entries → null (nothing configured, nothing announced)', () => {
  assert.equal(paneIssueEntryFor([], 'warden', 'yatfa'), null);
});
test('paneIssueEntryFor: own project mapped → THAT entry, second leg never needed', () => {
  assert.equal(paneIssueEntryFor(WARDEN_ENTRIES, 'warden', 'yatfa'), WARDEN_ENTRIES[0]);
  assert.equal(paneIssueEntryFor(YATFA_ENTRIES, 'yatfa', null), YATFA_ENTRIES[0]);
  // LEG ORDER, pinned: both legs have a mapping and the OWN project's wins.
  assert.equal(paneIssueEntryFor(BOTH_ENTRIES, 'warden', 'yatfa'), WARDEN_ENTRIES[0],
    'a pane whose own project is mapped never falls through to the resolved leg');
  assert.equal(paneIssueEntryFor(BOTH_ENTRIES, 'yatfa', 'warden'), YATFA_ENTRIES[0]);
});
test('paneIssueEntryFor: own project unmapped + resolved project mapped → resolved\'s entry (the slice-3 fallback leg)', () => {
  // The manual-pane shape: a truthy placeholder own project, one-shot
  // /api/pane-project resolution landed a REAL mapped project.
  assert.equal(paneIssueEntryFor(WARDEN_ENTRIES, 'manual', 'warden'), WARDEN_ENTRIES[0]);
  assert.equal(paneIssueEntryFor(YATFA_ENTRIES, 'local', 'yatfa'), YATFA_ENTRIES[0]);
});
test('paneIssueEntryFor: honest silence — neither leg has a mapping → null', () => {
  // Both unmapped (own placeholder + resolution failed → null resolved leg).
  assert.equal(paneIssueEntryFor(WARDEN_ENTRIES, 'manual', null), null);
  assert.equal(paneIssueEntryFor(WARDEN_ENTRIES, 'manual', undefined), null);
  // Own project unmapped, resolved project ALSO unmapped.
  assert.equal(paneIssueEntryFor(WARDEN_ENTRIES, 'manual', 'unknown-project'), null);
  // A mapped RESOLVED project but null own project (chat metadata not loaded yet).
  assert.equal(paneIssueEntryFor(YATFA_ENTRIES, null, 'yatfa'), YATFA_ENTRIES[0]);
  // null/undefined own AND resolved — the ungated/pre-resolution state.
  assert.equal(paneIssueEntryFor(WARDEN_ENTRIES, null, null), null);
});
test('paneIssueEntryFor: several entries for one project → the FIRST ([0]) — the provider\'s own selection', () => {
  assert.equal(paneIssueEntryFor(WARDEN_ENTRIES, 'warden', null), WARDEN_ENTRIES[0],
    'warden has two prefixes; the linkifier opens with entries[0]');
});
test('paneIssueEntryFor: mutation — deleting the fallback leg changes the manual-pane outcome', () => {
  const firstLegOnly = (entries, project) =>
    (project ? entries.filter((e) => e.project === project)[0] : undefined) ?? null;
  assert.notEqual(firstLegOnly(WARDEN_ENTRIES, 'manual'),
    paneIssueEntryFor(WARDEN_ENTRIES, 'manual', 'warden'),
    'without leg 2 the helper degenerates to null for a manual pane; with it the resolved project wins');
  assert.equal(firstLegOnly(WARDEN_ENTRIES, 'manual'), null);
  assert.equal(paneIssueEntryFor(WARDEN_ENTRIES, 'manual', 'warden'), WARDEN_ENTRIES[0]);
});

console.log(`\n${passed} issue-links assertions passed`);
