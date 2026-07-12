// Aggregate per-chat git status into per-project + global WIP counts, for the
// project filter chips in ChatSidebar (WARDEN-201). A glance at the chips then
// surfaces — per project and globally — how many open agents have uncommitted or
// unpushed work, without opening each chat to read its branch badge.
//
// This reuses the cached `gitStatus` map (populated per open tab by fetchGitStatus
// on mount) — no new fetch, no backend change. A chat absent from the map counts
// as neither (status unknown / still loading), so loading or non-git chats never
// add noise. The vocabulary mirrors the per-row GitBranchBadge: dirty ⇒ yellow
// `±` (clean === false), unpushed ⇒ amber `↑N` (ahead > 0).
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
// uncommitted changes; ahead (a number > 0) ⇒ unpushed commits.
export interface GitStateStatus {
  clean?: boolean | null;
  ahead?: number | null;
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
}

export interface ProjectGitState {
  dirty: number;     // # of the project's active agents with uncommitted changes
  unpushed: number;  // # of the project's active agents with unpushed commits
  // The contributing agents behind those counts, in `chats` iteration order
  // (deterministic, so tests assert deep equality). The ±N popover filters
  // `agents.filter(a => a.dirty)`; the ↑N popover filters `agents.filter(a =>
  // a.ahead > 0)`. An agent both dirty AND unpushed appears ONCE with both
  // signals. `dirty`/`unpushed` are retained (the chip still reads them) even
  // though they're now derivable — avoids churn at the two call sites.
  agents: ProjectGitAgent[];
}

export interface ProjectGitSummary {
  // Sparse "needs attention" map: only projects with at least one dirty OR
  // unpushed agent get an entry, so a clean project yields no key (the chip's
  // sub-badges hide on absence exactly as they hide on a 0 count).
  perProject: Record<string, ProjectGitState>;
  total: ProjectGitState;  // the sum across all projects
}

/**
 * Summarize uncommitted (`dirty`) and unpushed (`unpushed`) agent counts per
 * project and globally, over the cached per-chat `gitStatus` map.
 *
 * Only active chats with a project are considered (the same population the chips'
 * `projectCounts` are drawn from). A chat missing from `gitStatus` — still
 * loading, or a non-git cwd — is treated as neither (no guess). `total` is the
 * sum of the per-project counts. Each `ProjectGitState` also carries the
 * contributing `agents` (in `chats` iteration order) so the chip badges can list
 * exactly who is dirty/unpushed — `total.agents` is the union across projects.
 */
export function summarizeProjectGitState(
  chats: GitStateChat[],
  gitStatus: Record<string, GitStateStatus>,
): ProjectGitSummary {
  const perProject: Record<string, ProjectGitState> = {};
  const total: ProjectGitState = { dirty: 0, unpushed: 0, agents: [] };

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
    // A clean, pushed agent contributes nothing — skip it so clean projects stay
    // absent from the sparse map (and off the chips).
    if (!dirty && !unpushed) continue;

    // The agent entry shared by the per-project list and the global union. One
    // entry per contributing agent, so a both-dirty-and-unpushed agent appears a
    // single time with both signals (never duplicated).
    const agent: ProjectGitAgent = { key: c.key || c.id, dirty, ahead };

    const entry = perProject[c.project] ?? { dirty: 0, unpushed: 0, agents: [] };
    if (dirty) entry.dirty += 1;
    if (unpushed) entry.unpushed += 1;
    entry.agents.push(agent);
    perProject[c.project] = entry;

    if (dirty) total.dirty += 1;
    if (unpushed) total.unpushed += 1;
    total.agents.push(agent);
  }

  return { perProject, total };
}
