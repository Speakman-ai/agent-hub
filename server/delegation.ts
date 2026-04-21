import { spawn, type ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { buildSpawnEnv } from './config.js';
import type { EnrichedAgent, Project, Stmts, BroadcastFn, AppConfig, SessionRow } from './types.js';
import {
  activeDelegationSessions,
  delegationSessionUiMeta,
  clearDelegationUiMeta,
} from './delegation-state.js';
import { broadcastActiveTasksSnapshot } from './active-tasks.js';

interface DelegationDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  buildEnrichedPrompt: (
    agent: EnrichedAgent,
    sessionId: string | null,
    opts?: { useWorktree?: boolean },
  ) => string;
  saveErrorMessage: (
    sessionId: string,
    messageId: string,
    engine: string,
    model: string,
    errorText: string,
  ) => void;
  appendDailyNote: (workspace: string, content: string) => void;
  getActiveProcesses: () => Map<string, ChildProcess | { kill: () => void }>;
  getClaudeBin: () => string;
  getDefaultModel: () => string;
  getConfig: () => AppConfig;
}

/**
 * Config knobs for the per-task retry loop. Both are optional on {@link AppConfig}
 * — sensible defaults are applied when unset. See {@link DEFAULT_MAX_ATTEMPTS}
 * and {@link DEFAULT_RETRY_BACKOFF_MS}.
 */
