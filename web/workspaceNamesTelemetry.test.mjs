// Tests for the WORKSPACE-NAMES telemetry PRODUCER (WARDEN-1416,
// src/workspaceNamesTelemetry.js) — the consent gate, the bounded snapshot, the
// window drop, and the IPC forward.
//
// This producer is the one that closes the `names` category's dead switch, so
// the properties under test are the ones that make an off-by-default,
// names-only promise real:
//
//   • names consent ON, ALONE → ONE bounded event per window, not one per chat;
//   • names consent OFF (the default) → the window is DISCARDED at flush, so
//     nothing out-of-consent is even retained in memory, let alone sent;
//   • a mid-window revoke drops the window that was already open;
//   • an idle catalog sends nothing at all;
//   • the cap is LOUD — capped list + TRUE count + truncated flag;
//   • CARRIER HYGIENE — the snapshot carries names/counts/window fields ONLY.
//     No host, path, cwd, session id, cmd, status or timestamp from the catalog
//     row can reach the wire, because nothing but `.name` is read.
//
// Everything is injectable, so this runs with a fake clock, a captured `send`,
// a togglable consent and a fixture catalog — no timers, no IPC, no waiting.
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node --test web/workspaceNamesTelemetry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkspaceNamesTelemetry,
  buildNamesSnapshot,
  NAMES_FLUSH_MS,
  NAMES_MAX,
  RESUMED_SESSION_LABEL,
  HOST_LABEL,
} from '../src/workspaceNamesTelemetry.js';

// A catalog row shaped exactly like chatCatalog.snapshot()'s — every field the
// real one carries, so a test that asserts "only `.name` survives" is asserting
// it against the REAL surface area rather than a convenient subset.
const chatRow = (name, over = {}) => ({
  id: `(local):${name}`,
  key: name,
  kind: 'tmux',
  host: '(local)',
  container: null,
  session: name,
  project: 'local',
  role: 'claude',
  name,
  cwd: '/home/alice/projects/warden',
  cmd: 'claude --resume 7b3a2f1',
  active: true,
  status: 'running',
  lastActivity: 1735689600000,
  ...over,
});

// A producer with a captured `send`, a togglable consent, a fixture catalog and
// a fake clock.
function harness({ enabled = true, chats = [chatRow('demo')] } = {}) {
  const sent = [];
  const state = { enabled, chats };
  let t = 1_000_000;
  const producer = createWorkspaceNamesTelemetry({
    consent: () => state.enabled,
    catalog: () => state.chats,
    send: (snapshot) => sent.push(snapshot),
    now: () => t,
  });
  return {
    producer,
    sent,
    state,
    advance(ms) { t += ms; },
    at() { return t; },
  };
}

// ==========================================================================
// The consent gate — the property that makes the off-by-default promise real
// ==========================================================================

test('names consent ON, ALONE — a catalog with chats yields ONE bounded event per window', () => {
  const { producer, sent } = harness({
    chats: [chatRow('demo'), chatRow('Refactor auth'), chatRow('chat-4nh15o')],
  });
  const snapshot = producer.flushNow();
  assert.equal(sent.length, 1, 'ONE snapshot for the window — never one row per chat');
  assert.equal(sent[0], snapshot);
  assert.deepEqual(snapshot.chats, ['demo', 'Refactor auth', 'chat-4nh15o']);
  assert.equal(snapshot.chatCount, 3, 'the TRUE catalog size');
  assert.equal(snapshot.truncated, false, 'nothing was cut');
});

test('names consent OFF (the default) — the window is DISCARDED, nothing sent or retained', () => {
  const { producer, sent } = harness({ enabled: false, chats: [chatRow('demo')] });
  assert.equal(producer.flushNow(), null, 'the flush sends nothing');
  assert.equal(sent.length, 0);
  // And nothing lingers: the producer holds no state across a consent-off
  // flush — the next ENABLED flush reads the catalog fresh, it does not replay
  // anything observed while off.
  const h = harness({ enabled: false, chats: [chatRow('was-off')] });
  h.producer.flushNow();
  h.state.enabled = true;
  h.state.chats = [chatRow('now-on')];
  const after = h.producer.flushNow();
  assert.deepEqual(after.chats, ['now-on'], 'only what the live catalog holds NOW is sent');
  assert.equal(h.sent.length, 1, 'the out-of-consent window was never sent');
});

