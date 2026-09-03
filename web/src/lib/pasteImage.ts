// Clipboard IMAGE half of the agent-pane paste gesture (WARDEN-1282).
//
// Pasting into an agent pane used to read text only: `navigator.clipboard
// .readText()` on an image-only clipboard resolves to `''`, and the `if (t)`
// guard in PaneTile's pasteIntoTerm dropped it in silence. So copying a
// screenshot and pasting it did NOTHING — the owner had to retell in prose what
// the agent could not see.
//
// The rules this module encodes:
//
//   IMAGE WINS. A clipboard carrying BOTH an image and text delivers the IMAGE.
//   One deterministic rule, decided here rather than left to the moment: an
//   image+text clipboard is overwhelmingly a screenshot tool that also wrote a
//   caption or a file path, and the image is the part the owner cannot retype.
//   The rule must never make the user think, and "whichever is bigger" or "ask"
//   both would. A text-only clipboard is untouched by this module entirely — it
//   never reaches here, so the WARDEN-254 bracketed-paste contract is not merely
//   preserved, it is not on this code path at all.
//
//   BYTES BESIDE, MARKER THROUGH. The image is POSTed as a raw body to
//   /api/paste-image, which delivers it as a FILE to where the agent lives; the
//   only thing that crosses the terminal is the short marker line the server
//   returns, pasted through the identical text path. No image byte ever enters
//   the pty.
//
//   NO MARKER WITHOUT A FILE. A failed delivery returns an error and no marker.
//   Telling the agent to open a file that was never written is worse than the
//   silence being fixed here.
//
// Three-context feature detection, the same contract as lib/electron.ts:
//   1. Electron desktop app  → navigator.clipboard.read() is available.
//   2. `npm run dev` browser → available in a secure context; a permission
//      refusal throws and degrades to the text path.
//   3. `node web/smoke.cjs`  → no navigator.clipboard at all → null, text path.
// Every branch that cannot read an image resolves to `null`, which the caller
// reads as "no image — carry on as text". Nothing here ever rejects.

/** The MIME prefix that makes a clipboard item an image. */
const IMAGE_TYPE = /^image\//;

/**
 * Read an image off the system clipboard, or null when there isn't one (or the
 * host cannot tell us). NEVER rejects: every failure — no async clipboard API,
 * a permission refusal, a host that throws — resolves to null, so the caller
 * falls through to the unchanged text path instead of losing the paste.
 *
 * `nav` is a test seam; production callers omit it.
 */
export async function readClipboardImage(
  nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): Promise<Blob | null> {
  // `read` (the full item API) is a strictly newer addition than `readText`, so
  // a host can have one without the other — feature-detect the METHOD, not the
  // `clipboard` object.
  const clip = nav?.clipboard as Clipboard | undefined;
  if (!clip || typeof clip.read !== 'function') return null;
  let items: ClipboardItems;
  try {
    items = await clip.read();
  } catch {
    // Permission denied, a non-secure context, or an Electron quirk. Not an
    // error worth surfacing: an image paste we cannot see is indistinguishable
    // from a text paste, and the caller is about to try text anyway.
    return null;
  }
  for (const item of items ?? []) {
    // IMAGE WINS: the first image type on the FIRST item that has one is taken,
    // without looking at whether a text/plain flavour sits beside it.
    const type = (item?.types ?? []).find((t) => IMAGE_TYPE.test(t));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      if (blob && blob.size > 0) return blob;
    } catch {
      // A flavour the host advertised but cannot materialize. Keep looking.
    }
  }
  return null;
}

/** What a delivery attempt reports back. `marker` is present ONLY on success. */
export interface ImagePasteResult {
  ok: boolean;
  marker?: string;
  path?: string;
  error?: string;
}

/**
 * POST the image bytes to the pane's chat and get back the marker line.
 *
 * The body is the RAW image — not base64 in JSON. The server's global
 * `express.json({ limit: '1mb' })` is untouchable (it bounds every other route),
 * base64 would inflate a screenshot ~33% past a limit it already exceeds, and
 * the pane id therefore rides the query string because the body is the picture.
 *
 * Never rejects: a network failure resolves as `{ ok: false, error }` so the
 * caller has exactly one shape to branch on, matching lib/api.ts's ApiResult
 * contract (a result object, not a throw).
 */
export async function deliverImagePaste(
  id: string,
  blob: Blob,
  fetchFn: typeof fetch = fetch,
): Promise<ImagePasteResult> {
  try {
    const res = await fetchFn(`/api/paste-image?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    let body: { marker?: string; path?: string; error?: string } | undefined;
    try { body = await res.json(); } catch { /* a truncated/empty body stays undefined */ }
    if (!res.ok) return { ok: false, error: body?.error || `paste failed (HTTP ${res.status})` };
    // A 2xx with no marker is a contract violation, not a success — refuse it
    // rather than paste `undefined` into a live agent pane.
    if (!body?.marker) return { ok: false, error: 'server returned no marker' };
    return { ok: true, marker: body.marker, path: body.path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
