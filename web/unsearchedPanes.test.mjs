// WARDEN-1945 — /api/search-pane `unsearchedPanes` disclosure in GlobalSearchDialog.
// No DOM runner here (see searchRaceGuard.test.mjs), so: PART 1 drives the real
// pure helper; PART 2 pins the component's wiring from source.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.resolve(__dirname, 'src/lib/unsearchedPanes.ts');
const { code } = await transformWithOxc(readFileSync(helperPath, 'utf8'), helperPath, {});
const tmpDir = mkdtempSync(path.join(tmpdir(), 'warden-unsearched-panes-'));
const tmpFile = path.join(tmpDir, 'unsearchedPanes.mjs');
writeFileSync(tmpFile, code);
const { parseUnsearchedPanes, formatUnsearchedPanes } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

const src = readFileSync(path.join(__dirname, 'src/components/GlobalSearchDialog.tsx'), 'utf8');

describe('parseUnsearchedPanes', () => {
  it('absent / non-array / empty all mean fully searched', () => {
    assert.deepEqual(parseUnsearchedPanes(undefined), []);
    assert.deepEqual(parseUnsearchedPanes('x'), []);
    assert.deepEqual(parseUnsearchedPanes({}), []);
    assert.deepEqual(parseUnsearchedPanes([]), []);
  });
  it('keeps well-formed entries and drops malformed ones', () => {
    const out = parseUnsearchedPanes([{ key: 'a', host: 'h1', name: 'A' }, null, 5, { key: 'b' }, {}]);
    assert.deepEqual(out, [{ key: 'a', host: 'h1', name: 'A' }, { key: 'b', host: '', name: 'b' }]);
  });
  it('formats name@host', () => {
    assert.equal(formatUnsearchedPanes([{ key: 'a', host: 'h1', name: 'A' }, { key: 'b', host: '', name: 'b' }]), 'A@h1, b');
  });
});

describe('GlobalSearchDialog wiring', () => {
  it('renders the Partial note and suppresses "No results found" when panes were unsearched', () => {
    assert.match(src, /Partial — could not search: \{formatUnsearchedPanes\(unsearchedPanes\)\}/);
    assert.match(src, /results\.length === 0 && !searching && !error && !sessionsShowing && unsearchedPanes\.length === 0/);
  });
  it('reads the server key through the type-guarded parser', () => {
    assert.match(src, /setUnsearchedPanes\(parseUnsearchedPanes\(data\.unsearchedPanes\)\)/);
  });
  it('resets the state on error, catch, new search, query cleared and close', () => {
    const resets = src.match(/setUnsearchedPanes\(\[\]\)/g) ?? [];
    assert.ok(resets.length >= 5, `expected >=5 resets, got ${resets.length}`);
  });
});
