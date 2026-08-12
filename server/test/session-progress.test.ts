/**
 * Unit test for the `session_progress` table + prepared statements that
 * back the in-Hub Cursor-style ProgressPanel.
 *
 * Regressions here would break the panel's rehydration on session reload:
 * a user returning to a running session would see an empty panel even
 * though the agent is mid-flight.
 */
import './setup.js';
import { getStmts } from '../db.js';
import type { SessionProgressRow } from '../types.js';

describe('session_progress — insert, complete, fetch', () => {
  const SESSION_ID = 'session-progress-test-1';

  beforeAll(() => {
    const stmts = getStmts();
    expect(stmts.addSessionProgress).toBeDefined();
    expect(stmts.completeSessionProgress).toBeDefined();
    expect(stmts.getSessionProgress).toBeDefined();
    expect(stmts.deleteSessionProgress).toBeDefined();
    // Clean slate in case a prior run left rows.
    stmts.deleteSessionProgress.run(SESSION_ID);
  });

  afterEach(() => {
    const stmts = getStmts();
    stmts.deleteSessionProgress.run(SESSION_ID);
  });

  it('inserts a started row and fetches it back in emit order', () => {
    const stmts = getStmts();
    stmts.addSessionProgress.run(
      SESSION_ID,
      'msg-1',
      'Gather PR context',
      'started',
      1000,
      null,
      null,
    );
    stmts.addSessionProgress.run(
      SESSION_ID,
      'msg-1',
      'Analyze diff and files',
      'started',
      2000,
      null,
      null,
    );

    const rows = stmts.getSessionProgress.all(SESSION_ID) as SessionProgressRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0].step).toBe('Gather PR context');
    expect(rows[0].status).toBe('started');
    expect(rows[0].started_at).toBe(1000);
    expect(rows[0].finished_at).toBeNull();
    expect(rows[1].step).toBe('Analyze diff and files');
  });

  it('completeSessionProgress closes the most recent open row for (session, step)', () => {
    const stmts = getStmts();
    stmts.addSessionProgress.run(
      SESSION_ID,
      'msg-1',
      'Gather PR context',
      'started',
      1000,
      null,
      null,
    );
    const info = stmts.completeSessionProgress.run(
      'completed',
      5000,
      null,
      SESSION_ID,
      'Gather PR context',
    ) as { changes?: number };
    expect(info.changes).toBe(1);

    const rows = stmts.getSessionProgress.all(SESSION_ID) as SessionProgressRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].finished_at).toBe(5000);
  });

  it('failed status is preserved through complete()', () => {
    const stmts = getStmts();
    stmts.addSessionProgress.run(
      SESSION_ID,
      null,
      'Post formal review',
      'started',
      1000,
      null,
      null,
    );
    stmts.completeSessionProgress.run(
      'failed',
      2500,
      '$ false (exit 1)\nboom',
      SESSION_ID,
      'Post formal review',
    );

    const rows = stmts.getSessionProgress.all(SESSION_ID) as SessionProgressRow[];
    expect(rows[0].status).toBe('failed');
    expect(rows[0].finished_at).toBe(2500);
    expect(rows[0].detail).toBe('$ false (exit 1)\nboom');
  });

  it('completeSessionProgress affects zero rows when no open step matches', () => {
    const stmts = getStmts();
    const info = stmts.completeSessionProgress.run(
      'completed',
      9999,
      null,
      SESSION_ID,
      'Never started',
    ) as { changes?: number };
    expect(info.changes).toBe(0);
  });

  it('re-emitting a step across a session only closes the most recent open row', () => {
    const stmts = getStmts();
    // First emission (early review)
    stmts.addSessionProgress.run(
      SESSION_ID,
      'msg-1',
      'Gather PR context',
      'started',
      1000,
      null,
      null,
    );
    stmts.completeSessionProgress.run('completed', 1500, null, SESSION_ID, 'Gather PR context');
    // Second emission (re-review after autofix)
    stmts.addSessionProgress.run(
      SESSION_ID,
      'msg-2',
      'Gather PR context',
      'started',
      5000,
      null,
      null,
    );

    stmts.completeSessionProgress.run('completed', 5800, null, SESSION_ID, 'Gather PR context');

    const rows = stmts.getSessionProgress.all(SESSION_ID) as SessionProgressRow[];
    expect(rows).toHaveLength(2);
    // First row stays closed with original timing
    expect(rows[0].finished_at).toBe(1500);
    // Second row is now closed with the later timing
    expect(rows[1].finished_at).toBe(5800);
  });

  it('deleteSessionProgress wipes all rows for a session', () => {
    const stmts = getStmts();
    stmts.addSessionProgress.run(SESSION_ID, 'msg-1', 'A', 'started', 1, null, null);
    stmts.addSessionProgress.run(SESSION_ID, 'msg-1', 'B', 'completed', 2, 3, null);
    stmts.deleteSessionProgress.run(SESSION_ID);
    const rows = stmts.getSessionProgress.all(SESSION_ID) as SessionProgressRow[];
    expect(rows).toHaveLength(0);
  });
});
