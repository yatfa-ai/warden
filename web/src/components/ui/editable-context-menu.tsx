// EditableContextMenu — the themed right-click edit menu (Cut · Copy · Paste ·
// Select all) for a single free-text <textarea>, text-like <input> (WARDEN-1830,
// widened to inputs in WARDEN-1837) or number <input> child (WARDEN-1864's
// number-safe branch). Electron ships no default context menu, so without this a
// right-click in a reply box / search field is silent. Password inputs (secret
// safety) are never wrapped; number inputs use the number-safe branch — their
// internal selection is unreadable, so Cut/Copy/Paste run on the whole value
// (runNumberItems). Built on the existing themed ContextMenu (`ContextMenuTrigger
// asChild` composes onto the textarea; no hand-rolled menu and no onContextMenu
// / preventDefault / stopPropagation of its own — WARDEN-926).
//
// Text mounts read the selection from the element's selectionStart/End, which a
// text field retains after focus moves to the menu. Paste/Cut go through
// document.execCommand so the browser fires a real `input` event (React onChange
// updates the controlled value) and the native undo stack stays intact. A number
// input exposes NO readable selection (selectionStart is null) and rejects
// setRangeText (InvalidStateError), so its branch is value-based only and never
// touches either primitive.
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

type EditableEl = HTMLInputElement | HTMLTextAreaElement;
type EditableProps = React.ComponentProps<'textarea'> | React.ComponentProps<'input'>;
type ContextMenuContentProps = React.ComponentProps<typeof ContextMenuContent> & {
  // Radix omits onOpenAutoFocus from the context-menu Content's public types
  // (it is a MenuContentImpl private prop) but consumes it at runtime — it is
  // the FocusScope's onMountAutoFocus. Declared here so the rename-field sites
  // can pass the focus-retention preventDefault type-safely (WARDEN-1854).
  onOpenAutoFocus?: (event: Event) => void;
};

/** Insert text over the current selection; execCommand first (undo + onChange), setRangeText fallback. */
function insertAtSelection(el: EditableEl, text: string) {
  if (document.execCommand('insertText', false, text)) return;
  el.setRangeText(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function restoreFocus(el: EditableEl, start: number, end: number) {
  el.focus();
  el.setSelectionRange(start, end);
}

// WARDEN-1864 — the number-safe branch for <input type="number"> children. A
// number input exposes NO readable internal selection (the internal
// selectionStart is null — the reason the old contract fenced numbers out) and
// the ranged-setter primitive THROWS InvalidStateError there, so this branch
// touches neither: it runs whole-value semantics. Number fields hold short
// values (a font size, a token budget, an SSH timeout), so value-level
// semantics are the honest, predictable choice:
//   Copy        = the whole value.
//   Cut         = select-all-then-cut: el.select() → clipboard write →
//                 execCommand('delete'), which fires a real input event so React
//                 onChange and the native undo stack keep working. If
//                 'delete' is refused the value is left intact (no ranged
//                 fallback — it would throw here).
//   Paste       = execCommand('insertText') ONLY — inserts at the internal
//                 caret without reading it; a refused insert leaves the value
//                 untouched. Chromium drops non-numeric pastes on a number
//                 input, and the section's onBlur clamps still run on the same
//                 real input event.
//   Select all  = el.select().
async function runNumberItems(id: EditMenuItemId, el: HTMLInputElement) {
  if (id === 'copy') {
    if (el.value) await copyWithToast(el.value);
  } else if (id === 'cut') {
    if (el.value && (await copyWithToast(el.value))) {
      el.focus();
      el.select();
      document.execCommand('delete');
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
    el.focus();
    document.execCommand('insertText', false, text);
  } else {
    el.focus();
    el.select();
  }
}

function isNumberInput(el: EditableEl): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'number';
}

export function EditableContextMenu({
  children,
  contentProps,
  holdBlurWhileOpen = false,
}: {
  children: React.ReactElement<EditableProps>;
  // Optional props forwarded verbatim to ContextMenuContent. Filled AT THE SITE,
  // never defaulted here (WARDEN-1854): the conditional-mount rename fields pass
  // an onOpenAutoFocus that keeps focus in the field while the menu is open, so a
  // blur-commit rename handler cannot unmount the field out from under the open
  // menu. All other mounts stay untouched.
  contentProps?: ContextMenuContentProps;
  // Opt-in companion to contentProps' focus retention (WARDEN-1854), needed
  // because radix menu items FOCUS THEMSELVES on hover (react-menu
  // MenuItemImpl onPointerMove → item.focus()): that hover steal fires the
  // field's blur even when onOpenAutoFocus kept the field focused at open, and
  // for a blur-commit handler that unmounts on blur the field would still drop
  // out from under the open menu (verified live: hover a rename-field menu item
  // → commit fires → Input unmounts → items no-op). While the menu is open the
  // child's own onBlur is held; on close it passes through untouched. Default
  // false so every other mount keeps its exact semantics.
  holdBlurWhileOpen?: boolean;
}) {
  const elRef = React.useRef<EditableEl | null>(null);
  const menuOpenRef = React.useRef(false);
  const [hasSelection, setHasSelection] = React.useState(false);
  // WARDEN-1864 — number-mode state, sampled when the menu opens: a number child
  // has no readable selection, so item enablement keys on the field's VALUE
  // instead (editMenuItems' numberValue variant).
  const [numberMode, setNumberMode] = React.useState(false);
  const [numberValue, setNumberValue] = React.useState('');

  // Compose our ref with the child's own (Observer's taRef) — React 19: ref is a prop.
  const childRef = (children.props as { ref?: React.Ref<EditableEl> }).ref;
  const childOnBlur = (children.props as { onBlur?: React.FocusEventHandler<EditableEl> }).onBlur;
  const setRef = React.useCallback((node: EditableEl | null) => {
    elRef.current = node;
    if (typeof childRef === 'function') childRef(node);
    else if (childRef) (childRef as React.MutableRefObject<EditableEl | null>).current = node;
  }, [childRef]);

  const { disabled, readOnly } = children.props;
  const items = editMenuItems({
    hasSelection,
    readOnly,
    disabled,
    // WARDEN-1864: on a number child the selection is unreadable — the menu
    // keys Cut/Copy enablement on the value sampled at open instead.
    numberValue: numberMode ? numberValue : undefined,
  });
  // Keep the tree shape STABLE when disabled (trigger `disabled`, no content) so a
  // disabled↔enabled flip (Observer !conn, QuickReply sending) never remounts the
  // textarea and drops its focus.

  const run = async (id: EditMenuItemId) => {
    const el = elRef.current;
    if (!el) return;
    if (isNumberInput(el)) {
      await runNumberItems(id, el);
      return;
    }
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
        menuOpenRef.current = open;
        const el = elRef.current;
        if (open && el) {
          setHasSelection((el.selectionStart ?? 0) !== (el.selectionEnd ?? 0));
          const numeric = isNumberInput(el);
          setNumberMode(numeric);
          setNumberValue(numeric ? el.value : '');
        }
      }}
    >
      <ContextMenuTrigger asChild disabled={items.length === 0}>
        {React.cloneElement(children, {
          ref: setRef,
          onBlur:
            holdBlurWhileOpen && childOnBlur
              ? (e: React.FocusEvent<EditableEl>) => { if (!menuOpenRef.current) childOnBlur(e); }
              : childOnBlur,
        } as EditableProps)}
      </ContextMenuTrigger>
      <ContextMenuContent {...contentProps}>
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
