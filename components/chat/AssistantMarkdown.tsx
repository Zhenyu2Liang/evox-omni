'use client';

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Keep model-authored URLs inert unless their scheme is supported by the chat surface. */
export function safeMarkdownUrl(value: string): string {
  const safe = defaultUrlTransform(value);
  if (!safe || safe.startsWith('//')) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(safe)?.[1]?.toLowerCase();
  return !scheme || ['https', 'http', 'mailto'].includes(scheme) ? safe : '';
}

export interface AssistantMarkdownProps {
  text: string;
  className?: string;
}

/** Render factual assistant text only. HTML and remote image requests are disabled. */
export function AssistantMarkdown({ text, className }: AssistantMarkdownProps) {
  return (
    <div data-assistant-content="true" className={[
      'min-w-0 break-words text-sm leading-relaxed', className,
    ].filter(Boolean).join(' ')}>
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl}
        components={{
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h2>,
          h2: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h3>,
          h3: ({ children }) => <h4 className="mb-2 mt-3 font-semibold first:mt-0">{children}</h4>,
          h4: ({ children }) => <h5 className="mb-2 mt-3 font-semibold first:mt-0">{children}</h5>,
          h5: ({ children }) => <h6 className="mb-2 mt-3 font-semibold first:mt-0">{children}</h6>,
          h6: ({ children }) => <p className="mb-2 mt-3 font-semibold first:mt-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-banking-accent/40 pl-3 text-banking-navy">{children}</blockquote>,
          pre: ({ children }) => <pre className="my-3 max-w-full overflow-x-auto rounded-lg bg-banking-subtle p-3 text-xs leading-5">{children}</pre>,
          code: ({ children, className: languageClass }) => <code className={languageClass ?? 'rounded-sm bg-banking-subtle px-1 py-0.5 font-mono text-[0.9em]'}>{children}</code>,
          table: ({ children }) => <div className="my-3 max-w-full overflow-x-auto rounded-lg border border-banking-border"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
          th: ({ children }) => <th className="border-b border-banking-border bg-banking-light px-3 py-2 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b border-banking-border/60 px-3 py-2 align-top">{children}</td>,
          hr: () => <hr className="my-4 border-banking-border" />,
          a: ({ children, href }) => href
            ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-banking-accent/50 underline-offset-2 hover:text-banking-accent">{children}</a>
            : <span>{children}</span>,
          img: ({ alt }) => <span className="text-banking-navy">{alt}</span>,
          input: ({ checked }) => <input type="checkbox" checked={checked ?? false} disabled readOnly className="mr-1 align-middle" />,
        }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
