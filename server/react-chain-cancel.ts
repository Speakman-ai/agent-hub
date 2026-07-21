/**
 * Between-turn cancellation flag for the ReAct / auto-continuation chain.
 *
 * `cancelSessionChatRun` SIGTERMs an *active* CLI process, but a Stop can land
 * in a window where no process is registered in `activeProcesses`:
 *   1. while the chat `close` handler executes host ReAct actions (a slow
 *      browser navigation or web search can hold this window open for seconds),
 *   2. in the `setImmediate` gap after a turn deregisters its process and
 *      before the queued auto-continuation spawns the next turn's process, and
 *   3. during a `planAutoContinuationRetry` `setTimeout` backoff.
 *
 * In all three the SIGTERM path is a no-op, so without this flag the chain runs
 * remaining host actions to completion and spawns a fresh follow-up turn after
 * the user asked it to stop. This module is the persistent per-session
 * "cancel requested" signal the auto-continue gate re-checks between iterations.
 *
 * Lifecycle: `handleCancel`/`cancelSessionChatRun` set it; the close handler
 * checks it before running host actions and before scheduling the next turn;
 * the auto-continuation entry in `handleChat` bails on it; a genuine new user
 * turn clears it.
 *
 * Memory bound: the flag only needs to survive the brief window between a Stop
 * and the next turn (setImmediate / a 500ms retry / an in-flight close handler
 * — sub-second to a few seconds). But a Stop on an idle session with no active
 * process and no follow-up turn would otherwise never be cleared. So entries
 * are timestamped and reaped two ways, keeping the map O(bounded) regardless of
 * how many idle sessions are cancelled over the server's lifetime:
 *   - lazy TTL: a flag older than `ENTRY_TTL_MS` is treated as absent and
 *     deleted on read; writes opportunistically sweep expired entries. The TTL
 *     is far longer than any real cancel→next-turn window, so it never expires
 *     a still-relevant Stop — only truly abandoned ones.
 *   - hard cap: at most `MAX_TRACKED` sessions are retained; the oldest is
 *     evicted first (insertion-ordered Map) as a backstop against bursts.
 */

/** A flag older than this is considered abandoned and reaped. */
export const ENTRY_TTL_MS = 10 * 60 * 1000;
/** Hard ceiling on retained sessions; oldest-first eviction beyond this. */
export const MAX_TRACKED = 2048;

/** sessionId → epoch ms the cancel was requested. Insertion-ordered. */
const cancelledChains = new Map<string, number>();

function sweepExpired(now: number): void {
  for (const [id, ts] of cancelledChains) {
    // Map iterates in insertion order, so the first non-expired entry means
    // every later entry is newer — stop early.
    if (now - ts <= ENTRY_TTL_MS) break;
    cancelledChains.delete(id);
  }
}

/** Mark this session's in-flight ReAct/auto-continuation chain as cancelled. */
export function requestReactChainCancel(sessionId: string): void {
  const now = Date.now();
  sweepExpired(now);
  // Re-insert so the entry moves to the newest (last) position.
  cancelledChains.delete(sessionId);
  cancelledChains.set(sessionId, now);
  // Backstop: evict oldest entries if a burst pushed us over the cap.
  while (cancelledChains.size > MAX_TRACKED) {
    const oldest = cancelledChains.keys().next().value;
    if (oldest === undefined) break;
    cancelledChains.delete(oldest);
  }
}

/** True while a Stop is pending for this session's chain (until cleared/expired). */
export function isReactChainCancelRequested(sessionId: string): boolean {
  const ts = cancelledChains.get(sessionId);
  if (ts === undefined) return false;
  if (Date.now() - ts > ENTRY_TTL_MS) {
    cancelledChains.delete(sessionId);
    return false;
  }
  return true;
}

/** Clear the flag — called when a genuine new user/system turn starts. */
export function clearReactChainCancel(sessionId: string): void {
  cancelledChains.delete(sessionId);
}

/** Test-only: number of currently tracked sessions. */
export function reactChainCancelTrackedCount(): number {
  return cancelledChains.size;
}

/** Test-only: drop all tracked sessions (hermetic test isolation). */
export function __resetReactChainCancelForTests(): void {
  cancelledChains.clear();
}
