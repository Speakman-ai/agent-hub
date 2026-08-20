/**
 * Scheduling behaviour for the project-scoped wiki background agent.
 *
 * node-cron and project-model are mocked so the test asserts task
 * registration (key + expression + timezone) without a real scheduler or
 * project store, mirroring heartbeat-scheduler-timezone.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from './types.js';

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  validate: vi.fn((expr: string) => expr !== 'not a cron'),
  getProjects: vi.fn<() => Project[]>(() => []),
}));

vi.mock('node-cron', () => ({
  default: { schedule: mocks.schedule, validate: mocks.validate },
}));

vi.mock('./db.js', () => ({
  db: {},
  stmts: {
    updateCronNextRun: { run: vi.fn() },
  },
}));

vi.mock('./worktree.js', () => ({
  getOrCreateProcessWorktree: vi.fn(async (cwd: string) => cwd),
}));

vi.mock('./project-model.js', () => ({
  getProjects: mocks.getProjects,
  saveProjects: vi.fn(),
}));

const {
  rescheduleBackgroundWikiAgent,
  scheduleBackgroundAgents,
  wikiBackgroundAgentKey,
  rescheduleBackgroundCustomAgents,
  rescheduleProjectBackgroundAgents,
  scheduleCustomBackgroundAgents,
  customBackgroundAgentKey,
} = await import('./heartbeat.js');

function proj(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    cwd: '/tmp/p1',
    ahw: '/tmp/p1/.ahw',
    ...over,
  } as Project;
}

describe('rescheduleBackgroundWikiAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.schedule.mockReturnValue({ stop: vi.fn(), getNextRun: vi.fn(() => null) });
  });

  it('registers a task keyed bg:wiki:<projectId> when the wiki agent is enabled', () => {
    rescheduleBackgroundWikiAgent(
      proj({ backgroundAgents: { wiki: { enabled: true, schedule: '0 6 * * *' } } }),
    );
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const [expr, , options] = mocks.schedule.mock.calls[0]!;
    expect(expr).toBe('0 6 * * *');
    expect(options).toMatchObject({ name: wikiBackgroundAgentKey('p1') });
  });

  it('falls back to the default daily schedule when none is set', () => {
    rescheduleBackgroundWikiAgent(proj({ backgroundAgents: { wiki: { enabled: true } } }));
    expect(mocks.schedule.mock.calls[0]![0]).toBe('0 3 * * *');
  });

  it('does not register a task when the wiki agent is disabled', () => {
    rescheduleBackgroundWikiAgent(proj({ backgroundAgents: { wiki: { enabled: false } } }));
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does not register a task when there is no background-agent config', () => {
    rescheduleBackgroundWikiAgent(proj());
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('rejects an invalid cron expression without scheduling', () => {
    rescheduleBackgroundWikiAgent(
      proj({ backgroundAgents: { wiki: { enabled: true, schedule: 'not a cron' } } }),
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('scheduleBackgroundAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.schedule.mockReturnValue({ stop: vi.fn(), getNextRun: vi.fn(() => null) });
  });

  it('registers only the projects whose wiki agent is enabled', () => {
    mocks.getProjects.mockReturnValue([
      proj({ id: 'on', backgroundAgents: { wiki: { enabled: true } } }),
      proj({ id: 'off', backgroundAgents: { wiki: { enabled: false } } }),
      proj({ id: 'none' }),
    ]);
    scheduleBackgroundAgents();
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.schedule.mock.calls[0]![2]).toMatchObject({
      name: wikiBackgroundAgentKey('on'),
    });
  });
});

describe('custom background agents scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.schedule.mockReturnValue({ stop: vi.fn(), getNextRun: vi.fn(() => null) });
  });

  it('schedules one task per enabled+prompted custom agent', () => {
    rescheduleBackgroundCustomAgents(
      proj({
        backgroundAgents: {
          custom: [
            { id: 'a1', name: 'Nightly', enabled: true, schedule: '0 2 * * *', prompt: 'do it' },
            { id: 'a2', name: 'Disabled', enabled: false, prompt: 'skip' },
            { id: 'a3', name: 'No prompt', enabled: true, prompt: '  ' },
          ],
        },
      }),
    );
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const [expr, , options] = mocks.schedule.mock.calls[0]!;
    expect(expr).toBe('0 2 * * *');
    expect(options).toMatchObject({ name: customBackgroundAgentKey('p1', 'a1') });
  });

  it('tears down a removed custom agent on reschedule', () => {
    const stop = vi.fn();
    mocks.schedule.mockReturnValue({ stop, getNextRun: vi.fn(() => null) });
    // First: one enabled agent gets scheduled.
    rescheduleBackgroundCustomAgents(
      proj({ backgroundAgents: { custom: [{ id: 'a1', name: 'A', enabled: true, prompt: 'x' }] } }),
    );
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    // Then: the agent is gone from config — its existing task must be stopped.
    rescheduleBackgroundCustomAgents(proj({ backgroundAgents: { custom: [] } }));
    expect(stop).toHaveBeenCalled();
  });

  it('rejects an invalid custom cron without scheduling', () => {
    rescheduleBackgroundCustomAgents(
      proj({
        backgroundAgents: {
          custom: [{ id: 'a1', name: 'Bad', enabled: true, schedule: 'not a cron', prompt: 'x' }],
        },
      }),
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('scheduleCustomBackgroundAgents walks every project', () => {
    mocks.getProjects.mockReturnValue([
      proj({
        id: 'p1',
        backgroundAgents: { custom: [{ id: 'a1', name: 'A', enabled: true, prompt: 'x' }] },
      }),
      proj({ id: 'p2' }),
    ]);
    scheduleCustomBackgroundAgents();
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.schedule.mock.calls[0]![2]).toMatchObject({
      name: customBackgroundAgentKey('p1', 'a1'),
    });
  });

  it('rescheduleProjectBackgroundAgents registers both wiki and custom tasks', () => {
    rescheduleProjectBackgroundAgents(
      proj({
        backgroundAgents: {
          wiki: { enabled: true },
          custom: [{ id: 'a1', name: 'A', enabled: true, prompt: 'x' }],
        },
      }),
    );
    const names = mocks.schedule.mock.calls.map((c) => (c[2] as { name: string }).name);
    expect(names).toContain(wikiBackgroundAgentKey('p1'));
    expect(names).toContain(customBackgroundAgentKey('p1', 'a1'));
  });
});
