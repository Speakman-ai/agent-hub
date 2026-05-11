import cron, { type ScheduledTask } from 'node-cron';
import { spawn } from 'child_process';
import { trackChild, killProcessGroup } from './process-groups.js';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db as _db, stmts as _stmts } from './db.js';
import config, { buildSpawnEnv, fileConfig } from './config.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { resolveCronSkillPrincipalAgentId } from './cron-skill-principal.js';
import { disableNativeSkillToolArgs } from './claude-cli-args.js';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
import { getOrCreateProcessWorktree } from './worktree.js';
import { runWorkspacePurge } from './session-purge.js';
import { reconcileMemoryFromWiki } from './memory.js';
import { listPages, getPage } from './wiki.js';
import { getProjects } from './project-model.js';
import { setSessionOwner, getOrgOwnerUserId } from './session-ownership.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from './engine-resolver.js';
import { runOneShotPrompt, type OneShotDetailed } from './one-shot-spawn.js';
import {
  runCertRenewalHeartbeat,
  CERT_RENEWAL_CRON,
} from './container-pool/cert-renewal-heartbeat.js';
import { readPrEnvConfig } from './container-pool/pr-env-runtime.js';
import { readPrEnvConfigRow } from './pr-env-store.js';
import { runReaperHeartbeat, REAPER_CRON } from './container-pool/reaper-heartbeat.js';
import {
  runPoolAlertsHeartbeat,
  POOL_ALERTS_CRON,
} from './container-pool/pool-alerts-heartbeat.js';
import { PoolAllocator } from './container-pool/allocator.js';
import type {
  EnrichedAgent,
  CronRow,
  HeartbeatStateRow,
  ThreadRow,
  ThreadEntryRow,
  SessionRow,
  Project,
  BroadcastFn,
  Stmts,
  AppConfig,
} from './types.js';

const db = _db!;
const stmts = _stmts!;

const CLAUDE_BIN: string = config.claudeBin;
const SLACK_WEBHOOK_URL: string | null = config.slackWebhookUrl;

const scheduledTasks = new Map<string, ScheduledTask>();

const runningHeartbeats = new Set<string>();

let onCronSessionUpdate: ((data: Record<string, unknown>) => void) | null = null;
export function setOnCronSessionUpdate(fn: (data: Record<string, unknown>) => void): void {
  onCronSessionUpdate = fn;
}

let broadcastFn: BroadcastFn | null = null;
export function setBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

function getOrCreateHeartbeatThread(agent: EnrichedAgent): ThreadRow | null {
  const projectId = agent.projectId;
  if (!projectId) {
    console.warn(
      `[Heartbeat] No projectId for agent ${agent.name} (${agent.id}) — skipping thread`,
    );
    return null;
  }

  let thread = stmts.getThreadBySourceId.get(projectId, 'heartbeat', agent.id) as
    | ThreadRow
    | undefined;
  if (thread) return thread;

  const id = uuidv4();
  const name = `${agent.name} heartbeat`;
  stmts.createThread.run(id, projectId, name, 'heartbeat', agent.id);
  thread = stmts.getThread.get(id) as ThreadRow | undefined;

  if (broadcastFn) {
    broadcastFn({ type: 'thread_created', projectId, thread });
  }

  return thread ?? null;
}

function appendToHeartbeatThread(agent: EnrichedAgent, content: string): void {
  try {
    const thread = getOrCreateHeartbeatThread(agent);
    if (!thread) return;

    const entryId = uuidv4();
    stmts.createThreadEntry.run(entryId, thread.id, content);
    const entry = stmts.getThreadEntry.get(entryId) as ThreadEntryRow | undefined;

    if (broadcastFn) {
      broadcastFn({
        type: 'thread_entry_created',
        threadId: thread.id,
        projectId: thread.project_id,
        threadName: thread.name,
        threadType: thread.type,
        entry,
      });
    }
  } catch (err) {
    console.error(
      `[Heartbeat] Failed to append to thread for ${agent.name}:`,
      (err as Error).message,
    );
  }
}

