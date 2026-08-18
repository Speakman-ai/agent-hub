import cron, { type ScheduledTask } from 'node-cron';
import { spawn } from 'child_process';
import { trackChild, killProcessGroup } from './process-groups.js';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db as _db, stmts as _stmts } from './db.js';
import config, { buildSpawnEnv, fileConfig } from './config.js';
import { resolveUserCliCredOverride } from './per-user-cli-spawn.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from './project-secrets-spawn.js';
import { mergeProjectAwsSpawnEnv } from './project-aws-spawn.js';
import { resolveCronSkillPrincipalAgentId } from './cron-skill-principal.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
import { getOrCreateProcessWorktree } from './worktree.js';
import { runWorkspacePurge } from './session-purge.js';
import { reconcileMemoryFromWiki } from './memory.js';
import { listPages, getPage } from './wiki.js';
import { getProjects } from './project-model.js';
import {
  initScheduledJobQueue,
  getScheduledJobQueue,
  enqueueCronJob,
} from './jobs/scheduled-jobs.js';
import { setSessionOwner } from './session-ownership.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from './engine-resolver.js';
import { hostedBarePathForProject } from './git-host/repo-store.js';
import { resolveCronEngine } from './cron-engine.js';
import { type OneShotDetailed } from './one-shot-spawn.js';
import { runOneShotPromptWithFailover, formatFailoverSummary } from './one-shot-failover.js';
import type { SupportedEngine } from './engine-availability.js';
import type {
  EnrichedAgent,
  CronRow,
  ThreadRow,
  ThreadEntryRow,
  SessionRow,
  Project,
  BroadcastFn,
} from './types.js';

const db = _db!;
const stmts = _stmts!;

const CLAUDE_BIN: string = config.claudeBin;
const SLACK_WEBHOOK_URL: string | null = config.slackWebhookUrl;

const scheduledTasks = new Map<string, ScheduledTask>();

let onCronSessionUpdate: ((data: Record<string, unknown>) => void) | null = null;
export function setOnCronSessionUpdate(fn: (data: Record<string, unknown>) => void): void {
  onCronSessionUpdate = fn;
}

let broadcastFn: BroadcastFn | null = null;
export function setBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

