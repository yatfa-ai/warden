// Pure, stateless companion bootstrap helpers — moved VERBATIM out of
// src/companion.js (WARDEN-1982). companion.js re-exports every public name so
// importers are unchanged; distDir / SUPPORTED_TARGETS are exported here only
// because bootstrapChannel (which stays in companion.js) also uses them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChat, sortChats, parseActivityTimestamp } from './chatMeta.js';

const COMPANION_DIR = '$HOME/.warden'; // expands on the remote host

// src/companionBootstrap.js -> ../companion/dist (same src/ dir as companion.js). Works in dev (repo root) and in the
// packaged app (companion/dist is bundled alongside src/ via electron-builder).
export function distDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'companion', 'dist');
}

let _manifest;
// The full cross-compile matrix (linux/darwin/windows × amd64/arm64). build.sh
// emits a binary for each target; loadManifest validates all six are present, and
// targetForUname maps a host's (uname -s, uname -m) into one of them.
export const SUPPORTED_TARGETS = [
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
// leading pane line (containerInfo.Pane) via parseActivityTimestamp.
//
// WARDEN-1340 NOTE — this is now the ONE path still on the old mechanism. The
// default SSH path derives lastActivity from #{window_activity} (tmux's own
// epoch-seconds record of the window's last OUTPUT); this companion leg still
// reads the leading pane line, whose first timestamp can be the OLDEST line of
// the scrollback (the frozen-clock defect WARDEN-1340 fixes). It stays this way
// deliberately: moving the Go side to #{window_activity} means editing
// companion/main.go and rebuilding all six companion/dist/ binaries +
// manifest.json, and this sandbox has no Go toolchain — shipping a main.go edit
// with stale binaries would leave hosts serving the old behavior while their
// ping reports the expected version (the WARDEN-376 lesson). Deferred to a
// follow-up slice; once it lands, parseActivityTimestamp retires entirely.
// Inactive containers, lean-mode (no Pane captured), and garbage/empty lines
// leave lastActivity null.
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
