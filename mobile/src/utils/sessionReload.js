/**
 * Factory for the "reload messages for the active session" helper used in
 * AppContext. Encapsulates the stale-response race guard: if the user
 * switches sessions while the fetch is in flight, the incoming response is
 * discarded instead of overwriting the new session's messages.
 *
 * Extracted from AppContext so it can be unit-tested without pulling in
 * React, Expo, or AsyncStorage.
 *
 * @param {object} deps
 * @param {(sessionId: string) => Promise<any[]>} deps.fetchMessages
 *   API call — `api.getMessages` in production, a mock in tests.
 * @param {() => string | null} deps.getActiveSessionId
 *   Reads the latest active session id (typically a ref's `.current`).
 * @param {(messages: any[]) => void} deps.setMessages
 *   React state setter for the messages list.
 * @returns {() => Promise<any[]>} A reload fn — resolves to the applied
 *   array (or `[]` if the session was cleared / the fetch failed / the
 *   response was stale).
 */
export function createReloadMessages({ fetchMessages, getActiveSessionId, setMessages }) {
  return function reloadMessages() {
    const sid = getActiveSessionId();
    if (!sid) {
      setMessages([]);
      return Promise.resolve([]);
    }
    return fetchMessages(sid)
      .then((data) => {
        if (getActiveSessionId() !== sid) return [];
        setMessages(data);
        return data;
      })
      .catch(() => {
        if (getActiveSessionId() !== sid) return [];
        setMessages([]);
        return [];
      });
  };
}
