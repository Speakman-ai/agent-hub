/**
 * Persistence for Server Agent proactive offers.
 *
 *   - `server_agent_offers`: one row per offer raised for a user. A dedupe key
 *     (derived from the fact, e.g. `finalize_failed:<runId>`) identifies the
 *     thing the offer is about, so the same thing is not offered twice.
 *   - `server_agent_offer_suppressions`: "Never for this kind" rules.
 *   - `server_agent_proactive_state`: per-user check bookkeeping (last snapshot
 *     hash, so an unchanged snapshot skips the model).
 *
 * Lives in the main DB beside the sessions and cards the offers point at.
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import {
  PROACTIVE_OFFER_KINDS,
  isProactiveOfferKind,
  type ProactiveOffer,
  type ProactiveOfferKind,
  type ProactiveOfferStatus,
  type ProactiveOfferTarget,
  type ProactiveUrgency,
} from '../../shared/utils/serverAgentProactive.js';

export const PROACTIVE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS server_agent_offers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    area TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    urgency TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT NOT NULL DEFAULT 'scheduled',
    target_json TEXT NOT NULL DEFAULT '{}',
    fact_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    snoozed_until TEXT,
    acted_at TEXT,
    action_session_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS server_agent_offers_user_status
    ON server_agent_offers(user_id, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS server_agent_offers_user_key
    ON server_agent_offers(user_id, dedupe_key, created_at DESC);

  CREATE TABLE IF NOT EXISTS server_agent_offer_suppressions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, kind)
  );

  CREATE TABLE IF NOT EXISTS server_agent_calendar_cache (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_email TEXT NOT NULL DEFAULT '',
    event_id TEXT NOT NULL,
    summary TEXT,
    location TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    start_at TEXT,
    end_at TEXT,
    html_link TEXT,
    event_updated TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id, event_id)
  );

  CREATE TABLE IF NOT EXISTS server_agent_fact_decisions (
    user_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL DEFAULT '',
    declined_at TEXT NOT NULL,
    PRIMARY KEY (user_id, fact_id)
  );

  CREATE TABLE IF NOT EXISTS server_agent_sso_expiry (
    user_id TEXT NOT NULL,
    cache_file TEXT NOT NULL,
    start_url TEXT,
    expires_at TEXT NOT NULL,
    refreshed_at TEXT NOT NULL,
    PRIMARY KEY (user_id, cache_file)
  );

  CREATE TABLE IF NOT EXISTS server_agent_proactive_state (
    user_id TEXT PRIMARY KEY,
    last_check_at TEXT,
    last_status TEXT,
    last_error TEXT,
    last_model_at TEXT,
    calendar_refreshed_at TEXT,
    deferred_reasons TEXT,
    deferred_at TEXT,
    calendar_tz TEXT
  );
`;

/** "Not now" hides a dedupe key for this long. */
export const PROACTIVE_SNOOZE_MS = 24 * 60 * 60_000;
/** Offers nobody acts on expire after this long. */
export const PROACTIVE_EXPIRE_MS = 24 * 60 * 60_000;
/** An expired key is not offered again for this long. */
export const PROACTIVE_EXPIRED_COOLDOWN_MS = 72 * 60 * 60_000;

const initialized = new WeakSet<Database.Database>();

function db(): Database.Database {
  const d = getDb();
  if (!initialized.has(d)) {
    d.exec(PROACTIVE_SCHEMA);
    const cols = d.prepare('PRAGMA table_info(server_agent_proactive_state)').all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === 'calendar_refreshed_at')) {
      d.exec('ALTER TABLE server_agent_proactive_state ADD COLUMN calendar_refreshed_at TEXT');
    }
    const calCols = d.prepare('PRAGMA table_info(server_agent_calendar_cache)').all() as Array<{
      name: string;
    }>;
    if (!calCols.some((c) => c.name === 'event_updated')) {
      d.exec('ALTER TABLE server_agent_calendar_cache ADD COLUMN event_updated TEXT');
    }
    for (const col of ['deferred_reasons', 'deferred_at', 'calendar_tz']) {
      if (!cols.some((c) => c.name === col)) {
        d.exec(`ALTER TABLE server_agent_proactive_state ADD COLUMN ${col} TEXT`);
      }
    }
    const offerCols = d.prepare('PRAGMA table_info(server_agent_offers)').all() as Array<{
      name: string;
    }>;
    if (!offerCols.some((c) => c.name === 'revision')) {
      d.exec('ALTER TABLE server_agent_offers ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    }
    initialized.add(d);
  }
  return d;
}

