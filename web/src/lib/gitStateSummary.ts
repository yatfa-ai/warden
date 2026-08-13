// Fleet-wide git aggregation for the surfaces that fan a per-agent /api/git-* call
// across the whole fleet: Fleet Health's per-agent status strip (buildFleetGitStatus),
// its recent-commits feed (mergeFleetCommitsByEpoch), and the sidebar's fleet commit /
// code search (buildFleetCommitGroups / buildFleetCodeGroups).
//
// WARDEN-975 removed the OTHER half of this module — the cached-map aggregators that
// fed the sidebar's fleet git chips, cross-agent collision badges and "triage first"
// callout (summarizeProjectGitState + its ProjectGitAgent shape, the four popover rank
// helpers sortByHeadAgeDesc / sortGitAgentsByMagnitudeDesc / sortByStashCountDesc /
// sortGitAgentsByConflictFirst, the triage trio rankGitTriage / pickGitTriageTop /
// gitTriageReason, and detectProjectFileCollisions / …Impending / …Outgoing) — together
// with gitStateSummary.test.mjs, which covered exactly those. Git in the sidebar is now
// one collapsible section scoped to the FOCUSED pane, so nothing computes fleet-wide
// git state from the per-pane status map any more; the map itself is now focused-only.
// The FileCollision types below survive because CollisionCompareDialog still types its
// props against them (it is reached from the FileViewer's co-editor Compare action).
//
// Pure (no React import) so it is unit-testable directly via node, mirroring diff.ts
// (extracted in WARDEN-151 "so it's testable without a React runner"). The surviving
// fleet helpers are covered by fleetGitStatus / fleetRecentCommits / fleetCommitSearch /
// fleetCodeSearch .test.mjs.

// ---- Cross-agent file-collision shapes (WARDEN-288 / 601 / 639) -------------
//
// The detectors that PRODUCED these are gone with the sidebar's collision badges
// (WARDEN-975). The shapes remain as the prop contract of CollisionCompareDialog,
// which the FileViewer's co-editor "Compare edits" action still fills in directly
// (its `agents` come from findFileCoEditors, not from a fleet detector).
export interface FileCollisionAgent {
  key: string;  // c.key || c.id — the same lookup a per-agent git surface uses
  // `source` marks WHICH side an agent brings to a collision:
  //   'outgoing' — this agent's change to the path lives in an unpushed COMMIT (its
  //     working tree is clean for this path), so the compare dialog fetches the
  //     path's diff from the outgoing range (@{u}..HEAD), NOT the (empty) working tree.
  //   'wip'      — this agent has the path dirty in its working tree (the live side).
  // Omitted ⇒ the compare dialog treats the agent as 'wip' (the working-tree diff).
  source?: 'outgoing' | 'wip';
}

export interface FileCollision {
  path: string;
  agents: FileCollisionAgent[];  // ≥2 distinct agent keys
  kind?: 'live' | 'impending' | 'outgoing';
}

// WARDEN-682: the last-commit freshness threshold — a HEAD commit older than this
// marks an agent "stalled" (💤) in Fleet Health's per-agent strip. ⚠️ This MUST mirror
// `STALE_HEAD_AGE_MS` in web/src/components/sidebar/GitBadges.tsx so Fleet Health and
// the sidebar's git section agree on EXACTLY who is stalled. Kept as a LOCAL copy (NOT
// imported from the .tsx) so this pure module stays unit-testable directly via node
// (the fleet*.test.mjs harnesses import the transpiled module); a runtime import of
// GitBadges.tsx would pull React/radix-ui/lucide and break every test in those files.
const STALE_HEAD_AGE_MS = 7 * 86400_000;

// ---- Fleet-wide commit search aggregation (WARDEN-534) ----------------------
//
// The cross-agent HISTORY layer — the fleet-wide counterpart to the per-agent
// commit-message grep shipped in WARDEN-498. Where buildFleetGitStatus aggregates
// per-agent STATUS across the fleet, this aggregates matched COMMITS: it turns N
// per-agent grep results into one grouped-by-agent view (each group carrying the agent key + project, each row
// carrying whether the commit is ↑unpushed) so a single sidebar-level query
// finds WHERE a change landed across the fleet instead of N manual per-agent
// greps.
//
// Pure (no React import, no fetch) so it is unit-testable directly via node,
// mirroring diff.ts. The fan-out (the actual fetches) lives in the React component; this resolves the searchable population, then
// joins + groups + counts. Ordering follows the same convention as the rest of
// this module: outcomes are processed in the caller's iteration order
// (= chats order), so the returned groups are deterministic and tests assert
// deep equality.

// Minimal slice of Chat the searchable-population gate reads. Defined locally so the
// helper stays decoupled and testable with plain objects rather than the React-layer
// Chat type.
export interface FleetSearchChat {
  id: string;
  key?: string;        // resolved first: searchable agents are keyed by key || id
  project?: string;
  active?: boolean | null;  // null = undiscovered; only active chats are searchable
}

// One searchable agent: the resolved identity (key || id) + its project. The
// fleet fan-out fires a /api/git-log?grep= per one of these.
export interface FleetSearchAgent {
  key: string;
  project: string;
}

/**
 * Resolve the searchable fleet: active chats WITH a project (the population every
 * fleet-wide git fan-out shares), keyed by `key || id`, deduped by key
 * so the same repo is never grepped twice. Non-active / project-less chats are
 * skipped — they are not represented by the fleet UI and grepping them would just
 * produce N error rows (the WARDEN-89 population gate the ticket calls out).
 * Emitted in chats iteration order so the downstream groups stay deterministic.
 */
export function fleetCommitSearchEligible(chats: readonly FleetSearchChat[]): FleetSearchAgent[] {
  const out: FleetSearchAgent[] = [];
  const seen = new Set<string>();
  for (const c of chats) {
    if (!c.active || !c.project) continue;
    const key = c.key || c.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, project: c.project });
  }
  return out;
}

// The fleet commit-search axes (WARDEN-534 = message, WARDEN-559 = content) PLUS the
// WARDEN-589 working-tree CODE axis. The AGGREGATION for message/content is
// mode-agnostic — a hit is just another FleetCommitLike and buildFleetCommitGroups
// groups it identically — so those two modes live with the FETCH (which param to
// splice), not with the grouping. The Code axis is grouped by its OWN fn
// (buildFleetCodeGroups) because its result shape is fundamentally different
// (file:line:text hits, not commits) — see the Code-search section below. Kept as a
// string union (not a const enum) so it survives the TS→ESM test transform without
// runtime support. The name says "Commit" but it now also covers the Code axis;
// renaming is out of scope (the population gate it selects is shared).
export type FleetCommitSearchMode = 'message' | 'content' | 'code';

