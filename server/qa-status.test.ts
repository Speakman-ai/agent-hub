import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getStmts, initDb } from './db.js';
import {
  addQaCase,
  approveQaPlan,
  cancelQaRun,
  completeQaRunIfCovered,
  editQaCase,
  finishQaRun,
  markQaRunRunning,
  recordQaResult,
  removeQaCase,
  nextQaPlanStatus,
  qaPlanSignOffBlocker,
  qaRunCaseIds,
  qaRunScopeCaseIds,
  QaStatusError,
  revokeQaPlanApproval,
  signOffQaPlan,
  startQaRun,
} from './qa-status.js';
import type { QaPlanStatus, QaVerdict } from './types.js';

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-status-')));
});

beforeEach(() => {
  getDb().exec('DELETE FROM qa_plans');
});

function makePlan(caseCount = 2): { planId: string; caseIds: string[] } {
  const s = getStmts();
  const planId = randomUUID();
  s.insertQaPlan.run(
    planId,
    'proj',
    'Plan',
    'goal',
    'https://example.com',
    null,
    null,
    null,
    1,
    5,
    'u1',
  );
  const caseIds = Array.from({ length: caseCount }, (_, i) => {
    const id = randomUUID();
    s.insertQaCase.run(id, planId, i, `Case ${i}`, 'steps', 'expected');
    return id;
  });
  return { planId, caseIds };
}

function record(runId: string, caseId: string, verdict: QaVerdict): void {
  recordQaResult(runId, caseId, { verdict });
}

/** Queue a run and move it to running, ready for results. */
function begin(planId: string, scope: 'full' | 'failed_only' = 'full') {
  const { run } = startQaRun(planId, { scope });
  return markQaRunRunning(run.id);
}

function passRun(planId: string, caseIds: string[], scope: 'full' | 'failed_only' = 'full') {
  const run = begin(planId, scope);
  for (const id of caseIds) record(run.id, id, 'pass');
  return finishQaRun(run.id);
}

function expectQaError(fn: () => unknown, code: string, status: number): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(QaStatusError);
    expect((err as QaStatusError).code).toBe(code);
    expect((err as QaStatusError).status).toBe(status);
    return;
  }
  throw new Error(`expected QaStatusError ${code}`);
}

