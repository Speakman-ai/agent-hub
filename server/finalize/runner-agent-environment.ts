/**
 * Runner-agent side of a PR environment job (`spec.kind === 'environment'`).
 *
 * Unlike a Finalize job, nothing is pushed over the Hub's in-process channel:
 * the agent boots the stack itself (materialize → DinD with the gateway port
 * published → compose up → seed steps → health), reports the reachable
 * `host:port`, then holds the stack until a heartbeat comes back 410 (the Hub
 * cancelled the row: stop, rebuild, or the job was declared lost). Heartbeat
 * failures while the Hub is down are ignored, so a Hub restart does not take
 * the environment with it.
 */
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { buildExecJobStepArgv } from './runner-exec-args.js';
import { startJobContainer, stopJobContainer } from './job-container.js';
import {
  ENVIRONMENT_GATEWAY_PORT,
  ENVIRONMENT_LABEL,
  buildEnvironmentTeardownCommand,
  environmentComposeEnv,
  environmentContainerName,
  parseDockerPortOutput,
  runEnvironmentBringup,
  type EnvironmentExec,
} from './runner-environment.js';
import type { RunnerJobWireSpec } from './runner-backend-remote.js';
import type { AgentDocker, AgentLogFrame, AgentTransport } from './runner-agent.js';
import { deliverCritical, runExecStepChild } from './runner-agent.js';
import { noopTaskProtection, type TaskProtection } from './ecs-task-protection.js';
import { getImdsMetadata } from './spot-interruption.js';
import {
  chownWorktreeForJobRunner,
  clearWorktreeDestForRematerialize,
} from './worktree-job-ownership.js';

const execFileAsync = promisify(execFile);

export type EnvironmentReport =
  | { status: 'ready'; host: string; port: number }
  | { status: 'failed'; detail: string }
  /** The stack died after it was reported ready. */
  | { status: 'lost'; detail: string };

export interface EnvironmentTransport extends Pick<
  AgentTransport,
  'postLogs' | 'postFinish' | 'heartbeat'
> {
  /**
   * Throws on a non-2xx so delivery is retried. `gone` (HTTP 410) means the
   * row is no longer live: the Hub stopped this environment meanwhile.
   */
  postEnvironment(jobId: string, report: EnvironmentReport): Promise<{ gone: boolean }>;
}

export interface EnvironmentDocker {
  startContainer(spec: RunnerJobWireSpec, workspaceMount: string, name: string): Promise<void>;
  execStep: AgentDocker['execStep'];
  /**
   * True / false for an existing container, null when docker confirms it
   * does not exist. Throws when docker could not be asked (daemon or API
   * error), which callers must not read as "gone".
   */
  isRunning(name: string): Promise<boolean | null>;
  /** Host port the container's `containerPort` is published on. */
  hostPort(name: string, containerPort: number): Promise<number>;
  stopContainer(name: string): Promise<void>;
}

/**
 * Address the Hub can reach this box on: `FINALIZE_RUNNER_ADVERTISE_HOST`, else
 * the EC2 private IP from IMDS, else the first non-internal IPv4 interface.
 */
