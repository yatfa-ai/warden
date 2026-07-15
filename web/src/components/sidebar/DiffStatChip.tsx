// The `+N −M` magnitude chip, extracted as a leaf so it can be shared by both the
// sidebar badge (GitBadges.tsx) and the general-purpose DiffViewer modal without
// dragging the whole GitBadges module (and its circular DiffViewer import) along.
// Co-located with the DiffStat type it consumes (WARDEN-449).

import { cn } from '@/lib/utils';
import type { DiffStat } from './types';

/**
 * A compact `+N −M` magnitude chip for an agent's uncommitted working-tree edits
 * (insertions/deletions from `git diff HEAD --shortstat`). Renders NOTHING for a
 * clean tree or an all-untracked WIP: `--shortstat` counts TRACKED (staged +
 * unstaged) edits only, so a purely-untracked WIP yields +0−0 which would read as
 * "nothing changed" (a lie) — untracked adds keep speaking through the existing
 * file count. Reuses the badge's green-add / red-del color language (WARDEN-411).
 */
export function DiffStatChip({ diffstat, className }: { diffstat?: DiffStat | null; className?: string }) {
  if (!diffstat) return null;
  // The all-untracked guard: no tracked edits → render nothing, not +0−0.
  if (diffstat.insertions === 0 && diffstat.deletions === 0) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-[10px]', className)}>
      <span className="text-green-400">+{diffstat.insertions}</span>
      <span className="text-red-400">−{diffstat.deletions}</span>
    </span>
  );
}
