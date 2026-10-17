import express from 'express';
import { read as readPane, send as sendPane, sendKey } from './tmux.js';
import { capturePanes } from './chats.js';
import { resolvePaneContainer, projectFromContainerResolution } from './paneContainer.js';
import { deliverPastedImage } from './pasteImage.js';

// Pane I/O routes (/api/pane, /api/pane-export, /api/pane-project, /api/send,
// /api/key, /api/paste-image, /api/search-pane), extracted verbatim from
// server.js. Injected: the live `cfg` object (mutated in place by applyConfigPut,
// so it is closed over, never copied), the chat `resolve` function, and the
// single `chatCatalog` instance (only /api/search-pane reads .snapshot()).
export function createPaneRouter({ cfg, resolve, chatCatalog }) {
  const router = express.Router();
  router.get('/api/pane', async (req, res) => {
    const r = await resolve(String(req.query.id || ''));
    if (r.error) return res.status(404).json(r);
    try { res.json({ pane: await readPane(r.chat, cfg, parseInt(req.query.lines || '200', 10)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/api/pane-export', async (req, res) => {
    const r = await resolve(String(req.query.id || ''));
    if (r.error) return res.status(404).json(r);
    try {
      const lines = parseInt(req.query.lines || '5000', 10);
      const pane = await readPane(r.chat, cfg, lines);
      const chat = r.chat;
      res.json({
        pane,
        meta: {
          name: chat.name || chat.key || chat.id,
          host: chat.host,
          container: chat.container || null,
          session: chat.session || null,
          project: chat.project || null,
          role: chat.role || null,
          kind: chat.kind || null,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/api/pane-project', async (req, res) => {
    // WARDEN-1405 — WHICH project a pane's foreground really belongs to, for the
    // issue-key linkifier's manual-pane fallback. A manual/tmux chat hardcodes a
    // placeholder project ('local'/'manual' — the chats.js/server.js factories),
    // so PaneTile's strict per-project scoping correctly linkifies nothing: the
    // matcher is right, the pane's project INPUT is wrong. This endpoint answers
    // the input question — and ONLY that question. The project→prefix→tracker
    // LINK is never inferred here; it stays the human-stated issueLinkTrackers
    // config. The container, when one can be proven, is read from the pane's own
    // docker-exec process tree (resolvePaneContainer, WARDEN-1377 — 5-min TTL
    // cache, never throws, honest none/ambiguous/failed), and container→project
    // is chatMeta.parseContainerName — the same parse that puts a project on
    // every yatfa chat.
    //
    // Contract (mirrors /api/pane-export's resolve(id) + 404 shape):
    //   integration off            → { state: 'disabled' }          (gate FIRST —
    //                                  the off state answers byte-identically even
    //                                  against stray requests, and never walks)
    //   unknown id                 → 404 { error }
    //   chat.container set (yatfa) → { state: 'known', project }    (no walk —
    //                                  its project already IS the container parse)
    //   walk resolved              → { state: 'resolved', project, container }
    //   walk none/ambiguous/failed → { state, project: null }       (honest
    //                                  silence — a guessed link must not appear)
    if (cfg.issueLinksEnabled !== true) return res.json({ state: 'disabled' });
    const r = await resolve(String(req.query.id || ''));
    if (r.error) return res.status(404).json(r);
    const chat = r.chat;
    if (chat.container) return res.json({ state: 'known', project: chat.project ?? null });
    try {
      const resolution = await resolvePaneContainer(chat, cfg);
      if (resolution && resolution.state === 'resolved') {
        return res.json({ state: 'resolved', project: projectFromContainerResolution(resolution), container: resolution.container });
      }
      return res.json({ state: resolution?.state ?? 'failed', project: null });
    } catch (e) {
      // resolvePaneContainer never throws by contract; this guard keeps a walk
      // that somehow escapes that contract an honest failure, not a 500.
      return res.json({ state: 'failed', project: null });
    }
  });
  router.post('/api/send', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.status(404).json(r);
    try { await sendPane(r.chat, cfg, String(req.body?.text || '')); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/api/key', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.status(404).json(r);
    try { await sendKey(r.chat, cfg, String(req.body?.key || '')); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // WARDEN-1282 — a clipboard IMAGE pasted into an agent pane. Modelled on
  // /api/send above: the renderer knows only the pane id, and the server resolves
  // the chat (and from it the host/container) — the renderer never learns, and
  // never gets to choose, where the bytes land.
  //
  // TWO body decisions, both deliberate:
  //
  // (1) RAW, not JSON. The global `express.json({ limit: '1mb' })` at the top of
  //     this file must NEVER be raised — it bounds every other route in the app,
  //     and widening it to fit a screenshot would widen the DoS surface of the
  //     entire API for one endpoint's sake. A route-specific `express.raw` mounted
  //     on THIS path only is the scoped alternative, and raw beats a base64 JSON
  //     field on its own merits too: no ~33% inflation, no parse of a multi-MB
  //     string on the single-threaded event loop this server's stall monitor
  //     exists to protect.
  //
  // (2) The id rides the QUERY STRING, because the body is now the image itself
  //     and cannot also carry a field. `type: () => true` accepts whatever
  //     content-type the clipboard's Blob declares (image/png, image/jpeg, …)
  //     rather than allow-listing MIME the client controls anyway — the FORMAT is
  //     decided by sniffing the actual header bytes in describeImage(), so a
  //     mislabeled type cannot make us name a PNG `.jpg`.
  //
  // The marker line is NOT sent from here. The renderer pastes it through the
  // same term.paste() text path a normal paste uses, so companion-enabled setups
  // and bracketed-paste apps behave identically to any other paste — and so no
  // marker can ever appear without the delivery this route reports having
  // succeeded.
  router.post('/api/paste-image', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    const r = await resolve(String(req.query?.id || ''));
    if (r.error) return res.status(404).json(r);
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'empty image body' });
    try {
      const out = await deliverPastedImage(r.chat, cfg, buf);
      if (!out.ok) return res.status(500).json({ error: out.error });
      res.json({ ok: true, path: out.path, marker: out.marker });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Global cross-pane search: captures and searches across all open panes
  router.get('/api/search-pane', async (req, res) => {
    const query = String(req.query.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query required' });

    const paneKeys = String(req.query.panes || '').split(',').filter(Boolean);
    const known = chatCatalog.snapshot();
    // WARDEN-1223: a bare key can name a session on more than one host — collect
    // EVERY catalogue match (deduped by the host-qualified id), so search results
    // are attributed to the chat whose terminal actually matched, per host.
    const chats = [];
    const seenIds = new Set();
    for (const key of paneKeys) {
      for (const c of known) {
        if (c.key !== key && c.id !== key) continue;
        if (!seenIds.has(c.id)) { seenIds.add(c.id); chats.push(c); }
      }
    }
    if (chats.length === 0) return res.json({ results: [], query });

    try {
      const captures = await capturePanes(chats, cfg);
      const results = [];

      // capturePanes is keyed by the host-qualified id (WARDEN-1223); attribute each
      // captured pane to ITS chat (host + name), not the first same-named one.
      for (const [id, content] of Object.entries(captures)) {
        const lines = content.split('\n');
        const chat = chats.find((c) => c.id === id);
        if (!chat) continue;
        const key = chat.key;

        const lowerQuery = query.toLowerCase();
        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(lowerQuery)) {
            results.push({
              key,
              host: chat.host || 'unknown',
              name: chat.name || key,
              line: idx,
              text: line.trim(),
              context: {
                before: lines[Math.max(0, idx - 2)]?.trim() || '',
                after: lines[Math.min(lines.length - 1, idx + 2)]?.trim() || '',
              },
            });
          }
        });
      }

      res.json({ results, query });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  return router;
}
