import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import { resolveSessionCliSpawnEnv, EngineAuthRequiredError } from '../per-user-cli-spawn.js';
import { resolveEffectiveEngineAndModel, resolveEffectiveModel } from '../effective-model.js';
import {
  CreateSessionRequestSchema,
  PatchSessionRequestSchema,
  ToggleEnabledRequestSchema,
  PutSessionEngineRequestSchema,
  PutSessionModelRequestSchema,
  PutSessionReasoningEffortRequestSchema,
  PutSessionModeRequestSchema,
  PutSessionLinkedDesignRequestSchema,
  PutSessionWorktreeBranchRequestSchema,
  RewindRequestSchema,
  PatchCheckpointRequestSchema,
  SubmitSessionCredentialRequestSchema,
  FollowUpSessionRequestSchema,
  AddSessionAgentRequestSchema,
  PutSessionAgentModelRequestSchema,
} from './sessions.openapi.js';
import {
  normalizeSessionMode,
  isSkillBuilderEligibleAgent,
  defaultSessionModeForProject,
  isShippingCompatibleSessionMode,
  type SessionMode,
} from '../session-mode.js';
import {
  isFirecrackerBackendRegistered,
  resolveSessionEnvAdapterForSession,
} from '../session-env/resolve-session-adapter.js';
import {
  buildFollowUpSeedMessage,
  buildFollowUpSessionName,
  findLatestFinalizeSummary,
  MAX_FOLLOW_UP_TRANSCRIPT_MESSAGES,
} from '../session-follow-up.js';
import {
  isWorkflowProject,
  sessionCanUseDesignMode,
  validateFinalizeAutomationForProject,
  validateSessionModeForProject,
} from '../project-mode-guards.js';
import { listSessionDesignFiles, listSessionDesignFilesAtRoot } from '../session-design-files.js';
import { resolveDesignLocationForServe } from '../design-artifact-store.js';
import { isTruncatedPayload, rehydrateTruncatedEvent } from '../session-events-store.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { appendCodexShellEnvironmentPolicyArgs } from '../codex-exec-sandbox.js';
import { markSessionTermination } from '../process-termination.js';
import { clearEphemeralBackgroundBash } from '../ephemeral-background-bash.js';
import { getDb } from '../db.js';
import { readAll } from '../db-async/read-facade.js';
import {
  buildSessionRunSnapshot,
  buildAggregationSkippedRunSnapshot,
  getSnapshotAggregateLimit,
} from '../session-run-snapshot.js';
import {
  applyMessagesLimitQuery,
  buildSessionMessagesHttpBody,
  sendSessionMessagesJson,
} from '../session-messages-response.js';
import {
  isPaginatedMessagesQuery,
  parseBeforeMessageId,
  parseMessagesPageSize,
  toAscendingPage,
} from '../session-messages-pagination.js';
import type {
  RouteDeps,
  AppConfig,
  MessageRow,
  SessionRow,
  BackgroundTaskRow,
  SessionEventRow,
  SessionProgressRow,
  CheckpointRow,
  KanbanCardRow,
  KanbanEpicRow,
  KanbanBoardRow,
  SkillInvocationRow,
  Project,
  FinalizeRunRow,
} from '../types.js';
import {
  resolveFinalizeBaseBranchForCard,
  resolveFinalizeGateBase,
} from '../finalize/resolve-base-branch.js';
import { mergeSkillCredentialSpawnEnv } from '../skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from '../project-secrets-spawn.js';
import { mergeProjectAwsSpawnEnv } from '../project-aws-spawn.js';
import { buildExtractSkillKickoffPrompt, buildExtractSkillSessionName } from '../skill-extract.js';
import { buildActiveTasksSnapshot } from '../active-tasks.js';
import { inferPrUrlFromSessionTitle } from '../session-title-pr.js';
import { checkWorktreeChanges } from '../auto-git.js';
import { hasPublishableChanges, makeNetDiffProbe } from '../finalize/net-diff.js';
import { syncLinkedCardToSessionStatus } from '../session-card-status.js';
import {
  computeSessionChanges,
  computeFileDiff,
  listSessionChangedPaths,
  resolveWorktreeRelativePath,
} from '../session-changes.js';
import { HostWorktreeIo, type SessionWorktreeIo } from '../session-env/worktree-io.js';
import { closeBrowserSession } from '../browser.js';
import {
  normalizeOrchestrationMetaInput,
  parseOrchestrationMetaJson,
  parseOrchestrationPhase,
} from '../orchestration.js';
import {
  defaultSessionUseWorktreeFlag,
  getProjectMode,
  sessionUsesWorktree,
} from '../project-mode.js';
import {
  resolveOwnerUserId,
  setSessionOwner,
  inheritOwnerFromSession,
  userOwnsSession,
  userCanReadSession,
  getSessionOwner,
} from '../session-ownership.js';
import { requireRole } from '../roles.js';
import {
  startSessionPreview,
  type StartSessionPreviewDeps,
} from '../preview/start-session-preview.js';
import { createPreviewProxyHandler } from '../preview/preview-proxy.js';
import { getSessionPreviewPort } from '../preview/session-preview-port.js';
import {
  getSessionPreviewStateEvent,
  type SessionPreviewStateRuntime,
} from '../preview/get-session-preview-state.js';
import { mintPreviewTicket, PREVIEW_TICKET_TTL_MS } from '../preview-auth.js';
import type { DevServerPortLookup } from '../preview/preview-runtime-lookup.js';
import { triggerSessionShip, markSessionFinalizeAutomation } from '../session-ship.js';
import { getUserProjectDefaultFinalizeAutomation } from '../user-project-settings.js';
import {
  enrichSessionForClient,
  engineSupportsCheckpointRewind,
} from '../session-checkpoint-rewind.js';
import { computeSessionState } from '../session-state.js';
import { enrichSessionWithAgents } from '../session-agents.js';
import { getDesign } from '../designs-store.js';
import { getActiveOrgId } from '../orgs.js';
import type { AuthenticatedRequest } from '../auth.js';
import {
  readCodexModelsCacheForUser,
  resolveSelectableCodexModels,
} from '../codex-model-capability.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import {
  acquireSessionWorktreeLock,
  isSessionWorktreeLocked,
  releaseSessionWorktreeLock,
  tryAcquireSessionWorktreeLock,
} from '../session-worktree-lock.js';
import {
  consumeSessionCredentialRequest,
  getSessionCredentialRequestStatus,
  submitSessionCredentialRequest,
  SessionCredentialRequestError,
} from '../session-credential-requests.js';

/**
 * A session row joined with its parent cron's metadata, as returned by
 * `stmts.getAllCronSessions`. The extra columns don't exist on `sessions`
 * itself — the cron row is the authoritative source of `project_id` (cron
 * sessions use the `_cron` pseudo agent) and `cron_shared` drives sidebar
 * visibility.
 */
type CronSessionRow = SessionRow & {
  cron_name: string | null;
  cron_schedule: string | null;
  project_id: string | null;
  cron_shared: number | null;
};

function safeParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s) as Record<string, unknown>;
    // Rows clamped at insert time persist as a truncation envelope with no
    // `type`. Rehydrate a renderable/pairable event so the UI doesn't fall
    // through to its "unhandled event" placeholder on reload.
    if (isTruncatedPayload(parsed)) return rehydrateTruncatedEvent(parsed);
    return parsed;
  } catch {
    return { type: 'unknown', text: s };
  }
}

/**
 * Validate `req.body` against a Zod schema. On failure, writes a 400 with
 * `{error, details}` and returns `undefined`; the handler must `return`
 * immediately. On success, returns the parsed data (typed).
 *
 * Mirrors the helper in `agents.ts` / `board.ts` / `wiki.ts` so the wire
 * shape of validation failures is identical across route groups.
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

function closeBrowserBestEffort(sessionId: string): void {
  void closeBrowserSession(sessionId).catch((err) => {
    console.warn(
      `[sessions] closeBrowserSession failed (${sessionId}):`,
      err instanceof Error ? err.message : String(err),
    );
  });
}

export function buildTranscript(
  messages: Array<{ role: string; content: string; agent_name?: string | null }>,
  { agentName, isRoom }: { agentName?: string; isRoom?: boolean },
): string {
  return messages
    .map((m) => {
      const label =
        m.role === 'user' ? 'User' : isRoom ? m.agent_name || 'Agent' : agentName || 'Assistant';
      return `[${label}]:\n${m.content}`;
    })
    .join('\n\n');
}

/**
 * The system prompt + user prompt used for auto-summarization passes.
 * Exported so tests can assert against the same text without re-deriving it.
 */
export const SUMMARIZE_SYSTEM_PROMPT = [
  'You are a concise summarizer. You will receive a conversation transcript.',
  'Produce a clear, well-structured summary that captures:',
  '- Key decisions made',
  '- Action items and outcomes',
  '- Important context and technical details',
  '- Any unresolved questions',
  'Use markdown formatting. Be thorough but concise — aim for ~20-30% of the original length.',
  'Do NOT add commentary — just the summary.',
].join(' ');

export function buildSummarizeUserPrompt(transcript: string): string {
  return `Summarize this conversation:\n\n${transcript}`;
}

/**
 * Build the bin + argv tuple used by summarizeTranscript() to invoke each
 * supported engine. Extracted as a pure function so tests can assert that
 * non-interactive flags (e.g. cursor-agent's `--force` to bypass the
 * Workspace Trust prompt) are wired correctly without spawning a process.
 *
 * Why `--force` for cursor-agent: cursor-agent gates non-interactive runs
 * behind a Workspace Trust prompt unless one of `--trust`, `--yolo`, or `-f`
 * (alias of `--force`) is passed. Without it the auto-summarize spawn hangs
 * on the prompt and exits 1, which is the failure mode this helper fixes.
 * `--force` matches what `server/chat.ts` already passes for cursor-agent
 * resume so behaviour stays consistent across spawn sites.
 */
export function buildSummarizeSpawnArgs(
  { engine, model }: { engine: string; model?: string },
  config: AppConfig,
): { bin: string; args: string[] } {
  const CLAUDE_BIN = config.claudeBin;
  const CURSOR_BIN = config.cursorBin;
  const GEMINI_BIN = config.geminiBin;
  const DEFAULT_MODEL =
    config.engineDefaultModels?.[engine] || config.engineValidModels?.[engine]?.[0] || '';
  const systemPrompt = SUMMARIZE_SYSTEM_PROMPT;
  // The transcript itself is provided by the caller; here we only need a
  // placeholder positional arg so non-cursor branches keep the same shape.
  // Callers replace this with the real prompt before spawning.
  const userPromptPlaceholder = '';

  if (engine === 'cursor-agent') {
    return {
      bin: CURSOR_BIN,
      args: [
        '--print',
        '--force',
        '--model',
        model || DEFAULT_MODEL,
        '--system-prompt',
        systemPrompt,
        userPromptPlaceholder,
      ],
    };
  }
  if (engine === 'gemini-cli') {
    // Gemini CLI doesn't have a --system-prompt flag — concatenate into
    // the prompt body like we do in slack.ts runAgent().
    const args: string[] = ['-p', userPromptPlaceholder];
    if (model && model !== 'auto') {
      args.push('--model', model);
    }
    return { bin: GEMINI_BIN, args };
  }
  if (engine === 'codex-cli') {
    // Codex exec has no `--system-prompt` flag — concatenate into the body.
    // `--skip-git-repo-check` lets us run outside a git cwd, and
    // `--sandbox read-only` keeps the summary pass from mutating anything.
    const args: string[] = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
    if (model) {
      args.push('--model', model);
    }
    args.push(userPromptPlaceholder);
    return { bin: config.codexBin, args };
  }
  if (engine === 'grok-cli') {
    // Grok Build CLI has no `--system-prompt` flag — the caller concatenates the
    // system prompt into the placeholder body before spawning (the `grok-cli`
    // arm of the `gemini-cli || codex-cli || grok-cli` branch in
    // `summarizeTranscript`, which is about prompt ASSEMBLY, not output parsing).
    //
    // Output format is intentionally LEFT AT THE DEFAULT (`plain`), NOT
    // `streaming-json`. `summarizeTranscript` collects the child's raw stdout
    // and resolves `output.trim()` directly — it does NOT run the result through
    // `createStreamParser` / `normalizeGrok`. Requesting streaming-json here
    // would make the "summary" a blob of raw JSON-RPC events instead of text,
    // exactly like it would for the Gemini summarize path (also plain `-p`).
    const args: string[] = ['-p', userPromptPlaceholder, '--no-auto-update'];
    if (model) {
      args.push('--model', model);
    }
    return { bin: config.grokBin, args };
  }
  return {
    bin: CLAUDE_BIN,
    args: [
      '--print',
      '--model',
      model || DEFAULT_MODEL,
      '--system-prompt',
      systemPrompt,
      userPromptPlaceholder,
    ],
  };
}

