/**
 * Release gate ticker — the evaluation + firing sweep that turns a satisfied
 * armed gate into a one-shot deployment. Every collaborator is injected
 * (getReleaseGate, listActiveReleaseGates, markReleaseGateFired/Failed,
 * resolvers, prepareCheckout, loadConfig, triggerDeployment,
 * isEnvironmentDeployable, scheduleFn) so these tests never touch the DB, spawn
 * git, run a real runner, or arm a wall-clock timer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ScheduledTask } from 'node-cron';
import type {
  AppConfig,
  DeploymentEnvironmentReleaseGateRow,
  DeploymentRow,
  Project,
} from '../types.js';
import type { DeployConfig } from './deploy-config.js';
import { DeployConfigError } from './deploy-config.js';
import { EnvironmentBusyError, type TriggerDeploymentInput } from './deploy-orchestrator.js';
import type { ReleaseGateResolvers } from './release-gate-evaluator.js';
import {
  fireReleaseGate,
  initReleaseGates,
  isReleaseGateSweepRegistered,
  stopReleaseGates,
  sweepReleaseGates,
  type ReleaseGateTickerDeps,
} from './release-gate-ticker.js';

const PROJECT = {
  id: 'proj-gate-test',
  githubRepo: 'owner/repo',
  gitHost: 'agenthub',
} as unknown as Project;

const APP_CONFIG = { personalOAuth: {} } as unknown as AppConfig;

function gateRow(
  overrides: Partial<DeploymentEnvironmentReleaseGateRow> = {},
): DeploymentEnvironmentReleaseGateRow {
  return {
    id: 'gate-1',
    project_id: PROJECT.id,
    environment_name: 'prod',
    ref: 'main',
    session_ids: JSON.stringify(['s1']),
    epic_ids: JSON.stringify([]),
    owner_user_id: 'user-42',
    status: 'armed',
    enabled: 1,
    fired_deployment_id: null,
    last_error: null,
    resolved_at: null,
    meta: null,
    created_at: '2026-08-20T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
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
  } as unknown as DeployConfig;
}

function mockTrigger(id: string) {
  return vi.fn(async (_input: TriggerDeploymentInput) => ({ id }) as DeploymentRow);
}

function makeCheckoutTracker() {
  const created: string[] = [];
  const prepareCheckout = vi.fn(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-test-'));
    created.push(dir);
    return { worktreePath: dir, resolvedRef: 'resolved-sha-abc' };
  });
  return { created, prepareCheckout };
}

function makeScheduleFn() {
  const calls: Array<{ cron: string; stop: ReturnType<typeof vi.fn> }> = [];
  const scheduleFn = vi.fn((cronExpr: string, _fn: unknown, _options: unknown) => {
    const stop = vi.fn();
    calls.push({ cron: cronExpr, stop });
    return { stop } as unknown as ScheduledTask;
  }) as unknown as ReleaseGateTickerDeps['scheduleFn'];
  return { calls, scheduleFn };
}

/** Resolvers where every listed id is complete; anything else is missing. */
function completeResolvers(sessions: string[], epics: string[]): ReleaseGateResolvers {
  return {
    sessionState: (id) => (sessions.includes(id) ? 'complete' : 'missing'),
    epicState: (id) => (epics.includes(id) ? 'complete' : 'missing'),
  };
}

beforeEach(() => {
  stopReleaseGates();
});
afterEach(() => {
  stopReleaseGates();
});

const baseDeps = (over: Partial<ReleaseGateTickerDeps> = {}): ReleaseGateTickerDeps => ({
  broadcast: vi.fn(),
  config: APP_CONFIG,
  findProject: () => PROJECT,
  log: vi.fn(),
  ...over,
});

