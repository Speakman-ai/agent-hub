/**
 * deploy-trigger-hook.ts — evaluate operator-configured deploy triggers when a
 * Hub-hosted repo branch moves, and enqueue the mapped environment's deployment.
 *
 * Locked epic decision `deploy-triggers`:
 *   Trigger = DB row `{environment, event(push|merge), branch pattern, enabled}`.
 *   Evaluated in the SAME `onPush` (smart-HTTP) + native-PR `afterMerge` hooks
 *   the security-audit push scan uses. A matching branch update enqueues a
 *   deployment (`trigger=push`) for the mapped environment, honoring the per-env
 *   concurrency lock; failures are logged and swallowed so a bad trigger never
 *   breaks the push/merge path. There is NO deploy.yaml trigger block — the
 *   store (`deployment-trigger-store.ts`) is the source of truth.
 *
 * Gating, in order:
 *   1. {@link findMatchingTriggers} — a cheap indexed query. No match ⇒ we never
 *      touch git (the common case for projects with no triggers configured).
 *   2. `deploy.yaml` must declare the environment AND the operator must not have
 *      paused it ({@link isEnvironmentDeployable}). A trigger for a removed or
 *      disabled environment is retained but never fires (decision
 *      `environments-config`).
 *   3. The per-environment concurrency lock inside {@link triggerDeployment}: a
 *      busy environment rejects with {@link EnvironmentBusyError}, which we treat
 *      as a normal skip.
 *
 * Both git events enqueue a deployment with `trigger: 'push'` and
 * `triggeredBy: null` (system-driven, no initiating user); the originating git
 * event (push|merge) is recorded in the deployment `meta` for audit.
 */
import path from 'path';
import { rm } from 'fs/promises';
import type { AppConfig, BroadcastFn, Project } from '../types.js';
import { resolveUserGithubToken } from '../auto-git.js';
import {
  triggerDeployment as defaultTriggerDeployment,
  EnvironmentBusyError,
  type DeployOrchestratorDeps,
} from './deploy-orchestrator.js';
import { DeployConfigError, loadDeployConfig, type DeployConfig } from './deploy-config.js';
import { prepareDeploymentCheckout } from './deployment-checkout.js';
import { isEnvironmentDeployable as defaultIsEnvironmentDeployable } from './deployment-env-config-store.js';
import {
  findMatchingTriggers as defaultFindMatchingTriggers,
  type DeployTriggerEvent,
} from './deployment-trigger-store.js';
import type { ReleaseDigestRunner } from '../release-digest.js';

type CheckoutResult = { worktreePath: string; resolvedRef: string };

export interface BuildDeployOrchestratorDepsInput {
  broadcast: BroadcastFn;
  config: AppConfig;
  findProject: (id: string) => Project | null | undefined;
  prepareCheckout: (args: { project: Project; ref: string }) => Promise<CheckoutResult>;
  releaseDigestRunner?: ReleaseDigestRunner;
  /** Test/route overrides layered over the defaults (matches the REST route). */
  overrides?: Partial<DeployOrchestratorDeps>;
}

/**
 * Build the {@link DeployOrchestratorDeps} shared by the REST trigger route and
 * the push/merge hook so the two paths never drift on GitHub-token / repo /
 * recovery-checkout / release-digest wiring. Each field mirrors the manual-deploy
 * route: an explicit override wins, otherwise the production default is used.
 */
export function buildDeployOrchestratorDeps({
  broadcast,
  config,
  findProject,
  prepareCheckout,
  releaseDigestRunner,
  overrides,
}: BuildDeployOrchestratorDepsInput): DeployOrchestratorDeps {
  return {
    broadcast,
    orgId: overrides?.orgId,
    runnerBackend: overrides?.runnerBackend,
    now: overrides?.now,
    env: overrides?.env,
    resolveGithubToken:
      overrides?.resolveGithubToken ?? ((userId: string) => resolveUserGithubToken(userId, config)),
    resolveProjectGithubRepo:
      overrides?.resolveProjectGithubRepo ??
      ((projectId: string) => findProject(projectId)?.githubRepo ?? null),
    prepareRecoveryCheckout:
      overrides?.prepareRecoveryCheckout ??
      (async ({ projectId, ref }) => {
        const project = findProject(projectId);
        if (!project) throw new Error(`Project not found: ${projectId}`);
        const checkout = await prepareCheckout({ project, ref });
        return { worktreePath: checkout.worktreePath, cleanupWorktreeOnTerminal: true };
      }),
    releaseDigestConfig: overrides?.releaseDigestConfig ?? config,
    releaseDigestRunner: overrides?.releaseDigestRunner ?? releaseDigestRunner,
  };
}

