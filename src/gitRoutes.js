// The git HTTP layer for the warden dashboard — the 15 `/api/git-*` +
// `/api/cross-agent-diff` route handlers and their transport helpers (gitCwd,
// runGit, withGitRepo, detectInProgress, …). Extracted verbatim from src/server.js
// (WARDEN-734) as the route-layer sibling of src/git.js (the pure parsers, WARDEN-606)
// and src/claudeSessions.js (the Claude-session layer, WARDEN-677): git.js +
// gitStatus.js hold the pure parse logic, this module holds the route handlers +
// the chat-scoped transport (runGit / runInContext / withGitRepo) that calls them.
//
// Side-effect-free at module load: the only project imports are the already-extracted
// leaf modules (ssh.js, gitStatus.js, git.js) + express, none of which boot anything,
// so importing this module does NOT read config or start a server (mirrors git.js /
// claudeSessions.js). The chat resolver (`resolve`) and the read-file guards
// (`readWorkingTreeFile`, `isBinaryFile`, `isBinaryBlob`) live in server.js and are
// passed into `createGitRouter` so this module never imports server.js — the
// dependency stays one-directional (server.js -> gitRoutes.js), avoiding a cycle.
//
// `runGit` + `gitCwd` (and the other exported pure-ish helpers) stay module-level
// named exports so server.js can re-export them for the test suites that import
// `runGit` / `gitCwd` / `getLocalGitDiff` / `stripCommitSubject` / `parseInProgressDetail`
// from './server.js' (git-container / git-ls / gitDiff / git-show / git-status tests).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import { run, shellQuote } from './ssh.js';
import { parseGitStatusPorcelain, parseAheadBehind, parseOutgoingFiles, parseStashCount, parseStashList, parseReflog, parseDiffStat, isDetachedHead, normalizeHeadSha, parseUpstream, parseHeadDate, parseGitRemotes, parseGitBranches, buildDockerGitArgv } from './gitStatus.js';
import { buildInProgressScript, GIT_LOG_PRETTY, parseGitLogLine, parseGitShowNameStatus, GIT_DIFF_MAX_BYTES, capDiff, buildGitDiffScript, isPathWithinCwd, isSafeRelativePath, isValidGitHash, parseGitBlame, buildGitBlameScript, parseGitLsEntries } from './git.js';

// The host sentinel for "run on this machine, not over SSH" (mirrors server.js's
// LOCAL — duplicated rather than imported to keep this a leaf module; the test suites
// already hardcode this same string).
const LOCAL = '(local)';


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
export function runLocalCapture(bin, args, { cwd, timeout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = timeout ? setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* noop */ } }, timeout) : null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr, error: err });
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}


