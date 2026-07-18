// Watch patterns section (WARDEN-540) — backend /api/config (the matcher runs in
// pollAgentStates server-side, so patterns MUST reach the backend, unlike
// presets/snippets which stay client-side). The pattern CRUD is relocated here
// verbatim from SettingsPage (WARDEN-664): each handler operates only on
// `config`/`setConfig` this section receives, so behavior is unchanged.
import { useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type PatternNameIssue,
  WATCH_PATTERN_NAME_MAX,
  WATCH_PATTERN_EXPRESSION_MAX,
  WATCH_PATTERN_MAX_COUNT,
  validatePatternName,
  isValidRegex,
} from '@/lib/storage';
import { PatternRow } from '../rows/PatternRow';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig } from '../types';

export interface PatternsSectionProps {
  config: ConfigData;
  setConfig: SetConfig;
  hidden: boolean;
}

export function PatternsSection({ config, setConfig, hidden }: PatternsSectionProps) {
  // ─── Watch patterns (WARDEN-540) ────────────────────────────────────────────
  // CRUD over config.watchPatterns (server-side, round-tripped via /api/config on
  // Save). Each pattern is keyed by a stable id (so a rename never confuses the row),
  // unlike snippets which key on name. The new-pattern form mirrors the snippet form.
  const [newPatternName, setNewPatternName] = useState('');
  const [newPatternExpression, setNewPatternExpression] = useState('');
  const [newPatternMode, setNewPatternMode] = useState<'string' | 'regex'>('string');

  const patternNameErrorMessage = (name: string, issue: PatternNameIssue): string => {
    switch (issue) {
      case 'empty': return 'Pattern needs a name.';
      case 'too-long': return `Pattern name must be ${WATCH_PATTERN_NAME_MAX} characters or fewer.`;
      case 'duplicate': return `A pattern named "${name}" already exists.`;
    }
  };

  // Stable id for a new pattern. crypto.randomUUID is available in every target
  // (mirrors genWorkspaceId in storage.ts); the fallback covers an older webview.
  const genPatternId = (): string =>
    globalThis.crypto?.randomUUID?.() ?? `wp-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  const addPattern = () => {
    const name = newPatternName.trim();
    const expression = newPatternExpression.trim();
    if (!name || !expression) {
      toast.error('Pattern needs both a name and an expression.');
      return;
    }
    if (config.watchPatterns.length >= WATCH_PATTERN_MAX_COUNT) {
      toast.error(`You can have at most ${WATCH_PATTERN_MAX_COUNT} watch patterns.`);
      return;
    }
    const issue = validatePatternName(name, config.watchPatterns);
    if (issue) {
      toast.error(patternNameErrorMessage(name, issue));
      return;
    }
    if (newPatternMode === 'regex' && !isValidRegex(expression)) {
      toast.error('That regex is invalid — fix it before adding.');
      return;
    }
    setConfig({
      ...config,
      watchPatterns: [...config.watchPatterns, { id: genPatternId(), name, expression, mode: newPatternMode, enabled: true }],
    });
    setNewPatternName('');
    setNewPatternExpression('');
    setNewPatternMode('string');
  };

  // Returns true on success (PatternRow reverts its draft on false). Validates the
  // name through the shared contract so a duplicate/oversize name can never persist.
  const renamePattern = (id: string, newName: string): boolean => {
    const issue = validatePatternName(newName, config.watchPatterns, id);
    if (issue) {
      if (issue !== 'empty') toast.error(patternNameErrorMessage(newName.trim(), issue));
      return false;
    }
    const name = newName.trim();
    setConfig({ ...config, watchPatterns: config.watchPatterns.map((p) => (p.id === id ? { ...p, name } : p)) });
    return true;
  };

  const updatePatternExpression = (id: string, expression: string) => {
    const trimmed = expression.trim();
    if (!trimmed) return; // never persist an empty expression
    setConfig({ ...config, watchPatterns: config.watchPatterns.map((p) => (p.id === id ? { ...p, expression: trimmed } : p)) });
  };

  const setPatternMode = (id: string, mode: 'string' | 'regex') => {
    setConfig({ ...config, watchPatterns: config.watchPatterns.map((p) => (p.id === id ? { ...p, mode } : p)) });
  };

  const togglePatternEnabled = (id: string) => {
    setConfig({ ...config, watchPatterns: config.watchPatterns.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)) });
  };

  const deletePattern = (id: string) => {
    setConfig({ ...config, watchPatterns: config.watchPatterns.filter((p) => p.id !== id) });
  };

  return (
    <SettingsSection title="Watch patterns" className={hidden ? 'hidden' : undefined}>
      <p className="text-xs text-muted-foreground">
        Get pinged when a watched agent prints specific text — a deploy failure, a merge conflict, a paywall page, anything the built-in categories are blind to. Patterns match only over output already captured for watched chats (no extra SSH cost). Disable a pattern to silence it without deleting.
      </p>
      <div className="flex flex-col gap-2">
        {config.watchPatterns.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No patterns yet. Add one like <code className="rounded bg-muted px-1">merge conflict</code> (text) or <code className="rounded bg-muted px-1">payment (required|due)</code> (regex).
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {config.watchPatterns.map((p) => (
              <PatternRow
                key={p.id}
                pattern={p}
                onRename={renamePattern}
                onExpressionChange={updatePatternExpression}
                onModeChange={setPatternMode}
                onToggleEnabled={togglePatternEnabled}
                onDelete={deletePattern}
              />
            ))}
          </div>
        )}

        {/* Add a new pattern */}
        <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
          <Input
            value={newPatternName}
            onChange={(e) => setNewPatternName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addPattern(); }
            }}
            className="h-8"
            placeholder="name (e.g. Deploy failed)"
            aria-label="New pattern name"
            maxLength={WATCH_PATTERN_NAME_MAX}
          />
          <div className="flex items-center gap-2">
            <Input
              value={newPatternExpression}
              onChange={(e) => setNewPatternExpression(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addPattern(); }
              }}
              className="h-8 flex-1"
              placeholder={newPatternMode === 'regex' ? 'regex (e.g. payment (required|due))' : 'text to match (e.g. merge conflict)'}
              aria-label="New pattern expression"
              maxLength={WATCH_PATTERN_EXPRESSION_MAX}
            />
            <Select
              value={newPatternMode}
              onValueChange={(v) => setNewPatternMode(v === 'regex' ? 'regex' : 'string')}
            >
              <SelectTrigger className="h-8 w-[104px]" aria-label="New pattern match mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="string">text</SelectItem>
                <SelectItem value="regex">regex</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {newPatternMode === 'regex' && newPatternExpression.trim().length > 0 && !isValidRegex(newPatternExpression) && (
            <p className="text-xs text-red-500">That regex is invalid.</p>
          )}
          <Button variant="outline" size="sm" className="w-full" onClick={addPattern}>
            Add pattern
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Patterns evaluate over watched chats only. <strong>text</strong> = case-insensitive substring; <strong>regex</strong> = case-insensitive regular expression. Names must be unique.
        </p>
      </div>
    </SettingsSection>
  );
}
