/**
 * A session's "Run QA Tests" (`/api/sessions/:sessionId/qa-request`): the
 * checkbox before merge and the button after it. Gated by `userOwnsSession`;
 * the lifecycle lives in `qa-session-runs.ts`.
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { getDefaultQaEnvironment, getQaProjectSettings } from '../qa-environments.js';
import { findProjectQaAgent } from '../qa-authoring.js';
import {
  getQaSessionRequest,
  QaSessionRequestError,
  reconcileSessionMerge,
  runQaSessionRequestNow,
  serializeQaSessionRequest,
  sessionMergedAt,
  setQaSessionRequestArmed,
  type QaSessionRunDeps,
} from '../qa-session-runs.js';
import { userOwnsSession } from '../session-ownership.js';
import type { Project, RouteDeps, SessionRow } from '../types.js';
import { SetQaSessionRequestArmedSchema } from './qa-session-runs.openapi.js';

export default function createQaSessionRunRoutes(
  deps: QaSessionRunDeps & Pick<RouteDeps, 'findAgent' | 'stmts'>,
): Router {
  const router = Router();
  const PATH = '/api/sessions/:sessionId/qa-request';

  const load = (req: Request, res: Response): { session: SessionRow; project: Project } | null => {
    const sessionId = req.params.sessionId as string;
    const session = userOwnsSession(req as AuthenticatedRequest, sessionId)
      ? ((deps.stmts.getSession.get(sessionId) as SessionRow | undefined) ?? null)
      : null;
    const project = session ? (deps.findAgent(session.agent_id)?.project ?? null) : null;
    if (!session || session.deleted_at || !project) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return { session, project };
  };

  const state = (session: SessionRow, project: Project) => {
    const row = getQaSessionRequest(session.id);
    const env = getDefaultQaEnvironment(project.id);
    return {
      request: row ? serializeQaSessionRequest(row) : null,
      merged: sessionMergedAt(session, project) !== null,
      defaultEnvironment: env ? { id: env.id, name: env.name, baseUrl: env.baseUrl } : null,
      delayMinutes: getQaProjectSettings(project.id).autoQaDelayMinutes,
      hasQaAgent: !!findProjectQaAgent(project),
    };
  };

  const requester = (req: Request, session: SessionRow): string | null =>
    (req as AuthenticatedRequest).authUserId ?? session.owner_user_id ?? null;

  const fail = (res: Response, e: unknown) => {
    if (e instanceof QaSessionRequestError) {
      res.status(e.status).json({ error: e.message, code: e.code });
      return;
    }
    console.error('[qa] session request route error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  };

  router.get(PATH, async (req, res) => {
    try {
      const loaded = load(req, res);
      if (!loaded) return;
      // The post-merge button needs to know about a github.com merge the Hub
      // did not perform; this asks GitHub at most once per branch per couple of minutes.
      await reconcileSessionMerge(deps, loaded.session, loaded.project);
      res.json(state(loaded.session, loaded.project));
    } catch (e) {
      fail(res, e);
    }
  });

  router.put(PATH, async (req, res) => {
    try {
      const loaded = load(req, res);
      if (!loaded) return;
      const body = SetQaSessionRequestArmedSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: body.error.issues[0]?.message ?? 'Validation failed' });
        return;
      }
      const { session, project } = loaded;
      await setQaSessionRequestArmed(
        deps,
        session,
        project,
        body.data.armed,
        requester(req, session),
      );
      res.json(state(session, project));
    } catch (e) {
      fail(res, e);
    }
  });

  router.post(`${PATH}/run`, async (req, res) => {
    try {
      const loaded = load(req, res);
      if (!loaded) return;
      const { session, project } = loaded;
      await reconcileSessionMerge(deps, session, project);
      await runQaSessionRequestNow(deps, session, project, requester(req, session));
      res.json(state(session, project));
    } catch (e) {
      fail(res, e);
    }
  });

  return router;
}
