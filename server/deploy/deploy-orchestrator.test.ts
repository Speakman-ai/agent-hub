/**
 * deploy-orchestrator.ts — Phase 3 orchestrator.
 *
 * Exercised against the shared test DB (test/setup.ts) with a FAKE RunnerBackend
 * — no real CLI/container is ever spawned (the global guard would throw). The
 * fake lease's spawnStep drives an EventEmitter-backed child so the streaming /
 * exit-code logic runs end-to-end.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { EventEmitter, Readable } from 'stream';
import { getDb, getStmts } from '../db.js';
import {
  getDeploymentEnvironment,
  listDeploymentReleaseItems,
  listDeploymentSteps,
  listDeploymentApprovals,
  createDeployment,
  ensureDeploymentEnvironment,
  ensureDeploymentReleaseItem,
  acquireEnvironmentLock,
  setDeploymentReleaseItemInclusion,
} from './deployment-store.js';
import { parseDeployConfig } from './deploy-config.js';
import {
  approveDeployment,
  triggerDeployment,
  EnvironmentBusyError,
  type DeploymentApprovalError,
  type DeployOrchestratorDeps,
} from './deploy-orchestrator.js';
import type { SpawnedStep } from '../finalize/step-runner.js';
import type { JobClaimSpec, RunnerBackend, RunnerLease } from '../finalize/runner-backend.js';
import { createSupportTicket, getSupportTicket } from '../support-tickets-store.js';
import { addReleaseDigestRecipient } from '../release-notification-settings.js';
import { listReleaseNotificationOutboxByDeployment } from '../release-notification-outbox.js';

const PROJECT = 'proj-deploy-orch';
const OTHER_PROJECT = 'proj-deploy-other';
const WORKTREE = '/tmp/deploy-orch-fake';

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM release_notification_outbox;');
  db.exec('DELETE FROM deployment_release_items;');
  db.exec('DELETE FROM deployment_approvals;');
  db.exec('DELETE FROM deployment_steps;');
  db.exec('DELETE FROM deployments;');
  db.exec('DELETE FROM deployment_environments;');
  db.exec('DELETE FROM finalize_runs;');
  db.exec('DELETE FROM release_digest_recipients;');
  db.exec('DELETE FROM release_notification_settings;');
  db.exec('DELETE FROM support_tickets;');
  db.exec('DELETE FROM kanban_cards;');
  db.exec('DELETE FROM kanban_columns;');
  db.exec('DELETE FROM kanban_boards;');
});

const CONFIG = parseDeployConfig(`
version: 1
environments:
  dev:
    steps:
      - name: build
        run: ./build.sh
      - name: ship
        run: ./ship.sh
  prod:
    approval: true
    steps:
      - run: ./deploy-prod.sh
`);

const RELEASE_CONFIG = parseDeployConfig(`
version: 1
environments:
  production:
    steps:
      - run: ./deploy-prod.sh
`);

const REVIEW_RELEASE_CONFIG = parseDeployConfig(`
version: 1
environments:
  production:
    approval: true
    steps:
      - run: ./deploy-prod.sh
`);

/** A scripted fake child: per-step exit codes + optional output, in call order. */
interface StepScript {
  exitCode: number;
  stdout?: string;
  /** Never emit close — used to exercise the timeout path. */
  hang?: boolean;
}

interface FakeBackend {
  backend: RunnerBackend;
  acquireCalls: JobClaimSpec[];
  released: number;
  spawnArgs: Array<{ run: string; cwd: string; env: NodeJS.ProcessEnv | undefined }>;
  killed: NodeJS.Signals[];
}

function makeFakeBackend(
  scripts: StepScript[],
  opts: { acquireDelay?: Promise<void> } = {},
): FakeBackend {
  const acquireCalls: JobClaimSpec[] = [];
  const spawnArgs: Array<{ run: string; cwd: string; env: NodeJS.ProcessEnv | undefined }> = [];
  const killed: NodeJS.Signals[] = [];
  let released = 0;
  let stepIdx = 0;

  const lease: RunnerLease = {
    spawnStep({ step, cwd, env }) {
      const script = scripts[stepIdx++] ?? { exitCode: 0 };
      spawnArgs.push({ run: step.run, cwd, env });
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const emitter = new EventEmitter();
      const child: SpawnedStep = {
        stdout,
        stderr,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          emitter.on(event, listener as never);
          return child;
        },
        kill(signal?: NodeJS.Signals) {
          killed.push(signal ?? 'SIGTERM');
          // A killed (timed-out) child closes with null exit.
          setImmediate(() => emitter.emit('close', null));
          return true;
        },
      };
      // Drive output + close asynchronously so the consumer wires listeners first.
      setImmediate(() => {
        if (script.stdout) stdout.push(script.stdout);
        if (!script.hang) emitter.emit('close', script.exitCode);
      });
      return child;
    },
    async release() {
      released++;
    },
  };

  const backend: RunnerBackend = {
    kind: 'fake',
    async acquire(spec) {
      acquireCalls.push(spec);
      if (opts.acquireDelay) await opts.acquireDelay;
      return lease;
    },
  };

  return {
    backend,
    acquireCalls,
    get released() {
      return released;
    },
    spawnArgs,
    killed,
  };
}

function makeDeps(backend: RunnerBackend, broadcast = vi.fn()): DeployOrchestratorDeps {
  return { broadcast, runnerBackend: backend, env: { PATH: '/usr/bin' } };
}

