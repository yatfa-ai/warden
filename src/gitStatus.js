// Pure helpers for parsing `git status --porcelain` output.
//
// Extracted from the /api/git-status route so the parsing is unit-testable —
// the porcelain format has subtle whitespace rules that are easy to break
// (see WARDEN-107).

/**
 * Parse `git status --porcelain` output into a list of changed files.
 *
 * The porcelain v1 format is a fixed-width record per line:
 *
 *     XY <path>
 *
 * where `X` is the index (staged) status and `Y` is the worktree status, each a
 * single character (a space means "no change in that slot"), followed by a
 * single space separator at position 2, then the path beginning at position 3.
 *
 *   " M file.js"  → X=' ' (not staged) Y='M' (worktree modified)  → status "M"
 *   "M  file.js"  → X='M' (staged)     Y=' ' (clean worktree)     → status "M"
 *   "A  file.js"  → X='A' (added)      Y=' '                       → status "A"
 *   "?? file.js"  → untracked                                      → status "??"
 *
 * CRITICAL: a status code can legitimately START WITH A SPACE (" M" = unstaged
 * modification — the single most common case). The full multi-line output must
 * therefore NEVER be `.trim()`-ed before parsing: trimming the whole blob strips
 * that leading space from the FIRST line, which then makes `substring(3)` read
 * one character too far and truncates the first file's path (e.g. "README.md"
 * becomes "EADME.md"). This function splits into lines first and preserves each
 * line's leading whitespace.
 *
 * Each file is also tagged `conflict: boolean` via `isConflictStatus` so a
 * conflicted path (UU/AA/…) can be rendered distinctly instead of falling
 * through to the generic-gray row. The field is additive — existing consumers
 * that destructure `{ path, status }` ignore it.
 *
 * In addition, the raw porcelain X/Y columns are exposed verbatim as `staged`
 * (X — the index/staged status) and `worktree` (Y — the worktree/unstaged
 * status), each a single character where a space means "no change in that slot".
 * `.trim()`-collapsing the status code destroys the position — "M " (staged) and
 * " M" (unstaged) both yield `status:"M"` — so the two columns are what let a
 * renderer tell a STAGED-for-commit file apart from unstaged WIP (WARDEN-369).
 * Both fields are additive alongside `status`, which is kept for backward compat.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git status --porcelain`.
 * @returns {Array<{path: string, status: string, staged: string, worktree: string, conflict: boolean}>} Changed files, or `[]` when clean.
 */
// The unmerged (conflict) XY codes from `git status --porcelain` v1. For an
// unmerged path git sets BOTH columns — at least one 'U' (unmerged), or the
// both-added/both-deleted forms DD/AA. A repo mid-merge/cherry-pick/rebase
// emits exactly these for the paths it could not resolve automatically.
const UNMERGED_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Returns true if a porcelain XY status code marks an unmerged/conflicted path.
 *
 * The unmerged codes are `DD AU UD UA DU AA UU` — git writes one of these in
 * BOTH the index (X) and worktree (Y) columns when a path could not be merged
 * automatically (merge/cherry-pick/rebase conflict). Ordinary single-column
 * codes (`M`/`A`/`D`, with the other column a space) and `??` (untracked) are
 * never conflicts. Extracted as its own pure helper so conflict detection is
 * unit-testable in isolation, mirroring `parseGitStatusPorcelain`.
 *
 * @param {string|Buffer|undefined} xy - The raw two-char XY status code (e.g. "UU", "M", "??").
 * @returns {boolean}
 */
export function isConflictStatus(xy) {
  return UNMERGED_STATUS_CODES.has((xy ?? '').toString().trim());
}

