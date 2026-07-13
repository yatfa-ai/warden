// Pure tests for the per-agent "What's new since you last looked" catch-up
// (WARDEN-356). The logic core lives in src/lib/whatsNew.ts so it is unit-
// testable without a React runner (mirroring formatTimestamp.test.mjs /
// agentFilter.test.mjs): lastSeen stamping, the relative-date parser (retained
// utility), the exact-epoch since-filter, the summary line, the truncation
// signal, and the marker-visibility gate.
//
// Like those suites, there is no FE test runner in this repo, so this loads the
// REAL src/lib/whatsNew.ts (transpiled TS -> ESM via Vite's OXC transform) and
// exercises the pure helpers with plain objects. summarizeWhatsNew is ABSOLUTE:
// commits carry an exact %ct epoch (seconds) and `since` is epoch-ms, so the
// filter needs no wall-clock — the tests are deterministic by construction.
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
  WHATS_NEW_FETCH_LIMIT,
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

// A fixed wall-clock epoch (ms) — 2023-11-14T22:13:20Z. Used only as the anchor
// for the relative-date parser tests and to DERIVE commit epochs; the filter
// itself is absolute (epoch vs since), so this is just a stable timeline origin.
const NOW = 1_700_000_000_000;
// ms -> git %ct seconds helper, so commit epochs read as "N units before NOW".
const SEC = (msAgo) => Math.round((NOW - msAgo) / 1000);

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

console.log('\nparseRelativeDate: git %ar -> epoch (retained utility; relative to now)');
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

console.log('\nsummarizeWhatsNew: exact-epoch since-filter (the WARDEN-356 fix)');
// Commit fixtures carry the EXACT %ct epoch (seconds). `date` is the display-only
// %ar string — the filter never reads it. Epochs are "N units before NOW".
const commits = [
  { hash: 'a1', subject: 'old (before visit)', author: 'ann', date: '5 days ago', epoch: SEC(5 * 86_400_000) },
  { hash: 'b2', subject: 'new (after visit)', author: 'ann', date: '2 hours ago', epoch: SEC(2 * 3_600_000) },
  { hash: 'c3', subject: 'newer (after visit)', author: 'bob', date: '5 minutes ago', epoch: SEC(5 * 60_000) },
];
test('only commits whose epoch is at/after since count as new', () => {
  // visited 1 day ago: the 5-days-ago commit is older (not new); the two recent
  // ones (2h, 5m before NOW) are after the visit → new.
  const since = NOW - 86_400_000; // 1 day ago
  const s = summarizeWhatsNew({ commits, since });
  assert.equal(s.newCommits.length, 2);
  assert.deepEqual(s.newCommits.map((c) => c.hash), ['b2', 'c3']);
});
test('a commit older than since is excluded', () => {
  // since = 1 min ago. Every commit in `commits` is at least 5 min older than NOW,
  // so all predate the visit → none count as new — the marker must not fire on
  // stale history that predates the last visit.
  const since = NOW - 60_000;
  const s = summarizeWhatsNew({ commits, since });
  assert.equal(s.newCommits.length, 0);
});
test('REGRESSION: an already-seen commit NEVER re-flips to new as it ages', () => {
  // This is the exact false-positive the WARDEN-356 review caught. Under the old
  // %ar-based filter, a commit made 10 min BEFORE the visit would parse from
  // "1 hour ago" to an instant AFTER lastSeen once ~65 min elapsed (the relative
  // string drifts forward as the commit ages) — flickering the marker on for an
  // already-seen commit. With the EXACT %ct epoch, the commit's instant is fixed:
  // it was before the visit, so it is forever before the visit. Re-evaluating the
  // SAME summary any time later changes nothing (there is no wall-clock input).
  const visit = NOW;                       // the human looked at 10:00
  const commitEpoch = SEC(10 * 60_000);    // commit landed 10 min BEFORE the visit (09:50)
  const s = summarizeWhatsNew({
    commits: [{ hash: 'seen', subject: 'landed before visit', author: 'a', date: '10 minutes ago', epoch: commitEpoch }],
    since: visit,
  });
  assert.equal(s.newCommits.length, 0); // already seen → never new, no matter how much later
});
test('a commit landing the exact visit-second counts as new (>= not >)', () => {
  // The review's mirror-image concern: a genuinely-new commit must not be DROPPED
  // at the unit boundary. The comparison is `epoch*1000 >= since`, so a commit
  // whose epoch-second equals the visit instant is surfaced, not hidden.
  const visit = NOW;
  const s = summarizeWhatsNew({
    commits: [{ hash: 'edge', subject: 'same second as visit', author: 'a', date: 'now', epoch: Math.round(visit / 1000) }],
    since: visit,
  });
  assert.equal(s.newCommits.length, 1);
});
test('a commit MISSING an epoch is excluded (conservative-include rule RETIRED)', () => {
  // The old rule surfaced unparseable-%ar commits as new ("don't miss progress").
  // That cried wolf. The filter now requires a numeric epoch; a stale pre-%ct
  // cache entry (epoch undefined) can't be proven new → excluded, never a false
  // positive. The next fetch (seconds later) brings the epoch.
  const since = NOW - 86_400_000;
  const s = summarizeWhatsNew({
    commits: [
      { hash: 'x', subject: 'new', author: 'a', date: '2 hours ago', epoch: SEC(2 * 3_600_000) },
      { hash: 'y', subject: 'no epoch (stale cache)', author: 'a', date: '2 hours ago' }, // epoch missing
    ],
    since,
  });
  assert.equal(s.newCommits.length, 1);
  assert.deepEqual(s.newCommits.map((c) => c.hash), ['x']);
});
test('since=0 (never visited) lists no new commits even with recent ones', () => {
  // Without a visit there is no "since", so nothing is "new since". The marker
  // independently gates on since===null, but the summary must not pre-flag.
  const s = summarizeWhatsNew({ commits, since: 0 });
  assert.equal(s.newCommits.length, 0);
});
test('changedFileCount + stashCount pass through as current-state context', () => {
  const s = summarizeWhatsNew({ commits: [], since: NOW - 86_400_000, changedFileCount: 7, stashCount: 1 });
  assert.equal(s.changedFileCount, 7);
  assert.equal(s.stashCount, 1);
  assert.equal(s.newCommits.length, 0);
});
test('missing commits -> empty newCommits (no unseen-progress claim)', () => {
  const s = summarizeWhatsNew({ commits: undefined, since: NOW - 86_400_000 });
  assert.equal(s.newCommits.length, 0);
});

