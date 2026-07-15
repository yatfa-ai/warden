// Host companion transport — WARDEN-272 (slice 1 of roadmap WARDEN-270).
//
// A Go binary is bootstrapped into user-space on a remote host
// (~/.warden/companion-<ver>) over the SSH session warden already holds, then
// driven over a SINGLE persistent ssh process's stdio using newline-delimited
// JSON RPC. discover() rides this one channel with ZERO per-op ssh handshakes —
// the win this slice measures (see scripts/companion-benchmark.mjs).
//
// The companion opens NO network port: requests arrive on the ssh process's
// stdin, responses leave on its stdout. "No one can reach your warden" stays
// literally true.
//
// This whole path is GATED behind WARDEN_COMPANION_TRANSPORT=1 (experimental).
// The default discover()/runWithPool() SSH path is untouched and remains the
// default until a later cutover slice. Companion-or-fail: on bootstrap failure
// this path surfaces a clear, actionable error and NEVER silently falls back to
// raw SSH — opt out by unsetting WARDEN_COMPANION_TRANSPORT.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { run as defaultRun, SSH_BASE_OPTS, SSH_BIN, shellQuote } from './ssh.js';
import { buildChat, sortChats, parseActivityTimestamp } from './chatMeta.js';

const LOCAL = '(local)';
const COMPANION_DIR = '$HOME/.warden'; // expands on the remote host

// ----------------------------- opt-in + manifest -----------------------------

export function isCompanionTransportEnabled(env = process.env) {
  return env.WARDEN_COMPANION_TRANSPORT === '1';
}

// src/companion.js -> ../companion/dist. Works in dev (repo root) and in the
// packaged app (companion/dist is bundled alongside src/ via electron-builder).
function distDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'companion', 'dist');
}

