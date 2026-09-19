/**
 * Infra alert vocabulary. `resolved` closes; `ignored` mutes through recurrence;
 * reopen is `status: 'open'`. Derive offered actions here.
 */

export type InfraAlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
export type InfraAlertStatus = 'open' | 'resolved' | 'ignored';
export type InfraAlertSeverity = 'critical' | 'warning' | 'info';

export interface InfraAlertWire {
  id: string;
  projectId: string;
  ruleId: string;
  resourceKey: string;
  state: InfraAlarmState;
  reason: string | null;
  stateUpdatedAt: number;
  status: InfraAlertStatus;
  statusUpdatedAt: number;
  statusUpdatedBy: string | null;
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  lastValue: number | null;
  breachingDatapoints: number | null;
}

export interface InfraAlertAction {
  status: InfraAlertStatus;
  label: string;
  /** True for actions that end an alert's life, so a surface can style them. */
  terminal: boolean;
}

const RESOLVE: InfraAlertAction = { status: 'resolved', label: 'Resolve', terminal: true };
const IGNORE: InfraAlertAction = { status: 'ignored', label: 'Ignore', terminal: true };
const REOPEN: InfraAlertAction = { status: 'open', label: 'Reopen', terminal: false };

/** Transitions from a given status. Never offer the current status as an action. */
export function infraAlertActions(status: InfraAlertStatus): InfraAlertAction[] {
  switch (status) {
    case 'open':
      return [RESOLVE, IGNORE];
    case 'resolved':
      // Ignore stays available after resolve so recurrence can still be muted.
      return [REOPEN, IGNORE];
    case 'ignored':
      return [REOPEN, RESOLVE];
    default:
      return [];
  }
}

/** Display order for an alert list: loudest state first, then most recent. */
const STATE_RANK: Record<InfraAlarmState, number> = {
  ALARM: 0,
  INSUFFICIENT_DATA: 1,
  OK: 2,
};

const SEVERITY_RANK: Record<InfraAlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function infraAlarmStateRank(state: string | null | undefined): number {
  return STATE_RANK[state as InfraAlarmState] ?? STATE_RANK.OK;
}

export function infraSeverityRank(severity: string | null | undefined): number {
  return SEVERITY_RANK[severity as InfraAlertSeverity] ?? SEVERITY_RANK.info;
}

/** Human label for a state. The wire values are CloudWatch's, not ours. */
export function formatAlarmState(state: string | null | undefined): string {
  if (state === 'INSUFFICIENT_DATA') return 'No data';
  if (state === 'ALARM') return 'In alarm';
  if (state === 'OK') return 'OK';
  return 'Unknown';
}

export function formatAlertStatus(status: string | null | undefined): string {
  if (status === 'resolved') return 'Resolved';
  if (status === 'ignored') return 'Ignored';
  if (status === 'open') return 'Open';
  return 'Unknown';
}

/**
 * Join alerts to rules. A deleted rule yields nulls rather than dropping the alert.
 */
export interface InfraAlertRuleSummary {
  id: string;
  name: string;
  severity: InfraAlertSeverity;
  service: string | null;
  metricName: string | null;
}

export interface InfraAlertRow {
  alert: InfraAlertWire;
  rule: InfraAlertRuleSummary | null;
  severity: InfraAlertSeverity | null;
  ruleName: string | null;
}

export function joinAlertsToRules(
  alerts: readonly InfraAlertWire[],
  rules: ReadonlyArray<Partial<InfraAlertRuleSummary> & { id?: string }>,
): InfraAlertRow[] {
  const byId = new Map<string, InfraAlertRuleSummary>();
  for (const rule of rules) {
    if (!rule?.id) continue;
    byId.set(rule.id, {
      id: rule.id,
      name: rule.name ?? rule.id,
      severity: (rule.severity as InfraAlertSeverity) ?? 'info',
      service: rule.service ?? null,
      metricName: rule.metricName ?? null,
    });
  }
  return alerts.map((alert) => {
    const rule = byId.get(alert.ruleId) ?? null;
    return {
      alert,
      rule,
      severity: rule?.severity ?? null,
      ruleName: rule?.name ?? null,
    };
  });
}

/**
 * Sort for display: in-alarm first, then by severity, then most recently seen.
 *
 * Recency alone is the wrong lead — a chatty `OK` transition would push a
 * critical breach off the top of a phone screen, which is the one place there
 * is no room to scroll past it.
 */
export function sortAlertRows(rows: readonly InfraAlertRow[]): InfraAlertRow[] {
  return [...rows].sort((a, b) => {
    const stateDelta = infraAlarmStateRank(a.alert.state) - infraAlarmStateRank(b.alert.state);
    if (stateDelta !== 0) return stateDelta;
    const severityDelta = infraSeverityRank(a.severity) - infraSeverityRank(b.severity);
    if (severityDelta !== 0) return severityDelta;
    return b.alert.lastSeen - a.alert.lastSeen;
  });
}

/**
 * Whether a live `infra_alert_transition` broadcast concerns the list on screen.
 *
 * The broadcast fans out to every connected client of the project, so a screen
 * showing project A must ignore project B's transitions rather than refetching
 * on them.
 */
export function isInfraAlertEventForProject(
  event: { projectId?: string | null } | null | undefined,
  projectId: string | null | undefined,
): boolean {
  return Boolean(event && projectId && event.projectId === projectId);
}
