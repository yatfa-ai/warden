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
import { classifyPane, stripAnsi, SUMM_ERROR_RE, SUMM_WAITING_RE, SUMM_BLOCKED_RE, matchWatchPatterns, sanitizeWatchPatterns, inferGoal } from './agentState.js';

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

// ─── inferGoal (direct unit tests) ────────────────────────────────────────────
//
// inferGoal(clean, c) (src/agentState.js:132) is the PURE goal-inference function
// behind every agent's displayed `goal` field — its one caller is classifyPane at
// src/agentState.js:99 (`goal: inferGoal(clean, c)`). It is a 5-branch priority
// cascade — ticket → action phrase → role+project → role → null — with non-obvious
// regex + string-slicing edges (the "complex business logic" the tests variant
// targets, categorically NOT a getter/delegation).
//
// The classifyPane block above only asserts 2 shallow outcomes THROUGH classifyPane
// (a ticket beats an action verb; the role+project fallback). Because the ticket
// always WON there, branch 2's phrase EXTRACTION was never actually exercised, and
// branches 4/5 plus every regex/slicing edge were left unpinned. These tests pin
// each branch and edge directly against the public inferGoal surface, independent
// of classifyPane. (Tested through inferGoal rather than the un-exported
// SUMM_TICKET_RE so the assertions reflect the real displayed `goal` contract.)
describe('inferGoal — branch 1: an explicit ticket reference wins', () => {
  it('returns the UPPER CASE PROJECT-N ticket (the canonical form, e.g. WARDEN-344)', () => {
    assert.equal(inferGoal('working on WARDEN-344\nrunning'), 'WARDEN-344');
  });
  it('extracts a ticket embedded in surrounding pane text (\\b boundaries)', () => {
    assert.equal(inferGoal('pre WARDEN-3 post'), 'WARDEN-3');
  });
  it('returns the FIRST (leftmost) ticket when several appear', () => {
    // clean.match() is leftmost, so the first ticket reference wins — not the last.
    assert.equal(inferGoal('ticket WARDEN-1 and WARDEN-2'), 'WARDEN-1');
  });
  it('accepts a 2+ char upper-case/digit prefix (AB-1, TINK-13, X1-99)', () => {
    // [A-Z][A-Z0-9]{1,} = first upper-case letter + ≥1 more upper/digit (2+ total).
    assert.equal(inferGoal('see AB-1 here'), 'AB-1');
    assert.equal(inferGoal('see TINK-13 here'), 'TINK-13');
    assert.equal(inferGoal('see X1-99 here'), 'X1-99');
  });
  it('returns only the ticket capture group, not the whole match', () => {
    // SUMM_TICKET_RE wraps the id in a capture group; branch 1 returns ticket[1].
    assert.equal(inferGoal('see WARDEN-344 now'), 'WARDEN-344');
  });
});

describe('inferGoal — ticket-regex boundaries: what does NOT register as a ticket', () => {
  it('a single-letter prefix (A-1) does NOT match — the prefix needs 2+ chars', () => {
    // 'A' alone is only the first [A-Z]; {1,} needs one more upper/digit. Falls
    // through to the role+project fallback rather than reading 'A-1' as a ticket.
    assert.equal(inferGoal('A-1 fix here', { role: 'worker', project: 'p' }), 'worker on p');
  });
  it('a digit-led id (12-3) does NOT match — the prefix must start with [A-Z]', () => {
    assert.equal(inferGoal('12-3 fix', { role: 'worker', project: 'p' }), 'worker on p');
  });
  it('a lower-case project id does NOT match — the prefix is upper-case only', () => {
    assert.equal(inferGoal('warden-344'), null, 'no ticket, no verb, no chat → null');
  });
  it('a space-prefixed "#42" does NOT preempt the action phrase (\\b needs a word char before #)', () => {
    // The #\d{2,} alternative is anchored by a leading \b; space→'#' is non-word→
    // non-word, so no boundary. In normal prose ('issue #42') the #NN form does not
    // register as a ticket and branch 2's action phrase wins instead. Pinning the
    // current boundary so a future regex change is caught intentionally.
    assert.equal(inferGoal('reviewing issue #42 details'), 'reviewing issue #42 details');
  });
});

