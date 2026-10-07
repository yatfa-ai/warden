// The chat-scoped transport layer for the warden git/file/search domain — the
// single place that decides HOW a command reaches a chat's execution context
// (manual-LOCAL spawn, yatfa docker-exec, remote ssh / companion). Extracted
// verbatim from src/gitRoutes.js (WARDEN-1626) so the 15-route express module
// stops doubling as the transport library that src/workspaceSearch.js and
// src/server.js import from.
//
// LEAF module: imports only ssh.js / childCapture.js / companion.js / gitStatus.js /
// git.js (all side-effect-free leaves) and node builtins — NEVER gitRoutes.js or
// server.js, so the dependency stays one-directional and cycle-free.
// gitRoutes.js re-exports the public names so every existing './gitRoutes.js'
// import keeps resolving unchanged.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { shellQuote } from './ssh.js';
import { captureAndSettle } from './childCapture.js';
// WARDEN-1261: the companion-transport routing for the chat-scoped script domain.
// companion.js is a leaf sibling (it imports ssh.js/chatMeta.js/loop-monitor.js,
// never this module), so the dependency stays one-directional — no cycle.
// WARDEN-1284 lifted the routing guard itself (`deliverRemoteScript`) into
// companion.js so the nine other script-delivery legs share ONE guard.
import { deliverRemoteScript } from './companion.js';
import { buildDockerGitArgv } from './gitStatus.js';
import { buildCwdReachableScript } from './git.js';

// The host sentinel for "run on this machine, not over SSH" (mirrors server.js's
// LOCAL — duplicated rather than imported to keep this a leaf module; the test suites
// already hardcode this same string).
export const LOCAL = '(local)';


// Run a command LOCALLY without blocking the event loop — the async, spawn-based
// twin of the spawnSync calls that previously froze the whole server for the
// duration of every local git / docker-exec / rg / grep on a request path
// (WARDEN-441). Mirrors run() in ssh.js (spawn + Promise) so the LOCAL transports
// are consistent with the remote path's existing async pattern. stdout/stderr are
// accumulated as UTF-8 STRINGS and returned as { ok, code, stdout, stderr } — the
// same shape runGit/runInContext already hand their callers — plus `error` (the
// spawn Error, with .code e.g. 'ENOENT') when the binary could not be spawned, so
// hasBinary() can distinguish an absent tool from a normal non-zero exit.
//
// stderr is CAPTURED (not inherited) so git/rg diagnostics ("fatal: not a git
// repository") reach the caller via .stderr instead of spewing on the server
// console — matching runLocalSearch's discipline and the remote run() path. Like
// run(), output is UNBOUNDED: the route-level capDiff() guard and the streamed
// search bounding remain the single truncation points (a spawnSync maxBuffer used
// to mask a large diff as a non-zero exit; the async read completes with status 0
// and lets capDiff truncate cleanly). Exported because server.js's non-git search
// path (runLocalSearch) reuses it — it is the single async spawn+capture primitive.
//
// Resolves on 'close', NOT 'exit' (WARDEN-464 'Good Pattern'). 'exit' fires when the
// child process ends but BEFORE the buffered stdio pipe data has finished draining;
// the final 'data' chunks arrive AFTER 'exit'. Under the fleet-wide git-status fan
// (WARDEN-766) — N agents × ~8 runGit probes each, all in flight at once — the
// saturated event loop can process a given child's 'exit' callback BEFORE its final
// 'data' callback, so resolving on 'exit' captures EMPTY/partial stdout even though
// the probe exited 0. That made `git status --porcelain` read as '' for a genuinely
// dirty repo → clean:true (false clean), and symmetrically `rev-parse` read as '' →
// clean:null — the exact non-deterministic failure QA observed under concurrency
// (reproduced at ~60% mismatch firing ~40 runGit probes at once; 0% after this fix).
// 'close' fires only AFTER the stdio streams fully drain, so stdout/stderr are always
// complete when the promise resolves. ssh.js's runLocalTmux AND the remote run() both
// resolve on 'close' for the same reason (run() was switched from 'exit' to 'close' in
// the WARDEN-766 rework — the fleet fan hits the remote transport concurrently too, so
// the same race that false-cleaned local reads would have false-cleaned remote ones).
//
// `spawn` is injectable (defaults to node's child_process.spawn) so the 'close'-not-
// 'exit' discipline has a DETERMINISTIC unit test: a fake child that emits 'exit'
// BEFORE its final stdout 'data' (the adversarial order the saturated loop produces)
// must still resolve with COMPLETE stdout — a real subprocess can't reproduce that
// order reliably on every machine. Mirrors runWithPool's `deps` injection pattern.
export function runLocalCapture(bin, args, { cwd, timeout, spawn: spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = timeout ? setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* noop */ } }, timeout) : null;
    // The stdout/stderr accumulation + 'close'-not-'exit' settlement is the shared
    // core — see captureAndSettle (childCapture.js). `timer` is null when no timeout
    // was given, which captureAndSettle tolerates.
    captureAndSettle(child, resolve, {
      timer,
      // runLocalCapture carries the spawn error as a separate `error` field — NOT
      // folded into stderr the way run() does. The two contracts point in opposite
      // directions and both are pinned by green tests (runLocalCapture.test.js:106
      // asserts `r.error === err`; sshRun.test.js:133 asserts the stderr fold).
      onSpawnError: (err, stdout, stderr) => ({ ok: false, code: -1, stdout, stderr, error: err }),
    });
  });
}