describe('QA schema migration', () => {
  it('creates the four tables with indexes on project/plan/run', () => {
    const db = getDb();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'qa_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables.sort()).toEqual([
      'qa_cases',
      'qa_environments',
      'qa_plans',
      'qa_results',
      'qa_runs',
    ]);

    const indexedColumns = (table: string) =>
      (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map(
        (idx) =>
          (db.prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string }[])[0]?.name,
      );
    expect(indexedColumns('qa_plans')).toContain('project_id');
    expect(indexedColumns('qa_cases')).toContain('plan_id');
    expect(indexedColumns('qa_runs')).toContain('plan_id');
    expect(indexedColumns('qa_results')).toContain('run_id');
  });

  it('is idempotent across re-init', () => {
    const { planId } = makePlan(1);
    const dir = path.dirname(getDb().name);
    initDb(dir);
    expect(getStmts().getQaPlan.get(planId)?.status).toBe('new');
  });

  it('applies defaults and rejects out-of-range enums', () => {
    const { planId, caseIds } = makePlan(1);
    const plan = getStmts().getQaPlan.get(planId)!;
    expect(plan).toMatchObject({
      status: 'new',
      auto_rerun: 1,
      max_iterations: 5,
      approved_at: null,
    });
    expect(getStmts().getQaCase.get(caseIds[0])?.version).toBe(1);

    expect(() => getStmts().setQaPlanStatus.run('bogus' as QaPlanStatus, planId)).toThrow(/CHECK/);
    approveQaPlan(planId, 'u1');
    const run = begin(planId);
    expect(() => record(run.id, caseIds[0], 'maybe' as QaVerdict)).toThrow(/CHECK/);
    expect(() =>
      getStmts().upsertQaResult.run(randomUUID(), run.id, caseIds[0], 'pass', '', '', 'nope', null),
    ).toThrow(/CHECK/);
  });

  it('cascades plan deletes and nulls kanban links', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    passRun(planId, caseIds);
    getStmts().deleteQaPlan.run(planId);
    const count = (t: string) =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count('qa_cases') + count('qa_runs') + count('qa_results')).toBe(0);
  });

  it('deletes every plan for a project on project delete', () => {
    const a = makePlan(1);
    getStmts().insertQaPlan.run(
      'other',
      'proj2',
      'P',
      '',
      'https://x.test',
      null,
      null,
      null,
      1,
      5,
      null,
    );
    getStmts().deleteQaPlansByProject.run('proj');
    expect(getStmts().getQaPlan.get(a.planId)).toBeUndefined();
    expect(getStmts().getQaPlan.get('other')).toBeDefined();
  });

  it('upserts one result per (run, case) and keeps an existing finding card', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    const { run } = startQaRun(planId);
    const db = getDb();
    db.exec(`
      INSERT INTO kanban_boards (id, project_id, name) VALUES ('qb', 'proj', 'B');
      INSERT INTO kanban_columns (id, board_id, name) VALUES ('qc', 'qb', 'To Do');
      INSERT INTO kanban_cards (id, column_id, board_id, title) VALUES ('qcard', 'qc', 'qb', 'Finding');
    `);
    getStmts().upsertQaResult.run(
      randomUUID(),
      run.id,
      caseIds[0],
      'fail',
      'x',
      '',
      '["a1"]',
      'qcard',
    );
    getStmts().upsertQaResult.run(
      randomUUID(),
      run.id,
      caseIds[0],
      'needs_change',
      'y',
      '',
      '[]',
      null,
    );
    const rows = getStmts().listQaResultsByRun.all(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: 'needs_change',
      actual: 'y',
      finding_card_id: 'qcard',
    });

    db.exec(
      "DELETE FROM kanban_cards WHERE id = 'qcard'; DELETE FROM kanban_boards WHERE id = 'qb'",
    );
    expect(getStmts().listQaResultsByRun.all(run.id)[0].finding_card_id).toBeNull();
  });

  it('stamps run started_at / finished_at from status', () => {
    const { planId } = makePlan(1);
    approveQaPlan(planId, 'u1');
    const { run } = startQaRun(planId);
    expect(run).toMatchObject({
      status: 'queued',
      started_at: null,
      finished_at: null,
      iteration: 1,
    });
    const running = markQaRunRunning(run.id);
    expect(running.started_at).not.toBeNull();
    expect(running.finished_at).toBeNull();
    expect(cancelQaRun(run.id).finished_at).not.toBeNull();
  });
});

describe('nextQaPlanStatus', () => {
  it.each<[QaPlanStatus, 'run_started' | 'signed_off', QaPlanStatus]>([
    ['new', 'run_started', 'in_progress'],
    ['in_progress', 'run_started', 'in_progress'],
    ['done', 'run_started', 'in_progress'],
    ['in_progress', 'signed_off', 'done'],
  ])('%s + %s -> %s', (from, event, to) => {
    expect(nextQaPlanStatus(from, event)).toBe(to);
  });

  it.each<QaPlanStatus>(['new', 'done'])('rejects signed_off from %s', (from) => {
    expectQaError(() => nextQaPlanStatus(from, 'signed_off'), 'illegal_transition', 409);
  });
});

