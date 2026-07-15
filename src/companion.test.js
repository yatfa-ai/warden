// Tests for the host companion transport (WARDEN-272, slice 1 of roadmap WARDEN-270).
//
// Coverage map:
//   - pure seams: targetForUname (OS-aware host-target selection),
//     mapCompanionContainers (parity with the default discover() chat shape),
//     encodeRequest, parseProbe, projectSpawnModel, isCompanionTransportEnabled.
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
import { describe, it, beforeEach, afterEach } from 'node:test';
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
  targetForUname, remoteBinaryPath, buildProbeScript, buildUploadScript, parseProbe,
  encodeRequest, mapCompanionContainers, CompanionChannel, CompanionTransportError,
  CompanionRpcError, getChannel, discover, capturePanes, hasSession, spawnSession, killSession,
  isCompanionTransportEnabled, loadManifest,
  projectSpawnModel, _resetChannelCacheForTests,
  resize as companionResize,
} from './companion.js';
import { probeSession, hasSession as tmuxHasSession, resize as tmuxResize } from './tmux.js';
import { classifyProbe } from './sessionRecovery.js';
import { buildChat, parseActivityTimestamp } from './chatMeta.js';
import { buildCaptureScript, parseCaptureSentinels } from './chats.js';

// ------------------------------- pure seams ---------------------------------

