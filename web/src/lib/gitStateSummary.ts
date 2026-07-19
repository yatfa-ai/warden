// Aggregate per-chat git status into per-project + global WIP counts, for the
// project filter chips in ChatSidebar (WARDEN-201). A glance at the chips then
// surfaces — per project and globally — how many open agents have uncommitted,
// unpushed, or behind-upstream work, without opening each chat to read its branch
// badge.
//
// This reuses the cached `gitStatus` map (populated per open tab by fetchGitStatus
// on mount) — no new fetch, no backend change. A chat absent from the map counts
// as neither (status unknown / still loading), so loading or non-git chats never
// add noise. The vocabulary mirrors the per-row GitBranchBadge: dirty ⇒ yellow
// `±` (clean === false), unpushed ⇒ amber `↑N` (ahead > 0), behind ⇒ blue `↓N`
// (behind > 0). `↓N` is the symmetric counterpart to `↑N`: hasn't pushed vs.
// hasn't pulled (WARDEN-297). A 4th axis, at-risk ⇒ rose `⚑N` (WARDEN-635), folds
// the three non-routine repo states the per-row badge renders individually but the
// fleet rollup previously dropped: detached HEAD, no-upstream (local-only work),
// and a mid merge/rebase/cherry-pick/revert/bisect op. A 5th axis, stashed ⇒
// fuchsia `🗄N` (WARDEN-667), carries the parked-WIP count `stashCount` the backend
// already ships and the per-row badge already renders — the lone current-state
// git signal that had no fleet rollup chip. A 6th axis, stalled ⇒ sky `💤N`
// (WARDEN-682), carries the last-commit freshness signal `headDate` (shipped by
// WARDEN-545) the per-row badge already renders as `· Nd` — a clean, pushed,
// up-to-date, routine-state, stash-free agent whose HEAD is >7d old reads ZERO on
// every other axis and was previously invisible at the fleet level; this surfaces it.
//
// Pure (no React import) so it is unit-testable directly via node, mirroring
// diff.ts (extracted in WARDEN-151 "so it's testable without a React runner").

// Minimal slice of Chat this aggregator reads. Defined locally rather than
// imported from the React-layer types so the helper stays decoupled and is
// testable with plain objects — the same decoupling classifyDiffLine relies on.
export interface GitStateChat {
  id: string;
  key?: string;       // looked up first: gitStatus[c.key || c.id] (matches the per-row key)
  project?: string;
  active?: boolean | null;  // null = undiscovered; only active chats have live status
}

// Minimal slice of a per-chat git status (matches the value shape ChatSidebar's
// useState<Record<string, …>> map stores via fetchGitStatus). clean === false ⇒
// uncommitted changes; ahead (a number > 0) ⇒ unpushed commits; behind (a number
// > 0) ⇒ commits on upstream not yet pulled. files is the changed-file list
// /api/git-status already returns per chat (parsed from `git status --porcelain`)
// — the join key detectProjectFileCollisions compares across agents. null for a
// detached/no-branch chat (contributes nothing).
//
// outgoingFiles (WARDEN-601) is the UNPUSHED-COMMIT changed-file list (parsed from
// `git diff --name-only @{u}..HEAD`) — the join key for the IMPENDING cross-agent
// collision detector. Where `files` is the working-tree WIP set, this is the
// committed-but-not-pushed set: agent A can have F here with a CLEAN tree (F ∉
// files), which is exactly the case the working-tree×working-tree detector is blind
// to (A contributes nothing to the `files` join) yet B's next pull collides on F.
// null for a detached/no-branch/in-sync (ahead 0) chat. A bare `string[]` (no status
// codes — `--name-only` carries none), unlike `files`' porcelain objects.
export interface GitStateStatus {
  clean?: boolean | null;
  ahead?: number | null;
  behind?: number | null;
  // The changed-file list /api/git-status already returns per chat (parsed from
  // `git status --porcelain`) — the join key detectProjectFileCollisions compares
  // across agents, AND (WARDEN-701) each file object carries the porcelain `conflict`
  // flag (parsed in src/gitStatus.js via isConflictStatus for the unmerged status codes
  // DD/AU/UD/UA/DU/AA/UU) so summarizeProjectGitState can count unmerged paths and
  // surface a blocked merge distinctly under ⚑. null for a detached/no-branch chat.
  files?: { path: string; conflict?: boolean }[] | null;
  outgoingFiles?: string[] | null;
  // WARDEN-635: the at-risk repo-state signals `/api/git-status` already returns
  // top-level — `detached` (WARDEN-239), `upstream` (WARDEN-243, null when none),
  // `inProgress: { operation, detail }` (WARDEN-511, merge/rebase/cherry-pick/revert/
  // bisect) — PLUS `branch`, the field that disambiguates no-upstream from detached /
  // non-git. All four already live in the cached gitStatus map ChatSidebar's useState
  // holds, so extending this slice is structurally compatible — no fetch, no backend
  // change. null/absent ⇒ that signal is unknown (treated as not-at-risk, never noise).
  branch?: string | null;
  detached?: boolean | null;
  upstream?: string | null;
  inProgress?: { operation: string | null; detail?: string | null } | null;
  // WARDEN-667: the parked-WIP count `/api/git-status` already returns top-level
  // — `stashCount` (shipped by WARDEN-211, parsed from `git stash list`) — which the
  // per-row GitBranchBadge already renders as 🗄N but the fleet rollup previously
  // dropped. Already lives in the cached gitStatus map ChatSidebar's useState holds,
  // so extending this slice is structurally compatible — no fetch, no backend change.
  // A number > 0 ⇒ stashed WIP; null/absent ⇒ unknown (treated as not-stashed, never
  // noise), the same null-is-quiet discipline ahead/behind follow.
  stashCount?: number | null;
  // WARDEN-669 + WARDEN-682: the strict ISO-8601 committer date of HEAD
  // (`git log -1 --format=%cI HEAD`, normalized by normalizeHeadDate in
  // src/gitStatus.js). It ALREADY ships on /api/git-status (WARDEN-545) and is
  // cached in the fleet gitStatus map ChatSidebar holds (ChatSidebar.tsx stores
  // `headDate: j.headDate`), but this GitStateStatus slice previously dropped it —
  // so the fleet summarizer had no temporal signal. Carried here as a STRING (not
  // pre-parsed to epoch) to mirror normalizeHeadDate's strict ISO-8601 contract and
  // avoid the epoch `*1000` footgun src/gitStatus.js documents — exactly as the
  // cached map stores it, so extending this slice is structurally compatible (no
  // fetch, no backend change). TWO fleet rollups read off it, derived as ONE
  // `headAgeMs` field on ProjectGitAgent (below): the ↑N unpushed-popover oldest-
  // first rank (WARDEN-669), and the 6th 💤N stalled axis — a HEAD older than
  // STALE_HEAD_AGE_MS (7d) (WARDEN-682). null/absent/invalid for a repo with no
  // commits / a non-git cwd / a branch-less cwd (mirrors headFresh); the derivations
  // treat that as age-unknown + not-stalled, never noise.
  headDate?: string | null;
  // WARDEN-670: the per-agent uncommitted-WIP magnitude — insertions/deletions from
  // `git diff HEAD --shortstat` (parsed by parseDiffStat in src/gitStatus.js and
  // served at /api/git-status as `diffstat: branch ? diffstat : null`). It ALREADY
  // ships on /api/git-status and is cached in the fleet gitStatus map ChatSidebar
  // holds (ChatSidebar.tsx stores `diffstat: j.diffstat`), but this GitStateStatus
  // slice previously dropped it — so the fleet summarizer had no per-agent magnitude,
  // and the ±N dirty popover was the only chip axis whose rows carried no per-agent
  // detail. Defined INLINE (the SAME shape /api/git-status serves), NOT imported from
  // sidebar/types — this module deliberately stays decoupled from React-layer types so
  // it remains unit-testable with plain objects (the decoupling GitStateChat relies
  // on). null for a detached/no-branch chat (the server serves null when there is no
  // branch) and +0−0 for an all-untracked WIP (shortstat counts tracked edits only);
  // both stay quiet downstream (DiffStatChip's own +0−0/null guard).
  diffstat?: { files: number; insertions: number; deletions: number } | null;
}

