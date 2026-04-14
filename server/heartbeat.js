import cron from 'node-cron';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, stmts } from './db.js';
import config, { buildSpawnEnv } from './config.js';
import { getOrCreateProcessWorktree } from './worktree.js';
import { reconcileMemoryFromWiki } from './memory.js';
import { listPages, getPage } from './wiki.js';
import { getProjects } from './project-model.js';

const CLAUDE_BIN = config.claudeBin;
const SLACK_WEBHOOK_URL = config.slackWebhookUrl;

// Track scheduled tasks so we can stop/restart them
const scheduledTasks = new Map();

// Track which agents have a heartbeat currently running (prevent double-launch)
const runningHeartbeats = new Set();

// Optional callback for cron session updates (set by index.js).
let onCronSessionUpdate = null;
export function setOnCronSessionUpdate(fn) {
  onCronSessionUpdate = fn;
}

// Optional callback for broadcasting WebSocket events (set by index.js).
let broadcastFn = null;
export function setBroadcast(fn) {
  broadcastFn = fn;
}

/**
 * Get or create a heartbeat thread for an agent.
 * Uses source_id = agent.id to deduplicate.
 */
function getOrCreateHeartbeatThread(agent) {
  const projectId = agent.projectId;
  if (!projectId) {
    console.warn(
      `[Heartbeat] No projectId for agent ${agent.name} (${agent.id}) — skipping thread`,
    );
    return null;
  }

  // Look up existing thread by source_id
  let thread = stmts.getThreadBySourceId.get(projectId, 'heartbeat', agent.id);
  if (thread) return thread;

  // Auto-create a new thread
  const id = uuidv4();
  const name = `${agent.name} heartbeat`;
  stmts.createThread.run(id, projectId, name, 'heartbeat', agent.id);
  thread = stmts.getThread.get(id);

  if (broadcastFn) {
    broadcastFn({ type: 'thread_created', projectId, thread });
  }

  return thread;
}

/**
 * Append heartbeat output to the agent's heartbeat thread.
 * Creates the thread on first call.
 */
function appendToHeartbeatThread(agent, content) {
  try {
    const thread = getOrCreateHeartbeatThread(agent);
    if (!thread) return;

    const entryId = uuidv4();
    stmts.createThreadEntry.run(entryId, thread.id, content);
    const entry = stmts.getThreadEntry.get(entryId);

    if (broadcastFn) {
      broadcastFn({ type: 'thread_entry_created', threadId: thread.id, entry });
    }
  } catch (err) {
    console.error(`[Heartbeat] Failed to append to thread for ${agent.name}:`, err.message);
  }
}

/**
 * Format a Date as an ISO string suitable for SQLite TEXT columns.
 * Returns null for invalid/missing dates.
 */
