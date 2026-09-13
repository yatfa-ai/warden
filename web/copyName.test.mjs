/** Unit tests for the shared non-colliding "(copy)"-suffix name synthesizer
 *  (WARDEN-1359), extracted from duplicatePattern (PatternsSection, WARDEN-898)
 *  and now shared by the snippet / preset / pattern Duplicate handlers. This is
 *  the one genuinely new affordance of the snippet/preset context-menu slice,
 *  and its failure modes are silent: a colliding name is rejected by the
 *  validator (no copy appears), an over-cap name is dropped by the load-time
 *  sanitizer (the copy vanishes on reload). Both are guards the loop must
 *  never trip, so the loop is the thing under test.
 *
 *  No front-end test runner in this repo, so (like rowDraftCommit.test.mjs)
 *  this loads the REAL src/lib/copyName.ts, transpiled TS -> ESM via Vite's
 *  OXC transform. The module is import-free, so the emitted code loads
 *  standalone. Auto-discovered by `npm test` (`node --test` runs every
 *  *.test.mjs in web/).
 *
 *  Run: node copyName.test.mjs   (from web/) */
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load the REAL module (TS -> ESM via the OXC transform) ---
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-copy-name-test-'));
const modPath = resolve(__dirname, 'src/lib/copyName.ts');
const { code } = await transformWithOxc(readFileSync(modPath, 'utf8'), modPath, {});
writeFileSync(join(tmpDir, 'copyName.mjs'), code);
const { nonCollidingCopyName } = await import(join(tmpDir, 'copyName.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

test('first duplicate gets the plain "(copy)" suffix', () => {
  assert.equal(nonCollidingCopyName('Run tests', () => false, 32), 'Run tests (copy)');
  assert.equal(nonCollidingCopyName('codex', () => false, 32), 'codex (copy)');
});

test('a taken "(copy)" steps up to "(copy 2)", then "(copy 3)" — the documented order', () => {
  const taken = new Set(['Run tests (copy)', 'Run tests (copy 2)']);
  const seen = [];
  const name = nonCollidingCopyName('Run tests', (c) => { seen.push(c); return taken.has(c); }, 32);
  assert.equal(name, 'Run tests (copy 3)');
  assert.deepEqual(seen, ['Run tests (copy)', 'Run tests (copy 2)', 'Run tests (copy 3)']);
});

test('the source name itself is never offered as a candidate — the caller excludes it', () => {
  // Mirrors the section wiring: validate*Name(candidate, list) — the source is
  // IN the list, so a candidate equal to the source must read as taken and the
  // loop must step past it.
  const list = ['Run tests', 'Run tests (copy)'];
  const name = nonCollidingCopyName('Run tests', (c) => list.includes(c), 32);
  assert.equal(name, 'Run tests (copy 2)');
});

test('duplicate detection is the caller\'s predicate — a case-insensitive one collides case-variants', () => {
  // Matches validateEntryName's CASE-INSENSITIVE duplicate rule: "run tests"
  // and "Run Tests" are the same name to the contract, so the synthesizer
  // must step past a case-variant sibling too.
  const list = ['Run tests (COPY)'];
  const name = nonCollidingCopyName('Run tests', (c) => list.some((n) => n.toLowerCase() === c.toLowerCase()), 32);
  assert.equal(name, 'Run tests (copy 2)');
});

test('truncation keeps a source name already at the cap within it once suffixed', () => {
  // SNIPPET_NAME_MAX / PRESET_NAME_MAX = 32: a 32-char source must yield a
  // ≤32-char copy ("Name (copy)" needs 7 chars of headroom) — a name the
  // load-time sanitizer would silently drop is the failure this guards.
  const longName = 'a'.repeat(32);
  const name = nonCollidingCopyName(longName, () => false, 32);
  assert.ok(name.length <= 32, `expected <= 32, got ${name.length}`);
  assert.equal(name, 'a'.repeat(25) + ' (copy)');
});

test('the truncation budget adapts to the wider "(copy N)" suffix', () => {
  const longName = 'a'.repeat(32);
  // Fill copies 1..9, so the next free slot is "(copy 10)" — whose suffix is
  // wider (" (copy 10)" is 10 chars) and must shrink the base to 32-10 = 22.
  const taken = new Set();
  for (let i = 0; i < 9; i++) {
    taken.add(nonCollidingCopyName(longName, (c) => taken.has(c), 32));
  }
  const name = nonCollidingCopyName(longName, (c) => taken.has(c), 32);
  assert.equal(name, 'a'.repeat(22) + ' (copy 10)');
  assert.ok(name.length <= 32);
});

test('terminates on a densely-colliding list (every candidate taken up to a free slot)', () => {
  const taken = new Set([
    'x (copy)', 'x (copy 2)', 'x (copy 3)', 'x (copy 4)',
    'x (copy 5)', 'x (copy 6)', 'x (copy 7)', 'x (copy 8)',
  ]);
  assert.equal(nonCollidingCopyName('x', (c) => taken.has(c), 32), 'x (copy 9)');
});
