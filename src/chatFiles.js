// Chat-file read + existence-probe layer (WARDEN-1567): the helpers behind
// POST /api/read-file, POST /api/file-exists and the git router's
// working-tree reads. Moved verbatim out of server.js; the route handlers stay
// there and import these helpers.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { shellQuote } from './ssh.js';
import { isWithinResolvedCwd, CWD_CONTAINMENT_CASE } from './pathContainment.js';
import { deliverRemoteScript } from './companion.js';

const LOCAL = '(local)';

// Helper function to detect binary files by extension
export function isBinaryFile(filePath) {
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg', // images
    '.pdf', '.ps', '.eps', '.ai', '.sketch', // documents
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', // archives
    '.exe', '.dll', '.so', '.dylib', '.app', '.bin', '.rom', // executables
    '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.webm', // media
    '.ttf', '.otf', '.woff', '.woff2', '.eot', // fonts
    '.class', '.jar', '.war', '.ear', // Java
    '.obj', '.o', '.a', '.lib', // compiled code
    '.pdb', '.min', '.map', // debug/map files
  ];
  const ext = path.extname(filePath).toLowerCase();
  return binaryExtensions.includes(ext);
}

// Detect binary content in a decoded blob string (WARDEN-354). `git show
// <hash>:<path>` emits raw bytes; runGit decodes them as UTF-8, so a binary
// blob's NUL bytes (0x00) survive as embedded '\0' characters in the string. A
// NUL anywhere in the content means the blob isn't valid text — git's own
// binary heuristic. The blob is already size-capped to 1MB by the cat-file -s
// pre-check above, so a full scan is cheap. Defense-in-depth behind
// isBinaryFile's extension check (which catches known-binary paths up front);
// this catches an extension-less file whose content is binary so we never emit
// garbled UTF-8. Exported for unit tests.
export function isBinaryBlob(content) {
  if (!content) return false;
  return content.includes('\0');
}

// WARDEN-1258 — expand a leading `~` to $HOME ON THE HOST RUNNING THE SCRIPT,
// spliced AFTER the single-quoted FILE assignment in both remote script builders.
// This is how a `~` path resolves remotely WITHOUT removing the quoting around
// the user-supplied value: the expansion is pure bash parameter expansion on the
// VARIABLE, so a payload containing quotes / $(…) / backticks stays inert inside
// the single quotes (the injection hardening WARDEN-39 established is untouched —
// the value is never re-interpolated into the script text). Only the EXACT forms
// expand: `~` alone and `~/…` — a `~user/…` tilde-USER prefix is deliberately
// left literal (bash cannot expand it without getpwnam, and the linkifier's
// local branch agrees: see expandChatFilePath, which also refuses it) so the
// existence probe answers no and the candidate never gains its affordance.
// Defined as ONE shared constant so buildReadFileScript and buildFileExistsScript
// (the probe and the open) can never disagree on tilde semantics.
//
// NOTE the `${FILE#…}` inside a plain single-quoted JS string, NOT a template
// literal: in a template literal `${…}` would be interpolated by JS (the
// WARDEN-140 interop trap). Single-quoted, it emits the literal bash expansion.
// `#\~` strips one leading literal tilde from the value; the case patterns
// "~") and "~/"* are quoted, so they match the literal characters only.
const TILDE_PREFIX_CASE =
  'case "$FILE" in "~") FILE=$HOME ;; "~/"*) FILE=$HOME${FILE#\\~} ;; esac';

