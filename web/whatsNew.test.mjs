// Pure tests for the per-agent "What's new since you last looked" catch-up
// (WARDEN-356). The logic core lives in src/lib/whatsNew.ts so it is unit-
// testable without a React runner (mirroring formatTimestamp.test.mjs /
// agentFilter.test.mjs): lastSeen stamping, the relative-date parser, the
// since-filtered summary, the summary line, and the marker-visibility gate.
//
// Like those suites, there is no FE test runner in this repo, so this loads the
// REAL src/lib/whatsNew.ts (transpiled TS -> ESM via Vite's OXC transform) and
// exercises the pure helpers with plain objects. The wall-clock-dependent
// pieces (parseRelativeDate, summarizeWhatsNew) take `now` as a parameter, so
// no Date.now pinning is needed — the tests are deterministic by construction.
//
// lastSeen reads/writes localStorage; a minimal in-memory shim stands in for it.
//
// Run: node whatsNew.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/whatsNew.ts');

// --- Load the REAL whatsNew.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-whatsnew-test-'));
const tmpFile = join(tmpDir, 'whatsNew.mjs');
writeFileSync(tmpFile, code);
const {
  LAST_SEEN_PREFIX,
  getLastSeen, stampLastSeen,
  parseRelativeDate,
  summarizeWhatsNew, formatWhatsNewLine,
  hasUnreviewedProgress,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- Minimal localStorage shim (whatsNew only does getItem/setItem) -----------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
} ;

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A fixed wall-clock epoch the date-parsing tests resolve relative dates against.
// 2023-11-14T22:13:20Z. Relative dates are "ago" so parsed epochs are now-delta.
const NOW = 1_700_000_000_000;

console.log('\nlastSeen: per-agent localStorage (mirrors warden:lastClose)');
test('key is per-chatId (warden:lastSeen:<id>)', () => {
  assert.equal(LAST_SEEN_PREFIX, 'warden:lastSeen:');
});
test('getLastSeen returns null for an unvisited agent', () => {
  assert.equal(getLastSeen('chat-A'), null);
});
test('stampLastSeen writes and getLastSeen reads it back (round-trip)', () => {
  stampLastSeen('chat-A', NOW);
  assert.equal(getLastSeen('chat-A'), NOW);
});
test('lastSeen is per-agent — stamping B does not touch A', () => {
  stampLastSeen('chat-A', NOW);
  stampLastSeen('chat-B', NOW - 1000);
  assert.equal(getLastSeen('chat-A'), NOW);
  assert.equal(getLastSeen('chat-B'), NOW - 1000);
});
test('a corrupt (non-numeric) value reads back as null, never throws', () => {
  store.set(LAST_SEEN_PREFIX + 'bad', 'not-a-number');
  assert.equal(getLastSeen('bad'), null);
});
test('stampLastSeen defaults to Date.now() when now omitted', () => {
  const real = Date.now;
  Date.now = () => 12345;
  try {
    stampLastSeen('auto');
    assert.equal(getLastSeen('auto'), 12345);
  } finally {
    Date.now = real;
  }
});

console.log('\nparseRelativeDate: git %ar -> epoch (relative to now)');
test('"2 hours ago" -> now - 2h', () => {
  assert.equal(parseRelativeDate('2 hours ago', NOW), NOW - 2 * 3_600_000);
});
test('"3 days ago" -> now - 3d', () => {
  assert.equal(parseRelativeDate('3 days ago', NOW), NOW - 3 * 86_400_000);
});
test('"5 minutes ago" -> now - 5m', () => {
  assert.equal(parseRelativeDate('5 minutes ago', NOW), NOW - 5 * 60_000);
});
test('singular "1 hour ago" parses (not just plural)', () => {
  assert.equal(parseRelativeDate('1 hour ago', NOW), NOW - 3_600_000);
});
test('weeks + months + years units', () => {
  assert.equal(parseRelativeDate('2 weeks ago', NOW), NOW - 2 * 604_800_000);
  assert.equal(parseRelativeDate('4 months ago', NOW), NOW - 4 * 2_629_800_000);
  assert.equal(parseRelativeDate('1 year ago', NOW), NOW - 31_557_600_000);
});
test('compound "1 year, 2 months ago" sums both units', () => {
  assert.equal(
    parseRelativeDate('1 year, 2 months ago', NOW),
    NOW - 31_557_600_000 - 2 * 2_629_800_000,
  );
});
test('seconds unit', () => {
  assert.equal(parseRelativeDate('30 seconds ago', NOW), NOW - 30_000);
});
test('no recognized unit -> null (locale/odd string)', () => {
  assert.equal(parseRelativeDate('yesterday', NOW), null);
  assert.equal(parseRelativeDate('', NOW), null);
  assert.equal(parseRelativeDate('   ', NOW), null);
});

