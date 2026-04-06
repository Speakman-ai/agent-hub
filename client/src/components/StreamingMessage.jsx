import React, { memo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

function CodeBlock({ children, className }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, '');
  const language = className?.replace('language-', '') || '';

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

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
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
}

const ENGINE_BADGES = {
  'claude-code': { emoji: '🟣', label: 'Claude Code' },
  'cursor-agent': { emoji: '🟢', label: 'Cursor Agent' },
};

function StreamingMessage({ content, agentColor, engine }) {
  const engineBadge = engine ? ENGINE_BADGES[engine] : null;
  const components = {
    code({ node, inline, className, children, ...props }) {
      if (!inline && String(children).includes('\n')) {
        return <CodeBlock className={className}>{children}</CodeBlock>;
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[90%] sm:max-w-[80%] bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: agentColor }}
          />
          <span className="text-xs text-gray-500 font-medium">Assistant</span>
          {engineBadge && (
            <span className="text-xs text-gray-600 flex items-center gap-1" title={engineBadge.label}>
              <span className="text-[10px]">{engineBadge.emoji}</span>
              <span className="hidden sm:inline">{engineBadge.label}</span>
            </span>
          )}
          <span className="flex items-center gap-1 ml-1">
            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-xs text-emerald-500">streaming</span>
          </span>
        </div>
        <div className="markdown-content text-gray-200">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

export default memo(StreamingMessage);
