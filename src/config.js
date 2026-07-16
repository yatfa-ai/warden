// Config + paths for warden. All user data lives under ~/.yatfa-warden/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const dir = path.join(os.homedir(), '.yatfa-warden');
export const configPath = path.join(dir, 'config.json');
export const cachePath = path.join(dir, 'cache.json');
export const catalogPath = path.join(dir, 'chats.json'); // user-defined manual chats

const DEFAULTS = {
  hosts: [],            // SSH host aliases to scan (from ~/.ssh/config). Add yours in ~/.yatfa-warden/config.json
  tmuxSession: 'agent', // tmux session name yatfa creates inside each container
  connectTimeout: 10,
  pollIntervalMs: 1500,
  pins: [],             // chat ids to surface first in listings / UI
  agentNotes: {},       // id → short human note (mirrors pins; works for un-renameable yatfa agents)
  sessionTags: {},      // claude-session id → string[] of short reusable labels (WARDEN-342); local sidecar, never written to transcripts
  // User-authored output-pattern alerts (WARDEN-540). The deterministic, zero-LLM,
  // user-authored complement to the fixed Watch categories: a human teaches Warden
  // "ping me when a watched agent prints X." Each entry:
  //   { id, name, expression, mode: 'string'|'regex', enabled }
  // Evaluated ONLY over pane text already captured for the watched set (the matcher
  // rides pollAgentStates's existing capturePanes — ZERO new SSH cost). Empty by
  // default → behavior is identical to today (no patterns = no custom alerts).
  // Sanitized on PUT /api/config (src/server.js) via sanitizeWatchPatterns.
  watchPatterns: [],
  // Observer settings
  observerConfirmMode: 'always',  // 'always' | 'auto-safe' - whether to auto-approve read-only directives
  observerAutoStart: false,       // boolean - whether to auto-start observer on first connection
  observerSessionTimeout: 30,     // minutes - auto-stop observer after inactivity, null to disable
  // Observer LLM provider/model (WARDEN-350). Empty object by design — llm.js
  // owns its own fallbacks ('glm-5.2' / 'https://api.anthropic.com' / 2048
  // max_tokens); never invent a default authToken or model here. Populated via
  // Settings → PUT /api/config and read live by llm.js's per-call resolvers.
  llm: {},
  // Fleet health attention thresholds (minutes of inactivity).
  // healthWarningThresholdMin maps to the healthy→WARNING boundary: once an
  // agent has been inactive this long it needs attention (WARNING). Must be <=
  // the critical threshold or WARNING collapses. Default 5 = today's behavior.
  healthWarningThresholdMin: 5,
  // healthCriticalThresholdMin maps to the warning→CRITICAL boundary: at this
  // much inactivity an agent is CRITICAL (and fires a desktop alert). ALSO
  // drives the IDLE branch for manual tmux sessions, so all three
  // getHealthState call sites consume the same configured value. Default 30.
  healthCriticalThresholdMin: 30,
  // Token-spend budget with threshold alerts (WARDEN-415). A meter without an
  // alarm is half-finished: WARDEN-367 surfaces per-session + fleet token totals;
  // these add the ALARM that routes human attention to a runaway/looping agent's
  // cost. Fully human-in-the-loop — it NOTIFY (desktop + in-app toast), it never
  // auto-kills/stops. Defaults: budget OFF (the human opts in via Settings).
  //   tokenBudgetEnabled                 — master switch for the whole feature.
  //   tokenBudgetThresholdTokens         — fleet-wide windowed threshold (the
  //                                        "spent across active sessions" alarm).
  //   tokenBudgetWindowHours             — rolling window (which SESSIONS count:
  //                                        active in the last N hours). Each
  //                                        contributes its FULL lifetime total
  //                                        (reuses the existing meter, no new
  //                                        transcript logic) — see budget.js.
  //   tokenBudgetPerSessionThresholdTokens — per-session runaway threshold (catches
  //                                        the SPECIFIC looping agent, not just
  //                                        aggregate drift). null/0 disables it.
  tokenBudgetEnabled: false,
  tokenBudgetThresholdTokens: 2_000_000,
  tokenBudgetWindowHours: 24,
  tokenBudgetPerSessionThresholdTokens: 1_000_000,
  // Companion transport (WARDEN-439 / roadmap WARDEN-270). A persistent RPC
  // channel to a remote host that collapses per-op SSH handshakes into one
  // connection — the biggest lever for cutting ssh-process churn on a
  // remote-heavy fleet. Was reachable only via the WARDEN_COMPANION_TRANSPORT=1
  // env var; now a first-class Settings toggle. Default OFF (experimental);
  // the env var remains an explicit operator override (force on/off regardless
  // of the UI). Remote-only by design — local hosts never route through it.
  companionTransportEnabled: false,
  // Optional telemetry — OFF BY DEFAULT, two tiers, both revocable anytime
  // (roadmap WARDEN-446 / design WARDEN-443). Nothing leaves the machine until
  // the user explicitly turns the base tier on in Settings; this is warden's
  // "off by default" trust foundation, persisted server-side (NOT client
  // localStorage) so it survives behind the backend config and a restart. The
  // receiver lives in a SEPARATE repo (warden-telemetry); this repo ships only
  // the client + the schema version it speaks.
  //   telemetryBaseEnabled     — anonymous error / crash / performance-stall
  //                              events only. No content, no paths, no identifiers
  //                              (the base-tier schema carries none by design).
  //   telemetryExtendedEnabled — gated behind base: additionally retains chat +
  //                              session NAMES (content is never sent). The server
  //                              PUT handler CLAMPS this to false unless base is
  //                              also on (extended-requires-base, enforced in
  //                              code — server.js WARDEN-457).
  telemetryBaseEnabled: false,
  telemetryExtendedEnabled: false,
  // Telemetry receiver endpoint (WARDEN-461). OFF by default: an empty string
  // means "unconfigured" and the transport (telemetry-send.js) sends NOTHING —
  // it is the last gate that makes "off by default / halts all traffic" real on
  // the wire. Set this to your self-hostable receiver's ingest URL via Settings
  // (PUT /api/config). No hardcoded SaaS host is ever used; events go only to
  // this URL. Consent is a SEPARATE gate (slice 1) — even with an endpoint set,
  // the transport no-ops unless consent is on.
  telemetryEndpoint: '',
  // Telemetry receiver shared-secret auth token (WARDEN-569). EMPTY by default =
  // sends no Authorization header (works against an AUTH_TOKEN-unset receiver).
  // When set, the transport (telemetry-send.js) sends it as
  // `Authorization: Bearer <token>` so a receiver that set AUTH_TOKEN accepts the
  // batch. This is a SECRET: GET /api/config never returns it in cleartext (only a
  // set + last-4 mask), and PUT only overwrites it on a non-empty value (no-clobber
  // — mirroring llm.authToken / webhookSecret) so an untouched password field
  // preserves the stored token.
  telemetryAuthToken: '',
  // Webhook "push" delivery channel (WARDEN-555). OFF by default: sends nothing
  // until the user configures a URL and enables it. Delivers critical agent
  // alerts to the user's OWN webhook URL (ntfy/Discord/Slack/Telegram/Home
  // Assistant) so a human away from the machine still gets pinged the moment an
  // agent newly needs attention or a token budget breaches — even with the
  // Warden window closed to tray (the backend stays alive on close-to-tray).
  // Reuses the same fire-and-forget POST transport shape as telemetryEndpoint;
  // the payload goes ONLY to the user's own URL (no yatfa SaaS), exactly like
  // the LLM API + telemetry endpoints. Off-by-default is enforced on the wire:
  // notify.js's sendWebhook is a strict no-op (fetch never called) unless
  // webhookEnabled is true AND webhookUrl is non-empty.
  //   webhookUrl            — destination URL. Empty = unconfigured = sends nothing.
  //   webhookEnabled        — master switch (the on-the-wire gate).
  //   webhookSecret         — shared secret (write-only on the wire: sent as
  //                           Authorization: Bearer + X-Webhook-Secret). No-clobber
  //                           on save, mirroring llm.authToken.
  //   webhookAlertAttention — route newly stuck/erroring/waiting/blocked pane
  //                           transitions (server-side attention sweep).
  //   webhookAlertBudget    — route token-budget breach transitions (tickBudget).
  // (Watch-pattern alerts are deferred to a follow-up: watch patterns live
  // client-side, so there is no server-side transition to dispatch yet.)
  webhookUrl: '',
  webhookEnabled: false,
  webhookSecret: '',
  webhookAlertAttention: true,
  webhookAlertBudget: true,
  // Safety
  confirmDestructiveActions: true, // boolean - confirm before destructive kills (force-kill tmux session, kill chat)
  notifyChatOps: true,           // chat operations (session kill, chat kill, resume, rename)
  notifyErrors: true,            // error toasts
  notifySuccess: true,           // success toasts
  notifyObserver: true,          // observer events (timeout, gate prompts)
  // Display customization
  showHostTags: true,        // Show host badges (local/hostname)
  showTypeBadges: true,      // Show type labels (shell/claude/yatfa)
  showStatusIndicators: true, // Show status dots (active/idle/dead)
  showProjectBadges: false,   // Show project name badges
  hideOfflineHosts: false,    // Collapse offline SSH hosts into an expandable "Offline (N)" row in the sidebar
};