function createLinkedCard(
  projectId: string,
  supportTicketId: string,
  opts: { prUrl?: string; sessionId?: string } = {},
): string {
  const stmts = getStmts();
  const boardId = `board-${randomUUID()}`;
  const columnId = `col-${randomUUID()}`;
  const cardId = `card-${randomUUID()}`;
  stmts.createKanbanBoard.run(boardId, projectId, 'Board', 'TST');
  stmts.createKanbanColumn.run(columnId, boardId, 'Done', 0, '#10B981');
  stmts.createKanbanCard.run(
    cardId,
    columnId,
    boardId,
    'Linked fix',
    '',
    'medium',
    null,
    null,
    opts.sessionId ?? null,
    null,
    'test',
    null,
    0,
  );
  stmts.linkKanbanCardSupportTicket.run(supportTicketId, supportTicketId, cardId);
  if (opts.prUrl) stmts.setCardPrUrl.run(opts.prUrl, cardId);
  return cardId;
}

function seedPushedFinalizeRun(input: {
  projectId: string;
  cardId: string;
  sessionId?: string | null;
  branch?: string;
  headSha: string;
  validatedHeadSha?: string | null;
  prUrl?: string | null;
}): string {
  const id = `run-${randomUUID()}`;
  getStmts().insertFinalizeRun.run(
    id,
    input.cardId,
    input.sessionId ?? null,
    input.projectId,
    input.branch ?? 'feature/test',
    input.headSha,
    `idem-${id}`,
    'ready_to_push',
    null,
    'ui_button',
    '/tmp/worktree',
    'user-1',
    'Agent Hub Dev',
    'dev@example.com',
    null,
    Date.now(),
    'full',
    null,
  );
  if (input.validatedHeadSha) {
    getDb()
      .prepare('UPDATE finalize_runs SET validated_head_sha = ? WHERE id = ?')
      .run(input.validatedHeadSha, id);
  }
  if (input.prUrl) getStmts().updateFinalizeRunPrUrl.run(input.prUrl, id);
  getStmts().markFinalizeRunPushed.run(id);
  return id;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for condition');
}

describe('triggerDeployment — happy path', () => {
  it('runs steps in order, marks success, records live ref, releases lock', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const broadcast = vi.fn();
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'sha-abc',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      makeDeps(fb.backend, broadcast),
    );

    expect(dep.status).toBe('success');
    expect(dep.started_at).toBeTruthy();
    expect(dep.completed_at).toBeTruthy();

    const steps = listDeploymentSteps(dep.id);
    expect(steps.map((s) => s.status)).toEqual(['success', 'success']);

    // Steps ran in declared order in the worktree.
    expect(fb.spawnArgs.map((s) => s.run)).toEqual(['./build.sh', './ship.sh']);
    expect(fb.spawnArgs.every((s) => s.cwd === WORKTREE)).toBe(true);

    // Live ref recorded; lock released (idle).
    const env = getDeploymentEnvironment(PROJECT, 'dev')!;
    expect(env.current_ref).toBe('sha-abc');
    expect(env.current_deployment_id).toBe(dep.id);
    expect(env.active_deployment_id).toBeNull();

    // Lease torn down; live progress broadcast.
    expect(fb.released).toBe(1);
    expect(
      broadcast.mock.calls.some(([m]) => (m as { type: string }).type === 'deployment_update'),
    ).toBe(true);
  });

  it('forces the unconstrained resource profile on the lease', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    await triggerDeployment(
      { projectId: PROJECT, environment: 'dev', ref: 'r1', worktreePath: WORKTREE, config: CONFIG },
      makeDeps(fb.backend),
    );
    expect(fb.acquireCalls).toHaveLength(1);
    expect(fb.acquireCalls[0].resourceProfile).toBe('unconstrained');
    expect(fb.acquireCalls[0].runId).toBeTruthy();
  });

  it('starts from a minimal allowlisted env — never the Hub process.env', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    // Source env carries an allowlisted var AND Hub-only secrets that must NOT
    // reach deploy commands.
    await triggerDeployment(
      { projectId: PROJECT, environment: 'dev', ref: 'r', worktreePath: WORKTREE, config: CONFIG },
      {
        broadcast: vi.fn(),
        runnerBackend: fb.backend,
        env: {
          PATH: '/usr/bin',
          AWS_SECRET_ACCESS_KEY: 'hub-infra-cred',
          STRIPE_API_KEY: 'sk_live_leak',
          OPENAI_API_KEY: 'sk-leak',
        },
      },
    );

    const spec = fb.acquireCalls[0];
    expect(spec.minimalEnv).toBe(true);
    // Allowlisted basics pass through…
    expect(spec.env?.PATH).toBe('/usr/bin');
    // …Hub-only credentials do NOT.
    expect(spec.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(spec.env?.STRIPE_API_KEY).toBeUndefined();
    expect(spec.env?.OPENAI_API_KEY).toBeUndefined();
    // The same minimal env reaches the step spawn (no Hub creds at exec time).
    expect(fb.spawnArgs[0].env?.STRIPE_API_KEY).toBeUndefined();
    expect(fb.spawnArgs[0].env?.PATH).toBe('/usr/bin');
  });

  it('survives a throwing broadcast — state + lock stay authoritative', async () => {
    // A flaky WebSocket fanout must NOT reject the deploy path or strand the lock.
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const broadcast = vi.fn(() => {
      throw new Error('ws fanout exploded');
    });
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'sha-ok',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      { broadcast, runnerBackend: fb.backend, env: { PATH: '/usr/bin' } },
    );

    // Deploy still ran to a terminal success despite every broadcast throwing.
    expect(dep.status).toBe('success');
    expect(listDeploymentSteps(dep.id).map((s) => s.status)).toEqual(['success', 'success']);
    // Live ref recorded; env lock released (not stranded by the broadcast failure).
    const env = getDeploymentEnvironment(PROJECT, 'dev')!;
    expect(env.current_ref).toBe('sha-ok');
    expect(env.active_deployment_id).toBeNull();
    expect(broadcast).toHaveBeenCalled(); // it WAS called (and threw), but was swallowed
  });
});

