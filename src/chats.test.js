import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveChat, resolveChatWithRefresh, comparePinned, compareChats, parseDiscoverRow, parseDockerStats, splitDiscoverOutput, discover, discoverManual, discoverAll, capturePanes, DISCOVER_SCRIPT } from './chats.js';
import { applyPaneDelta, hasFreshPaneDelta, readPaneDeltas, _resetPaneDeltaStateForTests } from './companion.js';
import { buildChat, windowActivityToMs } from './chatMeta.js';

// ----------------------------- capturePanes routing -------------------------
// WARDEN-276: under WARDEN_COMPANION_TRANSPORT=1, REMOTE hosts route capture-pane
// through the companion; the LOCAL fast path must stay on runLocalTmux and NEVER
// touch the companion. The cleanest proof is end-to-end against a real local tmux
// session: if LOCAL accidentally routed to the companion, the companion refuses
// (local) hosts and the content would be missing. So a successful capture under
// the opt-in IS proof the LOCAL path bypassed the companion. Skipped without tmux.

const TMUX_BIN = 'tmux';
function tmuxAvailable() {
  const r = spawnSync(TMUX_BIN, ['-V'], { encoding: 'utf8' });
  return r.status === 0 || (r.stdout && /^tmux\s+\d/i.test(r.stdout));
}
// bash is needed to execute DISCOVER_SCRIPT against a stub `docker` in the
// WARDEN-309 graceful-stats-failure test below. Present on Linux/macOS and via
// MSYS2/git-bash on Windows; the test is skipped where absent.
const BASH_BIN = process.platform === 'win32' ? 'bash.exe' : 'bash';
function bashAvailable() {
  const r = spawnSync(BASH_BIN, ['-lc', 'echo ok'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim() === 'ok';
}
function uniqueSession() {
  return `warden-test-${process.pid}-${Math.floor(Number(process.hrtime.bigint() % 100000n))}`;
}

(tmuxAvailable() ? describe : describe.skip)('capturePanes routing (LOCAL bypasses the companion)', () => {
  let savedEnv;

  function makeLocalChat(session) {
    return { host: '(local)', id: `(local):${session}`, key: session, container: null, session };
  }

  // For these tests runLocalTmux captures from a REAL detached tmux session.
  function withSession(name, fn) {
    return async () => {
      const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', name], { encoding: 'utf8' });
      assert.strictEqual(setup.status, 0, `tmux new-session failed: ${setup.stderr}`);
      try {
        spawnSync(TMUX_BIN, ['send-keys', '-t', name, 'WARDEN_LOCAL_MARKER_7'], { encoding: 'utf8' });
        await fn();
      } finally {
        spawnSync(TMUX_BIN, ['kill-session', '-t', name], { encoding: 'utf8' });
      }
    };
  }

  it('LOCAL fast path captures via runLocalTmux even under WARDEN_COMPANION_TRANSPORT=1', async () => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    const name = uniqueSession();
    try {
      await withSession(name, async () => {
        const chat = makeLocalChat(name);
        const out = await capturePanes([chat], {});
        // The capture succeeded via the LOCAL path — proving the companion (which
        // refuses (local) hosts) was NOT consulted. Keyed by the HOST-QUALIFIED id
        // (WARDEN-1223).
        assert.ok(out[chat.id], `LOCAL pane was captured: ${JSON.stringify(Object.keys(out))}`);
        assert.ok(out[chat.id].includes('WARDEN_LOCAL_MARKER_7'),
          `captured the marker; got:\n${out[chat.id]}`);
      })();
    } finally {
      if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
      else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    }
  });

  it('default path (no env var) is unchanged: LOCAL captures identically', async () => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    const name = uniqueSession();
    try {
      await withSession(name, async () => {
        const chat = makeLocalChat(name);
        const out = await capturePanes([chat], {});
        assert.ok(out[chat.id], 'default LOCAL capture works');
        assert.ok(out[chat.id].includes('WARDEN_LOCAL_MARKER_7'));
      })();
    } finally {
      if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
      else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    }
  });

  // WARDEN-440: the 2s pane monitor funnels every open LOCAL pane through
  // capturePanes' LOCAL branch. The previous implementation ran a SYNCHRONOUS
  // `for` loop of spawnSync capture-panes, holding the event loop for N × spawn
  // cost per tick. This test exercises the refactored CONCURRENT async path
  // (Promise.all of async runLocalTmux) against several real local panes and
  // asserts EVERY pane's content is captured — the failure mode a naive
  // concurrent rewrite hits (race drops all but the last pane, or only one key).
  it('LOCAL path captures MANY panes concurrently — every pane keyed, no drops (WARDEN-440)', async () => {
    const names = [uniqueSession(), uniqueSession(), uniqueSession()];
    // Set up three real detached sessions, each with its own marker.
    for (const n of names) {
      const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', n], { encoding: 'utf8' });
      assert.strictEqual(setup.status, 0, `tmux new-session failed for ${n}: ${setup.stderr}`);
      spawnSync(TMUX_BIN, ['send-keys', '-t', n, `MARK_${n}`], { encoding: 'utf8' });
    }
    try {
      const chats = names.map(makeLocalChat);
      const out = await capturePanes(chats, {});
      // Every pane must be present and carry its own marker — proving the
      // concurrent fan-out populated each key, not just one. Keys are the
      // HOST-QUALIFIED ids (WARDEN-1223).
      for (const c of chats) {
        assert.ok(out[c.id], `pane ${c.id} was captured (got keys: ${JSON.stringify(Object.keys(out))})`);
        assert.ok(out[c.id].includes(`MARK_${c.key}`), `pane ${c.id} carries its own marker; got:\n${out[c.id]}`);
      }
    } finally {
      for (const n of names) spawnSync(TMUX_BIN, ['kill-session', '-t', n], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
    }
  });
});

// --------------------- capturePanes renders from pushed deltas (WARDEN-413) ---
// The success gate: a companion-enabled REMOTE host with a live subscription
// delivering fresh deltas is rendered from the in-memory delta cache and the
// capturePanes RPC is SKIPPED — an idle host receives ZERO capturePanes RPCs per
// monitor tick. Proving the cached content comes back is proof the RPC path was
// never taken: the only other route (capturePanesViaCompanion) would bootstrap a
// real SSH channel and fail/empty — never return the seeded content. No network.

describe('capturePanes renders companion hosts from the pushed delta cache (WARDEN-413)', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    _resetPaneDeltaStateForTests();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    _resetPaneDeltaStateForTests();
  });

  it('a fresh subscription -> capturePanes returns the cached deltas and issues NO RPC', async () => {
    // Seed a fresh paneDelta for a REMOTE companion host (the push path).
    applyPaneDelta('prod', { event: 'paneDelta', panes: { 'p-worker': 'IDLE PANE CONTENT' } });
    assert.ok(hasFreshPaneDelta('prod'), 'precondition: host has a fresh delta');

    const out = await capturePanes([{ host: 'prod', id: 'prod:p-worker', key: 'p-worker', container: 'p-worker', session: 'agent' }], {});

    // The cached content came back — proving capturePanes read the cache and never
    // called capturePanesViaCompanion (which would have hit a real channel). The
    // map is keyed by the HOST-QUALIFIED id (WARDEN-1223).
    assert.deepStrictEqual(out, { 'prod:p-worker': 'IDLE PANE CONTENT' });
    // And the cache is unchanged (read is non-destructive).
    assert.deepStrictEqual(readPaneDeltas('prod', ['p-worker']), { 'p-worker': 'IDLE PANE CONTENT' });
  });

  it('only the requested keys are returned; a key absent from the cache stays missing', async () => {
    applyPaneDelta('prod', { event: 'paneDelta', panes: { a: 'AAA' } }); // b never pushed
    const out = await capturePanes([
      { host: 'prod', id: 'prod:a', key: 'a', container: 'a', session: 'agent' },
      { host: 'prod', id: 'prod:b', key: 'b', container: 'b', session: 'agent' },
    ], {});
    assert.deepStrictEqual(out, { 'prod:a': 'AAA' }, 'b is missing (cache miss) -> caller capture_failed handling, unchanged');
  });

  it('WARDEN-1223: two hosts running a SAME-NAMED session each get their own capture slot', async () => {
    // The defect: the flat capture map was keyed on the bare session name, so
    // hostA's pane overwrote hostB's and a capture failure on one host was
    // masked by the other. With host-qualified keying both slots coexist.
    applyPaneDelta('hostA', { event: 'paneDelta', panes: { 'same-name': 'HOST_A TERMINAL' } });
    applyPaneDelta('hostB', { event: 'paneDelta', panes: { 'same-name': 'HOST_B TERMINAL' } });
    assert.ok(hasFreshPaneDelta('hostA') && hasFreshPaneDelta('hostB'), 'precondition: both hosts fresh');

    const chats = [
      { host: 'hostA', id: 'hostA:same-name', key: 'same-name', container: 'same-name', session: 'agent' },
      { host: 'hostB', id: 'hostB:same-name', key: 'same-name', container: 'same-name', session: 'agent' },
    ];
    const out = await capturePanes(chats, {});
    assert.deepStrictEqual(out, {
      'hostA:same-name': 'HOST_A TERMINAL',
      'hostB:same-name': 'HOST_B TERMINAL',
    }, 'each host-qualified slot carries its OWN terminal output');

    // A capture failure on a host (no key in its host-local result) does not
    // borrow the sibling host's entry: the slot is simply missing → capture_failed.
    const onlyGhost = await capturePanes([{ host: 'hostB', id: 'hostB:ghost', key: 'ghost', container: 'ghost', session: 'agent' }], {});
    assert.deepStrictEqual(onlyGhost, {}, 'a host with no captured pane yields a MISSING slot, never the sibling host\'s content');
  });

  it('a host with NO fresh delta is not read from the cache (would poll instead)', async () => {
    // No delta seeded for 'prod' -> hasFreshPaneDelta is false, so capturePanes
    // must NOT serve the cache. The cache read returns nothing.
    assert.ok(!hasFreshPaneDelta('prod'));
    assert.deepStrictEqual(readPaneDeltas('prod', ['p-worker']), {});
  });
});

