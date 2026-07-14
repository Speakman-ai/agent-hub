/**
 * Integration tests for the personal dashboard aggregation
 * (`/api/me/dashboard`, `/api/me/work`).
 *
 * Locks the invariants the epic spec (AGGREGATION) cares about:
 *   1. RBAC filtering — a user only ever sees assigned cards on boards they can
 *      view. A card assigned to them on a *private project they don't own* is
 *      never returned.
 *   2. The payload aggregates work + open todos + a soft-degrading Google block.
 *   3. Read-only + cached per-uid — a second request inside the TTL reuses the
 *      cached Google read; `?fresh=1` bypasses it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Project, RouteDeps, AppConfig } from '../types.js';
import type { DashboardGoogle, GoogleReader } from '../me-dashboard-google.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createTodo } = await import('../user-todos-store.js');
const { getDb } = await import('../db.js');
const { clearMeDashboardCache } = await import('../me-dashboard.js');
const { default: createMeDashboardRoutes } = await import('./me-dashboard.js');

let TMP_DIR = '';
let userA = '';
let userB = '';
const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

/** A minimal project record with just the fields the visibility gate reads. */
function project(id: string, ownerUserId: string): Project {
  return {
    id,
    name: `Project ${id}`,
    cwd: '/tmp',
    ahw: '/tmp',
    visibility: 'private',
    ownerUserId,
  } as Project;
}

/** Insert a board + a To Do and a Done column; return their ids. */
function seedBoard(projectId: string): { boardId: string; todoCol: string; doneCol: string } {
  const db = getDb();
  const boardId = uuidv4();
  const todoCol = uuidv4();
  const doneCol = uuidv4();
  db.prepare(
    'INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)',
  ).run(boardId, projectId, 'Board', 'AH');
  db.prepare(
    'INSERT INTO kanban_columns (id, board_id, name, position, color) VALUES (?, ?, ?, ?, ?)',
  ).run(todoCol, boardId, 'To Do', 0, '#fff');
  db.prepare(
    'INSERT INTO kanban_columns (id, board_id, name, position, color) VALUES (?, ?, ?, ?, ?)',
  ).run(doneCol, boardId, 'Done', 1, '#fff');
  return { boardId, todoCol, doneCol };
}

function seedCard(opts: {
  boardId: string;
  columnId: string;
  title: string;
  assignedUserId: string | null;
  priority?: string;
}): string {
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, priority, position, assigned_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.columnId,
      opts.boardId,
      opts.title,
      opts.priority ?? 'high',
      0,
      opts.assignedUserId,
    );
  return id;
}

const disconnectedGoogle: DashboardGoogle = {
  configured: false,
  connected: false,
  email: null,
  reconnectRequired: false,
  calendar: { scopeGranted: false, date: null, timeZone: null, events: [], error: null },
  mail: {
    scopeGranted: false,
    unread: null,
    starred: null,
    important: null,
    messages: [],
    error: null,
  },
};

function makeDeps(): RouteDeps {
  return {
    getProjects: () => [project(PROJECT_A, userA), project(PROJECT_B, userB)],
    config: { googleOAuth: null } as AppConfig,
  } as unknown as RouteDeps;
}

/** Mount the router with a fixed acting user + an injectable Google reader. */
function mount(authUserId: string | null, googleReader?: GoogleReader): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) Object.assign(req, { authUserId, authUser: 'x', authRole: 'User' });
    next();
  });
  app.use(createMeDashboardRoutes(makeDeps(), googleReader ? { googleReader } : {}));
  return app;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'me-dashboard-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  userA = createUser({ username: 'user-a', passwordHash: 'x' }).id;
  userB = createUser({ username: 'user-b', passwordHash: 'x' }).id;
  clearMeDashboardCache();
  // Fresh kanban tables per test file are guaranteed by test/setup isolation;
  // clear cards/boards between cases so counts are deterministic.
  const db = getDb();
  db.prepare('DELETE FROM kanban_cards').run();
  db.prepare('DELETE FROM kanban_columns').run();
  db.prepare('DELETE FROM kanban_boards').run();
});

describe('GET /api/me/work (RBAC filtering)', () => {
  it('returns only assigned cards on boards the caller can view', async () => {
    const a = seedBoard(PROJECT_A);
    const b = seedBoard(PROJECT_B);
    // Both cards are assigned to userA, but PROJECT_B is private + owned by userB.
    seedCard({
      boardId: a.boardId,
      columnId: a.todoCol,
      title: 'A visible',
      assignedUserId: userA,
    });
    seedCard({ boardId: b.boardId, columnId: b.todoCol, title: 'B hidden', assignedUserId: userA });

    const res = await request(mount(userA)).get('/api/me/work').expect(200);
    const titles = res.body.cards.map((c: { title: string }) => c.title);
    expect(titles).toEqual(['A visible']);
    expect(res.body.counts.total).toBe(1);
    expect(res.body.counts.open).toBe(1);
    expect(res.body.counts.byPriority.high).toBe(1);
  });

  it('flags done-column cards without counting them as open', async () => {
    const a = seedBoard(PROJECT_A);
    seedCard({ boardId: a.boardId, columnId: a.todoCol, title: 'open one', assignedUserId: userA });
    seedCard({ boardId: a.boardId, columnId: a.doneCol, title: 'done one', assignedUserId: userA });

    const res = await request(mount(userA)).get('/api/me/work').expect(200);
    expect(res.body.counts.total).toBe(2);
    expect(res.body.counts.open).toBe(1);
    const done = res.body.cards.find((c: { title: string }) => c.title === 'done one');
    expect(done.isDone).toBe(true);
    expect(res.body.cards.find((c: { title: string }) => c.title === 'open one').isDone).toBe(
      false,
    );
  });

  it('does not leak another user’s assigned cards', async () => {
    const b = seedBoard(PROJECT_B);
    seedCard({ boardId: b.boardId, columnId: b.todoCol, title: 'B owns', assignedUserId: userB });
    // userA can't view PROJECT_B → sees nothing.
    const res = await request(mount(userA)).get('/api/me/work').expect(200);
    expect(res.body.cards).toEqual([]);
    // userB owns PROJECT_B → sees their card.
    const resB = await request(mount(userB)).get('/api/me/work').expect(200);
    expect(resB.body.cards.map((c: { title: string }) => c.title)).toEqual(['B owns']);
  });

  it('401s when unauthenticated', async () => {
    await request(mount(null)).get('/api/me/work').expect(401);
  });
});