describe('triggerDeployment — GitHub auth of the triggering user', () => {
  it('injects the initiating user GitHub token into the deploy step env', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const resolveGithubToken = vi.fn(async () => 'ghu_user_token');
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'sha-gh',
        worktreePath: WORKTREE,
        config: CONFIG,
        triggeredBy: 'user-42',
      },
      {
        broadcast: vi.fn(),
        runnerBackend: fb.backend,
        env: { PATH: '/usr/bin' },
        resolveGithubToken,
      },
    );

    expect(dep.status).toBe('success');
    // Resolver was asked for the user who triggered the deploy.
    expect(resolveGithubToken).toHaveBeenCalledWith('user-42');
    // Token reaches both the lease spec env and the per-step spawn env so
    // `gh` / `git push` authenticate as that user inside the runner.
    const spec = fb.acquireCalls[0];
    expect(spec.env?.GH_TOKEN).toBe('ghu_user_token');
    expect(spec.env?.GITHUB_TOKEN).toBe('ghu_user_token');
    expect(fb.spawnArgs[0].env?.GH_TOKEN).toBe('ghu_user_token');
    // A process-scoped git credential helper for github.com is wired up.
    const keys = Object.keys(spec.env ?? {}).filter((k) => k.startsWith('GIT_CONFIG_KEY_'));
    const helperWired = keys.some((k) => spec.env?.[k] === 'credential.https://github.com.helper');
    expect(helperWired).toBe(true);
  });

  it('injects no GitHub token for a system/push-driven deploy (no triggeredBy)', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const resolveGithubToken = vi.fn(async () => 'ghu_should_not_be_used');
    await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'sha-sys',
        worktreePath: WORKTREE,
        config: CONFIG,
        // no triggeredBy → system-initiated; never borrow an arbitrary identity
      },
      {
        broadcast: vi.fn(),
        runnerBackend: fb.backend,
        env: { PATH: '/usr/bin' },
        resolveGithubToken,
      },
    );

    expect(resolveGithubToken).not.toHaveBeenCalled();
    expect(fb.acquireCalls[0].env?.GH_TOKEN).toBeUndefined();
    expect(fb.spawnArgs[0].env?.GH_TOKEN).toBeUndefined();
  });

  it('swallows a resolver failure — deploy still runs without a token', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const resolveGithubToken = vi.fn(async () => {
      throw new Error('orgs.db unreachable');
    });
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'sha-throw',
        worktreePath: WORKTREE,
        config: CONFIG,
        triggeredBy: 'user-99',
      },
      {
        broadcast: vi.fn(),
        runnerBackend: fb.backend,
        env: { PATH: '/usr/bin' },
        resolveGithubToken,
      },
    );

    expect(dep.status).toBe('success');
    expect(resolveGithubToken).toHaveBeenCalledWith('user-99');
    expect(fb.acquireCalls[0].env?.GH_TOKEN).toBeUndefined();
  });
});

describe('runDeployment — GH_REPO injection (self-hosted-forge gh targeting)', () => {
  it('injects the project GitHub repo as GH_REPO into the deploy step env', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const resolveProjectGithubRepo = vi.fn(() => 'Speakman-ai/agent-hub');
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'sha-ghrepo',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      {
        broadcast: vi.fn(),
        runnerBackend: fb.backend,
        env: { PATH: '/usr/bin' },
        resolveProjectGithubRepo,
      },
    );

    expect(dep.status).toBe('success');
    expect(resolveProjectGithubRepo).toHaveBeenCalledWith(PROJECT);
    // GH_REPO reaches the lease spec env AND the per-step spawn env so `gh`
    // targets GitHub even when the checkout's `origin` is the Hub git forge.
    expect(fb.acquireCalls[0].env?.GH_REPO).toBe('Speakman-ai/agent-hub');
    expect(fb.spawnArgs[0].env?.GH_REPO).toBe('Speakman-ai/agent-hub');
  });

  it('injects no GH_REPO when the project has no configured GitHub repo', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const resolveProjectGithubRepo = vi.fn(() => null);
    await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'sha-norepo',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      {
        broadcast: vi.fn(),
        runnerBackend: fb.backend,
        env: { PATH: '/usr/bin' },
        resolveProjectGithubRepo,
      },
    );

    expect(resolveProjectGithubRepo).toHaveBeenCalledWith(PROJECT);
    expect(fb.acquireCalls[0].env?.GH_REPO).toBeUndefined();
  });

  it('injects GH_REPO for a gated environment resumed via approveDeployment', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }]);
    const resolveProjectGithubRepo = vi.fn(() => 'Speakman-ai/agent-hub');
    const deps: DeployOrchestratorDeps = {
      broadcast: vi.fn(),
      runnerBackend: fb.backend,
      env: { PATH: '/usr/bin' },
      resolveProjectGithubRepo,
    };
    const gated = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'prod',
        ref: 'sha-gated',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      deps,
    );
    expect(gated.status).toBe('awaiting_approval');

    await approveDeployment(
      { deploymentId: gated.id, approverUserId: 'admin-1', approverRole: 'Admin' },
      deps,
    );

    expect(fb.acquireCalls[0].env?.GH_REPO).toBe('Speakman-ai/agent-hub');
  });
});

