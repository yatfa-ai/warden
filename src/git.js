// Pure helpers for git log / show / diff / blame parsing + the shell scripts that
// drive those ops remotely. Extracted from the routes in server.js so the parsing
// is unit-testable without booting the Express app (server.js runs `load()` at
// module load, which reads ~/.yatfa-warden and starts the server) — mirrors
// src/gitStatus.js (the zero-dependency porcelain parsers extracted for the same
// reason). The log/show/diff/blame parsers were added later but dumped inline in
// server.js; this finishes that extraction.
//
// Side-effect-free at module load: the only project import is `shellQuote` from
// ./ssh.js, which has no top-level statements, so importing this module boots
// nothing. (WARDEN-606.)

import path from 'node:path';
import fs from 'node:fs';
import { shellQuote } from './ssh.js';

// ===== In-progress operation detection (status) =============================

// Build the shell script that detects an in-progress git operation under `cwd`
// by testing the well-known marker files git writes under the git dir. Pure
// (just builds a string) so it is unit-testable, mirroring buildGitDiffScript /
// buildGitBlameScript. A repo can be in ONE state, so the test order is the
// priority (first match wins). The `{ ... }` group's exit status is that of its
// LAST test (non-zero when BISECT_LOG is absent, even mid-merge), so callers
// parse STDOUT, not `.ok`. Delivered via runInContext (docker-exec for yatfa,
// ssh for manual-remote); manual-LOCAL uses the host-fs path in detectInProgress
// instead. The `2>/dev/null` on rev-parse swallows non-git/detached → empty →
// operation null (graceful, never a 500). See WARDEN-235.
//
// Each matching marker echoes ONE record line carrying the operation PLUS its
// raw progress detail, pipe-delimited so detectInProgress can parse it in one
// pass (WARDEN-511): `merge|<MERGE_HEAD-sha>`, `rebase|<msgnum>|<end>|<onto>|
// <stopped-sha>`, etc. rebase-apply (no step files) and bisect (no detail) echo
// a bare operation name → detail null. Callers take the FIRST non-empty line
// (priority order), so only the highest-priority in-progress op is reported.
export function buildInProgressScript(cwd) {
  return `cd ${shellQuote(cwd)} && gd=$(git rev-parse --git-dir 2>/dev/null) && ` +
    `{ [ -f "$gd/MERGE_HEAD" ] && echo "merge|$(cat "$gd/MERGE_HEAD" 2>/dev/null)"; ` +
    `[ -f "$gd/CHERRY_PICK_HEAD" ] && echo "cherry-pick|$(cat "$gd/CHERRY_PICK_HEAD" 2>/dev/null)"; ` +
    `[ -f "$gd/REVERT_HEAD" ] && echo "revert|$(cat "$gd/REVERT_HEAD" 2>/dev/null)"; ` +
    `[ -d "$gd/rebase-merge" ] && echo "rebase|$(cat "$gd/rebase-merge/msgnum" 2>/dev/null)|$(cat "$gd/rebase-merge/end" 2>/dev/null)|$(cat "$gd/rebase-merge/onto" 2>/dev/null)|$(cat "$gd/rebase-merge/stopped-sha" 2>/dev/null)"; ` +
    `[ -d "$gd/rebase-apply" ] && echo rebase; ` +
    `[ -f "$gd/BISECT_LOG" ] && echo bisect; }`;
}

// ===== Git log =============================================================

// The `--pretty=format:` used by /api/git-log: short hash | subject | author |
// relative date | committer epoch. Named (not inlined) so the field order is
// documented at a glance and grep-able. The '|' separators are passed as ONE argv
// element to runGit (no shell on the LOCAL branch) and shellQuote'd on the remote
// branch, so they're argument characters — never read as shell pipes (the
// WARDEN-122 quoting lesson). The trailing `%ct` (committer date, UNIX seconds)
// gives the frontend's per-agent "What's new since" filter an EXACT timestamp to
// compare against lastSeen (WARDEN-356) — the relative `%ar` is coarse and would
// mislabel already-seen commits as new as it ages, so the filter must use `%ct`.
export const GIT_LOG_PRETTY = '%h|%s|%an|%ar|%ct';

