import { Router, Request, Response } from 'express';
import { execSync, execFileSync, spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { createStreamParser } from '../stream-parser.js';
import { buildSpawnEnv } from '../config.js';
import {
  classifyCloneUrl,
  buildAuthenticatedUrl,
  redactToken,
  SSH_NOT_SUPPORTED_MESSAGE,
} from '../clone-url-auth.js';
import { getActiveAccessToken } from '../github-connections-store.js';
import { getUserByUsername, createUser } from '../users-store.js';
import type { AuthenticatedRequest } from '../auth.js';

const execAsync = promisify(exec);
import type {
  RouteDeps,
  Agent,
  Project,
  ProjectMode,
  StreamEvent,
  GithubWorkflowSettings,
} from '../types.js';
import { sanitizeOrchestrationBudgetsPartial } from '../orchestration-budgets.js';

const ANALYZE_SYSTEM_PROMPT = `You are a project analyzer for Agent Hub, an AI-powered workspace manager. Analyze the code repository at your current working directory and return structured JSON.

Your response MUST be a single valid JSON object wrapped in a \`\`\`json code fence. No other text outside the fence.

JSON schema:
{
  "techStack": {
    "languages": ["string"],
    "frameworks": ["string"],
    "tools": ["string"],
    "packageManager": "string or null"
  },
  "description": "1-2 sentence project summary",
  "agents": [
    {
      "name": "Human-readable agent name",
      "id": "kebab-case-id",
      "role": "lead | sub",
      "specialty": "Brief description of what this agent focuses on",
      "systemPrompt": "Full system prompt for this agent. Be specific about the project's tech stack, conventions, and what this agent should focus on. 2-4 paragraphs."
    }
  ],
  "commands": {
    "install": "string or null — command to install dependencies (e.g. 'npm ci', 'pip install -r requirements.txt', 'cargo build')",
    "build": "string or null — command to build the project (e.g. 'npm run build', 'cargo build --release')",
    "test": "string or null — command to run tests (e.g. 'npm test', 'pytest', 'cargo test')",
    "lint": "string or null — command to run linting (e.g. 'npm run lint', 'ruff check .', 'cargo clippy')"
  },
  "contextFiles": {
    "SOUL.md": "Content describing the project's philosophy, coding standards, and architectural principles.",
    "AGENTS.md": "Content describing the team of agents and their roles.",
    "USER.md": "Placeholder for user preferences with reasonable defaults.",
    "TOOLS.md": "Key tools, scripts, and commands found in this project.",
    "MEMORY.md": "Key architectural decisions, important file locations, and project structure."
  }
}

Guidelines for agents — LEAD + SUB-AGENT HIERARCHY:
- ALWAYS create exactly ONE lead agent first in the array with role "lead"
- The lead agent is the project coordinator — it understands the full codebase, delegates tasks to sub-agents, and synthesizes results
- The lead agent's name should be "[Project] Lead" (e.g. "MyApp Lead")
- The lead agent's systemPrompt should emphasize coordination, architecture decisions, code review, and delegation
- For small projects (single language, few files): create 1 lead + 1 sub-agent (general developer)
- For medium projects: create 1 lead + 2 sub-agents (e.g. frontend + backend, or app + testing)
- For large projects: create 1 lead + 2-3 sub-agents (e.g. frontend, backend, devops)
- Never create more than 4 agents total (1 lead + 3 subs max)
- Sub-agents have role "sub" and should be specialists for specific areas of the codebase
- Each sub-agent's systemPrompt should be detailed about their specialty and the specific tech stack they work with
- Agent IDs should be descriptive kebab-case (e.g. "myapp-lead", "myapp-frontend", "myapp-backend")

Guidelines for commands:
- Detect the install command by checking lock files: bun.lockb/bun.lock -> "bun install", pnpm-lock.yaml -> "pnpm install", yarn.lock -> "yarn install", package-lock.json -> "npm ci", package.json -> "npm install", requirements.txt -> "pip install -r requirements.txt", Cargo.toml -> "cargo build"
- Detect the build command from package.json "scripts.build", Makefile "build" target, Cargo.toml, etc.
- Detect the test command from package.json "scripts.test", Makefile "test" target, pytest.ini, Cargo.toml, etc.
- Detect the lint command from package.json "scripts.lint", .eslintrc*, ruff.toml, Cargo.toml (clippy), etc.
- Return null for any command that cannot be detected

Guidelines for contextFiles:
- SOUL.md: capture actual coding style (indentation, naming conventions, patterns observed)
- AGENTS.md: describe the lead/sub-agent team structure and how they coordinate
- TOOLS.md: list actual commands from package.json scripts, Makefile targets, etc.
- MEMORY.md: note the project structure and key directories
- All content must be specific to this project, not generic`;

const ANALYZE_USER_PROMPT = `Analyze the repository at the current working directory.

Read these files if they exist to understand the project:
- package.json, package-lock.json (Node.js)
- Cargo.toml (Rust)
- pyproject.toml, setup.py, requirements.txt (Python)
- go.mod (Go)
- Makefile, Justfile
- README.md, CLAUDE.md
- .github/workflows/ (CI)
- tsconfig.json, .eslintrc*, .prettierrc*
- docker-compose.yml, Dockerfile

Also examine the top-level directory structure and a sampling of source files to understand conventions.

Return your analysis as the JSON structure described in your instructions.`;

interface AnalysisResult {
  techStack?: {
    languages?: string[];
    frameworks?: string[];
    tools?: string[];
    packageManager?: string | null;
  };
  description?: string;
  agents?: Array<{
    id: string;
    name?: string;
    role?: string;
    engine?: string;
    systemPrompt?: string;
    color?: string;
    specialty?: string;
    identity?: string;
  }>;
  commands?: {
    install?: string | null;
    build?: string | null;
    test?: string | null;
    lint?: string | null;
  };
  contextFiles?: Record<string, string>;
}

interface OnboardBody {
  project: {
    id: string;
    name?: string;
    cwd?: string;
    color?: string;
    githubRepo?: { owner: string; repo: string };
    preCommitCommands?: unknown;
    checkHealCommands?: unknown;
    checkHealMaxRounds?: unknown;
  };
  agents?: Array<{
    id: string;
    name?: string;
    role?: string;
    engine?: string;
    systemPrompt?: string;
    color?: string;
    identity?: string;
  }>;
  contextFiles?: Record<string, string>;
  commands?: {
    install?: string | null;
    build?: string | null;
    test?: string | null;
    lint?: string | null;
  };
}

interface ProjectCommands {
  install: string | null;
  build: string | null;
  test: string | null;
  lint: string | null;
}

/** Normalize `preCommitCommands` from JSON bodies (POST/PATCH/onboard). */
function normalizePreCommitCommands(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Persisted 1–5; invalid values yield `undefined` (caller returns 400 when the field was explicit). */
function normalizeCheckHealMaxRounds(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 1 && n <= 5) return n;
    return undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = parseInt(value.trim(), 10);
    if (n >= 1 && n <= 5) return n;
  }
  return undefined;
}