// One contributing agent for a project's WIP breakdown (WARDEN-268). The project
// chip's ±N / ↑N badges are now explorable: each popover lists exactly these
// agents so a human can jump straight to the dirty/unpushed one instead of
// scanning the whole project row by row. Kept deliberately minimal — no title,
// no branch — so the helper stays pure and testable with plain objects (the same
// decoupling the rest of this module relies on). The React layer joins
// `key → displayName(findChat(chats, key))` and `gitStatus[key].branch`, both of
// which are already in scope in ChatSidebar; display fields do NOT belong here.
export interface ProjectGitAgent {
  key: string;       // c.key || c.id — the same lookup the per-row GitBranchBadge uses
  dirty: boolean;    // clean === false (the yellow ± signal)
  ahead: number;     // status.ahead ?? 0 — the amber ↑N signal (> 0 ⇒ unpushed)
  behind: number;    // status.behind ?? 0 — the blue ↓N signal (> 0 ⇒ behind upstream)
  // WARDEN-635: at-risk repo state — a non-routine state a human scanning the fleet
  // should eyeball, surfaced as a 4th project chip (⚑N). Folded into one axis are the
  // three signals the per-row GitBranchBadge renders individually but the fleet rollup
  // previously dropped: detached HEAD (commits not on a branch; at risk if reflog
  // expires), no-upstream (a named branch never `push -u`'d — local-only, unbacked
  // work), or a mid merge/rebase/cherry-pick/revert/bisect op. `atRiskReason`
  // disambiguates WHICH of those it is so the popover can label the specific risk;
  // null when the agent is not at-risk. Mirrors the per-row discriminator at
  // GitBadges.tsx (the `noUpstream` line) so the chip and the row agree by construction.
  // WARDEN-701: a 4th reason class, `'conflict'` (unmerged UU/AA/UD/… paths), slots
  // BEFORE `'op'` in the precedence (conflict ⟹ op — conflicts only arise mid-merge/
  // rebase/cherry-pick ⇒ inProgress.operation is truthy in practice — but a blocked
  // merge cannot self-resolve, so it is the MORE specific/urgent at-risk signal and the
  // one a human must act on RIGHT NOW). Distinct from `'op'` (a clean, auto-completing
  // rebase) so a blocked merge no longer reads identically to it under ⚑'s generic
  // "operation in progress" label.
  atRisk: boolean;
  atRiskReason: 'detached' | 'noUpstream' | 'op' | 'conflict' | null;
  // WARDEN-701: the # of unmerged (conflicted) paths this agent carries — the count
  // behind the `'conflict'` atRiskReason, surfaced as the per-row ⚑ suffix
  // "merge conflict · N unmerged". Derived by counting files with the porcelain
  // `conflict` flag in the cached status.files array (no new fetch, no backend change
  // — the flag already ships on /api/git-status). 0 for every non-conflict reason
  // (detached/noUpstream/op) so the field reads truthy-count-equivalent to "is a
  // blocked merge", mirroring how stashCount/diffstat/headAgeMs were carried onto
  // ProjectGitAgent (WARDEN-667/670/669): a present, deep-equal field on every entry.
  conflictCount: number;
  // WARDEN-667: parked WIP — `stashCount > 0`, surfaced as the 5th project chip
  // (🗄N). `git stash` parks uncommitted work off the tree (porcelain status reads
  // clean while real WIP sits in the reflog), so a clean, pushed, up-to-date,
  // routine-state agent that holds parked WIP — the canonical stash case — was
  // previously invisible at the fleet level: it read ZERO across every chip. This
  // axis surfaces it. Mirrors the per-row GitBranchBadge's 🗄N badge (GitBadges.tsx)
  // so the chip and the row agree by construction.
  stashed: boolean;
  // WARDEN-689: the MAGNITUDE of this agent's parked WIP — `stashCount` (> 0 ⇔
  // `stashed`), the count `git stash list` returns that /api/git-status already
  // ships (WARDEN-211) and the summarizer already READS (the `stashCount` local
  // below) but previously DISCARDED to the `stashed` boolean before it reached the
  // popover. Mirrors how `ahead`/`behind` carry their counts alongside their > 0
  // booleans (the ↑N/↓N popovers render `a.ahead`/`a.behind`), so the 🗄N popover
  // can render ` · 🗄 N` per agent and rank heaviest-parker-first — an agent that
  // parked 12 stashes reads distinctly from one that parked 1. 0 when `stashCount`
  // is absent/null on the status (null ⇒ unknown ⇒ 0, never noise), the same
  // null-is-quiet discipline ahead/behind/stashed follow.
  stashCount: number;
  // WARDEN-669 + WARDEN-682: the age of this agent's HEAD commit — `now - headMs`
  // (ms) — the fleet-level TEMPORAL signal. WARDEN-669 ranks the ↑N unpushed popover
  // oldest-first off it (longest-sitting WIP on top = highest rot/collision risk);
  // WARDEN-682 derives the 6th 💤N stalled axis off the SAME field (headAgeMs >
  // STALE_HEAD_AGE_MS). Named `headAgeMs` (kind-agnostic), NOT `unpushedAgeMs`/
  // `stalledAgeMs`: a HEAD-committer age is a property of the agent's HEAD, so the
  // field reads correctly when any later slice reuses it to rank the dirty/behind/
  // atRisk popovers too. Derived from headDate (strict ISO-8601 from git %cI) via
  // `Number.isFinite(Date.parse(...))`, mirroring the per-row GitBranchBadge's headMs
  // derivation. WARDEN-682's coordination note planned ONE head-time field reused by
  // both the unpushed-axis rank and the stalled-axis membership test — this is it
  // (no parallel `headMs` field on the agent). null when headDate is missing/invalid/
  // empty (a repo with no commits / non-git cwd) so the unpushed popover renders no
  // age label + sorts the row last (mirrors headFresh / mergeFleetCommitsByEpoch's
  // null-epoch-last convention), and the stalled axis treats it as not-stalled.
  headAgeMs: number | null;
  // WARDEN-682: stalled ⇒ headAgeMs is a finite age older than STALE_HEAD_AGE_MS
  // (7d) — a clean, pushed, up-to-date, routine-state, stash-free agent whose HEAD
  // is >7d old reads ZERO on every other axis and was previously invisible at the
  // fleet level; this 6th axis (💤N) surfaces it. The 💤N popover filters
  // `agents.filter(a => a.stalled)`; the branch-line suffix reads headAgeMs. Mirrors
  // the per-row GitBranchBadge's `headStale` computation (GitBadges.tsx) so the chip
  // and the row agree on the SAME 7d threshold.
  stalled: boolean;
  // WARDEN-670: this agent's uncommitted-WIP magnitude (+N −M) — the dirty-axis
  // per-agent detail the ±N popover renders via DiffStatChip and ranks heaviest-first
  // (sortGitAgentsByMagnitudeDesc). Carried as the full split { insertions, deletions }
  // (NOT a scalar magnitude) because DiffStatChip needs insertions and deletions
  // SEPARATELY to render `+N −M` (DiffStatChip.tsx); a scalar would suffice for
  // SORTING but could not render the split chip. Read from status.diffstat (already
  // cached at the ChatSidebar call site — no new fetch, no backend change). null for a
  // detached/no-branch agent (the server serves diffstat: null when there is no
  // branch) and +0−0 for an all-untracked WIP; DiffStatChip's own +0−0/null guard
  // renders nothing then, so a dirty agent with no tracked edits shows no false
  // magnitude (not a lie). Mirrors the per-row DiffStatChip the row already renders
  // (ChatRows.tsx, GitBadges.tsx) — the fleet popover now speaks the same +N −M
  // language as the row, completing the dirty axis the way unpushed/behind/atRisk
  // already complete theirs.
  diffstat: { files: number; insertions: number; deletions: number } | null;
}

