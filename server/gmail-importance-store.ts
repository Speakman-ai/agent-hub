/**
 * Persistence for the Gmail importance scan (schema in
 * `gmail-importance-schema.ts`). Every read and write is scoped to one linked
 * Google account of one user (`GmailImportanceKey`).
 *
 * Writes only land while the account is still linked, so a scan that finishes
 * after its account was removed can't bring its rows back.
 */
import { getOrgsDb } from './orgs.js';

export const GMAIL_IMPORTANCE_WINDOWS = [1, 7, 30] as const;
export type GmailImportanceWindowDays = (typeof GMAIL_IMPORTANCE_WINDOWS)[number];

export const GMAIL_IMPORTANCE_AUTO_SCAN = ['off', 'hourly', 'every6h', 'daily'] as const;
export type GmailImportanceAutoScan = (typeof GMAIL_IMPORTANCE_AUTO_SCAN)[number];

/** Minimum gap between automated scans for each cadence. */
export const AUTO_SCAN_INTERVAL_MS: Record<Exclude<GmailImportanceAutoScan, 'off'>, number> = {
  hourly: 60 * 60_000,
  every6h: 6 * 60 * 60_000,
  daily: 24 * 60 * 60_000,
};

export type GmailImportanceScanStatus = 'idle' | 'running' | 'ok' | 'error';

export interface GmailImportanceSettings {
  enabled: boolean;
  windowDays: GmailImportanceWindowDays;
  autoScan: GmailImportanceAutoScan;
  lastScanAt: string | null;
  lastScanStatus: GmailImportanceScanStatus;
  lastScanError: string | null;
  lastScanEngine: string | null;
  lastScanModel: string | null;
  /** One-line note when the last scan had to switch engines. */
  lastScanFailover: string | null;
}

export interface GmailImportanceThread {
  threadId: string;
  historyId: string | null;
  important: boolean;
  score: number;
  reason: string | null;
  subject: string | null;
  from: string | null;
  snippet: string | null;
  lastMessageAt: string | null;
  scannedAt: string;
}

interface SettingsRow {
  enabled: number;
  window_days: number;
  auto_scan: string;
  last_scan_at: string | null;
  last_scan_status: string;
  last_scan_error: string | null;
  last_scan_engine: string | null;
  last_scan_model: string | null;
  last_scan_failover: string | null;
}

