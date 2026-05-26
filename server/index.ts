import { installLogCapture, setLogBroadcast } from './server-log.js';
installLogCapture(); // Must be first — captures all subsequent console output

import express from 'express';
import type { Request, Response } from 'express';
import { createServer } from 'http';
import createWebSocket from './websocket.js';
import cors from 'cors';
import { corsOptions } from './cors-config.js';
import { exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { stmts, initDb, getDb } from './db.js';
import {
  initProjects,
  migrateAhwDirectories,
  getProjects,
  setProjects,
  findProject,
  findAgent,
  allAgents,
  getEnrichedAgent,
  getProjectDataDir,
  saveProjects,
  reloadProjects,
  ensureDocsAgents,
  ensureIntakeAgents,
  ensureReviewerAgents,
  ensureContextFiles,
  ensureProjectRoom,
} from './project-model.js';
import {
  scheduleAll,
  rescheduleCron,
  setOnCronSessionUpdate,
  setBroadcast,
  runClaude,
} from './heartbeat.js';
import { startSlack } from './slack.js';
import { startStalePrChecker } from './stale-pr-check.js';
import { startPrRebasePoll, type TriggerResolveResult } from './pr-rebase-poll.js';
import { appendDailyNote } from './memory.js';
import config, { refreshShellPath } from './config.js';
import { warnIfLegacyBotGithubToken } from './github-auth-policy.js';
import { ensureReviewerGhConfigDir } from './spawn-github-credentials.js';
import {
  getAppInfo,
  getAppInstallations,
  githubApiRequest,
  buildAppManifest,
  clearTokenCache,
} from './github-app.js';
import { authMiddleware } from './auth.js';
import { initOrgsDb, orgDataDir, getActiveOrgId } from './orgs.js';
import { migrateAuthRecordIfNeeded } from './users-store.js';
import { backfillSessionOwners, resetOrgOwnerCache } from './session-ownership.js';
import { maybeAutoProvisionOwner } from './auth-bootstrap.js';
import { sessionUsesWorktree } from './project-mode.js';
import { isPreviewSetupWizardSession } from './routes/preview-wizard.js';
import { ensureSessionWorkspace, type OnBaseBranchAdvancedFn } from './worktree.js';
import { handleWorktreeFailure } from './worktree-failure.js';
import { installShutdownHandlers, killProcessGroup } from './process-groups.js';

import { trustProxyValueFromEnv } from './trust-proxy.js';
import { uriDecodeGuard, uriErrorHandler } from './uri-error-handler.js';
import createNoteRoutes from './routes/notes.js';
import createToolErrorRoutes from './routes/tool-errors.js';
import createWikiRoutes from './routes/wiki.js';
import createHeartbeatRoutes from './routes/heartbeats.js';
import createCronRoutes from './routes/crons.js';
import createMemoryRoutes from './routes/memory.js';
import createRoomRoutes from './routes/rooms.js';
import createDesignRoutes from './routes/designs.js';
import createSkillRoutes, { DEFAULT_SKILLS_DIR, syncSkillsToClaude } from './routes/skills.js';
import createClawhubRoutes from './routes/clawhub.js';
import createWebhookRoutes, {
  createGithubWebhookHandler,
  pendingReviewComments,
} from './routes/webhooks.js';
import createBoardRoutes from './routes/board.js';
import createConfigRoutes from './routes/config.js';
import createSessionRoutes, { summarizeTranscript, buildTranscript } from './routes/sessions.js';
import createProjectRoutes from './routes/projects.js';
import { createProjectVisibilityGate } from './project-visibility-middleware.js';
import { cascadeDeleteUserPrivateProjects } from './project-owner-cascade.js';
import createPreviewSecretsRoutes from './routes/preview-secrets.js';
import createProjectAwsRoutes from './routes/project-aws.js';
import createPreviewWizardRoutes from './routes/preview-wizard.js';
import createPreviewEnvironmentRoutes from './routes/preview-environment.js';
import createPreviewInstancesRoutes from './routes/preview-instances.js';
import createProvisioningRoutes from './routes/provisioning.js';
import createAuditRoutes from './routes/audit.js';
import createAgentRoutes from './routes/agents.js';
import createOrgRoutes from './routes/orgs.js';
import createDashboardRoutes from './routes/dashboard.js';
import createUploadRoutes from './routes/uploads.js';
import createTranscribeRoutes from './routes/transcribe.js';
import createMiscRoutes, { createHealthRoute } from './routes/misc.js';
import createReleasesRoutes from './routes/releases.js';
import { createApiDocsRoutes } from './routes/api-docs.js';
import createHookRoutes from './routes/hooks.js';
import createClaudeAuthRoutes from './routes/claude-auth.js';
import createGeminiAuthRoutes from './routes/gemini-auth.js';
import createCodexAuthRoutes from './routes/codex-auth.js';
import createCursorAuthRoutes from './routes/cursor-auth.js';
import createPerUserEngineAuthRoutes from './routes/per-user-engine-auth.js';
import createThreadRoutes from './routes/threads.js';
import createWorkflowRoutes from './routes/workflows.js';
import { failStuckWorkflowRunsOnBoot } from './workflow-runner.js';
import { createWorkflowIncomingRouter, refreshWorkflowCronSchedules } from './workflow-triggers.js';
import createSlackRoutes from './routes/slack.js';
import createEscalationRoutes from './routes/escalations.js';
import createInstanceBackupRoutes from './routes/instance-backup.js';
import createIosBuildRoutes from './routes/ios-builds.js';
import { initIosBuildEngine } from './ios-build-engine.js';
import { initWebhookWorker } from './webhook-worker.js';
import createPrActionRoutes from './routes/pr-actions.js';
import createPrListRoutes from './routes/pr-list.js';
import createPrResolveRoutes from './routes/pr-resolve.js';
import createPrNudgeReviewerRoutes from './routes/pr-nudge-reviewer.js';
import createBugReportRoutes from './routes/bug-reports.js';
import createAuthRoutes from './routes/auth.js';
import createMcpServerRoutes from './routes/mcp-servers.js';
import createGithubOAuthRoutes from './routes/github-oauth.js';
import type { AddressInfo } from 'net';
import { setActualPort } from './server-port.js';

import {
  initDelegation,
  activeDelegationSessions,
  parseDelegateBlock,
  handleDelegationCancel,
  handleDelegation,
  synthesizeResults,
} from './delegation.js';

import { initHandoff } from './handoff.js';

import {
  initRoomChat,
  activeRoomProcesses,
  handleRoomChat,
  handleRoomCancel,
  handleRoomDequeue,
} from './room-chat.js';

import { initDesignChat, handleDesignChat, handleDesignCancel } from './design-chat.js';
import { ensureDesignsRoot, getDesign as getDesignStore } from './designs-store.js';

import { initAutoGit, autoCommitAndPR, resolveSlashSkill } from './auto-git.js';

import createChatHandler, {
  buildEnrichedPrompt,
  type ChatHandlerDeps,
  type WebSocketLike,
} from './chat.js';

import { createPreviewRuntimes } from './preview/preview-runtime-setup.js';
import { createPreviewUrlBase } from './preview/preview-public-url.js';
import { attachDefaultPreviewProxyUpgrade } from './preview/preview-proxy.js';
import { getSessionPreviewPort } from './preview/session-preview-port.js';
import { runPreviewReaper, PREVIEW_REAPER_CRON } from './preview/preview-reaper.js';
import cron from 'node-cron';

import {
  initAutonomous,
  autonomousCrons,
  autonomousProjects,
  lastDispatchedReviewId,
  runAutonomousLoop,
  tryAutonomousDispatch,
  scheduleAutonomousEpic,
  restoreAutonomousCrons,
  startReviewPollingFallback,
} from './autonomous.js';

import type {
  BroadcastFn,
  RouteDeps,
  ChatMessage,
  RoomChatMessage,
  DesignChatMessage,
  SessionRow,
  ActiveTaskRow,
  KanbanCardRow,
  KanbanColumnRow,
  Project,
} from './types.js';

const __dirname: string = path.dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);
const PORT: number = config.port;