test('a MID-WINDOW revoke drops the window that was already open', () => {
  const { producer, sent, state } = harness({ chats: [chatRow('demo')] });
  state.enabled = false; // the user revokes between window open and flush
  assert.equal(producer.flushNow(), null, 'the open window is dropped, not shipped');
  assert.equal(sent.length, 0);
});

test('a missing / non-function consent resolver fails CLOSED', () => {
  const sent = [];
  const producer = createWorkspaceNamesTelemetry({
    catalog: () => [chatRow('demo')],
    send: (s) => sent.push(s),
  });
  assert.equal(producer.flushNow(), null, 'no consent resolver → nothing sent');
  assert.equal(sent.length, 0);
});

test('an IDLE catalog sends nothing at all', () => {
  const { producer, sent } = harness({ chats: [] });
  assert.equal(producer.flushNow(), null, 'an empty workspace is not worth a window');
  assert.equal(sent.length, 0);
  // A catalog of rows that carry NO usable name is equally idle.
  const h = harness({ chats: [chatRow('x', { name: '' }), chatRow('y', { name: null })] });
  assert.equal(h.producer.flushNow(), null, 'no named chat → nothing sent');
  assert.equal(h.sent.length, 0);
});

test('STANDALONE (no process.send wired) — the producer is inert on the wire', () => {
  // server.js guards process.send for a standalone `node src/server` run, which
  // presents here as a missing `send`. The window still closes; nothing ships.
  const producer = createWorkspaceNamesTelemetry({
    consent: () => true,
    catalog: () => [chatRow('demo')],
  });
  assert.doesNotThrow(() => producer.flushNow(), 'a missing forward is inert, not a crash');
});

// ==========================================================================
// The bounded snapshot — the cap is LOUD, never silent
// ==========================================================================

test('CAP HONESTY — over the cap yields a capped list, the TRUE count, and truncated:true', () => {
  const chats = Array.from({ length: 250 }, (_, i) => chatRow(`chat-${i}`));
  const snapshot = buildNamesSnapshot(chats, 200);
  assert.equal(snapshot.chats.length, 200, 'the list is capped');
  assert.equal(snapshot.chatCount, 250, 'the count is the TRUE catalog size, not the capped length');
  assert.equal(snapshot.truncated, true, 'and the cut is declared');
  // The invariant the schema validator enforces on the wire.
  assert.ok(snapshot.chatCount >= snapshot.chats.length);
  assert.equal(snapshot.truncated, snapshot.chatCount > snapshot.chats.length);
});

test('EXACTLY at the cap is NOT truncated (an off-by-one here would be a false alarm)', () => {
  const snapshot = buildNamesSnapshot(Array.from({ length: 200 }, (_, i) => chatRow(`c-${i}`)), 200);
  assert.equal(snapshot.chats.length, 200);
  assert.equal(snapshot.chatCount, 200);
  assert.equal(snapshot.truncated, false);
});

test('names are DE-DUPLICATED in first-seen order, and duplicates still count', () => {
  const snapshot = buildNamesSnapshot([
    chatRow('demo'), chatRow('demo'), chatRow('other'), chatRow('demo'),
  ]);
  assert.deepEqual(snapshot.chats, ['demo', 'other'], 'each distinct name once, in order');
  assert.equal(snapshot.chatCount, 4, 'the count is CHATS, not distinct names');
  assert.equal(snapshot.truncated, true, 'and the list is honestly shorter than the count');
});

test('unnamed / non-string rows are skipped entirely (not counted, not sent)', () => {
  const snapshot = buildNamesSnapshot([
    chatRow('real'), chatRow('x', { name: '' }), chatRow('y', { name: 42 }),
    chatRow('z', { name: null }), null, undefined, 'not-an-object',
  ]);
  assert.deepEqual(snapshot.chats, ['real']);
  assert.equal(snapshot.chatCount, 1, 'only rows with a usable name are counted');
  assert.equal(snapshot.truncated, false);
});

test('a non-array catalog degrades to an empty snapshot (never throws)', () => {
  for (const bad of [undefined, null, 42, 'chats', {}]) {
    const snapshot = buildNamesSnapshot(bad);
    assert.deepEqual(snapshot, { chats: [], chatCount: 0, truncated: false },
      `degenerate catalog ${JSON.stringify(bad)} yields an empty snapshot`);
  }
});

// ==========================================================================
// CARRIER HYGIENE — the snapshot can carry nothing but names + counts
// ==========================================================================

