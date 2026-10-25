// Fleet Health's per-agent status-chip layer, extracted verbatim from
// HealthDashboard.tsx (WARDEN-1937 — first decomposition slice of that file):
// the five chip helpers plus the nine per-agent chips, each with its original
// doc comment intact. The ONLY deltas from the origin are this import header,
// the `export` keywords on the moved symbols, and the HEALTH_SECTION_ORDER
// mirror below. HealthDashboard imports the chips and healthRank back from
// here; the summary bar, renderAgent, group renderers and menus are
// deliberately NOT part of this module.
import { StatusDot, type StatusTone } from '@/components/StatusDot';
import { DiffStatChip } from '../sidebar/DiffStatChip';
import { formatTokens } from '@/lib/formatTokens';
import {
  HealthState,
  HEALTH_STATES,
  getHealthIcon,
  formatHealthState,
  resourceTone,
  type HealthStateValue,
} from '@/lib/healthUtils';
import type { Chat } from '@/lib/types';
import type { FleetGitStatusSlice } from '@/lib/gitStateSummary';

// healthRank ranks states by the canonical section display order. HealthDashboard
// keeps its own HEALTH_SECTION_ORDER alias (same one-line derivation) for its own
// section walks; this module is a leaf — HealthDashboard imports from it — so it
// cannot import that alias back. Both derive from the SAME source (healthUtils'
// HEALTH_STATES), so the two aliases cannot drift.
const HEALTH_SECTION_ORDER = HEALTH_STATES;

// Compact "used" portion of a docker-stats MemUsage string like
// "310.2MiB / 2GiB" → "310.2MiB" (everything before the first ' / '). Returns ''
// when there's nothing to show, including docker's `--` placeholder (emitted for
// a container too new to have a sample) so a fresh container renders no chip
// rather than a confusing `--`. (WARDEN-309)
export function memUsedShort(memUsage?: string): string {
  if (!memUsage) return '';
  const used = memUsage.split('/')[0].trim();
  if (!used || /^[-\s]*$/.test(used)) return '';
  return used;
}

// resourceTone() moved to healthUtils (WARDEN-361) so the single band definition
// also colors the per-host aggregate load line (renderHostLoad) and the ＋ new-chat
// picker annotation. Elevated = CPU OR mem ≥ 80 (amber); ≥ 90 (red). (WARDEN-309)

// Inline chip label: "42% · 310.2MiB" (rounded CPU% · used memory). Each part is
// included only when present, so a chat with only cpuPct still renders "42%".
// (WARDEN-309)
export function resourceLabel(agent: Chat): string {
  const parts: string[] = [];
  if (agent.cpuPct != null) parts.push(`${Math.round(agent.cpuPct)}%`);
  const used = memUsedShort(agent.memUsage);
  if (used) parts.push(used);
  return parts.join(' · ');
}

// Full tooltip text for the resource chip: precise CPU%, mem%, and the raw
// used / total string. (WARDEN-309)
export function resourceTitle(agent: Chat): string {
  const parts: string[] = [];
  if (agent.cpuPct != null) parts.push(`CPU ${agent.cpuPct.toFixed(1)}%`);
  if (agent.memPct != null) parts.push(`Mem ${agent.memPct.toFixed(1)}%`);
  if (agent.memUsage) parts.push(agent.memUsage);
  return parts.join(' · ');
}

// Rank a health state by its display order (healthy → unknown). Used to keep a
// host's agents in the same health-dot order the health-state view uses.
export function healthRank(state: HealthStateValue): number {
  const i = HEALTH_SECTION_ORDER.indexOf(state);
  return i === -1 ? HEALTH_SECTION_ORDER.length : i;
}

/** Map a health state to a StatusDot color family. */
export function healthTone(state: HealthStateValue): StatusTone {
  switch (state) {
    case HealthState.HEALTHY:
      return 'green';
    case HealthState.WARNING:
      return 'yellow';
    case HealthState.CRITICAL:
      return 'red';
    case HealthState.IDLE:
      return 'gray';
    case HealthState.CLOSED:
      // Same gray family as idle; the distinct glyph (■ vs ○) carries the
      // state under grayscale / CVD (WCAG 1.4.1). (WARDEN-245)
      return 'gray';
    default:
      return 'muted';
  }
}

/**
 * Health status indicator — pairs the health color with a distinct per-state
 * glyph (from getHealthIcon) plus an accessible name, so health state survives
 * grayscale / color-vision deficiency and is announced by screen readers.
 */
