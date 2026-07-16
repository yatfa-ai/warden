// Tests for the pure pane-state classifier (WARDEN-344) — the detector WARDEN-33
// built, extracted into agentState.js so the proactive attention surfaces (the
// header AttentionBadge + opt-in desktop alert) can reach it WITHOUT the Observer
// LLM invoking a tool.
//
// The behavioral contracts locked here are the ticket's measurable success criteria:
//   - an agent whose last 3 pane lines repeat → state 'stuck' (not HEALTHY), with
//     the repeating line as its signal — surfaced within one ~30s state poll, not
//     after 30 min of silence.
//   - an agent parked at a "press enter / waiting for user" prompt → 'waiting'.
//   - a repeating stack trace / "error|failed|..." → 'erroring'.
//   - coordination language ("blocked by", "depends on") → 'blocked'.
// Precedence mirrors classifyPane / ATTENTION_RANK: erroring > stuck > blocked > waiting >
// active (an error is more actionable than a loop, which beats a coordination wait).
//
// agentState.js is dependency-free (no fs/ssh/llm/node-pty), so it imports cleanly
// under `node --test` with no HOME/PATH shenanigans.
//
// Run: node --test src/agentState.test.js   (or auto-discovered by `npm test`)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPane, stripAnsi, SUMM_ERROR_RE, SUMM_WAITING_RE, SUMM_BLOCKED_RE, matchWatchPatterns, sanitizeWatchPatterns } from './agentState.js';

// A chat with active:true so the 'active' state guard can fire.
const chat = { active: true, role: 'worker', project: 'acme' };
const classify = (clean, c = chat) => classifyPane(clean, c);

describe('stripAnsi — clean text before classification (colored output still classifies)', () => {
  it('removes CSI color / cursor escapes and stray carriage returns', () => {
    const noisy = '\x1b[31mError: \x1b[0mboom\r\nfailed\r';
    assert.equal(stripAnsi(noisy), 'Error: boom\nfailed');
  });
  it('strips OSC title sequences', () => {
    assert.equal(stripAnsi('\x1b]0;title\x07hello'), 'hello');
  });
  it('a red "Error" line still matches the error regex after stripping', () => {
    assert.ok(SUMM_ERROR_RE.test(stripAnsi('\x1b[31mError\x1b[0m')));
  });
});

describe('classifyPane — stuck: last 3 lines repeat the previous 3', () => {
  // 6 lines where [3,4,5] duplicate [0,1,2]; the joined last-3 block is > 50 chars.
  const repeatLineA = 'compiling module index and linking the final binary output now';
  const repeatLineB = 'step two of the build sequence is currently executing here';
  const repeatLineC = 'final step repeats the same three line block over again';
  const stuckPane = [repeatLineA, repeatLineB, repeatLineC, repeatLineA, repeatLineB, repeatLineC].join('\n');

  it('classifies a repeating-output loop as stuck (not idle/healthy)', () => {
    assert.equal(classify(stuckPane).state, 'stuck');
  });
  it('signal is the repeating line (first line of the duplicated block)', () => {
    assert.equal(classify(stuckPane).signal, repeatLineA);
  });
  it('a short repeat (< 50 chars joined) is NOT stuck — avoids noise on tiny panes', () => {
    // Three 2-char lines repeat, but the joined last-3 block is far under 50 chars.
    const tiny = 'ab\ncd\nef\nab\ncd\nef';
    assert.notEqual(classify(tiny).state, 'stuck');
  });
  it('non-repeating output is NOT stuck even when long', () => {
    const progressing = ['line one is long enough', 'line two differs entirely', 'line three is new content', 'line four continues', 'line five moves on', 'line six is the latest'].join('\n');
    assert.notEqual(classify(progressing).state, 'stuck');
  });
});

