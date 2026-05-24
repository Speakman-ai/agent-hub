/**
 * Start a worktree preview for a chat session (user toolbar / API only).
 */
import config from '../config.js';
import { effectiveCwdForSession } from '../routes/hooks.js';
import type { BroadcastFn, Project, SessionRow } from '../types.js';
import type { PreviewRuntimeLike } from './preview-block.js';
import { handlePreviewBlock, resolvePreviewHandlerReadyTimeoutMs } from './preview-block.js';
import type { PreviewTask } from './preview-block.js';

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
  getSession: (sessionId: string) => SessionRow | undefined;
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

  const composeConfigured = !!project.prEnv?.preview?.compose?.entryService;
  const previewRuntime = composeConfigured
    ? (deps.getPreviewComposeRuntime?.() ?? null)
    : (deps.getPreviewRuntime?.() ?? null);

  void handlePreviewBlock(sessionId, task, {
    runtime: previewRuntime,
    broadcast,
    project,
    worktreePath,
    readyTimeoutMs: resolvePreviewHandlerReadyTimeoutMs(
      project,
      config.previewComposeReadyTimeoutMs,
    ),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[preview] startSessionPreview handler error:', message);
  });

  return { ok: true, started: true };
}
