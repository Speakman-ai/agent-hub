import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { defaultModelForEngine } from '../config.js';
import { resolveProjectPaths, contextFilePath, ALL_CONTEXT_FILES } from '../project-paths.js';
import { updateMemory, getMemoryData } from '../memory.js';
import { HOOK_EVENTS } from '../hooks.js';

export default function createAgentRoutes(deps) {
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

  // ─── Agent endpoints ───────────────────────────────────────────────
  // GET /api/agents returns a flat list (backward compat for sidebar, rooms, etc.)
  router.get('/api/agents', (_req, res) => {
    const enriched = allAgents().map((a) => {
      const sessions = stmts.getSessions.all(a.id);
      let lastActivity = null;
      let lastMessage = null;
      if (sessions.length > 0) {
        lastActivity = sessions[0].updated_at;
        const msg = stmts.getLastMessage.get(sessions[0].id);
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

  // PATCH /api/agents/:agentId — update agent config
  router.patch('/api/agents/:agentId', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
    const allowed = [
      'name',
      'engine',
      'model',
      'systemPrompt',
      'color',
      'heartbeat',
      'active',
      'reviewer',
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) agent[key] = req.body[key];
    }
    saveProjects();
    res.json(getEnrichedAgent(agent.id));
  });

  // POST /api/agents — create new agent (requires projectId)
  router.post('/api/agents', (req, res) => {
    const { id, projectId, name, engine, model, systemPrompt, color, heartbeat } = req.body;
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
      return res.status(400).json({ error: 'id is required and must be alphanumeric+hyphens' });
    }
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (findAgent(id)) {
      return res.status(409).json({ error: 'Agent id already exists' });
    }
    const agentEngine = engine || 'claude-code';
    const agent = {
      id,
      name: name || id,
      engine: agentEngine,
      model: model || defaultModelForEngine(agentEngine),
      systemPrompt: systemPrompt || '',
      color: color || project.color || '#6b7280',
      heartbeat: heartbeat || { enabled: false, interval: '', prompt: '' },
    };
    // Create agent-specific directory
    mkdirSync(path.join(project.ahw, 'agents', id), { recursive: true });
    project.agents.push(agent);
    saveProjects();
    // Sync project conference room
    ensureProjectRoom(project);
    res.status(201).json(getEnrichedAgent(id));
  });

  // DELETE /api/agents/:agentId — remove agent
  router.delete('/api/agents/:agentId', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { project, agent } = found;
    project.agents = project.agents.filter((a) => a.id !== agent.id);
    saveProjects();
    // Sync project conference room (removes deleted agent)
    ensureProjectRoom(project);
    res.status(204).end();
  });

  // ─── Hooks configuration ────────────────────────────────────────────
  // Per-agent Claude Code hooks — stored in projects.json agent.hooks.
  // Format mirrors Claude Code's native hooks structure:
  //   { "PreToolUse": [{ "matcher": "Write", "hooks": [{ "type": "command", "command": "..." }] }] }

  /**
   * GET /api/agents/:agentId/hooks — read agent hook configuration
   */
  router.get('/api/agents/:agentId/hooks', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
    res.json({
      hooks: agent.hooks || {},
      supportedEvents: HOOK_EVENTS,
    });
  });

  /**
   * PUT /api/agents/:agentId/hooks — replace agent hook configuration
   *
   * Body: { hooks: { PreToolUse?: [...], PostToolUse?: [...], ... } }
   * Each event maps to an array of { matcher: string, hooks: [{ type: "command", command: string }] }
   */
  router.put('/api/agents/:agentId/hooks', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;

    const { hooks } = req.body;
    if (!hooks || typeof hooks !== 'object') {
      return res.status(400).json({ error: 'hooks object is required' });
    }

    // Validate: only allow known event types
    for (const event of Object.keys(hooks)) {
      if (!HOOK_EVENTS.includes(event)) {
        return res.status(400).json({ error: `Unknown hook event: ${event}` });
      }
      if (!Array.isArray(hooks[event])) {
        return res.status(400).json({ error: `hooks.${event} must be an array` });
      }
      // Validate each entry has the correct shape
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

  /**
   * DELETE /api/agents/:agentId/hooks — remove all agent hook configuration
   */
  router.delete('/api/agents/:agentId/hooks', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
    delete agent.hooks;
    saveProjects();
    res.json({ hooks: {}, supportedEvents: HOOK_EVENTS });
  });

  // ─── MCP Server configuration ────────────────────────────────────────
  // Per-agent MCP (Model Context Protocol) server configs — stored in
  // projects.json as agent.mcpServers.
  // Format mirrors Claude Code's native mcpServers structure:
  //   { "server-name": { "command": "npx", "args": [...], "env": { ... } } }

  /**
   * GET /api/agents/:agentId/mcp-servers — list configured MCP servers
   */
  router.get('/api/agents/:agentId/mcp-servers', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    res.json({ mcpServers: found.agent.mcpServers || {} });
  });

  /**
   * PUT /api/agents/:agentId/mcp-servers — replace all MCP servers
   *
   * Body: { mcpServers: { "name": { command, args?, env?, cwd?, url? } } }
   */
  router.put('/api/agents/:agentId/mcp-servers', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;

    const { mcpServers } = req.body;
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
      return res.status(400).json({ error: 'mcpServers object is required' });
    }

    // Validate each server entry
    for (const [name, server] of Object.entries(mcpServers)) {
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Server name must be a non-empty string' });
      }
      // Must have either command (stdio) or url (SSE)
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

  /**
   * PUT /api/agents/:agentId/mcp-servers/:serverName — add or update a single MCP server
   *
   * Body: { command, args?, env?, cwd?, url? }
   */
  router.put('/api/agents/:agentId/mcp-servers/:serverName', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
    const { serverName } = req.params;
    const server = req.body;

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

    // Build clean server config
    const config = {};
    if (server.command) config.command = server.command;
    if (server.url) config.url = server.url;
    if (server.args?.length) config.args = server.args;
    if (server.env && Object.keys(server.env).length) config.env = server.env;
    if (server.cwd) config.cwd = server.cwd;

    agent.mcpServers[serverName] = config;
    saveProjects();
    res.json({ mcpServers: agent.mcpServers });
  });

  /**
   * DELETE /api/agents/:agentId/mcp-servers/:serverName — remove a single MCP server
   */
  router.delete('/api/agents/:agentId/mcp-servers/:serverName', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;
    const { serverName } = req.params;

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
  // Shared files (AGENTS.md, SOUL.md, etc.) live in project ahw/.
  // Agent-specific files (IDENTITY.md) live in ahw/agents/{agentId}/.

  router.get('/api/agents/:agentId/context', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { project, agent } = found;
    if (!project.ahw) return res.json({});

    const paths = resolveProjectPaths(project, agent);
    const result = {};
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

  router.put('/api/agents/:agentId/context/:filename', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { project, agent } = found;
    if (!project.ahw) return res.status(400).json({ error: 'No workspace configured' });
    if (!ALL_CONTEXT_FILES.includes(req.params.filename)) {
      return res.status(400).json({ error: 'Invalid context file' });
    }

    const paths = resolveProjectPaths(project, agent);
    const filePath = contextFilePath(paths, req.params.filename);
    if (!filePath) return res.status(400).json({ error: 'Cannot resolve file path' });
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, req.body.content, 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Memory API ────────────────────────────────────────────────────

  router.get('/api/agents/:agentId/memory', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    if (!found.project.ahw) return res.status(400).json({ error: 'No workspace configured' });

    res.json(getMemoryData(found.project.ahw));
  });

  router.put('/api/agents/:agentId/memory', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    if (!found.project.ahw) return res.status(400).json({ error: 'No workspace configured' });

    const { content } = req.body;
    if (typeof content !== 'string')
      return res.status(400).json({ error: 'content must be a string' });

    updateMemory(found.project.ahw, content);
    res.json({ ok: true });
  });

  return router;
}
