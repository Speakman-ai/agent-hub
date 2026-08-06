import { describe, expect, it } from 'vitest';
import {
  formatAlarmState,
  formatAlertStatus,
  infraAlertActions,
  isInfraAlertEventForProject,
  joinAlertsToRules,
  sortAlertRows,
  type InfraAlertWire,
} from './infraAlerts';

function alert(overrides: Partial<InfraAlertWire> = {}): InfraAlertWire {
  return {
    id: 'alert-1',
    projectId: 'p1',
    ruleId: 'rule-1',
    resourceKey: '111122223333/us-east-1/ec2/i-abc',
    state: 'ALARM',
    reason: null,
    stateUpdatedAt: 1000,
    status: 'open',
    statusUpdatedAt: 1000,
    statusUpdatedBy: null,
    firstSeen: 1000,
    lastSeen: 1000,
    occurrenceCount: 1,
    lastValue: null,
    breachingDatapoints: null,
    ...overrides,
  };
}

describe('infraAlertActions', () => {
  it('never offers the status the alert is already in', () => {
    for (const status of ['open', 'resolved', 'ignored'] as const) {
      const offered = infraAlertActions(status).map((a) => a.status);
      expect(offered).not.toContain(status);
    }
  });

  it('offers resolve and ignore on an open alert', () => {
    expect(infraAlertActions('open').map((a) => a.status)).toEqual(['resolved', 'ignored']);
  });

  it('offers reopen from both terminal statuses', () => {
    expect(infraAlertActions('resolved').map((a) => a.status)).toContain('open');
    expect(infraAlertActions('ignored').map((a) => a.status)).toContain('open');
  });

  it('keeps ignore reachable from resolved, since a resolved alert can recur', () => {
    expect(infraAlertActions('resolved').map((a) => a.status)).toContain('ignored');
  });
});

describe('joinAlertsToRules', () => {
  it('attaches the rule name and severity the alert row does not carry', () => {
    const [row] = joinAlertsToRules(
      [alert()],
      [{ id: 'rule-1', name: 'CPU high', severity: 'critical', service: 'ec2' }],
    );
    expect(row.ruleName).toBe('CPU high');
    expect(row.severity).toBe('critical');
  });

  it('keeps an alert whose rule was deleted rather than dropping the history', () => {
    const rows = joinAlertsToRules([alert()], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].ruleName).toBeNull();
    expect(rows[0].severity).toBeNull();
  });

  it('defaults a rule with no severity to info instead of undefined', () => {
    const [row] = joinAlertsToRules([alert()], [{ id: 'rule-1', name: 'Something' }]);
    expect(row.severity).toBe('info');
  });
});

describe('sortAlertRows', () => {
  it('leads with in-alarm rows even when an OK row is more recent', () => {
    const rows = joinAlertsToRules(
      [
        alert({ id: 'ok', state: 'OK', lastSeen: 9999 }),
        alert({ id: 'alarm', state: 'ALARM', lastSeen: 1 }),
      ],
      [{ id: 'rule-1', name: 'r', severity: 'info' }],
    );
    expect(sortAlertRows(rows).map((r) => r.alert.id)).toEqual(['alarm', 'ok']);
  });

  it('ranks critical above warning within the same state', () => {
    const rows = joinAlertsToRules(
      [
        alert({ id: 'warn', ruleId: 'w', lastSeen: 5000 }),
        alert({ id: 'crit', ruleId: 'c', lastSeen: 1 }),
      ],
      [
        { id: 'w', name: 'warn rule', severity: 'warning' },
        { id: 'c', name: 'crit rule', severity: 'critical' },
      ],
    );
    expect(sortAlertRows(rows).map((r) => r.alert.id)).toEqual(['crit', 'warn']);
  });

  it('falls back to most recently seen when state and severity tie', () => {
    const rows = joinAlertsToRules(
      [alert({ id: 'old', lastSeen: 1 }), alert({ id: 'new', lastSeen: 9999 })],
      [{ id: 'rule-1', name: 'r', severity: 'info' }],
    );
    expect(sortAlertRows(rows).map((r) => r.alert.id)).toEqual(['new', 'old']);
  });

  it('does not mutate the input array', () => {
    const rows = joinAlertsToRules(
      [alert({ id: 'a', state: 'OK' }), alert({ id: 'b', state: 'ALARM' })],
      [],
    );
    const order = rows.map((r) => r.alert.id);
    sortAlertRows(rows);
    expect(rows.map((r) => r.alert.id)).toEqual(order);
  });
});

describe('isInfraAlertEventForProject', () => {
  it('accepts a transition on the project on screen', () => {
    expect(isInfraAlertEventForProject({ projectId: 'p1' }, 'p1')).toBe(true);
  });

  it('ignores another project on the shared socket', () => {
    expect(isInfraAlertEventForProject({ projectId: 'p2' }, 'p1')).toBe(false);
  });

  it('ignores a missing event or an unresolved project', () => {
    expect(isInfraAlertEventForProject(null, 'p1')).toBe(false);
    expect(isInfraAlertEventForProject({ projectId: 'p1' }, null)).toBe(false);
    expect(isInfraAlertEventForProject({}, 'p1')).toBe(false);
  });
});

describe('labels', () => {
  it('names CloudWatch states in words an operator reads', () => {
    expect(formatAlarmState('ALARM')).toBe('In alarm');
    expect(formatAlarmState('INSUFFICIENT_DATA')).toBe('No data');
    expect(formatAlarmState('OK')).toBe('OK');
    expect(formatAlarmState(null)).toBe('Unknown');
  });

  it('names lifecycle statuses', () => {
    expect(formatAlertStatus('open')).toBe('Open');
    expect(formatAlertStatus('resolved')).toBe('Resolved');
    expect(formatAlertStatus('ignored')).toBe('Ignored');
    expect(formatAlertStatus(undefined)).toBe('Unknown');
  });
});
