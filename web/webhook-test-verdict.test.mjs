// UI-layer tests for the "Send test alert" verdict mapping (WARDEN-970).
// describeWebhookTestVerdict is the PURE seam that turns the raw transport
// result POST /api/webhook-test returns ({ ok, dropped, attempts, status }) into
// the { kind, tone, label, message } the Settings page renders — split out so
// every branch is verifiable without a browser (the worker sandbox cannot drive
// the renderer; CDP SIGTRAPs). Loads the REAL web/src/lib/webhook/testAlert.ts,
// transpiled TS -> ESM via Vite's OXC transform (same harness as
// telemetry-test-connection.test.mjs). The module has no runtime imports, so it
// loads standalone.
//
// Run: node webhook-test-verdict.test.mjs   (from web/)

import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/webhook/testAlert.ts');

// --- Load the REAL testAlert.ts (TS -> ESM via the OXC transform Vite uses) ---
const src = readFileSync(modPath, 'utf8');
const { code } = await transformWithOxc(src, modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-webhook-verdict-'));
const tmpFile = join(tmpDir, 'testAlert.mjs');
writeFileSync(tmpFile, code);
const { describeWebhookTestVerdict, webhookTestRequestFailedVerdict } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- The affirmative state ---

test('ok:true → delivered, positive tone', () => {
  const v = describeWebhookTestVerdict({ ok: true, dropped: false, attempts: 1, status: 200 });
  assert.equal(v.kind, 'delivered');
  assert.equal(v.tone, 'positive');
  assert.equal(v.label, 'Delivered');
  assert.match(v.message, /accepted the test alert/i);
});

test('ok:true wins over a stale status/attempts shape (ok is the source of truth)', () => {
  const v = describeWebhookTestVerdict({ ok: true, dropped: false, attempts: 0, status: null });
  assert.equal(v.kind, 'delivered');
  assert.equal(v.tone, 'positive');
});

// --- The gate no-op (NOOP_RESULT, src/notify.js:59) ---

test('attempts:0 → not-configured (nothing was ever attempted)', () => {
  const v = describeWebhookTestVerdict({ ok: false, dropped: false, attempts: 0, status: null });
  assert.equal(v.kind, 'not-configured');
  assert.equal(v.tone, 'warning');
  assert.equal(v.label, 'No URL configured');
  assert.match(v.message, /Nothing was sent/i);
});

// --- Dropped, by status class: each names the CAUSE, not the raw code alone ---

for (const status of [401, 403]) {
  test(`dropped ${status} → auth-rejected, names the shared secret`, () => {
    const v = describeWebhookTestVerdict({ ok: false, dropped: true, attempts: 1, status });
    assert.equal(v.kind, 'auth-rejected');
    assert.equal(v.tone, 'warning');
    assert.equal(v.label, 'Auth rejected');
    assert.match(v.message, /shared secret/i);
    assert.match(v.message, new RegExp(`status ${status}`));
  });
}

for (const status of [404, 410]) {
  test(`dropped ${status} → no-receiver, names the URL/topic`, () => {
    const v = describeWebhookTestVerdict({ ok: false, dropped: true, attempts: 1, status });
    assert.equal(v.kind, 'no-receiver');
    assert.equal(v.tone, 'warning');
    assert.equal(v.label, 'No receiver');
    assert.match(v.message, /URL or topic/i);
    assert.match(v.message, new RegExp(`status ${status}`));
  });
}

for (const status of [429, 500, 502, 503, 599]) {
  test(`dropped ${status} → receiver-error (throttled or erroring), "try again"`, () => {
    const v = describeWebhookTestVerdict({ ok: false, dropped: true, attempts: 3, status });
    assert.equal(v.kind, 'receiver-error');
    assert.equal(v.tone, 'warning');
    assert.equal(v.label, 'Receiver throttled or erroring');
    assert.match(v.message, /try again/i);
    assert.match(v.message, new RegExp(`status ${status}`));
  });
}

test('dropped with status null → unreachable (no response ever produced)', () => {
  const v = describeWebhookTestVerdict({ ok: false, dropped: true, attempts: 3, status: null });
  assert.equal(v.kind, 'unreachable');
  assert.equal(v.tone, 'warning');
  assert.equal(v.label, 'Could not reach');
  assert.match(v.message, /never got a response/i);
  // No fabricated status when there was none.
  assert.ok(!/status \d/.test(v.message), 'must not invent a status');
});

test('dropped with an ABSENT status field → unreachable (undefined reads like null)', () => {
  const v = describeWebhookTestVerdict({ ok: false, dropped: true, attempts: 3 });
  assert.equal(v.kind, 'unreachable');
});

// --- Boundary: 499 is NOT >= 500, so it must not read as a receiver error ---

test('dropped 499 falls to the fallback, not receiver-error (>=500 boundary)', () => {
  const v = describeWebhookTestVerdict({ ok: false, dropped: true, attempts: 1, status: 499 });
  assert.notEqual(v.kind, 'receiver-error');
  assert.equal(v.kind, 'unknown');
  assert.equal(v.tone, 'warning');
});

test('dropped 400 → fallback that still carries the exact status', () => {
  const v = describeWebhookTestVerdict({ ok: false, dropped: true, attempts: 1, status: 400 });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.label, 'Could not deliver');
  assert.match(v.message, /status 400/);
});

