import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// WARDEN-1924 — pins createClaudeSessionsRouter (src/claudeSessionsRoutes.js,
// the Claude-session HTTP layer WARDEN-1740/1741 moved out of server.js with no
// spec of its own): /api/claude-sessions, /api/claude-sessions-all,
// /api/claude-sessions-search and /api/claude-session. The server-level suites
// reach these routes but leave the glue branches (page-window clamps, partial-
// fleet disclosure, search trim/caps, the remote `before` plumbing) unasserted.
//
// A UNIT harness: the REAL router mounted on a bare express() app (never
// server.js). HOME is frozen to a temp dir BEFORE the dynamic imports. The
// shared sessionCache is a fake whose `snapshot(hosts, limit)` records its
// arguments and returns canned buckets. Remote legs run through the REAL
// claudeSessions.js / ssh.js / companion.js (companion toggle OFF) against a
// fake `ssh` on PATH that answers by host and script kind (list / claude /
// search / read). ControlMaster `-O` probes succeed; a missing canned file
// answers like a transport failure ("Could not resolve hostname"). Every
// non-probe call is recorded so tests can assert what was (not) run.

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  COMPANION: process.env.WARDEN_COMPANION_TRANSPORT,
  EXECPATH: process.env.CLAUDE_CODE_EXECPATH,
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-claudeSessionsRoutes-'));
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
delete process.env.WARDEN_COMPANION_TRANSPORT;

const shimDir = path.join(tmpRoot, 'bin');
const cannedDir = path.join(tmpRoot, 'canned');
const callsDir = path.join(tmpRoot, 'calls');
for (const d of [shimDir, cannedDir, callsDir]) fs.mkdirSync(d, { recursive: true });

const SSH_SHIM = `#!/bin/bash
host=""; cmd=""; ctl=0
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  a="\${args[$i]}"
  if [ "$a" = "-O" ]; then ctl=1; fi
  if [ "$a" = "--" ]; then host="\${args[$((i+1))]}"; cmd="\${args[$((i+2))]}"; break; fi
done
[ "$ctl" = 1 ] && exit 0
case "$cmd" in
  *___NOSESSION*) kind=read ;;
  *___SNIP*) kind=search ;;
  *"command -v claude"*) kind=claude ;;
  *___S*) kind=list ;;
  *) kind=other ;;
esac
f=$(mktemp "${callsDir}/call.XXXXXX")
printf '%s' "$host" > "$f"
printf '%s' "$kind" > "$f.kind"
printf '%s' "$cmd" > "$f.cmd"
safe=$(printf '%s' "$host" | tr -c 'a-zA-Z0-9' '_')
file="${cannedDir}/$safe/$kind"
if [ -f "$file" ]; then cat "$file"; if [ -f "$file.exit" ]; then exit "$(cat "$file.exit")"; fi; exit 0; fi
echo "ssh: Could not resolve hostname $host: Name or service not known" >&2
exit 255
`;
fs.writeFileSync(path.join(shimDir, 'ssh'), SSH_SHIM);
fs.chmodSync(path.join(shimDir, 'ssh'), 0o755);
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;

const claudeStub = path.join(tmpRoot, 'claude-stub');
fs.writeFileSync(claudeStub, '#!/bin/sh\nexit 0\n');
fs.chmodSync(claudeStub, 0o755);
process.env.CLAUDE_CODE_EXECPATH = claudeStub;

const { createClaudeSessionsRouter } = await import('./claudeSessionsRoutes.js');

const LOCAL = '(local)';
const projectsDir = path.join(process.env.HOME, '.claude', 'projects');

const cfg = { hosts: [] };
let snapshotCalls;
let snapshotBuckets;
let server;
let base;

const sessionCache = {
  async snapshot(hosts, limit) {
    snapshotCalls.push({ hosts: [...hosts], limit });
    return snapshotBuckets;
  },
};

const get = async (route) => {
  const res = await fetch(`${base}${route}`);
  return { status: res.status, body: await res.json() };
};