/**
 * Decide whether a repo is in detached-HEAD state from `git symbolic-ref -q HEAD`.
 *
 * `git symbolic-ref -q HEAD` exits 0 (printing `refs/heads/<name>`) when HEAD
 * points at a branch, and exits non-zero with no output when HEAD is detached.
 * BUT it also exits non-zero outside any git repo ("fatal: not a git
 * repository"), so the exit code alone is ambiguous — a non-git cwd would
 * falsely read as detached. The caller therefore passes `inGitRepo` (true iff
 * `git rev-parse --abbrev-ref HEAD` succeeded, i.e. the repo is real), and we
 * only call it detached when BOTH hold: inside a repo AND symbolic-ref refused
 * to resolve a branch.
 *
 * This is the canonical git detached-HEAD test, preferred over
 * `branch === 'HEAD'` (a branch could in principle be named "HEAD"). Extracted
 * as a pure helper so the detection is unit-testable in isolation, mirroring
 * `parseAheadBehind` (WARDEN-239). Detection is fundamentally exit-code based
 * (not stdout parsing), hence the exitCode argument.
 *
 * @param {number|null|undefined} symbolicRefExitCode - exit status of `git symbolic-ref -q HEAD`.
 * @param {boolean} inGitRepo - true iff HEAD resolved (we are inside a real git repo).
 * @returns {boolean}
 */
export function isDetachedHead(symbolicRefExitCode, inGitRepo) {
  if (!inGitRepo) return false;
  // Only status === 0 means HEAD resolved to a branch. Any other value — a
  // non-zero exit (1/128 …), or null when the process was killed by a signal —
  // means HEAD did NOT resolve, i.e. detached. Strict `!== 0` (rather than
  // `Number(…) !== 0`) is what keeps null from collapsing to 0 and reading as
  // attached.
  return symbolicRefExitCode !== 0;
}

/**
 * Normalize `git rev-parse --short HEAD` output into a short SHA string (or null).
 *
 * A non-zero exit / empty output (non-git cwd, or a freshly-init'd repo with no
 * commits yet) → null, mirroring `parseAheadBehind`'s tolerance of missing
 * input. On success returns the trimmed short SHA (e.g. "554b5e9"). The short
 * SHA replaces the misleading literal "HEAD" label the badge would otherwise
 * render for a detached repo (WARDEN-239). Extracted as a pure helper so the
 * normalization is unit-testable, mirroring `parseAheadBehind`.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git rev-parse --short HEAD`.
 * @param {number|null|undefined} [exitCode] - exit status; when omitted/unknown the output is trusted.
 * @returns {string | null}
 */
export function normalizeHeadSha(output, exitCode) {
  if (exitCode !== undefined && exitCode !== 0) return null;
  const sha = (output ?? '').toString().trim();
  return sha || null;
}

/**
 * Normalize `git rev-parse --abbrev-ref @{u}` output into the short upstream
 * name (e.g. `origin/main`), or `null` when there is no upstream.
 *
 * `@{u}` is git's upstream rev spec (the same one `parseAheadBehind`'s
 * `@{u}...HEAD` range uses). `git rev-parse --abbrev-ref @{u}` prints the short
 * tracking branch name + exit 0 when one is configured, and exits non-zero with
 * empty stdout when HEAD has NO upstream — a named branch that was never
 * `push -u`'d (an agent ran `git checkout -b feature` with no `-u`), a detached
 * HEAD, or a non-git cwd. We surface the trimmed short name on success and
 * `null` for empty/non-zero, mirroring `normalizeHeadSha`'s tolerance of missing
 * input (the optional `exitCode` lets a caller pass the raw exit status; when
 * omitted the output is trusted, like `parseAheadBehind`).
 *
 * This exists because ahead/behind alone CANNOT tell a non-tracking branch from
 * a synced one: both yield `{ahead:null, behind:null}` (no `@{u}` → nulls), so
 * without the upstream name a never-pushed branch renders as a bare cyan label
 * indistinguishable from in-sync — a durability risk (local-only work, no remote
 * backup) a human glancing at the badge needs to see (WARDEN-243).
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git rev-parse --abbrev-ref @{u}`.
 * @param {number|null|undefined} [exitCode] - exit status; when omitted/unknown the output is trusted.
 * @returns {string | null}
 */
export function parseUpstream(output, exitCode) {
  if (exitCode !== undefined && exitCode !== 0) return null;
  const name = (output ?? '').toString().trim();
  return name || null;
}

