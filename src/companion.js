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
// SSH_BASE_OPTS is no longer imported here: buildSshArgv applies it (WARDEN-989).
import { run as defaultRun, SSH_BIN, buildSshArgv, shellQuote } from './ssh.js';
import { buildChat, sortChats, parseActivityTimestamp, paneTarget } from './chatMeta.js';
import { loopMonitor } from './loop-monitor.js';

const LOCAL = '(local)';
const COMPANION_DIR = '$HOME/.warden'; // expands on the remote host
// The LOCAL-refusal message every companion client op returns — one constant so
// the text cannot drift between ops (WARDEN-1253). The ENVELOPE carrying it is
// NOT shared: five distinct refusal shapes exist across the ops, and each op
// still builds its own (see companionOp below).
const LOCAL_REFUSAL = 'companion transport does not apply to the local host';

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

// Remove the binary from the host — the precise mirror of buildUploadScript
// (WARDEN-882, the Removability outcome of roadmap WARDEN-270). Best-effort,
// never-fatal ordering so a partial state (no process to kill, no binary to
// remove, a non-empty ~/.warden) still exits 0:
//   1. `pkill -f` any running companion process so a warden-crash-orphaned
//      binary doesn't survive removal (the Go companion has no self-uninstall
//      RPC, and the process is otherwise reachable only via the ssh child warden
//      is about to kill — companion/main.go speaks only over the SSH channel);
//   2. `rm -f` the binary itself;
//   3. `rmdir ~/.warden` ONLY if empty — NEVER clobber a user's other files.
// `version` is validated hex from the manifest (safe to interpolate) and
// `$HOME` is left literal so it expands on the host — the same convention
// buildProbeScript / buildUploadScript follow. The three steps are `;`-joined
// (not `&&`-joined): each is independently best-effort, so a missing process or
// a kept ~/.warden does not short-circuit the `rm -f` that does the real work.
//
// WHY pkill matches the FULL path, not the basename: pkill -f matches its
// pattern against every process's FULL command line, including the very shell
// executing this script (the remote `bash -lc '<this script>'` wrapper — its
// argv carries the literal script text). A basename pattern `companion-<ver>`
// appears verbatim in that wrapper's argv, so pkill would SIGTERM the wrapper
// itself before `rm -f` ever ran — the script would kill its own shell and the
// binary would survive. Matching the `$HOME`-relative path avoids this: the
// subshell EXPANDS `$HOME` → `/home/.../companion-<ver>` before calling pkill,
// so pkill searches for the expanded absolute path. The running companion's
// cmdline carries that expanded path (match), but the wrapper shell's argv
// keeps `$HOME` literal (no self-match). This is the same kill-by-pattern
// self-match hazard that makes `pkill -f <literal>` dangerous locally.
export function buildUninstallScript(remotePath) {
  return `pkill -f "${remotePath}" 2>/dev/null || true; rm -f "${remotePath}"; rmdir "${COMPANION_DIR}" 2>/dev/null || true`;
}

