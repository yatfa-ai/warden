import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseRemoteSessionOutput,
  remoteClaudeSessions,
  remoteClaudeSessionsDetail,
} from './claudeSessions.js';
import { isTransportFailure } from './ssh.js';

/**
 * WARDEN-1196 — an unreachable host must be DISTINGUISHABLE from an empty one.
 *
 * THE BUG. `remoteClaudeSessions` collapsed every failure to `[]` and `detectClaude`
 * collapsed every failure to `null`, so `/api/claude-sessions` answered a clean
 * `200 {sessions: [], claudeAvailable: false}` for a host it could not reach. The
 * sidebar's warning is gated on `claudeAvailable === false`, so a dropped tunnel /
 * wedged control socket / powered-off box rendered as
 * "⚠ claude not found on <host> — install it" — a confident, WRONG, and ACTIONABLE
 * instruction about the user's machine.
 *
 * These tests drive the new `remoteClaudeSessionsDetail` through its `deps.run` seam,
 * so every leg is exercised with NO real SSH (the repo is on Node 20, which has no
 * `mock.module` — hence the seam rather than a module mock). They assert the ACTUAL
 * return value, so they fail if the classification is inverted or the flag dropped.
 *
 * The over-correction guards are the load-bearing half: it is trivially easy to "fix"
 * this by reporting every failure as unreachable, which would replace one false claim
 * with another (and break the two states that MUST keep their existing render).
 */

// One session as the remote script emits it: ___S<TAB>id<TAB>mtime, the JSONL head,
// then ___E<TAB>id. `cwd` is required — parseJsonlHead drops a session without one.
function emit(id, mtimeSec, cwd = '/home/u/proj', summary = 'hello there') {
  const head = [
    JSON.stringify({ cwd }),
    JSON.stringify({ type: 'user', message: { content: summary } }),
  ].join('\n');
  return `___S\t${id}\t${mtimeSec}\n${head}\n___E\t${id}\n`;
}

// A raw ssh result, the shape `run()` resolves to.
const result = (over = {}) => ({ ok: false, code: 1, stdout: '', stderr: '', ...over });

// The two transport shapes observed against a real black-holed host (see the ticket's
// reproduction): a killed/failed-to-spawn local ssh (code -1) and a connect-time
// refusal on stderr with NO stdout.
const SPAWN_FAILURE = result({ code: -1, stderr: 'Error: spawn ssh ENOENT' });
const NO_ROUTE = result({ code: 255, stderr: 'ssh: connect to host deadhost port 22: No route to host\n' });

describe('remoteClaudeSessionsDetail — the transport-failure channel (WARDEN-1196)', () => {
  it('reports unreachable:true when the local ssh never delivered the command (code -1)', async () => {
    const run = async () => SPAWN_FAILURE;

    const detail = await remoteClaudeSessionsDetail('deadhost', 40, { run });

    assert.deepStrictEqual(detail, { sessions: [], unreachable: true },
      'a code -1 with no stdout is a transport failure, not an empty host');
  });

  it('reports unreachable:true on a connect-time refusal (ssh: ... No route to host)', async () => {
    const run = async () => NO_ROUTE;

    const detail = await remoteClaudeSessionsDetail('deadhost', 40, { run });

    assert.strictEqual(detail.unreachable, true);
    assert.deepStrictEqual(detail.sessions, [], 'no rows are invented for a host we could not read');
  });

  it('delegates the classification to isTransportFailure rather than re-deriving it', async () => {
    // The discriminator is the house one (src/ssh.js:488), already used for exactly
    // this call by sessionRecovery.js:20. Pinning the agreement means a future change
    // to the classifier cannot silently desynchronise this leg from the rest of warden.
    for (const raw of [SPAWN_FAILURE, NO_ROUTE, result({ code: 2, stdout: 'partial\n' })]) {
      const detail = await remoteClaudeSessionsDetail('h', 40, { run: async () => raw });
      assert.strictEqual(detail.unreachable, isTransportFailure(raw),
        `unreachable must equal isTransportFailure for ${JSON.stringify(raw.stderr || raw.code)}`);
    }
  });

  it('passes the real remote script to run() on the configured 15s timeout', async () => {
    // The seam must not change WHAT is executed — only make it observable.
    const calls = [];
    const run = async (host, cmd, opts) => { calls.push({ host, cmd, opts }); return SPAWN_FAILURE; };

    await remoteClaudeSessionsDetail('somehost', 40, { run });

    assert.strictEqual(calls.length, 1, 'exactly one SSH round trip');
    assert.strictEqual(calls[0].host, 'somehost');
    assert.match(calls[0].cmd, /~\/\.claude\/projects/, 'runs the real session-enumeration script');
    assert.deepStrictEqual(calls[0].opts, { timeout: 15000 }, 'timeout unchanged');
  });
});

