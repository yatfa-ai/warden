// Pins validateRegistry's two unasserted startup guards (config-schema.js):
//  1. a non-derived descriptor must declare a `default`;
//  2. the nested llm sub-field `clamp` is validated (range shape AND clampable type).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistry, CONFIG_FIELDS } from './config-schema.js';

const ok = (extra) => ({ key: 'x', default: false, exposure: 'public', type: 'boolean', resolve: 'identity', order: 1, ...extra });
const llm = (fields) => ok({ key: 'llm', type: 'llm', default: {}, fields });

describe('validateRegistry — missing default', () => {
  it('rejects a public descriptor without a default and names the key', () => {
    const { default: _d, ...noDefault } = ok({ key: 'nodef' });
    assert.throws(() => validateRegistry([noDefault]), /CONFIG_FIELDS\[0\] \(key='nodef'\): missing 'default'/);
  });
  it('rejects an internal descriptor without a default', () => {
    const { default: _d, ...noDefault } = ok({ exposure: 'internal', order: undefined });
    assert.throws(() => validateRegistry([noDefault]), /missing 'default'/);
  });
  it('accepts a derived descriptor without a default (never persisted)', () => {
    const { default: _d, ...derived } = ok({ exposure: 'derived', order: 2 });
    assert.doesNotThrow(() => validateRegistry([derived]));
  });
  it('accepts a falsy-but-present default (null / 0 / "")', () => {
    for (const v of [null, 0, '', false]) assert.doesNotThrow(() => validateRegistry([ok({ default: v })]));
  });
});

describe('validateRegistry — nested llm sub-field clamp', () => {
  it('rejects a swapped-bounds sub-field clamp, naming the field', () => {
    const f = { key: 'maxTokens', type: 'nullablePositiveNumber', clamp: [10, 1] };
    assert.throws(() => validateRegistry([llm([f])]), /field 'maxTokens' clamp: min 10 > max 1/);
  });
  it('rejects a malformed sub-field clamp shape', () => {
    const f = { key: 'maxTokens', type: 'nullablePositiveNumber', clamp: [1] };
    assert.throws(() => validateRegistry([llm([f])]), /field 'maxTokens' clamp must be \[min, max\]/);
  });
  it('rejects a clamp on a sub-field type that does not honor it', () => {
    const f = { key: 'model', type: 'string', clamp: [1, 5] };
    assert.throws(() => validateRegistry([llm([f])]), /field 'model': 'clamp' is not valid on type 'string'/);
  });
  it('accepts a clamp on a clampable sub-field and an unclamped sibling', () => {
    assert.doesNotThrow(() => validateRegistry([llm([
      { key: 'model', type: 'string' },
      { key: 'maxTokens', type: 'nullablePositiveNumber', clamp: [1, null] },
    ])]));
  });
  it('accepts an llm descriptor with no fields array', () => {
    assert.doesNotThrow(() => validateRegistry([llm(undefined)]));
  });
  it('shipping registry llm.maxTokens clamp stays valid', () => {
    const d = CONFIG_FIELDS.find((x) => x.type === 'llm');
    assert.ok(d.fields.some((f) => f.clamp));
    assert.doesNotThrow(() => validateRegistry(CONFIG_FIELDS));
  });
});
