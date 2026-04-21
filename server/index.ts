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
import { stmts, initDb } from './db.js';
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
import { appendDailyNote } from './memory.js';
import config from './config.js';
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
import { ensureSessionWorkspace } from './worktree.js';

import createNoteRoutes from './routes/notes.js';
import createToolErrorRoutes from './routes/tool-errors.js';
import createWikiRoutes from './routes/wiki.js';
import createHeartbeatRoutes from './routes/heartbeats.js';
import createCronRoutes from './routes/crons.js';
import createPoolRoutes from './routes/pool.js';
import createMemoryRoutes from './routes/memory.js';
import createRoomRoutes from './routes/rooms.js';
import createDesignRoutes from './routes/designs.js';
import createSkillRoutes, { DEFAULT_SKILLS_DIR } from './routes/skills.js';
import createClawhubRoutes from './routes/clawhub.js';
import createWebhookRoutes, {
  createGithubWebhookHandler,
  pendingReviewComments,
} from './routes/webhooks.js';
import createBoardRoutes from './routes/board.js';
import createConfigRoutes from './routes/config.js';
import createSessionRoutes, { summarizeTranscript, buildTranscript } from './routes/sessions.js';
import createProjectRoutes from './routes/projects.js';
import createAgentRoutes from './routes/agents.js';
import createOrgRoutes from './routes/orgs.js';
import createDashboardRoutes from './routes/dashboard.js';
import createUploadRoutes from './routes/uploads.js';
import createTranscribeRoutes from './routes/transcribe.js';
import createMiscRoutes, { createHealthRoute } from './routes/misc.js';
import createHookRoutes from './routes/hooks.js';
import createClaudeAuthRoutes from './routes/claude-auth.js';
import createThreadRoutes from './routes/threads.js';
import createEscalationRoutes from './routes/escalations.js';
import createCaptureRoutes, { createCaptureGlobalRoutes } from './routes/captures.js';
import createIosBuildRoutes from './routes/ios-builds.js';
import { initIosBuildEngine } from './ios-build-engine.js';
import { initCaptureEngine } from './capture-engine.js';
import { initWebhookWorker } from './webhook-worker.js';
import createPrActionRoutes from './routes/pr-actions.js';
import createPrListRoutes from './routes/pr-list.js';
import createPrResolveRoutes from './routes/pr-resolve.js';
import createBugReportRoutes from './routes/bug-reports.js';
import createAuthRoutes from './routes/auth.js';
import createPrEnvSettingsRoutes from './routes/pr-env-settings.js';
import { migrateFileConfigToDb as migratePrEnvFileToDb } from './pr-env-store.js';
import { fileConfig as prEnvFileConfig } from './config.js';
import createGithubOAuthRoutes from './routes/github-oauth.js';

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

if (config.botGithubToken) {
  execAsync(`gh api user --jq ".login"`, {
    env: { ...process.env, GH_TOKEN: config.botGithubToken },
  })
    .then(({ stdout }) => {
      ghBotUser = stdout.trim();
      console.log(`[GitHub Bot] Bot account detected: ${ghBotUser}`);
    })
    .catch((err: Error) => {
      console.warn(
        `[GitHub Bot] Could not detect bot user — token may be invalid: ${err.message?.split('\n')[0]}`,
      );
    });
}

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

migrateAhwDirectories();
ensureDocsAgents();
ensureIntakeAgents();
ensureReviewerAgents();
ensureContextFiles();

function ensureWorktree(
  session: SessionRow,
  projectCwd: string,
  agentId: string,
  installCommand: string | null,
): string {
  return ensureSessionWorkspace(
    session,
    projectCwd,
    agentId,
    (wsPath: string, branch: string, sid: string) => {
      stmts!.updateSessionWorktreePath.run(wsPath, branch, sid);
    },
    installCommand,
    // Worktree creation failed — surface it instead of silently letting the
    // session fall back onto the main project repo. Flipping use_worktree to
    // 0 stops subsequent turns from retrying (and masking the failure) and
    // makes downstream behavior (auto-git skipping, edits landing in the main
    // repo) explicit rather than a surprise. Broadcasting `worktree_failed`
    // gives the UI a hook to warn the user that isolation was lost.
    (sid: string, errorMessage: string) => {
      try {
        stmts!.updateSessionWorktree.run(0, sid);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[worktree] Failed to clear use_worktree for session ${sid} after worktree failure: ${message}`,
        );
      }
      try {
        broadcast({
          type: 'worktree_failed',
          sessionId: sid,
          error: errorMessage,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[worktree] Failed to broadcast worktree_failed for session ${sid}: ${message}`,
        );
      }
    },
  );
}