console.log('\nsummarizeWhatsNew: since-filter the already-fetched git-log');
const commits = [
  { hash: 'a1', subject: 'old (before visit)', author: 'ann', date: '5 days ago' },
  { hash: 'b2', subject: 'new (after visit)', author: 'ann', date: '2 hours ago' },
  { hash: 'c3', subject: 'newer (after visit)', author: 'bob', date: '5 minutes ago' },
];
test('only commits parsed to AFTER since count as new', () => {
  // visited 1 day ago: the 5-days-ago commit is older (not new); the two recent
  // ones (2h, 5m) are after the visit → new.
  const since = NOW - 86_400_000; // 1 day ago
  const s = summarizeWhatsNew({ commits, since, now: NOW });
  assert.equal(s.newCommits.length, 2);
  assert.deepEqual(s.newCommits.map((c) => c.hash), ['b2', 'c3']);
});
test('a commit older than since is excluded', () => {
  // since = 1 min ago. Every commit in `commits` is at least 5 min old (older
  // than the visit), so none count as new — the marker must not fire on stale
  // history that predates the last visit.
  const since = NOW - 60_000;
  const s = summarizeWhatsNew({ commits, since, now: NOW });
  assert.equal(s.newCommits.length, 0);
});
test('an unparseable commit since a visit is treated as new (conservative)', () => {
  // git %ar is locale-dependent; a date we can't parse must not silently hide
  // potential progress. When visited, such a commit counts as new so the human
  // gets the marker + sees it in the catch-up view.
  const mixed = [
    { hash: 'x', subject: 'new', author: 'a', date: '2 hours ago' },
    { hash: 'y', subject: 'odd date', author: 'a', date: 'yesterday' }, // unparseable
  ];
  const s = summarizeWhatsNew({ commits: mixed, since: NOW - 86_400_000, now: NOW });
  assert.equal(s.newCommits.length, 2);
  assert.deepEqual(s.newCommits.map((c) => c.hash), ['x', 'y']);
});
test('an unparseable commit is NOT new when the agent was never visited', () => {
  const s = summarizeWhatsNew({
    commits: [{ hash: 'z', subject: 'odd', author: '', date: 'yesterday' }],
    since: 0, now: NOW,
  });
  assert.equal(s.newCommits.length, 0);
});
test('since=0 (never visited) lists no new commits even with recent ones', () => {
  // Without a visit there is no "since", so nothing is "new since". The marker
  // independently gates on since===null, but the summary must not pre-flag.
  const s = summarizeWhatsNew({ commits, since: 0, now: NOW });
  assert.equal(s.newCommits.length, 0);
});
test('changedFileCount + stashCount pass through as current-state context', () => {
  const s = summarizeWhatsNew({ commits: [], since: NOW - 86_400_000, now: NOW, changedFileCount: 7, stashCount: 1 });
  assert.equal(s.changedFileCount, 7);
  assert.equal(s.stashCount, 1);
  assert.equal(s.newCommits.length, 0);
});
test('missing commits -> empty newCommits (no unseen-progress claim)', () => {
  const s = summarizeWhatsNew({ commits: undefined, since: NOW - 86_400_000, now: NOW });
  assert.equal(s.newCommits.length, 0);
});

console.log('\nformatWhatsNewLine: one-glance summary (ticket example shape)');
test('"3 new commits · 7 changed files · 1 stash" — all segments', () => {
  const s = summarizeWhatsNew({
    commits: [
      { hash: '1', subject: 'a', author: '', date: '1 hour ago' },
      { hash: '2', subject: 'b', author: '', date: '1 hour ago' },
      { hash: '3', subject: 'c', author: '', date: '1 hour ago' },
    ],
    since: NOW - 86_400_000, now: NOW, changedFileCount: 7, stashCount: 1,
  });
  assert.equal(formatWhatsNewLine(s), '3 new commits · 7 changed files · 1 stash');
});
test('singular forms: "1 new commit · 1 changed file · 1 stash"', () => {
  const s = summarizeWhatsNew({
    commits: [{ hash: '1', subject: 'a', author: '', date: '1 hour ago' }],
    since: NOW - 86_400_000, now: NOW, changedFileCount: 1, stashCount: 1,
  });
  assert.equal(formatWhatsNewLine(s), '1 new commit · 1 changed file · 1 stash');
});
test('plural stash: "2 stashes"', () => {
  const s = summarizeWhatsNew({ commits: [], since: NOW - 86_400_000, now: NOW, stashCount: 2 });
  assert.equal(formatWhatsNewLine(s), '2 stashes');
});
test('nothing new -> empty string (not "0 new commits …")', () => {
  const s = summarizeWhatsNew({ commits: [], since: NOW - 86_400_000, now: NOW });
  assert.equal(formatWhatsNewLine(s), '');
});

console.log('\nhasUnreviewedProgress: the marker-visibility gate');
test('never visited (since null) -> no marker even with new commits', () => {
  const s = summarizeWhatsNew({ commits, since: 0, now: NOW });
  assert.equal(hasUnreviewedProgress(null, s), false);
});
test('visited + commits landed since -> marker shows', () => {
  const since = NOW - 86_400_000;
  const s = summarizeWhatsNew({ commits, since, now: NOW });
  assert.equal(hasUnreviewedProgress(since, s), true);
});
test('visited + no new commits -> no marker', () => {
  const since = NOW - 60_000; // 1 min ago — none of `commits` are newer
  const s = summarizeWhatsNew({ commits, since, now: NOW });
  assert.equal(hasUnreviewedProgress(since, s), false);
});
test('current dirty/stash state alone does NOT trigger the marker', () => {
  // The ± / 🗄 badges own current-state; this marker is commits-since-visit only.
  const since = NOW - 60_000;
  const s = summarizeWhatsNew({ commits: [], since, now: NOW, changedFileCount: 9, stashCount: 3 });
  assert.equal(hasUnreviewedProgress(since, s), false);
});
test('an unparseable commit since a visit fires the marker (conservative)', () => {
  const since = NOW - 86_400_000;
  const s = summarizeWhatsNew({
    commits: [{ hash: 'z', subject: 'odd', author: '', date: 'yesterday' }],
    since, now: NOW,
  });
  assert.equal(s.newCommits.length, 1);
  assert.equal(hasUnreviewedProgress(since, s), true); // can't rule it out → show
});

console.log(`\n✓ WHATS NEW TESTS PASS (${passed})`);
