import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseJsonlTokenUsage, computeSessionTotals } from './claudeSessions.js';

/**
 * Tests for the per-session LLM token-usage surface (WARDEN-367).
 *
 * `parseJsonlTokenUsage` sums every assistant turn's `message.usage` token
 * fields across a session's FULL JSONL body. It mirrors `parseJsonlHead`'s
 * lenient contract (never throws; skips malformed/empty/non-message lines) and
 * returns `null` when the session has no real usage — so a row renders without a
 * token badge instead of a misleading "0 tok". This null-when-zero contract is
 * what keeps the LOCAL full-file path byte-for-byte consistent with the REMOTE
 * grep+awk extractor (which sums to empty → null for the same all-zero case).
 *
 * `computeSessionTotals` rolls a list of sessions' tokenUsage into a grand total
 * + per-host breakdown (skipping no-usage rows). Pure so it's testable without SSH.
 *
 * Coverage maps to the ticket's success criteria:
 *   - empty body / no usage / all-zero → null (graceful-empty, no badge)
 *   - correct sums across multiple assistant turns (incl. cache-heavy real shape)
 *   - malformed JSON + non-assistant records skipped
 *   - grand + per-host subtotals roll up correctly
 */

function jsonl(...objs) { return objs.map((o) => JSON.stringify(o)).join('\n'); }

describe('parseJsonlTokenUsage', () => {
  it('returns null for an empty body', () => {
    assert.strictEqual(parseJsonlTokenUsage(''), null);
    assert.strictEqual(parseJsonlTokenUsage('\n  \n'), null);
  });

  it('returns null when no line carries usage (user lines + summary records skipped)', () => {
    const body = jsonl(
      { cwd: '/repo', type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'summary', summary: 'a summary record has no message.usage' },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'follow up' }] } },
    );
    assert.strictEqual(parseJsonlTokenUsage(body), null);
  });

  it('returns null when usage objects exist but every value is zero (no real usage)', () => {
    // A session whose assistant turns all reported 0 tokens is effectively no
    // usage — null so the row renders no badge. This is the case the REMOTE
    // awk guard (if(inp||out||cc||cr)) also collapses to empty → null, keeping
    // the two paths consistent.
    const body = jsonl(
      { type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 } } },
    );
    assert.strictEqual(parseJsonlTokenUsage(body), null);
  });

  it('sums the four token fields across multiple assistant turns', () => {
    const body = jsonl(
      { type: 'user', message: { role: 'user', content: 'go' } },
      { type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } },
      { type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    );
    assert.deepStrictEqual(parseJsonlTokenUsage(body), {
      input: 110, output: 5, cacheCreation: 2, cacheRead: 3, total: 120,
    });
  });

  it('sums the cache-heavy real-world shape (cache_read dominates)', () => {
    // Real Claude Code transcripts are cache-read dominated (millions of cached
    // tokens). Verify the four-field sum is correct on that shape — the number
    // that drives the per-row badge + the fleet total.
    const body = jsonl(
      { type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 195529, output_tokens: 63632, cache_creation_input_tokens: 0, cache_read_input_tokens: 5320192 } } },
    );
    assert.deepStrictEqual(parseJsonlTokenUsage(body), {
      input: 195529, output: 63632, cacheCreation: 0, cacheRead: 5320192, total: 5579353,
    });
  });

  it('skips malformed JSON lines and lines with empty/absent usage without throwing', () => {
    // Interleave garbage + a usage-bearing turn + a non-usage assistant turn;
    // only the real usage turn contributes.
    const body = [
      'this is not json at all',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 7, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }), // no usage object
      '{ "broken": ',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 4, cache_read_input_tokens: 5 } } }),
    ].join('\n');
    assert.deepStrictEqual(parseJsonlTokenUsage(body), {
      input: 10, output: 3, cacheCreation: 4, cacheRead: 5, total: 22,
    });
  });

  it('tolerates string-valued token fields without throwing (defensive coercion)', () => {
    // Real fields are JSON numbers, but the contract is "never throw" — a stray
    // string number is coerced, garbage is treated as 0.
    const body = jsonl(
      { type: 'assistant', message: { role: 'assistant', usage: { input_tokens: '42', output_tokens: '3', cache_creation_input_tokens: 'not-a-number', cache_read_input_tokens: null } } },
    );
    assert.deepStrictEqual(parseJsonlTokenUsage(body), {
      input: 42, output: 3, cacheCreation: 0, cacheRead: 0, total: 45,
    });
  });
});

describe('computeSessionTotals', () => {
  it('returns a zero grand total and empty byHost for no-usage / empty input', () => {
    assert.deepStrictEqual(computeSessionTotals([]), { grand: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 }, byHost: {} });
    // Sessions whose tokenUsage is null contribute nothing.
    const r = computeSessionTotals([{ host: 'a', tokenUsage: null }, { host: 'a', tokenUsage: undefined }]);
    assert.strictEqual(r.grand.total, 0);
    assert.deepStrictEqual(r.byHost, {});
  });

  it('rolls per-host subtotals up to the grand total', () => {
    const sessions = [
      { host: 'a', tokenUsage: { input: 10, output: 1, cacheCreation: 0, cacheRead: 2, total: 13 } },
      { host: 'a', tokenUsage: { input: 5, output: 0, cacheCreation: 0, cacheRead: 0, total: 5 } },
      { host: 'b', tokenUsage: { input: 100, output: 4, cacheCreation: 1, cacheRead: 8, total: 113 } },
      { host: 'b', tokenUsage: null }, // skipped
    ];
    const r = computeSessionTotals(sessions);
    // Grand = 13 + 5 + 113 = 131; per-host a = 18, b = 113.
    assert.strictEqual(r.grand.total, 131);
    assert.strictEqual(r.byHost.a.total, 18);
    assert.strictEqual(r.byHost.b.total, 113);
    // The per-host subtotals are themselves a full breakdown that sums to grand.
    const hostSum = (r.byHost.a.total + r.byHost.b.total);
    assert.strictEqual(hostSum, r.grand.total, 'per-host subtotals must sum to the grand total');
    // And the field-level grand matches the sum of per-host fields.
    assert.strictEqual(r.grand.input, 115); // 10+5+100
    assert.strictEqual(r.byHost.a.input, 15); // 10+5
    assert.strictEqual(r.byHost.b.input, 100);
  });

  it('buckets an unknown/missing host under "unknown" rather than crashing', () => {
    const r = computeSessionTotals([{ tokenUsage: { input: 1, output: 0, cacheCreation: 0, cacheRead: 0, total: 1 } }]);
    assert.ok(r.byHost.unknown, 'a session with no host field buckets under "unknown"');
    assert.strictEqual(r.byHost.unknown.total, 1);
  });
});
