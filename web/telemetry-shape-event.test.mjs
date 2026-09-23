// Tests for electron/telemetry-shape-event.cjs (WARDEN-1424) — the main-process
// builder that turns the renderer's 'telemetry:renderer-shape' IPC window into
// a `workspace-shape` schema event, the counts-only shape snapshot riding the
// operational-metrics category.
//
// Pinned here (main.cjs itself can't be required without Electron — the
// telemetry-names-event.cjs / telemetry-stall-event.cjs pattern):
//   • a REAL producer window builds into an event BOTH validators accept — the
//     canonical schema (loaded through vite's OXC transform, like the other
//     schema consumers in this suite family) AND the main-process copy — the
//     END-TO-END proof that the producer's shape and the wire contract agree;
//   • the event's `runtime` is `renderer` and nothing else (the workspace state
//     lives in the renderer's own refs);
//   • CARRIER HYGIENE — the type is COUNTS ONLY by construction: a negative /
//     NaN / float / string count, a missing count, a malformed stamp, or ANY
//     unexpected key (an injected `name` / `path` / `host`, or an identifier
//     field from another category) yields null — nothing recorded, nothing
//     fabricated, and the honest-peak invariant holds at the builder too;
//   • the non-identifying labels are attached only when supplied.
//
// Run: node --test telemetry-shape-event.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { buildWorkspaceShapeEvent } = require('../electron/telemetry-shape-event.cjs');

