// Tests for fleetCommitSearchEligible — the shared population gate that resolves
// WHICH agents a fleet-wide git fan-out covers (active + project, keyed by key || id,
// deduped).
//
// It was introduced for WARDEN-534's fleet-wide commit search, which WARDEN-975
// removed along with every other fleet-level git surface in the sidebar. The gate
// itself SURVIVES (and keeps its now-misleading name) because it is mode-agnostic and
// FLEET HEALTH still calls it from both of its fan-outs — FleetRecentCommits and
// useFleetGitStatus — which are explicitly out of WARDEN-975's scope. The grouping
// half of this file (buildFleetCommitGroups / buildFleetSearchBaseUrl) went with the
// helpers it covered, as did fleetCodeSearch.test.mjs.
//
// There is no front-end test runner in this repo, so this loads the REAL
// src/lib/gitStateSummary.ts (transpiled TS -> ESM via Vite's OXC transform) and
// exercises it directly with plain objects. The fan-out (the actual fetches) is NOT
// pure and lives in the React components; this covers only the testable seam — who
// gets fanned over.
//
// Run: node fleetCommitSearch.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/gitStateSummary.ts');

// --- Load the REAL gitStateSummary.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fleet-search-test-'));
const tmpFile = join(tmpDir, 'gitStateSummary.mjs');
writeFileSync(tmpFile, code);
const { fleetCommitSearchEligible } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny builder so each case reads as "which agents are eligible".
// `chat` mirrors the FleetSearchChat slice (id + optional key/project/active).
const chat = (id, project, opts = {}) => ({ id, project, active: true, ...opts });

console.log('\nfleetCommitSearchEligible — population gate (active && project, keyed, deduped)');
test('an active chat with a project is searchable, keyed by key when present', () => {
  const e = fleetCommitSearchEligible([chat('raw-1', 'warden', { key: 'warden-worker' })]);
  assert.deepEqual(e, [{ key: 'warden-worker', project: 'warden' }]);
});
test('an active chat with a project but no key falls back to id', () => {
  const e = fleetCommitSearchEligible([chat('chat-1', 'warden')]);
  assert.deepEqual(e, [{ key: 'chat-1', project: 'warden' }]);
});
test('an inactive agent is skipped (never grepped — would just error)', () => {
  const e = fleetCommitSearchEligible([chat('a1', 'warden', { active: false })]);
  assert.deepEqual(e, []);
});
test('active:null (undiscovered) is skipped — only known-active chats are searched', () => {
  const e = fleetCommitSearchEligible([chat('a1', 'warden', { active: null })]);
  assert.deepEqual(e, []);
});
test('an active agent without a project is skipped (nothing to fan a git call over)', () => {
  const e = fleetCommitSearchEligible([chat('a1', undefined)]);
  assert.deepEqual(e, []);
});
test('two chats sharing a resolved key are deduped — the same repo is grepped once', () => {
  // A yatfa agent (key set) and a stray entry collapsing to the same key must not
  // double-fetch: the fleet fan-out fires one grep per distinct key.
  const e = fleetCommitSearchEligible([
    chat('raw-1', 'warden', { key: 'warden-worker' }),
    chat('raw-2', 'warden', { key: 'warden-worker' }),
  ]);
  assert.deepEqual(e, [{ key: 'warden-worker', project: 'warden' }]);
});
test('eligibility is emitted in chats iteration order (deterministic grouping)', () => {
  const e = fleetCommitSearchEligible([
    chat('a1', 'warden'), chat('b1', 'tinker'), chat('c1', 'nova'),
  ]);
  assert.deepEqual(e.map((x) => x.key), ['a1', 'b1', 'c1']);
  assert.deepEqual(e.map((x) => x.project), ['warden', 'tinker', 'nova']);
});
test('mixed fleet: only active project chats survive, in order', () => {
  const e = fleetCommitSearchEligible([
    chat('a1', 'warden'),                       // eligible
    chat('a2', 'warden', { active: false }),    // inactive → skip
    chat('a3'),                                  // no project → skip
    chat('a4', 'tinker', { key: 't-w' }),        // eligible (keyed)
  ]);
  assert.deepEqual(e, [
    { key: 'a1', project: 'warden' },
    { key: 't-w', project: 'tinker' },
  ]);
});
test('empty input is safe', () => {
  assert.deepEqual(fleetCommitSearchEligible([]), []);
});

console.log(`\n✓ FLEET COMMIT SEARCH TESTS PASS (${passed})`);
