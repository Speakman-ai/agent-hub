import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

export function extractText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node?.props?.children) return extractText(node.props.children);
  return '';
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
    if (!inline && extractText(children).includes('\n')) {
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
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

// Lightweight markdown components without the copy-button CodeBlock.
// Used by compact views like SessionTail where a full code toolbar is too heavy.
export const markdownComponentsCompact = {
  code({ inline, className, children, ...props }) {
    if (!inline && extractText(children).includes('\n')) {
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
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

export function MarkdownContent({ content, components: componentsProp, className }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={componentsProp || markdownComponents}
      className={className}
    >
      {content}
    </ReactMarkdown>
  );
}
