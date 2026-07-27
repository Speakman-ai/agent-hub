import { describe, it, expect } from 'vitest';
import {
  SEVERITY_NUMBER,
  severityLabel,
  severityToneKey,
  nanoToMillis,
  mergeTailRecords,
  buildLogSubscribeFrame,
  oldestRecordCursor,
  buildOlderPageParams,
  isOlderCursor,
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

describe('buildLogSubscribeFrame', () => {
  it('requests a seed only while the tail holds no records', () => {
    // Regression (review): the newest-page seed is lossy. It skips everything
    // older than the page and reports no continue-token. Asking for one with
    // records in hand would punch a hole the client can never page back for.
    expect(buildLogSubscribeFrame({ projectId: 'p1', cursor: 0, hasRecords: false })).toMatchObject(
      { type: 'logs_subscribe', projectId: 'p1', cursor: 0, seed: true },
    );
    expect(buildLogSubscribeFrame({ projectId: 'p1', cursor: 42, hasRecords: true })).toMatchObject(
      { cursor: 42, seed: false },
    );
  });

  it('keys the seed off held records, not off a zero cursor', () => {
    // An empty frame advances the cursor without delivering rows, so the two
    // facts can disagree. The flag follows the records; the server's own
    // `cursor === 0` guard resolves the disagreement toward the safe drain.
    expect(buildLogSubscribeFrame({ projectId: 'p1', cursor: 7, hasRecords: false })).toMatchObject({
      cursor: 7,
      seed: true,
    });
    expect(buildLogSubscribeFrame({ projectId: 'p1', cursor: 0, hasRecords: true })).toMatchObject({
      cursor: 0,
      seed: false,
    });
  });

  it('sends the window bound on every subscribe, seed and reconnect alike', () => {
    // Regression (review): the window used to ride on the seed only, on the
    // reasoning that every `id > cursor` is already newer than it. That assumed
    // ingest id and event time agree. A delayed batch committed after the cursor
    // carries old event times, so an unbounded reconnect drain replays hours-old
    // rows into a bounded Live view.
    expect(
      buildLogSubscribeFrame({
        projectId: 'p1',
        cursor: 0,
        hasRecords: false,
        sinceUnixNano: 500,
      }),
    ).toMatchObject({ seed: true, sinceUnixNano: 500 });
    expect(
      buildLogSubscribeFrame({ projectId: 'p1', cursor: 9, hasRecords: true, sinceUnixNano: 500 }),
    ).toMatchObject({ seed: false, sinceUnixNano: 500 });
  });

  it('omits the window bound for the unbounded ("All time") range', () => {
    expect(
      buildLogSubscribeFrame({ projectId: 'p1', cursor: 0, hasRecords: false }),
    ).not.toHaveProperty('sinceUnixNano');
  });
});

describe('chronological ordering (multi-source ingest)', () => {
  it('orders the merged tail by event time, not ingest id', () => {
    // Regression: two sources each POST their own batch, so their rows land in
    // contiguous id runs. Sorting by id made the stream jump backwards in time
    // every time it crossed from one batch into the next.
    const prod = [
      rec({ id: 1, sourceId: 'prod', timeUnixNano: 100 }),
      rec({ id: 2, sourceId: 'prod', timeUnixNano: 300 }),
    ];
    const dev = [
      rec({ id: 3, sourceId: 'dev', timeUnixNano: 200 }),
      rec({ id: 4, sourceId: 'dev', timeUnixNano: 400 }),
    ];
    const merged = mergeTailRecords(prod, dev, 100);
    expect(merged.map((r) => r.timeUnixNano)).toEqual([100, 200, 300, 400]);
    expect(merged.map((r) => r.id)).toEqual([1, 3, 2, 4]);
  });

  it('breaks equal timestamps by ingest id so the order stays stable', () => {
    const merged = mergeTailRecords(
      [rec({ id: 7, timeUnixNano: 100 })],
      [rec({ id: 5, timeUnixNano: 100 }), rec({ id: 6, timeUnixNano: 100 })],
      100,
    );
    expect(merged.map((r) => r.id)).toEqual([5, 6, 7]);
  });

  it('trims to the newest `cap` records by event time', () => {
    const merged = mergeTailRecords(
      [rec({ id: 1, timeUnixNano: 400 }), rec({ id: 2, timeUnixNano: 100 })],
      [rec({ id: 3, timeUnixNano: 200 })],
      2,
    );
    expect(merged.map((r) => r.timeUnixNano)).toEqual([200, 400]);
  });
});

describe('oldestRecordCursor', () => {
  it('returns the chronologically oldest record as a (time, id) keyset', () => {
    // "Load older" pages on the same axis the tail renders and trims on, so the
    // cursor is the rendered head, not the minimum ingest id.
    const records = [
      rec({ id: 9, timeUnixNano: 100 }),
      rec({ id: 2, timeUnixNano: 200 }),
      rec({ id: 5, timeUnixNano: 300 }),
    ];
    expect(oldestRecordCursor(records)).toEqual({ timeUnixNano: 100, id: 9 });
  });

  it('breaks a timestamp tie on the lower id', () => {
    const records = [rec({ id: 8, timeUnixNano: 100 }), rec({ id: 3, timeUnixNano: 100 })];
    expect(oldestRecordCursor(records)).toEqual({ timeUnixNano: 100, id: 3 });
  });

  it('returns null for an empty tail', () => {
    expect(oldestRecordCursor([])).toBeNull();
  });

  it('stays reachable after the cap evicts a delayed high-id record', () => {
    // Regression (review): the tail is capped by event time while pagination
    // used ingest id, so a delayed batch (high id, old event time) could be
    // evicted by the cap and then sit above `id < min(id held)` forever. With
    // an event-time keyset the evicted row is strictly older than the cursor,
    // which is exactly what the next "Load older" page asks for.
    const delayed = rec({ id: 99, timeUnixNano: 50 });
    const kept = [rec({ id: 1, timeUnixNano: 100 }), rec({ id: 2, timeUnixNano: 200 })];
    const capped = mergeTailRecords(kept, [delayed], 2);
    expect(capped.map((r) => r.id)).toEqual([1, 2]); // delayed row evicted
    const cursor = oldestRecordCursor(capped)!;
    // The evicted record is strictly older than the cursor on the paged axis...
    expect(isOlderCursor({ timeUnixNano: delayed.timeUnixNano, id: delayed.id }, cursor)).toBe(true);
    // ...even though its ingest id is far ABOVE the minimum id held, which is
    // precisely what an id-only cursor could never reach.
    expect(delayed.id > Math.min(...capped.map((r) => r.id))).toBe(true);
  });
});

describe('buildOlderPageParams', () => {
  const errorFilter = { minSeverityNumber: SEVERITY_NUMBER.ERROR };

  it('takes the keyset from the FILTERED stream, not the raw tail', () => {
    // Regression (review): the cursor came from the unfiltered tail. With an
    // ERROR filter, the INFO row at the oldest edge of the tail became the
    // cursor, so the server paged strictly older than it and every ERROR row
    // between that INFO row and the oldest rendered match was skipped forever.
    const combined = [
      rec({ id: 1, timeUnixNano: 50, severityNumber: SEVERITY_NUMBER.INFO }),
      rec({ id: 2, timeUnixNano: 100, severityNumber: SEVERITY_NUMBER.ERROR }),
    ];
    const visible = filterLogRecords(combined, errorFilter);
    const params = buildOlderPageParams({ visible, filter: errorFilter, limit: 100 });
    // Cursor is the oldest ERROR (t=100), not the oldest row overall (t=50).
    expect(params.cursorTimeUnixNano).toBe(100);
    expect(params.cursor).toBe(2);
    // An ERROR at t=70 lies between the two and is therefore still fetchable.
    expect(70).toBeLessThan(params.cursorTimeUnixNano as number);
  });

  it('sends no cursor when the filter matches nothing held', () => {
    // Otherwise the request would page past the tail's entire time span and
    // miss every matching record inside it. With no cursor the server returns
    // the newest matching rows anywhere in the window, which is what the user
    // asked for.
    const combined = [rec({ id: 1, timeUnixNano: 50, severityNumber: SEVERITY_NUMBER.INFO })];
    const visible = filterLogRecords(combined, errorFilter);
    expect(visible).toHaveLength(0);
    const params = buildOlderPageParams({ visible, filter: errorFilter, limit: 100 });
    expect(params).not.toHaveProperty('cursor');
    expect(params).not.toHaveProperty('cursorTimeUnixNano');
    expect(params.minSeverityNumber).toBe(SEVERITY_NUMBER.ERROR);
  });

  it('forwards the active facets and the window bound', () => {
    const params = buildOlderPageParams({
      visible: [],
      filter: {
        minSeverityNumber: SEVERITY_NUMBER.WARN,
        sourceId: 'src-a',
        environment: 'prod',
        text: '  boom  ',
      },
      limit: 25,
      sinceUnixNano: 500,
    });
    expect(params).toMatchObject({
      limit: 25,
      minSeverityNumber: SEVERITY_NUMBER.WARN,
      sourceId: 'src-a',
      environment: 'prod',
      text: 'boom',
      startTimeUnixNano: 500,
    });
  });

  it('omits empty facets so an unfiltered pager is not over-constrained', () => {
    const params = buildOlderPageParams({
      visible: [],
      filter: { minSeverityNumber: 0, sourceId: '', environment: '', text: '   ' },
      limit: 10,
    });
    expect(Object.keys(params)).toEqual(['limit']);
  });
});

describe('isOlderCursor', () => {
  it('compares on event time, then id', () => {
    expect(isOlderCursor({ timeUnixNano: 100, id: 5 }, { timeUnixNano: 200, id: 1 })).toBe(true);
    expect(isOlderCursor({ timeUnixNano: 200, id: 1 }, { timeUnixNano: 100, id: 5 })).toBe(false);
    expect(isOlderCursor({ timeUnixNano: 100, id: 1 }, { timeUnixNano: 100, id: 5 })).toBe(true);
    expect(isOlderCursor({ timeUnixNano: 100, id: 5 }, { timeUnixNano: 100, id: 5 })).toBe(false);
  });

  it('is false when either side is absent (first render)', () => {
    expect(isOlderCursor(null, { timeUnixNano: 1, id: 1 })).toBe(false);
    expect(isOlderCursor({ timeUnixNano: 1, id: 1 }, null)).toBe(false);
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
