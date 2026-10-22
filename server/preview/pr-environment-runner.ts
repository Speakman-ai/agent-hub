/**
 * Where a PR environment's compose stack runs.
 *
 *   - remote: an `environment` job on the runner fleet queue. The agent boots
 *     and holds the stack; the queue row (state + endpoint) is the durable
 *     record, so status survives a Hub restart.
 *   - local:  a DinD container on the Hub host (single-host and dev
 *     installs), driven by the same bring-up code the agent runs. Status is
 *     read back from docker after a restart.
 *
 * Both are addressed by an opaque `ref` stored as the row's `runner_ref`.
 */
import { execFile } from 'child_process';
import { rm } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import type { Project } from '../types.js';
import {
  ENVIRONMENT_GATEWAY_PORT,
  ENVIRONMENT_LABEL,
  ENVIRONMENT_READY_MARKER,
  buildEnvironmentTeardownCommand,
  environmentComposeEnv,
  environmentContainerName,
  runEnvironmentBringup,
  type RunnerEnvironmentSpec,
} from '../finalize/runner-environment.js';
import {
  CONTAINER_STOPPED_DURING_BRINGUP,
  containerConfirmedDown,
  createEnvironmentExec,
  realEnvironmentDockerOps,
  type EnvironmentDocker,
} from '../finalize/runner-agent-environment.js';
import { startJobContainer, type JobContainerOptions } from '../finalize/job-container.js';
import {
  cancelRunnerJob,
  enqueueRunnerJob,
  getRunnerJobStatus,
  readRunnerJobLogs,
} from '../finalize/runner-queue.js';
import { reconcileFleetCapacity } from '../finalize/runner-fleet-scaler.js';
import { resolveEnvironmentRunnerClass, resolveRunsOnImage } from '../finalize/runner-images.js';
import type { RunnerJobWireSpec } from '../finalize/runner-backend-remote.js';
import {
  createWorktreeBundle,
  worktreeBundleKey,
  type BundleStore,
  type WorktreeRef,
} from '../finalize/worktree-bundle.js';
import { prepareDeploymentCheckout } from '../deploy/deployment-checkout.js';
import { WORKSPACES_ROOT } from '../worktree.js';

const execFileAsync = promisify(execFile);

/** Image every environment runs in (the GitHub-parity Finalize runner image). */
export const ENVIRONMENT_RUNS_ON = 'ubuntu-24.04';

export type EnvironmentRunnerState =
  | 'pending' // waiting for a runner
  | 'starting' // bring-up in progress
  | 'ready'
  | 'failed' // bring-up failed (a config/app problem, not infra)
  | 'lost' // the runner or container died
  | 'stopped';

export interface EnvironmentUpstream {
  host: string;
  port: number;
}

export interface EnvironmentRunnerStatus {
  state: EnvironmentRunnerState;
  upstream: EnvironmentUpstream | null;
  detail: string | null;
}

export interface EnvironmentStartRequest {
  /** Unique per build; names the container and runner job. */
  key: string;
  orgId: string;
  project: Project;
  prNumber: number;
  headSha: string;
  spec: RunnerEnvironmentSpec;
  /** Resolved preview secrets. */
  env: Record<string, string>;
}

export interface EnvironmentRunner {
  readonly kind: 'local' | 'remote';
  /** Start (or enqueue) a build. Returns the ref to persist. */
  start(req: EnvironmentStartRequest): Promise<string>;
  status(ref: string): Promise<EnvironmentRunnerStatus>;
  /** Idempotent. Resolves once the stack is stopped or its stop is recorded. */
  stop(ref: string): Promise<void>;
  /** New log lines after `cursor`. */
  readLogs(ref: string, cursor: number): Promise<{ lines: string[]; cursor: number }>;
}

function splitLines(chunks: string[]): string[] {
  return chunks
    .join('')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);
}

// Remote (runner fleet)

export interface RemoteEnvironmentRunnerDeps {
  store: BundleStore | null;
  prepareCheckout?: typeof prepareDeploymentCheckout;
  createBundle?: typeof createWorktreeBundle;
  removeDir?: (dir: string) => Promise<void>;
  scale?: () => void;
  now?: () => number;
  image?: string;
}

