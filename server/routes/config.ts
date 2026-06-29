import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import { localDateStr } from '../memory.js';
import type { RouteDeps, PersonalOAuthConfig, Project } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { refreshShellPath, getCachedShellPath, coerceConfigBooleanLoose } from '../config.js';
import { requireRole } from '../roles.js';
import { validateKanbanAssignModel } from '../kanban-assign-model.js';
import { deriveCardPrefix } from '../kanban-short-id.js';
import { parsePrBaseBranchInput } from '../kanban-pr-base.js';
import { invalidateCursorAuthCache } from '../cursor-auth-cache.js';
import { buildAuthenticatedModelConfig } from '../model-config-auth.js';
import { probeEngineAvailability } from '../engine-availability.js';
import { normalizeCronEngine, normalizeCronModel, normalizeCronSkillPrincipal } from './crons.js';
import { resolveCronEngine } from '../cron-engine.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import { getEngineAuthStatus } from '../engine-auth-status.js';
import { isPrEnvKillSwitchOn } from '../pr-env-killswitch.js';
import { syncWikiPageFts } from '../wiki.js';
import { getUserById } from '../users-store.js';
import { isEmailIdentifier } from '../auth-validation.js';
import { applySmtpPatch, maskSmtpConfig } from '../smtp-config.js';
import {
  EmailNotConfiguredError,
  getPasswordResetDeliveryStatus,
  safeEmailError,
  sendEmail,
} from '../email-sender.js';

interface FileConfig {
  claudeBin?: string;
  cursorBin?: string;
  geminiBin?: string;
  codexBin?: string;
  grokBin?: string;
  personalOAuth?: PersonalOAuthConfig;
  smtp?: unknown;
  [key: string]: unknown;
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
  shared?: boolean | number;
  /**
   * Optional CLI engine id (`claude-code`, `cursor-agent`, `gemini-cli`,
   * `codex-cli`). Validated against `ALL_SUPPORTED_ENGINES` by
   * `normalizeCronEngine`; unknown values import as null so the run-time
   * resolver falls back through the principal agent / `claude-code`
   * default rather than 500ing the whole batch.
   */
  engine?: string | null;
  /**
   * Optional model id. Validated against `engineValidModels[<resolved
   * engine>]` by `normalizeCronModel` — the resolved engine is the
   * imported `engine` field above, falling back to the principal agent's
   * engine and then `claude-code`. Unknown ids fall back to null (engine
   * default) on import rather than 500ing the batch.
   */
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

function resolveRequestOwnerUserId(req: Request): string | null {
  return resolveOwnerUserId(req as AuthenticatedRequest);
}

export const SMTP_TEST_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const SMTP_TEST_RATE_LIMIT_MAX = 5;

export function resolveSmtpTestRecipient({
  requestedTo,
  callerRole,
  callerEmail,
}: {
  requestedTo?: unknown;
  callerRole?: string | null;
  callerEmail?: string | null;
}): { ok: true; to: string } | { ok: false; status: number; error: string } {
  const requested = typeof requestedTo === 'string' ? requestedTo.trim().toLowerCase() : '';
  const current = callerEmail?.trim().toLowerCase() || '';
  if (requested) {
    if (!isEmailIdentifier(requested)) {
      return { ok: false, status: 400, error: 'to must be a valid email address' };
    }
    if (callerRole !== 'Owner' && requested !== current) {
      return {
        ok: false,
        status: 403,
        error: 'Only Owners can send SMTP tests to another address',
      };
    }
    return { ok: true, to: requested };
  }
  if (!current || !isEmailIdentifier(current)) {
    return {
      ok: false,
      status: 400,
      error: 'Current user has no email address; provide a test recipient as an Owner',
    };
  }
  return { ok: true, to: current };
}

function callerEmail(req: Request): string | null {
  const authedReq = req as AuthenticatedRequest;
  if (authedReq.authUserId) {
    try {
      const user = getUserById(authedReq.authUserId);
      if (user?.username && isEmailIdentifier(user.username)) return user.username.toLowerCase();
    } catch {
      /* orgs db can be unavailable in early tests; fall through to authUser */
    }
  }
  if (authedReq.authUser && isEmailIdentifier(authedReq.authUser)) {
    return authedReq.authUser.toLowerCase();
  }
  return null;
}

const smtpTestLimiter = rateLimit({
  windowMs: SMTP_TEST_RATE_LIMIT_WINDOW_MS,
  limit: SMTP_TEST_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many SMTP test sends. Please try again later.' });
  },
});