// Parse one `--pretty=format:%h|%s|%an|%ar|%ct` line into
// { hash, subject, author, date, epoch }. Field order:
//   hash | subject | author | relative-date(%ar) | committer-epoch(%ct)
// hash/author/date/epoch are pipe-free (epoch is a bare UNIX-second integer); the
// subject sits between hash and author and MAY contain '|' (a commit message like
// "merge a | b"). So peel the hash off the front and peel epoch/date/author off the
// BACK (each on its own last '|'), leaving whatever remains as the subject. `epoch`
// is the EXACT committer timestamp (git %ct, seconds) — the precise field the
// frontend's per-agent "What's new since" since-filter compares against lastSeen
// (WARDEN-356). It's a Number when the field parses as an integer, else null (a
// degraded/partial line from an older caller) — never a string, so the comparison
// is numeric. Exported for tests.
export function parseGitLogLine(line) {
  const firstPipe = line.indexOf('|');
  if (firstPipe === -1) return { hash: line, subject: '', author: '', date: '', epoch: null };
  const hash = line.slice(0, firstPipe);
  const tail = line.slice(firstPipe + 1); // subject|author|date|epoch (subject may contain |)
  // Peel the three trailing pipe-free fields (epoch, date, author) off the back, one
  // lastIndexOf('|') at a time. Each peel returns null when no '|' remains — meaning
  // the leftover string IS that field and there are no fields further left.
  const peel = (s) => {
    const i = s.lastIndexOf('|');
    return i === -1 ? null : { val: s.slice(i + 1), rest: s.slice(0, i) };
  };
  // epoch (committer UNIX ts) — last field.
  const e = peel(tail);
  if (!e) return { hash, subject: tail, author: '', date: '', epoch: null };
  const epochRaw = e.val;
  // date (relative %ar) — second-to-last.
  const d = peel(e.rest);
  if (!d) return { hash, subject: '', author: '', date: e.rest, epoch: toEpoch(epochRaw) };
  const date = d.val;
  // author — third-to-last.
  const a = peel(d.rest);
  if (!a) return { hash, subject: '', author: d.rest, date, epoch: toEpoch(epochRaw) };
  return { hash, subject: a.rest, author: a.val, date, epoch: toEpoch(epochRaw) };
}

// Parse git's %ct (committer date, UNIX seconds) into a Number, or null when the
// field is absent/non-numeric (a degraded line). %ct is always an integer from git;
// the null path only covers partial/test inputs. Centralized so parseGitLogLine's
// peeling stays readable. Module-private (only parseGitLogLine calls it).
function toEpoch(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && raw.trim() !== '' && /^[0-9]+$/.test(raw.trim()) ? n : null;
}

// ===== Git show ============================================================

// Parse `git show --name-status --pretty=format: <hash>` output into [{ path, status }].
// Each line is `<code>\t<path>` where the code is a single letter (A/M/D/T) or a
// rename/copy with a similarity score (`R100`/`C75`) followed by `old<TAB>new`. The
// {path,status} shape intentionally matches `GitFile` so the frontend's
// `GitChangedFile` row renders touched files unchanged. For rename/copy we report the
// NEW path (it exists at that commit, so a per-file `git show` on it works) and a
// single-letter status. Exported for unit tests. See WARDEN-180.
export function parseGitShowNameStatus(output) {
  const raw = (output ?? '').toString();
  const out = [];
  for (const line of raw.split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue; // not a name-status record
    const code = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    const letter = code[0]; // A / M / D / T / R / C
    // Rename (R<score>) / copy (C<score>): "R100\told\tnew" → take the new path.
    // Otherwise: "M\tpath".
    const path = (letter === 'R' || letter === 'C') ? rest.slice(rest.indexOf('\t') + 1) : rest;
    if (path) out.push({ status: letter || code, path });
  }
  return out;
}

// ===== Git diff ============================================================

export const GIT_DIFF_MAX_BYTES = 1024 * 1024; // mirrors read-file's 1MB size guard

// Cap diff output to GIT_DIFF_MAX_BYTES. Goes through a Buffer so the truncation is
// byte-accurate AND never splits a multi-byte UTF-8 sequence: toString('utf8') of a
// buffer cut mid-sequence drops the incomplete tail (→ U+FFFD) rather than emitting a
// lone surrogate that would corrupt the JSON response. Only the rare >1MB diff pays
// the Buffer allocation. Exported so the no-lone-surrogate invariant has a test.
export function capDiff(diff) {
  if (Buffer.byteLength(diff) <= GIT_DIFF_MAX_BYTES) return diff;
  return Buffer.from(diff, 'utf8').subarray(0, GIT_DIFF_MAX_BYTES).toString('utf8');
}

