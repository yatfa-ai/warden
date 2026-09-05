// Tests for the SERVER-STALL bounded aggregator + culprit-key mapping
// (WARDEN-1278, src/telemetry-stalls.cjs).
//
// Two things are on trial here, and they are not the same thing:
//
//   1. THE BOUNDS. Folding N stalls into one window must cost the same memory
//      at N = 3 and N = 3,000, and a pathological caller must not be able to
//      grow the key set. Asserted through the PUBLIC snapshot surface, never by
//      reaching into internals.
//
//   2. THE CLOSED-SET KEY GUARANTEE — the one that actually protects a user.
//      src/server.js labels every request `${req.method} ${requestLabelPath(
//      req.path)}`, and requestLabelPath only collapses unsafe characters and
//      truncates: an agent name, a chat name or a session id made of
//      `[A-Za-z0-9/._-]` survives VERBATIM into the span label. If a label could
//      become an aggregate key, that name would ride to the receiver. So every
//      label is projected onto a closed set first, and this suite tries to break
//      that projection with the shapes a real warden install produces.
//
// Loaded via createRequire — the module is a zero-dependency CJS sibling in src/
// (the discipline src/telemetry-consent.cjs and src/telemetry-metrics.cjs
// established), so it loads standalone with no transpile step.
//
// Auto-discovered by `npm run dev:test` (`node --test` in web/).
//
// Run: node --test web/telemetry-stalls.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_LAG_BOUNDARIES_MS,
  DEFAULT_MAX_CULPRITS,
  OVERFLOW_CULPRIT,
  UNATTRIBUTED_CULPRIT,
  SAFE_KEY_RE,
  culpritKey,
  createStallAggregator,
} = require('../src/telemetry-stalls.cjs');

// The exact shape src/loop-monitor.js's buildStallRecord produces.
const stallRecord = (lagMs, attribution = [], syncTotals = []) => ({
  type: 'performance-stall',
  runtime: 'server',
  source: 'event-loop',
  timestamp: new Date(0).toISOString(),
  lagMs,
  heartbeatMs: 1000,
  thresholdMs: 1000,
  attribution,
  syncTotals,
});

const culpritOf = (snapshot, key) => snapshot.culprits.find((c) => c.culprit === key);

// ==========================================================================
// (1) THE CLOSED-SET KEY GUARANTEE — user data can never become a key
// ==========================================================================

test('a request label carrying an AGENT NAME yields a route-pattern key, never the name', () => {
  // The exact shape server.js's middleware produces for a real request: the
  // agent name survives requestLabelPath untouched (it is all `[A-Za-z0-9-]`).
  const key = culpritKey('GET /api/chats/myproject-researcher');
  assert.equal(key, 'get-api-chats-id', 'the dynamic segment collapses to the id placeholder');
  assert.ok(!key.includes('myproject'), 'the agent name is nowhere in the key');
  assert.ok(!key.includes('researcher'), 'the agent name is nowhere in the key');
});

test('every dynamic-segment shape a real install produces collapses to `id`', () => {
  for (const [label, expected] of [
    ['GET /api/sessions/abc-123', 'get-api-sessions-id'],
    ['DELETE /api/sessions/7f3a2b1c', 'delete-api-sessions-id'],
    ['PATCH /api/collections/42', 'patch-api-collections-id'],
    ['GET /api/collections/42/agents', 'get-api-collections-id-agents'],
    // A chat title that happens to look like a route word is STILL collapsed —
    // membership in the closed set is the test, not shape.
    ['GET /api/chats/refactor-auth', 'get-api-chats-id'],
    // A static route maps to its own literal pattern (the useful case).
    ['GET /api/health', 'get-api-health'],
    ['POST /api/file-exists', 'post-api-file-exists'],
    ['GET /api/diagnostics/stalls', 'get-api-diagnostics-stalls'],
  ]) {
    assert.equal(culpritKey(label), expected, `${label} → ${expected}`);
  }
});

