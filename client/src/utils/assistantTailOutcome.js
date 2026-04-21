/**
 * Derive high-level assistant-turn outcome for chat bubble chrome (working /
 * done / error). Used by SessionTail so Cursor Agent sessions match Claude Code
 * affordances when the timeline is event-backed or legacy text-only.
 *
 * @param {object} opts
 * @param {boolean} opts.streaming — live turn still in flight
 * @param {Array<{ seq?: number, event?: object }>} [opts.events] — session events (may be empty)
 * @param {string} [opts.messageContent] — persisted assistant markdown / error text
 * @returns {{ phase: 'working'|'done'|'error', detail?: string } | null}
 */
export function deriveAssistantTailOutcome({ streaming, events, messageContent }) {
  if (streaming) {
    return { phase: 'working' };
  }

  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]?.event;
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'result') {
      if (ev.isError === true) {
        const detail =
          typeof ev.text === 'string' && ev.text.trim()
            ? ev.text.trim()
            : 'The agent run reported an error.';
        return { phase: 'error', detail };
      }
      return { phase: 'done' };
    }
    if (ev.type === 'error' && typeof ev.message === 'string' && ev.message.trim()) {
      return { phase: 'error', detail: ev.message.trim() };
    }
  }

  if (typeof messageContent === 'string' && messageContent.trimStart().startsWith('Error:')) {
    return { phase: 'error', detail: messageContent.replace(/^\s*Error:\s*/i, '').trim() };
  }

  return { phase: 'done' };
}
