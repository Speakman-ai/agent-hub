/**
 * runner-exec-args.ts — pure argv/env builders for the Finalize DinD runner.
 *
 * Extracted from job-container.ts so BOTH the Hub-local runner path and the
 * remote runner-agent (which runs the same `docker run --privileged` + `docker
 * exec` on a fleet box) build the container and step invocations from the SAME
 * source. Local/remote parity depends on this being the single definition — a
 * divergence here is the classic "passes locally, fails remotely" bug.
 *
 * Everything in this file is PURE (string/argv construction + env shaping); the
 * runtime that actually spawns/execs processes lives in job-container.ts and in
 * the runner-agent.
 */
import { FINALIZE_STEP_SHELL } from './ci-config.js';
import { FINALIZE_RUNNER_WORKSPACE } from './runner-images.js';
import { resolveHostMountPath } from './container-runner.js';
import { resolveRunnerResourceArgs, type RepoVisibility } from './runner-resource-profile.js';

const STEP_SHELL_ARGV = FINALIZE_STEP_SHELL.split(/\s+/u);
export const RUNNER_USER = 'runner';
const RUNNER_HOME = '/home/runner';

/**
 * Shared image cache, mounted into every runner so CI image builds can be done
 * once and reused across matrix shards (each shard has its own isolated inner
 * dockerd, so without this they'd each rebuild from scratch). run_e2e_ci.sh
 * `docker save`s built images here keyed by commit SHA and `docker load`s them
 * on later shards. Named volume → shared across all runner containers.
 *
 * NOTE (multi-tenant): this volume is global on a single host. When runners go
 * remote/multi-tenant the cache must be org-scoped (per-tenant ECR/S3) — see
 * the Stage 3 plan; do not share one volume across tenants.
 */
export const FINALIZE_IMAGE_CACHE_VOLUME = 'finalize-image-cache';
export const FINALIZE_IMAGE_CACHE_PATH = '/finalize-cache';

/** Hub server env keys that must not leak into DinD runners (wrong paths / permissions). */
const RUNNER_ENV_BLOCKLIST = new Set([
  // The Hub runs with NODE_ENV=production; leaking it into the runner makes
  // `npm ci` skip devDependencies (Angular CLI / `ng`, Cypress, build tooling),
  // so frontend lint/build/component and E2E jobs fail ("ng: not found",
  // missing cypress). CI runners must install dev deps — keep NODE_ENV unset.
  'NODE_ENV',
  'HOME',
  'AGENT_HUB_DATA_DIR',
  'AGENT_HUB_HOST',
  'AGENT_HUB_PORT',
  'AGENT_HUB_HOST_PROJECTS_DIR',
  'AGENT_HUB_HOST_WORKSPACES_DIR',
  'AGENT_HUB_HOST_MAC_PROJECTS_DIR',
  'AGENT_HUB_CONTAINER_PROJECTS_DIR',
  'AGENT_HUB_CONTAINER_WORKSPACES_DIR',
  'AGENT_HUB_CONTAINER_MAC_PROJECTS_DIR',
  'AGENT_HUB_PREVIEW_HEALTH_HOST',
]);

/**
 * Sanitize env passed into a finalize runner container.
 * Hub runs with HOME=/data; runners need the runner user's home or npm hits EACCES on /data.
 */
