import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { summarizeOpenChats, suggestNextActions, Observer, TOOLS } from './observer.js';
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

describe('summarizeOpenChats', () => {
  describe('empty tabs path (open.size === 0)', () => {
    it('returns the "no tabs" error when openTabs is undefined', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats(undefined, [yatfaChat()], capturePanes, cfg);

      assert.ok(result.error, 'should return an error');
      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });

    it('returns the "no tabs" error when openTabs is null', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats(null, [yatfaChat()], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });

    it('returns the "no tabs" error when openTabs is an empty array', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats([], [yatfaChat()], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });
  });

  describe('stale state path (openChats.length === 0)', () => {
    it('returns the "do not match" error when no open tab matches a discovered chat', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats(['ghost-tab'], [yatfaChat()], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });

    it('returns the "do not match" error when lastChats is empty', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats(['myproject-worker'], [], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });
  });

  describe('success path', () => {
    it('returns a structured per-agent entry (not raw pane) for each open chat', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'worker pane content' }));

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.strictEqual(result.count, 1);
      assert.ok(Array.isArray(result.chats));
      assert.strictEqual(result.chats.length, 1);

      const entry = result.chats[0];
      assert.strictEqual(entry.id, 'myproject-worker', 'id is container || session');
      assert.strictEqual(entry.host, 'host1');
      assert.strictEqual(entry.project, 'myproject');
      assert.strictEqual(entry.role, 'worker');
      assert.strictEqual(entry.active, true);
      // Structured classification fields (WARDEN-165 criterion #2), not raw pane:
      assert.ok(['active', 'idle', 'stuck', 'erroring', 'blocked', 'waiting'].includes(entry.state),
        'state is a known classification');
      assert.strictEqual(entry.captureError, false, 'a successful capture is not flagged');
      assert.strictEqual(entry.excerpt, 'worker pane content', 'excerpt carries the cleaned pane');
      assert.ok(!('pane' in entry), 'raw pane field is gone — output is structured, not a dump');
      assert.ok(result.summary && result.summary.total === 1, 'result includes a summary counts block');
    });

    it('calls capturePanes once with the filtered open chats and the cfg', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'x' }));

      await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.strictEqual(capturePanes.mock.callCount(), 1);
      const call = capturePanes.mock.calls[0];
      assert.strictEqual(call.arguments[0].length, 1, 'passes the single open chat');
      assert.strictEqual(call.arguments[0][0].key, 'myproject-worker');
      assert.strictEqual(call.arguments[1], cfg, 'forwards cfg');
    });

    it('id falls back to session when container is null (manual/tmux chat)', async () => {
      const chat = tmuxChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'manual pane' }));

      const result = await summarizeOpenChats([chat.session], [chat], capturePanes, cfg);

      assert.strictEqual(result.chats[0].id, 'manual-session');
      assert.strictEqual(result.chats[0].excerpt, 'manual pane');
    });

    it('flags a capture failure (key missing from panes map) instead of dropping the entry', async () => {
      // capturePanes returns no entry for this chat's key — the WARDEN-165 "1 of 6"
      // root cause: a host whose SSH fails is silently skipped, so every pane on that
      // host vanishes. summarizeOpenChats must surface it as a flagged failure, not
      // omit it and not render it as '(no pane content)'.
      const chat = yatfaChat();
      const capturePanes = mock.fn(async () => ({})); // host SSH failed: no panes captured

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      // The entry is STILL present — failures are surfaced, never silently dropped.
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.chats.length, 1);
      const entry = result.chats[0];
      assert.strictEqual(entry.id, 'myproject-worker');
      assert.strictEqual(entry.captureError, true, 'a missing key means capture failed');
      assert.strictEqual(entry.state, 'capture_failed');
      assert.strictEqual(entry.excerpt, null, 'no pane content to excerpt');
      assert.ok(typeof entry.error === 'string' && entry.error.length > 0, 'an error reason is reported on the entry');
      assert.ok(entry.error.includes('host1'), 'the error names the unreachable host');
      assert.strictEqual(result.summary.captureFailed, 1, 'summary counts the capture failure');
    });
  });

  describe('chat filtering logic (open.has(container || session) || open.has(key))', () => {
    const panesFn = mock.fn(async (chats) =>
      Object.fromEntries(chats.map((c) => [c.key, `pane-${c.key}`])));

    it('matches a yatfa chat by container', async () => {
      const result = await summarizeOpenChats(['myproject-worker'], [yatfaChat()], panesFn, cfg);
      assert.strictEqual(result.count, 1);
    });

    it('matches a manual chat by session (container is null)', async () => {
      const result = await summarizeOpenChats(['manual-session'], [tmuxChat()], panesFn, cfg);
      assert.strictEqual(result.count, 1);
    });

    it('matches a chat by key', async () => {
      const result = await summarizeOpenChats(['myproject-worker'], [yatfaChat()], panesFn, cfg);
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.chats[0].excerpt, 'pane-myproject-worker');
    });

    it('summarizes only chats whose tab is open (closed chats are excluded)', async () => {
      const worker = yatfaChat();
      const researcher = yatfaChat({
        id: 'host1:myproject-researcher',
        key: 'myproject-researcher',
        container: 'myproject-researcher',
        role: 'researcher',
      });

      const fn = mock.fn(async (chats) =>
        Object.fromEntries(chats.map((c) => [c.key, `pane-${c.key}`])));
      const result = await summarizeOpenChats(['myproject-worker'], [worker, researcher], fn, cfg);

      assert.strictEqual(result.count, 1, 'only the open worker tab');
      assert.strictEqual(result.chats[0].id, 'myproject-worker');
      // capturePanes only sees the one open chat
      assert.strictEqual(fn.mock.calls[0].arguments[0].length, 1);
    });

    it('summarizes all open chats when multiple tabs are open', async () => {
      const worker = yatfaChat();
      const researcher = yatfaChat({
        id: 'host1:myproject-researcher',
        key: 'myproject-researcher',
        container: 'myproject-researcher',
        role: 'researcher',
      });

      const fn = mock.fn(async (chats) =>
        Object.fromEntries(chats.map((c) => [c.key, `pane-${c.key}`])));
      const result = await summarizeOpenChats(
        ['myproject-worker', 'myproject-researcher'],
        [worker, researcher],
        fn,
        cfg,
      );

      assert.strictEqual(result.count, 2);
      const ids = result.chats.map((c) => c.id).sort();
      assert.deepStrictEqual(ids, ['myproject-researcher', 'myproject-worker']);
    });
  });

  describe('error handling', () => {
    it('returns the error message when capturePanes throws', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async () => {
        throw new Error('ssh connection refused');
      });

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'ssh connection refused');
    });

    it('does not throw when capturePanes rejects (error is captured, not propagated)', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async () => {
        throw new Error('boom');
      });

      // Must resolve rather than reject — the handler swallows the throw.
      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.count, undefined, 'success shape not produced');
    });
  });

  describe('capture failure across hosts (WARDEN-165 "1 of 6" root cause)', () => {
    // capturePanes silently skips a host whose SSH fails (`if (!res.ok) return;`),
    // so every pane on that host vanishes from its result map. summarizeOpenChats
    // detects the missing key and surfaces a flagged failure entry instead of
    // dropping it — every open pane yields an entry.
    it('lists every open pane and flags the one whose host capture failed', async () => {
      const worker = yatfaChat(); // host1
      const planner = yatfaChat({
        id: 'host1:proj-planner', key: 'proj-planner', container: 'proj-planner',
        host: 'host1', project: 'proj', role: 'planner',
      });
      const reviewer = yatfaChat({
        id: 'host2:proj-reviewer', key: 'proj-reviewer', container: 'proj-reviewer',
        host: 'host2', project: 'proj', role: 'reviewer',
      });

      // host2's SSH failed: capturePanes returns no entry for the reviewer.
      const capturePanes = mock.fn(async (chats) => {
        const out = {};
        for (const c of chats) if (c.host !== 'host2') out[c.key] = `pane for ${c.key}`;
        return out;
      });

      const result = await summarizeOpenChats(
        ['myproject-worker', 'proj-planner', 'proj-reviewer'],
        [worker, planner, reviewer],
        capturePanes, cfg,
      );

      assert.strictEqual(result.count, 3, 'all three open panes get an entry');
      assert.strictEqual(result.chats.length, 3);
      assert.strictEqual(result.summary.captureFailed, 1);

      // The reviewer (host2) entry is present and flagged — NOT omitted.
      const failed = result.chats.find((c) => c.id === 'proj-reviewer');
      assert.ok(failed, 'the failed-host pane still has an entry');
      assert.strictEqual(failed.captureError, true);
      assert.strictEqual(failed.state, 'capture_failed');
      assert.strictEqual(failed.host, 'host2');
      assert.ok(failed.error.includes('host2'), 'the error names the unreachable host');

      // The two captured panes are present, unflagged, with content.
      const captured = result.chats.filter((c) => !c.captureError);
      assert.strictEqual(captured.length, 2);
      assert.deepStrictEqual(captured.map((c) => c.id).sort(), ['myproject-worker', 'proj-planner']);
      assert.ok(captured.every((c) => c.excerpt != null));
    });
  });

  describe('structured classification fields (WARDEN-165 criterion #2)', () => {
    async function summarizeOne(pane, chatOverrides = {}) {
      const chat = yatfaChat(chatOverrides);
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: pane }));
      return summarizeOpenChats([chat.container], [chat], capturePanes, cfg);
    }

    it('classifies an erroring pane and extracts the error line', async () => {
      const result = await summarizeOne('Running build...\nError: compilation failed with exit 1\nSee log.');
      const e = result.chats[0];
      assert.strictEqual(e.state, 'erroring');
      assert.ok(e.errors.length >= 1, 'the offending error line is extracted');
      assert.ok(e.errors.some((x) => /compilation failed/.test(x)));
      assert.ok(typeof e.lastAction === 'string' && e.lastAction.length > 0);
    });

    it('classifies a stuck pane (repeating output) as stuck', async () => {
      const line = 'Retrying connection to host in 5 seconds...';
      const result = await summarizeOne(Array(6).fill(line).join('\n'));
      assert.strictEqual(result.chats[0].state, 'stuck');
    });

    it('classifies a waiting pane (human input) as waiting', async () => {
      const result = await summarizeOne('I need your input to continue. Please respond.');
      assert.strictEqual(result.chats[0].state, 'waiting');
    });

    it('classifies a blocked pane (coordination dependency) as blocked', async () => {
      const result = await summarizeOne('Holding — blocked by the planner. Depends on the spec.');
      assert.strictEqual(result.chats[0].state, 'blocked');
    });

    it('classifies an active pane as active and reports a current step', async () => {
      const result = await summarizeOne('Building the project...\nRunning the test suite.');
      const e = result.chats[0];
      assert.strictEqual(e.state, 'active');
      assert.ok(/Building|Running/.test(e.currentStep), 'currentStep reflects the activity');
    });

    it('infers the goal from a ticket reference in the pane', async () => {
      const result = await summarizeOne('Working on WARDEN-165: structured summarize.\nRunning tests.');
      assert.strictEqual(result.chats[0].goal, 'WARDEN-165');
    });

    it('falls back to a role/project goal when no ticket or action is inferable', async () => {
      const result = await summarizeOne('all good here'); // no keywords at all → idle
      assert.strictEqual(result.chats[0].goal, 'worker on myproject');
    });

    it('includes role/state/lastAction/errors/currentStep/goal on every entry', async () => {
      const result = await summarizeOne('Error: build failed\nCompiling sources.');
      const e = result.chats[0];
      for (const f of ['role', 'state', 'lastAction', 'errors', 'currentStep', 'goal']) {
        assert.ok(f in e, `entry includes the "${f}" field`);
      }
      assert.strictEqual(e.role, 'worker');
    });
  });

  describe('bounded output (WARDEN-165 criterion #3)', () => {
    it('defaults to a concise excerpt, not the full pane dump', async () => {
      const chat = yatfaChat();
      const longPane = Array.from({ length: 60 }, (_, i) => `line ${i} of output`).join('\n');
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: longPane }));

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      const lines = result.chats[0].excerpt.split('\n');
      assert.ok(lines.length <= 15, `default excerpt is bounded to <=15 lines (got ${lines.length})`);
      assert.ok(/line 59 of output/.test(lines[lines.length - 1]), 'excerpt keeps the most recent lines');
    });

    it('honors per_agent_lines to bound the excerpt', async () => {
      const chat = yatfaChat();
      const longPane = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: longPane }));

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg, { per_agent_lines: 3 });

      const lines = result.chats[0].excerpt.split('\n');
      assert.strictEqual(lines.length, 3);
      assert.deepStrictEqual(lines, ['line 37', 'line 38', 'line 39']);
    });

    it('treats per_agent_lines <= 0 as the minimum of 1 line', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'a\nb\nc' }));

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg, { per_agent_lines: 0 });

      assert.strictEqual(result.chats[0].excerpt, 'c');
    });
  });

  describe('ANSI stripping (raw capture-pane -e → clean classification)', () => {
    it('strips escape sequences so state/excerpt read clean text', async () => {
      const chat = yatfaChat();
      // A red "Error" line wrapped in SGR codes plus a cursor-hide CSI sequence.
      const pane = '\x1b[31mError: build failed\x1b[0m\n\x1b[?25lRunning setup.\x1b[0m';
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: pane }));

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);
      const e = result.chats[0];

      assert.strictEqual(e.state, 'erroring', 'an ANSI-wrapped error still classifies');
      assert.ok(!e.excerpt.includes('\x1b'), 'the excerpt contains no escape sequences');
      assert.ok(/Error: build failed/.test(e.excerpt), 'the clean text is preserved');
      assert.ok(e.errors.some((x) => /build failed/.test(x)), 'the error is extracted from an ANSI-wrapped line');
    });

    it('does not misclassify ANSI-colored active output as erroring', async () => {
      const chat = yatfaChat();
      const pane = '\x1b[32mBuilding the project\x1b[0m\n\x1b[36mRunning tests\x1b[0m';
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: pane }));

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.strictEqual(result.chats[0].state, 'active');
    });
  });
});

