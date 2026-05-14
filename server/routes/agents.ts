import { Router, Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import type { z } from 'zod';
import { defaultModelForEngine } from '../config.js';
import { getDb } from '../db.js';
import { unscheduleHeartbeat } from '../heartbeat.js';
import { resolveProjectPaths, contextFilePath, ALL_CONTEXT_FILES } from '../project-paths.js';
import { updateMemory, getMemoryData } from '../memory.js';
import { HOOK_EVENTS } from '../hooks.js';
import type { RouteDeps, Agent, Project, HookConfig } from '../types.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import {
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  BulkEngineRequestSchema,
  UpdateAgentMemoryRequestSchema,
} from './agents.openapi.js';

/**
 * Validate `req.body` against a Zod schema. On failure, writes a 400 with
 * `{error, details}` and returns `undefined`; the handler must `return`
 * immediately. On success, returns the parsed data (typed).
 *
 * Mirrors the helper in `board.ts` / `wiki.ts` / `sessions.ts` so the wire
 * shape of validation failures is identical across route groups.
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

interface McpServerInput {
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Translate a Zod-parsed browser-numeric dim (`number | null | undefined`)
 * to the `'delete' | number | undefined` tristate consumed by
 * `applyOptionalAgentNumeric`:
 *
 *   - `undefined` (key omitted)   → `undefined` ("preserve existing value")
 *   - `null`      (explicit clear) → `'delete'`  ("remove the key")
 *   - `number`    (explicit set)   → `Math.floor(value)`
 *
 * The schema has already validated that any explicit value is an integer
 * in the allowed range, so we only need to round-trip Zod's null sentinel
 * back to the legacy `'delete'` token.
 */
function translateDim(v: number | null | undefined): number | 'delete' | undefined {
  if (v === undefined) return undefined;
  if (v === null) return 'delete';
  return Math.floor(v);
}

/**
 * Apply a Zod-parsed browser-numeric dim to the agent record.
 *
 * `value` is the `'delete' | number | undefined` tristate produced by
 * `translateDim` from the schema's `number | null | undefined`:
 *   - `undefined`  — key was omitted; preserve the existing value.
 *   - `'delete'`   — caller sent `null`; remove the key from the record.
 *   - `number`     — caller sent a numeric value; store it.
 */
function applyOptionalAgentNumeric(
  agent: Agent,
  key: 'browserViewportWidth' | 'browserViewportHeight' | 'browserPageLoadTimeoutMs',
  value: number | 'delete' | undefined,
) {
  if (value === undefined) return;
  if (value === 'delete') delete (agent as Record<string, unknown>)[key];
  else (agent as Record<string, unknown>)[key] = value;
}