const CHECK_HEAL_MAX_ROUNDS_INVALID =
  'checkHealMaxRounds must be an integer between 1 and 5 (inclusive), or null or empty string to clear';

/**
 * Resolve the user id whose GitHub credentials should be used for a
 * clone. Mirrors `resolveOAuthUserId` in routes/github-oauth.ts:
 *
 *   1. Real JWT caller → `authUserId` is set, use it directly.
 *   2. Local-mode bypass → synthesize / load the singleton `local-<orgId>`
 *      user so the credentials saved via the local-mode connect-token
 *      flow are reachable from this route too.
 *   3. apiKey path or unauth → null. Public repos still clone fine;
 *      private clones simply fall back to the existing "auth required"
 *      error path. We do NOT use the apiKey as a proxy for any
 *      particular user identity.
 */
function resolveCloneUserId(req: Request): string | null {
  const areq = req as AuthenticatedRequest;
  if (areq.authUserId) return areq.authUserId;
  if (areq.authLocalOrgBypass && areq.authOrgId) {
    const username = `local-${areq.authOrgId}`;
    try {
      const existing = getUserByUsername(username);
      if (existing) return existing.id;
      const created = createUser({ username, passwordHash: '' });
      return created.id;
    } catch {
      return null;
    }
  }
  return null;
}

