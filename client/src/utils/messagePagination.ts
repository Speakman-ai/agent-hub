/**
 * Pure helpers for the chat reverse-infinite-scroll loader in App.jsx.
 *
 * The complex parts of "load older messages on scroll-up" are extracted here
 * so they can be unit-tested without a DOM: when to trigger a fetch, how to
 * infer there are more older pages, how to prepend a page without duplicating
 * messages already loaded, and how to keep the viewport anchored after the
 * prepend grows the scroll container.
 */

/** Messages fetched per page (initial load + each older page). */
export const MESSAGES_PAGE_SIZE = 40;

/** Load older messages once the user scrolls within this many px of the top. */
export const LOAD_OLDER_THRESHOLD_PX = 250;

/**
 * Whether a scroll position should trigger loading the next older page.
 * True only when near the top, more history exists, and no fetch is in flight.
 */
export function shouldLoadOlder({
  scrollTop,
  hasMore,
  loading,
  threshold = LOAD_OLDER_THRESHOLD_PX,
}: any) {
  if (loading || !hasMore) return false;
  return scrollTop <= threshold;
}

/**
 * A full page implies older messages still exist above the loaded window; a
 * short page means we've reached the start of the transcript.
 */
export function inferHasMore(pageLength: any, pageSize: any = MESSAGES_PAGE_SIZE) {
  return pageLength >= pageSize;
}

/**
 * Prepend an older page to the loaded messages, dropping any ids already
 * present (the keyset boundary can overlap, and live WS appends/dedup must not
 * be undone). Returns the next array plus how many genuinely-new rows were
 * added — `addedCount === 0` means there's nothing to render or anchor.
 */
export function prependOlderMessages(prev: any, older: any) {
  const have = new Set(prev.map((m: any) => m.id));
  const fresh = (Array.isArray(older) ? older : []).filter((m: any) => m && !have.has(m.id));
  if (fresh.length === 0) return { messages: prev, addedCount: 0 };
  return { messages: [...fresh, ...prev], addedCount: fresh.length };
}

/**
 * The scrollTop that keeps the viewport anchored on the same content after a
 * prepend grows the container: shift down by exactly the height added above.
 */
export function restoredScrollTop({ prevScrollTop, prevScrollHeight, newScrollHeight }: any) {
  return prevScrollTop + (newScrollHeight - prevScrollHeight);
}
