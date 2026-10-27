import { spawn } from 'node:child_process';
import { shellQuote } from './ssh.js';
import { unescapeGitPath } from './gitStatus.js';
import { runLocalCapture } from './gitTransport.js';

// ---- Workspace content search (grep) — WARDEN-145 ---------------------------
// Completes the locate→read loop WARDEN-39 (file reading) started: lets a human
// find a file by CONTENT (function name, error string, …) and open it in the
// FileViewer, instead of having to know the exact path by hand. Mirrors the
// read-file/git-status patterns: chat-scoped, cwd-contained, local async runLocalGit vs
// remote `run(host, script)` split. The `query` is user input that runs in a
// remote shell, so it carries the same injection surface read-file guards
// against — it is shellQuoted and preceded by `--`, output is bounded, and
// binaries are skipped (-I).
const SEARCH_MAX_RESULTS = 30;
// Upper bound on one local streamed search (WARDEN-1752); a recursive session
// grep can legitimately be slow, so this is generous.
export const SEARCH_STREAM_TIMEOUT_MS = 60000;
const SEARCH_MAX_LINE_LEN = 300; // display cap applied by parseSearchOutput
// Per-line transfer cap — the local/remote single source of truth for "how much
// of one matched line we move before stopping". The remote script's `cut -c1-…`
// and the local streamBoundedSearch both read this; SEARCH_MAX_LINE_LEN (300) is
// a stricter display-only truncation applied afterward by parseSearchOutput.
const SEARCH_TRANSFER_LINE_LEN = 1000;

// Parse one `<path>:<line>:<text>` line as emitted by `git grep -n` / `rg -n` /
// `grep -rn`. The line number is the FIRST ':digits:' after the path (non-greedy
// match), so a text body containing its own ':123:' isn't misread as the line.
//
// The path is C-unescaped: `git grep` (both producers — buildSearchScript's
// remote script and searchLocalRaw's local stream) quotes any path holding a
// non-ASCII byte, backslash or double-quote under the default core.quotePath=true,
// exactly like `git ls-files`/`git show --name-status`. Without this the octal
// form ("s\303\274b/caf\303\251.js") is what the dialog renders, copies, and
// hands to the FileViewer — where it string-equals no real path, so the file
// silently fails to open. unescapeGitPath is a no-op on paths that don't start
// with `"`, so the rg/grep fallbacks (raw UTF-8) pass through unchanged.
// See WARDEN-962; sibling fixes WARDEN-650/675/676.
//
// `text` (group 3) is raw matched line CONTENT, not a path — deliberately not
// unescaped, or a literal `\n` in source code would be mangled into a newline.
export function parseSearchLine(raw) {
  const m = raw.match(/^(.*?):(\d+):(.*)$/);
  if (!m) return null;
  return { file: unescapeGitPath(m[1]), line: parseInt(m[2], 10), text: m[3] };
}

// Parse raw search stdout into capped, truncated { file, line, text } rows.
// Stops at maxResults so a huge match set (e.g. searching "import") is never
// fully parsed — bounded work, bounded response.
export function parseSearchOutput(raw, maxResults = SEARCH_MAX_RESULTS, maxLineLen = SEARCH_MAX_LINE_LEN) {
  const results = [];
  for (const line of String(raw).split('\n')) {
    if (!line) continue;
    const parsed = parseSearchLine(line);
    if (!parsed) continue;
    if (parsed.text.length > maxLineLen) parsed.text = parsed.text.slice(0, maxLineLen);
    results.push(parsed);
    if (results.length >= maxResults) break;
  }
  return results;
}