describe('classifyPane — erroring: a stack trace / failure beats everything else', () => {
  it('classifies an error line as erroring', () => {
    assert.equal(classify('running tests\nError: assertion failed at line 42').state, 'erroring');
  });
  it('matches the full error vocabulary (failed/exception/traceback/panic/fatal)', () => {
    for (const word of ['error', 'failed', 'exception', 'traceback', 'panic', 'fatal']) {
      assert.equal(classify(`build step\n${word} occurred here`).state, 'erroring', `expected erroring for "${word}"`);
    }
  });
  it('signal is the most recent matching error line', () => {
    const pane = 'Error: first failure\nsome output\nTraceback: the real problem';
    assert.equal(classify(pane).signal, 'Traceback: the real problem');
  });
  it('erroring takes precedence over stuck (a repeating error is still an error)', () => {
    // The last 3 lines repeat (would be stuck), but they also contain "error".
    const err = 'Error: repeating failure message that is long enough to count here';
    const repeatingError = [err, err, err, err, err, err].join('\n');
    assert.equal(classify(repeatingError).state, 'erroring');
  });
});

describe('classifyPane — waiting: parked at a human-input prompt', () => {
  it('classifies "press enter" as waiting (while still emitting output → would be HEALTHY by /api/health)', () => {
    assert.equal(classify('claude is running\nPress enter to continue').state, 'waiting');
  });
  it('matches the waiting vocabulary (please/respond/input/press enter/waiting for user)', () => {
    for (const phrase of ['please respond', 'continue?', 'needs input', 'press enter', 'waiting for user']) {
      assert.equal(classify(`working\n${phrase}`).state, 'waiting', `expected waiting for "${phrase}"`);
    }
  });
  it('signal is the matching prompt line', () => {
    assert.equal(classify('doing work\nPress enter to continue').signal, 'Press enter to continue');
  });
  it('the bare fragment "waiting for" alone is NOT blocked — it stays a human-input waiting signal', () => {
    // BLOCKED_RE deliberately omits the bare "waiting for" so this reaches WAITING.
    assert.equal(classify('agent is waiting for input').state, 'waiting');
  });
});

describe('classifyPane — blocked: coordination / dependency on another agent', () => {
  it('classifies "blocked by" coordination language as blocked', () => {
    assert.equal(classify('working\nblocked by worker on ticket X').state, 'blocked');
  });
  it('matches "depends on" and "waiting for agent/worker/approval"', () => {
    assert.equal(classify('depends on the reviewer').state, 'blocked');
    assert.equal(classify('waiting for approval from planner').state, 'blocked');
  });
  it('signal is the coordination line', () => {
    assert.equal(classify('progress\nblocked on the planner decision').signal, 'blocked on the planner decision');
  });
});

describe('classifyPane — active / idle: no attention needed', () => {
  it('classifies active work (running/building) on an active chat as active', () => {
    const r = classify('running the test suite\nbuilding modules');
    assert.equal(r.state, 'active');
    assert.equal(r.signal, null, 'active has no alert signal');
  });
  it('active language on an INACTIVE chat (c.active falsy) is idle, not active', () => {
    const r = classify('running tests', { active: false, role: 'worker', project: 'acme' });
    assert.equal(r.state, 'idle');
  });
  it('unremarkable output with no keywords is idle', () => {
    const r = classify('just some ordinary output here\nnothing to see');
    assert.equal(r.state, 'idle');
    assert.equal(r.signal, null);
  });
});

describe('classifyPane — precedence: erroring > stuck > blocked > waiting > active', () => {
  it('erroring beats stuck', () => {
    const err = 'Error: repeating long enough message to also look stuck here';
    assert.equal(classify([err, err, err, err, err, err].join('\n')).state, 'erroring');
  });
  it('blocked beats waiting (a coordination wait is more specific than human input)', () => {
    // "waiting for approval from planner" matches BLOCKED_RE; ensure it isn't WAITING.
    assert.equal(classify('waiting for approval from planner and also press enter').state, 'blocked');
  });
});

