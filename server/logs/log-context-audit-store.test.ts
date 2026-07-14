import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initLogsDb, closeLogsDb } from './logs-db.js';
import { recordLogContextAudit, listLogContextAudit } from './log-context-audit-store.js';
import { buildAuditedLogContextPack } from './log-context-pack.js';
import type { LogRecordRow } from './logs-db.js';
import type { LogIssueRow } from './log-issues-store.js';

const NOW = 1_800_000_000_000;
const NOW_NANO = NOW * 1_000_000;

function issueRow(overrides: Partial<LogIssueRow> = {}): LogIssueRow {
  return {
    id: 'issue-1',
    project_id: 'proj-a',
    fingerprint: 'fp-1',
    title: 'Boom',
    service: 'checkout',
    environment: 'prod',
    exception_type: 'TypeError',
    message_template: 'boom',
    first_seen: NOW_NANO,
    last_seen: NOW_NANO,
    event_count: 3,
    status: 'open',
    status_updated_at: null,
    status_updated_by: null,
    first_record_id: 1,
    last_record_id: 2,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function recordRow(id: number): LogRecordRow {
  return {
    id,
    project_id: 'proj-a',
    source_id: 'src-1',
    time_unix_nano: NOW_NANO,
    observed_time_unix_nano: NOW_NANO,
    severity_number: 17,
    severity_text: 'ERROR',
    body: `error ${id}`,
    service_name: 'checkout',
    environment: 'prod',
    trace_id: null,
    span_id: null,
    fingerprint: 'fp-1',
    resource_json: null,
    attributes_json: null,
    scope_json: null,
    byte_size: 0,
    ingested_at: NOW_NANO,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'log-audit-test-'));
  initLogsDb(dir);
});

afterEach(() => {
  closeLogsDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('recordLogContextAudit', () => {
  it('persists the user, action, issue, and the exact record ids included', () => {
    const saved = recordLogContextAudit({
      projectId: 'proj-a',
      issueId: 'issue-1',
      action: 'analyze',
      actorUserId: 'user-42',
      recordIds: [10, 11, 12],
      contextBytes: 2048,
      redactions: 3,
      nowMs: NOW,
    });
    expect(saved.id).toBeTruthy();
    expect(saved.recordCount).toBe(3);

    const [row] = listLogContextAudit('proj-a', 'issue-1');
    expect(row.action).toBe('analyze');
    expect(row.actorUserId).toBe('user-42');
    expect(row.issueId).toBe('issue-1');
    expect(row.recordIds).toEqual([10, 11, 12]);
    expect(row.recordCount).toBe(3);
    expect(row.contextBytes).toBe(2048);
    expect(row.redactions).toBe(3);
    expect(row.createdAt).toBe(NOW);
  });

  it('scopes the list to a project and optional issue, newest-first', () => {
    recordLogContextAudit({
      projectId: 'proj-a',
      issueId: 'issue-1',
      action: 'analyze',
      actorUserId: 'u1',
      recordIds: [1],
      contextBytes: 10,
      nowMs: NOW,
    });
    recordLogContextAudit({
      projectId: 'proj-a',
      issueId: 'issue-2',
      action: 'fix',
      actorUserId: 'u2',
      recordIds: [2, 3],
      contextBytes: 20,
      nowMs: NOW + 1000,
    });
    recordLogContextAudit({
      projectId: 'proj-b',
      issueId: 'issue-9',
      action: 'analyze',
      actorUserId: 'u3',
      recordIds: [9],
      contextBytes: 30,
      nowMs: NOW + 2000,
    });

    const projA = listLogContextAudit('proj-a');
    expect(projA).toHaveLength(2);
    // Newest first.
    expect(projA[0].action).toBe('fix');
    expect(projA[1].action).toBe('analyze');

    const issue2 = listLogContextAudit('proj-a', 'issue-2');
    expect(issue2).toHaveLength(1);
    expect(issue2[0].recordIds).toEqual([2, 3]);

    // A project filter can never leak another project's rows.
    const projB = listLogContextAudit('proj-b');
    expect(projB).toHaveLength(1);
    expect(projB[0].projectId).toBe('proj-b');
  });

  it('defaults redactions to 0 and tolerates a null issue / actor', () => {
    const saved = recordLogContextAudit({
      projectId: 'proj-a',
      issueId: null,
      action: 'analyze',
      actorUserId: null,
      recordIds: [],
      contextBytes: 0,
      nowMs: NOW,
    });
    expect(saved.redactions).toBe(0);
    expect(saved.recordCount).toBe(0);
    const rows = listLogContextAudit('proj-a');
    expect(rows[0].issueId).toBeNull();
    expect(rows[0].actorUserId).toBeNull();
    expect(rows[0].recordIds).toEqual([]);
  });
});

describe('buildAuditedLogContextPack', () => {
  it('builds the pack AND persists exactly one matching audit row', () => {
    const records = [recordRow(10), recordRow(11), recordRow(12)];
    const { pack, audit } = buildAuditedLogContextPack({
      action: 'analyze',
      actorUserId: 'user-7',
      nowMs: NOW,
      pack: { issue: issueRow(), records },
    });

    // The pack is returned for embedding.
    expect(pack.includedRecordIds).toEqual([10, 11, 12]);
    expect(pack.contextBlock).toContain('BEGIN UNTRUSTED LOG DATA');

    // The audit row is persisted and derived from the pack's own issue.
    const rows = listLogContextAudit('proj-a', 'issue-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(audit.id);
    expect(rows[0].action).toBe('analyze');
    expect(rows[0].actorUserId).toBe('user-7');
    expect(rows[0].projectId).toBe('proj-a');
    expect(rows[0].issueId).toBe('issue-1');
    // The audited record ids are exactly the pack's included ids.
    expect(rows[0].recordIds).toEqual(pack.includedRecordIds);
    expect(rows[0].contextBytes).toBe(pack.contextBytes);
  });

  it('records a fix action under the initiating user', () => {
    buildAuditedLogContextPack({
      action: 'fix',
      actorUserId: 'dev-1',
      nowMs: NOW,
      pack: { issue: issueRow({ id: 'issue-9', project_id: 'proj-z' }), records: [recordRow(1)] },
    });
    const rows = listLogContextAudit('proj-z', 'issue-9');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('fix');
    expect(rows[0].actorUserId).toBe('dev-1');
  });
});
