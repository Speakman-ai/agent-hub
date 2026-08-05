/**
 * Issue-group store for repeated-error grouping (decision LOG-GROUP).
 *
 * An **issue** is one distinct error fingerprint (see `log-fingerprint.ts`).
 * This module owns the aggregate + lifecycle state that sits ON TOP of the
 * immutable raw records:
 *
 *   - `recordIssueOccurrence` runs on the write path, inside the same
 *     transaction that inserts the raw record, so an ERROR-or-higher (or
 *     structured-exception) record atomically bumps its group's count /
 *     first-last-seen / release facets and, when the group was `resolved`,
 *     reopens it (recurrence). It never mutates the raw record.
 *   - `listIssues` / `getIssue` / `setIssueStatus` back the project-scoped
 *     REST API (list, detail, resolve, ignore, reopen).
 *
 * Raw records stay in `log_records` and are joined back by
 * `(project_id, fingerprint)` — the issue row only holds aggregate state, so
 * pruning/retention of raw records never corrupts issue history.
 *
 * Thin synchronous `better-sqlite3` wrappers against the dedicated `logs.db`
 * handle (decision LOG-STORE), so they unit-test against a scratch data dir.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getLogsDb } from './logs-db.js';
import type { IssueGrouping } from './log-fingerprint.js';

export type IssueStatus = 'open' | 'resolved' | 'ignored';
export const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'resolved', 'ignored'];

/** Who/what recurrence attributes a system-driven reopen to. */
export const RECURRENCE_ACTOR = 'system:recurrence';

/** Max issues returned by one bounded list page. */
export const MAX_ISSUE_LIST_LIMIT = 200;
export const DEFAULT_ISSUE_LIST_LIMIT = 50;

export interface LogIssueRow {
  id: string;
  project_id: string;
  fingerprint: string;
  title: string;
  service: string | null;
  environment: string | null;
  exception_type: string | null;
  message_template: string | null;
  first_seen: number;
  last_seen: number;
  event_count: number;
  status: IssueStatus;
  status_updated_at: number | null;
  status_updated_by: string | null;
  first_record_id: number | null;
  last_record_id: number | null;
  /** Linked Analyze chat session (LOG-ANALYZE), or null before Analyze runs. */
  analyze_session_id: string | null;
  /** Linked active Fix card/session (LOG-FIX), or null before Fix runs. */
  fix_card_id?: string | null;
  fix_session_id?: string | null;
  created_at: number;
  updated_at: number;
}

export interface LogIssueReleaseRow {
  issue_id: string;
  release: string;
  commit_sha: string;
  first_seen: number;
  last_seen: number;
  event_count: number;
}

// ── Write path ──────────────────────────────────────────────────────────────

/**
 * Fold one committed record occurrence into its issue group. MUST be called
 * inside the record insert transaction (pass its `db`) so the group aggregate
 * and the raw row commit or roll back together. Returns the group id and
 * whether this occurrence reopened a resolved group.
 */