export function HealthDot({ state }: { state: HealthStateValue }) {
  return (
    <StatusDot
      variant="glyph"
      glyph={getHealthIcon(state)}
      tone={healthTone(state)}
      label={formatHealthState(state)}
    />
  );
}

/**
 * Per-agent resource chip (CPU% · memory used) from `docker stats` (WARDEN-309).
 * Rendered ONLY when the chat carries a resource field — i.e. a yatfa docker
 * agent on a host whose `docker stats` succeeded. Bare-tmux/manual agents and
 * hosts whose stats failed render nothing (graceful N/A). Elevated usage
 * (CPU or mem ≥ 80%) is amber/red so a runaway is visible at a glance in a
 * 50-row fleet. `tabular-nums` keeps the digits equal-width so the chip doesn't
 * jitter as the numbers tick on refresh.
 */
export function ResourceChip({ agent }: { agent: Chat }) {
  const label = resourceLabel(agent);
  if (!label) return null;
  return (
    <span
      className={`text-[10px] tabular-nums ${resourceTone(agent.cpuPct, agent.memPct)}`}
      title={resourceTitle(agent)}
    >
      {label}
    </span>
  );
}

/**
 * Per-agent token spend (WARDEN-466): the lifetime total of the budget session
 * this chat joined to, surfaced beside CPU/mem so the cost dimension lives at the
 * SAME surface as the kill button. A runaway that is cheap on CPU but burning
 * tokens is now visible at the moment the human decides to stop it.
 *
 * Mirrors the proven per-session chip in OpenChatBrowserPage exactly
 * (text-[10px] text-amber-500/80 tabular-nums + formatTokens) so cost reads in
 * the same color vocabulary everywhere it appears (WARDEN-68 — reuse, no new
 * styling). Rendered ONLY when the chat carries a joined tokenUsage — budget off,
 * no usage, or no cwd+host match render nothing, identical graceful-N/A to a
 * missing CPU/mem field. The number is model-agnostic tokens (dollar cost is out
 * of scope). `tabular-nums` keeps the digits steady as the total ticks.
 *
 * Join limitation (path A, noted in the tooltip): the total comes from a budget
 * session matched by cwd+host (NOT id — a chat id is a container/tmux key, never
 * the claude uuid). A fleet running multiple roles for one repo on one host
 * shares cwd+host, so this may show the heaviest role's spend against a sibling —
 * stale-but-plausible, pure observability, never a mutation.
 */
export function TokenChip({ agent }: { agent: Chat }) {
  const label = formatTokens(agent.tokenUsage?.total);
  if (!label) return null;
  return (
    <span
      className="text-[10px] text-amber-500/80 shrink-0 tabular-nums"
      title={`Token spend (lifetime total of the budget session this agent joined): ${label}. Matched by cwd + host — multiple roles on one repo/host may share this number (heaviest shown).`}
    >
      {label}
    </span>
  );
}

/**
 * Per-agent uncommitted-WIP chip (WARDEN-766): the fanned /api/git-status dirty
 * signal + ±N magnitude for THIS agent, surfaced in the row so a coordinator sees
 * which agents hold uncommitted work WITHOUT leaving Fleet Health for the sidebar.
 *
 * Renders the +N −M chip ONLY when the fanned status reports `clean === false`. The
 * magnitude comes from the SAME `diffstat` field /api/git-status serves and the
 * sidebar's per-row DiffStatChip renders, so this REUSES DiffStatChip verbatim (no
 * new glyph/color vocabulary — WARDEN-68). DiffStatChip itself returns null for a
 * null/+0−0 diffstat; a dirty agent with an all-untracked WIP (no tracked edits) thus
 * shows nothing here — never a misleading +0 −0 — while the summary bar's dirtyCount
 * still counts it (clean === false), so the agent is surfaced at the fleet level
 * even when its row carries no magnitude. The `hasMagnitude` pre-check mirrors that
 * guard so the titled wrapper renders ONLY when there is a chip to hover (no empty
 * titled span for an all-untracked dirty agent).
 *
 * `status` absent (still loading / not eligible / unreachable) → renders nothing,
 * the same graceful-N/A contract ResourceChip / TokenChip follow.
 */