describe('resolveChat', () => {
  const mockChats = [
    { id: 'host1:myproject-worker', key: 'myproject-worker', container: 'myproject-worker', session: 'agent', project: 'myproject', role: 'worker' },
    { id: 'host1:myproject-researcher', key: 'myproject-researcher', container: 'myproject-researcher', session: 'agent', project: 'myproject', role: 'researcher' },
    { id: 'host2:other-project', key: 'other-project', container: 'other-project', session: 'agent', project: 'other', role: 'planner' },
    { id: 'local:manual-session', key: 'manual-session', container: null, session: 'manual-session', project: 'local', role: 'claude' },
  ];

  describe('exact matches (highest priority)', () => {
    it('should match by exact id', () => {
      const result = resolveChat('host1:myproject-worker', mockChats, null);
      assert.ok(result.chat, 'Should find chat by exact id');
      assert.strictEqual(result.chat.id, 'host1:myproject-worker');
      assert.strictEqual(result.chat.role, 'worker');
    });

    it('should match by exact key', () => {
      const result = resolveChat('myproject-worker', mockChats, null);
      assert.ok(result.chat, 'Should find chat by exact key');
      assert.strictEqual(result.chat.key, 'myproject-worker');
      assert.strictEqual(result.chat.role, 'worker');
    });

    it('should match by exact container', () => {
      const result = resolveChat('myproject-worker', mockChats, null);
      assert.ok(result.chat, 'Should find chat by exact container');
      assert.strictEqual(result.chat.container, 'myproject-worker');
    });

    it('should match by exact session', () => {
      const result = resolveChat('manual-session', mockChats, null);
      assert.ok(result.chat, 'Should find chat by exact session');
      assert.strictEqual(result.chat.session, 'manual-session');
      assert.strictEqual(result.chat.project, 'local');
    });
  });

  describe('substring matches (lower priority)', () => {
    it('should match by role equality', () => {
      const result = resolveChat('worker', mockChats, null);
      assert.ok(result.chat, 'Should find chat by role equality');
      assert.strictEqual(result.chat.role, 'worker');
      assert.strictEqual(result.chat.project, 'myproject');
    });

    it('should match by suffix (id.endsWith(\':\' + id))', () => {
      const result = resolveChat('worker', mockChats, null);
      assert.ok(result.chat, 'Should find chat by suffix match');
      assert.strictEqual(result.chat.role, 'worker');
    });

    it('should match by container substring (unique)', () => {
      const result = resolveChat('other-project', mockChats, null);
      assert.ok(result.chat, 'Should find chat by container substring');
      assert.ok(result.chat.container.includes('other-project'));
    });

    it('should return error for ambiguous container substring', () => {
      const result = resolveChat('myproject', mockChats, null);
      assert.ok(result.error, 'Should return error for ambiguous container substring');
      assert.ok(result.error.includes('ambiguous'), 'Error should mention ambiguity');
    });

    it('should match by session substring', () => {
      const result = resolveChat('manual', mockChats, null);
      assert.ok(result.chat, 'Should find chat by session substring');
      assert.ok(result.chat.session.includes('manual'));
    });

    it('should match by id substring', () => {
      const result = resolveChat('host2', mockChats, null);
      assert.ok(result.chat, 'Should find chat by id substring');
      assert.ok(result.chat.id.includes('host2'));
    });

    it('should return error for ambiguous project equality', () => {
      const result = resolveChat('myproject', mockChats, null);
      assert.ok(result.error, 'Should return error for ambiguous project match');
      assert.ok(result.error.includes('ambiguous'), 'Error should mention ambiguity');
    });

    it('should match by unique project', () => {
      const result = resolveChat('other', mockChats, null);
      assert.ok(result.chat, 'Should find chat by unique project');
      assert.strictEqual(result.chat.project, 'other');
    });

    it('should match by role equality', () => {
      const result = resolveChat('researcher', mockChats, null);
      assert.ok(result.chat, 'Should find chat by role');
      assert.strictEqual(result.chat.role, 'researcher');
    });
  });

  describe('exact-first priority behavior', () => {
    it('should prioritize exact match over substring/project match', () => {
      const chats = [
        { id: 'host:myproject', key: 'myproject', container: 'myproject', session: 'agent', project: 'other', role: 'worker' },
        { id: 'host:other-project', key: 'other-project', container: 'other-project', session: 'agent', project: 'myproject', role: 'worker' },
      ];

      // Search for "myproject" - there's an exact match (id='host:myproject')
      // AND a project match (project='myproject' on other chat)
      const result = resolveChat('myproject', chats, null);

      // Should find exact match, not fail with ambiguity
      assert.ok(result.chat, 'Should prioritize exact match over project match');
      assert.strictEqual(result.chat.id, 'host:myproject');
      assert.strictEqual(result.chat.key, 'myproject');
    });

    it('should return error for multiple exact matches', () => {
      const chats = [
        { id: 'host1:myproject', key: 'myproject', container: 'myproject', session: 'agent', project: 'p1', role: 'worker' },
        { id: 'host2:myproject', key: 'myproject', container: 'myproject', session: 'agent', project: 'p2', role: 'worker' },
      ];

      const result = resolveChat('myproject', chats, null);
      assert.ok(result.error, 'Should return error for ambiguous exact matches');
      assert.ok(result.error.includes('ambiguous'), 'Error should mention ambiguity');
      assert.ok(result.error.includes('myproject'), 'Error should include the matched ids');
    });

    it('should return error for multiple substring matches', () => {
      const result = resolveChat('project', mockChats, null);
      assert.ok(result.error, 'Should return error for ambiguous substring matches');
      assert.ok(result.error.includes('ambiguous'), 'Error should mention ambiguity');
    });
  });

  describe('edge cases', () => {
    it('should return needsRefresh when no matches found', () => {
      const result = resolveChat('nonexistent', mockChats, null);
      assert.ok(result.needsRefresh, 'Should signal refresh needed when no matches');
      assert.strictEqual(result.chat, undefined);
      assert.strictEqual(result.error, undefined);
    });

    it('should handle empty chat list', () => {
      const result = resolveChat('anything', [], null);
      assert.ok(result.needsRefresh, 'Should signal refresh needed for empty list');
    });

    it('should handle null/undefined fields gracefully', () => {
      const chatsWithNulls = [
        { id: 'host:chat1', key: 'chat1', container: null, session: null, project: 'p1', role: 'worker' },
        { id: 'host:chat2', key: 'chat2', container: 'chat2', session: 'agent', project: 'p2', role: 'worker' },
      ];

      // Should still match by exact key even with null container/session
      const result = resolveChat('chat1', chatsWithNulls, null);
      assert.ok(result.chat, 'Should handle null fields');
      assert.strictEqual(result.chat.key, 'chat1');
    });
  });
});