export function recordIssueOccurrence(
  db: Database.Database,
  projectId: string,
  grouping: IssueGrouping,
  recordId: number,
  timeUnixNano: number,
  nowMs: number,
): { issueId: string; reopened: boolean } {
  const existing = db
    .prepare('SELECT * FROM log_issues WHERE project_id = ? AND fingerprint = ?')
    .get(projectId, grouping.fingerprint) as LogIssueRow | undefined;

  let issueId: string;
  let reopened = false;

  if (!existing) {
    issueId = uuidv4();
    db.prepare(
      `INSERT INTO log_issues
         (id, project_id, fingerprint, title, service, environment, exception_type,
          message_template, first_seen, last_seen, event_count, status,
          status_updated_at, status_updated_by, first_record_id, last_record_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      issueId,
      projectId,
      grouping.fingerprint,
      grouping.title,
      grouping.service,
      grouping.environment,
      grouping.exceptionType,
      grouping.messageTemplate || null,
      timeUnixNano,
      timeUnixNano,
      recordId,
      recordId,
      nowMs,
      nowMs,
    );
  } else {
    issueId = existing.id;
    // Recurrence reopens a resolved group; an ignored group stays muted.
    let status: IssueStatus = existing.status;
    let statusUpdatedAt = existing.status_updated_at;
    let statusUpdatedBy = existing.status_updated_by;
    if (existing.status === 'resolved') {
      status = 'open';
      statusUpdatedAt = nowMs;
      statusUpdatedBy = RECURRENCE_ACTOR;
      reopened = true;
    }
    // Records can arrive out of order — keep the true min/max and the record
    // ids representative of the earliest / most-recent occurrence.
    const firstSeen = Math.min(existing.first_seen, timeUnixNano);
    const lastSeen = Math.max(existing.last_seen, timeUnixNano);
    const firstRecordId = timeUnixNano < existing.first_seen ? recordId : existing.first_record_id;
    const lastRecordId = timeUnixNano >= existing.last_seen ? recordId : existing.last_record_id;
    db.prepare(
      `UPDATE log_issues
         SET event_count = event_count + 1,
             first_seen = ?, last_seen = ?,
             first_record_id = ?, last_record_id = ?,
             status = ?, status_updated_at = ?, status_updated_by = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(
      firstSeen,
      lastSeen,
      firstRecordId,
      lastRecordId,
      status,
      statusUpdatedAt,
      statusUpdatedBy,
      nowMs,
      issueId,
    );
  }

  // Release / commit facet (decision LOG-GROUP: tracked as a facet, never in
  // the fingerprint). Empty string stands in for an absent release/commit.
  if (grouping.release || grouping.commitSha) {
    db.prepare(
      `INSERT INTO log_issue_releases
         (issue_id, release, commit_sha, first_seen, last_seen, event_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(issue_id, release, commit_sha) DO UPDATE SET
         first_seen  = MIN(first_seen, excluded.first_seen),
         last_seen   = MAX(last_seen, excluded.last_seen),
         event_count = event_count + 1`,
    ).run(issueId, grouping.release ?? '', grouping.commitSha ?? '', timeUnixNano, timeUnixNano);
  }

  return { issueId, reopened };
}

// ── Read path ─────────────────────────────────────────────────────────────

export interface IssueListQuery {
  projectId: string;
  status?: IssueStatus;
  limit?: number;
  /** Opaque cursor from a prior page (`${last_seen}_${id}`). */
  cursor?: string;
}

export interface IssueListPage {
  issues: LogIssueRow[];
  nextCursor: string | null;
}

function clampIssueLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_ISSUE_LIST_LIMIT;
  return Math.min(MAX_ISSUE_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}

function encodeCursor(row: LogIssueRow): string {
  return `${row.last_seen}_${row.id}`;
}

function decodeCursor(cursor: string): { lastSeen: number; id: string } | null {
  const idx = cursor.indexOf('_');
  if (idx <= 0) return null;
  const lastSeen = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(lastSeen) || !id) return null;
  return { lastSeen, id };
}

/**
 * Project-scoped, newest-activity-first, cursor-paginated issue list. Ordered
 * by (last_seen DESC, id DESC) so the cursor is a stable total order even when
 * many issues share a last_seen.
 */
