import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WARDEN-1938 — pins the REMOTE leg of /api/claude-sessions-search at MODULE
// grain: the failure-channel split this ticket applied to the search twin.
// Mirrors the harness convention of claudeSessionsSearchLocal.test.js (the
// LOCAL twin's module-level suite) and companion-exec-legs.test.js (the
// `deps` routing seam, no real ssh).
//
// Three contracts, in the order the fix shipped them:
//
// 1. SINGLE BODY — `parseSessionSearchOutput` is the ONE ___S/___SNIP/___E
//    state machine both entry points parse through (the bare variant and the
//    detail variant delegate to it, so their parses cannot drift). It is
//    exported precisely so the state machine is assertable without a
//    transport.
// 2. FAILURE CLASSIFICATION — `remoteSearchClaudeSessionsDetail` answers a
//    TRANSPORT failure with `{ sessions: [], unreachable: true }` and a
//    COMMAND failure (non-zero exit, real stdout) with
//    `{ sessions: [], unreachable: false }` — the -all route's scope
//    discipline (isTransportFailure returns false on non-empty stdout), now
//    carried by the search twin instead of destroyed inside the helper.
// 3. FROZEN PROJECTION — `remoteSearchClaudeSessions` stays a bare array,
//    empty on any failure, and FORWARDS the `deps` seam (the
//    companion-exec-legs leg-3 suite pins this through server.js; this suite
//    pins the same seam on the projection directly, plus row parity with the
//    detail variant's sessions).

const originalHome = process.env.HOME;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-claudeSessionsSearchRemote-'));
process.env.HOME = tempHome;
fs.mkdirSync(path.join(tempHome, '.claude', 'projects'), { recursive: true });

const {
  parseSessionSearchOutput, remoteSearchClaudeSessions,
  remoteSearchClaudeSessionsDetail, buildSessionSearchScript,
  SESSION_SEARCH_PER_HOST,
} = await import('./claudeSessions.js');

const HOST = 'u@remote-test';

// The run()-result envelope execInContext / run() return (companion-exec-legs'
// okResult shape).
const okResult = (stdout = '') => ({ host: HOST, ok: true, code: 0, stdout, stderr: '' });
// A connection-establishment transport failure (the fake-ssh shim's
// "no canned file" answer in the route suite; classified by isTransportFailure).
const transportDead = () => ({
  host: HOST, ok: false, code: 255, stdout: '',
  stderr: `ssh: Could not resolve hostname ${HOST}: Name or service not known`,
});
// A command-level failure: the remote command RAN and exited non-zero with real
// stdout — isTransportFailure returns FALSE for it, so the host must NOT be
// named unreachable.
const commandFailed = () => ({
  host: HOST, ok: false, code: 3, stdout: 'the command ran and printed this', stderr: '',
});

const depsWith = (result) => ({
  isCompanionTransportEnabled: () => true,
  execInContext: async () => result,
  run: async () => { throw new Error('the routing seam must never consult run() here'); },
});

// One ___S/body/___SNIP/___E record, the exact shape buildSessionSearchScript
// emits (mirrors searchOut in claudeSessionsRoutes.test.js).
const record = (id, mtimeSec, body, match) =>
  `___S\t${id}\t${mtimeSec}\n${body}\n___SNIP\t${match}\n___E\t${id}\n`;

const userLine = (text, cwd) => JSON.stringify({
  type: 'user', cwd, message: { role: 'user', content: text }, timestamp: '2026-01-01T00:00:00Z',
});

