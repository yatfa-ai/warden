/**
 * Copy text to the system clipboard, Electron-safe.
 *
 * Prefers the async Clipboard API (`navigator.clipboard.writeText`), then
 * falls back to a hidden-textarea + `document.execCommand('copy')` — the same
 * legacy path PaneTile's copy-on-select uses (WARDEN-285) — because
 * `navigator.clipboard` can fail silently in Electron (non-secure context or
 * permission denied). Returns `true` on success, `false` if both paths fail.
 *
 * UI feedback (toasts) is intentionally left to the caller: keeping this free
 * of UI deps lets the menu decide what to surface and keeps the helper
 * unit-testable against mocked globals.
 *
 * Reads `navigator` / `document` off `globalThis` at call time (not import
 * time) so a test harness can swap them between cases.
 */
export async function copyText(text: string): Promise<boolean> {
  const g = globalThis as {
    navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } };
    document?: Document;
  };

  // 1. Async Clipboard API (browsers, secure contexts).
  try {
    if (g.navigator?.clipboard?.writeText) {
      await g.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Unavailable or rejected (Electron can reject silently) — fall through.
  }

  // 2. Legacy textarea + execCommand('copy') fallback (Electron-safe).
  const doc = g.document;
  if (!doc) return false;
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    doc.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
