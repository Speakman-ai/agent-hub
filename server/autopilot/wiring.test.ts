import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { RouteDeps, Stmts } from '../types.js';
import type { AutopilotRuntime } from './runtime.js';
import {
  buildBoardOps,
  buildFinalizeOps,
  buildLocalTargetLookup,
  handleAutopilotBroadcast,
  parseBaselineSpecJson,
  pinSessionEnvAdapter,
  readFinalizeOutcome,
  readSessionOutcome,
  autopilotWorkerSessionName,
} from './wiring.js';

describe('autopilotWorkerSessionName', () => {
  it('names evaluator sessions by cycle and implementer sessions by selected improvement', () => {
    expect(autopilotWorkerSessionName({ role: 'evaluator', cycleNumber: 2 })).toBe(
      'Autopilot evaluator · cycle 2',
    );
    expect(
      autopilotWorkerSessionName({
        role: 'implementer',
        cycleNumber: 2,
        selectedImprovement: 'Stamp scorecard SHA with the current git revision',
        cardTitle: 'Implement the Autopilot baseline',
      }),
    ).toBe('Autopilot: Stamp scorecard SHA with the current git revision');
    expect(
      autopilotWorkerSessionName({
        role: 'implementer',
        cycleNumber: 1,
        cardTitle: 'Implement the Autopilot baseline',
      }),
    ).toBe('Implement the Autopilot baseline');
  });
});

describe('autopilot wiring — parseBaselineSpecJson', () => {
  it('parses a fenced json block from planning-session output', () => {
    const text =
      'Here is the plan:\n```json\n{ "acceptanceJourneys": [{ "action": "a" }] }\n```\nDone.';
    expect(parseBaselineSpecJson(text)).toEqual({ acceptanceJourneys: [{ action: 'a' }] });
  });

  it('parses a bare object and returns null on non-JSON', () => {
    expect(parseBaselineSpecJson('{ "qualityRubricVersion": 1 }')).toEqual({
      qualityRubricVersion: 1,
    });
    expect(parseBaselineSpecJson('no json here')).toBeNull();
    expect(parseBaselineSpecJson('')).toBeNull();
    expect(parseBaselineSpecJson('```json\n{ not valid }\n```')).toBeNull();
  });
});

/** Minimal fake Stmts: only the statements the functions under test touch. */
function fakeStmts(rows: {
  epics?: { id: string; labels: string | null; position: number }[];
  cardsByEpic?: {
    id: string;
    title: string;
    labels: string | null;
    column_id?: string;
    phase_id?: string | null;
  }[];
  columns?: { id: string; name: string }[];
  phases?: { id: string; name: string; position: number; description?: string | null }[];
  finalizeRun?: Record<string, unknown> | undefined;
  pr?: Record<string, unknown> | undefined;
}): Stmts {
  const columns = rows.columns ?? [];
  return {
    getKanbanEpics: { all: () => rows.epics ?? [] },
    getKanbanCardsByEpic: { all: () => rows.cardsByEpic ?? [] },
    getKanbanColumn: {
      get: (id: string) => columns.find((c) => c.id === id),
    },
    getKanbanPhasesByEpic: { all: () => rows.phases ?? [] },
    getFinalizeRun: { get: () => rows.finalizeRun },
    getPullRequestByNumber: { get: () => rows.pr },
  } as unknown as Stmts;
}

describe('autopilot wiring — pinSessionEnvAdapter (fail closed)', () => {
  function dbWithSession(id: string) {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, session_env_adapter TEXT)');
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
    return db;
  }

  it('pins a concrete adapter onto the target session', () => {
    const db = dbWithSession('s1');
    pinSessionEnvAdapter(db, 's1', 'host');
    const row = db.prepare('SELECT session_env_adapter FROM sessions WHERE id = ?').get('s1') as {
      session_env_adapter: string | null;
    };
    expect(row.session_env_adapter).toBe('host');
  });

  it('is a no-op for auto (global boot selection applies)', () => {
    const db = dbWithSession('s1');
    pinSessionEnvAdapter(db, 's1', 'auto');
    const row = db.prepare('SELECT session_env_adapter FROM sessions WHERE id = ?').get('s1') as {
      session_env_adapter: string | null;
    };
    expect(row.session_env_adapter).toBeNull();
  });

  it('throws when the UPDATE affects no row, rather than silently using global', () => {
    const db = dbWithSession('s1');
    // Target a session id that does not exist — the pin cannot be applied, so a
    // Sysbox selection must NOT silently fall back to the host default.
    expect(() => pinSessionEnvAdapter(db, 'missing', 'sysbox')).toThrowError(
      /failed to pin session-env adapter 'sysbox'/,
    );
  });
});

