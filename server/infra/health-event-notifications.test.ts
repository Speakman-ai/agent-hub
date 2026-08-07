import { describe, it, expect, vi, beforeEach } from 'vitest';

const listReleaseDigestRecipients = vi.fn();
const enqueueInfraAlertEmail = vi.fn();
const resolveInfraAlertRouting = vi.fn();

vi.mock('../release-notification-settings.js', () => ({
  listReleaseDigestRecipients: (...args: unknown[]) => listReleaseDigestRecipients(...args),
}));
vi.mock('./alert-outbox.js', () => ({
  enqueueInfraAlertEmail: (...args: unknown[]) => enqueueInfraAlertEmail(...args),
}));
vi.mock('./alert-routing-store.js', () => ({
  resolveInfraAlertRouting: (...args: unknown[]) => resolveInfraAlertRouting(...args),
}));

const {
  notifyInfraHealthEvent,
  buildHealthEventBroadcast,
  healthNotificationKey,
  healthEventHeadline,
} = await import('./health-event-notifications.js');
type Row = import('./health-event-store.js').InfraHealthEventRow;

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'evt-1',
    project_id: 'p1',
    event_arn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc',
    communication_id: 'comm-1',
    affected_account: '123456789012',
    account_id: '123456789012',
    delivery_region: 'us-east-1',
    event_region: 'us-east-1',
    detail_type: 'AWS Health Event',
    service: 'EC2',
    event_type_code: 'AWS_EC2_OPERATIONAL_ISSUE',
    event_type_category: 'issue',
    event_scope_code: 'PUBLIC',
    status_code: 'open',
    severity: 'critical',
    start_time_ms: 1_700_000_000_000,
    end_time_ms: null,
    last_updated_ms: null,
    description: 'EC2 is having a bad day',
    affected_entities_json: null,
    affected_entity_count: 3,
    backup_event: 0,
    page: 1,
    total_pages: 1,
    event_time_ms: null,
    received_at_ms: 1_700_000_000_000,
    notification_delivered_at_ms: null,
    ...overrides,
  };
}

function channels(over: Partial<Record<'in_app' | 'push' | 'email', boolean>> = {}) {
  return { channels: { in_app: true, push: true, email: true, ...over } };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveInfraAlertRouting.mockReturnValue(channels());
  listReleaseDigestRecipients.mockReturnValue([]);
});

describe('buildHealthEventBroadcast', () => {
  it('never leaks an AWS account id', () => {
    // INFRA-NOTIFY hard constraint: broadcasts fan out to every connected
    // client of the project, so they carry resource identifiers only.
    const payload = buildHealthEventBroadcast(row());
    expect(JSON.stringify(payload)).not.toContain('123456789012');
    expect(payload).not.toHaveProperty('accountId');
    expect(payload).not.toHaveProperty('affectedAccount');
  });

  it('uses a discriminated type the client can route on', () => {
    expect(buildHealthEventBroadcast(row()).type).toBe('infra_health_event');
  });
});

describe('healthNotificationKey', () => {
  it('is stable per communication, which makes the email outbox idempotent', () => {
    expect(healthNotificationKey(row())).toBe(
      'health:arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc:comm-1',
    );
    expect(healthNotificationKey(row({ communication_id: 'comm-2' }))).not.toBe(
      healthNotificationKey(row()),
    );
  });
});

