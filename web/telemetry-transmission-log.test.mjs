// Unit tests for the local transmission log of ACTUAL send outcomes (WARDEN-583,
// slice 7 of the optional off-by-default telemetry client — roadmap WARDEN-446).
//
// This is verifiability's THIRD leg: a metadata-only record of what the client
// ACTUALLY transmitted, closing the preview→actual gap. describeCollection is the
// promise, previewPayload is the preview; this log is the actual-send truth.
//
// electron/telemetry-transmission-log.cjs is a PURE in-memory data structure with
// an INJECTED clock + cap — zero real network, zero real fs, zero real time. Like
// web/telemetry-source.test.mjs (the established pattern for "main-process CJS
// module required from web/"), it loads the REAL module via createRequire. Auto-
// discovered by `npm test` in web/ (`node --test`).
//
// Each done-criterion letter in the ticket maps to a section below:
//   (d) metadata-only — entries never carry payload/redacted/identifier fields.
//   (e) bounded ring  — oldest entries drop past the cap; memory cannot grow.
// Plus the pure-mechanics coverage (clock injection, host derivation, no-op default),
// and the WARDEN-782 persistence seam (injected save, debounced coalescing, flushSave,
// seed() load path, parseTransmissionLog skip-malformed, and a record→seed round-trip).
//
// Run: node telemetry-transmission-log.test.mjs   (from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  createTransmissionLog,
  hostOf,
  noopTransmissionLog,
  readSnapshot,
  parseTransmissionLog,
  DEFAULT_CAP,
} = require('../electron/telemetry-transmission-log.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A deterministic injected clock — the test discipline: never Date.now() directly.
// Each call advances a counter so successive records get ascending, pin-able ts.
const sequencedClock = (start = 1000, step = 10) => {
  let t = start;
  return () => {
    const now = t;
    t += step;
    return now;
  };
};

// ==========================================================================
// Clock injection — the timestamp comes from the injected clock, never Date.now
// ==========================================================================

test('records entries stamped by the injected clock (deterministic, ascending)', () => {
  const clock = sequencedClock(5000, 100);
  const log = createTransmissionLog({ clock });
  log.record({ outcome: 'ok', attempts: 1, status: 200 });
  log.record({ outcome: 'dropped', attempts: 3, status: 503 });
  const [a, b] = log.entries();
  assert.equal(a.timestamp, 5000, 'first entry uses the first clock tick');
  assert.equal(b.timestamp, 5100, 'second entry uses the next clock tick');
});

test('an explicitly-supplied timestamp overrides the injected clock', () => {
  const clock = sequencedClock(999);
  const log = createTransmissionLog({ clock });
  log.record({ timestamp: 42, outcome: 'ok', attempts: 1, status: 200 });
  assert.equal(log.entries()[0].timestamp, 42, 'caller-supplied timestamp wins');
});

// ==========================================================================
// (d) METADATA ONLY — entries never carry payload, redacted fields, or ids
// ==========================================================================

test('an entry stores EXACTLY the seven metadata fields — no payload smuggled through', () => {
  const log = createTransmissionLog({ clock: () => 1 });
  // A malicious/malformed caller tries to smuggle payload content + identifiers.
  log.record({
    outcome: 'ok',
    endpointHost: 'telemetry.example.invalid',
    schemaVersion: 1,
    eventCount: 1,
    attempts: 1,
    status: 200,
    // none of the following must survive normalization:
    message: 'auth failed for token ghp_SECRET',
    events: [{ type: 'error', message: 'leaked' }],
    chatName: 'Refactor auth module',
    sessionName: 'claude-7b3a2f1',
    endpointUrl: 'https://telemetry.example.invalid/v1/events?token=leak',
  });
  const entry = log.entries()[0];
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['attempts', 'endpointHost', 'eventCount', 'outcome', 'schemaVersion', 'status', 'timestamp'],
    'only the seven metadata fields are present',
  );
  assert.equal(entry.message, undefined, 'no payload message field');
  assert.equal(entry.events, undefined, 'no events/payload field');
  assert.equal(entry.chatName, undefined, 'no chat identifier');
  assert.equal(entry.sessionName, undefined, 'no session identifier');
  assert.equal(entry.endpointUrl, undefined, 'no full URL (host-only metadata)');
});

