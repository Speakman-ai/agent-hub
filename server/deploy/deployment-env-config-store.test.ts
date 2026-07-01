/**
 * Per-environment runtime config store — CRUD + the deploy.yaml active/deployable
 * resolution. Exercised against the shared test DB (initialized once per file by
 * test/setup.ts). No real CLI is spawned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import {
  getEnvironmentConfig,
  listEnvironmentConfigs,
  upsertEnvironmentConfig,
  setEnvironmentEnabled,
  deleteEnvironmentConfig,
  isEnvironmentDeployable,
  resolveEnvironmentConfigs,
} from './deployment-env-config-store.js';

const P = 'proj-env-config-test';

beforeEach(() => {
  wipeTables(getDb(), ['deployment_env_runtime_config']);
});

describe('deployment env config CRUD', () => {
  it('returns null / empty for an unconfigured project', () => {
    expect(getEnvironmentConfig(P, 'dev')).toBeNull();
    expect(listEnvironmentConfigs(P)).toEqual([]);
  });

  it('creates a row defaulting to enabled', () => {
    const row = upsertEnvironmentConfig({ projectId: P, environmentName: 'dev' });
    expect(row.project_id).toBe(P);
    expect(row.environment_name).toBe('dev');
    expect(row.enabled).toBe(1);
    expect(row.meta).toBeNull();
    expect(getEnvironmentConfig(P, 'dev')).toMatchObject({ enabled: 1 });
  });

  it('persists meta as JSON and round-trips it', () => {
    const row = upsertEnvironmentConfig({
      projectId: P,
      environmentName: 'prod',
      meta: { note: 'gated' },
    });
    expect(JSON.parse(row.meta as string)).toEqual({ note: 'gated' });
  });

  it('partial-updates: flipping enabled preserves meta, and vice versa', () => {
    upsertEnvironmentConfig({ projectId: P, environmentName: 'dev', meta: { a: 1 } });
    // Flip enabled only — meta must survive.
    const disabled = setEnvironmentEnabled(P, 'dev', false);
    expect(disabled.enabled).toBe(0);
    expect(JSON.parse(disabled.meta as string)).toEqual({ a: 1 });
    // Update meta only — enabled must survive.
    const remetad = upsertEnvironmentConfig({
      projectId: P,
      environmentName: 'dev',
      meta: { a: 2 },
    });
    expect(remetad.enabled).toBe(0);
    expect(JSON.parse(remetad.meta as string)).toEqual({ a: 2 });
  });

  it('clears meta when explicitly passed null', () => {
    upsertEnvironmentConfig({ projectId: P, environmentName: 'dev', meta: { a: 1 } });
    const cleared = upsertEnvironmentConfig({ projectId: P, environmentName: 'dev', meta: null });
    expect(cleared.meta).toBeNull();
  });

  it('re-enabling keeps a stable id (upsert, not insert)', () => {
    const first = upsertEnvironmentConfig({ projectId: P, environmentName: 'dev', enabled: false });
    const second = setEnvironmentEnabled(P, 'dev', true);
    expect(second.id).toBe(first.id);
    expect(second.enabled).toBe(1);
    expect(listEnvironmentConfigs(P)).toHaveLength(1);
  });

  it('lists configs ordered by environment name', () => {
    upsertEnvironmentConfig({ projectId: P, environmentName: 'staging' });
    upsertEnvironmentConfig({ projectId: P, environmentName: 'dev' });
    upsertEnvironmentConfig({ projectId: P, environmentName: 'production' });
    expect(listEnvironmentConfigs(P).map((r) => r.environment_name)).toEqual([
      'dev',
      'production',
      'staging',
    ]);
  });

  it('deletes a config row', () => {
    upsertEnvironmentConfig({ projectId: P, environmentName: 'dev' });
    expect(deleteEnvironmentConfig(P, 'dev')).toBe(true);
    expect(getEnvironmentConfig(P, 'dev')).toBeNull();
    expect(deleteEnvironmentConfig(P, 'dev')).toBe(false);
  });

  it('normalizes the environment key on write so trimmed reads find the row', () => {
    // A padded write must be stored under the trimmed key, so every read path
    // (which trims) resolves it — otherwise a paused env could look deployable.
    const written = upsertEnvironmentConfig({
      projectId: P,
      environmentName: '  dev  ',
      enabled: false,
    });
    expect(written.environment_name).toBe('dev');
    expect(getEnvironmentConfig(P, 'dev')?.enabled).toBe(0);
    expect(listEnvironmentConfigs(P)).toHaveLength(1);
    // A padded write to the same env updates the same row, not a duplicate.
    upsertEnvironmentConfig({ projectId: P, environmentName: 'dev', meta: { a: 1 } });
    expect(listEnvironmentConfigs(P)).toHaveLength(1);
    expect(getEnvironmentConfig(P, '  dev  ')?.id).toBe(written.id);
    // Resolution against the trimmed deploy.yaml name treats it as active+paused.
    expect(resolveEnvironmentConfigs(P, ['dev'])).toMatchObject([
      { environmentName: 'dev', active: true, enabled: false, deployable: false },
    ]);
    // Delete also normalizes the key.
    expect(deleteEnvironmentConfig(P, ' dev ')).toBe(true);
    expect(getEnvironmentConfig(P, 'dev')).toBeNull();
  });

  it('scopes rows per project', () => {
    upsertEnvironmentConfig({ projectId: P, environmentName: 'dev', enabled: false });
    upsertEnvironmentConfig({ projectId: 'other-proj', environmentName: 'dev' });
    expect(getEnvironmentConfig(P, 'dev')?.enabled).toBe(0);
    expect(getEnvironmentConfig('other-proj', 'dev')?.enabled).toBe(1);
    getDb().exec("DELETE FROM deployment_env_runtime_config WHERE project_id = 'other-proj';");
  });
});

describe('resolveEnvironmentConfigs — deploy.yaml active/deployable rule', () => {
  it('declared + no config → active, enabled by default, deployable', () => {
    const resolved = resolveEnvironmentConfigs(P, ['dev', 'production']);
    expect(resolved).toEqual([
      { environmentName: 'dev', active: true, enabled: true, deployable: true, config: null },
      {
        environmentName: 'production',
        active: true,
        enabled: true,
        deployable: true,
        config: null,
      },
    ]);
  });

  it('declared + disabled config → active but not deployable', () => {
    setEnvironmentEnabled(P, 'dev', false);
    const dev = resolveEnvironmentConfigs(P, ['dev']).find((r) => r.environmentName === 'dev');
    expect(dev).toMatchObject({ active: true, enabled: false, deployable: false });
    expect(dev?.config).not.toBeNull();
  });

  it('config present but env removed from deploy.yaml → inactive, not deployable', () => {
    upsertEnvironmentConfig({ projectId: P, environmentName: 'legacy', enabled: true });
    const legacy = resolveEnvironmentConfigs(P, ['dev']).find(
      (r) => r.environmentName === 'legacy',
    );
    // Even though the operator left it enabled, an env absent from deploy.yaml
    // is inactive and must never be deployable.
    expect(legacy).toMatchObject({ active: false, enabled: true, deployable: false });
  });

  it('merges declared and configured names, sorted, de-duplicated', () => {
    setEnvironmentEnabled(P, 'dev', false);
    upsertEnvironmentConfig({ projectId: P, environmentName: 'legacy' });
    const names = resolveEnvironmentConfigs(P, ['production', 'dev']).map((r) => r.environmentName);
    expect(names).toEqual(['dev', 'legacy', 'production']);
  });

  it('ignores blank/whitespace declared names', () => {
    const resolved = resolveEnvironmentConfigs(P, ['dev', '  ', '']);
    expect(resolved.map((r) => r.environmentName)).toEqual(['dev']);
  });
});

describe('isEnvironmentDeployable', () => {
  it('true when declared and enabled (no config row)', () => {
    expect(isEnvironmentDeployable(P, 'dev', ['dev'])).toBe(true);
  });

  it('false when declared but paused by operator', () => {
    setEnvironmentEnabled(P, 'dev', false);
    expect(isEnvironmentDeployable(P, 'dev', ['dev'])).toBe(false);
  });

  it('false when not declared in deploy.yaml, even with an enabled config row', () => {
    upsertEnvironmentConfig({ projectId: P, environmentName: 'legacy', enabled: true });
    expect(isEnvironmentDeployable(P, 'legacy', ['dev'])).toBe(false);
  });

  it('trims the environment name consistently for both the declared check and config lookup', () => {
    // A paused env queried with a padded name must still resolve its stored
    // config row (not silently fall back to the enabled default).
    setEnvironmentEnabled(P, 'dev', false);
    expect(isEnvironmentDeployable(P, '  dev  ', ['dev'])).toBe(false);
  });
});
