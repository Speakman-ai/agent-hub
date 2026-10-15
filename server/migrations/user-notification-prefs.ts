/**
 * Schema for `user_notification_prefs` plus the one-time fold of per-device
 * `device_tokens.enabled_events` into it. Kept free of `db.js` imports so
 * `initDb` can call it without an import cycle.
 */
import type BetterSqlite3 from 'better-sqlite3';
import {
  NOTIFICATION_CATEGORIES,
  PUSH_EVENT_CATEGORIES,
  PUSH_EVENT_TYPES,
  type ChannelDefaults,
  type NotificationCategoryId,
  type PushEventType,
} from '../../shared/utils/notificationCategories.js';

export const USER_NOTIFICATION_PREFS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_notification_prefs (
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    in_app INTEGER NOT NULL,
    desktop INTEGER NOT NULL,
    push INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, category)
  );
`;

/**
 * Event keys an older mobile build may still have persisted in
 * `enabled_events`, mapped to their current names. Mirrors the aliasing push
 * dispatch applies, so the migration reads a device list the same way the
 * dispatcher did.
 */
const LEGACY_EVENT_ALIASES: Record<string, PushEventType> = {
  session_complete: 'awaiting_feedback',
  changes_ready: 'ready_to_push',
  card_review: 'review_assigned_to_you',
};

/**
 * Categories a device's `enabled_events` value turns off. `null`, empty, or
 * unparseable means "all events on" (the device default), so nothing is off.
 */
export function categoriesDisabledByEnabledEvents(
  raw: string | null | undefined,
): Set<NotificationCategoryId> {
  const off = new Set<NotificationCategoryId>();
  if (raw == null || raw === '') return off;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return off;
  }
  if (!Array.isArray(parsed)) return off;
  const enabled = new Set<string>();
  for (const x of parsed) {
    if (typeof x !== 'string') continue;
    enabled.add(x);
    const alias = LEGACY_EVENT_ALIASES[x];
    if (alias) enabled.add(alias);
  }
  for (const event of PUSH_EVENT_TYPES) {
    if (enabled.has(event)) continue;
    for (const cat of PUSH_EVENT_CATEGORIES[event]) off.add(cat);
  }
  return off;
}

export interface MigrateDevicePrefsResult {
  users: number;
  rows: number;
}

/**
 * Fold every device's `enabled_events` into its owner's prefs: a category
 * disabled on any of a user's devices becomes `push = false`. Devices without
 * a `user_id` have no owner to attribute to and are skipped. Other channels
 * keep their catalog defaults (or the stored value when a row already exists).
 */
export function migrateDeviceEnabledEventsToUserPrefs(
  db: BetterSqlite3.Database,
): MigrateDevicePrefsResult {
  const devices = db
    .prepare(
      `SELECT user_id, enabled_events FROM device_tokens
       WHERE user_id IS NOT NULL AND user_id != '' AND enabled_events IS NOT NULL`,
    )
    .all() as Array<{ user_id: string; enabled_events: string }>;

  const offByUser = new Map<string, Set<NotificationCategoryId>>();
  for (const d of devices) {
    const off = categoriesDisabledByEnabledEvents(d.enabled_events);
    if (off.size === 0) continue;
    const acc = offByUser.get(d.user_id) ?? new Set<NotificationCategoryId>();
    for (const c of off) acc.add(c);
    offByUser.set(d.user_id, acc);
  }

  const upsert = db.prepare(
    `INSERT INTO user_notification_prefs (user_id, category, in_app, desktop, push)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(user_id, category) DO UPDATE SET push = 0, updated_at = datetime('now')`,
  );
  let rows = 0;
  for (const [userId, off] of offByUser) {
    for (const category of off) {
      const defaults = defaultsFor(category);
      upsert.run(userId, category, defaults.in_app ? 1 : 0, defaults.desktop ? 1 : 0);
      rows++;
    }
  }
  return { users: offByUser.size, rows };
}

/**
 * Create the prefs table and, only on the init that creates it, run the
 * device-token migration in the same transaction. Later inits find the table
 * and skip, so a user re-enabling push afterwards is never overwritten.
 */
export function ensureUserNotificationPrefsSchema(
  db: BetterSqlite3.Database,
): MigrateDevicePrefsResult | null {
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_notification_prefs'",
    )
    .get();
  if (exists) return null;
  return db.transaction(() => {
    db.exec(USER_NOTIFICATION_PREFS_SCHEMA);
    return migrateDeviceEnabledEventsToUserPrefs(db);
  })();
}

export function defaultsFor(category: NotificationCategoryId): ChannelDefaults {
  const cat = NOTIFICATION_CATEGORIES.find((c) => c.id === category);
  return cat ? { ...cat.defaults } : { in_app: false, desktop: false, push: false };
}
