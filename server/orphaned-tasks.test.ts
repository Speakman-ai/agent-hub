import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getDb, getStmts, initDb } from './db.js';
import { reconcileOrphanedTasks } from './orphaned-tasks.js';
import { MAX_RESUME_ATTEMPTS } from './resume-attempts.js';
import type { SessionRow } from './types.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ah-orphaned-tasks-'));
  initDb(dataDir);
});
afterEach(() => {
  getDb().close();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture(autonomous: boolean, linkedEpic = true, phaseAutonomous = false) {
  const db = getDb();
  const stmts = getStmts();
  db.exec(`
    INSERT INTO kanban_boards (id, project_id, name) VALUES ('board', 'project', 'Board');
    INSERT INTO kanban_columns (id, board_id, name) VALUES
      ('todo', 'board', 'To Do'), ('working', 'board', 'In Progress');
  `);
  db.prepare(
    "INSERT INTO kanban_epics (id, board_id, name, autonomous) VALUES ('epic', 'board', 'Epic', ?)",
  ).run(autonomous ? 1 : 0);
  db.prepare(
    "INSERT INTO kanban_phases (id, board_id, epic_id, name, autonomous, autonomous_running) VALUES ('phase', 'board', 'epic', 'P5', ?, ?)",
  ).run(phaseAutonomous ? 1 : 0, phaseAutonomous ? 1 : 0);
  stmts.createSession.run(
    'original',
    'agent',
    'Decode HATCH header',
    'grok-cli',
    'grok-4.6',
    1,
    0,
    1,
  );
  db.prepare(
    "UPDATE sessions SET worktree_path = ?, engine_session_id = 'engine-original', linked_epic_id = ? WHERE id = 'original'",
  ).run(dataDir, linkedEpic ? 'epic' : null);
  db.prepare(
    `INSERT INTO kanban_cards
    (id, board_id, column_id, title, assignee, session_id, epic_id, dispatched_by_autonomous, phase_id)
    VALUES ('card', 'board', 'working', 'Decode HATCH header', 'Dev', 'original', ?, ?, ?)`,
  ).run(
    linkedEpic ? 'epic' : null,
    autonomous || phaseAutonomous ? 1 : 0,
    phaseAutonomous ? 'phase' : null,
  );
  const interrupt = () => {
    stmts.insertActiveTask.run(
      'original',
      'message',
      'agent',
      null,
      'Implement the HATCH header',
      'grok-cli',
      'grok-4.6',
    );
    stmts.appendActiveTaskOutput.run('Implementation in progress', 'original');
  };
  const saveErrorMessage = vi.fn(() => 'error-message');
  const listKilledShells = vi.fn(() => [{ id: 'shell', command: 'npm test', label: 'tests' }]);
  const recover = () => reconcileOrphanedTasks({ stmts, saveErrorMessage, listKilledShells });
  return { db, stmts, interrupt, recover, saveErrorMessage, listKilledShells };
}

describe('orphaned task recovery', () => {
  it.each([
    ['autonomous epic', true, true, false],
    ['independently running phase', false, true, true],
    ['manually assigned epic', false, true, false],
    ['ordinary card', false, false, false],
  ] as const)(
    'resumes the same session for an interrupted %s without requeueing its card',
    (_name, autonomous, linkedEpic, phaseAutonomous) => {
      const f = fixture(autonomous, linkedEpic, phaseAutonomous);
      const before = f.stmts.getKanbanCard.get('card');
      const original = f.stmts.getSession.get('original') as SessionRow;
      f.interrupt();
      const resumes = f.recover();
      expect(resumes).toEqual([
        { sessionId: 'original', agentId: 'agent', content: expect.stringContaining('restart') },
      ]);
      expect(f.stmts.getKanbanCard.get('card')).toEqual(before);
      // These are the production dispatcher queries. Recovery must not turn the
      // interrupted card into a candidate for a newly created session.
      expect(f.stmts.getEligibleAutonomousCards.all('epic')).toEqual([]);
      expect(f.stmts.getEligibleAutonomousSpikeCards.all('epic')).toEqual([]);
      expect(f.stmts.getEligibleAutonomousCardsByPhase.all('phase')).toEqual([]);
      const resumed = f.stmts.getSession.get('original') as SessionRow;
      expect(resumed.engine_session_id).toBe(original.engine_session_id);
      expect(resumed.worktree_path).toBe(original.worktree_path);
      expect(resumed.engine).toBe('grok-cli');
      expect(resumed.resume_attempts).toBe(1);
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
      expect(f.stmts.getAllActiveTasks.all()).toEqual([]);
      expect(f.saveErrorMessage).not.toHaveBeenCalled();
      expect(f.listKilledShells).toHaveBeenCalledWith('original');
      expect(resumes[0].content).toContain('npm test');
    },
  );

  it('keeps epic work in the same session across repeated restarts and stops at the resume cap', () => {
    const f = fixture(true);
    const before = f.stmts.getKanbanCard.get('card');
    for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS; attempt++) {
      f.interrupt();
      expect(f.recover().map((r) => r.sessionId)).toEqual(['original']);
      expect(f.stmts.getEligibleAutonomousCards.all('epic')).toEqual([]);
      expect(f.stmts.getKanbanCard.get('card')).toEqual(before);
    }
    f.interrupt();
    expect(f.recover()).toEqual([]);
    expect(f.saveErrorMessage).toHaveBeenCalledWith(
      'original',
      'message',
      'grok-cli',
      'grok-4.6',
      expect.stringContaining('not resumed again to avoid a crash loop'),
    );
    expect((f.stmts.getSession.get('original') as SessionRow).resume_attempts).toBe(
      MAX_RESUME_ATTEMPTS,
    );
    expect(f.stmts.getKanbanCard.get('card')).toEqual(before);
    expect(f.stmts.getEligibleAutonomousCards.all('epic')).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
    expect(f.recover()).toEqual([]);
  });
});
