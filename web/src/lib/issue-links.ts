// Strict per-project issue-key extraction for the in-terminal linkifier
// (WARDEN-1388, slice 1 of roadmap WARDEN-1386).
//
// The third sibling of url-links.ts (WARDEN-1256) and path-links.ts
// (WARDEN-227), and the only one of the three that is GATED: it produces
// candidates only when the caller hands it the pane's own configured tracker
// entries — the shared integration toggle and the per-project mapping live
// with the caller (App → PaneTile, via /api/config). With the integration off
// or the pane's project unmapped the caller never calls this, so the link
// provider's output is byte-identical to before this module existed.
//
// Three properties are load-bearing (all three are the ticket's strictness):
//
//   1. WHOLE-TOKEN ANCHORING. A candidate is an entire whitespace-delimited
//      token (leading/trailing punctuation trimmed), never a substring. So
//      `SHA-256`, `UTF-8` and `HTTP-404` cannot match unless the pane's project
//      is actually configured with those (absurd) prefixes, another project's
//      key (`YATFA-1234` in a warden pane) stays plain text, and a key inside a
//      bigger word (`XWARDEN-1385`, `WARDEN-1385.tsx`) never linkifies.
//   2. CONFIGURED PREFIXES ONLY. The token's text before its first `-` must be
//      EXACTLY one of the configured prefixes (case-sensitive — the server
//      stores prefixes uppercased and issue keys are conventionally upper).
//      Nothing about the project is inferred from the key text itself.
//   3. URL > PATH > ISSUE PRECEDENCE, STRUCTURAL. The caller runs this matcher
//      over the line with URL spans (maskUrls) AND path-candidate spans
//      (maskSpans) already blanked, so an issue candidate can never land inside
//      a URL or a path link. (Whole-token anchoring already makes overlap
//      impossible in practice — an issue token contains no `.`, so no path
//      candidate can contain one — but masking keeps the invariant structural,
//      the same trick the path side uses against URLs.)
//
// Like its two siblings it is pure, side-effect-free, and unit-tested directly
// under the OXC-transform harness (web/issue-links.test.mjs). Decoration and
// opening live in PaneTile: construction-time underline+pointer+tooltip (no
// async probe — a configured key is valid by construction, exactly like a URL),
// activate → `https://<tracker>/<KEY>` via the system browser bridge.

export interface IssueLinkEntry {
  /** The pane project this mapping belongs to (strict, case-sensitive match against chat.project). */
  project: string;
  /** The issue-key prefix (uppercase — the server's sanitizer normalizes it). */
  prefix: string;
  /** Tracker base WITHOUT scheme or trailing slash: `host[:port][/path]`. */
  tracker: string;
}

export interface IssueCandidate {
  /** Index in the source line where the KEY starts (after leading-punct trim). */
  start: number;
  /** Length of the key as it should be linked (after trailing-punct trim). */
  length: number;
  /** The normalized key — what the opener appends to the tracker URL. */
  key: string;
}

export interface IssueScanOptions {
  /**
   * Same wrap rule as the URL matcher: true when the NEXT terminal buffer line
   * is a wrapped continuation of this one (IBufferLine.isWrapped). A key that
   * runs to end-of-line in that state may be truncated by the wrap (its tail
   * digits live on the next line) — and a truncated tail still passes the
   * `prefix-digits` shape — so candidates ending exactly at end-of-line are
   * dropped rather than linked to a wrong record.
   */
  wrappedAtEol?: boolean;
}

// Characters trimmed from a token's head/tail before the anchor test — sentence
// and bracket punctuation, quotes, and markdown backticks that terminal output
// prints AROUND keys (`see WARDEN-1385.`, `[WARDEN-1385]`, `"WARDEN-1385"`,
// `` `WARDEN-1385` ``). A trim set, not a regex: the key core itself is then
// matched structurally (see below), so none of this punctuation can leak into
// what gets linked or opened.
const TRIM_CHARS = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '<', '>', '(', ')', '[', ']', '{', '}', '`']);

// All-digits test for the token tail (the part after the prefix's hyphen).
const DIGITS_RE = /^[0-9]+$/;

