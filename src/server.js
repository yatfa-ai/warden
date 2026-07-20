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
import { buildGetResponse, applyConfigPut, afterSave } from './config-schema.js';
import { applyCompanionToggle } from './companion.js';
import * as collections from './collections.js';
import { capturePanes, resolveChatWithRefresh, catalogChats, discoverHost, discoverAll } from './chats.js';
import { read as readPane, send as sendPane, sendKey, hasSession, resize, spawn as spawnTmux, kill as killTmux, attachStream, probeSession } from './tmux.js';
import { run, runLocalTmux, shellQuote, TMUX_BIN, detectClaude, startConnectionPoolCleanup, validateHost } from './ssh.js';
import {
  parseJsonlHead, snippetFromLine,
  localClaudeSessions, remoteClaudeSessions,
  mergeAndPaginateSessions,
  readLocalSessionTranscript, buildSessionReadScript, parseSessionReadOutput,
} from './claudeSessions.js';
import { classifyProbe } from './sessionRecovery.js';
import { Observer, readDirectives } from './observer.js';
import { hasCredentials, resolveModel } from './llm.js';
import { listSessions, createSession, renameSession, deleteSession } from './sessions.js';
import { appendEvent, rotateEvents, readEvents, getStatsSince, getSeriesSince } from './activity.js';
import { computeBudgetState, shouldFireBudgetAlert, resolveBudgetConfig, BUDGET_INTERVAL_MS } from './budget.js';
import { buildSnapshot, diffLifecycles } from './lifecycle.js';
import { getHealthState, groupByHealth, getHealthSummary } from './health.js';
import { classifyPane, stripAnsi, matchWatchPatterns } from './agentState.js';
import * as notify from './notify.js';
import { checkHost } from './hostStatus.js';
import {
  probeReceiverCapabilities,
} from './telemetry-capabilities.js';
import { isCompanionTransportEnabled, subscribePanes, unsubscribePanes, reconcilePaneSubscriptions, startPaneDeltaSweep } from './companion.js';
import { createGitRouter, runLocalCapture, runInContext, gitCwd } from './gitRoutes.js';
export { runGit, gitCwd, parseInProgressDetail, stripCommitSubject, diffNoIndex, getLocalGitDiff } from './gitRoutes.js';

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

