// warden web dashboard server. tmux is required everywhere — every chat is a tmux
// session (yatfa: in a docker container; manual: a host/local tmux session). The
// transport (ssh.js runTmux/attachTmux) routes each op to the remote host over SSH
// or to this machine locally. No more direct-PTY path.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { load, save, loadCatalog, saveCatalog, allSshHosts } from './config.js';
import * as collections from './collections.js';
import { capturePanes, resolveChatWithRefresh, catalogChats, discoverHost } from './chats.js';
import { read as readPane, send as sendPane, sendKey, hasSession, resize, spawn as spawnTmux, kill as killTmux, attachStream } from './tmux.js';
import { run, runLocalTmux, shellQuote, TMUX_BIN, detectClaude, startConnectionPoolCleanup, validateHost } from './ssh.js';
import { Observer } from './observer.js';
import { hasCredentials, resolveModel } from './llm.js';
import { listSessions, createSession, renameSession, deleteSession } from './sessions.js';
import { appendEvent, rotateEvents, readEvents, getStatsSince } from './activity.js';
import { getHealthState, groupByHealth, getHealthSummary } from './health.js';
import { checkHost } from './hostStatus.js';
import { parseGitStatusPorcelain, parseAheadBehind, parseStashCount, parseStashList } from './gitStatus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = load();
const LOCAL = '(local)';

const app = express();
app.use(express.json({ limit: '1mb' }));

const DIST = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(DIST)) {
  // Never cache index.html (so new hashed bundles are picked up after a rebuild);
  // hashed assets under /assets are fine to cache (content-addressed).
  app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
  });
  app.use(express.static(DIST));
} else {
  app.get('/', (_req, res) => res.type('text/plain').send(
    'warden web build not found. Run `npm run build` in web/ (or `warden dev` for hot reload).',
  ));
}

// chat cache + resolver
let cache = [];
async function resolve(id) {
  const result = await resolveChatWithRefresh(id, cache, async () => {
    // Lazy mode: never do a full fleet discoverAll. Seed cache from disk (instant, zero
    // ssh), then — only if the id carries a known "<host>:..." prefix — discover that one
    // host. Bare container names (restored yatfa tabs) stay unresolved until the user
    // clicks the host. resolveChatWithRefresh re-matches against the refreshed cache.
    if (!cache.length) cache = catalogChats(cfg).chats;
    const colon = id.lastIndexOf(':');
    if (colon > 0) {
      const hostHint = id.slice(0, colon);
      if (hostHint === LOCAL || cfg.hosts.includes(hostHint)) {
        const { chats } = await discoverHost(hostHint, cfg);
        cache = [...cache.filter((c) => c.host !== hostHint), ...chats];
      }
    } else if (cfg.hosts.length) {
      // Bare name (e.g. a restored yatfa tab like "yatfa-worker") with no host hint.
      // Locate it across configured hosts so already-open remote panes resolve on app
      // start. Demand-driven + cached: runs at most once per unresolved bare name.
      const settled = await Promise.allSettled(cfg.hosts.map((h) => discoverHost(h, cfg)));
      const found = settled.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value.chats);
      cache = [...cache.filter((c) => !cfg.hosts.includes(c.host)), ...found];
    }
    return { chats: cache, errors: [] };
  });

  if (result.chat) return { chat: result.chat };
  if (result.error) {
    // Parse the error to maintain compatibility with existing error handling
    if (result.error.includes('ambiguous')) {
      const matches = result.error.match(/matches: (.+)$/)?.[1]?.split(', ') || [];
      return { error: 'ambiguous', matches };
    }
    return { error: result.error };
  }
  return { error: `no chat matches "${id}"` };
}

