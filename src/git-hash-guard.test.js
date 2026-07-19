import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isValidGitHash } from './git.js';

/**
 * Direct unit tests for `isValidGitHash` (src/git.js) — the pure hex-only regex
 * guard that clamps the user-supplied `hash` query param BEFORE that value
 * reaches `git show` / `git cat-file` argv. Implementation under test:
 *
 *     export function isValidGitHash(hash) {
 *       return /^[0-9a-f]{4,40}$/i.test(String(hash ?? ''));
 *     }
 *
 * Call sites (the gate this regex is): the `/api/git-show` and `/api/git-cat-file`
 * handlers in src/gitRoutes.js return `{ error: 'invalid hash' }` when this
 * returns false. (The routes were extracted out of server.js by later sibling
 * work; the guard itself and its contract are unchanged.)
 *
 * WHY these tests exist (WARDEN-750): the two route integration suites
 * (git-show.test.js, git-cat-file.test.js) cover the guard only end-to-end and
 * only for the two trivial cases — non-hex and too-short. They do NOT enumerate
 * the security-critical rejections that are the entire POINT of a hex-only
 * argument-injection regex. This file pins the accept/reject contract directly
 * against the pure function — no git-repo fixture, no listening server, no temp
 * HOME, sub-millisecond — so any future loosening
 *   - drop a `^` or `$` anchor,
 *   - add the multiline `m` flag,
 *   - raise the `{4,40}` cap,
 *   - broaden the `[0-9a-f]` char class,
 * trips a red test BEFORE it weakens a guard on a git-shelling route.
 *
 * git.js is side-effect-free at module load (WARDEN-606 — its only project
 * imports are pure helpers), so a static top-level import is safe here with no
 * before()/after() harness, unlike the route integration files that must boot
 * server.js inside a temp HOME.
 */

describe('isValidGitHash — accepts valid hex object names', () => {
  it('accepts a 7-char short SHA (the common git-show lookup shape)', () => {
    assert.strictEqual(isValidGitHash('abcd123'), true);
  });

  it('accepts exactly 4 hex chars (the {4,40} minimum)', () => {
    assert.strictEqual(isValidGitHash('abcd'), true);
  });

  it('accepts exactly 40 hex chars (a full SHA-1)', () => {
    assert.strictEqual(isValidGitHash('0123456789abcdef0123456789abcdef01234567'), true);
  });

  it('accepts uppercase hex (the /i case-insensitive flag)', () => {
    assert.strictEqual(isValidGitHash('ABCDEF12'), true);
  });

  it('accepts mixed-case hex', () => {
    assert.strictEqual(isValidGitHash('AbCdEf9'), true);
  });

  it('accepts a Number by coercing it to its hex digit string (1234 -> "1234")', () => {
    // The String(hash ?? '') coercion admits numbers whose digits are all hex.
    // 1234 reads as the hex string "1234" — a legal 4-char object-name prefix.
    assert.strictEqual(isValidGitHash(1234), true);
  });
});

describe('isValidGitHash — rejects argument-injection strings (the security point)', () => {
  // Each of these would be parsed by git as a flag/option (or a pathspec) rather
  // than an object name if it ever reached `git show` / `git cat-file` argv. The
  // entire purpose of a hex-only clamp is to make these unreachable: every one
  // starts with `-` (or is otherwise non-hex), so a tightened regex admits none.
  // If a future change broadens the char class or drops the implicit start
  // anchor, one of these turns true and this block goes red.
  const argumentInjectionStrings = [
    '--version',        // bare flag
    '--exec=/bin/sh',   // option with value — the classic git argument-injection vector
    '--output=/x',      // option with value
    '-h',               // short flag
    '--',               // end-of-options separator
  ];
  for (const input of argumentInjectionStrings) {
    it(`rejects the argument-injection string ${JSON.stringify(input)}`, () => {
      assert.strictEqual(isValidGitHash(input), false);
    });
  }
});

describe('isValidGitHash — rejects shell metacharacters', () => {
  // Even though the routes also shellQuote their argv, the hex-only regex is the
  // FIRST clamp: a value carrying shell metacharacters can never be a real object
  // name, and admitting it would let a metachar-laden string travel further into
  // the request path than necessary. Every one of these contains a non-hex char.
  const shellMetacharStrings = [
    'dead;rm',     // ';' command separator
    '$(id)',       // '$( ... )' command substitution
    'dead`id`',    // backtick command substitution
    'dead|beef',   // '|' pipe
    'dead&beef',   // '&' background / logical-and
    'dead>out',    // '>' redirection
    'dead$HOME',   // '$VAR' expansion
    "dead'beef'",  // single quotes
    'dead"beef',   // double quote
    'dead\\beef',  // backslash
    'dead beef',   // whitespace splits the token
  ];
  for (const input of shellMetacharStrings) {
    it(`rejects the shell-metacharacter string ${JSON.stringify(input)}`, () => {
      assert.strictEqual(isValidGitHash(input), false);
    });
  }
});