export async function resolveAdvertiseHost(
  env: NodeJS.ProcessEnv = process.env,
  imds: (p: string) => Promise<string | null> = (p) => getImdsMetadata(p),
  interfaces: () => ReturnType<typeof os.networkInterfaces> = os.networkInterfaces,
): Promise<string> {
  const explicit = env.FINALIZE_RUNNER_ADVERTISE_HOST?.trim();
  if (explicit) return explicit;
  const fromImds = await imds('local-ipv4').catch(() => null);
  if (fromImds && /^\d+\.\d+\.\d+\.\d+$/.test(fromImds)) return fromImds;
  for (const list of Object.values(interfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

/**
 * After a failed bring-up: did the environment container die under it? Only
 * a confirmed answer counts (stopped, or docker says it does not exist). A
 * docker error is retried a few times and then reads as "not confirmed", so
 * the failure stays an application failure.
 */
export async function containerConfirmedDown(
  docker: Pick<EnvironmentDocker, 'isRunning'>,
  name: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  for (let i = 0; i < attempts; i++) {
    try {
      return (await docker.isRunning(name)) !== true;
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, opts.delayMs ?? 1_000));
    }
  }
  return false;
}

/** Detail recorded when the container died during bring-up. */
export const CONTAINER_STOPPED_DURING_BRINGUP = 'the environment container stopped during bring-up';

/** `docker inspect`/`exec` failed because the container does not exist. */
export function isNoSuchContainerError(err: unknown): boolean {
  const stderr = String((err as { stderr?: unknown })?.stderr ?? '');
  return /no such (object|container)/i.test(stderr);
}

export function realEnvironmentDockerOps(env: NodeJS.ProcessEnv = process.env): EnvironmentDocker {
  return {
    async startContainer(spec, workspaceMount, name) {
      await startJobContainer({
        containerName: name,
        image: spec.image,
        worktreePath: workspaceMount,
        workspaceMount,
        composeProjectName: spec.composeProjectName,
        env: spec.env,
        labels: { [ENVIRONMENT_LABEL]: spec.runId },
        resourceProfile: spec.resourceProfile,
        baseEnvOnly: true,
        publish: [
          {
            containerPort: ENVIRONMENT_GATEWAY_PORT,
            hostIp: env.FINALIZE_ENV_PUBLISH_HOST?.trim() || undefined,
          },
        ],
      });
    },
    execStep(containerName, run, stepEnv, onLog, signal) {
      return runExecStepChild({
        argv: buildExecJobStepArgv({ containerName, run, env: stepEnv }),
        onLog,
        signal,
      });
    },
    async isRunning(name) {
      try {
        const { stdout } = await execFileAsync('docker', [
          'inspect',
          '-f',
          '{{.State.Running}}',
          name,
        ]);
        return stdout.trim() === 'true';
      } catch (err) {
        if (isNoSuchContainerError(err)) return null;
        throw err;
      }
    },
    async hostPort(name, containerPort) {
      const { stdout } = await execFileAsync('docker', ['port', name, String(containerPort)]);
      const port = parseDockerPortOutput(stdout);
      if (!port) throw new Error(`no host port published for ${name}:${containerPort}`);
      return port;
    },
    async stopContainer(name) {
      await stopJobContainer(name);
    },
  };
}

/**
 * Adapt `execStep` to the bring-up driver: a per-command deadline, stdout
 * captured for the health probe, and output streamed to the environment log.
 */
export function createEnvironmentExec(
  docker: Pick<EnvironmentDocker, 'execStep'>,
  containerName: string,
  onLog: (phase: number, stream: 'stdout' | 'stderr', data: string) => void,
): EnvironmentExec {
  return async (run, opts) => {
    const ac = new AbortController();
    const abort = (): void => ac.abort();
    if (opts.signal?.aborted) ac.abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, opts.deadlineMs);
    let stdout = '';
    try {
      const exitCode = await docker.execStep(
        containerName,
        run,
        opts.env,
        (stream, data) => {
          if (stream === 'stdout') stdout = (stdout + data).slice(-4096);
          if (!opts.quiet) onLog(opts.phase, stream, data);
        },
        ac.signal,
      );
      return { exitCode, stdout };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    }
  };
}

/**
 * Poll the container while the stack is held. `dead` resolves after two
 * consecutive reads find it stopped or gone (one failed `docker inspect` is
 * not proof).
 */
function watchContainer(
  docker: Pick<EnvironmentDocker, 'isRunning'>,
  name: string,
  stopSignal: AbortSignal,
  everyMs = 15_000,
): { dead: Promise<void>; isDead: () => boolean; cancel: () => void } {
  let misses = 0;
  let dead = false;
  let markDead!: () => void;
  const deadP = new Promise<void>((r) => (markDead = r));
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || dead || stopSignal.aborted) return;
    inFlight = true;
    void docker
      .isRunning(name)
      .then((running) => {
        misses = running === true ? 0 : misses + 1;
        if (misses >= 2 && !dead) {
          dead = true;
          markDead();
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  }, everyMs);
  (timer as { unref?: () => void }).unref?.();
  return { dead: deadP, isDead: () => dead, cancel: () => clearInterval(timer) };
}

