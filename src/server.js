// warden web dashboard server. tmux is required everywhere — every chat is a tmux
// session (yatfa: in a docker container; manual: a host/local tmux session). The
// transport (ssh.js runTmux/attachTmux) routes each op to the remote host over SSH
// or to this machine locally. No more direct-PTY path.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
// NOTE: server.js performs NO catalog writes any more — the last of them (the
// session-lifecycle routes' `mutateCatalog`/`loadCatalog` calls, WARDEN-991's
// read-modify-write critical section) moved to src/sessionRoutes.js (WARDEN-1868).
// Only the plain config load/save remain here; `saveCatalog` stays out of scope
// exactly as before, and the catalog-write invariant now lives where the writes do.
import { load, save } from './config.js';
import { afterSave } from './config-schema.js';
// WARDEN-1116 — THE telemetry consent authority (pure, dependency-free CJS shared
// by the server and the Electron main process; see src/telemetry-consent.cjs).
import { resolveConsent } from './telemetry-consent.cjs';
// WARDEN-1258 — usage-telemetry producer for the linkifier's existence probe
// (the operational-metrics consent category; see src/fileExistsTelemetry.js).
import { createServerTelemetry } from './serverTelemetry.js';
import { applyCompanionToggle, applyCompanionExclusions } from './companion.js';
// NOTE: `catalogChats` and `discoverHost` are deliberately NOT imported here.
// Every in-memory catalogue read/write in this file goes through `chatCatalog`,
// which owns the per-host slots, the freshness stamps, the in-flight dedup and
// the lastActivity carry-forward (WARDEN-1206). Those two functions are the
// owner's injected dependencies (src/chatCatalog.js). Keeping them out of scope
// makes that single-owner invariant structural rather than a convention — the
// same trick the `saveCatalog` note above plays for the disk catalogue.
import { resolveChatWithRefresh, discoverAll } from './chats.js';
// `run` is no longer imported: WARDEN-1284 routed the last four direct `run()`
// call sites in this file (the file viewer read, the linkifier existence probe,
// the session search + transcript reads, the tmux preflight) through
// `deliverRemoteScript`, which owns the run()-vs-companion choice. Every
// remaining remote script in this file goes through that guard or through
// runInContext.
import { runLocalTmux, TMUX_BIN, startConnectionPoolCleanup } from './ssh.js';
// The single source of the working-directory containment rule (WARDEN-1234):
// the JS clause for local resolution, and the bash fragment spliced into every
// remote script that guards a path against its cwd.
import {
  // `remoteClaudeSessions` (the frozen bare-array variant) is deliberately NOT
  // imported here: since WARDEN-1208 both fleet readers go through
  // `sessionCache`, which fetches the richer detail variant and projects down.
  // The route handlers that use the other session helpers live in
  // src/claudeSessionsRoutes.js (WARDEN-1740).
  localClaudeSessions, remoteClaudeSessionsDetail,
} from './claudeSessions.js';
import { rotateDirectives } from './observer.js';
import { resolveModel } from './llm.js';
import { listSessions, createSession, renameSession, deleteSession, isValidSessionId } from './sessions.js';
import { rotateEvents } from './activity.js';
import { BUDGET_INTERVAL_MS } from './budget.js';
import { createChatCatalogCache } from './chatCatalog.js';
import { createSessionCache } from './sessionCache.js';
import { unsubscribePanes, startPaneDeltaSweep, deliverRemoteScript } from './companion.js';
import { createHostsRouter } from './hostsRoutes.js';
import { createPaneRouter } from './paneRoutes.js';
import { createGitRouter } from './gitRoutes.js';
import { createUserDataRouter } from './userDataRoutes.js';
import { createClaudeSessionsRouter } from './claudeSessionsRoutes.js';
import { createActivityRouter } from './activityRoutes.js';
import { createChatFileRouter } from './chatFileRoutes.js';
import { createConfigRouter } from './configRoutes.js';
import { createSessionRouter } from './sessionRoutes.js';
import { createFleetRouter } from './fleetRoutes.js';
import { createStatusRouter } from './statusRoutes.js';
import { createLifecycleTick } from './lifecycleTick.js';
import { createBudgetTick } from './budgetTick.js';
import { isBinaryFile, isBinaryBlob, readWorkingTreeFile } from './chatFiles.js';
// WARDEN-1381 — the WebSocket layer (observe wss + streamWss + the upgrade router).
import { setupWsLayer } from './wsLayer.js';
import { hostGuardMiddleware, originGuardMiddleware, boundHostOf } from './originGuard.js';
import { createSweepSupervisor } from './sweepSupervisor.js';
import { loopMonitor } from './loop-monitor.js';
import { createLoopWiring } from './loopWiring.js';
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
// WARDEN-1896 — reject a non-loopback Host (DNS rebinding) before any router or static
// handler. The bound address is read lazily from the http server so a deliberate
// non-loopback startServer(port, host) bind keeps working.
app.use(hostGuardMiddleware(() => boundHostOf(server)));
app.use(originGuardMiddleware());
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
// src/chatCatalog.js; it is modelled on createHostStatusCache (src/hostStatus.js).
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

