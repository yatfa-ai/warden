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
// This whole path is GATED behind the companion transport being enabled
// (experimental). The default discover()/runWithPool() SSH path is untouched
// and remains the default. Companion-or-fail: on bootstrap failure this path
// surfaces a clear, actionable error and NEVER silently falls back to raw SSH.
//
// Enablement (WARDEN-439): historically an env-var-only opt-in
// (WARDEN_COMPANION_TRANSPORT=1). It is now a persisted Settings toggle
// (config.companionTransportEnabled) that drives this same gate — applied at
// server boot and live on every PUT /api/config, so a flip takes effect on the
// next op, not on a restart. The env var remains an explicit OPERATOR OVERRIDE
// (set it to '1'/'0' to force the choice regardless of the UI). See
// applyCompanionToggle below.

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

// WARDEN-439: drive the env-var gate above from the persisted Settings toggle.
// The toggle (config.companionTransportEnabled) is applied at server boot and
// on every PUT /api/config, so the routing sites that call
// isCompanionTransportEnabled() pick up a flip on the next op without a restart.
//
// `override` MUST reflect whether the operator set WARDEN_COMPANION_TRANSPORT
// before warden started (snapshot once at boot). When true, the env var is an
// explicit operator choice and the UI toggle is inert — never clobber it. When
// false, write the gate from the persisted toggle. Returns the resulting
// enabled state so callers (GET /api/config) can report it without a re-read.
export function applyCompanionToggle(enabled, { override = false, env = process.env } = {}) {
  if (!override) env.WARDEN_COMPANION_TRANSPORT = enabled ? '1' : '0';
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
    this._eventHandler = null; // unsolicited event handler (WARDEN-413)
    this._methods = null;      // cached ping `methods` (feature-detect; WARDEN-413)
    transport.onLine((line) => this._onLine(line));
    transport.onExit((err) => this._die(err || new Error('companion process exited')));
  }

  _onLine(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; } // ignore non-JSON noise
    // WARDEN-413: an UNSOLICITED event line carries an `event` field and NO id
    // (e.g. {"event":"paneDelta","panes":{…}}). RPC responses never carry `event`
    // (they carry `ok`), so this is unambiguous and strictly additive: dispatch
    // to the registered handler instead of dropping it as an unknown id.
    if (msg.event) {
      if (this._eventHandler) {
        try { this._eventHandler(msg); } catch { /* handler must not break the channel */ }
      }
      return;
    }
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

  // Register a handler for unsolicited event lines (subscribePanes paneDelta
  // pushes). At most one handler per channel; the channel is shared per host so
  // the handler fans updates into the host's delta cache. Returns the handler so
  // it can be re-installed idempotently. (WARDEN-413)
  onEvent(handler) {
    this._eventHandler = handler;
    return handler;
  }

  offEvent() {
    this._eventHandler = null;
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
  // Cache the advertised method list for feature-detection (WARDEN-413): a stale
  // cached companion binary predates subscribePanes, so subscribePanes() checks
  // this list before subscribing and degrades to the poll path when it's absent.
  if (Array.isArray(res.methods)) channel._methods = res.methods;
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

// --------------------------------- send --------------------------------------
// WARDEN-888 (the final slice of roadmap WARDEN-270). The user-input WRITE path
// — send (a directive) + sendKey (a special key) — is the last op family that
// still pays a per-op SSH handshake on remote hosts. Routing it over the
// persistent companion channel collapses the per-message handshake (the ~30s/
// action cost on the ControlMaster-disabled / Windows path that is this roadmap's
// reason for existing). The host side runs the WARDEN-254 bracketed-paste
// sequence in ONE atomic bash -lc script (companion/main.go send). The bootstrap
// + channel are slice 1's, reused verbatim; this only adds the RPC clients.
//
// Returns the SAME raw {host, ok, code, stdout, stderr} shape resize produces (so
// src/tmux.js maps it to the identical runTmux result the default path emits),
// or {host, ok:false, code:-1, stderr} on ANY channel failure — companion-or-fail,
// NEVER a silent raw-SSH fallback.
//
// Stale-binary graceful degradation: a cached binary predating this slice does
// not advertise `send`/`sendKeys` in its ping methods. That is NOT a failure —
// it returns {host, unsupported:true} so the caller falls back to runTmux
// (mirroring subscribePanes' methods check), so rolling this JS out does not
// require every host re-bootstrapped at once. A DEAD channel (the one case that
// must NOT silently fall back) fails earlier at getChannel and surfaces a real
// {ok:false, code:-1, stderr} error — the unsupported sentinel only fires when
// the channel is alive but its binary is old.

// send() over the companion channel: runs the WARDEN-254 write sequence
// (single-line send-keys -l + Enter; multiline set-buffer / paste-buffer -p -d /
// send-keys Enter) host-side. <text> is an arbitrary user directive carried as a
// JSON param and shell-quoted HOST-SIDE (never interpolated raw). The target
// falls back session → container → "agent", identical to resize / hasSession.
export async function send(host, { container, session, text } = {}, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, code: -1, stdout: '', stderr: 'companion transport does not apply to the local host' };
  }
  try {
    const channel = await getChannel(host, cfg, deps);
    const methods = await channelMethods(channel, opts);
    if (!methods.includes('send')) {
      // Stale cached binary (predates WARDEN-888): degrade to runTmux. The channel
      // is alive (getChannel succeeded); only the binary lacks the `send` RPC.
      return { host, unsupported: true };
    }
    const target = session || container || 'agent';
    const result = await channel.call('send', {
      container: container || null,
      session: target,
      text: text == null ? '' : String(text),
    }, { timeout: opts.timeout ?? 15000 });
    return mapCmdResult(host, result);
  } catch (e) {
    return mapCmdError(host, e);
  }
}