function isoOrNull(date: Date | null | undefined): string | null {
  if (!date || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function persistNextRun(
  kind: 'heartbeat' | 'cron',
  id: string | number,
  task: ScheduledTask,
): void {
  try {
    const next = isoOrNull(task.getNextRun?.());
    if (kind === 'heartbeat') {
      stmts.upsertHeartbeatState.run(id, next, null);
    } else if (kind === 'cron') {
      stmts.updateCronNextRun.run(next, id);
    }
  } catch (err) {
    console.error(
      `[Scheduler] Failed to persist next run for ${kind}:${id}:`,
      (err as Error).message,
    );
  }
}

function persistLastRun(kind: 'heartbeat' | 'cron', id: string | number, when = new Date()): void {
  const iso = isoOrNull(when);
  try {
    if (kind === 'heartbeat') {
      stmts.upsertHeartbeatState.run(id, null, iso);
    }
  } catch (err) {
    console.error(
      `[Scheduler] Failed to persist last run for ${kind}:${id}:`,
      (err as Error).message,
    );
  }
}

interface RunClaudeOptions {
  timeoutMs?: number;
  detailed?: boolean;
  /**
   * Optional Claude model ID forwarded as `--model <id>`. When unset/empty
   * the CLI default is used. Validated upstream by the heartbeat route,
   * heartbeat config, and the cron API's `model` column (all validate
   * against `config.engineValidModels['claude-code']`); no allowlist check
   * happens here so cron/manual runs stay agnostic to engine catalog drift.
   * Per-cron model selection flows through here via `runCronJob` after
   * being resolved against the engine default.
   */
  model?: string | null;
  /**
   * When set, merges decrypted per-user skill credentials into the spawn env
   * (same contract as interactive chat).
   */
  skillCredentialMerge?: {
    ownerId: string | null;
    agentId: string;
    project: Project;
  };
}

interface DetailedResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runClaude(
  prompt: string,
  cwd: string,
  systemPrompt?: string,
  options?: RunClaudeOptions & { detailed: true },
): Promise<DetailedResult>;
export function runClaude(
  prompt: string,
  cwd: string,
  systemPrompt?: string,
  options?: RunClaudeOptions,
): Promise<string>;
export function runClaude(
  prompt: string,
  cwd: string,
  systemPrompt?: string,
  options: RunClaudeOptions = {},
): Promise<string | DetailedResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(cwd)) {
      return reject(
        new Error(
          `Working directory does not exist: "${cwd}" — update the cwd in agent/cron settings`,
        ),
      );
    }

    const args: string[] = ['--print', '--permission-mode', 'bypassPermissions'];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    const modelOverride =
      typeof options.model === 'string' && options.model.trim() ? options.model.trim() : null;
    if (modelOverride) {
      args.push('--model', modelOverride);
    }
    // see claude-cli-args.ts
    args.push(...disableNativeSkillToolArgs());
    // `--` terminates option parsing so the variadic `--disallowed-tools <tools...>`
    // doesn't swallow the trailing positional prompt (Claude CLI 2.x).
    args.push('--', prompt);

    let output = '';
    let errorOutput = '';
    const timeout = options.timeoutMs || config.defaultTimeoutMs;

    const heartbeatEnv = buildSpawnEnv(config);
    if (options.skillCredentialMerge) {
      mergeSkillCredentialSpawnEnv(heartbeatEnv, options.skillCredentialMerge);
    }

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: heartbeatEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const timer = setTimeout(() => {
      killProcessGroup(proc, 'SIGTERM');
      if (options.detailed) {
        reject(
          Object.assign(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`), {
            stdout: output,
            stderr: errorOutput,
          }),
        );
      } else {
        reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
      }
    }, timeout);

    proc.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (options.detailed) {
        resolve({
          stdout: output.trim(),
          stderr: errorOutput.trim(),
          code,
        });
      } else if (code !== 0 && !output) {
        reject(new Error(errorOutput || `Exited with code ${code}`));
      } else {
        resolve(output.trim() || errorOutput.trim() || '(empty response)');
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function notifySlack(agentName: string, result: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return;

  const lowerResult = result.toLowerCase();
  const allClearPatterns = [
    'no open pr',
    'no failing',
    'all clear',
    'nothing to report',
    'no issues',
    'everything looks good',
    'no alerts',
    'all checks pass',
    'no action needed',
    'no stale',
    '0 open pull request',
  ];
  if (allClearPatterns.some((p) => lowerResult.includes(p)) && result.length < 200) {
    return;
  }

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🤖 *${agentName} Heartbeat*\n${result.substring(0, 2000)}`,
      }),
    });
  } catch (err) {
    console.error('Failed to send Slack notification:', (err as Error).message);
  }
}

/**
 * Notify mobile subscribers when a cron completes. Delegates to the shared
 * `push.ts` module so cron pushes honour per-device preferences and share
 * the Expo delivery/cleanup path with broadcast-driven pushes.
 */
async function sendPushNotifications(
  cronName: string,
  result: string,
  sessionId: string,
  cronId: number,
): Promise<void> {
  const { dispatchPushEvent, cronCompletePush } = await import('./push.js');
  const { title, body } = cronCompletePush({ cronName, result });
  await dispatchPushEvent('cron', {
    title,
    body,
    data: { sessionId, cronId: String(cronId), type: 'cron' },
  });
}

interface HeartbeatResult {
  id: number | bigint;
  status: 'success' | 'error';
  result: string;
}

