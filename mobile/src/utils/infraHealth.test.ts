import { describe, expect, it } from 'vitest';

import {
  HEALTH_CLAMP_CHARS,
  INGEST_SETUP_NOTE,
  TOKEN_ONCE_WARNING,
  affectedEntityLabel,
  formatEventPattern,
  formatHealthStatus,
  healthEmptyState,
  healthEventClock,
  healthEventMetaLine,
  healthEventService,
  healthEventTypeCode,
  healthIngestUrl,
  healthSeverityLabel,
  healthTruncationNote,
  ingestActionLabel,
  ingestTokenSummary,
  isHealthDescriptionClampable,
  isIngestTokenLive,
  normalizeHealthSeverity,
  sortHealthEvents,
  truncateHealthDescription,
  type InfraHealthEventWire,
  type InfraHealthIngestTokenInfoWire,
} from './infraHealth';

const NOW = 1_700_000_000_000;

function makeEvent(overrides: Partial<InfraHealthEventWire> = {}): InfraHealthEventWire {
  return {
    id: 'evt-1',
    projectId: 'agent-hub',
    eventArn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/1',
    communicationId: null,
    region: 'us-east-1',
    deliveryRegion: 'us-east-1',
    detailType: 'AWS Health Event',
    service: 'EC2',
    eventTypeCode: 'AWS_EC2_OPERATIONAL_ISSUE',
    eventTypeCategory: 'issue',
    eventScopeCode: 'PUBLIC',
    statusCode: 'open',
    severity: 'critical',
    startTime: NOW - 60 * 60 * 1000,
    endTime: null,
    lastUpdated: null,
    description: 'The EC2 control plane is degraded.',
    affectedEntities: [],
    affectedEntityCount: 0,
    backupEvent: false,
    page: null,
    totalPages: null,
    eventTime: null,
    receivedAt: NOW - 30 * 60 * 1000,
    ...overrides,
  };
}

