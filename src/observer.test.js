import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readChats, Observer, TOOLS,
  transcriptPhaseOf,
  filterRealTranscriptEntries, parseTranscriptTail, paneSignature,
  readTranscriptPhase, buildTranscriptTailScript, parsePhaseFromTailOutput,
} from './observer.js';
import { createSession, deleteSession } from './sessions.js';

// Shared config passed through to capturePanes.
const cfg = { hosts: [] };

// Builder for a yatfa (docker) chat: container set, session 'agent'.
function yatfaChat(overrides = {}) {
  return {
    id: 'host1:myproject-worker',
    key: 'myproject-worker',
    kind: 'yatfa',
    host: 'host1',
    container: 'myproject-worker',
    session: 'agent',
    project: 'myproject',
    role: 'worker',
    active: true,
    status: 'running',
    ...overrides,
  };
}

// Builder for a manual/tmux chat: container null, session is the target.
function tmuxChat(overrides = {}) {
  return {
    id: '(local):manual-session',
    key: 'manual-session',
    kind: 'tmux',
    host: '(local)',
    container: null,
    session: 'manual-session',
    project: 'local',
    role: 'claude',
    active: true,
    status: 'running',
    ...overrides,
  };
}

describe('read_chats tool registration', () => {
  it('is registered in the TOOLS array with an object input schema', () => {
    const tool = TOOLS.find((t) => t.name === 'read_chats');
    assert.ok(tool, 'read_chats tool should be registered');
    assert.strictEqual(tool.input_schema.type, 'object');
    assert.deepStrictEqual(tool.input_schema.required, [], 'no arg is required (ids OR open_only)');
    assert.ok(tool.input_schema.properties.ids, 'exposes an ids array property');
    assert.ok(tool.input_schema.properties.open_only, 'exposes an open_only property');
    assert.ok(tool.input_schema.properties.lines, 'exposes a lines property');
  });
});

