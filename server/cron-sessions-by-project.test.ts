import './test/setup.js';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { getStmts } from './db.js';

/**
 * The exact backfill statement run at DB init (server/db.ts) to retro-tag cron
 * sessions created before the consult tagging shipped. Kept in lockstep with
 * the production string; the test below pins its behavior.
 */
const CONSULT_BACKFILL_SQL =
  "UPDATE sessions SET session_mode = 'consult' WHERE cron_id IS NOT NULL AND session_mode != 'consult'";

/**
 * Regression coverage for the per-project scheduled-tasks sidebar grouping and
 * the consult-only contract for cron sessions.
 *
 * Unlike a hand-mirrored SQL copy, this exercises the REAL `getAllCronSessions`
 * prepared statement from server/db.ts against the real schema, so the test
 * fails if production SQL drifts (e.g. someone drops the `c.project_id` alias).
 *
 * Contract pinned:
 *  - `getAllCronSessions` surfaces `c.project_id as project_id` so the client
 *    can group scheduled-task rows under their owning project. The sessions
 *    table has no project_id column of its own — cron sessions use the `_cron`
 *    pseudo agent — so the join's project_id is the only source.
 *  - `crons.project_id` is nullable, so a cron session can legitimately carry a
 *    NULL project_id. The sidebar relies on this to route such rows to the
 *    "Ungrouped" bucket rather than dropping them.
 *  - Cron sessions are tagged `session_mode = 'consult'` (read-only surface).
 */

interface CronSessionRow {
  id: string;
  project_id: string | null;
  cron_name: string;
  cron_schedule: string;
  session_mode: string;
  cron_shared: number;
}

/** Create a cron + its linked consult session via the real prepared statements. */
function makeCronSession(opts: {
  projectId: string | null;
  cronName: string;
  schedule: string;
  shared?: 0 | 1;
}): {
  sessionId: string;
  cronId: number;
} {
  const stmts = getStmts();
  const cronResult = stmts.createCron.run(
    opts.cronName,
    opts.schedule,
    null, // timezone
    'noop prompt', // prompt
    '/tmp', // cwd (NOT NULL)
    1, // enabled
    opts.projectId, // project_id (nullable)
    null, // timeout_ms
    0, // notify_on_run
    null, // model
    null, // skill_principal_agent_id
    null, // engine
    null, // owner_user_id
    opts.shared ?? 0, // shared
  );
  const cronId = Number(cronResult.lastInsertRowid);
  const sessionId = `cron-sess-${randomUUID()}`;
  stmts.createSession.run(
    sessionId,
    '_cron',
    `Cron: ${opts.cronName}`,
    'claude-code',
    'claude-opus-4-8',
    0, // use_worktree
    0, // ask_mode
    1, // wiki_hybrid_rag_budget_version
  );
  stmts.updateSessionCronId.run(cronId, sessionId);
  // Mirror runCronJob: scheduled-task sessions are consult-only.
  stmts.updateSessionMode.run('consult', sessionId);
  return { sessionId, cronId };
}

describe('getAllCronSessions — per-project grouping + consult mode', () => {
  it('surfaces the owning project_id (and name/schedule) for grouping', () => {
    const projectId = `proj-${randomUUID()}`;
    const { sessionId } = makeCronSession({
      projectId,
      cronName: 'Nightly reconcile',
      schedule: '0 0 * * *',
    });

    const rows = getStmts().getAllCronSessions.all() as CronSessionRow[];
    const row = rows.find((r) => r.id === sessionId);
    expect(row).toBeDefined();
    expect(row!.project_id).toBe(projectId);
    expect(row!.cron_name).toBe('Nightly reconcile');
    expect(row!.cron_schedule).toBe('0 0 * * *');
    expect(row!.session_mode).toBe('consult');
  });

  it('returns a NULL project_id for project-less crons (routed to Ungrouped)', () => {
    const { sessionId } = makeCronSession({
      projectId: null,
      cronName: 'Legacy global cron',
      schedule: '0 * * * *',
    });

    const rows = getStmts().getAllCronSessions.all() as CronSessionRow[];
    const row = rows.find((r) => r.id === sessionId);
    expect(row).toBeDefined();
    // A nullable project_id is a reachable state — it must survive the query so
    // the sidebar can bucket it as Ungrouped rather than silently dropping it.
    expect(row!.project_id).toBeNull();
    expect(row!.session_mode).toBe('consult');
  });

  it('surfaces cron_shared so the sidebar route can apply shared visibility', () => {
    // The scheduled-tasks sidebar (GET /api/sessions/cron) lists a shared
    // cron for every org member, not just its owner. That filter reads
    // `cron_shared` straight off this join — if the alias is dropped, the
    // fix silently regresses to owner-only. Pin both states.
    const shared = makeCronSession({
      projectId: `proj-${randomUUID()}`,
      cronName: 'Shared nightly',
      schedule: '0 0 * * *',
      shared: 1,
    });
    const priv = makeCronSession({
      projectId: `proj-${randomUUID()}`,
      cronName: 'Private nightly',
      schedule: '0 1 * * *',
      shared: 0,
    });

    const rows = getStmts().getAllCronSessions.all() as CronSessionRow[];
    expect(rows.find((r) => r.id === shared.sessionId)!.cron_shared).toBe(1);
    expect(rows.find((r) => r.id === priv.sessionId)!.cron_shared).toBe(0);
  });

  it('isolates each cron session under exactly its own project', () => {
    const projectA = `proj-a-${randomUUID()}`;
    const projectB = `proj-b-${randomUUID()}`;
    const a = makeCronSession({ projectId: projectA, cronName: 'A', schedule: '0 0 * * *' });
    const b = makeCronSession({ projectId: projectB, cronName: 'B', schedule: '0 1 * * *' });

    const rows = getStmts().getAllCronSessions.all() as CronSessionRow[];
    const forA = rows.filter((r) => r.project_id === projectA).map((r) => r.id);
    const forB = rows.filter((r) => r.project_id === projectB).map((r) => r.id);
    expect(forA).toEqual([a.sessionId]);
    expect(forB).toEqual([b.sessionId]);
  });
});

describe('consult backfill — retro-tags legacy cron sessions', () => {
  it('flips chat cron sessions to consult and leaves everything else alone', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        session_mode TEXT NOT NULL DEFAULT 'chat',
        cron_id INTEGER
      );
    `);
    const insert = db.prepare('INSERT INTO sessions (id, session_mode, cron_id) VALUES (?,?,?)');
    insert.run('legacy-cron-chat', 'chat', 1); // pre-change cron session → should flip
    insert.run('new-cron-consult', 'consult', 2); // already consult → untouched
    insert.run('regular-chat', 'chat', null); // not a cron → must stay chat
    insert.run('design-cron', 'design', 3); // a non-default, non-consult cron mode → flips

    db.exec(CONSULT_BACKFILL_SQL);

    const modeOf = (id: string) =>
      (
        db.prepare('SELECT session_mode FROM sessions WHERE id = ?').get(id) as {
          session_mode: string;
        }
      ).session_mode;

    expect(modeOf('legacy-cron-chat')).toBe('consult');
    expect(modeOf('new-cron-consult')).toBe('consult');
    expect(modeOf('regular-chat')).toBe('chat');
    expect(modeOf('design-cron')).toBe('consult');
    db.close();
  });
});