// Verify tmux is available (local exec or remote host). Returns null or an error string.
async function preflightTmux(host) {
  if (host === LOCAL) {
    const r = runLocalTmux(['-V']);
    return r.ok ? null : 'tmux not found on this machine. Install it (Linux/macOS: tmux; Windows: MSYS2 tmux).';
  }
  const r = await run(host, 'command -v tmux >/dev/null 2>&1 && echo OK || echo MISSING', { timeout: 8000 });
  return r.stdout.includes('OK') ? null : `tmux is required on ${host}. install:  ssh ${host} 'sudo apt-get install -y tmux'  (or: brew install tmux)`;
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

// Disk-only catalog list — instant, zero ssh (lazy mode). Live active/status are
// resolved per host on demand via /api/discover.
app.get('/api/chats', (_req, res) => {
  const { chats, errors } = catalogChats(cfg);
  // Refresh catalog (disk) chats in the cache but KEEP any lazily-discovered yatfa chats,
  // so already-open remote panes keep streaming across list refreshes.
  const yatfa = cache.filter((c) => c.kind === 'yatfa');
  cache = [...yatfa, ...chats];
  res.json({ chats, errors });
});

// Discover ONE host on demand (user clicked it). Returns that host's chats with live
// active/lastActivity and merges them into the cache.
app.get('/api/discover', async (req, res) => {
  const host = String(req.query.host || '');
  if (!host) return res.status(400).json({ error: 'missing ?host=' });
  try {
    const { chats } = await discoverHost(host, cfg);
    cache = [...cache.filter((c) => c.host !== host), ...chats];
    res.json({ host, chats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health endpoint for fleet health monitoring
app.get('/api/health', (_req, res) => {
  try {
    // Cache-derived (zero ssh). Under lazy mode only discovered/catalog chats are present;
    // catalog chats report UNKNOWN until their host is clicked.
    const chats = cache;

    // Calculate health state for each agent
    const agentsWithHealth = chats.map(chat => ({
      ...chat,
      healthState: getHealthState(chat, chat.lastActivity)
    }));

    // Group by health state
    const groups = groupByHealth(agentsWithHealth);

    // Get summary
    const summary = getHealthSummary(groups);

    res.json({
      agents: agentsWithHealth,
      groups,
      summary,
      timestamp: Date.now()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/pane', async (req, res) => {
  const r = await resolve(String(req.query.id || ''));
  if (r.error) return res.status(404).json(r);
  try { res.json({ pane: await readPane(r.chat, cfg, parseInt(req.query.lines || '200', 10)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/pane-export', async (req, res) => {
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
app.post('/api/send', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  try { await sendPane(r.chat, cfg, String(req.body?.text || '')); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/key', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  try { await sendKey(r.chat, cfg, String(req.body?.key || '')); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions', (_req, res) => res.json({ sessions: listSessions() }));
app.post('/api/sessions', (req, res) => {
  const { name, host, container, project, role, chatKey } = req.body || {};
  res.json(createSession(name, { host, container, project, role, chatKey }));
});
app.patch('/api/sessions/:id', (req, res) => {
  const s = renameSession(String(req.params.id), String(req.body?.name || ''));
  return s ? res.json(s) : res.status(404).json({ error: 'not found' });
});
app.delete('/api/sessions/:id', (req, res) => { deleteSession(String(req.params.id)); res.json({ ok: true }); });

// Activity timeline endpoints
app.get('/api/activity', (req, res) => {
  const after = req.query.after ? new Date(req.query.after).getTime() : undefined;
  const before = req.query.before ? new Date(req.query.before).getTime() : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  const events = readEvents({ after, before, limit });
  res.json({ events });
});

app.get('/api/activity/stats', (req, res) => {
  const after = req.query.after ? new Date(req.query.after).getTime() : Date.now() - (24 * 60 * 60 * 1000); // Default: last 24 hours
  const stats = getStatsSince(after);
  res.json(stats);
});

app.get('/api/ssh-hosts', (_req, res) => res.json({ hosts: allSshHosts(), configured: cfg.hosts }));

// Host health check endpoint
app.get('/api/hosts/health', async (req, res) => {
  const hosts = Array.isArray(req.query.hosts) ? req.query.hosts : cfg.hosts;
  const healthChecks = await Promise.all(
    hosts.map(async (host) => {
      try {
        const result = await validateHost(host, cfg);
        return { host, ...result };
      } catch (e) {
        return { host, ok: false, error: e.message };
      }
    })
  );
  res.json({ hosts: healthChecks, timestamp: Date.now() });
});

// Host connectivity status endpoint for sidebar indicators
app.get('/api/hosts/status', async (_req, res) => {
  const hosts = [LOCAL, ...cfg.hosts];
  const results = await Promise.all(
    hosts.map((host) => checkHost(host, validateHost, cfg))
  );
  res.json({ hosts: results });
});

// ---- Collections API ----
// GET /api/collections - List all collections
app.get('/api/collections', (_req, res) => {
  try {
    const allCollections = collections.loadCollections();
    res.json({ collections: allCollections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/collections - Create new collection
app.post('/api/collections', (req, res) => {
  try {
    const { name, criteria, metadata } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required (string)' });
    }
    const newCollection = collections.createCollection(name, criteria, metadata);
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
app.patch('/api/collections/:id', (req, res) => {
  try {
    const id = String(req.params.id);
    const updates = req.body;
    const updated = collections.updateCollection(id, updates);
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
app.delete('/api/collections/:id', (req, res) => {
  try {
    const id = String(req.params.id);
    const deleted = collections.deleteCollection(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Collection not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/collections/:id/agents - Get agents matching collection criteria
app.get('/api/collections/:id/agents', async (req, res) => {
  try {
    const id = String(req.params.id);
    const allCollections = collections.loadCollections();
    const collection = allCollections.find((c) => c.id === id);
    if (!collection) {
      return res.status(404).json({ error: 'Collection not found' });
    }
    const chats = cache;
    const agents = collections.getAgentsInCollection(collection, chats);
    res.json({ agents, count: agents.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config — return current configuration (safe subset)
app.get('/api/config', (_req, res) => res.json({
  hosts: cfg.hosts,
  pollIntervalMs: cfg.pollIntervalMs,
  tmuxSession: cfg.tmuxSession,
  connectTimeout: cfg.connectTimeout,
  // Observer settings
  observerConfirmMode: cfg.observerConfirmMode,
  observerAutoStart: cfg.observerAutoStart,
  observerSessionTimeout: cfg.observerSessionTimeout,
  confirmDestructiveActions: cfg.confirmDestructiveActions,
  notifyChatOps: cfg.notifyChatOps,
  notifyErrors: cfg.notifyErrors,
  notifySuccess: cfg.notifySuccess,
  notifyObserver: cfg.notifyObserver,
  // Display customization
  showHostTags: cfg.showHostTags,
  showTypeBadges: cfg.showTypeBadges,
  showStatusIndicators: cfg.showStatusIndicators,
  showProjectBadges: cfg.showProjectBadges,
  hideOfflineHosts: cfg.hideOfflineHosts,
}));

// PUT /api/config — update configuration and persist
app.put('/api/config', (req, res) => {
  const { hosts, pollIntervalMs, tmuxSession, connectTimeout,
          observerConfirmMode, observerAutoStart, observerSessionTimeout,
          confirmDestructiveActions,
          notifyChatOps, notifyErrors, notifySuccess, notifyObserver,
          showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges,
          hideOfflineHosts } = req.body;
  if (hosts && Array.isArray(hosts)) cfg.hosts = hosts;
  if (typeof pollIntervalMs === 'number') cfg.pollIntervalMs = pollIntervalMs;
  if (typeof tmuxSession === 'string') cfg.tmuxSession = tmuxSession;
  if (typeof connectTimeout === 'number') cfg.connectTimeout = connectTimeout;
  // Observer settings
  if (observerConfirmMode && ['always', 'auto-safe'].includes(observerConfirmMode)) cfg.observerConfirmMode = observerConfirmMode;
  if (typeof observerAutoStart === 'boolean') cfg.observerAutoStart = observerAutoStart;
  if (observerSessionTimeout === null ||
      (typeof observerSessionTimeout === 'number' &&
       Number.isFinite(observerSessionTimeout) &&
       observerSessionTimeout > 0)) cfg.observerSessionTimeout = observerSessionTimeout;
  // Safety preference: confirm before destructive actions (force-kill, kill chat)
  if (typeof confirmDestructiveActions === 'boolean') cfg.confirmDestructiveActions = confirmDestructiveActions;
  // Notification preferences (toast categories). Only accept booleans so a
  // malformed body can't blank out a preference.
  if (typeof notifyChatOps === 'boolean') cfg.notifyChatOps = notifyChatOps;
  if (typeof notifyErrors === 'boolean') cfg.notifyErrors = notifyErrors;
  if (typeof notifySuccess === 'boolean') cfg.notifySuccess = notifySuccess;
  if (typeof notifyObserver === 'boolean') cfg.notifyObserver = notifyObserver;
  // Display customization
  if (typeof showHostTags === 'boolean') cfg.showHostTags = showHostTags;
  if (typeof showTypeBadges === 'boolean') cfg.showTypeBadges = showTypeBadges;
  if (typeof showStatusIndicators === 'boolean') cfg.showStatusIndicators = showStatusIndicators;
  if (typeof showProjectBadges === 'boolean') cfg.showProjectBadges = showProjectBadges;
  if (typeof hideOfflineHosts === 'boolean') cfg.hideOfflineHosts = hideOfflineHosts;
  save(cfg); // persist to ~/.yatfa-warden/config.json
  res.json({ ok: true });
});

// GET /api/pins — return the list of pinned chat ids
app.get('/api/pins', (_req, res) => res.json({ pins: cfg.pins || [] }));

// PUT /api/pins — update the pinned chat id list and persist
app.put('/api/pins', (req, res) => {
  const { pins } = req.body;
  if (!Array.isArray(pins)) return res.status(400).json({ error: 'pins must be an array' });
  cfg.pins = pins;
  save(cfg);
  res.json({ ok: true, pins });
});

app.get('/api/this-session', (_req, res) => res.json({
  sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
  claudePath: process.env.CLAUDE_CODE_EXECPATH || null,
  cwd: process.cwd(),
}));

// Global cross-pane search: captures and searches across all open panes
app.get('/api/search-pane', async (req, res) => {
  const query = String(req.query.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query required' });

  const paneKeys = String(req.query.panes || '').split(',').filter(Boolean);
  const chats = paneKeys.map((key) => cache.find((c) => c.key === key)).filter(Boolean);

  if (chats.length === 0) return res.json({ results: [], query });

  try {
    const captures = await capturePanes(chats, cfg);
    const results = [];

    for (const [key, content] of Object.entries(captures)) {
      const lines = content.split('\n');
      const chat = chats.find((c) => c.key === key);
      if (!chat) continue;

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

// ---- Claude Code session list (for the per-host "resume" list) ----
function parseJsonlHead(text) {
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
function localClaudeSessions(limit = 40) {
  return collectLocalSessionFiles().slice(0, limit).map((f) => {
    let cwd = '';
    let summary = '';
    try {
      const fd = fs.openSync(f.file, 'r');
      const buf = Buffer.alloc(8192);
      fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      ({ cwd, summary } = parseJsonlHead(buf.toString('utf8')));
    } catch { /* noop */ }
    return { id: f.id, cwd, summary, mtime: f.mtime };
  }).filter((s) => s.cwd);
}
// `limit` bounds the returned list (most-recent first). Defaults to 40 so
// `/api/claude-sessions` is unchanged; the "All Sessions" endpoint passes a
// larger window for pagination (WARDEN-176). The remote script already walks
// every file and transfers each head, so the per-request SSH cost is the same
// regardless of limit — only the in-Node slice changes.
async function remoteClaudeSessions(host, limit = 40) {
  const script = `for f in ~/.claude/projects/*/*.jsonl; do [ -f "$f" ] || continue; id=$(basename "$f" .jsonl); mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null); printf '___S\\t%s\\t%s\\n' "$id" "$mt"; head -c 6000 "$f"; printf '\\n___E\\t%s\\n' "$id"; done`;
  const res = await run(host, script, { timeout: 15000 });
  if (!res.ok) return [];
  const out = [];
  let cur = null;
  const buf = [];
  for (const line of res.stdout.split('\n')) {
    const sm = line.match(/^___S\t(\S+)\t(\d+)/);
    if (sm) { cur = { id: sm[1], mtime: Number(sm[2]) * 1000 }; buf.length = 0; continue; }
    if (/^___E\t/.test(line)) {
      if (cur) {
        const { cwd, summary } = parseJsonlHead(buf.join('\n'));
        if (cwd) out.push({ id: cur.id, cwd, summary, mtime: cur.mtime });
      }
      cur = null;
      continue;
    }
    if (cur) buf.push(line);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

// ---- full-content session search (WARDEN-161) ----
// Caps: per-host before merge, then global after recency sort. A per-host cap
// stops one prolific host from starving the others; the global cap bounds the
// response. The remote transfer caps (head bytes for cwd/summary, snippet bytes
// for the matched line) keep one giant tool_result line from flooding SSH.
const SESSION_SEARCH_PER_HOST = 20;
const SESSION_SEARCH_GLOBAL = 50;
const SESSION_SEARCH_HEAD_BYTES = 6000;    // matches remoteClaudeSessions' `head -c`
const SESSION_SEARCH_SNIP_TRANSFER = 1500; // bounded matched-line transfer over SSH
// Cap on matching files gathered locally before the recency sort (grep -m1 emits
// one row per file). High enough to honor recency ranking across a real archive,
// bounded so a wildly common term can't stream unbounded output. statSync'ing a
// few hundred files is cheap; only the top PER_HOST get a head read.
const SESSION_SEARCH_LOCAL_SCAN = 500;

// Search the local JSONL archive for sessions whose body contains `q` (literal,
// case-insensitive — same fixed-string semantics as the remote `grep -F`). Returns
// up to SESSION_SEARCH_PER_HOST matches, most-recent first, each with cwd/summary
// (from the head) + a snippet (from the first matching line), so matches OUTSIDE
// the top-40 list are found.
//
// Streams ONE `grep -r -m1` over the archive and bounds output AT THE SOURCE
// (line count + per-line transfer cap via streamBoundedSearch) — it never reads
// whole JSONL files into Node memory. This mirrors searchLocalRaw's pattern (the
// workspace-content search): a whole-file readFileSync approach would block the
// event loop and balloon memory on large transcripts. The query is a literal argv
// element (no shell), so it needs no shellQuote.
export async function searchLocalClaudeSessions(q) {
  const needle = q.toLowerCase();
  if (!needle) return [];
  const archiveDir = path.join(os.homedir(), '.claude', 'projects');
  try { if (!fs.statSync(archiveDir).isDirectory()) return []; } catch { return []; }
  const raw = await streamBoundedSearch(
    'grep', ['-r', '-m', '1', '--include=*.jsonl', '-F', '-i', '-I', '-n', '--', q, archiveDir], undefined,
    { maxResults: SESSION_SEARCH_LOCAL_SCAN, transferLen: SESSION_SEARCH_SNIP_TRANSFER },
  );
  // grep -m1 emits one `file:line:text` row per matching file. Collect them, sort
  // by recency, then enrich the most-recent SESSION_SEARCH_PER_HOST with cwd/summary
  // (a small head read) + a cleaned snippet (from grep's matched-line text).
  // parseSearchOutput's per-line cap is raised to the transfer cap so a needle
  // deep in a long matched line (but within the bounded transfer) survives to the
  // snippet builder instead of being chopped at the default 300-char display cap.
  const ranked = [];
  for (const row of parseSearchOutput(raw, SESSION_SEARCH_LOCAL_SCAN, SESSION_SEARCH_SNIP_TRANSFER)) {
    let mtime;
    try { mtime = fs.statSync(row.file).mtimeMs; } catch { continue; }
    ranked.push({ file: row.file, text: row.text, mtime });
  }
  ranked.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const e of ranked) {
    if (out.length >= SESSION_SEARCH_PER_HOST) break;
    let head = '';
    try {
      const fd = fs.openSync(e.file, 'r');
      const buf = Buffer.alloc(8192);
      fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      head = buf.toString('utf8');
    } catch { continue; }
    const { cwd, summary } = parseJsonlHead(head);
    if (!cwd) continue;
    // Push UNCONDITIONALLY — grep genuinely matched this file, so the session
    // must surface even when a clean snippet can't be built. snippetFromLine
    // returns '' when the needle sits past the 1500-byte matched-line transfer
    // cap (e.g. an error string deep inside a large tool_result blob): the cap
    // chops the line before the needle, but that's a snippet-quality issue, not
    // a "this session didn't match" signal. Dropping it here would be a false
    // negative that breaks "a phrase inside the body returns that session". The
    // remote twin pushes regardless of snippet (see remoteSearchClaudeSessions),
    // the frontend renders an empty snippet as nothing — so push here too, to
    // keep the two implementations consistent.
    const snippet = snippetFromLine(e.text, needle);
    out.push({ id: path.basename(e.file, '.jsonl'), cwd, summary, snippet, mtime: e.mtime });
  }
  return out;
}

// Remote (SSH) twin of searchLocalClaudeSessions. Builds a `bash -lc` script that
// walks the same ~/.claude/projects/*/*.jsonl archive, greps each file for the
// literal query, and emits id/mtime/head/snippet per match — delimited with the
// same ___S/___E markers remoteClaudeSessions uses. Exported so the quoting can
// be unit-tested like buildSearchScript (the query is user input in a remote
// shell: shellQuoted + `-F` literal + `--` option stop = no injection surface).
export function buildSessionSearchScript(q) {
  const sq = shellQuote(q);
  return `set +o pipefail
for f in ~/.claude/projects/*/*.jsonl; do
  [ -f "$f" ] || continue
  m=$(grep -m1 -F -i -I -- ${sq} "$f" 2>/dev/null | head -c ${SESSION_SEARCH_SNIP_TRANSFER})
  [ -n "$m" ] || continue
  id=$(basename "$f" .jsonl)
  mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
  printf '___S\\t%s\\t%s\\n' "$id" "$mt"
  head -c ${SESSION_SEARCH_HEAD_BYTES} "$f"
  printf '\\n___SNIP\\t'
  printf '%s' "$m"
  printf '\\n___E\\t%s\\n' "$id"
done`;
}

// Parse the remote script's delimited output into {id, cwd, summary, snippet,
// mtime} rows. Mirrors remoteClaudeSessions' ___S/___E state machine, adding the
// ___SNIP line (the bounded matched line, cleaned server-side via snippetFromLine
// so the snippet stays human-readable regardless of where grep matched).
async function remoteSearchClaudeSessions(host, q) {
  const needle = q.toLowerCase();
  const res = await run(host, buildSessionSearchScript(q), { timeout: 15000 });
  if (!res.ok) return [];
  const out = [];
  let cur = null;
  const buf = [];
  for (const line of res.stdout.split('\n')) {
    const sm = line.match(/^___S\t(\S+)\t(\d+)/);
    if (sm) { cur = { id: sm[1], mtime: Number(sm[2]) * 1000, snippet: '' }; buf.length = 0; continue; }
    const snm = line.match(/^___SNIP\t(.*)$/);
    if (snm && cur) { cur.snippet = snippetFromLine(snm[1], needle); continue; }
    if (/^___E\t/.test(line)) {
      if (cur) {
        const { cwd, summary } = parseJsonlHead(buf.join('\n'));
        if (cwd) out.push({ id: cur.id, cwd, summary, snippet: cur.snippet, mtime: cur.mtime });
      }
      cur = null;
      continue;
    }
    if (cur) buf.push(line);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, SESSION_SEARCH_PER_HOST);
}

app.get('/api/claude-sessions', async (req, res) => {
  const host = String(req.query.host || LOCAL);
  const sessions = host === LOCAL ? localClaudeSessions() : await remoteClaudeSessions(host);
  const claudeAvailable = !!(await detectClaude(host));
  res.json({ sessions, claudeAvailable });
});
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
  return { sessions: all.slice(offset, offset + limit), hasMore: all.length > offset + limit };
}

// Page-size guardrails for the unified "All Sessions" endpoint. Default 40 matches
// the old hard global cap (so page 1 is unchanged), clamped to bound remote cost.
const ALL_SESSIONS_DEFAULT_LIMIT = 40;
const ALL_SESSIONS_MAX_LIMIT = 200;
// Per-host fetch window ceiling. The endpoint asks for offset+limit+1 per host so
// `hasMore` is honest (see mergeAndPaginateSessions); this clamp bounds memory and
// remote transfer for pathological scale — far above any realistic page window.
const ALL_SESSIONS_MAX_PER_HOST = 1000;

app.get('/api/claude-sessions-all', async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(
    ALL_SESSIONS_MAX_LIMIT,
    Math.max(1, parseInt(req.query.limit, 10) || ALL_SESSIONS_DEFAULT_LIMIT),
  );
  // Per-host window: offset+limit+1 so the global boundary item is always fetched
  // and `hasMore` is computed honestly (clamped to bound remote SSH cost).
  const perHost = Math.min(ALL_SESSIONS_MAX_PER_HOST, offset + limit + 1);
  const hosts = [LOCAL, ...cfg.hosts];
  const results = await Promise.allSettled(hosts.map(async (host) => {
    const sessions = host === LOCAL ? localClaudeSessions(perHost) : await remoteClaudeSessions(host, perHost);
    return { host, sessions };
  }));
  const buckets = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => ({ host: r.value.host, sessions: r.value.sessions }));
  const { sessions, hasMore } = mergeAndPaginateSessions(buckets, offset, limit);
  res.json({ sessions, hasMore });
});

// GET /api/claude-sessions-search?q= — full-content search across EVERY host's
// JSONL archive, returning recency-ranked matches (incl. sessions outside the
// top-40 list). One unreachable host degrades to "no matches from it" via
// Promise.allSettled — it never fails the whole search. Response shape:
//   { results: [{ host, sessionId, cwd, summary, snippet, mtime }] }
app.get('/api/claude-sessions-search', async (req, res) => {
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

// Run git locally: captured stdout, inherited stderr, in a HIDDEN window. Centralizing
// the spawn options (esp. windowsHide) keeps local git calls from flashing a visible
// console window when warden runs as a packaged/detached app. Used by /api/git-status
// and /api/git-log. Remote chats go through run() (ssh.js), which already hides.
function runLocalGit(args, cwd) {
  return spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
}

app.get('/api/git-status', async (req, res) => {
  const chatId = String(req.query.id || '');
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  try {
    const cwd = chat.cwd || (chat.host === LOCAL ? process.cwd() : '');
    if (!cwd) return res.json({ branch: null, clean: null, cwd: '', ahead: null, behind: null, inProgress: { operation: null }, stashCount: null, files: null, error: 'no cwd' });

    let branch = '';
    let clean = true;
    let files = [];
    let ahead = null;
    let behind = null;
    let inProgressOp = null;
    let stashCount = null;

    if (chat.host === LOCAL) {
      // Local execution: use spawnSync directly
      const branchResult = runLocalGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      branch = branchResult.stdout?.toString().trim() || '';

      const statusResult = runLocalGit(['status', '--porcelain'], cwd);
      const statusRaw = statusResult.stdout?.toString() || '';
      // NOTE: parse the raw bytes — git status codes can start with a leading
      // space (" M" = unstaged mod), so the output must NOT be trimmed as a
      // whole or the first file's path is corrupted. See parseGitStatusPorcelain.
      files = parseGitStatusPorcelain(statusRaw);
      clean = files.length === 0;

      // ahead/behind upstream: @{u}...HEAD symmetric diff. Non-zero exit (no
      // upstream, detached HEAD, non-git cwd) → empty stdout → nulls. Mirrors
      // the branch call's spawnSync shape. See parseAheadBehind.
      const abResult = runLocalGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd);
      ({ ahead, behind } = parseAheadBehind(abResult.stdout?.toString() || ''));

      // Detect an in-progress operation (merge/cherry-pick/revert/rebase/bisect)
      // by stat'ing the well-known state files git writes under the git dir. A
      // repo can only be in ONE such state, so first match wins. Resolved via
      // `git rev-parse --git-dir` (relative like ".git" → resolved against cwd)
      // mirroring the branch call; a non-git/no-cwd cwd → empty git dir → no
      // markers → null (graceful, never a 500). Display only (WARDEN-28).
      const gitDirResult = runLocalGit(['rev-parse', '--git-dir'], cwd);
      const gitDir = gitDirResult.stdout?.toString().trim() || '';
      if (gitDir) {
        const gd = path.resolve(cwd, gitDir);
        if (fs.existsSync(path.join(gd, 'MERGE_HEAD'))) inProgressOp = 'merge';
        else if (fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD'))) inProgressOp = 'cherry-pick';
        else if (fs.existsSync(path.join(gd, 'REVERT_HEAD'))) inProgressOp = 'revert';
        else if (fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'))) inProgressOp = 'rebase';
        else if (fs.existsSync(path.join(gd, 'BISECT_LOG'))) inProgressOp = 'bisect';
      }

      // Shelved WIP: `git stash list` emits one line per stash, empty when none.
      // --porcelain status never surfaces stashes, so a clean tree with parked
      // work would otherwise read clean:true — count the list so the badge can
      // show 🗄 N (WARDEN-211). Non-git/empty → parseStashCount nulls it.
      const stashResult = runLocalGit(['stash', 'list'], cwd);
      stashCount = parseStashCount(stashResult.stdout?.toString() || '');
    } else {
      // Remote execution: use SSH
      const gitBranchCmd = `cd ${shellQuote(cwd)} && git rev-parse --abbrev-ref HEAD 2>/dev/null`;
      const gitStatusCmd = `cd ${shellQuote(cwd)} && git status --porcelain 2>/dev/null`;
      // The @{u}...HEAD rev spec is a constant, but we shellQuote it anyway:
      // '{' / '}' risk brace expansion in some shells, and this is consistent
      // with how git-log quotes its --pretty constant (WARDEN-122 quoting lesson).
      const gitAheadBehindCmd = `cd ${shellQuote(cwd)} && git rev-list --left-right --count ${shellQuote('@{u}...HEAD')} 2>/dev/null`;

      const r1 = await run(chat.host, gitBranchCmd, { timeout: 8000 });
      branch = r1.ok ? r1.stdout.trim() : '';

      const r2 = await run(chat.host, gitStatusCmd, { timeout: 8000 });
      const statusRaw = r2.ok ? (r2.stdout || '') : '';
      // NOTE: parse the raw bytes — git status codes can start with a leading
      // space (" M" = unstaged mod), so the output must NOT be trimmed as a
      // whole or the first file's path is corrupted. See parseGitStatusPorcelain.
      files = parseGitStatusPorcelain(statusRaw);
      clean = files.length === 0;

      const r3 = await run(chat.host, gitAheadBehindCmd, { timeout: 8000 });
      ({ ahead, behind } = parseAheadBehind(r3.ok ? (r3.stdout || '') : ''));

      // Detect an in-progress operation remotely with ONE combined `test` over
      // the resolved git dir — same markers/order as the local branch (first
      // match wins; a repo can only be in one state). `2>/dev/null` on the
      // rev-parse swallows the non-git/detached case so a clean or non-git repo
      // emits nothing → operation: null. Mirrors the r1/r2/r3 run()+shellQuote
      // split. Display only (WARDEN-28).
      const gitInProgCmd =
        `cd ${shellQuote(cwd)} && gd=$(git rev-parse --git-dir 2>/dev/null) && ` +
        `{ [ -f "$gd/MERGE_HEAD" ] && echo merge; ` +
        `[ -f "$gd/CHERRY_PICK_HEAD" ] && echo cherry-pick; ` +
        `[ -f "$gd/REVERT_HEAD" ] && echo revert; ` +
        `[ -d "$gd/rebase-merge" ] && echo rebase; ` +
        `[ -d "$gd/rebase-apply" ] && echo rebase; ` +
        `[ -f "$gd/BISECT_LOG" ] && echo bisect; }`;
      const r4 = await run(chat.host, gitInProgCmd, { timeout: 8000 });
      // The `{ ... }` group's exit status is that of its LAST test, which is
      // non-zero whenever BISECT_LOG is absent — true even mid-merge (only
      // MERGE_HEAD matches). So r4.ok is UNRELIABLE here: parse stdout instead.
      // The group emits one op per matching marker; take the first (priority order).
      const first = (r4.stdout || '').split('\n').map((l) => l.trim()).find(Boolean);
      if (first) inProgressOp = first;

      // Shelved WIP over SSH — same one-line-per-stash format as the local path.
      // 2>/dev/null swallows the non-git case so an empty/erroring repo yields ''
      // → parseStashCount null (WARDEN-211).
      const gitStashCmd = `cd ${shellQuote(cwd)} && git stash list 2>/dev/null`;
      const r5 = await run(chat.host, gitStashCmd, { timeout: 8000 });
      stashCount = parseStashCount(r5.ok ? (r5.stdout || '') : '');
    }

    res.json({
      branch: branch || null,
      clean: branch ? clean : null,
      cwd,
      ahead: branch ? ahead : null,
      behind: branch ? behind : null,
      inProgress: { operation: branch ? inProgressOp : null },
      stashCount: branch ? stashCount : null,
      files: branch ? files : null,
      error: null,
    });
  } catch (e) {
    res.json({ branch: null, clean: null, cwd: chat.cwd || '', ahead: null, behind: null, inProgress: { operation: null }, stashCount: null, files: null, error: e.message });
  }
});

// Parse one `--pretty=format:%h|%s|%an|%ar` line into { hash, subject, author, date }.
// The hash is the first field (never contains '|') and the relative date is the last
// (also never contains '|'); the subject sits between them and MAY contain '|' (a commit
// message like "merge a | b"). So we peel the hash off the front and the date off the back,
// then split the middle on its LAST '|' (author is assumed pipe-free). Exported for tests.
export function parseGitLogLine(line) {
  const firstPipe = line.indexOf('|');
  if (firstPipe === -1) return { hash: line, subject: '', author: '', date: '' };
  const hash = line.slice(0, firstPipe);
  const tail = line.slice(firstPipe + 1);
  const lastPipe = tail.lastIndexOf('|');
  if (lastPipe === -1) return { hash, subject: tail, author: '', date: '' };
  const date = tail.slice(lastPipe + 1);
  const mid = tail.slice(0, lastPipe);
  const midPipe = mid.lastIndexOf('|');
  if (midPipe === -1) return { hash, subject: mid, author: '', date };
  return { hash, subject: mid.slice(0, midPipe), author: mid.slice(midPipe + 1), date };
}

// Parse `git show --name-status --pretty=format: <hash>` output into [{ path, status }].
// Each line is `<code>\t<path>` where the code is a single letter (A/M/D/T) or a
// rename/copy with a similarity score (`R100`/`C75`) followed by `old<TAB>new`. The
// {path,status} shape intentionally matches `GitFile` so the frontend's
// `GitChangedFile` row renders touched files unchanged. For rename/copy we report the
// NEW path (it exists at that commit, so a per-file `git show` on it works) and a
// single-letter status. Exported for unit tests. See WARDEN-180.
export function parseGitShowNameStatus(output) {
  const raw = (output ?? '').toString();
  const out = [];
  for (const line of raw.split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue; // not a name-status record
    const code = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    const letter = code[0]; // A / M / D / T / R / C
    // Rename (R<score>) / copy (C<score>): "R100\told\tnew" → take the new path.
    // Otherwise: "M\tpath".
    const path = (letter === 'R' || letter === 'C') ? rest.slice(rest.indexOf('\t') + 1) : rest;
    if (path) out.push({ status: letter || code, path });
  }
  return out;
}

// The `--pretty=format:` used by /api/git-log: short hash | subject | author |
// relative date. Shared by the local (spawnSync) and remote (SSH) paths so the two
// can't drift. The '|' separators are shellQuote'd on the remote path so they aren't
// read as shell pipes (the WARDEN-122 quoting lesson).
const GIT_LOG_PRETTY = '%h|%s|%an|%ar';

// Build the remote SSH command for /api/git-log. Exported so its shellQuoting — of
// BOTH the pretty format and the HEAD..@{u} rev range — is unit-testable, mirroring
// buildGitDiffScript. `incoming` splices in `HEAD..@{u}` (commits the upstream has
// that HEAD doesn't); the token is shellQuote'd because its '{'/'}' risk brace
// expansion in some shells — the same reason /api/git-status quotes '@{u}...HEAD'.
// 2>/dev/null keeps the no-upstream case exit-clean with empty stdout so the route
// returns { commits: [], error: null } (200, not a 500).
export function buildGitLogCmd(cwd, limit, incoming) {
  const range = incoming ? ` ${shellQuote('HEAD..@{u}')}` : '';
  return `cd ${shellQuote(cwd)} && git log -${limit}${range} --pretty=format:${shellQuote(GIT_LOG_PRETTY)} 2>/dev/null`;
}

// Recent commit history (git log) for a chat's repo. Mirrors /api/git-status: local chats
// run git via spawnSync, remote chats run over SSH with shellQuote(cwd). A non-git or no-cwd
// repo yields an empty list (never a 500). limit is clamped to [1, 50].
app.get('/api/git-log', async (req, res) => {
  const chatId = String(req.query.id || '');
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10) || 5, 1), 50);
  // range=incoming → list commits reachable from @{u} but NOT HEAD (the "behind"
  // commits — what the upstream has that we don't). Absent → today's HEAD-reachable
  // log. @{u} is git's upstream rev spec, already used by /api/git-status's
  // ahead/behind count, so this introduces no new staleness or network fetch. The
  // ahead/behind COUNT shipped in WARDEN-153; this completes the explorable behind
  // half (WARDEN-225). Strictly read-only — no fetch/pull/merge/checkout.
  const incoming = String(req.query.range || '') === 'incoming';
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  try {
    const cwd = chat.cwd || (chat.host === LOCAL ? process.cwd() : '');
    if (!cwd) return res.json({ commits: [], error: 'no cwd' });

    // short hash | subject | author | relative date
    let raw = '';
    if (chat.host === LOCAL) {
      // Local execution: use spawnSync directly. With no rev range, `git log -N`
      // lists HEAD-reachable commits (today's behavior). range=incoming swaps in
      // `HEAD..@{u}` — commits the upstream has that HEAD doesn't. When there is
      // no upstream (detached HEAD / untracked branch / non-git) git exits non-zero
      // with empty stdout → raw stays '' → { commits: [], error: null } (200, not
      // a 500), mirroring parseAheadBehind's null tolerance.
      const args = ['log'];
      if (incoming) args.push('HEAD..@{u}');
      args.push(`-${limit}`, `--pretty=format:${GIT_LOG_PRETTY}`);
      const r = runLocalGit(args, cwd);
      raw = r.stdout?.toString().trim() || '';
    } else {
      // Remote execution: SSH. buildGitLogCmd shellQuotes the pretty format and the
      // HEAD..@{u} range; 2>/dev/null swallows the no-upstream case so a detached-HEAD
      // or untracked remote branch yields empty → 200, never a 500.
      const rr = await run(chat.host, buildGitLogCmd(cwd, limit, incoming), { timeout: 8000 });
      raw = rr.ok ? rr.stdout.trim() : '';
    }

    const commits = raw ? raw.split('\n').map(parseGitLogLine) : [];
    res.json({ commits, error: null });
  } catch (e) {
    res.json({ commits: [], error: e.message });
  }
});

// ---- Per-file git diff (WARDEN-151) ----------------------------------------
// The depth layer between WARDEN-107 (which files changed) and WARDEN-39 (read
// the current file): show WHAT an agent changed in one file. Mirrors
// /api/git-status + /api/read-file: chat-scoped, cwd-contained, local spawnSync
// vs remote `run(host, script)`, with the same path-traversal discipline read-file
// guards against. A diff target may be a DELETED file (status 'D') that no longer
// exists on disk, so the containment check must tolerate a missing path — unlike
// read-file's `realpath -e` (which requires existence).
const GIT_DIFF_MAX_BYTES = 1024 * 1024; // mirrors read-file's 1MB size guard

// Cap diff output to GIT_DIFF_MAX_BYTES. Goes through a Buffer so the truncation is
// byte-accurate AND never splits a multi-byte UTF-8 sequence: toString('utf8') of a
// buffer cut mid-sequence drops the incomplete tail (→ U+FFFD) rather than emitting a
// lone surrogate that would corrupt the JSON response. Only the rare >1MB diff pays
// the Buffer allocation. Exported so the no-lone-surrogate invariant has a test.
export function capDiff(diff) {
  if (Buffer.byteLength(diff) <= GIT_DIFF_MAX_BYTES) return diff;
  return Buffer.from(diff, 'utf8').subarray(0, GIT_DIFF_MAX_BYTES).toString('utf8');
}

// Build the remote (SSH) shell script that diffs one file vs HEAD under `cwd`.
// Extracted (and exported) so the fragile shell template is unit-tested directly,
// the same way buildReadFileScript is. Containment uses `realpath -m` (NOT `-e`):
// a deleted/untracked-not-yet-committed file has no realpath, so `-e` would wrongly
// reject it; `-m` resolves `..` lexically without requiring existence, so the
// cwd-containment `case` still catches `../etc/passwd` escapes. shellQuote yields a
// single-quoted POSIX token spliced in bare — same WARDEN-122 quoting discipline as
// read-file/git-log. The `--` before the path stops option parsing so a path named
// like a flag can't inject options.
export function buildGitDiffScript(cwd, filePath) {
  return `CWD=${shellQuote(cwd)}; FILE=${shellQuote(filePath)}; RESOLVED_CWD="$(cd "$CWD" && pwd -P)" || { echo "ERROR invalid path"; exit 1; }; RESOLVED="$(cd "$RESOLVED_CWD" && realpath -m -- "$FILE" 2>/dev/null)" || RESOLVED="$RESOLVED_CWD/$FILE"; case "$RESOLVED" in "$RESOLVED_CWD"/*|"$RESOLVED_CWD") ;; *) echo "ERROR path must be within working directory"; exit 1 ;; esac; git diff HEAD -- "$FILE" 2>/dev/null`;
}

// Is a cwd-relative `filePath` contained within `cwd`? Mirrors /api/read-file's guard,
// but tolerates a missing target (a deleted file — status 'D' — has no realpath, yet
// its deletion diff is valid). Lexical resolve catches `..` escapes even when the file
// doesn't exist; realpath then hardens against symlink escapes when it does. Exported
// so the local path has a direct unit test. Returns true if the path stays within cwd.
export function isPathWithinCwd(cwd, filePath) {
  const lexicalCwd = path.resolve(cwd);
  const lexicalPath = path.resolve(cwd, filePath);
  const lexicalWithin = lexicalPath === lexicalCwd || lexicalPath.startsWith(lexicalCwd + path.sep);
  if (!lexicalWithin) return false;
  try {
    const realCwd = fs.realpathSync.native(cwd);
    const realPath = fs.realpathSync.native(lexicalPath);
    return realPath === realCwd || realPath.startsWith(realCwd + path.sep);
  } catch {
    // File doesn't exist (deleted, or untracked not yet created): lexical check passed.
    return true;
  }
}

// Diff one file vs HEAD on a LOCAL host. Returns { diff, untracked } or
// { error, status }. An empty diff is ambiguous (clean tracked vs untracked '??'),
// so it's disambiguated with `git ls-files --error-unmatch` (exits non-zero for a
// path git doesn't track) — letting the UI say "untracked" instead of "no changes".
// Output is capped at GIT_DIFF_MAX_BYTES to protect the server. Exported for tests.
export function getLocalGitDiff(cwd, filePath) {
  if (!isPathWithinCwd(cwd, filePath)) {
    return { error: 'path must be within working directory', status: 403 };
  }

  const result = runLocalGit(['diff', 'HEAD', '--', filePath], cwd);
  let diff = capDiff(result.stdout ? result.stdout.toString() : '');

  if (diff.length === 0) {
    // Empty diff is ambiguous: a clean tracked file vs an untracked ('??') file HEAD
    // has no record of. `git ls-files --error-unmatch` exits non-zero for a path git
    // doesn't track. (Containment above already guaranteed the path is within cwd, so
    // a non-zero exit here means untracked, not "outside repo".)
    const tracked = runLocalGit(['ls-files', '--error-unmatch', '--', filePath], cwd);
    if (tracked.status !== 0) return { diff: null, untracked: true };
  }

  return { diff, untracked: false };
}

// Diff one file vs HEAD on a REMOTE host via SSH. Mirrors getLocalGitDiff's result
// shape and untracked disambiguation, but the containment check lives inside
// buildGitDiffScript's bash. The remote untracked check is a second `run` (only made
// when the diff is empty) so the common case stays a single round-trip.
async function getRemoteGitDiff(host, cwd, filePath) {
  const script = buildGitDiffScript(cwd, filePath);
  const r = await run(host, script, { timeout: 8000 });
  if (!r.ok) {
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (out.includes('ERROR path must be within working directory')) {
      return { error: 'path must be within working directory', status: 403 };
    }
    if (out.includes('ERROR invalid path')) {
      return { error: 'invalid path', status: 400 };
    }
    // git diff exits non-zero on a non-git cwd or SSH/pool failure — surface as an
    // error string rather than a 500 (matches git-status/git-log's soft failure).
    return { error: 'diff failed' };
  }

  let diff = capDiff(r.stdout || '');

  if (diff.length === 0) {
    const trackedCmd = `cd ${shellQuote(cwd)} && git ls-files --error-unmatch -- ${shellQuote(filePath)} 2>/dev/null`;
    const t = await run(host, trackedCmd, { timeout: 8000 });
    if (!t.ok) return { diff: null, untracked: true };
  }

  return { diff, untracked: false };
}

// GET /api/git-diff?id=<chatId>&path=<file> — unified diff of one file vs HEAD.
// Response: { diff: string|null, untracked: boolean, path, error }
app.get('/api/git-diff', async (req, res) => {
  const filePath = String(req.query.path || '').trim();
  if (!filePath) return res.status(400).json({ diff: null, untracked: false, path: '', error: 'path is required' });

  const { chat, error } = await resolve(String(req.query.id || ''));
  if (error) return res.status(404).json({ diff: null, untracked: false, path: filePath, error });

  try {
    const cwd = chat.cwd || (chat.host === LOCAL ? process.cwd() : '');
    if (!cwd) return res.json({ diff: null, untracked: false, path: filePath, error: 'no cwd' });

    const result = chat.host === LOCAL
      ? getLocalGitDiff(cwd, filePath)
      : await getRemoteGitDiff(chat.host, cwd, filePath);

    if (result.status) return res.status(result.status).json({ diff: null, untracked: false, path: filePath, error: result.error });
    if (result.error) return res.json({ diff: null, untracked: false, path: filePath, error: result.error });
    res.json({ diff: result.diff, untracked: !!result.untracked, path: filePath, error: null });
  } catch (e) {
    res.json({ diff: null, untracked: false, path: filePath, error: e.message });
  }
});

// Validate a git-show per-file `path` param. We use a LEXICAL check (not realpath)
// because the file may not exist in the working tree — a commit that DELETED it still
// has a diff to show, but `realpath` would throw ENOENT and wrongly block it. A
// relative path with no `..` segment and no absolute/home-relative prefix cannot
// escape the repo root that `git show` resolves against. Rejects null bytes, POSIX
// and Windows absolute paths, `~`-relative paths, and any `..` traversal segment.
// Distinct from isPathWithinCwd (WARDEN-151): that one guards a working-tree FILE
// (realpath-hardened against symlink escapes), whereas this validates a git pathspec
// against an arbitrary commit — a path the current tree may not even contain — so a
// purely lexical rule is the right containment model here.
function isSafeRelativePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.split(/[\\/]/).some((seg) => seg === '..')) return false;
  return true;
}

// Inspect a single commit (git show). Mirrors /api/git-log: local chats run git via
// spawnSync, remote chats run over SSH with shellQuote(cwd)+shellQuote(hash). A
// non-git / no-cwd / unknown-hash repo yields an empty result (never a 500).
//
//   GET /api/git-show?id=<chatId>&hash=<hash>           → { files: [{path,status}] }
//   GET /api/git-show?id=<chatId>&hash=<hash>&path=<p>  → { diff: "<patch text>" }
//
// `hash` is clamped to short/long hex ([0-9a-f]{4,40}) — anything else (e.g.
// "--version", shell metacharacters) is rejected before it reaches git or the remote
// shell, mirroring the shellQuote care taken in /api/git-log. `path`, when present,
// is a git pathspec and gets the isSafeRelativePath containment check.
app.get('/api/git-show', async (req, res) => {
  const chatId = String(req.query.id || '');
  const hash = String(req.query.hash || '');
  const filePath = String(req.query.path || '').trim();
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  // Reject malformed hashes before any git invocation: hex only, 4–40 chars.
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    return res.json({ files: [], diff: null, error: 'invalid hash' });
  }
  // Reject unsafe per-file paths (absolute / traversal). Bad path → empty, never 500.
  if (filePath && !isSafeRelativePath(filePath)) {
    return res.json({ files: [], diff: null, error: 'invalid path' });
  }

  try {
    const cwd = chat.cwd || (chat.host === LOCAL ? process.cwd() : '');
    if (!cwd) return res.json({ files: [], diff: null, error: 'no cwd' });

    let files = [];
    let diff = null;

    if (chat.host === LOCAL) {
      if (filePath) {
        // --format= strips the commit header (author/date/message) so we get ONLY the
        // file's patch — exactly what inspecting a single file should surface.
        const r = runLocalGit(['show', '--format=', hash, '--', filePath], cwd);
        diff = capDiff(r.stdout?.toString() || '');
      } else {
        const r = runLocalGit(['show', '--name-status', '--pretty=format:', hash], cwd);
        files = parseGitShowNameStatus(r.stdout?.toString() || '');
      }
    } else {
      if (filePath) {
        const cmd = `cd ${shellQuote(cwd)} && git show --format= ${shellQuote(hash)} -- ${shellQuote(filePath)} 2>/dev/null`;
        const rr = await run(chat.host, cmd, { timeout: 8000 });
        diff = capDiff(rr.ok ? (rr.stdout || '') : '');
      } else {
        const cmd = `cd ${shellQuote(cwd)} && git show --name-status --pretty=format: ${shellQuote(hash)} 2>/dev/null`;
        const rr = await run(chat.host, cmd, { timeout: 8000 });
        files = parseGitShowNameStatus(rr.ok ? (rr.stdout || '') : '');
      }
    }

    res.json({ files, diff, error: null });
  } catch (e) {
    res.json({ files: [], diff: null, error: e.message });
  }
});

// Shelved work-in-progress detail (git stash list). Mirrors /api/git-log: local
// chats run git via spawnSync, remote chats run over SSH with shellQuote(cwd).
// We reuse git-log's --pretty pipe format (`%gd|%s|%cr`) so the subject (which
// may itself contain '|') is peeled front/back by the exported `parseStashList`
// helper. A non-git / no-cwd / stash-free repo yields an empty list (never a
// 500). The eager per-chat count lives in /api/git-status's `stashCount`; this
// endpoint is the lazy detail fetched only when the stash section is opened.
//
//   GET /api/git-stash?id=<chatId>  → { stashes: [{ ref, subject, date }], error }
app.get('/api/git-stash', async (req, res) => {
  const chatId = String(req.query.id || '');
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  try {
    const cwd = chat.cwd || (chat.host === LOCAL ? process.cwd() : '');
    if (!cwd) return res.json({ stashes: [], error: 'no cwd' });

    // reflog selector | subject | relative date  (subject may contain '|')
    const pretty = '%gd|%s|%cr';
    let raw = '';
    if (chat.host === LOCAL) {
      // Local execution: use spawnSync directly
      const r = runLocalGit(['stash', 'list', `--pretty=format:${pretty}`], cwd);
      raw = r.stdout?.toString().trim() || '';
    } else {
      // Remote execution: SSH. shellQuote the pretty format so the '|' separators
      // aren't interpreted as shell pipes (same WARDEN-122 quoting lesson as git-log).
      const cmd = `cd ${shellQuote(cwd)} && git stash list --pretty=format:${shellQuote(pretty)} 2>/dev/null`;
      const rr = await run(chat.host, cmd, { timeout: 8000 });
      raw = rr.ok ? rr.stdout.trim() : '';
    }

    const stashes = raw ? parseStashList(raw) : [];
    res.json({ stashes, error: null });
  } catch (e) {
    res.json({ stashes: [], error: e.message });
  }
});

// If cmd invokes bare `claude`, replace it with the full path found on the host —
// claude is often in a .zshrc-only PATH that tmux's shell (bash) can't see.
async function resolveClaudeCmd(host, cmd) {
  if (!/^claude(\s|$)/.test(cmd)) return { cmd };
  const claudePath = await detectClaude(host);
  if (!claudePath) return { error: `\`claude\` not found on ${host}. Install it or add its dir to PATH (e.g. ~/.local/bin).` };
  return { cmd: cmd.replace(/^claude(\s|$)/, (_m, sp) => `${claudePath}${sp}`) };
}

app.post('/api/rename', (req, res) => {
  const session = String(req.body?.session || '');
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!session || !name) return res.status(400).json({ error: 'session and name required' });
  const catalog = loadCatalog();
  const entry = catalog.find((c) => c.session === session);
  if (!entry) return res.status(404).json({ error: 'not a renameable chat' });
  entry.name = name;
  saveCatalog(catalog);
  res.json({ ok: true });
});

// Spawn a chat (always tmux). host '(local)' → this machine; remote → host tmux.
async function buildAndSpawn({ host, session, name, cwd, cmd }) {
  const err = await preflightTmux(host);
  if (err) return { error: err, status: 400 };
  const resolved = await resolveClaudeCmd(host, cmd);
  if (resolved.error) return { error: resolved.error, status: 400 };
  const finalCmd = resolved.cmd;
  const chat = { host, session, cwd, cmd: finalCmd, name: name || session };
  try { await spawnTmux(chat); }
  catch (e) { return { error: e.message, status: 500 }; }
  // The session must actually be alive — `new-session -d` returns ok even when the
  // command inside fails to start, leaving no session.
  if (!(await hasSession(chat, cfg))) {
    const bin = String(finalCmd || '').split(/\s+/)[0] || 'the command';
    return { error: `\`${bin}\` failed to start on ${host} — tmux session died immediately. Is it installed and on PATH there?`, status: 500 };
  }
  return { chat: { id: `${host}:${session}`, key: session, kind: 'tmux', host, container: null, session, project: 'manual', role: 'claude', name: chat.name, cwd, cmd: finalCmd, active: true } };
}

app.post('/api/spawn', async (req, res) => {
  const host = String(req.body?.host || LOCAL).trim() || LOCAL;
  const session = String(req.body?.session || '').trim();
  const cwd = String(req.body?.cwd || '').trim();
  const cmd = String(req.body?.cmd || 'claude --dangerously-skip-permissions').trim();
  if (!session) return res.status(400).json({ error: 'session name is required' });
  if (!NAME_RE.test(session)) return res.status(400).json({ error: 'invalid session name (letters/digits/_-.)' });
  const catalog = loadCatalog();
  if (catalog.some((c) => c.session === session)) return res.status(409).json({ error: `"${session}" already exists` });
  const r = await buildAndSpawn({ host, session, name: req.body?.name || session, cwd, cmd });
  if (r.error) return res.status(r.status).json({ error: r.error });
  saveCatalog([...catalog, { kind: 'tmux', host, session, name: r.chat.name, cwd, cmd }]);
  res.json({ ok: true, chat: r.chat });
});

app.post('/api/resume', async (req, res) => {
  const sid = String(req.body?.id || '');
  if (!/^[\w-]+$/.test(sid)) return res.status(400).json({ error: 'invalid session id' });
  const host = String(req.body?.host || LOCAL);
  const cwd = String(req.body?.cwd || (host === LOCAL ? process.cwd() : ''));
  const session = `resume-${sid.slice(0, 8)}`;
  const name = String(req.body?.name || `resume ${sid.slice(0, 8)}`).trim().slice(0, 80);
  const resolved = await resolveClaudeCmd(host, `claude --resume ${sid} --dangerously-skip-permissions`);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const chat = { host, session, cwd, cmd: resolved.cmd, name };
  const out = { id: `${host}:${session}`, key: session, kind: 'tmux', host, container: null, session, project: 'manual', role: 'claude', name, cwd, cmd: resolved.cmd, active: true };
  // Always kill the old resume session + spawn fresh: the old claude has a stale
  // snapshot; the new `claude --resume` reads the latest JSONL (picks up messages
  // posted to the original session since the last resume).
  if (await hasSession(chat, cfg)) {
    try { await killTmux(chat, cfg); } catch { /* noop */ }
  }
  {
    const err = await preflightTmux(host);
    if (err) return res.status(400).json({ error: err });
    try { await spawnTmux(chat); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    if (!(await hasSession(chat, cfg))) {
      return res.status(500).json({ error: `\`claude\` failed to start on ${host} — tmux session died immediately. Is \`claude\` installed and on PATH there?` });
    }
  }
  const catalog = loadCatalog().filter((c) => c.session !== session);
  saveCatalog([...catalog, { kind: 'tmux', host, session, name, cwd, cmd: chat.cmd }]);
  res.json({ ok: true, chat: out });
});

app.post('/api/kill', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  const chat = r.chat;
  // Kill the tmux session for ANY chat type (yatfa or spawned). For yatfa this
  // kills the agent's tmux session inside the container (container keeps running).
  try { await killTmux(chat, cfg); } catch { /* noop */ }
  // Remove from catalog (spawned chats only; yatfa are auto-discovered)
  if (chat.kind === 'tmux') saveCatalog(loadCatalog().filter((c) => c.session !== chat.session));
  res.json({ ok: true });
});

// Force-kill a tmux session (the running process, even if hung). Does NOT remove
// from catalog — the chat can be re-spawned/resumed later. Different from Ctrl-C
// (which just signals the foreground command) and from /api/kill (which also
// forgets the chat).
app.post('/api/session-kill', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  try { await killTmux(r.chat, cfg); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper function to detect binary files by extension
export function isBinaryFile(filePath) {
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg', // images
    '.pdf', '.ps', '.eps', '.ai', '.sketch', // documents
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', // archives
    '.exe', '.dll', '.so', '.dylib', '.app', '.bin', '.rom', // executables
    '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.webm', // media
    '.ttf', '.otf', '.woff', '.woff2', '.eot', // fonts
    '.class', '.jar', '.war', '.ear', // Java
    '.obj', '.o', '.a', '.lib', // compiled code
    '.pdb', '.min', '.map', // debug/map files
  ];
  const ext = path.extname(filePath).toLowerCase();
  return binaryExtensions.includes(ext);
}

// Build the remote (SSH) shell script that safely reads a file under `cwd`.
// Extracted so it can be unit-tested — this template has been fragile (a bash
// `${...}` parameter expansion collides with JS template-literal interpolation,
// and the already-quoted shellQuote() output must NOT be wrapped in double quotes
// or the literal single-quotes end up inside the variable value). `shellQuote`
// produces a single-quoted POSIX token, so we splice it in bare.
export function buildReadFileScript(cwd, filePath) {
  // NOTE: `\${RESOLVED##*.}` is an *escaped* JS template expression on purpose —
  // it emits the literal bash `${RESOLVED##*.}` parameter expansion (strip to the
  // file extension) into the script. Do not "fix" it to `${...}`.
  // The binary extensions are inlined directly in the `case` pattern (not read
  // from a variable): bash tokenizes case-pattern `|` alternation at parse time,
  // before expansion, so `case "$EXT" in $BINARY)` would match the literal string
  // "png|jpg|...", never any extension.
  // The cwd-containment `case` pattern MUST include the path separator
  // ("$RESOLVED_CWD"/*|"$RESOLVED_CWD"): without the separator, "$RESOLVED_CWD"*
  // is a pure prefix match that also accepts a sibling whose name merely extends
  // the cwd (e.g. /x/proj-secret.txt when cwd is /x/proj) — a path-traversal hole.
  // See the prefix-sibling regression test in src/read-file.test.js.
  return `CWD=${shellQuote(cwd)}; FILE=${shellQuote(filePath)}; RESOLVED_CWD="$(realpath -e "$CWD" 2>/dev/null)" || { echo "ERROR invalid path"; exit 1; }; RESOLVED="$(cd "$RESOLVED_CWD" && realpath -e "$FILE" 2>/dev/null)" || { echo "ERROR file not found"; exit 1; }; case "$RESOLVED" in "$RESOLVED_CWD"/*|"$RESOLVED_CWD") ;; *) echo "ERROR path must be within working directory"; exit 1 ;; esac; [ -d "$RESOLVED" ] && { echo "ERROR path is a directory"; exit 1; }; [ -f "$RESOLVED" ] || { echo "ERROR not a file"; exit 1; }; SIZE=$(stat -c %s "$RESOLVED" 2>/dev/null || stat -f %z "$RESOLVED" 2>/dev/null); [ -n "$SIZE" ] && [ "$SIZE" -gt 1048576 ] && { echo "ERROR file too large"; exit 1; }; EXT="\${RESOLVED##*.}"; case "$EXT" in png|jpg|jpeg|gif|ico|bmp|webp|svg|pdf|ps|eps|ai|sketch|zip|tar|gz|bz2|xz|7z|rar|exe|dll|so|dylib|app|bin|rom|mp3|mp4|avi|mov|wav|flac|ogg|webm|ttf|otf|woff|woff2|eot|class|jar|war|ear|obj|o|a|lib|pdb|min|map) echo "ERROR cannot read binary files"; exit 1 ;; esac; cat "$RESOLVED"`;
}

// POST /api/read-file — read a file from a chat's working directory.
// Body: { id: string, path: string }
// Response: { content: string, path: string, error?: string }
app.post('/api/read-file', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);

  const filePath = String(req.body?.path || '').trim();
  if (!filePath) return res.status(400).json({ error: 'path is required' });

  const chat = r.chat;
  const cwd = chat.cwd || '.';

  // Security: resolve the path and verify it's within the chat's working directory
  // For local hosts, use fs.realpathSync.native to resolve symlinks; for remote, we'll validate on the remote side
  if (chat.host === LOCAL) {
    let resolvedPath;
    let resolvedCwd;
    try {
      // Resolve both paths to their final targets after following all symlinks
      resolvedCwd = fs.realpathSync.native(cwd);
      resolvedPath = fs.realpathSync.native(path.join(cwd, filePath));
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
      return res.status(400).json({ error: 'invalid path' });
    }

    // Check if the resolved path starts with the resolved cwd (prevent path traversal and symlink escapes)
    if (!resolvedPath.startsWith(resolvedCwd + path.sep) && resolvedPath !== resolvedCwd) {
      return res.status(403).json({ error: 'path must be within working directory' });
    }

    try {
      // Check file size (limit to 1MB to prevent server issues)
      const stats = fs.statSync(resolvedPath);
      if (stats.size > 1024 * 1024) {
        return res.status(413).json({ error: 'file too large (max 1MB)' });
      }

      // Check for binary files by extension
      if (isBinaryFile(resolvedPath)) {
        return res.status(400).json({ error: 'cannot read binary files' });
      }

      // Read file content
      const content = fs.readFileSync(resolvedPath, 'utf8');
      return res.json({ content, path: filePath });
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
      if (e.code === 'EISDIR') return res.status(400).json({ error: 'path is a directory' });
      return res.status(500).json({ error: 'read failed' });
    }
  } else {
    // Remote host: use SSH to read the file
    // Build a safe command that reads the file and validates the path
    // Security: use realpath -e to resolve symlinks and validate the final target
    // Also check for binary files by extension
    const script = buildReadFileScript(cwd, filePath);

    const result = await run(chat.host, script, { timeout: 10000 });
    if (!result.ok) {
      // The remote script writes its diagnostics ("ERROR ...") via `echo` on stdout;
      // pool/ssh failures land on stderr. Check both so specific errors map correctly.
      const out = `${result.stdout || ''}${result.stderr || ''}`;
      if (out.includes('ERROR invalid path')) return res.status(400).json({ error: 'invalid path' });
      if (out.includes('ERROR file not found')) return res.status(404).json({ error: 'file not found' });
      if (out.includes('ERROR path must be within working directory')) return res.status(403).json({ error: 'path must be within working directory' });
      if (out.includes('ERROR path is a directory')) return res.status(400).json({ error: 'path is a directory' });
      if (out.includes('ERROR not a file')) return res.status(400).json({ error: 'not a file' });
      if (out.includes('ERROR file too large')) return res.status(413).json({ error: 'file too large (max 1MB)' });
      if (out.includes('ERROR cannot read binary files')) return res.status(400).json({ error: 'cannot read binary files' });
      return res.status(500).json({ error: 'read failed' });
    }

    return res.json({ content: result.stdout, path: filePath });
  }
});

// ---- Workspace content search (grep) — WARDEN-145 ---------------------------
// Completes the locate→read loop WARDEN-39 (file reading) started: lets a human
// find a file by CONTENT (function name, error string, …) and open it in the
// FileViewer, instead of having to know the exact path by hand. Mirrors the
// read-file/git-status patterns: chat-scoped, cwd-contained, local spawnSync vs
// remote `run(host, script)` split. The `query` is user input that runs in a
// remote shell, so it carries the same injection surface read-file guards
// against — it is shellQuoted and preceded by `--`, output is bounded, and
// binaries are skipped (-I).
const SEARCH_MAX_RESULTS = 30;
const SEARCH_MAX_LINE_LEN = 300; // display cap applied by parseSearchOutput
// Per-line transfer cap — the local/remote single source of truth for "how much
// of one matched line we move before stopping". The remote script's `cut -c1-…`
// and the local streamBoundedSearch both read this; SEARCH_MAX_LINE_LEN (300) is
// a stricter display-only truncation applied afterward by parseSearchOutput.
const SEARCH_TRANSFER_LINE_LEN = 1000;

// Parse one `<path>:<line>:<text>` line as emitted by `git grep -n` / `rg -n` /
// `grep -rn`. The line number is the FIRST ':digits:' after the path (non-greedy
// match), so a text body containing its own ':123:' isn't misread as the line.
export function parseSearchLine(raw) {
  const m = raw.match(/^(.*?):(\d+):(.*)$/);
  if (!m) return null;
  return { file: m[1], line: parseInt(m[2], 10), text: m[3] };
}

// Parse raw search stdout into capped, truncated { file, line, text } rows.
// Stops at maxResults so a huge match set (e.g. searching "import") is never
// fully parsed — bounded work, bounded response.
export function parseSearchOutput(raw, maxResults = SEARCH_MAX_RESULTS, maxLineLen = SEARCH_MAX_LINE_LEN) {
  const results = [];
  for (const line of String(raw).split('\n')) {
    if (!line) continue;
    const parsed = parseSearchLine(line);
    if (!parsed) continue;
    if (parsed.text.length > maxLineLen) parsed.text = parsed.text.slice(0, maxLineLen);
    results.push(parsed);
    if (results.length >= maxResults) break;
  }
  return results;
}

// Build the remote (SSH) shell script that searches tracked files under `cwd`
// for `query`. Extracted + exported so the containment/quoting can be unit-
// tested, exactly like buildReadFileScript. `query` is user input interpolated
// into a remote shell, so it MUST be shellQuoted (single-quoted POSIX token)
// and preceded by `--` (option-injection stop). Other guards baked into the
// script (all reviewed against the remote execution environment):
//   set +o pipefail  — a user's ~/.bash_profile may set pipefail; under it
//     `git grep | head` exits 141 (SIGPIPE) once head closes the pipe after 30
//     lines, which `run()` reads as failure and silently drops all 30 results.
//   -F / --fixed-strings — treat the query as a LITERAL substring. The use case
//     is "find this error string / function name", not a regex; -F also stops
//     `.` matching every line (a DoS amplifier) and avoids invalid-regex→empty.
//   command -v rg — fall back to grep only when rg is ABSENT, not on rg's
//     exit-1-no-match (else grep needlessly re-walks the tree on every miss).
//   cut -c1-1000 — bound each line's transfer over SSH (a committed minified
//     bundle is one multi-MB line) before head bounds the line COUNT.
// `git grep -n -I` searches only tracked files (skips node_modules/dist/.git)
// and skips binaries (-I). git rev-parse gates the rg/grep fallback to non-repos.
export function buildSearchScript(cwd, query) {
  const q = shellQuote(query);
  return `cd ${shellQuote(cwd)} 2>/dev/null || exit 0; set +o pipefail; if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git grep -n -I -F -- ${q}; elif command -v rg >/dev/null 2>&1; then rg --line-number --no-heading -F -- ${q} .; else grep -rnI -F -- ${q} .; fi | cut -c1-${SEARCH_TRANSFER_LINE_LEN} | head -n ${SEARCH_MAX_RESULTS}`;
}

// spawnSync wrapper for tiny local PROBE commands only (git rev-parse,
// `rg --version`): bounded (1MB maxBuffer + 10s timeout) with stderr CAPTURED
// (not inherited) so probe noise ("fatal: not a git repository") never hits the
// server console. The workspace search itself is NOT run through here — it is
// streamed by streamBoundedSearch below so its output is bounded AT THE SOURCE
// (a spawnSync maxBuffer, once exceeded, masks a many-match search as ENOBUFS→'').
function runLocalSearch(bin, args, cwd) {
  return spawnSync(bin, args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000,
  });
}

// PATH-presence probe — the local twin of the remote `command -v rg` gate that
// decides whether the non-repo fallback runs ripgrep or plain grep. spawnSync so
// an absent tool (ENOENT) is detected cleanly, not entangled with a streamed run.
function hasBinary(bin) {
  return runLocalSearch(bin, ['--version'], undefined).error?.code !== 'ENOENT';
}

// Stream a local search tool's stdout and bound it AT THE SOURCE — the local twin
// of the remote `| cut -c1-<TRANSFER> | head -n <MAX>`. We read stdout
// incrementally, cap each matched line to SEARCH_TRANSFER_LINE_LEN, and STOP
// (kill the child) once we reach SEARCH_MAX_RESULTS lines. This NEVER depends on
// a maxBuffer cap: the previous spawnSync twin collected the ENTIRE stdout into a
// 4MB buffer and, on overflow (ENOBUFS), returned '' — so a search that had 30
// real matches for a common term ("import") came back as "No results found".
// Streaming caps where the results are PRODUCED, exactly like the remote script.
// Spawned as an argv array with `{cwd}` (NO shell), so the query is a literal
// argument with zero injection surface — it needs NO shellQuote here, unlike the
// remote path which builds a shell string for SSH. Returns the bounded raw stdout
// in the same `path:line:text` format the remote produces, so parseSearchOutput
// parses both paths identically. Exported for direct unit testing of the bound.
export function streamBoundedSearch(bin, args, cwd, opts = {}) {
  const maxResults = opts.maxResults ?? SEARCH_MAX_RESULTS;
  const transferLen = opts.transferLen ?? SEARCH_TRANSFER_LINE_LEN;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const lines = [];
    let buf = '';
    let skipping = false; // discarding the tail of an over-long (no-newline-yet) line
    let stopped = false;
    let settled = false;
    const cap = (s) => (s.length > transferLen ? s.slice(0, transferLen) : s);
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const stop = () => { stopped = true; try { child.kill('SIGTERM'); } catch {} };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stopped || settled) return;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skipping) { skipping = false; continue; } // remainder of an over-long line
        lines.push(cap(line));
        if (lines.length >= maxResults) { stop(); return; }
      }
      // No newline in buf. If buf already exceeds the cap, this single physical
      // line is over-long (e.g. a minified bundle): emit its first transferLen
      // chars, then drop the rest until the line's terminating newline arrives.
      if (skipping) buf = '';
      else if (buf.length > transferLen) {
        lines.push(cap(buf));
        buf = '';
        skipping = true;
        if (lines.length >= maxResults) stop();
      }
    });
    // Drain stderr so it can't backpressure the pipe. It is NOT inherited, so the
    // tool's diagnostics never spam the server console (mirrors runLocalSearch).
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', () => done('')); // ENOENT (tool absent) / spawn failure → no results
    child.on('close', () => {
      // Flush a trailing newline-less line ONLY on natural EOF. When we `stop()`-ed
      // at the cap, `buf` still holds the rest of that chunk — it must NOT be flushed
      // (it would push past maxResults, chunk-delivery-dependent and flaky).
      if (!stopped && !skipping && buf) lines.push(cap(buf));
      done(lines.join('\n'));
    });
  });
}

// Local raw search stdout for `query` under `cwd`: the streamed twin of the
// remote buildSearchScript. Prefers `git grep` (tracked files only, -F literal);
// falls back to rg (PATH-gated via hasBinary, mirroring `command -v rg`) then
// plain grep, only when cwd is not a git worktree. Output is bounded AT THE SOURCE
// by streamBoundedSearch (line count + per-line transfer cap) — never by a
// spawnSync maxBuffer — so a many-match search returns its real (≤30) results
// instead of ENOBUFS→''. Returns '' for no matches / spawn failure and never
// throws (matches git-status/git-log). Exported so the local path has test
// coverage parity with the remote buildSearchScript.
export async function searchLocalRaw(cwd, query) {
  // Gate the rg/grep fallback to non-repos (mirrors remote `if git rev-parse…`).
  // rev-parse output is tiny ("true"), so a spawnSync probe here is overflow-safe.
  const gitCheck = runLocalSearch('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  const insideRepo = gitCheck.status === 0 && (gitCheck.stdout?.trim() === 'true');
  if (insideRepo) {
    // git grep: status 1 = no matches (yields ''); 0 = matches. -I skips binaries.
    return streamBoundedSearch('git', ['grep', '-n', '-I', '-F', '--', query], cwd);
  }
  // Not a git repo → ripgrep (fast, respects .gitignore) then plain grep. -F = literal.
  if (hasBinary('rg')) {
    return streamBoundedSearch('rg', ['--line-number', '--no-heading', '-F', '--', query, '.'], cwd);
  }
  return streamBoundedSearch('grep', ['-rn', '-I', '-F', '--', query, '.'], cwd);
}

// POST /api/search-files — content-search a chat's working directory (grep).
// Body: { id: string, query: string }
// Response: { results: [{ file, line, text }], query, error?: string }
// Local chats run git/rg/grep via spawnSync; remote chats run buildSearchScript
// over SSH. Mirrors /api/git-status's resolve → cwd guard → local/remote split.
app.post('/api/search-files', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);

  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });

  const chat = r.chat;
  const cwd = chat.cwd || (chat.host === LOCAL ? process.cwd() : '');
  if (!cwd) return res.json({ results: [], query, error: 'no cwd' });

  try {
    let raw = '';
    let error = null;
    if (chat.host === LOCAL) {
      raw = await searchLocalRaw(cwd, query);
    } else {
      const script = buildSearchScript(cwd, query);
      const result = await run(chat.host, script, { timeout: 10000 });
      // A failed remote run (host down / SSH auth / timeout) must NOT masquerade
      // as "no matches" — surface it so the dialog can show a real error.
      // result.stdout is still parsed when present (head/cut already bounded it).
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

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  if (!hasCredentials()) {
    ws.send(JSON.stringify({ type: 'error', error: 'no LLM credentials (ANTHROPIC_AUTH_TOKEN missing in the server environment)' }));
    return;
  }
  const u = new URL(req.url || '', 'http://localhost');
  let sid = u.searchParams.get('sid');
  // NEW: extract chat context
  const chatHost = u.searchParams.get('host') || null;
  const chatContainer = u.searchParams.get('container') || null;
  const chatProject = u.searchParams.get('project') || null;
  const chatRole = u.searchParams.get('role') || null;
  const chatKey = u.searchParams.get('chatKey') || null;
  if (!sid) {
    const s = createSession(null, { host: chatHost, container: chatContainer, project: chatProject, role: chatRole, chatKey: chatKey });
    sid = s.id;
    ws.send(JSON.stringify({
      type: 'session_created', sid: s.id, name: s.name,
      chatContext: { host: s.host, container: s.container, project: s.project, role: s.role, chatKey: s.chatKey },
    }));
  }

  let reqCounter = 0;
  const pending = new Map();
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const obs = new Observer(cfg, {
    sid,
    // Pass chat context so a freshly-created session binds to its agent; on
    // resume the Observer re-reads it from the persisted session instead.
    chatContext: (chatHost || chatContainer || chatProject || chatRole || chatKey)
      ? { host: chatHost, container: chatContainer, project: chatProject, role: chatRole, chatKey: chatKey }
      : null,
    onTool: (name, input) => send({ type: 'tool', name, input: { ...input, id: input?.id } }),
    onToolResult: (name, result) => {
      try {
        if (name === 'suggest_next_actions' && result?.suggestions && Array.isArray(result.suggestions)) {
          for (const suggestion of result.suggestions) {
            // Validate required fields before sending
            if (suggestion && typeof suggestion === 'object' &&
                suggestion.agentId && suggestion.agentName &&
                suggestion.urgency && suggestion.state && suggestion.action) {
              send({
                type: 'suggestion_card',
                agentId: String(suggestion.agentId),
                agentName: String(suggestion.agentName),
                role: String(suggestion.role || 'agent'),
                urgency: String(suggestion.urgency),
                state: String(suggestion.state),
                action: String(suggestion.action)
              });
            }
          }
        }
      } catch (e) {
        // Log error but don't crash the server
        console.error('Error handling tool result:', e);
      }
    },
    onText: (text) => send({ type: 'assistant', text }),
    gate: async (chat, directive) => {
      // Auto-send read-looking directives when in auto-safe mode
      const isReadOnlyDirective = /^(?:\?|list|read|show|get|find|search|check|status|info|display)/i.test(directive.trim());
      if (cfg.observerConfirmMode === 'auto-safe' && isReadOnlyDirective) {
        return { approved: true, edited: null };
      }

      // Otherwise, require confirmation
      const requestId = String(++reqCounter);
      send({ type: 'directive_proposed', requestId, container: chat.container, host: chat.host, role: chat.role, directive });
      appendEvent({ type: 'directive_proposed', container: chat.container, host: chat.host, role: chat.role, directive });
      return new Promise((resolveDecision) => pending.set(requestId, resolveDecision));
    },
  });
  send({ type: 'history', name: obs.name, items: obs.serializeForUi(), chatContext: obs.getChatContext() });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'user') {
      send({ type: 'thinking' });
      obs.openTabs = Array.isArray(msg.panes) ? msg.panes : [];
      try { send({ type: 'done', text: await obs.step(String(msg.text || '')) }); }
      catch (e) {
        send({ type: 'error', error: e.message });
        appendEvent({ type: 'error', error: e.message });
      }
    } else if (msg.type === 'gate_decision') {
      const r = pending.get(msg.requestId);
      if (r) { pending.delete(msg.requestId); r({ approved: !!msg.approved, edited: msg.edited }); }
    }
  });
  ws.on('close', () => { for (const [, r] of pending) r({ approved: false }); });
});

// Pane stream WS: live PTY attach (interactive) + monitor snapshots. tmux is the
// durable holder everywhere, so attach PTYs are per-WS (killed on disconnect; the
// tmux session lives on). Local chats attach to a local tmux, remotes over ssh.
const streamWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  const route = (w) => w.handleUpgrade(req, socket, head, (ws) => w.emit('connection', ws, req));
  if (p === '/api/observe') route(wss);
  else if (p === '/api/stream') route(streamWss);
  else socket.destroy();
});
streamWss.on('connection', (ws) => {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const attaches = new Map(); // id -> { pty, chat }
  const monitors = new Set(); // chat keys
  let monitorTimer = null;

  const tickMonitor = async () => {
    if (!monitors.size) return;
    const chats = [...monitors].map((k) => cache.find((c) => c.key === k)).filter(Boolean);
    if (!chats.length) return;
    let out;
    try { out = await capturePanes(chats, cfg); } catch { return; }
    for (const [k, pane] of Object.entries(out)) {
      send({ type: 'snapshot', id: k, pane });
      // Snapshot logging disabled due to performance: 2s intervals create 300K+ events/pane/7 days
      // appendEvent({ type: 'snapshot', id: k, host: chats.find(c => c.key === k)?.host, container: chats.find(c => c.key === k)?.container });
    }
  };
  const startMonitor = () => { if (!monitorTimer) { monitorTimer = setInterval(tickMonitor, 2000); tickMonitor(); } };
  const stopMonitorIfEmpty = () => { if (monitorTimer && !monitors.size) { clearInterval(monitorTimer); monitorTimer = null; } };

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'monitor') { monitors.add(String(m.id)); await resolve(String(m.id)); startMonitor(); }
    else if (m.type === 'unmonitor') { monitors.delete(String(m.id)); stopMonitorIfEmpty(); }
    else if (m.type === 'attach') {
      if (attaches.has(m.id)) return;
      // Lazy restore: if the client knows the host (stored when the pane was first
      // opened), discover just that one host so resolve() hits cache — no all-hosts scan.
      if (m.host && !cache.some((c) => c.key === m.id || c.id === m.id)) {
        try {
          const { chats } = await discoverHost(String(m.host), cfg);
          cache = [...cache.filter((c) => c.host !== m.host), ...chats];
        } catch { /* fall through; resolve() still has a locate fallback */ }
      }
      const r = await resolve(String(m.id));
      if (r.error) { send({ type: 'attach_error', id: m.id, error: r.error }); appendEvent({ type: 'error', error: r.error, context: 'attach', id: m.id }); return; }
      const chat = r.chat;
      const cols = Math.max(20, Math.floor(m.cols || 100));
      const rows = Math.max(6, Math.floor(m.rows || 30));
      let pty;
      try { pty = attachStream(chat, cfg, { cols, rows }); }
      catch (e) {
        send({ type: 'attach_error', id: m.id, error: String((e && e.message) || e) });
        appendEvent({ type: 'error', error: String((e && e.message) || e), context: 'attach', id: m.id, host: chat.host, container: chat.container });
        return;
      }
      attaches.set(m.id, { pty, chat });
      pty.onData((d) => send({ type: 'pty', id: m.id, data: d }));
      pty.onExit(({ exitCode }) => { attaches.delete(m.id); send({ type: 'ended', id: m.id, code: exitCode }); appendEvent({ type: 'ended', id: m.id, code: exitCode, host: chat.host, container: chat.container }); });
      try { await resize(chat, cfg, cols, rows); } catch { /* noop */ }
      send({ type: 'attached', id: m.id });
      appendEvent({ type: 'attached', id: m.id, host: chat.host, container: chat.container });
    } else if (m.type === 'input') {
      const a = attaches.get(m.id);
      if (a) { try { a.pty.write(String(m.data || '')); } catch { /* noop */ } }
    } else if (m.type === 'resize') {
      const c = Math.max(20, Math.floor(m.cols || 80));
      const r = Math.max(6, Math.floor(m.rows || 24));
      const a = attaches.get(m.id);
      if (a) {
        try { a.pty.resize(c, r); } catch { /* noop */ }
        try { await resize(a.chat, cfg, c, r); } catch { /* noop */ }
      }
    } else if (m.type === 'detach') {
      const a = attaches.get(m.id);
      if (a) { try { a.pty.kill(); } catch { /* noop */ } attaches.delete(m.id); }
    }
  });

  ws.on('close', () => {
    for (const [, a] of attaches) { try { a.pty.kill(); } catch { /* noop */ } }
    if (monitorTimer) clearInterval(monitorTimer);
  });
});

// Rotate old activity events on startup
try { rotateEvents(); } catch { /* ignore */ }

// Exported for HTTP-level integration tests (see src/server-hosts-status.test.js).
// Not used by the running server — startServer() below drives the module-level
// `server` directly.
export { app };

export function startServer(port = 7421, host = '127.0.0.1') {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nwarden: port ${port} is already in use — another warden running? Stop it, or start with PORT=<other> npm start.\n`);
    } else {
      console.error('warden: server error:', e.message);
    }
    process.exit(1);
  });
  server.listen(port, host, async () => {
    console.log(`warden ui → http://${host}:${port}`);
    console.log(`  hosts: ${cfg.hosts.join(', ')}   model: ${resolveModel()}   tmux: ${TMUX_BIN}`);
    // Start connection pool cleanup task
    startConnectionPoolCleanup();
    // Lazy mode: no startup SSH. Connections open on demand (per-host discover / pane read).
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer(parseInt(process.env.PORT || '7421', 10));
}
