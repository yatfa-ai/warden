// Reconciler for the three Electron-MAIN-OWNED preferences (WARDEN-973).
//
// "Close to tray", "Launch at login" and "Remember window bounds" are NOT
// renderer-owned localStorage prefs: main's window-state.json / the OS is the
// source of truth and the React state is only a DISPLAY MIRROR (App.tsx:452).
// Main implements a real REFUSAL contract — its set handlers deliberately do
// not echo the request, they return WHAT ACTUALLY HAPPENED:
//   - window:set-close-to-tray refuses a requested `true` when createTray()
//     fails (unsupported desktop / misconfigured AppIndicator-SNI / headless),
//     persists OFF and returns false — so the user is never stranded with a
//     hidden window and no tray to restore it.
//   - window:set-launch-at-login re-reads the OS via getLoginItemSettings()
//     after writing, so a requested `true` resolves `false` on a platform that
//     doesn't honor it ("limited on Linux").
// `lib/electron.ts` faithfully forwards that authoritative value.
//
// Discarding it (the pre-WARDEN-973 `void persist…(v)`) left the switch reading
// ON while the feature was OFF, then silently flipping back on next launch —
// the "this setting doesn't stick" symptom. Main's boot self-heal aims to keep
// "cache == file == Settings display == behavior"; the renderer's display is
// the one layer main cannot reach, and this reconciler is how it closes.
//
// Deliberately dependency-free (no React, no `sonner`): the caller supplies the
// state setter and the refusal notifier, which keeps this loadable by the
// OXC-transform-to-temp-`.mjs` harness in web/electron.test.mjs.

/**
 * Apply a main-owned boolean pref optimistically, then reconcile the display
 * mirror with the value main/the OS actually settled on.
 *
 * `setDisplay(requested)` runs SYNCHRONOUSLY (before the first await) so the
 * Switch stays responsive, exactly as before. When the resolved value matches
 * the request — the normal case — nothing further happens: no extra setState,
 * no toast, behavior identical to the pre-fix code. When it DIFFERS, main
 * refused: the display reverts to the truth and `onRefused` explains why.
 *
 * The `persist` accessors in lib/electron.ts never reject (they degrade to the
 * passed value), so no catch is needed for the documented contract; the guard
 * below is belt-and-braces for a future accessor that does throw, and leaves
 * the optimistic state untouched rather than reverting on an unknown outcome.
 *
 * @returns the authoritative value the display was reconciled to.
 */
export async function reconcileMainOwnedPref(
  requested: boolean,
  persist: (v: boolean) => Promise<boolean>,
  setDisplay: (v: boolean) => void,
  onRefused: (actual: boolean) => void,
): Promise<boolean> {
  setDisplay(requested);
  let actual: boolean;
  try {
    actual = await persist(requested);
  } catch {
    // Contract says this cannot happen. If it ever does, keep the optimistic
    // value rather than inventing a refusal we did not observe.
    return requested;
  }
  if (actual !== requested) {
    setDisplay(actual);
    onRefused(actual);
  }
  return actual;
}
