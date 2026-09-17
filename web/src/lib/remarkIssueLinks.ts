// remark plugin that linkifies issue keys inside markdown (WARDEN-1394, slice 2
// of roadmap WARDEN-1386) — the markdown sibling of WARDEN-1388's terminal
// linkifier, and a pure mdast transformer so it is unit-testable directly under
// the OXC harness (web/issue-links-md.test.mjs).
//
// THE MATCHER IS BORROWED, NOT REIMPLEMENTED. Every candidate comes from
// `findIssueCandidates` (issue-links.ts) — the exact function the terminal pane
// runs — so whole-token anchoring, configured-prefix-only matching, the
// punctuation TRIM set, and the key shape (prefix-digits at the first hyphen)
// cannot drift between terminal and markdown. On top of it this module adds
// only what markdown structure requires:
//
//   1. mdast WALKING. Text nodes are rewritten into [text, link, text, …]
//      sequences; inline code spans become links ONLY when their whole value is
//      exactly one key (the markdown mirror of the terminal's backtick
//      TRIM_CHARS handling — agents conventionally write keys in backticks, and
//      `` `WARDEN-1385` `` must linkify in a message body just as it does in a
//      pane). Fenced code blocks carry literal `value`, not text children, so
//      they are never touched; `link`/`linkReference` subtrees are skipped so
//      text inside an EXISTING markdown link is never re-linkified.
//   2. PREFIX→ENTRY RESOLUTION. `findIssueCandidates` reports start/length/key
//      but not which configured entry matched, so this module keeps its own
//      prefix map for URL building (issueTrackerUrl — the shared builder, same
//      `https://<tracker>/<KEY>` shape as the terminal). On the markdown path
//      the caller (unambiguousPrefixEntries) has already dropped ambiguous
//      prefixes, so each prefix resolves to exactly one entry; a lookup miss is
//      defensively treated as "no link" rather than guessed at.
//   3. THE MARKER. Every minted link carries `data-issue-link` via
//      `data.hProperties`, which survives remark-rehype into the hast node's
//      properties — the shared `a:` renderer in MarkdownBody reads that marker
//      to route ONLY plugin-minted links onto the openExternalUrl click
//      contract. A hand-written markdown link to the same tracker URL never
//      carries it and renders exactly as before.
//
// OFF BY DEFAULT is structural: the caller passes entries only when the
// integration is enabled, and an empty entry list makes findIssueCandidates a
// no-op — with the plugin unregistered (every current default caller) the
// rendered markdown is byte-identical to before this module existed.

import type { InlineCode, Link, Nodes, PhrasingContent, Root, Text } from 'mdast';
import type { IssueCandidate, IssueLinkEntry } from './issue-links';
import { findIssueCandidates, issueTrackerUrl } from './issue-links';

// The data attribute that marks a link as plugin-minted. Read by MarkdownBody's
// `a:` renderer (WARDEN-1394) — one constant, two modules, so the contract
// cannot drift. The value is the recognized key, which shows up in the DOM as
// `data-issue-link="WARDEN-1385"` (debuggability only; routing checks presence).
export const ISSUE_LINK_MARKER = 'data-issue-link';

// Subtrees this transformer never enters. Each with its reason:
// - `link` / `linkReference`: text inside an EXISTING markdown link must stay
//   un-linkified (nesting an <a> inside an <a> is invalid HTML and the author
//   already chose the destination).
// - `code` (fenced block): literal content — never linkified, matching the
//   terminal where the whole line is literal text until the matcher runs.
// - `inlineMath` / `math`: literal TeX, not prose.
// - `definition` / `image` / `imageReference` / `html` / `yaml` / `toml`:
//   carry raw string `value`s (or urls) that never render as phrasing text.
const SKIP_TYPES = new Set([
  'link', 'linkReference', 'code', 'inlineMath', 'math',
  'definition', 'image', 'imageReference', 'html', 'yaml', 'toml',
]);