test('a label carrying a PATH, a HOSTNAME, or an EMAIL never yields a key derived from it', () => {
  // The hard exclusions (WARDEN-443). Each of these is a shape a badly-behaved
  // caller or a future route could put in a span label; none may leave here as
  // anything but a closed-set key.
  for (const hostile of [
    'GET /api/read-file/home/alice/.ssh/id_rsa',
    'GET /api/chats/prod-db-01.corp.local',
    'GET /api/chats/alice@example.com',
    'GET /~/warden/config.json',
    'GET /api/search-files/Users/bob/Documents/secrets.txt',
  ]) {
    const key = culpritKey(hostile);
    assert.ok(SAFE_KEY_RE.test(key), `${hostile} yields a wire-safe key, got ${JSON.stringify(key)}`);
    for (const leak of ['alice', 'bob', 'corp', 'local', 'ssh', 'secrets', 'rsa', 'example']) {
      assert.ok(!key.includes(leak), `${hostile} → ${key} must not contain ${leak}`);
    }
  }
});

test('sync-io labels map to their closed-set kebab keys (the dot never reaches the wire)', () => {
  assert.equal(culpritKey('fs.readFileSync'), 'fs-read-file-sync');
  assert.equal(culpritKey('fs.statSync'), 'fs-stat-sync');
  assert.equal(culpritKey('child_process.spawnSync'), 'child-process-spawn-sync');
  // A dot in a key would read as a hostname to a naive scanner, and the schema
  // validator rejects one outright — so the mapping must remove it, not pass it.
  for (const label of ['fs.readFileSync', 'child_process.execSync']) {
    assert.ok(!culpritKey(label).includes('.'), `${label} yields a dot-free key`);
  }
});

test('scoped sweep / websocket labels map only when BOTH halves are known literals', () => {
  assert.equal(culpritKey('sweep:budget'), 'sweep-budget');
  assert.equal(culpritKey('sweep:lifecycle'), 'sweep-lifecycle');
  assert.equal(culpritKey('sweep:pane-delta'), 'sweep-pane-delta');
  assert.equal(culpritKey('ws:pane-monitor'), 'ws-pane-monitor');
  // A scope we do not recognize, or a name we do not recognize, FOLDS. Losing
  // the distinction is the acceptable cost; passing through a dynamic name is
  // not. `sweep:attention` is the live proof of the NAME half: it was a known
  // literal until WARDEN-1274 retired the attention sweep, and dropping it from
  // SCOPED_LABEL_NAMES is what makes it fold — a known scope is not enough.
  assert.equal(culpritKey('sweep:attention'), OVERFLOW_CULPRIT);
  assert.equal(culpritKey('sweep:whatever-new'), OVERFLOW_CULPRIT);
  assert.equal(culpritKey('chat:myproject-researcher'), OVERFLOW_CULPRIT);
});

test('a BARE label folds unless it is a known literal — a bare string is the leak shape', () => {
  assert.equal(culpritKey('unknown'), 'unknown', "loop-monitor's own fallback is a known literal");
  // These are all `SAFE_KEY_RE`-clean, so a shape-only rule would pass them —
  // and each is a plausible agent/chat name. Membership is what stops them.
  for (const bare of ['myproject-researcher', 'refactor-auth', 'alice', 'prod-01']) {
    assert.equal(culpritKey(bare), OVERFLOW_CULPRIT, `${bare} folds`);
  }
});

test('degenerate labels fold rather than throw', () => {
  for (const bad of [undefined, null, 42, '', {}, [], 'x'.repeat(500)]) {
    const key = culpritKey(bad);
    assert.equal(key, OVERFLOW_CULPRIT, `${JSON.stringify(bad)} folds`);
  }
});

test('the LIVE route-segment set is honored, and an unknown segment folds to `id`', () => {
  // server.js derives the set from the express router so the mapping cannot
  // drift from the real route table. A segment outside the injected set is `id`,
  // whatever it looks like.
  const live = new Set(['api', 'health']);
  assert.equal(culpritKey('GET /api/health', live), 'get-api-health');
  assert.equal(culpritKey('GET /api/chats', live), 'get-api-id', 'chats is not in THIS set');
});