describe('triggerDeployment — failure', () => {
  it('fails fast on a non-zero step, skips the rest, marks error', async () => {
    const fb = makeFakeBackend([{ exitCode: 3, stdout: 'boom\n' }]);
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'sha-x',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      makeDeps(fb.backend),
    );

    expect(dep.status).toBe('error');
    expect(dep.error).toContain('build');
    const steps = listDeploymentSteps(dep.id);
    expect(steps[0].status).toBe('error');
    expect(steps[0].exit_code).toBe(3);
    expect(steps[0].error).toContain('boom');
    expect(steps[1].status).toBe('skipped'); // never ran

    // The second step's command never spawned.
    expect(fb.spawnArgs.map((s) => s.run)).toEqual(['./build.sh']);

    // No live ref recorded; lock released.
    const env = getDeploymentEnvironment(PROJECT, 'dev')!;
    expect(env.current_ref).toBeNull();
    expect(env.active_deployment_id).toBeNull();
    expect(fb.released).toBe(1);
  });

  it('marks error and releases the lock when the runner acquire fails', async () => {
    const broadcast = vi.fn();
    const backend: RunnerBackend = {
      kind: 'fake',
      async acquire() {
        throw new Error('no runner available');
      },
    };
    const dep = await triggerDeployment(
      { projectId: PROJECT, environment: 'dev', ref: 'r', worktreePath: WORKTREE, config: CONFIG },
      { broadcast, runnerBackend: backend, env: {} },
    );
    expect(dep.status).toBe('error');
    expect(dep.error).toContain('no runner available');
    expect(getDeploymentEnvironment(PROJECT, 'dev')!.active_deployment_id).toBeNull();
    // Step rows are terminalized, not left "waiting": first errored, rest skipped.
    const steps = listDeploymentSteps(dep.id);
    expect(steps[0].status).toBe('error');
    expect(steps[0].error).toContain('no runner available');
    expect(steps[1].status).toBe('skipped');
    expect(steps.every((s) => s.status !== 'pending')).toBe(true);
  });

  it('terminalizes step rows on an unsupported runs-on (no step left pending)', async () => {
    const badConfig = parseDeployConfig(`
version: 1
environments:
  dev:
    runs-on: definitely-not-a-runner
    steps:
      - run: ./a.sh
      - run: ./b.sh
`);
    const fb = makeFakeBackend([]);
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'r',
        worktreePath: WORKTREE,
        config: badConfig,
      },
      makeDeps(fb.backend),
    );
    expect(dep.status).toBe('error');
    expect(dep.error).toContain('unsupported runs-on');
    const steps = listDeploymentSteps(dep.id);
    expect(steps.map((s) => s.status)).toEqual(['error', 'skipped']);
    // Never reached the runner.
    expect(fb.acquireCalls).toHaveLength(0);
  });

  it('bounds retained step output for a newline-less stream (no unbounded buffer)', async () => {
    // A step that floods stdout with no newline must not retain the whole stream.
    const flood = 'x'.repeat(300_000);
    const fb = makeFakeBackend([{ exitCode: 1, stdout: flood }]);
    const dep = await triggerDeployment(
      { projectId: PROJECT, environment: 'dev', ref: 'r', worktreePath: WORKTREE, config: CONFIG },
      makeDeps(fb.backend),
    );
    expect(dep.status).toBe('error');
    const steps = listDeploymentSteps(dep.id);
    // The persisted error keeps only a bounded tail, far below the 300KB input.
    expect(steps[0].status).toBe('error');
    expect(steps[0].error!.length).toBeLessThan(100_000);
  });

  it('releases the lock when pre-lease setup throws AFTER the running transition', async () => {
    // Simulate `resolveRunnerBackend()` (or any setup step) throwing after the
    // deployment is marked `running`. A throwing getter trips inside the wrapped
    // setup region — before this was caught, the deploy would reject stuck at
    // `running` with the env lock held forever (every future deploy → 409).
    const broadcast = vi.fn();
    const deps: DeployOrchestratorDeps = {
      broadcast,
      env: {},
      get runnerBackend(): RunnerBackend {
        throw new Error('runner backend misconfigured');
      },
    };
    const dep = await triggerDeployment(
      { projectId: PROJECT, environment: 'dev', ref: 'r', worktreePath: WORKTREE, config: CONFIG },
      deps,
    );
    expect(dep.status).toBe('error');
    expect(dep.error).toContain('runner backend misconfigured');
    // Lock released — the env is NOT left busy.
    expect(getDeploymentEnvironment(PROJECT, 'dev')!.active_deployment_id).toBeNull();
  });
});