// sendKey() over the companion channel: runs `send-keys -t <target> <key>` for a
// key the caller ALREADY validated against ALLOWED_KEYS (the trust boundary stays
// JS-side, identical to the default sendKey path). Mirrors send's shape + stale-
// binary degradation.
export async function sendKey(host, { container, session, key } = {}, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, code: -1, stdout: '', stderr: 'companion transport does not apply to the local host' };
  }
  try {
    const channel = await getChannel(host, cfg, deps);
    const methods = await channelMethods(channel, opts);
    if (!methods.includes('sendKeys')) {
      return { host, unsupported: true };
    }
    const target = session || container || 'agent';
    const result = await channel.call('sendKeys', {
      container: container || null,
      session: target,
      key,
    }, { timeout: opts.timeout ?? 15000 });
    return mapCmdResult(host, result);
  } catch (e) {
    return mapCmdError(host, e);
  }
}

// ------------------------------- subscribePanes --------------------------------
// WARDEN-413 (problem #3 of roadmap WARDEN-270). capture-pane is polled every 2s
// monitor tick + every observer poll even when nothing changed; for an idle fleet
// that is pure waste scaled by hosts × panes × scrollback. subscribePanes flips
// REMOTE pane capture from PULL to PUSH: the companion watches the pane set and
// emits paneDelta events for ONLY the changed panes (empty-panes = heartbeat);
// the consumer renders from the in-memory delta cache and SKIPS the capturePanes
// RPC on the monitor tick. Idle-fleet channel traffic collapses to ~0 while
// active panes still update within ~one tick.
//
// This whole path is GATED behind WARDEN_COMPANION_TRANSPORT=1 (experimental),
// reuses the shipped channel/bootstrap (WARDEN-272/276/382), and is strictly
// additive: request/response RPCs are byte-for-byte unchanged. A companion that
// does NOT advertise subscribePanes (a stale cached binary) is detected via the
// ping `methods` list and the subscription degrades to the existing poll path —
// never a hard failure that breaks pane rendering.

// A delta is "fresh" while no monitor-tick liveness window has elapsed without a
// push. 3 × the 2s monitor tick = 6s; the companion heartbeat (4s, main.go) stays
// below this so a LIVE idle host keeps warden out of its poll backstop, while a
// stalled/dead push ages out and capturePanes resumes polling within ~3 ticks.
export const PANE_DELTA_FRESH_MS = 6000;

