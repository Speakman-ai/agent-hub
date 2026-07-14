/**
 * Start a worktree preview for a chat session (user toolbar / API only).
 */
import config from '../config.js';
import { sessionUsesWorktree } from '../project-mode.js';
import { effectiveCwdForSession } from '../routes/hooks.js';
import type { BroadcastFn, Project, SessionRow } from '../types.js';
import type { PreviewRuntimeLike } from './preview-block.js';
import { handlePreviewBlock, resolvePreviewHandlerReadyTimeoutMs } from './preview-block.js';
import type { PreviewTask } from './preview-block.js';
import { projectWithWorktreePreviewOverride } from './worktree-preview-config.js';

export interface StartSessionPreviewBody {
  route?: string;
  reason?: string;
}

export type StartSessionPreviewDeps = {
  sessionId: string;
  body?: StartSessionPreviewBody;
  broadcast: BroadcastFn;
  findAgent: (agentId: string) => { project: Project; agent: { id: string } } | null;
  getPreviewRuntime?: () => PreviewRuntimeLike | null;
  getPreviewComposeRuntime?: () => PreviewRuntimeLike | null;
  getDevServerRuntime?: () => DevServerRuntimeLike | null;
  getSession: (sessionId: string) => SessionRow | undefined;
};

/**
 * The managed dev-server has its own runtime vocabulary (`start` and
 * `devServerId`). Adapt it here to the preview block's shared runtime shape
 * rather than making the legacy/compose handler know about each runtime.
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
  const routes = project.prEnv?.preview?.captureRoutes;
  if (Array.isArray(routes) && routes.length > 0 && typeof routes[0] === 'string') {
    const t = routes[0].trim();
    if (t.startsWith('/')) return t;
  }
  const composeHealth = project.prEnv?.preview?.compose?.healthPath;
  if (typeof composeHealth === 'string' && composeHealth.trim().startsWith('/')) {
    return composeHealth.trim();
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
  const session = getSession(sessionId);
  if (!session) {
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
  // Let the session worktree's .agent-hub/preview.json drive its own preview
  // compose config (e.g. entryWorkdir live-mount → HMR). The runtime otherwise
  // reads only the project record, so a committed repo edit wouldn't take effect.
  const effectiveProject = projectWithWorktreePreviewOverride(project, worktreePath);
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

  const devServerConfigured = !!effectiveProject.prEnv?.devServer;
  const composeConfigured = !!effectiveProject.prEnv?.preview?.compose?.entryService;
  const devServerRuntime = devServerConfigured ? (deps.getDevServerRuntime?.() ?? null) : null;
  const previewRuntime = devServerConfigured
    ? devServerRuntime
      ? adaptDevServerRuntime(devServerRuntime)
      : null
    : composeConfigured
      ? (deps.getPreviewComposeRuntime?.() ?? null)
      : (deps.getPreviewRuntime?.() ?? null);

  void handlePreviewBlock(sessionId, task, {
    runtime: previewRuntime,
    broadcast,
    project: effectiveProject,
    worktreePath,
    readyTimeoutMs: resolvePreviewHandlerReadyTimeoutMs(
      effectiveProject,
      config.previewComposeReadyTimeoutMs,
    ),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[preview] startSessionPreview handler error:', message);
  });

  return { ok: true, started: true };
}
