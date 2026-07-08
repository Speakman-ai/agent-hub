import { installLogCapture, setLogBroadcast } from './server-log.js';
installLogCapture(); // Must be first — captures all subsequent console output

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
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
import { MAX_RESUME_ATTEMPTS, shouldGiveUpAutoResume } from './resume-attempts.js';
import { createGitSmartHttpRoutes } from './git-host/smart-http.js';
import createGitHostRoutes from './routes/git-host.js';
import createSecurityAuditRoutes from './routes/security-audit.js';
import createCiRunsRoutes from './routes/ci-runs.js';
import createPullsNativeRoutes from './routes/pulls-native.js';
import { refreshGitHostNotifyConfigs } from './git-host/lifecycle.js';
import { hostedBarePathForProject } from './git-host/repo-store.js';
import { notifyMirrorPush } from './git-host/mirror.js';
import { startMirrorReconcilePoller } from './git-host/reconcile.js';
import {
  maybeRunPushCi,
  maybeRunPrCi,
  handleHostedRepoPush,
  setChecksPassedHook,
} from './git-host/push-ci.js';
import { maybeRunPushSecurityScan } from './security-audit/on-push.js';
import { startScheduledSecurityScanner } from './security-audit/scheduled-scan.js';
import { recordRecentPush } from './git-host/recent-pushes.js';
import { createNativePrService } from './native-pr/service.js';
import { maybeRunPrAutoReview } from './native-pr/auto-review.js';
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
  resolveProjectSkillsDir,
  saveProjects,
  reloadProjects,
  ensureDocsAgents,
  retireIntakeAgents,
  ensureSkillBuilderAgents,
  ensureReviewerAgents,
  ensureContextFiles,
  migrateProjectSkillDirectories,
} from './project-model.js';
import { backfillSkillBuilderAgents } from './migrations/backfill-skill-builder-agents.js';
import {
  scheduleAll,
  rescheduleCron,
  setOnCronSessionUpdate,
  setBroadcast,
  runClaude,
} from './heartbeat.js';
import { startSlack } from './slack.js';
import { startStalePrChecker } from './stale-pr-check.js';
import {
  startReplayRetentionSweeper,
  RETENTION_SWEEP_INTERVAL_MS,
} from './replays/replay-retention-sweeper.js';
import { startRumSegmentRetentionSweeper } from './replays/rum-segment-retention-sweeper.js';
import { collectRetentionOverrides } from './replays/replay-config.js';
import {
  createRumLifecycleState,
  reconcileRumLifecycle,
} from './replays/rum-lifecycle-reconciler.js';
import { appendDailyNote } from './memory.js';
import config, { refreshShellPath } from './config.js';
import { ensureReviewerGhConfigDir } from './spawn-github-credentials.js';
import { authMiddleware } from './auth.js';
import { initOrgsDb, orgDataDir, getActiveOrgId } from './orgs.js';
import { migrateAuthRecordIfNeeded } from './users-store.js';
import { maybeAutoProvisionOwner } from './auth-bootstrap.js';
import { sessionUsesWorktree } from './project-mode.js';
import { ensureSessionWorkspace, type OnBaseBranchAdvancedFn } from './worktree.js';
import { handleWorktreeFailure } from './worktree-failure.js';
import { installShutdownHandlers } from './process-groups.js';
import { markSessionTermination } from './process-termination.js';
import { cancelSessionChatRun } from './session-chat-cancel.js';

