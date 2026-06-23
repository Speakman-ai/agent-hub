/**
 * Helpers for lazy-loading `/messages/:id/events` into the mobile chat shell.
 *
 * HTTP failures must **not** call `onEventsLoaded(messageId, [])` (or any
 * value): the parent treats any non-`undefined` `events` as "timeline known",
 * skips refetch, and `[]` used to conflate network errors with "DB had zero
 * rows" — hiding `ask_user_question` pickers while prose had fences stripped.
 */
/**
 * @param {Array<{ seq: number, event: unknown }>|null|undefined} data
 * @returns {Array<{ seq: number, event: unknown }>}
 */
export function mapRowsFromMessageEventsApi(data: any) {
    return (data || []).map((e: any) => ({
        seq: e.seq,
        event: typeof e.event === 'string' ? JSON.parse(e.event) : e.event,
    }));
}
export function notifyParentOfLoadedEvents(onEventsLoaded: any, messageId: any, data: any) {
    const mapped = mapRowsFromMessageEventsApi(data);
    onEventsLoaded?.(messageId, mapped);
}
/**
 * Single choke point for parent notification after `getMessageEvents` settles.
 *
 * @param {object} args
 * @param {boolean} args.cancelled
 * @param {boolean} args.ok — false for HTTP / parse failures (`.catch` path)
 * @param {unknown} args.data — raw API rows (only read when `ok`)
 * @param {string} args.messageId
 * @param {(id: string, rows: ReturnType<typeof mapRowsFromMessageEventsApi>) => void} [args.onEventsLoaded]
 * @returns {{ parentNotified: boolean }}
 */
export function applyLazyMessageEventsResult({ cancelled, ok, data, messageId, onEventsLoaded }: any) {
    if (cancelled)
        return { parentNotified: false };
    if (!ok)
        return { parentNotified: false };
    notifyParentOfLoadedEvents(onEventsLoaded, messageId, data);
    return { parentNotified: true };
}