describe('resolveChatWithRefresh', () => {
  describe('refresh behavior', () => {
    it('should return cached result without refresh when match found', async () => {
      const mockChats = [
        { id: 'host:myproject', key: 'myproject', container: 'myproject', session: 'agent', project: 'p1', role: 'worker' },
      ];

      const refreshFn = mock.fn(async () => ({ chats: [], errors: [] }));

      const result = await resolveChatWithRefresh('myproject', mockChats, refreshFn);

      assert.ok(result.chat, 'Should find chat in cache');
      assert.strictEqual(result.chat.id, 'host:myproject');
      assert.strictEqual(refreshFn.mock.callCount(), 0, 'Should not call refresh when cache hit');
    });

    it('should call refreshFn when no match in cache', async () => {
      const mockChats = [
        { id: 'host:existing', key: 'existing', container: 'existing', session: 'agent', project: 'p1', role: 'worker' },
      ];

      const refreshedChats = [
        { id: 'host:new-chat', key: 'new-chat', container: 'new-chat', session: 'agent', project: 'p2', role: 'worker' },
      ];

      const refreshFn = mock.fn(async () => ({
        chats: refreshedChats,
        errors: []
      }));

      const result = await resolveChatWithRefresh('new-chat', mockChats, refreshFn);

      assert.strictEqual(refreshFn.mock.callCount(), 1, 'Should call refresh when cache miss');
      assert.ok(result.chat, 'Should find chat after refresh');
      assert.strictEqual(result.chat.id, 'host:new-chat');
    });

    it('should pass through refresh errors', async () => {
      const mockChats = [];
      const refreshErrors = [{ host: 'host1', error: 'Connection timeout' }];

      const refreshFn = mock.fn(async () => ({
        chats: [],
        errors: refreshErrors
      }));

      const result = await resolveChatWithRefresh('nonexistent', mockChats, refreshFn);

      assert.ok(result.error, 'Should return error when no match after refresh');
      assert.ok(result.error.includes('no chat matches'), 'Error should mention no matches');
      assert.deepStrictEqual(result.errors, refreshErrors, 'Should include refresh errors');
    });

    it('should apply full matching logic after refresh', async () => {
      const mockChats = [];

      // Simulate refresh returning multiple chats
      const refreshedChats = [
        { id: 'host1:myproject-worker', key: 'myproject-worker', container: 'myproject-worker', session: 'agent', project: 'myproject', role: 'worker' },
        { id: 'host1:myproject-researcher', key: 'myproject-researcher', container: 'myproject-researcher', session: 'agent', project: 'myproject', role: 'researcher' },
      ];

      const refreshFn = mock.fn(async () => ({
        chats: refreshedChats,
        errors: []
      }));

      // Test exact match after refresh
      const result = await resolveChatWithRefresh('myproject-worker', mockChats, refreshFn);

      assert.ok(result.chat, 'Should find exact match after refresh');
      assert.strictEqual(result.chat.role, 'worker');
    });

    it('should return ambiguous error after refresh if multiple matches', async () => {
      const mockChats = [];

      const refreshedChats = [
        { id: 'host1:chat', key: 'chat', container: 'chat', session: 'agent', project: 'p1', role: 'worker' },
        { id: 'host2:chat', key: 'chat', container: 'chat', session: 'agent', project: 'p2', role: 'worker' },
      ];

      const refreshFn = mock.fn(async () => ({
        chats: refreshedChats,
        errors: []
      }));

      const result = await resolveChatWithRefresh('chat', mockChats, refreshFn);

      assert.ok(result.error, 'Should return ambiguous error after refresh');
      assert.ok(result.error.includes('ambiguous'), 'Error should mention ambiguity');
    });
  });

  describe('exact-first priority with refresh', () => {
    it('should prioritize exact match over substring after refresh', async () => {
      const mockChats = [];

      // After refresh, we have both exact and project matches
      const refreshedChats = [
        { id: 'host:myproject', key: 'myproject', container: 'myproject', session: 'agent', project: 'other', role: 'worker' },
        { id: 'host:other-project', key: 'other-project', container: 'other-project', session: 'agent', project: 'myproject', role: 'worker' },
      ];

      const refreshFn = mock.fn(async () => ({
        chats: refreshedChats,
        errors: []
      }));

      const result = await resolveChatWithRefresh('myproject', mockChats, refreshFn);

      // Should find exact match, not fail with ambiguity
      assert.ok(result.chat, 'Should prioritize exact match after refresh');
      assert.strictEqual(result.chat.id, 'host:myproject');
      assert.strictEqual(result.chat.key, 'myproject');
    });
  });
});

describe('comparePinned (pin-first sort)', () => {
  // Two chats: `aaa` sorts before `zzz` by name. `key` is the bare session name;
  // `id` is the host-prefixed contract that the backend sort + config use.
  const aaa = { id: '(local):aaa-agent', key: 'aaa-agent', active: false };
  const zzz = { id: '(local):zzz-agent', key: 'zzz-agent', active: false };
  // The REAL production comparator every discovery sort uses (WARDEN-1120) —
  // not a hand-reconstruction of it. These fixtures are all `active: false`, so
  // compareChats' active tiebreak is inert here and id order is what's exercised.
  const sortById = (chats, pinSet) =>
    [...chats].sort((a, b) => compareChats(a, b, pinSet));

  it('sorts a pinned id above a non-pinned one regardless of name', () => {
    // zzz sorts last by name; pinning its id surfaces it to the top.
    const pins = new Set(['(local):zzz-agent']);
    const sorted = sortById([aaa, zzz], pins);
    assert.strictEqual(sorted[0].id, '(local):zzz-agent');
    assert.strictEqual(sorted[1].id, '(local):aaa-agent');
  });

  it('returns 0 when neither chat is pinned', () => {
    assert.strictEqual(comparePinned(aaa, zzz, new Set()), 0);
  });

  it('returns 0 when both chats are pinned', () => {
    assert.strictEqual(
      comparePinned(aaa, zzz, new Set(['(local):aaa-agent', '(local):zzz-agent'])),
      0,
    );
  });

  it('returns negative when only the first chat is pinned', () => {
    assert.ok(comparePinned(aaa, zzz, new Set(['(local):aaa-agent'])) < 0);
  });

  it('does NOT match on the bare key/session name (host-prefixed id is the contract)', () => {
    // Regression: the frontend previously saved the bare `c.key` ("zzz-agent")
    // instead of the host-prefixed `c.id`. The backend ignores bare names, so a
    // bare-key pin must NOT surface zzz above aaa. This case would have stayed
    // green while the feature was silently broken, so it pins the seam down.
    const bareKeyPins = new Set(['zzz-agent']);
    assert.strictEqual(comparePinned(aaa, zzz, bareKeyPins), 0);
    const sorted = sortById([aaa, zzz], bareKeyPins);
    assert.strictEqual(sorted[0].id, '(local):aaa-agent', 'bare key pin must not reorder');
  });

  it('does not collide bare session names across hosts', () => {
    // Two hosts each run a session named "agent". A bare-key pin would match
    // both; the id contract matches exactly one (host-prefixed).
    const localAgent = { id: '(local):agent', key: 'agent', active: false };
    const remoteAgent = { id: 'remote:agent', key: 'agent', active: false };
    const pins = new Set(['remote:agent']);
    assert.ok(comparePinned(localAgent, remoteAgent, pins) > 0, 'remote pinned sorts first');
    assert.ok(comparePinned(remoteAgent, localAgent, pins) < 0);
  });
});

