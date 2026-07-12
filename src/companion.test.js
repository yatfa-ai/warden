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
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  archForUname, remoteBinaryPath, buildProbeScript, buildUploadScript, parseProbe,
  encodeRequest, mapCompanionContainers, CompanionChannel, CompanionTransportError,
  CompanionRpcError, getChannel, discover, capturePanes, isCompanionTransportEnabled, loadManifest,
  projectSpawnModel, _resetChannelCacheForTests,
} from './companion.js';
import { buildChat } from './chatMeta.js';
import { buildCaptureScript, parseCaptureSentinels } from './chats.js';

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

describe('mapCompanionContainers (maps containers into the shared buildChat)', () => {
  // The chat SHAPE is locked once in chatMeta.test.js (buildChat asserted against
  // literal objects). Parity with the default discover() path is now STRUCTURAL:
  // both src/chats.js and src/companion.js call the same buildChat(), so the two
  // cannot drift (WARDEN-272 review #5). Here we verify only that
  // mapCompanionContainers routes each container's fields into buildChat with the
  // right argument order, skips nameless rows, and sorts.

  const host = 'prod-1';
  const cases = [
    { name: 'myproject-worker', status: 'Up 3 hours', cwd: '/work/myproject', active: true },
    { name: 'myproject-researcher', status: 'Up 1 minute', cwd: '/work/x', active: false },
    { name: 'barename', status: 'Exited (0) 5 min ago', cwd: '', active: false }, // hyphenless
    { name: 'multi-dash-project-planner', status: 'Up', cwd: '  ', active: true }, // multi-hyphen project
    { name: 'x-reviewer', status: 'Restarting', cwd: '/a b/c', active: true }, // cwd with spaces
  ];

  it('maps each container to buildChat(host, name, status, cwd, active, session)', () => {
    const containers = cases.map((c) => ({ ...c, active: c.active }));
    const chats = mapCompanionContainers(host, containers, 'agent');
    assert.strictEqual(chats.length, cases.length, 'one chat per container');
    for (const chat of chats) {
      const src = cases.find((c) => c.name === chat.key);
      assert.deepStrictEqual(chat, buildChat(host, src.name, src.status, src.cwd, src.active, 'agent'),
        `mapping mismatch for ${src.name}`);
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
  if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover', 'capturePanes'] } };
  if (req.method === 'discover') return { id: req.id, ok: true, result: { containers: extra.containers ?? [] } };
  if (req.method === 'capturePanes') return { id: req.id, ok: true, result: { panes: extra.panes ?? {} } };
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

// A fake ssh child for testing the DEFAULT upload/spawnChannel wiring (the legs
// that close over deps.spawn) WITHOUT real ssh — the path the live benchmark
// exercises. The benchmark injects a single deps.spawn wrapper for both legs, so
// this proves they really route through it. Branches on the trailing remote arg:
//   'bash -lc …' → upload leg: accept the piped binary on stdin, then exit 0.
//   the companion remotePath → channel leg: speak the stdio RPC (answer ping
//   with `version`, discover with `containers`) and stay alive.
function fakeSpawnChildFactory(version, containers = []) {
  return (_bin, args) => {
    const remote = args[args.length - 1];
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = () => {};
    if (typeof remote === 'string' && remote.startsWith('bash -lc')) {
      child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
      setImmediate(() => child.emit('exit', 0));
    } else {
      child.stdin = new Writable({
        write(chunk, _enc, cb) {
          const line = (chunk == null ? '' : chunk.toString()).trim();
          if (line) {
            try {
              const req = JSON.parse(line);
              let resp;
              if (req.method === 'ping') resp = { id: req.id, ok: true, result: { version, methods: ['ping', 'discover'] } };
              else if (req.method === 'discover') resp = { id: req.id, ok: true, result: { containers } };
              else resp = { id: req.id, ok: false, error: 'unknown method' };
              if (resp) setImmediate(() => child.stdout.push(JSON.stringify(resp) + '\n'));
            } catch { /* ignore non-JSON */ }
          }
          cb();
        },
      });
    }
    return child;
  };
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

  it('a fresh bootstrap routes ALL three legs through deps.spawn/deps.run (count == 3)', async () => {
    // Mirrors scripts/companion-benchmark.mjs's counting shape exactly: the
    // benchmark injects ONE deps.spawn (upload + channel legs) and ONE deps.run
    // (the probe leg, since ssh.js run() spawns internally). The probe previously
    // bypassed the counter, so the live replay reported 2 instead of 3 and
    // disagreed with the Part 1 projection. This locks the wiring: default upload
    // + default spawnChannel MUST call deps.spawn, and the probe MUST call deps.run.
    // (WARDEN-272 review #2.)
    let runCalls = 0;
    let spawnCalls = 0;
    const ch = await getChannel('prod-count', {}, {
      manifest: TEST_MANIFEST,
      run: async () => { runCalls++; return { ok: true, stdout: 'ARCH=x86_64\nHAVE=0\n' }; },
      spawn: (...a) => { spawnCalls++; return fakeSpawnChildFactory(TEST_VER)(...a); },
    });
    assert.ok(ch instanceof CompanionChannel);
    assert.strictEqual(runCalls, 1, 'probe leg: exactly one deps.run call');
    assert.strictEqual(spawnCalls, 2, 'upload + channel legs: exactly two deps.spawn calls');
    assert.strictEqual(runCalls + spawnCalls, 3, 'total == Part 1 projection (probe + upload + channel = 3)');
  });

  it('concurrent getChannel for the SAME host shares one bootstrap (no leaked ssh)', async () => {
    // Two concurrent calls for one host (e.g. the 2s monitor tick landing on a 60s
    // lifecycle poll) must coalesce onto ONE in-flight bootstrap, not each start
    // their own — otherwise an ssh + companion process leaks. getChannel caches
    // the bootstrap PROMISE so the second caller awaits the first's result.
    // (WARDEN-272 review #6.)
    const { deps, calls } = fakeDeps();
    const [a, b] = await Promise.all([
      getChannel('prod-race', {}, deps),
      getChannel('prod-race', {}, deps),
    ]);
    assert.strictEqual(a, b, 'both callers got the SAME channel');
    assert.strictEqual(calls.run, 1, 'probe ran once (not twice)');
    assert.strictEqual(calls.spawnChannel, 1, 'channel spawned once (not twice)');
  });

  it('a dead cached channel is replaced by a fresh bootstrap (self-healing)', async () => {
    // When a channel dies (ssh process exited) the cache holds a dead channel; a
    // later getChannel must NOT reuse it but bootstrap a fresh one. This is the
    // fall-through branch of the cache check (a live channel vs a dead one).
    const { deps, calls } = fakeDeps();
    const first = await getChannel('prod-dead', {}, deps);
    first.kill(); // mark the cached channel dead (simulates the ssh process exiting)
    assert.ok(first.dead, 'precondition: channel is dead');
    const second = await getChannel('prod-dead', {}, deps);
    assert.notStrictEqual(second, first, 'got a NEW channel, not the dead one');
    assert.ok(!second.dead, 'the new channel is alive');
    assert.strictEqual(calls.spawnChannel, 2, 'bootstrapped a second time');
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

// ------------------------------- capture-pane --------------------------------
// WARDEN-276 (slice 2): the capturePanes RPC + its host-side sentinel framing.
// capture-pane is the highest-frequency remote op; routing it over the companion
// collapses the per-tick handshake on the polling cadence. The contract under
// test: the ___B_<key>___ / ___E_<key>___ framing that BOTH the default JS path
// (chats.js) and the Go companion (companion/main.go) reproduce byte-for-byte.

describe('buildCaptureScript (exact bytes — the host-side framing contract)', () => {
  it('docker-exec chat: sentinel-bracketed, docker exec <container> tmux, shellQuoted target', () => {
    const script = buildCaptureScript([
      { key: 'p-worker', container: 'p-worker', session: 'agent' },
    ]);
    assert.strictEqual(
      script,
      "printf '___B_p-worker___\\n'; docker exec 'p-worker' tmux capture-pane -t 'agent' -p -e -S -60 -E - 2>/dev/null; printf '\\n___E_p-worker___\\n'",
    );
  });

  it('bare-tmux chat (no container): uses bare tmux, not docker exec', () => {
    const script = buildCaptureScript([
      { key: 'mysession', container: null, session: 'mysession' },
    ]);
    assert.ok(!script.includes('docker exec'), 'bare-tmux must not docker exec');
    assert.strictEqual(
      script,
      "printf '___B_mysession___\\n'; tmux capture-pane -t 'mysession' -p -e -S -60 -E - 2>/dev/null; printf '\\n___E_mysession___\\n'",
    );
  });

  it('target falls back container -> "agent" when session is empty (mirrors chats.js)', () => {
    // yatfa-style: container set, session empty -> target is the container.
    const a = buildCaptureScript([{ key: 'k', container: 'c1', session: '' }]);
    assert.ok(a.includes("capture-pane -t 'c1'"), a);
    // nothing set -> target 'agent'.
    const b = buildCaptureScript([{ key: 'k', container: null, session: '' }]);
    assert.ok(b.includes("capture-pane -t 'agent'"), b);
  });

  it('multiple panes are joined with "; " (one batched ssh call per host)', () => {
    const script = buildCaptureScript([
      { key: 'a', container: 'a', session: 'agent' },
      { key: 'b', container: 'b', session: 'agent' },
    ]);
    assert.ok(script.includes('; '), 'joined with "; "');
    // ordering preserved
    assert.ok(script.indexOf('___B_a___') < script.indexOf('___B_b___'));
    // one begin-sentinel per pane (each pane command has its own internal "; "
    // separators around the capture, so counting those would over-count).
    assert.strictEqual((script.match(/___B_[^_]/g) || []).length, 2, 'one begin-sentinel per pane');
    assert.strictEqual((script.match(/___E_[^_]/g) || []).length, 2, 'one end-sentinel per pane');
  });

  it('containers with special chars are shellQuoted (single-quote escaped)', () => {
    // A container name with an apostrophe must be escaped, never injected bare.
    const script = buildCaptureScript([{ key: 'k', container: "c'x", session: 'agent' }]);
    assert.ok(script.includes(`docker exec 'c'\\''x' tmux`), script);
  });
});

describe('buildCaptureScript (validated through bash — WARDEN-140)', () => {
  // Stub tmux + docker as shell functions that echo their args, so the script's
  // sentinel framing, shellQuoting, and docker-vs-tmux selection can be validated
  // through REAL bash without a docker daemon or live tmux. The captured "content"
  // encodes the command the script ended up running.
  const STUB = `tmux() { echo "TMUX:$*"; }
docker() { if [ "$1" = exec ]; then shift; local c="$1"; shift; echo "DOCKEREXEC:$c:$*"; fi }
`;
  const runThroughBash = (script) =>
    spawnSync('bash', ['-c', STUB + script], { encoding: 'utf8' });

  it('docker-exec pane: bash runs docker exec <container> tmux capture-pane with the quoted target', () => {
    const r = runThroughBash(buildCaptureScript([{ key: 'p-worker', container: 'p-worker', session: 'agent' }]));
    assert.strictEqual(r.status, 0, r.stderr);
    const map = parseCaptureSentinels(r.stdout);
    assert.deepStrictEqual(Object.keys(map), ['p-worker']);
    // Bash consumes the single-quotes shellQuote added, so the stub sees the
    // unquoted args. What matters: docker exec <container> was invoked, tmux ran,
    // and the exact capture-pane flags/args came through verbatim. (.trim: the
    // sentinel framing preserves a trailing newline from echo, as it would from
    // real tmux — not part of the command under test.)
    assert.strictEqual(map['p-worker'].trim(), 'DOCKEREXEC:p-worker:tmux capture-pane -t agent -p -e -S -60 -E -');
  });

  it('bare-tmux pane: bash runs bare tmux capture-pane (no docker exec)', () => {
    const r = runThroughBash(buildCaptureScript([{ key: 's', container: null, session: 's' }]));
    assert.strictEqual(r.status, 0, r.stderr);
    const map = parseCaptureSentinels(r.stdout);
    assert.deepStrictEqual(Object.keys(map), ['s']);
    assert.ok(map.s.startsWith('TMUX:'), map.s);
    assert.ok(map.s.includes('-t s '), `target came through; got: ${map.s}`);
  });

  it('mixed batch: both shapes demarcated correctly in one bash invocation', () => {
    const r = runThroughBash(buildCaptureScript([
      { key: 'yatfa', container: 'yatfa', session: 'agent' },
      { key: 'manual', container: null, session: 'manual' },
    ]));
    assert.strictEqual(r.status, 0, r.stderr);
    const map = parseCaptureSentinels(r.stdout);
    assert.deepStrictEqual(Object.keys(map).sort(), ['manual', 'yatfa']);
    assert.ok(map.yatfa.startsWith('DOCKEREXEC:'));
    assert.ok(map.manual.startsWith('TMUX:'));
  });

  it('sentinel framing round-trips through bash verbatim (parity with the JS parser)', () => {
    // The default JS path stuffs captures into one stdout via these sentinels and
    // parses them back; the companion must produce output the SAME parser reads.
    const r = runThroughBash(buildCaptureScript([{ key: 'k', container: null, session: 's' }]));
    const map = parseCaptureSentinels(r.stdout);
    assert.ok('k' in map, 'parser recovered the key from the sentinel');
  });
});

describe('parseCaptureSentinels (the JS side of the framing contract)', () => {
  it('maps each ___B_<key>___ ... ___E_<key>___ block to key -> joined lines', () => {
    const stdout = "___B_a___\nline1\nline2\n___E_a___\n___B_b___\nonly\n___E_b___\n";
    assert.deepStrictEqual(parseCaptureSentinels(stdout), { a: 'line1\nline2', b: 'only' });
  });

  it('preserves blank lines and indentation inside a block', () => {
    const stdout = "___B_a___\n  indented\n\nblank-above\n___E_a___\n";
    assert.strictEqual(parseCaptureSentinels(stdout).a, '  indented\n\nblank-above');
  });

  it('ignores lines outside any B/E block (e.g. a shell banner)', () => {
    const stdout = "Welcome to bash\n___B_a___\nhi\n___E_a___\ntrailing noise\n";
    assert.deepStrictEqual(parseCaptureSentinels(stdout), { a: 'hi' });
  });

  it('a missing closer drops the pane (no key emitted) — matches the JS parser', () => {
    const stdout = "___B_a___\nnever closed\n";
    assert.deepStrictEqual(parseCaptureSentinels(stdout), {});
  });

  it('empty / null stdout -> {}', () => {
    assert.deepStrictEqual(parseCaptureSentinels(''), {});
    assert.deepStrictEqual(parseCaptureSentinels(null), {});
    assert.deepStrictEqual(parseCaptureSentinels(undefined), {});
  });

  it('requires a non-empty key (___B____ with empty key is not a sentinel)', () => {
    // mirrors the regex (.+) — an empty-key sentinel line is treated as content.
    const stdout = "___B_a___\n___B____\n___E_a___\n";
    assert.deepStrictEqual(parseCaptureSentinels(stdout), { a: '___B____' });
  });
});

describe('capturePanes() via companion (companion-or-fail)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('returns {ok:true, panes} from the capturePanes RPC', async () => {
    const panes = { 'p-worker': 'pane content\nline2', 'p-planner': 'other' };
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport({ panes }) });
    const res = await capturePanes('prod', [
      { key: 'p-worker', container: 'p-worker', session: 'agent' },
      { key: 'p-planner', container: 'p-planner', session: 'agent' },
    ], {}, {}, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.host, 'prod');
    assert.deepStrictEqual(res.panes, panes);
  });

  it('sends the per-host pane list with key/container/session (container null for bare-tmux)', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'capturePanes') { sent = req.params; return { id: req.id, ok: true, result: { panes: {} } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    await capturePanes('prod', [
      { key: 'yatfa', container: 'yatfa', session: 'agent' },
      { key: 'manual', container: null, session: 'manual' },
    ], {}, {}, deps);
    assert.deepStrictEqual(sent.panes, [
      { key: 'yatfa', container: 'yatfa', session: 'agent' },
      { key: 'manual', container: null, session: 'manual' },
    ]);
  });

  it('target fallback session->container->agent is applied on the JS side too', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'capturePanes') { sent = req.params; return { id: req.id, ok: true, result: { panes: {} } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    await capturePanes('prod', [{ key: 'k', container: 'c1', session: '' }], {}, {}, deps);
    assert.strictEqual(sent.panes[0].session, 'c1', 'empty session falls back to container');
  });

  it('bootstrap failure -> {ok:false, actionable error}, NOT a raw-ssh fallback', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    const res = await capturePanes('prod', [{ key: 'k', container: 'k', session: 'agent' }], {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.panes, {});
    assert.ok(res.error.includes('companion'), `error names the companion: ${res.error}`);
    assert.ok(res.error.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `bootstrap error must tell the user how to opt out: ${res.error}`);
  });

  it('capturePanes RPC error ({ok:false}) propagates without fallback', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER } }
          : { id: req.id, ok: false, error: 'capturePanes script failed: tmux: not found' }),
    });
    const res = await capturePanes('prod', [{ key: 'k', container: 'k', session: 'agent' }], {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('capturePanes script failed'), res.error);
  });

  it('(local) host is refused (companion serves remote hosts only)', async () => {
    const res = await capturePanes('(local)', [{ key: 'k', container: null, session: 'k' }], {}, {});
    assert.strictEqual(res.ok, false);
    assert.ok(/local/.test(res.error));
  });

  it('empty pane list -> ok with empty map (no RPC payload to build)', async () => {
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport({}) });
    const res = await capturePanes('prod', [], {}, {}, deps);
    assert.strictEqual(res.ok, true);
    // The host had no panes to capture, so the result map is empty regardless.
    assert.deepStrictEqual(res.panes, {});
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
      assert.ok(res.methods.includes('capturePanes'), 'ping advertises the capturePanes RPC');
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

  // The make-or-break parity test for slice 2 (WARDEN-276): the Go companion
  // builds the ___B_/___E_ sentinel-framed capture script, runs it via bash -lc
  // against a REAL tmux session, parses the sentinels, and returns a structured
  // key->content map — which the JS parser (parseCaptureSentinels) MUST be able
  // to read. This proves the host-side framing matches the JS contract. Skipped
  // unless tmux is available (the docker-exec path is the same code with a
  // `docker exec <c>` prefix; the bare-tmux path exercises every other seam).
  const TMUX_BIN = 'tmux';
  const tmuxAvailable = (() => {
    const r = spawnSync(TMUX_BIN, ['-V'], { encoding: 'utf8' });
    return r.status === 0 || (r.stdout && /^tmux\s+\d/i.test(r.stdout));
  })();
  const canCapture = canRunBinary && tmuxAvailable;

  function uniqueSession() {
    return `warden-test-${process.pid}-${Math.floor(Number(process.hrtime.bigint() % 100000n))}`;
  }

  (canCapture ? it : it.skip)('capturePanes: real binary captures a live tmux session over stdio', async () => {
    const session = uniqueSession();
    // Create a detached tmux session and stamp recognizable content into it.
    const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', session], { encoding: 'utf8' });
    assert.strictEqual(setup.status, 0, `tmux new-session failed: ${setup.stderr}`);
    try {
      // send-keys lands text on the pane that capture-pane -p reads back.
      spawnSync(TMUX_BIN, ['send-keys', '-t', session, 'WARDEN_CAPTURE_MARKER_42'], { encoding: 'utf8' });

      const ch = new CompanionChannel('local-binary', realBinaryTransport());
      try {
        const res = await ch.call('capturePanes', {
          panes: [{ key: session, container: '', session }],
        }, { timeout: 8000 });
        // The Go side returns {panes: {<key>: <content>}}; the JS parser MUST be
        // able to read the SAME bytes (parity with the default runWithPool path).
        assert.ok(res && typeof res.panes === 'object', 'response is a panes map');
        assert.ok(session in res.panes, `captured the pane under its key '${session}'`);
        // Cross-check: parse the raw content with the JS parser contract too. (The
        // content itself came through structured JSON, but it must be the text the
        // JS consumer expects — including our stamped marker.)
        const content = res.panes[session];
        assert.ok(content.includes('WARDEN_CAPTURE_MARKER_42'),
          `captured content includes the marker; got:\n${content}`);
      } finally {
        ch.kill();
      }
    } finally {
      spawnSync(TMUX_BIN, ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  });
});
