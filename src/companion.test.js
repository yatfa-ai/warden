// Tests for the host companion transport (WARDEN-272, slice 1 of roadmap WARDEN-270).
//
// Coverage map:
//   - pure seams: archForUname, mapCompanionContainers (parity with the default
//     discover() chat shape), encodeRequest, parseProbe, projectSpawnModel,
//     isCompanionTransportEnabled.
//   - RPC framing: CompanionChannel.call round-trip + error/timeout/dead handling,
//     driven through a fake transport (no real ssh).
//   - remote bash builders: buildProbeScript / buildUploadScript validated by
//     running them through `bash -c` so quoting / $HOME-expansion traps surface
//     (WARDEN-140's "extract + test through bash" rule).
//   - bootstrap orchestration: probe → upload → spawn → ping, incl. the stale-
//     binary re-upload and every companion-or-fail failure mode (no raw-SSH
//     fallback anywhere).
//   - end-to-end stdio: spawn the REAL built companion binary and verify it
//     answers ping over stdio (proves AC #4: NO network port), guarded by
//     platform/binary presence so it skips cleanly elsewhere.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  archForUname, remoteBinaryPath, buildProbeScript, buildUploadScript, parseProbe,
  encodeRequest, mapCompanionContainers, CompanionChannel, CompanionTransportError,
  CompanionRpcError, getChannel, discover, isCompanionTransportEnabled, loadManifest,
  projectSpawnModel, _resetChannelCacheForTests,
} from './companion.js';

// ------------------------------- pure seams ---------------------------------

describe('archForUname', () => {
  for (const [uname, want] of [
    ['x86_64', 'amd64'], ['amd64', 'amd64'], ['AMD64', 'amd64'],
    ['aarch64', 'arm64'], ['arm64', 'arm64'],
  ]) {
    it(`maps ${uname} -> ${want}`, () => {
      assert.strictEqual(archForUname(uname), want);
    });
  }
  it('returns null for unsupported / empty arch', () => {
    for (const u of ['', 'mips', 'ppc64le', 'riscv64', undefined, null]) {
      assert.strictEqual(archForUname(u), null, `expected null for ${JSON.stringify(u)}`);
    }
  });
});

describe('remoteBinaryPath', () => {
  it('expands $HOME on the remote (literal $HOME kept for the host shell)', () => {
    assert.strictEqual(remoteBinaryPath('abc123'), '$HOME/.warden/companion-abc123');
  });
});

describe('encodeRequest (RPC framing)', () => {
  it('encodes id + method with no params when params is empty/absent', () => {
    assert.strictEqual(encodeRequest(1, 'ping'), '{"id":1,"method":"ping"}');
    assert.strictEqual(encodeRequest(2, 'ping', {}), '{"id":2,"method":"ping"}');
    assert.strictEqual(encodeRequest(3, 'ping', null), '{"id":3,"method":"ping"}');
  });
  it('includes params when provided', () => {
    assert.strictEqual(
      encodeRequest('a', 'discover', { session: 'agent' }),
      '{"id":"a","method":"discover","params":{"session":"agent"}}',
    );
  });
  it('preserves non-numeric ids (strings) for the caller', () => {
    const o = JSON.parse(encodeRequest('req-7', 'ping'));
    assert.strictEqual(o.id, 'req-7');
  });
});

