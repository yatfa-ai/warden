// Pure view-state helpers for the FileViewer "Changes" view (WARDEN-786).
//
// The Changes view fetches the open file's uncommitted working-tree diff vs HEAD
// (GET /api/git-diff?id=&path= — no staged/range, so the default worktree-vs-HEAD
// diff) and renders it via DiffBlock. Two pure seams live here so the load-bearing
// decisions have real unit coverage — there is no front-end DOM test runner in
// this repo (see breadcrumbs.test.mjs / collisionCompare.test.mjs), so the
// behavior that a render-only check can't catch is pinned at the pure layer:
//
//   1. classifyChangesView — turns a /api/git-diff response into the render
//      decision (loading / error / untracked / clean / dirty). An untracked file
//      is a CHANGE this view exists to surface (agents create new files
//      constantly), so the backend returns { diff: null, untracked: true } for one
//      — `git diff HEAD -- <untracked>` is empty, so the route disambiguates with
//      `git ls-files --error-unmatch` and returns { diff: null, untracked: true }
//      (src/gitRoutes.js getLocalGitDiff + the delivered /api/git-diff path).
//      untracked MUST render its own state, NEVER "no uncommitted changes": the
//      route's `untracked` flag exists exactly to let the UI say "untracked"
//      instead of "no changes". Only diff null OR '' with untracked=false reaches
//      `clean` (the route returns null for a clean tracked file; `git diff HEAD`
//      can ALSO yield '' — both mean "no uncommitted changes"). A non-null `error`
//      is surfaced, never masked as clean (the endpoint returns 200 with a
//      populated `error` for every soft failure — see ConflictView.tsx:85 /
//      DiffViewer.tsx:96). Ordering mirrors DiffViewer.tsx's
//      loading/error/untracked/empty/dirty branch sequence.
//
//   2. resolveViewToggles — the mutual-exclusivity contract for the toolbar's
//      button-driven alternate views (annotate / history / changes). Turning one
//      ON clears the other two; turning one OFF leaves the others alone. (The
//      at-commit snapshot is a fourth exclusive view, but it carries a commit
//      object, not a bool, and has history-specific clearing asymmetry — handled
//      inline in the component, not here.)
//
// This module is `import`-free at runtime (pure logic, no value imports) so
// Vite's OXC transform emits clean ESM JS and the transpile-to-temp-`.mjs` test
// harness loads the REAL module (not a hand-rolled re-implementation).

// Response shape of GET /api/git-diff?id=&path= (working-tree-vs-HEAD, no
// staged/range). Mirrors the route contract at src/gitRoutes.js (/api/git-diff)
// and the `gitDiff` fixture in collisionCompare.test.mjs: { diff, untracked, error }.
export interface ChangesDiffResponse {
  diff: string | null;
  untracked: boolean;
  error: string | null;
}

// The render decision for the Changes view. `loading` is owned by the component
// (it gates the fetch) but pre-empts the response classification so a stale
// non-null diff from a prior file never flashes before the spinner. `untracked`
// is a distinct state checked BEFORE `clean`: an untracked file is a real change
// (agents create new files constantly), and the endpoint always pairs untracked
// with diff:null (git diff HEAD -- <untracked> is empty), so it must never read
// as the "no uncommitted changes" empty-state.
export type ChangesViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'untracked' }
  | { kind: 'clean' }
  | { kind: 'dirty'; diff: string; untracked: boolean };

// Classify a working-tree-vs-HEAD diff response into the Changes view's render
// decision. Pure so the untracked / clean / dirty / error branches are unit-testable.
//
// Precedence (mirrors DiffViewer.tsx's loading/error/untracked/empty/dirty branch
// order — untracked is checked BEFORE clean):
//   - loading -> spinner (pre-empts everything; a prior file's diff must not show).
//   - error non-null -> surface it (never mask as a clean empty-state).
//   - untracked with no non-empty diff -> untracked: render its own state. This is
//     the real production input for a brand-new file — the endpoint returns
//     { diff: null, untracked: true } (git diff HEAD -- <untracked> is empty, so
//     the route disambiguates with `git ls-files --error-unmatch`). A new file is
//     100% a change this view exists to surface, so it must NOT read as "no
//     uncommitted changes" — the `untracked` flag exists exactly so the UI can say
//     "untracked" instead of "no changes" (src/gitRoutes.js getLocalGitDiff).
//   - diff is a non-empty string -> dirty: render via DiffBlock. `untracked` rides
//     along defensively (in practice the endpoint never pairs a non-empty diff
//     with untracked=true — untracked always yields an empty diff — but the field
//     is carried honestly so the type can't lie if that ever changes).
//   - diff null OR '' with untracked=false -> clean: empty-state. Both shapes
//     occur — the route returns null for a clean tracked file, and `git diff HEAD`
//     can yield '' — both mean no uncommitted changes.
export function classifyChangesView(resp: ChangesDiffResponse, loading: boolean): ChangesViewState {
  if (loading) return { kind: 'loading' };
  if (resp.error) return { kind: 'error', message: resp.error };
  if (resp.untracked && !(typeof resp.diff === 'string' && resp.diff.length > 0)) {
    return { kind: 'untracked' };
  }
  if (typeof resp.diff === 'string' && resp.diff.length > 0) {
    return { kind: 'dirty', diff: resp.diff, untracked: !!resp.untracked };
  }
  return { kind: 'clean' };
}

// The toolbar's button-driven alternate views. Mutually exclusive in the main
// content area — only one of annotate/history/changes renders at once. (The
// at-commit snapshot is a fourth exclusive view reached from the history list;
// it is cleared inline in the component because its clearing is history-specific.)
export interface ViewToggles {
  annotate: boolean;
  history: boolean;
  changes: boolean;
}
export type ViewToggleKey = keyof ViewToggles;

// Compute the next toolbar-toggle state when one alternate view is toggled.
// Turning a view ON clears the other two (mutual exclusivity); turning a view
// OFF leaves the others alone (the user dismissed it, not switched away). Pure
// so the exclusivity contract is unit-testable — a multi-way inline setState web
// is exactly the kind of thing that silently regresses (e.g. forgetting to clear
// `changes` when annotate turns on would overlay two views in the content area).
export function resolveViewToggles(current: ViewToggles, mode: ViewToggleKey, next: boolean): ViewToggles {
  if (!next) return { ...current, [mode]: false };
  const off: ViewToggles = { annotate: false, history: false, changes: false };
  off[mode] = true;
  return off;
}
