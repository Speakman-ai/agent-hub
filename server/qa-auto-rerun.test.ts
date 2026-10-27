import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts, initDb } from './db.js';
import { getOrCreateBoard } from './routes/board.js';
import {
  approveQaPlan,
  completeQaRunIfCovered,
  markQaRunRunning,
  recordQaResult,
  startQaRun,
} from './qa-status.js';
import type { QaRunLaunchDeps } from './qa-run-launch.js';
import { mapBroadcastToNotification } from './notification-fanout.js';
import type { QaVerdict } from './types.js';

const launchQaRun = vi.fn();
vi.mock('./qa-run-launch.js', () => ({
  launchQaRun: (...a: unknown[]) => launchQaRun(...a),
}));

const {
  describeQaAutoRerun,
  evaluateQaAutoRerun,
  processQaAutoRerun,
  qaAutoRerunProjectFor,
  sweepProjectQaAutoRerun,
} = await import('./qa-auto-rerun.js');

const PROJECT = 'qa-auto-rerun-proj';
const broadcast = vi.fn();
const deps = { broadcast, findProject: () => null } as unknown as QaRunLaunchDeps;

let boardId: string;
let todoColumn: string;
let doneColumn: string;

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-auto-rerun-')));
  const { board, columns } = getOrCreateBoard(getStmts(), PROJECT);
  boardId = board.id;
  todoColumn = columns.find((c) => c.name === 'To Do')!.id;
  doneColumn = columns.find((c) => c.name === 'Done')!.id;
});

beforeEach(() => {
  getDb().exec('DELETE FROM qa_plans');
  getDb().exec('DELETE FROM deployments');
  getDb().exec('DELETE FROM pull_requests');
  getDb().exec(`DELETE FROM kanban_cards WHERE board_id = '${boardId}'`);
  broadcast.mockClear();
  launchQaRun.mockReset().mockResolvedValue({ ok: true });
});

function plan(opts: { env?: string | null; autoRerun?: boolean; maxIterations?: number } = {}) {
  const s = getStmts();
  const planId = randomUUID();
  s.insertQaPlan.run(
    planId,
    PROJECT,
    'Checkout',
    '',
    'https://staging.example.com',
    null,
    null,
    opts.env ?? null,
    opts.autoRerun === false ? 0 : 1,
    opts.maxIterations ?? 5,
    'owner-1',
  );
  const caseIds = ['Login', 'Pay'].map((title, i) => {
    const id = randomUUID();
    s.insertQaCase.run(id, planId, i, title, '', '');
    return id;
  });
  approveQaPlan(planId, 'owner-1');
  return { planId, caseIds };
}

function card(): string {
  const id = randomUUID();
  getStmts().createKanbanCard.run(
    id,
    todoColumn,
    boardId,
    'QA: fix',
    '',
    'high',
    null,
    'qa-finding',
    null,
    null,
    'owner-1',
    null,
    0,
  );
  return id;
}

function markDone(cardId: string, at: string) {
  getDb().prepare('UPDATE kanban_cards SET column_id = ? WHERE id = ?').run(doneColumn, cardId);
  getDb().prepare('UPDATE kanban_cards SET completed_at = ? WHERE id = ?').run(at, cardId);
}

/** A finished run; each failing case gets the finding card given in `cards`. */
function failedRun(
  planId: string,
  verdicts: Record<string, QaVerdict>,
  cards: Record<string, string> = {},
  scope: 'full' | 'failed_only' = 'full',
) {
  const { run } = startQaRun(planId, { scope, startedBy: 'owner-1' });
  markQaRunRunning(run.id);
  for (const [caseId, verdict] of Object.entries(verdicts)) {
    recordQaResult(run.id, caseId, { verdict, findingCardId: cards[caseId] ?? null });
  }
  return completeQaRunIfCovered(run.id)!;
}

