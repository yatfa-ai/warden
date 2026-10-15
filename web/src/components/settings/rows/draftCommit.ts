/** Shared draft-commit decision helpers for the settings rows (WARDEN-1219).
 *
 *  SnippetRow and PatternRow each carry the same two commit-on-blur rules
 *  (originally hand-copied across PresetRow too, retired in WARDEN-1816). These helpers hold each rule in one
 *  tested place; the rows delegate to them. They are pure decisions — they never
 *  touch state or callbacks, so they are testable without rendering anything.
 *
 *  The silent-data-loss guard: committing an EMPTY name or value must revert,
 *  never persist — parseSnippets would drop the whole
 *  stored entry on next reload if an empty field were written through.
 *
 *  The rows differ in what identifies the entry to the rename callback (the snippet
 *  row passes the previous NAME, the pattern row passes its id), so
 *  these helpers take no identity at all — the row supplies its own argument
 *  when invoking its callback.
 */

export type DraftCommitDecision =
  | { commit: true; value: string }
  | { commit: false };

/** Rule 1 — the name rule: commit a changed, non-empty trimmed name; otherwise
 *  (empty or unchanged) revert to the current name. An empty commit reverts so a
 *  blank name is never persisted (the data-loss guard). */
export function decideDraftNameCommit(
  draft: string,
  currentName: string,
): DraftCommitDecision {
  const trimmed = draft.trim();
  if (trimmed && trimmed !== currentName) return { commit: true, value: trimmed };
  return { commit: false }; // empty or unchanged → revert
}

/** Rule 2 — the value rule: commit a non-empty trimmed value; an empty one
 *  reverts to the last saved value so the field is editable but never goes
 *  dangling (never persist an empty command/text/expression — the same
 *  data-loss guard, value side). Unchanged values pass through as a commit —
 *  matching the original row bodies, which only guard emptiness here. */
export function decideDraftValueCommit(draft: string): DraftCommitDecision {
  const trimmed = draft.trim();
  if (trimmed) return { commit: true, value: trimmed };
  return { commit: false }; // empty → revert
}
