/**
 * Archiving an epic's manager session stops the epic: dispatch off, manager
 * unlinked, busy workers interrupted with their cards left in place, and the
 * next autonomous tick starts nothing.
 */
import './setup.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import { getDb, getStmts } from '../db.js';
import { activeProcesses } from '../index.js';
import { runAutonomousLoopForEpic } from '../autonomous.js';
import { getOrCreateBoard } from '../routes/board.js';

let request: TestAgent;
let projectId: string;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  projectId = `epic-stop-${Date.now().toString(36)}`;
  await createProject({ id: projectId, name: 'Epic stop', cwd: '/tmp' });
  // Closing an epic session only stops epics on projects that run orchestrated epics.
  await request.patch(`/api/projects/${projectId}`).send({ orchestratedEpics: true }).expect(200);
  const agent = await createAgent({ projectId, id: `${projectId}-dev`, name: 'Epic stop dev' });
  agentId = agent.id as string;
});

const fakeProcs: string[] = [];
afterEach(() => {
  for (const id of fakeProcs.splice(0)) activeProcesses.delete(id);
});

function busy(sessionId: string) {
  const proc = { kill: vi.fn() };
  activeProcesses.set(sessionId, proc as never);
  fakeProcs.push(sessionId);
  return proc;
}

async function seedEpic() {
  const db = getDb();
  const stmts = getStmts();
  const manager = (await createSession({ agentId, name: 'Epic: Checkout' })).id as string;
  stmts.updateSessionMode.run('orchestrate', manager);
  const busyWorker = (await createSession({ agentId, name: 'worker busy' })).id as string;
  const idleWorker = (await createSession({ agentId, name: 'worker idle' })).id as string;

  const boardId = getOrCreateBoard(stmts, projectId).board.id;
  const existing = stmts.getKanbanColumns.all(boardId) as Array<{ id: string; name: string }>;
  const cols: Record<string, string> = Object.fromEntries(existing.map((c) => [c.name, c.id]));
  ['To Do', 'In Progress', 'Review', 'Done'].forEach((name, position) => {
    if (cols[name]) return;
    cols[name] = randomUUID();
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,?)').run(
      cols[name],
      boardId,
      name,
      position,
    );
  });
  const epicId = randomUUID();
  stmts.createKanbanEpic.run(epicId, boardId, 'Checkout', '', '#3366ff', 0, null);
  db.prepare('UPDATE kanban_epics SET autonomous = 1, manager_session_id = ? WHERE id = ?').run(
    manager,
    epicId,
  );
  const phaseId = randomUUID();
  db.prepare(
    'INSERT INTO kanban_phases (id, epic_id, board_id, name, autonomous_running) VALUES (?,?,?,?,1)',
  ).run(phaseId, epicId, boardId, 'Phase 1');

  const card = (title: string, column: string, sessionId: string | null) => {
    const id = randomUUID();
    db.prepare(
      'INSERT INTO kanban_cards (id, column_id, board_id, title, session_id, epic_id, phase_id) VALUES (?,?,?,?,?,?,?)',
    ).run(id, cols[column], boardId, title, sessionId, epicId, phaseId);
    return id;
  };
  return {
    manager,
    busyWorker,
    idleWorker,
    epicId,
    phaseId,
    cols,
    busyCard: card('Busy card', 'In Progress', busyWorker),
    idleCard: card('Idle card', 'Review', idleWorker),
    todoCard: card('Waiting card', 'To Do', null),
  };
}