import { trustProxyValueFromEnv } from './trust-proxy.js';
import { uriDecodeGuard, uriErrorHandler } from './uri-error-handler.js';
import { publicCorsErrorHandler } from './public-cors-error-handler.js';
import { jsonBodyErrorHandler } from './json-body-error-handler.js';
import createNoteRoutes from './routes/notes.js';
import createToolErrorRoutes from './routes/tool-errors.js';
import createWikiRoutes from './routes/wiki.js';
import createCodeRagRoutes from './routes/code-rag.js';
import createHeartbeatRoutes from './routes/heartbeats.js';
import createCronRoutes from './routes/crons.js';
import createMemoryRoutes from './routes/memory.js';
import createDesignRoutes from './routes/designs.js';
import createSkillRoutes, { DEFAULT_SKILLS_DIR, syncSkillsToClaude } from './routes/skills.js';
import { resolveGlobalSkillsDir } from './global-skills-dir.js';
import createSkillEvalRoutes from './routes/skill-evals.js';
import createBoardRoutes from './routes/board.js';
import createConfigRoutes from './routes/config.js';
import createSessionRoutes, { summarizeTranscript, buildTranscript } from './routes/sessions.js';
import createProjectRoutes from './routes/projects.js';
import { createProjectVisibilityGate } from './project-visibility-middleware.js';
import { cascadeDeleteUserPrivateProjects } from './project-owner-cascade.js';
import createPreviewSecretsRoutes from './routes/preview-secrets.js';
import createProjectAwsRoutes from './routes/project-aws.js';
import createPreviewWizardRoutes from './routes/preview-wizard.js';
import createRumWizardRoutes from './routes/rum-wizard.js';
import createRumClientRoutes from './routes/rum-clients.js';
import createPreviewEnvironmentRoutes from './routes/preview-environment.js';
import createPreviewInstancesRoutes from './routes/preview-instances.js';
import createProvisioningRoutes from './routes/provisioning.js';
import createAuditRoutes from './routes/audit.js';
import createAgentRoutes from './routes/agents.js';
import createOrgRoutes from './routes/orgs.js';
import createDashboardRoutes from './routes/dashboard.js';
import createUploadRoutes from './routes/uploads.js';
import createArtifactRoutes from './routes/artifacts.js';
import createTranscribeRoutes from './routes/transcribe.js';
import createMiscRoutes, { createHealthRoute } from './routes/misc.js';
import createReleasesRoutes from './routes/releases.js';
import { createApiDocsRoutes } from './routes/api-docs.js';
import createHookRoutes from './routes/hooks.js';
import createGeminiAuthRoutes from './routes/gemini-auth.js';
import createPerUserEngineAuthRoutes from './routes/per-user-engine-auth.js';
import createThreadRoutes from './routes/threads.js';
import createWorkflowRoutes from './routes/workflows.js';
import { failStuckWorkflowRunsOnBoot } from './workflow-runner.js';
import { failStuckFinalizeRunsOnBoot } from './finalize/boot-recovery.js';
import {
  retriggerInterruptedFinalizeRunsOnBoot,
  type InterruptedFinalizeRun,
} from './finalize/boot-retrigger.js';
import { createWorkflowIncomingRouter, refreshWorkflowCronSchedules } from './workflow-triggers.js';
import createSlackRoutes from './routes/slack.js';
import createEscalationRoutes from './routes/escalations.js';
import createSupportTicketRoutes from './routes/support-tickets.js';
import createSupportTicketsOverviewRoutes from './routes/support-tickets-overview.js';
import createFinalizeRoutes from './routes/finalize.js';
import createFinalizeParityRoutes from './routes/finalize-parity.js';
import createFinalizeQuarantineRoutes from './routes/finalize-quarantine.js';
import createFinalizeWizardRoutes from './routes/finalize-wizard.js';
import createDeploymentRoutes from './routes/deployments.js';
import { recoverInFlightDeployments } from './deploy/deploy-orchestrator.js';
import { prepareDeploymentCheckout } from './deploy/deployment-checkout.js';
import { maybeRunDeployTriggers } from './deploy/deploy-trigger-hook.js';
import { initDeploySchedules } from './deploy/deploy-schedule-ticker.js';
import createReleaseNotificationSettingsRoutes from './routes/release-notification-settings.js';
import createRunnerRoutes from './finalize/runner-routes.js';
import { recordJobResourceSummary } from './finalize/metrics.js';
import { startFleetScaler } from './finalize/runner-fleet-scaler.js';
import createInstanceBackupRoutes from './routes/instance-backup.js';
import createIosBuildRoutes from './routes/ios-builds.js';
import { initIosBuildEngine } from './ios-build-engine.js';
import createPrActionRoutes from './routes/pr-actions.js';
import createPrListRoutes from './routes/pr-list.js';
import createPrResolveRoutes from './routes/pr-resolve.js';
import createBugReportRoutes from './routes/bug-reports.js';
import createReplayRoutes from './routes/replays.js';
import createReplaysDashboardRoutes from './routes/replays-dashboard.js';
import createReplayPlaylistRoutes from './routes/replay-playlists.js';
import createRumSessionsRoutes from './routes/rum-sessions.js';
import createAuthRoutes from './routes/auth.js';
import createMcpServerRoutes from './routes/mcp-servers.js';
import createMeTodosRoutes from './routes/me-todos.js';
import createMeDashboardRoutes from './routes/me-dashboard.js';
import createGithubOAuthRoutes from './routes/github-oauth.js';
import createGoogleOAuthRoutes from './routes/google-oauth.js';
import createGoogleCalendarRoutes from './routes/google-calendar.js';
import createGoogleGmailRoutes from './routes/google-gmail.js';
import createGoogleSheetsRoutes from './routes/google-sheets.js';
import createGoogleDriveRoutes from './routes/google-drive.js';
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
import { drainIdleQueuedSessions } from './session-chat-busy.js';

import { initHandoff } from './handoff.js';

import { handleMultiAgentCancel } from './session-multi-agent.js';

import { initDesignChat, handleDesignChat, handleDesignCancel } from './design-chat.js';
import { ensureDesignsRoot, getDesign as getDesignStore } from './designs-store.js';
import { createSessionDesignFilesHandler } from './session-files-mount.js';

import {
  initAutoGit,
  autoCommitAndPR,
  resolveSlashSkill,
  setTriggerAutoSessionShip,
  resolveUserGithubToken,
} from './auto-git.js';
import {
  triggerSessionShip,
  type TriggerSessionShipArgs,
  markSessionFinalizeAutomation,
} from './session-ship.js';
import { setReadyToPushAutomationHook } from './finalize/orchestrator.js';
import {
  maybeAutoPushReadyFinalizeRun,
  maybeAutoMergeAfterChecks,
  setFinalizeAutomationRouteDeps,
} from './finalize/automation-runner.js';

import createChatHandler, {
  buildEnrichedPrompt,
  type ChatHandlerDeps,
  type WebSocketLike,
} from './chat.js';

import { createPreviewRuntimes } from './preview/preview-runtime-setup.js';
import { createPreviewUrlBase } from './preview/preview-public-url.js';
import { attachDefaultPreviewProxyUpgrade } from './preview/preview-proxy.js';
import { parsePreviewSubdomainHost } from './preview/preview-subdomain-host.js';
import { getSessionPreviewPort } from './preview/session-preview-port.js';
import { runPreviewReaper, PREVIEW_REAPER_CRON } from './preview/preview-reaper.js';
import { runFinalizeReaper, FINALIZE_REAPER_CRON } from './finalize/finalize-reaper.js';
import { runStuckRunReaper, STUCK_RUN_REAPER_CRON } from './finalize/stuck-run-reaper.js';
import {
  runRunnerJobLogReaper,
  RUNNER_JOB_LOG_REAPER_CRON,
} from './finalize/runner-job-log-reaper.js';
import {
  RELEASE_NOTIFICATION_OUTBOX_WORKER_CRON,
  runReleaseNotificationOutboxWorker,
} from './release-notification-worker.js';
import { resolveDockerAvailability } from './docker-availability.js';
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
} from './autonomous.js';

import type {
  BroadcastFn,
  RouteDeps,
  ChatMessage,
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
let GROK_BIN: string = config.grokBin;

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
    console.warn('[GitHub] Could not detect gh CLI user');
  });

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

// Legacy NULL-owner sessions are intentionally NOT backfilled to any user:
// AI auth and session ownership are strictly per-account, with no org-owner
// fallback. Such rows belong to nobody and are not auto-granted on upgrade.