export interface ProjectGitState {
  dirty: number;     // # of the project's active agents with uncommitted changes
  unpushed: number;  // # of the project's active agents with unpushed commits
  behind: number;    // # of the project's active agents behind their upstream
  atRisk: number;    // # of the project's active agents in a non-routine repo state (WARDEN-635)
  stashed: number;   // # of the project's active agents with parked WIP (stashCount > 0, WARDEN-667)
  stalled: number;   // # of the project's active agents whose last commit is >7d old (headDate, WARDEN-682)
  // The contributing agents behind those counts, in `chats` iteration order
  // (deterministic, so tests assert deep equality). The ±N popover filters
  // `agents.filter(a => a.dirty)`; the ↑N popover filters `agents.filter(a =>
  // a.ahead > 0)`; the ↓N popover filters `agents.filter(a => a.behind > 0)`; the
  // ⚑N popover filters `agents.filter(a => a.atRisk)` (WARDEN-635); the 🗄N popover
  // filters `agents.filter(a => a.stashed)` (WARDEN-667); the 💤N popover filters
  // `agents.filter(a => a.stalled)` (WARDEN-682). An agent dirty AND
  // unpushed AND behind AND at-risk AND stashed AND stalled appears ONCE with all
  // signals. `dirty`/`unpushed`/`behind`/`atRisk`/`stashed`/`stalled` are retained
  // (the chip still reads them) even though they're now derivable — avoids churn at
  // the two call sites.
  agents: ProjectGitAgent[];
}

export interface ProjectGitSummary {
  // Sparse "needs attention" map: only projects with at least one dirty,
  // unpushed, behind, at-risk, stashed, OR stalled agent get an entry, so a clean
  // project yields no key (the chip's sub-badges hide on absence exactly as they
  // hide on a 0 count).
  perProject: Record<string, ProjectGitState>;
  total: ProjectGitState;  // the sum across all projects
}

// WARDEN-682: the last-commit freshness threshold — a HEAD commit older than this
// marks an agent "stalled" (💤). ⚠️ This MUST mirror `STALE_HEAD_AGE_MS` in
// web/src/components/sidebar/GitBadges.tsx so the fleet chip and the per-row `· Nd`
// append agree on EXACTLY who is stalled (fleet/row agreement rides on this shared
// 7d threshold, not on a shared color — the per-row stale tint is amber, the chip is
// sky). Kept as a LOCAL copy (NOT imported from the .tsx) so this pure module stays
// unit-testable directly via node (gitStateSummary.test.mjs imports the transpiled
// module); a runtime import of GitBadges.tsx would pull React/radix-ui/lucide and
// break every test in that file. The per-row badge keeps its own copy; this is the
// summarizer's own, comment-linked so the two stay in sync.
const STALE_HEAD_AGE_MS = 7 * 86400_000;

/**
 * Summarize uncommitted (`dirty`), unpushed (`unpushed`), behind-upstream
 * (`behind`), at-risk-repo-state (`atRisk`, WARDEN-635), parked-WIP (`stashed`,
 * WARDEN-667), and last-commit-freshness (`stalled`, WARDEN-682) agent counts per
 * project and globally, over the cached per-chat `gitStatus` map.
 *
 * Only active chats with a project are considered (the same population the chips'
 * `projectCounts` are drawn from). A chat missing from `gitStatus` — still
 * loading, or a non-git cwd — is treated as neither (no guess). `total` is the
 * sum of the per-project counts. Each `ProjectGitState` also carries the
 * contributing `agents` (in `chats` iteration order) so the chip badges can list
 * exactly who is dirty/unpushed/behind/at-risk/stashed/stalled — `total.agents` is
 * the union across projects.
 *
 * `now` (defaulting to `Date.now()`) is the staleness reference: an agent is
 * `stalled` when its `headDate` parses to a finite ms older than `now -
 * STALE_HEAD_AGE_MS`. The default keeps the lone production call site
 * (ChatSidebar.tsx) unchanged; tests pass a fixed `now` so assertions are
 * deterministic (the module stays pure — no `Date.now()` read inside the body).
 */
