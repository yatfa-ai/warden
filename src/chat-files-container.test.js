import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// WARDEN-1908 — /api/read-file, /api/file-exists and readChatFile must run
// INSIDE a yatfa chat's container (docker exec), never on the host fs / host
// shell. A `docker` shim logs its argv and executes the delivered script with
// the host path prefix rewritten onto a separate "container fs" tree, so the
// same cwd resolves to DIFFERENT content in the container than on the host —
// a host-fs read would return 'HOST', only a real in-container read 'CONTAINER'.
// A remote-container chat goes through an `ssh` shim that runs the delivered
// `docker exec …` command string (so the same docker shim answers).

const originalEnv = { HOME: process.env.HOME, PATH: process.env.PATH, COMPANION: process.env.WARDEN_COMPANION_TRANSPORT };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cfc-'));
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
delete process.env.WARDEN_COMPANION_TRANSPORT;

const hostProj = path.join(tmpRoot, 'host', 'proj');
const boxProj = path.join(tmpRoot, 'box', 'proj');
for (const d of [hostProj, boxProj]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(hostProj, 'a.txt'), 'HOST\n');
fs.writeFileSync(path.join(boxProj, 'a.txt'), 'CONTAINER\n');
fs.writeFileSync(path.join(boxProj, 'only-in-box.txt'), 'BOX-ONLY\n');
fs.writeFileSync(path.join(boxProj, 'bin.txt'), Buffer.from([0x61, 0x00, 0x62]));
fs.writeFileSync(path.join(boxProj, 'pic.png'), 'x');
fs.writeFileSync(path.join(tmpRoot, 'box', 'secret.txt'), 'SECRET\n');
fs.mkdirSync(path.join(boxProj, 'sub'));

const shimDir = path.join(tmpRoot, 'bin');
const logFile = path.join(tmpRoot, 'shim.log');
fs.mkdirSync(shimDir);
fs.writeFileSync(logFile, '');
// docker exec <container> bash -lc <script> (run with `bash -c`: a login shell
// would reset PATH and lose the shims)
const DOCKER_SHIM = `#!/bin/bash
{ echo "--CALL docker"; printf '%s\\n' "$@"; } >> "${logFile}"
[ "$1" = exec ] || exit 2
[ "$2" = downbox ] && { echo "Error: No such container: downbox" >&2; exit 1; }
script="\${5//${hostProj.replace(/\//g, '\\/')}/${boxProj.replace(/\//g, '\\/')}}"
exec bash -c "$script"
`;
// ssh … -- <host> <remote command string>
const SSH_SHIM = `#!/bin/bash
{ echo "--CALL ssh"; printf '%s\\n' "$@"; } >> "${logFile}"
cmd="\${@: -1}"
cmd="\${cmd#bash -lc }"
eval "bash -c $cmd"
`;
for (const [n, b] of [['docker', DOCKER_SHIM], ['ssh', SSH_SHIM]]) {
  fs.writeFileSync(path.join(shimDir, n), b);
  fs.chmodSync(path.join(shimDir, n), 0o755);
}
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;

const { createChatFileRouter } = await import('./chatFileRoutes.js');
const { readChatFile, readWorkingTreeFile } = await import('./chatFiles.js');