test('EVERY producible key SURVIVES the real redaction engine untouched', () => {
  // THE HAZARD THIS PINS, which is not obvious and would fail SILENTLY.
  // electron/telemetry-redact.cjs's generic high-entropy rule replaces any run of
  // >=20 characters from the secret charset mixing >=2 of {lower, upper, digit}
  // with `[REDACTED:secret]`. A key like `get-api-oauth2-callback-id` is 26 chars
  // of lowercase AND digits: it matches, redaction rewrites it, the rewritten key
  // then FAILS the schema's culprit pattern, and the pipeline's validator drops
  // THE ENTIRE EVENT. A whole window would vanish, and the cause would be a route
  // segment someone added months earlier.
  //
  // The producer's key alphabet is therefore letters + hyphens ONLY — one
  // character class, so the entropy rule can never fire whatever the length.
  // This asserts it against the REAL redactor rather than reasoning about it.
  const { redact } = require('../electron/telemetry-redact.cjs');
  const consent = { incidents: true };
  const segments = new Set(['api', 'oauth2', 'callback', 'claude-sessions', 'collections', 'agents', 'file-exists']);
  const labels = [
    'GET /api/oauth2/callback', // the digit-bearing trap
    'GET /api/claude-sessions',
    'GET /api/collections/42/agents',
    'POST /api/file-exists',
    'fs.readFileSync', 'child_process.spawnSync',
    'sweep:pane-delta', 'ws:pane-monitor', 'unknown',
  ];
  for (const label of labels) {
    const key = culpritKey(label, segments);
    const out = redact({ culprits: [{ culprit: key, count: 1, totalOverlapMs: 1 }] }, { consent });
    assert.equal(out.culprits[0].culprit, key,
      `${label} → ${key} must survive redaction byte-identically (a mangled key drops the whole event)`);
  }
});

test('a digit-bearing route segment folds to `id` — a lost distinction, not a lost event', () => {
  // The cost of the letters-only alphabet, stated explicitly so it reads as a
  // deliberate trade rather than a bug: resolution is cheap, the event is not.
  const segments = new Set(['api', 'oauth2', 'v2', 'callback']);
  assert.equal(culpritKey('GET /api/oauth2/callback', segments), 'get-api-id-callback');
  assert.equal(culpritKey('GET /api/v2/callback', segments), 'get-api-id-callback');
});

test('EVERY key the mapper can produce satisfies the wire contract (fuzz over hostile labels)', () => {
  // The invariant the schema validator independently enforces, asserted at the
  // producer so a mapping bug fails here rather than as a silently dropped event.
  const verbs = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'get', 'Ω'];
  const paths = [
    '/', '//', '/api', '/api/', '/api/sessions/../../etc/passwd',
    '/api/chats/a b c', '/api/chats/%2e%2e', '/api/chats/' + 'x'.repeat(200),
    '/api/chats/UPPER', '/api/chats/under_score', '/api/chats/1.2.3.4',
  ];
  for (const v of verbs) {
    for (const p of paths) {
      const key = culpritKey(`${v} ${p}`);
      assert.ok(SAFE_KEY_RE.test(key), `${v} ${p} → ${JSON.stringify(key)} must be wire-safe`);
    }
  }
});

// ==========================================================================
// (2) THE FOLD — one aggregate per window, not one row per stall
// ==========================================================================

test('N stalls fold into ONE window carrying count / totalMs / maxMs', () => {
  const agg = createStallAggregator({ now: () => 1000 });
  agg.record(stallRecord(1500, [{ label: 'GET /api/health', overlapMs: 1400 }]));
  agg.record(stallRecord(3000, [{ label: 'GET /api/health', overlapMs: 2900 }]));
  agg.record(stallRecord(5200, [{ label: 'sweep:budget', overlapMs: 5000 }]));
  const s = agg.snapshot();
  assert.equal(s.count, 3, 'three stalls, ONE window');
  assert.equal(s.totalMs, 9700);
  assert.equal(s.maxMs, 5200, 'the headline freeze duration');
});