export async function runHeartbeat(agent: EnrichedAgent): Promise<HeartbeatResult | null> {
  if (!agent.heartbeat?.prompt) return null;

  if (runningHeartbeats.has(agent.id)) {
    console.log(`[Heartbeat] Skipping ${agent.name} — already running`);
    return null;
  }
  runningHeartbeats.add(agent.id);

  console.log(`[Heartbeat] Running for ${agent.name}...`);
  persistLastRun('heartbeat', agent.id);
  const logEntry = stmts.addHeartbeatLog.run(agent.id, agent.heartbeat.prompt, 'running');
  const logId = logEntry.lastInsertRowid;

  try {
    const heartbeatCwd = await getOrCreateProcessWorktree(agent.cwd, `heartbeat-${agent.id}`);
    const isDocsAgent = agent.role === 'docs';
    const timeoutMs =
      (agent.heartbeat as EnrichedAgent['heartbeat'] & { timeoutMs?: number })?.timeoutMs ||
      (isDocsAgent ? config.docsTimeoutMs : config.defaultTimeoutMs);
    const heartbeatModel =
      typeof agent.heartbeat.model === 'string' && agent.heartbeat.model.trim()
        ? agent.heartbeat.model.trim()
        : undefined;
    const hbProject = getProjects().find((p) => p.id === agent.projectId);
    // Resolve the engine just-in-time so a heartbeat run can fall back to
    // any other authenticated CLI when Claude is unavailable. Throws
    // NoEnginesAvailableError when nothing is configured — caught below
    // and surfaced as a clear "set up credentials" error in the log.
    const preferredEngine = (agent as EnrichedAgent & { engine?: string }).engine ?? 'claude-code';
    const resolved = await resolveOneShotEngine(config, {
      preferred: preferredEngine,
      preferredModel: heartbeatModel,
    });
    const heartbeatEnv = buildSpawnEnv(config);
    if (hbProject) {
      mergeSkillCredentialSpawnEnv(heartbeatEnv, {
        ownerId: getOrgOwnerUserId(),
        agentId: agent.id,
        project: hbProject,
      });
    }
    if (resolved.fallbackUsed) {
      console.warn(
        `[Heartbeat] ${agent.name}: preferred engine "${preferredEngine}" unavailable (${resolved.fallbackFromReason}); using "${resolved.engine}".`,
      );
    }
    const result = await runOneShotPrompt(
      {
        engine: resolved.engine,
        model: resolved.model,
        prompt: agent.heartbeat.prompt,
        systemPrompt: agent.systemPrompt,
        cwd: heartbeatCwd,
        timeoutMs,
        env: heartbeatEnv,
      },
      config,
    );
    stmts.updateHeartbeatLog.run(result, 'success', logId);
    console.log(`[Heartbeat] ${agent.name} completed successfully`);

    appendToHeartbeatThread(agent, result);

    await notifySlack(agent.name, result);
    return { id: logId, status: 'success', result };
  } catch (err) {
    const isNoEngines = err instanceof NoEnginesAvailableError;
    const rawMsg = (err as Error).message || 'Unknown error';
    const errorMsg = isNoEngines
      ? `No AI engine credentials available — heartbeat cannot run.\n${rawMsg}`
      : rawMsg;
    stmts.updateHeartbeatLog.run(errorMsg, 'error', logId);
    console.error(`[Heartbeat] ${agent.name} failed:`, errorMsg);

    appendToHeartbeatThread(agent, `ERROR: ${errorMsg}`);

    return { id: logId, status: 'error', result: errorMsg };
  } finally {
    runningHeartbeats.delete(agent.id);
    const task = scheduledTasks.get(`heartbeat:${agent.id}`);
    if (task) persistNextRun('heartbeat', agent.id, task);
    try {
      const thread = getOrCreateHeartbeatThread(agent);
      if (thread) {
        stmts.pruneThreadEntries.run(thread.id, thread.id);
      }
    } catch {}
  }
}

function findProjectForCron(cronJob: CronRow): Project | null {
  const projects = getProjects();
  return (
    (cronJob.project_id && projects.find((p) => p.id === cronJob.project_id)) ||
    projects.find((p) => p.cwd === cronJob.cwd) ||
    null
  );
}

function resolveCronCwd(cronJob: CronRow): string {
  if (existsSync(cronJob.cwd)) return cronJob.cwd;

  const project = findProjectForCron(cronJob);
  if (project && existsSync(project.cwd)) {
    console.warn(
      `[Cron] cwd "${cronJob.cwd}" does not exist for "${cronJob.name}" — using project cwd "${project.cwd}"`,
    );
    return project.cwd;
  }

  const fallback = config.defaultCwd;
  console.warn(
    `[Cron] cwd "${cronJob.cwd}" does not exist for "${cronJob.name}" — falling back to "${fallback}"`,
  );
  return fallback;
}

interface CronEntryContentInput {
  stdout: string | null;
  stderr: string | null;
  status: string;
  durationMs: number;
}

function formatCronEntryContent({
  stdout,
  stderr,
  status,
  durationMs,
}: CronEntryContentInput): string {
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`--- stderr ---\n${stderr}`);
  if (!stdout && !stderr) parts.push('(empty response)');
  parts.push(`\n[${status} in ${durationMs}ms]`);
  return parts.join('\n');
}