// Build the remote (SSH) shell script that safely reads a file under `cwd`.
// Extracted so it can be unit-tested — this template has been fragile (a bash
// `${...}` parameter expansion collides with JS template-literal interpolation,
// and the already-quoted shellQuote() output must NOT be wrapped in double quotes
// or the literal single-quotes end up inside the variable value). `shellQuote`
// produces a single-quoted POSIX token, so we splice it in bare.
export function buildReadFileScript(cwd, filePath) {
  // NOTE: `\${RESOLVED##*.}` is an *escaped* JS template expression on purpose —
  // it emits the literal bash `${RESOLVED##*.}` parameter expansion (strip to the
  // file extension) into the script. Do not "fix" it to `${...}`.
  // The binary extensions are inlined directly in the `case` pattern (not read
  // from a variable): bash tokenizes case-pattern `|` alternation at parse time,
  // before expansion, so `case "$EXT" in $BINARY)` would match the literal string
  // "png|jpg|...", never any extension.
  // The cwd-containment `case` is the shared separator-bearing fragment from
  // src/pathContainment.js (WARDEN-1234) — see there for why the `/*` arm is
  // load-bearing. The prefix-sibling regression test lives in
  // src/read-file.test.js ("blocks prefix-sibling traversal").
  return `CWD=${shellQuote(cwd)}; FILE=${shellQuote(filePath)}; ${TILDE_PREFIX_CASE}; RESOLVED_CWD="$(realpath -e "$CWD" 2>/dev/null)" || { echo "ERROR invalid path"; exit 1; }; RESOLVED="$(cd "$RESOLVED_CWD" && realpath -e "$FILE" 2>/dev/null)" || { echo "ERROR file not found"; exit 1; }; ${CWD_CONTAINMENT_CASE}; [ -d "$RESOLVED" ] && { echo "ERROR path is a directory"; exit 1; }; [ -f "$RESOLVED" ] || { echo "ERROR not a file"; exit 1; }; SIZE=$(stat -c %s "$RESOLVED" 2>/dev/null || stat -f %z "$RESOLVED" 2>/dev/null); [ -n "$SIZE" ] && [ "$SIZE" -gt 1048576 ] && { echo "ERROR file too large"; exit 1; }; EXT="\${RESOLVED##*.}"; case "$EXT" in png|jpg|jpeg|gif|ico|bmp|webp|svg|pdf|ps|eps|ai|sketch|zip|tar|gz|bz2|xz|7z|rar|exe|dll|so|dylib|app|bin|rom|mp3|mp4|avi|mov|wav|flac|ogg|webm|ttf|otf|woff|woff2|eot|class|jar|war|ear|obj|o|a|lib|pdb|min|map) echo "ERROR cannot read binary files"; exit 1 ;; esac; cat "$RESOLVED"`;
}

// Build the remote (SSH) shell script that checks a path under `cwd` resolves to
// a real file — WITHOUT reading or transferring any content. The lightweight twin
// of buildReadFileScript: it runs the SAME realpath + cwd-containment + is-file
// guards (same `realpath -e`, same shared separator-bearing containment fragment
// from src/pathContainment.js that blocks the prefix-sibling traversal hole),
// then stops — no size/binary/cat. Used by /api/file-exists so the terminal
// linkifier (WARDEN-227) can confirm a candidate is a real file cheaply; it runs
// per visible terminal candidate, so it must not move file bytes. Exported for
// unit testing, parallel to buildReadFileScript.
export function buildFileExistsScript(cwd, filePath) {
  return `CWD=${shellQuote(cwd)}; FILE=${shellQuote(filePath)}; ${TILDE_PREFIX_CASE}; RESOLVED_CWD="$(realpath -e "$CWD" 2>/dev/null)" || { echo "ERROR invalid path"; exit 1; }; RESOLVED="$(cd "$RESOLVED_CWD" && realpath -e "$FILE" 2>/dev/null)" || { echo "ERROR file not found"; exit 1; }; ${CWD_CONTAINMENT_CASE}; [ -d "$RESOLVED" ] && { echo "ERROR path is a directory"; exit 1; }; [ -f "$RESOLVED" ] || { echo "ERROR not a file"; exit 1; }; echo EXISTS`;
}