let _manifest;
// The full cross-compile matrix (linux/darwin/windows × amd64/arm64). build.sh
// emits a binary for each target; loadManifest validates all six are present, and
// targetForUname maps a host's (uname -s, uname -m) into one of them.
const SUPPORTED_TARGETS = [
  'linux/amd64', 'linux/arm64',
  'darwin/amd64', 'darwin/arm64',
  'windows/amd64', 'windows/arm64',
];
export function loadManifest() {
  if (_manifest) return _manifest;
  const p = path.join(distDir(), 'manifest.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // The version interpolates into a remote shell path, so validate it strictly.
  if (!raw.version || !/^[a-f0-9]+$/.test(raw.version)) {
    throw new Error(`companion manifest has invalid version: ${JSON.stringify(raw.version)}`);
  }
  if (!raw.binaries || !SUPPORTED_TARGETS.every((t) => raw.binaries[t])) {
    throw new Error(`companion manifest missing binary entries (expected all of ${SUPPORTED_TARGETS.join(', ')})`);
  }
  _manifest = raw;
  return raw;
}

// Test seam: override the manifest (and thus the version + binary map).
export function _setManifestForTests(m) { _manifest = m; }

// Map a host's reported (uname -s, uname -m) to a cross-compile target
// {goos, goarch}, or null if the pair isn't in the supported matrix.
//
// `uname -s` values: "Linux", "Darwin", and on Windows "MINGW*_NT-*" (Git Bash /
// MSYS2), "CYGWIN_NT-*", or "MSYS_NT-*". `uname -m` is x86_64/amd64 or
// aarch64/arm64. BOTH dimensions must resolve: an unknown OS OR an unknown arch
// yields null, so the bootstrap surfaces a clear CompanionTransportError rather
// than selecting a wrong-OS binary that fails opaquely at exec (the macOS/Windows
// selection that WARDEN-294 makes OS-aware).
export function targetForUname(osStr, archStr) {
  if (!osStr || !archStr) return null;
  let goos;
  if (/^Darwin/i.test(osStr)) goos = 'darwin';
  else if (/^Linux/i.test(osStr)) goos = 'linux';
  else if (/^(MINGW|CYGWIN|MSYS)/i.test(osStr)) goos = 'windows';
  else return null;
  let goarch;
  if (/^(x86_64|amd64)$/i.test(archStr)) goarch = 'amd64';
  else if (/^(aarch64|arm64)$/i.test(archStr)) goarch = 'arm64';
  else return null;
  return { goos, goarch };
}

// The remote path for the companion binary. `version` is validated hex from the
// manifest; `$HOME` is deliberately left unexpanded so it expands on the host.
export function remoteBinaryPath(version) {
  return `${COMPANION_DIR}/companion-${version}`;
}

// ------------------------------- pure helpers -------------------------------
// All bash that runs remotely is built by exported, bash-lc-testable helpers
// (WARDEN-140: extract + test remote command builders rather than hand-assemble).

// Probe the host OS + arch and whether the right-version binary already exists.
// Emits three parseable lines:
//   OS=Linux                 (uname -s)
//   ARCH=x86_64              (uname -m)
//   HAVE=1   (1 if companion-<ver> exists & is executable, else 0)
// OS + arch together drive OS-aware binary selection (WARDEN-294): a darwin host
// must select the darwin binary, not the linux one. `$HOME` is in DOUBLE quotes
// so it expands remotely; the version is validated hex so it is safe to
// interpolate (never user-controlled).
export function buildProbeScript(remotePath) {
  return `echo "OS=$(uname -s)"; echo "ARCH=$(uname -m)"; echo "HAVE=$(test -x "${remotePath}" && echo 1 || echo 0)"`;
}

// Receive the binary on stdin, write it to the remote path, make executable.
// `mkdir -p` first so the very first bootstrap needs zero host-side prep.
export function buildUploadScript(remotePath) {
  return `mkdir -p "${COMPANION_DIR}" && cat > "${remotePath}" && chmod +x "${remotePath}"`;
}

export function parseProbe(stdout) {
  const s = stdout || '';
  const os = (/^OS=(.+)$/m.exec(s) || [])[1];
  const arch = (/^ARCH=(.+)$/m.exec(s) || [])[1];
  const haveMatch = (/^HAVE=([01])$/m.exec(s) || [])[1];
  return { os: os ? os.trim() : '', arch: arch ? arch.trim() : '', have: haveMatch === '1' };
}

// RPC request framing — one JSON object per line. id is owned by the caller and
// echoed verbatim by the companion (see main.go).
export function encodeRequest(id, method, params) {
  const o = { id, method };
  if (params && typeof params === 'object' && Object.keys(params).length > 0) o.params = params;
  return JSON.stringify(o);
}

// Map a companion `discover` result (containers[]) into warden chat objects —
// the SAME shape the default discover() path builds (chats.js), so callers can't
// tell the two paths apart by field. Both paths build the literal via the shared
// chatMeta.buildChat(), so parity is structural (WARDEN-272 review #5).
// lastActivity is parsed here from each ACTIVE container's host-side-captured
// leading pane line (containerInfo.Pane) via the SAME parseActivityTimestamp
// helper the default path uses — one regex, both paths agree by construction
// (WARDEN-376 closed the slice-1 gap where the companion left lastActivity null
// and active agents classified UNKNOWN in Fleet Health). Inactive containers,
// lean-mode (no Pane captured), and garbage/empty lines leave lastActivity null.
export function mapCompanionContainers(host, containers, session = 'agent') {
  const chats = [];
  for (const c of containers || []) {
    const name = c.name;
    if (!name) continue;
    const chat = buildChat(host, name, c.status, c.cwd, c.active, session);
    // Only active agents carry a captured leading line (the Go side captures
    // Pane for active containers only); parse it through the shared helper so
    // lastActivity matches the default path's field exactly.
    if (c.active) {
      const ts = parseActivityTimestamp(c.pane);
      if (ts != null) {
        chat.lastActivity = ts;
      }
    }
    chats.push(chat);
  }
  // Identical ordering to the default discover() path: active first, then by key.
  return sortChats(chats);
}

// ------------------------------- errors -------------------------------------

export class CompanionTransportError extends Error {
  constructor(host, reason, recovery) {
    super(`companion transport error for ${host}: ${reason}`);
    this.name = 'CompanionTransportError';
    this.host = host;
    this.reason = reason;
    this.recovery = recovery ||
      `Set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path, or verify the host is reachable (ssh ${host}).`;
  }
}

// A companion RPC returned {ok:false}. Distinct from a transport/bootstrap error.
export class CompanionRpcError extends Error {
  constructor(host, message) {
    super(`companion RPC error on ${host}: ${message}`);
    this.name = 'CompanionRpcError';
    this.host = host;
  }
}

// ------------------------------- RPC channel --------------------------------
// A CompanionChannel wraps ONE persistent ssh-to-companion process and multiplexes
// request/response by id. The transport layer (write/onLine/onExit/kill) is
// injectable so the framing + bootstrap are unit-testable with no real ssh.

export class CompanionChannel {
  constructor(host, transport) {
    this.host = host;
    this.transport = transport;
    this.nextId = 1;
    this.pending = new Map(); // String(id) -> { resolve, reject, timer }
    this.dead = false;
    this._diedWith = null;
    transport.onLine((line) => this._onLine(line));
    transport.onExit((err) => this._die(err || new Error('companion process exited')));
  }

  _onLine(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; } // ignore non-JSON noise
    const p = this.pending.get(String(msg.id));
    if (!p) return; // response for an unknown/already-resolved id
    this.pending.delete(String(msg.id));
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(msg.result);
    } else {
      p.reject(new CompanionRpcError(this.host, msg.error || 'rpc returned ok:false with no error'));
    }
  }

  _die(err) {
    if (this.dead) return;
    this.dead = true;
    this._diedWith = err;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  call(method, params, opts = {}) {
    if (this.dead) {
      return Promise.reject(new CompanionTransportError(
        this.host, `channel is dead (${this._diedWith?.message || 'exited'}); cannot send '${method}'`));
    }
    const id = this.nextId++;
    const key = String(id);
    const req = encodeRequest(id, method, params);
    const timeout = opts.timeout ?? 30000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(key)) {
          reject(new CompanionTransportError(
            this.host, `timed out waiting for companion response to '${method}' after ${timeout}ms`));
        }
      }, timeout);
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.transport.write(req);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new CompanionTransportError(this.host, `failed to write '${method}' request: ${e.message}`));
      }
    });
  }

  kill() {
    this._die(new Error('killed'));
    try { this.transport.kill(); } catch { /* noop */ }
  }
}

