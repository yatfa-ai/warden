/** Render a committed diff as a scrollable, colorized monospace block, reusing the
 *  shared line classifier + palette (classifyDiffLine / DIFF_LINE_CLASS in
 *  @/lib/diff) so a commit's file diff renders identically whether it's reached from
 *  the sidebar's expanded commit (ChatSidebar, WARDEN-180), the FileViewer annotate
 *  inspector (WARDEN-206), or the modal working-tree DiffViewer (WARDEN-151) — same
 *  green/red/muted coloring, no second classifier.
 *
 *  Right-click (WARDEN-1800): a themed menu — Copy diff / Copy added lines / Copy
 *  removed lines — so the on-screen diff is copyable instead of falling through to an
 *  unrelated ancestor menu. Radix's ContextMenu root renders no DOM and `asChild`
 *  merges only handlers, so the <pre> is unchanged. Nesting inside an ancestor
 *  ContextMenuTrigger (ChatRows, dialogs): the innermost trigger wins and ancestors
 *  skip on defaultPrevented (WARDEN-926), so no stopPropagation is needed. */
import { classifyDiffLine, DIFF_LINE_CLASS, addedLinesOf, removedLinesOf } from '@/lib/diff';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';

export function DiffBlock({ diff }: { diff: string }) {
  const added = addedLinesOf(diff);
  const removed = removedLinesOf(diff);
  const hasAdded = diff.split('\n').some(ln => classifyDiffLine(ln) === 'add');
  const hasRemoved = diff.split('\n').some(ln => classifyDiffLine(ln) === 'remove');
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <pre className="mt-0.5 max-h-64 overflow-auto rounded bg-muted/40 p-1 font-mono text-[10px] leading-tight whitespace-pre">
          {diff.split('\n').map((ln, i) => (
            <div key={i} className={DIFF_LINE_CLASS[classifyDiffLine(ln)]}>{ln || ' '}</div>
          ))}
        </pre>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Every copy goes through copyWithToast — never bare navigator.clipboard,
            which fails silently in Electron. */}
        <ContextMenuItem onSelect={() => copyWithToast(diff)}>Copy diff</ContextMenuItem>
        <ContextMenuItem disabled={!hasAdded} onSelect={() => copyWithToast(added)}>Copy added lines</ContextMenuItem>
        <ContextMenuItem disabled={!hasRemoved} onSelect={() => copyWithToast(removed)}>Copy removed lines</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
