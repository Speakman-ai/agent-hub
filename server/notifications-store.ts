/**
 * Per-user notification inbox store (spec STORAGE). All reads and writes of
 * the `notifications` table (orgs.db, see `notifications-schema.ts`) go
 * through here: the fan-out step inserts, the bell REST surface lists and
 * marks read, and the daily retention job prunes.
 *
 * Paging is keyset on (created_at DESC, id DESC). Offset paging would skip or
 * repeat rows while new notifications arrive between "load more" clicks.
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';

/** Read rows older than this are pruned. */
export const READ_RETENTION_DAYS = 30;
/** Unread rows older than this are pruned. */
export const UNREAD_RETENTION_DAYS = 90;
/** Daily, off the hour, so it doesn't stack with the other top-of-hour jobs. */
export const NOTIFICATIONS_PRUNE_CRON = '17 4 * * *';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Notification {
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

interface NotificationRow {
  id: string;
  user_id: string;
  org_id: string | null;
  project_id: string | null;
  category: string;
  title: string;
  body: string;
  route: string | null;
  data: string | null;
  source_key: string;
  created_at: string;
  read_at: string | null;
}

export interface InsertNotificationInput {
  userId: string;
  orgId?: string | null;
  projectId?: string | null;
  category: string;
  title: string;
  body?: string;
  route?: string | null;
  data?: Record<string, unknown> | null;
  /** Identifies the source event. Omitted means the row never dedupes. */
  sourceKey?: string | null;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface InsertNotificationResult {
  notification: Notification;
  /** False when a row with the same (userId, sourceKey) already existed. */
  created: boolean;
}

export interface ListNotificationsOptions {
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string | null;
  unreadOnly?: boolean;
}

export interface NotificationPage {
  items: Notification[];
  /** Opaque cursor for the next page, or null when this was the last page. */
  nextCursor: string | null;
}

function parseData(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rowToNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    projectId: row.project_id,
    category: row.category,
    title: row.title,
    body: row.body,
    route: row.route,
    data: parseData(row.data),
    sourceKey: row.source_key,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function encodeCursor(row: Pick<NotificationRow, 'created_at' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

/**
 * Insert a notification. Idempotent on (userId, sourceKey): a second insert
 * with the same key leaves the existing row (including its read state)
 * untouched and returns it with `created: false`.
 */
export function insertNotification(input: InsertNotificationInput): InsertNotificationResult {
  const db = getOrgsDb();
  const id = uuidv4();
  const sourceKey = input.sourceKey?.trim() || id;
  const createdAt = (input.now ?? new Date()).toISOString();
  const info = db
    .prepare(
      `INSERT INTO notifications
         (id, user_id, org_id, project_id, category, title, body, route, data, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, source_key) DO NOTHING`,
    )
    .run(
      id,
      input.userId,
      input.orgId ?? null,
      input.projectId ?? null,
      input.category,
      input.title,
      input.body ?? '',
      input.route ?? null,
      input.data ? JSON.stringify(input.data) : null,
      sourceKey,
      createdAt,
    );
  const row = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? AND source_key = ?')
    .get(input.userId, sourceKey) as NotificationRow;
  return { notification: rowToNotification(row), created: info.changes > 0 };
}

export function getNotification(userId: string, id: string): Notification | null {
  const row = getOrgsDb()
    .prepare('SELECT * FROM notifications WHERE user_id = ? AND id = ?')
    .get(userId, id) as NotificationRow | undefined;
  return row ? rowToNotification(row) : null;
}

/** Newest first. An unparseable cursor is treated as "start from the top". */
export function listNotifications(
  userId: string,
  opts: ListNotificationsOptions = {},
): NotificationPage {
  const limit = clampLimit(opts.limit);
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (opts.unreadOnly) where.push('read_at IS NULL');
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  // Fetch one extra row to learn whether another page exists.
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM notifications WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as NotificationRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(rowToNotification),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

export function countUnreadNotifications(userId: string): number {
  const row = getOrgsDb()
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { n: number };
  return row.n;
}

/** Returns true when an unread row owned by `userId` was flipped to read. */
export function markNotificationRead(userId: string, id: string, now: Date = new Date()): boolean {
  const info = getOrgsDb()
    .prepare(
      'UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL',
    )
    .run(now.toISOString(), userId, id);
  return info.changes > 0;
}

/**
 * Mark read by source key, for surfaces that know the event but not the inbox
 * row id (e.g. reading a DM in Chat clears the matching bell entry).
 */
export function markNotificationReadBySourceKey(
  userId: string,
  sourceKey: string,
  now: Date = new Date(),
): boolean {
  const info = getOrgsDb()
    .prepare(
      'UPDATE notifications SET read_at = ? WHERE user_id = ? AND source_key = ? AND read_at IS NULL',
    )
    .run(now.toISOString(), userId, sourceKey);
  return info.changes > 0;
}

/** Returns the number of rows flipped to read. */
export function markAllNotificationsRead(userId: string, now: Date = new Date()): number {
  const info = getOrgsDb()
    .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .run(now.toISOString(), userId);
  return info.changes;
}

export interface PruneNotificationsResult {
  read: number;
  unread: number;
}

/**
 * Retention: drop read rows older than READ_RETENTION_DAYS and unread rows
 * older than UNREAD_RETENTION_DAYS, both measured from `created_at`.
 */
export function pruneNotifications(now: Date = new Date()): PruneNotificationsResult {
  const db = getOrgsDb();
  const readCutoff = new Date(now.getTime() - READ_RETENTION_DAYS * DAY_MS).toISOString();
  const unreadCutoff = new Date(now.getTime() - UNREAD_RETENTION_DAYS * DAY_MS).toISOString();
  return db.transaction(() => {
    const read = db
      .prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?')
      .run(readCutoff).changes;
    const unread = db
      .prepare('DELETE FROM notifications WHERE read_at IS NULL AND created_at < ?')
      .run(unreadCutoff).changes;
    return { read, unread };
  })();
}

/** Cron entry point: never throws, logs only when something was removed. */
export function runNotificationsPrune(now: Date = new Date()): PruneNotificationsResult | null {
  try {
    const result = pruneNotifications(now);
    if (result.read + result.unread > 0) {
      console.log(
        `[notifications-prune] removed ${result.read} read, ${result.unread} unread notification(s)`,
      );
    }
    return result;
  } catch (err) {
    console.warn('[notifications-prune] failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
