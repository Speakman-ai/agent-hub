/**
 * Deploy schedule store — CRUD, partial-update semantics, cron/timezone
 * validation, duplicate rejection, and the enabled-schedule listing the future
 * scheduler registration path consumes. Exercised against the shared test DB
 * (initialized once per file by test/setup.ts). No real CLI is spawned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import {
  createSchedule,
  deleteSchedule,
  DeployScheduleError,
  getSchedule,
  listEnabledSchedules,
  listSchedulesForEnvironment,
  listSchedulesForProject,
  updateSchedule,
} from './deployment-schedule-store.js';

const P = 'proj-schedule-test';
const CRON = '0 3 * * *';

beforeEach(() => {
  wipeTables(getDb(), ['deployment_env_schedule']);
});

describe('deploy schedule CRUD', () => {
  it('returns null / empty for an unconfigured project', () => {
    expect(getSchedule(P, 'missing')).toBeNull();
    expect(listSchedulesForProject(P)).toEqual([]);
    expect(listSchedulesForEnvironment(P, 'prod')).toEqual([]);
  });

  it('creates a schedule defaulting to enabled with null timezone/owner', () => {
    const row = createSchedule({
      projectId: P,
      environmentName: 'prod',
      ref: 'main',
      cron: CRON,
    });
    expect(row).toMatchObject({
      project_id: P,
      environment_name: 'prod',
      ref: 'main',
      cron: CRON,
      timezone: null,
      owner_user_id: null,
      enabled: 1,
      meta: null,
    });
    expect(getSchedule(P, row.id)).toMatchObject({ id: row.id });
  });

  it('honors enabled:false and persists timezone, owner, and meta', () => {
    const row = createSchedule({
      projectId: P,
      environmentName: 'prod',
      ref: 'release',
      cron: CRON,
      timezone: 'America/New_York',
      ownerUserId: 'user-1',
      enabled: false,
      meta: { note: 'nightly' },
    });
    expect(row.enabled).toBe(0);
    expect(row.timezone).toBe('America/New_York');
    expect(row.owner_user_id).toBe('user-1');
    expect(JSON.parse(row.meta as string)).toEqual({ note: 'nightly' });
  });

  it('trims the environment name and ref at the write boundary', () => {
    const row = createSchedule({
      projectId: P,
      environmentName: '  prod  ',
      ref: '  main  ',
      cron: CRON,
    });
    expect(row.environment_name).toBe('prod');
    expect(row.ref).toBe('main');
    expect(listSchedulesForEnvironment(P, 'prod')).toHaveLength(1);
  });

  it('rejects an empty ref', () => {
    expect(() =>
      createSchedule({ projectId: P, environmentName: 'prod', ref: '   ', cron: CRON }),
    ).toThrow(/ref is required/);
  });

  it('rejects an empty or invalid cron', () => {
    expect(() =>
      createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: '   ' }),
    ).toThrow(/cron is required/);
    expect(() =>
      createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: 'not-a-cron' }),
    ).toThrow(/valid cron expression/);
  });

  it('rejects an invalid IANA timezone', () => {
    expect(() =>
      createSchedule({
        projectId: P,
        environmentName: 'prod',
        ref: 'main',
        cron: CRON,
        timezone: 'Mars/Phobos',
      }),
    ).toThrow(/valid IANA timezone/);
  });

  it('rejects a duplicate (ref, cron) on the same environment', () => {
    createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: CRON });
    expect(() =>
      createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: CRON }),
    ).toThrow(DeployScheduleError);
    try {
      createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: CRON });
    } catch (err) {
      expect((err as DeployScheduleError).reason).toBe('duplicate');
    }
  });

  it('allows the same ref/cron on a different environment or a different cron', () => {
    createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: CRON });
    expect(() =>
      createSchedule({ projectId: P, environmentName: 'dev', ref: 'main', cron: CRON }),
    ).not.toThrow();
    expect(() =>
      createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: '0 4 * * *' }),
    ).not.toThrow();
  });

  it('lists schedules scoped to a project or environment, sorted', () => {
    createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: CRON });
    createSchedule({ projectId: P, environmentName: 'dev', ref: 'develop', cron: CRON });
    createSchedule({ projectId: 'other', environmentName: 'prod', ref: 'main', cron: CRON });
    expect(listSchedulesForProject(P)).toHaveLength(2);
    // dev sorts before prod.
    expect(listSchedulesForProject(P)[0]?.environment_name).toBe('dev');
    expect(listSchedulesForEnvironment(P, 'prod')).toHaveLength(1);
  });
});

describe('updateSchedule', () => {
  it('returns null for a missing schedule', () => {
    expect(updateSchedule(P, 'nope', { enabled: false })).toBeNull();
  });

  it('applies a partial update without clobbering other fields', () => {
    const row = createSchedule({
      projectId: P,
      environmentName: 'prod',
      ref: 'main',
      cron: CRON,
      timezone: 'UTC',
      ownerUserId: 'user-1',
      meta: { keep: true },
    });
    const updated = updateSchedule(P, row.id, { enabled: false });
    expect(updated).toMatchObject({
      enabled: 0,
      ref: 'main',
      cron: CRON,
      timezone: 'UTC',
      // owner is never touched by update.
      owner_user_id: 'user-1',
    });
    expect(JSON.parse(updated?.meta as string)).toEqual({ keep: true });
  });

  it('can change ref, cron, and timezone', () => {
    const row = createSchedule({
      projectId: P,
      environmentName: 'prod',
      ref: 'main',
      cron: CRON,
    });
    const updated = updateSchedule(P, row.id, {
      ref: 'release',
      cron: '30 2 * * 1',
      timezone: 'Europe/London',
    });
    expect(updated).toMatchObject({
      ref: 'release',
      cron: '30 2 * * 1',
      timezone: 'Europe/London',
    });
  });

  it('clears timezone and meta when passed null', () => {
    const row = createSchedule({
      projectId: P,
      environmentName: 'prod',
      ref: 'main',
      cron: CRON,
      timezone: 'UTC',
      meta: { x: 1 },
    });
    const updated = updateSchedule(P, row.id, { timezone: null, meta: null });
    expect(updated?.timezone).toBeNull();
    expect(updated?.meta).toBeNull();
  });

  it('rejects an invalid cron on update', () => {
    const row = createSchedule({
      projectId: P,
      environmentName: 'prod',
      ref: 'main',
      cron: CRON,
    });
    expect(() => updateSchedule(P, row.id, { cron: 'nope' })).toThrow(/valid cron expression/);
  });

  it('rejects an update that collides with another schedule', () => {
    createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: CRON });
    const b = createSchedule({
      projectId: P,
      environmentName: 'prod',
      ref: 'develop',
      cron: CRON,
    });
    expect(() => updateSchedule(P, b.id, { ref: 'main' })).toThrow(DeployScheduleError);
  });
});

describe('deleteSchedule', () => {
  it('removes a schedule and is idempotent', () => {
    const row = createSchedule({
      projectId: P,
      environmentName: 'prod',
      ref: 'main',
      cron: CRON,
    });
    expect(deleteSchedule(P, row.id)).toBe(true);
    expect(getSchedule(P, row.id)).toBeNull();
    expect(deleteSchedule(P, row.id)).toBe(false);
  });
});

describe('listEnabledSchedules', () => {
  it('returns only enabled schedules across projects', () => {
    createSchedule({ projectId: P, environmentName: 'prod', ref: 'main', cron: CRON });
    createSchedule({
      projectId: P,
      environmentName: 'dev',
      ref: 'develop',
      cron: CRON,
      enabled: false,
    });
    createSchedule({ projectId: 'other', environmentName: 'prod', ref: 'main', cron: CRON });
    const enabled = listEnabledSchedules();
    // Only the two enabled rows (this project's prod + other project's prod).
    const forTest = enabled.filter((s) => s.project_id === P || s.project_id === 'other');
    expect(forTest).toHaveLength(2);
    expect(forTest.every((s) => s.enabled === 1)).toBe(true);
    expect(forTest.some((s) => s.environment_name === 'dev')).toBe(false);
  });
});
