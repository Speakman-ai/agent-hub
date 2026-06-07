import React, { memo, useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { GitPullRequest, AlertTriangle } from 'lucide-react';
import { relativeTime } from '../utils/time.js';
import { getServerBase } from '../utils/connection.js';
import { markdownComponents } from './MarkdownRenderer.jsx';
import {
  parsePrCreatedMetadata,
  parsePrFailedMetadata,
  describePrFailureCode,
  shortSha,
} from '../utils/prMessage.js';
import { parseShipRequestedMetadata } from '../utils/shipRequestedMessage.js';
import { stripAskAnswerBlocks } from '../utils/askAnswers.js';
import {
  isFinalizeStepOutputMessage,
  parseRawReviewVerdictContent,
  parseFinalizeTimelineKind,
} from '../utils/finalizeTimeline.js';
import FinalizeRunStartedBlock from './finalize/blocks/FinalizeRunStartedBlock.jsx';
import FinalizeRebaseBlock from './finalize/blocks/FinalizeRebaseBlock.jsx';
import FinalizeReviewRoundBlock from './finalize/blocks/FinalizeReviewRoundBlock.jsx';
import FinalizeChecksRoundBlock from './finalize/blocks/FinalizeChecksRoundBlock.jsx';
import FinalizeReadyToPushBlock from './finalize/blocks/FinalizeReadyToPushBlock.jsx';
import FinalizeTerminalBlock from './finalize/blocks/FinalizeTerminalBlock.jsx';
import FinalizeFixDispatchBlock from './finalize/blocks/FinalizeFixDispatchBlock.jsx';

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

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'heic',
  'avif',
]);

