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
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
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
  isCompanionTransportEnabled, applyCompanionToggle, loadManifest,
  projectSpawnModel, _resetChannelCacheForTests,
  getCompanionStatus, getAllCompanionStatuses,
  buildUninstallScript, uninstallCompanion, _channelCacheHasForTests,
  buildReapScript,
  resize as companionResize,
  send as companionSend, sendKey as companionSendKey,
  execInContext as companionExec,
  // WARDEN-413: pane-delta push (subscribePanes) — event routing, delta cache, subscriptions.
  applyPaneDelta, hasFreshPaneDelta, readPaneDeltas, PANE_DELTA_FRESH_MS,
  subscribePanes, unsubscribePanes,
  reconcilePaneSubscriptions, _getAgentStateWatchedForTests,
  _resetPaneDeltaStateForTests, _getPaneSubscriptionsForTests,
  startPaneDeltaSweep, _stopPaneDeltaSweepForTests,
  streamFileToHost, UPLOAD_CLOSE_GRACE_MS,
} from './companion.js';
import { probeSession, hasSession as tmuxHasSession, resize as tmuxResize, send as tmuxSend, sendKey as tmuxSendKey } from './tmux.js';
import { classifyProbe } from './sessionRecovery.js';
import { buildChat, parseActivityTimestamp } from './chatMeta.js';
import { buildCaptureScript, parseCaptureSentinels } from './chats.js';
// WARDEN-1261: the git-domain routing lives in src/gitRoutes.js (runGit /
// runInContext); driven here alongside the rest of the transport surface.
import { runGit, runInContext } from './gitRoutes.js';
import { shellQuote } from './ssh.js';

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
    assert.strictEqual(m.after.totalSpawns, 16, '4 hosts × 4 bootstrap spawns, once');
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

