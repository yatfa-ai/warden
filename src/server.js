// warden web dashboard server. tmux is required everywhere — every chat is a tmux
// session (yatfa: in a docker container; manual: a host/local tmux session). The
// transport (ssh.js runTmux/attachTmux) routes each op to the remote host over SSH
// or to this machine locally. No more direct-PTY path.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { load, save, loadCatalog, saveCatalog, allSshHosts, sameCatalogEntry } from './config.js';
import { applyCompanionToggle } from './companion.js';
import * as collections from './collections.js';
import { capturePanes, resolveChatWithRefresh, catalogChats, discoverHost, discoverAll } from './chats.js';
import { read as readPane, send as sendPane, sendKey, hasSession, resize, spawn as spawnTmux, kill as killTmux, attachStream, probeSession } from './tmux.js';
import { run, runLocalTmux, shellQuote, TMUX_BIN, detectClaude, startConnectionPoolCleanup, validateHost } from './ssh.js';
import { classifyProbe } from './sessionRecovery.js';
import { Observer, readDirectives } from './observer.js';
import { hasCredentials, resolveModel } from './llm.js';
import { listSessions, createSession, renameSession, deleteSession } from './sessions.js';
import { appendEvent, rotateEvents, readEvents, getStatsSince, getSeriesSince } from './activity.js';
import { computeBudgetState, shouldFireBudgetAlert, resolveBudgetConfig, BUDGET_INTERVAL_MS } from './budget.js';
import { buildSnapshot, diffLifecycles } from './lifecycle.js';
import { getHealthState, groupByHealth, getHealthSummary } from './health.js';
import { classifyPane, stripAnsi } from './agentState.js';
import { checkHost } from './hostStatus.js';
import { parseGitStatusPorcelain, parseAheadBehind, parseStashCount, parseStashList, parseReflog, parseDiffStat, isDetachedHead, normalizeHeadSha, parseUpstream, parseGitRemotes, buildDockerGitArgv } from './gitStatus.js';
import { isCompanionTransportEnabled, subscribePanes, unsubscribePanes, reconcilePaneSubscriptions, startPaneDeltaSweep } from './companion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = load();
const LOCAL = '(local)';

// WARDEN-439: the companion transport is a persisted Settings toggle that drives
// the WARDEN_COMPANION_TRANSPORT env-var gate every remote routing site reads.
// Snapshot ONCE whether the operator set that env var before warden started: if
// so it's an explicit override (the UI toggle is inert, the env var wins); if
// not, the persisted toggle drives the gate, applied here at boot and live on
// every PUT /api/config so a flip takes effect on the next op, not on restart.
const companionEnvOverridden = process.env.WARDEN_COMPANION_TRANSPORT !== undefined;
applyCompanionToggle(cfg.companionTransportEnabled, { override: companionEnvOverridden });

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

// Carry a chat's last-known lastActivity forward across a cache refresh
// (WARDEN-245). Activity is captured for LIVE sessions only; when a session goes
// inactive the fresh discover yields lastActivity === null, and a cache replace
// would wipe the value the closed chat needs for Fleet Health recency ordering.
// This fills any nextChat.lastActivity that is null/undefined with the prior
// cached value for the same id (catalog chats additionally hydrate from the
// persisted entry in chats.js; this covers yatfa chats, which have no catalog,
// and is belt-and-suspenders for catalog chats too). Pure / no ssh.
function retainLastActivity(prevCache, nextChats) {
  if (!prevCache.length) return nextChats;
  const prev = new Map();
  for (const c of prevCache) {
    if (c.lastActivity != null) prev.set(c.id, c.lastActivity);
  }
  if (!prev.size) return nextChats;
  return nextChats.map((c) =>
    (c.lastActivity == null && prev.has(c.id)) ? { ...c, lastActivity: prev.get(c.id) } : c
  );
}

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
        cache = [...cache.filter((c) => c.host !== hostHint), ...retainLastActivity(cache, chats)];
      }
    } else if (cfg.hosts.length) {
      // Bare name (e.g. a restored yatfa tab like "yatfa-worker") with no host hint.
      // Locate it across configured hosts so already-open remote panes resolve on app
      // start. Demand-driven + cached: runs at most once per unresolved bare name.
      const settled = await Promise.allSettled(cfg.hosts.map((h) => discoverHost(h, cfg)));
      const found = settled.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value.chats);
      cache = [...cache.filter((c) => !cfg.hosts.includes(c.host)), ...retainLastActivity(cache, found)];
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
    // runLocalTmux is async (WARDEN-440) so this `tmux -V` probe never blocks the
    // event loop while serving the spawn/resume request that triggered preflight.
    const r = await runLocalTmux(['-V']);
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
  cache = [...yatfa, ...retainLastActivity(cache, chats)];
  res.json({ chats, errors });
});

