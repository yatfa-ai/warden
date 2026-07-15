export interface Chat {
  id: string;
  key?: string;        // unique display/stream id (yatfa: container; manual: session)
  kind?: 'yatfa' | 'tmux' | 'local';
  host: string;
  container?: string | null;
  session?: string;
  project?: string;
  role?: string;
  name?: string;
  cwd?: string;
  cmd?: string;
  isAgent?: boolean;
  active?: boolean | null;  // null = undiscovered (lazy mode, before host is clicked)
  status?: string;
  lastActivity?: number;  // Timestamp of last activity (ms since epoch)
  healthState?: string;  // Health state (healthy, warning, critical, idle, unknown)
  // Per-container resource usage from `docker stats` (WARDEN-309). Captured in the
  // SSH discover() path only (rides the existing discover round-trip), cache-carried
  // into /api/health (zero SSH on the 10s poll). Optional → chats without them
  // (bare-tmux/manual agents, hosts whose docker stats failed, companion path)
  // are unaffected.
  cpuPct?: number;     // e.g. 42.3 (percent, no trailing %)
  memPct?: number;     // e.g. 15.7 (percent)
  memUsage?: string;   // e.g. "310.2MiB / 2GiB" (used / total display string)
  // Per-agent token spend (WARDEN-466): the lifetime total of the budget session
  // this chat joined to (by cwd+host), attached server-side in /api/health from
  // the cached budgetState.sessionUsage map. Optional → chats that don't join
  // (budget off, no usage, or no cwd+host match) render no token chip, identical
  // graceful-N/A to a missing CPU/mem field. `total` is model-agnostic tokens.
  tokenUsage?: { total: number };
}

export interface HealthData {
  agents: Chat[];  // Agents with healthState
  groups: {
    healthy: Chat[];
    warning: Chat[];
    critical: Chat[];
    idle: Chat[];
    closed: Chat[];
    unknown: Chat[];
  };
  summary: {
    healthy: number;
    warning: number;
    critical: number;
    idle: number;
    closed: number;
    total: number;
    label: string;
  };
  timestamp: number;
}

export type StreamMsg =
  | { type: 'snapshot'; id: string; pane: string }
  | { type: 'pty'; id: string; data: string }
  | { type: 'attached'; id: string }
  | { type: 'ended'; id: string; code?: number }
  | { type: 'attach_error'; id: string; error: string }
  // WARDEN-231: the bounded pre-attach probe classified this pane's session.
  // session_dead = host reachable but the tmux session is absent (recovery panel
  // with Open shell / Re-spawn / Close); host_unreachable = SSH can't deliver
  // (elapsed-then-unresponsive panel with Retry / Close). Distinct from
  // attach_error (a thrown attach) so the frontend branches correctly.
  | { type: 'session_dead'; id: string }
  | { type: 'host_unreachable'; id: string };

export type StreamReq =
  | { type: 'monitor'; id: string }
  | { type: 'unmonitor'; id: string }
  | { type: 'attach'; id: string; cols: number; rows: number; host?: string }
  | { type: 'detach'; id: string }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number };

export type ObserveMsg =
  | { type: 'thinking' }
  | { type: 'tool'; name: string; input?: { id?: string } }
  | { type: 'assistant'; text: string }
  | { type: 'done'; text: string }
  | { type: 'directive_proposed'; requestId: string; container: string; host: string; role?: string; directive: string }
  | { type: 'error'; error: string }
  | { type: 'history'; name?: string; chatContext?: ChatContextMeta; items: { role: 'user' | 'assistant' | 'tool'; text?: string; name?: string; id?: string }[] }
  | { type: 'session_created'; sid: string; name: string; chatContext?: ChatContextMeta };

// Which agent chat an observer session is bound to. Lets a resumed session
// reconnect to its original agent (host becomes an attribute of the session).
export interface ChatContextMeta {
  host?: string | null;
  container?: string | null;
  project?: string | null;
  role?: string | null;
  chatKey?: string | null;
}

