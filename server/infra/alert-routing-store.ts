/**
 * Project-scoped alert channel routing.
 *
 * Rows are overrides, not a materialized copy of the defaults.  This keeps a
 * missing row meaningful and makes the setting safe to extend when a new
 * severity or channel is added.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_INFRA_ALERT_CHANNELS,
  INFRA_ALERT_CHANNELS,
  INFRA_ALERT_SEVERITIES,
  type InfraAlertChannel,
  type InfraAlertSeverity,
} from './infra-schema.js';
import { getInfraDb } from './infra-db.js';

export interface InfraAlertRoutingRow {
  id: string;
  project_id: string;
  severity: InfraAlertSeverity;
  channel: InfraAlertChannel;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ResolvedInfraAlertRouting {
  projectId: string;
  severity: InfraAlertSeverity;
  channels: Record<InfraAlertChannel, boolean>;
  isDefault: boolean;
  overrides: InfraAlertRoutingRow[];
}

export interface InfraAlertRoutingEntry {
  severity: InfraAlertSeverity;
  channel: InfraAlertChannel;
  enabled: boolean;
}

function isSeverity(value: string): value is InfraAlertSeverity {
  return (INFRA_ALERT_SEVERITIES as readonly string[]).includes(value);
}

function isChannel(value: string): value is InfraAlertChannel {
  return (INFRA_ALERT_CHANNELS as readonly string[]).includes(value);
}

export function listInfraAlertRouting(projectId: string): InfraAlertRoutingRow[] {
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_routing
       WHERE project_id = ?
       ORDER BY severity, channel`,
    )
    .all(projectId) as InfraAlertRoutingRow[];
}

export function resolveInfraAlertRouting(
  projectId: string,
  severity: InfraAlertSeverity,
): ResolvedInfraAlertRouting {
  const stored = listInfraAlertRouting(projectId).filter((row) => row.severity === severity);
  const channels = Object.fromEntries(
    INFRA_ALERT_CHANNELS.map((channel) => [
      channel,
      DEFAULT_INFRA_ALERT_CHANNELS[severity].includes(channel),
    ]),
  ) as Record<InfraAlertChannel, boolean>;
  for (const row of stored) {
    if (isChannel(row.channel)) channels[row.channel] = row.enabled === 1;
  }
  return {
    projectId,
    severity,
    channels,
    isDefault: stored.length === 0,
    overrides: stored,
  };
}

export function resolveAllInfraAlertRouting(projectId: string): ResolvedInfraAlertRouting[] {
  return INFRA_ALERT_SEVERITIES.map((severity) => resolveInfraAlertRouting(projectId, severity));
}

export function upsertInfraAlertRouting(
  projectId: string,
  input: InfraAlertRoutingEntry,
  nowMs = Date.now(),
): InfraAlertRoutingRow {
  if (!isSeverity(input.severity) || !isChannel(input.channel)) {
    throw new Error('Invalid infrastructure alert routing key');
  }
  const existing = getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_routing
       WHERE project_id = ? AND severity = ? AND channel = ?`,
    )
    .get(projectId, input.severity, input.channel) as InfraAlertRoutingRow | undefined;
  getInfraDb()
    .prepare(
      `INSERT INTO infra_alert_routing
         (id, project_id, severity, channel, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, severity, channel) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(
      existing?.id ?? randomUUID(),
      projectId,
      input.severity,
      input.channel,
      input.enabled ? 1 : 0,
      existing?.created_at ?? nowMs,
      nowMs,
    );
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_routing
       WHERE project_id = ? AND severity = ? AND channel = ?`,
    )
    .get(projectId, input.severity, input.channel) as InfraAlertRoutingRow;
}

export function deleteInfraAlertRouting(
  projectId: string,
  severity: InfraAlertSeverity,
  channel: InfraAlertChannel,
): boolean {
  return (
    getInfraDb()
      .prepare(
        `DELETE FROM infra_alert_routing
         WHERE project_id = ? AND severity = ? AND channel = ?`,
      )
      .run(projectId, severity, channel).changes > 0
  );
}
