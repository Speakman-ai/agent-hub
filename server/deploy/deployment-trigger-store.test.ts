/**
 * Deploy trigger store — CRUD, partial-update semantics, duplicate rejection,
 * and the branch-pattern matching used by the hook evaluation path. Exercised
 * against the shared test DB (initialized once per file by test/setup.ts). No
 * real CLI is spawned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import {
  branchMatchesPattern,
  createTrigger,
  deleteTrigger,
  DeployTriggerError,
  findMatchingTriggers,
  getTrigger,
  listTriggersForEnvironment,
  listTriggersForProject,
  updateTrigger,
} from './deployment-trigger-store.js';

const P = 'proj-trigger-test';

beforeEach(() => {
  wipeTables(getDb(), ['deployment_env_trigger']);
});

describe('branchMatchesPattern', () => {
  it('matches exact literals', () => {
    expect(branchMatchesPattern('main', 'main')).toBe(true);
    expect(branchMatchesPattern('main', 'develop')).toBe(false);
  });

  it('treats * as within-segment wildcard (no slash)', () => {
    expect(branchMatchesPattern('release/*', 'release/1.0')).toBe(true);
    expect(branchMatchesPattern('release/*', 'release/1.0/hotfix')).toBe(false);
    expect(branchMatchesPattern('feat-*', 'feat-login')).toBe(true);
  });

  it('treats ** as across-segment wildcard (matches slashes)', () => {
    expect(branchMatchesPattern('release/**', 'release/1.0/hotfix')).toBe(true);
    expect(branchMatchesPattern('**', 'any/deep/branch')).toBe(true);
  });

  it('escapes regex specials in the pattern', () => {
    expect(branchMatchesPattern('v1.0', 'v1.0')).toBe(true);
    // The '.' is literal, not "any char".
    expect(branchMatchesPattern('v1.0', 'v1x0')).toBe(false);
  });

  it('strips a leading refs/heads/ from the branch', () => {
    expect(branchMatchesPattern('main', 'refs/heads/main')).toBe(true);
    expect(branchMatchesPattern('release/*', 'refs/heads/release/2.0')).toBe(true);
  });

  it('never matches an empty pattern or empty branch', () => {
    expect(branchMatchesPattern('', 'main')).toBe(false);
    expect(branchMatchesPattern('main', '')).toBe(false);
    expect(branchMatchesPattern('  ', 'main')).toBe(false);
  });
});

describe('deploy trigger CRUD', () => {
  it('returns null / empty for an unconfigured project', () => {
    expect(getTrigger(P, 'missing')).toBeNull();
    expect(listTriggersForProject(P)).toEqual([]);
    expect(listTriggersForEnvironment(P, 'prod')).toEqual([]);
  });

  it('creates a trigger defaulting to enabled', () => {
    const row = createTrigger({
      projectId: P,
      environmentName: 'prod',
      event: 'push',
      branchPattern: 'main',
    });
    expect(row).toMatchObject({
      project_id: P,
      environment_name: 'prod',
      event: 'push',
      branch_pattern: 'main',
      enabled: 1,
      meta: null,
    });
    expect(getTrigger(P, row.id)).toMatchObject({ id: row.id });
  });

  it('honors enabled:false and persists meta as JSON', () => {
    const row = createTrigger({
      projectId: P,
      environmentName: 'prod',
      event: 'merge',
      branchPattern: 'release/*',
      enabled: false,
      meta: { note: 'gated' },
    });
    expect(row.enabled).toBe(0);
    expect(JSON.parse(row.meta as string)).toEqual({ note: 'gated' });
  });

  it('trims the environment name at the write boundary', () => {
    const row = createTrigger({
      projectId: P,
      environmentName: '  prod  ',
      event: 'push',
      branchPattern: 'main',
    });
    expect(row.environment_name).toBe('prod');
    expect(listTriggersForEnvironment(P, 'prod')).toHaveLength(1);
  });

  it('rejects a duplicate (event, branchPattern) on the same environment', () => {
    createTrigger({ projectId: P, environmentName: 'prod', event: 'push', branchPattern: 'main' });
    expect(() =>
      createTrigger({
        projectId: P,
        environmentName: 'prod',
        event: 'push',
        branchPattern: 'main',
      }),
    ).toThrow(DeployTriggerError);
    try {
      createTrigger({
        projectId: P,
        environmentName: 'prod',
        event: 'push',
        branchPattern: 'main',
      });
    } catch (err) {
      expect((err as DeployTriggerError).reason).toBe('duplicate');
    }
  });

  it('allows the same pattern on a different event or environment', () => {
    createTrigger({ projectId: P, environmentName: 'prod', event: 'push', branchPattern: 'main' });
    expect(() =>
      createTrigger({
        projectId: P,
        environmentName: 'prod',
        event: 'merge',
        branchPattern: 'main',
      }),
    ).not.toThrow();
    expect(() =>
      createTrigger({ projectId: P, environmentName: 'dev', event: 'push', branchPattern: 'main' }),
    ).not.toThrow();
  });

  it('rejects an empty branch pattern', () => {
    expect(() =>
      createTrigger({ projectId: P, environmentName: 'prod', event: 'push', branchPattern: '   ' }),
    ).toThrow(/branchPattern is required/);
  });

  it('lists triggers scoped to a project or environment, sorted', () => {
    createTrigger({ projectId: P, environmentName: 'prod', event: 'push', branchPattern: 'main' });
    createTrigger({
      projectId: P,
      environmentName: 'dev',
      event: 'push',
      branchPattern: 'develop',
    });
    createTrigger({
      projectId: 'other',
      environmentName: 'prod',
      event: 'push',
      branchPattern: 'main',
    });
    expect(listTriggersForProject(P)).toHaveLength(2);
    // dev sorts before prod.
    expect(listTriggersForProject(P)[0]?.environment_name).toBe('dev');
    expect(listTriggersForEnvironment(P, 'prod')).toHaveLength(1);
  });
});

describe('updateTrigger', () => {
  it('returns null for a missing trigger', () => {
    expect(updateTrigger(P, 'nope', { enabled: false })).toBeNull();
  });

  it('applies a partial update without clobbering other fields', () => {
    const row = createTrigger({
      projectId: P,
      environmentName: 'prod',
      event: 'push',
      branchPattern: 'main',
      meta: { keep: true },
    });
    const updated = updateTrigger(P, row.id, { enabled: false });
    expect(updated).toMatchObject({ enabled: 0, branch_pattern: 'main', event: 'push' });
    // meta preserved.
    expect(JSON.parse(updated?.meta as string)).toEqual({ keep: true });
  });

  it('can change event and branch pattern', () => {
    const row = createTrigger({
      projectId: P,
      environmentName: 'prod',
      event: 'push',
      branchPattern: 'main',
    });
    const updated = updateTrigger(P, row.id, { event: 'merge', branchPattern: 'release/*' });
    expect(updated).toMatchObject({ event: 'merge', branch_pattern: 'release/*' });
  });

  it('clears meta when passed null', () => {
    const row = createTrigger({
      projectId: P,
      environmentName: 'prod',
      event: 'push',
      branchPattern: 'main',
      meta: { x: 1 },
    });
    expect(updateTrigger(P, row.id, { meta: null })?.meta).toBeNull();
  });

  it('rejects an update that collides with another trigger', () => {
    createTrigger({ projectId: P, environmentName: 'prod', event: 'push', branchPattern: 'main' });
    const b = createTrigger({
      projectId: P,
      environmentName: 'prod',
      event: 'push',
      branchPattern: 'develop',
    });
    expect(() => updateTrigger(P, b.id, { branchPattern: 'main' })).toThrow(DeployTriggerError);
  });
});

describe('deleteTrigger', () => {
  it('removes a trigger and is idempotent', () => {
    const row = createTrigger({
      projectId: P,
      environmentName: 'prod',
      event: 'push',
      branchPattern: 'main',
    });
    expect(deleteTrigger(P, row.id)).toBe(true);
    expect(getTrigger(P, row.id)).toBeNull();
    expect(deleteTrigger(P, row.id)).toBe(false);
  });
});

describe('findMatchingTriggers', () => {
  beforeEach(() => {
    createTrigger({ projectId: P, environmentName: 'prod', event: 'push', branchPattern: 'main' });
    createTrigger({
      projectId: P,
      environmentName: 'staging',
      event: 'push',
      branchPattern: 'release/*',
    });
    createTrigger({
      projectId: P,
      environmentName: 'prod',
      event: 'merge',
      branchPattern: 'main',
    });
    createTrigger({
      projectId: P,
      environmentName: 'dev',
      event: 'push',
      branchPattern: 'main',
      enabled: false,
    });
  });

  it('returns enabled triggers matching the event and branch', () => {
    const matches = findMatchingTriggers(P, 'push', 'main');
    expect(matches.map((t) => t.environment_name)).toEqual(['prod']);
  });

  it('filters by event', () => {
    expect(findMatchingTriggers(P, 'merge', 'main').map((t) => t.environment_name)).toEqual([
      'prod',
    ]);
  });

  it('matches glob patterns', () => {
    expect(findMatchingTriggers(P, 'push', 'release/2.0').map((t) => t.environment_name)).toEqual([
      'staging',
    ]);
  });

  it('excludes disabled triggers', () => {
    // dev has a disabled push->main trigger; only prod (enabled) should match.
    const envs = findMatchingTriggers(P, 'push', 'main').map((t) => t.environment_name);
    expect(envs).not.toContain('dev');
  });

  it('returns empty when nothing matches', () => {
    expect(findMatchingTriggers(P, 'push', 'feature/x')).toEqual([]);
  });
});