export interface SessionMeta extends ChatContextMeta {
  id: string;
  name: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
}

export type TileMode = 'monitor' | 'live';

export interface Collection {
  id: string;
  name: string;
  criteria?: { role?: string; project?: string; host?: string; custom?: string[] };
  metadata?: { description?: string; color?: string };
  createdAt: number;
  updatedAt: number;
}

export interface ActivityEvent {
  timestamp: string;
  type:
    | 'directive_proposed' | 'directive_sent' | 'directive_rejected' | 'attached' | 'ended' | 'error' | 'snapshot'
    // Cross-host lifecycle transitions (server-side periodic poll; see src/lifecycle.js).
    // `active` reflects the `agent` tmux session being alive, not output recency.
    | 'agent_started' | 'agent_ended'           // container appeared / disappeared
    | 'agent_session_up' | 'agent_session_down' // tmux session came alive / stopped
    | 'host_error' | 'host_ok';                 // host discovery failed / recovered
  id?: string;
  container?: string;
  host?: string;
  role?: string;
  project?: string;
  directive?: string;
  error?: string;
  code?: number;
  context?: string;
  [key: string]: any; // Allow additional properties
}

export interface ActivityStats {
  total: number;
  directive_proposed: number;
  directive_sent: number;
  directive_rejected: number;
  attached: number;
  ended: number;
  error: number;
  snapshot: number;
}

/**
 * A directive that reached an agent — the structured view of one
 * `directives.md` block (written by observer.js logDirective, read back by the
 * GET /api/directives endpoint). `text` is the FULL directive body (possibly
 * multi-line); `container@host` (+ `role`) is the target.
 */
export interface Directive {
  timestamp: string;
  container: string;
  host: string;
  role: string;
  text: string;
}

/**
 * Per-agent, per-time-bucket activity series for the Fleet Health sparklines
 * (WARDEN-299). Returned by `GET /api/activity/series`.
 *
 * `buckets` is the full epoch-aligned bucket-start range across the requested
 * window (ascending) — idle periods are zero buckets, not gaps. Each series
 * entry's `total`/`error` arrays are parallel to `buckets` (same length, index
 * i ↔ buckets[i]); `error` counts "something went wrong" event types.
 */
export interface ActivitySeries {
  bucketMs: number;
  buckets: number[];
  series: Record<string, { total: number[]; error: number[] }>;
}

/**
 * A single agent's classified pane state, from `GET /api/agent-states` (WARDEN-344).
 *
 * `/api/health` is purely inactivity-based (HEALTHY/WARNING/CRITICAL by time since
 * last output), so an agent ACTIVELY emitting a repeating loop, a stack trace, or a
 * "press enter" prompt reads HEALTHY. This is the rich pane-content signal that fills
 * that gap: each open agent's `state` (active/idle/stuck/erroring/blocked/waiting, or
 * `capture_failed` when its host was unreachable) plus the `signal` line that
 * triggered it. `capture_failed` is NOT folded into the attention rollup — an
 * unreachable host is already surfaced as CRITICAL/CLOSED by /api/health, so counting
 * it here would double-count the same condition.
 */
export interface AgentStateRow {
  id: string;
  key?: string;
  host?: string;
  project?: string;
  role?: string;
  name?: string;
  state: string;
  /** The line that triggered the state (the repeating line / matched prompt). */
  signal?: string | null;
  /** True when the pane's host could not be captured (flagged, not dropped). */
  captureError?: boolean;
}

/** Response shape of `GET /api/agent-states` (WARDEN-344). */
export interface AgentStatesData {
  agents: AgentStateRow[];
  total: number;
  timestamp: number;
}

/**
 * Minimal shape an AttentionBadge row needs to render + deep-link into a pane. Both
 * `Chat` (from /api/health's critical/warning groups) and `AgentStateRow` (from
 * /api/agent-states) structurally satisfy it, so the badge's AgentRow accepts either.
 */
export interface AttentionAgent {
  id: string;
  key?: string;
  name?: string;
  role?: string;
  host?: string;
}