migrateAhwDirectories();
migrateProjectSkillDirectories();
// Auto-seeding Docs/Intake/Reviewer at startup is deprecated alongside the
// sub-agent model (see CLAUDE.md "Flat Agent Model"). We no longer
// retroactively backfill them on existing projects — projects keep
// whatever roster they were created with. `ensureReviewerAgents` is still
// invoked when a project is wired up to GitHub so the Finalize review
// phase has a reviewer agent to spawn.
ensureContextFiles();
// Retirement sweep: "Ticket Intake" agents (role: 'intake') are decommissioned
// platform-wide. Unlike the deprecated-but-passive seeders above, this actively
// PURGES any legacy intake agent still persisted in an existing project's
// roster (plus its child DB rows + workspace), so projects created before
// retirement stop exposing and running their old Ticket Intake agent. Runs
// every boot — idempotent and self-healing (a no-op once none remain).
retireIntakeAgents();
// Exception to the no-backfill rule: Agent Hub-HOSTED projects need the
// Reviewer (Finalize review phase + native PR reviews), and hosting can
// be enabled at any time — seed any hosted project that is missing one.
ensureReviewerAgents({ onlyHosted: true });

// One-time (per-org) backfill of the per-project Skill Builder coach into
// projects that predate the feature, so the web Skills page's "Build a skill"
// button appears for them. Marker-guarded — runs once and never resurrects a
// coach a user later deletes. The org-switch path runs the same backfill for
// every other org the first time it becomes active. See
// migrations/backfill-skill-builder-agents.ts.
try {
  backfillSkillBuilderAgents({
    dataDir: _activeDataDir,
    ensureSkillBuilderAgents: () => ensureSkillBuilderAgents(),
  });
} catch (err) {
  // Best-effort migration — never let a seeding/marker hiccup crash boot.
  console.warn(
    '[Skill Builder] startup backfill skipped:',
    err instanceof Error ? err.message : String(err),
  );
}

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

// Sync default + global + per-project skill dirs to the Claude Code CLI so
// bundled, global (shared), and per-project skills register at startup.
try {
  const projectSkillDirs = getProjects()
    .map((p) => resolveProjectSkillsDir(p))
    .filter((d) => !!d);
  // TODO(skill-gateway): remove after one release once no active sessions rely on the native Skill tool.
  syncSkillsToClaude([resolveGlobalSkillsDir(), ...projectSkillDirs]);
} catch (err) {
  console.warn('[skills] Startup sync failed:', (err as Error).message);
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
  /** Hosted bare repo path for `gitHost: 'agenthub'` projects (self-heal source). */
  hostedBarePath?: string | null,
): Promise<string> {
  if (!sessionUsesWorktree(session)) {
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
    hostedBarePath ?? null,
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

// Git smart-HTTP transport for Agent Hub-hosted repos (/git/<id>.git).
// MUST stay mounted before `express.json`: clone/push bodies are piped
// verbatim into spawned `git upload-pack` / `git receive-pack` processes
// and a body parser would consume the stream. `/git` is outside `/api`,
// so `authMiddleware` never gates it — the router self-authenticates via
// HTTP Basic + ahub_ API keys (see server/git-host/auth.ts).
app.use(
  createGitSmartHttpRoutes({
    findProject,
    broadcast,
    // Default-branch "CI on push" + PR-level CI for moved branches that
    // back an open native PR (external pushes, "push anyway" bypasses).
    // Fire-and-forget — the push-CI module guards/serializes internally.
    onPush: (project, refs, ctx) => {
      recordRecentPush(project.id, refs); // feeds the "Create pull request" banner
      handleHostedRepoPush(project, refs, { stmts: stmts!, broadcast });
      // Opt-in dependency security re-scan when the default branch moved.
      // Fire-and-forget — the module gates on `securityScan.onPush`, serializes
      // per project, and swallows failures so it never breaks the push path.
      void maybeRunPushSecurityScan(project, refs, { stmts: stmts!, broadcast });
      // Operator-configured deploy triggers: a matching branch update enqueues a
      // deployment for the mapped environment. Fire-and-forget — the module gates
      // on a cheap indexed query, honors the per-env concurrency lock, and
      // swallows failures so it never breaks the push path.
      void maybeRunDeployTriggers(project, 'push', refs, { broadcast, config, findProject });
      // Review safety net for external pushes: any moved branch backing
      // an open PR gets the Reviewer agent when branch protection
      // requires review and the head isn't Finalize-validated.
      // routeDeps is initialized later in module order but long before
      // the server accepts pushes.
      for (const ref of refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        const branch = ref.slice('refs/heads/'.length);
        const open = stmts!.getOpenPullRequestByHeadBranch.get(project.id, branch) as
          | import('./types.js').PullRequestRow
          | undefined;
        if (open) {
          void maybeRunPrAutoReview(
            project,
            open,
            {
              stmts: stmts!,
              config,
              broadcast,
              handleChat: routeDeps.handleChat,
            },
            // Run the review as the user who pushed, so it uses their
            // reviewer engine/model + per-account credentials. If receive-pack
            // attribution is unavailable for a head update, skip instead of
            // falling back to the PR author (the pushed content is controlled
            // by the latest pusher).
            { pushedByUserId: ctx?.pushedByUserId ?? null, trigger: 'head_update' },
          );
        }
      }
    },
  }),
);

// Artifact uploads (POST /api/sessions/:id/artifacts) are raw binary read by
// the route's own `express.raw` — but a body an earlier middleware already
// consumed cannot be re-parsed. The global JSON parser would otherwise eat
// `application/json` (and `*+json`) artifact bodies, turning a valid `.json`
// upload into a parsed object and tripping the route's `Buffer.isBuffer` guard
// (400 "Empty file body"). JSON is an explicitly-supported artifact type, so
// skip the global parser for that one path and let the route handle the raw
// stream. Other content types already bypass `express.json` (it only matches
// JSON) so this guard is scoped tightly to the upload endpoint.
const ARTIFACT_UPLOAD_PATH = /^\/api\/sessions\/[^/]+\/artifacts\/?$/;
// Public session-replay ingest (one-shot `/api/replays` and the chunked
// `/api/replays/:id/events`) reads its own raw body via `express.raw` so a
// large rrweb capture can arrive gzip-compressed. The global JSON parser would
// otherwise consume an `application/json` replay body before the route sees it,
// leaving `express.raw` with an empty stream. Skip it for those POSTs and let
// the route own decoding (gzip-framed, `Content-Encoding: gzip`, or plain JSON).
const REPLAY_INGEST_PATH = /^\/api\/replays(?:\/[A-Za-z0-9._-]+\/events)?\/?$/;
const globalJsonParser = express.json({
  limit: '20mb',
  verify: (req: Request, _res, buf: Buffer) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  },
});
app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    req.method === 'POST' &&
    (ARTIFACT_UPLOAD_PATH.test(req.path) || REPLAY_INGEST_PATH.test(req.path))
  ) {
    return next();
  }
  return globalJsonParser(req, res, next);
});

