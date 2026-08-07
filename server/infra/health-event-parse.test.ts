import { describe, it, expect } from 'vitest';
import {
  parseHealthEvent,
  parseHealthEventBatch,
  healthEventSeverity,
  MAX_HEALTH_EVENT_BATCH,
} from './health-event-parse.js';
import {
  MAX_INFRA_HEALTH_AFFECTED_ENTITIES,
  MAX_INFRA_HEALTH_DESCRIPTION_CHARS,
} from './infra-schema.js';

/**
 * Verbatim from the AWS Health user guide's account-specific example
 * (EC2 instance retirement). Kept byte-faithful on purpose: the parser exists
 * to absorb AWS's actual shape, so the fixture must not be tidied up.
 */
function accountSpecificEvent(): Record<string, unknown> {
  return {
    version: '0',
    id: '7bf73129-1428-4cd3-a780-95db273d1602',
    'detail-type': 'AWS Health Event',
    source: 'aws.health',
    account: '123456789012',
    time: '2026-01-27T01:43:21Z',
    region: 'us-east-1',
    detail: {
      eventArn:
        'arn:aws:health:us-east-1::event/AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED_90353408594353983',
      service: 'EC2',
      eventTypeCode: 'AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED',
      eventTypeCategory: 'scheduledChange',
      eventScopeCode: 'ACCOUNT_SPECIFIC',
      communicationId: '1234abc01232a4012345678-1',
      startTime: 'Thu, 27 Aug 2026 13:19:03 GMT',
      lastUpdatedTime: 'Thu, 27 Jan 2026 13:44:13 GMT',
      statusCode: 'open',
      eventRegion: 'us-east-1',
      eventDescription: [{ language: 'en_US', latestDescription: 'A description of the event.' }],
      affectedEntities: [
        {
          entityValue: 'arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0',
          lastUpdatedTime: 'Thu, 26 Jan 2026 19:01:55 GMT',
          status: 'PENDING',
        },
      ],
      affectedAccount: '123456789012',
      page: '1',
      totalPages: '1',
      backupEvent: 'false',
    },
  };
}

/** Verbatim from the AWS public-event example (operational issue). */
function publicEvent(): Record<string, unknown> {
  return {
    version: '0',
    id: 'aaaaaaaa-1428-4cd3-a780-95db273d1602',
    'detail-type': 'AWS Health Event',
    source: 'aws.health',
    account: '123456789012',
    time: '2023-01-27T09:01:22Z',
    region: 'af-south-1',
    resources: [],
    detail: {
      eventArn:
        'arn:aws:health:af-south-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/AWS_EC2_OPERATIONAL_ISSUE_7f35',
      service: 'EC2',
      eventTypeCode: 'AWS_EC2_OPERATIONAL_ISSUE',
      eventTypeCategory: 'issue',
      eventScopeCode: 'PUBLIC',
      communicationId: '01b0993207d81a09dcd552ebd1e633e36cf1f09a-1',
      startTime: 'Fri, 27 Jan 2023 06:02:51 GMT',
      endTime: 'Fri, 27 Jan 2023 09:01:22 GMT',
      lastUpdatedTime: 'Fri, 27 Jan 2023 09:01:22 GMT',
      statusCode: 'open',
      eventRegion: 'af-south-1',
      eventDescription: [{ language: 'en_US', latestDescription: '[RESOLVED] recovery observed.' }],
      affectedEntities: [],
      page: '1',
      totalPages: '1',
      backupEvent: 'false',
      affectedAccount: '123456789012',
    },
  };
}

function expectOk(input: unknown) {
  const result = parseHealthEvent(input);
  if (!result.ok) throw new Error(`expected parse to succeed, got ${result.reason}`);
  return result.event;
}

