/**
 * Mainline deploy watcher against the real session row and deployments table.
 * The orchestrator is faked: it only writes the deployment row the way the
 * real `triggerDeployment` does (landing key + plan snapshot in meta).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts } from './db.js';
import { wipeTables } from './test/destructive-db.js';
import type { DeploymentRow, Project } from './types.js';
import {
  AUTOPILOT_DEPLOY_TRIGGER,
  MAINLINE_DEPLOY_ESCALATE_AFTER_MS,
  createMainlineDeployWatcher,
  mainlineDeployBackoffMs,
  type MainlineDeployWatcherDeps,
} from './autopilot-mainline-deploy-watcher.js';
import type { AutopilotRowStmts } from './session-autopilot-slot.js';
import {
  type AutopilotSessionConfig,
  parseAutopilotSessionConfig,
} from '../shared/utils/sessionAutopilot.js';
import {
  type MainlineSlot,
  idleMainlineSlot,
  mainlineLandingKey,
} from '../shared/utils/autopilotMainlineSlot.js';
import {
  createDeployment,
  getDeployment,
  listDeploymentsByLandingKey,
  updateDeploymentStatus,
} from './deploy/deployment-store.js';
import {
  EnvironmentBusyError,
  LOCK_RACE_CANCEL_ERROR,
  type TriggerDeploymentInput,
} from './deploy/deploy-orchestrator.js';

const PROJECT_ID = 'proj-mainline-watcher';
const SHA = 'a'.repeat(40);
const ATTEMPT = 'attempt-1';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const OWNER = 'user-owner-1';

const DEPLOY_YAML = `version: 1
environments:
  prod:
    origin: https://prod.example.com
    readiness: /healthz
    steps:
      - name: ship
        run: echo ship
`;

const project = { id: PROJECT_ID, name: 'Mainline', cwd: '/tmp/none' } as unknown as Project;

function landedConfig(slot: Partial<MainlineSlot> = {}): AutopilotSessionConfig {
  return {
    durationHours: 0,
    brief: 'Ship it',
    goal: 'Live and healthy',
    escalation: 'medium',
    branch: 'main',
    startedAt: new Date(T0).toISOString(),
    deadlineAt: null,
    status: 'running',
    cycle: 0,
    lastPushSha: null,
    target: 'mainline',
    mainline: {
      deployEnvironment: 'prod',
      landedCount: 1,
      slot: {
        ...idleMainlineSlot(),
        phase: 'landed',
        attemptId: ATTEMPT,
        sha: SHA,
        enteredAt: new Date(T0).toISOString(),
        ...slot,
      },
    },
  };
}

let seq = 0;
function seedSession(cfg: AutopilotSessionConfig): string {
  const stmts = getStmts();
  const id = `ml-watch-${++seq}-${Date.now()}`;
  stmts.createSession.run(id, 'agent-ml', 'Autopilot', 'claude-code', 'test', 1, 0, 1);
  stmts.updateSessionMode.run('autopilot', id);
  stmts.updateSessionAutopilotConfig.run(JSON.stringify(cfg), id);
  getDb().prepare('UPDATE sessions SET owner_user_id = ? WHERE id = ?').run(OWNER, id);
  return id;
}

function storedSlot(id: string): MainlineSlot {
  const row = getStmts().getSession.get(id) as { autopilot_session_config: string | null };
  return parseAutopilotSessionConfig(row.autopilot_session_config)!.mainline!.slot;
}

/** Creates the row the way the real orchestrator does, then returns it. */
function writeDeploymentRow(input: TriggerDeploymentInput): DeploymentRow {
  return createDeployment({
    projectId: input.projectId,
    environment: input.environment,
    ref: input.ref,
    trigger: input.trigger,
    triggeredBy: input.triggeredBy ?? null,
    status: 'pending',
    meta: {
      ...(input.meta as Record<string, unknown>),
      agentHubDeploymentPlan: {
        version: 1,
        worktreePath: input.worktreePath,
        environment: {
          name: input.environment,
          approval: false,
          runsOn: 'host',
          timeoutMinutes: 60,
          origin: 'https://prod.example.com',
          readiness: 'https://prod.example.com/healthz',
          steps: [{ name: 'ship', run: 'echo ship' }],
        },
      },
    },
  });
}