interface OfferRow {
  id: string;
  user_id: string;
  dedupe_key: string;
  kind: string;
  area: string;
  title: string;
  reason: string;
  action: string;
  urgency: string;
  status: string;
  source: string;
  target_json: string;
  fact_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  snoozed_until: string | null;
  acted_at: string | null;
  action_session_id: string | null;
  revision: number;
}

export interface StoredOffer extends ProactiveOffer {
  userId: string;
  dedupeKey: string;
  fact: Record<string, unknown>;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function toOffer(row: OfferRow): StoredOffer {
  const kind = (isProactiveOfferKind(row.kind) ? row.kind : 'stale_card') as ProactiveOfferKind;
  return {
    id: row.id,
    userId: row.user_id,
    dedupeKey: row.dedupe_key,
    kind,
    area: PROACTIVE_OFFER_KINDS[kind].area,
    title: row.title,
    reason: row.reason,
    action: row.action,
    urgency: row.urgency as ProactiveUrgency,
    status: row.status as ProactiveOfferStatus,
    source: row.source as StoredOffer['source'],
    target: parseJson<ProactiveOfferTarget>(row.target_json, {}),
    fact: parseJson<Record<string, unknown>>(row.fact_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    snoozedUntil: row.snoozed_until,
    actedAt: row.acted_at,
    actionSessionId: row.action_session_id,
    revision: row.revision ?? 0,
  };
}

/** Public shape (no user id, dedupe key or raw fact). */
export function publicOffer(offer: StoredOffer): ProactiveOffer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { userId, dedupeKey, fact, ...rest } = offer;
  return rest;
}

export interface InsertOfferInput {
  userId: string;
  dedupeKey: string;
  kind: ProactiveOfferKind;
  title: string;
  reason: string;
  action: string;
  urgency: ProactiveUrgency;
  source: StoredOffer['source'];
  target: ProactiveOfferTarget;
  fact: Record<string, unknown>;
  now: Date;
}

export function insertOffer(input: InsertOfferInput): StoredOffer {
  const id = uuidv4();
  const nowIso = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + PROACTIVE_EXPIRE_MS).toISOString();
  db()
    .prepare(
      `INSERT INTO server_agent_offers
         (id, user_id, dedupe_key, kind, area, title, reason, action, urgency, status, source,
          target_json, fact_json, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.dedupeKey,
      input.kind,
      PROACTIVE_OFFER_KINDS[input.kind].area,
      input.title,
      input.reason,
      input.action,
      input.urgency,
      input.source,
      JSON.stringify(input.target),
      JSON.stringify(input.fact),
      nowIso,
      nowIso,
      expiresAt,
    );
  return getOffer(input.userId, id)!;
}

export function getOffer(userId: string, id: string): StoredOffer | null {
  const row = db()
    .prepare('SELECT * FROM server_agent_offers WHERE id = ? AND user_id = ?')
    .get(id, userId) as OfferRow | undefined;
  return row ? toOffer(row) : null;
}

export function listOffers(
  userId: string,
  opts: { status?: ProactiveOfferStatus | 'all'; limit?: number } = {},
): StoredOffer[] {
  // SQLite LIMIT needs an integer; callers other than the route may pass anything.
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit ?? 50)) || 50));
  const status = opts.status ?? 'open';
  const rows = (
    status === 'all'
      ? db()
          .prepare(
            'SELECT * FROM server_agent_offers WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(userId, limit)
      : db()
          .prepare(
            `SELECT * FROM server_agent_offers WHERE user_id = ? AND status = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(userId, status, limit)
  ) as OfferRow[];
  return rows.map(toOffer);
}

/**
 * Move an offer out of `open`. Returns null when the offer is gone or was
 * already acted on (so a double-click cannot run the action twice).
 */
/**
 * Move an open offer to `next`. "Open" includes the deadline: an offer past
 * `expires_at` is refused here atomically even if no sweep has marked it
 * expired yet (e.g. right after downtime), so it can't be accepted or acted on.
 */