export function summarizeProjectGitState(
  chats: GitStateChat[],
  gitStatus: Record<string, GitStateStatus>,
  now: number = Date.now(),
): ProjectGitSummary {
  const perProject: Record<string, ProjectGitState> = {};
  const total: ProjectGitState = { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] };

  for (const c of chats) {
    // Match projectCounts' population exactly (active && has a project) so the
    // summary is over the same chats the chips represent.
    if (!c.active || !c.project) continue;

    const status = gitStatus[c.key || c.id];
    // Unknown status (not yet fetched / non-git) ⇒ neither, by design: never
    // surface noise for a chat whose repo state we don't actually know.
    if (!status) continue;

    const dirty = status.clean === false;
    const ahead = typeof status.ahead === 'number' ? status.ahead : 0;
    const unpushed = ahead > 0;
    const behindCount = typeof status.behind === 'number' ? status.behind : 0;
    const behind = behindCount > 0;
    // WARDEN-635: at-risk repo state — a non-routine state a human should eyeball,
    // surfaced as the 4th chip axis (⚑N). Mirrors the per-row GitBranchBadge
    // discriminator (GitBadges.tsx's `noUpstream` line) so fleet and row agree:
    //   detached === true              ⇒ 'detached'   (commits not on a branch)
    //   named branch with NO upstream  ⇒ 'noUpstream' (local-only, unbacked work)
    //   inProgress.operation truthy    ⇒ 'op'         (mid merge/rebase/cherry-pick/…)
    // The `branch` gate is load-bearing: without it, upstream:null is ambiguous
    // across detached / no-upstream / non-git-unborn (all read upstream:null).
    // server.js gates inProgress.operation on `branch` (null for detached), so a
    // detached agent surfaces via 'detached', never also 'op' — folded into one axis.
    //
    // WARDEN-701: a 4th reason class, `'conflict'` (unmerged UU/AA/UD/… paths), slots
    // BEFORE `'op'`. conflict ⟹ op — conflicts only arise mid-merge/rebase/cherry-pick
    // ⇒ inProgress.operation is truthy in practice — but a blocked merge CANNOT self-
    // resolve (unlike a clean, auto-completing rebase), so it is the more specific/
    // urgent at-risk signal and the one a human must act on RIGHT NOW. Counting the
    // porcelain `conflict` flags already on the cached status.files array (no new
    // fetch, no backend change). hasConflict reads truthy even if inProgress.operation
    // is somehow absent (porcelain conflict markers without a recorded op) — a
    // conflicted tree is at-risk regardless, so the branch never falls through to null.
    const isDetached = status.detached === true;
    const branch = status.branch ?? null;
    const upstream = status.upstream ?? null;
    const op = status.inProgress?.operation || null;
    const conflictCount = (status.files ?? []).filter((f) => f?.conflict).length;
    const hasConflict = conflictCount > 0;
    const atRiskReason: ProjectGitAgent['atRiskReason'] = isDetached
      ? 'detached'
      : (!isDetached && !!branch && branch !== 'HEAD' && !upstream)
        ? 'noUpstream'
        : hasConflict
          ? 'conflict'
          : op
            ? 'op'
            : null;
    const atRisk = atRiskReason !== null;
    // WARDEN-667: parked WIP — `git stash` parks uncommitted work off the tree, so
    // the stashCount signal is INDEPENDENT of the dirty/ahead/behind/atRisk axes
    // (a stash can sit alongside a clean, pushed, up-to-date, routine-state tree).
    // `stashCount: number > 0` ⇒ stashed; null/absent ⇒ unknown, treated as
    // not-stashed (the same null-is-quiet discipline ahead/behind follow). Mirrors
    // the per-row GitBranchBadge's `stashN` computation (GitBadges.tsx).
    const stashCount = typeof status.stashCount === 'number' ? status.stashCount : 0;
    const stashed = stashCount > 0;
    // WARDEN-669 + WARDEN-682: HEAD-commit time → age, derived from headDate (the
    // strict ISO-8601 last-commit time /api/git-status already ships via WARDEN-545
    // and the cached gitStatus map holds). Date.parse → NaN for a missing/invalid/
    // empty headDate (a repo with no commits / non-git cwd). The age is computed
    // against the fixed `now` arg (NOT Date.now()) so the module stays pure/
    // deterministic and tests are stable — a strict improvement over WARDEN-669's
    // original Date.now()-based derivation, and it keeps the two consumers (the
    // unpushed-popover age rank, WARDEN-669; the stalled-axis membership test,
    // WARDEN-682) reading off ONE `headAgeMs` field, reconciled per WARDEN-682's
    // coordination note so the agent carries a single head-time field, not two.
    const headMs = typeof status.headDate === 'string' && status.headDate ? Date.parse(status.headDate) : NaN;
    const headAgeMs = Number.isFinite(headMs) ? now - headMs : null;
    // WARDEN-682: stalled ⇒ headAgeMs is a finite age older than STALE_HEAD_AGE_MS
    // (7d) — a clean/pushed/in-sync/routine/stash-free agent whose HEAD is >7d old
    // previously read ZERO across every chip; this 6th axis surfaces it. Fleet/row
    // agreement rides on this shared 7d threshold (the per-row GitBranchBadge's own
    // headStale uses the same constant).
    const stalled = headAgeMs != null && headAgeMs > STALE_HEAD_AGE_MS;
    // A clean, pushed, up-to-date, routine-state, stash-free agent contributes
    // nothing — skip it so clean projects stay absent from the sparse map (and off
    // the chips). An at-risk-only agent is KEPT here (WARDEN-635) — the mirror of
    // WARDEN-297's "a behind-only agent now surfaces" change, for that axis. A
    // stashed-only agent is KEPT here too (WARDEN-667) — the same mirror for this
    // 5th axis: a clean, pushed, up-to-date, routine-state agent that holds parked
    // WIP (the canonical stash case) previously read ZERO across every chip and was
    // invisible at the fleet level. A stalled-only agent is KEPT here too (WARDEN-682)
    // — the same mirror for this 6th axis: a clean, pushed, up-to-date,
    // routine-state, stash-free agent whose HEAD is >7d old previously read ZERO
    // across every chip and was invisible at the fleet level.
    if (!dirty && !unpushed && !behind && !atRisk && !stashed && !stalled) continue;

    // WARDEN-670: carry this agent's uncommitted-WIP magnitude (status.diffstat,
    // already cached — no new fetch) onto ProjectGitAgent so the ±N popover can render
    // +N −M per row (via DiffStatChip) and rank heaviest-first. `?? null` coerces an
    // absent field to null so EVERY agent carries the field — the deep-equality shape
    // the test suite asserts — matching how the server serves null when there is no
    // branch. null/+0−0 stay quiet downstream via DiffStatChip's own guard.
    const diffstat = status.diffstat ?? null;

    // The agent entry shared by the per-project list and the global union. One
    // entry per contributing agent, so a both-dirty-and-at-risk agent appears a
    // single time with all signals (never duplicated).
    const agent: ProjectGitAgent = { key: c.key || c.id, dirty, ahead, behind: behindCount, atRisk, atRiskReason, stashed, stashCount, headAgeMs, stalled, diffstat, conflictCount };

    const entry = perProject[c.project] ?? { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] };
    if (dirty) entry.dirty += 1;
    if (unpushed) entry.unpushed += 1;
    if (behind) entry.behind += 1;
    if (atRisk) entry.atRisk += 1;
    if (stashed) entry.stashed += 1;
    if (stalled) entry.stalled += 1;
    entry.agents.push(agent);
    perProject[c.project] = entry;

    if (dirty) total.dirty += 1;
    if (unpushed) total.unpushed += 1;
    if (behind) total.behind += 1;
    if (atRisk) total.atRisk += 1;
    if (stashed) total.stashed += 1;
    if (stalled) total.stalled += 1;
    total.agents.push(agent);
  }

  return { perProject, total };
}