// Fleet sweep — the slow companion of /api/agent-states above (WARDEN-571). Where that
// endpoint classifies ONLY the open ∪ watched panes, this one classifies the REST of the
// fleet: every active chat NOT in the caller's open ∪ watched set, so a HIDDEN agent
// that is stuck-looping / waiting for a keypress / error-spamming surfaces in the
// Attention badge instead of reading HEALTHY forever. The frontend polls this on a
// dedicated ~90s cadence (distinct from the 30s open∪watched poll) and folds the rows
// into the same rollup.
//
// `?exclude=k1,k2` is the caller's CURRENTLY open ∪ watched pane keys, so the sweep does
// not re-classify (or double-count) what the faster poll already owns; the sweep set =
// active chats (the catalog cache) − (open ∪ watched). Hard cost gate: the sweep
// classifies ONLY via the companion path and NEVER opens an SSH connection to the fleet.
// A steady-state sweep issues ONE batched capturePanesViaCompanion per hidden companion
// HOST per ~90s sweep (the subscription's 30s TTL — tuned for the 30s open-pane poll —
// evicts a hidden pane between sweeps, because the hidden pane is owned only by this 90s
// sweep and no 30s poll refreshes its TTL, so each sweep re-subscribes and re-captures
// once over the persistent channel). That is a single batched companion RPC per host —
// NOT an SSH sweep. Non-companion / LOCAL hosts come back `sweep_skipped` and are never
// probed. Contrast: the 30s /api/agent-states poll keeps its own subscriptions alive
// (cadence == TTL), so it earns zero capturePanes RPCs steady-state; the 90s sweep does
// not, and the cost-gate test pins the real 1/host/sweep steady state. See pollFleetStates.
app.get('/api/agent-states/fleet', async (req, res) => {
  try {
    const excludeKeys = String(req.query.exclude || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const agents = await pollFleetStates(cache, cfg, {}, { excludeKeys });
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
    // WARDEN-540: user-authored output-pattern alerts. Run the matcher over the SAME
    // already-cleaned text classifyPane read (a sibling pure function — zero new SSH
    // capture; rides this poll's existing capturePanes). When a watched chat's output
    // matches an enabled pattern, attach customMatch { pattern, line } — an ADDITIVE
    // signal independent of `state` (an agent can be both erroring AND match a custom
    // pattern). The frontend's watch diff fires a 'custom' ping on the new-match
    // transition; the attention rollup surfaces it as its own row. Null/absent when no
    // pattern matches → identical to today.
    const customMatch = matchWatchPatterns(clean, cfg.watchPatterns);
    return { ...base, state, signal, captureError: false, ...(customMatch ? { customMatch } : {}) };
  });
}

// pollFleetStates is the slow "fleet sweep" classification mode (WARDEN-571). The 30s
// /api/agent-states poll above classifies ONLY the open ∪ watched panes, so an agent the
// human has HIDDEN — or simply never opened/watched on a busy fleet — is NEVER
// classified. Because a stuck-looping, error-spamming, or "press enter"-prompting agent
// is still PRODUCING output, /api/health's inactivity classifier reads it HEALTHY and
// Warden stays silently green. This fills that gap by classifying the REST of the fleet
// — every active chat NOT already in the caller's open ∪ watched set — on a dedicated
// slow cadence (the frontend's ~90s beat), folded into the SAME Attention rollup so a
// hidden agent needing attention surfaces in the badge + fires the opt-in alert.
//
// Hard cost gate — the sweep NEVER opens an SSH connection to the fleet. It classifies
// ONLY via the companion path (the shipped WARDEN-413 read/delta path — NOT the
// rejected WARDEN-279/283 companion write/send-keys paths; those rejections do not bear
// on this). Companion-connected REMOTE hosts reuse pollAgentStates' reconcile → capture
// → classify: a steady-state sweep issues ONE batched capturePanesViaCompanion per hidden
// HOST per ~90s sweep. The subscription's 30s TTL (tuned for the 30s open-pane poll — see
// AGENT_STATE_TTL_MS) evicts a hidden pane between sweeps, because the hidden pane is
// owned ONLY by this 90s sweep and the 30s poll never requests it, so nothing refreshes
// its TTL; each sweep therefore re-subscribes and captures once over the persistent
// channel. That single batched RPC per host is NOT an SSH sweep. (Contrast pollAgentStates
// above: the 30s poll's cadence equals its TTL, so its subscriptions stay live and it
// earns ZERO capturePanes RPCs steady-state; the 90s sweep's cadence is 3× its TTL, so it
// does not — the cost-gate test asserts the real 1/host/sweep steady state, driving the
// production background TTL eviction between iterations.) Hosts WITHOUT the companion
// transport (flag off, or LOCAL) are returned `state: 'sweep_skipped'` and NEVER probed —
// preserving the "no full SSH sweep" invariant at the /api/agent-states header.
// `sweep_skipped` is a NEW state, distinct from `capture_failed` (tried + failed): it is
// the honest "intentionally not probed (cost gate)" signal, the opposite of the silence
// this fixes.
//
// `chats` is the full active fleet (the endpoint passes the catalog `cache`).
// `opts.excludeKeys` is the caller's open ∪ watched pane keys, so the sweep does NOT
// re-classify what the 30s poll already covers (the sweep set = active chats − open ∪
// watched). `deps` is the same test seam pollAgentStates takes, so the WARDEN-413
// cost-gate test is drivable end-to-end. The sweep uses the SAME classifyPane +
// stripAnsi path so classification semantics are identical to the open-pane poll — no
// divergent heuristics. Exported (and deps-injected) for the cost-gate test. (WARDEN-571)
export async function pollFleetStates(chats, cfg = {}, deps = {}, opts = {}) {
  const exclude = new Set((opts.excludeKeys || []));
  const fleet = (Array.isArray(chats) ? chats : []).filter((c) => c && c.key && !exclude.has(c.key));
  // Partition the fleet: companion-eligible (REMOTE + companion transport on) vs the
  // rest. The companion path is the ONLY capture path the sweep is allowed to use, so
  // anything that would require a raw SSH capture (LOCAL tmux, or the companion flag
  // off) is intentionally NOT classified and surfaced as sweep_skipped — never probed.
  const companionEligible = [];
  const skipped = [];
  for (const c of fleet) {
    if (isCompanionTransportEnabled() && c.host !== LOCAL) companionEligible.push(c);
    else skipped.push(c);
  }
  // Reconcile establishes the pane-push subscription → the companion pushes paneDelta
  // events → capturePanes renders from hasFreshPaneDelta cache and SKIPS the RPC. The
  // companion-eligible subset is classified by the EXACT pollAgentStates path, so a
  // hidden agent's classification (stuck / erroring / waiting / blocked / custom) is
  // byte-for-byte what the open-pane poll would have produced.
  const classified = companionEligible.length
    ? await pollAgentStates(companionEligible, cfg, deps)
    : [];
  // sweep_skipped rows are NAMED (so the badge can list "not swept" if it ever wants
  // to) but carry state 'sweep_skipped', which matches none of buildAttentionRollup's
  // four attention buckets — so a sweep_skipped row is NEVER a needs-attention row and
  // never inflates the count or fires an alert. Honors WARDEN-89's "flagged, not
  // dropped" spirit: it is the explicit "didn't look here" state, kept distinct from
  // capture_failed (tried + failed via the companion path).
  const skippedRows = skipped.map((c) => ({
    id: c.container || c.session,
    key: c.key,
    host: c.host,
    project: c.project,
    role: c.role,
    name: c.name || c.key || (c.container || c.session),
    state: 'sweep_skipped',
    sweepSkipped: true,
    signal: null,
  }));
  return [...classified, ...skippedRows];
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
app.get('/api/activity', async (req, res) => {
  const after = req.query.after ? new Date(req.query.after).getTime() : undefined;
  const before = req.query.before ? new Date(req.query.before).getTime() : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  const events = await readEvents({ after, before, limit });
  res.json({ events });
});

app.get('/api/activity/stats', async (req, res) => {
  const after = req.query.after ? new Date(req.query.after).getTime() : Date.now() - (24 * 60 * 60 * 1000); // Default: last 24 hours
  const stats = await getStatsSince(after);
  res.json(stats);
});

// Per-agent activity series for the Fleet Health sparklines (WARDEN-299). Mirrors
// the stats endpoint's default window (last 24h) and adds an hourly bucket grid a
// sparkline can join by `container`. Deliberately a separate endpoint — the
// dashboard fetches it on a slow ~60s cadence, never on the 10s /api/health poll.
app.get('/api/activity/series', async (req, res) => {
  const after = req.query.after ? new Date(req.query.after).getTime() : Date.now() - (24 * 60 * 60 * 1000); // Default: last 24 hours
  const rawBucket = req.query.bucket ? parseInt(String(req.query.bucket), 10) : 3_600_000; // default 1h
  const bucket = Number.isFinite(rawBucket) && rawBucket > 0 ? rawBucket : 3_600_000;
  res.json(await getSeriesSince(after, { bucketMs: bucket }));
});

app.get('/api/ssh-hosts', (_req, res) => res.json({ hosts: allSshHosts(), configured: cfg.hosts }));

// Directive history — reads the append-only directives.md back as structured
// records (the inverse of observer.js logDirective). Mirrors /api/activity's
// graceful-empty contract: a missing/empty file yields { directives: [] } and
// never a 500. `agent`/`limit` are optional filters (agent = container, the
// same field ActivityTimeline's agent filter uses). Newest-first.
app.get('/api/directives', async (req, res) => {
  try {
    const agent = req.query.agent ? String(req.query.agent) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const directives = await readDirectives({ agent, limit });
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

// GET /api/config — return the safe-subset response, derived from the single
// CONFIG_FIELDS registry (WARDEN-773). buildGetResponse iterates the registry:
// public fields emit by their resolve rule, secret fields auto-emit {key}Set +
// {key}Tail only (cleartext never on the wire), and the derived
// companionTransportOverridden emits from the boot env snapshot. The key order
// is byte-pinned to the pre-refactor response (server-config-registry.test.js).
app.get('/api/config', (_req, res) => res.json(
  buildGetResponse(cfg, { companionEnvOverridden }),
));

// PUT /api/config — update configuration and persist. Derived from the single
// CONFIG_FIELDS registry (WARDEN-773): applyConfigPut iterates the registry's
// per-field guards (type checks, the [1,60] connectTimeout clamp, oneOf, the
// tokenBudget null-asymmetry + Math.max(1) floor, sanitizeWatchPatterns, secret
// no-clobber, and the nested llm sub-fields), then runs the two cross-field
// invariants (health warning<=critical ordering + telemetry extended-requires-
// base). The four post-save side-effects run through afterSave (Correction 2):
// the IPC telemetry forward incl. cleartext authToken (WARDEN-524/569), the live
// companion toggle (WARDEN-439), and the budget/attention poll restarts
// (WARDEN-415/555) — declared as a pipeline so a refactor can't silently drop
// them the way the source proposal's hooks would have.
app.put('/api/config', (req, res) => {
  applyConfigPut(cfg, req.body);
  save(cfg); // persist to ~/.yatfa-warden/config.json
  afterSave(cfg, {
    companionOverridden: companionEnvOverridden,
    forwardTelemetryConfig,
    applyCompanionToggle,
    restartBudgetPoll,
    restartAttentionPoll,
  });
  res.json({ ok: true });
});

// Forward the (now-clamped) telemetry prefs to the Electron main process over
// the fork's IPC channel so a consent/endpoint flip takes effect on the next
// signal without an app restart — the source + pipeline live in MAIN, but the
// PUT is serviced here in the server child. Guarded: process.send exists only
// when the server is forked by electron/main.cjs (standalone `node src/server`
// has no parent). WARDEN-524. Pulled out of the PUT handler so afterSave can
// name it as an injected dep, keeping config-schema.js dependency-free.
function forwardTelemetryConfig(cfg) {
  if (typeof process.send !== 'function') return;
  process.send({
    type: 'telemetry-config',
    base: cfg.telemetryBaseEnabled === true,
    extended: cfg.telemetryExtendedEnabled === true,
    endpoint: typeof cfg.telemetryEndpoint === 'string' ? cfg.telemetryEndpoint : '',
    // Forward the cleartext auth token. This is the parent↔child IPC channel
    // (main process ↔ server child, both in-app on the same host) — NOT the
    // renderer. The main-process transport needs the cleartext to send it on
    // the wire; GET /api/config masks it from the renderer, but this internal
    // forward is the one path the token reaches the sender through. WARDEN-569.
    authToken: typeof cfg.telemetryAuthToken === 'string' ? cfg.telemetryAuthToken : '',
  });
}

// POST /api/webhook-test — send a test alert so the user can verify their
// ntfy/Discord/Slack/Telegram topic end-to-end from Settings (WARDEN-555). This
// is an EXPLICIT human action. The draft { webhookUrl, webhookSecret? } comes
// from the BODY (not persisted config) so a user fixing a typo in their URL can
// verify the NEW destination before committing it via Save — parity with
// /api/telemetry-test right below. Any field not supplied in the body falls back
// to the persisted cfg (write-only-secret parity: a draft secret is sent only
// when the human typed a new one; an untouched field reuses the saved secret).
//
// The off-by-default invariant ("enabled off → zero outbound requests") still
// holds for every AUTOMATIC dispatch path — the budget/attention/finished hooks
// all dispatch via persisted cfg directly and are untouched here. This route is
// the ONE sanctioned explicit-send path that bypasses the enable gate: the
// button itself is the human's opt-in to send, exactly like /api/telemetry-test
// (which has no enable gate at all), so the merged testCfg forces webhookEnabled:
// true and only no-ops when the resolved URL (draft or persisted) is empty.
// Returns the transport result so the UI can report sent/failed/no-config.
app.post('/api/webhook-test', async (req, res) => {
  try {
    // Merge the draft over persisted cfg. A non-empty draft URL/secret overrides;
    // an absent or empty field falls back to the persisted value (no-clobber).
    const testCfg = {
      ...cfg,
      webhookEnabled: true,
      ...(typeof req.body?.webhookUrl === 'string' && req.body.webhookUrl.trim()
        ? { webhookUrl: req.body.webhookUrl.trim() }
        : {}),
      ...(typeof req.body?.webhookSecret === 'string' && req.body.webhookSecret
        ? { webhookSecret: req.body.webhookSecret }
        : {}),
    };
    const result = await notify.dispatchWebhook({
      event: 'test',
      severity: 'info',
      agent: 'Warden',
      reason: 'Test alert from Warden — your webhook is configured correctly.',
      cfg: testCfg,
      now: Date.now(),
    });
    res.json(result);
  } catch (e) {
    // dispatchWebhook never throws (best-effort), but guard anyway so a surprise
    // never 500s the Settings page.
    res.status(500).json({ error: e.message });
  }
});

// POST /api/telemetry-test — probe a configured telemetry receiver so the user
// can confirm it is reachable + schema-matched + authed BEFORE relying on it
// (WARDEN-595). The renderer cannot fetch the receiver directly: the telemetry
// transport runs in the Node main process (no CORS), but the probe button lives
// in the renderer, and a cross-origin renderer fetch would be CORS-blocked (the
// receiver sends no CORS headers). So — exactly like /api/webhook-test above —
// the renderer POSTs { endpoint, token? } and THIS backend does the outbound
// GET /capabilities in Node (no CORS), returning a structured verdict the UI
// renders (connected / schema-drift / auth-required / no-receiver).
//
// The endpoint comes from the BODY (not persisted config) so the user can test a
// typo'd URL before saving — an improvement over /api/webhook-test. The optional
// token likewise comes from the body when the user typed a new one; when it is
// absent, the route falls back to the persisted cfg.telemetryAuthToken so a
// previously-saved token is used for the probe without the user retyping it (the
// token is write-only on GET /api/config, so the renderer never holds its
// cleartext). The verdict is NEVER persisted: a cached "connected" would go stale
// (receiver down, token rotated) and become a false trust signal, so it stays a
// live, on-demand probe. Only the configured origin is ever contacted — no
// third-party SaaS, no hardcoded host.
app.post('/api/telemetry-test', async (req, res) => {
  try {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }
    // A draft token from the body takes precedence; otherwise probeReceiverCapabilities
    // falls back to the persisted cfg.telemetryAuthToken so a saved secret works
    // without retyping (the token is write-only on GET /api/config).
    const verdict = await probeReceiverCapabilities({
      endpoint,
      token: typeof req.body?.token === 'string' ? req.body.token : '',
      fallbackToken: typeof cfg.telemetryAuthToken === 'string' ? cfg.telemetryAuthToken : '',
      fetchImpl: fetch,
    });
    return res.json(verdict);
  } catch (e) {
    // The probe itself never throws (errors map to verdicts), but guard anyway so
    // a surprise never 500s the Settings page.
    res.status(500).json({ error: e.message });
  }
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
  const sessions = host === LOCAL ? await localClaudeSessions() : await remoteClaudeSessions(host);
  const claudeAvailable = !!(await detectClaude(host));
  res.json({ sessions, claudeAvailable });
});

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
    const sessions = host === LOCAL ? await localClaudeSessions(perHost) : await remoteClaudeSessions(host, perHost);
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


// ---- git HTTP layer (extracted to src/gitRoutes.js, WARDEN-734) ----
app.use(createGitRouter({ resolve, readWorkingTreeFile, isBinaryFile, isBinaryBlob }));


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

// Map the remote read-script's diagnostics ("ERROR ...") to the canonical
// { status, error } the LOCAL branch of readChatFile produces. ONE shared table
// used by readChatFile's remote branch so a new facet added to buildReadFileScript
// (a new binary extension, a new ERROR reason) lands here once instead of being
// hand-copied into two parallel if-ladders — the per-new-facet drift tax that
// once left readWorkingTreeFile and /api/read-file disagreeing on the binary
// vocabulary ('binary file' vs 'cannot read binary files'). The script emits at
// most ONE "ERROR ..." line then exits, so these out.includes() checks can never
// overlap; order is therefore irrelevant. Returns { status, error }.
function mapReadScriptError(out) {
  if (out.includes('ERROR invalid path')) return { status: 400, error: 'invalid path' };
  if (out.includes('ERROR file not found')) return { status: 404, error: 'file not found' };
  if (out.includes('ERROR path must be within working directory')) return { status: 403, error: 'path must be within working directory' };
  if (out.includes('ERROR path is a directory')) return { status: 400, error: 'path is a directory' };
  if (out.includes('ERROR not a file')) return { status: 400, error: 'not a file' };
  if (out.includes('ERROR file too large')) return { status: 413, error: 'file too large (max 1MB)' };
  if (out.includes('ERROR cannot read binary files')) return { status: 400, error: 'cannot read binary files' };
  return { status: 500, error: 'read failed' };
}

// The ONE shared local-vs-remote read-with-guards orchestration. Used by BOTH
// POST /api/read-file (the FileViewer single-file read) and readWorkingTreeFile
// (the A↔B cross-agent compare), so a future guard added here is paid ONCE
// instead of drifted across two hand-maintained copies (WARDEN-674). Returns a
// canonical discriminated result: { ok: true, content } | { ok: false, status, error }.
//
// LOCAL chats (chat.host === LOCAL): resolveLocalFile → 1MB statSync cap →
// isBinaryFile (by extension) → readFileSync → isBinaryBlob (NUL in content).
// REMOTE/yatfa chats: buildReadFileScript + run(host, script) — the script
// carries the same realpath + cwd-containment + size + binary-extension guards
// inside the bash, emitting "ERROR ..." diagnostics — then an isBinaryBlob pass
// on the returned stdout to catch a binary file whose extension wasn't known.
//
// This is the canonical rule set that reconciles the two former copies: it
// ADOPTS readWorkingTreeFile's isBinaryBlob-on-local check (closing the gap where
// /api/read-file used to serve a binary-blob .txt/.log the compare already
// rejected) and /api/read-file's 'cannot read binary files' vocabulary (so the
// two no longer disagree on the string). Neither spec suite exercises a
// local text-extension file containing NUL bytes (both test binary by EXTENSION,
// caught earlier by isBinaryFile), so adopting the stricter check is a pure
// correctness improvement with zero spec regression.
async function readChatFile(chat, filePath) {
  const cwd = chat.cwd || '.';
  if (chat.host === LOCAL) {
    const resolved = resolveLocalFile(cwd, filePath);
    if (!resolved.ok) return { ok: false, status: resolved.status, error: resolved.error };
    try {
      const stats = fs.statSync(resolved.resolvedPath);
      if (stats.size > 1024 * 1024) return { ok: false, status: 413, error: 'file too large (max 1MB)' };
      if (isBinaryFile(resolved.resolvedPath)) return { ok: false, status: 400, error: 'cannot read binary files' };
      const content = fs.readFileSync(resolved.resolvedPath, 'utf8');
      if (isBinaryBlob(content)) return { ok: false, status: 400, error: 'cannot read binary files' };
      return { ok: true, content };
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: false, status: 404, error: 'file not found' };
      if (e.code === 'EISDIR') return { ok: false, status: 400, error: 'path is a directory' };
      return { ok: false, status: 500, error: 'read failed' };
    }
  }
  // remote/yatfa: buildReadFileScript + run(host, script). The script's
  // diagnostics ("ERROR ...") land on stdout; pool/ssh failures land on stderr —
  // mapReadScriptError inspects both via the shared table.
  const script = buildReadFileScript(cwd, filePath);
  const result = await run(chat.host, script, { timeout: 10000 });
  if (!result.ok) {
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    return { ok: false, ...mapReadScriptError(out) };
  }
  if (isBinaryBlob(result.stdout)) return { ok: false, status: 400, error: 'cannot read binary files' };
  return { ok: true, content: result.stdout };
}

// Read one agent's CURRENT working-tree file CONTENT (NOT a diff vs HEAD) for the
// A↔B cross-agent compare (WARDEN-593). A thin fold over readChatFile (the shared
// read-with-guards orchestration also used by /api/read-file) so the two paths
// resolve identically — no per-new-facet drift, no split binary vocabulary.
// Returns { content } on success or { error } on any read failure — never throws
// (the /api/cross-agent-diff route folds .error into its never-500
// { diff, error } response, prefixing the failing side A/B). A deleted/missing
// path (status 'D') fails here and surfaces as 'file not found'.
async function readWorkingTreeFile(chat, filePath) {
  const r = await readChatFile(chat, filePath);
  return r.ok ? { content: r.content } : { error: r.error };
}

// POST /api/read-file — read a file from a chat's working directory.
// Body: { id: string, path: string }
// Response: { content: string, path: string, error?: string }
app.post('/api/read-file', async (req, res) => {
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

async function tickLifecycle(deps = {}) {
  if (lifecycleRunning) return;
  lifecycleRunning = true;
  return tickLifecycleBody(deps).finally(() => { lifecycleRunning = false; });
}

// WARDEN-575: append a lifecycle event to the activity log AND, when it is a genuine
// agent_ended (container gone, host reachable — already SSH-noise-cleaned by
// buildSnapshot's carry-forward), bridge it to the POSITIVE done webhook so a human
// away from the machine learns an agent FINISHED, not only that it broke. The
// done-routing gate (webhookAlertDone) is checked here so the lifecycle sweep adds
// ZERO webhook cost when the positive routing is off; the channel gate inside
// dispatchWebhook is the second line of defense. Fire-and-forget + .catch so a slow
// receiver never blocks the lifecycle sweep. Sibling of tickAttention's done
// dispatch — same event id ('done') and non-alarming 'info' severity, so the
// active→idle ("Finished a task", doneReason) and container-ended ("Agent finished
// (container ended)", doneEndedIdentity) pings share a positive tone on the phone.
//
// Intentional TWO-signal design (WARDEN-575 review): the active→idle ping (tickAttention)
// means "the agent stopped working — finished a task"; THIS agent_ended ping means "the
// container was genuinely recycled." They fire at DIFFERENT times with DIFFERENT wording
// and convey distinct events. The common yatfa sequence — agent finishes (active→idle),
// then its container is torn down (agent_ended) — can therefore produce two positive
// pings for one task. That is intentional, not a bug to dedup away: the two pings are
// separable in time (active→idle when work stops; agent_ended later, on recycle) and the
// container-ended ping is a distinct, SSH-cleaned confirmation worth surfacing on its
// own. Suppressing one would lose that signal; the per-event wording lets the human tell
// them apart. (The two sweeps also key agents differently — t.name||t.key here vs
// container||id — so a cross-sweep dedup would add shared state + key normalization for
// a marginal noise win; documented-intentional is the lower-risk call.)
//
// `deps` (test seam, defaults to {} in production) threads fetchImpl/sleepImpl to
// the webhook transport — mirroring tickBudget/tickAttention so the bridge is
// testable with ZERO real network. Production callers (the timer, startLifecyclePoll)
// pass nothing → dispatchWebhook falls through to globalThis.fetch.
function appendLifecycleEvent(event, deps = {}) {
  try { appendEvent(event); } catch { /* ignore single-event write failures */ }
  if (event && event.type === 'agent_ended' && cfg.webhookAlertDone) {
    const { agent, reason } = notify.doneEndedIdentity(event);
    notify.dispatchWebhook({
      event: 'done',
      severity: notify.doneSeverity(),
      agent,
      reason,
      cfg,
      now: Date.now(),
      fetchImpl: deps.fetchImpl,
      sleepImpl: deps.sleepImpl,
    }).catch(() => {});
  }
}

async function tickLifecycleBody(deps = {}) {
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
        appendLifecycleEvent(event, deps);
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
    appendLifecycleEvent(event, deps);
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
// Previous-sweep snapshot for the budget-breach webhook debounce (WARDEN-555).
// Kept SERVER-SIDE (the frontend has its OWN prev in useTokenBudget) so the
// webhook fires on the !alerted → alerted transition even with the Warden
// window closed to tray. Baseline-primed: null on the first tick → no fire.
let prevBudgetState = null;
let budgetTimer = null;
// Re-entrancy guard, same rationale as lifecycleRunning: a sweep over slow hosts
// can exceed the 120s beat, so an in-flight tick makes the next a no-op.
let budgetRunning = false;
// Per-host fetch ceiling. Sessions are mtime-sorted descending and the window is
// recent, so window-active sessions sit at the front; this caps transcript reads
// (local) + the grep+awk SSH pass (remote) on a very active host. 100 is far
// above any realistic 24h session count.
const BUDGET_PER_HOST_LIMIT = 100;

// `deps` is a test seam (defaults to {} in production), identical in shape to
// tickAttention's: `fetchImpl`/`sleepImpl` flow through to the webhook transport
// so a test drives the full gate → computeBudgetState → shouldFireBudgetAlert →
// dispatch path with ZERO real network. Production calls pass no args, so
// deps.fetchImpl is undefined and dispatchWebhook falls through to globalThis.fetch
// exactly as before.
async function tickBudget(deps = {}) {
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
        ? await localClaudeSessions(BUDGET_PER_HOST_LIMIT)
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
    // Webhook push for a budget breach (WARDEN-555). Fires ONLY on the transition
    // into an alerted state (the debounced one-shot), server-side, so it reaches
    // the user's phone even with the window closed to tray. shouldFireBudgetAlert
    // is the same pure debounce the frontend uses; this keeps its OWN prev. Fire-
    // and-forget: dispatchWebhook already swallows terminal failure, and we never
    // let a rejection escape the tick (the .catch is belt-and-suspenders). The
    // dispatch is gated on cfg.webhookAlertBudget inside the helper chain; prev is
    // advanced unconditionally so the debounce tracks reality regardless.
    if (cfg.webhookAlertBudget && shouldFireBudgetAlert(prevBudgetState, budgetState)) {
      const offender = budgetState.topOffender;
      notify.dispatchWebhook({
        event: 'budget-breached',
        severity: 'critical',
        agent: offender ? (offender.cwd || offender.id || 'fleet') : 'fleet',
        reason: budgetState.perSessionBreached
          ? `Per-session token budget exceeded: top session at ${offender?.total ?? 0} tokens (${offender?.cwd || offender?.id || 'unknown'}).`
          : `Fleet token budget exceeded: ${budgetState.fleetSpent} tokens spent across active sessions in the last ${Math.round(windowMs / 3_600_000)}h window.`,
        cfg,
        now: Date.now(),
        fetchImpl: deps.fetchImpl,
        sleepImpl: deps.sleepImpl,
      }).catch(() => {});
    }
    prevBudgetState = budgetState;
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

// ---- Server-side attention sweep for webhook push (WARDEN-555) ---------------
//
// The desktop-alert channel detects a newly-needy agent by diffing /api/agent-
// states client-side (desktopAlerts.ts). That only fires while the Warden window
// is live. For a webhook to reach the user's phone with the window CLOSED TO
// TRAY, transition detection must happen SERVER-SIDE. This is that server-side
// sweep: on its own slow beat it discovers the fleet, classifies every pane
// (capturePanes + classifyPane — the SAME classify /api/agent-states uses, but
// WITHOUT the companion reconcile, which the dashboard owns for OPEN panes), and
// diffs the per-pane state against the previous sweep, dispatching a webhook on
// each NEW transition into an attention state (stuck/erroring/waiting/blocked).
//
// COST GATE: the sweep self-clears its timer unless the webhook channel is
// enabled, a URL is configured, AND attention routing is on — so it adds ZERO
// per-host pane-capture cost for users who never enable webhooks. The 60s beat
// is between the 2s live monitor (per-WS, window-open only) and the 120s budget
// accumulator, and well inside the ticket's "within one sweep (~120s)" bar.
const ATTENTION_SWEEP_MS = 60_000;
let prevAttentionStates = new Map(); // key → state (the diff baseline)
let attentionTimer = null;
// Re-entrancy guard, same rationale as lifecycleRunning/budgetRunning.
let attentionRunning = false;

// tickAttention — one server-side attention sweep. Exported so a test can drive
// a single sweep deterministically (the running server drives it off a 60s
// setInterval via startAttentionPoll, which is too slow for a test). Self-gates
// to idle when the channel is off; baseline-primes on the first sweep (empty
// prevAttentionStates → no fire). Transient capture failures leave the baseline
// in place and retry next sweep (no spurious fire / no flap).
//
// `deps` is a test seam (defaults to {} in production): `chats` overrides the
// pane source (otherwise discovered fresh via discoverAll so the sweep is
// window-independent — NOT the client-refreshed `cache`), `pollAgentStates`
// overrides the capture+classify path, and `fetchImpl`/`sleepImpl` flow through
// to the webhook transport — so a test drives the full gate → diff → dispatch
// path with ZERO real pane capture and ZERO real network.
async function tickAttention(deps = {}) {
  // WARDEN-575: the sweep now serves TWO independent routings — the problem-side
  // attention diff (webhookAlertAttention) AND the positive done diff
  // (webhookAlertDone). It runs while the channel is on AND at least one routing is
  // enabled, so a human can opt into "tell me when an agent finishes" even with the
  // problem pings off (and vice versa). Each routing is gated separately inside, so
  // neither dispatches when its own flag is off. The channel gate (webhookEnabled +
  // webhookUrl) is unchanged: off / unconfigured → no sweep, zero capture cost.
  if (!cfg.webhookEnabled || !cfg.webhookUrl) {
    if (attentionTimer) { clearInterval(attentionTimer); attentionTimer = null; }
    return;
  }
  if (!cfg.webhookAlertAttention && !cfg.webhookAlertDone) {
    if (attentionTimer) { clearInterval(attentionTimer); attentionTimer = null; }
    return;
  }
  if (attentionRunning) return;
  attentionRunning = true;
  try {
    // Discover the fleet SERVER-SIDE so the sweep is self-sufficient: it does
    // NOT rely on the `cache` (which is refreshed by client /api/chats +
    // /api/discover calls and so can go stale with the window closed to tray).
    // discoverAll over [LOCAL, ...cfg.hosts] covers local docker yatfa + local/
    // remote manual tmux + remote docker — the same lean pass the lifecycle tick
    // uses. Tests inject deps.chats to skip the SSH discovery entirely.
    let chats = deps.chats;
    if (chats === undefined) {
      try {
        ({ chats = [] } = await discoverAll([LOCAL, ...cfg.hosts], cfg, { activity: false }));
      } catch {
        return; // transient discovery failure; retry next sweep
      }
    }
    if (!chats || chats.length === 0) return;
    // Classify WITHOUT reconcilePaneSubscriptions: the dashboard's /api/agent-
    // states reconciles the companion subscription to the OPEN panes, and this
    // sweep classifies the WHOLE fleet — sharing the reconcile would make the two
    // fight over the subscription set. capturePanes alone is fine (it falls back
    // to the per-host SSH capture when a companion push subscription isn't live).
    // Mirrors pollAgentStates' capture+classify, minus the reconcile. Tests inject
    // deps.pollAgentStates to short-circuit the whole classify step.
    const classify = deps.pollAgentStates || (async (chatList) => {
      const panes = await capturePanes(chatList, cfg);
      return chatList.map((c) => {
        const base = {
          id: c.container || c.session,
          key: c.key,
          host: c.host,
          project: c.project,
          role: c.role,
          name: c.name || c.key || (c.container || c.session),
        };
        if (!Object.prototype.hasOwnProperty.call(panes, c.key)) {
          return { ...base, state: 'capture_failed', signal: null };
        }
        const { state, signal } = classifyPane(stripAnsi(panes[c.key] || ''), c);
        return { ...base, state, signal };
      });
    });
    const agents = await classify(chats);
    // WARDEN-575: the done diff shares the SAME classified `agents` + the SAME
    // prevAttentionStates baseline as the problem diff — zero extra capture cost
    // (both are pure diffs over one classify pass). Computed before the baseline
    // advances so it sees the working→idle transition against the prior sweep.
    const doneTransitions = cfg.webhookAlertDone
      ? notify.diffDoneTransitions(prevAttentionStates, agents)
      : [];
    const transitions = cfg.webhookAlertAttention
      ? notify.diffAttentionTransitions(prevAttentionStates, agents)
      : [];
    for (const t of transitions) {
      // Fire-and-forget: dispatchWebhook swallows terminal failure; the .catch
      // guarantees a slow/unreachable destination never escapes the sweep.
      notify.dispatchWebhook({
        event: `attention-${t.state}`,
        severity: notify.attentionSeverity(t.state),
        agent: t.name || t.key,
        reason: notify.attentionReason(t.state, t.signal),
        cfg,
        now: Date.now(),
        fetchImpl: deps.fetchImpl,
        sleepImpl: deps.sleepImpl,
      }).catch(() => {});
    }
    // WARDEN-575: dispatch the POSITIVE "finished" transitions with a non-alarming
    // 'info' severity + a positive reason (distinct from the red/amber problem
    // tones). Same fire-and-forget contract; the webhookAlertDone gate above already
    // held the diff to zero when the routing is off.
    for (const t of doneTransitions) {
      notify.dispatchWebhook({
        event: 'done',
        severity: notify.doneSeverity(),
        agent: t.name || t.key,
        reason: notify.doneReason(t.signal),
        cfg,
        now: Date.now(),
        fetchImpl: deps.fetchImpl,
        sleepImpl: deps.sleepImpl,
      }).catch(() => {});
    }
    // Advance the baseline over EVERY classified row (including the non-attention
    // ones) so recovery re-arms the one-shot and capture_failed rows don't get
    // stuck firing on every sweep once capture recovers.
    prevAttentionStates = new Map(
      agents.filter((a) => a && typeof a.state === 'string').map((a) => [a.key, a.state]),
    );
  } catch {
    // A transient capture failure leaves the previous baseline in place (no
    // blanking) so a blip doesn't flap the sweep or re-prime spuriously.
  } finally {
    attentionRunning = false;
  }
}

function startAttentionPoll() {
  // Self-gates via tickAttention's first line, so a parked idle timer is harmless
  // and a later enable (PUT /api/config → restartAttentionPoll) wakes it without a
  // second start call.
  if (!attentionTimer) attentionTimer = setInterval(tickAttention, ATTENTION_SWEEP_MS);
  tickAttention();
}

// React to a config change: enable → ensure the timer runs + sweep now; disable
// → stop + reset the baseline so the next enable gets a clean prime (no stale
// state from a previous run). Mirrors restartBudgetPoll's shape.
function restartAttentionPoll() {
  // WARDEN-575: run while the channel is on AND at least one routing (attention OR
  // done) is enabled — mirrors tickAttention's gate so a Settings flip of either
  // routing takes effect on the next sweep.
  if (cfg.webhookEnabled && cfg.webhookUrl && (cfg.webhookAlertAttention || cfg.webhookAlertDone)) {
    if (!attentionTimer) attentionTimer = setInterval(tickAttention, ATTENTION_SWEEP_MS);
    prevAttentionStates = new Map(); // clean baseline prime on (re)enable
    tickAttention();
  } else if (attentionTimer) {
    clearInterval(attentionTimer);
    attentionTimer = null;
    prevAttentionStates = new Map();
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
export { app, tickLifecycle, tickBudget, tickAttention, server };

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
    // Start the server-side attention sweep for webhook push (WARDEN-555).
    // Self-gates: parks (zero pane-capture cost) until the user enables a
    // webhook URL + attention routing; once enabled, classifies every known pane
    // on a 60s beat and dispatches a webhook on each new attention transition.
    startAttentionPoll();
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
