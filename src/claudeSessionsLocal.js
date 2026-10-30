// Local Claude Code session archive access + the shared JSONL primitives + the
// read-only transcript view: moved VERBATIM out of src/claudeSessions.js
// (WARDEN-2033). claudeSessions.js re-exports every public name so all its
// importers are unchanged; the dependency is strictly one-way (claudeSessions.js
// -> this leaf, no cycle). tok / collectLocalSessionFiles / findLocalSessionFile
// stay module-private (zero external callers across src/).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// fs.promises alias — the local session enumeration/transcript reads are async
// (WARDEN-828) so the single-threaded server answers /api/config mid-sweep
// instead of blocking behind synchronous full-transcript readFileSync calls.
const fsp = fs.promises;

// ---- Claude Code session list (for the per-host "resume" list) ----
// Exported (not just module-local) because other modules reuse it to derive cwd/summary.
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
// instead of a misleading "0 tok" — the REMOTE grep+awk extractor collapses the
// same all-zero case to empty → null, so both paths share the null-for-zero
// contract. (WARDEN-367.)
//
// PARITY WITH THE REMOTE EXTRACTOR (WARDEN-1088). This function is the
// REFERENCE side: it parses each line as JSON and reads `message.usage` only.
// The remote path can't parse JSON (no jq/node on-host), so it text-scans — and
// the two agree only where the scan is constrained to match this reading. Two
// places where the shapes differ, and what each side does:
//
//   1. `message.usage.iterations[]` — a per-iteration DECOMPOSITION of the very
//      rollup that sits beside it (measured: parts sum to the rollup exactly on
//      7611/7611 usage objects locally). Reading `u.input_tokens` takes the
//      rollup and never descends into `iterations`, so this side counts it once.
//      The remote awk dedups per JSONL line to match. Before WARDEN-1088 it did
//      not, and summed rollup + parts ≈ 2× on every remote host.
//   2. `toolUseResult.usage.*` — subagent turns carry usage under a DIFFERENT
//      key. This side ignores it (it reads `message.usage` only); the remote
//      text-scan still counts it, because the scan keys off field names, not
//      paths. That residual is a deliberate open question, not a bug — see the
//      note on the remote script below. It cannot interact with (1): no JSONL
//      line carries both keys (measured 0 of 7617 locally).
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