// ---- fake-ssh helpers ----
const safeName = (host) => host.replace(/[^a-zA-Z0-9]/g, '_');
const can = (host, kind, stdout) => {
  const d = path.join(cannedDir, safeName(host));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, kind), stdout);
};
const sshCalls = () => fs.readdirSync(callsDir)
  .filter((n) => /^call\.[^.]+$/.test(n))
  .map((n) => {
    const p = path.join(callsDir, n);
    return {
      host: fs.readFileSync(p, 'utf8'),
      kind: fs.readFileSync(`${p}.kind`, 'utf8'),
      cmd: fs.readFileSync(`${p}.cmd`, 'utf8'),
    };
  });
const callsOf = (host, kind) => sshCalls().filter((c) => c.host === host && c.kind === kind);

// ---- transcript / session fixtures ----
const userLine = (text, extra = {}) => JSON.stringify({
  type: 'user', cwd: '/w/proj', message: { role: 'user', content: text }, timestamp: '2026-01-01T00:00:00Z', ...extra,
});
const assistantLine = (text, usage) => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', content: text, ...(usage ? { usage } : {}) }, timestamp: '2026-01-01T00:00:01Z',
});
const listOut = (rows) => rows.map((r) => `___S\t${r.id}\t${r.mt}\n${userLine(r.summary ?? 'hello', { cwd: r.cwd ?? '/w/proj' })}\n\n___E\t${r.id}\n`).join('');
const searchOut = (rows) => rows.map((r) => {
  const line = userLine(`the ${r.needle ?? 'needle'} appears here`, { cwd: r.cwd ?? '/w/proj' });
  return `___S\t${r.id}\t${r.mt}\n${line}\n___SNIP\t${line}\n___E\t${r.id}\n`;
}).join('');

const writeLocalSession = (id, lines, mtimeSecs) => {
  const dir = path.join(projectsDir, '-w-proj');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, lines.join('\n') + '\n');
  if (mtimeSecs != null) fs.utimesSync(fp, mtimeSecs, mtimeSecs);
  return fp;
};

