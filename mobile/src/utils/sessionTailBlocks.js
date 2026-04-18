/**
 * Mobile twin of the reducer in `client/src/components/SessionTail.jsx`.
 *
 * Walks a session-events array and produces a flat list of display blocks:
 *   text, thinking, tool, subagent, ask_question, checkpoint, rate_limit,
 *   system, result, error.
 *
 * Pairs tool_use with its tool_result by id so orphan results aren't
 * rendered. Coalesces consecutive assistant_text events using the
 * partial-vs-final precedence rule: the final frame replaces any partials.
 *
 * Pure function — kept in utils so it can be unit-tested without a React
 * Native environment.
 */
export function eventsToBlocks(events) {
  if (!events || events.length === 0) return [];

  // First pass: index tool_results by tool_use_id for pairing.
  const resultByToolId = {};
  for (const entry of events) {
    const evt = entry?.event;
    if (evt?.type === 'tool_result' && evt.toolUseId) {
      resultByToolId[evt.toolUseId] = evt;
    }
  }

  const blocks = [];
  let textBuf = null; // { partials, final }

  const flushText = () => {
    if (!textBuf) return;
    const text = textBuf.final || textBuf.partials;
    if (text && text.trim()) blocks.push({ kind: 'text', content: text.trim() });
    textBuf = null;
  };

  for (const e of events) {
    const evt = e?.event;
    if (!evt) continue;
    const t = evt.type;

    if (t === 'assistant_text') {
      if (!textBuf) textBuf = { partials: '', final: '' };
      if (evt.partial) textBuf.partials += evt.text || '';
      else textBuf.final += evt.text || '';
      continue;
    }

    flushText();

    if (t === 'tool_result') continue; // rendered inside paired tool/subagent card
    if (t === 'progress_step') continue; // handled by out-of-tail progress UI

    switch (t) {
      case 'thinking':
        blocks.push({ kind: 'thinking', text: evt.text || '' });
        break;
      case 'tool_use': {
        const isSubagent = evt.tool === 'Task' || evt.tool === 'Agent';
        blocks.push({
          kind: isSubagent ? 'subagent' : 'tool',
          use: evt,
          tool: evt.tool,
          input: evt.input,
          result: resultByToolId[evt.id] || null,
        });
        break;
      }
      case 'result':
        blocks.push({
          kind: 'result',
          durationMs: evt.durationMs,
          costUsd: evt.costUsd,
          numTurns: evt.numTurns,
          isError: evt.isError,
        });
        break;
      case 'checkpoint':
        blocks.push({ kind: 'checkpoint', uuid: evt.uuid, turnIndex: evt.turnIndex });
        break;
      case 'rate_limit':
        blocks.push({ kind: 'rate_limit', retryAfterMs: evt.retryAfterMs, message: evt.message });
        break;
      case 'ask_user_question':
        blocks.push({ kind: 'ask_question', askId: evt.askId, questions: evt.questions || [] });
        break;
      case 'error':
        blocks.push({ kind: 'error', message: evt.message || 'Unknown error' });
        break;
      case 'system':
        blocks.push({ kind: 'system', model: evt.model, cwd: evt.cwd });
        break;
      default:
        break;
    }
  }
  flushText();
  return blocks;
}

/** Summarize a tool's input into a single line for collapsed card headers. */
export function summarizeToolInput(tool, input) {
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 80);
  if (typeof input !== 'object') return '';
  if (tool === 'Bash') return (input.command || input.description || '').slice(0, 80);
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    return input.file_path || input.path || '';
  }
  if (tool === 'Grep' || tool === 'Glob') return input.pattern ? `/${input.pattern}/` : '';
  if (tool === 'WebFetch' || tool === 'WebSearch') return input.url || input.query || '';
  if (tool === 'TodoWrite') {
    const todos = input.todos;
    if (Array.isArray(todos)) return `${todos.length} todo${todos.length === 1 ? '' : 's'}`;
    return '';
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return v.slice(0, 80);
  }
  return '';
}