test('CARRIER HYGIENE — ONLY names / counts / window fields appear; no host, path, cmd or id', () => {
  // The forcing function for "this producer cannot become a leak channel". The
  // fixture row carries every field the real catalog row does — a cwd, a host,
  // a session id, a command line with a session uuid, a status, a timestamp —
  // and NONE of them may appear anywhere in the snapshot.
  const { producer } = harness({ chats: [chatRow('demo'), chatRow('second')] });
  const snapshot = producer.flushNow();

  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['chatCount', 'chats', 'endedAt', 'startedAt', 'truncated'],
    'the snapshot has EXACTLY these keys',
  );

  // And no forbidden VALUE survives anywhere in the serialized snapshot.
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    '/home/alice', 'projects/warden', '(local)', 'claude --resume', '7b3a2f1',
    'tmux', 'running', '1735689600000', 'local',
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `no catalog field may ride the snapshot: ${JSON.stringify(forbidden)}`,
    );
  }
});

test('every snapshot value is a string name, a number, or a boolean — no nested object', () => {
  const { producer } = harness({ chats: [chatRow('demo')] });
  const snapshot = producer.flushNow();
  for (const v of snapshot.chats) assert.equal(typeof v, 'string');
  assert.equal(typeof snapshot.chatCount, 'number');
  assert.equal(typeof snapshot.truncated, 'boolean');
  assert.equal(typeof snapshot.startedAt, 'number');
  assert.equal(typeof snapshot.endedAt, 'number');
});

// ==========================================================================
// Window stamps + cadence
// ==========================================================================

test('window stamps describe the CADENCE interval — the first opens one interval back', () => {
  const h = harness({ chats: [chatRow('demo')] });
  const first = h.producer.flushNow();
  assert.equal(first.endedAt, h.at());
  assert.equal(first.startedAt, h.at() - NAMES_FLUSH_MS, 'the first window opens one cadence back');
  assert.ok(first.startedAt < first.endedAt, 'never zero-length or inverted');

  h.advance(NAMES_FLUSH_MS);
  const second = h.producer.flushNow();
  assert.equal(second.startedAt, first.endedAt, 'the next window opens where the last closed');
  assert.equal(second.endedAt, h.at());
});

test('a DROPPED (consent-off) window still advances the clock — no out-of-consent span is replayed', () => {
  const h = harness({ chats: [chatRow('demo')] });
  h.producer.flushNow();          // window 1, sent
  h.advance(NAMES_FLUSH_MS);
  h.state.enabled = false;
  const droppedAt = h.at();
  h.producer.flushNow();          // window 2, dropped
  h.advance(NAMES_FLUSH_MS);
  h.state.enabled = true;
  const third = h.producer.flushNow();
  assert.equal(third.startedAt, droppedAt,
    'the next window opens where the DROPPED one closed — it never re-covers the off span');
});

test('the flush interval is armed UNREF\'d so a library import never holds the loop open', () => {
  let unrefCalls = 0;
  const fakeTimer = { unref: () => { unrefCalls += 1; } };
  const producer = createWorkspaceNamesTelemetry({
    consent: () => true,
    catalog: () => [],
    setIntervalImpl: () => fakeTimer,
  });
  const t = producer.start();
  assert.equal(t, fakeTimer);
  assert.equal(unrefCalls, 1, 'start() unrefs the timer');
});

test('the shipped cadence + cap are the documented values', () => {
  assert.equal(NAMES_FLUSH_MS, 5 * 60_000, 'the same 5-minute window every producer uses');
  assert.equal(NAMES_MAX, 200);
});

// ==========================================================================
// Resume-spawned rows carry the owner's first PROMPT as `.name` (WARDEN-1550)
// ==========================================================================

test('a resume-<sid8> row with a prompt-text name ships the constant label, never the prompt', () => {
  const prompt = 'проверь доступность ремоут хостов whitego';
  const snapshot = buildNamesSnapshot([
    chatRow(prompt, { session: 'resume-3f9a1c2d' }),
    chatRow('demo'),
  ]);
  assert.ok(!snapshot.chats.includes(prompt), 'the prompt text is not shipped');
  assert.ok(!JSON.stringify(snapshot).includes(prompt), 'nor anywhere else in the snapshot');
  assert.ok(snapshot.chats.includes(RESUMED_SESSION_LABEL), 'the constant label stands in');
  assert.ok(snapshot.chats.includes('demo'), 'a normally-named chat is unaffected');
  assert.equal(snapshot.chatCount, 2, 'the true catalog size still counts the resumed row');
});