before(async () => {
  const app = express();
  app.use(createClaudeSessionsRouter({ cfg, sessionCache, local: LOCAL }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  for (const [k, v] of [['HOME', originalEnv.HOME], ['PATH', originalEnv.PATH],
    ['WARDEN_COMPANION_TRANSPORT', originalEnv.COMPANION], ['CLAUDE_CODE_EXECPATH', originalEnv.EXECPATH]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  cfg.hosts = [];
  snapshotCalls = [];
  snapshotBuckets = [];
  process.env.CLAUDE_CODE_EXECPATH = claudeStub;
  for (const d of [cannedDir, callsDir, projectsDir]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  fs.mkdirSync(cannedDir, { recursive: true });
  fs.mkdirSync(callsDir, { recursive: true });
});

describe('GET /api/claude-sessions-all', () => {
  const rows = (n, startMtime = 1000, step = -1) => Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, cwd: '/w', summary: `s${i}`, mtime: startMtime + i * step, tokenUsage: null,
  }));

  it('asks the cache for [LOCAL, ...cfg.hosts], re-reading cfg.hosts on every request', async () => {
    cfg.hosts = ['a@one', 'b@two'];
    await get('/api/claude-sessions-all');
    cfg.hosts = ['c@three'];
    await get('/api/claude-sessions-all');
    assert.deepEqual(snapshotCalls.map((c) => c.hosts), [[LOCAL, 'a@one', 'b@two'], [LOCAL, 'c@three']]);
  });

  for (const [query, expectedLimit] of [
    ['', 41], // default page of 40, +1 boundary row
    ['?limit=10&offset=5', 16],
    ['?limit=500', 201], // limit clamps to 200 first
    ['?limit=0', 41], // falsy → default 40
    ['?limit=-5', 2], // clamps up to 1
    ['?limit=abc', 41],
    ['?offset=-3', 41], // negative offset floors at 0
    ['?offset=garbage&limit=10', 11],
    ['?offset=5000&limit=200', 1000], // per-host window ceiling
    ['?offset=999&limit=1', 1000],
    ['?offset=998&limit=1', 1000],
    ['?offset=997&limit=1', 999],
  ]) {
    it(`fetch window for ${query || '(no params)'} is ${expectedLimit}`, async () => {
      const r = await get(`/api/claude-sessions-all${query}`);
      assert.equal(r.status, 200);
      assert.equal(snapshotCalls.length, 1);
      assert.equal(snapshotCalls[0].limit, expectedLimit);
    });
  }

  it('never serves more than 200 rows even when asked for more, and reports hasMore', async () => {
    snapshotBuckets = [{ host: LOCAL, sessions: rows(300) }];
    const r = await get('/api/claude-sessions-all?limit=1000');
    assert.equal(r.body.sessions.length, 200);
    assert.equal(r.body.hasMore, true);
    assert.equal(r.body.sessions[0].id, 's0');
    assert.equal(r.body.sessions[199].id, 's199');
  });

  it('defaults to 40 rows per page and floors a negative offset at 0', async () => {
    snapshotBuckets = [{ host: LOCAL, sessions: rows(60) }];
    const r = await get('/api/claude-sessions-all?offset=-10');
    assert.equal(r.body.sessions.length, 40);
    assert.equal(r.body.sessions[0].id, 's0');
    assert.equal(r.body.hasMore, true);
    const page2 = await get('/api/claude-sessions-all?offset=40');
    assert.equal(page2.body.sessions.length, 20);
    assert.equal(page2.body.sessions[0].id, 's40');
    assert.equal(page2.body.hasMore, false);
  });

  it('tags each row with its bucket host and merges the buckets newest-first', async () => {
    snapshotBuckets = [
      { host: LOCAL, sessions: [{ id: 'l1', mtime: 500, tokenUsage: null }, { id: 'l2', mtime: 100, tokenUsage: null }] },
      { host: 'u@h', sessions: [{ id: 'r1', mtime: 900, tokenUsage: null }, { id: 'r2', mtime: 300, tokenUsage: null }] },
    ];
    const r = await get('/api/claude-sessions-all');
    assert.deepEqual(r.body.sessions.map((s) => [s.id, s.host]), [
      ['r1', 'u@h'], ['l1', LOCAL], ['r2', 'u@h'], ['l2', LOCAL],
    ]);
    assert.equal(r.body.hasMore, false);
  });

  it('rolls token usage up over the returned page by host', async () => {
    const tu = (n) => ({ input: n, output: n, cacheCreation: 0, cacheRead: 0, total: 2 * n });
    snapshotBuckets = [
      { host: LOCAL, sessions: [{ id: 'l1', mtime: 2, tokenUsage: tu(1) }] },
      { host: 'u@h', sessions: [{ id: 'r1', mtime: 1, tokenUsage: tu(5) }] },
    ];
    const r = await get('/api/claude-sessions-all');
    assert.equal(r.body.totals.grand.total, 12);
    assert.equal(r.body.totals.byHost[LOCAL].total, 2);
    assert.equal(r.body.totals.byHost['u@h'].total, 10);
  });

  it('omits unreachableHosts / pendingHosts when every host answered', async () => {
    snapshotBuckets = [
      { host: LOCAL, sessions: rows(1) },
      { host: 'u@h', sessions: rows(1), unreachable: false, pending: false },
    ];
    const r = await get('/api/claude-sessions-all');
    assert.equal(r.status, 200);
    assert.equal('unreachableHosts' in r.body, false);
    assert.equal('pendingHosts' in r.body, false);
    assert.equal('error' in r.body, false);
    assert.deepEqual(Object.keys(r.body).sort(), ['hasMore', 'sessions', 'totals']);
  });

  it('partitions unreachable and pending hosts, keeps serving the rest, and sends no top-level error', async () => {
    snapshotBuckets = [
      { host: LOCAL, sessions: [{ id: 'l1', mtime: 10, tokenUsage: null }] },
      { host: 'dead@x', sessions: [], unreachable: true },
      { host: 'cold@y', sessions: [], pending: true },
      { host: 'fill@z', sessions: [{ id: 'z1', mtime: 20, tokenUsage: null }], pending: true },
      { host: 'ok@w', sessions: [{ id: 'w1', mtime: 30, tokenUsage: null }], unreachable: false },
    ];
    const r = await get('/api/claude-sessions-all');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.unreachableHosts, ['dead@x']);
    assert.deepEqual(r.body.pendingHosts, ['cold@y', 'fill@z']);
    assert.equal('error' in r.body, false);
    // the under-filled pending host still contributes its real rows
    assert.deepEqual(r.body.sessions.map((s) => s.id), ['w1', 'z1', 'l1']);
  });

  it('emits only unreachableHosts when nothing is pending, and only pendingHosts when nothing is unreachable', async () => {
    snapshotBuckets = [{ host: 'dead@x', sessions: [], unreachable: true }];
    const a = await get('/api/claude-sessions-all');
    assert.deepEqual(a.body.unreachableHosts, ['dead@x']);
    assert.equal('pendingHosts' in a.body, false);
    snapshotBuckets = [{ host: 'cold@y', sessions: [], pending: true }];
    const b = await get('/api/claude-sessions-all');
    assert.deepEqual(b.body.pendingHosts, ['cold@y']);
    assert.equal('unreachableHosts' in b.body, false);
  });
});

describe('GET /api/claude-sessions-search', () => {
  it('400s "query required" for a missing, empty or whitespace-only q and runs nothing', async () => {
    cfg.hosts = ['u@search'];
    for (const route of ['/api/claude-sessions-search', '/api/claude-sessions-search?q=', '/api/claude-sessions-search?q=%20%20%09']) {
      const r = await get(route);
      assert.deepEqual(r, { status: 400, body: { error: 'query required' } }, route);
    }
    assert.equal(sshCalls().length, 0);
  });

  it('trims q before searching: a padded query matches and the remote script carries the trimmed literal', async () => {
    cfg.hosts = ['u@search'];
    can('u@search', 'search', searchOut([{ id: 'r1', mt: 1000 }]));
    const r = await get('/api/claude-sessions-search?q=%20%20needle%20%20');
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 1);
    const [call] = callsOf('u@search', 'search');
    assert.ok(call, 'the remote host was actually searched');
    // the script is itself shell-quoted into `bash -lc '...'`, so the literal's quotes appear escaped
    assert.ok(call.cmd.includes("-- '\\''needle'\\'' \"$f\""), call.cmd);
  });

  it('shapes each result as {host, sessionId, cwd, summary, snippet, mtime} (mtime in ms)', async () => {
    cfg.hosts = ['u@search'];
    can('u@search', 'search', searchOut([{ id: 'abc-1', mt: 1700000000, cwd: '/w/x' }]));
    const r = await get('/api/claude-sessions-search?q=needle');
    assert.deepEqual(r.body, {
      results: [{
        host: 'u@search', sessionId: 'abc-1', cwd: '/w/x',
        summary: 'the needle appears here', snippet: 'the needle appears here', mtime: 1700000000000,
      }],
    });
  });

  it('searches the local archive too, and a tie on mtime keeps host order (local first, then cfg.hosts order)', async () => {
    cfg.hosts = ['u@a', 'u@b'];
    writeLocalSession('loc-1', [userLine('local needle here')], 1700000000);
    can('u@a', 'search', searchOut([{ id: 'a1', mt: 1700000000 }]));
    can('u@b', 'search', searchOut([{ id: 'b1', mt: 1700000000 }]));
    const r = await get('/api/claude-sessions-search?q=needle');
    assert.deepEqual(r.body.results.map((x) => [x.host, x.sessionId]), [
      [LOCAL, 'loc-1'], ['u@a', 'a1'], ['u@b', 'b1'],
    ]);
  });

  it('ranks results newest-first across hosts', async () => {
    cfg.hosts = ['u@a', 'u@b'];
    can('u@a', 'search', searchOut([{ id: 'a-old', mt: 100 }, { id: 'a-new', mt: 900 }]));
    can('u@b', 'search', searchOut([{ id: 'b-mid', mt: 500 }]));
    const r = await get('/api/claude-sessions-search?q=needle');
    assert.deepEqual(r.body.results.map((x) => x.sessionId), ['a-new', 'b-mid', 'a-old']);
  });

  it('drops a failing host and a throwing host without failing the search', async () => {
    cfg.hosts = ['u@good', 'u@down', 'bad\u0000host'];
    can('u@good', 'search', searchOut([{ id: 'g1', mt: 1000 }]));
    const r = await get('/api/claude-sessions-search?q=needle');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x) => x.sessionId), ['g1']);
    assert.equal(callsOf('u@down', 'search').length, 1, 'the failing host was attempted');
  });

  it('discloses a transport-failed host as unreachableHosts without blanking the reachable fleet (WARDEN-1938)', async () => {
    cfg.hosts = ['u@dead', 'u@good'];
    can('u@good', 'search', searchOut([{ id: 'g1', mt: 1000 }]));
    // u@dead has no canned file → the shim answers "ssh: Could not resolve
    // hostname" + exit 255, a TRANSPORT failure (isTransportFailure true).
    const r = await get('/api/claude-sessions-search?q=needle');
    assert.equal(r.status, 200, 'a partial fleet is a partial SUCCESS, never a 500');
    assert.deepEqual(r.body.results.map((x) => x.sessionId), ['g1'], 'the reachable fleet is never blanked');
    assert.deepEqual(r.body.unreachableHosts, ['u@dead']);
    assert.equal('error' in r.body, false, 'a partial search is not an error — it has its own disclosure key');
  });

  it('names only transport failures unreachable — a command failure (non-zero exit, real stdout) degrades to empty (WARDEN-1938)', async () => {
    cfg.hosts = ['u@cmdfail'];
    can('u@cmdfail', 'search', 'the command ran and printed this');
    fs.writeFileSync(path.join(cannedDir, safeName('u@cmdfail'), 'search.exit'), '3');
    const r = await get('/api/claude-sessions-search?q=needle');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { results: [] },
      'no disclosure key: a command result is not an unreachable host (the -all scope discipline)');
  });

  it('caps each host at 20 results and the merged list at 50', async () => {
    const hostNames = ['u@h1', 'u@h2', 'u@h3'];
    cfg.hosts = hostNames;
    const perHost = {};
    hostNames.forEach((h, hi) => {
      const rows = Array.from({ length: 25 }, (_, i) => ({ id: `${h}-${i}`, mt: 1_000_000 + i * 3 + hi }));
      perHost[h] = rows;
      can(h, 'search', searchOut(rows));
    });
    const r = await get('/api/claude-sessions-search?q=needle');
    const results = r.body.results;
    assert.equal(results.length, 50);

    const expected = hostNames
      .flatMap((h) => [...perHost[h]].sort((a, b) => b.mt - a.mt).slice(0, 20).map((x) => ({ host: h, id: x.id, mt: x.mt })))
      .sort((a, b) => b.mt - a.mt)
      .slice(0, 50);
    assert.deepEqual(results.map((x) => x.sessionId), expected.map((x) => x.id));
    assert.deepEqual(results.map((x) => x.mtime), expected.map((x) => x.mt * 1000));

    // a single host never contributes more than 20 even when it owns the newest rows
    cfg.hosts = ['u@solo'];
    can('u@solo', 'search', searchOut(Array.from({ length: 30 }, (_, i) => ({ id: `solo-${i}`, mt: 5000 + i }))));
    const solo = await get('/api/claude-sessions-search?q=needle');
    assert.equal(solo.body.results.length, 20);
    assert.equal(solo.body.results[0].sessionId, 'solo-29');
    assert.equal(solo.body.results[19].sessionId, 'solo-10');
  });
});