export function createRemoteEnvironmentRunner(
  deps: RemoteEnvironmentRunnerDeps,
): EnvironmentRunner {
  const prepareCheckout = deps.prepareCheckout ?? prepareDeploymentCheckout;
  const createBundle = deps.createBundle ?? createWorktreeBundle;
  const removeDir = deps.removeDir ?? ((dir) => rm(dir, { recursive: true, force: true }));
  const scale = deps.scale ?? (() => void reconcileFleetCapacity());
  const now = deps.now ?? Date.now;

  return {
    kind: 'remote',
    async start(req) {
      const store = deps.store;
      if (!store) {
        throw new Error(
          'The runner fleet has no worktree store (set FINALIZE_WORKTREE_BUCKET or FINALIZE_RUNNER_BUNDLE_DIR), so a PR environment cannot ship its code.',
        );
      }
      const runId = `prenv-${req.key}`;
      const checkout = await prepareCheckout({ project: req.project, ref: req.headSha });
      let worktreeRef: WorktreeRef;
      try {
        const base = await createBundle({
          worktreePath: checkout.worktreePath,
          key: worktreeBundleKey(req.orgId, runId, req.headSha),
          store,
          rev: req.headSha,
        });
        const getUrl = store.presignGet ? await store.presignGet(base.key) : null;
        worktreeRef = getUrl ? { ...base, getUrl } : base;
      } finally {
        await removeDir(checkout.worktreePath).catch(() => {});
      }
      const image = deps.image ?? resolveRunsOnImage(ENVIRONMENT_RUNS_ON) ?? '';
      const wire: RunnerJobWireSpec = {
        orgId: req.orgId,
        projectId: req.project.id,
        runId,
        jobId: `pr-${req.prNumber}`,
        matrixKey: 'environment',
        image,
        runsOn: ENVIRONMENT_RUNS_ON,
        composeProjectName: req.spec.composeProject,
        env: req.env,
        // A PR environment is what testers click: run it at full host size,
        // not under the GitHub-parity gate caps.
        resourceProfile: 'unconstrained',
        minimalEnv: true,
        worktreeRef,
        kind: 'environment',
        environment: req.spec,
        headSha: req.headSha,
      };
      const ref = enqueueRunnerJob({
        orgId: req.orgId || 'default',
        projectId: req.project.id,
        runId,
        jobId: wire.jobId,
        matrixKey: wire.matrixKey,
        image,
        runnerClass: resolveEnvironmentRunnerClass(),
        kind: 'environment',
        specJson: JSON.stringify(wire),
        now: now(),
      });
      scale();
      return ref;
    },
    async status(ref) {
      const row = getRunnerJobStatus(ref);
      if (!row) return { state: 'lost', upstream: null, detail: 'runner job record is gone' };
      switch (row.state) {
        case 'queued':
          return { state: 'pending', upstream: null, detail: null };
        case 'claimed':
        case 'running':
          return row.endpoint
            ? { state: 'ready', upstream: row.endpoint, detail: null }
            : { state: 'starting', upstream: null, detail: null };
        case 'failed':
          return { state: 'failed', upstream: null, detail: row.detail };
        case 'lost':
          return { state: 'lost', upstream: null, detail: row.detail ?? 'runner lost' };
        default:
          return { state: 'stopped', upstream: null, detail: row.detail };
      }
    },
    async stop(ref) {
      // The agent sees 410 on its next heartbeat and tears the stack down;
      // its DinD container takes the whole inner graph with it.
      if (cancelRunnerJob({ jobId: ref, detail: 'PR environment stopped', now: now() })) scale();
    },
    async readLogs(ref, cursor) {
      const frames = readRunnerJobLogs({ jobId: ref, afterSeq: cursor });
      if (!frames.length) return { lines: [], cursor };
      return {
        lines: splitLines(frames.map((f) => f.data)),
        cursor: frames[frames.length - 1].seq,
      };
    },
  };
}

// Local (DinD on the Hub host)

export interface LocalEnvironmentDocker extends EnvironmentDocker {
  start(opts: JobContainerOptions): Promise<void>;
  /** True when `file` exists inside the container. Throws when docker could not be asked. */
  hasFile(name: string, file: string): Promise<boolean>;
}