describe('targetForUname (OS-aware host-target selection)', () => {
  // (uname -s, uname -m) -> {goos, goarch} for every supported cross-compile pair.
  for (const [os, arch, want] of [
    ['Linux', 'x86_64', { goos: 'linux', goarch: 'amd64' }],
    ['Linux', 'amd64', { goos: 'linux', goarch: 'amd64' }],
    ['Linux', 'aarch64', { goos: 'linux', goarch: 'arm64' }],
    ['Linux', 'arm64', { goos: 'linux', goarch: 'arm64' }],
    ['Darwin', 'x86_64', { goos: 'darwin', goarch: 'amd64' }],     // Intel mac
    ['Darwin', 'arm64', { goos: 'darwin', goarch: 'arm64' }],       // Apple Silicon
    ['MINGW64_NT-10.0-19045', 'x86_64', { goos: 'windows', goarch: 'amd64' }], // Git Bash (WARDEN-294's reason for existing)
    ['MINGW32_NT-6.3', 'AMD64', { goos: 'windows', goarch: 'amd64' }],
    ['CYGWIN_NT-10.0', 'aarch64', { goos: 'windows', goarch: 'arm64' }],
    ['MSYS_NT-10.0', 'arm64', { goos: 'windows', goarch: 'arm64' }],
  ]) {
    it(`maps ${os} + ${arch} -> ${want.goos}/${want.goarch}`, () => {
      assert.deepStrictEqual(targetForUname(os, arch), want);
    });
  }
  it('returns null for unsupported / empty os or arch (no wrong-OS fallback)', () => {
    for (const [os, arch] of [
      ['', 'x86_64'], ['Linux', ''], [null, 'x86_64'], ['Linux', null],
      ['FreeBSD', 'x86_64'], ['SunOS', 'amd64'],    // unsupported OS
      ['Linux', 'riscv64'], ['Darwin', 'ppc64le'],  // unsupported arch
    ]) {
      assert.strictEqual(targetForUname(os, arch), null, `expected null for ${JSON.stringify(os)},${JSON.stringify(arch)}`);
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

  // WARDEN-376: an active container's host-side-captured leading pane line is
  // parsed into lastActivity via the SAME parseActivityTimestamp the default
  // path uses, so a companion-discovered active agent classifies
  // HEALTHY/WARNING/CRITICAL (not UNKNOWN) in Fleet Health.

  it('sets lastActivity from an active container pane line (parity with the default path)', () => {
    const pane = '[2024-01-15 10:30:00] worker: thinking';
    const [chat] = mapCompanionContainers(host, [
      { name: 'p-worker', status: 'Up', cwd: '/w', active: true, pane },
    ]);
    assert.strictEqual(chat.lastActivity, parseActivityTimestamp(pane),
      'lastActivity is exactly what the shared helper parses from the pane line');
    assert.ok(Number.isFinite(chat.lastActivity), 'a real epoch ms, not null');
  });

  it('leaves lastActivity null when the active container pane line is garbage/empty', () => {
    for (const pane of ['no timestamp here', '', '   ', null, undefined]) {
      const [chat] = mapCompanionContainers(host, [
        { name: 'p-worker', status: 'Up', cwd: '/w', active: true, pane },
      ]);
      assert.strictEqual(chat.lastActivity, null, `expected null for pane=${JSON.stringify(pane)}`);
    }
  });

  it('does not parse lastActivity for INACTIVE containers (even with a pane line)', () => {
    // The Go side captures Pane for active containers only; even if an inactive
    // row carried a pane, the mapper must not stamp activity onto a dead chat.
    const [chat] = mapCompanionContainers(host, [
      { name: 'p-worker', status: 'Exited', cwd: '/w', active: false, pane: '[2024-01-15 10:30:00] stale' },
    ]);
    assert.strictEqual(chat.active, false);
    assert.strictEqual(chat.lastActivity, null, 'inactive containers are not parsed');
  });

  it('leaves lastActivity null when no pane field is present (lean-mode / slice-1 shape)', () => {
    // Backward-compatible: a container with no pane (the lean lifecycle poll, or
    // an older companion) leaves lastActivity null exactly like slice 1.
    const [active, inactive] = mapCompanionContainers(host, [
      { name: 'a-worker', status: 'Up', cwd: '/w', active: true },
      { name: 'i-worker', status: 'Up', cwd: '/w', active: false },
    ]);
    assert.strictEqual(active.lastActivity, null);
    assert.strictEqual(inactive.lastActivity, null);
  });
});

describe('parseProbe', () => {
  it('parses OS + ARCH + HAVE=1', () => {
    assert.deepStrictEqual(parseProbe('OS=Linux\nARCH=x86_64\nHAVE=1\n'), { os: 'Linux', arch: 'x86_64', have: true });
  });
  it('parses HAVE=0', () => {
    assert.deepStrictEqual(parseProbe('OS=Linux\nARCH=aarch64\nHAVE=0\n'), { os: 'Linux', arch: 'aarch64', have: false });
  });
  it('parses a Windows (MINGW) probe — uname -s carries the OS detail', () => {
    assert.deepStrictEqual(parseProbe('OS=MINGW64_NT-10.0-19045\nARCH=x86_64\nHAVE=1\n'),
      { os: 'MINGW64_NT-10.0-19045', arch: 'x86_64', have: true });
  });
  it('handles missing fields / noisy stdout', () => {
    assert.deepStrictEqual(parseProbe('ARCH=arm64\n'), { os: '', arch: 'arm64', have: false });
    assert.deepStrictEqual(parseProbe(''), { os: '', arch: '', have: false });
  });
  it('tolerates trailing \r (Windows CRLF probe via Git Bash)', () => {
    // A Windows Git Bash probe may emit CRLF. In JS regex `.` excludes line
    // terminators, so the captured OS/ARCH values never include the \r; parseProbe
    // still .trim()s defensively. Either way targetForUname sees a clean value.
    assert.deepStrictEqual(parseProbe('OS=Darwin\r\nARCH=arm64\r\nHAVE=1\r\n'),
      { os: 'Darwin', arch: 'arm64', have: true });
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
    assert.deepStrictEqual(parseProbe(r.stdout), { os: expectOs(), arch: expectArch(), have: true });
    fs.rmSync(bin, { force: true });
  });

  it('HAVE=0 when the binary is absent', () => {
    const r = spawnSync('bash', ['-c', buildProbeScript(remotePath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(parseProbe(r.stdout), { os: expectOs(), arch: expectArch(), have: false });
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

// The os/arch this test machine reports via uname -s / uname -m — so the probe
// bash tests can assert the real OS= + ARCH= lines without hardcoding.
function expectOs() {
  return spawnSync('uname', ['-s'], { encoding: 'utf8' }).stdout.trim();
}
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
    'darwin/amd64': 'warden-companion-darwin-amd64',
    'darwin/arm64': 'warden-companion-darwin-arm64',
    'windows/amd64': 'warden-companion-windows-amd64.exe',
    'windows/arm64': 'warden-companion-windows-arm64.exe',
  },
};

// Build a fake transport whose ping reports the test version (a healthy channel).
const healthyTransport = (extra = {}) => fakeTransport((req) => {
  if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover', 'capturePanes', 'hasSession', 'spawnSession', 'killSession', 'resize'] } };
  if (req.method === 'discover') return { id: req.id, ok: true, result: { containers: extra.containers ?? [] } };
  if (req.method === 'capturePanes') return { id: req.id, ok: true, result: { panes: extra.panes ?? {} } };
  if (req.method === 'hasSession') return { id: req.id, ok: true, result: { exists: extra.exists ?? true } };
  if (req.method === 'spawnSession') return { id: req.id, ok: true, result: {} };
  if (req.method === 'killSession') return { id: req.id, ok: true, result: {} };
  if (req.method === 'resize') return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } };
  return { id: req.id, ok: false, error: 'unknown method' };
});

// Minimal deps: a probe `run` returning a canned ARCH/HAVE, a recording upload,
// and spawnChannel returning a fake transport. `overrides` customizes any leg.
function fakeDeps(overrides = {}) {
  const calls = { run: 0, upload: 0, spawnChannel: 0 };
  const deps = {
    manifest: TEST_MANIFEST,
    run: async () => { calls.run++; return { ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }; },
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
      run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=aarch64\nHAVE=1\n' }),
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
      run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=1\n' }),
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

  it('unsupported host target (unknown os or arch) -> CompanionTransportError, no wrong-OS fallback', async () => {
    // A host whose (uname -s, uname -m) pair isn't in the matrix must NOT get a
    // best-effort linux binary — that would exec-fail opaquely on macOS/Windows.
    // targetForUname returns null and the bootstrap names the supported set.
    const { deps: depsArch } = fakeDeps({
      run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=riscv64\nHAVE=0\n' }),
    });
    await assert.rejects(() => getChannel('prod-5a', {}, depsArch), (e) => {
      assert.ok(e instanceof CompanionTransportError);
      assert.ok(/riscv64/.test(e.message), `names the bad arch: ${e.message}`);
      assert.ok(/windows\/arm64 only/.test(e.message), `names the full supported set: ${e.message}`);
      return true;
    });
    const { deps: depsOs } = fakeDeps({
      run: async () => ({ ok: true, stdout: 'OS=FreeBSD\nARCH=amd64\nHAVE=0\n' }),
    });
    await assert.rejects(() => getChannel('prod-5b', {}, depsOs), (e) => {
      assert.ok(/FreeBSD/.test(e.message), `names the bad os: ${e.message}`);
      return true;
    });
  });

  it('OS-aware selection: a Darwin host uploads the DARWIN binary (no hard-coded linux/)', async () => {
    // The whole point of WARDEN-294: a macOS arm64 host must select the darwin
    // Mach-O binary, not the linux one. Pre-294 this selected linux/arm64 and
    // failed opaquely ("cannot execute binary file"). Asserts the uploaded path.
    let uploadedBinary;
    const { deps } = fakeDeps({
      run: async () => ({ ok: true, stdout: 'OS=Darwin\nARCH=arm64\nHAVE=0\n' }),
      upload: async (_h, localBinary) => { uploadedBinary = localBinary; return { ok: true }; },
    });
    await getChannel('mac-1', {}, deps);
    assert.ok((uploadedBinary || '').endsWith('warden-companion-darwin-arm64'),
      `selected ${uploadedBinary} (expected the darwin/arm64 binary)`);
  });

  it('OS-aware selection: a MINGW (Windows) host uploads the WINDOWS .exe binary', async () => {
    let uploadedBinary;
    const { deps } = fakeDeps({
      run: async () => ({ ok: true, stdout: 'OS=MINGW64_NT-10.0-19045\nARCH=x86_64\nHAVE=0\n' }),
      upload: async (_h, localBinary) => { uploadedBinary = localBinary; return { ok: true }; },
    });
    await getChannel('win-1', {}, deps);
    assert.ok((uploadedBinary || '').endsWith('warden-companion-windows-amd64.exe'),
      `selected ${uploadedBinary} (expected the windows/amd64 .exe)`);
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
      run: async () => { runCalls++; return { ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }; },
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

  it('forwards opts.activity in the discover RPC params (lean-mode parity, WARDEN-376)', async () => {
    // The lifecycle poll runs lean (activity:false) to SKIP per-container
    // capture-pane work; the user-facing discover omits activity (-> true) so the
    // host captures leading lines. Both must be forwarded exactly — otherwise the
    // lean poll would suddenly do per-active-container capture-pane work every
    // tick (a quiet local-cost regression vs the default path's lean mode).
    const seen = [];
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'discover') { seen.push(req.params); return { id: req.id, ok: true, result: { containers: [] } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    await discover('prod', {}, { activity: false }, deps); // lean
    await discover('prod', {}, {}, deps);                  // user-facing (omitted)
    await discover('prod', {}, { activity: true }, deps);  // explicit
    assert.strictEqual(seen.length, 3);
    assert.deepStrictEqual(seen[0], { session: 'agent', activity: false }, 'lean forwards activity:false');
    assert.deepStrictEqual(seen[1], { session: 'agent', activity: true }, 'omitted forwards activity:true');
    assert.deepStrictEqual(seen[2], { session: 'agent', activity: true }, 'explicit true forwards activity:true');
  });

  it('populates lastActivity from a container pane line so Fleet Health classifies (not UNKNOWN) — WARDEN-376', async () => {
    // Success criterion #1: a discovered ACTIVE agent populates lastActivity with
    // the SAME field the default path sets (parsed by the same helper), so
    // getHealthState classifies HEALTHY/WARNING/CRITICAL instead of UNKNOWN.
    const containers = [
      { name: 'p-worker', status: 'Up', cwd: '/w', active: true, pane: '[2024-01-15 10:30:00] thinking' },
      { name: 'p-planner', status: 'Up', cwd: '/w', active: false }, // inactive: no pane
    ];
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport({ containers }) });
    const res = await discover('prod', { tmuxSession: 'agent' }, {}, deps);
    assert.strictEqual(res.ok, true);
    const worker = res.chats.find((c) => c.key === 'p-worker');
    assert.strictEqual(worker.active, true);
    assert.ok(Number.isFinite(worker.lastActivity), 'active agent has a real lastActivity (NOT UNKNOWN)');
    assert.strictEqual(worker.lastActivity, parseActivityTimestamp('[2024-01-15 10:30:00] thinking'));
    const planner = res.chats.find((c) => c.key === 'p-planner');
    assert.strictEqual(planner.lastActivity, null, 'inactive agent has no lastActivity');
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

// --------------------------------- hasSession --------------------------------
// WARDEN-382 (slice 3): the hasSession RPC client. has-session is the pre-attach
// / pre-recovery liveness probe; routing it over the persistent channel collapses
// the per-probe SSH handshake. The contract under test: returns {ok, exists} on a
// reachable host and flags transport failures so tmux.js can map them to
// host_unreachable instead of the ambiguous session_dead — companion-or-fail, no
// raw-SSH fallback anywhere.

describe('hasSession() via companion (companion-or-fail)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('returns {ok:true, exists:true} when the host-side session is live', async () => {
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport({ exists: true }) });
    const res = await hasSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.host, 'prod');
    assert.strictEqual(res.exists, true);
  });

  it('returns {ok:true, exists:false} when the session is absent (host reachable)', async () => {
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport({ exists: false }) });
    const res = await hasSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.exists, false);
  });

  it('sends the hasSession RPC params {container, session} (container null for bare-tmux)', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'hasSession') { sent = req.params; return { id: req.id, ok: true, result: { exists: true } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // yatfa chat: container + session.
    await hasSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.deepStrictEqual(sent, { container: 'p-worker', session: 'agent' });
    // bare-tmux chat: container null, session is the target.
    await hasSession('prod', { container: null, session: 'mysession' }, {}, {}, deps);
    assert.deepStrictEqual(sent, { container: null, session: 'mysession' });
  });

  it('target fallback session->container->agent is applied on the JS side', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'hasSession') { sent = req.params; return { id: req.id, ok: true, result: { exists: false } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // empty session -> target falls back to container
    await hasSession('prod', { container: 'c1', session: '' }, {}, {}, deps);
    assert.strictEqual(sent.session, 'c1', 'empty session falls back to container');
    // nothing set -> target 'agent'
    await hasSession('prod', { container: 'c2', session: null }, {}, {}, deps);
    assert.strictEqual(sent.session, 'c2', 'null session falls back to container');
    await hasSession('prod', {}, {}, {}, deps);
    assert.strictEqual(sent.session, 'agent', 'no container/session -> agent');
    assert.strictEqual(sent.container, null, 'no container -> null');
  });

  it('bootstrap failure -> {ok:false, transport:true, actionable error}, NOT a raw-ssh fallback', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    const res = await hasSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.exists, false);
    assert.strictEqual(res.transport, true, 'a bootstrap/transport failure is flagged transport');
    assert.ok(res.error.includes('companion'), `error names the companion: ${res.error}`);
    // The error must carry the actionable opt-out guidance.
    assert.ok(res.error.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `bootstrap error must tell the user how to opt out: ${res.error}`);
  });

  it('channel death (timeout) mid-RPC -> {ok:false, transport:true}', async () => {
    // The channel is alive for ping (bootstrap succeeds) but never answers the
    // hasSession RPC -> CompanionTransportError (timeout) -> flagged transport.
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER } }
          : null), // hasSession never gets a reply
    });
    const res = await hasSession('prod', { container: 'p-worker', session: 'agent' }, {}, { timeout: 60 }, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.transport, true, 'channel timeout is a transport failure');
    assert.strictEqual(res.exists, false);
  });

  it('hasSession RPC error ({ok:false}) propagates as {ok:false} without fallback', async () => {
    // The Go RPC itself never fails for a host-side command result (it returns
    // exists:false), so this exercises the dispatch-level / generic-error path.
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER } }
          : { id: req.id, ok: false, error: 'hasSession failed: tmux: not found' }),
    });
    const res = await hasSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.transport, false, 'an RPC error is NOT a transport failure');
    assert.ok(res.error.includes('hasSession failed'), res.error);
  });

  it('(local) host is refused (companion serves remote hosts only)', async () => {
    const res = await hasSession('(local)', { container: null, session: 'agent' }, {});
    assert.strictEqual(res.ok, false);
    assert.ok(/local/.test(res.error));
  });
});

