/**
 * Mobile twin of the reducer in `client/src/components/SessionTail.jsx`.
 *
 * Walks session-events and produces display blocks with the same kinds and
 * coalescing rules as the web client (explored burst, todos, plan_proposal,
 * checkpoint/rate_limit suppressed, etc.).
 *
 * Pure functions — unit-tested without a React Native environment.
 */

import { stripAssistantControlBlocks } from '../../../shared/utils/stripAssistantControlBlocks.js';

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);

/**
 * @param {{ seq?: number, event: object }[]|null|undefined} events
 */
export function eventsToBlocks(events) {
  const blocks = [];
  const list = events || [];

  const latestToolUseById = new Map();
  const lastToolUseIndex = new Map();
  list.forEach(({ event }, i) => {
    if (event?.type === 'tool_use' && event.id != null && String(event.id)) {
      const id = String(event.id);
      latestToolUseById.set(id, event);
      lastToolUseIndex.set(id, i);
    }
  });

  const resultByToolId = {};
  for (const { event } of list) {
    if (event?.type === 'tool_result' && event.toolUseId) {
      resultByToolId[event.toolUseId] = event;
    }
  }

  let textBuf = null;
  let exploredBuf = null;

  const flushText = () => {
    if (!textBuf) return;
    const rawText = textBuf.final || textBuf.partials;
    const text = stripAssistantControlBlocks(rawText);
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

  const flushAll = () => {
    flushExplored();
    flushText();
  };

  for (let i = 0; i < list.length; i++) {
    const { event } = list[i];
    if (!event) continue;
    const t = event.type;

    if (t === 'assistant_text') {
      flushExplored();
      if (!textBuf) textBuf = { partials: '', final: '' };
      if (event.partial) textBuf.partials += event.text || '';
      else textBuf.final += event.text || '';
      continue;
    }

    if (t === 'tool_result') continue;

    if (t === 'progress_step') continue;
    if (t === 'browser_tool_activity') continue;
    if (t === 'checkpoint') continue;
    if (t === 'rate_limit') continue;

    if (t === 'tool_use') {
      const toolId = event.id != null ? String(event.id) : '';
      if (toolId && lastToolUseIndex.get(toolId) !== i) continue;
      const use = toolId ? (latestToolUseById.get(toolId) ?? event) : event;
      const isSubagent = use.tool === 'Task' || use.tool === 'Agent';
      const isExitPlanMode = use.tool === 'ExitPlanMode';
      const isTodoWrite = use.tool === 'TodoWrite';
      const result = resultByToolId[use.id];
      const isExplore = EXPLORE_TOOLS.has(use.tool) && !result?.isError;
      if (isExplore) {
        flushText();
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

    flushAll();

    if (t === 'system') blocks.push({ kind: 'system', event });
    else if (t === 'thinking') blocks.push({ kind: 'thinking', event });
    else if (t === 'result') blocks.push({ kind: 'result', event });
    else if (t === 'ask_user_question') blocks.push({ kind: 'ask_question', event });
    else if (t === 'error') blocks.push({ kind: 'error', event });
    else blocks.push({ kind: 'unknown', event });
  }
  flushAll();
  return blocks;
}

export function truncateOneLine(s, max) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

/**
 * Humanized one-line headline for a tool call (Cursor-style) — same rules as web.
 * @returns {{ headline: string, arg: string }}
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
      const done = todos.filter((x) => x?.status === 'completed').length;
      return { headline: `${done} of ${todos.length} Done`, arg: '' };
    }
    case 'ExitPlanMode': {
      const plan = typeof obj.plan === 'string' ? obj.plan : '';
      const first = plan.split('\n').find((l) => l.trim()) || '';
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