let CLAUDE_BIN: string = config.claudeBin;
let CURSOR_BIN: string = config.cursorBin;
let GEMINI_BIN: string = config.geminiBin;
let CODEX_BIN: string = config.codexBin;

let handleChat: ((ws: unknown, msg: ChatMessage) => Promise<void>) | undefined;
let saveErrorMessage:
  | ((
      sessionId: string,
      messageId: string,
      engine: string,
      model: string,
      errorText: string,
    ) => string)
  | undefined;
const DEFAULT_MODEL: string = config.defaultModel;
const ENGINE_VALID_MODELS: Record<string, string[]> = config.engineValidModels;
const ALL_VALID_MODELS: string[] = config.allValidModels;

let ghAuthenticatedUser: string | null = null;
execAsync('gh api user --jq ".login"')
  .then(({ stdout }) => {
    ghAuthenticatedUser = stdout.trim();
    console.log(`[GitHub] Authenticated as: ${ghAuthenticatedUser}`);
  })
  .catch(() => {
    console.warn('[GitHub] Could not detect gh CLI user — webhook loop prevention disabled');
  });

let ghBotUser: string | null = null;
let ghAppSlug: string | null = null;

if (config.githubApp?.appId && config.githubApp?.privateKey) {
  getAppInfo(config.githubApp.appId, config.githubApp.privateKey)
    .then((app) => {
      ghAppSlug = (app.slug as string) || (app.name as string);
      console.log(`[GitHub App] Connected: ${ghAppSlug} (ID: ${app.id})`);
    })
    .catch((err: Error) => {
      console.warn(
        `[GitHub App] Could not verify app — credentials may be invalid: ${err.message?.split('\n')[0]}`,
      );
    });
}

warnIfLegacyBotGithubToken(config);

let _activeDataDir: string = config.dataDir;

initOrgsDb();
// Migrate the pre-Phase-3 single-user auth.json into the new users +
// memberships tables. No-op when users already exist or auth.json is
// missing (fresh install → setup flow seeds the first Owner directly).
try {
  const migrated = migrateAuthRecordIfNeeded();
  if (migrated) {
    console.log(
      `[Auth] Migrated legacy auth.json user into users table (id=${migrated.migratedUserId})`,
    );
  }
} catch (err) {
  console.error('[Auth] Failed to migrate legacy auth.json → users table:', err);
}

// Env-driven auto-provisioning for fresh deploys (Terraform / Docker /
// SSM bootstrap). When AGENT_HUB_DEFAULT_PASSWORD is set and no
// auth.json exists yet, create the Owner account from the env vars.
// No-op on every subsequent boot because auth.json now exists.
// Top-level await is fine here: tsconfig targets ES2022 + nodenext.
try {
  await maybeAutoProvisionOwner();
} catch (err) {
  // Only thrown when AGENT_HUB_DEFAULT_PASSWORD=auto and we couldn't
  // write the credentials file. Re-raising kills boot — the operator
  // would otherwise have no way to retrieve the generated password.
  console.error('[Auth] Auto-provision failed fatally:', err);
  throw err;
}

initProjects(config.dataDir);

const _startupOrgId: string = getActiveOrgId();
if (_startupOrgId !== 'default') {
  const _startupDataDir: string = orgDataDir(_startupOrgId);
  mkdirSync(_startupDataDir, { recursive: true });
  initDb(_startupDataDir);
  _activeDataDir = _startupDataDir;
  initProjects(_startupDataDir);
  console.log(`[Org] Restoring last-active org: ${_startupOrgId} → ${_startupDataDir}`);
}

// Backfill `sessions.owner_user_id` for legacy rows created before
// per-user session ownership existed. The auth migration above has
// already populated the `users` table; we set every NULL session to
// the oldest user (the org owner) so the post-migration boot serves
// the existing transcripts to that user without an empty sidebar.
try {
  resetOrgOwnerCache();
  const { updated } = backfillSessionOwners();
  if (updated > 0) {
    console.log(`[Auth] Backfilled owner_user_id on ${updated} legacy session(s)`);
  }
} catch (err) {
  console.error('[Auth] Failed to backfill session owners:', (err as Error).message);
}

migrateAhwDirectories();
// Auto-seeding Docs/Intake/Reviewer at startup is deprecated alongside the
// sub-agent model (see CLAUDE.md "Flat Agent Model"). We no longer
// retroactively backfill them on existing projects — projects keep
// whatever roster they were created with. `ensureReviewerAgents` is still
// invoked from the GitHub-App / webhook routes when the user explicitly
// wires up GitHub.
ensureContextFiles();

// Pre-create the empty `GH_CONFIG_DIR` reviewer spawns are routed to.
// `applyReviewerSpawnIsolation` resolves the same path; doing the mkdir
// here keeps the first reviewer spawn from racing the directory and
// makes the isolation directory inspectable on disk for operators.
try {
  ensureReviewerGhConfigDir(config);
} catch (err) {
  console.error(
    `[Reviewer] Failed to provision GH_CONFIG_DIR isolation directory: ${(err as Error).message}`,
  );
}