// Reap SUPERSEDED companion-* binaries on the bootstrap upgrade path (WARDEN-904).
// A version bump uploads companion-<newver> but historically left the orphaned
// companion-<oldver> behind, leaking a multi-MB static Go binary per host per
// upgrade. This runs AFTER the channel is verified via ping (the live
// companion-<manifest.version> is in use), so reaping a superseded sibling can
// never rip out the binary the running channel fronts.
//
// Targets ONLY non-current companion-* siblings in $HOME/.warden and NEVER the
// current path: the for-loop globs the dir's companion-* entries, skips anything
// that isn't a regular file ([ -f ]), skips the current path ([ != ]), and rm -f's
// the rest. Files not matching companion-* (a user's ~/.warden contents) are never
// iterated, so they are untouched. `$HOME` stays double-quoted so it expands on
// the host in BOTH the glob and the current-path comparison (so an expanded `$f`
// compares against the expanded current path — the current binary always excludes
// itself); the version is validated hex so the interpolated current path is safe.
// The trailing `; true` keeps the script exit 0 even when the glob matches nothing
// or the last loop body short-circuits — the bootstrap caller treats the reap as
// best-effort regardless (a reap failure is NEVER fatal to a successful bring-up).
export function buildReapScript(currentRemotePath) {
  return `for f in "${COMPANION_DIR}"/companion-*; do [ -f "$f" ] && [ "$f" != "${currentRemotePath}" ] && rm -f "$f"; done; true`;
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

// Format the actionable message a thrown channel error carries — the ONE place
// the op sites (discover/capturePanes/hasSession/…) get their error text: a
// CompanionTransportError's message plus its recovery hint (how to return to the
// default SSH path), an RPC error's message, or a generic fallback naming the op.
// Centralised so the WARDEN-878 status surface shows byte-identical text to the
// op contracts (a failed host's tooltip and the op's thrown error read the same).
//
// `op` names the operation in the generic fallback — the ONLY thing that varied
// across the seven hand-rolled ladders this helper replaced (WARDEN-933). It
// defaults to the literal 'op' for the callers that are not a single named
// operation (the bootstrap status capture, and mapCmdError's best-effort
// envelope), preserving their `companion op failed on <host>` text verbatim.
// (WARDEN-878, WARDEN-933)
function formatCompanionError(host, e, op = 'op') {
  if (e instanceof CompanionTransportError) {
    // Surface the actionable recovery hint (opt-out env var) so the user knows
    // exactly how to return to the default SSH path — no silent fallback.
    return e.message + (e.recovery ? ` ${e.recovery}` : '');
  }
  if (e instanceof CompanionRpcError) {
    return e.message;
  }
  return `companion ${op} failed on ${host}: ${e?.message ?? e}`;
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
    // WARDEN-1295: a live attach is a STREAM, not a pending request — it has no
    // entry in `pending`, so the loop above cannot tell it the channel died and
    // its pane would spin forever on a companion that is already gone. Dead
    // handlers are how a stream learns; each one is best-effort so a throwing
    // consumer can't stop the rest from being notified.
    const handlers = this._deadHandlers || [];
    this._deadHandlers = [];
    for (const cb of handlers) {
      try { cb(err); } catch { /* a dead-handler throw must not break teardown */ }
    }
  }

  // Register a callback for channel death (WARDEN-1295). Fires immediately if the
  // channel is ALREADY dead — a stream that registers late must still learn,
  // otherwise it hangs on a death it merely missed. Handlers fire at most once.
  onDead(cb) {
    if (this.dead) {
      try { cb(this._diedWith); } catch { /* noop */ }
      return;
    }
    (this._deadHandlers ||= []).push(cb);
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
// Exported (alongside streamFileToHost below) so the two `child.stdin` write
// sites can be driven directly by a test with an injected `spawnFn` — the
// mid-write EPIPE race in WARDEN-983 is unreachable through the fakeDeps()
// bootstrap harness, which stubs both legs out.
export function spawnPersistentChannel(host, remotePath, cfg, spawnFn) {
  // argv (including the `--` separator before the host) comes from ssh.js's
  // buildSshArgv, so this site is covered by the same invariant as every other
  // ssh transport even though it spawns directly rather than via run()
  // (WARDEN-969 could not reach it; WARDEN-979 patched it by hand; WARDEN-989
  // routed it through the builder).
  const args = buildSshArgv(host, {
    opts: ['-o', `ConnectTimeout=${cfg.connectTimeout ?? 10}`],
    command: remotePath,
  });
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
  // `child.stdin` is its OWN Socket emitter, and an 'error' event with no listener
  // THROWS — killing the whole warden server, mid-request. The try/catch in write()
  // below does NOT cover this: it catches only a *synchronous* throw (e.g.
  // ERR_STREAM_DESTROYED). An EPIPE from ssh dying while a write is in flight
  // surfaces ASYNCHRONOUSLY as an 'error' event here, outside that try block
  // entirely. Route it through onExit so it tears the channel down as an ordinary
  // transport death (CompanionTransportError, which every caller already handles).
  // Both guards are needed — sync and async are different paths. (WARDEN-983.)
  child.stdin.on('error', (e) => onExit(new Error(`stdin write failed: ${e.message}`)));
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

// How long streamFileToHost's 'exit' waits for 'close' before settling on its
// own. See the hang guard in that function for why this exists and why it is
// generous. Exported so its test asserts against the real value rather than
// hard-coding a sleep.
export const UPLOAD_CLOSE_GRACE_MS = 1000;

// Stream the bundled binary to the host over ssh stdin (the VS Code Remote-SSH
// model). Returns { ok, code, stderr }. The binary is only ever exec'd on the
// REMOTE host after this upload, never locally.
// Exported for the WARDEN-983 stdin-EPIPE guard — see spawnPersistentChannel.
//
// Known, deliberate exception to the WARDEN-464 'close'-not-'exit' discipline
// this function now follows: `ensureControlMaster` (src/ssh.js:139) also
// accumulates stderr and returns it through the same degrading
// `${stderr || `exit ${code}`}` idiom, but it must STAY on 'exit'. It starts a
// persistent `-N` ControlMaster with ControlPersist=10m and resolves
// `{ ..., process: child }` on success; the backgrounded master can hold its
// stdio open indefinitely, so 'close' may never fire and converting it would
// risk wedging the whole connection pool — far worse than a degraded message on
// its failure leg.
export function streamFileToHost(host, localBinaryPath, remotePath, cfg, spawnFn) {
  const cmd = buildUploadScript(remotePath);
  // argv from ssh.js's buildSshArgv — see spawnPersistentChannel above.
  const args = buildSshArgv(host, {
    opts: ['-o', `ConnectTimeout=${cfg.connectTimeout ?? 10}`],
    command: `bash -lc ${shellQuote(cmd)}`,
  });
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
    let graceTimer = null;
    const done = (r) => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (!resolved) { resolved = true; resolve(r); }
    };
    const stream = fs.createReadStream(localBinaryPath);
    stream.on('error', (e) => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      done({ ok: false, code: -1, stderr: `read binary failed: ${e.message}` });
    });
    child.on('error', (e) => done({ ok: false, code: -1, stderr: String(e) }));
    // setEncoding('utf8') before the 'data' listener (WARDEN-1045): accumulating
    // Buffers with `+=` decodes each chunk in isolation, so a multibyte character
    // split across a read boundary is destroyed. Additive consistency only — this
    // stderr carries short ssh diagnostics, well under the 64KB pipe buffer — but
    // the idiom must not diverge between the spawn-and-collect siblings.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    // Drain stdout. 'close' waits for ALL stdio to close, and this function never
    // reads child.stdout — an unconsumed pipe fills its buffer and stalls the
    // child (and therefore the close we now resolve on). Same reason sshControl
    // resumes the streams it ignores (src/ssh.js:90-91).
    if (child.stdout) child.stdout.resume();
    // 'close' (NOT 'exit') — this resolver ACCUMULATES stderr and RETURNS it, and
    // that stderr is the ONLY diagnostic a user gets when a host fails to provision
    // (bootstrapChannel's `upload failed: ${stderr || `ssh exited ${code}`}` — the
    // `||` means a truncated stderr does not error, it silently degrades the real
    // cause, e.g. "No space left on device", to a bare "ssh exited 1"). 'exit'
    // fires BEFORE the stdio pipes drain, so it can capture a truncated or empty
    // tail; 'close' fires only after they drain. The race is wide here because we
    // pipe ~2.1MB through child.stdin, saturating the loop in exactly the window
    // the child exits and its stderr tail must drain. Same class as WARDEN-464/766
    // (ssh.js run(), runLocalCapture, gitRoutes) — 'close' passes the same `code`,
    // so the {ok, code, stderr} contract is unchanged; only stderr gets completer.
    child.on('close', (code) => {
      stream.destroy();
      done({ ok: code === 0, code: code ?? -1, stderr });
    });
    // Hang guard. 'close' requires every stdio stream to close; a child whose
    // stdio is held open (inherited by a grandchild, a wedged pipe) would leave a
    // promise that resolves TODAY pending forever. So 'exit' — which we no longer
    // resolve on — arms a bounded grace instead: if 'close' has not landed within
    // it, settle with whatever stderr drained. 'close' clears the timer, and both
    // paths funnel through the idempotent done(), so whichever lands first wins
    // and the other no-ops. The grace is ~1000x a real drain (microseconds), so in
    // practice 'close' always wins; when it doesn't, the result is today's
    // possibly-truncated stderr — never worse than the status quo, never a hang.
    // NOT unref'd: this timer is the only thing keeping the promise alive on that
    // path, and an unref'd one would let node exit with the upload unsettled.
    child.on('exit', (code) => {
      if (resolved) return;
      stream.destroy();
      graceTimer = setTimeout(() => {
        graceTimer = null;
        done({ ok: code === 0, code: code ?? -1, stderr });
      }, UPLOAD_CLOSE_GRACE_MS);
    });
    // `child.stdin` is its own Socket emitter and an unlistened 'error' THROWS —
    // process death, taking the warden server with it. The pipe below streams
    // ~2.1MB, so the window where ssh can die mid-write (EPIPE, delivered
    // ASYNCHRONOUSLY as this event) is wide. `child.on('error')` above does NOT
    // cover it: that fires for spawn failures, not for writes to the child's pipe.
    // Route it through the idempotent done() so the upload resolves as a failed
    // upload; whichever of stdin-error / exit lands first wins, the other no-ops.
    // (WARDEN-983.)
    // APPEND the accumulated remote stderr, never replace it (WARDEN-1018). When
    // the remote dies mid-upload (disk full, mkdir/auth failure) it stops reading
    // while ~2.1MB is still piped, so the write EPIPEs — and because child.stdin
    // is one of the stdio streams 'close' waits on, THIS handler necessarily runs
    // before 'close' and wins deterministically. Reporting only the local symptom
    // ("write EPIPE") would therefore discard the remote cause on the DOMINANT
    // failure leg, exactly the diagnostic the 'close' comment above calls "the
    // ONLY diagnostic a user gets when a host fails to provision".
    // Additive by construction: with an empty accumulator the message is
    // byte-identical to the pre-WARDEN-1018 one, so no path can regress.
    // NOT solved by arming the UPLOAD_CLOSE_GRACE_MS timer here so 'close' wins
    // with complete stderr — that reds companion.test.js:1864, which requires the
    // stdin path (not the exit path) to produce this result.
    // Caveat, deliberately not oversold: stdin's 'error' precedes the stderr
    // pipe's full drain, so this recovers what has DRAINED SO FAR, not a
    // guaranteed-complete remote message. Strictly better than discarding it.
    child.stdin.on('error', (e) => {
      stream.destroy();
      const remote = stderr.trim();
      done({
        ok: false,
        code: -1,
        stderr: `upload stdin failed: ${e.message}${remote ? ` — remote said: ${remote}` : ''}`,
      });
    });
    stream.pipe(child.stdin);
  });
}

