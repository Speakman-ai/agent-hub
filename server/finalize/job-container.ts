/**
 * job-container.ts — job-scoped DinD runner lifecycle (Hub-local backend).
 *
 * One privileged runner container per ci.yaml job instance (matrix shard).
 * Steps run via `docker exec`; inner compose uses the runner's own dockerd.
 *
 * The pure argv/env construction lives in `runner-exec-args.ts` (shared with the
 * remote runner-agent for parity); this file owns only the runtime that spawns
 * and execs against the local Docker daemon.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import type { SpawnedStep, SpawnStepArgs, SpawnStepFn } from './step-runner.js';
import {
  RUNNER_USER,
  buildExecJobStepArgv,
  buildRemoveGraphVolumeArgv,
  buildStartJobContainerArgv,
  buildStopJobContainerArgv,
  finalizeRunnerEnv,
  type ExecJobStepOptions,
  type JobContainerOptions,
} from './runner-exec-args.js';

// Re-export the shared pure builders/env/constants so existing importers
// (job-runner, tests) keep their `./job-container.js` import path unchanged.
export {
  FINALIZE_IMAGE_CACHE_VOLUME,
  FINALIZE_IMAGE_CACHE_PATH,
  finalizeRunnerEnv,
  sanitizeJobContainerName,
  buildStartJobContainerArgv,
  buildExecJobStepArgv,
  buildStopJobContainerArgv,
  buildRemoveGraphVolumeArgv,
} from './runner-exec-args.js';
export type { JobContainerOptions, ExecJobStepOptions } from './runner-exec-args.js';

const execFileAsync = promisify(execFile);
const DOCKERD_READY_TIMEOUT_MS = 120_000;
const DOCKERD_POLL_MS = 1_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isInnerDockerReady(containerName: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['exec', '-u', RUNNER_USER, containerName, 'docker', 'info']);
    return true;
  } catch {
    return false;
  }
}

/** Start a job-scoped DinD runner and wait for inner dockerd. */
export async function startJobContainer(opts: JobContainerOptions): Promise<void> {
  const argv = buildStartJobContainerArgv(opts);
  try {
    await execFileAsync(argv[0], argv.slice(1));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to start job container ${opts.containerName}: ${msg}`);
  }

  const deadline = Date.now() + DOCKERD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isInnerDockerReady(opts.containerName)) {
      return;
    }
    await sleep(DOCKERD_POLL_MS);
  }
  throw new Error(
    `job container ${opts.containerName}: inner dockerd not ready within ${DOCKERD_READY_TIMEOUT_MS / 1000}s`,
  );
}

/** Stop and remove a job-scoped runner (including its named inner graph volume). */
export async function stopJobContainer(containerName: string): Promise<void> {
  const argv = buildStopJobContainerArgv(containerName);
  try {
    await execFileAsync(argv[0], argv.slice(1));
  } catch {
    // Container may already be gone on timeout/kill paths.
  }
  // `docker rm -v` only removes anonymous volumes; the graph volume is named, so
  // remove it explicitly or it leaks one per job. (The finalize-reaper sweeps any
  // that survive a hard kill where this never runs.)
  const volArgv = buildRemoveGraphVolumeArgv(containerName);
  try {
    await execFileAsync(volArgv[0], volArgv.slice(1));
  } catch {
    // Volume may be gone, or still attached if the container removal failed.
  }
}

function wrapChild(child: ChildProcess): SpawnedStep {
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    on(event: 'close' | 'error', listener: (arg: never) => void) {
      child.on(event, listener as never);
      return child;
    },
    kill(signal?: NodeJS.Signals) {
      return child.kill(signal);
    },
  };
}

/** Spawn a step via `docker exec` into a running job container. */
export function execJobStep(opts: ExecJobStepOptions): SpawnedStep {
  const argv = buildExecJobStepArgv(opts);
  const child: ChildProcess = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return wrapChild(child);
}

/** Factory: all steps in a job instance exec into the same DinD runner. */
export function createJobScopedSpawnStep(options: {
  containerName: string;
  baseEnv?: NodeJS.ProcessEnv;
}): SpawnStepFn {
  return ({ step, env }: SpawnStepArgs): SpawnedStep => {
    return execJobStep({
      containerName: options.containerName,
      run: step.run,
      env: finalizeRunnerEnv(process.env, { ...options.baseEnv, ...env }),
    });
  };
}
