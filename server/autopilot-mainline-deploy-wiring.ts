/**
 * Production wiring for the mainline Autopilot deploy watcher, and the
 * ownership check push/merge deploy triggers use to stay off an environment a
 * mainline session deploys.
 */
import { existsSync } from 'fs';
import path from 'path';
import type { AppConfig, BroadcastFn, ChatMessage, Project, SessionRow, Stmts } from './types.js';
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
import {
  createMainlineReconciler,
  type MainlineReconcilerDeps,
} from './autopilot-mainline-reconciler.js';
import {
  checkCommitOnRemoteBranch,
  type RemoteCheckSource,
  type RemoteCommitAnswer,
} from './autopilot-mainline-remote-check.js';
import { assertMainlineOrigin, isMainlinePushLive } from './finalize/push-to-default-branch.js';
import { resolveMainlineGitEnv } from './finalize/push-run.js';
import { gitHostRepoPath } from './git-host/repo-store.js';
import {
  createMainlineReportDelivery,
  findMainlineReportKey,
} from './autopilot-mainline-report.js';
import { kickoffSeededTurn } from './seeded-session-kickoff.js';

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

/**
 * Where to read the remote's default branch for a session:
 * - Hub-hosted: the hosted bare repo is the remote, so read its ref directly.
 * - Otherwise: fetch through the session worktree, whose origin was checked
 *   by the same guard the push uses. Without a worktree there is nothing
 *   verified to fetch through, and the answer stays unknown.
 */
export async function resolveRemoteCheckSource(args: {
  session: Pick<SessionRow, 'id' | 'worktree_path'>;
  project: Project;
  config: AppConfig;
}): Promise<RemoteCheckSource> {
  const { session, project, config } = args;
  if (project.gitHost === 'agenthub') {
    const hosted = gitHostRepoPath(project.id);
    if (existsSync(path.join(hosted, 'HEAD'))) return { kind: 'local', repoPath: hosted };
  }
  const worktree = session.worktree_path;
  if (!worktree || !existsSync(worktree)) {
    throw new Error('the session worktree is gone, so the remote cannot be fetched');
  }
  const env = await resolveMainlineGitEnv(config, project, session.id);
  await assertMainlineOrigin({ project, worktreePath: worktree, env });
  return { kind: 'fetch', repoPath: worktree, env };
}

export function initMainlineDeployWatcher(args: {
  stmts: Stmts;
  broadcast: BroadcastFn;
  config: AppConfig;
  findProject: (id: string) => Project | null | undefined;
  findAgent: FindAgent;
  orgId: () => string;
  /** Start Finalize again after the reconciler found a push absent. */
  restartFinalize: MainlineReconcilerDeps['restartFinalize'];
  /** Chat entry point for the verify turn. Dispatched, never awaited by the sweep. */
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
}): MainlineDeployWatcher {
  const { stmts, broadcast, config, findProject, findAgent } = args;
  const postNotice = (sessionId: string, content: string) =>
    postAutopilotSystemNotice({ stmts, broadcast }, sessionId, content);
  const reconciler = createMainlineReconciler({
    stmts,
    isPushLive: isMainlinePushLive,
    checkRemote: async ({ session, sha, branch }): Promise<RemoteCommitAnswer> => {
      const project = findAgent(session.agent_id)?.project ?? null;
      if (!project) return { kind: 'unknown', detail: 'project not found for this session' };
      const row = stmts.getSession.get(session.id) as SessionRow | undefined;
      if (!row) return { kind: 'unknown', detail: 'session row not found' };
      const source = await resolveRemoteCheckSource({ session: row, project, config });
      return checkCommitOnRemoteBranch({ source, sha, branch });
    },
    restartFinalize: args.restartFinalize,
    postNotice,
  });
  let watcher: MainlineDeployWatcher | null = null;
  const reporter = createMainlineReportDelivery({
    stmts,
    findReportKey: (sessionId, key) => findMainlineReportKey(getDb(), sessionId, key),
    dispatchTurn: (session, content, acceptTurn) =>
      kickoffSeededTurn({
        acceptTurn,
        handleChat: args.handleChat,
        agentId: session.agent_id,
        sessionId: session.id,
        content,
        onBackgroundError: (err) =>
          console.warn(
            `[autopilot-report] verify turn failed after delivery session=${session.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      }),
    postNotice,
    requestSweep: () => watcher?.kick(),
  });
  const prepareCheckout = ({ project, ref }: { project: Project; ref: string }) =>
    prepareDeploymentCheckout({ project, ref });
  const created = createMainlineDeployWatcher({
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
    postNotice,
    reconcile: (session) => reconciler.reconcile(session),
    report: (session) => reporter.deliver(session),
  });
  watcher = created;
  setMainlineSlotLandedListener(() => created.kick());
  created.start();
  return created;
}
