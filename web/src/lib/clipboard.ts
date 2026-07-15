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

/**
 * OSC 52 clipboard handler — the standard terminal clipboard protocol
 * (WARDEN-437). On hosts where tmux has mouse on (e.g. macmini), xterm never
 * owns the selection, so the pane's select + Ctrl/Cmd+C copy path grabs nothing.
 * Modern tmux defaults (`set-clipboard = external`) already emit an OSC 52
 * clipboard sequence on a drag-select-and-release, and warden's PTY transport is
 * byte-transparent, so those bytes reach xterm — but xterm.js ships no OSC 52
 * handler and silently discards them. Registering this handler (via
 * `term.parser.registerOscHandler(52, handleOsc52)`) routes the copy to the
 * system clipboard through {@link copyText}, so a mouse drag-select-and-release
 * now copies on every host with no per-host toggle and no tmux-mouse fighting.
 *
 * xterm passes the handler the OSC data AFTER the `52;` code: a string of the
 * form `<clipboard-selectors>;<payload>`. The payload is base64 text (a SET) or
 * `?` / empty (a QUERY). We honor SET (decode + write the system clipboard) and
 * ignore QUERY — answering a query would hand the LOCAL clipboard to a remote
 * program, which we never do. Always returns `true` so no other handler (none
 * ships today, but a future xterm default might) can ever answer a query on our
 * behalf. base64 never contains `;`, so `lastIndexOf(';')` reliably splits the
 * selectors from the payload regardless of how many selectors precede it.
 *
 * Reads `atob` off `globalThis` at call time (not import time) so a test harness
 * can swap it — the same call-time-global pattern {@link copyText} uses.
 */
export function handleOsc52(data: string): boolean {
  // The payload follows the LAST ';' (one or more clipboard selectors — `c`,
  // `p`, `s0`… — precede it). No ';' at all, or an empty / `?` payload, is a
  // clipboard QUERY: ignore it. Never reply, so the local clipboard can't leak.
  const semi = data.lastIndexOf(';');
  if (semi < 0) return true;
  const payload = data.slice(semi + 1);
  if (payload === '' || payload === '?') return true;
  try {
    const decode = (globalThis as { atob?: (s: string) => string }).atob;
    if (!decode) return true;
    // atob yields a binary string; map each char to its byte, then decode as
    // UTF-8 so multibyte selections (emoji, accents) round-trip correctly.
    const bin = decode(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder('utf-8').decode(bytes);
    void copyText(text);
  } catch {
    // bad base64 / decode error — ignore; never let a malformed sequence crash xterm
  }
  return true;
}
