import { spawn, type ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { buildSpawnEnv, defaultModelForEngine } from './config.js';
import { detectCodexAuthMode, shouldPassModelFlag } from './codex-auth.js';
import { createStreamParser } from './stream-parser.js';
import type { StreamEvent } from './types.js';
import { pickProcessErrorMessage } from './process-error-message.js';
import type { EnrichedAgent, Project, Stmts, BroadcastFn, AppConfig, SessionRow } from './types.js';
import {
  activeDelegationSessions,
  delegationSessionUiMeta,
  clearDelegationUiMeta,
} from './delegation-state.js';
import { broadcastActiveTasksSnapshot } from './active-tasks.js';
import { applyAssistantTextChunkForDelegationKickoff } from './delegation-kickoff-buffer.js';

export interface DelegationDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  /** Same function as `buildEnrichedPrompt` in `chat.ts` (3-arg form: agent, null, opts). */
  buildEnrichedPrompt: typeof import('./chat.js').buildEnrichedPrompt;
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
  getCursorBin: () => string;
  getGeminiBin: () => string;
  getCodexBin: () => string;
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
  owner: string;
  scope: string;
  expectedArtifact: string;
  deadline: string;
  returnFormat: string;
}

export type DelegateMalformedReason =
  | 'invalid-json'
  | 'not-object'
  | 'empty-array'
  | 'no-valid-entries'
  | 'missing-contract-fields';

export interface DelegateDetectionResult {
  present: boolean;
  tasks: DelegateTask[] | null;
  reason: DelegateMalformedReason | null;
  rawBody: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeDelegateTask(raw: unknown): DelegateTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const rawAgentId =
    typeof row.agentId === 'string'
      ? row.agentId
      : typeof row.toAgent === 'string'
        ? row.toAgent
        : '';
  if (!isNonEmptyString(rawAgentId) || !isNonEmptyString(row.task)) return null;
  if (
    !isNonEmptyString(row.owner) ||
    !isNonEmptyString(row.scope) ||
    !isNonEmptyString(row.expectedArtifact) ||
    !isNonEmptyString(row.deadline) ||
    !isNonEmptyString(row.returnFormat)
  ) {
    return null;
  }
  return {
    agentId: rawAgentId.trim(),
    task: (row.task as string).trim(),
    owner: row.owner.trim(),
    scope: row.scope.trim(),
    expectedArtifact: row.expectedArtifact.trim(),
    deadline: row.deadline.trim(),
    returnFormat: row.returnFormat.trim(),
  };
}

export function detectDelegateBlock(text: string): DelegateDetectionResult {
  if (typeof text !== 'string') return { present: false, tasks: null, reason: null, rawBody: null };
  const match = text.match(/<delegate>\s*([\s\S]*?)\s*<\/delegate>/);
  if (!match) return { present: false, tasks: null, reason: null, rawBody: null };

  const rawBody = match[1] ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { present: true, tasks: null, reason: 'invalid-json', rawBody };
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { present: true, tasks: null, reason: 'not-object', rawBody };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) return { present: true, tasks: null, reason: 'empty-array', rawBody };

  const normalized = list
    .map((entry) => normalizeDelegateTask(entry))
    .filter((entry): entry is DelegateTask => !!entry);
  if (normalized.length === 0)
    return { present: true, tasks: null, reason: 'no-valid-entries', rawBody };
  if (normalized.length !== list.length) {
    return { present: true, tasks: null, reason: 'missing-contract-fields', rawBody };
  }
  return { present: true, tasks: normalized, reason: null, rawBody };
}

interface DelegationState {
  proc: ChildProcess | null;
  cancelled: boolean;
}

/** One-shot delegate subprocess: correct bin + args per sub-agent engine. */
interface DelegateCliSpec {
  bin: string;
  args: string[];
  engine: string;
  /** stdout is JSONL — accumulate `assistant_text` via stream parser. */
  parseStream: boolean;
}