/**
 * Build the per-agent fetch base URL for the fleet commit search (message/content axes).
 * `mode` selects the param: 'message' → `grep=` (`git log --grep`, WARDEN-498 — searches
 * commit messages); 'content' → `pickaxe=` (`git log -S`/`-G`, WARDEN-559 — searches
 * commit-history diffs to find the commit that ADDED or REMOVED a code string). When
 * `pickaxeRegex` is set in content mode, appends `pickaxeRegex=1` (the broader `-G`
 * diff-text match over the default `-S` count-change match). The component appends
 * `&range=outgoing` to this base for the second (↑unpushed join) fetch. Extracted into
 * the pure layer — not inlined in the React component — so the message⇄content URL swap
 * is unit-testable without a React runner (this repo has none).
 *
 * NOT used by the Code axis: /api/search-files is a POST with a JSON body (not a GET URL),
 * so WARDEN-589's Code mode has its own seam — fleetCodeFetchRequest — rather than
 * overloading this GET-URL helper. The component's fan-out branches to Code before ever
 * reaching this call, so 'code' is never passed here in practice; if it were, it would
 * fall through to the grep= branch (harmless, but unreachable).
 */
export function buildFleetSearchBaseUrl(
  key: string,
  query: string,
  mode: FleetCommitSearchMode,
  pickaxeRegex = false,
): string {
  const id = `id=${encodeURIComponent(key)}`;
  if (mode === 'content') {
    return `/api/git-log?${id}&pickaxe=${encodeURIComponent(query)}${pickaxeRegex ? '&pickaxeRegex=1' : ''}`;
  }
  return `/api/git-log?${id}&grep=${encodeURIComponent(query)}`;
}

// Minimal slice of a /api/git-log commit row (the shape GIT_LOG_PRETTY parses to:
// { hash, subject, author, date, epoch }). Defined locally so this module stays
// decoupled from the React-layer GitCommit type and is testable with plain
// objects — the same decoupling every other helper in this module relies on.
export interface FleetCommitLike {
  hash: string;
  subject: string;
  author?: string;
  date?: string;
  epoch?: number;
}

// One agent's fan-out outcome. `ok: false` = that agent's fetch failed (host
// unreachable / non-ok HTTP / network) — counted as an error but never dropped
// silently, and never blanking the other agents' results (the Promise.allSettled
// contract). `ok: true` carries the agent's grep matches (recent / HEAD-reachable)
// plus the SET of hashes its outgoing (range=outgoing, @{u}..HEAD) grep matched —
// the join key for ↑unpushed.
export type FleetCommitOutcome =
  | { ok: true; key: string; project: string; matches: FleetCommitLike[]; outgoingHashes: Set<string> }
  | { ok: false; key: string; project: string };

// One matched commit, marked with whether it is still ↑unpushed (local-only —
// HEAD has it but @{u} doesn't).
export type FleetCommitHit = FleetCommitLike & { unpushed: boolean };

// One agent's matched commits (the rows under its group header). key + project
// ride along so the React layer can join key → displayName / project without a
// second lookup: each row carries the key it was fanned for.
export interface FleetCommitGroup {
  key: string;
  project: string;
  commits: FleetCommitHit[];
}

export interface FleetCommitSearchResult {
  // Matched agents in chats iteration order (empties dropped). Each group's
  // commits stay in the order /api/git-log returned them (newest first).
  groups: FleetCommitGroup[];
  // # of agents whose fetch failed — surfaced as a "(N unreachable)" note so a
  // partial failure is honest, never a silent false-empty (WARDEN-89).
  errorCount: number;
}

/**
 * Turn N per-agent grep outcomes into the grouped-by-agent fleet view. Drops
 * `ok` agents with no matches (no group for a barren repo); counts `ok: false`
 * agents into `errorCount` without dropping the successful groups; and marks each
 * hit ↑unpushed when its hash also appears in that agent's outgoing set — the
 * precise per-commit join (a match present in BOTH the recent grep and the
 * outgoing @{u}..HEAD grep is a commit HEAD has that @{u} doesn't = unpushed),
 * preferred over the coarse aheadCount>0 signal because it works for agents whose
 * git status isn't cached (every agent in the fleet, not just open panes).
 *
 * Outcomes are processed in caller (chats) order, so the returned groups are
 * deterministic and tests assert deep equality — the convention the rest of this
 * module follows.
 */
export function buildFleetCommitGroups(outcomes: FleetCommitOutcome[]): FleetCommitSearchResult {
  const groups: FleetCommitGroup[] = [];
  let errorCount = 0;
  for (const o of outcomes) {
    if (!o.ok) {
      errorCount += 1;
      continue;
    }
    if (o.matches.length === 0) continue;  // drop empties — no group for a barren repo
    groups.push({
      key: o.key,
      project: o.project,
      commits: o.matches.map((m) => ({ ...m, unpushed: o.outgoingHashes.has(m.hash) })),
    });
  }
  return { groups, errorCount };
}

// ---- Fleet-wide RECENT-commits feed (WARDEN-597) -----------------------------
//
// The no-query "what the fleet just shipped" rollup — the cross-fleet counterpart
// to the per-agent recent-commit list (the GitBadges popover). Where the commit
// search above (WARDEN-534/559) is QUERY-DRIVEN (a typed term fans out to find
// WHERE a change landed), this is the unfiltered TIME-SORTED merge: fan
// /api/git-log?limit=N across every active project agent, flatten every returned
// commit into ONE list, and sort the whole by committer epoch (newest first). The
// result is a glanceable cross-fleet feed — "who just shipped / who went quiet /
// two agents committing the same area" — patterns the independent per-agent lists
// cannot compose into in one glance. The commit-history analog of the
// FleetActivityHeatmap (WARDEN-532), which did the same promotion for activity
// volume; the identical gap existed for commits.
//
// Three load-bearing divergences from buildFleetCommitGroups (each called out in
// WARDEN-597), which is why this gets its OWN aggregation rather than a flag:
//
//  1. FLAT, not grouped. buildFleetCommitGroups groups by agent (preserving
//     per-agent order, dropping empties) — a "matches per agent" view. The recent
//     feed needs every agent's commits in ONE stream, sorted by epoch across the
//     whole fleet, so the newest commit anywhere is on top regardless of who
//     shipped it. That cross-agent time-merge is a different aggregation → a new
//     pure fn (mergeFleetCommitsByEpoch).
//
//  2. NO query, but ↑unpushed IS joined (WARDEN-723 lifted the original recent-only
//     MVP cap). Decision #2 originally bundled "no query AND no outgoing join" to
//     keep the MVP fan-out at N; the no-query half still holds (this is the
//     unfiltered recent view — no grep=/pickaxe=), but each agent now fires its
//     recent + outgoing (range=outgoing, @{u}..HEAD) fetches concurrently (2N, the
//     same 2N the query-driven search pays) so each row can carry the precise
//     per-hash ↑unpushed mark. Decision #1 still bounds the cost: fetch-on-mount +
//     manual ↻ only — never a steady 2N cadence.
//
//  3. `epoch` is the merge key. /api/git-log returns commits carrying `epoch`
//     (committer time, UNIX seconds from %ct). Sorting by epoch desc is the whole
//     point. A degraded line with `epoch == null` (parseGitLogLine's null path,
//     src/server.js:2294 — only partial/test inputs) is placed LAST, stably.
//
// Pure (no React import, no fetch) so it is unit-testable directly via node,
// mirroring buildFleetCommitGroups. The population gate
// is REUSED (fleetCommitSearchEligible — mode-agnostic: active + project, keyed,
// deduped); the fan-out lives in the React component (its own Promise.allSettled,
// the fleet convention). Outcomes are flattened in caller (chats) order BEFORE the
// sort, so equal-epoch ties break by input order — deterministic, so tests assert
// deep equality, the convention the rest of this module follows.