// compareChats is the COMPOSED discovery order — pin, then active-desc, then id
// — that used to be hand-copied at all three `.sort(` sites in chats.js
// (discoverAll, catalogChats, discoverHost). Only the pin half was under test
// before WARDEN-1120: the active tiebreak lived inside inline comparator bodies
// in two functions the spec file never imports, so nothing pinned it. These
// cases pin the composition itself.
describe('compareChats (composed pin → active → id order)', () => {
  const pinnedIdle = { id: '(local):zzz-agent', key: 'zzz-agent', active: false };
  const unpinnedLive = { id: '(local):aaa-agent', key: 'aaa-agent', active: true };
  const sorted = (chats, pinSet = new Set()) => [...chats].sort((a, b) => compareChats(a, b, pinSet));

  it('sorts a pinned idle chat above an unpinned ACTIVE one (pin outranks active)', () => {
    // Pin loses to nothing: zzz is idle AND sorts last by id, but the pin wins.
    const pins = new Set(['(local):zzz-agent']);
    assert.ok(compareChats(pinnedIdle, unpinnedLive, pins) < 0);
    assert.deepStrictEqual(
      sorted([unpinnedLive, pinnedIdle], pins).map((c) => c.id),
      ['(local):zzz-agent', '(local):aaa-agent'],
    );
  });

  it('sorts an active chat above an idle one whose id sorts earlier (active outranks name)', () => {
    // With neither pinned, active zzz must beat idle aaa despite losing on id.
    const idleAaa = { id: '(local):aaa-agent', key: 'aaa-agent', active: false };
    const liveZzz = { id: '(local):zzz-agent', key: 'zzz-agent', active: true };
    assert.ok(compareChats(liveZzz, idleAaa, new Set()) < 0);
    assert.deepStrictEqual(
      sorted([idleAaa, liveZzz]).map((c) => c.id),
      ['(local):zzz-agent', '(local):aaa-agent'],
    );
  });

  it('treats a null active (undiscovered, as catalogChats builds every row) as inactive', () => {
    // catalogChats hardcodes active: null. null must read as inactive — sorting
    // below a live chat, and tying with an explicitly-idle one so id decides.
    const undiscovered = { id: '(local):aaa-agent', key: 'aaa-agent', active: null };
    const live = { id: '(local):zzz-agent', key: 'zzz-agent', active: true };
    assert.ok(compareChats(undiscovered, live, new Set()) > 0, 'null active sorts below active');
    const idle = { id: '(local):bbb-agent', key: 'bbb-agent', active: false };
    assert.strictEqual(
      compareChats(undiscovered, idle, new Set()),
      '(local):aaa-agent'.localeCompare('(local):bbb-agent'),
      'null and false tie on active, so id decides',
    );
  });

  it('falls back to the host-prefixed id when pin and active status both tie', () => {
    const a = { id: '(local):aaa-agent', key: 'aaa-agent', active: true };
    const b = { id: 'remote:aaa-agent', key: 'aaa-agent', active: true };
    // Same bare key, both active, neither pinned: only the host-prefixed id separates them.
    assert.ok(compareChats(a, b, new Set()) < 0);
    assert.ok(compareChats(b, a, new Set()) > 0);
    assert.strictEqual(compareChats(a, { ...a }, new Set()), 0, 'identical ids tie at 0');
  });
});

// parseDiscoverRow parses one TSV row from DISCOVER_SCRIPT (WARDEN-235). Discovery
// runs `docker ps` + per-container `docker exec` over SSH, which CI can't do, so
// the row parser is the unit-testable seam for the new `cwd` column. The layout
// is  name \t status \t cwd \t active  (cwd second-to-last, active last); a legacy
// 3-column row (pre-cwd) must still parse with cwd ''.
describe('parseDiscoverRow', () => {
  it('parses a 4-column row: name, status, cwd, active', () => {
    // active yatfa agent whose pane sits in /workspace
    assert.deepStrictEqual(parseDiscoverRow('myproject-worker\tUp 2 hours\t/workspace\t1'), {
      name: 'myproject-worker', status: 'Up 2 hours', cwd: '/workspace', active: true,
    });
  });

  it('reads active=FALSE when the trailing flag is 0', () => {
    const row = parseDiscoverRow('proj-researcher\tUp 5 min\t/app\t0');
    assert.strictEqual(row.active, false);
  });

  it('reads cwd as the second-to-last column (active stays last)', () => {
    // An idle container whose WorkingDir fallback was /app — cwd must NOT be
    // confused with the active flag.
    const row = parseDiscoverRow('c\tUp\t/app\t0');
    assert.strictEqual(row.cwd, '/app');
    assert.strictEqual(row.active, false);
  });

  it('preserves a status containing spaces', () => {
    const row = parseDiscoverRow('c\tUp 3 hours (healthy)\t/w\t1');
    assert.strictEqual(row.status, 'Up 3 hours (healthy)');
  });

  it('rejoins a status that itself contains a tab (WARDEN-1340 layout: name, 2-part status, cwd, activity, active)', () => {
    // Defensive: if docker's Status field ever embeds a tab, the middle columns
    // between name and the cwd/activity tail are the status (rejoined), not split
    // into cwd/activity. (Fixture updated from the pre-WARDEN-1340 4-field shape:
    // the row now also carries the window_activity column, so a 2-part status
    // makes the row 6 parts, and the tail anchor is cwd/activity/active.)
    const row = parseDiscoverRow('c\tUp\tand\t/w\t1789088272\t1');
    assert.strictEqual(row.status, 'Up\tand');
    assert.strictEqual(row.cwd, '/w');
    assert.strictEqual(row.activitySecs, 1789088272);
    assert.strictEqual(row.active, true);
  });

  it('tolerates an empty cwd (derivation failed) without dropping the row', () => {
    // Neither pane path nor WorkingDir resolved → cwd '' → discover() sets
    // chat.cwd undefined (the git routes then treat it as "no cwd" rather than
    // falling back to Warden's own repo). The row is still a valid chat.
    const row = parseDiscoverRow('c\tUp\t\t1');
    assert.strictEqual(row.cwd, '');
    assert.strictEqual(row.active, true);
  });

  it('parses a legacy 3-column row (pre-cwd) with cwd ""', () => {
    // Backward compat: an older discover script emitting name/status/active must
    // not break — cwd reads as '' and the chat still resolves.
    assert.deepStrictEqual(parseDiscoverRow('c\tUp 1 hour\t1'), {
      name: 'c', status: 'Up 1 hour', cwd: '', active: true,
    });
  });

  // WARDEN-1340: the per-container display-message was widened to also yield
  // tmux's #{window_activity} (epoch SECONDS of the window's last OUTPUT), so a
  // live agent's row is 5 columns. The activity column sits second-to-last —
  // between cwd and active — so `active` remains the LAST column and every
  // existing tail-position parse above is unchanged.
  it('parses a 5-column row: name, status, cwd, window_activity, active (WARDEN-1340)', () => {
    assert.deepStrictEqual(
      parseDiscoverRow('myproject-worker\tUp 2 hours\t/workspace\t1789088272\t1'),
      { name: 'myproject-worker', status: 'Up 2 hours', cwd: '/workspace', activitySecs: 1789088272, active: true },
    );
  });

  it('reads activitySecs=null for a 5-column row with an empty/garbage/non-positive activity column', () => {
    // display-message failed or tmux predated window_activity → empty column;
    // parseDiscoverRow degrades to null (lastActivity stays null downstream),
    // never to a bogus value.
    assert.strictEqual(parseDiscoverRow('c\tUp\t/w\t\t1').activitySecs, null);
    assert.strictEqual(parseDiscoverRow('c\tUp\t/w\tgarbage\t1').activitySecs, null);
    assert.strictEqual(parseDiscoverRow('c\tUp\t/w\t0\t1').activitySecs, null);
    assert.strictEqual(parseDiscoverRow('c\tUp\t/w\t-5\t1').activitySecs, null);
  });

  it('5-column row with an empty cwd AND empty activity still parses (active stays last)', () => {
    // Defensive tolerance: a 5-column row whose cwd and activity columns are
    // both empty (only reachable via corner cases — e.g. a pane path that itself
    // contains a tab shifts the column count) must still parse rather than drop
    // the row or misread `active`, which stays pinned to the LAST column.
    const row = parseDiscoverRow('c\tUp 5 min\t\t\t0');
    assert.strictEqual(row.name, 'c');
    assert.strictEqual(row.cwd, '');
    assert.strictEqual(row.activitySecs, null);
    assert.strictEqual(row.active, false);
  });

  it('returns null for blank / too-short / malformed rows', () => {
    assert.strictEqual(parseDiscoverRow(''), null);
    assert.strictEqual(parseDiscoverRow('   '), null);
    assert.strictEqual(parseDiscoverRow(null), null);
    assert.strictEqual(parseDiscoverRow(undefined), null);
    assert.strictEqual(parseDiscoverRow('only-name'), null);            // 1 column
    assert.strictEqual(parseDiscoverRow('a\tb'), null);                 // 2 columns
  });
});

