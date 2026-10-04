// Tests for electron/telemetry-usage-event.cjs (WARDEN-1479) — the main-process
// builder that turns the renderer's 'telemetry:renderer-usage' IPC window into
// a `feature-usage` schema event (the telemetry-shape-event.cjs pattern).
//
// Pinned here:
//   • the happy path: a producer window builds a v11-valid event stamped
//     runtime 'renderer', carrying the exact name/count pairs;
//   • CARRIER HYGIENE (the hostile-snapshot census): uppercase / underscore /
//     65+-char / path-shaped / host-shaped names, zero / negative /
//     non-integer counts, duplicate names, an empty window, a window over the
//     schema ceiling, a malformed stamp, and ANY injected extra key — each
//     yields null from the builder AND is rejected by the REAL validators;
//   • a hostile row's extra keys cannot ride into the built event (the
//     builder copies only {name, count});
//   • consent is NOT this module's job (the receipt gates) — asserted by
//     construction: the builder takes no consent input.
//
// Run: node --test telemetry-usage-event.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildFeatureUsageEvent } = require('../electron/telemetry-usage-event.cjs');
const { validateBaseEvent } = require('../electron/telemetry-source.cjs');

const BASE = {
  startedAt: 1_000,
  endedAt: 301_000,
  features: [{ name: 'global-search', count: 2 }, { name: 'settings', count: 1 }],
};

test('happy path: a producer window builds a v11-valid renderer event with the exact pairs', () => {
  const e = buildFeatureUsageEvent({
    snapshot: BASE,
    schemaVersion: 11,
    appVersion: '0.1.83',
    platform: 'linux',
    now: () => 5_000,
  });
  assert.ok(e);
  assert.equal(e.schemaVersion, 11);
  assert.equal(e.type, 'feature-usage');
  assert.equal(e.runtime, 'renderer');
  assert.equal(e.timestamp, 5_000);
  assert.equal(e.windowStartedAt, 1_000);
  assert.equal(e.windowEndedAt, 301_000);
  assert.deepEqual(e.features, [{ name: 'global-search', count: 2 }, { name: 'settings', count: 1 }]);
  assert.equal(e.appVersion, '0.1.83');
  assert.equal(e.platform, 'linux');
  assert.equal(validateBaseEvent(e), true, 'the main-process validator accepts the built event');
});

test('optional labels: absent appVersion/platform are omitted, garbage labels are omitted', () => {
  const e = buildFeatureUsageEvent({ snapshot: BASE, schemaVersion: 11, now: () => 1 });
  assert.ok(e);
  assert.equal('appVersion' in e, false);
  assert.equal('platform' in e, false);
  const e2 = buildFeatureUsageEvent({ snapshot: BASE, schemaVersion: 11, appVersion: 42, platform: null, now: () => 1 });
  assert.ok(e2);
  assert.equal('appVersion' in e2, false);
  assert.equal('platform' in e2, false);
});

