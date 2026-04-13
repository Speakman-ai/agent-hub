/**
 * Delegation Engine
 *
 * Handles lead-agent → sub-agent delegation: parsing <delegate> blocks,
 * spawning sub-agent CLI processes in parallel, streaming their output,
 * and re-invoking the lead for synthesis.
 */

import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

// ─── Module-level state ──────────────────────────────────────────────
let deps = null;

/** Sessions that currently have an in-progress delegation round. */
export const activeDelegationSessions = new Set();

/** Active delegation sub-agent processes (keyed by `${sessionId}:${delegationId}`). */
const activeDelegations = new Map();

// ─── Initialisation ──────────────────────────────────────────────────

/**
 * Call once at startup to inject shared dependencies.
 *
 * @param {object} d
 * @param {object} d.stmts             - Prepared SQLite statements
 * @param {Function} d.broadcast        - WebSocket broadcast helper
 * @param {Function} d.getEnrichedAgent - Resolve agent by ID (enriched with project data)
 * @param {Function} d.buildEnrichedPrompt - Build the full system prompt for an agent
 * @param {Function} d.saveErrorMessage - Persist an error message to the DB + broadcast
 * @param {Function} d.appendDailyNote  - Append to the project's daily memory note
 * @param {Function} d.getActiveProcesses - Returns Map of sessionId → active CLI process
 * @param {Function} d.getClaudeBin     - Returns the current CLAUDE_BIN path
 * @param {Function} d.getDefaultModel  - Returns the current DEFAULT_MODEL string
 * @param {Function} d.getConfig        - Returns the server config object
 */
export function initDelegation(d) {
  deps = d;
}

// ─── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse <delegate> blocks from assistant response text.
 * Returns array of { agentId, task } or null if none found.
 */
export function parseDelegateBlock(text) {
  const match = text.match(/<delegate>\s*([\s\S]*?)\s*<\/delegate>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter(
      (t) => t && typeof t.agentId === 'string' && typeof t.task === 'string',
    );
    return valid.length > 0 ? valid : null;
  } catch {
    console.error('[Delegation] Failed to parse delegate block JSON');
    return null;
  }
}

// ─── Cancellation ────────────────────────────────────────────────────

/**
 * Cancel all active delegation processes for a session.
 */
export function handleDelegationCancel(sessionId) {
  const { stmts, broadcast } = deps;
  for (const [compositeKey, state] of activeDelegations) {
    if (compositeKey.startsWith(sessionId + ':')) {
      state.cancelled = true;
      if (state.proc) state.proc.kill('SIGTERM');
      try {
        stmts.updateDelegation.run(
          'cancelled',
          null,
          'Cancelled by user',
          compositeKey.split(':')[1],
        );
      } catch {}
    }
  }
  broadcast({ type: 'delegation_cancelled', sessionId });
}

// ─── Sub-agent spawning ──────────────────────────────────────────────

/**
 * Spawn sub-agents in parallel to handle delegated tasks.
 * Returns array of { agentId, agentName, output, error }.
 */