describe('readChats (batched concurrent read)', () => {
  // Build several chats on different hosts so multi-pane / partial-host scenarios
  // have realistic keys to match against.
  function worker() { return yatfaChat(); }
  function planner() {
    return yatfaChat({
      id: 'host1:myproject-planner', key: 'myproject-planner', container: 'myproject-planner',
      role: 'planner',
    });
  }
  function reviewer() {
    return yatfaChat({
      id: 'host2:myproject-reviewer', key: 'myproject-reviewer', container: 'myproject-reviewer',
      host: 'host2', project: 'myproject', role: 'reviewer',
    });
  }

  describe('multi-pane success (ids mode)', () => {
    it('returns raw pane content per requested pane in one result (not a structured classification)', async () => {
      const chats = [worker(), planner()];
      const capturePanes = mock.fn(async (_cs) => ({
        'myproject-worker': 'worker output line',
        'myproject-planner': 'planner output line',
      }));

      const result = await readChats(['myproject-worker', 'myproject-planner'], false, [], chats, capturePanes, cfg);

      assert.strictEqual(result.count, 2);
      assert.strictEqual(result.chats.length, 2);
      // Each entry carries the RAW pane (a `pane` field) — read_chats returns
      // raw pane text per pane, not a structured/lossy classification.
      const w = result.chats.find((c) => c.id === 'myproject-worker');
      assert.ok(w, 'worker entry present');
      assert.strictEqual(w.ok, true);
      assert.strictEqual(w.pane, 'worker output line');
      assert.strictEqual(w.host, 'host1');
      assert.strictEqual(w.role, 'worker');
      assert.ok(!('state' in w) && !('errors' in w), 'no classification fields — this is raw content');
      assert.strictEqual(result.summary.read, 2);
      assert.strictEqual(result.summary.captureFailed, 0);
    });

    it('calls capturePanes exactly once with all resolved chats and the cfg (concurrent, no serial loop)', async () => {
      // WARDEN-88: a serial await-in-loop would call capturePanes once PER pane.
      // The batched design calls it exactly ONCE for N panes.
      const chats = [worker(), planner(), reviewer()];
      const capturePanes = mock.fn(async (cs) => Object.fromEntries(cs.map((c) => [c.key, `pane-${c.key}`])));

      await readChats(['myproject-worker', 'myproject-planner', 'myproject-reviewer'], false, [], chats, capturePanes, cfg);

      assert.strictEqual(capturePanes.mock.callCount(), 1, 'one batched capturePanes call regardless of pane count');
      const passed = capturePanes.mock.calls[0].arguments[0];
      assert.strictEqual(passed.length, 3, 'all three panes are read in that single call');
      assert.strictEqual(capturePanes.mock.calls[0].arguments[1], cfg, 'cfg is forwarded');
    });

    it('dedupes ids that resolve to the same pane', async () => {
      const chats = [worker()];
      const capturePanes = mock.fn(async (cs) => ({ [cs[0].key]: 'only pane' }));

      // 'myproject-worker' (exact container) and 'worker' (role) both hit the same chat.
      const result = await readChats(['myproject-worker', 'worker'], false, [], chats, capturePanes, cfg);

      assert.strictEqual(result.count, 1, 'the same pane is not read twice');
      assert.strictEqual(capturePanes.mock.calls[0].arguments[0].length, 1);
    });

    it('resolves a manual/tmux chat (container null) by session', async () => {
      const chat = tmuxChat();
      const capturePanes = mock.fn(async (cs) => ({ [cs[0].key]: 'manual pane text' }));

      const result = await readChats(['manual-session'], false, [], [chat], capturePanes, cfg);

      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.chats[0].id, 'manual-session');
      assert.strictEqual(result.chats[0].pane, 'manual pane text');
    });
  });

  describe('open_only resolution', () => {
    it('reads exactly the open tabs when open_only is true (ignores ids)', async () => {
      const worker_ = worker();
      const planner_ = planner();
      const reviewer_ = reviewer(); // not open
      const capturePanes = mock.fn(async (cs) => Object.fromEntries(cs.map((c) => [c.key, `pane-${c.key}`])));

      const result = await readChats(['myproject-reviewer'], true,
        ['myproject-worker', 'myproject-planner'], [worker_, planner_, reviewer_], capturePanes, cfg);

      // ids is ignored under open_only; only the two open tabs are read.
      assert.strictEqual(result.count, 2);
      assert.deepStrictEqual(result.chats.map((c) => c.id).sort(), ['myproject-planner', 'myproject-worker']);
      assert.strictEqual(capturePanes.mock.calls[0].arguments[0].length, 2);
    });

    it('returns the "no tabs" error when open_only is true and nothing is open', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await readChats([], true, [], [worker()], capturePanes, cfg);

      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0);
    });

    it('returns the "do not match" error when open_only tabs match no discovered chat', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await readChats([], true, ['ghost-tab'], [worker()], capturePanes, cfg);

      assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
      assert.strictEqual(capturePanes.mock.callCount(), 0);
    });
  });

  describe('partial host failure (WARDEN-89: failures reported, not dropped)', () => {
    it('flags the pane whose host capture failed while returning the others, never omitting it', async () => {
      // capturePanes silently skips a host whose SSH fails, so the reviewer (host2)
      // has NO key in the result map. readChats must surface it as a flagged entry
      // rather than dropping it — the dangerous input is the missing key.
      const chats = [worker(), planner(), reviewer()];
      const capturePanes = mock.fn(async (cs) => {
        const out = {};
        for (const c of cs) if (c.host !== 'host2') out[c.key] = `pane-${c.key}`;
        return out;
      });

      const result = await readChats(
        ['myproject-worker', 'myproject-planner', 'myproject-reviewer'], false, [], chats, capturePanes, cfg);

      assert.strictEqual(result.chats.length, 3, 'all three requested panes yield an entry');
      const failed = result.chats.find((c) => c.id === 'myproject-reviewer');
      assert.ok(failed, 'the failed-host pane is still present — NOT dropped');
      assert.strictEqual(failed.ok, false);
      assert.strictEqual(failed.host, 'host2');
      assert.ok(!('pane' in failed), 'no pane content for a failed capture');
      assert.ok(failed.error.includes('host2'), 'the error names the unreachable host');

      const ok = result.chats.filter((c) => c.ok);
      assert.strictEqual(ok.length, 2);
      assert.deepStrictEqual(ok.map((c) => c.id).sort(), ['myproject-planner', 'myproject-worker']);
      assert.strictEqual(result.summary.captureFailed, 1);
      assert.strictEqual(result.summary.read, 2);
    });
  });

  describe('id resolution failures (surfaced per-id, not fatal)', () => {
    it('reports an unmatched id per-id while still reading the ids that resolve', async () => {
      const chats = [worker()];
      const capturePanes = mock.fn(async (cs) => ({ [cs[0].key]: 'pane' }));

      const result = await readChats(['myproject-worker', 'no-such-agent'], false, [], chats, capturePanes, cfg);

      assert.strictEqual(result.count, 1, 'the resolvable id is still read');
      assert.strictEqual(result.chats[0].id, 'myproject-worker');
      assert.ok(Array.isArray(result.errors) && result.errors.length === 1, 'the bad id is reported');
      assert.strictEqual(result.errors[0].id, 'no-such-agent');
      assert.ok(/no chat matches/.test(result.errors[0].error));
      assert.strictEqual(result.summary.resolutionFailed, 1);
    });

    it('reports an ambiguous id per-id (does not silently pick one)', async () => {
      const a = worker();
      const b = yatfaChat({ id: 'host2:other-worker', key: 'other-worker', container: 'other-worker', host: 'host2' });
      const capturePanes = mock.fn(async (cs) => Object.fromEntries(cs.map((c) => [c.key, 'x'])));

      const result = await readChats(['worker'], false, [], [a, b], capturePanes, cfg);

      // 'worker' matches both by role → ambiguous. No pane is read; the error is surfaced.
      assert.strictEqual(result.count, undefined, 'no success shape when nothing resolves');
      assert.ok(result.error);
      assert.ok(Array.isArray(result.errors) && result.errors.length === 1);
      assert.ok(/ambiguous/.test(result.errors[0].error), 'the ambiguity is named');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'nothing to capture when the sole id is ambiguous');
    });

    it('returns a "provide ids or open_only" error when neither mode is supplied', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await readChats(undefined, false, [], [worker()], capturePanes, cfg);

      assert.strictEqual(result.error, 'provide an array of ids or set open_only: true.');
      assert.strictEqual(capturePanes.mock.callCount(), 0);
    });

    it('ignores blank/non-string ids rather than treating them as a match', async () => {
      const capturePanes = mock.fn(async (cs) => ({ [cs[0].key]: 'pane' }));
      // mixed with a valid id; the blanks must not error or match.
      const result = await readChats(['', '  ', 'myproject-worker'], false, [], [worker()], capturePanes, cfg);

      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.chats[0].id, 'myproject-worker');
      assert.strictEqual(capturePanes.mock.calls[0].arguments[0].length, 1);
    });
  });

  describe('bounded output (WARDEN-167 AC #5)', () => {
    it('trims each pane to the last `lines` lines', async () => {
      const chat = worker();
      const longPane = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
      const capturePanes = mock.fn(async () => ({ [chat.key]: longPane }));

      const result = await readChats(['myproject-worker'], false, [], [chat], capturePanes, cfg, { lines: 5 });

      const out = result.chats[0].pane.split('\n');
      assert.strictEqual(out.length, 5);
      assert.deepStrictEqual(out, ['line 55', 'line 56', 'line 57', 'line 58', 'line 59']);
    });

    it('treats lines <= 0 as the minimum of 1 line', async () => {
      const chat = worker();
      const capturePanes = mock.fn(async () => ({ [chat.key]: 'a\nb\nc' }));

      const result = await readChats(['myproject-worker'], false, [], [chat], capturePanes, cfg, { lines: 0 });

      assert.strictEqual(result.chats[0].pane, 'c');
    });

    it('caps how many panes are captured and surfaces the overflow as skipped (no silent drop)', async () => {
      const chats = [worker(), planner(), reviewer()];
      const capturePanes = mock.fn(async (cs) => Object.fromEntries(cs.map((c) => [c.key, `pane-${c.key}`])));

      const result = await readChats(
        ['myproject-worker', 'myproject-planner', 'myproject-reviewer'], false, [], chats, capturePanes, cfg,
        { maxPanes: 2 });

      // Only 2 are captured; the 3rd is surfaced as skipped, not silently truncated.
      assert.strictEqual(capturePanes.mock.calls[0].arguments[0].length, 2, 'capturePanes only sees the capped count');
      assert.strictEqual(result.count, 3, 'all requested panes still have an entry');
      const skipped = result.chats.filter((c) => c.skipped);
      assert.strictEqual(skipped.length, 1);
      assert.strictEqual(skipped[0].ok, false);
      assert.ok(/max pane cap/.test(skipped[0].error), 'the skip reason is stated');
      assert.strictEqual(result.summary.skipped, 1);
      assert.strictEqual(result.summary.read, 2);
    });
  });

  describe('raw content fidelity (matches read_chat, distinct from summarize)', () => {
    it('preserves raw pane text including ANSI (does not strip — read_chat keeps it)', async () => {
      // read_chat returns raw capture output (ANSI intact); read_chats is its batched
      // sibling and preserves the same fidelity rather than stripping like summarize.
      const chat = worker();
      const pane = '\x1b[31mError: build failed\x1b[0m\nRunning setup.';
      const capturePanes = mock.fn(async () => ({ [chat.key]: pane }));

      const result = await readChats(['myproject-worker'], false, [], [chat], capturePanes, cfg);

      assert.ok(result.chats[0].pane.includes('\x1b'), 'raw ANSI is preserved, matching read_chat');
      assert.ok(/Error: build failed/.test(result.chats[0].pane));
    });
  });

  describe('error handling', () => {
    it('returns the error message when capturePanes throws (does not reject)', async () => {
      const chat = worker();
      const capturePanes = mock.fn(async () => { throw new Error('ssh connection refused'); });

      const result = await readChats(['myproject-worker'], false, [], [chat], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'ssh connection refused');
    });
  });
});

