// WARDEN-1945: /api/search-pane's additive `unsearchedPanes` disclosure — the
// panes whose capture failed and so were NOT searched. The server omits the key
// on a healthy response, so absent/empty/malformed all mean "fully searched".
// Dependency-free so the repo's `node --test` suite can load it directly.

export interface UnsearchedPane {
  key: string;
  host: string;
  name: string;
}

/** Type-guarded read of `data.unsearchedPanes`; anything malformed is dropped. */
export function parseUnsearchedPanes(raw: unknown): UnsearchedPane[] {
  if (!Array.isArray(raw)) return [];
  const out: UnsearchedPane[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key : '';
    const name = typeof o.name === 'string' && o.name ? o.name : key;
    if (!name) continue;
    out.push({ key, name, host: typeof o.host === 'string' ? o.host : '' });
  }
  return out;
}

/** "name@host" per pane (just "name" when the host is unknown). */
export function formatUnsearchedPanes(panes: UnsearchedPane[]): string {
  return panes.map((p) => (p.host ? `${p.name}@${p.host}` : p.name)).join(', ');
}