export function listIssues(query: IssueListQuery): IssueListPage {
  const db = getLogsDb();
  const limit = clampIssueLimit(query.limit);
  const where: string[] = ['project_id = ?'];
  const params: Array<string | number> = [query.projectId];
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    if (c) {
      where.push('(last_seen < ? OR (last_seen = ? AND id < ?))');
      params.push(c.lastSeen, c.lastSeen, c.id);
    }
  }
  const rows = db
    .prepare(
      `SELECT * FROM log_issues
        WHERE ${where.join(' AND ')}
        ORDER BY last_seen DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as LogIssueRow[];

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    nextCursor = encodeCursor(rows[rows.length - 1]);
  }
  return { issues: rows, nextCursor };
}

/** Fetch one issue scoped to its project. Returns null on miss or cross-project id. */
export function getIssue(projectId: string, issueId: string): LogIssueRow | null {
  const row = getLogsDb()
    .prepare('SELECT * FROM log_issues WHERE project_id = ? AND id = ?')
    .get(projectId, issueId) as LogIssueRow | undefined;
  return row ?? null;
}

/** Release/commit facets for an issue, most-recent activity first. */
export function getIssueReleases(issueId: string): LogIssueReleaseRow[] {
  return getLogsDb()
    .prepare(
      'SELECT * FROM log_issue_releases WHERE issue_id = ? ORDER BY last_seen DESC, release ASC',
    )
    .all(issueId) as LogIssueReleaseRow[];
}

/**
 * Set an issue's lifecycle status (resolve / ignore / reopen). Project-scoped:
 * an id from another project never matches. Returns the updated row, or null
 * when the issue does not exist in the project.
 */
export function setIssueStatus(
  projectId: string,
  issueId: string,
  status: IssueStatus,
  actorUserId: string | null,
  nowMs: number,
): LogIssueRow | null {
  const db = getLogsDb();
  const info = db
    .prepare(
      `UPDATE log_issues
         SET status = ?, status_updated_at = ?, status_updated_by = ?, updated_at = ?
       WHERE project_id = ? AND id = ?`,
    )
    .run(status, nowMs, actorUserId, nowMs, projectId, issueId);
  if (info.changes === 0) return null;
  return getIssue(projectId, issueId);
}

/**
 * Atomically claim the Analyze slot before creating a session in agent-hub.db.
 * `replaceSessionId` is only supplied when the issue points at a deleted
 * session; the compare-and-swap keeps two stale-link retries from both
 * replacing the winner. The claim table is the coordination boundary because
 * the issue store and sessions live in separate SQLite databases.
 */
export function claimIssueAnalyzeSession(
  projectId: string,
  issueId: string,
  sessionId: string,
  replaceSessionId: string | null = null,
): { claimed: boolean; sessionId: string | null } {
  const db = getLogsDb();
  return db.transaction(() => {
    const current = db
      .prepare(
        `SELECT session_id FROM log_issue_analyze_claims
         WHERE project_id = ? AND issue_id = ?`,
      )
      .get(projectId, issueId) as { session_id: string } | undefined;

    if (!current) {
      const inserted = db
        .prepare(
          `INSERT INTO log_issue_analyze_claims
             (project_id, issue_id, session_id, claimed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, issue_id) DO NOTHING`,
        )
        .run(projectId, issueId, sessionId, Date.now());
      if (inserted.changes === 0) {
        const winner = db
          .prepare(
            `SELECT session_id FROM log_issue_analyze_claims
             WHERE project_id = ? AND issue_id = ?`,
          )
          .get(projectId, issueId) as { session_id: string } | undefined;
        return { claimed: false, sessionId: winner?.session_id ?? null };
      }
    } else if (replaceSessionId && current.session_id === replaceSessionId) {
      db.prepare(
        `UPDATE log_issue_analyze_claims
            SET session_id = ?, claimed_at = ?
          WHERE project_id = ? AND issue_id = ? AND session_id = ?`,
      ).run(sessionId, Date.now(), projectId, issueId, replaceSessionId);
    } else {
      return { claimed: false, sessionId: current.session_id };
    }

    db.prepare(
      `UPDATE log_issues
          SET analyze_session_id = ?
        WHERE project_id = ? AND id = ?`,
    ).run(sessionId, projectId, issueId);
    return { claimed: true, sessionId };
  })();
}

/** Release a claim if session creation failed; compare-and-swap protects a replacement winner. */
export function releaseIssueAnalyzeSession(
  projectId: string,
  issueId: string,
  sessionId: string,
): void {
  const db = getLogsDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM log_issue_analyze_claims
        WHERE project_id = ? AND issue_id = ? AND session_id = ?`,
    ).run(projectId, issueId, sessionId);
    db.prepare(
      `UPDATE log_issues
          SET analyze_session_id = NULL
        WHERE project_id = ? AND id = ? AND analyze_session_id = ?`,
    ).run(projectId, issueId, sessionId);
  })();
}