function getOrCreateCronThread(cronJob: CronRow): ThreadRow | null {
  const project = findProjectForCron(cronJob);
  if (!project) return null;

  const sourceId = String(cronJob.id);
  let thread = stmts.getThreadBySource.get(project.id, 'cron', sourceId) as ThreadRow | undefined;
  if (!thread) {
    const threadId = uuidv4();
    stmts.createThread.run(threadId, project.id, cronJob.name, 'cron', sourceId);
    thread = stmts.getThread.get(threadId) as ThreadRow | undefined;
    console.log(`[Cron] Created thread "${cronJob.name}" for cron ${cronJob.id}`);
  }
  return thread ?? null;
}

interface CronRunResult {
  id: number | bigint;
  status: 'success' | 'error';
  result: string;
}

/**
 * Build the `last_result` value written into the `crons` row when a run
 * fails. When the failure carried partial stdout/stderr (e.g. a timeout
 * surfaced through `runClaude({ detailed: true })`), include it so the
 * cron card shows the work-in-progress output instead of just
 * `ERROR: Timed out after N minutes`. Falls back to the historical
 * `ERROR: <msg>` shape when no partial output is available.
 *
 * Exported for unit testing — the runtime call site is in `runCronJob`.
 */
export function formatCronErrorResult(
  errorMsg: string,
  partialStdout: string | null | undefined,
  partialStderr: string | null | undefined,
): string {
  const message = (errorMsg || 'Unknown error').trim() || 'Unknown error';
  const stdout = (partialStdout || '').trim();
  const stderr = (partialStderr || '').trim();
  const partial = stdout || stderr;
  if (!partial) {
    return `ERROR: ${message}`;
  }
  return `ERROR: ${message}\n\n--- Partial output ---\n${partial}`;
}

