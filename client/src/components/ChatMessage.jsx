import React, { memo, useState, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { relativeTime } from '../utils/time.js';
import { getServerBase } from '../utils/connection.js';

function extractText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node?.props?.children) return extractText(node.props.children);
  return '';
}

function CodeBlock({ children, className }) {
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

const VIDEO_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);

function isVideoAttachment(att) {
  if (att.contentType && VIDEO_CONTENT_TYPES.has(att.contentType)) return true;
  const ext = (att.filename || att.originalName || att.url || '').split('.').pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function VideoLightbox({ src, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-default"
      onClick={onClose}
    >
      <video
        src={src}
        controls
        autoPlay
        className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
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
  const [lightboxType, setLightboxType] = useState('image'); // 'image' | 'video'

  const parsed = useMemo(() => {
    if (!attachments) return [];
    try {
      return typeof attachments === 'string' ? JSON.parse(attachments) : attachments;
    } catch {
      return [];
    }
  }, [attachments]);

  if (parsed.length === 0) return null;

  // Build the display URL: prefer the server-hosted /uploads/ path.
  // Prefix relative server paths with the server base so images load
  // in remote mode, Electron, and Vite dev proxy.
  const serverBase = getServerBase();
  const getDisplayUrl = (att) => {
    if (att.url) {
      // Relative path like "/uploads/uuid.png" — prefix with server base
      if (att.url.startsWith('/') && serverBase) return `${serverBase}${att.url}`;
      return att.url;
    }
    if (att.dataUrl) return att.dataUrl;
    return null;
  };

  const openLightbox = (src, type) => {
    setLightboxSrc(src);
    setLightboxType(type);
  };

  return (
    <>
      <div className={`flex flex-wrap gap-2 ${parsed.length > 0 ? 'mb-2' : ''}`}>
        {parsed.map((att, i) => {
          const src = getDisplayUrl(att);
          if (!src) return null;
          const isVideo = isVideoAttachment(att);

          if (isVideo) {
            return (
              <div
                key={att.id || i}
                className="relative max-w-xs rounded-lg border border-gray-600/50 overflow-hidden cursor-pointer hover:brightness-110 transition-all"
                onClick={() => openLightbox(src, 'video')}
              >
                <video
                  src={src}
                  className="max-h-48 max-w-xs rounded-lg"
                  muted
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    e.target.currentTime = 0.5;
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/20 transition-colors">
                  <div className="w-10 h-10 bg-white/90 rounded-full flex items-center justify-center">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-5 w-5 text-gray-900 ml-0.5"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                </div>
                <span className="absolute bottom-1 right-1 text-[10px] text-white bg-black/60 px-1.5 py-0.5 rounded">
                  {(att.filename || att.originalName || '').split('.').pop()?.toUpperCase() ||
                    'VIDEO'}
                </span>
              </div>
            );
          }

          return (
            <img
              key={att.id || i}
              src={src}
              alt={att.originalName || att.name || 'attachment'}
              className="max-h-48 max-w-xs rounded-lg border border-gray-600/50 cursor-zoom-in hover:brightness-110 transition-all"
              onClick={() => openLightbox(src, 'image')}
            />
          );
        })}
      </div>
      {lightboxSrc && lightboxType === 'video' && (
        <VideoLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
      {lightboxSrc && lightboxType === 'image' && (
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
  'claude-code': { icon: 'purple', label: 'Claude Code' },
};

function ChatMessage({ message, agentColor, onDequeue, onEditQueued }) {
  const isUser = message.role === 'user';
  const isQueued = message.queued;
  const isInterrupted = message.interrupted;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const editRef = React.useRef(null);
  const engineBadge = !isUser && message.engine ? ENGINE_BADGES[message.engine] : null;
  const modelLabel =
    !isUser && message.model ? message.model.replace('claude-', '').replace('-', ' ') : null;

  const components = {
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

  // Don't show "(image attached)" as text if it was auto-generated and there are actual attachments
  const displayContent = useMemo(() => {
    if (
      (message.content === '(image attached)' || message.content === '(media attached)') &&
      message.attachments
    )
      return '';
    return message.content;
  }, [message.content, message.attachments]);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[95%] sm:max-w-[90%] ${
          isUser
            ? isQueued
              ? 'bg-blue-600/40 border border-blue-500/30 rounded-2xl rounded-br-md px-4 py-2.5'
              : isInterrupted
                ? 'bg-amber-600/80 border border-amber-500/30 rounded-2xl rounded-br-md px-4 py-2.5'
                : 'bg-blue-600 rounded-2xl rounded-br-md px-4 py-2.5'
            : 'bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3'
        }`}
      >
        {!isUser && (
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: agentColor }} />
            <span className="text-xs text-gray-500 font-medium">Assistant</span>
            {engineBadge && (
              <span
                className="text-xs text-gray-600 flex items-center gap-1"
                title={engineBadge.label}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500 inline-block" />
                <span className="hidden sm:inline">{engineBadge.label}</span>
              </span>
            )}
            {modelLabel && <span className="text-xs text-gray-600">· {modelLabel}</span>}
          </div>
        )}

        {/* Queued indicator */}
        {isQueued && (
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs text-blue-300/70 font-medium flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400/50 animate-pulse" />
              Queued
            </span>
            {onEditQueued && !editing && (
              <button
                onClick={() => {
                  setEditValue(message.content);
                  setEditing(true);
                  requestAnimationFrame(() => editRef.current?.focus());
                }}
                className="text-xs text-blue-400/50 hover:text-blue-300 transition-colors"
              >
                Edit
              </button>
            )}
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

        {/* Interrupted indicator */}
        {isInterrupted && (
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs text-amber-300/70 font-medium flex items-center gap-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-3 w-3"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Interrupted
            </span>
          </div>
        )}

        {/* Render image attachments */}
        <MessageAttachments attachments={message.attachments} />

        {/* Editable queued message */}
        {isQueued && editing ? (
          <div className="space-y-2">
            <textarea
              ref={editRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (editValue.trim() && editValue !== message.content) {
                    onEditQueued(message.id, editValue.trim());
                  }
                  setEditing(false);
                }
                if (e.key === 'Escape') {
                  setEditing(false);
                  setEditValue(message.content);
                }
              }}
              rows={Math.min(editValue.split('\n').length, 6)}
              className="w-full bg-gray-900/80 border border-blue-500/40 rounded-lg px-3 py-2 text-sm text-white resize-none focus:outline-none focus:border-blue-400/60"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (editValue.trim() && editValue !== message.content) {
                    onEditQueued(message.id, editValue.trim());
                  }
                  setEditing(false);
                }}
                className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1 rounded-md transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setEditValue(message.content);
                }}
                className="text-xs text-gray-400 hover:text-gray-200 px-2.5 py-1 transition-colors"
              >
                Cancel
              </button>
              <span className="text-[10px] text-gray-600 ml-auto">
                Enter to save · Esc to cancel
              </span>
            </div>
          </div>
        ) : (
          <div className={isUser ? 'text-white' : 'markdown-content text-gray-200'}>
            {isUser ? (
              displayContent ? (
                <p className="whitespace-pre-wrap">{displayContent}</p>
              ) : null
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={components}
              >
                {message.content}
              </ReactMarkdown>
            )}
          </div>
        )}
        <div className={`text-xs mt-1 ${isUser ? 'text-blue-300' : 'text-gray-600'}`}>
          {message.created_at && relativeTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}

export default memo(ChatMessage);
