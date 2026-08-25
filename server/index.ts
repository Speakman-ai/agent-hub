import { installLogCapture, setLogBroadcast } from './server-log.js';
installLogCapture(); // Must be first — captures all subsequent console output
import { initLogShipperFromEnv } from './log-shipper.js';

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
import createProjectStatsRoutes from './routes/project-stats.js';
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
import type { SecurityAutofixDeps } from './security-audit/autofix.js';
import { createSecurityAuditStore } from './security-audit/findings-store.js';
import { recordRecentPush } from './git-host/recent-pushes.js';
import { createNativePrService } from './native-pr/service.js';
import { tryAutoMergeArmedNativePr } from './native-pr/auto-merge-armed.js';
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
import { ensureOperatorBaseBranch } from './autonomous.js';
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
import config, { refreshShellPath } from './config.js';
import { resolveUploadsDir } from './uploads-dir.js';
import { migrateLegacyUploads } from './uploads-migration.js';
import {
  beginSessionEnvSelection,
  initSessionEnvSelection,
  logSessionEnvSelection,
  whenSessionEnvSelectionReady,
} from './session-env/sysbox-capability.js';
import { reconcileSysboxSessionEnvs } from './session-env/sysbox-reconcile.js';
import { runSessionEnvBootSweep } from './session-env/session-env-boot-sweep.js';
import { probeFirecrackerCapability } from './session-env/firecracker/firecracker-capability.js';
import { reconcileFirecrackerHost } from './session-env/firecracker/firecracker-slots.js';
import {
  createFirecrackerHostIo,
  stopStaleFirecrackerVmms,
  createHelperCapabilityDeps,
  resolveFirecrackerExecConfig,
} from './session-env/firecracker/firecracker-privileged-exec.js';
import {
  firecrackerExecDefaults,
  firecrackerHostPaths,
  forgetPersistedFirecrackerDisks,
  registerFirecrackerBackend,
  unregisterFirecrackerBackend,
} from './session-env/firecracker/register-firecracker-backend.js';
import { SessionEnvManager, type SessionEnvEnsureOpts } from './session-env/session-env-manager.js';
import { worktreeSharingForKind } from './session-env/session-env.js';
import {
  allocateEphemeralHostPort,
  releaseEphemeralHostPort,
} from './session-env/ephemeral-host-port.js';
import { HostWorktreeIo, type SessionWorktreeIo } from './session-env/worktree-io.js';
import { setSessionWorktreeIoResolver } from './session-worktree-io.js';
import { setSessionProjectResolver } from './session-checkpoint-rewind.js';
import { getProjectSessionStartupCommands } from './session-env/session-startup-hooks.js';
import {
  emitSessionStartupProgress,
  emitSessionEnvLaunchProgress,
  emitSessionWorkspaceProgress,
} from './session-env/session-env-progress.js';
import {
  describeSessionEnvPortRouting,
  resolveSessionEnvPortRouting,
} from './session-env/container-routing.js';
import { ensureReviewerGhConfigDir } from './spawn-github-credentials.js';
import { authMiddleware } from './auth.js';
import { initOrgsDb, orgDataDir, getActiveOrgId } from './orgs.js';
import { migrateAuthRecordIfNeeded } from './users-store.js';
import { maybeAutoProvisionOwner } from './auth-bootstrap.js';
import { getProjectMode, sessionUsesWorktree } from './project-mode.js';
import { resolveSessionWorktreePath } from './session-env/workflow-session-env.js';
import {
  isFirecrackerBackendRegistered,
  resolveSessionEnvAdapterForSession,
} from './session-env/resolve-session-adapter.js';
import { isSessionWorktreeLocked } from './session-worktree-lock.js';
import {
  ensureSessionWorkspace,
  switchSessionWorkspaceBranch,
  sessionWorkspaceNeedsProvisionProgress,
  type OnBaseBranchAdvancedFn,
} from './worktree.js';
import { handleWorktreeFailure } from './worktree-failure.js';
import { installShutdownHandlers } from './process-groups.js';
import { markSessionTermination } from './process-termination.js';
import {
  buildRestartResumeNotice,
  buildRestartResumePrompt,
  type KilledBackgroundShell,
} from './restart-resume-notice.js';
import { cancelSessionChatRun } from './session-chat-cancel.js';

import { trustProxyValueFromEnv } from './trust-proxy.js';
import { uriDecodeGuard, uriErrorHandler } from './uri-error-handler.js';
import { publicCorsErrorHandler } from './public-cors-error-handler.js';
import { jsonBodyErrorHandler } from './json-body-error-handler.js';
import createNoteRoutes from './routes/notes.js';
import createToolErrorRoutes from './routes/tool-errors.js';
import createWikiRoutes from './routes/wiki.js';
import createCodeRagRoutes from './routes/code-rag.js';
import createLogSourceRoutes from './routes/log-sources.js';
import createLogMetricsRoutes from './routes/log-metrics.js';
import createLogIngestRoutes from './routes/log-ingest.js';
import createLogQueryRoutes from './routes/log-query.js';
import createLogIssueRoutes from './routes/log-issues.js';
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
import createProjectBrandingRoutes from './routes/project-branding.js';
import { createProjectVisibilityGate } from './project-visibility-middleware.js';
import { cascadeDeleteUserPrivateProjects } from './project-owner-cascade.js';
import createPreviewSecretsRoutes from './routes/preview-secrets.js';
import createProjectAwsRoutes from './routes/project-aws.js';
import createInfraRoutes from './routes/infra.js';
import createInfraAlertRoutes from './routes/infra-alerts.js';
import createInfraAlertRoutingRoutes from './routes/infra-alert-routing.js';
import createInfraHealthRoutes from './routes/infra-health.js';
import createInfraHealthIngestRoutes from './routes/infra-health-ingest.js';
import createDevServerWizardRoutes from './routes/dev-server-wizard.js';
import createRumWizardRoutes from './routes/rum-wizard.js';
import createLogsWizardRoutes from './routes/logs-wizard.js';
import createInfraWizardRoutes from './routes/infra-wizard.js';
import createRumClientRoutes from './routes/rum-clients.js';
import createPreviewInstancesRoutes from './routes/preview-instances.js';
import createProvisioningRoutes from './routes/provisioning.js';
import createJobRoutes from './routes/jobs.js';
import createAgentRoutes from './routes/agents.js';
import createOrgRoutes from './routes/orgs.js';
import createDashboardRoutes from './routes/dashboard.js';
import createUploadRoutes from './routes/uploads.js';
import createArtifactRoutes from './routes/artifacts.js';
import createBackgroundShellRoutes from './routes/background-shells.js';
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
import createFinalizeCiConfigRoutes from './routes/finalize-ci-config.js';
import createDeploymentRoutes from './routes/deployments.js';
import { recoverInFlightDeployments } from './deploy/deploy-orchestrator.js';
import { prepareDeploymentCheckout } from './deploy/deployment-checkout.js';
import { maybeRunDeployTriggers } from './deploy/deploy-trigger-hook.js';
import { initDeploySchedules } from './deploy/deploy-schedule-ticker.js';
import { initReleaseGates, requestReleaseGateSweep } from './deploy/release-gate-ticker.js';
import { initEpicStartSchedules } from './autonomous-start-schedule.js';
import { initDailySummarySchedules } from './daily-summary-schedule.js';
import { generateDailySummary } from './hub-daily-summary.js';
import { listUsersWithDailySummarySchedule } from './user-preferences-store.js';
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
import createMeTodosRoutes from './routes/me-todos.js';
import createMeDashboardRoutes from './routes/me-dashboard.js';
import createMeHubRoutes from './routes/me-hub.js';
import createMeDailySummaryRoutes from './routes/me-daily-summary.js';
import createGithubOAuthRoutes from './routes/github-oauth.js';
import createGoogleOAuthRoutes from './routes/google-oauth.js';
import createGoogleCalendarRoutes from './routes/google-calendar.js';
import createGoogleGmailRoutes from './routes/google-gmail.js';
import createGoogleSheetsRoutes from './routes/google-sheets.js';
import createGoogleDriveRoutes from './routes/google-drive.js';
import type { AddressInfo } from 'net';
import { setActualPort } from './server-port.js';