// One agent's recent-commits fan-out outcome. `ok: false` = that agent's /api/git-log
// fetch failed (host unreachable / non-ok HTTP / network) — counted as an error but
// never dropped silently, and never blanking the other agents' commits (the
// Promise.allSettled contract). `ok: true` carries the agent's recent commits in the
// order /api/git-log returned them (newest first) PLUS the SET of hashes its outgoing
// (range=outgoing, @{u}..HEAD) fetch returned — the join key for ↑unpushed. Mirrors
// FleetCommitOutcome (the query-driven search's per-agent outcome), including the
// graceful-degradation contract: a failed outgoing fetch yields an EMPTY
// outgoingHashes (never throws, never false-positives a commit as unpushed). key +
// project ride along so the merged rows can join key → displayName / project without
// a second lookup, mirroring FleetCommitGroup. (WARDEN-723 ported the ↑unpushed join
// from buildFleetCommitGroups; the recent feed now fires 2 fetches per agent — recent
// + outgoing — but decision #1 still bounds the cost: fetch-on-mount + manual ↻ only.)
export type FleetRecentOutcome =
  | { ok: true; key: string; project: string; commits: FleetCommitLike[]; outgoingHashes: Set<string> }
  | { ok: false; key: string; project: string };

// One merged commit row: the commit + which agent/project shipped it + whether it is
// still ↑unpushed. Carried FLAT (not grouped under an agent header) so the feed is a
// single time-sorted list — the cross-fleet "who just shipped" picture the independent
// per-agent lists can't compose into on their own. `commit` is the full FleetCommitLike
// so the React layer has hash/subject/author/date/epoch for the row without a second
// lookup. `unpushed` is the precise per-hash join against the agent's outgoing
// (@{u}..HEAD) set — mirrors FleetCommitHit.unpushed (WARDEN-723 — ported from
// buildFleetCommitGroups' line-1039 join `o.outgoingHashes.has(m.hash)`); it is NEVER
// coarse per-agent (a commit is unpushed iff ITS hash is in that agent's outgoing set).
export interface FleetRecentCommitRow {
  key: string;
  project: string;
  commit: FleetCommitLike;
  unpushed: boolean;
}

export interface FleetRecentCommitsResult {
  // Every commit across the fleet, flat + sorted by epoch desc (null-epoch rows
  // last, stably). The component slices this to its glance bound (top 20–30).
  rows: FleetRecentCommitRow[];
  // # of agents whose fetch failed — surfaced as a "(N unreachable)" note so a
  // partial failure is honest, never a silent false-empty (WARDEN-89).
  errorCount: number;
}

/**
 * Turn N per-agent recent-commits outcomes into ONE flat, time-sorted list — the
 * no-query "what the fleet just shipped" feed (WARDEN-597). Unlike
 * buildFleetCommitGroups (which groups by agent and preserves per-agent order),
 * this FLATTENS every agent's commits into one stream and sorts the whole by
 * committer `epoch` desc, so the newest commit anywhere in the fleet is on top
 * regardless of which agent shipped it.
 *
 * ↑unpushed join (ported from buildFleetCommitGroups, WARDEN-723): each ok outcome
 * now carries its outgoing (@{u}..HEAD) hash set as well as its recent commits, and
 * each row is marked `unpushed: outgoingHashes.has(c.hash)` — the exact per-hash join
 * buildFleetCommitGroups does at its line 1039, preferred over a coarse aheadCount>0
 * signal because it works for agents whose git status isn't cached (every agent in
 * the fleet, not just open panes). The feed is still NO-QUERY (decision #2's
 * "unfiltered recent view" half is intact — no grep=/pickaxe=), but it now pays the
 * 2N the query-driven search pays (recent + outgoing per agent); decision #1 still
 * bounds that cost — fetch-on-mount + manual ↻ only, never an auto-poll cadence. A
 * failed outgoing fetch yields an EMPTY outgoingHashes (graceful degradation — a
 * commit is never WRONGLY marked unpushed by a missing outgoing set).
 *
 * `epoch == null` (a degraded GIT_LOG_PRETTY line — see parseGitLogLine's null
 * path, src/server.js:2294) is placed LAST, stably: two null-epoch rows keep their
 * input order, and any null-epoch row sorts after every epoch-bearing row. That
 * keeps a malformed/old line from leap-frogging real commits to the top of the feed.
 *
 * Outcomes are flattened in caller (chats) order BEFORE the sort, so equal-epoch
 * ties break by input order (agent A's commit before agent B's when both shipped at
 * the same epoch) — deterministic, so tests assert deep equality, the convention
 * the rest of this module follows. Array.prototype.sort is stable on Node ≥12 / V8,
 * so that pre-sort input order is preserved through the equal-epoch ties.
 */
export function mergeFleetCommitsByEpoch(outcomes: FleetRecentOutcome[]): FleetRecentCommitsResult {
  const rows: FleetRecentCommitRow[] = [];
  let errorCount = 0;
  for (const o of outcomes) {
    if (!o.ok) {
      errorCount += 1;
      continue;
    }
    for (const c of o.commits) rows.push({ key: o.key, project: o.project, commit: c, unpushed: o.outgoingHashes.has(c.hash) });
  }
  // Stable sort (Array.prototype.sort is stable on Node ≥12 / V8): epoch desc, with
  // null-epoch rows placed last and preserving input order among themselves. The
  // rows array was built in chats order, so equal/null-epoch ties keep that order.
  rows.sort((a, b) => {
    const ae = a.commit.epoch;
    const be = b.commit.epoch;
    if (ae == null && be == null) return 0;  // both degraded → keep input order
    if (ae == null) return 1;                 // degraded sorts after every real epoch
    if (be == null) return -1;
    return be - ae;                           // newest epoch first
  });
  return { rows, errorCount };
}

/**
 * Build the per-agent fetch URL for the fleet recent-commits feed (WARDEN-597):
 * `/api/git-log?id=<key>&limit=<limit>` — the NO-QUERY recent view. This is the
 * recent-commits analog of buildFleetSearchBaseUrl, but WITHOUT a grep= / pickaxe=
 * query param (those two always splice a query; the recent view shows the newest
 * commits unfiltered). The `limit` reaches /api/git-log, which clamps it to [1,50]
 * (src/server.js:2398); the component passes a bounded constant (top 20–30 across
 * the fleet) so the merged feed stays a glance, not a firehose.
 *
 * Pure (no fetch) so it is unit-testable without a React runner, mirroring
 * buildFleetSearchBaseUrl — the URL is the only mode-dependent line in the recent
 * view's fan-out.
 */
export function buildFleetRecentCommitsUrl(key: string, limit: number): string {
  return `/api/git-log?id=${encodeURIComponent(key)}&limit=${limit}`;
}

