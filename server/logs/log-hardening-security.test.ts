/**
 * log-hardening-security.test.ts — consolidated store-level security invariants
 * for the customer log module (card "Harden log operations and scale limits").
 *
 * These exercise the real `logs.db` code paths (no mocks, scratch data dir) and
 * assert the hardening guarantees named in the epic decisions:
 *   - LOG-QUERY / LOG-STORE: cross-project isolation — a cursor or filter from
 *     one project can never surface another project's rows.
 *   - LOG-STORE: quota-bypass — a project cannot exceed its byte quota; the
 *     reaper evicts oldest-first back under the cap.
 *   - LOG-STORE: oversize record + batch caps are enforced, not advisory.
 *   - LOG-TRUST: log-injection normalization (CRLF / ANSI / control bytes) and
 *     key- + pattern-based redaction of secrets before persistence.
 *
 * Token-abuse and access-control (Admin gate, source-token scoping) are covered
 * by routes/log-sources.test.ts and routes/log-ingest.test.ts; this suite adds
 * the storage-boundary guarantees those route tests do not reach.
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
  queryLogRecordsSince,
  enforceProjectQuota,
  setRetentionConfig,
  getProjectByteSize,
  type LogRecordInput,
} from './logs-db.js';
import { MAX_BATCH_RECORDS, MAX_RECORD_BYTES, SEVERITY_NUMBER } from './logs-schema.js';
import {
  buildRedactionConfig,
  normalizeLogText,
  redactText,
  redactStructured,
} from './log-redaction.js';

const NANO = 1_000_000;

function rec(projectId: string, body: string, extra: Partial<LogRecordInput> = {}): LogRecordInput {
  return {
    projectId,
    sourceId: 'src-1',
    timeUnixNano: 1_800_000_000_000 * NANO,
    severityNumber: SEVERITY_NUMBER.INFO,
    body,
    ...extra,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'log-sec-'));
  initLogsDb(dir);
});

afterEach(() => {
  closeLogsDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('cross-project isolation', () => {
  it('never returns another project rows from a query filter', () => {
    insertLogRecords([rec('proj-a', 'a-only')], 1);
    insertLogRecords([rec('proj-b', 'b-secret')], 2);

    const page = queryLogRecords({ projectId: 'proj-a', limit: 100 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.body).toBe('a-only');
    expect(JSON.stringify(page.records)).not.toContain('b-secret');
  });

  it('cannot cross a project boundary with a cursor stolen from another project', () => {
    // A row exists in B with a low id; A ingests later (higher ids).
    const bRow = insertLogRecords([rec('proj-b', 'b-secret')], 1).records[0]!;
    insertLogRecords([rec('proj-a', 'a-1')], 2);
    insertLogRecords([rec('proj-a', 'a-2')], 3);

    // Replaying "since" B's cursor against project A must only ever expose A.
    const since = queryLogRecordsSince('proj-a', bRow.id - 1, 100);
    expect(since.records.every((r) => r.project_id === 'proj-a')).toBe(true);
    expect(JSON.stringify(since.records)).not.toContain('b-secret');
  });

  it('FTS text search is scoped to the requesting project', () => {
    insertLogRecords([rec('proj-a', 'payment declined')], 1);
    insertLogRecords([rec('proj-b', 'payment declined')], 2);

    const hits = queryLogRecords({ projectId: 'proj-a', text: 'payment', limit: 100 });
    // Either FTS is available (exactly A's row) or unavailable (text ignored,
    // still only A's row) — never B's.
    expect(hits.records.every((r) => r.project_id === 'proj-a')).toBe(true);
  });
});

describe('quota-bypass resistance', () => {
  it('evicts oldest-first back under the byte quota, keeping newest and dropping oldest', () => {
    const quotaBytes = 64 * 1024 * 1024; // MIN_PROJECT_QUOTA_BYTES (clamp floor)
    setRetentionConfig('proj-a', { quotaBytes }, Date.now());

    // 300 records of ~250 KiB each (< MAX_RECORD_BYTES) = ~73 MiB, over quota.
    // Capture the durable id of each in insertion order so we can assert exactly
    // which records the reaper removed.
    const big = 'x'.repeat(250 * 1024);
    const ids: number[] = [];
    for (let i = 0; i < 300; i++) {
      const row = insertLogRecords(
        [rec('proj-a', big, { timeUnixNano: (1_800_000_000_000 + i) * NANO })],
        i + 1,
      ).records[0]!;
      ids.push(row.id);
    }
    const oldestId = ids[0]!;
    const newestId = ids[ids.length - 1]!;
    expect(newestId).toBeGreaterThan(oldestId);
    expect(getProjectByteSize('proj-a')).toBeGreaterThan(quotaBytes);

    // Drain the reaper across its per-call budget until it is under quota.
    let guard = 100;
    while (getProjectByteSize('proj-a') > quotaBytes && guard-- > 0) {
      enforceProjectQuota('proj-a');
    }
    expect(getProjectByteSize('proj-a')).toBeLessThanOrEqual(quotaBytes);

    // Oldest-first ordering guarantee (not merely "under quota"): the evicted
    // set must be exactly the oldest prefix. Verify the newest record is kept,
    // the oldest is gone, some records survived, and — the ordering assertion —
    // every evicted id is strictly older than every surviving id.
    const survivors = queryLogRecords({ projectId: 'proj-a', limit: 500 }).records;
    const survivingIds = new Set(survivors.map((r) => r.id));
    expect(survivors.length).toBeGreaterThan(0); // reaper didn't nuke everything
    expect(survivingIds.has(newestId)).toBe(true); // newest retained
    expect(survivingIds.has(oldestId)).toBe(false); // oldest evicted

    const evictedIds = ids.filter((id) => !survivingIds.has(id));
    expect(evictedIds.length).toBeGreaterThan(0);
    const minSurvivingId = Math.min(...survivingIds);
    const maxEvictedId = Math.max(...evictedIds);
    // A reaper deleting newest/arbitrary rows would break this: survivors are
    // the newest contiguous suffix, so nothing older than the boundary survives
    // and nothing newer than it was evicted.
    expect(maxEvictedId).toBeLessThan(minSurvivingId);
  });

  it('does not touch a sibling project when reaping one project quota', () => {
    setRetentionConfig('proj-a', { quotaBytes: 64 * 1024 * 1024 }, Date.now());
    const big = 'x'.repeat(250 * 1024);
    for (let i = 0; i < 300; i++) {
      insertLogRecords(
        [rec('proj-a', big, { timeUnixNano: (1_800_000_000_000 + i) * NANO })],
        i + 1,
      );
    }
    insertLogRecords([rec('proj-b', 'b-keep')], 999);

    let guard = 100;
    while (getProjectByteSize('proj-a') > 64 * 1024 * 1024 && guard-- > 0) {
      enforceProjectQuota('proj-a');
    }
    const b = queryLogRecords({ projectId: 'proj-b', limit: 10 });
    expect(b.records).toHaveLength(1);
    expect(b.records[0]!.body).toBe('b-keep');
  });
});

describe('storage caps are enforced, not advisory', () => {
  it('drops an oversize record but commits the rest of the batch (partial success)', () => {
    const oversize = 'y'.repeat(MAX_RECORD_BYTES + 1);
    const result = insertLogRecords([rec('proj-a', 'ok'), rec('proj-a', oversize)], 1);
    expect(result.inserted).toBe(1);
    expect(result.rejectedOversize).toBe(1);
  });

  it('throws on a batch above MAX_BATCH_RECORDS rather than silently truncating', () => {
    const tooMany = Array.from({ length: MAX_BATCH_RECORDS + 1 }, (_, i) => rec('proj-a', `m${i}`));
    expect(() => insertLogRecords(tooMany, 1)).toThrow(/MAX_BATCH_RECORDS/);
  });
});

describe('log-injection normalization (LOG-TRUST)', () => {
  it('collapses CRLF and strips control bytes so a line cannot forge extra lines', () => {
    const CR = String.fromCharCode(13);
    const NUL = String.fromCharCode(0);
    const ESC = String.fromCharCode(27);
    // A CR, a NUL control byte, and an ANSI SGR escape sequence.
    const forged = `user login${CR}\n2026-01-01 ERROR fake injected line${NUL} ${ESC}[31mred`;
    const clean = normalizeLogText(forged);
    expect(clean).not.toContain(CR); // CRLF collapsed to LF
    expect(clean).not.toContain(NUL); // NUL control byte stripped
    expect(clean).not.toContain(ESC); // ESC removed with the SGR sequence
    expect(clean).not.toContain('[31m'); // whole ANSI sequence removed as a unit
    expect(clean).toContain('fake injected line'); // the literal text survives
  });
});

describe('redaction before persistence (LOG-TRUST)', () => {
  it('masks built-in secret value patterns (bearer token)', () => {
    const config = buildRedactionConfig();
    const { value, redactions } = redactText('Authorization: Bearer abc123DEFtoken456xyz', config);
    expect(redactions).toBeGreaterThan(0);
    expect(value).not.toContain('abc123DEFtoken456xyz');
    expect(value).toContain('[redacted]');
  });

  it('masks by sensitive key regardless of value shape', () => {
    const config = buildRedactionConfig();
    const { value, redactions } = redactStructured(
      { password: { nested: 'hunter2' }, ok: 'visible' },
      config,
    );
    expect(redactions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(value)).not.toContain('hunter2');
    expect(JSON.stringify(value)).toContain('visible');
  });

  it('applies an operator-configured custom redaction pattern', () => {
    const config = buildRedactionConfig({ redactPatterns: ['CUST-\\d{6}'] });
    const { value, redactions } = redactText('customer CUST-123456 charged', config);
    expect(redactions).toBe(1);
    expect(value).not.toContain('CUST-123456');
  });
});