export function realLocalEnvironmentDocker(): LocalEnvironmentDocker {
  const base = realEnvironmentDockerOps();
  return {
    ...base,
    start: (opts) => startJobContainer(opts),
    async hasFile(name, file) {
      try {
        await execFileAsync('docker', ['exec', name, 'test', '-f', file]);
        return true;
      } catch (err) {
        // `test -f` exits 1 silently; anything on stderr is docker failing.
        const e = err as { code?: unknown; stderr?: unknown };
        if (e.code === 1 && !String(e.stderr ?? '').trim()) return false;
        throw err;
      }
    },
  };
}

/** Where local environment checkouts live (host-translatable, like `.finalize-source`). */
export function localEnvironmentRoot(workspacesRoot: string = WORKSPACES_ROOT): string {
  return path.join(workspacesRoot, '.pr-environments');
}

export interface LocalEnvironmentRunnerDeps {
  docker?: LocalEnvironmentDocker;
  prepareCheckout?: typeof prepareDeploymentCheckout;
  removeDir?: (dir: string) => Promise<void>;
  root?: string;
  image?: string;
  env?: NodeJS.ProcessEnv;
  /** Delay between container checks after a failed bring-up. */
  containerCheckRetryMs?: number;
  /** Health-probe / ready-marker retry interval (tests). */
  healthPollMs?: number;
}

interface LocalRecord {
  status: EnvironmentRunnerStatus;
  logs: string[];
  /** Absolute index of `logs[0]`. */
  logBase: number;
  abort: AbortController;
}

const LOCAL_LOG_KEEP = 500;

