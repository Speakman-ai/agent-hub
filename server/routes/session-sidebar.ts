import { Router, Request, Response } from 'express';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import type { RouteDeps, SessionRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { userOwnsSession } from '../session-ownership.js';
import { enrichSessionForClient } from '../session-checkpoint-rewind.js';
import {
  SidebarError,
  closeSidebars,
  getLiveSidebar,
  isSidebarSession,
  openSidebar,
} from '../session-sidebar.js';

const MAX_SIDEBAR_PROMPT_LENGTH = 50_000;

const SidebarErrorResponse = registerComponent(
  'SessionSidebarErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for SideBar routes.' }),
);

const SidebarSessionSchema = z
  .object({
    id: z.string(),
    agent_id: z.string(),
    name: z.string(),
    engine: z.string(),
    model: z.string(),
    session_mode: z.string(),
    sidebar_parent_id: z.string(),
    sidebar_seq: z.number().int().openapi({
      description:
        'Per-parent creation order. A client seeing two SideBars for one session keeps the higher.',
    }),
  })
  .passthrough()
  .openapi({ description: 'The hidden Consult-mode child session behind the SideBar.' });

export const GetSidebarResponseSchema = registerComponent(
  'SessionSidebarGetResponse',
  z.object({
    session: SidebarSessionSchema.nullable(),
    running: z
      .boolean()
      .openapi({ description: 'True while a SideBar turn is in flight (e.g. after a reload).' }),
  }),
);

export const OpenSidebarRequestSchema = registerComponent(
  'SessionSidebarOpenRequest',
  z
    .object({
      content: z
        .string()
        .min(1)
        .max(MAX_SIDEBAR_PROMPT_LENGTH)
        .optional()
        .openapi({ description: 'First question. When set, the SideBar turn starts at once.' }),
    })
    .strict(),
);

export const OpenSidebarResponseSchema = registerComponent(
  'SessionSidebarOpenResponse',
  z.object({
    session: SidebarSessionSchema,
    forked: z.boolean().openapi({
      description:
        "True when the first turn forks the parent's Claude Code conversation; false when it is seeded with the parent's transcript instead.",
    }),
    closedSessionIds: z.array(z.string()),
  }),
);

const CloseSidebarResponseSchema = registerComponent(
  'SessionSidebarCloseResponse',
  z.object({ ok: z.literal(true), closedSessionIds: z.array(z.string()) }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});
const params = z.object({ sessionId: z.string() });

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/sidebar',
  tags: ['Sessions'],
  summary: "Get a session's SideBar",
  description:
    'Returns the live SideBar child session for this session, or `null`. Load its messages with `GET /api/sessions/{id}/messages` on the returned id. Owner only.',
  request: { params },
  responses: {
    200: { description: 'SideBar (or null).', content: jsonContent(GetSidebarResponseSchema) },
    404: { description: 'Session not found.', content: jsonContent(SidebarErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/sidebar',
  tags: ['Sessions'],
  summary: 'Open a new SideBar',
  description:
    "Forks the session into a hidden Consult-mode child for side questions, archiving any previous SideBar (one per session). The child uses the parent's agent, engine, and model, runs in the parent's checkout, and never writes to the parent. On Claude Code its first turn forks the parent's CLI conversation; other engines get the parent's transcript as context. Follow-up questions go over the WebSocket `chat` message with the child's session id. Owner only.",
  request: {
    params,
    body: { content: jsonContent(OpenSidebarRequestSchema) },
  },
  responses: {
    201: { description: 'SideBar opened.', content: jsonContent(OpenSidebarResponseSchema) },
    400: {
      description: 'Invalid body, or the session is itself a SideBar.',
      content: jsonContent(SidebarErrorResponse),
    },
    404: { description: 'Session not found.', content: jsonContent(SidebarErrorResponse) },
  },
});

registerPath({
  method: 'delete',
  path: '/api/sessions/{sessionId}/sidebar',
  tags: ['Sessions'],
  summary: 'Close the SideBar',
  description: 'Stops any SideBar turn in flight and archives the SideBar. Owner only.',
  request: { params },
  responses: {
    200: { description: 'SideBar closed.', content: jsonContent(CloseSidebarResponseSchema) },
    404: { description: 'Session not found.', content: jsonContent(SidebarErrorResponse) },
  },
});

export default function createSessionSidebarRoutes(deps: RouteDeps): Router {
  const { stmts, findAgent, activeProcesses, broadcast, handleChat } = deps;
  const router = Router();

  /** Owned, live, non-SideBar parent session, or null after writing a 4xx. */
  const loadParent = (req: Request, res: Response): SessionRow | null => {
    const sessionId = String(req.params.sessionId);
    // The SideBar holds a fork of the transcript, so reads are owner-only too.
    if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session || session.deleted_at) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return session;
  };

  router.get('/api/sessions/:sessionId/sidebar', (req: Request, res: Response) => {
    const parent = loadParent(req, res);
    if (!parent) return;
    const sidebar = getLiveSidebar(stmts, parent.id);
    res.json({
      session: sidebar ? enrichSessionForClient(sidebar, stmts) : null,
      running: sidebar ? activeProcesses.has(sidebar.id) : false,
    });
  });

  router.post('/api/sessions/:sessionId/sidebar', (req: Request, res: Response) => {
    try {
      const parsed = OpenSidebarRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      const parent = loadParent(req, res);
      if (!parent) return;
      if (isSidebarSession(parent)) {
        return res.status(400).json({ error: 'A SideBar session cannot open its own SideBar' });
      }
      const found = findAgent(parent.agent_id);
      if (!found) return res.status(404).json({ error: 'Agent not found' });

      const { session, closedIds, forked } = openSidebar({
        stmts,
        parent,
        agentName: found.agent.name || parent.agent_id,
        activeProcesses,
      });
      const wire = enrichSessionForClient(session, stmts);
      for (const id of closedIds) broadcast({ type: 'sidebar_closed', sessionId: id });
      broadcast({
        type: 'sidebar_opened',
        sessionId: session.id,
        parentSessionId: parent.id,
        session: wire,
      });

      const content = parsed.data.content?.trim();
      if (content) {
        void handleChat(null, {
          type: 'chat',
          agentId: parent.agent_id,
          sessionId: session.id,
          content,
        }).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[sidebar] first turn failed for ${session.id}: ${message}`);
        });
      }
      res.status(201).json({ session: wire, forked, closedSessionIds: closedIds });
    } catch (err) {
      if (err instanceof SidebarError) return res.status(err.status).json({ error: err.message });
      console.error('[sidebar] open failed:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/sessions/:sessionId/sidebar', (req: Request, res: Response) => {
    const parent = loadParent(req, res);
    if (!parent) return;
    const closedIds = closeSidebars({ stmts, parentId: parent.id, activeProcesses });
    for (const id of closedIds) broadcast({ type: 'sidebar_closed', sessionId: id });
    res.json({ ok: true, closedSessionIds: closedIds });
  });

  return router;
}