// ------------------------------- bootstrap ----------------------------------

const channelCache = new Map(); // host -> CompanionChannel

// --------------------- per-host transport status (WARDEN-878) --------------------
// WARDEN-270 Visibility: the human must be able to see, per host, whether the
// companion transport is working — active (with version), bootstrapping, or
// errored (with the actionable last error). Per-host state lives ONLY in the
// in-memory channelCache while healthy and in THROWN errors when it isn't, so it
// is nowhere a human can read. Worse, getChannel deletes the cache entry on
// bootstrap FAILURE (the .catch below), so an ERRORED host leaves NO cache entry:
// last error/state CANNOT be derived by reading the cache — an approach that
// "reads the cache, finds nothing for the hosts that most need a status" ships a
// no-op. This map captures state at the transition sites (bootstrapping → active
// | error) so a failed host shows its error instead of silently reading "no
// companion."
//
//   state: 'active'        — channel live; version = the ping-verified manifest version
//        | 'bootstrapping' — a bootstrap promise is in flight
//        | 'error'         — last bootstrap threw; lastError = actionable message
//        | 'inactive'      — toggle off, LOCAL, or no op has engaged the host yet
const companionStatus = new Map(); // host -> { state, version?, lastError?, lastErrorAt? }

// Module-private writer; the only writers that SET a status are the getChannel
// bootstrap transitions (bootstrapping/active/error) below. Kept narrow so all
// status mutation funnels through one place the reachability trace can reason
// about. Two places INVALIDATE instead of setting, by deleting the entry so
// getCompanionStatus falls back to {state:'inactive'}: uninstallCompanion (the
// host's companion was just removed — WARDEN-882) and
// _resetChannelCacheForTests (whole-map clear).
function setCompanionStatus(host, status) {
  companionStatus.set(host, status);
}

// Read one host's companion transport status — the single source the API layer
// surfaces on /api/hosts/status. Returns {state:'inactive'} when the transport is
// disabled (toggle off), for LOCAL (the companion is remote-only), or for a host
// no companion op has engaged yet, so a reader never mistakes "not applicable /
// not yet" for an error. (WARDEN-878)
export function getCompanionStatus(host) {
  if (!isCompanionTransportEnabled()) return { state: 'inactive' };
  if (host === LOCAL) return { state: 'inactive' };
  return companionStatus.get(host) ?? { state: 'inactive' };
}

// Read every host's status (host -> status object). Empty when the transport is
// disabled (the toggle check short-circuits, so stale entries from a prior
// enabled-window never leak out while off). (WARDEN-878)
export function getAllCompanionStatuses() {
  if (!isCompanionTransportEnabled()) return {};
  const out = {};
  for (const [host, status] of companionStatus) out[host] = status;
  return out;
}

export function _resetChannelCacheForTests() {
  for (const ch of channelCache.values()) {
    try { if (ch && typeof ch.kill === 'function') ch.kill(); } catch { /* noop */ }
  }
  channelCache.clear();
  companionStatus.clear(); // WARDEN-878: clear captured per-host status too
}

// Test-only: whether a host currently has a cached channel/bootstrap — so
// uninstallCompanion's "tear down the cache entry FIRST" contract (kill + delete
// BEFORE the uninstall script runs) is unit-testable. Not for production use.
export function _channelCacheHasForTests(host) {
  return channelCache.has(host);
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
//  4. reap superseded companion-* binaries left by a prior version bump (WARDEN-904)
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
  // Both success paths (first ping ok, or mismatch → re-upload → re-ping ok)
  // converge on `liveChannel` so the reap below runs once, AFTER the channel is
  // verified, regardless of which path brought it up.
  const channel = new CompanionChannel(host, spawnChannelFn(host, remotePath, cfg));
  const ping = await pingOnce(channel, manifest.version, cfg);
  let liveChannel;
  if (ping.ok) {
    liveChannel = channel;
  } else {
    channel.kill();
    if (ping.reason === 'mismatch' && !didUpload) {
      const up = await uploadFn(host, binaryPath, remotePath, cfg);
      if (!up.ok) {
        throw new CompanionTransportError(host,
          `re-upload of stale companion failed: ${(up.stderr || '').trim() || `ssh exited ${up.code}`}`);
      }
      didUpload = true;
      const channel2 = new CompanionChannel(host, spawnChannelFn(host, remotePath, cfg));
      const ping2 = await pingOnce(channel2, manifest.version, cfg);
      if (ping2.ok) {
        liveChannel = channel2;
      } else {
        channel2.kill();
        throw new CompanionTransportError(host, ping2.reason === 'mismatch'
          ? `companion on host reports version '${ping2.got}' after re-upload; expected '${manifest.version}'`
          : `companion did not respond after re-upload: ${ping2.err?.message ?? ping2.err}`);
      }
    } else {
      throw new CompanionTransportError(host, ping.reason === 'mismatch'
        ? `companion on host reports version '${ping.got}'; expected '${manifest.version}'. The cached binary is stale — remove ${remotePath} on the host and retry.`
        : `companion bootstrap uploaded the binary but the process did not respond to ping: ${ping.err?.message ?? ping.err}.`);
    }
  }

  // 4. Reap superseded companion-* binaries (WARDEN-904). The channel is now
  // verified via ping, so the live companion-<manifest.version> is in use and is
  // NEVER a reap target (buildReapScript excludes the current path). Gated on
  // didUpload — a same-version re-bootstrap (HAVE=1) installs nothing, so it reaps
  // nothing and pays no extra ssh round-trip (a true no-op); the reap fires only
  // when a binary was just installed/upgraded, which is exactly when an orphaned
  // companion-<oldver> may exist. Best-effort: a reap failure is NEVER fatal to an
  // otherwise-successful channel bring-up (the channel is already live).
  if (didUpload) {
    try {
      await runFn(host, buildReapScript(remotePath), { timeout: connectMs + 5000 }, cfg);
    } catch {
      // Swallow: reaping is best-effort hygiene, not part of the channel contract.
    }
  }
  return liveChannel;
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
  // WARDEN-878: mark bootstrapping BEFORE the promise is created so the host
  // reads "bootstrapping" (not "inactive") on the status surface while the first
  // channel comes up. getChannel runs this body synchronously through to the
  // cache set below, so a concurrent caller sees the in-flight promise (above)
  // and never re-sets this.
  setCompanionStatus(host, { state: 'bootstrapping' });
  const bootstrapPromise = bootstrapChannel(host, cfg, deps)
    .then((channel) => {
      channelCache.set(host, channel);
      // WARDEN-878: successful bootstrap → active + the version the ping just
      // verified. pingOnce confirms the host's companion reports manifest.version,
      // so the active version IS the manifest version (deps.manifest when a test
      // overrode it, else the cached real manifest — safe to read because a
      // successful bootstrap just loaded and cached it).
      const version = deps.manifest?.version ?? loadManifest().version;
      setCompanionStatus(host, { state: 'active', version });
      return channel;
    })
    .catch((err) => {
      if (channelCache.get(host) === bootstrapPromise) channelCache.delete(host);
      // WARDEN-878 (THE TRAP): channelCache.delete above means an errored host
      // leaves NO cache entry — reading the cache alone would show "no companion"
      // for exactly the hosts that most need a status. Capture the error at the
      // failure site instead, surfacing the same actionable message + recovery
      // hint the op contracts build.
      setCompanionStatus(host, {
        state: 'error',
        lastError: formatCompanionError(host, err),
        lastErrorAt: Date.now(),
      });
      throw err;
    });
  channelCache.set(host, bootstrapPromise);
  return bootstrapPromise;
}

