/**
 * Decide whether SessionTail should eagerly fetch session events on mount.
 *
 * On web, `client/src/components/SessionTail.jsx` lazy-loads events as soon as
 * the component mounts for historical (non-streaming) messages — this is what
 * makes the `agenthub:ask` picker appear for past turns without requiring the
 * user to tap anything.
 *
 * Mobile historically only loaded on expand, which meant:
 *   - Live `ask_user_question` events were still written to `eventsByMessage`
 *     via the `session-event` WebSocket, but the surfacing SessionTail wasn't
 *     rendered for the streaming message id (only for messages already in
 *     `messages`).
 *   - For historical sessions, events were never loaded until the user tapped
 *     the summary bar — but the summary bar wasn't rendered in the first place
 *     when `!hasMeta && !events && askBlocks.length === 0`.
 *
 * Returning true from this function means SessionTail should dispatch a
 * one-shot `api.getMessageEvents(messageId)` call immediately to backfill the
 * events so the picker (and rest of the timeline) can render.
 *
 * @param {object} args
 * @param {string|null|undefined} args.messageId  — target assistant message id
 * @param {boolean|undefined} args.streaming      — true while the CLI is live
 * @param {Array|undefined} args.events           — already-loaded events; a
 *                                                  defined empty array means
 *                                                  "loaded successfully, DB had
 *                                                  no rows" (never used for HTTP errors)
 * @returns {boolean}
 */
export function shouldAutoLoadEvents({ messageId, streaming, events }: any) {
  if (!messageId) return false;
  if (streaming) return false; // live ws will fill this in
  if (events !== undefined) return false; // already loaded (possibly empty)
  return true;
}
