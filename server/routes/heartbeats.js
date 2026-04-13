import { Router } from 'express';
import { runHeartbeat, rescheduleCron, rescheduleHeartbeat, runCronJob } from '../heartbeat.js';
import config from '../config.js';

export default function createHeartbeatCronRoutes(deps) {
  const { allAgents, findAgent, getEnrichedAgent, saveProjects, stmts } = deps;
  const router = Router();

  // Heartbeats
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

  // Crons
  router.get('/api/crons', (_req, res) => {
    const crons = stmts.getCrons.all();
    res.json(crons);
  });

  router.post('/api/crons', (req, res) => {
    const { name, schedule, prompt, cwd, enabled } = req.body;
    if (!name || !schedule || !prompt) {
      return res.status(400).json({ error: 'name, schedule, and prompt are required' });
    }
    const result = stmts.createCron.run(
      name,
      schedule,
      prompt,
      cwd || config.defaultCwd,
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
    );
    const cronJob = stmts.getCron.get(result.lastInsertRowid);
    rescheduleCron(cronJob);
    res.json(cronJob);
  });

  router.put('/api/crons/:id', (req, res) => {
    const existing = stmts.getCron.get(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Cron not found' });

    const { name, schedule, prompt, cwd, enabled } = req.body;
    stmts.updateCron.run(
      name || existing.name,
      schedule || existing.schedule,
      prompt || existing.prompt,
      cwd || existing.cwd,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      existing.id,
    );
    const updated = stmts.getCron.get(existing.id);
    rescheduleCron(updated);
    res.json(updated);
  });

  router.delete('/api/crons/:id', (req, res) => {
    const id = parseInt(req.params.id);
    rescheduleCron({ id, enabled: false });
    stmts.deleteCron.run(id);
    res.json({ ok: true });
  });

  router.get('/api/crons/:id/logs', (req, res) => {
    const id = parseInt(req.params.id);
    const limit = Math.min(parseInt(req.query.limit) || 3, 50);
    const logs = stmts.getCronLogs.all(id, limit);
    res.json(logs);
  });

  router.post('/api/crons/:id/run', async (req, res) => {
    const cronJob = stmts.getCron.get(parseInt(req.params.id));
    if (!cronJob) return res.status(404).json({ error: 'Cron not found' });

    res.json({ status: 'running' });
    runCronJob(cronJob).catch((err) => {
      console.error(`Manual cron run failed for "${cronJob.name}":`, err);
    });
  });

  return router;
}