function isoOrNull(date: Date | null | undefined): string | null {
  if (!date || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function cronTimezone(timezone?: string | null): string {
  const candidate = timezone?.trim() || config.schedulerTimezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    console.warn(`[Scheduler] Invalid timezone "${candidate}" — falling back to UTC`);
    return 'UTC';
  }
}

function persistNextRun(id: string | number, task: ScheduledTask): void {
  try {
    const next = isoOrNull(task.getNextRun?.());
    stmts.updateCronNextRun.run(next, id);
  } catch (err) {
    console.error(`[Scheduler] Failed to persist next run for cron:${id}:`, (err as Error).message);
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
  /**
   * Fully-resolved spawn env override. When set, runClaude uses it as the
   * child env verbatim instead of building one (callers that resolved
   * per-user CLI credentials themselves, e.g. via
   * `resolveSessionCliSpawnEnv`). `skillCredentialMerge` still applies.
   */
  spawnEnv?: NodeJS.ProcessEnv;
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

    const args: string[] = [
      '--print',
      '--permission-mode',
      claudePermissionModeForSpawn('bypassPermissions'),
    ];
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

    const heartbeatEnv =
      options.spawnEnv ??
      buildSpawnEnv(config, {
        userId: options.skillCredentialMerge?.ownerId ?? null,
        engine: 'claude-code',
      });
    if (options.skillCredentialMerge) {
      mergeSkillCredentialSpawnEnv(heartbeatEnv, options.skillCredentialMerge);
      // sessionId: null — heartbeats are scheduled, not driven by an
      // interactive chat session; decrypt-failure audit entries attribute to
      // system-initiated, not a missing value. See mergeProjectSecretsSpawnEnv.
      mergeProjectSecretsSpawnEnv(heartbeatEnv, {
        projectId: options.skillCredentialMerge.project.id,
        sessionId: null,
      });
      mergeProjectAwsSpawnEnv(heartbeatEnv, options.skillCredentialMerge.project);
    }

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: heartbeatEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const timer = setTimeout(() => {
      console.info(
        `[heartbeat] heartbeat_wall_timeout: sending SIGTERM after ${timeout}ms cwd=${cwd}`,
      );
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
        text: `🤖 *${agentName}*\n${result.substring(0, 2000)}`,
      }),
    });
  } catch (err) {
    console.error('Failed to send Slack notification:', (err as Error).message);
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
    const cronProject = findProjectForCron(cronJob);
    const cronCwd = await getOrCreateProcessWorktree(
      resolvedCwd,
      `cron-${cronJob.id}`,
      undefined,
      undefined,
      cronProject?.repoUrl ?? null,
      cronProject?.id,
      cronProject?.githubRepo ?? null,
      cronProject ? hostedBarePathForProject(cronProject) : null,
    );
    const cronSkillAgentId = cronProject
      ? resolveCronSkillPrincipalAgentId(cronJob, cronProject)
      : undefined;

    let detailed: OneShotDetailed;
    let resolved: Awaited<ReturnType<typeof resolveOneShotEngine>>;

    // Resolve the engine the cron actually wants to run under: the row's
    // explicit `engine` first, then the skill principal agent's `engine`,
    // then the historical `claude-code` fallback. The resolver will still
    // walk its own fallback chain if that engine isn't authed locally —
    // NoEnginesAvailableError bubbles into the outer catch block where
    // it's surfaced verbatim.
    const preferredCronEngine = resolveCronEngine(cronJob, cronProject);
    // Crons run outside an interactive chat turn, but creator-owned resources
    // such as AWS SSO caches and per-account engine auth still live under that
    // user's spawn HOME. Legacy rows without an owner keep the historical host
    // fallback by passing null.
    const cronOwnerId: string | null = cronJob.owner_user_id ?? null;
    resolved = await resolveOneShotEngine(config, {
      preferred: preferredCronEngine,
      preferredModel: requestedModel,
      userId: cronOwnerId,
      agentId: cronSkillAgentId ?? null,
    });
    // Rebuilt per attempt: a failover engine needs its own per-account
    // credentials and engine-specific env.
    const buildCronEnv = (engine: SupportedEngine): NodeJS.ProcessEnv => {
      const cronEnv = buildSpawnEnv(config, {
        userId: cronOwnerId,
        // Inject the owner's stored per-account AI credentials. Without this the
        // spawned CLI runs logged-out for DB-stored-credential users (no host
        // fallback for claude/cursor/codex/grok). Null owner => host behavior.
        userOverride: resolveUserCliCredOverride(cronOwnerId),
        engine,
      });
      if (cronProject) {
        if (cronSkillAgentId) {
          mergeSkillCredentialSpawnEnv(cronEnv, {
            ownerId: cronOwnerId,
            agentId: cronSkillAgentId,
            project: cronProject,
          });
          // sessionId: null — crons are scheduled, not driven by an interactive
          // chat session; decrypt-failure audit entries attribute to
          // system-initiated, not a missing value. See mergeProjectSecretsSpawnEnv.
          mergeProjectSecretsSpawnEnv(cronEnv, { projectId: cronProject.id, sessionId: null });
        }
        mergeProjectAwsSpawnEnv(cronEnv, cronProject);
      }
      return cronEnv;
    };
    if (resolved.fallbackUsed) {
      console.warn(
        `[Cron] "${cronJob.name}": preferred engine "${preferredCronEngine}" unavailable (${resolved.fallbackFromReason}); using "${resolved.engine}".`,
      );
    }
    // Pre-flight resolution only proves the engine was authenticated at
    // START. Quota can run out mid-run, and nobody is watching a cron — so
    // hand off to the next engine in its chain rather than logging a failure.
    const cronOutcome = await runOneShotPromptWithFailover(
      {
        scope: `cron "${cronJob.name}"`,
        engine: resolved.engine,
        model: resolved.model,
        userId: cronOwnerId,
        agentId: cronSkillAgentId ?? null,
        prompt: cronJob.prompt,
        cwd: cronCwd,
        timeoutMs,
        buildEnv: buildCronEnv,
        detailed: true,
      },
      config,
    );
    detailed = cronOutcome.detailed;
    // Record the engine/model that actually produced the result, not the one
    // the row asked for.
    const cronEngine = cronOutcome.engine;
    const cronModel = cronOutcome.model;
    const durationMs = Date.now() - startTime;
    const result = cronOutcome.output + formatFailoverSummary(cronOutcome.failovers);
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
            ownerUserId: cronJob.owner_user_id ?? null,
            cronShared: Boolean(cronJob.shared),
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
        // when fallback kicked in — whether that was pre-flight resolution
        // (engine not authenticated) or a runtime failover mid-run.
        stmts.createSession.run(sessionId, '_cron', sessionName, cronEngine, cronModel, 0, 0, 1);
        // Cron sessions belong to the cron creator. Shared visibility on the
        // cron does not change whose CLI credentials pay for the run.
        setSessionOwner(sessionId, cronOwnerId);
        stmts.updateSessionCronId.run(cronJob.id, sessionId);
        // Scheduled tasks are consult-only: the cron session is a read-only
        // log/Q&A thread, never a build/ship surface. Tagging it `consult`
        // keeps any follow-up interaction in consult behavior (no code edits,
        // no Finalize) and surfaces the consult badge in the sidebar.
        stmts.updateSessionMode.run('consult', sessionId);
        session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      }
      const msgId = uuidv4();
      stmts.addMessage.run(
        msgId,
        session!.id,
        'assistant',
        result,
        cronEngine,
        null,
        null,
        null,
        null,
        null,
        null,
      );
      stmts.touchSession.run(session!.id);

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
            ownerUserId: cronJob.owner_user_id ?? null,
            cronShared: Boolean(cronJob.shared),
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
    if (task) persistNextRun(cronJob.id, task);
    try {
      stmts.pruneCronLogs.run(cronJob.id, cronJob.id);
    } catch {}
  }
}

