/**
 * runner-backend-local.ts — the Hub-local DinD backend.
 *
 * Wraps the existing job-container lifecycle (`startJobContainer` /
 * `createJobScopedSpawnStep` / `stopJobContainer`) behind the `RunnerBackend`
 * interface.
 *
 * Each job gets its own clone of the run worktree before the container
 * starts. GitHub Actions does this by default; without it, parallel
 * Survey Tracker shards race `python3 -m venv .venv` and `npm ci` on one
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

export interface LocalRunnerBackendOpts {
  /** Override `.finalize-source` root (tests). */
  sourceRoot?: string;
  materialize?: typeof materializeJobWorktree;
}

export function createLocalRunnerBackend(opts: LocalRunnerBackendOpts = {}): RunnerBackend {
  const sourceRoot = opts.sourceRoot;
  const materialize = opts.materialize ?? materializeJobWorktree;
  return {
    kind: 'local',
    async acquire(spec: JobClaimSpec): Promise<RunnerLease> {
      const containerName = sanitizeJobContainerName(spec.runId, spec.jobId, spec.matrixKey);
      const jobWt = jobWorktreePath(
        sourceRoot ?? finalizeSourceRoot(),
        spec.runId,
        spec.jobId,
        spec.matrixKey,
      );
      await materialize(spec.worktreePath, jobWt);
      try {
        await startJobContainer({
          containerName,
          image: spec.image,
          worktreePath: jobWt,
          composeProjectName: spec.composeProjectName,
          env: spec.env,
          labels: spec.labels,
          visibility: spec.visibility,
          resourceProfile: spec.resourceProfile,
          baseEnvOnly: spec.minimalEnv,
        });
      } catch (err) {
        await rm(jobWt, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return {
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