// Run git locally, async (non-blocking). Used by /api/git-status, /api/git-log,
// /api/git-diff, /api/git-blame and the manual-LOCAL branch of runGit. Captures
// stdout/stderr as strings (see runLocalCapture) and centralizes windowsHide so a
// local git call never flashes a visible console window when warden runs as a
// packaged/detached app. Remote chats go through run() (ssh.js), which is already
// async and hides. Returns { ok, code, stdout, stderr }.
export async function runLocalGit(args, cwd) {
  return runLocalCapture('git', args, { cwd });
}


// Resolve the working directory for a chat's git operations (WARDEN-235).
//
// yatfa (container) chats carry an IN-CONTAINER path derived at discovery (the
// agent tmux pane's cwd, else the image WorkingDir). It must NEVER fall back to
// Warden's own process.cwd(): that path is the host's, not the container's, so a
// LOCAL yatfa agent would silently surface WARDEN'S repo state — actively
// misleading, the core bug this ticket fixes. When derivation failed we return ''
// and the route's existing `!cwd` guard emits a graceful `error: 'no cwd'` (never
// a 500), which is correct: better no badge than a wrong one.
//
// manual/tmux chats keep the original local fallback (their cwd is a real host
// path, and LOCAL manual chats have always shown the host repo at process.cwd()).
export function gitCwd(chat) {
  if (chat.container) return chat.cwd || '';
  return chat.cwd || (chat.host === LOCAL ? process.cwd() : '');
}


// Run `git <args>` for a chat, choosing the transport by kind/host (WARDEN-235).
// Returns { ok, code, stdout, stderr } with STRING stdout/stderr so call sites
// read `.stdout` directly (no `.toString()`). Mirrors runLocalGit's windowsHide
// centralization while adding the docker-exec branch yatfa chats need — their cwd
// is an in-container path the host (and a bare remote `cd`) cannot reach.
//
//   yatfa LOCAL   → docker exec <c> git -C <cwd> <args>   (argv, NO shell — safe)
//   yatfa REMOTE  → ssh host 'docker exec <c> git -C <cwd> <args>'
//   manual LOCAL  → runLocalGit('git', args, {cwd})        (async, non-blocking)
//   manual REMOTE → ssh host 'cd <cwd> && git <args>'      (unchanged)
//
// `-C <cwd>` (not a shell `cd`) targets git at the in-container dir with zero
// injection surface on the local branch (argv); the remote branch shellQuotes
// cwd + each arg (the same WARDEN-122 discipline as git-log/show). `2>/dev/null`
// on the remote branches swallows non-git / detached noise so a non-repo reads
// as empty, mirroring runLocalGit's non-zero-exit tolerance.
//
// WARDEN-1261 (companion transport): the REMOTE branches now route through the
// persistent companion channel (execInContext) under the
// `companionTransportEnabled` toggle — collapsing the raw, UN-POOLED per-op ssh
// handshake each probe paid (unlike the tmux ops, this domain never even rode
// ControlMaster pooling). PARITY CONTRACT: the script string is built ONCE,
// byte-for-byte as before, and delivered by EITHER transport — the companion
// path hands the very same string to the host-side `exec` RPC (which runs it via
// the same `bash -lc` interpreter level run() delivers), so the command executed
// host-side is identical on both paths. Companion-or-fail: a channel/bootstrap
// failure surfaces through the routes' existing error handling ({ok:false, …})
// — never a silent raw-SSH fallback. LOCAL branches are untouched.
//
// `deps` is a test seam for the routing guard (the wiring that decides default
// vs companion is otherwise untested): isCompanionTransportEnabled /
// execInContext / run are injectable so a test can assert delegation, the
// delivered-script parity, and non-fallthrough to the default path without real
// ssh (mirrors the deps seams in chats.js discover / tmux.js send).
export async function runGit(chat, args, cwd, deps = {}) {
  if (chat.container) {
    if (chat.host === LOCAL) {
      const argv = buildDockerGitArgv(chat.container, cwd, args);
      return runLocalCapture(argv[0], argv.slice(1));
    }
    // REMOTE container chat. The full script (docker-exec prefix included, the
    // `2>/dev/null` suffix preserved) is assembled once and delivered by either
    // transport — the companion runs it via `bash -lc <script>`, byte-for-byte
    // what run() delivers, so no parser or quoting changes anywhere.
    const a = args.map(shellQuote).join(' ');
    const script = `docker exec ${shellQuote(chat.container)} git -C ${shellQuote(cwd)} ${a} 2>/dev/null`;
    return deliverRemoteScript(chat.host, script, { timeout: 8000 }, {}, deps);
  }
  if (chat.host === LOCAL) {
    return runLocalGit(args, cwd);
  }
  // REMOTE manual chat — same single-assembly parity contract.
  const a = args.map(shellQuote).join(' ');
  const script = `cd ${shellQuote(cwd)} && git ${a} 2>/dev/null`;
  return deliverRemoteScript(chat.host, script, { timeout: 8000 }, {}, deps);
}