// ----------------------- ssh transports (real + seams) ----------------------

// Spawn the persistent ssh-to-companion process and return a Transport
// ({write,onLine,onExit,kill}). One process per host; reused for every RPC.
function spawnPersistentChannel(host, remotePath, cfg, spawnFn) {
  const args = [...SSH_BASE_OPTS, '-o', `ConnectTimeout=${cfg.connectTimeout ?? 10}`, host, remotePath];
  let child;
  try {
    child = spawnFn(SSH_BIN, args, { windowsHide: true });
  } catch (e) {
    return makeDeadTransport(new Error(`failed to spawn companion ssh: ${e.message}`));
  }
  const rl = readline.createInterface({ input: child.stdout });
  let lineCb = null;
  let exitCb = null;
  rl.on('line', (line) => { if (lineCb) lineCb(line); });
  const onExit = (err) => { if (exitCb) exitCb(err); };
  child.on('exit', (code) => onExit(new Error(`companion ssh exited with code ${code}`)));
  child.on('error', (e) => onExit(e));
  return {
    write(line) {
      try { child.stdin.write(line + '\n'); }
      catch (e) { onExit(new Error(`stdin write failed: ${e.message}`)); }
    },
    onLine(cb) { lineCb = cb; },
    onExit(cb) { exitCb = cb; },
    kill() { try { child.kill('SIGTERM'); } catch { /* noop */ } },
  };
}

// A transport that is already dead — used when spawn itself throws.
function makeDeadTransport(err) {
  let exitCb = null;
  // Fire onExit asynchronously so the CompanionChannel constructor (which calls
  // onExit AFTER assigning it) still observes the death.
  setImmediate(() => { if (exitCb) exitCb(err); });
  return {
    write() { /* noop */ },
    onLine() {},
    onExit(cb) { exitCb = cb; },
    kill() {},
  };
}