// The guard at the top of discover() — `if (host !== LOCAL && isEnabled()) return
// discoverViaCompanion(...)` — is the one line that decides default SSH path vs
// companion transport. It is the highest-leverage seam in the slice and was
// previously untested: a refactor that inverted/dropped it would have stayed
// green. discover() takes an injectable deps seam (isCompanionTransportEnabled /
// discoverViaCompanion / runWithPool) precisely so this wiring can be asserted
// without real ssh. (WARDEN-272 review #3.)
describe('discover() companion routing guard (WARDEN-272)', () => {
  it('delegates to the companion for a REMOTE host when the opt-in is on', async () => {
    let companionCalls = 0;
    let runWithPoolCalls = 0;
    const res = await discover('prod', {}, {}, {
      isCompanionTransportEnabled: () => true,
      discoverViaCompanion: async (host) => {
        companionCalls++;
        return { host, ok: true, chats: [{ key: 'companion-side' }] };
      },
      runWithPool: async () => { runWithPoolCalls++; return { ok: true, stdout: '' }; },
    });
    assert.strictEqual(companionCalls, 1, 'delegated to the companion exactly once');
    assert.strictEqual(runWithPoolCalls, 0, 'must NOT fall through to the default runWithPool path');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.chats[0].key, 'companion-side', 'returned the companion result');
  });

  it('does NOT delegate when the opt-in is off — the default runWithPool path runs', async () => {
    let companionCalls = 0;
    let runWithPoolCalls = 0;
    const res = await discover('prod', {}, {}, {
      isCompanionTransportEnabled: () => false,
      discoverViaCompanion: async () => { companionCalls++; return { ok: true, chats: [] }; },
      runWithPool: async () => { runWithPoolCalls++; return { ok: true, stdout: '' }; },
    });
    assert.strictEqual(companionCalls, 0, 'companion must not run without the opt-in');
    assert.strictEqual(runWithPoolCalls, 1, 'default SSH path ran');
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.chats, []);
  });

  it('does NOT delegate the (local) host even when the opt-in is on', async () => {
    // The companion serves remote hosts only: a (local) host must always take the
    // default path regardless of the env var (bootstrapping over ssh-to-self is
    // nonsensical). The `host !== LOCAL` half of the guard is what prevents it.
    let companionCalls = 0;
    let runWithPoolCalls = 0;
    await discover('(local)', {}, {}, {
      isCompanionTransportEnabled: () => true,
      discoverViaCompanion: async () => { companionCalls++; return { ok: true, chats: [] }; },
      runWithPool: async () => { runWithPoolCalls++; return { ok: true, stdout: '' }; },
    });
    assert.strictEqual(companionCalls, 0, 'never delegate the local host to the companion');
    assert.strictEqual(runWithPoolCalls, 1, 'local host uses the default path');
  });

  it('forwards host, cfg, and opts to the companion delegate', async () => {
    let seen = null;
    await discover('prod', { tmuxSession: 'custom', connectTimeout: 7 }, { activity: false }, {
      isCompanionTransportEnabled: () => true,
      discoverViaCompanion: async (host, cfg, opts) => { seen = { host, cfg, opts }; return { ok: true, chats: [] }; },
      runWithPool: async () => ({ ok: true, stdout: '' }),
    });
    assert.strictEqual(seen.host, 'prod');
    assert.strictEqual(seen.cfg.tmuxSession, 'custom');
    assert.strictEqual(seen.opts.activity, false, 'opts pass through to the companion');
  });
});

// The default SSH discover path was refactored to build chats via the shared
// buildChat() (WARDEN-272 review #5) instead of its inline literal. This proves
// that refactor is behavior-preserving: real DISCOVER_SCRIPT TSV output still
// parses into the documented chat shape, byte-for-byte. (The default path must
// remain unchanged — WARDEN-272 AC.)
describe('discover() default path builds chats via buildChat (refactor is a no-op)', () => {
  it('parses DISCOVER_SCRIPT rows into the shared chat shape, sorted active-first', async () => {
    const stdout = [
      'myproject-worker\tUp 2 hours\t/work/myproject\t1',
      'myproject-researcher\tUp 5 min\t/work/x\t0',
    ].join('\n');
    let runWithPoolCalls = 0;
    const res = await discover('prod', { connectTimeout: 10 }, { activity: false }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => { runWithPoolCalls++; return { ok: true, stdout }; },
    });
    assert.strictEqual(runWithPoolCalls, 1, 'default path ran runWithPool once');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.chats.length, 2);
    // active worker sorts first; shape identical to the shared buildChat().
    assert.deepStrictEqual(
      res.chats[0],
      buildChat('prod', 'myproject-worker', 'Up 2 hours', '/work/myproject', true, 'agent'),
    );
    assert.strictEqual(res.chats[1].key, 'myproject-researcher');
    assert.strictEqual(res.chats[1].active, false);
    assert.strictEqual(res.chats[1].cwd, '/work/x');
    assert.strictEqual(res.chats[1].isAgent, true);
  });

  it('propagates runWithPool failure as {ok:false} (default error contract intact)', async () => {
    const res = await discover('prod', {}, { activity: false }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.chats.length, 0);
    assert.ok(res.error.includes('Permission denied'));
  });
});

// WARDEN-1340: the default SSH discover path derives lastActivity from the
// discover row's #{window_activity} column — tmux's own epoch-SECONDS record of
// the window's last OUTPUT, read in the SAME per-container display-message that
// already produced cwd (zero extra round-trips). The previous mechanism — a
// second pass running `capture-pane -S - -E - | head -1` per active agent, then
// parseActivityTimestamp on the FIRST line — read the OLDEST line of the
// scrollback: a frozen clock that decayed continuously-working agents to
// CRITICAL, a ring-buffer eviction edge once history-limit was hit, and usually
// a bare shell prompt (silent null → UNKNOWN). These tests pin the new
// mechanism. The raw `run` seam stays injectable so the tests can prove the
// capture pass is GONE (runCalls === 0) — reverting the production change turns
// the mutation-check test below RED.
describe('discover() derives lastActivity from the discover row (WARDEN-1340)', () => {
  // A plausible window_activity reading (epoch seconds — what tmux itself emits;
  // ×1000 → ms is the lastActivity contract).
  const FRESH_SECS = 1789088272;
  const FRESH_MS = FRESH_SECS * 1000;

  it('populates lastActivity from the row window_activity column (×1000 → ms) with NO capture round-trip', async () => {
    const stdout = `myproject-worker\tUp 2 hours\t/work/myproject\t${FRESH_SECS}\t1`; // one active agent, live activity
    let runCalls = 0;
    const res = await discover('prod', { connectTimeout: 10 }, { /* activity flag irrelevant now */ }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
      run: async () => { runCalls++; return { ok: true, stdout: '' }; },
    });
    assert.strictEqual(runCalls, 0,
      'no per-agent run may fire — the row already carries the value from the SAME ssh round-trip');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.chats.length, 1);
    assert.strictEqual(res.chats[0].lastActivity, FRESH_MS,
      'epoch seconds × 1000 — raw seconds would read as ~1970 and poison stampCatalogActivity');
  });

  it('MUTATION CHECK — multi-line pane fixture: lastActivity follows the NEWEST signal, never the oldest scrollback line', async () => {
    // The load-bearing fixture. The OLD code captured the full scrollback
    // (`capture-pane -S - -E -`) and took its FIRST line (head -1, or the first
    // unanchored regex match on the full capture) — on a long-lived pane line 1
    // is pinned near session start, so this is what the old path would have
    // consumed: first line 2020, last line fresh. The new code must NEVER call
    // run() and must rest lastActivity on the row's window_activity. Reverting
    // the production change turns this test RED twice over: runCalls > 0 and
    // lastActivity would become 1577836801000 (the 2020 line) instead of FRESH_MS.
    const OLD_PANE = [
      '[2020-01-01 00:00:01] session banner — pinned here since the pane was created',
      '... thousands of lines of scrollback the old capture would haul across ...',
      '[2026-09-11 00:40:00] worker: latest output — what health SHOULD see',
    ].join('\n');
    const stdout = `myproject-worker\tUp 2 hours\t/work/myproject\t${FRESH_SECS}\t1`;
    let runCalls = 0;
    const res = await discover('prod', {}, {}, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
      run: async () => { runCalls++; return { ok: true, stdout: OLD_PANE }; },
    });
    assert.strictEqual(runCalls, 0, 'the scrollback capture must be GONE from the activity path');
    assert.strictEqual(res.chats[0].lastActivity, FRESH_MS,
      'lastActivity rests on window_activity (the newest OUTPUT tmux itself tracks), not line 1 of scrollback');
    assert.notStrictEqual(res.chats[0].lastActivity, 1577836801000,
      'the 2020 first line must never leak into lastActivity');
  });

  it('a legacy 4-column row (older script, or the docker-inspect cwd fallback) leaves lastActivity null', async () => {
    const stdout = 'myproject-worker\tUp 2 hours\t/work/myproject\t1'; // pre-WARDEN-1340 shape
    const res = await discover('prod', {}, {}, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
    });
    assert.strictEqual(res.chats[0].lastActivity, null,
      'no activity column → null, never a stale or bogus value');
  });

  it('an empty/garbage window_activity column degrades to null (no bogus timestamp, row survives)', async () => {
    const stdout = 'myproject-worker\tUp 2 hours\t/work/myproject\t\t1';
    let runCalls = 0;
    const res = await discover('prod', {}, {}, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
      run: async () => { runCalls++; return { ok: true, stdout: 'should not be called' }; },
    });
    assert.strictEqual(runCalls, 0);
    assert.strictEqual(res.chats[0].lastActivity, null);
    assert.strictEqual(res.chats[0].cwd, '/work/myproject', 'the row itself is not dropped');
  });

  it('the lean lifecycle poll gets the row value too — it rides the SAME round-trip for free', async () => {
    // WARDEN-147/WARDEN-994 made lean mode skip the per-agent capture because it
    // cost a fresh ssh per agent. The row column costs nothing, so lean mode no
    // longer trades away lastActivity — the flag stays meaningful only for the
    // discoverManual/local legs, which still run a per-session command.
    const stdout = `myproject-worker\tUp 2 hours\t/work/myproject\t${FRESH_SECS}\t1`;
    let runCalls = 0;
    const res = await discover('prod', {}, { activity: false }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
      run: async () => { runCalls++; return { ok: true, stdout: '' }; },
    });
    assert.strictEqual(runCalls, 0, 'lean still runs no per-agent command');
    assert.strictEqual(res.chats[0].lastActivity, FRESH_MS,
      'the row value is applied even on the lean sweep — it was already paid for');
  });
});

