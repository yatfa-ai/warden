import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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
export function useStickToBottom() {
  // Ref on the <ScrollArea/> Root element.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The Radix viewport we actually scroll — resolved from the Root after mount.
  const viewportRef = useRef<HTMLElement | null>(null);

  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  useEffect(() => { atBottomRef.current = atBottom; }, [atBottom]);

  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < BOTTOM_THRESHOLD);
  }, []);

  // Resolve the viewport once it exists and track its scroll + size. A
  // ResizeObserver covers content growing without a scroll event (e.g. markdown
  // / image load) so `atBottom` stays accurate.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const vp = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!vp) return;
    viewportRef.current = vp;
    vp.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    measure();
    return () => {
      vp.removeEventListener('scroll', measure);
      ro.disconnect();
      viewportRef.current = null;
    };
  }, [measure]);

  // Pin to the bottom instantly if the user is already there. Call this from a
  // layout effect keyed on the message data so it runs after the DOM is mutated
  // but before paint — no flicker while streaming. Instant (not smooth): smooth
  // scrolling during rapid token-style updates jitters.
  const stickIfPinned = useCallback(() => {
    if (!atBottomRef.current) return;
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

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
    setAtBottom(true);
  }, []);

  return { rootRef, atBottom, scrollToBottom, stickIfPinned };
}
