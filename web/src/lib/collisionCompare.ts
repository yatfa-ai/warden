// Pure helpers for the cross-agent file-edit collision "Compare edits" view
// (WARDEN-321) — the resolution layer on top of WARDEN-287/288's detection.
//
// The fan-out itself (Promise.allSettled over /api/git-diff per colliding agent)
// lives in the CollisionCompareDialog component because it touches fetch +
// per-panel state. These helpers are the TESTABLE pure seam: reducing the
// allSettled outcomes — aligned by index with the colliding agents — into a
// per-agent panel model, classifying each agent's diff result into one of
// ok / untracked / empty / error so the dialog renders each panel through the
// right branch. Extracted so the partial-failure + untracked + empty
// classification has real tests instead of being asserted by hand, mirroring
// broadcast.ts (the send fan-out's pure reducer) and gitStateSummary.ts.
//
// `import type` only below — erased by OXC, so this module loads under the
// transpile-to-temp-`.mjs` + dynamic-`import()` harness (see
// collisionCompare.test.mjs), matching broadcast.test.mjs / gitStateSummary.test.mjs.

/** One agent's /api/git-diff response shape (server.js:1377-1402). The dialog's
 *  fetch callback normalizes a non-ok HTTP status into `{ error }` (mirroring how
 *  broadcast.ts's fan-out maps a 404/500 into `{ ok: false, error }`) so the
 *  reducer never sees a Response object — only the settled data. */
export interface GitDiffResult {
  diff: string | null;
  untracked: boolean;
  error?: string | null;
}

/** The side an agent brings to a collision — decides which diff the compare dialog
 *  fetches for that agent's panel (WARDEN-601). 'outgoing' = the agent's change to
 *  the path lives in an unpushed COMMIT (clean working tree) → the panel MUST fetch
 *  the outgoing (@{u}..HEAD) diff, or it would be empty and misclassify as 'already
 *  resolved' (the load-bearing nuance for an IMPENDING collision's committer).
 *  Undefined / 'wip' = the agent has the path dirty in its working tree → fetch the
 *  ordinary working-tree diff (the original WARDEN-321 behavior). */
export type CollisionAgentSource = 'outgoing' | 'wip';

/**
 * Build the per-agent `/api/git-diff` URL the compare dialog fans out, choosing the
 * diff RANGE by the agent's collision `source` (WARDEN-601).
 *
 * For a working-tree contributor (source omitted / 'wip') this is the original
 * `/api/git-diff?id=&path=` (the file's uncommitted change vs HEAD) — unchanged
 * behavior for the live WARDEN-288 collision. For an OUTGOING contributor
 * (source 'outgoing' — an impending collision's committer, whose working tree is
 * clean for this path) it appends `&range=outgoing` so the panel shows the file's
 * UNPUSHED-COMMIT change instead of an empty working-tree diff that would wrongly
 * read "file matches HEAD — already resolved." Extracted into the pure layer (not
 * inlined in the React component) so the outgoing⇄working-tree URL swap is unit-
 * testable without a React runner (this repo has none), mirroring
 * buildFleetSearchBaseUrl's extraction.
 *
 * `path` and `key` are URL-encoded so special chars (spaces, query chars) are safe.
 */
export function buildCollisionDiffUrl(
  key: string,
  path: string,
  source?: CollisionAgentSource | null,
): string {
  const base = `/api/git-diff?id=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`;
  return source === 'outgoing' ? `${base}&range=outgoing` : base;
}

/** The per-panel render classification the dialog branches on. Ordered from most
 *  to least useful so a switch/lookup falls through sensibly. */
export type CollisionDiffStatus = 'ok' | 'untracked' | 'empty' | 'error';

/** One agent's resolved diff-panel model. Display fields (name, host, branch) are
 *  intentionally NOT here — the React layer joins `key → displayName/host/branch`
 *  via findChat + gitStatus, exactly as the ±N/↑N popovers do for
 *  ProjectGitAgent. Keeping the helper display-field-free is what makes it pure
 *  and testable with plain objects. */