// splitDiscoverOutput separates the docker-stats block (appended to DISCOVER_SCRIPT
// behind the ___WARDEN_STATS___ sentinel, WARDEN-309) from the discover rows, so
// the tested 4-column parseDiscoverRow never sees a stats row. Pure; CI can run it
// with no docker/ssh. The stats block rides the same SSH round-trip but is parsed
// by parseDockerStats (tested below) into a name→stats map.
describe('splitDiscoverOutput (WARDEN-309)', () => {
  it('splits rows from the stats block at the sentinel', () => {
    const stdout = [
      'myproject-worker\tUp 2 hours\t/work\t1',
      '___WARDEN_STATS___',
      'myproject-worker\t42.30%\t15.70%\t310.2MiB / 2GiB',
    ].join('\n');
    const { rows, statsBlock } = splitDiscoverOutput(stdout);
    assert.strictEqual(rows, 'myproject-worker\tUp 2 hours\t/work\t1\n');
    assert.strictEqual(statsBlock, 'myproject-worker\t42.30%\t15.70%\t310.2MiB / 2GiB');
  });

  it('excludes the sentinel line itself from the stats block', () => {
    // The remainder of the sentinel's own line (a trailing comment, hypothetically)
    // must NOT leak into the first stats row.
    const stdout = 'r1\tUp\t/w\t1\n___WARDEN_STATS___\tc\na\t1%\t2%\t3MiB / 4GiB';
    const { statsBlock } = splitDiscoverOutput(stdout);
    assert.strictEqual(statsBlock, 'a\t1%\t2%\t3MiB / 4GiB',
      `sentinel's own line was dropped; got:\n${JSON.stringify(statsBlock)}`);
  });

  it('returns the whole stdout as rows when the sentinel is absent (backward compat)', () => {
    // An older host (pre-WARDEN-309 script) or the companion path emits no stats
    // block: nothing is split off, the rows are intact, and the stats block is ''.
    const stdout = 'a\tUp\t/w\t1\nb\tUp\t/x\t0';
    const { rows, statsBlock } = splitDiscoverOutput(stdout);
    assert.strictEqual(rows, stdout);
    assert.strictEqual(statsBlock, '');
  });

  it('treats null/undefined input as empty', () => {
    assert.deepStrictEqual(splitDiscoverOutput(undefined), { rows: '', statsBlock: '' });
    assert.deepStrictEqual(splitDiscoverOutput(null), { rows: '', statsBlock: '' });
  });
});

// parseDockerStats turns `docker stats --no-stream --format` TSV into a
// name → { cpuPct?, memPct?, memUsage? } map (WARDEN-309). Discovery runs
// `docker stats` over SSH, which CI can't do, so the parser is the unit-testable
// seam — mirroring parseDiscoverRow's testability.
describe('parseDockerStats (WARDEN-309)', () => {
  it('parses a row into cpuPct / memPct / memUsage keyed by container name', () => {
    const out = parseDockerStats('myproject-worker\t42.30%\t15.70%\t310.2MiB / 2GiB');
    assert.deepStrictEqual(out, {
      'myproject-worker': { cpuPct: 42.3, memPct: 15.7, memUsage: '310.2MiB / 2GiB' },
    });
  });

  it('parses multiple rows into a map', () => {
    const out = parseDockerStats([
      'myproject-worker\t42.30%\t15.70%\t310.2MiB / 2GiB',
      'myproject-researcher\t0.10%\t5.00%\t90.1MiB / 2GiB',
    ].join('\n'));
    assert.strictEqual(Object.keys(out).length, 2);
    assert.strictEqual(out['myproject-worker'].cpuPct, 42.3);
    assert.strictEqual(out['myproject-researcher'].memPct, 5);
  });

  it('strips a leading "/" from the name (docker <17 stats quirk)', () => {
    // Older docker daemons (and some CI shims) prefix the container name with '/'.
    // The key must match the `docker ps` name parseDiscoverRow yields (no slash).
    const out = parseDockerStats('/myproject-worker\t10.00%\t5.00%\t100MiB / 2GiB');
    assert.ok(out['myproject-worker'], 'key has no leading slash');
    assert.ok(out['/myproject-worker'] === undefined, 'leading-slash key absent');
  });

  it('keeps a busy-loop CPU reading above 100% (multi-core)', () => {
    // A container burning >1 core reads >100% CPU; the value must not be clamped.
    const out = parseDockerStats('burner\t150.40%\t20.00%\t400MiB / 2GiB');
    assert.strictEqual(out['burner'].cpuPct, 150.4);
  });

  it('parses integer percents and an idle 0% reading', () => {
    const out = parseDockerStats('idle\t0.00%\t0.00%\t10MiB / 2GiB');
    assert.strictEqual(out['idle'].cpuPct, 0);
    assert.strictEqual(out['idle'].memPct, 0);
    const out2 = parseDockerStats('c\t42%\t15%\t310MiB / 2GiB');
    assert.strictEqual(out2['c'].cpuPct, 42);
    assert.strictEqual(out2['c'].memPct, 15);
  });

  it('omits non-numeric percent fields (docker "--" placeholder) but keeps memUsage', () => {
    // A container too new to have a sample emits "--" for the percent columns.
    const out = parseDockerStats('fresh\t--\t--\t-- / --');
    assert.strictEqual(out['fresh'].cpuPct, undefined, 'cpuPct dropped for "--"');
    assert.strictEqual(out['fresh'].memPct, undefined, 'memPct dropped for "--"');
    assert.strictEqual(out['fresh'].memUsage, '-- / --', 'memUsage kept faithfully');
  });

  it('returns {} for blank input and skips blank/short lines', () => {
    assert.deepStrictEqual(parseDockerStats(''), {});
    assert.deepStrictEqual(parseDockerStats(null), {});
    assert.deepStrictEqual(parseDockerStats(undefined), {});
    // blank lines and a name-only line are skipped, the valid row still parses
    const out = parseDockerStats('\n\nmyproject-worker\t1.00%\t2.00%\t3MiB / 2GiB\nnameonly');
    assert.deepStrictEqual(Object.keys(out), ['myproject-worker']);
  });
});

