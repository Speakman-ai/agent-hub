import { describe, it, expect } from 'vitest';
import type { PrPagingState } from './prPaging';
import {
  appendPrPage,
  canLoadMore,
  createListRequestGate,
  initialPrPaging,
  pagingAfterFailure,
  pagingAfterPage,
} from './prPaging';

describe('appendPrPage', () => {
  it('appends the next page after what is already on screen', () => {
    expect(appendPrPage([{ number: 3 }, { number: 2 }], [{ number: 1 }])).toEqual([
      { number: 3 },
      { number: 2 },
      { number: 1 },
    ]);
  });

  it('drops rows already shown (pages overlap when a PR is updated mid-scroll)', () => {
    const rows = appendPrPage([{ number: 3 }, { number: 2 }], [{ number: 2 }, { number: 1 }]);
    expect(rows.map((r) => r.number)).toEqual([3, 2, 1]);
  });

  it('tolerates empty / missing inputs', () => {
    expect(appendPrPage([], [])).toEqual([]);
    expect(appendPrPage(undefined as any, [{ number: 1 }])).toEqual([{ number: 1 }]);
    expect(appendPrPage([{ number: 1 }], undefined as any)).toEqual([{ number: 1 }]);
  });
});

describe('pagingAfterPage', () => {
  it('adopts the page number and the server hasMore, clearing a stale error', () => {
    const recovered = pagingAfterPage({ page: 2, hasMore: true });
    expect(recovered).toEqual({ page: 2, hasMore: true, error: null });
  });

  it('coerces junk page numbers to 1 and non-boolean hasMore', () => {
    expect(pagingAfterPage({ page: 0, hasMore: undefined })).toEqual({
      page: 1,
      hasMore: false,
      error: null,
    });
    expect(pagingAfterPage({ page: Number.NaN, hasMore: 'yes' }).page).toBe(1);
  });
});

describe('pagingAfterFailure', () => {
  it('keeps hasMore so the Load more footer survives a dropped request', () => {
    // The regression: clearing hasMore here hid the footer permanently, and the
    // rest of the list could only be reached by pull-to-refresh or a tab switch.
    const state = { page: 2, hasMore: true, error: null };
    const failed = pagingAfterFailure(state, 'Network request failed');
    expect(failed.hasMore).toBe(true);
    expect(failed.page).toBe(2);
    expect(failed.error).toBe('Network request failed');
  });

  it('falls back to a generic message when the error carries none', () => {
    expect(pagingAfterFailure(initialPrPaging, undefined).error).toBe('Failed to load more');
    expect(pagingAfterFailure(initialPrPaging, '   ').error).toBe('Failed to load more');
  });

  it('a later success clears the error', () => {
    const failed = pagingAfterFailure({ page: 2, hasMore: true, error: null }, 'boom');
    expect(pagingAfterPage({ page: 3, hasMore: false }).error).toBeNull();
    expect(failed.error).toBe('boom');
  });
});

describe('canLoadMore', () => {
  it('is true only when another page exists and nothing is in flight', () => {
    expect(canLoadMore({ page: 1, hasMore: true, error: null }, false)).toBe(true);
    expect(canLoadMore({ page: 1, hasMore: true, error: null }, true)).toBe(false);
    expect(canLoadMore(initialPrPaging, false)).toBe(false);
  });

  it('still allows a retry after a failure', () => {
    expect(canLoadMore({ page: 2, hasMore: true, error: 'boom' }, false)).toBe(true);
  });
});

describe('createListRequestGate', () => {
  it('keeps the newest generation current and retires the older ones', () => {
    const gate = createListRequestGate();
    const first = gate.begin();
    expect(gate.isCurrent(first)).toBe(true);

    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('current() observes the generation without starting one', () => {
    // Page appends must not retire the reload they are running under —
    // otherwise the reload's response is dropped and its spinner never clears.
    const gate = createListRequestGate();
    const reload = gate.begin();
    const append = gate.current();

    expect(append).toBe(reload);
    expect(gate.isCurrent(reload)).toBe(true);
    expect(gate.isCurrent(append)).toBe(true);
  });

  it('an unknown token is never current', () => {
    const gate = createListRequestGate();
    gate.begin();
    expect(gate.isCurrent(999)).toBe(false);
    expect(gate.isCurrent(0)).toBe(false);
  });
});

describe('paging under interleaved requests (the stale-append regression)', () => {
  /**
   * Replays what the screen does, with the page-2 response landing AFTER the
   * user switched state tabs. Before the shared gate, that response appended
   * "open" rows onto the freshly loaded "closed" list and stamped the old
   * page number over the new paging state.
   */
  it('drops a page whose response lands after the list was reloaded', () => {
    const gate = createListRequestGate();
    let pulls: Array<{ number: number }> = [{ number: 9 }, { number: 8 }];
    let paging: PrPagingState = { page: 1, hasMore: true, error: null };

    gate.begin(); // the open list is the current generation
    // User taps "Load more" on the open list...
    const loadMoreToken = gate.current();
    // ...then switches to the Closed tab, which reloads page 1.
    const reloadToken = gate.begin();

    // The closed page-1 response arrives first and replaces the list.
    if (gate.isCurrent(reloadToken)) {
      pulls = [{ number: 4 }];
      paging = pagingAfterPage({ page: 1, hasMore: false });
    }

    // The superseded page-2 response arrives late.
    if (gate.isCurrent(loadMoreToken)) {
      pulls = appendPrPage(pulls, [{ number: 7 }, { number: 6 }]);
      paging = pagingAfterPage({ page: 2, hasMore: true });
    }

    expect(pulls.map((p) => p.number)).toEqual([4]);
    expect(paging).toEqual({ page: 1, hasMore: false, error: null });
  });

  it('applies a page that is still the newest request', () => {
    const gate = createListRequestGate();
    let pulls: Array<{ number: number }> = [{ number: 9 }];
    let paging: PrPagingState = { page: 1, hasMore: true, error: null };

    gate.begin();
    const token = gate.current();
    if (gate.isCurrent(token)) {
      pulls = appendPrPage(pulls, [{ number: 8 }]);
      paging = pagingAfterPage({ page: 2, hasMore: false });
    }

    expect(pulls.map((p) => p.number)).toEqual([9, 8]);
    expect(paging).toEqual({ page: 2, hasMore: false, error: null });
  });

  it('does not record an error from a superseded page fetch', () => {
    const gate = createListRequestGate();
    gate.begin();
    const staleToken = gate.current();
    gate.begin();

    let paging: PrPagingState = { page: 1, hasMore: true, error: null };
    if (gate.isCurrent(staleToken)) paging = pagingAfterFailure(paging, 'Network request failed');

    expect(paging.error).toBeNull();
  });
});