// Stream the bundled binary to the host over ssh stdin (the VS Code Remote-SSH
// model). Returns { ok, code, stderr }. The binary is only ever exec'd on the
// REMOTE host after this upload, never locally.
function streamFileToHost(host, localBinaryPath, remotePath, cfg, spawnFn) {
  const cmd = buildUploadScript(remotePath);
  const args = [...SSH_BASE_OPTS, '-o', `ConnectTimeout=${cfg.connectTimeout ?? 10}`, host, `bash -lc ${shellQuote(cmd)}`];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(SSH_BIN, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, stderr: `spawn failed: ${e.message}` });
      return;
    }
    let stderr = '';
    let resolved = false;
    const done = (r) => { if (!resolved) { resolved = true; resolve(r); } };
    const stream = fs.createReadStream(localBinaryPath);
    stream.on('error', (e) => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      done({ ok: false, code: -1, stderr: `read binary failed: ${e.message}` });
    });
    child.on('error', (e) => done({ ok: false, code: -1, stderr: String(e) }));
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => {
      stream.destroy();
      done({ ok: code === 0, code: code ?? -1, stderr });
    });
    stream.pipe(child.stdin);
  });
}

// ------------------------------- bootstrap ----------------------------------

const channelCache = new Map(); // host -> CompanionChannel

export function _resetChannelCacheForTests() {
  for (const ch of channelCache.values()) {
    try { if (ch && typeof ch.kill === 'function') ch.kill(); } catch { /* noop */ }
  }
  channelCache.clear();
}

// Ping the channel once. Returns {ok:true} | {ok:false, reason:'mismatch', got}
// | {ok:false, reason:'unreachable', err}.
async function pingOnce(channel, expectedVersion, cfg) {
  let res;
  try {
    res = await channel.call('ping', {}, { timeout: (cfg.connectTimeout ?? 10) * 1000 + 8000 });
  } catch (e) {
    return { ok: false, reason: 'unreachable', err: e };
  }
  if (!res || res.version !== expectedVersion) {
    return { ok: false, reason: 'mismatch', got: res ? res.version : null };
  }
  return { ok: true };
}

// Bootstrap one host's companion channel:
//  1. probe arch + whether the right-version binary already exists
//  2. upload the binary if missing (stream over ssh; chmod +x; no host prep)
//  3. spawn the persistent ssh process and verify identity with a ping
// On a version mismatch from a pre-existing (stale) binary, force one re-upload
// — the warden-upgrade case. Any failure throws CompanionTransportError.
async function bootstrapChannel(host, cfg, deps) {
  const runFn = deps.run ?? defaultRun;
  const spawnFn = deps.spawn ?? spawn;
  const uploadFn = deps.upload ?? ((h, lb, rp, c) => streamFileToHost(h, lb, rp, c, spawnFn));
  const spawnChannelFn = deps.spawnChannel ?? ((h, rp, c) => spawnPersistentChannel(h, rp, c, spawnFn));
  const manifest = deps.manifest ?? loadManifest();
  const connectMs = (cfg.connectTimeout ?? 10) * 1000;

  const remotePath = remoteBinaryPath(manifest.version);

  // 1. Probe.
  const probeRes = await runFn(host, buildProbeScript(remotePath), { timeout: connectMs + 5000 }, cfg);
  if (!probeRes.ok) {
    throw new CompanionTransportError(host,
      `bootstrap probe failed: ${(probeRes.stderr || '').trim() || `ssh exited ${probeRes.code}`}`);
  }
  const { os, arch, have } = parseProbe(probeRes.stdout);
  const target = targetForUname(os, arch);
  if (!target) {
    throw new CompanionTransportError(host,
      `host reports os '${os || 'unknown'}' arch '${arch || 'unknown'}'; the bundled companion supports ${SUPPORTED_TARGETS.join(', ')} only`);
  }
  const binaryPath = path.join(distDir(), manifest.binaries[`${target.goos}/${target.goarch}`]);
  if (!fs.existsSync(binaryPath)) {
    throw new CompanionTransportError(host, `bundled companion binary not found at ${binaryPath}`);
  }

  // 2. Upload if missing.
  let didUpload = false;
  if (!have) {
    const up = await uploadFn(host, binaryPath, remotePath, cfg);
    if (!up.ok) {
      throw new CompanionTransportError(host,
        `bootstrap upload failed: ${(up.stderr || '').trim() || `ssh exited ${up.code}`}`);
    }
    didUpload = true;
  }

  // 3. Spawn + ping. A stale cached binary (wrong version) triggers one re-upload.
  const channel = new CompanionChannel(host, spawnChannelFn(host, remotePath, cfg));
  const ping = await pingOnce(channel, manifest.version, cfg);
  if (ping.ok) return channel;

  channel.kill();
  if (ping.reason === 'mismatch' && !didUpload) {
    const up = await uploadFn(host, binaryPath, remotePath, cfg);
    if (!up.ok) {
      throw new CompanionTransportError(host,
        `re-upload of stale companion failed: ${(up.stderr || '').trim() || `ssh exited ${up.code}`}`);
    }
    const channel2 = new CompanionChannel(host, spawnChannelFn(host, remotePath, cfg));
    const ping2 = await pingOnce(channel2, manifest.version, cfg);
    if (ping2.ok) return channel2;
    channel2.kill();
    throw new CompanionTransportError(host, ping2.reason === 'mismatch'
      ? `companion on host reports version '${ping2.got}' after re-upload; expected '${manifest.version}'`
      : `companion did not respond after re-upload: ${ping2.err?.message ?? ping2.err}`);
  }
  throw new CompanionTransportError(host, ping.reason === 'mismatch'
    ? `companion on host reports version '${ping.got}'; expected '${manifest.version}'. The cached binary is stale — remove ${remotePath} on the host and retry.`
    : `companion bootstrap uploaded the binary but the process did not respond to ping: ${ping.err?.message ?? ping.err}.`);
}