// Run git locally, async (non-blocking). Used by /api/git-status, /api/git-log,
// /api/git-diff, /api/git-blame and the manual-LOCAL branch of runGit. Captures
// stdout/stderr as strings (see runLocalCapture) and centralizes windowsHide so a
// local git call never flashes a visible console window when warden runs as a
// packaged/detached app. Remote chats go through run() (ssh.js), which is already
// async and hides. Returns { ok, code, stdout, stderr }.
async function runLocalGit(args, cwd) {
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
export async function runGit(chat, args, cwd) {
  if (chat.container) {
    if (chat.host === LOCAL) {
      const argv = buildDockerGitArgv(chat.container, cwd, args);
      return runLocalCapture(argv[0], argv.slice(1));
    }
    const a = args.map(shellQuote).join(' ');
    return run(chat.host, `docker exec ${shellQuote(chat.container)} git -C ${shellQuote(cwd)} ${a} 2>/dev/null`, { timeout: 8000 });
  }
  if (chat.host === LOCAL) {
    return runLocalGit(args, cwd);
  }
  const a = args.map(shellQuote).join(' ');
  return run(chat.host, `cd ${shellQuote(cwd)} && git ${a} 2>/dev/null`, { timeout: 8000 });
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
export async function runInContext(chat, script, { timeout = 8000 } = {}) {
  if (chat.container) {
    if (chat.host === LOCAL) {
      return runLocalCapture('docker', ['exec', chat.container, 'bash', '-lc', script]);
    }
    return run(chat.host, `docker exec ${shellQuote(chat.container)} bash -lc ${shellQuote(script)}`, { timeout });
  }
  return run(chat.host, script, { timeout });
}


// Read+trim a git marker file under git-dir `gd`. Returns '' on any error (the
// file is absent or unreadable) so a partial marker state never throws — only
// used by detectInProgress's manual-LOCAL host-fs path, which (unlike the script
// path) reaches the marker files on this machine's fs directly.
function readMarker(gd, name) {
  try {
    return fs.readFileSync(path.join(gd, name), 'utf8').trim();
  } catch {
    return '';
  }
}


// Shorten a hex object name (40-char SHA from a marker file) to the ~7-char
// display form git's own `rev-parse --short` produces, mirroring the headSha
// discipline at the /api/git-status route. A non-hex value (a ref name, should a
// marker ever hold one) is returned verbatim — never mis-truncated. null when
// empty so the caller can omit the segment entirely.
function shortObjName(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return /^[0-9a-f]{7,40}$/i.test(s) ? s.slice(0, 7) : s;
}


// Parse a non-negative integer marker value (msgnum/end), or null when it is
// absent/non-numeric — so a missing step file degrades to a skipped segment
// rather than a misleading "0".
function parseStepNum(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}


// Parse ONE in-progress-operation record into { operation, detail } (WARDEN-511).
// The record is the line buildInProgressScript echoes — a bare operation
// (`bisect`, or `rebase` for the step-less rebase-apply backend) or
// `op|<raw marker values>`:
//   merge|<MERGE_HEAD-sha>   cherry-pick|<sha>   revert|<sha>
//   rebase|<msgnum>|<end>|<onto>|<stopped-sha>
// Pure + exported so BOTH detectInProgress code paths share it: the in-context
// script path feeds the first stdout line; the manual-LOCAL host-fs path builds
// the identical record from readMarker and feeds it — guaranteeing the same
// detail for the same on-disk state regardless of transport, and giving the
// detail logic one unit-testable seam (mirrors buildInProgressScript). Returns
// { operation: null, detail: null } for a blank line (graceful, never throws).
// detail is null when no progress info is available: bisect, rebase-apply, a
// rebase-merge state with no step files yet, or an empty *_HEAD. The detail is a
// display-ready fragment the badge appends after "<op> in progress · ".
export function parseInProgressDetail(line) {
  const trimmed = String(line == null ? '' : line).trim();
  if (!trimmed) return { operation: null, detail: null };
  const sep = trimmed.indexOf('|');
  const operation = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const tail = sep === -1 ? '' : trimmed.slice(sep + 1);
  let detail = null;
  if (operation === 'merge' || operation === 'cherry-pick' || operation === 'revert') {
    // tail is the full SHA from the *_HEAD file — the commit being applied.
    detail = shortObjName(tail);
  } else if (operation === 'rebase') {
    // rebase-merge step files: msgnum/end (step N/M), onto (the new base SHA),
    // stopped-sha (the commit that failed to apply). onto/stopped-sha are hex
    // object names → shortened; each present piece joins the detail, so a
    // partial state (e.g. stopped-sha absent early in a rebase) still renders
    // whatever subset exists. All absent → null (rebase-apply degrades here too,
    // since its backend never carries these files).
    const [msgnum, end, onto, stopped] = tail.split('|');
    const mn = parseStepNum(msgnum);
    const en = parseStepNum(end);
    const ontoShort = shortObjName(onto);
    const stoppedShort = shortObjName(stopped);
    const parts = [];
    if (mn && en) parts.push(`${mn}/${en}`);
    if (ontoShort) parts.push(`onto ${ontoShort}`);
    if (stoppedShort) parts.push(`stopped at ${stoppedShort}`);
    detail = parts.length ? parts.join(' · ') : null;
  }
  // bisect (and any unknown operation) carry no progress detail — operation
  // name alone, exactly as before WARDEN-511.
  return { operation, detail };
}


// Detect an in-progress git operation (merge/cherry-pick/revert/rebase/bisect)
// and, where git records it, the progress detail (rebase step N/M · onto ·
// stopped-sha; the SHA being applied for merge/cherry-pick/revert). manual-LOCAL
// stats the marker files on the host fs and feeds the shared parseInProgressDetail
// seam a record built from readMarker; every other transport (yatfa local+remote,
// manual-remote) runs buildInProgressScript in-context and feeds its first stdout
// line to the same parser — the marker files live beyond the host fs (in-container
// or on the remote host), so only a shell `test`+`cat` delivered there can reach
// them. Returns { operation, detail } (both null when nothing is in progress).
// Display only, read-only — never mutates the repo (WARDEN-28, WARDEN-511).
async function detectInProgress(chat, cwd) {
  if (!chat.container && chat.host === LOCAL) {
    const gitDirResult = await runLocalGit(['rev-parse', '--git-dir'], cwd);
    const gitDir = gitDirResult.stdout.trim() || '';
    if (!gitDir) return { operation: null, detail: null };
    const gd = path.resolve(cwd, gitDir);
    if (fs.existsSync(path.join(gd, 'MERGE_HEAD')))
      return parseInProgressDetail(`merge|${readMarker(gd, 'MERGE_HEAD')}`);
    if (fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD')))
      return parseInProgressDetail(`cherry-pick|${readMarker(gd, 'CHERRY_PICK_HEAD')}`);
    if (fs.existsSync(path.join(gd, 'REVERT_HEAD')))
      return parseInProgressDetail(`revert|${readMarker(gd, 'REVERT_HEAD')}`);
    if (fs.existsSync(path.join(gd, 'rebase-merge')))
      return parseInProgressDetail(`rebase|${readMarker(gd, 'rebase-merge/msgnum')}|${readMarker(gd, 'rebase-merge/end')}|${readMarker(gd, 'rebase-merge/onto')}|${readMarker(gd, 'rebase-merge/stopped-sha')}`);
    // rebase-apply (the older git rebase / git pull --rebase backend) has NO
    // step files — surface the operation with a null detail rather than a
    // misleading "step 0/0".
    if (fs.existsSync(path.join(gd, 'rebase-apply'))) return { operation: 'rebase', detail: null };
    if (fs.existsSync(path.join(gd, 'BISECT_LOG'))) return { operation: 'bisect', detail: null };
    return { operation: null, detail: null };
  }
  const r = await runInContext(chat, buildInProgressScript(cwd));
  const firstLine = (r.stdout || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return parseInProgressDetail(firstLine);
}


// Strip a commit message's subject line so only the BODY shows in an expanded
// commit. git's `%B` (raw body, fetched by commitMessage below) is
// "<subject>\n\n<body>…": the collapsed row already shows the subject (cm.subject),
// so rendering raw `%B` would echo the subject again as the first line. We keep
// only the body AFTER the first blank line. A subject-only commit (no blank line,
// i.e. no body) → '' so the UI renders nothing extra for it. CRLF-tolerant so a
// remote transport's \r\n doesn't hide the split. Exported (pure) so the
// subject-strip rule has a unit test (WARDEN-388).
export function stripCommitSubject(raw) {
  const s = (raw ?? '').toString().replace(/\r\n/g, '\n');
  const i = s.indexOf('\n\n');
  return i === -1 ? '' : s.slice(i + 2).trim();
}


// WARDEN-498: the commit-search window (shared by message grep AND WARDEN-559
// pickaxe — both may need to reach far down history). Browse caps at 50 (limit
// clamped to [1,50] in the handler), but search exists to FIND a commit that may
// sit far down history, so it uses this larger ceiling instead. A few hundred
// covers a long project history without an unbounded scan; still bounded so a huge
// repo can't exhaust argv or the response. Absent `grep`/`pickaxe` never reaches
// this path (browse keeps `limit`).
const GIT_LOG_GREP_MAX = 200;


// ---- Per-file git diff (WARDEN-151) ----------------------------------------
// The depth layer between WARDEN-107 (which files changed) and WARDEN-39 (read
// the current file): show WHAT an agent changed in one file. Mirrors
// /api/git-status + /api/read-file: chat-scoped, cwd-contained, local async runLocalGit
// vs remote `run(host, script)`, with the same path-traversal discipline read-file
// guards against. A diff target may be a DELETED file (status 'D') that no longer
// exists on disk, so the containment check must tolerate a missing path — unlike
// read-file's `realpath -e` (which requires existence).

// Diff two arbitrary working-tree file CONTENTS against each other (NOT vs HEAD)
// — the A↔B cross-agent compare (WARDEN-593). Writes both contents to temp files
// under os.tmpdir() and runs `git diff --no-index`, the SAME diff engine Warden
// uses everywhere (no new dependency): --no-index diffs two paths git does not
// track, which is exactly what two agents' independently-staged working-tree blobs
// are. Output is capped via capDiff (the shared 1MB guard), exactly like
// /api/git-range-diff. Temp files are removed in a `finally` so a failed diff
// never leaks scratch files into os.tmpdir().
//
// CRITICAL gotcha (load-bearing): `git diff --no-index` exits 1 when the two files
// DIFFER (that is SUCCESS — a diff was produced) and 0 when they are IDENTICAL.
// Only exit codes >1 are failures. This inverts the usual "non-zero = error"
// reading, so the success check is `code === 0 || code === 1`, NOT `r.ok` (which
// is `code === 0`): reading `r.ok` here would classify EVERY real diff as an error.
// Exported so the exit-0-identical / exit-1-differ discipline has a direct test.
export async function diffNoIndex(contentA, contentB, filePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cross-agent-'));
  try {
    // A safe basename so the diff header names the file meaningfully; the A-/B-
    // prefix labels the two sides in the `--- a/.../A-<name>` / `+++ b/.../B-<name>`
    // headers — the same unified-diff primitive DiffBlock colorizes for every other
    // diff view. Sanitized + length-capped so a hostile/odd path can't shape the
    // temp filename.
    const base = (path.basename(filePath || 'file').replace(/[^A-Za-z0-9._-]/g, '_') || 'file').slice(0, 64);
    const fileA = path.join(tmpDir, `A-${base}`);
    const fileB = path.join(tmpDir, `B-${base}`);
    fs.writeFileSync(fileA, contentA ?? '');
    fs.writeFileSync(fileB, contentB ?? '');
    const r = await runLocalCapture('git', ['diff', '--no-index', fileA, fileB]);
    if (r.code !== 0 && r.code !== 1) {
      // >1 (or spawn failure → -1): a real git error, not "files differ". Surface
      // stderr cleanly; never throw (the route folds this into never-500 { diff, error }).
      const detail = (r.stderr || '').trim();
      return { error: detail ? `diff failed: ${detail}` : 'diff failed' };
    }
    // code 0 → identical (empty stdout); code 1 → differ (a diff was produced). Both
    // success; an empty stdout on the identical case is the genuine, useful signal.
    return { diff: capDiff(r.stdout || '') };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}


// Diff one file vs HEAD on a LOCAL host. Returns { diff, untracked } or
// { error, status }. An empty diff is ambiguous (clean tracked vs untracked '??'),
// so it's disambiguated with `git ls-files --error-unmatch` (exits non-zero for a
// path git doesn't track) — letting the UI say "untracked" instead of "no changes".
// Output is capped at GIT_DIFF_MAX_BYTES to protect the server. Exported for tests.
//
// `staged` (WARDEN-369) runs `git diff --cached` (index-vs-HEAD, exactly what will
// be committed) instead of `git diff HEAD` (combined staged+unstaged). Read-only.
//
// `rangeRev` (WARDEN-601) — a fixed server-validated literal range ('@{u}..HEAD') —
// runs `git diff <rangeRev> -- <path>` (the file's change across the range) instead of
// the working-tree diff, so the impending-conflict committer's panel can show its
// OUTGOING change to the path (its working tree is clean, so the default `git diff
// HEAD` would be empty and misclassify as 'already resolved'). rangeRev is passed as a
// single argv element (no shell on the LOCAL transport) so @{u}..HEAD stays brace-
// expansion-safe. Read-only. Containment (isPathWithinCwd) is unchanged — the pathspec
// `-- <path>` still applies identically regardless of the rev.
export async function getLocalGitDiff(cwd, filePath, staged, rangeRev) {
  if (!isPathWithinCwd(cwd, filePath)) {
    return { error: 'path must be within working directory', status: 403 };
  }

  const args = rangeRev
    ? ['diff', rangeRev, '--', filePath]
    : (staged ? ['diff', '--cached', '--', filePath] : ['diff', 'HEAD', '--', filePath]);
  const result = await runLocalGit(args, cwd);
  let diff = capDiff(result.stdout || '');

  if (diff.length === 0) {
    // Empty diff is ambiguous: a clean tracked file vs an untracked ('??') file HEAD
    // has no record of. `git ls-files --error-unmatch` exits non-zero for a path git
    // doesn't track. (Containment above already guaranteed the path is within cwd, so
    // a non-zero exit here means untracked, not "outside repo".) For staged mode an
    // empty diff means "nothing staged for this path" — the file is tracked, so this
    // check returns tracked and the empty diff flows through unchanged.
    const tracked = await runLocalGit(['ls-files', '--error-unmatch', '--', filePath], cwd);
    if (!tracked.ok) return { diff: null, untracked: true };
  }

  return { diff, untracked: false };
}
// Build the git `/api/*` router. `resolve` is server.js's chat resolver (closes over
// the live chat cache, so every route sees the same cache the rest of the app does);
// `readWorkingTreeFile` / `isBinaryFile` / `isBinaryBlob` are the read-file guards the
// cross-agent-diff and git-cat-file / git-conflict routes reuse. Passed in (not
// imported) so this module never depends on server.js — same factory-injection shape
// the WARDEN-677 proposal recommended for route layers that need shared server state.
export function createGitRouter({ resolve, readWorkingTreeFile, isBinaryFile, isBinaryBlob }) {
  const router = express.Router();


  // Collapse the duplicated control-flow prelude hand-copied across every /api/git-*
  // route into ONE place (WARDEN-645). Owns ONLY the boilerplate the routes duplicated:
  //   resolve(chatId) → 404 on unknown id   (NOT 200 — the routes are deliberate about
  //       this 404-vs-200 split, so the wrapper preserves it)
  //   route-specific validate(req) → 200 (or a route-chosen status) short-circuit on bad
  //       input (hex hash / stash ref / path guards)
  //   gitCwd(chat) → graceful 'no cwd' empty contract (200, never a 500)
  //   try/catch → 200 { ...defaults, error } on any thrown error (never a 500)
  // The route BODY (the runGit calls + parsers) stays in `handler`, which receives `res`
  // so its existing res.json / res.status calls work byte-for-byte — only the prelude is
  // hoisted; the body is unchanged. This is the route-layer finish to WARDEN-606 (which
  // extracted only the pure parsers/script-builders into git.js): the transport layer
  // (runGit) and parser layer (gitStatus.js + git.js) were already extracted; the route
  // layer was the last un-extracted frontier in this 4,800-line file.
  //
  // Options:
  //   validate(req)   optional. null/undefined to continue; otherwise { status?, body }
  //                   to short-circuit (status defaults 200). Returning the FULL body
  //                   (not just an error key) lets each route reproduce its exact
  //                   validation-failure shape verbatim — incl. git-blame's
  //                   { lines: [], error: null } empty-path "success" and git-conflict's
  //                   path-bearing contract.
  //   defaults        object | (chat, req) => object. The empty contract spread into the
  //                   'no cwd' and catch responses. A function for routes whose empty
  //                   contract carries chat state (git-status / git-ls use chat.cwd).
  //                   When 'no cwd' fires chat.cwd is always falsy (gitCwd returns '' only
  //                   when chat.cwd is absent), so `chat.cwd || ''` reproduces the
  //                   hand-written `cwd: ''` no-cwd body there exactly.
  //   notFoundEmpty   when true, the unknown-id 404 carries the route's empty contract
  //                   ({ ...defaults, error }) instead of the bare { error } most routes
  //                   emit. git-diff / git-conflict / git-range-diff set this.
  //   catchError      string | (e, chat) => string. The error string spread into the
  //                   catch response. Defaults to e.message; git-ls passes 'ls failed'.
  //   handler({chat,cwd,req,res})  the route body, unchanged. Responds via res itself.
  async function withGitRepo(req, res, { validate, defaults, notFoundEmpty, catchError, handler }) {
    const chatId = String(req.query.id || '');
    const { chat, error } = await resolve(chatId);
    if (error) {
      return res.status(404).json(notFoundEmpty ? { ...gitDefaults(defaults, null, req), error } : { error });
    }

    if (validate) {
      const v = validate(req);
      if (v) {
        if (v.status) return res.status(v.status).json(v.body);
        return res.json(v.body);
      }
    }

    try {
      const cwd = gitCwd(chat);
      if (!cwd) return res.json({ ...gitDefaults(defaults, chat, req), error: 'no cwd' });
      await handler({ chat, cwd, req, res });
    } catch (e) {
      const msg = typeof catchError === 'function' ? catchError(e, chat) : (catchError ?? e.message);
      res.json({ ...gitDefaults(defaults, chat, req), error: msg });
    }
  }


  // Resolve a route's `defaults` option to a plain object. Usually a static literal
  // ({ commits: [] }, { files: [], diff: null }, …); a handful of routes whose empty
  // contract carries chat state (git-status, git-ls) pass a function. `chat` is null on
  // the 404 path (resolve failed before we had a chat) — the routes that set
  // notFoundEmpty carry only query-derived state (filePath / dir) in their defaults,
  // never chat, so the null is never dereferenced there.
  function gitDefaults(defaults, chat, req) {
    if (typeof defaults === 'function') return defaults(chat, req);
    return defaults || {};
  }


  router.get('/api/git-status', async (req, res) => {
    // defaults carries `cwd: chat.cwd || ''`. The hand-written no-cwd body used the
    // literal `cwd: ''` and the catch used `cwd: chat.cwd || ''`; these are identical
    // on the no-cwd path (gitCwd returns '' only when chat.cwd is absent, so
    // `chat.cwd || ''` is '' there too — see gitCwd), so one function serves both.
    await withGitRepo(req, res, {
      defaults: (chat) => ({ branch: null, detached: false, headSha: null, headDate: null, clean: null, cwd: chat.cwd || '', ahead: null, behind: null, upstream: null, inProgress: { operation: null, detail: null }, stashCount: null, diffstat: null, files: null, outgoingFiles: null }),
      handler: async ({ chat, cwd, res }) => {
        // branch / status / ahead-behind / detached / stash all run via runGit: argv
        // (no shell) for the LOCAL transports, ssh for the remote ones — and for yatfa
        // chats (container set) each call is wrapped in `docker exec … git -C <cwd>` so
        // git runs INSIDE the container against the in-container path (WARDEN-235).
        // The old per-transport if/else collapses into one runGit call per probe; the
        // detached-HEAD detection (WARDEN-239) rides the same transport so it lights
        // up for yatfa agents too.
        const branchR = await runGit(chat, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
        const branch = branchR.ok ? branchR.stdout.trim() : '';

        const statusR = await runGit(chat, ['status', '--porcelain'], cwd);
        // NOTE: parse the raw bytes — git status codes can start with a leading
        // space (" M" = unstaged mod), so the output must NOT be trimmed as a
        // whole or the first file's path is corrupted. See parseGitStatusPorcelain.
        const files = parseGitStatusPorcelain(statusR.ok ? statusR.stdout : '');
        const clean = files.length === 0;

        // ahead/behind upstream: @{u}...HEAD symmetric diff. Non-zero exit (no
        // upstream, detached HEAD, non-git cwd) → empty stdout → nulls. See parseAheadBehind.
        const abR = await runGit(chat, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd);
        const { ahead, behind } = parseAheadBehind(abR.ok ? abR.stdout : '');

        // Upstream tracking branch (WARDEN-243). `git rev-parse --abbrev-ref @{u}`
        // prints the short upstream name (e.g. origin/feature) + exit 0 when one is
        // configured, and exits non-zero with empty stdout when HEAD has NO upstream
        // — a named branch never `push -u`'d. ahead/behind alone can't tell that
        // branch from a synced 0/0 one (both → nulls with no @{u}), so without this
        // a never-pushed branch renders as a bare cyan label indistinguishable from
        // in-sync: a durability risk (local-only work, no remote backup) a human
        // needs to see at a glance. Same `@{u}` rev spec + runGit transport as the
        // ahead/behind call above (so it lights up for yatfa containers too,
        // WARDEN-235) and shellQuote'd on the remote branch inside runGit (the
        // WARDEN-122 brace-expansion lesson — `@{u}` must not reach a shell bare).
        const upR = await runGit(chat, ['rev-parse', '--abbrev-ref', '@{u}'], cwd);
        const upstream = parseUpstream(upR.ok ? upR.stdout : '');

        // Detached-HEAD detection (WARDEN-239). `git symbolic-ref -q HEAD` exits
        // non-zero iff HEAD is detached (it prints refs/heads/<name> + exit 0 when on
        // a branch) — the canonical test, more reliable than `branch === 'HEAD'` (a
        // branch could in principle be named "HEAD"). Run via runGit so it ALSO works
        // inside a yatfa container (WARDEN-235). Guarded by `branch` (truthy ⟺ the
        // rev-parse above succeeded ⟺ we're inside a real repo) so a NON-git cwd —
        // where symbolic-ref also fails — is NOT misread as detached. The short SHA
        // replaces the misleading literal "HEAD" label the badge would otherwise show;
        // it's only fetched when detached to keep the normal branch path's command
        // set unchanged.
        const symRefResult = await runGit(chat, ['symbolic-ref', '-q', 'HEAD'], cwd);
        const detached = isDetachedHead(symRefResult.code, !!branch);
        let headSha = null;
        if (detached) {
          const shaResult = await runGit(chat, ['rev-parse', '--short', 'HEAD'], cwd);
          headSha = normalizeHeadSha(shaResult.stdout, shaResult.code);
        }

        // Last-commit freshness (WARDEN-545): `git log -1 --format=%cI HEAD` prints
        // the strict ISO-8601 committer date of HEAD. Fetched UNCONDITIONALLY for any
        // repo with a branch — deliberately NOT inside `if (detached)` above — so a
        // normally-committing BRANCH agent that has gone quiet (committed days ago,
        // silent since) is the one that lights up. `headSha` is detached-only (it
        // merely relabels the "HEAD" string), but freshness must reach the branch
        // agents that are its actual target; gating it on `if (detached)` would make
        // the marker render only for detached-HEAD agents and defeat the purpose. A
        // single rev, ~free. Nulls naturally on an unborn branch / non-git cwd
        // (`git log` errors → non-zero exit → parseHeadDate returns null). Same
        // runGit transport as the probes above, so it runs inside yatfa containers
        // via `docker exec … git -C <cwd>` too (WARDEN-235).
        const headDateR = await runGit(chat, ['log', '-1', '--format=%cI', 'HEAD'], cwd);
        const headDate = parseHeadDate(headDateR.ok ? headDateR.stdout : '', headDateR.code);

        const inProgressState = await detectInProgress(chat, cwd);

        // Shelved WIP: `git stash list` emits one line per stash, empty when none.
        // --porcelain status never surfaces stashes, so a clean tree with parked work
        // would otherwise read clean:true — count the list so the badge can show 🗄️ N
        // (WARDEN-211). Non-git/empty → parseStashCount nulls it.
        const stashR = await runGit(chat, ['stash', 'list'], cwd);
        const stashCount = parseStashCount(stashR.ok ? stashR.stdout : '');

        // Working-tree WIP magnitude (WARDEN-411): `git diff HEAD --shortstat` prints
        // a one-line "N files changed, N insertions(+), N deletions(-)" summary of the
        // combined (staged + unstaged) edits vs HEAD. Where stashCount surfaces PARKED
        // work and the porcelain file list surfaces WHICH files are dirty, this surfaces
        // HOW MUCH — a 4-file WIP could be four one-line tweaks or a 1000-line rewrite,
        // and this is the only signal that distinguishes them at a glance. Read-only
        // (the withdrawn WARDEN-199 branch-switch slice is the cautionary tale; this
        // stays on the read side). Same runGit transport as the probes above, so it runs
        // inside yatfa containers via `docker exec … git -C <cwd>` too (WARDEN-235).
        // parseDiffStat nulls empty/garbage (incl. a clean tree and an all-untracked
        // WIP — `git diff HEAD` counts tracked edits only); the `branch` gate keeps
        // non-git/detached consistent with stashCount.
        const diffstatR = await runGit(chat, ['diff', 'HEAD', '--shortstat'], cwd);
        const diffstat = parseDiffStat(diffstatR.ok ? diffstatR.stdout : '');

        // Outgoing (unpushed-commit) changed-file set (WARDEN-601): `git diff --name-only
        // @{u}..HEAD` lists the files touched by the agent's local commits that @{u}
        // (upstream) doesn't have yet — the join key for the IMPENDING cross-agent file-
        // conflict detector. Where `files` (porcelain) surfaces working-tree WIP and
        // ahead/behind surface the COUNT of unpushed/incoming commits, this surfaces
        // WHICH paths are in the unpushed set, so the detector can flag the case the
        // working-tree×working-tree join is blind to: agent A committed F (clean tree →
        // contributes nothing to the WIP join) while agent B has F dirty — B's next pull
        // (after A pushes) collides on F. Read-only (the WARDEN-199 line: a `git diff
        // --name-only` over a range is a pure read). One more git call in a route that
        // already runs @{u} rev-lists, gated on `branch && ahead > 0` so a non-git /
        // detached / in-sync agent pays nothing and reads null (mirroring the ahead/files
        // gating). Same runGit transport as the probes above, so it runs inside yatfa
        // containers via `docker exec … git -C <cwd>` too (WARDEN-235). parseOutgoingFiles
        // returns [] for empty; the `branch && ahead > 0` gate below nulls it otherwise.
        let outgoingFiles = null;
        if (branch && typeof ahead === 'number' && ahead > 0) {
          const outR = await runGit(chat, ['diff', '--name-only', '@{u}..HEAD'], cwd);
          outgoingFiles = parseOutgoingFiles(outR.ok ? outR.stdout : '');
        }

        res.json({
          branch: branch || null,
          // detached: true only inside a real repo whose HEAD is not on a branch.
          // headSha: the short SHA shown in place of the misleading "HEAD" label.
          // The branch ? gate is kept so files/clean/inProgress still surface on a
          // detached HEAD (you still want to see uncommitted changes); ahead/behind
          // are already null there (parseAheadBehind returns nulls with no @{u})
          // (WARDEN-239).
          detached,
          headSha,
          clean: branch ? clean : null,
          cwd,
          ahead: branch ? ahead : null,
          behind: branch ? behind : null,
          // upstream: the short tracking branch name (e.g. origin/feature), or null
          // when HEAD has no upstream — gated on `branch` like ahead/behind so a
          // detached HEAD / non-git cwd reads null (WARDEN-243). ahead/behind are
          // already null there, so this is what lets the badge tell a never-pushed
          // branch from a synced 0/0 one.
          upstream: branch ? upstream : null,
          inProgress: { operation: branch ? inProgressState.operation : null, detail: branch ? inProgressState.detail : null },
          stashCount: branch ? stashCount : null,
          // diffstat: net insertions/deletions of the working-tree edits vs HEAD
          // (WARDEN-411), or null for a clean / non-git / detached repo. Gated on
          // `branch` like stashCount; parseDiffStat already nulls an all-untracked WIP.
          diffstat: branch ? diffstat : null,
          // headDate: the last-commit freshness of HEAD (strict ISO-8601 committer
          // date from `git log -1 --format=%cI`), gated on `branch` like the other
          // derived fields so a non-git cwd reads null. Rendered as an always-on
          // `· Nd` append on the badge so a human can spot a synced-but-stalled agent
          // (WARDEN-545); fetched unconditionally above (not detached-only).
          headDate: branch ? headDate : null,
          files: branch ? files : null,
          // outgoingFiles: the unpushed-commit changed-file set (WARDEN-601), or null for
          // a non-git / detached / in-sync (ahead 0) repo. Gated on `branch && ahead > 0`
          // like the other derived fields so a clean agent reads null (zero noise for the
          // impending-conflict detector); a repo with unpushed commits reads its outgoing
          // path list (possibly empty if the range touches nothing).
          outgoingFiles: branch && typeof ahead === 'number' && ahead > 0 ? outgoingFiles : null,
          error: null,
        });
      },
    });
  });


  // Which remote repo a checkout points at + its web host URL (WARDEN-528). The one
  // coordination fact a multi-project human needs that every OTHER git facet omits:
  // `git status` exhaustively surfaces local state (branch/ahead/behind/diff/…) but
  // never WHICH source host the working tree maps to. `git remote -v` does, and from
  // its URLs we derive `{ host, owner, repo, web }` so the branch badge can show
  // `github · owner/repo` and deep-link the branch/HEAD/upstream to the host.
  //
  // Mirrors /api/git-status exactly: resolve(chatId) → 404 guard → gitCwd(chat) →
  // graceful `{ remotes: [] }` when no cwd / non-git / zero remotes (never 500).
  // `git remote -v` is read-only (no `-v` mutation path exists), and runGit routes
  // it through the same transport as the status probes (argv `docker exec … git -C`
  // for yatfa containers, ssh for manual-remote) so it lights up for every agent
  // kind. parseGitRemotes (gitStatus.js) dedupes the fetch/push duplicate per remote
  // and parses each URL; empty/non-git stdout → [].
  router.get('/api/git-remote', async (req, res) => {
    await withGitRepo(req, res, {
      defaults: { remotes: [] },
      handler: async ({ chat, cwd, res }) => {
        const remoteR = await runGit(chat, ['remote', '-v'], cwd);
        const remotes = parseGitRemotes(remoteR.ok ? remoteR.stdout : '');
        res.json({ remotes, error: null });
      },
    });
  });


  // Recent commit history (git log) for a chat's repo. All transports go through
  // runGit (WARDEN-235): manual-local async runLocalGit, manual-remote SSH, and yatfa
  // containers via `docker exec … git -C <cwd>`. A non-git or no-cwd repo yields an
  // empty list (never a 500). limit is clamped to [1, 50]. An optional `path` filters
  // to file-history mode (git log --follow -- <path>, WARDEN-319). An optional `grep`
  // searches commit MESSAGES (git log --grep=<term> -i, WARDEN-498) over a wider
  // window (GIT_LOG_GREP_MAX) so an old commit is findable. An optional `pickaxe`
  // searches commit-history DIFFS (git log -S<term>, or -G<term> with pickaxeRegex=1,
  // WARDEN-559) — finds the commit that ADDED or REMOVED a code string — over the same
  // wider window. All three filters are read-only flags to the permitted `git log`
  // subcommand; absent any ⇒ byte-for-byte today's behavior.
  router.get('/api/git-log', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10) || 5, 1), 50);
    // range selects a commit window:
    //   incoming → HEAD..@{u}  (commits @{u} has that HEAD doesn't — the "behind" list)
    //   outgoing → @{u}..HEAD  (commits HEAD has that @{u} doesn't — the "unpushed/ahead" list)
    //   absent   → today's HEAD-reachable log.
    // @{u} is git's upstream rev spec, already used by /api/git-status's ahead/behind
    // count, so this introduces no new staleness or network fetch. The ahead/behind
    // COUNT shipped in WARDEN-153; the behind LIST in WARDEN-225; this completes the
    // explorable ahead half (WARDEN-252). Strictly read-only — no fetch/pull/merge/checkout.
    const range = String(req.query.range || '');
    const rangeRev = range === 'incoming' ? 'HEAD..@{u}' : range === 'outgoing' ? '@{u}..HEAD' : null;
    // Optional path filter (WARDEN-319): when present, switch to file-history mode —
    // list every commit that touched this ONE file (`git log --follow -- <path>`),
    // the temporal counterpart to blame. A git pathspec validated with the same
    // isSafeRelativePath the per-file git-show route uses (WARDEN-151). Absent `path`
    // → byte-for-byte today's behavior (existing callers send none).
    const filePath = String(req.query.path || '').trim();
    // Optional commit-message search (WARDEN-498): when present, splice
    // `git log --grep=<term> -i` so a human can find WHEN a change landed by message
    // instead of scrolling the per-agent commit lists. Mirrors how `path` was added
    // (WARDEN-319): parsed here, length-capped (≤128) to bound argv, passed as a SINGLE
    // argv element locally and shellQuote'd remotely (WARDEN-122 — the `=` stays one
    // argument; never let it reach a shell). `-i` makes it case-insensitive; `--grep`
    // matches the full message (subject + body) by default — exactly what WARDEN-387/388
    // made visible. Absent `grep` → byte-for-byte today's behavior (existing callers send
    // none).
    const grep = String(req.query.grep || '').trim().slice(0, 128);
    // Optional content-history search (WARDEN-559): pickaxe — `git log -S<term>`
    // (default) finds commits that ADDED or REMOVED the string (changed its occurrence
    // count — the precise "where did this land" signal); `git log -G<term>`
    // (pickaxeRegex=1) matches the regex against the diff (broader). Mirrors `grep`
    // byte-for-byte: parsed here, length-capped (≤128) to bound argv, passed as a
    // SINGLE argv element locally and shellQuote'd remotely (WARDEN-122 — the `=`-less
    // `-S` stays one argument, never reaching a shell). Absent `pickaxe` → byte-for-byte
    // today's behavior (existing callers send none); composes with `grep` (a user may
    // want both), `range`, and `path` (the filePath branch below already uses
    // searchLimit, so it widens automatically).
    const pickaxe = String(req.query.pickaxe || '').trim().slice(0, 128);
    const pickaxeRegex = req.query.pickaxeRegex === '1';
    await withGitRepo(req, res, {
      defaults: { commits: [] },
      // Reject unsafe per-file paths (absolute / traversal) before any git invocation —
      // mirrors git-show's isSafeRelativePath guard. Bad path → empty list, never a 500.
      validate: () => (filePath && !isSafeRelativePath(filePath)
        ? { body: { commits: [], error: 'invalid path' } }
        : null),
      handler: async ({ chat, cwd, res }) => {
        // short hash | subject | author | relative date | committer epoch (GIT_LOG_PRETTY).
        // runGit passes
        // --pretty (and the range rev) as a single argv element (no shell on the LOCAL
        // branch) so the '|' separators can't be read as pipes and the @{u}..HEAD range
        // stays brace-expansion-safe; the remote branch shellQuotes each arg for the same
        // reason (WARDEN-122). yatfa chats run this inside the container (WARDEN-235).
        // range=incoming/outgoing splices in the corresponding rev; absent → HEAD log.
        // WARDEN-498: a present `grep` splices `--grep=<term>` + `-i` (case-insensitive,
        // matches subject AND body) as the FIRST log options — before the limit/range/pretty
        // args — and widens the window to GIT_LOG_GREP_MAX (an old commit may sit beyond the
        // 50-commit browse cap; the point of search is to FIND it). WARDEN-559: a present
        // `pickaxe` splices `-S<term>` (or `-G<term>` with pickaxeRegex) FIRST, alongside the
        // grep splice — a hit may sit beyond the 50-commit browse cap too, so it also widens
        // the window. The two splice independently (a user may pass both). Absent both ⇒
        // searchLimit === limit, so the browse path is byte-for-byte unchanged.
        const searchLimit = (grep || pickaxe) ? GIT_LOG_GREP_MAX : limit;
        const args = ['log'];
        if (pickaxe) args.push(pickaxeRegex ? `-G${pickaxe}` : `-S${pickaxe}`);
        if (grep) args.push(`--grep=${grep}`, '-i');
        if (filePath) {
          // File-history mode (WARDEN-319): --follow tracks the file across renames and
          // yields every commit that touched it (newest first). incoming/outgoing is a
          // repo-wide range concept that doesn't apply to one file's full history, so
          // rangeRev is intentionally NOT spliced here. `--follow` must precede --pretty
          // and the pathspec must be the single path after `--` (--follow requires exactly
          // one pathspec); `--` terminates option parsing so a path named like a flag
          // can't inject options — same WARDEN-122 discipline as git-show's per-file path.
          args.push(`-${searchLimit}`, '--follow', `--pretty=format:${GIT_LOG_PRETTY}`, '--', filePath);
        } else {
          if (rangeRev) args.push(rangeRev);
          args.push(`-${searchLimit}`, `--pretty=format:${GIT_LOG_PRETTY}`);
        }
        const r = await runGit(chat, args, cwd);
        const raw = r.ok ? r.stdout.trim() : '';

        const commits = raw ? raw.split('\n').map(parseGitLogLine) : [];
        res.json({ commits, error: null });
      },
    });
  });


  // Diff one file vs HEAD on a host whose git dir is NOT on this machine's fs —
  // i.e. a yatfa container (local OR remote: the cwd is an in-container path) or a
  // manual-remote host. Mirrors getLocalGitDiff's result shape and untracked
  // disambiguation, but the containment check lives inside buildGitDiffScript's
  // bash, delivered via runInContext (docker-exec for yatfa, ssh for manual-remote)
  // so the `cd <cwd>` + `realpath` resolve where the repo actually is. The remote
  // untracked check is a second runInContext (only when the diff is empty) so the
  // common case stays a single round-trip. See WARDEN-235.
  async function getDeliveredGitDiff(chat, cwd, filePath, staged, rangeRev) {
    const script = buildGitDiffScript(cwd, filePath, staged, rangeRev);
    const r = await runInContext(chat, script);
    if (!r.ok) {
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      if (out.includes('ERROR path must be within working directory')) {
        return { error: 'path must be within working directory', status: 403 };
      }
      if (out.includes('ERROR invalid path')) {
        return { error: 'invalid path', status: 400 };
      }
      // git diff exits non-zero on a non-git cwd or transport failure — surface as an
      // error string rather than a 500 (matches git-status/git-log's soft failure).
      return { error: 'diff failed' };
    }

    let diff = capDiff(r.stdout || '');

    if (diff.length === 0) {
      const trackedScript = `cd ${shellQuote(cwd)} && git ls-files --error-unmatch -- ${shellQuote(filePath)} 2>/dev/null`;
      const t = await runInContext(chat, trackedScript);
      if (!t.ok) return { diff: null, untracked: true };
    }

    return { diff, untracked: false };
  }


  // GET /api/git-diff?id=<chatId>&path=<file> — unified diff of one file vs HEAD.
  //   ?staged=1 — diff the INDEX vs HEAD instead (exactly what will be committed),
  //               so clicking a staged file shows its staged-only diff, not the
  //               combined worktree-vs-HEAD diff (WARDEN-369). `git diff --cached`
  //               is strictly read-only (see the contract comment below).
  // Response: { diff: string|null, untracked: boolean, path, error }
  router.get('/api/git-diff', async (req, res) => {
    const filePath = String(req.query.path || '').trim();
    if (!filePath) return res.status(400).json({ diff: null, untracked: false, path: '', error: 'path is required' });
    const staged = String(req.query.staged || '') === '1';
    // range=outgoing (WARDEN-601): diff the file across the unpushed (@{u}..HEAD) range
    // instead of the working tree, so the impending-conflict committer's per-agent panel
    // shows its OUTGOING change (its clean working tree would otherwise yield an empty
    // diff and misclassify as 'already resolved'). Validated to the fixed literal rev
    // '@{u}..HEAD' — anything else (including an unknown/garbage range) falls back to the
    // default working-tree diff (rangeRev null), so a stray param can never inject a rev
    // (mirroring /api/git-range-diff's rangeRev map discipline, WARDEN-398).
    const rangeParam = String(req.query.range || '').trim();
    const rangeRev = rangeParam === 'outgoing' ? '@{u}..HEAD' : null;
    await withGitRepo(req, res, {
      defaults: { diff: null, untracked: false, path: filePath },
      // The unknown-id 404 carries this route's path-bearing contract (not the bare
      // { error } most routes emit), so notFoundEmpty spreads `defaults` into the 404.
      notFoundEmpty: true,
      handler: async ({ chat, cwd, res }) => {
        // manual-LOCAL can stat the worktree on the host fs (getLocalGitDiff). Every
        // other transport — yatfa container (the cwd is in-container) or manual-remote
        // — runs the diff in-context via docker-exec/ssh (getDeliveredGitDiff), so the
        // realpath containment + git diff resolve where the repo actually lives.
        const result = (!chat.container && chat.host === LOCAL)
          ? await getLocalGitDiff(cwd, filePath, staged, rangeRev)
          : await getDeliveredGitDiff(chat, cwd, filePath, staged, rangeRev);

        if (result.status) return res.status(result.status).json({ diff: null, untracked: false, path: filePath, error: result.error });
        if (result.error) return res.json({ diff: null, untracked: false, path: filePath, error: result.error });
        res.json({ diff: result.diff, untracked: !!result.untracked, path: filePath, error: null });
      },
    });
  });


  // ---- Aggregated range diff (WARDEN-398) ------------------------------------
  // The net unified diff of an agent's whole unpushed (↑N) or incoming (↓N) set, as
  // ONE view — the literal completion of the per-commit exploration arc (WARDEN-252
  // ahead list / WARDEN-303 explorable / WARDEN-348 incoming / WARDEN-180 inline diff
  // / WARDEN-225 behind list). Today the GitBranchBadge popover shows the commit
  // LISTS and supports drilling into ONE commit at a time, but the question a human
  // actually asks — "what is this agent about to push?" / "what will land if I bring
  // it up to upstream?" — is answerable only by expanding N commits and mentally
  // aggregating. This diffs the two tips directly so the total change is visible at
  // once. Strictly read-only — no fetch/pull/merge/checkout (the WARDEN-199 line).
  //
  //   GET /api/git-range-diff?id=<chatId>&range=outgoing|incoming|worktree
  //     → { diff: string|null, error: string|null }
  //
  // Range semantics reuse /api/git-log's exact `range` param:
  //   outgoing → @{u}..HEAD   (the net change that lands on push)
  //   incoming → HEAD..@{u}   (the net change that lands on a pull)
  //   worktree → HEAD         (the combined staged+unstaged change vs HEAD — ± axis)
  // We use TWO-DOT (`@{u}..HEAD` ≡ `git diff @{u} HEAD`): the diff BETWEEN the two
  // tips = the honest "what changes when these two states meet." Three-dot would
  // diff from the merge-base (only HEAD's side since divergence); for a fast-forward
  // agent ahead of a still upstream the two are identical, and they diverge only if
  // upstream also moved — two-dot is the more honest "net" answer.
  //
  // Because there is NO user-supplied file pathspec, the realpath containment
  // ceremony of /api/git-diff (buildGitDiffScript / isPathWithinCwd) does NOT apply
  // — this route stays simple like /api/git-log. Output is capped at 1MB via capDiff.
  // A non-zero git exit is surfaced as a clean user-facing error — never a 500:
  //   outgoing/incoming with no upstream (or detached HEAD) → 'no upstream configured'
  //   worktree on an unborn HEAD (fresh repo, no commits)     → 'no commits yet ...'
  // mirroring how every other git route tolerates a non-git/no-upstream repo.
  router.get('/api/git-range-diff', async (req, res) => {
    const range = String(req.query.range || '');
    // Same rev map as /api/git-log (outgoing → @{u}..HEAD, incoming → HEAD..@{u}),
    // reused verbatim so the diff honors the identical range definition the commit
    // LIST already uses — the net diff over exactly those commits. worktree → 'HEAD'
    // runs `git diff HEAD` (no pathspec → combined staged+unstaged tracked changes vs
    // HEAD), the SAME set WARDEN-411's `git diff HEAD --shortstat` counts, so the
    // ± magnitude chip and the full-diff content stay consistent by construction.
    const rangeRev =
      range === 'outgoing' ? '@{u}..HEAD'
      : range === 'incoming' ? 'HEAD..@{u}'
      : range === 'worktree' ? 'HEAD'
      : null;
    await withGitRepo(req, res, {
      defaults: { diff: null },
      // The unknown-id 404 carries this route's contract ({ diff: null, error }), so
      // notFoundEmpty spreads `defaults` into the 404.
      notFoundEmpty: true,
      // Reject any range value other than outgoing/incoming/worktree cleanly — never a 500
      // (mirrors /api/git-show's rejection of a malformed hash: 200 + error string).
      validate: () => (rangeRev ? null : { body: { diff: null, error: 'invalid range' } }),
      handler: async ({ chat, cwd, res }) => {
        // runGit passes the range rev as a single argv element (no shell on the LOCAL
        // branch) so @{u}..HEAD stays brace-expansion-safe; the remote branch
        // shellQuotes it (WARDEN-122). yatfa chats run this inside the container
        // (WARDEN-235). `git diff @{u}..HEAD` exits non-zero when no upstream is
        // configured (or HEAD is detached) → surfaced as a clean user-facing error
        // rather than a 500. For worktree (`git diff HEAD`) the realistic non-zero is
        // an unborn HEAD (fresh repo, no commits) — unrelated to upstream, so the error
        // is range-aware: it says so rather than misleadingly claiming "no upstream".
        const r = await runGit(chat, ['diff', rangeRev], cwd);
        if (!r.ok) {
          return res.json({
            diff: null,
            error: range === 'worktree'
              ? 'no commits yet (nothing to compare against HEAD)'
              : 'no upstream configured',
          });
        }
        res.json({ diff: capDiff(r.stdout || ''), error: null });
      },
    });
  });


  // ---- Cross-agent A↔B working-tree diff (WARDEN-593) -------------------------
  // The direct compare that answers the ONE question a same-file collision raises:
  // do these two agents' edits actually collide on the same lines, or are they
  // disjoint? Today the "Compare edits" dialog fans out /api/git-diff per agent and
  // renders each agent's diff vs its OWN HEAD as stacked panels — leaving the human
  // to mentally overlay two independent diffs. This route diffs the two agents'
  // CURRENT working-tree versions of the file DIRECTLY against each other, so the
  // overlap (or lack of it) is legible at a glance. Sits ALONGSIDE the per-agent
  // panels (which still answer "what did each agent change"); it does NOT replace
  // them. Strictly read-only (the WARDEN-199 no-mutation line): no 3-way merge
  // editor, no stash/write-back — it informs a human decision, it never makes one.
  //
  //   GET /api/cross-agent-diff?idA=<chatId>&idB=<chatId>&path=<file>
  //     → { diff: string|null, error: string|null }
  //
  // Implementation: resolve BOTH chats (resolve()), read each side's working-tree
  // file CONTENT by reusing the /api/read-file resolution primitives verbatim
  // (readWorkingTreeFile — resolveLocalFile + size/binary/read guards for LOCAL
  // chats; buildReadFileScript + run(host, script) for remote/yatfa), then
  // diffNoIndex() writes both to temp files and runs `git diff --no-index` (git is
  // already the diff engine — no new dependency). This working-tree-content read is
  // what makes the A↔B view handle the untracked/new-file case better than the
  // per-agent vs-HEAD panels: it diffs the bytes on disk regardless of tracked status.
  //
  // Never-500 discipline (mirrors /api/git-range-diff): a read failure on one side,
  // a binary file, a missing/deleted path, or a git error all collapse to
  // { diff: null, error: '<side>: <reason>' } — never thrown, never a 500. The error
  // is prefixed with the side (A/B) so the human knows which agent's read failed.
  // An empty diff is a genuine, useful signal: both working trees are byte-identical
  // → "both agents made the same change — no conflict."
  router.get('/api/cross-agent-diff', async (req, res) => {
    const filePath = String(req.query.path || '').trim();
    const idA = String(req.query.idA || '').trim();
    const idB = String(req.query.idB || '').trim();
    if (!filePath || !idA || !idB) {
      return res.status(400).json({ diff: null, error: 'idA, idB, and path are required' });
    }

    try {
      // Resolve both chats up front so a bad idA/idB fails fast (404, like /api/git-diff).
      const [ra, rb] = await Promise.all([resolve(idA), resolve(idB)]);
      if (ra.error) return res.status(404).json({ diff: null, error: `A: ${ra.error}` });
      if (rb.error) return res.status(404).json({ diff: null, error: `B: ${rb.error}` });

      // Read each side's working-tree content. A read failure (missing, binary,
      // traversal, too large) surfaces as '<side>: <reason>' — never a 500.
      const aRead = await readWorkingTreeFile(ra.chat, filePath);
      if (aRead.error) return res.json({ diff: null, error: `A: ${aRead.error}` });
      const bRead = await readWorkingTreeFile(rb.chat, filePath);
      if (bRead.error) return res.json({ diff: null, error: `B: ${bRead.error}` });

      const r = await diffNoIndex(aRead.content, bRead.content, filePath);
      if (r.error) return res.json({ diff: null, error: r.error });
      res.json({ diff: r.diff, error: null });
    } catch (e) {
      res.json({ diff: null, error: e.message });
    }
  });


  // Inspect a single commit (git show). Mirrors /api/git-log: local chats run git via
  // async runLocalGit, remote chats run over SSH with shellQuote(cwd)+shellQuote(hash). A
  // non-git / no-cwd / unknown-hash repo yields an empty result (never a 500).
  //
  //   GET /api/git-show?id=<chatId>&hash=<hash>           → { files: [{path,status}] }
  //   GET /api/git-show?id=<chatId>&hash=<hash>&path=<p>  → { diff: "<patch text>" }
  //
  // `hash` is clamped to short/long hex ([0-9a-f]{4,40}) — anything else (e.g.
  // "--version", shell metacharacters) is rejected before it reaches git or the remote
  // shell, mirroring the shellQuote care taken in /api/git-log. `path`, when present,
  // is a git pathspec and gets the isSafeRelativePath containment check.
  //
  // commitMessage: fetch a commit's full message (git's %B: subject + body) WITHOUT
  // computing a diff (--no-patch ≡ -s), then cap + strip it to the BODY only. `hash`
  // is already hex-validated by the route ([0-9a-f]{4,40}), so it's safe as argv
  // after `git -C <cwd>` (local) / the shellQuoted remote form (the same WARDEN-122
  // discipline as the rest of this route). The 1MB cap (capDiff — byte-accurate, no
  // lone surrogate) bounds a pathological message; stripCommitSubject drops the
  // subject the collapsed row already shows. Returns '' for a subject-only commit
  // (no body) or a non-ok git result, so the UI renders the message block
  // unconditionally and it just hides when empty. Shared by the no-path and per-file
  // branches so both commit inspectors (sidebar expand + FileViewer blame/history)
  // surface the "why" (WARDEN-388). Read-only: honors the WARDEN-199 no-mutation line.
  async function commitMessage(chat, hash, cwd) {
    const r = await runGit(chat, ['show', '--no-patch', '--format=%B', hash], cwd);
    if (!r.ok) return '';
    return stripCommitSubject(capDiff(r.stdout || ''));
  }


  router.get('/api/git-show', async (req, res) => {
    const hash = String(req.query.hash || '');
    const filePath = String(req.query.path || '').trim();
    await withGitRepo(req, res, {
      defaults: { files: [], diff: null },
      // Reject malformed hashes before any git invocation: hex only, 4–40 chars.
      // Reject unsafe per-file paths (absolute / traversal). Bad path → empty, never 500.
      validate: () => {
        if (!isValidGitHash(hash)) return { body: { files: [], diff: null, error: 'invalid hash' } };
        if (filePath && !isSafeRelativePath(filePath)) return { body: { files: [], diff: null, error: 'invalid path' } };
        return null;
      },
      handler: async ({ chat, cwd, res }) => {
        // runGit collapses the local/remote branches and runs inside the container
        // for yatfa chats (WARDEN-235). `hash` is already hex-validated above and the
        // per-file `path` is a git pathspec (isSafeRelativePath), so both are safe as
        // argv after `git -C <cwd>` / the shellQuoted remote form.
        let files = [];
        let diff = null;
        let message = '';
        if (filePath) {
          // --format= strips the commit header (author/date/message) so we get ONLY the
          // file's patch — exactly what inspecting a single file should surface. The
          // commit's full message rides a separate --no-patch call (commitMessage) so the
          // FileViewer blame/history popover can show the "why" above this diff too.
          const r = await runGit(chat, ['show', '--format=', hash, '--', filePath], cwd);
          diff = capDiff(r.ok ? r.stdout : '');
          message = await commitMessage(chat, hash, cwd);
        } else {
          const r = await runGit(chat, ['show', '--name-status', '--pretty=format:', hash], cwd);
          files = parseGitShowNameStatus(r.ok ? r.stdout : '');
          // The commit's full message (body) rides this same detail fetch — no extra
          // round-trip for the primary path. parseGitShowNameStatus stays untouched (the
          // %B fetch is deliberately separate so the name-status parser isn't complicated).
          message = await commitMessage(chat, hash, cwd);
        }

        res.json({ files, diff, message, error: null });
      },
    });
  });


  // ---- File blob at a historical commit (WARDEN-354) --------------------------
  // The temporal file-exploration trio's full-snapshot leg: blame = per-line
  // provenance (WARDEN-206), history = commit sequence + per-file diff (WARDEN-319),
  // this = the file's FULL content as it existed at a commit (git show <hash>:<path>).
  // Read-only — consistent with the git-status/log/diff/show/stash/blame set. No
  // checkouts, no mutating ops (the WARDEN-199 line stays read-only).
  //
  //   GET /api/git-cat-file?id=<chatId>&hash=<hash>&path=<file>
  //     → { content: string|null, error: string|null }
  //
  // Mirrors /api/git-show's resolve → hex-validate hash → isSafeRelativePath →
  // gitCwd guard → runGit → never-500 shape, and layers /api/read-file's 1MB +
  // binary guards on top (a blob is full file content, not a diff, so an oversize
  // blob is a clean size error rather than a silent truncation). `hash` is hex-
  // validated and `path` is isSafeRelativePath-checked, so `${hash}:${path}` is
  // safe as a single argv element (no shell on the local branch; shellQuoted
  // remotely). A non-git cwd, a deleted-at-commit path, or an invalid hash yields
  // a clean empty/error result — never a 500.
  router.get('/api/git-cat-file', async (req, res) => {
    const hash = String(req.query.hash || '');
    const filePath = String(req.query.path || '').trim();
    await withGitRepo(req, res, {
      defaults: { content: null },
      // Reject malformed hashes before any git invocation: hex only, 4–40 chars.
      // Empty path → nothing to read; unsafe path → 'invalid path' (never 500).
      validate: () => {
        if (!isValidGitHash(hash)) return { body: { content: null, error: 'invalid hash' } };
        if (!filePath) return { body: { content: null, error: 'path is required' } };
        if (!isSafeRelativePath(filePath)) return { body: { content: null, error: 'invalid path' } };
        return null;
      },
      handler: async ({ chat, cwd, res }) => {
        // Binary by extension: mirror /api/read-file (a .png at a commit is still a
        // .png). Checked before any git call so we never transfer garbled bytes.
        if (isBinaryFile(filePath)) {
          return res.json({ content: null, error: 'cannot read binary files' });
        }

        // Pre-check existence + size with `git cat-file -s` (tiny output, never hits
        // a maxBuffer). An oversize blob is a clean size error BEFORE we transfer its
        // bytes — mirroring /api/read-file's stat-before-read (a blob is full file
        // content, so a truncation would mislead; we error instead). A path that
        // doesn't exist at this commit (deleted/never touched) exits non-zero here.
        const sizeR = await runGit(chat, ['cat-file', '-s', `${hash}:${filePath}`], cwd);
        if (!sizeR.ok) {
          // Distinguish a non-git cwd (soft failure → clean empty, mirroring git-show)
          // from a path that doesn't exist at this commit (→ helpful 'not found at
          // commit'). Both are 200, never a 500.
          const probe = await runGit(chat, ['rev-parse', '--is-inside-work-tree'], cwd);
          const isRepo = probe.ok && (probe.stdout || '').trim() === 'true';
          return res.json({ content: null, error: isRepo ? 'not found at commit' : null });
        }
        const size = parseInt(sizeR.stdout || '', 10);
        if (Number.isNaN(size)) return res.json({ content: null, error: 'not found at commit' });
        if (size > GIT_DIFF_MAX_BYTES) {
          return res.json({ content: null, error: 'file too large (max 1MB)' });
        }

        // `git show <hash>:<path>` emits the full blob bytes. hash is hex-validated
        // and filePath is isSafeRelativePath-checked, so `<hash>:<path>` is safe as
        // one argv element after `git -C <cwd>` / the shellQuoted remote form. The
        // size pre-check above guarantees the blob fits the transport's maxBuffer.
        const r = await runGit(chat, ['show', `${hash}:${filePath}`], cwd);
        if (!r.ok) {
          return res.json({ content: null, error: 'not found at commit' });
        }
        const raw = r.stdout || '';
        // Defense-in-depth: a file with a non-binary extension but binary content
        // (e.g. an extension-less blob) would decode to garbled UTF-8. Detect a NUL
        // byte anywhere in the content — git's own binary heuristic.
        if (isBinaryBlob(raw)) {
          return res.json({ content: null, error: 'cannot read binary files' });
        }
        res.json({ content: raw, error: null });
      },
    });
  });


  // ---- Per-side conflict content (WARDEN-428) --------------------------------
  // Read-only ours-vs-theirs view for a conflicted path (UU/AA/UD/…). When an agent
  // is stuck mid-merge/rebase/cherry-pick, clicking a conflicted file from the
  // changed-files list opens THIS — the two conflicting sides from git's stage
  // blobs — instead of the generic `git diff --cached`, which for an unmerged path
  // is not a usable ours/theirs view. Completes WARDEN-186's conflict-STATE
  // visibility (the red `!XY` badge) with conflict-CONTENT.
  //
  //   GET /api/git-conflict?id=<chatId>&path=<file>
  //     → { ours: string|null, theirs: string|null, path: string, error: string|null }
  //
  // `ours`   = `git show :2:<path>` (stage 2 = HEAD / the current branch).
  // `theirs` = `git show :3:<path>` (stage 3 = MERGE_HEAD / the branch being merged).
  // Stage blobs :2:/:3: exist by definition for any unmerged path (that is exactly
  // what UNMERGED_STATUS_CODES means), so this is uniform across every conflict code.
  //
  // Mirrors /api/git-cat-file (a blob READ, not a diff), NOT /api/git-diff: resolve
  // → gitCwd guard → isSafeRelativePath (the cat-file/read-file guard, NOT
  // isPathWithinCwd — a stage blob is read by git, not from the host fs) →
  // isBinaryFile extension check → size pre-check via `git cat-file -s :2:`/`:3:`
  // against GIT_DIFF_MAX_BYTES → `git show :N:<path>` → isBinaryBlob NUL-byte
  // defense-in-depth. `${stage}:${filePath}` is safe as one argv element after
  // `git -C <cwd>` / the shellQuoted remote form (filePath is isSafeRelativePath-
  // checked), mirroring cat-file's `${hash}:${filePath}`.
  //
  // Edge cases: if a stage blob is absent (modify/delete UD/DU, or both-deleted DD)
  // that side returns null cleanly — a one-sided conflict still renders the present
  // side. When BOTH sides are absent we distinguish a non-git cwd (soft-fail → null
  // sides, null error, mirroring cat-file's rev-parse --is-inside-work-tree probe)
  // from a real repo where both blobs are genuinely absent (DD / path not conflicted
  // → a helpful 'no conflict content' error). Every failure path returns 200 with a
  // populated `error` / null sides — never a 500.
  //
  // Read-only contract: `git show :N:` and `git cat-file -s :N:` are strictly
  // read-only — identical in kind to the already-shipped `git show <hash>:<path>`
  // (cat-file) and `git diff` (git-diff). No merge/checkout/add/rm. This stays on
  // the WARDEN-199 read-only line the git-status/log/diff/show/cat-file/blame set
  // already honors.
  router.get('/api/git-conflict', async (req, res) => {
    const filePath = String(req.query.path || '').trim();
    await withGitRepo(req, res, {
      defaults: { ours: null, theirs: null, path: filePath },
      // The unknown-id 404 carries this route's path-bearing contract (not the bare
      // { error } most routes emit), so notFoundEmpty spreads `defaults` into the 404.
      notFoundEmpty: true,
      // Empty path → nothing to read; unsafe path → 'invalid path' (never 500),
      // mirroring cat-file's guards exactly.
      validate: () => {
        if (!filePath) return { body: { ours: null, theirs: null, path: '', error: 'path is required' } };
        if (!isSafeRelativePath(filePath)) return { body: { ours: null, theirs: null, path: filePath, error: 'invalid path' } };
        return null;
      },
      handler: async ({ chat, cwd, res }) => {
        // Binary by extension: mirror /api/git-cat-file (a conflicted .png is still a
        // .png). Checked before any git call so we never transfer garbled bytes.
        if (isBinaryFile(filePath)) {
          return res.json({ ours: null, theirs: null, path: filePath, error: 'cannot read binary files' });
        }

        // Read each stage blob (:2: ours, :3: theirs) independently. A side whose
        // `cat-file -s` fails is absent (modify/delete conflict, or DD both-deleted) →
        // that side stays undefined (→ null) cleanly; the present side still renders.
        // An oversize or binary side aborts the whole response with a clean error
        // (mirroring cat-file: a truncation would mislead, and a conflict view needs
        // both sides to be honest). `sides[stage]` may legitimately be '' (an empty
        // file), so the absence → null mapping below uses `!== undefined`, NOT a
        // truthiness test that would collapse '' to null.
        const sides = {};
        for (const stage of ['2', '3']) {
          const sizeR = await runGit(chat, ['cat-file', '-s', `:${stage}:${filePath}`], cwd);
          if (!sizeR.ok) continue; // stage blob absent → side stays undefined (→ null)
          const size = parseInt(sizeR.stdout || '', 10);
          if (Number.isNaN(size)) continue;
          if (size > GIT_DIFF_MAX_BYTES) {
            return res.json({ ours: null, theirs: null, path: filePath, error: 'file too large (max 1MB)' });
          }
          const r = await runGit(chat, ['show', `:${stage}:${filePath}`], cwd);
          if (!r.ok) continue; // blob vanished between -s and show → treat as absent
          const raw = r.stdout || '';
          // Defense-in-depth: a non-binary extension whose stage content is binary
          // (e.g. an extension-less blob) decodes to garbled UTF-8. NUL = binary.
          if (isBinaryBlob(raw)) {
            return res.json({ ours: null, theirs: null, path: filePath, error: 'cannot read binary files' });
          }
          sides[stage] = raw;
        }
        const ours = sides['2'] !== undefined ? sides['2'] : null;
        const theirs = sides['3'] !== undefined ? sides['3'] : null;

        // Both sides absent: distinguish a non-git cwd (soft-fail → null error,
        // mirroring cat-file's rev-parse probe) from a real repo where both stage
        // blobs are genuinely absent (DD both-deleted, or the path isn't conflicted).
        if (ours === null && theirs === null) {
          const probe = await runGit(chat, ['rev-parse', '--is-inside-work-tree'], cwd);
          const isRepo = probe.ok && (probe.stdout || '').trim() === 'true';
          return res.json({ ours: null, theirs: null, path: filePath, error: isRepo ? 'no conflict content' : null });
        }

        res.json({ ours, theirs, path: filePath, error: null });
      },
    });
  });


  // Shelved work-in-progress detail (git stash list). Mirrors /api/git-log: local
  // chats run git via async runLocalGit, remote chats run over SSH with shellQuote(cwd).
  // We reuse git-log's --pretty pipe format (`%gd|%s|%cr`) so the subject (which
  // may itself contain '|') is peeled front/back by the exported `parseStashList`
  // helper. A non-git / no-cwd / stash-free repo yields an empty list (never a
  // 500). The eager per-chat count lives in /api/git-status's `stashCount`; this
  // endpoint is the lazy detail fetched only when the stash section is opened.
  //
  //   GET /api/git-stash?id=<chatId>  → { stashes: [{ ref, subject, date }], error }
  router.get('/api/git-stash', async (req, res) => {
    await withGitRepo(req, res, {
      defaults: { stashes: [] },
      handler: async ({ chat, cwd, res }) => {
        // reflog selector | subject | relative date  (subject may contain '|'). runGit
        // passes --pretty as one argv element (no shell on LOCAL) so '|' isn't read as
        // a pipe; the remote branch shellQuotes it (WARDEN-122). yatfa chats run this
        // inside the container (WARDEN-235).
        const pretty = '%gd|%s|%cr';
        const r = await runGit(chat, ['stash', 'list', `--pretty=format:${pretty}`], cwd);
        const raw = r.ok ? r.stdout.trim() : '';

        const stashes = raw ? parseStashList(raw) : [];
        res.json({ stashes, error: null });
      },
    });
  });


  // Git reflog — an agent's operation history (WARDEN-460). The fourth read-only
  // "axis" alongside commit history (/api/git-log), working-tree state
  // (/api/git-status), and shelved WIP (/api/git-stash): the NON-commit git
  // operations an autonomous agent performs that leave no commit AND no dirty file
  // — `git reset --hard` to a clean tree, `git checkout` to another branch, an
  // abandoned/aborted rebase, a force-push, a cherry-pick rewind. Those live ONLY
  // in the reflog, so when a human opens an agent that looks "clean" but is on a
  // surprising branch (or whose commits seem to have vanished after a reset), this
  // is what makes it diagnosable in-UI. It is also the recovery handle the detached
  // -HEAD tooltip already gestures at ("at risk if reflog expires") but never
  // exposed. Mirrors /api/git-stash's transport/shape exactly. Read-only by
  // construction: `git reflog` (the read form) only, never `git reflog expire`/
  // `delete` (the WARDEN-199 read-only line the whole git-status/log/diff/show/
  // cat-file/conflict/stash/blame set holds).
  //
  //   GET /api/git-reflog?id=<chatId>  → { entries: [{ hash, subject, date }], error }
  router.get('/api/git-reflog', async (req, res) => {
    await withGitRepo(req, res, {
      defaults: { entries: [] },
      handler: async ({ chat, cwd, res }) => {
        // abbreviated hash | reflog subject (the OPERATION, e.g. "reset: moving to
        // HEAD~1") | relative committer date. The subject may itself contain '|'. We
        // reuse git-stash's `%gd|%s|%cr` pipe format so `parseReflog` peels the subject
        // front/back exactly like `parseStashList`. runGit passes --pretty as one argv
        // element (no shell on LOCAL) so '|' isn't read as a pipe; the remote branch
        // shellQuotes it (WARDEN-122). yatfa chats run this inside the container
        // (WARDEN-235). Capped at the last 50 entries — the recent operation window a
        // human needs to answer "what did this agent just do to its repo?".
        const pretty = '%h|%gs|%cr';
        const r = await runGit(chat, ['reflog', '-n', '50', `--pretty=format:${pretty}`], cwd);
        const raw = r.ok ? r.stdout.trim() : '';

        const entries = raw ? parseReflog(raw) : [];
        res.json({ entries, error: null });
      },
    });
  });


  // Local branches — an agent's branch topology (WARDEN-577). The last read-only
  // "axis" on the WARDEN-199 line: a human can already see WHICH branch the agent
  // sits on (the badge), but not what OTHER branches exist — whether work is
  // focused on one branch or scattered across many, whether a branch is stranded
  // (unmerged into HEAD, or its upstream `[gone]`), or whether a remembered older
  // branch still exists. Surfaces that without dropping into a terminal. Mirrors
  // /api/git-stash's transport/shape exactly (resolve → 404 guard → gitCwd →
  // graceful [] on no-cwd/non-git, never 500). Read-only by construction:
  // `git for-each-ref` (and `--merged HEAD`) only — never branch/checkout/merge/
  // delete/rename (the WARDEN-199 read-only line the whole git-status/log/diff/
  // show/blame/stash/reflog set holds; the withdrawn branch-switch slice is the
  // cautionary tale the git-status comment at /api/git-status cites).
  //
  //   GET /api/git-branch?id=<chatId>
  //     → { branches: [{ name, current, headSha, headDate, upstream, ahead, behind, gone, merged }], error }
  router.get('/api/git-branch', async (req, res) => {
    await withGitRepo(req, res, {
      defaults: { branches: [] },
      handler: async ({ chat, cwd, res }) => {
        // name|sha|date|upstream|track. %(upstream:track) yields [ahead N]/[behind N]/
        // [ahead N, behind M]/[gone] natively, so ahead/behind (+ gone) come for free
        // (no separate rev-list). %(committerdate:iso-strict) gives strict ISO (the
        // %cI headDate discipline — `2026-07-17T01:23:59Z`, reliably Date.parse-able).
        // --format is one argv element (no shell on LOCAL); the remote branch
        // shellQuotes it (WARDEN-122). yatfa chats run this inside the container
        // (WARDEN-235).
        const fmt = '%(refname:short)|%(objectname:short)|%(committerdate:iso-strict)|%(upstream:short)|%(upstream:track)';
        const r = await runGit(chat, ['for-each-ref', `--format=${fmt}`, 'refs/heads/'], cwd);
        const raw = r.ok ? r.stdout.trim() : '';
        const branches = raw ? parseGitBranches(raw) : [];

        // Current branch: re-resolve HEAD so the matching branch is flagged current
        // (the badge already names it; the list marks it). One cheap runGit; on a
        // detached HEAD / non-git cwd symbolic-ref exits non-zero → '' → no branch
        // flagged current (a detached repo still lists its branches).
        const headR = await runGit(chat, ['symbolic-ref', '--short', 'HEAD'], cwd);
        const currentName = headR.ok ? headR.stdout.trim() : '';

        // Merged-into-HEAD set: a second read-only `for-each-ref --merged HEAD` so a
        // NON-merged branch (a tip not reachable from HEAD — potentially stranded
        // work that never landed) is flaggable. A failure degrades to all-false
        // (never 500). Same CRLF tolerance as the main parse; one name per line.
        const mergedR = await runGit(chat, ['for-each-ref', '--merged', 'HEAD', '--format=%(refname:short)', 'refs/heads/'], cwd);
        const mergedNames = mergedR.ok
          ? mergedR.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim())
          : [];
        const mergedSet = new Set(mergedNames);

        const out = branches.map((b) => ({
          ...b,
          current: currentName !== '' && b.name === currentName,
          merged: mergedSet.has(b.name),
        }));
        res.json({ branches: out, error: null });
      },
    });
  });


  // Inspect a single stash's changes (the depth layer under /api/git-stash).
  // Completes the explorable-badge symmetry with recent/outgoing commits — a stash
  // row expands to its changed files (path + M/A/D token) and each file expands to a
  // per-file diff, exactly like the commit rows expand via /api/git-show + CommitFile.
  // Read-only — no apply/pop/drop (stays on the WARDEN-199 read-only side of the
  // roadmap, like git-show/blame). No persistence (read live from git via runGit).
  //
  //   GET /api/git-stash-show?id=<chatId>&ref=<ref>           → { files: [{path,status}] }
  //   GET /api/git-stash-show?id=<chatId>&ref=<ref>&path=<p>  → { diff: "<patch text>" }
  //
  // `ref` is the stash reflog selector from parseStashList (`%gd` = stash@{0}, stash@{1},
  // …), clamped here to that exact shape `^stash@{\d+}$` and rejected otherwise BEFORE it
  // reaches git or the remote shell — the stash equivalent of git-show's hex clamp
  // ([0-9a-f]{4,40}). `path`, when present, is a git pathspec with isSafeRelativePath
  // containment. On malformed ref / bad path / non-git cwd / empty → empty result, never
  // a 500. See WARDEN-340.
  router.get('/api/git-stash-show', async (req, res) => {
    const ref = String(req.query.ref || '');
    const filePath = String(req.query.path || '').trim();
    await withGitRepo(req, res, {
      defaults: { files: [], diff: null },
      // ref clamp (WARDEN-122 injection discipline): parseStashList's `ref` is the %gd
      // reflog selector = `stash@{0}`. Validate against that exact shape and reject
      // anything else (e.g. "--version", "stash@{a}", "; rm -rf") BEFORE it reaches git
      // or the remote shell — the stash equivalent of git-show's /([0-9a-f]{4,40})/i
      // hex clamp. On malformed ref → empty, never a 500. Reject unsafe per-file paths
      // (absolute / traversal). Bad path → empty, never 500.
      validate: () => {
        if (!/^stash@\{\d+\}$/.test(ref)) return { body: { files: [], diff: null, error: 'invalid ref' } };
        if (filePath && !isSafeRelativePath(filePath)) return { body: { files: [], diff: null, error: 'invalid path' } };
        return null;
      },
      handler: async ({ chat, cwd, res }) => {
        // `git stash show` accepts the same --name-status/--pretty shape as `git show`,
        // so parseGitShowNameStatus reuses cleanly for the files list. `ref` is already
        // ^stash@{\d+}$-validated above and `path` is isSafeRelativePath-checked, so both
        // are safe as argv after `git -C <cwd>` / the shellQuoted remote form (the
        // WARDEN-122 discipline). `--` before the path stops option injection.
        //
        // NOTE on the per-file diff: `git stash show -p <ref> -- <path>` FAILS with
        // "Too many revisions specified" (verified on git 2.47) — `git stash show` does
        // not accept a pathspec. Instead `git diff <ref>^ <ref> -- <path>` is used: it is
        // byte-identical to `git stash show -p <ref>` (the stash commit's tree diff vs its
        // first parent, the commit the stash was created on) and stays consistent with the
        // files list — both surface the tracked working-tree changes only (verified they
        // agree for a `-u` stash too). `git diff` emits pure patch output with no commit
        // header, so no --format= is needed. capDiff guards the 1MB ceiling (capDiff).
        let files = [];
        let diff = null;
        if (filePath) {
          const r = await runGit(chat, ['diff', `${ref}^`, ref, '--', filePath], cwd);
          diff = capDiff(r.ok ? r.stdout : '');
        } else {
          const r = await runGit(chat, ['stash', 'show', '--name-status', '--pretty=format:', ref], cwd);
          files = parseGitShowNameStatus(r.ok ? r.stdout : '');
        }

        res.json({ files, diff, error: null });
      },
    });
  });


  // ---- Per-line git blame / annotate (WARDEN-206) -----------------------------
  // Read-only provenance for the file a human is viewing in FileViewer: which
  // commit / author / date last touched each line. Strictly observational — `git
  // blame` only, no checkout or any mutating op (the WARDEN-199 line the roadmap
  // stays on the read-only side of). Mirrors /api/git-show's resolve → cwd guard →
  // isSafeRelativePath → local async runLocalGit vs remote run() → capDiff → never-500
  // shape. A non-git / no-cwd / binary / unblamable file yields an empty list.

  //   GET /api/git-blame?id=<chatId>&path=<file> → { lines: [{line,hash,author,date,summary}], error }
  //
  // `path` is a git pathspec and gets the isSafeRelativePath containment check (bad
  // path → empty, never 500), mirroring /api/git-show's per-file guard. Output is
  // capped via capDiff/GIT_DIFF_MAX_BYTES before parsing (blame on a large file can
  // be big) — a truncation that may drop the final partial record, never a 500.
  router.get('/api/git-blame', async (req, res) => {
    const filePath = String(req.query.path || '').trim();
    await withGitRepo(req, res, {
      defaults: { lines: [] },
      // Empty path → nothing to blame (not an error — a success-shaped { lines: [],
      // error: null }). Unsafe path → empty + 'invalid path' (mirrors git-show: never
      // a 500). Returning the FULL body lets the empty-path "success" reproduce verbatim.
      validate: () => {
        if (!filePath) return { body: { lines: [], error: null } };
        if (!isSafeRelativePath(filePath)) return { body: { lines: [], error: 'invalid path' } };
        return null;
      },
      handler: async ({ chat, cwd, res }) => {
        let raw = '';
        if (!chat.container && chat.host === LOCAL) {
          // manual-LOCAL: runLocalGit (async, non-blocking) on the host fs.
          // `--line-porcelain` for the stable, machine-parseable per-line header block
          // the parser above consumes.
          const r = await runLocalGit(['blame', '--line-porcelain', '--', filePath], cwd);
          raw = capDiff(r.stdout || '');
        } else {
          // container (local+remote) or manual-remote: buildGitBlameScript delivered
          // in-context via runInContext (docker-exec for yatfa, ssh for manual-remote)
          // so the `cd <cwd>` + `git blame` run where the repo lives. The `2>/dev/null`
          // in the script swallows git's "no such file" / "not a git repo" noise so a
          // non-git cwd reads as empty, not an error. See WARDEN-235.
          const rr = await runInContext(chat, buildGitBlameScript(cwd, filePath));
          raw = capDiff(rr.ok ? (rr.stdout || '') : '');
        }

        const lines = parseGitBlame(raw);
        res.json({ lines, error: null });
      },
    });
  });


  // GET /api/git-ls — read-only directory listing of a chat's working directory
  // (WARDEN-573). The STRUCTURAL discovery twin of /api/search-files: where grep
  // finds a file by CONTENT, this finds it by POSITION (browse dirs → filenames)
  // with no prior knowledge of either. Backed by `git ls-files --cached --others
  // --exclude-standard` via runGit (WARDEN-235) so it lights up identically for
  // local, SSH-remote, and yatfa-container chats (docker-exec into the container);
  // raw fs.readdirSync is deliberately avoided — it would silently break the
  // remote/container transports AND would not honor .gitignore. --exclude-standard
  // naturally hides node_modules/.git/build artifacts. Mirrors /api/git-status's
  // resolve → gitCwd → runGit shape and its graceful `error:'no cwd'` contract.
  //
  // Query: id=<chatId>, dir=<cwd-relative path, default '' (repo root)>
  // Response: { entries: [{ name, type: 'file'|'dir' }], cwd, dir, error?: string }
  //
  // Strictly read-only (WARDEN-199 line): `git ls-files` mutates nothing.
  router.get('/api/git-ls', async (req, res) => {
    // `dir` is relative to cwd (default '' = repo root). Containment guard: a
    // pathspec reaching `..` would let git list outside cwd, so it is validated
    // server-side here (not just client-side in the dialog). Reuses the SAME
    // isSafeRelativePath the git-show/blame routes trust (lexical pathspec rule —
    // works across all transports, no host-fs realpath needed). The `dir &&` gate
    // lets the empty root default through (isSafeRelativePath treats '' as invalid
    // because a git-show path is required, but root is the legitimate list-all).
    const dir = String(req.query.dir || '');
    await withGitRepo(req, res, {
      // defaults carries `cwd: chat.cwd || ''`. The hand-written no-cwd body used the
      // literal `cwd: ''` and the catch used `cwd: chat.cwd || ''`; identical on the
      // no-cwd path (gitCwd returns '' only when chat.cwd is absent — see gitCwd).
      defaults: (chat) => ({ entries: [], cwd: chat.cwd || '', dir }),
      // The dir guard runs AFTER the 404 (hand-written order) and rejects with 400.
      validate: () => (dir && !isSafeRelativePath(dir)
        ? { status: 400, body: { error: 'dir must be within working directory' } }
        : null),
      // Generic catch — don't leak internals (a HostConnectionError embeds the hostname).
      catchError: 'ls failed',
      handler: async ({ chat, cwd, res }) => {
        // Pathspec the listing to `dir` so git reads only that subtree; with dir=''
        // (root) no pathspec is passed → lists from cwd. --cached (--staged) gives
        // tracked files, --others adds untracked work-in-progress, and
        // --exclude-standard drops .gitignored entries (node_modules, build, .git).
        const args = ['ls-files', '--cached', '--others', '--exclude-standard'];
        if (dir) args.push('--', dir);
        const r = await runGit(chat, args, cwd);
        // Non-zero exit (not a git repo, or an unborn repo whose index is empty
        // under a non-root dir) → empty list with an explicit error so the dialog
        // can tell "empty directory" from "not a repo" (mirrors search-files's
        // honest-error discipline rather than masking as "no results").
        if (!r.ok) return res.json({ entries: [], cwd, dir, error: 'not a git repository' });
        res.json({ entries: parseGitLsEntries(r.stdout, dir), cwd, dir, error: null });
      },
    });
  });
  return router;
}
