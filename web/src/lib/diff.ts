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
