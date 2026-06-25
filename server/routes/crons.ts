import { Router, Request, Response } from 'express';
import type { z } from 'zod';
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
import { CreateCronRequestSchema, UpdateCronRequestSchema } from './crons.openapi.js';
import { DEFAULT_CRON_ENGINE, isSupportedEngine, resolveCronEngine } from '../cron-engine.js';
import { ALL_SUPPORTED_ENGINES } from '../engine-availability.js';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveOwnerUserId } from '../session-ownership.js';

/**
 * Coerce an `engine` request value into the DB-friendly form: a non-empty
 * string from `ALL_SUPPORTED_ENGINES`, or null (= "use default / inherit
 * from skill principal at run time"). Throws on a bad type or an unknown
 * engine so the API returns 400 instead of persisting a value the resolver
 * would silently fall back from.
 */
export function normalizeCronEngine(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new Error('engine must be a string');
  }
  if (!isSupportedEngine(raw)) {
    throw new Error(`engine must be one of: ${ALL_SUPPORTED_ENGINES.join(', ')}`);
  }
  return raw;
}

/**
 * Coerce a `model` request value into the DB-friendly form: a non-empty
 * string from the engine's allowlist (`config.engineValidModels[engine]`),
 * or null (use that engine's default). Throws on a bad type or an unknown
 * id so the API returns 400 instead of silently persisting a model the CLI
 * will reject at run time.
 *
 * The validation engine is whichever engine the cron will run under (see
 * `resolveCronEngine`): an explicit per-row `engine`, the skill principal
 * agent's `engine`, or the historical `claude-code` fallback. This keeps a
 * Cursor cron from accepting a Claude id, and vice versa.
 *
 * Exported (module-scoped) so import paths in `routes/config.ts` can reuse
 * the same allowlist check on cron rows arriving via project / v1-agents
 * config import. The optional `engine` argument lets callers pass the
 * already-resolved engine; defaults to `DEFAULT_CRON_ENGINE` so legacy
 * call sites that haven't been threaded through still validate against
 * the historical Claude allowlist (i.e. unchanged behaviour).
 */
export function normalizeCronModel(
  raw: unknown,
  engine: string = DEFAULT_CRON_ENGINE,
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new Error('model must be a string');
  }
  const allowed = config.engineValidModels[engine] || [];
  if (!allowed.includes(raw)) {
    throw new Error(`model must be one of (engine=${engine}): ${allowed.join(', ')}`);
  }
  return raw;
}

