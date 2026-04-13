import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { defaultModelForEngine } from '../config.js';
import { resolveProjectPaths, contextFilePath, ALL_CONTEXT_FILES } from '../project-paths.js';
import { updateMemory, getMemoryData } from '../memory.js';

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