function makeToken(
  overrides: Partial<InfraHealthIngestTokenInfoWire> = {},
): InfraHealthIngestTokenInfoWire {
  return {
    projectId: 'agent-hub',
    tokenPrefix: 'ahhealth_ab12',
    createdAt: NOW - 86_400_000,
    rotatedAt: null,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe('healthEmptyState', () => {
  // The distinction this whole panel is built around: zero rows means two
  // opposite things, and only one of them is worth waiting out.
  it('tells an unconfigured project to go wire up a rule', () => {
    const state = healthEmptyState(false);
    expect(state.kind).toBe('not-configured');
    expect(state.title).toBe('AWS Health ingest not configured');
    expect(state.testID).toBe('infra-health-not-configured');
    expect(state.body).toContain('EventBridge rule');
  });

  it('tells a configured project that AWS has simply published nothing', () => {
    const state = healthEmptyState(true);
    expect(state.kind).toBe('quiet');
    expect(state.title).toBe('No AWS Health events received yet.');
    expect(state.testID).toBe('infra-health-empty');
    expect(state.body).toContain('Ingest is configured');
  });

  it('never reuses copy or a testID between the two states', () => {
    const notConfigured = healthEmptyState(false);
    const quiet = healthEmptyState(true);
    expect(notConfigured.title).not.toBe(quiet.title);
    expect(notConfigured.body).not.toBe(quiet.body);
    expect(notConfigured.testID).not.toBe(quiet.testID);
  });
});

describe('normalizeHealthSeverity / healthSeverityLabel', () => {
  it('passes the three known severities through', () => {
    expect(normalizeHealthSeverity('critical')).toBe('critical');
    expect(normalizeHealthSeverity('warning')).toBe('warning');
    expect(normalizeHealthSeverity('info')).toBe('info');
  });

  it('degrades an unrecognised or missing severity to info', () => {
    expect(normalizeHealthSeverity('catastrophic')).toBe('info');
    expect(normalizeHealthSeverity(null)).toBe('info');
    expect(normalizeHealthSeverity(undefined)).toBe('info');
  });

  it('labels with the web wording', () => {
    expect(healthSeverityLabel('critical')).toBe('Critical');
    expect(healthSeverityLabel('warning')).toBe('Warning');
    expect(healthSeverityLabel('info')).toBe('Info');
    expect(healthSeverityLabel('nonsense')).toBe('Info');
  });
});

describe('formatHealthStatus', () => {
  it('uppercases the lifecycle status for the pill', () => {
    expect(formatHealthStatus('open')).toBe('OPEN');
    expect(formatHealthStatus('closed')).toBe('CLOSED');
    expect(formatHealthStatus('upcoming')).toBe('UPCOMING');
  });

  it('returns null when AWS omitted the status, so no empty pill renders', () => {
    expect(formatHealthStatus(null)).toBeNull();
    expect(formatHealthStatus(undefined)).toBeNull();
    expect(formatHealthStatus('   ')).toBeNull();
  });
});

describe('healthEventClock / sortHealthEvents', () => {
  it("uses the event's own start time when AWS gave one", () => {
    expect(healthEventClock({ startTime: 5, receivedAt: 9 })).toBe(5);
  });

  it('falls back to arrival only when there is no start time', () => {
    expect(healthEventClock({ startTime: null, receivedAt: 9 })).toBe(9);
  });

  it('orders newest first', () => {
    const older = makeEvent({ id: 'old', startTime: NOW - 10_000 });
    const newer = makeEvent({ id: 'new', startTime: NOW - 1_000 });
    expect(sortHealthEvents([older, newer]).map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('does not mutate the response array', () => {
    const events = [
      makeEvent({ id: 'a', startTime: 1 }),
      makeEvent({ id: 'b', startTime: 2 }),
    ];
    sortHealthEvents(events);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('tolerates a missing or non-array events field', () => {
    expect(sortHealthEvents(null)).toEqual([]);
    expect(sortHealthEvents(undefined)).toEqual([]);
  });
});

describe('healthEventService / healthEventTypeCode', () => {
  it('names the service when AWS gave one', () => {
    expect(healthEventService(makeEvent())).toBe('EC2');
  });

  it('falls back to AWS for account-wide events that name no service', () => {
    expect(healthEventService(makeEvent({ service: null }))).toBe('AWS');
  });

  it('prefers the specific type code, then the detail type, then a literal', () => {
    expect(healthEventTypeCode(makeEvent())).toBe('AWS_EC2_OPERATIONAL_ISSUE');
    expect(healthEventTypeCode(makeEvent({ eventTypeCode: null }))).toBe('AWS Health Event');
    expect(healthEventTypeCode(makeEvent({ eventTypeCode: null, detailType: null }))).toBe(
      'AWS Health Event',
    );
  });
});

describe('affectedEntityLabel', () => {
  it('is null when AWS named no affected resources', () => {
    expect(affectedEntityLabel(0)).toBeNull();
    expect(affectedEntityLabel(null)).toBeNull();
    expect(affectedEntityLabel(-1)).toBeNull();
  });

  it('agrees with itself on plurals', () => {
    expect(affectedEntityLabel(1)).toBe('1 affected resource');
    expect(affectedEntityLabel(3)).toBe('3 affected resources');
  });
});

describe('healthEventMetaLine', () => {
  it('joins Region, relative time and entity count', () => {
    const line = healthEventMetaLine(makeEvent({ affectedEntityCount: 2 }), NOW);
    expect(line).toBe('us-east-1 · 1h ago · 2 affected resources');
  });

  it('marks a backup-Region delivery so a duplicate row is not read as a bug', () => {
    const line = healthEventMetaLine(makeEvent({ backupEvent: true }), NOW);
    expect(line).toContain('backup Region');
  });

  it('drops absent parts rather than leaving empty separators', () => {
    const line = healthEventMetaLine(
      makeEvent({ region: null, affectedEntityCount: 0, startTime: NOW }),
      NOW,
    );
    expect(line).toBe('just now');
  });
});

describe('truncateHealthDescription', () => {
  const long = `${'word '.repeat(60)}end`;

  it('leaves a short description alone and offers no toggle', () => {
    const result = truncateHealthDescription('short', false);
    expect(result).toEqual({ text: 'short', truncated: false });
    expect(isHealthDescriptionClampable('short')).toBe(false);
  });

  it('clips a long description and marks it truncated', () => {
    const result = truncateHealthDescription(long, false);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(HEALTH_CLAMP_CHARS + 1);
    expect(result.text.endsWith('…')).toBe(true);
    expect(isHealthDescriptionClampable(long)).toBe(true);
  });

  it('cuts on a word boundary rather than through an identifier', () => {
    const result = truncateHealthDescription(long, false);
    expect(result.text).not.toMatch(/wor…$/);
  });

  it('returns the whole description once expanded', () => {
    const result = truncateHealthDescription(long, true);
    expect(result).toEqual({ text: long, truncated: false });
  });

  it('treats a null description as empty rather than rendering "null"', () => {
    expect(truncateHealthDescription(null, false)).toEqual({ text: '', truncated: false });
    expect(truncateHealthDescription(undefined, true)).toEqual({ text: '', truncated: false });
    expect(isHealthDescriptionClampable(null)).toBe(false);
  });

  it('hard-slices when there is no word boundary late enough to use', () => {
    const unbroken = 'x'.repeat(200);
    const result = truncateHealthDescription(unbroken, false, 10);
    expect(result.text).toBe('xxxxxxxxxx…');
    expect(result.truncated).toBe(true);
  });
});

describe('healthTruncationNote', () => {
  it('is null when every event was drawn', () => {
    expect(healthTruncationNote(10, 10)).toBeNull();
    expect(healthTruncationNote(10, 3)).toBeNull();
  });

  it('states the cut, since the list is newest-first', () => {
    expect(healthTruncationNote(10, 34)).toContain('24 older events not shown');
    expect(healthTruncationNote(10, 11)).toContain('1 older event not shown');
  });
});

describe('ingest credential helpers', () => {
  it('treats an unrevoked token as live', () => {
    expect(isIngestTokenLive(makeToken())).toBe(true);
    expect(isIngestTokenLive(makeToken({ revokedAt: NOW }))).toBe(false);
    expect(isIngestTokenLive(null)).toBe(false);
  });

  it('offers Create before a token exists and Rotate afterwards', () => {
    expect(ingestActionLabel(null)).toBe('Create ingest token');
    expect(ingestActionLabel(makeToken())).toBe('Rotate ingest token');
    expect(ingestActionLabel(makeToken({ revokedAt: NOW }))).toBe('Create ingest token');
  });

  it('summarises a token by prefix and last use, never by its value', () => {
    expect(ingestTokenSummary(null, NOW)).toBeNull();
    expect(ingestTokenSummary(makeToken(), NOW)).toBe('ahhealth_ab12… · never used');
    expect(ingestTokenSummary(makeToken({ lastUsedAt: NOW - 3_600_000 }), NOW)).toBe(
      'ahhealth_ab12… · last used 1h ago',
    );
    expect(ingestTokenSummary(makeToken({ revokedAt: NOW }), NOW)).toBe('ahhealth_ab12… · revoked');
  });

  it('prefers revoked over last-used, so a dead credential never reads as working', () => {
    const summary = ingestTokenSummary(makeToken({ revokedAt: NOW, lastUsedAt: NOW - 1000 }), NOW);
    expect(summary).toBe('ahhealth_ab12… · revoked');
  });
});

describe('healthIngestUrl', () => {
  it('joins the saved server base to the server-supplied path', () => {
    expect(healthIngestUrl('https://hub.example.com', '/api/infra/health/ingest')).toBe(
      'https://hub.example.com/api/infra/health/ingest',
    );
  });

  it('never produces a double slash', () => {
    expect(healthIngestUrl('https://hub.example.com/', '/api/infra/health/ingest')).toBe(
      'https://hub.example.com/api/infra/health/ingest',
    );
    expect(healthIngestUrl('https://hub.example.com', 'api/infra/health/ingest')).toBe(
      'https://hub.example.com/api/infra/health/ingest',
    );
  });

  it('still yields the path when no server base is configured yet', () => {
    expect(healthIngestUrl('', '/api/infra/health/ingest')).toBe('/api/infra/health/ingest');
    expect(healthIngestUrl(null, '/api/infra/health/ingest')).toBe('/api/infra/health/ingest');
  });
});

describe('formatEventPattern', () => {
  it('pretty-prints the rule pattern for the copy button', () => {
    const json = formatEventPattern({
      source: ['aws.health'],
      'detail-type': ['AWS Health Event', 'AWS Health Abuse Event'],
    });
    expect(json).toContain('"aws.health"');
    expect(json.split('\n').length).toBeGreaterThan(1);
    expect(JSON.parse(json).source).toEqual(['aws.health']);
  });

  it('is empty rather than "null" before the pattern has loaded', () => {
    expect(formatEventPattern(null)).toBe('');
    expect(formatEventPattern(undefined)).toBe('');
  });
});

describe('setup copy', () => {
  // AWS event patterns do not wildcard: `aws.health*` matches nothing, forever,
  // silently. The instructions have to hand over the exact literal, and must
  // not accidentally present the wildcard as usable.
  it('names the exact source literal and calls the wildcard out as broken', () => {
    expect(INGEST_SETUP_NOTE).toContain('source is exactly aws.health');
    expect(INGEST_SETUP_NOTE).toContain('aws.health* never matches');
  });

  it('names both accepted auth headers', () => {
    expect(INGEST_SETUP_NOTE).toContain('Authorization: Bearer');
    expect(INGEST_SETUP_NOTE).toContain('x-agenthub-health-token');
  });

  it('warns that the plaintext token is unrecoverable', () => {
    expect(TOKEN_ONCE_WARNING).toContain('shown only once');
    expect(TOKEN_ONCE_WARNING).toContain('no recovery path');
  });
});