describe('Observer _execTool read_chats dispatch', () => {
  // The success/content behavior is covered by the readChats pure-function suite
  // above (mocked capturePanes). These dispatch tests cover only paths that run
  // BEFORE capturePanes is reached — _execTool wires the real module-level
  // capturePanes, which cannot be mocked on Node 20 (WARDEN-130), so a success
  // assertion here would hit live SSH. The guard + wiring paths below exercise the
  // dispatch without that constraint.

  it('open_only with empty openTabs returns the "no tabs" error', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = [];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('read_chats', { open_only: true });

    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
  });

  it('open_only forwards effectiveOpenTabs + lastChats (ghost tab → "do not match")', async () => {
    // Reaching the "do not match" guard proves _execTool passed open_only through
    // to readChats and supplied effectiveOpenTabs() + this.lastChats.
    const obs = new Observer(cfg, {});
    obs.openTabs = ['ghost-tab'];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('read_chats', { open_only: true });

    assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
  });

  it('ids mode forwards input.ids + lastChats to readChats (unknown id → resolution error)', async () => {
    // Reaching readChats' resolution logic (not the usage guard) proves _execTool
    // forwarded ids and lastChats. An unknown id resolves to nothing without ever
    // calling capturePanes, so this needs no SSH.
    const obs = new Observer(cfg, {});
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('read_chats', { ids: ['totally-unknown-id'] });

    assert.ok(/none of the requested ids resolved/.test(result.error));
    assert.ok(Array.isArray(result.errors) && result.errors.length === 1);
    assert.strictEqual(result.errors[0].id, 'totally-unknown-id');
  });

  it('returns the usage error when neither ids nor open_only is supplied', async () => {
    const obs = new Observer(cfg, {});
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('read_chats', {});

    assert.strictEqual(result.error, 'provide an array of ids or set open_only: true.');
  });

  it('returns the usage error when ids is an empty array and open_only is false', async () => {
    const obs = new Observer(cfg, {});
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('read_chats', { ids: [] });

    assert.strictEqual(result.error, 'provide an array of ids or set open_only: true.');
  });
});