// Load the CANONICAL schema AND the REAL renderer producer through the same
// OXC transform the other web tests use, so "validates" means the real wire
// contract and the window is the real producer output, not a restatement.
async function loadTs(absPath, tag) {
  const { code } = await transformWithOxc(readFileSync(absPath, 'utf8'), absPath, {});
  const tmpDir = mkdtempSync(join(tmpdir(), `warden-${tag}-`));
  const tmpFile = join(tmpDir, `${tag}.mjs`);
  writeFileSync(tmpFile, code);
  try {
    return await import(tmpFile);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
const schema = await loadTs(join(__dirname, 'src', 'lib', 'telemetry', 'schema.ts'), 'tse-schema');
const { SCHEMA_VERSION, validateEvent } = schema;
const producer = await loadTs(join(__dirname, 'src', 'lib', 'workspaceShapeTelemetry.ts'), 'tse-producer');
const { createWorkspaceShapeSampler } = producer;

// The REAL main-process validator too, so the copies are proven to agree on
// this type rather than assumed to.
const { validateBaseEvent } = require('../electron/telemetry-source.cjs');

/** A window from the REAL producer, so the shapes cannot drift apart. */
function realWindow() {
  const sampler = createWorkspaceShapeSampler({
    stampNow: () => 1_000_000,
    read: () => ({ workspaces: 2, panesOpen: 5, panesActive: 3, chats: 7 }),
  });
  return sampler.flush();
}

// ==========================================================================
// The end-to-end proof: a REAL producer window → a schema-valid event
// ==========================================================================

test('a REAL producer window builds an event BOTH validators accept', () => {
  const event = buildWorkspaceShapeEvent({
    snapshot: realWindow(),
    schemaVersion: SCHEMA_VERSION,
    appVersion: '0.1.77',
    platform: 'linux',
    now: () => 1_000_042,
  });
  assert.ok(event, 'an event is built');
  assert.equal(validateEvent(event), true, 'the CANONICAL schema validates it');
  assert.equal(validateBaseEvent(event), true, 'the MAIN-PROCESS validator agrees');
  assert.equal(event.type, 'workspace-shape');
  assert.equal(event.timestamp, 1_000_042, 'the injected clock stamps it');
  assert.equal(event.workspaces, 2);
  assert.equal(event.panesOpen, 5);
  assert.equal(event.panesActive, 3);
  assert.equal(event.chats, 7, 'chats is the COUNT — never a list, never a name');
});

test('the event is PINNED to the renderer runtime — the workspace state lives in the renderer', () => {
  const event = buildWorkspaceShapeEvent({
    snapshot: realWindow(),
    schemaVersion: SCHEMA_VERSION,
  });
  assert.equal(event.runtime, 'renderer', 'never main, never server');
  // And the validators enforce it, so a mislabeled build cannot ship.
  assert.equal(validateEvent({ ...event, runtime: 'main' }), false);
  assert.equal(validateBaseEvent({ ...event, runtime: 'main' }), false);
  assert.equal(validateEvent({ ...event, runtime: 'server' }), false);
  assert.equal(validateBaseEvent({ ...event, runtime: 'server' }), false);
});

test('the optional non-identifying labels attach only when supplied', () => {
  const bare = buildWorkspaceShapeEvent({ snapshot: realWindow(), schemaVersion: SCHEMA_VERSION });
  assert.equal('appVersion' in bare, false, 'no appVersion invented');
  assert.equal('platform' in bare, false, 'no platform invented');
  const labeled = buildWorkspaceShapeEvent({
    snapshot: realWindow(), schemaVersion: SCHEMA_VERSION, appVersion: '0.1.77', platform: 'darwin',
  });
  assert.equal(labeled.appVersion, '0.1.77');
  assert.equal(labeled.platform, 'darwin');
});

// ==========================================================================
// Carrier hygiene — COUNTS ONLY, by construction
// ==========================================================================

test('a malformed count yields null — negative, NaN, float, string, or missing', () => {
  for (const [key, bad] of [
    ['workspaces', -1], ['panesOpen', NaN], ['panesActive', 2.5], ['chats', 'seven'], ['peakPanesOpen', null],
  ]) {
    const snapshot = realWindow();
    snapshot[key] = bad;
    assert.equal(
      buildWorkspaceShapeEvent({ snapshot, schemaVersion: SCHEMA_VERSION }),
      null,
      `${key}=${String(bad)} is not a count — nothing recorded`,
    );
  }
  const missing = realWindow();
  delete missing.peakChats;
  assert.equal(
    buildWorkspaceShapeEvent({ snapshot: missing, schemaVersion: SCHEMA_VERSION }),
    null,
    'a missing count is not a shape snapshot',
  );
});

test('a malformed window stamp yields null', () => {
  for (const bad of [undefined, 'soon', NaN]) {
    const snapshot = realWindow();
    snapshot.startedAt = bad;
    assert.equal(
      buildWorkspaceShapeEvent({ snapshot, schemaVersion: SCHEMA_VERSION }),
      null,
      `startedAt=${String(bad)} is not a stamp`,
    );
  }
});

test('the honest-peak invariant holds at the builder — a peak below its closing count is a lie', () => {
  const snapshot = realWindow();
  snapshot.peakPanesOpen = snapshot.panesOpen - 1;
  assert.equal(
    buildWorkspaceShapeEvent({ snapshot, schemaVersion: SCHEMA_VERSION }),
    null,
    'peakPanesOpen < panesOpen rejected',
  );
  const snapshot2 = realWindow();
  snapshot2.peakChats = snapshot2.chats - 1;
  assert.equal(
    buildWorkspaceShapeEvent({ snapshot: snapshot2, schemaVersion: SCHEMA_VERSION }),
    null,
    'peakChats < chats rejected',
  );
});

test('an unexpected key yields null — no identifier can ride the counts-only channel', () => {
  for (const injected of [
    { name: 'refactor auth' }, // a chat name riding as a "name"
    { path: '/home/alice/secret/proj' }, // a path
    { host: 'deploy@prod.internal' }, // a hostname / user@host
    { chatName: 'Refactor auth' }, // the names category's gated field
    { sessionName: 'claude-7b3a2f1' }, // its sibling
    { contents: 'cat /etc/passwd' }, // content of any kind
  ]) {
    const snapshot = { ...realWindow(), ...injected };
    assert.equal(
      buildWorkspaceShapeEvent({ snapshot, schemaVersion: SCHEMA_VERSION }),
      null,
      `an injected ${Object.keys(injected)[0]} key is rejected at the builder`,
    );
    // And the canonical schema rejects it too — the builder is the first, not
    // the only, gate on this boundary.
    assert.equal(
      validateEvent({ ...buildWorkspaceShapeEvent({ snapshot: realWindow(), schemaVersion: SCHEMA_VERSION }), ...injected }),
      false,
      `an injected ${Object.keys(injected)[0]} key is rejected by the schema`,
    );
  }
});

test('non-object snapshots yield null — the builder never fabricates a window', () => {
  for (const bad of [null, undefined, 42, 'window', [], true]) {
    assert.equal(
      buildWorkspaceShapeEvent({ snapshot: bad, schemaVersion: SCHEMA_VERSION }),
      null,
      `${String(bad)} is not a window`,
    );
  }
});