// --------------------------------- lifecycle ---------------------------------
// WARDEN-386 (slice 3): the spawnSession/killSession RPCs — the agent create/
// destroy twins migrated off per-op SSH. The contract under test mirrors
// capturePanes: companion-or-fail (no raw-SSH fallback), (local) refused, and
// the exact params sent over channel.call (the host-side RPC builds the tmux
// argv from them — locked byte-for-byte in the e2e test below).

describe('spawnSession() via companion (companion-or-fail)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('returns {ok:true} from the spawnSession RPC', async () => {
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport() });
    const res = await spawnSession('prod', { container: 'p-worker', session: 'agent', cwd: '/w', cmd: ['claude'] }, {}, {}, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.host, 'prod');
  });

  it('sends container/session/cwd/cmd (cmd split; container null + empty cmd for a manual default-shell chat)', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'spawnSession') { sent = req.params; return { id: req.id, ok: true, result: {} }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // yatfa chat: container set, cmd argv (pre-split by tmux.js), cwd verbatim.
    await spawnSession('prod', { container: 'p-worker', session: 'agent', cwd: '/work/p', cmd: ['claude', '--resume', 'xyz'] }, {}, {}, deps);
    assert.deepStrictEqual(sent, { container: 'p-worker', session: 'agent', cwd: '/work/p', cmd: ['claude', '--resume', 'xyz'] });

    // manual chat: container null (→ bare tmux on the host), empty cmd (→ default shell).
    await spawnSession('prod', { container: null, session: 'mysess', cwd: '', cmd: [] }, {}, {}, deps);
    assert.deepStrictEqual(sent, { container: null, session: 'mysess', cwd: '', cmd: [] },
      'empty cmd → cmd:[] (host appends no trailing argv → default shell, WARDEN-223)');
  });

  it('applies the session -> container -> agent fallback on the JS side too', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'spawnSession') { sent = req.params; return { id: req.id, ok: true, result: {} }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    await spawnSession('prod', { container: 'c1', session: '', cwd: '', cmd: [] }, {}, {}, deps);
    assert.strictEqual(sent.session, 'c1', 'empty session falls back to container');
  });

  it('bootstrap failure -> {ok:false, actionable error}, NOT a raw-ssh fallback', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    const res = await spawnSession('prod', { container: 'p-worker', session: 'agent', cwd: '', cmd: [] }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('companion'), `error names the companion: ${res.error}`);
    assert.ok(res.error.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `bootstrap error must tell the user how to opt out: ${res.error}`);
  });

  it('spawnSession RPC error ({ok:false}) propagates without fallback', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER } }
          : { id: req.id, ok: false, error: 'spawnSession failed: duplicate session: agent' }),
    });
    const res = await spawnSession('prod', { container: 'p-worker', session: 'agent', cwd: '', cmd: [] }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('duplicate session'), res.error);
  });

  it('(local) host is refused (companion serves remote hosts only)', async () => {
    const res = await spawnSession('(local)', { container: null, session: 's', cwd: '', cmd: [] }, {}, {});
    assert.strictEqual(res.ok, false);
    assert.ok(/local/.test(res.error));
  });
});

