import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronRow } from './types.js';

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  validate: vi.fn(() => true),
  getCron: vi.fn(),
  updateCronNextRun: vi.fn(),
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: mocks.schedule,
    validate: mocks.validate,
  },
}));

vi.mock('./db.js', () => ({
  db: {},
  stmts: {
    getCron: { get: mocks.getCron },
    updateCronNextRun: { run: mocks.updateCronNextRun },
    upsertHeartbeatState: { run: vi.fn() },
    deleteHeartbeatState: { run: vi.fn() },
  },
}));

vi.mock('./worktree.js', () => ({
  getOrCreateProcessWorktree: vi.fn(async (cwd: string) => cwd),
}));

vi.mock('./project-model.js', () => ({
  getProjects: vi.fn(() => []),
  saveProjects: vi.fn(),
}));

const { rescheduleCron } = await import('./heartbeat.js');

function makeCron(overrides: Partial<CronRow> = {}): CronRow {
  return {
    id: 9,
    name: 'Daily local report',
    schedule: '0 9 * * *',
    timezone: 'America/New_York',
    prompt: 'report',
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
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('cron scheduler timezone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.schedule.mockReturnValue({
      stop: vi.fn(),
      getNextRun: vi.fn(() => new Date('2026-07-01T13:00:00.000Z')),
    });
  });

  it('schedules a 9am cron in the row timezone instead of UTC', () => {
    rescheduleCron(makeCron());

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const [expr, , options] = mocks.schedule.mock.calls[0]!;
    expect(expr).toBe('0 9 * * *');
    expect(options).toMatchObject({
      name: 'cron:9',
      timezone: 'America/New_York',
    });
    expect(mocks.updateCronNextRun).toHaveBeenCalledWith('2026-07-01T13:00:00.000Z', 9);
  });
});
