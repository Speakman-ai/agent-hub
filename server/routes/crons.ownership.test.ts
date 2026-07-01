import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../auth.js';
import type { CronRow } from '../types.js';

vi.mock('../heartbeat.js', () => ({
  rescheduleCron: vi.fn(),
  runCronJob: vi.fn(async () => ({ id: 1, status: 'success', result: 'ok' })),
}));

vi.mock('../users-store.js', () => ({
  getUserById: vi.fn((id: string) => {
    const users: Record<string, { id: string; username: string }> = {
      'owner-a': { id: 'owner-a', username: 'owner@example.com' },
      'user-a': { id: 'user-a', username: 'alice@example.com' },
      'user-b': { id: 'user-b', username: 'bob@example.com' },
    };
    return users[id] ?? null;
  }),
}));

vi.mock('../orgs.js', () => ({
  getActiveOrgId: vi.fn(() => 'default'),
}));

vi.mock('../memberships-store.js', () => ({
  listMembersForOrg: vi.fn(() => [
    { userId: 'owner-a', username: 'owner@example.com', role: 'Owner', createdAt: '1' },
  ]),
}));

const { default: createCronRoutes } = await import('./crons.js');

function makeCron(overrides: Partial<CronRow>): CronRow {
  return {
    id: 1,
    name: 'cron',
    schedule: '0 * * * *',
    timezone: null,
    prompt: 'prompt',
    cwd: '/tmp',
    enabled: 1,
    last_run: null,
    last_result: null,
    next_run_at: null,
    project_id: null,
    timeout_ms: null,
    notify_on_run: 0,
    model: null,
    skill_principal_agent_id: null,
    engine: null,
    owner_user_id: null,
    shared: 0,
    created_at: '2026-06-29T00:00:00.000Z',
    ...overrides,
  };
}

function makeApp(
  opts: { userId?: string; role?: AuthenticatedRequest['authRole'] },
  rows: CronRow[],
) {
  const backfillCronOwners = vi.fn();
  const stmts = {
    getCrons: { all: vi.fn(() => rows) },
    getCron: { get: vi.fn((id: number) => rows.find((row) => row.id === Number(id))) },
    createCron: { run: vi.fn() },
    updateCron: {
      run: vi.fn(
        (
          name,
          schedule,
          timezone,
          prompt,
          cwd,
          enabled,
          projectId,
          timeoutMs,
          notifyOnRun,
          model,
          skillPrincipalAgentId,
          engine,
          shared,
          id,
        ) => {
          const row = rows.find((r) => r.id === Number(id));
          if (!row) return;
          Object.assign(row, {
            name,
            schedule,
            timezone,
            prompt,
            cwd,
            enabled,
            project_id: projectId,
            timeout_ms: timeoutMs,
            notify_on_run: notifyOnRun,
            model,
            skill_principal_agent_id: skillPrincipalAgentId,
            engine,
            shared,
          });
        },
      ),
    },
    backfillCronOwners: { run: backfillCronOwners },
    deleteCron: { run: vi.fn() },
    updateCronResult: { run: vi.fn() },
    updateCronNextRun: { run: vi.fn() },
    addCronLog: { run: vi.fn() },
    updateCronLog: { run: vi.fn() },
    getCronLogs: { all: vi.fn(() => []) },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const authed = req as AuthenticatedRequest;
    if (opts.userId) authed.authUserId = opts.userId;
    if (opts.role) authed.authRole = opts.role;
    next();
  });
  app.use(createCronRoutes({ stmts } as never));
  return { app, stmts };
}

describe('cron ownership and shared visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists owned private crons plus shared crons, hiding other private crons', async () => {
    const rows = [
      makeCron({ id: 1, name: 'mine', owner_user_id: 'user-a', shared: 0 }),
      makeCron({ id: 2, name: 'shared by bob', owner_user_id: 'user-b', shared: 1 }),
      makeCron({ id: 3, name: 'private by bob', owner_user_id: 'user-b', shared: 0 }),
    ];
    const { app, stmts } = makeApp({ userId: 'user-a', role: 'User' }, rows);

    const res = await request(app).get('/api/crons').expect(200);

    expect(res.body.map((row: CronRow) => row.name)).toEqual(['mine', 'shared by bob']);
    expect(res.body[0]).toMatchObject({
      owner_user_id: 'user-a',
      owner_username: 'alice@example.com',
      can_manage: true,
    });
    expect(res.body[1]).toMatchObject({
      owner_user_id: 'user-b',
      owner_username: 'bob@example.com',
      can_manage: false,
    });
    expect(stmts.backfillCronOwners.run).toHaveBeenCalledWith('owner-a');
  });

  it('rejects mutation of another user shared cron', async () => {
    const rows = [makeCron({ id: 2, owner_user_id: 'user-b', shared: 1 })];
    const { app } = makeApp({ userId: 'user-a', role: 'User' }, rows);

    await request(app).put('/api/crons/2').send({ shared: false }).expect(403);
  });

  it('allows org Owners to flip another user cron shared flag', async () => {
    const rows = [makeCron({ id: 2, owner_user_id: 'user-b', shared: 0 })];
    const { app } = makeApp({ userId: 'owner-a', role: 'Owner' }, rows);

    const res = await request(app).put('/api/crons/2').send({ shared: true }).expect(200);

    expect(res.body).toMatchObject({ id: 2, shared: 1, can_manage: true });
  });
});