/** True when scheduled work should run through the job queue (default). */
function scheduledJobsEnabled(): boolean {
  return config.scheduledJobsViaQueue !== false;
}

/**
 * Lazily construct + start the scheduled-work job queue and register the
 * cron handler. Idempotent. No-op when the config flag is off (legacy
 * direct-execution path). Leftover `scheduled.heartbeat` jobs from an older
 * process are drained as no-ops so they cannot spawn an agent.
 */
export function ensureScheduledJobQueue(): void {
  if (!scheduledJobsEnabled()) return;
  initScheduledJobQueue({
    db,
    concurrency: config.scheduledJobsConcurrency,
    heartbeatHandler: async (job) => {
      console.warn(`[Scheduler] Skipping leftover heartbeat job for agent ${job.payload.agentId}`);
    },
    cronHandler: async (job) => {
      const { cronId } = job.payload;
      const fresh = stmts.getCron.get(cronId) as CronRow | undefined;
      if (fresh && fresh.enabled) {
        await runCronJob(fresh);
      }
    },
  });
}

/**
 * Run a cron from a scheduler tick. Queue mode enqueues by id (the worker
 * re-reads the row + enabled flag); legacy mode re-reads inline and runs,
 * matching the historical timer-callback behaviour.
 */
export function dispatchCron(cronId: number): void | Promise<unknown> {
  if (scheduledJobsEnabled() && getScheduledJobQueue()) {
    enqueueCronJob(cronId);
    return;
  }
  const fresh = stmts.getCron.get(cronId) as CronRow | undefined;
  if (fresh && fresh.enabled) return runCronJob(fresh);
}