function buildDelegateCliSpec(
  subAgent: EnrichedAgent,
  subPrompt: string,
  taskText: string,
  bins: { claude: string; cursor: string; gemini: string; codex: string },
  defaultModelStr: string,
  /** Lead session Ask Mode — mirrors `server/chat.ts` privilege flags on Gemini/Codex. */
  leadAskMode: boolean,
): DelegateCliSpec {
  const engine = subAgent.engine || 'claude-code';
  const model =
    (subAgent.model as string | undefined) || defaultModelStr || defaultModelForEngine(engine);
  const combined = `${subPrompt}\n\n${taskText}`;

  switch (engine) {
    case 'cursor-agent':
      return {
        bin: bins.cursor,
        args: ['-p', combined, '--force', '--model', model],
        engine,
        parseStream: false,
      };
    case 'gemini-cli': {
      const args = ['-p', combined, '--output-format', 'stream-json'];
      if (model && model !== 'auto') {
        args.push('--model', model);
      }
      if (!leadAskMode) {
        args.push('--yolo');
      }
      return { bin: bins.gemini, args, engine, parseStream: true };
    }
    case 'codex-cli': {
      const codexAuth = detectCodexAuthMode();
      const args = ['exec', '--json', '--skip-git-repo-check'];
      if (leadAskMode) {
        args.push('--sandbox', 'read-only');
      } else {
        args.push('--full-auto');
      }
      if (model && shouldPassModelFlag(codexAuth.mode, model)) {
        args.push('--model', model);
      }
      args.push(combined);
      return { bin: bins.codex, args, engine, parseStream: true };
    }
    default:
      return {
        bin: bins.claude,
        args: [
          '--print',
          '--permission-mode',
          'bypassPermissions',
          '--model',
          model,
          '--system-prompt',
          subPrompt,
          taskText,
        ],
        engine: 'claude-code',
        parseStream: false,
      };
  }
}

