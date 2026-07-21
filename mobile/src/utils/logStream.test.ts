import { describe, it, expect } from 'vitest';
import {
  SEVERITY_NUMBER,
  severityLabel,
  severityToneKey,
  nanoToMillis,
  mergeTailRecords,
  recordMatchesFilter,
  filterLogRecords,
  distinctValues,
  parseAttributes,
  extractStackTrace,
  recordHasDetail,
  resolveTailCursor,
  isNearBottom,
  type LogRecord,
} from './logStream';

function rec(overrides: Partial<LogRecord> & { id: number }): LogRecord {
  return {
    projectId: 'p1',
    sourceId: 'src-a',
    timeUnixNano: overrides.id * 1_000_000,
    observedTimeUnixNano: null,
    severityNumber: SEVERITY_NUMBER.INFO,
    severityText: null,
    body: `line ${overrides.id}`,
    serviceName: null,
    environment: null,
    traceId: null,
    spanId: null,
    fingerprint: null,
    resourceJson: null,
    attributesJson: null,
    scopeJson: null,
    byteSize: 0,
    ingestedAt: 0,
    ...overrides,
  };
}

describe('severity labelling', () => {
  it('prefers explicit severity text, upper-cased', () => {
    expect(severityLabel(SEVERITY_NUMBER.INFO, 'notice')).toBe('NOTICE');
  });
  it('buckets by number when text is absent', () => {
    expect(severityLabel(SEVERITY_NUMBER.ERROR, null)).toBe('ERROR');
    expect(severityLabel(SEVERITY_NUMBER.WARN, '')).toBe('WARN');
    expect(severityLabel(0, null)).toBe('UNSET');
  });
  it('maps a number to a semantic tone key', () => {
    expect(severityToneKey(SEVERITY_NUMBER.FATAL)).toBe('error');
    expect(severityToneKey(SEVERITY_NUMBER.ERROR)).toBe('error');
    expect(severityToneKey(SEVERITY_NUMBER.WARN)).toBe('warn');
    expect(severityToneKey(SEVERITY_NUMBER.INFO)).toBe('info');
    expect(severityToneKey(SEVERITY_NUMBER.DEBUG)).toBe('muted');
  });
});

describe('nanoToMillis', () => {
  it('floors nanoseconds to milliseconds', () => {
    expect(nanoToMillis(1_500_000)).toBe(1);
    expect(nanoToMillis(2_999_999)).toBe(2);
  });
  it('returns 0 for non-finite input', () => {
    expect(nanoToMillis(Infinity)).toBe(0);
    expect(nanoToMillis(NaN)).toBe(0);
  });
});

