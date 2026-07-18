/** One editable watch-pattern row (WARDEN-540): an inline name field, the match
 *  expression, a string/regex mode selector, an enabled toggle, and delete. Mirrors
 *  SnippetRow's commit-on-blur discipline but persists through /api/config (server-
 *  side) rather than localStorage — the matcher runs in pollAgentStates, so the
 *  pattern must reach the backend. The list (`config.watchPatterns`) is the source of
 *  truth; this holds only the two editable drafts, re-synced on external change.
 *
 *  For mode 'regex', a live validity check (isValidRegex) warns when the expression
 *  won't compile — the backend matcher try/catches and skips an invalid pattern rather
 *  than throwing, but authoring-time feedback beats a silently-never-matching rule.
 *
 *  Extracted verbatim from SettingsPage (WARDEN-664); behavior is unchanged. */
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Trash2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type WatchPattern,
  WATCH_PATTERN_NAME_MAX,
  WATCH_PATTERN_EXPRESSION_MAX,
  isValidRegex,
} from '@/lib/storage';

export function PatternRow({
  pattern,
  onRename,
  onExpressionChange,
  onModeChange,
  onToggleEnabled,
  onDelete,
}: {
  pattern: WatchPattern;
  onRename: (id: string, newName: string) => boolean;
  onExpressionChange: (id: string, expression: string) => void;
  onModeChange: (id: string, mode: 'string' | 'regex') => void;
  onToggleEnabled: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(pattern.name);
  const [exprDraft, setExprDraft] = useState(pattern.expression);
  useEffect(() => { setNameDraft(pattern.name); }, [pattern.name]);
  useEffect(() => { setExprDraft(pattern.expression); }, [pattern.expression]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== pattern.name) {
      if (!onRename(pattern.id, trimmed)) setNameDraft(pattern.name); // revert on rejection
    } else {
      setNameDraft(pattern.name); // empty or unchanged → revert
    }
  };
  const commitExpr = () => {
    const trimmed = exprDraft.trim();
    if (trimmed) {
      onExpressionChange(pattern.id, trimmed);
    } else {
      setExprDraft(pattern.expression); // empty → revert (never persist an empty expression)
    }
  };

  // Only flag an invalid regex once the user has typed something — an empty draft is
  // the "not yet editing" state, not a malformed rule.
  const regexInvalid = pattern.mode === 'regex' && exprDraft.trim().length > 0 && !isValidRegex(exprDraft);

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setNameDraft(pattern.name);
          }}
          className="h-8 flex-1"
          placeholder="name (e.g. Deploy failed)"
          aria-label="Pattern name"
          maxLength={WATCH_PATTERN_NAME_MAX}
        />
        {/* Enabled toggle: silence a pattern without deleting it. */}
        <IconTooltip label={pattern.enabled ? 'disable — stop alerting on this pattern' : 'enable — alert when this matches'}>
          <Switch
            checked={pattern.enabled}
            onCheckedChange={() => onToggleEnabled(pattern.id)}
            aria-label={`Toggle ${pattern.name} pattern`}
          />
        </IconTooltip>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onDelete(pattern.id)}
          aria-label={`Delete ${pattern.name} pattern`}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={exprDraft}
          onChange={(e) => setExprDraft(e.target.value)}
          onBlur={commitExpr}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setExprDraft(pattern.expression);
          }}
          className="h-8 flex-1"
          placeholder={pattern.mode === 'regex' ? 'regex (e.g. payment (required|due))' : 'text to match (e.g. merge conflict)'}
          aria-label={`${pattern.name} match expression`}
          maxLength={WATCH_PATTERN_EXPRESSION_MAX}
        />
        <Select
          value={pattern.mode}
          onValueChange={(v) => onModeChange(pattern.id, v === 'regex' ? 'regex' : 'string')}
        >
          <SelectTrigger className="h-8 w-[104px]" aria-label="Match mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">text</SelectItem>
            <SelectItem value="regex">regex</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {regexInvalid && (
        <p className="text-xs text-red-500">Invalid regex — it will be skipped until fixed.</p>
      )}
    </div>
  );
}