// Re-bind the parent's open-file callback for ONE fleet row (WARDEN-757). The feed
// is multi-agent, so HealthDashboard hands a SINGLE onOpenFile(chatId, path) for the
// whole list; each CommitFile must call it with ITS OWN agent key (the row's key —
// c.key || c.id, the same identifier /api/git-show / /api/read-file already resolve
// these rows against) so opening a file reads from the CORRECT agent's repo, not the
// focused pane. This is the fleet-level analog of ChatSidebar binding c.key per
// ChatRow closure, lifted one level because the .map lives in FleetRecentCommits.
//
// Returns UNDEFINED when the parent supplied no onOpenFile — load-bearing: CommitFile
// renders its 📄 OpenFileAffordance only when onOpenFile is truthy, so returning
// undefined here means the affordance does NOT render in contexts that didn't opt in
// (preserving today's inline-diff-only fleet behavior). Always wrapping —
// `(path) => onOpenFile(chatId, path)` with no guard — would BOTH render the
// affordance where it shouldn't AND throw on click (calling undefined(...)). The guard
// is the contract.
//
// Extracted PURE (no React) so the binding is unit-testable without a front-end test
// runner (see fleetRecentCommits.test.mjs) — the React layer calls this verbatim at the
// CommitFile binding site, so the test exercises the real write path, not a parallel one.
export function bindFleetRowOpenFile(
  onOpenFile: ((chatId: string, path: string) => void) | undefined,
  chatId: string,
): ((path: string) => void) | undefined {
  return onOpenFile ? (path: string) => onOpenFile(chatId, path) : undefined;
}

// ---- Fleet-wide git-STATUS fan-out aggregation (WARDEN-766) -------------------
//
// The cross-fleet WORKING-TREE-STATE layer — the missing repository-state axis in
// Fleet Health (HealthDashboard.tsx). Where FleetRecentCommits (WARDEN-597) fans
// /api/git-log across the fleet for the COMMIT-HISTORY axis and
// The removed sidebar summarizer (WARDEN-975) rolled the per-pane CACHED status for the sidebar's
// project chips, this fans /api/git-status across every active project agent so Fleet
// Health can surface — per agent — whether it has uncommitted WIP and its magnitude
// (±N), plus a fleet-wide "N dirty" count in the summary bar. A coordinator scanning
// the fleet no longer has to leave Fleet Health for the sidebar to see which agents
// hold the uncommitted work most at risk if an agent crashes or the coordinator
// interrupts it.
//
// The closest sibling is FleetRecentCommits: this is the STATUS analog of that
// commit-history fan. WARDEN-766's directive is to mirror FleetRecentCommits'
// fetch discipline VERBATIM (eligible gate, eligibleKey membership signature,
// Promise.allSettled, the WARDEN-89 false-empty guard, fetch-on-mount + manual ↻,
// no auto-poll) — the only divergence is the route (/api/git-status, a single-shot
// per-chat probe, vs /api/git-log) and that the result is a per-agent MAP + a count
// rather than a merged list. Mirroring applies to the React hook (useFleetGitStatus);
// this pure layer mirrors buildFleetRecentCommitsUrl (URL builder) +
// mergeFleetCommitsByEpoch (aggregation).
//
// Pure (no React import, no fetch) so it is unit-testable directly via node,
// mirroring mergeFleetCommitsByEpoch / buildFleetRecentCommitsUrl. The population
// gate is REUSED (fleetCommitSearchEligible — active + project, keyed by key || id,
// deduped, the same population the sibling fleet fans use); the actual fetches + the
// WARDEN-89 false-empty guard live in the useFleetGitStatus React hook. Outcomes are
// processed in caller (chats) iteration order so the statusByKey map + the counts
// are deterministic and tests assert deep equality — the convention the rest of this
// module follows.