describe('triggerDeployment — concurrency lock', () => {
  it('rejects a trigger while another deploy holds the env lock', async () => {
    // Pre-seed an in-flight deploy holding the dev lock.
    ensureDeploymentEnvironment(PROJECT, 'dev');
    const inflight = createDeployment({
      projectId: PROJECT,
      environment: 'dev',
      ref: 'old',
      status: 'running',
    });
    expect(acquireEnvironmentLock(PROJECT, 'dev', inflight.id)).toBe(true);

    const fb = makeFakeBackend([{ exitCode: 0 }]);
    await expect(
      triggerDeployment(
        {
          projectId: PROJECT,
          environment: 'dev',
          ref: 'new',
          worktreePath: WORKTREE,
          config: CONFIG,
        },
        makeDeps(fb.backend),
      ),
    ).rejects.toBeInstanceOf(EnvironmentBusyError);

    // The rejected trigger never acquired a runner.
    expect(fb.acquireCalls).toHaveLength(0);
  });

  it('different environments deploy independently (lock is per-env)', async () => {
    ensureDeploymentEnvironment(PROJECT, 'dev');
    const inflight = createDeployment({
      projectId: PROJECT,
      environment: 'dev',
      ref: 'old',
      status: 'running',
    });
    acquireEnvironmentLock(PROJECT, 'dev', inflight.id);

    // prod is gated → parks awaiting_approval without running, but is NOT blocked
    // by dev's lock.
    const fb = makeFakeBackend([{ exitCode: 0 }]);
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'prod',
        ref: 'p1',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      makeDeps(fb.backend),
    );
    expect(dep.status).toBe('awaiting_approval');
  });
});