export function WipChip({ status }: { status?: FleetGitStatusSlice | null }) {
  if (!status || status.clean !== false) return null;
  const ins = status.diffstat?.insertions ?? 0;
  const del = status.diffstat?.deletions ?? 0;
  // Mirror DiffStatChip's own +0−0/null guard so the titled wrapper exists ONLY when
  // the chip renders — a dirty-but-all-untracked agent shows nothing (the summary-bar
  // count still carries it).
  if (ins === 0 && del === 0) return null;
  return (
    <span
      className="shrink-0 tabular-nums"
      title={`uncommitted working-tree WIP — +${ins} −${del} (insertions/deletions vs HEAD)`}
    >
      <DiffStatChip diffstat={status.diffstat} />
    </span>
  );
}

/**
 * Per-agent merge-conflict chip (WARDEN-796) — the sibling of WipChip for the conflict
 * axis, the highest-severity git state: an agent BLOCKED mid-merge/rebase/cherry-pick
 * with unmerged paths (porcelain DD/AU/UD/UA/DU/AA/UU). WARDEN-766 shipped the dirty
 * axis (WipChip); this is the natural next axis — "which agent is stuck and needs
 * attention NOW," the one state dirty alone cannot speak to.
 *
 * Renders the sidebar's rose ⚑ + "N unmerged" vocabulary VERBATIM (no new glyph/color
 * system — WARDEN-68): the atRisk ⚑ treatment established by WARDEN-701
 * (GitBadges.tsx:282-283 → glyph '⚑', `text-rose-400 hover:text-rose-300`) + the
 * conflict suffix's "N unmerged" magnitude (GitBadges.tsx:294 →
 * ` · merge conflict · ${conflictCount} unmerged`). The "merge conflict" label is
 * replicated as a literal here (AT_RISK_REASON_LABEL is a non-exported sidebar-internal
 * const typed against ProjectGitAgent; coupling Fleet Health to it for one string is
 * worse than citing the source) — same decoupling call WARDEN-766 made reusing the
 * DiffStatChip component rather than a label.
 *
 * Renders ONLY when status.conflictCount > 0 — absent (loading / not eligible /
 * unreachable) or a clean/no-conflict agent → nothing, the same graceful-N/A contract
 * WipChip / ResourceChip / TokenChip follow. `tabular-nums` mirrors WipChip so the two
 * chips' digit widths align when both render (a mid-merge repo is dirty too).
 */
export function ConflictChip({ status }: { status?: FleetGitStatusSlice | null }) {
  if (!status || status.conflictCount <= 0) return null;
  const n = status.conflictCount;
  return (
    <span
      className="shrink-0 tabular-nums text-rose-400 hover:text-rose-300"
      title={`merge conflict — ${n} unmerged path${n === 1 ? '' : 's'} (blocked mid-merge/rebase/cherry-pick; needs resolution)`}
    >
      ⚑ {n} unmerged
    </span>
  );
}

/**
 * Per-agent behind-upstream chip (WARDEN-815) — the sibling of WipChip / ConflictChip
 * for the staleness axis: an agent whose HEAD is BEHIND its upstream (a sibling pushed
 * and this agent hasn't pulled). WARDEN-766 shipped the dirty axis (WipChip), WARDEN-796
 * the conflict axis (ConflictChip); this is the coordination signal that rots silently
 * in a multi-agent fleet — when agent A pushes to main, agents B/C/D are now behind and
 * don't know it, so their next commits land on an outdated base and diverge. This lets a
 * coordinator see who is running on stale code WITHOUT leaving Fleet Health for the
 * sidebar's per-project ↓N chip (WARDEN-297) — the same detour 766/796 eliminated for
 * the dirty/conflict axes.
 *
 * Renders the sidebar's blue ↓ vocabulary VERBATIM (no new glyph/color system —
 * WARDEN-68): the behind treatment established by WARDEN-297 (GitBadges.tsx:280 →
 * glyph '↓', `text-blue-400 hover:text-blue-300`) — the symmetric counterpart to
 * unpushed amber ↑N. `↓` (not "behind") keeps Fleet Health and the sidebar speaking the
 * same vocabulary, the same fleet/row agreement 766/796 already establish.
 *
 * Renders ONLY when status.behind > 0 — absent (loading / not eligible / unreachable),
 * a fresh agent (behind 0), or a non-git / no-branch / no-upstream cwd (behind null,
 * the same null-is-quiet discipline `clean` follows) → nothing, the same graceful-N/A
 * contract WipChip / ConflictChip / ResourceChip / TokenChip follow. `tabular-nums`
 * mirrors WipChip / ConflictChip so the chips' digit widths align when several render
 * (a behind agent is often dirty too).
 */