export async function handleDelegation(
  sessionId,
  parentMessageId,
  delegateTasks,
  leadAgent,
  project,
  leadCwd,
) {
  const {
    stmts,
    broadcast,
    getEnrichedAgent,
    buildEnrichedPrompt,
    getClaudeBin,
    getDefaultModel,
    getConfig,
  } = deps;

  const CLAUDE_BIN = getClaudeBin();
  const DEFAULT_MODEL = getDefaultModel();
  const config = getConfig();

  // Validate all sub-agent IDs
  const validTasks = delegateTasks.filter((t) => {
    if (!leadAgent.subAgents || !leadAgent.subAgents.includes(t.agentId)) {
      console.warn(`[Delegation] Agent ${t.agentId} is not a sub-agent of ${leadAgent.id}`);
      return false;
    }
    return getEnrichedAgent(t.agentId) != null;
  });

  if (validTasks.length === 0) {
    broadcast({
      type: 'delegation_error',
      sessionId,
      error: 'No valid sub-agents found for delegation',
    });
    return [];
  }

  broadcast({
    type: 'delegation_start',
    sessionId,
    parentMessageId,
    tasks: validTasks.map((t) => ({ agentId: t.agentId, task: t.task })),
  });

  // Spawn all sub-agents in parallel
  const results = await Promise.all(
    validTasks.map(async (task) => {
      const subAgent = getEnrichedAgent(task.agentId);
      const delegationId = uuidv4();

      // Create DB row
      try {
        stmts.createDelegation.run(
          delegationId,
          sessionId,
          parentMessageId,
          task.agentId,
          subAgent.name,
          task.task,
        );
      } catch (err) {
        console.error('[Delegation] DB insert failed:', err.message);
      }

      // Update status to running
      try {
        stmts.updateDelegation.run('running', null, null, delegationId);
      } catch {}

      broadcast({
        type: 'delegation_thinking',
        sessionId,
        delegationId,
        agentId: subAgent.id,
        agentName: subAgent.name,
        agentColor: subAgent.color,
      });

      const delegationState = { proc: null, cancelled: false };
      activeDelegations.set(`${sessionId}:${delegationId}`, delegationState);

      try {
        const output = await new Promise((resolve, reject) => {
          const subPrompt = buildEnrichedPrompt(subAgent, null, { useWorktree: true });
          const args = [
            '--print',
            '--permission-mode',
            'bypassPermissions',
            '--model',
            DEFAULT_MODEL,
            '--system-prompt',
            subPrompt,
            task.task,
          ];

          let stdout = '';
          let stderr = '';
          const timeout = config.conferenceTimeoutMs || 600000;

          const proc = spawn(CLAUDE_BIN, args, {
            cwd: leadCwd || subAgent.cwd || project.cwd || process.env.HOME,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          delegationState.proc = proc;

          const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
          }, timeout);

          proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            broadcast({
              type: 'delegation_stream',
              sessionId,
              delegationId,
              agentId: subAgent.id,
              agentName: subAgent.name,
              agentColor: subAgent.color,
              content: stdout,
            });
          });

          proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });

          proc.on('close', (code) => {
            clearTimeout(timer);
            delegationState.proc = null;
            if (delegationState.cancelled) {
              reject(new Error('Cancelled'));
              return;
            }
            if (code !== 0 && !stdout) {
              reject(new Error(stderr || `Exited with code ${code}`));
            } else {
              resolve(stdout.trim() || stderr.trim() || '(empty response)');
            }
          });

          proc.on('error', (err) => {
            clearTimeout(timer);
            delegationState.proc = null;
            reject(err);
          });
        });

        // Success
        try {
          stmts.updateDelegation.run('done', output, null, delegationId);
        } catch {}
        activeDelegations.delete(`${sessionId}:${delegationId}`);

        broadcast({
          type: 'delegation_agent_done',
          sessionId,
          delegationId,
          agentId: subAgent.id,
          agentName: subAgent.name,
          output,
        });

        return { agentId: subAgent.id, agentName: subAgent.name, output, error: null };
      } catch (err) {
        // Error
        try {
          stmts.updateDelegation.run('error', null, err.message, delegationId);
        } catch {}
        activeDelegations.delete(`${sessionId}:${delegationId}`);

        broadcast({
          type: 'delegation_agent_error',
          sessionId,
          delegationId,
          agentId: subAgent.id,
          agentName: subAgent.name,
          error: err.message,
        });

        return { agentId: subAgent.id, agentName: subAgent.name, output: null, error: err.message };
      }
    }),
  );

  broadcast({ type: 'delegation_round_done', sessionId, parentMessageId });
  return results;
}

// ─── Synthesis ───────────────────────────────────────────────────────

/**
 * Re-invoke the lead agent with delegation results for synthesis.
 */