import { drainIdleQueuedSessions, isSessionChatBusy } from './session-chat-busy.js';

import { handleMultiAgentCancel } from './session-multi-agent.js';

import { initDesignChat, handleDesignChat, handleDesignCancel } from './design-chat.js';
import { ensureDesignsRoot, getDesign as getDesignStore } from './designs-store.js';
import { sweepOrphanedCursorRuleFiles } from './cursor-rule-registry.js';
import { createSessionDesignFilesHandler } from './session-files-mount.js';
import { createGitHostMediaHandler, validateGitHostMediaToken } from './git-host-media-mount.js';
import { readRepoBlob } from './git-host/repo-read.js';

import {
  initAutoGit,
  autoCommitAndPR,
  resolveSlashSkill,
  setTriggerAutoSessionShip,
  setTriggerUncommittedCommitNudge,
  resolveUserGithubToken,
} from './auto-git.js';
import {
  triggerSessionShip,
  type TriggerSessionShipArgs,
  markSessionFinalizeAutomation,
} from './session-ship.js';
import {
  triggerUncommittedCommitNudge,
  type TriggerUncommittedCommitNudgeArgs,
} from './uncommitted-commit-nudge.js';
import { setReadyToPushAutomationHook } from './finalize/orchestrator.js';
import {
  maybeAutoPushReadyFinalizeRun,
  maybeAutoMergeAfterChecks,
  setFinalizeAutomationRouteDeps,
} from './finalize/automation-runner.js';
import { initWikiDocMergeHook } from './wiki-doc-session.js';

import createChatHandler, { type ChatHandlerDeps, type WebSocketLike } from './chat.js';

import { createPreviewRuntimes } from './preview/preview-runtime-setup.js';
import {
  DEFAULT_DEV_SERVER_PORT_ENTRY,
  resolveDevServerPortEntries,
} from './preview/dev-server-runtime.js';
import { parseDevServerConfig } from './dev-server-config.js';
import { createBackgroundShellRuntime } from './background-shells/background-shell-runtime-setup.js';
import {
  BackgroundShellWatcher,
  WATCH_SWEEP_INTERVAL_MS,
} from './background-shells/background-shell-watcher.js';
import type { BackgroundShellRow } from './background-shells/background-shell-runtime.js';
import {
  createPreviewUrlBase,
  resolveDevServerPortClientUrl,
  resolvePreviewHealthHost,
} from './preview/preview-public-url.js';
import { attachDefaultPreviewProxyUpgrade } from './preview/preview-proxy.js';
import { logBrowserCapabilityAtBoot } from './browser-capability.js';
import { PtyHost } from './terminal/pty-host.js';
import { PtySession } from './terminal/pty-session.js';
import { buildTerminalShellEnv } from './terminal/terminal-shell-env.js';
import { attachTerminalWebSocket } from './terminal/terminal-websocket.js';
import { parsePreviewSubdomainHost } from './preview/preview-subdomain-host.js';
import { previewSubdomainRewrittenUrl } from './preview/preview-public-url.js';
import { getSessionPreviewPort } from './preview/session-preview-port.js';
import { PREVIEW_REAPER_CRON } from './preview/preview-runtime-primitives.js';
import { runFinalizeReaper, FINALIZE_REAPER_CRON } from './finalize/finalize-reaper.js';
import { reapFinalizeSourceCheckouts } from './finalize/session-source.js';
import { runStuckRunReaper, STUCK_RUN_REAPER_CRON } from './finalize/stuck-run-reaper.js';
import {
  runRunnerJobLogReaper,
  RUNNER_JOB_LOG_REAPER_CRON,
} from './finalize/runner-job-log-reaper.js';
import {
  RELEASE_NOTIFICATION_OUTBOX_WORKER_CRON,
  runReleaseNotificationOutboxWorker,
} from './release-notification-worker.js';
import { initLogsDb } from './logs/logs-db.js';
import { startLogWriteQueue, flushLogWriteQueue } from './logs/log-write-queue.js';
import { runLogRetentionReaper, LOG_RETENTION_REAPER_CRON } from './logs/log-retention-reaper.js';
import { initInfraDb } from './infra/infra-db.js';
import { startInfraWriteQueue, flushInfraWriteQueue } from './infra/infra-write-queue.js';
import { runInfraInventorySync, INFRA_INVENTORY_SYNC_CRON } from './infra/inventory-sync.js';
import { runInfraMetricCollection, INFRA_COLLECT_CRON } from './infra/metric-collector.js';
import { runInfraCostExplorerSync, INFRA_COST_EXPLORER_CRON } from './infra/cost-explorer-sync.js';
import { runInfraAlertEvaluation } from './infra/alert-runner.js';
import {
  runInfraRetentionReaper,
  INFRA_RETENTION_REAPER_CRON,
} from './infra/infra-retention-reaper.js';
import {
  runInfraAlertOutboxWorker,
  INFRA_ALERT_OUTBOX_WORKER_CRON,
} from './infra/alert-outbox-worker.js';
import {
  recoverPendingInfraHealthNotifications,
  INFRA_HEALTH_RECOVERY_CRON,
} from './infra/health-event-recovery.js';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
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
  MessageRow,
  KanbanCardRow,
  KanbanColumnRow,
  Project,
} from './types.js';

const __dirname: string = path.dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);
const PORT: number = config.port;
// Bind address for the HTTP listener. Defaults to `0.0.0.0` (all interfaces),
// which is what LAN / server deployments want. Set AGENT_HUB_HOST=127.0.0.1
// (or `host` in config.json) to restrict the API to loopback on shared hosts.
const HOST: string = config.host;

let CLAUDE_BIN: string = config.claudeBin;
let CURSOR_BIN: string = config.cursorBin;
let GEMINI_BIN: string = config.geminiBin;
let CODEX_BIN: string = config.codexBin;
let GROK_BIN: string = config.grokBin;

let handleChat: ((ws: unknown, msg: ChatMessage) => Promise<void>) | undefined;
let prepareAutonomousSessionEnv: (sessionId: string) => Promise<void> = async () => {};

/**
 * Collaborators the unattended security scans (on-push, scheduled) need to
 * dispatch a fix session for projects that opted into `securityAutoPr.enabled`.
 * Built lazily per call: `handleChat` and the db handle are initialised later in
 * module order, long before any scan can fire.
 */
let securityAuditStore: ReturnType<typeof createSecurityAuditStore> | null = null;
const securityAutofixDeps = (): SecurityAutofixDeps => {
  if (!securityAuditStore) securityAuditStore = createSecurityAuditStore(getDb());
  return {
    stmts: stmts!,
    config,
    findAgent: routeDeps.findAgent,
    handleChat: routeDeps.handleChat,
    broadcast,
    store: securityAuditStore,
  };
};

let saveErrorMessage:
  | ((
      sessionId: string,
      messageId: string,
      engine: string,
      model: string,
      errorText: string,
    ) => string)
  | undefined;
const DEFAULT_MODEL: string =
  config.engineDefaultModels['claude-code'] || config.engineValidModels['claude-code']?.[0] || '';
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

// Dedicated customer-application log store (decision LOG-STORE). Anchored at
// the base data dir like orgs.db — a single Hub-wide logs.db, never mixed
// into agent-hub.db / orgs.db so high-volume log writes can't contend with
// operational state. Best-effort: a failure here must not block boot.
try {
  initLogsDb(config.dataDir);
  // Start the bounded batch-writer queue's background flusher once the store is
  // open (decision LOG-STORE). The timer is unref'd, so it never keeps the
  // process alive; ingest routes enqueue into the same singleton.
  startLogWriteQueue();
} catch (err) {
  console.error('[logs] Failed to initialize logs.db:', (err as Error).message);
}