// Get the cached channel for a host, or bootstrap one. The cache is what makes
// per-op handshake cost collapse to zero after the first op (WARDEN-272 AC #1/#5).
//
// Concurrent calls for the SAME host (e.g. the 2s monitor tick landing on a 60s
// lifecycle poll for one host) coalesce onto ONE in-flight bootstrap by caching
// the bootstrap *promise*: the second caller awaits the first's bootstrap rather
// than starting its own, so no ssh + companion process leaks. On failure the
// promise is dropped so a later call can retry (no cached rejection).
export async function getChannel(host, cfg = {}, deps = {}) {
  if (host === LOCAL) {
    throw new CompanionTransportError(host, 'companion transport serves remote hosts only, not (local)');
  }
  const existing = channelCache.get(host);
  if (existing) {
    // Reuse an in-flight bootstrap (a Promise) or a live channel. A dead channel
    // (existing.dead) falls through to a fresh bootstrap below.
    if (typeof existing.then === 'function') return existing; // bootstrap in flight — await it
    if (!existing.dead) return existing;                      // live channel — reuse
  }
  const bootstrapPromise = bootstrapChannel(host, cfg, deps)
    .then((channel) => {
      channelCache.set(host, channel);
      return channel;
    })
    .catch((err) => {
      if (channelCache.get(host) === bootstrapPromise) channelCache.delete(host);
      throw err;
    });
  channelCache.set(host, bootstrapPromise);
  return bootstrapPromise;
}

// --------------------------------- discover ---------------------------------

// discover() over the companion channel. Returns the same { host, ok, chats } /
// { host, ok:false, error, chats:[] } contract as chats.js discover(). On ANY
// failure it returns { ok:false } with an actionable error — it NEVER falls back
// to raw SSH (the experimental path's contract; opt out via the env var).
export async function discover(host, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, error: 'companion transport does not apply to the local host', chats: [] };
  }
  try {
    const channel = await getChannel(host, cfg, deps);
    const session = cfg.tmuxSession || 'agent';
    // Forward opts.activity over the wire (lean-mode parity — WARDEN-376). The
    // default path gates its per-agent capture-pane pass on `opts.activity !==
    // false` (chats.js:265); the 60s lifecycle poll runs lean (`activity: false`)
    // to SKIP that per-agent work (WARDEN-147). Mirror the same semantics so the
    // companion's host-side leading-line capture runs on the user-facing discover
    // but NOT on the lean lifecycle poll — otherwise the poll would suddenly do
    // per-active-container capture-pane work every tick (a quiet local-cost
    // regression and a behavioral divergence from the default path's lean mode).
    const activity = opts.activity !== false;
    const result = await channel.call('discover', { session, activity }, { timeout: opts.timeout ?? 60000 });
    const chats = mapCompanionContainers(host, result?.containers || [], session);
    return { host, ok: true, chats };
  } catch (e) {
    let msg;
    if (e instanceof CompanionTransportError) {
      // Surface the actionable recovery hint (opt-out env var) so the user knows
      // exactly how to return to the default SSH path — no silent fallback.
      msg = e.message + (e.recovery ? ` ${e.recovery}` : '');
    } else if (e instanceof CompanionRpcError) {
      msg = e.message;
    } else {
      msg = `companion discover failed on ${host}: ${e?.message ?? e}`;
    }
    return { host, ok: false, error: msg, chats: [] };
  }
}