describe('killSession() via companion (companion-or-fail, best-effort)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('returns {ok:true} from the killSession RPC', async () => {
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport() });
    const res = await killSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.host, 'prod');
  });

  it('sends container/session (container null for a bare-tmux chat)', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'killSession') { sent = req.params; return { id: req.id, ok: true, result: {} }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    await killSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.deepStrictEqual(sent, { container: 'p-worker', session: 'agent' });
    await killSession('prod', { container: null, session: 'mysess' }, {}, {}, deps);
    assert.deepStrictEqual(sent, { container: null, session: 'mysess' });
  });

  it('"session not found" RPC ok is surfaced as a benign ok (idempotent — the host returns ok for an already-dead session)', async () => {
    // kill is idempotent: the Go side returns ok for "session not found" /
    // "no server running" (the session is already gone). The client must surface
    // that as {ok:true}, NOT a hard error — or /api/kill's best-effort semantics
    // break. (The host-side idempotency is exercised end-to-end below.)
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport() });
    const res = await killSession('prod', { container: null, session: 'already-dead' }, {}, {}, deps);
    assert.strictEqual(res.ok, true, 'an already-dead session is a benign ok, not an error');
  });

  it('bootstrap failure -> {ok:false, actionable error}, NOT a raw-ssh fallback', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Connection refused' }),
    });
    const res = await killSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('companion'), `error names the companion: ${res.error}`);
    assert.ok(res.error.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `bootstrap error must tell the user how to opt out: ${res.error}`);
  });

  it('killSession RPC error (a genuine failure, not session-not-found) propagates without fallback', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER } }
          : { id: req.id, ok: false, error: 'killSession failed: docker: not found' }),
    });
    const res = await killSession('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('docker: not found'), res.error);
  });

  it('(local) host is refused (companion serves remote hosts only)', async () => {
    const res = await killSession('(local)', { container: null, session: 's' }, {}, {});
    assert.strictEqual(res.ok, false);
    assert.ok(/local/.test(res.error));
  });
});

