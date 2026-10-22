import express from 'express';
import { readChatFile, resolveLocalFile, probeRemoteFile, probeContainerFile } from './chatFiles.js';
import { searchLocalRaw, buildSearchScript, parseSearchOutput } from './workspaceSearch.js';
import { runInContext, gitCwd } from './gitRoutes.js';

// Chat working-directory file routes (/api/read-file, /api/file-exists,
// /api/search-files), extracted verbatim from server.js. Injected: `resolve`
// (chat id → { chat } | { error }), the shared `fileExistsTelemetry` instance
// (server.js owns its lifecycle) and the `local` host id constant.
export function createChatFileRouter({ resolve, fileExistsTelemetry, local }) {
  const router = express.Router();

  // POST /api/read-file — read a file from a chat's working directory.
  // Body: { id: string, path: string }
  // Response: { content: string, path: string, error?: string }
  router.post('/api/read-file', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.status(404).json(r);

    const filePath = String(req.body?.path || '').trim();
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    // The local-vs-remote read-with-guards orchestration (resolve + 1MB + binary +
    // read, plus the remote ERROR→{status,error} mapping) lives in ONE place —
    // readChatFile — shared with readWorkingTreeFile so the two paths can't drift
    // apart on a new guard or a new error string (WARDEN-674). The handler keeps
    // only its own pre-checks (the chat-resolution 404 and the `path is required`
    // 400) and the response shaping ({content, path} / {error}).
    const result = await readChatFile(r.chat, filePath);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ content: result.content, path: filePath });
  });

  // POST /api/file-exists — lightweight existence probe for the in-terminal file
  // linkifier (WARDEN-227). Body: { id, path }. Confirms `path` resolves to a real
  // file within the chat's cwd WITHOUT reading or transferring content, so it is
  // cheap enough to run per visible terminal candidate. Reuses the SAME resolution
  // discipline as /api/read-file (realpath + cwd-containment + is-file): local chats
  // go through the shared resolveLocalFile, remote chats deliver
  // buildFileExistsScript to the host (raw ssh by default, the companion channel
  // under the WARDEN-1284 toggle). Response: { exists: boolean } — any resolution
  // failure (missing, outside cwd, directory, transport error) collapses to
  // exists:false because the linkifier only needs yes/no — EXCEPT a remote probe
  // that got no verdict at all, which adds `failed: true` (WARDEN-1492) so it is
  // distinguishable from a conclusive absence. Security: never weakens
  // the cwd-containment guard.
  router.post('/api/file-exists', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.json({ exists: false });

    const filePath = String(req.body?.path || '').trim();
    if (!filePath) return res.json({ exists: false });

    const chat = r.chat;
    const cwd = chat.cwd || '.';

    // WARDEN-1258 — fold the renderer's cache-hit DELTA for this pane before the
    // probe runs: `cacheHits` counts the candidates served from the pane's
    // per-path cache since its last request (a hit never fetches, so this
    // piggyback is the only way the server ever learns about them). Aggregate
    // count only — no path travels with it.
    fileExistsTelemetry.recordCacheHits(req.body?.cacheHits);

    // WARDEN-1258 — usage telemetry for the probe itself: count + ok/fail +
    // latency, split local/remote, gated on the operational-metrics category
    // (off by default). Timing wraps ONLY the resolution work.
    const probeStart = Date.now();
    const finishProbe = (kind, ok) =>
      fileExistsTelemetry.recordProbe(kind, Date.now() - probeStart, ok);

    if (!chat.container && chat.host === local) {
      const exists = resolveLocalFile(cwd, filePath).ok;
      finishProbe('local', exists);
      return res.json({ exists });
    }

    // Remote: run the existence script; success + the EXISTS marker ⇒ real file.
    // WARDEN-1492: three-state — a probe that got NO verdict (transport error,
    // timeout, script failure) answers `{ exists: false, failed: true }` so the
    // renderer can tell it from a conclusive absence and not cache it, and the
    // telemetry files it in a separate failure bucket instead of "absent".
    // WARDEN-1908: container chats (local OR remote host) probe inside the container.
    const probe = chat.container
      ? await probeContainerFile(chat, filePath)
      : await probeRemoteFile(chat.host, cwd, filePath);
    const elapsed = Date.now() - probeStart;
    if (probe.state === 'failed') {
      fileExistsTelemetry.recordRemoteFailure(probe.reason, elapsed);
      return res.json({ exists: false, failed: true });
    }
    const exists = probe.state === 'exists';
    finishProbe('remote', exists);
    return res.json({ exists });
  });

  // POST /api/search-files — content-search a chat's working directory (grep).
  // Body: { id: string, query: string }
  // Response: { results: [{ file, line, text }], query, error?: string }
  // Local chats run git/rg/grep via async runLocalGit/streamBoundedSearch; remote chats run buildSearchScript
  // over SSH. Mirrors /api/git-status's resolve → cwd guard → local/remote split.
  router.post('/api/search-files', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.status(404).json(r);

    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    const chat = r.chat;
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ results: [], query, error: 'no cwd' });

    try {
      let raw = '';
      let error = null;
      if (!chat.container && chat.host === local) {
        // manual-LOCAL: stream git/rg/grep on the host fs, bounded at the source.
        raw = await searchLocalRaw(cwd, query);
      } else {
        // container (local+remote) or manual-remote: buildSearchScript delivered
        // in-context via runInContext (docker-exec for yatfa, ssh for manual-remote)
        // so `cd <cwd>` + `git grep`/`rg`/`grep` run where the repo lives. The script
        // already bounds output (`| cut | head`) so the in-context run is overflow-
        // safe. See WARDEN-235.
        const script = buildSearchScript(cwd, query);
        const result = await runInContext(chat, script, { timeout: 10000 });
        // A failed run (container down / SSH auth / timeout) must NOT masquerade as
        // "no matches" — surface it so the dialog can show a real error. result.stdout
        // is still parsed when present (head/cut already bounded it).
        if (!result.ok) error = 'search failed';
        raw = result.stdout || '';
      }
      if (error) res.json({ results: [], query, error });
      else res.json({ results: parseSearchOutput(raw), query });
    } catch (e) {
      // Generic message — don't leak internals (e.g. a HostConnectionError embedding
      // the remote hostname) to the browser. Mirrors read-file's 'read failed'.
      res.json({ results: [], query, error: 'search failed' });
    }
  });

  return router;
}
