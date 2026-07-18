// Pure helpers for the Claude Code session layer — JSONL parsing (head + token
// usage), local/remote session enumeration, the read-only transcript viewer
// (byte-windowed paging + message mapping), and the cross-host merge/paginate +
// token rollup. Extracted from the routes in server.js (WARDEN-677) so this logic
// is unit-testable without booting the Express app (server.js runs `load()` at
// module load, which reads ~/.yatfa-warden and starts the server) — mirrors
// src/git.js (the log/show/diff/blame parsers extracted for the same reason) and
// the chats.js / gitStatus.js extractions.
//
// Side-effect-free at module load: the only project import is `run` from
// ./ssh.js, which has no top-level statements, so importing this module boots
// nothing. (WARDEN-606.)
//
// NOTE: the full-content session-SEARCH helpers (searchLocalClaudeSessions,
// buildSessionSearchScript, remoteSearchClaudeSessions + the SESSION_SEARCH_*
// caps) remain in server.js. They depend on the shared workspace-search
// infrastructure (streamBoundedSearch / parseSearchOutput) that also backs
// /api/search-files; pulling that infra into a leaf session module would invert
// the dependency (server.js importing general search utilities back from here).
// server.js imports parseJsonlHead + snippetFromLine from this module for those
// helpers, keeping the dependency one-directional.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { run } from './ssh.js';

// ---- Claude Code session list (for the per-host "resume" list) ----
// Exported (not just module-local) because server.js's session-search helpers
// (which stay there — see NOTE above) reuse it to derive cwd/summary.
export function parseJsonlHead(text) {
  let cwd = '';
  let summary = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!cwd && j.cwd) cwd = j.cwd;
    if (!summary && j.type === 'user' && j.message) {
      const c = j.message.content;
      const txt = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((b) => b && b.type === 'text')?.text || '') : '');
      summary = txt.replace(/\s+/g, ' ').trim().slice(0, 100);
    }
    if (cwd && summary) break;
  }
  return { cwd, summary };
}

// Sum every assistant turn's `message.usage` token fields across a session's
// FULL JSONL body → { input, output, cacheCreation, cacheRead, total } where
// total = input+output+cacheCreation+cacheRead. Mirrors parseJsonlHead's lenient
// contract: malformed lines, missing/empty usage, and non-message records are
// skipped (never throws). Returns null when the body has no real usage (no
// usage objects, or all of them zero) so a row renders without a token badge
// instead of a misleading "0 tok" — this also keeps the LOCAL full-file path
// byte-for-byte consistent with the REMOTE grep+awk extractor (which sums to
// empty → null for the same all-zero case). (WARDEN-367.)
export function parseJsonlTokenUsage(text) {
  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const u = j?.message?.usage;
    if (!u || typeof u !== 'object') continue;
    input += tok(u.input_tokens);
    output += tok(u.output_tokens);
    cacheCreation += tok(u.cache_creation_input_tokens);
    cacheRead += tok(u.cache_read_input_tokens);
  }
  const total = input + output + cacheCreation + cacheRead;
  return total > 0 ? { input, output, cacheCreation, cacheRead, total } : null;
}

// Coerce one usage field to a non-negative integer, defending against a stray
// string/null without ever throwing. Real fields are JSON numbers; absent values
// (undefined) contribute 0. Token counts are whole units — Math.trunc guards a
// malformed float (none observed in real files, but the contract is "never throw").
function tok(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

// ---- full-content session-search helpers (WARDEN-161) ----
// parseJsonlHead only extracts cwd + the first user message (the 100-char
// "summary"). These helpers search the WHOLE conversation body so a session is
// findable by what was actually discussed — not just its first line.

// Pull the human-meaningful text out of one JSONL message line: the joined text
// blocks of a user/assistant `message.content`. Returns null for anything else
// (tool_result blobs, summary records, malformed JSON) so the caller can fall
// back to a raw snippet instead of rendering a wall of base64/JSON.
export function extractMessageText(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  const c = j && j.message && j.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const texts = c.filter((b) => b && b.type === 'text').map((b) => b.text || '');
    if (texts.length) return texts.join(' ');
  }
  return null;
}

