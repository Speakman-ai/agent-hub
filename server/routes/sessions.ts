import { v4 as uuidv4 } from 'uuid';
import { spawn, ChildProcess } from 'child_process';
import { Router, Request, Response } from 'express';
import { defaultModelForEngine, buildSpawnEnv } from '../config.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { getDb } from '../db.js';
import { manualCommitAndPR } from '../auto-git.js';
import {
  buildSessionRunSnapshot,
  buildAggregationSkippedRunSnapshot,
  getSnapshotAggregateLimit,
} from '../session-run-snapshot.js';
import type {
  RouteDeps,
  AppConfig,
  MessageRow,
  SessionRow,
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
import { buildActiveTasksSnapshot } from '../active-tasks.js';
import { inferPrUrlFromSessionTitle } from '../session-title-pr.js';
import { closeBrowserSession } from '../browser.js';
import {
  normalizeOrchestrationMetaInput,
  parseOrchestrationMetaJson,
  parseOrchestrationPhase,
} from '../orchestration.js';
import { defaultSessionUseWorktreeFlag, getProjectMode } from '../project-mode.js';
import {
  resolveOwnerUserId,
  setSessionOwner,
  inheritOwnerFromSession,
  userOwnsSession,
  getSessionOwner,
  getOrgOwnerUserId,
} from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { type: 'unknown', text: s };
  }
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

    const spawnEnv = { ...buildSpawnEnv(config) };
    if (skillCredentialMerge) {
      mergeSkillCredentialSpawnEnv(spawnEnv, skillCredentialMerge);
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
  const { stmts, findAgent, getEnrichedAgent, handleChat, config, activeProcesses } = deps;

  const router = Router();

  router.get('/api/agents/:agentId/sessions', (req: Request, res: Response) => {
    const all = stmts.getSessions.all(req.params.agentId) as SessionRow[];
    // Strict per-user filter: hide sessions whose owner doesn't match the
    // caller. NULL-owner rows (pre-Phase-4 legacy / mid-migration) fall
    // through to `userOwnsSession`, which treats them as org-owner-owned.
    const sessions = all.filter((s) => userOwnsSession(req as AuthenticatedRequest, s.id));
    res.json(sessions);
  });

  router.post('/api/agents/:agentId/sessions', (req: Request, res: Response) => {
    const id = uuidv4();
    const name = req.body.name || `Session ${new Date().toLocaleString()}`;
    const found = findAgent(req.params.agentId as string);
    const engine = req.body.engine || found?.agent?.engine || 'claude-code';
    const model = req.body.model || found?.agent?.model || defaultModelForEngine(engine);
    let useWorktree =
      req.body.use_worktree !== undefined
        ? req.body.use_worktree
          ? 1
          : 0
        : defaultSessionUseWorktreeFlag(found?.project);
    if (getProjectMode(found?.project) === 'workflow') useWorktree = 0;
    const askMode = req.body.ask_mode ? 1 : 0;
    stmts.createSession.run(id, req.params.agentId, name, engine, model, useWorktree, askMode, 1);
    setSessionOwner(id, resolveOwnerUserId(req as AuthenticatedRequest));
    const session = stmts.getSession.get(id) as SessionRow;
    deps.broadcast({ type: 'session_created', agentId: req.params.agentId, session });
    res.json(session);
  });

  router.get('/api/sessions/cron', (req: Request, res: Response) => {
    const all = stmts.getAllCronSessions.all() as SessionRow[];
    // Cron sessions are owned by the org owner; non-owners see nothing.
    const sessions = all.filter((s) => userOwnsSession(req as AuthenticatedRequest, s.id));
    res.json(sessions);
  });

  /**
   * Strict per-user gate for everything under `/api/sessions/:sessionId`.
   * Returns 404 (not 403) so non-owners can't probe for the existence
   * of another user's sessions. Registered here so the static
   * `/api/sessions/cron` handler above is reached first.
   */
  router.use('/api/sessions/:sessionId', (req, res, next) => {
    const sid = (req.params as { sessionId?: string }).sessionId;
    if (!sid || sid === 'cron') return next();
    if (!userOwnsSession(req as AuthenticatedRequest, sid)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    return next();
  });

  router.get('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({
      ...session,
      orchestrationMeta: parseOrchestrationMetaJson(session.orchestration_meta ?? null),
    });
  });

  router.get('/api/sessions/:sessionId/messages', (req: Request, res: Response) => {
    const messages = stmts.getMessages.all(req.params.sessionId) as MessageRow[];
    res.json(messages);
  });

  router.post('/api/tasks', (req: Request, res: Response) => {
    const { agentId, prompt } = req.body;
    if (!agentId || !prompt) {
      return res.status(400).json({ error: 'agentId and prompt are required' });
    }

    const found = findAgent(agentId);
    if (!found) return res.status(404).json({ error: `Unknown agent: ${agentId}` });

    const taskId = uuidv4();
    const sessionId = uuidv4();

    const engine = found.agent.engine || 'claude-code';
    const model = found.agent.model || defaultModelForEngine(engine);
    const sessionName = `[BG] ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`;
    const wt = getProjectMode(found.project) === 'workflow' ? 0 : 1;
    stmts.createSession.run(sessionId, agentId, sessionName, engine, model, wt, 0, 1);
    setSessionOwner(sessionId, resolveOwnerUserId(req as AuthenticatedRequest));

    stmts.insertBackgroundTask.run(taskId, sessionId, agentId, prompt);

    handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: prompt,
    });

    const session = stmts.getSession.get(sessionId) as SessionRow;
    res.status(201).json({ taskId, sessionId, session });
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
          proc.kill('SIGTERM');
        } catch {
          /* best-effort */
        }
        activeProcesses.delete(session.id);
      }
      closeBrowserBestEffort(session.id);
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
  router.delete('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Kill any in-flight CLI process so the archived session isn't still
    // streaming output into a hidden row.
    const proc = activeProcesses.get(sessionId);
    if (proc) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      activeProcesses.delete(sessionId);
    }

    closeBrowserBestEffort(sessionId);

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
    res.json(rows);
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

    try {
      deps.broadcast({ type: 'session_restored', sessionId, session: restored });
    } catch {
      /* best-effort */
    }

    res.json(restored);
  });

  router.patch('/api/sessions/:sessionId', (req: Request, res: Response) => {
    if (req.body.name) {
      stmts.updateSessionName.run(req.body.name, req.params.sessionId);
    }
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(session);
  });

  router.put('/api/sessions/:sessionId/engine', (req: Request, res: Response) => {
    const { engine } = req.body;
    if (!engine || !['claude-code', 'cursor-agent', 'gemini-cli', 'codex-cli'].includes(engine)) {
      return res.status(400).json({
        error: 'Invalid engine. Must be claude-code, cursor-agent, gemini-cli, or codex-cli',
      });
    }
    // Load the session BEFORE updating the engine so we can check whether
    // the current model is still valid for the new engine. If not, reset
    // the model to the engine's default. Without this step, the session
    // ends up in a mixed state (e.g. engine=codex-cli, model=claude-opus-4-7)
    // and the next `PUT .../model` call — which the client fires right
    // after — 400s with "Model X is not valid for engine Y".
    const existing = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    const allowedForNewEngine = config.engineValidModels[engine] || [];
    getDb().transaction(() => {
      stmts.updateSessionEngine.run(engine, req.params.sessionId);
      stmts.updateSessionEngineSessionId.run(null, req.params.sessionId);
      if (!existing.model || !allowedForNewEngine.includes(existing.model)) {
        stmts.updateSessionModel.run(defaultModelForEngine(engine), req.params.sessionId);
      }
    })();
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  router.put('/api/sessions/:sessionId/model', (req: Request, res: Response) => {
    const { model } = req.body;
    const ALL_VALID_MODELS = config.allValidModels;
    const ENGINE_VALID_MODELS = config.engineValidModels;
    if (!model || !ALL_VALID_MODELS.includes(model)) {
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
    res.json(updated);
  });

  router.put('/api/sessions/:sessionId/worktree', (req: Request, res: Response) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const agentLookup = findAgent(session.agent_id);
    if (enabled && agentLookup && getProjectMode(agentLookup.project) === 'workflow') {
      return res.status(403).json({
        error: 'Per-session worktrees are disabled while this project is in workflow mode',
      });
    }
    stmts.updateSessionWorktree.run(enabled ? 1 : 0, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(updated);
  });

  router.put('/api/sessions/:sessionId/ask-mode', (req: Request, res: Response) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.updateSessionAskMode.run(enabled ? 1 : 0, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(updated);
  });

  router.put('/api/sessions/:sessionId/react-loop', (req: Request, res: Response) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.updateSessionReactLoop.run(enabled ? 1 : 0, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId) as SessionRow;
    res.json(updated);
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
    deps.broadcast({ type: 'session-updated', session: updated });
    res.json({
      ...updated,
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
              ownerId: getSessionOwner(session.id) || getOrgOwnerUserId(),
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
    const { uuid } = req.body || {};
    if (!uuid) return res.status(400).json({ error: 'uuid is required' });

    try {
      const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.engine !== 'claude-code') {
        return res.status(400).json({ error: 'Checkpoints are only supported for Claude Code' });
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

      const rewindEnv = { ...buildSpawnEnv(config) };
      const rewindOwnerId = getSessionOwner(req.params.sessionId) || getOrgOwnerUserId();
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
    const { label } = req.body || {};
    if (label === undefined) return res.status(400).json({ error: 'label is required' });

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
      const model = targetAgent.model || defaultModelForEngine(engine);
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
        );
        stmts.touchSession.run(newSessionId);
      }

      const newSession = stmts.getSession.get(newSessionId) as SessionRow;

      // Broadcast so all clients know a new forwarded session was created
      deps.broadcast({
        type: 'session_forwarded',
        sourceSessionId: req.params.sessionId,
        targetAgentId,
        session: newSession,
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

      res.status(201).json({ session: newSession, forwardedMessageId });
    } catch (err) {
      console.error('Forward session error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Create ticket & PR from ad-hoc session ──────────────────────
  router.post('/api/sessions/:sessionId/create-pr', async (req: Request, res: Response) => {
    // `autoMerge` is a per-PR override (from ChangesReadyBox). When omitted,
    // the project's `githubWorkflow.autoMerge` setting is used. When it's an
    // explicit boolean — including `false` — that wins over the project
    // default. GitHub's native auto-merge (`gh pr merge --auto --squash`) is
    // what actually performs the merge once branch-protection checks pass.
    const { title, autoMerge } = req.body || {};
    const sessionId = req.params.sessionId as string;

    try {
      const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const agentLookup = findAgent(session.agent_id);
      if (!agentLookup) return res.status(404).json({ error: 'Agent not found' });

      const { project, agent } = agentLookup;

      if (getProjectMode(project) === 'workflow') {
        return res.status(403).json({
          error: 'Session PR creation is disabled while this project is in workflow mode',
        });
      }

      if (!session.worktree_path) {
        return res.status(400).json({ error: 'Session has no worktree — nothing to commit' });
      }

      const result = await manualCommitAndPR(
        sessionId,
        session.agent_id,
        project,
        agent,
        session.worktree_path,
        {
          title: title || undefined,
          autoMerge: typeof autoMerge === 'boolean' ? autoMerge : undefined,
        },
      );

      if (!result.ok) {
        return res.status(422).json({ error: result.error, code: result.code });
      }

      stmts.clearSessionChangesReady.run(sessionId);
      res.json({ prUrl: result.prUrl, cardId: result.cardId });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      const stack = (err as Error).stack || '';
      console.error(`[create-pr] Error for session ${sessionId}:`, msg);
      console.error(`[create-pr] Stack:`, stack);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
