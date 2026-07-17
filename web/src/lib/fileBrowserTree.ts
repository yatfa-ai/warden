// Pure tree logic for the read-only file browser (WARDEN-573).
//
// Kept UI-free (no React, no shadcn, no lucide) so it lives in src/lib and can
// be unit-tested directly via the OXC-transform pattern the other lib tests use
// (see web/fileBrowser.test.mjs). FileBrowserDialog.tsx imports these and adds
// the fetch + render; the *decision* behind a directory click lives here so the
// WARDEN-573 subdir-expansion regression ("first click of a subdir did nothing")
// is asserted against the real function, not a render.

export interface Entry {
  name: string;
  type: 'file' | 'dir';
}

// One loaded directory in the tree, keyed by its cwd-relative path ('' = root).
// Owns its lazy listing + expand state, so expanding a dir never reloads its
// siblings and each dir is fetched at most once per dialog-open.
export interface DirState {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  entries: Entry[];
  expanded: boolean;
}

export const EMPTY_DIR: DirState = {
  loaded: false,
  loading: false,
  error: null,
  entries: [],
  expanded: false,
};

// Join a cwd-relative dir + entry name into the path both the API (dir=) and the
// FileViewer (filePath=) expect. A leading/trailing slash would break the
// containment rule / double up, so it is normalized here in one place.
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// Pure decision behind a directory row click (WARDEN-573). Takes the current
// tree + the toggled dir, returns the next tree and whether the dir needs to be
// fetched. Side-effect-free so the expansion decision is unit-tested directly.
//
// WHY THIS IS EXTRACTED: the WARDEN-573 review caught a one-line bug where the
// inline toggle read `tree[dir]` and bailed on a missing node — but a subdir is
// NEVER a tree key until first toggled (root is the only node the open-effect
// seeds; child dirs live only as entries inside their parent). So the very first
// click of any subdir did nothing: no expand, no fetch, no children. Defaulting a
// missing node to EMPTY_DIR (seed-on-demand) is the fix; lifting it into this
// pure function lets a test assert the outcome ("a subdir expands AND requests
// its children on first click") instead of trusting a render.
export function applyToggle(
  tree: Record<string, DirState>,
  dir: string,
): { tree: Record<string, DirState>; needsFetch: boolean } {
  const node = tree[dir] || EMPTY_DIR;
  if (node.expanded) {
    // Collapse keeps the loaded entries cached (re-expand is instant, no refetch).
    return { tree: { ...tree, [dir]: { ...node, expanded: false } }, needsFetch: false };
  }
  // Expand: seed the node open; lazy-load on first expand (a dir that has never
  // been loaded still needs its entries fetched).
  return { tree: { ...tree, [dir]: { ...node, expanded: true } }, needsFetch: !node.loaded };
}