// host -> { panes: {key: content}, lastEventAt: ms }. In-memory only — never
// persisted/serialized (the same trust boundary as capturePanes' panes map).
const paneDeltaCache = new Map();

// host -> Map(key -> { descriptor, refs }). Ref-counted across WS connections so
// two tabs monitoring panes on the same host share ONE subscription whose pane
// set is the union of both; a key is dropped only when its LAST monitor closes.
const paneSubscriptions = new Map();

// host -> Promise. Serializes per-host subscribe/unsubscribe syncs so concurrent
// monitor/unmonitor churn (two tabs, rapid open/close) cannot interleave partial
// pane sets to the companion; the last sync always reflects the true union.
const syncInFlight = new Map();

// host -> Map(key -> lastSeenMs). What /api/agent-states is CURRENTLY watching,
// with a TTL. /api/agent-states is stateless HTTP (no connection identity), so a
// per-poller ref like the WS monitor path can't bound a subscription. The TTL
// keeps it multi-tab correct instead: a key is subscribed while ANY poller
// requests it within the TTL, and released only when the last poller stops. One
// ref per watched key (balanced add/remove), composable with the WS monitor refs.
const agentStateWatched = new Map();
const AGENT_STATE_TTL_MS = 30_000; // ~1 poll at the 30s /api/agent-states cadence. A pane that left every poller is aged out ~2 polls later (the strict `>` evicts one tick past the TTL).

// Background TTL-sweep timer (started by startPaneDeltaSweep). Held at module
// scope so startPaneDeltaSweep is idempotent and _resetPaneDeltaStateForTests can
// tear it down so a real interval never bleeds across describe blocks.
let paneDeltaSweepTimer = null;

export function _resetPaneDeltaStateForTests() {
  paneDeltaCache.clear();
  paneSubscriptions.clear();
  syncInFlight.clear();
  agentStateWatched.clear();
  if (paneDeltaSweepTimer) { clearInterval(paneDeltaSweepTimer); paneDeltaSweepTimer = null; }
}

// Apply one paneDelta event to the host's cache entry. Exported (and pure aside
// from the cache mutation) so the freshness/skip contract is unit-testable: a
// payload refreshes content + liveness; an empty payload (heartbeat) refreshes
// liveness only. Returns the entry. (WARDEN-413)
export function applyPaneDelta(host, event, now = Date.now()) {
  let entry = paneDeltaCache.get(host);
  if (!entry) {
    entry = { panes: {}, lastEventAt: 0 };
    paneDeltaCache.set(host, entry);
  }
  if (event && event.event === 'paneDelta') {
    const changed = event.panes || {};
    for (const [k, v] of Object.entries(changed)) entry.panes[k] = v;
    entry.lastEventAt = now;
  }
  return entry;
}

// True iff host has a subscription delivering fresh deltas — the gate capturePanes
// checks to SKIP the capturePanes RPC. `now` is injectable for deterministic tests.
export function hasFreshPaneDelta(host, now = Date.now()) {
  const e = paneDeltaCache.get(host);
  return !!e && e.lastEventAt > 0 && (now - e.lastEventAt) <= PANE_DELTA_FRESH_MS;
}

// Read the cached deltas for the requested keys. Only keys present in the cache
// are returned; a missing key stays missing so the caller's existing
// capture_failed handling is unchanged (WARDEN-89). (WARDEN-413)
export function readPaneDeltas(host, keys) {
  const e = paneDeltaCache.get(host);
  const out = {};
  if (!e) return out;
  for (const k of keys || []) {
    if (Object.prototype.hasOwnProperty.call(e.panes, k)) out[k] = e.panes[k];
  }
  return out;
}

// Look up the cached channel for a host without bootstrapping is intentionally
// NOT provided: subscribe/unsubscribe go through syncSubscriptionOnce, which uses
// getChannel (bootstraps if needed for subscribe; unsubscribe's RPC is skipped
// when the channel is absent/dead via the methods check). (WARDEN-413)

