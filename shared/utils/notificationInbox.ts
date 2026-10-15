/** One row of the caller's bell inbox, as `/api/notifications` returns it. */
export interface InboxNotification {
  id: string;
  userId: string;
  orgId: string | null;
  projectId: string | null;
  category: string;
  title: string;
  body: string;
  route: string | null;
  data: Record<string, unknown> | null;
  sourceKey: string;
  createdAt: string;
  readAt: string | null;
}

/**
 * Bell inbox state as a set of facts that the rows and badge are derived
 * from on every render.
 *
 * Rows. A row only ever goes from unread to read, so every read we learn
 * about is kept as its own fact and folded in at render time. The result
 * does not depend on the order page responses, WS events and our own
 * writes land in. An older page can't undo a read or drop a live row, and
 * a write overlays every page however late it loads. Rolling back a
 * failed write means removing it.
 *
 * Count. The badge is `serverCount` minus our writes that count doesn't
 * reflect yet. A write is marked `reflected` only when we can prove the
 * applied count includes it:
 *  - a WS `notification_read` covering its row (the server emits it after
 *    committing, and later WS counts are ordered after it), or
 *  - a count GET issued after the write settled, with no newer count
 *    applied before it resolved.
 * Counts in write responses are never used. Their arrival order says
 * nothing about server order, so concurrent writes could leave an older
 * count on screen.
 */
export interface LocalWrite {
  /** Unique per write. Also the optimistic `readAt` it stamps (never parsed as a time). */
  token: string;
  kind: 'read' | 'read_all';
  /** Row id and creation time for `read`. */
  id?: string;
  createdAt?: string;
  /**
   * `read_all` only: rows created at or before this are covered. Always a
   * server-clock time, never the browser's: while pending, the newest
   * `createdAt` the bell had loaded when the user clicked; once the server
   * answers, the `readAt` it stamped. Null covers nothing.
   */
  cutoff?: string | null;
  status: 'pending' | 'done';
  reflected: boolean;
}

export interface InboxFacts {
  /** Rows from page fetches, newest first. */
  pageRows: InboxNotification[];
  /** Rows from `notification_created` events not yet covered by a page. */
  liveRows: InboxNotification[];
  /** Reads reported by the server: row id -> readAt. */
  serverReads: Record<string, string>;
  /** `readAt` of every server mark-all-read. Covers rows created at or before it. */
  serverReadAll: string[];
  writes: LocalWrite[];
  serverCount: number;
  /** Bumped whenever a server count is applied. */
  countSeq: number;
  /** Bumped whenever a write starts. */
  writeSeq: number;
}

export const EMPTY_INBOX: InboxFacts = {
  pageRows: [],
  liveRows: [],
  serverReads: {},
  serverReadAll: [],
  writes: [],
  serverCount: 0,
  countSeq: 0,
  writeSeq: 0,
};

function createdBy(createdAt: string | undefined, cutoff: string): boolean {
  const t = Date.parse(createdAt ?? '');
  const c = Date.parse(cutoff);
  return !Number.isNaN(t) && !Number.isNaN(c) && t <= c;
}

function readAtFor(n: InboxNotification, f: InboxFacts): string | null {
  if (n.readAt) return n.readAt;
  if (f.serverReads[n.id]) return f.serverReads[n.id];
  const all = f.serverReadAll.find((cutoff) => createdBy(n.createdAt, cutoff));
  if (all) return all;
  const w = f.writes.find((x) =>
    x.kind === 'read' ? x.id === n.id : !!x.cutoff && createdBy(n.createdAt, x.cutoff),
  );
  return w ? w.token : null;
}

/** The rows to render: pages plus live rows, newest first, with every known read applied. */
export function deriveInboxRows(f: InboxFacts): InboxNotification[] {
  const seen = new Set<string>();
  const merged: InboxNotification[] = [];
  for (const n of [...f.liveRows, ...f.pageRows]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    merged.push(n);
  }
  merged.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return merged.map((n) => {
    const readAt = readAtFor(n, f);
    return readAt === n.readAt ? n : { ...n, readAt };
  });
}

/** Badge count for `rows = deriveInboxRows(f)`. */
export function deriveUnreadCount(f: InboxFacts, rows: InboxNotification[]): number {
  const unreflected = f.writes.filter((w) => !w.reflected);
  // Everything up to an unreflected mark-all is read; only loaded rows newer than it remain.
  if (unreflected.some((w) => w.kind === 'read_all')) return rows.filter((n) => !n.readAt).length;
  return Math.max(0, f.serverCount - unreflected.length);
}

export function withCount(f: InboxFacts, count: number | undefined): InboxFacts {
  return typeof count === 'number' ? { ...f, serverCount: count, countSeq: f.countSeq + 1 } : f;
}

/** A fresh first page replaces the paged rows; live rows it now covers are dropped. */
/**
 * Every server copy of a row that says it is read is a read fact. Recording
 * it here means the read survives whichever copy of the row is kept, and a
 * later copy saying unread (an older snapshot, a live event) can't undo it.
 */
function withRowReads(f: InboxFacts, items: InboxNotification[]): InboxFacts {
  const fresh = items.filter((n) => n.readAt && !f.serverReads[n.id]);
  if (fresh.length === 0) return f;
  const serverReads = { ...f.serverReads };
  for (const n of fresh) serverReads[n.id] = n.readAt!;
  return { ...f, serverReads };
}