export function parseGitStatusPorcelain(output) {
  const raw = (output ?? '').toString();
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // tolerate CRLF (e.g. over SSH)
    .filter((line) => line.trim())           // drop the trailing empty line + blanks
    .map((line) => {
      const statusCode = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim();
      // Preserve the porcelain X/Y position so a STAGED-for-commit file is no longer
      // indistinguishable from an unstaged WIP file (WARDEN-369). `status` is the
      // collapsed/trimmed code existing consumers already read (kept verbatim for
      // backward compat); `staged`/`worktree` are the raw single columns:
      //   X = line.charAt(0) = index/staged status  (' ' = nothing staged)
      //   Y = line.charAt(1) = worktree/unstaged status (' ' = clean worktree)
      // charAt — not the trimmed substring — is what keeps the position: "M " and
      // " M" both collapse to status "M", but staged 'M'/' ' vs ' '/'M' differ.
      // This is a DIFFERENT trim than the whole-blob `.trim()` pitfall above: the
      // line is already split out, so charAt reads each line's own columns safely.
      return {
        path: filePath,
        status: statusCode || '??',
        staged: line.charAt(0),
        worktree: line.charAt(1),
        conflict: isConflictStatus(statusCode),
      };
    })
    .filter((f) => f.path.length > 0);
}

/**
 * Parse `git rev-list --left-right --count @{u}...HEAD` output into
 * `{ ahead, behind }`.
 *
 * For the symmetric difference `@{u}...HEAD` (upstream ... HEAD), git prints
 * two tab-separated counts:
 *
 *   `<behind>\t<ahead>`
 *
 * The LEFT count is commits reachable from `@{u}` but not `HEAD` — commits the
 * upstream has that we don't (= behind / remote is ahead of us). The RIGHT
 * count is commits reachable from `HEAD` but not `@{u}` — local commits not yet
 * pushed (= ahead / unpushed). So `"0\t3"` means "0 behind, 3 ahead" (3
 * unpushed commits), and `"2\t0"` means "2 behind, 0 ahead".
 *
 * When there is no upstream (detached HEAD, an untracked branch, or a non-git
 * cwd) git exits non-zero with empty stdout. We surface that — and any other
 * malformed/garbage output — as `{ ahead: null, behind: null }` rather than
 * throwing, mirroring `parseGitStatusPorcelain`'s tolerance of missing/empty
 * input (see WARDEN-153).
 *
 * @param {string|Buffer|undefined} output - Raw stdout from the rev-list command.
 * @returns {{ ahead: number | null, behind: number | null }}
 */
export function parseAheadBehind(output) {
  const raw = (output ?? '').toString().trim();
  if (!raw) return { ahead: null, behind: null };
  const parts = raw.split('\t');
  if (parts.length !== 2) return { ahead: null, behind: null };
  const behind = parseInt(parts[0], 10);
  const ahead = parseInt(parts[1], 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) return { ahead: null, behind: null };
  return { ahead, behind };
}

/**
 * Count the number of `git stash list` entries.
 *
 * Delegates to `parseStashList` (same line-splitting/CRLF/empty-filter pipeline)
 * rather than re-implementing it — mirroring how `parseGitStatusPorcelain` reuses
 * `isConflictStatus`. `git stash list` prints one reflog line per shelved WIP
 * entry; an empty output (no stashes, or a non-git / no-cwd repo whose
 * `git stash list` errors to stderr) has zero entries. We surface the count so a
 * stashed-but-clean tree reads `stashCount: N` instead of a misleading
 * `clean: true` — the core gap, since `git status --porcelain` emits no stash
 * entries (WARDEN-211).
 *
 * Mirrors `parseAheadBehind`: empty / undefined / whitespace-only input → `null`
 * (the frontend renders no indicator), `N` entries → `N`. The route additionally
 * guards non-git/no-cwd with `branch ? count : null`.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git stash list`.
 * @returns {number | null}
 */
export function parseStashCount(output) {
  const count = parseStashList(output).length;
  return count > 0 ? count : null;
}

