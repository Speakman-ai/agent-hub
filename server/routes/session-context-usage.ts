import { Router, Request, Response } from 'express';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import type { RouteDeps, SessionRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { userOwnsSession } from '../session-ownership.js';
import { getDb } from '../db.js';
import {
  CONTEXT_CATEGORY_KEYS,
  buildContextUsageReport,
  getContextUsageSnapshot,
} from '../session-context-usage.js';

const ErrorResponse = registerComponent(
  'SessionContextUsageErrorResponse',
  z.object({ error: z.string() }),
);

export const ContextUsageResponseSchema = registerComponent(
  'SessionContextUsage',
  z
    .object({
      sessionId: z.string(),
      engine: z.string().nullable(),
      model: z.string().nullable(),
      source: z.enum(['reported', 'estimated', 'none']).openapi({
        description:
          '`reported`: the total comes from the engine (Claude Code per-step usage). `estimated`: ~4 characters per token. `none`: nothing recorded yet.',
      }),
      totalTokens: z.number().int().nonnegative(),
      contextWindow: z.number().int().positive().nullable().openapi({
        description: 'Context window of the session model, or null when unknown.',
      }),
      percent: z
        .number()
        .nullable()
        .openapi({ description: 'totalTokens / contextWindow, 0-100.' }),
      categories: z.array(
        z.object({
          key: z.enum(CONTEXT_CATEGORY_KEYS),
          label: z.string(),
          tokens: z.number().int().nonnegative(),
        }),
      ),
      updatedAt: z.string().nullable(),
    })
    .openapi({
      description:
        "Context-window usage for the session's latest turn, split by source. Hub prompt sections are estimated from their size; the engine and conversation shares are derived from the engine-reported total when available.",
    }),
);

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/context-usage',
  tags: ['Sessions'],
  summary: 'Get context-window usage for a session',
  description:
    "Breaks the latest turn's context down into system prompt, rules and context files, skills, wiki and retrieval, memory, the engine's own prompt and tools, and conversation. Owner only.",
  request: { params: z.object({ sessionId: z.string() }) },
  responses: {
    200: {
      description: 'Context usage report.',
      content: { 'application/json': { schema: ContextUsageResponseSchema } },
    },
    404: {
      description: 'Session not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

export default function createSessionContextUsageRoutes(deps: RouteDeps): Router {
  const { stmts } = deps;
  const router = Router();

  router.get('/api/sessions/:sessionId/context-usage', (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId);
    if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session || session.deleted_at) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const db = getDb();
    const { chars } = db
      .prepare(
        'SELECT COALESCE(SUM(LENGTH(content)), 0) AS chars FROM messages WHERE session_id = ?',
      )
      .get(sessionId) as { chars: number };
    res.json(
      buildContextUsageReport({
        sessionId,
        engine: session.engine ?? null,
        model: session.model ?? null,
        snapshot: getContextUsageSnapshot(db, sessionId),
        transcriptChars: Number(chars) || 0,
      }),
    );
  });

  return router;
}