// WARDEN-439: the persisted Settings toggle drives the same env-var gate above
// via applyCompanionToggle (called at boot + on PUT /api/config). It must write
// the gate from the toggle UNLESS the operator set the env var as an override.
describe('applyCompanionToggle', () => {
  it('writes the gate ON from the toggle when enabled (no override)', () => {
    const env = {}; // operator did not set the var
    assert.strictEqual(applyCompanionToggle(true, { env }), true);
    assert.strictEqual(env.WARDEN_COMPANION_TRANSPORT, '1');
    assert.strictEqual(isCompanionTransportEnabled(env), true);
  });

  it('writes the gate OFF from the toggle when disabled (no override)', () => {
    const env = {};
    assert.strictEqual(applyCompanionToggle(false, { env }), false);
    assert.strictEqual(env.WARDEN_COMPANION_TRANSPORT, '0');
    assert.strictEqual(isCompanionTransportEnabled(env), false);
  });

  it('a live flip (disabled → enabled) updates the gate for the next op', () => {
    // Boot: toggle off.
    const env = {};
    applyCompanionToggle(false, { env });
    assert.strictEqual(isCompanionTransportEnabled(env), false);
    // PUT: flip on — the gate must follow without a restart.
    applyCompanionToggle(true, { env });
    assert.strictEqual(isCompanionTransportEnabled(env), true);
  });

  it('never clobbers an operator env-var override (force ON)', () => {
    // Operator set WARDEN_COMPANION_TRANSPORT=1 before warden started: override.
    const env = { WARDEN_COMPANION_TRANSPORT: '1' };
    // User turns the toggle OFF in Settings — the override must win.
    assert.strictEqual(applyCompanionToggle(false, { override: true, env }), true);
    assert.strictEqual(env.WARDEN_COMPANION_TRANSPORT, '1', 'operator var left intact');
  });

  it('never clobbers an operator env-var override (force OFF)', () => {
    const env = { WARDEN_COMPANION_TRANSPORT: '0' };
    // User turns the toggle ON in Settings — the override must win.
    assert.strictEqual(applyCompanionToggle(true, { override: true, env }), false);
    assert.strictEqual(env.WARDEN_COMPANION_TRANSPORT, '0', 'operator var left intact');
  });

  it('defaults to process.env when no env is passed', () => {
    const saved = process.env.WARDEN_COMPANION_TRANSPORT;
    try {
      delete process.env.WARDEN_COMPANION_TRANSPORT;
      assert.strictEqual(applyCompanionToggle(true), true);
      assert.strictEqual(process.env.WARDEN_COMPANION_TRANSPORT, '1');
    } finally {
      if (saved === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
      else process.env.WARDEN_COMPANION_TRANSPORT = saved;
    }
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

describe('buildUninstallScript (validated through bash — WARDEN-882)', () => {
  // The precise mirror of buildUploadScript: kill any running companion, rm -f
  // the binary, and rmdir ~/.warden ONLY if empty. All three legs are
  // best-effort — the script must exit 0 across every partial state.

  it('rm -f removes the binary and pkill/rmdir are best-effort (exits 0)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-uninstall-'));
    const remotePath = remoteBinaryPath('abc123');
    fs.mkdirSync(path.join(tmp, '.warden'), { recursive: true });
    const bin = path.join(tmp, '.warden', 'companion-abc123');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    const r = spawnSync('bash', ['-c', buildUninstallScript(remotePath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(bin), 'binary removed');
  });

  it('NEVER removes ~/.warden when the user keeps other files there (only-if-empty)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-uninstall-kept-'));
    const remotePath = remoteBinaryPath('abc123');
    fs.mkdirSync(path.join(tmp, '.warden'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.warden', 'companion-abc123'), 'x', { mode: 0o755 });
    // A user-owned sibling that MUST survive the only-if-empty rmdir.
    const kept = path.join(tmp, '.warden', 'user-config.json');
    fs.writeFileSync(kept, '{}');
    const r = spawnSync('bash', ['-c', buildUninstallScript(remotePath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(tmp, '.warden')), '~/.warden preserved (was non-empty)');
    assert.ok(fs.existsSync(kept), 'the user file in ~/.warden is untouched');
  });

  it('removes ~/.warden when it is empty after the binary is gone', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-uninstall-empty-'));
    const remotePath = remoteBinaryPath('deadbeef');
    fs.mkdirSync(path.join(tmp, '.warden'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.warden', 'companion-deadbeef'), 'x', { mode: 0o755 });
    const r = spawnSync('bash', ['-c', buildUninstallScript(remotePath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(tmp, '.warden')), 'removed an empty ~/.warden');
  });

  it('exits 0 with no binary and no ~/.warden at all (idempotent / never-fatal)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-uninstall-missing-'));
    const remotePath = remoteBinaryPath('fff000');
    // pkill finds nothing; rm -f is a no-op; rmdir is a no-op. Must still exit 0.
    const r = spawnSync('bash', ['-c', buildUninstallScript(remotePath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
  });

  it('quotes the (validated-hex) binary path + companion dir so they interpolate safely', () => {
    const remotePath = remoteBinaryPath('abc123');
    const script = buildUninstallScript(remotePath);
    // rm -f the manifest-version binary path, quoted; $HOME left literal.
    assert.ok(script.includes('rm -f "$HOME/.warden/companion-abc123"'), `rm -f quotes the remote path: ${script}`);
    // pkill targets the full $HOME-relative path (NOT the basename — a basename
    // pattern would self-match the bash -lc wrapper executing this script; see
    // buildUninstallScript's WHY comment). $HOME stays literal in the script
    // text; the subshell expands it before calling pkill.
    assert.ok(script.includes('pkill -f'), `pkill -f present: ${script}`);
    assert.ok(script.includes('pkill -f "$HOME/.warden/companion-abc123"'), `pkill matches the full path: ${script}`);
    assert.ok(script.includes('companion-abc123'), `pkill/rm target the manifest version: ${script}`);
    assert.ok(script.includes('|| true'), `best-effort || true guards present: ${script}`);
    // rmdir the companion dir, quoted.
    assert.ok(script.includes('rmdir "$HOME/.warden"'), `rmdir targets the companion dir: ${script}`);
  });
});

describe('buildReapScript (validated through bash — WARDEN-904)', () => {
  // The bootstrap upgrade-path hygiene op: after the channel is verified, remove
  // orphaned companion-<oldver> siblings a version bump left behind — WITHOUT ever
  // touching the current binary or the user's other ~/.warden files. Best-effort:
  // the script must exit 0 across every state (nothing to reap, only the current
  // binary, a dir matching the glob).

  it('reaps superseded companion-* siblings but leaves the current binary + user files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-reap-'));
    const currentPath = remoteBinaryPath('newver'); // $HOME/.warden/companion-newver
    fs.mkdirSync(path.join(tmp, '.warden'), { recursive: true });
    // The current binary (MUST survive — the live channel fronts it).
    const cur = path.join(tmp, '.warden', 'companion-newver');
    fs.writeFileSync(cur, 'CURRENT', { mode: 0o755 });
    // Two superseded siblings left by prior version bumps (MUST be reaped).
    fs.writeFileSync(path.join(tmp, '.warden', 'companion-oldver1'), 'OLD1');
    fs.writeFileSync(path.join(tmp, '.warden', 'companion-oldver2'), 'OLD2');
    // A user-owned file in ~/.warden (MUST survive — not a companion-* sibling).
    const user = path.join(tmp, '.warden', 'user-config.json');
    fs.writeFileSync(user, '{}');
    const r = spawnSync('bash', ['-c', buildReapScript(currentPath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(cur), 'the current binary is preserved');
    assert.strictEqual(fs.readFileSync(cur, 'utf8'), 'CURRENT', 'current binary contents intact');
    assert.ok(!fs.existsSync(path.join(tmp, '.warden', 'companion-oldver1')), 'old sibling 1 reaped');
    assert.ok(!fs.existsSync(path.join(tmp, '.warden', 'companion-oldver2')), 'old sibling 2 reaped');
    assert.ok(fs.existsSync(user), 'a non-companion user file is untouched');
  });

  it('is a no-op (exit 0) when only the current binary exists — the same-version re-bootstrap case', () => {
    // Success criterion 2: a same-version re-bootstrap reaps nothing. With only
    // the current binary present, the glob matches it but the [ != current ]
    // guard skips it, so nothing is removed and the script still exits 0.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-reap-solo-'));
    const currentPath = remoteBinaryPath('abc123');
    fs.mkdirSync(path.join(tmp, '.warden'), { recursive: true });
    const cur = path.join(tmp, '.warden', 'companion-abc123');
    fs.writeFileSync(cur, 'x', { mode: 0o755 });
    const r = spawnSync('bash', ['-c', buildReapScript(currentPath)], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(cur), 'the lone current binary is untouched (reaped nothing)');
  });

  it('is a no-op (exit 0) when there is no ~/.warden / nothing to reap', () => {
    // A first-ever bootstrap (no ~/.warden) or a host with no companion-* files:
    // the glob matches nothing, the loop body short-circuits, `; true` exits 0.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-reap-empty-'));
    // Intentionally do NOT create ~/.warden.
    const r = spawnSync('bash', ['-c', buildReapScript(remoteBinaryPath('abc123'))], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, 'exits 0 even with nothing to reap (never-fatal)');
  });

  it('never removes a directory that happens to match companion-* (the -f guard)', () => {
    // A directory matching the glob must not be touched: [ -f "$f" ] skips it
    // (and rm -f would not remove a non-empty dir anyway). Defense-in-depth so a
    // stray dir name can never trip the reap.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-reap-dir-'));
    fs.mkdirSync(path.join(tmp, '.warden', 'companion-strangedir'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.warden', 'companion-abc'), 'x');
    const r = spawnSync('bash', ['-c', buildReapScript(remoteBinaryPath('abc'))], {
      env: { ...process.env, HOME: tmp }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(tmp, '.warden', 'companion-strangedir')), 'the dir survived');
  });

  it('targets only non-current companion-* siblings and quotes $HOME + the current path', () => {
    const currentPath = remoteBinaryPath('abc123');
    const script = buildReapScript(currentPath);
    // Globs the companion dir's companion-* siblings ($HOME double-quoted → remote expand).
    assert.ok(script.includes('"$HOME/.warden"/companion-*'), `globs companion-* in $HOME/.warden: ${script}`);
    // Excludes the current path; $HOME stays literal so it expands on the host,
    // matching the expanded $f (the current binary always excludes itself).
    assert.ok(script.includes('[ "$f" != "$HOME/.warden/companion-abc123" ]'),
      `excludes the current path: ${script}`);
    // rm -f the sibling, quoted against spaces/special chars in the path.
    assert.ok(script.includes('rm -f "$f"'), `quoted rm -f: ${script}`);
    // Forces exit 0 (best-effort) even when the glob is empty or the body short-circuits.
    assert.ok(script.endsWith('; true'), `trailing ; true forces exit 0: ${script}`);
    // Only the regular-file guard lets a target through (skips the empty-glob literal + dirs).
    assert.ok(script.includes('[ -f "$f" ]'), `regular-file guard present: ${script}`);
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
    // Test hook (WARDEN-413): inject an unsolicited line as if the companion
    // pushed it (subscribePanes paneDelta events arrive without a request).
    _inject(line) { setImmediate(() => { if (lineCB) lineCB(line); }); },
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

// --------------------------- event routing (WARDEN-413) ----------------------
// Unsolicited event lines (subscribePanes paneDelta pushes) carry an `event`
// field and NO id. _onLine must dispatch them to a registered handler instead of
// dropping them as an unknown id, while leaving request/response RPC framing
// byte-for-byte unchanged — a strictly additive protocol addition.

describe('CompanionChannel event routing (WARDEN-413)', () => {
  // _inject emits via setImmediate; await one macrotask so the handler has run.
  const tick = () => new Promise((r) => setImmediate(r));

  it('dispatches an {event} line to the onEvent handler (not treated as a response)', async () => {
    const events = [];
    const t = fakeTransport(() => null); // never sends RPC responses
    const ch = new CompanionChannel('h', t);
    ch.onEvent((msg) => events.push(msg));
    // Simulate the companion pushing an unsolicited paneDelta.
    t._inject('{"event":"paneDelta","panes":{"k":"v"}}');
    await tick();
    assert.strictEqual(events.length, 1, 'event dispatched to handler');
    assert.strictEqual(events[0].event, 'paneDelta');
    assert.deepStrictEqual(events[0].panes, { k: 'v' });
  });

  it('an event line with no handler is dropped silently (never throws)', async () => {
    const t = fakeTransport(() => null);
    // Constructing the channel wires the transport's onLine callback (the side
    // effect under test); no onEvent handler is registered.
    new CompanionChannel('h', t);
    await assert.doesNotReject(async () => { t._inject('{"event":"paneDelta","panes":{}}'); await tick(); });
  });

  it('a handler that throws does not break the channel (next RPC still resolves)', async () => {
    const t = fakeTransport((req) => ({ id: req.id, ok: true, result: {} }));
    const ch = new CompanionChannel('h', t);
    ch.onEvent(() => { throw new Error('boom'); });
    t._inject('{"event":"paneDelta","panes":{}}');
    await tick();
    // Channel survived — a follow-up RPC still works.
    const res = await ch.call('ping', {}, { timeout: 500 });
    assert.deepStrictEqual(res, {});
  });

  it('offEvent stops dispatch (and request/response RPCs are unaffected)', async () => {
    const events = [];
    const t = fakeTransport((req) => ({ id: req.id, ok: true, result: {} }));
    const ch = new CompanionChannel('h', t);
    ch.onEvent((msg) => events.push(msg));
    ch.offEvent();
    t._inject('{"event":"paneDelta","panes":{}}');
    await tick();
    assert.strictEqual(events.length, 0, 'offEvent removed the handler');
    const res = await ch.call('ping', {}, { timeout: 500 });
    assert.deepStrictEqual(res, {});
  });
});

// --------------------------- paneDelta cache (WARDEN-413) --------------------
// The freshness/skip contract: a payload or heartbeat refreshes liveness; an idle
// host whose last push aged past PANE_DELTA_FRESH_MS is no longer "fresh" so
// capturePanes resumes polling (the liveness backstop). In-memory only.

describe('paneDelta cache: freshness + read (the capturePanes skip gate)', () => {
  beforeEach(() => _resetPaneDeltaStateForTests());

  it('applyPaneDelta stores content + refreshes liveness; readPaneDeltas returns only present keys', () => {
    const now = 1_000_000;
    applyPaneDelta('prod', { event: 'paneDelta', panes: { a: 'aa', b: 'bb' } }, now);
    assert.ok(hasFreshPaneDelta('prod', now), 'just-applied delta is fresh');
    assert.deepStrictEqual(readPaneDeltas('prod', ['a', 'b', 'missing']), { a: 'aa', b: 'bb' });
  });

  it('an empty-panes paneDelta is a heartbeat: refreshes liveness without changing content', () => {
    applyPaneDelta('prod', { event: 'paneDelta', panes: { a: 'aa' } }, 1000);
    // Heartbeat at a later time: no content, but liveness refreshes.
    applyPaneDelta('prod', { event: 'paneDelta', panes: {} }, 5000);
    assert.deepStrictEqual(readPaneDeltas('prod', ['a']), { a: 'aa' }, 'content preserved across heartbeat');
    assert.ok(hasFreshPaneDelta('prod', 5000), 'heartbeat kept it fresh');
  });

  it('a host with no delta is not fresh (capturePanes polls)', () => {
    assert.ok(!hasFreshPaneDelta('prod', 1000), 'never-pushed host is not fresh');
  });

  it('freshness expires after PANE_DELTA_FRESH_MS with no push (liveness backstop -> poll)', () => {
    applyPaneDelta('prod', { event: 'paneDelta', panes: { a: 'aa' } }, 1000);
    const stale = 1000 + PANE_DELTA_FRESH_MS + 1;
    assert.ok(!hasFreshPaneDelta('prod', stale), 'aged-out delta is not fresh -> capturePanes resumes polling');
  });

  it('a non-paneDelta event does not refresh the cache', () => {
    applyPaneDelta('prod', { event: 'somethingElse', panes: { a: 'aa' } }, 1000);
    assert.ok(!hasFreshPaneDelta('prod', 1000), 'unrelated event ignored');
  });
});

// ----------------------- subscribePanes / unsubscribePanes -------------------
// The push subscription: ref-counted across callers, feature-detected via ping
// methods (stale binary degrades to poll), and companion-or-fail on transport
// errors (never breaks pane rendering — capturePanes keeps polling).

// Extend healthyTransport to also ACK subscribePanes/unsubscribePanes and to
// advertise them in ping methods (a WARDEN-413-aware companion).
const healthySubTransport = (extra = {}) => {
  const methods = ['ping', 'discover', 'capturePanes', 'hasSession', 'subscribePanes', 'unsubscribePanes'];
  return fakeTransport((req) => {
    if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods } };
    if (req.method === 'discover') return { id: req.id, ok: true, result: { containers: extra.containers ?? [] } };
    if (req.method === 'capturePanes') return { id: req.id, ok: true, result: { panes: extra.panes ?? {} } };
    if (req.method === 'subscribePanes') return { id: req.id, ok: true, result: { subscribed: (req.params?.panes || []).length } };
    if (req.method === 'unsubscribePanes') return { id: req.id, ok: true, result: { unsubscribed: true } };
    return { id: req.id, ok: false, error: 'unknown method' };
  });
};

describe('subscribePanes / unsubscribePanes (WARDEN-413)', () => {
  beforeEach(() => { _resetChannelCacheForTests(); _resetPaneDeltaStateForTests(); });

  it('subscribePanes sends the pane list and returns {ok:true, subscribed:true}', async () => {
    let sent = null;
    const t = healthySubTransport();
    t._record = (line) => { sent = JSON.parse(line); };
    const origWrite = t.write.bind(t);
    t.write = (line) => { try { t._record(line); } catch {} origWrite(line); };
    const { deps } = fakeDeps({ spawnChannel: () => t });
    const res = await subscribePanes('prod', [
      { key: 'p-worker', container: 'p-worker', session: 'agent' },
    ], {}, {}, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.subscribed, true);
    assert.ok(sent && sent.method === 'subscribePanes');
    assert.deepStrictEqual(sent.params.panes, [{ key: 'p-worker', container: 'p-worker', session: 'agent' }]);
  });

  it('feature-detect: a stale binary (no subscribePanes in methods) degrades to poll, no RPC sent', async () => {
    const seen = [];
    const stale = fakeTransport((req) => {
      seen.push(req.method);
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover', 'capturePanes', 'hasSession'] } };
      return { id: req.id, ok: true, result: {} };
    });
    const { deps } = fakeDeps({ spawnChannel: () => stale });
    const res = await subscribePanes('prod', [{ key: 'k', container: 'k', session: 'agent' }], {}, {}, deps);
    assert.strictEqual(res.ok, false, 'unsupported -> ok:false');
    assert.strictEqual(res.unsupported, true, 'flagged unsupported so the caller keeps polling');
    assert.ok(!seen.includes('subscribePanes'), 'never sent subscribePanes to a stale binary');
  });

  it('ref-counts across callers: two subscribes for the same key sync the union, one unsubscribe keeps it live', async () => {
    const sent = [];
    const t = healthySubTransport();
    const origWrite = t.write.bind(t);
    t.write = (line) => { sent.push(JSON.parse(line)); origWrite(line); };
    const { deps } = fakeDeps({ spawnChannel: () => t });

    // Two "connections" each monitor panes on the same host.
    await subscribePanes('prod', [{ key: 'a', container: 'a', session: 'agent' }], {}, {}, deps);
    await subscribePanes('prod', [{ key: 'b', container: 'b', session: 'agent' }], {}, {}, deps);
    // The live subscription set is the UNION {a,b}.
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { a: 1, b: 1 });

    // Connection A closes (unsubscribes a); b must stay subscribed.
    await unsubscribePanes('prod', ['a'], {}, {}, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { b: 1 }, 'b stays live after a closes');
    // The last sync sent the reduced set {b} only.
    const lastSub = [...sent].reverse().find((s) => s.method === 'subscribePanes');
    assert.ok(lastSub, 'a subscribePanes sync happened');
    assert.deepStrictEqual(lastSub.params.panes.map((p) => p.key), ['b']);

    // Last connection closes -> unsubscribePanes sent, set empties.
    await unsubscribePanes('prod', ['b'], {}, {}, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests(), {}, 'subscription released when last watcher closes');
  });

  it('unsubscribePanes on a host that empties its set sends unsubscribePanes + clears the delta cache', async () => {
    const sent = [];
    const t = healthySubTransport();
    const origWrite = t.write.bind(t);
    t.write = (line) => { sent.push(JSON.parse(line)); origWrite(line); };
    const { deps } = fakeDeps({ spawnChannel: () => t });
    await subscribePanes('prod', [{ key: 'k', container: 'k', session: 'agent' }], {}, {}, deps);
    applyPaneDelta('prod', { event: 'paneDelta', panes: { k: 'cached' } });
    assert.ok(hasFreshPaneDelta('prod'));

    await unsubscribePanes('prod', ['k'], {}, {}, deps);
    assert.ok(sent.some((s) => s.method === 'unsubscribePanes'), 'unsubscribePanes sent');
    assert.ok(!hasFreshPaneDelta('prod'), 'delta cache cleared -> capturePanes resumes polling');
  });

  it('LOCAL host is refused (companion serves remote hosts only)', async () => {
    const res = await subscribePanes('(local)', [{ key: 'k', session: 'k' }]);
    assert.strictEqual(res.ok, false);
    assert.ok(/local/.test(res.error));
  });

  it('a paneDelta pushed over the channel lands in the delta cache (event handler wired on subscribe)', async () => {
    const t = healthySubTransport();
    const { deps } = fakeDeps({ spawnChannel: () => t });
    const channel = await getChannel('prod', {}, deps);
    await subscribePanes('prod', [{ key: 'k', container: 'k', session: 'agent' }], {}, {}, deps);
    // Simulate the companion pushing an unsolicited paneDelta event line. It must
    // route through _onLine (the `event` branch) into the delta cache.
    channel._onLine(JSON.stringify({ event: 'paneDelta', panes: { k: 'pushed' } }));
    assert.ok(hasFreshPaneDelta('prod'));
    assert.deepStrictEqual(readPaneDeltas('prod', ['k']), { k: 'pushed' });
  });
});

// ----------------------- reconcilePaneSubscriptions --------------------------
// The /api/agent-states production trigger (WARDEN-413). Stateless HTTP has no
// connection identity, so a per-poller ref can't bound a subscription; the TTL
// keeps it multi-tab correct instead. A pane is subscribed when it ENTERS the
// polled set and released only when the last poller stops requesting it. The
// refs compose with the WS monitor path's refs (one ref per watched key).

describe('reconcilePaneSubscriptions (WARDEN-413 /api/agent-states trigger)', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    _resetChannelCacheForTests();
    _resetPaneDeltaStateForTests();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    _resetChannelCacheForTests();
    _resetPaneDeltaStateForTests();
  });

  it('subscribes a REMOTE host panes when they enter the polled set', async () => {
    const t = healthySubTransport();
    const { deps } = fakeDeps({ spawnChannel: () => t });
    const chats = [
      { host: 'prod', key: 'w1', container: 'w1', session: 'agent' },
      { host: 'prod', key: 'w2', container: 'w2', session: 'agent' },
    ];
    await reconcilePaneSubscriptions(chats, {}, { now: 1000 }, deps);
    // One agent-states ref per watched key; the companion got a subscribePanes for
    // the union {w1,w2}.
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { w1: 1, w2: 1 });
    assert.deepStrictEqual(_getAgentStateWatchedForTests().prod, { w1: 1000, w2: 1000 });
  });

  it('dedupes duplicate keys per host (no ref over-count / leak)', async () => {
    const t = healthySubTransport();
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // Same key twice for one host (e.g. a caller that didn't dedupe) must count
    // as ONE ref, not two — else TTL eviction would under-decrement and leak.
    await reconcilePaneSubscriptions([
      { host: 'prod', key: 'w1', container: 'w1', session: 'agent' },
      { host: 'prod', key: 'w1', container: 'w1', session: 'agent' },
    ], {}, { now: 1000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { w1: 1 }, 'duplicate key -> one ref');
  });

  it('steady-state: re-polling the SAME set issues NO new subscribe (refs stay 1)', async () => {
    const sent = [];
    const t = healthySubTransport();
    const origWrite = t.write.bind(t);
    t.write = (line) => { sent.push(JSON.parse(line)); origWrite(line); };
    const { deps } = fakeDeps({ spawnChannel: () => t });
    const chats = [{ host: 'prod', key: 'w1', container: 'w1', session: 'agent' }];
    await reconcilePaneSubscriptions(chats, {}, { now: 1000 }, deps);
    const firstCount = sent.filter((s) => s.method === 'subscribePanes').length;
    await reconcilePaneSubscriptions(chats, {}, { now: 11_000 }, deps);
    await reconcilePaneSubscriptions(chats, {}, { now: 21_000 }, deps);
    const afterCount = sent.filter((s) => s.method === 'subscribePanes').length;
    assert.strictEqual(firstCount, 1, 'first reconcile subscribes once');
    assert.strictEqual(afterCount, 1, 'no re-subscribe on steady-state polls');
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { w1: 1 }, 'ref stays 1 (balanced)');
  });

  it('a pane that LEAVES the polled set is released once its TTL elapses', async () => {
    const t = healthySubTransport();
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // Poll 1 (t=1000): w1 + w2 watched.
    await reconcilePaneSubscriptions([
      { host: 'prod', key: 'w1', container: 'w1', session: 'agent' },
      { host: 'prod', key: 'w2', container: 'w2', session: 'agent' },
    ], {}, { now: 1000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { w1: 1, w2: 1 });
    // Poll 2 (t=11000, within TTL): only w1. w2 is absent but NOT yet expired -> lingers.
    await reconcilePaneSubscriptions([
      { host: 'prod', key: 'w1', container: 'w1', session: 'agent' },
    ], {}, { now: 11_000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { w1: 1, w2: 1 }, 'w2 lingers within the TTL');
    // Poll 3 (t=42000): w2's lastSeen (1000) is now >30s old -> released; w1 refreshed.
    await reconcilePaneSubscriptions([
      { host: 'prod', key: 'w1', container: 'w1', session: 'agent' },
    ], {}, { now: 42_000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { w1: 1 }, 'w2 released after TTL; w1 stays watched');
  });

  it('LOCAL hosts are never subscribed (companion serves remote hosts only)', async () => {
    const t = healthySubTransport();
    const { deps } = fakeDeps({ spawnChannel: () => t });
    await reconcilePaneSubscriptions([
      { host: '(local)', key: 'l1', session: 'l1' },
      { host: 'prod', key: 'w1', container: 'w1', session: 'agent' },
    ], {}, { now: 1000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests(), { prod: { w1: 1 } }, 'no LOCAL entry');
    assert.deepStrictEqual(_getAgentStateWatchedForTests(), { prod: { w1: 1000 } });
  });

  it('is a no-op when the companion transport flag is OFF (poll path unchanged)', async () => {
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    const { deps } = fakeDeps({});
    const res = await reconcilePaneSubscriptions([
      { host: 'prod', key: 'w1', container: 'w1', session: 'agent' },
    ], {}, { now: 1000 }, deps);
    assert.deepStrictEqual(res, []);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests(), {}, 'no subscription created with the flag off');
  });

  it('two concurrent pollers keep a shared pane subscribed until BOTH stop (multi-tab)', async () => {
    const t = healthySubTransport();
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // Poller A watches a; poller B watches b - same host. Interleaved polls.
    await reconcilePaneSubscriptions([{ host: 'prod', key: 'a', container: 'a', session: 'agent' }], {}, { now: 1000 }, deps);
    await reconcilePaneSubscriptions([{ host: 'prod', key: 'b', container: 'b', session: 'b' }], {}, { now: 2_000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { a: 1, b: 1 }, 'union watched');
    // Poller A stops (only B polls now). a absent from B's poll but within TTL -> lingers.
    await reconcilePaneSubscriptions([{ host: 'prod', key: 'b', container: 'b', session: 'b' }], {}, { now: 12_000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { a: 1, b: 1 }, 'a lingers - only one poller dropped, TTL not elapsed');
    // Time advances past a's TTL (last seen 1000) with only B polling -> a released, b stays.
    await reconcilePaneSubscriptions([{ host: 'prod', key: 'b', container: 'b', session: 'b' }], {}, { now: 42_000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { b: 1 }, 'a released only once aged out; b still live');
  });

  it('a pane whose pollers ALL stop is released by the EMPTY-set sweep (the background-timer path)', async () => {
    const sent = [];
    const t = healthySubTransport();
    const origWrite = t.write.bind(t);
    t.write = (line) => { sent.push(JSON.parse(line)); origWrite(line); };
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // A pane is polled (t=1000): subscribed.
    await reconcilePaneSubscriptions([{ host: 'prod', key: 'w1', container: 'w1', session: 'agent' }], {}, { now: 1000 }, deps);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests().prod, { w1: 1 });
    // The user closes ALL panes -> the frontend stops polling entirely, so NO pane
    // is in the polled set and the request-driven reconcile never runs. The
    // background sweep (startPaneDeltaSweep) calls reconcile with an EMPTY set;
    // advancing now past the TTL must age w1 out and fire unsubscribePanes. This
    // is the cleanup-leak fix (the tests above always poll at least one pane, so
    // they exercise the request-driven sweep — not this decoupled path).
    const before = sent.filter((s) => s.method === 'unsubscribePanes').length;
    await reconcilePaneSubscriptions([], {}, { now: 42_000 }, deps);
    assert.ok(
      sent.filter((s) => s.method === 'unsubscribePanes').length > before,
      'empty-set sweep fired unsubscribePanes for the closed pane'
    );
    assert.deepStrictEqual(_getPaneSubscriptionsForTests(), {}, 'subscription released once aged out');
    assert.deepStrictEqual(_getAgentStateWatchedForTests(), {}, 'watched entry evicted');
  });
});

// ----------------------- startPaneDeltaSweep (WARDEN-413) ---------------------
// The background TTL-sweep timer: arms once when the companion flag is on (so the
// empty-set cleanup path the test above proves actually FIRES in production, even
// when no client is polling), self-gates off when the flag is off, and is
// idempotent. No real elapsed time is needed here — the eviction LOGIC is proven
// by the empty-set reconcile test above; this asserts the timer is armed under the
// right conditions (the production wiring in startServer calls this unconditionally).

describe('startPaneDeltaSweep: background TTL sweep (WARDEN-413 cleanup-leak fix)', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    _resetChannelCacheForTests();
    _resetPaneDeltaStateForTests();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    _stopPaneDeltaSweepForTests();
    _resetChannelCacheForTests();
    _resetPaneDeltaStateForTests();
  });

  it('arms one idempotent timer when the flag is on; null when off', () => {
    const t1 = startPaneDeltaSweep({});
    assert.ok(t1, 'flag on -> arms a timer');
    assert.strictEqual(startPaneDeltaSweep({}), t1, 'idempotent: second start returns the SAME timer');
    // Stopping clears the idempotency guard, so a subsequent start arms a NEW one.
    _stopPaneDeltaSweepForTests();
    const t2 = startPaneDeltaSweep({});
    assert.notStrictEqual(t1, t2, 'after stop, a new start arms a fresh timer');
    _stopPaneDeltaSweepForTests();
    // Flag off -> no timer (the startServer call site relies on this self-gate).
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    assert.strictEqual(startPaneDeltaSweep({}), null, 'flag off -> no timer');
  });
});

// ------------------ pollAgentStates: the real /api/agent-states poll -----------
// WARDEN-413 success-gate proof. This is the reachability test the prior PR
// lacked: it drives the REAL /api/agent-states poll core (pollAgentStates, exported
// from server.js) end-to-end with a fake companion (the same stand-in pattern as
// the parity tests). The subscription is established by the REAL production
// trigger (reconcilePaneSubscriptions, which the handler calls), the paneDelta
// arrives over the REAL channel event routing (NOT a hand-seeded cache), and the
// REAL capturePanes gate issues ZERO RPCs on the steady-state poll. The contrast —
// poll 1 captures once (bootstrap, no delta yet); poll 2 captures ZERO (live
// subscription) — is the success measure: an idle companion host is never polled.

describe('pollAgentStates: idle companion host receives ZERO capturePanes RPCs (WARDEN-413)', () => {
  let server, savedEnv, savedHome, tempHome;
  before(async () => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    savedHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-poll-'));
    process.env.HOME = tempHome;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    // Dynamic import so this suite stays out of server.js's module-scope side
    // effects unless this describe runs. HOME is an isolated temp dir so server.js's
    // own load() reads no real config (pollAgentStates takes cfg as a param anyway).
    server = await import('./server.js');
  });
  after(async () => {
    if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  beforeEach(() => { _resetChannelCacheForTests(); _resetPaneDeltaStateForTests(); });
  afterEach(() => { _resetChannelCacheForTests(); _resetPaneDeltaStateForTests(); });

  it('poll 1 bootstraps (1 RPC); after the push, poll 2 issues ZERO capturePanes RPCs', async () => {
    let captureRpc = 0;
    // capturePanes, IF polled, returns POLLED CONTENT (distinct from the pushed
    // delta) so the two paths are unambiguous.
    const t = healthySubTransport({ panes: { w1: 'POLLED CONTENT' } });
    const origWrite = t.write.bind(t);
    t.write = (line) => { try { if (JSON.parse(line).method === 'capturePanes') captureRpc++; } catch { /* non-JSON noise */ } origWrite(line); };
    const { deps } = fakeDeps({ spawnChannel: () => t });
    const chats = [{ host: 'prod', key: 'w1', container: 'w1', session: 'agent', project: 'p', role: 'worker' }];

    // --- Poll 1 (bootstrap): reconcile subscribes; no delta has been pushed yet,
    // so capturePanes polls once (graceful bootstrap). This is the first poll after
    // the host enters the watched set. ---
    let agents = await server.pollAgentStates(chats, {}, deps);
    assert.strictEqual(captureRpc, 1, 'bootstrap poll captures once (subscription just started, no delta yet)');
    assert.ok(agents.some((a) => a.key === 'w1' && !a.captureError), 'the pane was captured on the bootstrap poll');

    // --- The companion pushes the pane over the channel (REAL event routing -> cache). ---
    const ch = await getChannel('prod', {}, deps);
    ch._onLine(JSON.stringify({ event: 'paneDelta', panes: { w1: 'PUSHED IDLE CONTENT' } }));
    assert.ok(hasFreshPaneDelta('prod'), 'precondition: the pushed delta made the host fresh');

    // --- Poll 2 (steady state): the delta is fresh -> capturePanes renders from the
    // in-memory cache and issues ZERO RPCs. This is the WARDEN-413 success gate: an
    // idle host with a live subscription is never polled. ---
    agents = await server.pollAgentStates(chats, {}, deps);
    assert.strictEqual(captureRpc, 1, 'ZERO new capturePanes RPCs on the steady-state poll for an idle host with a live subscription');
  });
});

// ----------------------- pollFleetStates (WARDEN-571) --------------------------
// The slow "fleet sweep": classify the REST of the fleet (agents NEITHER open NOR
// watched) so a hidden stuck/erroring/waiting agent surfaces in the badge instead of
// reading HEALTHY forever. Hard cost gate — the sweep captures ONLY via the companion
// delta path: a steady-state sweep issues ONE batched capturePanesViaCompanion per
// hidden companion HOST per ~90s sweep (the subscription's 30s TTL — tuned for the 30s
// open-pane poll — evicts a hidden pane between sweeps, so each sweep re-subscribes and
// re-captures once). That is a companion RPC over the PERSISTENT channel, NOT an SSH
// sweep. Non-companion / LOCAL hosts come back `sweep_skipped` and are NEVER probed.
// Contrast with pollAgentStates above: the 30s poll keeps its own subscriptions alive
// (cadence == TTL), so it earns ZERO capturePanes RPCs steady-state; the 90s sweep does
// not, and the test below asserts the REAL steady state (1/host/sweep), driving the
// production background TTL eviction between iterations so it cannot fool itself.

describe('pollFleetStates: hidden-fleet sweep (WARDEN-571)', () => {
  let server, savedEnv, savedHome, tempHome;
  before(async () => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    savedHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fleet-'));
    process.env.HOME = tempHome;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    // Dynamic import so this suite stays out of server.js's module-scope side effects
    // unless this describe runs. HOME is an isolated temp dir so server.js's own load()
    // reads no real config (pollFleetStates takes cfg/chats as params anyway).
    server = await import('./server.js');
  });
  after(async () => {
    if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  beforeEach(() => { _resetChannelCacheForTests(); _resetPaneDeltaStateForTests(); });
  afterEach(() => { _resetChannelCacheForTests(); _resetPaneDeltaStateForTests(); });

  it('steady-state sweep re-captures each hidden companion host ONCE per sweep after the background TTL evicts between sweeps; LOCAL host is sweep_skipped + never probed', async () => {
    let captureRpc = 0;
    const t = healthySubTransport({ panes: { 'hidden-a': 'POLLED A', 'hidden-b': 'POLLED B' } });
    const origWrite = t.write.bind(t);
    t.write = (line) => { try { if (JSON.parse(line).method === 'capturePanes') captureRpc++; } catch { /* non-JSON noise */ } origWrite(line); };
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // Two HIDDEN panes on the SAME companion host (proves the per-sweep capture is
    // batched into ONE capturePanes RPC per host, not one per pane) + a LOCAL host.
    const chats = [
      { host: 'prod', key: 'hidden-a', container: 'hidden-a', session: 'agent', project: 'p', role: 'worker' },
      { host: 'prod', key: 'hidden-b', container: 'hidden-b', session: 'agent', project: 'p', role: 'worker' },
      { host: '(local)', key: 'local1', session: 'local1', project: 'p', role: 'worker' },
    ];

    // --- Sweep 1 (bootstrap, ~t=0): prod has no delta yet, so capturePanes issues ONE
    // batched RPC for the host (both panes) — the graceful bootstrap, exactly as
    // pollAgentStates does on the first poll after a host enters the watched set. The
    // LOCAL host is sweep_skipped and never probed. ---
    let agents = await server.pollFleetStates(chats, {}, deps, {});
    assert.strictEqual(captureRpc, 1, 'bootstrap sweep captured the companion host ONCE (batched, both panes)');
    const localRow = agents.find((a) => a.key === 'local1');
    assert.strictEqual(localRow.state, 'sweep_skipped', 'LOCAL host is sweep_skipped (cost gate)');
    assert.strictEqual(localRow.sweepSkipped, true, 'flagged sweep_skipped');
    assert.strictEqual(agents.filter((a) => a.host === 'prod' && !a.sweepSkipped).length, 2, 'both hidden panes classified in the one batched RPC');
    const t0 = Date.now();

    // --- The companion pushes deltas for the now-subscribed hidden panes (cache fresh). ---
    const ch = await getChannel('prod', {}, deps);
    ch._onLine(JSON.stringify({ event: 'paneDelta', panes: { 'hidden-a': 'IDLE A', 'hidden-b': 'IDLE B' } }));
    assert.ok(hasFreshPaneDelta('prod'), 'precondition: the pushed delta made prod fresh');

    // --- Model the ~90s sweep gap's interior. The hidden panes are owned ONLY by the
    // 90s sweep — the 30s open-pane /api/agent-states poll never requests them (they are
    // HIDDEN), so nothing refreshes their subscription TTL between sweeps. The production
    // background sweep (startPaneDeltaSweep) ticks every AGENT_STATE_TTL_MS (30s) and
    // evicts any watched key whose lastSeen is >30s stale, so the hidden panes are
    // unsubscribed ~30s into every 90s gap. Drive THAT eviction with an injected `now`
    // past the TTL — the exact production path the previous test skipped (the
    // false-confidence gap: it never ran the background sweep, so the subscription never
    // aged out and the steady-state read came from a cache the production runtime does
    // not keep fresh). ---
    await reconcilePaneSubscriptions([], {}, { now: t0 + 60_000 }, deps);
    assert.deepStrictEqual(_getAgentStateWatchedForTests(), {}, 'the background TTL tick evicted the hidden panes (no 30s poll refreshed them)');

    // After unsubscribe the companion stops pushing; the cache's lastEventAt ages past
    // PANE_DELTA_FRESH_MS (6s). Model the last push landing ~10s before this sweep (right
    // before eviction stopped it) so hasFreshPaneDelta is false and capturePanes re-captures.
    applyPaneDelta('prod', { event: 'paneDelta', panes: { 'hidden-a': 'STALE A', 'hidden-b': 'STALE B' } }, t0 - 10_000);
    assert.ok(!hasFreshPaneDelta('prod'), 'precondition: the delta aged out after the subscription was dropped');

    // --- Sweep 2 (~t=90): the subscription was evicted, so reconcile RE-subscribes and
    // capturePanes issues ONE batched capturePanesViaCompanion for prod. This is the
    // HONEST steady state — ONE companion RPC per hidden host per sweep (NOT zero, and
    // NOT an SSH sweep: it is a single batched RPC over the persistent channel). The
    // LOCAL host stays sweep_skipped and is still never probed. ---
    agents = await server.pollFleetStates(chats, {}, deps, {});
    assert.strictEqual(captureRpc, 2, 'steady-state sweep re-captured the hidden host ONCE (1 batched companion RPC per host per sweep after TTL eviction)');
    assert.strictEqual(agents.find((a) => a.key === 'local1').state, 'sweep_skipped', 'LOCAL host still sweep_skipped on steady-state');
    const t1 = Date.now();

    // --- Sweep 3: repeat the gap to prove this is the STEADY state, not a one-off. The
    // count increments by exactly 1 again — every sweep re-captures each hidden host once. ---
    await reconcilePaneSubscriptions([], {}, { now: t1 + 60_000 }, deps);
    applyPaneDelta('prod', { event: 'paneDelta', panes: { 'hidden-a': 'STALE A2', 'hidden-b': 'STALE B2' } }, t1 - 10_000);
    agents = await server.pollFleetStates(chats, {}, deps, {});
    assert.strictEqual(captureRpc, 3, 'third sweep re-captured once more — 1 batched companion RPC per hidden host per sweep is the steady state');
    const prodRow = agents.find((a) => a.key === 'hidden-a');
    assert.ok(prodRow, 'companion hidden agent present');
    assert.ok(!prodRow.sweepSkipped, 'a classified companion row is not sweep_skipped');
  });

  it('companion flag OFF -> every host is sweep_skipped and NONE are probed (no SSH sweep)', async () => {
    const saved = process.env.WARDEN_COMPANION_TRANSPORT;
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    let captureRpc = 0;
    const t = healthySubTransport({ panes: { hidden: 'POLLED' } });
    const origWrite = t.write.bind(t);
    t.write = (line) => { try { if (JSON.parse(line).method === 'capturePanes') captureRpc++; } catch { /* non-JSON noise */ } origWrite(line); };
    const { deps } = fakeDeps({ spawnChannel: () => t });
    try {
      const chats = [{ host: 'prod', key: 'hidden', container: 'hidden', session: 'agent', project: 'p', role: 'worker' }];
      const agents = await server.pollFleetStates(chats, {}, deps, {});
      assert.strictEqual(captureRpc, 0, 'no capturePanes RPC issued with the companion flag off');
      assert.strictEqual(agents.length, 1);
      assert.strictEqual(agents[0].state, 'sweep_skipped', 'flag-off host is sweep_skipped, never probed');
      assert.strictEqual(agents[0].sweepSkipped, true);
    } finally {
      process.env.WARDEN_COMPANION_TRANSPORT = saved; // restore ('1') for the next test
    }
  });

  it('a hidden stuck-looping agent on a companion host is classified as stuck by the sweep', async () => {
    // The stuck-loop pane content arrives via the companion capturePanes RPC — the
    // production path for a hidden pane (captured once per sweep; the per-sweep cost is
    // pinned by the cost-gate test above). The sweep classifies it via the SAME
    // classifyPane + stripAnsi path the open-pane poll uses, so a hidden agent is now
    // surfaced as 'stuck' where /api/health reads it HEALTHY forever. The last 3
    // non-blank lines repeat the previous 3, the joined last-3 block clears the 50-char
    // stuck threshold, and the line matches NO error/waiting/blocked regex so precedence
    // lands on 'stuck'.
    const line = 'Retrying the upload step because the network is slow today';
    const loop = [line, line, line, line, line, line].join('\n');
    const t = healthySubTransport({ panes: { hidden: loop } });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    const chats = [{ host: 'prod', key: 'hidden', container: 'hidden', session: 'agent', project: 'p', role: 'worker' }];
    const agents = await server.pollFleetStates(chats, {}, deps, {});
    const row = agents.find((a) => a.key === 'hidden');
    assert.ok(row, 'hidden agent classified by the sweep');
    assert.strictEqual(row.state, 'stuck', 'the hidden looping agent is stuck');
    assert.ok(row.signal, 'the stuck row carries a triggering signal');
    assert.ok(!row.sweepSkipped, 'a classified row is not sweep_skipped');
  });

  it('excludeKeys drops open ∪ watched panes (sweep set = fleet − open ∪ watched)', async () => {
    const t = healthySubTransport({ panes: { opened: 'A', hidden: 'B' } });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    const chats = [
      { host: 'prod', key: 'opened', container: 'opened', session: 'agent' },
      { host: 'prod', key: 'hidden', container: 'hidden', session: 'agent' },
    ];
    // 'opened' is the caller's open pane -> excluded; only 'hidden' is swept.
    const agents = await server.pollFleetStates(chats, {}, deps, { excludeKeys: ['opened'] });
    assert.deepStrictEqual(agents.map((a) => a.key).sort(), ['hidden'], 'the open pane is excluded; only the hidden pane is swept');
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
  if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover', 'capturePanes', 'hasSession', 'spawnSession', 'killSession', 'resize', 'send', 'sendKeys'] } };
  if (req.method === 'discover') return { id: req.id, ok: true, result: { containers: extra.containers ?? [] } };
  if (req.method === 'capturePanes') return { id: req.id, ok: true, result: { panes: extra.panes ?? {} } };
  if (req.method === 'hasSession') return { id: req.id, ok: true, result: { exists: extra.exists ?? true } };
  if (req.method === 'spawnSession') return { id: req.id, ok: true, result: {} };
  if (req.method === 'killSession') return { id: req.id, ok: true, result: {} };
  if (req.method === 'resize') return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } };
  if (req.method === 'send') return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } };
  if (req.method === 'sendKeys') return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } };
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
    assert.strictEqual(calls.run, 2, 'probe + best-effort reap (WARDEN-904; reap fires after an upload)');
    assert.strictEqual(calls.upload, 1, 'uploaded the missing binary');
    assert.strictEqual(calls.spawnChannel, 1, 'spawned one channel');
    // Second call reuses the cached channel — no new ssh spawns.
    const ch2 = await getChannel('prod-1', {}, deps);
    assert.strictEqual(ch2, ch, 'same channel object (cached)');
    assert.strictEqual(calls.run, 2, 'no re-probe or re-reap on cache hit');
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

  it('a fresh bootstrap routes ALL four legs through deps.spawn/deps.run (count == 4)', async () => {
    // Mirrors scripts/companion-benchmark.mjs's counting shape exactly: the
    // benchmark injects ONE deps.spawn (upload + channel legs) and ONE deps.run
    // (the probe + reap legs, since ssh.js run() spawns internally). The probe
    // previously bypassed the counter, so the live replay reported 2 instead of 3
    // and disagreed with the Part 1 projection. This locks the wiring: default
    // upload + default spawnChannel MUST call deps.spawn, and the probe + reap
    // MUST call deps.run. (WARDEN-272 review #2; WARDEN-904 added the reap as the
    // 4th best-effort bootstrap leg.)
    let runCalls = 0;
    let spawnCalls = 0;
    const ch = await getChannel('prod-count', {}, {
      manifest: TEST_MANIFEST,
      run: async () => { runCalls++; return { ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }; },
      spawn: (...a) => { spawnCalls++; return fakeSpawnChildFactory(TEST_VER)(...a); },
    });
    assert.ok(ch instanceof CompanionChannel);
    assert.strictEqual(runCalls, 2, 'probe + reap legs: exactly two deps.run calls');
    assert.strictEqual(spawnCalls, 2, 'upload + channel legs: exactly two deps.spawn calls');
    assert.strictEqual(runCalls + spawnCalls, 4, 'total == Part 1 projection (probe + upload + channel + reap = 4)');
  });

  describe("'--' terminates ssh options before the host positional (WARDEN-979)", () => {
    /**
     * Option injection, NOT shell injection. Both companion spawns are argv-safe
     * (`spawnFn(SSH_BIN, args)`, no `shell: true`), which stops the SHELL — it does
     * nothing about ssh's OWN option parser. A `host` beginning with '-' lands in a
     * bare positional slot and ssh reads it as an option; `-oProxyCommand=<cmd>`
     * then makes ssh execute <cmd> on the LOCAL machine.
     *
     * WARDEN-969 closed the 5 builders in ssh.js, but these two spawn DIRECTLY via
     * the injected spawnFn instead of routing through run(), so that builder-level
     * fix never reached them.
     *
     * Harness note: the ubiquitous fakeDeps() helper stubs BOTH builders
     * (deps.upload + deps.spawnChannel), so a guard built on fakeDeps would
     * assert on a stub and pass regardless of the fix. We inject deps.spawn ONLY
     * — leaving upload and
     * spawnChannel at their defaults — so the real builders run. deps.run stays
     * faked: it serves the probe + reap legs, which go through ssh.js run() and are
     * already covered by WARDEN-969's guard. One bootstrap with HAVE=0 exercises
     * both builders (upload leg + channel leg).
     */
    const bootstrapRecordingArgv = async (host) => {
      const calls = [];
      const inner = fakeSpawnChildFactory(TEST_VER);
      const ch = await getChannel(host, {}, {
        manifest: TEST_MANIFEST,
        run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }),
        spawn: (bin, args, opts) => { calls.push({ bin, args }); return inner(bin, args, opts); },
      });
      assert.ok(ch instanceof CompanionChannel, 'bootstrap must succeed for the argv to be meaningful');
      const isUpload = (c) => String(c.args[c.args.length - 1]).startsWith('bash -lc');
      const upload = calls.find(isUpload);
      const channel = calls.find((c) => !isUpload(c));
      assert.ok(upload, 'streamFileToHost (upload leg) must have spawned');
      assert.ok(channel, 'spawnPersistentChannel (channel leg) must have spawned');
      return { upload, channel };
    };

    // Adjacency, NOT ordering. During WARDEN-969's review a mutation inserting
    // `'--', '-o', 'X=1', host` went red only because the adjacency form was used;
    // `indexOf('--') < indexOf(host)` would have stayed green. SSH_BASE_OPTS is
    // four -o pairs and carries no '--', so indexOf('--') is unambiguous.
    const assertSeparatorHugsHost = (args, host, leg) => {
      assert.ok(args.includes('--'), `${leg}: ssh argv must carry an end-of-options '--'`);
      assert.strictEqual(
        args[args.indexOf('--') + 1], host,
        `${leg}: nothing may sneak between the separator and the host positional`,
      );
    };

    it("passes '--' immediately before the host at BOTH companion builders", async () => {
      const host = 'prod-sep';
      const { upload, channel } = await bootstrapRecordingArgv(host);
      assertSeparatorHugsHost(upload.args, host, 'streamFileToHost');
      assertSeparatorHugsHost(channel.args, host, 'spawnPersistentChannel');
    });

    it('confines a hostile -oProxyCommand host to the positional slot after the separator', async () => {
      // The exact shape that turns a host string into local code execution. After
      // '--' ssh parses it as a (bogus) hostname and never as an option.
      const host = '-oProxyCommand=touch /tmp/pwned';
      const { upload, channel } = await bootstrapRecordingArgv(host);
      assertSeparatorHugsHost(upload.args, host, 'streamFileToHost');
      assertSeparatorHugsHost(channel.args, host, 'spawnPersistentChannel');
      // And it must not have leaked into an option slot ahead of the separator.
      for (const { args, leg } of [{ args: upload.args, leg: 'streamFileToHost' }, { args: channel.args, leg: 'spawnPersistentChannel' }]) {
        assert.strictEqual(
          args.slice(0, args.indexOf('--')).includes(host), false,
          `${leg}: hostile host must not appear before the end-of-options separator`,
        );
      }
    });
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
    assert.strictEqual(calls.run, 2, 'probe + reap ran once each (not twice — coalesced)');
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

  // --- reap superseded binaries on the bootstrap upgrade path (WARDEN-904) ---
  // A version bump uploads companion-<newver> but must not leave the orphaned
  // companion-<oldver> behind. After a successful bootstrap that installed a
  // binary, bootstrapChannel runs buildReapScript over the same raw-ssh runFn the
  // probe uses — best-effort, AFTER the channel is verified via ping, and NEVER
  // fatal to the bring-up. A same-version re-bootstrap (HAVE=1) installs nothing,
  // so it reaps nothing (a true no-op).
  it('reaps superseded binaries via runFn after an upgrade bootstrap (WARDEN-904)', async () => {
    const runScripts = [];
    const { deps } = fakeDeps({
      run: async (_host, script) => { runScripts.push(script); return { ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }; },
    });
    const remotePath = remoteBinaryPath(TEST_VER);
    await getChannel('prod-reap-upgrade', {}, deps);
    // The probe ran, then — after the channel was verified — the reap ran via the
    // SAME runFn, at the current-version path (the only runFn legs bootstrap has).
    assert.strictEqual(runScripts.length, 2, 'probe + reap (the two runFn legs)');
    assert.strictEqual(runScripts[0], buildProbeScript(remotePath), 'first runFn call is the probe');
    assert.strictEqual(runScripts[1], buildReapScript(remotePath), 'second runFn call is the reap at the current path');
  });

  it('a reap failure is NON-FATAL: bootstrap still returns a live channel (best-effort hygiene)', async () => {
    // Success criterion 5: a failed rm must never fail an otherwise-successful
    // channel bring-up. The reap throws here, yet bootstrap resolves with the
    // verified channel (the channel was already live before the reap ran).
    const reapScript = buildReapScript(remoteBinaryPath(TEST_VER));
    let reapRan = false;
    const { deps } = fakeDeps({
      run: async (_host, script) => {
        if (script === reapScript) { reapRan = true; throw new Error('rm failed: read-only filesystem'); }
        return { ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' };
      },
    });
    const ch = await getChannel('prod-reap-fail', {}, deps);
    assert.ok(reapRan, 'the reap ran (and threw)');
    assert.ok(ch instanceof CompanionChannel, 'bootstrap still returned the verified channel');
    assert.ok(!ch.dead, 'the channel is alive despite the reap failure');
  });

  it('a same-version re-bootstrap (HAVE=1) installs nothing and reaps NOTHING (a no-op)', async () => {
    // Success criterion 2: HAVE=1 → no upload → nothing superseded to reap → the
    // reap step does not even run (gated on didUpload), so no extra ssh round-trip.
    const runScripts = [];
    const { deps } = fakeDeps({
      run: async (_host, script) => { runScripts.push(script); return { ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=1\n' }; },
    });
    await getChannel('prod-reap-samever', {}, deps);
    assert.strictEqual(runScripts.length, 1, 'only the probe ran (no reap on a same-version re-bootstrap)');
    assert.strictEqual(runScripts[0], buildProbeScript(remoteBinaryPath(TEST_VER)), 'the single runFn call is the probe');
  });
});

describe("streamFileToHost — close, not exit (WARDEN-464/766 class, WARDEN-1007)", () => {
  /**
   * streamFileToHost ACCUMULATES stderr and RETURNS it, which is the WARDEN-464
   * discriminator for "must resolve on 'close'". 'exit' fires before the stdio
   * pipes drain, so the returned stderr can be truncated or empty — and that
   * stderr is the ONLY diagnostic a user gets when a host fails to provision:
   *
   *   // src/companion.js, bootstrapChannel upload leg
   *   `bootstrap upload failed: ${(up.stderr || '').trim() || `ssh exited ${up.code}`}`
   *
   * The `||` makes the failure SILENT BY CONSTRUCTION (WARDEN-89): a truncated
   * stderr does not error, it quietly degrades "No space left on device" into a
   * bare "ssh exited 1". The probe leg ~19 lines above uses the identical idiom
   * but sources its result from run() (src/ssh.js), which already resolves on
   * 'close' — the asymmetry this locks shut.
   *
   * Deterministic by injection, exactly as src/sshRun.test.js does it: a fake
   * child emitting the adversarial 'exit'-before-final-'data' order reproduces
   * on every machine what a saturated loop produces only sometimes. The window
   * is genuinely wide in production because this function pipes ~2.1MB through
   * child.stdin, saturating the loop in exactly the interval the child exits and
   * its stderr tail must drain.
   */
  let tmpDir, tinyFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-upload-close-'));
    // Small on purpose: these cases drive the RESOLVE ordering by hand, so the
    // pipe must not still be the thing keeping the child busy. The 2.1MB
    // backpressure shape is the WARDEN-983 block's job, not this one's.
    tinyFile = path.join(tmpDir, 'tiny.bin');
    fs.writeFileSync(tinyFile, Buffer.alloc(64, 0x61));
  });

  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  // A minimal ChildProcess stand-in for the upload leg. stdout is a real Readable
  // because production calls .resume() on it; stderr is a plain EventEmitter so a
  // 'data' can be emitted SYNCHRONOUSLY at a chosen point in the ordering (a
  // Readable's push() defers, which is exactly the determinism these tests need
  // to control) — with a no-op setEncoding stub, because production calls it
  // (WARDEN-1045: accumulating Buffers with `+=` decodes each chunk in isolation
  // and destroys a multibyte character split across a read boundary). The stub is
  // a no-op because this fake emits pre-decoded strings, so there is no decoder
  // state to carry. stdin swallows the piped bytes.
  const fakeUploadChild = () => {
    const c = new EventEmitter();
    c.stdout = new Readable({ read() {} });
    c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    c.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    c.kill = () => {};
    return c;
  };

  it('gate 1 (deterministic): a non-zero exit whose stderr drains AFTER exit resolves with the COMPLETE stderr', async () => {
    let child;
    const started = Date.now();
    const p = streamFileToHost('h', tinyFile, '/remote/p', {}, () => { child = fakeUploadChild(); return child; });

    child.emit('exit', 1);                     // old 'exit' code resolved HERE → stderr === ''
    child.stderr.emit('data', 'bash: line 3: /tmp/.warden-companion: No space left on device\n');
    child.emit('close', 1);                    // 'close' resolves here → stderr complete

    const r = await p;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 1);
    // The load-bearing assertion. Inverted to an 'exit' resolve in the production
    // source during development: this went red with stderr === '' (i.e. the caller
    // would have printed the degraded "ssh exited 1"); restored → green.
    assert.strictEqual(
      r.stderr,
      'bash: line 3: /tmp/.warden-companion: No space left on device\n',
      "stderr must be fully drained — resolve on 'close', not 'exit'",
    );
    // ...and it was 'close' that settled it, not the hang-guard grace timer
    // firing with the same values. (Proves 'close' clears the timer.)
    assert.ok(
      Date.now() - started < UPLOAD_CLOSE_GRACE_MS,
      `'close' must resolve immediately, not via the ${UPLOAD_CLOSE_GRACE_MS}ms grace fallback`,
    );
  });

  it('gate 2: child.stdout is drained, so an unconsumed pipe cannot stall the child and delay close', () => {
    // This function never READS stdout, but 'close' waits for ALL stdio to close.
    // Left paused, a real ssh writing anything to stdout fills its pipe buffer and
    // blocks — turning the fix into a hang. sshControl (src/ssh.js:90-91) resumes
    // the streams it ignores for the same reason.
    let child;
    const p = streamFileToHost('h', tinyFile, '/remote/p', {}, () => { child = fakeUploadChild(); return child; });

    assert.strictEqual(child.stdout.readableFlowing, true, 'child.stdout must be put in flowing mode (resumed)');

    child.emit('exit', 0);
    child.emit('close', 0);
    return p;
  });

  it("gate 3 (hang guard): an 'exit' that is never followed by 'close' still settles, via the bounded grace", async () => {
    // 'close' requires every stdio stream to close. A child whose stdio is held
    // open (inherited by a grandchild, a wedged pipe) would leave a promise that
    // resolves TODAY pending forever — so moving to 'close' ALONE would trade a
    // degraded message for a hang. 'exit' arms a bounded grace through the same
    // idempotent done().
    //
    // This is also what keeps the existing fakes green WITHOUT fixture surgery:
    // fakeSpawnChildFactory's upload branch (this file, ~:1293) emits ONLY 'exit',
    // never 'close', and is injected as deps.spawn by the bootstrap tests below.
    // The production hang risk is the real reason for the fallback; the fakes
    // surviving unmodified is the corroborating evidence, not the motive.
    let child;
    const p = streamFileToHost('h', tinyFile, '/remote/p', {}, () => { child = fakeUploadChild(); return child; });

    child.stderr.emit('data', 'Permission denied (publickey).\n');
    child.emit('exit', 255);
    // deliberately NO 'close'

    const r = await p;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 255, 'the grace fallback reports the real exit code');
    assert.strictEqual(r.stderr, 'Permission denied (publickey).\n', 'whatever drained before the grace elapsed');
  });

  it('gate 4: a null exit code (signal-killed) still reports ok:false through close', async () => {
    let child;
    const p = streamFileToHost('h', tinyFile, '/remote/p', {}, () => { child = fakeUploadChild(); return child; });

    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');

    const r = await p;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, -1, '`code ?? -1` must survive the move to close');
  });

  it('gate 5: the happy path still resolves ok:true with code 0', async () => {
    let child;
    const p = streamFileToHost('h', tinyFile, '/remote/p', {}, () => { child = fakeUploadChild(); return child; });

    child.emit('exit', 0);
    child.emit('close', 0);

    const r = await p;
    assert.deepStrictEqual(r, { ok: true, code: 0, stderr: '' });
  });
});

describe("child.stdin 'error' is handled at BOTH stdin write sites (WARDEN-983)", () => {
  /**
   * `child.stdin` is its OWN Socket emitter. An 'error' event on an emitter with
   * no listener THROWS, and there is no live uncaughtException handler anywhere
   * in non-test src/ — so an ssh death mid-write killed the whole warden server,
   * mid-request. Two write sites: streamFileToHost's `stream.pipe(child.stdin)`
   * and spawnPersistentChannel's transport `write()`.
   *
   * ⚠ THE TRAP — the intuitive test is tautological. The obvious shape ("ssh
   * exits immediately while a large stdin write is in flight") is GREEN WITHOUT
   * THE FIX: `child.on('exit')`'s `stream.destroy()` wins the race before any
   * write reaches a closed pipe, so the process never sees an EPIPE at all.
   * Measured on Node v20.20.2 against the unfixed handler set:
   *
   *   `sh -c 'exit 255'`                                    -> resolves, exit 0  (USELESS as a guard)
   *   `sh -c 'head -c 65536 >/dev/null; sleep .15; exit 255'` -> Unhandled 'error', exit 1  (the real crash)
   *
   * The safe input and the dangerous input differ only by TIMING, not by value.
   * The child must consume a little, THEN die while writes are in flight and
   * backpressured. A guard built on the immediate-exit shape does not cover this.
   *
   * Harness: the crash is process death, so it cannot be caught in-process — an
   * unhandled 'error' would take the whole test runner down with it. Each case
   * therefore runs in a CHILD node process that drives the real (exported)
   * builder with an injected spawnFn, prints a RESULT line, and exits 0. Red on
   * unfixed code is `status: 1` + "Unhandled 'error' event" on stderr; green is
   * status 0 with a RESULT proving the EPIPE was observed AND absorbed.
   *
   * Each assertion checks the EPIPE actually fired (stderr/message mentions it),
   * not merely that the call settled — otherwise a future timing shift could
   * silently degenerate this back into the immediate-exit shape and keep passing.
   */
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const COMPANION_URL = JSON.stringify(new URL('./companion.js', import.meta.url).href);
  let tmpDir;
  let bigFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-stdin-epipe-'));
    // ~2.1MB — the real HAVE=0 bootstrap upload size, and big enough that the
    // pipe stays backpressured for the whole window the child is alive.
    bigFile = path.join(tmpDir, 'big.bin');
    fs.writeFileSync(bigFile, Buffer.alloc(2_200_000, 0x61));
  });

  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  // Run `source` as a module in a fresh node process. Returns { status, stdout,
  // stderr, result } where `result` is the parsed RESULT line (null if it never
  // got there — i.e. the process died).
  const runInChild = (name, source) => {
    const file = path.join(tmpDir, `${name}.mjs`);
    fs.writeFileSync(file, source);
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30000, cwd: HERE });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', result: line ? JSON.parse(line.slice(7)) : null };
  };

  const assertSurvived = (r) => {
    assert.strictEqual(
      r.status, 0,
      `the process must SURVIVE the mid-write EPIPE. exit=${r.status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`,
    );
    assert.ok(!/Unhandled 'error' event/.test(r.stderr), `no unhandled 'error' event:\n${r.stderr}`);
    assert.ok(r.result, `child must reach its RESULT line\n${r.stdout}\n${r.stderr}`);
  };

  // Both cases spawn `sh`; skip on Windows rather than fail on shell shape.
  const skipWin = { skip: process.platform === 'win32' ? 'POSIX sh harness' : false };

  it('site 1 — streamFileToHost: a mid-upload EPIPE resolves a failed upload instead of killing the process', skipWin, () => {
    const r = runInChild('upload', `
import { spawn } from 'node:child_process';
import { streamFileToHost } from ${COMPANION_URL};
// Consume 64KB, then die while the remaining ~2.1MB is still backpressured.
const spawnFn = () => spawn('sh', ['-c', 'head -c 65536 >/dev/null; sleep 0.15; exit 255'], { windowsHide: true });
const res = await streamFileToHost('h', ${JSON.stringify(bigFile)}, '/remote/p', {}, spawnFn);
// Hold the loop open past the resolve: a LATE async 'error' still crashes an
// unguarded process, and exiting immediately would hide exactly that.
setTimeout(() => { console.log('RESULT ' + JSON.stringify(res)); process.exit(0); }, 300);
`);
    assertSurvived(r);
    // Success criterion 1: it resolves as a FAILED upload...
    assert.strictEqual(r.result.ok, false, `upload must resolve ok:false — got ${JSON.stringify(r.result)}`);
    assert.strictEqual(r.result.code, -1, `stdin failure is code -1 (not the child's exit code) — got ${JSON.stringify(r.result)}`);
    // ...and the stderr proves the stdin listener is what absorbed it. Without
    // this the test would still pass if the race degenerated to the immediate-
    // exit shape (which resolves {ok:false, code:255} on UNFIXED code too).
    assert.match(r.result.stderr, /upload stdin failed:/, 'the stdin-error path, not the exit path, must have produced the result');
    assert.match(r.result.stderr, /EPIPE/, 'the mid-write race must actually have produced an EPIPE');
  });

  it('site 1b — streamFileToHost: the stdin-error result PRESERVES the accumulated remote stderr (WARDEN-1018)', skipWin, () => {
    // The dominant real-world leg: the remote dies mid-upload (disk full, mkdir
    // or auth failure) having ALREADY said why on stderr, and stops reading while
    // ~2.1MB is still backpressured. child.stdin is one of the stdio streams
    // 'close' waits on, so the stdin 'error' handler wins deterministically — if
    // it REPLACES the accumulated stderr, the actionable remote cause is gone and
    // the user is told only "write EPIPE".
    //
    // The remote text is emitted EARLY (before the 150ms sleep) on purpose: the
    // stdin 'error' fires before the stderr pipe's full drain, so this asserts on
    // what has drained, not on a complete-stderr guarantee the fix cannot make.
    const r = runInChild('upload-stderr', `
import { spawn } from 'node:child_process';
import { streamFileToHost } from ${COMPANION_URL};
// Consume 64KB, SAY WHY on stderr, then die with ~2.1MB still backpressured.
const spawnFn = () => spawn('sh', ['-c', 'head -c 65536 >/dev/null; echo "No space left on device" >&2; sleep 0.15; exit 255'], { windowsHide: true });
const res = await streamFileToHost('h', ${JSON.stringify(bigFile)}, '/remote/p', {}, spawnFn);
setTimeout(() => { console.log('RESULT ' + JSON.stringify(res)); process.exit(0); }, 300);
`);
    assertSurvived(r);
    // Same contract as site 1 — the fix is additive, ok/code/prefix all unchanged.
    assert.strictEqual(r.result.ok, false, `upload must resolve ok:false — got ${JSON.stringify(r.result)}`);
    assert.strictEqual(r.result.code, -1, `stdin failure is code -1 (not the child's exit code) — got ${JSON.stringify(r.result)}`);
    assert.match(r.result.stderr, /upload stdin failed:/, 'the stdin-error path, not the exit path, must have produced the result');
    assert.match(r.result.stderr, /EPIPE/, 'the mid-write race must actually have produced an EPIPE');
    // The point of this case: the remote cause survives alongside the local symptom.
    assert.match(
      r.result.stderr, /No space left on device/,
      `the accumulated remote stderr must be PRESERVED, not replaced by the local EPIPE symptom — got ${JSON.stringify(r.result)}`,
    );
  });

  it('site 2 — spawnPersistentChannel: a mid-RPC EPIPE surfaces as a transport error instead of killing the process', skipWin, () => {
    const r = runInChild('channel', `
import { spawn } from 'node:child_process';
import { CompanionChannel, CompanionTransportError, spawnPersistentChannel } from ${COMPANION_URL};
const spawnFn = () => spawn('sh', ['-c', 'head -c 4096 >/dev/null; sleep 0.15; exit 255'], { windowsHide: true });
const ch = new CompanionChannel('h', spawnPersistentChannel('h', '/remote/p', {}, spawnFn));
const out = {};
// A backpressured request (a large send()) still in flight when ssh dies. The
// transport's try/catch around child.stdin.write() does NOT see this: EPIPE is
// delivered asynchronously as an 'error' event, outside that try block.
try { await ch.call('send', { text: 'x'.repeat(300000) }, { timeout: 8000 }); out.rejected = false; }
catch (e) { out.rejected = true; out.message = e.message; }
out.dead = ch.dead;
// And the channel is now dead for every SUBSEQUENT caller, the ordinary
// CompanionTransportError path that discover()/capturePanes()/send() handle.
try { await ch.call('ping', {}, { timeout: 1000 }); out.nextRejected = false; }
catch (e) { out.nextRejected = true; out.nextIsTransportError = e instanceof CompanionTransportError; out.nextMessage = e.message; }
setTimeout(() => { console.log('RESULT ' + JSON.stringify(out)); process.exit(0); }, 300);
`);
    assertSurvived(r);
    // Success criterion 2: the in-flight RPC rejects rather than the process dying.
    assert.strictEqual(r.result.rejected, true, `the in-flight RPC must reject — got ${JSON.stringify(r.result)}`);
    assert.match(r.result.message, /stdin write failed:/, 'the stdin-error listener, not the exit handler, must have torn the channel down');
    assert.match(r.result.message, /EPIPE/, 'the mid-write race must actually have produced an EPIPE');
    // ...and it is a transport death, so the channel is dead and later callers
    // get the CompanionTransportError they already handle.
    assert.strictEqual(r.result.dead, true, 'the channel must be marked dead');
    assert.strictEqual(r.result.nextRejected, true, 'a subsequent call on the dead channel must reject');
    assert.strictEqual(r.result.nextIsTransportError, true, `subsequent calls must reject with CompanionTransportError — got ${r.result.nextMessage}`);
  });

  it('control: the IMMEDIATE-exit shape does not reliably reach the stdin path — it is NOT a guard for this defect', skipWin, () => {
    // Pinned deliberately (memory 5f23f67e). This is the shape a reviewer will be
    // offered as "the regression test"; it must be visible here as the NEGATIVE
    // control so nobody mistakes it for coverage.
    //
    // ⚠ Its OUTCOME IS RACED, so this test must not assert a fixed value for it.
    // Measured on Node v20.20.2: the exit path wins ~80-93% of the time
    // ({ok:false, code:255} — stream.destroy() beat the write to the closed
    // pipe), but under parallel load (`npm test` is `node --test src`) the stdin
    // path wins the rest ({ok:false, code:-1, 'upload stdin failed: write EPIPE'}).
    // Asserting `code === 255` here would commit the very error the block comment
    // above warns about — the safe and dangerous inputs differ only by TIMING,
    // not by value — and would red the suite ~1 run in 5 to 1 in 10 (WARDEN-983 QA).
    //
    // What IS invariant, and all this control needs to make its point: the shape
    // settles as a failed upload without ever guaranteeing an EPIPE is reached.
    // A guard whose crash exposure is a coin flip is not a guard — the two tests
    // above force the race deterministically, which is why they are the coverage.
    const r = runInChild('immediate-exit-control', `
import { spawn } from 'node:child_process';
import { streamFileToHost } from ${COMPANION_URL};
const spawnFn = () => spawn('sh', ['-c', 'exit 255'], { windowsHide: true });
const res = await streamFileToHost('h', ${JSON.stringify(bigFile)}, '/remote/p', {}, spawnFn);
setTimeout(() => { console.log('RESULT ' + JSON.stringify(res)); process.exit(0); }, 300);
`);
    assertSurvived(r);
    assert.strictEqual(r.result.ok, false);
    // Either side of the race is a legitimate observation of this shape; only the
    // disjunction is invariant. (Whichever lands, the process survived — that is
    // what assertSurvived above already proved, and it is the whole point: this
    // input cannot be relied on to exercise the stdin path at all.)
    assert.ok(
      r.result.code === 255 || (r.result.code === -1 && /upload stdin failed:/.test(r.result.stderr)),
      `expected either the exit path (code 255) or the stdin path (code -1 + 'upload stdin failed'), `
      + `i.e. exactly the nondeterminism that disqualifies this shape as a guard — got ${JSON.stringify(r.result)}`,
    );
  });
});