// Recency-bound state decision (WARDEN-390): erroring/blocked/waiting are decided
// against the LIVE BOTTOM of the pane (the last ~15 non-empty lines), not the full
// ~60-line capture. A triggering line that has scrolled OUT of that tail, with
// active/other output below it, no longer flips the state — so a recovered agent
// stops reading "needs attention". `stuck` is already recency-safe; `active` keeps
// scanning the full window (a busy-but-quiet agent must not false-flip to alertable
// 'idle'). Precedence still holds among the tail's lines.
describe('classifyPane — recency: a recovered error/prompt/block scrolled past no longer flips the state', () => {
  // Fully neutral filler lines (no word in ANY state regex) used to push a triggering
  // line OUT of the 15-line tail, simulating the pane scrolling past it. 16 of them
  // guarantees the trigger lands outside the last-15 window.
  const fillers = n => Array.from({ length: n }, (_, i) => `filler output line number ${i}`);

  it('(a) an error line in the OLDER window + active output in the tail → active, NOT erroring', () => {
    const lines = ['Error: something failed early on', ...fillers(16), 'building the project modules', 'running the full test suite now'];
    const r = classify(lines.join('\n'));
    assert.notEqual(r.state, 'erroring', 'a scrolled-past error must not pin the state to erroring');
    assert.equal(r.state, 'active', 'recovered agent with active output reads active');
  });
  it('(b) a "press enter" prompt scrolled past + active output → active, NOT waiting', () => {
    const lines = ['Press enter to continue', ...fillers(16), 'building modules', 'running the test suite'];
    const r = classify(lines.join('\n'));
    assert.notEqual(r.state, 'waiting', 'a scrolled-past prompt must not pin the state to waiting');
    assert.equal(r.state, 'active');
  });
  it('(c) a resolved "blocked by…" scrolled past + active output → active, NOT blocked', () => {
    const lines = ['blocked by the reviewer on the dependency', ...fillers(16), 'building the project', 'running the suite'];
    const r = classify(lines.join('\n'));
    assert.notEqual(r.state, 'blocked', 'a scrolled-past coordination block must not pin the state to blocked');
    assert.equal(r.state, 'active');
  });
  it('(d) a current error at the LIVE BOTTOM still classifies as erroring (no false negative)', () => {
    const lines = [...fillers(20), 'Traceback: live error at the very bottom'];
    assert.equal(classify(lines.join('\n')).state, 'erroring');
  });
  it('(e) a current prompt at the LIVE BOTTOM still classifies as waiting (no false negative)', () => {
    const lines = [...fillers(20), 'Press enter to continue'];
    assert.equal(classify(lines.join('\n')).state, 'waiting');
  });
  it('(f) precedence is preserved WITHIN the tail: error + blocked both present → erroring', () => {
    // Both lines sit in a short pane (well inside any reasonable tail); error wins.
    assert.equal(classify('blocked by the reviewer\nError: something failed here').state, 'erroring');
  });
  it('a current coordination block at the LIVE BOTTOM still classifies as blocked (no false negative)', () => {
    const lines = [...fillers(20), 'blocked on the planner decision'];
    assert.equal(classify(lines.join('\n')).state, 'blocked');
  });
});

describe('classifyPane — goal inference still works (unchanged from observer.js)', () => {
  it('prefers an explicit ticket reference', () => {
    assert.equal(classify('working on WARDEN-344\nrunning').goal, 'WARDEN-344');
  });
  it('falls back to role on project when no ticket/action phrase is present', () => {
    assert.equal(classify('just output', { active: true, role: 'reviewer', project: 'acme' }).goal, 'reviewer on acme');
  });
});

// ─── matchWatchPatterns (WARDEN-540) ─────────────────────────────────────────
//
// The user-authored output-pattern matcher — sibling of classifyPane. Pure +
// dependency-free, so it imports cleanly under `node --test`. The contracts locked
// here are the ticket's matcher success criteria: string = case-insensitive
// substring (mirrors /api/search-pane), regex = a case-insensitive RegExp, an
// INVALID regex never throws (skipped), disabled patterns are skipped, the FIRST
// enabled match wins, and the LAST (most recent) matching line is returned.
describe('matchWatchPatterns — string mode: case-insensitive substring', () => {
  const stringPat = (name, expression, enabled = true) => ({ id: name, name, expression, mode: 'string', enabled });

  it('matches a substring anywhere in any line, case-insensitively', () => {
    const m = matchWatchPatterns('building step 2\nDEPLOY FAILED: exit code 1', [stringPat('Deploy', 'deploy failed')]);
    assert.equal(m.pattern, 'Deploy');
    assert.equal(m.line, 'DEPLOY FAILED: exit code 1');
  });
  it('matches /api/search-pane semantics: substring, not whole-line equality', () => {
    // The expression is a fragment, not the full line — must still match.
    const m = matchWatchPatterns('remote: error: merge conflict in src/index.ts', [stringPat('Conflict', 'merge conflict')]);
    assert.equal(m.pattern, 'Conflict');
    assert.equal(m.line, 'remote: error: merge conflict in src/index.ts');
  });
  it('returns null when no line contains the substring', () => {
    assert.equal(matchWatchPatterns('all good here\nstill building', [stringPat('X', 'deploy failed')]), null);
  });
});

