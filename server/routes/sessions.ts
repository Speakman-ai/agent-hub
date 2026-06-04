import { v4 as uuidv4 } from 'uuid';
import { spawn, ChildProcess } from 'child_process';
import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import config from '../config.js';
import { resolveSessionCliSpawnEnv, EngineAuthRequiredError } from '../per-user-cli-spawn.js';
import { resolveEffectiveEngineAndModel, resolveEffectiveModel } from '../effective-model.js';
import {
  CreateSessionRequestSchema,
  PatchSessionRequestSchema,
  ToggleEnabledRequestSchema,
  PutSessionEngineRequestSchema,
  PutSessionModelRequestSchema,
  RewindRequestSchema,
  PatchCheckpointRequestSchema,
} from './sessions.openapi.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { markSessionTermination } from '../process-termination.js';
import { getDb } from '../db.js';
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
import type {
  RouteDeps,
  AppConfig,
  MessageRow,
  SessionRow,
  SessionAgentRow,
  BackgroundTaskRow,
  SessionEventRow,
  SessionProgressRow,
  CheckpointRow,
  AgentLookup,
  EnrichedAgent,
  KanbanCardRow,
  SkillInvocationRow,
  Project,
} from '../types.js';
import { mergeSkillCredentialSpawnEnv } from '../skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from '../project-secrets-spawn.js';
import { mergeProjectAwsSpawnEnv } from '../project-aws-spawn.js';
import { buildActiveTasksSnapshot } from '../active-tasks.js';
import { inferPrUrlFromSessionTitle } from '../session-title-pr.js';
import { checkWorktreeChanges } from '../auto-git.js';
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
import { isPreviewSetupWizardSession } from './preview-wizard.js';
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
import { mintPreviewTicket, PREVIEW_TICKET_TTL_MS } from '../preview-auth.js';
import type {
  PreviewComposeRuntimeSync,
  PreviewRuntimeActiveLookup,
} from '../preview/preview-runtime-lookup.js';
import { triggerSessionShip } from '../session-ship.js';
import {
  enrichSessionForClient,
  engineSupportsCheckpointRewind,
} from '../session-checkpoint-rewind.js';
import { enrichSessionWithAgents } from '../session-agents.js';
import type { AuthenticatedRequest } from '../auth.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
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
  const DEFAULT_MODEL = config.defaultModel;
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
    if (engine === 'gemini-cli' || engine === 'codex-cli') {
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
  const { stmts, findAgent, getEnrichedAgent, handleChat, config, activeProcesses, broadcast } =
    deps;

  /**
   * Tear down any preview groups owned by `sessionId` across both runtimes.
   * Each runtime's `stopBySessionId` is a no-op for rows it does not own.
   */
  async function stopPreviewsForSession(sessionId: string): Promise<void> {
    const composeRuntime = deps.getPreviewComposeRuntime?.();
    const legacyRuntime = deps.getPreviewRuntime?.();
    const tasks: Promise<unknown>[] = [];
    if (composeRuntime) {
      tasks.push(
        composeRuntime.stopBySessionId(sessionId).catch((err) => {
          console.warn(
            `[sessions] preview-compose stopBySessionId failed (${sessionId}):`,
            (err as Error).message,
          );
        }),
      );
    }
    if (legacyRuntime) {
      tasks.push(
        legacyRuntime.stopBySessionId(sessionId).catch((err) => {
          console.warn(
            `[sessions] preview stopBySessionId failed (${sessionId}):`,
            (err as Error).message,
          );
        }),
      );
    }
    await Promise.all(tasks);
  }

  /** Fire-and-forget variant for bulk archive loops. */
  function stopPreviewsBestEffort(sessionId: string): void {
    void stopPreviewsForSession(sessionId).catch((err) => {
      console.warn(`[sessions] preview teardown failed (${sessionId}):`, (err as Error).message);
    });
  }

  const router = Router();

  router.get('/api/agents/:agentId/sessions', (req: Request, res: Response) => {
    const all = stmts.getSessions.all(req.params.agentId) as SessionRow[];
    // Per-user read filter. Strict ownership for normal sessions; shared
    // sessions (reviewer threads spawned from GitHub webhooks) are
    // visible to everyone so all users can inspect a PR review.
    const sessions = all.filter((s) => userCanReadSession(req as AuthenticatedRequest, s.id));
    res.json(sessions.map((s) => enrichSessionForClient(s, stmts)));
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
    // Agent Hub is worktree-only for user-facing session creation.
    // `defaultSessionUseWorktreeFlag` returns 1 unconditionally; internal
    // callers that need a shared-checkout session (preview-wizard) bypass
    // this route and write directly to `stmts.createSession`.
    const useWorktree = defaultSessionUseWorktreeFlag(found?.project);
    const askMode = parsed.ask_mode ? 1 : 0;
    stmts.createSession.run(id, req.params.agentId, name, engine, model, useWorktree, askMode, 1);
    setSessionOwner(id, resolveOwnerUserId(req as AuthenticatedRequest));
    const session = stmts.getSession.get(id) as SessionRow;
    const sessionWire = enrichSessionForClient(session, stmts);
    deps.broadcast({ type: 'session_created', agentId: req.params.agentId, session: sessionWire });
    res.json(sessionWire);
  });

  router.get('/api/sessions/cron', (req: Request, res: Response) => {
    const all = stmts.getAllCronSessions.all() as SessionRow[];
    // Cron sessions are owned by the org owner; non-owners see nothing.
    const sessions = all.filter((s) => userOwnsSession(req as AuthenticatedRequest, s.id));
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
    res.json({
      ...enrichSessionWithAgents(session, stmts, getEnrichedAgent),
      orchestrationMeta: parseOrchestrationMetaJson(session.orchestration_meta ?? null),
    });
  });

  router.get('/api/sessions/:sessionId/messages', (req: Request, res: Response) => {
    const all = stmts.getMessages.all(req.params.sessionId) as MessageRow[];
    const limited = applyMessagesLimitQuery(all, req.query.limit);
    const body = buildSessionMessagesHttpBody(limited);
    if (!Array.isArray(body) && body.truncated) {
      console.warn(
        `[Sessions] Truncated messages for session ${req.params.sessionId}: ${body.omitted}/${body.total} omitted`,
      );
    }
    sendSessionMessagesJson(res, body);
  });

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
    res.status(201).json({ taskId, sessionId, session: enrichSessionForClient(session, stmts) });
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

  router.get('/api/tasks/:taskId', (req: Request, res: Response) => {
    const task = stmts.getBackgroundTask.get(req.params.taskId) as BackgroundTaskRow | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!userOwnsSession(req as AuthenticatedRequest, task.session_id)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const agent = getEnrichedAgent(task.agent_id);
    const messages = stmts.getMessages.all(task.session_id) as MessageRow[];
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
    const inferredTitlePr = inferPrUrlFromSessionTitle(session.name, githubRepo);
    const sessionTitlePrUrl = !linkedCardPrUrl && inferredTitlePr ? inferredTitlePr : null;

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
      const changes = await checkWorktreeChanges(session.worktree_path);
      res.json({
        branch: changes.branch,
        hasUncommitted: changes.hasUncommitted,
        hasUnpushed: changes.hasUnpushed,
        committable: changes.hasUncommitted || changes.hasUnpushed,
        headSha: changes.headSha || null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'worktree_status_failed', message: msg });
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

  router.delete('/api/agents/:agentId/sessions', (req: Request, res: Response) => {
    const sessions = (stmts.getAllSessionsByAgent.all(req.params.agentId) as SessionRow[]).filter(
      (s) => userOwnsSession(req as AuthenticatedRequest, s.id),
    );
    let archived = 0;
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
      stopPreviewsBestEffort(session.id);
      stmts.softDeleteSession.run(session.id);
      archived++;
      try {
        deps.broadcast({ type: 'session_deleted', sessionId: session.id });
      } catch {
        /* best-effort */
      }
    }
    // `deleted` mirrors `archived` for older clients that only read `deleted`.
    res.json({ ok: true, archived, deleted: archived });
  });

  router.delete('/api/agents/:agentId/sessions/inactive', (req: Request, res: Response) => {
    const sessions = (stmts.getAllSessionsByAgent.all(req.params.agentId) as SessionRow[]).filter(
      (s) => userOwnsSession(req as AuthenticatedRequest, s.id),
    );
    let archived = 0;
    for (const session of sessions) {
      if (session.deleted_at) continue;
      if (activeProcesses.has(session.id)) continue;
      closeBrowserBestEffort(session.id);
      stopPreviewsBestEffort(session.id);
      stmts.softDeleteSession.run(session.id);
      archived++;
      try {
        deps.broadcast({ type: 'session_deleted', sessionId: session.id });
      } catch {
        /* best-effort */
      }
    }
    res.json({ ok: true, archived, deleted: archived });
  });

  // Single-session DELETE is a *soft* delete (archive). The row is marked with
  // `deleted_at` so it disappears from the live sidebar but stays recoverable
  // via POST /api/sessions/:sessionId/restore for 24 hours. We deliberately
  // leave the worktree on disk so a restore can reattach the same checkout.
  // Bulk `DELETE /api/agents/:agentId/sessions[/inactive]` uses the same
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
    await stopPreviewsForSession(sessionId);

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
    const restored = stmts.getSession.get(sessionId) as SessionRow;
    const restoredWire = enrichSessionForClient(restored, stmts);

    try {
      deps.broadcast({ type: 'session_restored', sessionId, session: restoredWire });
    } catch {
      /* best-effort */
    }

    res.json(restoredWire);
  });

  router.patch('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const parsed = parseBody(PatchSessionRequestSchema, req, res);
    if (!parsed) return;
    if (parsed.name) {
      stmts.updateSessionName.run(parsed.name, req.params.sessionId);
    }
    if (parsed.max_turns !== undefined) {
      stmts.updateSessionMaxTurns.run(parsed.max_turns, req.params.sessionId);
    }
    if (parsed.finalize_automation !== undefined) {
      stmts.updateSessionFinalizeAutomation.run(parsed.finalize_automation, req.params.sessionId);
    }
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow;
    const enriched = enrichSessionWithAgents(session, stmts, getEnrichedAgent);
    deps.broadcast({ type: 'session-updated', session: enriched });
    res.json(enriched);
  });

  router.post('/api/sessions/:sessionId/agents', (req: Request, res: Response) => {
    const { agentId } = req.body as { agentId?: string };
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (agentId === session.agent_id) {
      return res.status(400).json({ error: 'Cannot add the primary agent as an advisor' });
    }
    const found = findAgent(agentId);
    if (!found) return res.status(404).json({ error: 'Agent not found' });
    const caller = resolveVisibilityCaller(req);
    if (!canViewProject(found.project, caller)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (found.agent?.role === 'reviewer') {
      return res.status(403).json({ error: 'Reviewer agents cannot join multi-agent sessions' });
    }
    stmts.addSessionAgent.run(req.params.sessionId, agentId, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    deps.broadcast({
      type: 'session-updated',
      session: enrichSessionWithAgents(updated, stmts, getEnrichedAgent),
    });
    res.json(enrichSessionWithAgents(updated, stmts, getEnrichedAgent));
  });

  router.delete('/api/sessions/:sessionId/agents/:agentId', (req: Request, res: Response) => {
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.params.agentId === session.agent_id) {
      return res.status(400).json({ error: 'Cannot remove the primary executor agent' });
    }
    stmts.removeSessionAgent.run(req.params.sessionId, req.params.agentId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    deps.broadcast({
      type: 'session-updated',
      session: enrichSessionWithAgents(updated, stmts, getEnrichedAgent),
    });
    res.json(enrichSessionWithAgents(updated, stmts, getEnrichedAgent));
  });

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
    const ALL_VALID_MODELS = config.allValidModels;
    const ENGINE_VALID_MODELS = config.engineValidModels;
    if (!ALL_VALID_MODELS.includes(model)) {
      return res
        .status(400)
        .json({ error: `Invalid model. Must be one of: ${ALL_VALID_MODELS.join(', ')}` });
    }
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const engine = session.engine || 'claude-code';
    const allowed = ENGINE_VALID_MODELS[engine] || ENGINE_VALID_MODELS['claude-code'];
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
  // kept on the row for legacy data + internal callers (preview-wizard
  // spawns shared-checkout sessions) but is no longer user-toggleable.

  router.put('/api/sessions/:sessionId/ask-mode', (req: Request, res: Response) => {
    const parsed = parseBody(ToggleEnabledRequestSchema, req, res);
    if (!parsed) return;
    const { enabled } = parsed;
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.updateSessionAskMode.run(enabled ? 1 : 0, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(enrichSessionForClient(updated, stmts));
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
   * `worktree_preview_processes` tables; no PreviewRuntime instance
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
        await stopPreviewsForSession(sessionId);
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
        if (
          isPreviewSetupWizardSession(session) ||
          !sessionUsesWorktree(session) ||
          getProjectMode(project) === 'workflow'
        ) {
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
        const worktreePath = await deps.provisionSessionWorkspace(sessionId);
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
        const body = (req.body ?? {}) as { route?: string; reason?: string };
        const result = await startSessionPreview({
          sessionId,
          body,
          broadcast: deps.broadcast,
          findAgent,
          getPreviewRuntime: deps.getPreviewRuntime as StartSessionPreviewDeps['getPreviewRuntime'],
          getPreviewComposeRuntime:
            deps.getPreviewComposeRuntime as StartSessionPreviewDeps['getPreviewComposeRuntime'],
          getSession: (id) => stmts.getSession.get(id) as SessionRow | undefined,
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

  const previewProxyHandler = createPreviewProxyHandler({
    getSessionPreviewPort: (sessionId) =>
      getSessionPreviewPort(sessionId, {
        getPreviewComposeRuntime: deps.getPreviewComposeRuntime as
          | (() => PreviewComposeRuntimeSync | null)
          | undefined,
        getPreviewRuntime: deps.getPreviewRuntime as
          | (() => PreviewRuntimeActiveLookup | null)
          | undefined,
      }),
    userOwnsSession,
    // CSP frame-ancestors source for cross-origin iframe loads in
    // subdomain mode. `config.publicUrl` is normally
    // `https://agenthub.example.com`; the proxy uses its origin
    // (scheme + host) and falls back to 'self' when unset.
    parentPublicUrl: config.publicUrl,
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
   *
   * Limits: prompt max 50k chars; without messageIds only last 200 messages are forwarded;
   *         with messageIds, 400 if count exceeds 200 or content exceeds 500 KB.
   *
   * Returns: { session, forwardedMessageId }
   */
  router.post('/api/sessions/:sessionId/forward', (req: Request, res: Response) => {
    try {
      const { targetAgentId, messageIds, prompt, autoStart } = req.body as ForwardBody;

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

      // Validate target agent
      const targetFound = findAgent(targetAgentId);
      if (!targetFound) {
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
      const fwdOwnerUid = getSessionOwner(String(req.params.sessionId));
      const model = resolveEffectiveModel(config, engine, {
        agentModel: targetAgent.model,
        ownerUserId: fwdOwnerUid,
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