// The routing guard (`deliverRemoteScript`) used to live HERE as a private
// helper. WARDEN-1284 routed the nine remaining script-delivery legs — spread
// across server.js, observer.js, claudeSessions.js and ssh.js — onto the same
// `exec` RPC, so the guard moved to src/companion.js (beside the client it
// guards) rather than being copied into four modules, each free to drift on the
// companion-or-fail discipline. Behaviour here is byte-for-byte unchanged; the
// deps seam (isCompanionTransportEnabled / execInContext / run) is the same one.


// WHY did this git command fail — is the repo fine, or is it gone? (WARDEN-1021)
//
// Returns one of:
//   'unborn' — a HEALTHY repo whose HEAD simply has no commits yet.
//   'broken' — not a repo / a deleted cwd / a dropped SSH transport.
//   'other'  — a valid repo with a real HEAD; the command failed for its own
//              reason (e.g. `@{u}` on a branch that tracks nothing).
//
// `git log` and `git reflog` exit NON-ZERO on a freshly `git init`'d repo before
// its first commit — unlike `git stash list` / `git for-each-ref`, which exit zero
// and so need no probe. An agent sitting in a brand-new repo is an entirely normal
// state, NOT a broken one, so those two routes must not report "git log failed"
// for it (that is the false positive the empty-list-with-error convention exists to
// avoid, in the opposite direction). Called ONLY on an already-failing leg, so the
// extra round-trips never touch the hot path.
//
// 'broken' is kept DISTINCT from 'other' rather than collapsed into a boolean
// because a caller that has a more specific message for a route-level condition
// (git-log's `no upstream configured` under ?range=) must not paste that message
// over a repo that isn't there. Telling a human "no upstream configured" for a
// deleted cwd sends them to `git branch --set-upstream` for a repo that no longer
// exists — a fabricated cause, i.e. this ticket's own disease one layer up.
//
// Two probes, because neither bit is sufficient alone:
//   1. `rev-parse --git-dir` — succeeds in ANY valid repo (unborn and detached
//      included), fails for a non-git cwd, a deleted cwd, or a dropped SSH
//      transport. This is what keeps a genuinely broken repo from being excused.
//   2. `rev-parse --verify -q HEAD` — resolves HEAD to a commit. Fails ONLY when
//      HEAD points at a ref with no commit behind it, i.e. an unborn HEAD.
//
// Deliberately NOT done by exit-code sniffing (`code === 1` vs `128`): the remote
// branches run `cd <cwd> && git …`, and a deleted cwd makes *bash* exit 1 — exactly
// the code an unborn HEAD produces. That shortcut would re-introduce the false
// empty on the deployment shape this ticket is about. Nor can `r.stderr` be read:
// both remote branches pipe `2>/dev/null` (see runGit above).
export async function classifyGitFailure(chat, cwd) {
  const dir = await runGit(chat, ['rev-parse', '--git-dir'], cwd);
  if (!dir.ok) return 'broken'; // not a repo / deleted cwd / dead transport → a REAL failure
  const head = await runGit(chat, ['rev-parse', '--verify', '-q', 'HEAD'], cwd);
  return head.ok ? 'other' : 'unborn'; // HEAD resolves to nothing → unborn, a benign empty
}