app.use(createHealthRoute({ allAgents, getProjects, config }));

// Interactive API docs (Swagger UI) at /api/docs. Mounted before
// authMiddleware so self-hosters and unauthenticated visitors can browse
// the API surface — the spec is the same one published from CI, so there's
// nothing private to gate. No client changes required; this is a server-only
// nice-to-have for local dev and self-hosted instances.
app.use(createApiDocsRoutes());

// Native PR service for Agent Hub-hosted projects. The afterMerge hook is
// the ONLY mirror trigger for merges — `git update-ref` in the bare repo
// does not fire the post-receive hook (only receive-pack does), so the
// merge path pushes the moved base branch to the GitHub mirror itself.
// Constructed before initAutoGit so the session "Create PR" flow can
// create native PRs too.
const nativePr = createNativePrService({
  stmts: stmts!,
  broadcast,
  afterMerge: async ({ project, baseBranch }) => {
    // Native merges move the base branch via `update-ref` — no
    // post-receive hook fires — so BOTH downstream reactions to "default
    // branch moved" hang off this hook: the GitHub mirror push and CI on
    // push.
    void maybeRunPushCi(project, [`refs/heads/${baseBranch}`], { stmts: stmts!, broadcast });
    // Native merges move the base branch via update-ref (no post-receive hook),
    // so the on-push security re-scan hangs off this hook too.
    void maybeRunPushSecurityScan(project, [`refs/heads/${baseBranch}`], {
      stmts: stmts!,
      broadcast,
    });
    // A native merge is the `merge` deploy-trigger event: enqueue a deployment
    // for any environment whose merge trigger matches the moved base branch.
    void maybeRunDeployTriggers(project, 'merge', [`refs/heads/${baseBranch}`], {
      broadcast,
      config,
      findProject,
    });
    await notifyMirrorPush(project, [`refs/heads/${baseBranch}`], { broadcast });
  },
  // PR head changed (created or reused with a new sha): if Finalize
  // already fully validated this exact sha the PR inherits that result;
  // otherwise run PR-level CI so the PR still shows check status. Covers
  // the create-time race where the push hook fired before the PR row
  // existed.
  onPrHeadChanged: (project, row, meta) => {
    void maybeRunPrCi(project, row, { stmts: stmts!, broadcast });
    void maybeRunPrAutoReview(
      project,
      row,
      {
        stmts: stmts!,
        config,
        broadcast,
        handleChat: routeDeps.handleChat,
      },
      { trigger: meta.reason === 'created' ? 'pr_create' : 'head_update' },
    );
  },
});