describe('Observer _resolve (no-match suggestion fallback)', () => {
  // WARDEN-141: when neither cache nor refresh resolves an id, _resolve builds a
  // "no chat matches" error suggesting available chats. The suggestion MUST use
  // c.id (always present and typeable) — not c.container, which is null for
  // manual/tmux chats. Array.join turns that null into "" (NOT the literal
  // "null"), so buggy code silently drops the manual chat from the list, leaving
  // an empty/degenerate slot. Asserting the manual chat's id appears is what
  // actually fails on the buggy code; a bare !includes('null') would not.

  // Builds an Observer whose cache and refresh both fail to match `id`, forcing
  // _resolve to the fallback that constructs the suggestion message.
  function observerThatCannotResolve(id, chats) {
    const obs = new Observer(cfg, {});
    obs.lastChats = chats;
    obs._refreshChats = async () => { obs.lastChats = chats; return chats; };
    return obs;
  }

  it('lists every chat by id, including manual/tmux chats whose container is null', async () => {
    const chats = [yatfaChat(), tmuxChat()];
    const obs = observerThatCannotResolve('definitely-not-a-real-chat', chats);

    const result = await obs._resolve('definitely-not-a-real-chat');

    assert.ok(result.error, 'should return an error when nothing matches');
    assert.ok(result.error.includes('(local):manual-session'),
      'the manual/tmux chat (container null) must appear by its id — buggy code dropped it to an empty entry');
    assert.ok(result.error.includes('host1:myproject-worker'),
      'the yatfa chat must appear by its id');
    assert.ok(!result.error.includes('null'),
      'no literal "null" should appear in the suggestion list');
  });

  it('emits no empty/degenerate suggestion slots when a manual chat is interleaved', async () => {
    // Mirrors the reported scenario: a manual chat sandwiched between yatfa chats.
    const planner = yatfaChat({ id: 'host1:yatfa-planner-1', key: 'yatfa-planner-1', container: 'yatfa-planner-1', role: 'planner' });
    const manual = tmuxChat();
    const worker = yatfaChat({ id: 'host1:yatfa-worker-2', key: 'yatfa-worker-2', container: 'yatfa-worker-2', role: 'worker' });
    const chats = [planner, manual, worker];
    const obs = observerThatCannotResolve('foo', chats);

    const result = await obs._resolve('foo');

    // Pull the suggestion list out of "try one of: a, b, c" and check each slot.
    const list = result.error.split('try one of: ')[1];
    const entries = list.split(', ');
    assert.ok(!entries.includes(''),
      'no empty suggestion slots — buggy code rendered the null container as ""');
    assert.ok(entries.includes('(local):manual-session'),
      'the manual chat appears as a valid, typeable id');
  });
});

