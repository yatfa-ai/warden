// Transcript-phase detection (mid-turn vs awaiting-input): moved verbatim out of
// observer.js (WARDEN-1964). observer.js re-exports the public names, so every
// existing importer of './observer.js' is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shellQuote } from './ssh.js';
// companion.js is a leaf sibling (it imports ssh.js/chatMeta.js/loop-monitor.js,
// never observer.js or this module) — no import cycle.
import { deliverRemoteScript } from './companion.js';

const fsp = fs.promises;

const LOCAL = '(local)';

// ---- transcript phase detection (mid-turn vs awaiting-input) ----
//
// classifyPane already returns idle / erroring / stuck / blocked / waiting /
// active — reused as-is, no new patterns. The extra signal here is the Claude
// Code transcript phase: a turn is 'mid-turn' until it ends, then
// 'awaiting-input' (the agent finished and is waiting for the next prompt). It
// is recorded in the change-aware cache so read_chats
// changed_only can detect progress. (WARDEN-509 removed the on-demand
// alert_changes derivation that turned a mid-turn → awaiting-input flip into a
// "completed" alert; "who finished" / "where am I needed" is now surfaced by the
// deterministic AttentionBadge + per-chat watch, which read pane state directly.)

// Transcript entry types that carry no conversational signal — skipped when
// locating the "last real" entry (per WARDEN-166 spec).
const TRANSCRIPT_METADATA_TYPES = new Set([
  'mode', 'ai-title', 'last-prompt', 'file-history-snapshot',
  'attachment', 'system', 'summary', 'permission-mode',
]);
const STOP_AWAITING_INPUT = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

// Keep only real conversational entries (user / assistant), dropping metadata.
export function filterRealTranscriptEntries(entries) {
  return (entries || []).filter((e) => e && (e.type === 'user' || e.type === 'assistant')
    && !TRANSCRIPT_METADATA_TYPES.has(e.type));
}

// Parse a transcript tail (raw text) into an array of JSON objects, skipping
// unparseable lines. The leading partial line left by `tail -c N` is naturally
// dropped because JSON.parse throws on it.
export function parseTranscriptTail(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial / malformed → skip */ }
  }
  return out;
}

// Determine an agent's turn phase from its transcript entries:
//   'awaiting-input' — last real entry is an assistant message that ended a turn
//                      (stop_reason ∈ {end_turn, stop_sequence, max_tokens}).
//   'mid-turn'       — last real entry is a user message, OR an assistant message
//                      mid-tool-use (stop_reason = 'tool_use'): the turn is ongoing.
//   null             — indeterminate (no real entries, or an assistant line with an
//                      unrecognized stop_reason). A stale mid-turn from a dead agent
//                      never flips to end_turn, so this never false-fires.
export function transcriptPhaseOf(entries) {
  const real = filterRealTranscriptEntries(entries);
  if (!real.length) return null;
  const last = real[real.length - 1];
  const stopReason = last && last.message ? last.message.stop_reason : undefined;
  if (last.type === 'assistant') {
    if (STOP_AWAITING_INPUT.has(stopReason)) return 'awaiting-input';
    if (stopReason === 'tool_use') return 'mid-turn';
    return null;
  }
  return 'mid-turn'; // last real entry is a user message → turn in progress
}

// ---- reading a live agent's transcript tail (the impure part) ----
//
// The completed signal needs the transcript's last assistant stop_reason. The
// history browser already walks ~/.claude/projects/*/*.jsonl, but only on the
// SSH HOST — a yatfa agent's `claude` runs INSIDE its container, so its
// transcript lives at the in-container $HOME/.claude/projects. buildTranscriptTailScript
// is the host/container-portable script that finds the most-recently-modified
// .jsonl and tails it; readTranscriptPhase wraps it for the three chat shapes.

// Shell script: locate the most-recently-modified transcript and tail its last
// 8 KB (plenty for the last assistant message + stop_reason). Emits ___TAIL /
// ___NONE markers parsed by parsePhaseFromTailOutput. Runs on a host or inside a
// container (via docker exec) unchanged — it only touches $HOME/.claude/projects.
export function buildTranscriptTailScript() {
  return [
    'f=$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1)',
    'if [ -n "$f" ]; then',
    "  printf '___TAIL\\n'; tail -c 8192 \"$f\"",
    'else',
    "  printf '___NONE\\n'",
    'fi',
  ].join('\n');
}

// Parse the marked stdout of buildTranscriptTailScript into a phase (or null when
// there is no transcript / the host was unreachable). Pure — fed fake stdout in
// tests exactly like parseSessionReadOutput is (WARDEN-130 testing pattern).
export function parsePhaseFromTailOutput(stdout) {
  const s = String(stdout || '');
  const idx = s.indexOf('___TAIL');
  if (idx < 0) return null; // ___NONE, empty, or host unreachable
  return transcriptPhaseOf(parseTranscriptTail(s.slice(idx + '___TAIL'.length)));
}

