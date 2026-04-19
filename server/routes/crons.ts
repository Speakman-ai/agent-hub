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

  /**
   * Coerce a `timeout_ms` value from a request body into the DB-friendly
   * form: either a positive integer (the override) or null (use default).
   * Throws on non-numeric or non-positive input so the API returns 400
   * instead of silently persisting garbage that would bypass the timeout.
   */
  function normalizeTimeoutMs(raw: unknown): number | null {
    if (raw === null || raw === undefined || raw === '') return null;
    // Explicitly reject booleans — `Number(true)` is 1, which would otherwise
    // sneak through as a valid 1 ms timeout and silently kill every run.
    if (typeof raw === 'boolean') {
      throw new Error('timeout_ms must be a positive integer (milliseconds)');
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error('timeout_ms must be a positive integer (milliseconds)');
    }
    return n;
  }

  /**
   * Coerce a `notify_on_run` request value into the DB-friendly 0/1 form.
   * Accepts boolean, 0/1, "0"/"1", "true"/"false". Anything else throws so
   * the API returns 400 instead of silently storing nonsense.
   */
  function normalizeNotifyOnRun(raw: unknown): 0 | 1 {
    if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 1;
    if (raw === false || raw === 0 || raw === '0' || raw === 'false') return 0;
    throw new Error('notify_on_run must be a boolean');
  }

  router.post('/api/crons', (req: Request, res: Response) => {
    const { name, schedule, prompt, cwd, enabled, project_id, timeout_ms, notify_on_run } =
      req.body;
    if (!name || !schedule || !prompt) {
      return res.status(400).json({ error: 'name, schedule, and prompt are required' });
    }
    let normalizedTimeout: number | null;
    try {
      normalizedTimeout = normalizeTimeoutMs(timeout_ms);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    let normalizedNotify: 0 | 1 = 0;
    if (notify_on_run !== undefined) {
      try {
        normalizedNotify = normalizeNotifyOnRun(notify_on_run);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    }
    const result = stmts.createCron.run(
      name,
      schedule,
      prompt,
      cwd || config.defaultCwd,
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
      project_id || null,
      normalizedTimeout,
      normalizedNotify,
    );
    const cronJob = stmts.getCron.get(result.lastInsertRowid) as CronRow;
    rescheduleCron(cronJob);
    res.json(cronJob);
  });

  router.put('/api/crons/:id', (req: Request, res: Response) => {
    const existing = stmts.getCron.get(parseInt(req.params.id as string)) as CronRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Cron not found' });

    const { name, schedule, prompt, cwd, enabled, project_id, timeout_ms, notify_on_run } =
      req.body;
    let nextTimeout: number | null = existing.timeout_ms;
    if (Object.prototype.hasOwnProperty.call(req.body, 'timeout_ms')) {
      try {
        nextTimeout = normalizeTimeoutMs(timeout_ms);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    }
    let nextNotify: 0 | 1 = (existing.notify_on_run ? 1 : 0) as 0 | 1;
    if (Object.prototype.hasOwnProperty.call(req.body, 'notify_on_run')) {
      try {
        nextNotify = normalizeNotifyOnRun(notify_on_run);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    }
    stmts.updateCron.run(
      name || existing.name,
      schedule || existing.schedule,
      prompt || existing.prompt,
      cwd || existing.cwd,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      project_id !== undefined ? project_id : existing.project_id || null,
      nextTimeout,
      nextNotify,
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
