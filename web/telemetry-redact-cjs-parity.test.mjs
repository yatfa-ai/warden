// CJS redact PARITY tests (WARDEN-524). The live main-process pipeline uses
// electron/telemetry-redact.cjs — a CJS mirror of web/src/lib/telemetry/redact.ts
// (the TS redactor cannot be require()'d at runtime from main-process CJS). This
// suite guards the mirror against drift: it loads BOTH the REAL redact.ts (TS →
// ESM via Vite's OXC transform) and the CJS mirror (via createRequire) and asserts
// they produce IDENTICAL output across a battery of inputs × every consent tier.
// A future edit to either file that diverges them fails here.
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node telemetry-redact-cjs-parity.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Load the REAL redact.ts (TS -> ESM via the OXC transform Vite bundles) ----
const tsPath = resolve(__dirname, 'src/lib/telemetry/redact.ts');
const tsSrc = readFileSync(tsPath, 'utf8');
const { code } = await transformWithOxc(tsSrc, tsPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-cjs-parity-'));
const tsTmp = join(tmpDir, 'redact.mjs');
writeFileSync(tsTmp, code);
const { redact: tsRedact, scrubString: tsScrubString } = await import(tsTmp);
rmSync(tmpDir, { recursive: true, force: true });

// --- Load the CJS mirror ------------------------------------------------------
const { redact: cjsRedact, scrubString: cjsScrubString } = require('../electron/telemetry-redact.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Every consent tier the pipeline resolver can hand the redactor, including the
// "most-redacted" fallbacks for unrecognized / missing tiers.
const TIERS = ['base', 'extended', 'off', undefined, null, 'weird', '', 42];

// A canonical event exercising every hard-exclusion category (credentials, paths,
// hosts, IPv4/IPv6, MAC, content, prompts) plus the identifier fields (names).
const GH_TOKEN = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const PEM_KEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/y2Qr0PEjTnLlNhQ3y4WzR3g7',
  'dQ==',
  '-----END RSA PRIVATE KEY-----',
].join('\n');
const CANONICAL = {
  type: 'renderer_crash',
  timestamp: 1719500000123,
  chatName: 'Refactor auth module',
  sessionName: 'claude-7b3a2f1',
  error: {
    name: 'Error',
    message: `Failed to load /home/alice/.ssh/aws-creds from host prod-db-01.corp.local (Authorization: Bearer ${GH_TOKEN})`,
    stack: `at loadCreds (/home/alice/projects/warden/src/server.js:42)\nAWS access key AKIAIOSFODNN7EXAMPLE leaked; secret=${AWS_SECRET}`,
  },
  content: 'User asked: what is the production database password for prod-db-01?',
  prompt: `Run: ssh ubuntu@10.0.0.5 with this key\n${PEM_KEY}\ncat /etc/shadow`,
  meta: {
    hostname: 'prod-db-01.corp.local',
    endpoint: 'https://api.internal.corp.local/v1/secrets',
    counts: { errors: 3, panes: 2, recovered: 1 },
    ipv6: 'connect fe80::1 / 2001:db8:abcd:ef12::1 / ::1 refused',
    mac: 'nic 00:1A:2B:3C:4D:5E',
    jwt: 'token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f',
  },
};

// A varied battery: nested arrays, deeply mixed types, primitives, a bare
// sensitive top-level string, empty collections, and the canonical event.
const BATTERY = [
  CANONICAL,
  { type: 'error', message: 'plain message with no secrets' },
  { a: { b: { c: 'key AKIAIOSFODNN7EXAMPLE in deep', content: 'secret chat' } }, list: [{ token: 'Bearer abcdefghijklmnop' }] },
  [{ x: '/etc/shadow' }, { y: 'deploy ubuntu@prod-db-01' }, 7, true, null],
  { ipv6: 'gateway fe80::1%eth0 up', clock: 'at 12:34:56 elapsed', ratio: '1:2 split' },
  { win: 'log at C:\\Users\\alice\\secrets.txt', unc: 'share \\\\corp\\eng\\r.md' },
  { sk1: 'sk-proj-abcd1234EFGH5678ijkl9012mnop3456', sk2: 'sk_live_0123456789abcdefghijklmn', slack: 'xoxb-1234567890-abcdefghij', google: 'AIzaSyA0123456789abcdefghijklmnopqrstuv' },
  { labeled: 'password=hunter2 api_key: abc123def456 client_secret = "s3cr3t-value"' },
  { emptyObj: {}, emptyArr: [], emptyStr: '', zero: 0, false: false },
  null,
  undefined,
  42,
  true,
  'leak: AKIAIOSFODNN7EXAMPLE and /home/a/b and ubuntu@host.local',
  '',
];

console.log('\nparity — cjsRedact === tsRedact across the battery × every tier');

for (const input of BATTERY) {
  for (const tier of TIERS) {
    test(`deepEqual for input ${String(JSON.stringify(input)).slice(0, 40)} @ tier ${JSON.stringify(tier)}`, () => {
      assert.deepEqual(
        cjsRedact(input, { tier }),
        tsRedact(input, { tier }),
        `CJS mirror must match redact.ts exactly for tier ${JSON.stringify(tier)}`,
      );
    });
  }
}

console.log('\nparity — scrubString (raw value-level rules) match across a string battery');

const SCRUB_BATTERY = [
  'auth failed for token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 on retry',
  'AKIAIOSFODNN7EXAMPLE secret=' + AWS_SECRET,
  PEM_KEY,
  'connect ssh://deploy@10.0.0.5:2222/~/app and postgres://u:p@db.internal:5432/app',
  'reading ~/.ssh/config and /home/alice/projects/warden/src/server.js and /etc/shadow',
  'log at C:\\Users\\alice\\secrets.txt share \\\\corp-fileserver\\engineering\\roadmap.md',
  'pushed to git.example-corp.internal from ubuntu@10.0.0.5',
  'gateway fe80::1 / 2001:db8:abcd:ef12::1 / ::1 refused, zone fe80::1%eth0, mac 00:1A:2B:3C:4D:5E',
  'at 12:34:56 elapsed, duration 8:30:45, ratio 1:2, version 1.2.3',
  'password=hunter2 and api_key: abc123def456 and client_secret = "s3cr3t-value"',
  'count=3 timestamp=1719500000123 the quick brown fox version 1.2.3',
  'jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f and sk-proj-abcd1234EFGH5678ijkl9012mnop3456',
  'Bearer abcdefghijklmnop and Authorization: Bearer s3cr3t',
  '',
  'no secrets here at all, just plain text',
];

for (const s of SCRUB_BATTERY) {
  test(`scrubString deepEqual for ${String(JSON.stringify(s)).slice(0, 50)}`, () => {
    assert.deepEqual(cjsScrubString(s), tsScrubString(s));
  });
}

console.log('\nparity — idempotency holds in the CJS mirror (re-redacting is a no-op)');

test('CJS redact is idempotent (matches TS idempotency)', () => {
  const once = cjsRedact(CANONICAL, { tier: 'extended' });
  assert.deepEqual(cjsRedact(once, { tier: 'extended' }), once);
  // And the CJS idempotent output equals the TS idempotent output.
  assert.deepEqual(cjsRedact(once, { tier: 'extended' }), tsRedact(tsRedact(CANONICAL, { tier: 'extended' }), { tier: 'extended' }));
});

console.log(`\n✓ TELEMETRY CJS-REDACT PARITY TESTS PASS (${passed})`);
