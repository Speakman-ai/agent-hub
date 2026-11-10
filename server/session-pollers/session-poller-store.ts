/**
 * Session pollers: a user-confirmed recurring check that wakes one session
 * every `interval_minutes` until `ends_at`. Throwaway by design, so the
 * schedule lives on the session rather than in the project's cron jobs.
 *
 * Timestamps are ISO-8601 strings written here (not `datetime('now')`) so the
 * scheduler can compare them lexically against `new Date().toISOString()`.
 */
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { SessionPoller, SessionPollerStatus } from '../../shared/utils/sessionPoller.js';

export const SESSION_POLLERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_pollers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  poller_id TEXT NOT NULL,
  task TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  notify_each_run INTEGER NOT NULL DEFAULT 0,
  notify_on_complete INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  run_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  finished_at TEXT,
  created_by TEXT,
  UNIQUE(session_id, poller_id)
);
CREATE INDEX IF NOT EXISTS idx_session_pollers_status ON session_pollers(status);
`;

interface SessionPollerRow {
  id: string;
  session_id: string;
  poller_id: string;
  task: string;
  interval_minutes: number;
  duration_minutes: number;
  notify_each_run: number;
  notify_on_complete: number;
  status: SessionPollerStatus;
  run_count: number;
  started_at: string;
  ends_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  finished_at: string | null;
  created_by: string | null;
}

function toPoller(row: SessionPollerRow): SessionPoller {
  return {
    id: row.id,
    sessionId: row.session_id,
    pollerId: row.poller_id,
    task: row.task,
    intervalMinutes: row.interval_minutes,
    durationMinutes: row.duration_minutes,
    notifyEachRun: row.notify_each_run === 1,
    notifyOnComplete: row.notify_on_complete === 1,
    status: row.status,
    runCount: row.run_count,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    finishedAt: row.finished_at,
  };
}

export interface CreateSessionPollerInput {
  sessionId: string;
  pollerId: string;
  task: string;
  intervalMinutes: number;
  durationMinutes: number;
  notifyEachRun: boolean;
  notifyOnComplete: boolean;
  createdBy?: string | null;
  now?: Date;
}

export class SessionPollerStore {
  constructor(private readonly db: Database) {
    db.exec(SESSION_POLLERS_SCHEMA);
  }

  /**
   * Start a poller. The card's `pollerId` makes this idempotent: a second
   * click, or a reload that re-submits, returns the existing row.
   */
  create(input: CreateSessionPollerInput): { poller: SessionPoller; created: boolean } {
    const existing = this.getByPollerId(input.sessionId, input.pollerId);
    if (existing) return { poller: existing, created: false };
    const now = input.now ?? new Date();
    const startedAt = now.toISOString();
    const endsAt = new Date(now.getTime() + input.durationMinutes * 60_000).toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO session_pollers (id, session_id, poller_id, task, interval_minutes,
           duration_minutes, notify_each_run, notify_on_complete, status, run_count,
           started_at, ends_at, next_run_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.pollerId,
        input.task,
        input.intervalMinutes,
        input.durationMinutes,
        input.notifyEachRun ? 1 : 0,
        input.notifyOnComplete ? 1 : 0,
        startedAt,
        endsAt,
        // The first check runs right away; waiting a full interval to learn
        // the poller works defeats the point of a quick throwaway test.
        startedAt,
        input.createdBy ?? null,
      );
    return { poller: this.get(id)!, created: true };
  }

  get(id: string): SessionPoller | null {
    const row = this.db.prepare(`SELECT * FROM session_pollers WHERE id = ?`).get(id) as
      | SessionPollerRow
      | undefined;
    return row ? toPoller(row) : null;
  }

  getByPollerId(sessionId: string, pollerId: string): SessionPoller | null {
    const row = this.db
      .prepare(`SELECT * FROM session_pollers WHERE session_id = ? AND poller_id = ?`)
      .get(sessionId, pollerId) as SessionPollerRow | undefined;
    return row ? toPoller(row) : null;
  }

  listForSession(sessionId: string): SessionPoller[] {
    return (
      this.db
        .prepare(`SELECT * FROM session_pollers WHERE session_id = ? ORDER BY started_at ASC`)
        .all(sessionId) as SessionPollerRow[]
    ).map(toPoller);
  }

  listActive(): SessionPoller[] {
    return (
      this.db
        .prepare(`SELECT * FROM session_pollers WHERE status = 'active' ORDER BY started_at ASC`)
        .all() as SessionPollerRow[]
    ).map(toPoller);
  }

  /**
   * Record a run and schedule the next one on the original cadence. Slots
   * missed while the session was busy are skipped rather than replayed back
   * to back.
   */
  recordRun(id: string, now: Date = new Date()): SessionPoller | null {
    const poller = this.get(id);
    if (!poller || poller.status !== 'active') return null;
    const intervalMs = poller.intervalMinutes * 60_000;
    let next = Date.parse(poller.nextRunAt ?? poller.startedAt);
    if (!Number.isFinite(next)) next = now.getTime();
    while (next <= now.getTime()) next += intervalMs;
    this.db
      .prepare(
        `UPDATE session_pollers SET run_count = run_count + 1, last_run_at = ?, next_run_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(now.toISOString(), new Date(next).toISOString(), id);
    return this.get(id);
  }

  /** Move an active poller to a final state. Returns null when it was not active. */
  finish(
    id: string,
    status: Exclude<SessionPollerStatus, 'active'>,
    now: Date = new Date(),
  ): SessionPoller | null {
    const result = this.db
      .prepare(
        `UPDATE session_pollers SET status = ?, finished_at = ?, next_run_at = NULL
         WHERE id = ? AND status = 'active'`,
      )
      .run(status, now.toISOString(), id);
    return result.changes > 0 ? this.get(id) : null;
  }

  cancelForSession(sessionId: string, now: Date = new Date()): number {
    return this.db
      .prepare(
        `UPDATE session_pollers SET status = 'cancelled', finished_at = ?, next_run_at = NULL
         WHERE session_id = ? AND status = 'active'`,
      )
      .run(now.toISOString(), sessionId).changes;
  }
}
