import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveChat, resolveChatWithRefresh, comparePinned, parseDiscoverRow, parseDockerStats, splitDiscoverOutput, discover, capturePanes, DISCOVER_SCRIPT } from './chats.js';
import { buildChat, parseActivityTimestamp } from './chatMeta.js';

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
    return { host: '(local)', key: session, container: null, session };
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
        const out = await capturePanes([makeLocalChat(name)], {});
        // The capture succeeded via the LOCAL path — proving the companion (which
        // refuses (local) hosts) was NOT consulted.
        assert.ok(out[name], `LOCAL pane was captured: ${JSON.stringify(Object.keys(out))}`);
        assert.ok(out[name].includes('WARDEN_LOCAL_MARKER_7'),
          `captured the marker; got:\n${out[name]}`);
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
        const out = await capturePanes([makeLocalChat(name)], {});
        assert.ok(out[name], 'default LOCAL capture works');
        assert.ok(out[name].includes('WARDEN_LOCAL_MARKER_7'));
      })();
    } finally {
      if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
      else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    }
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
  // Mirrors the catalogChats() comparator: pin-first, then id localeCompare.
  const sortById = (chats, pinSet) =>
    [...chats].sort((a, b) => comparePinned(a, b, pinSet) || a.id.localeCompare(b.id));

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

  it('rejoins a status that itself contains a tab', () => {
    // Defensive: if docker's Status field ever embeds a tab, the middle columns
    // between name and cwd are the status (rejoined), not split into cwd/active.
    const row = parseDiscoverRow('c\tUp\tand\tmore\t/w\t1');
    assert.strictEqual(row.status, 'Up\tand\tmore');
    assert.strictEqual(row.cwd, '/w');
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

// WARDEN-376: the default SSH discover path's second-pass activity capture was
// refactored to parse the leading pane line via the shared parseActivityTimestamp
// (the SAME helper the companion path uses). Every existing discover test skips
// this pass with { activity: false }, so this block exercises the capture path
// itself — locking the refactor as a no-op and proving default<->companion
// parity (both produce the same lastActivity for the same leading line). The raw
// `run` the capture pass uses is injected via deps.run (defaults to the real run;
// production behavior unchanged).
describe('discover() default-path activity capture uses the shared helper (WARDEN-376)', () => {
  it('populates lastActivity from the captured leading pane line (parity with companion)', async () => {
    const stdout = 'myproject-worker\tUp 2 hours\t/work/myproject\t1'; // one active agent
    const pane = '[2024-01-15 10:30:00] worker: thinking';
    let runCalls = 0;
    const res = await discover('prod', { connectTimeout: 10 }, { /* activity omitted -> capture runs */ }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
      run: async () => { runCalls++; return { ok: true, stdout: pane }; },
    });
    assert.strictEqual(runCalls, 1, 'one capture-pane run per active agent');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.chats.length, 1);
    assert.strictEqual(res.chats[0].lastActivity, parseActivityTimestamp(pane),
      'lastActivity parsed by the SAME helper the companion uses');
    assert.ok(Number.isFinite(res.chats[0].lastActivity));
  });

  it('leaves lastActivity null when the captured line has no timestamp', async () => {
    const stdout = 'myproject-worker\tUp 2 hours\t/work/myproject\t1';
    const res = await discover('prod', {}, {}, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
      run: async () => ({ ok: true, stdout: 'agent output with no timestamp' }),
    });
    assert.strictEqual(res.chats[0].lastActivity, null);
  });

  it('skips the capture pass entirely when lean (activity: false) — no per-agent run', async () => {
    const stdout = 'myproject-worker\tUp 2 hours\t/work/myproject\t1';
    let runCalls = 0;
    const res = await discover('prod', {}, { activity: false }, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
      run: async () => { runCalls++; return { ok: true, stdout: '' }; },
    });
    assert.strictEqual(runCalls, 0, 'lean mode skips the per-agent capture-pane run');
    assert.strictEqual(res.chats[0].lastActivity, null);
  });

  it('a failed capture (run !ok) leaves lastActivity null without throwing (per-agent resilience)', async () => {
    const stdout = 'myproject-worker\tUp 2 hours\t/work/myproject\t1';
    const res = await discover('prod', {}, {}, {
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, stdout }),
      run: async () => ({ ok: false, code: 1, stderr: 'capture failed' }),
    });
    assert.strictEqual(res.ok, true, 'discover itself still succeeds');
    assert.strictEqual(res.chats[0].lastActivity, null);
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