/**
 * Deliver the ready report until it lands. Unlike a step result, there is no
 * attempt limit: giving up would tear down a healthy stack the Hub can still
 * adopt once it is back.
 */
async function deliverReady(
  post: () => Promise<{ gone: boolean }>,
  stopSignal: AbortSignal,
  dead: Promise<void>,
  firstDelayMs = 1_000,
): Promise<'delivered' | 'gone' | 'stopped' | 'dead'> {
  let isDead = false;
  void dead.then(() => {
    isDead = true;
  });
  let delay = firstDelayMs;
  for (let attempt = 1; ; attempt++) {
    if (stopSignal.aborted) return 'stopped';
    if (isDead) return 'dead';
    try {
      return (await post()).gone ? 'gone' : 'delivered';
    } catch (err) {
      console.error(
        `[runner-agent] environment ready report failed (attempt ${attempt}): ${
          err instanceof Error ? err.message : String(err)
        } — retrying in ${delay}ms`,
      );
    }
    await Promise.race([
      new Promise((r) => setTimeout(r, delay)),
      dead,
      new Promise((r) => stopSignal.addEventListener('abort', r, { once: true })),
    ]);
    delay = Math.min(delay * 2, 30_000);
  }
}

/**
 * Boot and hold one environment until the Hub stops it. Resolves after the
 * stack is torn down. Throws only for bring-up infrastructure failures before
 * the container exists (the caller reports those as a lost job).
 */
