import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';

// WARDEN-1808 — pins the HANDLER GLUE of createChatFileRouter (/api/read-file,
// /api/file-exists, /api/search-files): path/query trimming, the 400/404
// mapping, the file-exists three-state + telemetry hand-offs, the search-files
// local / container / remote split and its failure channels. The helpers the
// handlers call (readChatFile, resolveLocalFile, probeRemoteFile, searchLocalRawResult,
// buildSearchScript, runInContext) have their own suites; those are reached here
// only through the real router, over real HTTP, on a bare express() app with an
// injected `resolve` and a recording telemetry stub (no server.js import).
//
// The remote / container legs run through tiny `ssh` and `docker` shell shims
// prepended to PATH (written below with fs.writeFileSync + chmod): each appends
// its argv to a log file and answers by host / container name. HOME is frozen to
// a temp dir BEFORE the top-level import (module-freeze discipline, see
// file-exists-probe-state.test.js) and the companion transport is forced off so
// the default raw-ssh path carries every script.

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  COMPANION: process.env.WARDEN_COMPANION_TRANSPORT,
};
const originalCwd = process.cwd();

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cfr-'));
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
delete process.env.WARDEN_COMPANION_TRANSPORT;

const shimDir = path.join(tmpRoot, 'bin');
const logFile = path.join(tmpRoot, 'shim.log');
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(logFile, '');

// Every invocation appends "--CALL <name>" then one argv entry per line.
const SSH_SHIM = `#!/bin/bash
{ echo "--CALL ssh"; printf '%s\\n' "$@"; } >> "${logFile}"
host=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--" ]; then host="$a"; break; fi
  prev="$a"
done
sleep 0.2
case "$host" in
  has-it) echo EXISTS ;;
  absent) echo "ERROR file not found"; exit 1 ;;
  broken) echo "ssh: connect to host broken port 22: Connection refused" >&2; exit 255 ;;
  searchok) echo "a.js:3:hello world" ;;
  searchfail) printf 'partial.js:1:leftover\\n'; exit 1 ;;
  *) exit 0 ;;
esac
`;
const DOCKER_SHIM = `#!/bin/bash
{ echo "--CALL docker"; printf '%s\\n' "$@"; } >> "${logFile}"
case "$2" in
  mybox) echo "a.js:3:hello world" ;;
  failbox) printf 'partial.js:1:leftover\\n'; exit 1 ;;
  *) exit 0 ;;
esac
`;
for (const [name, body] of [['ssh', SSH_SHIM], ['docker', DOCKER_SHIM]]) {
  fs.writeFileSync(path.join(shimDir, name), body);
  fs.chmodSync(path.join(shimDir, name), 0o755);
}
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;

const { createChatFileRouter } = await import('./chatFileRoutes.js');

const LOCAL = '(local)';
const readLog = () => fs.readFileSync(logFile, 'utf8');
const clearLog = () => fs.writeFileSync(logFile, '');

let server;
let baseUrl;
let chats;
let calls;
let workDir;
let gitDir;
let noCwdDir;

const telemetry = {
  recordCacheHits: (n) => calls.push(['cacheHits', n]),
  recordProbe: (kind, ms, ok) => calls.push(['probe', kind, ms, ok]),
  recordRemoteFailure: (reason, ms) => calls.push(['failure', reason, ms]),
};

