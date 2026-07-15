// Tests for the telemetry pre-collection redaction engine (WARDEN-459, slice 2
// of roadmap WARDEN-446). This module is the pipeline's safety gate: it MUST
// make it impossible for an un-redacted payload to be produced — credentials /
// chat content / prompts / file paths / hostnames can never survive, and chat /
// session names survive only at the extended consent tier.
//
// No front-end test runner in this repo, so (like web/desktopAlerts.test.mjs)
// this loads the REAL web/src/lib/telemetry/redact.ts (transpiled TS -> ESM via
// Vite's OXC transform) and exercises the PURE transform with plain objects.
// The `import type` in that file is erased at transpile time and there are no
// runtime imports, so the emitted module loads standalone.
//
// Auto-discovered by `npm run dev:test` (`node --test` in web/).
//
// Run: node telemetry-redact.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/telemetry/redact.ts');

// --- Load the REAL redact.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(modPath, 'utf8');
const { code } = await transformWithOxc(src, modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-redact-test-'));
const tmpFile = join(tmpDir, 'redact.mjs');
writeFileSync(tmpFile, code);
const { redact, scrubString } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A canonical AWS secret access key (40 chars, mixed classes + slashes) — caught
// by the generic high-entropy rule, not by the AKIA access-key-id rule.
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
// GitHub classic PAT: `ghp_` + 36 chars.
const GH_TOKEN = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
// A representative PEM private-key block.
const PEM_KEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/y2Qr0PEjTnLlNhQ3y4WzR3g7',
  'dQ==',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

// The combined candidate event used across most assertions — every hard
// exclusion category appears somewhere in it, alongside safe base-tier fields.
const EVENT = {
  type: 'renderer_crash',
  timestamp: 1719500000123,
  chatName: 'Refactor auth module',
  sessionName: 'claude-7b3a2f1',
  error: {
    name: 'Error',
    message:
      'Failed to load /home/alice/.ssh/aws-creds from host prod-db-01.corp.local (Authorization: Bearer ' +
      GH_TOKEN +
      ')',
    stack:
      'at loadCreds (/home/alice/projects/warden/src/server.js:42)\n' +
      'AWS access key AKIAIOSFODNN7EXAMPLE leaked; secret=' +
      AWS_SECRET,
  },
  content: 'User asked: what is the production database password for prod-db-01?',
  prompt:
    'Run: ssh ubuntu@10.0.0.5 with this key\n' + PEM_KEY + '\ncat /etc/shadow',
  meta: {
    hostname: 'prod-db-01.corp.local',
    endpoint: 'https://api.internal.corp.local/v1/secrets',
    counts: { errors: 3, panes: 2, recovered: 1 },
  },
};

// Serialized views are used for the "NONE of the sensitive material survives"
// substring-absence checks across the whole scrubbed payload.
const redacted = redact(EVENT, { tier: 'extended' });
const redactedAnyTier = JSON.stringify(redacted); // extended retains names; secrets still gone
const baseSerialized = JSON.stringify(redact(EVENT, { tier: 'base' }));

console.log('\nhard exclusions — credentials never survive (all tiers)');

test('AWS access-key-id is absent from output', () => {
  assert.doesNotMatch(redactedAnyTier, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(baseSerialized, /AKIAIOSFODNN7EXAMPLE/);
});

test('AWS secret access key (high-entropy) is absent from output', () => {
  assert.doesNotMatch(redactedAnyTier, /wJalrXUtnFEMI/);
  assert.doesNotMatch(redactedAnyTier, /bPxRfiCYEXAMPLEKEY/);
});

test('GitHub token is absent from output', () => {
  assert.doesNotMatch(redactedAnyTier, /ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789/);
  assert.doesNotMatch(redactedAnyTier, /ghp_/);
});

test('Authorization / Bearer header value is absent from output', () => {
  assert.doesNotMatch(redactedAnyTier, /Bearer\s+\S/); // no `Bearer <value>` survives
  // The header label may remain, but never with its secret value.
  assert.ok(
    !redactedAnyTier.includes(GH_TOKEN),
    'GitHub token must not ride out under the Authorization header',
  );
});

test('PEM private-key block is absent from output', () => {
  assert.doesNotMatch(redactedAnyTier, /BEGIN RSA PRIVATE KEY/);
  assert.doesNotMatch(redactedAnyTier, /MIIEpAIBAAKCAQEA/);
  assert.doesNotMatch(redactedAnyTier, /END RSA PRIVATE KEY/);
});

test('known-format secrets (OpenAI/Stripe/Slack/Google/JWT) are scrubbed directly', () => {
  assert.equal(scrubString('key=sk-proj-abcd1234EFGH5678ijkl9012mnop3456'), 'key=[REDACTED:secret]');
  assert.equal(scrubString('sk_live_0123456789abcdefghijklmn'), '[REDACTED:secret]');
  assert.equal(scrubString('xoxb-1234567890-abcdefghij'), '[REDACTED:secret]');
  assert.equal(scrubString('google=AIzaSyA0123456789abcdefghijklmnopqrstuv'), 'google=[REDACTED:secret]');
  // JWT (header.payload.signature) — none of the segments survive.
  const jwtScrubbed = scrubString('jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f');
  assert.doesNotMatch(jwtScrubbed, /eyJ/);
  assert.doesNotMatch(jwtScrubbed, /SflKxwRJSMeKKF2QT4f/);
});

test('labeled secrets (password= / api_key:) are scrubbed directly', () => {
  assert.equal(scrubString('password=hunter2'), 'password=[REDACTED:secret]');
  assert.equal(scrubString('api_key: abc123def456'), 'api_key=[REDACTED:secret]');
  assert.equal(scrubString('client_secret = "s3cr3t-value"'), 'client_secret=[REDACTED:secret]');
});

test('high-entropy rule leaves ordinary words / numbers / versions untouched', () => {
  // Pure numbers (timestamps), single-class lowercase words, and short version
  // strings are NOT secret-shaped and must pass through verbatim.
  assert.equal(scrubString('count=3 timestamp=1719500000123'), 'count=3 timestamp=1719500000123');
  assert.equal(scrubString('the quick brown fox jumps over the lazy dog'), 'the quick brown fox jumps over the lazy dog');
  assert.equal(scrubString('version 1.2.3'), 'version 1.2.3');
});

console.log('\nhard exclusions — chat content & prompts are dropped wholesale');

test('chat-content field is dropped entirely (not partially scrubbed)', () => {
  const out = redact(EVENT, { tier: 'extended' });
  assert.equal(out.content, undefined, 'content field must be absent');
  // The content text never leaks anywhere in the payload.
  assert.doesNotMatch(JSON.stringify(out), /production database password/);
});

test('prompt field is dropped entirely (PEM key inside it never leaks)', () => {
  const out = redact(EVENT, { tier: 'extended' });
  assert.equal(out.prompt, undefined, 'prompt field must be absent');
  assert.doesNotMatch(JSON.stringify(out), /BEGIN RSA PRIVATE KEY/);
});

console.log('\nhard exclusions — file paths & hostnames never survive');

test('absolute POSIX file paths are absent from output', () => {
  assert.doesNotMatch(redactedAnyTier, /\/home\/alice\/\.ssh\/aws-creds/);
  assert.doesNotMatch(redactedAnyTier, /\/home\/alice\/projects\/warden\/src\/server\.js/);
  assert.doesNotMatch(redactedAnyTier, /\/etc\/shadow/);
});

test('home-relative POSIX path is scrubbed directly', () => {
  assert.equal(scrubString('reading ~/.ssh/config'), 'reading [REDACTED:path]');
});

test('Windows drive + UNC paths are scrubbed directly', () => {
  assert.equal(scrubString('log at C:\\Users\\alice\\secrets.txt'), 'log at [REDACTED:path]');
  assert.equal(scrubString('share \\\\corp-fileserver\\engineering\\roadmap.md'), 'share [REDACTED:path]');
});

test('FQDN hostname is absent from output', () => {
  assert.doesNotMatch(redactedAnyTier, /prod-db-01\.corp\.local/);
  assert.equal(scrubString('pushed to git.example-corp.internal'), 'pushed to [REDACTED:host]');
});

test('user@host SSH / email address is absent from output', () => {
  assert.doesNotMatch(redactedAnyTier, /ubuntu@10\.0\.0\.5/);
  assert.equal(scrubString('email ops+alerts@example.com'), 'email [REDACTED:host]');
  assert.equal(scrubString('deploy ubuntu@prod-db-01'), 'deploy [REDACTED:host]');
});

test('ssh:// and https:// scheme URLs are scrubbed wholesale', () => {
  assert.doesNotMatch(redactedAnyTier, /https:\/\/api\.internal\.corp\.local/);
  assert.equal(scrubString('connect ssh://deploy@10.0.0.5:2222/~/app'), 'connect [REDACTED:host]');
  assert.equal(scrubString('postgres://u:p@db.internal:5432/app'), '[REDACTED:host]');
});

test('IPv4 address is scrubbed directly (dates / versions left alone)', () => {
  assert.equal(scrubString('gateway 10.0.0.5 up'), 'gateway [REDACTED:host] up');
  assert.equal(scrubString('date 2026-07-15'), 'date 2026-07-15'); // date not 4-octet → preserved
  assert.equal(scrubString('version 1.2.3'), 'version 1.2.3');
});

test('IPv6 host addresses are scrubbed directly (compressed / full / loopback / zone)', () => {
  // Once IPv4 is a host identifier, IPv6 is one too — internal topology
  // (link-local, ULA) must never ride out in an error message.
  assert.equal(scrubString('gateway fe80::1 up'), 'gateway [REDACTED:host] up');
  assert.equal(scrubString('db 2001:db8:abcd:ef12::1 ready'), 'db [REDACTED:host] ready');
  assert.equal(scrubString('ula fd00::1234 here'), 'ula [REDACTED:host] here');
  assert.equal(scrubString('loopback ::1 down'), 'loopback [REDACTED:host] down');
  // Full uncompressed 8-hextet form.
  assert.equal(
    scrubString('addr 2001:0db8:0000:0000:0000:0000:0000:0001 ok'),
    'addr [REDACTED:host] ok',
  );
  // Link-local with a %zone scope id — the whole token (zone included) goes.
  assert.equal(scrubString('zone fe80::1%eth0 dev'), 'zone [REDACTED:host] dev');
});

test('IPv6 addresses are absent from a payload driven through redact()', () => {
  // The dangerous input the reviewer flagged, exercised end-to-end through the
  // real transform — none of the three IPv6 shapes survive in the output.
  const out = redact(
    { type: 'network_error', error: { message: 'connect fe80::1 / 2001:db8:abcd:ef12::1 / ::1 refused' } },
    { tier: 'extended' },
  );
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /fe80::1/);
  assert.doesNotMatch(s, /2001:db8:abcd:ef12::1/);
  assert.doesNotMatch(s, /::1/);
  assert.ok(out.error.message.includes('[REDACTED:host]'), 'host placeholder present in scrubbed message');
});

test('clock times / timestamps are NOT mistaken for IPv6 (no false positives)', () => {
  // The colon syntax collides with crash-message timestamps; these must survive.
  assert.equal(scrubString('at 12:34:56 elapsed'), 'at 12:34:56 elapsed'); // HH:MM:SS
  assert.equal(scrubString('duration 8:30:45'), 'duration 8:30:45'); // H:MM:SS
  assert.equal(scrubString('ratio 1:2 split'), 'ratio 1:2 split'); // single colon, no hex
  assert.equal(scrubString('version 1.2.3'), 'version 1.2.3'); // dots, not colons
});

test('MAC addresses (persistent device identifiers) are scrubbed in the host pass', () => {
  assert.equal(scrubString('mac 00:1A:2B:3C:4D:5E'), 'mac [REDACTED:host]');
  assert.equal(scrubString('nic a0:b1:c2:d3:e4:f5'), 'nic [REDACTED:host]');
});

console.log('\ntier gating — chat/session names only at the extended tier');

test('names are PRESENT at the extended tier', () => {
  const out = redact(EVENT, { tier: 'extended' });
  assert.equal(out.chatName, 'Refactor auth module');
  assert.equal(out.sessionName, 'claude-7b3a2f1');
});

test('names are ABSENT at the base tier', () => {
  const out = redact(EVENT, { tier: 'base' });
  assert.equal(out.chatName, undefined);
  assert.equal(out.sessionName, undefined);
  assert.ok(!('chatName' in out), 'chatName key must not even be present');
  assert.ok(!('sessionName' in out), 'sessionName key must not even be present');
});

test('names are ABSENT when tier is off / unknown / undefined (most-redacted default)', () => {
  assert.equal(redact(EVENT, { tier: 'off' }).chatName, undefined);
  assert.equal(redact(EVENT, { tier: 'off' }).sessionName, undefined);
  assert.equal(redact(EVENT, { tier: 'unknown' }).chatName, undefined);
  assert.equal(redact(EVENT, {}).chatName, undefined); // tier omitted entirely
  assert.equal(redact(EVENT, { tier: undefined }).chatName, undefined);
  assert.equal(redact(EVENT, { tier: null }).chatName, undefined);
});

test('safe base-tier fields survive every tier (scrubbed, not dropped)', () => {
  for (const tier of ['base', 'extended', 'off', 'unknown', undefined]) {
    const out = redact(EVENT, { tier });
    assert.equal(out.type, 'renderer_crash', `type preserved at tier ${tier}`);
    assert.equal(out.timestamp, 1719500000123, `timestamp preserved at tier ${tier}`);
    assert.equal(out.error.name, 'Error', `error.name preserved at tier ${tier}`);
    assert.deepEqual(out.meta.counts, { errors: 3, panes: 2, recovered: 1 }, `counts preserved at tier ${tier}`);
  }
});

test('free-text error.message is RETAINED but scrubbed of every secret/path/host', () => {
  const msg = redact(EVENT, { tier: 'base' }).error.message;
  assert.ok(typeof msg === 'string' && msg.length > 0, 'the message itself is kept (base-tier crash signal)');
  assert.doesNotMatch(msg, /prod-db-01/); // host
  assert.doesNotMatch(msg, /\/home\/alice/); // path
  assert.doesNotMatch(msg, /ghp_/); // token
  assert.doesNotMatch(msg, /Authorization:\s*\S/); // no header value
});

console.log('\nstructural guarantees — non-mutation & idempotency');

test('input payload is NOT mutated (defensive copy)', () => {
  const snapshot = JSON.parse(JSON.stringify(EVENT));
  const out = redact(EVENT, { tier: 'extended' });
  // Input unchanged.
  assert.deepEqual(EVENT, snapshot, 'original EVENT must be byte-for-byte unchanged');
  // Output is a distinct object, not the input reference.
  assert.notEqual(out, EVENT);
  assert.notEqual(out.error, EVENT.error);
});

test('redaction is idempotent — re-redacting already-redacted output is a no-op', () => {
  const once = redact(EVENT, { tier: 'extended' });
  const twice = redact(once, { tier: 'extended' });
  assert.deepEqual(twice, once);
  // Same holds at base tier and for the raw string scrubber.
  assert.deepEqual(redact(redact(EVENT, { tier: 'base' }), { tier: 'base' }), redact(EVENT, { tier: 'base' }));
  const messy = 'AKIAIOSFODNN7EXAMPLE and /etc/shadow and ubuntu@host.local';
  assert.equal(scrubString(scrubString(messy)), scrubString(messy));
});

test('scrubString placeholders are inert (contain no residual sensitive material)', () => {
  // A fully scrubbed string re-scrubs to itself — placeholders never re-trigger.
  const scrubbed = scrubString('AKIAIOSFODNN7EXAMPLE ' + GH_TOKEN + ' /home/a/b ' + PEM_KEY);
  assert.equal(scrubString(scrubbed), scrubbed);
  assert.doesNotMatch(scrubbed, /AKIA/);
  assert.doesNotMatch(scrubbed, /ghp_/);
  assert.doesNotMatch(scrubbed, /home/);
  assert.doesNotMatch(scrubbed, /BEGIN RSA/);
});

test('deeply nested payloads are scrubbed at every level', () => {
  const nested = {
    a: { b: { c: 'key AKIAIOSFODNN7EXAMPLE in deep', content: 'secret chat' } },
    list: [{ token: 'Bearer abcdefghijklmnop' }],
  };
  const out = redact(nested, { tier: 'base' });
  assert.doesNotMatch(JSON.stringify(out), /AKIAIOSFODNN7EXAMPLE/);
  assert.equal(out.a.b.c, 'key [REDACTED:aws-key] in deep');
  assert.equal(out.a.b.content, undefined, 'deeply nested content still dropped');
  assert.equal(out.list[0].token, 'Bearer [REDACTED:token]');
});

test('null / undefined / primitive inputs are handled defensively', () => {
  assert.equal(redact(null, { tier: 'extended' }), null);
  assert.equal(redact(undefined, { tier: 'extended' }), undefined);
  assert.equal(redact(42, { tier: 'extended' }), 42);
  assert.equal(redact(true, { tier: 'extended' }), true);
  // A bare sensitive string passed at the top level is still scrubbed.
  assert.equal(redact('leak: AKIAIOSFODNN7EXAMPLE', { tier: 'extended' }), 'leak: [REDACTED:aws-key]');
});

console.log(`\n✓ TELEMETRY REDACTION TESTS PASS (${passed})`);
