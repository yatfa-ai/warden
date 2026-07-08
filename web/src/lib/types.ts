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
  active?: boolean;
  status?: string;
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
  | { type: 'attach'; id: string; cols: number; rows: number }
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
  | { type: 'history'; name?: string; items: { role: 'user' | 'assistant' | 'tool'; text?: string; name?: string; id?: string }[] }
  | { type: 'session_created'; sid: string; name: string };

export interface SessionMeta {
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
  type: 'directive_proposed' | 'attached' | 'ended' | 'error' | 'snapshot';
  id?: string;
  container?: string;
  host?: string;
  role?: string;
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