// Build a bounded, whitespace-collapsed snippet centered on the first occurrence
// of `needleLower` (already lowercased) within `line`. Prefers the extracted
// message text when it contains the needle, so snippets read like conversation
// ("we debugged the SSH pool") rather than raw JSON. Returns '' if the line has
// no occurrence of the needle (e.g. this is a truncated/bounded fragment).
export function snippetFromLine(line, needleLower, maxLen = 180) {
  if (!needleLower) return '';
  const human = extractMessageText(line);
  const source = human && human.toLowerCase().includes(needleLower) ? human : line;
  const idx = source.toLowerCase().indexOf(needleLower);
  if (idx === -1) return '';
  const half = Math.max(24, Math.floor((maxLen - needleLower.length) / 2));
  const start = Math.max(0, idx - half);
  return source.slice(start, start + maxLen).replace(/\s+/g, ' ').trim();
}

// Enumerate ~/.claude/projects/*/*.jsonl, most-recent-first. Shared by the
// top-40 list (localClaudeSessions) and full-content search so they walk the
// same archive layout. Returns [] if the projects dir is absent.
function collectLocalSessionFiles() {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  try {
    for (const proj of fs.readdirSync(dir)) {
      const pdir = path.join(dir, proj);
      try { if (!fs.statSync(pdir).isDirectory()) continue; } catch { continue; }
      for (const f of fs.readdirSync(pdir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pdir, f);
        try { files.push({ id: f.slice(0, -6), file: fp, mtime: fs.statSync(fp).mtimeMs }); } catch { /* noop */ }
      }
    }
  } catch { return []; }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// `limit` bounds the returned list (most-recent first). Defaults to 40 to keep
// `/api/claude-sessions` (the single-host resume list) unchanged; the unified
// "All Sessions" endpoint passes a larger window for pagination (WARDEN-176).
export function localClaudeSessions(limit = 40) {
  return collectLocalSessionFiles().slice(0, limit).map((f) => {
    let cwd = '';
    let summary = '';
    let tokenUsage = null;
    try {
      // Full-file read: token usage lives on EVERY assistant turn across the
      // whole transcript, so the 8KB head window that sufficed for cwd/summary
      // can't see it. Reads are sequential (one file in memory at a time), so
      // peak memory stays bounded by the largest single transcript — not the
      // whole archive. cwd/summary + tokens are derived from the SAME body so
      // the file is read once. (WARDEN-367.)
      const body = fs.readFileSync(f.file, 'utf8');
      ({ cwd, summary } = parseJsonlHead(body));
      tokenUsage = parseJsonlTokenUsage(body);
    } catch { /* noop */ }
    return { id: f.id, cwd, summary, mtime: f.mtime, tokenUsage };
  }).filter((s) => s.cwd);
}
// `limit` bounds the returned list (most-recent first). Defaults to 40 so
// `/api/claude-sessions` is unchanged; the "All Sessions" endpoint passes a
// larger window for pagination (WARDEN-176). The remote script already walks
// every file and transfers each head, so the per-request SSH cost is the same
// regardless of limit — only the in-Node slice changes.
export async function remoteClaudeSessions(host, limit = 40) {
  // Token usage lives on EVERY assistant turn across the WHOLE file. Computing it
  // needs the full transcript, but we only ever transfer cwd/summary (the 6KB
  // head) + four summed ints per file. So the totals are computed ON-HOST with a
  // portable grep+awk pipeline (no jq/node assumed — remote hosts run docker+
  // tmux+claude), and only the four ints ride the ___S marker. Single SSH pass,
  // same shape as before, just an enriched header line. An all-zero / no-usage
  // file prints nothing → tokenUsage null (matches the local path). (WARDEN-367.)
  const script = `for f in ~/.claude/projects/*/*.jsonl; do
[ -f "$f" ] || continue
id=$(basename "$f" .jsonl)
mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
tu=$(grep -oE '"(input_tokens|output_tokens|cache_creation_input_tokens|cache_read_input_tokens)"[[:space:]]*:[[:space:]]*[0-9]+' "$f" 2>/dev/null | awk '
/^"cache_creation_input_tokens"/ { if (match($0,/[0-9]+$/)) cc += substr($0,RSTART,RLENGTH) }
/^"cache_read_input_tokens"/     { if (match($0,/[0-9]+$/)) cr += substr($0,RSTART,RLENGTH) }
/^"input_tokens"/                { if (match($0,/[0-9]+$/)) inp += substr($0,RSTART,RLENGTH) }
/^"output_tokens"/               { if (match($0,/[0-9]+$/)) out += substr($0,RSTART,RLENGTH) }
END { if (inp||out||cc||cr) printf "%d\\t%d\\t%d\\t%d", inp, out, cc, cr }')
if [ -n "$tu" ]; then printf '___S\\t%s\\t%s\\t%s\\n' "$id" "$mt" "$tu"; else printf '___S\\t%s\\t%s\\n' "$id" "$mt"; fi
head -c 6000 "$f"
printf '\\n___E\\t%s\\n' "$id"
done`;
  const res = await run(host, script, { timeout: 15000 });
  if (!res.ok) return [];
  const out = [];
  let cur = null;
  const buf = [];
  for (const line of res.stdout.split('\n')) {
    // ___S now optionally carries four tab-separated token ints after the
    // mtime: ___S  id  mt  input  output  cacheCreation  cacheRead. The token
    // group is optional so a no-usage file (or a pre-token-format archive)
    // degrades to tokenUsage null — never a parse failure.
    const sm = line.match(/^___S\t(\S+)\t(\d+)(?:\t(\d+)\t(\d+)\t(\d+)\t(\d+))?/);
    if (sm) {
      cur = { id: sm[1], mtime: Number(sm[2]) * 1000 };
      if (sm[3] != null && sm[4] != null && sm[5] != null && sm[6] != null) {
        const i = +sm[3], o = +sm[4], cc = +sm[5], cr = +sm[6];
        cur.tokenUsage = { input: i, output: o, cacheCreation: cc, cacheRead: cr, total: i + o + cc + cr };
      } else {
        cur.tokenUsage = null;
      }
      buf.length = 0;
      continue;
    }
    if (/^___E\t/.test(line)) {
      if (cur) {
        const { cwd, summary } = parseJsonlHead(buf.join('\n'));
        if (cwd) out.push({ id: cur.id, cwd, summary, mtime: cur.mtime, tokenUsage: cur.tokenUsage ?? null });
      }
      cur = null;
      continue;
    }
    if (cur) buf.push(line);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

// ---- read-only transcript view (WARDEN-233) ----
// Caps for the read-only single-session viewer. A huge transcript must not blow
// up the UI or the remote SSH transfer. SESSION_VIEW_MAX_BYTES bounds the body
// transfer (a `tail -c` window remotely / a tail read locally); the head window
// for cwd is the same 8KB the list endpoints already read. SESSION_VIEW_MAX_MESSAGES
// is a secondary message-count cap (most-recent kept) so a transcript of many
// short messages stays bounded too.
const SESSION_VIEW_MAX_BYTES = 400_000;
const SESSION_VIEW_MAX_MESSAGES = 500;

// ---- read-only transcript view (WARDEN-233) ----
// The full-content search above finds sessions; this makes any ONE past session
// fully readable WITHOUT resuming it (no live `claude` process, no tmux, no
// catalog entry). Same JSONL archive + the same extractMessageText primitive; the
// difference is we map EVERY line into a {role, text, ts} message and bound the
// result instead of returning one snippet.

// Map one JSONL line into a transcript message {role, text, ts, usage?} for the
// read-only viewer, reusing extractMessageText's human-text extraction + null-skip
// semantics (tool_result blobs, summary records, malformed JSON → null → skipped).
// Adds the role + timestamp extractMessageText doesn't surface, plus an optional
// per-turn token `usage` (WARDEN-474) when the line carries message.usage. Exported
// so the message mapping is unit-testable like extractMessageText.
export function extractTranscriptMessage(line) {
  const text = extractMessageText(line);
  // null = not a renderable message (tool_result/summary/malformed); an empty
  // string (a text block with no text, e.g. beside tool_use blocks) would render
  // a stray empty bubble, so skip it too.
  if (!text || !text.trim()) return null;
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  const role = (j && j.message && j.message.role) || (j && j.type) || 'unknown';
  // Per-turn token attribution (WARDEN-474): when this line carries message.usage,
  // surface it with the SAME tok() coercion parseJsonlTokenUsage uses, so a per-turn
  // total is methodologically identical to the session-total badge (WARDEN-367).
  // Only a turn that actually spent tokens (total > 0) attaches a usage object —
  // mirroring parseJsonlTokenUsage's null-for-zero contract — so a user/tool row
  // (no message.usage) and an all-zero turn render no token chip (graceful empty,
  // same contract as formatTokens). The key is ABSENT (not undefined-valued) when
  // there is no usage, so the object stays {role, text, ts} for every non-spend turn.
  const msg = { role, text, ts: (j && j.timestamp) || '' };
  const u = j && j.message && j.message.usage;
  if (u && typeof u === 'object') {
    const input = tok(u.input_tokens);
    const output = tok(u.output_tokens);
    const cacheCreation = tok(u.cache_creation_input_tokens);
    const cacheRead = tok(u.cache_read_input_tokens);
    const total = input + output + cacheCreation + cacheRead;
    if (total > 0) msg.usage = { input, output, cacheCreation, cacheRead, total };
  }
  return msg;
}

// Build the bounded {cwd, messages, truncated} view from a head window (for cwd,
// via parseJsonlHead) and a body window (for the message list, via
// extractTranscriptMessage per line). Pure + exported so the bounding/tail logic
// is unit-testable without disk or SSH. `truncated` is true when the message count
// exceeded the cap (the oldest messages were dropped to keep the most recent).
//
// The 500-message cap is applied PER BODY WINDOW — a safety net for pathological
// tiny-message files (e.g. a 400KB window of 1-line turns). For the common
// large-transcript case the 400KB byte cap binds first, so this cap rarely fires;
// when it does fire WITHIN a single page it is a known residual (≤ the oldest few
// messages of that one window are dropped), accepted because encoding both a byte
// cursor AND a message index would over-complicate the paging contract. The byte
// paging in transcriptWindow fully solves the common case.
export function buildTranscriptView(headText, bodyText) {
  const cwd = parseJsonlHead(headText || '').cwd;
  const messages = [];
  for (const line of (bodyText || '').split('\n')) {
    if (!line.trim()) continue;
    const msg = extractTranscriptMessage(line);
    if (msg) messages.push(msg);
  }
  let truncated = false;
  if (messages.length > SESSION_VIEW_MAX_MESSAGES) {
    truncated = true;
    // Keep the most recent (tail) — the head of the body window is the oldest.
    messages.splice(0, messages.length - SESSION_VIEW_MAX_MESSAGES);
  }
  return { cwd, messages, truncated };
}

// Compute the bounded byte window for ONE transcript page (WARDEN-510). `size` is
// the JSONL file size in bytes; `before` is the END byte offset of the desired
// window — the cursor a prior page returned — or null for the FIRST (most-recent)
// page. Each window is a contiguous byte range [start, end] of the file, at most
// SESSION_VIEW_MAX_BYTES wide, so no page reads more than ~400KB into Node or
// transfers more than ~400KB over SSH (the same invariant the single-window tail
// read already upholds). A byte-offset cursor is used (NOT a timestamp) because
// extractTranscriptMessage frequently yields ts:'' and timestamps are never
// guaranteed unique — a byte offset is exact and maps cleanly to both transports.
//
// Returns { start, end, prevCursor, hasMore }: prevCursor is the START of this
// window (pass it as `before` to fetch the next-older window), and hasMore is true
// while that older window would be non-empty (start > 0) — i.e. until the true
// start of the transcript is reached, at which point the "Load earlier" control
// disappears. Pure + exported so the cursor math is unit-testable without disk/SSH.
export function transcriptWindow(size, before) {
  // Clamp `before` to the file size so a stale cursor (file shrank between pages)
  // degrades to the tail window instead of reading past EOF.
  const end = before == null ? size : Math.min(before, size);
  const start = Math.max(0, end - SESSION_VIEW_MAX_BYTES);
  return { start, end, prevCursor: start, hasMore: start > 0 };
}

// Resolve a local session JSONL by id across every project dir (the session id IS
// the basename; ids are unique per file). Returns the absolute path or null.
function findLocalSessionFile(id) {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const proj of fs.readdirSync(dir)) {
      const fp = path.join(dir, proj, `${id}.jsonl`);
      try { if (fs.statSync(fp).isFile()) return fp; } catch { /* not in this project dir */ }
    }
  } catch { /* no projects dir */ }
  return null;
}

// Read ONE local session into the bounded transcript view. Reads a head window
// (8KB) for cwd and a body window for the message list — never the whole file, so
// a giant transcript stays cheap. Returns {notFound} when the id matches no local
// file. With `opts.before` (a byte-offset cursor from a prior page's prevCursor)
// it reads the OLDER window [start, before] instead of the tail and SKIPS the head
// read (cwd is only needed on the first page — the caller already has it). The
// response carries prevCursor/hasMore so the caller can page further back.
export function readLocalSessionTranscript(id, opts = {}) {
  const before = opts.before;
  const file = findLocalSessionFile(id);
  if (!file) return { notFound: true };
  let headText = '';
  let bodyText = '';
  let win = { start: 0, end: 0, prevCursor: 0, hasMore: false };
  // byteTruncated is a FIRST-PAGE signal only (file exceeds the body cap) — the
  // banner + token qualifier depend on it. Older pages are bounded to the cap by
  // construction, so their `truncated` reflects only the within-window message cap.
  let byteTruncated = false;
  try {
    const size = fs.statSync(file).size;
    win = transcriptWindow(size, before);
    if (before == null) byteTruncated = size > SESSION_VIEW_MAX_BYTES;
    const fd = fs.openSync(file, 'r');
    try {
      // Head window (8KB) for cwd — only on the first page. The same head read
      // localClaudeSessions uses; skipped on older pages (cwd already known).
      if (before == null) {
        const hlen = Math.min(size, 8192);
        const hbuf = Buffer.alloc(hlen);
        fs.readSync(fd, hbuf, 0, hlen, 0);
        headText = hbuf.toString('utf8');
      }
      // Body window [start, end] for this page — bounded, never the whole file.
      const blen = Math.max(0, win.end - win.start);
      if (blen > 0) {
        const bbuf = Buffer.alloc(blen);
        fs.readSync(fd, bbuf, 0, blen, win.start);
        bodyText = bbuf.toString('utf8');
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* noop — empty windows yield an empty message list */ }
  const view = buildTranscriptView(headText, bodyText);
  if (byteTruncated) view.truncated = true;
  view.prevCursor = win.prevCursor;
  view.hasMore = win.hasMore;
  return view;
}

// Remote (SSH) twin of readLocalSessionTranscript. ONE SSH call resolves the
// (unique) file by its id basename, emits a size line, a head window (for cwd),
// and a bounded body window — delimited so the server can split them. `___NOSESSION`
// (and a zero exit) when the id matches no remote file. Exported so the shell
// surface + shape is unit-testable like buildSessionSearchScript. `id` is validated
// /^[\w-]+$/ at the endpoint, so it has no shell metacharacters.
//
// With `opts.before` (a byte-offset cursor from a prior page) it emits a RANGED
// body read of the older window [start, before] in the SAME single invocation —
// no head read (cwd is only needed on the first page) and still ONE SSH call per
// page (the proposal's hard remote-cost requirement; no per-message round-trips).
// `tail -c +N` is 1-indexed (byte N onward), so +1 maps the 0-indexed start; the
// concrete numbers are computed here (not in shell) so only validated integers are
// embedded. `before`/`start`/`window` are server-computed numbers, so no injection
// surface is added beyond the already-validated id.
export function buildSessionReadScript(id, opts = {}) {
  const before = opts.before;
  // Older page: ranged body read, no head window.
  if (before != null) {
    const start = Math.max(0, before - SESSION_VIEW_MAX_BYTES);
    const window = Math.max(0, before - start);
    return [
      `set -- ~/.claude/projects/*/${id}.jsonl`,
      'if [ -f "$1" ]; then',
      '  sz=$(stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null)',
      "  printf '___SZ\\t%s\\n' \"$sz\"",
      `  printf '\\n___BODY\\n'; tail -c +${start + 1} "$1" | head -c ${window}`,
      'else',
      "  printf '___NOSESSION\\n'",
      'fi',
    ].join('\n');
  }
  // First page: head window (cwd) + tail window (most-recent body).
  return [
    `set -- ~/.claude/projects/*/${id}.jsonl`,
    'if [ -f "$1" ]; then',
    '  sz=$(stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null)',
    "  printf '___SZ\\t%s\\n' \"$sz\"",
    "  printf '___HEAD\\n'; head -c 8192 \"$1\"",
    `  printf '\\n___BODY\\n'; tail -c ${SESSION_VIEW_MAX_BYTES} "$1"`,
    'else',
    "  printf '___NOSESSION\\n'",
    'fi',
  ].join('\n');
}

// Parse the remote read script's delimited output into {cwd, messages, truncated,
// prevCursor, hasMore} (or {notFound}). Splits the head/body windows on the
// ___HEAD/___BODY markers, reads the byte size from ___SZ to compute the page's
// cursor via transcriptWindow (and flag byte-truncation on the first page), and
// detects the ___NOSESSION not-found marker. Pure + exported so the remote parsing
// is unit-testable without SSH (the found branch never emits ___NOSESSION, and the
// not-found branch emits ONLY it, so the marker is unambiguous — same trust model
// the search endpoint uses for ___SNIP).
//
// `opts.before` (the cursor this remote read used) flows through to transcriptWindow
// so prevCursor/hasMore reflect the right page. An older-page script emits NO
// ___HEAD marker (cwd is first-page-only), so the body is taken as everything after
// ___BODY and the head stays empty.
export function parseSessionReadOutput(stdout, opts = {}) {
  if (stdout.startsWith('___NOSESSION')) return { notFound: true };
  const HEAD = '___HEAD\n';
  const BODY = '___BODY\n';
  const headIdx = stdout.indexOf(HEAD);
  const bodyIdx = stdout.indexOf(BODY);
  let headText = '';
  let bodyText = stdout;
  if (bodyIdx !== -1) {
    // First page has both markers (head before body); an older page has only
    // ___BODY. Take the head slice only when ___HEAD is present AND precedes the
    // body, else leave it empty.
    if (headIdx !== -1 && headIdx < bodyIdx) {
      headText = stdout.slice(headIdx + HEAD.length, bodyIdx);
    }
    bodyText = stdout.slice(bodyIdx + BODY.length);
  }
  const before = opts.before;
  const szm = stdout.match(/^___SZ\t(\d+)/);
  const size = szm ? Number(szm[1]) : 0;
  const win = transcriptWindow(size, before);
  // First page only: flag byte-truncation when the file exceeds the body cap. Older
  // pages are bounded by construction; their `truncated` reflects only the
  // within-window message cap (buildTranscriptView).
  const byteTruncated = before == null && size > SESSION_VIEW_MAX_BYTES;
  const view = buildTranscriptView(headText, bodyText);
  if (byteTruncated) view.truncated = true;
  view.prevCursor = win.prevCursor;
  view.hasMore = win.hasMore;
  return view;
}

// Merge per-host session buckets into ONE globally-sorted, paginated list for the
// unified "All Sessions" view. Pure + exported so the cross-host interleaving and
// offset/limit math is unit-testable without SSH (WARDEN-176). `buckets` is a list
// of { host, sessions } where each host's sessions are already most-recent-first.
// Returns { sessions, hasMore } for the requested [offset, offset+limit) page.
//
// hasMore is honest ONLY when each bucket already carries the global top
// (offset+limit+1) of its host: a session at global rank k has host-rank ≤ k, so
// the (offset+limit)-th global item (the "is there a next page?" sentinel) is
// guaranteed present iff every host contributed at least offset+limit+1 rows. The
// endpoint computes that per-host window (perHost) before calling this.
export function mergeAndPaginateSessions(buckets, offset, limit) {
  const all = buckets.flatMap(({ host, sessions }) => sessions.map((s) => ({ ...s, host })));
  all.sort((a, b) => b.mtime - a.mtime);
  const sessions = all.slice(offset, offset + limit);
  // Per-host + grand token totals over the RETURNED window (this page), not every
  // fetched row. Sessions with no usage (tokenUsage null) contribute nothing.
  // Folded in here (pure + unit-tested) so the endpoint just stamps it on the
  // response. (WARDEN-367.)
  return { sessions, hasMore: all.length > offset + limit, totals: computeSessionTotals(sessions) };
}

// Sum a list of sessions' tokenUsage into a grand total + per-host breakdown.
// Sessions without usage (tokenUsage null) are skipped. The aggregate shape
// matches a single tokenUsage object so a "0-everywhere" fleet renders the same
// way as a session's own usage. Pure + exported so the rollup is unit-testable
// without SSH. (WARDEN-367.)
export function computeSessionTotals(sessions) {
  const byHost = {};
  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0;
  for (const s of sessions) {
    const u = s && s.tokenUsage;
    if (!u) continue;
    input += u.input || 0;
    output += u.output || 0;
    cacheCreation += u.cacheCreation || 0;
    cacheRead += u.cacheRead || 0;
    const h = s.host || 'unknown';
    const b = byHost[h] || (byHost[h] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 });
    b.input += u.input || 0;
    b.output += u.output || 0;
    b.cacheCreation += u.cacheCreation || 0;
    b.cacheRead += u.cacheRead || 0;
    b.total = b.input + b.output + b.cacheCreation + b.cacheRead;
  }
  return {
    grand: { input, output, cacheCreation, cacheRead, total: input + output + cacheCreation + cacheRead },
    byHost,
  };
}