// -------------------------------- capturePanes --------------------------------
// WARDEN-276 (slice 2 of roadmap WARDEN-270). capture-pane is the highest-
// frequency remote op (every observer poll + the 2s monitor tick), so routing
// it over the persistent companion channel collapses the per-tick ssh handshake
// that dominates the ControlMaster-disabled / Windows path. The bootstrap+
// channel are slice 1's, reused verbatim; this only adds the RPC client + the
// host-side capturePanes RPC (companion/main.go) that runs the batched,
// sentinel-framed tmux capture LOCALLY on the host.

// capturePanes() over the companion channel, for ONE host's pane list. Returns
// { host, ok, panes } where panes is the key->content map, or { host, ok:false,
// error, panes:{} } on ANY failure — it NEVER falls back to raw SSH (the
// experimental path's contract; opt out via WARDEN_COMPANION_TRANSPORT). The
// returned map is the SAME shape the default runWithPool capturePanes path
// produces (sentinel framing reproduced faithfully on the host side).
export async function capturePanes(host, list, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, error: 'companion transport does not apply to the local host', panes: {} };
  }
  try {
    const channel = await getChannel(host, cfg, deps);
    // Send the per-host pane list. `container` is null for bare-tmux / manual
    // chats so the companion selects bare `tmux` (vs `docker exec <c> tmux`).
    // The target falls back container -> 'agent', identical to chats.js.
    const panes = (list || []).map((c) => ({
      key: c.key,
      container: c.container || null,
      session: c.session || c.container || 'agent',
    }));
    const result = await channel.call('capturePanes', { panes }, { timeout: opts.timeout ?? 15000 });
    return { host, ok: true, panes: (result && result.panes) || {} };
  } catch (e) {
    let msg;
    if (e instanceof CompanionTransportError) {
      msg = e.message + (e.recovery ? ` ${e.recovery}` : '');
    } else if (e instanceof CompanionRpcError) {
      msg = e.message;
    } else {
      msg = `companion capturePanes failed on ${host}: ${e?.message ?? e}`;
    }
    return { host, ok: false, error: msg, panes: {} };
  }
}


// -------------------------------- hasSession --------------------------------
// WARDEN-382 (slice 3 of roadmap WARDEN-270). has-session is the pre-attach /
// pre-recovery LIVENESS PROBE — it fires on every pane open + the recovery flows.
// Routing it over the persistent companion channel collapses the per-probe SSH
// handshake the default probeSession path pays (one ssh spawn per probe). The
// bootstrap+channel are slice 1's, reused verbatim; this only adds the RPC client.
//
// Returns { host, ok, exists } where exists is the host-side has-session verdict,
// or { host, ok:false, transport, error, exists:false } on ANY failure — it NEVER
// falls back to raw SSH (companion-or-fail; opt out via WARDEN_COMPANION_TRANSPORT).
// `transport` flags a CompanionTransportError (host unreachable / channel died) so
// tmux.js can map it to 'host_unreachable' rather than the ambiguous 'session_dead'
// — the whole point of the slice: reachability vs session-existence, separated by
// the channel contract instead of the raw-SSH isTransportFailure heuristic.
export async function hasSession(host, { container, session } = {}, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, error: 'companion transport does not apply to the local host', exists: false };
  }
  try {
    const channel = await getChannel(host, cfg, deps);
    // The target falls back session -> container -> 'agent', identical to
    // capturePanes (companion.js:512-517) and src/chats.js. `container` is null
    // for bare-tmux / manual chats so the companion selects bare `tmux`.
    const target = session || container || 'agent';
    const result = await channel.call('hasSession', { container: container || null, session: target }, { timeout: opts.timeout ?? 10000 });
    return { host, ok: true, exists: !!(result && result.exists) };
  } catch (e) {
    const transport = e instanceof CompanionTransportError;
    let msg;
    if (transport) {
      msg = e.message + (e.recovery ? ` ${e.recovery}` : '');
    } else if (e instanceof CompanionRpcError) {
      msg = e.message;
    } else {
      msg = `companion hasSession failed on ${host}: ${e?.message ?? e}`;
    }
    return { host, ok: false, transport, error: msg, exists: false };
  }
}