export function scheduleAll(_agents?: EnrichedAgent[]): void {
  ensureScheduledJobQueue();

  for (const [, task] of scheduledTasks) {
    task.stop();
  }
  scheduledTasks.clear();

  try {
    const cleaned = db!
      .prepare(
        `UPDATE heartbeat_logs SET status = 'error', result = 'Abandoned — per-agent heartbeats are no longer scheduled' WHERE status = 'running'`,
      )
      .run();
    if (cleaned.changes > 0) {
      console.log(`[Scheduler] Abandoned ${cleaned.changes} leftover heartbeat log(s)`);
    }
  } catch (err) {
    console.error('[Scheduler] Failed to abandon leftover heartbeat logs:', (err as Error).message);
  }

  try {
    const dropped = db!.prepare(`DELETE FROM heartbeat_state`).run();
    if (dropped.changes > 0) {
      console.log(`[Scheduler] Dropped ${dropped.changes} leftover heartbeat_state row(s)`);
    }
  } catch (err) {
    console.error('[Scheduler] Failed to drop leftover heartbeat_state:', (err as Error).message);
  }

  const now = Date.now();
  const missed: Array<() => void | Promise<unknown>> = [];

  const crons = stmts.getCrons.all() as CronRow[];
  for (const cronJob of crons) {
    if (cronJob.enabled) {
      if (!cron.validate(cronJob.schedule)) {
        console.error(`[Cron] Invalid expression for "${cronJob.name}": ${cronJob.schedule}`);
        continue;
      }
      const task = cron.schedule(
        cronJob.schedule,
        wrapCronTick(() => dispatchCron(cronJob.id), `cron:${cronJob.id}`),
        defaultTickOptions({
          intervalSeconds: estimateIntervalSeconds(cronJob.schedule),
          name: `cron:${cronJob.id}`,
          timezone: cronTimezone(cronJob.timezone),
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
        missed.push(() => dispatchCron(cronJob.id));
      }

      persistNextRun(cronJob.id, task);
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
      // `runWorkspacePurge` is async (the stale-clone sweep now removes off the
      // event loop); catch the rejection so the tick never produces an
      // unhandled promise rejection.
      void runWorkspacePurge().catch((err: unknown) => {
        console.error('[Workspace Purge] Scheduled tick threw:', (err as Error).message);
      });
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
    void runWorkspacePurge().catch((err: unknown) => {
      console.error('[Workspace Purge] Startup tick threw:', (err as Error).message);
    });
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

  // PR-env crons (cert-renewal, reaper, pool-alerts) were removed by
  // PR-Env Removal #4 along with the PR-env backing directory.

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
  // No human in-context for scheduled wiki→memory sync; strictly per-account
  // auth means the per-account engines are unavailable and only the
  // host-global Gemini can run this (else NoEnginesAvailableError is logged
  // by reconcileMemoryFromWiki). No org-owner fallback.
  const wikiSyncOwnerId: string | null = null;
  const opts = {
    cfg: config,
    spawnEnv: buildSpawnEnv(config, { userId: wikiSyncOwnerId }),
    spawnOwnerUserId: wikiSyncOwnerId,
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
  // The queue is initialised once by scheduleAll() at boot, well before any
  // API-driven reschedule; dispatchCron falls back to inline execution if it
  // is somehow not up yet, so no ensure call is needed here.
  const key = `cron:${cronJob.id}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
  }

  if (cronJob.enabled && cron.validate(cronJob.schedule)) {
    const task = cron.schedule(
      cronJob.schedule,
      wrapCronTick(() => dispatchCron(cronJob.id), `cron:${cronJob.id}`),
      defaultTickOptions({
        intervalSeconds: estimateIntervalSeconds(cronJob.schedule),
        name: `cron:${cronJob.id}`,
        timezone: cronTimezone(cronJob.timezone),
      }),
    );
    scheduledTasks.set(key, task);
    persistNextRun(cronJob.id, task);
    console.log(`[Cron] Rescheduled "${cronJob.name}": ${cronJob.schedule}`);
  } else {
    try {
      stmts.updateCronNextRun.run(null, cronJob.id);
    } catch {}
  }
}

/**
 * Drop leftover heartbeat_state for a deleted agent. Heartbeats are no longer
 * scheduled; this stays so hard-delete (`DELETE /api/agents/:id`) can still
 * clean historical rows. Safe to call when no row exists.
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

/** In-memory scheduled task keys. Exported for tests. */
export function scheduledTaskKeys(): string[] {
  return [...scheduledTasks.keys()];
}