export function BehindChip({ status }: { status?: FleetGitStatusSlice | null }) {
  if (!status || !status.behind || status.behind <= 0) return null;
  const n = status.behind;
  return (
    <span
      className="shrink-0 tabular-nums text-blue-400 hover:text-blue-300"
      title={`${n} commit${n === 1 ? '' : 's'} behind upstream (stale — pulling re-syncs before further edits diverge)`}
    >
      ↓ {n}
    </span>
  );
}

/**
 * Per-agent unpushed-commit chip (WARDEN-822) — the sibling of WipChip / ConflictChip
 * for the ahead axis, surfacing the one git state clean cannot speak to: an agent that
 * committed N times and never pushed has clean === true AND dirtyCount === 0, so it is
 * indistinguishable from an agent fully in sync with upstream — its FINISHED work is
 * stranded locally and invisible to every other agent pulling from shared upstream.
 * WARDEN-766 (dirty ±N) and WARDEN-796 (conflict ⚑) shipped the axes clean CAN speak
 * to; this is the natural next axis — "who has work no one else can see yet?", the
 * silent coordination rot the dashboard exists to surface.
 *
 * Renders the sidebar's amber ↑N vocabulary VERBATIM (no new glyph/color system —
 * WARDEN-68): the unpushed treatment established at GitBadges.tsx:1472 (glyph '↑',
 * `text-amber-400`) — the SAME fleet/row agreement 766/796 establish (Fleet Health and
 * the sidebar speak one vocabulary). The per-agent count (status.ahead) drives the
 * chip's magnitude; the fleet-wide count of stranded AGENTS (fleetGit.aheadCount, the
 * mirror of dirtyCount/conflictCount) drives the summary tally.
 *
 * Renders ONLY when status.ahead > 0 — absent (loading / not eligible / unreachable),
 * a non-git / detached / no-upstream cwd (ahead: null), or an in-sync agent (ahead: 0)
 * → nothing, the same graceful-N/A contract WipChip / ConflictChip / ResourceChip /
 * TokenChip follow. `tabular-nums` mirrors WipChip / ConflictChip so the chips' digit
 * widths align when several render together (an unpushed agent is often dirty too).
 */
export function UnpushedChip({ status }: { status?: FleetGitStatusSlice | null }) {
  if (!status || !status.ahead || status.ahead <= 0) return null;
  const n = status.ahead;
  return (
    <span
      className="shrink-0 tabular-nums text-amber-400 hover:text-amber-300"
      title={`${n} commit${n === 1 ? '' : 's'} unpushed to upstream (stranded locally — pulling/re-syncing elsewhere won't see this work yet)`}
    >
      ↑ {n}
    </span>
  );
}

/**
 * Per-agent stalled-HEAD chip (WARDEN-847) — the sibling of WipChip / ConflictChip /
 * BehindChip / UnpushedChip for the sole RECENCY axis: an agent whose last commit is
 * >7d old. dirty/conflict/behind/unpushed are all STATE axes ("what IS the repo right
 * now"); stalled answers "WHEN did this agent last commit?" — the signal for a silently
 * stalled / abandoned / rotting agent. This is the canonical blind spot the chip exists
 * for: an agent that is clean (no WIP), conflict-free, in sync with upstream, AND fully
 * pushed reads ZERO across every existing Fleet Health axis, so WITHOUT this chip it is
 * indistinguishable from a healthy agent — yet its HEAD has gone quiet for >7d and the
 * work may be stalled or forgotten. This closes Fleet Health's parity gap with the
 * sidebar's git-state system (5 of the sidebar's 6 axes now surfaced per-row).
 *
 * Renders the sidebar's sky 💤 vocabulary VERBATIM (no new glyph/color system —
 * WARDEN-68): the stalled treatment established by WARDEN-682
 * (GitBadges.tsx:329-331 → glyph '💤', `text-sky-400 hover:text-sky-300`, label
 * 'stalled (>7d)') — the SAME fleet/row agreement 766/796/815/822 establish (Fleet
 * Health and the sidebar speak one vocabulary). The 💤 glyph + sky hue are EACH distinct
 * from every existing Fleet Health chip (± yellow / ⚑ rose / ↓ blue / ↑ amber) — no
 * collision on hue OR glyph. The per-agent stalled boolean (status.stalled, derived in
 * buildFleetGitStatus from headDate + the threaded now against the shared
 * STALE_HEAD_AGE_MS 7d threshold — the SAME threshold summarizeProjectGitState uses, so
 * fleet and sidebar agree on exactly who is stalled) drives the chip; the fleet-wide
 * count of stalled AGENTS (fleetGit.stalledCount, the mirror of dirtyCount/conflictCount/
 * behindCount/aheadCount) drives the summary tally.
 *
 * Renders ONLY when status.stalled === true — absent (loading / not eligible /
 * unreachable), an ok agent whose headDate is missing/invalid/empty (a repo with no
 * commits / non-git cwd — Date.parse → NaN → headAgeMs null → not stalled), or a fresh
 * agent (HEAD ≤7d old) → nothing, the same null-is-quiet + graceful-N/A contract the
 * sibling chips / ResourceChip / TokenChip follow. The fleet/row agreement (WARDEN-682)
 * rides on this shared 7d threshold — the row and the chip agree on exactly who is
 * stalled, never differing by a day.
 */
