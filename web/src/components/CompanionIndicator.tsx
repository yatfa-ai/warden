import { StatusDot, type StatusTone } from '@/components/StatusDot';
import type { CompanionStatus } from '@/lib/healthUtils';

/**
 * CompanionIndicator — the per-host companion transport state dot, with (when
 * the host has op tallies) a compact visible activity suffix. (WARDEN-878 state,
 * WARDEN-1312 activity.)
 *
 * Layout contract — the suffix must NEVER be able to displace the host name.
 *
 * This component renders inside the Fleet Health host row's line 1, a flex row
 * whose only shrinkable element is the hostname (`flex-1 min-w-0 truncate`);
 * every other row element is `shrink-0`. The first cut of the ops suffix was an
 * unconstrained `inline-flex` wrapper + long text, which won the flex line and
 * collapsed the hostname to 0px at every realistic panel width (measured 300 /
 * 312 / 360 / 420px; recovered only ~520px) and wrapped the row to a second
 * line. Three constraints here make that structurally impossible again:
 *
 *  1. the visible suffix is the SHORT form ("60 ops") — the per-method
 *     breakdown and the failure count live in the StatusDot accessible
 *     label/title, so truncating the visible text loses nothing (WCAG 1.4.1
 *     is about the dot's state, which the required label still carries in
 *     full);
 *  2. the wrapper carries `min-w-0` so the host row can always shrink it;
 *  3. the suffix carries `min-w-0 max-w-24 truncate` — bounded at 6rem (96px)
 *     and self-truncating with an ellipsis, never wrapping.
 *
 * Width budget at the panel's real ~300px: indicator worst case = dot (8px) +
 * gap (4px) + capped suffix (96px) = 108px, the row's fixed (shrink-0) content
 * is ~160px, so the hostname keeps ≥ ~30px even at the cap — and with the
 * realistic short form ("60 ops" ≈ 35px) it keeps ~170px. The pin check
 * (companionIndicator.test.mjs) renders the real component and asserts this
 * class contract and the short-form text; do not loosen them without
 * re-measuring the row in a browser.
 *
 * Renders ONLY for active/bootstrapping/error. `inactive` (LOCAL, or a host no
 * companion op has engaged yet) renders nothing — the indicator appears ONLY when
 * there is actionable state to read, so a healthy fleet isn't blanketed in gray
 * dots. The `companion` field is itself absent entirely when the transport is
 * disabled (the server omits it), so a toggle-off fleet shows no indicators.
 *
 * Reuses the themed StatusDot primitive (WARDEN-68 Rule 3): the connectivity
 * dot's green-solid / red-square vocabulary transfers directly — active is the
 * "working" green solid, error the "bad" red square, and bootstrapping gets the
 * pulse variant (its literal meaning: an in-flight connection).
 */

/** Full activity summary for the accessible label, e.g.
 *  "60 ops · unsubscribePanes 15 · discover 13 · exec 13 · 2 failed". */
function companionOpsSummary(ops: CompanionStatus['ops']): string | null {
  if (!ops) return null;
  const entries = Object.entries(ops);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, t]) => sum + t.n, 0);
  const failed = entries.reduce((sum, [, t]) => sum + t.failures, 0);
  const top = [...entries]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 3)
    .map(([method, t]) => `${method} ${t.n}`)
    .join(' · ');
  return [`${total} op${total === 1 ? '' : 's'}`, top, failed > 0 ? `${failed} failed` : null]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** SHORT visible suffix — the total alone ("60 ops"). The per-method breakdown
 *  and failure count stay in the accessible label (see layout contract above). */
function companionOpsShort(ops: CompanionStatus['ops']): string | null {
  if (!ops) return null;
  const entries = Object.entries(ops);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, t]) => sum + t.n, 0);
  return `${total} op${total === 1 ? '' : 's'}`;
}

export function CompanionIndicator({ companion }: { companion?: CompanionStatus }) {
  if (!companion || companion.state === 'inactive') return null;
  const tone: StatusTone = companion.state === 'active' ? 'green'
    : companion.state === 'bootstrapping' ? 'yellow'
    : 'red'; // error
  const variant = companion.state === 'active' ? 'solid'
    : companion.state === 'bootstrapping' ? 'pulse'
    : 'square'; // error
  const opsSummary = companionOpsSummary(companion.ops);
  const opsShort = companionOpsShort(companion.ops);
  const label = (companion.state === 'active'
    ? `Companion active${companion.version ? ` (v${companion.version})` : ''}`
    : companion.state === 'bootstrapping'
      ? 'Companion bootstrapping'
      : `Companion error${companion.lastError ? `: ${companion.lastError}` : ''}`)
    + (opsSummary ? ` — ${opsSummary}` : '');
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <StatusDot
        tone={tone}
        variant={variant}
        label={label}
        title={label}
      />
      {opsShort && (
        <span className="text-[10px] text-muted-foreground min-w-0 max-w-24 truncate">
          {opsShort}
        </span>
      )}
    </span>
  );
}
