import { Router } from 'express';
import { statSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { getSlackStatus, restartSlack, getSlackMessages, getAllSlackMessages } from '../slack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverVersion = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'),
).version;

/**
 * Health check router — mount BEFORE auth middleware.
 */
export function createHealthRoute(deps) {
  const { allAgents, getProjects, config } = deps;
  const router = Router();

  router.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: serverVersion,
      uptime: process.uptime(),
      projects: getProjects().length,
      agents: allAgents().length,
      authRequired: !!config.apiKey,
    });
  });

  return router;
}

/**
 * Miscellaneous protected routes: browse, devices, usage, slack.
 */
export default function createMiscRoutes(deps) {
  const { allAgents, getEnrichedAgent, stmts } = deps;
  const router = Router();

  // ─── Directory browsing (for project folder picker) ──────────────
  router.get('/api/browse', (req, res) => {
    const home = process.env.HOME || '/home/' + (process.env.USER || 'user');
    let targetPath = req.query.path || home;

    // Resolve ~ to home directory
    if (targetPath === '~' || targetPath.startsWith('~/')) {
      targetPath = path.join(home, targetPath.slice(1));
    }
    targetPath = path.resolve(targetPath);

    // Security: restrict browsing to home directory and below
    if (!targetPath.startsWith(home)) {
      return res.status(403).json({ error: 'Browsing is restricted to the home directory' });
    }

    // Validate path exists and is a directory
    try {
      const stat = statSync(targetPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
    } catch {
      return res.status(404).json({ error: 'Path does not exist' });
    }

    // Read directory entries, keeping only directories
    const entries = [];
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

    // Sort alphabetically, dot-directories last
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

  // ─── Push notification device tokens ──────────────────────────────
  router.post('/api/devices', (req, res) => {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });
    stmts.registerDeviceToken.run(token, platform || 'ios');
    res.json({ ok: true });
  });

  router.delete('/api/devices/:token', (req, res) => {
    stmts.removeDeviceToken.run(req.params.token);
    res.json({ ok: true });
  });

  // ─── Usage endpoints ──────────────────────────────────────────────
  router.get('/api/usage', (_req, res) => {
    try {
      // Overall totals
      const totals = db
        .prepare(
          `
        SELECT COUNT(*) as count,
               COALESCE(SUM(json_extract(payload, '$.costUsd')), 0) as total_cost,
               COALESCE(SUM(json_extract(payload, '$.durationMs')), 0) as total_duration_ms,
               COALESCE(SUM(json_extract(payload, '$.numTurns')), 0) as total_turns
        FROM session_events WHERE event_type = 'result'
      `,
        )
        .get();

      // Per-agent breakdown
      const byAgent = db
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
        .all();

      // Enrich with agent name/color
      const byAgentEnriched = byAgent.map((row) => {
        const agent = getEnrichedAgent(row.agent_id);
        return {
          ...row,
          agent_name: agent?.name || row.agent_id,
          agent_color: agent?.color || '#666',
        };
      });

      // Daily breakdown (last 30 days)
      const byDay = db
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
        .all();

      // Recent sessions with cost
      const recentSessions = db
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
        .all()
        .map((row) => {
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
    } catch (err) {
      console.error('Usage query error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Slack endpoints ───────────────────────────────────────────────
  router.get('/api/slack/status', (_req, res) => {
    res.json(getSlackStatus());
  });

  router.post('/api/slack/restart', async (_req, res) => {
    try {
      await restartSlack(allAgents(), stmts);
      res.json({ ok: true, status: getSlackStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/slack/messages', (req, res) => {
    const agentId = req.query.agentId;
    const limit = parseInt(req.query.limit) || 50;
    if (agentId) {
      res.json(getSlackMessages(agentId, limit));
    } else {
      res.json(getAllSlackMessages(limit));
    }
  });

  return router;
}