export interface DeployTriggerHookDeps {
  broadcast: BroadcastFn;
  config: AppConfig;
  findProject: (id: string) => Project | null | undefined;
  releaseDigestRunner?: ReleaseDigestRunner;
  /** Test seam — defaults to {@link prepareDeploymentCheckout}. */
  prepareCheckout?: (args: { project: Project; ref: string }) => Promise<CheckoutResult>;
  /** Test seam — defaults to {@link loadDeployConfig}. */
  loadConfig?: (deployYamlPath: string) => Promise<DeployConfig>;
  /** Test seam — defaults to {@link defaultTriggerDeployment}. */
  triggerDeployment?: typeof defaultTriggerDeployment;
  /** Test seam — defaults to {@link defaultFindMatchingTriggers}. */
  findMatchingTriggers?: typeof defaultFindMatchingTriggers;
  /** Test seam — defaults to {@link defaultIsEnvironmentDeployable}. */
  isEnvironmentDeployable?: typeof defaultIsEnvironmentDeployable;
  /** Orchestrator overrides (runner backend, clock, env, …) for tests. */
  orchestratorDeps?: Partial<DeployOrchestratorDeps>;
  /** Override for tests to capture log lines. */
  log?: (msg: string) => void;
}

/** Per-project serialization so two rapid pushes don't race the trigger setup. */
const queues = new Map<string, Promise<void>>();

