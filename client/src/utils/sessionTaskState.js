/** @typedef {{ goal: string, checklist: Array<{ text: string, done: boolean }>, lastFailure: string }} SessionTaskStateForm */

/**
 * @param {Record<string, unknown>|null|undefined} session
 * @returns {SessionTaskStateForm}
 */
export function parseTaskStateFromSession(session) {
  const raw = session?.task_state_json;
  if (!raw || !String(raw).trim()) {
    return { goal: '', checklist: [], lastFailure: '' };
  }
  try {
    const o = JSON.parse(String(raw));
    const goal = typeof o.goal === 'string' ? o.goal : '';
    const lastFailure =
      o.lastFailure === null || o.lastFailure === undefined
        ? ''
        : typeof o.lastFailure === 'string'
          ? o.lastFailure
          : '';
    const checklist = Array.isArray(o.checklist)
      ? o.checklist.map((row) => {
          if (typeof row === 'string') return { text: row, done: false };
          const text = row && typeof row.text === 'string' ? row.text : '';
          const done = !!(row && row.done);
          return { text, done };
        })
      : [];
    return { goal, checklist, lastFailure };
  } catch {
    return { goal: '', checklist: [], lastFailure: '' };
  }
}

/**
 * @param {SessionTaskStateForm} state
 * @returns {boolean}
 */
export function taskStateFormHasContent(state) {
  return !!(
    state.goal?.trim() ||
    state.lastFailure?.trim() ||
    (state.checklist && state.checklist.some((c) => c.text?.trim()))
  );
}