export async function synthesizeResults(
  sessionId,
  agentId,
  enrichedAgent,
  project,
  results,
  originalUserMessage,
  leadCwd,
) {
  const {
    stmts,
    broadcast,
    saveErrorMessage,
    appendDailyNote,
    getActiveProcesses,
    getClaudeBin,
    getDefaultModel,
    getConfig,
  } = deps;

  const activeProcesses = getActiveProcesses();

  const CLAUDE_BIN = getClaudeBin();
  const DEFAULT_MODEL = getDefaultModel();
  const config = getConfig();

  const assistantMsgId = uuidv4();
  const engine = 'claude-code';
  const model = DEFAULT_MODEL;

  // Build synthesis prompt with all results
  const resultsSummary = results
    .map((r) => {
      const header = `## ${r.agentName} (${r.agentId})`;
      if (r.error) return `${header}\n⚠️ Error: ${r.error}`;
      return `${header}\n${r.output}`;
    })
    .join('\n\n');

  const synthesisPrompt = `Your team completed the delegated tasks. Here are their results:\n\n${resultsSummary}\n\nSynthesize these results for the user. The original request was:\n${originalUserMessage}\n\nProvide a clear, unified summary of what was accomplished, any issues encountered, and next steps if applicable.`;

  // Broadcast thinking
  broadcast({
    type: 'thinking',
    messageId: assistantMsgId,
    sessionId,
    engine,
    model,
  });

  try {
    // Resume the lead's existing session so delegation results become part of
    // the conversation history. This way follow-up messages have full context
    // of what the sub-agents did and the lead's synthesis.
    const sess = stmts.getSession.get(sessionId);
    const engineSessionId = sess?.engine_session_id || sessionId;
    const args = [
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      model,
      '--resume',
      engineSessionId,
      synthesisPrompt,
    ];

    const timeout = config.conferenceTimeoutMs || 600000;
    let finalOutput = '';

    // Mark session as busy during synthesis to prevent race conditions
    const synthMarker = { kill: () => {} };
    activeProcesses.set(sessionId, synthMarker);

    await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn(CLAUDE_BIN, args, {
        cwd: leadCwd || project.cwd || process.env.HOME,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Update marker so cancel can kill the real process
      activeProcesses.set(sessionId, proc);

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Synthesis timed out after ${Math.round(timeout / 60000)} minutes`));
      }, timeout);

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        broadcast({
          type: 'stream',
          messageId: assistantMsgId,
          sessionId,
          chunk: chunk.toString(),
          content: stdout,
          engine,
          model,
        });
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout) {
          reject(new Error(stderr || `Synthesis exited with code ${code}`));
        } else {
          finalOutput = stdout.trim() || stderr.trim() || '(empty synthesis)';
          resolve();
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Clear busy marker
    activeProcesses.delete(sessionId);

    // Save synthesis message
    stmts.addMessage.run(assistantMsgId, sessionId, 'assistant', finalOutput, engine, model, null);
    stmts.touchSession.run(sessionId);

    broadcast({
      type: 'done',
      messageId: assistantMsgId,
      sessionId,
      message: {
        id: assistantMsgId,
        session_id: sessionId,
        role: 'assistant',
        content: finalOutput,
        engine,
        model,
        created_at: new Date().toISOString(),
      },
    });

    // Append to daily notes
    if (project.ahw) {
      appendDailyNote(
        project.ahw,
        `**Delegation Synthesis** (${enrichedAgent.name}):\n${finalOutput.substring(0, 300)}${finalOutput.length > 300 ? '...' : ''}`,
      );
    }
  } catch (err) {
    activeProcesses.delete(sessionId);
    console.error('[Delegation] Synthesis failed:', err.message);
    const errText = `Delegation synthesis failed: ${err.message}`;
    saveErrorMessage(sessionId, assistantMsgId, engine, model, errText);
    broadcast({
      type: 'error',
      messageId: assistantMsgId,
      sessionId,
      error: errText,
    });
  }
}
