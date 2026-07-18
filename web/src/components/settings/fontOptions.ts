// Terminal font-family select options for the Appearance section. Curated
// common monospace fonts; "Custom…" reveals a free-text input. Pure data, no
// JSX, so it lives outside the component to keep the section file readable.
import { DEFAULT_TERMINAL_FONT_FAMILY } from '@/lib/storage';

// Each `value` is a complete, valid CSS font-family string (the chosen face
// first, then sane monospace fallbacks) so it can be passed straight to xterm.
// "System default" maps to DEFAULT_TERMINAL_FONT_FAMILY (today's exact stack).
// Anything not in this list is "Custom…" (free-text input in the section).
export const TERMINAL_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'System default', value: DEFAULT_TERMINAL_FONT_FAMILY },
  { label: 'Cascadia Code', value: '"Cascadia Code", "JetBrains Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'Fira Code', value: '"Fira Code", "JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'Source Code Pro', value: '"Source Code Pro", "JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'Menlo', value: 'Menlo, "Cascadia Code", "JetBrains Mono", ui-monospace, Consolas, monospace' },
  { label: 'Consolas', value: 'Consolas, "Cascadia Code", "JetBrains Mono", ui-monospace, Menlo, monospace' },
];

// Sentinel value the Select uses to mean "show the free-text Custom input".
// (Radix Select forbids an empty-string option value, so this is non-empty.)
export const CUSTOM_FONT_VALUE = '__custom__';