/**
 * Parse `git diff HEAD --shortstat` output into
 * `{ files, insertions, deletions }`, or `null` when the tree matches HEAD.
 *
 * `--shortstat` prints a single summary line for the combined (staged +
 * unstaged) changes vs HEAD:
 *
 *   " 3 files changed, 847 insertions(+), 203 deletions(-)"
 *
 * The insertions/deletions halves are OPTIONAL — an insertions-only change omits
 * the deletions half and vice versa, and the singular form drops the trailing
 * "s" ("1 file changed, 1 insertion(+)", "1 file changed, 1 deletion(-)"). When
 * the working tree matches HEAD git prints NOTHING (a clean tree, OR a tree with
 * ONLY untracked files — `git diff HEAD` counts tracked edits only), so
 * empty/garbage/clean input returns `null`, never throwing — same discipline as
 * `parseAheadBehind` / `parseStashCount`. The return shape is additive so the
 * frontend can render a compact `+N −M` magnitude chip (WARDEN-411).
 *
 * RENDERING CAVEAT (WARDEN-411): the line stat counts TRACKED (staged + unstaged)
 * edits vs HEAD. A purely-UNTRACKED new file (`??` in porcelain) contributes to
 * the porcelain file list but NOT to these numbers (GitHub/gitk behave
 * identically). The frontend therefore ties the chip to `insertions + deletions
 * > 0` so an all-untracked WIP renders no misleading `+0 −0` — untracked adds
 * keep speaking through the existing file count.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git diff HEAD --shortstat`.
 * @returns {{ files: number, insertions: number, deletions: number } | null}
 */
export function parseDiffStat(output) {
  const raw = (output ?? '').toString().trim();
  if (!raw) return null;
  const files = raw.match(/(\d+)\s+files?\s+changed/);
  const insertions = raw.match(/(\d+)\s+insertions?\(\+\)/);
  const deletions = raw.match(/(\d+)\s+deletions?\(-\)/);
  // Require at least one recognizable clause so arbitrary garbage → null (mirrors
  // parseAheadBehind's rejection of malformed input) rather than a {0,0,0} lie.
  if (!files && !insertions && !deletions) return null;
  return {
    files: files ? parseInt(files[1], 10) : 0,
    insertions: insertions ? parseInt(insertions[1], 10) : 0,
    deletions: deletions ? parseInt(deletions[1], 10) : 0,
  };
}

/**
 * Build the local (host) argv to run `git -C <cwd> <args>` INSIDE a yatfa
 * container via `docker exec`. The in-container cwd is passed to git with `-C`
 * (not a shell `cd`) so there is NO shell and therefore NO injection surface:
 * `gitArgs` are spliced verbatim after `git`, exactly like the manual-local
 * `spawnSync('git', args, {cwd})` path this mirrors. `docker exec <c>` (no
 * `-w`) runs in the container's default dir, then `git -C <cwd>` re-targets —
 * robust whether or not the image set a WORKDIR.
 *
 * Pure (just builds an array) so the docker-exec transport is unit-testable
 * without docker. The argv is `['docker', 'exec', container, 'git', '-C', cwd,
 * ...gitArgs]`. See WARDEN-235.
 *
 * @param {string} container - Container name (chat.container).
 * @param {string} cwd - In-container working directory (derived at discovery).
 * @param {string[]} gitArgs - git argv AFTER `git` (e.g. ['status','--porcelain']).
 * @returns {string[]}
 */
export function buildDockerGitArgv(container, cwd, gitArgs) {
  return ['docker', 'exec', container, 'git', '-C', cwd, ...gitArgs];
}

/**
 * Parse `git stash list --pretty=format:%gd|%s|%cr` output into
 * `[{ ref, subject, date }]`.
 *
 * `%gd` is the reflog selector (`stash@{0}`), `%s` the stash subject (e.g.
 * "WIP on main: abc1234 …"), and `%cr` the relative committer date. The subject
 * sits in the MIDDLE and MAY contain the `|` separator (a stash created with a
 * custom message like "merge a | b"), so — like `parseGitLogLine` — we peel the
 * ref off the front and the date off the back, leaving everything between as the
 * subject. CRLF (over SSH) is tolerated per line.
 *
 * Empty / undefined input → `[]` (no stashes), never throws. Exported for unit
 * tests. See WARDEN-211.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git stash list --pretty`.
 * @returns {Array<{ ref: string, subject: string, date: string }>}
 */
export function parseStashList(output) {
  const raw = (output ?? '').toString();
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // tolerate CRLF (e.g. over SSH)
    .filter((line) => line.trim())           // drop the trailing empty line + blanks
    .map((line) => {
      const firstPipe = line.indexOf('|');
      if (firstPipe === -1) return { ref: line, subject: '', date: '' };
      const ref = line.slice(0, firstPipe);
      const tail = line.slice(firstPipe + 1);
      const lastPipe = tail.lastIndexOf('|');
      if (lastPipe === -1) return { ref, subject: tail, date: '' };
      const date = tail.slice(lastPipe + 1);
      const subject = tail.slice(0, lastPipe);
      return { ref, subject, date };
    });
}