function enqueue(projectId: string, work: () => Promise<void>): Promise<void> {
  const prior = queues.get(projectId) ?? Promise.resolve();
  const next = prior.then(work).catch((err: unknown) => {
    console.error(
      `[deploy-trigger] unexpected failure for ${projectId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  queues.set(projectId, next);
  void next.finally(() => {
    if (queues.get(projectId) === next) queues.delete(projectId);
  });
  return next;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function cleanupCheckout(checkout: CheckoutResult | null): Promise<void> {
  if (!checkout) return;
  try {
    await rm(checkout.worktreePath, { recursive: true, force: true });
  } catch {
    /* best-effort — a leaked temp dir is preferable to breaking the push path */
  }
}

/**
 * Evaluate deploy triggers for a set of updated refs and enqueue a deployment for
 * every mapped, deployable, non-busy environment. Fire-and-forget safe; returns
 * the chain tail so tests can await it. Never rejects — every failure is logged
 * and swallowed.
 */
export function maybeRunDeployTriggers(
  project: Project,
  event: DeployTriggerEvent,
  updatedRefs: string[],
  deps: DeployTriggerHookDeps,
): Promise<void> {
  const findMatching = deps.findMatchingTriggers ?? defaultFindMatchingTriggers;

  // Cheap indexed pre-check: map each matched environment to the branch that
  // fired it (first branch wins — two branches racing the same env would just
  // contend on the concurrency lock anyway). Nothing matched ⇒ no git work.
  const branches = [
    ...new Set(
      updatedRefs
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length)),
    ),
  ];
  const envToBranch = new Map<string, string>();
  for (const branch of branches) {
    for (const trigger of findMatching(project.id, event, branch)) {
      if (!envToBranch.has(trigger.environment_name)) {
        envToBranch.set(trigger.environment_name, branch);
      }
    }
  }
  if (envToBranch.size === 0) return Promise.resolve();

  return enqueue(project.id, () => runTriggeredDeployments(project, event, envToBranch, deps));
}

async function runTriggeredDeployments(
  project: Project,
  event: DeployTriggerEvent,
  envToBranch: Map<string, string>,
  deps: DeployTriggerHookDeps,
): Promise<void> {
  const prepareCheckout = deps.prepareCheckout ?? prepareDeploymentCheckout;
  const loadConfig = deps.loadConfig ?? loadDeployConfig;
  const trigger = deps.triggerDeployment ?? defaultTriggerDeployment;
  const isDeployable = deps.isEnvironmentDeployable ?? defaultIsEnvironmentDeployable;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const orchestratorDeps = buildDeployOrchestratorDeps({
    broadcast: deps.broadcast,
    config: deps.config,
    findProject: deps.findProject,
    prepareCheckout,
    releaseDigestRunner: deps.releaseDigestRunner,
    overrides: deps.orchestratorDeps,
  });

  // Group by branch so each branch's deploy.yaml is read exactly once.
  const branchToEnvs = new Map<string, string[]>();
  for (const [env, branch] of envToBranch) {
    const list = branchToEnvs.get(branch);
    if (list) list.push(env);
    else branchToEnvs.set(branch, [env]);
  }

  for (const [branch, envs] of branchToEnvs) {
    // One checkout reads the branch's deploy.yaml; it is then reused for the
    // first deployable environment (fresh checkouts for the rest).
    let configCheckout: CheckoutResult | null = null;
    let config: DeployConfig;
    try {
      configCheckout = await prepareCheckout({ project, ref: branch });
      config = await loadConfig(
        path.join(configCheckout.worktreePath, '.agent-hub', 'deploy.yaml'),
      );
    } catch (err) {
      await cleanupCheckout(configCheckout);
      // No deploy.yaml at this ref (or the branch vanished) ⇒ nothing to deploy.
      if (!(err instanceof DeployConfigError && err.reason === 'not_found')) {
        log(
          `[deploy-trigger] ${project.id} ${event}/${branch}: cannot load deploy.yaml: ${errMessage(err)}`,
        );
      }
      continue;
    }

    const declared = [...config.environments.keys()];
    // The config checkout is reused by the first environment that actually
    // deploys; a spare that no environment consumes is cleaned up at the end.
    let spare: CheckoutResult | null = configCheckout;
    for (const env of envs) {
      // environments-config: absent from deploy.yaml OR operator-paused ⇒ skip.
      if (!isDeployable(project.id, env, declared)) {
        log(
          `[deploy-trigger] ${project.id} ${event}/${branch}: env "${env}" not deployable — skipped`,
        );
        continue;
      }

      let checkout: CheckoutResult;
      try {
        checkout = spare ?? (await prepareCheckout({ project, ref: branch }));
        spare = null;
      } catch (err) {
        log(
          `[deploy-trigger] ${project.id} ${event}/${branch}: checkout failed for env "${env}": ${errMessage(err)}`,
        );
        continue;
      }

      try {
        const deployment = await trigger(
          {
            projectId: project.id,
            environment: env,
            ref: checkout.resolvedRef,
            worktreePath: checkout.worktreePath,
            config,
            trigger: 'push',
            triggeredBy: null,
            meta: { triggeredByEvent: event, branch },
            deferRun: true,
            cleanupWorktreeOnTerminal: true,
          },
          orchestratorDeps,
        );
        log(
          `[deploy-trigger] ${project.id} ${event}/${branch} → deploy env "${env}" (${deployment.id})`,
        );
      } catch (err) {
        // triggerDeployment only takes ownership of the worktree once the
        // deployment row exists; on ANY throw we still own it. cleanup is
        // idempotent, so a double free with the orchestrator's own cleanup
        // (lock-lost path) is harmless.
        await cleanupCheckout(checkout);
        if (err instanceof EnvironmentBusyError) {
          log(`[deploy-trigger] ${project.id} ${event}/${branch}: env "${env}" busy — skipped`);
        } else {
          log(
            `[deploy-trigger] ${project.id} ${event}/${branch}: deploy of env "${env}" failed: ${errMessage(err)}`,
          );
        }
      }
    }

    await cleanupCheckout(spare);
  }
}

/** Test seam: drop queued chains between tests. */
export function __clearDeployTriggerQueues(): void {
  queues.clear();
}
