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

export interface ProjectGitState {
  dirty: number;     // # of the project's active agents with uncommitted changes
  unpushed: number;  // # of the project's active agents with unpushed commits
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
 * sum of the per-project counts.
 */
export function summarizeProjectGitState(
  chats: GitStateChat[],
  gitStatus: Record<string, GitStateStatus>,
): ProjectGitSummary {
  const perProject: Record<string, ProjectGitState> = {};
  const total: ProjectGitState = { dirty: 0, unpushed: 0 };

  for (const c of chats) {
    // Match projectCounts' population exactly (active && has a project) so the
    // summary is over the same chats the chips represent.
    if (!c.active || !c.project) continue;

    const status = gitStatus[c.key || c.id];
    // Unknown status (not yet fetched / non-git) ⇒ neither, by design: never
    // surface noise for a chat whose repo state we don't actually know.
    if (!status) continue;

    const dirty = status.clean === false;
    const unpushed = typeof status.ahead === 'number' && status.ahead > 0;
    // A clean, pushed agent contributes nothing — skip it so clean projects stay
    // absent from the sparse map (and off the chips).
    if (!dirty && !unpushed) continue;

    const entry = perProject[c.project] ?? { dirty: 0, unpushed: 0 };
    if (dirty) entry.dirty += 1;
    if (unpushed) entry.unpushed += 1;
    perProject[c.project] = entry;

    if (dirty) total.dirty += 1;
    if (unpushed) total.unpushed += 1;
  }

  return { perProject, total };
}