function isoOrNull(date) {
  if (!date || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Persist a task's next-run time. Called after scheduling and after each execution.
 */
function persistNextRun(kind, id, task) {
  try {
    const next = isoOrNull(task.getNextRun?.());
    if (kind === 'heartbeat') {
      stmts.upsertHeartbeatState.run(id, next, null);
    } else if (kind === 'cron') {
      stmts.updateCronNextRun.run(next, id);
    }
  } catch (err) {
    console.error(`[Scheduler] Failed to persist next run for ${kind}:${id}:`, err.message);
  }
}

/**
 * Persist that a task ran at the given time.
 */
function persistLastRun(kind, id, when = new Date()) {
  const iso = isoOrNull(when);
  try {
    if (kind === 'heartbeat') {
      stmts.upsertHeartbeatState.run(id, null, iso);
    }
    // Crons already track last_run via updateCronResult.
  } catch (err) {
    console.error(`[Scheduler] Failed to persist last run for ${kind}:${id}:`, err.message);
  }
}

/**
 * Run a claude --print command and return the result
 * @param {string} prompt
 * @param {string} cwd
 * @param {string} [systemPrompt]
 * @param {{ timeoutMs?: number, detailed?: boolean }} [options]
 *   When `detailed` is true, resolves with `{ stdout, stderr, code }` instead of a plain string.
 */
export function runClaude(prompt, cwd, systemPrompt, options = {}) {
  return new Promise((resolve, reject) => {
    if (!existsSync(cwd)) {
      return reject(
        new Error(
          `Working directory does not exist: "${cwd}" — update the cwd in agent/cron settings`,
        ),
      );
    }

    const args = ['--print', '--permission-mode', 'bypassPermissions'];
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

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code) => {
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

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Send a notable result to Slack webhook
 */
async function notifySlack(agentName, result) {
  if (!SLACK_WEBHOOK_URL) return;

  // Skip "all clear" type responses
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
    console.error('Failed to send Slack notification:', err.message);
  }
}

/**
 * Send push notifications to all registered mobile devices via Expo's push API.
 */
async function sendPushNotifications(cronName, result, sessionId, cronId) {
  const tokens = stmts.getAllDeviceTokens.all();
  if (!tokens.length) return;

  const body = result.length > 200 ? result.slice(0, 200) + '...' : result;

  const messages = tokens.map((t) => ({
    to: t.token,
    sound: 'default',
    title: `Cron: ${cronName}`,
    body,
    data: { sessionId, cronId: String(cronId) },
  }));

  // Expo supports batches of 100
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const resp = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const data = await resp.json();
      if (data.data) {
        data.data.forEach((receipt, idx) => {
          if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
            stmts.removeDeviceToken.run(chunk[idx].to);
          }
        });
      }
    } catch (err) {
      console.error('[push] Failed to send:', err.message);
    }
  }
}

/**
 * Execute a heartbeat for an agent
 */
export async function runHeartbeat(agent) {
  if (!agent.heartbeat?.prompt) return null;

  // Prevent double-launch — skip if this agent already has a heartbeat running
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
    // Docs agents do more work (read git log, check wiki, write pages) — give them more time
    const isDocsAgent = agent.role === 'docs';
    const timeoutMs =
      agent.heartbeat.timeoutMs || (isDocsAgent ? config.docsTimeoutMs : config.defaultTimeoutMs);
    const result = await runClaude(agent.heartbeat.prompt, heartbeatCwd, agent.systemPrompt, {
      timeoutMs,
    });
    stmts.updateHeartbeatLog.run(result, 'success', logId);
    console.log(`[Heartbeat] ${agent.name} completed successfully`);

    // Pipe output into thread
    appendToHeartbeatThread(agent, result);

    await notifySlack(agent.name, result);
    return { id: logId, status: 'success', result };
  } catch (err) {
    const errorMsg = err.message || 'Unknown error';
    stmts.updateHeartbeatLog.run(errorMsg, 'error', logId);
    console.error(`[Heartbeat] ${agent.name} failed:`, errorMsg);

    // Pipe error into thread too
    appendToHeartbeatThread(agent, `ERROR: ${errorMsg}`);

    return { id: logId, status: 'error', result: errorMsg };
  } finally {
    runningHeartbeats.delete(agent.id);
    // Refresh next-run from the live task so the DB reflects the upcoming fire.
    const task = scheduledTasks.get(`heartbeat:${agent.id}`);
    if (task) persistNextRun('heartbeat', agent.id, task);
    // Keep only the last 100 thread entries per heartbeat thread
    try {
      const thread = getOrCreateHeartbeatThread(agent);
      if (thread) {
        stmts.pruneThreadEntries.run(thread.id, thread.id);
      }
    } catch {}
  }
}

/**
 * Find the project that owns a cron job.
 * Checks project_id first, then falls back to cwd matching.
 * Returns the project object or null if no match.
 */
function findProjectForCron(cronJob) {
  const projects = getProjects();
  return (
    (cronJob.project_id && projects.find((p) => p.id === cronJob.project_id)) ||
    projects.find((p) => p.cwd === cronJob.cwd) ||
    null
  );
}

