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
    expect(store.getOperationBySessionId('sess-1')?.id).toBe('op-new');
    expect(store.getOperationByFinalizeRunId('fin-9')?.id).toBe('op-fin');
    expect(store.getOperationBySessionId('missing')).toBeNull();
    expect(store.getOperationByFinalizeRunId('fin-missing')).toBeNull();
  });
});