/** Live rows a page now covers are dropped, so each row lives in one place. */
function withoutLiveCopies(f: InboxFacts, items: InboxNotification[]): InboxFacts {
  const ids = new Set(items.map((n) => n.id));
  return { ...f, liveRows: f.liveRows.filter((n) => !ids.has(n.id)) };
}

/** A fresh first page replaces the paged rows. */
export function withFirstPage(f: InboxFacts, items: InboxNotification[]): InboxFacts {
  return withRowReads(withoutLiveCopies({ ...f, pageRows: items }, items), items);
}

export function withNextPage(f: InboxFacts, items: InboxNotification[]): InboxFacts {
  const ids = new Set(f.pageRows.map((n) => n.id));
  const next = { ...f, pageRows: [...f.pageRows, ...items.filter((n) => !ids.has(n.id))] };
  return withRowReads(withoutLiveCopies(next, items), items);
}

export function withLiveRow(f: InboxFacts, n: InboxNotification, count?: number): InboxFacts {
  const known = f.liveRows.some((x) => x.id === n.id) || f.pageRows.some((x) => x.id === n.id);
  return withCount(withRowReads(known ? f : { ...f, liveRows: [n, ...f.liveRows] }, [n]), count);
}

export function withServerRead(
  f: InboxFacts,
  ids: string[],
  readAt: string,
  count?: number,
): InboxFacts {
  const serverReads = { ...f.serverReads };
  for (const id of ids) serverReads[id] ??= readAt;
  const idSet = new Set(ids);
  const writes = f.writes.map((w) =>
    w.kind === 'read' && w.id && idSet.has(w.id) ? { ...w, reflected: true } : w,
  );
  return withCount({ ...f, serverReads, writes }, count);
}

/**
 * A server mark-all (possibly from another tab, possibly older than our
 * writes). It reflects only our single-row writes on rows it covers. Our own
 * mark-all can't be matched to it, so that one waits for a later count GET.
 */
export function withServerReadAll(f: InboxFacts, readAt: string, count?: number): InboxFacts {
  const writes = f.writes.map((w) =>
    w.kind === 'read' && createdBy(w.createdAt, readAt) ? { ...w, reflected: true } : w,
  );
  return withCount({ ...f, serverReadAll: [...f.serverReadAll, readAt], writes }, count);
}

export function withWrite(f: InboxFacts, w: Omit<LocalWrite, 'status' | 'reflected'>): InboxFacts {
  return {
    ...f,
    writeSeq: f.writeSeq + 1,
    writes: [...f.writes, { ...w, status: 'pending', reflected: false }],
  };
}

/**
 * The write succeeded. Its overlay stays, since it is now true. A mark-all
 * takes the server's stamped `readAt` as its cutoff when the response has one.
 */
export function withWriteDone(f: InboxFacts, token: string, serverReadAt?: string): InboxFacts {
  return {
    ...f,
    writes: f.writes.map((w) =>
      w.token === token
        ? {
            ...w,
            status: 'done' as const,
            ...(w.kind === 'read_all' && serverReadAt ? { cutoff: serverReadAt } : {}),
          }
        : w,
    ),
  };
}

/** Newest server `createdAt` among loaded rows: a pending mark-all's cutoff. */
export function newestCreatedAt(rows: InboxNotification[]): string | null {
  let best: string | null = null;
  for (const n of rows) {
    if (Number.isNaN(Date.parse(n.createdAt))) continue;
    if (!best || Date.parse(n.createdAt) > Date.parse(best)) best = n.createdAt;
  }
  return best;
}

/** The write failed. Dropping it un-reads exactly the rows only it had marked. */
export function withWriteFailed(f: InboxFacts, token: string): InboxFacts {
  return { ...f, writes: f.writes.filter((w) => w.token !== token) };
}

export function pendingWriteCount(f: InboxFacts): number {
  return f.writes.filter((w) => w.status === 'pending').length;
}

/** A settled write the count doesn't reflect yet: a count GET would fix the badge. */
export function needsCountRefresh(f: InboxFacts): boolean {
  return f.writes.some((w) => w.status === 'done' && !w.reflected);
}

/** What a count GET must remember when it is issued. */
export interface CountRequest {
  countSeq: number;
  writeSeq: number;
  /** Settled writes the server has already applied when the GET goes out. */
  settledTokens: string[];
}

export function beginCountRequest(f: InboxFacts): CountRequest {
  return {
    countSeq: f.countSeq,
    writeSeq: f.writeSeq,
    settledTokens: f.writes.filter((w) => w.status === 'done').map((w) => w.token),
  };
}

/**
 * True when a write started while the GET was in flight. The server may have
 * applied that write before or after reading the count, so the response
 * can't be used: subtracting the write could count it twice, and not
 * subtracting it could miss it. Ask again once writes settle.
 */
export function countRequestOverlapsWrite(f: InboxFacts, req: CountRequest): boolean {
  return f.writeSeq !== req.writeSeq;
}

/**
 * Apply a count GET. Returns null when the response is ambiguous: a newer
 * count was applied while it was in flight (it may be older than what is on
 * screen), or a write started meanwhile (see `countRequestOverlapsWrite`).
 */
export function withCountResponse(
  f: InboxFacts,
  req: CountRequest,
  count: number,
): InboxFacts | null {
  if (f.countSeq !== req.countSeq || countRequestOverlapsWrite(f, req)) return null;
  const settled = new Set(req.settledTokens);
  const writes = f.writes.map((w) => (settled.has(w.token) ? { ...w, reflected: true } : w));
  return withCount({ ...f, writes }, count);
}
