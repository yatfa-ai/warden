// Tests for the telemetry VERIFIABILITY engine (WARDEN-508, slice 6 of roadmap
// WARDEN-446 / design WARDEN-443). This module makes the redaction guarantee
// INSPECTABLE: `describeCollection` catalogs exactly what each consent tier
// collects; `previewPayload` previews the exact redacted + validated payload the
// pipeline would transmit for any candidate event. The success criteria (a)–(f)
// below are the roadmap's literal "trust made verifiable" measure.
//
// No front-end test runner in this repo, so (like web/telemetry-redact.test.mjs)
// this loads the REAL web/src/lib/telemetry/transparency.ts (transpiled TS -> ESM
// via Vite's OXC transform) and exercises the PURE functions with plain objects.
//
// HARNESS WRINKLE (decision A): unlike redact.ts (zero runtime imports),
// transparency.ts has a REAL runtime `import … from './redact'`. A lone
// transformed transparency.mjs would fail to resolve './redact'. So this harness
// transforms redact.ts -> tmpDir/redact.mjs AND transparency.ts ->
// tmpDir/transparency.mjs into the SAME tmpDir, then imports transparency.mjs;
// the relative './redact' then resolves to redact.mjs. (The `import type
// { ConsentTier }` is erased at transpile time, exactly as in redact.ts.)
//
// Belt-and-suspenders (decision B): the module carries a LOCAL base-event
// contract copy; the TEST additionally cross-checks `valid` against the REAL
// `validateBaseEvent` (and re-uses the REAL `containsIdentifier` for the
// identifier-leak proof) via `createRequire`, the pattern
// web/telemetry-source.test.mjs uses.
//
// Auto-discovered by `npm run dev:test` (`node --test` in web/).
//
// Run: node telemetry-transparency.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Load the REAL transparency.ts + its './redact' sibling (TS -> ESM via the --
// --- OXC transform Vite bundles), into the SAME tmpDir so the relative import --
// --- resolves. ---------------------------------------------------------------
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-transparency-test-'));
for (const name of ['redact', 'transparency']) {
  const modPath = resolve(__dirname, `src/lib/telemetry/${name}.ts`);
  const src = readFileSync(modPath, 'utf8');
  let { code } = await transformWithOxc(src, modPath, {});
  // Node ESM requires an explicit extension on the relative specifier, but the
  // TS source (correctly) uses extensionless './redact' (resolved by Vite at
  // build time). Patch ONLY the emitted test artifact so the './redact' import
  // resolves to the sibling redact.mjs written below.
  if (name === 'transparency') {
    code = code.replace(/from\s+(["'])\.\/redact\1/, 'from $1./redact.mjs$1');
  }
  writeFileSync(join(tmpDir, `${name}.mjs`), code);
}
const { describeCollection, previewPayload, isValidBaseEvent, SCHEMA_VERSION } = await import(
  join(tmpDir, 'transparency.mjs')
);
rmSync(tmpDir, { recursive: true, force: true });

// Belt-and-suspenders: the REAL main-process validator (exported) for the
// schema-validity cross-check (criterion b).
const { validateBaseEvent } = require('../electron/telemetry-source.cjs');

// The identifier-leak PROOF shape — mirrors telemetry-source.cjs:77-91 (the five
// patterns) + :249-258 (the combine). Re-implemented here INDEPENDENTLY of the
// module under test (the source does not export containsIdentifier) so criterion
// (e) is a self-contained proof, not the module checking itself. Non-global
// regexes → stateless `.test`, no lastIndex hazard (same as the source).
const ID_PROOF = {
  path: /(?:[A-Za-z]:[\\/]|[\\/]|~\/|\.(?:\.)?\/)(?:[^\s:'"<>|*?]+[\\/])*[^\s:'"<>|*?\\/]*/,
  userhost: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/,
  ipv4: /(?:\d{1,3}\.){3}\d{1,3}/,
  ipv6: /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*::[0-9a-fA-F:]*|::[0-9a-fA-F:]+/,
  hostname: /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}\b/,
};
function containsIdentifier(text) {
  if (typeof text !== 'string' || text === '') return false;
  return (
    ID_PROOF.path.test(text) ||
    ID_PROOF.userhost.test(text) ||
    ID_PROOF.ipv4.test(text) ||
    ID_PROOF.ipv6.test(text) ||
    ID_PROOF.hostname.test(text)
  );
}

// A source-code filename basename (final dot-segment is a known source
// extension). Independently re-implemented here (the redactor does not export
// its set) to mirror WARDEN-680's scoping: such a basename in a stack frame's
// file/function is NON-identifying for warden's own code (schema designates
// function/file/line non-identifying; the directory is dropped at the
// collection boundary, leaving only the basename) and the redactor intentionally
// PRESERVES it. A host-shaped value (`api.github.com` → `.com`) is NOT a source
// basename, so the leak proof still flags it.
const SOURCE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'cjs', 'mjs', 'mts', 'json', 'json5', 'jsonc',
  'html', 'htm', 'css', 'scss', 'sass', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'go', 'rs', 'java', 'rb', 'cs', 'cpp', 'cc', 'cxx', 'hpp', 'hxx',
  'php', 'swift', 'kt', 'scala', 'lua', 'pl', 'sh', 'bash', 'zsh', 'ps1',
  'sql', 'graphql', 'proto', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf',
  'env', 'map',
]);
function isSourceBasename(token) {
  if (typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Recurse a payload and collect every string value — used by the identifier-
// leak proof (criterion e) to assert NO string carries a path/host/IP/user@host.
// Each entry is tagged with whether it is a stack frame's `file`/`function`
// field: those carry a NON-identifying source basename (WARDEN-680) that the
// redactor intentionally preserves, so the proof exempts a recognized source
// basename there while STILL flagging a host-shaped frame value. The `frames`
// array is detected at any depth (top-level or nested under `error`).
function collectStrings(v, out, inFrameMember) {
  if (typeof v === 'string') {
    out.push({ s: v, frameField: !!inFrameMember });
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, false);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const lower = String(k).toLowerCase();
      if (lower === 'frames' && Array.isArray(x)) {
        // Each element is a StackFrame object; mark its file/function children.
        for (const frame of x) collectStrings(frame, out, true);
      } else {
        collectStrings(x, out, inFrameMember && (lower === 'file' || lower === 'function'));
      }
    }
  }
}

// GitHub classic PAT: `ghp_` + 36 chars — caught by the known-format rule.
const GH_TOKEN = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

// A well-formed ERROR base-event candidate whose free-text message carries one
// of every hard-exclusion category (path, hostname, Authorization header),
// alongside tier-gated identifier + content fields. After redaction it MUST
// still conform to the schema (valid === true) — criterion (b).
const CANDIDATE = {
  schemaVersion: SCHEMA_VERSION,
  type: 'error',
  runtime: 'renderer',
  timestamp: 1719500000123,
  // A non-identifying release label (WARDEN-665). Neither content nor an
  // identifier → it must SURVIVE redaction unredacted at every tier, which the
  // preview must disclose (a transparency panel that hides a collected field is
  // a lie of omission even when the data is benign).
  appVersion: '0.1.19',
  // A non-identifying OS label (WARDEN-684). Same trust posture as appVersion
  // (neither content nor an identifier) → it too must SURVIVE redaction unredacted
  // at every tier, which the preview must disclose.
  platform: 'darwin',
  name: 'Error',
  message:
    'Failed to load /home/alice/.ssh/aws-creds from host prod-db-01.corp.local (Authorization: Bearer ' +
    GH_TOKEN +
    ')',
  frames: [{ function: 'loadCreds', file: 'loader.js' }],
  // Tier-gated: kept (scrubbed) only at extended.
  chatName: 'deploy@prod.internal refactor',
  sessionName: 'claude-7b3a2f1',
  // Hard-excluded at every tier.
  content: 'User asked for the production database password',
  prompt: 'Run: ssh ubuntu@10.0.0.5 with the deploy key',
};

console.log('\n(a) describeCollection — tier catalog of what is collected');

test('describeCollection(base) lists ONLY anonymous fields (no chat/session-name fields)', () => {
  const cat = describeCollection('base');
  assert.equal(cat.tier, 'base');
  assert.equal(cat.collectsBaseEvents, true);
  assert.equal(cat.collectsIdentifiers, false);
  assert.deepEqual(cat.identifierFields, []);
  // All three anonymous base-event types, each with its anonymous fields.
  assert.deepEqual(
    cat.eventTypes.map((e) => e.type),
    ['error', 'crash', 'performance-stall'],
  );
  // The identifier field names are the ones extended collects; NONE of them may
  // appear among the base-tier event fields. (An error event's `name` is the
  // anonymous Error-class name, NOT a chat/session-name identifier.)
  const idFields = new Set(describeCollection('extended').identifierFields);
  for (const et of cat.eventTypes) {
    assert.ok(et.fields.length > 0, `${et.type} lists its anonymous fields`);
    for (const f of et.fields) {
      assert.ok(!idFields.has(f.toLowerCase()), `no identifier field at base: ${f}`);
    }
  }
});

test('describeCollection(extended) ADDITIONALLY lists the chat/session-name identifier fields', () => {
  const cat = describeCollection('extended');
  assert.equal(cat.collectsBaseEvents, true);
  assert.equal(cat.collectsIdentifiers, true);
  assert.ok(cat.identifierFields.length > 0, 'extended collects identifier fields');
  assert.ok(cat.identifierFields.includes('chatname'), 'chat name advertised at extended');
  assert.ok(cat.identifierFields.includes('sessionname'), 'session name advertised at extended');
  // Base events are still the same three anonymous types.
  assert.equal(cat.eventTypes.length, 3);
});

test('describeCollection(off / unknown / undefined) collects NOTHING (most-redacted)', () => {
  for (const t of ['off', 'unknown', undefined, null, 'garbage']) {
    const cat = describeCollection(t);
    assert.equal(cat.collectsBaseEvents, false, `no base events at tier ${t}`);
    assert.equal(cat.collectsIdentifiers, false, `no identifiers at tier ${t}`);
    assert.deepEqual(cat.eventTypes, [], `no event types at tier ${t}`);
    assert.deepEqual(cat.identifierFields, [], `no identifier fields at tier ${t}`);
  }
});

test('describeCollection lists content/prompt fields as HARD-EXCLUDED at every tier', () => {
  for (const t of ['base', 'extended', 'off']) {
    const cat = describeCollection(t);
    assert.ok(cat.hardExcludedContent.includes('content'), `content hard-excluded at ${t}`);
    assert.ok(cat.hardExcludedContent.includes('prompt'), `prompt hard-excluded at ${t}`);
    assert.ok(cat.hardExcludedContent.includes('messages'), `messages hard-excluded at ${t}`);
  }
});

test('describeCollection DISCLOSES the optional appVersion? field on every base-event type (WARDEN-665)', () => {
  // The transparency panel's contract is to list EVERY field a tier collects.
  // Production attaches appVersion to every emitted event, so it MUST appear in
  // the disclosed field catalog — modeled with the `?` suffix (like `exitCode?`)
  // to document that a v2 event WITHOUT it still validates. This is the forcing
  // function: removing appVersion? from BASE_EVENT_FIELDS turns this red.
  for (const tier of ['base', 'extended']) {
    const cat = describeCollection(tier);
    assert.equal(cat.eventTypes.length, 3, `three event types at ${tier}`);
    for (const et of cat.eventTypes) {
      assert.ok(
        et.fields.includes('appVersion?'),
        `${et.type} discloses optional appVersion? at ${tier}`,
      );
    }
  }
  // appVersion is a release label, NOT an identifier — it must not be classified
  // as a chat/session-name identifier field (those are extended-only).
  for (const tier of ['base', 'extended', 'off']) {
    const cat = describeCollection(tier);
    for (const id of cat.identifierFields) {
      assert.ok(!/appversion/.test(id), `appVersion is not an identifier field at ${tier}`);
    }
  }
});

test('describeCollection DISCLOSES the optional platform? field on every base-event type (WARDEN-684)', () => {
  // The transparency panel's contract is to list EVERY field a tier collects.
  // Production attaches platform to every emitted event, so it MUST appear in the
  // disclosed field catalog — modeled with the `?` suffix to document that a v3
  // event WITHOUT it still validates. Removing platform? from BASE_EVENT_FIELDS
  // turns this red.
  for (const tier of ['base', 'extended']) {
    const cat = describeCollection(tier);
    assert.equal(cat.eventTypes.length, 3, `three event types at ${tier}`);
    for (const et of cat.eventTypes) {
      assert.ok(
        et.fields.includes('platform?'),
        `${et.type} discloses optional platform? at ${tier}`,
      );
    }
  }
  // platform is an OS label, NOT an identifier — it must not be classified as a
  // chat/session-name identifier field (those are extended-only).
  for (const tier of ['base', 'extended', 'off']) {
    const cat = describeCollection(tier);
    for (const id of cat.identifierFields) {
      assert.ok(!/platform/.test(id), `platform is not an identifier field at ${tier}`);
    }
  }
});

console.log('\n(b) previewPayload — path/host/Authorization redacted + schema-valid');

test('previewPayload replaces the file path, hostname, and Authorization header with [REDACTED:…]', () => {
  const { payload, valid } = previewPayload(CANDIDATE, 'base');
  assert.equal(valid, true, 'a well-formed redacted error event is valid');
  const s = JSON.stringify(payload);
  assert.ok(s.includes('[REDACTED:path]'), 'file path replaced with [REDACTED:path]');
  assert.ok(s.includes('[REDACTED:host]'), 'hostname replaced with [REDACTED:host]');
  assert.ok(s.includes('[REDACTED:token]'), 'Authorization header replaced with [REDACTED:token]');
  // The raw sensitive material is gone.
  assert.doesNotMatch(s, /\/home\/alice/);
  assert.doesNotMatch(s, /prod-db-01\.corp\.local/);
  assert.doesNotMatch(s, /ghp_/);
  // Belt-and-suspenders: the REAL main-process validator agrees the payload is valid.
  assert.equal(validateBaseEvent(payload), true, 'real validateBaseEvent agrees valid');
});

test('a non-identifying appVersion release label SURVIVES redaction unredacted at every tier (WARDEN-665)', () => {
  // appVersion is neither a content/prompt field nor a chat/session-name
  // identifier, so the redactor neither drops nor rewrites it. This is exactly
  // what the transparency panel's live preview must SHOW: a benign release label
  // passing through intact — reinforcing, not undermining, the trust model.
  for (const t of ['base', 'extended', 'off', 'unknown', undefined]) {
    const { payload } = previewPayload(CANDIDATE, t);
    assert.equal(payload.appVersion, '0.1.19', `appVersion survives unredacted at tier ${t}`);
    // And it is never enumerated as a redaction change (it was not transformed).
    const re = previewPayload(CANDIDATE, t);
    const touched = re.changes.some((c) => c.path === 'appVersion');
    assert.equal(touched, false, `appVersion is never a redacted/dropped path at tier ${t}`);
  }
});

test('a non-identifying platform OS label SURVIVES redaction unredacted at every tier (WARDEN-684)', () => {
  // platform is neither a content/prompt field nor a chat/session-name identifier,
  // so the redactor neither drops nor rewrites it. Same as appVersion: a benign OS
  // label (darwin/win32/linux) passing through intact — what the transparency
  // panel's live preview must SHOW.
  for (const t of ['base', 'extended', 'off', 'unknown', undefined]) {
    const { payload } = previewPayload(CANDIDATE, t);
    assert.equal(payload.platform, 'darwin', `platform survives unredacted at tier ${t}`);
    const re = previewPayload(CANDIDATE, t);
    const touched = re.changes.some((c) => c.path === 'platform');
    assert.equal(touched, false, `platform is never a redacted/dropped path at tier ${t}`);
  }
});

test('previewPayload is valid for a well-formed crash and performance-stall event too', () => {
  const crash = previewPayload(
    { schemaVersion: SCHEMA_VERSION, type: 'crash', runtime: 'renderer', timestamp: 1, reason: 'oom' },
    'base',
  );
  assert.equal(crash.valid, true);
  assert.equal(validateBaseEvent(crash.payload), true);
  const stall = previewPayload(
    { schemaVersion: SCHEMA_VERSION, type: 'performance-stall', runtime: 'main', timestamp: 1, lagMs: 2500, source: 'event-loop' },
    'base',
  );
  assert.equal(stall.valid, true);
  assert.equal(validateBaseEvent(stall.payload), true);
});

test('previewPayload flags an INVALID candidate (missing required field) without throwing', () => {
  // No message/name/frames → not a conformant error event.
  const bad = previewPayload({ schemaVersion: SCHEMA_VERSION, type: 'error', runtime: 'renderer', timestamp: 1 }, 'base');
  assert.equal(bad.valid, false);
  assert.equal(isValidBaseEvent(bad.payload), false);
  // Unknown event type → invalid.
  const unknown = previewPayload(
    { schemaVersion: SCHEMA_VERSION, type: 'mystery', runtime: 'renderer', timestamp: 1 },
    'base',
  );
  assert.equal(unknown.valid, false);
  // A primitive (non-event) → invalid, changes still enumerated.
  const prim = previewPayload('leak: AKIAIOSFODNN7EXAMPLE at /etc/shadow', 'base');
  assert.equal(prim.valid, false);
  assert.equal(prim.payload, 'leak: [REDACTED:aws-key] at [REDACTED:path]');
});

console.log('\n(c) content field is absent from the preview at EVERY tier');

test('content + prompt fields are absent at every tier (dropped wholesale)', () => {
  for (const t of ['base', 'extended', 'off', 'unknown', undefined]) {
    const { payload } = previewPayload(CANDIDATE, t);
    const p = payload || {};
    assert.equal(p.content, undefined, `content absent at tier ${t}`);
    assert.equal(p.prompt, undefined, `prompt absent at tier ${t}`);
    assert.ok(!('content' in p), `content key absent at tier ${t}`);
    assert.ok(!('prompt' in p), `prompt key absent at tier ${t}`);
    // The content text never leaks anywhere.
    assert.doesNotMatch(JSON.stringify(payload), /production database password/);
    assert.doesNotMatch(JSON.stringify(payload), /ssh ubuntu/);
  }
});

console.log('\n(d) chatName absent at base/off/unknown, present (scrubbed) at extended');

test('chatName / sessionName ABSENT at base / off / unknown / undefined', () => {
  for (const t of ['base', 'off', 'unknown', undefined, null]) {
    const { payload } = previewPayload(CANDIDATE, t);
    assert.equal(payload.chatName, undefined, `chatName absent at tier ${t}`);
    assert.equal(payload.sessionName, undefined, `sessionName absent at tier ${t}`);
    assert.ok(!('chatName' in payload), `chatName key absent at tier ${t}`);
  }
});

test('chatName / sessionName PRESENT (scrubbed) at extended', () => {
  const { payload } = previewPayload(CANDIDATE, 'extended');
  assert.ok('chatName' in payload, 'chatName present at extended');
  assert.ok('sessionName' in payload, 'sessionName present at extended');
  // Retained, but scrubbed: the raw chatName carried a user@host that must not survive.
  assert.doesNotMatch(payload.chatName, /deploy@prod\.internal/);
  assert.equal(containsIdentifier(payload.chatName), false, 'retained chatName is scrubbed of identifiers');
});

console.log('\n(e) PROOF — no identifier pattern survives ANY preview');

test('no path / host / IPv4 / IPv6 / user@host survives any preview (re-uses containsIdentifier)', () => {
  for (const t of ['base', 'extended', 'off', 'unknown', undefined]) {
    const { payload } = previewPayload(CANDIDATE, t);
    const strings = [];
    collectStrings(payload, strings);
    for (const { s, frameField } of strings) {
      // A frame file/function source basename is NON-identifying (WARDEN-680) and
      // intentionally preserved — exempt it ONLY when it is a recognized source
      // basename, so a host-shaped frame value (api.github.com) is still caught.
      if (frameField && isSourceBasename(s)) continue;
      assert.equal(containsIdentifier(s), false, `identifier leaked at tier ${t}: ${s}`);
    }
  }
});

test('a stack frame source basename SURVIVES previewPayload (WARDEN-680 — non-identifying debug value)', () => {
  // The redactor preserves a frame.file/function source basename; the preview is
  // the EXACT transmitted payload, so it must reflect `loader.js`/`loadCreds`,
  // NOT [REDACTED:host]. The single most useful debug field stays actionable.
  for (const t of ['base', 'extended']) {
    const { payload } = previewPayload(CANDIDATE, t);
    const frame = payload.frames[0];
    assert.equal(frame.file, 'loader.js', `frame.file basename preserved @ ${t}`);
    assert.equal(frame.function, 'loadCreds', `frame.function preserved @ ${t}`);
    assert.doesNotMatch(frame.file, /REDACTED/, `frame.file not clobbered @ ${t}`);
  }
});

test('a candidate packed with every identifier shape is fully scrubbed at every tier', () => {
  const packed = {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    runtime: 'main',
    timestamp: 1,
    name: 'Error',
    message: 'path /etc/shadow host 10.0.0.5 v6 fe80::1 mail ops@example.com fqdn db.internal.local',
    frames: [],
  };
  for (const t of ['base', 'extended', 'off']) {
    const { payload, valid } = previewPayload(packed, t);
    assert.equal(valid, true, `packed event still valid after scrub at tier ${t}`);
    const strings = [];
    collectStrings(payload, strings);
    for (const { s, frameField } of strings) {
      if (frameField && isSourceBasename(s)) continue;
      assert.equal(containsIdentifier(s), false, `identifier survived at tier ${t}: ${s}`);
    }
  }
});

console.log('\n(f) determinism + non-mutation');

test('describeCollection is deterministic — stable across calls (pure)', () => {
  assert.deepEqual(describeCollection('base'), describeCollection('base'));
  assert.deepEqual(describeCollection('extended'), describeCollection('extended'));
  assert.deepEqual(describeCollection('off'), describeCollection('off'));
});

test('previewPayload is deterministic — same input+tier yields equal results', () => {
  assert.deepEqual(previewPayload(CANDIDATE, 'base'), previewPayload(CANDIDATE, 'base'));
  assert.deepEqual(previewPayload(CANDIDATE, 'extended'), previewPayload(CANDIDATE, 'extended'));
});

test('previewPayload does NOT mutate its input (defensive copy)', () => {
  const snapshot = JSON.parse(JSON.stringify(CANDIDATE));
  previewPayload(CANDIDATE, 'extended');
  previewPayload(CANDIDATE, 'base');
  assert.deepEqual(CANDIDATE, snapshot, 'original CANDIDATE must be byte-for-byte unchanged');
});

console.log('\nchanges — enumerated diff of what redaction did');

test('changes enumerate dropped content, dropped/retained identifiers, and redacted substitutions', () => {
  const base = previewPayload(CANDIDATE, 'base');
  const kinds = base.changes.map((c) => c.kind);
  assert.ok(kinds.includes('dropped-content'), 'content drop recorded');
  assert.ok(kinds.includes('dropped-identifier'), 'identifier drop recorded at base');
  assert.ok(!kinds.includes('retained-identifier'), 'no retained identifier at base');

  // The message had a path, a hostname, and an Authorization header — each
  // enumerated as a distinct [REDACTED:…] category on the message path.
  const msgCats = base.changes
    .filter((c) => c.kind === 'redacted' && c.path === 'message')
    .map((c) => c.category)
    .sort();
  assert.ok(msgCats.includes('path'), 'path redaction recorded on message');
  assert.ok(msgCats.includes('host'), 'host redaction recorded on message');
  assert.ok(msgCats.includes('token'), 'token/header redaction recorded on message');
  // counts are positive integers.
  for (const c of base.changes) {
    if (c.kind === 'redacted') assert.ok(c.count >= 1, 'redacted change has a positive count');
  }

  const ext = previewPayload(CANDIDATE, 'extended');
  const extKinds = ext.changes.map((c) => c.kind);
  assert.ok(extKinds.includes('retained-identifier'), 'identifier retained at extended');
  // The retained chatName carried a user@host → a redacted substitution is recorded too.
  const chatRedactions = ext.changes.filter((c) => c.kind === 'redacted' && c.path === 'chatName');
  assert.ok(chatRedactions.some((c) => c.category === 'host'), 'retained chatName scrubbed of embedded host');
});

console.log(`\n✓ TELEMETRY TRANSPARENCY TESTS PASS (${passed})`);
