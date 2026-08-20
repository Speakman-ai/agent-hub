/**
 * Hub Daily Summary facts + persist-by-local-day (no real CLI spawn).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig, Project, RouteDeps } from './types.js';
import { HUB_ASSISTANT_AGENT_ID, HUB_SESSION_MODE } from '../shared/utils/hub.js';

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { initDb, getDb } = await import('./db.js');
const { createTodo, updateTodo } = await import('./user-todos-store.js');
const {
  collectDailySummaryFacts,
  formatFactsForPrompt,
  generateDailySummary,
  getDailySummaryPayload,
  saveDailySummary,
  readDailySummary,
} = await import('./hub-daily-summary.js');

let userA = '';
let userB = '';
const PROJECT_A = 'proj-a';
const NOW = new Date('2026-08-19T18:00:00.000Z');

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

function makeDeps(): RouteDeps {
  return {
    getProjects: () => [project(PROJECT_A, userA)],
    config: {} as AppConfig,
  } as unknown as RouteDeps;
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

describe('collectDailySummaryFacts', () => {
  it('splits owned sessions, messages, cards, and todos across today and yesterday', () => {
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
    seedSession({
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

    const doneToday = createTodo({ userId: userA, title: 'Done today' });
    updateTodo(userA, doneToday.id, { status: 'done' });
    getOrgsDb()
      .prepare(`UPDATE user_todos SET updated_at = ? WHERE id = ?`)
      .run('2026-08-19T12:00:00.000Z', doneToday.id);

    const facts = collectDailySummaryFacts({
      userId: userA,
      caller: { userId: userA, role: 'User' },
      deps: makeDeps(),
      timeZone: 'UTC',
      now: NOW,
    });

    expect(facts.date).toBe('2026-08-19');
    expect(facts.yesterdayDate).toBe('2026-08-18');
    expect(facts.todaySessions.map((s) => s.name)).toEqual(
      expect.arrayContaining(['Ship summary', 'Hub chat']),
    );
    expect(facts.todaySessions.find((s) => s.name === 'Hub chat')?.kind).toBe('hub');
    expect(facts.yesterdaySessions.map((s) => s.name)).toEqual(['Yesterday work']);
    expect(facts.todayMessages.map((m) => m.content)).toEqual(['finish the daily summary tab']);
    expect(facts.yesterdayMessages.map((m) => m.content)).toEqual(['landed the hub assistant']);
    expect(facts.todayCards.map((c) => c.title)).toEqual(['Today card']);
    expect(facts.yesterdayCards.map((c) => c.title)).toEqual(['Yesterday card']);
    expect(facts.running.some((r) => r.sessionId === todaySession && r.mine)).toBe(true);
    expect(facts.todayDoneTodos.map((t) => t.title)).toEqual(['Done today']);

    const prompt = formatFactsForPrompt(facts);
    expect(prompt).toContain('finish the daily summary tab');
    expect(prompt).toContain('Yesterday work');
    expect(prompt).toContain('/projects/proj-a/board?card=');
    expect(prompt).toContain('/sessions/');
    expect(prompt).toContain('/hub/todos');
  });
});

describe('daily summary persistence', () => {
  it('returns a stored report only for the matching local date', () => {
    saveDailySummary(userA, {
      date: '2026-08-18',
      timeZone: 'UTC',
      markdown: '## Yesterday leftover',
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      generatedAt: '2026-08-18T18:00:00.000Z',
    });
    const stale = getDailySummaryPayload({ userId: userA, timeZone: 'UTC', now: NOW });
    expect(stale.date).toBe('2026-08-19');
    expect(stale.report).toBeNull();

    saveDailySummary(userA, {
      date: '2026-08-19',
      timeZone: 'UTC',
      markdown: '## Today',
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      generatedAt: '2026-08-19T18:00:00.000Z',
    });
    const fresh = getDailySummaryPayload({ userId: userA, timeZone: 'UTC', now: NOW });
    expect(fresh.report?.markdown).toBe('## Today');
  });

  it('does not wipe a stored report when a read resolves a different local date', () => {
    // Regression: a Pacific user who generated at 17:00 (local date still the
    // 18th) then hits GET without `tz` (defaults to UTC → the 19th) must keep
    // their report. readDailySummary must be a pure read, never a mutating one.
    saveDailySummary(userA, {
      date: '2026-08-18',
      timeZone: 'America/Los_Angeles',
      markdown: '## Report for the 18th',
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      generatedAt: '2026-08-19T00:30:00.000Z',
    });

    // A GET that resolves a later date must return null WITHOUT dropping the row.
    const staleRead = getDailySummaryPayload({ userId: userA, timeZone: 'UTC', now: NOW });
    expect(staleRead.date).toBe('2026-08-19');
    expect(staleRead.report).toBeNull();

    // The stored report for its own date is still intact.
    expect(readDailySummary(userA, '2026-08-18')?.markdown).toBe('## Report for the 18th');
  });
});

describe('generateDailySummary', () => {
  it('runs the injected model, persists the report as today, and does not invent a spawn', async () => {
    const report = await generateDailySummary({
      userId: userA,
      timeZone: 'UTC',
      deps: makeDeps(),
      caller: { userId: userA, role: 'User' },
      now: NOW,
      cwd: tmpdir(),
      resolveEngine: async () =>
        ({
          engine: 'claude-code',
          model: 'claude-opus-4-6',
          fallbackUsed: false,
          availability: {},
        }) as Awaited<ReturnType<typeof import('./engine-resolver.js').resolveOneShotEngine>>,
      runFailover: async () => ({
        engine: 'codex-cli',
        model: 'gpt-5.3-codex',
        output: '## Today\n- wrote tests\n## Right now\n- idle\n## Yesterday\n- hub work',
        failovers: [],
        detailed: { stdout: 'ok', stderr: '', code: 0, timedOut: false },
      }),
    });
    expect(report.date).toBe('2026-08-19');
    expect(report.engine).toBe('codex-cli');
    expect(report.markdown).toContain('wrote tests');
    expect(
      getDailySummaryPayload({ userId: userA, timeZone: 'UTC', now: NOW }).report?.markdown,
    ).toBe(report.markdown);
  });

  it('asks the one-shot resolver for the caller Hub engine and model', async () => {
    const { mutateUserPreferencesJson } = await import('./user-preferences-store.js');
    mutateUserPreferencesJson(userA, (current) => ({
      ...current,
      agentEngineOverrides: {
        [HUB_ASSISTANT_AGENT_ID]: { engine: 'codex-cli', model: 'gpt-5.6-sol' },
      },
      agentModelOverrides: { [HUB_ASSISTANT_AGENT_ID]: 'gpt-5.6-sol' },
    }));
    let seen: { preferred?: string; preferredModel?: string } | null = null;
    await generateDailySummary({
      userId: userA,
      timeZone: 'UTC',
      deps: {
        ...makeDeps(),
        config: {
          engineValidModels: { 'codex-cli': ['gpt-5.6-sol'] },
          engineDefaultModels: { 'codex-cli': 'gpt-5.6-sol' },
        } as unknown as AppConfig,
      },
      caller: { userId: userA, role: 'User' },
      now: NOW,
      cwd: tmpdir(),
      resolveEngine: async (_cfg, input) => {
        seen = {
          preferred: input?.preferred ?? undefined,
          preferredModel: input?.preferredModel ?? undefined,
        };
        return {
          engine: 'codex-cli',
          model: 'gpt-5.6-sol',
          fallbackUsed: false,
          availability: {},
        } as Awaited<ReturnType<typeof import('./engine-resolver.js').resolveOneShotEngine>>;
      },
      runFailover: async () => ({
        engine: 'codex-cli',
        model: 'gpt-5.6-sol',
        output: '## Today\n- ok\n## Right now\n- idle\n## Yesterday\n- none',
        failovers: [],
        detailed: { stdout: 'ok', stderr: '', code: 0, timedOut: false },
      }),
    });
    expect(seen).toEqual({ preferred: 'codex-cli', preferredModel: 'gpt-5.6-sol' });
  });

  it('linkifies ticket and session names the model mentioned without URLs', async () => {
    const { boardId, todoCol } = seedBoard();
    const cardId = seedCard({
      boardId,
      columnId: todoCol,
      title: 'Today card',
      assignedUserId: userA,
      updatedAt: '2026-08-19 12:00:00',
    });
    const sessionId = seedSession({
      ownerId: userA,
      name: 'Ship summary',
      updatedAt: '2026-08-19 15:00:00',
    });
    const report = await generateDailySummary({
      userId: userA,
      timeZone: 'UTC',
      deps: makeDeps(),
      caller: { userId: userA, role: 'User' },
      now: NOW,
      cwd: tmpdir(),
      resolveEngine: async () =>
        ({
          engine: 'claude-code',
          model: 'claude-opus-4-6',
          fallbackUsed: false,
          availability: {},
        }) as Awaited<ReturnType<typeof import('./engine-resolver.js').resolveOneShotEngine>>,
      runFailover: async () => ({
        engine: 'claude-code',
        model: 'claude-opus-4-6',
        output:
          '## Today\n- Today card in Ship summary\n## Right now\n- idle\n## Yesterday\n- none',
        failovers: [],
        detailed: { stdout: 'ok', stderr: '', code: 0, timedOut: false },
      }),
    });
    expect(report.markdown).toContain(`[Today card](/projects/${PROJECT_A}/board?card=${cardId})`);
    expect(report.markdown).toContain(`[Ship summary](/sessions/${sessionId}?agent=agent-a)`);
  });
});