export interface CollisionDiffPanel {
  key: string;
  status: CollisionDiffStatus;
  /** The diff text. Empty string when there is none (untracked-with-no-content,
   *  empty, or error) — the `status` field disambiguates WHY. */
  diff: string;
  /** A human-readable reason when `status === 'error'`; null otherwise. */
  error: string | null;
}

/**
 * Reduce `Promise.allSettled` outcomes into a per-agent diff-panel list.
 *
 * `agents` and `results` are aligned by index (Promise.allSettled preserves
 * array order): `results[i]` is the outcome of fetching
 * `/api/git-diff?id=agents[i].key&path=<path>`. Each outcome is classified
 * INDEPENDENTLY so a partial failure — one agent's host unreachable, one whose
 * file is no longer dirty, one whose diff errored — is reported per-panel and
 * does NOT abort or blank the others (that's the allSettled contract, not
 * Promise.all; this reducer merely reports what happened per agent, never
 * throws). This is the load-bearing property for the collision view: a human
 * comparing two agents' edits must still see the reachable agent's diff when
 * the other is down.
 *
 * Classification (mirrors DiffViewer's branches so the popover's per-agent panel
 * reads identically to opening that agent's own diff modal):
 *  - rejected promise          → 'error' (a network throw / unreachable host;
 *                                 reason.message if an Error, else stringified)
 *  - fulfilled with `.error`   → 'error' (the 200-with-error AND the 4xx/5xx
 *                                 shapes — the fetch path folds both into `.error`)
 *  - fulfilled, untracked:true → 'untracked' (a new file HEAD has no record of;
 *                                 the panel renders the new-file content if any,
 *                                 else a "no tracked baseline" note)
 *  - fulfilled, empty diff     → 'empty' (file matches HEAD — the collision has
 *                                 already resolved on THIS agent's side; a real
 *                                 signal, not a bug)
 *  - otherwise                 → 'ok' (render the diff)
 *
 * A missing result slot (results shorter than agents, e.g. a buggy call site) is
 * treated as an 'error' rather than crashing — the panel still renders, labeled
 * unreachable, so a mis-sized fan-out surfaces instead of dropping an agent
 * silently.
 */
export function reduceCollisionDiffs(
  agents: { key: string }[],
  results: PromiseSettledResult<GitDiffResult>[],
): CollisionDiffPanel[] {
  return agents.map((agent, i) => {
    const res = results[i];
    // No slot at all (call-site bug: fewer results than agents). Surface it
    // rather than crash — the human still sees the agent named + flagged.
    if (!res) {
      return { key: agent.key, status: 'error', diff: '', error: 'unreachable' };
    }
    if (res.status === 'rejected') {
      const reason = res.reason;
      const error = reason instanceof Error
        ? reason.message
        : (reason === undefined || reason === null ? 'unreachable' : String(reason));
      return { key: agent.key, status: 'error', diff: '', error };
    }
    const v = res.value ?? {};
    // The fetch path maps every error shape (non-ok HTTP, 200-with-error,
    // thrown-and-caught) into `.error`, so this single branch covers all of them.
    if (v.error) {
      return { key: agent.key, status: 'error', diff: '', error: String(v.error) };
    }
    if (v.untracked) {
      // An untracked file may still carry content if the transport returned the
      // new file as additions; pass it through so the panel can render it.
      return { key: agent.key, status: 'untracked', diff: v.diff ?? '', error: null };
    }
    const diff = v.diff ?? '';
    if (diff.length === 0) {
      return { key: agent.key, status: 'empty', diff: '', error: null };
    }
    return { key: agent.key, status: 'ok', diff, error: null };
  });
}

// ============================================================================
// A↔B cross-agent working-tree diff (WARDEN-593)
// ============================================================================
// The per-agent reducer above classifies each agent's diff vs its OWN HEAD. This
// sibling reducer classifies the SINGLE A↔B diff — two agents' CURRENT working-tree
// versions of the same colliding path, diffed DIRECTLY against each other by
// /api/cross-agent-diff (server.js) — so the dialog can render the top "A ↔ B
// overlap" panel that answers the one question a collision raises (do the edits
// overlap?) without making the human mentally overlay two independent vs-HEAD diffs.
// Mirrors reduceCollisionDiffs' discipline: the fetch wraps its single request in
// Promise.allSettled so the rejected→error mapping lives in THIS testable pure seam,
// never in the component.