describe('parseHealthEvent — AWS reference payloads', () => {
  it('normalizes the account-specific example', () => {
    const event = expectOk(accountSpecificEvent());
    expect(event.eventArn).toContain('AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED');
    expect(event.communicationId).toBe('1234abc01232a4012345678-1');
    expect(event.service).toBe('EC2');
    expect(event.eventTypeCategory).toBe('scheduledChange');
    expect(event.eventScopeCode).toBe('ACCOUNT_SPECIFIC');
    expect(event.statusCode).toBe('open');
    expect(event.affectedAccount).toBe('123456789012');
    expect(event.description).toBe('A description of the event.');
    expect(event.affectedEntities).toHaveLength(1);
    expect(event.affectedEntities[0]!.status).toBe('PENDING');
    expect(event.affectedEntityCount).toBe(1);
  });

  it('normalizes the public example, including endTime', () => {
    const event = expectOk(publicEvent());
    expect(event.eventScopeCode).toBe('PUBLIC');
    expect(event.eventTypeCategory).toBe('issue');
    expect(event.endTimeMs).toBe(Date.parse('Fri, 27 Jan 2023 09:01:22 GMT'));
    expect(event.affectedEntities).toEqual([]);
    expect(event.affectedEntityCount).toBe(0);
  });

  it('parses RFC-1123 detail timestamps and the ISO-8601 envelope time', () => {
    const event = expectOk(accountSpecificEvent());
    // AWS sends detail timestamps as RFC-1123, NOT ISO-8601. Regressing this
    // would silently null every date on the timeline.
    expect(event.startTimeMs).toBe(Date.parse('Thu, 27 Aug 2026 13:19:03 GMT'));
    expect(event.lastUpdatedMs).toBe(Date.parse('Thu, 27 Jan 2026 13:44:13 GMT'));
    expect(event.eventTimeMs).toBe(Date.parse('2026-01-27T01:43:21Z'));
  });

  it('reads page/totalPages/backupEvent from their STRING encodings', () => {
    const raw = accountSpecificEvent();
    (raw.detail as Record<string, unknown>).page = '2';
    (raw.detail as Record<string, unknown>).totalPages = '3';
    (raw.detail as Record<string, unknown>).backupEvent = 'true';
    const event = expectOk(raw);
    expect(event.page).toBe(2);
    expect(event.totalPages).toBe(3);
    expect(event.backupEvent).toBe(true);
  });

  it('keeps the delivery Region distinct from the impacted Region', () => {
    // The backup-Region fan-out delivers a us-east-1 event into us-west-2.
    const raw = accountSpecificEvent();
    raw.region = 'us-west-2';
    (raw.detail as Record<string, unknown>).backupEvent = 'true';
    const event = expectOk(raw);
    expect(event.deliveryRegion).toBe('us-west-2');
    expect(event.eventRegion).toBe('us-east-1');
    expect(event.backupEvent).toBe(true);
  });
});

describe('parseHealthEvent — rejection', () => {
  it('rejects a source that is not exactly aws.health', () => {
    // The code-side mirror of AWS's rule-pattern callout: a wildcard source
    // such as "aws.health*" never matches, so anything arriving under a
    // near-miss source is a misconfiguration, not a health event.
    for (const source of ['aws.health2', 'aws.healthx', 'aws.HEALTH', 'aws.ec2', '']) {
      const raw = accountSpecificEvent();
      raw.source = source;
      expect(parseHealthEvent(raw)).toEqual({ ok: false, reason: 'wrong-source' });
    }
  });

  it('rejects CloudTrail API-call events that share the aws.health source', () => {
    const raw = accountSpecificEvent();
    raw['detail-type'] = 'AWS API Call via CloudTrail';
    expect(parseHealthEvent(raw)).toEqual({ ok: false, reason: 'wrong-detail-type' });
  });

  it('accepts the abuse detail-type', () => {
    const raw = accountSpecificEvent();
    raw['detail-type'] = 'AWS Health Abuse Event';
    expect(expectOk(raw).detailType).toBe('AWS Health Abuse Event');
  });

  it.each([
    ['eventArn', 'missing-event-arn'],
    ['communicationId', 'missing-communication-id'],
    ['eventTypeCode', 'missing-event-type-code'],
  ])('rejects a payload missing detail.%s', (field, reason) => {
    const raw = accountSpecificEvent();
    delete (raw.detail as Record<string, unknown>)[field];
    expect(parseHealthEvent(raw)).toEqual({ ok: false, reason });
  });

  it('rejects a payload with no account or no detail', () => {
    const noAccount = accountSpecificEvent();
    delete noAccount.account;
    expect(parseHealthEvent(noAccount)).toEqual({ ok: false, reason: 'missing-account' });

    const noDetail = accountSpecificEvent();
    delete noDetail.detail;
    expect(parseHealthEvent(noDetail)).toEqual({ ok: false, reason: 'missing-detail' });
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'x', 42, []]) {
      expect(parseHealthEvent(value)).toEqual({ ok: false, reason: 'not-an-object' });
    }
  });
});

