// Pure helper: find the same-project sibling agents ALSO touching the file a
// coordinator just opened in FileViewer (WARDEN-810) — the file-level complement
// to the sidebar's fleet ⚠ collision rollup (WARDEN-288). The sidebar badge is
// out of view once a reader is inside the FileViewer dialog, so the exact moment a
// coordinator is about to direct edits to a file is the moment they can no longer
// see who else is touching it. This surfaces that contention AT the reading moment:
// every OTHER same-project agent that has the open path dirty (±) / in a merge
// conflict (⚑) / in an unpushed commit (↑), without leaving the reader.
//
// Mirrors the fleet→file pattern WARDEN-786 established for WIP (the fleet rollup
// in WARDEN-765 → the per-file Changes view), now applied to "who else is touching
// this file." Reuses the SAME cached per-agent `gitStatus` map ChatSidebar already
// holds (populated per open tab by fetchGitStatus) — no new fetch, no backend
// route, no persisted field. `coEditors` is transient, derived at render.
//
// Pure (no React import, no value imports at all) so it is unit-testable directly
// via the OXC→temp-`.mjs` harness (see web/fileCoEditors.test.mjs), mirroring
// gitStateSummary.ts / fileViewerChanges.ts. CRUCIALLY import-free at runtime:
// the test harness transpiles this file with Vite's OXC transform, writes the JS to
// a TEMP DIR, and dynamically `import()`s it from there — Node's resolver can
// neither resolve the `@/` path alias NOR find a sibling via a relative path from
// that temp dir. So neither `displayName` (`@/lib/chatDisplay`) nor a relative
// value import can live here. The display label is therefore injected by the React
// layer via `labelFor(key)` — the exact `key → displayName(findChat(chats, key))`
// join GitBadges.tsx performs inline (line ~431/~741) — keeping this finder pure
// AND giving the leaf FileViewer a self-contained `CoEditor` (with label) prop
// without forcing it to take the whole `chats` array.

// Minimal slice of Chat this finder reads. Defined LOCALLY (like GitStateChat in
// gitStateSummary.ts) rather than imported — both so the helper stays decoupled
// from the React-layer Chat type AND so the import-free test harness keeps
// working (see the module header). The active+project population gate mirrors
// detectProjectFileCollisions (gitStateSummary.ts:880); the caller narrows
// `projectChats` to the reader's OWN project first (the param name is the contract
// — same-project chats in, same-project siblings out).
export interface CoEditorChat {
  id: string;
  key?: string;        // c.key || c.id — the same lookup the per-row GitBranchBadge uses
  project?: string;
  active?: boolean | null;  // null = undiscovered; only active chats have live status
}

// Minimal slice of a per-chat git status — the TWO changed-file lists this finder
// reads. Defined locally for the same decoupling reason (mirrors GitStateStatus in
// gitStateSummary.ts). `files` is the working-tree WIP set /api/git-status returns
// per chat (parsed from `git status --porcelain`), each entry carrying the porcelain
// `conflict` flag (parsed in src/gitStatus.js for the unmerged status codes
// DD/AU/UD/UA/DU/AA/UU) — the ⚑ signal WARDEN-796 ships. `outgoingFiles` is the
// unpushed-commit changed-file list (parsed from `git diff --name-only @{u}..HEAD`)
// — the ↑ signal WARDEN-601 ships. Both already live in the cached gitStatus map.
export interface CoEditorStatus {
  files?: { path: string; conflict?: boolean }[] | null;
  outgoingFiles?: string[] | null;
}

// One same-project sibling agent that ALSO has the open path dirty / in conflict /
// in an unpushed commit. `label` is the display name (joined by the caller's
// `labelFor` — see the module header for why it cannot be a direct displayName
// import). `key` is the deep-link target (swap FileViewer to this sibling's version
// of the file). The three booleans mirror the glyphs the fleet rollup already
// renders: ± dirty / ⚑ conflict / ↑ unpushed.
export interface CoEditor {
  key: string;
  label: string;
  dirty: boolean;    // the open path is in this sibling's working-tree WIP set (files)
  conflict: boolean; // that file entry carries the porcelain unmerged flag (⚑, WARDEN-796)
  unpushed: boolean; // the open path is in this sibling's unpushed-commit set (outgoingFiles, ↑)
}

export interface FindFileCoEditorsOptions {
  // The cwd-relative path open in FileViewer — the same join key
  // detectProjectFileCollisions compares across agents (gitStateSummary.ts:64).
  filePath: string;
  // The agent READING the file (fileTarget.chatId = c.key || c.id). Excluded from
  // results — the chip names the OTHER agents, never the reader itself.
  selfKey: string;
  // The reader's same-project chats. The CALLER narrows to the self's project first
  // (a same-project-only collision is what's actionable; a different-project agent
  // touching the same relative path is not in contention for THIS reader). This
  // finder still applies the active gate and self-exclusion internally.
  projectChats: CoEditorChat[];
  // The cached per-agent git status map ChatSidebar's useState holds.
  gitStatus: Record<string, CoEditorStatus>;
  // React-layer display-label join: `key → displayName(findChat(chats, key))`.
  // Injected (not imported) so this pure module stays import-free for the test
  // harness — see the module header. Tests pass a plain `(key) => key`.
  labelFor: (key: string) => string;
}

