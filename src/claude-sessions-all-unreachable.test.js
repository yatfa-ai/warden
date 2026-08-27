import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { remoteClaudeSessionsDetail } from './claudeSessions.js';

/**
 * WARDEN-1200 — `/api/claude-sessions-all` must not silently DROP an unreachable host.
 *
 * THE BUG. WARDEN-1196 built the transport-failure discriminator
 * (`remoteClaudeSessionsDetail` → `{sessions, unreachable}`) and adopted it on the
 * single-host `/api/claude-sessions`. The cross-host route never adopted it: it called
 * the deliberately-frozen bare-array `remoteClaudeSessions`, which returns `[]` for an
 * unreachable host — indistinguishable from "this host has no sessions". That `[]` was
 * merged away by `mergeAndPaginateSessions` and the route answered a clean 200 with no
 * error vocabulary on ANY path. Host A reachable-and-empty + host B unreachable
 * therefore rendered "Nothing runnable on the selected hosts yet" — a confident factual
 * claim about the user's fleet, made while a whole machine's history had been dropped.
 *
 * Second-order: `hasMore` and `totals` are computed over the SURVIVING buckets only, so
 * an unreachable host also made pagination and the token rollup quietly wrong, with no
 * way for the client to know.
 *
 * WHY THIS IS A SEPARATE FILE FROM server-claude-sessions.test.js. `cfg` is read ONCE
 * at module scope in src/server.js (`const cfg = load()`, :56), so a file's config is
 * frozen at the first import of the app and cannot be varied between describes. That
 * existing file seeds `{"hosts": []}` — which is exactly the coverage gap that let this
 * bug survive: with no remote hosts, no remote leg is ever driven through this route.
 * A fleet containing a remote host therefore needs its own process, which `node --test`
 * gives per file. The fully-reachable counterpart assertion lives in that file, where
 * the local-only fleet already is.
 *
 * HARNESS (copied from claude-sessions-unreachable.test.js:218-275). Boots the real
 * Express app on an ephemeral port against a throwaway HOME whose config names
 * `nonexistent.invalid`. NO SSH is mocked: `run()` genuinely fails to reach that host,
 * which is precisely the production failure being reproduced. The same HOME is seeded
 * with real local .jsonl sessions, so the fleet is genuinely MIXED — one host that
 * answers with rows, one that cannot be reached.
 */

// Seed `count` fake .jsonl sessions under <tempHome>/.claude/projects/testproj/, s00
// oldest. Each carries a `cwd` because the real localClaudeSessions() drops a session
// without one. (Same seeding as server-claude-sessions.test.js:188-202.)
function seedLocalSessions(tempHome, count) {
  const projDir = path.join(tempHome, '.claude', 'projects', 'testproj');
  fs.mkdirSync(projDir, { recursive: true });
  const base = 1_700_000_000; // fixed epoch (seconds) → deterministic mtimes
  for (let i = 0; i < count; i++) {
    const id = `s${String(i).padStart(2, '0')}`;
    const file = path.join(projDir, `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ cwd: `/${id}` }) + '\n');
    fs.utimesSync(file, base + i, base + i);
  }
}

describe('GET /api/claude-sessions-all — a PARTIAL fleet (WARDEN-1200)', () => {
  let httpServer, baseUrl, tempHome, originalHome;
  const LOCAL_SESSIONS = 3;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1200-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    // A MIXED fleet: the implicit (local) host, plus one remote that cannot be reached.
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: ['nonexistent.invalid'] }));
    // Local rows so "the reachable hosts' data survives" is a real assertion and not
    // vacuously true against an empty list.
    seedLocalSessions(tempHome, LOCAL_SESSIONS);

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

  it('KEEPS the reachable hosts rows AND names the unreachable host — 200, not a failure', async () => {
    // THE load-bearing test, and the one that pins the SHAPE choice. The rejected
    // alternative (a top-level `error` key, as the sibling single-host route uses)
    // would make the client seam throw; OpenChatBrowserPage's catch deliberately never
    // seats a list, so on a first load `allSessions` would stay `[]` and the page would
    // render "Could not load sessions" INSTEAD of these local rows. That trades a
    // false-empty for a false-total-failure. A partial fleet is a partial SUCCESS.
    const res = await fetch(`${baseUrl}/api/claude-sessions-all`);
    const body = await res.json();

    assert.strictEqual(res.status, 200, 'the reachable hosts answered — this is not a failed read');
    assert.strictEqual(body.sessions.length, LOCAL_SESSIONS,
      'the rows from the host that DID answer must survive — losing them is the over-correction');
    assert.deepStrictEqual(body.unreachableHosts, ['nonexistent.invalid'],
      'the dropped machine must be NAMED — this is the whole point of the ticket');
    assert.strictEqual(body.error, undefined,
      'NO top-level error: the client seam throws on one, which would blank the rows above');
  });

  it('still answers the full pre-existing body — unreachableHosts is purely ADDITIVE', async () => {
    // A partial fleet must not degrade the fields a client already reads. `hasMore` and
    // `totals` remain computed over the SURVIVING buckets (unavoidable — the missing
    // rows are on the machine we could not read); `unreachableHosts` is what makes that
    // partiality knowable instead of silent.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all`)).json();

    assert.ok(Array.isArray(body.sessions));
    assert.strictEqual(typeof body.hasMore, 'boolean');
    assert.ok(body.totals && typeof body.totals === 'object', 'the WARDEN-367 rollup is untouched');
    assert.ok(body.totals.byHost && typeof body.totals.byHost === 'object');
  });

  it('never invents rows for the host it could not read', async () => {
    // The other half of honesty: disclosing the gap must not be confused with filling
    // it. Every returned row belongs to a host that actually answered.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all`)).json();

    assert.ok(body.sessions.every((s) => s.host !== 'nonexistent.invalid'),
      'no session may be attributed to a machine we never reached');
  });

  it('survives pagination — a later page still discloses the partial fleet', async () => {
    // The notice must not be a page-1-only artifact: the client replaces its
    // unreachable set on every page, so a page that dropped the key would silently
    // retire the notice while the fleet was still incomplete.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all?offset=1&limit=1`)).json();

    assert.deepStrictEqual(body.unreachableHosts, ['nonexistent.invalid']);
    assert.strictEqual(body.sessions.length, 1, 'the page window itself is unchanged');
  });

  it('the (local) host is never reported unreachable — it does no SSH', async () => {
    // Scope guard, inherited from WARDEN-1196: localClaudeSessions is a FILESYSTEM
    // read, so `isTransportFailure` has no meaning for it and it can never be named
    // here. Asserted rather than assumed, because the route builds one bucket list over
    // both legs and a careless refactor could apply the remote classifier to both.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all`)).json();

    assert.ok(!body.unreachableHosts.includes('(local)'),
      'a filesystem read has no transport to fail');
  });
});

