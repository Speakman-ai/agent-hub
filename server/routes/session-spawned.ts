/**
 * GET /api/sessions/:sessionId/spawned — worker sessions started from an
 * Orchestrate parent. The right rail reads this; the left session list does not.
 */
import { Router, type Request, type Response } from 'express';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import type { RouteDeps, SessionRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { userOwnsSession } from '../session-ownership.js';
import { enrichSessionForClient } from '../session-checkpoint-rewind.js';

const SpawnedSessionSchema = registerComponent(
  'SpawnedSession',
  z
    .object({
      id: z.string(),
      name: z.string(),
      agent_id: z.string(),
      state: z.string(),
      updated_at: z.string(),
      finalize_status: z.string().nullable(),
      needs_input: z.string().nullable(),
      needs_input_at: z.number().nullable(),
      last_turn_error: z.string().nullable(),
    })
    .openapi({ description: 'A Hub session started from an Orchestrate parent.' }),
);

const SpawnedArchivedSessionSchema = registerComponent(
  'SpawnedArchivedSession',
  z
    .object({
      id: z.string(),
      name: z.string(),
      agent_id: z.string(),
      deleted_at: z.string(),
    })
    .openapi({
      description: 'A soft-deleted Orchestrate worker still inside the recovery window.',
    }),
);

const GetSpawnedSessionsResponse = registerComponent(
  'GetSpawnedSessionsResponse',
  z.object({
    parent: z.object({
      id: z.string(),
      name: z.string(),
      agent_id: z.string(),
      up: z.object({ id: z.string(), name: z.string(), agent_id: z.string() }).nullable().openapi({
        description:
          'When this chat is itself a worker that was switched to Orchestrate, the Orchestrate chat that started it, so the rail can link back up. Null otherwise.',
      }),
    }),
    sessions: z.array(SpawnedSessionSchema),
    archived: z.array(SpawnedArchivedSessionSchema),
  }),
);

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/spawned',
  tags: ['Sessions'],
  summary: 'List sessions spawned from an Orchestrate chat',
  description:
    'Owner-only. Returns worker sessions whose `spawned_from_session_id` is this session, newest first, plus soft-deleted workers still inside the 24-hour recovery window. Live rows are omitted from the agent session list.',
  request: { params: z.object({ sessionId: z.string() }) },
  responses: {
    200: {
      description: 'Parent summary and its spawned sessions.',
      content: { 'application/json': { schema: GetSpawnedSessionsResponse } },
    },
    404: {
      description: 'Session not found, or the caller does not own it.',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
  },
});

export default function createSessionSpawnedRoutes(
  deps: Pick<RouteDeps, 'stmts' | 'findAgent'>,
): Router {
  const router = Router();
  const { stmts, findAgent } = deps;

  // A worker switched to Orchestrate lists its own workers; this is the way
  // back to the chat that started it.
  const upLink = (req: AuthenticatedRequest, parent: SessionRow) => {
    const upId = parent.spawned_from_session_id;
    if (!upId || !userOwnsSession(req, upId)) return null;
    const up = stmts.getSession.get(upId) as SessionRow | undefined;
    if (!up || up.deleted_at) return null;
    return { id: up.id, name: up.name || 'New session', agent_id: up.agent_id };
  };

  router.get('/api/sessions/:sessionId/spawned', (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId);
    if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const parent = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!parent || parent.deleted_at) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const project = findAgent(parent.agent_id)?.project ?? null;
    const rows = stmts.getSpawnedSessions.all(sessionId) as SessionRow[];
    const archived = stmts.getArchivedSpawnedSessions.all(sessionId) as SessionRow[];
    res.json({
      parent: {
        id: parent.id,
        name: parent.name,
        agent_id: parent.agent_id,
        up: upLink(req as AuthenticatedRequest, parent),
      },
      sessions: rows.map((row) => {
        const enriched = enrichSessionForClient(row, stmts, project);
        return {
          id: enriched.id,
          name: enriched.name,
          agent_id: enriched.agent_id,
          state: enriched.state,
          updated_at: enriched.updated_at,
          finalize_status: enriched.finalize_status ?? null,
          needs_input: enriched.needs_input ?? null,
          needs_input_at: enriched.needs_input_at ?? null,
          last_turn_error: enriched.last_turn_error ?? null,
        };
      }),
      archived: archived.map((row) => ({
        id: row.id,
        name: row.name || 'New session',
        agent_id: row.agent_id,
        deleted_at: row.deleted_at || '',
      })),
    });
  });

  return router;
}
