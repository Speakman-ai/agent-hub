/**
 * Registers the process-wide PR environment runtime: the runner fleet when
 * `FINALIZE_RUNNER_BACKEND=remote`, else DinD on this host.
 * `AGENT_HUB_PR_ENVIRONMENTS=off` leaves it unregistered (rows stay queued).
 */
import type { Project } from '../types.js';
import { parseDeployConfig } from '../deploy/deploy-config.js';
import { readDeployYamlAtCommit } from '../deploy/deployment-checkout.js';
import { resolvePreviewSecretEnv } from '../deploy/deploy-preview-secrets.js';
import type { PreviewConfig } from '../deploy/deploy-preview-config.js';
import { resolveBundleStore, resolveRunnerBackendKind } from '../finalize/runner-backend.js';
import { getActiveOrgId } from '../orgs.js';
import { setPrEnvironmentRuntime } from './pr-environments.js';
import {
  createLocalEnvironmentRunner,
  createRemoteEnvironmentRunner,
  type EnvironmentRunner,
} from './pr-environment-runner.js';
import {
  createRunnerPrEnvironmentRuntime,
  type RunnerPrEnvironmentRuntime,
} from './pr-environment-runner-runtime.js';

export function prEnvironmentsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(0|off|false|no)$/i.test(env.AGENT_HUB_PR_ENVIRONMENTS?.trim() ?? '');
}

/** The `preview:` block at exactly `headSha`, or null when it has none. */
export async function readPreviewConfigAtSha(
  project: Project,
  headSha: string,
): Promise<PreviewConfig | null> {
  const at = await readDeployYamlAtCommit({ project, sha: headSha });
  return at.kind === 'present' ? parseDeployConfig(at.raw).preview : null;
}

export function resolveEnvironmentRunner(env: NodeJS.ProcessEnv = process.env): EnvironmentRunner {
  return resolveRunnerBackendKind(env) === 'remote'
    ? createRemoteEnvironmentRunner({ store: resolveBundleStore() })
    : createLocalEnvironmentRunner({ env });
}

export function registerPrEnvironmentRuntime(): RunnerPrEnvironmentRuntime | null {
  if (prEnvironmentsDisabled()) {
    console.log('[pr-env] runtime disabled (AGENT_HUB_PR_ENVIRONMENTS=off)');
    return null;
  }
  const runner = resolveEnvironmentRunner();
  const runtime = createRunnerPrEnvironmentRuntime({
    runner,
    readPreviewConfig: readPreviewConfigAtSha,
    resolveSecrets: (preview, projectId) => resolvePreviewSecretEnv(preview, projectId),
    orgId: () => {
      try {
        return getActiveOrgId();
      } catch {
        return '';
      }
    },
  });
  setPrEnvironmentRuntime(runtime);
  console.log(`[pr-env] runtime registered (${runner.kind} runner)`);
  return runtime;
}