test('two different resume rows collapse to ONE label while chatCount counts both', () => {
  const snapshot = buildNamesSnapshot([
    chatRow('first prompt A', { session: 'resume-aaaaaaaa' }),
    chatRow('second prompt B', { session: 'resume-bbbbbbbb' }),
    chatRow('resume cccccccc', { session: 'resume-cccccccc' }),
  ]);
  assert.deepEqual(snapshot.chats, [RESUMED_SESSION_LABEL]);
  assert.equal(snapshot.chatCount, 3);
  assert.ok(snapshot.chatCount >= snapshot.chats.length, 'chatCount >= chats.length invariant');
  assert.equal(snapshot.truncated, true, 'collapsed entries make chatCount exceed the list, as dedup always did');
});

test('a resume-shaped row whose name equals its session is not prompt-derived and passes through', () => {
  const snapshot = buildNamesSnapshot([chatRow('resume-3f9a1c2d')]);
  assert.deepEqual(snapshot.chats, ['resume-3f9a1c2d']);
});

test('only the exact resume-<sid> shape is stripped — look-alike sessions keep their names', () => {
  const snapshot = buildNamesSnapshot([
    chatRow('Refactor auth', { session: 'resume-' }),
    chatRow('Other thing', { session: 'resume-123456789' }),
    chatRow('Third', { session: 'my-resume-abc' }),
  ]);
  assert.deepEqual(snapshot.chats, ['Refactor auth', 'Other thing', 'Third']);
});

// ==========================================================================
// A row's own SSH host alias is stripped from its name (WARDEN-1564)
// ==========================================================================

test('a row\'s own host alias is replaced by <host>; (local) and non-owning names are untouched', () => {
  const snapshot = buildNamesSnapshot([
    { host: 'netcup', session: 'shell-ab12cd', name: 'shell @ netcup' },
    { host: '(local)', session: 's', name: 'shell @ local' },
    { host: 'arch', session: 't', name: 'search arch' },
  ]);
  assert.equal(HOST_LABEL, '<host>');
  assert.deepEqual(snapshot.chats, ['shell @ <host>', 'shell @ local', 'search <host>']);
  assert.equal(snapshot.chatCount, 3);
  assert.ok(!JSON.stringify(snapshot).includes('netcup'));
});

test('host alias: row without host, or name not containing its host, is unchanged', () => {
  const snapshot = buildNamesSnapshot([
    { session: 'a', name: 'shell @ netcup' },
    { host: '', session: 'b', name: 'shell @ netcup2' },
    { host: 'macmini', session: 'c', name: 'my notes' },
    { host: 'netcup', session: 'd', name: 'netcupish' },
    { host: 'arch', session: 'e', name: 'search' },
  ]);
  assert.deepEqual(snapshot.chats, ['shell @ netcup', 'shell @ netcup2', 'my notes', 'netcupish', 'search']);
});

test('host alias: matching is case-insensitive and replaces every occurrence', () => {
  const snapshot = buildNamesSnapshot([{ host: 'netcup', session: 'x', name: 'NetCup and netcup' }]);
  assert.deepEqual(snapshot.chats, ['<host> and <host>']);
});

test('host alias: two rows with different aliases collapse to one entry while chatCount counts both', () => {
  const snapshot = buildNamesSnapshot([
    { host: 'netcup', session: 'shell-aaaaaa', name: 'shell @ netcup' },
    { host: 'whitego', session: 'shell-bbbbbb', name: 'shell @ whitego' },
  ]);
  assert.deepEqual(snapshot.chats, ['shell @ <host>']);
  assert.equal(snapshot.chatCount, 2);
});

test('host alias: regex-metacharacter hosts neither throw nor over-match', () => {
  const snapshot = buildNamesSnapshot([
    { host: 'a.b', session: 'p', name: 'shell @ a.b' },
    { host: 'a.b', session: 'q', name: 'shell @ axb' },
    { host: 'x+y', session: 'r', name: 'shell @ x+y' },
    { host: 'x+y', session: 's', name: 'shell @ xxy' },
    { host: '(', session: 't', name: 'shell @ (' },
  ]);
  assert.deepEqual(snapshot.chats, ['shell @ <host>', 'shell @ axb', 'shell @ xxy']);
});

test('host alias: the resume rule still wins over the host rule', () => {
  const snapshot = buildNamesSnapshot([
    { host: 'whitego', session: 'resume-3f9a1c2d', name: 'check whitego please' },
  ]);
  assert.deepEqual(snapshot.chats, [RESUMED_SESSION_LABEL]);
});
