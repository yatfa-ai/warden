import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/healthUtils.ts');
const { code } = await transformWithOxc(readFileSync(helperPath, 'utf8'), helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fleetSummary-test-'));
const tmpFile = join(tmpDir, 'healthUtils.mjs');
writeFileSync(tmpFile, code);
const { formatFleetSummaryText } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

import { test } from 'node:test';

const summary = { total: 12, healthy: 7, warning: 2, critical: 1, idle: 1, closed: 0, unknown: 1 };
const axes = [
  { count: 'dirtyCount', label: 'dirty' },
  { count: 'conflictCount', label: 'conflict' },
  { count: 'behindCount', label: 'behind' },
];
const zero = { dirtyCount: 0, conflictCount: 0, behindCount: 0 };

test('zero git axes and no errors are omitted', () => {
  assert.equal(
    formatFleetSummaryText({ summary, axes, git: zero, errorCount: 0 }),
    '12 agents · 7 healthy · 2 warning · 1 critical · 1 idle · 0 closed · 1 unknown',
  );
});

test('a non-zero axis is included in axes order', () => {
  assert.equal(
    formatFleetSummaryText({ summary, axes, git: { ...zero, dirtyCount: 3, behindCount: 2 }, errorCount: 0 }),
    '12 agents · 7 healthy · 2 warning · 1 critical · 1 idle · 0 closed · 1 unknown · 3 dirty · 2 behind',
  );
});

test('unreachable note is appended last when errorCount > 0', () => {
  assert.equal(
    formatFleetSummaryText({ summary, axes, git: { ...zero, conflictCount: 1 }, errorCount: 4 }),
    '12 agents · 7 healthy · 2 warning · 1 critical · 1 idle · 0 closed · 1 unknown · 1 conflict · 4 unreachable',
  );
});
