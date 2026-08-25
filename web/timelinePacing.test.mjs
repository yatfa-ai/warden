// Pure tests for the live Activity Timeline's cadence + visibility decisions.
//
// Like diff.test.mjs, there is no FE test runner in this repo, so this loads
// the REAL src/lib/timelinePacing.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises the pure helpers that drive useLiveTimeline's
// polling gate, its "refresh-on-focus" behavior, and the "Updated Ns ago"
// affordance. The hook delegates to these — so this guards the live/pause/
// hidden behavior without a browser.
//
// Run: node timelinePacing.test.mjs   (or: npm test, from web/)

// --- Pin the zone BEFORE anything constructs a Date or imports the module ----
//
// `dayBucket` compares calendar days via `toDateString()`, which is LOCAL time,
// so its DST-boundary behavior is only observable in a zone that observes DST.
// Run under UTC (as CI may) and the spring-forward / fall-back cases below
// degrade into ordinary days that pass no matter what the helper does. We pin
// the zone rather than writing zone-agnostic assertions because the whole point
// of those cases is a 23h/25h calendar day, which a zone-agnostic test cannot
// produce. Node re-reads TZ on the next Date operation, so this only has to
// beat the first one. It does: ESM `import` declarations are HOISTED and run
// before any statement here, but none of them constructs a Date, and the
// module under test is pulled in by a DYNAMIC import further down — which
// runs after this line, not before it. (Verified: with TZ set here, dates
// below report EDT/EST rather than UTC.)
process.env.TZ = 'America/New_York';

import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pacingPath = resolve(__dirname, 'src/lib/timelinePacing.ts');

