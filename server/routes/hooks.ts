import { Router, Request, Response } from 'express';
import { autoCommitAndPR } from '../auto-git.js';
import type { RouteDeps } from '../types.js';

const inFlight = new Set<string>();
const completed = new Set<string>();

export function hookHandled(sessionId: string): boolean {
  return inFlight.has(sessionId) || completed.has(sessionId);
}

export function clearCompleted(sessionId: string): void {
  completed.delete(sessionId);
}

export default function createHookRoutes(deps: RouteDeps): Router {
  const { stmts, findAgent } = deps;
  const router = Router();

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

    if (inFlight.has(sessionId)) {
      console.log(`[hooks/stop] Skipping duplicate hook for session ${sessionId}`);
      return;
    }
    inFlight.add(sessionId);

    const found = findAgent((session as { agent_id: string }).agent_id);
    if (!found) {
      console.warn(`[hooks/stop] Agent not found for session ${sessionId}`);
      return;
    }
    const { project, agent } = found;

    const effectiveCwd = (session as { worktree_path?: string }).worktree_path || project.cwd;

    console.log(
      `[hooks/stop] Hook fired for session ${sessionId} (agent: ${agent.name}, cwd: ${effectiveCwd})`,
    );

    let finalContent = '';
    try {
      const lastMsg = stmts.getLastAssistantMessage.get(sessionId) as
        | { content?: string }
        | undefined;
      finalContent = lastMsg?.content || '';
    } catch {
      // Non-critical — auto-commit works without it
    }

    try {
      await autoCommitAndPR(
        sessionId,
        (session as { agent_id: string }).agent_id,
        project,
        agent,
        effectiveCwd,
        finalContent,
      );
    } catch (err) {
      console.error(
        `[hooks/stop] Auto-commit failed for session ${sessionId}:`,
        (err as Error).message,
      );
    } finally {
      inFlight.delete(sessionId);
      completed.add(sessionId);
      setTimeout(() => completed.delete(sessionId), 300_000);
    }
  });

  return router;
}