describe('remote search leg of /api/claude-sessions-search (WARDEN-1938)', () => {
  after(async () => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('parseSessionSearchOutput — the ONE shared state machine', () => {
    it('parses id/mtime (sec→ms), cwd/summary from the head, and the snippet from ___SNIP', () => {
      const body = userLine('the needle appears here', '/w/proj');
      const out = parseSessionSearchOutput(record('abc-1', 1700000000, body, body), 'needle');
      assert.deepEqual(out, [{
        id: 'abc-1', cwd: '/w/proj', summary: 'the needle appears here',
        snippet: 'the needle appears here', mtime: 1700000000000,
      }]);
    });

    it('sorts newest-first and caps at SESSION_SEARCH_PER_HOST', () => {
      const body = userLine('hello', '/w/proj');
      const stdout = record('old', 100, body, body) + record('new', 900, body, body)
        + Array.from({ length: SESSION_SEARCH_PER_HOST + 5 }, (_, i) => record(`r${i}`, 500 + i, body, body)).join('');
      const out = parseSessionSearchOutput(stdout, 'hello');
      assert.equal(out.length, SESSION_SEARCH_PER_HOST);
      assert.equal(out[0].id, 'new');
      assert.equal(out.some((r) => r.id === 'old'), false, 'the oldest row past the cap is dropped');
    });

    it('drops a record whose head yields no cwd, and tolerates empty input', () => {
      assert.deepEqual(parseSessionSearchOutput('', 'needle'), []);
      assert.deepEqual(parseSessionSearchOutput(record('n cwd', 100, 'garbage', 'x'), 'needle'), []);
    });

    it('is the single body: the detail variant and the bare projection parse the same stdout into the same rows', async () => {
      const body = userLine('parity needle', '/w/proj');
      const stdout = record('p1', 1700000000, body, body) + record('p2', 1600000000, body, body);
      const deps = depsWith(okResult(stdout));
      const detail = await remoteSearchClaudeSessionsDetail(HOST, 'needle', deps);
      const bare = await remoteSearchClaudeSessions(HOST, 'needle', deps);
      assert.deepEqual(bare, detail.sessions, 'the projection is exactly the detail variant minus the flag');
      assert.equal(detail.unreachable, false);
      assert.deepEqual(detail.sessions.map((r) => r.id), ['p1', 'p2']);
    });
  });

  describe('remoteSearchClaudeSessionsDetail — the failure channel', () => {
    it('a TRANSPORT failure answers { sessions: [], unreachable: true }', async () => {
      const r = await remoteSearchClaudeSessionsDetail(HOST, 'needle', depsWith(transportDead()));
      assert.deepEqual(r, { sessions: [], unreachable: true });
    });

    it('a COMMAND failure (non-zero exit, real stdout) answers { sessions: [], unreachable: false }', async () => {
      const r = await remoteSearchClaudeSessionsDetail(HOST, 'needle', depsWith(commandFailed()));
      assert.deepEqual(r, { sessions: [], unreachable: false },
        'the command ran, so this is not an unreachable host — the -all scope discipline');
    });

    it('delivers the search script on the 15000ms deadline and reports ok results unreachable: false', async () => {
      let seen = null;
      const r = await remoteSearchClaudeSessionsDetail(HOST, 'needle', {
        isCompanionTransportEnabled: () => true,
        execInContext: async (host, script, opts) => { seen = { host, script, opts }; return okResult(''); },
        run: async () => { throw new Error('never'); },
      });
      assert.deepEqual(r, { sessions: [], unreachable: false });
      assert.equal(seen.host, HOST);
      assert.equal(seen.script, buildSessionSearchScript('needle'), 'the script is built ONCE and delivered byte-for-byte');
      assert.equal(seen.opts.timeout, 15000);
    });
  });

  describe('remoteSearchClaudeSessions — the frozen bare-array projection', () => {
    it('returns [] on a transport failure and never consults run()', async () => {
      const rows = await remoteSearchClaudeSessions(HOST, 'needle', depsWith(transportDead()));
      assert.deepEqual(rows, []);
    });

    it('returns [] on a command failure too (contract frozen: empty on ANY failure)', async () => {
      const rows = await remoteSearchClaudeSessions(HOST, 'needle', depsWith(commandFailed()));
      assert.deepEqual(rows, []);
    });

    it('forwards the deps seam (the query still rides shell-quoted in the delivered script)', async () => {
      let sent = null;
      await remoteSearchClaudeSessions(HOST, "it's; rm -rf /", {
        isCompanionTransportEnabled: () => true,
        execInContext: async (_host, script) => { sent = script; return okResult(''); },
        run: async () => { throw new Error('never'); },
      });
      assert.equal(sent, buildSessionSearchScript("it's; rm -rf /"));
    });
  });
});