// discover() attaches per-container cpuPct/memPct/memUsage from the docker-stats
// block (WARDEN-309) onto chats AFTER buildChat returns — never inside buildChat,
// whose literal is shared byte-for-byte with the companion transport (WARDEN-272).
// The stats ride the same SSH round-trip (the injected runWithPool returns both the
// rows and the sentinel-bracketed stats block in one stdout). CI can assert the
// wiring with no real ssh/docker via the deps seam.
describe('discover() attaches docker-stats resource fields (WARDEN-309)', () => {
  it('attaches cpuPct/memPct/memUsage to chats whose name has a stats row', async () => {
    const stdout = [
      'myproject-worker\tUp 2 hours\t/work\t1',
      'myproject-researcher\tUp 5 min\t/x\t0',
      '___WARDEN_STATS___',
      'myproject-worker\t42.30%\t15.70%\t310.2MiB / 2GiB',
      'myproject-researcher\t0.10%\t5.00%\t90.1MiB / 2GiB',
    ].join('\n');
    const res = await discover('prod', {}, { activity: false }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
    });
    assert.strictEqual(res.ok, true);
    const byKey = Object.fromEntries(res.chats.map((c) => [c.key, c]));
    assert.strictEqual(byKey['myproject-worker'].cpuPct, 42.3);
    assert.strictEqual(byKey['myproject-worker'].memPct, 15.7);
    assert.strictEqual(byKey['myproject-worker'].memUsage, '310.2MiB / 2GiB');
    assert.strictEqual(byKey['myproject-researcher'].cpuPct, 0.1);
  });

  it('omits resource fields entirely when there is no stats block (older host)', async () => {
    // Pre-WARDEN-309 script output: rows only, no sentinel. Chats must match
    // buildChat() exactly — no cpuPct/memPct/memUsage keys at all (graceful N/A).
    const stdout = 'myproject-worker\tUp 2 hours\t/work\t1';
    const res = await discover('prod', {}, { activity: false }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
    });
    assert.strictEqual(res.ok, true);
    const chat = res.chats[0];
    assert.strictEqual(chat.cpuPct, undefined);
    assert.strictEqual(chat.memPct, undefined);
    assert.strictEqual(chat.memUsage, undefined);
    // And the chat is otherwise byte-identical to buildChat (the WARDEN-272 invariant).
    assert.deepStrictEqual(
      chat,
      buildChat('prod', 'myproject-worker', 'Up 2 hours', '/work', true, 'agent'),
    );
  });

  it('omits fields for a container with no matching stats row (stats row absent)', async () => {
    // The container is discovered but `docker stats` returned no row for it
    // (e.g. it stopped between `docker ps` and `docker stats`). It must not get
    // another container's stats, and must not throw.
    const stdout = [
      'myproject-worker\tUp 2 hours\t/work\t1',
      '___WARDEN_STATS___',
      'some-other-container\t99.00%\t99.00%\t1GiB / 2GiB',
    ].join('\n');
    const res = await discover('prod', {}, { activity: false }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
    });
    const chat = res.chats[0];
    assert.strictEqual(chat.cpuPct, undefined);
    assert.strictEqual(chat.memUsage, undefined);
    assert.strictEqual(res.chats.length, 1, 'stats row did NOT become a bogus chat');
  });

  it('does not let a stats row masquerade as a discover row (sentinel isolates it)', async () => {
    // Regression guard: without the sentinel split, a stats row
    // `name\t42.30%\t15.70%\t310MiB / 2GiB` has 4 columns and would parse as a
    // chat (name=name, active=false, cwd=15.70%, status=42.30%). The sentinel
    // must prevent that — only the real discover row becomes a chat.
    const stdout = [
      'myproject-worker\tUp 2 hours\t/work\t1',
      '___WARDEN_STATS___',
      'myproject-worker\t42.30%\t15.70%\t310.2MiB / 2GiB',
    ].join('\n');
    const res = await discover('prod', {}, { activity: false }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
    });
    assert.strictEqual(res.chats.length, 1, 'exactly one chat — the stats row did not double it');
    assert.strictEqual(res.chats[0].cwd, '/work', 'cwd is the real discover cwd, not a percent');
  });
});

