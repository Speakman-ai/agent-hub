/**
 * Unit test for the `pr_state` table + prepared statements.
 *
 * `pr_state` is the row where we persist the GitHub Check Run id for each PR,
 * so the reviewer pipeline (in webhooks.ts + pr-actions.ts) can find it again
 * when it's time to PATCH progress or mark the run completed.
 *
 * Regressions here break the Check Runs UI (the progress panel would never
 * update after the initial `queued` POST), so the upsert + lookup contract is
 * worth pinning.
 */
import './setup.js';
import { getStmts } from '../db.js';

describe('pr_state — upsert + lookup', () => {
  const ROW_ID = 'owner/repo#123';

  beforeAll(() => {
    // Force db init by touching the singleton once.
    const stmts = getStmts();
    expect(stmts.upsertPrState).toBeDefined();
  });

  it('inserts a new pr_state row on first upsert', () => {
    const stmts = getStmts();
    stmts.upsertPrState.run(
      ROW_ID,
      'proj-1',
      'owner/repo',
      123,
      'sha-aaa',
      9999,
      'queued',
      'queue',
    );
    const row = stmts.getPrState.get(ROW_ID) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.check_run_id).toBe(9999);
    expect(row?.head_sha).toBe('sha-aaa');
    expect(row?.status).toBe('queued');
    expect(row?.phase).toBe('queue');
  });

  it('upsert replaces head_sha and check_run_id on conflict (new push = new commit-scoped check run)', () => {
    const stmts = getStmts();
    // First insert
    stmts.upsertPrState.run(
      ROW_ID,
      'proj-1',
      'owner/repo',
      123,
      'sha-aaa',
      9999,
      'queued',
      'queue',
    );
    // Second push arrives with a new head_sha — we create a fresh check run
    stmts.upsertPrState.run(
      ROW_ID,
      'proj-1',
      'owner/repo',
      123,
      'sha-bbb',
      10_000,
      'queued',
      'queue',
    );

    const row = stmts.getPrState.get(ROW_ID) as Record<string, unknown> | undefined;
    expect(row?.head_sha).toBe('sha-bbb');
    expect(row?.check_run_id).toBe(10_000);
    // conclusion/completed_at must be cleared — this is a brand-new run.
    expect(row?.conclusion).toBeNull();
    expect(row?.completed_at).toBeNull();
  });

  it('looks up by (repo_full_name, pr_number) for webhook rehydration', () => {
    const stmts = getStmts();
    stmts.upsertPrState.run(
      ROW_ID,
      'proj-1',
      'owner/repo',
      123,
      'sha-aaa',
      9999,
      'queued',
      'queue',
    );
    const row = stmts.getPrStateByRepoPr.get('owner/repo', 123) as
      | Record<string, unknown>
      | undefined;
    expect(row?.id).toBe(ROW_ID);
  });

  it('looks up by check_run_id for check_run.rerequested webhook', () => {
    const stmts = getStmts();
    stmts.upsertPrState.run(
      ROW_ID,
      'proj-1',
      'owner/repo',
      123,
      'sha-aaa',
      9999,
      'queued',
      'queue',
    );
    const row = stmts.getPrStateByCheckRunId.get(9999) as Record<string, unknown> | undefined;
    expect(row?.id).toBe(ROW_ID);
  });

  it('updatePrStatePhase sets phase + status together', () => {
    const stmts = getStmts();
    stmts.upsertPrState.run(
      ROW_ID,
      'proj-1',
      'owner/repo',
      123,
      'sha-aaa',
      9999,
      'queued',
      'queue',
    );
    stmts.updatePrStatePhase.run('analyze', 'in_progress', ROW_ID);
    const row = stmts.getPrState.get(ROW_ID) as Record<string, unknown> | undefined;
    expect(row?.phase).toBe('analyze');
    expect(row?.status).toBe('in_progress');
  });

  it('completePrState finalizes with conclusion + completed_at', () => {
    const stmts = getStmts();
    stmts.upsertPrState.run(
      ROW_ID,
      'proj-1',
      'owner/repo',
      123,
      'sha-aaa',
      9999,
      'queued',
      'queue',
    );
    stmts.completePrState.run('success', 'post', ROW_ID);
    const row = stmts.getPrState.get(ROW_ID) as Record<string, unknown> | undefined;
    expect(row?.status).toBe('completed');
    expect(row?.conclusion).toBe('success');
    expect(row?.phase).toBe('post');
    expect(row?.completed_at).toBeTruthy();
  });
});