// Resolve the companion's advertised method list, caching it on the channel.
// Bootstrapping already stashed it from the ping; if it didn't (e.g. an older
// bootstrap path), fetch it with one ping. Never throws — returns [] on failure
// so the caller's feature-detect simply degrades to the poll path.
async function channelMethods(channel, opts = {}) {
  if (Array.isArray(channel._methods)) return channel._methods;
  try {
    const res = await channel.call('ping', {}, { timeout: opts.timeout ?? 8000 });
    if (res && Array.isArray(res.methods)) channel._methods = res.methods;
    return channel._methods || [];
  } catch {
    return [];
  }
}

// Wire the channel's event handler to feed the host's delta cache, once per
// channel. Idempotent: re-installs the same handler shape if the channel was
// re-bootstrapped (a fresh channel has _eventWired unset). (WARDEN-413)
function ensurePaneDeltaHandler(channel, host) {
  if (channel._eventWired) return;
  channel._eventWired = true;
  channel.onEvent((msg) => {
    if (msg.event !== 'paneDelta') return;
    applyPaneDelta(host, msg);
  });
}

// describePanes normalizes a chat list to the {key,container,session} shape the
// companion expects (identical to capturePanes' mapping). container null for
// bare-tmux; target falls back session -> container -> 'agent'.
function describePanes(list) {
  return (list || []).map((c) => ({
    key: c.key,
    container: c.container || null,
    session: c.session || c.container || 'agent',
  }));
}

// syncSubscriptionOnce sends the host's CURRENT subscribed pane set (the union
// across all connections) to the companion — subscribePanes with the full set, or
// unsubscribePanes when it has emptied. Reads the union fresh on every call so the
// last sync of a churn burst always reflects the true set. (WARDEN-413)
async function syncSubscriptionOnce(host, cfg, opts = {}, deps = {}) {
  const sub = paneSubscriptions.get(host);
  const panes = sub ? [...sub.values()].map((e) => e.descriptor) : [];
  try {
    const channel = await getChannel(host, cfg, deps);
    const methods = await channelMethods(channel, opts);
    if (!methods.includes('subscribePanes')) {
      // Stale cached binary (predates WARDEN-413): degrade to the existing poll
      // path. NOT a failure — capturePanes still works; we just don't push.
      return { host, ok: false, unsupported: true, subscribed: false };
    }
    ensurePaneDeltaHandler(channel, host);
    if (panes.length === 0) {
      // No one is monitoring this host anymore: stop serving cached deltas (so a
      // later capturePanes resumes polling) and tell the companion to stop.
      paneDeltaCache.delete(host);
      if (methods.includes('unsubscribePanes')) {
        await channel.call('unsubscribePanes', {}, { timeout: opts.timeout ?? 5000 });
      }
      return { host, ok: true, subscribed: false };
    }
    await channel.call('subscribePanes', { panes }, { timeout: opts.timeout ?? 15000 });
    return { host, ok: true, subscribed: true, count: panes.length };
  } catch (e) {
    let msg;
    if (e instanceof CompanionTransportError) {
      msg = e.message + (e.recovery ? ` ${e.recovery}` : '');
    } else if (e instanceof CompanionRpcError) {
      msg = e.message;
    } else {
      msg = `companion subscribePanes failed on ${host}: ${e?.message ?? e}`;
    }
    // Companion-or-fail surfaces the actionable error, but a subscription failure
    // does NOT break pane rendering: capturePanes keeps polling (freshness is
    // false until a real push arrives), so this is a recoverable degradation.
    return { host, ok: false, error: msg, subscribed: false };
  }
}

// Serialize per-host syncs so concurrent subscribe/unsubscribe churn collapses
// into an ordered sequence whose final state is the true union. Each call chains
// after the previous one for the same host; the last call reflects reality.
function syncSubscription(host, cfg, opts = {}, deps = {}) {
  const prev = syncInFlight.get(host) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => syncSubscriptionOnce(host, cfg, opts, deps));
  syncInFlight.set(host, next);
  next.finally(() => {
    if (syncInFlight.get(host) === next) syncInFlight.delete(host);
  });
  return next;
}