describe('parseHealthEvent — degrading rather than failing', () => {
  it('defaults affectedAccount to the delivering account', () => {
    // Never null: a NULL would defeat the SQLite UNIQUE dedupe, since SQLite
    // treats NULLs as distinct.
    const raw = accountSpecificEvent();
    delete (raw.detail as Record<string, unknown>).affectedAccount;
    expect(expectOk(raw).affectedAccount).toBe('123456789012');
  });

  it('tolerates a missing lastUpdatedTime, which AWS documents as required', () => {
    const raw = accountSpecificEvent();
    delete (raw.detail as Record<string, unknown>).lastUpdatedTime;
    expect(expectOk(raw).lastUpdatedMs).toBeNull();
  });

  it('nulls an unparseable timestamp instead of rejecting the event', () => {
    const raw = accountSpecificEvent();
    (raw.detail as Record<string, unknown>).startTime = 'not a date';
    expect(expectOk(raw).startTimeMs).toBeNull();
  });

  it('accepts the lowercase lastUpdatedtime spelling from the AWS schema table', () => {
    const raw = accountSpecificEvent();
    const entity = {
      entityValue: 'i-1',
      status: 'IMPAIRED',
      lastUpdatedtime: 'Thu, 26 Jan 2026 19:01:55 GMT',
    };
    (raw.detail as Record<string, unknown>).affectedEntities = [entity];
    expect(expectOk(raw).affectedEntities[0]!.lastUpdatedMs).toBe(
      Date.parse('Thu, 26 Jan 2026 19:01:55 GMT'),
    );
  });

  it('marks an absent category unknown and routes it as warning, not info', () => {
    // Must not default to the quietest category: that would silently downgrade
    // an event we merely failed to classify.
    const raw = accountSpecificEvent();
    delete (raw.detail as Record<string, unknown>).eventTypeCategory;
    const event = expectOk(raw);
    expect(event.eventTypeCategory).toBe('unknown');
    expect(event.severity).toBe('warning');
  });

  it('stores an unknown category verbatim and routes it as warning', () => {
    const raw = accountSpecificEvent();
    (raw.detail as Record<string, unknown>).eventTypeCategory = 'somethingNew';
    const event = expectOk(raw);
    expect(event.eventTypeCategory).toBe('somethingNew');
    expect(event.severity).toBe('warning');
  });

  it('falls back to the first description when AWS sends no en_US', () => {
    const raw = accountSpecificEvent();
    (raw.detail as Record<string, unknown>).eventDescription = [
      { language: 'ja_JP', latestDescription: 'japanese text' },
    ];
    expect(expectOk(raw).description).toBe('japanese text');
  });

  it('truncates an oversized description', () => {
    const raw = accountSpecificEvent();
    (raw.detail as Record<string, unknown>).eventDescription = [
      {
        language: 'en_US',
        latestDescription: 'x'.repeat(MAX_INFRA_HEALTH_DESCRIPTION_CHARS + 500),
      },
    ];
    const description = expectOk(raw).description as string;
    expect(description).toHaveLength(MAX_INFRA_HEALTH_DESCRIPTION_CHARS);
    expect(description.endsWith('…')).toBe(true);
  });

  it('caps stored entities while still reporting the true total', () => {
    const raw = accountSpecificEvent();
    (raw.detail as Record<string, unknown>).affectedEntities = Array.from(
      { length: MAX_INFRA_HEALTH_AFFECTED_ENTITIES + 20 },
      (_, i) => ({ entityValue: `i-${i}`, status: 'IMPAIRED' }),
    );
    const event = expectOk(raw);
    expect(event.affectedEntities).toHaveLength(MAX_INFRA_HEALTH_AFFECTED_ENTITIES);
    expect(event.affectedEntityCount).toBe(MAX_INFRA_HEALTH_AFFECTED_ENTITIES + 20);
  });

  it('skips entities with no entityValue', () => {
    const raw = accountSpecificEvent();
    (raw.detail as Record<string, unknown>).affectedEntities = [
      { status: 'IMPAIRED' },
      { entityValue: 'i-real', status: 'IMPAIRED' },
    ];
    expect(expectOk(raw).affectedEntities.map((e) => e.entityValue)).toEqual(['i-real']);
  });
});

describe('healthEventSeverity', () => {
  it('maps each documented category', () => {
    expect(healthEventSeverity('issue', 'open', 'AWS Health Event')).toBe('critical');
    expect(healthEventSeverity('scheduledChange', 'upcoming', 'AWS Health Event')).toBe('warning');
    expect(healthEventSeverity('investigation', 'open', 'AWS Health Event')).toBe('warning');
    expect(healthEventSeverity('accountNotification', 'open', 'AWS Health Event')).toBe('info');
  });

  it('downgrades a closed event to info whatever its category', () => {
    expect(healthEventSeverity('issue', 'closed', 'AWS Health Event')).toBe('info');
    expect(healthEventSeverity('scheduledChange', 'closed', 'AWS Health Event')).toBe('info');
  });

  it('keeps abuse events critical even once closed', () => {
    expect(healthEventSeverity('accountNotification', 'closed', 'AWS Health Abuse Event')).toBe(
      'critical',
    );
  });

  it('falls back to warning for an unrecognized category', () => {
    expect(healthEventSeverity('brandNew', 'open', 'AWS Health Event')).toBe('warning');
  });
});

describe('parseHealthEventBatch', () => {
  it('accepts a bare envelope, which is what an API destination sends', () => {
    const batch = parseHealthEventBatch(accountSpecificEvent());
    expect(batch.events).toHaveLength(1);
    expect(batch.rejected).toEqual([]);
    expect(batch.overflow).toBe(0);
  });

  it('accepts an array and reports per-entry rejection reasons', () => {
    const bad = accountSpecificEvent();
    bad.source = 'aws.ec2';
    const batch = parseHealthEventBatch([accountSpecificEvent(), bad, publicEvent()]);
    expect(batch.events).toHaveLength(2);
    expect(batch.rejected).toEqual([{ index: 1, reason: 'wrong-source' }]);
  });

  it('caps the batch and reports the overflow', () => {
    const batch = parseHealthEventBatch(
      Array.from({ length: MAX_HEALTH_EVENT_BATCH + 5 }, () => accountSpecificEvent()),
    );
    expect(batch.events).toHaveLength(MAX_HEALTH_EVENT_BATCH);
    expect(batch.overflow).toBe(5);
  });
});