describe('matchWatchPatterns — regex mode: case-insensitive RegExp', () => {
  const rePat = (name, expression, enabled = true) => ({ id: name, name, expression, mode: 'regex', enabled });

  it('matches a regex and returns the matching line', () => {
    const m = matchWatchPatterns('processing\nPayment Required (HTTP 402)', [rePat('Paywall', 'payment (required|due)')]);
    assert.equal(m.pattern, 'Paywall');
    assert.equal(m.line, 'Payment Required (HTTP 402)');
  });
  it('a regex with anchors respects them', () => {
    // Anchored to start-of-line: matches the line that BEGINS with FAIL.
    const m = matchWatchPatterns('step: FAIL\nFAIL: the deploy (anchored match)', [rePat('Fail', '^FAIL:')]);
    assert.equal(m.line, 'FAIL: the deploy (anchored match)');
  });
  it('an INVALID regex never throws — it is skipped, returning null when it is the only pattern', () => {
    // The load-bearing "never throw" contract: a user-authored bad regex must not
    // crash /api/agent-states. `(unclosed` is an unterminated group.
    assert.doesNotThrow(() => matchWatchPatterns('anything', [rePat('Bad', '(unclosed')]));
    assert.equal(matchWatchPatterns('anything', [rePat('Bad', '(unclosed')]), null);
  });
  it('an invalid regex is skipped but a LATER valid pattern still matches', () => {
    const m = matchWatchPatterns('deploy failed', [rePat('Bad', '(unclosed'), rePat('Good', 'deploy failed')]);
    assert.equal(m.pattern, 'Good');
  });
});

describe('matchWatchPatterns — selection + edge contracts', () => {
  const pat = (id, name, expression, mode = 'string', enabled = true) => ({ id, name, expression, mode, enabled });

  it('the FIRST enabled matching pattern wins (array order is the precedence)', () => {
    const text = 'both should match this line';
    const m = matchWatchPatterns(text, [pat('a', 'First', 'match'), pat('b', 'Second', 'should')]);
    assert.equal(m.pattern, 'First');
  });
  it('returns the LAST (most recent) matching line for the winning pattern', () => {
    // Two lines match; the pane's live bottom is the actionable one (mirrors
    // classifyPane's recency-bound signal). The matcher walks from the end.
    const m = matchWatchPatterns('deploy failed earlier\ncleanup ok\ndeploy failed just now', [pat('a', 'Deploy', 'deploy failed')]);
    assert.equal(m.line, 'deploy failed just now');
  });
  it('a disabled pattern is skipped (enabled === false)', () => {
    const m = matchWatchPatterns('deploy failed', [pat('a', 'Off', 'deploy failed', 'string', false), pat('b', 'On', 'nomatch')]);
    assert.equal(m, null, 'disabled pattern did not match, and the enabled one found nothing');
  });
  it('an enabled: false pattern does NOT block a later enabled pattern from matching', () => {
    const m = matchWatchPatterns('merge conflict', [pat('a', 'Off', 'deploy failed', 'string', false), pat('b', 'On', 'merge conflict')]);
    assert.equal(m.pattern, 'On');
  });
  it('returns null for an empty pattern list (no patterns = no alerts = identical to today)', () => {
    assert.equal(matchWatchPatterns('deploy failed', []), null);
  });
  it('returns null for null/undefined patterns', () => {
    assert.equal(matchWatchPatterns('deploy failed', null), null);
    assert.equal(matchWatchPatterns('deploy failed', undefined), null);
  });
  it('returns null when cleanText is not a string', () => {
    assert.equal(matchWatchPatterns(null, [pat('a', 'A', 'x')]), null);
    assert.equal(matchWatchPatterns(undefined, [pat('a', 'A', 'x')]), null);
  });
  it('skips patterns missing a name or expression (defensive — never trusts input)', () => {
    const m = matchWatchPatterns('deploy failed', [
      { id: 'a', name: '', expression: 'deploy failed', mode: 'string', enabled: true },
      { id: 'b', name: 'BlankExpr', expression: '   ', mode: 'string', enabled: true },
      pat('c', 'Good', 'deploy failed'),
    ]);
    assert.equal(m.pattern, 'Good');
  });
  it('trims + slices the matching line to 200 chars (mirrors classifyPane signal bound)', () => {
    // The matching token at the START survives the leading slice; the trailing
    // padding is what gets clipped, proving the 200-char bound holds.
    const longLine = 'deploy failed ' + 'x'.repeat(300);
    const m = matchWatchPatterns(longLine, [pat('a', 'Deploy', 'deploy failed')]);
    assert.ok(m.line.length <= 200, `line was not sliced (${m.line.length} chars)`);
    assert.equal(m.line.slice(0, 'deploy failed'.length), 'deploy failed');
  });
});

