import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { exec, execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { localDateStr } from '../memory.js';
import {
  getAppInfo,
  getAppInstallations,
  buildAppManifest,
  clearTokenCache,
} from '../github-app.js';
import type {
  RouteDeps,
  AppConfig,
  GitHubAppConfig,
  PersonalOAuthConfig,
  Project,
  Stmts,
} from '../types.js';
import { refreshShellPath, getCachedShellPath } from '../config.js';
import { validateKanbanAssignModel } from '../kanban-assign-model.js';
import { parsePrBaseBranchInput } from '../kanban-pr-base.js';
import { invalidateCursorAuthCache } from '../cursor-auth-cache.js';
import { buildAuthenticatedModelConfig } from '../model-config-auth.js';
import { normalizeCronModel, normalizeCronSkillPrincipal } from './crons.js';
import { getProjects } from '../project-model.js';
import { getEngineAuthStatus } from '../engine-auth-status.js';
import { isPrEnvKillSwitchOn } from '../pr-env-killswitch.js';

interface FileConfig {
  claudeBin?: string;
  cursorBin?: string;
  geminiBin?: string;
  codexBin?: string;
  githubApp?: GitHubAppConfig;
  personalOAuth?: PersonalOAuthConfig;
  [key: string]: unknown;
}

interface AppInfoCache {
  data: { name: string } | null;
  appId: string | null;
  ts: number;
}

interface Installation {
  id: number;
  account?: { login?: string; type?: string };
}

interface GitHubAppConversion {
  id: number;
  slug?: string;
  name?: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
}

interface CronImportData {
  name: string;
  schedule: string;
  prompt: string;
  cwd?: string;
  enabled?: boolean | number;
  project_id?: string;
  timeout_ms?: number | null;
  notify_on_run?: boolean | number;
  // Optional Claude model id. Validated against `engineValidModels['claude-code']`
  // by `normalizeCronModel`; unknown ids fall back to null (engine default) on
  // import rather than 500ing the whole batch.
  model?: string | null;
  /** Optional agent id for spawn skill-credential resolution; must belong to the import target project. */
  skill_principal_agent_id?: string | null;
}

function cronImportSkillPrincipal(raw: unknown, project: Project | null): string | null {
  if (!project) return null;
  try {
    const id = normalizeCronSkillPrincipal(raw);
    if (!id) return null;
    if (!project.agents.some((a) => a.id === id)) {
      console.warn(
        `[config import] Ignoring skill_principal_agent_id "${id}" — not an agent on project ${project.id}`,
      );
      return null;
    }
    return id;
  } catch {
    console.warn('[config import] Ignoring invalid skill_principal_agent_id field on cron row');
    return null;
  }
}

interface RoomImportData {
  id?: string;
  name: string;
  max_turns?: number;
  agents?: Array<{ agentId?: string; agent_id?: string }>;
}

interface WebhookImportData {
  repo_url: string;
  secret?: string;
  events?: string;
  enabled?: boolean | number;
  author_allowlist?: string;
}

interface WikiImportData {
  slug: string;
  title: string;
  content?: string;
  category?: string;
  updated_by?: string;
}

interface KanbanImportData {
  board?: { name?: string };
  columns?: Array<{
    id: string;
    name: string;
    position: number;
    color?: string;
  }>;
  cards?: Array<{
    id: string;
    column_id: string;
    title: string;
    description?: string;
    priority?: string;
    assignee?: string;
    labels?: string;
    github_issue_url?: string;
    pr_url?: string;
    created_by?: string;
    position?: number;
    epic_id?: string;
    pr_base_branch?: string | null;
  }>;
  epics?: Array<{
    id: string;
    name: string;
    description?: string;
    color?: string;
    position?: number;
  }>;
  comments?: Record<string, Array<{ author?: string; content: string }>>;
}

interface ProjectExportData {
  version: number;
  type: string;
  // The export endpoint serializes the entire project record (id, name, cwd,
  // ahw, color, agents, commands, leadAgent, subAgents, …). The merge-into-
  // existing path only consumes a subset, but the create-from-export path
  // needs id/name/cwd to seed a brand-new project, so the type lists those
  // explicitly.
  project?: {
    id?: string;
    name?: string;
    cwd?: string;
    ahw?: string;
    agents?: unknown[];
    color?: string;
    leadAgent?: string;
    subAgents?: string[];
    commands?: Record<string, string>;
    [key: string]: unknown;
  };
  crons?: CronImportData[];
  rooms?: RoomImportData[];
  webhooks?: WebhookImportData[];
  wiki?: WikiImportData[];
  kanban?: KanbanImportData;
}

interface LegacyAgent {
  id: string;
  name?: string;
  cwd?: string;
  workspace?: string;
  engine?: string;
  systemPrompt?: string;
  color?: string;
  heartbeat?: { enabled: boolean; interval: string; prompt: string };
}

interface LegacyExportData {
  version: number;
  config?: Record<string, unknown>;
  projects?: Project[];
  agents?: LegacyAgent[];
  crons?: CronImportData[];
  rooms?: RoomImportData[];
  slack?: {
    accounts?: Array<{
      botToken?: string;
      appToken?: string;
      [key: string]: unknown;
    }>;
  };
}

// Host-level Claude OAuth probe and the cursor-status shellout used to live
// here. They were moved to `engine-auth-status.ts` so `/api/setup/status` can
// reuse them. `/api/config/models` below now delegates to `getEngineAuthStatus`.

interface SlackConfigData {
  accounts: Array<{
    botToken?: string;
    appToken?: string;
    [key: string]: unknown;
  }>;
}

export default function createConfigRoutes(deps: RouteDeps): Router {
  const {
    stmts,
    getProjects,
    setProjects,
    saveProjects,
    config,
    getGhBotUser,
    setGhBotUser,
    getGhAppSlug,
    setGhAppSlug,
    serverDir,
    ensureReviewerAgents,
    broadcast,
    getProjectDataDir,
  } = deps;
  const router = Router();

  router.get('/api/config', (_req: Request, res: Response) => {
    let fileConfig: FileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(path.join(config.dataDir, 'config.json'), 'utf-8'));
    } catch {
      /* no file yet */
    }
    res.json({
      claudeBin: config.claudeBin,
      cursorBin: config.cursorBin,
      geminiBin: config.geminiBin,
      codexBin: config.codexBin,
      defaultModel: config.defaultModel,
      defaultCwd: config.defaultCwd,
      port: config.port,
      publicUrl: config.publicUrl || '',
      apiKey: config.apiKey || '',
      authRequired: !!config.apiKey,
      githubApp: config.githubApp
        ? {
            appId: config.githubApp.appId,
            appSlug: config.githubApp.appSlug || getGhAppSlug() || null,
            hasInstallation:
              !!config.githubApp.installationId ||
              (config.githubApp.installations?.length ?? 0) > 0,
            installations: config.githubApp.installations || [],
          }
        : null,
      personalOAuth: config.personalOAuth
        ? {
            configured: !!(config.personalOAuth.clientId && config.personalOAuth.clientSecret),
            clientId: config.personalOAuth.clientId || null,
          }
        : { configured: false, clientId: null },
      botGithubToken: config.botGithubToken ? '••••••••' : '',
      botGithubTokenSet: !!config.botGithubToken,
      botGithubUser: getGhBotUser() || null,
      anthropicApiKey: config.anthropicApiKey ? '••••••••' : '',
      anthropicApiKeySet: !!config.anthropicApiKey,
      _file: {
        claudeBin: fileConfig.claudeBin || null,
        cursorBin: fileConfig.cursorBin || null,
        geminiBin: fileConfig.geminiBin || null,
        codexBin: fileConfig.codexBin || null,
      },
      // Feature flags surfaced to clients so the UI can hide deprecated
      // sections (Settings → PR Environments, the provisioning wizard,
      // any PR-env badges) without a separate request. `prEnv: false`
      // means the PR-env subsystem is killed at boot (epic 88367984).
      features: {
        prEnv: !isPrEnvKillSwitchOn(),
      },
    });
  });

  router.get('/api/config/models', async (_req: Request, res: Response) => {
    // Engine auth resolution lives in `engine-auth-status.ts` (shared with
    // `/api/setup/status`) so the spawn-time view of "is X usable?" can't
    // drift from the Settings / wizard view. Gemini auth stays inline here
    // because it's API-key-only and not yet a first-class engine in the
    // engine-status helper.
    const cursorBin = deps.getCursorBin?.() ?? config.cursorBin;
    const engineStatus = await getEngineAuthStatus({ config, cursorBin });
    const geminiAuthenticated = !!(config.geminiApiKey || process.env.GEMINI_API_KEY);

    res.json(
      buildAuthenticatedModelConfig(config, {
        'claude-code': engineStatus.claude,
        'cursor-agent': engineStatus.cursor,
        'gemini-cli': geminiAuthenticated,
        'codex-cli': engineStatus.codex,
      }),
    );
  });

  router.patch('/api/config', (req: Request, res: Response) => {
    const allowed = [
      'claudeBin',
      'cursorBin',
      'geminiBin',
      'codexBin',
      'defaultModel',
      'defaultCwd',
      'port',
      'apiKey',
      'publicUrl',
      'botGithubToken',
    ] as const;
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if ((req.body as Record<string, unknown>)[key] !== undefined)
        updates[key] = (req.body as Record<string, unknown>)[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid config fields provided' });
    }

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: FileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* no file yet */
    }

    Object.assign(fileConfig, updates);
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    for (const [key, val] of Object.entries(updates)) {
      if (key in config) {
        Object.defineProperty(config, key, { value: val, writable: true, configurable: true });
      }
    }

    // Also update the module-level bin variables that chat.ts captures once at
    // boot. Without this, `config.codexBin = '/new/path'` sticks but
    // `getCodexBin()` still returns the original CODEX_BIN from index.ts, and
    // spawns fail with ENOENT (close event fires with code=-2). Applies to
    // every engine bin path equally.
    if ('claudeBin' in updates && typeof updates.claudeBin === 'string') {
      deps.setClaudeBin(updates.claudeBin);
    }
    if ('cursorBin' in updates && typeof updates.cursorBin === 'string' && deps.setCursorBin) {
      deps.setCursorBin(updates.cursorBin);
      // The cursor-auth cache is keyed on the resolved bin string, so a new
      // path technically misses the cache — but we still invalidate so any
      // stale entry for the *new* bin (left over from a previous probe) is
      // dropped. The wizard can otherwise see a cached `false` for up to
      // 60s after the user finishes `cursor-agent login`, which manifests
      // as Save & Continue refusing to advance even though the status
      // endpoint reports authenticated.
      invalidateCursorAuthCache();
    }
    if ('geminiBin' in updates && typeof updates.geminiBin === 'string' && deps.setGeminiBin) {
      deps.setGeminiBin(updates.geminiBin);
    }
    if ('codexBin' in updates && typeof updates.codexBin === 'string' && deps.setCodexBin) {
      deps.setCodexBin(updates.codexBin);
    }

    if ('botGithubToken' in updates) {
      const execAsync = promisify(exec);
      const newToken = updates.botGithubToken as string | null;
      if (newToken) {
        execAsync('gh api user --jq ".login"', { env: { ...process.env, GH_TOKEN: newToken } })
          .then(({ stdout }) => {
            setGhBotUser(stdout.trim());
            console.log(`[GitHub Bot] Bot account re-detected: ${stdout.trim()}`);
          })
          .catch((err: Error) => {
            setGhBotUser(null);
            console.warn(`[GitHub Bot] Token validation failed: ${err.message?.split('\n')[0]}`);
          });
      } else {
        setGhBotUser(null);
        console.log('[GitHub Bot] Bot token removed');
      }
    }

    res.json({
      ok: true,
      updated: Object.fromEntries(
        Object.entries(updates).map(([k, v]) => [k, k === 'botGithubToken' && v ? '••••••••' : v]),
      ),
    });
  });

  // ─── Spawn-env PATH refresh ─────────────────────────────────────────────
  // Returns the current cached login-shell PATH used when spawning agents.
  router.get('/api/config/spawn-path', (_req: Request, res: Response) => {
    const cached = getCachedShellPath();
    res.json({
      path: cached.value,
      source: cached.source,
      capturedAt: cached.capturedAt,
      entries: cached.value ? cached.value.split(':').filter(Boolean) : [],
    });
  });

  // Re-runs the login shell to pick up newly-installed CLIs (aws, gh, etc.)
  // and updates the cached PATH that `buildSpawnEnv` merges into every spawn.
  // Idempotent — safe to call whenever the user has installed a new tool.
  router.post('/api/config/refresh-spawn-path', (_req: Request, res: Response) => {
    try {
      const cached = refreshShellPath();
      console.log(`[shell-path] Refreshed spawn PATH from ${cached.source}`);
      res.json({
        ok: true,
        path: cached.value,
        source: cached.source,
        capturedAt: cached.capturedAt,
        entries: cached.value ? cached.value.split(':').filter(Boolean) : [],
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Personal GitHub OAuth App ─────────────────────────────────────────────
  // Decoupled from the GitHub App (which is reviewer-bot-only). This is the
  // OAuth App registration users sign in with for personal-identity actions
  // (push, open PRs, query repos as themselves). Never installed; just an
  // OAuth client_id / client_secret pair.

  router.get('/api/config/personal-oauth', (_req: Request, res: Response) => {
    const personal = config.personalOAuth;
    const configured = !!(personal?.clientId && personal?.clientSecret);
    res.json({
      configured,
      clientId: personal?.clientId || null,
    });
  });

  router.put('/api/config/personal-oauth', (req: Request, res: Response) => {
    const { clientId, clientSecret } = req.body as {
      clientId?: unknown;
      clientSecret?: unknown;
    };
    if (typeof clientId !== 'string' || !clientId.trim()) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (typeof clientSecret !== 'string' || !clientSecret.trim()) {
      return res.status(400).json({ error: 'clientSecret is required' });
    }

    const personalOAuth: PersonalOAuthConfig = {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    };

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: FileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* no file yet */
    }
    fileConfig.personalOAuth = personalOAuth;
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    config.personalOAuth = personalOAuth;
    console.log(`[Personal OAuth] Configured (clientId: ${personalOAuth.clientId})`);

    res.json({
      ok: true,
      configured: true,
      clientId: personalOAuth.clientId,
    });
  });

  router.delete('/api/config/personal-oauth', (_req: Request, res: Response) => {
    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: FileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* no file yet */
    }
    delete fileConfig.personalOAuth;
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    config.personalOAuth = null;
    console.log('[Personal OAuth] Configuration removed');

    res.json({ ok: true });
  });

  // ─── GitHub App Setup (Manifest Flow) ──────────────────────────────────────

  router.get('/api/github-app/manifest', (req: Request, res: Response) => {
    const serverUrl = config.publicUrl;
    if (!serverUrl) {
      return res.status(400).json({
        error: 'Public URL must be configured first (Settings → General → Public URL)',
      });
    }
    const manifest = buildAppManifest(serverUrl);
    res.json({
      manifest,
      githubUrl: 'https://github.com/settings/apps/new',
      redirectUrl: manifest.redirect_url,
    });
  });

  router.get('/api/github-app/register', (req: Request, res: Response) => {
    const serverUrl = config.publicUrl;
    if (!serverUrl) {
      return res.status(400).send('Public URL must be configured first.');
    }
    const manifest = buildAppManifest(serverUrl);
    const manifestJson = JSON.stringify(manifest)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/'/g, '&#39;')
      .replace(/"/g, '&quot;');
    const state = Date.now().toString(36);
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head><title>Setting up GitHub App…</title></head>
<body>
  <p>Redirecting to GitHub…</p>
  <form id="manifest-form" action="https://github.com/settings/apps/new?state=${state}" method="post">
    <input type="hidden" name="manifest" value="${manifestJson}">
  </form>
  <script>document.getElementById('manifest-form').submit();</script>
</body>
</html>`);
  });

  router.get('/api/github-app/callback', async (req: Request, res: Response) => {
    const { code } = req.query as { code?: string };
    if (!code) {
      return res.status(400).send('Missing code parameter from GitHub');
    }

    try {
      const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`GitHub returned ${response.status}: ${errText}`);
      }

      const appData = (await response.json()) as GitHubAppConversion;

      const githubAppConfig: GitHubAppConfig & {
        installations?: Array<{ id: number; account: string; accountType: string }>;
      } = {
        appId: String(appData.id),
        appSlug: appData.slug || appData.name,
        privateKey: appData.pem,
        webhookSecret: appData.webhook_secret,
        clientId: appData.client_id,
        clientSecret: appData.client_secret,
      };

      try {
        const installations = (await getAppInstallations(
          appData.id,
          appData.pem,
        )) as unknown as Installation[];
        if (installations.length > 0) {
          githubAppConfig.installationId = installations[0].id;
          githubAppConfig.installations = installations.map((inst) => ({
            id: inst.id,
            account: inst.account?.login ?? '',
            accountType: inst.account?.type ?? '',
          }));
          console.log(
            `[GitHub App] Found ${installations.length} installation(s): ${installations.map((i) => i.account?.login).join(', ')}`,
          );
        }
      } catch {
        // No installations yet — user still needs to install the app
      }

      const configPath = path.join(config.dataDir, 'config.json');
      let fileConfig: FileConfig = {};
      try {
        fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        /* no file yet */
      }
      fileConfig.githubApp = githubAppConfig;
      writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

      config.githubApp = githubAppConfig;
      setGhAppSlug?.(appData.slug || appData.name || null);

      console.log(
        `[GitHub App] App "${appData.slug || appData.name}" created and configured (ID: ${appData.id})`,
      );

      const clientUrl = config.publicUrl || `http://localhost:3050`;
      if (!githubAppConfig.installationId) {
        res.redirect(`https://github.com/apps/${githubAppConfig.appSlug}/installations/new`);
      } else {
        res.redirect(`${clientUrl}/#/settings?githubApp=ready`);
      }
    } catch (err: unknown) {
      console.error('[GitHub App] Callback failed:', (err as Error).message);
      const clientUrl = config.publicUrl || `http://localhost:3050`;
      res.redirect(
        `${clientUrl}/#/settings?githubApp=error&message=${encodeURIComponent((err as Error).message)}`,
      );
    }
  });

  router.get('/api/github-app/install-url', async (_req: Request, res: Response) => {
    const app = config.githubApp;
    if (!app?.appSlug) {
      return res.status(400).json({ error: 'No GitHub App configured' });
    }
    res.json({
      installUrl: `https://github.com/apps/${app.appSlug}/installations/new`,
    });
  });

  router.post('/api/github-app/refresh-installation', async (_req: Request, res: Response) => {
    const app = config.githubApp;
    if (!app?.appId || !app?.privateKey) {
      return res.status(400).json({ error: 'No GitHub App configured' });
    }

    try {
      const installations = (await getAppInstallations(
        app.appId,
        app.privateKey,
      )) as unknown as Installation[];
      if (installations.length === 0) {
        return res.json({
          installed: false,
          message: 'No installations found. Install the app on your GitHub account first.',
        });
      }

      app.installationId = installations[0].id;
      app.installations = installations.map((inst) => ({
        id: inst.id,
        account: inst.account?.login ?? '',
        accountType: inst.account?.type ?? '',
      }));
      config.githubApp = app;

      const configPath = path.join(config.dataDir, 'config.json');
      let fileConfig: FileConfig = {};
      try {
        fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        /* no file yet */
      }
      fileConfig.githubApp = app;
      writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

      console.log(
        `[GitHub App] Installation refreshed: ${installations.length} installation(s) — ${installations.map((i) => i.account?.login).join(', ')}`,
      );
      res.json({
        installed: true,
        installationId: installations[0].id,
        installations: app.installations,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/github-app/setup-complete', async (req: Request, res: Response) => {
    const clientUrl = config.publicUrl || 'http://localhost:3050';
    const app = config.githubApp;
    if (!app?.appId || !app?.privateKey) {
      return res.redirect(
        `${clientUrl}/#/settings?githubApp=error&message=${encodeURIComponent('No GitHub App configured')}`,
      );
    }

    try {
      const installations = (await getAppInstallations(
        app.appId,
        app.privateKey,
      )) as unknown as Installation[];
      if (installations.length > 0) {
        app.installationId = installations[0].id;
        app.installations = installations.map((inst) => ({
          id: inst.id,
          account: inst.account?.login ?? '',
          accountType: inst.account?.type ?? '',
        }));
        config.githubApp = app;

        const configPath = path.join(config.dataDir, 'config.json');
        let fileConfig: FileConfig = {};
        try {
          fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch {
          /* no file yet */
        }
        fileConfig.githubApp = app;
        writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

        console.log(
          `[GitHub App] Auto-setup complete — ${installations.length} installation(s): ${installations.map((i) => i.account?.login).join(', ')}`,
        );

        // Seed Reviewer agents for any projects that already have GitHub
        // integration. The GitHub App now provides the formal-review identity,
        // so existing projects should pick up a Reviewer the moment the app
        // is connected.
        try {
          const reviewersChanged = ensureReviewerAgents();
          if (reviewersChanged) {
            // Notify any connected clients so their sidebar picks up the new
            // Reviewer agent without requiring a page refresh (fixes GitHub
            // App not creating a sidebar agent after auto-setup).
            broadcast({ type: 'projects_updated', reason: 'github-app-setup' });
          }
        } catch (err: unknown) {
          console.warn(`[GitHub App] ensureReviewerAgents failed: ${(err as Error).message}`);
        }
        return res.redirect(`${clientUrl}/#/settings?githubApp=ready`);
      }

      return res.redirect(`${clientUrl}/#/settings?githubApp=no-install`);
    } catch (err: unknown) {
      console.error('[GitHub App] Setup complete callback failed:', (err as Error).message);
      return res.redirect(
        `${clientUrl}/#/settings?githubApp=error&message=${encodeURIComponent((err as Error).message)}`,
      );
    }
  });

  let _appInfoCache: AppInfoCache = { data: null, appId: null, ts: 0 };
  const APP_INFO_CACHE_TTL = 5 * 60 * 1000;

  router.get('/api/github-app/status', async (_req: Request, res: Response) => {
    const app = config.githubApp;
    if (!app?.appId) {
      return res.json({ configured: false });
    }

    const result: Record<string, unknown> = {
      configured: true,
      appId: app.appId,
      appSlug: app.appSlug || null,
      hasInstallation:
        !!app.installationId || (Array.isArray(app.installations) && app.installations.length > 0),
      installationId: app.installationId || null,
      installations: app.installations || [],
    };

    const now = Date.now();
    if (_appInfoCache.appId === app.appId && now - _appInfoCache.ts < APP_INFO_CACHE_TTL) {
      result.appName = _appInfoCache.data?.name || null;
      result.valid = !!_appInfoCache.data;
    } else {
      try {
        const appInfo = (await getAppInfo(app.appId, app.privateKey)) as { name: string };
        _appInfoCache = { data: appInfo, appId: app.appId, ts: now };
        result.appName = appInfo.name;
        result.valid = true;
      } catch {
        _appInfoCache = { data: null, appId: app.appId, ts: now };
        result.valid = false;
      }
    }

    res.json(result);
  });

  router.delete('/api/github-app', (_req: Request, res: Response) => {
    config.githubApp = null;
    setGhAppSlug?.(null);
    clearTokenCache();

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: FileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* no file yet */
    }
    delete fileConfig.githubApp;
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    console.log('[GitHub App] Configuration removed');
    res.json({ ok: true });
  });

  router.post('/api/github-app/connect', async (req: Request, res: Response) => {
    const { appId, privateKey, installationId } = req.body as {
      appId?: string;
      privateKey?: string;
      installationId?: string;
    };

    if (!appId || !privateKey || !installationId) {
      return res
        .status(400)
        .json({ error: 'appId, privateKey, and installationId are all required' });
    }

    let appInfo: { slug?: string; name?: string };
    try {
      appInfo = (await getAppInfo(appId, privateKey)) as { slug?: string; name?: string };
    } catch (err: unknown) {
      return res.status(400).json({
        error: `Invalid GitHub App credentials: ${(err as Error).message}`,
      });
    }

    try {
      const installations = (await getAppInstallations(
        appId,
        privateKey,
      )) as unknown as Installation[];
      const found = installations.some((inst) => String(inst.id) === String(installationId));
      if (!found) {
        console.warn(
          `[GitHub App] Installation ID ${installationId} not found in app installations — proceeding anyway`,
        );
      }
    } catch (err: unknown) {
      console.warn(
        `[GitHub App] Could not verify installation ID: ${(err as Error).message} — proceeding anyway`,
      );
    }

    const appSlug = appInfo.slug || appInfo.name || '';
    const githubAppConfig: GitHubAppConfig & {
      installations?: Array<{ id: number; account: string; accountType: string }>;
    } = {
      appId,
      appSlug,
      privateKey,
      installationId: Number(installationId),
    };

    try {
      const allInstallations = (await getAppInstallations(
        appId,
        privateKey,
      )) as unknown as Installation[];
      if (allInstallations.length > 0) {
        githubAppConfig.installations = allInstallations.map((inst) => ({
          id: inst.id,
          account: inst.account?.login ?? '',
          accountType: inst.account?.type ?? '',
        }));
      }
    } catch {
      // Could not fetch installations — proceed with single installationId
    }

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: FileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* no file yet */
    }
    fileConfig.githubApp = githubAppConfig;
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    config.githubApp = githubAppConfig;
    setGhAppSlug?.(appSlug);

    console.log(
      `[GitHub App] Connected existing app "${appSlug}" (ID: ${appId}, Installation: ${installationId})`,
    );

    res.json({ ok: true, appId, appSlug, installationId });
  });

  // ─── GitHub CLI Status & Repo Detection ────────────────────────────────────

  router.get('/api/github/status', async (_req: Request, res: Response) => {
    const execFileAsync = promisify(execFile);
    try {
      const { stdout: user } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
      let scopes: string[] = [];
      try {
        const { stdout: scopeOut, stderr: scopeErr } = await execFileAsync('gh', [
          'api',
          '-i',
          'user',
        ]);
        const combined = scopeOut + scopeErr;
        const scopeMatch = combined.match(/x-oauth-scopes:\s*(.+)/i);
        if (scopeMatch) {
          scopes = scopeMatch[1]
            .trim()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } catch {
        /* scopes optional */
      }
      res.json({
        authenticated: true,
        user: user.trim(),
        scopes,
        githubApp: config.githubApp
          ? {
              appId: config.githubApp.appId,
              appSlug: config.githubApp.appSlug || getGhAppSlug() || null,
              hasInstallation:
                !!config.githubApp.installationId ||
                (config.githubApp.installations?.length ?? 0) > 0,
              installations: config.githubApp.installations || [],
            }
          : null,
        botUser: getGhBotUser() || null,
      });
    } catch {
      res.json({
        authenticated: false,
        error: 'GitHub CLI not authenticated. Run: gh auth login',
      });
    }
  });

  router.post('/api/github/detect-repo', async (req: Request, res: Response) => {
    const { cwd } = req.body as { cwd?: string };
    if (!cwd) return res.status(400).json({ error: 'cwd is required' });

    const execFileAsync = promisify(execFile);
    try {
      const { stdout: remoteUrl } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd,
      });
      const url = remoteUrl.trim();
      if (!url) return res.json({ hasRemote: false });

      let owner: string | null = null;
      let repo: string | null = null;
      const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (httpsMatch) {
        owner = httpsMatch[1];
        repo = httpsMatch[2].replace(/\.git$/, '');
      }

      let defaultBranch = 'main';
      try {
        const { stdout: branch } = await execFileAsync(
          'git',
          ['symbolic-ref', 'refs/remotes/origin/HEAD'],
          { cwd },
        );
        defaultBranch = branch.trim().replace('refs/remotes/origin/', '');
      } catch {
        /* fallback to main */
      }

      res.json({ hasRemote: true, owner, repo, url, defaultBranch });
    } catch {
      res.json({ hasRemote: false });
    }
  });

  router.post('/api/github/test-connection', async (req: Request, res: Response) => {
    const { owner, repo } = req.body as { owner?: string; repo?: string };
    if (!owner || !repo) return res.status(400).json({ error: 'owner and repo are required' });

    const validName = /^[a-zA-Z0-9._-]+$/;
    if (!validName.test(owner) || !validName.test(repo)) {
      return res.status(400).json({ error: 'Invalid owner or repo name' });
    }

    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync('gh', [
        'api',
        `repos/${owner}/${repo}`,
        '--jq',
        '{ name: .name, full_name: .full_name, private: .private, default_branch: .default_branch, permissions: .permissions }',
      ]);
      const repoInfo = JSON.parse(stdout.trim()) as Record<string, unknown>;
      res.json({ ok: true, repoInfo });
    } catch (err: unknown) {
      const error = err as { stderr?: string; message?: string };
      const msg =
        error.stderr?.split('\n')[0] || error.message?.split('\n')[0] || 'Connection failed';
      res.json({ ok: false, error: msg });
    }
  });

  router.get('/api/projects/:projectId/export', (req: Request, res: Response) => {
    try {
      const projects = getProjects();
      const project = projects.find((p) => p.id === req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const allCrons = stmts.getCrons.all() as Array<
        Record<string, unknown> & { cwd: string; name: string }
      >;
      const projectCrons = allCrons
        .filter((c) => c.cwd === project.cwd)
        .map(
          ({
            last_run: _last_run,
            last_result: _last_result,
            next_run_at: _next_run_at,
            ...rest
          }) => rest,
        );

      const allRooms = stmts.getRooms.all() as Array<
        Record<string, unknown> & { id: string; project_id: string | null }
      >;
      const projectRooms = allRooms
        .filter((r) => r.project_id === project.id)
        .map((room) => {
          const roomAgents = (
            stmts.getRoomAgents.all(room.id) as Array<{ agent_id: string; position: number }>
          ).map((ra) => ({
            agentId: ra.agent_id,
            position: ra.position,
          }));
          return { ...room, agents: roomAgents };
        });

      const webhooks = (
        stmts.getWebhookConfigsByProject.all(project.id) as Array<
          Record<string, unknown> & { secret: string }
        >
      ).map(({ secret: _secret, ...rest }) => ({ ...rest, secret: '***REDACTED***' }));

      const wikiPages = (
        stmts.getWikiPages.all(project.id) as Array<Record<string, unknown> & { slug: string }>
      ).map((page) => {
        const full = stmts.getWikiPage.get(project.id, page.slug) as
          | Record<string, unknown>
          | undefined;
        return full || page;
      });

      let kanban: Record<string, unknown> | null = null;
      const board = stmts.getKanbanBoard.get(project.id) as { id: string } | undefined;
      if (board) {
        const columns = stmts.getKanbanColumns.all(board.id) as Array<Record<string, unknown>>;
        const cards = (
          stmts.getKanbanCards.all(board.id) as Array<
            Record<string, unknown> & { id: string; session_id?: string }
          >
        ).map(({ session_id: _session_id, ...rest }) => rest);
        const epics = stmts.getKanbanEpics.all(board.id) as Array<Record<string, unknown>>;
        const comments: Record<string, unknown[]> = {};
        for (const card of cards) {
          const cardComments = stmts.getKanbanCardComments?.all(card.id) as unknown[] | undefined;
          if (cardComments?.length) comments[card.id] = cardComments;
        }
        kanban = { board, columns, cards, epics, comments };
      }

      const exported = {
        version: 3,
        type: 'project',
        exportedAt: new Date().toISOString(),
        project,
        crons: projectCrons,
        rooms: projectRooms,
        webhooks,
        wiki: wikiPages,
        kanban,
      };

      const safeName = project.name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}-export-${localDateStr()}.json"`,
      );
      res.json(exported);
    } catch (err: unknown) {
      console.error('Project export failed:', (err as Error).message);
      res.status(500).json({ error: 'Export failed: ' + (err as Error).message });
    }
  });

  // Internal helper shared by both import endpoints. Walks the v3 export and
  // merges each section into `targetProject`. Returns the per-section result
  // map exposed to clients. Caller is responsible for resolving the target
  // project (existing-by-id for the per-project endpoint, freshly created for
  // the no-id endpoint) and for sending the HTTP response — keeping IO out of
  // here means the helper is easy to unit-test in isolation.
  //
  // Each section is wrapped in a `runSection(...)` boundary so the route-level
  // catch can report **which** section / row triggered a 500. Without this,
  // better-sqlite3's generic "Too few parameter values were provided" surfaces
  // as a bare 500 with no hint at the offending statement or input shape —
  // making large imports (hundreds of cards, comments, etc.) effectively
  // un-debuggable from the UI. See card `import-too-few-parameter-values`.
  function runProjectImport(
    targetProject: Project,
    data: ProjectExportData,
  ): Record<string, string | boolean> {
    const targetProjectId = targetProject.id;
    const results: Record<string, string | boolean> = {
      project: false,
      crons: false,
      rooms: false,
      webhooks: false,
      wiki: false,
      kanban: false,
    };

    // Diagnostic boundary: wraps a section so a stray throw from
    // better-sqlite3 / JSON / etc. is re-raised as a typed error tagged with
    // the section name and an optional row context. The route handlers
    // unwrap this back into `{ error, section, detail }` on the 500.
    const runSection = <T>(section: string, fn: () => T): T => {
      try {
        return fn();
      } catch (e: unknown) {
        const err = e as Error & { __projectImportSection?: string };
        if (!err.__projectImportSection) {
          err.__projectImportSection = section;
          // Preserve the original better-sqlite3 message verbatim so the
          // root-cause string ("Too few parameter values were provided",
          // "NOT NULL constraint failed", etc.) stays mineable.
          err.message = `[${section}] ${err.message}`;
        }
        throw err;
      }
    };

    if (data.project) {
      runSection('project', () => {
        (targetProject as Record<string, unknown>).agents =
          data.project!.agents || (targetProject as Record<string, unknown>).agents;
        targetProject.color = data.project!.color || targetProject.color;
        (targetProject as Record<string, unknown>).leadAgent =
          data.project!.leadAgent || (targetProject as Record<string, unknown>).leadAgent;
        (targetProject as Record<string, unknown>).subAgents =
          data.project!.subAgents || (targetProject as Record<string, unknown>).subAgents;
        if (data.project!.commands)
          (targetProject as Record<string, unknown>).commands = data.project!.commands;
        saveProjects();
        results.project = true;
      });
    }

    if (Array.isArray(data.crons)) {
      const crons = data.crons;
      runSection('crons', () => {
        const existingCrons = stmts.getCrons.all() as Array<{ name: string }>;
        const existingNames = new Set(existingCrons.map((c) => c.name));
        let imported = 0;
        for (const c of crons) {
          if (existingNames.has(c.name)) continue;
          // Validate `model` against the cron API allowlist so a stale or
          // hand-crafted export can't smuggle an unknown id into the DB
          // and crash the CLI at run time. An invalid id falls back to
          // null (engine default) instead of failing the whole import.
          let importedModel: string | null = null;
          try {
            importedModel = normalizeCronModel(c.model);
          } catch {
            importedModel = null;
          }
          stmts.createCron.run(
            c.name,
            c.schedule,
            c.prompt,
            targetProject.cwd,
            c.enabled !== undefined ? (c.enabled ? 1 : 0) : 1,
            targetProject.id || null,
            typeof c.timeout_ms === 'number' && c.timeout_ms > 0 ? c.timeout_ms : null,
            c.notify_on_run ? 1 : 0,
            importedModel,
            cronImportSkillPrincipal(c.skill_principal_agent_id, targetProject),
          );
          imported++;
        }
        results.crons = `${imported} new, ${crons.length - imported} skipped`;
      });
    }

    if (Array.isArray(data.rooms)) {
      const rooms = data.rooms;
      runSection('rooms', () => {
        const existingRooms = stmts.getRooms.all() as Array<{ name: string }>;
        const existingNames = new Set(existingRooms.map((r) => r.name));
        let imported = 0;
        for (const r of rooms) {
          if (existingNames.has(r.name)) continue;
          const roomId = uuidv4();
          stmts.createProjectRoom.run(roomId, r.name, targetProjectId);
          if (r.max_turns) stmts.updateRoomMaxTurns.run(r.max_turns, roomId);
          if (Array.isArray(r.agents)) {
            for (const ra of r.agents) {
              stmts.addRoomAgent.run(roomId, ra.agentId || ra.agent_id, roomId);
            }
          }
          imported++;
        }
        results.rooms = `${imported} new, ${rooms.length - imported} skipped`;
      });
    }

    if (Array.isArray(data.webhooks)) {
      const webhooks = data.webhooks;
      runSection('webhooks', () => {
        const existing = stmts.getWebhookConfigsByProject.all(targetProjectId) as Array<{
          repo_url: string;
        }>;
        const existingRepos = new Set(existing.map((w) => w.repo_url));
        let imported = 0;
        for (const w of webhooks) {
          if (existingRepos.has(w.repo_url)) continue;
          const secret = w.secret && !w.secret.includes('REDACTED') ? w.secret : uuidv4();
          stmts.createWebhookConfig.run(
            targetProjectId,
            w.repo_url,
            secret,
            w.events || '{}',
            w.enabled ? 1 : 0,
            typeof w.author_allowlist === 'string' ? w.author_allowlist : '[]',
          );
          imported++;
        }
        results.webhooks = `${imported} new, ${webhooks.length - imported} skipped`;
      });
    }

    if (Array.isArray(data.wiki)) {
      const wiki = data.wiki;
      runSection('wiki', () => {
        let imported = 0,
          updated = 0;
        for (const page of wiki) {
          const existing = stmts.getWikiPage.get(targetProjectId, page.slug) as
            | Record<string, unknown>
            | undefined;
          if (existing) {
            stmts.updateWikiPage.run(
              page.title,
              page.content,
              page.category || 'general',
              page.updated_by || 'import',
              targetProjectId,
              page.slug,
            );
            updated++;
          } else {
            stmts.createWikiPage.run(
              uuidv4(),
              targetProjectId,
              page.title,
              page.slug,
              page.content || '',
              page.category || 'general',
              page.updated_by || 'import',
            );
            imported++;
          }
        }
        results.wiki = `${imported} new, ${updated} updated`;
      });
    }

    if (data.kanban) {
      const kanban = data.kanban;
      runSection('kanban', () => {
        let existingBoard = stmts.getKanbanBoard.get(targetProjectId) as { id: string } | undefined;
        let boardId: string;
        let boardCreated = false;
        const colIdMap: Record<string, string> = {};

        if (existingBoard) {
          boardId = existingBoard.id;
          const existingCols = stmts.getKanbanColumns.all(boardId) as Array<{
            id: string;
            name: string;
          }>;
          for (const col of existingCols) {
            const matchingImported = (kanban.columns || []).find(
              (c) => c.name.toLowerCase() === col.name.toLowerCase(),
            );
            if (matchingImported) colIdMap[matchingImported.id] = col.id;
          }
          for (const col of kanban.columns || []) {
            if (!colIdMap[col.id]) {
              const newColId = uuidv4();
              colIdMap[col.id] = newColId;
              stmts.createKanbanColumn.run(
                newColId,
                boardId,
                col.name,
                col.position,
                col.color || null,
              );
            }
          }
        } else {
          boardId = uuidv4();
          stmts.createKanbanBoard.run(
            boardId,
            targetProjectId,
            kanban.board?.name || `${targetProject.name} Board`,
          );
          boardCreated = true;
          for (const col of kanban.columns || []) {
            const newColId = uuidv4();
            colIdMap[col.id] = newColId;
            stmts.createKanbanColumn.run(
              newColId,
              boardId,
              col.name,
              col.position,
              col.color || null,
            );
          }
        }

        const epicIdMap: Record<string, string> = {};
        const existingEpics = stmts.getKanbanEpics.all(boardId) as Array<{
          id: string;
          name: string;
        }>;
        const existingEpicNames = new Set(existingEpics.map((e) => e.name.toLowerCase()));
        let epicsImported = 0;
        for (const epic of kanban.epics || []) {
          if (existingEpicNames.has(epic.name.toLowerCase())) {
            const existing = existingEpics.find(
              (e) => e.name.toLowerCase() === epic.name.toLowerCase(),
            );
            if (existing) epicIdMap[epic.id] = existing.id;
            continue;
          }
          const newEpicId = uuidv4();
          epicIdMap[epic.id] = newEpicId;
          stmts.createKanbanEpic.run(
            newEpicId,
            boardId,
            epic.name,
            epic.description || '',
            epic.color || '#6b7280',
            epic.position || 0,
          );
          const importedEpicPrBase = (epic as { pr_base_branch?: string | null }).pr_base_branch;
          if (importedEpicPrBase != null && String(importedEpicPrBase).trim() !== '') {
            const br = parsePrBaseBranchInput(importedEpicPrBase);
            if (br.ok && br.value) {
              const row = stmts.getKanbanEpic.get(newEpicId) as {
                name: string;
                description: string | null;
                color: string;
                autonomous: number;
                autonomous_interval: number;
                autonomous_max_concurrent: number;
                autonomous_model: string | null;
                orchestration_budgets_json?: string | null;
              };
              stmts.updateKanbanEpic.run(
                row.name,
                row.description,
                row.color,
                row.autonomous,
                row.autonomous_interval,
                row.autonomous_max_concurrent,
                row.autonomous_model ?? null,
                row.orchestration_budgets_json ?? null,
                br.value,
                newEpicId,
              );
            }
          }
          epicsImported++;
        }

        const existingCards = stmts.getKanbanCards.all(boardId) as Array<{ title: string }>;
        const existingCardTitles = new Set(existingCards.map((c) => c.title.toLowerCase()));
        let cardsImported = 0,
          cardsSkipped = 0;
        for (const card of kanban.cards || []) {
          if (existingCardTitles.has(card.title.toLowerCase())) {
            cardsSkipped++;
            continue;
          }
          const newCardId = uuidv4();
          const newColId = colIdMap[card.column_id];
          if (!newColId) continue;
          const newEpicId = card.epic_id ? epicIdMap[card.epic_id] || null : null;
          const importAssignModelRaw = (card as { assign_model?: string | null }).assign_model;
          let importAssignModel =
            typeof importAssignModelRaw === 'string' && importAssignModelRaw.trim()
              ? importAssignModelRaw.trim()
              : null;
          if (importAssignModel) {
            const assigneeForModel =
              typeof card.assignee === 'string' && card.assignee.trim()
                ? card.assignee.trim()
                : null;
            const v = validateKanbanAssignModel(
              importAssignModel,
              targetProject,
              assigneeForModel,
              config,
            );
            if (!v.ok) importAssignModel = null;
          }
          stmts.createKanbanCard.run(
            newCardId,
            newColId,
            boardId,
            card.title,
            card.description || '',
            card.priority || 'medium',
            card.assignee || '',
            card.labels || '',
            null,
            card.github_issue_url || null,
            card.created_by || 'import',
            importAssignModel,
            card.position || 0,
          );
          if (newEpicId) {
            stmts.updateKanbanCard.run(
              card.title,
              card.description || '',
              card.priority || 'medium',
              card.assignee || null,
              card.labels || null,
              null,
              card.github_issue_url || null,
              card.pr_url || null,
              newEpicId,
              importAssignModel,
              card.pr_base_branch ?? null,
              newCardId,
            );
          }
          const cardComments = kanban.comments?.[card.id];
          if (cardComments?.length) {
            for (const comment of cardComments) {
              stmts.createKanbanCardComment.run(
                uuidv4(),
                newCardId,
                comment.author || 'import',
                comment.content,
              );
            }
          }
          cardsImported++;
        }
        results.kanban = boardCreated
          ? `Board created with ${kanban.columns?.length || 0} columns, ${cardsImported} cards, ${epicsImported} epics`
          : `Merged: ${cardsImported} new cards, ${cardsSkipped} skipped, ${epicsImported} new epics`;
      });
    }

    return results;
  }

  // Surfaces the section tag attached by `runSection(...)`. Falls back to a
  // null section when an error originated outside a tagged block (e.g. body
  // validation, target-project resolution) — the 500 response still includes
  // the original message so the legacy contract is preserved.
  function projectImportSection(err: unknown): string | null {
    const tagged = err as { __projectImportSection?: unknown };
    return typeof tagged?.__projectImportSection === 'string'
      ? tagged.__projectImportSection
      : null;
  }

  router.post('/api/projects/:projectId/import', (req: Request, res: Response) => {
    try {
      const data = req.body as ProjectExportData;
      if (!data || data.version !== 3 || data.type !== 'project') {
        return res
          .status(400)
          .json({ error: 'Invalid project export — expected version 3 with type "project"' });
      }

      const targetProjectId = req.params.projectId;
      const projects = getProjects();
      const targetProject = projects.find((p) => p.id === targetProjectId);
      if (!targetProject) return res.status(404).json({ error: 'Target project not found' });

      const results = runProjectImport(targetProject, data);
      res.json({ message: 'Project import complete.', results });
    } catch (err: unknown) {
      const e = err as Error;
      const section = projectImportSection(err);
      console.error(
        'Project import failed:',
        section ? `[${section}] ${e.message}` : e.message,
        e.stack,
      );
      const body: Record<string, unknown> = { error: 'Import failed: ' + e.message };
      if (section) body.section = section;
      res.status(500).json(body);
    }
  });

  // Create-from-export: no target project required. The export itself supplies
  // id/name/cwd/color/agents — we materialize a fresh project record (and its
  // data dir on disk) and then run the same merge logic the per-project
  // endpoint uses. If the exported id is already taken on this instance we
  // generate a unique slug-based id rather than 409ing, so a user can drop in
  // an export from their own machine onto a hub that already has a project
  // with the same id.
  router.post('/api/projects/import', (req: Request, res: Response) => {
    try {
      const data = req.body as ProjectExportData;
      if (!data || data.version !== 3 || data.type !== 'project') {
        return res
          .status(400)
          .json({ error: 'Invalid project export — expected version 3 with type "project"' });
      }
      if (!data.project) {
        return res.status(400).json({
          error:
            'Export is missing the `project` block — cannot create a new project without it. ' +
            'Use POST /api/projects/:projectId/import to merge into an existing project instead.',
        });
      }

      const projects = getProjects();
      const idValid = /^[a-zA-Z0-9-]+$/;
      const slugify = (s: string): string =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64) || 'imported';

      const desiredId =
        data.project.id && idValid.test(data.project.id)
          ? data.project.id
          : slugify(data.project.name || data.project.id || 'imported');

      let projectId = desiredId;
      if (projects.find((p) => p.id === projectId)) {
        // Collision — append a short suffix until we find a free id. Bounded
        // attempts so a totally unhinged backing store can't hang the request.
        for (let i = 0; i < 100; i++) {
          const candidate = `${desiredId}-${Math.random().toString(36).slice(2, 6)}`;
          if (!projects.find((p) => p.id === candidate)) {
            projectId = candidate;
            break;
          }
        }
        if (projects.find((p) => p.id === projectId)) {
          return res.status(500).json({ error: 'Could not allocate a unique project id' });
        }
      }

      const dataDir = getProjectDataDir(projectId);
      const cwd =
        data.project.cwd && typeof data.project.cwd === 'string'
          ? data.project.cwd
          : config.defaultCwd;

      const newProject: Project = {
        id: projectId,
        name: data.project.name || projectId,
        cwd,
        ahw: dataDir,
        color: data.project.color || '#6b7280',
        agents: [],
      };

      mkdirSync(dataDir, { recursive: true });
      mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
      mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
      mkdirSync(path.join(dataDir, 'memory'), { recursive: true });

      projects.push(newProject);
      saveProjects();

      const results = runProjectImport(newProject, data);
      res
        .status(201)
        .json({ message: 'Project created from export.', project: newProject, results });
    } catch (err: unknown) {
      const e = err as Error;
      const section = projectImportSection(err);
      console.error(
        'Project create-from-import failed:',
        section ? `[${section}] ${e.message}` : e.message,
        e.stack,
      );
      const body: Record<string, unknown> = { error: 'Import failed: ' + e.message };
      if (section) body.section = section;
      res.status(500).json(body);
    }
  });

  router.get('/api/config/export', (_req: Request, res: Response) => {
    try {
      let fileConfig: FileConfig = {};
      try {
        fileConfig = JSON.parse(readFileSync(path.join(config.dataDir, 'config.json'), 'utf-8'));
      } catch {
        /* no config.json yet */
      }

      const crons = (stmts.getCrons.all() as Array<Record<string, unknown>>).map(
        ({ last_run: _last_run, last_result: _last_result, next_run_at: _next_run_at, ...rest }) =>
          rest,
      );

      const rooms = (stmts.getRooms.all() as Array<Record<string, unknown> & { id: string }>).map(
        (room) => {
          const roomAgents = (
            stmts.getRoomAgents.all(room.id) as Array<{ agent_id: string; position: number }>
          ).map((ra) => ({
            agentId: ra.agent_id,
            position: ra.position,
          }));
          return { ...room, agents: roomAgents };
        },
      );

      let slackConfig: SlackConfigData = { accounts: [] };
      try {
        slackConfig = JSON.parse(readFileSync(path.join(serverDir, 'slack-config.json'), 'utf-8'));
        slackConfig.accounts = (slackConfig.accounts || []).map(
          ({ botToken, appToken, ...rest }) => ({
            ...rest,
            botToken: botToken ? '***REDACTED***' : undefined,
            appToken: appToken ? '***REDACTED***' : undefined,
          }),
        );
      } catch {
        /* no slack config */
      }

      const projects = getProjects();
      const exported = {
        version: 2,
        exportedAt: new Date().toISOString(),
        config: fileConfig,
        projects,
        crons,
        rooms,
        slack: slackConfig,
      };

      res.setHeader('Content-Disposition', 'attachment; filename="agent-hub-export.json"');
      res.json(exported);
    } catch (err: unknown) {
      console.error('Config export failed:', (err as Error).message);
      res.status(500).json({ error: 'Export failed: ' + (err as Error).message });
    }
  });

  router.post('/api/config/import', (req: Request, res: Response) => {
    try {
      const data = req.body as LegacyExportData;
      if (!data || ![1, 2].includes(data.version)) {
        return res.status(400).json({ error: 'Invalid export format — expected version 1 or 2' });
      }

      const results: Record<string, string | boolean> = {
        config: false,
        projects: false,
        crons: false,
        rooms: false,
        slack: false,
      };

      if (data.config && typeof data.config === 'object') {
        writeFileSync(
          path.join(config.dataDir, 'config.json'),
          JSON.stringify(data.config, null, 2) + '\n',
        );
        results.config = true;
      }

      if (data.version === 2 && Array.isArray(data.projects) && data.projects.length > 0) {
        setProjects(data.projects);
        saveProjects();
        results.projects = true;
      } else if (data.version === 1 && Array.isArray(data.agents) && data.agents.length > 0) {
        setProjects(
          data.agents.map((a) => ({
            id: a.id,
            name: a.name || a.id,
            cwd: a.cwd || config.defaultCwd,
            ahw: a.workspace || '',
            color: a.color || '#6b7280',
            agents: [
              {
                id: a.id,
                name: a.name || a.id,
                engine: a.engine || 'claude-code',
                systemPrompt: a.systemPrompt || '',
                color: a.color || '#6b7280',
                heartbeat: a.heartbeat || { enabled: false, interval: '', prompt: '' },
              },
            ],
          })),
        );
        saveProjects();
        results.projects = 'imported from v1 agents format';
      }

      if (Array.isArray(data.crons)) {
        const existingCrons = stmts.getCrons.all() as Array<{ name: string }>;
        const existingNames = new Set(existingCrons.map((c) => c.name));
        let imported = 0;
        for (const c of data.crons) {
          if (existingNames.has(c.name)) continue;
          // Validate `model` against the cron API allowlist; invalid id
          // falls back to null (engine default) so a single bad row
          // doesn't take down the whole v1-agents import.
          let importedModel: string | null = null;
          try {
            importedModel = normalizeCronModel(c.model);
          } catch {
            importedModel = null;
          }
          const projectIdForPrincipal =
            typeof c.project_id === 'string' && c.project_id.trim() ? c.project_id.trim() : '';
          const principalProject = projectIdForPrincipal
            ? (getProjects().find((p) => p.id === projectIdForPrincipal) ?? null)
            : null;
          stmts.createCron.run(
            c.name,
            c.schedule,
            c.prompt,
            c.cwd || config.defaultCwd,
            c.enabled !== undefined ? (c.enabled ? 1 : 0) : 1,
            c.project_id || null,
            typeof c.timeout_ms === 'number' && c.timeout_ms > 0 ? c.timeout_ms : null,
            c.notify_on_run ? 1 : 0,
            importedModel,
            cronImportSkillPrincipal(c.skill_principal_agent_id, principalProject),
          );
          imported++;
        }
        results.crons = `${imported} new, ${data.crons.length - imported} skipped (duplicate names)`;
      }

      if (Array.isArray(data.rooms)) {
        const existingRooms = stmts.getRooms.all() as Array<{ name: string }>;
        const existingNames = new Set(existingRooms.map((r) => r.name));
        let imported = 0;
        for (const r of data.rooms) {
          if (existingNames.has(r.name)) continue;
          const roomId = r.id || uuidv4();
          stmts.createRoom.run(roomId, r.name);
          if (r.max_turns) stmts.updateRoomMaxTurns.run(r.max_turns, roomId);
          if (Array.isArray(r.agents)) {
            for (const ra of r.agents) {
              stmts.addRoomAgent.run(roomId, ra.agentId || ra.agent_id, roomId);
            }
          }
          imported++;
        }
        results.rooms = `${imported} new, ${data.rooms.length - imported} skipped (duplicate names)`;
      }

      if (data.slack && Array.isArray(data.slack.accounts)) {
        const hasRealTokens = data.slack.accounts.some(
          (a) => a.botToken && !a.botToken.includes('REDACTED'),
        );
        if (hasRealTokens) {
          writeFileSync(
            path.join(serverDir, 'slack-config.json'),
            JSON.stringify(data.slack, null, 2) + '\n',
          );
          results.slack = true;
        } else {
          results.slack = 'skipped (tokens redacted — update slack-config.json manually)';
        }
      }

      res.json({
        message: 'Import complete. Restart the server for all changes to take effect.',
        results,
      });
    } catch (err: unknown) {
      console.error('Config import failed:', (err as Error).message);
      res.status(500).json({ error: 'Import failed: ' + (err as Error).message });
    }
  });

  return router;
}