describe('autopilot wiring — board ops', () => {
  it('finds a prior epic by the autopilot idempotency-key label', () => {
    const stmts = fakeStmts({
      epics: [
        { id: 'e1', labels: 'other', position: 0 },
        { id: 'e2', labels: 'autopilot-key:autopilot:run-1:cycle-1', position: 1 },
      ],
    });
    const ops = buildBoardOps(stmts);
    expect(ops.findEpicByKey('board-1', 'autopilot:run-1:cycle-1')).toEqual({ epicId: 'e2' });
    expect(ops.findEpicByKey('board-1', 'autopilot:run-9:cycle-9')).toBeNull();
  });

  it('computes the next epic position', () => {
    const ops = buildBoardOps(
      fakeStmts({
        epics: [
          { id: 'e1', labels: null, position: 3 },
          { id: 'e2', labels: null, position: 7 },
        ],
      }),
    );
    expect(ops.nextEpicPosition('board-1')).toBe(8);
    expect(buildBoardOps(fakeStmts({ epics: [] })).nextEpicPosition('board-1')).toBe(0);
  });

  it('lists epic cards by their durable autopilot-card key, ignoring keyless cards', () => {
    const ops = buildBoardOps(
      fakeStmts({
        cardsByEpic: [
          {
            id: 'c1',
            title: 'x'.repeat(200),
            labels: 'autopilot-card:autopilot:run-1:cycle-1#primary',
          },
          {
            id: 'c2',
            title: 'x'.repeat(200),
            labels: 'autopilot-card:autopilot:run-1:cycle-1#journey-1',
          },
          { id: 'c3', title: 'unrelated', labels: 'some-other-label' },
        ],
      }),
    );
    // Keys come from the label, not the (identical, truncatable) titles; the
    // keyless card is excluded.
    expect(ops.listCardsForEpic('epic-1')).toEqual([
      { id: 'c1', key: 'autopilot:run-1:cycle-1#primary' },
      { id: 'c2', key: 'autopilot:run-1:cycle-1#journey-1' },
    ]);
  });

  it('returns unlabeled epic cards so completion checks cannot skip them', () => {
    const ops = buildBoardOps(
      fakeStmts({
        cardsByEpic: [
          {
            id: 'c1',
            title: 'baseline',
            labels: 'autopilot-card:autopilot:run-1:cycle-1#primary',
            column_id: 'col-done',
            phase_id: 'p1',
          },
          {
            id: 'c2',
            title: 'human card',
            labels: null,
            column_id: 'col-todo',
            phase_id: 'p1',
          },
        ],
        columns: [
          { id: 'col-todo', name: 'To Do' },
          { id: 'col-done', name: 'Done' },
        ],
      }),
    );
    expect(ops.listEpicCards('epic-1')).toEqual([
      {
        id: 'c1',
        key: 'autopilot:run-1:cycle-1#primary',
        phaseId: 'p1',
        columnName: 'Done',
      },
      { id: 'c2', key: null, phaseId: 'p1', columnName: 'To Do' },
    ]);
  });

  it('reads a cycle-scoped phase identity from the phase description', () => {
    const stmts = fakeStmts({
      phases: [
        { id: 'p1', name: 'Baseline', position: 0, description: null },
        {
          id: 'p2',
          name: 'Cycle 2',
          position: 1,
          description: 'autopilot-key:autopilot:run-1:cycle-2',
        },
      ],
    });
    const ops = buildBoardOps(stmts);
    expect(ops.listPhases('epic-1')).toEqual([
      { id: 'p1', name: 'Baseline', position: 0, key: null },
      { id: 'p2', name: 'Cycle 2', position: 1, key: 'autopilot:run-1:cycle-2' },
    ]);
  });
});

