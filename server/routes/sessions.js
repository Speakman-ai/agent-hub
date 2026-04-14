import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { Router } from 'express';
import { defaultModelForEngine } from '../config.js';
import { removeWorkspace } from '../worktree.js';

// ─── Helpers ────────────────────────────────────────────────────────

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { type: 'unknown', text: s };
  }
}

/**
 * Build a plain-text transcript from message rows.
 */
export function buildTranscript(messages, { agentName, isRoom }) {
  return messages
    .map((m) => {
      const label =
        m.role === 'user' ? 'User' : isRoom ? m.agent_name || 'Agent' : agentName || 'Assistant';
      return `[${label}]:\n${m.content}`;
    })
    .join('\n\n');
}

/**
 * Spawn the CLI in --print mode to summarize a conversation transcript.
 * Returns the summary string.
 *
 * @param {string} transcript  Plain-text conversation
 * @param {{ engine: string, model?: string, cwd?: string }} opts
 * @param {{ claudeBin: string, cursorBin: string, defaultModel: string, defaultTimeoutMs: number }} config
 */
export function summarizeTranscript(transcript, { engine, model, cwd }, config) {
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
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Summary timed out after ${Math.round(timeout / 60000)} minutes`));
    }, timeout);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || output.trim()) {
        resolve(output.trim());
      } else {
        reject(new Error(errorOutput || `Process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── Route factory ──────────────────────────────────────────────────

export default function createSessionRoutes(deps) {
  const { stmts, findAgent, getEnrichedAgent, handleChat, config, activeProcesses } = deps;

  const router = Router();

  // ─── Agent session listing & creation ─────────────────────────────

  router.get('/api/agents/:agentId/sessions', (req, res) => {
    const sessions = stmts.getSessions.all(req.params.agentId);
    res.json(sessions);
  });

  router.post('/api/agents/:agentId/sessions', (req, res) => {
    const id = uuidv4();
    const name = req.body.name || `Session ${new Date().toLocaleString()}`;
    const found = findAgent(req.params.agentId);
    const engine = req.body.engine || found?.agent?.engine || 'claude-code';
    const model = req.body.model || found?.agent?.model || defaultModelForEngine(engine);
    const useWorktree = req.body.use_worktree !== undefined ? (req.body.use_worktree ? 1 : 0) : 1;
    const askMode = req.body.ask_mode ? 1 : 0;
    stmts.createSession.run(id, req.params.agentId, name, engine, model, useWorktree, askMode);
    const session = stmts.getSession.get(id);
    res.json(session);
  });

  // ─── Cron-linked sessions ─────────────────────────────────────────

  router.get('/api/sessions/cron', (_req, res) => {
    const sessions = stmts.getAllCronSessions.all();
    res.json(sessions);
  });

  // ─── Session messages ─────────────────────────────────────────────

  router.get('/api/sessions/:sessionId/messages', (req, res) => {
    const messages = stmts.getMessages.all(req.params.sessionId);
    res.json(messages);
  });

  // ─── Background Tasks ─────────────────────────────────────────────
  // Fire-and-forget: send a prompt to an agent, close your browser, check back later.

  router.post('/api/tasks', (req, res) => {
    const { agentId, prompt } = req.body;
    if (!agentId || !prompt) {
      return res.status(400).json({ error: 'agentId and prompt are required' });
    }

    const found = findAgent(agentId);
    if (!found) return res.status(404).json({ error: `Unknown agent: ${agentId}` });

    const taskId = uuidv4();
    const sessionId = uuidv4();

    // Create a session for this background task
    const engine = found.agent.engine || 'claude-code';
    const model = found.agent.model || defaultModelForEngine(engine);
    const sessionName = `[BG] ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`;
    stmts.createSession.run(sessionId, agentId, sessionName, engine, model, 1, 0);

    // Track the background task
    stmts.insertBackgroundTask.run(taskId, sessionId, agentId, prompt);

    // Fire handleChat with ws=null — everything goes to DB + broadcast
    handleChat(null, {
      agentId,
      sessionId,
      content: prompt,
    });

    const session = stmts.getSession.get(sessionId);
    res.status(201).json({ taskId, sessionId, session });
  });

  router.get('/api/tasks', (_req, res) => {
    const limit = parseInt(_req.query.limit) || 50;
    const tasks = stmts.getBackgroundTasks.all(limit);

    // Enrich with agent info
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

  router.get('/api/tasks/:taskId', (req, res) => {
    const task = stmts.getBackgroundTask.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const agent = getEnrichedAgent(task.agent_id);
    const messages = stmts.getMessages.all(task.session_id);
    res.json({
      ...task,
      agentName: agent?.name || task.agent_id,
      agentColor: agent?.color || '#6b7280',
      messages,
    });
  });

  router.post('/api/tasks/:taskId/stop', (req, res) => {
    const task = stmts.getBackgroundTask.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'running') return res.status(400).json({ error: 'Task is not running' });

    // Kill the active process if it exists
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

  // ─── Message events ───────────────────────────────────────────────

  // Fetch the full event timeline for an assistant message (or any parent).
  // Returns events in seq order, each with its normalized payload parsed back
  // into an object so the client doesn't have to.
  //
  // Usage: GET /api/messages/:messageId/events
  //        GET /api/heartbeats/logs/:logId/events  (parentKind=heartbeat — Phase 3)
  //        GET /api/crons/runs/:runId/events       (parentKind=cron — Phase 3)
  router.get('/api/messages/:messageId/events', (req, res) => {
    const rows = stmts.getSessionEvents.all('message', req.params.messageId);
    const events = rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      timestamp: r.timestamp,
      event_type: r.event_type,
      event: safeParse(r.payload),
    }));
    res.json(events);
  });

  // ─── Bulk session cleanup ─────────────────────────────────────────

  router.delete('/api/agents/:agentId/sessions', (req, res) => {
    const sessions = stmts.getSessions.all(req.params.agentId);
    let deleted = 0;
    for (const session of sessions) {
      // Kill active process if running
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

  router.delete('/api/agents/:agentId/sessions/inactive', (req, res) => {
    const sessions = stmts.getSessions.all(req.params.agentId);
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

  // ─── Session CRUD ─────────────────────────────────────────────────

  router.delete('/api/sessions/:sessionId', (req, res) => {
    const session = stmts.getSession.get(req.params.sessionId);
    // Clean up workspace clone if one was created
    if (session?.worktree_path) {
      removeWorkspace(session.worktree_path);
    }
    stmts.deleteSession.run(req.params.sessionId);
    res.json({ ok: true });
  });

  router.patch('/api/sessions/:sessionId', (req, res) => {
    if (req.body.name) {
      stmts.updateSessionName.run(req.body.name, req.params.sessionId);
    }
    const session = stmts.getSession.get(req.params.sessionId);
    res.json(session);
  });

  router.put('/api/sessions/:sessionId/engine', (req, res) => {
    const { engine } = req.body;
    if (!engine || !['claude-code', 'cursor-agent'].includes(engine)) {
      return res.status(400).json({ error: 'Invalid engine. Must be claude-code or cursor-agent' });
    }
    stmts.updateSessionEngine.run(engine, req.params.sessionId);
    // Clear stale engine_session_id so the new engine starts a fresh conversation
    // instead of trying to --resume a session ID that belongs to the old engine
    stmts.updateSessionEngineSessionId.run(null, req.params.sessionId);
    const session = stmts.getSession.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  router.put('/api/sessions/:sessionId/model', (req, res) => {
    const { model } = req.body;
    const ALL_VALID_MODELS = config.allValidModels;
    const ENGINE_VALID_MODELS = config.engineValidModels;
    if (!model || !ALL_VALID_MODELS.includes(model)) {
      return res
        .status(400)
        .json({ error: `Invalid model. Must be one of: ${ALL_VALID_MODELS.join(', ')}` });
    }
    // Validate model matches the session's engine
    const session = stmts.getSession.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const engine = session.engine || 'claude-code';
    const allowed = ENGINE_VALID_MODELS[engine] || ENGINE_VALID_MODELS['claude-code'];
    if (!allowed.includes(model)) {
      return res.status(400).json({
        error: `Model "${model}" is not valid for engine "${engine}". Allowed: ${allowed.join(', ')}`,
      });
    }
    stmts.updateSessionModel.run(model, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId);
    res.json(updated);
  });

  router.put('/api/sessions/:sessionId/worktree', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const session = stmts.getSession.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.updateSessionWorktree.run(enabled ? 1 : 0, req.params.sessionId);
    // Claude Code 2.1.94+ supports --resume across worktrees, so we preserve
    // engine_session_id for session continuity when toggling worktree mode.
    // The CLI will resume the conversation context even though the cwd changed.
    const updated = stmts.getSession.get(req.params.sessionId);
    res.json(updated);
  });

  router.put('/api/sessions/:sessionId/ask-mode', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const session = stmts.getSession.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.updateSessionAskMode.run(enabled ? 1 : 0, req.params.sessionId);
    const updated = stmts.getSession.get(req.params.sessionId);
    res.json(updated);
  });

  // ─── Delegation endpoints ────────────────────────────────────────

  router.get('/api/delegations/:messageId', (req, res) => {
    try {
      const delegations = stmts.getDelegations.all(req.params.messageId);
      res.json(delegations);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/sessions/:sessionId/delegations', (req, res) => {
    try {
      const delegations = stmts.getDelegationsBySession.all(req.params.sessionId);
      res.json(delegations);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/sessions/:sessionId/queue', (req, res) => {
    try {
      const queue = stmts.getQueuedMessages.all(req.params.sessionId);
      res.json(queue);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Session summarize ────────────────────────────────────────────

  router.post('/api/sessions/:sessionId/summarize', async (req, res) => {
    try {
      const session = stmts.getSession.get(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const messages = stmts.getMessages.all(req.params.sessionId);
      if (!messages.length) return res.status(400).json({ error: 'No messages to summarize' });

      const found = findAgent(session.agent_id);
      const agent = found?.agent;
      const transcript = buildTranscript(messages, { agentName: agent?.name });

      const summary = await summarizeTranscript(
        transcript,
        {
          engine: session.engine || agent?.engine || 'claude-code',
          model: session.model,
          cwd: agent?.cwd,
        },
        config,
      );

      res.json({ summary });
    } catch (err) {
      console.error('Summarize session error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Active tasks ─────────────────────────────────────────────────

  router.get('/api/active-tasks', (_req, res) => {
    try {
      res.json(
        stmts.getAllActiveTasks.all().map((t) => ({
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
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
