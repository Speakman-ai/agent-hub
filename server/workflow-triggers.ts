/**
 * Hub workflow V1.1 triggers: node-cron schedules and signed HTTP webhooks.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import config from './config.js';
import { startWorkflowRun } from './workflow-runner.js';
import type { Stmts, BroadcastFn, EnrichedAgent, Project } from './types.js';

/** Preset label → node-cron expression (server-authoritative). */
export const CRON_PRESETS: Record<string, string> = {
  every_15_min: '*/15 * * * *',
  every_hour: '0 * * * *',
  daily_midnight_utc: '0 0 * * *',
  weekdays_9am_utc: '0 9 * * 1-5',
};

export function resolveCronExpr(
  preset: string | null | undefined,
  expr: string | null | undefined,
): string | null {
  if (preset && typeof preset === 'string' && CRON_PRESETS[preset]) {
    return CRON_PRESETS[preset];
  }
  if (expr == null) return null;
  const t = String(expr).trim();
  return t.length ? t : null;
}

function publicApiBase(): string {
  const p = config.publicUrl?.replace(/\/$/, '');
  if (p) return p;
  return `http://localhost:${config.port}`;
}

export function buildWorkflowWebhookUrl(pathToken: string | null | undefined): string | null {
  if (!pathToken) return null;
  return `${publicApiBase()}/api/workflow-webhook/${pathToken}`;
}

export function generateWebhookSigningSecret(): string {
  return randomBytes(32).toString('hex');
}