type DelegationRetryConfig = AppConfig & {
  delegationMaxAttempts?: number;
  delegationRetryBackoffMs?: number;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1000;

interface DelegateTask {
  agentId: string;
  task: string;
}

interface DelegationState {
  proc: ChildProcess | null;
  cancelled: boolean;
}

export interface DelegationResult {
  agentId: string;
  agentName: string;
  /** Sub-agent instruction from the `<delegate>` block (needed for lead takeover after cancel). */
  task: string;
  output: string | null;
  error: string | null;
}

let deps: DelegationDeps | null = null;

/** @see delegation-state.ts — re-exported for chat/index callers */
export { activeDelegationSessions } from './delegation-state.js';

const activeDelegations = new Map<string, DelegationState>();

export function initDelegation(d: DelegationDeps): void {
  deps = d;
}

export function parseDelegateBlock(text: string): DelegateTask[] | null {
  const match = text.match(/<delegate>\s*([\s\S]*?)\s*<\/delegate>/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return null;
    const valid = (parsed as Array<Record<string, unknown>>).filter(
      (t) => t && typeof t.agentId === 'string' && typeof t.task === 'string',
    ) as unknown as DelegateTask[];
    return valid.length > 0 ? valid : null;
  } catch {
    console.error('[Delegation] Failed to parse delegate block JSON');
    return null;
  }
}

export function handleDelegationCancel(sessionId: string): void {
  const { stmts, broadcast } = deps!;
  const keyPrefix = `${sessionId}:`;
  for (const [compositeKey, state] of activeDelegations) {
    if (!compositeKey.startsWith(keyPrefix)) continue;
    const delegationId = compositeKey.slice(keyPrefix.length);
    state.cancelled = true;
    if (state.proc) state.proc.kill('SIGTERM');
    try {
      stmts.updateDelegation.run('cancelled', null, 'Cancelled by user', delegationId);
    } catch {}
  }
  activeDelegationSessions.delete(sessionId);
  clearDelegationUiMeta(sessionId);
  broadcast({ type: 'delegation_cancelled', sessionId });
  broadcastActiveTasksSnapshot(stmts, broadcast);
}

export async function handleDelegation(
  sessionId: string,
  parentMessageId: string,
  delegateTasks: DelegateTask[],
  leadAgent: EnrichedAgent,
  project: Project,
  leadCwd: string,
): Promise<DelegationResult[]> {
  const {
    stmts,
    broadcast,
    getEnrichedAgent,
    buildEnrichedPrompt,
    appendDailyNote,
    getClaudeBin,
    getDefaultModel,
    getConfig,
  } = deps!;

  const CLAUDE_BIN = getClaudeBin();
  const DEFAULT_MODEL = getDefaultModel();
  const cfg = getConfig() as DelegationRetryConfig;

  const maxAttempts = Math.max(1, cfg.delegationMaxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryBackoffMs = Math.max(0, cfg.delegationRetryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);

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

  delegationSessionUiMeta.set(sessionId, {
    parentMessageId,
    startedAt: new Date().toISOString(),
  });
  broadcast({
    type: 'delegation_start',
    sessionId,
    parentMessageId,
    tasks: validTasks.map((t) => ({ agentId: t.agentId, task: t.task })),
  });
  broadcastActiveTasksSnapshot(stmts, broadcast);

  const results = await Promise.all(
    validTasks.map(async (task): Promise<DelegationResult> => {
      const subAgent = getEnrichedAgent(task.agentId)!;
      const delegationId = uuidv4();

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
        console.error('[Delegation] DB insert failed:', (err as Error).message);
      }

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

      const delegationState: DelegationState = { proc: null, cancelled: false };
      activeDelegations.set(`${sessionId}:${delegationId}`, delegationState);

      /**
       * Run one dispatch attempt. Resolves with stdout on success; rejects
       * with a descriptive Error on timeout, spawn error, or non-zero exit.
       * Rejects with `Cancelled` when the delegation was cancelled.
       */
      const dispatchOnce = (): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          const subPrompt = buildEnrichedPrompt(subAgent, null, { useWorktree: true });
          const args: string[] = [
            '--print',
            '--permission-mode',
            'bypassPermissions',
            '--model',
            (subAgent.model as string | undefined) || DEFAULT_MODEL,
            '--system-prompt',
            subPrompt,
            task.task,
          ];

          let stdout = '';
          let stderr = '';
          const timeout = cfg.conferenceTimeoutMs || 600000;

          const spawnEnv = buildSpawnEnv(cfg);

          const proc = spawn(CLAUDE_BIN, args, {
            cwd: leadCwd || subAgent.cwd || project.cwd || process.env.HOME || '/',
            env: spawnEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          delegationState.proc = proc;

          const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
          }, timeout);

          proc.stdout?.on('data', (chunk: Buffer) => {
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

          proc.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          proc.on('close', (code: number | null) => {
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

          proc.on('error', (err: Error) => {
            clearTimeout(timer);
            delegationState.proc = null;
            reject(err);
          });
        });

      let output: string | null = null;
      let lastError: string | null = null;
      let attemptsMade = 0;
      const attemptErrors: string[] = [];

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attemptsMade = attempt;
        if (delegationState.cancelled) {
          lastError = 'Cancelled';
          break;
        }
        try {
          output = await dispatchOnce();
          lastError = null;
          break;
        } catch (err) {
          const msg = (err as Error).message;
          lastError = msg;
          attemptErrors.push(`attempt ${attempt}: ${msg}`);

          // Cancellation is terminal — never retry.
          if (msg === 'Cancelled' || delegationState.cancelled) break;

          if (attempt < maxAttempts) {
            console.warn(
              `[Delegation] ${subAgent.name} attempt ${attempt}/${maxAttempts} failed: ${msg} — retrying`,
            );
            broadcast({
              type: 'delegation_agent_retry',
              sessionId,
              delegationId,
              agentId: subAgent.id,
              agentName: subAgent.name,
              attempt,
              maxAttempts,
              error: msg,
            });
            // Linear backoff — 1s, 2s, 3s, … — keeps total wait bounded.
            await new Promise((r) => setTimeout(r, retryBackoffMs * attempt));
          }
        }
      }

      activeDelegations.delete(`${sessionId}:${delegationId}`);

      if (output !== null && lastError === null) {
        try {
          stmts.updateDelegation.run('done', output, null, delegationId);
        } catch {}

        broadcast({
          type: 'delegation_agent_done',
          sessionId,
          delegationId,
          agentId: subAgent.id,
          agentName: subAgent.name,
          output,
        });

        return {
          agentId: subAgent.id,
          agentName: subAgent.name,
          task: task.task,
          output,
          error: null,
        };
      }

      // All attempts exhausted (or cancelled). Build a descriptive error so
      // the synthesis turn can surface it to the lead rather than silently
      // dropping the result.
      const wasCancelled = lastError === 'Cancelled';
      const finalError = wasCancelled
        ? 'Cancelled'
        : `Delegation to ${subAgent.name} failed after ${attemptsMade} attempt${
            attemptsMade === 1 ? '' : 's'
          }: ${lastError ?? 'unknown error'}`;

      try {
        if (wasCancelled) {
          stmts.updateDelegation.run('cancelled', null, 'Cancelled by user', delegationId);
        } else {
          stmts.updateDelegation.run('error', null, finalError, delegationId);
        }
      } catch {}

      // User cancel already surfaced `delegation_cancelled`; broadcasting
      // `delegation_agent_error` here would clobber client UI back to "error".
      if (!wasCancelled) {
        broadcast({
          type: 'delegation_agent_error',
          sessionId,
          delegationId,
          agentId: subAgent.id,
          agentName: subAgent.name,
          error: finalError,
          attempts: attemptsMade,
        });
      }

      // TOOL_ERROR self-report — structured line per AGENTS.md convention.
      if (!wasCancelled && project.ahw) {
        try {
          const actionExcerpt = task.task.replace(/\s+/g, ' ').slice(0, 80);
          const summary = (lastError ?? 'unknown').replace(/\s+/g, ' ').slice(0, 160);
          const line = `TOOL_ERROR | ${new Date().toISOString()} | delegation | ${subAgent.id}:${actionExcerpt} | dispatch_failed | ${summary} (attempts=${attemptsMade})`;
          appendDailyNote(project.ahw, `\`\`\`\n${line}\n\`\`\``);
        } catch (logErr) {
          console.error('[Delegation] Failed to log TOOL_ERROR:', (logErr as Error).message);
        }
      }

      return {
        agentId: subAgent.id,
        agentName: subAgent.name,
        task: task.task,
        output: null,
        error: finalError,
      };
    }),
  );

  broadcast({ type: 'delegation_round_done', sessionId, parentMessageId });
  return results;
}

/**
 * Builds the user-visible synthesis prompt for the lead agent after a
 * delegation round. When any sub-agent was cancelled, the prompt instructs the
 * lead to take over the work instead of only summarizing an empty outcome.
 */
export function buildDelegationSynthesisPrompt(
  results: DelegationResult[],
  originalUserMessage: string,
): string {
  const anyCancelled = results.some((r) => r.error === 'Cancelled');

  const resultsSummary = results
    .map((r) => {
      const header = `## ${r.agentName} (${r.agentId})`;
      const taskBlock = r.task ? `**Delegated task:**\n${r.task}\n\n` : '';
      if (r.error) return `${header}\n${taskBlock}⚠️ Error: ${r.error}`;
      return `${header}\n${taskBlock}${r.output ?? ''}`;
    })
    .join('\n\n');

  if (anyCancelled) {
    const completed = results.filter((r) => r.error == null && r.output != null);
    const cancelled = results.filter((r) => r.error === 'Cancelled');
    const failedOther = results.filter((r) => r.error != null && r.error !== 'Cancelled');

    const completedSection =
      completed.length === 0
        ? ''
        : [
            '### Sub-agents that finished (review output below)',
            'These delegates completed before any cancel. **Incorporate their output** into your answer; do not redo their work unless it is clearly wrong or incomplete.',
            ...completed.map(
              (r) => `- **${r.agentName}** (${r.agentId})${r.task ? ` — ${r.task}` : ''}`,
            ),
            '',
          ].join('\n');

    const cancelledSection =
      cancelled.length === 0
        ? ''
        : [
            '### Cancelled — you must carry out yourself',
            'The user stopped these delegates mid-flight. **Execute these tasks yourself** (same tools as a normal turn), or state clearly what is still blocked.',
            ...cancelled.map(
              (r) => `- **${r.agentName}** (${r.agentId})${r.task ? ` — ${r.task}` : ''}`,
            ),
            '',
          ].join('\n');

    const failedSection =
      failedOther.length === 0
        ? ''
        : [
            '### Failed (not user-cancel)',
            'These delegates exhausted retries or hit another error — see the detailed section below. Decide whether to fix and retry, take over manually, or explain the blocker to the user.',
            ...failedOther.map(
              (r) =>
                `- **${r.agentName}** (${r.agentId})${r.task ? ` — ${r.task}` : ''} — ⚠️ ${r.error}`,
            ),
            '',
          ].join('\n');

    return [
      '## Delegation cancellation — lead must take over',
      "The user cancelled at least one in-flight delegated sub-agent before it finished. **You are the lead agent — you must personally continue and complete the user's request** using your own tools. Treat finished delegates as a handoff of their stdout; treat cancelled ones as work you still owe. Do not treat this as a terminal handoff; do not ask the user to re-run delegation unless they explicitly want that.",
      '',
      completedSection,
      cancelledSection,
      failedSection,
      '### Sub-agent outputs (may be partial or empty)',
      resultsSummary,
      '',
      '### Original user message',
      originalUserMessage,
      '',
      'Write your reply to the user: briefly acknowledge the cancellation when helpful, then **do the remaining work** implied by the delegated tasks and the original message (implementation, investigation, or a substantive completion — not only meta-commentary about what was cancelled).',
    ].join('\n');
  }

  return `Your team completed the delegated tasks. Here are their results:\n\n${resultsSummary}\n\nSynthesize these results for the user. The original request was:\n${originalUserMessage}\n\nProvide a clear, unified summary of what was accomplished, any issues encountered, and next steps if applicable.`;
}

export async function synthesizeResults(
  sessionId: string,
  agentId: string,
  enrichedAgent: EnrichedAgent,
  project: Project,
  results: DelegationResult[],
  originalUserMessage: string,
  leadCwd: string,
): Promise<void> {
  const {
    stmts,
    broadcast,
    saveErrorMessage,
    appendDailyNote,
    getActiveProcesses,
    getClaudeBin,
    getDefaultModel,
    getConfig,
  } = deps!;

  const activeProcesses = getActiveProcesses();

  const CLAUDE_BIN = getClaudeBin();
  const DEFAULT_MODEL = getDefaultModel();
  const cfg = getConfig();

  const assistantMsgId = uuidv4();
  const engine = 'claude-code';
  const model: string = (enrichedAgent?.model as string | undefined) || DEFAULT_MODEL;

  const synthesisPrompt = buildDelegationSynthesisPrompt(results, originalUserMessage);

  broadcast({
    type: 'thinking',
    messageId: assistantMsgId,
    sessionId,
    engine,
    model,
  });

  try {
    const sess = stmts.getSession.get(sessionId) as SessionRow | undefined;
    const engineSessionId = sess?.engine_session_id || sessionId;
    const args: string[] = [
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      model,
      '--resume',
      engineSessionId,
      synthesisPrompt,
    ];

    const timeout = cfg.conferenceTimeoutMs || 600000;
    let finalOutput = '';

    const synthMarker: { kill: () => void } = { kill: () => {} };
    activeProcesses.set(sessionId, synthMarker as unknown as ChildProcess);

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const synthEnv = buildSpawnEnv(cfg);

      const proc = spawn(CLAUDE_BIN, args, {
        cwd: leadCwd || project.cwd || process.env.HOME || '/',
        env: synthEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      activeProcesses.set(sessionId, proc);

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Synthesis timed out after ${Math.round(timeout / 60000)} minutes`));
      }, timeout);

      proc.stdout.on('data', (chunk: Buffer) => {
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

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout) {
          reject(new Error(stderr || `Synthesis exited with code ${code}`));
        } else {
          finalOutput = stdout.trim() || stderr.trim() || '(empty synthesis)';
          resolve();
        }
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    activeProcesses.delete(sessionId);

    stmts.addMessage.run(
      assistantMsgId,
      sessionId,
      'assistant',
      finalOutput,
      engine,
      model,
      null,
      null,
    );
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

    if (project.ahw) {
      appendDailyNote(
        project.ahw,
        `**Delegation Synthesis** (${enrichedAgent.name}):\n${finalOutput.substring(0, 300)}${finalOutput.length > 300 ? '...' : ''}`,
      );
    }
  } catch (err) {
    activeProcesses.delete(sessionId);
    console.error('[Delegation] Synthesis failed:', (err as Error).message);
    const errText = `Delegation synthesis failed: ${(err as Error).message}`;
    saveErrorMessage(sessionId, assistantMsgId, engine, model, errText);
    broadcast({
      type: 'error',
      messageId: assistantMsgId,
      sessionId,
      error: errText,
    });
  }
}
