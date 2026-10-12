/**
 * Scheduled auto-merge ticker against the real test DB statements, so the
 * claim / retry / recovery SQL is exercised. Only the merge itself is mocked.
 */
import '../test/setup.js';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { getDb, getStmts } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import {
  runDueScheduledAutoMerges,
  SCHEDULED_AUTO_MERGE_RETRY_MS,
} from './scheduled-auto-merge.js';
import type { PullRequestRow, Stmts } from '../types.js';
import type { NativePrService } from './service.js';

const P = 'proj-scheduled-auto-merge';
const T = Date.parse('2026-10-13T14:30:00Z');
const hosted = { id: P, gitHost: 'agenthub' } as any;
let stmts: Stmts;

function insertPr(number: number, scheduledAt: number | null): string {
  const id = `pr-${number}`;
  stmts.insertPullRequest.run(id, P, number, 't', '', `b${number}`, 'main', 'sha', 'me', 1, 1);
  if (scheduledAt !== null) stmts.setPullRequestAutoMergeAt.run(scheduledAt, 1, id);
  return id;
}

function row(number: number): PullRequestRow {
  return stmts.getPullRequestByNumber.get(P, number) as PullRequestRow;
}

/** Merge mock: each call consumes the next outcome; `ok` marks the row merged. */
function mergeMock(outcomes: Array<'ok' | 'not-ready' | 'throw'>) {
  return vi.fn(async ({ number }: { number: number }) => {
    const next = outcomes.shift() ?? 'ok';
    if (next === 'throw') throw new Error('git lock held');
    if (next === 'not-ready') return { ok: false, status: 409, error: 'checks pending' };
    stmts.markPullRequestMerged.run('m', 'auto-merge', 'squash', T, T, row(number).id);
    return { ok: true };
  });
}

function deps(merge: ReturnType<typeof mergeMock>, now: number, project: any = hosted) {
  return {
    stmts,
    nativePr: { merge } as unknown as NativePrService,
    broadcast: vi.fn(),
    getProject: () => project,
    now: () => now,
  };
}

beforeEach(() => {
  stmts = getStmts();
  wipeTables(getDb(), ['pull_requests']);
});

describe('runDueScheduledAutoMerges', () => {
  it('does nothing before the scheduled time, then arms and merges at it', async () => {
    insertPr(1, T);
    const merge = mergeMock(['ok']);
    expect(await runDueScheduledAutoMerges(deps(merge, T - 1000))).toEqual([]);
    expect(row(1)).toMatchObject({ status: 'open', auto_merge: 0 });

    const d = deps(merge, T);
    expect(await runDueScheduledAutoMerges(d)).toEqual([{ projectId: P, number: 1, merged: true }]);
    expect(row(1)).toMatchObject({ status: 'merged', auto_merge_at: null });
    expect(d.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 1, action: 'auto_merge_enabled' }),
    );
  });

  it('retries a transient merge failure after the backoff, not on the next tick', async () => {
    insertPr(1, T);
    const merge = mergeMock(['throw', 'ok']);

    const first = await runDueScheduledAutoMerges(deps(merge, T));
    expect(first).toEqual([{ projectId: P, number: 1, merged: false, reason: 'git lock held' }]);
    // Still scheduled (retryable) and armed.
    expect(row(1)).toMatchObject({ status: 'open', auto_merge: 1, auto_merge_at: T });

    expect(await runDueScheduledAutoMerges(deps(merge, T + 30_000))).toEqual([]);
    const retry = await runDueScheduledAutoMerges(deps(merge, T + SCHEDULED_AUTO_MERGE_RETRY_MS));
    expect(retry).toEqual([{ projectId: P, number: 1, merged: true }]);
    expect(merge).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying a not-yet-mergeable PR until it merges', async () => {
    insertPr(1, T);
    const merge = mergeMock(['not-ready', 'ok']);
    await runDueScheduledAutoMerges(deps(merge, T));
    expect(row(1)).toMatchObject({ status: 'open', auto_merge: 1 });
    await runDueScheduledAutoMerges(deps(merge, T + SCHEDULED_AUTO_MERGE_RETRY_MS));
    expect(row(1).status).toBe('merged');
  });

  it('recovers an attempt interrupted by a process exit after the claim', async () => {
    const id = insertPr(1, T);
    // A crash right after the claim leaves the row armed with a stamped attempt.
    stmts.claimScheduledAutoMergeAttempt.run(T, T, id, T, T - SCHEDULED_AUTO_MERGE_RETRY_MS);
    expect(row(1)).toMatchObject({ auto_merge: 1, auto_merge_attempted_at: T });

    const merge = mergeMock(['ok']);
    const out = await runDueScheduledAutoMerges(deps(merge, T + SCHEDULED_AUTO_MERGE_RETRY_MS));
    expect(out).toEqual([{ projectId: P, number: 1, merged: true }]);
  });

  it('stops retrying once the PR is disarmed or closed', async () => {
    const a = insertPr(1, T);
    const b = insertPr(2, T);
    const merge = mergeMock(['not-ready', 'not-ready']);
    await runDueScheduledAutoMerges(deps(merge, T));
    stmts.setPullRequestAutoMerge.run(0, T, a);
    stmts.markPullRequestClosed.run(T, T, b);
    expect(
      await runDueScheduledAutoMerges(deps(merge, T + 2 * SCHEDULED_AUTO_MERGE_RETRY_MS)),
    ).toEqual([]);
    expect(merge).toHaveBeenCalledTimes(2);
  });

  it('skips PRs whose project is gone or no longer Hub-hosted', async () => {
    insertPr(1, T);
    const merge = mergeMock(['ok']);
    for (const project of [null, { id: P, gitHost: 'github' }]) {
      expect(await runDueScheduledAutoMerges(deps(merge, T, project))).toEqual([]);
    }
    expect(row(1)).toMatchObject({ auto_merge: 0, auto_merge_attempted_at: null });
  });
});
