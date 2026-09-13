/**
 * Non-colliding "(copy)"-suffix name synthesis for the Duplicate affordance on
 * the Settings rows (WARDEN-1359), extracted from `duplicatePattern`
 * (PatternsSection, WARDEN-898) so all three sibling handlers share one tested
 * loop instead of a second and third hand-copy — the same vein
 * validateEntryName (WARDEN-1111) and draftCommit (WARDEN-1219) already mined.
 *
 * The first free name is `"<source> (copy)"`, then `"<source> (copy 2)"`,
 * `"<source> (copy 3)"`, … The base is truncated to `max - suffix.length` so a
 * source name already at the name cap cannot overflow it once suffixed — a
 * name the load-time sanitizer would silently drop on the next reload is
 * exactly the class of copy this must never produce.
 *
 * Termination: every candidate is ≤ `max` chars and non-empty-suffix, so the
 * caller's predicate is consulted only on the 'duplicate' axis (a suffixed
 * copy is never 'empty' or 'reserved' — the suffix breaks both — and cannot be
 * 'too-long'); a finite list yields finitely many collisions, so the loop
 * always lands on a free name.
 *
 * Pure and dependency-free so it is unit-tested directly (copyName.test.mjs) —
 * there is no React test runner in this repo.
 */
export function nonCollidingCopyName(
  sourceName: string,
  isTaken: (candidate: string) => boolean,
  max: number,
): string {
  const makeName = (n: number): string => {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const base = sourceName.slice(0, max - suffix.length);
    return `${base}${suffix}`;
  };
  let n = 1;
  let name = makeName(n);
  while (isTaken(name)) {
    n++;
    name = makeName(n);
  }
  return name;
}