// Build the remote (SSH) shell script that searches tracked files under `cwd`
// for `query`. Extracted + exported so the containment/quoting can be unit-
// tested, exactly like buildReadFileScript. `query` is user input interpolated
// into a remote shell, so it MUST be shellQuoted (single-quoted POSIX token)
// and preceded by `--` (option-injection stop). Other guards baked into the
// script (all reviewed against the remote execution environment):
//   set +o pipefail  — a user's ~/.bash_profile may set pipefail; under it
//     `git grep | head` exits 141 (SIGPIPE) once head closes the pipe after 30
//     lines, which `run()` reads as failure and silently drops all 30 results.
//   -F / --fixed-strings — treat the query as a LITERAL substring. The use case
//     is "find this error string / function name", not a regex; -F also stops
//     `.` matching every line (a DoS amplifier) and avoids invalid-regex→empty.
//   command -v rg — fall back to grep only when rg is ABSENT, not on rg's
//     exit-1-no-match (else grep needlessly re-walks the tree on every miss).
//   cut -c1-1000 — bound each line's transfer over SSH (a committed minified
//     bundle is one multi-MB line) before head bounds the line COUNT.
//   exit status (WARDEN-1963) — `head`'s status would always win, so a tool that
//     FAILED (corrupt .git/index → git grep exit 128) read as a clean empty run and
//     the dialog said "No results found". The tool's PIPESTATUS[0] is propagated as
//     the script's exit code ONLY when it is not 0 (match) / 1 (no match) / 141
//     (SIGPIPE from head) AND the tool emitted ZERO lines. A rg/grep exit 2 that
//     accompanies real partial hits (unreadable subdir) keeps returning them, since
//     the route drops stdout on a failed run.
// `git grep -n -I` searches only tracked files (skips node_modules/dist/.git)
// and skips binaries (-I). git rev-parse gates the rg/grep fallback to non-repos.
export function buildSearchScript(cwd, query) {
  const q = shellQuote(query);
  // The pipeline runs inside $( … ) so PIPESTATUS[0] — the search tool's OWN status,
  // which `head` would otherwise mask — can be read immediately after it and
  // appended as the last line (WARDEN-1963). Escapes: `\\n` is a bash-side newline
  // (a bare `\n` in this template literal would be a JS newline) and `\${` keeps
  // bash's PIPESTATUS expansion from being a JS interpolation.
  return `cd ${shellQuote(cwd)} 2>/dev/null || exit 0; set +o pipefail; r=$(if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git grep -n -I -F -- ${q}; elif command -v rg >/dev/null 2>&1; then rg --line-number --no-heading -F -- ${q} .; else grep -rnI -F -- ${q} .; fi | cut -c1-${SEARCH_TRANSFER_LINE_LEN} | head -n ${SEARCH_MAX_RESULTS}; printf '\\n%s' "\${PIPESTATUS[0]}"); s=\${r##*$'\\n'}; b=\${r%$'\\n'*}; printf '%s' "$b"; [ -n "$b" ] || [ "$s" -le 1 ] || [ "$s" -eq 141 ] || exit "$s"; exit 0`;
}

// Async, non-blocking wrapper for tiny local PROBE commands only (git rev-parse,
// `rg --version`): bounded by a 10s timeout (SIGTERM) with stderr CAPTURED (not
// inherited) so probe noise ("fatal: not a git repository") never hits the server
// console. The workspace search itself is NOT run through here — it is streamed by
// streamBoundedSearch below so its output is bounded AT THE SOURCE. Delegates to
// runLocalCapture (WARDEN-441): previously a spawnSync that froze the event loop
// on every /api/search-files request while the probe ran.
async function runLocalSearch(bin, args, cwd) {
  return runLocalCapture(bin, args, { cwd, timeout: 10000 });
}

// PATH-presence probe — the local twin of the remote `command -v rg` gate that
// decides whether the non-repo fallback runs ripgrep or plain grep. Async; an
// absent tool surfaces as a spawn ENOENT (runLocalCapture's `error.code`), not
// entangled with a streamed run.
async function hasBinary(bin) {
  const r = await runLocalSearch(bin, ['--version'], undefined);
  return r.error?.code !== 'ENOENT';
}

// Stream a local search tool's stdout and bound it AT THE SOURCE — the local twin
// of the remote `| cut -c1-<TRANSFER> | head -n <MAX>`. We read stdout
// incrementally, cap each matched line to SEARCH_TRANSFER_LINE_LEN, and STOP
// (kill the child) once we reach SEARCH_MAX_RESULTS lines. This NEVER depends on
// a maxBuffer cap: the previous spawnSync twin collected the ENTIRE stdout into a
// 4MB buffer and, on overflow (ENOBUFS), returned '' — so a search that had 30
// real matches for a common term ("import") came back as "No results found".
// Streaming caps where the results are PRODUCED, exactly like the remote script.
// Spawned as an argv array with `{cwd}` (NO shell), so the query is a literal
// argument with zero injection surface — it needs NO shellQuote here, unlike the
// remote path which builds a shell string for SSH. Returns the bounded raw stdout
// in the same `path:line:text` format the remote produces, so parseSearchOutput
// parses both paths identically. Exported for direct unit testing of the bound.
//
// streamBoundedSearchResult (WARDEN-1952) is the failure-aware core: it resolves
// `{ raw, failed, reason }` so a caller can tell "the tool ran and found nothing"
// from "the tool could not run / could not finish". `failed` is true ONLY when
// there is nothing to show AND the run did not end cleanly:
//   - the spawn `error` event (ENOENT / EACCES / …)            reason 'spawn'
//   - the timeout fired with ZERO lines gathered                reason 'timeout'
//   - `close` with a non-null exit code outside {0,1} that we did NOT cause
//     (`!stopped`) and zero lines collected (git grep exit 128, rg/grep exit 2)
//                                                               reason 'exit <code>'
// It never flags a result that already holds lines (rg/grep exit 2 with partial
// hits keeps its real results), and never flags our own cap-triggered SIGTERM.
// Exit 1 = genuine "no matches" for git grep/rg/grep → failed:false, raw ''.
// streamBoundedSearch stays the string-returning wrapper (byte-identical).
export async function streamBoundedSearch(bin, args, cwd, opts = {}) {
  return (await streamBoundedSearchResult(bin, args, cwd, opts)).raw;
}