// Discover ONE host on demand (user clicked it). Returns that host's chats with live
// active/lastActivity and merges them into the cache.
app.get('/api/discover', async (req, res) => {
  const host = String(req.query.host || '');
  if (!host) return res.status(400).json({ error: 'missing ?host=' });
  try {
    const { chats } = await discoverHost(host, cfg);
    cache = [...cache.filter((c) => c.host !== host), ...retainLastActivity(cache, chats)];
    res.json({ host, chats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Join key for the cwd+host budget-session join (WARDEN-466). A single shared
// helper keeps the map-build and lookup sites identical BY CONSTRUCTION — two
// hand-typed literals are how an invisible separator byte slipped in before.
// '\0' is the canonical record separator (cf. `find -print0` / `xargs -0`): it
// is the POSIX path terminator and cannot occur in a hostname either, so it
// also closes the `/a b`+`c` vs `/a`+`b c` space-join collision edge for free.
// The escape is visible in source (no literal NUL byte in the file); the NUL
// exists only at runtime inside these in-memory Map keys, which are never
// serialized, logged, or sent to the client.
function cwdHostKey(cwd, host) { return `${cwd}\0${host}`; }

// Health endpoint for fleet health monitoring
app.get('/api/health', (_req, res) => {
  try {
    // Cache-derived (zero ssh). Under lazy mode only discovered/catalog chats are present;
    // catalog chats report UNKNOWN until their host is clicked.
    const chats = cache;

    // Per-agent token spend (WARDEN-466): join each live agent to its budget
    // session's lifetime token total so the cost dimension sits beside CPU/mem
    // at the kill-decision surface. Reads ONLY the cached budgetState.sessionUsage
    // map (rebuilt every 120s by tickBudget) — zero SSH, no new fetch. The join
    // key is cwd+host (NOT id): a chat's id is a container/tmux key, never the
    // claude uuid a budget session carries (WARDEN-466's correction), so id would
    // never match. cwd+host is the viable existing-field key both sides carry.
    //
    // Multi-role collision caveat (path A, accepted): a yatfa fleet commonly runs
    // worker/reviewer/… for the SAME repo on ONE host — those chats share cwd+host
    // and collide. We keep the MAX total per key so the chip shows the heaviest
    // spender (a stale-but-plausible number — pure read-only observability, never
    // a mutation). The limitation is noted in the chip tooltip.
    const usageByCwdHost = new Map();
    const sessionUsage = budgetState?.sessionUsage;
    if (Array.isArray(sessionUsage)) {
      for (const u of sessionUsage) {
        if (!u || !u.cwd || !(u.total > 0)) continue;
        const key = cwdHostKey(u.cwd, u.host);
        const prev = usageByCwdHost.get(key);
        if (prev == null || u.total > prev) usageByCwdHost.set(key, u.total);
      }
    }

    // Calculate health state for each agent
    const agentsWithHealth = chats.map(chat => {
      const agent = {
        ...chat,
        healthState: getHealthState(chat, chat.lastActivity, {
          healthyMin: cfg.healthWarningThresholdMin,
          warningMin: cfg.healthCriticalThresholdMin,
        })
      };
      // Attach the joined token total when this chat's cwd+host matches a budget
      // session (the chip source for HealthDashboard; absent → no chip, the same
      // graceful-N/A as a missing CPU/mem field).
      if (chat.cwd) {
        const total = usageByCwdHost.get(cwdHostKey(chat.cwd, chat.host));
        if (total != null) agent.tokenUsage = { total };
      }
      return agent;
    });

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

// Pane-state classification for the proactive attention surfaces (WARDEN-344).
//
// `/api/health` above is purely inactivity-based (HEALTHY/WARNING/CRITICAL by
// time-since-last-output), so an agent ACTIVELY emitting a repeating loop, a stack
// trace, or a "press enter" prompt reads HEALTHY — it never raises the Attention
// badge. This endpoint fills that gap by running the existing classifyPane heuristic
// (WARDEN-33; no LLM) over the panes the human currently has OPEN, returning each
// agent's state + the triggering signal.
//
// The client passes its open pane KEYS as ?panes=k1,k2 (same convention as
// /api/search-pane) — we classify ONLY those, never the whole fleet, so a poll costs
// one capturePanes round-trip grouped per host, not a full SSH sweep. Panes whose
// host is unreachable are returned with state 'capture_failed' (flagged, not dropped
// — WARDEN-89). Capture is the only SSH cost; resolution is cache-derived (zero SSH).
app.get('/api/agent-states', async (req, res) => {
  try {
    const keys = String(req.query.panes || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (keys.length === 0) return res.json({ agents: [], total: 0, timestamp: Date.now() });

    // Resolve pane keys → chats from the cache (zero ssh). Match on key OR id so a
    // bare restored tab id resolves the same as a host-qualified key.
    const seen = new Set();
    const chats = [];
    for (const k of keys) {
      const c = cache.find((x) => x.key === k || x.id === k);
      if (c && !seen.has(c.key)) { seen.add(c.key); chats.push(c); }
    }
    if (chats.length === 0) return res.json({ agents: [], total: 0, timestamp: Date.now() });

    const agents = await pollAgentStates(chats, cfg);
    res.json({ agents, total: agents.length, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// pollAgentStates is the /api/agent-states poll core: it reconciles the companion
// pane-push subscriptions for the polled hosts, captures their pane content, and
// classifies each. Exported (and deps-injected) so the WARDEN-413 success gate is
// drivable end-to-end: reconcile establishes the subscription → the companion
// pushes paneDelta events over the channel → capturePanes (chats.js) renders from
// the in-memory delta cache and SKIPS the per-host capturePanes RPC, so an idle
// companion host receives ZERO capturePanes RPCs per poll. The reconcile is
// awaited (not fire-and-forget like the WS monitor path) because /api/agent-states
// is a request/response HTTP call whose caller awaits the result anyway — sending
// subscribe before capture gives clean ordering, and on steady-state polls
// reconcile issues NO RPC (the pane set is unchanged), so the cost is ~0. The
// first poll after a host enters the set still polls once (the push hasn't arrived
// yet) — the graceful bootstrap. LOCAL + flag-off hosts are unchanged.
// `deps` is a test seam (defaults to {} in production). (WARDEN-413)
export async function pollAgentStates(chats, cfg = {}, deps = {}) {
  await reconcilePaneSubscriptions(chats, cfg, {}, deps);
  const panes = await capturePanes(chats, cfg, deps);
  return chats.map((c) => {
    const base = {
      id: c.container || c.session,
      key: c.key,
      host: c.host,
      project: c.project,
      role: c.role,
      name: c.name || c.key || (c.container || c.session),
    };
    // A MISSING key means capturePanes silently dropped this chat (host SSH
    // failed → `if (!res.ok) return;` per host). Surface it as capture_failed so
    // the badge can still name the agent instead of omitting it (WARDEN-89).
    if (!Object.prototype.hasOwnProperty.call(panes, c.key)) {
      return { ...base, state: 'capture_failed', captureError: true, signal: null };
    }
    const clean = stripAnsi(panes[c.key] || '');
    const { state, signal } = classifyPane(clean, c);
    return { ...base, state, signal, captureError: false };
  });
}
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

// Per-agent activity series for the Fleet Health sparklines (WARDEN-299). Mirrors
// the stats endpoint's default window (last 24h) and adds an hourly bucket grid a
// sparkline can join by `container`. Deliberately a separate endpoint — the
// dashboard fetches it on a slow ~60s cadence, never on the 10s /api/health poll.
app.get('/api/activity/series', (req, res) => {
  const after = req.query.after ? new Date(req.query.after).getTime() : Date.now() - (24 * 60 * 60 * 1000); // Default: last 24 hours
  const rawBucket = req.query.bucket ? parseInt(String(req.query.bucket), 10) : 3_600_000; // default 1h
  const bucket = Number.isFinite(rawBucket) && rawBucket > 0 ? rawBucket : 3_600_000;
  res.json(getSeriesSince(after, { bucketMs: bucket }));
});

app.get('/api/ssh-hosts', (_req, res) => res.json({ hosts: allSshHosts(), configured: cfg.hosts }));

// Directive history — reads the append-only directives.md back as structured
// records (the inverse of observer.js logDirective). Mirrors /api/activity's
// graceful-empty contract: a missing/empty file yields { directives: [] } and
// never a 500. `agent`/`limit` are optional filters (agent = container, the
// same field ActivityTimeline's agent filter uses). Newest-first.
app.get('/api/directives', (req, res) => {
  try {
    const agent = req.query.agent ? String(req.query.agent) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const directives = readDirectives({ agent, limit });
    res.json({ directives });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
  // Observer model/provider (WARDEN-350). Mask the auth token — NEVER return the
  // cleartext secret to the renderer. authTokenSet + authTokenTail are the only
  // token signals the UI gets; the password field is write-only (no cleartext is
  // seeded into it on load).
  llm: {
    model: cfg.llm?.model ?? '',
    baseUrl: cfg.llm?.baseUrl ?? '',
    maxTokens: typeof cfg.llm?.maxTokens === 'number' ? cfg.llm.maxTokens : null,
    authTokenSet: Boolean(cfg.llm?.authToken),
    authTokenTail: cfg.llm?.authToken ? String(cfg.llm.authToken).slice(-4) : null,
  },
  // Fleet health attention thresholds (minutes of inactivity)
  healthWarningThresholdMin: cfg.healthWarningThresholdMin,
  healthCriticalThresholdMin: cfg.healthCriticalThresholdMin,
  // Token-spend budget (WARDEN-415). Surfaced so the Settings page can edit the
  // persisted config; the live computed snapshot comes from /api/budget.
  tokenBudgetEnabled: cfg.tokenBudgetEnabled,
  tokenBudgetThresholdTokens: cfg.tokenBudgetThresholdTokens,
  tokenBudgetWindowHours: cfg.tokenBudgetWindowHours,
  tokenBudgetPerSessionThresholdTokens: cfg.tokenBudgetPerSessionThresholdTokens,
  // Companion transport (WARDEN-439). companionTransportOverridden is true when
  // WARDEN_COMPANION_TRANSPORT was operator-set at boot — in that case the env
  // var wins and the UI toggle is inert, so the page shows an "overridden" note
  // instead of letting the toggle look broken.
  companionTransportEnabled: cfg.companionTransportEnabled,
  companionTransportOverridden: companionEnvOverridden,
  // Telemetry receiver endpoint (WARDEN-461). Surfaced so Settings can edit it;
  // empty by default (unconfigured → transport sends nothing). This is a plain
  // string URL — no secret, no masking needed.
  telemetryEndpoint: cfg.telemetryEndpoint ?? '',
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
  // Telemetry consent (WARDEN-457). Both off by default; persisted here (not
  // client localStorage) so consent survives a restart. See config.js DEFAULTS.
  telemetryBaseEnabled: cfg.telemetryBaseEnabled,
  telemetryExtendedEnabled: cfg.telemetryExtendedEnabled,
}));

// PUT /api/config — update configuration and persist
app.put('/api/config', (req, res) => {
  const { hosts, pollIntervalMs, tmuxSession, connectTimeout,
          observerConfirmMode, observerAutoStart, observerSessionTimeout,
          healthWarningThresholdMin, healthCriticalThresholdMin,
          tokenBudgetEnabled, tokenBudgetThresholdTokens,
          tokenBudgetWindowHours, tokenBudgetPerSessionThresholdTokens,
          companionTransportEnabled,
          telemetryEndpoint,
          confirmDestructiveActions,
          notifyChatOps, notifyErrors, notifySuccess, notifyObserver,
          showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges,
          hideOfflineHosts, telemetryBaseEnabled, telemetryExtendedEnabled, llm } = req.body;
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
  // Observer model/provider (WARDEN-350). model/baseUrl/maxTokens persist
  // directly; the auth token is NO-CLOBBER: only overwrite the stored secret when
  // the incoming value is a non-empty string. The UI never seeds the password
  // field (GET masks the token), so an untouched field sends no authToken and
  // the stored secret must survive such a save.
  if (llm && typeof llm === 'object' && !Array.isArray(llm)) {
    if (!cfg.llm || typeof cfg.llm !== 'object' || Array.isArray(cfg.llm)) cfg.llm = {};
    if (typeof llm.model === 'string') cfg.llm.model = llm.model;
    if (typeof llm.baseUrl === 'string') cfg.llm.baseUrl = llm.baseUrl;
    // null clears to "use the llm.js default (2048)"; a finite positive int sets it.
    if (llm.maxTokens === null ||
        (typeof llm.maxTokens === 'number' && Number.isFinite(llm.maxTokens) && llm.maxTokens > 0)) {
      cfg.llm.maxTokens = llm.maxTokens;
    }
    if (typeof llm.authToken === 'string' && llm.authToken.length > 0) {
      cfg.llm.authToken = llm.authToken;
    }
  }
  // Fleet health attention thresholds — null-able OR a finite positive number of
  // minutes (mirrors the observerSessionTimeout guard). A field not destructured
  // here is silently stripped, so both must be present for the pref to persist.
  if (healthWarningThresholdMin === null ||
      (typeof healthWarningThresholdMin === 'number' &&
       Number.isFinite(healthWarningThresholdMin) &&
       healthWarningThresholdMin > 0)) cfg.healthWarningThresholdMin = healthWarningThresholdMin;
  if (healthCriticalThresholdMin === null ||
      (typeof healthCriticalThresholdMin === 'number' &&
       Number.isFinite(healthCriticalThresholdMin) &&
       healthCriticalThresholdMin > 0)) cfg.healthCriticalThresholdMin = healthCriticalThresholdMin;
  // Cross-field ordering guard (WARDEN-374): once both thresholds are accepted,
  // keep the pair well-ordered (warning <= critical) so a persisted inverted
  // config (warning > critical) can't later make a silently-failing agent read
  // HEALTHY. Clamp the warning to at most the critical, resolving null to its
  // DEFAULT first (null means "use the default" — same resolution getHealthState
  // applies). When the clamp fires we persist the numeric critical value so the
  // saved pair is well-ordered and the UI round-trip stays consistent. The
  // classifier's effectiveHealthyMs clamp is the real safety net; this guard
  // keeps the persisted config clean.
  const DEFAULT_WARNING_MIN = 5;   // mirrors config.js DEFAULTS.healthWarningThresholdMin
  const DEFAULT_CRITICAL_MIN = 30; // mirrors config.js DEFAULTS.healthCriticalThresholdMin
  const warningMin = cfg.healthWarningThresholdMin ?? DEFAULT_WARNING_MIN;
  const criticalMin = cfg.healthCriticalThresholdMin ?? DEFAULT_CRITICAL_MIN;
  if (warningMin > criticalMin) {
    cfg.healthWarningThresholdMin = criticalMin;
  }
  // Token-spend budget (WARDEN-415). The master switch is a boolean; the three
  // numeric knobs accept null (clears to default at read time) or a finite
  // positive number. The per-session threshold is null-able too so it can be
  // turned OFF independently (null → resolveBudgetConfig returns 0 → disabled).
  if (typeof tokenBudgetEnabled === 'boolean') cfg.tokenBudgetEnabled = tokenBudgetEnabled;
  if (tokenBudgetThresholdTokens === null ||
      (typeof tokenBudgetThresholdTokens === 'number' &&
       Number.isFinite(tokenBudgetThresholdTokens) && tokenBudgetThresholdTokens > 0)) {
    cfg.tokenBudgetThresholdTokens = tokenBudgetThresholdTokens;
  }
  if (typeof tokenBudgetWindowHours === 'number' &&
      Number.isFinite(tokenBudgetWindowHours) && tokenBudgetWindowHours > 0) {
    cfg.tokenBudgetWindowHours = tokenBudgetWindowHours;
  }
  if (tokenBudgetPerSessionThresholdTokens === null ||
      (typeof tokenBudgetPerSessionThresholdTokens === 'number' &&
       Number.isFinite(tokenBudgetPerSessionThresholdTokens) && tokenBudgetPerSessionThresholdTokens > 0)) {
    cfg.tokenBudgetPerSessionThresholdTokens = tokenBudgetPerSessionThresholdTokens;
  }
  // Companion transport toggle (WARDEN-439). Boolean master switch; everything
  // else (the remote-routing decision) is read from the env-var gate it drives.
  if (typeof companionTransportEnabled === 'boolean') cfg.companionTransportEnabled = companionTransportEnabled;
  // Telemetry receiver endpoint (WARDEN-461). Type-guarded string only — a
  // malformed body can't corrupt the pref. An empty string is a valid value
  // (clears the endpoint → transport sends nothing), so accept any string.
  if (typeof telemetryEndpoint === 'string') cfg.telemetryEndpoint = telemetryEndpoint;
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
  // Telemetry consent (WARDEN-457). Both are booleans. The SERVER enforces
  // extended-requires-base (not just the UI) so a hand-crafted PUT cannot enable
  // extended without base. The unconditional clamp at the end — mirroring the
  // health-threshold ordering guard above — guarantees the persisted pair is
  // always well-formed regardless of which fields were in the body: revoking
  // base latches extended off, and a corrupt disk state (extended on, base off)
  // self-heals on the next PUT. Consent persists to config.json, so revoking
  // base revokes the subordinate tier on disk with it.
  if (typeof telemetryBaseEnabled === 'boolean') cfg.telemetryBaseEnabled = telemetryBaseEnabled;
  if (typeof telemetryExtendedEnabled === 'boolean') cfg.telemetryExtendedEnabled = telemetryExtendedEnabled;
  cfg.telemetryExtendedEnabled = cfg.telemetryExtendedEnabled && cfg.telemetryBaseEnabled;
  save(cfg); // persist to ~/.yatfa-warden/config.json
  // Forward the (now-clamped) telemetry prefs to the Electron main process over
  // the fork's IPC channel so a consent/endpoint flip takes effect on the next
  // signal without an app restart — the source + pipeline live in MAIN, but the
  // PUT is serviced here in the server child. Guarded: process.send exists only
  // when the server is forked by electron/main.cjs (standalone `node src/server`
  // has no parent). WARDEN-524.
  if (typeof process.send === 'function') {
    process.send({
      type: 'telemetry-config',
      base: cfg.telemetryBaseEnabled === true,
      extended: cfg.telemetryExtendedEnabled === true,
      endpoint: typeof cfg.telemetryEndpoint === 'string' ? cfg.telemetryEndpoint : '',
    });
  }
  // WARDEN-439: apply the companion toggle LIVE so a flip takes effect on the
  // next op, not after a restart. No-op when the env var is an operator override
  // (companionEnvOverridden) — then the env var already wins and the toggle is
  // inert by design.
  applyCompanionToggle(cfg.companionTransportEnabled, { override: companionEnvOverridden });
  // Pick up the new budget config immediately rather than waiting up to 120s:
  // enabling starts the poll (and seeds the cache); disabling stops it; a
  // threshold/window change re-computes now so the next /api/budget read is fresh.
  restartBudgetPoll();
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

// Agent notes — a short, human-authored per-chat annotation (mirrors /api/pins,
// but id→note instead of an id list). Keyed by chat id, so it works for every
// chat including un-renameable yatfa agents (rename is identity-only and 404s
// for yatfa chats). WARDEN-89: validate input, never 500 on bad shapes.
app.get('/api/agent-notes', (_req, res) => res.json({ notes: cfg.agentNotes || {} }));
app.put('/api/agent-notes', (req, res) => {
  const { id, note } = req.body;
  if (typeof id !== 'string' || !id.trim()) return res.status(400).json({ error: 'id must be a non-empty string' });
  if (typeof note !== 'string') return res.status(400).json({ error: 'note must be a string' });
  const value = note.trim().slice(0, 200); // mirror rename/collection name caps
  if (!cfg.agentNotes || typeof cfg.agentNotes !== 'object' || Array.isArray(cfg.agentNotes)) cfg.agentNotes = {};
  if (value) cfg.agentNotes[id] = value;
  else delete cfg.agentNotes[id]; // empty/blank note → remove the key entirely
  save(cfg);
  res.json({ ok: true, notes: cfg.agentNotes });
});

// Session tags — short reusable labels a human puts on a past Claude session so the
// ☁ sessions list can be filtered (e.g. #shipped, #needs-review). A local sidecar
// keyed by claude-session id (mirrors /api/agent-notes' id→value map): tags are
// NEVER written into Claude's transcript files. WARDEN-342. Orphan handling is the
// frontend's job — a tag on a session that later vanishes is ignored, never throws
// (same leniency cfg.pins/cfg.agentNotes already imply for vanished chats).
app.get('/api/session-tags', (_req, res) => res.json({ sessionTags: cfg.sessionTags || {} }));
app.put('/api/session-tags', (req, res) => {
  const { id, tags } = req.body;
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
  save(cfg);
  res.json({ ok: true, id, tags: cleaned });
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
function localClaudeSessions(limit = 40) {
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
async function remoteClaudeSessions(host, limit = 40) {
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

// ---- read-only transcript view (WARDEN-233) ----
// Caps for the read-only single-session viewer. A huge transcript must not blow
// up the UI or the remote SSH transfer. SESSION_VIEW_MAX_BYTES bounds the body
// transfer (a `tail -c` window remotely / a tail read locally); the head window
// for cwd is the same 8KB the list endpoints already read. SESSION_VIEW_MAX_MESSAGES
// is a secondary message-count cap (most-recent kept) so a transcript of many
// short messages stays bounded too.
const SESSION_VIEW_MAX_BYTES = 400_000;
const SESSION_VIEW_MAX_MESSAGES = 500;

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
function readLocalSessionTranscript(id, opts = {}) {
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
  const { sessions, hasMore, totals } = mergeAndPaginateSessions(buckets, offset, limit);
  res.json({ sessions, hasMore, totals });
});

// GET /api/budget — the cached token-spend budget snapshot (WARDEN-415). Cheap
// by design: the slow-cadence accumulator (tickBudget) computes this every
// ~120s by reusing the existing per-session token fetch, so this handler only
// reads the cache — no transcript reads, no SSH. Returns `enabled:false` with
// zeroed fields when the budget is off (or before the first sweep lands) so the
// frontend can render the progress surface + run the debounce check uniformly.
// `windowHours` is derived from the cached windowMs so the UI speaks hours.
app.get('/api/budget', (_req, res) => {
  const b = budgetState;
  if (!cfg.tokenBudgetEnabled || !b) {
    const { threshold, perSessionThreshold, windowHours } = resolveBudgetConfig(cfg);
    return res.json({
      enabled: !!cfg.tokenBudgetEnabled,
      threshold,
      perSessionThreshold,
      windowHours,
      fleetSpent: 0,
      sessionCount: 0,
      fleetBreached: false,
      perSessionBreached: false,
      topOffender: null,
      // Empty until the first sweep lands (WARDEN-466) — no sessions to join yet.
      sessionUsage: [],
      alerted: false,
      evaluatedAt: null,
    });
  }
  res.json({
    enabled: true,
    threshold: b.threshold,
    perSessionThreshold: b.perSessionThreshold,
    windowHours: b.windowMs / 3_600_000,
    fleetSpent: b.fleetSpent,
    sessionCount: b.sessionCount,
    fleetBreached: b.fleetBreached,
    perSessionBreached: b.perSessionBreached,
    topOffender: b.topOffender,
    // Per-session usage distribution (WARDEN-466) — the map /api/health joins on.
    sessionUsage: Array.isArray(b.sessionUsage) ? b.sessionUsage : [],
    alerted: b.alerted,
    evaluatedAt: b.evaluatedAt,
  });
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
// unreachable' } (run()'s default timeout means it never hangs) rather than failing.
app.get('/api/claude-session', async (req, res) => {
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
      view = readLocalSessionTranscript(id, { before });
    } else {
      const rr = await run(host, buildSessionReadScript(id, { before }), { timeout: 15000 });
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

// Run a command LOCALLY without blocking the event loop — the async, spawn-based
// twin of the spawnSync calls that previously froze the whole server for the
// duration of every local git / docker-exec / rg / grep on a request path
// (WARDEN-441). Mirrors run() in ssh.js (spawn + Promise) so the LOCAL transports
// are consistent with the remote path's existing async pattern. stdout/stderr are
// accumulated as UTF-8 STRINGS and returned as { ok, code, stdout, stderr } — the
// same shape runGit/runInContext already hand their callers — plus `error` (the
// spawn Error, with .code e.g. 'ENOENT') when the binary could not be spawned, so
// hasBinary() can distinguish an absent tool from a normal non-zero exit.
//
// stderr is CAPTURED (not inherited) so git/rg diagnostics ("fatal: not a git
// repository") reach the caller via .stderr instead of spewing on the server
// console — matching runLocalSearch's discipline and the remote run() path. Like
// run(), output is UNBOUNDED: the route-level capDiff() guard and the streamed
// search bounding remain the single truncation points (a spawnSync maxBuffer used
// to mask a large diff as a non-zero exit; the async read completes with status 0
// and lets capDiff truncate cleanly).
function runLocalCapture(bin, args, { cwd, timeout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = timeout ? setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* noop */ } }, timeout) : null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr, error: err });
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

// Run git locally, async (non-blocking). Used by /api/git-status, /api/git-log,
// /api/git-diff, /api/git-blame and the manual-LOCAL branch of runGit. Captures
// stdout/stderr as strings (see runLocalCapture) and centralizes windowsHide so a
// local git call never flashes a visible console window when warden runs as a
// packaged/detached app. Remote chats go through run() (ssh.js), which is already
// async and hides. Returns { ok, code, stdout, stderr }.
async function runLocalGit(args, cwd) {
  return runLocalCapture('git', args, { cwd });
}

// Resolve the working directory for a chat's git operations (WARDEN-235).
//
// yatfa (container) chats carry an IN-CONTAINER path derived at discovery (the
// agent tmux pane's cwd, else the image WorkingDir). It must NEVER fall back to
// Warden's own process.cwd(): that path is the host's, not the container's, so a
// LOCAL yatfa agent would silently surface WARDEN'S repo state — actively
// misleading, the core bug this ticket fixes. When derivation failed we return ''
// and the route's existing `!cwd` guard emits a graceful `error: 'no cwd'` (never
// a 500), which is correct: better no badge than a wrong one.
//
// manual/tmux chats keep the original local fallback (their cwd is a real host
// path, and LOCAL manual chats have always shown the host repo at process.cwd()).
export function gitCwd(chat) {
  if (chat.container) return chat.cwd || '';
  return chat.cwd || (chat.host === LOCAL ? process.cwd() : '');
}

// Run `git <args>` for a chat, choosing the transport by kind/host (WARDEN-235).
// Returns { ok, code, stdout, stderr } with STRING stdout/stderr so call sites
// read `.stdout` directly (no `.toString()`). Mirrors runLocalGit's windowsHide
// centralization while adding the docker-exec branch yatfa chats need — their cwd
// is an in-container path the host (and a bare remote `cd`) cannot reach.
//
//   yatfa LOCAL   → docker exec <c> git -C <cwd> <args>   (argv, NO shell — safe)
//   yatfa REMOTE  → ssh host 'docker exec <c> git -C <cwd> <args>'
//   manual LOCAL  → runLocalGit('git', args, {cwd})        (async, non-blocking)
//   manual REMOTE → ssh host 'cd <cwd> && git <args>'      (unchanged)
//
// `-C <cwd>` (not a shell `cd`) targets git at the in-container dir with zero
// injection surface on the local branch (argv); the remote branch shellQuotes
// cwd + each arg (the same WARDEN-122 discipline as git-log/show). `2>/dev/null`
// on the remote branches swallows non-git / detached noise so a non-repo reads
// as empty, mirroring runLocalGit's non-zero-exit tolerance.
export async function runGit(chat, args, cwd) {
  if (chat.container) {
    if (chat.host === LOCAL) {
      const argv = buildDockerGitArgv(chat.container, cwd, args);
      return runLocalCapture(argv[0], argv.slice(1));
    }
    const a = args.map(shellQuote).join(' ');
    return run(chat.host, `docker exec ${shellQuote(chat.container)} git -C ${shellQuote(cwd)} ${a} 2>/dev/null`, { timeout: 8000 });
  }
  if (chat.host === LOCAL) {
    return runLocalGit(args, cwd);
  }
  const a = args.map(shellQuote).join(' ');
  return run(chat.host, `cd ${shellQuote(cwd)} && git ${a} 2>/dev/null`, { timeout: 8000 });
}

// Deliver a SHELL SCRIPT to the chat's execution context (WARDEN-235). Used by
// git operations that need in-context shell features the argv `runGit` path
// can't express — chiefly the in-progress-operation marker `test` (MERGE_HEAD
// etc.) and the realpath/cd containment guards, which must run where the git
// dir actually lives (inside the container for yatfa, on the remote host for
// manual-remote). Returns { ok, code, stdout, stderr }.
//
//   yatfa LOCAL   → docker exec <c> bash -lc <script>   (script's `cd <cwd>` is in-container)
//   yatfa REMOTE  → ssh host 'docker exec <c> bash -lc <script>'
//   manual REMOTE → ssh host '<script>'                 (run() already wraps bash -lc)
//
// Never called for manual-LOCAL: that path keeps the host-fs existsSync
// implementation (the marker files and realpath are reachable on this machine).
async function runInContext(chat, script, { timeout = 8000 } = {}) {
  if (chat.container) {
    if (chat.host === LOCAL) {
      return runLocalCapture('docker', ['exec', chat.container, 'bash', '-lc', script]);
    }
    return run(chat.host, `docker exec ${shellQuote(chat.container)} bash -lc ${shellQuote(script)}`, { timeout });
  }
  return run(chat.host, script, { timeout });
}

// Build the shell script that detects an in-progress git operation under `cwd`
// by testing the well-known marker files git writes under the git dir. Pure
// (just builds a string) so it is unit-testable, mirroring buildGitDiffScript /
// buildGitBlameScript. A repo can be in ONE state, so the test order is the
// priority (first match wins). The `{ ... }` group's exit status is that of its
// LAST test (non-zero when BISECT_LOG is absent, even mid-merge), so callers
// parse STDOUT, not `.ok`. Delivered via runInContext (docker-exec for yatfa,
// ssh for manual-remote); manual-LOCAL uses the host-fs path in detectInProgress
// instead. The `2>/dev/null` on rev-parse swallows non-git/detached → empty →
// operation null (graceful, never a 500). See WARDEN-235.
//
// Each matching marker echoes ONE record line carrying the operation PLUS its
// raw progress detail, pipe-delimited so detectInProgress can parse it in one
// pass (WARDEN-511): `merge|<MERGE_HEAD-sha>`, `rebase|<msgnum>|<end>|<onto>|
// <stopped-sha>`, etc. rebase-apply (no step files) and bisect (no detail) echo
// a bare operation name → detail null. Callers take the FIRST non-empty line
// (priority order), so only the highest-priority in-progress op is reported.
export function buildInProgressScript(cwd) {
  return `cd ${shellQuote(cwd)} && gd=$(git rev-parse --git-dir 2>/dev/null) && ` +
    `{ [ -f "$gd/MERGE_HEAD" ] && echo "merge|$(cat "$gd/MERGE_HEAD" 2>/dev/null)"; ` +
    `[ -f "$gd/CHERRY_PICK_HEAD" ] && echo "cherry-pick|$(cat "$gd/CHERRY_PICK_HEAD" 2>/dev/null)"; ` +
    `[ -f "$gd/REVERT_HEAD" ] && echo "revert|$(cat "$gd/REVERT_HEAD" 2>/dev/null)"; ` +
    `[ -d "$gd/rebase-merge" ] && echo "rebase|$(cat "$gd/rebase-merge/msgnum" 2>/dev/null)|$(cat "$gd/rebase-merge/end" 2>/dev/null)|$(cat "$gd/rebase-merge/onto" 2>/dev/null)|$(cat "$gd/rebase-merge/stopped-sha" 2>/dev/null)"; ` +
    `[ -d "$gd/rebase-apply" ] && echo rebase; ` +
    `[ -f "$gd/BISECT_LOG" ] && echo bisect; }`;
}

// Read+trim a git marker file under git-dir `gd`. Returns '' on any error (the
// file is absent or unreadable) so a partial marker state never throws — only
// used by detectInProgress's manual-LOCAL host-fs path, which (unlike the script
// path) reaches the marker files on this machine's fs directly.
function readMarker(gd, name) {
  try {
    return fs.readFileSync(path.join(gd, name), 'utf8').trim();
  } catch {
    return '';
  }
}

// Shorten a hex object name (40-char SHA from a marker file) to the ~7-char
// display form git's own `rev-parse --short` produces, mirroring the headSha
// discipline at the /api/git-status route. A non-hex value (a ref name, should a
// marker ever hold one) is returned verbatim — never mis-truncated. null when
// empty so the caller can omit the segment entirely.
function shortObjName(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return /^[0-9a-f]{7,40}$/i.test(s) ? s.slice(0, 7) : s;
}

// Parse a non-negative integer marker value (msgnum/end), or null when it is
// absent/non-numeric — so a missing step file degrades to a skipped segment
// rather than a misleading "0".
function parseStepNum(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

// Parse ONE in-progress-operation record into { operation, detail } (WARDEN-511).
// The record is the line buildInProgressScript echoes — a bare operation
// (`bisect`, or `rebase` for the step-less rebase-apply backend) or
// `op|<raw marker values>`:
//   merge|<MERGE_HEAD-sha>   cherry-pick|<sha>   revert|<sha>
//   rebase|<msgnum>|<end>|<onto>|<stopped-sha>
// Pure + exported so BOTH detectInProgress code paths share it: the in-context
// script path feeds the first stdout line; the manual-LOCAL host-fs path builds
// the identical record from readMarker and feeds it — guaranteeing the same
// detail for the same on-disk state regardless of transport, and giving the
// detail logic one unit-testable seam (mirrors buildInProgressScript). Returns
// { operation: null, detail: null } for a blank line (graceful, never throws).
// detail is null when no progress info is available: bisect, rebase-apply, a
// rebase-merge state with no step files yet, or an empty *_HEAD. The detail is a
// display-ready fragment the badge appends after "<op> in progress · ".
export function parseInProgressDetail(line) {
  const trimmed = String(line == null ? '' : line).trim();
  if (!trimmed) return { operation: null, detail: null };
  const sep = trimmed.indexOf('|');
  const operation = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const tail = sep === -1 ? '' : trimmed.slice(sep + 1);
  let detail = null;
  if (operation === 'merge' || operation === 'cherry-pick' || operation === 'revert') {
    // tail is the full SHA from the *_HEAD file — the commit being applied.
    detail = shortObjName(tail);
  } else if (operation === 'rebase') {
    // rebase-merge step files: msgnum/end (step N/M), onto (the new base SHA),
    // stopped-sha (the commit that failed to apply). onto/stopped-sha are hex
    // object names → shortened; each present piece joins the detail, so a
    // partial state (e.g. stopped-sha absent early in a rebase) still renders
    // whatever subset exists. All absent → null (rebase-apply degrades here too,
    // since its backend never carries these files).
    const [msgnum, end, onto, stopped] = tail.split('|');
    const mn = parseStepNum(msgnum);
    const en = parseStepNum(end);
    const ontoShort = shortObjName(onto);
    const stoppedShort = shortObjName(stopped);
    const parts = [];
    if (mn && en) parts.push(`${mn}/${en}`);
    if (ontoShort) parts.push(`onto ${ontoShort}`);
    if (stoppedShort) parts.push(`stopped at ${stoppedShort}`);
    detail = parts.length ? parts.join(' · ') : null;
  }
  // bisect (and any unknown operation) carry no progress detail — operation
  // name alone, exactly as before WARDEN-511.
  return { operation, detail };
}

// Detect an in-progress git operation (merge/cherry-pick/revert/rebase/bisect)
// and, where git records it, the progress detail (rebase step N/M · onto ·
// stopped-sha; the SHA being applied for merge/cherry-pick/revert). manual-LOCAL
// stats the marker files on the host fs and feeds the shared parseInProgressDetail
// seam a record built from readMarker; every other transport (yatfa local+remote,
// manual-remote) runs buildInProgressScript in-context and feeds its first stdout
// line to the same parser — the marker files live beyond the host fs (in-container
// or on the remote host), so only a shell `test`+`cat` delivered there can reach
// them. Returns { operation, detail } (both null when nothing is in progress).
// Display only, read-only — never mutates the repo (WARDEN-28, WARDEN-511).
async function detectInProgress(chat, cwd) {
  if (!chat.container && chat.host === LOCAL) {
    const gitDirResult = await runLocalGit(['rev-parse', '--git-dir'], cwd);
    const gitDir = gitDirResult.stdout.trim() || '';
    if (!gitDir) return { operation: null, detail: null };
    const gd = path.resolve(cwd, gitDir);
    if (fs.existsSync(path.join(gd, 'MERGE_HEAD')))
      return parseInProgressDetail(`merge|${readMarker(gd, 'MERGE_HEAD')}`);
    if (fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD')))
      return parseInProgressDetail(`cherry-pick|${readMarker(gd, 'CHERRY_PICK_HEAD')}`);
    if (fs.existsSync(path.join(gd, 'REVERT_HEAD')))
      return parseInProgressDetail(`revert|${readMarker(gd, 'REVERT_HEAD')}`);
    if (fs.existsSync(path.join(gd, 'rebase-merge')))
      return parseInProgressDetail(`rebase|${readMarker(gd, 'rebase-merge/msgnum')}|${readMarker(gd, 'rebase-merge/end')}|${readMarker(gd, 'rebase-merge/onto')}|${readMarker(gd, 'rebase-merge/stopped-sha')}`);
    // rebase-apply (the older git rebase / git pull --rebase backend) has NO
    // step files — surface the operation with a null detail rather than a
    // misleading "step 0/0".
    if (fs.existsSync(path.join(gd, 'rebase-apply'))) return { operation: 'rebase', detail: null };
    if (fs.existsSync(path.join(gd, 'BISECT_LOG'))) return { operation: 'bisect', detail: null };
    return { operation: null, detail: null };
  }
  const r = await runInContext(chat, buildInProgressScript(cwd));
  const firstLine = (r.stdout || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return parseInProgressDetail(firstLine);
}

app.get('/api/git-status', async (req, res) => {
  const chatId = String(req.query.id || '');
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ branch: null, detached: false, headSha: null, clean: null, cwd: '', ahead: null, behind: null, upstream: null, inProgress: { operation: null, detail: null }, stashCount: null, diffstat: null, files: null, error: 'no cwd' });

    // branch / status / ahead-behind / detached / stash all run via runGit: argv
    // (no shell) for the LOCAL transports, ssh for the remote ones — and for yatfa
    // chats (container set) each call is wrapped in `docker exec … git -C <cwd>` so
    // git runs INSIDE the container against the in-container path (WARDEN-235).
    // The old per-transport if/else collapses into one runGit call per probe; the
    // detached-HEAD detection (WARDEN-239) rides the same transport so it lights
    // up for yatfa agents too.
    const branchR = await runGit(chat, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const branch = branchR.ok ? branchR.stdout.trim() : '';

    const statusR = await runGit(chat, ['status', '--porcelain'], cwd);
    // NOTE: parse the raw bytes — git status codes can start with a leading
    // space (" M" = unstaged mod), so the output must NOT be trimmed as a
    // whole or the first file's path is corrupted. See parseGitStatusPorcelain.
    const files = parseGitStatusPorcelain(statusR.ok ? statusR.stdout : '');
    const clean = files.length === 0;

    // ahead/behind upstream: @{u}...HEAD symmetric diff. Non-zero exit (no
    // upstream, detached HEAD, non-git cwd) → empty stdout → nulls. See parseAheadBehind.
    const abR = await runGit(chat, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd);
    const { ahead, behind } = parseAheadBehind(abR.ok ? abR.stdout : '');

    // Upstream tracking branch (WARDEN-243). `git rev-parse --abbrev-ref @{u}`
    // prints the short upstream name (e.g. origin/feature) + exit 0 when one is
    // configured, and exits non-zero with empty stdout when HEAD has NO upstream
    // — a named branch never `push -u`'d. ahead/behind alone can't tell that
    // branch from a synced 0/0 one (both → nulls with no @{u}), so without this
    // a never-pushed branch renders as a bare cyan label indistinguishable from
    // in-sync: a durability risk (local-only work, no remote backup) a human
    // needs to see at a glance. Same `@{u}` rev spec + runGit transport as the
    // ahead/behind call above (so it lights up for yatfa containers too,
    // WARDEN-235) and shellQuote'd on the remote branch inside runGit (the
    // WARDEN-122 brace-expansion lesson — `@{u}` must not reach a shell bare).
    const upR = await runGit(chat, ['rev-parse', '--abbrev-ref', '@{u}'], cwd);
    const upstream = parseUpstream(upR.ok ? upR.stdout : '');

    // Detached-HEAD detection (WARDEN-239). `git symbolic-ref -q HEAD` exits
    // non-zero iff HEAD is detached (it prints refs/heads/<name> + exit 0 when on
    // a branch) — the canonical test, more reliable than `branch === 'HEAD'` (a
    // branch could in principle be named "HEAD"). Run via runGit so it ALSO works
    // inside a yatfa container (WARDEN-235). Guarded by `branch` (truthy ⟺ the
    // rev-parse above succeeded ⟺ we're inside a real repo) so a NON-git cwd —
    // where symbolic-ref also fails — is NOT misread as detached. The short SHA
    // replaces the misleading literal "HEAD" label the badge would otherwise show;
    // it's only fetched when detached to keep the normal branch path's command
    // set unchanged.
    const symRefResult = await runGit(chat, ['symbolic-ref', '-q', 'HEAD'], cwd);
    const detached = isDetachedHead(symRefResult.code, !!branch);
    let headSha = null;
    if (detached) {
      const shaResult = await runGit(chat, ['rev-parse', '--short', 'HEAD'], cwd);
      headSha = normalizeHeadSha(shaResult.stdout, shaResult.code);
    }

    const inProgressState = await detectInProgress(chat, cwd);

    // Shelved WIP: `git stash list` emits one line per stash, empty when none.
    // --porcelain status never surfaces stashes, so a clean tree with parked work
    // would otherwise read clean:true — count the list so the badge can show 🗄️ N
    // (WARDEN-211). Non-git/empty → parseStashCount nulls it.
    const stashR = await runGit(chat, ['stash', 'list'], cwd);
    const stashCount = parseStashCount(stashR.ok ? stashR.stdout : '');

    // Working-tree WIP magnitude (WARDEN-411): `git diff HEAD --shortstat` prints
    // a one-line "N files changed, N insertions(+), N deletions(-)" summary of the
    // combined (staged + unstaged) edits vs HEAD. Where stashCount surfaces PARKED
    // work and the porcelain file list surfaces WHICH files are dirty, this surfaces
    // HOW MUCH — a 4-file WIP could be four one-line tweaks or a 1000-line rewrite,
    // and this is the only signal that distinguishes them at a glance. Read-only
    // (the withdrawn WARDEN-199 branch-switch slice is the cautionary tale; this
    // stays on the read side). Same runGit transport as the probes above, so it runs
    // inside yatfa containers via `docker exec … git -C <cwd>` too (WARDEN-235).
    // parseDiffStat nulls empty/garbage (incl. a clean tree and an all-untracked
    // WIP — `git diff HEAD` counts tracked edits only); the `branch` gate keeps
    // non-git/detached consistent with stashCount.
    const diffstatR = await runGit(chat, ['diff', 'HEAD', '--shortstat'], cwd);
    const diffstat = parseDiffStat(diffstatR.ok ? diffstatR.stdout : '');

    res.json({
      branch: branch || null,
      // detached: true only inside a real repo whose HEAD is not on a branch.
      // headSha: the short SHA shown in place of the misleading "HEAD" label.
      // The branch ? gate is kept so files/clean/inProgress still surface on a
      // detached HEAD (you still want to see uncommitted changes); ahead/behind
      // are already null there (parseAheadBehind returns nulls with no @{u})
      // (WARDEN-239).
      detached,
      headSha,
      clean: branch ? clean : null,
      cwd,
      ahead: branch ? ahead : null,
      behind: branch ? behind : null,
      // upstream: the short tracking branch name (e.g. origin/feature), or null
      // when HEAD has no upstream — gated on `branch` like ahead/behind so a
      // detached HEAD / non-git cwd reads null (WARDEN-243). ahead/behind are
      // already null there, so this is what lets the badge tell a never-pushed
      // branch from a synced 0/0 one.
      upstream: branch ? upstream : null,
      inProgress: { operation: branch ? inProgressState.operation : null, detail: branch ? inProgressState.detail : null },
      stashCount: branch ? stashCount : null,
      // diffstat: net insertions/deletions of the working-tree edits vs HEAD
      // (WARDEN-411), or null for a clean / non-git / detached repo. Gated on
      // `branch` like stashCount; parseDiffStat already nulls an all-untracked WIP.
      diffstat: branch ? diffstat : null,
      files: branch ? files : null,
      error: null,
    });
  } catch (e) {
    res.json({ branch: null, detached: false, headSha: null, clean: null, cwd: chat.cwd || '', ahead: null, behind: null, upstream: null, inProgress: { operation: null, detail: null }, stashCount: null, diffstat: null, files: null, error: e.message });
  }
});

// Which remote repo a checkout points at + its web host URL (WARDEN-528). The one
// coordination fact a multi-project human needs that every OTHER git facet omits:
// `git status` exhaustively surfaces local state (branch/ahead/behind/diff/…) but
// never WHICH source host the working tree maps to. `git remote -v` does, and from
// its URLs we derive `{ host, owner, repo, web }` so the branch badge can show
// `github · owner/repo` and deep-link the branch/HEAD/upstream to the host.
//
// Mirrors /api/git-status exactly: resolve(chatId) → 404 guard → gitCwd(chat) →
// graceful `{ remotes: [] }` when no cwd / non-git / zero remotes (never 500).
// `git remote -v` is read-only (no `-v` mutation path exists), and runGit routes
// it through the same transport as the status probes (argv `docker exec … git -C`
// for yatfa containers, ssh for manual-remote) so it lights up for every agent
// kind. parseGitRemotes (gitStatus.js) dedupes the fetch/push duplicate per remote
// and parses each URL; empty/non-git stdout → [].
app.get('/api/git-remote', async (req, res) => {
  const chatId = String(req.query.id || '');
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ remotes: [], error: 'no cwd' });

    const remoteR = await runGit(chat, ['remote', '-v'], cwd);
    const remotes = parseGitRemotes(remoteR.ok ? remoteR.stdout : '');
    res.json({ remotes, error: null });
  } catch (e) {
    res.json({ remotes: [], error: e.message });
  }
});

// Parse one `--pretty=format:%h|%s|%an|%ar|%ct` line into
// { hash, subject, author, date, epoch }. Field order:
//   hash | subject | author | relative-date(%ar) | committer-epoch(%ct)
// hash/author/date/epoch are pipe-free (epoch is a bare UNIX-second integer); the
// subject sits between hash and author and MAY contain '|' (a commit message like
// "merge a | b"). So peel the hash off the front and peel epoch/date/author off the
// BACK (each on its own last '|'), leaving whatever remains as the subject. `epoch`
// is the EXACT committer timestamp (git %ct, seconds) — the precise field the
// frontend's per-agent "What's new since" since-filter compares against lastSeen
// (WARDEN-356). It's a Number when the field parses as an integer, else null (a
// degraded/partial line from an older caller) — never a string, so the comparison
// is numeric. Exported for tests.
export function parseGitLogLine(line) {
  const firstPipe = line.indexOf('|');
  if (firstPipe === -1) return { hash: line, subject: '', author: '', date: '', epoch: null };
  const hash = line.slice(0, firstPipe);
  const tail = line.slice(firstPipe + 1); // subject|author|date|epoch (subject may contain |)
  // Peel the three trailing pipe-free fields (epoch, date, author) off the back, one
  // lastIndexOf('|') at a time. Each peel returns null when no '|' remains — meaning
  // the leftover string IS that field and there are no fields further left.
  const peel = (s) => {
    const i = s.lastIndexOf('|');
    return i === -1 ? null : { val: s.slice(i + 1), rest: s.slice(0, i) };
  };
  // epoch (committer UNIX ts) — last field.
  const e = peel(tail);
  if (!e) return { hash, subject: tail, author: '', date: '', epoch: null };
  const epochRaw = e.val;
  // date (relative %ar) — second-to-last.
  const d = peel(e.rest);
  if (!d) return { hash, subject: '', author: '', date: e.rest, epoch: toEpoch(epochRaw) };
  const date = d.val;
  // author — third-to-last.
  const a = peel(d.rest);
  if (!a) return { hash, subject: '', author: d.rest, date, epoch: toEpoch(epochRaw) };
  return { hash, subject: a.rest, author: a.val, date, epoch: toEpoch(epochRaw) };
}

// Parse git's %ct (committer date, UNIX seconds) into a Number, or null when the
// field is absent/non-numeric (a degraded line). %ct is always an integer from git;
// the null path only covers partial/test inputs. Centralized so parseGitLogLine's
// peeling stays readable.
function toEpoch(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && raw.trim() !== '' && /^[0-9]+$/.test(raw.trim()) ? n : null;
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

// Strip a commit message's subject line so only the BODY shows in an expanded
// commit. git's `%B` (raw body, fetched by commitMessage below) is
// "<subject>\n\n<body>…": the collapsed row already shows the subject (cm.subject),
// so rendering raw `%B` would echo the subject again as the first line. We keep
// only the body AFTER the first blank line. A subject-only commit (no blank line,
// i.e. no body) → '' so the UI renders nothing extra for it. CRLF-tolerant so a
// remote transport's \r\n doesn't hide the split. Exported (pure) so the
// subject-strip rule has a unit test (WARDEN-388).
export function stripCommitSubject(raw) {
  const s = (raw ?? '').toString().replace(/\r\n/g, '\n');
  const i = s.indexOf('\n\n');
  return i === -1 ? '' : s.slice(i + 2).trim();
}

// The `--pretty=format:` used by /api/git-log: short hash | subject | author |
// relative date | committer epoch. Named (not inlined) so the field order is
// documented at a glance and grep-able. The '|' separators are passed as ONE argv
// element to runGit (no shell on the LOCAL branch) and shellQuote'd on the remote
// branch, so they're argument characters — never read as shell pipes (the
// WARDEN-122 quoting lesson). The trailing `%ct` (committer date, UNIX seconds)
// gives the frontend's per-agent "What's new since" filter an EXACT timestamp to
// compare against lastSeen (WARDEN-356) — the relative `%ar` is coarse and would
// mislabel already-seen commits as new as it ages, so the filter must use `%ct`.
const GIT_LOG_PRETTY = '%h|%s|%an|%ar|%ct';
// WARDEN-498: the commit-message search window. Browse caps at 50 (limit clamped to
// [1,50] in the handler), but search exists to FIND a commit that may sit far down
// history, so it uses this larger ceiling instead. A few hundred covers a long project
// history without an unbounded scan; still bounded so a huge repo can't exhaust argv
// or the response. Absent `grep` never reaches this path (browse keeps `limit`).
const GIT_LOG_GREP_MAX = 200;

// Recent commit history (git log) for a chat's repo. All transports go through
// runGit (WARDEN-235): manual-local async runLocalGit, manual-remote SSH, and yatfa
// containers via `docker exec … git -C <cwd>`. A non-git or no-cwd repo yields an
// empty list (never a 500). limit is clamped to [1, 50]. An optional `path` filters
// to file-history mode (git log --follow -- <path>, WARDEN-319). An optional `grep`
// searches commit MESSAGES (git log --grep=<term> -i, WARDEN-498) over a wider
// window (GIT_LOG_GREP_MAX) so an old commit is findable.
app.get('/api/git-log', async (req, res) => {
  const chatId = String(req.query.id || '');
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10) || 5, 1), 50);
  // range selects a commit window:
  //   incoming → HEAD..@{u}  (commits @{u} has that HEAD doesn't — the "behind" list)
  //   outgoing → @{u}..HEAD  (commits HEAD has that @{u} doesn't — the "unpushed/ahead" list)
  //   absent   → today's HEAD-reachable log.
  // @{u} is git's upstream rev spec, already used by /api/git-status's ahead/behind
  // count, so this introduces no new staleness or network fetch. The ahead/behind
  // COUNT shipped in WARDEN-153; the behind LIST in WARDEN-225; this completes the
  // explorable ahead half (WARDEN-252). Strictly read-only — no fetch/pull/merge/checkout.
  const range = String(req.query.range || '');
  const rangeRev = range === 'incoming' ? 'HEAD..@{u}' : range === 'outgoing' ? '@{u}..HEAD' : null;
  // Optional path filter (WARDEN-319): when present, switch to file-history mode —
  // list every commit that touched this ONE file (`git log --follow -- <path>`),
  // the temporal counterpart to blame. A git pathspec validated with the same
  // isSafeRelativePath the per-file git-show route uses (WARDEN-151). Absent `path`
  // → byte-for-byte today's behavior (existing callers send none).
  const filePath = String(req.query.path || '').trim();
  // Optional commit-message search (WARDEN-498): when present, splice
  // `git log --grep=<term> -i` so a human can find WHEN a change landed by message
  // instead of scrolling the per-agent commit lists. Mirrors how `path` was added
  // (WARDEN-319): parsed here, length-capped (≤128) to bound argv, passed as a SINGLE
  // argv element locally and shellQuote'd remotely (WARDEN-122 — the `=` stays one
  // argument; never let it reach a shell). `-i` makes it case-insensitive; `--grep`
  // matches the full message (subject + body) by default — exactly what WARDEN-387/388
  // made visible. Absent `grep` → byte-for-byte today's behavior (existing callers send
  // none).
  const grep = String(req.query.grep || '').trim().slice(0, 128);
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  // Reject unsafe per-file paths (absolute / traversal) before any git invocation —
  // mirrors git-show's isSafeRelativePath guard. Bad path → empty list, never a 500.
  if (filePath && !isSafeRelativePath(filePath)) {
    return res.json({ commits: [], error: 'invalid path' });
  }

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ commits: [], error: 'no cwd' });

    // short hash | subject | author | relative date | committer epoch (GIT_LOG_PRETTY).
    // runGit passes
    // --pretty (and the range rev) as a single argv element (no shell on the LOCAL
    // branch) so the '|' separators can't be read as pipes and the @{u}..HEAD range
    // stays brace-expansion-safe; the remote branch shellQuotes each arg for the same
    // reason (WARDEN-122). yatfa chats run this inside the container (WARDEN-235).
    // range=incoming/outgoing splices in the corresponding rev; absent → HEAD log.
    // WARDEN-498: a present `grep` splices `--grep=<term>` + `-i` (case-insensitive,
    // matches subject AND body) as the FIRST log options — before the limit/range/pretty
    // args — and widens the window to GIT_LOG_GREP_MAX (an old commit may sit beyond the
    // 50-commit browse cap; the point of search is to FIND it). Absent `grep` →
    // searchLimit === limit, so the browse path is byte-for-byte unchanged.
    const searchLimit = grep ? GIT_LOG_GREP_MAX : limit;
    const args = ['log'];
    if (grep) args.push(`--grep=${grep}`, '-i');
    if (filePath) {
      // File-history mode (WARDEN-319): --follow tracks the file across renames and
      // yields every commit that touched it (newest first). incoming/outgoing is a
      // repo-wide range concept that doesn't apply to one file's full history, so
      // rangeRev is intentionally NOT spliced here. `--follow` must precede --pretty
      // and the pathspec must be the single path after `--` (--follow requires exactly
      // one pathspec); `--` terminates option parsing so a path named like a flag
      // can't inject options — same WARDEN-122 discipline as git-show's per-file path.
      args.push(`-${searchLimit}`, '--follow', `--pretty=format:${GIT_LOG_PRETTY}`, '--', filePath);
    } else {
      if (rangeRev) args.push(rangeRev);
      args.push(`-${searchLimit}`, `--pretty=format:${GIT_LOG_PRETTY}`);
    }
    const r = await runGit(chat, args, cwd);
    const raw = r.ok ? r.stdout.trim() : '';

    const commits = raw ? raw.split('\n').map(parseGitLogLine) : [];
    res.json({ commits, error: null });
  } catch (e) {
    res.json({ commits: [], error: e.message });
  }
});

// ---- Per-file git diff (WARDEN-151) ----------------------------------------
// The depth layer between WARDEN-107 (which files changed) and WARDEN-39 (read
// the current file): show WHAT an agent changed in one file. Mirrors
// /api/git-status + /api/read-file: chat-scoped, cwd-contained, local async runLocalGit
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
//
// `staged` (WARDEN-369) swaps `git diff HEAD` for `git diff --cached` so clicking a
// STAGED file shows exactly what will be committed (the index-vs-HEAD diff) rather
// than the combined worktree-vs-HEAD diff. `git diff --cached` is strictly read-only
// (NOT in the forbidden mutating-ops set — see the read-only contract comment above
// /api/git-diff), so this stays within Warden's by-design read-only contract.
export function buildGitDiffScript(cwd, filePath, staged) {
  const diffCmd = staged ? 'git diff --cached' : 'git diff HEAD';
  return `CWD=${shellQuote(cwd)}; FILE=${shellQuote(filePath)}; RESOLVED_CWD="$(cd "$CWD" && pwd -P)" || { echo "ERROR invalid path"; exit 1; }; RESOLVED="$(cd "$RESOLVED_CWD" && realpath -m -- "$FILE" 2>/dev/null)" || RESOLVED="$RESOLVED_CWD/$FILE"; case "$RESOLVED" in "$RESOLVED_CWD"/*|"$RESOLVED_CWD") ;; *) echo "ERROR path must be within working directory"; exit 1 ;; esac; ${diffCmd} -- "$FILE" 2>/dev/null`;
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
//
// `staged` (WARDEN-369) runs `git diff --cached` (index-vs-HEAD, exactly what will
// be committed) instead of `git diff HEAD` (combined staged+unstaged). Read-only.
export async function getLocalGitDiff(cwd, filePath, staged) {
  if (!isPathWithinCwd(cwd, filePath)) {
    return { error: 'path must be within working directory', status: 403 };
  }

  const result = await runLocalGit(staged ? ['diff', '--cached', '--', filePath] : ['diff', 'HEAD', '--', filePath], cwd);
  let diff = capDiff(result.stdout || '');

  if (diff.length === 0) {
    // Empty diff is ambiguous: a clean tracked file vs an untracked ('??') file HEAD
    // has no record of. `git ls-files --error-unmatch` exits non-zero for a path git
    // doesn't track. (Containment above already guaranteed the path is within cwd, so
    // a non-zero exit here means untracked, not "outside repo".) For staged mode an
    // empty diff means "nothing staged for this path" — the file is tracked, so this
    // check returns tracked and the empty diff flows through unchanged.
    const tracked = await runLocalGit(['ls-files', '--error-unmatch', '--', filePath], cwd);
    if (!tracked.ok) return { diff: null, untracked: true };
  }

  return { diff, untracked: false };
}

// Diff one file vs HEAD on a host whose git dir is NOT on this machine's fs —
// i.e. a yatfa container (local OR remote: the cwd is an in-container path) or a
// manual-remote host. Mirrors getLocalGitDiff's result shape and untracked
// disambiguation, but the containment check lives inside buildGitDiffScript's
// bash, delivered via runInContext (docker-exec for yatfa, ssh for manual-remote)
// so the `cd <cwd>` + `realpath` resolve where the repo actually is. The remote
// untracked check is a second runInContext (only when the diff is empty) so the
// common case stays a single round-trip. See WARDEN-235.
async function getDeliveredGitDiff(chat, cwd, filePath, staged) {
  const script = buildGitDiffScript(cwd, filePath, staged);
  const r = await runInContext(chat, script);
  if (!r.ok) {
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (out.includes('ERROR path must be within working directory')) {
      return { error: 'path must be within working directory', status: 403 };
    }
    if (out.includes('ERROR invalid path')) {
      return { error: 'invalid path', status: 400 };
    }
    // git diff exits non-zero on a non-git cwd or transport failure — surface as an
    // error string rather than a 500 (matches git-status/git-log's soft failure).
    return { error: 'diff failed' };
  }

  let diff = capDiff(r.stdout || '');

  if (diff.length === 0) {
    const trackedScript = `cd ${shellQuote(cwd)} && git ls-files --error-unmatch -- ${shellQuote(filePath)} 2>/dev/null`;
    const t = await runInContext(chat, trackedScript);
    if (!t.ok) return { diff: null, untracked: true };
  }

  return { diff, untracked: false };
}

// GET /api/git-diff?id=<chatId>&path=<file> — unified diff of one file vs HEAD.
//   ?staged=1 — diff the INDEX vs HEAD instead (exactly what will be committed),
//               so clicking a staged file shows its staged-only diff, not the
//               combined worktree-vs-HEAD diff (WARDEN-369). `git diff --cached`
//               is strictly read-only (see the contract comment below).
// Response: { diff: string|null, untracked: boolean, path, error }
app.get('/api/git-diff', async (req, res) => {
  const filePath = String(req.query.path || '').trim();
  if (!filePath) return res.status(400).json({ diff: null, untracked: false, path: '', error: 'path is required' });
  const staged = String(req.query.staged || '') === '1';

  const { chat, error } = await resolve(String(req.query.id || ''));
  if (error) return res.status(404).json({ diff: null, untracked: false, path: filePath, error });

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ diff: null, untracked: false, path: filePath, error: 'no cwd' });

    // manual-LOCAL can stat the worktree on the host fs (getLocalGitDiff). Every
    // other transport — yatfa container (the cwd is in-container) or manual-remote
    // — runs the diff in-context via docker-exec/ssh (getDeliveredGitDiff), so the
    // realpath containment + git diff resolve where the repo actually lives.
    const result = (!chat.container && chat.host === LOCAL)
      ? await getLocalGitDiff(cwd, filePath, staged)
      : await getDeliveredGitDiff(chat, cwd, filePath, staged);

    if (result.status) return res.status(result.status).json({ diff: null, untracked: false, path: filePath, error: result.error });
    if (result.error) return res.json({ diff: null, untracked: false, path: filePath, error: result.error });
    res.json({ diff: result.diff, untracked: !!result.untracked, path: filePath, error: null });
  } catch (e) {
    res.json({ diff: null, untracked: false, path: filePath, error: e.message });
  }
});

// ---- Aggregated range diff (WARDEN-398) ------------------------------------
// The net unified diff of an agent's whole unpushed (↑N) or incoming (↓N) set, as
// ONE view — the literal completion of the per-commit exploration arc (WARDEN-252
// ahead list / WARDEN-303 explorable / WARDEN-348 incoming / WARDEN-180 inline diff
// / WARDEN-225 behind list). Today the GitBranchBadge popover shows the commit
// LISTS and supports drilling into ONE commit at a time, but the question a human
// actually asks — "what is this agent about to push?" / "what will land if I bring
// it up to upstream?" — is answerable only by expanding N commits and mentally
// aggregating. This diffs the two tips directly so the total change is visible at
// once. Strictly read-only — no fetch/pull/merge/checkout (the WARDEN-199 line).
//
//   GET /api/git-range-diff?id=<chatId>&range=outgoing|incoming|worktree
//     → { diff: string|null, error: string|null }
//
// Range semantics reuse /api/git-log's exact `range` param:
//   outgoing → @{u}..HEAD   (the net change that lands on push)
//   incoming → HEAD..@{u}   (the net change that lands on a pull)
//   worktree → HEAD         (the combined staged+unstaged change vs HEAD — ± axis)
// We use TWO-DOT (`@{u}..HEAD` ≡ `git diff @{u} HEAD`): the diff BETWEEN the two
// tips = the honest "what changes when these two states meet." Three-dot would
// diff from the merge-base (only HEAD's side since divergence); for a fast-forward
// agent ahead of a still upstream the two are identical, and they diverge only if
// upstream also moved — two-dot is the more honest "net" answer.
//
// Because there is NO user-supplied file pathspec, the realpath containment
// ceremony of /api/git-diff (buildGitDiffScript / isPathWithinCwd) does NOT apply
// — this route stays simple like /api/git-log. Output is capped at 1MB via capDiff.
// A non-zero git exit is surfaced as a clean user-facing error — never a 500:
//   outgoing/incoming with no upstream (or detached HEAD) → 'no upstream configured'
//   worktree on an unborn HEAD (fresh repo, no commits)     → 'no commits yet ...'
// mirroring how every other git route tolerates a non-git/no-upstream repo.
app.get('/api/git-range-diff', async (req, res) => {
  const chatId = String(req.query.id || '');
  const range = String(req.query.range || '');
  // Same rev map as /api/git-log (outgoing → @{u}..HEAD, incoming → HEAD..@{u}),
  // reused verbatim so the diff honors the identical range definition the commit
  // LIST already uses — the net diff over exactly those commits. worktree → 'HEAD'
  // runs `git diff HEAD` (no pathspec → combined staged+unstaged tracked changes vs
  // HEAD), the SAME set WARDEN-411's `git diff HEAD --shortstat` counts, so the
  // ± magnitude chip and the full-diff content stay consistent by construction.
  const rangeRev =
    range === 'outgoing' ? '@{u}..HEAD'
    : range === 'incoming' ? 'HEAD..@{u}'
    : range === 'worktree' ? 'HEAD'
    : null;
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ diff: null, error });

  // Reject any range value other than outgoing/incoming/worktree cleanly — never a 500
  // (mirrors /api/git-show's rejection of a malformed hash: 200 + error string).
  if (!rangeRev) {
    return res.json({ diff: null, error: 'invalid range' });
  }

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ diff: null, error: 'no cwd' });

    // runGit passes the range rev as a single argv element (no shell on the LOCAL
    // branch) so @{u}..HEAD stays brace-expansion-safe; the remote branch
    // shellQuotes it (WARDEN-122). yatfa chats run this inside the container
    // (WARDEN-235). `git diff @{u}..HEAD` exits non-zero when no upstream is
    // configured (or HEAD is detached) → surfaced as a clean user-facing error
    // rather than a 500. For worktree (`git diff HEAD`) the realistic non-zero is
    // an unborn HEAD (fresh repo, no commits) — unrelated to upstream, so the error
    // is range-aware: it says so rather than misleadingly claiming "no upstream".
    const r = await runGit(chat, ['diff', rangeRev], cwd);
    if (!r.ok) {
      return res.json({
        diff: null,
        error: range === 'worktree'
          ? 'no commits yet (nothing to compare against HEAD)'
          : 'no upstream configured',
      });
    }
    res.json({ diff: capDiff(r.stdout || ''), error: null });
  } catch (e) {
    res.json({ diff: null, error: e.message });
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
// async runLocalGit, remote chats run over SSH with shellQuote(cwd)+shellQuote(hash). A
// non-git / no-cwd / unknown-hash repo yields an empty result (never a 500).
//
//   GET /api/git-show?id=<chatId>&hash=<hash>           → { files: [{path,status}] }
//   GET /api/git-show?id=<chatId>&hash=<hash>&path=<p>  → { diff: "<patch text>" }
//
// `hash` is clamped to short/long hex ([0-9a-f]{4,40}) — anything else (e.g.
// "--version", shell metacharacters) is rejected before it reaches git or the remote
// shell, mirroring the shellQuote care taken in /api/git-log. `path`, when present,
// is a git pathspec and gets the isSafeRelativePath containment check.
//
// commitMessage: fetch a commit's full message (git's %B: subject + body) WITHOUT
// computing a diff (--no-patch ≡ -s), then cap + strip it to the BODY only. `hash`
// is already hex-validated by the route ([0-9a-f]{4,40}), so it's safe as argv
// after `git -C <cwd>` (local) / the shellQuoted remote form (the same WARDEN-122
// discipline as the rest of this route). The 1MB cap (capDiff — byte-accurate, no
// lone surrogate) bounds a pathological message; stripCommitSubject drops the
// subject the collapsed row already shows. Returns '' for a subject-only commit
// (no body) or a non-ok git result, so the UI renders the message block
// unconditionally and it just hides when empty. Shared by the no-path and per-file
// branches so both commit inspectors (sidebar expand + FileViewer blame/history)
// surface the "why" (WARDEN-388). Read-only: honors the WARDEN-199 no-mutation line.
async function commitMessage(chat, hash, cwd) {
  const r = await runGit(chat, ['show', '--no-patch', '--format=%B', hash], cwd);
  if (!r.ok) return '';
  return stripCommitSubject(capDiff(r.stdout || ''));
}

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
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ files: [], diff: null, error: 'no cwd' });

    // runGit collapses the local/remote branches and runs inside the container
    // for yatfa chats (WARDEN-235). `hash` is already hex-validated above and the
    // per-file `path` is a git pathspec (isSafeRelativePath), so both are safe as
    // argv after `git -C <cwd>` / the shellQuoted remote form.
    let files = [];
    let diff = null;
    let message = '';
    if (filePath) {
      // --format= strips the commit header (author/date/message) so we get ONLY the
      // file's patch — exactly what inspecting a single file should surface. The
      // commit's full message rides a separate --no-patch call (commitMessage) so the
      // FileViewer blame/history popover can show the "why" above this diff too.
      const r = await runGit(chat, ['show', '--format=', hash, '--', filePath], cwd);
      diff = capDiff(r.ok ? r.stdout : '');
      message = await commitMessage(chat, hash, cwd);
    } else {
      const r = await runGit(chat, ['show', '--name-status', '--pretty=format:', hash], cwd);
      files = parseGitShowNameStatus(r.ok ? r.stdout : '');
      // The commit's full message (body) rides this same detail fetch — no extra
      // round-trip for the primary path. parseGitShowNameStatus stays untouched (the
      // %B fetch is deliberately separate so the name-status parser isn't complicated).
      message = await commitMessage(chat, hash, cwd);
    }

    res.json({ files, diff, message, error: null });
  } catch (e) {
    res.json({ files: [], diff: null, error: e.message });
  }
});

// ---- File blob at a historical commit (WARDEN-354) --------------------------
// The temporal file-exploration trio's full-snapshot leg: blame = per-line
// provenance (WARDEN-206), history = commit sequence + per-file diff (WARDEN-319),
// this = the file's FULL content as it existed at a commit (git show <hash>:<path>).
// Read-only — consistent with the git-status/log/diff/show/stash/blame set. No
// checkouts, no mutating ops (the WARDEN-199 line stays read-only).
//
//   GET /api/git-cat-file?id=<chatId>&hash=<hash>&path=<file>
//     → { content: string|null, error: string|null }
//
// Mirrors /api/git-show's resolve → hex-validate hash → isSafeRelativePath →
// gitCwd guard → runGit → never-500 shape, and layers /api/read-file's 1MB +
// binary guards on top (a blob is full file content, not a diff, so an oversize
// blob is a clean size error rather than a silent truncation). `hash` is hex-
// validated and `path` is isSafeRelativePath-checked, so `${hash}:${path}` is
// safe as a single argv element (no shell on the local branch; shellQuoted
// remotely). A non-git cwd, a deleted-at-commit path, or an invalid hash yields
// a clean empty/error result — never a 500.
app.get('/api/git-cat-file', async (req, res) => {
  const chatId = String(req.query.id || '');
  const hash = String(req.query.hash || '');
  const filePath = String(req.query.path || '').trim();
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  // Reject malformed hashes before any git invocation: hex only, 4–40 chars.
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    return res.json({ content: null, error: 'invalid hash' });
  }
  // Empty path → nothing to read; unsafe path → 'invalid path' (never 500).
  if (!filePath) return res.json({ content: null, error: 'path is required' });
  if (!isSafeRelativePath(filePath)) return res.json({ content: null, error: 'invalid path' });

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ content: null, error: 'no cwd' });

    // Binary by extension: mirror /api/read-file (a .png at a commit is still a
    // .png). Checked before any git call so we never transfer garbled bytes.
    if (isBinaryFile(filePath)) {
      return res.json({ content: null, error: 'cannot read binary files' });
    }

    // Pre-check existence + size with `git cat-file -s` (tiny output, never hits
    // a maxBuffer). An oversize blob is a clean size error BEFORE we transfer its
    // bytes — mirroring /api/read-file's stat-before-read (a blob is full file
    // content, so a truncation would mislead; we error instead). A path that
    // doesn't exist at this commit (deleted/never touched) exits non-zero here.
    const sizeR = await runGit(chat, ['cat-file', '-s', `${hash}:${filePath}`], cwd);
    if (!sizeR.ok) {
      // Distinguish a non-git cwd (soft failure → clean empty, mirroring git-show)
      // from a path that doesn't exist at this commit (→ helpful 'not found at
      // commit'). Both are 200, never a 500.
      const probe = await runGit(chat, ['rev-parse', '--is-inside-work-tree'], cwd);
      const isRepo = probe.ok && (probe.stdout || '').trim() === 'true';
      return res.json({ content: null, error: isRepo ? 'not found at commit' : null });
    }
    const size = parseInt(sizeR.stdout || '', 10);
    if (Number.isNaN(size)) return res.json({ content: null, error: 'not found at commit' });
    if (size > GIT_DIFF_MAX_BYTES) {
      return res.json({ content: null, error: 'file too large (max 1MB)' });
    }

    // `git show <hash>:<path>` emits the full blob bytes. hash is hex-validated
    // and filePath is isSafeRelativePath-checked, so `<hash>:<path>` is safe as
    // one argv element after `git -C <cwd>` / the shellQuoted remote form. The
    // size pre-check above guarantees the blob fits the transport's maxBuffer.
    const r = await runGit(chat, ['show', `${hash}:${filePath}`], cwd);
    if (!r.ok) {
      return res.json({ content: null, error: 'not found at commit' });
    }
    const raw = r.stdout || '';
    // Defense-in-depth: a file with a non-binary extension but binary content
    // (e.g. an extension-less blob) would decode to garbled UTF-8. Detect a NUL
    // byte anywhere in the content — git's own binary heuristic.
    if (isBinaryBlob(raw)) {
      return res.json({ content: null, error: 'cannot read binary files' });
    }
    res.json({ content: raw, error: null });
  } catch (e) {
    res.json({ content: null, error: e.message });
  }
});

