// Telemetry chat-name provenance rule for the renderer's `telemetry:set-context`
// push (WARDEN-1554, the second sink after WARDEN-1550's buildNamesSnapshot).
//
// POST /api/resume spawns a chat with `session = resume-<first 8 chars of sid>`
// and `name` = the owner's FIRST PROMPT (verbatim conversation text, ≤80 chars).
// Pushed raw as `chatName`, that text would decorate every error / crash /
// stall event when the `names` category is on. Only the renderer holds both
// `name` and `session`, so the rule lives here. It MIRRORS
// src/workspaceNamesTelemetry.js (same regex, same label, same
// `name !== session` condition) — web/telemetryChatName.test.mjs pins the
// parity so the two cannot drift. Fail closed: when in doubt, strip more.

import type { Chat } from './types';

export const RESUME_SESSION_RE = /^resume-[\w-]{1,8}$/;

// The constant stand-in a resume-spawned chat contributes instead of its text.
export const RESUMED_SESSION_LABEL = 'resumed-session';

// The constant stand-in for the chat's OWN SSH host alias inside its name
// (WARDEN-1564). Mirrors HOST_LABEL / stripOwnHost in
// src/workspaceNamesTelemetry.js — telemetryChatName.test.mjs pins the parity.
export const HOST_LABEL = '<host>';

const LOCAL_HOST = '(local)';

/** Replace standalone, case-insensitive occurrences of `host` in `name` with HOST_LABEL. */
export function stripOwnHost(name: string, host: unknown): string {
  if (typeof host !== 'string' || host.trim().length === 0 || host === LOCAL_HOST) return name;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'gi'), HOST_LABEL);
}

/**
 * The chat name that may be pushed to the telemetry source.
 * `undefined` for no chat / empty or non-string name; RESUMED_SESSION_LABEL for
 * a resume-spawned chat whose name differs from its session; else `chat.name`
 * with the chat's own host alias replaced by HOST_LABEL.
 */
export function telemetryChatName(
  chat: Pick<Chat, 'name' | 'session' | 'host'> | null | undefined,
): string | undefined {
  const name: unknown = chat && typeof chat === 'object' ? chat.name : undefined;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const session: unknown = chat!.session;
  if (typeof session === 'string' && RESUME_SESSION_RE.test(session) && name !== session) {
    return RESUMED_SESSION_LABEL;
  }
  return stripOwnHost(name, chat!.host);
}