/** Check ownership immediately before publishing an Analyze session. */
export function ownsIssueAnalyzeSessionClaim(
  projectId: string,
  issueId: string,
  sessionId: string,
): boolean {
  return Boolean(
    getLogsDb()
      .prepare(
        `SELECT 1 FROM log_issue_analyze_claims
         WHERE project_id = ? AND issue_id = ? AND session_id = ?`,
      )
      .get(projectId, issueId, sessionId),
  );
}

/**
 * Atomically claim the one active Fix workflow for an issue. The card and
 * session ids are generated by the caller, then stored in the claim before
 * the main database transaction creates either row. A competing request gets
 * the winner rather than entering board assignment and creating a duplicate.
 */
export function claimIssueFixSession(
  projectId: string,
  issueId: string,
  cardId: string,
  sessionId: string,
  replace?: { cardId: string; sessionId: string } | null,
): {
  claimed: boolean;
  cardId: string | null;
  sessionId: string | null;
  claimedAt: number | null;
} {
  const db = getLogsDb();
  return db.transaction(() => {
    const current = db
      .prepare(
        `SELECT card_id, session_id, claimed_at FROM log_issue_fix_claims
         WHERE project_id = ? AND issue_id = ?`,
      )
      .get(projectId, issueId) as
      | { card_id: string; session_id: string; claimed_at: number }
      | undefined;
    let claimedAt = Date.now();

    if (!current) {
      const inserted = db
        .prepare(
          `INSERT INTO log_issue_fix_claims
             (project_id, issue_id, card_id, session_id, claimed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, issue_id) DO NOTHING`,
        )
        .run(projectId, issueId, cardId, sessionId, claimedAt);
      if (inserted.changes === 0) {
        const winner = db
          .prepare(
            `SELECT card_id, session_id, claimed_at FROM log_issue_fix_claims
             WHERE project_id = ? AND issue_id = ?`,
          )
          .get(projectId, issueId) as
          | { card_id: string; session_id: string; claimed_at: number }
          | undefined;
        return {
          claimed: false,
          cardId: winner?.card_id ?? null,
          sessionId: winner?.session_id ?? null,
          claimedAt: winner?.claimed_at ?? null,
        };
      }
    } else if (
      replace &&
      current.card_id === replace.cardId &&
      current.session_id === replace.sessionId
    ) {
      claimedAt = Date.now();
      db.prepare(
        `UPDATE log_issue_fix_claims
            SET card_id = ?, session_id = ?, claimed_at = ?
          WHERE project_id = ? AND issue_id = ? AND card_id = ? AND session_id = ?`,
      ).run(cardId, sessionId, claimedAt, projectId, issueId, replace.cardId, replace.sessionId);
    } else {
      return {
        claimed: false,
        cardId: current.card_id,
        sessionId: current.session_id,
        claimedAt: current.claimed_at,
      };
    }

    db.prepare(
      `UPDATE log_issues
          SET fix_card_id = ?, fix_session_id = ?
        WHERE project_id = ? AND id = ?`,
    ).run(cardId, sessionId, projectId, issueId);
    return { claimed: true, cardId, sessionId, claimedAt };
  })();
}

