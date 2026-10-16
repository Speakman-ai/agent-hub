/**
 * `routine_skill` on the crons API: create sets it, PUT follows the
 * present-key tristate, and bad values or a missing project are rejected.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../auth.js';
import type { CronRow } from '../types.js';

vi.mock('../heartbeat.js', () => ({
  rescheduleCron: vi.fn(),
  runCronJob: vi.fn(async () => ({ id: 1, status: 'success', result: 'ok' })),
}));
vi.mock('../users-store.js', () => ({ getUserById: vi.fn(() => null) }));
vi.mock('../orgs.js', () => ({ getActiveOrgId: vi.fn(() => 'default') }));
vi.mock('../memberships-store.js', () => ({ listMembersForOrg: vi.fn(() => []) }));
vi.mock('../project-model.js', () => ({
  getProjects: () => [{ id: 'p1', name: 'P', cwd: '/tmp', agents: [{ id: 'ops' }] }],
}));

const { default: createCronRoutes } = await import('./crons.js');

function makeApp() {
  const rows: CronRow[] = [];
  const stmts = {
    getCrons: { all: vi.fn(() => rows) },
    getCron: { get: vi.fn((id: number) => rows.find((r) => r.id === Number(id))) },
    createCron: {
      run: vi.fn((name: string, schedule: string, timezone: string | null, prompt: string) => {
        const id = rows.length + 1;
        rows.push({
          id,
          name,
          schedule,
          timezone,
          prompt,
          cwd: '/tmp',
          enabled: 1,
          last_run: null,
          last_result: null,
          next_run_at: null,
          project_id: 'p1',
          timeout_ms: null,
          notify_on_run: 0,
          model: null,
          skill_principal_agent_id: 'ops',
          engine: null,
          owner_user_id: 'user-a',
          shared: 0,
          routine_skill: null,
          created_at: '',
        });
        return { lastInsertRowid: id, changes: 1 };
      }),
    },
    updateCron: { run: vi.fn() },
    updateCronRoutineSkill: {
      run: vi.fn((skill: string | null, id: number) => {
        const row = rows.find((r) => r.id === Number(id));
        if (row) row.routine_skill = skill;
      }),
    },
    backfillCronOwners: { run: vi.fn() },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const authed = req as AuthenticatedRequest;
    authed.authUserId = 'user-a';
    authed.authRole = 'User';
    next();
  });
  app.use(createCronRoutes({ stmts } as never));
  return { app, stmts, rows };
}

const base = {
  name: 'Routine: export',
  schedule: '0 9 * * 1-5',
  prompt: 'Run it',
  project_id: 'p1',
  skill_principal_agent_id: 'ops',
};

describe('crons API routine_skill', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a routine cron with the skill attached', async () => {
    const { app, stmts } = makeApp();
    const res = await request(app)
      .post('/api/crons')
      .send({ ...base, routine_skill: 'weekly-export' })
      .expect(200);
    expect(res.body.routine_skill).toBe('weekly-export');
    expect(stmts.updateCronRoutineSkill.run).toHaveBeenCalledWith('weekly-export', 1);
  });

  it('leaves classic crons without a routine skill', async () => {
    const { app, stmts } = makeApp();
    const res = await request(app).post('/api/crons').send(base).expect(200);
    expect(res.body.routine_skill).toBeNull();
    expect(stmts.updateCronRoutineSkill.run).not.toHaveBeenCalled();
  });

  it('rejects a non-slug skill and a routine without a project', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/api/crons')
      .send({ ...base, routine_skill: '../etc' })
      .expect(400);
    const res = await request(app)
      .post('/api/crons')
      .send({ ...base, project_id: null, skill_principal_agent_id: null, routine_skill: 'x' })
      .expect(400);
    expect(res.body.error).toBe('routine_skill requires project_id');
  });

  it('PUT keeps the skill when omitted and clears it on null', async () => {
    const { app, rows } = makeApp();
    await request(app)
      .post('/api/crons')
      .send({ ...base, routine_skill: 'weekly-export' })
      .expect(200);
    await request(app).put('/api/crons/1').send({ name: 'Renamed' }).expect(200);
    expect(rows[0]!.routine_skill).toBe('weekly-export');
    await request(app).put('/api/crons/1').send({ routine_skill: null }).expect(200);
    expect(rows[0]!.routine_skill).toBeNull();
  });
});