const LOCAL = '(local)';
const readLog = () => fs.readFileSync(logFile, 'utf8');
let server; let baseUrl; let chats; let calls;
const telemetry = {
  recordCacheHits: () => {},
  recordProbe: (kind, ms, ok) => calls.push(['probe', kind, ok]),
  recordRemoteFailure: (reason) => calls.push(['failure', reason]),
};
const post = async (route, body) => {
  const res = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  const resolve = async (id) => (chats.get(id) ? { chat: chats.get(id) } : { error: 'nope' });
  const app = express();
  app.use(express.json());
  app.use(createChatFileRouter({ resolve, fileExistsTelemetry: telemetry, local: LOCAL }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  process.env.PATH = originalEnv.PATH;
  process.env.HOME = originalEnv.HOME;
  if (originalEnv.COMPANION !== undefined) process.env.WARDEN_COMPANION_TRANSPORT = originalEnv.COMPANION;
  if (!process.env.KEEP) fs.rmSync(tmpRoot, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  fs.writeFileSync(logFile, '');
  chats = new Map([
    ['lc', { host: LOCAL, container: 'box', cwd: hostProj }],
    ['rc', { host: 'somehost', container: 'box', cwd: hostProj }],
    ['down', { host: LOCAL, container: 'downbox', cwd: hostProj }],
  ]);
});

for (const [label, chat] of [
  ['local-container', { host: LOCAL, container: 'box', cwd: hostProj }],
  ['remote-container', { host: 'somehost', container: 'box', cwd: hostProj }],
]) {
  describe(`readChatFile — ${label} chat`, () => {
    it('reads the CONTAINER copy via docker exec, not the host fs', async () => {
      const r = await readChatFile(chat, 'a.txt');
      assert.deepEqual(r, { ok: true, content: 'CONTAINER\n' });
      const log = readLog();
      assert.match(log, /--CALL docker\nexec\nbox\nbash\n-lc\n/);
      if (label === 'remote-container') assert.match(log, /--CALL ssh/);
    });

    it('reads a file that exists only in the container', async () => {
      const r = await readChatFile(chat, 'only-in-box.txt');
      assert.deepEqual(r, { ok: true, content: 'BOX-ONLY\n' });
    });

    it('traversal out of cwd is refused (403)', async () => {
      const r = await readChatFile(chat, '../secret.txt');
      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
    });

    it('missing file → 404, directory → 400, binary ext/content → 400', async () => {
      assert.equal((await readChatFile(chat, 'missing.txt')).status, 404);
      assert.equal((await readChatFile(chat, 'sub')).status, 400);
      assert.equal((await readChatFile(chat, 'pic.png')).status, 400);
      const bin = await readChatFile(chat, 'bin.txt');
      assert.equal(bin.status, 400);
      assert.equal(bin.error, 'cannot read binary files');
    });

    it('readWorkingTreeFile (A↔B compare) inherits the container read', async () => {
      assert.deepEqual(await readWorkingTreeFile(chat, 'a.txt'), { content: 'CONTAINER\n' });
    });
  });
}

describe('POST /api/read-file — container chats', () => {
  it('local container chat serves the container copy', async () => {
    const r = await post('/api/read-file', { id: 'lc', path: 'a.txt' });
    assert.equal(r.status, 200);
    assert.equal(r.body.content, 'CONTAINER\n');
  });
  it('remote container chat issues a docker exec on the host (not a bare bash -lc)', async () => {
    const r = await post('/api/read-file', { id: 'rc', path: 'a.txt' });
    assert.equal(r.body.content, 'CONTAINER\n');
    assert.match(readLog(), /docker exec/);
  });
  it('traversal → 403', async () => {
    assert.equal((await post('/api/read-file', { id: 'lc', path: '../../../../etc/passwd' })).status, 403);
  });
  it('a gone container is a failure, never the host copy', async () => {
    const r = await post('/api/read-file', { id: 'down', path: 'a.txt' });
    assert.notEqual(r.status, 200);
    assert.equal(r.body.content, undefined);
  });
});

describe('POST /api/file-exists — container chats', () => {
  for (const id of ['lc', 'rc']) {
    it(`${id}: exists (container-only file) via docker exec`, async () => {
      const r = await post('/api/file-exists', { id, path: 'only-in-box.txt' });
      assert.deepEqual(r.body, { exists: true });
      assert.match(readLog(), /--CALL docker\nexec\nbox\n/);
      assert.deepEqual(calls[0], ['probe', 'remote', true]);
    });
    it(`${id}: absent → {exists:false} without failed, filed as a conclusive probe`, async () => {
      const r = await post('/api/file-exists', { id, path: 'missing.txt' });
      assert.deepEqual(r.body, { exists: false });
      assert.deepEqual(calls[0], ['probe', 'remote', false]);
    });
    it(`${id}: traversal is absent, not exists`, async () => {
      const r = await post('/api/file-exists', { id, path: '../secret.txt' });
      assert.deepEqual(r.body, { exists: false });
    });
  }
  it('a host-only path is NOT found for a container chat (host fs not consulted)', async () => {
    fs.writeFileSync(path.join(hostProj, 'host-only.txt'), 'h');
    const r = await post('/api/file-exists', { id: 'lc', path: 'host-only.txt' });
    assert.deepEqual(r.body, { exists: false });
  });
  it('gone container → {exists:false, failed:true} + recordRemoteFailure', async () => {
    const r = await post('/api/file-exists', { id: 'down', path: 'a.txt' });
    assert.deepEqual(r.body, { exists: false, failed: true });
    assert.deepEqual(calls[0], ['failure', 'error']);
  });
});