/**
 * Rank agents oldest-HEAD-first so the ↑N unpushed popover surfaces the
 * longest-sitting WIP on top — a human clicking the fleet chip integrates the
 * commits most at risk of rot/collision first (WARDEN-669). Largest `headAgeMs`
 * first; null-age rows (a repo with no commits / non-git cwd — headDate missing/
 * invalid/empty) sort LAST, stably, mirroring `mergeFleetCommitsByEpoch`'s null-
 * epoch-last convention.
 *
 * Pure + returns a NEW array (does NOT mutate its input) so it is unit-testable
 * without a React runner, matching the module's `diff.ts` philosophy. Critically,
 * the SUMMARIZER's own `agents` array is NOT reordered by this helper: that array
 * MUST stay in `chats` iteration order (its deterministic-order invariant, asserted
 * throughout the test suite and shared by the dirty/behind/atRisk popovers). The
 * sort is a per-kind RENDER-TIME concern — the React layer applies it ONLY to the
 * unpushed popover's filtered slice. `Array.prototype.sort` is stable on Node ≥12 /
 * V8, so null-age and equal-age ties preserve the pre-sort (chats) input order.
 */
export function sortByHeadAgeDesc(agents: ProjectGitAgent[]): ProjectGitAgent[] {
  return [...agents].sort((a, b) => {
    const aa = a.headAgeMs;
    const bb = b.headAgeMs;
    if (aa == null && bb == null) return 0;  // both null → keep input order
    if (aa == null) return 1;                 // null sorts after every real age
    if (bb == null) return -1;
    return bb - aa;                           // largest age first (oldest WIP on top)
  });
}

/**
 * Rank dirty agents heaviest-WIP-first so the ±N popover surfaces the largest
 * uncommitted change on top — a human clicking the fleet chip triages the highest-
 * integration-effort WIP first (a 2-line tweak no longer crowds out a +847 −203
 * mid-refactor) (WARDEN-670). Largest magnitude (`diffstat.insertions + deletions`)
 * first; a magnitude-0 row (an all-untracked dirty agent whose shortstat is +0−0) and
 * a null-diffstat row (detached, no branch) sort LAST, stably — magnitude 0 is simply
 * the smallest value, so the descending comparator places it under every real WIP,
 * and `Array.prototype.sort` is stable on Node ≥12 / V8 so magnitude-0 / equal-
 * magnitude ties preserve the pre-sort (chats) input order.
 *
 * Pure + returns a NEW array (does NOT mutate its input) so it is unit-testable
 * without a React runner, matching the module's `diff.ts` philosophy. Critically,
 * the SUMMARIZER's own `agents` array is NOT reordered by this helper: that array
 * MUST stay in `chats` iteration order (its deterministic-order invariant, asserted
 * throughout the test suite and shared by the unpushed/behind/atRisk popovers, which
 * must NOT be reordered). The sort is a per-kind RENDER-TIME concern — the React
 * layer (GitBadges.tsx's GIT_STATE_KIND.dirty.sort) applies it ONLY to the dirty
 * popover's filtered slice, never inside summarizeProjectGitState.
 */
export function sortGitAgentsByMagnitudeDesc(agents: ProjectGitAgent[]): ProjectGitAgent[] {
  const magnitude = (a: ProjectGitAgent): number =>
    (a.diffstat?.insertions ?? 0) + (a.diffstat?.deletions ?? 0);
  return [...agents].sort((a, b) => magnitude(b) - magnitude(a));
}

/**
 * Rank agents heaviest-parker-first so the 🗄N stash popover surfaces the agent
 * with the MOST parked WIP on top — a human clicking the fleet chip integrates the
 * biggest stash first (highest drift/loss risk: a 12-stash agent holds far more
 * parked, easily-forgotten work than a 1-stash one) (WARDEN-689). Largest
 * `stashCount` first; `0` (a stash-free agent — which never appears in the stash
 * popover's `.stashed`-filtered slice anyway) sorts last, stably, mirroring
 * sortByHeadAgeDesc's null/zero-last convention.
 *
 * Pure + returns a NEW array (does NOT mutate its input) so it is unit-testable
 * without a React runner, matching sortByHeadAgeDesc / sortGitAgentsByMagnitudeDesc
 * / the module's diff.ts philosophy. Critically, the SUMMARIZER's own `agents`
 * array is NOT reordered by this helper: that array MUST stay in `chats` iteration
 * order (its deterministic-order invariant, asserted throughout the test suite and
 * shared by the dirty/behind/atRisk/stalled popovers). The sort is a per-kind
 * RENDER-TIME concern — the React layer (GitBadges.tsx's GIT_STATE_KIND.stash.sort)
 * applies it ONLY to the stash popover's filtered slice, never inside
 * summarizeProjectGitState. Array.prototype.sort is stable on Node ≥12 / V8, so
 * equal-count (and all-0) ties preserve the pre-sort (chats) input order.
 */
export function sortByStashCountDesc(agents: ProjectGitAgent[]): ProjectGitAgent[] {
  return [...agents].sort((a, b) => b.stashCount - a.stashCount);  // largest count first
}

