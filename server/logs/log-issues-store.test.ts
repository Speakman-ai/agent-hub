import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initLogsDb, closeLogsDb, insertLogRecords, type LogRecordInput } from './logs-db.js';
import {
  listIssues,
  getIssue,
  getIssueReleases,
  setIssueStatus,
  setIssueStatuses,
  RECURRENCE_ACTOR,
  claimIssueAnalyzeSession,
  releaseIssueAnalyzeSession,
} from './log-issues-store.js';
import { deriveIssueGrouping } from './log-fingerprint.js';
import { SEVERITY_NUMBER } from './logs-schema.js';

const NOW = 1_800_000_000_000;
const MS = 1_000_000; // ns per ms

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'log-issues-test-'));
  initLogsDb(dir);
});

afterEach(() => {
  closeLogsDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Build a group-eligible record with grouping attached, as ingest would. */
function errRecord(
  projectId: string,
  body: string,
  timeMs: number,
  overrides: Partial<LogRecordInput> & {
    attributes?: Record<string, unknown>;
    resource?: Record<string, unknown>;
  } = {},
): LogRecordInput {
  const { attributes, resource, ...rest } = overrides;
  const grouping = deriveIssueGrouping({
    projectId,
    sourceId: 'src1',
    serviceName: (rest.serviceName as string) ?? 'checkout',
    environment: (rest.environment as string) ?? 'prod',
    severityNumber: rest.severityNumber ?? SEVERITY_NUMBER.ERROR,
    body,
    attributes: attributes ?? {},
    resource: resource ?? {},
  });
  return {
    projectId,
    sourceId: 'src1',
    timeUnixNano: timeMs * MS,
    severityNumber: SEVERITY_NUMBER.ERROR,
    serviceName: 'checkout',
    environment: 'prod',
    body,
    fingerprint: grouping?.fingerprint ?? null,
    grouping,
    ...rest,
  };
}

describe('recordIssueOccurrence — group creation and aggregation', () => {
  it('creates one issue for repeated occurrences and tracks count / first-last seen', () => {
    insertLogRecords([errRecord('p1', 'user 1 failed', 100)], NOW);
    insertLogRecords([errRecord('p1', 'user 2 failed', 50)], NOW); // earlier ts, out of order
    insertLogRecords([errRecord('p1', 'user 3 failed', 200)], NOW);

    const page = listIssues({ projectId: 'p1' });
    expect(page.issues).toHaveLength(1);
    const issue = page.issues[0]!;
    expect(issue.event_count).toBe(3);
    expect(issue.first_seen).toBe(50 * MS);
    expect(issue.last_seen).toBe(200 * MS);
    expect(issue.status).toBe('open');
    expect(issue.first_record_id).not.toBeNull();
    expect(issue.last_record_id).not.toBeNull();
  });

  it('does not create an issue for non-eligible records', () => {
    insertLogRecords(
      [
        {
          projectId: 'p1',
          sourceId: 'src1',
          timeUnixNano: 100 * MS,
          severityNumber: SEVERITY_NUMBER.INFO,
          body: 'just info',
        },
      ],
      NOW,
    );
    expect(listIssues({ projectId: 'p1' }).issues).toHaveLength(0);
  });

  it('separates distinct fingerprints into distinct issues', () => {
    insertLogRecords(
      [
        errRecord('p1', 'db timeout', 100, { attributes: { 'exception.type': 'DBError' } }),
        errRecord('p1', 'null deref', 100, { attributes: { 'exception.type': 'TypeError' } }),
      ],
      NOW,
    );
    expect(listIssues({ projectId: 'p1' }).issues).toHaveLength(2);
  });

  it('scopes issues per project', () => {
    insertLogRecords([errRecord('p1', 'x failed', 100)], NOW);
    insertLogRecords([errRecord('p2', 'x failed', 100)], NOW);
    expect(listIssues({ projectId: 'p1' }).issues).toHaveLength(1);
    expect(listIssues({ projectId: 'p2' }).issues).toHaveLength(1);
  });
});

describe('release / commit facets', () => {
  it('accumulates affected releases and commits as facets under one issue', () => {
    insertLogRecords(
      [
        errRecord('p1', 'x failed', 100, {
          resource: { 'service.version': '1.0.0', 'git.commit.sha': 'aaa111' },
        }),
      ],
      NOW,
    );
    insertLogRecords(
      [
        errRecord('p1', 'x failed', 110, {
          resource: { 'service.version': '2.0.0', 'git.commit.sha': 'bbb222' },
        }),
      ],
      NOW,
    );
    insertLogRecords(
      [
        errRecord('p1', 'x failed', 120, {
          resource: { 'service.version': '2.0.0', 'git.commit.sha': 'bbb222' },
        }),
      ],
      NOW,
    );

    const issue = listIssues({ projectId: 'p1' }).issues[0]!;
    expect(issue.event_count).toBe(3);
    const releases = getIssueReleases(issue.id);
    expect(releases).toHaveLength(2);
    const v2 = releases.find((r) => r.release === '2.0.0')!;
    expect(v2.commit_sha).toBe('bbb222');
    expect(v2.event_count).toBe(2);
  });
});

describe('recurrence and lifecycle', () => {
  it('reopens a resolved issue when it recurs, attributed to the system', () => {
    insertLogRecords([errRecord('p1', 'x failed', 100)], NOW);
    let issue = listIssues({ projectId: 'p1' }).issues[0]!;
    setIssueStatus('p1', issue.id, 'resolved', 'user-a', NOW);
    expect(getIssue('p1', issue.id)!.status).toBe('resolved');

    // Recurrence.
    insertLogRecords([errRecord('p1', 'x failed', 300)], NOW + 1000);
    issue = getIssue('p1', issue.id)!;
    expect(issue.status).toBe('open');
    expect(issue.status_updated_by).toBe(RECURRENCE_ACTOR);
    expect(issue.event_count).toBe(2);
  });

  it('keeps an ignored issue muted on recurrence', () => {
    insertLogRecords([errRecord('p1', 'x failed', 100)], NOW);
    const issue = listIssues({ projectId: 'p1' }).issues[0]!;
    setIssueStatus('p1', issue.id, 'ignored', 'user-a', NOW);

    insertLogRecords([errRecord('p1', 'x failed', 300)], NOW + 1000);
    const after = getIssue('p1', issue.id)!;
    expect(after.status).toBe('ignored');
    expect(after.event_count).toBe(2);
  });

  it('setIssueStatus is project-scoped and returns null for a foreign id', () => {
    insertLogRecords([errRecord('p1', 'x failed', 100)], NOW);
    const issue = listIssues({ projectId: 'p1' }).issues[0]!;
    expect(setIssueStatus('p2', issue.id, 'resolved', 'user-a', NOW)).toBeNull();
    expect(getIssue('p2', issue.id)).toBeNull();
  });

  it('setIssueStatuses transitions a whole batch, deduplicating repeated ids', () => {
    insertLogRecords(
      [errRecord('p1', 'alpha failed', 100), errRecord('p1', 'beta failed', 200)],
      NOW,
    );
    const ids = listIssues({ projectId: 'p1' }).issues.map((i) => i.id);
    expect(ids).toHaveLength(2);

    const result = setIssueStatuses('p1', [...ids, ids[0]!], 'resolved', 'user-a', NOW);
    expect(result.updated.map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(result.notFound).toEqual([]);
    expect(result.updated.every((i) => i.status === 'resolved')).toBe(true);
    expect(result.updated.every((i) => i.status_updated_by === 'user-a')).toBe(true);
  });

  it('setIssueStatuses leaves foreign-project ids untouched and reports them', () => {
    insertLogRecords([errRecord('p1', 'x failed', 100)], NOW);
    const issue = listIssues({ projectId: 'p1' }).issues[0]!;

    const result = setIssueStatuses('p2', [issue.id, 'nope'], 'resolved', 'user-a', NOW);
    expect(result.updated).toEqual([]);
    expect(result.notFound).toEqual([issue.id, 'nope']);
    expect(getIssue('p1', issue.id)!.status).toBe('open');
  });

  it('atomically allows only one Analyze claim and supports stale-claim replacement', () => {
    insertLogRecords([errRecord('p1', 'x failed', 100)], NOW);
    const issue = listIssues({ projectId: 'p1' }).issues[0]!;

    expect(claimIssueAnalyzeSession('p1', issue.id, 'session-a')).toEqual({
      claimed: true,
      sessionId: 'session-a',
    });
    expect(claimIssueAnalyzeSession('p1', issue.id, 'session-b')).toEqual({
      claimed: false,
      sessionId: 'session-a',
    });
    expect(getIssue('p1', issue.id)?.analyze_session_id).toBe('session-a');

    expect(claimIssueAnalyzeSession('p1', issue.id, 'session-b', 'session-a')).toEqual({
      claimed: true,
      sessionId: 'session-b',
    });
    expect(getIssue('p1', issue.id)?.analyze_session_id).toBe('session-b');
    releaseIssueAnalyzeSession('p1', issue.id, 'session-b');
    expect(getIssue('p1', issue.id)?.analyze_session_id).toBeNull();
  });
});

describe('listIssues — filtering and pagination', () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) {
      insertLogRecords(
        [errRecord('p1', 'x failed', 100 + i, { attributes: { 'exception.type': `E${i}` } })],
        NOW,
      );
    }
  });

  it('filters by status', () => {
    const issues = listIssues({ projectId: 'p1' }).issues;
    setIssueStatus('p1', issues[0]!.id, 'resolved', 'u', NOW);
    expect(listIssues({ projectId: 'p1', status: 'open' }).issues).toHaveLength(4);
    expect(listIssues({ projectId: 'p1', status: 'resolved' }).issues).toHaveLength(1);
  });

  it('paginates newest-activity-first with a stable cursor', () => {
    const first = listIssues({ projectId: 'p1', limit: 2 });
    expect(first.issues).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = listIssues({ projectId: 'p1', limit: 2, cursor: first.nextCursor! });
    expect(second.issues).toHaveLength(2);
    const ids = new Set([...first.issues, ...second.issues].map((i) => i.id));
    expect(ids.size).toBe(4); // no overlap across pages
  });
});
