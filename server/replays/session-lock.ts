/**
 * Per-session serialization for segmented replays. Appending a segment, keeping a
 * session (flag + moving its objects), and the retention sweep expiring it all
 * read a session's state and then do awaited storage work based on it. Running
 * two of them interleaved lets one act on a decision the other just invalidated:
 * a Keep can land while the sweeper is deleting bytes, or while an append is
 * uploading to the expiring prefix. Each of those paths runs inside this lock so
 * the other sees a settled state.
 *
 * In-process only. The Hub is a single Node process, which is also what the rest
 * of the segment store assumes.
 */
const tails = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(sessionId, tail);
  try {
    return await run;
  } finally {
    // Drop the entry once nothing has queued behind us, so the map doesn't grow.
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  }
}
