// Pure helpers for the mobile kanban board's per-column keyset pagination.
//
// The mobile board renders one column at a time (the "active" column) and
// paginates only that column via a FlatList `onEndReached`. These functions
// hold the cursor / append / seeding logic so it can be unit-tested without a
// React tree or network. They mirror the web client's KanbanBoard pagination
// (client/src/components/KanbanBoard.jsx) but for a single visible column.
// Default keyset page size. The server clamps `limit` to [1, 200]; 50 matches
// the web client (PAGE_SIZE) and the server default.
export const KANBAN_PAGE_SIZE = 50;
// Dedup-append a freshly fetched page of cards onto the accumulated list.
// Preserves the existing order, appends only cards whose id is not already
// present (a racing reconcile / double-fire can't double-insert), and returns
// the same array reference when there is nothing new so callers can bail on a
// no-op setState.
export function appendCardPage(existing: any, page: any) {
  const list = Array.isArray(existing) ? existing : [];
  const incoming = Array.isArray(page) ? page : [];
  if (incoming.length === 0) return list;
  const seen = new Set(list.map((c: any) => c.id));
  const fresh = incoming.filter((c: any) => c && !seen.has(c.id));
  return fresh.length ? [...list, ...fresh] : list;
}
// Build a per-column paging entry from a cursor + totals. `nextCursor` of null
// (or undefined) means the column is fully loaded (`hasMore: false`).
export function pagingEntry(nextCursor: any, total: any, loaded: any) {
  const cursor = nextCursor ?? null;
  return {
    nextCursor: cursor,
    hasMore: cursor != null,
    loading: false,
    total: total ?? loaded ?? 0,
  };
}
// Seed the per-column paging map from a `GET /board?limit=N` response, which
// carries the first page per column plus `cursors` and `counts` maps.
export function seedPagingFromBoard({ columns, cards, cursors, counts }: any = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const all = Array.isArray(cards) ? cards : [];
  const cur = cursors || {};
  const cnt = counts || {};
  const paging: Record<string, any> = {};
  for (const col of cols) {
    const loaded = all.filter((c: any) => c.column_id === col.id).length;
    paging[col.id] = pagingEntry(cur[col.id] ?? null, cnt[col.id], loaded);
  }
  return paging;
}
// Count loaded cards per column. Drives reconcile depth: after a WS
// `kanban_update` we re-page each column up to its previously loaded count so a
// background refresh never collapses a column the user had scrolled.
export function loadedCountsByColumn(cards: any) {
  const counts: Record<string, any> = {};
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c) continue;
    counts[c.column_id] = (counts[c.column_id] || 0) + 1;
  }
  return counts;
}
// Should an `onEndReached` fire actually fetch the next page for this column?
// Guards against fetching past the end and against a double-fetch while a page
// is already in flight.
export function canLoadMore(entry: any) {
  return !!(entry && entry.hasMore && entry.nextCursor && !entry.loading);
}