// Read the local filesystem's most-recent transcript tail and return it in the
// ___TAIL-marked shape parsePhaseFromTailOutput expects (or '' if none). Uses
// os.homedir(), so a test redirects HOME to a throwaway dir to isolate it.
// Async (WARDEN-1073): this walk stat'd every transcript in the archive with
// synchronous fs on the WS request path — 400+ blocking syscalls per call, once
// per pane, growing monotonically with transcript history. Converted to fsp so
// the syscalls yield the event loop, matching collectLocalSessionFiles in
// claudeSessions.js:134 (the same walk, already async) and the WARDEN-832
// decision of record: no synchronous fs on a runtime/request path. Structure and
// skip/'' semantics are otherwise unchanged.
async function readLocalTranscriptTail() {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  let projects;
  try { projects = await fsp.readdir(dir); } catch { return ''; } // no ~/.claude/projects
  for (const proj of projects) {
    const pdir = path.join(dir, proj);
    try { if (!(await fsp.stat(pdir)).isDirectory()) continue; } catch { continue; }
    for (const f of await fsp.readdir(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(pdir, f);
      try { files.push({ fp, mtime: (await fsp.stat(fp)).mtimeMs }); } catch { /* skip */ }
    }
  }
  if (!files.length) return '';
  files.sort((a, b) => b.mtime - a.mtime);
  const { fp } = files[0];
  const size = (await fsp.stat(fp)).size;
  const len = Math.min(size, 8192);
  const buf = Buffer.alloc(len);
  // try/finally: the handle closes on every path, including a throwing read — a
  // leaked fd on this per-pane path would be worse than the stall being fixed.
  const fh = await fsp.open(fp, 'r');
  try { await fh.read(buf, 0, len, size - len); } finally { await fh.close(); }
  return '___TAIL\n' + buf.toString('utf8');
}

// Read a live agent's transcript phase. Returns 'mid-turn' | 'awaiting-input' |
// null (null = no transcript available → caller falls back to the pane-state
// path). Best-effort: any failure resolves to null so a transcript read can never
// block or break a pane read (WARDEN-89: failures surfaced, never fatal).
//
// WARDEN-1284 (companion transport): both REMOTE branches deliver through
// `deliverRemoteScript`, so under the `companionTransportEnabled` toggle they
// ride the persistent companion channel instead of spawning an un-pooled ssh per
// call. This leg rides the OBSERVER POLL CADENCE — a fleet-wide background
// rhythm repeating the handshake silently across every watched agent — so it is
// the highest-cadence of the nine WARDEN-1284 legs.
//
// ⚠️ CONTAINER-BRANCH PARITY (the one nuance): the default path delivers
// `bash -lc 'docker exec <c> sh -c <script>'` — note `sh -c`, NOT `bash -lc`,
// inside the container. Parity therefore comes from passing that FULL
// pre-assembled string as the script with NO `container` option: routing it
// through `container` would have the companion's host side re-assemble
// `docker exec <c> bash -lc <script>`, silently changing the in-container
// interpreter. The delivered string is pinned in a test either way.
//
// `deps` is the shared routing test seam; the LOCAL branch is untouched.
export async function readTranscriptPhase(chat, cfg = {}, deps = {}) {
  if (!chat) return null;
  try {
    let stdout = '';
    if (chat.container) {
      // yatfa docker agent: claude runs in-container, so reach its transcript via
      // docker exec (no existing code path did this — WARDEN-166 adds it).
      // The FULL docker-exec string rides as the script (container deliberately
      // UNSET) so `sh -c` survives on both transports — see the ⚠️ note above.
      const cmd = `docker exec ${shellQuote(chat.container)} sh -c ${shellQuote(buildTranscriptTailScript())}`;
      const res = await deliverRemoteScript(chat.host, cmd, { timeout: 10000 }, cfg, deps);
      if (!res.ok) return null;
      stdout = res.stdout;
    } else if (chat.host === LOCAL) {
      // bare local tmux 'claude' session: transcript on the local filesystem.
      stdout = await readLocalTranscriptTail();
    } else {
      // bare remote tmux session: transcript on the remote host.
      const res = await deliverRemoteScript(chat.host, buildTranscriptTailScript(), { timeout: 10000 }, cfg, deps);
      if (!res.ok) return null;
      stdout = res.stdout;
    }
    return parsePhaseFromTailOutput(stdout);
  } catch {
    return null;
  }
}