// Dedicated AWS infrastructure-monitoring store (decision INFRA-STORE).
// Anchored at the base data dir like logs.db so collector writes never contend
// with operational state. Best-effort: a failure here must not block boot.
try {
  initInfraDb(config.dataDir);
  // Start the bounded batch-writer queue's background flusher once the store is
  // open. The timer is unref'd, so it never keeps the process alive; collector
  // ticks enqueue into the same singleton.
  startInfraWriteQueue();
} catch (err) {
  console.error('[infra] Failed to initialize infra.db:', (err as Error).message);
}

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
// Docs are no longer auto-seeded, Intake is retired, and Reviewer creation is
// limited to explicit GitHub/hosting flows. Existing project rosters otherwise
// remain unchanged.
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

async function ensureWorktree(
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
    return projectCwd;
  }
  const trimmedPrBase = prBaseBranch?.trim();
  if (trimmedPrBase && projectId) {
    const project = findProject(projectId);
    if (project) {
      await ensureOperatorBaseBranch(project, trimmedPrBase, { config }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[Workspace] ensureOperatorBaseBranch threw for project "${project.name}", branch "${trimmedPrBase}": ${msg}`,
        );
      });
    }
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
      void maybeRunPushSecurityScan(project, refs, {
        stmts: stmts!,
        broadcast,
        autofix: securityAutofixDeps(),
      });
      // Operator-configured deploy triggers: a matching branch update enqueues a
      // deployment for the mapped environment. Fire-and-forget — the module gates
      // on a cheap indexed query, honors the per-env concurrency lock, and
      // swallows failures so it never breaks the push path.
      void maybeRunDeployTriggers(project, 'push', refs, { broadcast, config, findProject });
      // Review safety net for external pushes: any moved branch backing
      // an open PR gets the Reviewer agent when the head isn't already
      // Finalize-validated. Merge policy does not suppress review.
      // routeDeps is initialized later in module order but long before
      // the server accepts pushes.
      // `git push -o automerge` (or `-o auto-merge`): arm auto-merge for each
      // pushed branch. An already-open PR is armed (and merged now if green);
      // a branch with no PR yet records a pending intent that the next PR
      // opened for it consumes. Push CI running for the head completes the
      // merge once its checks pass (see maybeAutoMergeAfterChecks).
      const wantsAutoMerge = (ctx?.pushOptions ?? []).some(
        (o) => o === 'automerge' || o === 'auto-merge',
      );
      for (const ref of refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        const branch = ref.slice('refs/heads/'.length);
        const open = stmts!.getOpenPullRequestByHeadBranch.get(project.id, branch) as
          | import('./types.js').PullRequestRow
          | undefined;
        if (wantsAutoMerge && project.gitHost === 'agenthub') {
          if (open) {
            try {
              nativePr.setAutoMerge({ project, number: open.number, enabled: true });
              void tryAutoMergeArmedNativePr(
                { stmts: stmts!, nativePr },
                { project, number: open.number },
              ).catch(() => {});
            } catch (err: unknown) {
              console.warn(
                `[native-pr] push-option auto-merge arm failed for ${project.id}#${open.number}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          } else {
            stmts!.upsertPrAutoMergeIntent.run(
              project.id,
              branch,
              ctx?.pushedByUserId ?? null,
              Date.now(),
            );
          }
        }
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
// Customer-log ingest (OTLP/HTTP + the Agent Hub JSON batch) reads its own raw
// body via `express.raw` so it can accept binary protobuf and own gzip
// decompression. The global JSON parser would otherwise consume a JSON ingest
// body before the route sees it, leaving `express.raw` with an empty stream.
// Skip it for those POSTs. Trailing-slash-tolerant to match the route's
// non-strict routing and the public-path check in auth.ts.
const LOG_INGEST_PATH = /^\/api\/(?:otel\/v1\/logs|logs\/ingest)\/?$/;
// Public AWS Health ingest. The route mounts its own `express.json` with a
// 1 MiB cap; letting the 20 MB global parser run first would allow an
// unauthenticated caller to allocate 20 MB before the token is even checked.
const INFRA_HEALTH_INGEST_PATH_RE = /^\/api\/infra\/health\/ingest\/?$/;
const globalJsonParser = express.json({
  limit: '20mb',
  verify: (req: Request, _res, buf: Buffer) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  },
});
app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    req.method === 'POST' &&
    (ARTIFACT_UPLOAD_PATH.test(req.path) ||
      REPLAY_INGEST_PATH.test(req.path) ||
      LOG_INGEST_PATH.test(req.path) ||
      INFRA_HEALTH_INGEST_PATH_RE.test(req.path))
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