describe('inferGoal — branch 2: an action-verb phrase is extracted', () => {
  it('extracts the trailing phrase after each of the 7 action verbs', () => {
    // The full verb set: working on | implementing | fixing | building |
    // refactoring | reviewing | investigating.
    const cases = [
      ['working on the feature', 'working on the feature'],
      ['implementing the new module', 'implementing the new module'],
      ['fixing the bug', 'fixing the bug'],
      ['building the UI', 'building the UI'],
      ['refactoring the parser', 'refactoring the parser'],
      ['reviewing the PR', 'reviewing the PR'],
      ['investigating the flaky test', 'investigating the flaky test'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(inferGoal(input), expected, `verb phrase not extracted for "${input}"`);
    }
  });
  it('extracts the FULL trailing phrase, not just the verb keyword', () => {
    // The gap the classifyPane block left open: there a ticket always won, so this
    // branch's EXTRACTION was never exercised. No ticket here → branch 2 fires.
    assert.equal(inferGoal('investigating a flaky CI timeout in the runner'),
      'investigating a flaky CI timeout in the runner');
  });
  it('matches case-insensitively but preserves the original casing', () => {
    assert.equal(inferGoal('IMPLEMENTING the thing'), 'IMPLEMENTING the thing');
    assert.equal(inferGoal('Working On the feature'), 'Working On the feature');
  });
  it('returns just the verb when nothing trails it on the line', () => {
    assert.equal(inferGoal('fixing'), 'fixing');
  });
  it('trims leading and trailing whitespace from the captured phrase', () => {
    // Leading spaces before the verb are outside the match (the regex anchors at the
    // verb via \b); trailing whitespace captured by [^\n]{0,80} is removed by .trim().
    assert.equal(inferGoal('   fixing    the    bug'), 'fixing    the    bug');
    assert.equal(inferGoal('fixing the bug   '), 'fixing the bug');
  });
});

describe('inferGoal — branch 2 verb set: look-alikes NOT in the set fall through', () => {
  // The 7-verb set is exact. Active-looking words that aren't members must NOT
  // extract a phrase — otherwise "running tests" would masquerade as a goal. Each
  // falls through to the role+project fallback, proving branch 2 was skipped.
  const chat = { role: 'worker', project: 'acme' };
  it('"running" / "coding" / "testing" are NOT in the set', () => {
    assert.equal(inferGoal('running the test suite', chat), 'worker on acme');
    assert.equal(inferGoal('coding the new module', chat), 'worker on acme');
    assert.equal(inferGoal('testing the changes here', chat), 'worker on acme');
  });
  it('"working" without "on" does NOT match (the verb is the literal "working on")', () => {
    assert.equal(inferGoal('working the task alone', chat), 'worker on acme');
  });
});

describe('inferGoal — branch 2 caps: trailing [^\\n]{0,80} (binder) + slice(0,120) (net)', () => {
  it('clips the trailing phrase to 80 chars (the [^\\n]{0,80} bound is what binds)', () => {
    // After "investigating" the regex greedily grabs up to 80 non-newline chars:
    // the leading space + 79 of the 200 z's. (slice(0,120) is a secondary net that
    // never binds here — longest verb 13 + 80 = 93 < 120.)
    const result = inferGoal('investigating ' + 'z'.repeat(200));
    assert.equal(result, 'investigating ' + 'z'.repeat(79));
    assert.ok(result.length <= 120, `goal exceeded 120 chars (${result.length})`);
  });
  it('never returns an action-phrase goal longer than 120 chars (the slice(0,120) ceiling)', () => {
    // Invariant across every verb: verb (≤13) + 80-char trailing ≤ 93 < 120, so the
    // slice is a true ceiling on the action-phrase branch even though the 80-char
    // trailing bound is what usually binds.
    for (const verb of ['working on', 'implementing', 'fixing', 'building', 'refactoring', 'reviewing', 'investigating']) {
      const result = inferGoal(`${verb} ${'x'.repeat(300)}`);
      assert.ok(result.length <= 120, `"${verb}" goal exceeded 120 chars (${result.length})`);
      assert.equal(result.slice(0, verb.length), verb, `verb prefix lost for "${verb}"`);
    }
  });
  it('stops the phrase at a newline — [^\\n] does not cross lines', () => {
    assert.equal(inferGoal('investigating aa\nbb'), 'investigating aa');
  });
});

describe('inferGoal — branch 3: role + project fallback ("<role> on <project>")', () => {
  it('composes "<role> on <project>" when no ticket or action phrase is present', () => {
    assert.equal(inferGoal('plain output', { role: 'reviewer', project: 'acme' }), 'reviewer on acme');
  });
  it('composes for each role', () => {
    for (const role of ['planner', 'worker', 'reviewer', 'researcher']) {
      assert.equal(inferGoal('plain output', { role, project: 'p' }), `${role} on p`,
        `role+project not composed for "${role}"`);
    }
  });
});

describe('inferGoal — branch 4: role-only fallback (project absent or falsy)', () => {
  it('returns just the role when project is absent', () => {
    assert.equal(inferGoal('plain output', { role: 'reviewer' }), 'reviewer');
  });
  it('falls to role-only when project is falsy (empty string / null / 0)', () => {
    // The guard is `c && c.role && c.project` — any falsy project drops to branch 4.
    assert.equal(inferGoal('plain output', { role: 'worker', project: '' }), 'worker');
    assert.equal(inferGoal('plain output', { role: 'worker', project: null }), 'worker');
    assert.equal(inferGoal('plain output', { role: 'worker', project: 0 }), 'worker');
  });
});

describe('inferGoal — branch 5: null when nothing can be inferred', () => {
  it('returns null when there is no ticket, no action verb, and no chat', () => {
    assert.equal(inferGoal('plain output'), null);
  });
  it('returns null for an empty chat object', () => {
    assert.equal(inferGoal('plain output', {}), null);
  });
  it('returns null when chat is explicitly null', () => {
    assert.equal(inferGoal('plain output', null), null);
  });
  it('returns null for empty / whitespace-only pane text', () => {
    assert.equal(inferGoal(''), null);
    assert.equal(inferGoal('\n\n'), null);
  });
  it('returns null for active-looking output that is NOT an action verb and has no chat', () => {
    // "running tests" reads active but "running" is not in the 7-verb set.
    assert.equal(inferGoal('running the test suite'), null);
  });
});

describe('inferGoal — precedence cascade: ticket > action phrase > role+project > role > null', () => {
  const chat = { role: 'worker', project: 'acme' };
  it('a ticket beats an action phrase when both are present', () => {
    assert.equal(inferGoal('working on WARDEN-344', chat), 'WARDEN-344');
  });
  it('an action phrase beats the role+project fallback', () => {
    assert.equal(inferGoal('fixing the bug', chat), 'fixing the bug');
  });
  it('role+project beats role-only (project present → "<role> on <project>")', () => {
    assert.equal(inferGoal('nothing here', chat), 'worker on acme');
  });
  it('role-only beats null (project absent → just the role)', () => {
    assert.equal(inferGoal('nothing here', { role: 'worker' }), 'worker');
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