// WARDEN-1258 — resolve a linkifier/read candidate path AGAINST the chat's cwd
// BEFORE any filesystem work. Two forms used to be unresolvable (WARDEN-1258):
//   • an ABSOLUTE path was joined onto cwd, silently relocating it INSIDE the
//     working directory (`/etc/passwd` became `<cwd>/etc/passwd`) — usually a
//     guaranteed miss, and worse, a coincidentally-existing RELATIVE path of the
//     same shape would resolve to the WRONG file;
//   • a leading `~` stayed a literal filename character (`<cwd>/~/ops/…`), a
//     guaranteed miss on any host.
// Now: an absolute path is used AS-IS; `~` alone / `~/…` expands to `homeDir`
// (the caller passes the home directory of the host that owns the chat — for a
// LOCAL chat, os.homedir() of the machine running the server; the remote branch
// expands with the REMOTE $HOME inside its own script, see TILDE_PREFIX_CASE);
// everything else joins onto cwd exactly as before. A `~user/…` tilde-USER
// prefix is deliberately NOT expanded (matching the remote branch — bash cannot
// expand it without getpwnam): it stays literal, joins onto cwd, and fails the
// existence probe. Pure (no fs); exported for unit tests.
//
// ORDERING (security, WARDEN-96): this expansion happens BEFORE realpath, and
// the cwd-containment guard runs on the FULLY RESOLVED path, never before —
// expanding `~` first is exactly what lets `~/.ssh/id_rsa` under a cwd of
// `~/ops` resolve to its true location and then be REJECTED by the unchanged
// containment clause.
export function expandChatFilePath(cwd, filePath, homeDir) {
  const home = typeof homeDir === 'string' && homeDir ? homeDir : os.homedir();
  if (filePath === '~') return home;
  if (filePath.startsWith('~/')) return path.join(home, filePath.slice(2));
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(cwd, filePath);
}

// Shared LOCAL resolution for a chat file: realpath (follow symlinks) both cwd and
// the file, verify cwd-containment, and confirm it is a regular file. Used by both
// /api/read-file (which then layers on the 1MB/binary/read guards) and the
// lightweight /api/file-exists probe, so the resolution behavior — and the cwd
// containment guard — stay identical between the two endpoints. Returns
// { ok: true, resolvedPath } or { ok: false, status, error }.
export function resolveLocalFile(cwd, filePath) {
  let resolvedCwd, resolvedPath;
  try {
    resolvedCwd = fs.realpathSync.native(cwd);
    // WARDEN-1258 — absolute paths are used as-is and `~` expands to the local
    // home directory BEFORE resolution (expandChatFilePath); the containment
    // guard below still runs on the fully-resolved path, unchanged.
    resolvedPath = fs.realpathSync.native(expandChatFilePath(cwd, filePath));
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, status: 404, error: 'file not found' };
    return { ok: false, status: 400, error: 'invalid path' };
  }
  // Containment is the shared separator-bearing clause from src/pathContainment.js
  // (WARDEN-1234) — the local twin of the bash fragment in
  // buildReadFileScript/buildFileExistsScript above.
  if (!isWithinResolvedCwd(resolvedPath, resolvedCwd)) {
    return { ok: false, status: 403, error: 'path must be within working directory' };
  }
  try {
    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) return { ok: false, status: 400, error: 'path is a directory' };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, status: 404, error: 'file not found' };
    return { ok: false, status: 500, error: 'read failed' };
  }
  return { ok: true, resolvedPath };
}

// Map the remote read-script's diagnostics ("ERROR ...") to the canonical
// { status, error } the LOCAL branch of readChatFile produces. ONE shared table
// used by readChatFile's remote branch so a new facet added to buildReadFileScript
// (a new binary extension, a new ERROR reason) lands here once instead of being
// hand-copied into two parallel if-ladders — the per-new-facet drift tax that
// once left readWorkingTreeFile and /api/read-file disagreeing on the binary
// vocabulary ('binary file' vs 'cannot read binary files'). The script emits at
// most ONE "ERROR ..." line then exits, so these out.includes() checks can never
// overlap; order is therefore irrelevant. Returns { status, error }.
function mapReadScriptError(out) {
  if (out.includes('ERROR invalid path')) return { status: 400, error: 'invalid path' };
  if (out.includes('ERROR file not found')) return { status: 404, error: 'file not found' };
  if (out.includes('ERROR path must be within working directory')) return { status: 403, error: 'path must be within working directory' };
  if (out.includes('ERROR path is a directory')) return { status: 400, error: 'path is a directory' };
  if (out.includes('ERROR not a file')) return { status: 400, error: 'not a file' };
  if (out.includes('ERROR file too large')) return { status: 413, error: 'file too large (max 1MB)' };
  if (out.includes('ERROR cannot read binary files')) return { status: 400, error: 'cannot read binary files' };
  return { status: 500, error: 'read failed' };
}