describe('plan status helpers', () => {
  it('new -> in_progress on the first run, iterations increase', () => {
    const { planId } = makePlan();
    approveQaPlan(planId, 'u1');
    expect(getStmts().getQaPlan.get(planId)!.status).toBe('new');
    const first = startQaRun(planId, { scope: 'full', startedBy: 'u1' });
    expect(first.plan.status).toBe('in_progress');
    expect(first.run).toMatchObject({ iteration: 1, scope: 'full', started_by: 'u1' });
    cancelQaRun(first.run.id);
    const second = startQaRun(planId, { scope: 'failed_only' });
    expect(second.plan.status).toBe('in_progress');
    expect(second.run).toMatchObject({ iteration: 2, scope: 'failed_only' });
  });

  it('refuses runs on unapproved plans and approval with no cases', () => {
    const { planId } = makePlan();
    expectQaError(() => startQaRun(planId), 'not_approved', 409);
    approveQaPlan(planId, 'u1');
    revokeQaPlanApproval(planId);
    expectQaError(() => startQaRun(planId), 'not_approved', 409);
    expect(getStmts().listQaRunsByPlan.all(planId)).toHaveLength(0);

    const empty = makePlan(0);
    expectQaError(() => approveQaPlan(empty.planId, 'u1'), 'no_cases', 409);
  });

  it('reports missing plans as not_found', () => {
    expectQaError(() => startQaRun('missing'), 'not_found', 404);
    expectQaError(() => signOffQaPlan('missing', 'u1'), 'not_found', 404);
    expectQaError(() => approveQaPlan('missing', 'u1'), 'not_found', 404);
  });

  it('rejects sign-off on a new plan', () => {
    const { planId } = makePlan();
    approveQaPlan(planId, 'u1');
    expectQaError(() => signOffQaPlan(planId, 'u1'), 'illegal_transition', 409);
    expect(getStmts().getQaPlan.get(planId)!.status).toBe('new');
  });

  it('rejects sign-off until the latest run passed with every case passing', () => {
    const { planId, caseIds } = makePlan();
    approveQaPlan(planId, 'u1');
    const { run } = startQaRun(planId);
    expect(qaPlanSignOffBlocker(planId)).toMatch(/queued/);

    markQaRunRunning(run.id);
    record(run.id, caseIds[0], 'pass');
    record(run.id, caseIds[1], 'fail');
    expect(finishQaRun(run.id).status).toBe('failed');
    expectQaError(() => signOffQaPlan(planId, 'u1'), 'not_all_pass', 409);

    // A failed_only run with no results cannot pass.
    const empty = begin(planId, 'failed_only');
    expect(finishQaRun(empty.id).status).toBe('failed');
    expectQaError(() => signOffQaPlan(planId, 'u1'), 'not_all_pass', 409);
    expect(getStmts().getQaPlan.get(planId)!.status).toBe('in_progress');
  });

  it('in_progress -> done after a failed_only rerun fixes the remaining case', () => {
    const { planId, caseIds } = makePlan();
    approveQaPlan(planId, 'u1');
    const first = begin(planId);
    record(first.id, caseIds[0], 'pass');
    record(first.id, caseIds[1], 'fail');
    finishQaRun(first.id);

    expect(passRun(planId, [caseIds[1]], 'failed_only').status).toBe('passed');

    expect(qaPlanSignOffBlocker(planId)).toBeNull();
    const done = signOffQaPlan(planId, 'reviewer');
    expect(done).toMatchObject({ status: 'done', signed_off_by: 'reviewer' });
    expect(done.signed_off_at).not.toBeNull();

    expectQaError(() => signOffQaPlan(planId, 'reviewer'), 'illegal_transition', 409);
  });

  it('ignores cancelled runs when computing latest verdicts', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    const first = passRun(planId, caseIds);
    const cancelled = begin(planId);
    record(cancelled.id, caseIds[0], 'fail');
    cancelQaRun(cancelled.id);
    expect(getStmts().listLatestQaVerdictsByPlan.all(planId)[0]).toMatchObject({
      verdict: 'pass',
      run_id: first.id,
    });
    // The latest run is still the cancelled one, so sign-off stays blocked.
    expect(qaPlanSignOffBlocker(planId)).toMatch(/cancelled/);
  });

  it('done -> in_progress on reopen clears sign-off', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    passRun(planId, caseIds);
    signOffQaPlan(planId, 'reviewer');

    const reopened = startQaRun(planId);
    expect(reopened.plan).toMatchObject({
      status: 'in_progress',
      signed_off_at: null,
      signed_off_by: null,
    });
    expect(reopened.run.iteration).toBe(2);
  });

  it('approval does not change status', () => {
    const { planId } = makePlan();
    const approved = approveQaPlan(planId, 'u1');
    expect(approved).toMatchObject({ status: 'new', approved_by: 'u1' });
    expect(approved.approved_at).not.toBeNull();
    const draft = revokeQaPlanApproval(planId);
    expect(draft).toMatchObject({ status: 'new', approved_at: null, approved_by: null });
  });
});