// --- per-host companion transport status (WARDEN-878 / roadmap WARDEN-270) ---
// The visibility surface: getCompanionStatus is the single source the API layer
// surfaces on /api/hosts/status. The linchpin correctness property is THE TRAP
// the ticket calls out: channelCache.delete(host) runs on bootstrap failure, so
// an errored host leaves NO cache entry — last-error/state CANNOT be derived by
// reading the cache. The status map captures state at the failure site instead,
// so a failed host shows its error rather than silently reading "no companion."
describe('companion transport status (WARDEN-878)', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    _resetChannelCacheForTests();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
  });

  it('getCompanionStatus reads inactive while the transport is disabled', () => {
    process.env.WARDEN_COMPANION_TRANSPORT = '0';
    assert.deepStrictEqual(getCompanionStatus('any-host'), { state: 'inactive' });
  });

  it('getCompanionStatus reads inactive for LOCAL (the companion is remote-only)', () => {
    assert.deepStrictEqual(getCompanionStatus('(local)'), { state: 'inactive' });
  });

  it('getCompanionStatus reads inactive for a host no companion op has engaged yet', () => {
    assert.deepStrictEqual(getCompanionStatus('never-touched'), { state: 'inactive' });
  });

  it('a successful bootstrap -> active with the ping-verified version', async () => {
    const { deps } = fakeDeps();
    await getChannel('prod-active', {}, deps);
    assert.deepStrictEqual(getCompanionStatus('prod-active'), { state: 'active', version: TEST_VER });
  });

  it('THE TRAP: a FAILED bootstrap leaves no cache entry but status persists as error', async () => {
    // channelCache.delete(host) runs in getChannel's .catch on bootstrap failure,
    // so reading the cache alone would show "no companion" for exactly the host
    // that most needs a status. The status map captures the error at the failure
    // site instead — surfacing the same actionable message + recovery hint the op
    // contracts build.
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    await assert.rejects(() => getChannel('prod-errored', {}, deps), (e) => {
      assert.ok(e instanceof CompanionTransportError);
      return true;
    });
    const status = getCompanionStatus('prod-errored');
    assert.strictEqual(status.state, 'error');
    assert.ok(typeof status.lastErrorAt === 'number', 'lastErrorAt is a numeric epoch-ms timestamp');
    assert.ok(status.lastErrorAt > 0, 'lastErrorAt is positive');
    assert.ok(Date.now() - status.lastErrorAt < 5000, 'lastErrorAt is recent');
    assert.ok(status.lastError.includes('bootstrap probe failed'), 'surfaces the actionable error');
    assert.ok(status.lastError.includes('Permission denied'), 'preserves the underlying stderr');
    assert.ok(status.lastError.includes('WARDEN_COMPANION_TRANSPORT=0'), 'surfaces the recovery hint');
    assert.ok(!('version' in status), 'an errored host carries no version');
  });

  it('a bootstrap that fails at ping (not probe) is still captured as error', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport(() => null), // companion never answers ping
    });
    await assert.rejects(() => getChannel('prod-pingfail', {}, deps));
    const status = getCompanionStatus('prod-pingfail');
    assert.strictEqual(status.state, 'error');
    assert.ok(/did not respond to ping/.test(status.lastError), status.lastError);
  });

  it('bootstrapping is visible while a bootstrap promise is in flight', async () => {
    // A probe that resolves on demand holds the bootstrap promise in flight; while
    // it is pending the host reads "bootstrapping" (not "inactive"), then flips to
    // active once the bootstrap completes. Only the PROBE (the first runFn call) is
    // deferred; the reap (WARDEN-904) is a later best-effort runFn call and must
    // resolve immediately so the bootstrap completes.
    let resolveProbe;
    let firstRun = true;
    const { deps } = fakeDeps({
      run: () => firstRun
        ? (firstRun = false, new Promise((resolve) => { resolveProbe = resolve; }))
        : Promise.resolve({ ok: true, stdout: '', stderr: '' }),
    });
    const pending = getChannel('prod-booting', {}, deps);
    // getChannel sets bootstrapping synchronously before returning the promise,
    // but flush a microtask to be robust against any refactor.
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(getCompanionStatus('prod-booting').state, 'bootstrapping');
    // Release the probe so the bootstrap finishes (and the channel teardown stays clean).
    resolveProbe({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' });
    await pending;
    assert.deepStrictEqual(getCompanionStatus('prod-booting'), { state: 'active', version: TEST_VER });
  });

  it('getAllCompanionStatuses returns the per-host map, empty while disabled', async () => {
    const { deps } = fakeDeps();
    await getChannel('prod-all-1', {}, deps);
    await getChannel('prod-all-2', {}, deps);
    const all = getAllCompanionStatuses();
    assert.strictEqual(all['prod-all-1'].state, 'active');
    assert.strictEqual(all['prod-all-2'].state, 'active');
    process.env.WARDEN_COMPANION_TRANSPORT = '0';
    assert.deepStrictEqual(getAllCompanionStatuses(), {}, 'disabled transport -> empty map (no stale leak)');
  });

  it('a re-bootstrap after a dead channel flips the stale active back through bootstrapping', async () => {
    // A channel that dies (ssh process exits) is re-bootstrapped on the next
    // getChannel call. The status must follow: active → bootstrapping → active,
    // never stuck on a stale "active" once a fresh bootstrap is underway.
    const { deps } = fakeDeps();
    const first = await getChannel('prod-redead', {}, deps);
    assert.strictEqual(getCompanionStatus('prod-redead').state, 'active');
    first.kill(); // simulate the ssh process exiting
    // Only the PROBE (first runFn call of the re-bootstrap) is deferred; the reap
    // (WARDEN-904) is a later best-effort runFn call and resolves immediately.
    let resolveProbe;
    let firstRun = true;
    deps.run = () => firstRun
      ? (firstRun = false, new Promise((resolve) => { resolveProbe = resolve; }))
      : Promise.resolve({ ok: true, stdout: '', stderr: '' });
    const pending = getChannel('prod-redead', {}, deps);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(getCompanionStatus('prod-redead').state, 'bootstrapping');
    resolveProbe({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' });
    await pending;
    assert.strictEqual(getCompanionStatus('prod-redead').state, 'active');
  });
});

describe('uninstallCompanion() (WARDEN-882 Removability — companion-or-fail)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('tears down the cached channel for the host BEFORE the script runs, then runs it via runFn with the right path', async () => {
    // Seed the cache with a real live channel (the state uninstall must clear).
    // fakeDeps() returns { deps, calls } — pass .deps so bootstrap uses the
    // fake run/upload/spawnChannel legs, not the real ssh default.
    const { deps: bootDeps } = fakeDeps();
    const ch = await getChannel('prod-uninstall', {}, bootDeps);
    let killed = false;
    ch.kill = () => { killed = true; };

    let runHost = null;
    let runScript = null;
    let killedAtRunTime = null;
    let cacheHasAtRunTime = null;
    const res = await uninstallCompanion('prod-uninstall', {}, {
      manifest: TEST_MANIFEST,
      run: async (host, script, _opts, _cfg) => {
        runHost = host;
        runScript = script;
        // The teardown (kill + cache delete) must have happened BEFORE runFn.
        killedAtRunTime = killed;
        cacheHasAtRunTime = _channelCacheHasForTests('prod-uninstall');
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
    });

    assert.strictEqual(runHost, 'prod-uninstall', 'runFn received the host');
    assert.strictEqual(runScript, buildUninstallScript(remoteBinaryPath(TEST_VER)),
      'runFn received the uninstall script at the manifest-version path');
    assert.strictEqual(killedAtRunTime, true, 'cached channel was killed BEFORE runFn ran');
    assert.strictEqual(cacheHasAtRunTime, false, 'cache entry was deleted BEFORE runFn ran');
    assert.strictEqual(killed, true, 'channel kill() was invoked');
    assert.deepStrictEqual(res, { host: 'prod-uninstall', ok: true, code: 0, stderr: '' },
      'returns the raw {ok, code, stderr} shape');
  });

  it('refuses LOCAL (the companion serves remote hosts only)', async () => {
    let runCalled = false;
    const res = await uninstallCompanion('(local)', {}, {
      manifest: TEST_MANIFEST,
      run: async () => { runCalled = true; return { ok: true, code: 0, stderr: '' }; },
    });
    assert.strictEqual(runCalled, false, 'runFn never invoked for LOCAL');
    assert.strictEqual(res.ok, false);
    assert.ok(/local host/.test(res.stderr), `LOCAL refusal message: ${res.stderr}`);
  });

  it('works even when the host has no cached channel (never-bootstrapped)', async () => {
    // No getChannel first — cache has no entry. uninstall must still run the
    // script and return the raw result.
    const res = await uninstallCompanion('prod-fresh', {}, {
      manifest: TEST_MANIFEST,
      run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
    });
    assert.deepStrictEqual(res, { host: 'prod-fresh', ok: true, code: 0, stderr: '' });
  });

  it('surfaces a failed run (raw {ok:false} — companion-or-fail, no thrown error)', async () => {
    const res = await uninstallCompanion('prod-fail', {}, {
      manifest: TEST_MANIFEST,
      run: async () => ({ ok: false, code: 255, stdout: '', stderr: 'Permission denied (publickey).' }),
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 255);
    assert.ok(/Permission denied/.test(res.stderr), `surfaces the ssh stderr: ${res.stderr}`);
  });

  it('encodes a thrown transport failure as ok:false in the return shape (never rejects)', async () => {
    const res = await uninstallCompanion('prod-throw', {}, {
      manifest: TEST_MANIFEST,
      run: async () => { throw new Error('spawn failed: ENOENT'); },
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, -1);
    assert.ok(/spawn failed/.test(res.stderr), `surfaces the thrown message: ${res.stderr}`);
  });

  it('uses the default run path (deps.run ?? defaultRun) when no run is injected', async () => {
    // defaultRun is the raw `ssh host 'bash -lc …'` helper. It will fail in this
    // sandbox (no such host), which proves the DEFAULT path is wired — the
    // uninstall script reaches the host through the same leg the probe uses.
    const res = await uninstallCompanion('nonexistent-host-xyz', {}, { manifest: TEST_MANIFEST });
    assert.strictEqual(res.ok, false, 'default ssh run failed (expected — host is unreachable)');
    assert.strictEqual(res.host, 'nonexistent-host-xyz');
    assert.strictEqual(typeof res.stderr, 'string');
  });

  // REGRESSION (the rebase-integration miss): WARDEN-878 added the companionStatus
  // map AFTER this slice was written. Its only writers are getChannel's bootstrap
  // transitions, so clearing channelCache alone leaves {state:'active', version}
  // behind — and /api/hosts/status → getCompanionStatus → the host row's
  // CompanionIndicator would keep reading "active" after a successful removal.
  // That is success criterion 3 ("the host-status surface reflects the companion
  // as absent") failing on the very surface that confirms the action worked.
  // The transport flag MUST be on here: getCompanionStatus short-circuits to
  // 'inactive' while it is off, which would make this assertion tautological.
  it('clears the host companionStatus so the status surface reads absent after removal (WARDEN-878 integration)', async () => {
    const savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    try {
      // Drive the host to a real 'active' status through the bootstrap path (the
      // only writer of companionStatus), and assert that precondition — so a
      // green result cannot come from the status never having been 'active'.
      const { deps: bootDeps } = fakeDeps();
      await getChannel('prod-status-clear', {}, bootDeps);
      assert.deepStrictEqual(getCompanionStatus('prod-status-clear'),
        { state: 'active', version: TEST_VER },
        'precondition: the host reads active with a version before removal');

      const res = await uninstallCompanion('prod-status-clear', {}, {
        manifest: TEST_MANIFEST,
        run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
      });
      assert.strictEqual(res.ok, true, 'removal succeeded');

      assert.deepStrictEqual(getCompanionStatus('prod-status-clear'), { state: 'inactive' },
        'the host-status surface reads inactive (companion absent) after removal');
      assert.ok(!('prod-status-clear' in getAllCompanionStatuses()),
        'the removed host is gone from the all-hosts status map too (no stale version leaks)');
    } finally {
      if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
      else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    }
  });

  it('leaves OTHER hosts\' companionStatus intact (removal is per-host, not a global wipe)', async () => {
    const savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    try {
      const { deps: bootDeps } = fakeDeps();
      await getChannel('host-removed', {}, bootDeps);
      await getChannel('host-kept', {}, bootDeps);

      await uninstallCompanion('host-removed', {}, {
        manifest: TEST_MANIFEST,
        run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
      });

      assert.deepStrictEqual(getCompanionStatus('host-removed'), { state: 'inactive' },
        'the targeted host reads absent');
      assert.deepStrictEqual(getCompanionStatus('host-kept'), { state: 'active', version: TEST_VER },
        'an untouched host keeps its active status — uninstall is not a global clear');
    } finally {
      if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
      else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    }
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

// WARDEN-888 (the final slice): the send / sendKey RPC clients — the user-input
// WRITE path. Same raw {host, ok, code, stdout, stderr} contract as resize (so
// the call site is unchanged) and companion-or-fail (never falls back to raw
// SSH), PLUS stale-binary graceful degradation: a cached binary predating this
// slice returns {unsupported:true} so the caller falls back to runTmux (rolling
// this out must not require every host re-bootstrapped at once).

describe('send() / sendKey() via companion (companion-or-fail + stale-binary degrade)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('send returns the raw {host, ok, code, stdout, stderr} shape on success', async () => {
    const { deps } = fakeDeps({ spawnChannel: () => healthyTransport() });
    const res = await companionSend('prod', { container: 'p-worker', session: 'agent', text: 'do the thing' }, {}, {}, deps);
    assert.strictEqual(res.host, 'prod');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.stdout, '');
    assert.strictEqual(res.stderr, '');
  });

  it('send sends {container, session, text} with the target fallback applied on the JS side', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'send'] } };
      if (req.method === 'send') { sent = req.params; return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // yatfa chat: container + session + text carried verbatim.
    await companionSend('prod', { container: 'p-worker', session: 'agent', text: 'hello\nworld' }, {}, {}, deps);
    assert.deepStrictEqual(sent, { container: 'p-worker', session: 'agent', text: 'hello\nworld' });
    // empty session -> target falls back to container; container null when unset.
    await companionSend('prod', { container: 'c1', session: '', text: 'x' }, {}, {}, deps);
    assert.strictEqual(sent.session, 'c1', 'empty session falls back to container');
    await companionSend('prod', { text: 'x' }, {}, {}, deps);
    assert.strictEqual(sent.session, 'agent', 'no container/session -> agent');
    assert.strictEqual(sent.container, null, 'no container -> null');
  });

  it('send is companion-or-fail: a dead channel surfaces {ok:false, code:-1}, NOT a raw-ssh fallback', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    const res = await companionSend('prod', { container: 'p-worker', session: 'agent', text: 'x' }, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, -1);
    assert.strictEqual(res.stdout, '');
    assert.ok(res.stderr.includes('companion'), `error names the companion: ${res.stderr}`);
    assert.ok(res.stderr.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `bootstrap error must tell the user how to opt out: ${res.stderr}`);
  });

  it('send RPC error ({ok:false}) propagates as {ok:false} without fallback', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'send'] } }
          : req.method === 'send'
            ? { id: req.id, ok: false, error: "send failed: can't find session" }
            : null), // send never gets a success reply
    });
    const res = await companionSend('prod', { container: 'p-worker', session: 'agent', text: 'x' }, {}, { timeout: 60 }, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.stderr.includes("can't find session"), res.stderr);
  });

  it('send degrades on a STALE binary (no send in methods) -> {unsupported:true}, no send RPC issued', async () => {
    const seen = [];
    const stale = fakeTransport((req) => {
      seen.push(req.method);
      // A binary predating WARDEN-888 advertises every op EXCEPT send/sendKeys.
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover', 'capturePanes', 'hasSession', 'resize'] } };
      return { id: req.id, ok: true, result: {} };
    });
    const { deps } = fakeDeps({ spawnChannel: () => stale });
    const res = await companionSend('prod', { container: 'p-worker', session: 'agent', text: 'x' }, {}, {}, deps);
    assert.strictEqual(res.unsupported, true, 'stale binary -> unsupported sentinel so the caller falls back to runTmux');
    assert.ok(!res.ok, 'unsupported is NOT a success');
    assert.ok(!seen.includes('send'), 'never sent send to a stale binary');
  });

  it('send (local) host is refused (companion serves remote hosts only)', async () => {
    const res = await companionSend('(local)', { container: null, session: 'agent', text: 'x' }, {});
    assert.strictEqual(res.ok, false);
    assert.ok(/local/.test(res.stderr));
  });

  it('sendKey returns the raw shape on success and sends the already-validated key', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'sendKeys'] } };
      if (req.method === 'sendKeys') { sent = req.params; return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    const res = await companionSendKey('prod', { container: 'p-worker', session: 'agent', key: 'C-c' }, {}, {}, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.code, 0);
    assert.deepStrictEqual(sent, { container: 'p-worker', session: 'agent', key: 'C-c' });
  });

  it('sendKey degrades on a stale binary (no sendKeys in methods) -> {unsupported:true}', async () => {
    const stale = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'resize'] } };
      return { id: req.id, ok: true, result: {} };
    });
    const { deps } = fakeDeps({ spawnChannel: () => stale });
    const res = await companionSendKey('prod', { container: 'p-worker', session: 'agent', key: 'Enter' }, {}, {}, deps);
    assert.strictEqual(res.unsupported, true);
  });
});