export async function runCronJob(cronJob: CronRow): Promise<CronRunResult> {
  console.log(`[Cron] Running "${cronJob.name}"...`);
  const logEntry = stmts.addCronLog.run(cronJob.id, 'running');
  const logId = logEntry.lastInsertRowid;
  const startTime = Date.now();

  // Honor per-cron timeout override; fall back to the shared default. Stored
  // as NULL in the DB when unset, which coerces to the default here.
  const timeoutMs =
    typeof cronJob.timeout_ms === 'number' && cronJob.timeout_ms > 0
      ? cronJob.timeout_ms
      : config.defaultTimeoutMs;

  const thread = getOrCreateCronThread(cronJob);

  // Per-cron model override; null means "use the engine default". Resolved
  // once here so both the CLI invocation and the session record share the
  // same value (otherwise the session row would always read the default
  // even when the actual run picked something else).
  const requestedModel = cronJob.model || null;

  try {
    const resolvedCwd = resolveCronCwd(cronJob);
    const cronCwd = await getOrCreateProcessWorktree(resolvedCwd, `cron-${cronJob.id}`);
    const cronProject = findProjectForCron(cronJob);
    const cronSkillAgentId = cronProject
      ? resolveCronSkillPrincipalAgentId(cronJob, cronProject)
      : undefined;
    // Cron jobs historically targeted Claude Code only; preserve that as
    // the preferred engine, but fall back to any other authed engine
    // when Claude is unavailable. NoEnginesAvailableError bubbles into
    // the outer catch block where it's surfaced verbatim.
    const resolved = await resolveOneShotEngine(config, {
      preferred: 'claude-code',
      preferredModel: requestedModel,
    });
    const cronEnv = buildSpawnEnv(config);
    if (cronProject && cronSkillAgentId) {
      mergeSkillCredentialSpawnEnv(cronEnv, {
        ownerId: getOrgOwnerUserId(),
        agentId: cronSkillAgentId,
        project: cronProject,
      });
    }
    if (resolved.fallbackUsed) {
      console.warn(
        `[Cron] "${cronJob.name}": preferred engine "claude-code" unavailable (${resolved.fallbackFromReason}); using "${resolved.engine}".`,
      );
    }
    const cronModel = resolved.model;
    const detailed: OneShotDetailed = await runOneShotPrompt(
      {
        engine: resolved.engine,
        model: resolved.model,
        prompt: cronJob.prompt,
        cwd: cronCwd,
        timeoutMs,
        env: cronEnv,
        detailed: true,
      },
      config,
    );
    const durationMs = Date.now() - startTime;
    const result = detailed.stdout || detailed.stderr || '(empty response)';
    stmts.updateCronResult.run(result, cronJob.id);
    stmts.updateCronLog.run(result, 'success', durationMs, logId);
    console.log(`[Cron] "${cronJob.name}" completed successfully (${durationMs}ms)`);

    if (thread) {
      try {
        const entryId = uuidv4();
        const content = formatCronEntryContent({
          stdout: detailed.stdout,
          stderr: detailed.stderr,
          status: 'success',
          durationMs,
        });
        stmts.createThreadEntry.run(entryId, thread.id, content);
        const entry = stmts.getThreadEntry.get(entryId) as ThreadEntryRow | undefined;
        if (broadcastFn) {
          broadcastFn({
            type: 'thread_entry_created',
            threadId: thread.id,
            projectId: thread.project_id,
            threadName: thread.name,
            threadType: thread.type,
            entry,
            // When the cron has opted out of "ran" notifications, suppress
            // the mobile push that `handleBroadcastForPush` would otherwise
            // dispatch from this broadcast. The UI still receives the event
            // and updates the thread view in real time.
            suppressPush: !cronJob.notify_on_run,
          });
        }
      } catch (err) {
        console.error(
          `[Cron] Failed to add thread entry for "${cronJob.name}":`,
          (err as Error).message,
        );
      }
    }

    try {
      let session = stmts.getSessionByCronId.get(cronJob.id) as SessionRow | undefined;
      if (!session) {
        const sessionId = uuidv4();
        const sessionName = `Cron: ${cronJob.name}`;
        // Persist the engine actually used so the session row matches reality
        // when fallback kicked in (otherwise the row reads "claude-code"
        // even when the run resolved to e.g. cursor-agent).
        stmts.createSession.run(
          sessionId,
          '_cron',
          sessionName,
          resolved.engine,
          cronModel,
          0,
          0,
          1,
        );
        // System-spawned cron sessions belong to the org owner.
        setSessionOwner(sessionId, getOrgOwnerUserId());
        stmts.updateSessionCronId.run(cronJob.id, sessionId);
        session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      }
      const msgId = uuidv4();
      stmts.addMessage.run(
        msgId,
        session!.id,
        'assistant',
        result,
        resolved.engine,
        null,
        null,
        null,
      );
      stmts.touchSession.run(session!.id);

      // Only push when this cron has explicitly opted in. The thread and
      // session rows above are still written and broadcast — but those
      // broadcasts carry `suppressPush: true` when notify_on_run is off, so
      // mobile devices don't get pinged via the `thread_entry` channel
      // either. See `handleBroadcastForPush` in `push.ts`.
      if (cronJob.notify_on_run) {
        await sendPushNotifications(cronJob.name, result, session!.id, cronJob.id);
      }

      if (onCronSessionUpdate) {
        onCronSessionUpdate({
          type: 'cron_session_update',
          sessionId: session!.id,
          cronId: cronJob.id,
          cronName: cronJob.name,
          threadId: thread?.id || null,
        });
      }
    } catch (err) {
      console.error(
        `[Cron] Failed to save session/push for "${cronJob.name}":`,
        (err as Error).message,
      );
    }

    if (SLACK_WEBHOOK_URL) {
      const lowerResult = result.toLowerCase();
      const allClear = ['no open', 'nothing to', 'all clear', 'no dependabot'].some((p) =>
        lowerResult.includes(p),
      );
      if (!allClear || result.length > 200) {
        await notifySlack(`Cron: ${cronJob.name}`, result);
      }
    }

    return { id: logId, status: 'success', result };
  } catch (err) {
    const typedErr = err as Error & { stdout?: string; stderr?: string };
    const isNoEngines = err instanceof NoEnginesAvailableError;
    const baseMsg = typedErr.message || 'Unknown error';
    const errorMsg = isNoEngines
      ? `No AI engine credentials available — cron cannot run.\n${baseMsg}`
      : baseMsg;
    const durationMs = Date.now() - startTime;
    const cronResult = formatCronErrorResult(errorMsg, typedErr.stdout, typedErr.stderr);
    stmts.updateCronResult.run(cronResult, cronJob.id);
    stmts.updateCronLog.run(errorMsg, 'error', durationMs, logId);
    console.error(`[Cron] "${cronJob.name}" failed:`, errorMsg);

    if (thread) {
      try {
        const entryId = uuidv4();
        const content = formatCronEntryContent({
          stdout: typedErr.stdout || null,
          stderr: typedErr.stderr || errorMsg,
          status: 'error',
          durationMs,
        });
        stmts.createThreadEntry.run(entryId, thread.id, content);
        const entry = stmts.getThreadEntry.get(entryId) as ThreadEntryRow | undefined;
        if (broadcastFn) {
          broadcastFn({
            type: 'thread_entry_created',
            threadId: thread.id,
            projectId: thread.project_id,
            threadName: thread.name,
            threadType: thread.type,
            entry,
            // See success-path comment — honor per-cron notify_on_run on the
            // error path too, so a silenced cron doesn't suddenly start
            // pushing just because it happened to fail.
            suppressPush: !cronJob.notify_on_run,
          });
        }
      } catch (threadErr) {
        console.error(
          `[Cron] Failed to add error thread entry for "${cronJob.name}":`,
          (threadErr as Error).message,
        );
      }
    }

    return { id: logId, status: 'error', result: errorMsg };
  } finally {
    const task = scheduledTasks.get(`cron:${cronJob.id}`);
    if (task) persistNextRun('cron', cronJob.id, task);
    try {
      stmts.pruneCronLogs.run(cronJob.id, cronJob.id);
    } catch {}
  }
}