// --------------------------------- lifecycle ---------------------------------
// WARDEN-386 (slice 3 of roadmap WARDEN-270). The agent lifecycle commands —
// spawn (create) + kill (destroy) — are the create/destroy twins that today still
// pay a per-op SSH handshake. These two RPCs run the tmux command LOCALLY on the
// host over the persistent channel (the per-op-handshake win), mirroring the
// shipped capturePanes sibling. The bootstrap + channel are slice 1's, reused
// verbatim; this only adds the two RPC clients + the host-side spawnSession/
// killSession RPCs (companion/main.go) that run new-session/kill-session LOCALLY
// on the host.

// spawnSession() over the companion channel — the CREATE half of the agent
// lifecycle. Returns { host, ok } on success, or { host, ok:false, error } on ANY
// failure — it NEVER falls back to raw SSH (the experimental path's contract; opt
// out via WARDEN_COMPANION_TRANSPORT). `params` carries the semantic fields the
// host-side RPC builds the new-session argv from: container (docker container, or
// null for a bare-tmux/manual chat → bare `tmux`), session (the tmux target,
// falling back to container then 'agent'), cwd (chat.cwd VERBATIM for remote —
// no msys translation, which is local-only), and cmd (the command argv; empty →
// tmux's default shell, WARDEN-223). The argv is reproduced byte-for-byte on the
// host side (companion/main.go spawnSession), matching the default runTmux path.
export async function spawnSession(host, params, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, error: 'companion transport does not apply to the local host' };
  }
  try {
    const channel = await getChannel(host, cfg, deps);
    const payload = {
      container: params?.container || null,
      session: params?.session || params?.container || 'agent',
      cwd: params?.cwd || '',
      cmd: Array.isArray(params?.cmd) ? params.cmd : [],
    };
    await channel.call('spawnSession', payload, { timeout: opts.timeout ?? 30000 });
    return { host, ok: true };
  } catch (e) {
    let msg;
    if (e instanceof CompanionTransportError) {
      msg = e.message + (e.recovery ? ` ${e.recovery}` : '');
    } else if (e instanceof CompanionRpcError) {
      msg = e.message;
    } else {
      msg = `companion spawnSession failed on ${host}: ${e?.message ?? e}`;
    }
    return { host, ok: false, error: msg };
  }
}

// killSession() over the companion channel — the DESTROY half of the agent
// lifecycle. Returns { host, ok } / { host, ok:false, error }, companion-or-fail
// (never falls back to raw SSH). kill is IDEMPOTENT / best-effort: the host-side
// RPC surfaces "session not found" / "no server running" as a benign ok (the
// session is already gone — exactly what the caller wanted), so /api/kill's
// existing best-effort semantics are preserved. Mirrors capturePanes' shape.
export async function killSession(host, params, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, error: 'companion transport does not apply to the local host' };
  }
  try {
    const channel = await getChannel(host, cfg, deps);
    const payload = {
      container: params?.container || null,
      session: params?.session || params?.container || 'agent',
    };
    await channel.call('killSession', payload, { timeout: opts.timeout ?? 15000 });
    return { host, ok: true };
  } catch (e) {
    let msg;
    if (e instanceof CompanionTransportError) {
      msg = e.message + (e.recovery ? ` ${e.recovery}` : '');
    } else if (e instanceof CompanionRpcError) {
      msg = e.message;
    } else {
      msg = `companion killSession failed on ${host}: ${e?.message ?? e}`;
    }
    return { host, ok: false, error: msg };
  }
}


