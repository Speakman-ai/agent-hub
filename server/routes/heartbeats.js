import { Router } from 'express';
import { runHeartbeat, rescheduleHeartbeat } from '../heartbeat.js';

export default function createHeartbeatRoutes(deps) {
  const { allAgents, findAgent, getEnrichedAgent, saveProjects, stmts } = deps;
  const router = Router();

  router.get('/api/heartbeats', (_req, res) => {
    const configs = allAgents().map((a) => ({
      agentId: a.id,
      agentName: a.name,
      color: a.color,
      heartbeat: a.heartbeat || { enabled: false, interval: '', prompt: '' },
      latestLog: stmts.getLatestHeartbeat.get(a.id) || null,
      state: stmts.getHeartbeatState.get(a.id) || null,
    }));
    res.json(configs);
  });

  router.get('/api/heartbeats/state', (_req, res) => {
    const now = Date.now();
    const rows = allAgents()
      .filter((a) => a.heartbeat?.enabled || a.heartbeat?.interval)
      .map((a) => {
        const state = stmts.getHeartbeatState.get(a.id) || null;
        const nextMs = state?.next_run_at ? Date.parse(state.next_run_at) : null;
        return {
          agentId: a.id,
          agentName: a.name,
          enabled: !!a.heartbeat?.enabled,
          interval: a.heartbeat?.interval || null,
          next_run_at: state?.next_run_at || null,
          last_run_at: state?.last_run_at || null,
          overdue: Number.isFinite(nextMs) ? nextMs < now : false,
          overdue_seconds:
            Number.isFinite(nextMs) && nextMs < now ? Math.round((now - nextMs) / 1000) : 0,
        };
      });
    res.json(rows);
  });

  router.get('/api/heartbeats/:agentId/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const logs = stmts.getHeartbeatLogs.all(req.params.agentId, limit);
    res.json(logs);
  });

  router.put('/api/heartbeats/:agentId', (req, res) => {
    const found = findAgent(req.params.agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;

    const { enabled, interval, prompt } = req.body;
    agent.heartbeat = {
      enabled: enabled !== undefined ? enabled : (agent.heartbeat?.enabled ?? false),
      interval: interval || agent.heartbeat?.interval || '',
      prompt: prompt || agent.heartbeat?.prompt || '',
    };

    saveProjects();
    rescheduleHeartbeat(getEnrichedAgent(agent.id));
    res.json(agent.heartbeat);
  });

  router.post('/api/heartbeats/:agentId/run', async (req, res) => {
    const enriched = getEnrichedAgent(req.params.agentId);
    if (!enriched) return res.status(404).json({ error: 'Agent not found' });
    if (!enriched.heartbeat?.prompt) {
      return res.status(400).json({ error: 'No heartbeat prompt configured' });
    }

    const logEntry = stmts.addHeartbeatLog.run(enriched.id, enriched.heartbeat.prompt, 'running');
    const logId = logEntry.lastInsertRowid;
    res.json({ logId, status: 'running' });

    runHeartbeat(enriched).catch((err) => {
      console.error(`Manual heartbeat failed for ${enriched.name}:`, err);
    });
  });

  return router;
}