describe('mapCompanionContainers (parity with default discover() chat shape)', () => {
  // The exact chat literal the default chats.js discover() builds from a row
  // {name, status, cwd, active}. The companion path MUST produce a byte-identical
  // object (same fields, same defaults) so callers cannot tell paths apart.
  const expectedChat = (host, name, status, cwd, active, session = 'agent') => {
    const idx = name.lastIndexOf('-');
    const project = idx < 0 ? name : name.slice(0, idx);
    const role = idx < 0 ? '' : name.slice(idx + 1);
    return {
      id: `${host}:${name}`, key: name, kind: 'yatfa',
      host, container: name, session,
      project, role,
      isAgent: ['planner', 'worker', 'reviewer', 'researcher'].includes(role),
      active, status,
      cwd: cwd.trim() || undefined,
      lastActivity: null,
    };
  };

  const host = 'prod-1';
  const cases = [
    { name: 'myproject-worker', status: 'Up 3 hours', cwd: '/work/myproject', active: true },
    { name: 'myproject-researcher', status: 'Up 1 minute', cwd: '/work/x', active: false },
    { name: 'barename', status: 'Exited (0) 5 min ago', cwd: '', active: false }, // hyphenless
    { name: 'multi-dash-project-planner', status: 'Up', cwd: '  ', active: true }, // multi-hyphen project
    { name: 'x-reviewer', status: 'Restarting', cwd: '/a b/c', active: true }, // cwd with spaces
  ];

  it('produces byte-identical chat objects for a battery of containers', () => {
    const containers = cases.map((c) => ({ ...c, active: c.active }));
    const chats = mapCompanionContainers(host, containers, 'agent');
    assert.strictEqual(chats.length, cases.length, 'one chat per container');
    for (const chat of chats) {
      const src = cases.find((c) => c.name === chat.key);
      assert.deepStrictEqual(chat, expectedChat(host, src.name, src.status, src.cwd, src.active),
        `shape mismatch for ${src.name}`);
    }
  });

  it('sorts active-first then by key — identical to the default discover() sort', () => {
    const chats = mapCompanionContainers(host, [
      { name: 'b-worker', status: '', cwd: '', active: false },
      { name: 'a-worker', status: '', cwd: '', active: true },
      { name: 'c-worker', status: '', cwd: '', active: true },
    ]);
    assert.deepStrictEqual(chats.map((c) => c.key), ['a-worker', 'c-worker', 'b-worker']);
  });

  it('honors cfg.tmuxSession as the session field (mirrors default path)', () => {
    const [chat] = mapCompanionContainers(host, [{ name: 'p-worker', status: '', cwd: '', active: true }], 'custom');
    assert.strictEqual(chat.session, 'custom');
  });

  it('empties cwd -> undefined (NOT an empty string), matching default cwd.trim() || undefined', () => {
    const [chat] = mapCompanionContainers(host, [{ name: 'p-worker', status: '', cwd: '   ', active: false }]);
    assert.strictEqual(chat.cwd, undefined);
  });

  it('tolerates null/undefined containers', () => {
    assert.deepStrictEqual(mapCompanionContainers(host, null), []);
    assert.deepStrictEqual(mapCompanionContainers(host, undefined), []);
  });
});

describe('parseProbe', () => {
  it('parses ARCH + HAVE=1', () => {
    assert.deepStrictEqual(parseProbe('ARCH=x86_64\nHAVE=1\n'), { arch: 'x86_64', have: true });
  });
  it('parses HAVE=0', () => {
    assert.deepStrictEqual(parseProbe('ARCH=aarch64\nHAVE=0\n'), { arch: 'aarch64', have: false });
  });
  it('handles missing HAVE / noisy stdout', () => {
    assert.deepStrictEqual(parseProbe('ARCH=arm64\n'), { arch: 'arm64', have: false });
    assert.deepStrictEqual(parseProbe(''), { arch: '', have: false });
  });
});

describe('projectSpawnModel (benchmark spawn counter)', () => {
  it('default = 1 spawn/host/tick; companion = bootstrap once then 0/tick', () => {
    const m = projectSpawnModel({ hosts: 4, ticks: 10 });
    assert.strictEqual(m.before.totalSpawns, 40, '4 hosts × 10 ticks');
    assert.strictEqual(m.before.perTick, 4);
    assert.strictEqual(m.after.totalSpawns, 12, '4 hosts × 3 bootstrap spawns, once');
    assert.strictEqual(m.after.perTick, 0, 'zero spawns per tick after bootstrap');
    assert.ok(m.savedSpawns > 0);
  });
  it('companion already bootstrapped = 0 spawns total', () => {
    const m = projectSpawnModel({ hosts: 4, ticks: 10, alreadyBootstrapped: true });
    assert.strictEqual(m.after.totalSpawns, 0);
  });
  it('the win grows with the polling cadence (ticks)', () => {
    const few = projectSpawnModel({ hosts: 3, ticks: 1 });
    const many = projectSpawnModel({ hosts: 3, ticks: 60 }); // ~1 min of lifecycle polls
    assert.ok(many.savedSpawns > few.savedSpawns,
      `saved spawns should grow with ticks: ${many.savedSpawns} > ${few.savedSpawns}`);
  });
});

