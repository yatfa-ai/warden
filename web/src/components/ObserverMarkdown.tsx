import { MarkdownBody } from './MarkdownBody';
import type { IssueLinkEntry } from '@/lib/issue-links';

// Markdown renderer for observer (assistant) messages. Wraps the shared
// MarkdownBody in an observer-specific container so block elements are spaced
// with a flex/gap wrapper and the `observer-markdown` class stays stable for any
// downstream targeting. The element styling itself lives in MarkdownBody, shared
// with the file-viewer rendered-doc view (WARDEN-266) so docs and observer
// output read as one system.
//
// `issueEntries` (WARDEN-1394) is an optional pass-through: when the caller
// hands over configured tracker entries (App → ObserverTabs → here, only while
// the integration is enabled) MarkdownBody registers the remarkIssueLinks
// plugin and recognized issue keys render as links. Undefined (the default)
// renders byte-identically to before this prop existed.
export function ObserverMarkdown({ children, issueEntries }: { children: string; issueEntries?: IssueLinkEntry[] }) {
  return (
    <div className="observer-markdown flex flex-col gap-2 text-sm leading-relaxed">
      <MarkdownBody issueEntries={issueEntries}>{children}</MarkdownBody>
    </div>
  );
}
