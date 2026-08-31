// Pure http(s) URL-token extraction for the in-terminal linkifier (WARDEN-1256).
//
// The sibling of path-links.ts (WARDEN-227's clickable file paths): this module
// decides which substrings of a terminal line are http/https URLs, so it can be
// unit-tested directly under the same OXC-transform harness (see
// web/url-links.test.mjs). Two differences from the path side are load-bearing:
//
//   1. NO async existence check. A path must be probed against the chat's cwd
//      before it earns an underline; a URL is valid by construction, so the
//      caller sets the link's decorations at construction time and the
//      affordance appears on the FIRST hover (the ticket's no-delay criterion).
//   2. URL recognition consults neither the filesystem nor SSH — behaviour is
//      identical for local and remote chats by design.
//
// The matcher deliberately takes precedence over the path matcher: maskUrls
// blanks out every recognized URL span (same-length spaces) so findPathCandidates
// can never fire inside one — in `See http://localhost:7421/api/foo.json` the
// fragment `7421/api/foo.json` must not survive as a path candidate.

export interface UrlCandidate {
  /** Index in the source line where the URL starts (the `h` of http/https). */
  start: number;
  /** Length of the URL as it should be linked (after trailing-punctuation trim). */
  length: number;
  /** The URL text — what the opener receives. */
  url: string;
}

export interface UrlScanOptions {
  /**
   * True when the NEXT terminal buffer line is a wrapped continuation of this
   * one (IBufferLine.isWrapped), i.e. this line's last token was split by the
   * terminal's line wrap. A URL that runs to end-of-line in that state is
   * genuinely truncated — its remainder lives on the next line — so it must NOT
   * become a link. Tokens ending mid-line are unaffected, and neighbours are
   * never affected: only candidates ending exactly at end-of-line are dropped.
   */
  wrappedAtEol?: boolean;
}

// Scheme finder: a word boundary before `http://` / `https://` (case-insensitive)
// so `xhttps://…` — the scheme glued to a word — is not linkified, while
// `(https://…` / `<https://…` / plain ` https://…` are. `\b` avoids a lookbehind
// (Safari <16.4 throws on those at regex-construction time).
const SCHEME_RE = /\bhttps?:\/\//gi;

// Characters commonly printed immediately after a URL that are sentence/bracket
// punctuation, never part of the URL itself. Trimmed from the match tail.
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '<', '>']);

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n += 1;
  return n;
}

// Trim sentence/bracket punctuation off the tail of a raw whitespace-delimited
// token, keeping balanced brackets: `(https://x.io/a_(b))` keeps both `)`s (they
// balance the opens INSIDE the url), while `see (https://x.io/a).` drops the
// trailing `).` because the `)` has no matching open. Mirrors the GFM autolink
// tail-trim algorithm.
function trimUrlEnd(token: string): string {
  let end = token.length;
  while (end > 0) {
    const ch = token[end - 1];
    if (TRAILING_PUNCT.has(ch)) { end -= 1; continue; }
    if (ch === ')' && countChar(token.slice(0, end), ')') > countChar(token.slice(0, end), '(')) { end -= 1; continue; }
    if (ch === ']' && countChar(token.slice(0, end), ']') > countChar(token.slice(0, end), '[')) { end -= 1; continue; }
    break;
  }
  return token.slice(0, end);
}

// Find every http(s) URL on a single terminal line (already right-trimmed via
// IBufferLine.translateToString — this function trims defensively itself; only
// trailing characters are removed, so indices into the original line survive).
// Pure and side-effect-free; PaneTile maps each candidate's start/length to an
// xterm range and links it with construction-time decorations.
export function findUrlCandidates(line: string, opts?: UrlScanOptions): UrlCandidate[] {
  const out: UrlCandidate[] = [];
  const text = line.replace(/\s+$/, '');
  // End of the previous candidate's span. A second scheme match can land INSIDE
  // an earlier candidate's token (e.g. `https://a.https://b` — the `.` before
  // the second scheme is a word boundary, and the first scan consumes to the
  // next whitespace, covering it). Such an inner match must be skipped or the
  // two candidates would overlap — one link, not two, and maskUrls stays sound.
  let lastEnd = -1;
  for (const m of text.matchAll(SCHEME_RE)) {
    const schemeStart = m.index ?? 0;
    if (schemeStart < lastEnd) continue;
    const scheme = m[0];
    // Consume to the next whitespace (a URL contains none). Other punctuation
    // stays — it is either part of the URL or trimmed off the tail below.
    let end = schemeStart;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    const url = trimUrlEnd(text.slice(schemeStart, end));
    // `https://` with nothing (non-trimmable) after it is not a link.
    if (url.length <= scheme.length) continue;
    // A URL split by the terminal's line wrap (it runs to end-of-line and the
    // next buffer line continues it) is truncated — don't link a prefix that
    // 404s. Only candidates touching end-of-line can be in this state.
    if (opts?.wrappedAtEol && schemeStart + url.length === text.length) continue;
    out.push({ start: schemeStart, length: url.length, url });
    lastEnd = schemeStart + url.length;
  }
  return out;
}

// Blank out every recognized http(s) URL span with same-length spaces. Indices
// of all other text are preserved, so running the PATH matcher over the masked
// line yields candidates whose ranges are valid against the ORIGINAL line — with
// the URL interiors structurally unreachable (the path regex cannot cross a
// space). This is how the URL matcher "consumes the whole URL" ahead of the
// path matcher. Wrap context is deliberately NOT applied here: every
// URL-SHAPED span is masked, so a wrap-split fragment's tail can't leak into
// the path candidates either.
export function maskUrls(line: string): string {
  const urls = findUrlCandidates(line);
  if (!urls.length) return line;
  // Build with string slices (NOT [...line] char arrays): spans are in UTF-16
  // code units, and a code-point spread would misalign on astral characters.
  let out = '';
  let last = 0;
  for (const u of urls) {
    out += line.slice(last, u.start) + ' '.repeat(u.length);
    last = u.start + u.length;
  }
  return out + line.slice(last);
}
