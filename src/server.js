// warden web dashboard server. tmux is required everywhere — every chat is a tmux
// session (yatfa: in a docker container; manual: a host/local tmux session). The
// transport (ssh.js runTmux/attachTmux) routes each op to the remote host over SSH
// or to this machine locally. No more direct-PTY path.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import { read as readPane, send as sendPane, sendKey, hasSession, spawn as spawnTmux, kill as killTmux } from './tmux.js';
// NOTE: `saveCatalog` is deliberately NOT imported here. Every catalog write in
// this file goes through `mutateCatalog`, which owns the read-modify-write critical
// section (WARDEN-991); the two remaining `loadCatalog` calls are read-only. Keeping
// saveCatalog out of scope makes that invariant structural rather than a convention.
import { load, save, loadCatalog, mutateCatalog, allSshHosts, sameCatalogEntry } from './config.js';
import { buildGetResponse, applyConfigPut, afterSave, resetConfig } from './config-schema.js';
// WARDEN-1116 — THE telemetry consent authority (pure, dependency-free CJS shared
// by the server and the Electron main process; see src/telemetry-consent.cjs).
import { resolveConsent } from './telemetry-consent.cjs';
// WARDEN-1258 — usage-telemetry producer for the linkifier's existence probe
// (the operational-metrics consent category; see src/fileExistsTelemetry.js).
import { createFileExistsTelemetry } from './fileExistsTelemetry.js';
import { createProcessMemoryProducer } from './telemetry-process-memory.cjs';
import { createServerStallTelemetry, routeSegmentsOf } from './serverStallTelemetry.js';
import { createPaneInputTelemetry } from './paneInputTelemetry.js';
import { createRequestTelemetry } from './requestTelemetry.js';
import { createSshTelemetry } from './sshTelemetry.js';
import { createCompanionRpcTelemetry } from './companionRpcTelemetry.js';
import { createWorkspaceNamesTelemetry } from './workspaceNamesTelemetry.js';
import { applyCompanionToggle, applyCompanionExclusions } from './companion.js';
import * as collections from './collections.js';
// NOTE: `catalogChats` and `discoverHost` are deliberately NOT imported here.
// Every in-memory catalogue read/write in this file goes through `chatCatalog`,
// which owns the per-host slots, the freshness stamps, the in-flight dedup and
// the lastActivity carry-forward (WARDEN-1206). Those two functions are the
// owner's injected dependencies (src/chatCatalog.js). Keeping them out of scope
// makes that single-owner invariant structural rather than a convention — the
// same trick the `saveCatalog` note above plays for the disk catalogue.
import { capturePanes, resolveChatWithRefresh, discoverAll } from './chats.js';
// WARDEN-1405 — the manual-pane container resolver (proven on pasted-image
// delivery, WARDEN-1377) plus its container→project half. Additive imports:
// this file imported neither module before this slice.
import { resolvePaneContainer, projectFromContainerResolution } from './paneContainer.js';
// `run` is no longer imported: WARDEN-1284 routed the last four direct `run()`
// call sites in this file (the file viewer read, the linkifier existence probe,
// the session search + transcript reads, the tmux preflight) through
// `deliverRemoteScript`, which owns the run()-vs-companion choice. Every
// remaining remote script in this file goes through that guard or through
// runInContext.
import { runLocalTmux, splitCmd, TMUX_BIN, detectClaude, startConnectionPoolCleanup, validateHost, setSshRunObserver } from './ssh.js';
// The single source of the working-directory containment rule (WARDEN-1234):
// the JS clause for local resolution, and the bash fragment spliced into every
// remote script that guards a path against its cwd.
import {
  // `remoteClaudeSessions` (the frozen bare-array variant) is deliberately NOT
  // imported here any more: since WARDEN-1208 both fleet readers go through
  // `sessionCache`, which fetches the richer detail variant and projects down.
  // Its contract stays frozen and un-widened — it simply has no caller in this
  // file. `remoteClaudeSessionsDetail` is still used directly by the SINGLE-host
  // /api/claude-sessions route, which is a different read (one named host, no
  // fan-out) and explicitly out of this slice's scope.
  localClaudeSessions, remoteClaudeSessionsDetail,
  mergeAndPaginateSessions,
  readLocalSessionTranscript, parseSessionReadOutput,
  // WARDEN-1548: the full-content search helpers + transcript-delivery leg moved here.
  searchLocalClaudeSessions, remoteSearchClaudeSessions, remoteReadSessionTranscript,
  SESSION_SEARCH_PER_HOST, SESSION_SEARCH_GLOBAL,
} from './claudeSessions.js';
// WARDEN-1282 — deliver a pasted clipboard image to where the agent lives
// (ssh + `docker exec -i` stdin, or a direct local write). Image bytes NEVER
// enter the terminal stream; only the marker line this returns does.
import { deliverPastedImage } from './pasteImage.js';
import { readDirectives, rotateDirectives } from './observer.js';
import { resolveModel } from './llm.js';
import { listSessions, createSession, renameSession, deleteSession, isValidSessionId } from './sessions.js';
import { appendEvent, rotateEvents, readEvents, getStatsSince, getSeriesSince, getStateSeriesSince, NON_ACTIVITY_TYPES } from './activity.js';
import { computeBudgetState, shouldFireBudgetAlert, resolveBudgetConfig, BUDGET_INTERVAL_MS } from './budget.js';
import { getHealthState, groupByHealth, getHealthSummary } from './health.js';
import * as notify from './notify.js';
import { createHostStatusCache } from './hostStatus.js';
import { createChatCatalogCache } from './chatCatalog.js';
import { createSessionCache, completeSessionRows } from './sessionCache.js';
import {
  probeReceiverCapabilities,
} from './telemetry-capabilities.js';
import { setInputAckObserver, setCompanionRpcObserver, isCompanionTransportEnabled, unsubscribePanes, startPaneDeltaSweep, getCompanionStatus, uninstallCompanion, recordCompanionUninstall, deliverRemoteScript, pingProbe } from './companion.js';
import { parseSearchOutput, buildSearchScript, searchLocalRaw } from './workspaceSearch.js';
import { createGitRouter, runInContext, gitCwd } from './gitRoutes.js';
import { pollAgentStates, pollFleetStates } from './agentStatePoll.js';
import { createLifecycleTick } from './lifecycleTick.js';
import { isBinaryFile, isBinaryBlob, readWorkingTreeFile, readChatFile, resolveLocalFile, probeRemoteFile } from './chatFiles.js';
// WARDEN-1381 — the WebSocket layer (observe wss + streamWss + the upgrade router).
import { setupWsLayer } from './wsLayer.js';
import { createSweepSupervisor } from './sweepSupervisor.js';
import { loopMonitor, instrumentSyncIo, formatStallLine } from './loop-monitor.js';
// WARDEN-1406 — the SAME pure suspend-window tracker electron/main.cjs uses,
// imported across the directory line deliberately: the module is dependency-free
// by contract (no Electron import, no fs — see its header), so it is safe to
// load in the server child, and reusing it is what keeps the boundary semantics
// (resume-instant counts, suspend-instant doesn't, open window counts) in ONE
// spec'd implementation instead of a drift-prone fork-side copy.
import { createSuspendClock } from '../electron/suspend-clock.cjs';
import { appendStall, readStalls, pruneStallLog, stallLogFile } from './stall-log.js';
export { runGit, gitCwd, parseInProgressDetail, stripCommitSubject, diffNoIndex, getLocalGitDiff } from './gitRoutes.js';
export { parseSearchLine, parseSearchOutput, buildSearchScript, streamBoundedSearch, searchLocalRaw } from './workspaceSearch.js';
// WARDEN-1548: the Claude-session search + transcript-delivery helpers live in claudeSessions.js;
// re-exported so every `server.X` consumer is untouched.
export { searchLocalClaudeSessions, remoteSearchClaudeSessions, buildSessionSearchScript, remoteReadSessionTranscript } from './claudeSessions.js';
// WARDEN-1567: the chat-file read + existence-probe helpers live in chatFiles.js; re-exported so every `server.X` consumer is untouched.
export { isBinaryFile, isBinaryBlob, buildReadFileScript, buildFileExistsScript, expandChatFilePath, resolveLocalFile, readChatFile, remoteFileExists, probeRemoteFile, REMOTE_FILE_EXISTS_TIMEOUT_MS } from './chatFiles.js';

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
// WARDEN-1390: same boot-apply contract as the toggle above, for the per-host
// exclusion list — serializes cfg.companionExcludedHosts into
// WARDEN_COMPANION_EXCLUDED_HOSTS so every routing predicate (and the
// /api/hosts/status reason) reads it without a restart-coupled cache.
applyCompanionExclusions(cfg.companionExcludedHosts);

const app = express();

// WARDEN-977 — label every request for the event-loop stall monitor. This is the
// ATTRIBUTION half of the server's stall instrumentation: when the heartbeat in
// src/loop-monitor.js sees the loop blocked for seconds, the spans open across
// that window name the work that held it. Deliberately the FIRST middleware, so
// static assets and unmatched paths are labeled too.
//
// Cost per request: one small object, one monotonic clock read, one 'close'
// listener. No I/O and nothing synchronous is added to the request path — the
// monitor exists precisely because synchronous work on this path is the suspect.
// (`end` is idempotent, and node emits 'close' on a finished response AND on an
// aborted one, so a span always closes.)
app.use((req, res, next) => {
  // WARDEN-1292 — one wall-clock timestamp at span-open: the request-telemetry
  // fold below measures close − startedAt from the SAME instant the
  // loop-monitor span opens, so the two instruments stay comparable.
  const startedAt = Date.now();
  const span = loopMonitor.begin(`${req.method} ${requestLabelPath(req.path)}`);
  res.on('close', () => {
    loopMonitor.end(span);
    // WARDEN-1292 — fold every /api request's duration + ok/fail verdict into
    // the operational-metrics aggregate, keyed by the ROUTE PATTERN:
    // req.route.path is the route table's own code literal by construction
    // (undefined on un-routed requests, which fold to the producer's
    // `unmatched` sink), and req.path carries no query string. Scoped to
    // /api/ — static assets are out of this slice's territory. try/catch
    // mirrors the stall-sink discipline below (:399): an exception in an
    // event listener would be uncaught, and telemetry must never be able to
    // take out the close path. `requestTelemetry` is declared further down —
    // safe by the same lazy-reference pattern as wireStallSink: no request is
    // served before module evaluation completes.
    if (req.path.startsWith('/api/')) {
      try {
        requestTelemetry.recordRequest(req.method, req.route?.path, Date.now() - startedAt, res.statusCode < 500);
      } catch { /* never the close path's problem */ }
    }
  });
  next();
});
app.use(express.json({ limit: '1mb' }));

