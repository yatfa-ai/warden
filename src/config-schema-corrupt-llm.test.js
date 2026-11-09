import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Pins applyLlmPut's stored-llm self-heal (src/config-schema.js). config.load()
 * spreads a hand-edited config.json over DEFAULTS verbatim, so a stored `llm`
 * of null / string / number / array can reach PUT /api/config. The PUT must
 * replace it with a fresh object (not throw, not write onto it), while a valid
 * stored object is updated in place and a non-object body.llm is a no-op.
 */

import { applyConfigPut, buildGetResponse } from './config-schema.js';

const BODY = { model: 'm-1', maxTokens: 512, authToken: 'sk-ABCD' };

describe('applyLlmPut — corrupt stored llm self-heal', () => {
  for (const [label, corrupt] of [
    ['null', null],
    ['a string', 'junk'],
    ['a number', 7],
    ['an array', ['x']],
  ]) {
    it(`replaces a stored llm of ${label} with a fresh object carrying the PUT fields`, () => {
      const cfg = { llm: corrupt };
      const { refused } = applyConfigPut(cfg, { llm: { ...BODY } });
      assert.deepStrictEqual(refused, {});
      assert.ok(cfg.llm && typeof cfg.llm === 'object' && !Array.isArray(cfg.llm));
      assert.deepStrictEqual({ ...cfg.llm }, BODY);
      // Persisted shape: an array that merely gained properties would
      // serialise to ["x"] and silently lose the user's LLM settings.
      assert.deepStrictEqual(JSON.parse(JSON.stringify(cfg)).llm, BODY);
    });
  }

  it('creates llm when the stored key is absent', () => {
    const cfg = {};
    applyConfigPut(cfg, { llm: { ...BODY } });
    assert.deepStrictEqual({ ...cfg.llm }, BODY);
  });

  it('updates a VALID stored llm object in place (same identity, siblings survive)', () => {
    const stored = { model: 'old', baseUrl: 'http://x', authToken: 'sk-KEEP' };
    const cfg = { llm: stored };
    applyConfigPut(cfg, { llm: { maxTokens: 256 } });
    assert.strictEqual(cfg.llm, stored);
    assert.strictEqual(cfg.llm.model, 'old');
    assert.strictEqual(cfg.llm.baseUrl, 'http://x');
    assert.strictEqual(cfg.llm.authToken, 'sk-KEEP');
    assert.strictEqual(cfg.llm.maxTokens, 256);
  });

  for (const [label, bad] of [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'x'],
    ['an array', ['y']],
    ['a number', 3],
  ]) {
    it(`a non-object body.llm (${label}) is a no-op and leaves a corrupt stored llm untouched`, () => {
      const cfg = { llm: 'junk' };
      applyConfigPut(cfg, { llm: bad });
      assert.strictEqual(cfg.llm, 'junk');
    });
  }

  it('after the heal, buildGetResponse reports the stored LLM settings', () => {
    const cfg = { llm: null };
    applyConfigPut(cfg, { llm: { ...BODY } });
    const llm = buildGetResponse(cfg, {}).llm;
    assert.strictEqual(llm.authTokenSet, true);
    assert.strictEqual(llm.authTokenTail, 'ABCD');
    assert.strictEqual(llm.model, 'm-1');
    assert.strictEqual(llm.maxTokens, 512);
  });
});