export function StalledChip({ status }: { status?: FleetGitStatusSlice | null }) {
  if (!status || status.stalled !== true) return null;
  return (
    <span
      className="shrink-0 tabular-nums text-sky-400 hover:text-sky-300"
      title="stalled (>7d) — last commit is >7d old (the agent may be silently stalled, abandoned, or rotting; fanned /api/git-status)"
    >
      💤
    </span>
  );
}

/**
 * Per-agent parked-WIP chip (WARDEN-871) — the sibling of WipChip / ConflictChip /
 * BehindChip / UnpushedChip / StalledChip for the parked-WIP axis: an agent holding
 * `git stash`-shelved work. dirty/conflict/behind/unpushed/stalled are all STATE or
 * RECENCY axes porcelain status can speak to; stash answers "did this agent SHELVE work
 * off-tree?" — the signal for easily-forgotten, drift-prone parked WIP. This is the
 * canonical blind spot the chip exists for: an agent that stashed its WIP has a clean
 * tree (clean === true), no conflicts, in sync, fully pushed, AND a fresh HEAD, so it
 * reads ZERO across every existing Fleet Health axis — WITHOUT this chip it is
 * indistinguishable from a healthy agent, yet it holds shelved work nothing else can
 * see. This closes Fleet Health's LAST parity gap with the sidebar's git-state system
 * (all 6 of the sidebar's axes now surfaced per-row).
 *
 * Renders the sidebar's fuchsia 🗄 vocabulary VERBATIM (no new glyph/color system —
 * WARDEN-68): the parked-WIP treatment established by WARDEN-667/689
 * (GitBadges.tsx:306-308 → glyph '🗄', `text-fuchsia-400 hover:text-fuchsia-300`, label
 * 'stashed WIP') — the SAME fleet/row agreement 766/796/815/822/847 establish (Fleet
 * Health and the sidebar speak one vocabulary). The 🗄 glyph + fuchsia hue are EACH
 * distinct from every existing Fleet Health chip (± yellow / ⚑ rose / ↓ blue / ↑ amber
 * / 💤 sky) — no collision on hue OR glyph. The per-agent stash magnitude
 * (status.stashCount, the pure pass-through of /api/git-status's top-level stashCount,
 * parsed from `git stash list` line count — null for a non-git / no-branch cwd, 0 for a
 * stash-free tree) drives the chip's "N"; the fleet-wide count of stashed AGENTS
 * (fleetGit.stashedCount, the mirror of dirtyCount/conflictCount/behindCount/aheadCount/
 * stalledCount) drives the summary tally.
 *
 * Renders ONLY when status.stashCount > 0 — absent (loading / not eligible / unreachable),
 * a non-git / no-branch cwd (stashCount: null), or a stash-free agent (stashCount: 0)
 * → nothing, the same null-is-quiet + graceful-N/A contract the sibling chips /
 * ResourceChip / TokenChip follow. `tabular-nums` mirrors WipChip / ConflictChip /
 * UnpushedChip so the chips' digit widths align when several render together (a stashed
 * agent is often clean too, so 🗄N may render alone where every state chip is absent).
 */
export function StashChip({ status }: { status?: FleetGitStatusSlice | null }) {
  if (!status || !status.stashCount || status.stashCount <= 0) return null;
  const n = status.stashCount;
  return (
    <span
      className="shrink-0 tabular-nums text-fuchsia-400 hover:text-fuchsia-300"
      title={`${n} parked stash${n === 1 ? '' : 'es'} — uncommitted work stashed off-tree via git stash (easily forgotten / drift-prone; fanned /api/git-status)`}
    >
      🗄 {n}
    </span>
  );
}
