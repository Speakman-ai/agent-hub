import { Router, Request, Response } from 'express';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import type { RouteDeps, SessionRow } from '../types.js';
import { userOwnsSession } from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';
import { discardSessionChanges } from '../session-discard.js';
import { sessionWorktreeIoFor } from '../session-worktree-io.js';

const DiscardErrorResponse = registerComponent(
  'SessionDiscardErrorResponse',
  z
    .object({
      error: z.string(),
      code: z.string().optional(),
    })
    .openapi({ description: 'Error envelope for the discard-changes route.' }),
);

export const DiscardChangesResponseSchema = registerComponent(
  'SessionDiscardChangesResponse',
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string(),
      baseRef: z.string().openapi({ description: 'Ref the fork point was measured against.' }),
      baseSha: z.string().openapi({ description: 'Commit the worktree was reset to.' }),
      discardedAt: z.string().nullable(),
    })
    .openapi({ description: 'The session worktree was reset and `changes_ready` cleared.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/discard-changes',
  tags: ['Sessions'],
  summary: "Discard a session's worktree changes",
  description:
    'Resets the session worktree to the commit its branch forked from on the base branch (dropping local commits and tracked edits), removes untracked files, clears `changes_ready`, and stamps `discarded_at`. Writes a system message and broadcasts `changes_discarded`. Refused while a turn is running, Finalize is in flight, or a PR for the branch is open. PR state is read live (native PR table for Agent Hub-hosted projects, `gh pr list` for GitHub); when it cannot be confirmed the request is refused.',
  request: { params: z.object({ sessionId: z.string() }) },
  responses: {
    200: { description: 'Changes discarded.', content: jsonContent(DiscardChangesResponseSchema) },
    400: { description: 'Session has no worktree.', content: jsonContent(DiscardErrorResponse) },
    404: { description: 'Session not found.', content: jsonContent(DiscardErrorResponse) },
    409: {
      description:
        'Refused: another operation holds the session worktree (`session_busy`), turn running (`session_running`), ship in progress (`ship_in_progress`), Finalize in flight (`finalize_in_flight`), PR open (`pr_open`), PR state could not be confirmed (`pr_state_unknown`), branch could not be read (`branch_unresolved`), or base branch or fork point unresolved (`base_unresolved`). Any git probe that fails before the reset refuses the request; reset and clean never run on a guess.',
      content: jsonContent(DiscardErrorResponse),
    },
    500: { description: 'git reset or clean failed.', content: jsonContent(DiscardErrorResponse) },
  },
});

export default function createSessionDiscardRoutes(deps: RouteDeps): Router {
  const { stmts, findAgent, activeProcesses, broadcast, config } = deps;
  const router = Router();

  router.post('/api/sessions/:sessionId/discard-changes', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    try {
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const found = findAgent(session.agent_id);
      if (!found) return res.status(404).json({ error: 'Agent not found' });

      const result = await discardSessionChanges({
        session,
        project: found.project,
        config,
        stmts,
        activeProcesses,
        broadcast,
        getIo: async () =>
          (await deps.getSessionWorktreeIo?.(sessionId)) ??
          sessionWorktreeIoFor(sessionId, session.worktree_path as string),
        drainQueue: deps.drainSessionQueue,
      });
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, code: result.code });
      }
      return res.json({
        ok: true,
        sessionId,
        baseRef: result.baseRef,
        baseSha: result.baseSha,
        discardedAt: result.discardedAt,
      });
    } catch (err) {
      console.error(`[session-discard] Error for session ${sessionId}:`, (err as Error).message);
      return res.status(500).json({ error: (err as Error).message, code: 'discard_failed' });
    }
  });

  return router;
}
