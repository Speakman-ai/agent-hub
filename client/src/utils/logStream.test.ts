import { describe, it, expect } from 'vitest';
import {
  mergeTailRecords,
  filterLogRecords,
  recordMatchesFilter,
  distinctValues,
  parseAttributes,
  extractStackTrace,
  severityLabel,
  severityTone,
  nanoToMillis,
  SEVERITY_NUMBER,
  type LogRecord,
} from './logStream';

function rec(overrides: Partial<LogRecord> & { id: number }): LogRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    projectId: 'p1',
    sourceId: 'src-a',
    timeUnixNano: id * 1_000_000,
    observedTimeUnixNano: null,
    severityNumber: SEVERITY_NUMBER.INFO,
    severityText: null,
    body: `line ${id}`,
    serviceName: 'checkout',
    environment: 'prod',
    traceId: null,
    spanId: null,
    fingerprint: null,
    resourceJson: null,
    attributesJson: null,
    scopeJson: null,
    byteSize: 10,
    ingestedAt: 0,
    ...rest,
  };
}

describe('mergeTailRecords', () => {
  it('appends and keeps ascending id order', () => {
    const merged = mergeTailRecords([rec({ id: 1 }), rec({ id: 2 })], [rec({ id: 3 })], 100);
    expect(merged.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('dedupes replayed ids on reconnect (backfill overlaps existing tail)', () => {
    // Simulate a reconnect: the backfill replays ids 2 and 3 the client already
    // holds, then adds a new id 4. No duplicate rows must survive.
    const existing = [rec({ id: 1 }), rec({ id: 2 }), rec({ id: 3 })];
    const backfill = [rec({ id: 2 }), rec({ id: 3 }), rec({ id: 4 })];
    const merged = mergeTailRecords(existing, backfill, 100);
    expect(merged.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('prefers the newest copy of a duplicated id', () => {
    const merged = mergeTailRecords(
      [rec({ id: 5, body: 'old' })],
      [rec({ id: 5, body: 'new' })],
      100,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe('new');
  });

  it('bounds the tail to the newest cap records under high volume', () => {
    const existing = Array.from({ length: 900 }, (_, i) => rec({ id: i + 1 }));
    const incoming = Array.from({ length: 400 }, (_, i) => rec({ id: 901 + i }));
    const merged = mergeTailRecords(existing, incoming, 1000);
    expect(merged).toHaveLength(1000);
    expect(merged[0].id).toBe(301); // oldest 300 evicted
    expect(merged[merged.length - 1].id).toBe(1300);
  });

  it('trims an already-oversized tail even with no incoming records', () => {
    const existing = Array.from({ length: 50 }, (_, i) => rec({ id: i + 1 }));
    const merged = mergeTailRecords(existing, [], 10);
    expect(merged).toHaveLength(10);
    expect(merged[0].id).toBe(41);
  });
});

describe('filterLogRecords / recordMatchesFilter', () => {
  const records = [
    rec({
      id: 1,
      severityNumber: SEVERITY_NUMBER.INFO,
      body: 'user login ok',
      environment: 'prod',
    }),
    rec({ id: 2, severityNumber: SEVERITY_NUMBER.ERROR, body: 'db timeout', environment: 'prod' }),
    rec({
      id: 3,
      severityNumber: SEVERITY_NUMBER.WARN,
      body: 'slow query',
      environment: 'staging',
      sourceId: 'src-b',
    }),
  ];

  it('filters by minimum severity number (inclusive)', () => {
    const out = filterLogRecords(records, { minSeverityNumber: SEVERITY_NUMBER.WARN });
    expect(out.map((r) => r.id)).toEqual([2, 3]);
  });

  it('treats severity 0 / null filter as no severity filter', () => {
    expect(filterLogRecords(records, { minSeverityNumber: 0 })).toHaveLength(3);
    expect(filterLogRecords(records, {})).toHaveLength(3);
  });

  it('filters by source, environment, and case-insensitive text', () => {
    expect(filterLogRecords(records, { sourceId: 'src-b' }).map((r) => r.id)).toEqual([3]);
    expect(filterLogRecords(records, { environment: 'staging' }).map((r) => r.id)).toEqual([3]);
    expect(filterLogRecords(records, { text: 'TIMEOUT' }).map((r) => r.id)).toEqual([2]);
  });

  it('combines predicates with AND', () => {
    const out = filterLogRecords(records, {
      minSeverityNumber: SEVERITY_NUMBER.WARN,
      environment: 'prod',
    });
    expect(out.map((r) => r.id)).toEqual([2]);
  });

  it('matches text against service and severity text too', () => {
    const r = rec({ id: 9, body: null, serviceName: 'billing', severityText: 'CRITICAL' });
    expect(recordMatchesFilter(r, { text: 'billing' })).toBe(true);
    expect(recordMatchesFilter(r, { text: 'critical' })).toBe(true);
    expect(recordMatchesFilter(r, { text: 'nope' })).toBe(false);
  });
});

describe('distinctValues', () => {
  it('returns sorted unique non-empty field values', () => {
    const records = [
      rec({ id: 1, environment: 'prod' }),
      rec({ id: 2, environment: 'staging' }),
      rec({ id: 3, environment: 'prod' }),
      rec({ id: 4, environment: null }),
    ];
    expect(distinctValues(records, 'environment')).toEqual(['prod', 'staging']);
  });
});

describe('parseAttributes', () => {
  it('returns [] for null / malformed / non-object input', () => {
    expect(parseAttributes(null)).toEqual([]);
    expect(parseAttributes('not json{')).toEqual([]);
    expect(parseAttributes('[1,2,3]')).toEqual([]);
    expect(parseAttributes('"a string"')).toEqual([]);
  });

  it('flattens scalar and nested values to string display rows', () => {
    const out = parseAttributes(
      JSON.stringify({ 'http.status': 500, retried: true, ctx: { region: 'us' }, nil: null }),
    );
    expect(out).toEqual([
      { key: 'http.status', value: '500' },
      { key: 'retried', value: 'true' },
      { key: 'ctx', value: '{"region":"us"}' },
      { key: 'nil', value: 'null' },
    ]);
  });
});

describe('extractStackTrace', () => {
  it('pulls exception.stacktrace and preserves newlines', () => {
    const json = JSON.stringify({
      'exception.type': 'TypeError',
      'exception.stacktrace': 'at a()\n  at b()\n  at c()',
    });
    expect(extractStackTrace(json)).toBe('at a()\n  at b()\n  at c()');
  });

  it('returns null when no stack attribute is present', () => {
    expect(extractStackTrace(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(extractStackTrace(null)).toBeNull();
  });
});

describe('severity helpers', () => {
  it('labels by threshold and prefers explicit severity text', () => {
    expect(severityLabel(SEVERITY_NUMBER.ERROR)).toBe('ERROR');
    expect(severityLabel(SEVERITY_NUMBER.WARN)).toBe('WARN');
    expect(severityLabel(0)).toBe('UNSET');
    expect(severityLabel(SEVERITY_NUMBER.INFO, 'notice')).toBe('NOTICE');
  });

  it('tones escalate with severity', () => {
    expect(severityTone(SEVERITY_NUMBER.ERROR)).toContain('red');
    expect(severityTone(SEVERITY_NUMBER.WARN)).toContain('amber');
    expect(severityTone(SEVERITY_NUMBER.INFO)).toContain('sky');
    expect(severityTone(SEVERITY_NUMBER.DEBUG)).toContain('gray');
  });

  it('nanoToMillis floors nanoseconds to millis and guards non-finite', () => {
    expect(nanoToMillis(1_700_000_000_000_000)).toBe(1_700_000_000);
    expect(nanoToMillis(Number.NaN)).toBe(0);
  });
});
