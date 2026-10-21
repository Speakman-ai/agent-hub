/**
 * The Hub-local DinD backend.
 *
 * Wraps the existing job-container lifecycle (`startJobContainer` /
 * `createJobScopedSpawnStep` / `stopJobContainer`) behind the `RunnerBackend`
 * interface.
 *
 * Each job gets its own clone of the run worktree before the container
 * starts. GitHub Actions does this by default; without it, parallel
 * shards race `python3 -m venv .venv` and `npm ci` on one
 * bind-mount and fail with EACCES.
 */
import { rm } from 'fs/promises';
import {
  createJobScopedSpawnStep,
  sanitizeJobContainerName,
  startJobContainer,
  stopJobContainer,
} from './job-container.js';
import { jobWorktreePath, materializeJobWorktree } from './job-worktree.js';
import { finalizeSourceRoot } from './session-source.js';
import type { JobClaimSpec, RunnerBackend, RunnerLease } from './runner-backend.js';
import { timePhase, type JobStartupTimings } from './job-startup.js';

export interface LocalRunnerBackendOpts {
  /** Override `.finalize-source` root (tests). */
  sourceRoot?: string;
  materialize?: typeof materializeJobWorktree;
  startContainer?: typeof startJobContainer;
  now?: () => number;
}

export function createLocalRunnerBackend(opts: LocalRunnerBackendOpts = {}): RunnerBackend {
  const sourceRoot = opts.sourceRoot;
  const materialize = opts.materialize ?? materializeJobWorktree;
  const startContainer = opts.startContainer ?? startJobContainer;
  const now = opts.now ?? Date.now;
  return {
    kind: 'local',
    // Native (non-container) jobs run directly on THIS Hub host, so the Hub's
    // platform is the runner's platform. A `runs-on: macos-*` job is therefore
    // satisfiable here only when Agent Hub itself runs on macOS.
    nativeHostPlatforms: [process.platform],
    async acquire(spec: JobClaimSpec): Promise<RunnerLease> {
      const containerName = sanitizeJobContainerName(spec.runId, spec.jobId, spec.matrixKey);
      const jobWt = jobWorktreePath(
        sourceRoot ?? finalizeSourceRoot(),
        spec.runId,
        spec.jobId,
        spec.matrixKey,
      );
      const timings: JobStartupTimings = {};
      await timePhase(timings, 'worktree', () => materialize(spec.worktreePath, jobWt), now);
      try {
        await timePhase(
          timings,
          'container_start',
          () =>
            startContainer({
              containerName,
              image: spec.image,
              worktreePath: jobWt,
              composeProjectName: spec.composeProjectName,
              env: spec.env,
              labels: spec.labels,
              visibility: spec.visibility,
              resourceProfile: spec.resourceProfile,
              baseEnvOnly: spec.minimalEnv,
            }),
          now,
        );
      } catch (err) {
        await rm(jobWt, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return {
        startup: Promise.resolve(timings),
        spawnStep: createJobScopedSpawnStep({
          containerName,
          baseEnv: spec.env,
          baseEnvOnly: spec.minimalEnv,
        }),
        release: async () => {
          await stopJobContainer(containerName);
          await rm(jobWt, { recursive: true, force: true }).catch(() => {});
        },
      };
    },
  };
}
