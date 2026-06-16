import { memo, useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api.js';
import { relativeTime } from '../utils/time.js';
import { markdownComponents } from './MarkdownRenderer.jsx';
import {
  isFileModifyingTool,
  shortenPath,
  parseDiffLines,
  mergeEditInputWithToolResult,
  diffHasDisplayableLines,
  isExplicitEmptyWrite,
} from '../utils/diff.js';
import {
  extractCoordinationBlocks,
  describeHandoffReason,
  describeDelegateReason,
} from '../utils/coordinationBlocks.js';
import { deriveAssistantTailOutcome } from '../utils/assistantTailOutcome.js';
import { stripAssistantControlBlocks } from '../utils/controlBlocks.js';
import { extractReviewVerdictContent } from '../utils/finalizeTimeline.js';
import { extractAskBlocks } from '../../../shared/utils/extractAskBlocks.js';
import { shouldSuppressStreamEvent } from '../../../shared/utils/benignStreamEvents.js';
import { formatSystemBannerModelLine } from '../../../shared/utils/systemBannerModel.js';
import AskUserQuestion from './AskUserQuestion.jsx';
import HandoffCard from './HandoffCard.jsx';
import DelegateCard from './DelegateCard.jsx';
import BrowserActivityPanel from './BrowserActivityPanel.jsx';
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
  ClipboardList,
  Loader2,
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
 *   onEventsLoaded(messageId, events) — called after a **successful** HTTP fetch
 *                  so the parent can hoist the events into shared state. Never
 *                  use an empty array to mean "fetch failed" — that poisons the
 *                  parent's cache (`events !== undefined`) and skips refetch.
 *   browserScreenshots — optional map of actionId → screenshot data URL delivered
 *                  via `browser_activity_screenshot` (not persisted).
 */
function SessionTail({
  message,
  events,
  agentColor,
  agentName,
  streaming,
  onEventsLoaded,
  onAskSubmit,
  askSubmittedIds,
  fromAgent,
  agents,
  sessionHandoffs,
  sessionDelegations,
  delegationDispatchError,
  onOpenSession,
  browserScreenshots = {},
  onInterrupt,
}) {
  // `streaming` doubles as the parent-active signal for DelegateCard so it
  // can decide whether an empty live snapshot means "still awaiting dispatch"
  // (active turn) or "dispatch never happened" (closed turn) — the original
  // "Queued forever" bug.
  const parentSessionActive = !!streaming;
  const messageId = message?.id;
  // Prefer the name stored on the message (set per-agent at insert time), then
  // the active agent's name passed by the parent, falling back to "Assistant".
  const displayAgentName = message?.agent_name || agentName || undefined;

  /** Tracks lazy GET /messages/:id/events — must not conflate with "loaded empty". */
  const [eventFetchState, setEventFetchState] = useState('idle');
  /** Snapshot from the lazy fetch until the parent hoists the same rows into `events`. */
  const [localEvents, setLocalEvents] = useState(null);
  const [eventFetchRetry, setEventFetchRetry] = useState(0);

  useEffect(() => {
    setEventFetchState('idle');
    setLocalEvents(null);
  }, [messageId]);

  // If we don't have events yet AND this isn't a live stream, lazy-fetch them.
  // Live streams are populated via WS broadcasts, so no fetch is needed there.
  useEffect(() => {
    if (events !== undefined || streaming || !messageId) return;
    let cancelled = false;
    setEventFetchState('loading');
    api
      .getMessageEvents(messageId)
      .then((rows) => {
        if (cancelled) return;
        // API returns [{ id, seq, event_type, event, timestamp }, ...]
        const mapped = rows.map((r) => ({ seq: r.seq, event: r.event }));
        setLocalEvents(mapped);
        setEventFetchState('ok');
        onEventsLoaded?.(messageId, mapped);
      })
      .catch(() => {
        if (!cancelled) {
          setLocalEvents(null);
          setEventFetchState('error');
          // Do NOT call onEventsLoaded([]): once the parent caches any value
          // (including []), `events !== undefined` and the lazy effect skips
          // refetch, trapping StoredAssistantBubble while persisted assistant
          // content has ask fences stripped (bug: "question didn't generate").
        }
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, events, streaming, onEventsLoaded, eventFetchRetry]);

  const effectiveEvents = events !== undefined ? events : localEvents;
  const blocks = useMemo(() => eventsToBlocks(effectiveEvents ?? []), [effectiveEvents]);
  const hasEvents = !!effectiveEvents && effectiveEvents.length > 0;

  const timelineFetchPending =
    !streaming &&
    !!messageId &&
    events === undefined &&
    eventFetchState !== 'ok' &&
    eventFetchState !== 'error';

  const timelineFetchFailed =
    !streaming && !!messageId && events === undefined && eventFetchState === 'error';

  const outcome = useMemo(() => {
    if (timelineFetchPending || timelineFetchFailed) return null;
    return deriveAssistantTailOutcome({
      streaming,
      events: effectiveEvents ?? [],
      messageContent: message?.content,
    });
  }, [timelineFetchPending, timelineFetchFailed, streaming, effectiveEvents, message?.content]);

  // While we are fetching the event timeline, avoid StoredAssistantBubble: it
  // cannot render ask_user_question pickers, but persisted message.content has
  // ask fences stripped. A failed fetch used to cache [] and trap us there.
  if (timelineFetchPending) {
    return (
      <div className="flex justify-start mb-4 min-w-0">
        <div
          className="max-w-[95%] sm:max-w-[90%] w-full min-w-0 pl-3 border-l-2"
          style={{ borderColor: agentColor || '#374151' }}
        >
          <Header
            agentColor={agentColor}
            agentName={displayAgentName}
            engine={message?.engine}
            model={message?.model}
            streaming={false}
            createdAt={message?.created_at}
            outcome={null}
          />
          <div
            className="mt-3 flex items-center gap-2 text-xs text-gray-400"
            data-testid="session-tail-events-loading"
          >
            <Loader2 size={14} className="animate-spin text-gray-500" aria-hidden />
            <span>Loading message timeline…</span>
          </div>
        </div>
      </div>
    );
  }

  // Retry click handler: bump the fetch counter AND optimistically flip the
  // state to 'loading' in the same render. Without the optimistic flip the
  // UI keeps showing the error UI until the next effect tick fires the
  // fetch, which can feel like "nothing happened" when the API is slow —
  // user-reported as "if you hit retry it doesnt do anything".
  const handleRetryFetch = () => {
    setEventFetchState('loading');
    setEventFetchRetry((n) => n + 1);
  };

  if (timelineFetchFailed) {
    // If the message has persisted content, the rich timeline is just a
    // nice-to-have, the user should still be able to read what the model
    // said. Render the stored bubble (markdown content) plus a small inline
    // banner explaining the gap. Without this fallback the user is locked
    // out of their own reply for every transient fetch hiccup.
    if (message?.content) {
      return (
        <div data-testid="session-tail-events-error-with-content">
          <StoredAssistantBubble
            message={message}
            agentColor={agentColor}
            agentName={agentName}
            fromAgent={fromAgent}
            agents={agents}
            sessionHandoffs={sessionHandoffs}
            sessionDelegations={sessionDelegations}
            delegationDispatchError={delegationDispatchError}
            onOpenSession={onOpenSession}
          />
          <div className="flex justify-start -mt-2 mb-4 min-w-0">
            <div className="max-w-[95%] sm:max-w-[90%] w-full min-w-0 pl-3">
              <div
                className="flex items-center justify-between gap-3 rounded-md border border-amber-800/40 bg-amber-950/20 px-2.5 py-1.5 text-[11px] text-amber-100"
                data-testid="session-tail-events-error-banner"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <AlertTriangle size={12} className="text-amber-400 shrink-0" />
                  <span className="truncate">
                    Showing plain text; rich timeline (tools, pickers, streaming blocks)
                    couldn&apos;t load.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={handleRetryFetch}
                  className="shrink-0 rounded-md bg-amber-700/40 px-2 py-0.5 text-[11px] font-medium text-amber-50 hover:bg-amber-600/50"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    // No persisted content to fall back on — keep the block-level error UI.
    return (
      <div className="flex justify-start mb-4 min-w-0">
        <div
          className="max-w-[95%] sm:max-w-[90%] w-full min-w-0 pl-3 border-l-2"
          style={{ borderColor: agentColor || '#374151' }}
        >
          <Header
            agentColor={agentColor}
            agentName={displayAgentName}
            engine={message?.engine}
            model={message?.model}
            streaming={false}
            createdAt={message?.created_at}
            outcome={null}
          />
          <div
            className="mt-3 flex flex-col gap-2 rounded-lg border border-amber-800/50 bg-amber-950/25 px-3 py-2.5 text-xs text-amber-100"
            data-testid="session-tail-events-error"
          >
            <span className="flex items-center gap-2">
              <AlertTriangle size={14} className="text-amber-400 shrink-0" />
              Could not load the message timeline (tools, pickers, and streaming blocks). Check your
              connection and try again.
            </span>
            <button
              type="button"
              onClick={handleRetryFetch}
              className="self-start rounded-md bg-amber-700/40 px-2.5 py-1 text-[11px] font-medium text-amber-50 hover:bg-amber-600/50"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Fallback: when there are no events to render, but we have saved message
  // content, render the stored assistant bubble.
  if (
    !streaming &&
    !hasEvents &&
    message?.content &&
    (events !== undefined || eventFetchState === 'ok')
  ) {
    return (
      <StoredAssistantBubble
        message={message}
        agentColor={agentColor}
        agentName={agentName}
        fromAgent={fromAgent}
        agents={agents}
        sessionHandoffs={sessionHandoffs}
        sessionDelegations={sessionDelegations}
        delegationDispatchError={delegationDispatchError}
        onOpenSession={onOpenSession}
      />
    );
  }

  const streamingFallbackReview =
    streaming && blocks.length === 0 && message?.content
      ? extractReviewVerdictContent(stripAssistantControlBlocks(message.content))
      : null;
  const streamingFallbackText = streamingFallbackReview?.prose?.trim() || '';
  const hasBrowserActivity = (effectiveEvents ?? []).some(
    ({ event }) => event?.type === 'browser_tool_activity',
  );
  if (
    blocks.length === 0 &&
    !streamingFallbackText &&
    !hasBrowserActivity &&
    (!streaming || message?.content)
  ) {
    return null;
  }

  return (
    <div className="flex justify-start mb-4 min-w-0" data-message-id={messageId || undefined}>
      {/* Cursor-style assistant turn: no heavy bubble, just a thin left stripe
          in the agent's color so the column reads as one logical turn while
          letting individual cards/text breathe. The Header below carries the
          agent dot, engine/model badges, and timestamp. */}
      <div
        className="max-w-[95%] sm:max-w-[90%] w-full min-w-0 pl-3 border-l-2"
        style={{ borderColor: agentColor || '#374151' }}
      >
        <Header
          agentColor={agentColor}
          agentName={displayAgentName}
          engine={message?.engine}
          model={message?.model}
          streaming={streaming}
          createdAt={message?.created_at}
          outcome={outcome}
          onInterrupt={streaming ? onInterrupt : undefined}
        />

        <BrowserActivityPanel
          timelineEntries={effectiveEvents ?? []}
          streaming={streaming}
          screenshots={browserScreenshots}
        />

        {/* Streaming with no events yet, render the `stream` content
            if the server is still emitting that shape, otherwise show a
            waiting indicator until the first session-event arrives. */}
        {streaming && blocks.length === 0 && (
          <div className="mt-2">
            {streamingFallbackText ? (
              <TextBubble
                text={streamingFallbackText}
                fromAgent={fromAgent}
                agents={agents}
                sessionHandoffs={sessionHandoffs}
                sessionDelegations={sessionDelegations}
                delegationDispatchError={delegationDispatchError}
                parentMessageId={messageId}
                parentSessionActive={parentSessionActive}
                onOpenSession={onOpenSession}
              />
            ) : (
              <span className="text-xs text-gray-500 italic">Waiting for first event…</span>
            )}
          </div>
        )}

        <div className="space-y-1.5 mt-2">
          {blocks.map((block, i) => {
            switch (block.kind) {
              case 'system':
                return (
                  <SystemBanner
                    key={`b${i}`}
                    system={block.event}
                    messageEngine={message?.engine}
                    messageModel={message?.model}
                  />
                );
              case 'thinking':
                return <ThinkingBlock key={`b${i}`} text={block.event.text} />;
              case 'subagent':
                return <SubagentCard key={`b${i}`} use={block.use} result={block.result} />;
              case 'tool':
                return <ToolCard key={`b${i}`} use={block.use} result={block.result} />;
              case 'todos':
                return <TodoListCard key={`b${i}`} use={block.use} result={block.result} />;
              case 'explored':
                return <ExploredChip key={`b${i}`} items={block.items} />;
              case 'plan_proposal':
                return <PlanProposalCard key={`b${i}`} use={block.use} result={block.result} />;
              case 'text':
                return (
                  <TextBubble
                    key={`b${i}`}
                    text={block.text}
                    fromAgent={fromAgent}
                    agents={agents}
                    sessionHandoffs={sessionHandoffs}
                    sessionDelegations={sessionDelegations}
                    delegationDispatchError={delegationDispatchError}
                    parentMessageId={messageId}
                    parentSessionActive={parentSessionActive}
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
        <div data-testid="session-tail-bottom" className="h-px w-full shrink-0" aria-hidden />
      </div>
    </div>
  );
}

// ─── Reducer: events → display blocks ──────────────────────────────────

/**
 * Tools whose tool_use we coalesce into a single "Explored …" chip when they
 * appear in an uninterrupted run (no prose, errors, or other tool kinds in
 * between). Mirrors Cursor's "Explored 3 files, 1 search" status row — the
 * model is gathering context, not making changes, so per-call cards add noise.
 */
const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);

/**
 * Walk events and produce a flat list of display blocks. Pairs tool_use with
 * its tool_result by id (so we don't render orphan results), coalesces
 * consecutive assistant_text events into a single text bubble (partial-vs-
 * final precedence: final wins), and folds runs of read/search tool calls
 * into a single `explored` block.
 *
 * Single source of truth for layout: there is no verbose/compact toggle —
 * each block kind picks its own sensible default and provides a click-to-
 * expand affordance. Cursor's chat works the same way.
 */
export function eventsToBlocks(events) {
  const blocks = [];
  const list = events ?? [];

  // Cursor may emit a second tool_use for the same call_id when completed args
  // upgrade a path-only started payload — keep the latest input per id. This
  // dedup index is built BEFORE the result index below so:
  //   1. the walk in pass 2 can skip earlier revisions and only render the
  //      latest tool_use, and
  //   2. result pairing is still correct — both tool_use revisions share the
  //      same id string, and `resultByToolId` is keyed by that string, so the
  //      paired result is the same regardless of which revision survives.
  // If you swap the order or move dedup to a post-filter, re-verify pairing
  // against the test in SessionTail.test.jsx covering same-id tool_use revisions.
  const latestToolUseById = new Map();
  const lastToolUseIndex = new Map();
  list.forEach(({ event }, i) => {
    if (event?.type === 'tool_use' && event.id != null && String(event.id)) {
      const id = String(event.id);
      latestToolUseById.set(id, event);
      lastToolUseIndex.set(id, i);
    }
  });

  // First pass: index tool_results by tool_use_id for pairing.
  const resultByToolId = {};
  for (const { event } of list) {
    if (event?.type === 'tool_result' && event.toolUseId) {
      resultByToolId[event.toolUseId] = event;
    }
  }

  // Second pass: walk events, coalescing text and explore-tool runs.
  let textBuf = null; // { partials: '', final: '' }
  let exploredBuf = null; // { items: [{ use, result }] }
  let thinkingBuf = '';

  const flushText = () => {
    if (!textBuf) return;
    const rawText = textBuf.final || textBuf.partials;
    let prose = rawText;
    if (prose.includes('agenthub:ask')) {
      const { strippedText, asks } = extractAskBlocks(prose);
      if (asks.length > 0) {
        for (const ask of asks) {
          blocks.push({
            kind: 'ask_question',
            event: {
              type: 'ask_user_question',
              askId: ask.askId,
              questions: ask.questions,
            },
          });
        }
        prose = strippedText;
      }
    }
    // Strip skill/react/close-card tags from prose (not ask — handled above).
    const text = stripAssistantControlBlocks(prose);
    const review = extractReviewVerdictContent(text);
    if (review.prose && review.prose.trim()) blocks.push({ kind: 'text', text: review.prose });
    textBuf = null;
  };

  const flushExplored = () => {
    if (!exploredBuf) return;
    if (exploredBuf.items.length === 1) {
      // Single read/search keeps its own tool card — coalescing a single call
      // hides useful context (e.g. which file). Cursor only collapses bursts.
      const { use, result } = exploredBuf.items[0];
      blocks.push({ kind: 'tool', use, result });
    } else if (exploredBuf.items.length > 1) {
      blocks.push({ kind: 'explored', items: exploredBuf.items });
    }
    exploredBuf = null;
  };

  const flushThinking = () => {
    if (!thinkingBuf) return;
    blocks.push({ kind: 'thinking', event: { type: 'thinking', text: thinkingBuf } });
    thinkingBuf = '';
  };

  const flushAll = () => {
    flushExplored();
    flushText();
    flushThinking();
  };

  for (let i = 0; i < list.length; i++) {
    const { event } = list[i];
    if (!event) continue;
    const t = event.type;

    // Text breaks an explored run (model said something between reads → new
    // logical phase). Buffer text separately so a clean burst stays clean.
    if (t === 'assistant_text') {
      flushExplored();
      flushThinking();
      if (!textBuf) textBuf = { partials: '', final: '' };
      if (event.partial) textBuf.partials += event.text;
      else textBuf.final += event.text;
      continue;
    }

    // Tool results are folded into their paired tool_use; on their own they
    // never break an explored run.
    if (t === 'tool_result') continue;

    if (t === 'thinking') {
      flushExplored();
      flushText();
      thinkingBuf += event.text || '';
      continue;
    }

    // Hidden / internal: don't surface, but also don't break the buffers —
    // these can interleave with reads without changing the "burst" semantics.
    if (t === 'progress_step') continue;
    // Host browser ReAct steps — rendered by BrowserActivityPanel above the block list.
    if (t === 'browser_tool_activity') continue;
    if (t === 'checkpoint') continue;
    if (t === 'rate_limit') continue;
    if (shouldSuppressStreamEvent(event)) continue;

    if (t === 'tool_use') {
      const toolId = event.id != null ? String(event.id) : '';
      if (toolId && lastToolUseIndex.get(toolId) !== i) continue;
      const use = toolId ? (latestToolUseById.get(toolId) ?? event) : event;
      const isSubagent = use.tool === 'Task' || use.tool === 'Agent';
      // ExitPlanMode (Claude's plan-mode proposal) routes to a dedicated card
      // so the plan renders as markdown without ERROR styling — its
      // tool_result is `is_error: true` by design under non-interactive CLI
      // ("plan approval declined" is the expected flow).
      const isExitPlanMode = use.tool === 'ExitPlanMode';
      const isTodoWrite = use.tool === 'TodoWrite';
      const result = resultByToolId[use.id];
      const isExplore = EXPLORE_TOOLS.has(use.tool) && !result?.isError;
      if (isExplore) {
        flushText();
        flushThinking();
        if (!exploredBuf) exploredBuf = { items: [] };
        exploredBuf.items.push({ use, result });
        continue;
      }
      flushAll();
      let kind = 'tool';
      if (isSubagent) kind = 'subagent';
      else if (isExitPlanMode) kind = 'plan_proposal';
      else if (isTodoWrite) kind = 'todos';
      blocks.push({ kind, use, result });
      continue;
    }

    // Anything else closes both buffers.
    flushAll();

    if (t === 'system') blocks.push({ kind: 'system', event });
    else if (t === 'result') blocks.push({ kind: 'result', event });
    else if (t === 'ask_user_question') blocks.push({ kind: 'ask_question', event });
    else if (t === 'error') blocks.push({ kind: 'error', event });
    else blocks.push({ kind: 'unknown', event });
  }
  flushAll();
  return blocks;
}

// ─── Sub-components ────────────────────────────────────────────────────

const ENGINE_BADGES = {
  'claude-code': {
    icon: <span className="w-2.5 h-2.5 rounded-full bg-purple-500 inline-block" />,
    label: 'Claude Code',
  },
  'cursor-agent': {
    icon: <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />,
    label: 'Cursor Agent',
  },
  'codex-cli': {
    icon: <span className="w-2.5 h-2.5 rounded-full bg-sky-500 inline-block" />,
    label: 'Codex',
  },
};

/** Full markdown + CodeBlock stack — same as ChatMessage for readable diffs / fences. */
const MARKDOWN_COMPONENTS = markdownComponents;

function truncateStatusDetail(s, max) {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function Header({
  agentColor,
  agentName,
  engine,
  model,
  streaming,
  createdAt,
  outcome,
  onInterrupt,
}) {
  const badge = engine ? ENGINE_BADGES[engine] : null;
  const modelLabel = model ? model.replace('claude-', '').replace(/-/g, ' ') : null;
  const phase = outcome?.phase;
  const showWorking = streaming || phase === 'working';
  const showTerminal = !showWorking && outcome && (phase === 'done' || phase === 'error');
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: agentColor }} />
      <span className="text-gray-500 font-medium shrink-0">{agentName || 'Assistant'}</span>
      {badge && (
        <span className="text-gray-600 flex items-center gap-1 shrink-0" title={badge.label}>
          {badge.icon}
          <span className="hidden sm:inline">{badge.label}</span>
        </span>
      )}
      {modelLabel && <span className="text-gray-600 shrink-0">· {modelLabel}</span>}
      {showWorking && (
        <span
          className="flex items-center gap-1 ml-0.5 shrink-0"
          data-testid="assistant-status-working"
        >
          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
          <span className="text-emerald-500">streaming</span>
        </span>
      )}
      {showWorking && typeof onInterrupt === 'function' && (
        <button
          type="button"
          onClick={onInterrupt}
          className="ml-1 shrink-0 rounded-md bg-amber-600/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-500 transition-colors"
          title="Interrupt streaming response"
          aria-label="Interrupt streaming response"
          data-testid="session-tail-interrupt"
        >
          Interrupt
        </button>
      )}
      {showTerminal && phase === 'done' && (
        <span
          className="flex items-center gap-1 ml-0.5 shrink-0 text-emerald-400/95"
          data-testid="assistant-status-done"
        >
          <ListChecks size={12} className="shrink-0" aria-hidden />
          <span className="text-[11px] font-medium">done</span>
        </span>
      )}
      {showTerminal && phase === 'error' && (
        <span
          className="flex items-center gap-1 ml-0.5 min-w-0 max-w-full sm:max-w-[min(100%,20rem)] text-red-400/95"
          title={outcome.detail || 'Error'}
          data-testid="assistant-status-error"
        >
          <AlertTriangle size={12} className="shrink-0" aria-hidden />
          <span className="text-[11px] font-medium truncate">
            error
            {outcome.detail ? ` — ${truncateStatusDetail(outcome.detail, 96)}` : ''}
          </span>
        </span>
      )}
      <span className="ml-auto text-gray-600 shrink-0">
        {createdAt ? relativeTime(createdAt) : ''}
      </span>
    </div>
  );
}

function SystemBanner({ system, messageEngine, messageModel }) {
  // Compact badge showing model + cwd. Session id only on hover.
  const modelLine = formatSystemBannerModelLine({
    streamModel: system?.model,
    sessionModel: messageModel,
    sessionEngine: messageEngine,
  });
  const titleParts = [];
  if (system?.sessionId) titleParts.push(`session ${system.sessionId}`);
  if (
    trimmedModelId(system?.model) &&
    trimmedModelId(messageModel) &&
    system.model !== messageModel
  ) {
    titleParts.push(`CLI ${trimmedModelId(system.model)} · Hub ${trimmedModelId(messageModel)}`);
  }
  return (
    <div
      className="text-xs text-gray-500 bg-gray-900/50 rounded-md px-2 py-1 font-mono truncate"
      title={titleParts.join(' — ') || undefined}
    >
      {modelLine}
      {system?.cwd && <span className="text-gray-600"> · {system.cwd}</span>}
    </div>
  );
}

function trimmedModelId(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
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
          {!open && text.replace(/\s+/g, ' ').trim().slice(0, 80)}
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
  ExitPlanMode: {
    color: 'border-violet-700/60 bg-violet-950/30',
    icon: <ClipboardList size={16} />,
  },
};

/**
 * Humanized one-line headline for a tool call (Cursor-style):
 *   { headline: "Re-run live test with adjoiner overlay", arg: "pytest -k …" }
 *
 * Rules:
 *  - Bash: prefer the model-supplied `description` ("intent"); show the
 *    command as a small monospace chip beneath. Falls back to the command
 *    itself if no description was provided.
 *  - Read/Edit/Write: "Read foo.ts" / "Edit src/foo.ts" — verb + basename.
 *  - Grep/Glob/Web*: search-shaped verbs with the pattern/url as the arg.
 *  - Anything else: best-effort verb + first useful string field.
 *
 * Returns null fields when nothing meaningful is available; the caller
 * decides what to render.
 */
export function describeTool(tool, input) {
  const obj = input && typeof input === 'object' ? input : {};
  const baseName = (p) => {
    if (!p || typeof p !== 'string') return '';
    const segs = p.split('/').filter(Boolean);
    return segs[segs.length - 1] || p;
  };
  switch (tool) {
    case 'Bash': {
      const cmd = typeof obj.command === 'string' ? obj.command.trim() : '';
      const desc = typeof obj.description === 'string' ? obj.description.trim() : '';
      if (desc) return { headline: desc, arg: cmd };
      return { headline: cmd ? `Run ${truncateOneLine(cmd, 64)}` : 'Run shell command', arg: '' };
    }
    case 'Read':
      return { headline: `Read ${baseName(obj.file_path || obj.path) || 'file'}`, arg: '' };
    case 'Edit':
      return { headline: `Edit ${baseName(obj.file_path || obj.path) || 'file'}`, arg: '' };
    case 'Write':
      return { headline: `Write ${baseName(obj.file_path || obj.path) || 'file'}`, arg: '' };
    case 'Grep': {
      const p = typeof obj.pattern === 'string' ? obj.pattern : '';
      const path = typeof obj.path === 'string' ? obj.path : '';
      const head = p
        ? `Search ${path ? `${baseName(path)} ` : ''}for /${truncateOneLine(p, 40)}/`
        : 'Search files';
      return { headline: head, arg: '' };
    }
    case 'Glob': {
      const p = typeof obj.pattern === 'string' ? obj.pattern : '';
      return { headline: p ? `Find files matching ${p}` : 'Find files', arg: '' };
    }
    case 'WebFetch': {
      const url = typeof obj.url === 'string' ? obj.url : '';
      return { headline: url ? `Fetch ${truncateOneLine(url, 60)}` : 'Fetch URL', arg: '' };
    }
    case 'WebSearch': {
      const q = typeof obj.query === 'string' ? obj.query : '';
      return {
        headline: q ? `Search the web for "${truncateOneLine(q, 60)}"` : 'Web search',
        arg: '',
      };
    }
    case 'NotebookRead':
      return { headline: `Read notebook ${baseName(obj.notebook_path) || ''}`.trim(), arg: '' };
    case 'NotebookEdit':
      return { headline: `Edit notebook ${baseName(obj.notebook_path) || ''}`.trim(), arg: '' };
    case 'Task':
      return { headline: obj.description || 'Run subagent task', arg: '' };
    case 'TodoWrite': {
      const todos = Array.isArray(obj.todos) ? obj.todos : [];
      const done = todos.filter((t) => t?.status === 'completed').length;
      return { headline: `${done} of ${todos.length} Done`, arg: '' };
    }
    case 'ExitPlanMode': {
      const plan = typeof obj.plan === 'string' ? obj.plan : '';
      const first = plan.split('\n').find((l) => l.trim()) || '';
      return { headline: first.replace(/^#+\s*/, '') || 'Plan proposal', arg: '' };
    }
    default: {
      // Best-effort: the first non-empty string-valued field.
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && v) return { headline: tool, arg: truncateOneLine(v, 80) };
      }
      return { headline: tool, arg: '' };
    }
  }
}

function truncateOneLine(s, max) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

/** How many addition lines we show in the collapsed preview before "+ N more". */
const DIFF_PREVIEW_LINES = 5;

/**
 * DiffView — colorized diff for Edit / Write / Codex `file_change` tools.
 *
 * Two visual modes:
 *  - **Preview** (default): Cursor-style — header strip with `file.ext +N -M`
 *    and a few addition lines (DIFF_PREVIEW_LINES). Hidden lines are summarized
 *    as a `N more lines` footer that expands to the full diff on click. This
 *    matches the pattern in the Cursor screenshots — the chat stays scannable
 *    even when the model rewrites a 200-line file.
 *  - **Full**: every removal followed by every addition, scrollable. Used when
 *    the user clicks the preview footer or when the change has fewer than
 *    `DIFF_PREVIEW_LINES` lines (no truncation needed).
 */
export function DiffView({ tool, input, toolResult }) {
  const mergedInput = useMemo(
    () => mergeEditInputWithToolResult(input, toolResult),
    [input, toolResult],
  );
  const { filePath, action, removals, additions } = parseDiffLines(tool, mergedInput);
  const [expanded, setExpanded] = useState(false);
  const hasLines = diffHasDisplayableLines(tool, mergedInput);

  const addedCount = additions.filter((l) => l.trim()).length;
  const removedCount = removals.filter((l) => l.trim()).length;
  const totalLines = removals.length + additions.length;
  const canPreview = totalLines > DIFF_PREVIEW_LINES;
  const showFull = expanded || !canPreview;
  const previewLines = additions.length > 0 ? additions : removals;
  const previewKind = additions.length > 0 ? 'add' : 'remove';
  const hiddenCount = totalLines - Math.min(previewLines.length, DIFF_PREVIEW_LINES);

  return (
    <div className="bg-gray-950/60 rounded-md overflow-hidden font-mono text-xs">
      {/* File path header */}
      <div className="flex items-center gap-2 px-2 py-1 bg-gray-900/80 text-gray-400 border-b border-gray-800/50">
        <span className="text-emerald-500 font-semibold">{action}:</span>
        <span className="truncate">{shortenPath(filePath)}</span>
        <span className="ml-auto text-[10px] text-gray-600 shrink-0">
          {addedCount > 0 && <span className="text-emerald-500">+{addedCount}</span>}
          {removedCount > 0 && <span className="text-red-400 ml-1">-{removedCount}</span>}
        </span>
      </div>
      {!hasLines ? (
        <p className="px-2 py-2 text-[11px] text-gray-500 border-t border-gray-800/50">
          {/*
           * Three placeholder paths:
           *  - Write with explicit content:'' → "(empty file)". The model
           *    intentionally created/cleared a zero-byte file; calling this
           *    "pending or unavailable" would misreport a successful write.
           *  - Edit with a file path but no diff content → "pending or
           *    unavailable". Either a cancelled stream (flush() drained the
           *    deferred tool_use with empty strReplace) or Composer 2.5
           *    omitted the line bodies entirely.
           *  - Anything else → generic "no diff lines" copy.
           */}
          {isExplicitEmptyWrite(tool, mergedInput)
            ? '(empty file)'
            : filePath
              ? 'Diff content pending or unavailable for this edit.'
              : 'No diff lines to display.'}
        </p>
      ) : showFull ? (
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          {removals.map((line, i) => (
            <div
              key={`r${i}`}
              className="flex px-2 py-px bg-red-950/40 text-red-300 border-l-2 border-red-600"
            >
              <span className="text-red-500/60 select-none mr-2 flex-shrink-0">-</span>
              <span
                className="whitespace-pre min-w-0 flex-1 text-red-200"
                style={{ tabSize: 2, MozTabSize: 2 }}
              >
                {line.length === 0 ? '\u00a0' : line}
              </span>
            </div>
          ))}
          {additions.map((line, i) => (
            <div
              key={`a${i}`}
              className="flex px-2 py-px bg-emerald-950/40 text-emerald-300 border-l-2 border-emerald-600"
            >
              <span className="text-emerald-500/60 select-none mr-2 flex-shrink-0">+</span>
              <span
                className="whitespace-pre min-w-0 flex-1 text-emerald-200"
                style={{ tabSize: 2, MozTabSize: 2 }}
              >
                {line.length === 0 ? '\u00a0' : line}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            {previewLines.slice(0, DIFF_PREVIEW_LINES).map((line, i) => (
              <div
                key={`p${i}`}
                className={`flex px-2 py-px ${
                  previewKind === 'add'
                    ? 'bg-emerald-950/30 text-emerald-300 border-l-2 border-emerald-600/60'
                    : 'bg-red-950/30 text-red-300 border-l-2 border-red-600/60'
                }`}
              >
                <span
                  className={`select-none mr-2 flex-shrink-0 ${
                    previewKind === 'add' ? 'text-emerald-500/60' : 'text-red-500/60'
                  }`}
                >
                  {previewKind === 'add' ? '+' : '-'}
                </span>
                <span
                  className={`whitespace-pre min-w-0 flex-1 ${
                    previewKind === 'add' ? 'text-emerald-200' : 'text-red-200'
                  }`}
                  style={{ tabSize: 2, MozTabSize: 2 }}
                >
                  {line.length === 0 ? '\u00a0' : line}
                </span>
              </div>
            ))}
          </div>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full text-left text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 bg-gray-900/40 border-t border-gray-800/40"
              data-testid="diff-view-expand"
            >
              {hiddenCount} more {hiddenCount === 1 ? 'line' : 'lines'} · view all
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function ToolCard({ use, result, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const style = TOOL_STYLES[use.tool] || {
    color: 'border-gray-700/60 bg-gray-900/40',
    icon: <Wrench size={16} />,
  };
  const { headline, arg } = describeTool(use.tool, use.input);
  const errored = result?.isError;
  const stillRunning = !result;
  const showDiff = isFileModifyingTool(use.tool);
  const isBash =
    use.tool === 'Bash' &&
    typeof use.input?.command === 'string' &&
    use.input.command.trim().length > 0;

  // File-modifying tools: always show the diff from the latest tool input. When
  // the CLI flags `is_error`, we still render the diff (what was attempted)
  // plus the error body below — the old `!errored` early return hid the diff
  // entirely, so only the collapsible error card updated (Electron bug report).
  if (showDiff) {
    return (
      <div
        className={`border rounded-lg overflow-hidden ${style.color} ${errored ? 'border-red-700/80' : ''}`}
      >
        <DiffView tool={use.tool} input={use.input} toolResult={result} />
        {stillRunning && (
          <div className="flex items-center gap-2 px-2 py-1 border-t border-black/20 bg-black/10">
            <span className="text-emerald-400 text-[10px] animate-pulse">running…</span>
          </div>
        )}
        {result && errored && (
          <div className="border-t border-red-900/50 bg-red-950/25 px-2 py-2">
            <div className="text-[10px] text-red-400 uppercase tracking-wide mb-1">error</div>
            <pre className="text-xs text-red-200 bg-red-950/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-96">
              {result.output || '(empty)'}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`border rounded-lg overflow-hidden ${style.color} ${errored ? 'border-red-700/80' : ''}`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-black/20"
      >
        <span className="flex-shrink-0">{style.icon}</span>
        {/* Cursor-style: humanized headline as the primary text, with the raw
            argument (e.g. the actual shell command) as a small monospace chip
            after it. Falls back to the tool name when describeTool can't
            produce something better. */}
        <span className="text-gray-200 truncate min-w-0">{headline || use.tool}</span>
        {arg && (
          <code className="hidden sm:inline-block text-[10px] text-gray-500 bg-black/30 rounded px-1.5 py-0.5 max-w-[40%] truncate font-mono shrink">
            {arg}
          </code>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {stillRunning && (
            <span className="text-emerald-400 text-[10px] animate-pulse">running…</span>
          )}
          {errored && (
            <span className="text-red-400 text-[10px] uppercase tracking-wide">error</span>
          )}
          <span className="text-gray-500 text-2xl leading-none flex items-center">
            {open ? '▼' : '▶'}
          </span>
        </span>
      </button>
      {open && isBash && (
        <div
          data-testid="bash-terminal"
          className="border-t border-black/30 bg-black/40 font-mono text-xs"
        >
          {/* Terminal-style: `$ <command>` followed by stdout/stderr, the way
              Cursor renders Bash tool calls. We deliberately render the full
              command (no truncation) and let it wrap so chained commands like
              `cd ... && git push ...` stay scannable. */}
          <div className="px-3 py-2 border-b border-black/30">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">command</div>
            <div className="flex items-start gap-2 text-gray-100 whitespace-pre-wrap break-words">
              <span className="text-emerald-500 select-none shrink-0">$</span>
              <span className="flex-1 break-all">{use.input.command}</span>
            </div>
            {typeof use.input.description === 'string' && use.input.description.trim() && (
              <div className="mt-1 text-[10px] text-gray-500 italic">
                {use.input.description.trim()}
              </div>
            )}
          </div>
          {result && (
            <pre
              className={`px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words max-h-96 ${errored ? 'text-red-300' : 'text-gray-300'}`}
            >
              {result.output || '(empty)'}
            </pre>
          )}
          {!result && (
            <div className="px-3 py-2 text-[10px] text-emerald-400 animate-pulse">running…</div>
          )}
        </div>
      )}
      {open && !isBash && (
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

/**
 * ExploredChip — coalesced summary for a burst of read/search tool calls.
 * Cursor renders these as a single line ("Explored 3 files, 1 search") with
 * a click-to-expand list. We do the same: show the count chip by default,
 * expand to a small bullet list of the underlying calls. Items array carries
 * `{ use, result }` for each tool call, in original order.
 */
export function ExploredChip({ items, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const counts = items.reduce(
    (acc, it) => {
      const t = it.use?.tool;
      if (t === 'Read' || t === 'NotebookRead') acc.files += 1;
      else if (t === 'Grep') acc.searches += 1;
      else if (t === 'Glob') acc.globs += 1;
      else if (t === 'WebFetch' || t === 'WebSearch') acc.web += 1;
      return acc;
    },
    { files: 0, searches: 0, globs: 0, web: 0 },
  );
  const parts = [];
  if (counts.files) parts.push(`${counts.files} file${counts.files === 1 ? '' : 's'}`);
  if (counts.searches) parts.push(`${counts.searches} search${counts.searches === 1 ? '' : 'es'}`);
  if (counts.globs) parts.push(`${counts.globs} glob${counts.globs === 1 ? '' : 's'}`);
  if (counts.web) parts.push(`${counts.web} web`);
  const summary = parts.length > 0 ? parts.join(', ') : `${items.length} items`;
  return (
    <div className="border border-gray-800 rounded-lg bg-gray-900/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-400 hover:bg-gray-900/60"
        data-testid="explored-chip"
      >
        <FolderSearch size={14} className="text-gray-500 shrink-0" />
        <span className="text-gray-300">Explored</span>
        <span className="text-gray-500 truncate">{summary}</span>
        <span className="ml-auto text-gray-500 text-2xl leading-none flex items-center">
          {open ? '▼' : '▶'}
        </span>
      </button>
      {open && (
        <ul className="border-t border-gray-800/60 px-3 py-2 space-y-1">
          {items.map((it, i) => {
            const d = describeTool(it.use?.tool, it.use?.input);
            return (
              <li
                key={`ex${i}`}
                className="text-[11px] text-gray-400 flex items-center gap-2 min-w-0"
              >
                <span className="text-gray-600 font-mono shrink-0">{it.use?.tool}</span>
                <span className="text-gray-300 truncate">{d.headline}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * TodoListCard — dedicated rendering for the CLI's `TodoWrite` tool. Cursor
 * renders this as a "M of N Done · View all" panel with status icons and
 * strikethrough for completed items. The generic ToolCard is too noisy here
 * because it hides the actual list behind a click.
 *
 * Default state: show ~4 items (mix of in-progress and pending), with a
 * `View all` toggle that expands to the full list. When every item is
 * completed or cancelled, the collapsed filter would otherwise yield an empty
 * list under a truthful "N of N Done" header — we fall back to the last few
 * terminal rows so the card still reads as intentional.
 */
const TODO_STATUS_GLYPH = {
  completed: { mark: '✓', cls: 'text-emerald-500' },
  in_progress: { mark: '◐', cls: 'text-blue-400' },
  cancelled: { mark: '✕', cls: 'text-gray-500' },
  pending: { mark: '○', cls: 'text-gray-500' },
};

export function TodoListCard({ use, result, defaultOpen }) {
  const todos = Array.isArray(use?.input?.todos) ? use.input.todos : [];
  const done = todos.filter((t) => t?.status === 'completed').length;
  const total = todos.length;
  const errored = result?.isError;
  const stillRunning = !result;
  const [open, setOpen] = useState(defaultOpen ?? false);

  const maxCollapsed = 4;
  const activeOnly = todos.filter((t) => t?.status !== 'completed' && t?.status !== 'cancelled');

  // When collapsed: first few active todos. When open: all in original order.
  let visible = open ? todos : activeOnly.slice(0, maxCollapsed);

  // Collapsed UI hides completed/cancelled; if nothing active remains, show
  // up to `maxCollapsed` terminal items (tail order) instead of an empty <ul>.
  if (!open && visible.length === 0 && total > 0) {
    const terminal = todos.filter((t) => t?.status === 'completed' || t?.status === 'cancelled');
    visible = terminal.slice(-maxCollapsed);
  }

  return (
    <div className="border border-gray-700/60 bg-gray-900/40 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-black/20"
        data-testid="todo-list-toggle"
      >
        <ListChecks size={14} className="text-gray-400 shrink-0" />
        <span className="text-gray-200 font-medium">
          {done} of {total} Done
        </span>
        <span className="text-gray-500">{open ? '· Hide' : '· View all'}</span>
        {stillRunning && (
          <span className="text-emerald-400 text-[10px] animate-pulse ml-auto">running…</span>
        )}
        {!stillRunning && errored && (
          <span className="text-red-400 text-[10px] uppercase tracking-wide ml-auto">error</span>
        )}
      </button>
      {todos.length > 0 && (
        <ul className="border-t border-gray-800/60 px-3 py-2 space-y-1">
          {visible.map((t, i) => {
            const g = TODO_STATUS_GLYPH[t?.status] || TODO_STATUS_GLYPH.pending;
            const completed = t?.status === 'completed';
            const cancelled = t?.status === 'cancelled';
            return (
              <li
                key={`todo${i}`}
                className="text-[12px] text-gray-300 flex items-start gap-2 min-w-0"
              >
                <span className={`shrink-0 ${g.cls}`}>{g.mark}</span>
                <span
                  className={`truncate ${
                    completed
                      ? 'line-through text-gray-500'
                      : cancelled
                        ? 'line-through text-gray-600'
                        : ''
                  }`}
                  title={t?.content || ''}
                >
                  {t?.content || '(untitled)'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * PlanProposalCard — dedicated rendering for the CLI's `ExitPlanMode` tool
 * call. In Claude Code's `--permission-mode plan` flow, Claude calls
 * ExitPlanMode with a markdown `plan` string to ask the user to approve
 * leaving plan mode. In non-interactive (`--print`) mode the approval prompt
 * has no user to answer and the CLI's tool_result comes back flagged
 * `is_error: true` ("plan approval declined"). That's the EXPECTED flow in an
 * ask-mode session — the user reviews the plan in the UI and decides whether
 * to flip ask_mode off separately. The generic ToolCard rendered that as a
 * red ERROR box, which made plan mode look broken. This card instead renders
 * the plan as rendered markdown, omits the ERROR styling, and surfaces the
 * CLI's decline message as a subtle status note.
 */
function PlanProposalCard({ use, result, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  const planText = typeof use?.input?.plan === 'string' ? use.input.plan : '';
  const stillRunning = !result;
  // result.isError is expected in non-interactive plan mode — it just means
  // "user did not approve exiting plan mode", which is the right default for
  // an ask-mode session. We surface it as a neutral status, not an error.
  const declined = !!result?.isError;
  const summary = planText
    .split('\n')
    .find((l) => l.trim())
    ?.replace(/^#+\s*/, '')
    ?.slice(0, 120);

  return (
    <div className="border rounded-lg overflow-hidden border-violet-700/60 bg-violet-950/20">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-black/20"
      >
        <span className="flex-shrink-0 text-violet-300">
          <ClipboardList size={16} />
        </span>
        <span className="font-mono font-semibold text-violet-200 flex-shrink-0">Plan proposal</span>
        <span className="text-gray-400 truncate flex-1">{summary || '(empty plan)'}</span>
        {stillRunning && (
          <span className="text-emerald-400 text-[10px] animate-pulse">running…</span>
        )}
        {!stillRunning && declined && (
          <span
            className="text-violet-300 text-[10px] uppercase tracking-wide"
            title="Plan-mode sessions are read-only — Claude surfaced this plan for your review. Toggle ask mode off to let Claude execute it."
          >
            awaiting review
          </span>
        )}
        {!stillRunning && !declined && (
          <span className="text-emerald-300 text-[10px] uppercase tracking-wide">approved</span>
        )}
        <span className="text-gray-500 text-2xl leading-none flex items-center">
          {open ? '▼' : '▶'}
        </span>
      </button>
      {open && (
        <div className="border-t border-black/30 p-3">
          {planText ? (
            <div className="markdown-content text-sm text-gray-200 leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={MARKDOWN_COMPONENTS}
              >
                {planText}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="text-xs text-gray-500 italic">(empty plan)</div>
          )}
          {!stillRunning && declined && (
            <div className="mt-3 text-[11px] text-violet-300/80 bg-violet-950/30 border border-violet-800/50 rounded px-2 py-1.5">
              This session is in <strong>ask mode</strong> (plan-only). Review the proposal and, if
              you want Claude to execute it, turn ask mode off in the session header.
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

function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function TextBubble({
  text,
  fromAgent,
  agents,
  sessionHandoffs,
  sessionDelegations,
  delegationDispatchError,
  parentMessageId,
  parentSessionActive,
  onOpenSession,
}) {
  // Strip <agenthub:skill> / <agenthub:react> / … before coordination blocks.
  // `eventsToBlocks` already strips for persisted session_events, but this
  // bubble also renders `message.content` during early streaming (before the
  // first session_event) — that path must not leak fenced skill blocks into
  // the markdown renderer.
  const scrubbed = stripAssistantControlBlocks(text);
  // Strip any <handoff>/<delegate> blocks from the prose so the raw JSON
  // wall doesn't end up rendered inline. The blocks are surfaced separately
  // as dedicated cards below the prose. Rendering delegate blocks here as a
  // persistent `DelegateCard` is the fix for the "delegate sometimes
  // doesn't show up" bug — the side `DelegationPanel` is driven by live
  // WebSocket events that can be dropped or missed when the user switches
  // sessions, so the message-anchored card is the reliable visual signal.
  const { stripped, handoff, handoffMalformed, delegate, delegateMalformed } =
    extractCoordinationBlocks(scrubbed);
  const review = extractReviewVerdictContent(stripped);
  const handoffRow = handoff ? pickHandoffRow(handoff, sessionHandoffs) : null;
  const malformedProps = handoffMalformed
    ? buildMalformedHandoffProps(handoffMalformed, sessionHandoffs)
    : null;
  const delegateReasonText = delegateMalformed
    ? describeDelegateReason(delegateMalformed.reason)
    : null;
  return (
    <>
      {review.prose ? (
        <div className="markdown-content text-gray-200 text-sm leading-relaxed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={MARKDOWN_COMPONENTS}
          >
            {review.prose}
          </ReactMarkdown>
        </div>
      ) : null}
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
      {!handoff && malformedProps && (
        <HandoffCard
          toAgentId={malformedProps.toAgentId}
          note={malformedProps.note}
          fromAgent={fromAgent}
          agents={agents}
          handoff={malformedProps.handoff}
          onOpenSession={onOpenSession}
        />
      )}
      {(delegate || delegateMalformed) && (
        <DelegateCard
          tasks={delegate}
          malformed={delegateMalformed}
          malformedReasonText={delegateReasonText}
          agents={agents}
          sessionDelegations={sessionDelegations}
          parentMessageId={parentMessageId}
          parentSessionActive={parentSessionActive}
          dispatchError={delegationDispatchError}
        />
      )}
    </>
  );
}

/**
 * Build HandoffCard props for a malformed `<handoff>` block. The server now
 * persists a failed row + broadcasts `handoff_error` for malformed payloads
 * (see `server/chat.ts`), so we prefer the server-side row when present
 * (`sessionHandoffs` entry with status='failed'). When the row hasn't
 * arrived yet (client parsed the block locally before the broadcast) we
 * synthesize a minimal failed row so the widget still renders with the
 * correct reason text.
 */
function buildMalformedHandoffProps(malformed, sessionHandoffs) {
  const serverRow = Array.isArray(sessionHandoffs)
    ? sessionHandoffs.find(
        (h) => h?.status === 'failed' && (!h?.to_agent_id || h.to_agent_id === '(unknown)'),
      )
    : null;
  const reasonText = describeHandoffReason(malformed.reason);
  const note =
    (malformed.rawBody || '').trim().length > 0 ? malformed.rawBody.trim() : `(${reasonText})`;
  const handoffProp = serverRow || {
    id: null,
    to_agent_id: null,
    to_session_id: null,
    status: 'failed',
    error: reasonText,
  };
  return {
    toAgentId: '(unknown)',
    note,
    handoff: handoffProp,
  };
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
 * Fallback bubble for stored assistant messages when event rows are absent.
 */
function StoredAssistantBubble({
  message,
  agentColor,
  agentName,
  fromAgent,
  agents,
  sessionHandoffs,
  sessionDelegations,
  delegationDispatchError,
  onOpenSession,
}) {
  // Strip coordination blocks here too. Stored messages may include the
  // raw `<handoff>...</handoff>` JSON in their content. Delegate blocks get
  // the same treatment: the message-anchored DelegateCard is the persistent
  // visual record even when live WebSocket events never arrived.
  const scrubbed = stripAssistantControlBlocks(message.content);
  const { stripped, handoff, handoffMalformed, delegate, delegateMalformed } =
    extractCoordinationBlocks(scrubbed);
  const review = extractReviewVerdictContent(stripped);
  const handoffRow = handoff ? pickHandoffRow(handoff, sessionHandoffs) : null;
  const malformedProps = handoffMalformed
    ? buildMalformedHandoffProps(handoffMalformed, sessionHandoffs)
    : null;
  const delegateReasonText = delegateMalformed
    ? describeDelegateReason(delegateMalformed.reason)
    : null;
  const outcome = deriveAssistantTailOutcome({
    streaming: false,
    events: [],
    messageContent: message.content,
  });
  const hasAssistantBubbleContent =
    Boolean(review.prose) ||
    Boolean(handoff) ||
    Boolean(malformedProps) ||
    Boolean(delegate) ||
    Boolean(delegateMalformed);
  if (!hasAssistantBubbleContent) return null;

  return (
    <div className="flex justify-start mb-4 min-w-0">
      <div className="max-w-[95%] sm:max-w-[90%] min-w-0 bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
        <Header
          agentColor={agentColor}
          agentName={message.agent_name || fromAgent?.name || agentName || undefined}
          engine={message.engine}
          model={message.model}
          streaming={false}
          createdAt={message.created_at}
          outcome={outcome}
        />
        {review.prose ? (
          <div className="markdown-content text-gray-200 mt-1">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={MARKDOWN_COMPONENTS}
            >
              {review.prose}
            </ReactMarkdown>
          </div>
        ) : null}
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
        {!handoff && malformedProps && (
          <HandoffCard
            toAgentId={malformedProps.toAgentId}
            note={malformedProps.note}
            fromAgent={fromAgent}
            agents={agents}
            handoff={malformedProps.handoff}
            onOpenSession={onOpenSession}
          />
        )}
        {(delegate || delegateMalformed) && (
          <DelegateCard
            tasks={delegate}
            malformed={delegateMalformed}
            malformedReasonText={delegateReasonText}
            agents={agents}
            sessionDelegations={sessionDelegations}
            parentMessageId={message?.id}
            // Stored persisted messages are inherently historical. The turn
            // ended long ago, so an empty live snapshot here means dispatch
            // didn't happen (or the WS broadcast was never received). Default
            // to the historical branch so we render "Did not start" instead
            // of an indefinite "Awaiting dispatch" spinner.
            parentSessionActive={false}
            dispatchError={delegationDispatchError}
          />
        )}
      </div>
    </div>
  );
}

export default memo(SessionTail);