describe('autopilot wiring — readFinalizeOutcome', () => {
  it('returns null while the run is still in progress', () => {
    const stmts = fakeStmts({ finalizeRun: { status: 'reviewing', reviewer_verdict: null } });
    expect(readFinalizeOutcome(stmts, 'run-1')).toBeNull();
  });

  it('returns null when the run is missing', () => {
    expect(readFinalizeOutcome(fakeStmts({}), 'run-x')).toBeNull();
  });

  it('maps a pushed+merged run to a merged result with the PR merge SHA', () => {
    const stmts = fakeStmts({
      finalizeRun: {
        status: 'pushed',
        reviewer_verdict: 'approved',
        pr_url: 'https://hub/git/proj/pulls/42',
        project_id: 'proj',
      },
      pr: { status: 'merged', merged_sha: 'cafe1234' },
    });
    expect(readFinalizeOutcome(stmts, 'run-1')).toEqual({
      status: 'merged',
      mergedSha: 'cafe1234',
      reviewStatus: 'approved',
    });
  });

  it('waits for the PR row after push, then reads the recorded merge SHA', () => {
    const endedAt = Date.now();
    const rows = {
      finalizeRun: {
        status: 'pushed',
        reviewer_verdict: 'approved',
        pr_url: 'https://hub/git/proj/pulls/42',
        project_id: 'proj',
        ended_at: endedAt,
      },
      pr: undefined as Record<string, unknown> | undefined,
    };
    const stmts = fakeStmts(rows);
    expect(readFinalizeOutcome(stmts, 'run-1')).toBeNull();
    rows.pr = { status: 'open', merged_sha: null };
    expect(readFinalizeOutcome(stmts, 'run-1')).toBeNull();
    rows.pr = { status: 'merged', merged_sha: 'recorded-merge-sha' };
    expect(readFinalizeOutcome(stmts, 'run-1')).toEqual({
      status: 'merged',
      mergedSha: 'recorded-merge-sha',
      reviewStatus: 'approved',
    });
  });

  it('bounds the merge wait using the persisted push time across readers', () => {
    const rows = {
      finalizeRun: {
        status: 'pushed',
        reviewer_verdict: 'approved',
        pr_url: 'https://hub/git/proj/pulls/42',
        project_id: 'proj',
        ended_at: Date.now() - 60_000,
      },
      pr: { status: 'open', merged_sha: null as string | null },
    };
    expect(readFinalizeOutcome(fakeStmts(rows), 'run-1')).toEqual({
      status: 'error',
      reviewStatus: 'approved',
      message: 'merge_confirmation_timed_out',
    });
    // A late merge remains recoverable on retry, even after the wait expires.
    rows.pr = { status: 'merged', merged_sha: 'late-merge' };
    expect(readFinalizeOutcome(fakeStmts(rows), 'run-1')?.mergedSha).toBe('late-merge');
  });

  it('maps a changes_requested run to a review rejection', () => {
    const stmts = fakeStmts({
      finalizeRun: {
        status: 'failed',
        reviewer_verdict: 'changes_requested',
        pr_url: null,
        project_id: 'proj',
      },
    });
    expect(readFinalizeOutcome(stmts, 'run-1')).toEqual({
      status: 'review_rejected',
      reviewStatus: 'changes_requested',
    });
  });
});