test('a credential planted in a smuggled field never appears in any entry', () => {
  const log = createTransmissionLog({ clock: () => 1 });
  log.record({ outcome: 'ok', attempts: 1, status: 200, secret: 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' });
  const blob = JSON.stringify(log.entries());
  assert.doesNotMatch(blob, /ghp_/, 'a smuggled credential is not retained');
});

test('malformed fields are normalized — a bad outcome/attempts/status cannot crash or corrupt', () => {
  const log = createTransmissionLog({ clock: () => 7 });
  log.record({ outcome: 'weird', attempts: 'lots', status: 'OK', eventCount: 'one' });
  const e = log.entries()[0];
  assert.equal(e.outcome, null, 'unknown outcome normalized to null');
  assert.equal(e.attempts, 0, 'non-number attempts normalized to 0');
  assert.equal(e.status, null, 'non-number status normalized to null');
  assert.equal(e.eventCount, 0, 'non-number eventCount normalized to 0');
  assert.equal(e.timestamp, 7, 'clock still stamped the entry');
});

test('record() tolerates a non-object / null entry without throwing', () => {
  const log = createTransmissionLog({ clock: () => 1 });
  assert.doesNotThrow(() => log.record(null));
  assert.doesNotThrow(() => log.record(undefined));
  assert.doesNotThrow(() => log.record('not an object'));
  assert.equal(log.size(), 3, 'each call still appends a (normalized) entry');
  assert.equal(log.entries()[0].outcome, null);
});

// ==========================================================================
// (e) BOUNDED RING — oldest entries drop past the cap; memory cannot grow
// ==========================================================================

test('a small cap drops the OLDEST entries past it (FIFO ring)', () => {
  const clock = sequencedClock(0, 1);
  const log = createTransmissionLog({ clock, cap: 3 });
  for (let i = 0; i < 5; i++) log.record({ outcome: 'ok', attempts: 1, status: 200 });
  assert.equal(log.size(), 3, 'size never exceeds the cap');
  const ts = log.entries().map((e) => e.timestamp);
  // The first two (timestamps 0,1) were dropped; the ring holds the newest three.
  assert.deepEqual(ts, [2, 3, 4], 'oldest entries dropped, newest retained');
});

test('a cap of 1 keeps only the very latest entry', () => {
  const clock = sequencedClock(100, 1);
  const log = createTransmissionLog({ clock, cap: 1 });
  log.record({ outcome: 'ok', status: 200 });
  log.record({ outcome: 'dropped', status: 503 });
  assert.equal(log.size(), 1);
  assert.equal(log.entries()[0].outcome, 'dropped', 'only the latest survives');
});

test('firing far past the cap never grows memory beyond it', () => {
  const log = createTransmissionLog({ cap: 10, clock: () => 1 });
  for (let i = 0; i < 1000; i++) log.record({ outcome: 'ok', attempts: 1, status: 200 });
  assert.equal(log.size(), 10, '1000 records, cap held at 10');
});

test('a non-positive / non-integer cap falls back to DEFAULT_CAP', () => {
  for (const bad of [0, -5, 2.5, NaN, '10', null]) {
    const log = createTransmissionLog({ cap: bad, clock: () => 1 });
    assert.equal(log.size(), 0);
    // The fallback cap is DEFAULT_CAP — record many, confirm it bounds there.
    for (let i = 0; i < DEFAULT_CAP + 50; i++) log.record({ outcome: 'ok', attempts: 1, status: 200 });
    assert.equal(log.size(), DEFAULT_CAP, `cap ${JSON.stringify(bad)} fell back to DEFAULT_CAP`);
  }
});

// ==========================================================================
// entries() returns a SNAPSHOT — the live ring is never exposed for mutation
// ==========================================================================

test('entries() returns a copy — mutating it does not affect the live ring', () => {
  const log = createTransmissionLog({ clock: () => 1 });
  log.record({ outcome: 'ok', attempts: 1, status: 200 });
  const snap = log.entries();
  snap.length = 0;
  snap.push({ tampered: true });
  assert.equal(log.size(), 1, 'clearing the snapshot did not clear the ring');
  assert.equal(log.entries()[0].tampered, undefined, 'pushing into the snapshot did not pollute the ring');
});

test('entries() are oldest → newest (insertion order)', () => {
  const clock = sequencedClock(0, 100);
  const log = createTransmissionLog({ clock });
  log.record({ outcome: 'ok', attempts: 1, status: 200 });
  log.record({ outcome: 'dropped', attempts: 2, status: 503 });
  log.record({ outcome: 'ok', attempts: 1, status: 201 });
  const [a, b, c] = log.entries();
  assert.equal(a.timestamp, 0);
  assert.equal(b.timestamp, 100);
  assert.equal(c.timestamp, 200);
});

// ==========================================================================
// hostOf — endpoint HOST (hostname[:port]) only, never the full URL
// ==========================================================================

test('hostOf returns hostname for a plain host URL', () => {
  assert.equal(hostOf('https://telemetry.example.invalid/ingest'), 'telemetry.example.invalid');
});

test('hostOf includes the port when present', () => {
  assert.equal(hostOf('http://localhost:9999/telemetry'), 'localhost:9999');
});

test('hostOf strips path and query — never the full URL with identifying segments', () => {
  const full = 'https://telemetry.example.invalid/v1/events?token=secret&session=abc';
  assert.equal(hostOf(full), 'telemetry.example.invalid', 'path/query stripped (no token leak)');
  assert.ok(!hostOf(full).includes('token'), 'a query token never reaches the host label');
});

test('hostOf returns null for empty / non-string / malformed URLs (never throws)', () => {
  for (const bad of ['', null, undefined, 42, 'not a url', '://no-scheme', 'http://']) {
    assert.equal(hostOf(bad), null, `${JSON.stringify(bad)} → null, no throw`);
  }
  assert.doesNotThrow(() => hostOf('http://'));
});

// ==========================================================================
// noopTransmissionLog — the pipeline's default; records nothing
// ==========================================================================

test('noopTransmissionLog records nothing and reads as empty', () => {
  assert.equal(noopTransmissionLog.size(), 0);
  assert.deepEqual(noopTransmissionLog.entries(), []);
  assert.doesNotThrow(() => noopTransmissionLog.record({ outcome: 'ok' }));
  assert.equal(noopTransmissionLog.size(), 0, 'a no-op recorder retains nothing');
  assert.deepEqual(noopTransmissionLog.entries(), [], 'still empty after a record()');
});

test('noopTransmissionLog is frozen — the default singleton cannot be re-shaped', () => {
  assert.ok(Object.isFrozen(noopTransmissionLog), 'the shared no-op default is frozen');
});

// ==========================================================================
// readSnapshot — the IPC surfacing seam (WARDEN-668). The main-process handler
// `telemetry:transmission-log` is a thin delegate to this pure function. main.cjs
// cannot be require()'d in a test (it imports 'electron'), so the handler's
// defensive contract — return entries() on success, [] on ANY failure — is pinned
// here against the REAL function (not a re-implementation).
// ==========================================================================

test('readSnapshot returns the log entries() snapshot (the live ring is not handed out)', () => {
  const clock = sequencedClock(100, 10);
  const log = createTransmissionLog({ clock });
  log.record({ outcome: 'ok', attempts: 1, status: 200, endpointHost: 'host.example' });
  log.record({ outcome: 'dropped', attempts: 3, status: 503 });
  const snap = readSnapshot(log);
  assert.equal(snap.length, 2, 'both recorded entries surface');
  assert.deepEqual(
    snap.map((e) => e.outcome),
    ['ok', 'dropped'],
    'the snapshot is the same oldest→newest view as entries()',
  );
  // Mutating the snapshot the IPC handler returned must not touch the live ring —
  // a renderer must never mutate pipeline state through the verifiability panel.
  snap.length = 0;
  assert.equal(log.size(), 2, 'clearing the returned snapshot did not clear the ring');
});

test('readSnapshot of an empty ring returns [] (honest "no sends" — the panel empty state)', () => {
  const log = createTransmissionLog({ clock: () => 1 });
  assert.deepEqual(readSnapshot(log), [], 'a fresh ring surfaces as empty, not undefined/null');
});

test('readSnapshot degrades to [] when entries() throws (a pipeline failure never crashes the host)', () => {
  // A log whose entries() blows up (e.g. a corrupted internal state) must surface
  // as "no sends" rather than propagate the throw across the IPC boundary.
  const broken = { entries() { throw new Error('corrupted ring'); }, size() { return 0; } };
  assert.doesNotThrow(() => {
    const out = readSnapshot(broken);
    assert.deepEqual(out, [], 'the throw was swallowed and [] returned');
  });
});

test('readSnapshot degrades to [] for a non-log argument (null / undefined / wrong shape)', () => {
  // A partially-wired pipeline (no log injected yet, or a malformed collaborator)
  // must not crash the IPC handler — it surfaces as "no sends".
  for (const bad of [null, undefined, {}, { entries: 'not a function' }, 42, 'string']) {
    assert.deepEqual(readSnapshot(bad), [], `${JSON.stringify(bad)} → [] (no throw)`);
  }
  assert.doesNotThrow(() => readSnapshot(undefined));
});

// ==========================================================================
// (WARDEN-782) Persistence seam — injected save, debounced coalescing, flushSave
// ==========================================================================

test('record() invokes the injected save with the current snapshot (immediate when debounceMs is unset)', () => {
  const saved = [];
  const log = createTransmissionLog({ clock: () => 1, save: (e) => saved.push(e) });
  log.record({ outcome: 'ok', attempts: 1, status: 200 });
  log.record({ outcome: 'dropped', attempts: 2, status: 503 });
  // No debounce → one save per record, each carrying a snapshot of the ring AT THAT
  // record (the first save saw one entry, the second saw two).
  assert.equal(saved.length, 2, 'immediate mode saves once per record');
  assert.equal(saved[0].length, 1, 'first save snapshot has the first entry');
  assert.equal(saved[1].length, 2, 'second save snapshot has both entries');
  assert.equal(saved[1][1].outcome, 'dropped', 'the snapshot carries the normalized entry');
});

test('without an injected save, record() persists nothing and does not throw', () => {
  const log = createTransmissionLog({ clock: () => 1 });
  assert.doesNotThrow(() => log.record({ outcome: 'ok', attempts: 1, status: 200 }));
  assert.equal(log.size(), 1, 'the ring still records in-memory with no save injected');
});

test('a throwing save never crashes record() (durability is best-effort, never load-bearing)', () => {
  const log = createTransmissionLog({
    clock: () => 1,
    save: () => { throw new Error('disk full'); },
  });
  assert.doesNotThrow(() => log.record({ outcome: 'ok', attempts: 1, status: 200 }));
  assert.equal(log.size(), 1, 'the entry was recorded even though save threw');
});

test('a debounced save coalesces a burst of record() calls into ONE write', () => {
  let calls = 0;
  let lastSaved = null;
  const log = createTransmissionLog({
    clock: () => 1,
    debounceMs: 50,
    save: (e) => { calls += 1; lastSaved = e; },
  });
  // A burst of three records — all within the debounce window.
  log.record({ outcome: 'ok', attempts: 1, status: 200 });
  log.record({ outcome: 'ok', attempts: 1, status: 200 });
  log.record({ outcome: 'dropped', attempts: 3, status: 503 });
  assert.equal(calls, 0, 'no write fired yet — the save is debounced');
  assert.equal(log.size(), 3, 'the ring still holds all three in-memory');
  // Flush (the quit path) materializes the pending debounced write synchronously.
  const fired = log.flushSave();
  assert.equal(fired, true, 'flushSave reports a pending write was flushed');
  assert.equal(calls, 1, 'the burst coalesced into exactly one write');
  assert.equal(lastSaved.length, 3, 'the flushed snapshot has all three entries');
});

test('flushSave is a no-op (returns false) when nothing is pending', () => {
  let calls = 0;
  const log = createTransmissionLog({ clock: () => 1, debounceMs: 50, save: () => { calls += 1; } });
  assert.equal(log.flushSave(), false, 'nothing was pending');
  assert.equal(calls, 0, 'no save fired');
});

test('flushSave clears the pending timer — a second flush is a no-op (no late save leaks)', () => {
  let calls = 0;
  const log = createTransmissionLog({ clock: () => 1, debounceMs: 50, save: () => { calls += 1; } });
  log.record({ outcome: 'ok', attempts: 1, status: 200 });
  log.flushSave();
  assert.equal(log.flushSave(), false, 'the first flush cleared the pending timer');
  assert.equal(calls, 1, 'still exactly one write after the second flush');
});

test('noopTransmissionLog exposes the persistence seam as no-ops (uniform interface)', () => {
  assert.equal(noopTransmissionLog.flushSave(), false, 'noop flushSave reports nothing flushed');
  assert.doesNotThrow(() => noopTransmissionLog.seed([{ outcome: 'ok' }]));
  assert.equal(noopTransmissionLog.size(), 0, 'noop seed retained nothing');
});

// ==========================================================================
// (WARDEN-782) seed() — the restart-restore (load) path
// ==========================================================================

test('seed() loads a parsed array into the ring (oldest → newest preserved, timestamps kept)', () => {
  const log = createTransmissionLog({ clock: () => 999 });
  log.seed([
    { timestamp: 100, outcome: 'ok', attempts: 1, status: 200, endpointHost: 'a.example' },
    { timestamp: 200, outcome: 'dropped', attempts: 2, status: 503, endpointHost: 'b.example' },
  ]);
  const [a, b] = log.entries();
  assert.equal(a.timestamp, 100, 'loaded timestamps preserved (not re-stamped by the clock)');
  assert.equal(a.endpointHost, 'a.example');
  assert.equal(b.outcome, 'dropped');
  assert.equal(log.size(), 2);
});

test('seed() enforces the cap on the loaded set (drops the OLDEST past it)', () => {
  const log = createTransmissionLog({ clock: () => 1, cap: 3 });
  const loaded = [];
  for (let i = 0; i < 5; i++) loaded.push({ timestamp: i, outcome: 'ok', attempts: 1, status: 200 });
  log.seed(loaded);
  assert.equal(log.size(), 3, 'a loaded set past the cap is bounded on load');
  assert.deepEqual(
    log.entries().map((e) => e.timestamp),
    [2, 3, 4],
    'the oldest loaded entries dropped, newest retained',
  );
});

test('seed() does NOT trigger a save (the load path is not a write)', () => {
  let calls = 0;
  const log = createTransmissionLog({ clock: () => 1, save: () => { calls += 1; } });
  log.seed([{ timestamp: 1, outcome: 'ok', attempts: 1, status: 200 }]);
  assert.equal(calls, 0, 'loading the persisted set does not rewrite it');
  assert.equal(log.size(), 1);
});

test('seed() REPLACES the ring (re-seeding resets, it does not append)', () => {
  const log = createTransmissionLog({ clock: () => 1 });
  log.seed([{ timestamp: 1, outcome: 'ok', attempts: 1, status: 200 }]);
  log.seed([
    { timestamp: 2, outcome: 'dropped', attempts: 1, status: 503 },
    { timestamp: 3, outcome: 'ok', attempts: 1, status: 200 },
  ]);
  assert.equal(log.size(), 2, 'the second seed replaced the first');
  assert.deepEqual(log.entries().map((e) => e.timestamp), [2, 3]);
});

test('seed() tolerates a non-array without throwing (ring stays empty)', () => {
  const log = createTransmissionLog({ clock: () => 1 });
  for (const bad of [null, undefined, {}, 'string', 42]) {
    assert.doesNotThrow(() => log.seed(bad), `${JSON.stringify(bad)} did not throw`);
  }
  assert.equal(log.size(), 0, 'a non-array seed leaves the ring empty');
});

test('seed() normalizes loaded entries — a smuggled field on disk cannot survive into the ring', () => {
  // The load-path metadata-only invariant (extends the record() 7-field test): a
  // corrupt/smuggled entry read from disk is re-normalized, so payload/identifiers
  // are stripped before the entry reaches the live ring — durability persists a
  // metadata-only audit, never anything richer.
  const log = createTransmissionLog({ clock: () => 1 });
  log.seed([
    {
      timestamp: 1,
      outcome: 'ok',
      attempts: 1,
      status: 200,
      // none of the following may survive normalization:
      message: 'auth failed for token ghp_SECRET',
      events: [{ type: 'error', message: 'leaked' }],
      chatName: 'Refactor auth module',
      sessionName: 'claude-7b3a2f1',
      endpointUrl: 'https://telemetry.example.invalid/v1/events?token=leak',
    },
  ]);
  const entry = log.entries()[0];
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['attempts', 'endpointHost', 'eventCount', 'outcome', 'schemaVersion', 'status', 'timestamp'],
    'a loaded entry is normalized to exactly the seven metadata fields',
  );
  assert.equal(entry.message, undefined, 'no smuggled payload message');
  assert.equal(entry.sessionName, undefined, 'no smuggled session identifier');
  assert.equal(entry.endpointUrl, undefined, 'no smuggled full URL');
  assert.doesNotMatch(JSON.stringify(log.entries()), /ghp_|sessionName|endpointUrl/);
});

// ==========================================================================
// (WARDEN-782) parseTransmissionLog — skip-malformed NDJSON load
// ==========================================================================

test('parseTransmissionLog parses NDJSON entries (one JSON object per line)', () => {
  const text = JSON.stringify({ timestamp: 1, outcome: 'ok' }) + '\n' +
    JSON.stringify({ timestamp: 2, outcome: 'dropped' });
  const parsed = parseTransmissionLog(text);
  assert.equal(parsed.length, 2, 'two valid lines → two entries');
  assert.deepEqual(parsed.map((e) => e.outcome), ['ok', 'dropped']);
});

test('parseTransmissionLog skips a corrupt line — valid entries on either side survive', () => {
  // The skip-malformed success measure: one bad line degrades to the pre+post-
  // corruption entries, NOT a blank panel and NOT a crash.
  const text = JSON.stringify({ timestamp: 1, outcome: 'ok' }) + '\n' +
    '{ this line is not valid json +++\n' +
    JSON.stringify({ timestamp: 3, outcome: 'dropped' });
  const parsed = parseTransmissionLog(text);
  assert.equal(parsed.length, 2, 'the corrupt line was skipped, the good ones survived');
  assert.deepEqual(parsed.map((e) => e.timestamp), [1, 3]);
});

test('parseTransmissionLog ignores blank lines between entries', () => {
  const text = JSON.stringify({ timestamp: 1, outcome: 'ok' }) + '\n\n' +
    JSON.stringify({ timestamp: 2, outcome: 'ok' }) + '\n';
  const parsed = parseTransmissionLog(text);
  assert.equal(parsed.length, 2, 'blank lines (incl. trailing) are ignored');
});

test('parseTransmissionLog skips a non-object line (a bare number/string is not an entry)', () => {
  const text = JSON.stringify({ timestamp: 1, outcome: 'ok' }) + '\n' +
    JSON.stringify(42) + '\n' +
    JSON.stringify('a bare string') + '\n' +
    JSON.stringify({ timestamp: 4, outcome: 'dropped' });
  const parsed = parseTransmissionLog(text);
  assert.equal(parsed.length, 2, 'only object entries are retained');
  assert.deepEqual(parsed.map((e) => e.timestamp), [1, 4]);
});

test('parseTransmissionLog returns [] for missing/empty/non-string text (never throws)', () => {
  for (const bad of ['', '   ', '\n\n', null, undefined, 42, {}]) {
    assert.doesNotThrow(() => {
      assert.deepEqual(parseTransmissionLog(bad), [], `${JSON.stringify(bad)} → []`);
    });
  }
});

// ==========================================================================
// (WARDEN-782) Round-trip — record → serialize → parse → seed (a restart)
// ==========================================================================

test('a record → serialize → parse → seed round-trip is lossless (delivered/dropped badges intact)', () => {
  const clock = sequencedClock(5000, 100);
  const recorded = createTransmissionLog({ clock });
  recorded.record({ outcome: 'ok', endpointHost: 'telemetry.example.invalid', schemaVersion: 1, eventCount: 3, attempts: 1, status: 200 });
  recorded.record({ outcome: 'dropped', endpointHost: 'telemetry.example.invalid', schemaVersion: 1, eventCount: 1, attempts: 3, status: 503 });
  // main.cjs serializes via `entries.map(JSON.stringify).join('\n')`; mirror it here.
  const text = recorded.entries().map((e) => JSON.stringify(e)).join('\n') + '\n';
  // A fresh log (a restarted app) loads + seeds from the parsed file.
  const restarted = createTransmissionLog({ clock: () => 0 });
  restarted.seed(parseTransmissionLog(text));
  assert.deepEqual(restarted.entries(), recorded.entries(), 'the round-trip is lossless');
  assert.deepEqual(
    restarted.entries().map((e) => e.outcome),
    ['ok', 'dropped'],
    'delivered/dropped badges intact after a restart',
  );
});

test('a partially-corrupted persisted file degrades to the surviving entries (skip-malformed round-trip)', () => {
  // Simulate a real corruption: a valid audit file with one line damaged on disk.
  // The restarted app must load the SURVIVING entries, not blank, not crash.
  const recorded = createTransmissionLog({ clock: () => 1000 });
  recorded.record({ outcome: 'ok', attempts: 1, status: 200 });
  recorded.record({ outcome: 'dropped', attempts: 2, status: 503 });
  recorded.record({ outcome: 'ok', attempts: 1, status: 201 });
  const lines = recorded.entries().map((e) => JSON.stringify(e));
  lines[1] = '{ CORRUPTED LINE ON DISK +++'; // damage the middle entry
  const text = lines.join('\n') + '\n';
  const restarted = createTransmissionLog({ clock: () => 0 });
  restarted.seed(parseTransmissionLog(text));
  assert.equal(restarted.size(), 2, 'the corrupted entry was skipped; the two good ones survived');
  assert.deepEqual(
    restarted.entries().map((e) => e.status),
    [200, 201],
    'the pre- and post-corruption entries loaded (no blank panel)',
  );
});

console.log(`\n✓ TELEMETRY TRANSMISSION-LOG TESTS PASS (${passed})`);