export default function createProjectRoutes(deps: RouteDeps): Router {
  const {
    stmts,
    broadcast,
    findProject,
    findAgent,
    saveProjects,
    ensureProjectRoom,
    config,
    getProjects,
    getProjectDataDir,
    ensureDocsAgents,
    ensureIntakeAgents,
    ensureReviewerAgents,
    getClaudeBin,
    setClaudeBin,
  } = deps;

  const router = Router();

  router.post('/api/projects/clone', async (req: Request, res: Response) => {
    const { url, targetDir } = req.body as { url?: string; targetDir?: string };
    if (!url) return res.status(400).json({ error: 'url is required' });

    // ── Classify the URL up front so we can fail fast on SSH ───────
    // SSH cloning needs a known_hosts entry + a registered key, neither
    // of which we can guarantee in Docker-deployed Hubs. Surface a
    // pointed message instead of letting git error with the cryptic
    // `Host key verification failed` line.
    const parsed = classifyCloneUrl(url);
    if (parsed.kind === 'github-ssh') {
      return res.status(400).json({ error: SSH_NOT_SUPPORTED_MESSAGE });
    }

    const repoName =
      url
        .replace(/\.git$/, '')
        .split('/')
        .pop() || 'repo';
    const home = process.env.HOME || '/tmp';
    const resolvedTarget = (targetDir || path.join(home, 'projects')).replace(/^~/, home);

    mkdirSync(resolvedTarget, { recursive: true });

    const clonePath = path.join(resolvedTarget, repoName);
    const cloneId = uuidv4();

    if (existsSync(clonePath)) {
      return res.status(409).json({
        error: `Directory already exists: ${clonePath}`,
        existingPath: clonePath,
        cloneId,
      });
    }

    // ── Resolve a user OAuth/PAT token for github-https URLs ───────
    // The connect-token endpoint stores both OAuth and PAT credentials
    // in the same `users.github_user_token` column, so this single
    // lookup covers both flows. For non-github or already-authenticated
    // URLs we leave `spawnUrl` equal to `url` and skip the rewrite.
    let spawnUrl = url;
    let injectedToken: string | null = null;
    if (parsed.kind === 'github-https') {
      try {
        const userId = resolveCloneUserId(req);
        if (userId) {
          const personal = config.personalOAuth;
          const app = config.githubApp;
          const creds =
            personal?.clientId && personal?.clientSecret
              ? { clientId: personal.clientId, clientSecret: personal.clientSecret }
              : app?.clientId && app?.clientSecret
                ? { clientId: app.clientId, clientSecret: app.clientSecret }
                : null;
          const token = await getActiveAccessToken(userId, creds);
          if (token) {
            spawnUrl = buildAuthenticatedUrl(parsed, token);
            injectedToken = token;
          }
        }
      } catch (err) {
        // Token lookup is best-effort: a missing orgs.db, a dead
        // refresh token, or a transient OAuth failure must not block
        // public-repo clones. Fall through with the original URL and
        // let git surface the auth error if the repo turns out to be
        // private.
        console.warn(
          `[clone] Token lookup failed, falling back to unauthenticated clone: ${
            (err as Error).message?.split('\n')[0]
          }`,
        );
      }
    }

    // Pass the spawn URL via argv. We deliberately keep the `cwd`
    // unchanged from the parent so any GIT_* env vars the operator
    // set continue to apply, and we redact the token from any string
    // that gets broadcast or logged.
    const proc: ChildProcess = spawn('git', ['clone', '--progress', spawnUrl, clonePath], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const safeForBroadcast = (text: string): string => redactToken(text, injectedToken);

    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      const lines = text.split(/\r?\n|\r/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          broadcast({ type: 'clone-progress', cloneId, message: safeForBroadcast(trimmed) });
        }
      }
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) broadcast({ type: 'clone-progress', cloneId, message: safeForBroadcast(text) });
    });

    proc.on('error', (err: Error) => {
      broadcast({
        type: 'clone-error',
        cloneId,
        error: `Failed to start git: ${safeForBroadcast(err.message)}`,
      });
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        // Strip the token from the cloned repo's git config so it
        // doesn't persist on disk. We rewrite back to the user's
        // original URL string verbatim — that round-trip is the
        // promise of the clone wizard.
        if (injectedToken) {
          try {
            // execFileSync (no shell) is required here: both `clonePath`
            // (derived from a request-controlled `targetDir` via
            // `mkdirSync(..., { recursive: true })`, which doesn't
            // filter shell metachars) and `url` reach this call. Running
            // them through `sh -c` — even quoted with JSON.stringify —
            // would still expand `$(...)`, backticks, and `$VAR` because
            // those are evaluated inside double quotes. argv-style
            // execution sidesteps the shell entirely.
            execFileSync('git', ['-C', clonePath, 'remote', 'set-url', 'origin', url], {
              stdio: 'ignore',
            });
          } catch (err) {
            // Non-fatal: the repo is cloned and usable. Worst case
            // the user sees the tokenized URL in `git remote -v`
            // until they re-set it. Log so this is debuggable —
            // redacted in case git echoed the rewritten URL into its
            // error message before failing.
            const raw = (err as Error).message ?? String(err);
            console.warn(
              `[clone] Failed to scrub token from origin remote: ${safeForBroadcast(raw)}`,
            );
          }
        }
        broadcast({ type: 'clone-complete', cloneId, path: clonePath, repoName });
      } else {
        let errorMsg = `git clone exited with code ${code}`;
        const safeStderr = safeForBroadcast(stderrBuf);
        if (stderrBuf.includes('Host key verification failed')) {
          errorMsg = SSH_NOT_SUPPORTED_MESSAGE;
        } else if (stderrBuf.includes('Permission denied') || stderrBuf.includes('publickey')) {
          errorMsg =
            'SSH key authentication failed. Use the HTTPS URL form and connect your GitHub account in Settings → GitHub.';
        } else if (
          stderrBuf.includes('could not read Username') ||
          stderrBuf.includes('Authentication failed') ||
          stderrBuf.includes('403')
        ) {
          errorMsg = injectedToken
            ? 'Authentication failed. Your connected GitHub account may not have access to this repo, or the token has expired — try reconnecting in Settings → GitHub.'
            : 'Authentication required for this repo. Connect your GitHub account in Settings → GitHub and try again.';
        } else if (stderrBuf.includes('not found') || stderrBuf.includes('404')) {
          errorMsg = 'Repository not found. Check the URL and your access permissions.';
        } else if (stderrBuf.includes('already exists')) {
          errorMsg = `Directory already exists: ${clonePath}`;
        }
        broadcast({ type: 'clone-error', cloneId, error: errorMsg, stderr: safeStderr });
      }
    });

    const timeout = setTimeout(
      () => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }, 2000);
        broadcast({ type: 'clone-error', cloneId, error: 'Clone timed out after 5 minutes' });
      },
      5 * 60 * 1000,
    );

    proc.on('close', () => clearTimeout(timeout));

    // Echo the original URL back to the caller (never the tokenized
    // form). The client tracks the clone via `cloneId` over the
    // WebSocket from this point.
    res.json({ cloneId, repoName, clonePath });
  });

  router.get('/api/projects', (_req: Request, res: Response) => {
    const projects = getProjects();
    const enriched = projects.map((p) => ({
      ...p,
      agents: p.agents.map((a) => {
        const sessions = stmts.getSessions.all(a.id) as Array<{ id: string; updated_at: string }>;
        let lastActivity: string | null = null;
        let lastMessage: { role: string; content: string; created_at: string } | null = null;
        if (sessions.length > 0) {
          lastActivity = sessions[0].updated_at;
          const msg = stmts.getLastMessage.get(sessions[0].id) as
            | {
                role: string;
                content: string;
                created_at: string;
              }
            | undefined;
          if (msg) {
            lastMessage = {
              role: msg.role,
              content: msg.content.substring(0, 100),
              created_at: msg.created_at,
            };
          }
        }
        return {
          ...a,
          projectId: p.id,
          projectName: p.name,
          cwd: p.cwd,
          ahw: p.ahw,
          lastActivity,
          lastMessage,
        };
      }),
    }));
    res.json(enriched);
  });

  router.get('/api/setup/status', (_req: Request, res: Response) => {
    const projects = getProjects();
    let claudeAvailable = false;

    try {
      execSync(`"${getClaudeBin()}" --version`, { timeout: 5000, stdio: 'pipe' });
      claudeAvailable = true;
    } catch {}

    res.json({
      firstRun: projects.length === 0,
      engines: {
        'claude-code': {
          available: claudeAvailable,
          path: getClaudeBin(),
        },
      },
      dataDir: config.dataDir,
      projectsDir: config.projectsDir,
    });
  });

  router.post('/api/setup/configure', (req: Request, res: Response) => {
    const { claudeBin } = req.body as { claudeBin?: string };

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {}

    if (claudeBin !== undefined) fileConfig.claudeBin = claudeBin;

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

    if (claudeBin !== undefined) {
      setClaudeBin(claudeBin);
      config.claudeBin = claudeBin;
    }

    res.json({ ok: true, message: 'Configuration updated.' });
  });

  router.get('/api/projects/:projectId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  // ─── Branch listing for the PR base-branch picker ─────────────────
  //
  // Cards can override the PR base branch (via `pr_base_branch`). The card
  // configuration UI needs to list every branch the project's git remote
  // knows about — including feature branches that don't exist locally — so
  // users can target stacked / dependent PRs.
  //
  // Strategy: shell out to `git ls-remote --heads origin` from the project
  // cwd. This works for any GitHub-connected project whose repo is checked
  // out at `project.cwd`, regardless of whether the GitHub App is installed.
  // The result is cached briefly per-project to avoid hammering the remote
  // when the picker re-opens.
  interface BranchListEntry {
    name: string;
    isDefault: boolean;
  }
  interface BranchCacheEntry {
    branches: BranchListEntry[];
    fetchedAt: number;
  }
  const BRANCH_CACHE_TTL_MS = 30_000;
  const branchCache = new Map<string, BranchCacheEntry>();

  router.get(
    '/api/projects/:projectId/branches',
    async (req: Request, res: Response): Promise<void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      if (!project.cwd || !existsSync(project.cwd)) {
        res.status(400).json({ error: 'Project cwd is missing or does not exist on disk' });
        return;
      }

      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      const cached = branchCache.get(project.id);
      if (!force && cached && Date.now() - cached.fetchedAt < BRANCH_CACHE_TTL_MS) {
        res.json({ branches: cached.branches, cached: true });
        return;
      }

      try {
        // Confirm there's a git remote first so we return a clean error
        // instead of letting `ls-remote` produce a cryptic stderr.
        try {
          await execAsync('git remote get-url origin', {
            cwd: project.cwd,
            timeout: 5000,
          });
        } catch {
          res.status(400).json({
            error: 'Project has no `origin` git remote configured',
            branches: [],
          });
          return;
        }

        const { stdout } = await execAsync('git ls-remote --heads origin', {
          cwd: project.cwd,
          timeout: 15_000,
          maxBuffer: 5 * 1024 * 1024,
        });

        // Lines look like: "<sha>\trefs/heads/<branch-name>"
        const branchNames: string[] = [];
        for (const line of stdout.split('\n')) {
          const match = line.match(/^[0-9a-f]{40,}\trefs\/heads\/(.+)$/);
          if (match) branchNames.push(match[1].trim());
        }
        branchNames.sort((a, b) => a.localeCompare(b));

        // Resolve the default branch so the UI can flag it. Reuse the same
        // ordering as `auto-git.ts#resolveDefaultBranch`: origin/HEAD, then
        // local main / master.
        let defaultBranch: string | null = null;
        try {
          const { stdout: headOut } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
            cwd: project.cwd,
            timeout: 5000,
          });
          defaultBranch = headOut.trim().replace('refs/remotes/origin/', '') || null;
        } catch {
          for (const candidate of ['main', 'master']) {
            if (branchNames.includes(candidate)) {
              defaultBranch = candidate;
              break;
            }
          }
        }

        const branches: BranchListEntry[] = branchNames.map((name) => ({
          name,
          isDefault: name === defaultBranch,
        }));
        branchCache.set(project.id, { branches, fetchedAt: Date.now() });
        res.json({ branches, defaultBranch, cached: false });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[projects] branch listing failed for ${project.id}: ${msg}`);
        res.status(500).json({ error: `Failed to list branches: ${msg}`, branches: [] });
      }
    },
  );

  router.post('/api/projects', (req: Request, res: Response) => {
    const projects = getProjects();
    const {
      id,
      name,
      cwd,
      color,
      commands,
      preCommitCommands,
      checkHealCommands,
      checkHealMaxRounds,
    } = req.body as {
      id?: string;
      name?: string;
      cwd?: string;
      color?: string;
      commands?: ProjectCommands;
      preCommitCommands?: unknown;
      checkHealCommands?: unknown;
      checkHealMaxRounds?: unknown;
    };
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
      return res.status(400).json({ error: 'id is required and must be alphanumeric+hyphens' });
    }
    if (findProject(id)) {
      return res.status(409).json({ error: 'Project id already exists' });
    }
    const dataDir = getProjectDataDir(id);
    const project: Project = {
      id,
      name: name || id,
      cwd: cwd || config.defaultCwd,
      ahw: dataDir,
      color: color || '#6b7280',
      agents: [],
    };
    if (commands && typeof commands === 'object') {
      (project as Record<string, unknown>).commands = {
        install: commands.install || null,
        build: commands.build || null,
        test: commands.test || null,
        lint: commands.lint || null,
      };
    }
    const pcCreate = normalizePreCommitCommands(preCommitCommands);
    if (pcCreate.length) (project as Record<string, unknown>).preCommitCommands = pcCreate;
    const healCreate = normalizePreCommitCommands(checkHealCommands);
    if (healCreate.length) (project as Record<string, unknown>).checkHealCommands = healCreate;
    if ((req.body as Record<string, unknown>).checkHealMaxRounds !== undefined) {
      const healRoundsCreate = normalizeCheckHealMaxRounds(checkHealMaxRounds);
      if (healRoundsCreate == null) {
        return res.status(400).json({ error: CHECK_HEAL_MAX_ROUNDS_INVALID });
      }
      (project as Record<string, unknown>).checkHealMaxRounds = healRoundsCreate;
    }
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
    mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
    mkdirSync(path.join(dataDir, 'memory'), { recursive: true });

    projects.push(project);
    saveProjects();
    res.status(201).json(project);
  });

  router.patch('/api/projects/:projectId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const allowed = ['name', 'cwd', 'color', 'defaultReviewer', 'githubRepo'] as const;
    for (const key of allowed) {
      if ((req.body as Record<string, unknown>)[key] !== undefined)
        (project as Record<string, unknown>)[key] = (req.body as Record<string, unknown>)[key];
    }
    if (
      (req.body as Record<string, unknown>).commands &&
      typeof (req.body as Record<string, unknown>).commands === 'object'
    ) {
      if (!(project as Record<string, unknown>).commands)
        (project as Record<string, unknown>).commands = {};
      const projectCommands = (project as Record<string, unknown>).commands as Record<
        string,
        unknown
      >;
      const bodyCommands = (req.body as Record<string, unknown>).commands as Record<
        string,
        unknown
      >;
      for (const cmd of ['install', 'build', 'test', 'lint']) {
        if (bodyCommands[cmd] !== undefined) {
          projectCommands[cmd] = bodyCommands[cmd] || null;
        }
      }
    }
    if (
      (req.body as Record<string, unknown>).githubWorkflow &&
      typeof (req.body as Record<string, unknown>).githubWorkflow === 'object'
    ) {
      if (!(project as Record<string, unknown>).githubWorkflow)
        (project as Record<string, unknown>).githubWorkflow = {};
      const projectGhw = (project as Record<string, unknown>).githubWorkflow as Record<
        string,
        unknown
      >;
      const bodyGhw = (req.body as Record<string, unknown>)
        .githubWorkflow as GithubWorkflowSettings;
      for (const key of [
        'autoMerge',
        'autoReview',
        'waitForCI',
        'waitForResolvedComments',
      ] as const) {
        if (bodyGhw[key] !== undefined) {
          projectGhw[key] = !!bodyGhw[key];
        }
      }
      if (bodyGhw.reviewerModel !== undefined) {
        if (bodyGhw.reviewerModel === null || bodyGhw.reviewerModel === '') {
          delete projectGhw.reviewerModel;
        } else if (typeof bodyGhw.reviewerModel === 'string') {
          const trimmed = bodyGhw.reviewerModel.trim();
          if (trimmed) projectGhw.reviewerModel = trimmed;
          else delete projectGhw.reviewerModel;
        }
      }
    }
    if ((req.body as Record<string, unknown>).preCommitCommands !== undefined) {
      const rawPc = (req.body as Record<string, unknown>).preCommitCommands;
      const pc = normalizePreCommitCommands(rawPc);
      if (pc.length) (project as Record<string, unknown>).preCommitCommands = pc;
      else delete (project as Record<string, unknown>).preCommitCommands;
    }
    if ((req.body as Record<string, unknown>).checkHealCommands !== undefined) {
      const rawH = (req.body as Record<string, unknown>).checkHealCommands;
      const h = normalizePreCommitCommands(rawH);
      if (h.length) (project as Record<string, unknown>).checkHealCommands = h;
      else delete (project as Record<string, unknown>).checkHealCommands;
    }
    if ((req.body as Record<string, unknown>).checkHealMaxRounds !== undefined) {
      const rawR = (req.body as Record<string, unknown>).checkHealMaxRounds;
      if (rawR === null || rawR === '') {
        delete (project as Record<string, unknown>).checkHealMaxRounds;
      } else {
        const n = normalizeCheckHealMaxRounds(rawR);
        if (n == null) {
          return res.status(400).json({ error: CHECK_HEAL_MAX_ROUNDS_INVALID });
        }
        (project as Record<string, unknown>).checkHealMaxRounds = n;
      }
    }
    if ((req.body as Record<string, unknown>).orchestrationBudgets !== undefined) {
      const rawOb = (req.body as Record<string, unknown>).orchestrationBudgets;
      if (rawOb === null) {
        delete (project as Record<string, unknown>).orchestrationBudgets;
      } else if (typeof rawOb === 'object' && rawOb !== null && !Array.isArray(rawOb)) {
        const sanitized = sanitizeOrchestrationBudgetsPartial(rawOb);
        if (sanitized && Object.keys(sanitized).length > 0) {
          (project as Record<string, unknown>).orchestrationBudgets = sanitized as Record<
            string,
            unknown
          >;
        } else {
          delete (project as Record<string, unknown>).orchestrationBudgets;
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'mode')) {
      const rawMode = (req.body as Record<string, unknown>).mode;
      if (rawMode === null || rawMode === undefined || rawMode === '') {
        delete (project as Record<string, unknown>).mode;
      } else if (rawMode === 'dev' || rawMode === 'workflow') {
        (project as Record<string, unknown>).mode = rawMode as ProjectMode;
      } else {
        return res.status(400).json({ error: 'mode must be "dev", "workflow", or null' });
      }
    }
    if (
      (req.body as Record<string, unknown>).githubRepo &&
      typeof (req.body as Record<string, unknown>).githubRepo === 'string'
    ) {
      const repoUrl = `https://github.com/${(req.body as Record<string, unknown>).githubRepo}`;
      const existing = stmts.getWebhookConfigByProjectAndRepo.get(project.id, repoUrl) as
        | Record<string, unknown>
        | undefined;
      if (!existing) {
        const secret = crypto.randomBytes(32).toString('hex');
        // Default-on set is deliberately scoped to events the autonomous-mode
        // polling safety net in `autonomous.ts` does NOT already cover. The
        // three events seeded as `enabled: false` below are handled by the
        // every-3-minute poll:
        //   - pull_request.closed           → reconcileKanbanWithGitHub sweeps merged PRs to Done
        //   - pull_request_review.submitted → pollForMissedReviews catches changes_requested
        //   - check_suite.completed         → not polled by default; autofix-on-CI is opt-in
        // They're still seeded (rather than omitted) so they appear in the
        // webhook config UI pre-wired for operators to flip on per-repo.
        // Prior default-on all six caused 1,079 Claude invocations in one
        // log window under routine PR activity (incident 2026-04-16).
        const defaultEvents = JSON.stringify({
          'pull_request.opened': { enabled: true },
          'pull_request.synchronize': { enabled: true },
          'pull_request_review_comment.created': { enabled: true },
          'pull_request.closed': { enabled: false },
          'pull_request_review.submitted': { enabled: false },
          'check_suite.completed': { enabled: false },
        });
        stmts.createWebhookConfig.run(project.id, repoUrl, secret, defaultEvents, 1, '[]');
      }
    }
    saveProjects();
    res.json(project);
  });

  router.delete('/api/projects/:projectId', (req: Request, res: Response) => {
    const projects = getProjects();
    const idx = projects.findIndex((p) => p.id === req.params.projectId);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    const project = projects[idx];

    stmts.deleteEscalationsByProject.run(project.id);
    stmts.deleteNotesByProject.run(project.id);
    stmts.deleteWikiPagesByProject.run(project.id);
    stmts.deleteWebhookConfigsByProject.run(project.id);
    stmts.deleteBoardsByProject.run(project.id);
    stmts.deleteWorkflowsByProject.run(project.id);
    stmts.deleteThreadsByProject.run(project.id);
    stmts.deleteRoomsByProject.run(project.id);
    stmts.deleteCronsByProject.run(project.id);

    const agentIds = (project.agents || []).map((a) => a.id);
    for (const agentId of agentIds) {
      stmts.deleteSessionsByAgent.run(agentId);
    }

    projects.splice(idx, 1);
    saveProjects();
    res.status(204).end();
  });

  // ─── Project analysis (Open Project wizard) ──────────────────────
  router.post('/api/projects/analyze', (req: Request, res: Response) => {
    const { cwd } = req.body as { cwd?: string };
    if (!cwd) return res.status(400).json({ error: 'cwd is required' });

    const resolvedCwd = cwd.replace(/^~/, process.env.HOME || '/tmp');
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      return res.status(400).json({ error: 'Path does not exist or is not a directory' });
    }

    const analyzeId = uuidv4();

    const CLAUDE_BIN = getClaudeBin();
    const args = [
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      config.defaultModel,
      '--system-prompt',
      ANALYZE_SYSTEM_PROMPT,
      '--output-format',
      'stream-json',
      '--verbose',
      ANALYZE_USER_PROMPT,
    ];

    console.log(`[analyze ${analyzeId}] spawning ${CLAUDE_BIN} in ${resolvedCwd}`);

    let proc: ChildProcess;
    try {
      proc = spawn(CLAUDE_BIN, args, {
        cwd: resolvedCwd,
        env: buildSpawnEnv(config),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      console.error(`[analyze ${analyzeId}] spawn threw:`, (err as Error).message);
      return res.status(500).json({ error: `Failed to spawn claude: ${(err as Error).message}` });
    }

    const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      console.error(`[analyze ${analyzeId}] timed out after ${ANALYZE_TIMEOUT_MS}ms, killing`);
      try {
        proc.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 2000);
      broadcast({
        type: 'analyze-error',
        analyzeId,
        error: `Analysis timed out after ${ANALYZE_TIMEOUT_MS / 1000}s`,
      });
    }, ANALYZE_TIMEOUT_MS);

    const parser = createStreamParser('claude-code');
    let finalText = '';
    let stderr = '';

    const describeToolUse = (tool: string, input: Record<string, unknown> = {}): string => {
      switch (tool) {
        case 'Read':
          return `Reading ${shortPath(input.file_path as string)}`;
        case 'Glob':
          return `Searching for ${(input.pattern as string) || 'files'}`;
        case 'Grep':
          return `Grepping ${(input.pattern as string) || ''}${input.path ? ` in ${shortPath(input.path as string)}` : ''}`;
        case 'LS':
          return `Listing ${shortPath(input.path as string)}`;
        case 'Bash':
          return `Running: ${((input.command as string) || '').slice(0, 80)}`;
        case 'WebFetch':
          return `Fetching ${input.url}`;
        case 'TodoWrite':
          return `Planning next steps`;
        default:
          return `Using ${tool}`;
      }
    };
    const shortPath = (p: string | undefined): string => {
      if (!p) return '';
      const rel = p.startsWith(resolvedCwd) ? p.slice(resolvedCwd.length + 1) : p;
      return rel || p;
    };

    const handleEvent = (ev: StreamEvent): void => {
      if (ev.type === 'tool_use') {
        const message = describeToolUse(ev.tool, ev.input);
        console.log(`[analyze ${analyzeId}] ${message}`);
        broadcast({ type: 'analyze-progress', analyzeId, message });
      } else if (ev.type === 'assistant_text' && !ev.partial) {
        finalText += ev.text;
      } else if (ev.type === 'thinking') {
        broadcast({ type: 'analyze-progress', analyzeId, message: 'Thinking…' });
      } else if (ev.type === 'result' && ev.text && !finalText) {
        finalText = ev.text;
      }
    };

    proc.on('error', (err: Error) => {
      clearTimeout(timeoutHandle);
      console.error(`[analyze ${analyzeId}] process error:`, err.message);
      broadcast({
        type: 'analyze-error',
        analyzeId,
        error: `Failed to start claude (${(err as NodeJS.ErrnoException).code || 'ERR'}): ${err.message}`,
      });
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      for (const ev of parser.feed(chunk)) handleEvent(ev);
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      console.error(`[analyze ${analyzeId}] stderr:`, text.trimEnd());
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timeoutHandle);
      if (timedOut) return;
      for (const ev of parser.flush()) handleEvent(ev);
      console.log(
        `[analyze ${analyzeId}] exited code=${code}, finalText length=${finalText.length}`,
      );
      if (code !== 0) {
        broadcast({
          type: 'analyze-error',
          analyzeId,
          error: stderr || `Process exited with code ${code}`,
        });
        return;
      }

      let result: AnalysisResult | null = null;
      const fenceMatch = finalText.match(/```json\s*([\s\S]*)```/);
      if (fenceMatch) {
        try {
          result = JSON.parse(fenceMatch[1].trim()) as AnalysisResult;
        } catch {
          // Try the whole output
        }
      }
      if (!result) {
        try {
          result = JSON.parse(finalText.trim()) as AnalysisResult;
        } catch {
          broadcast({
            type: 'analyze-error',
            analyzeId,
            error: 'Failed to parse analysis output as JSON',
          });
          return;
        }
      }

      broadcast({ type: 'analyze-complete', analyzeId, result });
    });

    res.json({ analyzeId });
  });

  router.post('/api/projects/onboard', (req: Request, res: Response) => {
    const {
      project: projectData,
      agents: agentDefs,
      contextFiles,
      commands,
    } = req.body as OnboardBody;

    if (!projectData?.id || !/^[a-zA-Z0-9-]+$/.test(projectData.id)) {
      return res
        .status(400)
        .json({ error: 'Project id is required and must be alphanumeric+hyphens' });
    }
    if (findProject(projectData.id)) {
      return res.status(409).json({ error: 'Project id already exists' });
    }

    const resolvedCwd = (projectData.cwd || config.defaultCwd).replace(
      /^~/,
      process.env.HOME || '/tmp',
    );

    const dataDir = getProjectDataDir(projectData.id);
    const project: Project = {
      id: projectData.id,
      name: projectData.name || projectData.id,
      cwd: resolvedCwd,
      ahw: dataDir,
      color: projectData.color || '#6b7280',
      agents: [],
    };
    if (commands && typeof commands === 'object') {
      (project as Record<string, unknown>).commands = {
        install: commands.install || null,
        build: commands.build || null,
        test: commands.test || null,
        lint: commands.lint || null,
      };
    }
    const pcOnboard = normalizePreCommitCommands(projectData.preCommitCommands);
    if (pcOnboard.length) (project as Record<string, unknown>).preCommitCommands = pcOnboard;
    const healOnboard = normalizePreCommitCommands(projectData.checkHealCommands);
    if (healOnboard.length) (project as Record<string, unknown>).checkHealCommands = healOnboard;
    if (projectData.checkHealMaxRounds !== undefined) {
      const healRoundsOnboard = normalizeCheckHealMaxRounds(projectData.checkHealMaxRounds);
      if (healRoundsOnboard == null) {
        return res.status(400).json({ error: CHECK_HEAL_MAX_ROUNDS_INVALID });
      }
      (project as Record<string, unknown>).checkHealMaxRounds = healRoundsOnboard;
    }

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
    mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
    mkdirSync(path.join(dataDir, 'memory'), { recursive: true });

    if (contextFiles) {
      for (const [filename, content] of Object.entries(contextFiles)) {
        if (content && typeof content === 'string') {
          writeFileSync(path.join(dataDir, filename), content, 'utf-8');
        }
      }
    }

    if (Array.isArray(agentDefs)) {
      const leadDef =
        agentDefs.find((d) => d.role === 'lead') || (agentDefs.length > 1 ? agentDefs[0] : null);
      const subDefs = agentDefs.filter((d) => d !== leadDef);

      for (const def of agentDefs) {
        if (!def.id || !/^[a-zA-Z0-9-]+$/.test(def.id)) continue;
        if (findAgent(def.id)) continue;

        const isLead = def === leadDef && agentDefs.length > 1;
        const isSub = !isLead && leadDef && agentDefs.length > 1;

        const agent: Agent = {
          id: def.id,
          name: def.name || def.id,
          engine: def.engine || 'claude-code',
          systemPrompt: def.systemPrompt || '',
          color: def.color || project.color,
          heartbeat: { enabled: false, interval: '', prompt: '' },
        };

        if (isLead) {
          agent.role = 'lead';
          agent.subAgents = subDefs
            .filter((s) => s.id && /^[a-zA-Z0-9-]+$/.test(s.id))
            .map((s) => s.id);
        } else if (isSub) {
          agent.role = 'sub';
          agent.parentAgentId = leadDef!.id;
        }

        mkdirSync(path.join(dataDir, 'agents', agent.id), { recursive: true });

        if (def.identity) {
          writeFileSync(
            path.join(dataDir, 'agents', agent.id, 'IDENTITY.md'),
            def.identity,
            'utf-8',
          );
        }

        project.agents.push(agent);
      }
    }

    if (projectData.githubRepo?.owner && projectData.githubRepo?.repo) {
      const { owner, repo } = projectData.githubRepo;
      const repoUrl = `https://github.com/${owner}/${repo}`;
      const defaultEvents = JSON.stringify([
        'pull_request.opened',
        'pull_request.closed',
        'pull_request.synchronize',
        'pull_request_review.submitted',
        'pull_request_review_comment.created',
        'check_suite.completed',
      ]);
      try {
        stmts.createWebhookConfig.run(project.id, repoUrl, null, defaultEvents, 1, '[]');
      } catch (err: unknown) {
        console.warn(`[Onboard] Failed to create webhook config: ${(err as Error).message}`);
      }
    }

    const projects = getProjects();
    projects.push(project);
    saveProjects();

    ensureDocsAgents();
    ensureIntakeAgents();
    ensureReviewerAgents();

    ensureProjectRoom(project);

    // Notify any connected clients so their sidebar picks up the new
    // project (and any auto-seeded Docs/Intake/Reviewer agents) without
    // requiring a full page refresh.
    broadcast({ type: 'projects_updated', reason: 'project-created' });

    const enriched = {
      ...project,
      agents: project.agents.map((a) => ({
        ...a,
        projectId: project.id,
        projectName: project.name,
        cwd: project.cwd,
        ahw: project.ahw,
      })),
    };
    res.status(201).json(enriched);
  });

  return router;
}