/** /api/cross-agent-diff response shape (server.js /api/cross-agent-diff): a direct
 *  A↔B diff of two agents' working-tree file content. `diff` is null on error or
 *  an empty string when the two working trees are byte-identical. */
export interface CrossAgentDiffResult {
  diff: string | null;
  error?: string | null;
}

/** The A↔B overlap panel classification the dialog branches on. Ordered from most-
 *  to least-useful. 'identical' is DISTINCT from the per-agent 'empty' status: here
 *  it means the two agents' working trees are byte-identical → "both made the same
 *  change, no conflict" — a genuine resolution signal, not a no-op or a missing
 *  diff. (The per-agent 'empty' means one agent matches its OWN HEAD — different
 *  question, different word.) */
export type CrossAgentDiffStatus = 'differ' | 'identical' | 'error';

/** The A↔B overlap panel model. Display fields (the two agents' names/hosts) are
 *  intentionally NOT here — the React layer joins keyA/keyB → displayName/host via
 *  findChat + gitStatus, exactly as the per-agent panels do for one key. Keeping
 *  the helper display-field-free is what makes it pure + testable with plain objs. */
export interface CrossAgentDiffPanel {
  keyA: string;
  keyB: string;
  status: CrossAgentDiffStatus;
  /** The diff text. Empty unless status === 'differ' — `status` disambiguates WHY. */
  diff: string;
  /** A human-readable reason when status === 'error'; null otherwise. The server
   *  prefixes the failing side (e.g. "A: file not found"); pass it straight through. */
  error: string | null;
}

/**
 * Reduce the single /api/cross-agent-diff fetch outcome into an A↔B overlap panel.
 *
 * `result` is the `PromiseSettledResult` of the one fetch (the dialog wraps its
 * request in `Promise.allSettled([fetch(...)])[0]` so this reducer owns the
 * rejected→error mapping, mirroring reduceCollisionDiffs). Classification:
 *  - rejected promise          → 'error' (a network throw / unreachable host;
 *                                 reason.message if an Error, else stringified)
 *  - fulfilled with `.error`   → 'error' (a read failure on one side, binary file,
 *                                 missing path, git error — the server prefixes the
 *                                 side, e.g. "A: file not found")
 *  - fulfilled, non-empty diff → 'differ' (the two working trees diverge → render it)
 *  - fulfilled, empty/null diff → 'identical' (both agents made the same change —
 *                                 no conflict; the resolution the dialog exists to surface)
 *
 * A missing outcome (undefined — fewer than 2 agents, or a buggy call site) is
 * 'error' rather than crashing, so a mis-sized call surfaces instead of rendering
 * a broken panel.
 */
export function reduceCrossAgentDiff(
  keyA: string,
  keyB: string,
  result: PromiseSettledResult<CrossAgentDiffResult> | undefined,
): CrossAgentDiffPanel {
  if (!result) {
    return { keyA, keyB, status: 'error', diff: '', error: 'unreachable' };
  }
  if (result.status === 'rejected') {
    const reason = result.reason;
    const error = reason instanceof Error
      ? reason.message
      : (reason === undefined || reason === null ? 'unreachable' : String(reason));
    return { keyA, keyB, status: 'error', diff: '', error };
  }
  const v = result.value ?? {};
  // The server folds every error shape (non-ok HTTP, 200-with-error, thrown-and-
  // caught) into `.error`, often prefixed with the failing side (A:/B:).
  if (v.error) {
    return { keyA, keyB, status: 'error', diff: '', error: String(v.error) };
  }
  const diff = v.diff ?? '';
  if (diff.length === 0) {
    // The two working trees are byte-identical — a genuine "both made the same
    // change, no conflict" signal, NOT a missing diff. Distinct from per-agent 'empty'.
    return { keyA, keyB, status: 'identical', diff: '', error: null };
  }
  return { keyA, keyB, status: 'differ', diff, error: null };
}
