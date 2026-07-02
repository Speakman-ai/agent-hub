/**
 * Deploy schedule ticker — the node-cron registration + firing path that turns
 * an enabled schedule row into a cron-driven deployment. Every collaborator is
 * injected (getSchedule, listEnabledSchedules, prepareCheckout, loadConfig,
 * triggerDeployment, isEnvironmentDeployable, scheduleFn) so these tests never
 * touch the DB, spawn git, run a real runner, or arm a wall-clock timer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ScheduledTask } from 'node-cron';
import type {
  AppConfig,
  DeploymentEnvironmentScheduleRow,
  DeploymentRow,
  Project,
} from '../types.js';
import type { DeployConfig } from './deploy-config.js';
import { DeployConfigError } from './deploy-config.js';
import { EnvironmentBusyError, type TriggerDeploymentInput } from './deploy-orchestrator.js';
import {
  getRegisteredScheduleIds,
  initDeploySchedules,
  refreshScheduleRegistration,
  runScheduledDeployment,
  stopAllDeploySchedules,
  unregisterSchedule,
  type DeployScheduleTickerDeps,
} from './deploy-schedule-ticker.js';

const PROJECT = {
  id: 'proj-sched-test',
  githubRepo: 'owner/repo',
  gitHost: 'agenthub',
} as unknown as Project;

const APP_CONFIG = { personalOAuth: {} } as unknown as AppConfig;

function scheduleRow(
  overrides: Partial<DeploymentEnvironmentScheduleRow> = {},
): DeploymentEnvironmentScheduleRow {
  return {
    id: 'sch-1',
    project_id: PROJECT.id,
    environment_name: 'prod',
    ref: 'main',
    cron: '0 3 * * *',
    timezone: 'America/New_York',
    owner_user_id: 'user-42',
    enabled: 1,
    meta: null,
    created_at: '2026-07-02T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

function configWith(...envs: string[]): DeployConfig {
  return {
    version: 1,
    environments: new Map(
      envs.map((name) => [
        name,
        { name, approval: false, runsOn: 'ubuntu-24.04', timeoutMinutes: 30, steps: [] },
      ]),
    ),
  };
}

function mockTrigger(id: string) {
  return vi.fn(async (_input: TriggerDeploymentInput) => ({ id }) as DeploymentRow);
}

/** A prepareCheckout seam that materializes a REAL temp dir so cleanup is observable. */
function makeCheckoutTracker() {
  const created: string[] = [];
  const prepareCheckout = vi.fn(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dst-test-'));
    created.push(dir);
    return { worktreePath: dir, resolvedRef: 'resolved-sha-abc' };
  });
  return { created, prepareCheckout };
}

/** A node-cron scheduleFn seam that returns a fake task with a `stop` spy. */
function makeScheduleFn() {
  const calls: Array<{ cron: string; options: unknown; stop: ReturnType<typeof vi.fn> }> = [];
  const scheduleFn = vi.fn((cronExpr: string, _fn: unknown, options: unknown) => {
    const stop = vi.fn();
    calls.push({ cron: cronExpr, options, stop });
    return { stop } as unknown as ScheduledTask;
  }) as unknown as DeployScheduleTickerDeps['scheduleFn'];
  return { calls, scheduleFn };
}

beforeEach(() => {
  stopAllDeploySchedules();
});
afterEach(() => {
  stopAllDeploySchedules();
});