describe('case changes invalidate sign-off evidence', () => {
  it('stamps each result with the tested case version', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    const run = passRun(planId, caseIds);
    expect(getStmts().listQaResultsByRun.all(run.id)[0].case_version).toBe(1);
    expect(editQaCase(caseIds[0], { expected: 'new' }).version).toBe(2);
  });

  it('edit, re-approve, then sign-off before a fresh run is refused', () => {
    const { planId, caseIds } = makePlan();
    approveQaPlan(planId, 'u1');
    passRun(planId, caseIds);
    expect(qaPlanSignOffBlocker(planId)).toBeNull();

    editQaCase(caseIds[0], { steps: 'changed steps' });
    expect(getStmts().getQaPlan.get(planId)!.approved_at).toBeNull();
    expectQaError(() => signOffQaPlan(planId, 'u1'), 'not_all_pass', 409);
    expect(qaPlanSignOffBlocker(planId)).toMatch(/not approved/);

    approveQaPlan(planId, 'u1');
    expect(qaPlanSignOffBlocker(planId)).toMatch(/changed since the latest run/);
    expectQaError(() => signOffQaPlan(planId, 'u1'), 'not_all_pass', 409);

    passRun(planId, caseIds);
    expect(signOffQaPlan(planId, 'u1').status).toBe('done');
  });

  it('a failed_only rerun covers an edited case and keeps passing evidence for the rest', () => {
    const { planId, caseIds } = makePlan();
    approveQaPlan(planId, 'u1');
    passRun(planId, caseIds);
    editQaCase(caseIds[0], { title: 'renamed' });
    approveQaPlan(planId, 'u1');

    const rerun = begin(planId, 'failed_only');
    expect(JSON.parse(rerun.case_ids!)).toEqual([caseIds[0]]);
    expectQaError(() => record(rerun.id, caseIds[1], 'pass'), 'out_of_scope', 409);
    record(rerun.id, caseIds[0], 'pass');
    expect(finishQaRun(rerun.id).status).toBe('passed');
    expect(qaPlanSignOffBlocker(planId)).toBeNull();
  });

  describe('legacy runs without recorded scope', () => {
    /** A failed_only rerun queued before case_ids existed: case 0 passed, 1 and 2 failed. */
    function legacyRerun() {
      const { planId, caseIds } = makePlan(3);
      approveQaPlan(planId, 'u1');
      const first = begin(planId);
      record(first.id, caseIds[0], 'pass');
      record(first.id, caseIds[1], 'fail');
      record(first.id, caseIds[2], 'blocked');
      finishQaRun(first.id);
      const run = begin(planId, 'failed_only');
      getDb().prepare('UPDATE qa_runs SET case_ids = NULL WHERE id = ?').run(run.id);
      return { planId, caseIds, runId: run.id };
    }

    it('rebuilds the failed_only scope for a run with no results', () => {
      const { caseIds, runId } = legacyRerun();
      expect(qaRunCaseIds(getStmts().getQaRun.get(runId)!)).toEqual([caseIds[1], caseIds[2]]);
      record(runId, caseIds[1], 'pass');
      expectQaError(() => record(runId, caseIds[0], 'pass'), 'out_of_scope', 409);
    });

    it('does not complete early on a partial or replaced result', () => {
      const { caseIds, runId } = legacyRerun();
      record(runId, caseIds[1], 'fail');
      expect(completeQaRunIfCovered(runId)).toBeNull();
      // Replacing the only recorded result must not make the subset look covered.
      record(runId, caseIds[1], 'pass');
      expect(completeQaRunIfCovered(runId)).toBeNull();
      record(runId, caseIds[2], 'pass');
      expect(completeQaRunIfCovered(runId)?.status).toBe('passed');
    });

    it('falls back to every case when the rebuilt scope is empty', () => {
      const { planId, caseIds } = makePlan(2);
      approveQaPlan(planId, 'u1');
      passRun(planId, caseIds);
      const { run } = startQaRun(planId);
      getDb()
        .prepare("UPDATE qa_runs SET case_ids = NULL, scope = 'failed_only' WHERE id = ?")
        .run(run.id);
      expect(qaRunCaseIds(getStmts().getQaRun.get(run.id)!)).toEqual(caseIds);

      // The fallback holds after the first result: the run waits for every case.
      markQaRunRunning(run.id);
      record(run.id, caseIds[0], 'pass');
      expect(qaRunCaseIds(getStmts().getQaRun.get(run.id)!)).toEqual(caseIds);
      expect(completeQaRunIfCovered(run.id)).toBeNull();
      expect(getStmts().getQaRun.get(run.id)!.status).toBe('running');
      record(run.id, caseIds[1], 'pass');
      expect(completeQaRunIfCovered(run.id)?.status).toBe('passed');
    });
  });

  it('refuses a failed_only run when every case already passed', () => {
    const { planId, caseIds } = makePlan();
    approveQaPlan(planId, 'u1');
    passRun(planId, caseIds);
    expectQaError(() => startQaRun(planId, { scope: 'failed_only' }), 'nothing_to_rerun', 409);
  });

  it('fixes the in-scope case ids when the run is queued', () => {
    const { planId, caseIds } = makePlan(3);
    approveQaPlan(planId, 'u1');
    const first = begin(planId);
    expect(JSON.parse(first.case_ids!)).toEqual(caseIds);
    record(first.id, caseIds[0], 'pass');
    record(first.id, caseIds[1], 'fail');
    record(first.id, caseIds[2], 'blocked');
    finishQaRun(first.id);
    expect(qaRunScopeCaseIds(planId, 'failed_only')).toEqual([caseIds[1], caseIds[2]]);
  });

  it('completes a running run only once every in-scope case has a result', () => {
    const { planId, caseIds } = makePlan();
    approveQaPlan(planId, 'u1');
    const run = begin(planId);
    record(run.id, caseIds[0], 'pass');
    expect(completeQaRunIfCovered(run.id)).toBeNull();
    expect(getStmts().getQaRun.get(run.id)!.status).toBe('running');
    record(run.id, caseIds[1], 'needs_change');
    expect(completeQaRunIfCovered(run.id)?.status).toBe('failed');
    expect(completeQaRunIfCovered(run.id)).toBeNull();

    const { planId: p2, caseIds: c2 } = makePlan(1);
    approveQaPlan(p2, 'u1');
    const passing = begin(p2);
    record(passing.id, c2[0], 'pass');
    const done = completeQaRunIfCovered(passing.id);
    expect(done).toMatchObject({ status: 'passed' });
    expect(done!.finished_at).not.toBeNull();
  });

  it('adding or removing a case revokes approval', () => {
    const { planId, caseIds } = makePlan();
    approveQaPlan(planId, 'u1');
    const added = addQaCase(planId, { title: 'Extra' });
    expect(added.position).toBe(2);
    expect(addQaCase(planId, { title: 'Draft' }).position).toBe(3);
    expect(getStmts().getQaPlan.get(planId)!.approved_at).toBeNull();

    approveQaPlan(planId, 'u1');
    passRun(planId, [...caseIds, added.id]);
    removeQaCase(caseIds[1]);
    expect(getStmts().getQaPlan.get(planId)!.approved_at).toBeNull();
    expectQaError(() => signOffQaPlan(planId, 'u1'), 'not_all_pass', 409);
  });

  it('refuses results for a run started under an older approval', () => {
    const { planId, caseIds } = makePlan();
    approveQaPlan(planId, 'u1');
    const run = begin(planId);
    // The helpers refuse approval changes mid-run; this covers a direct write.
    getStmts().clearQaPlanApproval.run(planId);
    expectQaError(() => record(run.id, caseIds[0], 'pass'), 'stale_run', 409);
    getStmts().setQaPlanApproval.run('u1', planId);
    expectQaError(() => record(run.id, caseIds[0], 'pass'), 'stale_run', 409);
  });

  it('refuses results for a case from another plan', () => {
    const a = makePlan(1);
    const b = makePlan(1);
    approveQaPlan(a.planId, 'u1');
    const run = begin(a.planId);
    expectQaError(() => record(run.id, b.caseIds[0], 'pass'), 'not_found', 404);
    expectQaError(() => editQaCase('missing', {}), 'not_found', 404);
  });
});