describe('remoteClaudeSessionsDetail — NO over-correction (WARDEN-1196 criterion 4)', () => {
  it('a host that answers with a non-zero exit AND real stdout is a COMMAND failure, not unreachable', async () => {
    // This is the case that makes "report every failure as unreachable" wrong. The
    // machine answered — it ran the command and produced output — so calling it
    // unreachable would be a fresh false claim in the opposite direction.
    // isTransportFailure returns false whenever stdout is non-empty, by design.
    const run = async () => result({ code: 2, stdout: 'some output the command produced\n', stderr: 'grep: bad thing' });

    const detail = await remoteClaudeSessionsDetail('livehost', 40, { run });

    assert.strictEqual(detail.unreachable, false,
      'a host that produced stdout provably ran the command — that is not a transport failure');
    assert.deepStrictEqual(detail.sessions, [], 'still degrades to the pre-existing empty list');
  });

  it('an auth failure is NOT reported as unreachable (not transient, deliberately excluded)', async () => {
    // "Permission denied (publickey)." does not start with `ssh:` and is intentionally
    // not classified as transport by the house classifier.
    const run = async () => result({ code: 255, stderr: 'Permission denied (publickey).\n' });

    const detail = await remoteClaudeSessionsDetail('authfail', 40, { run });

    assert.strictEqual(detail.unreachable, false);
  });

  it('a REACHABLE host with zero sessions is unreachable:false — the empty state must survive', async () => {
    // Criterion 4's first guard: a genuinely empty host must keep rendering the
    // existing EmptyState, not the new failure row.
    const run = async () => result({ ok: true, code: 0, stdout: '' });

    const detail = await remoteClaudeSessionsDetail('emptyhost', 40, { run });

    assert.deepStrictEqual(detail, { sessions: [], unreachable: false },
      'empty is a fact about the host CONTENTS; unreachable is a fact about the READ');
  });

  it('a reachable host WITH sessions parses them and stays unreachable:false', async () => {
    const run = async () => result({ ok: true, code: 0, stdout: emit('aaa', 1000) + emit('bbb', 2000) });

    const detail = await remoteClaudeSessionsDetail('livehost', 40, { run });

    assert.strictEqual(detail.unreachable, false);
    assert.deepStrictEqual(detail.sessions.map((s) => s.id), ['bbb', 'aaa'], 'most-recent first');
    assert.strictEqual(detail.sessions[0].cwd, '/home/u/proj');
  });

  it('honours the limit on the success path', async () => {
    const stdout = emit('a', 1000) + emit('b', 2000) + emit('c', 3000);
    const run = async () => result({ ok: true, code: 0, stdout });

    const detail = await remoteClaudeSessionsDetail('h', 2, { run });

    assert.deepStrictEqual(detail.sessions.map((s) => s.id), ['c', 'b'], 'newest 2 kept');
  });
});

describe('remoteClaudeSessions — existing contract FROZEN (WARDEN-1196 criterion 5)', () => {
  // /api/claude-sessions-all (src/server.js:1434) wraps the return value in
  // {host, sessions} for mergeAndPaginateSessions, and the budget sweep (:2817) calls
  // .map() on it directly. Both would break on a record, so the array contract is
  // pinned here rather than assumed.
  it('still returns a BARE ARRAY on success (not the detail record)', async () => {
    // The production signature takes no deps, so this exercises the real `run` against
    // a host that cannot resolve — the array-ness is the assertion, not the contents.
    const out = await remoteClaudeSessions('nonexistent.invalid');

    assert.ok(Array.isArray(out), 'callers .map() this directly — it must stay an array');
  });

  it('still returns [] (never a throw, never a record) for an unreachable host', async () => {
    const out = await remoteClaudeSessions('nonexistent.invalid');

    assert.deepStrictEqual(out, [], 'the two other callers degrade to "no sessions from this host"');
    assert.strictEqual(out.unreachable, undefined, 'the failure flag must NOT leak onto the frozen array');
  });
});

