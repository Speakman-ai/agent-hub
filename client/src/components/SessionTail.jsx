import { memo, useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api.js';
import { relativeTime } from '../utils/time.js';
import { markdownComponentsCompact } from './MarkdownRenderer.jsx';
import { isFileModifyingTool, shortenPath, parseDiffLines } from '../utils/diff.js';
import { extractCoordinationBlocks } from '../utils/coordinationBlocks.js';
import AskUserQuestion from './AskUserQuestion.jsx';
import HandoffCard from './HandoffCard.jsx';
import {
  Bot,
  Zap,
  FileText,
  PenLine,
  Pencil,
  Search,
  FolderSearch,
  Globe,
  SearchCode,
  ListChecks,
  BookOpen,
  Wrench,
  MessageCircle,
  AlertTriangle,
  GitFork,
  Cpu,
  Timer,
  Bookmark,
} from 'lucide-react';

/**
 * SessionTail
 * -----------
 * Renders the full event timeline for an assistant message — including tool
 * uses, tool results, thinking blocks, partial streaming text, and the final
 * result summary. Replaces the old single-bubble ChatMessage/StreamingMessage
 * for assistant turns.
 *
 * Props:
 *   message      — { id, role, content, engine, model, created_at }
 *   events       — array of { seq, event } from session_events table or live WS
 *                  May be undefined when not yet loaded.
 *   agentColor   — color stripe for the assistant identity
 *   streaming    — true while a process is actively producing events
 *   onEventsLoaded(messageId, events) — called after a successful HTTP fetch,
 *                  so the parent can hoist the events into shared state
 */
function SessionTail({
  message,
  events,
  agentColor,
  streaming,
  onEventsLoaded,
  verboseMode,
  onAskSubmit,
  askSubmittedIds,
  fromAgent,
  agents,
  sessionHandoffs,
  onOpenSession,
}) {
  const messageId = message?.id;

  // If we don't have events yet AND this isn't a live stream, lazy-fetch them.
  // Live streams are populated via WS broadcasts, so no fetch is needed there.
  useEffect(() => {
    if (events !== undefined || streaming || !messageId) return;
    let cancelled = false;
    api
      .getMessageEvents(messageId)
      .then((rows) => {
        if (cancelled) return;
        // API returns [{ id, seq, event_type, event, timestamp }, ...]
        onEventsLoaded?.(
          messageId,
          rows.map((r) => ({ seq: r.seq, event: r.event })),
        );
      })
      .catch(() => {
        // Empty array signals "we tried, nothing here" so we don't loop.
        if (!cancelled) onEventsLoaded?.(messageId, []);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, events, streaming, onEventsLoaded]);

  const blocks = useMemo(() => eventsToBlocks(events ?? [], verboseMode), [events, verboseMode]);
  const hasEvents = !!events && events.length > 0;

  // Fallback: when there are no events to render (either truly legacy, or
  // still loading) but we have saved message content, render the legacy
  // bubble. This avoids a flash of "almost-empty container" while the lazy
  // events fetch is in flight, and is the permanent rendering for messages
  // saved before stream-json capture was added.
  if (!streaming && !hasEvents && message?.content) {
    return (
      <LegacyAssistantBubble
        message={message}
        agentColor={agentColor}
        fromAgent={fromAgent}
        agents={agents}
        sessionHandoffs={sessionHandoffs}
        onOpenSession={onOpenSession}
      />
    );
  }

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[95%] sm:max-w-[90%] w-full bg-gray-800/60 rounded-2xl rounded-bl-md px-3 py-3 sm:px-4 sm:py-4 border border-gray-800">
        <Header
          agentColor={agentColor}
          engine={message?.engine}
          model={message?.model}
          streaming={streaming}
          createdAt={message?.created_at}
        />

        {/* Streaming with no events yet — render the legacy `stream` content
            if the server is still emitting the old shape, otherwise show a
            waiting indicator until the first session-event arrives. */}
        {streaming && blocks.length === 0 && (
          <div className="mt-2">
            {message?.content ? (
              <TextBubble
                text={message.content}
                fromAgent={fromAgent}
                agents={agents}
                sessionHandoffs={sessionHandoffs}
                onOpenSession={onOpenSession}
              />
            ) : (
              <span className="text-xs text-gray-500 italic">Waiting for first event…</span>
            )}
          </div>
        )}

        <div className="space-y-2 mt-2">
          {blocks.map((block, i) => {
            switch (block.kind) {
              case 'system':
                return <SystemBanner key={`b${i}`} system={block.event} />;
              case 'thinking':
                return (
                  <ThinkingBlock key={`b${i}`} text={block.event.text} defaultOpen={verboseMode} />
                );
              case 'subagent':
                return (
                  <SubagentCard
                    key={`b${i}`}
                    use={block.use}
                    result={block.result}
                    defaultOpen={verboseMode}
                  />
                );
              case 'tool':
                return (
                  <ToolCard
                    key={`b${i}`}
                    use={block.use}
                    result={block.result}
                    defaultOpen={verboseMode}
                  />
                );
              case 'text':
                return (
                  <TextBubble
                    key={`b${i}`}
                    text={block.text}
                    fromAgent={fromAgent}
                    agents={agents}
                    sessionHandoffs={sessionHandoffs}
                    onOpenSession={onOpenSession}
                  />
                );
              case 'ask_question':
                return (
                  <AskUserQuestion
                    key={`b${i}`}
                    askId={block.event.askId}
                    questions={block.event.questions}
                    submitted={askSubmittedIds?.has?.(block.event.askId)}
                    onSubmit={(text) => onAskSubmit?.(block.event.askId, text)}
                  />
                );
              case 'result':
                return <ResultFooter key={`b${i}`} result={block.event} />;
              case 'checkpoint':
                return <CheckpointBlock key={`b${i}`} event={block.event} />;
              case 'rate_limit':
                return <RateLimitBlock key={`b${i}`} event={block.event} />;
              case 'error':
                return <ErrorBlock key={`b${i}`} message={block.event.message} />;
              case 'unknown':
                return <UnknownBlock key={`b${i}`} event={block.event} />;
              default:
                return null;
            }
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Reducer: events → display blocks ──────────────────────────────────

/**
 * Walk events and produce a flat list of display blocks. Pairs tool_use with
 * its tool_result by id (so we don't render orphan results), and coalesces
 * consecutive assistant_text events into a single text bubble using the
 * partial-vs-final precedence rule (final wins; partials are the streaming
 * preview that gets replaced when the final arrives).
 */
function eventsToBlocks(events, verbose) {
  const blocks = [];

  // First pass: index tool_results by tool_use_id for pairing.
  const resultByToolId = {};
  for (const { event } of events) {
    if (event?.type === 'tool_result' && event.toolUseId) {
      resultByToolId[event.toolUseId] = event;
    }
  }

  // Second pass: walk events, coalescing text segments.
  let textBuf = null; // { partials: '', final: '' }

  const flushText = () => {
    if (!textBuf) return;
    const text = textBuf.final || textBuf.partials;
    if (text && text.trim()) blocks.push({ kind: 'text', text });
    textBuf = null;
  };

  for (const { event } of events) {
    if (!event) continue;
    const t = event.type;

    if (t === 'assistant_text') {
      if (!textBuf) textBuf = { partials: '', final: '' };
      if (event.partial) textBuf.partials += event.text;
      else textBuf.final += event.text;
      continue;
    }

    // Any non-text event closes the current text segment.
    flushText();

    if (t === 'tool_result') continue; // shown inside its paired tool card
    if (t === 'checkpoint' && !verbose) continue; // internal restore-point bookkeeping
    if (t === 'rate_limit' && !verbose) continue; // no visual representation
    if (t === 'system') {
      blocks.push({ kind: 'system', event });
    } else if (t === 'thinking') {
      blocks.push({ kind: 'thinking', event });
    } else if (t === 'tool_use') {
      const isSubagent = event.tool === 'Task' || event.tool === 'Agent';
      blocks.push({
        kind: isSubagent ? 'subagent' : 'tool',
        use: event,
        result: resultByToolId[event.id],
      });
    } else if (t === 'checkpoint') {
      blocks.push({ kind: 'checkpoint', event });
    } else if (t === 'rate_limit') {
      blocks.push({ kind: 'rate_limit', event });
    } else if (t === 'result') {
      blocks.push({ kind: 'result', event });
    } else if (t === 'ask_user_question') {
      blocks.push({ kind: 'ask_question', event });
    } else if (t === 'error') {
      blocks.push({ kind: 'error', event });
    } else {
      blocks.push({ kind: 'unknown', event });
    }
  }
  flushText();
  return blocks;
}

// ─── Sub-components ────────────────────────────────────────────────────

const ENGINE_BADGES = {
  'claude-code': {
    icon: <span className="w-2.5 h-2.5 rounded-full bg-purple-500 inline-block" />,
    label: 'Claude Code',
  },
};

const MARKDOWN_COMPONENTS = markdownComponentsCompact;

function Header({ agentColor, engine, model, streaming, createdAt }) {
  const badge = engine ? ENGINE_BADGES[engine] : null;
  const modelLabel = model ? model.replace('claude-', '').replace(/-/g, ' ') : null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: agentColor }} />
      <span className="text-gray-500 font-medium">Assistant</span>
      {badge && (
        <span className="text-gray-600 flex items-center gap-1" title={badge.label}>
          {badge.icon}
          <span className="hidden sm:inline">{badge.label}</span>
        </span>
      )}
      {modelLabel && <span className="text-gray-600">· {modelLabel}</span>}
      {streaming && (
        <span className="flex items-center gap-1 ml-1">
          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
          <span className="text-emerald-500">streaming</span>
        </span>
      )}
      <span className="ml-auto text-gray-600">{createdAt ? relativeTime(createdAt) : ''}</span>
    </div>
  );
}

function SystemBanner({ system }) {
  // Compact badge showing model + cwd. Sessionid only on hover.
  return (
    <div
      className="text-xs text-gray-500 bg-gray-900/50 rounded-md px-2 py-1 font-mono truncate"
      title={system.sessionId ? `session ${system.sessionId}` : ''}
    >
      {system.model || 'unknown model'}
      {system.cwd && <span className="text-gray-600"> · {system.cwd}</span>}
    </div>
  );
}

function ThinkingBlock({ text, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="bg-gray-900/40 border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-900/60"
      >
        <span className="text-2xl leading-none flex items-center">{open ? '▼' : '▶'}</span>
        <span className="flex items-center gap-1">
          <MessageCircle size={12} /> thinking
        </span>
        <span className="text-gray-600 truncate flex-1 text-left">
          {!open && text.slice(0, 80)}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 pt-1 text-xs text-gray-400 italic whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

// Tool styling — color stripe by category. Falls back to gray for unknown tools.
const TOOL_STYLES = {
  Bash: { color: 'border-emerald-700/60 bg-emerald-950/30', icon: <Zap size={16} /> },
  Read: { color: 'border-blue-700/60 bg-blue-950/30', icon: <FileText size={16} /> },
  Write: { color: 'border-rose-700/60 bg-rose-950/30', icon: <PenLine size={16} /> },
  Edit: { color: 'border-amber-700/60 bg-amber-950/30', icon: <Pencil size={16} /> },
  Grep: { color: 'border-purple-700/60 bg-purple-950/30', icon: <Search size={16} /> },
  Glob: { color: 'border-purple-700/60 bg-purple-950/30', icon: <FolderSearch size={16} /> },
  WebFetch: { color: 'border-cyan-700/60 bg-cyan-950/30', icon: <Globe size={16} /> },
  WebSearch: { color: 'border-cyan-700/60 bg-cyan-950/30', icon: <SearchCode size={16} /> },
  Task: { color: 'border-indigo-700/60 bg-indigo-950/30', icon: <Bot size={16} /> },
  TodoWrite: { color: 'border-gray-700/60 bg-gray-900/40', icon: <ListChecks size={16} /> },
  NotebookEdit: { color: 'border-amber-700/60 bg-amber-950/30', icon: <BookOpen size={16} /> },
};

/**
 * DiffView — compact, colorized diff for Edit and Write tools.
 * Edit: shows old_string lines as removals (red) and new_string as additions (green).
 * Write: shows all content as additions (green).
 */
export function DiffView({ tool, input }) {
  const { filePath, action, removals, additions } = parseDiffLines(tool, input);

  const addedCount = additions.filter((l) => l.trim()).length;
  const removedCount = removals.filter((l) => l.trim()).length;

  return (
    <div className="bg-gray-950/60 rounded-md overflow-hidden font-mono text-xs">
      {/* File path header */}
      <div className="flex items-center gap-2 px-2 py-1 bg-gray-900/80 text-gray-400 border-b border-gray-800/50">
        <span className="text-emerald-500 font-semibold">{action}:</span>
        <span className="truncate">{shortenPath(filePath)}</span>
        <span className="ml-auto text-[10px] text-gray-600">
          {addedCount > 0 && <span className="text-emerald-500">+{addedCount}</span>}
          {removedCount > 0 && <span className="text-red-400 ml-1">-{removedCount}</span>}
        </span>
      </div>
      {/* Diff lines — whitespace-pre preserves leading indentation; the gutter
          marker is in a flex-shrink-0 span so the code portion keeps its
          original column alignment even when the container wraps. */}
      <div className="overflow-x-auto max-h-64 overflow-y-auto">
        {removals.map((line, i) => (
          <div
            key={`r${i}`}
            className="flex px-2 py-px bg-red-950/40 text-red-300 border-l-2 border-red-600"
          >
            <span className="text-red-500/60 select-none mr-2 flex-shrink-0">-</span>
            <span className="whitespace-pre" style={{ tabSize: 2, MozTabSize: 2 }}>
              {line}
            </span>
          </div>
        ))}
        {additions.map((line, i) => (
          <div
            key={`a${i}`}
            className="flex px-2 py-px bg-emerald-950/40 text-emerald-300 border-l-2 border-emerald-600"
          >
            <span className="text-emerald-500/60 select-none mr-2 flex-shrink-0">+</span>
            <span className="whitespace-pre" style={{ tabSize: 2, MozTabSize: 2 }}>
              {line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolCard({ use, result, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const style = TOOL_STYLES[use.tool] || {
    color: 'border-gray-700/60 bg-gray-900/40',
    icon: <Wrench size={16} />,
  };
  const summary = summarizeToolInput(use.tool, use.input);
  const errored = result?.isError;
  const stillRunning = !result;
  const showDiff = isFileModifyingTool(use.tool);

  // File-modifying tools always show compact diff (visible in both compact and verbose mode)
  if (showDiff && !errored) {
    return (
      <div className={`border rounded-lg overflow-hidden ${style.color}`}>
        <DiffView tool={use.tool} input={use.input} />
      </div>
    );
  }

  return (
    <div
      className={`border rounded-lg overflow-hidden ${style.color} ${errored ? 'border-red-700/80' : ''}`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-black/20"
      >
        <span className="flex-shrink-0">{style.icon}</span>
        <span className="font-mono font-semibold text-gray-200 flex-shrink-0">{use.tool}</span>
        <span className="text-gray-400 truncate flex-1 font-mono">{summary}</span>
        {stillRunning && (
          <span className="text-emerald-400 text-[10px] animate-pulse">running…</span>
        )}
        {errored && <span className="text-red-400 text-[10px] uppercase tracking-wide">error</span>}
        <span className="text-gray-500 text-2xl leading-none flex items-center">
          {open ? '▼' : '▶'}
        </span>
      </button>
      {open && (
        <div className="border-t border-black/30 p-3 space-y-2">
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">input</div>
            <pre className="text-xs text-gray-300 bg-black/30 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-64">
              {formatToolInput(use.input)}
            </pre>
          </div>
          {result && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">
                {errored ? 'error' : 'result'}
              </div>
              <pre
                className={`text-xs rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-96 ${errored ? 'bg-red-950/40 text-red-300' : 'bg-black/30 text-gray-300'}`}
              >
                {result.output || '(empty)'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Subagent type labels and colors ──────────────────────────────────
const SUBAGENT_TYPES = {
  'general-purpose': { label: 'General', color: 'text-indigo-400' },
  Explore: { label: 'Explore', color: 'text-cyan-400' },
  Plan: { label: 'Plan', color: 'text-amber-400' },
  'code-reviewer': { label: 'Reviewer', color: 'text-emerald-400' },
};

function SubagentCard({ use, result, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const input = use.input ?? {};
  const subagentType = input.subagent_type || 'general-purpose';
  const description = input.description || 'Subagent task';
  const model = input.model || null;
  const background = input.run_in_background || false;
  const isolation = input.isolation || null;
  const errored = result?.isError;
  const stillRunning = !result;
  const typeInfo = SUBAGENT_TYPES[subagentType] || {
    label: subagentType,
    color: 'text-gray-400',
  };

  return (
    <div
      className={`border rounded-lg overflow-hidden border-indigo-700/60 bg-indigo-950/20 ${errored ? 'border-red-700/80' : ''}`}
    >
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-black/20"
      >
        <span className="flex-shrink-0 text-indigo-400">
          <GitFork size={16} />
        </span>
        <span className="font-mono font-semibold text-indigo-300 flex-shrink-0">Subagent</span>
        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-800/80 ${typeInfo.color}`}
        >
          {typeInfo.label}
        </span>
        <span className="text-gray-400 truncate flex-1">{description}</span>
        {stillRunning && (
          <span className="flex items-center gap-1 text-indigo-400 text-[10px] animate-pulse">
            <Cpu size={10} />
            running…
          </span>
        )}
        {!stillRunning && !errored && <span className="text-emerald-400 text-[10px]">✓ done</span>}
        {errored && <span className="text-red-400 text-[10px] uppercase tracking-wide">error</span>}
        <span className="text-gray-500 text-2xl leading-none flex items-center">
          {open ? '▼' : '▶'}
        </span>
      </button>

      {/* Metadata badges row */}
      {(model || background || isolation) && (
        <div className="flex items-center gap-2 px-3 pb-1.5 text-[10px] text-gray-500">
          {model && (
            <span className="bg-gray-800/60 px-1.5 py-0.5 rounded">
              {model.replace('claude-', '').replace(/-/g, ' ')}
            </span>
          )}
          {background && <span className="bg-gray-800/60 px-1.5 py-0.5 rounded">background</span>}
          {isolation && (
            <span className="bg-gray-800/60 px-1.5 py-0.5 rounded flex items-center gap-0.5">
              <GitFork size={8} /> {isolation}
            </span>
          )}
        </div>
      )}

      {/* Expanded content */}
      {open && (
        <div className="border-t border-indigo-900/40 p-3 space-y-2">
          {/* Prompt */}
          {input.prompt && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">prompt</div>
              <div className="text-xs text-gray-300 bg-black/30 rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                {input.prompt}
              </div>
            </div>
          )}
          {/* Result — rendered as markdown for readability */}
          {result && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">
                {errored ? 'error' : 'result'}
              </div>
              <div
                className={`text-xs rounded p-2 max-h-96 overflow-y-auto ${errored ? 'bg-red-950/40 text-red-300' : 'bg-black/30 text-gray-300 markdown-content'}`}
              >
                {errored ? (
                  <pre className="whitespace-pre-wrap break-words">
                    {result.output || '(empty)'}
                  </pre>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {result.output || '(empty)'}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Single-line summary of a tool's input for the collapsed card header.
 * Tries to extract the most-important field per tool type.
 */
function summarizeToolInput(tool, input) {
  if (!input || typeof input !== 'object') return '';
  if (tool === 'Bash') return input.command || input.description || '';
  if (tool === 'Read') return input.file_path || input.path || '';
  if (tool === 'Write') return input.file_path || input.path || '';
  if (tool === 'Edit') return input.file_path || input.path || '';
  if (tool === 'Grep') return input.pattern || '';
  if (tool === 'Glob') return input.pattern || '';
  if (tool === 'WebFetch' || tool === 'WebSearch') return input.url || input.query || '';
  if (tool === 'Task') return input.description || input.subagent_type || '';
  if (tool === 'TodoWrite') {
    const todos = input.todos;
    if (Array.isArray(todos)) return `${todos.length} todo${todos.length === 1 ? '' : 's'}`;
    return '';
  }
  // Fallback: first string-valued field
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function TextBubble({ text, fromAgent, agents, sessionHandoffs, onOpenSession }) {
  // Strip any <handoff>/<delegate> blocks from the prose so the raw JSON
  // wall doesn't end up rendered inline. The blocks are surfaced separately
  // as a card below the prose.
  const { stripped, handoff } = extractCoordinationBlocks(text);
  const handoffRow = handoff ? pickHandoffRow(handoff, sessionHandoffs) : null;
  return (
    <>
      {stripped && (
        <div className="markdown-content text-gray-200 text-sm leading-relaxed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={MARKDOWN_COMPONENTS}
          >
            {stripped}
          </ReactMarkdown>
        </div>
      )}
      {handoff && (
        <HandoffCard
          toAgentId={handoff.toAgent}
          note={handoff.note}
          fromAgent={fromAgent}
          agents={agents}
          handoff={handoffRow}
          onOpenSession={onOpenSession}
        />
      )}
    </>
  );
}

/**
 * Correlate a parsed <handoff> block back to its DB row. The server's fuzzy
 * resolver may have rewritten the id (e.g. "agent-hub-backend" →
 * "hub-backend"), so we accept either the raw block's `toAgent` or the
 * resolved `to_agent_id`, preferring delivered rows and then falling back
 * to the most recent matching row. When there's only one handoff row for
 * the whole source session (the common case — handoff is terminal) we
 * just use it unconditionally.
 */
function pickHandoffRow(block, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const wanted = (block?.toAgent || '').trim().toLowerCase();
  const match = (r) => {
    const rowAgent = (r?.to_agent_id || '').toLowerCase();
    if (!wanted || !rowAgent) return false;
    return (
      rowAgent === wanted ||
      rowAgent.endsWith(`-${wanted}`) ||
      wanted.endsWith(`-${rowAgent}`) ||
      wanted.includes(rowAgent) ||
      rowAgent.includes(wanted)
    );
  };
  return (
    rows.find((r) => r.status === 'delivered' && match(r)) ||
    rows.find((r) => match(r)) ||
    (rows.length === 1 ? rows[0] : null)
  );
}

function ResultFooter({ result }) {
  const parts = [];
  if (typeof result.durationMs === 'number') {
    parts.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  }
  if (typeof result.costUsd === 'number') {
    parts.push(`$${result.costUsd.toFixed(4)}`);
  }
  if (typeof result.numTurns === 'number') {
    parts.push(`${result.numTurns} turn${result.numTurns === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return null;
  return (
    <div className="flex items-center gap-2 text-[10px] text-gray-600 font-mono pt-1 border-t border-gray-800/50">
      <span className="flex items-center gap-1">
        {result.isError ? (
          <>
            <AlertTriangle size={10} /> error
          </>
        ) : (
          <>
            <ListChecks size={10} /> done
          </>
        )}
      </span>
      <span>·</span>
      <span>{parts.join(' · ')}</span>
    </div>
  );
}

function CheckpointBlock({ event }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-gray-600 font-mono px-2 py-1 bg-gray-900/30 rounded border border-gray-800/50">
      <Bookmark size={10} />
      <span>checkpoint</span>
      {event.uuid && <span className="text-gray-700 truncate">{event.uuid.slice(0, 12)}…</span>}
      {typeof event.turnIndex === 'number' && <span>· turn {event.turnIndex}</span>}
    </div>
  );
}

function RateLimitBlock({ event }) {
  const seconds = event.retryAfterMs ? Math.ceil(event.retryAfterMs / 1000) : null;
  return (
    <div className="flex items-center gap-2 text-[10px] text-amber-500/80 font-mono px-2 py-1 bg-amber-950/20 rounded border border-amber-800/30">
      <Timer size={10} />
      <span>rate limited</span>
      {seconds && <span>· retry in {seconds}s</span>}
      {event.message && <span className="text-amber-600 truncate">· {event.message}</span>}
    </div>
  );
}

function ErrorBlock({ message }) {
  return (
    <div className="bg-red-950/40 border border-red-800/60 rounded-lg px-3 py-2 text-xs text-red-300 whitespace-pre-wrap">
      <span className="flex items-center gap-1">
        <AlertTriangle size={12} /> {message}
      </span>
    </div>
  );
}

function UnknownBlock({ event }) {
  return (
    <div className="bg-gray-900/40 border border-gray-800 rounded-lg px-3 py-2 text-[10px] text-gray-500 font-mono">
      unhandled event: {event.text || JSON.stringify(event).slice(0, 200)}
    </div>
  );
}

/**
 * Fallback bubble for legacy assistant messages that pre-date stream-json
 * event capture. Same shape as the old ChatMessage assistant case.
 */
function LegacyAssistantBubble({
  message,
  agentColor,
  fromAgent,
  agents,
  sessionHandoffs,
  onOpenSession,
}) {
  // Strip coordination blocks here too — legacy messages were saved with the
  // raw `<handoff>...</handoff>` JSON in their content.
  const { stripped, handoff } = extractCoordinationBlocks(message.content);
  const handoffRow = handoff ? pickHandoffRow(handoff, sessionHandoffs) : null;
  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[95%] sm:max-w-[90%] bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
        <Header
          agentColor={agentColor}
          engine={message.engine}
          model={message.model}
          streaming={false}
          createdAt={message.created_at}
        />
        {stripped && (
          <div className="markdown-content text-gray-200 mt-1">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={MARKDOWN_COMPONENTS}
            >
              {stripped}
            </ReactMarkdown>
          </div>
        )}
        {handoff && (
          <HandoffCard
            toAgentId={handoff.toAgent}
            note={handoff.note}
            fromAgent={fromAgent}
            agents={agents}
            handoff={handoffRow}
            onOpenSession={onOpenSession}
          />
        )}
      </div>
    </div>
  );
}

export default memo(SessionTail);
