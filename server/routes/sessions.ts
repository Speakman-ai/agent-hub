import { v4 as uuidv4 } from 'uuid';
import { spawn, ChildProcess } from 'child_process';
import { Router, Request, Response } from 'express';
import { defaultModelForEngine, buildSpawnEnv } from '../config.js';
import { removeWorkspace } from '../worktree.js';
import type {
  RouteDeps,
  AppConfig,
  MessageRow,
  SessionRow,
  BackgroundTaskRow,
  ActiveTaskRow,
  SessionEventRow,
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
    const bin = engine === 'cursor-agent' ? CURSOR_BIN : CLAUDE_BIN;
    const args = [
      '--print',
      '--model',
      model || DEFAULT_MODEL,
      '--system-prompt',
      systemPrompt,
      userPrompt,
    ];

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
    const sessions = stmts.getSessions.all(req.params.agentId) as SessionRow[];
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
    const sessions = stmts.getSessions.all(req.params.agentId) as SessionRow[];
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

  router.delete('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const session = stmts.getSession.get(req.params.sessionId) as SessionRow | undefined;
    if (session?.worktree_path) {
      removeWorkspace(session.worktree_path);
    }
    stmts.deleteSession.run(req.params.sessionId);
    res.json({ ok: true });
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
    if (!engine || !['claude-code', 'cursor-agent'].includes(engine)) {
      return res.status(400).json({ error: 'Invalid engine. Must be claude-code or cursor-agent' });
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

  return router;
}
