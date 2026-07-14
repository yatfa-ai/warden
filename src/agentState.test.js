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
// Precedence mirrors suggest_next_actions: erroring > stuck > blocked > waiting >
// active (an error is more actionable than a loop, which beats a coordination wait).
//
// agentState.js is dependency-free (no fs/ssh/llm/node-pty), so it imports cleanly
// under `node --test` with no HOME/PATH shenanigans.
//
// Run: node --test src/agentState.test.js   (or auto-discovered by `npm test`)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPane, stripAnsi, SUMM_ERROR_RE, SUMM_WAITING_RE, SUMM_BLOCKED_RE } from './agentState.js';

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