// Chat context metadata — what makes observer resume seamless across hosts.
// The session remembers which agent it was bound to so a reconnect restores it.
describe('Observer chat context (cross-host resumption)', () => {
  it('stores chat context passed at creation', () => {
    const ctx = { host: 'host1', container: 'c1', project: 'p', role: 'worker', chatKey: 'c1' };
    const obs = new Observer(cfg, { chatContext: ctx });

    assert.deepStrictEqual(obs.getChatContext(), ctx);
    assert.strictEqual(obs.boundKey, 'c1');
  });

  it('boundKey falls back to chatKey when container is null (manual/tmux chat)', () => {
    const obs = new Observer(cfg, { chatContext: { chatKey: 'manual-session', host: '(local)' } });
    assert.strictEqual(obs.boundKey, 'manual-session');
  });

  it('has no bound key and empty effective tabs without chat context', () => {
    const obs = new Observer(cfg, {});
    assert.strictEqual(obs.boundKey, null);
    assert.deepStrictEqual(obs.effectiveOpenTabs(), []);
  });

  it('effectiveOpenTabs includes the bound chat even when no panes are open', () => {
    const obs = new Observer(cfg, { chatContext: { container: 'myproject-worker', host: 'host1' } });
    obs.openTabs = [];
    assert.deepStrictEqual(obs.effectiveOpenTabs(), ['myproject-worker']);
  });

  it('effectiveOpenTabs dedupes the bound chat with already-open panes', () => {
    const obs = new Observer(cfg, { chatContext: { container: 'worker-a' } });
    obs.openTabs = ['worker-a', 'worker-b'];
    assert.deepStrictEqual(obs.effectiveOpenTabs().sort(), ['worker-a', 'worker-b']);
  });

  it('restores chat context from the persisted session on resume', () => {
    const s = createSession(null, { host: 'host1', container: 'c1', project: 'p', role: 'worker', chatKey: 'c1' });
    try {
      const obs = new Observer(cfg, { sid: s.id }); // resume path: sid set, no chatContext
      assert.strictEqual(obs.boundKey, 'c1');
      assert.strictEqual(obs.getChatContext().host, 'host1');
      assert.strictEqual(obs.getChatContext().role, 'worker');
    } finally {
      deleteSession(s.id);
    }
  });

  it('persisted session context takes precedence over a passed chatContext on resume', () => {
    const s = createSession(null, { host: 'host1', container: 'c1', chatKey: 'c1', role: 'worker' });
    try {
      const obs = new Observer(cfg, { sid: s.id, chatContext: { container: 'OTHER', chatKey: 'OTHER' } });
      assert.strictEqual(obs.boundKey, 'c1', 'the persisted context is the source of truth');
    } finally {
      deleteSession(s.id);
    }
  });

  it('a legacy session without chat context resumes unbound (backward compatible)', () => {
    const s = createSession(null); // no context
    try {
      const obs = new Observer(cfg, { sid: s.id });
      assert.strictEqual(obs.boundKey, null);
      assert.strictEqual(obs.getChatContext(), null);
    } finally {
      deleteSession(s.id);
    }
  });
});