// Defensive re-validation of /api/config-provided entries (WARDEN-1388): the
// server sanitizes on PUT, but a hand-edited config.json bypasses that, and the
// GET resolve is arrayOrEmpty (raw passthrough) — so the frontend filters
// rather than trusting. Same rules the server enforces, inlined: a project is
// non-empty (length ≤ 64), a prefix letters-then-alphanumerics (length ≤ 16),
// a tracker has NO scheme, no whitespace, no query/hash (length ≤ 200).
export function normalizeIssueLinkEntries(raw: unknown): IssueLinkEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: IssueLinkEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { project, prefix, tracker } = e as Record<string, unknown>;
    if (typeof project !== 'string' || !project || project.length > 64) continue;
    if (typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(prefix)) continue;
    if (typeof tracker !== 'string' || !tracker || tracker.length > 200) continue;
    if (tracker.includes('://') || /\s/.test(tracker) || tracker.includes('?') || tracker.includes('#')) continue;
    out.push({ project, prefix: prefix.toUpperCase(), tracker: tracker.replace(/\/+$/, '') });
  }
  return out;
}

// The pane's own entries: strict, case-sensitive `project` equality against the
// pane's chat.project. An unknown/empty pane project yields [] — panes without
// a project never linkify (the ticket's strict scoping; no inference).
export function issueEntriesForProject(entries: IssueLinkEntry[], project: string | null | undefined): IssueLinkEntry[] {
  if (!project) return [];
  return entries.filter((e) => e.project === project);
}

// WARDEN-1405 (slice 3 of roadmap WARDEN-1386): should THIS pane ask the server
// which project its foreground really belongs to? The manual-pane gap: a
// manual/tmux chat hardcodes a placeholder project ('local'/'manual' — the
// chats.js/server.js factories), so strict per-project scoping correctly finds
// no mapping for the MAJORITY of panes. The fix is to resolve the pane's REAL
// project (its docker-exec container, parsed with the product's own
// container→project parse) — but only for the panes where the answer can change
// the outcome, which is exactly this gate:
//
//   enabled                — the integration toggle (off → no request ever)
//   && entries.length > 0  — no mappings configured → nothing could linkify anyway
//   && chat && !chat.container — yatfa/container panes never ask: their project
//                            already IS the container parse (zero requests)
//   && issueEntriesForProject(...) is empty — the pane's own project is unmapped
//                            (the placeholder situation; a mapped pane needs no
//                            fallback)
//
// Pure and unit-tested (web/issue-links.test.mjs); PaneTile consumes it as the
// one-shot fetch gate feeding resolvedProjectRef.
export function shouldResolvePaneProject(
  chat: { container?: string | null; project?: string | null } | null | undefined,
  enabled: boolean,
  entries: IssueLinkEntry[],
): boolean {
  return !!enabled
    && entries.length > 0
    && !!chat
    && !chat.container
    && issueEntriesForProject(entries, chat.project).length === 0;
}

// WARDEN-1413 (slice 4 of roadmap WARDEN-1386): THE pane's issue-entry scope in
// one home, so the pane-header project label can never drift from what a click
// actually opens. The same two-leg per-ENTRY selection the linkifier has run
// since WARDEN-1405 — the pane's OWN project's entry first, else the one-shot
// /api/pane-project resolved project's entry — deliberately per-ENTRY
// ([0] ?? [0]), never a `??` on the project string: the manual-pane placeholders
// ('manual'/'local') are truthy, so a string-level fallback could never fire.
// An empty/unknown project yields [] inside issueEntriesForProject, so null /
// undefined / placeholder projects need no special-casing here. Honest silence
// by construction: null when neither leg has a mapping, exactly the panes where
// keys do not linkify (the header chip consumes this and stays label-less
// there). Pure and unit-tested; consumers are PaneTile's link-provider scope
// line (the expression this replaced, byte-identical) and the gated header chip.
export function paneIssueEntryFor(
  entries: IssueLinkEntry[],
  project: string | null | undefined,
  resolvedProject: string | null | undefined,
): IssueLinkEntry | null {
  if (!entries.length) return null;
  return issueEntriesForProject(entries, project)[0]
    ?? issueEntriesForProject(entries, resolvedProject)[0]
    ?? null;
}