export default function createAgentRoutes(deps: RouteDeps): Router {
  const {
    stmts,
    findProject,
    findAgent,
    getEnrichedAgent,
    allAgents,
    saveProjects,
    ensureProjectRoom,
  } = deps;

  /**
   * Agent-scoped equivalent of the `/api/projects/:projectId` visibility
   * gate: look up the agent, then refuse to admit the caller when they
   * cannot view the agent's project. Returns the lookup tuple on success,
   * or `null` after writing a 404 to `res` — handlers can early-return
   * without re-checking auth themselves.
   *
   * We mask the "private project, you can't see this agent" case as
   * `'Agent not found'` (same shape and status as a genuinely missing
   * agent) so the endpoint never leaks the existence of agents that live
   * inside a private project the caller cannot enter.
   */
  function findAgentVisible(
    req: Request,
    res: Response,
    agentId: string,
  ): { project: Project; agent: Agent } | null {
    const found = findAgent(agentId);
    if (!found) {
      res.status(404).json({ error: 'Agent not found' });
      return null;
    }
    const caller = resolveVisibilityCaller(req);
    if (!canViewProject(found.project, caller)) {
      res.status(404).json({ error: 'Agent not found' });
      return null;
    }
    return found;
  }

  const router = Router();

  router.post('/api/agents/bulk-engine', (req: Request, res: Response) => {
    const parsed = parseBody(BulkEngineRequestSchema, req, res);
    if (!parsed) return;
    const { engine, model } = parsed;
    const engines = Object.keys(deps.config.engineValidModels);
    if (!engines.includes(engine)) {
      return res.status(400).json({
        error: `Invalid or missing engine. Must be one of: ${engines.join(', ')}`,
      });
    }
    const allowed = deps.config.engineValidModels[engine] || [];
    let resolved = defaultModelForEngine(engine);
    if (model && allowed.includes(model)) {
      resolved = model;
    }
    // Visibility scope: only mutate agents in projects the caller can view.
    // This matches `GET /api/agents` (which only enumerates visible agents)
    // so a User running "switch all my agents to claude-code" doesn't
    // silently rewrite the engine on another tenant's private project.
    const caller = resolveVisibilityCaller(req);
    let updated = 0;
    for (const p of deps.getProjects()) {
      if (!canViewProject(p, caller)) continue;
      for (const a of p.agents) {
        a.engine = engine;
        a.model = resolved;
        updated++;
      }
    }
    saveProjects();
    res.json({ updated, engine, model: resolved });
  });

  router.get('/api/agents', (req: Request, res: Response) => {
    // Filter to agents whose project the caller can view. `allAgents()`
    // already enriches each row with `projectId`, but we filter at the
    // project level for the canonical visibility check (a project's
    // `visibility` / `ownerUserId` live on the parent record, not the
    // agent). Under bypass identities (local-bundled server, global
    // x-api-key break-glass, no-auth-configured dev) `canViewProject`
    // returns true for every project, so the list shape is unchanged
    // for those callers.
    const caller = resolveVisibilityCaller(req);
    const visibleProjectIds = new Set(
      deps
        .getProjects()
        .filter((p) => canViewProject(p, caller))
        .map((p) => p.id),
    );
    const enriched = allAgents()
      .filter((a) => visibleProjectIds.has(a.projectId))
      .map((a) => {
        const sessions = stmts.getSessions.all(a.id) as Array<{ id: string; updated_at: string }>;
        let lastActivity: string | null = null;
        let lastMessage: { role: string; content: string; created_at: string } | null = null;
        if (sessions.length > 0) {
          lastActivity = sessions[0].updated_at;
          const msg = stmts.getLastMessage.get(sessions[0].id) as
            | {
                role: string;
                content: string;
                created_at: string;
              }
            | undefined;
          if (msg) {
            lastMessage = {
              role: msg.role,
              content: msg.content.substring(0, 100),
              created_at: msg.created_at,
            };
          }
        }
        return { ...a, lastActivity, lastMessage };
      });
    res.json(enriched);
  });

  router.patch('/api/agents/:agentId', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;

    const parsed = parseBody(UpdateAgentRequestSchema, req, res);
    if (!parsed) return;

    const allowed = [
      'name',
      'engine',
      'model',
      'systemPrompt',
      'color',
      'avatar',
      'heartbeat',
      'active',
      'reviewer',
      'role',
      'canReview',
      'delegationEnabled',
    ] as const;
    for (const key of allowed) {
      if ((parsed as Record<string, unknown>)[key] !== undefined) {
        (agent as Record<string, unknown>)[key] = (parsed as Record<string, unknown>)[key];
      }
    }
    if (parsed.browserToolsEnabled !== undefined) {
      agent.browserToolsEnabled = parsed.browserToolsEnabled;
    }
    applyOptionalAgentNumeric(
      agent,
      'browserViewportWidth',
      translateDim(parsed.browserViewportWidth),
    );
    applyOptionalAgentNumeric(
      agent,
      'browserViewportHeight',
      translateDim(parsed.browserViewportHeight),
    );
    applyOptionalAgentNumeric(
      agent,
      'browserPageLoadTimeoutMs',
      translateDim(parsed.browserPageLoadTimeoutMs),
    );
    saveProjects();
    res.json(getEnrichedAgent(agent.id));
  });

  router.post('/api/agents', (req: Request, res: Response) => {
    const parsed = parseBody(CreateAgentRequestSchema, req, res);
    if (!parsed) return;

    const {
      id,
      projectId,
      name,
      engine,
      model,
      systemPrompt,
      color,
      heartbeat,
      role,
      browserToolsEnabled,
    } = parsed;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Visibility scope: refuse to add an agent to a project the caller
    // cannot view. Mask as 'Project not found' to keep parity with the
    // `/api/projects/:projectId` gate — we don't want this endpoint to
    // become an enumeration oracle for private projects.
    const caller = resolveVisibilityCaller(req);
    if (!canViewProject(project, caller)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (findAgent(id)) {
      return res.status(409).json({ error: 'Agent id already exists' });
    }
    const agentEngine = engine || 'claude-code';
    // The schema is partial — fields like `interval` / `prompt` on the
    // heartbeat config are optional. Build a fully-populated record so
    // downstream readers (heartbeat scheduler, settings UI) don't have to
    // gate every field.
    const heartbeatConfig: Agent['heartbeat'] = heartbeat
      ? {
          enabled: heartbeat.enabled ?? false,
          interval: heartbeat.interval ?? '',
          prompt: heartbeat.prompt ?? '',
        }
      : { enabled: false, interval: '', prompt: '' };
    const agent: Agent = {
      id,
      name: name || id,
      engine: agentEngine,
      model: model || defaultModelForEngine(agentEngine),
      systemPrompt: systemPrompt || '',
      color: color || project.color || '#6b7280',
      heartbeat: heartbeatConfig,
    };
    if (role) agent.role = role;
    if (browserToolsEnabled !== undefined) {
      agent.browserToolsEnabled = browserToolsEnabled;
    }
    applyOptionalAgentNumeric(
      agent,
      'browserViewportWidth',
      translateDim(parsed.browserViewportWidth),
    );
    applyOptionalAgentNumeric(
      agent,
      'browserViewportHeight',
      translateDim(parsed.browserViewportHeight),
    );
    applyOptionalAgentNumeric(
      agent,
      'browserPageLoadTimeoutMs',
      translateDim(parsed.browserPageLoadTimeoutMs),
    );
    mkdirSync(path.join(project.ahw, 'agents', agent.id), { recursive: true });
    project.agents.push(agent);
    saveProjects();
    ensureProjectRoom(project);
    res.status(201).json(getEnrichedAgent(agent.id));
  });

  // Hard-delete an agent. Agents are stored in projects.json (not a DB table)
  // so there are no FK cascades from an "agents" row — we have to wipe every
  // child store keyed by agent_id explicitly. Sessions cascade their own
  // children (messages, delegations, handoffs, skill_invocations,
  // background_tasks, message_queue, checkpoints). The on-disk workspace
  // directory at <project.ahw>/agents/<agentId>/ is also removed so a
  // re-created agent with the same id starts clean.
  router.delete('/api/agents/:agentId', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { project, agent } = found;
    const agentId = agent.id;

    // 1. Stop in-memory heartbeat task + drop heartbeat_state row.
    try {
      unscheduleHeartbeat(agentId);
    } catch (e) {
      console.error(`[agents] unscheduleHeartbeat(${agentId}) failed:`, e);
    }

    // 2. Atomically wipe every child row keyed by this agent.
    try {
      getDb().transaction(() => {
        // sessions cascade messages/delegations/handoffs/skill_invocations/
        // background_tasks/message_queue/checkpoints via FK ON DELETE CASCADE
        stmts.deleteSessionsByAgent.run(agentId);
        stmts.deleteHeartbeatLogsByAgent.run(agentId);
        stmts.deleteSlackMessagesByAgent.run(agentId);
        stmts.deleteRoomAgentsByAgent.run(agentId);
        stmts.deleteActiveTasksByAgent.run(agentId);
        stmts.deleteAgentSkillOverridesByAgent.run(agentId);
      })();
    } catch (e) {
      console.error(`[agents] hard-delete DB cleanup failed for ${agentId}:`, e);
      return res.status(500).json({ error: 'Failed to clean up agent data' });
    }

    // 3. Remove the agent from projects.json and drop stale sub-agent refs.
    project.agents = project.agents.filter((a) => a.id !== agentId);
    for (const a of project.agents) {
      if (Array.isArray(a.subAgents)) {
        a.subAgents = a.subAgents.filter((sid) => sid !== agentId);
      }
    }
    saveProjects();

    // 4. Refresh the project room so the participant list drops the agent.
    ensureProjectRoom(project);

    // 5. Best-effort: remove the on-disk agent workspace. Failure here
    //    shouldn't block the delete — log and continue.
    try {
      const agentDir = path.join(project.ahw, 'agents', agentId);
      if (existsSync(agentDir)) {
        rmSync(agentDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`[agents] failed to remove workspace for ${agentId}:`, e);
    }

    res.status(204).end();
  });

  // ─── Hooks configuration ────────────────────────────────────────────

  router.get('/api/agents/:agentId/hooks', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;
    res.json({
      hooks: agent.hooks || {},
      supportedEvents: HOOK_EVENTS,
    });
  });

  router.put('/api/agents/:agentId/hooks', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;

    const { hooks } = req.body as { hooks?: Record<string, HookConfig[]> };
    if (!hooks || typeof hooks !== 'object') {
      return res.status(400).json({ error: 'hooks object is required' });
    }

    for (const event of Object.keys(hooks)) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        return res.status(400).json({ error: `Unknown hook event: ${event}` });
      }
      if (!Array.isArray(hooks[event])) {
        return res.status(400).json({ error: `hooks.${event} must be an array` });
      }
      for (const entry of hooks[event]) {
        if (typeof entry.matcher !== 'string' && entry.matcher !== undefined) {
          return res.status(400).json({ error: `hooks.${event}[].matcher must be a string` });
        }
        if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) {
          return res
            .status(400)
            .json({ error: `hooks.${event}[].hooks must be a non-empty array` });
        }
        for (const h of entry.hooks) {
          if (!h.command || typeof h.command !== 'string') {
            return res
              .status(400)
              .json({ error: `hooks.${event}[].hooks[].command must be a non-empty string` });
          }
          if (h.type && h.type !== 'command') {
            return res
              .status(400)
              .json({ error: `hooks.${event}[].hooks[].type must be "command" if specified` });
          }
        }
      }
    }

    agent.hooks = hooks;
    saveProjects();
    res.json({ hooks: agent.hooks, supportedEvents: HOOK_EVENTS });
  });

  router.delete('/api/agents/:agentId/hooks', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;
    delete agent.hooks;
    saveProjects();
    res.json({ hooks: {}, supportedEvents: HOOK_EVENTS });
  });

  // ─── MCP Server configuration ────────────────────────────────────────

  router.get('/api/agents/:agentId/mcp-servers', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    res.json({ mcpServers: found.agent.mcpServers || {} });
  });

  router.put('/api/agents/:agentId/mcp-servers', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;

    const { mcpServers } = req.body as { mcpServers?: Record<string, McpServerInput> };
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
      return res.status(400).json({ error: 'mcpServers object is required' });
    }

    for (const [name, server] of Object.entries(mcpServers)) {
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Server name must be a non-empty string' });
      }
      if (!server.command && !server.url) {
        return res.status(400).json({ error: `Server "${name}" must have either command or url` });
      }
      if (server.command && typeof server.command !== 'string') {
        return res.status(400).json({ error: `Server "${name}" command must be a string` });
      }
      if (server.url && typeof server.url !== 'string') {
        return res.status(400).json({ error: `Server "${name}" url must be a string` });
      }
      if (server.args && !Array.isArray(server.args)) {
        return res.status(400).json({ error: `Server "${name}" args must be an array` });
      }
      if (server.env && (typeof server.env !== 'object' || Array.isArray(server.env))) {
        return res.status(400).json({ error: `Server "${name}" env must be an object` });
      }
    }

    agent.mcpServers = mcpServers;
    saveProjects();
    res.json({ mcpServers: agent.mcpServers });
  });

  router.put('/api/agents/:agentId/mcp-servers/:serverName', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;
    const serverName = req.params.serverName as string;
    const server = req.body as McpServerInput;

    if (!server.command && !server.url) {
      return res.status(400).json({ error: 'Server must have either command or url' });
    }
    if (server.command && typeof server.command !== 'string') {
      return res.status(400).json({ error: 'command must be a string' });
    }
    if (server.url && typeof server.url !== 'string') {
      return res.status(400).json({ error: 'url must be a string' });
    }
    if (server.args && !Array.isArray(server.args)) {
      return res.status(400).json({ error: 'args must be an array' });
    }
    if (server.env && (typeof server.env !== 'object' || Array.isArray(server.env))) {
      return res.status(400).json({ error: 'env must be an object' });
    }

    if (!agent.mcpServers) agent.mcpServers = {};

    const serverConfig: McpServerInput = {};
    if (server.command) serverConfig.command = server.command;
    if (server.url) serverConfig.url = server.url;
    if (server.args?.length) serverConfig.args = server.args;
    if (server.env && Object.keys(server.env).length) serverConfig.env = server.env;
    if (server.cwd) serverConfig.cwd = server.cwd;

    agent.mcpServers[serverName] = serverConfig;
    saveProjects();
    res.json({ mcpServers: agent.mcpServers });
  });

  router.delete('/api/agents/:agentId/mcp-servers/:serverName', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;
    const serverName = req.params.serverName as string;

    if (!agent.mcpServers || !agent.mcpServers[serverName]) {
      return res.status(404).json({ error: `MCP server "${serverName}" not found` });
    }

    delete agent.mcpServers[serverName];
    if (Object.keys(agent.mcpServers).length === 0) {
      delete agent.mcpServers;
    }
    saveProjects();
    res.json({ mcpServers: agent.mcpServers || {} });
  });

  // ─── Context endpoints ─────────────────────────────────────────────

  router.get('/api/agents/:agentId/context', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { project, agent } = found;
    if (!project.ahw) return res.json({});

    const paths = resolveProjectPaths(project, agent);
    const result: Record<string, string | null> = {};
    for (const filename of ALL_CONTEXT_FILES) {
      const filePath = contextFilePath(paths, filename);
      if (filePath && existsSync(filePath)) {
        try {
          result[filename] = readFileSync(filePath, 'utf-8');
        } catch {
          result[filename] = null;
        }
      }
    }
    res.json(result);
  });

  router.put('/api/agents/:agentId/context/:filename', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { project, agent } = found;
    if (!project.ahw) return res.status(400).json({ error: 'No workspace configured' });
    if (!ALL_CONTEXT_FILES.includes(req.params.filename as string)) {
      return res.status(400).json({ error: 'Invalid context file' });
    }

    const paths = resolveProjectPaths(project, agent);
    const filePath = contextFilePath(paths, req.params.filename as string);
    if (!filePath) return res.status(400).json({ error: 'Cannot resolve file path' });
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, (req.body as { content: string }).content, 'utf-8');
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Memory API ────────────────────────────────────────────────────

  router.get('/api/agents/:agentId/memory', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    if (!found.project.ahw) return res.status(400).json({ error: 'No workspace configured' });

    res.json(getMemoryData(found.project.ahw));
  });

  router.put('/api/agents/:agentId/memory', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    if (!found.project.ahw) return res.status(400).json({ error: 'No workspace configured' });

    const parsed = parseBody(UpdateAgentMemoryRequestSchema, req, res);
    if (!parsed) return;

    updateMemory(found.project.ahw, parsed.content);
    res.json({ ok: true });
  });

  return router;
}