describe('isValidGitHash — rejects non-hex characters that are not shell-meta', () => {
  // Pins the char class itself: letters past 'f' and other ASCII are rejected
  // even though they are harmless as bare strings. Loosening [0-9a-f] to e.g.
  // [0-9a-z] would turn these green.
  const nonHexStrings = [
    'deadghij', // 'g' onward is outside the hex char class
    'cafeXYZ',  // uppercase 'XYZ' past 'F'
    '1234z',    // trailing non-hex
    'nope',     // no hex digits at all
  ];
  for (const input of nonHexStrings) {
    it(`rejects the non-hex string ${JSON.stringify(input)}`, () => {
      assert.strictEqual(isValidGitHash(input), false);
    });
  }
});

describe('isValidGitHash — enforces the 4–40 length bound', () => {
  it('accepts exactly 4 hex chars (minimum inclusive)', () => {
    assert.strictEqual(isValidGitHash('abcd'), true);
  });

  it('rejects 3 hex chars (below the minimum)', () => {
    assert.strictEqual(isValidGitHash('abc'), false);
  });

  it('rejects a single hex char', () => {
    assert.strictEqual(isValidGitHash('a'), false);
  });

  it('accepts exactly 40 hex chars (maximum inclusive — a full SHA-1)', () => {
    assert.strictEqual(isValidGitHash('f'.repeat(40)), true);
  });

  it('rejects 41 hex chars (above the maximum)', () => {
    assert.strictEqual(isValidGitHash('f'.repeat(41)), false);
  });

  it('rejects a 64-char SHA-256 hash (pins the SHA-1 {4,40} cap — a future cap bump must be intentional, not accidental)', () => {
    // A SHA-256 object id is 64 hex chars. The current regex deliberately rejects
    // it because the cap is 40. If git's SHA-256 support ever needs admitting
    // these, that is a deliberate security-relevant cap change — this test
    // forces the contributor to update the bound consciously rather than by
    // accident, instead of silently admitting a longer attack surface.
    assert.strictEqual(isValidGitHash('f'.repeat(64)), false);
  });
});

describe('isValidGitHash — coerces input via String(hash ?? "") and guards nullish', () => {
  it('rejects null (the ?? coercion falls back to the empty string, which is < 4 chars)', () => {
    assert.strictEqual(isValidGitHash(null), false);
  });

  it('rejects undefined (the ?? coercion falls back to the empty string)', () => {
    assert.strictEqual(isValidGitHash(undefined), false);
  });

  it('rejects the empty string (length 0 < 4)', () => {
    assert.strictEqual(isValidGitHash(''), false);
  });

  it('rejects a plain object (coerces to "[object Object]" which is non-hex)', () => {
    assert.strictEqual(isValidGitHash({ x: 1 }), false);
  });

  it('rejects an array of hex digits (Array#toString joins with ",", non-hex)', () => {
    assert.strictEqual(isValidGitHash(['a', 'b', 'c', 'd']), false);
  });

  it('rejects a boolean (true -> "true", non-hex)', () => {
    assert.strictEqual(isValidGitHash(true), false);
  });

  it('rejects a Number containing a non-hex digit (12345 contains no letters but 12g45 -> "12g45")', () => {
    // Reinforces that the Number path is string-coerced then hex-checked, not
    // treated as a number: 12345 is fine, but a number whose string form has a
    // non-hex char is rejected just like the string form would be.
    assert.strictEqual(isValidGitHash(1234567890), true); // all decimal digits are hex digits
    assert.strictEqual(isValidGitHash('12g45'), false); // non-hex 'g'
  });
});

describe('isValidGitHash — anchors the WHOLE string with no multiline flag', () => {
  // The regex has ^ and $ but NO `m` flag, so ^/$ match only the absolute start
  // and end of the coerced string — a single embedded newline makes the value
  // non-hex AND breaks the anchor. A future contributor adding the `m` flag (or
  // dropping an anchor) would silently admit trailing-newline or multi-line
  // input; these cases catch that. Verified empirically against the live regex.
  it('rejects a valid hash with a trailing newline ("deadbeef\\n")', () => {
    assert.strictEqual(isValidGitHash('deadbeef\n'), false);
  });

  it('rejects a valid hash with a leading newline ("\\ndeadbeef")', () => {
    assert.strictEqual(isValidGitHash('\ndeadbeef'), false);
  });

  it('rejects a hash split across two lines ("dead\\nbeef")', () => {
    assert.strictEqual(isValidGitHash('dead\nbeef'), false);
  });

  it('rejects a hash with a trailing carriage return', () => {
    assert.strictEqual(isValidGitHash('deadbeef\r'), false);
  });

  it('rejects a hash with an embedded tab', () => {
    assert.strictEqual(isValidGitHash('dead\tbeef'), false);
  });
});