const app = express();
// We run behind nginx on localhost:3051 (see Deployment section of
// CLAUDE.md). Trust only the loopback proxy so `req.ip` resolves to the
// original client via X-Forwarded-For — required for per-IP rate
// limiting on login/invite-accept to work correctly. 'loopback' is the
// safest setting: we don't blindly trust arbitrary upstream proxies.
// NOTE: if we ever move behind ALB/Cloudflare/etc, revisit this value —
// 'loopback' will drop the forwarded IP in that topology and per-IP
// limits will collapse to the edge-proxy's IP.
app.set('trust proxy', 'loopback');
// CORS is locked to an explicit allowlist driven by ALLOWED_ORIGINS (see
// ./cors-config.ts). The intentionally-public /api/bug-reports endpoint
// installs its own `Access-Control-Allow-Origin: *` middleware in
// ./routes/bug-reports.ts, which overrides this one for that route.
app.use(cors(corsOptions));
app.use(
  express.json({
    limit: '20mb',
    verify: (req: Request, _res, buf: Buffer) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.use(createHealthRoute({ allAgents, getProjects, config }));

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
  buildEnrichedPrompt: buildEnrichedPrompt as (agent: import('./types.js').EnrichedAgent) => string,
  get saveErrorMessage() {
    return saveErrorMessage!;
  },
  appendDailyNote,
  getActiveProcesses: () => activeProcesses,
  getClaudeBin: () => CLAUDE_BIN,
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
  getDefaultModel: () => DEFAULT_MODEL,
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
} as Parameters<typeof initAutonomous>[0]);

app.use(createGithubWebhookHandler(webhookHandlerDeps));

// (Preview proxy removed — replaced by lightweight Playwright captures)

app.use(authMiddleware);

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

const activeProcesses = new Map<string, ChildProcess>();

const routeDeps: RouteDeps = {
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
  lastDispatchedReviewId: lastDispatchedReviewId as unknown as Map<string, string>,
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
  getClaudeBin: () => CLAUDE_BIN,
  setClaudeBin: (v: string) => {
    CLAUDE_BIN = v;
  },
  initDb,
  reloadProjects,
  setActiveDataDir: (v: string) => {
    _activeDataDir = v;
  },
  restoreAutonomousCrons,
  scheduleAll,
};

app.use(createMemoryRoutes(routeDeps));
app.use(createNoteRoutes(routeDeps));
app.use(createToolErrorRoutes(routeDeps));
app.use(createWikiRoutes(routeDeps));
app.use(createHeartbeatRoutes(routeDeps));
app.use(createCronRoutes(routeDeps));
app.use(createPoolRoutes(routeDeps));
app.use(createRoomRoutes(routeDeps));
app.use(createDesignRoutes({ ...routeDeps, getDesignsRoot }));
app.use(createSkillRoutes(routeDeps));
app.use(createClawhubRoutes(routeDeps));
app.use(createWebhookRoutes(routeDeps));
app.use(createBoardRoutes(routeDeps));
app.use(createConfigRoutes(routeDeps));
app.use(createSessionRoutes(routeDeps));
app.use(createProjectRoutes(routeDeps));
app.use(createAgentRoutes(routeDeps));
app.use(createOrgRoutes(routeDeps));
app.use(createDashboardRoutes(routeDeps));
app.use(createUploadRoutes(routeDeps));
app.use(createTranscribeRoutes(routeDeps));
app.use(createMiscRoutes(routeDeps));
app.use(createHookRoutes(routeDeps));
app.use(createClaudeAuthRoutes(routeDeps));
app.use(createThreadRoutes(routeDeps));
app.use(createEscalationRoutes(routeDeps));
// `/api/captures/status` is the only non-project-scoped endpoint — everything
// else must know which project it belongs to. Keeping these on separate routers
// prevents accidental matches like `POST /api/captures` (which would have no
// projectId and fail the NOT NULL on pr_captures.project_id).
app.use('/api/captures', createCaptureGlobalRoutes());
app.use('/api/projects/:projectId/captures', createCaptureRoutes(routeDeps));
app.use(createIosBuildRoutes(routeDeps));
app.use(createPrActionRoutes(routeDeps));
app.use(createPrListRoutes(routeDeps));
app.use(createPrResolveRoutes(routeDeps));
app.use(createBugReportRoutes(routeDeps));
app.use(createAuthRoutes());
app.use(createPrEnvSettingsRoutes(routeDeps));
app.use(createGithubOAuthRoutes(routeDeps));

// One-shot migration: copy legacy `config.json` prEnv block into the new
// pr_env_config DB row when the row doesn't exist yet. Idempotent after
// the first successful run. Logged so the operator knows the UI is now
// the source of truth.
try {
  const migrated = migratePrEnvFileToDb(prEnvFileConfig);
  if (migrated) {
    console.log('[pr-env] Migrated legacy config.json prEnv block → pr_env_config DB row');
  }
} catch (err) {
  console.error('[pr-env] Failed to migrate legacy prEnv block into DB:', (err as Error).message);
}

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
});
_broadcast = _wsBroadcast;
setLogBroadcast(_wsBroadcast);

const chatHandler = createChatHandler({
  broadcast,
  findAgent,
  getEnrichedAgent,
  activeProcesses,
  activeDelegationSessions,
  autonomousProjects,
  getClaudeBin: () => CLAUDE_BIN,
  getCursorBin: () => CURSOR_BIN,
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
  autoCommitAndPR,
  tryAutonomousDispatch,
} as ChatHandlerDeps);
handleChat = chatHandler.handleChat as (ws: unknown, msg: ChatMessage) => Promise<void>;
saveErrorMessage = chatHandler.saveErrorMessage;

function handleCancel(sessionId: string): void {
  const proc = activeProcesses.get(sessionId);
  if (proc) {
    proc.kill('SIGTERM');
  }
  handleDelegationCancel(sessionId);
  activeDelegationSessions.delete(sessionId);
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

export { app, server };

if (!process.env.AGENT_HUB_TEST_MODE) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Agent Hub server running on http://localhost:${PORT}`);
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
    }

    initIosBuildEngine({ stmts: stmts!, broadcast });
    initCaptureEngine({ stmts: stmts!, broadcast, uploadsDir: UPLOADS_DIR });
    initWebhookWorker({ stmts: stmts!, routeDeps: webhookHandlerDeps });

    resumeOrphanedSessions(sessionsToResume);
  });
}