describe('autopilot wiring finalize retries', () => {
  function setup() {
    const pushed = vi.fn();
    const updateAutomation = vi.fn();
    const deps = {
      stmts: {
        getSession: { get: () => ({ id: 'sess-1', agent_id: 'agent-1' }) },
        getPushedFinalizeRunForSession: { get: pushed },
        updateSessionFinalizeAutomation: { run: updateAutomation },
        getKanbanCardBySession: { get: () => ({ id: 'card-1', board_id: 'board-1' }) },
        getKanbanBoard: { get: () => ({ id: 'board-1' }) },
      },
      findProject: () => ({ id: 'proj' }),
    } as unknown as RouteDeps;
    const startRun = vi.fn().mockResolvedValue({ ok: true, runId: 'new-run' });
    return { pushed, updateAutomation, startRun, ops: buildFinalizeOps(deps, startRun) };
  }
  const input = { projectId: 'proj', sessionId: 'sess-1', cardId: 'card-1' };

  it('reuses the pushed run without restarting Finalize or changing the locked session', async () => {
    const { pushed, updateAutomation, startRun, ops } = setup();
    pushed.mockReturnValue({ id: 'pushed-run', status: 'pushed', project_id: 'proj' });
    await expect(ops.startMergeAutomation(input)).resolves.toEqual({ finalizeRunId: 'pushed-run' });
    expect(pushed).toHaveBeenCalledWith('sess-1');
    expect(startRun).not.toHaveBeenCalled();
    expect(updateAutomation).not.toHaveBeenCalled();
  });

  it('starts merge automation when the session has not pushed', async () => {
    const { startRun, updateAutomation, ops } = setup();
    await expect(ops.startMergeAutomation(input)).resolves.toEqual({ finalizeRunId: 'new-run' });
    expect(startRun).toHaveBeenCalledOnce();
    expect(updateAutomation).toHaveBeenCalledWith('merge', 'sess-1');
  });

  it('reconciles a push that finishes between lookup and starting Finalize', async () => {
    const { pushed, startRun, ops } = setup();
    pushed.mockReturnValueOnce(undefined).mockReturnValue({
      id: 'pushed-run',
      status: 'pushed',
      project_id: 'proj',
    });
    startRun.mockResolvedValue({ ok: false, error: 'session_finalized_pushed' });
    await expect(ops.startMergeAutomation(input)).resolves.toEqual({ finalizeRunId: 'pushed-run' });
  });

  it('does not reuse a pushed run from another project', async () => {
    const { pushed, startRun, ops } = setup();
    pushed.mockReturnValue({ id: 'foreign-run', status: 'pushed', project_id: 'other' });
    await expect(ops.startMergeAutomation(input)).rejects.toThrow(/project/);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('preserves unrelated Finalize start failures', async () => {
    const { startRun, ops } = setup();
    startRun.mockResolvedValue({ ok: false, error: 'missing_worktree' });
    await expect(ops.startMergeAutomation(input)).rejects.toThrow('missing_worktree');
  });
});

describe('autopilot wiring — completion callbacks', () => {
  it('routes finalize_run_completed and changes_ready into settle methods', () => {
    const settleSession = vi.fn();
    const settleFinalize = vi.fn();
    const settleDeployment = vi.fn();
    const runtime = {
      settleSession,
      settleFinalize,
      settleDeployment,
    } as unknown as AutopilotRuntime;
    handleAutopilotBroadcast(runtime, { type: 'finalize_run_completed', run_id: 'fin-1' });
    handleAutopilotBroadcast(runtime, { type: 'changes_ready', sessionId: 'sess-1' });
    handleAutopilotBroadcast(runtime, { type: 'changes_ready', session_id: 'sess-2' });
    handleAutopilotBroadcast(runtime, { type: 'deployment_update', deployment: { id: 'dep-1' } });
    expect(settleFinalize).toHaveBeenCalledWith('fin-1');
    expect(settleSession).toHaveBeenCalledWith('sess-1');
    expect(settleSession).toHaveBeenCalledWith('sess-2');
    expect(settleDeployment).toHaveBeenCalledWith('dep-1');
  });
});

describe('autopilot wiring — local target lookup', () => {
  it('binds origin, readiness, and live revision from the declared environment', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'autopilot-target-'));
    mkdirSync(path.join(cwd, '.agent-hub'));
    writeFileSync(
      path.join(cwd, '.agent-hub', 'deploy.yaml'),
      `version: 1
environments:
  local-preview:
    origin: http://127.0.0.1:4310
    readiness: /health
    steps:
      - run: ./deploy.sh
  staging:
    origin: http://127.0.0.1:9999
    readiness: /health
    steps:
      - run: ./deploy-staging.sh
`,
    );
    const lookup = buildLocalTargetLookup(
      (id) => (id === 'demo' ? ({ id, cwd } as never) : null),
      (_projectId, targetId) =>
        targetId === 'local-preview'
          ? { current_ref: 'sha-live', current_deployment_id: 'dep-1' }
          : null,
    );
    expect(lookup.getDeclaredEnvironment('demo', 'local-preview')).toEqual({
      origin: 'http://127.0.0.1:4310',
      readinessProbeUrl: 'http://127.0.0.1:4310/health',
      currentRef: 'sha-live',
      currentDeploymentId: 'dep-1',
    });
    expect(lookup.getDeclaredEnvironment('demo', 'staging')).toEqual({
      origin: 'http://127.0.0.1:9999',
      readinessProbeUrl: 'http://127.0.0.1:9999/health',
      currentRef: null,
      currentDeploymentId: null,
    });
    expect(lookup.getDeclaredEnvironment('demo', 'production')).toBeNull();
  });
});

describe('readSessionOutcome', () => {
  function stmtsFor(session: Record<string, unknown> | undefined) {
    return { getSession: { get: () => session } } as unknown as Stmts;
  }

  it('waits while the session is still in an active turn', () => {
    expect(
      readSessionOutcome(stmtsFor({ id: 's1', changes_ready: null }), new Set(['s1']), 's1'),
    ).toBeNull();
  });

  it('treats changes_ready or worktree mutations as committed', () => {
    expect(
      readSessionOutcome(stmtsFor({ id: 's1', changes_ready: '{"ok":true}' }), new Set(), 's1'),
    ).toEqual({ committed: true });
    expect(
      readSessionOutcome(
        stmtsFor({ id: 's1', changes_ready: null, code_changed_at: '2026-09-16T00:00:00Z' }),
        new Set(),
        's1',
      ),
    ).toEqual({ committed: true });
  });

  it('treats an idle session with no new commits as already delivered', () => {
    expect(
      readSessionOutcome(stmtsFor({ id: 's1', changes_ready: null }), new Set(), 's1'),
    ).toEqual({ committed: true, alreadyDelivered: true });
  });

  it('fails when the session row is missing', () => {
    expect(readSessionOutcome(stmtsFor(undefined), new Set(), 'missing')).toEqual({
      committed: false,
      error: 'session missing',
    });
  });
});
