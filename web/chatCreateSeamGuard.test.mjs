// WARDEN-1513 — STATIC SOURCE GUARD for the `chat-create` feature-usage seed.
//
// WHY: the seed was recorded only in SpawnControl's submit handler, but
// App.tsx `spawnShell` — the single seam that POSTs /api/spawn for shell
// creation — has three callers (SpawnControl, ChatSidebar's empty-host
// "+ Start a shell", handleSplitShell), so the adoption window undercounted.
// The record now lives in `spawnShell`, AFTER the failure early return (a
// failed spawn counts nothing), and nowhere in the UI call sites.
//
// No React/DOM runner here, so the wiring is pinned by a static source
// assertion (precedent: web/workspaceShapeTickGuard.test.mjs).
//
// Mutation check: move the call before the `!result.ok` return, or back into
// SpawnControl.tsx, and this file goes red.
//
// Auto-discovered by `npm test` in web/ (`node --test`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src', 'App.tsx'), 'utf8');
const spawnControlSrc = readFileSync(
  resolve(__dirname, 'src', 'components', 'sidebar', 'SpawnControl.tsx'), 'utf8');

const RECORD = "recordFeatureUse('chat-create')";

// Extracts the `const spawnShell = useCallback(...)` body: from its declaration
// up to the next top-level `useCallback` declaration.
function spawnShellBody(src) {
  const start = src.indexOf('const spawnShell = useCallback(');
  assert.notEqual(start, -1, 'App.tsx declares the spawnShell callback');
  const next = src.indexOf('\n  const ', start + 10);
  assert.notEqual(next, -1, 'the spawnShell callback is followed by another declaration');
  return src.slice(start, next);
}

test("App.tsx records 'chat-create' exactly once, inside spawnShell", () => {
  assert.equal(appSrc.split(RECORD).length - 1, 1, 'exactly one chat-create record in App.tsx');
  assert.ok(spawnShellBody(appSrc).includes(RECORD), 'the record sits inside the spawnShell body');
});

test("the record sits AFTER spawnShell's failure early return (failures count nothing)", () => {
  const body = spawnShellBody(appSrc);
  const failIdx = body.indexOf('if (!result.ok || !result.data)');
  assert.notEqual(failIdx, -1, 'the !result.ok early return is findable');
  const returnIdx = body.indexOf('return false;', failIdx);
  assert.notEqual(returnIdx, -1, 'the early return statement is findable');
  const recordIdx = body.indexOf(RECORD);
  assert.ok(recordIdx > returnIdx, 'the record comes after the failure `return false`');
});

test('SpawnControl.tsx no longer records any feature use', () => {
  assert.ok(!spawnControlSrc.includes('recordFeatureUse'), 'no recordFeatureUse in SpawnControl.tsx');
});
