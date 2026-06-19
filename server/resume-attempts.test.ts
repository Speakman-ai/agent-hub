import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Stmts } from './types.js';
import {
  MAX_RESUME_ATTEMPTS,
  shouldGiveUpAutoResume,
  shouldResetResumeAttemptsOnTurnStart,
} from './resume-attempts.js';

/**
 * Regression coverage for the post-restart auto-resume crash-loop guard.
 *
 * Before this guard, `reconcileOrphanedTasks` re-spawned every orphaned session
 * on every boot with no attempt counter — a server stuck in a crash/restart
 * loop (a bad deploy that dies mid-turn) would re-spawn the same sessions
 * forever. These tests pin both halves of the fix: the pure cap decision and
 * the persistent `resume_attempts` increment/reset SQL.
 */

describe('shouldGiveUpAutoResume', () => {
  it('resumes below the cap', () => {
    expect(shouldGiveUpAutoResume(0)).toBe(false);
    expect(shouldGiveUpAutoResume(MAX_RESUME_ATTEMPTS - 1)).toBe(false);
  });

  it('gives up at and above the cap', () => {
    expect(shouldGiveUpAutoResume(MAX_RESUME_ATTEMPTS)).toBe(true);
    expect(shouldGiveUpAutoResume(MAX_RESUME_ATTEMPTS + 5)).toBe(true);
  });

  it('treats nullish / negative attempts as zero (never blocks a fresh session)', () => {
    expect(shouldGiveUpAutoResume(null)).toBe(false);
    expect(shouldGiveUpAutoResume(undefined)).toBe(false);
    expect(shouldGiveUpAutoResume(-3)).toBe(false);
  });

  it('honours an explicit cap override', () => {
    expect(shouldGiveUpAutoResume(1, 1)).toBe(true);
    expect(shouldGiveUpAutoResume(1, 2)).toBe(false);
  });
});

/**
 * Mirror the production `resume_attempts` column + the increment/reset
 * statements against a real in-memory SQLite DB. The DEFAULT 0 and the
 * `resume_attempts != 0` reset guard match server/db.ts exactly.
 */
function makeStmts(): { db: Database.Database; stmts: Stmts } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      resume_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  const stmts = {
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    incrementSessionResumeAttempts: db.prepare(
      'UPDATE sessions SET resume_attempts = resume_attempts + 1 WHERE id = ?',
    ),
    resetSessionResumeAttempts: db.prepare(
      'UPDATE sessions SET resume_attempts = 0 WHERE id = ? AND resume_attempts != 0',
    ),
  } as unknown as Stmts;
  return { db, stmts };
}

type SessRow = { id: string; resume_attempts: number };
const attemptsOf = (stmts: Stmts, id: string): number =>
  (stmts.getSession.get(id) as SessRow).resume_attempts;

describe('resume_attempts persistence (crash-loop accounting)', () => {
  let db: Database.Database;
  let stmts: Stmts;

  beforeEach(() => {
    ({ db, stmts } = makeStmts());
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run('s1');
  });

  it('defaults to 0 for a new session', () => {
    expect(attemptsOf(stmts, 's1')).toBe(0);
  });

  it('increments on each boot-time resume and trips the cap', () => {
    // Simulate a crash loop: each boot increments, never a clean close.
    let gaveUp = false;
    for (let boot = 0; boot < 6; boot++) {
      const prior = attemptsOf(stmts, 's1');
      if (shouldGiveUpAutoResume(prior)) {
        gaveUp = true;
        break;
      }
      stmts.incrementSessionResumeAttempts.run('s1');
    }
    expect(gaveUp).toBe(true);
    // Stopped exactly at the cap, not before, not runaway.
    expect(attemptsOf(stmts, 's1')).toBe(MAX_RESUME_ATTEMPTS);
  });

  it('give-up is durable: the give-up branch itself never touches the counter', () => {
    // Drive the crash loop up to the cap.
    for (let boot = 0; boot < MAX_RESUME_ATTEMPTS; boot++) {
      stmts.incrementSessionResumeAttempts.run('s1');
    }
    expect(attemptsOf(stmts, 's1')).toBe(MAX_RESUME_ATTEMPTS);

    // Next boot hits the give-up branch. Reconcile must NOT touch the counter
    // here (regression guard: an earlier version reset it to 0 in the give-up
    // path, which erased the durable "gave up" signal). The orphan row is
    // cleared by deleteAllActiveTasks and no resume is spawned, so the session
    // stays capped and fails closed across boots until a fresh turn supersedes.
    expect(shouldGiveUpAutoResume(attemptsOf(stmts, 's1'))).toBe(true);
    expect(attemptsOf(stmts, 's1')).toBe(MAX_RESUME_ATTEMPTS);
    expect(shouldGiveUpAutoResume(attemptsOf(stmts, 's1'))).toBe(true);
  });

  it('reset is a no-op when already 0 (guarded to avoid needless writes)', () => {
    const res = stmts.resetSessionResumeAttempts.run('s1');
    expect(res.changes).toBe(0);
    expect(attemptsOf(stmts, 's1')).toBe(0);
  });
});