describe('lifecycle guards', () => {
  it('appends after the highest position when a middle case was removed', () => {
    const { planId, caseIds } = makePlan(3);
    removeQaCase(caseIds[1]);
    const added = addQaCase(planId, { title: 'Last' });
    expect(added.position).toBe(3);
    expect(
      getStmts()
        .listQaCasesByPlan.all(planId)
        .map((c) => c.id),
    ).toEqual([caseIds[0], caseIds[2], added.id]);
  });

  it('freezes results once a run finishes, including after sign-off', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    const run = passRun(planId, caseIds);
    signOffQaPlan(planId, 'reviewer');

    expectQaError(() => record(run.id, caseIds[0], 'fail'), 'run_not_running', 409);
    expect(getStmts().listQaResultsByRun.all(run.id)[0].verdict).toBe('pass');
    expect(getStmts().getQaPlan.get(planId)).toMatchObject({
      status: 'done',
      signed_off_by: 'reviewer',
    });
    expect(qaPlanSignOffBlocker(planId)).toBeNull();
  });

  it('refuses results on queued and cancelled runs', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    const { run } = startQaRun(planId);
    expectQaError(() => record(run.id, caseIds[0], 'pass'), 'run_not_running', 409);
    cancelQaRun(run.id);
    expectQaError(() => record(run.id, caseIds[0], 'pass'), 'run_not_running', 409);
  });

  it('enforces run transitions', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    const { run } = startQaRun(planId);
    expectQaError(() => finishQaRun(run.id), 'run_not_running', 409);
    markQaRunRunning(run.id);
    // The server begins runs it seeds, so a second begin from the agent is a no-op.
    expect(markQaRunRunning(run.id).status).toBe('running');
    record(run.id, caseIds[0], 'pass');
    finishQaRun(run.id);
    expectQaError(() => finishQaRun(run.id), 'run_not_running', 409);
    expectQaError(() => cancelQaRun(run.id), 'illegal_transition', 409);
    expectQaError(() => markQaRunRunning('missing'), 'not_found', 404);
  });

  it('a full run missing a case result fails', () => {
    const { planId, caseIds } = makePlan(2);
    approveQaPlan(planId, 'u1');
    expect(passRun(planId, [caseIds[0]]).status).toBe('failed');
  });

  it('allows one active run at a time', () => {
    const { planId } = makePlan(1);
    approveQaPlan(planId, 'u1');
    const { run } = startQaRun(planId);
    expectQaError(() => startQaRun(planId), 'run_active', 409);
    markQaRunRunning(run.id);
    expectQaError(() => startQaRun(planId), 'run_active', 409);
    cancelQaRun(run.id);
    expect(startQaRun(planId).run.iteration).toBe(2);
  });

  it('freezes the case list and approval during a run', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    begin(planId);
    expectQaError(() => editQaCase(caseIds[0], { title: 'x' }), 'run_active', 409);
    expectQaError(() => addQaCase(planId, { title: 'x' }), 'run_active', 409);
    expectQaError(() => removeQaCase(caseIds[0]), 'run_active', 409);
    expectQaError(() => revokeQaPlanApproval(planId), 'run_active', 409);
    expectQaError(() => approveQaPlan(planId, 'u1'), 'run_active', 409);
    expect(getStmts().getQaCase.get(caseIds[0])!.version).toBe(1);
  });

  it('freezes a done plan until a run reopens it', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    passRun(planId, caseIds);
    signOffQaPlan(planId, 'reviewer');
    expectQaError(() => editQaCase(caseIds[0], { title: 'x' }), 'plan_done', 409);
    expectQaError(() => addQaCase(planId, { title: 'x' }), 'plan_done', 409);
    expectQaError(() => removeQaCase(caseIds[0]), 'plan_done', 409);
    expectQaError(() => revokeQaPlanApproval(planId), 'plan_done', 409);
    expectQaError(() => approveQaPlan(planId, 'u1'), 'plan_done', 409);

    const { run } = startQaRun(planId);
    cancelQaRun(run.id);
    expect(editQaCase(caseIds[0], { title: 'x' }).version).toBe(2);
  });

  it('re-approving an approved plan keeps the latest run eligible', () => {
    const { planId, caseIds } = makePlan(1);
    approveQaPlan(planId, 'u1');
    passRun(planId, caseIds);
    const before = getStmts().getQaPlan.get(planId)!.approval_seq;
    expect(approveQaPlan(planId, 'u2').approval_seq).toBe(before);
    expect(qaPlanSignOffBlocker(planId)).toBeNull();
  });
});