// The ONE shared local-vs-remote read-with-guards orchestration. Used by BOTH
// POST /api/read-file (the FileViewer single-file read) and readWorkingTreeFile
// (the A↔B cross-agent compare), so a future guard added here is paid ONCE
// instead of drifted across two hand-maintained copies (WARDEN-674). Returns a
// canonical discriminated result: { ok: true, content } | { ok: false, status, error }.
//
// LOCAL chats (chat.host === LOCAL): resolveLocalFile → 1MB statSync cap →
// isBinaryFile (by extension) → readFileSync → isBinaryBlob (NUL in content).
// REMOTE/yatfa chats: buildReadFileScript + run(host, script) — the script
// carries the same realpath + cwd-containment + size + binary-extension guards
// inside the bash, emitting "ERROR ..." diagnostics — then an isBinaryBlob pass
// on the returned stdout to catch a binary file whose extension wasn't known.
//
// This is the canonical rule set that reconciles the two former copies: it
// ADOPTS readWorkingTreeFile's isBinaryBlob-on-local check (closing the gap where
// /api/read-file used to serve a binary-blob .txt/.log the compare already
// rejected) and /api/read-file's 'cannot read binary files' vocabulary (so the
// two no longer disagree on the string). Neither spec suite exercises a
// local text-extension file containing NUL bytes (both test binary by EXTENSION,
// caught earlier by isBinaryFile), so adopting the stricter check is a pure
// correctness improvement with zero spec regression.
export async function readChatFile(chat, filePath, deps = {}) {
  const cwd = chat.cwd || '.';
  if (chat.host === LOCAL) {
    const resolved = resolveLocalFile(cwd, filePath);
    if (!resolved.ok) return { ok: false, status: resolved.status, error: resolved.error };
    try {
      const stats = fs.statSync(resolved.resolvedPath);
      if (stats.size > 1024 * 1024) return { ok: false, status: 413, error: 'file too large (max 1MB)' };
      if (isBinaryFile(resolved.resolvedPath)) return { ok: false, status: 400, error: 'cannot read binary files' };
      const content = fs.readFileSync(resolved.resolvedPath, 'utf8');
      if (isBinaryBlob(content)) return { ok: false, status: 400, error: 'cannot read binary files' };
      return { ok: true, content };
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: false, status: 404, error: 'file not found' };
      if (e.code === 'EISDIR') return { ok: false, status: 400, error: 'path is a directory' };
      return { ok: false, status: 500, error: 'read failed' };
    }
  }
  // remote/yatfa: buildReadFileScript + deliverRemoteScript. The script's
  // diagnostics ("ERROR ...") land on stdout; pool/ssh failures land on stderr —
  // mapReadScriptError inspects both via the shared table.
  //
  // WARDEN-1284 (companion transport): under the `companionTransportEnabled`
  // toggle the script rides the persistent companion channel instead of a fresh
  // un-pooled ssh handshake per read. PARITY: buildReadFileScript still
  // assembles the script (its realpath/containment/1MB/binary guards untouched)
  // and it is delivered byte-for-byte by either transport — the `{ok, stdout,
  // stderr}` shape mapReadScriptError reads is identical. `deps` is the shared
  // routing test seam, threaded from readWorkingTreeFile so the A↔B compare
  // exercises the same routing.
  const script = buildReadFileScript(cwd, filePath);
  const result = await deliverRemoteScript(chat.host, script, { timeout: 10000 }, {}, deps);
  if (!result.ok) {
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    return { ok: false, ...mapReadScriptError(out) };
  }
  if (isBinaryBlob(result.stdout)) return { ok: false, status: 400, error: 'cannot read binary files' };
  return { ok: true, content: result.stdout };
}

// Read one agent's CURRENT working-tree file CONTENT (NOT a diff vs HEAD) for the
// A↔B cross-agent compare (WARDEN-593). A thin fold over readChatFile (the shared
// read-with-guards orchestration also used by /api/read-file) so the two paths
// resolve identically — no per-new-facet drift, no split binary vocabulary.
// Returns { content } on success or { error } on any read failure — never throws
// (the /api/cross-agent-diff route folds .error into its never-500
// { diff, error } response, prefixing the failing side A/B). A deleted/missing
// path (status 'D') fails here and surfaces as 'file not found'.
export async function readWorkingTreeFile(chat, filePath, deps = {}) {
  const r = await readChatFile(chat, filePath, deps);
  return r.ok ? { content: r.content } : { error: r.error };
}

