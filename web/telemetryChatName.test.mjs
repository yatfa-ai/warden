// telemetryChatName tests (WARDEN-1554). Loads the REAL src/lib/telemetryChatName.ts
// (TS -> ESM via Vite's OXC transform, like actingChat.test.mjs) and pins parity
// with the producer-side rule in ../src/workspaceNamesTelemetry.js (WARDEN-1550).
//
// Run: node --test telemetryChatName.test.mjs   (from web/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNamesSnapshot, RESUMED_SESSION_LABEL as PRODUCER_LABEL } from '../src/workspaceNamesTelemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsPath = resolve(__dirname, 'src/lib/telemetryChatName.ts');
const { code } = await transformWithOxc(readFileSync(tsPath, 'utf8'), tsPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetryChatName-test-'));
const tmpFile = join(tmpDir, 'telemetryChatName.mjs');
writeFileSync(tmpFile, code);
const { telemetryChatName, RESUME_SESSION_RE, RESUMED_SESSION_LABEL } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

const PROMPT = 'проверь доступность ремоут хостов whitego';

test('resume-shaped session with a prompt name collapses to the constant label', () => {
  assert.equal(telemetryChatName({ session: 'resume-3f9a1c2d', name: PROMPT }), 'resumed-session');
});

test('ordinary chats pass their name through unchanged', () => {
  assert.equal(telemetryChatName({ session: 'demo', name: 'demo' }), 'demo');
  assert.equal(telemetryChatName({ session: 'demo', name: 'my chat' }), 'my chat');
  assert.equal(telemetryChatName({ name: 'no session' }), 'no session');
});

test('no chat / empty / non-string name -> undefined', () => {
  assert.equal(telemetryChatName(null), undefined);
  assert.equal(telemetryChatName(undefined), undefined);
  assert.equal(telemetryChatName({ session: 'resume-3f9a1c2d' }), undefined);
  assert.equal(telemetryChatName({ session: 'resume-3f9a1c2d', name: '' }), undefined);
  assert.equal(telemetryChatName({ session: 'x', name: 42 }), undefined);
});

test('resume-shaped with name === session is unchanged', () => {
  assert.equal(telemetryChatName({ session: 'resume-3f9a1c2d', name: 'resume-3f9a1c2d' }), 'resume-3f9a1c2d');
});

test('look-alike sessions are unchanged', () => {
  for (const session of ['resume-', 'resume-123456789', 'xresume-1234', 'Resume-1234', 'resume-12 34']) {
    assert.equal(telemetryChatName({ session, name: PROMPT }), PROMPT, session);
  }
});

test('parity: label and regex source equal the producer-side rule', () => {
  assert.equal(RESUMED_SESSION_LABEL, PRODUCER_LABEL);
  const producerSrc = readFileSync(resolve(__dirname, '../src/workspaceNamesTelemetry.js'), 'utf8');
  const m = producerSrc.match(/const RESUME_SESSION_RE = (\/.*\/[a-z]*);/);
  assert.ok(m, 'producer RESUME_SESSION_RE declaration found');
  assert.equal(String(RESUME_SESSION_RE), m[1]);
});

test('parity table: renderer rule === producer snapshot rule for every row', () => {
  const rows = [
    { session: 'resume-3f9a1c2d', name: PROMPT },
    { session: 'resume-3f9a1c2d', name: 'resume-3f9a1c2d' },
    { session: 'resume-a', name: 'x' },
    { session: 'resume-a-b_c', name: 'x' },
    { session: 'resume-', name: PROMPT },
    { session: 'resume-123456789', name: PROMPT },
    { session: 'xresume-1234', name: PROMPT },
    { session: 'demo', name: 'demo' },
    { session: 'demo', name: PROMPT },
    { name: PROMPT },
    { session: 42, name: PROMPT },
  ];
  for (const row of rows) {
    const mine = telemetryChatName(row) === 'resumed-session';
    const theirs = buildNamesSnapshot([row]).chats.length === 1
      && buildNamesSnapshot([row]).chats[0] === 'resumed-session';
    assert.equal(mine, theirs, JSON.stringify(row));
  }
});
