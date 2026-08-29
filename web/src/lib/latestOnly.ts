// Generation guard for manually-fired async legs (WARDEN-1049).
//
// WHY THIS EXISTS: an `async` event handler that awaits a fetch and then writes
// React state has no sequencing of its own. Two invocations can overlap and land
// in either order, so an older response can overwrite a newer one; and one that
// resolves AFTER its owner unmounts/closes writes back over the state the
// reset-on-close effect just cleared. The repo's DEBOUNCED legs already solve
// this with a `cancelled` flag hung off the effect's cleanup
// (GlobalSearchDialog's session leg, OpenChatBrowserPage, GitBadges) — but an
// event handler has no cleanup to hang a flag on, so it needs a counter that
// lives across invocations instead. That counter is a `useRef`; this module is
// the pure arithmetic over it.
//
// Deliberately dependency-free (no React import, no `import type`) so the repo's
// `node --test` suite can load it directly — there is no front-end DOM runner
// here, so the sequencing is tested as a pure module rather than through a
// component. See web/searchRaceGuard.test.mjs.

/**
 * The mutable cell holding the current generation. Structurally satisfied by
 * React's `useRef<number>(0)`, so a component passes its ref straight in without
 * this module importing React.
 */
export interface GenerationRef {
  current: number;
}

/**
 * Claim the newest generation for an operation that is about to start, and
 * return the gate that operation must pass before it is allowed to write.
 *
 * The gate answers one question — "am I still the newest?" — and answers it
 * FALSE forever once anything else claims a generation (a later `claimLatest`)
 * or invalidates the current one (`supersedeInFlight`). Call it immediately
 * before EVERY write, including the one in `finally`: a superseded response that
 * is allowed to clear a "loading" flag stops the spinner belonging to the search
 * that is still running.
 *
 *   const gen = useRef(0);            // one cell per component instance
 *   const isLatest = claimLatest(gen);
 *   const data = await fetch(...);
 *   if (!isLatest()) return;          // superseded, or the dialog closed
 *   setResults(data);
 */
export function claimLatest(ref: GenerationRef): () => boolean {
  const mine = ref.current + 1;
  ref.current = mine;
  return () => ref.current === mine;
}

/**
 * Supersede every in-flight operation WITHOUT starting a new one — the
 * reset-on-close / unmount case. After this, every outstanding gate reads false,
 * so a response that arrives late writes nothing and the cleared state stays
 * cleared.
 */
export function supersedeInFlight(ref: GenerationRef): void {
  ref.current += 1;
}
