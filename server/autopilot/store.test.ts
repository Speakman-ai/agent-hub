import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AutopilotStore } from './store.js';

function freshStore() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const store = new AutopilotStore(db);
  db.exec(
    `INSERT INTO autopilot_runs (id, project_id, control_state, fencing_generation, cycle_number)
     VALUES ('run-1', 'proj', 'running', 1, 1)`,
  );
  return { db, store };
}

describe('autopilot store events', () => {
  it('orders and pages events by monotonic seq when timestamps tie', () => {
    const { store } = freshStore();
    const createdAt = '2026-09-14 05:31:00';
    // Lexicographic id DESC would keep 'z' over 'a', which is the older insert.
    store.insertEvent({ id: 'z', runId: 'run-1', type: 'first', createdAt });
    store.insertEvent({ id: 'a', runId: 'run-1', type: 'second', createdAt });
    store.insertEvent({ id: 'm', runId: 'run-1', type: 'third', createdAt });

    const all = store.listEvents('run-1', 50);
    expect(all.map((row) => row.type)).toEqual(['first', 'second', 'third']);
    expect(all.map((row) => row.seq)).toEqual([1, 2, 3]);

    const page = store.listEvents('run-1', 2);
    expect(page.map((row) => row.type)).toEqual(['second', 'third']);
    expect(page.map((row) => row.id)).toEqual(['a', 'm']);
  });
});

describe('autopilot store operation lookups', () => {
  it('finds the latest operation by session id and finalize run id', () => {
    const { store } = freshStore();
    const createdAt = '2026-09-14 12:00:00';
    store.insertOperation({
      id: 'op-old',
      runId: 'run-1',
      cycleId: null,
      kind: 'implement',
      status: 'succeeded',
      fencingGeneration: 1,
      intentJson: '{}',
      sessionId: 'sess-1',
      finalizeRunId: null,
      deploymentId: null,
      createdAt,
    });
    store.insertOperation({
      id: 'op-new',
      runId: 'run-1',
      cycleId: null,
      kind: 'implement',
      status: 'in_flight',
      fencingGeneration: 1,
      intentJson: '{}',
      sessionId: 'sess-1',
      finalizeRunId: null,
      deploymentId: null,
      createdAt: '2026-09-14 12:00:01',
    });
    store.insertOperation({
      id: 'op-fin',
      runId: 'run-1',
      cycleId: null,
      kind: 'finalize',
      status: 'in_flight',
      fencingGeneration: 1,
      intentJson: '{}',
      sessionId: null,
      finalizeRunId: 'fin-9',
      deploymentId: null,
      createdAt,
    });
    store.insertOperation({
      id: 'op-dep',
      runId: 'run-1',
      cycleId: null,
      kind: 'deploy',
      status: 'in_flight',
      fencingGeneration: 1,
      intentJson: '{}',
      sessionId: null,
      finalizeRunId: null,
      deploymentId: 'dep-9',
      createdAt,
    });
    expect(store.getOperationBySessionId('sess-1')?.id).toBe('op-new');
    expect(store.getOperationByFinalizeRunId('fin-9')?.id).toBe('op-fin');
    expect(store.getOperationByDeploymentId('dep-9')?.id).toBe('op-dep');
    expect(store.getOperationBySessionId('missing')).toBeNull();
    expect(store.getOperationByFinalizeRunId('fin-missing')).toBeNull();
    expect(store.getOperationByDeploymentId('dep-missing')).toBeNull();
  });
});

describe('autopilot store project cycles', () => {
  it('lists cycles across runs for a project in start order', () => {
    const { db, store } = freshStore();
    db.exec(
      `INSERT INTO autopilot_runs (id, project_id, control_state, fencing_generation, cycle_number, started_at)
       VALUES ('run-older', 'proj', 'stopped', 1, 1, '2026-01-01 00:00:00')`,
    );
    store.insertCycle({
      id: 'c-new',
      runId: 'run-1',
      cycleNumber: 1,
      briefRevision: 1,
      createdAt: '2026-09-15T00:00:00.000Z',
    });
    store.insertCycle({
      id: 'c-old',
      runId: 'run-older',
      cycleNumber: 1,
      briefRevision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(store.listCyclesForProject('proj').map((c) => c.id)).toEqual(['c-old', 'c-new']);
  });
});
