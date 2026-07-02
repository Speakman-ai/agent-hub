/**
 * Deploy trigger hook — the onPush/afterMerge evaluation path that turns a
 * matching branch update into an enqueued deployment. Every collaborator is
 * injected (findMatchingTriggers, isEnvironmentDeployable, prepareCheckout,
 * loadConfig, triggerDeployment) so these tests never touch the DB, spawn git,
 * or run a real runner — the trigger-hook logic is what's under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import type {
  AppConfig,
  DeploymentEnvironmentTriggerRow,
  DeploymentRow,
  Project,
} from '../types.js';
import type { DeployConfig } from './deploy-config.js';
import { DeployConfigError } from './deploy-config.js';
import { EnvironmentBusyError, type TriggerDeploymentInput } from './deploy-orchestrator.js';
import {
  __clearDeployTriggerQueues,
  buildDeployOrchestratorDeps,
  maybeRunDeployTriggers,
  type DeployTriggerHookDeps,
} from './deploy-trigger-hook.js';

const PROJECT = {
  id: 'proj-hook-test',
  githubRepo: 'owner/repo',
  gitHost: 'agenthub',
} as unknown as Project;

const APP_CONFIG = { personalOAuth: {} } as unknown as AppConfig;

function triggerRow(
  environment: string,
  event: 'push' | 'merge',
  branchPattern: string,
): DeploymentEnvironmentTriggerRow {
  return {
    id: `trg-${environment}-${event}-${branchPattern}`,
    project_id: PROJECT.id,
    environment_name: environment,
    event,
    branch_pattern: branchPattern,
    enabled: 1,
    meta: null,
    created_at: '2026-07-02T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
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

/** A typed triggerDeployment mock so `.mock.calls[i][0]` is the input, not `never`. */
function mockTrigger(id: string) {
  return vi.fn(async (_input: TriggerDeploymentInput) => ({ id }) as DeploymentRow);
}

/** A prepareCheckout seam that materializes a REAL temp dir so cleanup is observable. */
function makeCheckoutTracker() {
  const created: string[] = [];
  const prepareCheckout = vi.fn(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dth-test-'));
    created.push(dir);
    return { worktreePath: dir, resolvedRef: 'resolved-sha-abc' };
  });
  return { created, prepareCheckout };
}

beforeEach(() => {
  __clearDeployTriggerQueues();
});
afterEach(() => {
  __clearDeployTriggerQueues();
});

