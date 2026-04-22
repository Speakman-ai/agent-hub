import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { resolveServerMediaUrl } from '../utils/resolveServerMediaUrl.js';

export function extractText(node) {
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
export function markdownCodeIsBlock({ inline, className, children }) {
  if (inline === true) return false;
  if (inline === false) return true;
  const cls = typeof className === 'string' ? className : '';
  if (/\bhljs\b|language-/.test(cls)) return true;
  // mdast fenced `code` always appends `\n` to the text; inlineCode collapses newlines to spaces.
  if (/\n/.test(extractText(children))) return true;
  return false;
}

export function CodeBlock({ children, className }) {
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
  code({ node: _node, inline, className, children, ...props }) {
    if (markdownCodeIsBlock({ inline, className, children })) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ href, children, ...props }) {
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
  img({ src, alt, ...props }) {
    return <img src={src ? resolveServerMediaUrl(src) : src} alt={alt} {...props} />;
  },
};

// Lightweight markdown components without the copy-button CodeBlock.
// Used by compact views like SessionTail where a full code toolbar is too heavy.
export const markdownComponentsCompact = {
  code({ inline, className, children, ...props }) {
    if (markdownCodeIsBlock({ inline, className, children })) {
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
  a({ href, children, ...props }) {
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
  img({ src, alt, ...props }) {
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
  a({ href, children, onClick, ...props }) {
    return (
      <a
        href={href ? resolveServerMediaUrl(href) : href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
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
}) {
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
