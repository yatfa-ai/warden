import { MarkdownBody } from './MarkdownBody';

// Markdown renderer for observer (assistant) messages. Wraps the shared
// MarkdownBody in an observer-specific container so block elements are spaced
// with a flex/gap wrapper and the `observer-markdown` class stays stable for any
// downstream targeting. The element styling itself lives in MarkdownBody, shared
// with the file-viewer rendered-doc view (WARDEN-266) so docs and observer
// output read as one system.
export function ObserverMarkdown({ children }: { children: string }) {
  return (
    <div className="observer-markdown flex flex-col gap-2 text-sm leading-relaxed">
      <MarkdownBody>{children}</MarkdownBody>
    </div>
  );
}