test('the lag histogram uses FIXED boundaries (first boundary the lag is <= to)', () => {
  const agg = createStallAggregator({ buckets: [1000, 2000, 5000], now: () => 0 });
  for (const lag of [1000, 1000.1, 2000, 4999, 5000, 5000.1, 60000]) {
    agg.record(stallRecord(lag));
  }
  const s = agg.snapshot();
  assert.equal(s.buckets.length, s.boundaries.length + 1, 'buckets = boundaries + 1 overflow');
  assert.deepEqual(s.buckets, [1, 2, 2, 2],
    '<=1000: 1000 | <=2000: 1000.1+2000 | <=5000: 4999+5000 | over: 5000.1+60000');
  assert.equal(s.buckets.reduce((a, b) => a + b, 0), s.count, 'every stall lands in exactly one bucket');
});

test('MEMORY IS INDEPENDENT OF N — 3 stalls and 3,000 produce the same shape', () => {
  const shapeOf = (n) => {
    const agg = createStallAggregator({ now: () => 0 });
    for (let i = 0; i < n; i += 1) {
      agg.record(stallRecord(1500, [{ label: 'GET /api/health', overlapMs: 1400 }]));
    }
    const s = agg.snapshot();
    return { buckets: s.buckets.length, culprits: s.culprits.length };
  };
  assert.deepEqual(shapeOf(3), shapeOf(3000), 'the footprint does not grow with observations');
});

test('the default lag boundaries start where a stall starts (>1s, the monitor threshold)', () => {
  assert.equal(DEFAULT_LAG_BOUNDARIES_MS[0], 1000);
  const agg = createStallAggregator();
  assert.deepEqual(agg.boundaries, [...DEFAULT_LAG_BOUNDARIES_MS]);
});

// ==========================================================================
// (3) THE BOUNDS — a pathological caller cannot grow the key set
// ==========================================================================

test('distinct culprit keys are CAPPED, with the excess folded (never dropped)', () => {
  const agg = createStallAggregator({ maxCulprits: 3, now: () => 0 });
  // Ten distinct STATIC routes — each maps to its own real key, so this is the
  // cap doing the work, not the closed-set mapping.
  const routes = ['health', 'chats', 'budget', 'pins', 'discover', 'activity', 'directives', 'sessions', 'collections', 'config'];
  for (const r of routes) {
    agg.record(stallRecord(1500, [{ label: `GET /api/${r}`, overlapMs: 100 }]));
  }
  const s = agg.snapshot();
  assert.ok(s.culprits.length <= 4, `at most maxCulprits + overflow, got ${s.culprits.length}`);
  const overflow = culpritOf(s, OVERFLOW_CULPRIT);
  assert.ok(overflow, 'the excess folded into the reserved key');
  const totalCount = s.culprits.reduce((a, c) => a + c.count, 0);
  assert.equal(totalCount, routes.length, 'every attribution is accounted for — none was dropped');
});

test('the reserved overflow key is NOT claimable by a caller', () => {
  const agg = createStallAggregator({ maxCulprits: 1, now: () => 0 });
  agg.record(stallRecord(1500, [{ label: 'GET /api/health', overlapMs: 10 }]));
  // 'other' arrives as a bare label; it must fold into the reserved bucket
  // rather than occupying a cap slot of its own.
  agg.record(stallRecord(1500, [{ label: OVERFLOW_CULPRIT, overlapMs: 20 }]));
  const s = agg.snapshot();
  assert.ok(s.culprits.length <= 2);
  assert.equal(culpritOf(s, OVERFLOW_CULPRIT).count, 1);
});

test('an over-long key is REJECTED into the overflow bucket, never TRUNCATED', () => {
  // Truncation would be worse than folding: a truncated key is a silently WRONG
  // aggregate AND a partial string from wherever the length came from.
  const agg = createStallAggregator({ maxNameLength: 8, now: () => 0 });
  agg.record(stallRecord(1500, [{ label: 'GET /api/collections/42/agents', overlapMs: 100 }]));
  const s = agg.snapshot();
  assert.equal(s.culprits.length, 1);
  assert.equal(s.culprits[0].culprit, OVERFLOW_CULPRIT);
  for (const c of s.culprits) {
    assert.ok(c.culprit.length <= 8, 'no key exceeds the cap');
    assert.ok(!c.culprit.startsWith('get-api-c'), 'and none is a truncated prefix of the real key');
  }
});