// ---- Per-side conflict content (WARDEN-428) --------------------------------
// Read-only ours-vs-theirs view for a conflicted path (UU/AA/UD/…). When an agent
// is stuck mid-merge/rebase/cherry-pick, clicking a conflicted file from the
// changed-files list opens THIS — the two conflicting sides from git's stage
// blobs — instead of the generic `git diff --cached`, which for an unmerged path
// is not a usable ours/theirs view. Completes WARDEN-186's conflict-STATE
// visibility (the red `!XY` badge) with conflict-CONTENT.
//
//   GET /api/git-conflict?id=<chatId>&path=<file>
//     → { ours: string|null, theirs: string|null, path: string, error: string|null }
//
// `ours`   = `git show :2:<path>` (stage 2 = HEAD / the current branch).
// `theirs` = `git show :3:<path>` (stage 3 = MERGE_HEAD / the branch being merged).
// Stage blobs :2:/:3: exist by definition for any unmerged path (that is exactly
// what UNMERGED_STATUS_CODES means), so this is uniform across every conflict code.
//
// Mirrors /api/git-cat-file (a blob READ, not a diff), NOT /api/git-diff: resolve
// → gitCwd guard → isSafeRelativePath (the cat-file/read-file guard, NOT
// isPathWithinCwd — a stage blob is read by git, not from the host fs) →
// isBinaryFile extension check → size pre-check via `git cat-file -s :2:`/`:3:`
// against GIT_DIFF_MAX_BYTES → `git show :N:<path>` → isBinaryBlob NUL-byte
// defense-in-depth. `${stage}:${filePath}` is safe as one argv element after
// `git -C <cwd>` / the shellQuoted remote form (filePath is isSafeRelativePath-
// checked), mirroring cat-file's `${hash}:${filePath}`.
//
// Edge cases: if a stage blob is absent (modify/delete UD/DU, or both-deleted DD)
// that side returns null cleanly — a one-sided conflict still renders the present
// side. When BOTH sides are absent we distinguish a non-git cwd (soft-fail → null
// sides, null error, mirroring cat-file's rev-parse --is-inside-work-tree probe)
// from a real repo where both blobs are genuinely absent (DD / path not conflicted
// → a helpful 'no conflict content' error). Every failure path returns 200 with a
// populated `error` / null sides — never a 500.
//
// Read-only contract: `git show :N:` and `git cat-file -s :N:` are strictly
// read-only — identical in kind to the already-shipped `git show <hash>:<path>`
// (cat-file) and `git diff` (git-diff). No merge/checkout/add/rm. This stays on
// the WARDEN-199 read-only line the git-status/log/diff/show/cat-file/blame set
// already honors.
app.get('/api/git-conflict', async (req, res) => {
  const chatId = String(req.query.id || '');
  const filePath = String(req.query.path || '').trim();
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ ours: null, theirs: null, path: filePath, error });

  // Empty path → nothing to read; unsafe path → 'invalid path' (never 500),
  // mirroring cat-file's guards exactly.
  if (!filePath) return res.json({ ours: null, theirs: null, path: '', error: 'path is required' });
  if (!isSafeRelativePath(filePath)) return res.json({ ours: null, theirs: null, path: filePath, error: 'invalid path' });

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ ours: null, theirs: null, path: filePath, error: 'no cwd' });

    // Binary by extension: mirror /api/git-cat-file (a conflicted .png is still a
    // .png). Checked before any git call so we never transfer garbled bytes.
    if (isBinaryFile(filePath)) {
      return res.json({ ours: null, theirs: null, path: filePath, error: 'cannot read binary files' });
    }

    // Read each stage blob (:2: ours, :3: theirs) independently. A side whose
    // `cat-file -s` fails is absent (modify/delete conflict, or DD both-deleted) →
    // that side stays undefined (→ null) cleanly; the present side still renders.
    // An oversize or binary side aborts the whole response with a clean error
    // (mirroring cat-file: a truncation would mislead, and a conflict view needs
    // both sides to be honest). `sides[stage]` may legitimately be '' (an empty
    // file), so the absence → null mapping below uses `!== undefined`, NOT a
    // truthiness test that would collapse '' to null.
    const sides = {};
    for (const stage of ['2', '3']) {
      const sizeR = await runGit(chat, ['cat-file', '-s', `:${stage}:${filePath}`], cwd);
      if (!sizeR.ok) continue; // stage blob absent → side stays undefined (→ null)
      const size = parseInt(sizeR.stdout || '', 10);
      if (Number.isNaN(size)) continue;
      if (size > GIT_DIFF_MAX_BYTES) {
        return res.json({ ours: null, theirs: null, path: filePath, error: 'file too large (max 1MB)' });
      }
      const r = await runGit(chat, ['show', `:${stage}:${filePath}`], cwd);
      if (!r.ok) continue; // blob vanished between -s and show → treat as absent
      const raw = r.stdout || '';
      // Defense-in-depth: a non-binary extension whose stage content is binary
      // (e.g. an extension-less blob) decodes to garbled UTF-8. NUL = binary.
      if (isBinaryBlob(raw)) {
        return res.json({ ours: null, theirs: null, path: filePath, error: 'cannot read binary files' });
      }
      sides[stage] = raw;
    }
    const ours = sides['2'] !== undefined ? sides['2'] : null;
    const theirs = sides['3'] !== undefined ? sides['3'] : null;

    // Both sides absent: distinguish a non-git cwd (soft-fail → null error,
    // mirroring cat-file's rev-parse probe) from a real repo where both stage
    // blobs are genuinely absent (DD both-deleted, or the path isn't conflicted).
    if (ours === null && theirs === null) {
      const probe = await runGit(chat, ['rev-parse', '--is-inside-work-tree'], cwd);
      const isRepo = probe.ok && (probe.stdout || '').trim() === 'true';
      return res.json({ ours: null, theirs: null, path: filePath, error: isRepo ? 'no conflict content' : null });
    }

    res.json({ ours, theirs, path: filePath, error: null });
  } catch (e) {
    res.json({ ours: null, theirs: null, path: filePath, error: e.message });
  }
});