/** Release a Fix claim and its issue link only if this request still owns it. */
export function releaseIssueFixSession(
  projectId: string,
  issueId: string,
  cardId: string,
  sessionId: string,
): void {
  const db = getLogsDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM log_issue_fix_claims
        WHERE project_id = ? AND issue_id = ? AND card_id = ? AND session_id = ?`,
    ).run(projectId, issueId, cardId, sessionId);
    db.prepare(
      `UPDATE log_issues
          SET fix_card_id = NULL, fix_session_id = NULL
        WHERE project_id = ? AND id = ? AND fix_card_id = ? AND fix_session_id = ?`,
    ).run(projectId, issueId, cardId, sessionId);
  })();
}

/** Check ownership immediately before publishing a Fix workflow. */
export function ownsIssueFixSessionClaim(
  projectId: string,
  issueId: string,
  cardId: string,
  sessionId: string,
): boolean {
  const row = getLogsDb()
    .prepare(
      `SELECT 1 FROM log_issue_fix_claims
        WHERE project_id = ? AND issue_id = ? AND card_id = ? AND session_id = ?`,
    )
    .get(projectId, issueId, cardId, sessionId) as { 1: number } | undefined;
  return Boolean(row);
}

/**
 * Lifecycle cleanup for a card/session that is no longer an active Fix. The
 * main Hub DB can delete/archive the row before logs.db is consulted, so these
 * helpers are best-effort and deliberately no-op when logs.db is unavailable
 * (for example during early boot or an isolated board test).
 */
function releaseIssueFixClaimsBy(column: 'card_id' | 'session_id', value: string): void {
  let db: Database.Database;
  try {
    db = getLogsDb();
  } catch {
    return;
  }
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT project_id, issue_id, card_id, session_id
           FROM log_issue_fix_claims WHERE ${column} = ?`,
      )
      .all(value) as Array<{
      project_id: string;
      issue_id: string;
      card_id: string;
      session_id: string;
    }>;
    const remove = db.prepare(
      `DELETE FROM log_issue_fix_claims
        WHERE project_id = ? AND issue_id = ? AND card_id = ? AND session_id = ?`,
    );
    const clear = db.prepare(
      `UPDATE log_issues
          SET fix_card_id = NULL, fix_session_id = NULL
        WHERE project_id = ? AND id = ? AND fix_card_id = ? AND fix_session_id = ?`,
    );
    for (const row of rows) {
      remove.run(row.project_id, row.issue_id, row.card_id, row.session_id);
      clear.run(row.project_id, row.issue_id, row.card_id, row.session_id);
    }
  })();
}

/** Clear Fix claims when a kanban card is deleted or reaches Done. */
export function releaseIssueFixClaimsForCard(cardId: string): void {
  releaseIssueFixClaimsBy('card_id', cardId);
}

/** Clear Fix claims when a linked chat session is archived/deleted. */
export function releaseIssueFixClaimsForSession(sessionId: string): void {
  releaseIssueFixClaimsBy('session_id', sessionId);
}

// ── Serialization ───────────────────────────────────────────────────────────

/**
 * Wire (camelCase) representation of an issue for the REST API.
 *
 * `firstSeen` / `lastSeen` stay in the record's native epoch **nanoseconds** —
 * the list cursor is `${last_seen}_${id}`, so rescaling them here would break
 * pagination. Clients convert with `shared/utils/logIssueTime#logIssueSeenMs`
 * before handing them to any Date formatter.
 */
export function serializeLogIssue(
  row: LogIssueRow,
  releases?: LogIssueReleaseRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    projectId: row.project_id,
    fingerprint: row.fingerprint,
    title: row.title,
    service: row.service,
    environment: row.environment,
    exceptionType: row.exception_type,
    messageTemplate: row.message_template,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    eventCount: row.event_count,
    status: row.status,
    statusUpdatedAt: row.status_updated_at,
    statusUpdatedBy: row.status_updated_by,
    firstRecordId: row.first_record_id,
    lastRecordId: row.last_record_id,
    analyzeSessionId: row.analyze_session_id,
    fixCardId: row.fix_card_id ?? null,
    fixSessionId: row.fix_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (releases) {
    out.releases = releases.map((r) => ({
      release: r.release || null,
      commitSha: r.commit_sha || null,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      eventCount: r.event_count,
    }));
  }
  return out;
}
