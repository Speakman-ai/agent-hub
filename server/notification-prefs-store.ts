/**
 * Per-user notification preferences (`user_notification_prefs`).
 *
 * One row per (user, category) holding the three channel switches. A missing
 * row resolves to the catalog defaults in
 * `shared/utils/notificationCategories.ts`, so adding a category to the
 * catalog never needs a backfill. These prefs are the single source of truth
 * across web, desktop and phones; the schema and the one-time device-token
 * migration live in `migrations/user-notification-prefs.ts`.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { getDb } from './db.js';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  isNotificationCategoryId,
  type ChannelDefaults,
  type NotificationCategoryId,
} from '../shared/utils/notificationCategories.js';

export interface UserNotificationPrefRow {
  user_id: string;
  category: string;
  in_app: number;
  desktop: number;
  push: number;
  updated_at: string;
}

export interface NotificationCategoryPrefs extends ChannelDefaults {
  category: NotificationCategoryId;
  /** True when no stored row exists and the values are the catalog defaults. */
  isDefault: boolean;
}

export type NotificationPrefsPatch = Partial<
  Record<NotificationCategoryId, Partial<ChannelDefaults>>
>;

/** The caller's full matrix: every catalog category, stored or defaulted. */
export function getUserNotificationPrefs(
  userId: string,
  db: BetterSqlite3.Database = getDb(),
): NotificationCategoryPrefs[] {
  const rows = db
    .prepare('SELECT * FROM user_notification_prefs WHERE user_id = ?')
    .all(userId) as UserNotificationPrefRow[];
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  return NOTIFICATION_CATEGORIES.map((c) => {
    const row = byCategory.get(c.id);
    if (!row) return { category: c.id, ...c.defaults, isDefault: true };
    return {
      category: c.id,
      in_app: row.in_app === 1,
      desktop: row.desktop === 1,
      push: row.push === 1,
      isDefault: false,
    };
  });
}

/**
 * Apply a partial patch. Channels omitted from a category keep their current
 * value (stored, else default). Unknown categories are rejected by the route
 * before reaching here; they are ignored defensively.
 */
export function updateUserNotificationPrefs(
  userId: string,
  patch: NotificationPrefsPatch,
  db: BetterSqlite3.Database = getDb(),
): NotificationCategoryPrefs[] {
  const current = new Map(getUserNotificationPrefs(userId, db).map((p) => [p.category, p]));
  const upsert = db.prepare(
    `INSERT INTO user_notification_prefs (user_id, category, in_app, desktop, push)
     VALUES (@user_id, @category, @in_app, @desktop, @push)
     ON CONFLICT(user_id, category) DO UPDATE SET
       in_app = excluded.in_app,
       desktop = excluded.desktop,
       push = excluded.push,
       updated_at = datetime('now')`,
  );
  db.transaction(() => {
    for (const [category, channels] of Object.entries(patch)) {
      if (!isNotificationCategoryId(category) || !channels) continue;
      const base = current.get(category);
      if (!base) continue;
      const next: Record<string, number | string> = { user_id: userId, category };
      for (const ch of NOTIFICATION_CHANNELS) {
        next[ch] = (channels[ch] ?? base[ch]) ? 1 : 0;
      }
      upsert.run(next);
    }
  })();
  return getUserNotificationPrefs(userId, db);
}