// --- Tone integrity: green is reserved for delivered ONLY ---

test('every non-ok result is a warning — a green tone is reserved for delivered', () => {
  const results = [
    { ok: false, dropped: false, attempts: 0, status: null },
    { ok: false, dropped: true, attempts: 1, status: 401 },
    { ok: false, dropped: true, attempts: 1, status: 403 },
    { ok: false, dropped: true, attempts: 1, status: 404 },
    { ok: false, dropped: true, attempts: 1, status: 410 },
    { ok: false, dropped: true, attempts: 3, status: 429 },
    { ok: false, dropped: true, attempts: 3, status: 503 },
    { ok: false, dropped: true, attempts: 3, status: null },
    { ok: false, dropped: true, attempts: 1, status: 418 },
    { ok: false, dropped: false, attempts: 2, status: 200 },
  ];
  for (const r of results) {
    const v = describeWebhookTestVerdict(r);
    assert.equal(v.tone, 'warning', `${JSON.stringify(r)} must not read as success`);
    assert.notEqual(v.kind, 'delivered');
  }
});

test('a truthy-but-not-true ok is NOT delivered (strict === true, never green on coercion)', () => {
  const v = describeWebhookTestVerdict({ ok: 'yes', dropped: false, attempts: 1, status: 200 });
  assert.equal(v.tone, 'warning');
  assert.notEqual(v.kind, 'delivered');
});

// --- Defensive: a surprise shape never throws in the renderer ---

test('an unknown shape falls back to a neutral warning (never throws)', () => {
  const v = describeWebhookTestVerdict({ error: 'boom' });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.tone, 'warning');
  assert.ok(v.label.length > 0);
  assert.ok(v.message.length > 0);
});

for (const bad of [null, undefined, {}]) {
  test(`a ${bad === undefined ? 'undefined' : JSON.stringify(bad)} result is mapped, not thrown on`, () => {
    const v = describeWebhookTestVerdict(bad);
    assert.equal(v.kind, 'unknown');
    assert.equal(v.tone, 'warning');
  });
}

// --- Every verdict is renderable: 4 non-empty fields, always ---

test('every branch returns a complete, renderable verdict', () => {
  const inputs = [
    { ok: true, attempts: 1, status: 200 },
    { ok: false, dropped: false, attempts: 0, status: null },
    { ok: false, dropped: true, attempts: 1, status: 401 },
    { ok: false, dropped: true, attempts: 1, status: 404 },
    { ok: false, dropped: true, attempts: 3, status: 500 },
    { ok: false, dropped: true, attempts: 3, status: null },
    { ok: false, dropped: true, attempts: 1, status: 400 },
    null,
  ];
  for (const r of inputs) {
    const v = describeWebhookTestVerdict(r);
    assert.ok(typeof v.kind === 'string' && v.kind.length > 0);
    assert.ok(v.tone === 'positive' || v.tone === 'warning');
    assert.ok(typeof v.label === 'string' && v.label.length > 0);
    assert.ok(typeof v.message === 'string' && v.message.length > 0);
  }
});

// --- Distinctness: the outcomes a human acts on differently READ differently ---

test('the six mapped states have pairwise-distinct labels', () => {
  const labels = [
    { ok: true, attempts: 1, status: 200 },
    { ok: false, dropped: false, attempts: 0, status: null },
    { ok: false, dropped: true, attempts: 1, status: 401 },
    { ok: false, dropped: true, attempts: 1, status: 404 },
    { ok: false, dropped: true, attempts: 3, status: 500 },
    { ok: false, dropped: true, attempts: 3, status: null },
  ].map((r) => describeWebhookTestVerdict(r).label);
  assert.equal(new Set(labels).size, 6, 'six distinct labels for six states');
});

// --- The local-request-failure verdict blames Warden, never the receiver ---

test('webhookTestRequestFailedVerdict → warning, does not blame the receiver', () => {
  const v = webhookTestRequestFailedVerdict('NetworkError when attempting to fetch resource');
  assert.equal(v.kind, 'request-failed');
  assert.equal(v.tone, 'warning');
  assert.match(v.message, /NetworkError/);
  assert.ok(!/receiver/i.test(v.message), 'must not blame the user’s receiver');
});

test('webhookTestRequestFailedVerdict with an empty detail is still renderable', () => {
  const v = webhookTestRequestFailedVerdict('');
  assert.equal(v.kind, 'request-failed');
  assert.ok(v.message.length > 0);
});

console.log(`\n# tests ${passed}`);
console.log(`# pass ${passed}`);
console.log('# fail 0');