const post = async (route, body) => {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  workDir = path.join(tmpRoot, 'work');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'real.txt'), 'hello\n');

  noCwdDir = path.join(tmpRoot, 'nocwd');
  fs.mkdirSync(noCwdDir);
  fs.writeFileSync(path.join(noCwdDir, 'rel.txt'), 'rel\n');

  gitDir = path.join(tmpRoot, 'repo');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, 'a.txt'), 'find the needle here\n');
  execFileSync('git', ['init', '-q'], { cwd: gitDir });
  execFileSync('git', ['add', 'a.txt'], { cwd: gitDir });

  const resolve = async (id) => {
    const chat = chats.get(id);
    return chat ? { chat } : { error: `chat not found: ${id}` };
  };
  const app = express();
  app.use(express.json());
  app.use(createChatFileRouter({ resolve, fileExistsTelemetry: telemetry, local: LOCAL }));
  await new Promise((resolveListen) => {
    server = app.listen(0, '127.0.0.1', resolveListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  process.chdir(originalCwd);
  process.env.PATH = originalEnv.PATH;
  process.env.HOME = originalEnv.HOME;
  if (originalEnv.COMPANION === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = originalEnv.COMPANION;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  clearLog();
  chats = new Map([
    ['local', { host: LOCAL, cwd: workDir }],
    ['local-nocwd', { host: LOCAL }],
  ]);
});

describe('POST /api/read-file', () => {
  it('unknown chat → 404 with the resolver body', async () => {
    const r = await post('/api/read-file', { id: 'nope', path: 'real.txt' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'chat not found: nope' });
  });

  for (const [label, body] of [
    ['blank', { id: 'local', path: '' }],
    ['whitespace-only', { id: 'local', path: '   ' }],
    ['undefined', { id: 'local' }],
  ]) {
    it(`${label} path → 400 path is required`, async () => {
      const r = await post('/api/read-file', body);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'path is required' });
    });
  }

  it('trims the path and echoes the TRIMMED path with the content', async () => {
    const r = await post('/api/read-file', { id: 'local', path: '  real.txt  ' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { content: 'hello\n', path: 'real.txt' });
  });

  it("a missing file surfaces readChatFile's own status + error", async () => {
    const r = await post('/api/read-file', { id: 'local', path: 'missing.txt' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'file not found' });
  });
});

describe('POST /api/file-exists', () => {
  it('unknown chat → 200 {exists:false} with NO telemetry', async () => {
    const r = await post('/api/file-exists', { id: 'nope', path: 'real.txt', cacheHits: 3 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { exists: false });
    assert.deepEqual(calls, []);
  });

  for (const [label, p] of [['blank', ''], ['whitespace-only', '   '], ['undefined', undefined]]) {
    it(`${label} path → {exists:false} before any probe/telemetry (even with cacheHits)`, async () => {
      const r = await post('/api/file-exists', { id: 'local', path: p, cacheHits: 5 });
      assert.deepEqual(r.body, { exists: false });
      assert.deepEqual(calls, []);
    });
  }

  it('local hit: trims the path, folds cacheHits FIRST, then exactly one probe(local, ms, true)', async () => {
    const r = await post('/api/file-exists', { id: 'local', path: '  real.txt ', cacheHits: 4 });
    assert.deepEqual(r.body, { exists: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['cacheHits', 4]);
    assert.equal(calls[1][0], 'probe');
    assert.equal(calls[1][1], 'local');
    assert.equal(typeof calls[1][2], 'number');
    assert.ok(calls[1][2] >= 0);
    assert.equal(calls[1][3], true);
  });

  it('local miss records the probe with ok=false', async () => {
    const r = await post('/api/file-exists', { id: 'local', path: 'missing.txt' });
    assert.deepEqual(r.body, { exists: false });
    const probes = calls.filter((c) => c[0] === 'probe');
    assert.equal(probes.length, 1);
    assert.equal(probes[0][1], 'local');
    assert.equal(probes[0][3], false);
  });

  it('a chat without cwd probes relative to "."', async () => {
    process.chdir(noCwdDir);
    try {
      const hit = await post('/api/file-exists', { id: 'local-nocwd', path: 'rel.txt' });
      assert.deepEqual(hit.body, { exists: true });
      const miss = await post('/api/file-exists', { id: 'local-nocwd', path: 'nope.txt' });
      assert.deepEqual(miss.body, { exists: false });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('remote EXISTS → {exists:true}, one probe(remote, elapsed>=150, true), script carries the quoted cwd', async () => {
    chats.set('r', { host: 'has-it', cwd: '/srv/my proj' });
    const r = await post('/api/file-exists', { id: 'r', path: 'a.js' });
    assert.deepEqual(r.body, { exists: true });
    // cacheHits (undefined here) is still folded first, then exactly one probe.
    assert.deepEqual(calls[0], ['cacheHits', undefined]);
    const probes = calls.filter((c) => c[0] === 'probe');
    assert.equal(calls.length, 2);
    assert.equal(probes.length, 1);
    assert.equal(probes[0][1], 'remote');
    assert.ok(probes[0][2] >= 150, `elapsed ${probes[0][2]} should cover the shim's sleep`);
    assert.equal(probes[0][3], true);
    assert.match(readLog(), /\/srv\/my proj/);
  });

  it('remote chat without cwd probes relative to "."', async () => {
    chats.set('r', { host: 'has-it' });
    await post('/api/file-exists', { id: 'r', path: 'a.js' });
    // buildFileExistsScript receives '.' as the cwd (quoted inside bash -lc '…').
    assert.ok(readLog().includes("CWD='\\''.'\\''"), readLog());
  });

  it('remote conclusive absence → {exists:false} with NO failed key, filed as probe(remote,…,false), no failure record', async () => {
    chats.set('r', { host: 'absent', cwd: '/srv/proj' });
    const r = await post('/api/file-exists', { id: 'r', path: 'a.js' });
    assert.deepEqual(r.body, { exists: false });
    assert.equal('failed' in r.body, false);
    assert.equal(calls.filter((c) => c[0] === 'failure').length, 0);
    const probes = calls.filter((c) => c[0] === 'probe');
    assert.equal(probes.length, 1);
    assert.equal(probes[0][1], 'remote');
    assert.equal(probes[0][3], false);
  });

  it('remote transport failure → {exists:false, failed:true}, one recordRemoteFailure("error", elapsed>=150), NO probe record', async () => {
    chats.set('r', { host: 'broken', cwd: '/srv/proj' });
    const r = await post('/api/file-exists', { id: 'r', path: 'a.js' });
    assert.deepEqual(r.body, { exists: false, failed: true });
    const failures = calls.filter((c) => c[0] === 'failure');
    assert.equal(failures.length, 1);
    assert.equal(failures[0][1], 'error');
    assert.ok(failures[0][2] >= 150, `elapsed ${failures[0][2]} should cover the shim's sleep`);
    assert.equal(calls.filter((c) => c[0] === 'probe').length, 0);
  });
});

describe('POST /api/search-files', () => {
  it('unknown chat → 404 with the resolver body', async () => {
    const r = await post('/api/search-files', { id: 'nope', query: 'x' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'chat not found: nope' });
  });

  for (const [label, q] of [['blank', ''], ['whitespace-only', '   '], ['undefined', undefined]]) {
    it(`${label} query → 400 query is required`, async () => {
      const r = await post('/api/search-files', { id: 'local', query: q });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'query is required' });
    });
  }

  it('no resolvable cwd (remote chat, no cwd) → {results:[], query, error:"no cwd"} and nothing is shelled out', async () => {
    chats.set('r', { host: 'searchok' });
    const r = await post('/api/search-files', { id: 'r', query: '  hello ' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { results: [], query: 'hello', error: 'no cwd' });
    assert.equal(readLog(), '');
  });

  it('manual-local repo: query echoed trimmed, results from the host fs, no ssh/docker involved', async () => {
    chats.set('g', { host: LOCAL, cwd: gitDir });
    const r = await post('/api/search-files', { id: 'g', query: '  needle  ' });
    assert.equal(r.status, 200);
    assert.equal(r.body.query, 'needle');
    assert.equal('error' in r.body, false);
    assert.deepEqual(r.body.results.map((x) => x.file), ['a.txt']);
    assert.equal(r.body.results[0].line, 1);
    assert.match(r.body.results[0].text, /needle/);
    assert.equal(readLog(), '');
  });

  it('manual-local repo whose git index is corrupt (git grep exit 128) → error "search failed", not a confident empty (WARDEN-1952)', async () => {
    const badDir = path.join(tmpRoot, 'badrepo');
    fs.mkdirSync(badDir);
    fs.writeFileSync(path.join(badDir, 'a.txt'), 'needle\n');
    execFileSync('git', ['init', '-q'], { cwd: badDir });
    fs.writeFileSync(path.join(badDir, '.git', 'index'), 'garbage\n');
    chats.set('bad', { host: LOCAL, cwd: badDir });
    const r = await post('/api/search-files', { id: 'bad', query: 'needle' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { results: [], query: 'needle', error: 'search failed' });
  });

  it('local container chat → docker exec <box> bash -lc, results parsed into {file,line,text}', async () => {
    chats.set('c', { host: LOCAL, container: 'mybox', cwd: '/srv/proj' });
    const r = await post('/api/search-files', { id: 'c', query: 'hello' });
    assert.deepEqual(r.body, {
      results: [{ file: 'a.js', line: 3, text: 'hello world' }],
      query: 'hello',
    });
    const log = readLog();
    assert.match(log, /--CALL docker\nexec\nmybox\nbash\n-lc\n/);
    assert.doesNotMatch(log, /--CALL ssh/);
  });

  it("remote chat → parsed results; ssh argv carries ConnectTimeout=10 (the handler's 10s timeout), the cwd cd and the quoted -F query", async () => {
    chats.set('r', { host: 'searchok', cwd: '/srv/proj' });
    const r = await post('/api/search-files', { id: 'r', query: ' hello ' });
    assert.deepEqual(r.body, {
      results: [{ file: 'a.js', line: 3, text: 'hello world' }],
      query: 'hello',
    });
    const log = readLog();
    assert.match(log, /ConnectTimeout=10\n/);
    // The script rides inside `bash -lc '<script>'`, so its own single quotes
    // appear in the shim's argv in the '\'' escaped form.
    assert.ok(log.includes("cd '\\''/srv/proj'\\''"), log);
    assert.ok(log.includes("-F -- '\\''hello'\\''"), log);
  });

  it('failed remote run (exit 1 with partial stdout) → {results:[], query, error:"search failed"}; partial stdout dropped', async () => {
    chats.set('r', { host: 'searchfail', cwd: '/srv/proj' });
    const r = await post('/api/search-files', { id: 'r', query: 'leftover' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { results: [], query: 'leftover', error: 'search failed' });
  });

  it('failed container run (docker exit 1 with partial stdout) → the same search-failed body', async () => {
    chats.set('c', { host: LOCAL, container: 'failbox', cwd: '/srv/proj' });
    const r = await post('/api/search-files', { id: 'c', query: 'leftover' });
    assert.deepEqual(r.body, { results: [], query: 'leftover', error: 'search failed' });
  });

  it('a transport that throws → 200 generic "search failed", no internals leaked', async () => {
    chats.set('t', { host: 'secret\0host', cwd: '/srv/proj' });
    const r = await post('/api/search-files', { id: 't', query: 'hello' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { results: [], query: 'hello', error: 'search failed' });
    assert.doesNotMatch(JSON.stringify(r.body), /secret|TypeError|ERR_INVALID/);
  });
});