/**
 * Rank the ⚑ atRisk popover conflict-first so a merge-conflict-BLOCKED agent sits on
 * top — a human clicking the fleet chip triages the one repo state that CANNOT self-
 * resolve and needs a human RIGHT NOW before every clean auto-completing rebase,
 * no-upstream parker, or detached HEAD (WARDEN-701). Conflict-reason agents
 * (`atRiskReason === 'conflict'`) sort above every other atRiskReason; ties (both
 * conflict, or both not) preserve the pre-sort (chats) input order, so the
 * remainder stays in chats iteration order and conflict agents keep their relative
 * order among themselves.
 *
 * Pure + returns a NEW array (does NOT mutate its input) so it is unit-testable
 * without a React runner, matching the module's `diff.ts` philosophy and the three
 * sibling sorts. Critically, the SUMMARIZER's own `agents` array is NOT reordered by
 * this helper: that array MUST stay in `chats` iteration order (its deterministic-order
 * invariant, asserted throughout the test suite and shared by the dirty/behind/stash/
 * stalled popovers). The sort is a per-kind RENDER-TIME concern — the React layer
 * (GitBadges.tsx's GIT_STATE_KIND.atRisk.sort) applies it ONLY to the atRisk popover's
 * filtered slice, never inside summarizeProjectGitState. `Array.prototype.sort` is
 * stable on Node ≥12 / V8, so conflict/non-conflict ties preserve the input order.
 */
export function sortGitAgentsByConflictFirst(agents: ProjectGitAgent[]): ProjectGitAgent[] {
  const rank = (a: ProjectGitAgent): number => (a.atRiskReason === 'conflict' ? 1 : 0);
  return [...agents].sort((a, b) => rank(b) - rank(a));  // conflict (1) above the rest (0)
}

// A changed-file path that ≥2 distinct active agents in the SAME project both
// have in their uncommitted working tree — a cross-agent file-edit collision
// (WARDEN-288). The proactive complement to WARDEN-185, which surfaces a
// merge/rebase/cherry-pick conflict AFTER an agent is already blocked; this
// surfaces a collision BEFORE either agent commits and diverges. `agents` lists
// the contributors (≥2 distinct keys) in `chats` iteration order so tests assert
// deep equality; the React layer joins key → displayName/project, exactly as the
// ±N/↑N popovers do for ProjectGitAgent. Only `path` is the join key —
// status/conflict fields are intentionally NOT part of it (two agents creating
// the same new file path collide on `git add`/commit, so untracked `??` paths
// count too).
//
// `kind` discriminates the three collision classes the rollup surfaces:
//   - omitted (≡ 'live') — WARDEN-288's working-tree×working-tree collision (both
//     agents have the path dirty right now). Existing live collisions omit it so
//     this shape stays deep-equal to pre-601 tests.
//   - 'impending' — WARDEN-601's committed-outgoing × working-tree-WIP collision:
//     one agent committed the path (clean tree) and another has it dirty; the
//     collision lands on the next push/pull. Visually distinct in the rollup.
//   - 'outgoing' — WARDEN-639's committed-outgoing × committed-outgoing collision:
//     ≥2 agents each committed the path (both clean trees, both unpushed). The
//     class the live AND impending detectors are BOTH blind to (neither agent has
//     the path dirty, so neither contributes to the WIP join or the impending
//     editor side); it surfaces only at push/merge/CI. Every agent sources
//     'outgoing', so the compare dialog fetches each panel from its @{u}..HEAD range.
export interface FileCollisionAgent {
  key: string;  // c.key || c.id — the same lookup the per-row GitBranchBadge uses
  // source (WARDEN-601) marks WHICH side an agent brings to an 'impending' OR
  // 'outgoing' collision:
  //   'outgoing' — this agent's change to the path lives in an unpushed COMMIT (its
  //     working tree is clean for this path), so the compare dialog must fetch the
  //     path's diff from the outgoing range (@{u}..HEAD), NOT the (empty) working tree.
  //     Set for every agent in an 'outgoing' collision (both sides committed) and
  //     for the committer side of an 'impending' collision.
  //   'wip'      — this agent has the path dirty in its working tree (the live side).
  // Omitted for the working-tree×working-tree 'live' collision — those always fetch
  // the working-tree diff, so the compare dialog treats a missing source as 'wip'.
  source?: 'outgoing' | 'wip';
}

export interface FileCollision {
  path: string;
  agents: FileCollisionAgent[];  // ≥2 distinct agent keys, in chats iteration order
  kind?: 'live' | 'impending' | 'outgoing';
}

export interface FileCollisions {
  // The colliding paths, in `chats` iteration order (deterministic, so tests
  // assert deep equality). length = the ⚠ count shown on the chip.
  paths: FileCollision[];
}

export interface FileCollisionSummary {
  // Sparse "needs attention" map: only projects with ≥1 colliding path get an
  // entry, so a clean project yields no key (the chip renders no ⚠), exactly as
  // summarizeProjectGitState omits clean projects.
  perProject: Record<string, FileCollisions>;
  total: FileCollisions;  // union of colliding paths across all projects (for the "All Projects" chip)
}

/**
 * Detect cross-agent file-edit collisions: changed-file paths that ≥2 distinct
 * active agents in the SAME project both have in their uncommitted working tree
 * (WARDEN-288). A glance at a project chip's ⚠ badge then warns a human — before
 * either agent commits — that two agents are editing the same file and are about
 * to diverge into a merge conflict. The proactive complement to WARDEN-185's
 * post-block conflict surfacing.
 *
 * Population mirrors summarizeProjectGitState exactly (active chats with a
 * project, status looked up by `key || id`). The changed-file `path`s come from
 * the SAME cached gitStatus map — `/api/git-status` already returns per-chat
 * `files` parsed from `git status --porcelain` — so there is no new fetch. A
 * chat with `files: null` (detached/no-branch) or missing from the map (still
 * loading / non-git) contributes nothing, exactly like a not-yet-fetched chat.
 *
 * Join key is `path` ONLY — status/conflict fields are not compared, and
 * untracked (`??`) paths count (two agents creating the same new file collide on
 * `git add`/commit). A path appearing twice in ONE agent's `files` does not
 * self-collide: a collision requires ≥2 DISTINCT agent keys. `perProject` is
 * sparse (a project with no collision has no entry → no ⚠); `total` is the union
 * of colliding paths across all projects (for the "All Projects" chip). Paths
 * and agents are emitted in `chats` iteration order so tests assert deep equality.
 */
