import { Router, Request, Response } from 'express';
import type { RouteDeps, SessionRow } from '../types.js';
import { sessionUsesWorktree } from '../project-mode.js';

/**
 * Must match chat.ts: when worktree is off, the CLI runs in project.cwd even if
 * a stale worktree_path remains on the session row.
 */
export function effectiveCwdForSession(projectCwd: string, session: SessionRow): string {
  if (sessionUsesWorktree(session) && session.worktree_path) {
    return session.worktree_path;
  }
  return projectCwd;
}

export default function createHookRoutes(deps: RouteDeps): Router {
  const { stmts, findAgent } = deps;
  const router = Router();

  /**
   * Claude Code invokes this when a session stops. Auto-commit / `changes_ready`
   * runs from `chat.ts` proc.on('close') after a short filesystem settle delay, so
   * we only log here — the old hook-first path could mark "handled" while git was
   * still clean and skip the proc fallback (missing Create PR banner).
   */
  router.post('/api/hooks/stop', async (req: Request, res: Response) => {
    const { sessionId } = req.body as { sessionId?: string };

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const session = stmts.getSession.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ ok: true, sessionId });

    const found = findAgent((session as { agent_id: string }).agent_id);
    if (!found) {
      console.warn(`[hooks/stop] Agent not found for session ${sessionId}`);
      return;
    }
    const { project, agent } = found;
    const cwd = effectiveCwdForSession(project.cwd, session as SessionRow);
    console.log(
      `[hooks/stop] Stop hook for session ${sessionId} (agent: ${agent.name}, cwd: ${cwd}) — auto-commit runs from chat proc`,
    );
  });

  return router;
}