// Shelved work-in-progress detail (git stash list). Mirrors /api/git-log: local
// chats run git via async runLocalGit, remote chats run over SSH with shellQuote(cwd).
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
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ stashes: [], error: 'no cwd' });

    // reflog selector | subject | relative date  (subject may contain '|'). runGit
    // passes --pretty as one argv element (no shell on LOCAL) so '|' isn't read as
    // a pipe; the remote branch shellQuotes it (WARDEN-122). yatfa chats run this
    // inside the container (WARDEN-235).
    const pretty = '%gd|%s|%cr';
    const r = await runGit(chat, ['stash', 'list', `--pretty=format:${pretty}`], cwd);
    const raw = r.ok ? r.stdout.trim() : '';

    const stashes = raw ? parseStashList(raw) : [];
    res.json({ stashes, error: null });
  } catch (e) {
    res.json({ stashes: [], error: e.message });
  }
});

// Git reflog — an agent's operation history (WARDEN-460). The fourth read-only
// "axis" alongside commit history (/api/git-log), working-tree state
// (/api/git-status), and shelved WIP (/api/git-stash): the NON-commit git
// operations an autonomous agent performs that leave no commit AND no dirty file
// — `git reset --hard` to a clean tree, `git checkout` to another branch, an
// abandoned/aborted rebase, a force-push, a cherry-pick rewind. Those live ONLY
// in the reflog, so when a human opens an agent that looks "clean" but is on a
// surprising branch (or whose commits seem to have vanished after a reset), this
// is what makes it diagnosable in-UI. It is also the recovery handle the detached
// -HEAD tooltip already gestures at ("at risk if reflog expires") but never
// exposed. Mirrors /api/git-stash's transport/shape exactly. Read-only by
// construction: `git reflog` (the read form) only, never `git reflog expire`/
// `delete` (the WARDEN-199 read-only line the whole git-status/log/diff/show/
// cat-file/conflict/stash/blame set holds).
//
//   GET /api/git-reflog?id=<chatId>  → { entries: [{ hash, subject, date }], error }
app.get('/api/git-reflog', async (req, res) => {
  const chatId = String(req.query.id || '');
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ entries: [], error: 'no cwd' });

    // abbreviated hash | reflog subject (the OPERATION, e.g. "reset: moving to
    // HEAD~1") | relative committer date. The subject may itself contain '|'. We
    // reuse git-stash's `%gd|%s|%cr` pipe format so `parseReflog` peels the subject
    // front/back exactly like `parseStashList`. runGit passes --pretty as one argv
    // element (no shell on LOCAL) so '|' isn't read as a pipe; the remote branch
    // shellQuotes it (WARDEN-122). yatfa chats run this inside the container
    // (WARDEN-235). Capped at the last 50 entries — the recent operation window a
    // human needs to answer "what did this agent just do to its repo?".
    const pretty = '%h|%gs|%cr';
    const r = await runGit(chat, ['reflog', '-n', '50', `--pretty=format:${pretty}`], cwd);
    const raw = r.ok ? r.stdout.trim() : '';

    const entries = raw ? parseReflog(raw) : [];
    res.json({ entries, error: null });
  } catch (e) {
    res.json({ entries: [], error: e.message });
  }
});