export function detectProjectFileCollisions(
  chats: GitStateChat[],
  gitStatus: Record<string, GitStateStatus>,
): FileCollisionSummary {
  // project -> (path -> ordered distinct agent keys touching it). Maps preserve
  // insertion order, so iterating them yields projects, paths, and agents all in
  // first-seen (= chats iteration) order — the deterministic ordering tests rely on.
  const byProject = new Map<string, Map<string, string[]>>();

  for (const c of chats) {
    // Same population gate as summarizeProjectGitState: only active chats with a
    // project are represented by the chips.
    if (!c.active || !c.project) continue;

    const status = gitStatus[c.key || c.id];
    // Unknown status (not yet fetched / non-git) ⇒ contributes nothing. A
    // detached/no-branch chat has files: null and is skipped the same way — never
    // a false collision from a chat whose files we don't actually know.
    if (!status) continue;
    const files = status.files;
    if (!files || files.length === 0) continue;

    const key = c.key || c.id;
    let paths = byProject.get(c.project);
    if (!paths) { paths = new Map(); byProject.set(c.project, paths); }

    // Dedupe paths WITHIN this single agent: a path listed twice for one agent
    // must not self-collide (a collision needs ≥2 distinct agent keys). Each chat
    // is visited once, so distinct chats contribute distinct keys per path.
    const seen = new Set<string>();
    for (const f of files) {
      const path = f?.path;
      if (!path || seen.has(path)) continue;
      seen.add(path);

      let agents = paths.get(path);
      if (!agents) { agents = []; paths.set(path, agents); }
      agents.push(key);
    }
  }

  const perProject: Record<string, FileCollisions> = {};
  const total: FileCollisions = { paths: [] };

  for (const [project, paths] of byProject) {
    const colliding: FileCollision[] = [];
    for (const [path, agents] of paths) {
      // A collision needs ≥2 distinct agent keys — a single agent on a path is
      // just ordinary WIP (already shown by the ±N badge), not a cross-agent risk.
      if (agents.length >= 2) {
        colliding.push({ path, agents: agents.map((k) => ({ key: k })) });
      }
    }
    // Sparse: only projects with at least one colliding path get an entry, so a
    // clean chip shows no ⚠.
    if (colliding.length > 0) {
      perProject[project] = { paths: colliding };
      total.paths.push(...colliding);
    }
  }

  return { perProject, total };
}

/**
 * Detect cross-agent IMPENDING file collisions (WARDEN-601): a changed-file path that
 * one active agent has in its UNPUSHED commits (outgoingFiles) while ANOTHER active
 * agent in the SAME project has dirty in its working tree (files). The collision
 * class the working-tree×working-tree detector (`detectProjectFileCollisions`,
 * WARDEN-288) is structurally blind to: agent A committed F (A's tree is clean → F
 * ∉ A.files → A contributes nothing to the WIP join) while agent B has F dirty — so
 * today NO collision is flagged, yet B's next pull (after A pushes) collides on F.
 * It only becomes visible at pull/push time, too late to coordinate; this surfaces it
 * now, as a forward-looking sibling of the live ⚠.
 *
 * Population mirrors detectProjectFileCollisions exactly (active chats with a
 * project, status by `key || id`). For each project, per path, it cross-joins:
 *   committers (source 'outgoing') — agents with the path in outgoingFiles; AND
 *   editors    (source 'wip')      — agents with the path in files (working tree).
 * A path with ≥1 committer AND ≥1 editor (distinct agents — which they are by
 * construction) is an impending collision. The committer-clean rule keeps this
 * orthogonal and noise-free with the live detector: an agent that has the path BOTH
 * outgoing AND dirty is NOT counted as a committer (its dirty copy already makes it a
 * live-collision contributor alongside any other dirty agent), so a path already
 * surfaced by the live ⚠ is NOT re-surfaced here as impending. `outgoingFiles` null
 * (detached/no-branch/in-sync) or missing contributes no committer; `files` null/
 * empty contributes no editor — both exactly like a not-yet-fetched chat.
 *
 * Returns the SAME sparse `{ perProject, total }` shape as detectProjectFileCollisions
 * so the rollup renders both through one badge, each entry tagged `kind: 'impending'`
 * with agents tagged `source: 'outgoing' | 'wip'` (committers first, then editors) so
 * the compare dialog can source the committer's panel from its outgoing change.
 * Paths/agents emit in `chats` iteration order so tests assert deep equality — the
 * convention the rest of this module follows.
 */
export function detectProjectImpendingCollisions(
  chats: GitStateChat[],
  gitStatus: Record<string, GitStateStatus>,
): FileCollisionSummary {
  // project -> (path -> { committers, editors }) where each list holds distinct agent
  // keys in chats iteration order. Maps preserve insertion order, so iterating yields
  // projects, paths, and agents all in first-seen (= chats iteration) order.
  const byProject = new Map<string, Map<string, { committers: string[]; editors: string[] }>>();

  for (const c of chats) {
    if (!c.active || !c.project) continue;
    const status = gitStatus[c.key || c.id];
    if (!status) continue;
    const key = c.key || c.id;

    // The working-tree WIP path set (the editor side) — distinct paths only.
    const wipPaths = new Set<string>();
    for (const f of status.files ?? []) {
      const p = f?.path;
      if (p) wipPaths.add(p);
    }
    const outgoing = status.outgoingFiles ?? [];

    let paths = byProject.get(c.project);
    if (!paths) { paths = new Map(); byProject.set(c.project, paths); }

    // Committers: path in outgoing AND NOT in wip (clean tree for that path — the
    // exact case the live WIP join is blind to). An agent with the path BOTH
    // outgoing and dirty is skipped here (it stays an editor below) so the live
    // detector owns that overlap and this one adds no noise on top of it.
    for (const p of outgoing) {
      if (!p || wipPaths.has(p)) continue;
      let entry = paths.get(p);
      if (!entry) { entry = { committers: [], editors: [] }; paths.set(p, entry); }
      if (!entry.committers.includes(key)) entry.committers.push(key);
    }
    // Editors: path in wip (dirty tree). Distinct keys only.
    for (const p of wipPaths) {
      let entry = paths.get(p);
      if (!entry) { entry = { committers: [], editors: [] }; paths.set(p, entry); }
      if (!entry.editors.includes(key)) entry.editors.push(key);
    }
  }

  const perProject: Record<string, FileCollisions> = {};
  const total: FileCollisions = { paths: [] };

  for (const [project, paths] of byProject) {
    const colliding: FileCollision[] = [];
    for (const [path, entry] of paths) {
      // An impending collision needs ≥1 committer AND ≥1 editor (distinct agents —
      // guaranteed, since a committer is clean for the path and an editor is dirty).
      // Committers first (the impending-conflict source), then editors, in chats order.
      if (entry.committers.length > 0 && entry.editors.length > 0) {
        colliding.push({
          path,
          kind: 'impending',
          agents: [
            ...entry.committers.map((k) => ({ key: k, source: 'outgoing' as const })),
            ...entry.editors.map((k) => ({ key: k, source: 'wip' as const })),
          ],
        });
      }
    }
    // Sparse: only projects with at least one impending path get an entry.
    if (colliding.length > 0) {
      perProject[project] = { paths: colliding };
      total.paths.push(...colliding);
    }
  }

  return { perProject, total };
}