// Build the remote (SSH) shell script that diffs one file vs HEAD under `cwd`.
// Extracted (and exported) so the fragile shell template is unit-tested directly,
// the same way buildReadFileScript is. Containment uses `realpath -m` (NOT `-e`):
// a deleted/untracked-not-yet-committed file has no realpath, so `-e` would wrongly
// reject it; `-m` resolves `..` lexically without requiring existence, so the
// cwd-containment `case` still catches `../etc/passwd` escapes. shellQuote yields a
// single-quoted POSIX token spliced in bare — same WARDEN-122 quoting discipline as
// read-file/git-log. The `--` before the path stops option parsing so a path named
// like a flag can't inject options.
//
// `staged` (WARDEN-369) swaps `git diff HEAD` for `git diff --cached` so clicking a
// STAGED file shows exactly what will be committed (the index-vs-HEAD diff) rather
// than the combined worktree-vs-HEAD diff. `git diff --cached` is strictly read-only
// (NOT in the forbidden mutating-ops set — see the read-only contract comment above
// /api/git-diff), so this stays within Warden's by-design read-only contract.
//
// `rangeRev` (WARDEN-601) — a fixed, server-validated literal commit range (only
// '@{u}..HEAD' today, for the impending-conflict committer's per-agent panel) — swaps
// `git diff HEAD`/`--cached` for `git diff <rangeRev>`, so the diff shows the file's
// change across that range instead of vs the working tree. It is shellQuote'd before
// splicing (its `{u}` braces never reach the shell unquoted — belt-and-suspenders on
// the WARDEN-122 discipline, even though single-element `{u}` is brace-expansion-safe
// in bash) and is ALWAYS a server-chosen constant (the route validates the query param
// to this literal), so it can never carry user input. CRUCIALLY the `-- "$FILE"`
// pathspec and the realpath containment `case` below run UNCHANGED — supplying a range
// does NOT relax path containment one bit (a range + a pathspec compose exactly as git
// always composes them). Read-only: a `git diff <range> -- <path>` is a pure read.
export function buildGitDiffScript(cwd, filePath, staged, rangeRev) {
  const diffCmd = rangeRev
    ? `git diff ${shellQuote(rangeRev)}`
    : (staged ? 'git diff --cached' : 'git diff HEAD');
  return `CWD=${shellQuote(cwd)}; FILE=${shellQuote(filePath)}; RESOLVED_CWD="$(cd "$CWD" && pwd -P)" || { echo "ERROR invalid path"; exit 1; }; RESOLVED="$(cd "$RESOLVED_CWD" && realpath -m -- "$FILE" 2>/dev/null)" || RESOLVED="$RESOLVED_CWD/$FILE"; case "$RESOLVED" in "$RESOLVED_CWD"/*|"$RESOLVED_CWD") ;; *) echo "ERROR path must be within working directory"; exit 1 ;; esac; ${diffCmd} -- "$FILE" 2>/dev/null`;
}

// Is a cwd-relative `filePath` contained within `cwd`? Mirrors /api/read-file's guard,
// but tolerates a missing target (a deleted file — status 'D' — has no realpath, yet
// its deletion diff is valid). Lexical resolve catches `..` escapes even when the file
// doesn't exist; realpath then hardens against symlink escapes when it does. Exported
// so the local path has a direct unit test. Returns true if the path stays within cwd.
export function isPathWithinCwd(cwd, filePath) {
  const lexicalCwd = path.resolve(cwd);
  const lexicalPath = path.resolve(cwd, filePath);
  const lexicalWithin = lexicalPath === lexicalCwd || lexicalPath.startsWith(lexicalCwd + path.sep);
  if (!lexicalWithin) return false;
  try {
    const realCwd = fs.realpathSync.native(cwd);
    const realPath = fs.realpathSync.native(lexicalPath);
    return realPath === realCwd || realPath.startsWith(realCwd + path.sep);
  } catch {
    // File doesn't exist (deleted, or untracked not yet created): lexical check passed.
    return true;
  }
}

// ===== Shared pathspec guard ===============================================