describe('sanitizeWatchPatterns — PUT /api/config type-guard (WARDEN-540)', () => {
  it('returns null for a non-array so the PUT handler treats the field as absent', () => {
    // null/undefined/string/object → null (no mutation), mirroring the per-key guards.
    assert.equal(sanitizeWatchPatterns(null), null);
    assert.equal(sanitizeWatchPatterns(undefined), null);
    assert.equal(sanitizeWatchPatterns('nope'), null);
    assert.equal(sanitizeWatchPatterns({ id: 'x' }), null);
  });
  it('drops entries missing id/name/expression, keeping the valid ones', () => {
    const out = sanitizeWatchPatterns([
      { id: '1', name: 'A', expression: 'a', mode: 'string' },
      { id: '', name: 'noid', expression: 'x' },       // missing id → drop
      { id: '2', name: '', expression: 'x' },          // missing name → drop
      { id: '3', name: 'noexpr', expression: '' },     // missing expression → drop
      'not-an-object',                                  // not an object → drop
      null,
    ]);
    assert.deepEqual(out, [{ id: '1', name: 'A', expression: 'a', mode: 'string', enabled: true }]);
  });
  it('coerces mode to "string" for anything but the literal "regex"', () => {
    const out = sanitizeWatchPatterns([
      { id: '1', name: 'A', expression: 'a', mode: 'STRING' },
      { id: '2', name: 'B', expression: 'b', mode: 'regex' },
      { id: '3', name: 'C', expression: 'c' }, // missing mode → string
    ]);
    assert.equal(out[0].mode, 'string');
    assert.equal(out[1].mode, 'regex');
    assert.equal(out[2].mode, 'string');
  });
  it('enabled defaults to true and is preserved (enabled !== false)', () => {
    const out = sanitizeWatchPatterns([
      { id: '1', name: 'A', expression: 'a' },            // absent → true
      { id: '2', name: 'B', expression: 'b', enabled: false },
      { id: '3', name: 'C', expression: 'c', enabled: true },
    ]);
    assert.equal(out[0].enabled, true);
    assert.equal(out[1].enabled, false);
    assert.equal(out[2].enabled, true);
  });
  it('dedups by id (first occurrence wins)', () => {
    const out = sanitizeWatchPatterns([
      { id: 'dup', name: 'First', expression: 'a' },
      { id: 'dup', name: 'Second', expression: 'b' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'First');
  });
  it('caps the count at the max (overflow dropped)', () => {
    const big = Array.from({ length: 60 }, (_, i) => ({ id: String(i), name: `n${i}`, expression: 'x' }));
    const out = sanitizeWatchPatterns(big);
    assert.equal(out.length, 50);
  });
  it('an empty array is a valid value (clears all patterns) — not null', () => {
    // null means "field absent"; [] means "the human cleared the list". The
    // distinction is what lets a PUT with [] wipe patterns while a PUT omitting the
    // field leaves them intact.
    assert.deepEqual(sanitizeWatchPatterns([]), []);
  });
});
