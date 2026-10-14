import type { CompanionStatus } from './healthUtils';

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

export const EXCLUDED_LABEL = 'Companion excluded for this host by the "Companion excluded hosts" setting (Settings → Performance) — operations here ride the default SSH path';

/**
 * The indicator's full status text — exactly what the StatusDot carries as its
 * accessible label / hover title (WARDEN-1806: hoisted so the Fleet Health host
 * header menu can copy the same string). Returns null in exactly the cases the
 * component renders nothing (absent companion, plain/unknown-reason inactive).
 */
export function companionStatusText(companion?: CompanionStatus): string | null {
  if (!companion) return null;
  if (companion.state === 'inactive') {
    return companion.reason === 'excluded-by-setting' ? EXCLUDED_LABEL : null;
  }
  const opsSummary = companionOpsSummary(companion.ops);
  return (companion.state === 'active'
    ? `Companion active${companion.version ? ` (v${companion.version})` : ''}`
    : companion.state === 'bootstrapping'
      ? 'Companion bootstrapping'
      : `Companion error${companion.lastError ? `: ${companion.lastError}` : ''}`)
    + (opsSummary ? ` — ${opsSummary}` : '');
}