describe('triggerDeployment — gated environment', () => {
  it('parks at awaiting_approval, holds the lock, runs no steps', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }]);
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'prod',
        ref: 'p1',
        worktreePath: WORKTREE,
        config: CONFIG,
        triggeredBy: 'u1',
      },
      makeDeps(fb.backend),
    );

    expect(dep.status).toBe('awaiting_approval');
    expect(dep.started_at).toBeNull();
    // Steps registered (pending) but none executed.
    expect(listDeploymentSteps(dep.id).map((s) => s.status)).toEqual(['pending']);
    expect(fb.acquireCalls).toHaveLength(0);
    // Lock held by this deployment — env stays serialized.
    expect(getDeploymentEnvironment(PROJECT, 'prod')!.active_deployment_id).toBe(dep.id);
  });

  it('records Admin/Owner approval, then resumes and runs the parked deployment', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }]);
    const parked = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'prod',
        ref: 'prod-sha',
        worktreePath: WORKTREE,
        config: CONFIG,
        triggeredBy: 'admin-1',
      },
      makeDeps(fb.backend),
    );

    expect(parked.status).toBe('awaiting_approval');
    expect(fb.acquireCalls).toHaveLength(0);

    const approved = await approveDeployment(
      {
        deploymentId: parked.id,
        approverUserId: 'admin-1',
        approverRole: 'Admin',
        note: 'release approved',
      },
      makeDeps(fb.backend),
    );

    expect(approved.status).toBe('success');
    expect(approved.started_at).toBeTruthy();
    expect(approved.completed_at).toBeTruthy();
    expect(fb.spawnArgs.map((s) => s.run)).toEqual(['./deploy-prod.sh']);

    const approvals = listDeploymentApprovals(parked.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approver_user_id).toBe('admin-1');
    expect(approvals[0].approver_role).toBe('Admin');
    expect(approvals[0].decision).toBe('approved');
    expect(approvals[0].note).toBe('release approved');
    expect(approvals[0].created_at).toBeTruthy();

    const env = getDeploymentEnvironment(PROJECT, 'prod')!;
    expect(env.current_ref).toBe('prod-sha');
    expect(env.current_deployment_id).toBe(parked.id);
    expect(env.active_deployment_id).toBeNull();
  });

  it('allows the triggering Owner to self-approve v1 gated deploys', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }]);
    const parked = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'prod',
        ref: 'prod-self',
        worktreePath: WORKTREE,
        config: CONFIG,
        triggeredBy: 'owner-1',
      },
      makeDeps(fb.backend),
    );

    const approved = await approveDeployment(
      {
        deploymentId: parked.id,
        approverUserId: 'owner-1',
        approverRole: 'Owner',
      },
      makeDeps(fb.backend),
    );

    expect(approved.status).toBe('success');
    expect(listDeploymentApprovals(parked.id)[0].approver_user_id).toBe('owner-1');
  });

  it('resumes from the trigger-time plan, not a later deploy.yaml or checkout supplied at approval', async () => {
    const triggerConfig = parseDeployConfig(`
version: 1
environments:
  prod:
    approval: true
    steps:
      - name: original
        run: ./deploy-original.sh
`);
    const fb = makeFakeBackend([{ exitCode: 0 }]);
    const parked = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'prod',
        ref: 'prod-bound',
        worktreePath: '/tmp/original-worktree',
        config: triggerConfig,
      },
      makeDeps(fb.backend),
    );

    // Simulate a changed in-memory deploy.yaml after the deploy parked. Approval
    // must use the snapshot persisted with the deployment, not this newer plan.
    triggerConfig.environments.get('prod')!.steps[0] = {
      name: 'changed',
      run: './deploy-changed.sh',
    };

    const approved = await approveDeployment(
      {
        deploymentId: parked.id,
        approverUserId: 'admin-1',
        approverRole: 'Admin',
      },
      makeDeps(fb.backend),
    );

    expect(approved.status).toBe('success');
    expect(fb.spawnArgs.map((s) => s.run)).toEqual(['./deploy-original.sh']);
    expect(fb.spawnArgs.map((s) => s.cwd)).toEqual(['/tmp/original-worktree']);
  });

  it('allows only one concurrent approval caller to claim and run a parked deployment', async () => {
    let releaseAcquire!: () => void;
    const acquireDelay = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    const fb = makeFakeBackend([{ exitCode: 0 }], { acquireDelay });
    const parked = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'prod',
        ref: 'prod-race',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      makeDeps(fb.backend),
    );

    const first = approveDeployment(
      {
        deploymentId: parked.id,
        approverUserId: 'admin-1',
        approverRole: 'Admin',
      },
      makeDeps(fb.backend),
    );
    await waitFor(() => fb.acquireCalls.length === 1);

    await expect(
      approveDeployment(
        {
          deploymentId: parked.id,
          approverUserId: 'admin-2',
          approverRole: 'Owner',
        },
        makeDeps(fb.backend),
      ),
    ).rejects.toMatchObject({
      name: 'DeploymentApprovalError',
      reason: 'invalid_status',
    } satisfies Partial<DeploymentApprovalError>);

    expect(listDeploymentApprovals(parked.id).map((a) => a.approver_user_id)).toEqual(['admin-1']);
    expect(fb.acquireCalls).toHaveLength(1);

    releaseAcquire();
    await expect(first).resolves.toMatchObject({ status: 'success' });
    expect(listDeploymentApprovals(parked.id).map((a) => a.approver_user_id)).toEqual(['admin-1']);
  });

  it('rejects non-admin approval without recording approval or running steps', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }]);
    const parked = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'prod',
        ref: 'prod-no',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      makeDeps(fb.backend),
    );

    await expect(
      approveDeployment(
        {
          deploymentId: parked.id,
          approverUserId: 'user-1',
          approverRole: 'User',
        },
        makeDeps(fb.backend),
      ),
    ).rejects.toMatchObject({
      name: 'DeploymentApprovalError',
      reason: 'forbidden',
    } satisfies Partial<DeploymentApprovalError>);

    expect(listDeploymentApprovals(parked.id)).toHaveLength(0);
    expect(fb.acquireCalls).toHaveLength(0);
    expect(listDeploymentSteps(parked.id).map((s) => s.status)).toEqual(['pending']);
    expect(getDeploymentEnvironment(PROJECT, 'prod')!.active_deployment_id).toBe(parked.id);
  });

  it('approval:false runs immediately and records no approval rows', async () => {
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const dep = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'dev-direct',
        worktreePath: WORKTREE,
        config: CONFIG,
      },
      makeDeps(fb.backend),
    );

    expect(dep.status).toBe('success');
    expect(fb.spawnArgs.map((s) => s.run)).toEqual(['./build.sh', './ship.sh']);
    expect(listDeploymentApprovals(dep.id)).toHaveLength(0);
    expect(getDeploymentEnvironment(PROJECT, 'dev')!.active_deployment_id).toBeNull();
  });

  it('marks included project support tickets released only after production succeeds', async () => {
    const ticket = createSupportTicket({
      projectId: PROJECT,
      body: 'please notify me',
      reporterEmail: 'direct@example.com',
    });
    const cardTicket = createSupportTicket({
      projectId: PROJECT,
      body: 'linked through card',
      reporterEmail: 'card@example.com',
    });
    const cardId = createLinkedCard(PROJECT, cardTicket.id);
    addReleaseDigestRecipient({ projectId: PROJECT, email: 'digest@example.com' });
    const otherTicket = createSupportTicket({ projectId: OTHER_PROJECT, body: 'other direct' });
    const otherCardTicket = createSupportTicket({
      projectId: OTHER_PROJECT,
      body: 'other card',
    });
    const otherCardId = createLinkedCard(OTHER_PROJECT, otherCardTicket.id);
    const devBackend = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);

    const dev = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'dev',
        ref: 'dev-sha',
        worktreePath: WORKTREE,
        config: CONFIG,
        meta: { cardIds: [cardId, otherCardId], supportTicketIds: [ticket.id, otherTicket.id] },
      },
      makeDeps(devBackend.backend),
    );
    expect(getSupportTicket(ticket.id)!.released_to_prod_at).toBeNull();
    expect(getSupportTicket(cardTicket.id)!.released_to_prod_at).toBeNull();
    expect(getSupportTicket(otherTicket.id)!.released_to_prod_at).toBeNull();
    expect(getSupportTicket(otherCardTicket.id)!.released_to_prod_at).toBeNull();
    expect(listDeploymentReleaseItems(dev.id)).toEqual([]);

    const prodBackend = makeFakeBackend([{ exitCode: 0 }]);
    const broadcast = vi.fn();
    const prod = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'production',
        ref: 'prod-sha',
        worktreePath: WORKTREE,
        config: RELEASE_CONFIG,
        meta: { cardIds: [cardId, otherCardId], supportTicketIds: [ticket.id, otherTicket.id] },
      },
      makeDeps(prodBackend.backend, broadcast),
    );

    const released = getSupportTicket(ticket.id)!;
    const cardReleased = getSupportTicket(cardTicket.id)!;
    expect(prod.status).toBe('success');
    expect(released.fixed_at).toBeTruthy();
    expect(released.released_to_prod_at).toBeTruthy();
    expect(released.release_deployment_id).toBe(prod.id);
    expect(released.customer_notified_at).toBeNull();
    expect(cardReleased.release_deployment_id).toBe(prod.id);
    expect(getSupportTicket(otherTicket.id)!.released_to_prod_at).toBeNull();
    expect(getSupportTicket(otherCardTicket.id)!.released_to_prod_at).toBeNull();
    expect(
      listDeploymentReleaseItems(prod.id).map((item) => ({
        card_id: item.card_id,
        support_ticket_id: item.support_ticket_id,
      })),
    ).toEqual([{ card_id: cardId, support_ticket_id: cardTicket.id }]);
    const outboxRows = listReleaseNotificationOutboxByDeployment(prod.id);
    expect(outboxRows.map((row) => row.notification_type).sort()).toEqual([
      'release_digest',
      'ticket_release',
    ]);
    expect(outboxRows.find((row) => row.notification_type === 'ticket_release')).toMatchObject({
      recipient_email: 'card@example.com',
      support_ticket_id: cardTicket.id,
      status: 'pending',
      attempts: 0,
    });
    expect(outboxRows.find((row) => row.notification_type === 'release_digest')).toMatchObject({
      recipient_email: 'digest@example.com',
      support_ticket_id: null,
      status: 'pending',
      attempts: 0,
    });
    const releaseBroadcasts = broadcast.mock.calls
      .map(([msg]) => msg as { type?: string; ticket?: { id?: string; release_state?: string } })
      .filter((msg) => msg.type === 'support_ticket_updated');
    expect(releaseBroadcasts.map((msg) => msg.ticket?.id).sort()).toEqual(
      [ticket.id, cardTicket.id].sort(),
    );
    expect(releaseBroadcasts.every((msg) => msg.ticket?.release_state === 'released_to_prod')).toBe(
      true,
    );
  });

  it('derives release items from pushed Finalize metadata when explicit links are partial', async () => {
    const ticket = createSupportTicket({ projectId: PROJECT, body: 'fixed through finalize' });
    const cardId = createLinkedCard(PROJECT, ticket.id, {
      sessionId: 'session-finalize',
      prUrl: 'https://github.example/acme/app/pull/42',
    });
    seedPushedFinalizeRun({
      projectId: PROJECT,
      cardId,
      sessionId: 'session-finalize',
      branch: 'feature/release-candidate',
      headSha: 'prod-ref-sha',
      prUrl: 'https://github.example/acme/app/pull/42',
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const prod = await triggerDeployment(
        {
          projectId: PROJECT,
          environment: 'production',
          ref: 'prod-ref-sha',
          worktreePath: WORKTREE,
          config: RELEASE_CONFIG,
          meta: {
            cardIds: ['missing-card'],
            prUrls: ['https://github.example/acme/app/pull/42'],
          },
        },
        makeDeps(makeFakeBackend([{ exitCode: 0 }]).backend),
      );

      expect(prod.status).toBe('success');
      expect(listDeploymentReleaseItems(prod.id).map((item) => item.card_id)).toEqual([cardId]);
      expect(getSupportTicket(ticket.id)!.release_deployment_id).toBe(prod.id);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('missingExplicitCards=1'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining(`deployment=${prod.id}`));
    } finally {
      info.mockRestore();
    }
  });

  it('derives release items when the production deploy ref is a Finalize branch name', async () => {
    const ticket = createSupportTicket({ projectId: PROJECT, body: 'fixed from branch deploy' });
    const cardId = createLinkedCard(PROJECT, ticket.id, { sessionId: 'session-branch' });
    seedPushedFinalizeRun({
      projectId: PROJECT,
      cardId,
      sessionId: 'session-branch',
      branch: 'feature/release-candidate',
      headSha: 'branch-head-sha',
    });

    const prod = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'production',
        ref: 'feature/release-candidate',
        worktreePath: WORKTREE,
        config: RELEASE_CONFIG,
      },
      makeDeps(makeFakeBackend([{ exitCode: 0 }]).backend),
    );

    expect(prod.status).toBe('success');
    expect(listDeploymentReleaseItems(prod.id).map((item) => item.card_id)).toEqual([cardId]);
    expect(getSupportTicket(ticket.id)!.release_deployment_id).toBe(prod.id);
  });

  it('uses adjusted deployment release items as the final production inclusion set', async () => {
    const includedTicket = createSupportTicket({ projectId: PROJECT, body: 'ship this' });
    const excludedTicket = createSupportTicket({ projectId: PROJECT, body: 'not this one' });
    const untouchedTicket = createSupportTicket({ projectId: PROJECT, body: 'auto-resolved card' });
    const directTicket = createSupportTicket({ projectId: PROJECT, body: 'direct ticket include' });
    const includedCardId = createLinkedCard(PROJECT, includedTicket.id);
    const excludedCardId = createLinkedCard(PROJECT, excludedTicket.id);
    const untouchedCardId = createLinkedCard(PROJECT, untouchedTicket.id);
    const fb = makeFakeBackend([{ exitCode: 0 }]);

    const parked = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'production',
        ref: 'prod-sha',
        worktreePath: WORKTREE,
        config: REVIEW_RELEASE_CONFIG,
        meta: {
          cardIds: [includedCardId, excludedCardId, untouchedCardId],
          supportTicketIds: [directTicket.id, excludedTicket.id],
        },
      },
      makeDeps(fb.backend),
    );
    expect(parked.status).toBe('awaiting_approval');

    ensureDeploymentReleaseItem({ deploymentId: parked.id, cardId: includedCardId });
    setDeploymentReleaseItemInclusion({
      deploymentId: parked.id,
      cardId: excludedCardId,
      inclusionStatus: 'excluded',
      adjustedBy: 'user-1',
      note: 'internal-only change',
      meta: { source: 'test' },
    });

    const broadcast = vi.fn();
    const approved = await approveDeployment(
      {
        deploymentId: parked.id,
        approverUserId: 'user-1',
        approverRole: 'Admin',
      },
      makeDeps(fb.backend, broadcast),
    );

    expect(approved.status).toBe('success');
    expect(getSupportTicket(includedTicket.id)!.release_deployment_id).toBe(parked.id);
    expect(getSupportTicket(untouchedTicket.id)!.release_deployment_id).toBe(parked.id);
    expect(getSupportTicket(directTicket.id)!.release_deployment_id).toBe(parked.id);
    expect(getSupportTicket(excludedTicket.id)!.released_to_prod_at).toBeNull();
    expect(
      listDeploymentReleaseItems(parked.id)
        .map((item) => ({ cardId: item.card_id, inclusionStatus: item.inclusion_status }))
        .sort((a, b) => String(a.cardId).localeCompare(String(b.cardId))),
    ).toEqual(
      [
        { cardId: excludedCardId, inclusionStatus: 'excluded' },
        { cardId: includedCardId, inclusionStatus: 'included' },
        { cardId: untouchedCardId, inclusionStatus: 'included' },
      ].sort((a, b) => a.cardId.localeCompare(b.cardId)),
    );
    const releasedTicketIds = broadcast.mock.calls
      .map(([msg]) => msg as { type?: string; ticket?: { id?: string } })
      .filter((msg) => msg.type === 'support_ticket_updated')
      .map((msg) => msg.ticket?.id);
    expect(releasedTicketIds).toContain(includedTicket.id);
    expect(releasedTicketIds).toContain(untouchedTicket.id);
    expect(releasedTicketIds).toContain(directTicket.id);
    expect(releasedTicketIds).not.toContain(excludedTicket.id);
  });

  it('does not release explicit support tickets linked to excluded cards', async () => {
    const excludedTicket = createSupportTicket({ projectId: PROJECT, body: 'do not ship' });
    const excludedCardId = createLinkedCard(PROJECT, excludedTicket.id);
    getDb()
      .prepare(
        `UPDATE kanban_columns
            SET name = 'In Progress'
          WHERE id = (SELECT column_id FROM kanban_cards WHERE id = ?)`,
      )
      .run(excludedCardId);
    const fb = makeFakeBackend([{ exitCode: 0 }]);

    const parked = await triggerDeployment(
      {
        projectId: PROJECT,
        environment: 'production',
        ref: 'prod-sha',
        worktreePath: WORKTREE,
        config: REVIEW_RELEASE_CONFIG,
        meta: { supportTicketIds: [excludedTicket.id] },
      },
      makeDeps(fb.backend),
    );
    expect(parked.status).toBe('awaiting_approval');

    setDeploymentReleaseItemInclusion({
      deploymentId: parked.id,
      cardId: excludedCardId,
      inclusionStatus: 'excluded',
      adjustedBy: 'user-1',
      note: 'not in this release',
      supportTicketId: null,
      meta: { source: 'test' },
    });

    const broadcast = vi.fn();
    const approved = await approveDeployment(
      {
        deploymentId: parked.id,
        approverUserId: 'user-1',
        approverRole: 'Admin',
      },
      makeDeps(fb.backend, broadcast),
    );

    expect(approved.status).toBe('success');
    expect(getSupportTicket(excludedTicket.id)!.released_to_prod_at).toBeNull();
    expect(getSupportTicket(excludedTicket.id)!.release_deployment_id).toBeNull();
    expect(
      listDeploymentReleaseItems(parked.id).find((item) => item.card_id === excludedCardId),
    ).toMatchObject({
      inclusion_status: 'excluded',
      support_ticket_id: null,
    });
    expect(
      broadcast.mock.calls.some(([msg]) => {
        const event = msg as { type?: string; ticket?: { id?: string } };
        return event.type === 'support_ticket_updated' && event.ticket?.id === excludedTicket.id;
      }),
    ).toBe(false);
  });
});