export function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // first run — defaults are fine, don't force-create
  }
  return { ...DEFAULTS, ...raw };
}

export function save(cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

// Manual chat catalog — user-spawned chats (claude in a host tmux session).
// Each entry: { host, session, cwd, cmd, name? }. `session` is unique per host,
// NOT globally — the same session name may exist on different hosts (each host's
// tmux server is independent), so identity is the host+session composite below.
const LOCAL = '(local)';

// Catalog identity is a host+session composite. Every site that matches, filters,
// or de-dupes catalog entries must compare BOTH host and session: a bare session
// match would either falsely collide (spawn 409) or silently delete the wrong
// host's entry (kill/resume) once names may repeat across hosts. Legacy entries
// written before host-scoping lack `host` — treat them as local.
//
// `catalogKey` is the single source of truth for that composite shape — the same
// `${host}:${session}` form the runtime chat id uses (buildAndSpawn / resume in
// server.js) — and `sameCatalogEntry` is just key equality, so catalog identity
// and live chat identity can never drift apart.
export function catalogKey(c) {
  return `${c.host || LOCAL}:${c.session}`;
}

export function sameCatalogEntry(c, host, session) {
  return catalogKey(c) === catalogKey({ host, session });
}

export function loadCatalog() {
  try {
    const v = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (!Array.isArray(v)) return [];
    return v.map((e) => {
      // migrate legacy kind:'local' (direct PTY) → kind:'tmux' (local tmux, host '(local)')
      if (e.kind === 'local') { e.kind = 'tmux'; e.host = e.host || '(local)'; }
      // fold legacy cmd+args into a single cmd line (tmux spawn takes a command line)
      if (Array.isArray(e.args)) { e.cmd = [e.cmd, ...e.args].filter(Boolean).join(' '); delete e.args; }
      return e;
    });
  } catch { return []; }
}
export function saveCatalog(list) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(list, null, 2) + '\n');
}