test('the default cap is the documented one', () => {
  assert.equal(createStallAggregator().maxCulprits, DEFAULT_MAX_CULPRITS);
});

// ==========================================================================
// (4) ATTRIBUTION — the fold keeps the signal, including the sync aggregate
// ==========================================================================

test('per-culprit counts and overlap totals accumulate across stalls', () => {
  const agg = createStallAggregator({ now: () => 0 });
  agg.record(stallRecord(2000, [{ label: 'GET /api/claude-sessions', overlapMs: 1900 }]));
  agg.record(stallRecord(3000, [{ label: 'GET /api/claude-sessions', overlapMs: 2800 }]));
  const c = culpritOf(agg.snapshot(), 'get-api-claude-sessions');
  assert.equal(c.count, 2);
  assert.equal(c.totalOverlapMs, 4700);
});

test('the SYNC aggregate is folded too — the death-by-a-thousand-statSync shape', () => {
  // WARDEN-977's whole reason for summarizeSyncTotals: 4,000 calls of 2ms each
  // take no span slot and would report ZERO sync culprits, reading as
  // "synchronous I/O was not involved". A window that lost that would be
  // strictly worse than a bare duration.
  const agg = createStallAggregator({ now: () => 0 });
  agg.record(stallRecord(8000,
    [{ label: 'GET /api/claude-sessions', overlapMs: 7900 }],
    [{ label: 'fs.statSync', calls: 4012, totalMs: 7901 }]));
  const s = agg.snapshot();
  const sync = culpritOf(s, 'fs-stat-sync');
  assert.ok(sync, 'the sync total is attributed');
  assert.equal(sync.totalOverlapMs, 7901, 'its blocking time is the overlap it contributed');
  // And it OUTRANKS the enclosing request span in the ranked list, because it
  // cost MORE (7901ms of blocking inside a 7900ms span) — which is exactly the
  // reading that names the real culprit instead of the route it happened under.
  assert.equal(s.culprits[0].culprit, 'fs-stat-sync');
  assert.equal(s.culprits[1].culprit, 'get-api-claude-sessions');
});

test('a stall with NO attribution folds into `unattributed`, not into nothing', () => {
  // "Nothing we measure was running" is the most interesting reading in the set
  // — it means the block was somewhere we do not instrument. Dropping it would
  // make the counts disagree with the culprit map.
  const agg = createStallAggregator({ now: () => 0 });
  agg.record(stallRecord(4000));
  const s = agg.snapshot();
  assert.equal(s.count, 1);
  assert.equal(culpritOf(s, UNATTRIBUTED_CULPRIT).count, 1);
  assert.equal(culpritOf(s, UNATTRIBUTED_CULPRIT).totalOverlapMs, 4000);
});

test('culprits are ranked costliest-first, deterministically', () => {
  const agg = createStallAggregator({ now: () => 0 });
  agg.record(stallRecord(5000, [
    { label: 'GET /api/health', overlapMs: 10 },
    { label: 'sweep:budget', overlapMs: 4000 },
    { label: 'GET /api/chats', overlapMs: 900 },
  ]));
  const s = agg.snapshot();
  assert.deepEqual(s.culprits.map((c) => c.culprit), ['sweep-budget', 'get-api-chats', 'get-api-health']);
  // Two equal windows produce equal snapshots — a test can assert on the order.
  assert.deepEqual(agg.snapshot(), s);
});

// ==========================================================================
// (5) REJECTION + WINDOWING
// ==========================================================================