function deployment(env: string, status: string, createdAt: string) {
  getDb()
    .prepare(
      `INSERT INTO deployments (id, project_id, environment, ref, status, created_at, completed_at)
       VALUES (?, ?, ?, 'abc123', ?, ?, ?)`,
    )
    .run(randomUUID(), PROJECT, env, status, createdAt, createdAt);
}

let prNumber = 0;
function mergedPr(branch: string, mergedAt: string) {
  const at = Date.parse(`${mergedAt.replace(' ', 'T')}Z`);
  getDb()
    .prepare(
      `INSERT INTO pull_requests
         (id, project_id, number, title, head_branch, base_branch, head_sha, status, author,
          created_at, updated_at, merged_at)
       VALUES (?, ?, ?, 'fix', 'fix-branch', ?, 'abc123', 'merged', 'dev', ?, ?, ?)`,
    )
    .run(randomUUID(), PROJECT, ++prNumber, branch, at, at, at);
}

function mergeTrigger(planId: string, branch: string | null, delayMinutes = 0) {
  getDb()
    .prepare(
      `UPDATE qa_plans SET auto_rerun_trigger = 'merge', auto_rerun_branch = ?,
         auto_rerun_delay_minutes = ? WHERE id = ?`,
    )
    .run(branch, delayMinutes, planId);
}

const attention = () =>
  broadcast.mock.calls.map((c) => c[0]).filter((d) => d.type === 'qa_attention');