// The URL a modifier-click opens: the key appended to the configured tracker
// base. One shape — `https://<tracker>/<KEY>` — by design (see module header):
// the tracker carries the path, the key rides at the end. `issueTrackerUrl` is
// only reached with a sanitized entry, but a scheme-less tracker is enforced
// again here so the https prefix can never double up.
export function issueTrackerUrl(entry: IssueLinkEntry, key: string): string {
  const base = entry.tracker.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${base}/${key}`;
}

// Markdown-surface scoping (WARDEN-1394, slice 2 of roadmap WARDEN-1386): the
// entries whose PREFIX is unique across the whole configured set. Markdown
// message bodies (observer messages, directive text, transcript messages) are
// fleet-level surfaces — an agent working in ANY project may legitimately
// cross-reference another project's tickets, and the prefix→tracker mapping is
// human-stated configuration rather than something inferred from the key text,
// so consulting every configured entry on these surfaces is not inference. The
// one ambiguity that stays unresolved: where the SAME prefix is mapped under
// TWO projects (e.g. `WARDEN` for both `warden` and `acme`), markdown surfaces
// link that prefix NOWHERE — ambiguity is honest silence, never a guess at
// which tracker the author meant. Strict per-project scoping stays the
// terminal's contract (issueEntriesForProject — untouched).
export function unambiguousPrefixEntries(entries: IssueLinkEntry[]): IssueLinkEntry[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.prefix, (counts.get(e.prefix) ?? 0) + 1);
  return entries.filter((e) => counts.get(e.prefix) === 1);
}

// Find every configured-prefix issue key on a single terminal line (already
// right-trimmed via IBufferLine.translateToString — this function trims
// defensively itself, and only whole tokens ever match, so indices into the
// original line survive the trailing-whitespace trim). `entries` are the
// CALLER-SCOPED mappings for THIS pane's project (issueEntriesForProject) —
// possibly several prefixes for one project, never another project's. Pure and
// side-effect-free; PaneTile maps each candidate's start/length to an xterm
// range and links it with construction-time decorations.
//
// Matching is structural, not regex-from-config (the entries arrive over the
// wire, so building a RegExp from them would be an injection surface): each
// token is split at its FIRST `-`, the head must EQUAL a configured prefix, and
// the tail must be all digits. A hyphen in a prefix can never occur (the
// sanitizer forbids it), so the first hyphen is always the prefix/key boundary.
export function findIssueCandidates(line: string, entries: IssueLinkEntry[], opts?: IssueScanOptions): IssueCandidate[] {
  if (!entries.length) return [];
  const byPrefix = new Map(entries.map((e) => [e.prefix, e]));
  const out: IssueCandidate[] = [];
  const text = line.replace(/\s+$/, '');
  let i = 0;
  while (i < text.length) {
    // Token = maximal run of non-whitespace.
    if (/\s/.test(text[i])) { i += 1; continue; }
    let end = i;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    // Trim surrounding punctuation to the key core; the trim set contains no
    // whitespace, hyphen, or digit, so a trimmed core can never be empty on an
    // issue-shaped token and start/length stay inside the original line.
    let start = i;
    while (start < end && TRIM_CHARS.has(text[start])) start += 1;
    let tokenEnd = end;
    while (tokenEnd > start && TRIM_CHARS.has(text[tokenEnd - 1])) tokenEnd -= 1;
    const core = text.slice(start, tokenEnd);
    const hyphen = core.indexOf('-');
    if (hyphen > 0 && hyphen < core.length - 1 && byPrefix.has(core.slice(0, hyphen))) {
      const tail = core.slice(hyphen + 1);
      if (DIGITS_RE.test(tail)) {
        // Wrap-truncation guard, mirroring the URL matcher: a key touching
        // end-of-line with the next buffer line continuing this one may be
        // missing its tail digits — don't link the truncated prefix.
        if (!(opts?.wrappedAtEol && tokenEnd === text.length)) {
          out.push({ start, length: core.length, key: core });
        }
      }
    }
    i = end;
  }
  return out;
}
