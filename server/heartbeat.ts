import cron, { type ScheduledTask } from 'node-cron';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db as _db, stmts as _stmts } from './db.js';
import config, { buildSpawnEnv } from './config.js';
import { getOrCreateProcessWorktree } from './worktree.js';
import { reconcileMemoryFromWiki } from './memory.js';
import { listPages, getPage } from './wiki.js';
import { getProjects } from './project-model.js';
import type {
  EnrichedAgent,
  CronRow,
  HeartbeatStateRow,
  ThreadRow,
  ThreadEntryRow,
  SessionRow,
  DeviceTokenRow,
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
    args.push(prompt);

    let output = '';
    let errorOutput = '';
    const timeout = options.timeoutMs || config.defaultTimeoutMs;

    const heartbeatEnv = buildSpawnEnv(config);

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: heartbeatEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
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

interface PushMessage {
  to: string;
  sound: string;
  title: string;
  body: string;
  data: { sessionId: string; cronId: string };
}

interface PushReceipt {
  status: string;
  details?: { error?: string };
}

async function sendPushNotifications(
  cronName: string,
  result: string,
  sessionId: string,
  cronId: number,
): Promise<void> {
  const tokens = stmts.getAllDeviceTokens.all() as DeviceTokenRow[];
  if (!tokens.length) return;

  const body = result.length > 200 ? result.slice(0, 200) + '...' : result;

  const messages: PushMessage[] = tokens.map((t) => ({
    to: t.token,
    sound: 'default',
    title: `Cron: ${cronName}`,
    body,
    data: { sessionId, cronId: String(cronId) },
  }));

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const resp = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const data = (await resp.json()) as { data?: PushReceipt[] };
      if (data.data) {
        data.data.forEach((receipt, idx) => {
          if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
            stmts.removeDeviceToken.run(chunk[idx].to);
          }
        });
      }
    } catch (err) {
      console.error('[push] Failed to send:', (err as Error).message);
    }
  }
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
    const heartbeatCwd = getOrCreateProcessWorktree(agent.cwd, `heartbeat-${agent.id}`);
    const isDocsAgent = agent.role === 'docs';
    const timeoutMs =
      (agent.heartbeat as EnrichedAgent['heartbeat'] & { timeoutMs?: number })?.timeoutMs ||
      (isDocsAgent ? config.docsTimeoutMs : config.defaultTimeoutMs);
    const result = (await runClaude(agent.heartbeat.prompt, heartbeatCwd, agent.systemPrompt, {
      timeoutMs,
    })) as string;
    stmts.updateHeartbeatLog.run(result, 'success', logId);
    console.log(`[Heartbeat] ${agent.name} completed successfully`);

    appendToHeartbeatThread(agent, result);

    await notifySlack(agent.name, result);
    return { id: logId, status: 'success', result };
  } catch (err) {
    const errorMsg = (err as Error).message || 'Unknown error';
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

export async function runCronJob(cronJob: CronRow): Promise<CronRunResult> {
  console.log(`[Cron] Running "${cronJob.name}"...`);
  const logEntry = stmts.addCronLog.run(cronJob.id, 'running');
  const logId = logEntry.lastInsertRowid;
  const startTime = Date.now();

  const timeoutMs = config.defaultTimeoutMs;

  const thread = getOrCreateCronThread(cronJob);

  try {
    const resolvedCwd = resolveCronCwd(cronJob);
    const cronCwd = getOrCreateProcessWorktree(resolvedCwd, `cron-${cronJob.id}`);
    const detailed = (await runClaude(cronJob.prompt, cronCwd, undefined, {
      timeoutMs,
      detailed: true,
    })) as DetailedResult;
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
        stmts.createSession.run(
          sessionId,
          '_cron',
          sessionName,
          'claude-code',
          'claude-opus-4-6',
          0,
        );
        stmts.updateSessionCronId.run(cronJob.id, sessionId);
        session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      }
      const msgId = uuidv4();
      stmts.addMessage.run(msgId, session!.id, 'assistant', result, 'claude-code', null, null);
      stmts.touchSession.run(session!.id);

      await sendPushNotifications(cronJob.name, result, session!.id, cronJob.id);

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
    const errorMsg = typedErr.message || 'Unknown error';
    const durationMs = Date.now() - startTime;
    stmts.updateCronResult.run(`ERROR: ${errorMsg}`, cronJob.id);
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
      const task = cron.schedule(agent.heartbeat.interval, () => {
        runHeartbeat(agent);
      });
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
      const task = cron.schedule(cronJob.schedule, () => {
        const fresh = stmts.getCron.get(cronJob.id) as CronRow | undefined;
        if (fresh && fresh.enabled) {
          runCronJob(fresh);
        }
      });
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

  const WIKI_SYNC_SCHEDULE = '0 4 * * *';
  const wikiSyncTask = cron.schedule(WIKI_SYNC_SCHEDULE, () => {
    runWikiMemorySync().catch((err: unknown) => {
      console.error('[Wiki→Memory Sync] Scheduled run failed:', (err as Error).message);
    });
  });
  scheduledTasks.set('system:wiki-memory-sync', wikiSyncTask);
  console.log(`[Scheduler] Wiki→Memory sync scheduled: ${WIKI_SYNC_SCHEDULE}`);

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
  const opts = {
    claudeBin: config.claudeBin,
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
    const task = cron.schedule(cronJob.schedule, () => {
      const fresh = stmts.getCron.get(cronJob.id) as CronRow | undefined;
      if (fresh && fresh.enabled) {
        runCronJob(fresh);
      }
    });
    scheduledTasks.set(key, task);
    persistNextRun('cron', cronJob.id, task);
    console.log(`[Cron] Rescheduled "${cronJob.name}": ${cronJob.schedule}`);
  } else {
    try {
      stmts.updateCronNextRun.run(null, cronJob.id);
    } catch {}
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
    const task = cron.schedule(agent.heartbeat.interval, () => {
      runHeartbeat(agent);
    });
    scheduledTasks.set(key, task);
    persistNextRun('heartbeat', agent.id, task);
    console.log(`[Heartbeat] Rescheduled ${agent.name}: ${agent.heartbeat.interval}`);
  } else {
    try {
      stmts.deleteHeartbeatState.run(agent.id);
    } catch {}
  }
}