// ------------------------- exec (WARDEN-1261) ---------------------------
// The generic script RPC client — the chat-scoped git/file domain (runGit +
// runInContext in src/gitRoutes.js: 15 /api/git-* routes + cross-agent-diff +
// the search-files remote leg). Same raw {host, ok, code, stdout, stderr}
// contract as resize/send/sendKey (so the git routes' parsers are unchanged,
// ZERO parser changes) and companion-or-fail — but with NO stale-binary
// graceful degradation: a live channel whose binary predates `exec` gets the
// ACTIONABLE too-old error instead (the git surface is a polled fan; a silent
// per-op fallback would quietly re-pay every handshake this slice removes).

describe('execInContext() via companion (companion-or-fail, raw result shape)', () => {
  beforeEach(() => _resetChannelCacheForTests());

  it('returns the raw {host, ok, code, stdout, stderr} shape on success', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) => {
        if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'exec'] } };
        if (req.method === 'exec') return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '## main...origin/main\n', stderr: '' } };
        return { id: req.id, ok: false, error: 'unknown method' };
      }),
    });
    const res = await companionExec('prod', 'cd /work && git status --porcelain 2>/dev/null', {}, {}, deps);
    assert.strictEqual(res.host, 'prod');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.stdout, '## main...origin/main\n');
    assert.strictEqual(res.stderr, '');
  });

  it('sends {script, container, timeoutMs}; container null when unset; timeoutMs from opts', async () => {
    let sent = null;
    const t = fakeTransport((req) => {
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'exec'] } };
      if (req.method === 'exec') { sent = req.params; return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } }; }
      return { id: req.id, ok: false, error: 'unknown method' };
    });
    const { deps } = fakeDeps({ spawnChannel: () => t });
    // Bare script (the run() delivery shape): container null, timeoutMs default 8000.
    await companionExec('prod', 'git status --porcelain 2>/dev/null', {}, {}, deps);
    assert.deepStrictEqual(sent, { script: 'git status --porcelain 2>/dev/null', container: null, timeoutMs: 8000 });
    // Container branch (the runInContext delivery shape) + explicit timeout.
    await companionExec('prod', 'test -f MERGE_HEAD', { container: 'p-worker', timeout: 12000 }, {}, deps);
    assert.deepStrictEqual(sent, { script: 'test -f MERGE_HEAD', container: 'p-worker', timeoutMs: 12000 });
  });

  it('bootstrap failure -> {ok:false, code:-1, actionable error}, NOT a raw-ssh fallback', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    const res = await companionExec('prod', 'git status 2>/dev/null', {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, -1);
    assert.strictEqual(res.stdout, '');
    // The message rides stderr (the raw run() shape), not an `error` field.
    assert.ok(res.stderr.includes('companion'), `error names the companion: ${res.stderr}`);
    assert.ok(res.stderr.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `bootstrap error must tell the user how to opt out: ${res.stderr}`);
  });

  it('RPC error ({ok:false}) propagates as {ok:false} without fallback', async () => {
    const { deps } = fakeDeps({
      spawnChannel: () => fakeTransport((req) =>
        req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'exec'] } }
          : { id: req.id, ok: false, error: 'exec failed: bash not found' }),
    });
    const res = await companionExec('prod', 'true', {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.ok(res.stderr.includes('exec failed'), res.stderr);
  });

  it('a STALE binary (no exec in methods) gets the actionable too-old error — NOT {unsupported:true}, no exec RPC issued', async () => {
    const seen = [];
    const stale = fakeTransport((req) => {
      seen.push(req.method);
      // A binary predating WARDEN-1261 advertises every op EXCEPT exec.
      if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover', 'capturePanes', 'hasSession', 'resize', 'send', 'sendKeys'] } };
      return { id: req.id, ok: true, result: {} };
    });
    const { deps } = fakeDeps({ spawnChannel: () => stale });
    const res = await companionExec('prod', 'git status 2>/dev/null', {}, {}, deps);
    assert.strictEqual(res.unsupported, undefined, 'exec does NOT degrade — companion-or-fail, no silent raw-SSH fallback');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, -1);
    assert.strictEqual(res.stdout, '');
    assert.ok(res.stderr.includes('too old'), `error names the stale binary: ${res.stderr}`);
    assert.ok(res.stderr.includes("'exec'"), `error names the missing RPC: ${res.stderr}`);
    assert.ok(res.stderr.includes('WARDEN_COMPANION_TRANSPORT=0'),
      `error must tell the user how to opt out: ${res.stderr}`);
    assert.ok(!seen.includes('exec'), 'never sent exec to a stale binary');
  });

  it('(local) host is refused (companion serves remote hosts only)', async () => {
    const res = await companionExec('(local)', 'git status', {});
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, -1);
    assert.ok(/local/.test(res.stderr));
  });
});