// Enumerate ~/.claude/projects/*/*.jsonl, most-recent-first. Shared by the
// top-40 list (localClaudeSessions) and full-content search so they walk the
// same archive layout. Returns [] if the projects dir is absent.
//
// Async (WARDEN-828): the directory walk uses fs.promises so the readdir/stat
// syscalls yield the event loop instead of blocking it. This is the lighter
// half of the work — the heavy I/O is the transcript reads in localClaudeSessions.
async function collectLocalSessionFiles() {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  try {
    for (const proj of await fsp.readdir(dir)) {
      const pdir = path.join(dir, proj);
      try { if (!(await fsp.stat(pdir)).isDirectory()) continue; } catch { continue; }
      // Per-dir granularity (WARDEN-2029): one project dir that cannot be read —
      // EACCES after mangled permissions/ownership, or ENOENT from the window
      // between the stat above and this readdir (claude creates/removes project
      // dirs as sessions come and go) — skips only itself. A function-wide catch
      // here blanked the ENTIRE catalog ([]) because a sibling dir was bad.
      let entries;
      try { entries = await fsp.readdir(pdir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pdir, f);
        try { files.push({ id: f.slice(0, -6), file: fp, mtime: (await fsp.stat(fp)).mtimeMs }); } catch { /* noop */ }
      }
    }
  } catch { return []; }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// `limit` bounds the returned list (most-recent first). Defaults to 40 to keep
// `/api/claude-sessions` (the single-host resume list) unchanged; the unified
// "All Sessions" endpoint passes a larger window for pagination (WARDEN-176).
//
// Async (WARDEN-828): transcripts are read SEQUENTIALLY with fs.promises.readFile
// rather than readFileSync. A synchronous full-file read of up to `limit`
// transcripts (the budget sweep passes a large window) blocks the single-threaded
// server's event loop for the whole duration — queueing /api/config and every
// other HTTP response behind it, which surfaced as the Settings forever-spinner.
// Each `await readFile` yields the event loop, so other requests are answered in
// the I/O gaps. Reads stay sequential (not Promise.all) deliberately: peak memory
// remains bounded by the LARGEST single transcript — one body in memory at a time
// — matching the prior profile, rather than spiking to N concurrent bodies for the
// 1000-file pagination/budget window.
export async function localClaudeSessions(limit = 40) {
  const files = (await collectLocalSessionFiles()).slice(0, limit);
  const out = [];
  for (const f of files) {
    let cwd = '';
    let summary = '';
    let tokenUsage = null;
    try {
      // Full-file read: token usage lives on EVERY assistant turn across the
      // whole transcript, so the 8KB head window that sufficed for cwd/summary
      // can't see it. cwd/summary + tokens are derived from the SAME body so
      // the file is read once. (WARDEN-367.)
      const body = await fsp.readFile(f.file, 'utf8');
      ({ cwd, summary } = parseJsonlHead(body));
      tokenUsage = parseJsonlTokenUsage(body);
    } catch { /* noop */ }
    out.push({ id: f.id, cwd, summary, mtime: f.mtime, tokenUsage });
  }
  return out.filter((s) => s.cwd);
}

// ---- read-only transcript view (WARDEN-233) ----
// Caps for the read-only single-session viewer. A huge transcript must not blow
// up the UI or the remote SSH transfer. SESSION_VIEW_MAX_BYTES bounds the body
// transfer (a `tail -c` window remotely / a tail read locally); the head window
// for cwd is the same 8KB the list endpoints already read. SESSION_VIEW_MAX_MESSAGES
// is a secondary message-count cap (most-recent kept) so a transcript of many
// short messages stays bounded too.
export const SESSION_VIEW_MAX_BYTES = 400_000;
export const SESSION_VIEW_MAX_MESSAGES = 500;

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
// paging in transcriptWindow fully solves the common case. Page BOUNDARIES lose
// nothing: alignOlderPageCursor moves each page's prevCursor to a line boundary, so
// the record straddling a boundary is read whole by the next-older page (the one
// exception — a single line wider than a whole window — has no boundary to align to).
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

// Align an older-page cursor to a JSONL line boundary (WARDEN-1912). A window
// [start, end] with start > 0 begins somewhere INSIDE a line, so its raw `start`
// used as the next `before` would cut that line in half: the head of it ends the
// next-older page and the tail starts this one, and neither half parses. Instead the
// cursor becomes the byte offset of the first COMPLETE line in this window, the
// first (partial) line is not parsed here, and the next-older window [.., cursor]
// ends exactly on a line boundary so it contains the straddling line whole.
// `headBytes` is the byte length of this window's body up to and including its first
// '\n' (or -1 when it has none). Returns { prevCursor, skipBytes }: skipBytes is how
// much of the body to drop before parsing. Termination guard: when there is no '\n',
// or the only '\n' is the window's final byte (a single line wider than the window),
// aligning would not move the cursor backwards, so the raw start is kept.
export function alignOlderPageCursor(win, headBytes) {
  if (win.start > 0 && headBytes > 0 && win.start + headBytes < win.end) {
    return { prevCursor: win.start + headBytes, skipBytes: headBytes };
  }
  return { prevCursor: win.prevCursor, skipBytes: 0 };
}

// Resolve a local session JSONL by id across every project dir (the session id IS
// the basename; ids are unique per file). Returns the absolute path when found and
// null ONLY for genuine absence (ENOENT): the projects root does not exist, or the
// walk completed over every project dir and none holds the id. A resolution failure
// that is not absence (e.g. EACCES on an unreadable project dir) is thrown, never laundered into null — null maps to
// the route's 404 "session not found", a lie for a session the catalog lists
// (WARDEN-2031). Sibling isolation (WARDEN-2029) is preserved: a per-dir failure
// only skips its own dir (the last non-ENOENT error is thrown after the full walk),
// so an id found in a healthy dir resolves before any throw.
async function findLocalSessionFile(id) {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  let projects;
  try { projects = await fsp.readdir(dir); } catch (err) {
    if (err && err.code !== 'ENOENT') throw err; // unreadable root: no id is answerable
    return null; /* no projects dir → the id cannot exist */
  }
  let lastErr;
  for (const proj of projects) {
    const fp = path.join(dir, proj, `${id}.jsonl`);
    try { if ((await fsp.stat(fp)).isFile()) return fp; } catch (err) {
      if (err && err.code !== 'ENOENT') lastErr = err; /* skip this dir, remember why */
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// Read ONE local session into the bounded transcript view. Reads a head window
// (8KB) for cwd and a body window for the message list — never the whole file, so
// a giant transcript stays cheap. Returns {notFound} when the id matches no local
// file. With `opts.before` (a byte-offset cursor from a prior page's prevCursor)
// it reads the OLDER window [start, before] instead of the tail and SKIPS the head
// read (cwd is only needed on the first page — the caller already has it). The
// response carries prevCursor/hasMore so the caller can page further back.
// A read failure other than ENOENT (e.g. EACCES) is thrown, never swallowed into an
// empty view; ENOENT (file vanished mid-read) is {notFound}.
export async function readLocalSessionTranscript(id, opts = {}) {
  const before = opts.before;
  const file = await findLocalSessionFile(id);
  if (!file) return { notFound: true };
  let headText = '';
  let bodyText = '';
  let win = { start: 0, end: 0, prevCursor: 0, hasMore: false };
  // byteTruncated is a FIRST-PAGE signal only (file exceeds the body cap) — the
  // banner + token qualifier depend on it. Older pages are bounded to the cap by
  // construction, so their `truncated` reflects only the within-window message cap.
  let byteTruncated = false;
  try {
    const size = (await fsp.stat(file)).size;
    win = transcriptWindow(size, before);
    if (before == null) byteTruncated = size > SESSION_VIEW_MAX_BYTES;
    const fh = await fsp.open(file, 'r');
    try {
      // Head window (8KB) for cwd — only on the first page. The same head read
      // localClaudeSessions uses; skipped on older pages (cwd already known).
      if (before == null) {
        const hlen = Math.min(size, 8192);
        const hbuf = Buffer.alloc(hlen);
        await fh.read(hbuf, 0, hlen, 0);
        headText = hbuf.toString('utf8');
      }
      // Body window [start, end] for this page — bounded, never the whole file.
      const blen = Math.max(0, win.end - win.start);
      if (blen > 0) {
        const bbuf = Buffer.alloc(blen);
        await fh.read(bbuf, 0, blen, win.start);
        // Offsets are BYTES: find the first newline on the Buffer, not the string.
        const nl = bbuf.indexOf(0x0a);
        const aligned = alignOlderPageCursor(win, nl === -1 ? -1 : nl + 1);
        win.prevCursor = aligned.prevCursor;
        bodyText = bbuf.subarray(aligned.skipBytes).toString('utf8');
      }
    } finally {
      await fh.close();
    }
  } catch (err) {
    // The file vanished between findLocalSessionFile and open/stat: same answer as
    // an unknown id. Any other failure (EACCES, EIO, ...) must NOT masquerade as an
    // empty transcript — rethrow so the route's catch answers 500 {error}.
    if (err && err.code === 'ENOENT') return { notFound: true };
    throw err;
  }
  const view = buildTranscriptView(headText, bodyText);
  if (byteTruncated) view.truncated = true;
  view.prevCursor = win.prevCursor;
  view.hasMore = win.hasMore;
  return view;
}