// ======================= WARDEN-166: change-aware state cache =======================

// Build a transcript entry object (the shape Claude Code writes to .jsonl).
function tEntry(type, opts = {}) {
  return { type, ...opts };
}
function assistantEntry(stopReason, text = 'ok') {
  return tEntry('assistant', { message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason } });
}
function userEntry(text = 'go') {
  return tEntry('user', { message: { role: 'user', content: text } });
}

describe('WARDEN-166 pure helpers', () => {
  describe('filterRealTranscriptEntries', () => {
    it('keeps user/assistant entries and drops metadata types', () => {
      const entries = [
        tEntry('mode'),
        tEntry('summary', { summary: 'old' }),
        tEntry('permission-mode'),
        tEntry('ai-title'),
        tEntry('last-prompt'),
        tEntry('file-history-snapshot'),
        tEntry('attachment'),
        tEntry('system'),
        userEntry(),
        assistantEntry('end_turn'),
      ];
      const real = filterRealTranscriptEntries(entries);
      assert.strictEqual(real.length, 2, 'only the user + assistant entries survive');
      assert.deepStrictEqual(real.map((e) => e.type), ['user', 'assistant']);
    });

    it('returns an empty array when every entry is metadata', () => {
      assert.deepStrictEqual(filterRealTranscriptEntries([tEntry('mode'), tEntry('summary')]), []);
    });
  });

  describe('transcriptPhaseOf', () => {
    it('awaiting-input: last real entry is an assistant message that ended a turn', () => {
      for (const sr of ['end_turn', 'stop_sequence', 'max_tokens']) {
        assert.strictEqual(transcriptPhaseOf([userEntry(), assistantEntry(sr)]), 'awaiting-input',
          `${sr} means the turn ended → awaiting input`);
      }
    });

    it('mid-turn: last real entry is an assistant tool_use (turn ongoing)', () => {
      assert.strictEqual(transcriptPhaseOf([userEntry(), assistantEntry('tool_use')]), 'mid-turn');
    });

    it('mid-turn: last real entry is a user message (turn just started)', () => {
      assert.strictEqual(transcriptPhaseOf([assistantEntry('end_turn'), userEntry()]), 'mid-turn');
    });

    it('ignores trailing metadata entries when finding the last real entry', () => {
      // A mode/permission-mode/summary line appended after the assistant end_turn
      // must NOT change the phase — the last REAL entry is still the end_turn.
      const entries = [
        userEntry(),
        assistantEntry('end_turn'),
        tEntry('mode'),
        tEntry('permission-mode'),
        tEntry('summary', { summary: 'compaction' }),
      ];
      assert.strictEqual(transcriptPhaseOf(entries), 'awaiting-input');
    });

    it('returns null when there are no real entries', () => {
      assert.strictEqual(transcriptPhaseOf([tEntry('mode'), tEntry('summary')]), null);
      assert.strictEqual(transcriptPhaseOf([]), null);
    });

    it('returns null for an assistant line with an unrecognized stop_reason', () => {
      assert.strictEqual(transcriptPhaseOf([assistantEntry(undefined)]), null);
    });
  });

  describe('parseTranscriptTail', () => {
    it('parses JSON lines and skips the leading partial line + malformed lines', () => {
      // tail -c leaves a partial first line; JSON.parse throws on it → skipped.
      const text = '{"type":"partial\n' +
        JSON.stringify(userEntry()) + '\n' +
        'not-json-at-all\n' +
        JSON.stringify(assistantEntry('end_turn')) + '\n';
      const entries = parseTranscriptTail(text);
      assert.strictEqual(entries.length, 2, 'partial + malformed lines dropped');
      assert.strictEqual(transcriptPhaseOf(entries), 'awaiting-input');
    });
  });

  describe('paneSignature', () => {
    it('is stable for identical content and changes when content changes', () => {
      assert.strictEqual(paneSignature('a\nb\nc'), paneSignature('a\nb\nc'));
      assert.notStrictEqual(paneSignature('a\nb\nc'), paneSignature('a\nb\nd'));
    });

    it('ignores blank/whitespace-only lines in the count', () => {
      assert.strictEqual(paneSignature('a\n\nb'), '2:b');
    });
  });
});

