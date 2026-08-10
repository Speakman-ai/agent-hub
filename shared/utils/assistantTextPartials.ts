/**
 * Claude Code emits the same assistant text twice: once as a run of
 * `assistant_text {partial: true}` token deltas, and again as a single
 * `assistant_text {partial: false}` frame carrying the whole block when the
 * message stops. Tool calls resolve in between, so the deltas and their final
 * are separated by `tool_use` / `tool_result` rows.
 *
 * The tail reducers keep one text buffer and let the final win over the
 * partials, but any tool row flushes that buffer first: the partial fragment
 * gets emitted as its own block, then the final arrives and is emitted again.
 * The user sees the same paragraph two or three times, once truncated.
 *
 * A final always supersedes every partial that preceded it, so partials before
 * the last final are dropped. Partials *after* it are still in flight: that is
 * the live streaming bubble, and it must keep rendering.
 */
export interface PartialTextEventLike {
  type?: string;
  partial?: boolean;
}

/**
 * Index of the last finalized `assistant_text`, or -1 when none has arrived.
 * Pass `null` for events that should not count (e.g. subagent sidechain
 * frames), keeping indices aligned with the caller's list.
 */
export function lastFinalAssistantTextIndex(
  events: Array<PartialTextEventLike | null | undefined>,
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && event.type === 'assistant_text' && !event.partial) return i;
  }
  return -1;
}

/** True when this partial delta is already covered by a later final frame. */
export function isSupersededPartialText(
  event: PartialTextEventLike | null | undefined,
  index: number,
  lastFinalIndex: number,
): boolean {
  if (!event || event.type !== 'assistant_text' || !event.partial) return false;
  return index < lastFinalIndex;
}