export function summarizeTranscript(
  transcript: string,
  { engine, model, cwd }: { engine: string; model?: string; cwd?: string },
  config: AppConfig,
  skillCredentialMerge?: { ownerId: string | null; agentId: string; project: Project },
): Promise<string> {
  const systemPrompt = SUMMARIZE_SYSTEM_PROMPT;
  const userPrompt = buildSummarizeUserPrompt(transcript);

  return new Promise((resolve, reject) => {
    // Engine→bin + args mapping. Each CLI has its own flag conventions, so we
    // branch rather than force a common shape. The placeholder positional
    // arg from buildSummarizeSpawnArgs is replaced with the real prompt
    // (or the system+user concatenation for engines without --system-prompt).
    const built = buildSummarizeSpawnArgs({ engine, model }, config);
    const bin = built.bin;
    let args: string[];
    if (engine === 'gemini-cli' || engine === 'codex-cli' || engine === 'grok-cli') {
      // These engines have no --system-prompt; replace the placeholder with
      // the concatenated system + user body.
      const combined = `${systemPrompt}\n\n${userPrompt}`;
      args = built.args.map((a) => (a === '' ? combined : a));
    } else {
      // claude-code / cursor-agent: replace the placeholder with userPrompt;
      // the system prompt is already wired via --system-prompt above.
      args = built.args.map((a) => (a === '' ? userPrompt : a));
    }

    let output = '';
    let errorOutput = '';
    const timeout = config.defaultTimeoutMs;

    const summaryOwnerId = skillCredentialMerge?.ownerId ?? null;
    const spawnEnv = {
      ...resolveSessionCliSpawnEnv({
        cfg: config,
        ownerId: summaryOwnerId,
        credsOwnerId: summaryOwnerId,
        sessionId: null,
        engine,
      }),
    };
    if (skillCredentialMerge) {
      mergeSkillCredentialSpawnEnv(spawnEnv, skillCredentialMerge);
      mergeProjectSecretsSpawnEnv(spawnEnv, {
        projectId: skillCredentialMerge.project.id,
        sessionId: null,
      });
      mergeProjectAwsSpawnEnv(spawnEnv, skillCredentialMerge.project);
    }
    if (engine === 'codex-cli') {
      const promptArg = args.pop();
      appendCodexShellEnvironmentPolicyArgs(args, spawnEnv);
      if (promptArg !== undefined) args.push(promptArg);
    }

    const proc = spawn(bin, args, {
      cwd: cwd || process.env.HOME,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const timer = setTimeout(() => {
      killProcessGroup(proc, 'SIGTERM');
      reject(new Error(`Summary timed out after ${Math.round(timeout / 60000)} minutes`));
    }, timeout);

    proc.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0 || output.trim()) {
        resolve(output.trim());
      } else {
        reject(new Error(errorOutput || `Process exited with code ${code}`));
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export default function createSessionRoutes(deps: RouteDeps): Router {
  const {
    stmts,
    findAgent,
    findProject,
    getEnrichedAgent,
    handleChat,
    config,
    activeProcesses,
    broadcast,
  } = deps;

  interface WorkspaceEnsureState {
    generation: number;
    pending: number;
  }
  const workspaceEnsureStates = new Map<string, WorkspaceEnsureState>();

  function beginWorkspaceEnsure(sessionId: string): void {
    const current = workspaceEnsureStates.get(sessionId);
    workspaceEnsureStates.set(sessionId, {
      generation: (current?.generation ?? 0) + 1,
      pending: (current?.pending ?? 0) + 1,
    });
  }

  function finishWorkspaceEnsure(sessionId: string, succeeded: boolean): void {
    const current = workspaceEnsureStates.get(sessionId);
    if (!current) return;
    const pending = Math.max(0, current.pending - 1);
    const generation = current.generation;
    workspaceEnsureStates.set(sessionId, { generation, pending });
    if (pending > 0) return;
    if (!succeeded) {
      workspaceEnsureStates.delete(sessionId);
      return;
    }

    // Defer until lock waiters have had a chance to acquire. The generation
    // makes this callback belong to the final successful setup batch: a new
    // request invalidates it, and that request schedules its own drain only if
    // it succeeds. Exactly one callback can therefore drain a fast sequence of
    // idempotent overlapping ensures.
    setImmediate(() => {
      const latest = workspaceEnsureStates.get(sessionId);
      if (!latest || latest.generation !== generation || latest.pending !== 0) return;
      workspaceEnsureStates.delete(sessionId);
      if (!isSessionWorktreeLocked(sessionId)) {
        deps.drainSessionQueue?.(sessionId);
      }
    });
  }

  /** Keep a linked kanban card aligned with session archive / restore state. */
  function syncSessionCardBestEffort(sessionId: string, status: 'closed' | 'in-progress'): void {
    try {
      syncLinkedCardToSessionStatus({ stmts, broadcast }, sessionId, status);
    } catch (err) {
      console.warn(
        `[sessions] linked-card ${status} sync failed (${sessionId}):`,
        (err as Error).message,
      );
    }
  }

  /**
   * Stop only the session's running **dev preview** (compose / node process).
   *
   * Must not dispose the session env, kill background shells, or clear Bash
   * notices — those belong to the session, not the preview. Disposing the env
   * here is what made "Stop preview" feel like ending the session and wiping
   * in-env changes (Firecracker/container disk reset to the host seed).
   */
  async function stopPreviewOnlyForSession(sessionId: string): Promise<void> {
    const devServerRuntime = deps.getDevServerRuntime?.();
    if (!devServerRuntime) return;
    try {
      await devServerRuntime.stopBySessionId(sessionId);
    } catch (err: unknown) {
      console.warn(
        `[sessions] dev-server stopBySessionId failed (${sessionId}):`,
        (err as Error).message,
      );
    }
  }

  /**
   * Full session runtime teardown for archive/delete: preview, background
   * shells, ephemeral Bash notices, and the session environment itself.
   *
   * Soft archive keeps the Firecracker workspace disk (`forgetWorkspace:
   * false`) so restore can reattach. Hard purge must pass
   * `forgetWorkspace: true`. Dispose failures propagate — callers must not
   * archive/delete until resource teardown is proven.
   */
  async function teardownSessionRuntime(
    sessionId: string,
    opts: { forgetWorkspace?: boolean } = {},
  ): Promise<void> {
    // The session will never take another turn, so nothing will consume its
    // pending native-background-Bash notice. Drop it rather than leak the rows.
    clearEphemeralBackgroundBash(sessionId);
    const tasks: Promise<unknown>[] = [stopPreviewOnlyForSession(sessionId)];
    const backgroundShellRuntime = deps.getBackgroundShellRuntime?.();
    if (backgroundShellRuntime) {
      // Drop the watcher's in-memory pending wakes before the kill. The
      // runtime disarms the DB rows itself, which the watcher would notice on
      // its next tick anyway, but this session is going away now — nothing
      // should be able to dispatch a wake turn into it in the meantime.
      try {
        deps.getBackgroundShellWatcher?.()?.forgetSession(sessionId);
      } catch (err) {
        console.warn(
          `[sessions] background-shell watcher forgetSession failed (${sessionId}):`,
          (err as Error).message,
        );
      }
      tasks.push(
        backgroundShellRuntime.stopBySessionId(sessionId).catch((err) => {
          console.warn(
            `[sessions] background-shell stopBySessionId failed (${sessionId}):`,
            (err as Error).message,
          );
        }),
      );
    }
    if (deps.disposeSessionEnv) {
      tasks.push(
        deps.disposeSessionEnv(sessionId, {
          forgetWorkspace: opts.forgetWorkspace === true,
        }),
      );
    }
    await Promise.all(tasks);
  }

  const router = Router();

  router.get('/api/agents/:agentId/sessions', (req: Request, res: Response) => {
    const all = stmts.getSessions.all(req.params.agentId) as SessionRow[];
    // Sidebar list = the caller's OWN sessions only. We use the strict
    // `userOwnsSession` predicate (not the permissive `userCanReadSession`)
    // so sessions the caller does not own — including shared reviewer
    // threads and other users' sessions — are hidden from the sidebar.
    // Access is unchanged: any of those can still be opened by id (e.g. a
    // dashboard deep-link), which goes through the permissive read gate on
    // `/api/sessions/:sessionId`. Local / single-tenant / apiKey callers
    // still see everything via the bypasses inside `userOwnsSession`.
    const sessions = all.filter((s) => userOwnsSession(req as AuthenticatedRequest, s.id));
    // All rows belong to this one agent → one project; resolve it once so
    // `can_design_mode` reflects workflow (no-code) projects, not just worktrees.
    const listProject = findAgent(String(req.params.agentId))?.project ?? null;
    res.json(sessions.map((s) => enrichSessionForClient(s, stmts, listProject)));
  });

  router.post('/api/agents/:agentId/sessions', (req: Request, res: Response) => {
    const parsed = parseBody(CreateSessionRequestSchema, req, res);
    if (!parsed) return;
    const id = uuidv4();
    const name = parsed.name || `Session ${new Date().toLocaleString()}`;
    const found = findAgent(req.params.agentId as string);
    // Reviewer agents are spawned exclusively by the GitHub webhook
    // handler (one session per PR, named "Review: PR #N"). Users may
    // not start ad-hoc sessions with a reviewer — the thread is a
    // shared, read-only artifact tied to a specific PR.
    if (found?.agent?.role === 'reviewer') {
      return res.status(403).json({
        error:
          'Reviewer agent sessions are spawned by the GitHub webhook; they cannot be started manually.',
      });
    }
    const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
    const agentIdParam = String(req.params.agentId);
    const { engine, model } = resolveEffectiveEngineAndModel(config, {
      agentId: agentIdParam,
      agentEngine: found?.agent?.engine || 'claude-code',
      agentModel: found?.agent?.model ?? null,
      ownerUserId: ownerUid,
      explicitEngine: parsed.engine,
      explicitModel: parsed.model,
    });
    const requestedMode =
      parsed.session_mode !== undefined
        ? normalizeSessionMode(parsed.session_mode)
        : parsed.ask_mode === true
          ? 'consult'
          : undefined;
    if (requestedMode !== undefined) {
      const modeGuard = validateSessionModeForProject(found?.project, requestedMode);
      if (modeGuard) return res.status(400).json(modeGuard);
      if (requestedMode === 'design') {
        return res.status(400).json({
          error: 'design_mode_requires_worktree',
          message:
            'Design mode requires a session with an isolated worktree. Create the session first, then switch to Design after the worktree is ready.',
        });
      }
      if (requestedMode === 'skill-builder' && !isSkillBuilderEligibleAgent(found?.agent)) {
        return res.status(400).json({
          error: 'skill_builder_requires_dev_agent',
          message:
            "Skill Builder mode is only available on a dev agent — this session's agent " +
            'is a helper (docs / reviewer / skill-builder) and is not eligible.',
        });
      }
      if (requestedMode === 'isolated' && !isFirecrackerBackendRegistered()) {
        return res.status(400).json({
          error: 'isolated_mode_requires_firecracker',
          message:
            'VM mode requires Firecracker on this host (nested virtualization + guest artifacts). ' +
            'It is unavailable here — use a normal chat session or enable Firecracker.',
        });
      }
    }

    const useWorktree = defaultSessionUseWorktreeFlag(found?.project);
    stmts.createSession.run(id, req.params.agentId, name, engine, model, useWorktree, 0, 1);
    setSessionOwner(id, ownerUid);
    if (isWorkflowProject(found?.project)) {
      stmts.updateSessionMode.run(
        requestedMode ?? defaultSessionModeForProject(found?.project),
        id,
      );
    } else if (requestedMode !== undefined && requestedMode !== 'chat') {
      stmts.updateSessionMode.run(requestedMode, id);
    }
    if (
      !isWorkflowProject(found?.project) &&
      found?.project?.id &&
      (requestedMode === undefined || isShippingCompatibleSessionMode(requestedMode))
    ) {
      // Apply this user's per-project default Finalize automation level (if any)
      // to the new ad-hoc session. No stored preference → leave NULL, which the
      // session resolves to the global default ('manual'). Board-assigned and
      // autonomous-dispatch sessions are created elsewhere and keep their own
      // escalation rules (see assignedFinalizeAutomationLevel).
      const userDefault = getUserProjectDefaultFinalizeAutomation(
        stmts,
        ownerUid,
        found.project.id,
      );
      if (userDefault) markSessionFinalizeAutomation(stmts, id, userDefault);
    }
    const session = stmts.getSession.get(id) as SessionRow;
    const sessionWire = enrichSessionForClient(session, stmts, found?.project ?? null);
    deps.broadcast({ type: 'session_created', agentId: req.params.agentId, session: sessionWire });
    res.json(sessionWire);
  });

  router.get('/api/sessions/cron', (req: Request, res: Response) => {
    const all = stmts.getAllCronSessions.all() as CronSessionRow[];
    // A shared cron (crons.shared = 1) is a project-wide scheduled task:
    // list it for every org member, mirroring GET /api/crons. Non-shared
    // cron sessions stay private to their owner. Keeping this in lock-step
    // with `userCanReadSession` (which also treats shared crons as readable)
    // means a shared cron shown in the sidebar can actually be opened —
    // otherwise a listed row would 404 on the per-session read gate.
    const sessions = all.filter(
      (s) => Boolean(s.cron_shared) || userOwnsSession(req as AuthenticatedRequest, s.id),
    );
    res.json(sessions.map((s) => enrichSessionForClient(s, stmts)));
  });

  /**
   * Per-user gate for everything under `/api/sessions/:sessionId`.
   * Returns 404 (not 403) so non-owners can't probe for the existence
   * of another user's sessions. Registered here so the static
   * `/api/sessions/cron` handler above is reached first.
   *
   * Reads (GET, HEAD) use the permissive `userCanReadSession` predicate
   * so shared session types (reviewer threads) are visible to all
   * users. Mutations (POST/PUT/PATCH/DELETE) stay strict — only the
   * owner may write. Reviewer sessions have no owner, so non-owner
   * write attempts hit the NULL-owner branch in `userOwnsSession` and
   * 404 unless the caller is the org owner. That keeps the frontend
   * thread read-only for everyone except automation.
   */
  router.use('/api/sessions/:sessionId', (req, res, next) => {
    const sid = (req.params as { sessionId?: string }).sessionId;
    if (!sid || sid === 'cron') return next();
    // PWA manifest fetches under /preview/proxy/*.webmanifest are allowed
    // unauthenticated by the auth middleware (browsers omit credentials per
    // the App Manifest spec). The auth middleware signals this with
    // `authPreviewManifestBypass`; without honouring it here the request
    // would still 404 on this ownership gate before reaching the proxy
    // handler, leaving browsers parsing this JSON error as a manifest and
    // logging "Manifest: Line 1, column 1, Syntax error".
    if ((req as AuthenticatedRequest).authPreviewManifestBypass) return next();
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const ok = isRead
      ? userCanReadSession(req as AuthenticatedRequest, sid)
      : userOwnsSession(req as AuthenticatedRequest, sid);
    if (!ok) {
      return res.status(404).json({ error: 'Session not found' });
    }
    return next();
  });

  router.get('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const sessionProject = findAgent(session.agent_id)?.project ?? null;
    res.json({
      ...enrichSessionWithAgents(session, stmts, getEnrichedAgent, sessionProject),
      orchestrationMeta: parseOrchestrationMetaJson(session.orchestration_meta ?? null),
    });
  });

  router.get('/api/sessions/:sessionId/messages', async (req: Request, res: Response) => {
    const sid = req.params.sessionId;

    // Opt-in keyset pagination: newest page first, older pages via `?before=`
    // (the oldest loaded message's id). Returns a plain oldest-first array so
    // the response shape matches the legacy endpoint; the client infers
    // "more older messages" from page fullness. The DB-side LIMIT is what
    // keeps a huge post-finalize transcript from loading all at once. Paginated
    // reads stay sync: they are bounded by LIMIT and measured fast.
    if (isPaginatedMessagesQuery(req.query)) {
      const pageSize = parseMessagesPageSize(req.query.limit);
      const before = parseBeforeMessageId(req.query.before);
      const rowsDesc = (
        before !== null
          ? stmts.getMessagesPageBeforeId.all(sid, before, sid, pageSize)
          : stmts.getMessagesPageLatest.all(sid, pageSize)
      ) as MessageRow[];
      res.json(toAscendingPage(rowsDesc));
      return;
    }

    // Unbounded full-transcript load — the measured-slow read this endpoint is
    // known for (a long post-finalize session returns thousands of large rows,
    // and no index shrinks the row set). Route it through the async reader pool
    // so the SQLite work + row marshalling happen off the Node event loop.
    let all: MessageRow[];
    try {
      all = await readAll<MessageRow>(stmts.getMessages, [sid]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'messages_read_failed', message: msg });
      return;
    }
    const limited = applyMessagesLimitQuery(all, req.query.limit);
    const body = buildSessionMessagesHttpBody(limited);
    if (!Array.isArray(body) && body.truncated) {
      console.warn(
        `[Sessions] Truncated messages for session ${req.params.sessionId}: ${body.omitted}/${body.total} omitted`,
      );
    }
    sendSessionMessagesJson(res, body);
  });

  router.get(
    '/api/sessions/:sessionId/credential-requests/:requestId',
    (req: Request, res: Response) => {
      const sessionId = String(req.params.sessionId);
      const requestId = String(req.params.requestId);
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      try {
        const status = getSessionCredentialRequestStatus(sessionId, requestId);
        if (!status) return res.status(404).json({ error: 'Credential request not found' });
        res.json(status);
      } catch (err) {
        if (err instanceof SessionCredentialRequestError) {
          return res.status(err.statusCode).json({ error: err.message });
        }
        throw err;
      }
    },
  );

  router.put(
    '/api/sessions/:sessionId/credential-requests/:requestId',
    (req: Request, res: Response) => {
      const sessionId = String(req.params.sessionId);
      const requestId = String(req.params.requestId);
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const parsed = SubmitSessionCredentialRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid credential request body',
          details: parsed.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        });
      }
      try {
        const status = submitSessionCredentialRequest({
          sessionId,
          requestId,
          ...parsed.data,
        });
        res.json(status);
      } catch (err) {
        if (err instanceof SessionCredentialRequestError) {
          return res.status(err.statusCode).json({ error: err.message });
        }
        throw err;
      }
    },
  );

  router.post(
    '/api/sessions/:sessionId/credential-requests/:requestId/consume',
    (req: Request, res: Response) => {
      const sessionId = String(req.params.sessionId);
      const requestId = String(req.params.requestId);
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      try {
        const consumed = consumeSessionCredentialRequest(sessionId, requestId);
        if (!consumed) return res.status(404).json({ error: 'Credential request not available' });
        res.json(consumed);
      } catch (err) {
        if (err instanceof SessionCredentialRequestError) {
          return res.status(err.statusCode).json({ error: err.message });
        }
        throw err;
      }
    },
  );

  router.post('/api/tasks', (req: Request, res: Response) => {
    const { agentId, prompt } = req.body;
    if (!agentId || !prompt) {
      return res.status(400).json({ error: 'agentId and prompt are required' });
    }

    const found = findAgent(agentId);
    if (!found) return res.status(404).json({ error: `Unknown agent: ${agentId}` });
    // Same gate as POST /api/agents/:agentId/sessions — reviewer agents
    // are not user-startable, including via the background-task path.
    if (found.agent?.role === 'reviewer') {
      return res.status(403).json({
        error:
          'Reviewer agent sessions are spawned by the GitHub webhook; they cannot be started manually.',
      });
    }

    const taskId = uuidv4();
    const sessionId = uuidv4();

    const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
    const { engine, model } = resolveEffectiveEngineAndModel(config, {
      agentId,
      agentEngine: found.agent.engine || 'claude-code',
      agentModel: found.agent.model ?? null,
      ownerUserId: ownerUid,
    });
    const sessionName = `[BG] ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`;
    // Worktree-only — see note above.
    stmts.createSession.run(sessionId, agentId, sessionName, engine, model, 1, 0, 1);
    setSessionOwner(sessionId, resolveOwnerUserId(req as AuthenticatedRequest));

    stmts.insertBackgroundTask.run(taskId, sessionId, agentId, prompt);

    handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: prompt,
    });

    const session = stmts.getSession.get(sessionId) as SessionRow;
    const sessionWire = enrichSessionForClient(session, stmts);
    deps.broadcast({ type: 'session_created', agentId, session: sessionWire });
    res.status(201).json({ taskId, sessionId, session: sessionWire });
  });

  router.get('/api/tasks', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const tasks = (stmts.getBackgroundTasks.all(limit) as BackgroundTaskRow[]).filter((t) =>
      userOwnsSession(req as AuthenticatedRequest, t.session_id),
    );

    const enriched = tasks.map((t) => {
      const agent = getEnrichedAgent(t.agent_id);
      return {
        ...t,
        agentName: agent?.name || t.agent_id,
        agentColor: agent?.color || '#6b7280',
        projectName: agent?.projectName || '',
      };
    });
    res.json(enriched);
  });

  router.get('/api/tasks/:taskId', async (req: Request, res: Response) => {
    const task = stmts.getBackgroundTask.get(req.params.taskId) as BackgroundTaskRow | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!userOwnsSession(req as AuthenticatedRequest, task.session_id)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const agent = getEnrichedAgent(task.agent_id);
    // Same unbounded full-transcript read as GET /messages — off-load to the
    // async reader pool so a large background-task session doesn't stall the loop.
    let messages: MessageRow[];
    try {
      messages = await readAll<MessageRow>(stmts.getMessages, [task.session_id]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'messages_read_failed', message: msg });
      return;
    }
    res.json({
      ...task,
      agentName: agent?.name || task.agent_id,
      agentColor: agent?.color || '#6b7280',
      messages,
    });
  });

  router.post('/api/tasks/:taskId/stop', (req: Request, res: Response) => {
    const task = stmts.getBackgroundTask.get(req.params.taskId) as BackgroundTaskRow | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!userOwnsSession(req as AuthenticatedRequest, task.session_id)) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.status !== 'running') return res.status(400).json({ error: 'Task is not running' });

    const proc = activeProcesses.get(task.session_id);
    if (proc) {
      markSessionTermination(task.session_id, 'task_stopped');
      console.info(
        `[sessions] task_stopped: sending SIGTERM session=${task.session_id} task=${task.id}`,
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 2000);
    }

    stmts.updateBackgroundTaskStatus.run('error', task.id);
    res.json({ ...task, status: 'error' });
  });

  // Cursor-style progress checklist for a session. Used by the in-Hub
  // ProgressPanel to rehydrate state on page-load / session-switch so the
  // panel survives reloads. Steps are ordered by `started_at` ASC, falling
  // back to insertion order for ties.
  router.get('/api/sessions/:sessionId/progress', (req: Request, res: Response) => {
    const rows = stmts.getSessionProgress.all(req.params.sessionId) as SessionProgressRow[];
    const steps = rows.map((r) => ({
      id: r.id,
      step: r.step,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      ...(r.detail ? { detail: r.detail } : {}),
    }));
    res.json({ sessionId: req.params.sessionId, steps });
  });

  /**
   * Rich metadata for the session sidebar: linked kanban card, skill invocations,
   * and aggregated run snapshot (tools / files / context reads) from all message events.
   */
  router.get('/api/sessions/:sessionId/summary', (req: Request, res: Response) => {
    const id = req.params.sessionId;
    const session = stmts.getSession.get(id) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const found = findAgent(session.agent_id);
    const projectId = found?.project?.id ?? null;
    const githubRepo =
      found?.project && typeof found.project.githubRepo === 'string'
        ? found.project.githubRepo
        : null;

    const card = stmts.getKanbanCardBySession.get(id) as KanbanCardRow | undefined;
    let linkedCard: {
      id: string;
      title: string;
      pr_url: string | null;
      review_status: string | null;
      columnName: string | null;
    } | null = null;
    if (card) {
      const col = stmts.getKanbanColumn.get(card.column_id) as { name: string } | undefined;
      linkedCard = {
        id: card.id,
        title: card.title,
        pr_url: card.pr_url,
        review_status: card.review_status,
        columnName: col?.name ?? null,
      };
    }

    const linkedCardPrUrl = linkedCard?.pr_url ?? null;
    const latestFinalizeRun = stmts.getLatestFinalizeRunForSession.get(id) as
      | FinalizeRunRow
      | undefined;
    const finalizePrUrl =
      !linkedCardPrUrl && latestFinalizeRun?.pr_url?.trim()
        ? latestFinalizeRun.pr_url.trim()
        : null;
    const inferredTitlePr = inferPrUrlFromSessionTitle(session.name, githubRepo, {
      gitHost: found?.project?.gitHost ?? null,
      projectId,
    });
    const sessionTitlePrUrl =
      !linkedCardPrUrl && !finalizePrUrl && inferredTitlePr ? inferredTitlePr : null;

    const countRow = stmts.countSessionEventsForSession.get(id) as { c: number } | undefined;
    const eventCount = countRow?.c ?? 0;
    const runSnapshot =
      eventCount > getSnapshotAggregateLimit()
        ? buildAggregationSkippedRunSnapshot(eventCount)
        : buildSessionRunSnapshot(
            stmts.getSessionEventsForSession.all(id) as Array<{
              event_type: string;
              payload: string;
            }>,
          );

    const skillRows = stmts.listSkillInvocationsForSession.all(id) as SkillInvocationRow[];
    const skills = skillRows.map((s) => ({
      id: s.id,
      skillId: s.skill_id,
      status: s.status,
      source: s.source,
      injectedBytes: s.injected_bytes,
      createdAt: s.created_at,
    }));

    res.json({
      session: {
        id: session.id,
        name: session.name,
        engine: session.engine,
        model: session.model,
        updatedAt: session.updated_at,
      },
      projectId,
      projectGithubRepo: githubRepo,
      linkedCard,
      finalizePrUrl,
      sessionTitlePrUrl,
      runSnapshot,
      skills,
    });
  });

  /**
   * Live git status for Finalize / push affordances — uncommitted or unpushed
   * commits in the session worktree.
   */
  router.get('/api/sessions/:sessionId/worktree-changes', async (req: Request, res: Response) => {
    const id = req.params.sessionId as string;
    if (!userOwnsSession(req as AuthenticatedRequest, id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = stmts.getSession.get(id) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.worktree_path) {
      return res.json({
        branch: session.worktree_branch ?? null,
        hasUncommitted: false,
        hasUnpushed: false,
        committable: false,
        headSha: null,
      });
    }
    try {
      const io = await sessionWorktreeIo(session);
      if (!io) return res.status(404).json({ error: 'Session has no worktree' });
      const changes = await checkWorktreeChanges(io);
      // `committable` gates the Finalize/Push buttons. Refine bare unpushed
      // reachability with a net-diff probe so a branch that adds nothing to base
      // (already integrated / net-zero commits) doesn't offer Finalize for an
      // empty diff — keeping the button in lockstep with the Changes-pane count.
      // Probe against the session's real PR base (card/epic pr_base_branch), not
      // just the repo default, so an empty-vs-feature-branch session doesn't
      // offer Finalize (the stacked-PR zero-diff merge case). An authoritative
      // base that cannot be resolved/proven fails closed here, in lockstep with
      // the Finalize action gate (getSessionCommittableChanges).
      const gateCard = stmts.getKanbanCardBySession.get(session.id) as KanbanCardRow | undefined;
      const gateBase = resolveFinalizeGateBase({
        card: gateCard,
        worktreePath: session.worktree_path,
        getEpic: (epicId) => stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
      });
      let committable: boolean;
      if (gateBase.kind === 'unresolved') {
        committable = false;
      } else {
        const explicitBase = gateBase.kind === 'explicit';
        committable = await hasPublishableChanges(
          io,
          changes,
          makeNetDiffProbe(explicitBase ? gateBase.baseBranch : null),
          { explicitBase },
        );
      }
      res.json({
        branch: changes.branch,
        hasUncommitted: changes.hasUncommitted,
        hasUnpushed: changes.hasUnpushed,
        committable,
        headSha: changes.headSha || null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'worktree_status_failed', message: msg });
    }
  });

  // ── Session code-diff pane ────────────────────────────────────────
  // Total session delta (committed + uncommitted + untracked) vs the
  // merge-base with the base branch. Powers the web "Changes" pane.

  /**
   * The session's worktree, wherever it lives. Falls back to the host path for
   * embedders whose wiring predates the seam (tests mount this router with a
   * partial `deps`); that fallback is correct for every `host-shared` backend
   * and is exactly what this code did before.
   */
  async function sessionWorktreeIo(session: SessionRow): Promise<SessionWorktreeIo | null> {
    if (!session.worktree_path) return null;
    if (deps.getSessionWorktreeIo) return await deps.getSessionWorktreeIo(session.id);
    return new HostWorktreeIo(session.worktree_path);
  }

  // Resolve the branch a session should be diffed against. Uses the same
  // card → epic → repo-default chain as Finalize / auto-git so the Changes
  // pane anchors to the session's real PR base, not just the repo default.
  // Returns null when there's no linked card; computeSessionChanges then
  // resolves the repo default itself.
  async function resolveSessionDiffBase(session: SessionRow): Promise<string | null> {
    if (!session.worktree_path) return null;
    const card = stmts.getKanbanCardBySession.get(session.id) as KanbanCardRow | undefined;
    if (!card) return null;
    try {
      return await resolveFinalizeBaseBranchForCard({
        card,
        worktreePath: session.worktree_path,
        getEpic: (epicId) => stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
      });
    } catch {
      // Base resolution is best-effort — fall back to repo default.
      return null;
    }
  }

  router.get('/api/sessions/:sessionId/changes', async (req: Request, res: Response) => {
    const id = req.params.sessionId as string;
    if (!userOwnsSession(req as AuthenticatedRequest, id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = stmts.getSession.get(id) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.worktree_path) {
      return res.json({
        baseBranch: null,
        baseSha: null,
        headSha: null,
        branch: session.worktree_branch ?? null,
        dirty: false,
        files: [],
        truncated: false,
      });
    }
    try {
      const io = await sessionWorktreeIo(session);
      if (!io) return res.status(404).json({ error: 'Session has no worktree' });
      const baseBranch = await resolveSessionDiffBase(session);
      const summary = await computeSessionChanges({ io, baseBranch });
      res.json(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'session_changes_failed', message: msg });
    }
  });

  router.get('/api/sessions/:sessionId/changes/diff', async (req: Request, res: Response) => {
    const id = req.params.sessionId as string;
    if (!userOwnsSession(req as AuthenticatedRequest, id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const file = typeof req.query.file === 'string' ? req.query.file : '';
    if (!file) return res.status(400).json({ error: 'file query parameter is required' });
    const session = stmts.getSession.get(id) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.worktree_path) {
      return res.status(404).json({ error: 'Session has no worktree' });
    }
    // Reject absolute / out-of-worktree paths up front with a clear 400 — the
    // `git diff --no-index` path would otherwise be a server file-read oracle.
    const safeFile = resolveWorktreeRelativePath(file);
    if (!safeFile) return res.status(400).json({ error: 'invalid file path' });
    try {
      const io = await sessionWorktreeIo(session);
      if (!io) return res.status(404).json({ error: 'Session has no worktree' });
      const baseBranch = await resolveSessionDiffBase(session);
      // Authorization is membership-based: only diff a path git itself reports
      // as changed for this session. We gate against the UNTRUNCATED change set
      // (not the capped UI list) so a file past MAX_CHANGED_FILES is still
      // diffable. The `untracked` flag is derived server-side here — never
      // trusted from the client query string.
      const membership = await listSessionChangedPaths({ io, baseBranch });
      const entry = membership.get(safeFile);
      if (!entry) {
        return res.status(404).json({ error: 'file is not part of this session’s changes' });
      }
      const result = await computeFileDiff({
        io,
        baseBranch,
        file: safeFile,
        untracked: entry.untracked,
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'session_file_diff_failed', message: msg });
    }
  });

  router.get('/api/messages/:messageId/events', (req: Request, res: Response) => {
    // Resolve the parent session and gate by ownership — events leak the
    // full tool-use stream of someone else's chat otherwise.
    const message = stmts.getMessageById.get(req.params.messageId) as MessageRow | undefined;
    if (!message || !userOwnsSession(req as AuthenticatedRequest, message.session_id)) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const rows = stmts.getSessionEvents.all('message', req.params.messageId) as SessionEventRow[];
    const events = rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      timestamp: r.timestamp,
      event_type: r.event_type,
      event: safeParse(r.payload),
    }));
    res.json(events);
  });

  router.delete('/api/agents/:agentId/sessions', async (req: Request, res: Response) => {
    const sessions = (stmts.getAllSessionsByAgent.all(req.params.agentId) as SessionRow[]).filter(
      (s) => userOwnsSession(req as AuthenticatedRequest, s.id),
    );
    const archivedIds: string[] = [];
    let failed = 0;
    for (const session of sessions) {
      if (session.deleted_at) continue;
      const proc = activeProcesses.get(session.id);
      if (proc) {
        try {
          markSessionTermination(session.id, 'session_deleted');
          console.info(`[sessions] session_deleted: sending SIGTERM session=${session.id}`);
          proc.kill('SIGTERM');
        } catch {
          /* best-effort */
        }
        activeProcesses.delete(session.id);
      }
      closeBrowserBestEffort(session.id);
      // Same fail-closed contract as single-session archive: never hide the
      // row while a Firecracker VMM / workload may still be running.
      try {
        await teardownSessionRuntime(session.id, { forgetWorkspace: false });
      } catch (err: unknown) {
        failed++;
        console.error(
          `[sessions] refuse bulk archive; runtime teardown failed (${session.id}):`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
      syncSessionCardBestEffort(session.id, 'closed');
      stmts.softDeleteSession.run(session.id);
      archivedIds.push(session.id);
      try {
        deps.broadcast({ type: 'session_deleted', sessionId: session.id });
      } catch {
        /* best-effort */
      }
    }
    const archived = archivedIds.length;
    // Partial failure is not ok — clients must not optimistically drop sessions
    // that stayed live. `archivedIds` is the authoritative removed set.
    res.status(failed > 0 && archived === 0 ? 500 : 200).json({
      ok: failed === 0,
      archived,
      deleted: archived,
      failed,
      archivedIds,
    });
  });

  // Bulk soft-delete (archive) only the sessions whose resolved lifecycle state
  // is `pushed` — i.e. Finalize pushed the branch but the work has not merged
  // yet. Everything else (working / waiting / in-flight Finalize phases /
  // merged) is left untouched. A session with an active CLI process can never
  // resolve to `pushed` (live activity outranks the settled push state), but we
  // keep the explicit guard as defence-in-depth so a racing process is never
  // archived out from under itself.
  router.delete('/api/agents/:agentId/sessions/pushed', async (req: Request, res: Response) => {
    const sessions = (stmts.getAllSessionsByAgent.all(req.params.agentId) as SessionRow[]).filter(
      (s) => userOwnsSession(req as AuthenticatedRequest, s.id),
    );
    const archivedIds: string[] = [];
    let failed = 0;
    for (const session of sessions) {
      if (session.deleted_at) continue;
      if (activeProcesses.has(session.id)) continue;
      if (computeSessionState(stmts, session.id) !== 'pushed') continue;
      closeBrowserBestEffort(session.id);
      try {
        await teardownSessionRuntime(session.id, { forgetWorkspace: false });
      } catch (err: unknown) {
        failed++;
        console.error(
          `[sessions] refuse bulk archive (pushed); runtime teardown failed (${session.id}):`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
      syncSessionCardBestEffort(session.id, 'closed');
      stmts.softDeleteSession.run(session.id);
      archivedIds.push(session.id);
      try {
        deps.broadcast({ type: 'session_deleted', sessionId: session.id });
      } catch {
        /* best-effort */
      }
    }
    const archived = archivedIds.length;
    res.status(failed > 0 && archived === 0 ? 500 : 200).json({
      ok: failed === 0,
      archived,
      deleted: archived,
      failed,
      archivedIds,
    });
  });

  // Bulk soft-delete (archive) only the sessions whose resolved lifecycle state
  // is `merged` — i.e. the work has landed on the default branch. With per-session
  // Merge Automatically as the default, sessions blow straight through the
  // transient `pushed` state into `merged`, so "Clear pushed" rarely matches the
  // shipped sessions cluttering the sidebar. This is the companion that reaps
  // them. Everything else (working / waiting / in-flight Finalize phases /
  // pushed-but-not-merged) is left untouched. A session with an active CLI
  // process can never resolve to `merged` (live activity outranks the settled
  // merged marker), but we keep the explicit guard as defence-in-depth so a
  // racing process is never archived out from under itself.
  router.delete('/api/agents/:agentId/sessions/merged', async (req: Request, res: Response) => {
    const sessions = (stmts.getAllSessionsByAgent.all(req.params.agentId) as SessionRow[]).filter(
      (s) => userOwnsSession(req as AuthenticatedRequest, s.id),
    );
    const archivedIds: string[] = [];
    let failed = 0;
    for (const session of sessions) {
      if (session.deleted_at) continue;
      if (activeProcesses.has(session.id)) continue;
      if (computeSessionState(stmts, session.id) !== 'merged') continue;
      closeBrowserBestEffort(session.id);
      try {
        await teardownSessionRuntime(session.id, { forgetWorkspace: false });
      } catch (err: unknown) {
        failed++;
        console.error(
          `[sessions] refuse bulk archive (merged); runtime teardown failed (${session.id}):`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
      syncSessionCardBestEffort(session.id, 'closed');
      stmts.softDeleteSession.run(session.id);
      archivedIds.push(session.id);
      try {
        deps.broadcast({ type: 'session_deleted', sessionId: session.id });
      } catch {
        /* best-effort */
      }
    }
    const archived = archivedIds.length;
    res.status(failed > 0 && archived === 0 ? 500 : 200).json({
      ok: failed === 0,
      archived,
      deleted: archived,
      failed,
      archivedIds,
    });
  });

  // Single-session DELETE is a *soft* delete (archive). The row is marked with
  // `deleted_at` so it disappears from the live sidebar but stays recoverable
  // via POST /api/sessions/:sessionId/restore for 24 hours. We deliberately
  // leave the worktree on disk so a restore can reattach the same checkout.
  // Bulk `DELETE /api/agents/:agentId/sessions[/pushed]` uses the same
  // soft-delete semantics. Hard removal (DB row + worktree) happens when the
  // agent or project is deleted, or when the hourly workspace-purge tick in
  // server/session-purge.ts drops rows past the 24-hour recovery window.
  router.delete('/api/sessions/:sessionId', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Kill any in-flight CLI process so the archived session isn't still
    // streaming output into a hidden row.
    const proc = activeProcesses.get(sessionId);
    if (proc) {
      try {
        markSessionTermination(sessionId, 'session_deleted');
        console.info(`[sessions] session_deleted: sending SIGTERM session=${sessionId}`);
        proc.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      activeProcesses.delete(sessionId);
    }

    closeBrowserBestEffort(sessionId);
    try {
      // Soft archive: stop the env but keep the workspace disk for restore.
      await teardownSessionRuntime(sessionId, { forgetWorkspace: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] refuse archive; runtime teardown failed (${sessionId}):`, message);
      return res.status(500).json({
        error: `Failed to tear down session environment: ${message}`,
      });
    }

    syncSessionCardBestEffort(sessionId, 'closed');
    stmts.softDeleteSession.run(sessionId);

    // Broadcast `session_deleted` for cross-tab sync — the client treats
    // archive identically to a hard delete on the live list.
    try {
      deps.broadcast({ type: 'session_deleted', sessionId });
    } catch {
      /* best-effort */
    }

    res.json({ ok: true, archived: true });
  });

  // Archived (soft-deleted) sessions for a given agent within the 24-hour
  // recovery window, newest first. Powers the sidebar "Archived" section.
  router.get('/api/agents/:agentId/archived-sessions', (req: Request, res: Response) => {
    const rows = (stmts.getArchivedSessionsByAgent.all(req.params.agentId) as SessionRow[]).filter(
      (s) => userOwnsSession(req as AuthenticatedRequest, s.id),
    );
    res.json(rows.map((s) => enrichSessionForClient(s, stmts)));
  });

  // Restore a soft-deleted session. 404 when the row either doesn't exist or
  // isn't archived — the client uses the 404 to clear stale entries from the
  // Archived sidebar.
  router.post('/api/sessions/:sessionId/restore', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    const existing = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    if (!existing.deleted_at) {
      return res.status(409).json({ error: 'Session is not archived' });
    }

    stmts.restoreArchivedSession.run(sessionId);
    syncSessionCardBestEffort(sessionId, 'in-progress');
    const restored = stmts.getSession.get(sessionId) as SessionRow;
    const restoredWire = enrichSessionForClient(restored, stmts);

    try {
      deps.broadcast({ type: 'session_restored', sessionId, session: restoredWire });
    } catch {
      /* best-effort */
    }

    res.json(restoredWire);
  });

  router.patch('/api/sessions/:sessionId', async (req: Request, res: Response) => {
    const parsed = parseBody(PatchSessionRequestSchema, req, res);
    if (!parsed) return;
    const sessionId = String(req.params.sessionId);
    const existing = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    const sessionProject = findAgent(existing.agent_id)?.project ?? null;

    // Validate the design-mode precondition BEFORE any write so the whole patch
    // is atomic. The session-mode picker can change several axes at once (e.g.
    // entering Design from `merge` resets ask_mode + finalize_automation and
    // switches session_mode); applying them as separate calls risked a partial
    // commit where, say, ship intent was cleared but the mode switch then failed
    // its worktree check — leaving the user in chat with their merge/push intent
    // silently dropped. Rejecting the entire request here, then applying every
    // field in one transaction below, makes it all-or-nothing.
    let nextMode: SessionMode | undefined;
    if (parsed.session_mode !== undefined) {
      nextMode = normalizeSessionMode(parsed.session_mode);
      if (nextMode === 'design' && !sessionCanUseDesignMode(existing, sessionProject)) {
        return res.status(400).json({
          error: 'design_mode_requires_worktree',
          message:
            'Design mode requires a session with an isolated worktree (dev projects) or a ' +
            'workflow (no-code) project. This session has neither, so design artifacts cannot ' +
            'be produced.',
        });
      }
      // Skill Builder is a dev-agent mode: chat.ts prepends a dev coach prompt
      // and force-loads skill-authoring skills, so flipping a docs / reviewer /
      // legacy skill-builder helper session into it would apply the wrong
      // prompt + role. Enforce eligibility on EVERY generic mode update, not
      // just the dedicated entry points.
      if (
        nextMode === 'skill-builder' &&
        !isSkillBuilderEligibleAgent(findAgent(existing.agent_id)?.agent)
      ) {
        return res.status(400).json({
          error: 'skill_builder_requires_dev_agent',
          message:
            "Skill Builder mode is only available on a dev agent — this session's agent " +
            'is a helper (docs / reviewer / skill-builder) and is not eligible.',
        });
      }
      if (nextMode === 'isolated' && !isFirecrackerBackendRegistered()) {
        return res.status(400).json({
          error: 'isolated_mode_requires_firecracker',
          message:
            'VM mode requires Firecracker on this host (nested virtualization + guest artifacts). ' +
            'It is unavailable here — use a normal chat session or enable Firecracker.',
        });
      }
      const modeGuard = validateSessionModeForProject(sessionProject, nextMode);
      if (modeGuard) return res.status(400).json(modeGuard);
    }

    if (parsed.finalize_automation !== undefined) {
      const automationGuard = validateFinalizeAutomationForProject(
        sessionProject,
        parsed.finalize_automation,
      );
      if (automationGuard) return res.status(400).json(automationGuard);
    }

    if (parsed.ask_mode === true && nextMode === undefined) {
      nextMode = 'consult';
      const modeGuard = validateSessionModeForProject(sessionProject, nextMode);
      if (modeGuard) return res.status(400).json(modeGuard);
    }

    const finalMode = nextMode ?? normalizeSessionMode(existing.session_mode);
    const finalAskMode = parsed.ask_mode !== undefined ? 0 : Number(existing.ask_mode ?? 0);
    const finalModeBlocksFinalize =
      !isShippingCompatibleSessionMode(finalMode) || finalAskMode !== 0;
    if (
      finalModeBlocksFinalize &&
      parsed.finalize_automation !== undefined &&
      parsed.finalize_automation !== 'manual'
    ) {
      return res.status(400).json({
        error: 'finalize_not_allowed_in_session_mode',
        message:
          'Finalize automation must be manual when a session is in Consult, Scoping, Design, Skill Builder, or legacy Ask mode.',
      });
    }

    const enteringNonShippingMode =
      nextMode !== undefined && !isShippingCompatibleSessionMode(nextMode);
    const shouldClearFinalizeAutomation =
      enteringNonShippingMode && parsed.finalize_automation === undefined;
    const shouldClearAskMode = enteringNonShippingMode;

    const persistPatch = getDb().transaction(() => {
      if (parsed.name) {
        stmts.updateSessionName.run(parsed.name, sessionId);
      }
      if (parsed.max_turns !== undefined) {
        stmts.updateSessionMaxTurns.run(parsed.max_turns, sessionId);
      }
      if (parsed.finalize_automation !== undefined) {
        // Persist the chosen level only. Changing the dropdown must NOT start a
        // Finalize run on its own — the level is honored at the next
        // end-of-turn auto-commit (see maybeAutoStartFinalizeForSession via
        // auto-git.ts).
        stmts.updateSessionFinalizeAutomation.run(parsed.finalize_automation, sessionId);
      } else if (shouldClearFinalizeAutomation) {
        stmts.updateSessionFinalizeAutomation.run('manual', sessionId);
      }
      if (parsed.ask_mode !== undefined || shouldClearAskMode) {
        stmts.updateSessionAskMode.run(0, sessionId);
      }
      if (nextMode !== undefined) {
        stmts.updateSessionMode.run(nextMode, sessionId);
      }
    });
    if (nextMode !== undefined) {
      if (!deps.transitionSessionEnv) {
        return res.status(503).json({ error: 'session_env_transition_unavailable' });
      }
      await deps.transitionSessionEnv(sessionId, async (disposeCurrent) => {
        const current = stmts.getSession.get(sessionId) as SessionRow;
        const prevAdapter = resolveSessionEnvAdapterForSession({
          project: sessionProject,
          session: current,
        });
        const nextAdapter = resolveSessionEnvAdapterForSession({
          project: sessionProject,
          session: { ...current, session_mode: nextMode },
        });
        if (prevAdapter !== nextAdapter) {
          await disposeCurrent();
        }
        persistPatch();
      });
    } else {
      persistPatch();
    }

    const session = stmts.getSession.get(sessionId) as SessionRow;
    const enriched = enrichSessionWithAgents(session, stmts, getEnrichedAgent, sessionProject);
    deps.broadcast({ type: 'session-updated', session: enriched });
    res.json(enriched);
  });

  /**
   * Link (or unlink) a Design Studio design to this session. When linked, the
   * web client renders the design's live canvas in a preview pane beside the
   * chat so the user can iterate on the mockup with the agent before
   * implementation. `designId: null` clears the link.
   *
   * The design must exist in the caller's active org (org scoping flows
   * through `getDesign`). The link is stored as a plain id, not a FK — if the
   * design is later deleted the stale id is tolerated and ignored at render.
   */
  router.put('/api/sessions/:sessionId/linked-design', (req: Request, res: Response) => {
    const parsed = parseBody(PutSessionLinkedDesignRequestSchema, req, res);
    if (!parsed) return;
    const sessionId = req.params.sessionId as string;
    const existing = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const designId = parsed.designId ?? null;
    if (designId !== null) {
      const design = getDesign(designId, findProject, getActiveOrgId());
      if (!design) return res.status(404).json({ error: 'Design not found' });
    }

    stmts.updateSessionLinkedDesign.run(designId, sessionId);
    const updated = stmts.getSession.get(sessionId) as SessionRow;
    const enriched = enrichSessionForClient(updated, stmts);
    deps.broadcast({ type: 'session-updated', session: enriched });
    res.json(enriched);
  });

  /**
   * Choose (or clear) the existing remote branch this session's worktree is
   * checked out onto — the general form of the resolve-PR head-branch
   * mechanism, surfaced as the session Branch picker. `branch: null` clears the
   * choice and reverts to the default fresh `agent-hub/<agent>/session-<id>`
   * branch.
   *
   * Before provisioning, this records the branch for the initial clone. After
   * provisioning, a clean and idle session may switch to another existing
   * non-default branch. Once code changes, an active turn, or Finalize exists,
   * the branch is locked because Finalize keys off the recorded branch.
   */
  router.put(
    '/api/sessions/:sessionId/worktree-branch',
    requireRole('User'),
    async (req: Request, res: Response) => {
      const parsed = parseBody(PutSessionWorktreeBranchRequestSchema, req, res);
      if (!parsed) return;
      const sessionId = req.params.sessionId as string;
      const existing = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!existing) return res.status(404).json({ error: 'Session not found' });
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!sessionUsesWorktree(existing)) {
        return res.status(400).json({ error: 'Session does not use a worktree' });
      }
      const branch = parsed.branch ?? null;
      if (!tryAcquireSessionWorktreeLock(sessionId, 'branch-switch')) {
        return res
          .status(409)
          .json({ error: 'The session is already starting or switching a turn' });
      }
      try {
        const current = stmts.getSession.get(sessionId) as SessionRow | undefined;
        if (!current) return res.status(404).json({ error: 'Session not found' });
        if (!sessionUsesWorktree(current)) {
          return res.status(400).json({ error: 'Session does not use a worktree' });
        }
        if (!current.worktree_path) {
          stmts.setSessionWorktreeCheckoutBranch.run(branch, sessionId);
        } else {
          if (!branch) {
            return res.status(409).json({
              error: 'Worktree already provisioned; choose an existing branch to switch it',
            });
          }
          if (current.code_changed_at) {
            return res.status(409).json({
              error: 'The session already has code changes; its branch is locked',
            });
          }
          const activeTask = stmts.getActiveTask.get(sessionId) as
            | { status?: string | null }
            | undefined;
          if (activeProcesses.has(sessionId) || activeTask?.status === 'running') {
            return res
              .status(409)
              .json({ error: 'Cannot switch branches while the session is active' });
          }
          const activeFinalizeRuns = stmts.getActiveFinalizeRuns.all() as Array<{
            session_id?: string | null;
          }>;
          const hasFinalizeRun = activeFinalizeRuns.some((run) => run.session_id === sessionId);
          if (hasFinalizeRun) {
            return res
              .status(409)
              .json({ error: 'Cannot switch branches while Finalize is active' });
          }
          if (!deps.switchSessionWorkspaceBranch) {
            return res.status(503).json({ error: 'Workspace branch switching is not available' });
          }

          let changes;
          try {
            const io = await sessionWorktreeIo(current);
            if (!io) throw new Error('Session has no worktree');
            changes = await checkWorktreeChanges(io);
          } catch (err: unknown) {
            return res.status(409).json({
              error: 'Unable to verify that the session worktree is clean',
              message: err instanceof Error ? err.message : String(err),
            });
          }
          if (changes.hasUncommitted || changes.hasUnpushed) {
            return res.status(409).json({
              error: 'The session worktree has changes or commits that must be preserved first',
            });
          }

          const switched = await deps.switchSessionWorkspaceBranch(sessionId, branch);
          stmts.updateSessionWorktreePath.run(switched.worktreePath, switched.branch, sessionId);
          stmts.setSessionWorktreeCheckoutBranch.run(switched.branch, sessionId);
        }
      } catch (err: unknown) {
        return res.status(409).json({
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        releaseSessionWorktreeLock(sessionId, 'branch-switch');
        setImmediate(() => deps.drainSessionQueue?.(sessionId));
      }
      const updated = stmts.getSession.get(sessionId) as SessionRow;
      const enriched = enrichSessionForClient(updated, stmts);
      deps.broadcast({ type: 'session-updated', session: enriched });
      res.json(enriched);
    },
  );

  router.put('/api/sessions/:sessionId/linked-epic', (req: Request, res: Response) => {
    const epicId =
      req.body && typeof req.body === 'object' && 'epicId' in req.body
        ? ((req.body as { epicId?: string | null }).epicId ?? null)
        : null;
    const sessionId = req.params.sessionId as string;
    const existing = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (epicId !== null) {
      const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
      if (!epic) return res.status(404).json({ error: 'Epic not found' });
      // The epic must belong to the session's own project. Scoping-mode
      // prompt assembly later loads the linked epic/spec data straight from
      // `linked_epic_id`, so without this a user could attach a foreign
      // project's epic ID and pull that epic's scoping context into their
      // session. Resolve the project via the session's agent and require the
      // epic's board to match.
      const found = findAgent(existing.agent_id);
      const projectId = found?.project?.id ?? null;
      const board = projectId
        ? (stmts.getKanbanBoard.get(projectId) as KanbanBoardRow | undefined)
        : undefined;
      if (!board || epic.board_id !== board.id) {
        return res.status(404).json({ error: 'Epic not found' });
      }
    }

    stmts.updateSessionLinkedEpic.run(epicId, sessionId);
    const updated = stmts.getSession.get(sessionId) as SessionRow;
    const enriched = enrichSessionForClient(updated, stmts);
    deps.broadcast({ type: 'session-updated', session: enriched });
    res.json(enriched);
  });

  router.post('/api/sessions/:sessionId/agents', (req: Request, res: Response) => {
    const parsed = parseBody(AddSessionAgentRequestSchema, req, res);
    if (!parsed) return;
    const { agentId, model = null } = parsed;
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const found = findAgent(agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const caller = resolveVisibilityCaller(req);
    if (!canViewProject(found.project, caller)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (found.agent?.role === 'reviewer') {
      return res.status(403).json({ error: 'Reviewer agents cannot join multi-agent sessions' });
    }
    const ownerUserId = session.owner_user_id ?? (req as AuthenticatedRequest).authUserId ?? null;
    const { engine } = resolveEffectiveEngineAndModel(config, {
      agentId,
      agentEngine: found.agent.engine || 'claude-code',
      agentModel: found.agent.model ?? null,
      ownerUserId,
    });
    if (model) {
      const staticAllowed = config.engineValidModels[engine] || [];
      const allowed =
        engine === 'codex-cli'
          ? resolveSelectableCodexModels(
              staticAllowed,
              readCodexModelsCacheForUser(ownerUserId, config.dataDir),
            )
          : staticAllowed;
      if (!allowed.includes(model)) {
        return res.status(400).json({
          error: `Model "${model}" is not valid for engine "${engine}". Allowed: ${allowed.join(', ')}`,
        });
      }
    }
    stmts.addSessionAgent.run(uuidv4(), req.params.sessionId, agentId, model, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    deps.broadcast({
      type: 'session-updated',
      session: enrichSessionWithAgents(updated, stmts, getEnrichedAgent),
    });
    res.json(enrichSessionWithAgents(updated, stmts, getEnrichedAgent));
  });

  router.delete('/api/sessions/:sessionId/agents/:participantId', (req: Request, res: Response) => {
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const result = stmts.removeSessionAgent.run(req.params.sessionId, req.params.participantId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Session participant not found' });
    }
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    deps.broadcast({
      type: 'session-updated',
      session: enrichSessionWithAgents(updated, stmts, getEnrichedAgent),
    });
    res.json(enrichSessionWithAgents(updated, stmts, getEnrichedAgent));
  });

  router.put(
    '/api/sessions/:sessionId/agents/:participantId/model',
    (req: Request, res: Response) => {
      const parsed = parseBody(PutSessionAgentModelRequestSchema, req, res);
      if (!parsed) return;
      const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const participant = (
        stmts.getSessionAgents.all(req.params.sessionId) as Array<{
          id: string;
          agent_id: string;
        }>
      ).find((row) => row.id === req.params.participantId);
      if (!participant) return res.status(404).json({ error: 'Session participant not found' });
      const found = findAgent(participant.agent_id);
      if (!found) return res.status(404).json({ error: 'Agent not found' });
      const ownerUserId = session.owner_user_id ?? (req as AuthenticatedRequest).authUserId ?? null;
      const { engine } = resolveEffectiveEngineAndModel(config, {
        agentId: participant.agent_id,
        agentEngine: found.agent.engine || 'claude-code',
        agentModel: found.agent.model ?? null,
        ownerUserId,
      });
      if (parsed.model) {
        const staticAllowed = config.engineValidModels[engine] || [];
        const allowed =
          engine === 'codex-cli'
            ? resolveSelectableCodexModels(
                staticAllowed,
                readCodexModelsCacheForUser(ownerUserId, config.dataDir),
              )
            : staticAllowed;
        if (!allowed.includes(parsed.model)) {
          return res.status(400).json({
            error: `Model "${parsed.model}" is not valid for engine "${engine}". Allowed: ${allowed.join(', ')}`,
          });
        }
      }
      stmts.updateSessionAgentModel.run(
        parsed.model,
        req.params.sessionId,
        req.params.participantId,
      );
      const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
      deps.broadcast({
        type: 'session-updated',
        session: enrichSessionWithAgents(updated, stmts, getEnrichedAgent),
      });
      res.json(enrichSessionWithAgents(updated, stmts, getEnrichedAgent));
    },
  );

  router.put('/api/sessions/:sessionId/engine', (req: Request, res: Response) => {
    const parsed = parseBody(PutSessionEngineRequestSchema, req, res);
    if (!parsed) return;
    const { engine } = parsed;
    const sessionId = req.params.sessionId as string;
    // Load the session BEFORE updating the engine so we can check whether
    // the current model is still valid for the new engine. If not, reset
    // the model to the engine's default. Without this step, the session
    // ends up in a mixed state (e.g. engine=codex-cli, model=claude-opus-4-8)
    // and the next `PUT .../model` call — which the client fires right
    // after — 400s with "Model X is not valid for engine Y".
    const existing = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    const allowedForNewEngine = config.engineValidModels[engine] || [];
    getDb().transaction(() => {
      stmts.updateSessionEngine.run(engine, sessionId);
      stmts.updateSessionEngineSessionId.run(null, sessionId);
      if (!existing.model || !allowedForNewEngine.includes(existing.model)) {
        const af = existing.agent_id ? findAgent(existing.agent_id) : null;
        const agentModel = (af?.agent as { model?: string } | undefined)?.model ?? null;
        const ownerUid = getSessionOwner(sessionId);
        const fallbackModel = resolveEffectiveModel(config, engine, {
          agentModel,
          ownerUserId: ownerUid,
          agentId: existing.agent_id,
        });
        stmts.updateSessionModel.run(fallbackModel, sessionId);
      }
    })();
    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(enrichSessionForClient(session, stmts));
  });

  router.put('/api/sessions/:sessionId/model', (req: Request, res: Response) => {
    const parsed = parseBody(PutSessionModelRequestSchema, req, res);
    if (!parsed) return;
    const { model } = parsed;
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const engine = session.engine || 'claude-code';
    const staticAllowed =
      config.engineValidModels[engine] || config.engineValidModels['claude-code'];
    // For codex-cli, overlay the capability-gated models the installed CLI
    // advertises so a save accepts whatever GET /api/config/models offered in the
    // picker (self-heals across a codex upgrade). Without this, a selectable
    // gpt-5.6-* was rejected here and the row silently stayed on the baseline,
    // making the UI "revert" on the next refresh. Read the capability cache from
    // the SESSION OWNER's codex home (availability is per-user), falling back to
    // the request user.
    let allowed: string[] = staticAllowed;
    if (engine === 'codex-cli') {
      const capUserId = session.owner_user_id ?? (req as AuthenticatedRequest).authUserId ?? null;
      const codexCache = readCodexModelsCacheForUser(capUserId, config.dataDir);
      allowed = resolveSelectableCodexModels(staticAllowed, codexCache);
    }
    if (!allowed.includes(model)) {
      return res.status(400).json({
        error: `Model "${model}" is not valid for engine "${engine}". Allowed: ${allowed.join(', ')}`,
      });
    }
    stmts.updateSessionModel.run(model, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(enrichSessionForClient(updated, stmts));
  });

  // NOTE: `PUT /api/sessions/:sessionId/worktree` was removed when Agent
  // Hub locked to worktree-only sessions. The `use_worktree` column is
  // kept on the row for legacy data + internal callers but is no longer
  // user-toggleable.

  router.put('/api/sessions/:sessionId/ask-mode', (req: Request, res: Response) => {
    const parsed = parseBody(ToggleEnabledRequestSchema, req, res);
    if (!parsed) return;
    const { enabled } = parsed;
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const sessionProject = findAgent(session.agent_id)?.project ?? null;
    const targetMode = enabled ? 'consult' : isWorkflowProject(sessionProject) ? 'scoping' : 'chat';
    const modeGuard = validateSessionModeForProject(sessionProject, targetMode);
    if (modeGuard) return res.status(400).json(modeGuard);
    getDb().transaction(() => {
      stmts.updateSessionAskMode.run(0, req.params.sessionId);
      stmts.updateSessionMode.run(targetMode, req.params.sessionId);
      if (enabled) {
        stmts.updateSessionFinalizeAutomation.run('manual', req.params.sessionId);
      }
    })();
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(enrichSessionForClient(updated, stmts, sessionProject));
  });

  // Session mode picker (chat | design). Persists the chosen mode; the spawn
  // path reads it to decide design-skill loading / artifact behavior. Accepted
  // on any session. See server/session-mode.ts.
  router.put('/api/sessions/:sessionId/mode', async (req: Request, res: Response) => {
    const parsed = parseBody(PutSessionModeRequestSchema, req, res);
    if (!parsed) return;
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const sessionProject = findAgent(session.agent_id)?.project ?? null;
    const mode = normalizeSessionMode(parsed.mode);
    // Design mode needs a place to write artifacts: a dev-project session uses
    // its worktree `design/` dir; a workflow (no-code) session uses the
    // Hub-managed data-dir store. A dev-project session with no worktree has
    // neither — the spawn path disables design behavior there rather than
    // polluting the shared checkout — so refuse to persist `design`, keeping
    // API/UI state honest about what the session can actually run.
    if (mode === 'design' && !sessionCanUseDesignMode(session, sessionProject)) {
      return res.status(400).json({
        error: 'design_mode_requires_worktree',
        message:
          'Design mode requires a session with an isolated worktree (dev projects) or a ' +
          'workflow (no-code) project. This session has neither, so design artifacts cannot ' +
          'be produced.',
      });
    }
    // Skill Builder mode only runs on a dev agent (see the PATCH guard above and
    // chat.ts's prompt/skill wiring); refuse to persist it on a helper session.
    if (
      mode === 'skill-builder' &&
      !isSkillBuilderEligibleAgent(findAgent(session.agent_id)?.agent)
    ) {
      return res.status(400).json({
        error: 'skill_builder_requires_dev_agent',
        message:
          "Skill Builder mode is only available on a dev agent — this session's agent " +
          'is a helper (docs / reviewer / skill-builder) and is not eligible.',
      });
    }
    if (mode === 'isolated' && !isFirecrackerBackendRegistered()) {
      return res.status(400).json({
        error: 'isolated_mode_requires_firecracker',
        message:
          'VM mode requires Firecracker on this host (nested virtualization + guest artifacts). ' +
          'It is unavailable here — use a normal chat session or enable Firecracker.',
      });
    }
    const modeGuard = validateSessionModeForProject(sessionProject, mode);
    if (modeGuard) return res.status(400).json(modeGuard);
    const enteringNonShippingMode = !isShippingCompatibleSessionMode(mode);
    const persistMode = getDb().transaction(() => {
      stmts.updateSessionMode.run(mode, req.params.sessionId);
      if (enteringNonShippingMode) {
        stmts.updateSessionAskMode.run(0, req.params.sessionId);
        stmts.updateSessionFinalizeAutomation.run('manual', req.params.sessionId);
      }
    });
    if (!deps.transitionSessionEnv) {
      return res.status(503).json({ error: 'session_env_transition_unavailable' });
    }
    await deps.transitionSessionEnv(String(req.params.sessionId), async (disposeCurrent) => {
      const current = stmts.getSession.get(req.params.sessionId) as SessionRow;
      const prevAdapter = resolveSessionEnvAdapterForSession({
        project: sessionProject,
        session: current,
      });
      const nextAdapter = resolveSessionEnvAdapterForSession({
        project: sessionProject,
        session: { ...current, session_mode: mode },
      });
      if (prevAdapter !== nextAdapter) {
        await disposeCurrent();
      }
      persistMode();
    });
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    const enriched = enrichSessionForClient(updated, stmts, sessionProject);
    deps.broadcast({ type: 'session-updated', session: enriched });
    res.json(enriched);
  });

  /**
   * List the design artifacts a `session_mode = 'design'` session has produced
   * in its worktree `design/` dir. The web client renders these live in an
   * iframe canvas; mobile/Electron (no in-app iframe) show this flat file list
   * plus an open-in-browser link to `/session-files/:id/design/<path>`. Returns
   * `{ files: [{ path, size, mtime }] }` with forward-slash paths relative to
   * the `design/` dir. A worktree-less session (which can never enter design
   * mode) and a session that wrote no artifacts both yield an empty list.
   */
  router.get('/api/sessions/:sessionId/design-files', (req: Request, res: Response) => {
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // List from whichever artifact store backs this session — the worktree
    // `design/` dir (dev projects) or the data-dir store (worktree-less workflow
    // sessions). Independent of the CURRENT session_mode: artifacts persist even
    // after flipping out of design mode, and a session that produced none yields
    // an empty list either way.
    const location = resolveDesignLocationForServe({
      session,
      sessionId: String(req.params.sessionId),
      dataDir: config.dataDir,
    });
    const files =
      location.kind === 'worktree'
        ? listSessionDesignFiles(session.worktree_path)
        : listSessionDesignFilesAtRoot(location.root);
    res.json({ files });
  });

  router.put('/api/sessions/:sessionId/react-loop', (req: Request, res: Response) => {
    const parsed = parseBody(ToggleEnabledRequestSchema, req, res);
    if (!parsed) return;
    const { enabled } = parsed;
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.updateSessionReactLoop.run(enabled ? 1 : 0, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(enrichSessionForClient(updated, stmts));
  });

  // Codex reasoning ("thinking") level. `high` (default) → model_reasoning_effort=high,
  // `pro` → xhigh. Stored as the preset string; the spawn path resolves it to the
  // native effort (see server/codex-reasoning.ts). Accepted on any session but only
  // affects Codex (`codex-cli`) spawns.
  router.put('/api/sessions/:sessionId/reasoning-effort', (req: Request, res: Response) => {
    const parsed = parseBody(PutSessionReasoningEffortRequestSchema, req, res);
    if (!parsed) return;
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.updateSessionReasoningEffort.run(parsed.effort, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(enrichSessionForClient(updated, stmts));
  });

  router.put('/api/sessions/:sessionId/orchestration', (req: Request, res: Response) => {
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const body = req.body as { phase?: unknown; meta?: unknown };
    const hasPhase = Object.prototype.hasOwnProperty.call(body, 'phase');
    const hasMeta = Object.prototype.hasOwnProperty.call(body, 'meta');
    if (!hasPhase && !hasMeta) {
      return res.status(400).json({
        error: 'Provide at least one of: phase, meta (omit a key to leave that field unchanged)',
      });
    }

    let nextPhase: string | null = session.orchestration_phase ?? null;
    let nextMetaJson: string | null = session.orchestration_meta ?? null;

    if (hasPhase) {
      const pr = parseOrchestrationPhase(body.phase);
      if (pr === 'invalid') {
        return res.status(400).json({
          error: 'phase must be null or one of: planning, acting, verifying, done, escalated',
        });
      }
      nextPhase = pr;
    }

    if (hasMeta) {
      const nm = normalizeOrchestrationMetaInput(body.meta);
      if (!nm.ok) {
        if (nm.error === 'oversize') {
          return res.status(413).json({ error: 'meta JSON exceeds maximum size' });
        }
        return res.status(400).json({ error: 'meta must be a JSON object or null' });
      }
      nextMetaJson = nm.serialized;
    }

    stmts.updateSessionOrchestration.run(nextPhase, nextMetaJson, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    const updatedWire = enrichSessionForClient(updated, stmts);
    deps.broadcast({ type: 'session-updated', session: updatedWire });
    res.json({
      ...updatedWire,
      orchestrationMeta: parseOrchestrationMetaJson(updated.orchestration_meta ?? null),
    });
  });

  router.get('/api/delegations/:messageId', (req: Request, res: Response) => {
    try {
      const message = stmts.getMessageById.get(req.params.messageId) as MessageRow | undefined;
      if (!message || !userOwnsSession(req as AuthenticatedRequest, message.session_id)) {
        return res.status(404).json({ error: 'Message not found' });
      }
      const delegations = stmts.getDelegations.all(req.params.messageId);
      res.json(delegations);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/sessions/:sessionId/delegations', (req: Request, res: Response) => {
    try {
      const delegations = stmts.getDelegationsBySession.all(req.params.sessionId);
      res.json(delegations);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Return every handoff emitted from this source session (any status).
  // Used by the chat UI to resolve <handoff> blocks in saved messages to a
  // clickable link into the target session. Mirrors the delegations shape
  // so the client can lazy-fetch on session open.
  router.get('/api/sessions/:sessionId/handoffs', (req: Request, res: Response) => {
    try {
      const handoffs = stmts.getHandoffsFromSession.all(req.params.sessionId);
      res.json(handoffs);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/sessions/:sessionId/skill-invocations', (req: Request, res: Response) => {
    try {
      const rows = stmts.listSkillInvocationsForSession.all(req.params.sessionId);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/sessions/:sessionId/queue', (req: Request, res: Response) => {
    try {
      const queue = stmts.getQueuedMessages.all(req.params.sessionId);
      res.json(queue);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * Per-process detail for the active preview group of `sessionId`.
   *
   * Returns `{ group: null, processes: [] }` when no active group exists
   * (no preview ever started for this session, or it was torn down /
   * reaped). When a group is present, `processes` is ordered by
   * `started_at ASC, name ASC` and each row carries its own status, port,
   * URL, pid, and log path — multi-process callers iterate this; legacy
   * single-process callers can keep reading the group-level surface.
   *
   * Joined directly against the `worktree_preview_groups` /
   * `worktree_preview_processes` tables; no runtime instance
   * required, which keeps the route usable even before the runtime is
   * fully wired into prod.
   */
  router.get('/api/sessions/:sessionId/preview/processes', (req: Request, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      // Two-layer 404: the session row must exist AND the caller must
      // own it. Both produce the same "Session not found" body so an
      // unauth'd probe can't tell "session exists but you don't own it"
      // from "session doesn't exist".
      const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const db = getDb();
      const groupRow = db
        .prepare(
          `SELECT id, session_id, project_id, status, started_at, last_active_at
             FROM worktree_preview_groups
            WHERE session_id = ? AND status IN ('starting','ready','failed')
            ORDER BY started_at DESC
            LIMIT 1`,
        )
        .get(sessionId) as
        | {
            id: string;
            session_id: string;
            project_id: string;
            status: string;
            started_at: string;
            last_active_at: string;
          }
        | undefined;
      if (!groupRow) {
        return res.json({ group: null, processes: [] });
      }
      const processes = db
        .prepare(
          `SELECT id, group_id, name, pid, port, url, log_path, status, started_at
             FROM worktree_preview_processes
            WHERE group_id = ?
            ORDER BY started_at ASC, name ASC`,
        )
        .all(groupRow.id) as Array<{
        id: string;
        group_id: string;
        name: string;
        pid: number | null;
        port: number;
        url: string;
        log_path: string | null;
        status: string;
        started_at: string;
      }>;
      res.json({ group: groupRow, processes });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post(
    '/api/sessions/:sessionId/preview/stop',
    requireRole('User'),
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.sessionId as string;
        const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
        if (!session) {
          return res.status(404).json({ error: 'Session not found' });
        }
        if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
          return res.status(404).json({ error: 'Session not found' });
        }
        await stopPreviewOnlyForSession(sessionId);
        deps.broadcast({
          type: 'agenthub_preview',
          kind: 'preview_stopped',
          sessionId,
        } as Record<string, unknown>);
        return res.json({ ok: true, stopped: true });
      } catch (err) {
        return res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.post(
    '/api/sessions/:sessionId/workspace/ensure',
    requireRole('User'),
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.sessionId as string;
        const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
        if (!session) {
          return res.status(404).json({ error: 'Session not found' });
        }
        if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
          return res.status(404).json({ error: 'Session not found' });
        }
        const found = findAgent(session.agent_id);
        if (!found) {
          return res.status(404).json({ error: 'Agent not found' });
        }
        const { project } = found;
        if (!sessionUsesWorktree(session) || getProjectMode(project) === 'workflow') {
          return res.json({
            ok: true,
            skipped: true,
            worktreePath: project.cwd,
            session: enrichSessionForClient(session, stmts),
          });
        }
        if (!deps.provisionSessionWorkspace) {
          return res.status(503).json({ error: 'Workspace provisioning is not available' });
        }
        // Reserve turn startup before provisioning. A chat submitted while
        // setup owns the lock is persisted as queued by handleChat; if chat
        // wins the first-render race, wait for its own worktree/env startup to
        // finish before running this idempotent ensure. Waiting (rather than
        // proceeding after a failed tryAcquire) also serializes overlapping
        // ensure requests so an early request cannot drain chat while a later
        // request is still provisioning.
        beginWorkspaceEnsure(sessionId);
        await acquireSessionWorktreeLock(sessionId, 'workspace-setup');
        let workspaceSetupSucceeded = false;
        try {
          const worktreePath = await deps.provisionSessionWorkspace(sessionId);
          // Boot the session VM/container after the clone so the interactive
          // open pays clone + boot up front. Idempotent — reuses a live env,
          // boots one only when the in-memory environment is gone (Hub restart
          // / idle reap) even though the worktree_path row persists.
          if (deps.ensureSessionEnvironment) {
            await deps.ensureSessionEnvironment(sessionId);
          }
          workspaceSetupSucceeded = true;
          const updated = stmts.getSession.get(sessionId) as SessionRow;
          const sessionWire = enrichSessionForClient(updated, stmts);
          deps.broadcast({
            type: 'session_workspace_ready',
            sessionId,
            worktreePath,
            session: sessionWire,
          });
          return res.json({
            ok: true,
            skipped: false,
            worktreePath,
            session: sessionWire,
          });
        } finally {
          releaseSessionWorktreeLock(sessionId, 'workspace-setup');
          finishWorkspaceEnsure(sessionId, workspaceSetupSucceeded);
        }
      } catch (err) {
        return res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.post(
    '/api/sessions/:sessionId/preview/start',
    requireRole('User'),
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.sessionId as string;
        const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
        if (!session) {
          return res.status(404).json({ error: 'Session not found' });
        }
        if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
          return res.status(404).json({ error: 'Session not found' });
        }
        const body = (req.body ?? {}) as {
          route?: string;
          reason?: string;
          mode?: 'rebuild' | 'restart-server';
        };
        const result = await startSessionPreview({
          sessionId,
          body,
          broadcast: deps.broadcast,
          findAgent,
          getDevServerRuntime: deps.getDevServerRuntime as
            | StartSessionPreviewDeps['getDevServerRuntime']
            | undefined,
          getSession: (id) => stmts.getSession.get(id) as SessionRow | undefined,
          routing: {
            publicUrl: config.publicUrl,
            subdomainBase: config.previewSubdomainBase,
          },
        });
        if (!result.ok) {
          return res.status(result.statusCode).json({ error: result.error });
        }
        return res.json({ ok: true, started: true });
      } catch (err) {
        return res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── Preview iframe ticket mint ────────────────────────────────────
  // The SPA calls this with its JWT (or per-user API key, or the global
  // x-api-key in dev) before pointing the iframe at the preview proxy.
  // The minted ticket is single-use and bound to (sessionId, caller).
  // See `server/preview-auth.ts` for the full mechanism rationale.
  router.post(
    '/api/sessions/:sessionId/preview/ticket',
    requireRole('User'),
    (req: Request, res: Response) => {
      const sessionId = req.params.sessionId as string;
      const ar = req as AuthenticatedRequest;
      if (!userOwnsSession(ar, sessionId)) {
        // Match the proxy handler's 404 shape so probing for valid
        // session ids returns the same response as a non-owned session.
        return res.status(404).json({ error: 'Session not found' });
      }
      const ctx = {
        userId: ar.authUserId ?? null,
        username: ar.authUser ?? null,
        role: ar.authRole ?? 'User',
        orgId: ar.authOrgId ?? null,
      };
      const ticket = mintPreviewTicket(sessionId, ctx);
      return res.json({
        ticket,
        ttlSeconds: Math.floor(PREVIEW_TICKET_TTL_MS / 1000),
      });
    },
  );

  // ── Preview state hydration ───────────────────────────────────────
  // `SessionPreviewPane` derives its status purely from live
  // `agenthub_preview` WS events. The WS connect-snapshot covers
  // (re)connects, but a `ready` frame dropped while the socket stays
  // open (transient blip, no reconnect) strands the pane on
  // `preview_starting` even though the backend group is `ready`. This
  // GET lets the client re-request the current truth and reconcile
  // without forcing a WS reconnect. Returns `{ event }` using the SAME
  // wire shape the WS connect-snapshot emits, or `{ event: null }` when
  // no preview is active for the session. Ownership-gated with the same
  // 404 shape as the ticket/proxy handlers so probing session ids leaks
  // nothing.
  router.get(
    '/api/sessions/:sessionId/preview/state',
    requireRole('User'),
    (req: Request, res: Response) => {
      const sessionId = req.params.sessionId as string;
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const runtime = deps.getDevServerRuntime?.() as SessionPreviewStateRuntime | null | undefined;
      const event = getSessionPreviewStateEvent(runtime, sessionId);
      return res.json({ event });
    },
  );

  const previewProxyHandler = createPreviewProxyHandler({
    getSessionPreviewPort: (sessionId, internalPort) =>
      getSessionPreviewPort(
        sessionId,
        {
          getDevServerRuntime: deps.getDevServerRuntime as
            | (() => DevServerPortLookup | null)
            | undefined,
        },
        internalPort,
      ),
    getSessionPreviewHost: (sessionId) => {
      const runtime = deps.getDevServerRuntime?.() as
        | { getSessionUpstreamHost?: (id: string) => string | null }
        | null
        | undefined;
      return runtime?.getSessionUpstreamHost?.(sessionId) ?? null;
    },
    userOwnsSession,
    // CSP frame-ancestors source for cross-origin iframe loads in
    // subdomain mode. `config.publicUrl` is normally
    // `https://agenthub.example.com`; the proxy uses its origin
    // (scheme + host) and falls back to 'self' when unset.
    parentPublicUrl: config.publicUrl,
    onProxyActivity: (sessionId) => deps.touchSessionEnv?.(sessionId),
  });
  router.all('/api/sessions/:sessionId/preview/proxy', requireRole('User'), previewProxyHandler);
  router.all('/api/sessions/:sessionId/preview/proxy/*', requireRole('User'), previewProxyHandler);

  router.post('/api/sessions/:sessionId/summarize', async (req: Request, res: Response) => {
    try {
      const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const messages = stmts.getMessages.all(req.params.sessionId) as MessageRow[];
      if (!messages.length) return res.status(400).json({ error: 'No messages to summarize' });

      const found = findAgent(session.agent_id);
      const agent = found?.agent;
      const project = found?.project;
      const transcript = buildTranscript(messages, { agentName: agent?.name });

      const summary = await summarizeTranscript(
        transcript,
        {
          engine: session.engine || agent?.engine || 'claude-code',
          model: session.model,
          cwd: project?.cwd,
        },
        config,
        project && session.agent_id
          ? {
              // No org-owner fallback — the session's own owner only.
              ownerId: getSessionOwner(session.id),
              agentId: session.agent_id,
              project,
            }
          : undefined,
      );

      res.json({ summary });
    } catch (err) {
      console.error('Summarize session error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // POST /api/sessions/:sessionId/extract-skill  (Skill Builder Phase 4)
  // ───────────────────────────────────────────────────────────────
  //
  // "Turn this session into a skill." Hands the source session's transcript
  // to the project's Skill Builder coach agent, which mines the repeated
  // context/procedures out of the real work and drafts a SKILL.md via the
  // Phase 1 write API ("extract, don't invent"). The coach runs in a fresh
  // (non-worktree) chat session — skill writes go through the skills REST API
  // into the project's `ahw` skills dir, not a git branch. Returns
  // `{ sessionId, agentId, session }`; the new coach session streams its
  // draft into chat for the user to review/edit and save.
  router.post('/api/sessions/:sessionId/extract-skill', (req: Request, res: Response) => {
    try {
      const source = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
      if (!source) return res.status(404).json({ error: 'Session not found' });

      // Ownership/visibility guard BEFORE reading the transcript. Without this
      // a caller who guesses another user's session id could exfiltrate that
      // session's full transcript into their own Skill Builder session. We use
      // the read predicate (shared reviewer threads stay readable) and return
      // 404 — not 403 — so a non-owner can't probe for the session's existence.
      // The `/api/sessions/:sessionId` mount middleware also enforces this for
      // POST, but keeping the check explicit here makes the security property
      // local and robust to any future change in route/middleware ordering.
      if (!userCanReadSession(req as AuthenticatedRequest, source.id)) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const messages = stmts.getMessages.all(req.params.sessionId) as MessageRow[];
      if (!messages.length) {
        return res.status(400).json({ error: 'Session has no messages to extract a skill from' });
      }

      const sourceFound = findAgent(source.agent_id);
      const project = sourceFound?.project;
      if (!project) {
        return res.status(400).json({ error: 'Source session has no resolvable project' });
      }

      // Skill Builder is a DEV-agent mode. Mirror the client's dev-agent
      // selection: prefer the source session's agent when it is itself a
      // non-helper dev agent, otherwise fall back to any active dev agent in the
      // project. Reject when the project has no eligible dev agent so extraction
      // never launches `session_mode='skill-builder'` on a docs / reviewer /
      // legacy skill-builder helper (the same roles the UI path rejects).
      const isDevAgent = (a: { role?: string; active?: boolean } | undefined): boolean =>
        !!a &&
        a.active !== false &&
        a.role !== 'skill-builder' &&
        a.role !== 'reviewer' &&
        a.role !== 'docs';
      const coachAgent = isDevAgent(sourceFound?.agent)
        ? sourceFound!.agent
        : (project.agents || []).find(isDevAgent);
      if (!coachAgent) {
        return res.status(400).json({
          error:
            'Skill Builder needs a dev agent — the source session’s project has no eligible agent.',
        });
      }
      const coachAgentId = coachAgent.id;

      const transcript = buildTranscript(messages, {
        agentName: sourceFound?.agent?.name,
        isRoom: (stmts.getSessionAgents.all(source.id) as unknown[]).length > 1,
      });

      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const newSessionId = uuidv4();
      const engine = coachAgent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: coachAgent.model,
        ownerUserId: ownerUid,
        agentId: coachAgentId,
      });
      const sessionName = buildExtractSkillSessionName(source.name);
      // No worktree: the coach saves skills via the write API, not git.
      stmts.createSession.run(newSessionId, coachAgentId, sessionName, engine, model, 0, 0, 1);
      stmts.updateSessionMode.run('skill-builder', newSessionId);
      setSessionOwner(newSessionId, ownerUid);

      const prompt = buildExtractSkillKickoffPrompt({
        projectId: project.id,
        sourceSessionId: source.id,
        sourceSessionName: source.name,
        sourceAgentName: sourceFound?.agent?.name,
        transcript,
      });

      // Fire-and-forget: the HTTP response is already returning. The coach's
      // first turn runs the extraction.
      void handleChat(null, {
        type: 'chat',
        agentId: coachAgentId,
        sessionId: newSessionId,
        content: prompt,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[extract-skill] handleChat failed for session ${newSessionId}: ${message}`);
      });

      const session = stmts.getSession.get(newSessionId) as SessionRow;
      const sessionWire = session ? enrichSessionForClient(session, stmts) : null;
      if (sessionWire) {
        broadcast({ type: 'session_created', agentId: coachAgentId, session: sessionWire });
      }
      res
        .status(201)
        .json({ sessionId: newSessionId, agentId: coachAgentId, session: sessionWire });
    } catch (err) {
      console.error('Extract skill error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/active-tasks', (_req: Request, res: Response) => {
    try {
      res.json(buildActiveTasksSnapshot(stmts));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/sessions/:sessionId/checkpoints', (req: Request, res: Response) => {
    try {
      const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const checkpoints = stmts.getCheckpoints.all(req.params.sessionId) as CheckpointRow[];
      res.json(checkpoints);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/sessions/:sessionId/rewind', (req: Request, res: Response) => {
    const parsed = parseBody(RewindRequestSchema, req, res);
    if (!parsed) return;
    const { uuid } = parsed;

    try {
      const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!engineSupportsCheckpointRewind(session.engine)) {
        return res.status(400).json({
          error:
            'Checkpoint file rewind is only supported for Claude Code sessions. Other engines do not expose an equivalent rewind API.',
          code: 'checkpoint_rewind_unsupported_engine',
        });
      }

      const checkpoint = stmts.getCheckpointByUuid.get(uuid) as CheckpointRow | undefined;
      if (!checkpoint) return res.status(404).json({ error: 'Checkpoint not found' });
      if (checkpoint.session_id !== req.params.sessionId) {
        return res.status(400).json({ error: 'Checkpoint does not belong to this session' });
      }

      if (activeProcesses.has(req.params.sessionId)) {
        return res.status(409).json({ error: 'Cannot rewind while session is actively running' });
      }

      const engineSessionId = session.engine_session_id;
      if (!engineSessionId) {
        return res.status(400).json({
          error:
            'Session has no engine_session_id — cannot rewind (session was never fully started)',
          code: 'checkpoint_rewind_no_engine_session',
        });
      }

      const cwd =
        session.worktree_path ||
        (() => {
          const found = findAgent(session.agent_id);
          return found?.project?.cwd || process.cwd();
        })();

      const claudeBin = config.claudeBin || 'claude';
      const args = [
        '--print',
        '--resume',
        engineSessionId,
        '--output-format',
        'stream-json',
        '--rewind-files',
        uuid,
      ];

      let output = '';
      let errorOutput = '';

      const REWIND_TIMEOUT_MS = 30_000;

      // No org-owner fallback — the session's own owner only. The rewind
      // spawn runs the Claude CLI, so it needs that owner's per-account creds;
      // EngineAuthRequiredError surfaces as a 409.
      const rewindOwnerId = getSessionOwner(req.params.sessionId);
      let rewindEnv: NodeJS.ProcessEnv;
      try {
        rewindEnv = {
          ...resolveSessionCliSpawnEnv({
            cfg: config,
            ownerId: rewindOwnerId,
            credsOwnerId: rewindOwnerId,
            sessionId: req.params.sessionId,
            engine: 'claude-code',
          }),
        };
      } catch (err) {
        if (err instanceof EngineAuthRequiredError) {
          return res.status(409).json({ error: err.message, code: 'no_account_credentials' });
        }
        throw err;
      }
      const rewindLookup = findAgent(session.agent_id);
      if (rewindLookup?.project && rewindOwnerId) {
        mergeSkillCredentialSpawnEnv(rewindEnv, {
          ownerId: rewindOwnerId,
          agentId: session.agent_id,
          project: rewindLookup.project,
        });
      }

      const proc = spawn(claudeBin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: rewindEnv,
      });
      trackChild(proc);

      const killTimer = setTimeout(() => {
        console.error(`[rewind] Process timed out after ${REWIND_TIMEOUT_MS}ms — killing`);
        killProcessGroup(proc);
      }, REWIND_TIMEOUT_MS);

      proc.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      proc.stderr!.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(killTimer);
        if (code !== 0 && !output.trim()) {
          console.error(`[rewind] claude exited code=${code}, stderr: ${errorOutput.trim()}`);
        }
        deps.broadcast({
          type: 'rewind-complete',
          sessionId: req.params.sessionId,
          uuid,
          success: code === 0,
        });
      });

      proc.on('error', (err: Error) => {
        clearTimeout(killTimer);
        console.error(`[rewind] Failed to spawn claude:`, err.message);
        deps.broadcast({
          type: 'rewind-complete',
          sessionId: req.params.sessionId,
          uuid,
          success: false,
          error: err.message,
        });
      });

      res.json({ status: 'rewind_started', uuid, sessionId: req.params.sessionId });
    } catch (err) {
      console.error('[rewind] Error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.patch('/api/sessions/:sessionId/checkpoints/:uuid', (req: Request, res: Response) => {
    const parsed = parseBody(PatchCheckpointRequestSchema, req, res);
    if (!parsed) return;
    const { label } = parsed;

    try {
      const checkpoint = stmts.getCheckpointByUuid.get(req.params.uuid) as
        | CheckpointRow
        | undefined;
      if (!checkpoint) return res.status(404).json({ error: 'Checkpoint not found' });
      if (checkpoint.session_id !== req.params.sessionId) {
        return res.status(400).json({ error: 'Checkpoint does not belong to this session' });
      }
      stmts.updateCheckpointLabel.run(label, req.params.uuid);
      res.json({ ...checkpoint, label });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Forward to agent ──────────────────────────────────────────

  const MAX_PROMPT_LENGTH = 50_000;
  const MAX_FORWARD_MESSAGES = 200;
  const MAX_FORWARD_CONTENT_BYTES = 512_000; // 500 KB

  interface ForwardBody {
    targetAgentId: string;
    messageIds?: string[];
    prompt?: string;
    autoStart?: boolean;
    model?: string;
  }

  /**
   * POST /api/sessions/:sessionId/forward
   *
   * Forward conversation context from one session to a different agent.
   * Creates a new session for the target agent with the forwarded messages
   * as the initial user message.
   *
   * Body:
   *   targetAgentId  (required) — agent to forward to
   *   messageIds     (optional) — specific message IDs to include (default: all)
   *   prompt         (optional) — extra instructions prepended to the forwarded context
   *   autoStart      (optional) — if true, immediately send the forwarded message to the
   *                                target agent's CLI (fire-and-forget, like background tasks).
   *                                Note: if the CLI spawn fails after the 201 response, the
   *                                session exists but the agent won't be running. Clients can
   *                                detect this via the normal WebSocket session status events.
   *   model          (optional) — override the model the new session runs. Must be valid for the
   *                                target agent's engine (400 otherwise). Defaults to the target
   *                                agent's own effective model.
   *
   * Limits: prompt max 50k chars; without messageIds only last 200 messages are forwarded;
   *         with messageIds, 400 if count exceeds 200 or content exceeds 500 KB.
   *
   * Returns: { session, forwardedMessageId }
   */
  router.post('/api/sessions/:sessionId/forward', (req: Request, res: Response) => {
    try {
      const {
        targetAgentId,
        messageIds,
        prompt,
        autoStart,
        model: requestedModel,
      } = req.body as ForwardBody;

      if (!targetAgentId) {
        return res.status(400).json({ error: 'targetAgentId is required' });
      }

      if (prompt && prompt.length > MAX_PROMPT_LENGTH) {
        return res
          .status(400)
          .json({ error: `prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters` });
      }

      // Validate source session
      const sourceSession = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
      if (!sourceSession) {
        return res.status(404).json({ error: 'Source session not found' });
      }

      // Validate target agent. The target may live in a *different* project
      // than the source — cross-project forwarding is supported. The client
      // only ever lists agents the caller can already see, but this route is
      // the real authorization boundary: enforce target-project visibility so
      // a caller cannot forward (and optionally auto-start a CLI) into a
      // private project they cannot view. Mask as the same 404 the client
      // would get for a genuinely missing agent so we don't leak existence.
      const targetFound = findAgent(targetAgentId);
      if (!targetFound) {
        return res.status(404).json({ error: `Target agent not found: ${targetAgentId}` });
      }
      const caller = resolveVisibilityCaller(req as AuthenticatedRequest);
      if (!canViewProject(targetFound.project, caller)) {
        return res.status(404).json({ error: `Target agent not found: ${targetAgentId}` });
      }

      // If autoStart requested, verify handleChat is available
      if (autoStart && !handleChat) {
        return res.status(503).json({
          error: 'Auto-start is not available — chat handler is not initialized',
        });
      }

      // Gather messages from source session
      const allMessages = stmts.getMessages.all(req.params.sessionId) as MessageRow[];
      if (!allMessages.length) {
        return res.status(400).json({ error: 'Source session has no messages to forward' });
      }

      // Cap forwarded messages to avoid huge payloads
      let selected: MessageRow[] = allMessages;
      if (!messageIds && allMessages.length > MAX_FORWARD_MESSAGES) {
        selected = allMessages.slice(-MAX_FORWARD_MESSAGES);
      }

      // Filter to specific messages if IDs provided
      if (messageIds && Array.isArray(messageIds) && messageIds.length > 0) {
        const idSet = new Set(messageIds);
        selected = allMessages.filter((m) => idSet.has(m.id));
        if (!selected.length) {
          return res.status(400).json({ error: 'None of the specified messageIds were found' });
        }
      }

      // Guard: cap the number of forwarded messages
      if (selected.length > MAX_FORWARD_MESSAGES) {
        return res.status(400).json({
          error: `Too many messages to forward (${selected.length}). Maximum is ${MAX_FORWARD_MESSAGES}.`,
        });
      }

      // Guard: cap total content size to avoid oversized payloads
      const totalBytes = selected.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0);
      if (totalBytes > MAX_FORWARD_CONTENT_BYTES) {
        const sizeMB = (totalBytes / 1_000_000).toFixed(1);
        return res.status(400).json({
          error: `Forwarded content is too large (${sizeMB} MB). Maximum is ${MAX_FORWARD_CONTENT_BYTES / 1_000} KB. Use messageIds to select a smaller subset.`,
        });
      }

      // Resolve source agent name for transcript labels
      const sourceFound = findAgent(sourceSession.agent_id);
      const sourceAgentName = sourceFound?.agent?.name || sourceSession.agent_id;
      const targetAgent = targetFound.agent;

      // Build the forwarded context as a transcript
      const transcript = buildTranscript(selected, { agentName: sourceAgentName });

      // Assemble the forwarded message content
      const parts: string[] = [];
      if (prompt) {
        parts.push(prompt.trim());
        parts.push('');
      }
      parts.push(`--- Forwarded from session with ${sourceAgentName} ---`);
      parts.push('');
      parts.push(transcript);
      parts.push('');
      parts.push('--- End of forwarded context ---');

      const forwardedContent = parts.join('\n');

      // Create a new session for the target agent
      const newSessionId = uuidv4();
      const truncatedName = `[Fwd] ${sourceAgentName}: ${sourceSession.name || 'Session'}`.slice(
        0,
        100,
      );
      const engine = targetAgent.engine || 'claude-code';
      // Optional per-fork model override (lets the user pick which model the new
      // copy of the agent runs). Validate against the engine's allowlist so a
      // client cannot seed a session with an arbitrary model id; an empty/absent
      // value falls through to the agent's own effective model as before.
      const overrideModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
      if (overrideModel) {
        const allowed = config.engineValidModels?.[engine] || [];
        if (!allowed.includes(overrideModel)) {
          return res
            .status(400)
            .json({ error: `model "${overrideModel}" is not valid for engine ${engine}` });
        }
      }
      const fwdOwnerUid = getSessionOwner(String(req.params.sessionId));
      const model = resolveEffectiveModel(config, engine, {
        explicitModel: overrideModel || undefined,
        agentModel: targetAgent.model,
        ownerUserId: fwdOwnerUid,
        agentId: targetAgentId,
      });
      const wt = defaultSessionUseWorktreeFlag(targetFound.project);
      stmts.createSession.run(newSessionId, targetAgentId, truncatedName, engine, model, wt, 0, 1);
      // Forwarded session inherits ownership from the source — the caller
      // must own the source (gated by the prefix middleware above), and the
      // forwarded transcript should stay strictly with that same user.
      inheritOwnerFromSession(newSessionId, String(req.params.sessionId));

      // When autoStart is true, handleChat will store the user message itself,
      // so we only pre-store it when NOT auto-starting (to avoid duplicates).
      let forwardedMessageId: string | null = null;
      if (!autoStart) {
        forwardedMessageId = uuidv4();
        stmts.addMessage.run(
          forwardedMessageId,
          newSessionId,
          'user',
          forwardedContent,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        );
        stmts.touchSession.run(newSessionId);
      }

      const newSession = stmts.getSession.get(newSessionId) as SessionRow;
      const newSessionWire = enrichSessionForClient(newSession, stmts);

      // Broadcast so all clients know a new forwarded session was created
      deps.broadcast({
        type: 'session_forwarded',
        sourceSessionId: req.params.sessionId,
        targetAgentId,
        session: newSessionWire,
        forwardedMessageId,
      });

      // Optionally auto-start the target agent (fire-and-forget like background tasks).
      // handleChat stores the user message and spawns the CLI process.
      if (autoStart && handleChat) {
        handleChat(null, {
          type: 'chat',
          agentId: targetAgentId,
          sessionId: newSessionId,
          content: forwardedContent,
        });
      }

      res.status(201).json({ session: newSessionWire, forwardedMessageId });
    } catch (err) {
      console.error('Forward session error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/sessions/:sessionId/follow-up
   *
   * Start a follow-up session from this one. Same agent by default, a fresh
   * worktree branch, and an initial message that quotes the source session's
   * Finalize summary (including the follow-up steps it flagged) instead of the
   * whole transcript.
   *
   * This is the affordance behind `POST_FINALIZE_PUSH_LOCK_MESSAGE`: once a
   * session has pushed, it is locked in ask mode and telling the operator to
   * "start a new session" left them to rebuild the context by hand.
   *
   * ## Authorization on the SOURCE session
   *
   * There is no inline owner check here, and that is deliberate: the
   * `router.use('/api/sessions/:sessionId', …)` prefix gate registered far
   * above runs `userOwnsSession` for every non-GET method and 404s first. Same
   * contract `/forward` relies on.
   *
   * That gate is load-bearing rather than belt-and-braces. This route reads the
   * source session's transcript, its Finalize summary, and its PR url, then
   * inherits its owner — so losing it is an exfiltration primitive, not just an
   * unauthorized write. The `canViewProject` check below does NOT cover for it:
   * that validates the target agent's *project*, which teammates routinely
   * share. Pinned by `test/session-ownership-isolation.test.ts` →
   * "foreign user cannot exfiltrate a session's transcript via POST /follow-up",
   * which is built so it fails if the prefix gate stops enforcing ownership.
   *
   * Body:
   *   targetAgentId  (optional) — defaults to the source session's own agent
   *   prompt         (optional) — what the follow-up should actually do
   *   autoStart      (optional) — dispatch to the CLI immediately
   *
   * Validated against `FollowUpSessionRequestSchema` — the same schema the
   * OpenAPI doc publishes — rather than by hand. `autoStart` in particular
   * must be a real boolean: a JSON string like `"false"` is truthy, and
   * coercing it would spawn a CLI process the caller never asked for.
   *
   * Returns: { session, seededMessageId }
   */
  router.post('/api/sessions/:sessionId/follow-up', (req: Request, res: Response) => {
    try {
      const body = parseBody(FollowUpSessionRequestSchema, req, res);
      if (!body) return;
      const { targetAgentId, prompt, autoStart } = body;

      const sourceSessionId = String(req.params.sessionId);
      const sourceSession = stmts.getSession.get(sourceSessionId) as SessionRow | undefined;
      if (!sourceSession) {
        return res.status(404).json({ error: 'Source session not found' });
      }

      // Default to the source agent — a follow-up is normally "same agent,
      // clean slate". An explicit target still goes through the same
      // visibility boundary the forward route enforces, so a caller cannot
      // seed (and optionally auto-start) a session in a project they cannot
      // see. Mask as 404 rather than 403 so we don't leak existence.
      const resolvedTargetAgentId = targetAgentId || sourceSession.agent_id;
      const targetFound = findAgent(resolvedTargetAgentId);
      if (!targetFound) {
        return res.status(404).json({ error: `Target agent not found: ${resolvedTargetAgentId}` });
      }
      const caller = resolveVisibilityCaller(req as AuthenticatedRequest);
      if (!canViewProject(targetFound.project, caller)) {
        return res.status(404).json({ error: `Target agent not found: ${resolvedTargetAgentId}` });
      }

      if (autoStart && !handleChat) {
        return res.status(503).json({
          error: 'Auto-start is not available — chat handler is not initialized',
        });
      }

      const sourceFound = findAgent(sourceSession.agent_id);
      const sourceAgentName = sourceFound?.agent?.name || sourceSession.agent_id;

      let sourceMessages: MessageRow[] = [];
      try {
        sourceMessages = stmts.getMessages.all(sourceSessionId) as MessageRow[];
      } catch (err) {
        // A follow-up with no quoted context is still more useful than a 500 —
        // the operator's own prompt survives.
        console.warn(
          `[session-follow-up] getMessages failed (${sourceSessionId}):`,
          err instanceof Error ? err.message : String(err),
        );
      }

      const summary = findLatestFinalizeSummary(sourceMessages);
      const transcript = summary
        ? null
        : buildTranscript(sourceMessages.slice(-MAX_FOLLOW_UP_TRANSCRIPT_MESSAGES), {
            agentName: sourceAgentName,
          });

      let prUrl: string | null = null;
      try {
        const pushedRun = stmts.getPushedFinalizeRunForSession.get(sourceSessionId) as
          | FinalizeRunRow
          | undefined;
        prUrl = pushedRun?.pr_url ?? null;
      } catch {
        prUrl = null;
      }

      const seedContent = buildFollowUpSeedMessage({
        sourceAgentName,
        sourceSessionName: sourceSession.name,
        prompt,
        summary,
        transcript,
        prUrl,
      });

      const targetAgent = targetFound.agent;
      const newSessionId = uuidv4();
      const engine = targetAgent.engine || 'claude-code';
      const ownerUid = getSessionOwner(sourceSessionId);
      const model = resolveEffectiveModel(config, engine, {
        agentModel: targetAgent.model,
        ownerUserId: ownerUid,
        agentId: resolvedTargetAgentId,
      });
      const wt = defaultSessionUseWorktreeFlag(targetFound.project);
      stmts.createSession.run(
        newSessionId,
        resolvedTargetAgentId,
        buildFollowUpSessionName(sourceSession.name),
        engine,
        model,
        wt,
        0,
        1,
      );
      // Same rule as forward: the caller already owns the source (enforced by
      // the prefix middleware), and the quoted context stays with that user.
      inheritOwnerFromSession(newSessionId, sourceSessionId);

      // handleChat stores the user message itself, so pre-storing on the
      // auto-start path would duplicate it.
      let seededMessageId: string | null = null;
      if (!autoStart) {
        seededMessageId = uuidv4();
        stmts.addMessage.run(
          seededMessageId,
          newSessionId,
          'user',
          seedContent,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        );
        stmts.touchSession.run(newSessionId);
      }

      const newSession = stmts.getSession.get(newSessionId) as SessionRow;
      const newSessionWire = enrichSessionForClient(newSession, stmts);

      // Reuses the forward event so every client's existing sidebar-splice and
      // navigation handling picks the new session up unchanged.
      deps.broadcast({
        type: 'session_forwarded',
        sourceSessionId,
        targetAgentId: resolvedTargetAgentId,
        session: newSessionWire,
        forwardedMessageId: seededMessageId,
        followUp: true,
      });

      if (autoStart && handleChat) {
        handleChat(null, {
          type: 'chat',
          agentId: resolvedTargetAgentId,
          sessionId: newSessionId,
          content: seedContent,
        });
      }

      res.status(201).json({ session: newSessionWire, seededMessageId });
    } catch (err) {
      console.error('Follow-up session error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/sessions/:sessionId/ship', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    try {
      const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const agentLookup = findAgent(session.agent_id);
      if (!agentLookup) return res.status(404).json({ error: 'Agent not found' });

      const { project, agent } = agentLookup;
      const result = triggerSessionShip({
        sessionId,
        session,
        project,
        agent,
        stmts,
        broadcast,
        activeProcesses,
        handleChat,
      });
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, code: result.code });
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[session-ship] Error for session ${sessionId}:`, (err as Error).message);
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
