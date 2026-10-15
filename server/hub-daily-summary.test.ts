/**
 * my_work digest fact collection over a window (no real CLI spawn).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Project } from './types.js';
import { HUB_ASSISTANT_AGENT_ID, HUB_SESSION_MODE } from '../shared/utils/hub.js';

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { initDb, getDb } = await import('./db.js');
const { createTodo, updateTodo } = await import('./user-todos-store.js');
const { collectMyWorkWindowFacts } = await import('./hub-daily-summary.js');

let userA = '';
let userB = '';
const PROJECT_A = 'proj-a';

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

function seedBoard(): { boardId: string; todoCol: string } {
  const db = getDb();
  const boardId = uuidv4();
  const todoCol = uuidv4();
  db.prepare(
    'INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)',
  ).run(boardId, PROJECT_A, 'Board', 'AH');
  db.prepare(
    'INSERT INTO kanban_columns (id, board_id, name, position, color) VALUES (?, ?, ?, ?, ?)',
  ).run(todoCol, boardId, 'In Progress', 0, '#fff');
  return { boardId, todoCol };
}

function seedCard(opts: {
  boardId: string;
  columnId: string;
  title: string;
  assignedUserId: string;
  updatedAt: string;
}): string {
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, priority, position, assigned_user_id, updated_at)
       VALUES (?, ?, ?, ?, 'high', 0, ?, ?)`,
    )
    .run(id, opts.columnId, opts.boardId, opts.title, opts.assignedUserId, opts.updatedAt);
  return id;
}

function seedSession(opts: {
  id?: string;
  ownerId: string;
  name: string;
  agentId?: string;
  sessionMode?: string;
  updatedAt: string;
}): string {
  const id = opts.id ?? uuidv4();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_id, name, owner_user_id, session_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.agentId ?? 'agent-a',
      opts.name,
      opts.ownerId,
      opts.sessionMode ?? 'chat',
      opts.updatedAt,
      opts.updatedAt,
    );
  return id;
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-daily-summary-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userA = createUser({ username: 'summary-a', passwordHash: 'x' }).id;
  userB = createUser({ username: 'summary-b', passwordHash: 'x' }).id;
});

describe('collectMyWorkWindowFacts', () => {
  it('keeps only the window and the caller own running sessions', () => {
    const { boardId, todoCol } = seedBoard();
    seedCard({
      boardId,
      columnId: todoCol,
      title: 'Today card',
      assignedUserId: userA,
      updatedAt: '2026-08-19 12:00:00',
    });
    seedCard({
      boardId,
      columnId: todoCol,
      title: 'Yesterday card',
      assignedUserId: userA,
      updatedAt: '2026-08-18 12:00:00',
    });

    const todaySession = seedSession({
      ownerId: userA,
      name: 'Ship summary',
      updatedAt: '2026-08-19 15:00:00',
    });
    const yesterdaySession = seedSession({
      ownerId: userA,
      name: 'Yesterday work',
      updatedAt: '2026-08-18 15:00:00',
    });
    const otherRunningSession = seedSession({
      ownerId: userB,
      name: 'Someone else',
      updatedAt: '2026-08-19 15:00:00',
    });
    seedSession({
      ownerId: userA,
      name: 'Hub chat',
      agentId: HUB_ASSISTANT_AGENT_ID,
      sessionMode: HUB_SESSION_MODE,
      updatedAt: '2026-08-19 16:00:00',
    });

    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
      )
      .run(uuidv4(), todaySession, 'finish the daily summary tab', '2026-08-19 15:10:00');
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
      )
      .run(uuidv4(), yesterdaySession, 'landed the hub assistant', '2026-08-18 15:10:00');

    getDb()
      .prepare(
        `INSERT INTO active_tasks (session_id, message_id, agent_id, prompt, engine, status)
         VALUES (?, ?, 'agent-a', 'working', 'claude-code', 'running')`,
      )
      .run(todaySession, uuidv4());
    // Another user's running session must never surface in a personal summary.
    getDb()
      .prepare(
        `INSERT INTO active_tasks (session_id, message_id, agent_id, prompt, engine, status)
         VALUES (?, ?, 'agent-a', 'working', 'claude-code', 'running')`,
      )
      .run(otherRunningSession, uuidv4());

    const doneToday = createTodo({ userId: userA, title: 'Done today' });
    updateTodo(userA, doneToday.id, { status: 'done' });
    getOrgsDb()
      .prepare(`UPDATE user_todos SET updated_at = ? WHERE id = ?`)
      .run('2026-08-19T12:00:00.000Z', doneToday.id);

    const facts = collectMyWorkWindowFacts({
      userId: userA,
      caller: { userId: userA, role: 'User' },
      getProjects: () => [project(PROJECT_A, userA)],
      timeMin: '2026-08-19T00:00:00.000Z',
      timeMax: '2026-08-20T00:00:00.000Z',
    });

    expect(facts.sessions.map((s) => s.name)).toEqual(
      expect.arrayContaining(['Ship summary', 'Hub chat']),
    );
    expect(facts.sessions.map((s) => s.name)).not.toContain('Yesterday work');
    expect(facts.sessions.find((s) => s.name === 'Hub chat')?.kind).toBe('hub');
    expect(facts.messages.map((m) => m.content)).toEqual(['finish the daily summary tab']);
    expect(facts.cards.map((c) => c.title)).toEqual(['Today card']);
    expect(facts.openCards.map((c) => c.title)).toEqual(
      expect.arrayContaining(['Today card', 'Yesterday card']),
    );
    expect(facts.running.some((r) => r.sessionId === todaySession && r.mine)).toBe(true);
    // Regression: only the caller's own running sessions, never another user's.
    expect(facts.running.some((r) => r.sessionId === otherRunningSession)).toBe(false);
    expect(facts.doneTodos.map((t) => t.title)).toEqual(['Done today']);
  });
});