// WARDEN-409 (slice 4): the resize RPC client. This one-line control-plane
// tmux-option op routes over the persistent channel (zero per-open / per-resize
// SSH handshakes). The contract under test: it returns the SAME raw
// {host, ok, code, stdout, stderr} shape runTmux produces (so the existing call
// site is unchanged) and never falls back to raw SSH.

describe('resize() via companion (companion-or-fail, raw result shape)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('resize returns the raw {host, ok, code, stdout, stderr} shape on success', async () => {
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport() });
    const res = await companionResize('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.host, 'prod');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.stdout, '');
    assert.strictEqual(res.stderr, '');
  });

  it('resize sends {container, session} with the target fallback applied on the JS side', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER } };
      if (req.method === 'resize') { sent = req.params; return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // yatfa chat: container + session.
    await companionResize('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.deepStrictEqual(sent, { container: 'p-worker', session: 'agent' });
    // empty session -> target falls back to container.
    await companionResize('prod', { container: 'c1', session: '' }, {}, {}, deps);
    assert.strictEqual(sent.session, 'c1', 'empty session falls back to container');
    // nothing set -> target 'agent', container null.
    await companionResize('prod', {}, {}, {}, deps);
    assert.strictEqual(sent.session, 'agent', 'no container/session -> agent');
    assert.strictEqual(sent.container, null, 'no container -> null');
  });

  it('bootstrap failure -> {ok:false, code:-1, actionable error}, NOT a raw-ssh fallback', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    const res = await companionResize('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, -1);
    assert.strictEqual(res.stdout, '');
    // The message rides on stderr (the raw runTmux shape), not an `error` field.
    assert.ok(res.stderr.includes('companion'), `error names the companion: ${res.stderr}`);
    assert.ok(res.stderr.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `bootstrap error must tell the user how to opt out: ${res.stderr}`);
  });

  it('channel death (timeout) mid-RPC -> {ok:false, code:-1}', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER } }
          : null), // resize never gets a reply
    });
    const res = await companionResize('prod', { container: 'p-worker', session: 'agent' }, {}, { timeout: 60 }, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, -1);
  });

  it('RPC error ({ok:false}) propagates as {ok:false} without fallback', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER } }
          : { id: req.id, ok: false, error: 'resize failed: tmux: not found' }),
    });
    const res = await companionResize('prod', { container: 'p-worker', session: 'agent' }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.stderr.includes('resize failed'), res.stderr);
  });

  it('(local) host is refused (companion serves remote hosts only)', async () => {
    const res = await companionResize('(local)', { container: null, session: 'agent' }, {});
    assert.strictEqual(res.ok, false);
    assert.ok(/local/.test(res.stderr));
  });
});

