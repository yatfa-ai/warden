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
// hasn't pulled (WARDEN-297).
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
export interface GitStateStatus {
  clean?: boolean | null;
  ahead?: number | null;
  behind?: number | null;
  files?: { path: string }[] | null;
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
}

export interface ProjectGitState {
  dirty: number;     // # of the project's active agents with uncommitted changes
  unpushed: number;  // # of the project's active agents with unpushed commits
  behind: number;    // # of the project's active agents behind their upstream
  // The contributing agents behind those counts, in `chats` iteration order
  // (deterministic, so tests assert deep equality). The ±N popover filters
  // `agents.filter(a => a.dirty)`; the ↑N popover filters `agents.filter(a =>
  // a.ahead > 0)`; the ↓N popover filters `agents.filter(a => a.behind > 0)`. An
  // agent dirty AND unpushed AND behind appears ONCE with all signals.
  // `dirty`/`unpushed`/`behind` are retained (the chip still reads them) even
  // though they're now derivable — avoids churn at the two call sites.
  agents: ProjectGitAgent[];
}

export interface ProjectGitSummary {
  // Sparse "needs attention" map: only projects with at least one dirty,
  // unpushed, OR behind agent get an entry, so a clean project yields no key (the
  // chip's sub-badges hide on absence exactly as they hide on a 0 count).
  perProject: Record<string, ProjectGitState>;
  total: ProjectGitState;  // the sum across all projects
}

/**
 * Summarize uncommitted (`dirty`), unpushed (`unpushed`), and behind-upstream
 * (`behind`) agent counts per project and globally, over the cached per-chat
 * `gitStatus` map.
 *
 * Only active chats with a project are considered (the same population the chips'
 * `projectCounts` are drawn from). A chat missing from `gitStatus` — still
 * loading, or a non-git cwd — is treated as neither (no guess). `total` is the
 * sum of the per-project counts. Each `ProjectGitState` also carries the
 * contributing `agents` (in `chats` iteration order) so the chip badges can list
 * exactly who is dirty/unpushed/behind — `total.agents` is the union across
 * projects.
 */
export function summarizeProjectGitState(
  chats: GitStateChat[],
  gitStatus: Record<string, GitStateStatus>,
): ProjectGitSummary {
  const perProject: Record<string, ProjectGitState> = {};
  const total: ProjectGitState = { dirty: 0, unpushed: 0, behind: 0, agents: [] };

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
    // A clean, pushed, up-to-date agent contributes nothing — skip it so clean
    // projects stay absent from the sparse map (and off the chips). A behind-only
    // agent is kept here (WARDEN-297) — previously it was dropped entirely.
    if (!dirty && !unpushed && !behind) continue;

    // The agent entry shared by the per-project list and the global union. One
    // entry per contributing agent, so a both-dirty-and-unpushed-and-behind agent
    // appears a single time with all signals (never duplicated).
    const agent: ProjectGitAgent = { key: c.key || c.id, dirty, ahead, behind: behindCount };

    const entry = perProject[c.project] ?? { dirty: 0, unpushed: 0, behind: 0, agents: [] };
    if (dirty) entry.dirty += 1;
    if (unpushed) entry.unpushed += 1;
    if (behind) entry.behind += 1;
    entry.agents.push(agent);
    perProject[c.project] = entry;

    if (dirty) total.dirty += 1;
    if (unpushed) total.unpushed += 1;
    if (behind) total.behind += 1;
    total.agents.push(agent);
  }

  return { perProject, total };
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
export interface FileCollision {
  path: string;
  agents: { key: string }[];  // ≥2 distinct agent keys, in chats iteration order
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
