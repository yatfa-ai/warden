// Tests for the telemetry VERIFIABILITY engine (WARDEN-508, slice 6 of roadmap
// WARDEN-446 / design WARDEN-443). This module makes the redaction guarantee
// INSPECTABLE: `describeCollection` catalogs exactly what a PER-CATEGORY consent
// state collects; `previewPayload` previews the exact redacted + validated
// payload the pipeline would transmit for any candidate event. The success
// criteria (a)–(f) below are the roadmap's literal "trust made verifiable"
// measure, re-expressed over per-category consent by WARDEN-1116 — including the
// combinations the old three-value tier could not express.
//
// No front-end test runner in this repo, so (like web/telemetry-redact.test.mjs)
// this loads the REAL web/src/lib/telemetry/transparency.ts (transpiled TS -> ESM
// via Vite's OXC transform) and exercises the PURE functions with plain objects.
//
// HARNESS WRINKLE (decision A): transparency.ts has REAL runtime imports —
// './redact', './consent' and (since WARDEN-1254) './schema', the canonical
// base-event contract the module now consumes instead of restating. A lone
// transformed transparency.mjs would fail to resolve them, so this harness
// transforms consent.ts, redact.ts, schema.ts AND transparency.ts into the
// SAME tmpDir and rewrites the relative specifiers to the .mjs paths Node
// resolves.
//
// Belt-and-suspenders (decision B): the module's base-event contract is
// consumed from canonical schema.ts (WARDEN-1254 — it used to carry a LOCAL
// copy); the TEST additionally cross-checks `valid` against the REAL
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
for (const name of ['consent', 'redact', 'schema', 'transparency']) {
  const modPath = resolve(__dirname, `src/lib/telemetry/${name}.ts`);
  const src = readFileSync(modPath, 'utf8');
  let { code } = await transformWithOxc(src, modPath, {});
  // Node ESM requires an explicit extension on a relative specifier, but the TS
  // sources (correctly) use extensionless './redact' / './consent' (resolved by
  // Vite at build time). Patch ONLY the emitted test artifacts.
  code = code
    .replace(/from\s+(["'])\.\/redact\1/g, 'from "./redact.mjs"')
    .replace(/from\s+(["'])\.\/consent\1/g, 'from "./consent.mjs"')
    .replace(/from\s+(["'])\.\/schema\1/g, 'from "./schema.mjs"');
  writeFileSync(join(tmpDir, `${name}.mjs`), code);
}
const { describeCollection, previewPayload, isValidBaseEvent, SCHEMA_VERSION } = await import(
  join(tmpDir, 'transparency.mjs')
);
rmSync(tmpDir, { recursive: true, force: true });

// Named consent states this suite exercises. INCIDENTS_ONLY / BOTH are the two
// the old base/extended tiers could express; NAMES_ONLY is the combination they
// could NOT, and NOTHING is the default.
const NOTHING = {};
const INCIDENTS_ONLY = { incidents: true, names: false };
const NAMES_ONLY = { incidents: false, names: true };
const BOTH = { incidents: true, names: true };
// Every shape a corrupt / missing / stale-tier persisted value can take. All of
// them must resolve to nothing enabled.
const DEGENERATE = [NOTHING, undefined, null, 'base', 'extended', 'off', 'garbage', 42, [], { unknown: true }, { incidents: 'yes' }];
const cat = (c) => describeCollection(c);
const catOf = (c, id) => describeCollection(c).categories.find((x) => x.id === id);

// Belt-and-suspenders: the REAL main-process validator (exported) for the
// schema-validity cross-check (criterion b).
const { validateBaseEvent } = require('../electron/telemetry-source.cjs');

// The identifier-leak PROOF shape — mirrors telemetry-source.cjs:77-91 (the five
// patterns) + :249-258 (the combine). Re-implemented here INDEPENDENTLY of the
// module under test — DELIBERATELY, so criterion (e) is a self-contained proof
// rather than the module checking itself. (This re-implementation is NOT a
// workaround for a missing export: transparency.ts:101 does export
// `containsIdentifier`. Importing it would make (e) tautological — the redactor's
// output would be judged by the very predicate the redactor's own module ships —
// so the copy stays. Corrected by WARDEN-1180; the old note claimed the symbol
// was unexported, which is false today.) Non-global regexes → stateless `.test`,
// no lastIndex hazard (same as the source).
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
// alongside category-gated identifier + content fields. After redaction it MUST
// still conform to the schema (valid === true) — criterion (b).
const CANDIDATE = {
  schemaVersion: SCHEMA_VERSION,
  type: 'error',
  runtime: 'renderer',
  timestamp: 1719500000123,
  // A non-identifying release label (WARDEN-665). Neither content nor an
  // identifier → it must SURVIVE redaction unredacted under every consent, which the
  // preview must disclose (a transparency panel that hides a collected field is
  // a lie of omission even when the data is benign).
  appVersion: '0.1.19',
  // A non-identifying OS label (WARDEN-684). Same trust posture as appVersion
  // (neither content nor an identifier) → it too must SURVIVE redaction unredacted
  // under every consent, which the preview must disclose.
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
  // Hard-excluded under every consent.
  content: 'User asked for the production database password',
  prompt: 'Run: ssh ubuntu@10.0.0.5 with the deploy key',
};

console.log('\n(a) describeCollection — PER-CATEGORY catalog of what is collected');

test('every category is listed, in registry order, with its enabled state', () => {
  const c = cat(INCIDENTS_ONLY);
  assert.deepEqual(c.categories.map((x) => x.id), ['incidents', 'names', 'operational-metrics']);
  assert.equal(catOf(INCIDENTS_ONLY, 'incidents').enabled, true);
  assert.equal(catOf(INCIDENTS_ONLY, 'names').enabled, false);
  assert.deepEqual([...c.enabled], ['incidents']);
});

test('incidents-only collects the four anonymous event types and NO identifier fields', () => {
  const c = cat(INCIDENTS_ONLY);
  assert.equal(c.collectsAnything, true);
  // WARDEN-1278 — `server-stall` joined this category: a freeze in the BACKEND
  // child is an incident, so it rides `incidents` rather than earning a new
  // checkbox. It is disclosed HERE because the panel's contract is to list every
  // event type a category produces — a silently-added type would be exactly the
  // lie of omission this surface exists to prevent.
  assert.deepEqual(c.eventTypes.map((e) => e.type), ['error', 'crash', 'performance-stall', 'server-stall']);
  assert.deepEqual(c.retainedFields, [], 'no chat/session-name fields are retained');
  // No identifier field name may appear among the anonymous event fields. (An
  // error event's `name` is the Error CLASS name, not a chat/session identifier.)
  const idFields = new Set(catOf(BOTH, 'names').fields);
  for (const et of c.eventTypes) {
    assert.ok(et.fields.length > 0, `${et.type} lists its anonymous fields`);
    for (const f of et.fields) {
      assert.ok(!idFields.has(f.toLowerCase()), `no identifier field with incidents only: ${f}`);
    }
  }
});

test('incidents + names ADDITIONALLY retains the chat/session-name fields', () => {
  const c = cat(BOTH);
  assert.equal(c.collectsAnything, true);
  assert.ok(c.retainedFields.includes('chatname'), 'chat name advertised');
  assert.ok(c.retainedFields.includes('sessionname'), 'session name advertised');
  assert.equal(c.eventTypes.length, 4, 'the same four anonymous types');
  assert.equal(catOf(BOTH, 'names').inert, false, 'names is live when something collects');
});

test('names-ONLY is reported as enabled but INERT — nothing is collected or retained', () => {
  // The combination the old three-value tier could not express. The catalog must
  // tell the truth: the switch is on, and it still sends nothing.
  const c = cat(NAMES_ONLY);
  assert.equal(catOf(NAMES_ONLY, 'names').enabled, true, 'the user DID turn names on');
  assert.equal(catOf(NAMES_ONLY, 'names').inert, true, 'and it is flagged inert');
  assert.equal(c.collectsAnything, false, 'nothing is collected');
  assert.deepEqual(c.eventTypes, [], 'no event types');
  assert.deepEqual(c.retainedFields, [],
    'and NO fields are advertised as retained — there is no event for a name to ride on');
});

test('a missing / malformed / unrecognized / stale-tier consent collects NOTHING (most-redacted)', () => {
  for (const bad of DEGENERATE) {
    const c = cat(bad);
    assert.equal(c.collectsAnything, false, `nothing collected for ${JSON.stringify(bad)}`);
    assert.deepEqual(c.eventTypes, [], `no event types for ${JSON.stringify(bad)}`);
    assert.deepEqual(c.retainedFields, [], `no retained fields for ${JSON.stringify(bad)}`);
    for (const x of c.categories) {
      assert.equal(x.enabled, false, `${x.id} off for ${JSON.stringify(bad)}`);
    }
  }
});

test('describeCollection lists content/prompt fields as HARD-EXCLUDED under EVERY combination', () => {
  for (const c of [NOTHING, INCIDENTS_ONLY, NAMES_ONLY, BOTH]) {
    const label = JSON.stringify(c);
    const out = cat(c);
    assert.ok(out.hardExcludedContent.includes('content'), `content hard-excluded for ${label}`);
    assert.ok(out.hardExcludedContent.includes('prompt'), `prompt hard-excluded for ${label}`);
    assert.ok(out.hardExcludedContent.includes('messages'), `messages hard-excluded for ${label}`);
  }
});

test('describeCollection DISCLOSES the optional appVersion? field on every event type (WARDEN-665)', () => {
  // The panel's contract is to list EVERY field a category collects. Production
  // attaches appVersion to every emitted event, so it MUST appear in the disclosed
  // field catalog — modeled with the `?` suffix (like `exitCode?`) to document
  // that an event WITHOUT it still validates. Removing appVersion? from
  // BASE_EVENT_FIELDS turns this red.
  for (const c of [INCIDENTS_ONLY, BOTH]) {
    const label = JSON.stringify(c);
    const out = cat(c);
    assert.equal(out.eventTypes.length, 4, `four event types for ${label}`);
    for (const et of out.eventTypes) {
      assert.ok(et.fields.includes('appVersion?'), `${et.type} discloses optional appVersion? for ${label}`);
    }
  }
  // appVersion is a release label, NOT an identifier — it is never a gated field.
  for (const c of [INCIDENTS_ONLY, BOTH, NAMES_ONLY, NOTHING]) {
    for (const f of cat(c).retainedFields) {
      assert.ok(!/appversion/.test(f), 'appVersion is never a category-gated identifier field');
    }
  }
});

test('describeCollection DISCLOSES the optional platform? field on every event type (WARDEN-684)', () => {
  for (const c of [INCIDENTS_ONLY, BOTH]) {
    const label = JSON.stringify(c);
    const out = cat(c);
    assert.equal(out.eventTypes.length, 4, `four event types for ${label}`);
    for (const et of out.eventTypes) {
      assert.ok(et.fields.includes('platform?'), `${et.type} discloses optional platform? for ${label}`);
    }
  }
  for (const c of [INCIDENTS_ONLY, BOTH, NAMES_ONLY, NOTHING]) {
    for (const f of cat(c).retainedFields) {
      assert.ok(!/platform/.test(f), 'platform is never a category-gated identifier field');
    }
  }
});

test('the catalog is DERIVED from the registry — every declared category carries its own copy', () => {
  // The forcing function for "adding a category is a data addition": each entry
  // must arrive with a label, a summary, a role, and its own field/event lists,
  // so a new registry entry is disclosed without editing describeCollection.
  for (const x of cat(BOTH).categories) {
    assert.equal(typeof x.label, 'string');
    assert.ok(x.label.length > 0, `${x.id} has a label`);
    assert.ok(x.summary.length > 0, `${x.id} has a user-facing summary`);
    assert.ok(x.role === 'collecting' || x.role === 'decorating', `${x.id} declares a role`);
    assert.ok(Array.isArray(x.eventTypes) && Array.isArray(x.fields));
    assert.ok(x.eventTypes.length > 0 || x.fields.length > 0,
      `${x.id} has a REAL producer behind it (events or fields) — no empty toggle`);
  }
});

console.log('\n(b) previewPayload — path/host/Authorization redacted + schema-valid');

test('previewPayload replaces the file path, hostname, and Authorization header with [REDACTED:…]', () => {
  const { payload, valid } = previewPayload(CANDIDATE, INCIDENTS_ONLY);
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

test('a non-identifying appVersion release label SURVIVES redaction under EVERY consent (WARDEN-665)', () => {
  // appVersion is neither a content/prompt field nor a chat/session-name
  // identifier, so the redactor neither drops nor rewrites it. This is exactly
  // what the transparency panel's live preview must SHOW: a benign release label
  // passing through intact — reinforcing, not undermining, the trust model.
  for (const c of [INCIDENTS_ONLY, BOTH, NAMES_ONLY, NOTHING, undefined]) {
    const t = JSON.stringify(c);
    const { payload } = previewPayload(CANDIDATE, c);
    assert.equal(payload.appVersion, '0.1.19', `appVersion survives unredacted for ${t}`);
    // And it is never enumerated as a redaction change (it was not transformed).
    const re = previewPayload(CANDIDATE, c);
    const touched = re.changes.some((ch) => ch.path === 'appVersion');
    assert.equal(touched, false, `appVersion is never a redacted/dropped path for ${t}`);
  }
});

test('a non-identifying platform OS label SURVIVES redaction under EVERY consent (WARDEN-684)', () => {
  // platform is neither a content/prompt field nor a chat/session-name identifier,
  // so the redactor neither drops nor rewrites it. Same as appVersion: a benign OS
  // label (darwin/win32/linux) passing through intact — what the transparency
  // panel's live preview must SHOW.
  for (const c of [INCIDENTS_ONLY, BOTH, NAMES_ONLY, NOTHING, undefined]) {
    const t = JSON.stringify(c);
    const { payload } = previewPayload(CANDIDATE, c);
    assert.equal(payload.platform, 'darwin', `platform survives unredacted for ${t}`);
    const re = previewPayload(CANDIDATE, c);
    const touched = re.changes.some((ch) => ch.path === 'platform');
    assert.equal(touched, false, `platform is never a redacted/dropped path for ${t}`);
  }
});

test('previewPayload is valid for a well-formed crash and performance-stall event too', () => {
  const crash = previewPayload(
    { schemaVersion: SCHEMA_VERSION, type: 'crash', runtime: 'renderer', timestamp: 1, reason: 'oom' },
    INCIDENTS_ONLY,
  );
  assert.equal(crash.valid, true);
  assert.equal(validateBaseEvent(crash.payload), true);
  const stall = previewPayload(
    { schemaVersion: SCHEMA_VERSION, type: 'performance-stall', runtime: 'main', timestamp: 1, lagMs: 2500, source: 'event-loop' },
    INCIDENTS_ONLY,
  );
  assert.equal(stall.valid, true);
  assert.equal(validateBaseEvent(stall.payload), true);
});

test('previewPayload flags an INVALID candidate (missing required field) without throwing', () => {
  // No message/name/frames → not a conformant error event.
  const bad = previewPayload({ schemaVersion: SCHEMA_VERSION, type: 'error', runtime: 'renderer', timestamp: 1 }, INCIDENTS_ONLY);
  assert.equal(bad.valid, false);
  assert.equal(isValidBaseEvent(bad.payload), false);
  // Unknown event type → invalid.
  const unknown = previewPayload(
    { schemaVersion: SCHEMA_VERSION, type: 'mystery', runtime: 'renderer', timestamp: 1 },
    INCIDENTS_ONLY,
  );
  assert.equal(unknown.valid, false);
  // A primitive (non-event) → invalid, changes still enumerated.
  const prim = previewPayload('leak: AKIAIOSFODNN7EXAMPLE at /etc/shadow', INCIDENTS_ONLY);
  assert.equal(prim.valid, false);
  assert.equal(prim.payload, 'leak: [REDACTED:aws-key] at [REDACTED:path]');
});

console.log('\n(c) content field is absent from the preview under EVERY combination');

test('content + prompt fields are absent under every combination (dropped wholesale)', () => {
  for (const c of [INCIDENTS_ONLY, BOTH, NAMES_ONLY, NOTHING, undefined]) {
    const t = JSON.stringify(c);
    const { payload } = previewPayload(CANDIDATE, c);
    const p = payload || {};
    assert.equal(p.content, undefined, `content absent for ${t}`);
    assert.equal(p.prompt, undefined, `prompt absent for ${t}`);
    assert.ok(!('content' in p), `content key absent for ${t}`);
    assert.ok(!('prompt' in p), `prompt key absent for ${t}`);
    // The content text never leaks anywhere.
    assert.doesNotMatch(JSON.stringify(payload), /production database password/);
    assert.doesNotMatch(JSON.stringify(payload), /ssh ubuntu/);
  }
});

console.log('\n(d) names are gated by THEIR OWN category, independently of any other');

test('chatName / sessionName ABSENT whenever the `names` category is off', () => {
  for (const c of [INCIDENTS_ONLY, NOTHING, undefined, null, 'extended', { incidents: true, names: 'yes' }]) {
    const t = JSON.stringify(c);
    const { payload } = previewPayload(CANDIDATE, c);
    assert.equal(payload.chatName, undefined, `chatName absent for ${t}`);
    assert.equal(payload.sessionName, undefined, `sessionName absent for ${t}`);
    assert.ok(!('chatName' in payload), `chatName key absent for ${t}`);
  }
});

test('chatName / sessionName PRESENT (scrubbed) when the `names` category is on', () => {
  const { payload } = previewPayload(CANDIDATE, BOTH);
  assert.ok('chatName' in payload, 'chatName present');
  assert.ok('sessionName' in payload, 'sessionName present');
  // Retained, but scrubbed: the raw chatName carried a user@host that must not survive.
  assert.doesNotMatch(payload.chatName, /deploy@prod\.internal/);
  assert.equal(containsIdentifier(payload.chatName), false, 'retained chatName is scrubbed of identifiers');
});

test('a names-ONLY preview is schema-valid but reports transmitted:false (the honest answer)', () => {
  // The combination the old tier could not express. Redaction retains the name
  // (the user consented to it) and the schema is satisfied — but nothing is being
  // COLLECTED, so nothing would actually be sent. The preview must say so rather
  // than implying a name is on the wire.
  const res = previewPayload(CANDIDATE, NAMES_ONLY);
  assert.equal(res.valid, true, 'the payload itself is schema-valid');
  assert.equal(res.transmitted, false, 'but it would NOT be sent — nothing is collected');
  const collecting = previewPayload(CANDIDATE, BOTH);
  assert.equal(collecting.transmitted, true, 'with a collecting category on, it would be sent');
  assert.equal(previewPayload(CANDIDATE, NOTHING).transmitted, false, 'nothing on → not sent');
});

test('each dropped/retained change names the CATEGORY that gates it', () => {
  // The enumerated diff is category-keyed, so a future category's fields are
  // attributed correctly with no change to the diff walker.
  const off = previewPayload(CANDIDATE, INCIDENTS_ONLY).changes.filter((x) => x.kind === 'dropped-identifier');
  assert.ok(off.length > 0, 'names were dropped');
  for (const ch of off) assert.equal(ch.gate, 'names', `${ch.path} attributed to the names category`);
  const on = previewPayload(CANDIDATE, BOTH).changes.filter((x) => x.kind === 'retained-identifier');
  assert.ok(on.length > 0, 'names were retained');
  for (const ch of on) assert.equal(ch.gate, 'names', `${ch.path} attributed to the names category`);
});

console.log('\n(e) PROOF — no identifier pattern survives ANY preview, under ANY combination');

test('no path / host / IPv4 / IPv6 / user@host survives any preview (re-uses containsIdentifier)', () => {
  for (const c of [INCIDENTS_ONLY, BOTH, NAMES_ONLY, NOTHING, undefined]) {
    const t = JSON.stringify(c);
    const { payload } = previewPayload(CANDIDATE, c);
    const strings = [];
    collectStrings(payload, strings);
    for (const { s, frameField } of strings) {
      // A frame file/function source basename is NON-identifying (WARDEN-680) and
      // intentionally preserved — exempt it ONLY when it is a recognized source
      // basename, so a host-shaped frame value (api.github.com) is still caught.
      if (frameField && isSourceBasename(s)) continue;
      assert.equal(containsIdentifier(s), false, `identifier leaked for ${t}: ${s}`);
    }
  }
});

test('a stack frame source basename SURVIVES previewPayload (WARDEN-680 — non-identifying debug value)', () => {
  // The redactor preserves a frame.file/function source basename; the preview is
  // the EXACT transmitted payload, so it must reflect `loader.js`/`loadCreds`,
  // NOT [REDACTED:host]. The single most useful debug field stays actionable.
  for (const c of [INCIDENTS_ONLY, BOTH]) {
    const t = JSON.stringify(c);
    const { payload } = previewPayload(CANDIDATE, c);
    const frame = payload.frames[0];
    assert.equal(frame.file, 'loader.js', `frame.file basename preserved @ ${t}`);
    assert.equal(frame.function, 'loadCreds', `frame.function preserved @ ${t}`);
    assert.doesNotMatch(frame.file, /REDACTED/, `frame.file not clobbered @ ${t}`);
  }
});

test('a candidate packed with every identifier shape is fully scrubbed under every combination', () => {
  const packed = {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    runtime: 'main',
    timestamp: 1,
    name: 'Error',
    message: 'path /etc/shadow host 10.0.0.5 v6 fe80::1 mail ops@example.com fqdn db.internal.local',
    frames: [],
  };
  for (const c of [INCIDENTS_ONLY, BOTH, NOTHING]) {
    const t = JSON.stringify(c);
    const { payload, valid } = previewPayload(packed, c);
    assert.equal(valid, true, `packed event still valid after scrub for ${t}`);
    const strings = [];
    collectStrings(payload, strings);
    for (const { s, frameField } of strings) {
      if (frameField && isSourceBasename(s)) continue;
      assert.equal(containsIdentifier(s), false, `identifier survived for ${t}: ${s}`);
    }
  }
});

console.log('\n(f) determinism + non-mutation');

test('describeCollection is deterministic — stable across calls (pure)', () => {
  for (const c of [NOTHING, INCIDENTS_ONLY, NAMES_ONLY, BOTH]) {
    assert.deepEqual(describeCollection(c), describeCollection(c));
  }
});

test('previewPayload is deterministic — same input+consent yields equal results', () => {
  for (const c of [NOTHING, INCIDENTS_ONLY, NAMES_ONLY, BOTH]) {
    assert.deepEqual(previewPayload(CANDIDATE, c), previewPayload(CANDIDATE, c));
  }
});

test('previewPayload does NOT mutate its input (defensive copy)', () => {
  const snapshot = JSON.parse(JSON.stringify(CANDIDATE));
  previewPayload(CANDIDATE, BOTH);
  previewPayload(CANDIDATE, INCIDENTS_ONLY);
  previewPayload(CANDIDATE, NAMES_ONLY);
  assert.deepEqual(CANDIDATE, snapshot, 'original CANDIDATE must be byte-for-byte unchanged');
});

console.log('\nchanges — enumerated diff of what redaction did');

test('changes enumerate dropped content, dropped/retained identifiers, and redacted substitutions', () => {
  const base = previewPayload(CANDIDATE, INCIDENTS_ONLY);
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

  const ext = previewPayload(CANDIDATE, BOTH);
  const extKinds = ext.changes.map((c) => c.kind);
  assert.ok(extKinds.includes('retained-identifier'), 'identifier retained at extended');
  // The retained chatName carried a user@host → a redacted substitution is recorded too.
  const chatRedactions = ext.changes.filter((c) => c.kind === 'redacted' && c.path === 'chatName');
  assert.ok(chatRedactions.some((c) => c.category === 'host'), 'retained chatName scrubbed of embedded host');
});

console.log('\n(g) hard-exclusion proof — isValidBaseEvent REJECTS a leaked identifier');

// WARDEN-1180. Groups (a)–(f) above drive the module through `previewPayload`,
// which computes `payload = redact(rawEvent, …)` BEFORE calling the validator —
// so the payload reaching `isValidBaseEvent` is already scrubbed and its
// hard-exclusion arms (transparency.ts:146-154) can never fire through that
// path. The one existing direct call (`isValidBaseEvent(bad.payload)`) passes an
// event with no `message` at all, which short-circuits on the structural check
// long before the proof block. Mutation-verified at eb37e09: deleting :146,
// :149, :151, :152 — or the whole :146-154 body — left all 26 tests green, while
// deleting the covered :130 turned the suite red (positive control). These tests
// close that seam by driving the validator DIRECTLY.
//
// Why it matters (design WARDEN-443): redaction is the primary barrier and it is
// well tested, but this block is the INDEPENDENT re-check that catches a
// redaction ESCAPE — a new identifier shape, a regex gap, a future refactor of
// `redact`. Its verdict is not inert at runtime: `valid` gates `transmitted`
// (transparency.ts:420-426) and is rendered on the consent panel
// (TelemetryTransparency.tsx:335), the surface whose entire job is proving what
// leaves the machine. It is also the exact code WARDEN-1167 fences off with
// "do NOT collapse isValidBaseEvent onto validateBaseEvent — merging them would
// silently drop the redaction guarantee this module exists to prove"; today that
// collapse would keep the suite green, and after this block it would not.
//
// Each case ISOLATES one arm: the fixture is structurally valid and clean on
// every OTHER field, so the rejection can only come from the arm under test.

/** A structurally-valid `error` base event, clean by default. */
const validErrorEvent = (over = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  type: 'error',
  runtime: 'renderer',
  timestamp: 1719500000123,
  name: 'Error',
  message: 'Failed to load credentials',
  frames: [],
  ...over,
});

// One message per hard-exclusion shape. `family` names the ID_PROOF regex the
// fixture is MEANT to trip — asserted as a fixture PRECONDITION (so a case can
// never pass for the wrong reason, e.g. an "IPv4" string that is really only
// caught as a path); the behavior under test is the validator's verdict.
const LEAKED_MESSAGES = [
  { family: 'path', text: 'Failed to load key from /home/alice/.ssh/aws-creds' },
  { family: 'userhost', text: 'auth rejected for deploy@corp.internal' },
  { family: 'ipv4', text: 'connect ECONNREFUSED 10.0.0.5' },
  { family: 'ipv6', text: 'connect failed to 2001:0db8:85a3:0000:0000:8a2e:0370:7334' },
  { family: 'hostname', text: 'timeout talking to prod-db-01.corp.local' },
];

test(':146 — a structurally-valid event whose message still carries an identifier is REJECTED', () => {
  for (const { family, text } of LEAKED_MESSAGES) {
    // Fixture precondition: this string really does carry the shape it claims.
    assert.equal(ID_PROOF[family].test(text), true, `fixture for ${family} carries that shape`);
    const event = validErrorEvent({ message: text });
    // Everything EXCEPT the message is clean, so a `false` here can only be :146.
    assert.equal(isValidBaseEvent(event), false, `message with ${family} rejected`);
    // The CJS main-process mirror must agree (drift guard, same posture as (b)).
    assert.equal(validateBaseEvent(event), false, `CJS validator agrees for ${family}`);
  }
  // Control on the SAME fixture shape: identical event, clean message → accepted.
  // Without this, ":146 rejects" would be indistinguishable from a fixture that
  // was structurally invalid all along.
  assert.equal(isValidBaseEvent(validErrorEvent()), true, 'clean message accepted');
});

test(':146 applies to NON-error types too (the proof is not inside the error branch)', () => {
  // `crash` / `performance-stall` carry a message only incidentally, but :146 is
  // OUTSIDE the per-type branch — a leaked identifier must be rejected there too.
  const crash = {
    schemaVersion: SCHEMA_VERSION, type: 'crash', runtime: 'main', timestamp: 1,
    reason: 'oom', message: 'child died at /var/lib/warden/session.sock',
  };
  assert.equal(isValidBaseEvent(crash), false, 'crash with leaked path rejected');
  assert.equal(isValidBaseEvent({ ...crash, message: 'child died' }), true, 'clean crash accepted');
  const stall = {
    schemaVersion: SCHEMA_VERSION, type: 'performance-stall', runtime: 'main', timestamp: 1,
    lagMs: 2500, source: 'event-loop', message: 'stalled while polling 192.168.1.44',
  };
  assert.equal(isValidBaseEvent(stall), false, 'performance-stall with leaked IPv4 rejected');
  assert.equal(isValidBaseEvent({ ...stall, message: 'stalled while polling' }), true, 'clean stall accepted');
});

test(':151 — a frame whose `function` carries a PATH is REJECTED', () => {
  // message clean, frame.file a bare basename → only :151 can reject this.
  const event = validErrorEvent({
    frames: [{ function: '/home/u/app/loader.js:12', file: 'loader.js' }],
  });
  assert.equal(isValidBaseEvent(event), false);
  assert.equal(validateBaseEvent(event), false, 'CJS validator agrees');
  // Windows separator too — the guard is on separators, not on a leading slash.
  const win = validErrorEvent({ frames: [{ function: 'C:\\app\\loader.js', file: 'loader.js' }] });
  assert.equal(isValidBaseEvent(win), false, 'windows-style path in function rejected');
});

test(':152 — a frame whose `file` carries a PATH is REJECTED', () => {
  // message clean, frame.function a bare symbol → only :152 can reject this.
  const event = validErrorEvent({
    frames: [{ function: 'loadCreds', file: '/etc/warden/loader.js' }],
  });
  assert.equal(isValidBaseEvent(event), false);
  assert.equal(validateBaseEvent(event), false, 'CJS validator agrees');
  // A relative path is still a path (it has a separator).
  const rel = validErrorEvent({ frames: [{ function: 'loadCreds', file: './src/lib/loader.js' }] });
  assert.equal(isValidBaseEvent(rel), false, 'relative path in file rejected');
});

test('the ALLOWED side of the boundary (WARDEN-680) — a bare basename is ACCEPTED', () => {
  // Assert BOTH sides or the guard can be "fixed" into uselessness: frame fields
  // are checked for PATHS only, because a bare filename basename is
  // non-identifying under WARDEN-443 (the directory is dropped at the collection
  // boundary) and the redactor intentionally PRESERVES it. A guard widened to
  // reject basenames would strip warden's own stack frames — this test fails if
  // anyone does that.
  const event = validErrorEvent({ frames: [{ function: 'loadCreds', file: 'loader.js', line: 12 }] });
  assert.equal(isSourceBasename('loader.js'), true, 'fixture really is a source basename');
  assert.equal(isValidBaseEvent(event), true);
  assert.equal(validateBaseEvent(event), true, 'CJS validator agrees');
  // Multiple clean frames, and an empty frames array, are accepted too.
  assert.equal(
    isValidBaseEvent(validErrorEvent({
      frames: [{ function: 'a', file: 'a.ts' }, { function: 'b', file: 'b.tsx' }],
    })),
    true,
    'several clean frames accepted',
  );
  assert.equal(isValidBaseEvent(validErrorEvent({ frames: [] })), true, 'no frames accepted');
});

test(':149 — a malformed frame ELEMENT (non-object) is REJECTED', () => {
  // Each of these is structurally valid up to the frames loop and carries no
  // path in any frame FIELD (there are no fields) — so only :149 can reject.
  for (const bad of [null, undefined, 'loader.js', 42, true]) {
    const event = validErrorEvent({ frames: [bad] });
    assert.equal(isValidBaseEvent(event), false, `frames: [${JSON.stringify(bad)}] rejected`);
    assert.equal(validateBaseEvent(event), false, `CJS validator agrees for ${JSON.stringify(bad)}`);
  }
  // A malformed element ANYWHERE in the array is caught, not just at index 0.
  assert.equal(
    isValidBaseEvent(validErrorEvent({ frames: [{ function: 'loadCreds', file: 'loader.js' }, null] })),
    false,
    'malformed element after a good one rejected',
  );
});

// ==========================================================================
// server-stall (WARDEN-1278) — disclosed by the `incidents` category, and its
// attribution key proven closed-set on BOTH validators.
// ==========================================================================

const serverStallEvent = (overrides = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  type: 'server-stall',
  runtime: 'server',
  timestamp: 1735689600000,
  windowStartedAt: 1735689300000,
  windowEndedAt: 1735689600000,
  count: 2,
  totalMs: 4200,
  maxMs: 3000,
  boundaries: [1000, 2000, 5000, 10000, 30000],
  buckets: [0, 1, 1, 0, 0, 0],
  culprits: [{ culprit: 'get-api-claude-sessions', count: 2, totalOverlapMs: 4000 }],
  ...overrides,
});

test('the incidents category DISCLOSES server-stall and its aggregate fields (WARDEN-1278)', () => {
  const et = cat(INCIDENTS_ONLY).eventTypes.find((e) => e.type === 'server-stall');
  assert.ok(et, 'server-stall is catalogued under incidents');
  for (const f of ['windowStartedAt', 'windowEndedAt', 'count', 'totalMs', 'maxMs', 'boundaries', 'buckets', 'culprits']) {
    assert.ok(et.fields.includes(f), `server-stall discloses ${f}`);
  }
  // No free-text field is disclosed, because none exists in the shape.
  for (const f of et.fields) {
    assert.ok(!/message|reason|name$|label/i.test(f), `server-stall carries no free-text field: ${f}`);
  }
});

test('a well-formed server-stall window is VALID on both validators', () => {
  const event = serverStallEvent();
  assert.equal(isValidBaseEvent(event), true, 'local transparency validator accepts it');
  assert.equal(validateBaseEvent(event), true, 'the CJS main-process validator agrees');
});

test('a server-stall culprit key carrying user data is REJECTED on both validators', () => {
  // The producer projects every span label onto a closed set before it can
  // become a key; this is the INDEPENDENT second layer. A request label built
  // from an agent name (`GET /api/chats/myproject-researcher`) reaches the wire
  // only if BOTH layers fail, and the shape check alone is enough to stop it.
  for (const bad of [
    '/api/sessions/abc', 'GET /api/chats', 'myproject.internal',
    '~/warden/config.json', 'user@host', 'Refactor auth',
  ]) {
    const event = serverStallEvent({ culprits: [{ culprit: bad, count: 1, totalOverlapMs: 1 }] });
    assert.equal(isValidBaseEvent(event), false, `local validator rejects ${JSON.stringify(bad)}`);
    assert.equal(validateBaseEvent(event), false, `CJS validator rejects ${JSON.stringify(bad)}`);
  }
});

test('a server-stall previews with NOTHING redacted — there is nothing in it to redact', () => {
  // The strongest statement of the type's trust posture: run the REAL redaction
  // engine over a real window and the output is byte-equal to the input, because
  // every value is a number or a closed-set key. An event that needed redacting
  // would mean a leak channel had opened.
  const event = serverStallEvent();
  const { payload, valid, transmitted, changes } = previewPayload(event, INCIDENTS_ONLY);
  assert.deepEqual(payload, event, 'redaction is a no-op on a server-stall window');
  assert.equal(valid, true);
  assert.equal(transmitted, true, 'incidents is on, so it would be sent');
  assert.deepEqual(changes, [], 'no field was dropped and no substitution was made');
});

test('a server-stall is NOT transmitted with incidents off (it rides that category)', () => {
  const { transmitted } = previewPayload(serverStallEvent(), NAMES_ONLY);
  assert.equal(transmitted, false, 'names-only collects nothing, so nothing is sent');
});

console.log(`\n✓ TELEMETRY TRANSPARENCY TESTS PASS (${passed})`);
