/**
 * runner-backend-local.ts — the Hub-local DinD backend.
 *
 * Wraps the existing job-container lifecycle (`startJobContainer` /
 * `createJobScopedSpawnStep` / `stopJobContainer`) behind the `RunnerBackend`
 * interface. This is a behavior-preserving wrapper of the DinD path that
 * previously lived inline in `job-runner.ts`.
 */
import {
  createJobScopedSpawnStep,
  sanitizeJobContainerName,
  startJobContainer,
  stopJobContainer,
} from './job-container.js';
import type { JobClaimSpec, RunnerBackend, RunnerLease } from './runner-backend.js';

export function createLocalRunnerBackend(): RunnerBackend {
  return {
    kind: 'local',
    async acquire(spec: JobClaimSpec): Promise<RunnerLease> {
      const containerName = sanitizeJobContainerName(spec.runId, spec.jobId, spec.matrixKey);
      await startJobContainer({
        containerName,
        image: spec.image,
        worktreePath: spec.worktreePath,
        composeProjectName: spec.composeProjectName,
        env: spec.env,
        labels: spec.labels,
      });
      return {
        spawnStep: createJobScopedSpawnStep({ containerName, baseEnv: spec.env }),
        release: async () => {
          await stopJobContainer(containerName);
        },
      };
    },
  };
}
