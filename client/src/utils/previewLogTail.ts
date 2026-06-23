/** Max boot-log lines retained client-side for session preview pane + WS `preview_log`. */
export const PREVIEW_LOG_TAIL_MAX = 4_000;

export function appendPreviewLogTail(prev: any, line: any) {
  const tail = Array.isArray(prev) ? [...prev, line] : [line];
  if (tail.length <= PREVIEW_LOG_TAIL_MAX) return tail;
  return tail.slice(-PREVIEW_LOG_TAIL_MAX);
}

function capTail(tail: any) {
  return tail.length <= PREVIEW_LOG_TAIL_MAX ? tail : tail.slice(-PREVIEW_LOG_TAIL_MAX);
}

/**
 * If the snapshot `inc` forward-continues the live tail `prev`, return the
 * index in `inc` from which the new (post-overlap) lines begin; otherwise
 * return -1.
 *
 * A candidate "anchor" is any occurrence `m` of `prev`'s last line inside
 * `inc` that has at least one newer line after it (`m < inc.length - 1`).
 * The alignment is valid only if it is consistent over the FULL mutual
 * overlap — walking backwards from the anchor, every `inc[m-t]` must equal
 * `prev[len-1-t]` for as far back as BOTH arrays have data. The new lines to
 * append are then `inc.slice(m + 1)`.
 *
 * Repeated log lines are common, so we evaluate EVERY anchor (not just the
 * last one) and keep scanning past a mismatch — the overlap region may sit
 * in the middle of `inc` when the snapshot carries older history the live
 * tail has already trimmed. Among valid anchors we prefer the deepest
 * consistent overlap (most corroborating context); ties break toward the
 * earliest anchor so we adopt more of the authoritative snapshot rather than
 * leaving the client stuck on an older tail. `prev` is always preserved as
 * the merged prefix, so this only ever APPENDS — it can never rewind or
 * reorder already-streamed lines.
 */
function incomingContinuationIndex(prev: any, inc: any) {
  const last = prev[prev.length - 1];
  let bestIndex = -1;
  let bestDepth = -1;
  for (let m = inc.length - 1; m >= 0; m--) {
    if (inc[m] !== last) continue; // not an anchor
    if (m >= inc.length - 1) continue; // no newer line after this anchor
    const depth = Math.min(m + 1, prev.length); // mutual overlap length
    let consistent = true;
    for (let t = 0; t < depth; t++) {
      if (inc[m - t] !== prev[prev.length - 1 - t]) {
        consistent = false;
        break;
      }
    }
    if (!consistent) continue; // impossible alignment — try an earlier anchor
    // Prefer the deepest overlap; on a tie prefer the earliest anchor
    // (smaller m → smaller index → adopts more of the snapshot).
    if (depth > bestDepth || (depth === bestDepth && m + 1 < bestIndex)) {
      bestDepth = depth;
      bestIndex = m + 1;
    }
  }
  return bestIndex;
}

/**
 * Reconcile a full-tail snapshot (`incoming`, carried by preview_starting /
 * ready / failed events) with the live `preview_log` tail (`previous`).
 *
 * Both are tail windows of the SAME monotonic server-side log stream. We
 * adopt snapshot lines ONLY where the snapshot forward-extends the live tail
 * (see {@link incomingContinuationIndex}) — recovering lines lost to a
 * dropped live frame. Otherwise we keep the live tail unchanged. Length is
 * deliberately NOT used as a freshness signal: once both arrays hit
 * PREVIEW_LOG_TAIL_MAX, length no longer encodes recency, and a stale-but-
 * longer snapshot must never replace newer streamed lines (the
 * "rewind"/looping bug). Content overlap, not length, decides freshness.
 */
export function mergePreviewEventLogTail(incoming: any, previous: any) {
  const inc = Array.isArray(incoming) ? incoming : [];
  const prev = Array.isArray(previous) ? previous : [];
  if (inc.length === 0) return capTail(prev);
  if (prev.length === 0) return capTail(inc);
  const idx = incomingContinuationIndex(prev, inc);
  if (idx >= 0) return capTail(prev.concat(inc.slice(idx)));
  return capTail(prev);
}
