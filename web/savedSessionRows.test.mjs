// Unit tests for the rebuilt sidebar's pure helpers (WARDEN-1422).
// SavedSessionRows.tsx exports the decision logic the Ink rows render: the
// working/stopped split (the two dots ARE the whole classification), the
// recency ordering, the identity-chip hue, and the search-highlight split.
// This repo has no DOM runner, so — per the chatDisplay.test.mjs precedent —
// the pure-function block is transpiled to a temp .mjs (vite's OXC transform,
// which the module's React component half never reaches) and imported here.
// If someone makes these helpers depend on React state, the slice breaks and
// this file goes red — which is the right outcome: they must stay pure.
//
// Run: node savedSessionRows.test.mjs   (from web/)
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformWithOxc } from 'vite';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, 'src/components/sidebar/SavedSessionRows.tsx'), 'utf8');

// Slice the pure block: hueOf → MatchParts → matchHighlight → splitSaved →
// byRecencyDesc, which sit together between the module imports and the first
// component (HighlightedName). The `Chat` type annotations inside are erased
// by the transform without needing the import.
const startMark = '// Deterministic identity-chip hue';
const endMark = '// The name span';
const start = src.indexOf(startMark);
const end = src.indexOf(endMark);
assert.ok(start > 0 && end > start, 'the pure-function block moved — re-point the slice markers');
const slice = src.slice(start, end);

const { code } = await transformWithOxc(slice, 'savedSessionRows.pure.ts', {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-ink-'));
const tmpFile = join(tmpDir, 'rows.mjs');
writeFileSync(tmpFile, code);
const { hueOf, matchHighlight, splitSaved, byRecencyDesc } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

const chat = (over) => ({ id: 'h:s', key: 's', name: 's', active: null, ...over });

describe('splitSaved — the two dots are the whole classification (WARDEN-1422)', () => {
  it('active===false is stopped; everything else (true, null) is working', () => {
    const { working, stopped } = splitSaved([
      chat({ id: '1', active: true }),
      chat({ id: '2', active: false }),
      chat({ id: '3', active: null }),  // undiscovered — transient, renders working
      chat({ id: '4' }),                 // absent field — same
    ]);
    assert.deepEqual(working.map((c) => c.id), ['1', '3', '4']);
    assert.deepEqual(stopped.map((c) => c.id), ['2']);
  });

  it('an empty host list splits to two empty groups', () => {
    assert.deepEqual(splitSaved([]), { working: [], stopped: [] });
  });
});

describe('byRecencyDesc — most recently active first', () => {
  it('orders by lastActivity descending', () => {
    const rows = [
      chat({ id: 'old', lastActivity: 1000 }),
      chat({ id: 'new', lastActivity: 3000 }),
      chat({ id: 'mid', lastActivity: 2000 }),
    ];
    assert.deepEqual(rows.sort(byRecencyDesc).map((c) => c.id), ['new', 'mid', 'old']);
  });

  it('a chat with no lastActivity sinks below one that has it; ties break by name', () => {
    const rows = [
      chat({ id: 'b', name: 'b' }),
      chat({ id: 'has', name: 'a', lastActivity: 5 }),
      chat({ id: 'a', name: 'a' }),
    ];
    assert.deepEqual(rows.sort(byRecencyDesc).map((c) => c.id), ['has', 'a', 'b']);
  });
});

describe('hueOf — deterministic identity-chip hue', () => {
  it('is stable across calls and distinct for distinct names', () => {
    assert.equal(hueOf('release train 0.1.75'), hueOf('release train 0.1.75'));
    assert.notEqual(hueOf('release train 0.1.75'), hueOf('docs pass'));
  });

  it('stays within the hsl hue range and handles empty names', () => {
    const h = hueOf('');
    assert.ok(h >= 0 && h < 360, `hue out of range: ${h}`);
    for (const n of ['a', 'chat-4nh15o', 'ёмкая сессия', '🎉']) {
      const v = hueOf(n);
      assert.ok(v >= 0 && v < 360);
    }
  });
});

describe('matchHighlight — the live search highlight split', () => {
  it('splits [pre][hit][post] case-insensitively on the first occurrence', () => {
    assert.deepEqual(matchHighlight('Release Train', 'train'), { pre: 'Release ', hit: 'Train', post: '' });
    assert.deepEqual(matchHighlight('docs pass', 'docs'), { pre: '', hit: 'docs', post: ' pass' });
    // the query is trimmed once — a trailing space must not turn into a miss
    assert.deepEqual(matchHighlight('docs pass', 'docs '), { pre: '', hit: 'docs', post: ' pass' });
  });

  it('returns null for no match and for an empty/blank query', () => {
    assert.equal(matchHighlight('docs pass', 'zzz'), null);
    assert.equal(matchHighlight('docs pass', ''), null);
    assert.equal(matchHighlight('docs pass', '   '), null);
  });
});