export function createLocalEnvironmentRunner(
  deps: LocalEnvironmentRunnerDeps = {},
): EnvironmentRunner {
  const docker = deps.docker ?? realLocalEnvironmentDocker();
  const prepareCheckout = deps.prepareCheckout ?? prepareDeploymentCheckout;
  const removeDir = deps.removeDir ?? ((dir) => rm(dir, { recursive: true, force: true }));
  const root = deps.root ?? localEnvironmentRoot();
  const env = deps.env ?? process.env;
  // Loopback unless the Hub reaches containers through a docker-host gateway.
  const gatewayHost = env.AGENT_HUB_PREVIEW_HEALTH_HOST?.trim() || '127.0.0.1';
  const publishHost =
    env.FINALIZE_ENV_PUBLISH_HOST?.trim() ||
    (env.AGENT_HUB_PREVIEW_HEALTH_HOST?.trim() ? undefined : '127.0.0.1');
  const records = new Map<string, LocalRecord>();

  const dirFor = (ref: string) => path.join(root, ref);

  function append(rec: LocalRecord, chunk: string): void {
    for (const line of splitLines([chunk])) rec.logs.push(line);
    const excess = rec.logs.length - LOCAL_LOG_KEEP;
    if (excess > 0) {
      rec.logs.splice(0, excess);
      rec.logBase += excess;
    }
  }

  async function bringUp(ref: string, req: EnvironmentStartRequest, rec: LocalRecord) {
    const name = environmentContainerName(ref);
    const exec = createEnvironmentExec(docker, name, (_phase, _stream, data) => append(rec, data));
    const result = await runEnvironmentBringup({
      spec: req.spec,
      env: req.env,
      exec,
      log: (line) => append(rec, line),
      signal: rec.abort.signal,
      healthPollMs: deps.healthPollMs,
    });
    if (rec.abort.signal.aborted) return;
    if (!result.ok) {
      // Same rule as the fleet agent: a container that died under bring-up
      // is a loss (requeued), not an app failure.
      if (await containerConfirmedDown(docker, name, { delayMs: deps.containerCheckRetryMs })) {
        append(rec, `!! ${CONTAINER_STOPPED_DURING_BRINGUP}`);
        rec.status = { state: 'lost', upstream: null, detail: CONTAINER_STOPPED_DURING_BRINGUP };
        return;
      }
      append(rec, `!! ${result.error}`);
      rec.status = { state: 'failed', upstream: null, detail: result.error };
      return;
    }
    const port = await docker.hostPort(name, ENVIRONMENT_GATEWAY_PORT);
    rec.status = { state: 'ready', upstream: { host: gatewayHost, port }, detail: null };
  }

  async function stopContainer(ref: string, spec: RunnerEnvironmentSpec | null): Promise<void> {
    const name = environmentContainerName(ref);
    // Unknown (docker error) still attempts `compose down`; it is best-effort.
    if (spec && (await docker.isRunning(name).catch(() => true))) {
      const exec = createEnvironmentExec(docker, name, () => {});
      await exec(buildEnvironmentTeardownCommand(), {
        env: environmentComposeEnv(spec),
        phase: 0,
        deadlineMs: 120_000,
        quiet: true,
      }).catch(() => undefined);
    }
    // Removing the DinD container drops its inner graph (and so the stack).
    await docker.stopContainer(name);
  }

  const specs = new Map<string, RunnerEnvironmentSpec>();

  return {
    kind: 'local',
    async start(req) {
      const ref = req.key;
      const dir = dirFor(ref);
      await removeDir(dir).catch(() => {});
      const rec: LocalRecord = {
        status: { state: 'starting', upstream: null, detail: null },
        logs: [],
        logBase: 0,
        abort: new AbortController(),
      };
      records.set(ref, rec);
      specs.set(ref, req.spec);
      append(rec, `==> checking out ${req.headSha.slice(0, 12)}`);
      await prepareCheckout({ project: req.project, ref: req.headSha, destDir: dir });
      append(rec, '==> starting environment container');
      try {
        await docker.start({
          containerName: environmentContainerName(ref),
          image: deps.image ?? resolveRunsOnImage(ENVIRONMENT_RUNS_ON) ?? '',
          worktreePath: dir,
          composeProjectName: req.spec.composeProject,
          env: req.env,
          labels: { [ENVIRONMENT_LABEL]: ref },
          resourceProfile: 'unconstrained',
          baseEnvOnly: true,
          publish: [{ containerPort: ENVIRONMENT_GATEWAY_PORT, hostIp: publishHost }],
        });
      } catch (err) {
        await removeDir(dir).catch(() => {});
        records.delete(ref);
        throw err;
      }
      void bringUp(ref, req, rec).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        append(rec, `!! ${detail}`);
        rec.status = { state: 'failed', upstream: null, detail };
      });
      return ref;
    },
    async status(ref) {
      const name = environmentContainerName(ref);
      const rec = records.get(ref);
      if (rec) {
        if (rec.status.state !== 'ready') return rec.status;
        // A ready stack is only as alive as its container. A docker error
        // propagates (status unknown) rather than reading as a loss.
        if (await docker.isRunning(name)) return rec.status;
        rec.status = {
          state: 'lost',
          upstream: null,
          detail: 'the environment container stopped',
        };
        return rec.status;
      }
      // Not started by this process: read it back from docker.
      const running = await docker.isRunning(name);
      if (running === null) {
        return { state: 'lost', upstream: null, detail: 'the environment container is gone' };
      }
      if (!running || !(await docker.hasFile(name, ENVIRONMENT_READY_MARKER))) {
        return {
          state: 'lost',
          upstream: null,
          detail: running
            ? 'bring-up was interrupted by a Hub restart'
            : 'the environment container stopped',
        };
      }
      const port = await docker.hostPort(name, ENVIRONMENT_GATEWAY_PORT);
      const status: EnvironmentRunnerStatus = {
        state: 'ready',
        upstream: { host: gatewayHost, port },
        detail: null,
      };
      records.set(ref, {
        status,
        logs: [],
        logBase: 0,
        abort: new AbortController(),
      });
      return status;
    },
    async stop(ref) {
      const rec = records.get(ref);
      rec?.abort.abort();
      // The compose project name is only needed for `compose down`; removing
      // the container removes the stack either way.
      await stopContainer(ref, specs.get(ref) ?? null);
      await removeDir(dirFor(ref)).catch(() => {});
      if (rec) rec.status = { state: 'stopped', upstream: null, detail: null };
      specs.delete(ref);
    },
    async readLogs(ref, cursor) {
      const rec = records.get(ref);
      if (!rec) return { lines: [], cursor };
      const end = rec.logBase + rec.logs.length;
      if (cursor >= end) return { lines: [], cursor };
      const from = Math.max(cursor, rec.logBase) - rec.logBase;
      return { lines: rec.logs.slice(from), cursor: end };
    },
  };
}