initAutoGit({
  stmts: stmts!,
  broadcast,
  getConfig: () => config,
  DEFAULT_SKILLS_DIR,
  nativePr,
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
  getGrokBin: () => GROK_BIN,
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
  getDb,
  drainIdleSessionQueues: () =>
    drainIdleQueuedSessions({
      stmts: stmts!,
      activeProcesses,
      activeDelegationSessions,
      drainQueue,
    }),
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

// Subdomain preview dispatch — opt-in via AGENT_HUB_PREVIEW_SUBDOMAIN_BASE.
// When a request arrives at `<sessionId>.<base>` (e.g.
// `b371b1ba-….preview.agenthub.dev.example.com`), rewrite the URL to
// the path-prefix mount so the rest of the pipeline (authMiddleware →
// session router → previewProxyHandler) handles it identically — no
// dual code path, no auth-bypass risk.
//
// Mounted BEFORE authMiddleware specifically so the auth ticket/cookie
// machinery in `server/auth.ts` (which keys on the proxy path prefix
// via `matchPreviewProxyPath`) keeps working without changes. Mounted
// AFTER the workflow incoming router because that one handles GitHub
// webhook callbacks whose Host header would never match the subdomain
// pattern, and short-circuiting it would only skip the chance to reject
// non-preview hosts.
app.use((req, _res, next) => {
  const base = config.previewSubdomainBase;
  if (!base) return next();
  const sessionId = parsePreviewSubdomainHost(req.headers.host, base);
  if (!sessionId) return next();
  // Preserve the original suffix (query string included). Express
  // strips the host from req.url already, so it's just `/some/path?q=v`.
  const original = req.url || '/';
  const suffix = original.startsWith('/') ? original : `/${original}`;
  req.url = `/api/sessions/${encodeURIComponent(sessionId)}/preview/proxy${suffix}`;
  // Mark so `authMiddleware` can choose the right cookie Path scope
  // (Path=/ on the subdomain origin vs. the proxy mount path on the
  // main Hub origin) and downstream handlers can pick the right CSP
  // / postMessage origin for cross-origin iframe behaviour.
  (req as unknown as { authPreviewArrivedViaSubdomain?: boolean }).authPreviewArrivedViaSubdomain =
    true;
  return next();
});

// Remote runner-fleet control plane (pull-based agents). Mounted BEFORE
// authMiddleware: fleet agents have no Hub session — these routes self-auth via
// the fleet token (/register) and HMAC agent tokens (all others). Inert until a
// fleet token is configured (FINALIZE_RUNNER_FLEET_TOKEN); /register 404s otherwise.
app.use(
  createRunnerRoutes({
    // Persist + surface a runner's per-job resource summary (peak mem / CPU).
    onJobResources: ({ projectId, runId, jobName, matrixKey, summary }) => {
      recordJobResourceSummary(
        { stmts: stmts! },
        { projectId, runId, jobName, matrixKey, summary },
      );
      const gb = (b: number): string => (b / 1024 / 1024 / 1024).toFixed(2);
      console.log(
        `[finalize-job-resources] run=${runId} job=${jobName} matrix=${matrixKey || '(default)'} ` +
          `peak_mem=${gb(summary.peakMemBytes)}GB/${gb(summary.memTotalBytes)}GB ` +
          `peak_cpu=${summary.peakCpuPercent ?? '?'}% avg_cpu=${summary.avgCpuPercent ?? '?'}% ` +
          `samples=${summary.samples} dur=${Math.round(summary.durationMs / 1000)}s`,
      );
      broadcast({
        type: 'finalize_job_resources',
        run_id: runId,
        project_id: projectId,
        job_name: jobName,
        matrix_key: matrixKey,
        summary,
      });
    },
  }),
);
// Queue-depth autoscaler: scales the agent ECS service to run jobs concurrently
// (and back to zero when idle). No-op unless FINALIZE_FLEET_ECS_* are configured.
startFleetScaler();

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

// Session design-mode artifact files: `<worktree>/design/*` →
// `/session-files/<sessionId>/design/*`. Mirrors the `/design-files` mount but
// sources from the session's *worktree* instead of the standalone designs root —
// this is what the in-session Design-mode canvas pane renders (see
// SessionDesignModePane / DesignCanvas on the web client). Handler + guards live
// in session-files-mount.ts so they unit-test without booting the server.
app.use(
  '/session-files/:sessionId/design',
  createSessionDesignFilesHandler({
    getSession: (id) => stmts!.getSession.get(id) as SessionRow | undefined,
  }),
);

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
  // The legacy preview reaper drives *process-based* worktree previews and
  // never touches docker — it must run on every host, including docker-less
  // ones (e.g. a preview of agent-hub itself). The compose-mode reaper and the
  // finalize reaper both shell out to `docker`; on a host with no reachable
  // docker daemon they would throw `dial unix /var/run/docker.sock …` once a
  // minute, forever. `resolveDockerAvailability()` gates only those two so a
  // docker-less Hub stays quiet. See server/docker-availability.ts.
  const dockerAvailability = resolveDockerAvailability();
  if (!dockerAvailability.enabled) {
    console.warn(
      `[reapers] ${dockerAvailability.reason}; skipping finalize + compose-preview reapers`,
    );
  }

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
      if (dockerAvailability.enabled) {
        void runPreviewReaper({
          db: getDb(),
          runtime: previewComposeRuntime as unknown as Parameters<
            typeof runPreviewReaper
          >[0]['runtime'],
          getProject: (id) => findProject(id) ?? null,
        }).catch((err) => {
          console.warn('[preview-reaper:compose] tick failed:', (err as Error).message);
        });
      }
    },
    { name: 'preview-reaper' },
  );

  // Finalize DinD runner reaper — sweep orphaned runner containers + graph
  // volumes left behind when a run is hard-killed (OOM / ENOSPC / Hub crash)
  // before its per-job teardown could run. Active runs (ended_at IS NULL) are
  // never touched. Docker-gated: a docker-less Hub never runs Finalize jobs, so
  // there is nothing to reap and the daemon probe would only spam.
  // See server/finalize/finalize-reaper.ts.
  if (dockerAvailability.enabled) {
    cron.schedule(
      FINALIZE_REAPER_CRON,
      () => {
        void runFinalizeReaper({
          activeRunIds: () =>
            new Set(
              (
                getDb()
                  .prepare('SELECT id FROM finalize_runs WHERE ended_at IS NULL')
                  .all() as Array<{
                  id: string;
                }>
              ).map((r) => r.id),
            ),
        }).catch((err) => {
          console.warn('[finalize-reaper] tick failed:', (err as Error).message);
        });
      },
      { name: 'finalize-reaper' },
    );
  }

  // Runtime stuck-run reaper — steady-state analog to boot-recovery. boot only
  // fails stuck run ROWS on Hub start; an autonomous (`agent_block`) run whose
  // orchestrator dies/hangs mid-process (e.g. a transient runner-lease-expiry
  // blip, NO restart) otherwise hangs in `status=running` forever — the stall
  // watchdog only arms in live mode and the container reaper never touches the
  // row. This once-a-minute sweep flips such runs to infra_error (+ stranded
  // steps skipped, terminal broadcast) and re-triggers a fresh, non-destructive
  // run via the boot-retrigger path (its crash-loop cap bounds reap→retrigger).
  // Pure SQLite + broadcast, so NOT docker-gated. See stuck-run-reaper.ts.
  cron.schedule(
    STUCK_RUN_REAPER_CRON,
    () => {
      void runStuckRunReaper({
        stmts: stmts!,
        broadcast,
        onReaped:
          process.env.NODE_ENV === 'test'
            ? undefined
            : (reaped) =>
                retriggerInterruptedFinalizeRunsOnBoot(routeDeps, reaped).then(() => undefined),
      }).catch((err) => {
        console.warn('[finalize-stuck-reaper] tick failed:', (err as Error).message);
      });
    },
    { name: 'finalize-stuck-reaper' },
  );

  // Runner job-log retention reaper — prune transient CI stdout/stderr frames
  // from `runner_job_logs` (orgs.db) older than the TTL. Append-only and never
  // read post-run, the spool grew without bound until synchronous reads against
  // the bloated DB stalled the event loop (the recurring slow-page-load
  // incident). Pure SQLite, so NOT docker-gated; runs on every Hub.
  // See server/finalize/runner-job-log-reaper.ts.
  cron.schedule(
    RUNNER_JOB_LOG_REAPER_CRON,
    () => {
      try {
        runRunnerJobLogReaper();
      } catch (err) {
        console.warn('[runner-job-log-reaper] tick failed:', (err as Error).message);
      }
    },
    { name: 'runner-job-log-reaper' },
  );

  void runReleaseNotificationOutboxWorker({ broadcast });
  cron.schedule(
    RELEASE_NOTIFICATION_OUTBOX_WORKER_CRON,
    () => {
      void runReleaseNotificationOutboxWorker({ broadcast });
    },
    { name: 'release-notification-outbox-worker', noOverlap: true },
  );
}