// ---- Per-line git blame / annotate (WARDEN-206) -----------------------------
// Read-only provenance for the file a human is viewing in FileViewer: which
// commit / author / date last touched each line. Strictly observational — `git
// blame` only, no checkout or any mutating op (the WARDEN-199 line the roadmap
// stays on the read-only side of). Mirrors /api/git-show's resolve → cwd guard →
// isSafeRelativePath → local async runLocalGit vs remote run() → capDiff → never-500
// shape. A non-git / no-cwd / binary / unblamable file yields an empty list.

// `summary` is truncated per line so a giant commit message can't dominate the
// payload. Mirrors the compactness discipline of parseGitLogLine / parseGitShowNameStatus.
const GIT_BLAME_SUMMARY_MAX = 80;

// Parse `git blame --line-porcelain -- <file>` output into compact per-line
// provenance: [{ line, hash, author, date, summary }]. `--line-porcelain` emits a
// FULL header block for every line (unlike `--porcelain`, which may group lines),
// so each record is: a header line `<hash> <sourceline> <resultline> [<group>]`,
// detail lines (`author`/`author-mail`/`author-time`/`summary`/…), then the file
// content on a TAB-prefixed line that terminates the record. We track the in-flight
// record and emit it when we hit that TAB line. `date` is author-time (epoch sec)
// rendered to ISO 8601 — a PURE function of the input (so the parser is unit-
// testable with a fixed epoch) and the frontend formats it relative for display.
// `summary` is truncated to GIT_BLAME_SUMMARY_MAX. Exported for unit tests.
// See WARDEN-206.
export function parseGitBlame(output) {
  const raw = (output ?? '').toString();
  if (!raw) return [];
  // Tolerate CRLF (remote blame can arrive over an SSH pty with \r\n line ends),
  // mirroring parseGitShowNameStatus's CRLF tolerance.
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));
  const out = [];
  let cur = null;
  for (const ln of lines) {
    // A TAB-prefixed line is the file content for the current record → finalize it.
    if (ln.charCodeAt(0) === 0x09) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    // Record header: <hash> <sourceline> <resultline> [<group-size>]. resultline
    // (m[3]) is the line number in HEAD — exactly what FileViewer renders.
    const m = ln.match(/^([0-9a-f]{4,40})\s+(\d+)\s+(\d+)/);
    if (m) {
      cur = { line: parseInt(m[3], 10), hash: m[1], author: '', authorTime: null, summary: '' };
    } else if (cur) {
      // `author ` does not match `author-mail ` (7th char is '-' vs ' '), so the
      // mail line is naturally skipped — we skim it but don't emit it (compact shape).
      if (ln.startsWith('author ')) {
        cur.author = ln.slice(7);
      } else if (ln.startsWith('author-time ')) {
        const n = parseInt(ln.slice(12).trim(), 10);
        cur.authorTime = Number.isFinite(n) ? n : null;
      } else if (ln.startsWith('summary ')) {
        cur.summary = ln.slice(8);
      }
    }
  }
  return out.map((r) => ({
    line: r.line,
    hash: r.hash,
    author: r.author,
    date: Number.isFinite(r.authorTime) ? new Date(r.authorTime * 1000).toISOString() : '',
    summary: r.summary.length > GIT_BLAME_SUMMARY_MAX
      ? `${r.summary.slice(0, GIT_BLAME_SUMMARY_MAX - 1)}…`
      : r.summary,
  }));
}