// The minimal /api/git-status slice the Fleet Health UI reads: `clean` (the dirty
// signal; clean === false ⇒ uncommitted WIP) + `diffstat` (the ±N magnitude) +
// `behind` (the ↓N staleness magnitude, WARDEN-815). All three are top-level fields
// /api/git-status ALREADY serves (clean parsed from `git status --porcelain` at
// gitRoutes.js; diffstat parsed from `git diff HEAD --shortstat`; behind parsed from
// `git rev-list --left-right --count @{u}...HEAD` by parseAheadBehind, returned at
// gitRoutes.js:646 as `behind: branch ? behind : null`), so this is a pure
// pass-through — no new fetch, no backend change. clean is null for a non-git /
// no-branch cwd (the server gates `clean: branch ? clean : null`); diffstat is null
// there too AND for a clean tree / an all-untracked WIP; behind is null there too AND
// for a no-upstream cwd (parseAheadBehind returns `{ behind: null }`). Defined INLINE
// (the SAME shape /api/git-status serves) — deliberately NOT imported from the
// React-layer status type — so this pure module stays decoupled and is
// unit-testable with plain objects, the same decoupling every other helper here
// / FleetSearchChat rely on. (conflictCount below is the lone DERIVED field — counted
// at the fetch seam from the porcelain `files[]`, not a direct pass-through.)
export interface FleetGitStatusSlice {
  clean: boolean | null;
  diffstat: { files: number; insertions: number; deletions: number } | null;
  // # of unpushed commits for THIS agent (WARDEN-822) — the per-row ahead axis the
  // dirty signal is structurally blind to: an agent that committed N times and never
  // pushed has clean === true AND dirtyCount === 0, so it reads identically to an
  // agent fully in sync with upstream — its FINISHED work is stranded locally and
  // invisible to every other agent pulling from shared upstream. /api/git-status
  // ALREADY serves `ahead` top-level (gitRoutes.js serializes `ahead: branch ? ahead :
  // null`, parsed from one `git rev-list --left-right --count @{u}...HEAD` via
  // parseAheadBehind in gitStatus.js — RIGHT count = HEAD has, upstream doesn't =
  // unpushed), so this is a pure pass-through of one field — no new fetch, no backend
  // change. null for a non-git / detached / no-upstream cwd (the server gates on
  // `branch` → the SAME null-is-quiet discipline clean follows) and 0 for an in-sync
  // branch. NOTE this is a PER-AGENT commit count, NOT the fleet-wide count of
  // unpushed AGENTS (that is FleetGitStatusResult.aheadCount below — the mirror of
  // dirtyCount / conflictCount).
  ahead: number | null;
  // # of unmerged PATHS for THIS agent (WARDEN-796) — the per-row conflict axis
  // the dirty signal cannot speak to: an agent BLOCKED mid-merge/rebase/cherry-pick
  // (porcelain unmerged DD/AU/UD/UA/DU/AA/UU). /api/git-status ALREADY serves the
  // porcelain `files[]` with each row tagged `conflict: boolean` (gitStatus.js's
  // parseGitStatusPorcelain → `conflict: isConflictStatus(statusCode)`); this is the
  // count of those rows, derived at the fetch seam (useFleetGitStatus) — no new fetch,
  // no backend change. 0 for a clean / non-git / no-conflict cwd (the server serves
  // files:null there → the Array.isArray guard at the seam keeps it 0). NOTE this is a
  // PER-AGENT PATH count, NOT the fleet-wide count of conflict-blocked AGENTS (that is
  // FleetGitStatusResult.conflictCount below — the mirror of dirtyCount).
  conflictCount: number;
  // # of commits THIS agent is behind its upstream (WARDEN-815) — the per-row
  // staleness axis the dirty/conflict axes cannot speak to: an agent whose HEAD is
  // OUT-OF-DATE relative to its upstream (a sibling pushed and this agent hasn't
  // pulled). /api/git-status ALREADY serves `behind` (parseAheadBehind at
  // gitStatus.js:403, shipped WARDEN-153, returned at gitRoutes.js:646 as
  // `behind: branch ? behind : null`); this is the pure pass-through of that field —
  // no new fetch, no backend change. null for a non-git / no-branch / no-upstream cwd
  // (the server gates `behind: branch ? behind : null`, and parseAheadBehind returns
  // `{ behind: null }` for no-upstream / malformed) — the SAME null-is-quiet discipline
  // `clean` follows. NOTE this is the PER-AGENT behind count (drives the per-row ↓'s
  // "N" magnitude); the fleet-wide count of stale-blocked AGENTS is
  // FleetGitStatusResult.behindCount below (the mirror of dirtyCount/conflictCount).
  behind: number | null;
  // The strict ISO-8601 last-commit time for THIS agent (WARDEN-847) — the raw
  // pass-through of /api/git-status's top-level `headDate` (parsed from git `%cI` at
  // gitStatus.js:200, served at gitRoutes.js:664 as `headDate: branch ? headDate :
  // null`), the sole RECENCY axis. dirty/conflict/behind/ahead are all STATE axes
  // ("what IS the repo"); headDate answers "when did this agent last commit?" — the
  // signal for a silently stalled / abandoned / rotting agent (clean tree, in sync,
  // all pushed, but HEAD >7d old). null for a non-git / no-branch cwd (the server
  // gates on `branch`, the SAME null-is-quiet discipline `clean` follows) and for a
  // repo with no commits. This is the RAW input field — clock-dependent derivation
  // (headAgeMs + stalled below) happens in buildFleetGitStatus(now), the verbatim
  // mirror of the removed sidebar summarizer (WARDEN-975), so the pure module owns the clock and
  // tests pass a fixed `now`; the hook seam sets this from `j.headDate` and sets
  // headAgeMs/stalled to provisional null/false (enriched before the chip reads them).
  headDate: string | null;
  // headAgeMs is THIS agent's HEAD-commit AGE in ms (WARDEN-847) — `now - headMs`
  // where headMs = Date.parse(headDate). Derived in buildFleetGitStatus against the
  // threaded `now` (NOT Date.now()) so the module stays pure/deterministic — the
  // verbatim mirror of the removed sidebar summarizer's headAgeMs (WARDEN-975). null when headDate
  // is missing/invalid/empty (a repo with no commits / non-git cwd — Date.parse → NaN),
  // the same null-is-quiet discipline `clean` follows: a null-age agent is NOT stalled.
  // Provisional null at the fetch-seam literal; buildFleetGitStatus(now) enriches it
  // before the slice reaches statusByKey. NOTE this is the per-agent age (a future
  // 💤 popover could rank oldest-first off it, mirroring the sidebar's WARDEN-710); the
  // fleet-wide count of stalled AGENTS is FleetGitStatusResult.stalledCount below.
  headAgeMs: number | null;
  // stalled is THIS agent's "HEAD >7d old" boolean (WARDEN-847) — true iff headAgeMs is
  // a finite age older than STALE_HEAD_AGE_MS (7d, the shared constant at :257). Derived
  // in buildFleetGitStatus(now) — the verbatim mirror of the removed sidebar summarizer's
  // stalled test at :363 — so fleet/row agree on EXACTLY who is stalled (fleet/row
  // agreement rides on this shared 7d threshold, established WARDEN-682). The canonical
  // case: a clean, pushed, in-sync, routine-state, stash-free agent whose HEAD is >7d
  // old reads ZERO across every existing Fleet Health axis and was invisible; this 5th
  // per-row chip surfaces it. Provisional false at the fetch-seam literal;
  // buildFleetGitStatus(now) enriches it before the per-row 💤 chip reads it.
  stalled: boolean;
  // # of PARKED WIP stashes for THIS agent (WARDEN-871) — the per-row parked-WIP axis
  // every other axis is structurally blind to: an agent that ran `git stash` to shelve
  // uncommitted work off-tree reads clean === true AND dirtyCount === 0 (porcelain
  // status never surfaces stashes), so it looks identical to a fully-healthy agent —
  // yet it holds easily-forgotten, drift-prone shelved work. /api/git-status ALREADY
  // serves `stashCount` top-level (gitRoutes.js:654 — `stashCount: branch ? stashCount :
  // null`, parsed from `git stash list` line count via parseStashCount in gitStatus.js),
  // so this is a pure pass-through of one field — no new fetch, no backend change. null
  // for a non-git / no-branch cwd (the server gates on `branch` → the SAME null-is-quiet
  // discipline clean/ahead/behind follow) and 0 for a stash-free tree. NOTE this is the
  // PER-AGENT stash magnitude (drives the per-row 🗄N chip); the fleet-wide count of
  // stashed AGENTS is FleetGitStatusResult.stashedCount below (the mirror of
  // dirtyCount/aheadCount/stalledCount — agent tallies, never a sum of stashes).
  stashCount: number | null;
}

// One agent's fan-out outcome. `ok: false` = that agent's /api/git-status fetch
// failed (host unreachable / non-ok HTTP / network / an HTTP-200 `error` body the
// hook's WARDEN-89 guard maps to a failure) — counted as an error but never dropped
// silently, and never blanking the other agents' statuses (the Promise.allSettled
// fleet contract). `ok: true` carries that agent's { clean, diffstat } slice.
// Mirrors FleetRecentOutcome's ok/error discriminator (the recent-commits fan's
// per-agent outcome), including the WARDEN-89 contract that an error is COUNTED,
// never read as a false clean/empty status.
export type FleetGitStatusOutcome =
  | { ok: true; key: string; status: FleetGitStatusSlice }
  | { ok: false; key: string };