describe('fireReleaseGate', () => {
  it('enqueues a deployment (trigger=release_gate, ref=main, owner) and marks fired', async () => {
    const { prepareCheckout } = makeCheckoutTracker();
    const row = gateRow();
    const triggerDeployment = mockTrigger('dep-1');
    const markReleaseGateFired = vi.fn(() => true);

    await fireReleaseGate(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        isEnvironmentDeployable: () => true,
        getReleaseGate: () => row,
        resolvers: completeResolvers(['s1'], []),
        triggerDeployment,
        markReleaseGateFired,
      }),
    );

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    const [input] = triggerDeployment.mock.calls[0]!;
    expect(input).toMatchObject({
      projectId: PROJECT.id,
      environment: 'prod',
      ref: 'resolved-sha-abc',
      trigger: 'release_gate',
      triggeredBy: 'user-42',
      deferRun: true,
      cleanupWorktreeOnTerminal: true,
      meta: { triggeredByReleaseGate: 'gate-1' },
    });
    expect(markReleaseGateFired).toHaveBeenCalledWith(PROJECT.id, 'gate-1', 'dep-1');
  });

  it('re-reads and skips a gate flipped off between sweep and fire', async () => {
    const triggerDeployment = mockTrigger('dep-1');
    await fireReleaseGate(
      gateRow(),
      baseDeps({
        getReleaseGate: () => gateRow({ enabled: 0 }),
        resolvers: completeResolvers(['s1'], []),
        triggerDeployment,
      }),
    );
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it('re-evaluates and skips when the condition no longer holds', async () => {
    const triggerDeployment = mockTrigger('dep-1');
    await fireReleaseGate(
      gateRow(),
      baseDeps({
        getReleaseGate: () => gateRow(),
        // s1 is no longer complete → not satisfied.
        resolvers: { sessionState: () => 'pending', epicState: () => 'missing' },
        triggerDeployment,
      }),
    );
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it('leaves the gate armed (no mark) when the env is not deployable, and cleans up', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const row = gateRow();
    const markReleaseGateFired = vi.fn(() => true);
    const markReleaseGateFailed = vi.fn(() => true);

    await fireReleaseGate(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        isEnvironmentDeployable: () => false,
        getReleaseGate: () => row,
        resolvers: completeResolvers(['s1'], []),
        markReleaseGateFired,
        markReleaseGateFailed,
      }),
    );

    expect(markReleaseGateFired).not.toHaveBeenCalled();
    expect(markReleaseGateFailed).not.toHaveBeenCalled();
    expect(existsSync(created[0]!)).toBe(false);
  });

  it('leaves the gate armed when the env is busy (transient)', async () => {
    const { prepareCheckout } = makeCheckoutTracker();
    const row = gateRow();
    const markReleaseGateFailed = vi.fn(() => true);

    await fireReleaseGate(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        isEnvironmentDeployable: () => true,
        getReleaseGate: () => row,
        resolvers: completeResolvers(['s1'], []),
        triggerDeployment: vi.fn(async () => {
          throw new EnvironmentBusyError('other-dep');
        }),
        markReleaseGateFailed,
      }),
    );
    expect(markReleaseGateFailed).not.toHaveBeenCalled();
  });

  it('leaves the gate armed when deploy.yaml is missing at the ref (transient)', async () => {
    const { prepareCheckout } = makeCheckoutTracker();
    const row = gateRow();
    const markReleaseGateFailed = vi.fn(() => true);

    await fireReleaseGate(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => {
          throw new DeployConfigError('not_found', 'no deploy.yaml');
        },
        getReleaseGate: () => row,
        resolvers: completeResolvers(['s1'], []),
        markReleaseGateFailed,
      }),
    );
    expect(markReleaseGateFailed).not.toHaveBeenCalled();
  });

  it('marks the gate failed on a genuine enqueue error', async () => {
    const { created, prepareCheckout } = makeCheckoutTracker();
    const row = gateRow();
    const markReleaseGateFailed = vi.fn(() => true);

    await fireReleaseGate(
      row,
      baseDeps({
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        isEnvironmentDeployable: () => true,
        getReleaseGate: () => row,
        resolvers: completeResolvers(['s1'], []),
        triggerDeployment: vi.fn(async () => {
          throw new Error('runner exploded');
        }),
        markReleaseGateFailed,
      }),
    );
    expect(markReleaseGateFailed).toHaveBeenCalledWith(PROJECT.id, 'gate-1', 'runner exploded');
    expect(existsSync(created[0]!)).toBe(false);
  });
});

describe('sweepReleaseGates', () => {
  it('fires only satisfied gates and skips pending ones', async () => {
    const { prepareCheckout } = makeCheckoutTracker();
    const ready = gateRow({ id: 'ready', session_ids: JSON.stringify(['s1']) });
    const pending = gateRow({ id: 'pending', session_ids: JSON.stringify(['s2']) });
    const triggerDeployment = mockTrigger('dep-1');
    const markReleaseGateFired = vi.fn(() => true);
    const byId: Record<string, DeploymentEnvironmentReleaseGateRow> = { ready, pending };

    await sweepReleaseGates(
      baseDeps({
        prepareCheckout,
        loadConfig: async () => configWith('prod'),
        isEnvironmentDeployable: () => true,
        listActiveReleaseGates: () => [ready, pending],
        getReleaseGate: (_p, id) => byId[id] ?? null,
        resolvers: completeResolvers(['s1'], []), // s2 pending
        triggerDeployment,
        markReleaseGateFired,
      }),
    );

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    expect(markReleaseGateFired).toHaveBeenCalledWith(PROJECT.id, 'ready', 'dep-1');
  });
});

describe('initReleaseGates', () => {
  it('registers a single minute-cadence sweep task', () => {
    const { calls, scheduleFn } = makeScheduleFn();
    initReleaseGates(baseDeps({ scheduleFn, listActiveReleaseGates: () => [] }));
    expect(isReleaseGateSweepRegistered()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cron).toBe('* * * * *');
    stopReleaseGates();
    expect(isReleaseGateSweepRegistered()).toBe(false);
    expect(calls[0]!.stop).toHaveBeenCalled();
  });

  it('re-init stops the prior task (idempotent re-sync)', () => {
    const { calls, scheduleFn } = makeScheduleFn();
    initReleaseGates(baseDeps({ scheduleFn }));
    initReleaseGates(baseDeps({ scheduleFn }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.stop).toHaveBeenCalled();
  });
});
