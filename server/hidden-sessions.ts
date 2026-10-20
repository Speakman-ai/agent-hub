import { broadcastSessionIdOf } from './session-sidebar.js';

const HIDDEN_CACHE_MAX = 5000;

/**
 * Whether a broadcast is about a hidden session (one the system runs for
 * output posted elsewhere, like a channel digest). Such sessions raise no
 * inbox rows or pushes: the user never sees the session, only its result.
 *
 * A session is marked hidden right after its row is created and before
 * anything broadcasts about it, so lookups are cached both ways.
 */
export function createHiddenSessionCheck(
  lookupHidden: (sessionId: string) => boolean,
): (data: Record<string, unknown>) => boolean {
  const cache = new Map<string, boolean>();
  return (data) => {
    const sid = broadcastSessionIdOf(data);
    if (!sid) return false;
    let hidden = cache.get(sid);
    if (hidden === undefined) {
      try {
        hidden = lookupHidden(sid);
      } catch {
        return false;
      }
      if (cache.size >= HIDDEN_CACHE_MAX) cache.clear();
      cache.set(sid, hidden);
    }
    return hidden;
  };
}
