import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { resolveChat, resolveChatWithRefresh, comparePinned, parseDiscoverRow } from './chats.js';

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
