/**
 * container-runner.ts — spawn Finalize steps inside Docker runner containers.
 *
 * v2 jobs use `runs-on: ubuntu-24.04` (etc.) instead of host bash.
 *
 * Default (`dind`): job-scoped privileged runner with inner dockerd — see
 * job-container.ts. Legacy (`host-socket`): one ephemeral container per step
 * mounting the host docker.sock.
 */
import { spawn, type ChildProcess } from 'child_process';
import { FINALIZE_STEP_SHELL } from './ci-config.js';
import type { SpawnedStep, SpawnStepArgs, SpawnStepFn } from './step-runner.js';
import { FINALIZE_RUNNER_WORKSPACE } from './runner-images.js';
import { translateContainerPathToHost } from '../preview/host-path-translation.js';
import { isDindRunnerMode } from './runner-docker-mode.js';

const STEP_SHELL_ARGV = FINALIZE_STEP_SHELL.split(/\s+/u);
const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

export interface ContainerRunOptions {
  image: string;
  worktreePath: string;
  run: string;
  env?: NodeJS.ProcessEnv;
  /** Mount host Docker socket for nested compose/buildx. Default true in host-socket mode. */
  mountDockerSocket?: boolean;
  composeProjectName?: string;
  labels?: Record<string, string>;
}

export interface BuildDockerRunArgvOptions extends ContainerRunOptions {
  /** When true, mount host socket and host.docker.internal (legacy per-step mode). */
  hostSocketMode?: boolean;
}

/** Resolve worktree path for docker volume mount (host-side when Hub runs in container). */
export function resolveHostMountPath(worktreePath: string): string {
  const translation = translateContainerPathToHost(worktreePath);
  return translation.hostPath ?? worktreePath;
}

/**
 * Build argv for `docker run --rm ... image bash -euo pipefail -c <run>`.
 * Used only in legacy host-socket mode (one container per step).
 */
export function buildDockerRunArgv(opts: BuildDockerRunArgvOptions): string[] {
  const hostMount = resolveHostMountPath(opts.worktreePath);
  const hostSocketMode = opts.hostSocketMode ?? !isDindRunnerMode();
  const mountDocker = opts.mountDockerSocket !== false && hostSocketMode;
  const args = ['run', '--rm'];

  for (const [key, value] of Object.entries(opts.labels ?? {})) {
    args.push('--label', `${key}=${value}`);
  }

  args.push('-v', `${hostMount}:${FINALIZE_RUNNER_WORKSPACE}:rw`);
  args.push('-w', FINALIZE_RUNNER_WORKSPACE);

  if (hostSocketMode) {
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  if (mountDocker) {
    const socket = process.env.FINALIZE_DOCKER_SOCKET?.trim() || DEFAULT_DOCKER_SOCKET;
    args.push('-v', `${socket}:${DEFAULT_DOCKER_SOCKET}`);
  }

  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  if (opts.composeProjectName) {
    env.COMPOSE_PROJECT_NAME = opts.composeProjectName;
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    args.push('-e', `${key}=${value}`);
  }

  args.push('--entrypoint', STEP_SHELL_ARGV[0]);
  args.push(opts.image);
  args.push(...STEP_SHELL_ARGV.slice(1), opts.run);
  return ['docker', ...args];
}

/** Spawn a step inside a runner container. Same child shape as host spawn. */
export function spawnStepInContainer(opts: ContainerRunOptions): SpawnedStep {
  const argv = buildDockerRunArgv({ ...opts, hostSocketMode: true });
  const child: ChildProcess = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return wrapChild(child);
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

/** Factory: returns a {@link SpawnStepFn} for legacy host-socket per-step mode. */
export function createContainerSpawnStep(options: {
  image: string;
  composeProjectName: string;
  mountDockerSocket?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  labels?: Record<string, string>;
}): SpawnStepFn {
  return ({ step, cwd, env }: SpawnStepArgs): SpawnedStep => {
    const merged: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options.baseEnv ?? {}),
      ...(env ?? {}),
    };
    return spawnStepInContainer({
      image: options.image,
      worktreePath: cwd,
      run: step.run,
      env: merged,
      mountDockerSocket: options.mountDockerSocket,
      composeProjectName: options.composeProjectName,
      labels: options.labels,
    });
  };
}

export { DEFAULT_DOCKER_SOCKET };
