import { useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { resolveDocRelative } from '@/lib/docLinks';
import { copyText } from '@/lib/clipboard';

// A fenced code block with a language label + copy button. The raw text and
// language are pulled from the `<code>` child react-markdown renders inside the
// `<pre>` so we can replace the whole block with our own styled shell.
function CodeBlock({ language, children }: { language?: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between border-b bg-muted/60 px-2 py-1">
        <span className="text-xs text-muted-foreground">{language || 'code'}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={copy}
          aria-label="Copy code"
          title="Copy code"
        >
          {copied ? <CheckIcon className="text-green-500" /> : <CopyIcon />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className="font-mono whitespace-pre">{children}</code>
      </pre>
    </div>
  );
}

// Shared styled GFM markdown renderer. Styled entirely through this `components`
// map + Tailwind classes — no typography plugin, no CSS file. This is the single
// source of truth for how markdown renders across the app, so observer (LLM)
// message text (ObserverMarkdown) and file-viewer rendered docs (FileViewer,
// WARDEN-266) provably read as one system. Each caller wraps this in its own
// container; this component only owns the element styling.
//
// In-doc relative file links (WARDEN-805): when BOTH `baseFilePath` (the doc's
// repo-relative path) and `onOpenPath` are passed, a relative href like
// `[setup](./INSTALL.md)` or `[utils](../lib/utils.ts)` is resolved against the
// doc's directory and rendered as an in-app link that swaps the viewer in place
// via `onOpenPath(resolved)`. A real `href` (the resolved repo-relative path) is
// kept so the browser's context-menu (copy link / open in new tab) still works.
// When neither prop is passed — or the resolver returns null for a non-relative
// href (http(s), mailto, anchors, …) — links render exactly as before:
// `target="_blank" rel="noreferrer noopener"`. ObserverMarkdown and
// DirectiveHistory pass neither prop, so they are byte-for-byte unchanged.
export function MarkdownBody({
  children,
  baseFilePath,
  onOpenPath,
}: {
  children: string;
  baseFilePath?: string;
  onOpenPath?: (resolvedPath: string) => void;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
        h4: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
        h5: ({ children }) => <h5 className="text-xs font-semibold">{children}</h5>,
        h6: ({ children }) => <h6 className="text-xs font-semibold text-muted-foreground">{children}</h6>,
        p: ({ children }) => <p className="m-0">{children}</p>,
        a: ({ children, href }) => {
          // Resolve relative file refs (./x, ../y, dir/z.md) against the doc's
          // dir ONLY when both opt-in props are present; null otherwise (every
          // non-relative href, or no-resolver contexts like ObserverMarkdown).
          const resolved =
            href && onOpenPath && baseFilePath ? resolveDocRelative(baseFilePath, href) : null;
          if (resolved !== null && onOpenPath) {
            // In-app nav: swap the viewer in place. preventDefault so the real
            // href (the resolved repo-relative path, kept for copy-link/open-in-
            // new-tab) does not also navigate the browser.
            return (
              <a
                href={resolved}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenPath(resolved);
                }}
                className="text-primary underline underline-offset-2"
              >
                {children}
              </a>
            );
          }
          return (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2">
              {children}
            </a>
          );
        },
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        ul: ({ children }) => <ul className="m-0 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="m-0 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => {
          // Tighten nested paragraphs inside list items.
          const compacted = unwrapSingleParagraph(children);
          return <li className="marker:text-muted-foreground">{compacted}</li>;
        },
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-border pl-3 italic text-muted-foreground">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="border-border" />,
        table: ({ children }) => (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
        th: ({ children }) => (
          <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>
        ),
        td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
        // Fenced code blocks: react-markdown renders <pre><code class="language-x">.
        // We intercept <pre> and promote it to a styled CodeBlock with a copy
        // button. Inline `code` (no language, single line) stays a plain code tag.
        pre: ({ children }) => {
          const code = onlyElement(children);
          const className: string = code?.props?.className || '';
          const match = /language-(\w+)/.exec(className);
          const raw = String(code?.props?.children ?? '').replace(/\n$/, '');
          return <CodeBlock language={match?.[1]}>{raw}</CodeBlock>;
        },
        code: ({ children }) => (
          <code className="rounded bg-muted px-1 py-0.5 font-mono">{children}</code>
        ),
      }}
    >
      {children}
    </Markdown>
  );
}

// react-markdown wraps loose list-item text in <p>; collapse a single-child <p>
// so list rows aren't double-spaced. Passes anything else through untouched.
function unwrapSingleParagraph(node: ReactNode): ReactNode {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === 'p' && el.props) return el.props.children;
  }
  return node;
}

// Pull the first (and normally only) React element child out of react-markdown's
// children, tolerating the arrays/whitespace it sometimes wraps around it.
function onlyElement(children: ReactNode): { props?: { className?: string; children?: ReactNode } } | null {
  if (Array.isArray(children)) {
    return children.find((c) => c && typeof c === 'object') as { props?: { className?: string; children?: ReactNode } } | null;
  }
  if (children && typeof children === 'object') {
    return children as { props?: { className?: string; children?: ReactNode } };
  }
  return null;
}