/**
 * Parse `git reflog -n N --pretty=format:%h|%gs|%cr` output into
 * `[{ hash, subject, date }]`.
 *
 * `%h` is the abbreviated commit hash, `%gs` the reflog subject — i.e. the
 * OPERATION the agent performed (`"reset: moving to HEAD~1"`,
 * `"checkout: moving from main to feat"`, `"commit: …"`, `"rebase finished: …"`,
 * `"pull: …"`), and `%cr` the relative committer date. The subject sits in the
 * MIDDLE and MAY contain the `|` separator (a commit message can carry a pipe),
 * so — like `parseStashList` — we peel the hash off the front and the date off
 * the back, leaving everything between as the subject. CRLF (over SSH) is
 * tolerated per line.
 *
 * Empty / undefined input → `[]` (no entries), never throws. Exported for unit
 * tests. See WARDEN-460.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git reflog --pretty`.
 * @returns {Array<{ hash: string, subject: string, date: string }>}
 */
export function parseReflog(output) {
  const raw = (output ?? '').toString();
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // tolerate CRLF (e.g. over SSH)
    .filter((line) => line.trim())           // drop the trailing empty line + blanks
    .map((line) => {
      const firstPipe = line.indexOf('|');
      if (firstPipe === -1) return { hash: line, subject: '', date: '' };
      const hash = line.slice(0, firstPipe);
      const tail = line.slice(firstPipe + 1);
      const lastPipe = tail.lastIndexOf('|');
      if (lastPipe === -1) return { hash, subject: tail, date: '' };
      const date = tail.slice(lastPipe + 1);
      const subject = tail.slice(0, lastPipe);
      return { hash, subject, date };
    });
}

/**
 * Derive `{ host, owner, repo, web }` from a single git remote URL.
 *
 * `git remote -v` prints the raw clone URL a checkout came from. That URL's
 * SCHEME is irrelevant to "where does this live on the web" — GitHub/GitLab/
 * Bitbucket serve their web UI over https regardless of whether the agent cloned
 * via https, ssh (scp-like or explicit), or the dumb git:// protocol. So this
 * parser resolves the WEB TARGET from the URL's structure, not its protocol:
 *
 *   https://github.com/owner/repo(.git)   → host github.com, owner, repo
 *   git@github.com:owner/repo.git (scp)   → same (host stripped of the user@)
 *   ssh://git@github.com:22/o/r.git       → same (port + user stripped)
 *   ssh://git@gitlab.example.com:2222/g/s/p.git → host gitlab.example.com (self-hosted)
 *   /path/to/repo  /  file:///path/to/repo → no host → all null (no web equivalent)
 *
 * `web` is built ONLY when host + owner + repo are all present (i.e. the path has
 * at least two segments — the `owner/repo` convention every hosted web service
 * uses). A single-segment path (`ssh://git@gitolite.io/myrepo`, a bare server) has
 * no `owner/repo` structure → `web` null. This is what separates "self-hosted
 * GitLab, linkify it" from "bare ssh server, nothing to open". For GitLab nested
 * groups (`group/subgroup/project`) the FULL path is preserved in `web` (so the
 * deep link resolves) while `owner`/`repo` are the first/last segments (display).
 *
 * `file://` and bare local paths carry no host and so return all-null — mirroring
 * `parseAheadBehind`'s tolerance (empty/garbage never throws). The `web` URL has
 * any trailing `.git` stripped and always uses `https://` (the web UI's scheme).
 *
 * Exported for unit tests so the URL→{host,owner,repo,web} mapping is locked
 * independently of the route/transport. See WARDEN-528.
 *
 * @param {string|Buffer|undefined} input - One raw remote URL (as printed by `git remote -v`).
 * @returns {{ host: string | null, owner: string | null, repo: string | null, web: string | null }}
 */