export function scheduleAll(agents: EnrichedAgent[]): void {
  for (const [, task] of scheduledTasks) {
    task.stop();
  }
  scheduledTasks.clear();

  try {
    const cleaned = db!
      .prepare(
        `UPDATE heartbeat_logs SET status = 'error', result = 'Server restarted — run abandoned' WHERE status = 'running'`,
      )
      .run();
    if (cleaned.changes > 0) {
      console.log(
        `[Heartbeat] Cleaned up ${cleaned.changes} stale "running" log(s) from previous boot`,
      );
    }
  } catch (err) {
    console.error('[Heartbeat] Failed to clean stale logs:', (err as Error).message);
  }

  const now = Date.now();
  const missed: Array<() => void | Promise<unknown>> = [];

  for (const agent of agents) {
    if (agent.heartbeat?.enabled && agent.heartbeat?.interval) {
      if (!cron.validate(agent.heartbeat.interval)) {
        console.error(
          `[Heartbeat] Invalid cron expression for ${agent.name}: ${agent.heartbeat.interval}`,
        );
        continue;
      }
      const task = cron.schedule(
        agent.heartbeat.interval,
        wrapCronTick(() => runHeartbeat(agent), `heartbeat:${agent.id}`),
        defaultTickOptions({
          intervalSeconds: estimateIntervalSeconds(agent.heartbeat.interval),
          name: `heartbeat:${agent.id}`,
        }),
      );
      scheduledTasks.set(`heartbeat:${agent.id}`, task);
      console.log(`[Heartbeat] Scheduled ${agent.name}: ${agent.heartbeat.interval}`);

      const state = stmts.getHeartbeatState.get(agent.id) as HeartbeatStateRow | undefined;
      const prevNext = state?.next_run_at ? Date.parse(state.next_run_at) : NaN;
      if (Number.isFinite(prevNext) && prevNext < now) {
        const lateBySec = Math.round((now - prevNext) / 1000);
        console.log(
          `[Heartbeat] ${agent.name} missed a run (was due ${lateBySec}s ago) — catching up`,
        );
        missed.push(() => runHeartbeat(agent));
      }

      persistNextRun('heartbeat', agent.id, task);
    } else {
      try {
        stmts.deleteHeartbeatState.run(agent.id);
      } catch {}
    }
  }

  const crons = stmts.getCrons.all() as CronRow[];
  for (const cronJob of crons) {
    if (cronJob.enabled) {
      if (!cron.validate(cronJob.schedule)) {
        console.error(`[Cron] Invalid expression for "${cronJob.name}": ${cronJob.schedule}`);
        continue;
      }
      const task = cron.schedule(
        cronJob.schedule,
        wrapCronTick(() => {
          const fresh = stmts.getCron.get(cronJob.id) as CronRow | undefined;
          if (fresh && fresh.enabled) {
            runCronJob(fresh);
          }
        }, `cron:${cronJob.id}`),
        defaultTickOptions({
          intervalSeconds: estimateIntervalSeconds(cronJob.schedule),
          name: `cron:${cronJob.id}`,
        }),
      );
      scheduledTasks.set(`cron:${cronJob.id}`, task);
      console.log(`[Cron] Scheduled "${cronJob.name}": ${cronJob.schedule}`);

      const prevNext = cronJob.next_run_at ? Date.parse(cronJob.next_run_at) : NaN;
      if (Number.isFinite(prevNext) && prevNext < now) {
        const lateBySec = Math.round((now - prevNext) / 1000);
        console.log(
          `[Cron] "${cronJob.name}" missed a run (was due ${lateBySec}s ago) — catching up`,
        );
        missed.push(() => {
          const fresh = stmts.getCron.get(cronJob.id) as CronRow | undefined;
          if (fresh && fresh.enabled) return runCronJob(fresh);
        });
      }

      persistNextRun('cron', cronJob.id, task);
    } else {
      try {
        stmts.updateCronNextRun.run(null, cronJob.id);
      } catch {}
    }
  }

  // Workspace purge — hourly hard-delete of session rows past the 24-hour
  // archive window + stale-clone sweep across every project's workspace
  // dir. Hourly (not daily) so the effective worst-case disk retention
  // stays close to the 24h contract instead of drifting to ~48h. The tick
  // is cheap when there's nothing to do — `getExpiredArchivedSessions` is
  // an indexed scan, and `cleanupStaleWorkspaces` is a single readdir per
  // project — so the higher cadence has negligible overhead. Runs once at
  // startup (after a 30s grace so the scheduler isn't racing initial DB
  // writes / project hydration) and on the top of every hour. Wrapped in
  // `wrapCronTick` for the standard missed-run accounting and never throws
  // — `runWorkspacePurge` catches its own errors so a single bad row can't
  // kill the tick.
  const WORKSPACE_PURGE_SCHEDULE = '0 * * * *';
  const workspacePurgeTask = cron.schedule(
    WORKSPACE_PURGE_SCHEDULE,
    wrapCronTick(() => {
      try {
        runWorkspacePurge();
      } catch (err: unknown) {
        console.error('[Workspace Purge] Scheduled tick threw:', (err as Error).message);
      }
    }, 'system:workspace-purge'),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(WORKSPACE_PURGE_SCHEDULE),
      name: 'system:workspace-purge',
    }),
  );
  scheduledTasks.set('system:workspace-purge', workspacePurgeTask);
  console.log(`[Scheduler] Workspace purge scheduled: ${WORKSPACE_PURGE_SCHEDULE}`);

  // One-shot startup pass so a freshly-restarted server reclaims any
  // backlog accumulated while it was down. Deferred 30s so the rest of
  // boot (project hydration, in-flight session resume, etc.) settles
  // first — the purge is read-write and we don't want it competing with
  // initial WAL pressure.
  setTimeout(() => {
    try {
      runWorkspacePurge();
    } catch (err: unknown) {
      console.error('[Workspace Purge] Startup tick threw:', (err as Error).message);
    }
  }, 30_000);

  const WIKI_SYNC_SCHEDULE = '0 4 * * *';
  const wikiSyncTask = cron.schedule(
    WIKI_SYNC_SCHEDULE,
    wrapCronTick(
      () =>
        runWikiMemorySync().catch((err: unknown) => {
          console.error('[Wiki→Memory Sync] Scheduled run failed:', (err as Error).message);
        }),
      'system:wiki-memory-sync',
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(WIKI_SYNC_SCHEDULE),
      name: 'system:wiki-memory-sync',
    }),
  );
  scheduledTasks.set('system:wiki-memory-sync', wikiSyncTask);
  console.log(`[Scheduler] Wiki→Memory sync scheduled: ${WIKI_SYNC_SCHEDULE}`);

  // Cert-renewal heartbeat — daily dry-run (or live, if enabled) of the
  // wildcard preview cert. No-op when the PR-env feature flag is off.
  // Wrapped in try/catch because readPrEnvConfig throws on partial
  // config — we don't want one bad key to block the whole scheduler.
  const certRenewalTask = cron.schedule(
    CERT_RENEWAL_CRON,
    wrapCronTick(
      () =>
        runCertRenewalHeartbeat({
          getConfig: () => {
            try {
              return readPrEnvConfig(fileConfig, process.env, readPrEnvConfigRow(), config);
            } catch (err) {
              console.error('[cert-renewal] config read failed:', (err as Error).message);
              return null;
            }
          },
        }).catch((err: unknown) => {
          console.error('[cert-renewal] heartbeat threw:', (err as Error).message);
        }),
      'system:cert-renewal',
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(CERT_RENEWAL_CRON),
      name: 'system:cert-renewal',
    }),
  );
  scheduledTasks.set('system:cert-renewal', certRenewalTask);
  console.log(`[Scheduler] Cert-renewal heartbeat scheduled: ${CERT_RENEWAL_CRON}`);

  // Container-pool reaper — every 3 min, reconciles pool_slots against
  // the live Docker daemon and GitHub PR state so a dropped webhook
  // doesn't leave a slot busy forever. No-op when PR-env feature is off
  // (`getConfig()` returns null inside `runReaperHeartbeat`). The
  // allocator is constructed lazily here because the container-pool
  // dispatcher doesn't have a production home yet; when W1 lands in
  // production, swap the lazy allocator out for the shared singleton.
  const reaperAllocator = new PoolAllocator(db);
  const reaperTask = cron.schedule(
    REAPER_CRON,
    wrapCronTick(
      () =>
        runReaperHeartbeat({
          db,
          allocator: reaperAllocator,
          getConfig: () => {
            try {
              return readPrEnvConfig(fileConfig, process.env, readPrEnvConfigRow(), config);
            } catch (err) {
              console.error('[reaper] config read failed:', (err as Error).message);
              return null;
            }
          },
        }).catch((err: unknown) => {
          console.error('[reaper] heartbeat threw:', (err as Error).message);
        }),
      'system:reaper',
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(REAPER_CRON),
      name: 'system:reaper',
    }),
  );
  scheduledTasks.set('system:reaper', reaperTask);
  console.log(`[Scheduler] Container-pool reaper scheduled: ${REAPER_CRON}`);

  // Pool-alerts heartbeat — every minute, evaluates pool_metrics rows
  // against alert thresholds and fires/resolves rows in pool_alerts.
  // Pure SQLite reads/writes, no network or process spawn.
  const poolAlertsTask = cron.schedule(
    POOL_ALERTS_CRON,
    wrapCronTick(() => runPoolAlertsHeartbeat({ db }), 'system:pool-alerts'),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(POOL_ALERTS_CRON),
      name: 'system:pool-alerts',
    }),
  );
  scheduledTasks.set('system:pool-alerts', poolAlertsTask);
  console.log(`[Scheduler] Pool-alerts heartbeat scheduled: ${POOL_ALERTS_CRON}`);

  console.log(`[Scheduler] ${scheduledTasks.size} tasks scheduled`);

  if (missed.length > 0) {
    console.log(`[Scheduler] Replaying ${missed.length} missed run(s) in 5s...`);
    setTimeout(() => {
      for (const fn of missed) {
        try {
          fn();
        } catch (err) {
          console.error('[Scheduler] Catch-up run failed:', (err as Error).message);
        }
      }
    }, 5000);
  }
}