// --- Load the REAL timelinePacing.ts (TS -> ESM via the OXC transform) -------
const src = readFileSync(pacingPath, 'utf8');
const { code } = await transformWithOxc(src, pacingPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-timeline-test-'));
const tmpFile = join(tmpDir, 'timelinePacing.mjs');
writeFileSync(tmpFile, code);
const {
  shouldPoll,
  shouldRefreshOnVisibility,
  formatUpdatedAgo,
  POLL_INTERVAL_MS,
  sortedFilterOptions,
  dayBucket,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nshouldPoll: polling runs only while Live AND visible');
test('Live + visible -> poll', () => {
  assert.equal(shouldPoll(true, true), true);
});
test('Live + hidden -> NO poll (paused while tab hidden)', () => {
  assert.equal(shouldPoll(true, false), false);
});
test('Paused + visible -> NO poll (user froze the feed)', () => {
  assert.equal(shouldPoll(false, true), false);
});
test('Paused + hidden -> NO poll', () => {
  assert.equal(shouldPoll(false, false), false);
});

console.log('\nshouldRefreshOnVisibility: immediate refresh only on hidden->visible while Live');
test('hidden -> visible while Live refreshes immediately', () => {
  assert.equal(shouldRefreshOnVisibility(true, false, true), true);
});
test('visible -> hidden does NOT refresh', () => {
  assert.equal(shouldRefreshOnVisibility(false, true, true), false);
});
test('hidden -> visible while Paused does NOT refresh', () => {
  assert.equal(shouldRefreshOnVisibility(true, false, false), false);
});
test('already visible (no transition) does NOT refresh', () => {
  assert.equal(shouldRefreshOnVisibility(false, false, true), false);
});

console.log('\nformatUpdatedAgo: relative labels from explicit `now` (no clock)');
test('null lastUpdated -> null', () => {
  assert.equal(formatUpdatedAgo(1_000_000, null), null);
});
test('0s diff -> "just now"', () => {
  const now = 1_000_000;
  assert.equal(formatUpdatedAgo(now, now), 'just now');
});
test('under 60s -> "Ns ago"', () => {
  assert.equal(formatUpdatedAgo(1_000_000, 1_000_000 - 30_000), '30s ago');
});
test('under 60m -> "Nm ago"', () => {
  assert.equal(formatUpdatedAgo(1_000_000, 1_000_000 - 125_000), '2m ago');
});
test('hours -> "Nh ago"', () => {
  assert.equal(formatUpdatedAgo(1_000_000, 1_000_000 - 3 * 3600_000), '3h ago');
});
test('negative diff (clock skew) clamps to "just now", not negative/NaN', () => {
  assert.equal(formatUpdatedAgo(1_000_000, 1_000_000 + 5_000), 'just now');
});

console.log('\nthe cadence is the ~15s live interval (not seconds, not minutes)');
test('POLL_INTERVAL_MS is 15000 (15s)', () => {
  assert.equal(POLL_INTERVAL_MS, 15_000);
});

console.log('\nsortedFilterOptions: stable filter-menu order from a newest-first feed');
test('dedupes repeated values (one option per distinct value)', () => {
  assert.deepEqual(sortedFilterOptions(['alpha', 'zeta', 'alpha', 'zeta', 'alpha']), ['alpha', 'zeta']);
});
test('drops falsy values — undefined/null/empty are not selectable options', () => {
  assert.deepEqual(
    sortedFilterOptions(['zeta', undefined, 'alpha', null, '', 'zeta']),
    ['alpha', 'zeta'],
  );
});
test('sorts by localeCompare, NOT by feed insertion order', () => {
  // Input is newest-first (the order both feeds arrive in); output is alphabetical.
  assert.deepEqual(sortedFilterOptions(['zeta', 'alpha', 'Mid']), ['alpha', 'Mid', 'zeta']);
});
test('empty input -> []', () => {
  assert.deepEqual(sortedFilterOptions([]), []);
});
test('all-falsy input -> []', () => {
  assert.deepEqual(sortedFilterOptions([undefined, null, '']), []);
});
test('THE BUG: a newly-active host does not reorder the menu across a poll', () => {
  // Poll 1: alpha was most recently active, so the newest-first feed leads with it.
  const poll1 = sortedFilterOptions(['alpha', 'zeta']);
  // Poll 2: zeta emits an event and jumps to the head of the same feed.
  const poll2 = sortedFilterOptions(['zeta', 'alpha']);
  // The menu the user is reaching for must be identical across the two polls.
  assert.deepEqual(poll1, poll2);
  assert.deepEqual(poll2, ['alpha', 'zeta']);
});
test('the option SET is preserved — same values as a plain dedupe+falsy-drop', () => {
  const raw = ['zeta', undefined, 'alpha', 'zeta', '', 'mid', null];
  const today = Array.from(new Set(raw.filter(Boolean)));
  assert.deepEqual([...sortedFilterOptions(raw)].sort(), [...today].sort());
});
test('does not mutate the caller\'s array', () => {
  const input = ['zeta', 'alpha'];
  sortedFilterOptions(input);
  assert.deepEqual(input, ['zeta', 'alpha']);
});

// --- dayBucket: group headers are CALENDAR-correct, not elapsed-time guesses -
//
// `Today`/`Yesterday` are calendar-day claims; the two Observer feeds used to
// assign them from elapsed ms alone, so they were wrong for an ordinary
// fraction of rows every night. `now` is a parameter, so every case below pins
// a fixed wall-clock pair with NO time mocking. Dates are built with the local
// Date constructor because `toDateString()` — the comparison formatAbsolute
// uses, and therefore the one dayBucket must match — is local-time.
const at = (day, h, m = 0) => new Date(2026, 7, day, h, m).getTime();
const MON = 24, SUN = 23, SAT = 22; // Aug 2026: 22nd = Sat, 23rd = Sun, 24th = Mon

console.log('\ndayBucket: headers follow the calendar, not the stopwatch');
test('THE BUG #1: Mon 09:00, a Sun 14:00 event (19h) is Yesterday — not Today', () => {
  assert.equal(dayBucket(at(SUN, 14), at(MON, 9)), 'Yesterday');
});
test('THE BUG #2: Mon 00:30, a Sun 21:00 event (3.5h) is Yesterday — not Today', () => {
  // The worst window: the real "today" is 30 min old, but the old 24h-wide
  // `Today` bucket swallowed nearly all of yesterday.
  assert.equal(dayBucket(at(SUN, 21), at(MON, 0, 30)), 'Yesterday');
});
test('THE BUG #3: Mon 09:00, a Sat 10:00 event (47h) is This week — not Yesterday', () => {
  assert.equal(dayBucket(at(SAT, 10), at(MON, 9)), 'This week');
});
test('Last hour BEATS Yesterday: a 23:30 -> 00:15 event (35 min) reads Last hour', () => {
  // Crossed the day boundary, so it is calendar-yesterday — but the elapsed
  // check runs first, because "35 minutes ago" is the more useful truth.
  assert.equal(dayBucket(at(SUN, 23, 30), at(MON, 0, 15)), 'Last hour');
});
test('same calendar day, >1h old -> Today', () => {
  assert.equal(dayBucket(at(MON, 2), at(MON, 9)), 'Today');
});
test('<1h old on the same day -> Last hour (not Today)', () => {
  assert.equal(dayBucket(at(MON, 8, 30), at(MON, 9)), 'Last hour');
});
test('the 24h/48h thresholds do not decide: 19h reads Yesterday, 22h reads Today', () => {
  // Same bucket boundary, opposite verdicts — decided by the day boundary
  // between them, which is precisely what an elapsed-ms ladder cannot see.
  assert.equal(dayBucket(at(SUN, 14), at(MON, 9)), 'Yesterday'); // 19h, crossed midnight
  assert.equal(dayBucket(at(MON, 1), at(MON, 23)), 'Today'); // 22h, same day
});
test('beyond a week -> Older', () => {
  assert.equal(dayBucket(at(MON, 9) - 8 * 24 * 60 * 60 * 1000, at(MON, 9)), 'Older');
});

// --- DST: a calendar day is not always 24 hours long ------------------------
//
// The regression these pin: deriving yesterday as `now - 24h` lands on the
// WRONG calendar day around a DST transition, because a local day is 23h on
// spring-forward and 25h on fall-back. That is the same elapsed-ms-vs-
// wall-clock confusion the helper exists to remove, so it must not survive
// inside the fix. These only exercise the bug in a DST-observing zone — see
// the TZ pin at the top of this file; under TZ=UTC they degrade to ordinary
// days and pass vacuously.
//
// America/New_York 2026: spring forward Sun Mar 8, fall back Sun Nov 1.
const dst = (mon, day, h, m = 0) => new Date(2026, mon, day, h, m).getTime();

console.log('\ndayBucket: DST — a calendar day is not always 24h');
test('spring forward: Mon 00:00, a Sun 21:00 event (3h) is Yesterday — not This week', () => {
  // The 23h day: `now - 24h` overshoots past Sunday into Saturday, so the old
  // arithmetic filed a THREE-HOUR-OLD event under `This week` — a worse
  // misfile than the bug this PR set out to fix.
  assert.equal(dayBucket(dst(2, 8, 21), dst(2, 9, 0)), 'Yesterday');
});
test('spring forward: Mon 00:00, a Sun 05:00 event (19h) is Yesterday — not This week', () => {
  assert.equal(dayBucket(dst(2, 8, 5), dst(2, 9, 0)), 'Yesterday');
});
test('spring forward: Mon 00:00, a Sat 21:00 event (26h) is This week — not Yesterday', () => {
  // The mirror image: the overshoot made Saturday look like "yesterday".
  assert.equal(dayBucket(dst(2, 7, 21), dst(2, 9, 0)), 'This week');
});
test('fall back: Sun 23:00, a Sat 22:00 event (26h) is Yesterday — not This week', () => {
  // The 25h day: 26h elapsed is still calendar-yesterday, and `now - 24h`
  // undershoots — it lands back on Sunday, so Saturday matched nothing.
  assert.equal(dayBucket(dst(9, 31, 22), dst(10, 1, 23)), 'Yesterday');
});
test('the transition does not disturb an ordinary day in the same zone', () => {
  // Control: the August cases above already cover this, but assert it beside
  // the DST pairs so a failure here separates "zone is wrong" from "DST math
  // is wrong".
  assert.equal(dayBucket(dst(7, 23, 14), dst(7, 24, 9)), 'Yesterday');
});
test('the header can never contradict the row\'s own absolute timestamp', () => {
  // formatAbsolute (lib/formatTimestamp.ts) decides "is this today?" by
  // toDateString() equality. dayBucket must agree, or a row renders under a
  // `Today` heading while its own timestamp reads a past date — the exact
  // on-screen self-contradiction this fix removes.
  //
  // Both directions are asserted for BOTH day buckets, and the reverse
  // direction is the one with teeth: "claimed X => X is true" is satisfied by
  // a helper that simply never claims X, so it cannot catch a bucket that
  // WRONGLY escapes to `This week`. That is exactly how the DST defect hid.
  // The previous day is derived by calendar arithmetic here (never `now-24h`),
  // so this oracle is independent of the implementation it is checking.
  const prevDayOf = (t) => {
    const d = new Date(t);
    d.setDate(d.getDate() - 1);
    return d.toDateString();
  };
  const oneHourMs = 60 * 60 * 1000;

  // Ordinary days plus both DST transitions, so the invariant is enforced
  // across the boundaries where the day is 23h/25h long.
  for (const now of [at(MON, 9), at(MON, 0, 30), dst(2, 9, 0), dst(10, 1, 23)]) {
    const probes = [-2, -5, -14, -19, -22, -26, -30, -47].map((h) => now + h * oneHourMs);
    for (const ts of probes) {
      const bucket = dayBucket(ts, now);
      const sameCalendarDay = new Date(ts).toDateString() === new Date(now).toDateString();
      const isPrevCalendarDay = new Date(ts).toDateString() === prevDayOf(now);
      const withinLastHour = now - ts < oneHourMs;

      // Forward: a claim must be true.
      if (bucket === 'Today') assert.equal(sameCalendarDay, true, `"Today" claimed for a past date`);
      if (bucket === 'Yesterday') {
        assert.equal(isPrevCalendarDay, true, `"Yesterday" claimed for a day that is not yesterday`);
      }
      // Reverse: a true day must be claimed, not allowed to fall through to
      // an elapsed-time bucket. `Last hour` legitimately outranks both.
      if (sameCalendarDay && !withinLastHour) {
        assert.equal(bucket, 'Today', `same-day row filed under "${bucket}"`);
      }
      if (isPrevCalendarDay && !withinLastHour) {
        assert.equal(bucket, 'Yesterday', `previous-day row filed under "${bucket}"`);
      }
    }
  }
});
test('both feeds bucket identically — one shared helper, called with one clock', () => {
  // ActivityTimeline and DirectiveHistory now both call THIS function with
  // their 1s-ticking `now`, so identical input cannot produce two answers.
  const now = at(MON, 9);
  const rows = [at(MON, 2), at(SUN, 14), at(SAT, 10)];
  assert.deepEqual(rows.map((t) => dayBucket(t, now)), rows.map((t) => dayBucket(t, now)));
  assert.deepEqual(rows.map((t) => dayBucket(t, now)), ['Today', 'Yesterday', 'This week']);
});

console.log(`\n✓ TIMELINE PACING TESTS PASS (${passed})`);
