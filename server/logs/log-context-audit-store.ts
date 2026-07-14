/**
 * Audit trail for prompt-safe log context packs (decision LOG-TRUST: "Record
 * who launched each action and which redacted records were included").
 *
 * Every time an Analyze / Fix action builds a {@link LogContextPack} for an
 * agent, one row is persisted here: the acting Agent Hub user, the action, the
 * issue, and the exact record ids embedded in the redacted excerpt. The row
 * holds ids and counts only — never the redacted log text — so the audit store
 * stays small and never becomes a second copy of the log data.
 *
 * Agent-facing callers must go through `buildAuditedLogContextPack`
 * (`log-context-pack.ts`), which builds the pack and writes the audit row
 * together so the LOG-TRUST audit can't be skipped. `recordLogContextAudit`
 * here is the lower-level writer that seam uses.
 */
import { v4 as uuidv4 } from 'uuid';
import { getLogsDb } from './logs-db.js';

/** Actions that seed an agent with a log context pack. */
export type LogActionKind = 'analyze' | 'fix';

export interface LogActionAuditInput {
  projectId: string;
  issueId: string | null;
  action: LogActionKind;
  actorUserId: string | null;
  /** Record ids embedded in the redacted excerpt (from the built pack). */
  recordIds: number[];
  /** Byte size of the log-derived content in the pack. */
  contextBytes: number;
  /** Count of secrets masked while building the pack. */
  redactions?: number;
  /** Wall-clock ms. */
  nowMs: number;
}

export interface LogActionAuditRow {
  id: string;
  project_id: string;
  issue_id: string | null;
  action: string;
  actor_user_id: string | null;
  record_ids: string;
  record_count: number;
  context_bytes: number;
  redactions: number;
  created_at: number;
}

export interface LogActionAuditRecord {
  id: string;
  projectId: string;
  issueId: string | null;
  action: string;
  actorUserId: string | null;
  recordIds: number[];
  recordCount: number;
  contextBytes: number;
  redactions: number;
  createdAt: number;
}

/**
 * Persist an audit row for one context-pack build and return its record form.
 * `recordIds` is stored as a JSON array so the exact set is recoverable.
 */
export function recordLogContextAudit(input: LogActionAuditInput): LogActionAuditRecord {
  const id = uuidv4();
  const recordIds = input.recordIds.slice();
  const recordCount = recordIds.length;
  const redactions = input.redactions ?? 0;
  getLogsDb()
    .prepare(
      `INSERT INTO log_action_audit
         (id, project_id, issue_id, action, actor_user_id, record_ids,
          record_count, context_bytes, redactions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.issueId,
      input.action,
      input.actorUserId,
      JSON.stringify(recordIds),
      recordCount,
      input.contextBytes,
      redactions,
      input.nowMs,
    );
  return {
    id,
    projectId: input.projectId,
    issueId: input.issueId,
    action: input.action,
    actorUserId: input.actorUserId,
    recordIds,
    recordCount,
    contextBytes: input.contextBytes,
    redactions,
    createdAt: input.nowMs,
  };
}

function rowToRecord(row: LogActionAuditRow): LogActionAuditRecord {
  let recordIds: number[] = [];
  try {
    const parsed = JSON.parse(row.record_ids) as unknown;
    if (Array.isArray(parsed)) recordIds = parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    // Corrupt row — surface an empty id list rather than throwing.
  }
  return {
    id: row.id,
    projectId: row.project_id,
    issueId: row.issue_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    recordIds,
    recordCount: row.record_count,
    contextBytes: row.context_bytes,
    redactions: row.redactions,
    createdAt: row.created_at,
  };
}

/**
 * List context-pack audit rows for a project, newest-first. When `issueId` is
 * given, scoped to that issue.
 */
export function listLogContextAudit(
  projectId: string,
  issueId?: string | null,
  limit = 100,
): LogActionAuditRecord[] {
  const db = getLogsDb();
  const bounded = Math.max(1, Math.min(limit, 500));
  const rows = issueId
    ? (db
        .prepare(
          `SELECT * FROM log_action_audit
            WHERE project_id = ? AND issue_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, issueId, bounded) as LogActionAuditRow[])
    : (db
        .prepare(
          `SELECT * FROM log_action_audit
            WHERE project_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, bounded) as LogActionAuditRow[]);
  return rows.map(rowToRecord);
}