// subscribePanes adds a chat list's keys to the host's subscription (ref-counted
// across connections) and syncs the union to the companion. Returns
// {host, ok, subscribed} or {host, ok:false, unsupported} for a stale binary (the
// caller leaves the poll path intact) or {host, ok:false, error} on transport
// failure. LOCAL hosts are refused (the companion serves remote hosts only).
// Signature mirrors capturePanes(host, list, cfg, opts, deps) so the test deps
// seam (spawnChannel manifest, etc.) routes through to getChannel. (WARDEN-413)
export async function subscribePanes(host, list, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, error: 'companion transport does not apply to the local host', subscribed: false };
  }
  let sub = paneSubscriptions.get(host);
  if (!sub) { sub = new Map(); paneSubscriptions.set(host, sub); }
  for (const descriptor of describePanes(list)) {
    const existing = sub.get(descriptor.key);
    if (existing) existing.refs++;
    else sub.set(descriptor.key, { descriptor, refs: 1 });
  }
  return syncSubscription(host, cfg, opts, deps);
}

// unsubscribePanes drops a key set's refs (ref-counted: a key leaves the
// subscription only when its LAST monitor closes), then syncs the union. Safe to
// call for a host/key set that was never subscribed (no-op). LOCAL is a no-op.
// Signature mirrors capturePanes(host, list, cfg, opts, deps). (WARDEN-413)
export async function unsubscribePanes(host, keys, cfg = {}, opts = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: true, subscribed: false };
  }
  const sub = paneSubscriptions.get(host);
  if (sub) {
    for (const k of keys || []) {
      const existing = sub.get(k);
      if (existing) {
        existing.refs--;
        if (existing.refs <= 0) sub.delete(k);
      }
    }
    if (sub.size === 0) paneSubscriptions.delete(host);
  }
  return syncSubscription(host, cfg, opts, deps);
}

// _getPaneSubscriptionsForTests exposes the ref-counted subscription state for
// deterministic tests (refcounting + union sync are the multi-tab correctness
// contract). Not for production use.
export function _getPaneSubscriptionsForTests() {
  const out = {};
  for (const [host, sub] of paneSubscriptions.entries()) {
    out[host] = {};
    for (const [k, v] of sub.entries()) out[host][k] = v.refs;
  }
  return out;
}

// _getAgentStateWatchedForTests exposes the TTL-tracked /api/agent-states watched
// set (host -> {key: ms}) so the reconcile contract (subscribe-on-enter,
// unsubscribe-on-leave, TTL eviction) is unit-testable. Not for production use.
export function _getAgentStateWatchedForTests() {
  const out = {};
  for (const [host, watched] of agentStateWatched.entries()) {
    out[host] = {};
    for (const [k, ms] of watched.entries()) out[host][k] = ms;
  }
  return out;
}