describe('GET /api/claude-session', () => {
  const REMOTE = 'u@read';

  it('400s an invalid session id before touching any transport', async () => {
    for (const id of ['', 'a/b', 'a b', '../x']) {
      const r = await get(`/api/claude-session?id=${encodeURIComponent(id)}&host=${REMOTE}`);
      assert.deepEqual(r, { status: 400, body: { error: 'invalid session id' } }, JSON.stringify(id));
    }
    assert.equal((await get(`/api/claude-session?host=${REMOTE}`)).status, 400);
    assert.equal(sshCalls().length, 0);
  });

  for (const bad of ['-5', '1.5', 'abc', '0x10']) {
    it(`400s a malformed before cursor (${bad}) and never reads`, async () => {
      const r = await get(`/api/claude-session?id=s1&host=${REMOTE}&before=${encodeURIComponent(bad)}`);
      assert.deepEqual(r, { status: 400, body: { error: 'invalid before cursor' } });
      const local = await get(`/api/claude-session?id=s1&before=${encodeURIComponent(bad)}`);
      assert.deepEqual(local, { status: 400, body: { error: 'invalid before cursor' } });
      assert.equal(sshCalls().length, 0);
    });
  }

  it('serves the remote first page: cwd, messages (with per-turn usage), truncated=false, hasMore=false', async () => {
    const usage = { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 };
    can(REMOTE, 'read', `___SZ\t300\n___HEAD\n${userLine('hi')}\n___BODY\n${userLine('hi')}\n${assistantLine('yo', usage)}\n`);
    const r = await get(`/api/claude-session?id=s1&host=${REMOTE}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      host: REMOTE,
      cwd: '/w/proj',
      messages: [
        { role: 'user', text: 'hi', ts: '2026-01-01T00:00:00Z' },
        { role: 'assistant', text: 'yo', ts: '2026-01-01T00:00:01Z', usage: { input: 3, output: 4, cacheCreation: 1, cacheRead: 2, total: 10 } },
      ],
      truncated: false,
      hasMore: false,
      prevCursor: 0,
    });
    const [call] = callsOf(REMOTE, 'read');
    assert.ok(call.cmd.includes('s1.jsonl'));
    assert.ok(call.cmd.includes('___HEAD'), 'first page reads a head window');
    assert.ok(call.cmd.includes('tail -c 400000 '), 'first page tails the last window');
    assert.ok(!call.cmd.includes('tail -c +'));
  });

  it('flags a file larger than the body window as truncated with an older page available (line-aligned cursor)', async () => {
    can(REMOTE, 'read', `___SZ\t500000\n___HEAD\n${userLine('hi')}\n___BODY\nhalf-a-line\n${userLine('whole')}\n`);
    const r = await get(`/api/claude-session?id=s1&host=${REMOTE}`);
    assert.equal(r.body.truncated, true);
    assert.equal(r.body.hasMore, true);
    // window start 100000 + the 12 bytes of the partial first line
    assert.equal(r.body.prevCursor, 100012);
    assert.deepEqual(r.body.messages.map((m) => m.text), ['whole']);
  });

  it('forwards ?before to BOTH the remote script (tail -c +N) and the parse (line-aligned prevCursor)', async () => {
    can(REMOTE, 'read', `___SZ\t600000\n\n___BODY\nhalf\n${userLine('older')}\n`);
    const r = await get(`/api/claude-session?id=s1&host=${REMOTE}&before=500000`);
    assert.equal(r.status, 200);
    const [call] = callsOf(REMOTE, 'read');
    assert.ok(call.cmd.includes('tail -c +100001 '), call.cmd);
    assert.ok(call.cmd.includes('head -c 400000'), call.cmd);
    assert.ok(!call.cmd.includes('___HEAD'), 'older pages skip the head read');
    // parse window = [100000, 500000] (NOT size-derived 200000), aligned past the 5-byte partial line
    assert.equal(r.body.prevCursor, 100005);
    assert.equal(r.body.hasMore, true);
    assert.equal(r.body.truncated, false);
    assert.equal(r.body.cwd, '');
    assert.deepEqual(r.body.messages.map((m) => m.text), ['older']);
  });

  it('forwards before=0 as a real (empty-window) cursor, not as "no cursor"', async () => {
    can(REMOTE, 'read', `___SZ\t10\n\n___BODY\n`);
    const r = await get(`/api/claude-session?id=s1&host=${REMOTE}&before=0`);
    assert.equal(r.status, 200);
    const [call] = callsOf(REMOTE, 'read');
    assert.ok(call.cmd.includes('tail -c +1 '), call.cmd);
    assert.ok(call.cmd.includes('head -c 0'), call.cmd);
    assert.equal(r.body.hasMore, false);
  });

  it('treats an empty ?before= as the first page', async () => {
    can(REMOTE, 'read', `___SZ\t300\n___HEAD\n${userLine('hi')}\n___BODY\n${userLine('hi')}\n`);
    const r = await get(`/api/claude-session?id=s1&host=${REMOTE}&before=`);
    assert.equal(r.status, 200);
    const [call] = callsOf(REMOTE, 'read');
    assert.ok(call.cmd.includes('___HEAD'));
    assert.ok(!call.cmd.includes('tail -c +'));
    assert.equal(r.body.cwd, '/w/proj');
  });

  it('404s "session not found" when the remote answers ___NOSESSION', async () => {
    can(REMOTE, 'read', '___NOSESSION\n');
    const r = await get(`/api/claude-session?id=s1&host=${REMOTE}`);
    assert.deepEqual(r, { status: 404, body: { error: 'session not found' } });
  });

  it('answers 200 {host, error:"host unreachable"} when the remote transport fails', async () => {
    const r = await get(`/api/claude-session?id=s1&host=${REMOTE}`);
    assert.deepEqual(r, { status: 200, body: { host: REMOTE, error: 'host unreachable' } });
  });

  it('500s with the error message when the transport throws', async () => {
    const r = await get(`/api/claude-session?id=s1&host=${encodeURIComponent('bad\u0000host')}`);
    assert.equal(r.status, 500);
    assert.equal(typeof r.body.error, 'string');
    assert.ok(r.body.error.length > 0);
    assert.equal(sshCalls().length, 0);
  });

  it('reads a local transcript from disk without any ssh, 404s an unknown id', async () => {
    writeLocalSession('loc-1', [userLine('first'), assistantLine('second')]);
    const r = await get('/api/claude-session?id=loc-1');
    assert.equal(r.status, 200);
    assert.equal(r.body.host, LOCAL);
    assert.equal(r.body.cwd, '/w/proj');
    assert.deepEqual(r.body.messages.map((m) => m.text), ['first', 'second']);
    assert.equal(r.body.hasMore, false);
    assert.equal(r.body.truncated, false);
    assert.equal((await get('/api/claude-session?id=ghost')).status, 404);
    assert.equal(sshCalls().length, 0);
  });

  it('local ?before reads the older window [0, before], skipping the head read', async () => {
    const l1 = userLine('first');
    const l2 = assistantLine('second');
    writeLocalSession('loc-2', [l1, l2, userLine('third')]);
    const before = Buffer.byteLength(l1 + '\n' + l2 + '\n');
    const r = await get(`/api/claude-session?id=loc-2&before=${before}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.messages.map((m) => m.text), ['first', 'second']);
    assert.equal(r.body.cwd, '', 'older pages carry no head, so no cwd');
    assert.equal(r.body.hasMore, false);
    assert.equal(r.body.prevCursor, 0);
  });
});