describe('parseRemoteSessionOutput — the extracted pure parser (WARDEN-1196)', () => {
  // Extracted from remoteClaudeSessions so the detail variant and the frozen array
  // share ONE parse body and cannot drift. These pin the behaviour the extraction
  // must have preserved.
  it('parses ___S/___E framed rows, newest first', () => {
    const out = parseRemoteSessionOutput(emit('old', 100) + emit('new', 900));

    assert.deepStrictEqual(out.map((s) => s.id), ['new', 'old']);
    assert.strictEqual(out[0].mtime, 900_000, 'mtime is seconds → ms');
  });

  it('carries the optional token group when present and null when absent', () => {
    const withTokens = `___S\tt1\t500\t1\t2\t3\t4\n${JSON.stringify({ cwd: '/p' })}\n___E\tt1\n`;

    const [tok] = parseRemoteSessionOutput(withTokens);
    const [notok] = parseRemoteSessionOutput(emit('t2', 500));

    assert.deepStrictEqual(tok.tokenUsage, { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, total: 10 });
    assert.strictEqual(notok.tokenUsage, null, 'a no-usage file degrades to null, never a parse failure');
  });

  it('drops a session with no cwd rather than throwing', () => {
    const noCwd = `___S\tx\t500\n${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n___E\tx\n`;

    assert.deepStrictEqual(parseRemoteSessionOutput(noCwd), []);
  });

  it('is total over junk input (empty / undefined / unframed)', () => {
    assert.deepStrictEqual(parseRemoteSessionOutput(''), []);
    assert.deepStrictEqual(parseRemoteSessionOutput(undefined), []);
    assert.deepStrictEqual(parseRemoteSessionOutput('not the expected framing at all'), []);
  });
});

/**
 * The WIRE contract (WARDEN-1196 criteria 1 + 2). The helper tests above prove the
 * classification; these prove what the ROUTE actually emits, which is what the
 * sidebar reads — a fix that classified correctly but still sent
 * `claudeAvailable: false` would satisfy every test above and leave the bug live.
 *
 * Boots the real Express app on an ephemeral port against a throwaway HOME whose
 * config names a host that cannot be reached. No SSH is mocked: `run()` genuinely
 * fails to reach it, which is exactly the production failure being reproduced.
 */
describe('GET /api/claude-sessions — the wire contract for an unreachable host', () => {
  let httpServer, baseUrl, tempHome, originalHome;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1196-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: ['nonexistent.invalid'] }));

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('answers a DISTINGUISHABLE failure — an `error` key, not a clean empty list', async () => {
    const res = await fetch(`${baseUrl}/api/claude-sessions?host=nonexistent.invalid`);
    const body = await res.json();

    assert.strictEqual(res.status, 200, 'stays 200 — the convention is a 200 carrying {error}');
    assert.strictEqual(body.error, 'host unreachable',
      'criterion 1: the failure must reach the client, not be destroyed server-side');
    assert.deepStrictEqual(body.sessions, [], 'no rows invented for a host we could not read');
  });

  it('NEVER sends claudeAvailable for an unreachable host — the key is ABSENT', async () => {
    // THE load-bearing assertion. The sidebar's warning is gated on a strict
    // `claudeAvailable === false`, so sending `false` here (even beside an `error`)
    // would still render "⚠ claude not found — install it" and the fix would fail its
    // own purpose. Omitting the key arrives as `undefined`, which that gate rejects.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions?host=nonexistent.invalid`)).json();

    assert.ok(!('claudeAvailable' in body),
      `criterion 2: claudeAvailable must be ABSENT, got ${JSON.stringify(body.claudeAvailable)}`);
    assert.notStrictEqual(body.claudeAvailable, false,
      'sending false would keep the wrong "install claude" instruction rendering');
  });

  it('the (local) path is unchanged — still answers claudeAvailable, never an error', async () => {
    // Criterion 5/6: localClaudeSessions does no SSH, so transport failure is
    // impossible there and that leg must keep its exact prior shape.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions?host=${encodeURIComponent('(local)')}`)).json();

    assert.strictEqual(typeof body.claudeAvailable, 'boolean', 'local always answers the claude question');
    assert.strictEqual(body.error, undefined, 'the local path has no failure channel');
    assert.ok(Array.isArray(body.sessions));
  });

  it('defaults to the local host when no host param is given (unchanged)', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions`)).json();

    assert.strictEqual(typeof body.claudeAvailable, 'boolean');
    assert.strictEqual(body.error, undefined);
  });
});
