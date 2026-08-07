/**
 * Start a worktree preview for a chat session (user toolbar / API only).
 */
import { sessionUsesWorktree } from '../project-mode.js';
import { effectiveCwdForSession } from '../routes/hooks.js';
import { isDevServerConfigured } from '../dev-server-config.js';
import type { BroadcastFn, Project, SessionRow } from '../types.js';
import type { PreviewRuntimeLike } from './preview-block.js';
import { handlePreviewBlock, resolvePreviewHandlerReadyTimeoutMs } from './preview-block.js';
import type { PreviewTask } from './preview-block.js';
import { previewRoutingBlockReason, type PreviewRoutingInputs } from './preview-routing-mode.js';

export interface StartSessionPreviewBody {
  route?: string;
  reason?: string;
}

export type StartSessionPreviewDeps = {
  sessionId: string;
  body?: StartSessionPreviewBody;
  broadcast: BroadcastFn;
  findAgent: (agentId: string) => { project: Project; agent: { id: string } } | null;
  getDevServerRuntime?: () => DevServerRuntimeLike | null;
  getSession: (sessionId: string) => SessionRow | undefined;
  /** Deployment URL shape; see `previewRoutingBlockReason`. */
  routing?: PreviewRoutingInputs;
};

/**
 * The managed dev-server has its own runtime vocabulary (`start` and
 * `devServerId`). Adapt it here to the preview block's runtime shape
 * rather than teaching the handler about runtime internals.
 */
type DevServerRuntimeLike = {
  start: (
    sessionId: string,
    project: Project,
    worktreePath: string,
  ) => Promise<{ devServerId: string; url: string; port: number }>;
  getById: (devServerId: string) => { status: 'starting' | 'ready' | 'failed' } | null;
  getLogTail: (devServerId: string) => string[];
};

export type StartSessionPreviewResult =
  | { ok: true; started: true }
  | { ok: false; error: string; statusCode: number };

function defaultPreviewRoute(project: Project): string {
  const routes = project.prEnv?.devServer?.captureRoutes;
  if (Array.isArray(routes) && routes.length > 0 && typeof routes[0] === 'string') {
    const t = routes[0].trim();
    if (t.startsWith('/')) return t;
  }
  const healthPath = project.prEnv?.devServer?.healthPath;
  if (typeof healthPath === 'string' && healthPath.trim().startsWith('/')) {
    return healthPath.trim();
  }
  return '/';
}

function adaptDevServerRuntime(runtime: DevServerRuntimeLike): PreviewRuntimeLike {
  return {
    startPreview: async (sessionId, project, worktreePath) => {
      const result = await runtime.start(sessionId, project, worktreePath);
      return { previewId: result.devServerId, url: result.url, port: result.port };
    },
    getById: (previewId) => runtime.getById(previewId),
    getLogTail: (previewId) => runtime.getLogTail(previewId),
  };
}

export async function startSessionPreview(
  deps: StartSessionPreviewDeps,
): Promise<StartSessionPreviewResult> {
  const { sessionId, body, broadcast, findAgent, getSession } = deps;

  // Refuse before spawning anything. A path-prefix preview boots fine and
  // reports ready, so starting one just moves the failure somewhere it
  // looks like a bug in the user's app rather than in the deployment.
  if (deps.routing) {
    const blocked = previewRoutingBlockReason(deps.routing);
    if (blocked) return { ok: false, error: blocked, statusCode: 501 };
  }

  const session = getSession(sessionId);
  // A soft-deleted session is gone as far as every other consumer is concerned
  // (`SessionEnvManager.resolveWorktree`, `PtyHost.createSession`, the sidebar),
  // and it must be gone here too. Without this the start is accepted with
  // `{ok:true,started:true}` and then fails minutes later inside the env manager
  // as "has no workspace yet, wait for workspace provisioning to finish" —
  // pointing at a provisioning step that is not running and never will.
  if (!session || session.deleted_at) {
    return { ok: false, error: 'Session not found', statusCode: 404 };
  }

  const found = findAgent(session.agent_id);
  if (!found) {
    return { ok: false, error: 'Agent not found', statusCode: 404 };
  }

  const { project } = found;
  if (sessionUsesWorktree(session) && !session.worktree_path) {
    return {
      ok: false,
      error: 'Session workspace is not ready yet. Wait for workspace provisioning to finish.',
      statusCode: 409,
    };
  }
  const worktreePath = effectiveCwdForSession(project.cwd, session);
  const route =
    typeof body?.route === 'string' && body.route.trim().startsWith('/')
      ? body.route.trim()
      : defaultPreviewRoute(project);

  const task: PreviewTask = {
    target: 'client',
    route,
    reason:
      typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Started from session toolbar',
  };

  const devServerRuntime = isDevServerConfigured(project.prEnv?.devServer)
    ? (deps.getDevServerRuntime?.() ?? null)
    : null;

  void handlePreviewBlock(sessionId, task, {
    runtime: devServerRuntime ? adaptDevServerRuntime(devServerRuntime) : null,
    broadcast,
    project,
    worktreePath,
    readyTimeoutMs: resolvePreviewHandlerReadyTimeoutMs(project),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[preview] startSessionPreview handler error:', message);
  });

  return { ok: true, started: true };
}
