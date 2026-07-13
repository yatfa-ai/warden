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