describe('GET /api/claude-sessions', () => {
  const REMOTE = 'u@list';

  it('remote reachable: serves the sessions and claudeAvailable=true from the probe', async () => {
    can(REMOTE, 'list', listOut([{ id: 'r1', mt: 1700000000 }]));
    can(REMOTE, 'claude', '/usr/local/bin/claude\n');
    const r = await get(`/api/claude-sessions?host=${REMOTE}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.host, REMOTE);
    assert.equal(r.body.claudeAvailable, true);
    assert.deepEqual(r.body.sessions.map((s) => [s.id, s.cwd, s.mtime]), [['r1', '/w/proj', 1700000000000]]);
    assert.ok(callsOf(REMOTE, 'claude').length > 0);
  });

  it('remote reachable without claude: claudeAvailable=false (key present) and zero sessions is still an answer', async () => {
    can(REMOTE, 'list', '');
    can(REMOTE, 'claude', '');
    const r = await get(`/api/claude-sessions?host=${REMOTE}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { host: REMOTE, sessions: [], claudeAvailable: false });
  });

  it('remote unreachable: {host, sessions:[], error} with NO claudeAvailable key and no claude probe', async () => {
    const r = await get(`/api/claude-sessions?host=${REMOTE}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { host: REMOTE, sessions: [], error: 'host unreachable' });
    assert.equal('claudeAvailable' in r.body, false);
    assert.equal(callsOf(REMOTE, 'claude').length, 0, 'no `command -v claude` probe against a dead host');
    assert.equal(callsOf(REMOTE, 'list').length, 1);
  });

  it('no host param defaults to (local): reads disk, probes locally, runs no ssh', async () => {
    writeLocalSession('loc-1', [userLine('local one')]);
    const r = await get('/api/claude-sessions');
    assert.equal(r.status, 200);
    assert.equal(r.body.host, LOCAL);
    assert.equal(r.body.claudeAvailable, true);
    assert.deepEqual(r.body.sessions.map((s) => [s.id, s.cwd, s.summary]), [['loc-1', '/w/proj', 'local one']]);
    assert.equal(sshCalls().length, 0);
  });

  it('local claude missing → claudeAvailable=false', async () => {
    process.env.CLAUDE_CODE_EXECPATH = path.join(tmpRoot, 'does-not-exist');
    const origPath = process.env.PATH;
    process.env.PATH = shimDir; // no real `claude` can be found
    try {
      const r = await get('/api/claude-sessions');
      assert.equal(r.body.claudeAvailable, false);
    } finally {
      process.env.PATH = origPath;
    }
  });
});
