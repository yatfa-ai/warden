import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clampSidebarWidth, clampObserverWidth } from '@/lib/layout';
import {
  uiStore,
  useSidebarWidth,
  useObserverWidth,
  useSidebarCollapsed,
  useObserverCollapsed,
  useSetSidebarWidth,
  useSetObserverWidth,
} from '@/lib/uiStore';

// WARDEN-1628 (client-state slice 39): a resizable side rail extracted from App.tsx.
// The rail subscribes to its OWN width + collapsed flag and OWNS the drag, so a
// mousemove while dragging the sidebar/observer edge writes the store and re-renders
// only this rail — not the whole App at mouse-move rate. Everything the drag needs
// from the OTHER side (neighbour width / collapse, health collapse) is read
// imperatively via uiStore.getState() at mousedown, so the rail holds no
// subscription for it and the mousemove clamp stays on stable captured values.
//
// The sidebar handle sits on the rail's RIGHT edge and drags with delta = clientX -
// startX; the observer handle sits on the LEFT edge and drags with delta = startX -
// clientX (the rail grows as the pointer moves away from the middle pane).

export interface ResizableRailProps {
  side: 'sidebar' | 'observer';
  className: string;
  handleTitle: string;
  children: ReactNode;
}

export function ResizableRail({ side, className, handleTitle, children }: ResizableRailProps) {
  const isSidebar = side === 'sidebar';
  const sidebarWidth = useSidebarWidth();
  const observerWidth = useObserverWidth();
  const sidebarCollapsed = useSidebarCollapsed();
  const observerCollapsed = useObserverCollapsed();
  const setSidebarWidth = useSetSidebarWidth();
  const setObserverWidth = useSetObserverWidth();
  // Only this rail's own width/collapse are used for render; the neighbour's values
  // are read at mousedown (see header). Hooks cannot be conditional, so both pairs
  // are subscribed — a neighbour change re-renders just this small rail, never App.
  const width = isSidebar ? sidebarWidth : observerWidth;
  const collapsed = isSidebar ? sidebarCollapsed : observerCollapsed;

  const [isResizing, setIsResizing] = useState(false);
  const dragStartX = useRef<number>(0);
  const dragStartWidth = useRef<number>(0);
  // Neighbour width (0 when collapsed) + health state captured at drag start, so the
  // mousemove clamp can reserve the middle-pane floor (WARDEN-183) without the effect
  // needing live state in its deps.
  const dragOtherWidth = useRef<number>(0);
  const dragHealthCollapsed = useRef<boolean>(true);

  const handleMouseDown = (e: React.MouseEvent) => {
    const s = uiStore.getState();
    dragStartX.current = e.clientX;
    dragStartWidth.current = isSidebar ? s.sidebarWidth : s.observerWidth;
    dragOtherWidth.current = isSidebar
      ? (s.observerCollapsed ? 0 : s.observerWidth)
      : (s.sidebarCollapsed ? 0 : s.sidebarWidth);
    dragHealthCollapsed.current = s.healthCollapsed;
    setIsResizing(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const ctx = { windowWidth: window.innerWidth, healthCollapsed: dragHealthCollapsed.current };
      if (isSidebar) {
        const newWidth = dragStartWidth.current + (e.clientX - dragStartX.current);
        setSidebarWidth(clampSidebarWidth(newWidth, dragOtherWidth.current, ctx));
      } else {
        const newWidth = dragStartWidth.current + (dragStartX.current - e.clientX);
        setObserverWidth(clampObserverWidth(newWidth, dragOtherWidth.current, ctx));
      }
    };
    const handleMouseUp = () => setIsResizing(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    // Cleanup runs on mouseup (isResizing flips) AND on unmount mid-drag, so no
    // document listener can leak if the rail unmounts while dragging.
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, isSidebar, setSidebarWidth, setObserverWidth]);

  return (
    <section
      className={className}
      style={{ width: collapsed ? 0 : width, flexShrink: 0, opacity: collapsed ? 0 : 1 }}>
      <div
        className={`absolute top-0 ${isSidebar ? 'right-0' : 'left-0'} bottom-0 w-1 hover:bg-accent hover:w-1.5 transition-all cursor-col-resize z-10`}
        onMouseDown={handleMouseDown}
        title={handleTitle}
      />
      {children}
    </section>
  );
}