// --------------------------------- uninstall ---------------------------------
// WARDEN-882 (Removability outcome of roadmap WARDEN-270). The mirror of
// bootstrap: where bootstrap installs ~/.warden/companion-<ver> over the raw
// ssh path, uninstall takes it off. The human can cleanly remove warden's
// auto-bootstrapped companion from any remote host on request — "nothing gets
// installed that can't be taken off" (the roadmap's Removability bar) becomes
// literally true.
//
// Companion-or-fail: returns the raw {host, ok, code, stderr} (the same shape
// the probe / streamFileToHost return) so the caller surfaces what failed; it
// NEVER falls back to raw SSH (the experimental path's contract is unchanged).
// No new network port — the op rides the same `ssh host 'bash -lc …'` path the
// probe uses (companion.js), not streamFileToHost (this is a command, not a
// binary stream). No root; the host runtime footprint removed is JUST the
// binary (companion/main.go opens no listening socket, writes no pid file).

// uninstallCompanion(host) tears down the host's cached ssh child FIRST (so the
// binary isn't busy when rm runs — the single-host analogue of
// _resetChannelCacheForTests), then runs buildUninstallScript over the same
// runFn/defaultRun path the probe uses. ~/.warden is removed only-if-empty.
// LOCAL is refused (the companion serves remote hosts only). `deps.run` /
// `deps.manifest` are the same test seam bootstrap uses (deps.run ?? defaultRun).
export async function uninstallCompanion(host, cfg = {}, deps = {}) {
  if (host === LOCAL) {
    return { host, ok: false, code: -1, stderr: 'companion transport does not apply to the local host' };
  }
  // Tear down the host's channel cache entry FIRST — SIGTERM the cached ssh
  // child (and the companion process it fronts) so the binary file isn't busy
  // when rm runs. A never-bootstrapped host simply has no entry to delete; an
  // in-flight bootstrap Promise has no kill() and is dropped from the cache.
  const ch = channelCache.get(host);
  if (ch && typeof ch.kill === 'function') {
    try { ch.kill(); } catch { /* noop — a dead channel is fine */ }
  }
  channelCache.delete(host);
  // Invalidate the captured per-host status too (WARDEN-878's companionStatus
  // map). channelCache.delete alone is NOT enough: companionStatus is written
  // only at getChannel's bootstrap transitions, so a dead/removed channel
  // leaves the last {state:'active', version} behind, and /api/hosts/status →
  // getCompanionStatus → the host row's CompanionIndicator would keep showing
  // "active" after a successful removal — the confirmation surface lying about
  // whether the uninstall worked (success criterion 3). Deleting is the right
  // reset: getCompanionStatus falls back to {state:'inactive'}, i.e. "companion
  // absent". This mirrors _resetChannelCacheForTests, which clears BOTH maps.
  companionStatus.delete(host);
  // Resolve the manifest version → remote path (companion.js:116) and run the
  // uninstall script via the same runFn/defaultRun path the probe uses. The
  // version is validated hex, safe to interpolate.
  const runFn = deps.run ?? defaultRun;
  const manifest = deps.manifest ?? loadManifest();
  const remotePath = remoteBinaryPath(manifest.version);
  try {
    const res = await runFn(host, buildUninstallScript(remotePath), {}, cfg);
    return {
      host,
      ok: !!res?.ok,
      code: typeof res?.code === 'number' ? res.code : (res?.ok ? 0 : -1),
      stderr: res?.stderr || '',
    };
  } catch (e) {
    // runFn is the raw ssh helper; a throw is a transport failure (e.g. spawn
    // error). Encode it as ok:false rather than propagating so the
    // companion-or-fail contract stays in the return shape, not thrown.
    return { host, ok: false, code: -1, stderr: e?.message ?? String(e) };
  }
}

// --------------------------- the shared op skeleton ---------------------------
// WARDEN-1253: the ONE place the companion client-op skeleton lives. Eight ops
// (discover, capturePanes, hasSession, spawnSession, killSession, resize, send,
// sendKey) run the identical four steps — refuse when the target is LOCAL,
// acquire the bootstrapped+cached channel, make the call, catch ANY failure
// into an envelope (companion-or-fail: NEVER a raw-SSH fallback). The skeleton
// used to be hand-copied into all eight, which is why WARDEN-933's one
// catch-body change had to be edited in lockstep across seven of them.
//
// Each op supplies exactly what genuinely differs — nothing about the envelope
// shapes is unified here:
//
//   refuse()  the LOCAL refusal envelope. Five distinct forms exist across the
//             eight ({error, chats:[]}, {error, panes:{}}, {error, exists:
//             false}, bare {error}, and the raw runTmux {code, stdout, stderr}
//             family); each op builds its own because callers pin the exact
//             shape they read (chats.js, tmux.js, server.js).
//   run(ch)   the payload + channel.call(s) + result mapping. Runs INSIDE the
//             try, so a payload/mapping throw is enveloped exactly as before;
//             send/sendKey consult channelMethods for the stale-binary gate
//             here, before their call.
//   fail(e)   the thrown-error envelope: the {error} ops format with the op
//             name; the raw-shape family (resize/send/sendKey) maps through
//             mapCmdError, which deliberately OMITS the op name (WARDEN-933).
async function companionOp(host, cfg, deps, { refuse, run, fail }) {
  if (host === LOCAL) return refuse();
  try {
    const channel = await getChannel(host, cfg, deps);
    return await run(channel);
  } catch (e) {
    return fail(e);
  }
}

// --------------------------------- discover ---------------------------------