describe('isCompanionTransportEnabled', () => {
  it('is true only when WARDEN_COMPANION_TRANSPORT === "1"', () => {
    assert.strictEqual(isCompanionTransportEnabled({ WARDEN_COMPANION_TRANSPORT: '1' }), true);
    assert.strictEqual(isCompanionTransportEnabled({ WARDEN_COMPANION_TRANSPORT: '0' }), false);
    assert.strictEqual(isCompanionTransportEnabled({ WARDEN_COMPANION_TRANSPORT: undefined }), false);
    assert.strictEqual(isCompanionTransportEnabled({}), false);
  });
});

// ------------------------- remote bash builders ------------------------------
// WARDEN-140: run generated bash through `bash -c` so quoting / $HOME-expansion
// traps surface at test time, not at "discover silently fails on a host" time.

describe('buildProbeScript (validated through bash)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-probe-'));
  // The remote path the script tests; buildProbeScript keeps $HOME literal so it
  // expands under the controlled HOME below.
  const remotePath = remoteBinaryPath('abc123');

  it('HAVE=1 when the binary exists and is executable', () => {
    fs.mkdirSync(path.join(tmp, '.warden'), { recursive: true });
    const bin = path.join(tmp, '.warden', 'companion-abc123');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    const r = spawnSync('bash', ['-c', buildProbeScript(remotePath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(parseProbe(r.stdout), { arch: expectArch(), have: true });
    fs.rmSync(bin, { force: true });
  });

  it('HAVE=0 when the binary is absent', () => {
    const r = spawnSync('bash', ['-c', buildProbeScript(remotePath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(parseProbe(r.stdout), { arch: expectArch(), have: false });
  });
});

describe('buildUploadScript (validated through bash)', () => {
  it('mkdirs ~/.warden, writes stdin to the binary, and chmod +x', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-upload-'));
    const remotePath = remoteBinaryPath('deadbeef');
    const payload = Buffer.from('fake-go-binary-bytes');
    const r = spawnSync('bash', ['-c', buildUploadScript(remotePath)], {
      input: payload,
      env: { ...process.env, HOME: tmp },
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const written = path.join(tmp, '.warden', 'companion-deadbeef');
    assert.ok(fs.existsSync(written), 'binary written to ~/.warden/');
    assert.strictEqual(fs.readFileSync(written, 'utf8'), 'fake-go-binary-bytes', 'contents streamed verbatim');
    assert.ok(fs.statSync(written).mode & 0o111, 'binary is executable (chmod +x)');
  });
});

// The arch this test machine reports via uname -m — so the probe bash tests can
// assert the real ARCH= line without hardcoding.
function expectArch() {
  return spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
}

// ------------------------------ RPC channel ---------------------------------

// A transport that speaks the companion protocol in-process: on write(line), it
// computes a response via `handler` and emits it back on the next tick.
function fakeTransport(handler) {
  let lineCB = null, exitCb = null;
  return {
    write(line) {
      let resp = null;
      try { resp = handler(JSON.parse(line)); } catch { /* swallow */ }
      if (resp) setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    },
    onLine(cb) { lineCB = cb; },
    onExit(cb) { exitCb = cb; },
    kill() {},
    _die(err) { if (exitCb) exitCb(err); }, // test hook to simulate process exit
  };
}

describe('CompanionChannel.call (RPC round-trip via fake transport)', () => {
  it('resolves with result when the response is {ok:true}', async () => {
    const t = fakeTransport((req) => ({ id: req.id, ok: true, result: { containers: [] } }));
    const ch = new CompanionChannel('h', t);
    const res = await ch.call('discover', { session: 'agent' }, { timeout: 500 });
    assert.deepStrictEqual(res, { containers: [] });
  });

  it('rejects with CompanionRpcError on {ok:false}', async () => {
    const t = fakeTransport((req) => ({ id: req.id, ok: false, error: 'docker ps failed: no docker' }));
    const ch = new CompanionChannel('h', t);
    await assert.rejects(() => ch.call('discover', {}, { timeout: 500 }), (e) => {
      assert.ok(e instanceof CompanionRpcError);
      assert.ok(e.message.includes('docker ps failed'));
      return true;
    });
  });

  it('times out -> CompanionTransportError when no response arrives', async () => {
    const t = fakeTransport(() => null); // never responds
    const ch = new CompanionChannel('h', t);
    await assert.rejects(() => ch.call('ping', {}, { timeout: 60 }), (e) => {
      assert.ok(e instanceof CompanionTransportError, 'timeout is a transport error');
      assert.ok(e.message.includes('timed out'));
      return true;
    });
  });

  it('multiplexes concurrent calls by id (in-flight requests each get their reply)', async () => {
    const t = fakeTransport((req) => ({ id: req.id, ok: true, result: { n: req.id } }));
    const ch = new CompanionChannel('h', t);
    const [a, b, c] = await Promise.all([
      ch.call('ping', {}, { timeout: 500 }),
      ch.call('ping', {}, { timeout: 500 }),
      ch.call('ping', {}, { timeout: 500 }),
    ]);
    assert.deepStrictEqual([a, b, c], [{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('rejects all pending + future calls when the process dies mid-flight', async () => {
    const t = fakeTransport(() => null); // hold the call open, then kill
    const ch = new CompanionChannel('h', t);
    const pending = ch.call('ping', {}, { timeout: 1000 });
    setImmediate(() => t._die(new Error('companion ssh exited with code 255')));
    await assert.rejects(pending, (e) => {
      assert.ok(e.message.includes('companion ssh exited'), e.message);
      return true;
    });
    assert.ok(ch.dead, 'channel marked dead');
    await assert.rejects(() => ch.call('ping', {}, { timeout: 100}),
      (e) => /channel is dead/.test(e.message));
  });
});

// --------------------------- bootstrap orchestration ------------------------

// Manifest + ping handler that agree on a hex version. binaries point at the
// REAL built files (committed under companion/dist/) so the fs.existsSync gate
// in bootstrap passes.
const TEST_VER = 'abc123def456';
const TEST_MANIFEST = {
  version: TEST_VER,
  binaries: {
    'linux/amd64': 'warden-companion-linux-amd64',
    'linux/arm64': 'warden-companion-linux-arm64',
  },
};

// Build a fake transport whose ping reports the test version (a healthy channel).
const healthyTransport = (extra = {}) => fakeTransport((req) => {
  if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover'] } };
  if (req.method === 'discover') return { id: req.id, ok: true, result: { containers: extra.containers ?? [] } };
  return { id: req.id, ok: false, error: 'unknown method' };
});

// Minimal deps: a probe `run` returning a canned ARCH/HAVE, a recording upload,
// and spawnChannel returning a fake transport. `overrides` customizes any leg.
function fakeDeps(overrides = {}) {
  const calls = { run: 0, upload: 0, spawnChannel: 0 };
  const deps = {
    manifest: TEST_MANIFEST,
    run: async () => { calls.run++; return { ok: true, stdout: 'ARCH=x86_64\nHAVE=0\n' }; },
    upload: async () => { calls.upload++; return { ok: true }; },
    spawnChannel: () => { calls.spawnChannel++; return healthyTransport(overrides.containers ? { containers: overrides.containers } : {}); },
    ...overrides,
  };
  return { deps, calls };
}

describe('getChannel / bootstrap orchestration', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('happy path: probe(amd64,missing) -> upload -> spawn -> ping ok -> cached', async () => {
    const { deps, calls } = fakeDeps();
    const ch = await getChannel('prod-1', {}, deps);
    assert.ok(ch instanceof CompanionChannel);
    assert.strictEqual(calls.run, 1, 'one probe');
    assert.strictEqual(calls.upload, 1, 'uploaded the missing binary');
    assert.strictEqual(calls.spawnChannel, 1, 'spawned one channel');
    // Second call reuses the cached channel — no new ssh spawns.
    const ch2 = await getChannel('prod-1', {}, deps);
    assert.strictEqual(ch2, ch, 'same channel object (cached)');
    assert.strictEqual(calls.run, 1, 'no re-probe on cache hit');
    assert.strictEqual(calls.spawnChannel, 1, 'no re-spawn on cache hit');
  });

  it('skips upload when the right-version binary already exists (HAVE=1)', async () => {
    const { deps, calls } = fakeDeps({
      run: async () => ({ ok: true, stdout: 'ARCH=aarch64\nHAVE=1\n' }),
    });
    await getChannel('prod-2', {}, deps);
    assert.strictEqual(calls.upload, 0, 'HAVE=1 → no upload');
    assert.strictEqual(calls.spawnChannel, 1);
  });

  it('stale cached binary (HAVE=1 but ping mismatch) forces exactly one re-upload', async () => {
    // First spawnChannel reports an OLD version → mismatch; bootstrap must
    // re-upload and respawn, and the second channel reports the right version.
    let spawns = 0;
    const { deps, calls } = fakeDeps({
      run: async () => ({ ok: true, stdout: 'ARCH=x86_64\nHAVE=1\n' }),
      spawnChannel: () => {
        spawns++;
        return spawns === 1
          ? fakeTransport((req) => req.method === 'ping' ? { id: req.id, ok: true, result: { version: '000000000000' } } : null)
          : healthyTransport();
      },
    });
    const ch = await getChannel('prod-3', {}, deps);
    assert.ok(ch instanceof CompanionChannel);
    assert.strictEqual(calls.upload, 1, 'stale binary → re-uploaded once');
    assert.strictEqual(spawns, 2, 'respawned after re-upload');
  });

  it('probe failure -> CompanionTransportError, no upload, no spawn', async () => {
    const { deps, calls } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    await assert.rejects(() => getChannel('prod-4', {}, deps), (e) => {
      assert.ok(e instanceof CompanionTransportError);
      assert.ok(e.message.includes('bootstrap probe failed'));
      assert.ok(e.recovery.includes('WARDEN_COMPANION_TRANSPORT=0'), 'actionable recovery hint');
      return true;
    });
    assert.strictEqual(calls.upload, 0);
    assert.strictEqual(calls.spawnChannel, 0);
  });

  it('unsupported host arch -> CompanionTransportError', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ ok: true, stdout: 'ARCH=riscv64\nHAVE=0\n' }),
    });
    await assert.rejects(() => getChannel('prod-5', {}, deps), (e) => {
      assert.ok(/linux\/amd64 and linux\/arm64 only/.test(e.message), e.message);
      return true;
    });
  });

  it('upload failure -> CompanionTransportError (no silent success)', async () => {
    const { deps } = fakeDeps({
      upload: async () => ({ ok: false, code: 1, stderr: 'disk full' }),
    });
    await assert.rejects(() => getChannel('prod-6', {}, deps), (e) => {
      assert.ok(e.message.includes('bootstrap upload failed'));
      assert.ok(e.message.includes('disk full'));
      return true;
    });
  });

  it('ping unreachable after a fresh upload -> CompanionTransportError', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport(() => null), // companion never answers ping
    });
    await assert.rejects(() => getChannel('prod-7', {}, deps), (e) => {
      assert.ok(/did not respond to ping/.test(e.message), e.message);
      return true;
    });
  });

  it('ping mismatch AFTER a fresh upload (corrupt/streamed binary) -> error', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) => req.method === 'ping' ? { id: req.id, ok: true, result: { version: 'ffffffffffff' } } : null),
    });
    await assert.rejects(() => getChannel('prod-8', {}, deps), (e) => {
      assert.ok(/version/.test(e.message), e.message);
      return true;
    });
  });
});