// Native PR service for Agent Hub-hosted projects. The afterBaseBranchMoved
// hook is the ONLY mirror trigger for merges and reverts — `git update-ref`
// in the bare repo does not fire the post-receive hook (only receive-pack
// does), so those paths push the moved base branch to GitHub themselves.
// Constructed before initAutoGit so the session "Create PR" flow can
// create native PRs too.
const nativePr = createNativePrService({
  stmts: stmts!,
  broadcast,
  afterBaseBranchMoved: async ({ project, baseBranch }) => {
    // Native merges and reverts move the base branch via `update-ref` — no
    // post-receive hook fires — so EVERY downstream reaction to "default
    // branch moved" hangs off this hook: CI on push, the security re-scan,
    // deploy triggers, and the GitHub mirror push.
    void maybeRunPushCi(project, [`refs/heads/${baseBranch}`], { stmts: stmts!, broadcast });
    void maybeRunPushSecurityScan(project, [`refs/heads/${baseBranch}`], {
      stmts: stmts!,
      broadcast,
      autofix: securityAutofixDeps(),
    });
    // Both a merge and a revert are the `merge` deploy-trigger event: enqueue
    // a deployment for any environment whose merge trigger matches the moved
    // base branch. A revert that isn't deployed hasn't really been undone.
    void maybeRunDeployTriggers(project, 'merge', [`refs/heads/${baseBranch}`], {
      broadcast,
      config,
      findProject,
    });
    // A merge may have completed the last session/epic a release gate is waiting
    // on — nudge an off-cadence sweep so the gate fires promptly (the minute
    // sweep is the backstop).
    requestReleaseGateSweep('base-branch-moved');
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

function getDesignsRoot(): string {
  return path.join(_activeDataDir, 'designs');
}
ensureDesignsRoot(getDesignsRoot());

// Crash-safe cleanup: remove any per-session Cursor `.cursor/rules` files a
// previous run left behind (a crash / SIGKILL skips the per-spawn close
// handler). This makes the on-disk Hub rule delivery safe even in shared/real
// project directories, where a lingering always-apply file would otherwise
// steer later unrelated Cursor sessions.
try {
  const sweptCursorRules = sweepOrphanedCursorRuleFiles();
  if (sweptCursorRules > 0) {
    console.log(`[startup] Swept ${sweptCursorRules} orphaned Cursor session rule file(s).`);
  }
} catch (err: unknown) {
  console.warn(
    '[startup] Cursor rule sweep failed:',
    err instanceof Error ? err.message : String(err),
  );
}

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
  prepareSessionEnv: (sessionId: string) => prepareAutonomousSessionEnv(sessionId),
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
  const target = parsePreviewSubdomainHost(req.headers.host, base);
  if (!target) return next();
  // Preserve the original suffix (query string included). Express
  // strips the host from req.url already, so it's just `/some/path?q=v`.
  req.url = previewSubdomainRewrittenUrl(target, req.url);
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

const UPLOADS_DIR = resolveUploadsDir(config, __dirname);
migrateLegacyUploads({
  legacyUploadsDir: config.legacyUploadsDir,
  uploadsDir: UPLOADS_DIR,
  markerPath: path.join(config.dataDir, 'migrations', 'legacy-server-uploads-v1'),
});
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

// Session design-mode artifact files → `/session-files/<sessionId>/design/*`.
// Mirrors the `/design-files` mount but sources from the session's own store:
// a dev-project session serves from its *worktree* `design/` dir; a workflow
// (no-code) session serves from the Hub data-dir store
// (`<dataDir>/design-sessions/<sessionId>/`). This is what the in-session
// Design-mode canvas pane renders (see SessionDesignModePane / DesignCanvas on
// the web client). Handler + guards live in session-files-mount.ts so they
// unit-test without booting the server.
app.use(
  '/session-files/:sessionId/design',
  createSessionDesignFilesHandler({
    getSession: (id) => stmts!.getSession.get(id) as SessionRow | undefined,
    dataDir: config.dataDir,
  }),
);

// Hub-hosted repo README images: `![alt](docs/media/x.png)` refs are repo-
// relative and would 404 against the SPA origin, so the README image slots
// render blank. The client rewrites relative image srcs to this mount, which
// streams the raw image blob out of the bare repo. Non-`/api/` path so an
// `<img>` (which can't send the SPA bearer token) still loads it; image-only
// content types keep it from becoming a general repo-file exfil channel.
app.use(
  '/git-host-media/:projectId',
  createGitHostMediaHandler({
    findProject: (id) => findProject(id) ?? null,
    validateToken: (projectId, branch, token) =>
      validateGitHostMediaToken(projectId, branch, token),
    readBlob: (projectId, filePath, branch) => readRepoBlob(projectId, filePath, branch),
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
export const activeProcesses = new Map<
  string,
  import('./active-chat-process.js').ActiveChatProcess
>();

// ─── Preview runtime ────────────────────────────────────────────────────
//
// The reaper is scheduled below the runtime construction so it picks up
// the same instance the chat handler + session archive hooks use; a
// per-tick orphan check tears down rows whose project has been deleted
// out from under them.
// Docker-aware: `AGENT_HUB_PREVIEW_HEALTH_HOST` (e.g. `host.docker.internal`)
// only reaches a preview port when the Hub actually runs in a container across
// the docker-host boundary. With docker features disabled the preview runs
// co-resident on the host adapter and answers on loopback, so the readiness
// probe (and the proxy, via `resolvePreviewUpstreamHost`) must ignore the
// gateway and fall back to the runtime's `http://127.0.0.1:<port>` default —
// otherwise the probe dials a dead gateway port and the preview hangs
// "starting". See resolvePreviewHealthHost.
const previewHealthHost = resolvePreviewHealthHost() ?? undefined;
const previewUrlBase = createPreviewUrlBase(config.publicUrl);
const { devServerRuntime } = createPreviewRuntimes({
  db: getDb(),
  getProject: (id) => findProject(id) ?? null,
  // Containerized sessions must run their preview in the boundary the
  // session already owns; on the host adapter there is no boundary, so the
  // runtime keeps its own env and its reserved-port allocator.
  resolveSharedEnv: async (sessionId) => {
    await whenSessionEnvSelectionReady();
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    const project = session ? findAgent(session.agent_id)?.project : null;
    const adapter = resolveSessionEnvAdapterForSession({ project, session });
    if (adapter === 'host') return null;
    return sessionEnvManager.ensure(sessionId);
  },
  onSessionActivity: (sessionId) => {
    sessionEnvManager.get(sessionId)?.touch();
  },
  devServerConfig: {
    urlBase: previewUrlBase,
    // Per-entry proxy URL: primary keeps the root mount, extra ports resolve to
    // their `/p/<internalPort>` sub-mount. Env-scoped dial targets never use
    // localhost — the Hub proxy reaches container / guest IPs instead.
    portClientUrl: ({ sessionId, hostPort, internalPort, primary }) => {
      const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
      const project = session ? findAgent(session.agent_id)?.project : null;
      const adapter = resolveSessionEnvAdapterForSession({ project, session });
      const routing = resolveSessionEnvPortRouting();
      const useProxy =
        adapter === 'firecracker' ||
        adapter === 'sysbox' ||
        (adapter === 'container' && routing === 'container-ip');
      return resolveDevServerPortClientUrl(
        config.publicUrl,
        sessionId,
        hostPort,
        internalPort,
        primary,
        { useProxy },
      );
    },
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
  notifyStatus: ({ sessionId, groupId, status, port, url, logTail, error, ports }) => {
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
          // Multi-port dev servers ship their port list so the pane can
          // render a selector; a single-port group omits it (see
          // getClientPorts / previewSnapshotEventFromRow).
          ...(ports && ports.length > 1 ? { ports } : {}),
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

// Hub-owned background shells — long-running commands that survive across
// chat turns (the durable answer to "background Bash can't be monitored
// after the turn ends"). Reaped on session delete/archive via
// `stopBySessionId` in routes/sessions.ts.
const backgroundShellRuntime = createBackgroundShellRuntime({
  db: getDb(),
  dataDir: _activeDataDir,
  broadcast: (event) => {
    try {
      broadcast(event as unknown as Record<string, unknown>);
    } catch {
      /* best-effort — never let a broadcast failure stall the runtime */
    }
  },
});

/**
 * Write a `role: 'system'` transcript line for the watch loop and push it to
 * connected clients. Function declaration so it is hoisted above the watcher
 * construction below.
 */
function persistWatchSystemMessage(
  sessionId: string,
  content: string,
  meta: Record<string, unknown>,
): void {
  const msgId = uuidv4();
  const metadata = JSON.stringify(meta);
  stmts!.addMessage.run(
    msgId,
    sessionId,
    'system',
    content,
    null,
    null,
    null,
    metadata,
    null,
    null,
    null,
  );
  stmts!.touchSession.run(sessionId);
  const message = (stmts!.getMessageById.get(msgId) as MessageRow | undefined) ?? {
    id: msgId,
    session_id: sessionId,
    role: 'system' as const,
    content,
    engine: null,
    model: null,
    attachments: null,
    metadata,
    created_at: new Date().toISOString(),
  };
  broadcast({ type: 'message_added', sessionId, message });
}

// The watch loop: when a watched background shell finishes, wake its session
// with the result instead of leaving it idle forever. Dispatches through the
// same `handleChat(null, …)` seam as the queue drain and ReAct continuations.
const backgroundShellWatcher = new BackgroundShellWatcher({
  runtime: backgroundShellRuntime,
  getSession: (sessionId) => stmts!.getSession.get(sessionId) as SessionRow | undefined,
  isSessionBusy: (sessionId) =>
    isSessionChatBusy(
      sessionId,
      activeProcesses,
      stmts!.getActiveTask.get(sessionId) as ActiveTaskRow | undefined,
    ),
  isSessionFinalizing: (sessionId) => Boolean(stmts!.getActiveFinalizeRunForSession.get(sessionId)),
  dispatchChat: (msg) => handleChat!(null, msg as unknown as ChatMessage),
  persistSystemMessage: (sessionId, content, meta) =>
    persistWatchSystemMessage(sessionId, content, meta),
  listUnreportedCompletions: () =>
    getDb()
      .prepare(`SELECT * FROM background_shells WHERE watch = 1 AND status != 'running'`)
      .all() as BackgroundShellRow[],
});

// The session's environment, owned by the session rather than by whichever
// feature happened to start first. Preview, terminal, and session commands
// all resolve the same env from here, so they share one filesystem, one set
// of backing services, and one network.
// Opened once the boot GC sweep settles. Creating an env before then races the
// sweep, which would delete the new container as a leak — see
// SessionEnvManagerDeps.bootSweep.
let openSessionEnvBootGate: () => void = () => {};
const sessionEnvBootSweep = new Promise<void>((resolve) => {
  openSessionEnvBootGate = resolve;
});

const sessionEnvManager = new SessionEnvManager({
  bootSweep: sessionEnvBootSweep,
  resolveWorktree: (sessionId) => {
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) return null;
    const project = findAgent(session.agent_id)?.project;
    return resolveSessionWorktreePath({
      worktreePath: session.worktree_path,
      useWorktree: session.use_worktree,
      deletedAt: session.deleted_at,
      projectCwd: project?.cwd ?? null,
      projectMode: getProjectMode(project),
    });
  },
  // Workflow → host; isolated → firecracker when registered; chat never uses
  // firecracker even if the global adapter is still pinned to it.
  resolveAdapter: (sessionId) => {
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    const project = session ? findAgent(session.agent_id)?.project : null;
    return resolveSessionEnvAdapterForSession({ project, session });
  },
  resolveStartupCommands: (sessionId) => {
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    if (!session || session.deleted_at) return [];
    const project = findAgent(session.agent_id)?.project;
    if (!project) return [];
    return getProjectSessionStartupCommands(project);
  },
  onStartupProgress: (update) => {
    emitSessionStartupProgress({
      stmts: stmts!,
      broadcast,
      sessionId: update.sessionId,
      status: update.stepStatus,
      startedAt: update.startedAt,
      finishedAt: update.finishedAt,
      detail: update.detail,
    });
  },
  onEnvLaunchProgress: (update) => {
    emitSessionEnvLaunchProgress({
      stmts: stmts!,
      broadcast,
      sessionId: update.sessionId,
      status: update.status,
      startedAt: update.startedAt,
      finishedAt: update.finishedAt,
      detail: update.detail,
    });
  },
  resolvePublishPorts: (sessionId) => {
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    if (!session || session.deleted_at) return null;
    const project = findAgent(session.agent_id)?.project;
    if (!project) return null;
    const parsed = parseDevServerConfig(project.prEnv?.devServer ?? {});
    if (!parsed.ok) return [DEFAULT_DEV_SERVER_PORT_ENTRY.internalPort];
    return resolveDevServerPortEntries(parsed.value).map((e) => e.internalPort);
  },
  // Published-ports adapters need unique host ports per session; identity
  // mapping (internal===host) collides when two sessions share port 5173.
  allocateHostPort: () => allocateEphemeralHostPort(),
  releaseHostPort: (hostPort) => releaseEphemeralHostPort(hostPort),
});

// allocateEphemeralHostPort / releaseEphemeralHostPort live in
// session-env/ephemeral-host-port.ts (in-process reservation until Docker binds).

/**
 * Read/write access to a session's worktree, wherever it lives.
 *
 * Under a `host-shared` backend the host directory is authoritative, so this
 * answers from it directly — reading the Changes pane must not boot a
 * container. Under `env-owned` (microVM) the guest holds the only current copy,
 * so the env has to be running and we `ensure` it.
 *
 * `ensure` can therefore boot a VM to answer a read. That is deliberate: the
 * alternative is reporting a session as having no changes because its env is
 * idle, which is the stale-read bug this seam exists to remove. The cost is
 * bounded because the read surfaces are session-scoped — the Changes badge
 * refreshes on activation and on this session's own turn events, not on a
 * background sweep — so an actively-running session already has a live env and
 * this is a no-op for it.
 *
 * Returns null when the session has no worktree at all.
 */
async function resolveSessionWorktreeIo(sessionId: string): Promise<SessionWorktreeIo | null> {
  await whenSessionEnvSelectionReady();
  const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) return null;
  const project = findAgent(session.agent_id)?.project;
  const worktreePath = resolveSessionWorktreePath({
    worktreePath: session.worktree_path,
    useWorktree: session.use_worktree,
    deletedAt: session.deleted_at,
    projectCwd: project?.cwd ?? null,
    projectMode: getProjectMode(project),
  });
  if (!worktreePath) return null;
  const adapter = resolveSessionEnvAdapterForSession({ project, session });
  if (worktreeSharingForKind(adapter) === 'host-shared') {
    return new HostWorktreeIo(worktreePath);
  }
  return (await sessionEnvManager.ensure(sessionId)).worktreeIo;
}

// Modules below the route layer (chat-turn hooks, auto-commit) reach the
// worktree through this registry rather than a threaded dependency.
setSessionWorktreeIoResolver(resolveSessionWorktreeIo);

// Enrichment paths that omit `project` (WS broadcasts, most routes) resolve the
// owning project here so client capability flags (can_isolated_mode /
// can_design_mode) stay authoritative instead of assuming a non-workflow
// project. See enrichSessionForClient.
setSessionProjectResolver((row) => findAgent(row.agent_id)?.project ?? null);

// One persistent terminal shell per Agent Hub session, in the session's own
// environment. It no longer depends on a dev server having been started:
// under container-IP routing a port can be published at any time, so there is
// nothing to declare up front and no reason to make a shell wait on a preview.
export const ptyHost = new PtyHost({
  createSession: (sessionId) => {
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    if (!session || session.deleted_at) throw new Error('Session not found');
    const found = findAgent(session.agent_id);
    if (!found) throw new Error('Session agent not found');

    return new PtySession({
      sessionId,
      // Resolved on first attach: starting a container takes seconds, and
      // the env may already exist because the preview started it.
      env: () => sessionEnvManager.ensure(sessionId),
      // Same project AWS profiles the agent's spawns get, so `aws --profile
      // <name>` in the Terminal tab resolves instead of erroring out.
      shellEnv: (env) => buildTerminalShellEnv(found.project, { envKind: env.kind }),
    });
  },
});

if (process.env.NODE_ENV !== 'test' && !process.env.AGENT_HUB_TEST_MODE) {
  // Scheduled per the reaper's documented contract — every 60 s, scan
  // `worktree_preview_groups` and tear down idle / orphaned rows, so a
  // preview that never received a `touch` (e.g. the WS session dropped)
  // doesn't accumulate.
  //
  // The dev server runs as a managed host process and never touches
  // docker, so this reaper must run on every host including docker-less
  // ones (e.g. a preview of agent-hub itself). The finalize reapers below
  // shell out to `docker` and stay gated on `resolveDockerAvailability()`
  // so a docker-less Hub doesn't throw once a minute forever. See
  // server/docker-availability.ts.
  const dockerAvailability = resolveDockerAvailability();
  if (!dockerAvailability.enabled) {
    console.warn(`[reapers] ${dockerAvailability.reason}; skipping finalize reapers`);
  }

  cron.schedule(
    PREVIEW_REAPER_CRON,
    () => {
      void devServerRuntime.reap(Date.now()).catch((err: unknown) => {
        console.warn('[dev-server-reaper] tick failed:', (err as Error).message);
      });
      // Session environments outlive their previews, so the dev-server reaper
      // above never releases them. A container holding a database and an
      // image cache is not free; reclaim the ones nobody has touched.
      void sessionEnvManager.reap(Date.now()).catch((err: unknown) => {
        console.warn('[session-env-reaper] tick failed:', (err as Error).message);
      });
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

  // Staging checkouts for sessions whose worktree lives in their own env. Kept
  // separate from the container reaper above because the retention rule is
  // different: a run parked at `ready_to_push` has `ended_at` set but still
  // holds the only copy of the commits it validated, so it must survive until
  // the push lands. Not docker-gated — staging is plain git on disk.
  cron.schedule(
    FINALIZE_REAPER_CRON,
    () => {
      void reapFinalizeSourceCheckouts({
        retainRunIds: () =>
          new Set(
            (
              getDb()
                .prepare(
                  `SELECT id FROM finalize_runs
                    WHERE ended_at IS NULL
                       OR status IN ('ready_to_push', 'pushing')
                       OR (status = 'infra_error' AND phase = 'push' AND validated_head_sha IS NOT NULL)`,
                )
                .all() as Array<{ id: string }>
            ).map((r) => r.id),
          ),
      }).catch((err) => {
        console.warn('[finalize-source] reap tick failed:', (err as Error).message);
      });
    },
    { name: 'finalize-source-reaper' },
  );

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

  // Customer-application log retention + quota reaper — bound the dedicated
  // logs.db store by time window and per-project byte quota (decision
  // LOG-STORE). Pure SQLite against logs.db; runs on every Hub.
  cron.schedule(
    LOG_RETENTION_REAPER_CRON,
    () => {
      try {
        runLogRetentionReaper();
      } catch (err) {
        console.warn('[log-retention-reaper] tick failed:', (err as Error).message);
      }
    },
    { name: 'log-retention-reaper' },
  );

  // AWS resource inventory sync (decision INFRA-SCOPE) — hourly describe-API
  // sweep that seeds `infra_resources` for every enabled scope row. Deliberately
  // slower than metric collection: inventory changes at the pace of launches and
  // terminations. It issues AWS calls, so it is wrapped rather than run inline,
  // and it is a no-op on a Hub with no scope rows.
  cron.schedule(
    INFRA_INVENTORY_SYNC_CRON,
    wrapCronTick(() => runInfraInventorySync(), 'infra-inventory-sync'),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(INFRA_INVENTORY_SYNC_CRON),
      name: 'infra-inventory-sync',
    }),
  );

  // AWS metric collection (decision INFRA-COLLECT) — batched GetMetricData
  // against the inventory the sweep above maintains. `noOverlap` comes from
  // defaultTickOptions and is load-bearing here rather than hygienic: a tick
  // that overran into the next one would re-issue the same billed queries
  // against the same window for no new data.
  cron.schedule(
    INFRA_COLLECT_CRON,
    // `broadcast` is passed so a cost-ceiling transition raises an in-app notice
    // rather than only a log line (decision INFRA-COST: the collector "never
    // silently keeps spending"). It fires on the transition, not per tick.
    //
    // Alert evaluation is chained to this tick rather than given its own cron,
    // and the flush between them is what makes the chain correct: points reach
    // the store through a batched write queue, so a sweep on an independent
    // schedule would routinely read the window before the tick that filled it.
    wrapCronTick(async () => {
      const collected = await runInfraMetricCollection({ broadcast });
      flushInfraWriteQueue();
      runInfraAlertEvaluation({ broadcast });
      return collected;
    }, 'infra-metric-collector'),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(INFRA_COLLECT_CRON),
      name: 'infra-metric-collector',
    }),
  );

  // Cost Explorer spend sync (decision INFRA-COST mechanism 5) — three times a
  // day, and no more. AWS updates billing data at most three times daily, so a
  // tighter cadence buys no fresher numbers and costs $0.01 per paginated
  // request with no free tier. The module enforces the same floor against a
  // persisted timestamp, so editing this cron string cannot buy a fourth charge.
  //
  // Deliberately not chained onto the metric collector's tick the way alert
  // evaluation is: that tick runs every five minutes, and anything sharing it
  // would have to re-derive this cadence from scratch.
  cron.schedule(
    INFRA_COST_EXPLORER_CRON,
    wrapCronTick(() => runInfraCostExplorerSync(), 'infra-cost-explorer'),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(INFRA_COST_EXPLORER_CRON),
      name: 'infra-cost-explorer',
    }),
  );

  // Infra metric retention + quota reaper (decision INFRA-STORE) — bound
  // infra.db by age window and per-project byte quota. Pure SQLite, no AWS
  // calls, and a no-op on a Hub whose infra.db never opened.
  cron.schedule(
    INFRA_RETENTION_REAPER_CRON,
    () => {
      try {
        runInfraRetentionReaper();
      } catch (err) {
        console.warn('[infra-retention-reaper] tick failed:', (err as Error).message);
      }
    },
    { name: 'infra-retention-reaper' },
  );

  void runReleaseNotificationOutboxWorker({ broadcast });
  cron.schedule(
    RELEASE_NOTIFICATION_OUTBOX_WORKER_CRON,
    () => {
      void runReleaseNotificationOutboxWorker({ broadcast });
    },
    { name: 'release-notification-outbox-worker', noOverlap: true },
  );
  void runInfraAlertOutboxWorker();
  cron.schedule(
    INFRA_ALERT_OUTBOX_WORKER_CRON,
    () => {
      void runInfraAlertOutboxWorker();
    },
    { name: 'infra-alert-outbox-worker', noOverlap: true },
  );

  // AWS Health ingest commits the event, answers EventBridge inside its
  // 5-second timeout, and fans out afterwards. This sweep re-runs the fan-out
  // for anything that crashed or failed in that window.
  const sweepInfraHealth = (): void => {
    recoverPendingInfraHealthNotifications({
      projectIds: getProjects().map((project) => project.id),
      broadcast,
    });
  };
  sweepInfraHealth();
  cron.schedule(INFRA_HEALTH_RECOVERY_CRON, sweepInfraHealth, {
    name: 'infra-health-notification-recovery',
    noOverlap: true,
  });
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
  drainSessionQueue: (sessionId: string) => drainQueue(sessionId),
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
  getDevServerRuntime: () => devServerRuntime,
  touchSessionEnv: (sessionId) => {
    sessionEnvManager.get(sessionId)?.touch();
  },
  getBackgroundShellRuntime: () => backgroundShellRuntime,
  getBackgroundShellWatcher: () => backgroundShellWatcher,
  disposeSessionEnv: async (sessionId: string, opts: { forgetWorkspace?: boolean } = {}) => {
    // Soft archive must keep the Firecracker workspace disk — it is the only
    // authoritative copy of guest work. Hard purge passes forgetWorkspace.
    const forgetWorkspace = opts.forgetWorkspace === true;
    await sessionEnvManager.dispose(sessionId, { forgetWorkspace });
    if (!forgetWorkspace) return;
    // Idle reap / Hub restart leave the workspace disk. Proven deletion must
    // run whenever the session can own Firecracker artifacts — not only when
    // this boot selected the firecracker adapter (a fallback boot still needs
    // to clean disks created earlier).
    const paths = firecrackerHostPaths();
    const execCfg = resolveFirecrackerExecConfig(paths);
    await forgetPersistedFirecrackerDisks(sessionId, {
      io: createFirecrackerHostIo(execCfg),
      paths,
    });
  },
  transitionSessionEnv: (
    sessionId: string,
    applyTransition: (disposeCurrent: () => Promise<void>) => void | Promise<void>,
  ) => sessionEnvManager.transitionAdapter(sessionId, applyTransition),
  getSessionWorktreeIo: resolveSessionWorktreeIo,
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
    const workspaceStartedAt = Date.now();
    // Only surface the "Preparing session workspace" progress step when there is
    // genuine clone work to do. The open-time ensure runs on every session
    // activation and is a fast no-op reuse for an already-cloned worktree;
    // emitting the step unconditionally made browsing the sidebar flash
    // "Preparing session workspace" on every session (the reported bug).
    const emitWorkspaceProgress = sessionWorkspaceNeedsProvisionProgress(session.worktree_path);
    if (emitWorkspaceProgress) {
      emitSessionWorkspaceProgress({
        stmts: stmts!,
        broadcast,
        sessionId,
        status: 'started',
        startedAt: workspaceStartedAt,
      });
    }
    let worktreePath: string;
    try {
      worktreePath = await ensureWorktree(
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
    } catch (err) {
      if (emitWorkspaceProgress) {
        emitSessionWorkspaceProgress({
          stmts: stmts!,
          broadcast,
          sessionId,
          status: 'failed',
          startedAt: workspaceStartedAt,
          finishedAt: Date.now(),
        });
      }
      throw err;
    }
    if (emitWorkspaceProgress) {
      emitSessionWorkspaceProgress({
        stmts: stmts!,
        broadcast,
        sessionId,
        status: 'completed',
        startedAt: workspaceStartedAt,
        finishedAt: Date.now(),
      });
    }
    // Clone-only. This is a SHARED provisioning primitive: Finalize/RUM setup
    // apply and design import also call it just to materialize the host seed
    // worktree while they copy/commit files. Booting the session VM here would
    // make those non-interactive flows allocate a VM (and run project startup
    // hooks), and a boot failure would turn an already-successful clone into
    // no_worktree. The VM boot is triggered explicitly by the interactive
    // `POST …/workspace/ensure` route (via ensureSessionEnvironment) and by
    // autonomous dispatch (prepareAutonomousSessionEnv).
    return worktreePath;
  },
  ensureSessionEnvironment: async (sessionId: string) => {
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) throw new Error('Session not found');
    const found = findAgent(session.agent_id);
    if (!found) throw new Error('Agent not found');
    // Spike / no-worktree / workflow sessions have no per-session VM.
    if (!sessionUsesWorktree(session) || getProjectMode(found.project) === 'workflow') {
      return;
    }
    await whenSessionEnvSelectionReady();
    await sessionEnvManager.ensure(sessionId);
  },
  switchSessionWorkspaceBranch: async (sessionId: string, branch: string) => {
    const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) {
      throw new Error('Session not found');
    }
    const found = findAgent(session.agent_id);
    if (!found) {
      throw new Error('Agent not found');
    }
    const result = await switchSessionWorkspaceBranch(
      session,
      branch,
      found.project.githubRepo ?? null,
      hostedBarePathForProject(found.project),
    );
    if (result.kind !== 'switched') {
      throw new Error(result.message);
    }
    return { worktreePath: result.worktreePath, branch: result.branch };
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
app.use(createLogSourceRoutes(routeDeps));
app.use(createLogMetricsRoutes(routeDeps));
app.use(createLogQueryRoutes(routeDeps));
app.use(createLogIssueRoutes(routeDeps));
// Write-only customer-log ingest (OTLP/HTTP + Agent Hub JSON batch). Public
// (see auth.ts PUBLIC_METHOD_PATTERNS); self-authenticate from an `ahlog_` token.
app.use(createLogIngestRoutes(routeDeps));
// Write-only AWS Health ingest, targeted by an EventBridge rule in the
// operator's own account. Public on the same terms; self-authenticates from an
// `ahhealth_` token.
app.use(createInfraHealthIngestRoutes(routeDeps));
app.use(createCronRoutes(routeDeps));
app.use(createDesignRoutes({ ...routeDeps, getDesignsRoot }));
app.use(createSkillRoutes(routeDeps));
app.use(createSkillEvalRoutes(routeDeps));
app.use(createBoardRoutes(routeDeps));
app.use(createConfigRoutes(routeDeps));
app.use(createSessionRoutes(routeDeps));
app.use(createArtifactRoutes(routeDeps));
app.use(
  createBackgroundShellRoutes({
    ...routeDeps,
    getBackgroundShellRuntime: () => backgroundShellRuntime,
  }),
);
app.use(createFinalizeRoutes(routeDeps));
app.use(createFinalizeParityRoutes(routeDeps));
app.use(createFinalizeQuarantineRoutes(routeDeps));
app.use(createFinalizeWizardRoutes(routeDeps));
app.use(createFinalizeCiConfigRoutes(routeDeps));
app.use(createDeploymentRoutes(routeDeps));
app.use(createReleaseNotificationSettingsRoutes(routeDeps));
app.use(createProjectBrandingRoutes(routeDeps));
app.use(createProjectRoutes(routeDeps));
app.use(createGitHostRoutes(routeDeps));
app.use(createSecurityAuditRoutes(routeDeps));
app.use(createCiRunsRoutes(routeDeps));
app.use(createProjectStatsRoutes(routeDeps));
app.use(createPullsNativeRoutes(routeDeps));
app.use(createPreviewSecretsRoutes(routeDeps));
app.use(createProjectAwsRoutes(routeDeps));
app.use(createInfraRoutes(routeDeps));
app.use(createInfraAlertRoutes(routeDeps));
app.use(createInfraAlertRoutingRoutes(routeDeps));
app.use(createInfraHealthRoutes(routeDeps));
app.use(createDevServerWizardRoutes(routeDeps));
app.use(createRumWizardRoutes(routeDeps));
app.use(createLogsWizardRoutes(routeDeps));
app.use(createInfraWizardRoutes(routeDeps));
app.use(createRumClientRoutes(routeDeps));
app.use(
  createPreviewInstancesRoutes({
    ...routeDeps,
    getDevServerRuntime: () => devServerRuntime,
  }),
);
app.use(createProvisioningRoutes(routeDeps));
app.use(createJobRoutes(routeDeps));
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
app.use(createMeTodosRoutes(routeDeps));
app.use(createMeDashboardRoutes(routeDeps));
app.use(createMeHubRoutes(routeDeps));
app.use(createMeDailySummaryRoutes(routeDeps));
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
  handleDequeue,
  handleEditQueueItem,
  handleDesignChat: (ws: unknown, msg: DesignChatMessage) =>
    handleDesignChat(ws as WebSocketLike | null, msg),
  handleDesignCancel,
  // Hand the dev-server runtime to the WS connect handler so it can
  // replay active-preview snapshots (state + log tail) to (re)connecting
  // clients. Without this, a client that reconnects after the chat-handler
  // broadcast loop has exited never learns that the preview became ready.
  getPreviewSnapshotRuntime: () => [devServerRuntime],
  // Same rationale as the preview snapshot: a reconnecting client must be able
  // to rebuild the background-shell watch indicator from server state.
  getBackgroundShellSnapshotRuntime: () => backgroundShellRuntime,
});
_broadcast = _wsBroadcast;
setLogBroadcast(_wsBroadcast);

// Ship the Hub's own console output to Agent Hub's log-ingest endpoint when an
// AHLOG_TOKEN is configured. No-op otherwise, so dev/test stay offline.
initLogShipperFromEnv();

const terminalWebSocket = attachTerminalWebSocket(server, {
  ptyHost,
  sessionExists: (sessionId) => {
    try {
      const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
      return Boolean(session && !session.deleted_at);
    } catch {
      return false;
    }
  },
});

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
    getSessionPreviewPort: (sessionId, internalPort) =>
      getSessionPreviewPort(
        sessionId,
        {
          getDevServerRuntime: () => devServerRuntime,
        },
        internalPort,
      ),
    getSessionPreviewHost: (sessionId) => devServerRuntime.getSessionUpstreamHost(sessionId),
  },
  { subdomainBase: config.previewSubdomainBase },
);

