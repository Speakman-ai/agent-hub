import { Router, Request, Response } from 'express';
import { statSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { db } from '../db.js';
import { getSlackStatus, restartSlack, getSlackMessages, getAllSlackMessages } from '../slack.js';
import type { RouteDeps, EnrichedAgent, AppConfig, Stmts, Project } from '../types.js';
import { getLogBuffer } from '../server-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve the server version from server/package.json (one level up from
// server/routes/). We deliberately avoid the repo-root package.json because in
// the packaged Electron app only `server/**/*` is listed in asarUnpack — the
// root package.json lives inside app.asar and is not reachable from
// app.asar.unpacked/server/routes/. Reading server/package.json keeps the dev
// and production paths symmetric and both package.json files are kept in
// lockstep at the same version.
const serverVersion: string = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
).version;

// Short git SHA of the running server, resolved once at module load. Used by
// the sidebar to surface stale-bundle / client-vs-server build drift.
// Prefer the AGENT_HUB_GIT_HASH env (set by deploy scripts / Dockerfile);
// otherwise shell out to git. Empty string when neither is available
// (packaged Electron/asar with no .git).
function resolveGitHash(): string {
  if (process.env.AGENT_HUB_GIT_HASH) return process.env.AGENT_HUB_GIT_HASH;
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}
const serverGitHash: string = resolveGitHash();

interface HealthRouteDeps {
  allAgents: () => EnrichedAgent[];
  getProjects: () => Project[];
  config: AppConfig;
}

interface DirectoryEntry {
  name: string;
  type: 'directory';
  path: string;
}

export function createHealthRoute(deps: HealthRouteDeps): Router {
  const { allAgents, getProjects, config } = deps;
  const router = Router();

  router.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: serverVersion,
      gitHash: serverGitHash,
      uptime: process.uptime(),
      projects: getProjects().length,
      agents: allAgents().length,
      authRequired: !!config.apiKey,
    });
  });

  return router;
}

