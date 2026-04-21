import { v4 as uuidv4 } from 'uuid';
import { spawn, ChildProcess } from 'child_process';
import { Router, Request, Response } from 'express';
import { defaultModelForEngine, buildSpawnEnv } from '../config.js';
import { removeWorkspace } from '../worktree.js';
import { manualCommitAndPR } from '../auto-git.js';
import type {
  RouteDeps,
  AppConfig,
  MessageRow,
  SessionRow,
  BackgroundTaskRow,
  ActiveTaskRow,
  SessionEventRow,
  SessionProgressRow,
  CheckpointRow,
  AgentLookup,
  EnrichedAgent,
} from '../types.js';

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { type: 'unknown', text: s };
  }
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

export function summarizeTranscript(
  transcript: string,
  { engine, model, cwd }: { engine: string; model?: string; cwd?: string },
  config: AppConfig,
): Promise<string> {
  const CLAUDE_BIN = config.claudeBin;
  const CURSOR_BIN = config.cursorBin;
  const DEFAULT_MODEL = config.defaultModel;

  const systemPrompt = [
    'You are a concise summarizer. You will receive a conversation transcript.',
    'Produce a clear, well-structured summary that captures:',
    '- Key decisions made',
    '- Action items and outcomes',
    '- Important context and technical details',
    '- Any unresolved questions',
    'Use markdown formatting. Be thorough but concise — aim for ~20-30% of the original length.',
    'Do NOT add commentary — just the summary.',
  ].join(' ');

  const userPrompt = `Summarize this conversation:\n\n${transcript}`;

  return new Promise((resolve, reject) => {
    const GEMINI_BIN = config.geminiBin;
    // Engine→bin + args mapping. Each CLI has its own flag conventions, so we
    // branch rather than force a common shape.
    let bin: string;
    let args: string[];
    if (engine === 'cursor-agent') {
      bin = CURSOR_BIN;
      args = [
        '--print',
        '--model',
        model || DEFAULT_MODEL,
        '--system-prompt',
        systemPrompt,
        userPrompt,
      ];
    } else if (engine === 'gemini-cli') {
      // Gemini CLI doesn't have a --system-prompt flag — concatenate into
      // the prompt body like we do in slack.ts runAgent().
      bin = GEMINI_BIN;
      const combined = `${systemPrompt}\n\n${userPrompt}`;
      args = ['-p', combined];
      if (model && model !== 'auto') {
        args.push('--model', model);
      }
    } else {
      bin = CLAUDE_BIN;
      args = [
        '--print',
        '--model',
        model || DEFAULT_MODEL,
        '--system-prompt',
        systemPrompt,
        userPrompt,
      ];
    }

    let output = '';
    let errorOutput = '';
    const timeout = config.defaultTimeoutMs;

    const proc = spawn(bin, args, {
      cwd: cwd || process.env.HOME,
      env: buildSpawnEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
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

  const router = Router();

  router.get('/api/agents/:agentId/sessions', (req: Request, res: Response) => {
    const sessions = stmts.getSessions.all(req.params.agentId) as SessionRow[];
    res.json(sessions);
  });

  router.post('/api/agents/:agentId/sessions', (req: Request, res: Response) => {
    const id = uuidv4();
    const name = req.body.name || `Session ${new Date().toLocaleString()}`;
    const found = findAgent(req.params.agentId as string);
    const engine = req.body.engine || found?.agent?.engine || 'claude-code';
    const model = req.body.model || found?.agent?.model || defaultModelForEngine(engine);
    const useWorktree = req.body.use_worktree !== undefined ? (req.body.use_worktree ? 1 : 0) : 1;
    const askMode = req.body.ask_mode ? 1 : 0;
    stmts.createSession.run(id, req.params.agentId, name, engine, model, useWorktree, askMode);
    const session = stmts.getSession.get(id) as SessionRow;
    res.json(session);
  });

  router.get('/api/sessions/cron', (_req: Request, res: Response) => {
    const sessions = stmts.getAllCronSessions.all() as SessionRow[];
    res.json(sessions);
  });

  router.get('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
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
    stmts.createSession.run(sessionId, agentId, sessionName, engine, model, 1, 0);

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

  router.get('/api/tasks', (_req: Request, res: Response) => {
    const limit = parseInt(_req.query.limit as string) || 50;
    const tasks = stmts.getBackgroundTasks.all(limit) as BackgroundTaskRow[];

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

  router.get('/api/messages/:messageId/events', (req: Request, res: Response) => {
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
    const sessions = stmts.getAllSessionsByAgent.all(req.params.agentId) as SessionRow[];
    let deleted = 0;
    for (const session of sessions) {
      const proc = activeProcesses.get(session.id);
      if (proc) {
        proc.kill('SIGTERM');
        activeProcesses.delete(session.id);
      }
      if (session.worktree_path) {
        removeWorkspace(session.worktree_path);
      }
      stmts.deleteSession.run(session.id);
      deleted++;
    }
    res.json({ ok: true, deleted });
  });

  router.delete('/api/agents/:agentId/sessions/inactive', (req: Request, res: Response) => {
    const sessions = stmts.getAllSessionsByAgent.all(req.params.agentId) as SessionRow[];
    let deleted = 0;
    for (const session of sessions) {
      if (activeProcesses.has(session.id)) continue;
      if (session.worktree_path) {
        removeWorkspace(session.worktree_path);
      }
      stmts.deleteSession.run(session.id);
      deleted++;
    }
    res.json({ ok: true, deleted });
  });

  // Single-session DELETE is a *soft* delete (archive). The row is marked with
  // `deleted_at` so it disappears from the live sidebar but stays recoverable
  // via POST /api/sessions/:sessionId/restore for 7 days. We deliberately
  // leave the worktree on disk so a restore can reattach the same checkout —
  // bulk `DELETE /api/agents/:agentId/sessions[/inactive]` and the 7-day purge
  // are what actually reclaim worktree space.
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

    stmts.softDeleteSession.run(sessionId);

    // Broadcast `session_deleted` for cross-tab sync — the client treats
    // archive identically to a hard delete on the live list.
    try {
      broadcast({ type: 'session_deleted', sessionId });
    } catch {
      /* best-effort */
    }

    res.json({ ok: true, archived: true });
  });

  // Archived (soft-deleted) sessions for a given agent within the 7-day
  // recovery window, newest first. Powers the sidebar "Archived" section.
  router.get('/api/agents/:agentId/archived-sessions', (req: Request, res: Response) => {
    const rows = stmts.getArchivedSessionsByAgent.all(req.params.agentId) as SessionRow[];
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
      broadcast({ type: 'session_restored', sessionId, session: restored });
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
    if (!engine || !['claude-code', 'cursor-agent', 'gemini-cli'].includes(engine)) {
      return res
        .status(400)
        .json({ error: 'Invalid engine. Must be claude-code, cursor-agent, or gemini-cli' });
    }
    stmts.updateSessionEngine.run(engine, req.params.sessionId);
    stmts.updateSessionEngineSessionId.run(null, req.params.sessionId);
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

  router.get('/api/delegations/:messageId', (req: Request, res: Response) => {
    try {
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

  router.get('/api/sessions/:sessionId/queue', (req: Request, res: Response) => {
    try {
      const queue = stmts.getQueuedMessages.all(req.params.sessionId);
      res.json(queue);
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
      );

      res.json({ summary });
    } catch (err) {
      console.error('Summarize session error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/active-tasks', (_req: Request, res: Response) => {
    try {
      res.json(
        (stmts.getAllActiveTasks.all() as ActiveTaskRow[]).map((t) => ({
          sessionId: t.session_id,
          messageId: t.message_id,
          agentId: t.agent_id,
          engine: t.engine,
          model: t.model,
          prompt: t.prompt,
          content: t.streamed_output || '',
          startedAt: t.started_at,
        })),
      );
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

      const proc = spawn(claudeBin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        console.error(`[rewind] Process timed out after ${REWIND_TIMEOUT_MS}ms — killing`);
        proc.kill();
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
        broadcast({
          type: 'rewind-complete',
          sessionId: req.params.sessionId,
          uuid,
          success: code === 0,
        });
      });

      proc.on('error', (err: Error) => {
        clearTimeout(killTimer);
        console.error(`[rewind] Failed to spawn claude:`, err.message);
        broadcast({
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
      stmts.createSession.run(newSessionId, targetAgentId, truncatedName, engine, model, 1, 0);

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
      broadcast({
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
      if (!session.worktree_path) {
        return res.status(400).json({ error: 'Session has no worktree — nothing to commit' });
      }

      const agentLookup = findAgent(session.agent_id);
      if (!agentLookup) return res.status(404).json({ error: 'Agent not found' });

      const { project, agent } = agentLookup;

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

      if (!result) {
        return res.status(422).json({ error: 'No changes to commit or PR creation failed' });
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