test('hostile snapshots are rejected by the builder AND the validators (carrier hygiene)', () => {
  const hostile = (name, patch = {}) => buildFeatureUsageEvent({
    snapshot: { ...BASE, features: [{ name, count: 1 }], ...patch },
    schemaVersion: 11,
    now: () => 1,
  });
  const cases = [
    ['uppercase name', 'Global-Search'],
    ['underscore name', 'global_search'],
    ['65+-char name', 'a'.repeat(65)],
    ['path-shaped name', '../etc/passwd'],
    ['host-shaped name', 'prod.internal'],
    ['chat-name-shaped', 'refactor auth'],
  ];
  for (const [label, name] of cases) {
    const e = hostile(name);
    assert.equal(e, null, `a ${label} is rejected by the builder`);
  }
  // Non-string / empty names.
  assert.equal(hostile(42), null, 'a non-string name is rejected');
  assert.equal(hostile(''), null, 'an empty name is rejected');
  // Counts.
  for (const count of [0, -1, 1.5, 'two', NaN, null]) {
    const e = buildFeatureUsageEvent({
      snapshot: { ...BASE, features: [{ name: 'global-search', count }] },
      schemaVersion: 11, now: () => 1,
    });
    assert.equal(e, null, `a count of ${JSON.stringify(count)} is rejected by the builder`);
  }
  // Window shapes.
  assert.equal(buildFeatureUsageEvent({ snapshot: { ...BASE, features: [] }, schemaVersion: 11, now: () => 1 }), null, 'an empty window is rejected (an idle window never sends)');
  assert.equal(
    buildFeatureUsageEvent({
      snapshot: { ...BASE, features: Array.from({ length: 65 }, (_, i) => ({ name: `feat-${i}`, count: 1 })) },
      schemaVersion: 11, now: () => 1,
    }),
    null,
    'a window over the schema ceiling is rejected, never truncated',
  );
  assert.equal(buildFeatureUsageEvent({ snapshot: { ...BASE, startedAt: 'soon' }, schemaVersion: 11, now: () => 1 }), null, 'a non-numeric stamp is rejected');
  assert.equal(buildFeatureUsageEvent({ snapshot: { ...BASE, endedAt: NaN }, schemaVersion: 11, now: () => 1 }), null, 'a NaN stamp is rejected');
  assert.equal(
    buildFeatureUsageEvent({ snapshot: { ...BASE, features: [{ name: 'a', count: 1 }, { name: 'a', count: 2 }] }, schemaVersion: 11, now: () => 1 }),
    null,
    'a duplicate name (not a folded map) is rejected',
  );
  // Injected top-level extras — the closed key set.
  for (const extra of [
    { chatName: 'Refactor auth' },
    { path: '/home/alice/secret' },
    { host: 'deploy@prod.internal' },
    { sessionName: 'claude-7b3a2f1' },
  ]) {
    assert.equal(buildFeatureUsageEvent({ snapshot: { ...BASE, ...extra }, schemaVersion: 11, now: () => 1 }), null, `an injected ${Object.keys(extra)[0]} key is rejected`);
  }
  // Structural garbage.
  for (const snapshot of [null, undefined, 'window', 42, [], { startedAt: 1 }]) {
    assert.equal(buildFeatureUsageEvent({ snapshot, schemaVersion: 11, now: () => 1 }), null, 'a non-object / non-window snapshot is rejected');
  }
});

test('a hostile ROW cannot smuggle extra keys into the built event', () => {
  const e = buildFeatureUsageEvent({
    snapshot: { ...BASE, features: [{ name: 'global-search', count: 2, chatName: 'Refactor auth' }] },
    schemaVersion: 11,
    now: () => 1,
  });
  // The row-level key check rejects the snapshot outright — the builder never
  // trusts a row it did not shape.
  assert.equal(e, null, 'a row carrying an identifier key is rejected wholesale');
});

test('the builder + validator agree on every rejection (validator cross-check on the survivors)', () => {
  // The one legitimately-built event from each passing shape validates; the
  // builder is a strict subset of the validator (same closed keys, same name
  // pattern, same count rule) so nothing the builder admits can the
  // validator refuse.
  const e = buildFeatureUsageEvent({ snapshot: BASE, schemaVersion: 11, now: () => 1 });
  assert.ok(e);
  assert.equal(validateBaseEvent(e), true);
  // And the validator independently rejects the builder's headline hostiles —
  // defense in depth if a future builder edit loosens.
  const validatorRejects = (features) => validateBaseEvent({
    schemaVersion: 11, type: 'feature-usage', runtime: 'renderer', timestamp: 1,
    windowStartedAt: 1, windowEndedAt: 2, features,
  });
  assert.equal(validatorRejects([{ name: 'Global-Search', count: 1 }]), false, 'validator rejects uppercase');
  assert.equal(validatorRejects([{ name: 'global_search', count: 1 }]), false, 'validator rejects underscore');
  assert.equal(validatorRejects([{ name: 'global-search', count: 0 }]), false, 'validator rejects zero count');
  assert.equal(validatorRejects([{ name: 'global-search', count: -2 }]), false, 'validator rejects negative count');
  assert.equal(validatorRejects([]), false, 'validator rejects empty features');
  assert.equal(validatorRejects([{ name: 'global-search', count: 1 }, { name: 'global-search', count: 1 }]), false, 'validator rejects duplicate names');
  assert.equal(validatorRejects([{ name: 'global-search', count: 1, chatName: 'Refactor auth' }]), false, 'validator rejects a row-borne identifier key (closed row set)');
  const shaped = (patch) => ({
    schemaVersion: 11, type: 'feature-usage', runtime: 'renderer', timestamp: 1,
    windowStartedAt: 1, windowEndedAt: 2,
    features: [{ name: 'global-search', count: 1 }], ...patch,
  });
  assert.equal(validateBaseEvent(shaped({ runtime: 'main' })), false, 'validator pins the renderer runtime');
  assert.equal(validateBaseEvent(shaped({ schemaVersion: 8 })), false, 'validator pins the schema version');
  assert.equal(validateBaseEvent(shaped({ chatName: 'Refactor auth' })), false, 'validator rejects an injected identifier key (closed set)');
});
