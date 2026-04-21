import { Router, Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { defaultModelForEngine } from '../config.js';
import { resolveProjectPaths, contextFilePath, ALL_CONTEXT_FILES } from '../project-paths.js';
import { updateMemory, getMemoryData } from '../memory.js';
import { HOOK_EVENTS } from '../hooks.js';
import type { RouteDeps, Agent, HookConfig } from '../types.js';

interface McpServerInput {
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
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

  const router = Router();

  router.post('/api/agents/bulk-engine', (req: Request, res: Response) => {
    const { engine, model } = req.body as { engine?: string; model?: string };
    const engines = Object.keys(deps.config.engineValidModels);
    if (!engine || !engines.includes(engine)) {
      return res.status(400).json({
        error: `Invalid or missing engine. Must be one of: ${engines.join(', ')}`,
      });
    }
    const allowed = deps.config.engineValidModels[engine] || [];
    let resolved = defaultModelForEngine(engine);
    if (model && typeof model === 'string' && allowed.includes(model)) {
      resolved = model;
    }
    let updated = 0;
    for (const p of deps.getProjects()) {
      for (const a of p.agents) {
        a.engine = engine;
        a.model = resolved;
        updated++;
      }
    }
    saveProjects();
    res.json({ updated, engine, model: resolved });
  });

  router.get('/api/agents', (_req: Request, res: Response) => {
    const enriched = allAgents().map((a) => {
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
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
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
    ] as const;
    for (const key of allowed) {
      if ((req.body as Record<string, unknown>)[key] !== undefined)
        (agent as Record<string, unknown>)[key] = (req.body as Record<string, unknown>)[key];
    }
    saveProjects();
    res.json(getEnrichedAgent(agent.id));
  });

  router.post('/api/agents', (req: Request, res: Response) => {
    const { id, projectId, name, engine, model, systemPrompt, color, heartbeat, role } =
      req.body as Record<string, unknown>;
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id as string)) {
      return res.status(400).json({ error: 'id is required and must be alphanumeric+hyphens' });
    }
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const project = findProject(projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (findAgent(id as string)) {
      return res.status(409).json({ error: 'Agent id already exists' });
    }
    const agentEngine = (engine as string) || 'claude-code';
    const agent: Agent = {
      id: id as string,
      name: (name as string) || (id as string),
      engine: agentEngine,
      model: (model as string) || defaultModelForEngine(agentEngine),
      systemPrompt: (systemPrompt as string) || '',
      color: (color as string) || project.color || '#6b7280',
      heartbeat: (heartbeat as Agent['heartbeat']) || { enabled: false, interval: '', prompt: '' },
    };
    if (role) agent.role = role as string;
    mkdirSync(path.join(project.ahw, 'agents', agent.id), { recursive: true });
    project.agents.push(agent);
    saveProjects();
    ensureProjectRoom(project);
    res.status(201).json(getEnrichedAgent(agent.id));
  });

  router.delete('/api/agents/:agentId', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { project, agent } = found;
    project.agents = project.agents.filter((a) => a.id !== agent.id);
    saveProjects();
    ensureProjectRoom(project);
    res.status(204).end();
  });

  // ─── Hooks configuration ────────────────────────────────────────────

  router.get('/api/agents/:agentId/hooks', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
    res.json({
      hooks: agent.hooks || {},
      supportedEvents: HOOK_EVENTS,
    });
  });

  router.put('/api/agents/:agentId/hooks', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
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
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
    delete agent.hooks;
    saveProjects();
    res.json({ hooks: {}, supportedEvents: HOOK_EVENTS });
  });

  // ─── MCP Server configuration ────────────────────────────────────────

  router.get('/api/agents/:agentId/mcp-servers', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    res.json({ mcpServers: found.agent.mcpServers || {} });
  });

  router.put('/api/agents/:agentId/mcp-servers', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
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
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
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
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
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
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
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
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
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
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    if (!found.project.ahw) return res.status(400).json({ error: 'No workspace configured' });

    res.json(getMemoryData(found.project.ahw));
  });

  router.put('/api/agents/:agentId/memory', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    if (!found.project.ahw) return res.status(400).json({ error: 'No workspace configured' });

    const { content } = req.body as { content: unknown };
    if (typeof content !== 'string')
      return res.status(400).json({ error: 'content must be a string' });

    updateMemory(found.project.ahw, content);
    res.json({ ok: true });
  });

  return router;
}