export async function runWikiMemorySync(): Promise<void> {
  const projects = getProjects();
  // Wiki→Memory sync now goes through the unified one-shot resolver so
  // it works whenever any engine is authed (Claude / Cursor / Codex /
  // Gemini), not just Claude Code. NoEnginesAvailableError surfaces as a
  // clear "skipping sync" log via reconcileMemoryFromWiki's catch block.
  const opts = {
    cfg: config,
    spawnEnv: buildSpawnEnv(config),
  };

  for (const project of projects) {
    if (!project.ahw) continue;

    try {
      const pageMetas = listPages(project.id);
      if (!pageMetas.length) continue;

      const wikiPages = pageMetas
        .map((meta) => {
          const full = getPage(project.id, meta.slug);
          return {
            title: full?.title || meta.title,
            content: full?.content || '',
            category: full?.category || meta.category,
          };
        })
        .filter((p) => p.content.trim());

      if (!wikiPages.length) continue;

      console.log(
        `[Wiki→Memory Sync] Reconciling "${project.name}" (${wikiPages.length} wiki pages)...`,
      );
      await reconcileMemoryFromWiki(project.ahw, wikiPages, {
        ...opts,
        cwd: project.cwd,
      });
    } catch (err) {
      console.error(`[Wiki→Memory Sync] Failed for "${project.name}":`, (err as Error).message);
    }
  }
}