describe('archiving an epic manager session', () => {
  it('reports the running workers it would stop', async () => {
    const s = await seedEpic();
    busy(s.busyWorker);

    const res = await request.get(`/api/sessions/${s.manager}/epic-close-impact`).expect(200);
    expect(res.body.epic).toEqual({ id: s.epicId, name: 'Checkout' });
    expect(res.body.runningWorkerCount).toBe(1);
    expect(res.body.runningWorkers).toEqual([
      {
        sessionId: s.busyWorker,
        sessionName: 'worker busy',
        cardId: s.busyCard,
        cardTitle: 'Busy card',
      },
    ]);

    const plain = await request.get(`/api/sessions/${s.busyWorker}/epic-close-impact`).expect(200);
    expect(plain.body).toEqual({ epic: null, runningWorkers: [], runningWorkerCount: 0 });
  });

  it('stops the epic, interrupts busy workers and dispatches nothing after', async () => {
    const s = await seedEpic();
    const proc = busy(s.busyWorker);
    const db = getDb();

    await request.delete(`/api/sessions/${s.manager}`).expect(200);

    const epic = db.prepare('SELECT * FROM kanban_epics WHERE id = ?').get(s.epicId) as {
      autonomous: number;
      manager_session_id: string | null;
    };
    expect(epic.autonomous).toBe(0);
    expect(epic.manager_session_id).toBeNull();
    const phase = db.prepare('SELECT * FROM kanban_phases WHERE id = ?').get(s.phaseId) as {
      autonomous_running: number;
    };
    expect(phase.autonomous_running).toBe(0);

    // The busy worker's turn was stopped; the idle one was left alone.
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    const column = (id: string) =>
      (
        db.prepare('SELECT column_id FROM kanban_cards WHERE id = ?').get(id) as {
          column_id: string;
        }
      ).column_id;
    expect(column(s.busyCard)).toBe(s.cols['In Progress']);
    expect(column(s.idleCard)).toBe(s.cols.Review);
    const comments = (id: string) =>
      db.prepare('SELECT content FROM kanban_card_comments WHERE card_id = ?').all(id) as Array<{
        content: string;
      }>;
    expect(
      comments(s.busyCard)
        .map((c) => c.content)
        .join('\n'),
    ).toContain('Epic session closed');
    expect(comments(s.idleCard)).toEqual([]);

    // Workers are interrupted, not archived: their sessions and worktrees stay.
    const live = (id: string) =>
      (
        db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get(id) as {
          deleted_at: string | null;
        }
      ).deleted_at;
    expect(live(s.busyWorker)).toBeNull();
    expect(live(s.idleWorker)).toBeNull();

    // A later tick starts nothing: the waiting card stays in To Do unclaimed.
    const sessionsBefore = (
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?').get(agentId) as {
        n: number;
      }
    ).n;
    await runAutonomousLoopForEpic(projectId, s.epicId);
    const todo = db
      .prepare('SELECT column_id, session_id FROM kanban_cards WHERE id = ?')
      .get(s.todoCard) as { column_id: string; session_id: string | null };
    expect(todo).toEqual({ column_id: s.cols['To Do'], session_id: null });
    const sessionsAfter = (
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?').get(agentId) as {
        n: number;
      }
    ).n;
    expect(sessionsAfter).toBe(sessionsBefore);
  });

  it('leaves the epic alone when a worker session is archived', async () => {
    const s = await seedEpic();
    await request.delete(`/api/sessions/${s.idleWorker}`).expect(200);
    const epic = getDb()
      .prepare('SELECT autonomous, manager_session_id FROM kanban_epics WHERE id = ?')
      .get(s.epicId);
    expect(epic).toEqual({ autonomous: 1, manager_session_id: s.manager });
  });

  it('Planning pauses dispatch but keeps the manager and running workers', async () => {
    const s = await seedEpic();
    const proc = busy(s.busyWorker);
    const db = getDb();

    const res = await request
      .post(`/api/projects/${projectId}/board/epics/${s.epicId}/planning`)
      .expect(200);
    expect(res.body).toMatchObject({
      id: s.epicId,
      autonomous: 0,
      manager_session_id: s.manager,
      manager_state: 'planning',
    });
    const phase = db
      .prepare('SELECT autonomous_running FROM kanban_phases WHERE id = ?')
      .get(s.phaseId);
    expect(phase).toEqual({ autonomous_running: 0 });

    // The worker keeps its turn and its card gets no comment.
    expect(proc.kill).not.toHaveBeenCalled();
    expect(activeProcesses.has(s.busyWorker)).toBe(true);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM kanban_card_comments WHERE card_id = ?')
        .get(s.busyCard),
    ).toEqual({ n: 0 });

    // No new card starts while planning.
    await runAutonomousLoopForEpic(projectId, s.epicId);
    expect(
      db.prepare('SELECT column_id, session_id FROM kanban_cards WHERE id = ?').get(s.todoCard),
    ).toEqual({ column_id: s.cols['To Do'], session_id: null });
  });

  it('Planning 404s for an epic on another board', async () => {
    await request.post(`/api/projects/${projectId}/board/epics/missing/planning`).expect(404);
  });

  it('sums the impact over what a bulk archive would take', async () => {
    const s = await seedEpic();
    busy(s.busyWorker);

    const all = await request
      .get(`/api/agents/${agentId}/sessions/epic-close-impact?scope=all`)
      .expect(200);
    expect(all.body.epics).toContainEqual({ id: s.epicId, name: 'Checkout' });
    expect(all.body.runningWorkers).toContainEqual(
      expect.objectContaining({ sessionId: s.busyWorker, cardId: s.busyCard }),
    );
    expect(all.body.runningWorkerCount).toBe(all.body.runningWorkers.length);

    // A live manager is never "merged", so Clear merged would stop nothing of it.
    const merged = await request
      .get(`/api/agents/${agentId}/sessions/epic-close-impact?scope=merged`)
      .expect(200);
    expect(merged.body.epics).not.toContainEqual({ id: s.epicId, name: 'Checkout' });

    await request.get(`/api/agents/${agentId}/sessions/epic-close-impact?scope=bogus`).expect(400);
  });
});