export function parseRemoteUrl(input) {
  const url = (input ?? '').toString().trim();
  const empty = { host: null, owner: null, repo: null, web: null };
  if (!url) return empty;

  let host = null;
  let pathPart = null;

  // 1. Scheme URL: <scheme>://[user[:pass]@]host[:port][/path]. A scheme is
  //    letter-led and followed by `://` — the only forms git emits here are http,
  //    https, ssh, and git (plus file for local clones). The host is the segment
  //    after any userinfo and before an optional `:port`; the path is the rest.
  const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/:?#]+)(?::\d+)?(?:\/(.*))?$/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    // A `file://` remote is a LOCAL clone (file:///abs/path or file://host/path)
    // — it has no web equivalent, so short-circuit to all-null before treating a
    // `file://host/...` host as a web target.
    if (scheme === 'file') return empty;
    host = schemeMatch[2];
    pathPart = schemeMatch[3] ?? null;
  } else {
    // 2. SCP-like ssh (no scheme): [user@]host:path. Distinguished from a local
    //    path / Windows drive by requiring a dotted host (`host.tld`) before the
    //    `:` — the overwhelmingly common real form (`git@github.com:owner/repo`).
    //    Ports are NOT expressible in scp form (you'd use `ssh://`), so the colon
    //    here unambiguously separates host from path.
    const scpMatch = url.match(/^(?:[^@/:]+@)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}):(.+)$/);
    if (scpMatch) {
      host = scpMatch[1];
      pathPart = scpMatch[2];
    } else {
      // 3. Bare / relative local path → no host, no web equivalent.
      return empty;
    }
  }

  if (!host) return empty;
  if (!pathPart) return { host, owner: null, repo: null, web: null };

  // Strip a leading slash (scp paths have none; scheme paths do) and a trailing
  // `.git` (the conventional clone suffix — not part of the repo's web identity).
  const cleaned = pathPart.replace(/^\/+/, '').replace(/\.git$/i, '');
  const segs = cleaned.split('/').filter((s) => s.length > 0);
  // Need ≥2 segments to form `owner/repo`. A single segment (a bare-server repo
  // like `myrepo`, or `~/repos/foo` collapsed) has no owner → no web link.
  if (segs.length < 2) {
    return { host, owner: null, repo: segs[0] || null, web: null };
  }
  const owner = segs[0];
  const repo = segs[segs.length - 1];
  // Preserve the FULL path (nested GitLab groups) so the deep link resolves; the
  // `.git` was already stripped from the last segment above.
  const web = `https://${host}/${segs.join('/')}`;
  return { host, owner, repo, web };
}

/**
 * Parse `git remote -v` output into `[{ name, url, host, owner, repo, web }]`.
 *
 * `git remote -v` prints TWO lines per remote — the fetch URL and the push URL —
 * each tagged `(fetch)` / `(push)`:
 *
 *   origin\tgit@github.com:owner/repo.git (fetch)
 *   origin\tgit@github.com:owner/repo.git (push)
 *
 * They are almost always identical; when they differ the FETCH url is the one
 * that says "where this checkout came from", so the first line seen per remote
 * name wins and the push duplicate is dropped. Each surviving URL is run through
 * `parseRemoteUrl` for its `{ host, owner, repo, web }` (reusing that helper the
 * way `parseStashCount` reuses `parseStashList`).
 *
 * Empty / undefined / non-git input → `[]`, never throws — same discipline as
 * `parseGitStatusPorcelain` / `parseStashList`. Exported for unit tests. The
 * route wraps the array as `{ remotes }`. See WARDEN-528.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git remote -v`.
 * @returns {Array<{ name: string, url: string, host: string | null, owner: string | null, repo: string | null, web: string | null }>}
 */
export function parseGitRemotes(output) {
  const raw = (output ?? '').toString();
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // tolerate CRLF (e.g. over SSH)
    .filter((line) => line.trim())           // drop the trailing empty line + blanks
    .reduce((acc, line) => {
      // `name<TAB>url (fetch|push)` — name and url are whitespace-separated; the
      // trailing `(fetch)`/`(push)` tag is matched optionally so a defensive shape
      // still parses. `.+?` is lazy so the tag (not the url) absorbs the trailing
      // ` (fetch)`.
      const m = line.match(/^(\S+)\s+(.+?)\s*(?:\((?:fetch|push)\))?$/);
      if (!m) return acc;
      const name = m[1];
      // First (fetch) line per remote wins; drop the push duplicate.
      if (acc.some((r) => r.name === name)) return acc;
      const url = m[2].trim();
      const { host, owner, repo, web } = parseRemoteUrl(url);
      acc.push({ name, url, host, owner, repo, web });
      return acc;
    }, []);
}