export function streamBoundedSearchResult(bin, args, cwd, opts = {}) {
  const maxResults = opts.maxResults ?? SEARCH_MAX_RESULTS;
  const transferLen = opts.transferLen ?? SEARCH_TRANSFER_LINE_LEN;
  const timeout = opts.timeout ?? SEARCH_STREAM_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const lines = [];
    let buf = '';
    let skipping = false; // discarding the tail of an over-long (no-newline-yet) line
    let stopped = false;
    let settled = false;
    const cap = (s) => (s.length > transferLen ? s.slice(0, transferLen) : s);
    let timer = null;
    const done = (failure = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ raw: lines.join('\n'), failed: failure !== null, reason: failure });
    };
    const stop = () => { stopped = true; try { child.kill('SIGTERM'); } catch {} };
    // WARDEN-1752: a hung child may never close its pipes, so on expiry we stop()
    // it and settle IMMEDIATELY with the partial lines gathered so far rather
    // than waiting on 'close'.
    if (timeout > 0) timer = setTimeout(() => { stop(); done(lines.length === 0 ? 'timeout' : null); }, timeout);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stopped || settled) return;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skipping) { skipping = false; continue; } // remainder of an over-long line
        lines.push(cap(line));
        if (lines.length >= maxResults) { stop(); return; }
      }
      // No newline in buf. If buf already exceeds the cap, this single physical
      // line is over-long (e.g. a minified bundle): emit its first transferLen
      // chars, then drop the rest until the line's terminating newline arrives.
      if (skipping) buf = '';
      else if (buf.length > transferLen) {
        lines.push(cap(buf));
        buf = '';
        skipping = true;
        if (lines.length >= maxResults) stop();
      }
    });
    // Drain stderr so it can't backpressure the pipe. It is NOT inherited, so the
    // tool's diagnostics never spam the server console (mirrors runLocalSearch).
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', () => done('spawn')); // ENOENT (tool absent) / spawn failure → failed, no results
    child.on('close', (code) => {
      // Flush a trailing newline-less line ONLY on natural EOF. When we `stop()`-ed
      // at the cap, `buf` still holds the rest of that chunk — it must NOT be flushed
      // (it would push past maxResults, chunk-delivery-dependent and flaky).
      if (!stopped && !skipping && buf) lines.push(cap(buf));
      // Exit 0/1 = matches / no matches. Anything else with nothing collected and
      // not caused by our own stop() is a real failure (e.g. git grep 128).
      const failedExit = !stopped && lines.length === 0 && code !== null && code !== 0 && code !== 1;
      done(failedExit ? `exit ${code}` : null);
    });
  });
}

// Local raw search stdout for `query` under `cwd`: the streamed twin of the
// remote buildSearchScript. Prefers `git grep` (tracked files only, -F literal);
// falls back to rg (PATH-gated via hasBinary, mirroring `command -v rg`) then
// plain grep, only when cwd is not a git worktree. Output is bounded AT THE SOURCE
// by streamBoundedSearch (line count + per-line transfer cap) — never by a
// spawnSync maxBuffer — so a many-match search returns its real (≤30) results
// instead of ENOBUFS→''. Returns the bounded raw string ('' for no matches AND for
// spawn failure — use searchLocalRawResult to tell them apart) and never throws. Exported so the local path has test
// coverage parity with the remote buildSearchScript.
export async function searchLocalRaw(cwd, query) {
  return (await searchLocalRawResult(cwd, query)).raw;
}

// Failure-aware twin of searchLocalRaw (WARDEN-1952): same git/rg/grep selection,
// resolves `{ raw, failed, reason }` from streamBoundedSearchResult so the route
// can answer error:'search failed' instead of a confident "No results found".
export async function searchLocalRawResult(cwd, query) {
  // Gate the rg/grep fallback to non-repos (mirrors remote `if git rev-parse…`).
  // rev-parse output is tiny ("true"), and runLocalSearch is async + bounded by a
  // 10s timeout, so this probe never blocks the event loop.
  const gitCheck = await runLocalSearch('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  const insideRepo = gitCheck.ok && (gitCheck.stdout.trim() === 'true');
  if (insideRepo) {
    // git grep: status 1 = no matches (yields ''); 0 = matches. -I skips binaries.
    return streamBoundedSearchResult('git', ['grep', '-n', '-I', '-F', '--', query], cwd);
  }
  // Not a git repo → ripgrep (fast, respects .gitignore) then plain grep. -F = literal.
  if (await hasBinary('rg')) {
    return streamBoundedSearchResult('rg', ['--line-number', '--no-heading', '-F', '--', query, '.'], cwd);
  }
  return streamBoundedSearchResult('grep', ['-rn', '-I', '-F', '--', query, '.'], cwd);
}
