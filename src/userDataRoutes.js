// User-data HTTP routes — the 11 pure CRUD handlers over the user's own
// organisation data: /api/collections (x5), /api/pins, /api/agent-notes,
// /api/session-tags. Extracted verbatim from src/server.js (WARDEN-1733) as the
// next slice of the server.js decomposition (cf. gitRoutes.js, WARDEN-734).
//
// Leaf imports only (express, config.js, collections.js) — never imports
// server.js. `cfg` is the live config object server.js mutates in place
// (applyConfigPut / resetConfig), so it is injected and closed over, never
// copied; `chatCatalog` is the single shared cache instance.
import express from 'express';
import { save } from './config.js';
import * as collections from './collections.js';

export function createUserDataRouter({ cfg, chatCatalog }) {
  const router = express.Router();

  // ---- Collections API ----
  // GET /api/collections - List all collections
  router.get('/api/collections', async (_req, res) => {
    try {
      const allCollections = await collections.loadCollections();
      res.json({ collections: allCollections });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/collections - Create new collection
  router.post('/api/collections', async (req, res) => {
    try {
      const { name, criteria, metadata } = req.body ?? {};
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name is required (string)' });
      }
      const newCollection = await collections.createCollection(name, criteria, metadata);
      res.json({ collection: newCollection });
    } catch (e) {
      if (e.message.includes('already exists')) {
        res.status(409).json({ error: e.message });
      } else {
        res.status(400).json({ error: e.message });
      }
    }
  });

  // PATCH /api/collections/:id - Update collection
  router.patch('/api/collections/:id', async (req, res) => {
    try {
      const id = String(req.params.id);
      const updates = req.body;
      const updated = await collections.updateCollection(id, updates);
      res.json({ collection: updated });
    } catch (e) {
      if (e.message.includes('not found')) {
        res.status(404).json({ error: e.message });
      } else {
        res.status(400).json({ error: e.message });
      }
    }
  });

  // DELETE /api/collections/:id - Delete collection
  router.delete('/api/collections/:id', async (req, res) => {
    try {
      const id = String(req.params.id);
      const deleted = await collections.deleteCollection(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Collection not found' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/collections/:id/agents - Get agents matching collection criteria
  router.get('/api/collections/:id/agents', async (req, res) => {
    try {
      const id = String(req.params.id);
      const allCollections = await collections.loadCollections();
      const collection = allCollections.find((c) => c.id === id);
      if (!collection) {
        return res.status(404).json({ error: 'Collection not found' });
      }
      const chats = chatCatalog.snapshot();
      const agents = collections.getAgentsInCollection(collection, chats);
      res.json({ agents, count: agents.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/pins — return the list of pinned chat ids
  router.get('/api/pins', (_req, res) => res.json({ pins: cfg.pins || [] }));

  // PUT /api/pins — update the pinned chat id list and persist
  router.put('/api/pins', async (req, res) => {
    const { pins } = req.body ?? {};
    if (!Array.isArray(pins)) return res.status(400).json({ error: 'pins must be an array' });
    cfg.pins = pins;
    await save(cfg);
    res.json({ ok: true, pins });
  });

  // Agent notes — a short, human-authored per-chat annotation (mirrors /api/pins,
  // but id→note instead of an id list). Keyed by chat id, so it works for every
  // chat including un-renameable yatfa agents (rename is identity-only and 404s
  // for yatfa chats). WARDEN-89: validate input, never 500 on bad shapes.
  router.get('/api/agent-notes', (_req, res) => res.json({ notes: cfg.agentNotes || {} }));
  router.put('/api/agent-notes', async (req, res) => {
    const { id, note } = req.body ?? {};
    if (typeof id !== 'string' || !id.trim()) return res.status(400).json({ error: 'id must be a non-empty string' });
    if (typeof note !== 'string') return res.status(400).json({ error: 'note must be a string' });
    const value = note.trim().slice(0, 200); // mirror rename/collection name caps
    if (!cfg.agentNotes || typeof cfg.agentNotes !== 'object' || Array.isArray(cfg.agentNotes)) cfg.agentNotes = {};
    if (value) cfg.agentNotes[id] = value;
    else delete cfg.agentNotes[id]; // empty/blank note → remove the key entirely
    await save(cfg);
    res.json({ ok: true, notes: cfg.agentNotes });
  });

  // Session tags — short reusable labels a human puts on a past Claude session so the
  // ☁ sessions list can be filtered (e.g. #shipped, #needs-review). A local sidecar
  // keyed by claude-session id (mirrors /api/agent-notes' id→value map): tags are
  // NEVER written into Claude's transcript files. WARDEN-342. Orphan handling is the
  // frontend's job — a tag on a session that later vanishes is ignored, never throws
  // (same leniency cfg.pins/cfg.agentNotes already imply for vanished chats).
  router.get('/api/session-tags', (_req, res) => res.json({ sessionTags: cfg.sessionTags || {} }));
  router.put('/api/session-tags', async (req, res) => {
    const { id, tags } = req.body ?? {};
    if (typeof id !== 'string' || !id.trim()) return res.status(400).json({ error: 'id must be a non-empty string' });
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    // Coerce to trimmed strings, cap per-tag length, drop empties + duplicates, cap
    // the per-session count. Mirrors the caps the rest of the config surface uses.
    const MAX_TAG_LEN = 40;
    const MAX_TAGS_PER_SESSION = 8;
    const seen = new Set();
    const cleaned = tags
      .map((t) => (typeof t === 'string' ? t : String(t ?? '')))
      .map((t) => t.trim().slice(0, MAX_TAG_LEN))
      .filter((t) => {
        if (!t || seen.has(t.toLowerCase())) return false;
        seen.add(t.toLowerCase());
        return true;
      })
      .slice(0, MAX_TAGS_PER_SESSION);
    if (!cfg.sessionTags || typeof cfg.sessionTags !== 'object' || Array.isArray(cfg.sessionTags)) cfg.sessionTags = {};
    if (cleaned.length) cfg.sessionTags[id] = cleaned;
    else delete cfg.sessionTags[id]; // empty cleaned list → remove the key entirely
    await save(cfg);
    res.json({ ok: true, id, tags: cleaned });
  });

  return router;
}