describe('Observer _execTool summarize_chats dispatch', () => {
  it('returns the empty-tabs error when openTabs is empty', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = [];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('summarize_chats', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
  });

  it('returns the stale-state error when open tabs do not match any chat', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = ['ghost-tab'];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('summarize_chats', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
  });

  it('treats an unset openTabs as empty', async () => {
    const obs = new Observer(cfg, {});
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('summarize_chats', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
  });
});

describe('suggest_next_actions tool registration', () => {
  it('is registered in the TOOLS array with an object input schema', () => {
    const tool = TOOLS.find((t) => t.name === 'suggest_next_actions');
    assert.ok(tool, 'suggest_next_actions tool should be registered');
    assert.strictEqual(tool.input_schema.type, 'object');
    assert.deepStrictEqual(tool.input_schema.required, []);
  });
});

describe('Observer _execTool suggest_next_actions dispatch', () => {
  it('returns the empty-tabs error when openTabs is empty', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = [];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('suggest_next_actions', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
  });

  it('returns the stale-state error when open tabs do not match any chat', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = ['ghost-tab'];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('suggest_next_actions', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
  });

  it('treats an unset openTabs as empty', async () => {
    const obs = new Observer(cfg, {});
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('suggest_next_actions', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
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

describe('suggestNextActions (pure classifier)', () => {
  // Run classification for a single open chat with the given pane content.
  async function classify(pane, chatOverrides = {}) {
    const chat = yatfaChat(chatOverrides);
    const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: pane }));
    const result = await suggestNextActions([chat.container], [chat], capturePanes, cfg);
    return { result, capturePanes };
  }

  describe('classification of agent states', () => {
    it('classifies an erroring agent as urgent', async () => {
      const { result } = await classify(
        'Running tests...\nError: test suite failed with exit code 1\nSee traceback above.'
      );
      assert.strictEqual(result.suggestions[0].state, 'erroring');
      assert.strictEqual(result.suggestions[0].urgency, 'urgent');
      assert.strictEqual(result.summary.urgent, 1);
    });

    it('classifies a stuck agent (repeating output) as urgent', async () => {
      const line = 'Retrying connection to host in 5 seconds...';
      const pane = Array(6).fill(line).join('\n');
      const { result } = await classify(pane);
      assert.strictEqual(result.suggestions[0].state, 'stuck');
      assert.strictEqual(result.suggestions[0].urgency, 'urgent');
    });

    it('classifies a blocked agent (coordination dependency) as important', async () => {
      const { result } = await classify(
        'Cannot proceed: blocked by the planner. Depends on the design doc being finished.'
      );
      assert.strictEqual(result.suggestions[0].state, 'blocked');
      assert.strictEqual(result.suggestions[0].urgency, 'important');
    });

    it('classifies a waiting agent (human input) as important', async () => {
      const { result } = await classify(
        'I need your input to continue. Please respond with your decision, or press enter for the default.'
      );
      assert.strictEqual(result.suggestions[0].state, 'waiting');
      assert.strictEqual(result.suggestions[0].urgency, 'important');
    });

    it('classifies an active agent as informational', async () => {
      const { result } = await classify(
        'Installing dependencies...\nBuilding the project...\nRunning the test suite now.'
      );
      assert.strictEqual(result.suggestions[0].state, 'active');
      assert.strictEqual(result.suggestions[0].urgency, 'informational');
    });

    it('classifies an idle agent with minimal output as informational', async () => {
      const { result } = await classify('Ready.', { active: false });
      assert.strictEqual(result.suggestions[0].state, 'idle');
      assert.strictEqual(result.suggestions[0].urgency, 'informational');
    });
  });

  describe('waiting vs blocked (WARDEN-43 Issue 2 regression)', () => {
    it('classifies "waiting for user" as waiting, NOT blocked', async () => {
      const { result } = await classify(
        'I need your input to continue. waiting for user input'
      );
      assert.notStrictEqual(result.suggestions[0].state, 'blocked',
        '"waiting for user" must not be misclassified as blocked');
      assert.strictEqual(result.suggestions[0].state, 'waiting');
    });

    it('still classifies coordination blockers (e.g. "waiting for the planner") as blocked', async () => {
      const { result } = await classify(
        'Holding here — waiting for the planner to deliver the spec before I start.'
      );
      assert.strictEqual(result.suggestions[0].state, 'blocked');
    });
  });

  describe('urgency sort', () => {
    it('sorts suggestions urgent → important → informational', async () => {
      const worker = yatfaChat({ id: 'host1:proj-worker', key: 'proj-worker', container: 'proj-worker', role: 'worker' });
      const reviewer = yatfaChat({ id: 'host1:proj-reviewer', key: 'proj-reviewer', container: 'proj-reviewer', role: 'reviewer' });
      const planner = yatfaChat({ id: 'host1:proj-planner', key: 'proj-planner', container: 'proj-planner', role: 'planner' });

      const panes = {
        'proj-worker': 'Error: build failed',               // urgent (erroring)
        'proj-reviewer': 'Please respond with your approval.', // important (waiting)
        'proj-planner': 'Ready.',                            // informational (idle)
      };
      const capturePanes = mock.fn(async (chats) =>
        Object.fromEntries(chats.map((c) => [c.key, panes[c.key]])));

      const result = await suggestNextActions(
        ['proj-worker', 'proj-reviewer', 'proj-planner'],
        [worker, reviewer, planner],
        capturePanes,
        cfg,
      );

      assert.deepStrictEqual(result.suggestions.map((s) => s.state),
        ['erroring', 'waiting', 'idle']);
      assert.deepStrictEqual(result.suggestions.map((s) => s.urgency),
        ['urgent', 'important', 'informational']);
    });
  });

  describe('cfg forwarding (WARDEN-43 Issue 1)', () => {
    it('forwards cfg to capturePanes (previously dropped)', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'Ready.' }));
      await suggestNextActions([chat.container], [chat], capturePanes, cfg);

      assert.strictEqual(capturePanes.mock.callCount(), 1);
      assert.strictEqual(capturePanes.mock.calls[0].arguments[1], cfg,
        'capturePanes must receive cfg for parity with summarize_chats / analyze_agents');
    });
  });

  describe('guard paths', () => {
    it('returns the empty-tabs error when openTabs is empty (no capturePanes call)', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await suggestNextActions([], [yatfaChat()], capturePanes, cfg);
      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0);
    });

    it('returns the stale-state error when open tabs match no chat (no capturePanes call)', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await suggestNextActions(['ghost-tab'], [yatfaChat()], capturePanes, cfg);
      assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
      assert.strictEqual(capturePanes.mock.callCount(), 0);
    });

    it('captures capturePanes errors without throwing', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async () => { throw new Error('ssh refused'); });
      const result = await suggestNextActions([chat.container], [chat], capturePanes, cfg);
      assert.strictEqual(result.error, 'ssh refused');
    });
  });

  describe('suggestion shape', () => {
    it('populates agentId/agentName/role/project/host/state/urgency/action on each suggestion', async () => {
      const { result } = await classify('Error: something failed');
      const s = result.suggestions[0];
      assert.strictEqual(s.agentId, 'myproject-worker');
      assert.strictEqual(s.agentName, 'myproject-worker');
      assert.strictEqual(s.role, 'worker');
      assert.strictEqual(s.project, 'myproject');
      assert.strictEqual(s.host, 'host1');
      assert.strictEqual(s.state, 'erroring');
      assert.strictEqual(s.urgency, 'urgent');
      assert.ok(typeof s.action === 'string' && s.action.length > 0);
      assert.ok(typeof s.pane_excerpt === 'string');
    });
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

  it('summarize_chats watches the bound chat with no panes open (seamless resume)', async () => {
    // The bound chat is auto-included via effectiveOpenTabs, so summarize sees
    // it even though the UI has no panes open — the core resumption behavior.
    const chat = yatfaChat();
    const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'bound pane' }));
    const obs = new Observer(cfg, { chatContext: { container: chat.container, host: chat.host } });
    obs.openTabs = [];
    obs.lastChats = [chat];

    const result = await summarizeOpenChats(obs.effectiveOpenTabs(), obs.lastChats, capturePanes, cfg);

    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.chats[0].id, 'myproject-worker');
    assert.strictEqual(result.chats[0].excerpt, 'bound pane');
  });

  it('suggest_next_actions watches the bound chat with no panes open (seamless resume)', async () => {
    // Sibling to summarize_chats: the bound chat is auto-included via
    // effectiveOpenTabs, so suggest_next_actions sees it even with no panes open.
    const chat = yatfaChat();
    const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'Error: build failed' }));
    const obs = new Observer(cfg, { chatContext: { container: chat.container, host: chat.host } });
    obs.openTabs = [];
    obs.lastChats = [chat];

    const result = await suggestNextActions(obs.effectiveOpenTabs(), obs.lastChats, capturePanes, cfg);

    assert.ok(Array.isArray(result.suggestions), 'should produce suggestions, not the empty-tabs guard error');
    assert.strictEqual(result.suggestions.length, 1);
    assert.strictEqual(result.suggestions[0].agentId, 'myproject-worker');
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
