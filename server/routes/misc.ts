import { Router, Request, Response } from 'express';
import { statSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { db } from '../db.js';
import type { RouteDeps, EnrichedAgent, AppConfig, Project } from '../types.js';
import { getLogBuffer } from '../server-log.js';
import { isLogShippingEnabled } from '../log-shipper.js';
import { PUSH_EVENT_TYPES } from '../push.js';
import { isAuthConfigured } from '../auth-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import {
  computeUsageTotals,
  computeUsageByAgent,
  computeUsageByDay,
  computeRecentSessions,
} from '../usage-aggregation.js';

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
      authRequired: !!config.apiKey || isAuthConfigured(),
      apiKeyAuthEnabled: !!config.apiKey,
      jwtAuthEnabled: isAuthConfigured(),
      // Boolean only — see isLogShippingEnabled(). False means AHLOG_TOKEN is
      // unset and the Hub is not shipping its own console logs to the Logs
      // module, which otherwise presents only as an indefinitely-empty module.
      logShipping: { enabled: isLogShippingEnabled() },
    });
  });

  return router;
}

export default function createMiscRoutes(deps: RouteDeps): Router {
  const { allAgents, getEnrichedAgent, stmts } = deps;
  const router = Router();

  const mayAccessToken = (req: Request, row: { user_id?: string | null } | undefined): boolean => {
    if (!row) return false;
    const authedReq = req as AuthenticatedRequest;
    const caller = authedReq.authUserId ?? null;
    // In local-bundled mode or apiKey break-glass there is no per-user
    // boundary to enforce.
    if (!caller) return true;
    // Legacy rows may have NULL user_id until the device re-registers.
    if (!row.user_id) return true;
    return row.user_id === caller;
  };

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
    const authedReq = req as AuthenticatedRequest;
    stmts.registerDeviceToken.run(token, platform || 'ios', authedReq.authUserId ?? null);
    res.json({ ok: true });
  });

  router.delete('/api/devices/:token', (req: Request, res: Response) => {
    const row = stmts.getDeviceToken.get(req.params.token) as
      | { token: string; user_id: string | null }
      | undefined;
    if (!mayAccessToken(req, row)) return res.status(404).json({ error: 'Token not registered' });
    stmts.removeDeviceToken.run(req.params.token);
    res.json({ ok: true });
  });

  // Return the current preferences for a registered push token.
  // `enabled_events` is either null (all events) or a JSON array of strings.
  router.get('/api/devices/:token', (req: Request, res: Response) => {
    const row = stmts.getDeviceToken.get(req.params.token) as
      | { token: string; platform: string; user_id: string | null; enabled_events: string | null }
      | undefined;
    if (!row || !mayAccessToken(req, row))
      return res.status(404).json({ error: 'Token not registered' });
    let enabledEvents: string[] | null = null;
    if (row.enabled_events) {
      try {
        const parsed = JSON.parse(row.enabled_events);
        enabledEvents = Array.isArray(parsed)
          ? parsed.filter((x): x is string => typeof x === 'string')
          : null;
      } catch {
        enabledEvents = null;
      }
    }
    res.json({
      token: row.token,
      platform: row.platform,
      enabledEvents,
      supportedEvents: [...PUSH_EVENT_TYPES],
    });
  });

  // Update per-event push preferences for a token. Body: `{ enabledEvents:
  // string[] | null }`. `null` / omitted → clear preferences (all events
  // enabled, the legacy default). Unknown event names are stripped so a
  // malformed client can't permanently disable anything.
  router.put('/api/devices/:token/preferences', (req: Request, res: Response) => {
    const body = req.body as { enabledEvents?: string[] | null };
    const row = stmts.getDeviceToken.get(req.params.token) as
      | { token: string; user_id: string | null }
      | undefined;
    if (!row || !mayAccessToken(req, row))
      return res.status(404).json({ error: 'Token not registered' });

    if (body.enabledEvents == null) {
      stmts.setDeviceTokenPreferences.run(null, req.params.token);
      return res.json({ ok: true, enabledEvents: null });
    }
    if (!Array.isArray(body.enabledEvents)) {
      return res.status(400).json({ error: 'enabledEvents must be an array or null' });
    }
    const allowed = new Set<string>(PUSH_EVENT_TYPES);
    const cleaned = body.enabledEvents.filter(
      (x): x is string => typeof x === 'string' && allowed.has(x),
    );
    stmts.setDeviceTokenPreferences.run(JSON.stringify(cleaned), req.params.token);
    res.json({ ok: true, enabledEvents: cleaned });
  });

  router.get('/api/usage', (_req: Request, res: Response) => {
    try {
      // Cost aggregation lives in `server/usage-aggregation.ts`. It
      // deduplicates `total_cost_usd` per parent_id (MAX, not SUM) because
      // the Claude Code CLI emits cumulative cost on each result event.
      // See that module's header comment for the full rationale.
      const totals = computeUsageTotals(db!);

      const byAgentEnriched = computeUsageByAgent(db!).map((row) => {
        const agent = getEnrichedAgent(row.agent_id);
        return {
          ...row,
          agent_name: agent?.name || row.agent_id,
          agent_color: agent?.color || '#666',
        };
      });

      const byDay = computeUsageByDay(db!);

      const recentSessions = computeRecentSessions(db!).map((row) => {
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

  return router;
}