// Sync default + per-project skill dirs to the Claude Code CLI so both
// bundled skills and ClawHub-installed project skills register at startup.
// (Per-install syncs happen in server/routes/clawhub.ts.)
try {
  const projectSkillDirs = getProjects()
    .map((p) => (p.ahw ? path.join(p.ahw, 'skills') : ''))
    .filter((d) => !!d);
  // TODO(skill-gateway): remove after one release once no active sessions rely on the native Skill tool.
  syncSkillsToClaude(projectSkillDirs);
} catch (err) {
  console.warn('[skills] Startup sync failed:', (err as Error).message);
}

// ─── Missing-webhook audit ───────────────────────────────────────────
//
// A project with `githubRepo` set but NO enabled `webhook_configs` row
// will never receive PR events from GitHub — and therefore its
// reviewer agent will never be dispatched and its PRs will be merged
// (or rot) un-reviewed. This loop logs a one-line WARN per offender at
// startup so operators see the gap at a glance instead of debugging
// "why isn't the reviewer firing on this repo".
//
// Best-effort: any failure (db not yet up, prepared statement absent
// during mid-migration boot) is swallowed silently. We never want this
// audit to block the server starting.
try {
  if (stmts) {
    const projectsWithGithubRepo = getProjects().filter((p) => {
      const r = (p as { githubRepo?: string | null }).githubRepo;
      return typeof r === 'string' && r.trim().length > 0;
    });
    for (const project of projectsWithGithubRepo) {
      try {
        const rows = stmts.getWebhookConfigsByProject.all(project.id) as Array<{
          enabled: number | null;
        }>;
        const hasEnabled = rows.some((r) => r?.enabled === 1);
        if (!hasEnabled) {
          console.warn(
            `[ProjectAudit] github_repo=${(project as { githubRepo?: string }).githubRepo} project=${project.id} has no enabled webhook config — PRs from this repo will not be reviewed.`,
          );
        }
      } catch {
        /* per-project lookup failure is not fatal */
      }
    }
  }
} catch (err) {
  console.warn('[ProjectAudit] Startup webhook audit failed:', (err as Error).message);
}

function ensureWorktree(
  session: SessionRow,
  projectCwd: string,
  agentId: string,
  installCommand: string | null,
  prBaseBranch?: string | null,
  /** Optional `Project.repoUrl` for self-healing auto-clone when `projectCwd` is missing / non-git. */
  repoUrl?: string | null,
  /** Project id for error attribution; threaded into worktree errors. */
  projectId?: string,
  /**
   * Fired on the reuse path when origin/<prBaseBranch> has advanced past the
   * worktree's merge-base. Plumbed through from chat.ts so it can post a card
   * comment and augment the next-turn system prompt. Never fires for fresh
   * clones or no-drift cases — see `BaseBranchAdvancedInfo`.
   */
  onBaseBranchAdvanced?: OnBaseBranchAdvancedFn,
  /**
   * `Project.githubRepo` (e.g. `Speakman-ai/agent-hub`). Threaded through
   * for system-spawned sessions (reviewer / autonomous probe with
   * `owner_user_id` NULL) so the token resolver in worktree.ts can pick
   * an Owner whose stored OAuth/PAT actually has access to this repo
   * instead of always falling back to `listUsers()[0]`. See
   * `resolveOwnerWithRepoAccess`.
   */
  githubRepo?: string | null,
): Promise<string> {
  if (isPreviewSetupWizardSession(session) || !sessionUsesWorktree(session)) {
    return Promise.resolve(projectCwd);
  }
  return ensureSessionWorkspace(
    session,
    projectCwd,
    agentId,
    (wsPath: string, branch: string, sid: string) => {
      stmts!.updateSessionWorktreePath.run(wsPath, branch, sid);
    },
    installCommand,
    // Worktree creation failed — surface it loudly. `handleWorktreeFailure`
    // clears `use_worktree`, posts a `role='system'` message into the session
    // (so the agent's next-turn history + the chat UI both see it), comments
    // on the linked kanban card when one exists, and broadcasts both a
    // `message` and `worktree_failed` event. See `server/worktree-failure.ts`
    // for the contract and `worktree-failure.test.ts` for the assertions.
    (sid: string, errorMessage: string) => {
      handleWorktreeFailure({ stmts: stmts!, broadcast }, sid, errorMessage);
    },
    prBaseBranch ?? null,
    repoUrl ?? null,
    projectId,
    onBaseBranchAdvanced,
    githubRepo ?? null,
  );
}

const app = express();
// TRUST_PROXY: 1 = one load-balancer hop (e.g. AWS ALB). Default loopback only.
app.set('trust proxy', trustProxyValueFromEnv());
// CORS is locked to an explicit allowlist driven by ALLOWED_ORIGINS (see
// ./cors-config.ts). The intentionally-public /api/bug-reports endpoint
// installs its own `Access-Control-Allow-Origin: *` middleware in
// ./routes/bug-reports.ts, which overrides this one for that route.
// Reject malformed percent-encoded URLs (e.g. /%c0 from bot scanners)
// before they reach the router, where Express's `decode_param` would
// throw an unhandled `URIError`. See ./uri-error-handler.ts.
app.use(uriDecodeGuard);
app.use(cors(corsOptions));

let _broadcast: BroadcastFn;
function broadcast(data: Record<string, unknown>): void {
  _broadcast(data);
}

// Exported for tests: test/helpers.ts initializes the webhook-worker with
// these deps so `processOnce()` / `drainWebhookQueue()` can drive the queue
// deterministically without starting the real polling interval.
export const webhookHandlerDeps = {
  stmts: stmts!,
  broadcast,
  findAgent,
  handleChat: (ws: unknown, msg: ChatMessage) => handleChat!(ws, msg),
  runClaude,
  tryAutonomousDispatch,
  getProjects,
  getConfig: () => config,
  getGhAuthenticatedUser: () => ghAuthenticatedUser,
  getGhBotUser: () => ghBotUser,
  setGhBotUser: (v: string | null) => {
    ghBotUser = v;
  },
  getGhAppSlug: () => ghAppSlug,
  setGhAppSlug: (v: string | null) => {
    ghAppSlug = v;
  },
} as unknown as RouteDeps;

// GitHub webhook HMAC covers the raw request bytes; mount BEFORE `express.json`
// consumes the stream (routes/webhooks.ts uses `express.raw` internally).
app.use(createGithubWebhookHandler(webhookHandlerDeps));

