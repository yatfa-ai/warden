// Tests for electron/telemetry-names-event.cjs (WARDEN-1416) — the main-process
// builder that turns the server child's 'telemetry-names' IPC snapshot into a
// `workspace-names` schema event, the `names` category's own carrying event.
//
// Pinned here (main.cjs itself can't be required without Electron — the
// window-state.cjs / telemetry-metrics-event.cjs / telemetry-stall-event.cjs
// pattern):
//   • a REAL producer snapshot builds into an event BOTH validators accept —
//     the canonical schema (loaded through vite's OXC transform, like the other
//     schema consumers in this suite family) AND the main-process copy — the
//     END-TO-END proof that the producer's shape and the wire contract agree;
//   • the event's `runtime` is `server` and nothing else (the chat catalog
//     lives in the backend child);
//   • a snapshot that is not shaped like the producer's window yields null
//     (nothing recorded — the builder never fabricates fields), including the
//     honest-cap violation a hostile child could otherwise assert;
//   • the names ride through VERBATIM — this type's payload is the permitted
//     identifier data, so the builder must not mangle or filter it;
//   • the non-identifying labels are attached only when supplied.
//
// Run: node --test telemetry-names-event.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';
import { createWorkspaceNamesTelemetry } from '../src/workspaceNamesTelemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { buildWorkspaceNamesEvent } = require('../electron/telemetry-names-event.cjs');

