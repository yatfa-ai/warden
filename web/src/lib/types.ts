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
  | { type: 'attach_error'; id: string; error: string };

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
  | { type: 'suggestion_card'; agentId: string; agentName: string; role?: string; urgency: string; state: string; action: string }
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
    | 'directive_proposed' | 'attached' | 'ended' | 'error' | 'snapshot'
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
  attached: number;
  ended: number;
  error: number;
  snapshot: number;
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