// Stamp a catalog entry's last-known activity timestamp (WARDEN-245). A closed
// chat keeps a usable lastActivity for recency ordering only if the value
// survives the chat going inactive; lastActivity is captured for LIVE sessions
// alone, so we persist it on the catalog entry while the chat is alive. Only
// writes when the new value is FRESHER than the stored one (so a 60s re-discover
// of an unchanged pane does not thrash disk), and only for an entry that exists.
// `lastActivity` is ms-since-epoch. Returns true iff the catalog was updated.
export function stampCatalogActivity(host, session, lastActivity) {
  if (lastActivity == null || !Number.isFinite(lastActivity)) return false;
  const catalog = loadCatalog();
  const entry = catalog.find((c) => sameCatalogEntry(c, host, session));
  if (!entry) return false;
  if (!entry.lastActivity || entry.lastActivity < lastActivity) {
    entry.lastActivity = lastActivity;
    saveCatalog(catalog);
    return true;
  }
  return false;
}

// Parse ~/.ssh/config Host aliases (best-effort, no dep). Used for completion /
// validation — discovery only scans cfg.hosts.
export function allSshHosts() {
  const cfgPath = path.join(os.homedir(), '.ssh', 'config');
  const hosts = [];
  try {
    const text = fs.readFileSync(cfgPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*Host\s+(.+)$/i);
      if (!m) continue;
      for (const h of m[1].trim().split(/\s+/)) {
        if (!h.includes('*') && !h.includes('?') && !hosts.includes(h)) hosts.push(h);
      }
    }
  } catch {
    /* no ssh config */
  }
  return hosts;
}
