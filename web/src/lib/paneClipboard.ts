import type { Terminal } from '@xterm/xterm';
import { toast } from 'sonner';
import { copyText } from '@/lib/clipboard';
import { readClipboardImage, deliverImagePaste } from '@/lib/pasteImage';

// Copy the xterm selection to the system clipboard via the Electron-safe
// document.execCommand('copy') textarea fallback — the SAME path the Ctrl/Cmd+C
// handler below uses (navigator.clipboard fails silently in Electron, per the
// inline note there). No-op on an empty selection so a CLEARED selection never
// clobbers the clipboard (onSelectionChange also fires on de-select). Factored
// out so the three callers — Ctrl/Cmd+C, copy-on-select, and the Copy menu
// item — share one clipboard routine instead of duplicating it. (WARDEN-285)
//
// WARDEN-1244: execCommand('copy') can REFUSE without throwing — it returns
// false and writes NOTHING, so the previous clipboard contents survive (the
// shared helper already handles this; see clipboard.test.mjs's "returns false"
// case). Discarding the boolean made the pane treat that refusal as success,
// and the next paste sent the OLD text into a live agent pane. So the result
// is consulted: a refusal (false return, or the legacy throw) fires the pane's
// standard error toast, gated on the caller-supplied notifyErrors pref — the
// same WARDEN-400 convention as every other error toast in this file, and
// error-only by design (success stays silent; no new noise on the happy path).
export function copySelectionToClipboard(term: Terminal, notifyErrors: boolean): void {
  const s = term.getSelection();
  if (!s) return;
  const ta = document.createElement('textarea');
  ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* refused — copied stays false */ }
  document.body.removeChild(ta);
  if (!copied && notifyErrors) toast.error('Copy failed — clipboard still holds the old text');
}

// WARDEN-1293: copy a HIGHLIGHTED TOKEN (a URL or a file path) from the pane's
// context menu to the system clipboard.
//
// Routed through the shared, Electron-safe `copyText` helper (lib/clipboard.ts)
// rather than re-inlining the textarea dance: that helper already tries the
// async Clipboard API first and falls back to execCommand — the fallback the
// ticket requires "here as everywhere else" — and it already returns a success
// boolean. The boolean is CONSULTED, on this surface's established convention
// (copySelectionToClipboard above, WARDEN-1244): a failure raises the pane's
// standard error toast gated on the notifyErrors pref, and SUCCESS IS SILENT.
//
// That silence is why this does NOT use `copyWithToast` (lib/clipboardToast.ts),
// which the sidebar/FileViewer/search menus use: copyWithToast fires
// `toast.success('Copied')`, and this product deliberately does not toast the
// happy path in the terminal pane. Same mechanism, this surface's feedback.
export async function copyTokenToClipboard(text: string, notifyErrors: boolean): Promise<void> {
  const ok = await copyText(text);
  if (!ok && notifyErrors) toast.error('Copy failed — clipboard still holds the old text');
}

// Paste the system clipboard INTO the terminal via xterm's own paste path
// (WARDEN-254). term.paste() wraps the block in bracketed-paste markers
// (\e[200~ … \e[201~) exactly when the app has enabled DECSET 2004, then emits
// through onData → streamApi → PTY (the bridge is byte-transparent both ways,
// so the markers reach the agent). So a multiline paste arrives as ONE paste
// and is never submitted line-by-line, matching a direct paste into the same
// tmux session; single-line + a bare-shell app (no bracketed paste) paste raw,
// like today.
//
// Factored out so the Ctrl/Cmd+V keybinding below and the themed Paste menu
// item (WARDEN-380) share one routine — mirroring how copySelectionToClipboard
// above is shared by Ctrl/Cmd+C, copy-on-select, and the Copy menu item.
// navigator.clipboard fails silently in Electron, so the textarea +
// document.execCommand('paste') fallback reads a real paste event instead.
//
// WARDEN-1282 — the IMAGE branch. Both entry branches below (the async
// clipboard API and the Electron execCommand fallback) were text-only: an
// image-only clipboard yields '' in each, and the `if (t)` guard dropped it in
// SILENCE. So the image is tried FIRST, before either text read:
//
//   IMAGE WINS on an image+text clipboard. One deterministic rule, so the
//   gesture never makes the owner think; documented in lib/pasteImage.ts with
//   the reasoning. A text-only clipboard never enters this branch at all, so
//   the WARDEN-254 contract below is not merely preserved — it is untouched.
//
//   The BYTES go beside the terminal (POST → the server writes the file into
//   the agent's host/container over ssh + `docker exec -i` stdin) and only the
//   returned MARKER LINE crosses the pty, through the SAME term.paste() call a
//   text paste uses. So a companion-enabled or bracketed-paste session behaves
//   identically to any other paste, and no image byte is ever in the stream.
//
//   A failure is LOUD and MARKER-LESS: the pane's standard error toast (the
//   WARDEN-400 notifyErrors convention), and nothing pasted. A marker without a
//   delivered file would point the agent at something that isn't there — worse
//   than the silence this fixes.
//
// `id` is the pane's chat id; the server resolves host/container from it, so the
// renderer never chooses where bytes land. Async, but fire-and-forget from both
// call sites exactly as the text path already was.
export async function pasteIntoTerm(term: Terminal, id: string, notifyErrors: boolean): Promise<void> {
  const image = await readClipboardImage();
  if (image) {
    const res = await deliverImagePaste(id, image);
    if (!res.ok) {
      if (notifyErrors) toast.error(res.error ? `Image paste failed — ${res.error}` : 'Image paste failed');
      return;
    }
    term.paste(res.marker!);
    return;
  }
  navigator.clipboard?.readText().then((t) => { if (t) term.paste(t); }).catch(() => {
    // Electron fallback: read from a paste event
    const ta = document.createElement('textarea');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus();
    document.execCommand('paste');
    setTimeout(() => { if (ta.value) term.paste(ta.value); document.body.removeChild(ta); }, 100);
  });
}