const chatHandler = createChatHandler({
  broadcast,
  findAgent,
  getEnrichedAgent,
  activeProcesses,
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
  ensureSessionEnv: async (sessionId: string, opts?: SessionEnvEnsureOpts) => {
    await whenSessionEnvSelectionReady();
    return sessionEnvManager.ensure(sessionId, opts);
  },
  rescheduleCron,
  getDevServerRuntime: () => devServerRuntime,
  getPtyHost: () => ptyHost,
  listWatchedBackgroundShells: (sessionId: string) =>
    backgroundShellRuntime.listWatched(sessionId).map((shell) => ({
      id: shell.id,
      label: shell.label,
      command: shell.command,
      status: shell.status,
      exit_code: shell.exit_code,
    })),
  autoCommitAndPR,
  tryAutonomousDispatch,
} as ChatHandlerDeps);
handleChat = chatHandler.handleChat as (ws: unknown, msg: ChatMessage) => Promise<void>;
saveErrorMessage = chatHandler.saveErrorMessage;
chatHandler.initMultiAgent();

prepareAutonomousSessionEnv = async (sessionId: string) => {
  const session = stmts!.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) throw new Error('Session not found');
  const found = findAgent(session.agent_id);
  if (!found) throw new Error('Agent not found');
  // Spike / no-worktree / workflow sessions have no per-session VM. Skip.
  if (!sessionUsesWorktree(session) || getProjectMode(found.project) === 'workflow') {
    return;
  }
  await routeDeps.provisionSessionWorkspace!(sessionId);
  await whenSessionEnvSelectionReady();
  await sessionEnvManager.ensure(sessionId, { waitForStartup: true });
};

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