// Curated label for a request path: warden's routes are static, but a label must
// never become a channel for arbitrary text (it is written to the stall log and
// printed to stderr), so anything outside a conservative charset is collapsed and
// the whole thing is length-bounded.
function requestLabelPath(p) {
  const raw = typeof p === 'string' && p ? p : '/';
  const safe = raw.replace(/[^A-Za-z0-9/._-]+/g, '*');
  return safe.length > 48 ? safe.slice(0, 48) + '…' : safe;
}

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

// The in-memory chat catalogue. ONE owner (WARDEN-1206): per-host slots carrying
// freshness, per-host in-flight refresh dedup, and the lastActivity carry-forward
// applied STRUCTURALLY on every refresh. This replaced a bare `let cache = []`
// rewritten wholesale at six sites, each of which had to remember to call a
// `retainLastActivity` helper by hand. `snapshot()` is a flat chat array — the
// same shape the old array had — and never awaits the network. See
// src/chatCatalog.js; it is modelled on createHostStatusCache below.
const chatCatalog = createChatCatalogCache();

// The cross-host Claude SESSION list. ONE owner (WARDEN-1208): per-host slots
// carrying `{sessions, at, limit, unreachable}`, plus a per-host in-flight
// promise so concurrent readers JOIN one enumeration instead of stacking two.
//
// This replaced TWO independent full-fleet fan-outs over the SAME rows: the
// `/api/claude-sessions-all` route ran one ON THE REQUEST PATH (so the slowest
// host set the pace for every host), and `tickBudget` ran an identical one every
// 120s — its own comment already noted it reuses "the SAME functions
// /api/claude-sessions-all uses". A user opening the session browser mid-sweep
// paid a second full-fleet SSH sweep for rows the server was already fetching.
//
// Fetches go through `remoteClaudeSessionsDetail` (the `{sessions, unreachable}`
// discriminator) rather than the bare `remoteClaudeSessions`, whose contract is
// FROZEN (WARDEN-1196) — the sweep-facing read projects down to the array, so
// that signature is not widened and the sweep does not start consuming
// `unreachable`. See src/sessionCache.js; it is modelled on createHostStatusCache
// below, exactly as chatCatalog is.
const sessionCache = createSessionCache({
  fetchLocal: (limit) => localClaudeSessions(limit),
  fetchRemote: (host, limit) => remoteClaudeSessionsDetail(host, limit),
  local: LOCAL,
});

// Per-host connectivity cache behind GET /api/hosts/status (WARDEN-915), so that
// request never waits on live SSH. See createHostStatusCache in src/hostStatus.js
// for the model, and the route below for what it replaced.
const hostStatusCache = createHostStatusCache();

