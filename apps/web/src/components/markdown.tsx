import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Renders agent-written markdown. Raw HTML is never rendered (react-markdown's default), and links open safely. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-sm min-w-0 max-w-none space-y-3 text-sm [overflow-wrap:anywhere] [&_pre]:[overflow-wrap:normal] leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
