// Pure helpers for the in-view transcript search (WARDEN-513). Extracted from
// SessionTranscriptViewer so the match computation + ↑/↓ wrap navigation are unit-
// testable without a React runner — this repo has no front-end component test
// runner, so the testable seam lives here (same pattern as src/lib/gitStateSummary.ts;
// see web/fleetCommitSearch.test.mjs for the TS→ESM test harness). The React pieces
// that are NOT pure — the debounce timer, the scrollIntoView side effect, the ref
// map — stay in the component and consume these helpers.

// Anything with a `text` field — TranscriptMessage satisfies this structurally, so the
// component can pass its messages array without adapter code.
export interface SearchableText {
  text: string;
}

// Case-insensitive substring match indices over the message texts, in document order.
// An empty/whitespace query matches nothing: the UI hides the count and drops
// highlights when there's no query, so [] is never surfaced there, but returning []
// keeps the helper correct if called before the query resolves.
export function findTranscriptMatches(messages: SearchableText[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].text.toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

// Step the active-match cursor by dir (+1 = next, -1 = prev) with WRAP-AROUND,
// mirroring xterm's findNext/findPrevious — the live-pane search wraps, so this
// surface does too (identical feel). Stepping next past the last match returns to 0;
// stepping prev at 0 wraps to the last match. An empty result set pins the cursor at 0.
export function stepMatchIndex(current: number, dir: 1 | -1, matchCount: number): number {
  if (matchCount <= 0) return 0;
  // Double-mod handles JS's sign-preserving % so a negative intermediate (prev at 0)
  // still lands in [0, matchCount).
  return ((((current + dir) % matchCount) + matchCount) % matchCount);
}

// Resolve the active match's MESSAGE index (the value the UI rings + scrolls to),
// clamping an out-of-range cursor to the last valid match — so a transiently-stale
// cursor (results shrank on a new query / prepended page) can never index past the
// end. Returns -1 when there are no matches (the UI renders no active ring then).
export function activeMatchMessageIndex(matches: number[], current: number): number {
  if (matches.length === 0) return -1;
  const idx = Math.min(Math.max(current, 0), matches.length - 1);
  return matches[idx];
}