// Validate a git-show per-file `path` param. We use a LEXICAL check (not realpath)
// because the file may not exist in the working tree — a commit that DELETED it still
// has a diff to show, but `realpath` would throw ENOENT and wrongly block it. A
// relative path with no `..` segment and no absolute/home-relative prefix cannot
// escape the repo root that `git show` resolves against. Rejects null bytes, POSIX
// and Windows absolute paths, `~`-relative paths, and any `..` traversal segment.
// Distinct from isPathWithinCwd (WARDEN-151): that one guards a working-tree FILE
// (realpath-hardened against symlink escapes), whereas this validates a git pathspec
// against an arbitrary commit — a path the current tree may not even contain — so a
// purely lexical rule is the right containment model here. Exported so the
// /api/git-ls browse route (WARDEN-573) and its tests can rely on the same rule.
export function isSafeRelativePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.split(/[\\/]/).some((seg) => seg === '..')) return false;
  return true;
}

// ===== Git blame ===========================================================

// `summary` is truncated per line so a giant commit message can't dominate the
// payload. Mirrors the compactness discipline of parseGitLogLine / parseGitShowNameStatus.
export const GIT_BLAME_SUMMARY_MAX = 80;

// Parse `git blame --line-porcelain -- <file>` output into compact per-line
// provenance: [{ line, hash, author, date, summary }]. `--line-porcelain` emits a
// FULL header block for every line (unlike `--porcelain`, which may group lines),
// so each record is: a header line `<hash> <sourceline> <resultline> [<group>]`,
// detail lines (`author`/`author-mail`/`author-time`/`summary`/…), then the file
// content on a TAB-prefixed line that terminates the record. We track the in-flight
// record and emit it when we hit that TAB line. `date` is author-time (epoch sec)
// rendered to ISO 8601 — a PURE function of the input (so the parser is unit-
// testable with a fixed epoch) and the frontend formats it relative for display.
// `summary` is truncated to GIT_BLAME_SUMMARY_MAX. Exported for unit tests.
// See WARDEN-206.
export function parseGitBlame(output) {
  const raw = (output ?? '').toString();
  if (!raw) return [];
  // Tolerate CRLF (remote blame can arrive over an SSH pty with \r\n line ends),
  // mirroring parseGitShowNameStatus's CRLF tolerance.
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));
  const out = [];
  let cur = null;
  for (const ln of lines) {
    // A TAB-prefixed line is the file content for the current record → finalize it.
    if (ln.charCodeAt(0) === 0x09) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    // Record header: <hash> <sourceline> <resultline> [<group-size>]. resultline
    // (m[3]) is the line number in HEAD — exactly what FileViewer renders.
    const m = ln.match(/^([0-9a-f]{4,40})\s+(\d+)\s+(\d+)/);
    if (m) {
      cur = { line: parseInt(m[3], 10), hash: m[1], author: '', authorTime: null, summary: '' };
    } else if (cur) {
      // `author ` does not match `author-mail ` (7th char is '-' vs ' '), so the
      // mail line is naturally skipped — we skim it but don't emit it (compact shape).
      if (ln.startsWith('author ')) {
        cur.author = ln.slice(7);
      } else if (ln.startsWith('author-time ')) {
        const n = parseInt(ln.slice(12).trim(), 10);
        cur.authorTime = Number.isFinite(n) ? n : null;
      } else if (ln.startsWith('summary ')) {
        cur.summary = ln.slice(8);
      }
    }
  }
  return out.map((r) => ({
    line: r.line,
    hash: r.hash,
    author: r.author,
    date: Number.isFinite(r.authorTime) ? new Date(r.authorTime * 1000).toISOString() : '',
    summary: r.summary.length > GIT_BLAME_SUMMARY_MAX
      ? `${r.summary.slice(0, GIT_BLAME_SUMMARY_MAX - 1)}…`
      : r.summary,
  }));
}

// Build the remote (SSH) shell command that blames one file under `cwd`. Extracted
// (and exported) so the fragile shell template is unit-tested directly, the same way
// buildGitDiffScript / buildReadFileScript are. shellQuote yields a single-quoted
// POSIX token spliced in bare — same WARDEN-122 quoting discipline as git-log/show —
// and the `--` stops option parsing so a path named like a flag can't inject options.
// Mirrors /api/git-show's remote command shape.
export function buildGitBlameScript(cwd, filePath) {
  return `cd ${shellQuote(cwd)} && git blame --line-porcelain -- ${shellQuote(filePath)} 2>/dev/null`;
}