describe('notifyInfraHealthEvent — routing', () => {
  it('resolves routing by the event severity', () => {
    notifyInfraHealthEvent(row({ severity: 'warning' }), {});
    expect(resolveInfraAlertRouting).toHaveBeenCalledWith('p1', 'warning');
  });

  it('stamps both suppression flags when every channel is on', () => {
    const payload: Record<string, unknown> = {};
    const result = notifyInfraHealthEvent(row(), payload);
    expect(result.broadcast).toBe(true);
    expect(payload.suppressPush).toBe(false);
    expect(payload.suppressWebSocket).toBe(false);
    expect(payload.broadcastChannel).toBe('infra_alert');
  });

  it('suppresses push while still reaching browsers when push is off', () => {
    const payload: Record<string, unknown> = {};
    resolveInfraAlertRouting.mockReturnValue(channels({ push: false }));
    expect(notifyInfraHealthEvent(row(), payload).broadcast).toBe(true);
    expect(payload.suppressPush).toBe(true);
    expect(payload.suppressWebSocket).toBe(false);
  });

  it('supports push-only routing', () => {
    const payload: Record<string, unknown> = {};
    resolveInfraAlertRouting.mockReturnValue(channels({ in_app: false }));
    expect(notifyInfraHealthEvent(row(), payload).broadcast).toBe(true);
    expect(payload.suppressWebSocket).toBe(true);
    expect(payload.suppressPush).toBe(false);
  });

  it('does not broadcast when both live channels are off', () => {
    const payload: Record<string, unknown> = {};
    resolveInfraAlertRouting.mockReturnValue(
      channels({ in_app: false, push: false, email: false }),
    );
    expect(notifyInfraHealthEvent(row(), payload).broadcast).toBe(false);
    expect(payload).not.toHaveProperty('broadcastChannel');
  });

  it('falls back to severity defaults when the routing store throws', () => {
    resolveInfraAlertRouting.mockImplementation(() => {
      throw new Error('store down');
    });
    // `critical` defaults to every channel, so the event must still go out.
    const payload: Record<string, unknown> = {};
    expect(notifyInfraHealthEvent(row({ severity: 'critical' }), payload).broadcast).toBe(true);
    expect(payload.suppressWebSocket).toBe(false);
  });

  it('falls back correctly for info, which defaults to in-app only', () => {
    resolveInfraAlertRouting.mockImplementation(() => {
      throw new Error('store down');
    });
    const payload: Record<string, unknown> = {};
    notifyInfraHealthEvent(row({ severity: 'info' }), payload);
    expect(payload.suppressPush).toBe(true);
    expect(payload.suppressWebSocket).toBe(false);
  });
});

describe('notifyInfraHealthEvent — email', () => {
  it('enqueues one email per enabled recipient, keyed for idempotency', () => {
    listReleaseDigestRecipients.mockReturnValue([
      { email: 'a@example.com', enabled: true },
      { email: 'muted@example.com', enabled: false },
      { email: 'b@example.com', enabled: true },
    ]);
    const result = notifyInfraHealthEvent(row(), {});
    expect(result.emailsQueued).toBe(2);
    expect(enqueueInfraAlertEmail).toHaveBeenCalledTimes(2);
    const [first] = enqueueInfraAlertEmail.mock.calls[0] as [Record<string, unknown>];
    expect(first.transitionKey).toBe(healthNotificationKey(row()));
    expect(first.projectId).toBe('p1');
    expect(first.severity).toBe('critical');
    expect(first.subject).toContain('AWS Health');
  });

  it('skips email entirely when the channel is off', () => {
    resolveInfraAlertRouting.mockReturnValue(channels({ email: false }));
    listReleaseDigestRecipients.mockReturnValue([{ email: 'a@example.com', enabled: true }]);
    expect(notifyInfraHealthEvent(row(), {}).emailsQueued).toBe(0);
    expect(enqueueInfraAlertEmail).not.toHaveBeenCalled();
  });

  it('one failing recipient does not suppress the others or the broadcast', () => {
    listReleaseDigestRecipients.mockReturnValue([
      { email: 'bad@example.com', enabled: true },
      { email: 'good@example.com', enabled: true },
    ]);
    enqueueInfraAlertEmail.mockImplementationOnce(() => {
      throw new Error('outbox down');
    });
    const result = notifyInfraHealthEvent(row(), {});
    expect(result.emailsQueued).toBe(1);
    expect(result.emailEnqueueFailures).toBe(1);
    expect(result.broadcast).toBe(true);
  });

  it('records a failure when the recipient lookup itself throws', () => {
    listReleaseDigestRecipients.mockImplementation(() => {
      throw new Error('main db not initialized');
    });
    const result = notifyInfraHealthEvent(row(), {});
    expect(result.emailEnqueueFailures).toBe(1);
    // Still broadcasts — a hermetic infra worker must not lose the live event.
    expect(result.broadcast).toBe(true);
  });

  it('body carries the description and entity count', () => {
    listReleaseDigestRecipients.mockReturnValue([{ email: 'a@example.com', enabled: true }]);
    notifyInfraHealthEvent(row(), {});
    const [call] = enqueueInfraAlertEmail.mock.calls[0] as [{ bodyText: string }];
    expect(call.bodyText).toContain('EC2 is having a bad day');
    expect(call.bodyText).toContain('Affected entities: 3');
  });
});

describe('healthEventHeadline', () => {
  it('names the service, event code, and impacted Region', () => {
    expect(healthEventHeadline(row())).toBe('EC2 AWS_EC2_OPERATIONAL_ISSUE (us-east-1)');
  });

  it('falls back to the delivery Region and a generic service', () => {
    expect(healthEventHeadline(row({ service: null, event_region: null }))).toBe(
      'AWS AWS_EC2_OPERATIONAL_ISSUE (us-east-1)',
    );
  });
});