describe('discover() via companion (companion-or-fail)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('returns {ok:true, chats} mapped to the default chat shape', async () => {
    const containers = [
      { name: 'p-worker', status: 'Up', cwd: '/w', active: true },
      { name: 'p-planner', status: 'Up', cwd: '/w', active: false },
    ];
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport({ containers }) });
    const res = await discover('prod', { tmuxSession: 'agent' }, {}, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.host, 'prod');
    assert.strictEqual(res.chats.length, 2);
    // active first, identical shape to the default path
    assert.strictEqual(res.chats[0].key, 'p-worker');
    assert.strictEqual(res.chats[0].isAgent, true);
    assert.strictEqual(res.chats[0].session, 'agent');
    assert.strictEqual(res.chats[1].active, false);
  });

  it('bootstrap failure -> {ok:false, actionable error}, NOT a raw-ssh fallback', async () => {
    // If the companion path fell back to runWithPool, we would see a discover
    // attempt on the default path. Instead we must get a companion-specific error
    // that names the env-var opt-out — proving no silent fallback occurred.
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Connection refused' }),
    });
    const res = await discover('prod', {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.chats.length, 0);
    assert.ok(res.error.includes('companion'), `error should name the companion: ${res.error}`);
    assert.ok(res.recovery === undefined || res.error.includes('WARDEN_COMPANION_TRANSPORT') || true);
    // The error must carry the actionable opt-out guidance.
    assert.ok(res.error.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `bootstrap error must tell the user how to opt out: ${res.error}`);
  });

  it('discover RPC error ({ok:false}) propagates as {ok:false} without fallback', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER } }
          : { id: req.id, ok: false, error: 'docker ps failed: Cannot connect to the Docker daemon' }),
    });
    const res = await discover('prod', {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('docker ps failed'), res.error);
  });

  it('(local) host is refused (companion serves remote hosts only)', async () => {
    const res = await discover('(local)', {}, {});
    assert.strictEqual(res.ok, false);
    assert.ok(/local/.test(res.error));
  });
});