// ---------------- WARDEN-309 graceful stats-failure regression (criterion #3) ---
// The blocking bug review #2 caught: `docker stats` is the LAST command in
// DISCOVER_SCRIPT, and run() derives `ok` from the script's exit code
// (`ok: code === 0`, ssh.js). If `docker stats` exits non-zero (older host, no
// permission, daemon hiccup, or a timeout sampling CPU on a loaded 50-container
// host — the exact scale WARDEN-309 targets) and that exit code propagates, the
// WHOLE script exits non-zero → run() ok:false → discover() returns chats:[] →
// every agent on that host vanishes. The opposite of the ticket's "graceful N/A"
// (criterion #3). `2>/dev/null` swallows only the stderr MESSAGE; the trailing
// `|| true` is what neutralizes the EXIT code.
//
// The mock-only discover() tests above hand-supply `{ok:true}` and so are
// structurally blind to this — a mock can't know that `|| true` flips ok. Two
// guards here close that gap:
//   1) A pure, always-on assertion that the `docker stats` command is fault-
//      tolerant — red the moment someone drops `|| true`, no bash required.
//   2) An end-to-end run that ACTUALLY EXECUTES DISCOVER_SCRIPT against a stub
//      `docker` whose `stats` subcommand exits 1, wired through discover()'s
//      runWithPool seam (mirroring run()'s ok:code===0 contract). Red without
//      `|| true` (script exits 1 → ok:false → chats:[]), green with it (script
//      exits 0 → ok:true → chat survives, no resource fields). Gated on bash.
describe('discover() survives a failed docker stats (graceful N/A, WARDEN-309 #3)', () => {
  it('the docker stats command in DISCOVER_SCRIPT is fault-tolerant (|| true)', () => {
    // Pure guard: a `docker stats` failure must not be able to own the script's
    // exit code. If this fails, someone dropped `|| true` and a stats failure on
    // a loaded host will silently blank every agent on that host from Fleet Health.
    // Match the COMMAND line (trimmed, starts with `docker stats`), not a comment
    // that merely mentions it.
    const statsLine = DISCOVER_SCRIPT.split('\n').map((l) => l.trim()).find((l) => l.startsWith('docker stats --no-stream'));
    assert.ok(statsLine, 'DISCOVER_SCRIPT invokes `docker stats --no-stream`');
    assert.match(statsLine, /\|\|\s*true/,
      '`docker stats` must be followed by `|| true` so a non-zero exit cannot abort the whole discover script (run() ok:code===0 → discover chats:[])');
  });

  (bashAvailable() ? it : it.skip)('still returns ok:true with the chat (and no resource fields) when docker stats exits non-zero', async () => {
    // Drive the REAL failure path end-to-end: execute DISCOVER_SCRIPT against a
    // stub `docker` whose `stats` exits 1, via discover()'s runWithPool seam
    // (which mirrors run()'s ok:code===0 contract exactly). This is the test the
    // mock-only suites cannot express — only executing the script observes that
    // `|| true` flips the exit code, and therefore ok, and therefore whether the
    // chat survives.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-309-'));
    try {
      // Stub `docker`: ps/exec/inspect succeed so the chat row is produced; stats
      // FAILS — the divergence criterion #3 targets. `docker exec ... tmux
      // has-session` is driven via the `exec` subcommand (made to fail, so the
      // row reads active=0 and cwd falls back to `docker inspect`'s WorkingDir).
      const stub = [
        '#!/usr/bin/env bash',
        'case "$1" in',
        "  ps) printf 'myproject-worker\\tUp 2 hours\\n' ;;",
        '  exec) exit 1 ;;',
        "  inspect) printf '/work' ;;",
        '  stats) exit 1 ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(tmp, 'docker'), stub, { mode: 0o755 });

      const res = await discover('prod', {}, { activity: false }, {
        isCompanionTransportEnabled: () => false,
        runWithPool: async () => {
          // Execute the REAL script with the stub `docker` first on PATH. We use
          // `bash -c` (not -lc): a login shell sources the profile and clobbers
          // PATH, hiding the stub; the login shell is only SSH's PATH-loading
          // mechanism, not part of the exit-code invariant under test, which is
          // identical under `bash -c`.
          const r = spawnSync(BASH_BIN, ['-c', DISCOVER_SCRIPT], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${tmp}:${process.env.PATH || ''}` },
          });
          // Mirror ssh.js run()'s contract: ok is the script's exit code === 0.
          return { ok: (r.status ?? -1) === 0, code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        },
      });

      assert.strictEqual(res.ok, true,
        'discover() stays ok:true — a docker stats failure must NOT abort discovery (the script must exit 0 via `|| true`)');
      assert.strictEqual(res.chats.length, 1,
        'the chat row survives — a stats failure is graceful N/A, not host-wide data loss');
      const chat = res.chats[0];
      assert.strictEqual(chat.cpuPct, undefined, 'no stats row → no cpuPct');
      assert.strictEqual(chat.memPct, undefined, 'no stats row → no memPct');
      assert.strictEqual(chat.memUsage, undefined, 'no stats row → no memUsage');
      // And the chat is otherwise byte-identical to buildChat (the WARDEN-272
      // invariant — resource fields are attached in discover(), never in buildChat).
      assert.deepStrictEqual(
        chat,
        buildChat('prod', 'myproject-worker', 'Up 2 hours', '/work', false, 'agent'),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});


// -------------------- discoverManual lean path (WARDEN-994) -----------------
// The 60s lifecycle sweep calls discoverAll(hosts, cfg, { activity: false }).
// discover() (yatfa) and discoverAll()'s LOCAL catalog branch both gate their
// activity capture on that flag; the REMOTE catalog branch did not, because
// discoverManual had no `opts` parameter at all — so every active remote manual
// session still cost one NON-pooled ssh capture-pane plus a chats.json
// read-modify-write per tick. These tests pin the guard and prove the non-lean
// (WARDEN-245) path is untouched. Injected via the deps seam that mirrors
// discover()'s, so no real ssh runs and no catalog file is written.
describe('discoverManual() honors the lean activity flag (WARDEN-994)', () => {
  const ENTRIES = [{ host: 'prod', session: 'sess-a', name: 'A', cwd: '/w', cmd: 'claude' }];
  // WARDEN-1340: the non-lean activity probe is now `tmux display-message -p -t
  // <session> '#{window_activity}'` — stdout is epoch SECONDS (trailing newline
  // tolerated), not a pane line.
  const WINDOW_ACTIVITY = '1789088272\n';
  const WINDOW_ACTIVITY_MS = 1789088272000;
  // has-session probe: sess-a alive.
  const alive = { ok: true, stdout: '1 sess-a\n' };

  it('lean ({ activity: false }): zero capture runs and zero catalog stamps', async () => {
    let runCalls = 0, stamps = 0;
    const res = await discoverManual('prod', ENTRIES, {}, { activity: false }, {
      runWithPool: async () => alive,
      run: async () => { runCalls++; return { ok: true, stdout: WINDOW_ACTIVITY }; },
      stampCatalogActivity: async () => { stamps++; },
    });
    assert.strictEqual(runCalls, 0, 'lean mode skips the per-session activity run');
    assert.strictEqual(stamps, 0, 'lean mode writes nothing to chats.json');
    // Liveness (the only thing the lifecycle diff needs) is still resolved.
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].active, true);
  });

  it('lean still hydrates lastActivity from the persisted catalog entry', async () => {
    const persisted = [{ ...ENTRIES[0], lastActivity: 1700000000000 }];
    const res = await discoverManual('prod', persisted, {}, { activity: false }, {
      runWithPool: async () => alive,
      run: async () => { throw new Error('activity probe must not run in lean mode'); },
      stampCatalogActivity: async () => { throw new Error('stamp must not run in lean mode'); },
    });
    assert.strictEqual(res[0].lastActivity, 1700000000000,
      'the persisted value survives the lean tick (WARDEN-245 recency ordering)');
  });

  // `opts` genuinely OMITTED (undefined → the `opts = {}` default fires). This is
  // byte-for-byte discoverHost's call shape (`discoverManual(host, entries, cfg)`,
  // chats.js), which WARDEN-994 deliberately leaves un-gated — so this is the
  // behavioral proof of criterion 3: /api/discover still probes and stamps.
  it('opts omitted (discoverHost\'s call shape): still probes window_activity AND still stamps — WARDEN-245 untouched', async () => {
    let runCalls = 0, seenCmd = '';
    const stamped = [];
    const res = await discoverManual('prod', ENTRIES, {}, undefined, {
      runWithPool: async () => alive,
      run: async (_host, cmd) => { runCalls++; seenCmd = cmd; return { ok: true, stdout: WINDOW_ACTIVITY }; },
      stampCatalogActivity: async (host, session, ts) => { stamped.push([host, session, ts]); },
    });
    assert.strictEqual(runCalls, 1, 'one window_activity probe per active session');
    assert.match(seenCmd, /display-message/, 'the probe is display-message, not a pane capture');
    assert.match(seenCmd, /#\{window_activity\}/, 'it reads tmux\'s own window_activity (WARDEN-1340)');
    assert.doesNotMatch(seenCmd, /capture-pane/, 'no scrollback capture on the activity path');
    assert.strictEqual(res[0].lastActivity, WINDOW_ACTIVITY_MS,
      'epoch seconds × 1000 → ms BEFORE the stamp (raw seconds would read as ~1970)');
    assert.deepStrictEqual(stamped, [['prod', 'sess-a', WINDOW_ACTIVITY_MS]],
      'the live ms value is persisted so it survives going inactive + a restart');
  });

  it('non-lean ({ activity: true }) probes too — only `false` is lean', async () => {
    let runCalls = 0;
    await discoverManual('prod', ENTRIES, {}, { activity: true }, {
      runWithPool: async () => alive,
      run: async () => { runCalls++; return { ok: true, stdout: WINDOW_ACTIVITY }; },
      stampCatalogActivity: async () => {},
    });
    assert.strictEqual(runCalls, 1);
  });

  it('a garbage window_activity readout leaves lastActivity null and stamps nothing', async () => {
    const res = await discoverManual('prod', ENTRIES, {}, {}, {
      runWithPool: async () => alive,
      run: async () => ({ ok: true, stdout: '' }),
      stampCatalogActivity: async () => { throw new Error('must not stamp a null value'); },
    });
    assert.strictEqual(res[0].active, true);
    assert.strictEqual(res[0].lastActivity, null);
  });

  it('an INACTIVE session costs no probe in either mode', async () => {
    let runCalls = 0;
    const res = await discoverManual('prod', ENTRIES, {}, {}, {
      runWithPool: async () => ({ ok: true, stdout: '0 sess-a\n' }),
      run: async () => { runCalls++; return { ok: true, stdout: WINDOW_ACTIVITY }; },
      stampCatalogActivity: async () => {},
    });
    assert.strictEqual(runCalls, 0);
    assert.strictEqual(res[0].active, false);
    assert.strictEqual(res[0].lastActivity, null);
  });
});

// The guard above lives in discoverManual, but the BUG was the caller: discoverAll
// dropped the flag on the floor (`discoverManual(host, entries, cfg)`), so a guard
// alone would still be dead on the lean sweep. discoverAll gets the same `deps`
// seam discover() and discoverManual() already carry, so the flag's ARRIVAL is
// observed rather than its spelling pinned — this survives renames and reformats
// and goes red only on the actual regression.
describe('discoverAll forwards the lean flag to discoverManual (WARDEN-994 wiring)', () => {
  const CATALOG = [{ host: 'prod', session: 'sess-a', name: 'A', cwd: '/w', cmd: 'claude' }];

  it('the remote-catalog branch receives { activity: false } on a lean sweep', async () => {
    let seen;
    await discoverAll(['prod'], {}, { activity: false }, {
      loadCatalog: async () => CATALOG,
      discover: async () => ({ host: 'prod', ok: true, chats: [] }),
      discoverManual: async (h, e, c, o) => { seen = o; return e.map((x) => ({ ...x, active: true })); },
    });
    assert.strictEqual(seen?.activity, false,
      'the guard inside discoverManual is dead unless discoverAll forwards the flag');
  });

  it('a non-lean sweep does NOT suppress the capture (activity stays undefined, not false)', async () => {
    let seen;
    await discoverAll(['prod'], {}, {}, {
      loadCatalog: async () => CATALOG,
      discover: async () => ({ host: 'prod', ok: true, chats: [] }),
      discoverManual: async (h, e, c, o) => { seen = o; return e.map((x) => ({ ...x, active: true })); },
    });
    assert.notStrictEqual(seen?.activity, false,
      'only an explicit false is lean — a blanket `{ activity: false }` forward would kill WARDEN-245');
  });
});