// Build the remote (SSH) shell command that blames one file under `cwd`. Extracted
// (and exported) so the fragile shell template is unit-tested directly, the same way
// buildGitDiffScript / buildReadFileScript are. shellQuote yields a single-quoted
// POSIX token spliced in bare — same WARDEN-122 quoting discipline as git-log/show —
// and the `--` stops option parsing so a path named like a flag can't inject options.
// Mirrors /api/git-show's remote command shape.
export function buildGitBlameScript(cwd, filePath) {
  return `cd ${shellQuote(cwd)} && git blame --line-porcelain -- ${shellQuote(filePath)} 2>/dev/null`;
}

//   GET /api/git-blame?id=<chatId>&path=<file> → { lines: [{line,hash,author,date,summary}], error }
//
// `path` is a git pathspec and gets the isSafeRelativePath containment check (bad
// path → empty, never 500), mirroring /api/git-show's per-file guard. Output is
// capped via capDiff/GIT_DIFF_MAX_BYTES before parsing (blame on a large file can
// be big) — a truncation that may drop the final partial record, never a 500.
app.get('/api/git-blame', async (req, res) => {
  const chatId = String(req.query.id || '');
  const filePath = String(req.query.path || '').trim();
  const { chat, error } = await resolve(chatId);
  if (error) return res.status(404).json({ error });

  // Empty path → nothing to blame (not an error). Unsafe path → empty + 'invalid path'
  // (mirrors git-show: never a 500).
  if (!filePath) return res.json({ lines: [], error: null });
  if (!isSafeRelativePath(filePath)) return res.json({ lines: [], error: 'invalid path' });

  try {
    const cwd = gitCwd(chat);
    if (!cwd) return res.json({ lines: [], error: 'no cwd' });

    let raw = '';
    if (!chat.container && chat.host === LOCAL) {
      // manual-LOCAL: runLocalGit (async, non-blocking) on the host fs.
      // `--line-porcelain` for the stable, machine-parseable per-line header block
      // the parser above consumes.
      const r = await runLocalGit(['blame', '--line-porcelain', '--', filePath], cwd);
      raw = capDiff(r.stdout || '');
    } else {
      // container (local+remote) or manual-remote: buildGitBlameScript delivered
      // in-context via runInContext (docker-exec for yatfa, ssh for manual-remote)
      // so the `cd <cwd>` + `git blame` run where the repo lives. The `2>/dev/null`
      // in the script swallows git's "no such file" / "not a git repo" noise so a
      // non-git cwd reads as empty, not an error. See WARDEN-235.
      const rr = await runInContext(chat, buildGitBlameScript(cwd, filePath));
      raw = capDiff(rr.ok ? (rr.stdout || '') : '');
    }

    const lines = parseGitBlame(raw);
    res.json({ lines, error: null });
  } catch (e) {
    res.json({ lines: [], error: e.message });
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
  const host = String(req.body?.host || LOCAL).trim() || LOCAL;
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!session || !name) return res.status(400).json({ error: 'session and name required' });
  const catalog = loadCatalog();
  // Composite identity: a session name can repeat across hosts, so scope the find
  // to host+session (host defaults to local for callers that don't send it).
  const entry = catalog.find((c) => sameCatalogEntry(c, host, session));
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
  // An OMITTED cmd defaults to claude (the historical spawn default). An EXPLICIT
  // empty string is honored as-is: it flows through to tmux `new-session` with no
  // trailing command, so the host launches its own login shell — the ＋ split
  // "no explicit shell" case (WARDEN-223). (Previously `||` collapsed both into
  // claude, so an empty cmd could never spawn a bare shell.)
  const cmdRaw = req.body?.cmd;
  const cmd = (cmdRaw === undefined ? 'claude --dangerously-skip-permissions' : String(cmdRaw)).trim();
  if (!session) return res.status(400).json({ error: 'session name is required' });
  if (!NAME_RE.test(session)) return res.status(400).json({ error: 'invalid session name (letters/digits/_-.)' });
  const catalog = loadCatalog();
  // Composite identity: the same session name may exist on a DIFFERENT host (each
  // host's tmux server is independent), so only a same-host collision blocks spawn.
  if (catalog.some((c) => sameCatalogEntry(c, host, session))) return res.status(409).json({ error: `"${session}" already exists` });
  const r = await buildAndSpawn({ host, session, name: req.body?.name || session, cwd, cmd });
  if (r.error) return res.status(r.status).json({ error: r.error });
  saveCatalog([...catalog, { kind: 'tmux', host, session, name: r.chat.name, cwd, cmd }]);
  // Record the human's own spawn action so a returning human can see the agents
  // they brought up (WARDEN-484). Mirrors the existing attached/ended row shape.
  appendEvent({ type: 'spawned', id: r.chat.id, host, container: r.chat.container ?? null, role: r.chat.role, name: r.chat.name });
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
  // Composite identity: only replace THIS host's same-named resume entry; a
  // different host may legitimately carry the same resume-<sid> session name.
  const catalog = loadCatalog().filter((c) => !sameCatalogEntry(c, host, session));
  saveCatalog([...catalog, { kind: 'tmux', host, session, name, cwd, cmd: chat.cmd }]);
  // Record the human's own resume action (WARDEN-484). container is always null
  // here (resume spawns a bare-tmux session), matching the existing row shape.
  appendEvent({ type: 'resumed', id: out.id, host, container: null, role: out.role, name });
  res.json({ ok: true, chat: out });
});