// Load the CANONICAL schema through the same OXC transform the other web tests
// use, so "validates" means the real wire contract, not a restatement.
const schemaPath = join(__dirname, 'src', 'lib', 'telemetry', 'schema.ts');
const { code } = await transformWithOxc(readFileSync(schemaPath, 'utf8'), schemaPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-tne-'));
const tmpFile = join(tmpDir, 'schema.mjs');
writeFileSync(tmpFile, code);
const { SCHEMA_VERSION, validateEvent } = await import(tmpFile);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

// The REAL main-process validator too, so the two copies are proven to agree on
// this type rather than assumed to.
const { validateBaseEvent } = require('../electron/telemetry-source.cjs');

/** A window from the REAL producer, so the shapes cannot drift apart. */
function realSnapshot(names) {
  let sent = null;
  const producer = createWorkspaceNamesTelemetry({
    consent: () => true,
    catalog: () => names.map((name) => ({ name })),
    send: (s) => { sent = s; },
    now: () => 1_000_000,
  });
  producer.flushNow();
  return sent;
}

// ==========================================================================
// The end-to-end proof: a REAL producer window → a schema-valid event
// ==========================================================================

test('a REAL producer window builds an event BOTH validators accept', () => {
  const snapshot = realSnapshot(['demo', 'Refactor auth', 'chat-4nh15o']);
  const event = buildWorkspaceNamesEvent({
    snapshot,
    schemaVersion: SCHEMA_VERSION,
    appVersion: '0.1.75',
    platform: 'linux',
    now: () => 1_000_042,
  });
  assert.ok(event, 'an event is built');
  assert.equal(validateEvent(event), true, 'the CANONICAL schema validates it');
  assert.equal(validateBaseEvent(event), true, 'the MAIN-PROCESS validator agrees');
  assert.equal(event.type, 'workspace-names');
  assert.equal(event.timestamp, 1_000_042, 'the injected clock stamps it');
});

test('the event is PINNED to the server runtime — the catalog lives in the backend child', () => {
  const event = buildWorkspaceNamesEvent({
    snapshot: realSnapshot(['demo']),
    schemaVersion: SCHEMA_VERSION,
  });
  assert.equal(event.runtime, 'server', 'never main, never renderer');
  // And the validators enforce it, so a mislabeled build cannot ship.
  assert.equal(validateEvent({ ...event, runtime: 'main' }), false);
  assert.equal(validateBaseEvent({ ...event, runtime: 'main' }), false);
});

test('the names ride through VERBATIM — the builder does not mangle the permitted payload', () => {
  const names = ['demo', 'Refactor auth módule ✨', 'chat-4nh15o', 'AAA BBB'];
  const event = buildWorkspaceNamesEvent({
    snapshot: realSnapshot(names),
    schemaVersion: SCHEMA_VERSION,
  });
  assert.deepEqual(event.chats, names, 'every name arrives unchanged');
  assert.equal(event.chatCount, names.length);
  assert.equal(event.truncated, false);
  assert.equal(validateEvent(event), true, 'and arbitrary name text still validates');
});

test('the CAP travels honestly into the event (capped list + TRUE count + flag)', () => {
  const snapshot = { startedAt: 1, endedAt: 2, chats: ['a', 'b'], chatCount: 250, truncated: true };
  const event = buildWorkspaceNamesEvent({ snapshot, schemaVersion: SCHEMA_VERSION });
  assert.deepEqual(event.chats, ['a', 'b']);
  assert.equal(event.chatCount, 250, 'the TRUE catalog size, not the list length');
  assert.equal(event.truncated, true);
  assert.equal(validateEvent(event), true);
});

// ==========================================================================
// Defensive: a malformed snapshot yields null, never a fabricated event
// ==========================================================================

test('a snapshot that is not a producer window yields null (nothing recorded)', () => {
  const base = { startedAt: 1, endedAt: 2, chats: ['a'], chatCount: 1, truncated: false };
  for (const bad of [
    undefined, null, 42, 'snapshot', [],
    { ...base, startedAt: undefined },
    { ...base, startedAt: 'soon' },
    { ...base, endedAt: NaN },
    { ...base, chats: 'nope' },
    { ...base, chats: ['ok', 42] },
    { ...base, chats: ['ok', null] },
    { ...base, chatCount: undefined },
    { ...base, chatCount: 1.5 },
    { ...base, chatCount: -1 },
    { ...base, truncated: 'yes' },
    { ...base, truncated: undefined },
  ]) {
    assert.equal(
      buildWorkspaceNamesEvent({ snapshot: bad, schemaVersion: SCHEMA_VERSION }),
      null,
      `malformed snapshot ${JSON.stringify(bad)} must yield null`,
    );
  }
});

test('the HONEST-CAP invariant is enforced at the builder too (count below the list ⇒ null)', () => {
  // A hostile or buggy child claiming a catalog SMALLER than the list it sent
  // would make the cap a lie. The builder refuses it before the wire ever sees
  // it, and the schema refuses it again — defense in depth, not either alone.
  const lying = { startedAt: 1, endedAt: 2, chats: ['a', 'b', 'c'], chatCount: 1, truncated: false };
  assert.equal(buildWorkspaceNamesEvent({ snapshot: lying, schemaVersion: SCHEMA_VERSION }), null);
});

test('the non-identifying labels attach only when supplied', () => {
  const snapshot = realSnapshot(['demo']);
  const bare = buildWorkspaceNamesEvent({ snapshot, schemaVersion: SCHEMA_VERSION });
  assert.ok(!('appVersion' in bare), 'no appVersion when none is supplied');
  assert.ok(!('platform' in bare), 'no platform when none is supplied');
  assert.equal(validateEvent(bare), true, 'and it still validates (both are optional)');

  const labeled = buildWorkspaceNamesEvent({
    snapshot, schemaVersion: SCHEMA_VERSION, appVersion: '0.1.75', platform: 'darwin',
  });
  assert.equal(labeled.appVersion, '0.1.75');
  assert.equal(labeled.platform, 'darwin');
  // An empty / non-string label is omitted rather than stamped blank.
  const empty = buildWorkspaceNamesEvent({
    snapshot, schemaVersion: SCHEMA_VERSION, appVersion: '', platform: 42,
  });
  assert.ok(!('appVersion' in empty));
  assert.ok(!('platform' in empty));
});

test('the built event carries NO field beyond the disclosed shape', () => {
  // The transparency panel's BASE_EVENT_FIELDS for this type IS this key set —
  // a field the builder added silently would be a lie of omission there.
  const event = buildWorkspaceNamesEvent({
    snapshot: realSnapshot(['demo']),
    schemaVersion: SCHEMA_VERSION,
    appVersion: '0.1.75',
    platform: 'linux',
  });
  assert.deepEqual(
    Object.keys(event).sort(),
    ['appVersion', 'chatCount', 'chats', 'platform', 'runtime', 'schemaVersion', 'timestamp', 'truncated', 'type', 'windowEndedAt', 'windowStartedAt'],
  );
});