export function normalizeCronSkillPrincipal(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new Error('skill_principal_agent_id must be a string');
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * Throws when a non-null principal is paired with a missing/unknown project or
 * when the id is not an agent on that project.
 */
export function assertCronSkillPrincipalMatchesProject(
  projectId: string | null,
  principal: string | null,
  projects: Project[],
): void {
  if (!principal) return;
  if (!projectId) {
    throw new Error('skill_principal_agent_id requires project_id');
  }
  const proj = projects.find((p) => p.id === projectId);
  if (!proj || !proj.agents.some((a) => a.id === principal)) {
    throw new Error('skill_principal_agent_id must reference an agent in the cron project');
  }
}

/**
 * Validate `req.body` against a Zod schema. On failure, writes a 400 with
 * `{error, details}` and returns `undefined`; the handler must `return`
 * immediately. On success, returns the parsed data (typed).
 *
 * Mirrors the helper in `agents.ts` / `board.ts` / `wiki.ts` / `sessions.ts`
 * so the wire shape of validation failures is identical across route groups.
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

/**
 * Coerce the loose `notify_on_run` accept (boolean / 0 / 1 / "0" / "1" /
 * "true" / "false") into the strict 0/1 the DB column wants.
 *
 * The Zod schema gates the wire shape; this just folds the union into the
 * single canonical form. Any value not in the accept set never reaches
 * here — Zod has already returned 400.
 */
function coerceNotifyOnRun(raw: boolean | 0 | 1 | '0' | '1' | 'true' | 'false'): 0 | 1 {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 1;
  return 0;
}

/**
 * Coerce the parsed `timeout_ms` (number | null | "" | undefined) into the
 * DB-friendly `number | null` form. `undefined` (omitted) is the caller's
 * problem to handle; this only translates the present-key shapes.
 */
function coerceTimeoutMs(raw: number | null | ''): number | null {
  if (raw === null || raw === '') return null;
  return raw;
}

export default function createCronRoutes(deps: RouteDeps): Router {
  const { stmts } = deps;
  const router = Router();

  router.get('/api/crons', (_req: Request, res: Response) => {
    const crons = stmts.getCrons.all() as CronRow[];
    res.json(crons);
  });

  router.post('/api/crons', (req: Request, res: Response) => {
    const parsed = parseBody(CreateCronRequestSchema, req, res);
    if (!parsed) return;
    const {
      name,
      schedule,
      prompt,
      cwd,
      enabled,
      project_id,
      timeout_ms,
      notify_on_run,
      model,
      skill_principal_agent_id,
      engine,
    } = parsed;

    const normalizedTimeout = timeout_ms !== undefined ? coerceTimeoutMs(timeout_ms) : null;
    const normalizedNotify = notify_on_run !== undefined ? coerceNotifyOnRun(notify_on_run) : 0;

    let normalizedEngine: string | null;
    try {
      normalizedEngine = normalizeCronEngine(engine);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    let normalizedSkillPrincipal: string | null;
    try {
      normalizedSkillPrincipal = normalizeCronSkillPrincipal(skill_principal_agent_id);
      assertCronSkillPrincipalMatchesProject(
        project_id || null,
        normalizedSkillPrincipal,
        getProjects(),
      );
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    // Validate the model against the engine that this cron would actually run
    // under (explicit `engine` → skill-principal agent's engine → claude-code).
    // This keeps a cursor-agent cron from accepting a Claude id and vice versa.
    const projects = getProjects();
    const project = (project_id && projects.find((p) => p.id === project_id)) || null;
    const effectiveEngine = resolveCronEngine(
      { engine: normalizedEngine, skill_principal_agent_id: normalizedSkillPrincipal },
      project,
    );

    let normalizedModel: string | null;
    try {
      normalizedModel = normalizeCronModel(model, effectiveEngine);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
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
      normalizedModel,
      normalizedSkillPrincipal,
      normalizedEngine,
      resolveOwnerUserId(req as AuthenticatedRequest),
    );
    const cronJob = stmts.getCron.get(result.lastInsertRowid) as CronRow;
    rescheduleCron(cronJob);
    res.json(cronJob);
  });

  router.put('/api/crons/:id', (req: Request, res: Response) => {
    const existing = stmts.getCron.get(parseInt(req.params.id as string)) as CronRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Cron not found' });

    const parsed = parseBody(UpdateCronRequestSchema, req, res);
    if (!parsed) return;
    const {
      name,
      schedule,
      prompt,
      cwd,
      enabled,
      project_id,
      timeout_ms,
      notify_on_run,
      model,
      skill_principal_agent_id,
      engine,
    } = parsed;

    let nextTimeout: number | null = existing.timeout_ms;
    if (Object.prototype.hasOwnProperty.call(req.body, 'timeout_ms')) {
      nextTimeout = timeout_ms === undefined ? null : coerceTimeoutMs(timeout_ms);
    }

    let nextNotify: 0 | 1 = (existing.notify_on_run ? 1 : 0) as 0 | 1;
    if (
      Object.prototype.hasOwnProperty.call(req.body, 'notify_on_run') &&
      notify_on_run !== undefined
    ) {
      nextNotify = coerceNotifyOnRun(notify_on_run);
    }

    let nextEngine: string | null = existing.engine;
    if (Object.prototype.hasOwnProperty.call(req.body, 'engine')) {
      try {
        nextEngine = normalizeCronEngine(engine);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    }

    const nextProjectId =
      project_id !== undefined ? project_id : (existing.project_id as string | null) || null;

    let nextSkillPrincipal: string | null = existing.skill_principal_agent_id ?? null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'skill_principal_agent_id')) {
      try {
        nextSkillPrincipal = normalizeCronSkillPrincipal(skill_principal_agent_id);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    }
    try {
      assertCronSkillPrincipalMatchesProject(nextProjectId, nextSkillPrincipal, getProjects());
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    // Resolve the engine the row will run under after this update so model
    // validation lines up with the run-time decision (see POST handler note).
    const projects = getProjects();
    const projectForResolve =
      (nextProjectId && projects.find((p) => p.id === nextProjectId)) || null;
    const effectiveEngine = resolveCronEngine(
      { engine: nextEngine, skill_principal_agent_id: nextSkillPrincipal },
      projectForResolve,
    );

    let nextModel: string | null = existing.model;
    if (Object.prototype.hasOwnProperty.call(req.body, 'model')) {
      try {
        nextModel = normalizeCronModel(model, effectiveEngine);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    } else if (
      // When the engine changes but the model is left alone, the existing model
      // may now be invalid for the newly resolved engine. Re-validate the
      // surviving value so we don't silently persist a Claude id under a
      // Cursor engine. Clearing on incompatibility is the safest behaviour;
      // the user can resend a compatible model in the same PUT.
      Object.prototype.hasOwnProperty.call(req.body, 'engine') &&
      existing.model
    ) {
      try {
        nextModel = normalizeCronModel(existing.model, effectiveEngine);
      } catch {
        nextModel = null;
      }
    }

    stmts.updateCron.run(
      name || existing.name,
      schedule || existing.schedule,
      prompt || existing.prompt,
      cwd || existing.cwd,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      nextProjectId,
      nextTimeout,
      nextNotify,
      nextModel,
      nextSkillPrincipal,
      nextEngine,
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