describe('WARDEN-1200 over-correction guard — what must NOT be called unreachable', () => {
  // The route derives its list by filtering EXACTLY on the discriminator's flag
  // (`settled.filter((b) => b.unreachable).map((b) => b.host)`, src/server.js), so a
  // host the discriminator reports as `unreachable: false` cannot appear in the wire
  // response. That derivation is the trivial half; the classification is the half that
  // can be got wrong, and it is what these assert.
  //
  // These drive `remoteClaudeSessionsDetail`'s `deps.run` seam rather than the HTTP
  // route because a COMMAND failure cannot be produced over real SSH in CI (Node 20 has
  // no `mock.module`, hence the seam) — so the honest claim here is about the
  // classification the route consumes, not about a wire body observed under that state.
  const result = (over = {}) => ({ ok: false, code: 1, stdout: '', stderr: '', ...over });

  it('a non-zero exit WITH real stdout classifies as unreachable:false — a COMMAND failure', async () => {
    // The case that makes "report every failure as unreachable" wrong. The machine
    // answered — it ran the command and produced output — so naming it unreachable
    // would be a fresh false claim in the opposite direction. `isTransportFailure`
    // (src/ssh.js) returns false whenever stdout is non-empty, by design.
    const run = async () => result({ code: 2, stdout: 'some output the command produced\n', stderr: 'grep: bad thing' });

    const detail = await remoteClaudeSessionsDetail('livehost', 40, { run });

    assert.strictEqual(detail.unreachable, false,
      'a host that produced stdout provably ran the command — the route must not name it');
    assert.deepStrictEqual(detail.sessions, [], 'still degrades to the pre-existing empty list');
  });

  it('an auth failure classifies as unreachable:false — not transport, deliberately excluded', async () => {
    const run = async () => result({ code: 255, stderr: 'Permission denied (publickey).\n' });

    const detail = await remoteClaudeSessionsDetail('authfail', 40, { run });

    assert.strictEqual(detail.unreachable, false, 'the route lists transport failures only');
  });

  it('a REACHABLE host with zero sessions classifies as unreachable:false — the empty state survives', async () => {
    // Criterion 3: a genuinely empty fleet must keep rendering "Nothing runnable on the
    // selected hosts yet". If this leaked `true`, the notice would replace that string
    // for every user whose hosts simply have no sessions.
    const run = async () => result({ ok: true, code: 0, stdout: '' });

    const detail = await remoteClaudeSessionsDetail('emptyhost', 40, { run });

    assert.deepStrictEqual(detail, { sessions: [], unreachable: false },
      'empty is a fact about the host CONTENTS; unreachable is a fact about the READ');
  });
});
