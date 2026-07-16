import type { Chat } from '@/lib/types';

// Pure resolution of which chat a per-pane workspace dialog (content-search 🔍
// or open-file-from-directory 📄) acts on. Extracted from PaneGrid (WARDEN-563)
// so the acting-pane contract is unit-testable against the real function — the
// same reason resolveVisibleTiles (WARDEN-521) lives in src/lib.
//
// Both affordances used to live on the grid toolbar and operated on the FOCUSED
// pane (focusedChat). WARDEN-563 moves them onto each pane's own context menu,
// so a right-click on a NON-focused pane must search/open in THAT pane's repo.
// The hazard (the WARDEN-115 "reaches the observer" trap): if the dialogs still
// resolved focusedChat, right-clicking an unfocused pane would be a silent no-op
// against the success bar — the slice would reproduce the focused-pane bug it
// claims to fix. resolveActingChat prevents that: it prefers the right-clicked
// pane's chat (actingPaneId) and only falls back to focusedChat when no pane has
// been seeded, or when the seeded pane's chat has since vanished (so an open
// dialog stays mounted rather than blanking mid-use).
//
// PaneGrid seeds actingPaneId from openSearchFor/openFilePromptFor (bound per-
// tile, mirroring onSplitShell) and passes focusedChat + chats in here.
export function resolveActingChat(
  actingPaneId: string | null,
  focusedChat: Chat | null | undefined,
  chats: Chat[],
): Chat | null {
  // Normalize the focused chat to Chat | null (PaneGrid derives it from a
  // chats.find(...) : null ternary, so it may be undefined; the dialogs guard on
  // a nullable chat, and we never want undefined leaking through the return).
  const focused = focusedChat ?? null;
  if (!actingPaneId) return focused;
  return chats.find((c) => (c.key || c.id) === actingPaneId) ?? focused;
}