describe('runScheduledDeployment', () => {
  const baseDeps = (over: Partial<DeployScheduleTickerDeps> = {}): DeployScheduleTickerDeps => ({
    broadcast: vi.fn(),
    config: APP_CONFIG,
    findProject: () => PROJECT,
    log: vi.fn(),
    ...over,
  });

  it('enqueues a deployment (trigger=schedule, triggeredBy=owner) for a deployable env', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const row = scheduleRow();
    const triggerDeployment = mockTrigger('dep-1');

    await runScheduledDeployment(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        isEnvironmentDeployable: () => true,
        getSchedule: () => row,
        triggerDeployment,
      }),
    );

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    const [input] = triggerDeployment.mock.calls[0]!;
    expect(input).toMatchObject({
      projectId: PROJECT.id,
      environment: 'prod',
      ref: 'resolved-sha-abc',
      trigger: 'schedule',
      triggeredBy: 'user-42',
      deferRun: true,
      cleanupWorktreeOnTerminal: true,
      meta: { triggeredBySchedule: 'sch-1', cron: '0 3 * * *' },
    });
    expect(input.worktreePath).toBe(created[0]);
    // Success ⇒ ownership transferred; the ticker must NOT clean the worktree.
    expect(existsSync(created[0]!)).toBe(true);
  });

  it('passes triggeredBy=null for a system-owned schedule', async () => {
    const { prepareCheckout } = makeCheckoutTracker();
    const row = scheduleRow({ owner_user_id: null });
    const triggerDeployment = mockTrigger('dep-sys');

    await runScheduledDeployment(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        isEnvironmentDeployable: () => true,
        getSchedule: () => row,
        triggerDeployment,
      }),
    );

    expect(triggerDeployment.mock.calls[0]![0]).toMatchObject({ triggeredBy: null });
  });

  it('re-reads the row and does nothing when the schedule was disabled mid-flight', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const staleRow = scheduleRow();
    const triggerDeployment = vi.fn();

    await runScheduledDeployment(
      staleRow,
      baseDeps({
        prepareCheckout,
        triggerDeployment,
        // DB now reports the schedule as paused.
        getSchedule: () => scheduleRow({ enabled: 0 }),
      }),
    );

    expect(prepareCheckout).not.toHaveBeenCalled();
    expect(triggerDeployment).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('does nothing when the schedule was deleted mid-flight', async () => {
    const { prepareCheckout } = makeCheckoutTracker();
    const triggerDeployment = vi.fn();

    await runScheduledDeployment(
      scheduleRow(),
      baseDeps({ prepareCheckout, triggerDeployment, getSchedule: () => null }),
    );

    expect(prepareCheckout).not.toHaveBeenCalled();
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it('skips (and cleans up) when the environment is not deployable', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const row = scheduleRow();
    const triggerDeployment = vi.fn();

    await runScheduledDeployment(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        isEnvironmentDeployable: () => false,
        getSchedule: () => row,
        triggerDeployment,
      }),
    );

    expect(triggerDeployment).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
    expect(existsSync(created[0]!)).toBe(false);
  });

  it('swallows an EnvironmentBusyError and cleans up the checkout', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const row = scheduleRow();
    const log = vi.fn();
    const triggerDeployment = vi.fn(async () => {
      throw new EnvironmentBusyError('other-dep');
    });

    await expect(
      runScheduledDeployment(
        row,
        baseDeps({
          prepareCheckout,
          loadConfig: async () => configWith('prod'),
          isEnvironmentDeployable: () => true,
          getSchedule: () => row,
          triggerDeployment,
          log,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    expect(existsSync(created[0]!)).toBe(false);
    expect(log.mock.calls.some(([m]) => String(m).includes('busy'))).toBe(true);
  });

  it('skips (and cleans up) when the ref has no deploy.yaml', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const row = scheduleRow();
    const triggerDeployment = vi.fn();

    await runScheduledDeployment(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => {
          throw new DeployConfigError('not_found', 'deploy.yaml not found');
        },
        getSchedule: () => row,
        triggerDeployment,
      }),
    );

    expect(triggerDeployment).not.toHaveBeenCalled();
    expect(existsSync(created[0]!)).toBe(false);
  });

  it('does nothing when the project is not found', async () => {
    const { prepareCheckout } = makeCheckoutTracker();
    const row = scheduleRow();
    const triggerDeployment = vi.fn();

    await runScheduledDeployment(
      row,
      baseDeps({
        findProject: () => null,
        prepareCheckout,
        getSchedule: () => row,
        triggerDeployment,
      }),
    );

    expect(prepareCheckout).not.toHaveBeenCalled();
    expect(triggerDeployment).not.toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('registers only enabled schedules at boot, keyed by id, with cron + timezone', () => {
    const { calls, scheduleFn } = makeScheduleFn();
    const enabled = scheduleRow({ id: 'sch-on', cron: '0 3 * * *', timezone: 'America/New_York' });

    initDeploySchedules({
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      scheduleFn,
      listEnabledSchedules: () => [enabled],
      log: vi.fn(),
    });

    expect(getRegisteredScheduleIds()).toEqual(['sch-on']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cron).toBe('0 3 * * *');
    expect((calls[0]!.options as { timezone?: string }).timezone).toBe('America/New_York');
  });

  it('refreshScheduleRegistration arms a newly-created schedule', () => {
    const { scheduleFn } = makeScheduleFn();
    const row = scheduleRow({ id: 'sch-new' });

    initDeploySchedules({
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      scheduleFn,
      listEnabledSchedules: () => [],
      getSchedule: () => row,
      log: vi.fn(),
    });

    expect(getRegisteredScheduleIds()).toEqual([]);
    refreshScheduleRegistration(PROJECT.id, 'sch-new');
    expect(getRegisteredScheduleIds()).toEqual(['sch-new']);
  });

  it('refreshScheduleRegistration stops a task when the schedule flips to disabled', () => {
    const { calls, scheduleFn } = makeScheduleFn();
    let row = scheduleRow({ id: 'sch-toggle', enabled: 1 });

    initDeploySchedules({
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      scheduleFn,
      listEnabledSchedules: () => [row],
      getSchedule: () => row,
      log: vi.fn(),
    });
    expect(getRegisteredScheduleIds()).toEqual(['sch-toggle']);

    row = scheduleRow({ id: 'sch-toggle', enabled: 0 });
    refreshScheduleRegistration(PROJECT.id, 'sch-toggle');

    expect(getRegisteredScheduleIds()).toEqual([]);
    expect(calls[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it('refreshScheduleRegistration re-arms an edited schedule with the new cron (old task stopped)', () => {
    const { calls, scheduleFn } = makeScheduleFn();
    let row = scheduleRow({ id: 'sch-edit', cron: '0 3 * * *' });

    initDeploySchedules({
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      scheduleFn,
      listEnabledSchedules: () => [row],
      getSchedule: () => row,
      log: vi.fn(),
    });

    row = scheduleRow({ id: 'sch-edit', cron: '30 4 * * *' });
    refreshScheduleRegistration(PROJECT.id, 'sch-edit');

    expect(getRegisteredScheduleIds()).toEqual(['sch-edit']);
    expect(calls[0]!.stop).toHaveBeenCalledTimes(1); // old task stopped
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cron).toBe('30 4 * * *');
  });

  it('refreshScheduleRegistration stops a task when the schedule was deleted', () => {
    const { calls, scheduleFn } = makeScheduleFn();
    const row = scheduleRow({ id: 'sch-del' });
    let exists = true;

    initDeploySchedules({
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      scheduleFn,
      listEnabledSchedules: () => [row],
      getSchedule: () => (exists ? row : null),
      log: vi.fn(),
    });

    exists = false;
    refreshScheduleRegistration(PROJECT.id, 'sch-del');
    expect(getRegisteredScheduleIds()).toEqual([]);
    expect(calls[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it('unregisterSchedule stops and drops a running task', () => {
    const { calls, scheduleFn } = makeScheduleFn();
    const row = scheduleRow({ id: 'sch-unreg' });

    initDeploySchedules({
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      scheduleFn,
      listEnabledSchedules: () => [row],
      log: vi.fn(),
    });
    expect(getRegisteredScheduleIds()).toEqual(['sch-unreg']);

    unregisterSchedule('sch-unreg');
    expect(getRegisteredScheduleIds()).toEqual([]);
    expect(calls[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it('refreshScheduleRegistration is a no-op before initDeploySchedules', () => {
    // stopAllDeploySchedules() in beforeEach cleared injected deps.
    expect(() => refreshScheduleRegistration(PROJECT.id, 'whatever')).not.toThrow();
    expect(getRegisteredScheduleIds()).toEqual([]);
  });

  it('re-initializing re-syncs cleanly (old tasks stopped)', () => {
    const { calls, scheduleFn } = makeScheduleFn();
    const first = scheduleRow({ id: 'sch-a' });

    initDeploySchedules({
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      scheduleFn,
      listEnabledSchedules: () => [first],
      log: vi.fn(),
    });
    expect(getRegisteredScheduleIds()).toEqual(['sch-a']);

    const second = scheduleRow({ id: 'sch-b' });
    initDeploySchedules({
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      scheduleFn,
      listEnabledSchedules: () => [second],
      log: vi.fn(),
    });

    expect(getRegisteredScheduleIds()).toEqual(['sch-b']);
    expect(calls[0]!.stop).toHaveBeenCalledTimes(1); // sch-a task stopped
  });
});
