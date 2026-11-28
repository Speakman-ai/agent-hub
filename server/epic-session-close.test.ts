import { describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, getStmts } from './db.js';
import {
  closeEpicManagedBySession,
  epicCloseImpact,
  pauseEpicDispatch,
  type EpicSessionCloseDeps,
} from './epic-session-close.js';
import type { KanbanEpicRow } from './types.js';

function seed() {
  const db = getDb();
  const stmts = getStmts();
  const projectId = `proj-${uuidv4()}`;
  const boardId = uuidv4();
  db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?,?,?)').run(
    boardId,
    projectId,
    'Board',
  );
  const inProgress = uuidv4();
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,0)').run(
    inProgress,
    boardId,
    'In Progress',
  );
  const manager = uuidv4();
  stmts.createSession.run(manager, 'lead', 'Epic: Search', 'claude-code', 'm', 0, 0, 1);
  const worker = uuidv4();
  stmts.createSession.run(worker, 'lead', 'worker', 'claude-code', 'm', 0, 0, 1);
  const epicId = uuidv4();
  stmts.createKanbanEpic.run(epicId, boardId, 'Search', '', '#000', 0, null);
  db.prepare('UPDATE kanban_epics SET autonomous = 1, manager_session_id = ? WHERE id = ?').run(
    manager,
    epicId,
  );
  const phaseId = uuidv4();
  db.prepare(
    'INSERT INTO kanban_phases (id, epic_id, board_id, name, autonomous_running) VALUES (?,?,?,?,1)',
  ).run(phaseId, epicId, boardId, 'P1');
  db.prepare(
    'INSERT INTO kanban_cards (id, column_id, board_id, title, session_id, epic_id) VALUES (?,?,?,?,?,?)',
  ).run(uuidv4(), inProgress, boardId, 'Card', worker, epicId);

  const calls: string[] = [];
  const deps: EpicSessionCloseDeps = {
    stmts,
    db,
    broadcast: vi.fn(),
    rescheduleEpic: vi.fn((_p, epic: KanbanEpicRow) => calls.push(`epic:${epic.autonomous}`)),
    reschedulePhase: vi.fn((_p, phase) => calls.push(`phase:${phase.autonomous_running}`)),
    pauseManager: vi.fn(() => {
      const row = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow;
      calls.push(`pause:${row.manager_session_id ?? 'none'}`);
    }),
    isSessionRunning: (id) => id === worker,
    interruptSession: vi.fn(),
    isProjectOrchestrated: () => true,
  };
  const epic = () => stmts.getKanbanEpic.get(epicId) as KanbanEpicRow;
  return { deps, calls, epicId, phaseId, manager, worker, projectId, epic };
}

describe('pauseEpicDispatch', () => {
  it('stops dispatch but keeps the manager and its workers', () => {
    const s = seed();
    expect(pauseEpicDispatch(s.deps, s.epicId)).toBe(true);
    expect(s.epic()).toMatchObject({ autonomous: 0, manager_session_id: s.manager });
    const phase = getDb()
      .prepare('SELECT autonomous_running FROM kanban_phases WHERE id = ?')
      .get(s.phaseId);
    expect(phase).toEqual({ autonomous_running: 0 });
    expect(s.calls).toEqual([`pause:${s.manager}`, 'epic:0', 'phase:0']);
    expect(s.deps.interruptSession).not.toHaveBeenCalled();
    expect(s.deps.broadcast).toHaveBeenCalledWith({
      type: 'kanban_update',
      projectId: s.projectId,
    });
  });

  it('returns false for an unknown epic', () => {
    expect(pauseEpicDispatch(seed().deps, 'missing')).toBe(false);
  });
});

describe('closeEpicManagedBySession', () => {
  it('pauses the manager before unlinking it, then interrupts running workers', () => {
    const s = seed();
    const result = closeEpicManagedBySession(s.deps, s.manager);
    expect(result).toEqual({ epicId: s.epicId, interruptedSessionIds: [s.worker] });
    expect(s.calls[0]).toBe(`pause:${s.manager}`);
    expect(s.epic()).toMatchObject({ autonomous: 0, manager_session_id: null });
    expect(s.deps.interruptSession).toHaveBeenCalledWith(s.worker);
  });

  it('stops nothing on a project without orchestrated epics', () => {
    const s = seed();
    const deps = { ...s.deps, isProjectOrchestrated: () => false };
    expect(closeEpicManagedBySession(deps, s.manager)).toBeNull();
    expect(s.epic()).toMatchObject({ autonomous: 1, manager_session_id: s.manager });
    expect(s.deps.interruptSession).not.toHaveBeenCalled();
    expect(
      epicCloseImpact(
        s.deps.stmts,
        s.manager,
        () => true,
        () => false,
      ).epic,
    ).toBeNull();
    expect(
      epicCloseImpact(
        s.deps.stmts,
        s.manager,
        () => true,
        () => true,
      ).epic?.id,
    ).toBe(s.epicId);
  });

  it('does nothing for a session that manages no epic', () => {
    const s = seed();
    expect(closeEpicManagedBySession(s.deps, s.worker)).toBeNull();
    expect(s.epic()).toMatchObject({ autonomous: 1, manager_session_id: s.manager });
  });
});
