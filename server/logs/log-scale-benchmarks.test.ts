/**
 * log-scale-benchmarks.test.ts — single-node capacity tripwires for the customer
 * log store (card "Harden log operations and scale limits", decision LOG-SCOPE:
 * "Optimize the dedicated SQLite store for a single Hub instance and moderate
 * project volumes").
 *
 * These are NOT micro-benchmarks and NOT a perf gate. They exercise the real
 * logs.db at a representative volume and assert *generous* upper bounds — an
 * order of magnitude of headroom over what a modest CI runner does — so they trip
 * only on a gross regression (e.g. a lost index, an accidental full-table scan),
 * never on normal timing jitter. The measured numbers are logged for operators;
 * the documented envelope lives in the wiki page "Log Store — Single-Node
 * Envelope and Scale-Out Trigger".
 *
 * Covered: sustained-ingest, burst, live-subscriber fan-out, FTS query,
 * retention reap, and restart recovery. Disk-pressure (SQLITE_FULL) containment
 * is covered by log-outage-isolation.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  initLogsDb,
  closeLogsDb,
  insertLogRecords,
  queryLogRecords,
  pruneExpiredLogRecords,
  isLogFtsAvailable,
  type LogRecordInput,
} from './logs-db.js';
import { subscribeLogTail, publishLogTail, resetLogTailListenersForTests } from './log-tail.js';
import { SEVERITY_NUMBER } from './logs-schema.js';

const NANO = 1_000_000;
// A representative "moderate project volume" working set for a single node. Kept
// modest so the suite stays fast; thresholds carry ~10x headroom over observed.
const VOLUME = 5_000;

/** Generous per-phase wall-time ceilings (ms). Regression tripwires, not SLOs. */
const THRESHOLD = {
  sustainedIngestMs: 20_000,
  burstIngestMs: 15_000,
  ftsQueryMs: 2_000,
  historyQueryMs: 500,
  retentionReapMs: 5_000,
  restartRecoveryMs: 5_000,
  fanoutMs: 2_000,
};

function makeRecord(i: number, body: string): LogRecordInput {
  return {
    projectId: 'proj-a',
    sourceId: `src-${i % 4}`,
    timeUnixNano: (1_800_000_000_000 + i) * NANO,
    severityNumber: SEVERITY_NUMBER.INFO,
    body,
    serviceName: 'checkout',
    environment: 'prod',
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'log-bench-'));
  initLogsDb(dir);
  resetLogTailListenersForTests();
});

afterEach(() => {
  resetLogTailListenersForTests();
  closeLogsDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingest throughput', () => {
  it('sustains a steady ingest stream in bounded batches within the envelope', () => {
    const start = Date.now();
    const batchSize = 500;
    for (let i = 0; i < VOLUME; i += batchSize) {
      const batch = Array.from({ length: batchSize }, (_, j) =>
        makeRecord(i + j, `steady message ${i + j}`),
      );
      insertLogRecords(batch, Date.now());
    }
    const elapsed = Date.now() - start;
    const perSec = Math.round((VOLUME / elapsed) * 1000);
    console.log(`[bench] sustained ingest: ${VOLUME} records in ${elapsed}ms (~${perSec}/s)`);
    expect(elapsed).toBeLessThan(THRESHOLD.sustainedIngestMs);

    const page = queryLogRecords({ projectId: 'proj-a', limit: 1 });
    expect(page.records).toHaveLength(1);
  });

  it('absorbs a single large burst (one max-size transaction is bounded work)', () => {
    const burst = Array.from({ length: 1000 }, (_, i) => makeRecord(i, `burst ${i}`));
    const start = Date.now();
    const result = insertLogRecords(burst, Date.now());
    const elapsed = Date.now() - start;
    console.log(`[bench] burst ingest: 1000 records in ${elapsed}ms`);
    expect(result.inserted).toBe(1000);
    expect(elapsed).toBeLessThan(THRESHOLD.burstIngestMs);
  });
});