console.log('\ntruncation: the count never silently understates (WARDEN-356 review fix #2)');
const newCommit = (i) => ({ hash: String(i), subject: `new ${i}`, author: 'a', date: '1 hour ago', epoch: SEC(3_600_000) });
test('all-new fetch AT the cap (50) → truncated true', () => {
  // 50 commits fetched, all newer than the visit, fetchLimit default 50 → the
  // fetch hit its cap, so there COULD be a 51st new commit beyond the window.
  const commits50 = Array.from({ length: WHATS_NEW_FETCH_LIMIT }, (_, i) => newCommit(i));
  const s = summarizeWhatsNew({ commits: commits50, since: NOW - 86_400_000 });
  assert.equal(s.newCommits.length, WHATS_NEW_FETCH_LIMIT);
  assert.equal(s.truncated, true);
});
test('all-new fetch BELOW the cap (3) → truncated false (got them all)', () => {
  // Only 3 commits exist and all are new; 3 < fetchLimit, so the count is exact.
  const commits3 = Array.from({ length: 3 }, (_, i) => newCommit(i));
  const s = summarizeWhatsNew({ commits: commits3, since: NOW - 86_400_000 });
  assert.equal(s.newCommits.length, 3);
  assert.equal(s.truncated, false);
});
test('some-old fetch at the cap → truncated false (new/old boundary found)', () => {
  // 50 fetched, but only 8 are new (the rest predate the visit). The boundary
  // between new and old fell INSIDE the window, so the 8 is exact — no "+". This
  // is the common case: a handful of new commits atop older history.
  const old = { hash: 'old', subject: 'old', author: 'a', date: '5 days ago', epoch: SEC(5 * 86_400_000) };
  const commits50 = [
    ...Array.from({ length: 8 }, (_, i) => newCommit(i)),
    ...Array.from({ length: WHATS_NEW_FETCH_LIMIT - 8 }, () => old),
  ];
  const s = summarizeWhatsNew({ commits: commits50, since: NOW - 86_400_000 });
  assert.equal(s.newCommits.length, 8);
  assert.equal(s.truncated, false);
});
test('a smaller explicit fetchLimit is honored for truncation', () => {
  // A caller that fetched only 5 and got 5 all-new → truncated true at 5.
  const commits5 = Array.from({ length: 5 }, (_, i) => newCommit(i));
  const s = summarizeWhatsNew({ commits: commits5, since: NOW - 86_400_000, fetchLimit: 5 });
  assert.equal(s.newCommits.length, 5);
  assert.equal(s.truncated, true);
});

