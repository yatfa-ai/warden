import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Distance (px) from the bottom that still counts as "pinned" — keeps auto-scroll
// engaged through minor sub-pixel/rounding drift without fighting the user.
const BOTTOM_THRESHOLD = 24;

// Stick-to-bottom scroll behaviour for a chat message list rendered inside the
// shadcn <ScrollArea/>. The ScrollArea wraps a Radix viewport; we locate that
// viewport element to read scrollTop/scrollHeight and attach the scroll listener.
//
// Why the DOM here is fine (it is NOT a WARDEN-68 Rule 4 violation): scroll
// position has no React representation — React does not model scrollTop or
// scrollHeight. Rule 4 forbids querying the DOM for *component state* (e.g.
// reading an input's value instead of controlling it); measuring a scroll
// container's geometry is inherently imperative and is the only way to do this.
//
// Usage:
//   const { rootRef, atBottom, scrollToBottom, stickIfPinned } = useStickToBottom();
//   <ScrollArea ref={rootRef}>...</ScrollArea>
//   useLayoutEffect(() => { stickIfPinned(); }, [items]);   // pin on new content
//
// `enabled` (default true): when false, the scroll/resize/mutation observers are
// NOT attached, so the hook never auto-pins on content changes. Used by consumers
// that want stick-to-bottom only conditionally (e.g. FileViewer's Follow toggle —
// attach observers ONLY while Follow is on, so a content change with Follow OFF,
// such as toggling Annotate/History on a short file, doesn't snap to the bottom).
// Always-on consumers (ObserverPanel) omit the arg and get the default `true`.
export function useStickToBottom(enabled: boolean = true) {
  // Ref on the <ScrollArea/> Root element.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The Radix viewport we actually scroll — resolved from the Root after mount.
  const viewportRef = useRef<HTMLElement | null>(null);

  const [atBottom, setAtBottom] = useState(true);
  // Synchronous mirror of "is the user following the latest content" (near the
  // bottom). This is updated inside the scroll/measure callback — NOT in a
  // post-paint useEffect — so a content-growth re-pin can read it without racing
  // a user scroll-up. The previous design mirrored `atBottom` via useEffect,
  // which lagged a render behind: a content-growth re-pin could read a stale
  // `true` and yank a user back to the bottom, so re-pinning was never safe to
  // add. Keeping the flag in a ref updated synchronously from the scroll handler
  // is what makes "follow new content" and "respect a scroll-up" coexist.
  const followingRef = useRef(true);
  // Coalesces a burst of content changes into a single follow-up re-pin.
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nowAtBottom = distance < BOTTOM_THRESHOLD;
    followingRef.current = nowAtBottom;
    setAtBottom(nowAtBottom);
  }, []);

  // Pin to the bottom instantly if the user is already there. Call this from a
  // layout effect keyed on the message data so it runs after the DOM is mutated
  // but before paint — no flicker while streaming. Instant (not smooth): smooth
  // scrolling during rapid token-style updates jitters.
  const stickIfPinned = useCallback(() => {
    if (!followingRef.current) return;
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Re-pin on content growth. Content growth does NOT fire a `scroll` event
  // (scrollTop is unchanged — only scrollHeight grows), so a layout-effect-only
  // pin measures a stale scrollHeight: with assistant-ui each message commits on
  // a deferred render, so when the layout effect runs the new message's markdown
  // hasn't settled and the latest content drifts off-screen. We pin immediately
  // when growth is observed (so the new content never paints off-screen) and
  // again on the next frame to catch further settling in the same burst.
  const onGrow = useCallback(() => {
    stickIfPinned();
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      stickIfPinned();
    });
  }, [stickIfPinned]);

  // Explicit jump-to-bottom (the "jump to latest" button) + programmatic uses
  // (e.g. right after the user sends). Defaults to instant; pass 'smooth' for
  // the affordance so the user sees the list glide down.
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = viewportRef.current;
    if (!el) return;
    // Respect prefers-reduced-motion (WCAG 2.3.3). The global CSS reset sets
    // `scroll-behavior: auto !important`, but per CSSOM View that only supplies
    // the behaviour when the option is omitted/'auto' — an explicit JS
    // `behavior: 'smooth'` is honoured as-is and is NOT overridden by CSS. So we
    // guard it here too, snapping under reduce-motion on every browser.
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion ? 'auto' : behavior });
    followingRef.current = true;
    setAtBottom(true);
  }, []);

  // Resolve the viewport once it exists and track its scroll + size. The
  // ResizeObserver covers size changes (markdown reflow, image load, panel
  // resize); the MutationObserver covers assistant-ui's deferred message commits
  // and streamed text-node updates. The viewport's own border-box is fixed (it
  // fills the pane), so we also observe its content wrapper — the element that
  // actually grows as messages stream in.
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    if (!root) return;
    const vp = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!vp) return;
    viewportRef.current = vp;
    vp.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(onGrow);
    ro.observe(vp);
    const content = vp.firstElementChild as HTMLElement | null;
    if (content) ro.observe(content);
    const mo = new MutationObserver(onGrow);
    mo.observe(vp, { childList: true, subtree: true, characterData: true });
    measure();

    return () => {
      vp.removeEventListener('scroll', measure);
      ro.disconnect();
      mo.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      viewportRef.current = null;
    };
  }, [measure, onGrow, enabled]);

  return { rootRef, atBottom, scrollToBottom, stickIfPinned };
}