// reconcilePaneSubscriptions aligns the companion pane-push subscription for the
// REMOTE companion-enabled hosts in `chats` with what /api/agent-states is polling
// RIGHT NOW: subscribe panes that just entered the polled set, and (via the TTL
// sweep) release panes no poller has requested in a while. This is the WARDEN-413
// production trigger — the path that makes the success measure true: once a
// subscription delivers fresh deltas, capturePanes (chats.js) renders from the
// in-memory cache and SKIPS the per-host capturePanes RPC, so an idle companion
// host receives ZERO capturePanes RPCs per poll. LOCAL + flag-off hosts are
// excluded (their poll path is unchanged).
//
// Ref-counted: each watched key carries exactly one agent-states ref (composable
// with the WS monitor path's refs), so add/remove stay balanced however the polled
// set churns. The TTL makes a stateless HTTP poll multi-tab correct — see
// agentStateWatched. Best-effort: a subscription RPC failure surfaces a clear
// error (CompanionTransportError carries the opt-out hint) but never breaks pane
// rendering — capturePanes keeps polling until a real push arrives.
export async function reconcilePaneSubscriptions(chats, cfg = {}, opts = {}, deps = {}) {
  if (!isCompanionTransportEnabled()) return [];
  const now = opts.now ?? Date.now();
  // Group REMOTE chats by host (LOCAL is excluded — the companion serves remote
  // hosts only, same guard as discover/capturePanes/hasSession). Dedupe by key per
  // host: subscribePanes bumps a ref per descriptor, so a duplicate key would
  // over-count refs and leak (TTL eviction under-decrements). Self-contained —
  // does not rely on the caller deduping.
  const byHost = new Map();
  const seenKey = new Set();
  for (const c of chats || []) {
    if (c.host === LOCAL) continue;
    const dedupe = `${c.host}\0${c.key}`;
    if (seenKey.has(dedupe)) continue;
    seenKey.add(dedupe);
    if (!byHost.has(c.host)) byHost.set(c.host, []);
    byHost.get(c.host).push(c);
  }
  const results = [];
  // Subscribe panes NEWLY entering the polled set; refresh the TTL for every
  // polled pane so a key stays watched while any poller keeps requesting it.
  for (const [host, list] of byHost) {
    let watched = agentStateWatched.get(host);
    if (!watched) { watched = new Map(); agentStateWatched.set(host, watched); }
    const added = [];
    for (const c of list) {
      if (!watched.has(c.key)) added.push(c); // first agent-states watch -> ref++
      watched.set(c.key, now); // refresh TTL
    }
    if (added.length) results.push(subscribePanes(host, added, cfg, opts, deps));
  }
  // TTL sweep across ALL watched hosts (including ones absent from this poll): a
  // key no poller has requested within the TTL is released — its ref-- stops the
  // push for that pane (and the host's subscription empties when its last pane
  // leaves). This request-driven sweep covers the case where SOME pane is still
  // polled; the no-poller-active case (frontend stopped polling entirely once the
  // last pane closed) is covered by the background sweep (startPaneDeltaSweep),
  // which calls this with an empty set on its own timer. (WARDEN-413)
  const hostsToDelete = [];
  for (const [host, watched] of agentStateWatched) {
    const removed = [];
    for (const [k, lastSeen] of watched) if (now - lastSeen > AGENT_STATE_TTL_MS) removed.push(k);
    for (const k of removed) {
      watched.delete(k);
      results.push(unsubscribePanes(host, [k], cfg, opts, deps));
    }
    if (watched.size === 0) hostsToDelete.push(host);
  }
  for (const h of hostsToDelete) agentStateWatched.delete(h);
  return Promise.all(results);
}

// ----------------------- background TTL sweep (WARDEN-413) --------------------
// reconcilePaneSubscriptions is request-driven: it runs when /api/agent-states
// polls. But when the last pane closes, the frontend stops polling ENTIRELY
// (useAttentionRollup returns before the fetch once the open∪watched union is
// empty) and the handler short-circuits on an empty polled set BEFORE reconcile.
// So the request-driven TTL sweep never fires, and every previously-subscribed
// pane would keep being re-captured by its companion at 1Hz FOREVER — the
// optimization inverting on the exact "user walked away" fleet it protects.
//
// This background sweep closes that leak: on its OWN timer, decoupled from any
// request, it calls reconcilePaneSubscriptions([]) — an EMPTY polled set, so the
// "subscribe newly-entered" pass is a no-op but the TTL sweep across ALL watched
// hosts still runs, releasing stale keys via unsubscribePanes. Idempotent (one
// timer per process); the timer is unref'd so it never keeps the event loop alive
// on its own. Flag off -> no timer (self-gated, so the call site in startServer is
// unconditional). `opts.interval` is for tests; production uses the TTL cadence.
export function startPaneDeltaSweep(cfg = {}, opts = {}, deps = {}) {
  if (paneDeltaSweepTimer) return paneDeltaSweepTimer;
  if (!isCompanionTransportEnabled()) return null;
  const interval = opts.interval ?? AGENT_STATE_TTL_MS;
  const tick = () => { reconcilePaneSubscriptions([], cfg, {}, deps).catch(() => {}); };
  paneDeltaSweepTimer = setInterval(tick, interval);
  if (typeof paneDeltaSweepTimer.unref === 'function') paneDeltaSweepTimer.unref();
  return paneDeltaSweepTimer;
}

// Test-only: clear the background sweep timer (and reset the idempotency guard) so
// a real interval never bleeds across describe blocks.
export function _stopPaneDeltaSweepForTests() {
  if (paneDeltaSweepTimer) { clearInterval(paneDeltaSweepTimer); paneDeltaSweepTimer = null; }
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