describe('GET /api/me/dashboard', () => {
  it('aggregates work, open todos, and a disconnected Google block', async () => {
    const a = seedBoard(PROJECT_A);
    seedCard({ boardId: a.boardId, columnId: a.todoCol, title: 'my card', assignedUserId: userA });
    createTodo({ userId: userA, title: 'open todo' });
    const doneTodo = createTodo({ userId: userA, title: 'done todo' });
    // Mark one todo done so only the open one shows.
    getDb(); // ensure db init side-effect ordering
    const { updateTodo } = await import('../user-todos-store.js');
    updateTodo(userA, doneTodo.id, { status: 'done' });

    const res = await request(mount(userA)).get('/api/me/dashboard').expect(200);
    expect(res.body.work.cards.map((c: { title: string }) => c.title)).toEqual(['my card']);
    expect(res.body.todos.openCount).toBe(1);
    expect(res.body.todos.open.map((t: { title: string }) => t.title)).toEqual(['open todo']);
    expect(res.body.google.configured).toBe(false);
    expect(typeof res.body.generatedAt).toBe('string');
  });

  it('caches the Google read per-uid and honours ?fresh=1', async () => {
    const reader = vi.fn<GoogleReader>().mockResolvedValue(disconnectedGoogle);
    const app = mount(userA, reader);

    await request(app).get('/api/me/dashboard').expect(200);
    await request(app).get('/api/me/dashboard').expect(200);
    // Second request inside the TTL reused the cached payload.
    expect(reader).toHaveBeenCalledTimes(1);

    await request(app).get('/api/me/dashboard?fresh=1').expect(200);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by date/tz so a different day is not served stale', async () => {
    const reader = vi.fn<GoogleReader>().mockResolvedValue(disconnectedGoogle);
    const app = mount(userA, reader);

    await request(app).get('/api/me/dashboard?date=2026-07-07').expect(200);
    await request(app).get('/api/me/dashboard?date=2026-07-07').expect(200);
    // Same date within the TTL is cached.
    expect(reader).toHaveBeenCalledTimes(1);

    // A different requested day is a distinct cache key — the Google read runs
    // again for that day rather than returning the first day's calendar.
    await request(app).get('/api/me/dashboard?date=2026-07-08').expect(200);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenLastCalledWith(
      userA,
      expect.anything(),
      expect.objectContaining({ date: '2026-07-08' }),
    );
  });

  it('surfaces a connected Google block from the reader', async () => {
    const connected: DashboardGoogle = {
      configured: true,
      connected: true,
      email: 'a@example.com',
      reconnectRequired: false,
      calendar: {
        scopeGranted: true,
        date: '2026-07-07',
        timeZone: 'UTC',
        events: [
          {
            id: 'e1',
            summary: 'Standup',
            location: null,
            allDay: false,
            start: '2026-07-07T09:00:00Z',
            end: '2026-07-07T09:15:00Z',
            htmlLink: null,
            hangoutLink: null,
          },
        ],
        error: null,
      },
      mail: {
        scopeGranted: true,
        unread: 3,
        starred: 1,
        important: 2,
        messages: [
          {
            id: 'm1',
            threadId: 'th1',
            from: 'Jane Doe <jane@example.com>',
            subject: 'Lunch tomorrow?',
            snippet: 'Are you free…',
            date: 'Tue, 07 Jul 2026 08:00:00 +0000',
            internalDate: '1783065600000',
            unread: true,
          },
        ],
        error: null,
      },
    };
    const reader = vi.fn<GoogleReader>().mockResolvedValue(connected);
    const res = await request(mount(userA, reader)).get('/api/me/dashboard').expect(200);
    expect(res.body.google.email).toBe('a@example.com');
    expect(res.body.google.calendar.events).toHaveLength(1);
    expect(res.body.google.mail.unread).toBe(3);
    expect(res.body.google.mail.messages).toHaveLength(1);
    expect(res.body.google.mail.messages[0].subject).toBe('Lunch tomorrow?');
  });

  it('401s when unauthenticated', async () => {
    await request(mount(null)).get('/api/me/dashboard').expect(401);
  });
});