async function resolve(id) {
  const result = await resolveChatWithRefresh(id, chatCatalog.snapshot(), async () => {
    // Lazy mode: never do a full fleet discoverAll. Seed the catalogue from disk
    // (instant, zero ssh), then — only if the id carries a known "<host>:..." prefix
    // — discover that one host. Bare container names (restored yatfa tabs) stay
    // unresolved until the user clicks the host. resolveChatWithRefresh re-matches
    // against the refreshed snapshot.
    await chatCatalog.seedIfEmpty(cfg);
    const colon = id.lastIndexOf(':');
    if (colon > 0) {
      const hostHint = id.slice(0, colon);
      if (hostHint === LOCAL || cfg.hosts.includes(hostHint)) {
        await chatCatalog.refreshHost(hostHint, cfg);
      }
    } else {
      // Bare name (e.g. a restored yatfa tab like "yatfa-worker") with no host hint.
      // Locate it across configured hosts so already-open remote panes resolve on app
      // start. Demand-driven + cached: runs at most once per unresolved bare name.
      // The owner dedups per host, so two panes resolving bare names concurrently
      // share ONE fleet sweep instead of each starting their own (WARDEN-1206).
      //
      // WARDEN-1422 QA round 4: ALSO re-read the on-disk catalog here. A
      // just-spawned shell is appended to chats.json the instant /api/spawn
      // returns, and a pane opened before any poll refreshed the host slot
      // resolved a host-less bare-id attach to "no chat matches" (Couldn't
      // attach). This re-read is the only leg that reaches it — a catalog tmux
      // entry is invisible to refreshHost(LOCAL) (single-host discover lists
      // yatfa containers, not catalog entries) and cfg.hosts is usually empty.
      // Cheap local disk read, no ssh; the in-flight owner dedups concurrency.
      await chatCatalog.refreshCatalog(cfg);
      if (cfg.hosts.length) {
        await chatCatalog.refreshHosts(cfg.hosts, cfg);
      }
    }
    return { chats: chatCatalog.snapshot(), errors: [] };
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

// Verify the local transport / remote tmux is available. Returns null or an error
// string. On local Windows the native ConPTY transport needs no install at all
// (WARDEN-922), so `-V` always succeeds there and this is a pass-through.
//
// WARDEN-1284 (companion transport): the REMOTE branch delivers its one-line
// presence probe through `deliverRemoteScript`, so under the
// `companionTransportEnabled` toggle it rides the persistent companion channel
// instead of spawning its own un-pooled ssh per call. This gate fires on EVERY
// spawn/resume of a remote agent — a user-initiated action where a human is
// actively waiting on the handshake. PARITY: the probe string is assembled once
// and delivered byte-for-byte by either transport (no container → the companion
// runs it via `bash -lc`, run()'s exact delivery shape). The LOCAL branch and
// the toggle-off default path are untouched. `deps` is the shared routing test
// seam; exported so the routing is assertable without real ssh.
export async function preflightTmux(host, deps = {}) {
  if (host === LOCAL) {
    // runLocalTmux is async (WARDEN-440) so this `tmux -V` probe never blocks the
    // event loop while serving the spawn/resume request that triggered preflight.
    const r = await runLocalTmux(['-V']);
    return r.ok ? null : 'tmux not found on this machine. Install it (Linux/macOS: tmux).';
  }
  const script = 'command -v tmux >/dev/null 2>&1 && echo OK || echo MISSING';
  const r = await deliverRemoteScript(host, script, { timeout: 8000 }, {}, deps);
  return r.stdout.includes('OK') ? null : `tmux is required on ${host}. install:  ssh ${host} 'sudo apt-get install -y tmux'  (or: brew install tmux)`;
}

// A tmux session id may be [A-Za-z0-9_-] only. `.` is deliberately ABSENT even
// though tmux ACCEPTS it at creation: tmux silently rewrites `.` (and `:`) to
// `_` (WARDEN-1422 QA — `new-session -d -s a.b.c` creates `a_b_c`), so a dotted
// id would name a session warden can never find with `has-session`. Keeping the
// class dot-free means every id we validate is byte-identical to the session
// tmux actually creates.
const NAME_RE = /^[A-Za-z0-9_-]+$/;

// Disk-only catalog list — instant, zero ssh (lazy mode). Live active/status are
// resolved per host on demand via /api/discover.
app.get('/api/chats', async (_req, res) => {
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
app.get('/api/discover', async (req, res) => {
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
app.get('/api/health', (_req, res) => {
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

// ---- Server event-loop stall instrumentation (WARDEN-977) ------------------
//
// The backend is a FORKED CHILD of the Electron main process, and the freeze
// heartbeat that already existed (electron/telemetry-source.cjs) only ever
// watched the main process — so a multi-second block of THIS process emitted
// nothing anywhere, which is why the ~10s Settings hang survived three passes
// (WARDEN-828 / WARDEN-831 / WARDEN-915). This wires the server-side heartbeat
// to its three read channels, all of which are on by default and none of which
// require a rebuild, a debugger or any unrelated opt-in:
//
//   1. ~/.yatfa-warden/stalls.jsonl — the durable record the owner reads.
//   2. one `[warden:stall] …` line on stderr, which the Electron main process
//      already relays to its console as `[server] …`.
//   3. GET /api/diagnostics/stalls — the same file, in a browser.
//
// Telemetry is deliberately NOT the channel for the OWNER's on-demand read: it
// is opt-in and off by default, so it cannot be the surface someone consults
// when the app just froze. WARDEN-1278 adds it as a FOURTH, strictly ADDITIVE
// channel for the MAINTAINER, with consent — the three above are byte-untouched
// (same stderr line, same append, same route response) and run first.
// Wire the stall SINK — the delivery half of startLoopMonitor, split out so a
// test can arm the real callback WITHOUT also starting the heartbeat timer and
// patching the fs / child_process builtins process-wide (see
// __startLoopMonitorForTest at the bottom of this file).
function wireStallSink() {
  loopMonitor.setOnStall((record) => {
    // stderr first (synchronous, always available, survives a failed write), then
    // the durable append. Both are on the stall path only — never on a request.
    console.error(`${formatStallLine(record)} | recorded in ${stallLogFile()}`);
    appendStall(record).catch((e) => {
      console.warn(`[warden:stall] could not append to ${stallLogFile()}: ${e.message}`);
    });
    // WARDEN-1278 — fold into the telemetry window (aggregate, bounded, closed-
    // set culprit keys). Gated LIVE on the `incidents` category and a no-op
    // while it is off; the window is only ever forwarded on the 5-minute flush,
    // never per stall. LAST and WRAPPED, deliberately: the two local channels
    // above must not be able to fail because of a telemetry producer — the
    // ordering IS the guarantee that this slice cannot degrade the owner's read
    // channels, and src/server-stall-telemetry.test.js drives a THROWING
    // producer to prove it.
    try { serverStallTelemetry.recordStall(record); } catch { /* never the server's problem */ }
  });
}

function startLoopMonitor() {
  wireStallSink();
  loopMonitor.start();
  // Time the synchronous fs / child_process members so a stall can be attributed
  // to the actual blocking call, not just to the request or sweep it happened
  // inside. One patch covers every runtime sync site in src/ that calls through
  // the module object (`import fs from 'node:fs'` → `fs.statSync(…)`), which is
  // all of them — session, collection, companion, LLM, git and claude-session
  // reads, including the hand-rolled fd-level windowed reads
  // (openSync/readSync/closeSync) that carry the largest synchronous payloads.
  // This MEASURES the sites WARDEN-831 deliberately left synchronous; it does
  // not convert them (out of scope, and the point is to stop guessing).
  // Calls at/above the monitor's floor (100ms) take a ring slot; ALL calls are
  // aggregated per label, so a stall made of many cheap calls is still visible.
  const requireCjs = createRequire(import.meta.url);
  instrumentSyncIo(loopMonitor, { fs, childProcess: requireCjs('node:child_process') });
  // Age out records older than 7 days, once, off the request path.
  pruneStallLog().catch((e) => console.warn(`[warden:stall] prune failed: ${e.message}`));
}

// ===========================================================================
// WARDEN-1406 — suspension discrimination on the SERVER runtime.
//
// THE ARTIFACT THIS KILLS. The shared monitor's two suspension discriminators
// (`maxCredibleLagMs` + `isSuspendBoundary`, WARDEN-1376) are opt-in, and main
// has armed them since 0.1.70 — this runtime had not, so a machine SLEEP read
// as a server freeze on every channel: the receiver's worst "stall" is a
// 12.1-hour sleep, and all 7 server-stall events are single 43.9 min–12.1 h
// windows with `unattributed` culprits. Main is the only process that SEES
// powerMonitor suspend/resume, so it forwards the authoritative windows over
// the fork IPC channel and this side arms the monitor with them:
//
//   • `telemetry-suspend-replay` — sent ONCE at fork spawn (main.cjs, right
//     after fork()): the retained window history + any in-flight suspend. The
//     fork starts with no memory of suspends that happened before it existed.
//   • `telemetry-suspend-open` / `telemetry-suspend-close` — live, on every
//     powerMonitor suspend/resume. The close carries the closed {from, to}.
//
// CLOCK DOMAINS — LOAD-BEARING. The monitor's lag math ticks MONOTONIC
// performance.now(); suspend windows are WALL (Date.now()) stamps from main.
// The monitor therefore hands the predicate the WALL-CLOCK bounds of the tick
// gap as extra arguments (loop-monitor.js tick()), and the predicate below
// compares wall vs wall. main's own two-argument loop-monitor predicate
// compares monotonic tick values against wall windows — an accidental mix that
// survives only because its magnitude ceiling is domain-independent. That mix
// is NOT copied here. (Per-tick offset mapping would NOT work: the offset
// changes ACROSS the sleep, so mapping the lag window's start with the
// post-wake offset misplaces it by the whole sleep duration and the 12-hour
// artifact would report exactly as before.)
//
// ARM ONLY WHEN FORKED. `typeof process.send === 'function'` is the same guard
// every forward on this channel uses, read in the opposite direction: a
// standalone `node src/server.js` has no parent to send it windows, so it keeps
// today's byte-for-byte behavior — no ceiling, no predicate, no listener. In a
// test runner the guard also reads false, so importing server.js arms nothing.
// ===========================================================================
const MAX_CREDIBLE_LAG_MS = 60000; // mirrors electron/main.cjs — no live process blocks this long

// Module-level so a re-setup replaces the previous listener instead of stacking
// (and so `dispose` can remove exactly what was registered).
let suspendMessageHandler = null;

function setupSuspensionDiscrimination({
  forked = typeof process.send === 'function',
  monitor = loopMonitor,
  clock = createSuspendClock(),
} = {}) {
  if (!forked) return null; // standalone: today's behavior, byte for byte
  if (suspendMessageHandler) process.removeListener('message', suspendMessageHandler);

  suspendMessageHandler = (msg) => {
    // The IPC channel carries several producers' messages; anything that is not
    // one of ours — including a malformed one — is ignored, never thrown on.
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'telemetry-suspend-open') {
      if (typeof msg.at === 'number') clock.onSuspend(msg.at);
    } else if (msg.type === 'telemetry-suspend-close') {
      // onResume, NOT ingestWindow: the close must CLEAR the in-flight open
      // state (an open marker left standing would suppress every later stall
      // forever), and the fork→main channel is ordered, so the matching open
      // marker has already been applied. A close with no open on record is
      // dropped — the tracker's own idempotent resume semantics.
      if (typeof msg.from === 'number' && typeof msg.to === 'number') clock.onResume(msg.to);
    } else if (msg.type === 'telemetry-suspend-replay') {
      const replayed = Array.isArray(msg.windows) ? msg.windows : [];
      for (const w of replayed) clock.ingestWindow(w);
      if (typeof msg.openAt === 'number') clock.onSuspend(msg.openAt);
    }
  };
  // The fork's FIRST 'message' listener — grep confirmed none existed before
  // this slice; main.cjs's listener is on the parent side of the same channel.
  process.on('message', suspendMessageHandler);

  monitor.setSuspendPolicy({
    maxCredibleLagMs: MAX_CREDIBLE_LAG_MS,
    // The monotonic (from, to) pair is ignored on purpose — the wall bounds are
    // the same intervals in the domain the suspend windows live in. A caller
    // that somehow passes no wall bounds (never this monitor's tick) reads as
    // "no windows span" — spansSuspend's own non-numeric contract — which is
    // the monitor's fail-open direction: report the stall.
    isSuspendBoundary: (from, to, wallFrom, wallTo) => clock.spansSuspend(wallFrom, wallTo),
  });

  return {
    clock,
    dispose() {
      if (suspendMessageHandler) {
        process.removeListener('message', suspendMessageHandler);
        suspendMessageHandler = null;
      }
      monitor.setSuspendPolicy({ maxCredibleLagMs: null, isSuspendBoundary: null });
    },
  };
}

// Wire it once at module scope, next to the other IPC-channel wiring: the
// arming is a property of HOW this process was started, not of when the HTTP
// server starts listening.
setupSuspensionDiscrimination();

// Recorded server stalls — the owner-facing read surface for the durable log.
// Reads the FILE (not just the in-process ring) so the evidence survives a
// restart; `session` additionally exposes this process's ring, which is the
// fallback when the home dir is unwritable. Zero SSH, one async file read.
app.get('/api/diagnostics/stalls', async (req, res) => {
  try {
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
    const stalls = await readStalls({ limit });
    res.json({
      logFile: stallLogFile(),
      config: loopMonitor.config,
      stats: loopMonitor.stats(),
      stalls,
      session: loopMonitor.stalls().slice(-limit).reverse(),
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// WARDEN-1385 — pane-input latency, the owner's on-demand read surface: the
// per-PANE round-trip ledger (which pane, how slow, how stale) plus the
// current aggregate window for the two server-side hops (pane-input-write,
// pane-input-roundtrip). This is the local half of the attribution story —
// pane KEYS may appear here because this surface is the owner's, exactly like
// stalls.jsonl + /api/diagnostics/stalls; the TELEMETRY channel still carries
// only the closed-set hop histograms, never a pane key (WARDEN-443).
// Read-only: it snapshots the live window without flushing it, so curling this
// endpoint mid-window never perturbs or splits the telemetry window.
app.get('/api/diagnostics/pane-latency', (req, res) => {
  try {
    res.json({
      recording: paneInputTelemetry.isEnabled(),
      ledger: paneInputTelemetry.ledgerSnapshot(),
      window: paneInputTelemetry.windowSnapshot(),
      pending: paneInputTelemetry.pendingCount(),
      timestamp: Date.now(),
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
app.get('/api/agent-states/fleet', async (req, res) => {
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

// WARDEN-1647: the agent-state poll core lives in agentStatePoll.js; re-exported so every `server.X` consumer is untouched.
export { appendStateEvent, logStateTransition, pollAgentStates, pollFleetStates, __resetLastLoggedStateForTest } from './agentStatePoll.js';

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
app.get('/api/pane-project', async (req, res) => {
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
app.post('/api/paste-image', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
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

app.get('/api/sessions', async (_req, res) => res.json({ sessions: await listSessions() }));
app.post('/api/sessions', async (req, res) => {
  const { name, host, container, project, role, chatKey } = req.body || {};
  res.json(await createSession(name, { host, container, project, role, chatKey }));
});
app.patch('/api/sessions/:id', async (req, res) => {
  if (!isValidSessionId(String(req.params.id))) return res.status(400).json({ error: 'invalid session id' });
  let s;
  try {
    s = await renameSession(String(req.params.id), req.body?.name);
  } catch (e) {
    // Map ONLY the name-validation error to 400; everything else propagates.
    if (e?.message === 'session name is required') return res.status(400).json({ error: 'session name is required' });
    throw e;
  }
  return s ? res.json(s) : res.status(404).json({ error: 'not found' });
});
app.delete('/api/sessions/:id', async (req, res) => {
  if (!isValidSessionId(String(req.params.id))) return res.status(400).json({ error: 'invalid session id' });
  await deleteSession(String(req.params.id));
  res.json({ ok: true });
});

// Activity timeline endpoints
app.get('/api/activity', async (req, res) => {
  const after = req.query.after ? new Date(req.query.after).getTime() : undefined;
  const before = req.query.before ? new Date(req.query.before).getTime() : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  // Exclude non-activity events (state_changed — internal transition marker for
  // the state timeline, WARDEN-788) so the raw feed stays discrete
  // lifecycle/directive/error activity, matching getSeriesSince/getStatsSince.
  // Without this, a state_changed row renders in the Activity Timeline as a
  // header-only "STATE CHANGED" entry with an empty detail line (no icon/color/
  // case in ActivityTimeline.tsx), and the from:null baseline fires for every
  // agent on every warden restart — fleet-wide noise. The transition still flows
  // to /api/activity/series's stateSeries (its dedicated surface).
  //
  // WARDEN-1101: the limit MUST be applied AFTER the exclusion, so it is read
  // here rather than passed into readEvents. readEvents sorts newest-first and
  // slices internally, so `readEvents({ limit })` then `.filter()` subtracts every
  // state_changed in the newest N from the user's requested N instead of skipping
  // over it — and that restart baseline arrives as one newest-first burst of N
  // agents. On a fleet ≥50, "Last 50" rendered "Showing 0 of 0 events" with a full
  // store on disk. Filtering first and slicing after makes N mean "N activity
  // events", which is what the caller asked for.
  const activity = (await readEvents({ after, before }))
    .filter((e) => !NON_ACTIVITY_TYPES.has(e.type));
  // Guard the slice explicitly: `?limit=abc` → parseInt → NaN, and a bare
  // `.slice(0, NaN)` returns [] — trading one blanking bug for another. readEvents'
  // own `if (limit && …)` guard treats NaN/0 as "no limit" and returns the full
  // feed; this preserves that behaviour for every non-positive-integer value.
  const events = Number.isInteger(limit) && limit > 0 ? activity.slice(0, limit) : activity;
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
//
// WARDEN-788: the SAME response now also carries `stateSeries` — the per-bucket
// forward-filled agent-state timeline (sibling to `series`'s volume counts). It
// rides the existing 60s useActivitySeries poll (no new fetch/poll/SSH) so the
// Fleet state timeline panel consumes exactly what the heatmap already fetches.
// `series` (volume) stays activity-only — `state_changed` events are excluded
// from getSeriesSince (and getStatsSince's total) so the heatmap reverts to its
// pre-feature volume-of-activity meaning; stateSeries is an additive sibling
// field computed by getStateSeriesSince, the one reader of those transitions.
// WARDEN-1618: getSeriesSince/getStateSeriesSince allocate one slot per bucket in
// [after, now] synchronously on the single event loop, so an unbounded `bucket`
// (e.g. 1) or a far-past `after` blocked it for seconds (and threw "Map maximum
// size exceeded"). Clamp both: bucket >= 1 min, window <= the 7d store retention.
// Worst case is 7d / 1min = 10,080 buckets.
const SERIES_MIN_BUCKET_MS = 60_000;
const SERIES_MAX_WINDOW_MS = 7 * 24 * 3_600_000;
app.get('/api/activity/series', async (req, res) => {
  // Both series share one axis: derive the bucket grid from a SINGLE `now` so the
  // heatmap's volume columns and the timeline's state columns can never desync by a
  // bucket (the two functions would otherwise each call Date.now() and could straddle
  // a bucket boundary). Spread volume then add the additive stateSeries sibling field.
  const now = Date.now();
  const requestedAfter = req.query.after ? new Date(req.query.after).getTime() : now - (24 * 60 * 60 * 1000); // Default: last 24 hours
  // Math.max(NaN, x) is NaN, so an unparseable `after` still flows through to an
  // empty grid exactly as before; only finite far-past values are clamped.
  const after = Math.max(requestedAfter, now - SERIES_MAX_WINDOW_MS);
  const rawBucket = req.query.bucket ? parseInt(String(req.query.bucket), 10) : 3_600_000; // default 1h
  const bucket = Number.isFinite(rawBucket) && rawBucket > 0 ? Math.max(rawBucket, SERIES_MIN_BUCKET_MS) : 3_600_000;
  const volume = await getSeriesSince(after, { bucketMs: bucket, now });
  const state = await getStateSeriesSince(after, { bucketMs: bucket, now });
  res.json({ ...volume, stateSeries: state.series });
});

app.get('/api/ssh-hosts', async (_req, res) => res.json({ hosts: await allSshHosts(), configured: cfg.hosts }));

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

// WARDEN-1324: the reachability probe for the two POLL/GESTURE paths —
// /api/hosts/health below and the /api/hosts/status snapshot. It rides the
// companion channel ONLY when one is ALREADY live: pingProbe returns null for
// every other case (toggle off, host never engaged / errored / still
// bootstrapping, dead channel, LOCAL) and this falls back to validateHost
// byte-for-byte. A probe must never trigger a bootstrap — the poll is a fixed
// 30s clock, and a bootstrap here would pay the binary-upload cost on hosts the
// operator never gestured at.
//
// ⚠️ DELIBERATELY NOT used by the POST /api/companion/uninstall precheck, which
// keeps the raw-SSH validateHost: uninstallCompanion's first act is to tear down
// the cached channel, so a companion-routed precheck could bootstrap the very
// binary the operator asked to remove (the WARDEN-882 Removability outcome).
// checkHost's injected-function seam (hostStatus.js takes the probe as a
// PARAMETER) is unchanged — this is just a different function handed to it.
async function probeHostReachability(host, cfg) {
  const via = await pingProbe(host, cfg);
  if (via) return via;
  return validateHost(host, cfg);
}

// Host health check endpoint
app.get('/api/hosts/health', async (req, res) => {
  const hosts = Array.isArray(req.query.hosts) ? req.query.hosts : cfg.hosts;
  const healthChecks = await Promise.all(
    hosts.map(async (host) => {
      try {
        const result = await probeHostReachability(host, cfg);
        return { host, ...result };
      } catch (e) {
        return { host, ok: false, error: e.message };
      }
    })
  );
  res.json({ hosts: healthChecks, timestamp: Date.now() });
});

// Host connectivity status endpoint for sidebar indicators.
//
// WARDEN-915: served from a cache-first, background-refreshed per-host store —
// this request NEVER waits on live SSH. It used to Promise.all a live probe of
// [LOCAL, ...cfg.hosts] on the request path, which measured 2.6ms on a zero-host
// config (the agent-sandbox default, hence invisible) but 15.0s on a realistic
// 5-host config with one unreachable host, on EVERY 30s poll — because the
// response could not be produced until the single WORST host finished timing
// out, so four healthy hosts ready in ~300ms were withheld for 15s. See
// createHostStatusCache (and `hostStatusCache`, declared with the other
// module-level state above) for the model.
app.get('/api/hosts/status', async (_req, res) => {
  const hosts = [LOCAL, ...cfg.hosts];
  // WARDEN-878: when the companion transport is enabled, attach each host's
  // companion state (active/bootstrapping/error/inactive) to its result — one
  // per-host status the UI already polls, so no new endpoint or poll cadence.
  // The toggle is read at REQUEST time (isCompanionTransportEnabled) so a flip
  // takes effect on the next poll without a restart; when off, the field is
  // omitted entirely (the transport is opt-in, so there is nothing to surface).
  const companionOn = isCompanionTransportEnabled();
  // WARDEN-1324: the probe handed to the cache is the companion-riding wrapper,
  // NOT validateHost directly — a live channel answers the poll's reachability
  // question with zero ssh spawns; every other case (no channel / toggle off)
  // falls back to validateHost byte-for-byte inside the wrapper. The uninstall
  // precheck deliberately keeps raw validateHost (see probeHostReachability).
  const results = await hostStatusCache.snapshot(hosts, probeHostReachability, cfg);
  // Spread rather than mutate: the snapshot hands back the CACHED objects, and
  // assigning onto them would leave a stale `companion` field attached after the
  // transport is toggled back off (the field must vanish, not linger).
  res.json({
    hosts: companionOn
      ? results.map((r) => ({ ...r, companion: getCompanionStatus(r.host) }))
      : results,
  });
});

// ---- Collections API ----
// GET /api/collections - List all collections
app.get('/api/collections', async (_req, res) => {
  try {
    const allCollections = await collections.loadCollections();
    res.json({ collections: allCollections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/collections - Create new collection
app.post('/api/collections', async (req, res) => {
  try {
    const { name, criteria, metadata } = req.body;
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
app.patch('/api/collections/:id', async (req, res) => {
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
app.delete('/api/collections/:id', async (req, res) => {
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
app.get('/api/collections/:id/agents', async (req, res) => {
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
// companion toggle (WARDEN-439), and the budget poll restart (WARDEN-415) —
// declared as a pipeline so a refactor can't silently drop them the way the
// source proposal's hooks would have.
app.put('/api/config', async (req, res) => {
  // WARDEN-1331 — applyConfigPut now reports WHICH present-but-invalid values it
  // refused, so the route stops answering a bare { ok: true } to a rejected
  // write (the silent-ok is the amplifier that let the out-of-range-persist
  // defect class hide through five one-field repairs). The response stays
  // ADDITIVE: ok is still true whenever the request was processed (good fields
  // in a mixed body still save), and `refused` is {} on the normal path — only
  // the renderer's save flow reads it, to warn instead of silently dropping.
  const { refused } = applyConfigPut(cfg, req.body);
  await save(cfg); // persist to ~/.yatfa-warden/config.json (atomic, async — WARDEN-831)
  afterSave(cfg, {
    companionOverridden: companionEnvOverridden,
    forwardTelemetryConfig,
    applyCompanionToggle,
    applyCompanionExclusions,
    restartBudgetPoll,
  });
  res.json({ ok: true, refused });
});

// POST /api/config/reset — restore EVERY backend preference to its default
// (WARDEN-889). Until this endpoint the danger zone's only reset action touched
// CLIENT-side UI prefs; the consequential backend settings (webhook / telemetry /
// observer / hosts / thresholds / …) had no reset path, so reverting an
// experiment or rotating a compromised setup meant hand-editing config.json —
// and the write-only secrets (webhook / telemetry / observer auth tokens, which
// a GET masks and a user cannot even see) could not be cleared via the UI at all.
//
// resetConfig overwrites every public + secret field with deriveDefaults(),
// bypassing applyConfigPut's per-field guards on purpose: the secret no-clobber
// that protects an untouched password field on a normal Save would otherwise
// REFUSE to blank those tokens — clearing them is the whole point. internal
// fields (pins / agentNotes / sessionTags — user data, not settings) and derived
// fields (boot-computed) are left untouched. crossField then runs so the
// restored state is well-formed exactly as a PUT would leave it.
//
// The persist + live-apply path is IDENTICAL to PUT's: save round-trips through
// config.json (survives a restart) and afterSave re-forwards the telemetry
// config to main, re-applies the companion toggle, and restarts the budget
// poll — so the reset takes effect live on the next tick, not on restart. This is an INSTANT action (not a draft-then-Save); the UI labels it
// so. No request body is consulted.
app.post('/api/config/reset', async (_req, res) => {
  resetConfig(cfg);
  // save is async + atomic (temp + fsync + rename, WARDEN-831) — AWAIT it so the
  // reset's blanked secrets actually land on disk before we respond, mirroring the
  // PUT handler. Responding first would race the rename and leave the old (secret-
  // bearing) config.json observable.
  await save(cfg); // persist the restored defaults to ~/.yatfa-warden/config.json
  afterSave(cfg, {
    companionOverridden: companionEnvOverridden,
    forwardTelemetryConfig,
    applyCompanionToggle,
    applyCompanionExclusions,
    restartBudgetPoll,
  });
  res.json({ ok: true });
});

// Shared by the telemetry producers below: the one IPC egress to the Electron
// main process (no-op when standalone — no parent). `process.send` is read at
// CALL time, never captured, so a test installing it after import still works.
function forwardToParent(type, snapshot) {
  if (typeof process.send !== 'function') return;
  process.send({ type, snapshot });
}
// The operational-metrics consent, resolved LIVE through the one authority
// (cfg is mutated in place by applyConfigPut). The `incidents` and `names`
// producers use different categories and keep their own lambdas.
const operationalMetricsConsent = () => resolveConsent(cfg)['operational-metrics'] === true;

// WARDEN-1258 — the file-exists probe metrics producer. Consent is resolved
// LIVE through the one authority (cfg is mutated in place by applyConfigPut,
// so a Settings flip gates the very next record()), and the windowed snapshot
// is forwarded to the Electron main process over the fork's IPC channel — the
// same channel forwardTelemetryConfig below uses, with the same process.send
// guard for standalone `node src/server` runs (no parent → no forward; the
// module is inert on the wire). Started immediately: the interval is unref'd,
// so importing server.js in a test never hangs on it.
const fileExistsTelemetry = createFileExistsTelemetry({
  consent: operationalMetricsConsent,
  send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
});
fileExistsTelemetry.start();

// WARDEN-1278 — the server-stall telemetry producer. Same three properties as
// the metrics producer above: consent resolved LIVE through the one authority
// (cfg is mutated in place by applyConfigPut, so a Settings flip gates the very
// next record()), the windowed snapshot forwarded to the Electron main process
// over the fork's IPC channel, and the same process.send guard for standalone
// `node src/server` runs.
//
// It rides the EXISTING `incidents` category — a multi-second freeze IS an
// incident, and it is the same category the main process's `performance-stall`
// already travels under. No new category, no new checkbox.
//
// `knownSegments` is derived LIVE from the express router (every static segment
// of the real route table) so the culprit-key mapping cannot drift from the
// routes it maps. Passed as a THUNK because routes are registered across the
// whole module and the table is only complete after the last one; the
// aggregator resolves it on first use and memoizes.
const serverStallTelemetry = createServerStallTelemetry({
  consent: () => resolveConsent(cfg).incidents === true,
  knownSegments: () => routeSegmentsOf(app),
  send: (snapshot) => forwardToParent('telemetry-stalls', snapshot),
});
serverStallTelemetry.start();

// WARDEN-1385 — the pane-input telemetry producer: the two SERVER-side hops of
// a keystroke's journey (write leg + tmux round trip), folded into the same
// operational-metrics channel as the file-exists probes. The RENDERER half of
// the felt path (keystroke→echo e2e, the paint leg, main-thread health) is
// measured in web/src/lib/paneLatency.ts and arrives at main over its own IPC
// bridge — the two histograms are read beside each other to attribute a slow
// echo to input write, tmux round trip, WS delivery or renderer paint.
//
// Same three properties as the two producers above: consent resolved LIVE
// through the one authority, the windowed snapshot forwarded to the Electron
// main process over the fork's IPC channel, and the same process.send guard
// for standalone `node src/server` runs. Started after the WS layer is wired
// (below) so the correlation object exists before the first attach; the
// producer is handed to setupWsLayer, which correlates per pane.
const paneInputTelemetry = createPaneInputTelemetry({
  consent: operationalMetricsConsent,
  send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
});
paneInputTelemetry.start();
// WARDEN-1491: the companion attachInput request→ack leg of the felt path, so a
// tail in pane-input-roundtrip can be attributed to the channel/daemon (this
// histogram) or to tmux/the agent (the other one) from production telemetry.
setInputAckObserver((ms, ok) => paneInputTelemetry.noteInputAck(ms, ok));

// WARDEN-1292 — the request-metrics producer: every /api request's duration +
// ok/fail verdict, folded into the same operational-metrics channel as the
// file-exists probes and the pane-input hops. The fold happens in the FIRST
// middleware above (the loop-monitor span's close handler), keyed by the
// route table's own pattern literal via src/requestTelemetry.js's closed-set
// mapping — a concrete URL is never an input. Same three properties as the
// producers above: consent resolved LIVE through the one authority (cfg is
// mutated in place by applyConfigPut, so a Settings flip gates the very next
// record()), the windowed snapshot forwarded to the Electron main process
// over the fork's IPC channel, and the same process.send guard for standalone
// `node src/server` runs. Started immediately: the interval is unref'd, so
// importing server.js in a test never hangs on it. Declared AFTER the
// middleware that references it — safe because no request is served before
// module evaluation completes (same lazy-reference pattern as wireStallSink).
const requestTelemetry = createRequestTelemetry({
  consent: operationalMetricsConsent,
  send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
});
requestTelemetry.start();

// WARDEN-1578 — the raw-ssh vantage: one `ssh-run` fold per settled ssh.js run()
// (on win32 that IS one full handshake). okCount/failCount = handshake
// completed/failed, NOT the remote command's verdict (see src/sshTelemetry.js).
// Same consent + IPC-forward discipline as the producers above.
const sshTelemetry = createSshTelemetry({
  consent: operationalMetricsConsent,
  send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
});
sshTelemetry.start();
setSshRunObserver((ms, ok) => sshTelemetry.recordRun(ms, ok));

// WARDEN-1598 — the companion-RPC vantage: one fold per settled
// CompanionChannel.call() into a closed per-method table. okCount = the channel
// delivered a verdict (host-side ok:false is a command result and counts ok);
// failCount = transport failure incl. timeout (right-censored). See
// src/companionRpcTelemetry.js.
const companionRpcTelemetry = createCompanionRpcTelemetry({
  consent: operationalMetricsConsent,
  send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
});
companionRpcTelemetry.start();
setCompanionRpcObserver((method, ms, ok) => companionRpcTelemetry.recordRpc(method, ms, ok));

// WARDEN-1508 — the server child's own process-memory producer: samples THIS
// process (RSS + JS heap + uptime) every ~30s into fixed-size accumulators and
// forwards ONE folded window per ~5 minutes over the fork's IPC channel as
// 'telemetry-process-memory' (main builds the `process-memory` event with the
// runtime FIXED to `server`). It rides the existing `operational-metrics`
// category, resolved LIVE through the one authority — while off, no sample is
// taken. Same process.send guard for standalone `node src/server` runs; timers
// are unref'd so importing server.js in a test never hangs on them.
const serverProcessMemory = createProcessMemoryProducer({
  sources: [{
    runtime: 'server',
    read: () => {
      const m = process.memoryUsage();
      return { rssBytes: m.rss, heapUsedBytes: m.heapUsed, ageMs: Math.round(process.uptime() * 1000) };
    },
  }],
  consent: operationalMetricsConsent,
  send: (_runtime, snapshot) => forwardToParent('telemetry-process-memory', snapshot),
});
serverProcessMemory.start();

// WARDEN-1416 — the workspace-names producer: the `names` consent category's
// OWN carrying event, and the slice that closes that category's dead switch.
// Until now the category could only decorate events other producers built, so
// a names-alone consent sent nothing — a checkbox promising a flow that never
// happened. This producer reads the in-memory chat catalog's sidebar names
// (chatCatalog.snapshot() — zero new SSH, zero new polls) once per window,
// keeps ONLY the `.name` strings (every other catalog field is dropped at this
// collection boundary), de-duplicates, caps at NAMES_MAX, and forwards ONE
// bounded snapshot over the fork's IPC channel. Consent is resolved LIVE
// through the one authority and gates ONLY on the names category — identifying
// data stays behind its own conscious opt-in, never folded into a metrics
// category. Same three properties as the producers above: live consent (cfg is
// mutated in place by applyConfigPut), the same process.send guard for
// standalone `node src/server` runs, and an unref'd interval.
const workspaceNamesTelemetry = createWorkspaceNamesTelemetry({
  consent: () => resolveConsent(cfg).names === true,
  catalog: () => chatCatalog.snapshot(),
  send: (snapshot) => forwardToParent('telemetry-names', snapshot),
});
workspaceNamesTelemetry.start();

// Forward the (now-sanitized) telemetry prefs to the Electron main process over
// the fork's IPC channel so a consent/endpoint flip takes effect on the next
// signal without an app restart — the source + pipeline live in MAIN, but the
// PUT is serviced here in the server child. Guarded: process.send exists only
// when the server is forked by electron/main.cjs (standalone `node src/server`
// has no parent). WARDEN-524. Pulled out of the PUT handler so afterSave can
// name it as an injected dep, keeping config-schema.js dependency-free.
//
// WARDEN-1116 — consent travels as a per-CATEGORY map, resolved through the ONE
// consent authority rather than assembled here from named booleans. A new
// category rides this channel with no change to this function, and main maps it
// straight back onto the same registry. Turning a category off therefore halts
// its traffic on the next signal, with no restart.
function forwardTelemetryConfig(cfg) {
  if (typeof process.send !== 'function') return;
  process.send({
    type: 'telemetry-config',
    categories: resolveConsent(cfg),
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
app.put('/api/pins', async (req, res) => {
  const { pins } = req.body;
  if (!Array.isArray(pins)) return res.status(400).json({ error: 'pins must be an array' });
  cfg.pins = pins;
  await save(cfg);
  res.json({ ok: true, pins });
});

// Agent notes — a short, human-authored per-chat annotation (mirrors /api/pins,
// but id→note instead of an id list). Keyed by chat id, so it works for every
// chat including un-renameable yatfa agents (rename is identity-only and 404s
// for yatfa chats). WARDEN-89: validate input, never 500 on bad shapes.
app.get('/api/agent-notes', (_req, res) => res.json({ notes: cfg.agentNotes || {} }));
app.put('/api/agent-notes', async (req, res) => {
  const { id, note } = req.body;
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
app.get('/api/session-tags', (_req, res) => res.json({ sessionTags: cfg.sessionTags || {} }));
app.put('/api/session-tags', async (req, res) => {
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
  await save(cfg);
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
app.get('/api/claude-sessions', async (req, res) => {
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
// unreachable' } (the remote read carries an explicit 15s deadline on either
// transport, so it never hangs) rather than failing.
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


// ---- git HTTP layer (extracted to src/gitRoutes.js, WARDEN-734) ----
app.use(createGitRouter({ resolve, readWorkingTreeFile, isBinaryFile, isBinaryBlob }));


// If cmd invokes bare `claude`, replace it with the full path found on the host —
// claude is often in a .zshrc-only PATH that tmux's shell (bash) can't see, and on
// Windows it is an npm `.cmd` shim that only a full path can launch (WARDEN-922).
async function resolveClaudeCmd(host, cmd) {
  if (!/^claude(\s|$)/.test(cmd)) return { cmd };
  const claudePath = await detectClaude(host);
  if (!claudePath) return { error: `\`claude\` not found on ${host}. Install it or add its dir to PATH (e.g. ~/.local/bin).` };
  // A resolved path containing a space (routine on Windows: C:\Program Files\…)
  // must be quoted, or the argv split downstream would tear it into two args.
  // Unspaced paths — every Unix case — are emitted verbatim as before.
  const quoted = /\s/.test(claudePath) ? `"${claudePath}"` : claudePath;
  return { cmd: cmd.replace(/^claude(\s|$)/, (_m, sp) => `${quoted}${sp}`) };
}

app.post('/api/rename', async (req, res) => {
  const session = String(req.body?.session || '');
  const host = String(req.body?.host || LOCAL).trim() || LOCAL;
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!session || !name) return res.status(400).json({ error: 'session and name required' });
  // Serialized read-modify-write (WARDEN-991). Composite identity: a session name
  // can repeat across hosts, so scope the find to host+session (host defaults to
  // local for callers that don't send it). Returning undefined when the entry is
  // absent skips the write and preserves the 404.
  const updated = await mutateCatalog((catalog) => {
    const entry = catalog.find((c) => sameCatalogEntry(c, host, session));
    if (!entry) return undefined;
    entry.name = name;
    return catalog;
  });
  if (!updated) return res.status(404).json({ error: 'not a renameable chat' });
  res.json({ ok: true });
});

// Save a temporary (unnamed) shell session — the recently-closed flyout's "save"
// action (WARDEN-1422). Clearing the entry's `temporary` flag promotes it to a
// persistent session: it stops being filtered from every listing and appears
// under its host in the sidebar's saved list. Identity stays untouched — the
// tmux session name, cwd and cmd are exactly what was running, so a save of a
// still-running shell re-homes the SAME process under the host's saved list
// (and a stopped one is respawnable from there). Idempotent: saving an
// already-saved entry is a no-op that still answers ok.
app.post('/api/save-session', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  const chat = r.chat;
  if (chat.kind !== 'tmux') return res.status(400).json({ error: 'only spawned shell sessions can be saved' });
  const updated = await mutateCatalog((catalog) => {
    const entry = catalog.find((c) => sameCatalogEntry(c, chat.host, chat.session));
    if (!entry) return undefined;
    if (!entry.temporary) return catalog; // already saved — no write needed
    return catalog.map((c) => (sameCatalogEntry(c, chat.host, chat.session) ? { ...c, temporary: false } : c));
  });
  if (!updated) return res.status(404).json({ error: 'no saved session matches this id' });
  res.json({ ok: true, chat: { ...chat, temporary: false } });
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
    const bin = splitCmd(finalCmd || '')[0] || 'the command';
    return { error: `\`${bin}\` failed to start on ${host} — the session died immediately. Is it installed and on PATH there?`, status: 500 };
  }
  return { chat: { id: `${host}:${session}`, key: session, kind: 'tmux', host, container: null, session, project: 'manual', role: 'claude', name: chat.name, cwd, cmd: finalCmd, active: true } };
}

// WARDEN-1661 — the activity timeline is bookkeeping, not part of the action. The
// human lifecycle routes (/api/spawn, /api/resume, /api/kill) append their event AFTER
// the irreversible work (tmux session + catalog mutation) is done; a failing append
// (full disk, EACCES, EISDIR) must not turn that success into a 500 (a retry would then
// 409 "already exists"). The await is kept so the event is on disk before res.json.
async function appendEventSafe(route, event) {
  try { await appendEvent(event); } catch (e) { console.error(`[warden] ${route}: activity-log append failed (action succeeded):`, e?.message || e); }
}

app.post('/api/spawn', async (req, res) => {
  const host = String(req.body?.host || LOCAL).trim() || LOCAL;
  const cwd = String(req.body?.cwd || '').trim();
  // WARDEN-1422 — the sidebar's spawn is a PLAIN SHELL (like opening a terminal):
  // host ▾ + directory + optional name. An OMITTED session name means the human
  // did not name it, so the session is TEMPORARY: a generated `shell-xxxxxx`
  // tmux name, cataloged with `temporary: true` so panes/kill still resolve, but
  // filtered from every LISTING (/api/chats, /api/discover, /api/health) —
  // unsaved sessions are never listed anywhere in the UI. A NAMED spawn is
  // persistent (listed under its host) exactly as before.
  const requestedSession = String(req.body?.session || '').trim();
  // A human-typed name may carry characters the tmux session id cannot (the
  // design's saved sessions are named things like "release train 0.1.75"), so
  // when the caller sent a NAME instead of an explicit session id, the id is
  // DERIVED from it (invalid runs → '-') and the raw text stays the display
  // name. An explicit `session` keeps the strict NAME_RE check.
  //
  // WARDEN-1422 QA: `.` is tmux-UNSAFE in a session name — tmux silently
  // rewrites `.` (and `:`) to `_` at creation (`tmux new -d -s a.b.c` creates
  // `a_b_c`), so an id that keeps `.` describes a session tmux does not have:
  // `has-session -t <derived>` then misses, the spawn is misreported as "died
  // immediately" while the REAL session lives on as an orphan (one per retry).
  // The derivation therefore maps every character outside [A-Za-z0-9_-] — the
  // dot included — to '-', so the id we check is byte-identical to the one
  // tmux created. The display name keeps the dot; only the id is normalized.
  const requestedName = String(req.body?.name || '').trim().slice(0, 60);
  const temporary = !requestedSession && !requestedName;
  // A temporary shell's name is GENERATED here (the caller deliberately sent
  // none); `newTempName` draws fresh candidates for the collision loop below.
  const newTempName = () => `shell-${Math.random().toString(36).slice(2, 8)}`;
  const derivedFromName = requestedName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  let session = requestedSession || derivedFromName || newTempName();
  // An OMITTED cmd defaults by naming: a temporary shell is a shell (empty cmd →
  // the host's own login shell, the WARDEN-223 semantics), a named spawn keeps
  // the historical claude default. An EXPLICIT cmd is honored as-is in both
  // paths (the split-shell / open-shell callers still pass theirs).
  const cmdRaw = req.body?.cmd;
  const cmd = (cmdRaw === undefined ? (temporary ? '' : 'claude --dangerously-skip-permissions') : String(cmdRaw)).trim();
  if (requestedSession && !NAME_RE.test(requestedSession)) return res.status(400).json({ error: 'invalid session name (letters/digits/_-)' });
  // Generate a unique name for a temporary shell, re-drawing on the (rare) same-host
  // collision with an existing catalog entry instead of 409ing — the caller never
  // chose the name, so a retry with a fresh draw is always the right answer.
  for (let tries = 0; temporary && tries < 5; tries++) {
    if (!(await loadCatalog()).some((c) => sameCatalogEntry(c, host, session))) break;
    session = newTempName();
  }
  // Pre-flight duplicate check: fail fast with a 409 BEFORE paying for a real
  // tmux/ssh spawn. Composite identity: the same session name may exist on a
  // DIFFERENT host (each host's tmux server is independent), so only a same-host
  // collision blocks spawn. This snapshot is deliberately NOT reused for the append
  // below — buildAndSpawn awaits a full spawn, and appending against a stale
  // snapshot across that window is exactly the lost-update bug (WARDEN-991).
  if ((await loadCatalog()).some((c) => sameCatalogEntry(c, host, session))) return res.status(409).json({ error: `"${session}" already exists` });
  const r = await buildAndSpawn({ host, session, name: requestedName || session, cwd, cmd });
  if (r.error) return res.status(r.status).json({ error: r.error });
  // Append under serialization with a FRESH read, and re-check the collision here:
  // a concurrent spawn of the same host+session may have landed between the
  // pre-check and now. Same 409 body/status as the pre-flight rejection.
  const appended = await mutateCatalog((catalog) => {
    if (catalog.some((c) => sameCatalogEntry(c, host, session))) return undefined;
    return [...catalog, temporary
      ? { kind: 'tmux', host, session, name: r.chat.name, cwd, cmd, temporary: true }
      : { kind: 'tmux', host, session, name: r.chat.name, cwd, cmd }];
  });
  if (!appended) return res.status(409).json({ error: `"${session}" already exists` });
  if (temporary) r.chat.temporary = true;
  // Record the human's own spawn action so a returning human can see the agents
  // they brought up (WARDEN-484). Mirrors the existing attached/ended row shape.
  await appendEventSafe('/api/spawn', { type: 'spawned', id: r.chat.id, host, container: r.chat.container ?? null, role: r.chat.role, name: r.chat.name });
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
  // Serialized filter-then-append in ONE mutation (WARDEN-991) — split across two
  // catalog writes it would race a concurrent kill/spawn. Composite identity: only
  // replace THIS host's same-named resume entry; a different host may legitimately
  // carry the same resume-<sid> session name.
  await mutateCatalog((catalog) => [
    ...catalog.filter((c) => !sameCatalogEntry(c, host, session)),
    { kind: 'tmux', host, session, name, cwd, cmd: chat.cmd },
  ]);
  // Record the human's own resume action (WARDEN-484). container is always null
  // here (resume spawns a bare-tmux session), matching the existing row shape.
  await appendEventSafe('/api/resume', { type: 'resumed', id: out.id, host, container: null, role: out.role, name });
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
  // Serialized (WARDEN-991): a fleet batch-kill fires N concurrent POSTs, and
  // unserialized only ONE removal survived — every tmux session died but the
  // catalog kept ghosts that re-rendered in the sidebar until killed one at a time.
  // Composite identity: only drop the killed chat's own host+session entry — a
  // different host may carry the same session name and must be left intact.
  if (chat.kind === 'tmux') await mutateCatalog((c) => c.filter((x) => !sameCatalogEntry(x, chat.host, chat.session)));
  // Record the human's deliberate kill — the authoritative signal that lets a
  // returning human tell an agent THEY stopped apart from one that crashed. Emitted
  // here rather than via the attach-PTY onExit handler, which stays silent for
  // client-killed sessions (server.js:3339) — so this ALWAYS lands, even with no
  // attach-viewer open (WARDEN-484). yatfa chats carry no `name`, so fall back to
  // the container (the agent's display name) for a friendlier label.
  await appendEventSafe('/api/kill', { type: 'killed', id: chat.id, host: chat.host, container: chat.container ?? null, role: chat.role, name: chat.name ?? chat.container ?? null });
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
  // WARDEN-1422: an EMPTY stored cmd is a valid command — the host's own login
  // shell (the plain-shell spawn, WARDEN-223) — and exactly what a stopped
  // saved shell must respawn with. Only a chat with NO cmd at all (yatfa/
  // legacy rows) is unrespawnable.
  if (chat.kind !== 'tmux' || chat.cmd === undefined || chat.cmd === null) {
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
    const bin = splitCmd(resolved.cmd)[0] || 'the command';
    return res.status(500).json({ error: `\`${bin}\` failed to start on ${chat.host} — the session died immediately. Is it installed and on PATH there?` });
  }
  res.json({ ok: true });
});

// Remove warden's auto-bootstrapped companion binary from a remote host on
// request (WARDEN-882 — the Removability outcome of roadmap WARDEN-270). The
// write/action sibling of the Visibility slice: once installed, it can be taken
// off. Mirrors install: uninstallCompanion kills the cached ssh child, then
// rm -f's ~/.warden/companion-<ver> (and rmdir's ~/.warden only-if-empty) over
// the SAME raw-ssh path bootstrap/probe use — no new port, no root. Body
// {host}; the companion serves REMOTE hosts only, so LOCAL/(local) is rejected.
//
// Host-validation correction: this endpoint takes a HOST (not a chat id), so it
// validates with validateHost(host, cfg) — the helper /api/hosts/health uses —
// rather than resolve() (which resolves a chat id). Mirrors /api/kill's
// {ok}/{error} response shape. Companion-or-fail: surfaces what failed via
// {error}; it does not fall back to raw SSH. Not gated on the companion flag:
// a host that had the flag on (then off) must still be cleanable, so the
// endpoint works regardless of the current toggle state.
//
// WARDEN-1475: a successful removal is also PERSISTED (recordCompanionUninstall
// + save + afterSave, below) so the uninstall survives the next lifecycle tick
// and a restart. Response carries `excluded` — whether the host is now on the
// persisted no-bootstrap list — so the UI can say the removal will hold.
app.post('/api/companion/uninstall', async (req, res) => {
  const host = String(req.body?.host || '');
  if (!host || host === LOCAL) {
    return res.status(400).json({ error: 'a remote host is required (the companion serves remote hosts only)' });
  }
  // Validate the host the same way /api/hosts/health does, so an unreachable
  // host surfaces a clear connectivity message rather than an opaque ssh
  // failure from the uninstall run.
  try {
    const check = await validateHost(host, cfg);
    if (!check.ok) {
      return res.status(400).json({ error: check.error || `host ${host} is unreachable` });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const result = await uninstallCompanion(host, cfg);
    if (!result.ok) {
      const stderr = (result.stderr || '').trim();
      return res.status(500).json({ error: stderr || `failed to remove companion on ${host}` });
    }
    // WARDEN-1475 — PERSIST THE REMOVAL. uninstallCompanion's writes are all
    // in-memory (channelCache / companionStatus / companionOps /
    // bootstrapFailures), so before this slice the very next ordinary op —
    // including the unconditional 60s lifecycle tick, which needs no human
    // gesture — re-uploaded the binary and respawned the channel: the
    // operator's removal was undone by the system within ~60 seconds, with no
    // error and no user-visible signal (roadmap WARDEN-270's Removability
    // outcome, "nothing gets installed that cannot be taken off").
    //
    // uninstallCompanion has ALREADY recorded the fact into `cfg` and applied
    // it to the live env gate (recordCompanionUninstall) — what is missing is
    // the DISK write, and that is exactly what this route owns: `save` /
    // `afterSave` live in this file's import graph, and keeping them out of
    // companion.js preserves uninstallCompanion's `deps.run`/`deps.manifest`
    // test seam. The call below is the idempotent backstop (it no-ops for the
    // host the uninstall just added), so the persist cannot silently depend on
    // WHERE the recording happened.
    recordCompanionUninstall(host, cfg);
    const persisted = cfg.companionExcludedHosts?.includes(host) ?? false;
    if (persisted) {
      // PUT /api/config's shape verbatim, so the removal takes effect live
      // (afterSave → applyCompanionExclusions re-serializes the env gate every
      // routing predicate reads) AND survives a restart, instead of one or the
      // other.
      await save(cfg);
      afterSave(cfg, {
        companionOverridden: companionEnvOverridden,
        forwardTelemetryConfig,
        applyCompanionToggle,
        applyCompanionExclusions,
        restartBudgetPoll,
      });
    }
    res.json({ ok: true, excluded: persisted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
// go through the shared resolveLocalFile, remote chats deliver
// buildFileExistsScript to the host (raw ssh by default, the companion channel
// under the WARDEN-1284 toggle). Response: { exists: boolean } — any resolution
// failure (missing, outside cwd, directory, transport error) collapses to
// exists:false because the linkifier only needs yes/no — EXCEPT a remote probe
// that got no verdict at all, which adds `failed: true` (WARDEN-1492) so it is
// distinguishable from a conclusive absence. Security: never weakens
// the cwd-containment guard.
app.post('/api/file-exists', async (req, res) => {
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

  if (chat.host === LOCAL) {
    const exists = resolveLocalFile(cwd, filePath).ok;
    finishProbe('local', exists);
    return res.json({ exists });
  }

  // Remote: run the existence script; success + the EXISTS marker ⇒ real file.
  // WARDEN-1492: three-state — a probe that got NO verdict (transport error,
  // timeout, script failure) answers `{ exists: false, failed: true }` so the
  // renderer can tell it from a conclusive absence and not cache it, and the
  // telemetry files it in a separate failure bucket instead of "absent".
  const probe = await probeRemoteFile(chat.host, cwd, filePath);
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

// ---------------------------------------------------------------------------
// JSON error handler — WARDEN-1105.
//
// MUST be registered after every route/`app.use` above, and MUST declare four
// arguments, or Express treats it as ordinary middleware and it catches nothing.
//
// Without it, Express hands every error to `finalhandler`, which answers with a
// `text/html` body. The browser client parses every response with `res.json()`
// and falls back to `undefined` when that throws (`web/src/lib/api.ts`), so an
// HTML body erases the server's real diagnostic — an ENOSPC from a config
// write, or body-parser's own 400/413 — and each caller shows its generic
// default toast instead. Most routes here have no top-level try/catch, and
// Express 5 auto-forwards a rejected `async` handler to this handler, so this is
// the single place that guarantees a parseable `{ error }` for all of them. It
// generalizes what `/api/send` and `/api/key` already do by hand.
//
// Scope: an error handler only runs for errors routed through `next(err)`. An
// unmatched path never produces an error, so 404s still come from
// `express.static`/`finalhandler` — deliberately unchanged here, since a
// catch-all would shadow the static serving of the built frontend.
app.use((err, req, res, next) => {
  // A route that already began responding owns the socket; sending again would
  // corrupt the response. Delegate to Express's default handler, which closes
  // the connection instead.
  if (res.headersSent) return next(err);

  // body-parser sets 400 (malformed JSON) and 413 (over the 1mb limit set at the
  // top of this file). Preserving those is the difference between "your payload
  // is too big" and a blanket, misleading 500. Anything that is not a plausible
  // HTTP error status (absent, non-integer, out of range) becomes a 500 rather
  // than being passed to res.status(), which would throw on a bogus code.
  const declared = Number(err?.status ?? err?.statusCode);
  const status = Number.isInteger(declared) && declared >= 400 && declared <= 599 ? declared : 500;

  // 4xx messages are authored by express/body-parser about the client's own
  // request ("request entity too large") — safe and actionable, so they pass
  // through. 5xx messages are unbounded server internals: a HostConnectionError
  // embeds the remote hostname, an fs error embeds an absolute path. Those are
  // replaced wholesale, mirroring the `/api/search-pane` handler just above.
  // Never `err.stack`, at any status.
  //
  // The 4xx message can embed a fragment of the client's own body (V8 renders
  // one into a JSON parse error), so it is length-capped for the same reason
  // requestLabelPath caps its label: a diagnostic must not become a channel for
  // arbitrary text. 200 chars mirrors the caps the rest of this file uses.
  const message = typeof err?.message === 'string' ? err.message.trim().slice(0, 200) : '';
  const safe = status < 500 ? (message || 'bad request') : 'internal server error';

  // The browser losing the detail is the bug being fixed — not the logging. Keep
  // the full error server-side, under the same curated path label the loop
  // monitor uses so an arbitrary URL can't inject text into the log.
  if (status >= 500) console.error(`[error] ${req.method} ${requestLabelPath(req.path)}:`, err);

  res.status(status).json({ error: safe });
});

const server = http.createServer(app);

// ---- WebSocket layer (extracted verbatim to src/wsLayer.js, WARDEN-1381) ----
// Binds both WS servers (observe + stream) and the shared `upgrade` router to THIS
// http instance — the SAME `server` exported below (the test seam): app.listen()
// would create a different server with no WS routing.
setupWsLayer({ server, cfg, resolve, chatCatalog, paneInputTelemetry });

// Rotate old activity events + directives on startup (async + atomic — WARDEN-831)
try { await rotateEvents(); } catch { /* ignore */ }
try { await rotateDirectives(); } catch { /* ignore */ }

// --- Cross-host agent lifecycle polling -------------------------------------
// The tick itself (tickLifecycle/appendLifecycleEvent/tickLifecycleBody + its
// prevSnapshot/lifecycleRunning state) lives in lifecycleTick.js (WARDEN-1669).
const tickLifecycle = createLifecycleTick({ cfg });

const LIFECYCLE_INTERVAL_MS = 60_000;

// Unconditional (no `enabled` gate — the dormancy check lives inside
// tickLifecycleBody), one-shot start, and NO kick guard: lifecycle's crash
// semantics are load-bearing, so its kick must stay a bare trace() with no
// .catch — see createSweepSupervisor's guardKick note in src/sweepSupervisor.js. No test seam either.
const lifecycleSweep = createSweepSupervisor({
  name: 'lifecycle',
  intervalMs: LIFECYCLE_INTERVAL_MS,
  tick: tickLifecycle,
  guardKick: false,
  startOnce: true,
});

function startLifecyclePoll() {
  // start() seeds the baseline immediately (fires once, emits nothing) and, being
  // one-shot, never re-kicks if called a second time.
  lifecycleSweep.start();
}

// ---- Token-spend budget slow-cadence accumulator (WARDEN-415) ---------------
//
// The backend owns the budget check on its OWN slow beat (BUDGET_INTERVAL_MS,
// ~120s) — deliberately decoupled from the 2s monitor tick so it never joins the
// per-tick capture cost. Each tick REUSES the existing per-session token totals
// (through `sessionCache`, the ONE owner of the cross-host session list since
// WARDEN-1208 — the SAME rows /api/claude-sessions-all serves; do NOT re-read
// transcripts with new logic, and do NOT add a second fan-out here: that
// duplication is exactly what the cache was introduced to remove),
// filters to sessions active in the configured window, sums their lifetime
// totals (semantics documented in budget.js), and caches the pure
// computeBudgetState result. /api/budget returns the cache — instant, no SSH —
// so the frontend's progress surface + debounce check stay cheap. One
// unreachable host degrades to "no spend from it" (the cache never rejects and
// leaves a failed fetch's slot untouched); it
// never fails the whole sweep.
let budgetState = null;
// Previous-sweep snapshot for the budget-breach webhook debounce (WARDEN-555).
// Kept SERVER-SIDE (the frontend has its OWN prev in useTokenBudget) so the
// webhook fires on the !alerted → alerted transition even with the Warden
// window closed to tray. Baseline-primed: null on the first tick → no fire.
let prevBudgetState = null;
// Re-entrancy guard, same rationale as lifecycleRunning: a sweep over slow hosts
// can exceed the 120s beat, so an in-flight tick makes the next a no-op. Owned by
// the tick (not the supervisor), which only reads it for its settle seam.
let budgetRunning = false;
// Per-host fetch ceiling. Sessions are mtime-sorted descending and the window is
// recent, so window-active sessions sit at the front; this caps transcript reads
// (local) + the grep+awk SSH pass (remote) on a very active host. 100 is far
// above any realistic 24h session count.
const BUDGET_PER_HOST_LIMIT = 100;

// `deps` is a test seam (defaults to {} in production), identical in shape to
// the lifecycle bridge's: `fetchImpl`/`sleepImpl` flow through to the webhook transport
// so a test drives the full gate → computeBudgetState → shouldFireBudgetAlert →
// dispatch path with ZERO real network. Production calls pass no args, so
// deps.fetchImpl is undefined and dispatchWebhook falls through to globalThis.fetch
// exactly as before.
async function tickBudget(deps = {}) {
  // Self-gate: a disabled budget clears its own timer (and cache) so no sweep
  // runs while off. This makes startBudgetPoll safe to call unconditionally at
  // startup — it parks until the human opts in.
  if (!cfg.tokenBudgetEnabled) {
    budgetSweep.stop();
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
    //
    // ONE OWNER (WARDEN-1208). This used to be its OWN `Promise.allSettled`
    // fan-out, duplicating the route's over the same rows on an unrelated beat —
    // the duplication this comment block has always described ("the SAME
    // functions /api/claude-sessions-all uses") but did not prevent. Both readers
    // now share `sessionCache`, so a sweep landing near a page load costs ONE
    // enumeration per host instead of two, and each warms the slots the other
    // reads.
    //
    // `wait: true` is the slow-cadence mode: unlike the request path there is no
    // user waiting, so this awaits every fetch it launches with NO settle bound
    // and keeps the complete-rows behaviour the budget math has always had. A
    // host that fails still degrades to "no spend from it" — the cache leaves a
    // failed fetch's slot untouched and never rejects — exactly as the previous
    // `allSettled` + fulfilled-filter did.
    //
    // PROJECTED DOWN TO A BARE ARRAY, deliberately. The cache fetches through the
    // richer `remoteClaudeSessionsDetail` (that is how the route keeps its
    // `unreachable` discriminator), but this sweep consumes only the rows, so the
    // frozen `remoteClaudeSessions` contract (WARDEN-1196) is neither widened nor
    // relied on here, and the sweep does NOT start consuming `unreachable` — that
    // would be a behaviour change outside this slice.
    const settled = await sessionCache.snapshot(hosts, BUDGET_PER_HOST_LIMIT, { wait: true });
    // PENDING HOSTS CONTRIBUTE NOTHING TO THE BUDGET MATH, and this projection is
    // load-bearing rather than defensive.
    //
    // `wait: true` awaits every fetch this sweep LAUNCHES, but it cannot wait on
    // one it merely JOINED at a smaller limit (launcher-only settle discipline,
    // and a joined fetch fills the slot at ITS launcher's window). So when a
    // page-1 route fetch — `perHost = offset + limit + 1`, typically 41 — is in
    // flight as the 120s tick fires, this sweep can arrive holding a REAL but
    // TRUNCATED 41-row slot for a host it asked 100 rows of. The cache tells us
    // exactly that via `pending`.
    //
    // Those rows are mtime-DESCENDING, so on a host with more than 41 sessions
    // active in the window the truncation silently DROPS spend, and the result is
    // cached for the next 120s. That is a wrong NUMBER, not a slow response —
    // strictly worse than the honest degradation, and worse than the pre-cache
    // behaviour (which always fanned out at the full 100).
    //
    // `completeSessionRows` excludes those hosts, degrading each to "no spend from
    // it this tick" — the SAME pre-existing semantics an unreachable or failed
    // host already gets here, self-correcting on the next tick. The ROUTE
    // deliberately does the OPPOSITE with the same flag (it keeps the rows and
    // discloses `pendingHosts`), because it renders a list rather than computing a
    // number; that divergence is documented on the helper.
    const sessions = completeSessionRows(settled);
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

const budgetSweep = createSweepSupervisor({
  name: 'budget',
  intervalMs: BUDGET_INTERVAL_MS,
  tick: tickBudget,
  isRunning: () => budgetRunning,
  enabled: () => cfg.tokenBudgetEnabled,
  // Disable clears the cache so /api/budget reports disabled honestly. Nothing on
  // the enable leg — unlike attention, budget has no baseline to re-prime.
  onDisable: () => { budgetState = null; },
});

function startBudgetPoll() {
  // Always (re)seed the interval; tickBudget self-clears when disabled, so an
  // idle parked timer is harmless and lets a later enable (PUT /api/config) wake
  // it without a second start call. The kick seeds the cache immediately.
  budgetSweep.start();
}

// Test seam: resolves once no budget sweep is in flight — the seed one kicked by
// startBudgetPoll/restartBudgetPoll included. A test that enables the budget via PUT
// /api/config and then drives its own tickBudget() sweeps MUST await this first: the
// seed sweep advances prevBudgetState when it lands, and while it runs the
// budgetRunning guard makes the test's own sweep a silent no-op — which turns the
// test's priming sweep into a nothing and its breach sweep into the prime, so the
// expected POST never fires.
export const __budgetSweepSettledForTest = budgetSweep.settled;

// React to a config change: enable → ensure the timer runs + recompute now;
// disable → stop + clear the cache so /api/budget reports disabled honestly;
// threshold/window tweak → recompute now so the next read is fresh.
// Kept a NAMED function (not an alias): config-schema.js's afterSave pipeline is
// injected with it by name — src/config-schema.test.js:393-402 pins that dep list.
function restartBudgetPoll() {
  budgetSweep.restart();
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

// WARDEN-1258 — the file-exists probe metrics producer, exported as the test
// seam for the /api/file-exists instrumentation (the HTTP suite flips consent
// on in its pre-import config and asserts observations folded through the REAL
// route wiring). Also lets an operator snapshot probe costs from a REPL.
export { fileExistsTelemetry };

// WARDEN-1278 — exported on the same reasoning as fileExistsTelemetry above: an
// integration test drives a REAL stall record through the REAL setOnStall
// callback and then closes the window with flushNow(), rather than reaching
// into the producer's internals or waiting 5 minutes for a timer.
export { serverStallTelemetry };

// WARDEN-1385 — exported on the same reasoning: the pane-latency integration
// test and the diagnostics endpoint drive the REAL producer (noteInputWritten →
// notePaneOutput → windowSnapshot/flushNow) rather than a parallel copy.
export { paneInputTelemetry };

// WARDEN-1292 — exported on the same reasoning: the request-telemetry HTTP
// suites drive REAL /api traffic through the REAL middleware wiring and close
// the window with flushNow(), rather than reaching into the producer's
// internals or waiting 5 minutes for a timer.
export { requestTelemetry };

// WARDEN-1578 — exported so the wiring test drives a REAL run() observation
// through the REAL observer and closes the window with flushNow().
export { sshTelemetry };

// WARDEN-1598 — exported on the same reasoning (wiring test).
export { companionRpcTelemetry };

// WARDEN-1416 — exported on the same reasoning: a test seeds the REAL chat
// catalog and closes the window with flushNow(), proving the catalog read and
// the names-only consent gate through the real wiring rather than a parallel
// copy.
export { workspaceNamesTelemetry };

// WARDEN-1278 — test seams for src/server-stall-telemetry.test.js, which drives
// the REAL setOnStall callback to prove the owner's local channels (stalls.jsonl,
// the stderr line, /api/diagnostics/stalls) are byte-untouched by the additive
// telemetry fold.
//
// `__startLoopMonitorForTest` arms ONLY the callback: startLoopMonitor() also
// starts the heartbeat timer and patches the fs / child_process builtins
// PROCESS-WIDE, which a test must not do to the runner it shares. The callback
// is the thing under test; the timer and the patch are WARDEN-977's and are
// covered by src/loop-monitor.test.js.
//
// `cfg` is exported so the test can flip consent IN PLACE, exactly as
// applyConfigPut does — which is what makes the LIVE consent resolution (rather
// than a value captured at wire-up) the thing being asserted.
export function __startLoopMonitorForTest() {
  wireStallSink();
}
export { cfg };

// WARDEN-1406 — test seam for src/server-suspend-arm.test.js: drives the REAL
// arming path (the same function the module scope ran) with the forked flag
// forced, an injectable monitor, and a returned { clock, dispose } so a test
// can inspect the window store and clean the real process's listener up. In the
// test runner `typeof process.send` is undefined, so the module-scope call
// above armed nothing — the standalone-unarmed contract is asserted against
// that live state.
export function __setupSuspensionDiscriminationForTest(opts) {
  return setupSuspensionDiscrimination(opts);
}

// The process-wide monitor, re-exported for the same test: test-fixtures/
// stall-ipc-harness.mjs runs INSIDE a forked child and must reach the very same
// module instance the sink was wired on — importing loop-monitor.js separately
// would work today but would silently stop proving anything if the server ever
// used a monitor of its own.
export { loopMonitor as __loopMonitorForTest };

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
    // Watch THIS process's event loop for multi-second blocks and record them
    // durably with attribution (WARDEN-977). Started here — not at module import
    // — so importing `app` (tests, tools, the CLI) runs no timer and patches no
    // builtin; the server child is the only process that instruments itself.
    startLoopMonitor();
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
