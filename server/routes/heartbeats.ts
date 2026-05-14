import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import { runHeartbeat, rescheduleHeartbeat } from '../heartbeat.js';
import type {
  RouteDeps,
  HeartbeatLogRow,
  HeartbeatStateRow,
  ThreadRow,
  ThreadEntryRow,
} from '../types.js';
import { UpdateHeartbeatRequestSchema } from './heartbeats.openapi.js';

interface HeartbeatOverview {
  agentId: string;
  agentName: string;
  color: string | undefined;
  heartbeat: { enabled: boolean; interval: string; prompt: string };
  latestLog: HeartbeatLogRow | null;
  state: HeartbeatStateRow | null;
}

interface HeartbeatStateInfo {
  agentId: string;
  agentName: string;
  enabled: boolean;
  interval: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  overdue: boolean;
  overdue_seconds: number;
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

export default function createHeartbeatRoutes(deps: RouteDeps): Router {
  const { allAgents, findAgent, getEnrichedAgent, saveProjects, stmts } = deps;
  const router = Router();

  router.get('/api/heartbeats/:agentId/thread', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });

    const { project } = found;
    const thread = stmts.getThreadBySource.get(project.id, 'heartbeat', req.params.agentId) as
      | ThreadRow
      | undefined;
    if (!thread) {
      return res.json({ thread: null, entries: [] });
    }

    const entries = stmts.getThreadEntries.all(thread.id) as ThreadEntryRow[];
    res.json({ thread, entries });
  });

  router.get('/api/heartbeats', (_req: Request, res: Response) => {
    const configs: HeartbeatOverview[] = allAgents().map((a) => ({
      agentId: a.id,
      agentName: a.name,
      color: a.color,
      heartbeat: a.heartbeat || { enabled: false, interval: '', prompt: '' },
      latestLog: (stmts.getLatestHeartbeat.get(a.id) as HeartbeatLogRow | undefined) || null,
      state: (stmts.getHeartbeatState.get(a.id) as HeartbeatStateRow | undefined) || null,
    }));
    res.json(configs);
  });

  router.get('/api/heartbeats/state', (_req: Request, res: Response) => {
    const now = Date.now();
    const rows: HeartbeatStateInfo[] = allAgents()
      .filter((a) => a.heartbeat?.enabled || a.heartbeat?.interval)
      .map((a) => {
        const state = (stmts.getHeartbeatState.get(a.id) as HeartbeatStateRow | undefined) || null;
        const nextMs = state?.next_run_at ? Date.parse(state.next_run_at) : null;
        return {
          agentId: a.id,
          agentName: a.name,
          enabled: !!a.heartbeat?.enabled,
          interval: a.heartbeat?.interval || null,
          next_run_at: state?.next_run_at || null,
          last_run_at: state?.last_run_at || null,
          overdue: nextMs != null && Number.isFinite(nextMs) ? nextMs < now : false,
          overdue_seconds:
            nextMs != null && Number.isFinite(nextMs) && nextMs < now
              ? Math.round((now - nextMs) / 1000)
              : 0,
        };
      });
    res.json(rows);
  });

  router.get('/api/heartbeats/:agentId/logs', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const logs = stmts.getHeartbeatLogs.all(req.params.agentId, limit) as HeartbeatLogRow[];
    res.json(logs);
  });

  router.put('/api/heartbeats/:agentId', (req: Request, res: Response) => {
    const found = findAgent(req.params.agentId as string);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const { agent } = found;

    const parsed = parseBody(UpdateHeartbeatRequestSchema, req, res);
    if (!parsed) return;
    const { enabled, interval, prompt, model } = parsed;

    // `model` uses an explicit-undefined check so the caller can clear the
    // override by sending `""` or `null` (mapped to undefined) without losing
    // it under the truthy-fallback logic the other fields use.
    let nextModel = agent.heartbeat?.model;
    if (model !== undefined) {
      const trimmed = typeof model === 'string' ? model.trim() : '';
      nextModel = trimmed || undefined;
    }

    agent.heartbeat = {
      enabled: enabled !== undefined ? enabled : (agent.heartbeat?.enabled ?? false),
      interval: interval || agent.heartbeat?.interval || '',
      prompt: prompt || agent.heartbeat?.prompt || '',
      ...(nextModel ? { model: nextModel } : {}),
    };

    saveProjects();
    rescheduleHeartbeat(getEnrichedAgent(agent.id)!);
    res.json(agent.heartbeat);
  });

  router.post('/api/heartbeats/:agentId/run', async (req: Request, res: Response) => {
    const enriched = getEnrichedAgent(req.params.agentId as string);
    if (!enriched) return res.status(404).json({ error: 'Agent not found' });
    if (!enriched.heartbeat?.prompt) {
      return res.status(400).json({ error: 'No heartbeat prompt configured' });
    }

    const logEntry = stmts.addHeartbeatLog.run(enriched.id, enriched.heartbeat.prompt, 'running');
    const logId = logEntry.lastInsertRowid;
    res.json({ logId, status: 'running' });

    runHeartbeat(enriched).catch((err: Error) => {
      console.error(`Manual heartbeat failed for ${enriched.name}:`, err);
    });
  });

  return router;
}
