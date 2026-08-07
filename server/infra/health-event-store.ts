/**
 * Persistence for AWS Health events ingested from EventBridge.
 *
 * The whole module exists to make at-least-once delivery safe. EventBridge
 * documents delivery as "at least once", and AWS Health additionally fans
 * account-specific events out to a backup Region on purpose, so the same
 * communication arriving twice is the normal case. Every write therefore goes
 * through the `UNIQUE (project_id, event_arn, communication_id,
 * affected_account, page)` constraint with `DO NOTHING`, and the caller learns
 * how many rows were suppressed rather than how many it sent.
 *
 * `DO NOTHING` rather than `DO UPDATE` is deliberate: a redelivered
 * communication is byte-identical to the first, so there is nothing to update,
 * and preserving the original `received_at_ms` keeps the timeline honest about
 * when the Hub first learned of the event. Genuine updates to an incident
 * arrive as a NEW communicationId under the same eventArn, which inserts a new
 * row — history accumulates and {@link listInfraHealthEvents} collapses it.
 */
import { randomUUID } from 'node:crypto';
import { getInfraDb } from './infra-db.js';
import type { ParsedHealthEvent } from './health-event-parse.js';
import {
  DEFAULT_INFRA_HEALTH_EVENT_LIST_LIMIT,
  INFRA_HEALTH_EVENT_HISTORY_LIMIT,
  MAX_INFRA_HEALTH_EVENT_LIST_LIMIT,
  type InfraAlertSeverity,
} from './infra-schema.js';

export interface InfraHealthEventRow {
  id: string;
  project_id: string;
  event_arn: string;
  communication_id: string;
  affected_account: string;
  account_id: string;
  delivery_region: string;
  event_region: string | null;
  detail_type: string;
  service: string | null;
  event_type_code: string;
  event_type_category: string;
  event_scope_code: string | null;
  status_code: string | null;
  severity: InfraAlertSeverity;
  start_time_ms: number | null;
  end_time_ms: number | null;
  last_updated_ms: number | null;
  description: string | null;
  affected_entities_json: string | null;
  affected_entity_count: number;
  backup_event: number;
  page: number;
  total_pages: number;
  event_time_ms: number | null;
  received_at_ms: number;
  notification_delivered_at_ms: number | null;
}

export interface RecordHealthEventsResult {
  /** Rows newly written. Only these are eligible to notify. */
  inserted: InfraHealthEventRow[];
  /** Deliveries suppressed by the dedupe constraint. */
  deduped: number;
}

const INSERT_SQL = `
  INSERT INTO infra_health_events (
    id, project_id, event_arn, communication_id, affected_account, account_id,
    delivery_region, event_region, detail_type, service, event_type_code,
    event_type_category, event_scope_code, status_code, severity,
    start_time_ms, end_time_ms, last_updated_ms, description,
    affected_entities_json, affected_entity_count, backup_event,
    page, total_pages, event_time_ms, received_at_ms, notification_delivered_at_ms
  ) VALUES (
    @id, @project_id, @event_arn, @communication_id, @affected_account, @account_id,
    @delivery_region, @event_region, @detail_type, @service, @event_type_code,
    @event_type_category, @event_scope_code, @status_code, @severity,
    @start_time_ms, @end_time_ms, @last_updated_ms, @description,
    @affected_entities_json, @affected_entity_count, @backup_event,
    @page, @total_pages, @event_time_ms, @received_at_ms, NULL
  )
  ON CONFLICT (project_id, event_arn, communication_id, affected_account, page)
  DO NOTHING
  RETURNING *
`;

/**
 * Trim the project's oldest events once it exceeds the history limit.
 *
 * The retention reaper deliberately owns `infra_metric_points` and nothing
 * else, so this table bounds itself at the one moment its row count is already
 * being touched — the same approach `infra_alert_transitions` takes.
 */
function trimProjectHistory(projectId: string): number {
  const result = getInfraDb()
    .prepare(
      `DELETE FROM infra_health_events
        WHERE id IN (
          SELECT id FROM infra_health_events
           WHERE project_id = ?
           ORDER BY received_at_ms DESC, id DESC
           LIMIT -1 OFFSET ?
        )`,
    )
    .run(projectId, INFRA_HEALTH_EVENT_HISTORY_LIMIT);
  return result.changes;
}

/**
 * Persist a delivery. Returns only the rows that were actually new, so a
 * duplicate delivery can never trigger a second notification.
 */
