// Compact, model-agnostic token formatter for the per-session + fleet usage
// surfaces (WARDEN-367). Rule (from the ticket): <1k shown raw, <1M in k, else M.
// A token count under a thousand is the most precise and rare enough to spell out;
// the compact k/M tiers keep a multi-million-token fleet summary legible.
// 0 / null / undefined / non-finite → '' so a no-usage row renders no badge at all
// (the graceful-empty contract: never a misleading "0 tok").
//
// One decimal below 10 of the unit (e.g. 1.2M, 12.3k) then drops to whole (12k,
// 23M) — enough resolution to compare sessions without noisy trailing zeros.
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${compact1(n / 1000)}k tok`;
  return `${compact1(n / 1_000_000)}M tok`;
}

// Round to one decimal and drop a trailing ".0" (12.0 → "12", 12.3 → "12.3").
// String() on the rounded number does exactly this without regex stripping.
function compact1(x: number): string {
  return String(Math.round(x * 10) / 10);
}