describe('maybeRunDeployTriggers', () => {
  it('does nothing (no checkout, no trigger) when no trigger matches', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const triggerDeployment = vi.fn();
    const findMatchingTriggers = vi.fn(() => []);

    await maybeRunDeployTriggers(PROJECT, 'push', ['refs/heads/main'], {
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      prepareCheckout,
      findMatchingTriggers,
      triggerDeployment,
      log: vi.fn(),
    } as DeployTriggerHookDeps);

    expect(findMatchingTriggers).toHaveBeenCalledWith(PROJECT.id, 'push', 'main');
    expect(prepareCheckout).not.toHaveBeenCalled();
    expect(triggerDeployment).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('enqueues a deployment (trigger=push, triggeredBy=null) for a matching deployable env', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const triggerDeployment = mockTrigger('dep-1');

    await maybeRunDeployTriggers(PROJECT, 'push', ['refs/heads/main'], {
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      prepareCheckout,
      loadConfig: async () => configWith('prod'),
      findMatchingTriggers: () => [triggerRow('prod', 'push', 'main')],
      isEnvironmentDeployable: () => true,
      triggerDeployment,
      log: vi.fn(),
    } as DeployTriggerHookDeps);

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    const [input] = triggerDeployment.mock.calls[0]!;
    expect(input).toMatchObject({
      projectId: PROJECT.id,
      environment: 'prod',
      ref: 'resolved-sha-abc',
      trigger: 'push',
      triggeredBy: null,
      deferRun: true,
      cleanupWorktreeOnTerminal: true,
      meta: { triggeredByEvent: 'push', branch: 'main' },
    });
    // The single config checkout is reused for the deployment (no second clone).
    expect(prepareCheckout).toHaveBeenCalledTimes(1);
    expect(input.worktreePath).toBe(created[0]);
    // Success ⇒ ownership transferred to the orchestrator; the hook must NOT
    // clean the worktree itself.
    expect(existsSync(created[0]!)).toBe(true);
  });

  it('uses the merge event for the afterMerge hook', async () => {
    const findMatchingTriggers = vi.fn(() => [triggerRow('staging', 'merge', 'main')]);
    const triggerDeployment = mockTrigger('dep-2');
    const { prepareCheckout } = makeCheckoutTracker();

    await maybeRunDeployTriggers(PROJECT, 'merge', ['refs/heads/main'], {
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      prepareCheckout,
      loadConfig: async () => configWith('staging'),
      findMatchingTriggers,
      isEnvironmentDeployable: () => true,
      triggerDeployment,
      log: vi.fn(),
    } as DeployTriggerHookDeps);

    expect(findMatchingTriggers).toHaveBeenCalledWith(PROJECT.id, 'merge', 'main');
    expect(triggerDeployment.mock.calls[0]![0]).toMatchObject({ trigger: 'push' });
  });

  it('skips (and cleans up) an environment that is not deployable', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const triggerDeployment = vi.fn();

    await maybeRunDeployTriggers(PROJECT, 'push', ['refs/heads/main'], {
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      prepareCheckout,
      loadConfig: async () => configWith('prod'),
      findMatchingTriggers: () => [triggerRow('prod', 'push', 'main')],
      isEnvironmentDeployable: () => false,
      triggerDeployment,
      log: vi.fn(),
    } as DeployTriggerHookDeps);

    expect(triggerDeployment).not.toHaveBeenCalled();
    // Config checkout was made but no env consumed it → cleaned up.
    expect(created).toHaveLength(1);
    expect(existsSync(created[0]!)).toBe(false);
  });

  it('swallows an EnvironmentBusyError and cleans up the checkout', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const triggerDeployment = vi.fn(async () => {
      throw new EnvironmentBusyError('other-dep');
    });
    const log = vi.fn();

    await expect(
      maybeRunDeployTriggers(PROJECT, 'push', ['refs/heads/main'], {
        broadcast: vi.fn(),
        config: APP_CONFIG,
        findProject: () => PROJECT,
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        findMatchingTriggers: () => [triggerRow('prod', 'push', 'main')],
        isEnvironmentDeployable: () => true,
        triggerDeployment,
        log,
      } as DeployTriggerHookDeps),
    ).resolves.toBeUndefined();

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    expect(existsSync(created[0]!)).toBe(false);
    expect(log.mock.calls.some(([m]) => String(m).includes('busy'))).toBe(true);
  });

  it('ignores non-branch refs (tags) and never queries them', async () => {
    const findMatchingTriggers = vi.fn(() => []);
    const { prepareCheckout } = makeCheckoutTracker();

    await maybeRunDeployTriggers(PROJECT, 'push', ['refs/tags/v1.0.0'], {
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      prepareCheckout,
      findMatchingTriggers,
      triggerDeployment: vi.fn(),
      log: vi.fn(),
    } as DeployTriggerHookDeps);

    expect(findMatchingTriggers).not.toHaveBeenCalled();
    expect(prepareCheckout).not.toHaveBeenCalled();
  });

  it('skips silently when the branch has no deploy.yaml', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const triggerDeployment = vi.fn();

    await maybeRunDeployTriggers(PROJECT, 'push', ['refs/heads/main'], {
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      prepareCheckout,
      loadConfig: async () => {
        throw new DeployConfigError('not_found', 'deploy.yaml not found');
      },
      findMatchingTriggers: () => [triggerRow('prod', 'push', 'main')],
      isEnvironmentDeployable: () => true,
      triggerDeployment,
      log: vi.fn(),
    } as DeployTriggerHookDeps);

    expect(triggerDeployment).not.toHaveBeenCalled();
    expect(existsSync(created[0]!)).toBe(false);
  });

  it('deduplicates the same environment across multiple matching triggers', async () => {
    const { prepareCheckout } = makeCheckoutTracker();
    const triggerDeployment = mockTrigger('dep-3');

    await maybeRunDeployTriggers(PROJECT, 'push', ['refs/heads/main'], {
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      prepareCheckout,
      loadConfig: async () => configWith('prod'),
      findMatchingTriggers: () => [
        triggerRow('prod', 'push', 'main'),
        triggerRow('prod', 'push', '*'),
      ],
      isEnvironmentDeployable: () => true,
      triggerDeployment,
      log: vi.fn(),
    } as DeployTriggerHookDeps);

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
  });

  it('enqueues each distinct environment (second env gets a fresh checkout)', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const triggerDeployment = mockTrigger('dep-4');

    await maybeRunDeployTriggers(PROJECT, 'push', ['refs/heads/main'], {
      broadcast: vi.fn(),
      config: APP_CONFIG,
      findProject: () => PROJECT,
      prepareCheckout,
      loadConfig: async () => configWith('prod', 'staging'),
      findMatchingTriggers: () => [
        triggerRow('prod', 'push', 'main'),
        triggerRow('staging', 'push', 'main'),
      ],
      isEnvironmentDeployable: () => true,
      triggerDeployment,
      log: vi.fn(),
    } as DeployTriggerHookDeps);

    expect(triggerDeployment).toHaveBeenCalledTimes(2);
    // One config checkout reused + one fresh for the second env.
    expect(prepareCheckout).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(2);
    const envs = triggerDeployment.mock.calls.map(([i]) => i.environment).sort();
    expect(envs).toEqual(['prod', 'staging']);
  });
});

describe('buildDeployOrchestratorDeps', () => {
  const base = {
    broadcast: vi.fn(),
    config: APP_CONFIG,
    findProject: (id: string) => (id === PROJECT.id ? PROJECT : undefined),
    prepareCheckout: vi.fn(async () => ({ worktreePath: '/tmp/x', resolvedRef: 'sha' })),
  };

  it('defaults releaseDigestConfig to the app config and resolves the project GitHub repo', () => {
    const deps = buildDeployOrchestratorDeps(base);
    expect(deps.releaseDigestConfig).toBe(APP_CONFIG);
    expect(deps.resolveProjectGithubRepo!(PROJECT.id)).toBe('owner/repo');
    expect(deps.resolveProjectGithubRepo!('missing')).toBe(null);
  });

  it('lets explicit overrides win over the defaults', () => {
    const runnerBackend = {} as never;
    const now = () => 123;
    const deps = buildDeployOrchestratorDeps({
      ...base,
      overrides: { runnerBackend, now, resolveProjectGithubRepo: () => 'x/y' },
    });
    expect(deps.runnerBackend).toBe(runnerBackend);
    expect(deps.now).toBe(now);
    expect(deps.resolveProjectGithubRepo!(PROJECT.id)).toBe('x/y');
  });
});