describe('triggerDeployment — unknown environment', () => {
  it('throws DeployConfigError(unknown_environment) before any DB write', async () => {
    const fb = makeFakeBackend([]);
    await expect(
      triggerDeployment(
        { projectId: PROJECT, environment: 'qa', ref: 'r', worktreePath: WORKTREE, config: CONFIG },
        makeDeps(fb.backend),
      ),
    ).rejects.toMatchObject({ reason: 'unknown_environment' });
  });
});

describe('triggerDeployment — timeout', () => {
  it('marks the deploy error and skips steps once the env budget is exhausted', async () => {
    // Advancing clock: the first call (deadline) reads 0, every later call
    // reads past the 60m budget, so the budget is already blown when the first
    // step is about to run — no real long timer, fully deterministic.
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 61 * 60_000);
    const fb = makeFakeBackend([{ exitCode: 0 }, { exitCode: 0 }]);
    const broadcast = vi.fn();
    const dep = await triggerDeployment(
      { projectId: PROJECT, environment: 'dev', ref: 'r', worktreePath: WORKTREE, config: CONFIG },
      { broadcast, runnerBackend: fb.backend, env: {}, now },
    );

    expect(dep.status).toBe('error');
    expect(dep.error).toMatch(/timed out/i);
    // No step ever spawned (budget blown before the first one).
    expect(fb.spawnArgs).toHaveLength(0);
    const steps = listDeploymentSteps(dep.id);
    expect(steps[0].status).toBe('error');
    expect(steps[1].status).toBe('skipped');
    expect(getDeploymentEnvironment(PROJECT, 'dev')!.active_deployment_id).toBeNull();
    expect(fb.released).toBe(1);
  });
});
