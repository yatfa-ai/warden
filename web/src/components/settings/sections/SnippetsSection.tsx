// Instruction snippets section (WARDEN-323) — pure client localStorage prefs.
// The snippet CRUD is relocated here verbatim from SettingsPage (WARDEN-664):
// each handler operates only on `snippets`/`setSnippets` this section receives,
// so behavior is unchanged.
import { useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  type SnippetNameIssue,
  SNIPPET_NAME_MAX,
  SNIPPET_TEXT_MAX,
  validateSnippetName,
} from '@/lib/storage';
import { SnippetRow } from '../rows/SnippetRow';
import { SettingsSection } from '../SettingsSection';
import { type SnippetsPrefs } from '../types';

export type SnippetsSectionProps = SnippetsPrefs & { hidden: boolean };

export function SnippetsSection(props: SnippetsSectionProps) {
  const { snippets, setSnippets, hidden } = props;

  // --- Instruction-snippet management (create / rename / edit-text / delete) --
  // All pure client-side: edits apply instantly via setSnippets and are
  // persisted by App's saveUi effect. Mirrors the custom-preset handlers; the
  // differences are the {name, text} shape, a text-edit handler, and NO reserved
  // built-in names (so validateSnippetName has no 'reserved' case). The starter
  // set the library seeds on first run (WARDEN-323) renders here as ordinary
  // editable entries — rename, edit text, or delete like any user-created
  // snippet; once deleted, they stay deleted.
  const [newSnippetName, setNewSnippetName] = useState('');
  const [newSnippetText, setNewSnippetText] = useState('');

  // Human message for a non-null snippet-name validation issue. The contract
  // itself lives in storage.ts (validateSnippetName); this just renders it.
  const snippetNameErrorMessage = (name: string, issue: SnippetNameIssue): string => {
    switch (issue) {
      case 'empty': return 'Snippet needs a name.';
      case 'too-long': return `Snippet name must be ${SNIPPET_NAME_MAX} characters or fewer.`;
      case 'duplicate': return `A snippet named "${name}" already exists.`;
    }
  };

  const addSnippet = () => {
    const name = newSnippetName.trim();
    const text = newSnippetText.trim();
    if (!name || !text) {
      toast.error('Snippet needs both a name and instruction text.');
      return;
    }
    const issue = validateSnippetName(name, snippets);
    if (issue) {
      toast.error(snippetNameErrorMessage(name, issue));
      return;
    }
    setSnippets([...snippets, { name, text }]);
    setNewSnippetName('');
    setNewSnippetText('');
  };

  // Returns true on success (SnippetRow reverts its draft on false). Validates
  // through the shared storage contract so a name the load-time sanitizer would
  // drop (too long / duplicate) can never be persisted.
  const renameSnippet = (oldName: string, newName: string): boolean => {
    const issue = validateSnippetName(newName, snippets, oldName);
    if (issue) {
      // commitName already reverts an empty draft silently before calling us;
      // only surface a toast for the rejectable issues.
      if (issue !== 'empty') toast.error(snippetNameErrorMessage(newName.trim(), issue));
      return false;
    }
    const name = newName.trim();
    setSnippets(snippets.map((s) => (s.name === oldName ? { ...s, name } : s)));
    return true;
  };

  const updateSnippetText = (name: string, text: string) => {
    const trimmed = text.trim();
    // Never persist an empty text — parseSnippets would drop the whole snippet
    // on next reload (silent data loss). SnippetRow also reverts an empty draft
    // on blur, but this guards the contract at the write site itself.
    if (!trimmed) return;
    setSnippets(snippets.map((s) => (s.name === name ? { ...s, text: trimmed } : s)));
  };

  const deleteSnippet = (name: string) => {
    setSnippets(snippets.filter((s) => s.name !== name));
  };

  return (
    <SettingsSection title="Instruction snippets" className={hidden ? 'hidden' : undefined}>
      <p className="text-xs text-muted-foreground">
        Save instructions you send often ("run the tests", "pull latest", "commit your work") and reuse them from the Broadcast dialog or a pane's right-click menu. New installs start with a few examples you can edit or delete.
      </p>
      <div className="flex flex-col gap-2">
        {snippets.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No snippets yet. Add one to reuse common instructions like 'run the tests' across your fleet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {snippets.map((s) => (
              <SnippetRow
                key={s.name}
                snippet={s}
                onRename={renameSnippet}
                onTextChange={updateSnippetText}
                onDelete={deleteSnippet}
              />
            ))}
          </div>
        )}

        {/* Add a new snippet */}
        <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
          <Input
            value={newSnippetName}
            onChange={(e) => setNewSnippetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addSnippet();
              }
            }}
            className="h-8"
            placeholder="name (e.g. Run tests)"
            aria-label="New snippet name"
            maxLength={SNIPPET_NAME_MAX}
          />
          <Textarea
            value={newSnippetText}
            onChange={(e) => setNewSnippetText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                addSnippet();
              }
            }}
            className="min-h-[60px] text-sm"
            placeholder="instruction (e.g. run the test suite)"
            aria-label="New snippet instruction text"
            maxLength={SNIPPET_TEXT_MAX}
          />
          <Button variant="outline" size="sm" className="w-full" onClick={addSnippet}>
            Add snippet
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Snippets appear in the Broadcast dialog (insert into the message, then confirm Send) and in a pane's right-click menu (one-click send to that agent). Names must be unique.
        </p>
      </div>
    </SettingsSection>
  );
}
