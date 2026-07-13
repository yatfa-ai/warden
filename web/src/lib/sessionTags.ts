// Pure helpers for the session-tag sidecar (WARDEN-342). Extracted from
// ChatSidebar so the orphan-hiding + tag-filter + add/remove logic is unit-testable
// without a React runner (mirrors agentFilter.ts / diff.ts). No React, no imports.
//
// Tags are short reusable labels a human puts on a past Claude session; they live in
// a local sidecar keyed by claude-session id (cfg.sessionTags, never written into
// transcripts). These functions are the pure query/mutation layer over that map.

// A past Claude session row — only `id` matters here (the sidecar key). No index
// signature: ClaudeSession (which has id + extra typed fields) is structurally
// assignable to this, and a generic on filterSessionsByTags preserves the richer
// element type so callers keep access to summary/cwd/mtime.
export interface TaggedSession {
  id: string;
}

// Distinct tags among the IN-LIST session ids only, sorted for stable chip order.
// A tag on a session that has vanished (an orphan in the sidecar map) is IGNORED —
// never shown — because its id is absent from `sessions`. This is the same leniency
// cfg.pins/cfg.agentNotes already imply for vanished chats, and the contract the ☁
// sessions UI relies on: filtering/tag-display must never throw on a stale id.
export function computeTagsInUse(
  sessions: readonly TaggedSession[],
  sessionTags: Record<string, string[]>,
): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    const ts = sessionTags[s.id];
    // Array.isArray guard: a hand-edited config could hold a non-array value, and a
    // string is iterable (for...of would iterate its chars). Never throw on a stale
    // id — ignore anything that isn't a clean tag array (the "never throws" criterion).
    if (Array.isArray(ts)) for (const t of ts) set.add(t);
  }
  return Array.from(set).sort();
}

// Scope the list to sessions bearing ANY active tag filter (union semantics: a
// session matches if it carries at least one selected tag). Returns the original
// array unchanged when no filter is active, so the caller's most-recent-N cap and
// ordering are the only thing in play when the human hasn't filtered. Generic in S
// so the element type (e.g. ClaudeSession) is preserved on the way out.
export function filterSessionsByTags<S extends TaggedSession>(
  sessions: readonly S[],
  sessionTags: Record<string, string[]>,
  activeFilters: ReadonlySet<string>,
): S[] {
  if (!activeFilters || activeFilters.size === 0) return [...sessions];
  return sessions.filter((s) => {
    const ts = sessionTags[s.id];
    return Array.isArray(ts) && ts.some((t) => activeFilters.has(t));
  });
}

// Add a tag client-side (trim + case-insensitive dedupe). The server re-validates
// (length/count caps), so this is optimistic: it only keeps the local map consistent
// while the PUT is in flight. Returns the original array reference when the tag is
// already present or empty after trim (so callers can skip a needless PUT).
export function addTag(existing: readonly string[], tag: string): string[] {
  const v = typeof tag === 'string' ? tag.trim() : '';
  if (!v) return [...existing];
  if (existing.some((t) => t.toLowerCase() === v.toLowerCase())) return [...existing];
  return [...existing, v];
}

// Remove a tag client-side (exact match). Returns a NEW array (immutable update).
export function removeTag(existing: readonly string[], tag: string): string[] {
  return existing.filter((t) => t !== tag);
}