// discover() over the companion channel. Returns the same { host, ok, chats } /
// { host, ok:false, error, chats:[] } contract as chats.js discover(). On ANY
// failure it returns { ok:false } with an actionable error — it NEVER falls back
// to raw SSH (the experimental path's contract; opt out via the env var).
export async function discover(host, cfg = {}, opts = {}, deps = {}) {
  return companionOp(host, cfg, deps, {
    refuse: () => ({ host, ok: false, error: LOCAL_REFUSAL, chats: [] }),
    run: async (channel) => {
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
    },
    // {error}-family envelope: the op name rides the formatted message.
    fail: (e) => ({ host, ok: false, error: formatCompanionError(host, e, 'discover'), chats: [] }),
  });
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
  return companionOp(host, cfg, deps, {
    refuse: () => ({ host, ok: false, error: LOCAL_REFUSAL, panes: {} }),
    run: async (channel) => {
      // Send the per-host pane list. `container` is null for bare-tmux / manual
      // chats so the companion selects bare `tmux` (vs `docker exec <c> tmux`).
      const panes = describePanes(list);
      const result = await channel.call('capturePanes', { panes }, { timeout: opts.timeout ?? 15000 });
      return { host, ok: true, panes: (result && result.panes) || {} };
    },
    fail: (e) => ({ host, ok: false, error: formatCompanionError(host, e, 'capturePanes'), panes: {} }),
  });
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
  return companionOp(host, cfg, deps, {
    refuse: () => ({ host, ok: false, error: LOCAL_REFUSAL, exists: false }),
    run: async (channel) => {
      // `container` is null for bare-tmux / manual chats so the companion selects
      // bare `tmux`.
      const target = paneTarget(session, container);
      const result = await channel.call('hasSession', { container: container || null, session: target }, { timeout: opts.timeout ?? 10000 });
      return { host, ok: true, exists: !!(result && result.exists) };
    },
    // The one {error}-family envelope with an extra computed field: `transport`
    // flags a CompanionTransportError so tmux.js maps it to 'host_unreachable'
    // rather than 'session_dead'. Absent from the refusal above, as ever.
    fail: (e) => ({
      host,
      ok: false,
      transport: e instanceof CompanionTransportError,
      error: formatCompanionError(host, e, 'hasSession'),
      exists: false,
    }),
  });
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
  return companionOp(host, cfg, deps, {
    refuse: () => ({ host, ok: false, error: LOCAL_REFUSAL }),
    run: async (channel) => {
      const payload = {
        container: params?.container || null,
        session: paneTarget(params?.session, params?.container),
        cwd: params?.cwd || '',
        cmd: Array.isArray(params?.cmd) ? params.cmd : [],
      };
      await channel.call('spawnSession', payload, { timeout: opts.timeout ?? 30000 });
      return { host, ok: true };
    },
    fail: (e) => ({ host, ok: false, error: formatCompanionError(host, e, 'spawnSession') }),
  });
}

// killSession() over the companion channel — the DESTROY half of the agent
// lifecycle. Returns { host, ok } / { host, ok:false, error }, companion-or-fail
// (never falls back to raw SSH). kill is IDEMPOTENT / best-effort: the host-side
// RPC surfaces "session not found" / "no server running" as a benign ok (the
// session is already gone — exactly what the caller wanted), so /api/kill's
// existing best-effort semantics are preserved. Mirrors capturePanes' shape.
export async function killSession(host, params, cfg = {}, opts = {}, deps = {}) {
  return companionOp(host, cfg, deps, {
    refuse: () => ({ host, ok: false, error: LOCAL_REFUSAL }),
    run: async (channel) => {
      const payload = {
        container: params?.container || null,
        session: paneTarget(params?.session, params?.container),
      };
      await channel.call('killSession', payload, { timeout: opts.timeout ?? 15000 });
      return { host, ok: true };
    },
    fail: (e) => ({ host, ok: false, error: formatCompanionError(host, e, 'killSession') }),
  });
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
  // No op name: the generic `companion op failed on <host>` default is this
  // envelope's long-standing text (resize and friends share one best-effort
  // mapper rather than naming a single op). (WARDEN-933)
  return { host, ok: false, code: -1, stdout: '', stderr: formatCompanionError(host, e) };
}

// The LOCAL refusal for the raw-shape family (resize/send/sendKey): the exact
// envelope mapCmdError produces — {ok:false, code:-1, stdout:''} with the
// message on stderr — carrying the standard local-refusal text. Shared across
// the family exactly like mapCmdError itself; deliberately NOT shared with the
// {error}-family ops (a different envelope). (WARDEN-1253)
function mapCmdLocalRefusal(host) {
  return { host, ok: false, code: -1, stdout: '', stderr: LOCAL_REFUSAL };
}