export interface FleetGitStatusResult {
  // Per-agent { clean, diffstat }, keyed by `key || id` (the same key the fan-out
  // fetches /api/git-status?id= with — fleetCommitSearchEligible's resolved key).
  // ONLY ok agents get an entry — an error / loading / not-yet-fetched agent is
  // absent, so statusByKey[id] being undefined is the graceful N/A (render nothing),
  // identical to HealthDashboard's ResourceChip / TokenChip. A clean ok agent DOES
  // get an entry (clean: true) so the React layer could one day distinguish "fetched
  // + clean" from "still loading"; today both render no per-row chip (the chip gates
  // on clean === false), so including clean agents is honest, not noise.
  statusByKey: Record<string, FleetGitStatusSlice>;
  // # of fanned agents with status.clean === false — the fleet-wide "N dirty" count
  // surfaced in the Fleet Health summary bar. An error / loading agent is NOT dirty
  // (it's counted in errorCount / simply absent from the map), so the count is honest
  // and never inflated by an unknown-state agent.
  dirtyCount: number;
  // # of fanned agents whose fetch failed — surfaced honestly as a "· N unreachable"
  // note (WARDEN-89 — never let a per-agent failure masquerade as a clean/empty
  // status). errorCount ≤ eligible.length always (one outcome per fanned agent).
  errorCount: number;
  // # of fanned agents with at least one unmerged path (status.conflictCount > 0) —
  // the fleet-wide "N conflict" count surfaced in the Fleet Health summary bar
  // (WARDEN-796). This counts conflict-blocked AGENTS, NOT total unmerged files — the
  // direct mirror of dirtyCount (which counts agents with clean === false, not total
  // dirty files). An error / loading agent is NOT a conflict (counted in errorCount /
  // absent), so a transiently-unreachable agent is never misread as blocked. The
  // PER-AGENT path count lives on FleetGitStatusSlice.conflictCount above (drives the
  // per-row ⚑'s "N unmerged" magnitude); this fleet count drives the summary tally.
  conflictCount: number;
  // # of fanned agents running on stale, behind-upstream code (status.behind > 0) —
  // the fleet-wide "N behind" count surfaced in the Fleet Health summary bar
  // (WARDEN-815). This counts stale AGENTS, NOT total behind-commits — the direct
  // mirror of dirtyCount (agents with clean === false) and conflictCount (agents with
  // conflictCount > 0): all four axes are agent-level tallies, never file/commit sums. An
  // error / loading agent is NOT behind (counted in errorCount / absent), and a null
  // behind (non-git / no-branch / no-upstream cwd) is neither, so a transiently-
  // unreachable or non-git agent is never misread as stale. The PER-AGENT behind count
  // lives on FleetGitStatusSlice.behind above (drives the per-row ↓'s "N" magnitude);
  // this fleet count drives the summary tally.
  behindCount: number;
  // # of fanned agents with unpushed commits (status.ahead > 0) — the fleet-wide "N
  // unpushed" count surfaced in the Fleet Health summary bar (WARDEN-822). This counts
  // stranded-work AGENTS, NOT total unpushed commits — the direct mirror of dirtyCount
  // (which counts agents with clean === false, not total dirty files) and conflictCount
  // (which counts blocked agents, not total unmerged paths). It surfaces the blind spot
  // clean cannot speak to: an agent that committed and never pushed has clean === true,
  // so WITHOUT this axis it is indistinguishable from an agent fully in sync — its
  // finished work is invisible to every other agent pulling from shared upstream. An
  // error / loading agent is NOT unpushed (counted in errorCount / absent), and an
  // ok agent with ahead: null (non-git / detached / no-upstream) or ahead: 0 (in-sync)
  // is NOT counted, so a transiently-unreachable or no-upstream agent is never misread
  // as stranded. The PER-AGENT commit count lives on FleetGitStatusSlice.ahead above
  // (drives the per-row ↑N magnitude); this fleet count drives the summary tally.
  aheadCount: number;
  // # of fanned agents whose HEAD commit is >7d old (status.stalled) — the fleet-wide
  // "N stalled" count surfaced in the Fleet Health summary bar (WARDEN-847). This is the
  // sole RECENCY axis: dirty/conflict/behind/ahead are all STATE axes ("what IS the
  // repo"), but stalled answers "when did this agent last commit?" — surfacing the
  // silently stalled / abandoned / rotting agent that reads ZERO across every existing
  // axis (clean tree, no conflict, in sync, all pushed, but HEAD >7d old). This counts
  // stalled AGENTS (the direct mirror of dirtyCount/conflictCount/behindCount/
  // aheadCount — agent tallies, never a sum) and reuses the SAME STALE_HEAD_AGE_MS (7d)
  // threshold the sidebar's git section uses, so Fleet Health and
  // the sidebar agree on EXACTLY who is stalled (fleet/row agreement, WARDEN-682). An
  // error / loading agent is NOT stalled (counted in errorCount / absent), and an ok
  // agent whose headDate is missing/invalid/empty (a repo with no commits / non-git cwd
  // — Date.parse → NaN → headAgeMs null) is NOT stalled — the same null-is-quiet
  // discipline `clean` follows. The PER-AGENT stalled boolean lives on
  // FleetGitStatusSlice.stalled above (drives the per-row 💤 chip); this fleet count
  // drives the summary tally.
  stalledCount: number;
  // # of fanned agents holding parked `git stash` WIP (status.stashCount > 0) — the
  // fleet-wide "N stashed" count surfaced in the Fleet Health summary bar (WARDEN-871).
  // This counts stashed AGENTS, NOT total stashes — the direct mirror of dirtyCount
  // (which counts agents with clean === false, not total dirty files) and aheadCount
  // (which counts stranded-work agents, not total unpushed commits): all six axes are
  // agent-level tallies, never file/commit/stash sums. It surfaces the blind spot clean
  // cannot speak to: an agent that shelved its work via `git stash` has clean === true,
  // so WITHOUT this axis it is indistinguishable from a healthy agent — its parked,
  // easily-forgotten, drift-prone WIP is invisible. An error / loading agent is NOT
  // stashed (counted in errorCount / absent), and an ok agent with stashCount: null
  // (non-git / no-branch cwd) or stashCount: 0 (stash-free) is NOT counted, so a
  // transiently-unreachable or stash-free agent is never misread as parked. The
  // PER-AGENT stash magnitude lives on FleetGitStatusSlice.stashCount above (drives the
  // per-row 🗄N chip's "N" magnitude); this fleet count drives the summary tally.
  stashedCount: number;
}

/**
 * Turn N per-agent /api/git-status outcomes into the Fleet Health view: a per-agent
 * { clean, diffstat, conflictCount, behind, ahead, headDate, headAgeMs, stalled,
 * stashCount } map + a fleet-wide dirty count + a fleet-wide conflict count + a
 * fleet-wide behind count + a fleet-wide unpushed count + a fleet-wide stalled count +
 * a fleet-wide stashed count + an honest error count.
 * Every ok agent gets a map entry (clean OR dirty — the React layer gates the per-row
 * chip on clean === false, so a clean entry is harmless + keeps the "fetched vs loading"
 * distinction available); ok:false agents are counted into errorCount WITHOUT blanking
 * the ok agents' entries (the Promise.allSettled fleet contract). dirtyCount counts ONLY
 * ok agents whose clean === false; conflictCount counts ONLY ok agents with conflictCount
 * > 0 (the agent-level mirror of dirtyCount — blocked AGENTS, not unmerged files);
 * behindCount counts ONLY ok agents with behind > 0 (the agent-level mirror of dirtyCount
 * — stale AGENTS, not total behind-commits); aheadCount counts ONLY ok agents with ahead
 * > 0 (the agent-level mirror of dirtyCount — stranded-work AGENTS, not total unpushed
 * commits); stalledCount counts ONLY ok agents whose HEAD is >7d old (the agent-level
 * mirror of dirtyCount — stalled AGENTS, the sole recency axis); stashedCount counts ONLY
 * ok agents with stashCount > 0 (the agent-level mirror of dirtyCount — parked-WIP
 * AGENTS, not a sum of stashes). The counts are
 * ORTHOGONAL: an unpushed-and-dirty agent increments BOTH dirtyCount and aheadCount (a
 * clean === false tree says nothing about whether the committed work is pushed), a behind
 * agent is often clean too (clean upstream-synced work is still stale), a mid-merge repo
 * is dirty by definition so it increments dirtyCount and conflictCount, and a stalled
 * agent is VERY often otherwise clean (the canonical case this axis exists for: clean
 * tree, in sync, all pushed, but HEAD >7d old) so stalledCount fires where every other
 * axis reads zero, and a stashed agent is independent of EVERY other axis by construction
 * (a `git stash` can sit alongside a dirty tree, a conflict, divergence, unpushed commits,
 * or a stalled HEAD) so stashedCount fires wherever parked WIP lives. An error agent is
 * never dirty, never a conflict, never behind, never unpushed, never stalled, AND never
 * stashed.
 *
 * `now` (defaulting to `Date.now()`) is the staleness reference: an ok agent is `stalled`
 * when its `headDate` parses to a finite ms older than `now - STALE_HEAD_AGE_MS`, derived
 * HERE (the verbatim mirror of the removed sidebar summarizer (WARDEN-975)) so the pure module owns
 * the clock and tests pass a fixed `now`. The hook seam passes `Date.now()` at fan-out
 * time; the slice it builds carries the raw `headDate` + provisional headAgeMs/stalled,
 * which THIS fn enriches before storing into statusByKey (so the per-row chip always
 * reads the real derived values, never the seam's provisional placeholders).
 *
 * Outcomes are processed in caller (chats) order, so the map + counts are
 * deterministic and tests assert deep equality — the convention the rest of this
 * module follows. Pure + dependency-free (FleetGitStatusSlice / FleetGitStatusOutcome
 * are defined in this same file, so there is not even an `import type`), so
 * fleetGitStatus.test.mjs exercises it standalone alongside the URL builder.
 */