describe('shouldResetResumeAttemptsOnTurnStart (human turn supersedes give-up)', () => {
  it('resets for a fresh externally-initiated turn', () => {
    expect(shouldResetResumeAttemptsOnTurnStart({})).toBe(true);
    expect(
      shouldResetResumeAttemptsOnTurnStart({ isAutoResume: false, isAutoContinuation: false }),
    ).toBe(true);
  });

  it('does NOT reset for an automatic crash-resume (its increment must stand)', () => {
    expect(shouldResetResumeAttemptsOnTurnStart({ isAutoResume: true })).toBe(false);
  });

  it('does NOT reset for an in-turn ReAct continuation (would clear the cap mid-resume)', () => {
    // Continuations of an auto-resume carry only `_autoContinuation`, not
    // `_autoResume`; resetting here would defeat the cap.
    expect(shouldResetResumeAttemptsOnTurnStart({ isAutoContinuation: true })).toBe(false);
  });
});

describe('crash-loop lifecycle: a human turn is never capped (reviewer scenario)', () => {
  let db: Database.Database;
  let stmts: Stmts;

  beforeEach(() => {
    ({ db, stmts } = makeStmts());
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run('s1');
  });

  // Models the exact sequence the reviewer flagged: after auto-resume hits the
  // cap and we give up, a human sends a new message whose turn is itself
  // interrupted before it reaches a clean exit. The fresh-turn reset must have
  // already cleared the counter at turn START, so the next boot auto-resumes
  // the human turn with a full budget instead of immediately giving up.
  const startTurn = (opts: { isAutoResume?: boolean; isAutoContinuation?: boolean }): void => {
    if (shouldResetResumeAttemptsOnTurnStart(opts)) {
      stmts.resetSessionResumeAttempts.run('s1');
    }
  };

  it('a human turn after give-up resets the cap even if interrupted before completing', () => {
    // 1) Auto-resume crash loop burns the budget and gives up.
    for (let boot = 0; boot < MAX_RESUME_ATTEMPTS; boot++) {
      startTurn({ isAutoResume: true }); // auto-resume: no reset
      stmts.incrementSessionResumeAttempts.run('s1'); // reconcile increment
    }
    expect(attemptsOf(stmts, 's1')).toBe(MAX_RESUME_ATTEMPTS);
    expect(shouldGiveUpAutoResume(attemptsOf(stmts, 's1'))).toBe(true); // give up, counter stays

    // 2) Human sends a new message. handleChat resets at turn START...
    startTurn({}); // fresh human turn
    expect(attemptsOf(stmts, 's1')).toBe(0);

    // 3) ...and the server restarts mid-turn, BEFORE any clean process exit.
    //    Next boot, reconcile reads resume_attempts = 0 -> NOT capped.
    expect(shouldGiveUpAutoResume(attemptsOf(stmts, 's1'))).toBe(false);
  });

  it('an auto-resume continuation does not reset the in-flight cap', () => {
    startTurn({ isAutoResume: true });
    stmts.incrementSessionResumeAttempts.run('s1');
    // ReAct continuation within the same auto-resume turn must NOT reset.
    startTurn({ isAutoContinuation: true });
    expect(attemptsOf(stmts, 's1')).toBe(1);
  });
});
