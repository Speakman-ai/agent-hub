import { describe, expect, it } from 'vitest';
import { getStmts } from './db.js';

describe('spawned_from_session_id', () => {
  it('keeps workers out of the agent list and returns them for the parent', () => {
    const stmts = getStmts();
    stmts.createSession.run('parent-1', 'agent-1', 'Orchestrate', 'claude-code', 'm', 0, 0, 1);
    stmts.createSession.run('child-1', 'agent-1', 'Fix login', 'claude-code', 'm', 1, 0, 1);
    stmts.createSession.run('peer-1', 'agent-1', 'Other chat', 'claude-code', 'm', 1, 0, 1);
    stmts.updateSessionMode.run('orchestrate', 'parent-1');
    stmts.markSessionSpawnedFrom.run('parent-1', 'child-1');

    const listed = stmts.getSessions.all('agent-1').map((row) => (row as { id: string }).id);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining(['parent-1', 'peer-1']));
    expect(listed).not.toContain('child-1');
    expect(
      stmts.getSpawnedSessions.all('parent-1').map((row) => (row as { id: string }).id),
    ).toEqual(['child-1']);
    expect(stmts.getSpawnedSessions.all('peer-1')).toEqual([]);
    stmts.softDeleteSession.run('child-1');
    expect(stmts.getSpawnedSessions.all('parent-1')).toEqual([]);
    expect(
      stmts.getArchivedSpawnedSessions.all('parent-1').map((row) => (row as { id: string }).id),
    ).toEqual(['child-1']);
    expect(
      stmts.getArchivedSessionsByAgent.all('agent-1').map((row) => (row as { id: string }).id),
    ).not.toContain('child-1');
  });

  function ids(rows: unknown[]): string[] {
    return rows.map((row) => (row as { id: string }).id);
  }

  function seedParentWithWorkers(prefix: string): void {
    const stmts = getStmts();
    stmts.createSession.run(`${prefix}-p`, `${prefix}-agent`, 'Orch', 'claude-code', 'm', 0, 0, 1);
    stmts.createSession.run(
      `${prefix}-live`,
      `${prefix}-agent`,
      'Live',
      'claude-code',
      'm',
      1,
      0,
      1,
    );
    stmts.createSession.run(`${prefix}-old`, `${prefix}-agent`, 'Old', 'claude-code', 'm', 1, 0, 1);
    stmts.updateSessionMode.run('orchestrate', `${prefix}-p`);
    stmts.markSessionSpawnedFrom.run(`${prefix}-p`, `${prefix}-live`);
    stmts.markSessionSpawnedFrom.run(`${prefix}-p`, `${prefix}-old`);
    stmts.softDeleteSession.run(`${prefix}-old`);
    expect(ids(stmts.getSessions.all(`${prefix}-agent`))).toEqual([`${prefix}-p`]);
  }

  it('returns workers to the agent lists when the parent leaves Orchestrate', () => {
    const stmts = getStmts();
    seedParentWithWorkers('mode');
    stmts.updateSessionMode.run('consult', 'mode-p');

    expect(ids(stmts.getSessions.all('mode-agent'))).toEqual(
      expect.arrayContaining(['mode-p', 'mode-live']),
    );
    expect(ids(stmts.getArchivedSessionsByAgent.all('mode-agent'))).toContain('mode-old');
    expect(stmts.getSpawnedSessions.all('mode-p')).toEqual([]);
    // Turning Orchestrate back on does not hide them again.
    stmts.updateSessionMode.run('orchestrate', 'mode-p');
    expect(ids(stmts.getSessions.all('mode-agent'))).toContain('mode-live');
  });

  it('returns workers to the agent lists when the parent is archived or restored', () => {
    const stmts = getStmts();
    seedParentWithWorkers('arch');
    stmts.softDeleteSession.run('arch-p');

    expect(ids(stmts.getSessions.all('arch-agent'))).toEqual(['arch-live']);
    expect(ids(stmts.getArchivedSessionsByAgent.all('arch-agent'))).toEqual(
      expect.arrayContaining(['arch-p', 'arch-old']),
    );
    stmts.restoreArchivedSession.run('arch-p');
    expect(ids(stmts.getSessions.all('arch-agent'))).toEqual(
      expect.arrayContaining(['arch-p', 'arch-live']),
    );
  });

  it('detaches workers when the parent row is purged', () => {
    const stmts = getStmts();
    seedParentWithWorkers('purge');
    stmts.deleteSession.run('purge-p');

    const live = stmts.getSession.get('purge-live') as { spawned_from_session_id: string | null };
    const old = stmts.getSession.get('purge-old') as { spawned_from_session_id: string | null };
    expect(live.spawned_from_session_id).toBeNull();
    expect(old.spawned_from_session_id).toBeNull();
    expect(ids(stmts.getSessions.all('purge-agent'))).toEqual(['purge-live']);
  });
});