// ---------------------- write-path routing over the companion ----------------
// WARDEN-888: the routing change lives in src/tmux.js (send / sendKey), tested
// here alongside the rest of the transport surface. Drives the REAL exported
// functions through injected companion clients (no real ssh) and asserts the
// parity contract: under the flag a REMOTE host routes through the companion;
// LOCAL and the flag-off path keep runTmux byte-for-byte; a stale binary falls
// back to runTmux; a dead channel throws (companion-or-fail).

describe('write-path routing over the companion (WARDEN-888 parity)', () => {
  const remoteChat = { host: 'prod-1', container: 'p-worker', session: 'agent' };
  const localChat = { host: '(local)', session: 'agent' };

  beforeEach(() => { process.env.WARDEN_COMPANION_TRANSPORT = '1'; });
  afterEach(() => {
    if (ORIG_COMPANION_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_COMPANION_ENV;
  });

  it('send under the flag routes through the companion, NOT runTmux', async () => {
    let runTmuxCalls = 0;
    let rpcCalls = 0;
    await tmuxSend(remoteChat, {}, 'a directive', {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionSend: async () => { rpcCalls++; return { host: 'prod-1', ok: true, code: 0, stdout: '', stderr: '' }; },
      isCompanionTransportEnabled: () => true,
    });
    assert.strictEqual(rpcCalls, 1, 'remote send under the flag routes through the companion');
    assert.strictEqual(runTmuxCalls, 0, 'remote send under the flag does NOT call runTmux');
  });

  it('send under the flag still throws on a real companion failure (companion-or-fail, no runTmux fallback)', async () => {
    let runTmuxCalls = 0;
    await assert.rejects(
      () => tmuxSend(remoteChat, {}, 'x', {
        runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
        companionSend: async () => ({ host: 'prod-1', ok: false, code: -1, stdout: '', stderr: "can't find session" }),
        isCompanionTransportEnabled: () => true,
      }),
      /can't find session/,
    );
    assert.strictEqual(runTmuxCalls, 0, 'a dead channel does NOT fall back to runTmux');
  });

  it('send falls back to runTmux when the host binary is stale ({unsupported:true})', async () => {
    let runTmuxCalls = 0;
    let rpcCalls = 0;
    const calls = [];
    const r = await tmuxSend(remoteChat, {}, 'just one line', {
      runTmux: async (chat, args) => { runTmuxCalls++; calls.push(args); return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionSend: async () => { rpcCalls++; return { host: 'prod-1', unsupported: true }; },
      isCompanionTransportEnabled: () => true,
    });
    assert.strictEqual(rpcCalls, 1, 'the companion was consulted first');
    assert.strictEqual(runTmuxCalls, 2, 'stale binary -> fell back to runTmux (single-line: -l then Enter)');
    assert.deepStrictEqual(calls[0], ['send-keys', '-t', 'agent', '-l', 'just one line'], 'fallback used the unchanged default argv');
    assert.strictEqual(r, true);
  });

  it('send LOCAL still uses runTmux (never the companion), even under the flag', async () => {
    let runTmuxCalls = 0;
    let companionCalls = 0;
    await tmuxSend(localChat, {}, 'x', {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionSend: async () => { companionCalls++; return { host: '(local)', ok: true }; },
      isCompanionTransportEnabled: () => true,
    });
    assert.strictEqual(runTmuxCalls, 2, 'local send uses runTmux (single-line: -l then Enter)');
    assert.strictEqual(companionCalls, 0, 'local send does NOT call the companion');
  });

  it('sendKey under the flag routes through the companion, NOT runTmux', async () => {
    let runTmuxCalls = 0;
    let rpcCalls = 0;
    await tmuxSendKey(remoteChat, {}, 'C-c', {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionSendKey: async () => { rpcCalls++; return { host: 'prod-1', ok: true, code: 0, stdout: '', stderr: '' }; },
      isCompanionTransportEnabled: () => true,
    });
    assert.strictEqual(rpcCalls, 1, 'remote sendKey routes through the companion');
    assert.strictEqual(runTmuxCalls, 0, 'remote sendKey does NOT call runTmux');
  });

  it('sendKey validates ALLOWED_KEYS on the JS path for BOTH branches (trust boundary stays JS-side)', async () => {
    // An unsupported key is rejected before any transport is consulted — even with
    // the companion enabled and a healthy client standing by.
    const companionSendKey = async () => { throw new Error('companion should not be reached for an invalid key'); };
    await assert.rejects(
      () => tmuxSendKey(remoteChat, {}, 'C-a-INVALID', { companionSendKey, isCompanionTransportEnabled: () => true }),
      /unsupported key/,
    );
  });

  it('sendKey falls back to runTmux when the host binary is stale ({unsupported:true})', async () => {
    let runTmuxCalls = 0;
    let captured = null;
    await tmuxSendKey(remoteChat, {}, 'Enter', {
      runTmux: async (chat, args) => { runTmuxCalls++; captured = args; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionSendKey: async () => ({ host: 'prod-1', unsupported: true }),
      isCompanionTransportEnabled: () => true,
    });
    assert.strictEqual(runTmuxCalls, 1, 'stale binary -> fell back to runTmux');
    assert.deepStrictEqual(captured, ['send-keys', '-t', 'agent', 'Enter'], 'fallback used the unchanged default argv');
  });

  it('sendKey LOCAL still uses runTmux (never the companion)', async () => {
    let runTmuxCalls = 0;
    let companionCalls = 0;
    await tmuxSendKey(localChat, {}, 'Enter', {
      runTmux: async () => { runTmuxCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionSendKey: async () => { companionCalls++; return { host: '(local)', ok: true }; },
      isCompanionTransportEnabled: () => true,
    });
    assert.strictEqual(runTmuxCalls, 1);
    assert.strictEqual(companionCalls, 0);
  });
});

describe('write-path routing: the default path (flag off) is byte-for-byte unchanged', () => {
  const remoteChat = { host: 'prod-1', container: 'p-worker', session: 'agent' };

  afterEach(() => {
    if (ORIG_COMPANION_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_COMPANION_ENV;
  });

  it('flag OFF -> send uses runTmux and the argv is unchanged (single-line)', async () => {
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    let runTmuxCalls = 0;
    let companionCalls = 0;
    let captured = null;
    const runTmux = async (chat, args) => { runTmuxCalls++; captured = args; return { ok: true, code: 0, stdout: '', stderr: '' }; };
    await tmuxSend(remoteChat, {}, 'one line', {
      runTmux,
      companionSend: async () => { companionCalls++; return { host: 'prod-1', ok: true }; },
      isCompanionTransportEnabled: () => false,
    });
    assert.strictEqual(runTmuxCalls, 2, 'single-line: send-keys -l then Enter');
    assert.strictEqual(companionCalls, 0, 'flag OFF -> companion not consulted');
    assert.deepStrictEqual(captured, ['send-keys', '-t', 'agent', 'Enter'], 'argv byte-for-byte unchanged');
  });

  it('flag OFF -> send uses runTmux and the multiline bracketed-paste argv is unchanged', async () => {
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    const calls = [];
    const runTmux = async (chat, args) => { calls.push(args); return { ok: true, code: 0, stdout: '', stderr: '' }; };
    await tmuxSend(remoteChat, {}, 'line1\nline2', {
      runTmux,
      companionSend: async () => { throw new Error('companion should not be reached with the flag off'); },
      isCompanionTransportEnabled: () => false,
    });
    assert.strictEqual(calls[0][0], 'set-buffer');
    assert.ok(calls[1].includes('-p') && calls[1].includes('-d'), 'bracketed paste flags preserved');
    assert.deepStrictEqual(calls[2], ['send-keys', '-t', 'agent', 'Enter']);
  });

  it('flag OFF -> sendKey uses runTmux and the argv is unchanged', async () => {
    delete process.env.WARDEN_COMPANION_TRANSPORT;
    let captured = null;
    await tmuxSendKey(remoteChat, {}, 'C-c', {
      runTmux: async (chat, args) => { captured = args; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      companionSendKey: async () => { throw new Error('companion should not be reached with the flag off'); },
      isCompanionTransportEnabled: () => false,
    });
    assert.deepStrictEqual(captured, ['send-keys', '-t', 'agent', 'C-c'], 'argv byte-for-byte unchanged');
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

// ------------------- git-domain routing over the companion -------------------
// WARDEN-1261: the routing change lives in src/gitRoutes.js (runGit /
// runInContext — the transport seam behind the 15 /api/git-* routes,
// cross-agent-diff, and the search-files remote leg). Drives the REAL exported
// functions through deps seams (no real ssh) and asserts THE PARITY CONTRACT:
// under the flag a REMOTE chat's script rides the companion channel and the
// command delivered host-side is BYTE-FOR-BYTE the one run() delivers on the
// default path — same quoting, same `2>/dev/null` suffix, same containment
// fragments. LOCAL chats and the flag-off path are untouched; a companion
// failure propagates (companion-or-fail — never a raw-SSH fallback).

describe('git-domain routing over the companion (WARDEN-1261 parity)', () => {
  const remoteManual = { host: 'prod-1', container: null };
  const remoteContainer = { host: 'prod-1', container: 'p-worker' };
  const localManual = { host: '(local)', container: null };
  const localContainer = { host: '(local)', container: 'p-worker' };

  beforeEach(() => { process.env.WARDEN_COMPANION_TRANSPORT = '1'; });
  afterEach(() => {
    if (ORIG_COMPANION_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_COMPANION_ENV;
  });

  // THE LOAD-BEARING PARITY TEST (runGit): drive the SAME call twice — flag ON
  // (capturing the script handed to the companion) and flag OFF (capturing the
  // cmd handed to run()) — and assert the two strings are byte-identical. This
  // is the whole ticket's parity contract in one assertion: whichever transport
  // serves the probe, the host executes the same command.
  const parityCase = async (name, chat, args, cwd) => {
    it(`PARITY: the script reaching the companion is byte-identical to the string run() receives (${name})`, async () => {
      let companionScript = null;
      let runCmd = null;
      await runGit(chat, args, cwd, {
        execInContext: async (host, script) => { companionScript = script; return { host, ok: true, code: 0, stdout: '', stderr: '' }; },
        run: async () => { throw new Error('flag ON must not touch run()'); },
      });
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      await runGit(chat, args, cwd, {
        execInContext: async () => { throw new Error('flag OFF must not touch the companion'); },
        run: async (host, cmd) => { runCmd = cmd; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      });
      process.env.WARDEN_COMPANION_TRANSPORT = '1';
      assert.strictEqual(companionScript, runCmd,
        `the delivered script must be byte-identical on both paths:\ncompanion: ${companionScript}\nrun():     ${runCmd}`);
      // And the expected shape, pinned explicitly so a quoting drift in EITHER
      // path fails with a readable diff (not just an identity mismatch):
      //   - args are shellQuote'd, cwd is shellQuote'd
      //   - the `2>/dev/null` suffix survives intact
      const expected = chat.container
        ? `docker exec ${shellQuote(chat.container)} git -C ${shellQuote(cwd)} ${args.map(shellQuote).join(' ')} 2>/dev/null`
        : `cd ${shellQuote(cwd)} && git ${args.map(shellQuote).join(' ')} 2>/dev/null`;
      assert.strictEqual(runCmd, expected);
    });
  };
  parityCase('runGit, container chat', remoteContainer, ['status', '--porcelain'], '/work');
  parityCase('runGit, manual chat', remoteManual, ['rev-parse', '--abbrev-ref', 'HEAD'], '/home/user/proj');

  it('PARITY: runInContext (container chat) — the companion re-assembles the exact docker-exec delivery run() receives', async () => {
    const script = 'cd /work && test -f .git/MERGE_HEAD && echo merge || true';
    let companionPayload = null;
    let runCmd = null;
    await runInContext(remoteContainer, script, { timeout: 6000 }, {
      execInContext: async (host, s, opts) => { companionPayload = { script: s, opts }; return { host, ok: true, code: 0, stdout: '', stderr: '' }; },
      run: async () => { throw new Error('flag ON must not touch run()'); },
    });
    assert.strictEqual(companionPayload.script, script, 'the INNER script rides verbatim (never rebuilt JS-side)');
    assert.strictEqual(companionPayload.opts.container, 'p-worker', 'the container selects the docker-exec delivery host-side');
    assert.strictEqual(companionPayload.opts.timeout, 6000, 'the timeout rides through (the host-side kill deadline)');
    process.env.WARDEN_COMPANION_TRANSPORT = '0';
    await runInContext(remoteContainer, script, { timeout: 6000 }, {
      execInContext: async () => { throw new Error('flag OFF must not touch the companion'); },
      run: async (host, cmd) => { runCmd = cmd; return { ok: true, code: 0, stdout: '', stderr: '' }; },
    });
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    // The host side (companion buildExecScript) assembles EXACTLY this from the
    // payload above — Go's shellQuote is ssh.js's byte-identical twin — so the
    // delivered command is byte-for-byte the default path's:
    const hostSide = `docker exec ${shellQuote(companionPayload.opts.container)} bash -lc ${shellQuote(companionPayload.script)}`;
    assert.strictEqual(hostSide, runCmd,
      `the host-side assembly must equal run()'s delivery:\nhost-side: ${hostSide}\nrun():     ${runCmd}`);
  });

  it('PARITY: runInContext (manual chat) — the script itself is byte-identical to what run() receives', async () => {
    const script = 'cd /home/user/proj && realpath --relative-to=. /home/user/proj/src 2>/dev/null';
    let companionScript = null;
    let runCmd = null;
    await runInContext(remoteManual, script, {}, {
      execInContext: async (host, s, opts) => { companionScript = s; assert.strictEqual(opts.container, '', 'manual chat -> no container (bare bash -lc delivery)'); return { host, ok: true, code: 0, stdout: '', stderr: '' }; },
      run: async () => { throw new Error('flag ON must not touch run()'); },
    });
    process.env.WARDEN_COMPANION_TRANSPORT = '0';
    await runInContext(remoteManual, script, {}, {
      execInContext: async () => { throw new Error('flag OFF must not touch the companion'); },
      run: async (host, cmd) => { runCmd = cmd; return { ok: true, code: 0, stdout: '', stderr: '' }; },
    });
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    assert.strictEqual(companionScript, runCmd);
    assert.strictEqual(companionScript, script, 'the containment script rides verbatim');
  });

  it('runGit under the flag routes REMOTE chats through the companion (ZERO run() spawns), result mapped through', async () => {
    let companionCalls = 0;
    let runCalls = 0;
    const r = await runGit(remoteManual, ['status', '--porcelain'], '/work', {
      execInContext: async (host, script, opts) => {
        companionCalls++;
        assert.strictEqual(host, 'prod-1');
        assert.strictEqual(script, `cd ${shellQuote('/work')} && git 'status' '--porcelain' 2>/dev/null`);
        assert.strictEqual(opts.timeout, 8000, 'runGit probes keep their 8000ms deadline');
        return { host, ok: true, code: 0, stdout: ' M file.txt\n', stderr: '' };
      },
      run: async () => { runCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
    });
    assert.strictEqual(companionCalls, 1);
    assert.strictEqual(runCalls, 0, 'the companion path issues ZERO per-op ssh spawns');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stdout, ' M file.txt\n', 'callers read .stdout exactly as they read run()\'s result');
  });

  it('runGit under the flag is companion-or-fail: a companion failure propagates, run() is NEVER consulted', async () => {
    let runCalls = 0;
    const r = await runGit(remoteManual, ['status', '--porcelain'], '/work', {
      execInContext: async (host) => ({ host, ok: false, code: -1, stdout: '', stderr: 'companion transport error for prod-1: channel died. Set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path.' }),
      run: async () => { runCalls++; return { ok: true, code: 0, stdout: 'should not appear', stderr: '' }; },
    });
    assert.strictEqual(runCalls, 0, 'no silent raw-SSH fallback inside the experimental path');
    assert.strictEqual(r.ok, false);
    assert.ok(r.stderr.includes('WARDEN_COMPANION_TRANSPORT=0'));
  });

  it('LOCAL chats never route through the companion, even under the flag (container + manual)', async () => {
    let companionCalls = 0;
    const deps = {
      execInContext: async () => { companionCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
    };
    // container+LOCAL: runLocalCapture('docker', argv) — a local docker-exec, no
    // ssh and no companion. docker may not exist in the sandbox, so tolerate the
    // spawn-error leg; the ROUTING claim is "companion not consulted".
    await runGit(localContainer, ['status', '--porcelain'], '/work', deps).catch(() => {});
    await runInContext(localContainer, 'true', {}, deps).catch(() => {});
    // manual+LOCAL: runLocalGit — same tolerance (git exists everywhere, but the
    // catch keeps the test about routing, not about the local binary).
    await runGit(localManual, ['status', '--porcelain'], '/work', deps).catch(() => {});
    assert.strictEqual(companionCalls, 0, 'LOCAL never routes through the companion');
  });

  it('flag OFF -> runGit/runInContext use run() and the delivered command is unchanged', async () => {
    process.env.WARDEN_COMPANION_TRANSPORT = '0';
    let companionCalls = 0;
    const calls = [];
    const deps = {
      execInContext: async () => { companionCalls++; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      run: async (host, cmd, opts) => { calls.push({ host, cmd, opts }); return { ok: true, code: 0, stdout: '', stderr: '' }; },
    };
    await runGit(remoteContainer, ['stash', 'list'], '/work', deps);
    await runGit(remoteManual, ['stash', 'list'], '/work', deps);
    await runInContext(remoteManual, 'test -d .git', { timeout: 5000 }, deps);
    assert.strictEqual(companionCalls, 0, 'flag OFF -> companion not consulted');
    assert.deepStrictEqual(calls, [
      { host: 'prod-1', cmd: `docker exec 'p-worker' git -C '/work' 'stash' 'list' 2>/dev/null`, opts: { timeout: 8000 } },
      { host: 'prod-1', cmd: `cd '/work' && git 'stash' 'list' 2>/dev/null`, opts: { timeout: 8000 } },
      { host: 'prod-1', cmd: 'test -d .git', opts: { timeout: 5000 } },
    ], 'the default path delivers byte-for-byte the pre-WARDEN-1261 commands');
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

// "discover without docker" asserts the failure mode of a machine with NO working docker — a
// machine whose daemon answers (GitHub runners ship one) is not that machine. Skipped rather
// than failed: the environment being richer than the test's premise is not a product bug.
const dockerAvailable = (() => {
  try {
    const r = spawnSync('docker', ['ps'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();

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
      assert.ok(res.methods.includes('send'), 'ping advertises the send RPC (WARDEN-888)');
      assert.ok(res.methods.includes('sendKeys'), 'ping advertises the sendKeys RPC (WARDEN-888)');
      assert.ok(res.methods.includes('exec'), 'ping advertises the exec RPC (WARDEN-1261)');
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

  it('exec runs a script host-side and returns the raw cmdResult (WARDEN-1261)', async () => {
    const ch = new CompanionChannel('local-binary', realBinaryTransport());
    try {
      // The run() delivery shape: script verbatim under bash -lc, stdout
      // captured, a redirect inside the script honored.
      const ok = await ch.call('exec', {
        script: "printf 'warden-exec-e2e'; ls /nonexistent-warden-e2e 2>/dev/null; exit 0",
        timeoutMs: 4000,
      }, { timeout: 8000 });
      assert.strictEqual(ok.ok, true);
      assert.strictEqual(ok.code, 0);
      assert.strictEqual(ok.stdout, 'warden-exec-e2e');
      assert.strictEqual(ok.stderr, '', '2>/dev/null inside the script suppressed the probe noise');

      // A non-zero exit is DATA ({ok:false, code:N}), never an RPC error —
      // the git routes read it exactly as they read run()'s non-zero exits.
      const nz = await ch.call('exec', { script: 'exit 42', timeoutMs: 4000 }, { timeout: 8000 });
      assert.strictEqual(nz.ok, false);
      assert.strictEqual(nz.code, 42);

      // timeoutMs kills the host-side process: a 30s sleep returns in well
      // under a second with the kill shape {ok:false, code:-1}.
      const t0 = Date.now();
      const slow = await ch.call('exec', { script: 'sleep 30', timeoutMs: 250 }, { timeout: 8000 });
      assert.ok(Date.now() - t0 < 5000, `host-side kill must fire fast (took ${Date.now() - t0}ms)`);
      assert.strictEqual(slow.ok, false);
      assert.strictEqual(slow.code, -1);

      // WARDEN-1261 QA rework: the REAL script shapes must die too — and must
      // not stall the serial dispatch loop. `sleep 30` alone passes even
      // without a process-group kill (bash exec-optimizes it into the direct
      // child); the multi-command runGit manual-remote shape, the pipeline
      // (search-files family), and a background fork all fork instead, so a
      // direct-child-only kill orphaned the forks, produced NO response (the
      // orphans held the stdout pipe, blocking the host-side Wait), and froze
      // every subsequent op on the channel until the orphans exited.
      const qaShapes = [
        ["cd '/tmp' && sleep 30 2>/dev/null", 'runGit manual-remote shape'],
        ['sleep 30 | head -5', 'pipeline (search-files family)'],
        ['sleep 30 & wait', 'background fork'],
      ];
      for (const [script, label] of qaShapes) {
        const ts = Date.now();
        const killed = await ch.call('exec', { script, timeoutMs: 250 }, { timeout: 8000 });
        assert.ok(Date.now() - ts < 5000,
          `${label}: host-side group kill must fire fast, not stall on the pipe (took ${Date.now() - ts}ms)`);
        assert.strictEqual(killed.ok, false, `${label}: kill shape`);
        assert.strictEqual(killed.code, -1, `${label}: signal kill reports code -1`);
        // The serial dispatch loop must stay live: the very next op answers
        // immediately — a follow-up ping blocked for seconds is the
        // channel-wide-freeze half of the QA defect.
        const tp = Date.now();
        const pong = await ch.call('ping', {}, { timeout: 4000 });
        assert.ok(pong.version, `${label}: follow-up ping answered`);
        assert.ok(Date.now() - tp < 2000,
          `${label}: dispatch loop stalled behind the killed probe (ping took ${Date.now() - tp}ms)`);
      }
    } finally {
      ch.kill();
    }
  });

  it('execInContext through the FULL client stack against the real binary: the git-route script runs host-side (WARDEN-1261)', async () => {
    _resetChannelCacheForTests();
    // Bootstrapped like production (probe HAVE=1 -> no upload -> spawn -> ping),
    // except the channel fronts the REAL binary — so the whole client stack
    // (companionOp -> getChannel -> stale-binary gate -> channel.call) runs.
    const deps = {
      manifest: loadManifest(),
      run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=1\n' }),
      spawnChannel: () => realBinaryTransport(),
    };
    try {
      // The runGit manual-remote script shape, verbatim (quoting + 2>/dev/null).
      const res = await companionExec('prod', "cd '/tmp' && git 'status' '--porcelain' 2>/dev/null", { timeout: 4000 }, {}, deps);
      assert.strictEqual(res.host, 'prod');
      // /tmp is not a repo: the probe exits non-zero with EMPTY stdout AND EMPTY
      // stderr (the `2>/dev/null` suffix swallows git's noise) — the exact benign
      // non-repo shape the default run() path produces for the same script
      // (WARDEN-326: a single git probe exits non-zero for "cwd isn't a repo";
      // callers read that as data, not transport failure).
      assert.strictEqual(res.ok, false);
      assert.notStrictEqual(res.code, 0);
      assert.strictEqual(res.stdout, '');
      assert.strictEqual(res.stderr, '');

      // The runInContext container delivery shape: an in-container bash -lc (no
      // docker here, so expect the docker-failure envelope — still the raw
      // cmdResult shape, never an RPC error).
      const inContainer = await companionExec('prod', 'pwd', { container: 'no-such-warden-test', timeout: 4000 }, {}, deps);
      assert.strictEqual(inContainer.ok, false);
      assert.strictEqual(typeof inContainer.code, 'number');
    } finally {
      _resetChannelCacheForTests();
    }
  });


  (!dockerAvailable ? it : it.skip)('discover without docker -> actionable error, not a crash', async () => {
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

  // WARDEN-888 (the final slice) parity test: the Go companion runs the user-
  // input WRITE path LOCALLY via bash -lc against a REAL tmux session and returns
  // the raw {ok, code, stdout, stderr} shape. send lands a single-line marker
  // (send-keys -l + Enter) AND a multiline block (set-buffer / paste-buffer -p -d
  // / send-keys Enter) intact; sendKeys runs send-keys -t <session> <key> against
  // the live session. Proves the atomic host-side script works end-to-end on a
  // real tmux server (the docker-exec path is the same code with a prefix).
  // Skipped unless tmux + the binary are available.
  function waitForMarker(session, marker) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const cap = spawnSync(TMUX_BIN, ['capture-pane', '-t', session, '-p'], { encoding: 'utf8' });
      if ((cap.stdout || '').includes(marker)) return cap.stdout;
      // busy-wait a few ms — send-keys is synchronous, but the shell's echo of the
      // typed line can straddle a back-to-back capture (the render race WARDEN-413
      // documented). A short poll eliminates that ~5% flake.
      const start = Date.now(); while (Date.now() - start < 20) { /* spin */ }
    }
    return spawnSync(TMUX_BIN, ['capture-pane', '-t', session, '-p'], { encoding: 'utf8' }).stdout;
  }

  (canCapture ? it : it.skip)('send: real binary types a single-line directive into a live tmux session over stdio', async () => {
    const session = uniqueSession();
    const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', session], { encoding: 'utf8' });
    assert.strictEqual(setup.status, 0, `tmux new-session failed: ${setup.stderr}`);
    try {
      const ch = new CompanionChannel('local-binary', realBinaryTransport());
      try {
        const res = await ch.call('send', { container: '', session, text: 'WARDEN_SEND_E2E_SINGLE_9' }, { timeout: 8000 });
        assert.ok(res && typeof res === 'object', 'send response is an object');
        assert.strictEqual(res.ok, true, 'send against a live session -> ok:true');
        assert.strictEqual(res.code, 0, 'send exit code carried in the raw result');
        const pane = waitForMarker(session, 'WARDEN_SEND_E2E_SINGLE_9');
        assert.ok(pane.includes('WARDEN_SEND_E2E_SINGLE_9'),
          `the typed single-line marker landed on the pane; got:\n${pane}`);
      } finally {
        ch.kill();
      }
    } finally {
      spawnSync(TMUX_BIN, ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  });

  (canCapture ? it : it.skip)('send: real binary delivers a multiline block as one bracketed paste over stdio', async () => {
    const session = uniqueSession();
    const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', session], { encoding: 'utf8' });
    assert.strictEqual(setup.status, 0, `tmux new-session failed: ${setup.stderr}`);
    try {
      const ch = new CompanionChannel('local-binary', realBinaryTransport());
      try {
        const res = await ch.call('send', { container: '', session, text: 'WARDEN_MULTI_ONE\nWARDEN_MULTI_TWO' }, { timeout: 8000 });
        assert.strictEqual(res.ok, true, 'multiline send -> ok:true');
        const pane = waitForMarker(session, 'WARDEN_MULTI_TWO');
        assert.ok(pane.includes('WARDEN_MULTI_ONE') && pane.includes('WARDEN_MULTI_TWO'),
          `the whole multiline block landed intact; got:\n${pane}`);
      } finally {
        ch.kill();
      }
    } finally {
      spawnSync(TMUX_BIN, ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  });

  (canCapture ? it : it.skip)('sendKeys: real binary sends a special key into a live tmux session over stdio', async () => {
    const session = uniqueSession();
    const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', session], { encoding: 'utf8' });
    assert.strictEqual(setup.status, 0, `tmux new-session failed: ${setup.stderr}`);
    try {
      const ch = new CompanionChannel('local-binary', realBinaryTransport());
      try {
        // C-c is an ALLOWED_KEY; the host runs send-keys -t <session> C-c verbatim
        // (JS validated already). ok:true proves the argv ran against the live session.
        const res = await ch.call('sendKeys', { container: '', session, key: 'C-c' }, { timeout: 8000 });
        assert.ok(res && typeof res === 'object', 'sendKeys response is an object');
        assert.strictEqual(res.ok, true, 'sendKeys against a live session -> ok:true');
        assert.strictEqual(res.code, 0);
      } finally {
        ch.kill();
      }
    } finally {
      spawnSync(TMUX_BIN, ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  });

  // WARDEN-413 parity test: subscribePanes flips capture from PULL to PUSH. The Go
  // companion starts a watcher that re-captures on a short interval, content-hashes
  // each pane, and emits unsolicited {"event":"paneDelta",...} lines for ONLY the
  // changed panes — so an idle host emits nothing per tick (just an occasional
  // heartbeat), and a changed pane is pushed within ~one tick. This drives the REAL
  // binary against a LIVE tmux session and asserts the push contract end-to-end:
  // initial content is pushed, a content change is pushed, and RPC framing (ping)
  // still works in parallel. Skipped unless tmux is available.
  (canCapture ? it : it.skip)('subscribePanes: real binary pushes paneDelta events when content changes', async () => {
    const session = uniqueSession();
    const setup = spawnSync(TMUX_BIN, ['new-session', '-d', '-s', session], { encoding: 'utf8' });
    assert.strictEqual(setup.status, 0, `tmux new-session failed: ${setup.stderr}`);
    try {
      spawnSync(TMUX_BIN, ['send-keys', '-t', session, 'WARDEN_PUSH_FIRST'], { encoding: 'utf8' });
      const ch = new CompanionChannel('local-binary', realBinaryTransport());
      // Collect unsolicited paneDelta events the watcher pushes.
      const events = [];
      ch.onEvent((msg) => { if (msg.event === 'paneDelta') events.push(msg); });
      try {
        // Subscribe; the watcher's immediate first capture should push the initial
        // content (every pane is "changed" against an empty hash map).
        const ack = await ch.call('subscribePanes', { panes: [{ key: session, container: '', session }] }, { timeout: 8000 });
        assert.ok(ack && ack.subscribed === 1, 'subscribe ACK reports the pane count');

        // Normalize pane content for substring checks: strip ANSI escapes and join
        // wrapped lines, so a long prompt+marker that wraps at the terminal width
        // can't split the marker across a newline (the change is still pushed —
        // only the assertion needs to be wrap-agnostic).
        const norm = (s) => (s || '').replace(/\r?\n/g, '');
        // Wait for the initial push (the watcher ticks ~1s; allow headroom).
        const waitFor = (predicate, ms = 4000) => new Promise((resolve) => {
          const end = Date.now() + ms;
          const step = () => { if (predicate() || Date.now() > end) resolve(); else setTimeout(step, 50); };
          step();
        });
        await waitFor(() => events.some((e) => e.panes && e.panes[session] && norm(e.panes[session]).includes('WARDEN_PUSH_FIRST')));
        const initial = events.find((e) => e.panes && e.panes[session] && norm(e.panes[session]).includes('WARDEN_PUSH_FIRST'));
        assert.ok(initial, 'initial paneDelta pushed the pane content');
        assert.strictEqual(initial.event, 'paneDelta');

        // Change the pane content; a NEW paneDelta must arrive carrying only the
        // changed pane — this is the push that lets the monitor tick skip polling.
        spawnSync(TMUX_BIN, ['send-keys', '-t', session, 'WARDEN_PUSH_SECOND'], { encoding: 'utf8' });
        await waitFor(() => events.some((e) => e.panes && e.panes[session] && norm(e.panes[session]).includes('WARDEN_PUSH_SECOND')));
        const changed = events.find((e) => e.panes && e.panes[session] && norm(e.panes[session]).includes('WARDEN_PUSH_SECOND'));
        assert.ok(changed, 'a content change pushed a new paneDelta within ~one tick');

        // RPC framing is unaffected by the background push: a ping still resolves.
        const ping = await ch.call('ping', {}, { timeout: 4000 });
        assert.ok(ping && Array.isArray(ping.methods) && ping.methods.includes('subscribePanes'),
          'ping still works alongside pushes and advertises subscribePanes');

        // unsubscribePanes stops the watcher (no further pushes).
        const before = events.length;
        await ch.call('unsubscribePanes', {}, { timeout: 4000 });
        spawnSync(TMUX_BIN, ['send-keys', '-t', session, 'WARDEN_PUSH_AFTER_UNSUB'], { encoding: 'utf8' });
        await new Promise((r) => setTimeout(r, 1500)); // over a tick
        const afterUnsub = events.filter((e) => e.panes && e.panes[session] && norm(e.panes[session]).includes('WARDEN_PUSH_AFTER_UNSUB'));
        assert.strictEqual(afterUnsub.length, 0, 'no pushes after unsubscribePanes (watcher stopped)');
        assert.ok(events.length <= before + 1, 'unsubscribe stopped the watcher (at most one in-flight push)');

        // The very first event must carry the event field and NO id (unsolicited).
        assert.ok(!('id' in events[0]) || events[0].id === undefined, 'unsolicited events carry no id');
      } finally {
        ch.kill();
      }
    } finally {
      spawnSync(TMUX_BIN, ['kill-session', '-t', session], { encoding: 'utf8' });
    }
  });

});
