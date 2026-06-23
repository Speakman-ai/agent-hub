import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { resolveServerMediaUrl } from '../utils/resolveServerMediaUrl';
import MermaidDiagram from './MermaidDiagram';

/** Extract `mermaid` from `language-mermaid` etc. Returns '' for no/empty class. */
export function fencedCodeLanguage(className: any) {
  const cls = typeof className === 'string' ? className : '';
  const match = /\blanguage-([\w-]+)/.exec(cls);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Inspect the hast node react-markdown passes to a `<pre>` component and
 * decide whether the wrapped code is a mermaid fence. We need this because
 * react-markdown structures fenced code as `<pre><code class="language-X">…</code></pre>`,
 * and we want mermaid diagrams rendered *outside* the monospace `<pre>`.
 */
export function preChildIsMermaidFence(node: any) {
  const codeNode = node?.children?.find((c: any) => c?.tagName === 'code');
  if (!codeNode) return false;
  const cls = codeNode?.properties?.className;
  const classStr = Array.isArray(cls) ? cls.join(' ') : typeof cls === 'string' ? cls : '';
  return fencedCodeLanguage(classStr) === 'mermaid';
}

export function extractText(node: any): any {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node?.props?.children) return extractText(node.props.children);
  return '';
}

/**
 * Whether this `code` element is a fenced block vs inline backticks.
 * react-markdown 9 + hast-util-to-jsx-runtime often omit `inline` on custom
 * components (undefined for both), so `!inline` would wrongly treat inline as block.
 */
export function markdownCodeIsBlock({ inline, className, children }: any) {
  if (inline === true) return false;
  if (inline === false) return true;
  const cls = typeof className === 'string' ? className : '';
  if (/\bhljs\b|language-/.test(cls)) return true;
  // mdast fenced `code` always appends `\n` to the text; inlineCode collapses newlines to spaces.
  if (/\n/.test(extractText(children))) return true;
  return false;
}

export function CodeBlock({ children, className }: any) {
  const [copied, setCopied] = useState(false);
  const plainText = extractText(children).replace(/\n$/, '');
  const language = className?.replace('language-', '') || '';

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(plainText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [plainText]);

  return (
    <div className="relative group my-2">
      <div className="flex items-center justify-between bg-gray-950 rounded-t-lg px-4 py-1.5 text-xs text-gray-500">
        <span>{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-gray-400 hover:text-white px-2 py-1 rounded min-h-[32px]"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre className="!rounded-t-none !mt-0 overflow-x-auto">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export const markdownComponents = {
  code({ node: _node, inline, className, children, ...props }: any) {
    if (markdownCodeIsBlock({ inline, className, children })) {
      if (fencedCodeLanguage(className) === 'mermaid') {
        const source = extractText(children).replace(/\n$/, '');
        return <MermaidDiagram source={source} />;
      }
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ node, children, ...props }: any) {
    // For mermaid fences, the child `code` component already returns a
    // self-contained <MermaidDiagram>; wrapping it in <pre> would force
    // monospace styling and a horizontal scrollbar around the SVG.
    if (preChildIsMermaidFence(node)) return <>{children}</>;
    return <pre {...props}>{children}</pre>;
  },
  a({ href, children, ...props }: any) {
    return (
      <a
        href={href ? resolveServerMediaUrl(href) : href}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    );
  },
  img({ src, alt, ...props }: any) {
    return <img src={src ? resolveServerMediaUrl(src) : src} alt={alt} {...props} />;
  },
};

// Lightweight markdown components without the copy-button CodeBlock.
// Used by compact views like SessionTail where a full code toolbar is too heavy.
export const markdownComponentsCompact = {
  code({ inline, className, children, ...props }: any) {
    if (markdownCodeIsBlock({ inline, className, children })) {
      if (fencedCodeLanguage(className) === 'mermaid') {
        const source = extractText(children).replace(/\n$/, '');
        return <MermaidDiagram source={source} />;
      }
      return (
        <pre className="bg-gray-950 rounded p-2 overflow-x-auto text-xs my-2">
          <code className={className}>{children}</code>
        </pre>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ node, children, ...props }: any) {
    if (preChildIsMermaidFence(node)) return <>{children}</>;
    return <pre {...props}>{children}</pre>;
  },
  a({ href, children, ...props }: any) {
    return (
      <a
        href={href ? resolveServerMediaUrl(href) : href}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    );
  },
  img({ src, alt, ...props }: any) {
    return <img src={src ? resolveServerMediaUrl(src) : src} alt={alt} {...props} />;
  },
};

/**
 * Board card face: same as `markdownComponentsCompact`, but in-description links
 * call `stopPropagation` so the parent card row’s `onClick` (open detail) does not
 * also fire (matches `pr_url` / GitHub link handling on the same row).
 */
export const markdownComponentsKanbanCardSnippet = {
  ...markdownComponentsCompact,
  a({ href, children, onClick, ...props }: any) {
    return (
      <a
        href={href ? resolveServerMediaUrl(href) : href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e: any) => {
          onClick?.(e);
          e.stopPropagation();
        }}
        {...props}
      >
        {children}
      </a>
    );
  },
};

/** Renders GFM markdown. Default `rehypePlugins` includes syntax highlighting; pass `[]` to skip (e.g. kanban card snippets). */
export function MarkdownContent({
  content,
  components: componentsProp,
  className,
  rehypePlugins: rehypePluginsProp,
}: any) {
  const rehypePlugins = rehypePluginsProp !== undefined ? rehypePluginsProp : [rehypeHighlight];
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={componentsProp || markdownComponents}
      className={className}
    >
      {content}
    </ReactMarkdown>
  );
}