app.post('/api/kill', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  const chat = r.chat;
  // Kill the tmux session for ANY chat type (yatfa or spawned). For yatfa this
  // kills the agent's tmux session inside the container (container keeps running).
  try { await killTmux(chat, cfg); } catch { /* noop */ }
  // Remove from catalog (spawned chats only; yatfa are auto-discovered).
  // Composite identity: only drop the killed chat's own host+session entry — a
  // different host may carry the same session name and must be left intact.
  if (chat.kind === 'tmux') saveCatalog(loadCatalog().filter((c) => !sameCatalogEntry(c, chat.host, chat.session)));
  // Record the human's deliberate kill — the authoritative signal that lets a
  // returning human tell an agent THEY stopped apart from one that crashed. Emitted
  // here rather than via the attach-PTY onExit handler, which stays silent for
  // client-killed sessions (server.js:3339) — so this ALWAYS lands, even with no
  // attach-viewer open (WARDEN-484). yatfa chats carry no `name`, so fall back to
  // the container (the agent's display name) for a friendlier label.
  appendEvent({ type: 'killed', id: chat.id, host: chat.host, container: chat.container ?? null, role: chat.role, name: chat.name ?? chat.container ?? null });
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

// Re-create a chat's tmux session by re-running its command (WARDEN-231 recovery
// panel → [Re-spawn agent]). Only chats warden owns — manual/spawned kind:'tmux'
// with a stored `cmd` — are respawnable; yatfa chats have no cmd (their session
// is managed by the running container) and are rejected. Kills any stale session
// first (a dead session is a no-op for kill-session), then spawns under the SAME
// session name so the existing pane/tab re-attaches by id. Does NOT touch the
// catalog — the entry already carries the right cmd/cwd/host/session.
app.post('/api/respawn', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  const chat = r.chat;
  if (chat.kind !== 'tmux' || !chat.cmd) {
    return res.status(400).json({ error: 'this chat has no command to re-spawn (only spawned tmux chats can be re-spawned)' });
  }
  const err = await preflightTmux(chat.host);
  if (err) return res.status(400).json({ error: err });
  // Clear any dead/stale session under this name before recreating it.
  try { await killTmux(chat, cfg); } catch { /* a dead session may not exist */ }
  // Resolve a bare `claude` cmd to its full path on the host — claude is often in
  // a .zshrc-only PATH (e.g. ~/.local/bin) that tmux's non-login shell can't see,
  // so spawning the raw catalog cmd verbatim makes the session die on start on the
  // very remote hosts this recovery path targets (the WARDEN-231 bug report). The
  // catalog stores the RAW user-typed cmd, so resolution must happen here at
  // respawn time. Mirrors buildAndSpawn / /api/resume (both resolve before spawn).
  const resolved = await resolveClaudeCmd(chat.host, chat.cmd);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const spawnChat = { host: chat.host, session: chat.session, cwd: chat.cwd || '', cmd: resolved.cmd };
  try { await spawnTmux(spawnChat); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  // `new-session -d` returns ok even when the inner command fails to start, so
  // verify the session actually came up — mirroring /api/spawn's check.
  if (!(await hasSession(spawnChat, cfg))) {
    const bin = String(resolved.cmd).split(/\s+/)[0] || 'the command';
    return res.status(500).json({ error: `\`${bin}\` failed to start on ${chat.host} — tmux session died immediately. Is it installed and on PATH there?` });
  }
  res.json({ ok: true });
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

// Detect binary content in a decoded blob string (WARDEN-354). `git show
// <hash>:<path>` emits raw bytes; runGit decodes them as UTF-8, so a binary
// blob's NUL bytes (0x00) survive as embedded '\0' characters in the string. A
// NUL anywhere in the content means the blob isn't valid text — git's own
// binary heuristic. The blob is already size-capped to 1MB by the cat-file -s
// pre-check above, so a full scan is cheap. Defense-in-depth behind
// isBinaryFile's extension check (which catches known-binary paths up front);
// this catches an extension-less file whose content is binary so we never emit
// garbled UTF-8. Exported for unit tests.
export function isBinaryBlob(content) {
  if (!content) return false;
  return content.includes('\0');
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

// Build the remote (SSH) shell script that checks a path under `cwd` resolves to
// a real file — WITHOUT reading or transferring any content. The lightweight twin
// of buildReadFileScript: it runs the SAME realpath + cwd-containment + is-file
// guards (same `realpath -e`, same separator-bearing containment `case` glob that
// blocks the prefix-sibling traversal hole), then stops — no size/binary/cat. Used
// by /api/file-exists so the terminal linkifier (WARDEN-227) can confirm a
// candidate is a real file cheaply; it runs per visible terminal candidate, so it
// must not move file bytes. Exported for unit testing, parallel to buildReadFileScript.
export function buildFileExistsScript(cwd, filePath) {
  return `CWD=${shellQuote(cwd)}; FILE=${shellQuote(filePath)}; RESOLVED_CWD="$(realpath -e "$CWD" 2>/dev/null)" || { echo "ERROR invalid path"; exit 1; }; RESOLVED="$(cd "$RESOLVED_CWD" && realpath -e "$FILE" 2>/dev/null)" || { echo "ERROR file not found"; exit 1; }; case "$RESOLVED" in "$RESOLVED_CWD"/*|"$RESOLVED_CWD") ;; *) echo "ERROR path must be within working directory"; exit 1 ;; esac; [ -d "$RESOLVED" ] && { echo "ERROR path is a directory"; exit 1; }; [ -f "$RESOLVED" ] || { echo "ERROR not a file"; exit 1; }; echo EXISTS`;
}

// Is a resolved absolute path contained within a resolved cwd? The separator
// (resolvedCwd + path.sep) is REQUIRED: without it a pure prefix match also
// accepts a sibling whose name merely extends the cwd (e.g. /x/proj-secret.txt
// under cwd /x/proj) — a path-traversal hole. This is the local twin of the
// separator-bearing `case` glob in buildReadFileScript/buildFileExistsScript.
// Factored out of /api/read-file so the existence probe shares the exact same rule.
function isWithinCwd(resolvedPath, resolvedCwd) {
  return resolvedPath === resolvedCwd || resolvedPath.startsWith(resolvedCwd + path.sep);
}

// Shared LOCAL resolution for a chat file: realpath (follow symlinks) both cwd and
// the file, verify cwd-containment, and confirm it is a regular file. Used by both
// /api/read-file (which then layers on the 1MB/binary/read guards) and the
// lightweight /api/file-exists probe, so the resolution behavior — and the cwd
// containment guard — stay identical between the two endpoints. Returns
// { ok: true, resolvedPath } or { ok: false, status, error }.
export function resolveLocalFile(cwd, filePath) {
  let resolvedCwd, resolvedPath;
  try {
    resolvedCwd = fs.realpathSync.native(cwd);
    resolvedPath = fs.realpathSync.native(path.join(cwd, filePath));
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, status: 404, error: 'file not found' };
    return { ok: false, status: 400, error: 'invalid path' };
  }
  if (!isWithinCwd(resolvedPath, resolvedCwd)) {
    return { ok: false, status: 403, error: 'path must be within working directory' };
  }
  try {
    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) return { ok: false, status: 400, error: 'path is a directory' };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, status: 404, error: 'file not found' };
    return { ok: false, status: 500, error: 'read failed' };
  }
  return { ok: true, resolvedPath };
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

  // Security: resolve the path and verify it's within the chat's working directory.
  // The shared resolution (realpath + cwd-containment + is-file) lives in
  // resolveLocalFile so /api/file-exists enforces the identical rule; read-file
  // then layers the 1MB/binary/read guards on top of the resolved path.
  if (chat.host === LOCAL) {
    const resolved = resolveLocalFile(cwd, filePath);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });

    try {
      // Check file size (limit to 1MB to prevent server issues)
      const stats = fs.statSync(resolved.resolvedPath);
      if (stats.size > 1024 * 1024) {
        return res.status(413).json({ error: 'file too large (max 1MB)' });
      }

      // Check for binary files by extension
      if (isBinaryFile(resolved.resolvedPath)) {
        return res.status(400).json({ error: 'cannot read binary files' });
      }

      // Read file content
      const content = fs.readFileSync(resolved.resolvedPath, 'utf8');
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

// POST /api/file-exists — lightweight existence probe for the in-terminal file
// linkifier (WARDEN-227). Body: { id, path }. Confirms `path` resolves to a real
// file within the chat's cwd WITHOUT reading or transferring content, so it is
// cheap enough to run per visible terminal candidate. Reuses the SAME resolution
// discipline as /api/read-file (realpath + cwd-containment + is-file): local chats
// go through the shared resolveLocalFile, remote chats run buildFileExistsScript
// over SSH. Response: { exists: boolean } — any resolution failure (missing, outside
// cwd, directory, ssh error) collapses to exists:false because the linkifier only
// needs yes/no. Security: never weakens the cwd-containment guard.
app.post('/api/file-exists', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.json({ exists: false });

  const filePath = String(req.body?.path || '').trim();
  if (!filePath) return res.json({ exists: false });

  const chat = r.chat;
  const cwd = chat.cwd || '.';

  if (chat.host === LOCAL) {
    return res.json({ exists: resolveLocalFile(cwd, filePath).ok });
  }

  // Remote: run the existence script; success + the EXISTS marker ⇒ real file.
  const result = await run(chat.host, buildFileExistsScript(cwd, filePath), { timeout: 8000 });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  return res.json({ exists: result.ok && out.includes('EXISTS') });
});

// ---- Workspace content search (grep) — WARDEN-145 ---------------------------
// Completes the locate→read loop WARDEN-39 (file reading) started: lets a human
// find a file by CONTENT (function name, error string, …) and open it in the
// FileViewer, instead of having to know the exact path by hand. Mirrors the
// read-file/git-status patterns: chat-scoped, cwd-contained, local async runLocalGit vs
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

// Async, non-blocking wrapper for tiny local PROBE commands only (git rev-parse,
// `rg --version`): bounded by a 10s timeout (SIGTERM) with stderr CAPTURED (not
// inherited) so probe noise ("fatal: not a git repository") never hits the server
// console. The workspace search itself is NOT run through here — it is streamed by
// streamBoundedSearch below so its output is bounded AT THE SOURCE. Delegates to
// runLocalCapture (WARDEN-441): previously a spawnSync that froze the event loop
// on every /api/search-files request while the probe ran.
async function runLocalSearch(bin, args, cwd) {
  return runLocalCapture(bin, args, { cwd, timeout: 10000 });
}

// PATH-presence probe — the local twin of the remote `command -v rg` gate that
// decides whether the non-repo fallback runs ripgrep or plain grep. Async; an
// absent tool surfaces as a spawn ENOENT (runLocalCapture's `error.code`), not
// entangled with a streamed run.
async function hasBinary(bin) {
  const r = await runLocalSearch(bin, ['--version'], undefined);
  return r.error?.code !== 'ENOENT';
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
  // rev-parse output is tiny ("true"), and runLocalSearch is async + bounded by a
  // 10s timeout, so this probe never blocks the event loop.
  const gitCheck = await runLocalSearch('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  const insideRepo = gitCheck.ok && (gitCheck.stdout.trim() === 'true');
  if (insideRepo) {
    // git grep: status 1 = no matches (yields ''); 0 = matches. -I skips binaries.
    return streamBoundedSearch('git', ['grep', '-n', '-I', '-F', '--', query], cwd);
  }
  // Not a git repo → ripgrep (fast, respects .gitignore) then plain grep. -F = literal.
  if (await hasBinary('rg')) {
    return streamBoundedSearch('rg', ['--line-number', '--no-heading', '-F', '--', query, '.'], cwd);
  }
  return streamBoundedSearch('grep', ['-rn', '-I', '-F', '--', query, '.'], cwd);
}

// POST /api/search-files — content-search a chat's working directory (grep).
// Body: { id: string, query: string }
// Response: { results: [{ file, line, text }], query, error?: string }
// Local chats run git/rg/grep via async runLocalGit/streamBoundedSearch; remote chats run buildSearchScript
// over SSH. Mirrors /api/git-status's resolve → cwd guard → local/remote split.
app.post('/api/search-files', async (req, res) => {
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
    if (!chat.container && chat.host === LOCAL) {
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
      // Stash the directive meta alongside the resolver so the gate_decision
      // handler can append a `directive_rejected` event (approved sends are
      // recorded in observer.js at logDirective, which also covers auto-safe).
      const meta = { directive, container: chat.container, host: chat.host, role: chat.role };
      return new Promise((resolveDecision) => pending.set(requestId, { resolve: resolveDecision, meta }));
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
      const entry = pending.get(msg.requestId);
      if (entry) {
        pending.delete(msg.requestId);
        entry.resolve({ approved: !!msg.approved, edited: msg.edited });
        // A human rejection is distinct from an approved send — record it so the
        // timeline can show rejected directives separately from sent ones.
        if (!msg.approved) appendEvent({ type: 'directive_rejected', ...entry.meta });
      }
    }
  });
  ws.on('close', () => { for (const [, entry] of pending) entry.resolve({ approved: false }); });
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

  // WARDEN-413: keep companion pane-push subscriptions in sync with the monitored
  // set. capturePanes (chats.js) renders a companion host from the pushed delta
  // cache and SKIPS the per-tick RPC when the subscription is live, so an idle
  // companion host receives ZERO capturePanes RPCs per monitor tick. Subscriptions
  // are ref-counted across connections in companion.js: each connection subscribes
  // its own panes on monitor and drops them on unmonitor/close, so two tabs
  // watching the same host share one subscription whose pane set is the union.
  // LOCAL + flag-off hosts are excluded (their poll path is unchanged).
  const syncMonitorSubscription = async (chat, subscribe) => {
    if (!chat || !isCompanionTransportEnabled() || chat.host === LOCAL) return;
    try {
      if (subscribe) await subscribePanes(chat.host, [chat], cfg);
      else await unsubscribePanes(chat.host, [chat.key], cfg);
    } catch { /* subscriptions are a pure optimization; the poll path still works */ }
  };

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'monitor') {
      const id = String(m.id);
      // Subscribe only on a NEWLY-added pane so monitor/unmonitor stay balanced
      // per connection (a duplicate monitor must not double-count the ref, or a
      // later single unmonitor/close would leak the subscription). monitors is a
      // Set, so has()-before-add tells us whether this is the first watch.
      const isNew = !monitors.has(id);
      monitors.add(id);
      await resolve(id);
      startMonitor();
      if (isNew) {
        // Subscribe this pane's host to pushed deltas (skip-on-tick gate). resolve()
        // seeded the cache, so the chat is findable by key here. Fire-and-forget:
        // until the delta arrives, capturePanes keeps polling (graceful bootstrap).
        const chat = cache.find((c) => c.key === id || c.id === id);
        syncMonitorSubscription(chat, true);
      }
    }
    else if (m.type === 'unmonitor') {
      const id = String(m.id);
      const wasPresent = monitors.has(id);
      monitors.delete(id);
      stopMonitorIfEmpty();
      if (wasPresent) {
        const chat = cache.find((c) => c.key === id || c.id === id);
        syncMonitorSubscription(chat, false);
      }
    }
    else if (m.type === 'attach') {
      if (attaches.has(m.id)) return;
      // Lazy restore: if the client knows the host (stored when the pane was first
      // opened), discover just that one host so resolve() hits cache — no all-hosts scan.
      if (m.host && !cache.some((c) => c.key === m.id || c.id === m.id)) {
        try {
          const { chats } = await discoverHost(String(m.host), cfg);
          cache = [...cache.filter((c) => c.host !== m.host), ...retainLastActivity(cache, chats)];
        } catch { /* fall through; resolve() still has a locate fallback */ }
      }
      const r = await resolve(String(m.id));
      if (r.error) { send({ type: 'attach_error', id: m.id, error: r.error }); appendEvent({ type: 'error', error: r.error, context: 'attach', id: m.id }); return; }
      const chat = r.chat;
      const cols = Math.max(20, Math.floor(m.cols || 100));
      const rows = Math.max(6, Math.floor(m.rows || 30));
      // Bounded liveness probe BEFORE spawning the live PTY (WARDEN-231). A dead
      // session previously made the attach PTY exit immediately → the server
      // emitted {type:'ended'} → the pane spun an infinite "connecting" spinner
      // with no escape. Probing first lets us tell session-dead (host up, session
      // absent) from host-unreachable (SSH can't deliver) and emit a distinct
      // message the frontend branches on instead of hanging. A null reason means
      // the session is alive (or the probe was inconclusive) → fall through to a
      // normal attach; the frontend's immediate-end backstop still catches any
      // race the probe missed.
      let reason = null;
      try { reason = classifyProbe(await probeSession(chat, cfg)); }
      catch { /* probe threw → leave reason null and attempt a normal attach */ }
      if (reason === 'host_unreachable') {
        send({ type: 'host_unreachable', id: m.id });
        appendEvent({ type: 'error', error: 'host unreachable', context: 'attach', id: m.id, host: chat.host, container: chat.container });
        return;
      }
      if (reason === 'session_dead') {
        send({ type: 'session_dead', id: m.id });
        appendEvent({ type: 'error', error: 'session dead', context: 'attach', id: m.id, host: chat.host, container: chat.container });
        return;
      }

      let pty;
      try { pty = attachStream(chat, cfg, { cols, rows }); }
      catch (e) {
        send({ type: 'attach_error', id: m.id, error: String((e && e.message) || e) });
        appendEvent({ type: 'error', error: String((e && e.message) || e), context: 'attach', id: m.id, host: chat.host, container: chat.container });
        return;
      }
      // WARDEN-365 (defense-in-depth): bind a per-attach `entry` object and gate
      // the ENTIRE onData/onExit body on identity (`attaches.get(m.id) === entry`)
      // so a killed prior PTY can never clobber or pollute a freshly-bound one. A
      // detach→attach (legitimate Retry, or the client's attach-lifecycle) kills
      // the prior PTY and binds a new one under the SAME id; node-pty's kill() is
      // async, so the prior PTY's onExit (and any trailing onData) can fire AFTER
      // the new PTY is bound. If that late onExit were allowed through it would
      // BOTH `attaches.delete(m.id)` the NEW entry (orphaning it: input/resize
      // dropped, a later detach can't kill it) AND send a spurious 'ended' —
      // landing a healthy, just-re-attached pane on the session_dead recovery
      // panel, reproducing the intermittent race-shaped corruption this ticket
      // fixes. The early `return` on identity mismatch suppresses the whole body,
      // so a killed PTY's late exit is fully silent (no delete, no 'ended', no
      // event) whether or not a new PTY has rebound the id — the client initiated
      // that kill, so it is not a "session ended" the client needs to hear about.
      // This also contains the rare concurrent-attach race (two attaches passing
      // the `attaches.has` guard before either sets): the second set wins, the
      // first PTY's data is dropped and its onExit can't touch the live entry.
      const entry = { pty, chat };
      attaches.set(m.id, entry);
      pty.onData((d) => { if (attaches.get(m.id) === entry) send({ type: 'pty', id: m.id, data: d }); });
      pty.onExit(({ exitCode }) => {
        if (attaches.get(m.id) !== entry) return; // stale — killed prior PTY; this exit is not the live session ending
        attaches.delete(m.id);
        send({ type: 'ended', id: m.id, code: exitCode });
        appendEvent({ type: 'ended', id: m.id, code: exitCode, host: chat.host, container: chat.container });
      });
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
    // WARDEN-413: drop this connection's monitored pane refs so a shared
    // subscription is released only when its LAST watcher closes (ref-counted in
    // companion.js). Best-effort + fire-and-forget: a transport hiccup here must
    // not block teardown, and capturePanes falls back to polling either way.
    if (isCompanionTransportEnabled()) {
      const byHost = {};
      for (const k of monitors) {
        // Match the monitor handler's key||id lookup so a host-prefixed monitor id
        // (chat.id) still resolves, and drop the ref by chat.KEY — subscribePanes
        // keys refs by chat.key (describePanes), so the add/drop stay balanced
        // whatever id form the client sent. (WARDEN-413 reviewer minor finding.)
        const chat = cache.find((c) => c.key === k || c.id === k);
        if (chat && chat.host !== LOCAL) (byHost[chat.host] ||= []).push(chat.key);
      }
      for (const [host, keys] of Object.entries(byHost)) {
        unsubscribePanes(host, keys, cfg).catch(() => {});
      }
    }
  });
});