interface ThreadRow {
  thread_id: string;
  history_id: string | null;
  important: number;
  score: number;
  reason: string | null;
  subject: string | null;
  from_addr: string | null;
  snippet: string | null;
  last_message_at: string | null;
  scanned_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** One mailbox: a user's linked Google account (`google_connections.id`). */
export interface GmailImportanceKey {
  userId: string;
  accountId: string;
}

const ACCOUNT_LINKED = 'EXISTS (SELECT 1 FROM google_connections WHERE id = ? AND user_id = ?)';

function isLinked(key: GmailImportanceKey): boolean {
  return !!getOrgsDb()
    .prepare(`SELECT 1 FROM google_connections WHERE id = ? AND user_id = ?`)
    .get(key.accountId, key.userId);
}

export const DEFAULT_GMAIL_IMPORTANCE_SETTINGS: GmailImportanceSettings = {
  enabled: false,
  windowDays: 7,
  autoScan: 'off',
  lastScanAt: null,
  lastScanStatus: 'idle',
  lastScanError: null,
  lastScanEngine: null,
  lastScanModel: null,
  lastScanFailover: null,
};

export function isGmailImportanceWindow(value: unknown): value is GmailImportanceWindowDays {
  return (GMAIL_IMPORTANCE_WINDOWS as readonly unknown[]).includes(value);
}

export function isGmailImportanceAutoScan(value: unknown): value is GmailImportanceAutoScan {
  return (GMAIL_IMPORTANCE_AUTO_SCAN as readonly unknown[]).includes(value);
}

function shapeSettings(row: SettingsRow | undefined): GmailImportanceSettings {
  if (!row) return { ...DEFAULT_GMAIL_IMPORTANCE_SETTINGS };
  return {
    enabled: row.enabled === 1,
    windowDays: isGmailImportanceWindow(row.window_days) ? row.window_days : 7,
    autoScan: isGmailImportanceAutoScan(row.auto_scan) ? row.auto_scan : 'off',
    lastScanAt: row.last_scan_at,
    lastScanStatus: (['idle', 'running', 'ok', 'error'] as const).includes(
      row.last_scan_status as GmailImportanceScanStatus,
    )
      ? (row.last_scan_status as GmailImportanceScanStatus)
      : 'idle',
    lastScanError: row.last_scan_error,
    lastScanEngine: row.last_scan_engine,
    lastScanModel: row.last_scan_model,
    lastScanFailover: row.last_scan_failover,
  };
}

export function getGmailImportanceSettings(key: GmailImportanceKey): GmailImportanceSettings {
  const row = getOrgsDb()
    .prepare('SELECT * FROM gmail_importance_settings WHERE user_id = ? AND account_id = ?')
    .get(key.userId, key.accountId) as SettingsRow | undefined;
  return shapeSettings(row);
}

export function updateGmailImportanceSettings(
  key: GmailImportanceKey,
  patch: Partial<Pick<GmailImportanceSettings, 'enabled' | 'windowDays' | 'autoScan'>>,
): GmailImportanceSettings {
  const next = { ...getGmailImportanceSettings(key), ...patch };
  getOrgsDb()
    .prepare(
      `INSERT INTO gmail_importance_settings
         (user_id, account_id, enabled, window_days, auto_scan, updated_at)
       SELECT ?, ?, ?, ?, ?, ${NOW} WHERE ${ACCOUNT_LINKED}
       ON CONFLICT(user_id, account_id) DO UPDATE SET
         enabled = excluded.enabled,
         window_days = excluded.window_days,
         auto_scan = excluded.auto_scan,
         updated_at = excluded.updated_at`,
    )
    .run(
      key.userId,
      key.accountId,
      next.enabled ? 1 : 0,
      next.windowDays,
      next.autoScan,
      key.accountId,
      key.userId,
    );
  return getGmailImportanceSettings(key);
}

/** Ensure a settings row exists so scan bookkeeping has something to update. */
function ensureSettingsRow(key: GmailImportanceKey): void {
  getOrgsDb()
    .prepare(
      `INSERT OR IGNORE INTO gmail_importance_settings (user_id, account_id)
       SELECT ?, ? WHERE ${ACCOUNT_LINKED}`,
    )
    .run(key.userId, key.accountId, key.accountId, key.userId);
}

export function markGmailImportanceScanRunning(key: GmailImportanceKey): void {
  ensureSettingsRow(key);
  getOrgsDb()
    .prepare(
      `UPDATE gmail_importance_settings
         SET last_scan_status = 'running', last_scan_error = NULL, updated_at = ${NOW}
       WHERE user_id = ? AND account_id = ?`,
    )
    .run(key.userId, key.accountId);
}

export function recordGmailImportanceScanResult(
  key: GmailImportanceKey,
  result:
    | { ok: true; engine: string | null; model: string | null; failover: string | null }
    | { ok: false; error: string },
  finishedAt: string = new Date().toISOString(),
): void {
  ensureSettingsRow(key);
  if (result.ok) {
    getOrgsDb()
      .prepare(
        `UPDATE gmail_importance_settings
           SET last_scan_status = 'ok', last_scan_error = NULL, last_scan_at = ?,
               last_scan_engine = ?, last_scan_model = ?, last_scan_failover = ?,
               updated_at = ${NOW}
         WHERE user_id = ? AND account_id = ?`,
      )
      .run(finishedAt, result.engine, result.model, result.failover, key.userId, key.accountId);
  } else {
    // A failed scan still stamps last_scan_at so the auto-scan ticker backs off
    // for a full interval instead of retrying a broken setup every minute.
    getOrgsDb()
      .prepare(
        `UPDATE gmail_importance_settings
           SET last_scan_status = 'error', last_scan_error = ?, last_scan_at = ?,
               updated_at = ${NOW}
         WHERE user_id = ? AND account_id = ?`,
      )
      .run(result.error.slice(0, 1000), finishedAt, key.userId, key.accountId);
  }
}

/**
 * A `running` row left by a crash or restart would otherwise show a spinner
 * forever. Called on boot; in-process scans are tracked in memory anyway.
 */
export function resetStaleGmailImportanceScans(): number {
  return getOrgsDb()
    .prepare(
      `UPDATE gmail_importance_settings
         SET last_scan_status = 'error', last_scan_error = 'Scan interrupted by a server restart'
       WHERE last_scan_status = 'running'`,
    )
    .run().changes;
}

/**
 * Every mailbox with automated scans on, one entry per linked account. Rows
 * whose account is gone are skipped (cleanup normally deletes them).
 */
export function listGmailImportanceAutoScanAccounts(): Array<{
  userId: string;
  accountId: string;
  autoScan: Exclude<GmailImportanceAutoScan, 'off'>;
  lastScanAt: string | null;
}> {
  const rows = getOrgsDb()
    .prepare(
      `SELECT s.user_id, s.account_id, s.auto_scan, s.last_scan_at
         FROM gmail_importance_settings s
         JOIN google_connections g ON g.id = s.account_id AND g.user_id = s.user_id
        WHERE s.enabled = 1 AND s.auto_scan != 'off'`,
    )
    .all() as Array<{
    user_id: string;
    account_id: string;
    auto_scan: string;
    last_scan_at: string | null;
  }>;
  return rows
    .filter((r) => r.auto_scan !== 'off' && isGmailImportanceAutoScan(r.auto_scan))
    .map((r) => ({
      userId: r.user_id,
      accountId: r.account_id,
      autoScan: r.auto_scan as Exclude<GmailImportanceAutoScan, 'off'>,
      lastScanAt: r.last_scan_at,
    }));
}

/** Cached verdicts for these threads, keyed by thread id. */
export function getGmailImportanceVerdicts(
  key: GmailImportanceKey,
  threadIds: readonly string[],
): Map<string, GmailImportanceThread> {
  const out = new Map<string, GmailImportanceThread>();
  if (threadIds.length === 0) return out;
  const stmt = getOrgsDb().prepare(
    'SELECT * FROM gmail_importance_threads WHERE user_id = ? AND account_id = ? AND thread_id = ?',
  );
  for (const id of threadIds) {
    const row = stmt.get(key.userId, key.accountId, id) as ThreadRow | undefined;
    if (row) out.set(id, shapeThread(row));
  }
  return out;
}

function shapeThread(row: ThreadRow): GmailImportanceThread {
  return {
    threadId: row.thread_id,
    historyId: row.history_id,
    important: row.important === 1,
    score: row.score,
    reason: row.reason,
    subject: row.subject,
    from: row.from_addr,
    snippet: row.snippet,
    lastMessageAt: row.last_message_at,
    scannedAt: row.scanned_at,
  };
}

export type GmailImportanceVerdictInput = Omit<GmailImportanceThread, 'scannedAt'>;

export function upsertGmailImportanceVerdicts(
  key: GmailImportanceKey,
  verdicts: readonly GmailImportanceVerdictInput[],
): void {
  if (verdicts.length === 0) return;
  const db = getOrgsDb();
  const stmt = db.prepare(
    `INSERT INTO gmail_importance_threads
       (user_id, account_id, thread_id, history_id, important, score, reason, subject,
        from_addr, snippet, last_message_at, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW})
     ON CONFLICT(user_id, account_id, thread_id) DO UPDATE SET
       history_id = excluded.history_id,
       important = excluded.important,
       score = excluded.score,
       reason = excluded.reason,
       subject = excluded.subject,
       from_addr = excluded.from_addr,
       snippet = excluded.snippet,
       last_message_at = excluded.last_message_at,
       scanned_at = excluded.scanned_at`,
  );
  db.transaction(() => {
    if (!isLinked(key)) return;
    for (const v of verdicts) {
      stmt.run(
        key.userId,
        key.accountId,
        v.threadId,
        v.historyId,
        v.important ? 1 : 0,
        Math.max(0, Math.min(100, Math.round(v.score))),
        v.reason,
        v.subject,
        v.from,
        v.snippet,
        v.lastMessageAt,
      );
    }
  })();
}

/**
 * Important threads whose latest message falls inside the window, highest
 * score first. `sinceIso` is computed by the caller so tests can pin the clock.
 */
export function listImportantGmailThreads(
  key: GmailImportanceKey,
  sinceIso: string,
  limit = 50,
): GmailImportanceThread[] {
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM gmail_importance_threads
        WHERE user_id = ? AND account_id = ? AND important = 1 AND last_message_at >= ?
          AND (dismissed_at_message IS NULL OR last_message_at > dismissed_at_message)
        ORDER BY score DESC, last_message_at DESC
        LIMIT ?`,
    )
    .all(key.userId, key.accountId, sinceIso, limit) as ThreadRow[];
  return rows.map(shapeThread);
}

/** Drop verdicts for mail older than the widest window. */
export function pruneGmailImportanceVerdicts(key: GmailImportanceKey, beforeIso: string): number {
  return getOrgsDb()
    .prepare(
      `DELETE FROM gmail_importance_threads
        WHERE user_id = ? AND account_id = ? AND last_message_at < ?`,
    )
    .run(key.userId, key.accountId, beforeIso).changes;
}

/**
 * Pinned threads to re-check against Gmail this scan: every important thread
 * not in `excludeIds` (already confirmed by the inbox listing), least recently
 * confirmed first, capped at `limit`. Exclusion happens before the cap, and
 * confirmed threads move to the back of the queue, so pins beyond the cap are
 * reached on later scans instead of starving.
 */
export function selectGmailImportanceReconcileBatch(
  key: GmailImportanceKey,
  excludeIds: ReadonlySet<string>,
  limit: number,
): string[] {
  const rows = getOrgsDb()
    .prepare(
      `SELECT thread_id FROM gmail_importance_threads
        WHERE user_id = ? AND account_id = ? AND important = 1
        ORDER BY checked_at IS NOT NULL, checked_at ASC, score DESC, thread_id ASC`,
    )
    .all(key.userId, key.accountId) as Array<{ thread_id: string }>;
  const out: string[] = [];
  for (const r of rows) {
    if (excludeIds.has(r.thread_id)) continue;
    out.push(r.thread_id);
    if (out.length >= limit) break;
  }
  return out;
}

/** Stamp threads Gmail just confirmed are still in the inbox. */
export function markGmailImportanceChecked(
  key: GmailImportanceKey,
  threadIds: Iterable<string>,
  checkedAtIso: string,
): void {
  const db = getOrgsDb();
  const stmt = db.prepare(
    `UPDATE gmail_importance_threads SET checked_at = ?
      WHERE user_id = ? AND account_id = ? AND thread_id = ?`,
  );
  db.transaction(() => {
    for (const id of threadIds) stmt.run(checkedAtIso, key.userId, key.accountId, id);
  })();
}

export function deleteGmailImportanceVerdicts(
  key: GmailImportanceKey,
  threadIds: readonly string[],
): number {
  if (threadIds.length === 0) return 0;
  const db = getOrgsDb();
  const stmt = db.prepare(
    'DELETE FROM gmail_importance_threads WHERE user_id = ? AND account_id = ? AND thread_id = ?',
  );
  let changes = 0;
  db.transaction(() => {
    for (const id of threadIds) changes += stmt.run(key.userId, key.accountId, id).changes;
  })();
  return changes;
}

/**
 * Remove a thread from the user's important list. It stays out until a message
 * newer than the one it was dismissed at arrives. Returns false when the user
 * has no verdict for the thread.
 */
export function dismissGmailImportanceThread(key: GmailImportanceKey, threadId: string): boolean {
  return (
    getOrgsDb()
      .prepare(
        `UPDATE gmail_importance_threads
            SET dismissed_at_message = COALESCE(last_message_at, ${NOW})
          WHERE user_id = ? AND account_id = ? AND thread_id = ?`,
      )
      .run(key.userId, key.accountId, threadId).changes > 0
  );
}