interface Harness {
  deps: MainlineDeployWatcherDeps;
  clock: { now: number };
  notices: Array<{ sessionId: string; content: string }>;
  trigger: ReturnType<typeof vi.fn>;
  /** While true, every autopilot CAS write reports zero rows changed. */
  failCas: { value: boolean };
}

function harness(overrides: Partial<MainlineDeployWatcherDeps> = {}): Harness {
  const real = getStmts();
  const failCas = { value: false };
  const stmts: AutopilotRowStmts = {
    getSession: real.getSession,
    casSessionAutopilotConfig: {
      run: (...args: [string, string, string | null]) =>
        failCas.value
          ? { changes: 0, lastInsertRowid: 0 }
          : real.casSessionAutopilotConfig.run(...args),
    } as unknown as AutopilotRowStmts['casSessionAutopilotConfig'],
  };
  const clock = { now: T0 };
  const notices: Array<{ sessionId: string; content: string }> = [];
  const trigger = vi.fn(async (input: TriggerDeploymentInput) => writeDeploymentRow(input));
  const deps: MainlineDeployWatcherDeps = {
    stmts,
    listCandidates: () =>
      getDb()
        .prepare(
          `SELECT id, agent_id, owner_user_id FROM sessions WHERE autopilot_session_config LIKE '%mainline%'`,
        )
        .all() as never,
    findProjectForAgent: () => project,
    readDeployYamlAtCommit: async () => ({ kind: 'present', raw: DEPLOY_YAML }),
    isEnvironmentDeployable: () => true,
    prepareCheckout: async () => ({ worktreePath: '/tmp/ml-watch-checkout', resolvedRef: SHA }),
    triggerDeployment: trigger,
    listDeploymentsByLandingKey,
    getDeployment,
    postNotice: (sessionId, content) => notices.push({ sessionId, content }),
    now: () => clock.now,
    log: () => {},
    ...overrides,
  };
  return { deps, clock, notices, trigger, failCas };
}

beforeEach(() => {
  wipeTables(getDb(), ['deployment_steps', 'deployments', 'deployment_environments']);
  getDb().prepare(`DELETE FROM sessions WHERE agent_id = 'agent-ml'`).run();
});

describe('mainline deploy watcher: landed → deploying → reporting', () => {
  it('creates one deployment carrying the landing key, attributed to the session owner', async () => {
    const h = harness();
    const id = seedSession(landedConfig());
    const watcher = createMainlineDeployWatcher(h.deps);

    await watcher.sweep();

    expect(h.trigger).toHaveBeenCalledTimes(1);
    const input = h.trigger.mock.calls[0][0] as TriggerDeploymentInput;
    expect(input).toMatchObject({
      projectId: PROJECT_ID,
      environment: 'prod',
      ref: SHA,
      trigger: AUTOPILOT_DEPLOY_TRIGGER,
      triggeredBy: OWNER,
      sessionId: id,
      deferRun: true,
      cleanupWorktreeOnTerminal: true,
    });
    const key = mainlineLandingKey(id, ATTEMPT);
    expect((input.meta as Record<string, unknown>).autopilotLandingKey).toBe(key);
    const rows = listDeploymentsByLandingKey(PROJECT_ID, key);
    expect(rows).toHaveLength(1);
    const slot = storedSlot(id);
    expect(slot.phase).toBe('deploying');
    expect(slot.deploymentId).toBe(rows[0].id);
    expect(h.notices.map((n) => n.content)).toEqual([
      expect.stringContaining('Autopilot is deploying aaaaaaa to prod'),
    ]);
  });

  it('adopts the original deployment after its deploymentId write was lost, even once it is terminal', async () => {
    const h = harness();
    h.trigger.mockImplementationOnce(async (input: TriggerDeploymentInput) => {
      const row = writeDeploymentRow(input);
      h.failCas.value = true; // the deploying write that follows is lost
      return row;
    });
    const id = seedSession(landedConfig());
    const watcher = createMainlineDeployWatcher(h.deps);

    await watcher.sweep();
    expect(storedSlot(id).phase).toBe('landed');
    const key = mainlineLandingKey(id, ATTEMPT);
    const [original] = listDeploymentsByLandingKey(PROJECT_ID, key);
    expect(original).toBeDefined();

    // The original deploy runs to completion while the slot still says landed.
    h.failCas.value = false;
    updateDeploymentStatus(original.id, 'success');

    // The refused write backed off like any other failure; inside the window
    // nothing happens.
    await watcher.sweep();
    expect(storedSlot(id).phase).toBe('landed');

    h.clock.now = T0 + 15_000;
    await watcher.sweep();

    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(listDeploymentsByLandingKey(PROJECT_ID, key)).toHaveLength(1);
    const slot = storedSlot(id);
    expect(slot.phase).toBe('reporting');
    expect(slot.deploymentId).toBe(original.id);
    expect(slot.outcome).toEqual({
      status: 'succeeded',
      detail: null,
      origin: 'https://prod.example.com',
      readiness: 'https://prod.example.com/healthz',
    });
    expect(h.notices.at(-1)?.content).toContain('resumed tracking');
  });

  it('records a failed terminal deploy as the outcome with its error', async () => {
    const h = harness();
    const id = seedSession(landedConfig());
    const watcher = createMainlineDeployWatcher(h.deps);
    await watcher.sweep();
    const slot = storedSlot(id);
    updateDeploymentStatus(slot.deploymentId!, 'error', { error: 'step ship exited 1' });

    await watcher.sweep();

    expect(storedSlot(id).outcome).toMatchObject({
      status: 'failed',
      detail: 'step ship exited 1',
      origin: 'https://prod.example.com',
    });
  });

  it('waits on a non-terminal deployment and reports missing when the row is gone', async () => {
    const h = harness();
    const id = seedSession(landedConfig());
    const watcher = createMainlineDeployWatcher(h.deps);
    await watcher.sweep();
    const { deploymentId } = storedSlot(id);
    updateDeploymentStatus(deploymentId!, 'running');
    await watcher.sweep();
    expect(storedSlot(id).phase).toBe('deploying');

    getDb().prepare('DELETE FROM deployments WHERE id = ?').run(deploymentId);
    await watcher.sweep();
    expect(storedSlot(id)).toMatchObject({ phase: 'reporting', outcome: { status: 'missing' } });
  });

  it('finishes an owed deploy for a stopped, mode-switched, archived session', async () => {
    const h = harness();
    const id = seedSession({ ...landedConfig(), status: 'expired' });
    getStmts().updateSessionMode.run('chat', id);
    getDb().prepare(`UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?`).run(id);
    const watcher = createMainlineDeployWatcher(h.deps);

    await watcher.sweep();

    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(storedSlot(id).phase).toBe('deploying');
  });
});