console.log('\nformatWhatsNewLine: one-glance summary (ticket example shape)');
test('"3 new commits · 7 changed files · 1 stash" — all segments', () => {
  const s = summarizeWhatsNew({
    commits: [
      { hash: '1', subject: 'a', author: '', date: '1 hour ago', epoch: SEC(3_600_000) },
      { hash: '2', subject: 'b', author: '', date: '1 hour ago', epoch: SEC(3_600_000) },
      { hash: '3', subject: 'c', author: '', date: '1 hour ago', epoch: SEC(3_600_000) },
    ],
    since: NOW - 86_400_000, changedFileCount: 7, stashCount: 1,
  });
  assert.equal(formatWhatsNewLine(s), '3 new commits · 7 changed files · 1 stash');
});
test('singular forms: "1 new commit · 1 changed file · 1 stash"', () => {
  const s = summarizeWhatsNew({
    commits: [{ hash: '1', subject: 'a', author: '', date: '1 hour ago', epoch: SEC(3_600_000) }],
    since: NOW - 86_400_000, changedFileCount: 1, stashCount: 1,
  });
  assert.equal(formatWhatsNewLine(s), '1 new commit · 1 changed file · 1 stash');
});
test('truncated count renders "N+" — "50+ new commits"', () => {
  // When the fetch was capped with all-new commits, the line says "50+" so the
  // one-glance summary never silently understates "what you missed".
  const commits50 = Array.from({ length: WHATS_NEW_FETCH_LIMIT }, (_, i) => newCommit(i));
  const s = summarizeWhatsNew({ commits: commits50, since: NOW - 86_400_000 });
  assert.equal(formatWhatsNewLine(s), `${WHATS_NEW_FETCH_LIMIT}+ new commits`);
});
test('plural stash: "2 stashes"', () => {
  const s = summarizeWhatsNew({ commits: [], since: NOW - 86_400_000, stashCount: 2 });
  assert.equal(formatWhatsNewLine(s), '2 stashes');
});
test('nothing new -> empty string (not "0 new commits …")', () => {
  const s = summarizeWhatsNew({ commits: [], since: NOW - 86_400_000 });
  assert.equal(formatWhatsNewLine(s), '');
});

console.log('\nhasUnreviewedProgress: the marker-visibility gate');
test('never visited (since null) -> no marker even with new commits', () => {
  const s = summarizeWhatsNew({ commits, since: 0 });
  assert.equal(hasUnreviewedProgress(null, s), false);
});
test('visited + commits landed since -> marker shows', () => {
  const since = NOW - 86_400_000;
  const s = summarizeWhatsNew({ commits, since });
  assert.equal(hasUnreviewedProgress(since, s), true);
});
test('visited + no new commits -> no marker', () => {
  const since = NOW - 60_000; // 1 min ago — none of `commits` are newer
  const s = summarizeWhatsNew({ commits, since });
  assert.equal(hasUnreviewedProgress(since, s), false);
});
test('current dirty/stash state alone does NOT trigger the marker', () => {
  // The ± / 🗄 badges own current-state; this marker is commits-since-visit only.
  const since = NOW - 60_000;
  const s = summarizeWhatsNew({ commits: [], since, changedFileCount: 9, stashCount: 3 });
  assert.equal(hasUnreviewedProgress(since, s), false);
});
test('a commit missing its epoch does NOT fire the marker (no crying wolf)', () => {
  // Retired-rule counterpart: an unparseable/missing-epoch commit is excluded,
  // so it must not light up the marker either. (The old behavior surfaced it.)
  const since = NOW - 86_400_000;
  const s = summarizeWhatsNew({
    commits: [{ hash: 'z', subject: 'no epoch', author: '', date: '2 hours ago' }],
    since,
  });
  assert.equal(s.newCommits.length, 0);
  assert.equal(hasUnreviewedProgress(since, s), false);
});

console.log(`\n✓ WHATS NEW TESTS PASS (${passed})`);