// resize() over the companion channel: runs `set-option -t <target> window-size
// latest` host-side. Returns {host, ok, code, stdout, stderr} (the raw runTmux
// shape) or {host, ok:false, code:-1, stderr} on ANY failure — it NEVER falls back
// to raw SSH. `container` is null for bare-tmux / manual chats so the companion
// selects bare `tmux`.
export async function resize(host, { container, session } = {}, cfg = {}, opts = {}, deps = {}) {
  return companionOp(host, cfg, deps, {
    // Raw-shape family: the refusal rides stderr (the runTmux envelope), NOT an
    // `error` field.
    refuse: () => mapCmdLocalRefusal(host),
    run: async (channel) => {
      const target = paneTarget(session, container);
      const result = await channel.call('resize', { container: container || null, session: target }, { timeout: opts.timeout ?? 10000 });
      return mapCmdResult(host, result);
    },
    fail: (e) => mapCmdError(host, e),
  });
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
// JSON param and shell-quoted HOST-SIDE (never interpolated raw).
export async function send(host, { container, session, text } = {}, cfg = {}, opts = {}, deps = {}) {
  return companionOp(host, cfg, deps, {
    refuse: () => mapCmdLocalRefusal(host),
    run: async (channel) => {
      const methods = await channelMethods(channel, opts);
      if (!methods.includes('send')) {
        // Stale cached binary (predates WARDEN-888): degrade to runTmux. The channel
        // is alive (getChannel succeeded); only the binary lacks the `send` RPC.
        return { host, unsupported: true };
      }
      const target = paneTarget(session, container);
      const result = await channel.call('send', {
        container: container || null,
        session: target,
        text: text == null ? '' : String(text),
      }, { timeout: opts.timeout ?? 15000 });
      return mapCmdResult(host, result);
    },
    fail: (e) => mapCmdError(host, e),
  });
}

// sendKey() over the companion channel: runs `send-keys -t <target> <key>` for a
// key the caller ALREADY validated against ALLOWED_KEYS (the trust boundary stays
// JS-side, identical to the default sendKey path). Mirrors send's shape + stale-
// binary degradation.
export async function sendKey(host, { container, session, key } = {}, cfg = {}, opts = {}, deps = {}) {
  return companionOp(host, cfg, deps, {
    refuse: () => mapCmdLocalRefusal(host),
    run: async (channel) => {
      const methods = await channelMethods(channel, opts);
      if (!methods.includes('sendKeys')) {
        return { host, unsupported: true };
      }
      const target = paneTarget(session, container);
      const result = await channel.call('sendKeys', {
        container: container || null,
        session: target,
        key,
      }, { timeout: opts.timeout ?? 15000 });
      return mapCmdResult(host, result);
    },
    fail: (e) => mapCmdError(host, e),
  });
}

// --------------------------------- exec ---------------------------------------
// WARDEN-1261 (the git/file domain slice of roadmap WARDEN-270). The chat-scoped
// script domain — runGit + runInContext in src/gitRoutes.js, i.e. the entire git
// surface (15 /api/git-* routes + /api/cross-agent-diff) plus the search-files
// remote leg — still paid a raw, UN-POOLED per-op ssh connection per probe. This
// ONE generic client op serves that whole domain over the persistent channel:
// the CALLER keeps assembling the script (quoting, `2>/dev/null` suffixes,
// WARDEN-1234 containment fragments all live JS-side, preserved verbatim), and
// the host side merely executes it (companion `exec` RPC).
//
// Returns the SAME raw {host, ok, code, stdout, stderr} shape resize/send/
// sendKey produce, so runGit/runInContext callers read `.stdout`/`.ok` exactly
// as they read run()'s result today — ZERO parser changes. Companion-or-fail:
// NEVER falls back to raw SSH (opt out via WARDEN_COMPANION_TRANSPORT).
//
// Unlike send/sendKey there is NO stale-binary graceful degradation: the git
// surface is a polled FAN (8 probes/agent per Fleet Health view), and a silent
// per-op fallback would quietly re-pay every handshake this slice removes while
// the toggle reads "on". A live channel whose binary predates `exec` therefore
// gets the ACTIONABLE too-old error (the WARDEN-933 discipline: the message
// tells the user how to recover), riding stderr like every other raw-shape
// failure. (The bootstrap's version check already replaces a stale cached
// binary in the normal case; this gate covers a live channel whose advertised
// methods lag.)

// The margin added to timeoutMs for the JS-side channel.call deadline. The
// HOST-side kill (exec.CommandContext, armed at timeoutMs by the Go exec RPC) is
// the PRIMARY deadline — it terminates the host process and returns a proper
// cmdResult. The channel.call timeout is only the lost-response backstop, so it
// is armed strictly later: with equal deadlines the two would race and a lost
// race would surface a transport "timed out" envelope instead of the probe's
// real partial output, and the host process would be orphaned — the exact trap
// this slice's host-side timeout exists to close.
const EXEC_CALL_TIMEOUT_MARGIN_MS = 5000;

// execInContext() over the companion channel: runs one JS-assembled script
// host-side. `opts.container` selects the docker-exec delivery shape (the
// runInContext container branch: `docker exec <c> bash -lc <script>` rebuilt
// host-side with byte-identical quoting); unset delivers the script straight to
// `bash -lc` (run()'s delivery shape). `opts.timeout` (ms, default 8000 — the
// same default runGit/runInContext pass run() today) is forwarded as `timeoutMs`
// so the HOST side kills a too-slow probe.
export async function execInContext(host, script, opts = {}, cfg = {}, deps = {}) {
  return companionOp(host, cfg, deps, {
    // Raw-shape family: the refusal rides stderr (the run() envelope), NOT an
    // `error` field.
    refuse: () => mapCmdLocalRefusal(host),
    run: async (channel) => {
      const methods = await channelMethods(channel, opts);
      if (!methods.includes('exec')) {
        // Stale binary (channel alive, binary predates the exec RPC): surface the
        // actionable too-old error — companion-or-fail, never a silent raw-SSH
        // fallback (see the block comment for why this op does not degrade).
        const ver = deps.manifest?.version ?? loadManifest().version;
        return {
          host,
          ok: false,
          code: -1,
          stdout: '',
          stderr: `companion binary on ${host} is too old: it does not advertise the 'exec' RPC (ping methods: ${methods.join(', ') || 'none'}). Remove ~/.warden/companion-${ver} on the host and retry so the bootstrap re-uploads the current binary, or set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path.`,
        };
      }
      const timeoutMs = opts.timeout ?? 8000;
      const result = await channel.call('exec', {
        script,
        container: opts.container || null,
        timeoutMs,
      }, { timeout: timeoutMs + EXEC_CALL_TIMEOUT_MARGIN_MS });
      return mapCmdResult(host, result);
    },
    fail: (e) => mapCmdError(host, e),
  });
}

// ------------------------------- attachSession -------------------------------
// WARDEN-1295 (the streaming slice of roadmap WARDEN-270). The LIVE WEB PANE was
// the last runtime path still spawning raw SSH: every open of a remote pane
// spawned a fresh `ssh -tt` child inside a local node-pty (attachStream →
// attachTmux → attachPty). Every other op family is request/response; this one is
// a bidirectional byte stream with a terminal on the far end, which is why it was
// deferred to last.
//
// The companion serves it over the SAME stdio channel with no second transport:
// attachStart ACKs an {sid} and then pushes base64 attachData events until an
// attachExit; attachInput/attachResize/attachKill drive it. This client wraps
// that family in an object exposing EXACTLY the node-pty IPty surface server.js
// consumes — onData / onExit / write / resize / kill — so the consumer seam
// (server.js:2870-2918) is BYTE-FOR-BYTE unchanged.
//
// THE HANDLE IS CONSTRUCTED SYNCHRONOUSLY, and that is a hard requirement rather
// than a style choice. server.js does `pty = attachStream(...)` — no await — and
// immediately registers onData/onExit and stores the entry. Bootstrapping a
// channel and awaiting the attachStart ACK are both async, so the handle owns
// that startup internally: it is returned live, buffers output and queues
// input/resize until the sid lands, and routes a startup FAILURE into the same
// onExit the consumer already handles. Making attachStream async instead would
// have forced a change to server.js, which the ticket forbids.
//
// Two contracts the wrapper must inherit, not merely approximate:
//
//  1. WARDEN-365 race discipline. node-pty's kill() is ASYNC: the prior PTY's
//     onExit lands AFTER a fresh one has rebound the same pane id, and server.js
//     gates its whole onData/onExit body on entry identity to suppress it. The
//     wrapper must behave the SAME way — a late exit must still be DELIVERABLE
//     (so the identity gate is what suppresses it, not the transport silently
//     swallowing it and quietly moving which layer is load-bearing) while never
//     being delivered TWICE. Hence: exactly one onExit per session, whatever
//     ends it (natural exit, our kill, channel death, or a failed startup).
//
//  2. Byte exactness. PTY output is arbitrary binary — control sequences,
//     partial UTF-8 across chunk boundaries, and \n itself. The wire is
//     line-delimited JSON, so it is base64 on both sides; the wrapper decodes to
//     a latin1 ('binary') string, a LOSSLESS byte↔char mapping. node-pty hands
//     server.js utf8-decoded strings, but server.js only forwards them into a WS
//     frame the browser feeds to xterm.js, so what matters is that the BYTES
//     survive — a utf8 decode here would corrupt any multibyte glyph split across
//     two attachData events, which a full-screen tmux repaint produces routinely.

// Decode one base64 attachData payload to a byte-exact string. latin1 (Node's
// 'binary') maps each byte to one code unit, so no multibyte sequence can be
// mangled by a chunk boundary — see the note above.
export function decodeAttachData(b64) {
  return Buffer.from(b64 || '', 'base64').toString('binary');
}

// Encode outgoing input the same way. server.js hands the wrapper a string that
// came off a WS frame; latin1 round-trips it to the exact bytes the terminal
// should receive.
export function encodeAttachInput(s) {
  return Buffer.from(String(s ?? ''), 'binary').toString('base64');
}

// The actionable too-old / unsupported-platform message. ONE builder so the
// stale-binary case and the no-host-PTY case (a windows companion omits attach*
// from its ping methods — pty_windows.go) read identically: both are "this
// companion does not advertise the attach RPCs", and both must tell the user how
// to get back to the default SSH path. (WARDEN-933 discipline.)
export function attachUnsupportedMessage(host, methods, version) {
  return `companion binary on ${host} is too old or cannot serve an attach: it does not advertise the 'attachStart' RPC (ping methods: ${(methods || []).join(', ') || 'none'}). ` +
    `If the binary is stale, remove ~/.warden/companion-${version} on the host and retry so the bootstrap re-uploads the current one. ` +
    `If the host is Windows the companion cannot allocate a PTY there — set WARDEN_COMPANION_TRANSPORT=0 (or turn the Settings toggle off) to attach over the default SSH path.`;
}

// CompanionAttachSession is the IPty-compatible handle attachSession() returns.
// It is deliberately NOT an EventEmitter and exposes NOTHING beyond the five
// members server.js uses — a wider surface would invite a consumer to depend on
// node-pty internals the companion path cannot honor.
export class CompanionAttachSession {
  // `startPromise` resolves to { channel, sid } once attachStart has ACKed, or
  // rejects with the actionable error. The handle is usable immediately either
  // way: output buffers until onData is registered, input/resize queue until the
  // sid lands, and a rejection settles as an exit the consumer already handles.
  constructor(host, startPromise, opts = {}) {
    this.host = host;
    this.sid = null;
    this._channel = null;
    this._dataCb = null;
    this._exitCb = null;
    this._exited = false;
    this._exitCode = null;
    this._exitError = null;
    this._killed = false;
    this._opts = opts;
    this._offData = null;
    this._offExit = null;
    // Output that arrives BEFORE server.js registers onData. The handle is
    // returned and the callbacks attached on the same tick, but the ACK and the
    // first attachData are both later — buffering keeps a fast shell's opening
    // prompt from being dropped.
    this._pending = [];
    // Input/resize issued before the sid exists (a user typing into a pane that
    // is still connecting). Replayed in order once the session is live rather
    // than silently discarded.
    this._queued = [];

    this._starting = startPromise
      .then(({ channel, sid }) => this._bind(channel, sid))
      .catch((e) => this._settleStartFailure(e));
  }

  // Wire the live session: subscribe to this sid's events, flush queued writes.
  _bind(channel, sid) {
    if (this._exited) {
      // The consumer detached while we were still connecting. The session exists
      // on the host now, so kill it rather than leaking a PTY (and a tmux client)
      // there — the WARDEN-365 detach-during-connect shape.
      channel.call('attachKill', { sid }, { timeout: this._opts.timeout ?? 15000 }).catch(() => {});
      return;
    }
    this.sid = sid;
    this._channel = channel;
    this._offData = onChannelEvent(channel, 'attachData', (msg) => {
      if (msg.sid !== sid) return; // another pane's stream on the shared channel
      const chunk = decodeAttachData(msg.data);
      if (this._dataCb) this._dataCb(chunk);
      else this._pending.push(chunk);
    });
    this._offExit = onChannelEvent(channel, 'attachExit', (msg) => {
      if (msg.sid !== sid) return;
      this._settleExit(typeof msg.code === 'number' ? msg.code : -1);
    });
    // A dead channel ends every stream riding it. Without this the pane would
    // spin forever on a host whose companion just died: no attachExit can arrive
    // over a channel that is gone. -1 is the same "no exit status" code the host
    // side reports for an abnormal end.
    channel.onDead(() => this._settleExit(-1));
    const queued = this._queued;
    this._queued = [];
    for (const send of queued) send();
  }

  // A startup failure (bootstrap failed, binary too old, host has no PTY) becomes
  // an EXIT rather than an unhandled rejection: the handle was already returned
  // to server.js, which has no other channel to learn on. `_exitError` carries
  // the actionable text for the caller that wants to surface it as attach_error.
  _settleStartFailure(err) {
    this._exitError = err;
    this._settleExit(-1);
  }

  // Deliver the session's single exit. `_exited` (not a listener check) is the
  // guard, so a kill racing a natural exit racing a channel death still produces
  // EXACTLY ONE onExit — the WARDEN-365 contract: server.js's identity gate is
  // what decides whether a late exit is acted on, and it can only do that job if
  // the transport delivers each end exactly once.
  _settleExit(code) {
    if (this._exited) return;
    this._exited = true;
    this._exitCode = code;
    try { if (this._offData) this._offData(); } catch { /* noop */ }
    try { if (this._offExit) this._offExit(); } catch { /* noop */ }
    if (this._exitCb) this._exitCb({ exitCode: code, signal: undefined });
  }

  // node-pty: onData(cb). Flushes anything buffered before registration.
  onData(cb) {
    this._dataCb = cb;
    if (this._pending.length) {
      const buffered = this._pending;
      this._pending = [];
      for (const chunk of buffered) cb(chunk);
    }
  }

  // node-pty: onExit(cb) receiving {exitCode, signal}. Registering AFTER the
  // session already ended still fires — the exit is a fact, not an event the
  // listener merely missed (node-pty's own late-onExit delivery is exactly the
  // behavior WARDEN-365's identity gate was written against).
  onExit(cb) {
    this._exitCb = cb;
    if (this._exited) cb({ exitCode: this._exitCode ?? -1, signal: undefined });
  }

  // node-pty: write(data). FIRE-AND-FORGET — node-pty's write is synchronous and
  // returns void, so this must not hand a rejecting promise to a call site that
  // never awaits it. A write to an already-exited session is a silent no-op,
  // matching node-pty's write-after-exit; a write before the ACK is queued.
  write(data) {
    if (this._exited) return;
    const payload = encodeAttachInput(data);
    const send = () => {
      if (this._exited || !this._channel) return;
      this._channel
        .call('attachInput', { sid: this.sid, data: payload }, { timeout: this._opts.timeout ?? 15000 })
        .catch(() => { /* a dropped keystroke must never throw into the WS handler */ });
    };
    if (this._channel) send();
    else this._queued.push(send);
  }

  // node-pty: resize(cols, rows) → TIOCSWINSZ → SIGWINCH on the host, the same
  // signal the default path's local PTY produces through `ssh -tt`. Coalesces
  // while connecting: only the LAST pre-ACK size matters, and replaying a burst
  // of intermediate sizes would just churn SIGWINCH at the newly-live terminal.
  resize(cols, rows) {
    if (this._exited) return;
    const send = () => {
      if (this._exited || !this._channel) return;
      this._channel
        .call('attachResize', { sid: this.sid, cols, rows }, { timeout: this._opts.timeout ?? 15000 })
        .catch(() => { /* best-effort, like node-pty's resize */ });
    };
    if (this._channel) { send(); return; }
    this._queued = this._queued.filter((q) => !q._isResize);
    send._isResize = true;
    this._queued.push(send);
  }

  // node-pty: kill(). ASYNC on the far side, exactly like node-pty's: this
  // returns immediately and the attachExit arrives later — precisely the race
  // WARDEN-365's identity gate exists to survive. The late exit is still
  // DELIVERED (the transport does not swallow it); server.js decides it is stale.
  //
  // Killing while still CONNECTING is handled in _bind: the session that lands
  // after the kill is torn down there rather than leaked on the host.
  kill() {
    if (this._killed) return;
    this._killed = true;
    if (!this._channel) {
      // No sid yet. Mark exited so nothing further is sent; _bind sees `_exited`
      // and kills the session the ACK is about to deliver.
      this._settleExit(-1);
      return;
    }
    this._channel
      .call('attachKill', { sid: this.sid }, { timeout: this._opts.timeout ?? 15000 })
      .catch(() => { /* the session may already be gone — idempotent host-side */ });
  }
}

// attachPreflight — the SYNCHRONOUS feature gate, and the reason a stale or
// PTY-less companion surfaces as an `attach_error` frame rather than a bare
// `ended`.
//
// server.js calls attachStream() without awaiting, inside a try/catch whose
// catch emits attach_error (server.js:2870-2877). Only a SYNCHRONOUS throw can
// reach that catch — an async failure necessarily arrives after the handle is
// already bound, and can then only settle as an exit. So the check that CAN be
// made synchronously is made here.
//
// It is not a lucky special case: server.js runs the bounded liveness probe
// FIRST (probeSession, server.js:2856), and under the companion transport that
// probe goes over the channel — so by the time attachStream runs, the host's
// channel is bootstrapped and its ping `methods` are cached on it. The realistic
// failure modes are therefore all decidable here:
//   • host unreachable / bootstrap failed → the PROBE already returned
//     host_unreachable and server.js never reached attachStream.
//   • binary too old, or a windows host that cannot allocate a PTY (its
//     pty_windows.go build omits attach* from the advertised methods) → caught
//     here, synchronously, with the actionable message.
// Anything not decidable yet (no cached channel, methods not yet known) simply
// passes; the async path then settles it as an exit. Never guesses.
export function attachPreflight(host, deps = {}) {
  if (host === LOCAL) throw new Error(LOCAL_REFUSAL);
  const cached = channelCache.get(host);
  // Not a live channel (absent, a bootstrap promise, or dead) → nothing known
  // yet; let the async path decide rather than inventing a verdict.
  if (!cached || typeof cached.then === 'function' || cached.dead) return;
  const methods = cached._methods;
  if (!Array.isArray(methods)) return; // ping methods not cached — unknown, not absent
  if (methods.includes('attachStart')) return;
  const ver = deps.manifest?.version ?? loadManifest().version;
  throw new Error(attachUnsupportedMessage(host, methods, ver));
}

// attachSession() over the companion channel — the streaming client. Returns an
// IPty-compatible CompanionAttachSession SYNCHRONOUSLY (see the class note for
// why that is required rather than preferred).
//
// It DOES throw synchronously for a failure attachPreflight can already see (a
// stale binary, a host with no PTY, LOCAL) so server.js's catch turns it into an
// actionable attach_error frame. A failure that only becomes knowable LATER
// cannot reach that catch — the handle is already in server.js's hands by then —
// so it settles as an immediate exit carrying the message on `_exitError`.
// Companion-or-fail either way: never a silent raw-SSH fallback inside the
// experimental path.
//
// `script` is the FULLY-ASSEMBLED host-side command (built JS-side by
// buildAttachRemoteScript ∘ buildAttachCommand — the same builders the default
// attachPty path uses), so parity is by construction rather than by two literals
// kept in sync.
export function attachSession(host, { script, cols = 100, rows = 30, term } = {}, cfg = {}, opts = {}, deps = {}) {
  attachPreflight(host, deps); // may THROW → server.js emits attach_error
  const start = (async () => {
    const channel = await getChannel(host, cfg, deps);
    const methods = await channelMethods(channel, opts);
    if (!methods.includes('attachStart')) {
      // NO graceful degradation, deliberately: a silent per-open raw-SSH fallback
      // would re-pay the exact handshake this slice removes while the toggle
      // reads "on", and would hide a Windows host's real limitation behind a
      // working pane. Same call as exec's (WARDEN-1261).
      const ver = deps.manifest?.version ?? loadManifest().version;
      throw new Error(attachUnsupportedMessage(host, methods, ver));
    }
    const result = await channel.call('attachStart', {
      script,
      cols,
      rows,
      // What node-pty puts on the default path's child, which `ssh -tt`
      // propagates to the host. Falls back to node-pty's own DEFAULT_NAME.
      term: term || process.env.TERM || 'xterm',
    }, { timeout: opts.timeout ?? 20000 });
    const sid = result && result.sid;
    if (!sid) throw new Error(`companion attachStart on ${host} returned no session id`);
    return { channel, sid };
  })();
  return new CompanionAttachSession(host, start, opts);
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

// ---------------------------- channel event fan-out --------------------------
// The channel has a SINGLE event-handler slot (`_eventHandler`): a second
// onEvent() call CLOBBERS the first. That was fine while paneDelta was the only
// emitter, but the attach stream (WARDEN-1295) is a second one on the SAME
// channel — registering it directly would silently kill pane deltas for the host
// (or vice versa, depending on which registered last).
//
// So the single slot is owned ONCE, here, by a dispatcher that fans by event
// NAME to a set of listeners. Both consumers register through onChannelEvent
// instead of onEvent, and they coexist. Each listener is called defensively so
// one throwing consumer cannot starve the other — the same discipline
// CompanionChannel._onLine already applies to the slot itself.
function ensureEventFanout(channel) {
  if (channel._eventFanout) return channel._eventFanout;
  const fanout = new Map(); // event name -> Set(handler)
  channel._eventFanout = fanout;
  channel.onEvent((msg) => {
    const set = fanout.get(msg && msg.event);
    if (!set) return;
    for (const handler of [...set]) {
      try { handler(msg); } catch { /* one consumer must not break the other */ }
    }
  });
  return fanout;
}

// Subscribe to one event name on a channel. Returns an unsubscribe function.
function onChannelEvent(channel, name, handler) {
  const fanout = ensureEventFanout(channel);
  let set = fanout.get(name);
  if (!set) { set = new Set(); fanout.set(name, set); }
  set.add(handler);
  return () => { set.delete(handler); };
}

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

// Wire the channel's paneDelta listener to feed the host's delta cache, once per
// channel. Idempotent: re-installs the same handler shape if the channel was
// re-bootstrapped (a fresh channel has _eventWired unset). Goes through the
// fan-out (NOT onEvent) so the attach stream can share the slot. (WARDEN-413,
// WARDEN-1295)
function ensurePaneDeltaHandler(channel, host) {
  if (channel._eventWired) return;
  channel._eventWired = true;
  onChannelEvent(channel, 'paneDelta', (msg) => applyPaneDelta(host, msg));
}

// Test seams for the attach slice (WARDEN-1295). Both exist because the two
// contracts they serve are otherwise unreachable from a test:
//   • _wirePaneDeltaForTests — proves paneDelta and the attach stream COEXIST on
//     the channel's single event slot, which needs both consumers wired in an
//     arbitrary order against one channel.
//   • _primeChannelForTests — the stale-binary gate is SYNCHRONOUS and reads the
//     channel cache (see attachPreflight), so asserting it needs a live channel
//     in the cache without a real bootstrap. Mirrors _channelCacheHasForTests.
// Not for production use.
export function _wirePaneDeltaForTests(channel, host) {
  ensurePaneDeltaHandler(channel, host);
}

export function _primeChannelForTests(host, channel) {
  channelCache.set(host, channel);
}

// describePanes normalizes a chat list to the {key,container,session} shape the
// companion expects. container null for bare-tmux; target via paneTarget().
function describePanes(list) {
  return (list || []).map((c) => ({
    key: c.key,
    container: c.container || null,
    session: paneTarget(c.session, c.container),
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
    const msg = formatCompanionError(host, e, 'subscribePanes');
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
  // Traced for the server stall monitor (WARDEN-977): an always-on background
  // sweep that blocks the loop must be nameable in the stall record instead of
  // being blamed on whichever request it froze. `trace` hands back the tick's own
  // value, so the fire-and-forget shape below is unchanged.
  const tick = () => { loopMonitor.trace('sweep:pane-delta', () => reconcilePaneSubscriptions([], cfg, {}, deps)).catch(() => {}); };
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
//              (probe + upload-once + channel + best-effort reap, WARDEN-904),
//              then ZERO per tick thereafter.
export function projectSpawnModel({ hosts = 1, ticks = 1, alreadyBootstrapped = false } = {}) {
  const h = Math.max(0, hosts);
  const t = Math.max(0, ticks);
  const bootstrapPerHost = alreadyBootstrapped ? 0 : 4; // probe + upload + channel + reap (WARDEN-904)
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