function absorbStreamEvents(
  events: StreamEvent[],
  sink: {
    finalText: string;
    partialFallback: string;
    streamErrorMessage: string;
  },
): void {
  let buffers = { finalText: sink.finalText, partialFallback: sink.partialFallback };
  for (const event of events) {
    if (event.type === 'assistant_text') {
      const text = typeof event.text === 'string' ? event.text : JSON.stringify(event.text ?? '');
      buffers = applyAssistantTextChunkForDelegationKickoff(
        buffers,
        text,
        event.partial,
        event.replacesAssistantBuffer ? { replace: true } : undefined,
      ).next;
    }
    if (event.type === 'result' && event.isError && event.text && !sink.streamErrorMessage) {
      sink.streamErrorMessage = event.text;
    }
    if (
      event.type === 'unknown' &&
      typeof event.text === 'string' &&
      (event.text.startsWith('codex error:') || event.text.startsWith('codex item error:'))
    ) {
      if (!sink.streamErrorMessage) sink.streamErrorMessage = event.text;
    }
  }
  sink.finalText = buffers.finalText;
  sink.partialFallback = buffers.partialFallback;
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
  const detection = detectDelegateBlock(text);
  if (!detection.present || detection.tasks) return detection.tasks;
  const excerpt = (detection.rawBody || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  console.error(
    `[Delegation] Invalid delegate payload (${detection.reason ?? 'unknown'}) (excerpt: ${
      excerpt || '<empty>'
    })`,
  );
  return null;
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
    getCursorBin,
    getGeminiBin,
    getCodexBin,
    getDefaultModel,
    getConfig,
  } = deps!;

  const cliBins = {
    claude: getClaudeBin(),
    cursor: getCursorBin(),
    gemini: getGeminiBin(),
    codex: getCodexBin(),
  };
  const DEFAULT_MODEL = getDefaultModel();
  const cfg = getConfig() as DelegationRetryConfig;

  const maxAttempts = Math.max(1, cfg.delegationMaxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryBackoffMs = Math.max(0, cfg.delegationRetryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);

  const validTasks: DelegateTask[] = [];
  for (const t of delegateTasks) {
    if (!leadAgent.subAgents || !leadAgent.subAgents.includes(t.agentId)) {
      console.warn(
        `[Delegation] Skip task for ${t.agentId}: not listed as sub-agent of ${leadAgent.id}`,
      );
      continue;
    }
    if (!getEnrichedAgent(t.agentId)) {
      console.warn(`[Delegation] Skip task for ${t.agentId}: agent not found in project roster`);
      continue;
    }
    validTasks.push(t);
  }

  if (validTasks.length === 0) {
    const detail = delegateTasks.map((t) => t.agentId).join(', ') || '(none)';
    console.warn(`[Delegation] No valid tasks after filtering (requested: ${detail})`);
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
    tasks: validTasks.map((t) => ({
      agentId: t.agentId,
      task: t.task,
      owner: t.owner,
      scope: t.scope,
      expectedArtifact: t.expectedArtifact,
      deadline: t.deadline,
      returnFormat: t.returnFormat,
    })),
  });
  broadcastActiveTasksSnapshot(stmts, broadcast);

  const leadSessionRow = stmts.getSession.get(sessionId) as SessionRow | undefined;
  const leadAskMode = !!leadSessionRow?.ask_mode;

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
          const subPrompt = buildEnrichedPrompt(subAgent, undefined, { useWorktree: true });
          const spec = buildDelegateCliSpec(
            subAgent,
            subPrompt,
            task.task,
            cliBins,
            DEFAULT_MODEL,
            leadAskMode,
          );
          const spawnCwd = leadCwd || subAgent.cwd || project.cwd || process.env.HOME || '/';

          console.warn(
            `[Delegation] spawn sub=${subAgent.id} engine=${spec.engine} bin=${spec.bin} cwd=${spawnCwd}`,
          );

          let stdout = '';
          let stderr = '';
          const parser = spec.parseStream ? createStreamParser(spec.engine) : null;
          const sink = { finalText: '', partialFallback: '', streamErrorMessage: '' };

          const timeout = cfg.conferenceTimeoutMs || 600000;

          const spawnEnv = buildSpawnEnv(cfg);

          const proc = spawn(spec.bin, spec.args, {
            cwd: spawnCwd,
            env: spawnEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          delegationState.proc = proc;

          const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
          }, timeout);

          proc.stdout?.on('data', (chunk: Buffer) => {
            if (parser) {
              absorbStreamEvents(parser.feed(chunk), sink);
              const live = sink.finalText || sink.partialFallback;
              broadcast({
                type: 'delegation_stream',
                sessionId,
                delegationId,
                agentId: subAgent.id,
                agentName: subAgent.name,
                agentColor: subAgent.color,
                content: live,
              });
            } else {
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
            }
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
            if (parser) {
              absorbStreamEvents(parser.flush(), sink);
            }
            const assembled = parser
              ? (sink.finalText || sink.partialFallback).trim()
              : stdout.trim();
            const fallbackOut = stderr.trim();
            if (code !== 0 && !assembled) {
              const msg = pickProcessErrorMessage({
                stderr,
                streamErrorMessage: sink.streamErrorMessage,
                engine: spec.engine,
                exitCode: code,
              });
              reject(new Error(msg || fallbackOut || `Exited with code ${code}`));
            } else {
              resolve(assembled || fallbackOut || '(empty response)');
            }
          });

          proc.on('error', (err: Error) => {
            clearTimeout(timer);
            delegationState.proc = null;
            console.error(
              `[Delegation] spawn failed sub=${subAgent.id} engine=${spec.engine} bin=${spec.bin}: ${err.message}`,
            );
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
      const retryTrace =
        attemptsMade > 1 && attemptErrors.length > 0
          ? ` Attempt trace: ${attemptErrors.join(' | ')}`
          : '';
      const finalError = wasCancelled
        ? 'Cancelled'
        : `Delegation to ${subAgent.name} failed after ${attemptsMade} attempt${
            attemptsMade === 1 ? '' : 's'
          }: ${lastError ?? 'unknown error'}${retryTrace}`;

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
    getCursorBin,
    getGeminiBin,
    getCodexBin,
    getDefaultModel,
    getConfig,
    buildEnrichedPrompt,
  } = deps!;

  const activeProcesses = getActiveProcesses();

  const DEFAULT_MODEL = getDefaultModel();
  const cfg = getConfig();

  const assistantMsgId = uuidv4();
  const sessRow = stmts.getSession.get(sessionId) as SessionRow | undefined;
  const sessionEngine = sessRow?.engine || enrichedAgent.engine || 'claude-code';
  const sessionModel =
    sessRow?.model || (enrichedAgent?.model as string | undefined) || DEFAULT_MODEL;

  const synthesisPrompt = buildDelegationSynthesisPrompt(results, originalUserMessage);

  broadcast({
    type: 'thinking',
    messageId: assistantMsgId,
    sessionId,
    engine: sessionEngine,
    model: sessionModel,
  });

  try {
    const sess = sessRow ?? (stmts.getSession.get(sessionId) as SessionRow | undefined);
    const engineSessionId = sess?.engine_session_id;
    const isAskMode = !!sess?.ask_mode;
    const cwdSynth = leadCwd || project.cwd || process.env.HOME || '/';

    const timeout = cfg.conferenceTimeoutMs || 600000;
    let finalOutput = '';

    const synthMarker: { kill: () => void } = { kill: () => {} };
    activeProcesses.set(sessionId, synthMarker as unknown as ChildProcess);

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const synthEnv = buildSpawnEnv(cfg);

      let bin = getClaudeBin();
      let args: string[] = [];

      if (sessionEngine === 'cursor-agent') {
        if (!engineSessionId) {
          reject(
            new Error(
              'Cannot synthesize delegation results: missing Cursor engine session id (resume id)',
            ),
          );
          return;
        }
        bin = getCursorBin();
        args = [
          '-p',
          synthesisPrompt,
          '--force',
          '--model',
          sessionModel,
          '--resume',
          engineSessionId,
          '--output-format',
          'stream-json',
          '--stream-partial-output',
        ];
      } else if (sessionEngine === 'gemini-cli') {
        bin = getGeminiBin();
        // Match delegate path: second arg must be null so the builder treats the first
        // argument as EnrichedAgent (truthy sessionId wrongly selects project+agent arity).
        const enriched = buildEnrichedPrompt(enrichedAgent, undefined, {
          useWorktree: !!sess?.use_worktree,
          sessionId,
          isFirstMessage: false,
        });
        const combined = `${enriched}\n\n${synthesisPrompt}`;
        // Mirror `server/chat.ts` Gemini branch: `--yolo` only when not in Ask Mode.
        args = ['-p', combined, '--output-format', 'stream-json'];
        if (sessionModel && sessionModel !== 'auto') {
          args.push('--model', sessionModel);
        }
        if (!isAskMode) {
          args.push('--yolo');
        }
      } else if (sessionEngine === 'codex-cli') {
        bin = getCodexBin();
        const codexAuth = detectCodexAuthMode();
        const enriched = buildEnrichedPrompt(enrichedAgent, undefined, {
          useWorktree: !!sess?.use_worktree,
          sessionId,
          isFirstMessage: false,
        });
        // Mirror `server/chat.ts` Codex branch: read-only sandbox in Ask Mode.
        args = ['exec'];
        if (engineSessionId) {
          args.push('resume', engineSessionId);
        }
        args.push('--json', '--skip-git-repo-check');
        if (isAskMode) {
          args.push('--sandbox', 'read-only');
        } else {
          args.push('--full-auto');
        }
        if (sessionModel && shouldPassModelFlag(codexAuth.mode, sessionModel)) {
          args.push('--model', sessionModel);
        }
        args.push(engineSessionId ? synthesisPrompt : `${enriched}\n\n${synthesisPrompt}`);
      } else {
        args = [
          '--print',
          '--permission-mode',
          isAskMode ? 'plan' : 'bypassPermissions',
          '--model',
          sessionModel,
          '--resume',
          engineSessionId || sessionId,
          synthesisPrompt,
        ];
      }

      const useParser = sessionEngine !== 'claude-code';
      const parser = useParser ? createStreamParser(sessionEngine) : null;
      const sink = { finalText: '', partialFallback: '', streamErrorMessage: '' };

      console.warn(`[Delegation] synthesis engine=${sessionEngine} bin=${bin} cwd=${cwdSynth}`);

      const proc = spawn(bin, args, {
        cwd: cwdSynth,
        env: synthEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      activeProcesses.set(sessionId, proc);

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Synthesis timed out after ${Math.round(timeout / 60000)} minutes`));
      }, timeout);

      proc.stdout.on('data', (chunk: Buffer) => {
        if (parser) {
          absorbStreamEvents(parser.feed(chunk), sink);
          broadcast({
            type: 'stream',
            messageId: assistantMsgId,
            sessionId,
            chunk: chunk.toString(),
            content: sink.finalText || sink.partialFallback,
            engine: sessionEngine,
            model: sessionModel,
          });
        } else {
          stdout += chunk.toString();
          broadcast({
            type: 'stream',
            messageId: assistantMsgId,
            sessionId,
            chunk: chunk.toString(),
            content: stdout,
            engine: sessionEngine,
            model: sessionModel,
          });
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (parser) {
          absorbStreamEvents(parser.flush(), sink);
        }
        const assembled = parser ? (sink.finalText || sink.partialFallback).trim() : stdout.trim();
        if (code !== 0 && !assembled) {
          reject(
            new Error(
              pickProcessErrorMessage({
                stderr,
                streamErrorMessage: sink.streamErrorMessage,
                engine: sessionEngine,
                exitCode: code,
              }) ||
                stderr.trim() ||
                `Synthesis exited with code ${code}`,
            ),
          );
        } else {
          finalOutput = assembled || stderr.trim() || '(empty synthesis)';
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
      sessionEngine,
      sessionModel,
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
        engine: sessionEngine,
        model: sessionModel,
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
    saveErrorMessage(sessionId, assistantMsgId, sessionEngine, sessionModel, errText);
    broadcast({
      type: 'error',
      messageId: assistantMsgId,
      sessionId,
      error: errText,
    });
  }
}