export function buildFleetGitStatus(outcomes: FleetGitStatusOutcome[], now: number = Date.now()): FleetGitStatusResult {
  const statusByKey: Record<string, FleetGitStatusSlice> = {};
  let dirtyCount = 0;
  let errorCount = 0;
  let conflictCount = 0;
  let behindCount = 0;
  let aheadCount = 0;
  let stalledCount = 0;
  let stashedCount = 0;
  for (const o of outcomes) {
    if (!o.ok) {
      errorCount += 1;
      continue;
    }
    // WARDEN-847: derive THIS agent's HEAD-commit age + stalled flag against the threaded
    // `now` — the verbatim mirror of the removed sidebar summarizer (WARDEN-975) (Date.parse(headDate)
    // → now - headMs; stalled ⇔ headAgeMs > STALE_HEAD_AGE_MS). Done HERE (not at the fetch
    // seam) so the pure module owns the clock: the hook seam passes the raw headDate +
    // provisional headAgeMs/stalled, and THIS fn enriches the slice before storing it, so
    // the per-row chip always reads the real derived values. Date.parse → NaN for a
    // missing/invalid/empty headDate (a repo with no commits / non-git cwd — the server
    // serves headDate:null there) ⇒ headAgeMs null ⇒ NOT stalled, the same null-is-quiet
    // discipline `clean` follows. STALE_HEAD_AGE_MS (7d, :257) is the SAME threshold the
    // sidebar's git section uses, so Fleet Health and the sidebar agree on
    // EXACTLY who is stalled (fleet/row agreement, WARDEN-682).
    const headMs = typeof o.status.headDate === 'string' && o.status.headDate ? Date.parse(o.status.headDate) : NaN;
    const headAgeMs = Number.isFinite(headMs) ? now - headMs : null;
    const stalled = headAgeMs != null && headAgeMs > STALE_HEAD_AGE_MS;
    const status: FleetGitStatusSlice = { ...o.status, headAgeMs, stalled };
    statusByKey[o.key] = status;
    if (o.status.clean === false) dirtyCount += 1;
    // Mirror the dirtyCount line: count conflict-blocked AGENTS (those with at least
    // one unmerged path), NOT total unmerged files — the agent-level fleet tally the
    // summary bar renders as "N conflict". An agent both dirty AND conflict-blocked
    // increments BOTH (a mid-merge repo is dirty by definition); the two axes are
    // orthogonal counts over the same ok fleet.
    if (o.status.conflictCount > 0) conflictCount += 1;
    // Mirror the conflictCount line: count stale AGENTS (those behind upstream), NOT
    // total behind-commits — the agent-level fleet tally the summary bar renders as
    // "N behind". `o.status.behind` is null for a non-git / no-branch / no-upstream
    // cwd (the same null-is-quiet discipline `clean` follows), and the truthy guard
    // keeps null/0 out so a fresh or non-git agent is never misread as stale. An agent
    // both stale AND dirty/conflict increments ALL applicable axes (a behind agent is
    // often clean too — clean upstream-synced work is still stale); the axes are
    // orthogonal counts over the same ok fleet.
    if (o.status.behind && o.status.behind > 0) behindCount += 1;
    // Mirror the dirtyCount/conflictCount/behindCount lines: count stranded-work AGENTS
    // (those with ahead > 0 — committed-but-unpushed work), NOT total unpushed commits —
    // the agent-level fleet tally the summary bar renders as "N unpushed". `ahead &&`
    // guards null (non-git / detached / no-upstream cwd — the server serves ahead:null
    // there, mirroring the null-is-quiet discipline clean follows) the SAME way the
    // conflictCount line's `> 0` guards 0. An agent both dirty AND unpushed increments
    // BOTH dirtyCount and aheadCount (a clean === false tree says nothing about whether
    // the committed work is pushed — the four axes dirty/conflict/behind/ahead are
    // orthogonal counts over the same ok fleet).
    if (o.status.ahead && o.status.ahead > 0) aheadCount += 1;
    // Mirror the dirtyCount/conflictCount/behindCount/aheadCount lines: count stalled
    // AGENTS (those whose HEAD is >7d old — `stalled`, derived above), NOT a sum — the
    // agent-level fleet tally the summary bar renders as "N stalled" (WARDEN-847). The
    // canonical case: a clean, pushed, in-sync, routine-state, stash-free agent whose
    // HEAD is >7d old reads ZERO across every existing axis, so WITHOUT this line it is
    // invisible at the fleet level — stalledCount is the sole axis that surfaces it. An
    // agent stalled AND dirty/conflict/behind/unpushed increments ALL applicable axes
    // (the five axes are orthogonal counts over the same ok fleet), but a stalled agent
    // is VERY often otherwise clean, so `stalled` fires alone where every other axis is 0.
    if (stalled) stalledCount += 1;
    // Mirror the ahead line (WARDEN-871): count parked-WIP AGENTS (those with
    // stashCount > 0 — `git stash`-shelved work porcelain status is blind to), NOT a sum
    // of stashes — the agent-level fleet tally the summary bar renders as "N stashed".
    // `o.status.stashCount &&` guards null (non-git / no-branch cwd — the server gates
    // `stashCount: branch ? stashCount : null`, mirroring the null-is-quiet discipline
    // clean/ahead/behind follow) the SAME way the ahead line's `ahead &&` guards null,
    // and `> 0` guards a stash-free tree the SAME way the conflictCount line guards 0.
    // The canonical case this axis exists for: a clean, conflict-free, in-sync, pushed,
    // fresh-HEAD agent that stashed its WIP reads ZERO across every other axis, so
    // WITHOUT this line it is invisible — stashedCount surfaces parked work nothing else
    // can see. stash is INDEPENDENT of every other axis by construction (a stash can sit
    // alongside a dirty tree, a conflict, a behind/upstream divergence, unpushed commits,
    // or a stalled HEAD), so an agent both stashed AND dirty increments BOTH stashedCount
    // and dirtyCount — the six axes are orthogonal counts over the same ok fleet.
    if (o.status.stashCount && o.status.stashCount > 0) stashedCount += 1;
  }
  return { statusByKey, dirtyCount, errorCount, conflictCount, behindCount, aheadCount, stalledCount, stashedCount };
}