export default function createConfigRoutes(deps: RouteDeps): Router {
  const { stmts, getProjects, setProjects, saveProjects, config, serverDir, getProjectDataDir } =
    deps;
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
      grokBin: config.grokBin,
      defaultModel: config.defaultModel,
      defaultCwd: config.defaultCwd,
      port: config.port,
      publicUrl: config.publicUrl || '',
      apiKey: config.apiKey || '',
      authRequired: !!config.apiKey,
      openaiApiKey: config.openaiApiKey ? '••••••••' : '',
      openaiApiKeySet: !!config.openaiApiKey,
      // Voice-transcription provider selectable on the settings page. The two
      // `*Set` flags let the UI warn when the chosen provider's key is missing.
      transcriptionProvider: config.transcriptionProvider,
      geminiApiKeySet: !!config.geminiApiKey,
      xaiApiKeySet: !!config.xaiApiKey,
      // Wildcard subdomain base for "subdomain preview" mode (Phase 4
      // of the session-previews RFC). When non-empty, the UI builds
      // iframe URLs as `<sessionId>.<base>` so the app sees itself at
      // `/` and renders correctly without per-app base-path config.
      // Empty = subdomain mode off; UI falls back to the path-prefix
      // iframe URL.
      previewSubdomainBase: config.previewSubdomainBase || '',
      personalOAuth: config.personalOAuth
        ? {
            configured: !!(config.personalOAuth.clientId && config.personalOAuth.clientSecret),
            clientId: config.personalOAuth.clientId || null,
          }
        : { configured: false, clientId: null },
      codexDangerBypass: !!config.codexDangerBypass,
      codexProfile: config.codexProfile || null,
      _file: {
        claudeBin: fileConfig.claudeBin || null,
        cursorBin: fileConfig.cursorBin || null,
        geminiBin: fileConfig.geminiBin || null,
        codexBin: fileConfig.codexBin || null,
        grokBin: fileConfig.grokBin || null,
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

  router.get('/api/config/smtp', requireRole('Admin'), (_req: Request, res: Response) => {
    res.json({
      smtp: maskSmtpConfig(config.smtp),
      passwordReset: getPasswordResetDeliveryStatus(config.smtp),
    });
  });

  router.patch('/api/config/smtp', requireRole('Admin'), (req: Request, res: Response) => {
    const result = applySmtpPatch(config.smtp, req.body);
    if (!result.ok || !result.config) {
      return res.status(400).json({ error: result.error || 'Invalid SMTP settings' });
    }

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: FileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return res.status(500).json({
          error: 'Unable to read existing config.json; SMTP settings were not saved.',
        });
      }
    }

    fileConfig.smtp = result.config;
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');
    config.smtp = result.config;

    res.json({
      ok: true,
      smtp: maskSmtpConfig(config.smtp),
      passwordReset: getPasswordResetDeliveryStatus(config.smtp),
    });
  });

  router.post(
    '/api/config/smtp/test',
    requireRole('Admin'),
    smtpTestLimiter,
    async (req: Request, res: Response) => {
      const authedReq = req as AuthenticatedRequest;
      const target = resolveSmtpTestRecipient({
        requestedTo: (req.body as Record<string, unknown> | undefined)?.to,
        callerRole: authedReq.authRole,
        callerEmail: callerEmail(req),
      });
      if (!target.ok) {
        return res.status(target.status).json({ error: target.error });
      }

      try {
        await sendEmail({
          to: target.to,
          subject: 'Agent Hub SMTP test',
          text: 'This is a test email from Agent Hub SMTP settings.',
        });
        res.json({ ok: true, to: target.to });
      } catch (err) {
        if (err instanceof EmailNotConfiguredError) {
          return res.status(400).json({
            error: 'SMTP is not configured or enabled.',
            code: 'smtp_not_configured',
          });
        }
        const detail = safeEmailError(err, config.smtp);
        console.warn(`[smtp] test-send failed: ${detail}`);
        res.status(502).json({
          error: 'SMTP test send failed. Check host, port, credentials, and TLS mode.',
          code: 'smtp_send_failed',
        });
      }
    },
  );

  router.get('/api/config/models', async (req: Request, res: Response) => {
    // Engine auth resolution lives in `engine-auth-status.ts` (shared with
    // `/api/setup/status`) so the spawn-time view of "is X usable?" can't
    // drift from the Settings / wizard view. Gemini auth stays inline here
    // because it's API-key-only and not yet a first-class engine in the
    // engine-status helper.
    const cursorBin = deps.getCursorBin?.() ?? config.cursorBin;
    const authedReq = req as AuthenticatedRequest;
    const engineStatus = await getEngineAuthStatus({
      cursorBin,
      userId: authedReq.authUserId ?? null,
      dataDir: config.dataDir,
    });
    const geminiAuthenticated = !!(config.geminiApiKey || process.env.GEMINI_API_KEY);
    const grokProbe = await probeEngineAvailability('grok-cli', config, {
      userId: authedReq.authUserId ?? null,
    });

    res.json(
      buildAuthenticatedModelConfig(config, {
        'claude-code': engineStatus.claude,
        'cursor-agent': engineStatus.cursor,
        'gemini-cli': geminiAuthenticated,
        'codex-cli': engineStatus.codex,
        'grok-cli': grokProbe.available,
      }),
    );
  });

  router.patch('/api/config', (req: Request, res: Response) => {
    const allowed = [
      'claudeBin',
      'cursorBin',
      'geminiBin',
      'codexBin',
      'grokBin',
      'defaultModel',
      'defaultCwd',
      'port',
      'apiKey',
      'openaiApiKey',
      'xaiApiKey',
      'transcriptionProvider',
      'publicUrl',
      'codexDangerBypass',
      'codexProfile',
    ] as const;
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if ((req.body as Record<string, unknown>)[key] !== undefined)
        updates[key] = (req.body as Record<string, unknown>)[key];
    }
    if (updates.codexDangerBypass !== undefined) {
      updates.codexDangerBypass = coerceConfigBooleanLoose(updates.codexDangerBypass, false);
    }
    if (updates.openaiApiKey !== undefined) {
      const raw = updates.openaiApiKey;
      if (raw == null) {
        updates.openaiApiKey = null;
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        updates.openaiApiKey = trimmed.length > 0 ? trimmed : null;
      } else {
        delete updates.openaiApiKey;
      }
    }
    if (updates.transcriptionProvider !== undefined) {
      // Only 'xai' | 'openai' | 'gemini' are valid. Reject anything else with
      // 400 so a bad value can't silently land in config.json.
      const raw = updates.transcriptionProvider;
      const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (normalized === 'xai' || normalized === 'openai' || normalized === 'gemini') {
        updates.transcriptionProvider = normalized;
      } else {
        return res.status(400).json({
          error: 'Invalid transcriptionProvider',
          accepted: ['xai', 'openai', 'gemini'],
        });
      }
    }
    if (updates.xaiApiKey !== undefined) {
      const raw = updates.xaiApiKey;
      if (raw == null) {
        updates.xaiApiKey = null;
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        updates.xaiApiKey = trimmed.length > 0 ? trimmed : null;
      } else {
        delete updates.xaiApiKey;
      }
    }
    if (updates.codexProfile !== undefined) {
      // Normalize: empty / whitespace / null → null (unset). Otherwise trim.
      const raw = updates.codexProfile;
      if (raw == null) {
        updates.codexProfile = null;
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        updates.codexProfile = trimmed.length > 0 ? trimmed : null;
      } else {
        delete updates.codexProfile;
      }
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
    if ('grokBin' in updates && typeof updates.grokBin === 'string' && deps.setGrokBin) {
      deps.setGrokBin(updates.grokBin);
    }

    res.json({
      ok: true,
      updated: Object.fromEntries(
        Object.entries(updates).map(([key, value]) => [
          key,
          key === 'openaiApiKey' || key === 'xaiApiKey' ? (value ? '••••••••' : null) : value,
        ]),
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
    ownerUserId: string | null,
  ): Record<string, string | boolean> {
    const targetProjectId = targetProject.id;
    const results: Record<string, string | boolean> = {
      project: false,
      crons: false,
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
          // Validate `engine` first; an invalid value imports as null so the
          // run-time resolver inherits from the principal agent / falls back
          // to claude-code rather than failing the whole import.
          let importedEngine: string | null = null;
          try {
            importedEngine = normalizeCronEngine(c.engine);
          } catch {
            importedEngine = null;
          }
          const importedSkillPrincipal = cronImportSkillPrincipal(
            c.skill_principal_agent_id,
            targetProject,
          );
          // Validate `model` against the engine the imported cron will run
          // under (explicit → principal → claude-code). An invalid id falls
          // back to null (engine default) instead of failing the import.
          const importEngine = resolveCronEngine(
            { engine: importedEngine, skill_principal_agent_id: importedSkillPrincipal },
            targetProject,
          );
          let importedModel: string | null = null;
          try {
            importedModel = normalizeCronModel(c.model, importEngine);
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
            importedSkillPrincipal,
            importedEngine,
            ownerUserId,
            c.shared ? 1 : 0,
          );
          imported++;
        }
        results.crons = `${imported} new, ${crons.length - imported} skipped`;
      });
    }

    if (Array.isArray(data.wiki)) {
      const wiki = data.wiki;
      runSection('wiki', () => {
        let imported = 0;
        let updated = 0;
        let skipped = 0;
        for (let i = 0; i < wiki.length; i++) {
          const page = wiki[i];
          // Defensive coercion + validation. Earlier versions of this loop
          // passed `page.title` / `page.slug` straight to better-sqlite3 with
          // no fallback, so a single malformed export row (missing or
          // undefined title/slug) blew up the whole import with
          // `RangeError: Too few parameter values were provided` — the user
          // lost crons, rooms, kanban, and wiki too. Now: validate up
          // front, skip the bad row with a console.warn, keep the rest of
          // the section running. See card
          // `project-import-500-wiki-section-throws-rangeerror`.
          const slug = typeof page?.slug === 'string' ? page.slug.trim() : '';
          const title = typeof page?.title === 'string' ? page.title.trim() : '';
          if (!slug || !title) {
            console.warn(
              `[wiki] import: skipping malformed page at index ${i} (slug=${JSON.stringify(
                page?.slug,
              )}, title=${JSON.stringify(page?.title)})`,
            );
            skipped++;
            continue;
          }
          const content = typeof page.content === 'string' ? page.content : '';
          const category =
            typeof page.category === 'string' && page.category ? page.category : 'general';
          const updatedBy =
            typeof page.updated_by === 'string' && page.updated_by ? page.updated_by : 'import';

          const existing = stmts.getWikiPage.get(targetProjectId, slug) as
            | { id?: string }
            | undefined;
          if (existing) {
            stmts.updateWikiPage.run(title, content, category, updatedBy, targetProjectId, slug);
            if (typeof existing.id === 'string') {
              syncWikiPageFts(existing.id, title, content, slug, targetProjectId);
            }
            updated++;
          } else {
            const id = uuidv4();
            stmts.createWikiPage.run(
              id,
              targetProjectId,
              title,
              slug,
              content,
              category,
              updatedBy,
            );
            syncWikiPageFts(id, title, content, slug, targetProjectId);
            imported++;
          }
        }
        results.wiki = skipped
          ? `${imported} new, ${updated} updated, ${skipped} skipped`
          : `${imported} new, ${updated} updated`;
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
            deriveCardPrefix(targetProjectId),
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
            (epic as { labels?: string | null }).labels ?? null,
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
                (row as { labels?: string | null }).labels ?? null,
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
          const importAssignEngineRaw = (card as { assign_engine?: string | null }).assign_engine;
          let importAssignEngine =
            typeof importAssignEngineRaw === 'string' && importAssignEngineRaw.trim()
              ? importAssignEngineRaw.trim()
              : null;
          // Drop the engine override silently if it's not a recognised engine
          // id on the target instance — same fail-safe pattern as the
          // model-override import above.
          if (importAssignEngine && !config.engineValidModels?.[importAssignEngine]) {
            importAssignEngine = null;
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
          if (newEpicId || importAssignEngine) {
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
              null,
              importAssignModel,
              importAssignEngine,
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

      const results = runProjectImport(targetProject, data, resolveRequestOwnerUserId(req));
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

      const results = runProjectImport(newProject, data, resolveRequestOwnerUserId(req));
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
        slack: false,
      };
      const importOwnerUserId = resolveRequestOwnerUserId(req);

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
          // Validate `engine` first; an invalid value imports as null so the
          // run-time resolver inherits from the principal agent / falls back
          // to claude-code rather than failing the whole import.
          let importedEngine: string | null = null;
          try {
            importedEngine = normalizeCronEngine(c.engine);
          } catch {
            importedEngine = null;
          }
          const projectIdForPrincipal =
            typeof c.project_id === 'string' && c.project_id.trim() ? c.project_id.trim() : '';
          const principalProject = projectIdForPrincipal
            ? (getProjects().find((p) => p.id === projectIdForPrincipal) ?? null)
            : null;
          const importedSkillPrincipal = cronImportSkillPrincipal(
            c.skill_principal_agent_id,
            principalProject,
          );
          // Validate `model` against the engine the imported cron will run
          // under (explicit → principal → claude-code). An invalid id falls
          // back to null (engine default) so a single bad row doesn't take
          // down the whole v1-agents import.
          const importEngine = resolveCronEngine(
            { engine: importedEngine, skill_principal_agent_id: importedSkillPrincipal },
            principalProject,
          );
          let importedModel: string | null = null;
          try {
            importedModel = normalizeCronModel(c.model, importEngine);
          } catch {
            importedModel = null;
          }
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
            importedSkillPrincipal,
            importedEngine,
            importOwnerUserId,
            c.shared ? 1 : 0,
          );
          imported++;
        }
        results.crons = `${imported} new, ${data.crons.length - imported} skipped (duplicate names)`;
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