// Rotate old activity events on startup
try { rotateEvents(); } catch { /* ignore */ }

// --- Cross-host agent lifecycle polling -------------------------------------
// appendEvent() is only reached from the local attach/observe path, so a remote
// agent that starts/finishes/errors while no Warden pane is open on its host
// leaves no trace. This periodic discoverAll() over EVERY configured host feeds
// two snapshots into the pure diffLifecycles() (src/lifecycle.js) to emit
// host-attributed lifecycle events on state TRANSITIONS only — so event volume
// stays negligible against the 7-day rotation regardless of the 60s cadence.
let lifecycleTimer = null;
let prevSnapshot = new Map(); // id → { host, container, role, project, active, ok }
// Re-entrancy guard. A single discoverAll sweep can take longer than the 60s tick
// (slow/unreachable hosts each wait on ConnectTimeout; per-agent SSH on Windows),
// so without this guard ticks overlap and pile up — compounding load into the
// exact global slowdown WARDEN-147 introduced. A tick already in flight makes the
// next interval a no-op rather than stacking a second full-fleet sweep on it.
let lifecycleRunning = false;

const LIFECYCLE_INTERVAL_MS = 60_000;

async function tickLifecycle() {
  if (lifecycleRunning) return;
  lifecycleRunning = true;
  return tickLifecycleBody().finally(() => { lifecycleRunning = false; });
}

async function tickLifecycleBody() {
  // No remote hosts and no catalog → discoverAll has nothing to observe. But
  // FIRST drain any pending transitions in prevSnapshot against an empty fleet.
  // The last agent ending (or the user removing their last configured host) can
  // empty the catalog/hosts while prevSnapshot still tracks it; this guard would
  // otherwise short-circuit BEFORE the diff — permanently suppressing that final
  // agent_ended, or emitting it minutes late with a wrong timestamp once some
  // other agent later reappears (the only thing that would un-freeze the diff).
  // diffLifecycles(prev, ∅) emits agent_ended for every tracked chat, so draining
  // then going dormant captures the real disappearance(s) and frees the snapshot.
  if (!cfg.hosts.length && !loadCatalog().length) {
    if (prevSnapshot.size > 0) {
      for (const event of diffLifecycles(prevSnapshot, new Map())) {
        try { appendEvent(event); } catch { /* ignore single-event write failures */ }
      }
      prevSnapshot = new Map();
    }
    return;
  }
  let chats, errors;
  try {
    // Lean sweep: { activity: false } skips the per-agent activity SSH (remote)
    // and the per-session capture-pane (local). The lifecycle diff needs only
    // alive/dead TRANSITIONS, not timestamps — and those per-agent round-trips
    // (a fresh ssh.exe each on Windows, which has no ControlMaster multiplexing)
    // were the bulk of the unconditional 60s sweep's cost.
    ({ chats, errors } = await discoverAll(cfg.hosts, cfg, { activity: false }));
  } catch {
    return; // transient discovery failure; retry next tick
  }
  const failingHosts = new Set((errors || []).map((e) => e.host));
  const next = buildSnapshot(prevSnapshot, chats, failingHosts);

  // First run: seed the baseline SILENTLY. An empty prevSnapshot would otherwise
  // emit agent_started for every currently-running agent (a one-time burst).
  if (prevSnapshot.size === 0) {
    prevSnapshot = next;
    return;
  }

  for (const event of diffLifecycles(prevSnapshot, next)) {
    try { appendEvent(event); } catch { /* ignore single-event write failures */ }
  }
  prevSnapshot = next;
}

function startLifecyclePoll() {
  if (lifecycleTimer) return;
  lifecycleTimer = setInterval(tickLifecycle, LIFECYCLE_INTERVAL_MS);
  tickLifecycle(); // seed the baseline immediately (fires once, emits nothing)
}

// ---- Token-spend budget slow-cadence accumulator (WARDEN-415) ---------------
//
// The backend owns the budget check on its OWN slow beat (BUDGET_INTERVAL_MS,
// ~120s) — deliberately decoupled from the 2s monitor tick so it never joins the
// per-tick capture cost. Each tick REUSES the existing per-session token totals
// (localClaudeSessions / remoteClaudeSessions — the SAME functions
// /api/claude-sessions-all uses; do NOT re-read transcripts with new logic),
// filters to sessions active in the configured window, sums their lifetime
// totals (semantics documented in budget.js), and caches the pure
// computeBudgetState result. /api/budget returns the cache — instant, no SSH —
// so the frontend's progress surface + debounce check stay cheap. One
// unreachable host degrades to "no spend from it" via Promise.allSettled; it
// never fails the whole sweep.
let budgetState = null;
let budgetTimer = null;
// Re-entrancy guard, same rationale as lifecycleRunning: a sweep over slow hosts
// can exceed the 120s beat, so an in-flight tick makes the next a no-op.
let budgetRunning = false;
// Per-host fetch ceiling. Sessions are mtime-sorted descending and the window is
// recent, so window-active sessions sit at the front; this caps transcript reads
// (local) + the grep+awk SSH pass (remote) on a very active host. 100 is far
// above any realistic 24h session count.
const BUDGET_PER_HOST_LIMIT = 100;

async function tickBudget() {
  // Self-gate: a disabled budget clears its own timer (and cache) so no sweep
  // runs while off. This makes startBudgetPoll safe to call unconditionally at
  // startup — it parks until the human opts in.
  if (!cfg.tokenBudgetEnabled) {
    if (budgetTimer) { clearInterval(budgetTimer); budgetTimer = null; }
    budgetState = null;
    return;
  }
  if (budgetRunning) return;
  budgetRunning = true;
  try {
    const { threshold, perSessionThreshold, windowMs } = resolveBudgetConfig(cfg);
    const hosts = [LOCAL, ...cfg.hosts];
    // Reuse the existing session-usage fetch — single SSH pass per remote host
    // returning the enriched header (cwd/summary + four token ints), identical
    // to /api/claude-sessions-all. We only need mtime + tokenUsage.total +
    // identity, so the same rows feed computeBudgetState directly.
    const results = await Promise.allSettled(hosts.map(async (host) => {
      const sessions = host === LOCAL
        ? localClaudeSessions(BUDGET_PER_HOST_LIMIT)
        : await remoteClaudeSessions(host, BUDGET_PER_HOST_LIMIT);
      return sessions.map((s) => ({ ...s, host }));
    }));
    const sessions = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value);
    budgetState = computeBudgetState(sessions, {
      now: Date.now(),
      windowMs,
      threshold,
      perSessionThreshold,
    });
  } catch {
    // A transient failure leaves the previous cache in place (no blanking) so a
    // blip doesn't flap the progress surface / re-arm the one-shot spuriously.
  } finally {
    budgetRunning = false;
  }
}

function startBudgetPoll() {
  // Always (re)seed the interval; tickBudget self-clears when disabled, so an
  // idle parked timer is harmless and lets a later enable (PUT /api/config) wake
  // it without a second start call.
  if (!budgetTimer) budgetTimer = setInterval(tickBudget, BUDGET_INTERVAL_MS);
  tickBudget(); // seed the cache immediately on enable
}

// React to a config change: enable → ensure the timer runs + recompute now;
// disable → stop + clear the cache so /api/budget reports disabled honestly;
// threshold/window tweak → recompute now so the next read is fresh.
function restartBudgetPoll() {
  if (cfg.tokenBudgetEnabled) {
    if (!budgetTimer) budgetTimer = setInterval(tickBudget, BUDGET_INTERVAL_MS);
    tickBudget();
  } else if (budgetTimer) {
    clearInterval(budgetTimer);
    budgetTimer = null;
    budgetState = null;
  }
}

// Exported for HTTP-level integration tests (see src/server-hosts-status.test.js).
// Not used by the running server — startServer() below drives the module-level
// `server` directly.
// tickLifecycle is exported so src/server-lifecycle.test.js can drive a single
// lifecycle tick deterministically (the running server drives it off a 60s
// setInterval via startLifecyclePoll, which is too slow for a test).
// `server` is exported so stream-lifecycle tests (src/server-stream-reattach.test.js)
// can listen the SAME http server that streamWss's upgrade handler is bound to —
// app.listen() would create a different server with no WS routing.
// tickBudget is exported so src/server-budget.test.js can drive a single budget
// sweep deterministically (the running server drives it off a 120s setInterval
// via startBudgetPoll, which is far too slow for a test). That test exercises
// the integration glue the pure src/budget.test.js suite cannot reach:
// localClaudeSessions → computeBudgetState → this cache → /api/budget, including
// the '(local)' host tag and the window filter over a planted transcript.
export { app, tickLifecycle, tickBudget, server };

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
    // Start cross-host lifecycle polling (captures agent start/stop/error on
    // hosts even when no Warden pane is open on them).
    startLifecyclePoll();
    // Start the token-spend budget accumulator (WARDEN-415). Self-gates: parks
    // until the human opts in via Settings; once enabled, reuses the existing
    // session-usage fetch on a 120s beat and caches the result for /api/budget.
    startBudgetPoll();
    // Start the background pane-delta TTL sweep (WARDEN-413). When the last pane
    // closes the frontend stops polling, so the request-driven reconcile can't age
    // out subscriptions; this decoupled sweep releases them via unsubscribePanes.
    // Self-gates on the companion flag (no-op when off); unref'd so it never keeps
    // the event loop alive.
    startPaneDeltaSweep(cfg);
    // Lazy mode: no startup SSH. Connections open on demand (per-host discover / pane read).
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer(parseInt(process.env.PORT || '7421', 10));
}
