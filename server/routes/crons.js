import { Router } from 'express';
import { rescheduleCron, runCronJob } from '../heartbeat.js';
import config from '../config.js';
import { getProjects } from '../project-model.js';

export default function createCronRoutes(deps) {
  const { stmts } = deps;
  const router = Router();

  router.get('/api/crons', (_req, res) => {
    const crons = stmts.getCrons.all();
    res.json(crons);
  });

  router.post('/api/crons', (req, res) => {
    const { name, schedule, prompt, cwd, enabled, project_id } = req.body;
    if (!name || !schedule || !prompt) {
      return res.status(400).json({ error: 'name, schedule, and prompt are required' });
    }
    const result = stmts.createCron.run(
      name,
      schedule,
      prompt,
      cwd || config.defaultCwd,
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
      project_id || null,
    );
    const cronJob = stmts.getCron.get(result.lastInsertRowid);
    rescheduleCron(cronJob);
    res.json(cronJob);
  });

  router.put('/api/crons/:id', (req, res) => {
    const existing = stmts.getCron.get(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Cron not found' });

    const { name, schedule, prompt, cwd, enabled, project_id } = req.body;
    stmts.updateCron.run(
      name || existing.name,
      schedule || existing.schedule,
      prompt || existing.prompt,
      cwd || existing.cwd,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      project_id !== undefined ? project_id : existing.project_id || null,
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

  // ── Cron thread shortcut (find thread by cron source_id) ────

  router.get('/api/crons/:id/thread', (req, res) => {
    const id = parseInt(req.params.id);
    const cron = stmts.getCron.get(id);
    if (!cron) return res.status(404).json({ error: 'Cron not found' });

    // Find the project that owns this cron (by project_id, falling back to cwd match)
    const projects = getProjects();
    const project =
      (cron.project_id && projects.find((p) => p.id === cron.project_id)) ||
      projects.find((p) => p.cwd === cron.cwd);
    if (!project) {
      return res.json({ thread: null, entries: [] });
    }

    const thread = stmts.getThreadBySource.get(project.id, 'cron', String(id));
    if (!thread) {
      return res.json({ thread: null, entries: [] });
    }

    const entries = stmts.getThreadEntries.all(thread.id);
    res.json({ thread, entries });
  });

  return router;
}