export function rescheduleCron(cronJob: CronRow): void {
  const key = `cron:${cronJob.id}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
  }

  if (cronJob.enabled && cron.validate(cronJob.schedule)) {
    const task = cron.schedule(
      cronJob.schedule,
      wrapCronTick(() => {
        const fresh = stmts.getCron.get(cronJob.id) as CronRow | undefined;
        if (fresh && fresh.enabled) {
          runCronJob(fresh);
        }
      }, `cron:${cronJob.id}`),
      defaultTickOptions({
        intervalSeconds: estimateIntervalSeconds(cronJob.schedule),
        name: `cron:${cronJob.id}`,
      }),
    );
    scheduledTasks.set(key, task);
    persistNextRun('cron', cronJob.id, task);
    console.log(`[Cron] Rescheduled "${cronJob.name}": ${cronJob.schedule}`);
  } else {
    try {
      stmts.updateCronNextRun.run(null, cronJob.id);
    } catch {}
  }
}

/**
 * Tear down any in-memory heartbeat task for the agent and drop its persisted
 * `heartbeat_state` row. Used by hard-delete (`DELETE /api/agents/:id`) so a
 * removed agent can't keep firing scheduled work. Safe to call when no task
 * exists.
 */
export function unscheduleHeartbeat(agentId: string): void {
  const key = `heartbeat:${agentId}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    try {
      existing.stop();
    } catch {
      // best-effort — node-cron may already be torn down during shutdown
    }
    scheduledTasks.delete(key);
  }
  try {
    stmts.deleteHeartbeatState.run(agentId);
  } catch {
    // best-effort — DB may be closed during shutdown
  }
}

export function rescheduleHeartbeat(agent: EnrichedAgent): void {
  const key = `heartbeat:${agent.id}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
  }

  if (
    agent.heartbeat?.enabled &&
    agent.heartbeat?.interval &&
    cron.validate(agent.heartbeat.interval)
  ) {
    const task = cron.schedule(
      agent.heartbeat.interval,
      wrapCronTick(() => runHeartbeat(agent), `heartbeat:${agent.id}`),
      defaultTickOptions({
        intervalSeconds: estimateIntervalSeconds(agent.heartbeat.interval),
        name: `heartbeat:${agent.id}`,
      }),
    );
    scheduledTasks.set(key, task);
    persistNextRun('heartbeat', agent.id, task);
    console.log(`[Heartbeat] Rescheduled ${agent.name}: ${agent.heartbeat.interval}`);
  } else {
    try {
      stmts.deleteHeartbeatState.run(agent.id);
    } catch {}
  }
}