export default function createMiscRoutes(deps: RouteDeps): Router {
  const { allAgents, getEnrichedAgent, stmts } = deps;
  const router = Router();

  router.get('/api/server-logs', (_req: Request, res: Response) => {
    res.json(getLogBuffer());
  });

  router.get('/api/browse', (req: Request, res: Response) => {
    const home = process.env.HOME || '/home/' + (process.env.USER || 'user');
    let targetPath = (req.query.path as string | undefined) || home;

    if (targetPath === '~' || targetPath.startsWith('~/')) {
      targetPath = path.join(home, targetPath.slice(1));
    }
    targetPath = path.resolve(targetPath);

    if (!targetPath.startsWith(home)) {
      return res.status(403).json({ error: 'Browsing is restricted to the home directory' });
    }

    try {
      const stat = statSync(targetPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
    } catch {
      return res.status(404).json({ error: 'Path does not exist' });
    }

    const entries: DirectoryEntry[] = [];
    try {
      const names = readdirSync(targetPath);
      for (const name of names) {
        if (entries.length >= 200) break;
        try {
          const fullPath = path.join(targetPath, name);
          const s = statSync(fullPath);
          if (s.isDirectory()) {
            entries.push({ name, type: 'directory', path: fullPath });
          }
        } catch {
          // Skip entries with permission errors
        }
      }
    } catch {
      return res.status(403).json({ error: 'Cannot read directory' });
    }

    entries.sort((a, b) => {
      const aDot = a.name.startsWith('.');
      const bDot = b.name.startsWith('.');
      if (aDot !== bDot) return aDot ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    const parentPath = path.dirname(targetPath);
    res.json({
      path: targetPath,
      parent: parentPath.startsWith(home) ? parentPath : null,
      entries,
    });
  });

  router.post('/api/devices', (req: Request, res: Response) => {
    const { token, platform } = req.body as { token?: string; platform?: string };
    if (!token) return res.status(400).json({ error: 'token is required' });
    stmts.registerDeviceToken.run(token, platform || 'ios');
    res.json({ ok: true });
  });

  router.delete('/api/devices/:token', (req: Request, res: Response) => {
    stmts.removeDeviceToken.run(req.params.token);
    res.json({ ok: true });
  });

  router.get('/api/usage', (_req: Request, res: Response) => {
    try {
      const totals = db!
        .prepare(
          `
        SELECT COUNT(*) as count,
               COALESCE(SUM(json_extract(payload, '$.costUsd')), 0) as total_cost,
               COALESCE(SUM(json_extract(payload, '$.durationMs')), 0) as total_duration_ms,
               COALESCE(SUM(json_extract(payload, '$.numTurns')), 0) as total_turns
        FROM session_events WHERE event_type = 'result'
      `,
        )
        .get() as Record<string, unknown>;

      const byAgent = db!
        .prepare(
          `
        SELECT s.agent_id,
               COUNT(*) as count,
               COALESCE(SUM(json_extract(se.payload, '$.costUsd')), 0) as total_cost,
               COALESCE(SUM(json_extract(se.payload, '$.durationMs')), 0) as total_duration_ms,
               COALESCE(SUM(json_extract(se.payload, '$.numTurns')), 0) as total_turns
        FROM session_events se
        JOIN messages m ON se.parent_id = m.id
        JOIN sessions s ON m.session_id = s.id
        WHERE se.event_type = 'result' AND se.parent_kind = 'message'
        GROUP BY s.agent_id
        ORDER BY total_cost DESC
      `,
        )
        .all() as Array<Record<string, unknown> & { agent_id: string }>;

      const byAgentEnriched = byAgent.map((row) => {
        const agent = getEnrichedAgent(row.agent_id);
        return {
          ...row,
          agent_name: agent?.name || row.agent_id,
          agent_color: agent?.color || '#666',
        };
      });

      const byDay = db!
        .prepare(
          `
        SELECT date(se.timestamp, 'localtime') as day,
               COUNT(*) as count,
               COALESCE(SUM(json_extract(se.payload, '$.costUsd')), 0) as cost,
               COALESCE(SUM(json_extract(se.payload, '$.durationMs')), 0) as duration_ms,
               COALESCE(SUM(json_extract(se.payload, '$.numTurns')), 0) as turns
        FROM session_events se
        WHERE se.event_type = 'result'
          AND se.timestamp >= datetime('now', '-30 days')
        GROUP BY date(se.timestamp, 'localtime')
        ORDER BY day DESC
      `,
        )
        .all() as Array<Record<string, unknown>>;

      const recentSessions = (
        db!
          .prepare(
            `
        SELECT s.id, s.agent_id, s.name as session_name,
               COUNT(*) as message_count,
               COALESCE(SUM(json_extract(se.payload, '$.costUsd')), 0) as cost,
               COALESCE(SUM(json_extract(se.payload, '$.durationMs')), 0) as duration_ms,
               MAX(se.timestamp) as last_activity
        FROM session_events se
        JOIN messages m ON se.parent_id = m.id
        JOIN sessions s ON m.session_id = s.id
        WHERE se.event_type = 'result' AND se.parent_kind = 'message'
        GROUP BY s.id
        ORDER BY last_activity DESC
        LIMIT 20
      `,
          )
          .all() as Array<Record<string, unknown> & { agent_id: string }>
      ).map((row) => {
        const agent = getEnrichedAgent(row.agent_id);
        return {
          ...row,
          agent_name: agent?.name || row.agent_id,
          agent_color: agent?.color || '#666',
        };
      });

      res.json({
        totals,
        byAgent: byAgentEnriched,
        byDay,
        recentSessions,
      });
    } catch (err: unknown) {
      console.error('Usage query error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/slack/status', (_req: Request, res: Response) => {
    res.json(getSlackStatus());
  });

  router.post('/api/slack/restart', async (_req: Request, res: Response) => {
    try {
      await restartSlack(allAgents(), stmts);
      res.json({ ok: true, status: getSlackStatus() });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/slack/messages', (req: Request, res: Response) => {
    const agentId = req.query.agentId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    if (agentId) {
      res.json(getSlackMessages(agentId, limit));
    } else {
      res.json(getAllSlackMessages(limit));
    }
  });

  return router;
}