/**
 * Build the per-agent fetch URL for the Fleet Health git-status fan (WARDEN-766):
 * `/api/git-status?id=<key>`. The status analog of buildFleetRecentCommitsUrl, but
 * for /api/git-status (the working-tree-state route) instead of /api/git-log. No
 * query, no limit — /api/git-status is a single-shot per-chat probe. Pure (no fetch)
 * so it is unit-testable without a React runner, mirroring buildFleetRecentCommitsUrl
 * — the URL is the only route-dependent line in the fan-out, and isolating it lets
 * the WARDEN-122 key-encoding discipline be asserted (a container/host key reaches
 * git as ONE argument, never split across params).
 */
export function buildFleetGitStatusUrl(key: string): string {
  return `/api/git-status?id=${encodeURIComponent(key)}`;
}

// ---- Fleet-wide working-tree CODE search aggregation (WARDEN-589) ------------
//
// The cross-agent WORKING-TREE layer — the fleet-wide counterpart to the per-agent
// workspace grep shipped in WARDEN-145 (POST /api/search-files, read-only `git grep`
// over tracked files). Where the commit search above (WARDEN-534 message / WARDEN-559
// content) finds WHERE a change LANDED in HISTORY, this finds WHERE a string lives
// RIGHT NOW across the fleet's CURRENT tracked code — answering "which agent is
// editing auth.js?", "who already has a cancelToken helper?", "which repos still
// reference the old API name?". One query greps every active project agent's working
// tree, grouped by agent (file:line:text snippets, not commits).
//
// Three load-bearing divergences from the commit axes (message/content), each called
// out in WARDEN-589, which is why this gets its OWN grouping fn + types rather than a
// third branch on buildFleetCommitGroups:
//
//  1. RESULT SHAPE is fundamentally different — file:line:text hits, NOT commits.
//     /api/search-files → { results: [{ file, line, text }] }, grouped as
//     FleetCodeGroup { hits: FleetCodeHit[] } and rendered as file:line:text rows
//     (mirroring WorkspaceSearchDialog's SearchResultRow), NOT commit rows.
//
//  2. ONE FETCH PER AGENT (N, not 2N) — a working-tree grep match has no hash and no
//     concept of "unpushed"; there is no outgoing join. The group header shows only
//     the match count (no · ↑N).
//
//  3. HTTP-200 ERRORS — /api/search-files returns transport/runtime failures
//     ('search failed', 'no cwd') at HTTP 200 with an `error` field (mirroring
//     /api/git-status), so the fan-out must check `data.error` (NOT just r.ok) and
//     treat an error response as that agent's FAILURE outcome (counted into
//     errorCount), NEVER as a false-empty match list — the WARDEN-89 false-empty
//     contract the rest of this codebase fights. That gate lives in the component
//     (the fetch); this pure layer just counts whatever the component hands it.
//
// Pure (no React import, no fetch) so it is unit-testable directly via node, mirroring
// the commit-search seam. The population gate is REUSED (fleetCommitSearchEligible —
// mode-agnostic: active + project, keyed, deduped); this layer then groups + counts
// the per-agent outcomes in chats iteration order (deterministic, so tests assert
// deep equality).

// One matched working-tree line, exactly as /api/search-files returns it: file path,
// line number, and the matched text. Deliberately carries NO `unpushed` field — a
// working-tree grep match has no hash and no concept of "unpushed" (the commit axes'
// ↑unpushed join does not apply here). buildFleetCodeGroups emits EXACTLY these three
// fields; asserting `unpushed`'s absence in tests catches an accidental copy-paste
// from the commit path.
export interface FleetCodeHit {
  file: string;
  line: number;
  text: string;
}

// One agent's fan-out outcome for the code axis. `ok: false` = that agent's
// /api/search-files fetch failed OR returned an HTTP-200 `error` body (the component
// maps both to this before calling buildFleetCodeGroups) — counted as an error but
// never dropped silently, and never blanking the other agents' results (the
// Promise.allSettled contract). `ok: true` carries the agent's grep hits
// (file:line:text), in git-grep order.
export type FleetCodeOutcome =
  | { ok: true; key: string; project: string; hits: FleetCodeHit[] }
  | { ok: false; key: string; project: string };

// One agent's matched working-tree lines (the rows under its group header). key +
// project ride along so the React layer can join key → displayName / project without
// a second lookup, mirroring FleetCommitGroup.
export interface FleetCodeGroup {
  key: string;
  project: string;
  hits: FleetCodeHit[];
}

export interface FleetCodeSearchResult {
  // Matched agents in chats iteration order (empties dropped). Each group's hits stay
  // in the order /api/search-files returned them (git grep order).
  groups: FleetCodeGroup[];
  // # of agents whose fetch failed (transport error, non-ok HTTP, OR an HTTP-200
  // `error` body) — surfaced as a "(N unreachable)" note so a partial failure is
  // honest, never a silent false-empty (WARDEN-89).
  errorCount: number;
}

/**
 * Turn N per-agent working-tree grep outcomes into the grouped-by-agent fleet view
 * for the Code axis. Drops `ok` agents with no hits (no group for a clean repo);
 * counts `ok: false` agents into `errorCount` without dropping the successful groups;
 * and emits each hit as EXACTLY { file, line, text } — stripping any stray fields so
 * a working-tree match never carries the commit axes' `unpushed` marker (the Code
 * axis has no such concept). No outgoing join, no ↑unpushed.
 *
 * Outcomes are processed in caller (chats) order, so the returned groups are
 * deterministic and tests assert deep equality — the convention the rest of this
 * module follows.
 */
export function buildFleetCodeGroups(outcomes: FleetCodeOutcome[]): FleetCodeSearchResult {
  const groups: FleetCodeGroup[] = [];
  let errorCount = 0;
  for (const o of outcomes) {
    if (!o.ok) {
      errorCount += 1;
      continue;
    }
    if (o.hits.length === 0) continue;  // drop empties — no group for a clean repo
    groups.push({
      key: o.key,
      project: o.project,
      // Emit EXACTLY { file, line, text } so the Code axis never inherits the commit
      // path's `unpushed` field (and any stray field the raw API row carried is
      // dropped). The contract tests assert this exact shape.
      hits: o.hits.map((h) => ({ file: h.file, line: h.line, text: h.text })),
    });
  }
  return { groups, errorCount };
}

/**
 * Build the per-agent POST request for the fleet Code search (WARDEN-589).
 * /api/search-files is a POST with a JSON body `{ id, query }` — UNLIKE the commit
 * axes' GET + URL params — so it gets its OWN seam rather than overloading
 * buildFleetSearchBaseUrl (whose GET URL-string contract is exhaustively tested).
 * The query rides in a JSON body, so special chars are safe WITHOUT the URL-encoding
 * the GET commit path needs: `id`/`query` are passed through verbatim via
 * JSON.stringify. Returns the fetch() args (`url` + `init`) so the component's Code
 * fan-out stays a thin Promise.allSettled over ONE fetch per agent (N, not the 2N
 * the commit axes pay for the ↑unpushed join).
 */
export function fleetCodeFetchRequest(key: string, query: string): { url: string; init: RequestInit } {
  return {
    url: '/api/search-files',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: key, query }),
    },
  };
}
