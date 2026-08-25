/**
 * Mobile twin of the reducer in `client/src/components/SessionTail.jsx`.
 *
 * Walks session-events and produces display blocks with the same kinds and
 * coalescing rules as the web client (explored burst, todos, plan_proposal,
 * checkpoint/rate_limit suppressed, etc.).
 *
 * Pure functions — unit-tested without a React Native environment.
 */
import { stripAssistantControlBlocks } from '@shared/utils/stripAssistantControlBlocks';
import { shouldSuppressStreamEvent } from '@shared/utils/benignStreamEvents';
import { isSidechainStreamEvent } from '@shared/utils/sidechainStreamEvents';
import {
  lastFinalAssistantTextIndex,
  isSupersededPartialText,
} from '@shared/utils/assistantTextPartials';
import { extractCredentialRequestBlocks } from './credentialRequests';
import { isScheduleWakeupTool } from '@shared/utils/scheduledWakeup';
const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);
/**
 * @param {{ seq?: number, event: object }[]|null|undefined} events
 */
export function eventsToBlocks(events: any) {
  const blocks = [];
  const list = events || [];
  // Dedup of repeated tool_use ids runs BEFORE the result index so the walk
  // can skip earlier revisions of the same call_id (Cursor emits a follow-up
  // when completed args upgrade an empty/path-only started payload). Result
  // pairing is keyed by id string and is therefore order-independent.
  const latestToolUseById = new Map();
  const lastToolUseIndex = new Map();
  // Wall clock per tool_use id — the anchor that turns ScheduleWakeup's
  // relative `delaySeconds` into an absolute fire time. Recorded off the first
  // revision; a later same-id revision only upgrades args.
  const firstToolUseTimestamp = new Map();
  list.forEach(({ event, timestamp }: any, i: any) => {
    if (event?.type === 'tool_use' && event.id != null && String(event.id)) {
      const id = String(event.id);
      latestToolUseById.set(id, event);
      lastToolUseIndex.set(id, i);
      if (timestamp != null && !firstToolUseTimestamp.has(id)) {
        firstToolUseTimestamp.set(id, timestamp);
      }
    }
  });
  const resultByToolId: Record<string, any> = {};
  for (const { event } of list) {
    if (event?.type === 'tool_result' && event.toolUseId) {
      resultByToolId[event.toolUseId] = event;
    }
  }
  let textBuf: any = null;
  let exploredBuf: any = null;
  let thinkingBuf = '';
  const flushText = () => {
    if (!textBuf) return;
    const rawText = textBuf.final || textBuf.partials;
    let prose = rawText;
    if (prose.includes('agenthub:credential-request')) {
      const { strippedText, requests } = extractCredentialRequestBlocks(prose);
      if (requests.length > 0) {
        for (const request of requests) {
          blocks.push({
            kind: 'credential_request',
            event: { type: 'credential_request', request },
          });
        }
        prose = strippedText;
      }
    }
    const text = stripAssistantControlBlocks(prose);
    if (text && text.trim()) blocks.push({ kind: 'text', text });
    textBuf = null;
  };
  const flushExplored = () => {
    if (!exploredBuf) return;
    if (exploredBuf.items.length === 1) {
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
  // A tool row between a text block's deltas and its final frame flushes the
  // partial buffer, so the same paragraph renders twice. The final wins.
  const lastFinalTextIdx = lastFinalAssistantTextIndex(
    list.map(({ event }: any) => (event && !isSidechainStreamEvent(event) ? event : null)),
  );
  for (let i = 0; i < list.length; i++) {
    const { event } = list[i];
    if (!event) continue;
    // Inner-subagent frames belong to their SubagentCard, not to the tail.
    if (isSidechainStreamEvent(event)) continue;
    if (isSupersededPartialText(event, i, lastFinalTextIdx)) continue;
    const t = event.type;
    if (t === 'assistant_text') {
      flushExplored();
      flushThinking();
      if (!textBuf) textBuf = { partials: '', final: '' };
      if (event.partial) textBuf.partials += event.text || '';
      else textBuf.final += event.text || '';
      continue;
    }
    if (t === 'tool_result') continue;
    if (t === 'thinking') {
      flushExplored();
      flushText();
      thinkingBuf += event.text || '';
      continue;
    }
    if (t === 'progress_step') continue;
    if (t === 'browser_tool_activity') continue;
    if (t === 'checkpoint') continue;
    if (t === 'rate_limit') continue;
    if (shouldSuppressStreamEvent(event)) continue;
    if (t === 'tool_use') {
      const toolId = event.id != null ? String(event.id) : '';
      if (toolId && lastToolUseIndex.get(toolId) !== i) continue;
      const use = toolId ? (latestToolUseById.get(toolId) ?? event) : event;
      const isSubagent = use.tool === 'Task' || use.tool === 'Agent';
      const isExitPlanMode = use.tool === 'ExitPlanMode';
      const isTodoWrite = use.tool === 'TodoWrite';
      const isWakeup = isScheduleWakeupTool(use.tool);
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
      else if (isWakeup) kind = 'wakeup';
      if (isWakeup) {
        blocks.push({
          kind,
          use,
          result,
          scheduledAt: firstToolUseTimestamp.get(toolId) ?? list[i].timestamp ?? null,
        });
        continue;
      }
      blocks.push({ kind, use, result });
      continue;
    }
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
export function truncateOneLine(s: any, max: any) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}
/**
 * Humanized one-line headline for a tool call (Cursor-style) — same rules as web.
 * @returns {{ headline: string, arg: string }}
 */
export function describeTool(tool: any, input: any) {
  const obj = input && typeof input === 'object' ? input : {};
  const baseName = (p: any) => {
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
      const done = todos.filter((x: any) => x?.status === 'completed').length;
      return { headline: `${done} of ${todos.length} Done`, arg: '' };
    }
    case 'ExitPlanMode': {
      const plan = typeof obj.plan === 'string' ? obj.plan : '';
      const first = plan.split('\n').find((l: any) => l.trim()) || '';
      return { headline: first.replace(/^#+\s*/, '') || 'Plan proposal', arg: '' };
    }
    default: {
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && v) return { headline: tool, arg: truncateOneLine(v, 80) };
      }
      return { headline: tool, arg: '' };
    }
  }
}
