import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listReleaseDigestRecipients } from '../release-notification-settings.js';
import { enqueueInfraAlertEmail } from './alert-outbox.js';
import { resolveInfraAlertRouting } from './alert-routing-store.js';
import { notifyInfraAlertTransition } from './alert-notifications.js';

vi.mock('../release-notification-settings.js', () => ({
  listReleaseDigestRecipients: vi.fn(),
}));
vi.mock('./alert-outbox.js', () => ({
  enqueueInfraAlertEmail: vi.fn(),
}));
vi.mock('./alert-routing-store.js', () => ({
  resolveInfraAlertRouting: vi.fn(),
}));

const listRecipientsMock = vi.mocked(listReleaseDigestRecipients);
const enqueueEmailMock = vi.mocked(enqueueInfraAlertEmail);
const resolveRoutingMock = vi.mocked(resolveInfraAlertRouting);

describe('infrastructure alert notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRecipientsMock.mockReturnValue([]);
    resolveRoutingMock.mockReturnValue({
      projectId: 'project-a',
      severity: 'critical',
      channels: { in_app: true, push: true, email: true },
      isDefault: true,
      overrides: [],
    });
  });

  it('continues the broadcast and remaining recipients when email enqueueing fails', () => {
    listRecipientsMock.mockReturnValue([
      {
        id: 'recipient-1',
        projectId: 'project-a',
        email: 'first@example.com',
        displayLabel: null,
        enabled: true,
        createdBy: null,
        updatedBy: null,
        createdAt: '2026-08-06 12:00:00',
        updatedAt: '2026-08-06 12:00:00',
      },
      {
        id: 'recipient-2',
        projectId: 'project-a',
        email: 'second@example.com',
        displayLabel: null,
        enabled: true,
        createdBy: null,
        updatedBy: null,
        createdAt: '2026-08-06 12:00:00',
        updatedAt: '2026-08-06 12:00:00',
      },
    ]);
    enqueueEmailMock
      .mockImplementationOnce(() => {
        throw new Error('outbox unavailable');
      })
      .mockImplementation(() => undefined as never);

    const broadcast = { type: 'infra_alert_transition' };
    const result = notifyInfraAlertTransition({
      projectId: 'project-a',
      alertId: 'alert-a',
      transitionKey: 'alert-a:transition-1',
      severity: 'critical',
      resourceId: 'i-123',
      ruleName: 'CPU high',
      metricName: 'CPUUtilization',
      fromState: 'OK',
      toState: 'ALARM',
      reason: 'threshold exceeded',
      value: 99,
      broadcast,
    });

    expect(result).toEqual({ broadcast: true, emailsQueued: 1, emailEnqueueFailures: 1 });
    expect(enqueueEmailMock).toHaveBeenCalledTimes(2);
    expect(broadcast).toMatchObject({
      suppressPush: false,
      suppressWebSocket: false,
      broadcastChannel: 'infra_alert',
    });
  });

  it('broadcasts with safe severity defaults when routing resolution fails', () => {
    resolveRoutingMock.mockImplementation(() => {
      throw new Error('routing store unavailable');
    });

    const broadcast = { type: 'infra_alert_transition' };
    const result = notifyInfraAlertTransition({
      projectId: 'project-a',
      alertId: 'alert-a',
      transitionKey: 'alert-a:transition-2',
      severity: 'critical',
      resourceId: 'i-123',
      ruleName: 'CPU high',
      metricName: 'CPUUtilization',
      fromState: 'OK',
      toState: 'ALARM',
      reason: 'threshold exceeded',
      value: 99,
      broadcast,
    });

    expect(result).toEqual({ broadcast: true, emailsQueued: 0, emailEnqueueFailures: 0 });
    expect(broadcast).toMatchObject({
      suppressPush: false,
      suppressWebSocket: false,
      broadcastChannel: 'infra_alert',
    });
  });

  it('reports recipient lookup failures so recovery can retry email delivery', () => {
    listRecipientsMock.mockImplementation(() => {
      throw new Error('main db unavailable');
    });

    const result = notifyInfraAlertTransition({
      projectId: 'project-a',
      alertId: 'alert-a',
      transitionKey: 'alert-a:transition-3',
      severity: 'critical',
      resourceId: 'i-123',
      ruleName: 'CPU high',
      metricName: 'CPUUtilization',
      fromState: 'OK',
      toState: 'ALARM',
      reason: 'threshold exceeded',
      value: 99,
      broadcast: { type: 'infra_alert_transition' },
    });

    expect(result.emailEnqueueFailures).toBe(1);
  });
});
