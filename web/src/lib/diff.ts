// Classify a unified-diff line for syntax highlighting. Pure (no React) so it can be
// unit-tested directly via node (mirrors the storage.test.mjs pattern). Used by
// DiffViewer to color +added / -removed lines and mute the metadata.
//
// The only mis-coloring trap in a unified diff is the file header pair:
//   +++ b/file.txt   (starts with '+', but is NOT an added line)
//   --- a/file.txt   (starts with '-', but is NOT a removed line)
// These must classify as 'meta', as must the hunk headers and the diff/index banners.

export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context';

export function classifyDiffLine(line: string): DiffLineKind {
  // File/commit metadata banners come first so the leading-char checks below never
  // mis-read a header as an added/removed line.
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('dissimilarity index') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('new file mode') ||
    line.startsWith('Binary files') ||
    line.startsWith('\\ No newline at end of file')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

// Shared palette mapping a DiffLineKind → Tailwind class. Used by BOTH the modal
// working-tree diff viewer (DiffViewer, WARDEN-151) and the inline committed-diff
// block (DiffBlock in ChatSidebar, WARDEN-180) so a file's diff renders identically
// whether it's reached from the changed-files list or from an expanded commit.
// +added green / -removed red, hunk + file headers muted, context slightly dimmed —
// matching the sidebar's status palette so diffs read as part of the same surface.
export const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'text-green-400',
  remove: 'text-red-400',
  hunk: 'text-muted-foreground',
  meta: 'text-muted-foreground',
  context: 'text-foreground/80',
};