describe('mergeTailRecords — reconnect-safe stream merge', () => {
  it('dedupes replayed ids and keeps ascending order', () => {
    const existing = [rec({ id: 1 }), rec({ id: 2 })];
    const incoming = [rec({ id: 2 }), rec({ id: 3 })]; // id 2 overlaps (backfill replay)
    const merged = mergeTailRecords(existing, incoming, 100);
    expect(merged.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('bounds the result to the newest cap records', () => {
    const existing = [rec({ id: 1 }), rec({ id: 2 }), rec({ id: 3 })];
    const incoming = [rec({ id: 4 }), rec({ id: 5 })];
    const merged = mergeTailRecords(existing, incoming, 3);
    expect(merged.map((r) => r.id)).toEqual([3, 4, 5]);
  });

  it('trims existing when incoming is empty without cloning ids away', () => {
    const existing = [rec({ id: 1 }), rec({ id: 2 }), rec({ id: 3 })];
    expect(mergeTailRecords(existing, [], 2).map((r) => r.id)).toEqual([2, 3]);
  });

  it('the later occurrence of a duplicate id wins (fresh frame overrides)', () => {
    const merged = mergeTailRecords(
      [rec({ id: 7, body: 'old' })],
      [rec({ id: 7, body: 'new' })],
      10,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe('new');
  });
});

describe('recordMatchesFilter / filterLogRecords — facet + text filters', () => {
  const records = [
    rec({ id: 1, severityNumber: SEVERITY_NUMBER.INFO, sourceId: 'a', environment: 'prod', body: 'hello world' }),
    rec({ id: 2, severityNumber: SEVERITY_NUMBER.ERROR, sourceId: 'b', environment: 'staging', body: 'boom failed' }),
    rec({ id: 3, severityNumber: SEVERITY_NUMBER.WARN, sourceId: 'a', environment: 'prod', body: 'careful now' }),
  ];

  it('filters by minimum severity (inclusive)', () => {
    expect(filterLogRecords(records, { minSeverityNumber: SEVERITY_NUMBER.WARN }).map((r) => r.id)).toEqual([2, 3]);
  });
  it('treats minSeverity 0 as no floor', () => {
    expect(filterLogRecords(records, { minSeverityNumber: 0 })).toHaveLength(3);
  });
  it('filters by source id', () => {
    expect(filterLogRecords(records, { sourceId: 'a' }).map((r) => r.id)).toEqual([1, 3]);
  });
  it('filters by environment', () => {
    expect(filterLogRecords(records, { environment: 'staging' }).map((r) => r.id)).toEqual([2]);
  });
  it('does a case-insensitive text search over body/service/severity', () => {
    expect(filterLogRecords(records, { text: 'FAILED' }).map((r) => r.id)).toEqual([2]);
    expect(filterLogRecords(records, { text: '  ' })).toHaveLength(3); // whitespace-only = no needle
  });
  it('combines facets with an AND', () => {
    expect(
      recordMatchesFilter(records[2], { sourceId: 'a', environment: 'prod', minSeverityNumber: SEVERITY_NUMBER.WARN }),
    ).toBe(true);
    expect(recordMatchesFilter(records[2], { sourceId: 'b' })).toBe(false);
  });
});

describe('distinctValues — facet menus', () => {
  it('returns sorted distinct non-empty values', () => {
    const records = [
      rec({ id: 1, environment: 'prod' }),
      rec({ id: 2, environment: 'dev' }),
      rec({ id: 3, environment: 'prod' }),
      rec({ id: 4, environment: '' }),
      rec({ id: 5, environment: null }),
    ];
    expect(distinctValues(records, 'environment')).toEqual(['dev', 'prod']);
  });
});

describe('parseAttributes / extractStackTrace — untrusted-field error handling', () => {
  it('returns [] for null / malformed / non-object JSON (never throws)', () => {
    expect(parseAttributes(null)).toEqual([]);
    expect(parseAttributes('not json{')).toEqual([]);
    expect(parseAttributes('[1,2,3]')).toEqual([]);
    expect(parseAttributes('"a string"')).toEqual([]);
  });
  it('flattens primitives and stringifies nested values', () => {
    const rows = parseAttributes(JSON.stringify({ a: 1, b: 'x', c: true, d: null, e: { nested: 1 } }));
    expect(rows).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'x' },
      { key: 'c', value: 'true' },
      { key: 'd', value: 'null' },
      { key: 'e', value: '{"nested":1}' },
    ]);
  });
  it('extracts a stack trace from known attribute aliases', () => {
    expect(extractStackTrace(JSON.stringify({ 'exception.stacktrace': 'at foo\nat bar' }))).toBe('at foo\nat bar');
    expect(extractStackTrace(JSON.stringify({ stack: 'trace here' }))).toBe('trace here');
    expect(extractStackTrace(JSON.stringify({ irrelevant: 'x' }))).toBeNull();
    expect(extractStackTrace('garbage')).toBeNull();
  });
});

describe('resolveTailCursor — reconnect cursor after a tail frame', () => {
  it('advances by nextCursor for a mid-backfill page (not the frame cursor)', () => {
    // Regression: a backfill page must follow the server continue-token so a
    // reconnect resubscribes past this page instead of replaying it. Here the
    // server sends nextCursor=6 alongside cursor=6; both must land on 6.
    expect(resolveTailCursor({ cursor: 6, nextCursor: 6 }, 0)).toBe(6);
  });

  it('prefers nextCursor even when it differs from the frame cursor', () => {
    // Defensive: if a frame ever carries a start `cursor` distinct from the
    // durable `nextCursor`, the durable token wins so we never stall on a
    // stale cursor and replay the same backfill window.
    expect(resolveTailCursor({ cursor: 100, nextCursor: 250 }, 0)).toBe(250);
  });

  it('falls back to the frame cursor on the final backfill page (nextCursor null)', () => {
    // Final page carries records but nextCursor=null; the last record id in
    // `cursor` is the correct durable position.
    expect(resolveTailCursor({ cursor: 8, nextCursor: null }, 3)).toBe(8);
  });

  it('uses the frame cursor for a live frame that carries no nextCursor', () => {
    expect(resolveTailCursor({ cursor: 42 }, 10)).toBe(42);
  });

  it('retains the current cursor for a bare keepalive with no numeric cursor', () => {
    expect(resolveTailCursor({}, 17)).toBe(17);
    expect(resolveTailCursor({ cursor: null, nextCursor: undefined }, 17)).toBe(17);
  });
});

describe('recordHasDetail', () => {
  it('is true when any structured field is present', () => {
    expect(recordHasDetail(rec({ id: 1 }))).toBe(false);
    expect(recordHasDetail(rec({ id: 1, traceId: 't' }))).toBe(true);
    expect(recordHasDetail(rec({ id: 1, attributesJson: '{}' }))).toBe(true);
  });
});

describe('isNearBottom — FlatList tail stickiness', () => {
  it('is true at the exact bottom', () => {
    expect(isNearBottom({ offsetY: 500, contentHeight: 1000, viewportHeight: 500 })).toBe(true);
  });

  it('is true within the threshold of the bottom', () => {
    expect(isNearBottom({ offsetY: 480, contentHeight: 1000, viewportHeight: 500 })).toBe(true);
  });

  it('is false when scrolled up past the threshold (reading older history)', () => {
    expect(isNearBottom({ offsetY: 100, contentHeight: 1000, viewportHeight: 500 })).toBe(false);
  });

  it('honors a custom threshold', () => {
    const geom = { offsetY: 400, contentHeight: 1000, viewportHeight: 500 };
    expect(isNearBottom(geom, 50)).toBe(false);
    expect(isNearBottom(geom, 100)).toBe(true);
  });
});
