/** One editable instruction-snippet row: an inline name field (committed on
 *  blur/Enter, reverted on a rejected rename) and a live-editable text field
 *  (the instruction itself — free-form, so a Textarea), plus delete. Stateless
 *  w.r.t. its own value except the two drafts — the list is the source of truth.
 *  Mirrors PresetRow; the only structural difference is Textarea vs Input for
 *  the body (instructions are multi-line free text up to SNIPPET_TEXT_MAX chars,
 *  not a single spawn command).
 *
 *  Extracted verbatim from SettingsPage (WARDEN-664); behavior is unchanged. */
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Trash2 } from 'lucide-react';
import { type Snippet, SNIPPET_NAME_MAX, SNIPPET_TEXT_MAX } from '@/lib/storage';

export function SnippetRow({
  snippet,
  onRename,
  onTextChange,
  onDelete,
}: {
  snippet: Snippet;
  onRename: (oldName: string, newName: string) => boolean;
  onTextChange: (name: string, text: string) => void;
  onDelete: (name: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(snippet.name);
  const [textDraft, setTextDraft] = useState(snippet.text);
  // Re-sync the drafts if the snippet changes from the outside (e.g. after a
  // coordinated load), so the inputs never drift.
  useEffect(() => {
    setNameDraft(snippet.name);
  }, [snippet.name]);
  useEffect(() => {
    setTextDraft(snippet.text);
  }, [snippet.text]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== snippet.name) {
      if (!onRename(snippet.name, trimmed)) setNameDraft(snippet.name); // revert on rejection
    } else {
      setNameDraft(snippet.name); // empty or unchanged → revert
    }
  };

  // Commit the text on blur, mirroring commitName: free-edit while focused, but
  // never persist an empty text — parseSnippets would drop the whole snippet on
  // next reload (silent data loss). Empty on commit reverts to the last saved
  // value, so the field is editable but never goes dangling.
  const commitText = () => {
    const trimmed = textDraft.trim();
    if (trimmed) {
      onTextChange(snippet.name, trimmed);
    } else {
      setTextDraft(snippet.text); // empty → revert
    }
  };

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setNameDraft(snippet.name);
          }}
          className="h-8 flex-1"
          placeholder="name"
          aria-label="Snippet name"
          maxLength={SNIPPET_NAME_MAX}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onDelete(snippet.name)}
          aria-label={`Delete ${snippet.name} snippet`}
        >
          <Trash2 />
        </Button>
      </div>
      <Textarea
        value={textDraft}
        onChange={(e) => setTextDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          // Enter inserts a newline in a Textarea; ⌘/Ctrl+Enter commits.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') setTextDraft(snippet.text);
        }}
        className="min-h-[60px] text-sm"
        placeholder="the instruction to send"
        aria-label={`${snippet.name} instruction text`}
        maxLength={SNIPPET_TEXT_MAX}
      />
    </div>
  );
}