describe('mainline deploy watcher: busy lock and retries', () => {
  it('backs off on a busy environment, retries, and escalates once after an hour without clearing', async () => {
    const h = harness();
    h.trigger.mockImplementation(async () => {
      throw new EnvironmentBusyError('other-deploy');
    });
    const id = seedSession(landedConfig());
    const key = mainlineLandingKey(id, ATTEMPT);
    const watcher = createMainlineDeployWatcher(h.deps);

    await watcher.sweep();
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(watcher.backoffFor(key)).toEqual({ failures: 1, nextAt: T0 + 15_000 });

    // Inside the backoff window nothing is attempted.
    h.clock.now = T0 + 14_000;
    await watcher.sweep();
    expect(h.trigger).toHaveBeenCalledTimes(1);

    h.clock.now = T0 + 15_000;
    await watcher.sweep();
    expect(h.trigger).toHaveBeenCalledTimes(2);
    expect(watcher.backoffFor(key)?.failures).toBe(2);
    expect(storedSlot(id)).toMatchObject({ phase: 'landed', escalatedAt: null });

    h.clock.now = T0 + MAINLINE_DEPLOY_ESCALATE_AFTER_MS + 1;
    await watcher.sweep();
    h.clock.now += MAINLINE_DEPLOY_ESCALATE_AFTER_MS;
    await watcher.sweep();

    const slot = storedSlot(id);
    expect(slot.phase).toBe('landed');
    expect(slot.attemptId).toBe(ATTEMPT);
    expect(slot.escalatedAt).not.toBeNull();
    expect(h.notices.filter((n) => n.content.includes('over an hour'))).toHaveLength(1);

    // Once the lock frees, the same landing deploys.
    h.trigger.mockImplementation(async (input: TriggerDeploymentInput) =>
      writeDeploymentRow(input),
    );
    h.clock.now += MAINLINE_DEPLOY_ESCALATE_AFTER_MS;
    await watcher.sweep();
    expect(storedSlot(id).phase).toBe('deploying');
  });

  it('does not adopt a row that lost the lock race; it starts a fresh deploy later', async () => {
    const h = harness();
    h.trigger.mockImplementationOnce(async (input: TriggerDeploymentInput) => {
      const row = writeDeploymentRow(input);
      updateDeploymentStatus(row.id, 'cancelled', { error: LOCK_RACE_CANCEL_ERROR });
      throw new EnvironmentBusyError('winner');
    });
    const id = seedSession(landedConfig());
    const key = mainlineLandingKey(id, ATTEMPT);
    const watcher = createMainlineDeployWatcher(h.deps);

    await watcher.sweep();
    expect(storedSlot(id).phase).toBe('landed');

    h.clock.now = T0 + 15_000;
    await watcher.sweep();

    expect(h.trigger).toHaveBeenCalledTimes(2);
    const rows = listDeploymentsByLandingKey(PROJECT_ID, key);
    expect(rows).toHaveLength(2);
    expect(storedSlot(id).deploymentId).toBe(rows[1].id);
  });

  it('adopts a row created before the start threw (the error follows the row)', async () => {
    const h = harness();
    h.trigger.mockImplementationOnce(async (input: TriggerDeploymentInput) => {
      const row = writeDeploymentRow(input);
      updateDeploymentStatus(row.id, 'error', { error: 'runner acquire failed' });
      throw new Error('runner acquire failed');
    });
    const id = seedSession(landedConfig());
    const watcher = createMainlineDeployWatcher(h.deps);

    await watcher.sweep();
    await watcher.sweep();

    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(storedSlot(id).outcome).toMatchObject({
      status: 'failed',
      detail: 'runner acquire failed',
    });
  });

  it.each([
    [
      'deploy.yaml missing at the commit',
      { readDeployYamlAtCommit: async () => ({ kind: 'absent' }) },
      'No .agent-hub/deploy.yaml',
    ],
    [
      'deploy.yaml invalid at the commit',
      { readDeployYamlAtCommit: async () => ({ kind: 'present', raw: 'version: 9\n' }) },
      'is invalid',
    ],
    [
      'environment not declared at the commit',
      {
        readDeployYamlAtCommit: async () => ({
          kind: 'present',
          raw: DEPLOY_YAML.replace('  prod:', '  staging:'),
        }),
      },
      'does not declare environment "prod"',
    ],
  ] as const)(
    '%s is final: undeployable outcome, nothing deployed',
    async (_label, override, detail) => {
      const h = harness(override as Partial<MainlineDeployWatcherDeps>);
      const id = seedSession(landedConfig());
      const watcher = createMainlineDeployWatcher(h.deps);

      await watcher.sweep();

      expect(h.trigger).not.toHaveBeenCalled();
      const slot = storedSlot(id);
      expect(slot.phase).toBe('reporting');
      expect(slot.outcome?.status).toBe('undeployable');
      expect(slot.outcome?.detail).toContain(detail);
    },
  );

  it.each([
    [
      'deploy.yaml read failed',
      {
        readDeployYamlAtCommit: async () => {
          throw new Error('Commit is not in the project workspace yet.');
        },
      },
    ],
    ['environment paused', { isEnvironmentDeployable: () => false }],
    [
      'checkout failed',
      {
        prepareCheckout: async () => {
          throw new Error('clone timed out');
        },
      },
    ],
    [
      'runner or I/O failure starting the deploy',
      {
        triggerDeployment: async () => {
          throw new Error('ENOSPC');
        },
      },
    ],
  ] as const)('%s is retryable: slot stays landed with a backoff', async (_label, override) => {
    const h = harness(override as Partial<MainlineDeployWatcherDeps>);
    const id = seedSession(landedConfig());
    const watcher = createMainlineDeployWatcher(h.deps);

    await watcher.sweep();

    expect(storedSlot(id)).toMatchObject({ phase: 'landed', attemptId: ATTEMPT, outcome: null });
    expect(watcher.backoffFor(mainlineLandingKey(id, ATTEMPT))?.failures).toBe(1);
  });

  it.each([
    [
      'environment state check throws',
      {
        isEnvironmentDeployable: () => {
          throw new Error('SQLITE_BUSY');
        },
      },
    ],
    [
      'project lookup throws',
      {
        findProjectForAgent: () => {
          throw new Error('projects.json unreadable');
        },
      },
    ],
    [
      'deploy.yaml parse dependency rejects synchronously',
      {
        readDeployYamlAtCommit: () => {
          throw new Error('spawn EMFILE');
        },
      },
    ],
  ] as const)(
    '%s repeatedly: backs off and escalates once after an hour, slot kept',
    async (_label, override) => {
      const h = harness(override as unknown as Partial<MainlineDeployWatcherDeps>);
      const id = seedSession(landedConfig());
      const key = mainlineLandingKey(id, ATTEMPT);
      const watcher = createMainlineDeployWatcher(h.deps);

      await watcher.sweep();
      expect(watcher.backoffFor(key)).toEqual({ failures: 1, nextAt: T0 + 15_000 });

      // Keep failing past the escalation threshold, sweeping every backoff.
      while (h.clock.now < T0 + 2 * MAINLINE_DEPLOY_ESCALATE_AFTER_MS) {
        h.clock.now = watcher.backoffFor(key)!.nextAt;
        await watcher.sweep();
      }

      const slot = storedSlot(id);
      expect(slot).toMatchObject({ phase: 'landed', attemptId: ATTEMPT, outcome: null });
      expect(slot.escalatedAt).not.toBeNull();
      expect(watcher.backoffFor(key)!.failures).toBeGreaterThan(5);
      expect(h.notices.filter((n) => n.content.includes('over an hour'))).toHaveLength(1);
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'project lookup throws',
      (fail: () => never) => ({ findProjectForAgent: vi.fn(fail) }),
      'findProjectForAgent',
    ],
    [
      'project is missing',
      () => ({ findProjectForAgent: vi.fn(() => null) }),
      'findProjectForAgent',
    ],
    [
      'landing-key lookup throws',
      (fail: () => never) => ({ listDeploymentsByLandingKey: vi.fn(fail) }),
      'listDeploymentsByLandingKey',
    ],
  ] as const)(
    '%s: the lookup is not repeated inside the backoff window',
    async (_label, make, dep) => {
      const fail = (): never => {
        throw new Error('lookup failed');
      };
      const overrides = make(fail) as Partial<MainlineDeployWatcherDeps>;
      const h = harness(overrides);
      const spy = overrides[dep as keyof MainlineDeployWatcherDeps] as ReturnType<typeof vi.fn>;
      const id = seedSession(landedConfig());
      const key = mainlineLandingKey(id, ATTEMPT);
      const watcher = createMainlineDeployWatcher(h.deps);

      await watcher.sweep();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(watcher.backoffFor(key)).toEqual({ failures: 1, nextAt: T0 + 15_000 });

      // Sweeps and kicks inside the window do nothing.
      h.clock.now = T0 + 14_999;
      await watcher.sweep();
      await watcher.sweep();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(watcher.backoffFor(key)?.failures).toBe(1);

      h.clock.now = T0 + 15_000;
      await watcher.sweep();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(watcher.backoffFor(key)).toEqual({ failures: 2, nextAt: T0 + 45_000 });
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );

  it('adopts an existing deployment once a failing landing-key lookup recovers', async () => {
    const lookup = vi
      .fn<MainlineDeployWatcherDeps['listDeploymentsByLandingKey']>()
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
      })
      .mockImplementation(listDeploymentsByLandingKey);
    const h = harness({ listDeploymentsByLandingKey: lookup });
    const id = seedSession(landedConfig());
    const original = writeDeploymentRow({
      projectId: PROJECT_ID,
      environment: 'prod',
      ref: SHA,
      worktreePath: '/tmp/x',
      config: {} as never,
      trigger: AUTOPILOT_DEPLOY_TRIGGER,
      meta: { autopilotLandingKey: mainlineLandingKey(id, ATTEMPT) },
    });
    const watcher = createMainlineDeployWatcher(h.deps);

    await watcher.sweep();
    expect(storedSlot(id).phase).toBe('landed');

    h.clock.now = T0 + 15_000;
    await watcher.sweep();

    expect(h.trigger).not.toHaveBeenCalled();
    expect(storedSlot(id)).toMatchObject({ phase: 'deploying', deploymentId: original.id });
  });

  it('caps the backoff between 15s and 10m', () => {
    expect(mainlineDeployBackoffMs(1)).toBe(15_000);
    expect(mainlineDeployBackoffMs(2)).toBe(30_000);
    expect(mainlineDeployBackoffMs(6)).toBe(480_000);
    expect(mainlineDeployBackoffMs(7)).toBe(600_000);
    expect(mainlineDeployBackoffMs(50)).toBe(600_000);
  });
});