export function finalizeRunnerEnv(
  base: NodeJS.ProcessEnv | undefined,
  extras?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: RUNNER_HOME,
    USER: RUNNER_USER,
    AGENT_HUB_RUNNER: '1',
    NPM_CONFIG_CACHE: '/tmp/.npm',
  };
  for (const source of [base, extras]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || RUNNER_ENV_BLOCKLIST.has(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

export interface JobContainerOptions {
  containerName: string;
  image: string;
  worktreePath: string;
  composeProjectName: string;
  env?: NodeJS.ProcessEnv;
  labels?: Record<string, string>;
  /**
   * Pre-resolved host path to bind-mount as the workspace. The Hub omits this
   * (it derives the host path from `worktreePath` via `resolveHostMountPath`,
   * which un-translates the Hub's own container paths). The remote agent passes
   * the path where it materialized the worktree bundle directly — no Hub-side
   * path translation applies on the fleet box.
   */
  workspaceMount?: string;
  /**
   * Env source for resolving GitHub-parity CPU/memory caps (see
   * runner-resource-profile.ts). Defaults to `process.env`; tests inject a
   * fixed env to assert the resulting `--cpus` / `--memory` flags.
   */
  resourceEnv?: NodeJS.ProcessEnv;
  /**
   * The gated repo's GitHub visibility (detected Hub-side from the worktree's
   * origin). Selects the GitHub-parity tier when no explicit
   * FINALIZE_RUNNER_RESOURCE_PROFILE override is set: public -> ubuntu-public,
   * private -> ubuntu-private. Omitted/`'unknown'` keeps the stricter default.
   */
  visibility?: RepoVisibility;
}

export interface ExecJobStepOptions {
  containerName: string;
  run: string;
  env?: NodeJS.ProcessEnv;
}

/** Stable Docker container name for a job instance. */
export function sanitizeJobContainerName(runId: string, jobId: string, matrixKey: string): string {
  const slug = `${runId}-${jobId}-${matrixKey}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return `finalize-${slug}`.toLowerCase();
}

export function sanitizeVolumeName(containerName: string): string {
  return `${containerName}-graph`.slice(0, 120);
}

function pushEnvArgs(args: string[], env: NodeJS.ProcessEnv | undefined): void {
  if (!env) return;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    args.push('-e', `${key}=${value}`);
  }
}

/** Build argv for `docker run -d ... image runner-entrypoint.sh daemon`. */
export function buildStartJobContainerArgv(opts: JobContainerOptions): string[] {
  const hostMount = opts.workspaceMount ?? resolveHostMountPath(opts.worktreePath);
  const graphVolume = sanitizeVolumeName(opts.containerName);
  const args = ['run', '-d', '--privileged', '--cgroupns=host', '--name', opts.containerName];

  // GitHub-parity CPU/memory caps: the gate runner must never be faster/beefier
  // than the GitHub-hosted runner it stands in for (see runner-resource-profile.ts).
  // The repo's visibility picks the matching tier when no explicit override is set.
  args.push(
    ...resolveRunnerResourceArgs(opts.resourceEnv ?? process.env, { visibility: opts.visibility }),
  );

  for (const [key, value] of Object.entries(opts.labels ?? {})) {
    args.push('--label', `${key}=${value}`);
  }

  args.push('-v', `${hostMount}:${FINALIZE_RUNNER_WORKSPACE}:rw`);
  args.push('-v', `${graphVolume}:/var/lib/docker`);
  args.push('-v', `${FINALIZE_IMAGE_CACHE_VOLUME}:${FINALIZE_IMAGE_CACHE_PATH}`);
  args.push('-w', FINALIZE_RUNNER_WORKSPACE);

  const env = finalizeRunnerEnv(opts.env ?? process.env, {
    COMPOSE_PROJECT_NAME: opts.composeProjectName,
  });
  pushEnvArgs(args, env);

  args.push(opts.image, '/usr/local/bin/runner-entrypoint.sh', 'daemon');
  return ['docker', ...args];
}

/** Build argv for `docker exec -u runner ... bash -c <run>`. */
export function buildExecJobStepArgv(opts: ExecJobStepOptions): string[] {
  const args = ['exec', '-i', '-u', RUNNER_USER, '-w', FINALIZE_RUNNER_WORKSPACE];
  pushEnvArgs(args, finalizeRunnerEnv(opts.env));
  args.push(opts.containerName, ...STEP_SHELL_ARGV, opts.run);
  return ['docker', ...args];
}

/** Build argv for `docker rm -f -v <name>`. */
export function buildStopJobContainerArgv(containerName: string): string[] {
  return ['docker', 'rm', '-f', '-v', containerName];
}

/**
 * Build argv to remove the job's NAMED graph volume. `docker rm -v` only removes
 * ANONYMOUS volumes, so the named graph volume (`<container>-graph`) survives the
 * container removal and leaks one per job unless removed explicitly.
 */
export function buildRemoveGraphVolumeArgv(containerName: string): string[] {
  return ['docker', 'volume', 'rm', '-f', sanitizeVolumeName(containerName)];
}
