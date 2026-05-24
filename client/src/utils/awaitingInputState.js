/**
 * Pure reducer helpers for the client-side `awaitingInputBySession` map.
 *
 * Extracted from `App.jsx` so the WebSocket-event handling has unit coverage
 * outside the App's giant useReducer-by-hand. The map's shape is
 *
 *   { [sessionId: string]: { askIds: string[], agentId, sessionName } }
 *
 * and every reducer returns the **same object reference** when the call would
 * be a no-op. App.jsx relies on that referential equality to short-circuit
 * effect-dependency comparisons.
 */

/**
 * Apply a snapshot of awaiting-input rows received on WebSocket connect.
 * Replaces the entire map (snapshot is authoritative).
 *
 * @param {Array<{ sessionId: string, askIds?: string[], agentId?: string|null, sessionName?: string|null }>|null|undefined} items
 * @returns {Record<string, { askIds: string[], agentId: string|null, sessionName: string|null }>}
 */
export function applyAwaitingInputSnapshot(items) {
  const next = {};
  if (!Array.isArray(items)) return next;
  for (const item of items) {
    if (!item || typeof item.sessionId !== 'string') continue;
    next[item.sessionId] = {
      askIds: Array.isArray(item.askIds) ? item.askIds : [],
      agentId: item.agentId ?? null,
      sessionName: item.sessionName ?? null,
    };
  }
  return next;
}

/**
 * Apply a single live `awaiting_input` event. Returns the next map or the
 * same reference if no change was needed.
 *
 * @param {Record<string, { askIds: string[], agentId: string|null, sessionName: string|null }>} prev
 * @param {{ sessionId?: string|null, waiting?: boolean, askIds?: string[]|null, agentId?: string|null, sessionName?: string|null }} event
 */
export function applyAwaitingInputEvent(prev, event) {
  const sid = event && typeof event.sessionId === 'string' ? event.sessionId : null;
  if (!sid) return prev;

  if (event.waiting) {
    const askIds = Array.isArray(event.askIds) ? event.askIds : [];
    const existing = prev[sid];
    if (
      existing &&
      existing.agentId === (event.agentId ?? null) &&
      existing.sessionName === (event.sessionName ?? null) &&
      existing.askIds.length === askIds.length &&
      existing.askIds.every((id, i) => id === askIds[i])
    ) {
      return prev;
    }
    return {
      ...prev,
      [sid]: {
        askIds,
        agentId: event.agentId ?? null,
        sessionName: event.sessionName ?? null,
      },
    };
  }

  if (!prev[sid]) return prev;
  const next = { ...prev };
  delete next[sid];
  return next;
}

/**
 * Drop an entry by sessionId (covers `interrupted`, `session_deleted`, and
 * the optimistic clear when the user submits a picker answer). Returns the
 * same reference if the id was absent.
 *
 * @param {Record<string, { askIds: string[], agentId: string|null, sessionName: string|null }>} prev
 * @param {string|null|undefined} sessionId
 */
export function clearAwaitingInputForSession(prev, sessionId) {
  if (!sessionId || !prev[sessionId]) return prev;
  const next = { ...prev };
  delete next[sessionId];
  return next;
}

/**
 * Decide whether a freshly-received `awaiting_input { waiting: true }` event
 * should trigger a desktop notification. Suppressed when:
 *   - the session was already in the waiting state (reconnect / replay)
 *   - the session is the one the user is currently viewing
 *
 * @param {{ wasWaiting: boolean, sessionId: string|null|undefined, activeSessionId: string|null|undefined }} args
 */
export function shouldNotifyForAwaitingInput({ wasWaiting, sessionId, activeSessionId }) {
  if (wasWaiting) return false;
  if (!sessionId) return false;
  if (sessionId === activeSessionId) return false;
  return true;
}