/**
 * Detect cross-agent OUTGOING×OUTGOING file collisions (WARDEN-639): a changed-file
 * path that ≥2 distinct active agents in the SAME project EACH have in their UNPUSHED
 * commits (outgoingFiles) with CLEAN working trees for that path. The collision class
 * BOTH other detectors are structurally blind to: agent A committed F (A's tree is
 * clean → F ∉ A.files → A contributes nothing to the WIP join) AND agent C committed F
 * (C's tree is clean → C is not an editor either). The live ⚠ needs two dirty agents;
 * the impending ⏱ needs a committer AND an editor — neither fires when BOTH agents are
 * clean committers. So today NO collision is flagged, yet the two divergent unpushed
 * commits collide at push/merge/CI — the exact too-late failure WARDEN-601 was built to
 * preempt, for its symmetric case. This surfaces it now, as a third sibling of the live
 * ⚠ and impending ⏱.
 *
 * Population mirrors detectProjectImpendingCollisions exactly (active chats with a
 * project, status by `key || id`). For each project, per path, it collects COMMITTERS
 * only — agents with the path in outgoingFiles AND a clean tree for that path (REUSES
 * the exact committer-clean rule from detectProjectImpendingCollisions, so a path
 * already surfaced by the live ⚠ or the impending ⏱ is NOT re-surfaced here). A path
 * with ≥2 DISTINCT committer agent keys is an outgoing×outgoing collision.
 *
 * Kept INDEPENDENT/ORTHOGONAL to its siblings BY DESIGN: if A and B are both clean
 * committers and C is an editor, the path is BOTH an outgoing×outgoing collision
 * (A+B) AND an impending collision (A+C / B+C) — two distinct risks, both correctly
 * surfaced. There is no cross-class dedupe; each detector owns its own matrix cell.
 *
 * Returns the SAME sparse `{ perProject, total }` shape as the other two detectors so
 * the rollup renders all three through one badge, each entry tagged `kind: 'outgoing'`
 * with every agent tagged `source: 'outgoing'` (so the compare dialog fetches each
 * panel from its @{u}..HEAD outgoing range, not an empty working-tree diff). Paths/
 * agents emit in `chats` iteration order so tests assert deep equality — the convention
 * the rest of this module follows.
 */
export function detectProjectOutgoingCollisions(
  chats: GitStateChat[],
  gitStatus: Record<string, GitStateStatus>,
): FileCollisionSummary {
  // project -> (path -> ordered distinct committer keys). Maps preserve insertion
  // order, so iterating yields projects, paths, and agents all in first-seen
  // (= chats iteration) order — the deterministic ordering tests rely on.
  const byProject = new Map<string, Map<string, string[]>>();

  for (const c of chats) {
    if (!c.active || !c.project) continue;
    const status = gitStatus[c.key || c.id];
    if (!status) continue;
    const key = c.key || c.id;

    // The working-tree WIP path set — the committer-clean gate, REUSED VERBATIM from
    // detectProjectImpendingCollisions so the two detectors agree on who counts as a
    // clean committer. An agent with the path BOTH outgoing AND dirty is excluded here
    // (its dirty copy already makes it a live-collision contributor alongside any other
    // dirty agent, and an editor for the impending detector), so this detector adds no
    // noise on top of its siblings.
    const wipPaths = new Set<string>();
    for (const f of status.files ?? []) {
      const p = f?.path;
      if (p) wipPaths.add(p);
    }
    const outgoing = status.outgoingFiles ?? [];

    let paths = byProject.get(c.project);
    if (!paths) { paths = new Map(); byProject.set(c.project, paths); }

    // Committers: path in outgoing AND NOT in wip (clean tree for that path — the
    // exact case both other detectors are blind to). Distinct keys only, deduped per
    // path so one agent appearing twice (a path listed twice in its outgoingFiles)
    // never self-collides — a collision needs ≥2 DISTINCT agent keys.
    for (const p of outgoing) {
      if (!p || wipPaths.has(p)) continue;
      let committers = paths.get(p);
      if (!committers) { committers = []; paths.set(p, committers); }
      if (!committers.includes(key)) committers.push(key);
    }
  }

  const perProject: Record<string, FileCollisions> = {};
  const total: FileCollisions = { paths: [] };

  for (const [project, paths] of byProject) {
    const colliding: FileCollision[] = [];
    for (const [path, committers] of paths) {
      // An outgoing×outgoing collision needs ≥2 DISTINCT committer keys — a single
      // agent with the path outgoing is just ordinary unpushed work (already shown by
      // the ↑N badge), not a cross-agent risk. The committer-clean rule above
      // guarantees each key is a different agent with a CLEAN tree for the path.
      if (committers.length >= 2) {
        colliding.push({
          path,
          kind: 'outgoing',
          agents: committers.map((k) => ({ key: k, source: 'outgoing' as const })),
        });
      }
    }
    // Sparse: only projects with at least one outgoing×outgoing path get an entry.
    if (colliding.length > 0) {
      perProject[project] = { paths: colliding };
      total.paths.push(...colliding);
    }
  }

  return { perProject, total };
}

// ---- Fleet-wide commit search aggregation (WARDEN-534) ----------------------
//
// The cross-agent HISTORY layer — the fleet-wide counterpart to the per-agent
// commit-message grep shipped in WARDEN-498. Where summarizeProjectGitState +
// detectProjectFileCollisions aggregate STATUS and COLLISIONS across the fleet,
// this aggregates matched COMMITS: it turns N per-agent grep results into one
// grouped-by-agent view (each group carrying the agent key + project, each row
// carrying whether the commit is ↑unpushed) so a single sidebar-level query
// finds WHERE a change landed across the fleet instead of N manual per-agent
// greps.
//
// Pure (no React import, no fetch) so it is unit-testable directly via node,
// mirroring summarizeProjectGitState / diff.ts. The fan-out (the actual fetches)
// lives in the React component; this resolves the searchable population, then
// joins + groups + counts. Ordering follows the same convention as the rest of
// this module: outcomes are processed in the caller's iteration order
// (= chats order), so the returned groups are deterministic and tests assert
// deep equality.

// Minimal slice of Chat the searchable-population gate reads. Defined locally
// (like GitStateChat) so the helper stays decoupled and testable with plain
// objects rather than the React-layer Chat type.
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
 * Resolve the searchable fleet: active chats WITH a project (the same population
 * summarizeProjectGitState aggregates over), keyed by `key || id`, deduped by key
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
// objects — the same decoupling GitStateChat / GitStateStatus rely on.
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
// second lookup, mirroring how ProjectGitAgent carries key for the chip popovers.
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
// mirroring buildFleetCommitGroups / summarizeProjectGitState. The population gate
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
