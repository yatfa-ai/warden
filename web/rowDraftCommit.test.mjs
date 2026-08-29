/** Unit tests for the shared settings-row draft-commit decision helpers
 *  (WARDEN-1219). These rules were previously hand-copied six times across
 *  PresetRow / SnippetRow / PatternRow with no coverage; the empty-name case is
 *  the silent-data-loss guard (parseCustomPresets / parseSnippets would drop a
 *  stored entry whose name was committed empty). Pure decisions — no rendering.
 *
 *  No front-end test runner in this repo, so (like settingsDirty.test.mjs) this
 *  loads the REAL src/components/settings/rows/draftCommit.ts, transpiled
 *  TS -> ESM via Vite's OXC transform. The module is import-free, so the
 *  emitted code loads standalone.
 *
 *  This file is auto-discovered by `npm test` (`node --test` runs every
 *  *.test.mjs in web/), so it runs in CI with no package.json wiring.
 *
 *  Run: node rowDraftCommit.test.mjs   (from web/) */
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load the REAL module (TS -> ESM via the OXC transform) ---
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-row-draft-commit-test-'));
const modPath = resolve(__dirname, 'src/components/settings/rows/draftCommit.ts');
const { code } = await transformWithOxc(readFileSync(modPath, 'utf8'), modPath, {});
writeFileSync(join(tmpDir, 'draftCommit.mjs'), code);
const { decideDraftNameCommit, decideDraftValueCommit } = await import(join(tmpDir, 'draftCommit.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

test('name rule: a changed, non-empty name commits (trimmed)', () => {
  assert.deepEqual(decideDraftNameCommit('  new-name  ', 'old-name'), { commit: true, value: 'new-name' });
  assert.deepEqual(decideDraftNameCommit('renamed', 'original'), { commit: true, value: 'renamed' });
});

test('name rule: an empty draft reverts — never persist an empty name (data-loss guard)', () => {
  assert.deepEqual(decideDraftNameCommit('', 'stored-name'), { commit: false });
  assert.deepEqual(decideDraftNameCommit('   ', 'stored-name'), { commit: false });
  assert.deepEqual(decideDraftNameCommit('\t\n', 'stored-name'), { commit: false });
});

test('name rule: an unchanged draft reverts (no no-op rename attempt)', () => {
  assert.deepEqual(decideDraftNameCommit('same', 'same'), { commit: false });
  // unchanged after trimming is still unchanged
  assert.deepEqual(decideDraftNameCommit('  same  ', 'same'), { commit: false });
});

test('value rule: a non-empty value commits (trimmed), even when unchanged', () => {
  assert.deepEqual(decideDraftValueCommit('  npm run build  '), { commit: true, value: 'npm run build' });
  // the original row bodies only guarded emptiness here, not change
  assert.deepEqual(decideDraftValueCommit('same-as-saved'), { commit: true, value: 'same-as-saved' });
});

test('value rule: an empty draft reverts — never persist an empty value (data-loss guard)', () => {
  assert.deepEqual(decideDraftValueCommit(''), { commit: false });
  assert.deepEqual(decideDraftValueCommit('   '), { commit: false });
  assert.deepEqual(decideDraftValueCommit('\n\t '), { commit: false });
});
