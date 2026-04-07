import React, { memo, useState, useCallback, useMemo } from 'react';
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

function ImageLightbox({ src, alt, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-gray-800 rounded-full text-white hover:bg-gray-700 transition-colors"
      >
        x
      </button>
    </div>
  );
}

function MessageAttachments({ attachments }) {
  const [lightboxSrc, setLightboxSrc] = useState(null);

  const parsed = useMemo(() => {
    if (!attachments) return [];
    try {
      return typeof attachments === 'string' ? JSON.parse(attachments) : attachments;
    } catch {
      return [];
    }
  }, [attachments]);

  if (parsed.length === 0) return null;

  // Build the display URL: prefer the server-hosted /uploads/ path
  const getDisplayUrl = (img) => {
    if (img.url) return img.url;
    if (img.dataUrl) return img.dataUrl;
    return null;
  };

  return (
    <>
      <div className={`flex flex-wrap gap-2 ${parsed.length > 0 ? 'mb-2' : ''}`}>
        {parsed.map((img, i) => {
          const src = getDisplayUrl(img);
          if (!src) return null;
          return (
            <img
              key={img.id || i}
              src={src}
              alt={img.originalName || img.name || 'attachment'}
              className="max-h-48 max-w-xs rounded-lg border border-gray-600/50 cursor-zoom-in hover:brightness-110 transition-all"
              onClick={() => setLightboxSrc(src)}
            />
          );
        })}
      </div>
      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc}
          alt="Full size image"
          onClose={() => setLightboxSrc(null)}
        />
      )}
    </>
  );
}

const ENGINE_BADGES = {
  'claude-code': { emoji: '🟣', label: 'Claude Code' },
  'cursor-agent': { emoji: '🟢', label: 'Cursor Agent' },
};

function ChatMessage({ message, agentColor, onDequeue }) {
  const isUser = message.role === 'user';
  const isQueued = message.queued;
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

  // Don't show "(image attached)" as text if it was auto-generated and there are actual attachments
  const displayContent = useMemo(() => {
    if (message.content === '(image attached)' && message.attachments) return '';
    return message.content;
  }, [message.content, message.attachments]);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[95%] sm:max-w-[90%] ${
          isUser
            ? isQueued
              ? 'bg-blue-600/40 border border-blue-500/30 rounded-2xl rounded-br-md px-4 py-2.5'
              : 'bg-blue-600 rounded-2xl rounded-br-md px-4 py-2.5'
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

        {/* Queued indicator */}
        {isQueued && (
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs text-blue-300/70 font-medium flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400/50 animate-pulse" />
              Queued
            </span>
            {onDequeue && (
              <button
                onClick={() => onDequeue(message.id)}
                className="text-xs text-blue-400/50 hover:text-red-400 transition-colors"
              >
                ✕ Remove
              </button>
            )}
          </div>
        )}

        {/* Render image attachments */}
        <MessageAttachments attachments={message.attachments} />

        <div className={isUser ? 'text-white' : 'markdown-content text-gray-200'}>
          {isUser ? (
            displayContent ? <p className="whitespace-pre-wrap">{displayContent}</p> : null
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
