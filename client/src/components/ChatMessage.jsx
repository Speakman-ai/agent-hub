import React, { memo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { relativeTime } from '../utils/time.js';

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

function ChatMessage({ message, agentColor }) {
  const isUser = message.role === 'user';
  const engineBadge = !isUser && message.engine ? ENGINE_BADGES[message.engine] : null;
  const modelLabel = !isUser && message.model ? message.model.replace('claude-', '').replace('-', ' ') : null;

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
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[90%] sm:max-w-[80%] ${
          isUser
            ? 'bg-blue-600 rounded-2xl rounded-br-md px-4 py-2.5'
            : 'bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3'
        }`}
      >
        {!isUser && (
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
            {modelLabel && (
              <span className="text-xs text-gray-600">· {modelLabel}</span>
            )}
          </div>
        )}
        <div className={isUser ? 'text-white' : 'markdown-content text-gray-200'}>
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
              {message.content}
            </ReactMarkdown>
          )}
        </div>
        <div
          className={`text-xs mt-1 ${isUser ? 'text-blue-300' : 'text-gray-600'}`}
        >
          {message.created_at && relativeTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}

export default memo(ChatMessage);
