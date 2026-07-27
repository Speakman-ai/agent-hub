import { describe, it, expect } from 'vitest';
import {
  mergeTailRecords,
  buildLogSubscribeFrame,
  oldestRecordCursor,
  buildOlderPageParams,
  isOlderCursor,
  filterLogRecords,
  recordMatchesFilter,
  distinctValues,
  parseAttributes,
  extractStackTrace,
  severityLabel,
  severityTone,
  nanoToMillis,
  resolveTailCursor,
  resolveSinceUnixNano,
  isNearBottom,
  nextScrollTop,
  DEFAULT_TIME_RANGE_MS,
  TIME_RANGES,
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
    expect(buildLogSubscribeFrame({ projectId: 'p1', cursor: 7, hasRecords: false })).toMatchObject(
      {
        cursor: 7,
        seed: true,
      },
    );
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
    expect(isOlderCursor({ timeUnixNano: delayed.timeUnixNano, id: delayed.id }, cursor)).toBe(
      true,
    );
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

describe('isNearBottom', () => {
  it('is true at the exact bottom', () => {
    expect(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
  });

  it('is true within the threshold of the bottom', () => {
    expect(isNearBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
  });

  it('is false when scrolled up past the threshold', () => {
    expect(isNearBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
  });

  it('honors a custom threshold', () => {
    const geom = { scrollTop: 400, scrollHeight: 1000, clientHeight: 500 };
    expect(isNearBottom(geom, 50)).toBe(false);
    expect(isNearBottom(geom, 100)).toBe(true);
  });
});

describe('nextScrollTop', () => {
  it('follows the newest record to the real maximum scroll top when pinned', () => {
    // Max reachable scrollTop is scrollHeight - clientHeight, not scrollHeight.
    const target = nextScrollTop(
      { oldest: { timeUnixNano: 1, id: 1 }, scrollHeight: 800, scrollTop: 300 },
      { oldest: { timeUnixNano: 1, id: 1 }, scrollHeight: 1000, clientHeight: 400 },
      true,
    );
    expect(target).toBe(600);
  });

  it('floors the pinned scroll top at 0 when content is shorter than the viewport', () => {
    const target = nextScrollTop(
      { oldest: { timeUnixNano: 1, id: 1 }, scrollHeight: 100, scrollTop: 0 },
      { oldest: { timeUnixNano: 1, id: 1 }, scrollHeight: 200, clientHeight: 500 },
      true,
    );
    expect(target).toBe(0);
  });

  it('preserves the viewport when older history is prepended above', () => {
    // The oldest held keyset moved back (a "Load older" prepend) and the content
    // grew by 400px; shift down by that delta so the read row stays put.
    const target = nextScrollTop(
      { oldest: { timeUnixNano: 10, id: 10 }, scrollHeight: 600, scrollTop: 0 },
      { oldest: { timeUnixNano: 1, id: 1 }, scrollHeight: 1000, clientHeight: 400 },
      false,
    );
    expect(target).toBe(400);
  });

  it('leaves the scroll untouched when records append below while scrolled up', () => {
    const target = nextScrollTop(
      { oldest: { timeUnixNano: 1, id: 1 }, scrollHeight: 800, scrollTop: 100 },
      { oldest: { timeUnixNano: 1, id: 1 }, scrollHeight: 1000, clientHeight: 400 },
      false,
    );
    expect(target).toBeNull();
  });

  it('does not adjust on the first render (no prior cursor)', () => {
    const target = nextScrollTop(
      { oldest: null, scrollHeight: 0, scrollTop: 0 },
      { oldest: { timeUnixNano: 5, id: 5 }, scrollHeight: 1000, clientHeight: 400 },
      false,
    );
    expect(target).toBeNull();
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

  it('resolveSinceUnixNano converts a window + now into a nanosecond lower bound', () => {
    const nowMs = 1_800_000_000_000;
    // 24h window → (now - 24h) in nanoseconds.
    expect(resolveSinceUnixNano(DEFAULT_TIME_RANGE_MS, nowMs)).toBe(
      (nowMs - DEFAULT_TIME_RANGE_MS) * 1e6,
    );
    // "All time" (0) and degenerate widths → no lower bound.
    expect(resolveSinceUnixNano(0, nowMs)).toBeUndefined();
    expect(resolveSinceUnixNano(-1, nowMs)).toBeUndefined();
    expect(resolveSinceUnixNano(Number.NaN, nowMs)).toBeUndefined();
    // A window wider than the epoch collapses to no bound rather than a negative.
    expect(resolveSinceUnixNano(nowMs + 1, nowMs)).toBeUndefined();
  });

  it('TIME_RANGES defaults to a 24h option and includes an unbounded "All time"', () => {
    expect(DEFAULT_TIME_RANGE_MS).toBe(86_400_000);
    expect(TIME_RANGES.some((r) => r.value === DEFAULT_TIME_RANGE_MS)).toBe(true);
    expect(TIME_RANGES.some((r) => r.value === 0)).toBe(true);
  });

  it('resolveTailCursor prefers the backfill nextCursor continue-token', () => {
    // Regression: a backfill frame must advance by `nextCursor`, not the page
    // `cursor`, so a reconnect never resubscribes from a stale cursor and
    // replays the same backfill window.
    expect(resolveTailCursor({ cursor: 100, nextCursor: 250 }, 0)).toBe(250);
    // Final backfill page (nextCursor null) → the last-record `cursor` wins.
    expect(resolveTailCursor({ cursor: 8, nextCursor: null }, 3)).toBe(8);
    // Live frame carries only `cursor`.
    expect(resolveTailCursor({ cursor: 42 }, 10)).toBe(42);
    // Bare keepalive → keep the current cursor.
    expect(resolveTailCursor({}, 17)).toBe(17);
  });
});
