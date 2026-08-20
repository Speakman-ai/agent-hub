/**
 * GET/POST /api/me/hub-session — the caller's persistent Hub assistant session.
 * GET/PUT /api/me/hub-model — Hub engine/model used by Hub chats and Hub generation.
 * POST /api/me/hub-session/clear — archive Hub chat and start a fresh empty session.
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import appConfig from '../config.js';
import {
  applyHubEngineAndModelToLiveSessions,
  clearHubChatSession,
  getOrCreateHubSession,
  resolveHubEngineAndModel,
} from '../hub-assistant.js';
import { getEnrichedAgent } from '../project-model.js';
import { mutateUserPreferencesJson } from '../user-preferences-store.js';
import type { RouteDeps } from '../types.js';
import './me-hub.openapi.js';
import { HUB_ASSISTANT_AGENT_ID } from '../../shared/utils/hub.js';

const NON_SELECTABLE = new Set(['gemini-cli']);

export default function createMeHubRoutes(deps: RouteDeps): Router {
  const router = Router();
  const cfg = deps.config ?? appConfig;

  function handleHubSession(req: Request, res: Response): void {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { agent, session, created } = getOrCreateHubSession({
      stmts: deps.stmts,
      userId: areq.authUserId,
      config: cfg,
    });
    const enriched = getEnrichedAgent(agent.id);
    res.status(created ? 201 : 200).json({
      session,
      agent: enriched || agent,
    });
  }

  function handleClear(req: Request, res: Response): void {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { agent, session, clearedSessionId } = clearHubChatSession({
      stmts: deps.stmts,
      userId: areq.authUserId,
      config: cfg,
      activeProcesses: deps.activeProcesses,
      broadcast: deps.broadcast,
    });
    const enriched = getEnrichedAgent(agent.id);
    res.status(200).json({
      session,
      agent: enriched || agent,
      clearedSessionId,
    });
  }

  function handleGetHubModel(req: Request, res: Response): void {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const resolved = resolveHubEngineAndModel(cfg, areq.authUserId);
    res.json(resolved);
  }

  function handlePutHubModel(req: Request, res: Response): void {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const engine = typeof req.body?.engine === 'string' ? req.body.engine.trim() : '';
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    if (!engine || !model) {
      res.status(400).json({ error: 'engine and model are required' });
      return;
    }
    if (NON_SELECTABLE.has(engine)) {
      res.status(400).json({ error: `Engine "${engine}" is not selectable for Hub` });
      return;
    }
    const allowed = cfg.engineValidModels?.[engine];
    if (!Array.isArray(allowed) || allowed.length === 0) {
      res.status(400).json({ error: `Unknown engine "${engine}"` });
      return;
    }
    if (!allowed.includes(model)) {
      res.status(400).json({ error: `Model "${model}" is not valid for ${engine}` });
      return;
    }
    mutateUserPreferencesJson(areq.authUserId, (current) => ({
      ...current,
      agentEngineOverrides: {
        ...(current.agentEngineOverrides || {}),
        [HUB_ASSISTANT_AGENT_ID]: { engine, model },
      },
      agentModelOverrides: {
        ...(current.agentModelOverrides || {}),
        [HUB_ASSISTANT_AGENT_ID]: model,
      },
    }));
    applyHubEngineAndModelToLiveSessions({
      stmts: deps.stmts,
      userId: areq.authUserId,
      engine,
      model,
    });
    res.json({ engine, model });
  }

  router.get('/api/me/hub-session', handleHubSession);
  router.post('/api/me/hub-session', handleHubSession);
  router.post('/api/me/hub-session/clear', handleClear);
  router.get('/api/me/hub-model', handleGetHubModel);
  router.put('/api/me/hub-model', handlePutHubModel);
  return router;
}