test('degenerate records are REJECTED and counted, never thrown', () => {
  // A diagnostic must never be able to take down the process it observes.
  const agg = createStallAggregator({ now: () => 0 });
  for (const bad of [null, undefined, 42, 'stall', {}, { lagMs: -1 }, { lagMs: NaN }, { lagMs: 'lots' }]) {
    assert.equal(agg.record(bad), false, `${JSON.stringify(bad)} rejected`);
  }
  const s = agg.snapshot();
  assert.equal(s.count, 0, 'nothing was folded');
  assert.equal(s.rejected, 8, 'and every refusal was counted');
});

test('a malformed attribution ENTRY is skipped without poisoning the window', () => {
  const agg = createStallAggregator({ now: () => 0 });
  agg.record(stallRecord(2000, [
    null,
    'not-an-object',
    { label: 'GET /api/health', overlapMs: 'lots' }, // bad overlap → folds as 0
    { label: 'GET /api/health', overlapMs: 1900 },
  ]));
  const s = agg.snapshot();
  assert.equal(s.count, 1);
  assert.equal(culpritOf(s, 'get-api-health').count, 2, 'both well-shaped entries folded');
  assert.equal(culpritOf(s, 'get-api-health').totalOverlapMs, 1900, 'the unusable overlap counted 0');
});

test('flush() closes the window and starts an empty one — no double-counting', () => {
  let t = 1000;
  const agg = createStallAggregator({ now: () => t });
  agg.record(stallRecord(1500, [{ label: 'GET /api/health', overlapMs: 100 }]));
  t = 2000;
  const first = agg.flush();
  assert.equal(first.count, 1);
  assert.equal(first.startedAt, 1000);
  assert.equal(first.endedAt, 2000);

  const second = agg.snapshot();
  assert.equal(second.count, 0, 'the new window is empty');
  assert.equal(second.totalMs, 0);
  assert.equal(second.maxMs, 0);
  assert.deepEqual(second.culprits, []);
  assert.equal(second.startedAt, 2000, 'the next window starts where the last ended');

  // The returned snapshot is DETACHED — a later record cannot mutate it.
  agg.record(stallRecord(9000));
  assert.equal(first.count, 1, 'the flushed window is unaffected by later records');
});

test('invalid FACTORY options throw at wire-up (a programming error, not a measurement)', () => {
  assert.throws(() => createStallAggregator({ buckets: [] }), TypeError);
  assert.throws(() => createStallAggregator({ buckets: [2000, 1000] }), TypeError);
  assert.throws(() => createStallAggregator({ buckets: [0] }), TypeError);
  assert.throws(() => createStallAggregator({ maxCulprits: 0 }), TypeError);
  assert.throws(() => createStallAggregator({ maxNameLength: 1.5 }), TypeError);
  assert.throws(() => createStallAggregator({ now: 'clock' }), TypeError);
  assert.throws(() => createStallAggregator({ knownSegments: 'routes' }), TypeError);
});

test('a knownSegments THUNK is resolved lazily and survives a throwing one', () => {
  // server.js passes a thunk because the express route table is only complete
  // after the last app.get() — resolving at wire-up would capture a partial one.
  let calls = 0;
  const agg = createStallAggregator({
    now: () => 0,
    knownSegments: () => { calls += 1; return new Set(['api', 'health']); },
  });
  assert.equal(calls, 0, 'not resolved at construction');
  agg.record(stallRecord(1500, [{ label: 'GET /api/health', overlapMs: 1 }]));
  assert.equal(calls, 1, 'resolved on first use');
  agg.record(stallRecord(1500, [{ label: 'GET /api/health', overlapMs: 1 }]));
  assert.equal(calls, 1, 'and memoized');
  assert.ok(culpritOf(agg.snapshot(), 'get-api-health'));

  // A thunk that throws costs RESOLUTION, never SAFETY: the fallback set still
  // folds every unknown segment to `id`.
  const broken = createStallAggregator({ now: () => 0, knownSegments: () => { throw new Error('no router'); } });
  broken.record(stallRecord(1500, [{ label: 'GET /api/chats/myproject-researcher', overlapMs: 1 }]));
  const key = broken.snapshot().culprits[0].culprit;
  assert.ok(SAFE_KEY_RE.test(key), 'still a wire-safe key');
  assert.ok(!key.includes('myproject'), 'and still no user data in it');
});