// WARDEN-1923: the event-loop stall wiring (WARDEN-977) and the server-runtime
// suspension discrimination (WARDEN-1406) live in src/loopWiring.js. The thunk
// reads `serverStallTelemetry` (destructured further down) at call time.
const { wireStallSink, startLoopMonitor, setupSuspensionDiscrimination } = createLoopWiring({
  getServerStallTelemetry: () => serverStallTelemetry,
});

// Wire it once at module scope, next to the other IPC-channel wiring: the
// arming is a property of HOW this process was started, not of when the HTTP
// server starts listening.
setupSuspensionDiscrimination();

app.use(createFleetRouter({ cfg, chatCatalog, getBudgetState: () => budgetTick.getBudgetState() }));

// WARDEN-1647: the agent-state poll core lives in agentStatePoll.js; re-exported so every `server.X` consumer is untouched.
export { appendStateEvent, logStateTransition, pollAgentStates, pollFleetStates, __resetLastLoggedStateForTest } from './agentStatePoll.js';

app.use(createPaneRouter({ cfg, resolve, chatCatalog }));

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

app.use(createHostsRouter({ cfg, local: LOCAL }));

// WARDEN-1868 — hoisted from the createConfigRouter call below so BOTH mounts hand
// afterSave the identical five dependencies: the settings routes (WARDEN-1810) and
// /api/companion/uninstall's persist (WARDEN-1475, now living in sessionRoutes.js).
const afterSaveDeps = {
  companionOverridden: companionEnvOverridden,
  forwardTelemetryConfig,
  applyCompanionToggle,
  applyCompanionExclusions,
  restartBudgetPoll,
};

app.use(createConfigRouter({
  cfg,
  save,
  companionEnvOverridden,
  afterSaveDeps,
}));

// WARDEN-1916 — the eight server-child telemetry producers (and their observer
// hooks) are built in src/serverTelemetry.js; destructured here at the same module
// position so the routers below can consume them and the re-exports stay put.
const {
  fileExistsTelemetry,
  serverStallTelemetry,
  paneInputTelemetry,
  requestTelemetry,
  sshTelemetry,
  companionRpcTelemetry,
  workspaceNamesTelemetry,
} = createServerTelemetry({ app, cfg, chatCatalog });

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

app.use(createStatusRouter({ loopMonitor, paneInputTelemetry, cfg, getBudgetState: () => budgetTick.getBudgetState() }));


// ---- git HTTP layer (extracted to src/gitRoutes.js, WARDEN-734) ----
app.use(createGitRouter({ resolve, readWorkingTreeFile, isBinaryFile, isBinaryBlob }));
app.use(createUserDataRouter({ cfg, chatCatalog }));
app.use(createClaudeSessionsRouter({ cfg, sessionCache, local: LOCAL }));
app.use(createActivityRouter());

// ---- session lifecycle routes (extracted to src/sessionRoutes.js, WARDEN-1868) ----
app.use(createSessionRouter({ cfg, local: LOCAL, resolve, preflightTmux, save, afterSave, afterSaveDeps }));

// Chat working-directory file routes (read-file / file-exists / search-files).
app.use(createChatFileRouter({ resolve, fileExistsTelemetry, local: LOCAL }));

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
// The tick itself (tickBudget + budgetState/prevBudgetState/budgetRunning state and
// BUDGET_PER_HOST_LIMIT) lives in budgetTick.js (WARDEN-1688). The supervisor stays
// here; stopSweep late-binds the `budgetSweep` const declared below.
const budgetTick = createBudgetTick({ cfg, sessionCache, local: LOCAL, stopSweep: () => budgetSweep.stop() });
const { tickBudget } = budgetTick;

const budgetSweep = createSweepSupervisor({
  name: 'budget',
  intervalMs: BUDGET_INTERVAL_MS,
  tick: tickBudget,
  isRunning: budgetTick.isRunning,
  enabled: () => cfg.tokenBudgetEnabled,
  // Disable clears the cache so /api/budget reports disabled honestly. Nothing on
  // the enable leg — unlike attention, budget has no baseline to re-prime.
  onDisable: budgetTick.clearBudgetState,
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