/**
 * Resolve the working directory for a cron job.
 * If the stored cwd doesn't exist, tries to resolve from the linked project.
 * Falls back to config.defaultCwd as a last resort.
 */
function resolveCronCwd(cronJob) {
  // Stored cwd is valid — use it
  if (existsSync(cronJob.cwd)) return cronJob.cwd;

  // Try to resolve from the linked project
  const project = findProjectForCron(cronJob);
  if (project && existsSync(project.cwd)) {
    console.warn(
      `[Cron] cwd "${cronJob.cwd}" does not exist for "${cronJob.name}" — using project cwd "${project.cwd}"`,
    );
    return project.cwd;
  }

  // Last resort — defaultCwd
  const fallback = config.defaultCwd;
  console.warn(
    `[Cron] cwd "${cronJob.cwd}" does not exist for "${cronJob.name}" — falling back to "${fallback}"`,
  );
  return fallback;
}

/**
 * Format cron run output for a thread entry.
 * Combines stdout and stderr into a single content string.
 */
function formatCronEntryContent({ stdout, stderr, status, durationMs }) {
  const parts = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`--- stderr ---\n${stderr}`);
  if (!stdout && !stderr) parts.push('(empty response)');
  parts.push(`\n[${status} in ${durationMs}ms]`);
  return parts.join('\n');
}

/**
 * Get or create the thread associated with a cron job.
 * Auto-creates on first call; thread name defaults to the cron job name.
 * Returns the thread, or null if the cron has no associated project.
 */
function getOrCreateCronThread(cronJob) {
  const project = findProjectForCron(cronJob);
  if (!project) return null;

  const sourceId = String(cronJob.id);
  let thread = stmts.getThreadBySource.get(project.id, 'cron', sourceId);
  if (!thread) {
    const threadId = uuidv4();
    stmts.createThread.run(threadId, project.id, cronJob.name, 'cron', sourceId);
    thread = stmts.getThread.get(threadId);
    console.log(`[Cron] Created thread "${cronJob.name}" for cron ${cronJob.id}`);
  }
  return thread;
}

/**
 * Execute a standalone cron job
 */
export async function runCronJob(cronJob) {
  console.log(`[Cron] Running "${cronJob.name}"...`);
  const logEntry = stmts.addCronLog.run(cronJob.id, 'running');
  const logId = logEntry.lastInsertRowid;
  const startTime = Date.now();

  const timeoutMs = config.defaultTimeoutMs;

  // Get or create the thread for this cron job
  const thread = getOrCreateCronThread(cronJob);

  try {
    const resolvedCwd = resolveCronCwd(cronJob);
    const cronCwd = getOrCreateProcessWorktree(resolvedCwd, `cron-${cronJob.id}`);
    const detailed = await runClaude(cronJob.prompt, cronCwd, undefined, {
      timeoutMs,
      detailed: true,
    });
    const durationMs = Date.now() - startTime;
    const result = detailed.stdout || detailed.stderr || '(empty response)';
    stmts.updateCronResult.run(result, cronJob.id);
    stmts.updateCronLog.run(result, 'success', durationMs, logId);
    console.log(`[Cron] "${cronJob.name}" completed successfully (${durationMs}ms)`);

    // ── Add thread entry with output ─────────────────────────────
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
      } catch (err) {
        console.error(`[Cron] Failed to add thread entry for "${cronJob.name}":`, err.message);
      }
    }

    // ── Save result to a dedicated cron session ─────────────────
    try {
      let session = stmts.getSessionByCronId.get(cronJob.id);
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
        session = stmts.getSession.get(sessionId);
      }
      // Add the result as an assistant message
      const msgId = uuidv4();
      stmts.addMessage.run(msgId, session.id, 'assistant', result, 'claude-code', null, null);
      stmts.touchSession.run(session.id);

      // Send push notifications to registered mobile devices
      await sendPushNotifications(cronJob.name, result, session.id, cronJob.id);

      // Broadcast WebSocket event so clients can update their sidebar
      if (onCronSessionUpdate) {
        onCronSessionUpdate({
          type: 'cron_session_update',
          sessionId: session.id,
          cronId: cronJob.id,
          cronName: cronJob.name,
          threadId: thread?.id || null,
        });
      }
    } catch (err) {
      console.error(`[Cron] Failed to save session/push for "${cronJob.name}":`, err.message);
    }

    // Notify for cron results too
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
    const errorMsg = err.message || 'Unknown error';
    const durationMs = Date.now() - startTime;
    stmts.updateCronResult.run(`ERROR: ${errorMsg}`, cronJob.id);
    stmts.updateCronLog.run(errorMsg, 'error', durationMs, logId);
    console.error(`[Cron] "${cronJob.name}" failed:`, errorMsg);

    // Add error entry to thread
    if (thread) {
      try {
        const entryId = uuidv4();
        const content = formatCronEntryContent({
          stdout: err.stdout || null,
          stderr: err.stderr || errorMsg,
          status: 'error',
          durationMs,
        });
        stmts.createThreadEntry.run(entryId, thread.id, content);
      } catch (threadErr) {
        console.error(
          `[Cron] Failed to add error thread entry for "${cronJob.name}":`,
          threadErr.message,
        );
      }
    }

    return { id: logId, status: 'error', result: errorMsg };
  } finally {
    const task = scheduledTasks.get(`cron:${cronJob.id}`);
    if (task) persistNextRun('cron', cronJob.id, task);
    // Keep only the last 100 logs per cron
    try {
      stmts.pruneCronLogs.run(cronJob.id, cronJob.id);
    } catch {}
  }
}