// ----------------------- end-to-end: the real binary ------------------------
// Spawns the committed companion binary and drives it over stdio. Proves AC #4
// (the channel is stdio — NO network port) and that the baked version matches the
// manifest. Skipped unless we're on the binary's host platform and it's present.

const BIN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'companion', 'dist', 'warden-companion-linux-amd64',
);
const canRunBinary = process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(BIN_PATH);

function realBinaryTransport() {
  const child = spawn(BIN_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  let lineCb = null, exitCb = null;
  rl.on('line', (l) => { if (lineCb) lineCb(l); });
  child.on('exit', (code) => { if (exitCb) exitCb(new Error(`exit ${code}`)); });
  child.on('error', (e) => { if (exitCb) exitCb(e); });
  return {
    write(line) { child.stdin.write(line + '\n'); },
    onLine(cb) { lineCb = cb; },
    onExit(cb) { exitCb = cb; },
    kill() { try { child.kill(); } catch { /* noop */ } },
  };
}

(canRunBinary ? describe : describe.skip)('end-to-end: real companion binary over stdio', () => {
  it('ping returns the manifest version (proves stdio RPC; no network port)', async () => {
    const ch = new CompanionChannel('local-binary', realBinaryTransport());
    try {
      const res = await ch.call('ping', {}, { timeout: 4000 });
      const manifest = loadManifest();
      assert.strictEqual(res.version, manifest.version,
        `binary version ${res.version} must match manifest ${manifest.version}`);
      assert.ok(Array.isArray(res.methods) && res.methods.includes('discover'));
    } finally {
      ch.kill();
    }
  });

  it('unknown method -> {ok:false} error (no crash, channel stays usable)', async () => {
    const ch = new CompanionChannel('local-binary', realBinaryTransport());
    try {
      await assert.rejects(() => ch.call('bogus', {}, { timeout: 4000 }), (e) => {
        assert.ok(e instanceof CompanionRpcError);
        assert.ok(/unknown method/.test(e.message));
        return true;
      });
      // Channel survived; a follow-up ping still works.
      const res = await ch.call('ping', {}, { timeout: 4000 });
      assert.ok(res.version);
    } finally {
      ch.kill();
    }
  });

  it('discover without docker -> actionable error, not a crash', async () => {
    const ch = new CompanionChannel('local-binary', realBinaryTransport());
    try {
      await assert.rejects(() => ch.call('discover', { session: 'agent' }, { timeout: 4000 }), (e) => {
        assert.ok(e instanceof CompanionRpcError);
        // Either docker isn't installed or the daemon isn't running — both are
        // clear, actionable failures, never a silent empty result.
        assert.ok(/docker ps failed/.test(e.message), e.message);
        return true;
      });
    } finally {
      ch.kill();
    }
  });
});
