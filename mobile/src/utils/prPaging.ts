/**
 * Pure paging state for the mobile PR list (mirrors `kanbanPagination.ts`).
 *
 * The list pages by appending, so three facts travel together: which page we
 * are on, whether the server said another exists, and whether the last attempt
 * failed. Keeping the transitions here (rather than inline in the screen) is
 * what makes the failure rule testable — a dropped request must NOT clear
 * `hasMore`, or the "Load more" footer disappears and the rest of the list
 * becomes unreachable until the user pulls to refresh.
 */

export interface PrPagingState {
  /** 1-based page currently loaded. */
  page: number;
  /** Server's answer to "is there another page?". */
  hasMore: boolean;
  /** Message from the last failed page fetch; null once a fetch succeeds. */
  error: string | null;
}

export const initialPrPaging: PrPagingState = { page: 1, hasMore: false, error: null };

/** Append `rows`, dropping any PR number already on screen (pages can overlap). */
export function appendPrPage<T extends { number?: unknown }>(prev: T[], rows: T[]): T[] {
  const seen = new Set((prev || []).map((row) => row?.number));
  return [...(prev || []), ...(rows || []).filter((row) => !seen.has(row?.number))];
}

/** A page landed: adopt its number, adopt the server's `hasMore`, clear any error. */
export function pagingAfterPage(args: { page: number; hasMore: unknown }): PrPagingState {
  const page = Number.isFinite(args.page) && args.page > 0 ? Math.trunc(args.page) : 1;
  return { page, hasMore: Boolean(args.hasMore), error: null };
}

/**
 * A page fetch failed: record the message and leave `page` / `hasMore` alone.
 * A dropped request says nothing about whether more pages exist, so the footer
 * stays and becomes a retry.
 */
export function pagingAfterFailure(prev: PrPagingState, message: unknown): PrPagingState {
  const text = typeof message === 'string' && message.trim() ? message : 'Failed to load more';
  return { ...prev, error: text };
}

/** Guard for the "Load more" action. */
export function canLoadMore(state: PrPagingState, loading: boolean): boolean {
  return Boolean(state?.hasMore) && !loading;
}

export interface ListRequestGate {
  /** Start a new list generation (whole-list loads only); retires every earlier token. */
  begin(): number;
  /** Read the current generation without starting one (page appends). */
  current(): number;
  /** Is this token still the live generation? */
  isCurrent(token: number): boolean;
}

/**
 * Generation counter for "which list is on screen".
 *
 * Two different fetches write the PR list: the page-1 load (mount, tab switch,
 * project switch, pull-to-refresh) and the append-a-page load. Without a
 * shared gate, a page-2 response that lands *after* the user switched tabs
 * appends "open" PRs onto the "closed" list and stamps the old page number
 * over the new paging state.
 *
 * The asymmetry is deliberate: only a whole-list load calls `begin()`, while a
 * page append merely captures `current()`. So a reload invalidates an
 * in-flight append (the append's rows belong to a list that no longer exists),
 * but an append never invalidates a reload — which would strand the reload's
 * `refreshing` spinner, since the dropped response is the one that would have
 * cleared it.
 */
export function createListRequestGate(): ListRequestGate {
  let generation = 0;
  return {
    begin: () => ++generation,
    current: () => generation,
    isCurrent: (token: number) => token === generation,
  };
}
