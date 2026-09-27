/**
 * Production wiring for the mainline Autopilot deploy watcher, and the
 * ownership check push/merge deploy triggers use to stay off an environment a
 * mainline session deploys.
 */
import type { AppConfig, BroadcastFn, Project, Stmts } from './types.js';
import { getDb } from './db.js';
import {
  createMainlineDeployWatcher,
  listMainlineWatcherSessions,
  type MainlineDeployWatcher,
} from './autopilot-mainline-deploy-watcher.js';
import { setMainlineSlotLandedListener } from './session-autopilot-slot.js';
import { postAutopilotSystemNotice } from './session-autopilot.js';
import {
  findMainlineEnvironmentOwner,
  listMainlineAutopilotCandidates,
} from './session-autopilot-mainline-start.js';
import { triggerDeployment } from './deploy/deploy-orchestrator.js';
import { buildDeployOrchestratorDeps } from './deploy/deploy-trigger-hook.js';
import { prepareDeploymentCheckout, readDeployYamlAtCommit } from './deploy/deployment-checkout.js';
import { getDeployment, listDeploymentsByLandingKey } from './deploy/deployment-store.js';
import { isEnvironmentDeployable } from './deploy/deployment-env-config-store.js';

type FindAgent = (agentId: string) => { project?: Project | null } | null | undefined;

/**
 * Whether a mainline session owns `projectId`/`environment` (live run, or a
 * slot that still owes a landing). Push/merge triggers skip such an
 * environment: Autopilot starts that deploy itself.
 */
export function mainlineSessionOwnsEnvironment(
  findAgent: FindAgent,
  projectId: string,
  environment: string,
): boolean {
  try {
    return (
      findMainlineEnvironmentOwner({
        candidates: listMainlineAutopilotCandidates(getDb()),
        projectOf: (agentId) => findAgent(agentId)?.project?.id ?? null,
        projectId,
        environment,
        excludeSessionId: '',
      }) !== null
    );
  } catch (err) {
    console.warn(
      `[autopilot-deploy] ownership check failed for ${projectId}/${environment}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export function initMainlineDeployWatcher(args: {
  stmts: Stmts;
  broadcast: BroadcastFn;
  config: AppConfig;
  findProject: (id: string) => Project | null | undefined;
  findAgent: FindAgent;
  orgId: () => string;
}): MainlineDeployWatcher {
  const { stmts, broadcast, config, findProject, findAgent } = args;
  const prepareCheckout = ({ project, ref }: { project: Project; ref: string }) =>
    prepareDeploymentCheckout({ project, ref });
  const watcher = createMainlineDeployWatcher({
    stmts,
    listCandidates: () => listMainlineWatcherSessions(getDb()),
    findProjectForAgent: (agentId) => findAgent(agentId)?.project ?? null,
    readDeployYamlAtCommit: (project, sha) => readDeployYamlAtCommit({ project, sha }),
    isEnvironmentDeployable,
    prepareCheckout: (project, sha) => prepareCheckout({ project, ref: sha }),
    triggerDeployment: (input) =>
      triggerDeployment(
        input,
        buildDeployOrchestratorDeps({
          broadcast,
          config,
          findProject,
          prepareCheckout,
          overrides: { orgId: args.orgId() },
        }),
      ),
    listDeploymentsByLandingKey,
    getDeployment,
    postNotice: (sessionId, content) =>
      postAutopilotSystemNotice({ stmts, broadcast }, sessionId, content),
  });
  setMainlineSlotLandedListener(() => watcher.kick());
  watcher.start();
  return watcher;
}