// Probe a path's existence on a REMOTE host (leg 2 of WARDEN-1284). Extracted
// from the /api/file-exists handler so the routing — which transport carries the
// script — is assertable through the shared `deps` seam without real ssh; the
// handler keeps its telemetry and response shaping.
//
// WARDEN-1284 (companion transport): this is the probe that costs the user the
// most. The linkifier fires it PER VISIBLE TERMINAL CANDIDATE (WARDEN-227) and
// each one paid its own un-pooled ssh handshake; under the toggle they all share
// the persistent companion channel. The WARDEN-1258 telemetry the caller records
// around this call is its built-in observer — the remote-probe latency split
// shows the collapse. PARITY: buildFileExistsScript still assembles the script
// (the WARDEN-96 containment guard untouched) and it is delivered byte-for-byte
// by either transport; the EXISTS-marker check reads the identical
// {ok, stdout, stderr} shape. remoteFileExists keeps the boolean contract for
// callers that only need yes/no; the /api/file-exists route uses probeRemoteFile
// below so a transport failure is NOT reported as "absent" (WARDEN-1492).
export async function remoteFileExists(host, cwd, filePath, deps = {}) {
  return (await probeRemoteFile(host, cwd, filePath, deps)).state === 'exists';
}

// WARDEN-1492 — the three-state probe behind remoteFileExists. A boolean cannot
// tell "the file is absent" from "we never got an answer", and that conflation
// made the WARDEN-1258 telemetry useless (98.6% of remote probes read as
// "absent" while 13 of them ran 5–10s past the 8s script timeout — transport
// failures wearing the absence verdict). The states:
//   exists — the script ran and printed EXISTS.
//   absent — the script RAN and delivered a definitive verdict: one of
//            buildFileExistsScript's own `ERROR …` diagnostics on stdout
//            (missing, outside cwd, directory, not a file). Conclusive: the
//            linkifier may cache it.
//   failed — no verdict at all: transport error, channel death, script
//            failure, or the hard deadline below. NOT conclusive — a real file
//            must not lose its link over it. `reason` is 'timeout' | 'error'.
// The ERROR markers are matched on STDOUT only (the script echoes them there),
// so ssh/profile noise on stderr can never forge an "absent" verdict. The
// EXISTS check keeps reading stdout+stderr exactly as before (transport parity).
//
// The deadline: the transports enforce the script timeout themselves, but the
// companion exec adds EXEC_CALL_TIMEOUT_MARGIN_MS (5s) of channel slack on top
// of it, which is how probes ran to ~9.8s against an 8s timeout. A race here
// makes the configured timeout the boundary for the CALLER regardless of
// transport; the transport's own call is left to finish and be discarded.
export const REMOTE_FILE_EXISTS_TIMEOUT_MS = 8000;
// Slack over the script timeout so a transport that kills at exactly the
// timeout can still report its own answer before the race fires.
const REMOTE_FILE_EXISTS_DEADLINE_GRACE_MS = 250;
const FILE_EXISTS_ABSENT_MARKER =
  /(^|\n)ERROR (invalid path|file not found|path must be within working directory|path is a directory|not a file)\s*(\n|$)/;

export async function probeRemoteFile(host, cwd, filePath, deps = {}) {
  const timeoutMs = deps.probeTimeoutMs ?? REMOTE_FILE_EXISTS_TIMEOUT_MS;
  const graceMs = deps.probeDeadlineGraceMs ?? REMOTE_FILE_EXISTS_DEADLINE_GRACE_MS;
  const started = Date.now();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs + graceMs);
  });
  let result;
  try {
    result = await Promise.race([
      (async () => deliverRemoteScript(host, buildFileExistsScript(cwd, filePath), { timeout: timeoutMs }, {}, deps))().catch(() => undefined),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!result) return { state: 'failed', reason: 'timeout' };
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.ok && out.includes('EXISTS')) return { state: 'exists' };
  if (FILE_EXISTS_ABSENT_MARKER.test(result.stdout || '')) return { state: 'absent' };
  // No verdict: a transport-killed run (code -1) that consumed the timeout is a
  // timeout; anything else is a generic transport/script failure.
  const timedOut = result.code === -1 && Date.now() - started >= timeoutMs - 50;
  return { state: 'failed', reason: timedOut ? 'timeout' : 'error' };
}