describe('evaluateQaAutoRerun', () => {
  it('waits while any finding card from the latest run is not Done', () => {
    const { planId, caseIds } = plan({ env: 'staging' });
    const [a, b] = [card(), card()];
    failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'needs_change' },
      {
        [caseIds[0]!]: a,
        [caseIds[1]!]: b,
      },
    );
    markDone(a, '2026-10-26 10:00:00');
    expect(evaluateQaAutoRerun(planId)).toMatchObject({ kind: 'wait_fixes', pending: 1 });
  });

  it('does nothing when auto-rerun is off, the run passed, or a finding has no card', () => {
    const off = plan({ autoRerun: false });
    const c = card();
    failedRun(
      off.planId,
      { [off.caseIds[0]!]: 'fail', [off.caseIds[1]!]: 'pass' },
      {
        [off.caseIds[0]!]: c,
      },
    );
    markDone(c, '2026-10-26 10:00:00');
    expect(evaluateQaAutoRerun(off.planId).kind).toBe('idle');

    const passed = plan();
    failedRun(passed.planId, { [passed.caseIds[0]!]: 'pass', [passed.caseIds[1]!]: 'pass' });
    expect(evaluateQaAutoRerun(passed.planId).kind).toBe('idle');

    const blockedOnly = plan();
    failedRun(blockedOnly.planId, {
      [blockedOnly.caseIds[0]!]: 'blocked',
      [blockedOnly.caseIds[1]!]: 'pass',
    });
    expect(evaluateQaAutoRerun(blockedOnly.planId)).toMatchObject({ kind: 'idle' });

    const noCard = plan();
    failedRun(noCard.planId, { [noCard.caseIds[0]!]: 'fail', [noCard.caseIds[1]!]: 'pass' });
    expect(evaluateQaAutoRerun(noCard.planId).kind).toBe('wait_fixes');
  });

  it('with a linked environment, waits for a successful deploy triggered after the last fix', () => {
    const { planId, caseIds } = plan({ env: 'staging' });
    const [a, b] = [card(), card()];
    failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'fail' },
      {
        [caseIds[0]!]: a,
        [caseIds[1]!]: b,
      },
    );
    markDone(a, '2026-10-26 10:00:00');
    markDone(b, '2026-10-26 11:00:00');
    expect(evaluateQaAutoRerun(planId)).toMatchObject({
      kind: 'wait_deploy',
      fixesDoneAt: '2026-10-26 11:00:00',
    });
    // Before the last fix, failed, or to another environment: none count.
    deployment('staging', 'success', '2026-10-26 10:30:00');
    deployment('staging', 'error', '2026-10-26 11:30:00');
    deployment('production', 'success', '2026-10-26 11:30:00');
    expect(evaluateQaAutoRerun(planId).kind).toBe('wait_deploy');
    deployment('staging', 'success', '2026-10-26 11:45:00');
    expect(evaluateQaAutoRerun(planId)).toMatchObject({ kind: 'rerun', target: 'staging' });
  });

  it('with a merge trigger, waits for a merge into the branch that carries the last fix', () => {
    const { planId, caseIds } = plan({ env: 'staging' });
    mergeTrigger(planId, 'release');
    const c = card();
    const run = failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' },
      { [caseIds[0]!]: c },
    );
    getDb()
      .prepare("UPDATE qa_runs SET finished_at = '2026-10-26 09:00:00' WHERE id = ?")
      .run(run.id);
    markDone(c, '2026-10-26 11:00:00');
    expect(evaluateQaAutoRerun(planId)).toMatchObject({ kind: 'wait_merge', branch: 'release' });

    // A deploy does not count, nor a merge well before the fix or into another branch.
    deployment('staging', 'success', '2026-10-26 11:30:00');
    mergedPr('release', '2026-10-26 10:00:00');
    mergedPr('main', '2026-10-26 11:30:00');
    expect(evaluateQaAutoRerun(planId).kind).toBe('wait_merge');

    // The merge that moved the card to Done lands a moment before it.
    mergedPr('release', '2026-10-26 10:59:58');
    expect(evaluateQaAutoRerun(planId)).toMatchObject({ kind: 'rerun', target: 'release' });
  });

  it('with a merge delay, waits until the delay after the merge ends', () => {
    const { planId, caseIds } = plan();
    mergeTrigger(planId, 'main', 15);
    const c = card();
    const run = failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' },
      { [caseIds[0]!]: c },
    );
    getDb()
      .prepare("UPDATE qa_runs SET finished_at = '2026-10-26 09:00:00' WHERE id = ?")
      .run(run.id);
    markDone(c, '2026-10-26 11:00:00');
    mergedPr('main', '2026-10-26 11:00:00');
    const mergedAt = Date.parse('2026-10-26T11:00:00Z');
    expect(evaluateQaAutoRerun(planId, mergedAt + 14 * 60_000)).toMatchObject({
      kind: 'wait_delay',
      dueAt: mergedAt + 15 * 60_000,
    });
    expect(evaluateQaAutoRerun(planId, mergedAt + 15 * 60_000)).toMatchObject({
      kind: 'rerun',
    });
  });

  it('anchors the delay to the merge carrying the last fix, not an earlier one', () => {
    const { planId, caseIds } = plan();
    mergeTrigger(planId, 'main', 15);
    const [a, b] = [card(), card()];
    const run = failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'fail' },
      { [caseIds[0]!]: a, [caseIds[1]!]: b },
    );
    getDb()
      .prepare("UPDATE qa_runs SET finished_at = '2026-10-26 09:00:00' WHERE id = ?")
      .run(run.id);
    mergedPr('main', '2026-10-26 11:00:00');
    markDone(a, '2026-10-26 11:00:00');
    mergedPr('main', '2026-10-26 11:04:00');
    markDone(b, '2026-10-26 11:04:00');
    mergedPr('main', '2026-10-26 11:30:00');
    const lastFix = Date.parse('2026-10-26T11:04:00Z');
    expect(evaluateQaAutoRerun(planId, lastFix + 15 * 60_000 - 1)).toMatchObject({
      kind: 'wait_delay',
      dueAt: lastFix + 15 * 60_000,
    });
  });

  it('with no merge near the last fix, waits for the first merge after it', () => {
    const { planId, caseIds } = plan();
    mergeTrigger(planId, 'release', 5);
    const c = card();
    const run = failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' },
      { [caseIds[0]!]: c },
    );
    getDb()
      .prepare("UPDATE qa_runs SET finished_at = '2026-10-26 09:00:00' WHERE id = ?")
      .run(run.id);
    markDone(c, '2026-10-26 11:00:00');
    mergedPr('release', '2026-10-26 12:00:00');
    mergedPr('release', '2026-10-26 13:00:00');
    expect(evaluateQaAutoRerun(planId, Date.parse('2026-10-26T12:01:00Z'))).toMatchObject({
      kind: 'wait_delay',
      dueAt: Date.parse('2026-10-26T12:05:00Z'),
    });
  });

  it('with a fixes-merged trigger, reruns once the last fix is Done, after the delay', () => {
    const { planId, caseIds } = plan();
    getDb()
      .prepare(
        `UPDATE qa_plans SET auto_rerun_trigger = 'fixes_merged', auto_rerun_delay_minutes = 10
          WHERE id = ?`,
      )
      .run(planId);
    const [a, b] = [card(), card()];
    failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'needs_change' },
      {
        [caseIds[0]!]: a,
        [caseIds[1]!]: b,
      },
    );
    markDone(a, '2026-10-26 10:00:00');
    expect(evaluateQaAutoRerun(planId).kind).toBe('wait_fixes');

    // No deploy or branch merge needed: the delay runs from the last card's Done.
    markDone(b, '2026-10-26 11:00:00');
    const doneAt = Date.parse('2026-10-26T11:00:00Z');
    expect(evaluateQaAutoRerun(planId, doneAt + 9 * 60_000)).toMatchObject({
      kind: 'wait_delay',
      dueAt: doneAt + 10 * 60_000,
    });
    expect(describeQaAutoRerun(planId)).not.toBeNull();
    expect(evaluateQaAutoRerun(planId, doneAt + 10 * 60_000)).toMatchObject({ kind: 'rerun' });

    getDb().prepare('UPDATE qa_plans SET auto_rerun_delay_minutes = 0 WHERE id = ?').run(planId);
    expect(evaluateQaAutoRerun(planId, doneAt)).toMatchObject({ kind: 'rerun' });
    expect(describeQaAutoRerun(planId)?.message).toBe('The fixes merged; a rerun is starting.');
  });

  it('with a merge trigger and no branch, asks for a manual rerun', () => {
    const { planId, caseIds } = plan({ env: 'staging' });
    mergeTrigger(planId, null);
    const c = card();
    failedRun(planId, { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' }, { [caseIds[0]!]: c });
    markDone(c, '2026-10-26 10:00:00');
    expect(evaluateQaAutoRerun(planId).kind).toBe('notify_manual');
    expect(describeQaAutoRerun(planId)?.message).toContain('no branch is chosen');
  });

  it('stops at max_iterations even when fixes are deployed', () => {
    const { planId, caseIds } = plan({ env: 'staging', maxIterations: 1 });
    const c = card();
    failedRun(planId, { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' }, { [caseIds[0]!]: c });
    markDone(c, '2026-10-26 10:00:00');
    deployment('staging', 'success', '2026-10-26 10:05:00');
    expect(evaluateQaAutoRerun(planId).kind).toBe('cap_reached');
  });
});

describe('processQaAutoRerun', () => {
  it('reruns failed cases once, as the plan owner, after the deploy', async () => {
    const { planId, caseIds } = plan({ env: 'staging' });
    const c = card();
    failedRun(planId, { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' }, { [caseIds[0]!]: c });
    markDone(c, '2026-10-26 10:00:00');
    expect(await processQaAutoRerun(deps, planId)).toBe('waiting');
    deployment('staging', 'success', '2026-10-26 10:05:00');

    expect(await processQaAutoRerun(deps, planId)).toBe('rerun_started');
    expect(launchQaRun).toHaveBeenCalledTimes(1);
    expect(launchQaRun.mock.calls[0]![1]).toMatchObject({ id: planId });
    expect(launchQaRun.mock.calls[0]![2]).toEqual({
      scope: 'failed_only',
      startedBy: null,
      ownerUserId: 'owner-1',
    });
    expect(await processQaAutoRerun(deps, planId)).toBe('already_handled');
    expect(launchQaRun).toHaveBeenCalledTimes(1);
    expect(attention()).toHaveLength(0);
  });

  it('without an environment, notifies the owner once that a manual rerun is needed', async () => {
    const { planId, caseIds } = plan();
    const c = card();
    const run = failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' },
      {
        [caseIds[0]!]: c,
      },
    );
    markDone(c, '2026-10-26 10:00:00');
    expect(describeQaAutoRerun(planId)?.kind).toBe('notify_manual');

    expect(await processQaAutoRerun(deps, planId)).toBe('manual_notified');
    expect(await processQaAutoRerun(deps, planId)).toBe('already_handled');
    expect(launchQaRun).not.toHaveBeenCalled();
    const notices = attention();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      projectId: PROJECT,
      planId,
      runId: run.id,
      reason: 'manual_rerun_needed',
      notifyUserIds: ['owner-1'],
    });
    expect(mapBroadcastToNotification(notices[0])).toMatchObject({
      category: 'qa_attention',
      title: 'Checkout: ready for a rerun',
      sourceKey: `qa_attention:${run.id}:manual_rerun_needed`,
      recipients: { kind: 'users', userIds: ['owner-1'] },
    });

    // Linking an environment later still lets the deploy trigger the rerun.
    getDb().prepare("UPDATE qa_plans SET deploy_environment = 'staging' WHERE id = ?").run(planId);
    deployment('staging', 'success', '2026-10-26 10:05:00');
    expect(await processQaAutoRerun(deps, planId)).toBe('rerun_started');
  });

  it('notifies the owner once when a failed run hits the cap, and never reruns', async () => {
    const { planId, caseIds } = plan({ env: 'staging', maxIterations: 2 });
    failedRun(planId, { [caseIds[0]!]: 'blocked', [caseIds[1]!]: 'pass' });
    expect(await processQaAutoRerun(deps, planId)).toBe('idle');

    const c = card();
    const second = failedRun(
      planId,
      { [caseIds[0]!]: 'fail' },
      { [caseIds[0]!]: c },
      'failed_only',
    );
    expect(second.iteration).toBe(2);
    expect(await processQaAutoRerun(deps, planId)).toBe('cap_notified');
    markDone(c, '2026-10-26 10:00:00');
    deployment('staging', 'success', '2026-10-26 10:05:00');
    expect(await processQaAutoRerun(deps, planId)).toBe('already_handled');
    expect(launchQaRun).not.toHaveBeenCalled();
    expect(attention()).toEqual([
      expect.objectContaining({ reason: 'cap_reached', runId: second.id, iteration: 2 }),
    ]);
    expect(describeQaAutoRerun(planId)?.kind).toBe('cap_reached');
    expect(getStmts().getQaPlan.get(planId)!.status).toBe('in_progress');
  });

  it('resumes once after the owner raises the cap', async () => {
    const { planId, caseIds } = plan({ env: 'staging', maxIterations: 1 });
    const c = card();
    failedRun(planId, { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' }, { [caseIds[0]!]: c });
    expect(await processQaAutoRerun(deps, planId)).toBe('cap_notified');

    getDb().prepare('UPDATE qa_plans SET max_iterations = 3 WHERE id = ?').run(planId);
    expect(await processQaAutoRerun(deps, planId)).toBe('waiting');
    markDone(c, '2026-10-26 10:00:00');
    deployment('staging', 'success', '2026-10-26 10:05:00');
    expect(describeQaAutoRerun(planId)?.kind).toBe('rerun');

    expect(await processQaAutoRerun(deps, planId)).toBe('rerun_started');
    expect(await processQaAutoRerun(deps, planId)).toBe('already_handled');
    expect(launchQaRun).toHaveBeenCalledTimes(1);
  });

  it('sends the cap notice when the cap is lowered after a manual-rerun notice', async () => {
    const { planId, caseIds } = plan();
    const c = card();
    const run = failedRun(
      planId,
      { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' },
      {
        [caseIds[0]!]: c,
      },
    );
    markDone(c, '2026-10-26 10:00:00');
    expect(await processQaAutoRerun(deps, planId)).toBe('manual_notified');

    getDb().prepare('UPDATE qa_plans SET max_iterations = 1 WHERE id = ?').run(planId);
    expect(await processQaAutoRerun(deps, planId)).toBe('cap_notified');
    expect(await processQaAutoRerun(deps, planId)).toBe('already_handled');
    expect(attention().map((n) => n.reason)).toEqual(['manual_rerun_needed', 'cap_reached']);
    expect(attention()[1]).toMatchObject({ runId: run.id });
    expect(launchQaRun).not.toHaveBeenCalled();
  });

  it('notifies the owner when the automatic rerun cannot start', async () => {
    launchQaRun.mockResolvedValue({ ok: false, error: 'This project has no QA agent.' });
    const { planId, caseIds } = plan({ env: 'staging' });
    const c = card();
    failedRun(planId, { [caseIds[0]!]: 'fail', [caseIds[1]!]: 'pass' }, { [caseIds[0]!]: c });
    markDone(c, '2026-10-26 10:00:00');
    deployment('staging', 'success', '2026-10-26 10:05:00');
    expect(await processQaAutoRerun(deps, planId)).toBe('rerun_failed');
    expect(attention()[0]).toMatchObject({
      reason: 'auto_rerun_failed',
      message: expect.stringContaining('This project has no QA agent.'),
    });
    expect(await processQaAutoRerun(deps, planId)).toBe('already_handled');
    expect(describeQaAutoRerun(planId)?.kind).toBe('rerun_failed');
  });

  it('sweeps only the project plans auto-rerun can act on', async () => {
    const on = plan();
    const off = plan({ autoRerun: false });
    for (const p of [on, off]) {
      const c = card();
      failedRun(
        p.planId,
        { [p.caseIds[0]!]: 'fail', [p.caseIds[1]!]: 'pass' },
        {
          [p.caseIds[0]!]: c,
        },
      );
      markDone(c, '2026-10-26 10:00:00');
    }
    expect(await sweepProjectQaAutoRerun(deps, PROJECT)).toEqual(['manual_notified']);
  });
});

describe('qaAutoRerunProjectFor', () => {
  it('reacts to card moves, successful deploys, and plan setting changes', () => {
    expect(qaAutoRerunProjectFor({ type: 'kanban_update', projectId: 'p' })).toBe('p');
    expect(
      qaAutoRerunProjectFor({
        type: 'deployment_update',
        projectId: 'p',
        deployment: { status: 'success' },
      }),
    ).toBe('p');
    expect(
      qaAutoRerunProjectFor({
        type: 'deployment_update',
        projectId: 'p',
        deployment: { status: 'running' },
      }),
    ).toBeNull();
    expect(
      qaAutoRerunProjectFor({ type: 'qa_update', projectId: 'p', action: 'plan_updated' }),
    ).toBe('p');
    expect(
      qaAutoRerunProjectFor({ type: 'qa_update', projectId: 'p', action: 'run_started' }),
    ).toBeNull();
    expect(
      qaAutoRerunProjectFor({ type: 'native_pr_update', projectId: 'p', action: 'merged' }),
    ).toBe('p');
    expect(
      qaAutoRerunProjectFor({ type: 'native_pr_update', projectId: 'p', action: 'edited' }),
    ).toBeNull();
    expect(qaAutoRerunProjectFor({ type: 'kanban_update' })).toBeNull();
  });
});