// Deliver a SHELL SCRIPT to the chat's execution context (WARDEN-235). Used by
// git operations that need in-context shell features the argv `runGit` path
// can't express — chiefly the in-progress-operation marker `test` (MERGE_HEAD
// etc.) and the realpath/cd containment guards, which must run where the git
// dir actually lives (inside the container for yatfa, on the remote host for
// manual-remote). Returns { ok, code, stdout, stderr }.
//
//   yatfa LOCAL   → docker exec <c> bash -lc <script>   (script's `cd <cwd>` is in-container)
//   yatfa REMOTE  → ssh host 'docker exec <c> bash -lc <script>'
//   manual REMOTE → ssh host '<script>'                 (run() already wraps bash -lc)
//
// Never called for manual-LOCAL: that path keeps the host-fs existsSync
// implementation (the marker files and realpath are reachable on this machine).
// Exported because server.js's non-git /api/search-files route reuses it for its
// in-context rg/grep probe — the same chat-scoped transport the git routes use.
//
// WARDEN-1261 (companion transport): the REMOTE branches route through the
// persistent companion channel (execInContext) under the
// `companionTransportEnabled` toggle. PARITY CONTRACT, both branches:
//   - the container branch passes the INNER script + the container, and the
//     host side re-assembles `docker exec <c> bash -lc <script>` with byte-
//     identical quoting (Go's shellQuote == ssh.js's) — the same command string
//     run() receives on the default path, so the delivered command is unchanged;
//   - the manual branch passes the script itself, which the host side runs via
//     `bash -lc <script>` — exactly what run()'s `bash -lc ${shellQuote(cmd)}`
//     delivers.
// Companion-or-fail: a channel/bootstrap failure surfaces as {ok:false, …}
// through the routes' existing error handling — never a silent raw-SSH fallback.
// LOCAL branches (and the manual-LOCAL exclusion) are untouched.
//
// `deps` is the same test seam runGit carries (isCompanionTransportEnabled /
// execInContext / run injectable).
export async function runInContext(chat, script, { timeout = 8000 } = {}, deps = {}) {
  if (chat.container) {
    if (chat.host === LOCAL) {
      return runLocalCapture('docker', ['exec', chat.container, 'bash', '-lc', script]);
    }
    // REMOTE container chat: the default path assembles `docker exec <c> bash -lc
    // <script>` (byte-for-byte unchanged below); the companion receives the INNER
    // script + container and the host side re-assembles the identical string
    // (buildExecScript — Go's shellQuote is ssh.js's byte-identical twin).
    const full = `docker exec ${shellQuote(chat.container)} bash -lc ${shellQuote(script)}`;
    return deliverRemoteScript(chat.host, full, { innerScript: script, container: chat.container, timeout }, {}, deps);
  }
  // REMOTE manual chat (manual-LOCAL never reaches runInContext — see above).
  return deliverRemoteScript(chat.host, script, { timeout }, {}, deps);
}


// Is the chat's working directory REACHABLE — a directory one could enter where
// the repo lives — NOT "is it a repository"? (WARDEN-1255) The finer discriminator
// /api/git-blame's failure gate keys on, and deliberately NOT classifyGitFailure:
// its 'broken' bucket fuses the benign-for-blame cases (a plain non-repo cwd,
// which must stay a success-shaped empty) with the real failures (a deleted cwd,
// a gone container, a dropped transport) — its own comment groups them — so
// keying blame's gate on it would either report the benign empties its pinned
// tests protect or excuse the unreachable cwd the gate exists to catch.
// Reachability alone splits the two exactly:
//   reachable  + failed blame → repo-level conditions (non-repo cwd, untracked
//                               file) → empty result, no error
//   unreachable + anything    → deleted cwd / gone container / dead transport
//                               → the fixed-literal failure the client renders
// Called ONLY on an already-failing leg — mirroring classifyGitFailure's
// discipline — so the extra round-trip never touches the hot path.
// Exported for the WARDEN-1255 unit tests (both transports' unreachable shapes —
// the HTTP suite can only fixture the LOCAL one, since the disk catalog hardcodes
// container:null for seeded chats).
export async function isCwdReachable(chat, cwd) {
  // manual-LOCAL: cwd is a real host path, so the host fs answers directly — the
  // same host-fs probe discipline detectInProgress's manual-LOCAL leg uses.
  // statSync (not existsSync) so a cwd that survives as a non-directory reads as
  // unreachable exactly the way a `cd` into it would fail; ANY stat error (deleted
  // cwd above all) is unreachable.
  if (!chat.container && chat.host === LOCAL) {
    try { return fs.statSync(cwd).isDirectory(); } catch { return false; }
  }
  // container (local+remote) or manual-remote: ask over the SAME in-context
  // transport the blame script took, so "reachable" means reachable where the
  // repo lives. buildCwdReachableScript is `test -d` — bash's directory predicate,
  // no git involvement. A dropped SSH transport or a missing container fails the
  // probe exactly the way it failed the blame, which is the failure being
  // reported; a present-but-non-repo directory passes it, which is the benign
  // empty. runInContext resolves (never rejects), and run()'s ok:false-on-dead-
  // transport contract is pinned by sshRun.test.js.
  const probe = await runInContext(chat, buildCwdReachableScript(cwd));
  return probe.ok;
}
