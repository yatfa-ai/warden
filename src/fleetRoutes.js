import express from 'express';
import { getHealthState, groupByHealth, getHealthSummary } from './health.js';
import { pollAgentStates, pollFleetStates } from './agentStatePoll.js';

// Fleet catalogue / health / agent-state routes (/api/chats, /api/discover,
// /api/health, /api/agent-states, /api/agent-states/fleet), extracted verbatim from
// server.js. Injected: the shared `cfg`, the `chatCatalog` cache, and a
// `getBudgetState` thunk (the budget tick is constructed after these routes are
// mounted, so it must be read lazily — passing the value would hit the TDZ).
export function createFleetRouter({ cfg, chatCatalog, getBudgetState }) {
  const router = express.Router();

  // Disk-only catalog list — instant, zero ssh (lazy mode). Live active/status are
  // resolved per host on demand via /api/discover.
  router.get('/api/chats', async (_req, res) => {
    // Refreshes the catalog (disk) chats in the catalogue but KEEPS any lazily-discovered
    // yatfa chats, so already-open remote panes keep streaming across list refreshes.
    // That preservation is the owner's rule now, not this handler's (WARDEN-1206).
    const { chats, errors } = await chatCatalog.refreshCatalog(cfg);
    // WARDEN-1422: temporary (unnamed) shells are cataloged only so panes/kill can
    // resolve them — they are never LISTED. The in-memory cache keeps them (resolve()
    // reads it); this wire filters them out so no sidebar/fleet surface ever lists one.
    res.json({ chats: chats.filter((c) => !c.temporary), errors });
  });

  // Discover ONE host on demand (user clicked it). Returns that host's chats with live
  // active/lastActivity and merges them into the catalogue.
  router.get('/api/discover', async (req, res) => {
    const host = String(req.query.host || '');
    if (!host) return res.status(400).json({ error: 'missing ?host=' });
    try {
      // Concurrent clicks on the same host share ONE discover (the owner's per-host
      // in-flight dedup); each still gets that host's chats back.
      const chats = await chatCatalog.refreshHost(host, cfg);
      // WARDEN-1422: the saved list excludes temporary shells; the UNSAVED shells
      // that ARE running ride beside them as `temporaryChats` so the host view can
      // account for them in its footer line (and its empty state) without ever
      // listing them.
      res.json({
        host,
        chats: chats.filter((c) => !c.temporary),
        temporaryChats: chats.filter((c) => c.temporary),
      });
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
  router.get('/api/health', (_req, res) => {
    try {
      // Catalogue-derived (zero ssh — snapshot() never awaits the network). Under lazy
      // mode only discovered/catalog chats are present; catalog chats report UNKNOWN
      // until their host is clicked.
      // WARDEN-1422: temporary (unnamed) shells are unlisted everywhere — Fleet Health
      // included. The cache keeps them (resolve() needs them); this read drops them.
      const chats = chatCatalog.snapshot().filter((c) => !c.temporary);
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
      const sessionUsage = getBudgetState()?.sessionUsage;
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
  router.get('/api/agent-states', async (req, res) => {
    try {
      const keys = String(req.query.panes || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (keys.length === 0) return res.json({ agents: [], total: 0, timestamp: Date.now() });

      // Resolve pane keys → chats from the catalogue (zero ssh). Match on key OR id
      // so a bare restored tab id resolves the same as a host-qualified key. One
      // snapshot for the whole loop — it is a fresh array each call.
      // WARDEN-1223: a bare key can name a session on MORE THAN ONE host — collect
      // EVERY match (deduped by the host-qualified id) so each host's agent is
      // captured and classified from its own terminal instead of only the first
      // catalogue entry winning.
      const known = chatCatalog.snapshot();
      const seen = new Set();
      const chats = [];
      for (const k of keys) {
        for (const c of known) {
          if (c.key !== k && c.id !== k) continue;
          if (!seen.has(c.id)) { seen.add(c.id); chats.push(c); }
        }
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
  router.get('/api/agent-states/fleet', async (req, res) => {
    try {
      const excludeKeys = String(req.query.exclude || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const agents = await pollFleetStates(chatCatalog.snapshot(), cfg, {}, { excludeKeys });
      res.json({ agents, total: agents.length, timestamp: Date.now() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