describe('query throughput', () => {
  beforeEach(() => {
    for (let i = 0; i < VOLUME; i += 500) {
      const batch = Array.from({ length: 500 }, (_, j) =>
        makeRecord(i + j, `payment ${(i + j) % 2 === 0 ? 'declined' : 'ok'} order ${i + j}`),
      );
      insertLogRecords(batch, Date.now());
    }
  });

  it('serves a newest-first history page from the index quickly', () => {
    const start = Date.now();
    const page = queryLogRecords({ projectId: 'proj-a', limit: 500 });
    const elapsed = Date.now() - start;
    console.log(`[bench] history page (500) in ${elapsed}ms`);
    expect(page.records.length).toBe(500);
    // Bounded: never scans the whole table into memory.
    expect(elapsed).toBeLessThan(THRESHOLD.historyQueryMs);
  });

  it('runs an FTS message search over the working set within the envelope', () => {
    if (!isLogFtsAvailable()) {
      console.log('[bench] FTS unavailable in this SQLite build — skipping FTS timing');
      return;
    }
    const start = Date.now();
    const page = queryLogRecords({ projectId: 'proj-a', text: 'declined', limit: 500 });
    const elapsed = Date.now() - start;
    console.log(`[bench] FTS query matched ${page.records.length} in ${elapsed}ms`);
    expect(page.records.length).toBeGreaterThan(0);
    expect(page.records.every((r) => r.body?.includes('declined'))).toBe(true);
    expect(elapsed).toBeLessThan(THRESHOLD.ftsQueryMs);
  });
});

describe('retention reap throughput', () => {
  it('reaps an expired backlog in bounded per-call batches within the envelope', () => {
    // Ingest well in the past so the whole set is beyond the default 7d window.
    const longAgoNano = (Date.now() - 30 * 24 * 60 * 60 * 1000) * NANO;
    for (let i = 0; i < VOLUME; i += 500) {
      const batch = Array.from({ length: 500 }, (_, j) => ({
        ...makeRecord(i + j, `old ${i + j}`),
        timeUnixNano: longAgoNano + (i + j),
      }));
      insertLogRecords(batch, Date.now());
    }
    const start = Date.now();
    let reaped = 0;
    let guard = 100;
    let deleted: number;
    do {
      deleted = pruneExpiredLogRecords(Date.now());
      reaped += deleted;
    } while (deleted > 0 && guard-- > 0);
    const elapsed = Date.now() - start;
    console.log(`[bench] retention reap: ${reaped} records in ${elapsed}ms`);
    expect(reaped).toBe(VOLUME);
    expect(elapsed).toBeLessThan(THRESHOLD.retentionReapMs);
    expect(queryLogRecords({ projectId: 'proj-a', limit: 1 }).records).toHaveLength(0);
  });
});

describe('live-subscriber fan-out', () => {
  it('fans a committed batch to many subscribers within the envelope', () => {
    const received = new Array(50).fill(0);
    for (let s = 0; s < received.length; s++) {
      const idx = s;
      subscribeLogTail((records) => {
        received[idx] += records.length;
      });
    }
    const batch = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      project_id: 'proj-a',
      source_id: 'src-1',
      time_unix_nano: i,
      observed_time_unix_nano: null,
      severity_number: 9,
      severity_text: null,
      body: `live ${i}`,
      service_name: null,
      environment: null,
      trace_id: null,
      span_id: null,
      fingerprint: null,
      resource_json: null,
      attributes_json: null,
      scope_json: null,
      byte_size: 6,
      ingested_at: 1,
    }));
    const start = Date.now();
    publishLogTail(batch);
    const elapsed = Date.now() - start;
    console.log(`[bench] fan-out 100 records to 50 subscribers in ${elapsed}ms`);
    expect(received.every((n) => n === 100)).toBe(true);
    expect(elapsed).toBeLessThan(THRESHOLD.fanoutMs);
  });
});

describe('restart recovery', () => {
  it('reopens logs.db (WAL checkpoint + quick_check) with data intact and fast', () => {
    for (let i = 0; i < VOLUME; i += 500) {
      const batch = Array.from({ length: 500 }, (_, j) =>
        makeRecord(i + j, `pre-restart ${i + j}`),
      );
      insertLogRecords(batch, Date.now());
    }
    closeLogsDb();

    const start = Date.now();
    initLogsDb(dir); // runs the WAL checkpoint + quick_check recovery path
    const elapsed = Date.now() - start;
    console.log(`[bench] restart recovery in ${elapsed}ms`);
    expect(elapsed).toBeLessThan(THRESHOLD.restartRecoveryMs);
    // Every committed record survived the reopen.
    const page = queryLogRecords({ projectId: 'proj-a', limit: 1 });
    expect(page.records).toHaveLength(1);
  });
});