function isImageLikeAttachment(att) {
  if (att.contentType?.startsWith('image/')) return true;
  const ext = (att.filename || att.originalName || att.url || '').split('.').pop()?.toLowerCase();
  if (ext && IMAGE_EXTENSIONS.has(ext)) return true;
  return false;
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
          const isImage = isImageLikeAttachment(att);
          const fileLabel = att.originalName || att.name || att.filename || 'attachment';

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

          if (!isImage) {
            return (
              <a
                key={att.id || i}
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                download={fileLabel}
                className="inline-flex items-center gap-2 max-w-xs px-3 py-2 rounded-lg border border-gray-600/50 bg-gray-800/50 text-sm text-blue-300 hover:bg-gray-800 hover:text-blue-200 transition-colors truncate"
                title={fileLabel}
              >
                <span className="truncate">{fileLabel}</span>
              </a>
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
  'claude-code': { dotClass: 'bg-purple-500', label: 'Claude Code' },
  'cursor-agent': { dotClass: 'bg-emerald-500', label: 'Cursor Agent' },
  'codex-cli': { dotClass: 'bg-sky-500', label: 'Codex' },
};

function SystemShipRequestedMessage({ message }) {
  const meta = parseShipRequestedMetadata(message.metadata);
  if (!meta) {
    return (
      <div className="flex justify-center mb-4">
        <div className="text-xs text-gray-500 italic">{message.content || 'System event'}</div>
      </div>
    );
  }
  return (
    <div className="flex justify-center mb-4">
      <div className="max-w-[95%] sm:max-w-[80%] w-full bg-purple-950/30 border border-purple-700/50 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2">
          <GitPullRequest className="w-4 h-4 text-purple-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-purple-200">
              {meta.auto ? 'Shipping automatically' : 'Create ticket & PR'}
            </p>
            <p className="text-xs text-purple-200/70 mt-0.5">
              {meta.auto
                ? 'Agent Hub is rebasing on the base branch, then committing, pushing, and opening or updating the pull request.'
                : 'Agent Hub is creating a kanban ticket, committing, pushing, and opening a pull request.'}
            </p>
          </div>
        </div>
        {message.created_at && (
          <div className="text-[11px] text-gray-600 mt-2">{relativeTime(message.created_at)}</div>
        )}
      </div>
    </div>
  );
}

function SystemPrCreatedMessage({ message }) {
  const meta = parsePrCreatedMetadata(message.metadata);
  if (!meta) {
    // Malformed metadata — render a minimal generic system callout so we
    // never crash the timeline on unexpected payloads.
    return (
      <div className="flex justify-center mb-4">
        <div className="text-xs text-gray-500 italic">{message.content || 'System event'}</div>
      </div>
    );
  }
  const prLabel = meta.prNumber ? `#${meta.prNumber}` : 'View PR';
  return (
    <div className="flex justify-center mb-4">
      <div className="max-w-[95%] sm:max-w-[80%] w-full bg-emerald-950/30 border border-emerald-700/40 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <GitPullRequest className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-medium text-emerald-300">
            Pull request created from these changes
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <a
            href={meta.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-400 hover:text-emerald-300 underline font-medium"
          >
            {prLabel}
          </a>
          {meta.commitSha && (
            <code className="text-xs text-gray-400 bg-gray-900/60 px-1.5 py-0.5 rounded">
              {shortSha(meta.commitSha)}
            </code>
          )}
          {meta.commitTitle && <span className="text-gray-300 truncate">{meta.commitTitle}</span>}
        </div>
        {meta.cardTitle && (
          <div className="mt-1.5 text-xs text-gray-500">
            Linked card: <span className="text-gray-400">{meta.cardTitle}</span>
          </div>
        )}
        {message.created_at && (
          <div className="text-[11px] text-gray-600 mt-1.5">{relativeTime(message.created_at)}</div>
        )}
      </div>
    </div>
  );
}

function SystemPrFailedMessage({ message }) {
  const meta = parsePrFailedMetadata(message.metadata);
  if (!meta) {
    return (
      <div className="flex justify-center mb-4">
        <div className="text-xs text-gray-500 italic">{message.content || 'System event'}</div>
      </div>
    );
  }
  const heading = describePrFailureCode(meta.code);
  return (
    <div className="flex justify-center mb-4">
      <div className="max-w-[95%] sm:max-w-[80%] w-full bg-red-950/30 border border-red-700/40 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          <span className="text-sm font-medium text-red-300">{heading}</span>
          <code className="text-[11px] text-red-300/70 bg-red-950/40 px-1.5 py-0.5 rounded">
            {meta.code}
          </code>
        </div>
        <div className="text-sm text-red-100/80 whitespace-pre-wrap break-words">{meta.error}</div>
        {(meta.branch || meta.cardTitle) && (
          <div className="mt-1.5 text-xs text-gray-400 space-x-3">
            {meta.branch && (
              <span>
                Branch: <code className="text-gray-300">{meta.branch}</code>
              </span>
            )}
            {meta.cardTitle && (
              <span>
                Card: <span className="text-gray-300">{meta.cardTitle}</span>
              </span>
            )}
          </div>
        )}
        <div className="mt-2 text-[11px] text-red-200/70">
          Your work is still on the local branch. Open the worktree, run{' '}
          <code className="bg-red-950/40 px-1 rounded">git fetch origin</code> +{' '}
          <code className="bg-red-950/40 px-1 rounded">git rebase origin/&lt;branch&gt;</code>, then
          push manually or click <em>Create PR</em>.
        </div>
        {message.created_at && (
          <div className="text-[11px] text-gray-600 mt-1.5">{relativeTime(message.created_at)}</div>
        )}
      </div>
    </div>
  );
}

function ChatMessage({
  message,
  agentColor,
  projectId,
  onDequeue,
  onEditQueued,
  onEditInComposer,
  onInterrupt,
  inFlightWhileStreaming = false,
}) {
  const isSystem = message.role === 'system';
  const isUser = message.role === 'user';
  const isQueued = message.queued;
  const isInterrupted = message.interrupted;
  const showInFlightActions = inFlightWhileStreaming && isUser && (isQueued || isInterrupted);
  const displayAgentColor = message.agent_color || agentColor;
  const displayAgentName = message.agent_name || 'Assistant';
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const editRef = React.useRef(null);

  // Don't show "(image attached)" as text if it was auto-generated and there are actual attachments.
  // For user messages only, strip `agenthub:ask:answer` fences (picker UI already shows submission).
  const displayContent = useMemo(() => {
    if (
      (message.content === '(image attached)' || message.content === '(media attached)') &&
      message.attachments
    )
      return '';
    // Only user bubbles carry `agenthub:ask:answer` payloads; stripping from
    // assistant text used to delete documented fenced examples and break MD.
    if (message.role === 'user') return stripAskAnswerBlocks(message.content);
    return typeof message.content === 'string' ? message.content : message.content;
  }, [message.content, message.attachments, message.role]);

  if (isSystem) {
    if (isFinalizeStepOutputMessage(message.metadata)) {
      return null;
    }
    const finalizeKind = parseFinalizeTimelineKind(message.metadata);
    if (finalizeKind === 'finalize_run_started') {
      return <FinalizeRunStartedBlock message={message} />;
    }
    if (finalizeKind === 'finalize_rebase_result') {
      return <FinalizeRebaseBlock message={message} />;
    }
    if (finalizeKind === 'finalize_review_round') {
      return <FinalizeReviewRoundBlock message={message} />;
    }
    if (finalizeKind === 'finalize_checks_round') {
      return <FinalizeChecksRoundBlock message={message} projectId={projectId} />;
    }
    if (finalizeKind === 'finalize_ready_to_push') {
      return <FinalizeReadyToPushBlock message={message} />;
    }
    if (finalizeKind === 'finalize_run_terminal') {
      return <FinalizeTerminalBlock message={message} />;
    }
    if (finalizeKind === 'finalize_fix_dispatch') {
      return <FinalizeFixDispatchBlock message={message} />;
    }
    if (parseShipRequestedMetadata(message.metadata)) {
      return <SystemShipRequestedMessage message={message} />;
    }
    if (parsePrFailedMetadata(message.metadata)) {
      return <SystemPrFailedMessage message={message} />;
    }
    return <SystemPrCreatedMessage message={message} />;
  }

  // If a user message had nothing but an ask-answer payload (no prose, no
  // attachments, no queued/interrupted affordances), suppress the bubble
  // entirely — the picker already reflects the submission.
  if (
    isUser &&
    !displayContent &&
    !message.attachments &&
    !isQueued &&
    !isInterrupted &&
    typeof message.content === 'string' &&
    message.content.includes('agenthub:ask:answer')
  ) {
    return null;
  }

  const rawReviewVerdict = !isUser ? parseRawReviewVerdictContent(displayContent) : null;
  if (rawReviewVerdict) {
    return null;
  }

  const engineBadge = !isUser && message.engine ? ENGINE_BADGES[message.engine] : null;
  const modelLabel =
    !isUser && message.model ? message.model.replace('claude-', '').replace('-', ' ') : null;

  const components = markdownComponents;

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
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: displayAgentColor }} />
            <span className="text-xs text-gray-500 font-medium">{displayAgentName}</span>
            {engineBadge && (
              <span
                className="text-xs text-gray-600 flex items-center gap-1"
                title={engineBadge.label}
              >
                <span className={`w-2.5 h-2.5 rounded-full inline-block ${engineBadge.dotClass}`} />
                <span className="hidden sm:inline">{engineBadge.label}</span>
              </span>
            )}
            {modelLabel && <span className="text-xs text-gray-600">· {modelLabel}</span>}
          </div>
        )}

        {/* Queued / in-flight indicator */}
        {(isQueued || isInterrupted) && (
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            {isQueued && !isInterrupted && (
              <span className="text-xs text-blue-300/70 font-medium flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400/50 animate-pulse" />
                Queued
              </span>
            )}
            {isInterrupted && (
              <span className="text-xs text-amber-300/70 font-medium flex items-center gap-1">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Interrupted
              </span>
            )}
            {showInFlightActions ? (
              <>
                {onEditInComposer && (
                  <button
                    type="button"
                    onClick={() => onEditInComposer(message.id, message.content)}
                    className="text-xs text-blue-400/70 hover:text-blue-300 transition-colors"
                  >
                    Edit
                  </button>
                )}
                {onInterrupt && (
                  <button
                    type="button"
                    onClick={() => onInterrupt(message)}
                    className="text-xs text-amber-300/80 hover:text-amber-200 transition-colors"
                  >
                    Interrupt
                  </button>
                )}
                {onDequeue && (
                  <button
                    type="button"
                    onClick={() => onDequeue(message.id, { cancelStream: true })}
                    className="text-xs text-blue-400/50 hover:text-red-400 transition-colors"
                  >
                    Remove
                  </button>
                )}
              </>
            ) : (
              <>
                {isQueued && onEditQueued && !editing && (
                  <button
                    type="button"
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
                {isQueued && onDequeue && (
                  <button
                    type="button"
                    onClick={() => onDequeue(message.id)}
                    className="text-xs text-blue-400/50 hover:text-red-400 transition-colors"
                  >
                    ✕ Remove
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* Render image attachments */}
        <MessageAttachments attachments={message.attachments} />

        {/* Editable queued message */}
        {isQueued && editing && !showInFlightActions ? (
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
                {displayContent}
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
