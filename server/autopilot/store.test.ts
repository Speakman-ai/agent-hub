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
