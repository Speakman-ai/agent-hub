import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import express from 'express';
import supertest from 'supertest';
import createSupportTicketRoutes from './support-tickets.js';
import { getDb, getStmts } from '../db.js';
import type { Project, RouteDeps, SessionReplayRow } from '../types.js';

/**
 * Proves the trusted-context replay attribution: a replay ingested anonymously
 * (project_id NULL) gets linked to a project + ticket when a project-scoped
 * support ticket is created / updated with its `replayRef`. Without this, the
 * read-API's per-project authorization could never let a project member read
 * their own capture (the gap the reviewer flagged).
 *
 * The DB is the per-process tmp DB from test/setup.ts. We build the router
 * directly (no app.listen) so this never binds the server port, and use a
 * `question` ticket so the bug-only AI investigation path (which would spawn a
 * CLI) is skipped.
 */

const PROJECTS: Record<string, Project> = {
  p1: { id: 'p1', cwd: '/tmp' } as unknown as Project,
  p2: { id: 'p2', cwd: '/tmp' } as unknown as Project,
};

function makeApp() {
  const deps = {
    broadcast: () => {},
    findProject: (id: string) => PROJECTS[id] ?? null,
    stmts: getStmts(),
    config: {} as unknown,
    serverDir: tmpdir(),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSupportTicketRoutes(deps));
  return app;
}

/** Insert an unattributed replay row (as POST /api/replays would) and return
 *  its id + canonical ref. */
function seedReplay(id: string): { id: string; ref: string } {
  getStmts().insertSessionReplay.run(
    id,
    null, // project_id
    0,
    1,
    10,
    20,
    'local',
    `replays/${id}.json.gz`,
    null,
    null,
    null,
    null,
    null,
  );
  return { id, ref: `/uploads/replay-${id}.json` };
}

beforeEach(() => {
  const db = getDb();
  if (!db.name.startsWith(tmpdir())) {
    throw new Error(`Refusing to wipe tables in non-tmp DB at ${db.name}`);
  }
  db.exec('DELETE FROM support_tickets; DELETE FROM session_replays;');
});

describe('support-ticket creation links the referenced replay', () => {
  it('attributes the replay to the project + new ticket on create', async () => {
    const { id, ref } = seedReplay('link-create-1');
    const app = makeApp();

    const res = await supertest(app)
      .post('/api/projects/p1/support-tickets')
      .send({ type: 'question', subject: 'why', body: 'broken', replayRef: ref })
      .expect(201);

    const ticketId = res.body.id as string;
    // The ref attributes to p1, so it's kept on the ticket.
    expect(res.body.replay_ref).toBe(ref);
    const row = getStmts().getSessionReplay.get(id) as SessionReplayRow;
    expect(row.project_id).toBe('p1');
    expect(row.support_ticket_id).toBe(ticketId);
  });

  it('attributes the replay when a ref is attached later via PATCH', async () => {
    const { id, ref } = seedReplay('link-patch-1');
    const app = makeApp();

    const created = await supertest(app)
      .post('/api/projects/p1/support-tickets')
      .send({ type: 'question', subject: 'q', body: 'b' })
      .expect(201);
    const ticketId = created.body.id as string;

    // Not linked yet.
    expect((getStmts().getSessionReplay.get(id) as SessionReplayRow).project_id).toBeNull();

    const patched = await supertest(app)
      .patch(`/api/projects/p1/support-tickets/${ticketId}`)
      .send({ replayRef: ref })
      .expect(200);
    expect(patched.body.replay_ref).toBe(ref); // kept — attributes to p1

    const row = getStmts().getSessionReplay.get(id) as SessionReplayRow;
    expect(row.project_id).toBe('p1');
    expect(row.support_ticket_id).toBe(ticketId);
  });

  it('refuses to reassign a replay already linked to another project (no steal)', async () => {
    const { id, ref } = seedReplay('link-steal-1');
    const app = makeApp();

    // Legit: project p1 attaches the replay to its ticket.
    const owner = await supertest(app)
      .post('/api/projects/p1/support-tickets')
      .send({ type: 'question', subject: 'mine', body: 'b', replayRef: ref })
      .expect(201);
    const ownerTicketId = owner.body.id as string;

    // Attacker: project p2 references the SAME ref to try to pull it over.
    const attacker = await supertest(app)
      .post('/api/projects/p2/support-tickets')
      .send({ type: 'question', subject: 'gimme', body: 'b', replayRef: ref })
      .expect(201);

    // The foreign ref is CLEARED on p2's ticket, so its investigation can never
    // resolve project A's capture via the legacy /uploads path.
    expect(attacker.body.replay_ref).toBeNull();

    // Attribution is unchanged — p2 never gains the project link (and thus no
    // read access via canViewProject), nor poisons the ticket/card metadata.
    const row = getStmts().getSessionReplay.get(id) as SessionReplayRow;
    expect(row.project_id).toBe('p1');
    expect(row.support_ticket_id).toBe(ownerTicketId);
    expect(row.card_id).toBeNull();
  });

  it('clears a ref via PATCH when it belongs to another project', async () => {
    const { ref } = seedReplay('link-steal-patch');
    const app = makeApp();
    // p1 owns it first.
    await supertest(app)
      .post('/api/projects/p1/support-tickets')
      .send({ type: 'question', subject: 'mine', body: 'b', replayRef: ref })
      .expect(201);
    // p2 makes a ticket, then tries to attach the foreign ref via PATCH.
    const p2 = await supertest(app)
      .post('/api/projects/p2/support-tickets')
      .send({ type: 'question', subject: 'q', body: 'b' })
      .expect(201);
    const res = await supertest(app)
      .patch(`/api/projects/p2/support-tickets/${p2.body.id}`)
      .send({ replayRef: ref })
      .expect(200);
    expect(res.body.replay_ref).toBeNull();
  });

  it('clears a ref that matches no stored replay row (cannot be attributed)', async () => {
    const app = makeApp();
    // No seedReplay — the ref points at a replay that was never stored, so it
    // can't be attributed to this project and must not be persisted.
    const res = await supertest(app)
      .post('/api/projects/p1/support-tickets')
      .send({ type: 'question', subject: 's', body: 'b', replayRef: '/uploads/replay-ghost.json' })
      .expect(201);
    expect(res.body.replay_ref).toBeNull();
    expect(getStmts().getSessionReplay.get('ghost')).toBeUndefined();
  });
});