export function transitionOffer(
  userId: string,
  id: string,
  next: Exclude<ProactiveOfferStatus, 'open'>,
  now: Date,
  extra: { snoozedUntil?: string | null; actionSessionId?: string | null } = {},
): StoredOffer | null {
  const nowIso = now.toISOString();
  const res = db()
    .prepare(
      `UPDATE server_agent_offers
       SET status = ?, updated_at = ?, acted_at = ?, snoozed_until = COALESCE(?, snoozed_until),
           action_session_id = COALESCE(?, action_session_id), revision = revision + 1
       WHERE id = ? AND user_id = ? AND status = 'open'
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .run(
      next,
      nowIso,
      nowIso,
      extra.snoozedUntil ?? null,
      extra.actionSessionId ?? null,
      id,
      userId,
      nowIso,
    );
  if (res.changes === 0) return null;
  return getOffer(userId, id);
}

/**
 * Undo an accept whose work never started (dispatch or session setup failed),
 * so its dedupe key is no longer blocked by the accept. Only an accepted
 * offer moves; anything else is left alone.
 *
 * The offer returns to `open` unless its kind is suppressed right now (the
 * user chose "Never for this kind" while the dispatch was pending, which
 * only retires *open* offers): then it becomes `suppressed`, like the other
 * offers of that kind, so a failure can't bring back a kind the user turned
 * off. Decided in the same UPDATE, so no suppression can land in between.
 */
export function reopenAcceptedOffer(userId: string, id: string, now: Date): StoredOffer | null {
  const res = db()
    .prepare(
      `UPDATE server_agent_offers
       SET status = CASE
             WHEN EXISTS (
               SELECT 1 FROM server_agent_offer_suppressions s
               WHERE s.user_id = server_agent_offers.user_id AND s.kind = server_agent_offers.kind
             ) THEN 'suppressed'
             ELSE 'open'
           END,
           acted_at = NULL, action_session_id = NULL, updated_at = ?,
           revision = revision + 1
       WHERE id = ? AND user_id = ? AND status = 'accepted'`,
    )
    .run(now.toISOString(), id, userId);
  return res.changes > 0 ? getOffer(userId, id) : null;
}

export function setOfferActionSession(userId: string, id: string, sessionId: string): void {
  db()
    .prepare(
      `UPDATE server_agent_offers SET action_session_id = ?, revision = revision + 1
       WHERE id = ? AND user_id = ?`,
    )
    .run(sessionId, id, userId);
}

/** Expire open offers past their deadline. Returns the expired offers. */
export function expireOffers(now: Date, userId?: string): StoredOffer[] {
  const nowIso = now.toISOString();
  const rows = (
    userId
      ? db()
          .prepare(
            `SELECT * FROM server_agent_offers
             WHERE user_id = ? AND status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?`,
          )
          .all(userId, nowIso)
      : db()
          .prepare(
            `SELECT * FROM server_agent_offers
             WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?`,
          )
          .all(nowIso)
  ) as OfferRow[];
  const update = db().prepare(
    `UPDATE server_agent_offers SET status = 'expired', updated_at = ?, revision = revision + 1
     WHERE id = ? AND status = 'open'`,
  );
  const out: StoredOffer[] = [];
  for (const row of rows) {
    if (update.run(nowIso, row.id).changes > 0) {
      out.push({
        ...toOffer(row),
        status: 'expired',
        updatedAt: nowIso,
        revision: row.revision + 1,
      });
    }
  }
  return out;
}

/** Offers raised for `userId` since `sinceIso` (feeds the daily cap). */
export function countOffersSince(userId: string, sinceIso: string): number {
  const row = db()
    .prepare('SELECT COUNT(*) AS n FROM server_agent_offers WHERE user_id = ? AND created_at >= ?')
    .get(userId, sinceIso) as { n: number };
  return row.n;
}

/** An accepted subject is not offered again for this long. */
export const PROACTIVE_ACCEPTED_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/**
 * Dedupe keys that must not be offered right now. Every block is bounded by
 * something that can end, so no status hides a subject forever:
 *
 *   - `open`: until the offer is acted on or expires.
 *   - `accepted`: for {@link PROACTIVE_ACCEPTED_COOLDOWN_MS} after the accept.
 *   - `suppressed`: only while a "Never for this kind" rule for its kind exists.
 *   - `dismissed` ("Not now"): until `snoozed_until`.
 *   - `expired`: for {@link PROACTIVE_EXPIRED_COOLDOWN_MS}.
 */
export function blockedDedupeKeys(userId: string, now: Date): Set<string> {
  const nowIso = now.toISOString();
  const expiredSince = new Date(now.getTime() - PROACTIVE_EXPIRED_COOLDOWN_MS).toISOString();
  const acceptedSince = new Date(now.getTime() - PROACTIVE_ACCEPTED_COOLDOWN_MS).toISOString();
  const rows = db()
    .prepare(
      `SELECT DISTINCT o.dedupe_key FROM server_agent_offers o
       WHERE o.user_id = ? AND (
         o.status = 'open'
         OR (o.status = 'accepted' AND COALESCE(o.acted_at, o.updated_at) > ?)
         OR (o.status = 'suppressed' AND EXISTS (
               SELECT 1 FROM server_agent_offer_suppressions s
               WHERE s.user_id = o.user_id AND s.kind = o.kind))
         OR (o.status = 'dismissed' AND o.snoozed_until IS NOT NULL AND o.snoozed_until > ?)
         OR (o.status = 'expired' AND o.updated_at > ?)
       )`,
    )
    .all(userId, acceptedSince, nowIso, expiredSince) as Array<{ dedupe_key: string }>;
  return new Set(rows.map((r) => r.dedupe_key));
}

export interface Suppression {
  id: string;
  kind: ProactiveOfferKind;
  createdAt: string;
}

export function listSuppressions(userId: string): Suppression[] {
  const rows = db()
    .prepare(
      `SELECT id, kind, created_at FROM server_agent_offer_suppressions
       WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as Array<{ id: string; kind: string; created_at: string }>;
  return rows
    .filter((r) => isProactiveOfferKind(r.kind))
    .map((r) => ({ id: r.id, kind: r.kind as ProactiveOfferKind, createdAt: r.created_at }));
}

export function suppressedKinds(userId: string): Set<ProactiveOfferKind> {
  return new Set(listSuppressions(userId).map((s) => s.kind));
}

/**
 * Add a "Never for this kind" rule and retire the kind's open offers.
 * Returns the offers that were retired.
 */
export function addSuppression(
  userId: string,
  kind: ProactiveOfferKind,
  now: Date,
): { suppression: Suppression; retired: StoredOffer[] } {
  const nowIso = now.toISOString();
  db()
    .prepare(
      `INSERT OR IGNORE INTO server_agent_offer_suppressions (id, user_id, kind, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(uuidv4(), userId, kind, nowIso);
  const open = (
    db()
      .prepare(
        `SELECT * FROM server_agent_offers WHERE user_id = ? AND kind = ? AND status = 'open'`,
      )
      .all(userId, kind) as OfferRow[]
  ).map(toOffer);
  const retired: StoredOffer[] = [];
  for (const offer of open) {
    const next = transitionOffer(userId, offer.id, 'suppressed', now);
    if (next) retired.push(next);
  }
  const suppression = listSuppressions(userId).find((s) => s.kind === kind)!;
  return { suppression, retired };
}

/** Remove a rule by id or kind. Returns true when a row was deleted. */
export function removeSuppression(userId: string, idOrKind: string): boolean {
  const res = db()
    .prepare(
      `DELETE FROM server_agent_offer_suppressions WHERE user_id = ? AND (id = ? OR kind = ?)`,
    )
    .run(userId, idOrKind, idOrKind);
  return res.changes > 0;
}

/** Why a due check could not run its work. */
export const PROACTIVE_DEFER_REASONS = ['quiet', 'cap', 'error'] as const;
export type ProactiveDeferReason = (typeof PROACTIVE_DEFER_REASONS)[number];

/**
 * Per-user check bookkeeping. `lastCheckAt` is the last scheduled or manual
 * check that actually ran (completed); the interval counts from it.
 *
 * A deferred check stores *why* it deferred (`deferredReasons`) and *when*
 * (`deferredAt`), never a retry time. Whether it may run again is decided at
 * each tick against the user's current settings (`isProactiveCheckDue`), so
 * changing quiet hours or the cap takes effect on the next tick instead of
 * waiting out a time computed from the old settings.
 */
export interface ProactiveState {
  lastCheckAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastModelAt: string | null;
  deferredReasons: ProactiveDeferReason[];
  deferredAt: string | null;
}

function parseReasons(raw: string | null | undefined): ProactiveDeferReason[] {
  if (!raw) return [];
  return raw
    .split(',')
    .filter((r): r is ProactiveDeferReason =>
      (PROACTIVE_DEFER_REASONS as readonly string[]).includes(r),
    );
}

export function getProactiveState(userId: string): ProactiveState {
  const row = db()
    .prepare('SELECT * FROM server_agent_proactive_state WHERE user_id = ?')
    .get(userId) as
    | {
        last_check_at: string | null;
        last_status: string | null;
        last_error: string | null;
        last_model_at: string | null;
        deferred_reasons: string | null;
        deferred_at: string | null;
      }
    | undefined;
  return {
    lastCheckAt: row?.last_check_at ?? null,
    lastStatus: row?.last_status ?? null,
    lastError: row?.last_error ?? null,
    lastModelAt: row?.last_model_at ?? null,
    deferredReasons: parseReasons(row?.deferred_reasons),
    deferredAt: row?.deferred_at ?? null,
  };
}

/**
 * Record a scheduled or manual check. A completed check (`defer` empty)
 * moves `last_check_at` and clears any deferral. A deferred one leaves
 * `last_check_at` alone and records its reasons and time.
 */
export function recordProactiveCheck(
  userId: string,
  input: {
    at: Date;
    status: string;
    error?: string | null;
    ranModel: boolean;
    defer: readonly ProactiveDeferReason[];
  },
): void {
  const at = input.at.toISOString();
  const completed = input.defer.length === 0;
  db()
    .prepare(
      `INSERT INTO server_agent_proactive_state
         (user_id, last_check_at, last_status, last_error, last_model_at, deferred_reasons, deferred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         last_check_at = COALESCE(excluded.last_check_at, server_agent_proactive_state.last_check_at),
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         last_model_at = COALESCE(excluded.last_model_at, server_agent_proactive_state.last_model_at),
         deferred_reasons = excluded.deferred_reasons,
         deferred_at = excluded.deferred_at`,
    )
    .run(
      userId,
      completed ? at : null,
      input.status,
      input.error ?? null,
      input.ranModel ? at : null,
      completed ? null : [...new Set(input.defer)].join(','),
      completed ? null : at,
    );
}

/** The time zone the calendar cache was last filled for. */
export function calendarCacheTimeZone(userId: string): string | null {
  const row = db()
    .prepare('SELECT calendar_tz FROM server_agent_proactive_state WHERE user_id = ?')
    .get(userId) as { calendar_tz: string | null } | undefined;
  return row?.calendar_tz ?? null;
}

/** A calendar event as the proactive snapshot sees it (persisted copy). */
export interface CachedCalendarEvent {
  id: string;
  accountId: string;
  accountEmail: string;
  summary: string | null;
  location: string | null;
  allDay: boolean;
  start: string | null;
  end: string | null;
  htmlLink: string | null;
  /** Google's last-modified time; part of the calendar facts' occurrence. */
  updated?: string | null;
}

/** Replace the user's cached calendar with a fresh read. */
export function replaceCalendarCache(
  userId: string,
  events: readonly CachedCalendarEvent[],
  now: Date,
  timeZone: string | null = null,
): void {
  const d = db();
  const at = now.toISOString();
  d.transaction(() => {
    d.prepare('DELETE FROM server_agent_calendar_cache WHERE user_id = ?').run(userId);
    const insert = d.prepare(
      `INSERT OR REPLACE INTO server_agent_calendar_cache
         (user_id, account_id, account_email, event_id, summary, location, all_day, start_at,
          end_at, html_link, event_updated, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of events) {
      insert.run(
        userId,
        e.accountId,
        e.accountEmail,
        e.id,
        e.summary,
        e.location,
        e.allDay ? 1 : 0,
        e.start,
        e.end,
        e.htmlLink,
        e.updated ?? null,
        at,
      );
    }
    d.prepare(
      `INSERT INTO server_agent_proactive_state (user_id, calendar_refreshed_at, calendar_tz)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         calendar_refreshed_at = excluded.calendar_refreshed_at,
         calendar_tz = excluded.calendar_tz`,
    ).run(userId, at, timeZone);
  })();
}

/** Drop cached events of accounts not in `keep` (disconnected or scope revoked). */
export function pruneCalendarCache(userId: string, keep: ReadonlySet<string>): number {
  const ids = [...keep];
  const res =
    ids.length === 0
      ? db().prepare('DELETE FROM server_agent_calendar_cache WHERE user_id = ?').run(userId)
      : db()
          .prepare(
            `DELETE FROM server_agent_calendar_cache
             WHERE user_id = ? AND account_id NOT IN (${ids.map(() => '?').join(',')})`,
          )
          .run(userId, ...ids);
  return res.changes;
}

export function listCachedCalendarEvents(userId: string): CachedCalendarEvent[] {
  const rows = db()
    .prepare(`SELECT * FROM server_agent_calendar_cache WHERE user_id = ? ORDER BY start_at ASC`)
    .all(userId) as Array<{
    account_id: string;
    account_email: string;
    event_id: string;
    summary: string | null;
    location: string | null;
    all_day: number;
    start_at: string | null;
    end_at: string | null;
    html_link: string | null;
    event_updated: string | null;
  }>;
  return rows.map((r) => ({
    id: r.event_id,
    accountId: r.account_id,
    accountEmail: r.account_email,
    summary: r.summary,
    location: r.location,
    allDay: r.all_day === 1,
    start: r.start_at,
    end: r.end_at,
    htmlLink: r.html_link,
    updated: r.event_updated,
  }));
}

export function calendarRefreshedAt(userId: string): string | null {
  const row = db()
    .prepare('SELECT calendar_refreshed_at FROM server_agent_proactive_state WHERE user_id = ?')
    .get(userId) as { calendar_refreshed_at: string | null } | undefined;
  return row?.calendar_refreshed_at ?? null;
}

/**
 * A fact the model looked at and chose not to offer. The skip-the-model
 * decision is made per fact against these rows: a fact is classified again
 * when it is new, its fingerprint changed, or its decline is older than
 * {@link PROACTIVE_DECLINE_TTL_MS}. Facts that became offers get no row; the
 * offer lifecycle (open, snoozed, expired cooldown) governs them, so once a
 * snooze or cooldown ends the fact is simply undecided again.
 */
export const PROACTIVE_DECLINE_TTL_MS = 24 * 60 * 60_000;

export function declinedFacts(userId: string, now: Date): Map<string, string> {
  const since = new Date(now.getTime() - PROACTIVE_DECLINE_TTL_MS).toISOString();
  const rows = db()
    .prepare(
      `SELECT fact_id, fingerprint FROM server_agent_fact_decisions
       WHERE user_id = ? AND declined_at > ?`,
    )
    .all(userId, since) as Array<{ fact_id: string; fingerprint: string }>;
  return new Map(rows.map((r) => [r.fact_id, r.fingerprint]));
}

export function recordDeclinedFacts(
  userId: string,
  facts: ReadonlyArray<{ id: string; fingerprint: string }>,
  now: Date,
): void {
  if (facts.length === 0) return;
  const d = db();
  const at = now.toISOString();
  const upsert = d.prepare(
    `INSERT INTO server_agent_fact_decisions (user_id, fact_id, fingerprint, declined_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, fact_id) DO UPDATE SET
       fingerprint = excluded.fingerprint, declined_at = excluded.declined_at`,
  );
  d.transaction(() => {
    for (const f of facts) upsert.run(userId, f.id, f.fingerprint, at);
  })();
  // Old declines only matter inside the TTL; keep the table small.
  d.prepare('DELETE FROM server_agent_fact_decisions WHERE user_id = ? AND declined_at <= ?').run(
    userId,
    new Date(now.getTime() - PROACTIVE_DECLINE_TTL_MS).toISOString(),
  );
}

/** Non-secret AWS SSO token metadata copied out of the user's cache files. */
export interface SsoExpiryRow {
  cacheFile: string;
  startUrl: string | null;
  expiresAt: string;
}

export function replaceSsoExpiry(userId: string, rows: readonly SsoExpiryRow[], now: Date): void {
  const d = db();
  const at = now.toISOString();
  d.transaction(() => {
    d.prepare('DELETE FROM server_agent_sso_expiry WHERE user_id = ?').run(userId);
    const insert = d.prepare(
      `INSERT OR REPLACE INTO server_agent_sso_expiry
         (user_id, cache_file, start_url, expires_at, refreshed_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of rows) insert.run(userId, r.cacheFile, r.startUrl, r.expiresAt, at);
  })();
}

export function listSsoExpiry(userId: string): SsoExpiryRow[] {
  const rows = db()
    .prepare(
      'SELECT cache_file, start_url, expires_at FROM server_agent_sso_expiry WHERE user_id = ?',
    )
    .all(userId) as Array<{ cache_file: string; start_url: string | null; expires_at: string }>;
  return rows.map((r) => ({
    cacheFile: r.cache_file,
    startUrl: r.start_url,
    expiresAt: r.expires_at,
  }));
}
