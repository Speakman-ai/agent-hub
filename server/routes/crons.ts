import { Router, Request, Response } from 'express';
import { rescheduleCron, runCronJob } from '../heartbeat.js';
import config from '../config.js';
import { getProjects } from '../project-model.js';
import type {
  RouteDeps,
  CronRow,
  CronLogRow,
  Project,
  ThreadRow,
  ThreadEntryRow,
} from '../types.js';

export default function createCronRoutes(deps: RouteDeps): Router {
  const { stmts } = deps;
  const router = Router();

  router.get('/api/crons', (_req: Request, res: Response) => {
    const crons = stmts.getCrons.all() as CronRow[];
    res.json(crons);
  });

  router.post('/api/crons', (req: Request, res: Response) => {
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
    const cronJob = stmts.getCron.get(result.lastInsertRowid) as CronRow;
    rescheduleCron(cronJob);
    res.json(cronJob);
  });

  router.put('/api/crons/:id', (req: Request, res: Response) => {
    const existing = stmts.getCron.get(parseInt(req.params.id as string)) as CronRow | undefined;
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
    const updated = stmts.getCron.get(existing.id) as CronRow;
    rescheduleCron(updated);
    res.json(updated);
  });

  router.delete('/api/crons/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    rescheduleCron({ id, enabled: 0 } as CronRow);
    stmts.deleteCron.run(id);
    res.json({ ok: true });
  });

  router.get('/api/crons/:id/logs', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const limit = Math.min(parseInt(req.query.limit as string) || 3, 50);
    const logs = stmts.getCronLogs.all(id, limit) as CronLogRow[];
    res.json(logs);
  });

  router.post('/api/crons/:id/run', async (req: Request, res: Response) => {
    const cronJob = stmts.getCron.get(parseInt(req.params.id as string)) as CronRow | undefined;
    if (!cronJob) return res.status(404).json({ error: 'Cron not found' });

    res.json({ status: 'running' });
    runCronJob(cronJob).catch((err: Error) => {
      console.error(`Manual cron run failed for "${cronJob.name}":`, err);
    });
  });

  router.get('/api/crons/:id/thread', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const cron = stmts.getCron.get(id) as CronRow | undefined;
    if (!cron) return res.status(404).json({ error: 'Cron not found' });

    const projects = getProjects();
    const project =
      (cron.project_id && projects.find((p) => p.id === cron.project_id)) ||
      projects.find((p) => p.cwd === cron.cwd);
    if (!project) {
      return res.json({ thread: null, entries: [] });
    }

    const thread = stmts.getThreadBySource.get(project.id, 'cron', String(id)) as
      | ThreadRow
      | undefined;
    if (!thread) {
      return res.json({ thread: null, entries: [] });
    }

    const entries = stmts.getThreadEntries.all(thread.id) as ThreadEntryRow[];
    res.json({ thread, entries });
  });

  return router;
}