setTriggerUncommittedCommitNudge(async ({ sessionId, agent, session, branch, porcelain }) => {
  const result = triggerUncommittedCommitNudge({
    sessionId,
    session,
    agent,
    stmts: stmts!,
    broadcast,
    activeProcesses,
    branch,
    porcelain,
    handleChat: handleChat as TriggerUncommittedCommitNudgeArgs['handleChat'],
  });
  if (result.ok) return { ok: true as const };
  return { ok: false as const, code: result.code, error: result.error };
});

setFinalizeAutomationRouteDeps(routeDeps);
initWikiDocMergeHook({
  stmts: stmts!,
  config,
  findProject,
  findAgent,
  handleChat: (ws, msg) => handleChat!(ws, msg),
  broadcast,
});
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
  if (isSessionWorktreeLocked(sessionId)) return;
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

    // The restart drained this session's CLI child by process *group*, so every
    // background job, dev server, test run and build it had started died too.
    // Both the transcript line and the resume prompt say so explicitly —
    // otherwise the resumed agent keeps polling work the Hub already killed.
    let killedShells: KilledBackgroundShell[] = [];
    try {
      killedShells = backgroundShellRuntime.listBootOrphans(t.session_id).map((row) => ({
        id: row.id,
        command: row.command,
        label: row.label,
      }));
    } catch (err) {
      console.warn(
        `[Resume] Failed to list killed background shells for ${t.session_id}:`,
        (err as Error).message,
      );
    }

    const infoMsgId: string = uuidv4();
    const infoText: string = buildRestartResumeNotice({ partial, killedShells });
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

    const resumeContent: string = buildRestartResumePrompt({
      hasEngineSession: Boolean(session.engine_session_id),
      taskPrompt: t.prompt,
      killedShells,
    });

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
  let terminalShutdownStarted = false;
  const markActiveSessionsForShutdown = (signal: string): void => {
    if (!terminalShutdownStarted) {
      terminalShutdownStarted = true;
      terminalWebSocket.close();
      ptyHost.disposeAll();
      void sessionEnvManager.disposeAll().catch((err: unknown) => {
        console.warn(
          `[session-env] shutdown dispose failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    // Best-effort: flush any records still pending in the log write queue so a
    // graceful restart doesn't lose the tail of a burst.
    try {
      const flushed = flushLogWriteQueue();
      if (flushed > 0)
        console.info(`[shutdown] flushed ${flushed} pending log record(s) (${signal})`);
    } catch (err) {
      console.warn('[shutdown] log write queue flush failed:', (err as Error).message);
    }
    // Same for the metric-point queue: a restart mid-tick would otherwise lose
    // the window the collector already paid AWS to fetch.
    try {
      const flushed = flushInfraWriteQueue();
      if (flushed > 0)
        console.info(`[shutdown] flushed ${flushed} pending metric point(s) (${signal})`);
    } catch (err) {
      console.warn('[shutdown] infra write queue flush failed:', (err as Error).message);
    }
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

  // Close the adapter-selection gate before accept() — early HTTP must wait
  // for the probe rather than caching the host fallback.
  beginSessionEnvSelection();
  server.listen(PORT, HOST, () => {
    const actualPort = (server.address() as AddressInfo).port;
    setActualPort(actualPort);
    console.log(`Agent Hub server running on http://localhost:${actualPort} (bind ${HOST})`);
    console.log(`Loaded ${getProjects().length} projects, ${allAgents().length} agents`);

    // SessionEnv adapter selection: probe sysbox and docker once at boot and
    // cache the choice for the per-session env runtime. Best-effort — a probe
    // failure must not block boot.
    const previewRouting = resolveSessionEnvPortRouting();
    const sessionDocker = resolveDockerAvailability();
    console.log(`[session-env] port routing: ${describeSessionEnvPortRouting()}`);

    // The microVM backend is registered only when the host can actually boot
    // one, so `registeredBackends.has('firecracker')` stays a truthful answer
    // to "would a VM start here" rather than "was this build compiled with
    // the adapter".
    const firecrackerPaths = firecrackerHostPaths();
    const firecrackerExec = resolveFirecrackerExecConfig(firecrackerPaths);
    const firecrackerProbe = probeFirecrackerCapability({
      artifactPaths: [firecrackerPaths.kernelPath, firecrackerPaths.baseRootfsPath],
      // In docker mode the Hub container has neither /dev/kvm nor the VMM
      // binary, so ask the helper what *it* can see.
      ...(firecrackerExec.mode === 'docker' ? createHelperCapabilityDeps(firecrackerExec) : {}),
    });
    console.log(
      `[session-env] microVM probe (${firecrackerExec.mode}): ` +
        (firecrackerProbe.available
          ? `available, ${firecrackerProbe.version}`
          : `unavailable — ${firecrackerProbe.reason}`),
    );
    if (firecrackerProbe.available) {
      const fcDefaults = firecrackerExecDefaults(firecrackerExec);
      console.log(
        `[session-env] firecracker exec=${firecrackerExec.mode} jailer=${fcDefaults.useJailer ? 'on' : 'off'}`,
      );
      registerFirecrackerBackend({
        paths: firecrackerPaths,
        ...fcDefaults,
      });
    }

    void initSessionEnvSelection(
      config.sessionEnvAdapter,
      undefined,
      {
        dockerAvailable: sessionDocker.enabled,
        routing: previewRouting,
        detail: sessionDocker.enabled ? describeSessionEnvPortRouting() : sessionDocker.reason,
      },
      firecrackerProbe,
    )
      .then((selection) => {
        logSessionEnvSelection(selection);
        // The firecracker sweep is deliberately keyed off backend registration,
        // NOT `selection.adapter`: VM mode is opt-in, so the global adapter is
        // usually `host`, yet ahfc0 + guest NAT must still be prepared or the
        // first opt-in VM session fails on tap-create. See runSessionEnvBootSweep.
        return runSessionEnvBootSweep({
          adapter: selection.adapter,
          firecrackerRegistered: () => isFirecrackerBackendRegistered(),
          reconcileSysbox: () => reconcileSysboxSessionEnvs().then(() => undefined),
          reconcileFirecracker: () =>
            reconcileFirecrackerHost({
              run: (argv) => createFirecrackerHostIo(firecrackerExec).run(argv),
              stopStaleVmms: () => stopStaleFirecrackerVmms(firecrackerExec),
            }),
          unregisterFirecracker: () => unregisterFirecrackerBackend(),
        });
      })
      .catch((e) => console.error('[session-env] capability probe failed:', (e as Error).message))
      // Always open the gate, including on a failed probe or sweep: a session
      // env that can never start is worse than one started without the sweep.
      .finally(() => openSessionEnvBootGate());

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

    // Browser capability self-check: launch the bundled Playwright Chromium
    // once and log whether the preview/browser tools can actually screenshot.
    // Fire-and-forget and best-effort — a missing/mislinked Chromium must be
    // loud at boot (operators see it here) instead of surfacing only when an
    // agent first tries to screenshot. See server/Dockerfile PLAYWRIGHT_BROWSERS_PATH.
    void logBrowserCapabilityAtBoot().catch((e) =>
      console.error('[browser] capability check errored:', (e as Error).message),
    );

    const sessionsToResume: ResumeEntry[] = reconcileOrphanedTasks();

    try {
      const drained = drainIdleQueuedSessions({
        stmts: stmts!,
        activeProcesses,
        drainQueue,
      });
      if (drained > 0) {
        console.log(`[QueueDrain] Boot drained idle queues for ${drained} session(s)`);
      }
    } catch (err) {
      console.error('[QueueDrain] Boot drain failed:', (err as Error).message);
    }

    // Background shells that finished while the Hub was down are still armed;
    // deliver those wakes now, then sweep for ones deferred behind a busy
    // session. Unref'd so the timer never holds the process open.
    try {
      backgroundShellWatcher.resumePendingOnBoot();
      setInterval(() => {
        try {
          backgroundShellWatcher.tickAll();
        } catch (err) {
          console.error('[bg-watch] sweep failed:', (err as Error).message);
        }
      }, WATCH_SWEEP_INTERVAL_MS).unref?.();
    } catch (err) {
      console.error('[bg-watch] Boot resume failed:', (err as Error).message);
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

    // Register the once-a-minute release-gate sweep so one-shot gates fire when
    // their sessions/epics complete. Same broadcast/config/findProject wiring.
    try {
      initReleaseGates({ broadcast, config, findProject });
    } catch (e) {
      console.error('[release-gate] init on boot', (e as Error).message);
    }

    // Register node-cron tasks for every enabled scheduled epic start so a
    // configured epic kicks off its phase sweep at its scheduled local time
    // without a restart.
    try {
      initEpicStartSchedules({ getProjects });
    } catch (e) {
      console.error('[epic-start-schedule] init on boot', (e as Error).message);
    }

    // Register the once-a-minute ticker that auto-refreshes each user's Hub
    // Daily Summary at their configured local times, reusing their own engine
    // credentials (same path as the on-demand POST).
    try {
      initDailySummarySchedules({
        routeDeps,
        listSchedules: listUsersWithDailySummarySchedule,
        generate: generateDailySummary,
      });
    } catch (e) {
      console.error('[daily-summary-schedule] init on boot', (e as Error).message);
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
        autofix: securityAutofixDeps(),
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