/**
 * Find every OTHER same-project active agent whose cached `gitStatus` shows the
 * open `filePath` as dirty (±), in a merge conflict (⚑), or in an unpushed commit
 * (↑) — the cross-agent file contention a coordinator should see the moment they
 * open a file to read it (WARDEN-810).
 *
 * Population mirrors detectProjectFileCollisions exactly (active chats with a
 * project, status looked up by `key || id`), PLUS the reader (`selfKey`) is
 * excluded — the chip names the OTHER agents touching the file, never the reader.
 * A chat missing from `gitStatus` (still loading / non-git) contributes nothing,
 * exactly like a not-yet-fetched chat in the detectors.
 *
 * MORE comprehensive than the WARDEN-288 rollup, by design: the rollup fires only
 * when ≥2 agents have a path DIRTY (working-tree×working-tree). This finder
 * surfaces contention from the READER's perspective even when the reader itself is
 * CLEAN — an impending sibling (committed the path, clean tree) or an outgoing
 * sibling (committed, unpushed) the live detector is structurally blind to. So a
 * sibling is included if ANY of dirty/conflict/unpushed is true for the open path.
 *
 * Returns the siblings in `projectChats` iteration order (deterministic — the same
 * convention every gitStateSummary helper follows, so tests assert deep equality).
 */
export function findFileCoEditors({
  filePath,
  selfKey,
  projectChats,
  gitStatus,
  labelFor,
}: FindFileCoEditorsOptions): CoEditor[] {
  // No path open (or an empty one) ⇒ nothing to surface. Guards the FileViewer's
  // initial render where filePath may be '' before fileTarget resolves.
  if (!filePath) return [];

  const out: CoEditor[] = [];
  for (const c of projectChats) {
    // Same population gate as detectProjectFileCollisions (gitStateSummary.ts:880):
    // only active chats with a project are represented. The caller already narrowed
    // to same-project, but a project can hold inactive agents whose stale cached
    // status would be misleading — skip them, exactly as the detectors do.
    if (!c.active || !c.project) continue;

    const key = c.key || c.id;
    // Exclude the reader: the chip names the OTHER agents touching the file, never
    // the agent whose version is currently on screen.
    if (key === selfKey) continue;

    const status = gitStatus[key];
    // Unknown status (not yet fetched / non-git cwd) ⇒ contributes nothing. Never
    // a false co-editor from a chat whose file state we don't actually know.
    if (!status) continue;

    // dirty (±): the open path is in this sibling's working-tree WIP set. The
    // porcelain file list is the same join key the live collision detector uses.
    const files = status.files ?? [];
    const fileEntry = files.find((f) => f?.path === filePath);
    const dirty = !!fileEntry;

    // conflict (⚑): that SAME entry carries the porcelain unmerged flag
    // (WARDEN-796's ⚑, parsed for the DD/AU/UD/UA/DU/AA/UU status codes). A
    // conflicted file is by construction also dirty (it sits in `files`), so
    // conflict ⇒ dirty; both glyphs render for it, which is honest (the file is
    // BOTH uncommitted AND blocked on a merge). Read off `fileEntry` directly
    // rather than re-scanning so the conflict flag is tied to the SAME row that
    // set `dirty` — a path can appear once per agent (porcelain dedupes).
    const conflict = !!fileEntry?.conflict;

    // unpushed (↑): the open path is in this sibling's unpushed-commit set
    // (outgoingFiles, @{u}..HEAD — WARDEN-601). `includes` over the bare path list
    // (outgoingFiles is a string[], no status objects). A path can be BOTH dirty
    // AND unpushed (the agent edited it AND has a prior unpushed commit touching
    // it); both flags are true then, which is accurate.
    const outgoing = status.outgoingFiles ?? [];
    const unpushed = outgoing.includes(filePath);

    // Include this sibling only if it touches the open path on ANY of the three
    // axes. This is the comprehensiveness divergence from the WARDEN-288 rollup
    // (which fires at ≥2-dirty): a single impending/outgoing sibling the live
    // detector is blind to still surfaces here, because from the READER's
    // perspective that one agent's pending change is the contention that matters.
    if (!dirty && !conflict && !unpushed) continue;

    out.push({ key, label: labelFor(key), dirty, conflict, unpushed });
  }

  // Deterministic: projectChats iteration order (the detectors' contract), so the
  // chip's popover lists siblings in a stable order and tests assert deep equality.
  return out;
}
