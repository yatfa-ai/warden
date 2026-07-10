/** Render a committed diff as a scrollable, colorized monospace block, reusing the
 *  shared line classifier + palette (classifyDiffLine / DIFF_LINE_CLASS in
 *  @/lib/diff) so a commit's file diff renders identically whether it's reached from
 *  the sidebar's expanded commit (ChatSidebar, WARDEN-180), the FileViewer annotate
 *  inspector (WARDEN-206), or the modal working-tree DiffViewer (WARDEN-151) — same
 *  green/red/muted coloring, no second classifier. */
import { classifyDiffLine, DIFF_LINE_CLASS } from '@/lib/diff';

export function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="mt-0.5 max-h-64 overflow-auto rounded bg-muted/40 p-1 font-mono text-[10px] leading-tight whitespace-pre">
      {diff.split('\n').map((ln, i) => (
        <div key={i} className={DIFF_LINE_CLASS[classifyDiffLine(ln)]}>{ln || ' '}</div>
      ))}
    </pre>
  );
}
