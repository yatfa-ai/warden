// Claude-session HTTP routes — /api/claude-sessions, /api/claude-sessions-all,
// /api/claude-sessions-search, /api/claude-session: a thin HTTP layer over
// claudeSessions.js plus the shared sessionCache. Extracted verbatim from
// src/server.js (WARDEN-1740) as the next slice of the server.js decomposition
// (cf. gitRoutes.js, WARDEN-734; userDataRoutes.js, WARDEN-1733).
//
// Never imports server.js. `cfg` is the live config object server.js mutates in
// place (applyConfigPut / resetConfig), so it is injected and closed over, never
// copied (`cfg.hosts` is read per request); `sessionCache` is the single shared
// cache instance; `local` is the '(local)' host sentinel.
import express from 'express';
import { detectClaude } from './ssh.js';
import {
  localClaudeSessions, remoteClaudeSessionsDetail,
  mergeAndPaginateSessions,
  readLocalSessionTranscript, parseSessionReadOutput,
  searchLocalClaudeSessions, remoteSearchClaudeSessions, remoteReadSessionTranscript,
  SESSION_SEARCH_PER_HOST, SESSION_SEARCH_GLOBAL,
} from './claudeSessions.js';

export function createClaudeSessionsRouter({ cfg, sessionCache, local }) {
  const LOCAL = local;
  const router = express.Router();

  // An unreachable REMOTE host answers `{ host, sessions: [], error: 'host
  // unreachable' }` — and, critically, WITHOUT a `claudeAvailable` key (WARDEN-1196).
  //
  // THE BUG THIS CLOSES. Both helpers destroyed the failure server-side:
  // `remoteClaudeSessions` returned `[]` for a dead host, and `detectClaude`
  // returned `null` because its probes could not reach the machine. That produced a
  // clean `200 {sessions: [], claudeAvailable: false}`, and the sidebar's warning is
  // gated on `claudeAvailable === false` — so a dropped tunnel / wedged control
  // socket / powered-off box was reported in the product's own voice as
  // "⚠ claude not found on <host> — install it", a confident, WRONG, and ACTIONABLE
  // claim about the user's machine. `detectClaude` cannot tell "claude is absent"
  // from "I could not reach the host", so the answer is not to make it try: it is to
  // not ask a question whose answer we already know is unknowable.
  //
  // WHY THE KEY IS OMITTED RATHER THAN SENT AS `false`. Sending `claudeAvailable:
  // false` alongside the error would leave the bug LIVE — the gate is a strict
  // `=== false`. Omitting it arrives as `undefined`, which that gate does not
  // satisfy, so the wrong instruction cannot render. The client state shape already
  // types the field optional, so this needs no change to the gate's operator (which
  // would risk over-correcting the two states that MUST keep their existing render:
  // a reachable host with zero sessions, and a reachable host genuinely missing
  // claude).
  //
  // Skipping `detectClaude` on this path also drops three SSH probes to a machine we
  // have just proven unreachable — each on an 8s timeout.
  //
  // Scope: the REMOTE leg only. `(local)` does no SSH (`localClaudeSessions` reads
  // the filesystem), so transport failure is impossible there and that path is
  // unchanged. A host that answers with a non-zero exit and real stdout is a COMMAND
  // failure, not transport — `isTransportFailure` returns false when stdout is
  // non-empty — and still degrades to the pre-existing empty list.
  router.get('/api/claude-sessions', async (req, res) => {
    const host = String(req.query.host || LOCAL);
    if (host !== LOCAL) {
      const { sessions, unreachable } = await remoteClaudeSessionsDetail(host);
      // `claudeAvailable` is deliberately absent from this body — see above.
      if (unreachable) return res.json({ host, sessions: [], error: 'host unreachable' });
      const claudeAvailable = !!(await detectClaude(host));
      return res.json({ host, sessions, claudeAvailable });
    }
    const sessions = await localClaudeSessions();
    const claudeAvailable = !!(await detectClaude(host));
    res.json({ host, sessions, claudeAvailable });
  });

  // Page-size guardrails for the unified "All Sessions" endpoint. Default 40 matches
  // the old hard global cap (so page 1 is unchanged), clamped to bound remote cost.
  const ALL_SESSIONS_DEFAULT_LIMIT = 40;
  const ALL_SESSIONS_MAX_LIMIT = 200;
  // Per-host fetch window ceiling. The endpoint asks for offset+limit+1 per host so
  // `hasMore` is honest (see mergeAndPaginateSessions); this clamp bounds memory and
  // remote transfer for pathological scale — far above any realistic page window.
  const ALL_SESSIONS_MAX_PER_HOST = 1000;

  router.get('/api/claude-sessions-all', async (req, res) => {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(
      ALL_SESSIONS_MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || ALL_SESSIONS_DEFAULT_LIMIT),
    );
    // Per-host window: offset+limit+1 so the global boundary item is always fetched
    // and `hasMore` is computed honestly (clamped to bound remote SSH cost).
    const perHost = Math.min(ALL_SESSIONS_MAX_PER_HOST, offset + limit + 1);
    const hosts = [LOCAL, ...cfg.hosts];
    // ONE OWNER (WARDEN-1208). This used to be a `Promise.allSettled` fan-out right
    // here, which meant the route could not answer until the LAST host settled: one
    // unreachable machine withheld every healthy host's rows for the duration of its
    // 15s SSH timeout, and a page load landing near the 120s budget sweep re-fetched
    // rows that sweep was already fetching. Both are now the cache's business — it
    // serves each host from its own slot, joins an in-flight fetch rather than
    // stacking a second one, and bounds how long a cold host may hold the response.
    //
    // WHAT DID NOT CHANGE, deliberately: the cache fetches the REMOTE leg through
    // `remoteClaudeSessionsDetail`, so a transport failure stays DISTINGUISHABLE from
    // "this host has no sessions" (WARDEN-1200) and `unreachableHosts` below is
    // derived exactly as before. The bare `remoteClaudeSessions` contract is still
    // FROZEN (WARDEN-1196) and still un-widened; the budget sweep now shares this
    // cache but still consumes a plain array.
    //
    // Scope, unchanged: REMOTE only. `localClaudeSessions` is a filesystem read, not
    // a transport, so `isTransportFailure` has no meaning for it and `(local)` can
    // never be reported unreachable (the cache hard-codes `unreachable: false` on
    // that leg). A remote host answering with a non-zero exit and real stdout is a
    // COMMAND failure — `isTransportFailure` returns false on non-empty stdout — so
    // it still degrades to the pre-existing empty list and is NOT named unreachable.
    const settled = await sessionCache.snapshot(hosts, perHost);
    // Every host contributes its bucket, INCLUDING the ones we could not fully
    // answer for. A cold host (`known: false`) contributes zero rows here — but it
    // is contributing zero rows WHILE BEING DISCLOSED as `pendingHosts` below, which
    // is what keeps that different from the false-empty defect. An under-filled host
    // (joined a smaller in-flight fetch) contributes its REAL but possibly truncated
    // rows, and is disclosed the same way: dropping them would blank a host that did
    // answer, for a list the user can see. This is the OPPOSITE choice from the
    // budget sweep, which drops pending hosts' rows entirely (`completeSessionRows`)
    // — deliberately, because it computes a NUMBER that gets cached, and a truncated
    // list would make it silently wrong rather than visibly partial.
    const buckets = settled.map(({ host, sessions }) => ({ host, sessions }));
    const unreachableHosts = settled.filter((b) => b.unreachable).map((b) => b.host);
    // Hosts we have NOT SUCCESSFULLY READ YET — cold on this request, or still
    // filling from a fetch another reader launched. Disclosed for the same reason
    // `unreachableHosts` is: an empty session list renders as the confident sentence
    // "Nothing runnable on the selected hosts yet", so a host we simply have not
    // looked at must never be merged away as zero rows (the WARDEN-89 / WARDEN-1200
    // false-empty defect). "We have not looked yet" and "we looked and it is empty"
    // are different answers, and the wire now carries the difference.
    const pendingHosts = settled.filter((b) => b.pending).map((b) => b.host);
    const { sessions, hasMore, totals } = mergeAndPaginateSessions(buckets, offset, limit);
    // `unreachableHosts` is ADDITIVE and OMITTED when the fleet is fully reachable, so
    // a healthy response is byte-identical to before this change.
    //
    // Deliberately NOT a top-level `error` key, even though the sibling single-host
    // route uses one. The client seam (web/src/lib/allSessionsApi.ts and
    // OpenChatBrowserPage, since removed) threw on a 2xx carrying `error` and its
    // catch never seated a list — so on a first load with one host down, an `error` here would render
    // "Could not load sessions" INSTEAD of the rows the reachable hosts did return.
    // That is the WARDEN-1196 criterion-4 over-correction: replacing a false-empty
    // with a false-total-failure. `error` is a whole-read-failed channel; a partial
    // fleet is a partial SUCCESS and needs its own, non-throwing channel.
    //
    // It is also what makes `totals`/`hasMore` honest. Both are computed over the
    // SURVIVING buckets only (mergeAndPaginateSessions) — unavoidable, since the
    // missing rows are on the machine we could not read — so the client can now know
    // the rollup and the pagination are partial instead of trusting them blindly.
    //
    // `pendingHosts` rides the SAME additive, non-throwing channel and for the same
    // reason — both are partial-SUCCESS disclosures, never a whole-read failure. It
    // is likewise OMITTED when every host answered, so a warm response is
    // byte-identical to before this change. The two are deliberately separate keys:
    // "I could not reach this machine" and "I have not looked at it yet" call for
    // different words to a user and different behaviour from a client (the second
    // resolves on its own, and is worth re-reading for).
    res.json({
      sessions,
      hasMore,
      totals,
      ...(unreachableHosts.length ? { unreachableHosts } : {}),
      ...(pendingHosts.length ? { pendingHosts } : {}),
    });
  });

  // GET /api/claude-sessions-search?q= — full-content search across EVERY host's
  // JSONL archive, returning recency-ranked matches (incl. sessions outside the
  // top-40 list). One unreachable host degrades to "no matches from it" via
  // Promise.allSettled — it never fails the whole search. Response shape:
  //   { results: [{ host, sessionId, cwd, summary, snippet, mtime }] }
  router.get('/api/claude-sessions-search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'query required' });
    const hosts = [LOCAL, ...cfg.hosts];
    const settled = await Promise.allSettled(hosts.map(async (host) => {
      const sessions = host === LOCAL ? await searchLocalClaudeSessions(q) : await remoteSearchClaudeSessions(host, q);
      return { host, sessions: sessions.slice(0, SESSION_SEARCH_PER_HOST) };
    }));
    const all = settled
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value.sessions.map((s) => ({
        host: r.value.host, sessionId: s.id, cwd: s.cwd, summary: s.summary, snippet: s.snippet, mtime: s.mtime,
      })));
    all.sort((a, b) => b.mtime - a.mtime);
    res.json({ results: all.slice(0, SESSION_SEARCH_GLOBAL) });
  });

  // GET /api/claude-session?id=&host=&before= — read-only transcript of ONE past
  // session across any host, WITHOUT resuming it (no live `claude` process, no tmux
  // session, no catalog entry). Local host reads the JSONL from disk; a remote host
  // reads it over SSH via buildSessionReadScript (same hosts the search already
  // reaches). The output is bounded (a byte window + a message cap) so a huge
  // transcript can't blow up the UI or the remote transfer. Response on success:
  //   { host, cwd, messages: [{role, text, ts, usage?}], truncated?, hasMore, prevCursor }
  // where each message may carry an optional `usage` (WARDEN-474) — the per-turn
  // token breakdown {input, output, cacheCreation, cacheRead, total} for assistant
  // turns that spent tokens (absent on user/tool rows). It is the drill-down beneath
  // the session-list total badge (WARDEN-367), not a re-derivation of it.
  //
  // `before` (WARDEN-510) is a byte-offset cursor for paging OLDER messages: omit it
  // for the first (most-recent) page; pass a prior page's `prevCursor` to fetch the
  // next-older window and prepend it. `hasMore` drives the "Load earlier messages"
  // control (false at the true start of the transcript); `prevCursor` is the cursor
  // for the next page. An unreachable host degrades to { host, error: 'host
  // unreachable' } (the remote read carries an explicit 15s deadline on either
  // transport, so it never hangs) rather than failing.
  router.get('/api/claude-session', async (req, res) => {
    const id = String(req.query.id || '');
    if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
    const host = String(req.query.host || LOCAL);
    // Validate `before` as a base-10 non-negative integer (mirror the id-guard
    // discipline); 400 on anything malformed so a stray cursor can't reach the read.
    let before;
    const beforeRaw = req.query.before;
    if (beforeRaw !== undefined && String(beforeRaw) !== '') {
      if (!/^\d+$/.test(String(beforeRaw))) return res.status(400).json({ error: 'invalid before cursor' });
      before = Number(beforeRaw);
    }
    try {
      let view;
      if (host === LOCAL) {
        view = await readLocalSessionTranscript(id, { before });
      } else {
        const rr = await remoteReadSessionTranscript(host, id, { before });
        if (!rr.ok) return res.json({ host, error: 'host unreachable' });
        view = parseSessionReadOutput(rr.stdout, { before });
      }
      if (view.notFound) return res.status(404).json({ error: 'session not found' });
      return res.json({
        host,
        cwd: view.cwd,
        messages: view.messages,
        truncated: view.truncated,
        hasMore: view.hasMore,
        prevCursor: view.prevCursor,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