// Build the link node for one candidate. `child` is passed only by the
// inline-code path (the original inlineCode node, preserved so the code styling
// stays inside the anchor); the text path mints a plain text child.
function issueLinkNode(
  byPrefix: Map<string, IssueLinkEntry>,
  candidate: IssueCandidate,
  child?: InlineCode,
): Link | null {
  const hyphen = candidate.key.indexOf('-');
  // The matcher guarantees the shape (prefix before the first hyphen, digits
  // after), so byPrefix always resolves — but a miss returns null and the
  // callers keep the original node rather than minting a dead link.
  const entry = hyphen > 0 ? byPrefix.get(candidate.key.slice(0, hyphen)) : undefined;
  if (!entry) return null;
  return {
    type: 'link',
    url: issueTrackerUrl(entry, candidate.key),
    title: null,
    children: child ? [child] : [{ type: 'text', value: candidate.key }],
    data: { hProperties: { [ISSUE_LINK_MARKER]: candidate.key } },
  };
}

// Rewrite one text node into the [text, link, text, …] run the candidates imply.
// Candidates from findIssueCandidates are left-to-right and disjoint (one per
// whitespace token), so a single cursor pass never overlaps or reorders.
function linkifyText(node: Text, entries: IssueLinkEntry[], byPrefix: Map<string, IssueLinkEntry>): PhrasingContent[] {
  const candidates = findIssueCandidates(node.value, entries);
  if (candidates.length === 0) return [node];
  const out: PhrasingContent[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start > cursor) {
      out.push({ type: 'text', value: node.value.slice(cursor, candidate.start) });
    }
    const link = issueLinkNode(byPrefix, candidate);
    if (link) out.push(link);
    else out.push({ type: 'text', value: node.value.slice(candidate.start, candidate.start + candidate.length) });
    cursor = candidate.start + candidate.length;
  }
  if (cursor < node.value.length) {
    out.push({ type: 'text', value: node.value.slice(cursor) });
  }
  return out;
}

// An inline code span links ONLY when its entire value is exactly one key —
// the whole-span rule. `` `WARDEN-1385` `` (the conventional agent spelling)
// becomes an anchor wrapping the original inlineCode node; `` `see
// WARDEN-1385` ``, `` `WARDEN-1385.` `` and `` `WARDEN-1385 extra` `` stay
// literal code. (The trailing-period case stays literal here on purpose: the
// whole-span rule is stricter than prose trimming because inside code the
// period is plausibly significant; prose text still trims it via the shared
// matcher.)
function linkifyInlineCode(node: InlineCode, entries: IssueLinkEntry[], byPrefix: Map<string, IssueLinkEntry>): PhrasingContent[] {
  const candidates = findIssueCandidates(node.value, entries);
  const only = candidates.length === 1 ? candidates[0] : null;
  if (!only || only.start !== 0 || only.start + only.length !== node.value.length) return [node];
  const link = issueLinkNode(byPrefix, only, node);
  return link ? [link] : [node];
}

// Depth-first rewrite. Text/inlineCode nodes are replaced in their parent's
// children array; every other non-skipped parent is recursed into. mdast nodes
// are plain mutable objects (the same transform remark-gfm etc. perform), so
// the array splice is the standard shape for a unified transformer.
function walk(node: Nodes, entries: IssueLinkEntry[], byPrefix: Map<string, IssueLinkEntry>): void {
  if (SKIP_TYPES.has(node.type)) return;
  if (!('children' in node) || !Array.isArray(node.children)) return;
  const children = node.children as Nodes[];
  const next: Nodes[] = [];
  for (const child of children) {
    if (child.type === 'text') {
      next.push(...linkifyText(child, entries, byPrefix));
    } else if (child.type === 'inlineCode') {
      next.push(...linkifyInlineCode(child, entries, byPrefix));
    } else {
      walk(child, entries, byPrefix);
      next.push(child);
    }
  }
  (node as unknown as { children: Nodes[] }).children = next;
}

// The unified plugin: `use(remarkIssueLinks, entries)` shape — called with the
// configured entries, returns the tree transformer. Pure over the tree; no
// VFile use, no async.
export function remarkIssueLinks(entries: IssueLinkEntry[]) {
  // One prefix→entry resolution, built once at registration.
  const byPrefix = new Map(entries.map((e) => [e.prefix, e]));
  return (tree: Root) => {
    if (!entries.length) return;
    walk(tree, entries, byPrefix);
  };
}