// ------------------------------- resize -------------------------------------
// WARDEN-409 (slice 4 of roadmap WARDEN-270). The interactive-pane CONTROL-PLANE
// tmux command — `resize` (set-option window-size latest) — is a one-line
// request/response tmux-option op that fires on every pane OPEN and every
// in-session RESIZE. Routing it over the persistent companion channel collapses
// the per-open / per-resize SSH handshake the default runTmux path pays. The
// bootstrap+channel are slice 1's, reused verbatim; this only adds the RPC client.
//
// Unlike hasSession (which returns {host, ok, exists}), this returns the SAME raw
// {host, ok, code, stdout, stderr} shape — minus nothing runTmux produces — so
// src/tmux.js maps it to the identical result the default path emits and the
// server.js best-effort call site is unchanged. Companion-or-fail: NEVER falls
// back to raw SSH (opt out via WARDEN_COMPANION_TRANSPORT).

// Map a successful RPC result ({ok, code, stdout, stderr} from the Go side) to
// the raw runTmux-shaped envelope the control-plane clients return. Mirrors the
// JS result shape runTmux/runLocalTmux produce (src/ssh.js): ok + code + stdout +
// stderr, with `host` carried as the envelope convention every companion client
// uses. Defensively defaults missing fields so a malformed result can never crash
// a best-effort caller.
function mapCmdResult(host, result) {
  const r = result || {};
  return {
    host,
    ok: !!r.ok,
    code: typeof r.code === 'number' ? r.code : (r.ok ? 0 : -1),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// Map a thrown channel error (bootstrap/transport/RPC) to the raw-shaped envelope
// with ok:false. A transport failure (host unreachable / channel died) and an RPC
// error both surface as ok:false with the message on stderr — exactly what a
// best-effort caller (resize, wrapped in try/catch at the server.js call site)
// needs to swallow without distinguishing.
function mapCmdError(host, e) {
  let msg;
  if (e instanceof CompanionTransportError) {
    msg = e.message + (e.recovery ? ` ${e.recovery}` : '');
  } else if (e instanceof CompanionRpcError) {
    msg = e.message;
  } else {
    msg = `companion op failed on ${host}: ${e?.message ?? e}`;
  }
  return { host, ok: false, code: -1, stdout: '', stderr: msg };
}

// resize() over the companion channel: runs `set-option -t <target> window-size
// latest` host-side. Returns {host, ok, code, stdout, stderr} (the raw runTmux
// shape) or {host, ok:false, code:-1, stderr} on ANY failure — it NEVER falls back
// to raw SSH. The target falls back session → container → "agent", identical to
// hasSession (companion.js) and src/chats.js. `container` is null for bare-tmux /
// manual chats so the companion selects bare `tmux`.
export async function resize(host, { container, session } = {}, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, code: -1, stdout: '', stderr: 'companion transport does not apply to the local host' };
  }
  try {
    const channel = await getChannel(host, cfg, deps);
    const target = session || container || 'agent';
    const result = await channel.call('resize', { container: container || null, session: target }, { timeout: opts.timeout ?? 10000 });
    return mapCmdResult(host, result);
  } catch (e) {
    return mapCmdError(host, e);
  }
}


// Pure model of per-tick ssh spawn cost, used by scripts/companion-benchmark.mjs
// and unit-tested here (WARDEN-272 AC #5: "a spawn/handshake counter per discover
// tick"). Mirrors the real transport:
//   default  : discover() does ONE runWithPool ssh spawn per host per tick; on
//              the ControlMaster-disabled / Windows path each is a full handshake.
//   companion: bootstrap pays a bounded number of ssh spawns ONCE per host
//              (probe + upload-once + channel), then ZERO per tick thereafter.
export function projectSpawnModel({ hosts = 1, ticks = 1, alreadyBootstrapped = false } = {}) {
  const h = Math.max(0, hosts);
  const t = Math.max(0, ticks);
  const bootstrapPerHost = alreadyBootstrapped ? 0 : 3; // probe + upload + channel
  const beforeTotal = h * t;            // 1 handshake / host / tick
  const afterTotal = h * bootstrapPerHost; // bootstrap once; 0/tick after
  return {
    hosts: h,
    ticks: t,
    before: { totalSpawns: beforeTotal, perTick: h },           // handshakes every tick
    after: { totalSpawns: afterTotal, bootstrap: h * bootstrapPerHost, perTick: 0 },
    savedSpawns: Math.max(0, beforeTotal - afterTotal),
  };
}
