/**
 * Per-user note visibility: private notes are owner-only, shared notes are
 * visible to every project member, and only the owner can flip visibility or
 * delete. WebSocket events for private notes reach only the owner.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { Project, RouteDeps } from '../types.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { initDb, getDb } = await import('../db.js');
const { default: createNoteRoutes } = await import('./notes.js');
const { shouldDeliverBroadcast } = await import('../broadcast-filter.js');

const PROJECT_ID = 'notes-visibility-project';
const project = {
  id: PROJECT_ID,
  name: 'Notes',
  cwd: '/tmp/notes',
  agents: [],
} as unknown as Project;
const broadcast = vi.fn();

function mount(authUserId: string | null): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) Object.assign(req, { authUserId, authUser: 'x', authRole: 'User' });
    next();
  });
  app.use(
    createNoteRoutes({
      broadcast,
      findProject: (id: string) => (id === PROJECT_ID ? project : null),
    } as unknown as RouteDeps),
  );
  return app;
}

const base = `/api/projects/${PROJECT_ID}/notes`;
let userA = '';
let userB = '';

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notes-visibility-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userA = createUser({ username: 'note-a', passwordHash: 'x' }).id;
  userB = createUser({ username: 'note-b', passwordHash: 'x' }).id;
  broadcast.mockClear();
});

async function createAs(userId: string | null, body: Record<string, unknown>) {
  return request(mount(userId)).post(base).send(body).expect(201);
}

describe('note visibility', () => {
  it('defaults a signed-in user’s new note to private and hides it from teammates', async () => {
    const res = await createAs(userA, { title: 'Mine', content: 'secret plan' });
    expect(res.body).toMatchObject({
      shared: false,
      owner_user_id: userA,
      owner_username: 'note-a',
      can_manage: true,
    });

    const listA = await request(mount(userA)).get(base).expect(200);
    expect(listA.body.map((n: { id: string }) => n.id)).toEqual([res.body.id]);

    const listB = await request(mount(userB)).get(base).expect(200);
    expect(listB.body).toEqual([]);
    const searchB = await request(mount(userB)).get(`${base}?q=secret`).expect(200);
    expect(searchB.body).toEqual([]);
    await request(mount(userB)).get(`${base}/${res.body.id}`).expect(404);
    await request(mount(userB)).put(`${base}/${res.body.id}`).send({ content: 'x' }).expect(404);
    await request(mount(userB)).delete(`${base}/${res.body.id}`).expect(404);
  });

  it('shares a note on request; teammates can read and edit but not delete or re-hide it', async () => {
    const res = await createAs(userA, { title: 'Team', content: 'agenda', shared: true });
    const id = res.body.id as string;

    const got = await request(mount(userB)).get(`${base}/${id}`).expect(200);
    expect(got.body).toMatchObject({ shared: true, can_manage: false, owner_username: 'note-a' });
    const searchB = await request(mount(userB)).get(`${base}?q=agenda`).expect(200);
    expect(searchB.body.map((n: { id: string }) => n.id)).toEqual([id]);

    await request(mount(userB)).put(`${base}/${id}`).send({ content: 'edited' }).expect(200);
    await request(mount(userB)).put(`${base}/${id}`).send({ shared: false }).expect(403);
    await request(mount(userB)).delete(`${base}/${id}`).expect(403);
    await request(mount(userA)).delete(`${base}/${id}`).expect(200);
  });

  it('lets the owner toggle a note private and back', async () => {
    const res = await createAs(userA, { title: 'Flip', shared: true });
    const id = res.body.id as string;

    const hidden = await request(mount(userA)).put(`${base}/${id}`).send({ shared: false });
    expect(hidden.status).toBe(200);
    expect(hidden.body.shared).toBe(false);
    await request(mount(userB)).get(`${base}/${id}`).expect(404);

    await request(mount(userA)).put(`${base}/${id}`).send({ shared: true }).expect(200);
    await request(mount(userB)).get(`${base}/${id}`).expect(200);
  });

  it('keeps notes that predate ownership shared, and lets a member claim one as private', async () => {
    getDb()
      .prepare("INSERT INTO notes (id, project_id, title, content) VALUES ('old', ?, 'Old', '')")
      .run(PROJECT_ID);
    const got = await request(mount(userB)).get(`${base}/old`).expect(200);
    expect(got.body).toMatchObject({ shared: true, owner_user_id: null, can_manage: true });

    const claimed = await request(mount(userA)).put(`${base}/old`).send({ shared: false });
    expect(claimed.body).toMatchObject({ shared: false, owner_user_id: userA });
    await request(mount(userB)).get(`${base}/old`).expect(404);
  });

  it('creates shared notes for callers without a user identity', async () => {
    const res = await createAs(null, { title: 'Agent note', shared: false });
    expect(res.body).toMatchObject({ shared: true, owner_user_id: null });
  });

  it('rejects a non-boolean shared flag', async () => {
    await request(mount(userA)).post(base).send({ title: 't', shared: 'yes' }).expect(400);
  });
});

describe('note broadcasts', () => {
  const deps = {
    resolveProjectId: () => null,
    findProject: () => null,
    getSessionOwner: () => null,
  };
  const stampFor = (userId: string) => ({ userId, role: 'Owner' as const, localBypass: false });

  it('tags private note events so only the owner receives them, with no content', async () => {
    await createAs(userA, { title: 'Private', content: 'secret' });
    const event = broadcast.mock.calls.at(-1)![0];
    expect(event).toMatchObject({ type: 'note_update', noteShared: false, ownerUserId: userA });
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(shouldDeliverBroadcast(event, stampFor(userA), deps)).toBe(true);
    // Org Owner role does not override a private note.
    expect(shouldDeliverBroadcast(event, stampFor(userB), deps)).toBe(false);
  });

  it('fans the visibility change out to every member so teammates drop the note', async () => {
    const res = await createAs(userA, { title: 'Flip', shared: true });
    broadcast.mockClear();
    await request(mount(userA)).put(`${base}/${res.body.id}`).send({ shared: false }).expect(200);
    const event = broadcast.mock.calls.at(-1)![0];
    expect(event.noteShared).toBeUndefined();
    expect(shouldDeliverBroadcast(event, stampFor(userB), deps)).toBe(true);
  });

  it('delivers private note deletes only to the owner', async () => {
    const res = await createAs(userA, { title: 'Gone' });
    await request(mount(userA)).delete(`${base}/${res.body.id}`).expect(200);
    const event = broadcast.mock.calls.at(-1)![0];
    expect(event.type).toBe('note_delete');
    expect(shouldDeliverBroadcast(event, stampFor(userB), deps)).toBe(false);
    expect(shouldDeliverBroadcast(event, stampFor(userA), deps)).toBe(true);
  });
});
