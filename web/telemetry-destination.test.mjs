// Regression tests for the WARDEN-557 "is anything being sent, and to where?"
// derivation: `telemetryDestinationLabel` (raw endpoint -> host) and
// `deriveTelemetrySendingStatus` (the off/unconfigured/configured state machine).
//
// The telemetry subsystem is the most unit-tested part of web/ — every sibling
// pure-logic module ships a *.test.mjs (client, schema, redact, source, pipeline,
// live-wire). destination.ts is extracted purely so its logic is "plain,
// side-effect-free, and verifiable independent of the DOM" (its own doc comment);
// these tests are that verification, committed rather than a throwaway probe.
//
// What is being guarded here is NOT the happy path but the DANGEROUS properties —
// the ones a future "simplification" could silently break:
//   - NO PATH LEAK — the destination label is host-only, never the path. The
//     label is privacy-relevant: it must never echo a sensitive path the user
//     typed into the endpoint field. A change to `.href` / `.origin + .pathname`
//     must turn this test red.
//   - WHITESPACE = UNCONFIGURED — a whitespace-only endpoint reads as the
//     silently-inert opt-in (the core case the ticket exists to surface), not
//     as a configured destination.
//   - bare-host lenient parse, port retention, garbage -> raw fallback.
//
// No front-end test runner in this repo, so (like telemetry-client.test.mjs)
// this loads the REAL web/src/lib/telemetry/destination.ts (transpiled TS -> ESM
// via Vite's OXC transform). destination.ts has no relative imports, so this is
// the simpler single-file variant — one module transpiled into a tmp dir.
//
// Auto-discovered by `npm test` (`node --test` in web/).
//
// Run: node telemetry-destination.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Transpile destination.ts (single file, no relative imports) into a tmp dir ---
const destinationPath = resolve(__dirname, 'src/lib/telemetry/destination.ts');
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-destination-test-'));
const { code: destinationCode } = await transformWithOxc(
  readFileSync(destinationPath, 'utf8'),
  destinationPath,
  {},
);
writeFileSync(join(tmpDir, 'destination.mjs'), destinationCode);
const { telemetryDestinationLabel, deriveTelemetrySendingStatus } = await import(
  join(tmpDir, 'destination.mjs')
);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// ==========================================================================
// telemetryDestinationLabel — raw endpoint -> destination host
// ==========================================================================

test('an empty endpoint yields an empty label (callers treat this as unconfigured)', () => {
  assert.equal(telemetryDestinationLabel(''), '');
});

test('a whitespace-only endpoint yields an empty label', () => {
  assert.equal(telemetryDestinationLabel('   '), '');
  assert.equal(telemetryDestinationLabel('\t\n '), '', 'tabs/newlines count as blank');
});

// THE PRIVACY GUARD. The label must be host-only: it may never echo the path of
// the URL the user typed. A receiver ingest path can be sensitive; surfacing it
// in the Settings UI would leak it. If anyone "simplifies" this to .href or
// .origin + .pathname, this assertion goes red.
test('NO PATH LEAK — a full URL with a deep path yields the host only, never the path', () => {
  assert.equal(
    telemetryDestinationLabel('https://receiver.example/ingest/v1'),
    'receiver.example',
    'path /ingest/v1 must not appear in the label',
  );
  assert.equal(
    telemetryDestinationLabel('https://receiver.example/secret/ingest'),
    'receiver.example',
    'a sensitive path must never be echoed',
  );
});

test('port retention — the host keeps its port, but the path is still stripped', () => {
  assert.equal(
    telemetryDestinationLabel('https://receiver.example:8080/ingest/v1'),
    'receiver.example:8080',
    'port kept, path stripped',
  );
  assert.equal(
    telemetryDestinationLabel('http://localhost:3000/api/events'),
    'localhost:3000',
  );
  assert.equal(
    telemetryDestinationLabel('http://192.168.1.5:9000/ingest'),
    '192.168.1.5:9000',
    'IPv4 + port retained',
  );
});

test('bare-host lenient parse — a scheme-less host with a path still yields the host', () => {
  // The common self-hoster mistake: typing `receiver.example/ingest` with no
  // https://. The strict parse throws; the lenient retry surfaces a clean host.
  assert.equal(telemetryDestinationLabel('receiver.example/ingest'), 'receiver.example');
  assert.equal(telemetryDestinationLabel('receiver.example'), 'receiver.example');
});

test('surrounding whitespace is trimmed before deriving the host', () => {
  assert.equal(telemetryDestinationLabel('  https://r.example/x  '), 'r.example');
});

test('garbage that cannot parse falls back to the raw trimmed value rather than throwing', () => {
  assert.doesNotThrow(() => telemetryDestinationLabel(':::not a url'));
  assert.equal(telemetryDestinationLabel(':::not a url'), ':::not a url');
  assert.equal(
    telemetryDestinationLabel('not a url with spaces'),
    'not a url with spaces',
  );
});

// ==========================================================================
// deriveTelemetrySendingStatus — the off / unconfigured / configured machine
// ==========================================================================

test('base OFF is OFF regardless of endpoint (off is off)', () => {
  assert.deepEqual(deriveTelemetrySendingStatus({ baseEnabled: false, endpoint: '' }), {
    kind: 'off',
  });
  assert.deepEqual(
    deriveTelemetrySendingStatus({ baseEnabled: false, endpoint: 'https://r.example/ingest' }),
    { kind: 'off' },
    'a configured endpoint does not override base OFF',
  );
});

// THE CORE CASE THE TICKET EXISTS TO SURFACE. Base is on but the endpoint is
// blank — the opt-in is silently inert (transport no-ops, events buffer + drop).
test('base ON + empty endpoint -> unconfigured (the silently-inert opt-in)', () => {
  assert.deepEqual(deriveTelemetrySendingStatus({ baseEnabled: true, endpoint: '' }), {
    kind: 'unconfigured',
  });
});

test('base ON + whitespace-only endpoint -> unconfigured (whitespace is not a configured endpoint)', () => {
  assert.deepEqual(deriveTelemetrySendingStatus({ baseEnabled: true, endpoint: '   ' }), {
    kind: 'unconfigured',
  });
});

test('base ON + configured endpoint -> configured, with a host-only destination', () => {
  assert.deepEqual(
    deriveTelemetrySendingStatus({ baseEnabled: true, endpoint: 'https://receiver.example/ingest/v1' }),
    { kind: 'configured', destination: 'receiver.example' },
  );
});

// Privacy property enforced at the status layer too: the destination carried in
// the `configured` status is host-only — the path never reaches the UI via this
// status object.
test('NO PATH LEAK through the configured status — destination is host-only', () => {
  const status = deriveTelemetrySendingStatus({
    baseEnabled: true,
    endpoint: 'https://receiver.example/secret/ingest',
  });
  assert.equal(status.kind, 'configured');
  if (status.kind === 'configured') {
    assert.equal(status.destination, 'receiver.example');
    assert.doesNotMatch(status.destination, /secret|ingest/, 'path must not leak');
  }
});

console.log(`\n✓ TELEMETRY-DESTINATION TESTS PASS (${passed})`);
