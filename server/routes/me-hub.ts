/**
 * GET/POST /api/me/hub-session — the caller's persistent Hub assistant session.
 * GET/PUT /api/me/hub-model — Hub engine/model used by Hub chats and Hub generation.
 * POST /api/me/hub-session/clear — archive Hub chat and start a fresh empty session.
 * GET/PUT /api/me/server-agent — the caller's Server Agent name, instructions and added skills.
 * GET /api/me/server-agent/skill-options — skills the caller may add to their Server Agent.
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
import {
  getUserPreferencesRow,
  mutateUserPreferencesJson,
  normalizeServerAgentPrefs,
  normalizeServerAgentSkillRefs,
  SERVER_AGENT_INSTRUCTIONS_MAX,
  SERVER_AGENT_SKILLS_MAX,
  SERVER_AGENT_NAME_MAX,
  type ServerAgentPrefs,
} from '../user-preferences-store.js';
import { DEFAULT_SERVER_AGENT_NAME, HUB_SKILL_IDS } from '../hub-mode-prompt.js';
import {
  listServerAgentSkillOptions,
  serverAgentCaller,
  validateServerAgentSkillRefs,
} from '../server-agent-skills.js';
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

  function serverAgentBody(prefs: ServerAgentPrefs | undefined) {
    return {
      name: prefs?.name ?? '',
      instructions: prefs?.instructions ?? '',
      skills: prefs?.skills ?? [],
      builtInSkills: [...HUB_SKILL_IDS],
      defaultName: DEFAULT_SERVER_AGENT_NAME,
      effectiveName: prefs?.name || DEFAULT_SERVER_AGENT_NAME,
    };
  }

  function handleGetServerAgent(req: Request, res: Response): void {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.json(serverAgentBody(getUserPreferencesRow(areq.authUserId).serverAgent));
  }

  function handlePutServerAgent(req: Request, res: Response): void {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of ['name', 'instructions'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'string') {
        res.status(400).json({ error: `${key} must be a string` });
        return;
      }
    }
    const name = body.name as string | undefined;
    const instructions = body.instructions as string | undefined;
    let skills: ReturnType<typeof normalizeServerAgentSkillRefs> | null = null;
    if (body.skills !== undefined) {
      if (!Array.isArray(body.skills)) {
        res.status(400).json({ error: 'skills must be an array' });
        return;
      }
      if (body.skills.length > SERVER_AGENT_SKILLS_MAX) {
        res
          .status(400)
          .json({ error: `skills must have at most ${SERVER_AGENT_SKILLS_MAX} entries` });
        return;
      }
      skills = normalizeServerAgentSkillRefs(body.skills);
      if ((skills?.length ?? 0) !== body.skills.length) {
        res.status(400).json({ error: 'skills entries must be unique { id, projectId? } objects' });
        return;
      }
      const check = validateServerAgentSkillRefs(
        skills ?? [],
        serverAgentCaller(areq.authUserId),
        getUserPreferencesRow(areq.authUserId).serverAgent?.skills ?? [],
      );
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
    }
    if (name !== undefined && name.trim().length > SERVER_AGENT_NAME_MAX) {
      res.status(400).json({ error: `name must be at most ${SERVER_AGENT_NAME_MAX} characters` });
      return;
    }
    if (instructions !== undefined && instructions.trim().length > SERVER_AGENT_INSTRUCTIONS_MAX) {
      res.status(400).json({
        error: `instructions must be at most ${SERVER_AGENT_INSTRUCTIONS_MAX} characters`,
      });
      return;
    }
    const next = mutateUserPreferencesJson(areq.authUserId, (current) => ({
      ...current,
      serverAgent: normalizeServerAgentPrefs({
        name: name ?? current.serverAgent?.name,
        instructions: instructions ?? current.serverAgent?.instructions,
        skills: skills === null ? current.serverAgent?.skills : skills,
      }),
    }));
    res.json(serverAgentBody(next.serverAgent));
  }

  function handleGetSkillOptions(req: Request, res: Response): void {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.json(listServerAgentSkillOptions(serverAgentCaller(areq.authUserId)));
  }

  router.get('/api/me/server-agent', handleGetServerAgent);
  router.get('/api/me/server-agent/skill-options', handleGetSkillOptions);
  router.put('/api/me/server-agent', handlePutServerAgent);
  router.get('/api/me/hub-session', handleHubSession);
  router.post('/api/me/hub-session', handleHubSession);
  router.post('/api/me/hub-session/clear', handleClear);
  router.get('/api/me/hub-model', handleGetHubModel);
  router.put('/api/me/hub-model', handlePutHubModel);
  return router;
}