/** Full route wiring; exported so integration tests can `vi.spyOn(routeDeps, 'broadcast')`. */
export const routeDeps: RouteDeps = {
  stmts: stmts!,
  broadcast,
  nativePr,
  findProject,
  findAgent,
  getEnrichedAgent,
  allAgents,
  saveProjects,
  handleChat: (ws: unknown, msg: ChatMessage) => handleChat!(ws, msg),
  lastDispatchedReviewId,
  scheduleAutonomousEpic,
  autonomousCrons,
  runAutonomousLoop,
  config,
  getProjects,
  setProjects,
  serverDir: __dirname,
  buildTranscript,
  summarizeTranscript,
  DEFAULT_MODEL,
  activeProcesses,
  getProjectDataDir,
  ensureDocsAgents,
  retireIntakeAgents,
  ensureSkillBuilderAgents,
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
  getGrokBin: () => GROK_BIN,
  setGrokBin: (v: string) => {
    GROK_BIN = v;
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
      hostedBarePathForProject(project),
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
app.use(createCodeRagRoutes(routeDeps));
app.use(createHeartbeatRoutes(routeDeps));
app.use(createCronRoutes(routeDeps));
app.use(createDesignRoutes({ ...routeDeps, getDesignsRoot }));
app.use(createSkillRoutes(routeDeps));
app.use(createSkillEvalRoutes(routeDeps));
app.use(createBoardRoutes(routeDeps));
app.use(createConfigRoutes(routeDeps));
app.use(createSessionRoutes(routeDeps));
app.use(createArtifactRoutes(routeDeps));
app.use(createFinalizeRoutes(routeDeps));
app.use(createFinalizeParityRoutes(routeDeps));
app.use(createFinalizeQuarantineRoutes(routeDeps));
app.use(createFinalizeWizardRoutes(routeDeps));
app.use(createDeploymentRoutes(routeDeps));
app.use(createReleaseNotificationSettingsRoutes(routeDeps));
app.use(createProjectRoutes(routeDeps));
app.use(createGitHostRoutes(routeDeps));
app.use(createSecurityAuditRoutes(routeDeps));
app.use(createCiRunsRoutes(routeDeps));
app.use(createPullsNativeRoutes(routeDeps));
app.use(createPreviewSecretsRoutes(routeDeps));
app.use(createProjectAwsRoutes(routeDeps));
app.use(createPreviewWizardRoutes(routeDeps));
app.use(createRumWizardRoutes(routeDeps));
app.use(createRumClientRoutes(routeDeps));
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
app.use(createGeminiAuthRoutes(routeDeps));
app.use(createPerUserEngineAuthRoutes(routeDeps));
app.use(createThreadRoutes(routeDeps));
app.use(createWorkflowRoutes(routeDeps));
app.use(createEscalationRoutes(routeDeps));
app.use(createSupportTicketRoutes(routeDeps));
app.use(createSupportTicketsOverviewRoutes(routeDeps));
app.use(createInstanceBackupRoutes(routeDeps));
app.use(createIosBuildRoutes(routeDeps));
app.use(createPrActionRoutes(routeDeps));
app.use(createPrListRoutes(routeDeps));
app.use(createPrResolveRoutes(routeDeps));
app.use(createBugReportRoutes(routeDeps));
app.use(createReplayRoutes(routeDeps));
app.use(createReplaysDashboardRoutes(routeDeps));
app.use(createReplayPlaylistRoutes(routeDeps));
app.use(createRumSessionsRoutes(routeDeps));
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
app.use(createMeTodosRoutes(routeDeps));
app.use(createMeDashboardRoutes(routeDeps));
// PR-env settings/provisioning routes and the `pr_env_config` DB row
// were removed as part of the "Strip PR Environments" epic (88367984).
// Worktree previews (per-session, host-side) are the supported preview
// surface.
app.use(createGithubOAuthRoutes(routeDeps));
app.use(createGoogleOAuthRoutes(routeDeps));
app.use(createGoogleCalendarRoutes(routeDeps));
app.use(createGoogleGmailRoutes(routeDeps));
app.use(createGoogleSheetsRoutes(routeDeps));
app.use(createGoogleDriveRoutes(routeDeps));

const server = createServer(app);
const drainingLock = new Set<string>();
const MAX_QUEUE_SIZE = 10;

const { broadcast: _wsBroadcast } = createWebSocket(server, {
  getProjects,
  handleChat: (ws: unknown, msg: ChatMessage) => handleChat!(ws as WebSocketLike | null, msg),
  handleCancel,
  handleDelegationCancel,
  handleDequeue,
  handleEditQueueItem,
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

recoverInFlightDeployments({
  broadcast,
  orgId: getActiveOrgId(),
  resolveGithubToken: (userId: string) => resolveUserGithubToken(userId, config),
  resolveProjectGithubRepo: (projectId: string) => findProject(projectId)?.githubRepo ?? null,
  prepareRecoveryCheckout: async ({ projectId, ref }) => {
    const project = findProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const checkout = await prepareDeploymentCheckout({ project, ref });
    return { worktreePath: checkout.worktreePath, cleanupWorktreeOnTerminal: true };
  },
  releaseDigestConfig: config,
});

attachDefaultPreviewProxyUpgrade(
  server,
  {
    getSessionPreviewPort: (sessionId) =>
      getSessionPreviewPort(sessionId, {
        getPreviewComposeRuntime: () => previewComposeRuntime,
        getPreviewRuntime: () => previewRuntime,
      }),
  },
  { subdomainBase: config.previewSubdomainBase },
);

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
  getGrokBin: () => GROK_BIN,
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
chatHandler.initMultiAgent();

setTriggerAutoSessionShip(async ({ sessionId, project, agent, session }) => {
  const result = triggerSessionShip({
    sessionId,
    session,
    project,
    agent,
    stmts: stmts!,
    broadcast,
    activeProcesses,
    handleChat: handleChat as TriggerSessionShipArgs['handleChat'],
    source: 'auto_session_end',
  });
  if (result.ok) return { ok: true as const };
  return { ok: false as const, code: result.code, error: result.error };
});

setFinalizeAutomationRouteDeps(routeDeps);
setReadyToPushAutomationHook((sessionId, runId) => {
  void maybeAutoPushReadyFinalizeRun({ sessionId, runId });
});
// When a hosted-repo head's checks pass, complete any deferred native
// Auto-Merge that earlier raced an in-flight required check. The work is
// intentionally detached (we don't block CI-run completion on the merge), so
// attach a rejection handler here: push-ci's hook invocation only guards
// SYNCHRONOUS throws, and any async failure before autoMergeFinalizedPr's
// internal catch (e.g. a prepared-statement shape issue) would otherwise
// surface as an unhandled rejection.
setChecksPassedHook(({ project, branch }) => {
  maybeAutoMergeAfterChecks({ project, branch }).catch((err: unknown) => {
    console.warn(
      `[finalize-automation] checks-passed auto-merge hook failed for ${project.id} ${branch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
});

function handleCancel(sessionId: string): void {
  cancelSessionChatRun({ sessionId, activeProcesses });
  handleMultiAgentCancel(sessionId);
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
          card.phase_id ?? null,
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

    // Crash-loop guard: if this session has already been auto-resumed
    // MAX_RESUME_ATTEMPTS times without any turn completing cleanly, stop
    // re-spawning it and surface an error so a human can pick it up.
    //
    // We deliberately do NOT reset resume_attempts here — the cap must stay
    // durable. Giving up permanently stops the loop: this orphan's
    // active_tasks row is cleared by deleteAllActiveTasks below and we don't
    // re-spawn, so nothing re-creates a task for this session next boot.
    // Leaving the counter at the cap means that even if a later spawn is
    // itself interrupted before completing, we keep failing closed instead of
    // silently re-entering the loop with a fresh budget. The counter is reset
    // only by a turn that actually runs to a clean process exit (see
    // resetSessionResumeAttempts in chat.ts proc.on('close')) — i.e. real
    // forward progress, which is exactly the human-initiated turn that
    // supersedes the give-up state.
    const priorAttempts = session.resume_attempts ?? 0;
    if (shouldGiveUpAutoResume(priorAttempts)) {
      const suffix = partial ? `\n\nPartial output before interruption:\n${partial}` : '';
      saveErrorMessage!(
        t.session_id,
        t.message_id,
        t.engine,
        t.model ?? '',
        `Session repeatedly interrupted by server restarts (${priorAttempts}/${MAX_RESUME_ATTEMPTS} auto-resume attempts) and was not resumed again to avoid a crash loop. Send a message to continue.${suffix}`,
      );
      console.warn(
        `[Resume] Session ${t.session_id} hit MAX_RESUME_ATTEMPTS (${priorAttempts}/${MAX_RESUME_ATTEMPTS}); not auto-resuming`,
      );
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
        null,
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

    // Record the attempt before re-spawning. A clean process exit later resets
    // this to 0 (see resetSessionResumeAttempts in chat.ts proc.on('close')),
    // so the counter only grows while the server keeps dying mid-turn.
    try {
      stmts!.incrementSessionResumeAttempts.run(t.session_id);
    } catch (err) {
      console.error(
        `[Resume] Failed to increment resume_attempts for session ${t.session_id}:`,
        (err as Error).message,
      );
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
        // `_autoResume` marks this as an automatic crash-resume so handleChat
        // does NOT clear the resume_attempts cap at turn start (the increment
        // recorded in reconcileOrphanedTasks must stand). A human-initiated
        // turn, by contrast, leaves this unset and resets the cap.
        await handleChat!(null, { type: 'chat', agentId, sessionId, content, _autoResume: true });
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

// Public permissive-CORS ingest endpoints (rrweb replay recorder,
// bug-report widget) advertise `Access-Control-Allow-Origin: *` so they
// can be POSTed from third-party origins. Their per-route applyCors only
// runs once the request reaches the router, so a failure in the GLOBAL
// body parser above (oversized / malformed body) would otherwise answer
// with NO CORS headers and the browser reports a misleading "CORS error"
// instead of the honest 413 / 400. Stamp the headers on those errors.
app.use(publicCorsErrorHandler);

// Global fallback for body-parser failures on every other route: without it, a
// malformed / oversized JSON body (canonically a plain-text body sent with
// `Content-Type: application/json`) falls through to Express's default handler,
// which dumps the full stack to stderr even though the client already gets a
// 400. Answer with a concise JSON error and one warn line instead.
app.use(jsonBodyErrorHandler);

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
  const markActiveSessionsForShutdown = (signal: string): void => {
    for (const sessionId of activeProcesses.keys()) {
      markSessionTermination(sessionId, 'server_shutdown');
      console.info(
        `[shutdown] server_shutdown: marked session=${sessionId} before drain (${signal})`,
      );
    }
  };
  process.on('SIGTERM', () => markActiveSessionsForShutdown('SIGTERM'));
  process.on('SIGINT', () => markActiveSessionsForShutdown('SIGINT'));
  process.on('SIGHUP', () => markActiveSessionsForShutdown('SIGHUP'));
  installShutdownHandlers();

  server.listen(PORT, '0.0.0.0', () => {
    const actualPort = (server.address() as AddressInfo).port;
    setActualPort(actualPort);
    console.log(`Agent Hub server running on http://localhost:${actualPort}`);
    console.log(`Loaded ${getProjects().length} projects, ${allAgents().length} agents`);

    // Hosted-git notify hooks embed this process's port — refresh on every
    // boot so post-receive notifications reach the current process.
    try {
      refreshGitHostNotifyConfigs(getProjects());
    } catch (e) {
      console.error('[git-host] notify refresh on boot failed:', (e as Error).message);
    }

    // Two-way mirror reconcile poller: catches commits that land directly
    // on GitHub (e.g. a release bot's version bump) and pulls them into the
    // Hub, and surfaces a true divergence the outbound mirror can't cross.
    try {
      startMirrorReconcilePoller({ getProjects, broadcast });
    } catch (e) {
      console.error('[git-host] mirror reconcile poller failed to start:', (e as Error).message);
    }

    const sessionsToResume: ResumeEntry[] = reconcileOrphanedTasks();

    try {
      const drained = drainIdleQueuedSessions({
        stmts: stmts!,
        activeProcesses,
        activeDelegationSessions,
        drainQueue,
      });
      if (drained > 0) {
        console.log(`[QueueDrain] Boot drained idle queues for ${drained} session(s)`);
      }
    } catch (err) {
      console.error('[QueueDrain] Boot drain failed:', (err as Error).message);
    }

    scheduleAll(allAgents());

    try {
      failStuckWorkflowRunsOnBoot(stmts!);
    } catch (e) {
      console.error('[workflow] failStuckWorkflowRunsOnBoot', (e as Error).message);
    }

    let interruptedFinalizeRuns: InterruptedFinalizeRun[] = [];
    try {
      interruptedFinalizeRuns = failStuckFinalizeRunsOnBoot(stmts!);
    } catch (e) {
      console.error('[finalize] failStuckFinalizeRunsOnBoot', (e as Error).message);
    }
    // Re-trigger interrupted runs from scratch so a deploy/crash mid-Finalize is
    // non-destructive. Guarded out of tests (kicks off real git + orchestrators)
    // and fire-and-forget so it never blocks boot.
    if (process.env.NODE_ENV !== 'test' && interruptedFinalizeRuns.length > 0) {
      void retriggerInterruptedFinalizeRunsOnBoot(routeDeps, interruptedFinalizeRuns).catch((e) =>
        console.error('[finalize] retriggerInterruptedFinalizeRunsOnBoot', (e as Error).message),
      );
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

    // Register node-cron tasks for every enabled operator-configured deploy
    // schedule so cron-driven deployments fire without a restart. Same
    // broadcast/config/findProject wiring the push/merge trigger hook uses.
    try {
      initDeploySchedules({ broadcast, config, findProject });
    } catch (e) {
      console.error('[deploy-schedule] init on boot', (e as Error).message);
    }

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

      // Periodic dependency security re-scan for projects that opted into a
      // daily/weekly cadence (Project.securityScan.schedule). Opens a kanban
      // card only when a scan surfaces new/reopened findings.
      startScheduledSecurityScanner({
        stmts: stmts!,
        broadcast,
        getProjects,
      });

      // Session-replay retention GC. No-op unless `replayRetentionDays > 0`;
      // when enabled, periodically deletes expired UNLINKED replay INDEX ROWS so
      // the SQLite index can't grow without bound. On S3 the blob bytes are reaped
      // by the bucket lifecycle rules — but ONLY once provisioning is confirmed
      // (see the holder below); until then, and on local storage, the sweeper
      // still reclaims the blob itself so a provisioning gap can't orphan bytes.
      // Linked (ticket/card) replays are never expired.
      // Shared S3-lifecycle confirmation state the sweepers gate byte delegation
      // on. `provisioned` = the global `rum/` rule is confirmed; `provisionedProjects`
      // = the per-tenant `rum/<project>/` rules confirmed installed. Kept in sync by
      // the reconciler below; the sweepers hold closures over this object.
      const rumLifecycle = createRumLifecycleState();
      // Per-tenant BASE (hot/index) retention overrides, resolved fresh each sweep
      // from the current project config so an operator toggling
      // `project.replay.retentionDays` takes effect without a restart. Only
      // projects whose effective window actually differs from the global default
      // are returned (tighten-only; see collectRetentionOverrides).
      const getRetentionOverrides = () =>
        collectRetentionOverrides(getProjects(), config.replayRetentionDays);
      startReplayRetentionSweeper({
        stmts: stmts!,
        config,
        isLifecycleProvisioned: () => rumLifecycle.provisioned,
        isProjectLifecycleProvisioned: (pid) => rumLifecycle.provisionedProjects.has(pid),
        getRetentionOverrides,
      });

      // Index-only TTL reconciliation for SEGMENTED captures (rum_sessions /
      // rum_segments). Same policy + lifecycle-provisioned gate as the monolithic
      // sweeper above: once S3 lifecycle expires the `rum/` bytes these index rows
      // point at gone objects, so reap them (dropping only the rows on confirmed
      // S3, reclaiming the blob on local / unconfirmed provisioning).
      startRumSegmentRetentionSweeper({
        stmts: stmts!,
        config,
        isLifecycleProvisioned: () => rumLifecycle.provisioned,
        isProjectLifecycleProvisioned: (pid) => rumLifecycle.provisionedProjects.has(pid),
        getRetentionOverrides,
      });

      // Provision the S3-native lifecycle policy for segmented RUM objects: the
      // global `rum/` rule (blob expiry + IA/Glacier tiering owned by S3, not the
      // app) plus one `rum/<project>/` rule per per-tenant override at its tighter
      // window (S3 honors the shortest overlapping expiration). Idempotent + a true
      // no-op on local storage; best-effort on S3 so a missing
      // s3:*LifecycleConfiguration permission logs rather than crashes boot.
      //
      // Run on an interval (not one-shot): the sweepers read the override set fresh
      // each tick, so a runtime `project.replay.retentionDays` edit must also get
      // its per-prefix rule installed and confirmed — otherwise the sweeper would
      // (safely, per its per-project provisioned gate) keep deleting that tenant's
      // bytes itself instead of delegating to lifecycle. Reconciling keeps the S3
      // rules and the confirmation state in step with live project config.
      const reconcileLifecycle = () =>
        reconcileRumLifecycle({ config, getProjects, state: rumLifecycle }).catch((err: Error) =>
          console.error(`[replay-lifecycle] reconcile failed: ${err.message}`),
        );
      void reconcileLifecycle();
      const rumLifecycleTimer = setInterval(reconcileLifecycle, RETENTION_SWEEP_INTERVAL_MS);
      if (typeof rumLifecycleTimer.unref === 'function') rumLifecycleTimer.unref();
    }

    initIosBuildEngine({ stmts: stmts!, broadcast });

    resumeOrphanedSessions(sessionsToResume);
  });
}
