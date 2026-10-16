// EditableContextMenu — the themed right-click edit menu (Cut · Copy · Paste ·
// Select all) for a single free-text <textarea> child (WARDEN-1830). Electron
// ships no default context menu, so without this a right-click in a reply box
// is silent. Built on the existing themed ContextMenu (`ContextMenuTrigger
// asChild` composes onto the textarea; no hand-rolled menu and no onContextMenu
// / preventDefault / stopPropagation of its own — WARDEN-926).
//
// Selection is read from the element's selectionStart/End, which a textarea
// retains after focus moves to the menu. Paste/Cut go through
// document.execCommand so the browser fires a real `input` event (React onChange
// updates the controlled value) and the native undo stack stays intact.
import * as React from 'react';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';
import { editMenuItems, selectedText, type EditMenuItemId } from '@/lib/editMenu';

/** Insert text over the current selection; execCommand first (undo + onChange), setRangeText fallback. */
function insertAtSelection(el: HTMLTextAreaElement, text: string) {
  if (document.execCommand('insertText', false, text)) return;
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function restoreFocus(el: HTMLTextAreaElement, start: number, end: number) {
  el.focus();
  el.setSelectionRange(start, end);
}

export function EditableContextMenu({ children }: { children: React.ReactElement<React.ComponentProps<'textarea'>> }) {
  const elRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [hasSelection, setHasSelection] = React.useState(false);

  // Compose our ref with the child's own (Observer's taRef) — React 19: ref is a prop.
  const childRef = (children.props as { ref?: React.Ref<HTMLTextAreaElement> }).ref;
  const setRef = React.useCallback((node: HTMLTextAreaElement | null) => {
    elRef.current = node;
    if (typeof childRef === 'function') childRef(node);
    else if (childRef) (childRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
  }, [childRef]);

  const { disabled, readOnly } = children.props;
  const items = editMenuItems({ hasSelection, readOnly, disabled });
  // Keep the tree shape STABLE when disabled (trigger `disabled`, no content) so a
  // disabled↔enabled flip (Observer !conn, QuickReply sending) never remounts the
  // textarea and drops its focus.

  const run = async (id: EditMenuItemId) => {
    const el = elRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const sel = selectedText(el.value, start, end);
    if (id === 'copy') {
      if (sel) await copyWithToast(sel);
    } else if (id === 'cut') {
      if (sel && (await copyWithToast(sel))) {
        restoreFocus(el, start, end);
        if (!document.execCommand('delete')) {
          el.setRangeText('', start, end, 'end');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } else if (id === 'paste') {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast.error('Paste failed — clipboard unavailable');
        return;
      }
      if (!text) return;
      restoreFocus(el, start, end);
      insertAtSelection(el, text);
    } else {
      el.focus();
      el.select();
    }
  };

  return (
    <ContextMenu
      onOpenChange={(open) => {
        const el = elRef.current;
        if (open && el) setHasSelection((el.selectionStart ?? 0) !== (el.selectionEnd ?? 0));
      }}
    >
      <ContextMenuTrigger asChild disabled={items.length === 0}>
        {React.cloneElement(children, { ref: setRef } as React.ComponentProps<'textarea'>)}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {items.map((it, i) =>
          it.kind === 'separator' ? (
            <ContextMenuSeparator key={`sep-${i}`} />
          ) : (
            <ContextMenuItem key={it.id} disabled={it.disabled} onSelect={() => { void run(it.id); }}>
              {it.label}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