/**
 * Schedule all heartbeats and crons.
 *
 * On boot, this also detects "missed" runs: if a task's previously persisted
 * next_run_at is in the past (because the server was offline when it was due),
 * it runs the task once immediately as a single catch-up. We do NOT replay
 * every missed slot — if you were off for a week, that would be a stampede.
 */
export function scheduleAll(agents) {
  // Clear existing schedules
  for (const [key, task] of scheduledTasks) {
    task.stop();
    scheduledTasks.delete(key);
  }

  // Clean up stale "running" heartbeat logs from previous server crashes/restarts.
  // These will never complete, so mark them as errors.
  try {
    const cleaned = db
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
    console.error('[Heartbeat] Failed to clean stale logs:', err.message);
  }

  const now = Date.now();
  const missed = [];

  // Schedule agent heartbeats
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

      // Did we miss a previously-scheduled run while the server was down?
      const state = stmts.getHeartbeatState.get(agent.id);
      const prevNext = state?.next_run_at ? Date.parse(state.next_run_at) : NaN;
      if (Number.isFinite(prevNext) && prevNext < now) {
        const lateBySec = Math.round((now - prevNext) / 1000);
        console.log(
          `[Heartbeat] ${agent.name} missed a run (was due ${lateBySec}s ago) — catching up`,
        );
        missed.push(() => runHeartbeat(agent));
      }

      // Persist the upcoming run so next restart can detect missed runs again.
      persistNextRun('heartbeat', agent.id, task);
    } else {
      // Heartbeat disabled — clear any stale state.
      try {
        stmts.deleteHeartbeatState.run(agent.id);
      } catch {}
    }
  }

  // Schedule standalone crons
  const crons = stmts.getCrons.all();
  for (const cronJob of crons) {
    if (cronJob.enabled) {
      if (!cron.validate(cronJob.schedule)) {
        console.error(`[Cron] Invalid expression for "${cronJob.name}": ${cronJob.schedule}`);
        continue;
      }
      const task = cron.schedule(cronJob.schedule, () => {
        // Re-read from DB in case it was updated
        const fresh = stmts.getCron.get(cronJob.id);
        if (fresh && fresh.enabled) {
          runCronJob(fresh);
        }
      });
      scheduledTasks.set(`cron:${cronJob.id}`, task);
      console.log(`[Cron] Scheduled "${cronJob.name}": ${cronJob.schedule}`);

      // Catch up missed cron runs
      const prevNext = cronJob.next_run_at ? Date.parse(cronJob.next_run_at) : NaN;
      if (Number.isFinite(prevNext) && prevNext < now) {
        const lateBySec = Math.round((now - prevNext) / 1000);
        console.log(
          `[Cron] "${cronJob.name}" missed a run (was due ${lateBySec}s ago) — catching up`,
        );
        missed.push(() => {
          const fresh = stmts.getCron.get(cronJob.id);
          if (fresh && fresh.enabled) return runCronJob(fresh);
        });
      }

      persistNextRun('cron', cronJob.id, task);
    } else {
      // Disabled — clear any persisted next_run_at.
      try {
        stmts.updateCronNextRun.run(null, cronJob.id);
      } catch {}
    }
  }

  // ── Built-in: Wiki → Memory Sync (daily at 4am) ──────────────────
  const WIKI_SYNC_SCHEDULE = '0 4 * * *'; // 4:00 AM daily
  const wikiSyncTask = cron.schedule(WIKI_SYNC_SCHEDULE, () => {
    runWikiMemorySync().catch((err) => {
      console.error('[Wiki→Memory Sync] Scheduled run failed:', err.message);
    });
  });
  scheduledTasks.set('system:wiki-memory-sync', wikiSyncTask);
  console.log(`[Scheduler] Wiki→Memory sync scheduled: ${WIKI_SYNC_SCHEDULE}`);

  console.log(`[Scheduler] ${scheduledTasks.size} tasks scheduled`);

  // Fire catch-up runs after a short delay so the server has time to finish booting
  // (Slack bots, WS server, etc.) before we kick off potentially-long agent runs.
  if (missed.length > 0) {
    console.log(`[Scheduler] Replaying ${missed.length} missed run(s) in 5s...`);
    setTimeout(() => {
      for (const fn of missed) {
        try {
          fn();
        } catch (err) {
          console.error('[Scheduler] Catch-up run failed:', err.message);
        }
      }
    }, 5000);
  }
}