app.use(
  express.json({
    limit: '20mb',
    verify: (req: Request, _res, buf: Buffer) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.use(createHealthRoute({ allAgents, getProjects, config }));

// Interactive API docs (Swagger UI) at /api/docs. Mounted before
// authMiddleware so self-hosters and unauthenticated visitors can browse
// the API surface — the spec is the same one published from CI, so there's
// nothing private to gate. No client changes required; this is a server-only
// nice-to-have for local dev and self-hosted instances.
app.use(createApiDocsRoutes());

initAutoGit({
  stmts: stmts!,
  broadcast,
  getConfig: () => config,
  DEFAULT_SKILLS_DIR,
});

initDelegation({
  stmts: stmts!,
  broadcast,
  getEnrichedAgent,
  buildEnrichedPrompt,
  get saveErrorMessage() {
    return saveErrorMessage!;
  },
  appendDailyNote,
  getActiveProcesses: () => activeProcesses,
  getClaudeBin: () => CLAUDE_BIN,
  getCursorBin: () => CURSOR_BIN,
  getGeminiBin: () => GEMINI_BIN,
  getCodexBin: () => CODEX_BIN,
  getDefaultModel: () => DEFAULT_MODEL,
  getConfig: () => config,
});

initHandoff({
  stmts: stmts!,
  broadcast,
  getEnrichedAgent,
  findAgent,
  getActiveProcesses: () => activeProcesses,
  getClaudeBin: () => CLAUDE_BIN,
  getDefaultModel: () => DEFAULT_MODEL,
  getConfig: () => config,
  // handleChat is assigned after createChatHandler below, so we read it
  // lazily via a getter.
  getHandleChat: () => handleChat,
});

initRoomChat({
  stmts: stmts!,
  broadcast,
  getEnrichedAgent,
  buildEnrichedPrompt,
  getClaudeBin: () => CLAUDE_BIN,
  getCursorBin: () => CURSOR_BIN,
  getGeminiBin: () => GEMINI_BIN,
  getCodexBin: () => CODEX_BIN,
  getDefaultModel: () => DEFAULT_MODEL,
  getConfig: () => config,
  getMaxQueueSize: () => MAX_QUEUE_SIZE,
});

// Designs live under `<activeDataDir>/designs/`. We ensure the root exists
// at boot so the artifact-dir creation inside createDesign() doesn't race
// against a first-time deploy, and so the static mount can serve its own
// 404s rather than throwing at registration time.
function getDesignsRoot(): string {
  return path.join(_activeDataDir, 'designs');
}
ensureDesignsRoot(getDesignsRoot());

initDesignChat({
  stmts: stmts!,
  broadcast,
  getClaudeBin: () => CLAUDE_BIN,
  getCursorBin: () => CURSOR_BIN,
  getGeminiBin: () => GEMINI_BIN,
  getCodexBin: () => CODEX_BIN,
  getConfig: () => config,
  getDesign: (id: string) => getDesignStore(id, findProject, getActiveOrgId()),
  getDesignsRoot,
  getDefaultSkillsDir: () => DEFAULT_SKILLS_DIR,
});

initAutonomous({
  stmts: stmts!,
  broadcast,
  findProject: findProject as (id: string) => Project | undefined,
  findAgent,
  handleChat: (ws: unknown, msg: ChatMessage) => handleChat!(ws, msg),
  handleCancel,
  getActiveProcesses: () => activeProcesses,
  getProjects,
  getConfig: () => config,
  getGhAuthenticatedUser: () => ghAuthenticatedUser,
  getGhBotUser: () => ghBotUser,
  getGhAppSlug: () => ghAppSlug,
  setGhAppSlug: (v: string | null) => {
    ghAppSlug = v;
  },
  getWebhookHandlerDeps: () => webhookHandlerDeps,
  getDb,
} as Parameters<typeof initAutonomous>[0]);

app.use(
  createWorkflowIncomingRouter({
    stmts: stmts!,
    broadcast,
    getEnrichedAgent,
    findProject,
  }),
);

// (Preview proxy removed — session previews use preview-runtime instead)

app.use(authMiddleware);

// Releases page powers the in-app "What's new" view, only reachable from
// the logged-in sidebar. Mount AFTER authMiddleware so the `?refresh=1`
// bypass cannot be looped by an unauthenticated caller to burn the
// configured GITHUB_TOKEN's rate-limit budget against api.github.com.
app.use(createReleasesRoutes());

const UPLOADS_DIR: string = path.join(__dirname, 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

// Design artifact files: `<dataDir>/designs/<designId>/*` → `/design-files/<designId>/*`.
// Each design's directory is its own mount root so path traversal (../..) can't
// escape into a neighbouring design or out of the designs root entirely. We
// resolve the requested path and verify it lives inside the per-design root
// before handing off to express.static. Express already URL-decodes req.path
// so `%2e%2e` and friends arrive normalized.
app.use('/design-files/:designId', (req: Request, res: Response, next) => {
  const designId = req.params.designId as string;
  // Only allow [A-Za-z0-9-] ids so a malicious path segment (e.g. `..`, a
  // trailing slash, a null byte) can't be laundered through the designId
  // param. uuidv4 output is a strict subset of this alphabet.
  if (!/^[A-Za-z0-9-]+$/.test(designId)) {
    return res.status(400).json({ error: 'Invalid design id' });
  }
  // Verify the design belongs to the caller's org before serving files.
  const design = getDesignStore(designId, findProject, getActiveOrgId());
  if (!design) {
    return res.status(404).json({ error: 'Not found' });
  }
  const root = path.resolve(getDesignsRoot(), designId);
  const requested = path.resolve(root, '.' + (req.path || '/'));
  if (requested !== root && !requested.startsWith(root + path.sep)) {
    return res.status(404).json({ error: 'Not found' });
  }
  return express.static(root, { fallthrough: false })(req, res, next);
});

const CLIENT_DIST: string =
  process.env.AGENT_HUB_SERVE_CLIENT || path.join(__dirname, '..', 'client', 'dist');
if (existsSync(CLIENT_DIST) && existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  app.use(express.static(CLIENT_DIST));
}

// Exported so server tests can inject a fake entry to exercise the
// "session is still streaming" guard on `POST /api/sessions/:id/create-pr`
// without spinning up a real CLI. Production code should keep using the
// existing call sites (`activeProcesses.set` / `.get` / `.delete`) below.
export const activeProcesses = new Map<string, ChildProcess>();

// ─── Preview runtimes ───────────────────────────────────────────────────
//
// Both runtimes share the same SQLite DB so the legacy spawn pool and the
// compose pool see each other's allocated ports through
// `worktree_preview_processes.port UNIQUE`. The compose runtime's
// disk-backed override-file writer lives under `<dataDir>/preview-compose`
// (created on construction with mkdirSync -p semantics).
//
// The reaper is scheduled below the runtime construction so it picks up
// the same instance the chat handler + session archive hooks use; a
// per-tick orphan check tears down rows whose project has been deleted
// out from under them.
const previewHealthHost = process.env.AGENT_HUB_PREVIEW_HEALTH_HOST?.trim();
const previewUrlBase = createPreviewUrlBase(config.publicUrl);
const { previewRuntime, previewComposeRuntime } = createPreviewRuntimes({
  db: getDb(),
  dataDir: _activeDataDir,
  legacyConfig: {
    urlBase: previewUrlBase,
  },
  composeConfig: {
    urlBase: previewUrlBase,
    readyTimeoutMs: config.previewComposeReadyTimeoutMs,
    ...(previewHealthHost
      ? { healthUrlBase: (port: number) => `http://${previewHealthHost}:${port}` }
      : {}),
  },
  notifyLog: ({ sessionId, groupId, processName, line, stream }) => {
    try {
      broadcast({
        type: 'agenthub_preview',
        kind: 'preview_log',
        sessionId,
        previewId: groupId,
        processName,
        line,
        stream,
      } as Record<string, unknown>);
    } catch {
      /* best-effort — never let a broadcast failure stall the spawn */
    }
  },
  // Fires when the background health-check flips a compose group to a
  // terminal state. Without this hook the only path that broadcasts
  // `preview` / `preview_failed` is the chat-handler poll loop in
  // `handlePreviewBlock`, which exits as soon as the chat turn ends. A
  // client that reconnected after `handlePreviewBlock` returned (slow
  // boot, WS drop mid-build) would never see the transition. The
  // runtime owns the truth — broadcast it directly from there.
  notifyStatus: ({ sessionId, groupId, status, port, url, logTail, error }) => {
    try {
      if (status === 'ready') {
        broadcast({
          type: 'agenthub_preview',
          kind: 'preview',
          sessionId,
          previewId: groupId,
          // We don't have the original `<agenthub:preview>` target/route
          // here — the chat-handler call site is the only place that
          // knows them. Use the same generic defaults the WS connect
          // snapshot uses; clients render against `route='/'` already.
          target: 'client',
          route: '/',
          agentReason: '',
          previewUrl: url,
          fullUrl: url,
          port,
          screenshotPath: null,
          logTail,
        } as Record<string, unknown>);
      } else {
        broadcast({
          type: 'agenthub_preview',
          kind: 'preview_failed',
          sessionId,
          previewId: groupId,
          target: 'client',
          route: '/',
          agentReason: '',
          error: error ?? 'preview boot failed',
          logTail,
        } as Record<string, unknown>);
      }
    } catch {
      /* best-effort — same rationale as notifyLog */
    }
  },
});

if (process.env.NODE_ENV !== 'test' && !process.env.AGENT_HUB_TEST_MODE) {
  // Scheduled per the reaper's documented contract — every 60 s, scan
  // `worktree_preview_groups` and tear down idle / orphaned rows. We run
  // both runtimes through the same tick so a compose-mode preview that
  // never received a `touch` (e.g. the WS session dropped) doesn't
  // accumulate.
  //
  // Cross-runtime ownership is enforced at the runtime layer: each
  // runtime's `stopPreview` short-circuits when the row's
  // `compose_project_name` doesn't match its mode (compose runtime
  // skips NULL; legacy runtime skips non-NULL). So both passes scan
  // the same table but only act on the rows they own — a compose-only
  // row passed to the legacy reaper is a guarded no-op rather than a
  // silent `DELETE FROM worktree_preview_groups` that would leak the
  // docker stack.
  cron.schedule(
    PREVIEW_REAPER_CRON,
    () => {
      void runPreviewReaper({
        db: getDb(),
        runtime: previewRuntime,
        getProject: (id) => findProject(id) ?? null,
      }).catch((err) => {
        console.warn('[preview-reaper] tick failed:', (err as Error).message);
      });
      void runPreviewReaper({
        db: getDb(),
        runtime: previewComposeRuntime as unknown as Parameters<
          typeof runPreviewReaper
        >[0]['runtime'],
        getProject: (id) => findProject(id) ?? null,
      }).catch((err) => {
        console.warn('[preview-reaper:compose] tick failed:', (err as Error).message);
      });
    },
    { name: 'preview-reaper' },
  );
}

/** Full route wiring; exported so integration tests can `vi.spyOn(routeDeps, 'broadcast')`. */
export const routeDeps: RouteDeps = {
  stmts: stmts!,
  broadcast,
  findProject,
  findAgent,
  getEnrichedAgent,
  allAgents,
  saveProjects,
  ensureProjectRoom,
  handleChat: (ws: unknown, msg: ChatMessage) => handleChat!(ws, msg),
  pendingReviewComments,
  lastDispatchedReviewId,
  scheduleAutonomousEpic,
  autonomousCrons,
  runAutonomousLoop,
  config,
  getProjects,
  setProjects,
  getGhBotUser: () => ghBotUser,
  setGhBotUser: (v: string | null) => {
    ghBotUser = v;
  },
  getGhAppSlug: () => ghAppSlug,
  setGhAppSlug: (v: string | null) => {
    ghAppSlug = v;
  },
  serverDir: __dirname,
  buildTranscript,
  summarizeTranscript,
  DEFAULT_MODEL,
  activeProcesses,
  getProjectDataDir,
  ensureDocsAgents,
  ensureIntakeAgents,
  ensureReviewerAgents,
  ensureContextFiles,
  getClaudeBin: () => CLAUDE_BIN,
  setClaudeBin: (v: string) => {
    CLAUDE_BIN = v;
  },
  getCursorBin: () => CURSOR_BIN,
  setCursorBin: (v: string) => {
    CURSOR_BIN = v;
  },
  getGeminiBin: () => GEMINI_BIN,
  setGeminiBin: (v: string) => {
    GEMINI_BIN = v;
  },
  getCodexBin: () => CODEX_BIN,
  setCodexBin: (v: string) => {
    CODEX_BIN = v;
  },
  initDb,
  reloadProjects,
  setActiveDataDir: (v: string) => {
    _activeDataDir = v;
  },
  restoreAutonomousCrons,
  scheduleAll,
  getPreviewRuntime: () => previewRuntime,
  getPreviewComposeRuntime: () => previewComposeRuntime,
  provisionSessionWorkspace: async (sessionId: string) => {
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) {
      throw new Error('Session not found');
    }
    const found = findAgent(session.agent_id);
    if (!found) {
      throw new Error('Agent not found');
    }
    const { project, agent } = found;
    const installCommand =
      (project as { commands?: { install?: string | null } }).commands?.install ?? null;
    return ensureWorktree(
      session,
      project.cwd,
      agent.id,
      installCommand,
      null,
      project.repoUrl ?? null,
      project.id,
      undefined,
      project.githubRepo ?? null,
    );
  },
};

// Visibility gate for every project-scoped route. Mounted ahead of all
// project sub-routers so a new `/api/projects/:projectId/<thing>` route
// inherits the check for free. The gate masks unauthorized access as 404
// (not 403) so we don't leak the existence of private projects to
// non-members. DELETE on the project itself is allowed through so the
// route handler can apply its own Owner kill-switch logic.
app.use('/api/projects/:projectId', createProjectVisibilityGate({ findProject }));

app.use(createMemoryRoutes(routeDeps));
app.use(createNoteRoutes(routeDeps));
app.use(createToolErrorRoutes(routeDeps));
app.use(createWikiRoutes(routeDeps));
app.use(createHeartbeatRoutes(routeDeps));
app.use(createCronRoutes(routeDeps));
app.use(createRoomRoutes(routeDeps));
app.use(createDesignRoutes({ ...routeDeps, getDesignsRoot }));
app.use(createSkillRoutes(routeDeps));
app.use(createClawhubRoutes(routeDeps));
app.use(createWebhookRoutes(routeDeps));
app.use(createBoardRoutes(routeDeps));
app.use(createConfigRoutes(routeDeps));
app.use(createSessionRoutes(routeDeps));
app.use(createProjectRoutes(routeDeps));
app.use(createPreviewSecretsRoutes(routeDeps));
app.use(createProjectAwsRoutes(routeDeps));
app.use(createPreviewWizardRoutes(routeDeps));
app.use(
  createPreviewEnvironmentRoutes({
    ...routeDeps,
    getPreviewComposeRuntime: () => previewComposeRuntime,
  }),
);
app.use(
  createPreviewInstancesRoutes({
    ...routeDeps,
    getPreviewComposeRuntime: () => previewComposeRuntime,
    getPreviewRuntime: () => previewRuntime,
  }),
);
app.use(createProvisioningRoutes(routeDeps));
app.use(createAuditRoutes(routeDeps));
app.use(createAgentRoutes(routeDeps));
app.use(createOrgRoutes(routeDeps));
app.use(createDashboardRoutes(routeDeps));
app.use(createUploadRoutes(routeDeps));
app.use(createTranscribeRoutes(routeDeps));
app.use(createMiscRoutes(routeDeps));
app.use(createSlackRoutes(routeDeps));
app.use(createHookRoutes(routeDeps));
app.use(createClaudeAuthRoutes(routeDeps));
app.use(createGeminiAuthRoutes(routeDeps));
app.use(createCursorAuthRoutes(routeDeps));
app.use(createCodexAuthRoutes(routeDeps));
app.use(createPerUserEngineAuthRoutes(routeDeps));
app.use(createThreadRoutes(routeDeps));
app.use(createWorkflowRoutes(routeDeps));
app.use(createEscalationRoutes(routeDeps));
app.use(createInstanceBackupRoutes(routeDeps));
app.use(createIosBuildRoutes(routeDeps));
app.use(createPrActionRoutes(routeDeps));
app.use(createPrListRoutes(routeDeps));
app.use(createPrResolveRoutes(routeDeps));
app.use(createPrNudgeReviewerRoutes(routeDeps));
app.use(createBugReportRoutes(routeDeps));
app.use(
  createAuthRoutes({
    // When a user's last org membership is dropped and the user row is
    // hard-deleted, sweep their private projects. Shared projects are
    // left behind (visibility-permitted to other org members) — only
    // private projects, which would otherwise become unreachable, get
    // removed. See `project-owner-cascade.ts`.
    onUserDeleted: (userId) =>
      cascadeDeleteUserPrivateProjects(
        // `stmts` is initialized by `initDb` long before any HTTP request
        // arrives. Mirrors the non-null assert on `routeDeps.stmts`.
        { stmts: stmts!, getProjects, saveProjects },
        userId,
      ),
  }),
);
app.use(createMcpServerRoutes());
// PR-env settings/provisioning routes and the `pr_env_config` DB row
// were removed as part of the "Strip PR Environments" epic (88367984).
// Worktree previews (per-session, host-side) are the supported preview
// surface.
app.use(createGithubOAuthRoutes(routeDeps));

const server = createServer(app);
const drainingLock = new Set<string>();
const MAX_QUEUE_SIZE = 10;

const { broadcast: _wsBroadcast } = createWebSocket(server, {
  getProjects,
  handleChat: (ws: unknown, msg: ChatMessage) => handleChat!(ws as WebSocketLike | null, msg),
  handleRoomChat: (ws: unknown, msg: RoomChatMessage) =>
    handleRoomChat(ws as WebSocketLike | null, msg),
  handleCancel,
  handleRoomCancel,
  handleDelegationCancel,
  handleDequeue,
  handleEditQueueItem,
  handleRoomDequeue,
  handleDesignChat: (ws: unknown, msg: DesignChatMessage) =>
    handleDesignChat(ws as WebSocketLike | null, msg),
  handleDesignCancel,
  // Hand the compose runtime to the WS connect handler so it can replay
  // active-preview snapshots to (re)connecting clients. Without this,
  // a client that reconnects after the chat-handler broadcast loop has
  // exited never learns that the container became ready.
  getPreviewSnapshotRuntime: () => previewComposeRuntime,
});
_broadcast = _wsBroadcast;
setLogBroadcast(_wsBroadcast);

attachDefaultPreviewProxyUpgrade(server, {
  getSessionPreviewPort: (sessionId) =>
    getSessionPreviewPort(sessionId, {
      getPreviewComposeRuntime: () => previewComposeRuntime,
      getPreviewRuntime: () => previewRuntime,
    }),
});

const chatHandler = createChatHandler({
  broadcast,
  findAgent,
  getEnrichedAgent,
  activeProcesses,
  activeDelegationSessions,
  autonomousProjects,
  getClaudeBin: () => CLAUDE_BIN,
  getCursorBin: () => CURSOR_BIN,
  getGeminiBin: () => GEMINI_BIN,
  getCodexBin: () => CODEX_BIN,
  uploadsDir: UPLOADS_DIR,
  resolveSlashSkill,
  createCursorChat: undefined,
  ensureWorktree,
  drainQueue: (sessionId: string) => drainQueue(sessionId),
  rescheduleCron,
  handleDelegation: handleDelegation as ChatHandlerDeps['handleDelegation'],
  handleDelegationCancel,
  synthesizeResults: synthesizeResults as ChatHandlerDeps['synthesizeResults'],
  parseDelegateBlock,
  getPreviewRuntime: () => previewRuntime,
  getPreviewComposeRuntime: () => previewComposeRuntime,
  autoCommitAndPR,
  tryAutonomousDispatch,
} as ChatHandlerDeps);
handleChat = chatHandler.handleChat as (ws: unknown, msg: ChatMessage) => Promise<void>;
saveErrorMessage = chatHandler.saveErrorMessage;

function handleCancel(sessionId: string): void {
  const proc = activeProcesses.get(sessionId);
  if (proc) {
    killProcessGroup(proc, 'SIGTERM');
  }
  handleDelegationCancel(sessionId);
  stmts!.clearSessionQueue.run(sessionId);
  broadcast({ type: 'queue_updated', sessionId, queue: [] });
}

function handleDequeue(sessionId: string, messageId: string): void {
  stmts!.dequeueMessage.run(messageId);
  broadcast({
    type: 'queue_updated',
    sessionId,
    queue: stmts!.getQueuedMessages.all(sessionId),
  });
}

function handleEditQueueItem(sessionId: string, messageId: string, content: string): void {
  stmts!.updateQueueMessage.run(content, messageId);
  stmts!.updateMessageContent.run(content, messageId);
  broadcast({
    type: 'queue_updated',
    sessionId,
    queue: stmts!.getQueuedMessages.all(sessionId),
  });
  broadcast({
    type: 'queue_item_edited',
    sessionId,
    messageId,
    content,
  });
}

function drainQueue(sessionId: string): void {
  if (activeProcesses.has(sessionId)) return;
  if (activeDelegationSessions.has(sessionId)) return;
  if (drainingLock.has(sessionId)) return;

  drainingLock.add(sessionId);
  try {
    const next = stmts!.getNextQueuedMessage.get(sessionId) as
      | {
          id: string;
          agent_id: string;
          session_id: string;
          content: string;
          attachments: string | null;
        }
      | undefined;
    if (!next) {
      drainingLock.delete(sessionId);
      return;
    }

    stmts!.dequeueMessage.run(next.id);
    broadcast({
      type: 'queue_updated',
      sessionId,
      queue: stmts!.getQueuedMessages.all(sessionId),
    });

    handleChat!(null, {
      type: 'chat',
      agentId: next.agent_id,
      sessionId: next.session_id,
      content: next.content,
      images: next.attachments ? JSON.parse(next.attachments) : undefined,
      _fromQueue: true,
      _existingMsgId: next.id,
    });
  } finally {
    drainingLock.delete(sessionId);
  }
}

interface OrphanedTaskRow extends ActiveTaskRow {
  streamed_output: string;
  prompt: string;
}

interface ResumeEntry {
  sessionId: string;
  agentId: string;
  content: string;
}

function reconcileOrphanedTasks(): ResumeEntry[] {
  let orphans: OrphanedTaskRow[] = [];
  try {
    orphans = stmts!.getAllActiveTasks.all() as OrphanedTaskRow[];
  } catch {
    return [];
  }
  if (orphans.length === 0) return [];
  console.log(`Reconciling ${orphans.length} orphaned task(s) from prior run`);

  const toResume: ResumeEntry[] = [];

  for (const t of orphans) {
    const partial = (t.streamed_output || '').trim();

    let isAutonomousCard = false;
    try {
      const card = stmts!.getKanbanCardBySession.get(t.session_id) as KanbanCardRow | undefined;
      if (card && card.epic_id) {
        isAutonomousCard = true;
        const col = stmts!.getKanbanColumn.get(card.column_id) as KanbanColumnRow | undefined;
        if (col) {
          const cols = stmts!.getKanbanColumns.all(col.board_id) as KanbanColumnRow[];
          const todoCol = cols.find((c) => c.name.toLowerCase() === 'to do');
          if (todoCol) {
            stmts!.moveKanbanCard.run(todoCol.id, 0, card.id);
          }
        }
        stmts!.updateKanbanCard.run(
          card.title,
          card.description,
          card.priority,
          null,
          card.labels,
          null,
          card.github_issue_url,
          card.pr_url,
          card.epic_id,
          card.assign_model ?? null,
          card.assign_engine ?? null,
          card.pr_base_branch ?? null,
          card.id,
        );
        console.log(
          `[Autonomous] Reset orphaned card "${card.title}" back to To Do for re-dispatch`,
        );
        const suffix = partial ? `\n\nPartial output before interruption:\n${partial}` : '';
        saveErrorMessage!(
          t.session_id,
          t.message_id,
          t.engine,
          t.model ?? '',
          `Task interrupted by server restart.${suffix}`,
        );
      }
    } catch (err) {
      console.error(
        `[Autonomous] Failed to reset card for session ${t.session_id}:`,
        (err as Error).message,
      );
    }

    if (isAutonomousCard) continue;

    const session = stmts!.getSession.get(t.session_id) as SessionRow | undefined;
    if (!session) {
      console.log(`[Resume] Session ${t.session_id} no longer exists, skipping`);
      continue;
    }

    const infoMsgId: string = uuidv4();
    const infoText: string = partial
      ? `ℹ️ Session interrupted by server restart. Resuming automatically…\n\nPartial output before interruption:\n${partial}`
      : 'ℹ️ Session interrupted by server restart. Resuming automatically…';
    try {
      stmts!.addMessage.run(
        infoMsgId,
        t.session_id,
        'assistant',
        infoText,
        t.engine,
        t.model,
        null,
        null,
      );
      stmts!.touchSession.run(t.session_id);
    } catch (err) {
      console.error(
        `[Resume] Failed to save info message for session ${t.session_id}:`,
        (err as Error).message,
      );
    }

    let resumeContent: string;
    if (session.engine_session_id) {
      resumeContent =
        'The server restarted while you were working. Please continue where you left off. If you were in the middle of a task, pick up from where you stopped.';
    } else {
      resumeContent = t.prompt || 'The server restarted. Please continue where you left off.';
    }

    toResume.push({
      sessionId: t.session_id,
      agentId: t.agent_id,
      content: resumeContent,
    });

    const worktreeGone: boolean = !!session.worktree_path && !existsSync(session.worktree_path);
    console.log(
      `[Resume] Will resume session ${t.session_id} (agent: ${t.agent_id}, hasEngineSession: ${!!session.engine_session_id}${worktreeGone ? ', worktree missing — cross-worktree resume' : ''})`,
    );
  }

  try {
    stmts!.deleteAllActiveTasks.run();
  } catch {}

  try {
    stmts!.deleteAllActiveRoomTasks.run();
  } catch {}

  return toResume;
}

function resumeOrphanedSessions(toResume: ResumeEntry[]): void {
  if (!toResume || toResume.length === 0) return;

  const RESUME_DELAY_MS = 5000;
  console.log(`[Resume] Will resume ${toResume.length} session(s) in ${RESUME_DELAY_MS / 1000}s`);

  setTimeout(async () => {
    broadcast({
      type: 'sessions_resuming',
      count: toResume.length,
      sessionIds: toResume.map((r) => r.sessionId),
    });

    for (const { sessionId, agentId, content } of toResume) {
      console.log(`[Resume] Resuming session ${sessionId}`);
      try {
        await handleChat!(null, { type: 'chat', agentId, sessionId, content });
      } catch (err) {
        console.error(`[Resume] Failed to resume session ${sessionId}:`, (err as Error).message);
        saveErrorMessage!(
          sessionId,
          uuidv4(),
          'claude-code',
          '',
          `Failed to resume session after server restart: ${(err as Error).message}`,
        );
      }
    }
  }, RESUME_DELAY_MS);
}

if (CLIENT_DIST && existsSync(CLIENT_DIST)) {
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// Final error-handling middleware. Catches URIError raised from inside
// the router's `decode_param` (defense in depth — `uriDecodeGuard`
// above should already have rejected these). Other errors fall through
// to Express's default handler, preserving existing behavior.
app.use(uriErrorHandler);

export { app, server };

if (!process.env.AGENT_HUB_TEST_MODE) {
  // Capture the login shell's PATH up-front so the first spawn already sees
  // everything the shell rc files expose (aws, gh, nvm shims, etc.). Running
  // this synchronously at startup trades ~50–200ms of boot time for one fewer
  // surprise when a new CLI is installed before the first agent spawn.
  // refreshShellPath() catches internally and falls back to FALLBACK_DIRS on
  // failure, so this cannot throw in practice.
  const shellPath = refreshShellPath();
  console.log(`[shell-path] Captured spawn PATH from ${shellPath.source}`);

  // SIGTERM/SIGINT → drain spawned CLI children before exit, so pm2 restarts
  // (e.g. max_memory_restart) don't reparent in-flight claudes to init.
  installShutdownHandlers();

  server.listen(PORT, '0.0.0.0', () => {
    const actualPort = (server.address() as AddressInfo).port;
    setActualPort(actualPort);
    console.log(`Agent Hub server running on http://localhost:${actualPort}`);
    console.log(`Loaded ${getProjects().length} projects, ${allAgents().length} agents`);

    const sessionsToResume: ResumeEntry[] = reconcileOrphanedTasks();

    for (const project of getProjects()) {
      try {
        ensureProjectRoom(project);
      } catch (err) {
        console.error(`Failed to ensure room for project ${project.id}:`, (err as Error).message);
      }
    }

    try {
      const queuedSessions = stmts!.getAllQueuedSessions.all() as Array<{ session_id: string }>;
      for (const { session_id } of queuedSessions) {
        const task = stmts!.getActiveTask.get(session_id);
        if (!task) drainQueue(session_id);
      }
    } catch {}

    scheduleAll(allAgents());

    try {
      failStuckWorkflowRunsOnBoot(stmts!);
    } catch (e) {
      console.error('[workflow] failStuckWorkflowRunsOnBoot', (e as Error).message);
    }

    try {
      refreshWorkflowCronSchedules(
        { stmts: stmts!, broadcast, getEnrichedAgent, findProject },
        null,
      );
    } catch (e) {
      console.error('[workflow-cron] refresh on boot', (e as Error).message);
    }

    restoreAutonomousCrons();

    startReviewPollingFallback();

    setOnCronSessionUpdate((info: Record<string, unknown>) => {
      broadcast(info);
    });
    setBroadcast(broadcast);

    startSlack(allAgents(), stmts!).catch((err: Error) => {
      console.error('Failed to start Slack bots:', err.message);
    });

    // Periodic reminder for sessions stuck in "changes awaiting PR creation".
    // Guarded under NODE_ENV so tests don't leak intervals or fire pushes.
    if (process.env.NODE_ENV !== 'test') {
      startStalePrChecker({
        stmts: stmts!,
        broadcast,
        getAgent: (agentId: string) => {
          const found = findAgent(agentId);
          if (!found) return null;
          return { name: found.agent.name, projectId: found.project.id };
        },
      });

      // Stale-PR conflict / CI / changes-requested sweep. Re-uses the
      // existing `POST /api/projects/:id/pulls/:number/resolve` route over
      // loopback so we don't duplicate any of pr-resolve.ts's spawn logic.
      // The route is auth-gated; we authenticate with the deployment's
      // global API key (Owner-equivalent). Operators that disable the
      // global apiKey get no poller — fine; webhook-driven autofix
      // continues to work, just without the safety net.
      const systemApiKey = config.apiKey;
      if (systemApiKey) {
        const baseUrl = `http://127.0.0.1:${actualPort}`;
        startPrRebasePoll({
          stmts: stmts!,
          broadcast,
          triggerResolve: async ({
            projectId,
            prNumber,
            agentId,
          }): Promise<TriggerResolveResult> => {
            const url = `${baseUrl}/api/projects/${encodeURIComponent(
              projectId,
            )}/pulls/${prNumber}/resolve`;
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-api-key': systemApiKey,
              },
              body: JSON.stringify({ agentId }),
            });
            const body = (await res.json().catch(() => ({}))) as {
              sessionId?: string | null;
              triggered?: string[];
              reason?: string;
              error?: string;
            };
            if (!res.ok && res.status !== 201) {
              throw new Error(body?.error ?? `pr-resolve responded ${res.status}`);
            }
            return {
              sessionId: body.sessionId ?? null,
              triggered: Array.isArray(body.triggered) ? body.triggered : [],
              reason: body.reason,
            };
          },
        });
      } else {
        console.log(
          '[pr-rebase-poll] Skipping startup — no global AGENT_HUB_API_KEY configured (webhook-driven autofix still active).',
        );
      }
    }

    initIosBuildEngine({ stmts: stmts!, broadcast });
    initWebhookWorker({ stmts: stmts!, routeDeps: webhookHandlerDeps });

    resumeOrphanedSessions(sessionsToResume);
  });
}
