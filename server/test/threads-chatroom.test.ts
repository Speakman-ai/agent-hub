/**
 * Chatroom semantics on top of the existing thread (heartbeat / cron log)
 * surface. Daemons keep writing via `stmts.createThreadEntry` directly
 * (role defaults to 'system'); humans hit `POST /api/threads/:threadId/entries`
 * which stamps `role='user'` and the resolved `authUserId`.
 *
 * In the test harness, `setup.ts` deletes `AGENT_HUB_API_KEY` and no JWT
 * auth record is configured, so the auth middleware short-circuits with
 * `authRole='Owner'` but no `authUserId`. That's the realistic
 * single-tenant / Electron path, and the route is expected to accept the
 * write and record `author_user_id = NULL`.
 */
import type TestAgent from 'supertest/lib/agent.js';
import { v4 as uuidv4 } from 'uuid';
import { getRequest, createProject, createThread } from './helpers.js';
import type { Project, ThreadRow, ThreadEntryRow } from '../types.js';

let request: TestAgent;
let project: Project;

beforeAll(async () => {
  request = await getRequest();
  project = (await createProject()) as unknown as Project;
});

describe('POST /api/threads/:threadId/entries — chatroom write', () => {
  it("stamps role='user' on entries posted through the HTTP route", async () => {
    const thread = (await createThread(project.id as string)) as unknown as ThreadRow;

    const res = await request
      .post(`/api/threads/${thread.id}/entries`)
      .send({ content: 'hi from a human' })
      .expect(201);

    expect(res.body.role).toBe('user');
    expect(res.body.content).toBe('hi from a human');
    // No auth user in this harness → author_user_id should be null but
    // never undefined (the SELECT * MUST surface the column).
    expect(res.body).toHaveProperty('author_user_id');
    expect(res.body.author_user_id).toBeNull();
    expect(res.body).toHaveProperty('author_agent_id');
    expect(res.body.author_agent_id).toBeNull();
  });

  it("preserves role='system' for daemon writes via stmts.createThreadEntry", async () => {
    const { getStmts } = await import('../db.js');
    const stmts = getStmts();

    const thread = (await createThread(project.id as string)) as unknown as ThreadRow;
    const id = uuidv4();
    stmts.createThreadEntry.run(id, thread.id, 'heartbeat finished');

    const entry = stmts.getThreadEntry.get(id) as ThreadEntryRow;
    expect(entry.role).toBe('system');
    expect(entry.author_user_id).toBeNull();
    expect(entry.author_agent_id).toBeNull();
  });

  it('returned entries surface role + author columns to the client', async () => {
    const thread = (await createThread(project.id as string)) as unknown as ThreadRow;
    await request
      .post(`/api/threads/${thread.id}/entries`)
      .send({ content: 'first human reply' })
      .expect(201);

    // Daemon-side write — should land in the same listing with role='system'.
    const { getStmts } = await import('../db.js');
    const stmts = getStmts();
    stmts.createThreadEntry.run(uuidv4(), thread.id, 'cron tick');

    const res = await request.get(`/api/threads/${thread.id}/entries`).expect(200);
    const entries = res.body as ThreadEntryRow[];
    expect(entries.length).toBe(2);

    const roles = entries.map((e) => e.role).sort();
    expect(roles).toEqual(['system', 'user']);
    // Every entry must expose the new columns, not just the ones we just wrote.
    for (const e of entries) {
      expect(e).toHaveProperty('author_user_id');
      expect(e).toHaveProperty('author_agent_id');
      expect(e).toHaveProperty('role');
    }
  });

  it('rejects whitespace-only content', async () => {
    const thread = (await createThread(project.id as string)) as unknown as ThreadRow;
    await request.post(`/api/threads/${thread.id}/entries`).send({ content: '   ' }).expect(400);
  });
});