// ─── Wiki → Memory Sync ─────────────────────────────────────────────

/**
 * Run wiki-to-memory reconciliation for all projects that have
 * both a workspace (ahw) and wiki pages.
 *
 * Scheduled as a built-in daily task — runs alongside user crons
 * but isn't stored in the crons table (it's a system task).
 */
export async function runWikiMemorySync() {
  const projects = getProjects();
  const opts = {
    claudeBin: config.claudeBin,
    spawnEnv: buildSpawnEnv(config),
  };

  for (const project of projects) {
    if (!project.ahw) continue;

    try {
      // Get all wiki pages with full content
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
      console.error(`[Wiki→Memory Sync] Failed for "${project.name}":`, err.message);
    }
  }
}

/**
 * Reschedule a single cron job (after update)
 */
export function rescheduleCron(cronJob) {
  const key = `cron:${cronJob.id}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
  }

  if (cronJob.enabled && cron.validate(cronJob.schedule)) {
    const task = cron.schedule(cronJob.schedule, () => {
      const fresh = stmts.getCron.get(cronJob.id);
      if (fresh && fresh.enabled) {
        runCronJob(fresh);
      }
    });
    scheduledTasks.set(key, task);
    persistNextRun('cron', cronJob.id, task);
    console.log(`[Cron] Rescheduled "${cronJob.name}": ${cronJob.schedule}`);
  } else {
    // Disabled or invalid — clear next_run_at so we don't falsely catch up later.
    try {
      stmts.updateCronNextRun.run(null, cronJob.id);
    } catch {}
  }
}

/**
 * Reschedule heartbeat for an agent after config update
 */
export function rescheduleHeartbeat(agent) {
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
    // Disabled — clear persisted state so it doesn't trigger a catch-up next boot.
    try {
      stmts.deleteHeartbeatState.run(agent.id);
    } catch {}
  }
}
