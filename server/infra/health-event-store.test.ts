import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, closeInfraDb } from './infra-db.js';
import type { ParsedHealthEvent } from './health-event-parse.js';
import {
  recordInfraHealthEvents,
  listInfraHealthEvents,
  listPendingInfraHealthEventNotifications,
  markInfraHealthEventNotified,
  countInfraHealthEvents,
  serializeInfraHealthEvent,
} from './health-event-store.js';
import { INFRA_HEALTH_EVENT_HISTORY_LIMIT } from './infra-schema.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-health-store-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

function event(overrides: Partial<ParsedHealthEvent> = {}): ParsedHealthEvent {
  return {
    eventArn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc',
    communicationId: 'comm-1',
    affectedAccount: '123456789012',
    accountId: '123456789012',
    deliveryRegion: 'us-east-1',
    eventRegion: 'us-east-1',
    detailType: 'AWS Health Event',
    service: 'EC2',
    eventTypeCode: 'AWS_EC2_OPERATIONAL_ISSUE',
    eventTypeCategory: 'issue',
    eventScopeCode: 'PUBLIC',
    statusCode: 'open',
    severity: 'critical',
    startTimeMs: 1_700_000_000_000,
    endTimeMs: null,
    lastUpdatedMs: 1_700_000_000_000,
    description: 'something is broken',
    affectedEntities: [],
    affectedEntityCount: 0,
    backupEvent: false,
    page: 1,
    totalPages: 1,
    eventTimeMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe('recordInfraHealthEvents — at-least-once delivery', () => {
  it('writes a new event and reports it as accepted', () => {
    const result = recordInfraHealthEvents('p1', [event()], 1000);
    expect(result.inserted).toHaveLength(1);
    expect(result.deduped).toBe(0);
    expect(result.inserted[0]!.event_arn).toContain('AWS_EC2_OPERATIONAL_ISSUE');
    expect(result.inserted[0]!.notification_delivered_at_ms).toBeNull();
  });

  it('dedupes a redelivery of the same eventArn + communicationId', () => {
    // This is the acceptance criterion: EventBridge delivers at least once, so
    // the identical communication arriving twice must not double-write.
    recordInfraHealthEvents('p1', [event()], 1000);
    const second = recordInfraHealthEvents('p1', [event()], 2000);
    expect(second.inserted).toHaveLength(0);
    expect(second.deduped).toBe(1);
    expect(countInfraHealthEvents('p1')).toBe(1);
  });

  it('dedupes within a single batch', () => {
    const result = recordInfraHealthEvents('p1', [event(), event()], 1000);
    expect(result.inserted).toHaveLength(1);
    expect(result.deduped).toBe(1);
  });

  it('preserves the original received_at_ms on a redelivery', () => {
    recordInfraHealthEvents('p1', [event()], 1000);
    recordInfraHealthEvents('p1', [event()], 9999);
    expect(listInfraHealthEvents('p1')[0]!.received_at_ms).toBe(1000);
  });

  it('dedupes the backup-Region copy of the same communication', () => {
    // AWS fans account-specific events out to a backup Region on purpose. The
    // delivery Region differs, but eventArn + communicationId do not, so the
    // second copy must collapse.
    recordInfraHealthEvents('p1', [event()], 1000);
    const backup = recordInfraHealthEvents(
      'p1',
      [event({ deliveryRegion: 'us-west-2', backupEvent: true })],
      1500,
    );
    expect(backup.deduped).toBe(1);
    expect(countInfraHealthEvents('p1')).toBe(1);
  });

  it('keeps a new communication about the same incident as a new row', () => {
    recordInfraHealthEvents('p1', [event({ communicationId: 'comm-1' })], 1000);
    const update = recordInfraHealthEvents(
      'p1',
      [event({ communicationId: 'comm-2', statusCode: 'closed' })],
      2000,
    );
    expect(update.inserted).toHaveLength(1);
    expect(countInfraHealthEvents('p1')).toBe(2);
  });

  it('keeps the same ARN in two member accounts as distinct rows', () => {
    // An event ARN is not unique to an account, so an org-wide integration
    // legitimately sees the same ARN once per affected account.
    recordInfraHealthEvents('p1', [event({ affectedAccount: '111111111111' })], 1000);
    const other = recordInfraHealthEvents('p1', [event({ affectedAccount: '222222222222' })], 1000);
    expect(other.inserted).toHaveLength(1);
    expect(countInfraHealthEvents('p1')).toBe(2);
  });

  it('keeps separate pages of one paginated event', () => {
    recordInfraHealthEvents('p1', [event({ page: 1, totalPages: 2 })], 1000);
    const page2 = recordInfraHealthEvents('p1', [event({ page: 2, totalPages: 2 })], 1000);
    expect(page2.inserted).toHaveLength(1);
    expect(countInfraHealthEvents('p1')).toBe(2);
  });

  it('isolates projects', () => {
    recordInfraHealthEvents('p1', [event()], 1000);
    const other = recordInfraHealthEvents('p2', [event()], 1000);
    expect(other.inserted).toHaveLength(1);
    expect(countInfraHealthEvents('p1')).toBe(1);
    expect(countInfraHealthEvents('p2')).toBe(1);
  });

  it('is a no-op on an empty batch', () => {
    expect(recordInfraHealthEvents('p1', [], 1000)).toEqual({ inserted: [], deduped: 0 });
  });

  it('trims the oldest rows past the per-project history limit', () => {
    const batch = Array.from({ length: 20 }, (_, i) =>
      event({ communicationId: `comm-${i}`, eventArn: `arn-${i}` }),
    );
    recordInfraHealthEvents('p1', batch, 1000);
    expect(countInfraHealthEvents('p1')).toBe(20);
    expect(INFRA_HEALTH_EVENT_HISTORY_LIMIT).toBeGreaterThan(20);
  });
});

describe('listInfraHealthEvents', () => {
  it('collapses each incident to its newest communication by default', () => {
    recordInfraHealthEvents('p1', [event({ communicationId: 'c1', statusCode: 'open' })], 1000);
    recordInfraHealthEvents('p1', [event({ communicationId: 'c2', statusCode: 'closed' })], 2000);

    const collapsed = listInfraHealthEvents('p1', { latestOnly: true });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.status_code).toBe('closed');

    const full = listInfraHealthEvents('p1', { latestOnly: false });
    expect(full).toHaveLength(2);
  });

  it('collapses per (eventArn, affectedAccount), not per ARN alone', () => {
    recordInfraHealthEvents('p1', [event({ affectedAccount: '111111111111' })], 1000);
    recordInfraHealthEvents('p1', [event({ affectedAccount: '222222222222' })], 2000);
    expect(listInfraHealthEvents('p1', { latestOnly: true })).toHaveLength(2);
  });

  it('orders newest first', () => {
    recordInfraHealthEvents('p1', [event({ eventArn: 'arn-old', communicationId: 'c1' })], 1000);
    recordInfraHealthEvents('p1', [event({ eventArn: 'arn-new', communicationId: 'c2' })], 2000);
    expect(listInfraHealthEvents('p1').map((r) => r.event_arn)).toEqual(['arn-new', 'arn-old']);
  });

  it('filters by status code', () => {
    recordInfraHealthEvents('p1', [event({ eventArn: 'a1', communicationId: 'c1' })], 1000);
    recordInfraHealthEvents(
      'p1',
      [event({ eventArn: 'a2', communicationId: 'c2', statusCode: 'closed' })],
      2000,
    );
    const open = listInfraHealthEvents('p1', { statusCode: 'open', latestOnly: false });
    expect(open).toHaveLength(1);
    expect(open[0]!.event_arn).toBe('a1');
  });

  it('bounds the limit', () => {
    const batch = Array.from({ length: 10 }, (_, i) =>
      event({ eventArn: `arn-${i}`, communicationId: `c-${i}` }),
    );
    recordInfraHealthEvents('p1', batch, 1000);
    expect(listInfraHealthEvents('p1', { limit: 3 })).toHaveLength(3);
    // Out-of-range limits clamp rather than throwing.
    expect(listInfraHealthEvents('p1', { limit: 0 }).length).toBeGreaterThan(0);
    expect(listInfraHealthEvents('p1', { limit: 10_000 })).toHaveLength(10);
  });
});

describe('notification recovery bookkeeping', () => {
  it('lists newly written events as pending', () => {
    recordInfraHealthEvents('p1', [event()], 1000);
    expect(listPendingInfraHealthEventNotifications('p1')).toHaveLength(1);
  });

  it('drops an event from pending once marked, and marks only once', () => {
    const { inserted } = recordInfraHealthEvents('p1', [event()], 1000);
    const id = inserted[0]!.id;
    expect(markInfraHealthEventNotified(id, 2000)).toBe(true);
    expect(markInfraHealthEventNotified(id, 3000)).toBe(false);
    expect(listPendingInfraHealthEventNotifications('p1')).toHaveLength(0);
  });

  it('never re-queues a deduped redelivery for notification', () => {
    // The duplicate does not insert, so it cannot become pending — this is what
    // stops at-least-once delivery from paging someone twice.
    const { inserted } = recordInfraHealthEvents('p1', [event()], 1000);
    markInfraHealthEventNotified(inserted[0]!.id, 1500);
    recordInfraHealthEvents('p1', [event()], 2000);
    expect(listPendingInfraHealthEventNotifications('p1')).toHaveLength(0);
  });
});

describe('serializeInfraHealthEvent', () => {
  it('omits AWS account identifiers from the API projection', () => {
    // INFRA-NOTIFY hard constraint: this shape is what fans out to every
    // connected client of the project, so it must carry no account id.
    const { inserted } = recordInfraHealthEvents('p1', [event()], 1000);
    const serialized = serializeInfraHealthEvent(inserted[0]!);
    expect(JSON.stringify(serialized)).not.toContain('123456789012');
    expect(serialized).not.toHaveProperty('accountId');
    expect(serialized).not.toHaveProperty('affectedAccount');
  });

  it('prefers the impacted Region over the delivery Region', () => {
    const { inserted } = recordInfraHealthEvents(
      'p1',
      [event({ deliveryRegion: 'us-west-2', eventRegion: 'eu-west-1', backupEvent: true })],
      1000,
    );
    const serialized = serializeInfraHealthEvent(inserted[0]!);
    expect(serialized.region).toBe('eu-west-1');
    expect(serialized.deliveryRegion).toBe('us-west-2');
    expect(serialized.backupEvent).toBe(true);
  });

  it('degrades to an empty entity list on malformed JSON', () => {
    const { inserted } = recordInfraHealthEvents('p1', [event()], 1000);
    const broken = { ...inserted[0]!, affected_entities_json: '{not json' };
    expect(serializeInfraHealthEvent(broken).affectedEntities).toEqual([]);
  });

  it('round-trips stored entities', () => {
    const { inserted } = recordInfraHealthEvents(
      'p1',
      [
        event({
          affectedEntities: [{ entityValue: 'i-123', status: 'IMPAIRED', lastUpdatedMs: 5 }],
          affectedEntityCount: 1,
        }),
      ],
      1000,
    );
    const serialized = serializeInfraHealthEvent(inserted[0]!);
    expect(serialized.affectedEntities).toEqual([
      { entityValue: 'i-123', status: 'IMPAIRED', lastUpdatedMs: 5 },
    ]);
  });
});