export async function runAgentEnvironment(args: {
  jobId: string;
  spec: RunnerJobWireSpec;
  workspaceDir: string;
  transport: EnvironmentTransport;
  docker: EnvironmentDocker;
  materialize?: (spec: RunnerJobWireSpec, destPath: string) => Promise<void>;
  clearJobWorktreeDest?: (destPath: string) => Promise<void>;
  ensureJobWorktreeOwnership?: (destPath: string) => Promise<void>;
  resolveHost?: () => Promise<string>;
  protection?: TaskProtection;
  heartbeatMs?: number;
  logFlushMs?: number;
  delivery?: { attempts?: number; baseDelayMs?: number };
  sleep?: (ms: number) => Promise<void>;
  healthPollMs?: number;
  /** How often a ready stack's container is checked. */
  livenessMs?: number;
  /** First delay between ready-report attempts (doubles, capped at 30s). */
  readyRetryMs?: number;
  /** Delay between container checks after a failed bring-up. */
  containerCheckRetryMs?: number;
}): Promise<{ ready: boolean; error: string | null }> {
  const { jobId, spec, transport, docker } = args;
  const envSpec = spec.environment;
  if (!envSpec) throw new Error(`environment job ${jobId} has no environment spec`);
  const protection = args.protection ?? noopTaskProtection();
  void protection.set(true).catch(() => {});

  // Stop signal: the Hub answers a heartbeat with 410 once the row is no
  // longer live. Failed heartbeats (Hub restarting) are not a stop.
  const stop = new AbortController();
  const stopped = new Promise<void>((resolve) =>
    stop.signal.addEventListener('abort', () => resolve(), { once: true }),
  );
  const heartbeat = setInterval(() => {
    void transport
      .heartbeat(jobId)
      .then((r) => {
        if (r && r.gone && !stop.signal.aborted) {
          console.log(`[runner-agent] environment ${jobId} stopped by the Hub`);
          stop.abort();
        }
      })
      .catch(() => {});
    void protection.set(true).catch(() => {});
  }, args.heartbeatMs ?? 30_000);
  (heartbeat as { unref?: () => void }).unref?.();

  let seq = 0;
  const buffer: AgentLogFrame[] = [];
  const flush = async (): Promise<void> => {
    if (!buffer.length) return;
    await transport.postLogs(jobId, buffer.splice(0)).catch(() => {});
  };
  const flusher = setInterval(() => void flush(), args.logFlushMs ?? 500);
  (flusher as { unref?: () => void }).unref?.();
  const log = (line: string): void => {
    buffer.push({ seq: seq++, stepIndex: 0, stream: 'stdout', data: `${line}\n` });
  };

  const name = environmentContainerName(spec.runId);
  let containerStarted = false;
  let ready = false;
  let error: string | null = null;
  try {
    const workspace = path.join(args.workspaceDir, 'repo');
    await (args.clearJobWorktreeDest ?? clearWorktreeDestForRematerialize)(workspace);
    if (spec.worktreeRef && args.materialize) {
      await args.materialize(spec, workspace);
      await (args.ensureJobWorktreeOwnership ?? chownWorktreeForJobRunner)(workspace);
    }
    log('==> starting environment container');
    await docker.startContainer(spec, workspace, name);
    containerStarted = true;

    const exec = createEnvironmentExec(docker, name, (phase, stream, data) => {
      buffer.push({ seq: seq++, stepIndex: phase, stream, data });
    });
    const result = await runEnvironmentBringup({
      spec: envSpec,
      env: spec.env,
      exec,
      log,
      signal: stop.signal,
      sleep: args.sleep,
      healthPollMs: args.healthPollMs,
    });
    if (stop.signal.aborted) {
      error = 'stopped';
    } else if (!result.ok) {
      // A dead container makes every phase fail; that is a runner loss (the
      // Hub requeues it), not a broken app (terminal until Retry).
      const lost = await containerConfirmedDown(docker, name, {
        delayMs: args.containerCheckRetryMs,
      });
      error = lost ? CONTAINER_STOPPED_DURING_BRINGUP : result.error;
      log(`!! ${error}`);
      await flush();
      const report: EnvironmentReport = lost
        ? { status: 'lost', detail: error }
        : { status: 'failed', detail: error };
      await deliverCritical(
        `environment ${report.status} (job=${jobId})`,
        async () => {
          await transport.postEnvironment(jobId, report);
        },
        args.delivery,
      ).catch(() => {});
    } else {
      const port = await docker.hostPort(name, ENVIRONMENT_GATEWAY_PORT);
      const host = await (args.resolveHost ?? (() => resolveAdvertiseHost()))();
      log(`==> serving on ${host}:${port}`);
      await flush();
      // The ready report is retried for as long as the stack is worth
      // reporting: a Hub that is restarting must find the stack still up
      // (and adopt it) rather than a stack torn down because delivery ran
      // out of attempts. It ends on delivery, a 410, a stop, or a dead
      // container.
      const liveness = watchContainer(docker, name, stop.signal, args.livenessMs);
      const outcome = await deliverReady(
        () => transport.postEnvironment(jobId, { status: 'ready', host, port }),
        stop.signal,
        liveness.dead,
        args.readyRetryMs,
      );
      if (outcome === 'delivered') {
        ready = true;
        await Promise.race([stopped, liveness.dead]);
      }
      liveness.cancel();
      if (outcome === 'gone' || outcome === 'stopped') {
        error = 'stopped';
      } else if (!stop.signal.aborted && liveness.isDead()) {
        error = 'the environment container stopped';
        log(`!! ${error}`);
        ready = false;
        // The Hub would otherwise keep routing to the stored endpoint.
        await deliverCritical(
          `environment lost (job=${jobId})`,
          async () => {
            await transport.postEnvironment(jobId, { status: 'lost', detail: error! });
          },
          args.delivery,
        ).catch(() => {});
      }
    }
  } finally {
    clearInterval(flusher);
    await flush();
    clearInterval(heartbeat);
    if (containerStarted) {
      const exec = createEnvironmentExec(docker, name, () => {});
      await exec(buildEnvironmentTeardownCommand(), {
        env: { ...spec.env, ...environmentComposeEnv(envSpec) },
        phase: 0,
        deadlineMs: 120_000,
        quiet: true,
      }).catch(() => undefined);
      await docker.stopContainer(name).catch(() => {});
    }
    await deliverCritical(
      `finish (job=${jobId})`,
      () => transport.postFinish(jobId, ready ? 0 : 1, null),
      args.delivery,
    ).catch((err: unknown) =>
      console.error(`[runner-agent] ${err instanceof Error ? err.message : String(err)}`),
    );
    await protection.set(false).catch(() => {});
  }
  return { ready, error };
}
