/**
 * Hook callback routes — receives notifications from Claude Code's
 * Stop/SubagentStop hooks and triggers post-session automation
 * (auto-commit, PR creation, lead review).
 */

import { Router } from 'express';
import { autoCommitAndPR } from '../auto-git.js';

// Tracks sessions with an in-flight or completed autoCommitAndPR call to prevent
// double-fire when both Stop and SubagentStop hooks trigger for the same session,
// and to let proc.on('close') fallback know that hooks already handled it.
const inFlight = new Set();
const completed = new Set();

/**
 * Check whether hook-driven auto-commit has already run (or is running) for a session.
 * Used by proc.on('close') fallback in chat.js to avoid double-runs.
 */
export function hookHandled(sessionId) {
  return inFlight.has(sessionId) || completed.has(sessionId);
}

/**
 * @param {object} deps - Route dependencies from index.js
 * @returns {Router}
 */
export default function createHookRoutes(deps) {
  const { stmts, findAgent } = deps;
  const router = Router();

  /**
   * POST /api/hooks/stop
   *
   * Called by Claude Code Stop/SubagentStop hooks when an agent finishes work.
   * Triggers auto-commit-and-PR flow for the session's worktree.
   *
   * Body: { sessionId: string }
   */
  router.post('/api/hooks/stop', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const session = stmts.getSession.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Respond immediately — auto-commit runs asynchronously
    res.json({ ok: true, sessionId });

    // Debounce: skip if autoCommitAndPR is already running for this session
    // (both Stop and SubagentStop hooks fire, so this prevents double-fire)
    if (inFlight.has(sessionId)) {
      console.log(`[hooks/stop] Skipping duplicate hook for session ${sessionId}`);
      return;
    }
    inFlight.add(sessionId);

    // Look up project and agent context — findAgent returns { project, agent }
    const found = findAgent(session.agent_id);
    if (!found) {
      console.warn(`[hooks/stop] Agent not found for session ${sessionId}`);
      return;
    }
    const { project, agent } = found;

    // Determine the effective working directory (worktree or project cwd)
    const effectiveCwd = session.worktree_path || project.cwd;

    console.log(
      `[hooks/stop] Hook fired for session ${sessionId} (agent: ${agent.name}, cwd: ${effectiveCwd})`,
    );

    // Retrieve the last assistant message as finalContent for context.
    // Uses a targeted query instead of loading all messages for the session.
    let finalContent = '';
    try {
      const lastMsg = stmts.getLastAssistantMessage.get(sessionId);
      finalContent = lastMsg?.content || '';
    } catch {
      // Non-critical — auto-commit works without it
    }

    try {
      await autoCommitAndPR(
        sessionId,
        session.agent_id,
        project,
        agent,
        effectiveCwd,
        finalContent,
      );
    } catch (err) {
      console.error(`[hooks/stop] Auto-commit failed for session ${sessionId}:`, err.message);
    } finally {
      inFlight.delete(sessionId);
      completed.add(sessionId);
      // Clean up completed set after 60s to avoid unbounded growth
      setTimeout(() => completed.delete(sessionId), 60_000);
    }
  });

  return router;
}