export function recordInfraHealthEvents(
  projectId: string,
  events: readonly ParsedHealthEvent[],
  nowMs: number = Date.now(),
): RecordHealthEventsResult {
  if (events.length === 0) return { inserted: [], deduped: 0 };
  const db = getInfraDb();
  const stmt = db.prepare(INSERT_SQL);

  const run = db.transaction((batch: readonly ParsedHealthEvent[]) => {
    const inserted: InfraHealthEventRow[] = [];
    for (const event of batch) {
      const row = stmt.get({
        id: randomUUID(),
        project_id: projectId,
        event_arn: event.eventArn,
        communication_id: event.communicationId,
        affected_account: event.affectedAccount,
        account_id: event.accountId,
        delivery_region: event.deliveryRegion,
        event_region: event.eventRegion,
        detail_type: event.detailType,
        service: event.service,
        event_type_code: event.eventTypeCode,
        event_type_category: event.eventTypeCategory,
        event_scope_code: event.eventScopeCode,
        status_code: event.statusCode,
        severity: event.severity,
        start_time_ms: event.startTimeMs,
        end_time_ms: event.endTimeMs,
        last_updated_ms: event.lastUpdatedMs,
        description: event.description,
        affected_entities_json:
          event.affectedEntities.length > 0 ? JSON.stringify(event.affectedEntities) : null,
        affected_entity_count: event.affectedEntityCount,
        backup_event: event.backupEvent ? 1 : 0,
        page: event.page,
        total_pages: event.totalPages,
        event_time_ms: event.eventTimeMs,
        received_at_ms: nowMs,
      }) as InfraHealthEventRow | undefined;
      // `RETURNING` yields nothing when `DO NOTHING` suppressed the insert —
      // that absence IS the duplicate signal.
      if (row) inserted.push(row);
    }
    if (inserted.length > 0) trimProjectHistory(projectId);
    return inserted;
  });

  const inserted = run(events);
  return { inserted, deduped: events.length - inserted.length };
}

export interface ListInfraHealthEventsOptions {
  limit?: number;
  /**
   * Collapse each incident to its newest communication. This is what the
   * Overview timeline wants: one row per incident showing its current status,
   * not one row per update AWS published about it.
   */
  latestOnly?: boolean;
  /** Restrict to a lifecycle (`open` / `closed` / `upcoming`). */
  statusCode?: string;
}

function boundedLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_INFRA_HEALTH_EVENT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_INFRA_HEALTH_EVENT_LIST_LIMIT, Math.floor(limit as number)));
}

export function listInfraHealthEvents(
  projectId: string,
  options: ListInfraHealthEventsOptions = {},
): InfraHealthEventRow[] {
  const limit = boundedLimit(options.limit);
  const filters: string[] = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (options.statusCode) {
    filters.push('status_code = ?');
    params.push(options.statusCode);
  }

  // The collapse picks the newest row per incident by received_at_ms, tie-broken
  // on id so the choice is deterministic when two pages of the same event land
  // inside the same millisecond.
  const where = filters.join(' AND ');
  const sql = options.latestOnly
    ? `SELECT * FROM infra_health_events e
        WHERE ${where}
          AND e.id = (
            SELECT id FROM infra_health_events x
             WHERE x.project_id = e.project_id
               AND x.event_arn = e.event_arn
               AND x.affected_account = e.affected_account
             ORDER BY x.received_at_ms DESC, x.id DESC
             LIMIT 1
          )
        ORDER BY e.received_at_ms DESC, e.id DESC
        LIMIT ?`
    : `SELECT * FROM infra_health_events
        WHERE ${where}
        ORDER BY received_at_ms DESC, id DESC
        LIMIT ?`;

  return getInfraDb()
    .prepare(sql)
    .all(...params, limit) as InfraHealthEventRow[];
}

/**
 * Events written but never fanned out, oldest first.
 *
 * Mirrors `listPendingInfraAlertTransitions`: it makes an ingested event
 * recoverable after a crash between the database write and the notification.
 */
export function listPendingInfraHealthEventNotifications(
  projectId: string,
  limit = 100,
): InfraHealthEventRow[] {
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_health_events
        WHERE project_id = ? AND notification_delivered_at_ms IS NULL
        ORDER BY id
        LIMIT ?`,
    )
    .all(projectId, boundedLimit(limit)) as InfraHealthEventRow[];
}

export function markInfraHealthEventNotified(id: string, nowMs: number = Date.now()): boolean {
  const result = getInfraDb()
    .prepare(
      `UPDATE infra_health_events
          SET notification_delivered_at_ms = ?
        WHERE id = ? AND notification_delivered_at_ms IS NULL`,
    )
    .run(nowMs, id);
  return result.changes > 0;
}

export function countInfraHealthEvents(projectId: string): number {
  const row = getInfraDb()
    .prepare(`SELECT COUNT(*) AS n FROM infra_health_events WHERE project_id = ?`)
    .get(projectId) as { n: number };
  return row.n;
}

function parseEntities(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Degrade rather than fail the list read; the entity list is decoration.
    return [];
  }
}

/**
 * API projection.
 *
 * `account_id` and `affected_account` are intentionally omitted. Health event
 * broadcasts fan out to every connected client of the project (INFRA-NOTIFY's
 * hard constraint), and an AWS account id is account-identifying.
 */
export function serializeInfraHealthEvent(row: InfraHealthEventRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    eventArn: row.event_arn,
    communicationId: row.communication_id,
    region: row.event_region ?? row.delivery_region,
    deliveryRegion: row.delivery_region,
    detailType: row.detail_type,
    service: row.service,
    eventTypeCode: row.event_type_code,
    eventTypeCategory: row.event_type_category,
    eventScopeCode: row.event_scope_code,
    statusCode: row.status_code,
    severity: row.severity,
    startTime: row.start_time_ms,
    endTime: row.end_time_ms,
    lastUpdated: row.last_updated_ms,
    description: row.description,
    affectedEntities: parseEntities(row.affected_entities_json),
    affectedEntityCount: row.affected_entity_count,
    backupEvent: row.backup_event === 1,
    page: row.page,
    totalPages: row.total_pages,
    eventTime: row.event_time_ms,
    receivedAt: row.received_at_ms,
  };
}