describe('WARDEN-166 buildTranscriptTailScript + parsePhaseFromTailOutput', () => {
  it('builds a script that finds the most-recent transcript and tails it', () => {
    const s = buildTranscriptTailScript();
    for (const frag of ['"$HOME"/.claude/projects', 'ls -t', 'tail -c 8192', '___TAIL', '___NONE']) {
      assert.ok(s.includes(frag), `script contains "${frag}"`);
    }
  });

  it('parses a ___TAIL payload into a phase', () => {
    const stdout = '___TAIL\n' + JSON.stringify(userEntry()) + '\n' + JSON.stringify(assistantEntry('end_turn')) + '\n';
    assert.strictEqual(parsePhaseFromTailOutput(stdout), 'awaiting-input');
  });

  it('returns null for ___NONE (no transcript)', () => {
    assert.strictEqual(parsePhaseFromTailOutput('___NONE\n'), null);
  });

  it('returns null for empty/unreachable output', () => {
    assert.strictEqual(parsePhaseFromTailOutput(''), null);
    assert.strictEqual(parsePhaseFromTailOutput(undefined), null);
  });
});

describe('WARDEN-166 readTranscriptPhase (local-filesystem branch)', () => {
  // The local branch reads os.homedir()/.claude/projects — redirect HOME to a
  // throwaway dir so the test is isolated and never touches the real archive.
  let realHome;
  let tmp;
  before(() => {
    realHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-phase-'));
    process.env.HOME = tmp;
  });
  after(() => {
    process.env.HOME = realHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function writeTranscript(entries) {
    const dir = path.join(tmp, '.claude', 'projects', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session-uuid.jsonl');
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    return file;
  }

  it('returns awaiting-input when the transcript ends on end_turn', async () => {
    writeTranscript([userEntry(), assistantEntry('end_turn')]);
    const phase = await readTranscriptPhase({ container: null, host: '(local)', key: 'm', session: 'm' });
    assert.strictEqual(phase, 'awaiting-input');
  });

  it('returns mid-turn when the transcript ends on tool_use', async () => {
    writeTranscript([userEntry(), assistantEntry('tool_use')]);
    const phase = await readTranscriptPhase({ container: null, host: '(local)', key: 'm', session: 'm' });
    assert.strictEqual(phase, 'mid-turn');
  });

  it('returns null when there is no transcript at all', async () => {
    // Fresh tmp with no .claude/projects (writeTranscript not called here, but a
    // prior test wrote one — wipe to be sure this asserts the empty case).
    fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true });
    const phase = await readTranscriptPhase({ container: null, host: '(local)', key: 'm', session: 'm' });
    assert.strictEqual(phase, null);
  });
});

describe('WARDEN-166 readChats changed_only + observedState', () => {
  it('attaches observedState while keeping entries RAW (no state field on entries)', async () => {
    const chat = yatfaChat();
    const capturePanes = mock.fn(async (cs) => ({ [cs[0].key]: 'raw pane' }));
    const res = await readChats(['myproject-worker'], false, [], [chat], capturePanes, cfg);
    assert.ok(res.observedState, 'observedState side-channel present');
    assert.ok(!('state' in res.chats[0]), 'result entries stay raw — no classification fields');
    assert.strictEqual(res.chats[0].pane, 'raw pane');
  });

  it('changed_only drops panes whose content signature is unchanged', async () => {
    const worker = yatfaChat();
    const researcher = yatfaChat({
      id: 'host1:myproject-researcher', key: 'myproject-researcher', container: 'myproject-researcher', role: 'researcher',
    });
    const chats = [worker, researcher];
    const panes = { 'myproject-worker': 'same content', 'myproject-researcher': 'same content' };
    const capturePanes = mock.fn(async (cs) => Object.fromEntries(cs.map((c) => [c.key, panes[c.key]])));

    // Baseline to seed the cache.
    const base = await readChats(['myproject-worker', 'myproject-researcher'], false, [], chats, capturePanes, cfg);

    // Only the worker pane changes.
    const panes2 = { 'myproject-worker': 'CHANGED content', 'myproject-researcher': 'same content' };
    const capturePanes2 = mock.fn(async (cs) => Object.fromEntries(cs.map((c) => [c.key, panes2[c.key]])));
    const res = await readChats(['myproject-worker', 'myproject-researcher'], false, [], chats, capturePanes2, cfg,
      { changed_only: true }, undefined, base.observedState);

    const readIds = res.chats.filter((c) => c.ok).map((c) => c.id);
    assert.deepStrictEqual(readIds, ['myproject-worker'], 'only the changed pane is returned');
    assert.strictEqual(res.changedOnly, true);
  });
});

describe('WARDEN-166 Observer cache wiring', () => {
  it('starts with an empty in-memory lastReadState', () => {
    const obs = new Observer(cfg, {});
    assert.deepStrictEqual(obs.lastReadState, {});
  });

  it('_mergeReadState records state/phase/sig + ts from an observed side-channel', () => {
    const obs = new Observer(cfg, {});
    obs._mergeReadState({ 'myproject-worker': { state: 'erroring', phase: null, sig: '3:x' } });
    const e = obs.lastReadState['myproject-worker'];
    assert.strictEqual(e.state, 'erroring');
    assert.strictEqual(e.sig, '3:x');
    assert.ok(typeof e.ts === 'number' && e.ts > 0, 'timestamp recorded');
  });

  it('_mergeReadState preserves a previously cached phase when the new read omits it', () => {
    // read_chat / a plain summarize refresh pane state but pass phase:null; the
    // cached transcript phase must survive so the next alert can still flip.
    const obs = new Observer(cfg, {});
    obs._mergeReadState({ 'k': { state: 'active', phase: 'mid-turn', sig: 'a' } });
    obs._mergeReadState({ 'k': { state: 'active', phase: null, sig: 'b' } });
    assert.strictEqual(obs.lastReadState['k'].phase, 'mid-turn', 'phase preserved across a phase-less refresh');
    assert.strictEqual(obs.lastReadState['k'].sig, 'b', 'sig refreshed');
  });

});

describe('WARDEN-509 alert_changes retirement', () => {
  it('is absent from the TOOLS array (retired; "what needs attention" defers to the AttentionBadge)', () => {
    const tool = TOOLS.find((t) => t.name === 'alert_changes');
    assert.strictEqual(tool, undefined, 'alert_changes tool should be retired');
  });

  it('read_chats still exposes a changed_only flag', () => {
    const read = TOOLS.find((t) => t.name === 'read_chats');
    assert.ok(read.input_schema.properties.changed_only, 'read_chats has changed_only');
  });
});