function isoOrNull(d: Date | null | undefined): string | null {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function computeNextRunIso(expr: string): string | null {
  if (!cron.validate(expr)) return null;
  // `scheduled: false` prevents the task from running; we only need getNextRun for preview.
  const task = cron.schedule(expr, () => {}, { scheduled: false } as Parameters<
    typeof cron.schedule
  >[2]);
  try {
    return isoOrNull(task.getNextRun?.() ?? null);
  } finally {
    task.stop();
  }
}

export function getCronNextRunPreview(expr: string | null | undefined): string | null {
  if (expr == null) return null;
  const t = String(expr).trim();
  if (!t.length) return null;
  return computeNextRunIso(t);
}

export function verifyWorkflowWebhookSignature(
  rawBody: Buffer,
  signingSecret: string,
  header: string | undefined,
): boolean {
  if (!header || !signingSecret) return false;
  const m = String(header).match(/^sha256=([0-9a-f]+)$/i);
  if (!m) return false;
  const expectedHex = createHmac('sha256', signingSecret).update(rawBody).digest('hex');
  const got = m[1]!;
  if (got.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

const workflowCronTasks = new Map<string, ScheduledTask>();

type TriggerDeps = {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getEnrichedAgent: (id: string) => EnrichedAgent | null;
  findProject: (id: string) => Project | null;
};

function persistWorkflowCronNextRun(
  stmts: Stmts,
  projectId: string,
  workflowId: string,
  task: ScheduledTask,
): void {
  try {
    const next = isoOrNull(task.getNextRun?.() ?? null);
    stmts.updateWorkflowCronNextRun.run(next, workflowId, projectId);
  } catch (err) {
    console.error(
      '[workflow-cron] persist next run:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function clearWorkflowCronSchedule(workflowId: string): void {
  const t = workflowCronTasks.get(workflowId);
  if (t) {
    t.stop();
    workflowCronTasks.delete(workflowId);
  }
}

function registerWorkflowCron(
  deps: TriggerDeps,
  row: Record<string, unknown> & { id: string; project_id: string; cron_expr: string | null },
): void {
  const workflowId = String(row.id);
  const projectId = String(row.project_id);
  const expr = row.cron_expr;
  if (expr == null || !String(expr).trim()) {
    clearWorkflowCronSchedule(workflowId);
    return;
  }
  const schedule = String(expr).trim();
  if (!cron.validate(schedule)) {
    console.warn(`[workflow-cron] invalid expression for workflow ${workflowId}: ${schedule}`);
    clearWorkflowCronSchedule(workflowId);
    try {
      deps.stmts.updateWorkflowCronNextRun.run(null, workflowId, projectId);
    } catch (err) {
      console.error('[workflow-cron] clear next_run (invalid expr)', (err as Error).message);
    }
    return;
  }
  clearWorkflowCronSchedule(workflowId);
  const task = cron.schedule(
    schedule,
    () => {
      const id = uuidv4();
      const runPayload = JSON.stringify({
        source: 'cron',
        firedAt: new Date().toISOString(),
      });
      try {
        deps.stmts.createWorkflowRun.run(id, workflowId, 'pending', runPayload);
        deps.broadcast({ type: 'workflow_run', projectId, workflowId, runId: id });
        startWorkflowRun(
          {
            stmts: deps.stmts,
            broadcast: deps.broadcast,
            getEnrichedAgent: deps.getEnrichedAgent,
            findProject: deps.findProject,
          },
          { projectId, workflowId, runId: id },
        );
      } catch (e) {
        console.error(
          '[workflow-cron] tick',
          workflowId,
          e instanceof Error ? e.message : String(e),
        );
      }
      persistWorkflowCronNextRun(deps.stmts, projectId, workflowId, task);
    },
    { timezone: 'UTC' },
  );
  workflowCronTasks.set(workflowId, task);
  console.debug(`[workflow-cron] scheduled workflow ${workflowId}: ${schedule}`);
  persistWorkflowCronNextRun(deps.stmts, projectId, workflowId, task);
}

/**
 * (Re)register cron for one workflow, or all workflows when `workflowId` is null.
 */
export function refreshWorkflowCronSchedules(deps: TriggerDeps, workflowId: string | null): void {
  if (workflowId) {
    const row = deps.stmts.getWorkflow.get(workflowId) as
      | (Record<string, unknown> & { id: string; project_id: string; cron_expr: string | null })
      | undefined;
    if (!row) {
      clearWorkflowCronSchedule(workflowId);
      return;
    }
    if (row.cron_expr == null || !String(row.cron_expr).trim()) {
      clearWorkflowCronSchedule(workflowId);
      try {
        deps.stmts.updateWorkflowCronNextRun.run(null, workflowId, String(row.project_id));
      } catch (err) {
        console.error('[workflow-cron] clear next_run', (err as Error).message);
      }
      return;
    }
    registerWorkflowCron(
      deps,
      row as Record<string, unknown> & { id: string; project_id: string; cron_expr: string | null },
    );
    return;
  }
  for (const [, t] of workflowCronTasks) t.stop();
  workflowCronTasks.clear();
  const rows = deps.stmts.getWorkflowsWithCronExpr.all() as Array<
    Record<string, unknown> & { id: string; project_id: string; cron_expr: string | null }
  >;
  for (const row of rows) {
    registerWorkflowCron(deps, row);
  }
}

export function createWorkflowIncomingRouter(deps: TriggerDeps): Router {
  const r = Router();

  r.post('/api/workflow-webhook/:pathToken', (req: Request, res: Response) => {
    const pathToken = String(req.params.pathToken || '');
    if (!pathToken) {
      return res.status(400).json({ error: 'Missing token' });
    }
    const row = deps.stmts.getWorkflowByWebhookToken.get(pathToken) as
      | (Record<string, unknown> & {
          id: string;
          project_id: string;
          webhook_signing_secret: string | null;
        })
      | undefined;
    if (!row) {
      return res.status(404).json({ error: 'Unknown webhook' });
    }
    const secret = row.webhook_signing_secret;
    if (!secret) {
      return res.status(503).json({ error: 'Webhook signing secret not configured' });
    }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      return res.status(400).json({ error: 'Missing request body' });
    }
    const ok = verifyWorkflowWebhookSignature(
      raw,
      secret,
      req.get('x-agent-hub-signature') || req.get('X-Agent-Hub-Signature') || undefined,
    );
    if (!ok) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let triggerPayload: Record<string, unknown> = {};
    const ct = String(req.get('content-type') || '');
    if (ct.includes('application/json')) {
      try {
        const j = JSON.parse(raw.toString('utf8') || '{}');
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          triggerPayload = j as Record<string, unknown>;
        } else {
          triggerPayload = { value: j };
        }
      } catch {
        triggerPayload = { raw: raw.toString('utf8') };
      }
    } else if (raw.length) {
      triggerPayload = { raw: raw.toString('utf8') };
    }

    const workflowId = String(row.id);
    const projectId = String(row.project_id);
    const id = uuidv4();
    // System provenance last so caller JSON cannot override `source` (auditability).
    const runPayload = JSON.stringify({ ...triggerPayload, source: 'webhook' });
    try {
      deps.stmts.createWorkflowRun.run(id, workflowId, 'pending', runPayload);
      deps.broadcast({ type: 'workflow_run', projectId, workflowId, runId: id });
      startWorkflowRun(
        {
          stmts: deps.stmts,
          broadcast: deps.broadcast,
          getEnrichedAgent: deps.getEnrichedAgent,
          findProject: deps.findProject,
        },
        { projectId, workflowId, runId: id },
      );
    } catch (e) {
      console.error('[workflow-webhook]', (e as Error).message);
      return res.status(500).json({ error: 'Failed to start workflow run' });
    }
    return res.status(201).json({ ok: true, run_id: id });
  });

  return r;
}

/**
 * Call before/after a workflow row is removed so the cron task does not point at a dead id.
 */
export function discardWorkflowTriggerCron(workflowId: string): void {
  clearWorkflowCronSchedule(workflowId);
}