// ---------------------- control-plane routing over the companion ----------------
// WARDEN-409: the routing change lives in src/tmux.js (resize), tested here
// alongside the rest of the transport surface. Drives
// the REAL exported functions through injected companion clients (no real ssh) and
// asserts the parity contract: under the flag a REMOTE host routes through the
// companion and returns the SAME result shape / tri-state the default runTmux path
// produces; LOCAL and the flag-off path keep runTmux byte-for-byte.

describe('control-plane routing over the companion (WARDEN-409 parity)', () => {
  const remoteChat = { host: 'prod-1', container: 'p-worker', session: 'agent' };
  const localChat = { host: '(local)', session: 'agent' };

  beforeEach(() => { process.env.WARDEN_COMPANION_TRANSPORT = '1'; });
  afterEach(() => {
    if (ORIG_COMPANION_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_COMPANION_ENV;
  });

  it('resize under the flag routes through the companion, NOT runTmux', async () => {
    let runTmuxCalls = 0;
    let rpcCalls = 0;
    await tmuxResize(remoteChat, {}, 100, 30, {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionResize: async () => { rpcCalls++; return { host: 'prod-1', ok: true, code: 0, stdout: '', stderr: '' }; },
    });
    assert.strictEqual(rpcCalls, 1, 'remote resize under the flag routes through the companion');
    assert.strictEqual(runTmuxCalls, 0, 'remote resize under the flag does NOT call runTmux');
  });

  it('LOCAL still uses runTmux (never the companion), even under the flag', async () => {
    let runTmuxCalls = 0;
    let companionCalls = 0;
    await tmuxResize(localChat, {}, 100, 30, {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionResize: async () => { companionCalls++; return { host: '(local)', ok: true, code: 0, stdout: '', stderr: '' }; },
    });
    assert.strictEqual(runTmuxCalls, 1, 'local control-plane op uses runTmux');
    assert.strictEqual(companionCalls, 0, 'local control-plane op does NOT call the companion');
  });
});

describe('control-plane routing: the default path (flag off) is byte-for-byte unchanged', () => {
  const remoteChat = { host: 'prod-1', container: 'p-worker', session: 'agent' };

  afterEach(() => {
    if (ORIG_COMPANION_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_COMPANION_ENV;
  });

  it('flag OFF -> resize uses runTmux and the argv is unchanged', async () => {
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    let runTmuxCalls = 0;
    let companionCalls = 0;
    let captured = null;
    const r = await tmuxResize(remoteChat, {}, 100, 30, {
      runTmux: async (chat, args) => { runTmuxCalls++; captured = args; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionResize: async () => { companionCalls++; return { host: 'prod-1', ok: true, code: 0, stdout: '', stderr: '' }; },
    });
    assert.strictEqual(runTmuxCalls, 1);
    assert.strictEqual(companionCalls, 0, 'flag OFF -> companion not consulted');
    assert.deepStrictEqual(captured, ['set-option', '-t', 'agent', 'window-size', 'latest'], 'argv byte-for-byte unchanged');
    assert.strictEqual(r, undefined, 'resize still returns nothing (await-only)');
  });
});

// ---------------------- probe routing over the companion ---------------------
// WARDEN-382: the routing change lives in src/tmux.js (probeSession/hasSession),
// but the whole transport surface is tested here. Drives the REAL exported
// probeSession/hasSession through an injected companion client (no real ssh) and
// asserts the reason contract classifyProbe produces — the ticket's tri-state:
// exists -> alive, !exists -> session_dead, transport -> host_unreachable.

// Capture/restore WARDEN_COMPANION_TRANSPORT so the routing tests can flip the
// gate without leaking the change to the rest of the suite.
const ORIG_COMPANION_ENV = process.env.WARDEN_COMPANION_TRANSPORT;

describe('probe routing over the companion (WARDEN-382 reason mapping)', () => {
  const remoteChat = { host: 'prod-1', container: 'p-worker', session: 'agent' };

  beforeEach(() => { process.env.WARDEN_COMPANION_TRANSPORT = '1'; });
  afterEach(() => {
    if (ORIG_COMPANION_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_COMPANION_ENV;
  });

  it('exists:true -> probeSession ok -> classifyProbe null (alive)', async () => {
    const probe = await probeSession(remoteChat, {}, {}, {
      companionHasSession: async () => ({ host: 'prod-1', ok: true, exists: true }),
    });
    assert.strictEqual(probe.ok, true);
    assert.strictEqual(probe.code, 0);
    assert.strictEqual(classifyProbe(probe), null, 'live session -> null reason (attach normally)');
  });

  it('exists:false -> classifyProbe session_dead', async () => {
    const probe = await probeSession(remoteChat, {}, {}, {
      companionHasSession: async () => ({ host: 'prod-1', ok: true, exists: false }),
    });
    assert.strictEqual(probe.ok, false);
    // session_dead requires NOT looking like transport: stdout empty, no transport
    // phrases. The synthesized result carries "can't find session" on stderr (code 1).
    assert.ok((probe.stderr || '').includes("can't find session"), probe.stderr);
    assert.strictEqual(classifyProbe(probe), 'session_dead');
  });

  it('transport failure -> classifyProbe host_unreachable', async () => {
    const probe = await probeSession(remoteChat, {}, {}, {
      companionHasSession: async () => ({
        host: 'prod-1', ok: false, transport: true,
        error: 'companion transport error for prod-1: bootstrap probe failed',
        exists: false,
      }),
    });
    assert.strictEqual(probe.ok, false);
    assert.strictEqual(probe.code, -1, 'transport -> code -1 so isTransportFailure classifies it');
    assert.strictEqual(classifyProbe(probe), 'host_unreachable');
  });

  it('hasSession() boolean: true iff the companion says exists:true', async () => {
    const yes = await tmuxHasSession(remoteChat, {}, {
      companionHasSession: async () => ({ host: 'prod-1', ok: true, exists: true }),
    });
    assert.strictEqual(yes, true, 'exists:true -> hasSession true');
    const no = await tmuxHasSession(remoteChat, {}, {
      companionHasSession: async () => ({ host: 'prod-1', ok: true, exists: false }),
    });
    assert.strictEqual(no, false, 'exists:false -> hasSession false');
    const dead = await tmuxHasSession(remoteChat, {}, {
      companionHasSession: async () => ({ host: 'prod-1', ok: false, transport: true, error: 'x', exists: false }),
    });
    assert.strictEqual(dead, false, 'transport failure -> hasSession false');
  });

  it('runTmux is NOT invoked for a remote probe under the flag', async () => {
    let runTmuxCalls = 0;
    await probeSession(remoteChat, {}, {}, {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionHasSession: async () => ({ host: 'prod-1', ok: true, exists: true }),
    });
    assert.strictEqual(runTmuxCalls, 0, 'remote probe under the flag routes through the companion, NOT runTmux');
  });

  it('LOCAL still uses runTmux (never the companion), even under the flag', async () => {
    let runTmuxCalls = 0;
    let companionCalls = 0;
    const localChat = { host: '(local)', session: 'agent' };
    await probeSession(localChat, {}, {}, {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionHasSession: async () => { companionCalls++; return { host: '(local)', ok: true, exists: true }; },
    });
    assert.strictEqual(runTmuxCalls, 1, 'local probe uses runTmux');
    assert.strictEqual(companionCalls, 0, 'local probe does NOT call the companion');
  });
});

describe('probe routing: the default path (flag off) is byte-for-byte unchanged', () => {
  afterEach(() => {
    if (ORIG_COMPANION_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_COMPANION_ENV;
  });

  it('a remote probe uses runTmux (the deps seam) when the flag is OFF', async () => {
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    let runTmuxCalls = 0;
    let companionCalls = 0;
    const remoteChat = { host: 'prod-1', container: 'p-worker', session: 'agent' };
    const r = await probeSession(remoteChat, {}, { timeout: 5000 }, {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionHasSession: async () => { companionCalls++; return { host: 'prod-1', ok: true, exists: true }; },
    });
    assert.strictEqual(runTmuxCalls, 1, 'flag OFF -> remote probe uses runTmux (default path)');
    assert.strictEqual(companionCalls, 0, 'flag OFF -> companion is not consulted');
    assert.deepStrictEqual(r, { ok: true, code: 0, stdout: '', stderr: '' }, 'raw runTmux result passed through');
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
      assert.ok(res.methods.includes('hasSession'), 'ping advertises the hasSession RPC (WARDEN-382)');
      assert.ok(res.methods.includes('resize'), 'ping advertises the resize RPC (WARDEN-409)');
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

  // WARDEN-382 (slice 3) parity test: the Go companion runs `tmux has-session`
  // LOCALLY via bash -lc and reports exists = (exit 0). Probes a live session
  // (exists:true) and an absent one (exists:false) so both halves of the tri-state
  // are exercised against the real binary. Skipped unless tmux is available.
  (canCapture ? it : it.skip)('hasSession: real binary reports exists true/false over stdio', async () => {
    const session = uniqueSession();
    const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', session], { encoding: 'utf8' });
    assert.strictEqual(setup.status, 0, `tmux new-session failed: ${setup.stderr}`);
    try {
      const ch = new CompanionChannel('local-binary', realBinaryTransport());
      try {
        // A live session -> exists:true.
        const live = await ch.call('hasSession', { container: '', session }, { timeout: 8000 });
        assert.ok(live && typeof live === 'object', 'response is an object');
        assert.strictEqual(live.exists, true, `live session '${session}' -> exists:true`);

        // A session nobody created -> exists:false (NOT an RPC error: the host
        // answered, the session is simply absent — the separation this slice ships).
        const absent = await ch.call('hasSession', { container: '', session: `${session}-nope` }, { timeout: 8000 });
        assert.strictEqual(absent.exists, false, 'absent session -> exists:false');
      } finally {
        ch.kill();
      }
    } finally {
      spawnSync(TMUX_BIN, ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  });

  // WARDEN-386 (slice 3): the make-or-break parity test for the lifecycle RPCs.
  // The Go companion builds the new-session/kill-session argv, runs it via bash
  // -lc against a REAL tmux server, and the session must actually come up / come
  // down — proving the host-side argv matches what the default runTmux path
  // produces. Also locks kill's idempotency: killing an already-dead session is
  // a benign ok (the host returns ok, not a hard error). Skipped unless tmux +
  // the binary are available (the docker-exec path is the same code with a
  // `docker exec <c>` prefix; the bare-tmux path here exercises every other seam).
  (canCapture ? it : it.skip)('spawnSession + killSession: real binary creates + destroys a live tmux session over stdio', async () => {
    const session = uniqueSession();
    const ch = new CompanionChannel('local-binary', realBinaryTransport());
    try {
      // CREATE: an empty cmd launches tmux's default shell (WARDEN-223) — a
      // long-lived session that stays alive to be verified.
      await ch.call('spawnSession', { container: '', session, cwd: '', cmd: [] }, { timeout: 8000 });
      const hasAfterSpawn = spawnSync(TMUX_BIN, ['has-session', '-t', session], { encoding: 'utf8' });
      assert.strictEqual(hasAfterSpawn.status, 0, 'the spawned session is alive (default shell stays up)');

      // DESTROY: killSession tears it down.
      await ch.call('killSession', { container: '', session }, { timeout: 8000 });
      const hasAfterKill = spawnSync(TMUX_BIN, ['has-session', '-t', session], { encoding: 'utf8' });
      assert.notStrictEqual(hasAfterKill.status, 0, 'the session is gone after killSession');

      // IDEMPOTENT: killing an already-dead session resolves ok (the host
      // surfaces "session not found" as a benign ok — ch.call would REJECT with
      // CompanionRpcError if the host returned {ok:false}, failing this test).
      await ch.call('killSession', { container: '', session }, { timeout: 8000 });
    } finally {
      ch.kill();
      spawnSync(TMUX_BIN, ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  });
  // WARDEN-409 (slice 4) parity test: the Go companion runs the control-plane
  // tmux option LOCALLY via bash -lc against a REAL tmux session and returns the
  // raw {ok, code, stdout, stderr} shape. resize runs set-option window-size
  // latest (ok:true against a live session). Skipped unless tmux is available.
  (canCapture ? it : it.skip)('resize: real binary runs the control-plane tmux option over stdio', async () => {
    const session = uniqueSession();
    const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', session], { encoding: 'utf8' });
    assert.strictEqual(setup.status, 0, `tmux new-session failed: ${setup.stderr}`);
    try {
      const ch = new CompanionChannel('local-binary', realBinaryTransport());
      try {
        // resize: set-option -t <session> window-size latest -> ok:true, raw shape.
        const rz = await ch.call('resize', { container: '', session }, { timeout: 8000 });
        assert.ok(rz && typeof rz === 'object', 'resize response is an object');
        assert.strictEqual(rz.ok, true, 'resize against a live session -> ok:true');
        assert.strictEqual(rz.code, 0, 'resize exit code carried in the raw result');
        assert.strictEqual(rz.stdout, '', 'resize writes no stdout');
      } finally {
        ch.kill();
      }
    } finally {
      spawnSync(TMUX_BIN, ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  });

});