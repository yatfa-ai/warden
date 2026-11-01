// Pins sanitizeWatchPatterns' persistence-boundary caps (WARDEN-2079): the 64-char
// name cap, the 500-char expression cap, measure-after-trim, the drop-before-dedup
// ordering, the count cap interplay with dropped entries, and the invariant that the
// web constants in web/src/lib/storage.ts mirror the server's verbatim (so the UI can
// never accept a pattern the server silently drops on save).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sanitizeWatchPatterns,
  WATCH_PATTERN_NAME_MAX,
  WATCH_PATTERN_EXPRESSION_MAX,
  WATCH_PATTERN_MAX_COUNT,
} from './agentState.js';

const entry = (over = {}) => ({ id: 'p1', name: 'n', expression: 'e', mode: 'string', enabled: true, ...over });

describe('sanitizeWatchPatterns — length caps (WARDEN-2079)', () => {
  test('name of exactly WATCH_PATTERN_NAME_MAX is kept; one more is dropped', () => {
    const ok = 'a'.repeat(WATCH_PATTERN_NAME_MAX);
    const bad = 'a'.repeat(WATCH_PATTERN_NAME_MAX + 1);
    const out = sanitizeWatchPatterns([entry({ id: 'ok', name: ok }), entry({ id: 'bad', name: bad })]);
    assert.deepEqual(out.map((p) => p.id), ['ok']);
    assert.equal(out[0].name.length, WATCH_PATTERN_NAME_MAX);
  });

  test('expression of exactly WATCH_PATTERN_EXPRESSION_MAX is kept; one more is dropped', () => {
    const ok = 'x'.repeat(WATCH_PATTERN_EXPRESSION_MAX);
    const bad = 'x'.repeat(WATCH_PATTERN_EXPRESSION_MAX + 1);
    const out = sanitizeWatchPatterns([entry({ id: 'ok', expression: ok }), entry({ id: 'bad', expression: bad })]);
    assert.deepEqual(out.map((p) => p.id), ['ok']);
    assert.equal(out[0].expression.length, WATCH_PATTERN_EXPRESSION_MAX);
  });

  test('caps are measured on the trimmed value and id/name/expression are stored trimmed', () => {
    const name = 'n'.repeat(WATCH_PATTERN_NAME_MAX);
    const expression = 'e'.repeat(WATCH_PATTERN_EXPRESSION_MAX);
    const out = sanitizeWatchPatterns([
      { id: '  padded  ', name: `  ${name}  `, expression: `\n ${expression} \t`, mode: 'regex' },
    ]);
    assert.deepEqual(out, [{ id: 'padded', name, expression, mode: 'regex', enabled: true }]);
  });

  test('whitespace-only id, name or expression drops the entry', () => {
    assert.deepEqual(sanitizeWatchPatterns([entry({ id: '   ' })]), []);
    assert.deepEqual(sanitizeWatchPatterns([entry({ name: '   ' })]), []);
    assert.deepEqual(sanitizeWatchPatterns([entry({ expression: ' \n ' })]), []);
  });

  test('a dropped over-long entry does not burn its id for a later valid entry', () => {
    const tooLongName = 'a'.repeat(WATCH_PATTERN_NAME_MAX + 1);
    const tooLongExpr = 'x'.repeat(WATCH_PATTERN_EXPRESSION_MAX + 1);
    const out = sanitizeWatchPatterns([
      entry({ id: 'dup', name: tooLongName }),
      entry({ id: 'dup2', expression: tooLongExpr }),
      entry({ id: 'dup', name: 'valid' }),
      entry({ id: 'dup2', name: 'valid2' }),
    ]);
    assert.deepEqual(out.map((p) => [p.id, p.name]), [['dup', 'valid'], ['dup2', 'valid2']]);
  });

  test('dropped entries do not consume the count cap: junk + valid → exactly MAX_COUNT kept, first is v0', () => {
    const junk = [
      entry({ id: 'j1', name: 'a'.repeat(WATCH_PATTERN_NAME_MAX + 1) }),
      entry({ id: 'j2', expression: 'x'.repeat(WATCH_PATTERN_EXPRESSION_MAX + 1) }),
      entry({ id: '' }),
      null,
      'str',
    ];
    const valid = Array.from({ length: WATCH_PATTERN_MAX_COUNT + 3 }, (_, i) => entry({ id: `v${i}`, name: `n${i}` }));
    const out = sanitizeWatchPatterns([...junk, ...valid]);
    assert.equal(out.length, WATCH_PATTERN_MAX_COUNT);
    assert.equal(out[0].id, 'v0');
    assert.equal(out[out.length - 1].id, `v${WATCH_PATTERN_MAX_COUNT - 1}`);
  });
});

describe('web/src/lib/storage.ts mirrors the server watch-pattern caps (WARDEN-2079)', () => {
  const src = readFileSync(new URL('../web/src/lib/storage.ts', import.meta.url), 'utf8');
  const webConst = (name) => {
    const m = src.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)\\s*;`));
    assert.ok(m, `${name} numeric literal not found in web/src/lib/storage.ts`);
    return Number(m[1]);
  };

  test('WATCH_PATTERN_NAME_MAX / EXPRESSION_MAX / MAX_COUNT equal the server constants', () => {
    assert.equal(webConst('WATCH_PATTERN_NAME_MAX'), WATCH_PATTERN_NAME_MAX);
    assert.equal(webConst('WATCH_PATTERN_EXPRESSION_MAX'), WATCH_PATTERN_EXPRESSION_MAX);
    assert.equal(webConst('WATCH_PATTERN_MAX_COUNT'), WATCH_PATTERN_MAX_COUNT);
  });
});
